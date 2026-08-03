/**
 * Privacy-filter auto-seeding: name extraction from the Patient Summary's
 * known formats. The original patterns only matched "74 y" headers and
 * parenthesized providers — the generator also emits "Name, 74, M" headers
 * and "by First Last, MD" visit lines, which seeded NOTHING and left the
 * "privacy-filtered" copy identical to the real summary.
 */
import { describe, it, expect } from 'vitest';
import {
  extractSummaryNames, seedPseudonymMappingFromSummary, seedMissingNames,
  looksLikePersonName, applyPseudonymMapping
} from '../../server/privacyFilter.js';

const FORMAT_A = [
  'Adrian Gropper, 74, M',
  '',
  '## Medical History',
  'The patient has prediabetes and hypothyroidism.',
  '',
  '## Recent Visits (past 12 months)',
  '- 2026-05-07 Outpatient – Patient Instructions by Wei Lien, MD',
  '- 2025-10-29 Telemedicine – Telephone Encounter by Harshal Patil',
  '- 2025-08-27 Outpatient – Progress Notes by Brook Donovan, CNP',
  '- 2025-07-01 Imaging read by Boston Medical Center'
].join('\n');

const FORMAT_B = [
  'Jane Doe, 61 y, F',
  '',
  '## Recent Visits',
  '- 2026-01-05 Office visit (Wei Lien, MD)',
  '- 2025-11-20 Telehealth (Harshal Patil)'
].join('\n');

describe('extractSummaryNames', () => {
  it('handles the "Name, 74, M" header and "by Provider" visit lines', () => {
    const names = extractSummaryNames(FORMAT_A);
    expect(names).toContain('Adrian Gropper');
    expect(names).toContain('Wei Lien');
    expect(names).toContain('Harshal Patil');
    expect(names).toContain('Brook Donovan');
    // Organizations are never people.
    expect(names).not.toContain('Boston Medical Center');
  });

  it('still handles the "74 y" header and parenthesized providers', () => {
    const names = extractSummaryNames(FORMAT_B);
    expect(names).toContain('Jane Doe');
    expect(names).toContain('Wei Lien');
    expect(names).toContain('Harshal Patil');
  });
});

describe('seedPseudonymMappingFromSummary', () => {
  it('seeds obviously-fake pseudonyms and the filtered copy actually filters', () => {
    const userDoc = { userId: 'paige34' };
    expect(seedPseudonymMappingFromSummary(userDoc, FORMAT_A)).toBe(true);
    const mapping = userDoc.privacyFilter.pseudonymMapping;
    expect(mapping.length).toBeGreaterThanOrEqual(4);
    for (const e of mapping) expect(e.pseudonym).toMatch(/\d{2}\s.*\d{2}$/);
    const filtered = applyPseudonymMapping(mapping, FORMAT_A);
    expect(filtered).not.toContain('Adrian Gropper');
    expect(filtered).not.toContain('Wei Lien');
    expect(filtered).not.toContain('Brook Donovan');
  });

  it('never reseeds over an existing or explicitly-emptied mapping', () => {
    const withMapping = { userId: 'u', privacyFilter: { pseudonymMapping: [{ original: 'A B', pseudonym: 'X10 Y20' }], lastUpdated: 'x' } };
    expect(seedPseudonymMappingFromSummary(withMapping, FORMAT_A)).toBe(false);
    const emptied = { userId: 'u', privacyFilter: { pseudonymMapping: [], lastUpdated: '2026-08-01T00:00:00Z' } };
    expect(seedPseudonymMappingFromSummary(emptied, FORMAT_A)).toBe(false);
    expect(emptied.privacyFilter.pseudonymMapping.length).toBe(0);
  });

  it('a summary with no recognizable names seeds nothing and leaves no lockout stamp', () => {
    const userDoc = { userId: 'u' };
    expect(seedPseudonymMappingFromSummary(userDoc, '## Medical History\nNo names here.')).toBe(false);
    expect(userDoc.privacyFilter).toBeUndefined();
  });
});

// The Margarita regression: single-name patient header, credential-anchored
// visit lines with an ALL-CAPS org in parens ("PARTNERS HEALTHCARE"). The
// old code seeded ONLY the org (as a fake "person") and none of the people,
// producing "Theodor Sauer, MD (Blake45 Granger10)" — real names visible,
// nonsense pseudonym appended.
const FORMAT_C = [
  'Margarita, 68, Female',
  '',
  '## Medical History',
  "Margarita has Crohn's disease of the small intestine.",
  '',
  '## Recent Visits (past 12 months)',
  '- 2026-02-02 Outpatient – Theodor Sauer, MD (PARTNERS HEALTHCARE)',
  '- 2025-12-29 Outpatient – Caroline Macharia Mwangi, RN (PARTNERS HEALTHCARE)',
  '- 2025-12-22 Outpatient – Sharon Chou, MD (PARTNERS HEALTHCARE)',
  '- 2025-11-13 Outpatient – Joshua Korzenik, MD (PARTNERS HEALTHCARE)',
  '- 2025-10-25 Outpatient – Sharon Chou, MD, PARTNERS HEALTHCARE (Imaging, Radiology)'
].join('\n');

describe('single-name patients + credential-anchored providers (Margarita regression)', () => {
  it('extracts the single-name patient and every credentialed provider — never the org', () => {
    const names = extractSummaryNames(FORMAT_C);
    expect(names).toContain('Margarita');
    expect(names).toContain('Theodor Sauer');
    expect(names).toContain('Caroline Macharia Mwangi');
    expect(names).toContain('Sharon Chou');
    expect(names).toContain('Joshua Korzenik');
    expect(names.some((n) => /HEALTHCARE/i.test(n))).toBe(false);
  });

  it('the filtered copy contains no real names, including the single name', () => {
    const userDoc = { userId: 'ashley24' };
    expect(seedPseudonymMappingFromSummary(userDoc, FORMAT_C)).toBe(true);
    const filtered = applyPseudonymMapping(userDoc.privacyFilter.pseudonymMapping, FORMAT_C);
    expect(filtered).not.toContain('Margarita');
    expect(filtered).not.toContain('Theodor Sauer');
    expect(filtered).not.toContain('Sharon Chou');
    expect(filtered).not.toContain('Caroline Macharia Mwangi');
    expect(filtered).not.toContain('Joshua Korzenik');
    // The org is not a person: it stays, unmasked, and no pseudonym rides
    // along next to a real name.
    expect(filtered).toContain('PARTNERS HEALTHCARE');
  });

  it('looksLikePersonName rejects orgs and accepts people', () => {
    expect(looksLikePersonName('PARTNERS HEALTHCARE')).toBe(false);
    expect(looksLikePersonName('Boston Medical Center')).toBe(false);
    expect(looksLikePersonName('Theodor Sauer')).toBe(true);
    expect(looksLikePersonName('Caroline Macharia Mwangi')).toBe(true);
  });

  it('seedMissingNames augments an auto mapping without touching existing entries', () => {
    const userDoc = { userId: 'u' };
    seedPseudonymMappingFromSummary(userDoc, FORMAT_A);
    const before = userDoc.privacyFilter.pseudonymMapping.map((e) => ({ ...e }));
    const added = seedMissingNames(userDoc, FORMAT_C);
    expect(added).toBeGreaterThanOrEqual(4); // Margarita + the new providers
    for (const b of before) {
      const still = userDoc.privacyFilter.pseudonymMapping.find((e) => e.original === b.original);
      expect(still?.pseudonym).toBe(b.pseudonym);
    }
    // Idempotent: a second pass adds nothing.
    expect(seedMissingNames(userDoc, FORMAT_C)).toBe(0);
  });
});
