/**
 * Account access: the session decides whose account a request acts on,
 * and a session can only be obtained with proof of ownership.
 *
 * Unit tests for the /api guard, plus integration tests that drive the REAL
 * auth routes (in-memory database, real express-session, signed cookies).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createApiGuard, isLocalDevRequest } from '../../server/utils/api-guard.js';
import setupAuthRoutes from '../../server/routes/auth.js';

// ── Guard unit tests ────────────────────────────────────────────────────
const run = async (guard, req) => {
  let status = null; let passed = false;
  const res = { status(n) { status = n; return this; }, json() { return this; } };
  await guard({ method: 'GET', query: {}, body: {}, path: '/api/x', ...req }, res, () => { passed = true; });
  return passed ? 'next' : status;
};

describe('api guard', () => {
  const guard = createApiGuard({ getDeepLinkOwnerId: async () => 'owner01' });

  it('lets requests that name no account through (handlers decide)', async () => {
    expect(await run(guard, { session: {} })).toBe('next');
  });
  it('refuses a named account with no session (401) and a different user (403)', async () => {
    expect(await run(guard, { query: { userId: 'victim01' }, session: {} })).toBe(401);
    expect(await run(guard, { body: { userId: 'victim01' }, session: { userId: 'mallory07' } })).toBe(403);
  });
  it('allows the account owner and the admin', async () => {
    expect(await run(guard, { query: { userId: 'alice01' }, session: { userId: 'alice01' } })).toBe('next');
    expect(await run(guard, { query: { userId: 'alice01' }, session: { userId: 'admin' } })).toBe('next');
  });
  it('allows pre-sign-in routes that carry their own proof', async () => {
    expect(await run(guard, { path: '/api/passkey/check-user', query: { userId: 'alice01' }, session: {} })).toBe('next');
    expect(await run(guard, { path: '/api/passkey/registration-complete', body: { userId: 'alice01' }, session: {} })).toBe(401);
  });
  it('limits deep-link guests to themselves, plus reads of the sharing patient on a few routes', async () => {
    const dl = { isDeepLink: true, deepLinkUserId: 'bob-dl-x' };
    expect(await run(guard, { query: { userId: 'bob-dl-x' }, session: dl })).toBe('next');
    expect(await run(guard, { path: '/api/user-settings', query: { userId: 'owner01' }, session: dl })).toBe('next');
    expect(await run(guard, { path: '/api/patient-summary', query: { userId: 'owner01' }, session: dl })).toBe(403);
    expect(await run(guard, { method: 'POST', path: '/api/user-settings', body: { userId: 'owner01' }, session: dl })).toBe(403);
    expect(await run(guard, { path: '/api/user-settings', query: { userId: 'someone-else' }, session: dl })).toBe(403);
  });
});

describe('isLocalDevRequest', () => {
  const saved = process.env.PUBLIC_APP_URL;
  afterEach(() => { if (saved === undefined) delete process.env.PUBLIC_APP_URL; else process.env.PUBLIC_APP_URL = saved; });
  it('is never true behind an https deployment, whatever the Host headers say', () => {
    process.env.PUBLIC_APP_URL = 'https://maia.example.org';
    expect(isLocalDevRequest({ hostname: 'localhost', socket: { remoteAddress: '127.0.0.1' } })).toBe(false);
  });
  it('needs a loopback socket, not a spoofable hostname', () => {
    process.env.PUBLIC_APP_URL = 'http://localhost:5173';
    expect(isLocalDevRequest({ hostname: 'localhost', socket: { remoteAddress: '203.0.113.9' } })).toBe(false);
    expect(isLocalDevRequest({ socket: { remoteAddress: '::1' } })).toBe(true);
  });
});

// ── Integration: real auth routes ───────────────────────────────────────
class FakeCloudant {
  constructor() { this.docs = new Map(); }
  async getDocument(_db, id) { const d = this.docs.get(id); return d ? JSON.parse(JSON.stringify(d)) : null; }
  async saveDocument(_db, doc) { this.docs.set(doc._id, JSON.parse(JSON.stringify(doc))); return { ok: true }; }
  async findDocuments() { return { docs: [] }; }
}

let app, cloudant;
beforeEach(() => {
  cloudant = new FakeCloudant();
  cloudant.docs.set('victim01', { _id: 'victim01', userId: 'victim01', type: 'user', temporaryAccount: true, displayName: 'victim01' });
  cloudant.docs.set('keyholder01', { _id: 'keyholder01', userId: 'keyholder01', type: 'user', credentialID: 'cred', displayName: 'keyholder01' });
  app = express();
  app.use(cookieParser('test-secret'));
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use('/api', createApiGuard({}));
  const passkeyService = {
    rpID: 'localhost',
    generateRegistrationOptions: async () => ({ challenge: 'challenge-1' }),
    resolveExpectedOrigin: () => 'http://localhost'
  };
  const doClient = { agent: { list: async () => [], get: async () => null } };
  setupAuthRoutes(app, passkeyService, cloudant, doClient, { logEvent: () => {} }, {});
  // A stand-in account endpoint behind the guard.
  app.get('/api/patient-summary', (req, res) => res.json({ ok: true, userId: req.query.userId }));
});

const signedInAs = async () => {
  const agent = request.agent(app);
  const r = await agent.post('/api/temporary/start').send({});
  expect(r.body.authenticated).toBe(true);
  return { agent, userId: r.body.user.userId };
};

describe('account data needs a session for that account', () => {
  it('anonymous → 401; another signed-in user → 403; the owner → 200', async () => {
    expect((await request(app).get('/api/patient-summary?userId=victim01')).status).toBe(401);
    const { agent, userId } = await signedInAs();
    expect((await agent.get('/api/patient-summary?userId=victim01')).status).toBe(403);
    expect((await agent.get(`/api/patient-summary?userId=${userId}`)).status).toBe(200);
  });
});

describe('no session without proof of ownership', () => {
  it('account/recreate refuses an existing account and signs nobody in', async () => {
    const agent = request.agent(app);
    for (const id of ['victim01', 'keyholder01']) {
      const r = await agent.post('/api/account/recreate').send({ userId: id });
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('ACCOUNT_EXISTS');
    }
    expect((await agent.get('/api/current-user')).body.authenticated).toBe(false);
    expect((await request(app).post('/api/account/recreate').send({ userId: 'admin' })).status).toBe(403);
  });

  it('account/recreate still restores a destroyed account', async () => {
    const r = await request(app).post('/api/account/recreate').send({ userId: 'ghost01' });
    expect(r.status).toBe(200);
    expect(r.body.recreated).toBe(true);
  });

  it('temporary/restore needs this browser\'s signed cookie (or a session)', async () => {
    const anon = await request(app).post('/api/temporary/restore').send({ userId: 'victim01' });
    expect(anon.status).toBe(401);
    expect(anon.body.error).toBe('SIGN_IN_REQUIRED');

    const { agent, userId } = await signedInAs();
    const own = await agent.post('/api/temporary/restore').send({ userId });
    expect(own.status).toBe(200);
    expect(own.body.authenticated).toBe(true);
  });

  it('a forged, unsigned temporary-account cookie is not a credential', async () => {
    const r = await request(app).post('/api/temporary/start').set('Cookie', 'maia_temp_user=victim01').send({});
    expect(r.body.authenticated).toBe(true);
    expect(r.body.user.userId).not.toBe('victim01');
  });

  it('adding a passkey to an existing account requires being signed in to it', async () => {
    const anon = await request(app).post('/api/passkey/register').send({ userId: 'victim01', displayName: 'x' });
    expect(anon.status).toBe(403);
    expect(anon.body.code).toBe('NOT_ACCOUNT_OWNER');

    const { agent, userId } = await signedInAs();
    const own = await agent.post('/api/passkey/register').send({ userId, displayName: userId });
    expect(own.status).toBe(200);
    expect(own.body.challenge).toBe('challenge-1');
  });
});
