/**
 * Finding the Apple Health export in the patient's MAIA folder (Personal AS
 * edition, D11 route 1): the export the patient put there is used without
 * asking them to pick it again, and MAIA's own files are never candidates.
 */
import { describe, it, expect } from 'vitest';
import {
  APPLE_HEALTH_EXPORT_PHRASE, looksLikeAppleHealthText, findAppleHealthExportInFolder
} from '../src/utils/appleHealthFolder';

/** A stand-in folder: `files` maps name → [contents, lastModified]. */
const fakeDir = (files: Record<string, [string, number]>, subdirs: Record<string, FileSystemDirectoryHandle> = {}) => ({
  async *values() {
    for (const [name, [text, lastModified]] of Object.entries(files)) {
      yield { kind: 'file', name, getFile: async () => new File([text], name, { lastModified }) };
    }
    for (const name of Object.keys(subdirs)) yield { kind: 'directory', name };
  },
  async getDirectoryHandle(name: string) {
    if (!subdirs[name]) throw new DOMException('not found', 'NotFoundError');
    return subdirs[name];
  }
}) as unknown as FileSystemDirectoryHandle;

// The detector reads the file's text; the stand-in files carry it directly.
const detect = async (f: Blob) => looksLikeAppleHealthText(await f.text());
const EXPORT_TEXT = `Health Records\n${APPLE_HEALTH_EXPORT_PHRASE.toUpperCase()} reflect all of your care.`;

describe('recognizing the export', () => {
  it('matches the export sentence however the PDF spaced or split it', () => {
    expect(looksLikeAppleHealthText('This summary displays certain health infor- mation made available to you by your health care provider and may not completely')).toBe(true);
    expect(looksLikeAppleHealthText('Visit Summary — Dr. Jane Smith')).toBe(false);
  });
});

describe('finding it in the MAIA folder', () => {
  it('finds the export among other records, newest first', async () => {
    const dir = fakeDir({
      'Labs 2026.pdf': ['Lab results', 3],
      'Health Records.pdf': [EXPORT_TEXT, 2],
      'Old Health Records.pdf': [EXPORT_TEXT, 1]
    });
    const found = await findAppleHealthExportInFolder(dir, detect);
    expect(found).toMatchObject({ name: 'Health Records.pdf', path: '' });
  });

  it('looks in Records/ too, and never at MAIA\'s own PDFs', async () => {
    const records = fakeDir({ 'Export.pdf': [EXPORT_TEXT, 5] });
    const dir = fakeDir({
      'MAIA Patient Summary.pdf': [EXPORT_TEXT, 9], // quotes the sentence, but it's MAIA's own
      'maia-log.pdf': [EXPORT_TEXT, 8],
      'notes.txt': [EXPORT_TEXT, 7]
    }, { Records: records });
    expect(await findAppleHealthExportInFolder(dir, detect)).toMatchObject({ name: 'Export.pdf', path: 'Records/' });
  });

  it('returns nothing when there is no export', async () => {
    expect(await findAppleHealthExportInFolder(fakeDir({ 'Labs.pdf': ['Lab results', 1] }), detect)).toBeNull();
  });
});
