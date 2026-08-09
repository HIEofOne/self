/**
 * Vocabulary-edition stamping (P0 of design doc §15.6): every card
 * records the edition its elements are expressed in, plus its consent
 * sentence at save. This is what makes future vocabulary migrations
 * possible — you can't migrate cards you didn't stamp.
 */
import { describe, it, expect } from 'vitest';
import { normalizeCard, policySentence, POLICY_VOCAB_VERSION } from '../../server/routes/policies.js';
import { POLICY_VOCAB_VERSION as CLIENT_VOCAB_VERSION } from '../../src/utils/policyCards';

const rawCard = (over = {}, elOver = {}) => ({
  outcome: 'allow',
  enabled: true,
  provenance: 'user',
  elements: {
    party: { type: 'anyone' },
    purpose: 'clinical',
    scope: 'patient-summary',
    filtered: true,
    signature: 'verified-email',
    payment: 'none',
    ...elOver
  },
  ...over
});

describe('policy vocabulary editions', () => {
  it('client and server declare the same edition (twin-file parity)', () => {
    expect(CLIENT_VOCAB_VERSION).toBe(POLICY_VOCAB_VERSION);
  });

  it('a new card is stamped with the current edition and its consent sentence', () => {
    const card = normalizeCard(rawCard());
    expect(card.vocabVersion).toBe(POLICY_VOCAB_VERSION);
    expect(card.authoredSentence).toBe(policySentence(card));
    expect(card.authoredSentence).toContain('may receive');
  });

  it('a valid incoming stamp is preserved on round-trip (edits keep the authored edition)', () => {
    const card = normalizeCard(rawCard({ vocabVersion: 1 }));
    expect(card.vocabVersion).toBe(1);
  });

  it('bogus stamps are replaced with the current edition', () => {
    expect(normalizeCard(rawCard({ vocabVersion: 0 })).vocabVersion).toBe(POLICY_VOCAB_VERSION);
    expect(normalizeCard(rawCard({ vocabVersion: 99 })).vocabVersion).toBe(POLICY_VOCAB_VERSION);
    expect(normalizeCard(rawCard({ vocabVersion: 1.5 })).vocabVersion).toBe(POLICY_VOCAB_VERSION);
  });

  it("a legacy card using 'npi' is stamped edition 1 — the only edition that expresses it", () => {
    const card = normalizeCard(rawCard({ vocabVersion: 2 }, { signature: 'npi' }));
    expect(card).not.toBeNull(); // legacy cards stay editable (removal never strands them)
    expect(card.vocabVersion).toBe(1);
    // …and its strict meaning survives in the sentence.
    expect(card.authoredSentence).toContain('npi identity or stronger');
  });
});
