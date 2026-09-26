/**
 * GNAP, direct route (group_requests.md §10, P4) — the real handlers with an
 * in-memory database, a signing test client and a controllable clock:
 * allow → token → resource server → revoke; ask → patient accepts / declines;
 * silence looks like an unanswered ask (I-29); nothing decides while sharing
 * is off or a card is unconfirmed (I-24); bearer refused (I-28); the scope
 * lattice at the RS; an address rotation stops every direct grant.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { generateKeyPairSync } from 'crypto';
import { serve } from '../helpers/serve.js';
import setupGnapRoutes from '../../server/routes/gnap.js';
import setupGroupRoutes from '../../server/routes/groups.js';
import { signRequest } from '../../server/gnap/httpsig.js';
import { ACCESS_TYPE } from '../../server/gnap/grants.js';
import { grantCredits, getAccount } from '../../server/credits.js';
import { sweepExpiredGnapPayments } from '../../server/gnap/payments.js';
import { getEdition, setEditionForTests } from '../../server/edition.js';

const originalEdition = getEdition();
afterAll(() => setEditionForTests(originalEdition));

const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
class FakeCloudant {
  constructor() { this.dbs = new Map(); }
  db(n) { if (!this.dbs.has(n)) this.dbs.set(n, new Map()); return this.dbs.get(n); }
  async getDocument(n, id) { return clone(this.db(n).get(id) || null); }
  async saveDocument(n, doc) { this.db(n).set(doc._id, clone(doc)); return { ok: true }; }
  async deleteDocument(n, id) { this.db(n).delete(id); }
  async getAllDocuments(n) { return [...this.db(n).values()].map(clone); }
  async findDocuments() { return { docs: [] }; }
}

const AS_ID = 'a'.repeat(32);
const FILTERED = [
  '**Rowan73 Vance28**, 66, F', '', '**Current Medications**', '- Metformin 500 mg twice daily', '',
  '**Allergies**', '- Penicillin (hives)'
].join('\n');
const card = (id, outcome, elements = {}, extra = {}) => ({
  id, outcome, enabled: true, provenance: 'user', confirmedAt: '2026-09-25T00:00:00Z',
  elements: { party: { type: 'anyone' }, purpose: 'clinical', scope: 'patient-summary', filtered: true, signature: 'unverified', payment: 'none', ...elements },
  ...extra
});

let server, cloudant, clock, emails, baseUrl, emailMode;
const patient = () => cloudant.db('maia_users').get('pat01');

beforeEach(async () => {
  setEditionForTests('personal-as');
  clock = Date.parse('2026-09-25T12:00:00Z');
  emails = [];
  emailMode = 'ok';
  cloudant = new FakeCloudant();
  await cloudant.saveDocument('maia_users', {
    _id: 'pat01', userId: 'pat01', email: 'pat@example.com', emailVerified: true, asId: AS_ID, asState: 'active',
    sharingPolicies: [], patientSummaryVerifiedAt: '2026-09-25T00:00:00Z',
    privacyFilteredSummary: { text: FILTERED }, privacyFilter: { pseudonymMapping: [] }
  });
  await cloudant.saveDocument('maia_gnap', { _id: `as_${AS_ID}`, type: 'gnap_as', userId: 'pat01', asId: AS_ID, grants: [] });
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use((req, _res, next) => { const u = req.get('x-test-user'); req.session = u ? { userId: u } : {}; next(); });
  // 'ok' delivers; 'off' is delivery switched off (local dev); 'fail' throws.
  const sendEmail = async (to, subject, text) => {
    if (emailMode === 'fail') throw new Error('provider error');
    if (emailMode === 'off') return false;
    emails.push({ to, subject, text });
    return true;
  };
  setupGnapRoutes(app, { cloudant, sendEmail, now: () => clock, publicBaseUrl: () => baseUrl });
  setupGroupRoutes(app, cloudant, { logEvent: () => {} }, { sendEmail });
  server = await serve(app);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

const newClient = (kid = 'client-1') => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const priv = { ...privateKey.export({ format: 'jwk' }), kid };
  return { priv, pub: { kty: priv.kty, crv: priv.crv, x: priv.x, kid } };
};

/** A signed GNAP call (the reference client does the same). */
const call = (client, method, url, { body = null, token = null } = {}) => {
  const u = new URL(url, baseUrl);
  const text = body ? JSON.stringify(body) : null;
  const headers = { ...(text ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `GNAP ${token}` } : {}) };
  const sig = signRequest({ method, targetUri: u.href, headers, body: text, privateJwk: client.priv, created: Math.floor(clock / 1000) });
  let r = request(server)[method.toLowerCase()](u.pathname + u.search).set(headers).set(sig);
  if (text) r = r.send(text);
  return r;
};

const grantBody = (client, over = {}) => ({
  access_token: { access: [{ type: ACCESS_TYPE, actions: ['read'], datatypes: ['patient-summary'], purpose: 'clinical' }] },
  client: { key: { proof: 'httpsig', jwk: client.pub }, display: { name: 'Dr. Test' } },
  ...over
});
const ask = (client, over) => call(client, 'POST', `/gnap/as/${AS_ID}`, { body: grantBody(client, over) });
const cont = (client, c, body = null) => call(client, 'POST', c.uri, { token: c.access_token.value, body });
const read = (client, at, query = '') => call(client, 'GET', at.access[0].locations[0] + query, { token: at.value });
const decide = async (decision) => {
  const reqs = await request(server).get('/api/user-groups/requests?userId=pat01').set('x-test-user', 'pat01');
  const id = reqs.body.requests.find((r) => r.status === 'pending').id;
  return request(server).post(`/api/user-groups/requests/${id}/decision`).set('x-test-user', 'pat01').send({ userId: 'pat01', decision });
};

describe('the grant request', () => {
  it('discovery names the grant endpoint and httpsig', async () => {
    const r = await request(server).options(`/gnap/as/${AS_ID}`);
    expect(r.body).toMatchObject({ grant_request_endpoint: `${baseUrl}/gnap/as/${AS_ID}`, key_proofs_supported: ['httpsig'] });
  });

  it('refuses a bearer token (I-28), an unknown datatype, and an unsigned request', async () => {
    const c = newClient();
    const bearer = grantBody(c);
    bearer.access_token.flags = ['bearer'];
    expect((await call(c, 'POST', `/gnap/as/${AS_ID}`, { body: bearer })).body.error.code).toBe('invalid_flag');
    const bad = grantBody(c);
    bad.access_token.access[0].datatypes = ['genome'];
    expect((await call(c, 'POST', `/gnap/as/${AS_ID}`, { body: bad })).body.error.code).toBe('invalid_request');
    const unsigned = await request(server).post(`/gnap/as/${AS_ID}`).send(grantBody(c));
    expect(unsigned.status).toBe(401);
  });

  it('an unknown address is just a missing path', async () => {
    const c = newClient();
    expect((await call(c, 'POST', `/gnap/as/${'b'.repeat(32)}`, { body: grantBody(c) })).status).toBe(404);
  });

  it('does not exist in the full edition', async () => {
    setEditionForTests('full');
    const c = newClient();
    expect((await ask(c)).status).toBe(404);
  });
});

describe('allow', () => {
  it('→ a key-bound token → the filtered artifact → revoke → 401', async () => {
    patient().sharingPolicies = [card('pol_allow', 'allow')];
    const c = newClient();
    const r = await ask(c);
    expect(r.status).toBe(200);
    const at = r.body.access_token;
    expect(at.access[0].locations[0]).toMatch(/\/gnap\/rs\//);
    expect(at.access[0].locations[0]).not.toContain(AS_ID); // opaque handles, never the address
    const got = await read(c, at);
    expect(got.status).toBe(200);
    expect(got.body.text).toBe(FILTERED);
    // another key can't use the token
    expect((await read(newClient(), at)).status).toBe(401);
    const revoke = await call(c, 'DELETE', at.manage.uri, { token: at.manage.access_token.value });
    expect(revoke.status).toBe(204);
    expect((await read(c, at)).status).toBe(401);
    expect(emails.map((e) => e.to)).toEqual(['pat@example.com']); // the patient is told; nothing to the requester
    expect(emails[0].text).not.toContain('Metformin');
  });

  it('the RS serves narrower datatypes within the grant, never wider (scope lattice)', async () => {
    patient().sharingPolicies = [card('pol_allow', 'allow')];
    const c = newClient();
    const at = (await ask(c)).body.access_token;
    const meds = await read(c, at, '?datatype=meds-allergies');
    expect(meds.status).toBe(200);
    expect(meds.body.text).toContain('Metformin');
    expect((await read(c, at, '?datatype=everything')).status).toBe(403);
  });

  it('pausing sharing stops every read', async () => {
    patient().sharingPolicies = [card('pol_allow', 'allow')];
    const c = newClient();
    const at = (await ask(c)).body.access_token;
    patient().asState = 'paused';
    expect((await read(c, at)).status).toBe(403);
  });

  it('no verified summary yet → the request asks, never answers empty', async () => {
    patient().sharingPolicies = [card('pol_allow', 'allow')];
    delete patient().patientSummaryVerifiedAt;
    const r = await ask(newClient());
    expect(r.body.continue).toBeTruthy();
    expect(r.body.access_token).toBeUndefined();
  });
});

describe('ask', () => {
  it('→ wait; too fast is refused; the patient accepts → token', async () => {
    const c = newClient();
    const first = await ask(c);
    expect(first.body.continue.wait).toBe(60);
    expect(emails.map((e) => e.subject)).toEqual(['A request is waiting for you in MAIA']);
    expect((await cont(c, first.body.continue)).body.error.code).toBe('too_fast');
    expect((await decide('accept')).status).toBe(200);
    // The decision lifts the wait: collect at once.
    const done = await cont(c, first.body.continue);
    expect(done.status).toBe(200);
    expect((await read(c, done.body.access_token)).body.text).toBe(FILTERED);
  });

  it('→ the patient declines → request_denied, and the requester is never emailed', async () => {
    const c = newClient();
    const first = await ask(c);
    await decide('decline');
    clock += 61 * 1000;
    const done = await cont(c, first.body.continue);
    expect(done.status).toBe(400);
    expect(done.body.error.code).toBe('request_denied');
    expect(emails.every((e) => e.to === 'pat@example.com')).toBe(true);
  });

  it('only the key that asked can continue', async () => {
    const c = newClient();
    const first = await ask(c);
    clock += 61 * 1000;
    const other = newClient();
    expect((await cont(other, first.body.continue)).status).toBe(401);
  });

  it('nothing decides while sharing is off, or with an unconfirmed card (I-24)', async () => {
    patient().sharingPolicies = [card('pol_allow', 'allow')];
    patient().asState = 'setup';
    expect((await ask(newClient())).body.continue).toBeTruthy();
    patient().asState = 'active';
    patient().sharingPolicies = [card('pol_allow', 'allow', {}, { confirmedAt: undefined })];
    expect((await ask(newClient())).body.continue).toBeTruthy();
  });
});

describe('declines are indistinguishable (I-29)', () => {
  const sequence = async (c) => {
    const out = [];
    let r = await ask(c);
    for (let i = 0; i < 3; i++) {
      out.push({ status: r.status, body: r.body });
      clock += (r.body.continue.wait + 1) * 1000;
      r = await cont(c, r.body.continue);
    }
    // Mask what is random per grant: token values and handles.
    return JSON.parse(JSON.stringify(out)
      .replace(/"value":"[^"]+"/g, '"value":"*"')
      .replace(/\/gnap\/continue\/[^"]+/g, '/gnap/continue/*'));
  };

  it('a deny-silent card and an unanswered ask give the same responses', async () => {
    patient().sharingPolicies = [card('pol_deny', 'deny', { purpose: 'clinical' })];
    const silent = await sequence(newClient());
    patient().sharingPolicies = [];
    const unanswered = await sequence(newClient());
    expect(silent).toEqual(unanswered);
    expect(silent.map((s) => s.body.continue.wait)).toEqual([60, 120, 240]);
  });

  it('a deny card that responds → request_denied at once', async () => {
    patient().sharingPolicies = [card('pol_deny', 'deny', {}, { denyMode: 'respond' })];
    const r = await ask(newClient());
    expect(r.body.error.code).toBe('request_denied');
  });
});

describe('interaction: a verified email', () => {
  it('upgrades the request to verified-email and finishes back at the client', async () => {
    patient().sharingPolicies = [card('pol_allow', 'allow', { signature: 'verified-email' })];
    const c = newClient();
    const first = await ask(c, { interact: { start: ['redirect'], finish: { method: 'redirect', uri: 'https://client.example/done', nonce: 'client-nonce-123' } } });
    expect(first.body.continue).toBeTruthy(); // unverified: the card doesn't match yet
    const ix = new URL(first.body.interact.redirect).pathname;
    expect((await request(server).get(ix)).text).toContain('Verify your email');
    const sent = await request(server).post(`${ix}/code`).send({ email: 'dr@example.com' });
    const code = emails.find((e) => e.to === 'dr@example.com').text.match(/\d{6}/)[0];
    expect(sent.body.success).toBe(true);
    const verified = await request(server).post(`${ix}/verify`).send({ code });
    const redirect = new URL(verified.body.redirect);
    expect(redirect.origin).toBe('https://client.example');
    const ref = redirect.searchParams.get('interact_ref');
    expect(redirect.searchParams.get('hash')).toBeTruthy();
    const done = await cont(c, first.body.continue, { interact_ref: ref }); // at once: no too_fast after interaction
    expect(done.status).toBe(200);
    expect(done.body.access_token).toBeTruthy();
  });
});

describe('P5: the requester hears back; the patient can stop sharing', () => {
  const INTERACT = { interact: { start: ['redirect'], finish: { method: 'redirect', uri: 'https://client.example/r', nonce: 'client-nonce-123' } } };
  const verifyEmail = async (first, email = 'dr@example.com') => {
    const ix = new URL(first.body.interact.redirect).pathname;
    await request(server).post(`${ix}/code`).send({ email });
    const code = emails.find((e) => e.to === email).text.match(/\d{6}/)[0];
    const v = await request(server).post(`${ix}/verify`).send({ code });
    return new URL(v.body.redirect).searchParams.get('interact_ref');
  };

  it('a verified requester is emailed once that there is an answer — a link, no record data', async () => {
    const c = newClient();
    const first = await ask(c, INTERACT);
    await verifyEmail(first);
    expect((await decide('accept')).status).toBe(200);
    const toRequester = emails.filter((e) => e.to === 'dr@example.com' && !/code/.test(e.subject));
    expect(toRequester).toHaveLength(1);
    expect(toRequester[0].text).toContain(`/r/${AS_ID}`);
    expect(toRequester[0].text).not.toContain('Metformin');
  });

  it('a declined request is answered too; a blocked one never (I-29)', async () => {
    const c1 = newClient('k1');
    await verifyEmail(await ask(c1, INTERACT), 'one@example.com');
    await decide('decline');
    const c2 = newClient('k2');
    await verifyEmail(await ask(c2, INTERACT), 'two@example.com');
    await decide('block');
    const answers = emails.filter((e) => /has an answer/.test(e.subject)).map((e) => e.to);
    expect(answers).toEqual(['one@example.com']);
  });

  it('Stop sharing revokes the token: the next read is refused', async () => {
    const c = newClient();
    const first = await ask(c);
    await decide('accept');
    clock += 61 * 1000;
    const at = (await cont(c, first.body.continue)).body.access_token;
    expect((await read(c, at)).status).toBe(200);
    const reqs = await request(server).get('/api/user-groups/requests?userId=pat01').set('x-test-user', 'pat01');
    const id = reqs.body.requests[0].id;
    expect(reqs.body.requests[0].route).toBe('gnap-direct');
    const stop = await request(server).post(`/api/user-groups/requests/${id}/stop-sharing`).set('x-test-user', 'pat01').send({ userId: 'pat01' });
    expect(stop.body.status).toBe('stopped');
    expect((await read(c, at)).status).toBe(401);
  });

  it('the verification code reaches the page only when delivery is switched off, never on a failed send', async () => {
    const first = await ask(newClient(), INTERACT);
    const ix = new URL(first.body.interact.redirect).pathname;
    emailMode = 'fail';
    const failed = await request(server).post(`${ix}/code`).send({ email: 'dr@example.com' });
    expect(failed.status).toBe(500);
    expect(failed.body.devCode).toBeUndefined();
    emailMode = 'off';
    const dev = await request(server).post(`${ix}/code`).send({ email: 'dr2@example.com' });
    expect(dev.body.devCode).toMatch(/^\d{6}$/);
  });
});

describe('P5b: a returning requester is recognized', () => {
  const INTERACT = { interact: { start: ['redirect'], finish: { method: 'redirect', uri: 'https://client.example/r', nonce: 'client-nonce-123' } } };
  const firstContact = async (c, email = 'dr@example.com') => {
    const first = await ask(c, INTERACT);
    const ix = new URL(first.body.interact.redirect).pathname;
    await request(server).post(`${ix}/code`).send({ email });
    const code = emails.filter((e) => e.to === email).pop().text.match(/\d{6}/)[0];
    const v = await request(server).post(`${ix}/verify`).send({ code });
    const ref = new URL(v.body.redirect).searchParams.get('interact_ref');
    const done = await cont(c, first.body.continue, { interact_ref: ref });
    return done.body.instance_id;
  };
  const again = (c, instanceId, over = {}) => call(c, 'POST', `/gnap/as/${AS_ID}`, {
    body: { access_token: grantBody(c).access_token, client: instanceId, ...over }
  });

  it('gets an instance_id, and the next request is judged verified without a code', async () => {
    const c = newClient();
    const id = await firstContact(c);
    expect(id).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    patient().sharingPolicies = [card('pol_allow', 'allow', { signature: 'verified-email' })];
    const r = await again(c, id);
    expect(r.status).toBe(200);
    expect(r.body.access_token).toBeTruthy();
    const reqs = await request(server).get('/api/user-groups/requests?userId=pat01').set('x-test-user', 'pat01');
    const latest = reqs.body.requests.find((x) => x.status === 'accepted');
    expect(latest).toMatchObject({ recognized: true, requester: { email: 'dr@example.com', emailVerified: true } });
  });

  it('only the key it was issued to can present it', async () => {
    const id = await firstContact(newClient('k1'));
    expect((await again(newClient('k2'), id)).status).toBe(401);
  });

  it('Forget, or a new request link, stops the recognition', async () => {
    const c = newClient();
    const id = await firstContact(c);
    const reqs = await request(server).get('/api/user-groups/requests?userId=pat01').set('x-test-user', 'pat01');
    const f = await request(server).post(`/api/user-groups/requests/${reqs.body.requests[0].id}/forget-requester`).set('x-test-user', 'pat01').send({ userId: 'pat01' });
    expect(f.body.forgotten).toBe(1);
    expect((await again(c, id)).body.error.code).toBe('invalid_client');

    const c2 = newClient('k3');
    const id2 = await firstContact(c2, 'two@example.com');
    const rotated = await request(server).post('/api/gnap/request-link/rotate').set('x-test-user', 'pat01').send({ userId: 'pat01' });
    const r = await call(c2, 'POST', `/gnap/as/${rotated.body.asId}`, { body: { access_token: grantBody(c2).access_token, client: id2 } });
    expect(r.status).toBe(401);
  });
});

describe('P5b: credits on a direct request', () => {
  const INTERACT = { interact: { start: ['redirect'], finish: { method: 'redirect', uri: 'https://client.example/r', nonce: 'client-nonce-123' } } };
  const EMAIL = 'payer@example.com';
  /** Ask, verify, attach `payment` on the credits step; → the first continue. */
  const payAndAsk = async (c, payment) => {
    const first = await ask(c, INTERACT);
    const ix = new URL(first.body.interact.redirect).pathname;
    await request(server).post(`${ix}/code`).send({ email: EMAIL });
    const code = emails.filter((e) => e.to === EMAIL).pop().text.match(/\d{6}/)[0];
    const v = await request(server).post(`${ix}/verify`).send({ code });
    expect(v.body.credits.balance).toBeGreaterThan(0); // the credits step is offered
    const fin = await request(server).post(`${ix}/finish`).send({ payment });
    if (!fin.body.redirect) return { first, fin };
    const ref = new URL(fin.body.redirect).searchParams.get('interact_ref');
    return { first, fin, done: await cont(c, first.body.continue, { interact_ref: ref }) };
  };
  const balance = async () => (await getAccount(cloudant, EMAIL)).balance;
  beforeEach(async () => { await grantCredits(cloudant, EMAIL, 100, 'test'); });

  it('a sharing payment a card asks for → shared, and the payment is captured', async () => {
    patient().sharingPolicies = [card('pol_pay', 'allow', { signature: 'verified-email', payment: 'sharing-payment' })];
    const { done } = await payAndAsk(newClient(), 'sharing-payment');
    expect(done.body.access_token).toBeTruthy();
    expect(await balance()).toBe(75);
    expect((await getAccount(cloudant, EMAIL)).held).toBe(0);
  });

  it('a spam deposit comes back when the patient declines', async () => {
    await payAndAsk(newClient(), 'spam-deposit');
    expect(await balance()).toBe(95);
    await decide('decline');
    expect(await balance()).toBe(100);
  });

  it('a spam deposit on an ignored request is forfeited when it expires; a withdrawal returns one', async () => {
    await payAndAsk(newClient('a'), 'spam-deposit');
    await decide('block');
    clock += 31 * 24 * 60 * 60 * 1000;
    expect(await sweepExpiredGnapPayments(cloudant, clock)).toBe(1);
    expect(await balance()).toBe(95);

    clock = Date.parse('2026-09-25T12:00:00Z');
    const c = newClient('b');
    const { done } = await payAndAsk(c, 'spam-deposit');
    expect(await balance()).toBe(90);
    clock += 10 * 1000;
    const w = await call(c, 'DELETE', done.body.continue.uri, { token: done.body.continue.access_token.value });
    expect(w.status).toBe(204);
    expect(await balance()).toBe(95);
  });

  it('more than the balance is refused', async () => {
    await grantCredits(cloudant, EMAIL, 1, 'x'); // 101
    const first = await ask(newClient(), INTERACT);
    const ix = new URL(first.body.interact.redirect).pathname;
    await request(server).post(`${ix}/code`).send({ email: 'poor@example.com' });
    await grantCredits(cloudant, 'poor@example.com', 3, 'test');
    const code = emails.filter((e) => e.to === 'poor@example.com').pop().text.match(/\d{6}/)[0];
    await request(server).post(`${ix}/verify`).send({ code });
    const fin = await request(server).post(`${ix}/finish`).send({ payment: 'spam-deposit' });
    expect(fin.status).toBe(402);
  });
});

describe('the personal request address', () => {
  it('rotation stops every direct grant and retires the old address', async () => {
    patient().sharingPolicies = [card('pol_allow', 'allow')];
    const c = newClient();
    const at = (await ask(c)).body.access_token;
    const rotated = await request(server).post('/api/gnap/request-link/rotate').set('x-test-user', 'pat01').send({ userId: 'pat01' });
    expect(rotated.body.asId).not.toBe(AS_ID);
    expect((await read(c, at)).status).toBe(401);
    expect((await ask(newClient())).status).toBe(404);
  });

  it('needs the patient signed in', async () => {
    expect((await request(server).get('/api/gnap/request-link')).status).toBe(401);
    const r = await request(server).get('/api/gnap/request-link').set('x-test-user', 'pat01');
    expect(r.body.grantEndpoint).toBe(`${baseUrl}/gnap/as/${AS_ID}`);
  });
});
