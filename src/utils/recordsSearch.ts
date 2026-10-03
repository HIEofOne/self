/**
 * "Search all my records" (feature `records-index`) in the Personal AS
 * edition (group_requests.md §9, P10): once the patient turns it on, the
 * record files in their MAIA folder are uploaded to MAIA (the ones it
 * doesn't have yet), then indexed on the server (the pipeline's
 * index-records step), and the private AI searches them. The index itself
 * is the full edition's, unchanged.
 *
 * Only the folder's own records are uploaded: PDFs at the top of the
 * folder, not the PDFs MAIA writes there, and not Received/ — documents
 * someone else wrote reach the private AI only as labeled, quoted data
 * (I-32), never as search results.
 */
import { fetchPipeline, advancePipeline, type PipelineAdvance } from './pipeline';
import { reconnectLocalFolder, reconnectLocalFolderWithGesture, getLocalFolderStatus, listFolderFiles, isMaiaGeneratedFile, isFileSystemAccessSupported } from './localFolder';
import { isAppleHealthExportFile } from './appleHealthFolder';

export type IndexState = 'no-records' | 'pending' | 'running' | 'done' | 'error' | 'off' | 'unknown'
  | 'uploading' | 'no-folder' | 'no-permission' | 'upload-failed';

export const indexStateOf = (p: PipelineAdvance | null): IndexState => {
  if (!p) return 'unknown';
  const { imported, indexed } = p.pipeline.stages;
  if (imported?.status !== 'done') return 'no-records';
  if (!indexed || indexed.status === 'skipped') return 'off';
  return indexed.status as IndexState;
};

export const recordsIndexState = async (userId: string): Promise<IndexState> => indexStateOf(await fetchPipeline(userId));

/** The index's state plus the indexing job's progress (start, tokens,
 *  files) and the server's estimate of how long it takes. */
export interface IndexProgress {
  state: IndexState; startedAt: string | null; tokens: number; filesIndexed: number;
  filesTotal: number; estimateMinutes: number | null;
  /** Why indexing stopped, as the server recorded it. */
  error?: string | null;
}
export async function recordsIndexProgress(userId: string): Promise<IndexProgress> {
  const p = await fetchPipeline(userId);
  const st = p?.pipeline.stages.indexed;
  return {
    state: indexStateOf(p), startedAt: st?.status === 'running' ? st.at : null, tokens: st?.tokens || 0, filesIndexed: st?.filesIndexed || 0,
    filesTotal: st?.filesTotal || 0, estimateMinutes: st?.estimateMinutes || null,
    error: st?.status === 'error' ? st.error || null : null
  };
}

/**
 * Wait while the records are being indexed (setup's "Index all now"), so the
 * Patient Summary can use the index; `shouldStop` lets the patient write it
 * now instead. → why it stopped waiting.
 */
export async function waitForIndexing(userId: string, opts: {
  onProgress?: (p: IndexProgress) => void;
  shouldStop?: () => boolean;
  intervalMs?: number;
  timeoutMs?: number;
} = {}): Promise<'done' | 'skipped' | 'error' | 'timeout'> {
  const t0 = Date.now();
  const intervalMs = opts.intervalMs ?? 5000;
  const timeoutMs = opts.timeoutMs ?? 60 * 60 * 1000;
  while (Date.now() - t0 < timeoutMs) {
    if (opts.shouldStop?.()) return 'skipped';
    const p = await recordsIndexProgress(userId).catch(() => null);
    if (p) {
      if (p.state !== 'running') return p.state === 'error' ? 'error' : 'done';
      opts.onProgress?.(p);
    }
    // Wake each second so "write it now" takes effect at once.
    for (let waited = 0; waited < intervalMs; waited += 1000) {
      if (opts.shouldStop?.()) return 'skipped';
      await new Promise((res) => setTimeout(res, Math.min(1000, intervalMs)));
    }
  }
  return 'timeout';
}

/** "about 6 minutes", or '' when unknown. */
export const estimateWords = (minutes: number | null | undefined): string => (minutes ? `about ${minutes} minutes` : '');

/** "3m 07s" since `sinceIso`, or '' when unknown. */
export const elapsedWords = (sinceIso: string | null, now = Date.now()): string => {
  const t = sinceIso ? Date.parse(sinceIso) : NaN;
  if (!Number.isFinite(t)) return '';
  const sec = Math.max(0, Math.floor((now - t) / 1000));
  return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
};

/** "Indexing your records: 3m 07s of about 6 minutes · 41,200 tokens · 1 of 5 files indexed" */
export const progressWords = (
  p: Pick<IndexProgress, 'startedAt' | 'tokens' | 'filesIndexed'> & Partial<Pick<IndexProgress, 'filesTotal' | 'estimateMinutes'>>,
  now = Date.now()
): string => {
  const elapsed = elapsedWords(p.startedAt, now);
  const estimate = estimateWords(p.estimateMinutes);
  const parts = [elapsed && estimate ? `${elapsed} of ${estimate}` : elapsed];
  if (p.tokens > 0) parts.push(`${p.tokens.toLocaleString()} tokens`);
  if (p.filesTotal) parts.push(`${p.filesIndexed} of ${p.filesTotal} file${p.filesTotal === 1 ? '' : 's'} indexed`);
  else if (p.filesIndexed > 0) parts.push(`${p.filesIndexed} file${p.filesIndexed === 1 ? '' : 's'} indexed so far`);
  const detail = parts.filter(Boolean).join(' · ');
  return `Indexing your records${detail ? `: ${detail}` : '…'}. You can keep using MAIA.`;
};

export const MAX_RECORD_BYTES = 50 * 1024 * 1024; // the upload route's limit

export interface FolderUpload { found: number; uploaded: number; alreadyInMaia: number; failed: number; tooLarge: number; appleHealth?: string }

/**
 * Upload the folder's record files that MAIA doesn't have yet (by name).
 * `onProgress` hears each file as it goes. With `markAppleHealth`, the
 * first Apple Health export among them is registered as such (when MAIA
 * has none yet), as the Patient Summary's Apple Health route expects.
 * → the counts, or why not.
 */
export async function uploadFolderRecords(
  userId: string,
  onProgress: (done: number, total: number, name: string) => void = () => {},
  opts: { markAppleHealth?: boolean; detect?: (file: Blob) => Promise<boolean> } = {}
): Promise<FolderUpload | 'no-folder' | 'no-permission' | 'failed'> {
  const folder = (await reconnectLocalFolder(userId)) || (await reconnectLocalFolderWithGesture(userId));
  if (!folder) return (await getLocalFolderStatus(userId)).configured ? 'no-permission' : 'no-folder';
  const r = await fetch(`/api/records/files?userId=${encodeURIComponent(userId)}`, { credentials: 'include', cache: 'no-store' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.success) return 'failed';
  const have = new Set<string>((d.files || []).map((f: { fileName: string }) => f.fileName));
  let lookForAppleHealth = !!opts.markAppleHealth && !(d.files || []).some((f: { isAppleHealth?: boolean }) => f.isAppleHealth);
  const detect = opts.detect || isAppleHealthExportFile;
  const records = (await listFolderFiles(folder.handle, { extensions: ['pdf'] })).filter((f) => !isMaiaGeneratedFile(f.name));
  const todo = records.filter((f) => !have.has(f.name));
  const out: FolderUpload = { found: records.length, uploaded: 0, alreadyInMaia: records.length - todo.length, failed: 0, tooLarge: 0 };
  let i = 0;
  for (const entry of todo) {
    onProgress(i++, todo.length, entry.name);
    try {
      const file = await entry.fileHandle.getFile();
      if (file.size > MAX_RECORD_BYTES) { out.tooLarge++; continue; }
      const isAppleHealth = lookForAppleHealth && (await detect(file));
      if (isAppleHealth) lookForAppleHealth = false;
      const form = new FormData();
      form.append('file', file);
      const up = await fetch('/api/files/upload', { method: 'POST', credentials: 'include', body: form });
      const u = await up.json().catch(() => ({}));
      if (!up.ok || !u.fileInfo?.bucketKey) { out.failed++; continue; }
      const meta = await fetch('/api/user-file-metadata', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          fileMetadata: {
            fileName: u.fileInfo.fileName, bucketKey: u.fileInfo.bucketKey, bucketPath: u.fileInfo.userFolder,
            fileSize: u.fileInfo.size, fileType: 'pdf', uploadedAt: u.fileInfo.uploadedAt, isAppleHealth
          },
          updateInitialFile: isAppleHealth
        })
      });
      if (meta.ok) {
        out.uploaded++;
        if (isAppleHealth) out.appleHealth = u.fileInfo.fileName;
      } else out.failed++;
    } catch {
      out.failed++;
    }
  }
  onProgress(todo.length, todo.length, '');
  return out;
}

/** Upload the folder's records MAIA doesn't have yet, then start indexing
 *  (a no-op when there is nothing to do). */
export async function startRecordsIndexing(
  userId: string,
  onProgress?: (done: number, total: number, name: string) => void
): Promise<{ state: IndexState; upload?: FolderUpload }> {
  // A phone or Safari has no folder to upload from: index what MAIA has.
  if (!isFileSystemAccessSupported()) {
    const r = await advancePipeline(userId, 'index-records');
    return { state: r?.next.action === 'indexing-running' ? 'running' : indexStateOf(r) };
  }
  const upload = await uploadFolderRecords(userId, onProgress);
  if (upload === 'no-folder' || upload === 'no-permission') return { state: upload };
  if (upload === 'failed') return { state: 'upload-failed' };
  const r = await advancePipeline(userId, 'index-records');
  if (r?.next.action === 'indexing-running') return { state: 'running', upload };
  return { state: indexStateOf(r), upload };
}

/** "12 record files uploaded from your MAIA folder (3 already in MAIA)." */
export const uploadWords = (u?: FolderUpload) => {
  if (!u) return '';
  const parts = [`${u.uploaded} record file${u.uploaded === 1 ? '' : 's'} uploaded from your MAIA folder`];
  if (u.alreadyInMaia) parts.push(`${u.alreadyInMaia} already in MAIA`);
  if (u.tooLarge) parts.push(`${u.tooLarge} over 50 MB left out`);
  if (u.failed) parts.push(`${u.failed} couldn’t be uploaded`);
  return `${parts[0]}${parts.length > 1 ? ` (${parts.slice(1).join('; ')})` : ''}.`;
};

/** "Indexing stopped: <the reason the server recorded>." */
export const indexErrorWords = (reason?: string | null): string => {
  const r = String(reason || '').replace(/^(Error:\s*)+/i, '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
  if (!r || r === 'error' || r === 'failed') return 'Indexing stopped with an error.';
  return `Indexing stopped: ${r.length > 180 ? `${r.slice(0, 177)}…` : r}.`;
};

export const INDEX_WORDS: Record<IndexState, string> = {
  'no-records': 'There are no record files (PDFs) at the top of your MAIA folder to index.',
  pending: 'Your records aren’t indexed yet.',
  running: 'Indexing your records. This takes a few minutes; you can keep using MAIA.',
  done: 'Your records are indexed: your private AI can search all of them.',
  error: 'Indexing stopped with an error. Try again.',
  uploading: 'Uploading the record files in your MAIA folder…',
  'no-folder': 'Connect your MAIA folder first: its record files are what gets indexed.',
  'no-permission': 'MAIA needs your permission to read your MAIA folder. Try again and allow it.',
  'upload-failed': 'MAIA couldn’t check which records it already has. Try again.',
  off: '',
  unknown: ''
};
