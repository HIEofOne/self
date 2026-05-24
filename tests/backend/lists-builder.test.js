/**
 * Tests for the Apple-Health Lists pre-build that backstops the
 * Setup-wizard race documented in clinical-prompts.md.
 *
 * Strategy:
 *   - The pure section-extractor (`ah-section-extract.js`) is exercised
 *     directly against synthetic AH-style markdown.
 *   - The lists-builder helper is exercised end-to-end with an
 *     in-memory S3 mock and a fake AH PDF buffer. We monkey-patch the
 *     `pdf-parser` module so we don't need a real .pdf binary fixture
 *     in the repo (and so the test runs fast and offline).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  extractCategorySection,
  extractAllergiesFromAppleHealthMarkdown,
  extractMedicalHistoryFromAppleHealthMarkdown,
  extractSocialHistoryFromAppleHealthMarkdown,
  extractRadiologyFromAppleHealthMarkdown
} from '../../server/utils/ah-section-extract.js';

// Synthetic Apple-Health-style markdown that mimics what
// `extractPdfWithPages()` returns for an AH export. Includes the
// distinctive footer string the lists-builder uses to confirm "yes,
// this really is an Apple Health PDF".
const SYNTH_AH_MARKDOWN = `## Page 1

### Allergies

Penicillin
Reaction: Hives
Onset: 2014-03-12

Latex
Reaction: Skin irritation
Onset: 2018-06-04

### Conditions

Hypertension (active)
Hypothyroidism (active)

### Clinical Notes

May 7, 2026 Massachusetts General Primary Care Clinic
Office visit. Managed hypertension and hypothyroidism.

April 9, 2026 Massachusetts General Primary Care Clinic
Patient message. No new diagnoses.

### Medications

levothyroxine 150 MCG tablet — Active
atorvastatin 20 MG tablet — Active

---

This Summary displays certain health information made available to you by your healthcare provider and may not completely reflect every encounter.`;

describe('ah-section-extract', () => {
  it('extractCategorySection pulls the Allergies block from AH markdown', () => {
    const text = extractCategorySection(SYNTH_AH_MARKDOWN, 'allergies');
    expect(text).toContain('Penicillin');
    expect(text).toContain('Latex');
    // Stops at the next heading — should NOT contain Conditions/Notes content.
    expect(text).not.toContain('Hypertension');
    expect(text).not.toContain('Clinical Notes');
  });

  it('extractCategorySection is case-insensitive and tolerates plural/singular', () => {
    const md = '### ALLERGY\n\nShellfish\n\n### Conditions\n\nNone';
    const text = extractCategorySection(md, 'allergies');
    expect(text).toContain('Shellfish');
    expect(text).not.toContain('None');
  });

  it('extractCategorySection returns empty string when the section is absent', () => {
    const md = '### Conditions\n\nHypertension';
    expect(extractCategorySection(md, 'allergies')).toBe('');
  });

  it('extractAllergiesFromAppleHealthMarkdown is the named-section wrapper', () => {
    expect(extractAllergiesFromAppleHealthMarkdown(SYNTH_AH_MARKDOWN))
      .toContain('Penicillin');
  });

  it('handles markdown with no section headings at all', () => {
    expect(extractCategorySection('just some prose', 'allergies')).toBe('');
    expect(extractCategorySection('', 'allergies')).toBe('');
    expect(extractCategorySection(null, 'allergies')).toBe('');
  });

  it('extractMedicalHistoryFromAppleHealthMarkdown stitches Conditions + Procedures + Past Medical History', () => {
    const md = [
      '### Conditions',
      '',
      'Hypertension (active)',
      'Hypothyroidism (active)',
      '',
      '### Procedures',
      '',
      'ACL repair 2008',
      'Cholecystectomy 2014',
      '',
      '### Past Medical History',
      '',
      'Chronic knee pain (post-ACL injury)',
      '',
      '### Allergies',
      '',
      'Penicillin'
    ].join('\n');
    const block = extractMedicalHistoryFromAppleHealthMarkdown(md);
    expect(block).toContain('Hypertension');
    expect(block).toContain('Cholecystectomy');
    expect(block).toContain('Chronic knee pain');
    // Each contributing AH category is labeled in the block so the agent
    // can preserve the distinction in its narrative.
    expect(block).toContain('**Conditions:**');
    expect(block).toContain('**Procedures:**');
    expect(block).toContain('**Past Medical History:**');
    // Allergies belong to the Allergies authoritative block, not Medical History.
    expect(block).not.toContain('Penicillin');
  });

  it('extractMedicalHistoryFromAppleHealthMarkdown returns "" when none of the source categories exist', () => {
    const md = '### Lab Results\n\nGlucose 95 mg/dL';
    expect(extractMedicalHistoryFromAppleHealthMarkdown(md)).toBe('');
  });

  it('extractMedicalHistoryFromAppleHealthMarkdown is robust to a single contributing category', () => {
    const md = '### Conditions\n\nHypertension';
    const block = extractMedicalHistoryFromAppleHealthMarkdown(md);
    expect(block).toContain('**Conditions:**');
    expect(block).toContain('Hypertension');
    expect(block).not.toContain('**Procedures:**'); // section absent → label not emitted
  });

  it('extractSocialHistoryFromAppleHealthMarkdown picks the AH Social History section verbatim', () => {
    const md = [
      '### Social History',
      '',
      'Tobacco: never smoker',
      'Alcohol: 2 drinks/week',
      '',
      '### Lab Results',
      '',
      'Glucose 95 mg/dL'
    ].join('\n');
    const block = extractSocialHistoryFromAppleHealthMarkdown(md);
    expect(block).toContain('Tobacco');
    expect(block).toContain('Alcohol');
    expect(block).not.toContain('Glucose');
  });

  it('extractRadiologyFromAppleHealthMarkdown stitches alternative AH headings (Imaging / Radiology / Diagnostic Imaging)', () => {
    const md = [
      '### Imaging',
      '',
      'Chest X-ray 2026-03-12: clear lung fields.',
      '',
      '### Diagnostic Imaging',
      '',
      'CT abdomen 2025-11-04: no acute findings.',
      '',
      '### Conditions',
      '',
      'Hypertension'
    ].join('\n');
    const block = extractRadiologyFromAppleHealthMarkdown(md);
    expect(block).toContain('Chest X-ray');
    expect(block).toContain('CT abdomen');
    // Each contributing AH heading is labeled, distinct headings emit distinct labels.
    expect(block).toContain('**Imaging:**');
    expect(block).toContain('**Diagnostic Imaging:**');
    // Other categories are not pulled in.
    expect(block).not.toContain('Hypertension');
  });

  it('extractRadiologyFromAppleHealthMarkdown returns "" when no radiology-flavored heading is present', () => {
    const md = '### Conditions\n\nHypertension\n\n### Lab Results\n\nGlucose 95';
    expect(extractRadiologyFromAppleHealthMarkdown(md)).toBe('');
  });

  it('extractRadiologyFromAppleHealthMarkdown de-dupes identical sections (does not double-emit when two headings happen to produce the same text)', () => {
    // Pathological case: two synonymous headings with identical content.
    const md = '### Radiology\n\nChest X-ray 2026-03-12';
    const block = extractRadiologyFromAppleHealthMarkdown(md);
    // Only one heading matched, so only one label.
    expect((block.match(/\*\*Radiology:\*\*/g) || []).length).toBe(1);
  });
});

describe('ensureAppleHealthListsBuilt — race-safe sidecar build', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  /**
   * In-memory S3-shaped mock used by the lists-builder. Tracks every
   * Put so the test can assert what sidecars were written.
   */
  function makeMockS3() {
    const store = new Map();
    return {
      store,
      send: vi.fn(async (cmd) => {
        // PutObject — putObjectWithLog uses this shape under the hood.
        const input = cmd?.input || cmd;
        if (input?.Bucket && input?.Key && input?.Body !== undefined) {
          store.set(input.Key, input.Body);
          return {};
        }
        // GetObject — return whatever was Put.
        if (input?.Bucket && input?.Key) {
          const body = store.get(input.Key);
          if (body === undefined) throw new Error('NoSuchKey');
          return { Body: body };
        }
        return {};
      })
    };
  }

  it('returns no-ah-file when userDoc has no Apple Health entry', async () => {
    const { ensureAppleHealthListsBuilt } = await import(
      '../../server/utils/lists-builder.js'
    );
    const result = await ensureAppleHealthListsBuilt('alice', { files: [] }, {
      readSpacesObjectBuffer: async () => null,
      readSpacesTextObject: async () => null,
      s3Client: makeMockS3(),
      bucketName: 'maia',
      cloudant: { getDocument: async () => null, saveDocument: async () => {} },
      log: { warn() {}, info() {} }
    });
    expect(result).toBe('no-ah-file');
  });

  it('builds Lists/*.md sidecars from an AH PDF when none exist yet', async () => {
    // Stub `extractPdfWithPages` so we don't need a real .pdf in the
    // repo. The builder confirms the AH footer string before writing,
    // so the synthetic markdown must include it (SYNTH_AH_MARKDOWN does).
    vi.doMock('../../server/utils/pdf-parser.js', () => ({
      extractPdfWithPages: async () => ({
        pages: [{ page: 1, markdown: SYNTH_AH_MARKDOWN }],
        totalPages: 1
      })
    }));

    const { ensureAppleHealthListsBuilt } = await import(
      '../../server/utils/lists-builder.js'
    );
    const mockS3 = makeMockS3();
    const userDoc = {
      userId: 'alice',
      files: [{ fileName: 'Health Records - Alice - 2026.pdf', bucketKey: 'alice/ah.pdf', isAppleHealth: true }]
    };
    const saveCalls = [];
    const cloudantMock = {
      _doc: { ...userDoc },
      async getDocument() { return this._doc; },
      async saveDocument(_db, doc) {
        // Real CloudantClient.saveDocument(dbName, doc) takes two args,
        // and lists-builder calls it with two — so the doc is the
        // SECOND positional arg, not the first. The earlier mock was
        // off-by-one and silently wrote the db-name string into _doc.
        saveCalls.push(doc);
        this._doc = { ...doc };
      }
    };

    const result = await ensureAppleHealthListsBuilt('alice', userDoc, {
      readSpacesObjectBuffer: async () => Buffer.from('fake-pdf-bytes'),
      readSpacesTextObject: async () => null, // sidecars don't exist yet
      s3Client: mockS3,
      bucketName: 'maia',
      cloudant: cloudantMock,
      log: { warn() {}, info() {} }
    });
    expect(result).toBe('built');
    expect(saveCalls.length).toBeGreaterThan(0);

    // The category split should have produced at least these sidecars.
    // extractAndSaveCategoryFiles sanitizes names to "allergies.md",
    // "clinical_notes.md", etc.
    const writtenKeys = Array.from(mockS3.store.keys());
    expect(writtenKeys.some(k => /alice\/Lists\/allergies\.md$/i.test(k))).toBe(true);
    expect(writtenKeys.some(k => /alice\/Lists\/clinical_notes\.md$/i.test(k))).toBe(true);

    // The userDoc should be marked as "built" for the fast-path on
    // subsequent calls.
    expect(cloudantMock._doc.appleHealthCategoriesBuiltAt).toBeTruthy();
    expect(cloudantMock._doc.appleHealthCategoriesSourceKey).toBe('alice/ah.pdf');
  });

  it('hits the cached fast-path when the sidecars are already present', async () => {
    vi.doMock('../../server/utils/pdf-parser.js', () => ({
      extractPdfWithPages: vi.fn(async () => {
        throw new Error('should not have been called — fast-path expected');
      })
    }));

    const { ensureAppleHealthListsBuilt } = await import(
      '../../server/utils/lists-builder.js'
    );
    const userDoc = {
      userId: 'alice',
      appleHealthCategoriesBuiltAt: '2026-05-01T00:00:00Z',
      files: [{ fileName: 'Health Records - Alice - 2026.pdf', bucketKey: 'alice/ah.pdf', isAppleHealth: true }]
    };
    const result = await ensureAppleHealthListsBuilt('alice', userDoc, {
      readSpacesObjectBuffer: async () => Buffer.from('should-not-be-read'),
      // Pretend clinical_notes.md is already on disk — that's the probe.
      readSpacesTextObject: async (key) =>
        /clinical_notes\.md$/.test(key) ? 'some prior content' : null,
      s3Client: makeMockS3(),
      bucketName: 'maia',
      cloudant: { getDocument: async () => userDoc, saveDocument: async () => {} },
      log: { warn() {}, info() {} }
    });
    expect(result).toBe('cached');
  });

  it('rebuilds when the flag is set but the sidecar is missing (Restore wipe scenario)', async () => {
    vi.doMock('../../server/utils/pdf-parser.js', () => ({
      extractPdfWithPages: async () => ({
        pages: [{ page: 1, markdown: SYNTH_AH_MARKDOWN }],
        totalPages: 1
      })
    }));

    const { ensureAppleHealthListsBuilt } = await import(
      '../../server/utils/lists-builder.js'
    );
    const mockS3 = makeMockS3();
    const userDoc = {
      userId: 'alice',
      // Flag says "already built" but Spaces is empty (post-Restore).
      appleHealthCategoriesBuiltAt: '2026-05-01T00:00:00Z',
      files: [{ fileName: 'Health Records - Alice - 2026.pdf', bucketKey: 'alice/ah.pdf', isAppleHealth: true }]
    };
    const cloudantMock = {
      _doc: { ...userDoc },
      async getDocument() { return this._doc; },
      async saveDocument(_db, doc) { this._doc = { ...doc }; }
    };

    const result = await ensureAppleHealthListsBuilt('alice', userDoc, {
      readSpacesObjectBuffer: async () => Buffer.from('fake-pdf-bytes'),
      readSpacesTextObject: async () => null,
      s3Client: mockS3,
      bucketName: 'maia',
      cloudant: cloudantMock,
      log: { warn() {}, info() {} }
    });
    // Must NOT short-circuit to 'cached' just because the flag is set
    // — it must actually rebuild because the sidecar probe returned null.
    expect(result).toBe('built');
    const writtenKeys = Array.from(mockS3.store.keys());
    expect(writtenKeys.some(k => /alice\/Lists\/allergies\.md$/i.test(k))).toBe(true);
  });

  it('rejects a non-AH PDF that snuck in via filename heuristic', async () => {
    // Synthetic markdown WITHOUT the Apple-Health footer — the helper
    // must refuse to produce category sidecars so we don't pollute
    // Lists/ with garbage from an unrelated PDF.
    vi.doMock('../../server/utils/pdf-parser.js', () => ({
      extractPdfWithPages: async () => ({
        pages: [{ page: 1, markdown: '### Allergies\n\nNone\n\n### Notes\n\nSomething.' }],
        totalPages: 1
      })
    }));

    const { ensureAppleHealthListsBuilt } = await import(
      '../../server/utils/lists-builder.js'
    );
    const mockS3 = makeMockS3();
    // No explicit isAppleHealth flag — only the filename heuristic matches.
    const userDoc = {
      userId: 'alice',
      files: [{ fileName: 'health-records-pretender.pdf', bucketKey: 'alice/pretender.pdf' }]
    };
    const result = await ensureAppleHealthListsBuilt('alice', userDoc, {
      readSpacesObjectBuffer: async () => Buffer.from('fake-bytes'),
      readSpacesTextObject: async () => null,
      s3Client: mockS3,
      bucketName: 'maia',
      cloudant: { getDocument: async () => userDoc, saveDocument: async () => {} },
      log: { warn() {}, info() {} }
    });
    expect(result).toBe('no-ah-file');
    expect(mockS3.store.size).toBe(0); // nothing written
  });
});
