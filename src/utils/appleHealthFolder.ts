/**
 * Find the patient's Apple Health export in their MAIA folder (Personal AS
 * edition, group_requests.md §5 D11 route 1, §7). The folder is where the
 * patient's records live, so the export they put there is the one to use —
 * recognized in the browser, so no other record leaves the computer.
 */
import { isMaiaGeneratedFile } from './localFolder';

/** The sentence on the first page of every Apple Health records PDF — the
 *  same one the server's detection looks for. */
export const APPLE_HEALTH_EXPORT_PHRASE =
  'this summary displays certain health information made available to you by your healthcare provider and may not completely';

// Letters only: PDF text runs split and space words unpredictably.
const letters = (s: string) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const PHRASE_LETTERS = letters(APPLE_HEALTH_EXPORT_PHRASE);

export const looksLikeAppleHealthText = (firstPageText: string): boolean =>
  letters(firstPageText).includes(PHRASE_LETTERS);

/** Read the first page of a PDF in the browser and check for the export
 *  sentence. Any read failure means "not an export". */
export async function isAppleHealthExportFile(file: Blob): Promise<boolean> {
  try {
    const pdfjs = await import('pdfjs-dist');
    if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js';
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    try {
      const page = await doc.getPage(1);
      const content = await page.getTextContent();
      const text = content.items.map((i) => ('str' in i ? i.str : '')).join(' ');
      return looksLikeAppleHealthText(text);
    } finally {
      void doc.destroy();
    }
  } catch {
    return false;
  }
}

export interface FolderExport {
  name: string;
  /** Where it was found, relative to the MAIA folder ("" = the folder itself). */
  path: string;
  file: File;
}

const MAX_PDFS_CHECKED = 40;

async function pdfsIn(dir: FileSystemDirectoryHandle): Promise<File[]> {
  const out: File[] = [];
  for await (const entry of (dir as any).values()) {
    if (entry.kind !== 'file') continue;
    const name = String(entry.name || '');
    if (!/\.pdf$/i.test(name) || name.startsWith('.') || isMaiaGeneratedFile(name)) continue;
    try { out.push(await (entry as FileSystemFileHandle).getFile()); } catch { /* unreadable: skip */ }
  }
  return out.sort((a, b) => b.lastModified - a.lastModified);
}

/** The newest Apple Health export in the folder or its Records/ subfolder
 *  (§7), or null. `detect` is injectable for tests. */
export async function findAppleHealthExportInFolder(
  dir: FileSystemDirectoryHandle,
  detect: (file: Blob) => Promise<boolean> = isAppleHealthExportFile
): Promise<FolderExport | null> {
  const places: Array<{ path: string; files: File[] }> = [{ path: '', files: await pdfsIn(dir) }];
  try {
    const records = await dir.getDirectoryHandle('Records');
    places.push({ path: 'Records/', files: await pdfsIn(records) });
  } catch { /* no Records/ subfolder */ }
  const candidates = places
    .flatMap((p) => p.files.map((file) => ({ path: p.path, file })))
    .sort((a, b) => b.file.lastModified - a.file.lastModified)
    .slice(0, MAX_PDFS_CHECKED);
  for (const c of candidates) {
    if (await detect(c.file)) return { name: c.file.name, path: c.path, file: c.file };
  }
  return null;
}
