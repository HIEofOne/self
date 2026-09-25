/**
 * P7d: Current Medications as a section of the Patient Summary. The server
 * and client twins split and join the section identically; a verified
 * summary is the source of the medication list; a "meds and allergies"
 * share releases only what the patient verified.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as server from '../../server/utils/summary-sections.js';
import * as client from '../../src/utils/summaryMeds';
import { applyPseudonymMapping } from '../../server/privacyFilter.js';
import { deriveSetupStatus } from '../../server/routes/setup.js';
import { EDITIONS, getEdition, setEditionForTests } from '../../server/edition.js';

const originalEdition = getEdition();
afterAll(() => setEditionForTests(originalEdition));

const PS = `**Pat Doe**, 66, F

**Medical History**
Type 2 diabetes, followed by Dr. Jane Smith.

**Current Medications**
- Metformin 500 mg twice daily [File 1 p.12]
- **Lisinopril** 10 mg daily

**Stopped or Inactive Medications**
- Atorvastatin (last 2023-01-02)

**Allergies**
- Penicillin — hives

**Social History**
Never smoker.`;

const CASES = {
  bold: PS,
  hashes: PS.replace(/\*\*(Medical History|Current Medications|Stopped or Inactive Medications|Allergies|Social History)\*\*/g, '## $1'),
  inline: 'Current Medications:\n- Aspirin 81mg daily\nAllergies: none',
  empty: '## Current Medications\nNot documented in the available records.\n\n## Allergies\nNone',
  verifiedMarker: '## Current Medications (Patient Verified)\n1. Metformin\n2) Lisinopril\n## Allergies\nNone',
  plainHeadings: 'Current Medications\n- Metformin\nStopped or Inactive Medications\n- Atorvastatin',
  missing: '**Medical History**\nNothing else.'
};

describe('the section twins agree', () => {
  for (const [name, text] of Object.entries(CASES)) {
    it(`split and join: ${name}`, () => {
      const s = server.splitMedsSection(text);
      const c = client.splitMedsSection(text);
      expect(c).toEqual(s);
      const rows = [...s.rows, 'Aspirin 81 mg'];
      expect(client.joinMedsSection(c, rows)).toBe(server.joinMedsSection(s, rows));
    });
  }
});

describe('reading the section', () => {
  it('finds the rows, keeps citations and bold, and stops at the next section', () => {
    const p = server.splitMedsSection(PS);
    expect(p.rows).toEqual(['Metformin 500 mg twice daily [File 1 p.12]', '**Lisinopril** 10 mg daily']);
    expect(p.after.startsWith('**Stopped or Inactive Medications**')).toBe(true); // never absorbs it
  });

  it('an unchanged list joins back to the same summary', () => {
    const p = server.splitMedsSection(PS);
    expect(server.joinMedsSection(p, p.rows)).toBe(PS);
  });

  it('an empty list reads as none, and joins back as "None"', () => {
    const p = server.splitMedsSection(CASES.empty);
    expect(p.rows).toEqual([]);
    expect(p.note).toMatch(/^Not documented/);
    expect(server.joinMedsSection(p, [])).toContain('## Current Medications\nNone');
    expect(server.medsFromSummary(CASES.empty)).toBe('None');
  });

  it('numbered lists and verified markers are read too; no section means no list', () => {
    expect(server.splitMedsSection(CASES.verifiedMarker).rows).toEqual(['Metformin', 'Lisinopril']);
    expect(server.medsFromSummary(CASES.missing)).toBeNull();
    expect(server.medsFromSummary(PS)).toBe('- Metformin 500 mg twice daily [File 1 p.12]\n- **Lisinopril** 10 mg daily');
  });

  it('rows compare by drug and content, not by formatting', () => {
    expect(client.drugKey('**Metformin** 500 mg [File 1 p.12]')).toBe('metformin');
    expect(client.sameMedList(['- Metformin 500 mg [File 1 p.3]'], ['metformin 500 mg'])).toBe(true);
    expect(client.sameMedList(['Metformin 500 mg'], ['Metformin 1000 mg'])).toBe(false);
  });
});

describe('what a "meds and allergies" share releases', () => {
  const mapping = [{ original: 'Pat Doe', pseudonym: 'Rowan73 Vance28' }];
  const filtered = applyPseudonymMapping(mapping, PS);

  it('a verified summary: its medications and allergies, from the filtered copy', () => {
    const a = server.medsAllergiesArtifact({
      patientSummaryVerifiedAt: '2026-09-24T12:00:00Z',
      privacyFilteredSummary: { text: filtered },
      privacyFilter: { pseudonymMapping: mapping }
    }, applyPseudonymMapping);
    expect(a).toContain('Metformin 500 mg twice daily');
    expect(a).toContain('Penicillin');
    expect(a).not.toContain('Atorvastatin'); // stopped meds aren't current
    expect(a).not.toContain('Pat Doe');
  });

  it('nothing verified: nothing leaves (the request comes to the patient)', () => {
    expect(server.medsAllergiesArtifact({ currentMedications: '- Metformin', privacyFilteredSummary: { text: filtered } }, applyPseudonymMapping)).toBe('');
  });

  it('a separately verified list still leaves, filtered (full edition until its back-port)', () => {
    const a = server.medsAllergiesArtifact({
      currentMedications: '- Metformin (prescribed for Pat Doe)', currentMedicationsVerifiedAt: '2026-09-24T12:00:00Z',
      privacyFilter: { pseudonymMapping: mapping }
    }, applyPseudonymMapping);
    expect(a).toContain('Metformin');
    expect(a).not.toContain('Pat Doe');
  });
});

describe.each(EDITIONS)('setup checklist row 5, edition "%s"', (edition) => {
  it('personal-as: done with the verified summary alone; full: needs both stamps', () => {
    setEditionForTests(edition);
    const row = (doc) => deriveSetupStatus(doc).steps.find((s) => s.key === 'summary');
    expect(row({ patientSummaryVerifiedAt: 'y' }).done).toBe(edition === 'personal-as');
    expect(row({ patientSummaryVerifiedAt: 'y', currentMedicationsVerifiedAt: 'x' }).done).toBe(true);
  });
});
