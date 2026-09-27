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
import { reconnectLocalFolder, reconnectLocalFolderWithGesture, getLocalFolderStatus, listFolderFiles, isMaiaGeneratedFile } from './localFolder';

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

export const MAX_RECORD_BYTES = 50 * 1024 * 1024; // the upload route's limit

export interface FolderUpload { found: number; uploaded: number; alreadyInMaia: number; failed: number; tooLarge: number }

/**
 * Upload the folder's record files that MAIA doesn't have yet (by name).
 * `onProgress` hears each file as it goes. → the counts, or why not.
 */
export async function uploadFolderRecords(
  userId: string,
  onProgress: (done: number, total: number, name: string) => void = () => {}
): Promise<FolderUpload | 'no-folder' | 'no-permission' | 'failed'> {
  const folder = (await reconnectLocalFolder(userId)) || (await reconnectLocalFolderWithGesture(userId));
  if (!folder) return (await getLocalFolderStatus(userId)).configured ? 'no-permission' : 'no-folder';
  const r = await fetch(`/api/records/files?userId=${encodeURIComponent(userId)}`, { credentials: 'include', cache: 'no-store' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.success) return 'failed';
  const have = new Set<string>((d.files || []).map((f: { fileName: string }) => f.fileName));
  const records = (await listFolderFiles(folder.handle, { extensions: ['pdf'] })).filter((f) => !isMaiaGeneratedFile(f.name));
  const todo = records.filter((f) => !have.has(f.name));
  const out: FolderUpload = { found: records.length, uploaded: 0, alreadyInMaia: records.length - todo.length, failed: 0, tooLarge: 0 };
  let i = 0;
  for (const entry of todo) {
    onProgress(i++, todo.length, entry.name);
    try {
      const file = await entry.fileHandle.getFile();
      if (file.size > MAX_RECORD_BYTES) { out.tooLarge++; continue; }
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
            fileSize: u.fileInfo.size, fileType: 'pdf', uploadedAt: u.fileInfo.uploadedAt, isAppleHealth: false
          },
          updateInitialFile: false
        })
      });
      if (meta.ok) out.uploaded++; else out.failed++;
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
