/**
 * Adding a passkey to a new account while its private AI is starting: the
 * passkey must not wait for, or fail with, the private AI (the page spun,
 * or showed an error though the passkey was saved), and a start that fails
 * after the agent was created must release its lock (a lock left behind
 * made every later call for the account wait forever).
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { serve } from '../helpers/serve.js';
import setupAuthRoutes, { ensureUserAgent } from '../../server/routes/auth.js';
import { EDITIONS, getEdition, setEditionForTests } from '../../server/edition.js';

const originalEdition = getEdition();
afterAll(() => setEditionForTests(originalEdition));

class Store {
  constructor(docs = []) { this.docs = new Map(docs.map((d) => [d._id, { ...structuredClone(d), _rev: '1-x' }])); this.n = 1; }
  async getDocument(_db, id) { const d = this.docs.get(id); return d ? structuredClone(d) : null; }
  async saveDocument(_db, doc) { const rev = `${++this.n}-x`; this.docs.set(doc._id, { ...structuredClone(doc), _rev: rev }); return { ok: true, id: doc._id, rev }; }
}

const AGENT = { uuid: '11111111-2222-4333-8444-555555555555', name: 'ann01-agent', deployment: { url: 'https://agent.example' }, model: { inference_name: 'qwen3.8-max' } };
const within = (p, ms = 1000) => Promise.race([p, new Promise((r) => setTimeout(() => r('still waiting'), ms))]);

describe('a start that fails after the agent was created', () => {
  const saved = { model: process.env.DO_MODEL_ID, project: process.env.DO_PROJECT_ID };
  afterEach(() => {
    for (const [k, v] of [['DO_MODEL_ID', saved.model], ['DO_PROJECT_ID', saved.project]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it('releases the lock: a call waiting on it goes on instead of waiting forever', async () => {
    process.env.DO_MODEL_ID = '22222222-2222-4333-8444-555555555555';
    process.env.DO_PROJECT_ID = '33333333-2222-4333-8444-555555555555';
    const store = new Store([{ _id: 'ann01', userId: 'ann01', emailVerified: true }]);
    let gets = 0;
    const doClient = {
      agent: {
        create: async () => ({ uuid: AGENT.uuid }),
        get: async () => { gets += 1; await new Promise((r) => setTimeout(r, 20)); if (gets === 1) throw new Error('DO 503'); return AGENT; }
      }
    };
    const first = ensureUserAgent(doClient, store, await store.getDocument('maia_users', 'ann01'));
    const waiting = ensureUserAgent(doClient, store, await store.getDocument('maia_users', 'ann01'));
    await expect(first).rejects.toThrow('DO 503');
    const second = await within(waiting);
    expect(second).not.toBe('still waiting');
    expect(second.assignedAgentId).toBe(AGENT.uuid);
  });
});

describe.each(EDITIONS)('adding a passkey while the private AI cannot start, edition "%s"', (edition) => {
  it('the passkey is saved and the sign-up goes on', async () => {
    setEditionForTests(edition);
    const store = new Store([{ _id: 'ann01', userId: 'ann01', displayName: 'ann01', emailVerified: true, temporaryAccount: true, challenge: 'chal-1' }]);
    const passkeys = {
      rpID: 'localhost',
      resolveExpectedOrigin: () => 'http://localhost:5173',
      verifyRegistration: async ({ expectedChallenge }) => ({ verified: expectedChallenge === 'chal-1', credentialInfo: { credentialID: 'cred-ann', credentialPublicKey: 'pk', counter: 0 } })
    };
    // A DO client that can't start anything: the start throws.
    const doClient = { agent: { list: async () => { throw new Error('DO down'); } }, request: async () => { throw new Error('DO down'); } };
    const app = express();
    app.use(express.json());
    app.use(session({ secret: 't', resave: false, saveUninitialized: false }));
    setupAuthRoutes(app, passkeys, store, doClient, { logEvent: async () => {} });
    const server = await serve(app);
    const r = await within(request(server).post('/api/passkey/register-verify').send({ userId: 'ann01', response: { id: 'cred-ann' } }), 3000);
    expect(r).not.toBe('still waiting');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, user: { userId: 'ann01', isTemporary: false } });
    const doc = await store.getDocument('maia_users', 'ann01');
    expect(doc).toMatchObject({ credentialID: 'cred-ann', temporaryAccount: false });
    expect(doc.challenge).toBeUndefined();
  });
});
