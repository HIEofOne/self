/**
 * Patient Summary from an Apple Health export without a search index
 * (Personal AS edition, group_requests.md §5, D11 route 1; phase P7c).
 * The pipeline skips indexing unless "Search all my records" is on (and,
 * since P7d, has no separate medications step there), and
 * the records-only prompt never sends the private AI to a knowledge base.
 * The full edition keeps indexing in every user's journey.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { computeRecordsPipeline, decideNextAction } from '../../server/records-pipeline.js';
import { getClinicalPrompt, listClinicalPrompts } from '../../server/utils/clinical-prompts.js';
import { EDITIONS, getEdition, setEditionForTests } from '../../server/edition.js';

const originalEdition = getEdition();
afterAll(() => setEditionForTests(originalEdition));

const AH_FILE = { fileName: 'Health Records.pdf', bucketKey: 'pat01/Health_Records.pdf', isAppleHealth: true, uploadedAt: '2026-09-24T12:00:00Z' };
const listsDone = { files: [AH_FILE], listsBuild: { status: 'done', finishedAt: '2026-09-24T12:01:00Z' } };

describe.each(EDITIONS)('records pipeline, edition "%s"', (edition) => {
  const pa = edition === 'personal-as';

  it('the Lists build still comes first for a new Apple Health export', () => {
    setEditionForTests(edition);
    expect(decideNextAction(computeRecordsPipeline({ files: [AH_FILE] })).action).toBe('process-initial-file');
  });

  it('after the Lists build: indexing in full; in Personal AS, the draft (no separate medications step, P7d)', () => {
    setEditionForTests(edition);
    const pipeline = computeRecordsPipeline(listsDone);
    const next = decideNextAction(pipeline);
    if (!pa) {
      expect(pipeline.stages.indexed.status).toBe('pending');
      expect(next.action).toBe('start-indexing');
      return;
    }
    expect(pipeline.stages.indexed.status).toBe('skipped');
    expect(pipeline.stages.medsVerified.status).toBe('skipped');
    expect(next).toMatchObject({ kind: 'client', action: 'request-draft' });
  });

  it('Personal AS: the draft goes straight to the one review, where the medications are verified too', () => {
    setEditionForTests(edition);
    if (!pa) return;
    const drafted = { ...listsDone, draftPatientSummary: { text: 'draft', draftAt: '2026-09-24T12:12:00Z' } };
    const p = computeRecordsPipeline(drafted);
    expect(p.current).toBe('summaryVerified');
    expect(decideNextAction(p)).toMatchObject({ kind: 'user', action: 'review-summary' });
  });

  it('full: the hidden draft still comes before the medications, as before', () => {
    setEditionForTests(edition);
    if (pa) return;
    const drafted = { ...listsDone, draftPatientSummary: { text: 'draft', draftAt: '2026-09-24T12:05:00Z' } };
    expect(computeRecordsPipeline(drafted, { hasFilesInKB: true }).current).toBe('medsVerified');
    const meds = { ...drafted, currentMedications: 'Metformin 500 mg twice daily' }; // no stamp needed in full
    expect(computeRecordsPipeline(meds, { hasFilesInKB: true }).current).toBe('summaryVerified');
    expect(computeRecordsPipeline(listsDone, { hasFilesInKB: true }).current).toBe('summaryDrafted');
  });

  it('a Personal AS user who turns on "Search all my records" indexes first', () => {
    setEditionForTests(edition);
    const unlocked = { ...listsDone, features: { 'records-index': { enabledAt: '2026-09-24T12:00:00Z' } } };
    expect(computeRecordsPipeline(unlocked).stages.indexed.status).toBe('pending');
    expect(computeRecordsPipeline(unlocked, { hasFilesInKB: true }).current).toBe('summaryDrafted');
  });

  it('without an Apple Health file, medications never block (interview users)', () => {
    setEditionForTests(edition);
    const interviewed = { draftPatientSummary: { text: 'draft', draftAt: '2026-09-24T12:05:00Z' } };
    expect(computeRecordsPipeline(interviewed).stages.medsVerified.status).toBe('skipped');
  });
});

describe('the records-only summary prompt', () => {
  const vars = {
    patientIdentity: '**Patient:** Pat Doe, DOB 1960-05-01, F',
    currentMedications: '**Authoritative Current Medications (verified by the patient):**\nMetformin 500 mg twice daily',
    stoppedMedications: '', encounters: '', allergies: '', outOfRangeLabs: '',
    medicalHistory: '', socialHistory: '', radiology: '', fileTags: 'File 1 = Health Records.pdf'
  };

  it('takes the same placeholders as the draft prompt, so the builder feeds both', () => {
    const byId = Object.fromEntries(listClinicalPrompts().map((p) => [p.id, p.placeholders]));
    expect(byId['patient-summary.records-only']).toBeDefined();
    expect([...byId['patient-summary.records-only']].sort()).toEqual([...byId['patient-summary.draft']].sort());
  });

  it('uses only the extracted blocks and never sends the AI to a knowledge base', () => {
    const t = getClinicalPrompt('patient-summary.records-only', vars);
    expect(t).toContain('Pat Doe');
    expect(t).toContain('Metformin 500 mg twice daily');
    expect(t).toContain('There is no knowledge base');
    expect(t).not.toMatch(/search the knowledge base/i);
    expect(t).toContain('Not documented in the available records.');
    expect(t).not.toMatch(/\{[a-zA-Z]+\}/);
  });
});
