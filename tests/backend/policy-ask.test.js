/**
 * "Ask me first" cards: explicit ask-outcome precedence (deny → ask →
 * allow → default ask) in BOTH policy matchers — server
 * (server/routes/policies.js) and client (src/utils/policyCards.ts) —
 * which must stay in sync.
 */
import { describe, it, expect } from 'vitest';
import { evaluatePolicies, policySentence, normalizeCard } from '../../server/routes/policies.js';
import { evaluate, sentenceFor } from '../../src/utils/policyCards';

const card = (outcome, scope, over = {}) => ({
  id: `pol_${outcome}_${scope}`,
  outcome,
  enabled: true,
  provenance: 'user',
  elements: {
    party: { type: 'anyone' },
    purpose: 'clinical',
    scope,
    filtered: true,
    signature: 'verified-email',
    payment: 'none',
    ...over.elements
  },
  ...over
});

const req = (scope, over = {}) => ({
  party: { type: 'anyone' },
  purpose: 'clinical',
  scope,
  signature: 'verified-email',
  payment: 'none',
  ...over
});

describe('explicit ask-outcome cards', () => {
  const broadAllow = card('allow', 'everything');
  const askPs = card('ask', 'patient-summary');
  const denyPs = card('deny', 'patient-summary');

  it('ask carves an approval requirement out of a broader allow (both matchers)', () => {
    const cards = [broadAllow, askPs];
    // Patient Summary: the ask card wins over the subsuming allow.
    const s = evaluatePolicies(cards, req('patient-summary'));
    expect(s.outcome).toBe('ask');
    expect(s.decidedBy?.id).toBe('pol_ask_patient-summary');
    const c = evaluate(cards, req('patient-summary'));
    expect(c.outcome).toBe('ask');
    expect(c.decidedBy?.id).toBe('pol_ask_patient-summary');
    // Everything else the allow still covers.
    expect(evaluatePolicies(cards, req('everything')).outcome).toBe('allow');
    expect(evaluate(cards, req('everything')).outcome).toBe('allow');
  });

  it('subsumption applies to ask cards too (PS ask covers a meds ask)', () => {
    const cards = [broadAllow, askPs];
    expect(evaluatePolicies(cards, req('meds-allergies')).outcome).toBe('ask');
    expect(evaluate(cards, req('meds-allergies')).outcome).toBe('ask');
  });

  it('deny still beats ask', () => {
    const cards = [denyPs, askPs, broadAllow];
    expect(evaluatePolicies(cards, req('patient-summary')).outcome).toBe('deny');
    expect(evaluate(cards, req('patient-summary')).outcome).toBe('deny');
  });

  it('a disabled ask card does not participate', () => {
    const cards = [broadAllow, { ...askPs, enabled: false }];
    expect(evaluatePolicies(cards, req('patient-summary')).outcome).toBe('allow');
    expect(evaluate(cards, req('patient-summary')).outcome).toBe('allow');
  });

  it('no matching card still defaults to ask with no decidedBy', () => {
    const s = evaluatePolicies([askPs], req('everything'));
    expect(s.outcome).toBe('ask');
    expect(s.decidedBy).toBeNull();
  });

  it('normalizeCard accepts ask cards and sentences read as approval', () => {
    const norm = normalizeCard(askPs);
    expect(norm).not.toBeNull();
    expect(norm.outcome).toBe('ask');
    expect(norm.denyMode).toBeUndefined();
    expect(policySentence(askPs)).toContain('needs my approval to receive');
    expect(sentenceFor(askPs)).toContain('needs my approval to receive');
  });
});
