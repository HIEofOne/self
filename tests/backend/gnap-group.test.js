/**
 * GNAP group routing (group_requests.md §10.9, P6): one signed request to a
 * group reaches every member's AS through the relay; each member's cards
 * decide; answers come back sealed to the requester, and the group sees only
 * boxes and counts. Real handlers (groups.js, gnap.js, gnap-group.js) on one
 * test server, two members on the same host, an in-memory database.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { generateKeyPairSync } from 'crypto';
import { serve } from '../helpers/serve.js';
import setupGroupRoutes from '../../server/routes/groups.js';
import setupGnapRoutes from '../../server/routes/gnap.js';
import setupGnapGroupRoutes from '../../server/routes/gnap-group.js';
import setupGnapMemberRoutes from '../../server/routes/gnap-member.js';
import { signRequest } from '../../server/gnap/httpsig.js';
import { ACCESS_TYPE } from '../../server/gnap/grants.js';
import { openFrom } from '../../server/utils/sealed-box.js';
import { grantCredits, getAccount } from '../../server/credits.js';
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
  async findDocuments(n, q) {
    const m = q?.selector?.groupMemberships?.$elemMatch;
    const docs = [...this.db(n).values()].filter((d) => !m || (d.groupMemberships || []).some(
      (x) => x.groupId === m.groupId.$eq && x.pairwiseId === m.pairwiseId.$eq));
    return { docs: docs.slice(0, q?.limit || docs.length).map(clone) };
  }
}

const jwkPair = (type) => {
  const { publicKey, privateKey } = generateKeyPairSync(type);
  return { publicKeyJwk: publicKey.export({ format: 'jwk' }), privateKeyJwk: privateKey.export({ format: 'jwk' }) };
};
const summary = (name) => [`**${name}**, 60, F`, '', '**Current Medications**', '- Metformin 500 mg', '', '**Allergies**', '- None'].join('\n');
const card = (id, outcome, elements = {}, extra = {}) => ({
  id, outcome, enabled: true, provenance: 'user', confirmedAt: '2026-09-25T00:00:00Z',
  elements: { party: { type: 'anyone' }, purpose: 'clinical', scope: 'patient-summary', filtered: true, signature: 'verified-email', payment: 'none', ...elements },
  ...extra
});

const GROUP = 'trustee-test';
let server, cloudant, emails, baseUrl, hooks, pullSameHostMembers, pollSentRequests;
const user = (id) => cloudant.db('maia_users').get(id);

beforeEach(async () => {
  setEditionForTests('personal-as');
  emails = [];
  cloudant = new FakeCloudant();
  const groupKey = jwkPair('ed25519');
  const members = [];
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use((req, _res, next) => { const u = req.get('x-test-user'); req.session = u ? { userId: u } : {}; next(); });
  server = await serve(app);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const [userId, name] of [['pat01', 'Rowan73 Vance28'], ['pat02', 'Ash11 Moor42']]) {
    const sign = jwkPair('ed25519');
    const enc = jwkPair('x25519');
    const pairwiseId = `pw_${userId}`;
    members.push({ pairwiseId, status: 'active', alias: userId, signingPublicKeyJwk: sign.publicKeyJwk, encryptionPublicKeyJwk: enc.publicKeyJwk, joinedAt: '2026-09-01T00:00:00Z' });
    await cloudant.saveDocument('maia_users', {
      _id: userId, userId, email: `${userId}@example.com`, emailVerified: true, asState: 'active', sharingPolicies: [],
      patientSummaryVerifiedAt: '2026-09-25T00:00:00Z', privacyFilteredSummary: { text: summary(name) }, privacyFilter: { pseudonymMapping: [] },
      groupMemberships: [{
        groupId: GROUP, groupName: 'Trustee Test', registryUrl: baseUrl, pairwiseId, alias: userId,
        signingKeyPair: sign, encryptionKeyPair: enc, groupPublicKeyJwk: groupKey.publicKeyJwk, credential: null
      }]
    });
  }
  await cloudant.saveDocument('maia_groups', {
    _id: GROUP, type: 'group', name: 'Trustee Test', signingKey: groupKey, members, createdAt: '2026-08-01T00:00:00Z'
  });
  const sendEmail = async (to, subject, text) => { emails.push({ to, subject, text }); return true; };
  const gnapHooks = {};
  ({ pullSameHostMembers } = setupGroupRoutes(app, cloudant, { logEvent: () => {} }, { sendEmail, gnapHooks }));
  setupGnapGroupRoutes(app, { cloudant, sendEmail, pullNow: async () => {}, publicBaseUrl: () => baseUrl });
  hooks = Object.assign(gnapHooks, setupGnapRoutes(app, { cloudant, sendEmail, publicBaseUrl: () => baseUrl }));
  ({ pollSentRequests } = setupGnapMemberRoutes(app, { cloudant, sendEmail, publicBaseUrl: () => baseUrl }));
});

// The requester: a signing key and a sealing key.
const newRequester = () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const priv = { ...privateKey.export({ format: 'jwk' }), kid: 'requester-1' };
  const seal = jwkPair('x25519');
  return { priv, pub: { kty: priv.kty, crv: priv.crv, x: priv.x, kid: priv.kid }, seal };
};
const call = (c, method, url, { body = null, token = null } = {}) => {
  const u = new URL(url, baseUrl);
  const text = body ? JSON.stringify(body) : null;
  const headers = { ...(text ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `GNAP ${token}` } : {}) };
  const sig = signRequest({ method, targetUri: u.href, headers, body: text, privateJwk: c.priv });
  let r = request(server)[method.toLowerCase()](u.pathname + u.search).set(headers).set(sig);
  if (text) r = r.send(text);
  return r;
};
const groupRequest = (c, over = {}) => call(c, 'POST', `/gnap/group/${GROUP}`, {
  body: {
    access_token: { access: [{ type: ACCESS_TYPE, actions: ['read'], datatypes: ['patient-summary'], purpose: 'clinical' }] },
    client: { key: { proof: 'httpsig', jwk: c.pub }, display: { name: 'Dr. Group Test' } },
    interact: { start: ['redirect'], finish: { method: 'redirect', uri: 'https://client.example/g', nonce: 'client-nonce-123' } },
    maia_seal_jwk: c.seal.publicKeyJwk,
    ...over
  }
});
/** Ask the group and verify an email; → the continuation after interaction. */
const askGroup = async (c, { email = 'dr@example.com', payment = null } = {}) => {
  const first = await groupRequest(c);
  expect(first.status).toBe(200);
  const ix = new URL(first.body.interact.redirect).pathname;
  await request(server).post(`${ix}/code`).send({ email });
  const code = emails.filter((e) => e.to === email).pop().text.match(/\d{6}/)[0];
  let done = await request(server).post(`${ix}/verify`).send({ code });
  if (done.body.credits) done = await request(server).post(`${ix}/finish`).send({ payment });
  const ref = new URL(done.body.redirect).searchParams.get('interact_ref');
  // The same-host members pull (in the app this runs right after fan-out).
  await pullSameHostMembers(GROUP, ['pw_pat01', 'pw_pat02']);
  const polled = await call(c, 'POST', first.body.continue.uri, { token: first.body.continue.access_token.value, body: { interact_ref: ref } });
  return polled;
};
const openAnswers = (c, polled) => polled.body.maia_group.answers.map((a) => JSON.parse(openFrom(c.seal.privateKeyJwk, a.box)));
const collect = async (c, answer) => {
  const t = await call(c, 'POST', answer.continue.uri, { token: answer.continue.access_token.value });
  expect(t.status).toBe(200);
  const at = t.body.access_token;
  return (await call(c, 'GET', at.access[0].locations[0], { token: at.value })).body.text;
};

describe('a request to a whole group', () => {
  it('reaches every member; one shares by rule, one when asked; the requester reads both', async () => {
    user('pat01').sharingPolicies = [card('pol_allow', 'allow')];
    const c = newRequester();
    const polled = await askGroup(c);
    expect(polled.body.maia_group.counts).toEqual({ delivered: 2, shared: 1, declined: 0 });
    const [first] = openAnswers(c, polled);
    expect(first.kind).toBe('ready');
    expect(await collect(c, first)).toContain('Rowan73 Vance28');

    // pat02 was asked, and shares by hand.
    const reqs = await request(server).get('/api/user-groups/requests?userId=pat02').set('x-test-user', 'pat02');
    const pending = reqs.body.requests.find((r) => r.status === 'pending');
    expect(pending).toMatchObject({ route: 'gnap-group', groupName: 'Trustee Test', requester: { email: 'dr@example.com', emailVerified: true } });
    await request(server).post(`/api/user-groups/requests/${pending.id}/decision`).set('x-test-user', 'pat02').send({ userId: 'pat02', decision: 'accept' });

    const gb = [...cloudant.db('maia_gnap').values()].find((d) => d.type === 'gnap_group_request');
    expect(gb.counts.shared).toBe(2);
    // The group holds boxes and counts, never who answered.
    expect(JSON.stringify(gb)).not.toMatch(/pat0|pw_pat/);
    // A new answer can be collected at once, whatever wait was given.
    const again = await call(c, 'POST', polled.body.continue.uri, { token: polled.body.continue.access_token.value });
    expect(again.status).toBe(200);
    const both = openAnswers(c, again);
    expect(both).toHaveLength(2);
    expect(await collect(c, both[1])).toContain('Ash11 Moor42');
    // The requester is told answers are waiting (counts only, debounced).
    const told = emails.filter((e) => e.to === 'dr@example.com' && /answered your request/.test(e.subject));
    expect(told).toHaveLength(1);
    expect(told[0].text).not.toMatch(/Metformin|Rowan|Ash11/);
  });

  it('a deny-respond card counts as declined; a silent one is never counted (I-29)', async () => {
    user('pat01').sharingPolicies = [card('pol_deny', 'deny', {}, { denyMode: 'respond' })];
    user('pat02').sharingPolicies = [card('pol_silent', 'deny')];
    const polled = await askGroup(newRequester());
    expect(polled.body.maia_group.counts).toEqual({ delivered: 2, shared: 0, declined: 1 });
    expect(polled.body.maia_group.answers).toEqual([]);
  });

  it('nothing goes out before the email check; unsigned or keyless requests are refused', async () => {
    const c = newRequester();
    const first = await groupRequest(c);
    expect([...cloudant.db('maia_relay').values()]).toHaveLength(0);
    expect((await groupRequest(c, { maia_seal_jwk: { kty: 'OKP', crv: 'X25519' } })).status).toBe(400);
    expect((await groupRequest(c, { interact: undefined })).status).toBe(400);
    const unsigned = await request(server).post(`/gnap/group/${GROUP}`).send({ access_token: {} });
    expect(unsigned.status).toBe(400);
    expect(first.body.continue).toBeTruthy();
  });

  it("a member's AS refuses a copy whose request was altered", async () => {
    user('pat01').sharingPolicies = [card('pol_allow', 'allow')];
    const c = newRequester();
    const first = await groupRequest(c);
    const ix = new URL(first.body.interact.redirect).pathname;
    await request(server).post(`${ix}/code`).send({ email: 'dr@example.com' });
    const code = emails.filter((e) => e.to === 'dr@example.com').pop().text.match(/\d{6}/)[0];
    await request(server).post(`${ix}/verify`).send({ code });
    // Take pat01's sealed copy from the relay and alter the request inside.
    const msg = [...cloudant.db('maia_relay').values()].find((m) => m.toPairwiseId === 'pw_pat01');
    const membership = user('pat01').groupMemberships[0];
    const copy = JSON.parse(openFrom(membership.encryptionKeyPair.privateKeyJwk, msg.box));
    copy.request.body = copy.request.body.replace('clinical', 'research');
    const out = await hooks.receiveGroupCopy(user('pat01'), membership, copy, { fromPairwiseId: msg.fromPairwiseId });
    expect(out).toMatchObject({ ok: false });
    // …and one that didn't come from the group.
    const out2 = await hooks.receiveGroupCopy(user('pat01'), membership, JSON.parse(openFrom(membership.encryptionKeyPair.privateKeyJwk, msg.box)), { fromPairwiseId: 'pw_pat02' });
    expect(out2).toMatchObject({ ok: false });
  });

  it('answers never outnumber the members reached', async () => {
    const c = newRequester();
    await askGroup(c);
    const gb = [...cloudant.db('maia_gnap').values()].find((d) => d.type === 'gnap_group_request');
    const post = () => request(server).post(`/gnap/group/${GROUP}/answer/${gb._id.slice(3)}`).send({ outcome: 'declined' });
    expect((await post()).status).toBe(204);
    expect((await post()).status).toBe(204);
    expect((await post()).status).toBe(410);
  });

  it('one spam deposit covers the whole group, returned on the first real answer', async () => {
    await grantCredits(cloudant, 'payer@example.com', 20, 'test');
    user('pat01').sharingPolicies = [card('pol_allow', 'allow', { payment: 'spam-deposit' })];
    const polled = await askGroup(newRequester(), { email: 'payer@example.com', payment: 'spam-deposit' });
    expect(polled.body.maia_group.counts.shared).toBe(1); // pat01's card wanted the deposit
    expect((await getAccount(cloudant, 'payer@example.com')).balance).toBe(20);
  });
});

describe('member to member (P6b)', () => {
  const GROUP_CARD = (outcome = 'allow') => card('pol_group', outcome, {
    party: { type: 'group', groupId: GROUP, groupName: 'Trustee Test' }, purpose: 'peer-support', signature: 'group-member'
  });
  const send = (userId, body) => request(server).post('/api/gnap/member-requests').set('x-test-user', userId)
    .send({ userId, groupId: GROUP, datatype: 'patient-summary', purpose: 'peer-support', ...body });

  it("a member asks the group; another member's group card shares; the asker reads it", async () => {
    user('pat02').sharingPolicies = [GROUP_CARD()];
    const sent = await send('pat01', { message: 'Anyone else on metformin?' });
    expect(sent.status).toBe(200);
    expect(sent.body.request.counts.delivered).toBe(1); // everyone but the asker
    await pullSameHostMembers(GROUP, ['pw_pat02']);

    // pat02's record of it: from a member, by alias, decided by the group card.
    const got = await request(server).get('/api/user-groups/requests?userId=pat02').set('x-test-user', 'pat02');
    expect(got.body.requests[0]).toMatchObject({ status: 'accepted', fromOutsider: false, fromAlias: 'pat01', route: 'gnap-group' });

    const id = sent.body.request.id;
    const refreshed = await request(server).post(`/api/gnap/member-requests/${id}/refresh`).set('x-test-user', 'pat01').send({ userId: 'pat01' });
    expect(refreshed.body.request.counts).toMatchObject({ delivered: 1, shared: 1 });
    const aid = refreshed.body.request.answers[0].id;
    const read = await request(server).post(`/api/gnap/member-requests/${id}/answers/${aid}/read`).set('x-test-user', 'pat01').send({ userId: 'pat01' });
    expect(read.body.answer.text).toContain('Ash11 Moor42');
    // The asker's host keeps no copy of the answer.
    expect(JSON.stringify([...cloudant.db('maia_gnap').values()])).not.toContain('Ash11 Moor42');
  });

  it('asks without a group card: the other member is asked, and the asker is told when they share', async () => {
    const sent = await send('pat01', {});
    await pullSameHostMembers(GROUP, ['pw_pat02']);
    const got = await request(server).get('/api/user-groups/requests?userId=pat02').set('x-test-user', 'pat02');
    const pending = got.body.requests.find((r) => r.status === 'pending');
    await request(server).post(`/api/user-groups/requests/${pending.id}/decision`).set('x-test-user', 'pat02').send({ userId: 'pat02', decision: 'accept' });
    // The hourly check finds the answer and emails the asker (no content).
    const sr = cloudant.db('maia_gnap').get(`sr_${sent.body.request.id}`);
    sr.nextPollAt = 0;
    expect(await pollSentRequests()).toBe(1);
    const told = emails.filter((e) => e.to === 'pat01@example.com' && /answered your request/.test(e.subject));
    expect(told).toHaveLength(1);
    expect(told[0].text).not.toMatch(/Metformin|Ash11/);
  });

  it('maia_to must name another active member; a key the group does not know is an outsider', async () => {
    expect((await send('pat01', { to: 'pw_pat01' })).status).toBe(400);
    expect((await send('pat01', { to: 'pw_nobody' })).status).toBe(400);
    const one = await send('pat01', { to: 'pw_pat02', toAlias: 'pat02' });
    expect(one.body.request).toMatchObject({ counts: { delivered: 1 }, toAlias: 'pat02' });
    // An outsider's key, without the email check, is refused.
    const c = newRequester();
    expect((await groupRequest(c, { interact: undefined })).status).toBe(400);
  });

  it('a sender the member blocked is dropped', async () => {
    user('pat02').groupMemberships[0].blockedSenders = ['pw_pat01'];
    await send('pat01', {});
    await pullSameHostMembers(GROUP, ['pw_pat02']);
    const got = await request(server).get('/api/user-groups/requests?userId=pat02').set('x-test-user', 'pat02');
    expect(got.body.requests).toHaveLength(0);
  });
});
