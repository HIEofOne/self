/**
 * One join per account and group at a time. On the test app every member
 * appeared twice at the registry: a second join arrived while the first was
 * still talking to the registry over its public URL, both passed the
 * "already a member" check, each registered its own pairwise key, and the
 * account kept only one — the other stayed an orphaned "active" record.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { serve } from '../helpers/serve.js';
import setupGroupRoutes from '../../server/routes/groups.js';

const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
class FakeCloudant {
  constructor() { this.dbs = new Map(); }
  db(name) { if (!this.dbs.has(name)) this.dbs.set(name, new Map()); return this.dbs.get(name); }
  async getDocument(dbName, id) { return clone(this.db(dbName).get(id) || null); }
  async saveDocument(dbName, doc) { this.db(dbName).set(doc._id, clone(doc)); return { id: doc._id, ok: true }; }
  async deleteDocument(dbName, id) { this.db(dbName).delete(id); }
  async getAllDocuments(dbName) { return [...this.db(dbName).values()].map(clone); }
  async findDocuments() { return { docs: [] }; }
}

const REGISTRY = 'https://registry.test';
let server, cloudant, registryJoins, realFetch;

beforeEach(async () => {
  cloudant = new FakeCloudant();
  await cloudant.saveDocument('maia_users', { _id: 'aaron19', userId: 'aaron19', type: 'user', emailVerified: true });
  registryJoins = 0;
  realFetch = globalThis.fetch;
  const passThrough = realFetch;
  globalThis.fetch = async (url, opts) => {
    if (!String(url).startsWith(REGISTRY)) return passThrough(url, opts);
    registryJoins += 1;
    // The registry takes a moment (a public URL, not localhost).
    await new Promise((r) => setTimeout(r, 50));
    return { ok: true, status: 200, json: async () => ({ success: true, pairwiseId: `pw_${registryJoins}`, groupName: 'Trustee Test' }) };
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId: 'aaron19' }; next(); });
  setupGroupRoutes(app, cloudant, { logEvent: () => {} }, { sendEmail: async () => true });
  server = await serve(app);
});
afterEach(() => { globalThis.fetch = realFetch; });

const join = () => request(server).post('/api/user-groups/request-join')
  .send({ userId: 'aaron19', groupId: 'trustee-test', token: 'tok', alias: 'aaron19', registryUrl: REGISTRY });

describe('request-join', () => {
  it('a second join while the first is on its way is refused, and the registry sees one', async () => {
    const [a, b] = await Promise.all([join(), join()]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a.body.error, b.body.error]).toContain('JOIN_IN_PROGRESS');
    expect(registryJoins).toBe(1);
    const doc = await cloudant.getDocument('maia_users', 'aaron19');
    expect(doc.pendingGroupJoins).toHaveLength(1);
  });

  it('after it finishes, the usual "already pending" answer applies — and the lock is released', async () => {
    expect((await join()).status).toBe(200);
    const again = await join();
    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/already pending/);
    expect(registryJoins).toBe(1);
  });
});
