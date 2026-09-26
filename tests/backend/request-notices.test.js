/**
 * P8: what MAIA tells the patient about requests, and when (group_requests.md
 * §8.2–8.3, D5, D10): every automatic share at once; asks at most every 6
 * hours; a weekly digest that re-runs can't repeat and a failed send retries;
 * a monthly heartbeat when nothing happened; retention that prunes only what
 * the folder holds; and no health data in any email.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { serve } from '../helpers/serve.js';
import {
  createNotices, renderAsks, renderShared, renderDigest, summarize, requestEvents,
  ASK_QUIET_MS, DIGEST_EVERY_MS, HEARTBEAT_EVERY_MS
} from '../../server/gnap/notices.js';
import setupRequestLogRoutes from '../../server/routes/requests-log.js';

const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
class FakeCloudant {
  constructor() { this.dbs = new Map(); }
  db(n) { if (!this.dbs.has(n)) this.dbs.set(n, new Map()); return this.dbs.get(n); }
  async getDocument(n, id) { return clone(this.db(n).get(id) || null); }
  async saveDocument(n, doc) { this.db(n).set(doc._id, clone(doc)); return { ok: true }; }
  async deleteDocument(n, id) { this.db(n).delete(id); }
  async getAllDocuments(n) { return [...this.db(n).values()].map(clone); }
}

const DAY = 24 * 60 * 60 * 1000;
const SUMMARY = 'Type 2 diabetes. Metformin 500 mg twice daily.';
let cloudant, clock, emails, deliver, notices;
const iso = (t) => new Date(t).toISOString();
const PAT = { _id: 'pat01', userId: 'pat01', email: 'pat@example.com', emailVerified: true, asState: 'active', createdAt: '2026-09-01T00:00:00.000Z' };

const addRequest = async (id, over = {}) => {
  const r = {
    _id: id, type: 'as_request', userId: 'pat01', route: 'gnap-direct', groupName: 'Direct request', fromOutsider: true,
    requester: { name: 'Dr. Test, Local Clinic', email: 'dr@example.com', emailVerified: true },
    resource: 'patient-summary', purpose: 'clinical', payload: `About your ${SUMMARY}`, receivedAt: iso(clock), status: 'pending', ...over
  };
  await cloudant.saveDocument('maia_as_requests', r);
  return r;
};

beforeEach(async () => {
  cloudant = new FakeCloudant();
  clock = Date.parse('2026-09-26T12:00:00Z');
  emails = [];
  deliver = true;
  await cloudant.saveDocument('maia_users', { ...PAT, privacyFilteredSummary: { text: SUMMARY } });
  notices = createNotices({
    cloudant, now: () => clock, appUrl: () => 'https://maia.example',
    sendEmail: async (to, subject, text) => { if (!deliver) return false; emails.push({ to, subject, text }); return true; }
  });
});

describe('immediate notices', () => {
  it('asks: the first emails at once; more within 6 hours wait and go together', async () => {
    await addRequest('r1');
    await notices.ask(PAT);
    expect(emails.map((e) => e.subject)).toEqual(['A request is waiting for you in MAIA']);
    clock += 60 * 60 * 1000;
    await addRequest('r2', { requester: { name: 'Nurse Two', email: null, emailVerified: false } });
    await notices.ask(PAT);
    clock += 60 * 60 * 1000;
    await addRequest('r3');
    await notices.ask(PAT);
    expect(emails).toHaveLength(1);
    expect(await notices.sendDueAsks()).toBe(0); // still inside the quiet period
    clock += ASK_QUIET_MS;
    expect(await notices.sendDueAsks()).toBe(1);
    expect(emails[1].subject).toBe('2 requests are waiting for you in MAIA');
    expect(emails[1].text).toContain('Nurse Two (email not verified)');
    expect(emails[1].text).not.toContain('r1');
  });

  it('every automatic share emails at once, naming who and what, never the data', async () => {
    const r = await addRequest('r1', { status: 'accepted', autonomous: true, decidedAt: iso(clock) });
    await notices.shared(PAT, r._id);
    await notices.shared(PAT, r._id);
    expect(emails).toHaveLength(2);
    expect(emails[0].text).toContain('your Patient Summary for clinical use with Dr. Test, Local Clinic (email verified: dr@example.com)');
  });
});

describe('weekly digest and monthly heartbeat', () => {
  it('once a week; a re-run the same day sends nothing', async () => {
    clock = Date.parse(PAT.createdAt) + DIGEST_EVERY_MS + DAY;
    await addRequest('r1', { status: 'accepted', autonomous: true, decidedAt: iso(clock - DAY) });
    await addRequest('r2');
    expect(await notices.sendDigests()).toBe(1);
    expect(await notices.sendDigests()).toBe(0);
    const d = emails[0];
    expect(d.subject).toBe('Your MAIA this week');
    expect(d.text).toContain('1 shared automatically by your rules');
    expect(d.text).toContain('Waiting for your decision (1)');
    expect(d.text).toContain('doesn’t have a request log yet');
  });

  it('a failed send is retried the next day (the week starts only when it went out)', async () => {
    clock = Date.parse(PAT.createdAt) + DIGEST_EVERY_MS + DAY;
    await addRequest('r1');
    deliver = false;
    expect(await notices.sendDigests()).toBe(0);
    deliver = true;
    clock += DAY;
    expect(await notices.sendDigests()).toBe(1);
  });

  it('a quiet month gets a heartbeat; quiet weeks in between send nothing', async () => {
    clock = Date.parse(PAT.createdAt) + DIGEST_EVERY_MS + DAY;
    expect(await notices.sendDigests()).toBe(0);
    clock = Date.parse(PAT.createdAt) + HEARTBEAT_EVERY_MS + DAY;
    expect(await notices.sendDigests()).toBe(1);
    expect(emails[0].subject).toBe('Your MAIA is on');
    clock += DIGEST_EVERY_MS + DAY;
    expect(await notices.sendDigests()).toBe(0);
  });

  it('reports whether the folder’s request log is up to date', async () => {
    const r = await addRequest('r1', { status: 'declined', decidedAt: iso(clock) });
    const s1 = summarize([r], { since: '2026-09-01T00:00:00.000Z', now: iso(clock + 1), logSyncedThrough: iso(clock - DAY) });
    expect(renderDigest(s1, { appUrl: 'x', sharing: 'on' }).text).toContain('missing 1 request');
    const s2 = summarize([r], { since: '2026-09-01T00:00:00.000Z', now: iso(clock + 1), logSyncedThrough: iso(clock) });
    expect(renderDigest(s2, { appUrl: 'x', sharing: 'on' }).text).toContain('up to date');
  });
});

describe('no health data in any email (I-31)', () => {
  it('ask, share and digest bodies carry neither the summary nor the requester’s message', async () => {
    const r = await addRequest('r1', { status: 'accepted', autonomous: true, decidedAt: iso(clock) });
    const texts = [
      renderAsks([r], 'u').text, renderShared(r, 'u').text,
      renderDigest(summarize([r, await addRequest('r2')], { since: '2026-01-01T00:00:00.000Z', now: iso(clock + 1) }), { appUrl: 'u', sharing: 'on' }).text
    ];
    for (const t of texts) {
      expect(t).not.toContain('Metformin');
      expect(t).not.toContain('diabetes');
    }
  });
});

describe('retention (D10)', () => {
  it('prunes decided requests after 90 days only once the folder has them; any after 365; never undecided', async () => {
    const old = iso(clock - 100 * DAY);
    await addRequest('synced', { receivedAt: old, status: 'declined', decidedAt: old });
    await addRequest('unsynced', { receivedAt: iso(clock - 95 * DAY), status: 'declined', decidedAt: iso(clock - 95 * DAY) });
    await addRequest('ancient', { receivedAt: iso(clock - 400 * DAY), status: 'accepted', decidedAt: iso(clock - 400 * DAY) });
    await addRequest('undecided', { receivedAt: iso(clock - 400 * DAY) });
    await notices.markLogSynced('pat01', iso(clock - 98 * DAY));
    expect(await notices.prune()).toBe(2);
    expect([...cloudant.db('maia_as_requests').keys()].sort()).toEqual(['undecided', 'unsynced']);
  });
});

describe('the request log API', () => {
  it('events after a cursor, deduplicated by id; the folder reports what it holds', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { const u = req.get('x-test-user'); req.session = u ? { userId: u } : {}; next(); });
    setupRequestLogRoutes(app, { cloudant, notices });
    const server = await serve(app);
    await addRequest('r1', { receivedAt: '2026-09-20T10:00:00.000Z', status: 'accepted', decidedAt: '2026-09-21T10:00:00.000Z' });
    await addRequest('r2', { receivedAt: '2026-09-22T10:00:00.000Z' });
    const all = await request(server).get('/api/requests/log?userId=pat01').set('x-test-user', 'pat01');
    expect(all.body.events.map((e) => e.id)).toEqual(['r1:received', 'r1:shared', 'r2:received']);
    expect(all.body.events[1]).toMatchObject({ type: 'shared', by: 'you', what: 'patient-summary' });
    const later = await request(server).get('/api/requests/log?userId=pat01&since=2026-09-21T10:00:00.000Z').set('x-test-user', 'pat01');
    expect(later.body.events.map((e) => e.id)).toEqual(['r2:received']);
    expect((await request(server).get('/api/requests/log?userId=pat01')).status).toBe(401);
    await request(server).post('/api/requests/log/synced').set('x-test-user', 'pat01').send({ userId: 'pat01', through: '2026-09-22T10:00:00.000Z' });
    expect((await notices.getState('pat01')).logSyncedThrough).toBe('2026-09-22T10:00:00.000Z');
  });

  it('a member’s request is logged by alias, with no email', () => {
    const [e] = requestEvents([{ _id: 'm1', type: 'as_request', fromOutsider: false, fromAlias: 'cy55', groupName: 'Trustee', resource: 'patient-summary', purpose: 'peer-support', receivedAt: '2026-09-22T10:00:00.000Z', status: 'pending' }]);
    expect(e.requester).toEqual({ name: 'cy55', member: true });
  });
});
