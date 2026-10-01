/**
 * Drafting the Patient Summary from the records themselves: the record PDFs
 * as compact, page-marked text in the citation links' File N order, within
 * a budget (over it, the caller drafts the old way); and the prompt that
 * reads them, with a Notable Lab Trends section.
 */
import { describe, it, expect } from 'vitest';
import { compactPageText, buildRecordsText, recordsBudgetChars } from '../../server/utils/records-text.js';
import { getClinicalPrompt } from '../../server/utils/clinical-prompts.js';
import { SUMMARY_SECTIONS } from '../../server/utils/summary-sections.js';

const PAGE1 = `## EDITH PARGH
Date of Birth: Nov 29, 1953 (Age 72)   Quest Diagnostics
### Lab Results
ALBUMIN   4.8   g/dL   3.6 to 5.1
ALBUMIN   4.8   g/dL   3.6 to 5.1
ALBUMIN   4.8   g/dL   3.6 to 5.1
Continued on Page 2
Health
Page 1 of 19
This summary displays certain health information made available to you by your healthcare provider and may not completely or`;

describe('the records as text', () => {
  it('drops repeated rows and page furniture, keeps the content', () => {
    expect(compactPageText(PAGE1)).toBe('EDITH PARGH\nDate of Birth: Nov 29, 1953 (Age 72)  Quest Diagnostics\nLab Results\nALBUMIN  4.8  g/dL  3.6 to 5.1');
  });

  it('marks every page with its File N, in the order given; a file without text is reported', async () => {
    const pages = { 'u/a.pdf': [{ page: 1, markdown: PAGE1 }, { page: 2, markdown: 'LDL-CHOLESTEROL   258.0 mg/dL' }], 'u/scan.pdf': [{ page: 1, markdown: '' }], 'u/b.pdf': [{ page: 1, markdown: 'Clinic note' }] };
    const r = await buildRecordsText(
      [{ fileName: 'a.pdf', bucketKey: 'u/a.pdf' }, { fileName: 'scan.pdf', bucketKey: 'u/scan.pdf' }, { fileName: 'b.pdf', bucketKey: 'u/b.pdf' }],
      { readBuffer: async (k) => Buffer.from(k), extractPages: async (buf) => pages[buf.toString()], maxChars: 10000 }
    );
    expect(r).toMatchObject({ complete: true, files: 2, pages: 3, unreadable: ['scan.pdf'] });
    expect(r.text).toContain('=== File 1, page 2 ===\nLDL-CHOLESTEROL  258.0 mg/dL');
    expect(r.text).toContain('=== File 3, page 1 ===\nClinic note');
  });

  it('over the budget it says so and sends nothing, rather than half the records', async () => {
    const r = await buildRecordsText([{ fileName: 'a.pdf', bucketKey: 'k' }], {
      readBuffer: async () => Buffer.from('x'), extractPages: async () => [{ page: 1, markdown: 'x'.repeat(500) }], maxChars: 100
    });
    expect(r).toMatchObject({ complete: false, text: '' });
  });

  it('the budget fits the model: smaller for a 128k-context model, overridable', () => {
    expect(recordsBudgetChars('openai-gpt-oss-120b', {})).toBeLessThan(recordsBudgetChars('qwen3.8-max', {}));
    expect(recordsBudgetChars('qwen3.8-max', { MAIA_SUMMARY_RECORDS_MAX_CHARS: '5000' })).toBe(5000);
  });
});

describe('the prompt that reads them', () => {
  it('gets the records, the identity and the anchors, and asks for Notable Lab Trends', () => {
    const p = getClinicalPrompt('patient-summary.records-in-context', {
      today: '2026-10-01', patientIdentity: '- Name: EDITH PARGH', currentMedications: '', stoppedMedications: '',
      allergies: '', outOfRangeLabs: '', fileTags: 'File 1 = Health Records.pdf', records: '=== File 1, page 3 ===\nLDL-CHOLESTEROL  258.0 mg/dL'
    });
    expect(p).toContain("Today's date is 2026-10-01");
    expect(p).toContain('- Name: EDITH PARGH');
    expect(p).toContain('Notable Lab Trends');
    expect(p).toContain('=== File 1, page 3 ===');
    expect(p).not.toMatch(/\{(records|today|fileTags)\}/);
    expect(SUMMARY_SECTIONS).toContain('notable lab trends');
  });
});
