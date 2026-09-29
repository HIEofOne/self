/**
 * A MAIA on a phone or in Safari (companion mode): signing in with a passkey
 * alone, the account named by the passkey's host-qualified handle; the
 * folder key's passkey copy, kept only for the account's own passkey and
 * current folder key; and the note that the folder's PDFs must catch up on
 * the computer.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { serve } from '../helpers/serve.js';
import setupAuthRoutes, { accountFromUserHandle } from '../../server/routes/auth.js';
import setupReceivedRoutes, { wrappedFor } from '../../server/routes/received.js';
import setupSetupRoutes, { deriveSetupStatus } from '../../server/routes/setup.js';
import { getEdition, setEditionForTests } from '../../server/edition.js';

const originalEdition = getEdition();
afterAll(() => setEditionForTests(originalEdition));
const b64u = (s) => Buffer.from(s, 'utf8').toString('base64url');

class FakeCloudant {
  constructor(docs = []) { this.docs = new Map(docs.map((d) => [d._id, JSON.parse(JSON.stringify(d))])); }
  async getDocument(_db, id) { const d = this.docs.get(id); return d ? JSON.parse(JSON.stringify(d)) : null; }
  async saveDocument(_db, doc) { this.docs.set(doc._id, JSON.parse(JSON.stringify({ ...doc, _rev: String(Date.now()) }))); return { ok: true }; }
  async getAllDocuments() { return [...this.docs.values()]; }
  async findDocuments(_db, q) {
    const id = q.selector?.credentialID?.$eq;
    return { docs: [...this.docs.values()].filter((d) => d.credentialID === id) };
  }
}

describe('the account a passkey names', () => {
  it('reads <userId>@<host> for this host only, or an older bare handle', () => {
    expect(accountFromUserHandle(b64u('ann01@maia.agropper.xyz'), 'maia.agropper.xyz')).toBe('ann01');
    expect(accountFromUserHandle(b64u('ann01@test.agropper.xyz'), 'maia.agropper.xyz')).toBeNull();
    expect(accountFromUserHandle(b64u('admin'), 'maia.agropper.xyz')).toBe('admin');
    expect(accountFromUserHandle(b64u('../etc@maia.agropper.xyz'), 'maia.agropper.xyz')).toBeNull();
    expect(accountFromUserHandle('', 'x')).toBeNull();
    expect(accountFromUserHandle(undefined, 'x')).toBeNull();
  });
});

describe('signing in with a passkey alone', () => {
  const USER = { _id: 'ann01', userId: 'ann01', displayName: 'Ann', credentialID: 'cred-ann', credentialPublicKey: 'pk', counter: 1, emailVerified: false };
  const OLD = { _id: 'bo02', userId: 'bo02', displayName: 'Bo', credentialID: 'cred-bo', credentialPublicKey: 'pk', counter: 1, emailVerified: false };
  const fakePasskeys = {
    rpID: 'agropper.xyz',
    hostname: () => 'maia.agropper.xyz',
    resolveExpectedOrigin: () => 'https://maia.agropper.xyz',
    generateDiscoverableOptions: async () => ({ challenge: 'chal-1', rpId: 'agropper.xyz', userVerification: 'required' }),
    verifyAuthentication: async ({ response, expectedChallenge, userDoc }) => ({
      verified: expectedChallenge === 'chal-1' && response.response.signature === 'good',
      userDoc: { ...userDoc, counter: 2 }
    })
  };
  let server;
  let cloudant;
  beforeEach(async () => {
    setEditionForTests('personal-as'); // no agent before a verified email: ensureUserAgent returns at once
    cloudant = new FakeCloudant([USER, OLD]);
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 't', resave: false, saveUninitialized: false }));
    setupAuthRoutes(app, fakePasskeys, cloudant, { agent: {} }, { logEvent: async () => {} });
    server = await serve(app);
  });
  const assertion = (id, handle, signature = 'good') => ({ id, rawId: id, type: 'public-key', response: { userHandle: handle ? b64u(handle) : undefined, signature } });

  it('the chosen passkey names the account; the challenge is used once', async () => {
    const agent = request.agent(server);
    const opts = await agent.post('/api/passkey/discover');
    expect(opts.body).toMatchObject({ challenge: 'chal-1' });
    expect(opts.body.allowCredentials).toBeUndefined();
    const ok = await agent.post('/api/passkey/discover-verify').send({ response: assertion('cred-ann', 'ann01@maia.agropper.xyz') });
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ userId: 'ann01', displayName: 'Ann' });
    expect((await cloudant.getDocument('maia_users', 'ann01')).counter).toBe(2);
    const again = await agent.post('/api/passkey/discover-verify').send({ response: assertion('cred-ann', 'ann01@maia.agropper.xyz') });
    expect(again.status).toBe(400);
  });

  it('an older passkey with a bare handle is found by its id', async () => {
    const agent = request.agent(server);
    await agent.post('/api/passkey/discover');
    const ok = await agent.post('/api/passkey/discover-verify').send({ response: assertion('cred-bo', null) });
    expect(ok.body.user?.userId).toBe('bo02');
  });

  it('refuses another host\'s passkey, a passkey that isn\'t the account\'s, and a bad signature', async () => {
    for (const [a, status] of [
      [assertion('cred-ann', 'ann01@test.agropper.xyz'), 404],
      [assertion('cred-other', 'ann01@maia.agropper.xyz'), 404],
      [assertion('cred-ann', 'ann01@maia.agropper.xyz', 'bad'), 400]
    ]) {
      const agent = request.agent(server);
      await agent.post('/api/passkey/discover');
      expect((await agent.post('/api/passkey/discover-verify').send({ response: a })).status).toBe(status);
    }
    // No challenge in this session: start again.
    expect((await request(server).post('/api/passkey/discover-verify').send({ response: assertion('cred-ann', 'ann01@maia.agropper.xyz') })).status).toBe(400);
  });
});

describe('the folder key\'s passkey copy', () => {
  const X = 'x'.repeat(43);
  const base = { _id: 'ann01', userId: 'ann01', credentialID: 'cred-ann', folderKeyJwk: { kty: 'OKP', crv: 'X25519', x: X } };
  let server;
  let cloudant;
  beforeEach(async () => {
    cloudant = new FakeCloudant([base]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { userId: 'ann01' }; next(); });
    setupReceivedRoutes(app, { cloudant, holds: null });
    server = await serve(app);
  });
  const wrapped = { credentialId: 'cred-ann', x: X, iv: 'aXZpdml2aXZpdml2', ct: 'Y2lwaGVydGV4dA' };

  it('keeps one copy, for the account\'s own passkey and current folder key only', async () => {
    expect((await request(server).get('/api/folder-key/wrapped')).body).toMatchObject({ success: true, wrapped: null, credentialId: 'cred-ann' });
    expect((await request(server).put('/api/folder-key/wrapped').send({ ...wrapped, credentialId: 'cred-other' })).status).toBe(409);
    expect((await request(server).put('/api/folder-key/wrapped').send({ ...wrapped, x: 'y'.repeat(43) })).status).toBe(409);
    expect((await request(server).put('/api/folder-key/wrapped').send({ ...wrapped, ct: 'not base64url!' })).status).toBe(400);
    expect((await request(server).put('/api/folder-key/wrapped').send(wrapped)).status).toBe(200);
    expect((await request(server).get('/api/folder-key/wrapped')).body.wrapped).toMatchObject(wrapped);
  });

  it('a new folder key drops the copy of the old one; so does a new passkey', async () => {
    await request(server).put('/api/folder-key/wrapped').send(wrapped);
    await request(server).post('/api/folder-key').send({ publicJwk: { kty: 'OKP', crv: 'X25519', x: 'z'.repeat(43) } });
    expect((await request(server).get('/api/folder-key/wrapped')).body.wrapped).toBeNull();
    const d = { ...base, folderKeyWrapped: { v: 1, ...wrapped } };
    expect(wrappedFor(d)).toMatchObject(wrapped);
    expect(wrappedFor({ ...d, credentialID: 'cred-new' })).toBeNull();
  });
});

describe('the folder catching up on the computer', () => {
  it('setup status reports the passkey copy and what the folder must catch up on', () => {
    const s = deriveSetupStatus({ userId: 'a', credentialID: 'c', folderKeyJwk: { x: 'k' }, folderKeyWrapped: { v: 1, credentialId: 'c', x: 'k', iv: 'i', ct: 'c' }, folderCatchUp: { summary: '2026-09-28T00:00:00Z' } });
    expect(s).toMatchObject({ folderKeyOnPasskey: true, hasFolderKey: true, folderCatchUp: { summary: '2026-09-28T00:00:00Z' } });
    expect(deriveSetupStatus({ userId: 'a' })).toMatchObject({ folderKeyOnPasskey: false, hasFolderKey: false, folderCatchUp: {} });
  });

  it('a note is set, and cleared once the computer has rewritten the PDFs', async () => {
    const cloudant = new FakeCloudant([{ _id: 'ann01', userId: 'ann01' }]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { userId: 'ann01' }; next(); });
    setupSetupRoutes(app, cloudant);
    const server = await serve(app);
    expect((await request(server).post('/api/setup/folder-catch-up').send({ what: 'rules' })).body.folderCatchUp).toHaveProperty('rules');
    expect((await request(server).post('/api/setup/folder-catch-up').send({ what: 'summary' })).body.folderCatchUp).toHaveProperty('summary');
    const cleared = await request(server).post('/api/setup/folder-catch-up').send({ what: 'rules', done: true });
    expect(Object.keys(cleared.body.folderCatchUp)).toEqual(['summary']);
    expect((await request(server).post('/api/setup/folder-catch-up').send({ what: 'everything' })).status).toBe(400);
  });
});
