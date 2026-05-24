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
  extractAllergiesFromAppleHealthMarkdown
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
