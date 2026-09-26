/**
 * New activity on the welcome page before sign-in: a signed-in session gets
 * a token for its own account; with it, a signed-out page reads that
 * account's counts and nothing else. Another account's token, a guessed
 * token, or none reads nothing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { serve } from '../helpers/serve.js';
import setupWelcomeActivityRoutes, { activityCounts } from '../../server/routes/welcome-activity.js';
import { createApiGuard } from '../../server/utils/api-guard.js';

const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
class FakeCloudant {
  constructor() { this.dbs = new Map(); }
  db(n) { if (!this.dbs.has(n)) this.dbs.set(n, new Map()); return this.dbs.get(n); }
  async getDocument(n, id) { return clone(this.db(n).get(id) || null); }
  async saveDocument(n, doc) { this.db(n).set(doc._id, clone(doc)); return { ok: true }; }
  async getAllDocuments(n) { return [...this.db(n).values()].map(clone); }
}

let server, cloudant;
beforeEach(async () => {
  cloudant = new FakeCloudant();
  await cloudant.saveDocument('maia_users', {
    _id: 'pat01', userId: 'pat01', email: 'secret@example.com',
    groupMemberships: [{ groupId: 'g1', inbox: [{ id: 'm1' }, { id: 'm2' }] }, { groupId: 'g2', inbox: [{ id: 'm3' }] }]
  });
  await cloudant.saveDocument('maia_users', { _id: 'pat02', userId: 'pat02' });
  for (const [id, over] of [['r1', { status: 'pending' }], ['r2', { status: 'pending', document: { state: 'held' } }],
    ['r3', { status: 'accepted', document: { state: 'accepted' } }], ['r4', { status: 'declined' }], ['r5', { status: 'pending', userId: 'pat02' }]]) {
    await cloudant.saveDocument('maia_as_requests', { _id: id, type: 'as_request', userId: 'pat01', ...over });
  }
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { const u = req.get('x-test-user'); req.session = u ? { userId: u } : {}; next(); });
  app.use('/api', createApiGuard({ getDeepLinkOwnerId: async () => null }));
  setupWelcomeActivityRoutes(app, { cloudant, secret: 'test-secret' });
  server = await serve(app);
});

const tokenFor = async (userId) => (await request(server).post('/api/welcome-activity/token').set('x-test-user', userId)).body.token;
const read = (userId, token) => {
  const r = request(server).get(`/api/welcome-activity?userId=${userId}`);
  return token === undefined ? r : r.set('X-Maia-Activity', token);
};

describe('welcome-page activity', () => {
  it('a signed-in session gets its own token; signed out, there is none to get', async () => {
    expect((await request(server).post('/api/welcome-activity/token')).status).toBe(401);
    const t = await tokenFor('pat01');
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('with the token, a signed-out page reads the counts and nothing else', async () => {
    const r = await read('pat01', await tokenFor('pat01'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, pendingRequests: 2, messageCount: 3, documentsToSave: 1 });
    expect(JSON.stringify(r.body)).not.toContain('secret@example.com');
  });

  it('no token, a guessed one, or another account’s: nothing', async () => {
    expect((await read('pat01')).status).toBe(401);
    expect((await read('pat01', 'x'.repeat(43))).status).toBe(401);
    expect((await read('pat01', await tokenFor('pat02'))).status).toBe(401);
  });

  it('the account’s own session works without a token', async () => {
    const r = await request(server).get('/api/welcome-activity?userId=pat01').set('x-test-user', 'pat01');
    expect(r.body.pendingRequests).toBe(2);
  });

  it('counts only this account’s requests', () => {
    expect(activityCounts({ userId: 'pat02' }, [{ type: 'as_request', userId: 'pat02', status: 'pending' }, { type: 'as_request', userId: 'pat01', status: 'pending' }]))
      .toEqual({ pendingRequests: 1, messageCount: 0, documentsToSave: 0 });
  });
});
