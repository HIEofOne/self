/**
 * The folder PDFs (Personal AS edition, group_requests.md §7, P7b): what
 * goes into each one, that MAIA's own files are never taken for records,
 * and that the privacy-filtered PDF carries only the filtered text.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  toPdfText, summaryLines, patientSummaryPdf, sharingPoliciesPdf,
  writeSummaryPdfs, writeSharingPoliciesPdf
} from '../src/utils/folderPdfs';
import { MAIA_FOLDER_PDFS, isMaiaGeneratedFile } from '../src/utils/localFolder';
import type { PolicyCard } from '../src/utils/policyCards';

/** The text jsPDF drew (it writes uncompressed "(...) Tj" operators). */
const drawn = (pdf: string): string =>
  [...pdf.matchAll(/\((.*?)\) Tj/g)].map((m) => m[1].replace(/\\([()\\])/g, '$1')).join('\n');

/** A stand-in for the folder the patient granted. */
const fakeFolder = () => {
  const files: Record<string, Blob | string | ArrayBuffer> = {};
  const handle = {
    getFileHandle: async (name: string) => ({
      createWritable: async () => ({
        write: async (c: Blob | string | ArrayBuffer) => { files[name] = c; },
        close: async () => {}
      })
    })
  } as unknown as FileSystemDirectoryHandle;
  const text = async (name: string) => {
    const c = files[name];
    return c instanceof Blob ? drawn(await c.text()) : '';
  };
  return { handle, files, text };
};

const stubFetch = (body: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => body })));

afterEach(() => vi.unstubAllGlobals());

describe("MAIA's own folder files", () => {
  it('are recognized, and a portal\'s "Patient Summary.pdf" is still a record', () => {
    for (const name of [...Object.values(MAIA_FOLDER_PDFS), 'maia-log.pdf', 'maia-state.json', 'maia-pat.webloc', 'MAIA PATIENT SUMMARY.PDF']) {
      expect(isMaiaGeneratedFile(name)).toBe(true);
    }
    for (const name of ['Patient Summary.pdf', 'Sharing Policies.pdf', 'Export.pdf', 'Labs 2026.pdf']) {
      expect(isMaiaGeneratedFile(name)).toBe(false);
    }
  });
});

describe('summary text for the PDF', () => {
  it('maps punctuation the built-in fonts lack, and keeps Latin-1 letters', () => {
    expect(toPdfText('Pat — 5 µg “twice” • ≥ 2 … é')).toBe('Pat - 5 µg "twice" - >= 2 ... é');
    expect(toPdfText('王')).toBe('?');
  });

  it('reads headings, bullets and inline bold', () => {
    const lines = summaryLines('**Pat Doe**, 66, F\n\n**Current Medications**\n- **Lisinopril** 10 mg daily\n  - with food\n\n\n## Allergies\nNone known.');
    expect(lines).toEqual([
      { kind: 'text', text: 'Pat Doe, 66, F' },
      { kind: 'blank', text: '' },
      { kind: 'heading', text: 'Current Medications' },
      { kind: 'bullet', text: 'Lisinopril 10 mg daily', indent: 0 },
      { kind: 'bullet', text: 'with food', indent: 1 },
      { kind: 'blank', text: '' },
      { kind: 'heading', text: 'Allergies' },
      { kind: 'text', text: 'None known.' }
    ]);
  });

  it('is a PDF that says when it was verified', () => {
    const pdf = patientSummaryPdf('**Medical History**\nHypertension.', { verifiedAt: '2026-09-24T15:00:00Z' }).output();
    expect(pdf.startsWith('%PDF-')).toBe(true);
    const t = drawn(pdf);
    expect(t).toContain('Patient Summary');
    expect(t).toContain('Verified by you on Sep 24, 2026.');
    expect(t).toContain('Hypertension.');
  });
});

describe('writing the summary PDFs after Verify', () => {
  const SERVER = {
    summary: '**Pat Doe**, 66, F\n\n**Medical History**\nHypertension, followed by Dr. Jane Smith.',
    verifiedAt: '2026-09-24T15:00:00Z',
    privacyFiltered: {
      text: '**Rowan73 Vance28**, 66, F\n\n**Medical History**\nHypertension, followed by Dr. Kelsey89 Fisher45.',
      mapping: [
        { original: 'Pat Doe', pseudonym: 'Rowan73 Vance28' },
        { original: 'Jane Smith', pseudonym: 'Kelsey89 Fisher45' }
      ]
    }
  };

  it('writes the verified summary and the filtered copy, which never names the patient', async () => {
    stubFetch(SERVER);
    const folder = fakeFolder();
    expect(await writeSummaryPdfs('pat01', { handle: folder.handle })).toBe('written');
    const summary = await folder.text(MAIA_FOLDER_PDFS.summary);
    const filtered = await folder.text(MAIA_FOLDER_PDFS.filtered);
    expect(summary).toContain('Pat Doe, 66, F');
    expect(filtered).toContain('Rowan73 Vance28, 66, F');
    expect(filtered).toContain('Kelsey89 Fisher45');
    for (const real of ['Pat Doe', 'Jane Smith']) expect(filtered).not.toContain(real);
  });

  it('writes nothing for a summary that is not verified', async () => {
    stubFetch({ ...SERVER, verifiedAt: null });
    const folder = fakeFolder();
    expect(await writeSummaryPdfs('pat01', { handle: folder.handle })).toBe('not-verified');
    expect(Object.keys(folder.files)).toEqual([]);
  });

  it('reports a folder write that fails instead of throwing', async () => {
    stubFetch(SERVER);
    const broken = { getFileHandle: async () => { throw new Error('disk full'); } } as unknown as FileSystemDirectoryHandle;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await writeSummaryPdfs('pat01', { handle: broken })).toBe('failed');
    warn.mockRestore();
  });
});

describe('the Sharing Policies PDF', () => {
  const card = (id: string, outcome: PolicyCard['outcome'], over: Partial<PolicyCard> = {}): PolicyCard => ({
    id, outcome, enabled: true, provenance: 'user',
    elements: { party: { type: 'anyone' }, purpose: 'clinical', scope: 'meds-allergies', filtered: true, signature: 'verified-email', payment: 'none' },
    ...over
  } as PolicyCard);
  const CARDS = [
    card('a1', 'allow', { confirmedAt: '2026-09-20T12:00:00Z' }),
    card('d1', 'deny', { confirmedAt: '2026-09-21T12:00:00Z', elements: { party: { type: 'anyone' }, purpose: 'marketing', scope: 'everything', filtered: true, signature: 'unverified', payment: 'none' } }),
    card('s1', 'allow', { provenance: 'group:g1', elements: { party: { type: 'anyone' }, purpose: 'research', scope: 'patient-summary', filtered: true, signature: 'unverified', payment: 'none' } }),
    card('o1', 'ask', { enabled: false, confirmedAt: '2026-09-22T12:00:00Z' })
  ];

  it('lists only the confirmed, turned-on rules, in the order they apply, and says whether sharing is on', () => {
    const t = drawn(sharingPoliciesPdf(CARDS, { asState: 'active', generatedAt: '2026-09-24T12:00:00Z' }).output());
    expect(t).toContain('Sharing is on.');
    expect(t.indexOf('Declined')).toBeGreaterThan(-1);
    expect(t.indexOf('Declined')).toBeLessThan(t.indexOf('Shared automatically'));
    expect(t).toContain('Confirmed Sep 20, 2026');
    expect(t).not.toMatch(/research/i); // the suggested rule waits for confirmation
    expect(t).not.toContain('Needs my approval'); // the only ask rule is turned off
    expect(t).toContain('1 rule is waiting for your confirmation and 1 rule is turned off');
  });

  it('is written under its own name', async () => {
    const folder = fakeFolder();
    expect(await writeSharingPoliciesPdf('pat01', { cards: CARDS, asState: 'paused' }, { handle: folder.handle })).toBe('written');
    expect(await folder.text(MAIA_FOLDER_PDFS.policies)).toContain('Sharing is paused.');
  });
});
