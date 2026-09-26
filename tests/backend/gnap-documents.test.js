/**
 * P9: adding a document (group_requests.md §10.12, D15, I-32) — the real
 * handlers with an in-memory database and hold store, a signing client and
 * a controllable clock. No existing card accepts an add; an add card →
 * `add` token → upload → accepted; no card → `offer` token → held for the
 * patient, who previews (browser side), accepts or declines; a deny card →
 * nothing stored. The upload must be exactly the document described, once.
 * What the server keeps is sealed to the folder key and opens only with it.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { generateKeyPairSync, createHash } from 'crypto';
import { serve } from '../helpers/serve.js';
import setupGnapRoutes from '../../server/routes/gnap.js';
import setupGnapGroupRoutes from '../../server/routes/gnap-group.js';
import setupGroupRoutes from '../../server/routes/groups.js';
import setupReceivedRoutes from '../../server/routes/received.js';
import setupRequestLogRoutes from '../../server/routes/requests-log.js';
import { signRequest } from '../../server/gnap/httpsig.js';
import { ACCESS_TYPE } from '../../server/gnap/grants.js';
import { createMemoryHoldStore, sweepExpiredHolds, matchesDeclaredType, HOLD_TTL_MS, MAX_HOLDS } from '../../server/gnap/documents.js';
import { openBytesFrom, FOLDER_DOCUMENT_INFO } from '../../server/utils/sealed-box.js';
import { normalizeCard, evaluatePolicies, policySentence } from '../../server/routes/policies.js';
import { evaluate, sentenceFor } from '../../src/utils/policyCards';
import { renderShared, renderAsks } from '../../server/gnap/notices.js';
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

const AS_ID = 'd'.repeat(32);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('MRI brain without contrast. Impression: no acute findings.\n%%EOF\n')]);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const DOC = { kind: 'radiology-report', title: 'MRI brain, 2026-09-24', mediaType: 'application/pdf', size: PDF.length, sha256: sha(PDF) };
const card = (id, outcome, elements = {}, extra = {}) => ({
  id, outcome, enabled: true, provenance: 'user', confirmedAt: '2026-09-25T00:00:00Z',
  elements: { party: { type: 'anyone' }, action: 'add', purpose: 'clinical', scope: 'document', filtered: true, signature: 'verified-email', payment: 'none', ...elements },
  ...extra
});

let server, cloudant, clock, emails, baseUrl, holds, audits, folderKey;
const patient = () => cloudant.db('maia_users').get('pat01');
const requests = () => [...cloudant.db('maia_as_requests').values()];

beforeEach(async () => {
  setEditionForTests('personal-as');
  clock = Date.parse('2026-09-26T12:00:00Z');
  emails = [];
  audits = [];
  holds = createMemoryHoldStore();
  cloudant = new FakeCloudant();
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  folderKey = { pub: publicKey.export({ format: 'jwk' }), priv: privateKey.export({ format: 'jwk' }) };
  await cloudant.saveDocument('maia_users', {
    _id: 'pat01', userId: 'pat01', email: 'pat@example.com', emailVerified: true, asId: AS_ID, asState: 'active',
    sharingPolicies: [], folderKeyJwk: folderKey.pub
  });
  await cloudant.saveDocument('maia_gnap', { _id: `as_${AS_ID}`, type: 'gnap_as', userId: 'pat01', asId: AS_ID, grants: [] });
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use((req, _res, next) => { const u = req.get('x-test-user'); req.session = u ? { userId: u } : {}; next(); });
  const sendEmail = async (to, subject, text) => { emails.push({ to, subject, text }); return true; };
  const auditLog = { logEvent: (e) => audits.push(e) };
  const gnapHooks = {};
  setupGnapGroupRoutes(app, { cloudant, auditLog, sendEmail, now: () => clock, publicBaseUrl: () => baseUrl });
  Object.assign(gnapHooks, setupGnapRoutes(app, { cloudant, auditLog, sendEmail, now: () => clock, publicBaseUrl: () => baseUrl, holds }));
  setupGroupRoutes(app, cloudant, auditLog, { sendEmail, gnapHooks });
  setupReceivedRoutes(app, { cloudant, holds, auditLog, now: () => clock });
  setupRequestLogRoutes(app, { cloudant, notices: gnapHooks.notices });
  server = await serve(app);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

const newClient = (kid = 'sender-1') => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const priv = { ...privateKey.export({ format: 'jwk' }), kid };
  return { priv, pub: { kty: priv.kty, crv: priv.crv, x: priv.x, kid } };
};

/** A signed GNAP call; `bytes` sends a document instead of JSON. */
const call = (client, method, url, { body = null, token = null, bytes = null, type = null } = {}) => {
  const u = new URL(url, baseUrl);
  const payload = bytes || (body ? JSON.stringify(body) : null);
  const headers = {
    ...(bytes ? { 'content-type': type } : body ? { 'content-type': 'application/json' } : {}),
    ...(token ? { authorization: `GNAP ${token}` } : {})
  };
  const sig = signRequest({ method, targetUri: u.href, headers, body: payload, privateJwk: client.priv, created: Math.floor(clock / 1000) });
  let r = request(server)[method.toLowerCase()](u.pathname + u.search).set(headers).set(sig);
  if (payload) r = r.send(payload);
  return r;
};

const INTERACT = { interact: { start: ['redirect'], finish: { method: 'redirect', uri: 'https://client.example/r', nonce: 'client-nonce-123' } } };
const addBody = (client, over = {}, doc = DOC) => ({
  access_token: { access: [{ type: ACCESS_TYPE, actions: ['add'], datatypes: ['document'], purpose: 'clinical', document: doc }] },
  client: { key: { proof: 'httpsig', jwk: client.pub }, display: { name: 'Dr. Ray, Imaging Center' } },
  ...INTERACT,
  ...over
});
const offer = (client, over, doc) => call(client, 'POST', `/gnap/as/${AS_ID}`, { body: addBody(client, over, doc) });
const cont = (client, c, body = null) => call(client, 'POST', c.uri, { token: c.access_token.value, body });

/** A new sender verifies their email, then continues: the patient's cards decide. */
const verified = async (client, email = 'ray@imaging.example', doc = DOC) => {
  const first = await offer(client, {}, doc);
  expect(first.status).toBe(200);
  expect(first.body.access_token).toBeUndefined(); // unverified: nothing is decided yet
  const ix = new URL(first.body.interact.redirect).pathname;
  await request(server).post(`${ix}/code`).send({ email });
  const code = emails.filter((e) => e.to === email).pop().text.match(/\d{6}/)[0];
  const v = await request(server).post(`${ix}/verify`).send({ code });
  const ref = new URL(v.body.redirect).searchParams.get('interact_ref');
  return cont(client, first.body.continue, { interact_ref: ref });
};
const upload = (client, at, bytes = PDF, type = 'application/pdf') =>
  call(client, 'PUT', at.access[0].locations[0], { token: at.value, bytes, type });
const asPatient = (method, url) => request(server)[method](url).set('x-test-user', 'pat01');
const decide = async (decision) => {
  const id = requests().find((r) => r.status === 'pending').id || requests().find((r) => r.status === 'pending')._id;
  return asPatient('post', `/api/user-groups/requests/${id}/decision`).send({ userId: 'pat01', decision });
};

describe('vocabulary v3: adding is separate from reading (I-32)', () => {
  const ADD = { party: { type: 'anyone' }, action: 'add', purpose: 'clinical', scope: 'document', signature: 'verified-email', payment: 'none' };
  const readCard = (scope) => ({ id: `r_${scope}`, outcome: 'allow', enabled: true, provenance: 'user', elements: { party: { type: 'anyone' }, purpose: 'any', scope, filtered: true, signature: 'unverified', payment: 'none' } });

  it('no card without an action accepts an add, however broad — in both twins', () => {
    const cards = ['everything', 'patient-summary', 'meds-allergies', 'not-sensitive'].map(readCard);
    expect(evaluatePolicies(cards, ADD).outcome).toBe('ask');
    expect(evaluate(cards, ADD).outcome).toBe('ask');
  });

  it('an add card decides adds, never reads — in both twins', () => {
    const add = card('a1', 'allow');
    const read = { party: { type: 'anyone' }, purpose: 'clinical', scope: 'patient-summary', signature: 'verified-email', payment: 'none' };
    for (const ev of [evaluatePolicies, evaluate]) {
      expect(ev([add], ADD).outcome).toBe('allow');
      expect(ev([add], read).outcome).toBe('ask');
      expect(ev([add], { ...ADD, signature: 'unverified' }).outcome).toBe('ask');
    }
  });

  it('normalizeCard: add pairs only with document, needs a verified email, and is stamped edition 3', () => {
    const raw = (el) => ({ outcome: 'allow', elements: { party: { type: 'anyone' }, purpose: 'clinical', filtered: true, payment: 'none', ...el } });
    const ok = normalizeCard(raw({ action: 'add', scope: 'document', signature: 'verified-email' }));
    expect(ok.elements.action).toBe('add');
    expect(ok.vocabVersion).toBe(3);
    expect(normalizeCard(raw({ action: 'add', scope: 'patient-summary', signature: 'verified-email' }))).toBeNull();
    expect(normalizeCard(raw({ scope: 'document', signature: 'verified-email' }))).toBeNull();
    expect(normalizeCard(raw({ action: 'add', scope: 'document', signature: 'unverified' }))).toBeNull();
    expect(normalizeCard(raw({ action: 'delete', scope: 'document', signature: 'verified-email' }))).toBeNull();
    // A read card keeps exactly its shape: no action element appears.
    expect(normalizeCard(raw({ scope: 'patient-summary', signature: 'verified-email' })).elements).not.toHaveProperty('action');
  });

  it('the sentence says add, in both twins', () => {
    const c = normalizeCard({ outcome: 'allow', elements: { party: { type: 'anyone' }, action: 'add', purpose: 'clinical', scope: 'document', filtered: true, signature: 'verified-email', payment: 'none' } });
    expect(policySentence(c)).toBe('Anyone with verified-email identity or stronger may add documents to my MAIA for clinical use.');
    expect(sentenceFor({ ...c, id: 'x' })).toBe('Anyone with verified-email identity or stronger may add documents to my MAIA for Clinical use.');
  });
});

describe('the add request', () => {
  it('a new sender must include interact (the email check), and nothing is decided before it', async () => {
    const c = newClient();
    const noInteract = await call(c, 'POST', `/gnap/as/${AS_ID}`, { body: { ...addBody(c), interact: undefined } });
    expect(noInteract.body.error.code).toBe('invalid_request');
    patient().sharingPolicies = [card('a1', 'allow')];
    const first = await offer(c);
    expect(first.body.continue).toBeTruthy();
    expect(first.body.access_token).toBeUndefined();
    expect(requests()).toHaveLength(0);
  });

  it('refuses a bad descriptor and add mixed with a read datatype', async () => {
    const c = newClient();
    expect((await offer(c, {}, { ...DOC, mediaType: 'application/zip' })).body.error.code).toBe('invalid_request');
    expect((await offer(c, {}, { ...DOC, size: 21 * 1024 * 1024 })).body.error.code).toBe('invalid_request');
    expect((await offer(c, {}, { ...DOC, sha256: 'nope' })).body.error.code).toBe('invalid_request');
    const mixed = addBody(c);
    mixed.access_token.access[0].datatypes = ['patient-summary'];
    expect((await call(c, 'POST', `/gnap/as/${AS_ID}`, { body: mixed })).body.error.code).toBe('invalid_request');
  });

  it('a group broadcast can’t add: a document is about one person', async () => {
    const c = newClient();
    const r = await call(c, 'POST', '/gnap/group/g1', { body: { ...addBody(c), maia_seal_jwk: folderKey.pub } });
    expect([400, 404]).toContain(r.status); // no such group here, or refused — never accepted
    expect(requests()).toHaveLength(0);
  });
});

describe('an add card: accepted, sealed, delivered', () => {
  it('→ an add token → upload → a sealed hold only the folder key opens → Received → deleted', async () => {
    patient().sharingPolicies = [card('a1', 'allow')];
    const c = newClient();
    const done = await verified(c);
    expect(done.status).toBe(200);
    const at = done.body.access_token;
    expect(at.access[0].actions).toEqual(['add']);
    clock += 60 * 1000;
    const up = await upload(c, at);
    expect(up.status).toBe(201);
    expect(up.body.status).toBe('accepted');

    // The hold: ciphertext only — no title, no text, and the server can't open it.
    const [key] = [...holds.objects.keys()];
    expect(key).toMatch(/^pat01\/received\/.+\.sealed\.json$/);
    const stored = holds.objects.get(key);
    expect(stored).not.toContain('MRI');
    expect(stored).not.toContain('%PDF');
    expect(JSON.stringify(audits)).not.toContain('MRI brain');
    expect(openBytesFrom(folderKey.priv, JSON.parse(stored), FOLDER_DOCUMENT_INFO).equals(PDF)).toBe(true);

    // The patient heard, with no title and no content (I-31).
    const note = emails.find((e) => e.to === 'pat@example.com');
    expect(note.subject).toBe('A document was added to your MAIA');
    expect(note.text).toContain('a radiology report');
    expect(note.text).not.toContain('MRI');

    // The browser lists it, opens it, writes it, and says so; the hold goes.
    const list = await asPatient('get', '/api/received?userId=pat01');
    expect(list.body.documents).toHaveLength(1);
    const d = list.body.documents[0];
    expect(d).toMatchObject({ kind: 'radiology-report', title: DOC.title, sha256: DOC.sha256, sender: { email: 'ray@imaging.example', emailVerified: true } });
    const box = await asPatient('get', `/api/received/${d.id}/box?userId=pat01`);
    expect(openBytesFrom(folderKey.priv, box.body, FOLDER_DOCUMENT_INFO).equals(PDF)).toBe(true);
    clock += 60 * 60 * 1000;
    await asPatient('post', `/api/received/${d.id}/delivered`).send({ userId: 'pat01', fileName: '2026-09-26 Radiology report - Dr. Ray, Imaging Center.pdf' });
    expect(holds.objects.size).toBe(0);
    expect((await asPatient('get', '/api/received?userId=pat01')).body.documents).toHaveLength(0);

    // The folder's log: received, accepted by the rule, saved as that file.
    const log = await asPatient('get', '/api/requests/log?userId=pat01');
    expect(log.body.events.map((e) => e.type)).toEqual(['received', 'accepted', 'document_received']);
    expect(log.body.events[1].by).toBe('rule');
    expect(log.body.events[2]).toMatchObject({ fileName: '2026-09-26 Radiology report - Dr. Ray, Imaging Center.pdf', document: { sha256: DOC.sha256 } });
  });

  it('the upload must be the document described: size, hash, declared type, real type', async () => {
    patient().sharingPolicies = [card('a1', 'allow')];
    const c = newClient();
    const at = (await verified(c)).body.access_token;
    const other = Buffer.from(PDF); other[20] ^= 1;
    expect((await upload(c, at, other)).body.error.code).toBe('invalid_request'); // hash
    expect((await upload(c, at, PDF, 'image/png')).body.error.code).toBe('invalid_request'); // header
    expect(holds.objects.size).toBe(0);
    expect(matchesDeclaredType(Buffer.from('not a pdf at all'), 'application/pdf')).toBe(false);
    expect(matchesDeclaredType(Buffer.from([0x68, 0x00, 0x69]), 'text/plain')).toBe(false);
    expect(matchesDeclaredType(Buffer.from([0xc3, 0x28]), 'text/plain')).toBe(false); // not UTF-8
    // A PDF-looking name on text isn't enough: the bytes are checked.
    const fake = Buffer.from('hello, this is text');
    const c2 = newClient('sender-2');
    const at2 = (await verified(c2, 'two@imaging.example', { ...DOC, size: fake.length, sha256: sha(fake) })).body.access_token;
    expect((await upload(c2, at2, fake)).body.error.code).toBe('invalid_request');
  });

  it('a token uploads once; another key can’t use it', async () => {
    patient().sharingPolicies = [card('a1', 'allow')];
    const c = newClient();
    const at = (await verified(c)).body.access_token;
    expect((await upload(newClient('thief'), at)).status).toBe(401);
    expect((await upload(c, at)).status).toBe(201);
    clock += 1000;
    expect((await upload(c, at)).status).toBe(401);
    expect(holds.objects.size).toBe(1);
  });
});

describe('no card: offered, held for the patient', () => {
  it('→ an offer token → held → the patient accepts → ready for the folder; the sender hears (no title)', async () => {
    const c = newClient();
    const at = (await verified(c)).body.access_token;
    expect(at.access[0].actions).toEqual(['offer']);
    const up = await upload(c, at);
    expect(up.body.status).toBe('held');
    const pending = requests().find((r) => r.status === 'pending');
    expect(pending.document.state).toBe('held');
    expect(emails.find((e) => e.to === 'pat@example.com').subject).toBe('A request is waiting for you in MAIA');
    // A held box opens for a preview (in the browser, with the folder key).
    const box = await asPatient('get', `/api/received/${pending._id}/box?userId=pat01`);
    expect(openBytesFrom(folderKey.priv, box.body, FOLDER_DOCUMENT_INFO).equals(PDF)).toBe(true);
    expect((await asPatient('get', '/api/received?userId=pat01')).body.documents).toHaveLength(0); // not yet accepted
    expect((await decide('accept')).body.status).toBe('accepted');
    expect((await asPatient('get', '/api/received?userId=pat01')).body.documents).toHaveLength(1);
    const toSender = emails.find((e) => e.to === 'ray@imaging.example' && /accepted/.test(e.subject));
    expect(toSender.text).not.toContain('MRI');
  });

  it('decline deletes the hold and tells the sender; ignore deletes it and says nothing', async () => {
    const c1 = newClient();
    await upload(c1, (await verified(c1)).body.access_token);
    await decide('decline');
    expect(holds.objects.size).toBe(0);
    expect(emails.some((e) => e.to === 'ray@imaging.example' && e.subject === 'Your document was declined')).toBe(true);

    const c2 = newClient('sender-2');
    await upload(c2, (await verified(c2, 'quiet@imaging.example')).body.access_token);
    const before = emails.length;
    await decide('block');
    expect(holds.objects.size).toBe(0);
    expect(emails.slice(before).some((e) => e.to === 'quiet@imaging.example')).toBe(false);
  });

  it('while sharing is off, even an add card only offers: the patient decides', async () => {
    patient().sharingPolicies = [card('a1', 'allow')];
    patient().asState = 'setup';
    const c = newClient();
    const at = (await verified(c)).body.access_token;
    expect(at.access[0].actions).toEqual(['offer']);
    expect((await upload(c, at)).body.status).toBe('held');
  });
});

describe('a deny card, or no folder key: nothing is stored', () => {
  it('deny-respond → request_denied, no token', async () => {
    patient().sharingPolicies = [card('d1', 'deny', {}, { denyMode: 'respond' })];
    const done = await verified(newClient());
    expect(done.body.error.code).toBe('request_denied');
    expect(holds.objects.size).toBe(0);
  });

  it('a card that denies by the time the document arrives: refused, nothing stored', async () => {
    patient().sharingPolicies = [card('a1', 'allow')];
    const c = newClient();
    const at = (await verified(c)).body.access_token;
    patient().sharingPolicies = [card('d1', 'deny')];
    expect((await upload(c, at)).status).toBe(403);
    expect(holds.objects.size).toBe(0);
  });

  it('no folder key: the sender waits as for silence; the patient sees why', async () => {
    delete patient().folderKeyJwk;
    patient().sharingPolicies = [card('a1', 'allow')];
    const done = await verified(newClient());
    expect(done.body.continue).toBeTruthy();
    expect(done.body.access_token).toBeUndefined();
    expect(requests()[0].document.state).toBe('no-key');
  });
});

describe('limits and expiry', () => {
  it(`at most ${MAX_HOLDS} documents wait per patient → 429`, async () => {
    for (let i = 0; i < MAX_HOLDS; i++) {
      await cloudant.saveDocument('maia_as_requests', {
        _id: `asreq_x${i}`, type: 'as_request', userId: 'pat01', status: 'pending', receivedAt: new Date(clock).toISOString(),
        requester: { email: `s${i}@x.example`, emailVerified: true }, document: { ...DOC, state: 'held', heldAt: new Date(clock - 2 * 86400000).toISOString() }
      });
    }
    const done = await verified(newClient());
    expect(done.status).toBe(429);
  });

  it('a held document not decided in 90 days is deleted, and marked expired', async () => {
    const c = newClient();
    await upload(c, (await verified(c)).body.access_token);
    expect(holds.objects.size).toBe(1);
    expect(await sweepExpiredHolds({ cloudant, holds, now: clock + HOLD_TTL_MS - 1000 })).toBe(0);
    expect(await sweepExpiredHolds({ cloudant, holds, now: clock + HOLD_TTL_MS + 1000 })).toBe(1);
    expect(holds.objects.size).toBe(0);
    expect(requests()[0]).toMatchObject({ status: 'expired', document: { state: 'expired' } });
  });
});

describe('the folder key and the patient’s routes', () => {
  it('sets the public half only; each route acts for the session’s own account', async () => {
    const { publicKey } = generateKeyPairSync('x25519');
    const pub = publicKey.export({ format: 'jwk' });
    expect((await asPatient('post', '/api/folder-key').send({ userId: 'pat01', publicJwk: { ...pub, d: 'secret' } })).status).toBe(400);
    const set = await asPatient('post', '/api/folder-key').send({ userId: 'pat01', publicJwk: pub });
    expect(set.body).toEqual({ success: true, replaced: true });
    expect(patient().folderKeyJwk).toEqual({ kty: 'OKP', crv: 'X25519', x: pub.x });
    expect((await asPatient('get', '/api/folder-key?userId=pat01')).body.publicJwk.x).toBe(pub.x);
    expect((await request(server).get('/api/received?userId=pat01')).status).toBe(401);
    expect((await request(server).get('/api/received?userId=pat01').set('x-test-user', 'someone-else')).status).toBe(401);
  });
});

describe('emails name the kind, never the title or content (I-31)', () => {
  it('share and ask bodies', () => {
    const r = { requester: { name: 'Dr. Ray', email: 'ray@x', emailVerified: true }, document: { kind: 'lab-report', title: 'HIV test result' }, resource: 'document' };
    for (const t of [renderShared(r, 'u').text, renderAsks([r], 'u').text]) {
      expect(t).toContain('a lab report');
      expect(t).not.toContain('HIV');
    }
  });
});
