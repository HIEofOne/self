/**
 * Two-host simulation of the cross-host autonomous-response flow (PR #279),
 * driving the REAL route handlers from server/routes/groups.js.
 *
 * Host A (hosta.test) = registry host: owns the "Trustee Test" group.
 * Host B (hostb.test) = jessica76's MAIA host: owns her userDoc.
 * bob's userDoc lives on Host A (same-host member, cross-host to jessica).
 *
 * Self-contained: in-memory cloudant fakes + a fake global fetch that
 * routes cross-host HTTP to the right in-memory app. No CouchDB needed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import setupGroupRoutes from '../../server/routes/groups.js';
import { issueCode, checkCode } from '../../server/emailVerification.js';

const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));

const matchSelector = (doc, selector) => {
  for (const [k, cond] of Object.entries(selector || {})) {
    const val = doc?.[k];
    if (cond && typeof cond === 'object' && '$elemMatch' in cond) {
      if (!Array.isArray(val)) return false;
      if (!val.some((el) => matchSelector(el, cond.$elemMatch))) return false;
    } else if (cond && typeof cond === 'object' && '$eq' in cond) {
      if (val !== cond.$eq) return false;
    } else if (cond && typeof cond === 'object') {
      if (!matchSelector(val, cond)) return false;
    } else if (val !== cond) return false;
  }
  return true;
};

class FakeCloudant {
  constructor() { this.dbs = new Map(); }
  db(name) { if (!this.dbs.has(name)) this.dbs.set(name, new Map()); return this.dbs.get(name); }
  async getDocument(dbName, id) { return clone(this.db(dbName).get(id) || null); }
  async saveDocument(dbName, doc) { this.db(dbName).set(doc._id, clone(doc)); return { id: doc._id, ok: true }; }
  async deleteDocument(dbName, id) { this.db(dbName).delete(id); }
  async getAllDocuments(dbName) { return [...this.db(dbName).values()].map(clone); }
  async findDocuments(dbName, query) {
    const docs = [...this.db(dbName).values()].filter((d) => matchSelector(d, query.selector)).map(clone);
    return { docs: query.limit ? docs.slice(0, query.limit) : docs };
  }
}

class FakeApp {
  constructor() { this.routes = []; }
  get(path, handler) { this.routes.push({ method: 'GET', path, handler }); }
  post(path, handler) { this.routes.push({ method: 'POST', path, handler }); }
  put(path, handler) { this.routes.push({ method: 'PUT', path, handler }); }
  delete(path, handler) { this.routes.push({ method: 'DELETE', path, handler }); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const pat = r.path.split('/');
      const got = pathname.split('/');
      if (pat.length !== got.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < pat.length; i++) {
        if (pat[i].startsWith(':')) params[pat[i].slice(1)] = decodeURIComponent(got[i]);
        else if (pat[i] !== got[i]) { ok = false; break; }
      }
      if (ok) return { handler: r.handler, params };
    }
    return null;
  }
  async request(host, method, url, body, session = {}) {
    const u = new URL(url, `https://${host}`);
    const m = this.match(method, u.pathname);
    if (!m) return { status: 404, body: { error: `no route ${method} ${u.pathname}` } };
    const req = {
      params: m.params,
      query: Object.fromEntries(u.searchParams.entries()),
      body: body || {},
      session,
      ip: '127.0.0.1',
      protocol: 'https',
      hostname: host,
      get: () => host
    };
    let statusCode = 200; let payload = null;
    const res = {
      status(n) { statusCode = n; return this; },
      json(obj) { payload = obj; return this; }
    };
    await m.handler(req, res);
    return { status: statusCode, body: payload };
  }
}

const hosts = {}; // origin → { app, cloudant, emails, audits }
const admin = { userId: 'admin' };

const mkHost = (origin) => {
  const app = new FakeApp();
  const cloudant = new FakeCloudant();
  const emails = [];
  const audits = [];
  setupGroupRoutes(app, cloudant, { logEvent: (e) => audits.push(e) }, {
    sendEmail: async (to, subject, textOrLines) => {
      emails.push({ to, subject, text: Array.isArray(textOrLines) ? textOrLines.join('\n') : String(textOrLines) });
      return true;
    }
  });
  hosts[origin] = { app, cloudant, emails, audits };
  return hosts[origin];
};

let A, B, realFetch, realAppUrl;
let groupId, reqId, jessPw;

beforeAll(async () => {
  realFetch = globalThis.fetch;
  realAppUrl = process.env.PUBLIC_APP_URL;
  process.env.PUBLIC_APP_URL = 'https://hosta.test';
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const h = hosts[u.origin];
    if (!h) throw new Error(`fetch to unknown host: ${u.origin}`);
    const r = await h.app.request(u.host, (opts.method || 'GET').toUpperCase(), u.pathname + u.search,
      opts.body ? JSON.parse(opts.body) : undefined);
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  A = mkHost('https://hosta.test'); // registry ("hieofone")
  B = mkHost('https://hostb.test'); // jessica's MAIA ("agropper")
});

afterAll(() => {
  globalThis.fetch = realFetch;
  if (realAppUrl === undefined) delete process.env.PUBLIC_APP_URL;
  else process.env.PUBLIC_APP_URL = realAppUrl;
});

describe('cross-host autonomous responses (registry on Host A, member AS on Host B)', () => {
  it('creates the group and mints invites on Host A', async () => {
    const cg = await A.app.request('hosta.test', 'POST', '/api/groups', { name: 'Trustee Test' }, admin);
    groupId = cg.body?.group?.groupId;
    expect(groupId).toBeTruthy();
  });

  it('jessica76 joins CROSS-HOST from Host B; bob joins same-host on A', async () => {
    const invite = async (email) => {
      const r = await A.app.request('hosta.test', 'POST', `/api/groups/${groupId}/invites`, { email }, admin);
      return new URL(r.body.invite.inviteLink).searchParams.get('groupInvite');
    };
    await B.cloudant.saveDocument('maia_users', {
      _id: 'jessica76', userId: 'jessica76',
      email: 'jessica76@example.com', emailVerified: true,
      currentMedications: 'Current Medications:\n- Aspirin 81mg daily\nAllergies: none',
      privacyFilteredSummary: { text: '# Patient Summary\nFirst12 Last34, DOB [filtered]\nDx: hypertension.' },
      privacyFilter: { pseudonymMapping: [] },
      sharingPolicies: []
    });
    const join = await B.app.request('hostb.test', 'POST', '/api/user-groups/join',
      { userId: 'jessica76', groupId, token: await invite('jessica76@example.com'), alias: 'jessica76', registryUrl: 'https://hosta.test' });
    expect(join.body?.success).toBe(true);
    expect(join.body?.membership?.registryUrl).toBe('https://hosta.test');

    await A.cloudant.saveDocument('maia_users', {
      _id: 'bob', userId: 'bob', email: 'bob@example.com', emailVerified: true, sharingPolicies: []
    });
    const bjoin = await A.app.request('hosta.test', 'POST', '/api/user-groups/join',
      { userId: 'bob', groupId, token: await invite('bob@example.com'), alias: 'bob', registryUrl: 'https://hosta.test' });
    expect(bjoin.body?.success).toBe(true);

    // Jessica adopts two allow cards (as if imported from suggestions).
    const jd = await B.cloudant.getDocument('maia_users', 'jessica76');
    jd.sharingPolicies = [
      { id: 'pol_ve_meds', outcome: 'allow', enabled: true, provenance: 'user',
        elements: { party: { type: 'anyone' }, purpose: 'clinical', scope: 'meds-allergies', filtered: true, signature: 'verified-email', payment: 'none' }, createdFrom: 'manual' },
      { id: 'pol_gm_ps', outcome: 'allow', enabled: true, provenance: `group:${groupId}`,
        elements: { party: { type: 'group', groupId, groupName: 'Trustee Test' }, purpose: 'peer-support', scope: 'patient-summary', filtered: true, signature: 'group-member', payment: 'none' }, createdFrom: 'manual' }
    ];
    await B.cloudant.saveDocument('maia_users', jd);
  });

  it('outside request with verified email is delivered but undecided (jessica cross-host)', async () => {
    const issued = issueCode('visitor@example.com');
    checkCode(issued.token, issued.code);
    const outReq = await A.app.request('hosta.test', 'POST', `/api/groups/${groupId}/outside-request`, {
      name: 'Dr Visitor', email: 'visitor@example.com', message: 'Please share for a consult',
      scope: 'meds-allergies', purpose: 'clinical', emailVerifyToken: issued.token
    });
    expect(outReq.body?.success).toBe(true);
    reqId = outReq.body.requestId;
    expect(outReq.body.delivered).toBe(2);
    const st = await A.app.request('hosta.test', 'GET', `/api/groups/${groupId}/outside-request/${reqId}/status`);
    expect(st.body.responded).toBe(0);
  });

  it('jessica refresh on Host B: ingest auto-accepts, emails visitor, bumps registry tally', async () => {
    const ref = await B.app.request('hostb.test', 'POST', '/api/user-groups/refresh', { userId: 'jessica76' });
    expect(ref.body?.success).toBe(true);

    const visitorMail = B.emails.find((e) => e.to === 'visitor@example.com');
    expect(visitorMail).toBeTruthy();
    expect(visitorMail.text).toContain('Aspirin 81mg');
    // The deciding card is never disclosed to the requester.
    expect(visitorMail.text).not.toMatch(/may receive|policy card|verified-email identity/i);

    expect(B.emails.some((e) => e.to === 'jessica76@example.com' && /already responded/i.test(e.text))).toBe(true);

    const st = await A.app.request('hosta.test', 'GET', `/api/groups/${groupId}/outside-request/${reqId}/status`);
    expect(st.body.responded).toBe(1);
    expect(st.body.accepted).toBe(1);

    const reqs = await B.app.request('hostb.test', 'GET', `/api/user-groups/requests?userId=jessica76`);
    expect(reqs.body.requests.find((r) => r.fromOutsider)?.status).toBe('accepted');
  });

  it('re-refresh is idempotent: no duplicate docs, emails, or tally bumps', async () => {
    const emailsBefore = B.emails.length;
    await B.app.request('hostb.test', 'POST', '/api/user-groups/refresh', { userId: 'jessica76' });
    const reqs = await B.app.request('hostb.test', 'GET', `/api/user-groups/requests?userId=jessica76`);
    expect(reqs.body.requests.filter((r) => r.fromOutsider).length).toBe(1);
    expect(B.emails.length).toBe(emailsBefore);
    const st = await A.app.request('hosta.test', 'GET', `/api/groups/${groupId}/outside-request/${reqId}/status`);
    expect(st.body.responded).toBe(1);
  });

  it("bob's cross-host PS request gets an in-app relay reply + nudge from jessica's card", async () => {
    // Drain bob's relay queue (pull, then ack-and-delete on the second
    // refresh) so his own copy of the earlier outside request doesn't
    // clutter the message assertions below.
    await A.app.request('hosta.test', 'POST', '/api/user-groups/refresh', { userId: 'bob' });
    await A.app.request('hosta.test', 'POST', '/api/user-groups/refresh', { userId: 'bob' });

    const groupDoc = await A.cloudant.getDocument('maia_groups', groupId);
    jessPw = groupDoc.members.find((m) => m.alias === 'jessica76')?.pairwiseId;
    expect(jessPw).toBeTruthy();

    const mreq = await A.app.request('hosta.test', 'POST', '/api/user-groups/request', {
      userId: 'bob', groupId, toPairwiseId: jessPw,
      action: 'share-request', resource: 'patient-summary', purpose: 'peer-support', payload: 'peer support please'
    });
    expect(mreq.body?.success).toBe(true);

    // Host A's delivery-time trigger can't resolve jessica (cross-host);
    // her own host decides at her next refresh.
    const bBefore = B.emails.length;
    await B.app.request('hostb.test', 'POST', '/api/user-groups/refresh', { userId: 'jessica76' });
    const jreqs = await B.app.request('hostb.test', 'GET', `/api/user-groups/requests?userId=jessica76`);
    expect(jreqs.body.requests.find((r) => !r.fromOutsider)?.status).toBe('accepted');
    // No direct email possible from Host B — bob is unresolvable there…
    expect(B.emails.slice(bBefore).some((e) => e.to === 'bob@example.com')).toBe(false);

    // …but the sealed relay reply reaches him on HIS host, with a nudge.
    await A.app.request('hosta.test', 'POST', '/api/user-groups/refresh', { userId: 'bob' });
    const bobMsgs = await A.app.request('hosta.test', 'GET', `/api/user-groups/messages?userId=bob&groupId=${groupId}`);
    const reply = (bobMsgs.body.messages || []).find((m) => /MAIA responded to your request automatically/.test(m.text || ''));
    expect(reply).toBeTruthy();
    expect(reply.text).toContain('hypertension');
    expect(A.emails.some((e) => e.to === 'bob@example.com' && /new message/i.test(e.subject))).toBe(true);
  });

  it('nudge is time-debounced: a second message inside the quiet period sends no second email', async () => {
    const nudgesBefore = A.emails.filter((e) => e.to === 'bob@example.com' && /new message/i.test(e.subject)).length;
    const groupDoc = await A.cloudant.getDocument('maia_groups', groupId);
    const bobPw = groupDoc.members.find((m) => m.alias === 'bob')?.pairwiseId;
    const send = await B.app.request('hostb.test', 'POST', '/api/user-groups/send', {
      userId: 'jessica76', groupId, toPairwiseId: bobPw, text: 'follow-up note'
    });
    expect(send.body?.success).toBe(true);
    // Delivered (bob sees it on his next pull)…
    await A.app.request('hosta.test', 'POST', '/api/user-groups/refresh', { userId: 'bob' });
    const bobMsgs = await A.app.request('hosta.test', 'GET', `/api/user-groups/messages?userId=bob&groupId=${groupId}`);
    expect((bobMsgs.body.messages || []).some((m) => m.text === 'follow-up note')).toBe(true);
    // …but no second nudge inside the quiet period.
    const nudgesAfter = A.emails.filter((e) => e.to === 'bob@example.com' && /new message/i.test(e.subject)).length;
    expect(nudgesAfter).toBe(nudgesBefore);
  });
});
