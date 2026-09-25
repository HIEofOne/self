/**
 * Confirmed policies and the AS state (group_requests.md §6.1–6.2, I-24):
 * both evaluator twins agree, options included; the patient's own acts
 * stamp confirmedAt; sharing turns on only with every enabled card
 * confirmed. Route behavior runs under both editions.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { serve } from '../helpers/serve.js';
import {
  evaluatePolicies, evaluationOptionsFor, asStateOf
} from '../../server/routes/policies.js';
import setupPolicyRoutes from '../../server/routes/policies.js';
import { evaluate } from '../../src/utils/policyCards';
import { EDITIONS, getEdition, setEditionForTests } from '../../server/edition.js';
import { deriveSetupStatus } from '../../server/routes/setup.js';

const originalEdition = getEdition();
afterAll(() => setEditionForTests(originalEdition));

const card = (id, outcome, over = {}) => ({
  id, outcome, enabled: true, provenance: 'user',
  elements: { party: { type: 'anyone' }, purpose: 'clinical', scope: 'meds-allergies', filtered: true, signature: 'verified-email', payment: 'none' },
  ...over
});
const REQ = { party: { type: 'anyone' }, purpose: 'clinical', scope: 'meds-allergies', signature: 'verified-email', payment: 'none' };
const CONFIRMED = '2026-09-24T12:00:00Z';

describe('evaluator: confirmed cards and the AS state', () => {
  const allowConfirmed = card('a1', 'allow', { confirmedAt: CONFIRMED });
  const allowPending = card('a2', 'allow');
  const denyPending = card('d1', 'deny');

  const cases = [
    { name: 'defaults (full edition) — any enabled card decides', cards: [allowPending], opts: undefined, outcome: 'allow' },
    { name: 'an unconfirmed allow card does not decide', cards: [allowPending], opts: { requireConfirmed: true }, outcome: 'ask' },
    { name: 'a confirmed allow card decides', cards: [allowConfirmed], opts: { requireConfirmed: true }, outcome: 'allow' },
    { name: 'an unconfirmed deny card does not decide either', cards: [denyPending, allowConfirmed], opts: { requireConfirmed: true }, outcome: 'allow' },
    { name: 'setup: nothing decides', cards: [allowConfirmed], opts: { requireConfirmed: true, asState: 'setup' }, outcome: 'ask' },
    { name: 'paused: nothing decides', cards: [allowConfirmed], opts: { requireConfirmed: true, asState: 'paused' }, outcome: 'ask' },
    { name: 'active: confirmed cards decide', cards: [allowConfirmed], opts: { requireConfirmed: true, asState: 'active' }, outcome: 'allow' }
  ];

  for (const c of cases) {
    it(`${c.name} — and the client twin agrees`, () => {
      const server = evaluatePolicies(c.cards, REQ, c.opts);
      const client = evaluate(c.cards, REQ, c.opts);
      expect(server.outcome).toBe(c.outcome);
      expect(client.outcome).toBe(server.outcome);
      expect(client.decidedBy?.id ?? null).toBe(server.decidedBy?.id ?? null);
    });
  }

  it('reports why nothing was decided when sharing is off', () => {
    expect(evaluatePolicies([allowConfirmed], REQ, { asState: 'paused' }).reason).toBe('sharing-off');
    expect(evaluate([allowConfirmed], REQ, { asState: 'setup' }).reason).toBe('sharing-off');
  });

  it('evaluationOptionsFor: full keeps today; personal-as needs confirmation and starts in setup', () => {
    setEditionForTests('full');
    expect(evaluationOptionsFor({})).toEqual({ requireConfirmed: false, asState: 'active' });
    expect(evaluationOptionsFor({ asState: 'paused' }).asState).toBe('active');
    setEditionForTests('personal-as');
    expect(evaluationOptionsFor({})).toEqual({ requireConfirmed: true, asState: 'setup' });
    expect(asStateOf({ asState: 'paused' })).toBe('paused');
    expect(asStateOf({ asState: 'bogus' })).toBe('setup');
  });
});

class FakeCloudant {
  constructor(docs = {}) { this.docs = new Map(Object.entries(docs)); }
  async getDocument(_db, id) { const d = this.docs.get(id); return d ? JSON.parse(JSON.stringify(d)) : null; }
  async saveDocument(_db, doc) { this.docs.set(doc._id, JSON.parse(JSON.stringify(doc))); return { ok: true }; }
}

describe.each(EDITIONS)('policy routes, edition "%s"', (edition) => {
  const pa = edition === 'personal-as';
  let cloudant, server, audits;
  const as = (method, url) => request(server)[method](url).set('x-test-user', 'carol03');
  beforeEach(async () => {
    setEditionForTests(edition);
    audits = [];
    cloudant = new FakeCloudant({
      carol03: {
        _id: 'carol03', userId: 'carol03',
        sharingPolicies: [card('pol_suggested', 'allow', { provenance: 'group:g1' })] // imported, unconfirmed
      }
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { const u = req.get('x-test-user'); req.session = u ? { userId: u } : {}; next(); });
    setupPolicyRoutes(app, cloudant, { logEvent: (e) => audits.push(e) });
    server = await serve(app);
  });

  it('GET reports the AS state (always active in full)', async () => {
    const r = await as('get', '/api/user-policies?userId=carol03');
    expect(r.body.asState).toBe(pa ? 'setup' : 'active');
  });

  it("a card the patient writes or edits is confirmed by that act", async () => {
    const created = await as('post', '/api/user-policies').send({ userId: 'carol03', policy: card('x', 'deny') });
    expect(created.body.policy.confirmedAt).toBeTruthy();
    const edited = await as('put', '/api/user-policies/pol_suggested')
      .send({ userId: 'carol03', policy: card('pol_suggested', 'allow', { provenance: 'group:g1' }) });
    expect(edited.body.policy.confirmedAt).toBeTruthy();
  });

  it('Confirm stamps a suggested card as it is, and is logged', async () => {
    const r = await as('post', '/api/user-policies/pol_suggested/confirm').send({ userId: 'carol03' });
    expect(r.status).toBe(200);
    expect(r.body.policy.confirmedAt).toBeTruthy();
    expect(r.body.policy.elements.scope).toBe('meds-allergies');
    expect(audits.some((e) => e.type === 'sharing_policy_confirmed')).toBe(true);
    expect((await as('post', '/api/user-policies/nope/confirm').send({ userId: 'carol03' })).status).toBe(404);
  });

  it('turning sharing on needs every enabled rule confirmed; pausing always works', async () => {
    const on = () => as('post', '/api/as-state').send({ userId: 'carol03', state: 'active' });
    if (!pa) {
      expect((await on()).body.error).toBe('NOT_IN_THIS_EDITION');
      return;
    }
    const refused = await on();
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'UNCONFIRMED_POLICIES', policyIds: ['pol_suggested'] });
    await as('post', '/api/user-policies/pol_suggested/confirm').send({ userId: 'carol03' });
    expect((await on()).body.asState).toBe('active');
    expect(cloudant.docs.get('carol03').asState).toBe('active');
    const paused = await as('post', '/api/as-state').send({ userId: 'carol03', state: 'paused' });
    expect(paused.body.asState).toBe('paused');
    expect((await as('post', '/api/as-state').send({ userId: 'carol03', state: 'bogus' })).status).toBe(400);
    expect(audits.filter((e) => e.type === 'as_state_changed').map((e) => e.details.to)).toEqual(['active', 'paused']);
  });

  it('a disabled rule does not block turning sharing on', async () => {
    if (!pa) return;
    const d = cloudant.docs.get('carol03');
    d.sharingPolicies[0].enabled = false;
    expect((await as('post', '/api/as-state').send({ userId: 'carol03', state: 'active' })).body.asState).toBe('active');
  });

  it('the setup checklist row 6 follows the AS state and counts rules to confirm', () => {
    const row = (doc) => deriveSetupStatus(doc).steps.find((s) => s.key === 'sharing');
    const doc = cloudant.docs.get('carol03');
    expect(row(doc)).toMatchObject({ required: false, done: !pa, unconfirmed: 1 });
    expect(row({ ...doc, asState: 'active' }).done).toBe(true);
    expect(deriveSetupStatus(doc).requiredDone).toBe(false); // row 6 never blocks the checklist on its own
  });
});
