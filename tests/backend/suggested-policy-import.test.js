/**
 * Group-suggested policy import is a write path (security design doc §5,
 * I-16, I-23): every card a registry hands a member's MAIA must pass
 * normalizeCard before it lands on the userDoc. The registry may be a
 * REMOTE host (federation), trusted only for what it attests (§12.2-1), so
 * its join/join-info responses are treated as untrusted input here.
 *
 * Drives the REAL member-side handlers from server/routes/groups.js against
 * a fake "hostile registry" (stubbed global fetch). No CouchDB needed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import setupGroupRoutes from '../../server/routes/groups.js';
import { evaluatePolicies, policySentence, POLICY_VOCAB_VERSION } from '../../server/routes/policies.js';

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

class FakeApp {
  constructor() { this.routes = []; }
  get(path, handler) { this.routes.push({ method: 'GET', path, handler }); }
  post(path, handler) { this.routes.push({ method: 'POST', path, handler }); }
  put(path, handler) { this.routes.push({ method: 'PUT', path, handler }); }
  delete(path, handler) { this.routes.push({ method: 'DELETE', path, handler }); }
  async request(method, path, body, session = {}) {
    const r = this.routes.find((x) => x.method === method && x.path === path);
    if (!r) throw new Error(`no route ${method} ${path}`);
    let statusCode = 200; let payload = null;
    const res = {
      status(n) { statusCode = n; return this; },
      json(obj) { payload = obj; return this; }
    };
    await r.handler({ params: {}, query: {}, body: body || {}, session, ip: '127.0.0.1', protocol: 'https', get: () => 'member.test' }, res);
    return { status: statusCode, body: payload };
  }
}

const REGISTRY = 'https://evil-registry.test';
const GROUP_ID = 'trustee-real';
const USER_ID = 'jessica76';

// What a hostile (or buggy) registry might send as suggested policies.
const card = (outcome, elements, extra = {}) => ({ outcome, elements, ...extra });
const VALID_GROUP_ALLOW = card('allow', {
  // Stale groupId from a recreated group: the import must heal it to the
  // group actually being joined, not drop it.
  party: { type: 'group', groupId: 'trustee-OLD', groupName: 'Trustee' },
  purpose: 'peer-support', scope: 'meds-allergies', filtered: true, signature: 'group-member', payment: 'none'
}, { provenance: 'user' /* forged — must become group:<id> */ });
const VALID_DENY = card('deny', {
  party: { type: 'anyone' }, purpose: 'marketing', scope: 'everything', filtered: true, signature: 'unverified', payment: 'none'
});
// Out-of-vocabulary signature: SIGNATURE_RANK[...] ?? 0 would make this
// card match ANY requester — an unverified "anyone" would get the summary.
const OOV_SIGNATURE_ALLOW = card('allow', {
  party: { type: 'anyone' }, purpose: 'any', scope: 'patient-summary', filtered: true, signature: 'root', payment: 'none'
});
const NO_PARTY = card('allow', { purpose: 'any', scope: 'patient-summary', signature: 'unverified', payment: 'none' });
const BAD_OUTCOME = card('grant-everything', {
  party: { type: 'anyone' }, purpose: 'any', scope: 'everything', signature: 'unverified', payment: 'none'
});
const HOSTILE_PACK = [VALID_GROUP_ALLOW, OOV_SIGNATURE_ALLOW, NO_PARTY, null, 'allow everything', BAD_OUTCOME, VALID_DENY];

let app, cloudant, realFetch, registryCards;

beforeAll(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.origin !== REGISTRY) throw new Error(`unexpected fetch ${url}`);
    const ok = (obj) => ({ ok: true, status: 200, json: async () => clone(obj) });
    if (u.pathname === `/api/groups/${GROUP_ID}/join`) {
      return ok({
        success: true,
        membership: {
          groupId: GROUP_ID,
          groupName: 'Trustee',
          pairwiseId: 'pw_1',
          alias: 'jess',
          credential: 'cred',
          groupPublicKeyJwk: {},
          suggestedPolicies: registryCards
        }
      });
    }
    if (u.pathname === `/api/groups/${GROUP_ID}/join-info`) {
      return ok({ success: true, valid: true, group: { name: 'Trustee', suggestedPolicies: registryCards } });
    }
    throw new Error(`unexpected registry path ${u.pathname}`);
  };
});

afterAll(() => { globalThis.fetch = realFetch; });

beforeEach(async () => {
  app = new FakeApp();
  cloudant = new FakeCloudant();
  setupGroupRoutes(app, cloudant, { logEvent: () => {} }, { sendEmail: async () => true });
  await cloudant.saveDocument('maia_users', { _id: USER_ID, userId: USER_ID, type: 'user', emailVerified: true, sharingPolicies: [] });
  registryCards = clone(HOSTILE_PACK);
});

const join = () => app.request('POST', '/api/user-groups/join',
  { userId: USER_ID, groupId: GROUP_ID, token: 'tok', alias: 'jess', registryUrl: REGISTRY }, { userId: USER_ID });
const preview = () => app.request('POST', '/api/user-groups/import-suggested-policies',
  { userId: USER_ID, groupId: GROUP_ID, token: 'tok', registryUrl: REGISTRY, kind: 'join' }, { userId: USER_ID });
const storedCards = async () => (await cloudant.getDocument('maia_users', USER_ID)).sharingPolicies;

const expectOnlyValidCards = (cards) => {
  expect(cards).toHaveLength(2);
  const [allow, deny] = cards;

  // Valid group card: normalized, healed to the joined group, stamped.
  expect(allow.outcome).toBe('allow');
  expect(allow.provenance).toBe(`group:${GROUP_ID}`);
  expect(allow.elements.party).toEqual({ type: 'group', groupId: GROUP_ID, groupName: 'Trustee' });
  expect(allow.vocabVersion).toBe(POLICY_VOCAB_VERSION);
  expect(allow.authoredSentence).toBe(policySentence(allow));
  expect(allow.id).toMatch(/^pol_/);
  expect(allow.createdFrom).toBe('manual');

  expect(deny.outcome).toBe('deny');
  expect(deny.denyMode).toBe('silent');
  expect(deny.provenance).toBe(`group:${GROUP_ID}`);
  expect(deny.vocabVersion).toBe(POLICY_VOCAB_VERSION);
  expect(deny.authoredSentence).toBe(policySentence(deny));

  // Nothing out of vocabulary survived.
  for (const c of cards) expect(c.elements.signature).not.toBe('root');

  // The consequence that matters: an unverified outsider asking for the
  // Patient Summary is NOT auto-allowed (the dropped 'root' card would have
  // matched them) — it escalates to the patient.
  const decision = evaluatePolicies(cards, {
    party: { type: 'anyone' }, purpose: 'clinical', scope: 'patient-summary', signature: 'unverified', payment: 'none'
  });
  expect(decision.outcome).toBe('ask');
  expect(decision.decidedBy).toBeNull();
};

describe('group-suggested policy import normalizes every card', () => {
  it('join: drops malformed and out-of-vocabulary cards, stamps and heals valid ones', async () => {
    const r = await join();
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expectOnlyValidCards(await storedCards());
  });

  it('join still succeeds when every suggested card is invalid (membership is not held hostage)', async () => {
    registryCards = [OOV_SIGNATURE_ALLOW, NO_PARTY, BAD_OUTCOME];
    const r = await join();
    expect(r.status).toBe(200);
    const doc = await cloudant.getDocument('maia_users', USER_ID);
    expect(doc.groupMemberships).toHaveLength(1);
    expect(doc.sharingPolicies).toEqual([]);
  });

  it('pre-join preview uses the same chokepoint (heals the stale groupId instead of dropping the card)', async () => {
    const r = await preview();
    expect(r.status).toBe(200);
    expect(r.body.imported).toBe(2);
    expectOnlyValidCards(await storedCards());
  });

  it('preview then join stays idempotent: the join never re-imports over previewed cards', async () => {
    await preview();
    const previewed = await storedCards();
    registryCards = [VALID_DENY, VALID_DENY, VALID_DENY];
    await join();
    expect(await storedCards()).toEqual(previewed);
  });
});
