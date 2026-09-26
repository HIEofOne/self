/**
 * P11: a MAIA asking another MAIA for its user (group_requests.md §10.13,
 * I-33) — two real hosts over HTTP. Host A's user sends (their click);
 * host B's patient's cards decide at B's one door. First contact goes
 * through the email check and comes back to A; B then recognizes A's
 * client until B's patient chooses Forget. A waits, collects the answer,
 * seals it at once to its user's folder key, and keeps no readable copy.
 * Keys are pairwise; receiving never makes a MAIA send.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { generateKeyPairSync } from 'crypto';
import { serve } from '../helpers/serve.js';
import setupGnapRoutes from '../../server/routes/gnap.js';
import setupGroupRoutes from '../../server/routes/groups.js';
import setupGnapOutRoutes, { parseTarget, OUT_PER_USER_PER_DAY } from '../../server/routes/gnap-out.js';
import setupReceivedRoutes from '../../server/routes/received.js';
import { createMemoryHoldStore } from '../../server/gnap/documents.js';
import { openBytesFrom, FOLDER_DOCUMENT_INFO } from '../../server/utils/sealed-box.js';
import { buildEditionAdvisorContext } from '../../server/advisor-context.js';
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

const BO_AS = 'b'.repeat(32);
const CY_AS = 'c'.repeat(32);
const FILTERED = '**Rowan73 Vance28**, 66\n\n**Current Medications**\n- Metformin 500 mg twice daily';
const allowCard = { id: 'a1', outcome: 'allow', enabled: true, provenance: 'user', confirmedAt: '2026-09-25T00:00:00Z',
  elements: { party: { type: 'anyone' }, purpose: 'clinical', scope: 'patient-summary', filtered: true, signature: 'verified-email', payment: 'none' } };

let A, B, cA, cB, holdsA, emailsB, emailsA, clockOffset, annKey;
const nowA = () => Date.now() + clockOffset;
const patientB = (id) => cB.db('maia_users').get(id);

const makeHost = async ({ cloudant, holds, emails, now = () => Date.now() }) => {
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use((req, _res, next) => { const u = req.get('x-test-user'); req.session = u ? { userId: u } : {}; next(); });
  const sendEmail = async (to, subject, text) => { emails.push({ to, subject, text }); return true; };
  const host = { base: '' };
  const gnapHooks = {};
  Object.assign(gnapHooks, setupGnapRoutes(app, { cloudant, sendEmail, publicBaseUrl: () => host.base, holds }));
  setupGroupRoutes(app, cloudant, { logEvent: () => {} }, { sendEmail, gnapHooks });
  host.out = setupGnapOutRoutes(app, { cloudant, sendEmail, holds, now, publicBaseUrl: () => host.base, allowLocal: true });
  setupReceivedRoutes(app, { cloudant, holds, now });
  host.server = await serve(app);
  host.base = `http://127.0.0.1:${host.server.address().port}`;
  return host;
};

beforeEach(async () => {
  setEditionForTests('personal-as');
  clockOffset = 0;
  emailsA = []; emailsB = [];
  cA = new FakeCloudant(); cB = new FakeCloudant();
  holdsA = createMemoryHoldStore();
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  annKey = { pub: publicKey.export({ format: 'jwk' }), priv: privateKey.export({ format: 'jwk' }) };
  await cA.saveDocument('maia_users', { _id: 'ann01', userId: 'ann01', email: 'ann@a.example', emailVerified: true, folderKeyJwk: annKey.pub, asState: 'active' });
  for (const [id, asId] of [['bo01', BO_AS], ['cy02', CY_AS]]) {
    await cB.saveDocument('maia_users', {
      _id: id, userId: id, email: `${id}@b.example`, emailVerified: true, asId, asState: 'active', sharingPolicies: [],
      patientSummaryVerifiedAt: '2026-09-25T00:00:00Z', privacyFilteredSummary: { text: FILTERED }, privacyFilter: { pseudonymMapping: [] }
    });
    await cB.saveDocument('maia_gnap', { _id: `as_${asId}`, type: 'gnap_as', userId: id, asId, grants: [] });
  }
  A = await makeHost({ cloudant: cA, holds: holdsA, emails: emailsA, now: nowA });
  B = await makeHost({ cloudant: cB, holds: createMemoryHoldStore(), emails: emailsB });
});

const send = (body) => request(A.server).post('/api/gnap/out').set('x-test-user', 'ann01')
  .send({ userId: 'ann01', link: `${B.base}/r/${BO_AS}`, label: 'Bo', what: 'patient-summary', why: 'clinical', message: 'Before our visit', fromName: 'Dr. Ann', ...body });
/** The user's browser at B's email check, then back to A's finish page. */
const confirmEmail = async (verifyUrl, email = 'ann@a.example') => {
  const ix = new URL(verifyUrl).pathname;
  await request(B.server).post(`${ix}/code`).send({ email });
  const code = emailsB.filter((e) => e.to === email).pop().text.match(/\d{6}/)[0];
  const v = await request(B.server).post(`${ix}/verify`).send({ code });
  const back = new URL(v.body.redirect);
  expect(back.origin).toBe(A.base);
  return request(A.server).get(back.pathname + back.search);
};
const decideOnB = async (patient, decision) => {
  const list = await request(B.server).get(`/api/user-groups/requests?userId=${patient}`).set('x-test-user', patient);
  const r = list.body.requests.find((x) => x.status === 'pending');
  await request(B.server).post(`/api/user-groups/requests/${r.id}/decision`).set('x-test-user', patient).send({ userId: patient, decision });
  return r;
};
const outDocs = (c) => [...c.db('maia_gnap').values()].filter((d) => d.type === 'gnap_out_request');

describe('first contact, then the patient decides, then the answer reaches Received/', () => {
  it('verify → waiting → accepted → collected, sealed to the user’s folder key → delivered', async () => {
    const sent = await send();
    expect(sent.status).toBe(200);
    expect(sent.body.request).toMatchObject({ state: 'verify', label: 'Bo', draftedBy: 'user' });
    expect(sent.body.request.verifyUrl.startsWith(`${B.base}/gnap/interact/`)).toBe(true);

    const finish = await confirmEmail(sent.body.request.verifyUrl);
    expect(finish.text).toContain('Email confirmed');
    const id = sent.body.request.id;
    expect(outDocs(cA)[0].state).toBe('waiting');

    // B's patient sees who asked, how sure, and that a MAIA sent it (self-reported).
    const r = await decideOnB('bo01', 'accept');
    expect(r.requester).toMatchObject({ name: 'Dr. Ann', email: 'ann@a.example', emailVerified: true });
    expect(r.origin).toMatchObject({ software: 'maia', drafted_by: 'user', sent_by: 'user' });
    expect(r.payload).toBe('Before our visit');

    const after = await request(A.server).post(`/api/gnap/out/${id}/refresh`).set('x-test-user', 'ann01').send({ userId: 'ann01' });
    expect(after.body.request).toMatchObject({ state: 'answered', saved: false });

    // Only the sealed box stays on A, and only the folder key opens it.
    const og = outDocs(cA)[0];
    expect(JSON.stringify(og)).not.toContain('Metformin');
    const [stored] = [...holdsA.objects.values()];
    expect(stored).not.toContain('Metformin');
    const opened = openBytesFrom(annKey.priv, JSON.parse(stored), FOLDER_DOCUMENT_INFO).toString('utf8');
    expect(opened).toContain('Metformin 500 mg twice daily');
    expect(opened).toContain('Requested by you from Bo');

    const received = await request(A.server).get('/api/received?userId=ann01').set('x-test-user', 'ann01');
    expect(received.body.documents).toEqual([expect.objectContaining({ id: og._id, kind: 'answer', label: 'Patient Summary (requested)', mediaType: 'text/plain', sender: expect.objectContaining({ name: 'Bo' }) })]);
    await request(A.server).post(`/api/received/${og._id}/delivered`).set('x-test-user', 'ann01').send({ userId: 'ann01', fileName: '2026-09-26 Patient Summary (requested) - Bo.txt' });
    expect(holdsA.objects.size).toBe(0);
    const list = await request(A.server).get('/api/gnap/out?userId=ann01').set('x-test-user', 'ann01');
    expect(list.body.requests[0].saved).toBe('2026-09-26 Patient Summary (requested) - Bo.txt');
  });

  it('declined → declined; the user is told by email when the hourly check finds it', async () => {
    const sent = await send();
    await confirmEmail(sent.body.request.verifyUrl);
    await decideOnB('bo01', 'decline');
    clockOffset = 121 * 1000; // past the wait B gave at the last continue
    expect(await A.out.pollOutRequests()).toBe(1);
    expect(outDocs(cA)[0].state).toBe('declined');
    expect(emailsA.map((e) => e.subject)).toEqual(['Bo declined your request']);
  });
});

describe('recognition, Forget, and pairwise keys', () => {
  it('a second request is recognized (no email check); after Forget it needs one again', async () => {
    const first = await send();
    await confirmEmail(first.body.request.verifyUrl);
    patientB('bo01').sharingPolicies = [allowCard];
    const second = await send();
    expect(second.body.request).toMatchObject({ state: 'answered', recognized: true });

    // B's patient forgets the requester.
    const list = await request(B.server).get('/api/user-groups/requests?userId=bo01').set('x-test-user', 'bo01');
    const theirs = list.body.requests.find((x) => x.recognized);
    await request(B.server).post(`/api/user-groups/requests/${theirs.id}/forget-requester`).set('x-test-user', 'bo01').send({ userId: 'bo01' });
    const third = await send();
    expect(third.body.request).toMatchObject({ state: 'verify', recognized: false });
  });

  it('two patients’ MAIAs see two different keys for one user', async () => {
    await send();
    await send({ link: `${B.base}/r/${CY_AS}`, label: 'Cy' });
    const keys = [...cA.db('maia_gnap').values()].filter((d) => d.type === 'gnap_client_key').map((k) => k.publicJwk.x);
    expect(new Set(keys).size).toBe(2);
    const thumbs = [...cB.db('maia_gnap').values()].filter((d) => d.type === 'gnap_grant').map((g) => g.keyThumbprint);
    expect(new Set(thumbs).size).toBe(2);
  });
});

describe('what a MAIA sends, and when', () => {
  it('only a request link on an allowed address; not the user’s own; not without a folder key; not too many', async () => {
    expect(parseTarget('https://maia.example/r/' + 'a'.repeat(32))).toMatchObject({ grantEndpoint: `https://maia.example/gnap/as/${'a'.repeat(32)}` });
    for (const bad of ['http://maia.example/r/' + 'a'.repeat(32), 'https://10.0.0.5/r/' + 'a'.repeat(32), 'https://169.254.169.254/r/' + 'a'.repeat(32),
      'https://maia.example/admin', 'https://maia.example/r/' + 'a'.repeat(32) + '?x=1', 'https://user:pw@maia.example/r/' + 'a'.repeat(32), 'http://127.0.0.1/r/' + 'a'.repeat(32)]) {
      expect(parseTarget(bad), bad).toBeNull();
    }
    expect((await send({ link: 'https://10.0.0.5/r/' + 'a'.repeat(32) })).body.error).toBe('BAD_LINK');
    await cA.saveDocument('maia_gnap', { _id: `as_${'e'.repeat(32)}`, type: 'gnap_as', userId: 'ann01', asId: 'e'.repeat(32) });
    expect((await send({ link: `${A.base}/r/${'e'.repeat(32)}` })).body.error).toBe('OWN_LINK');
    expect((await send({ link: `${B.base}/r/${'f'.repeat(32)}` })).body.error).toBe('LINK_GONE');
    delete cA.db('maia_users').get('ann01').folderKeyJwk;
    expect((await send()).body.error).toBe('NO_FOLDER_KEY');
  });

  it(`at most ${OUT_PER_USER_PER_DAY} a day; only the user’s own session sends`, async () => {
    for (let i = 0; i < OUT_PER_USER_PER_DAY; i++) {
      await cA.saveDocument('maia_gnap', { _id: `og_x${i}`, type: 'gnap_out_request', userId: 'ann01', createdAt: new Date().toISOString(), access: { datatypes: ['patient-summary'] }, grantEndpoint: B.base });
    }
    expect((await send()).status).toBe(429);
    expect((await request(A.server).post('/api/gnap/out').send({ userId: 'ann01' })).status).toBe(401);
  });

  it('no reflexes: receiving and answering a request never makes a MAIA send one (I-33)', async () => {
    const sent = await send();
    await confirmEmail(sent.body.request.verifyUrl);
    await decideOnB('bo01', 'accept');
    await B.out.pollOutRequests();
    expect(outDocs(cB)).toHaveLength(0);
    expect(outDocs(cA)).toHaveLength(1);
  });

  it('the private AI sees the user’s requests to other MAIAs and how to draft one', async () => {
    await send({ draftedBy: 'private-ai' });
    const t = await buildEditionAdvisorContext(cA, cA.db('maia_users').get('ann01'));
    expect(t).toContain('language tag `maia-request`');
    expect(t).toMatch(/to "Bo" \(127\.0\.0\.1:\d+\) for patient-summary \(clinical use\) → waiting for the patient to confirm their email/);
    expect(outDocs(cA)[0].draftedBy).toBe('private-ai');
  });
});
