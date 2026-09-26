/**
 * Documents others added, from the server's sealed hold into the patient's
 * folder (group_requests.md §10.12, I-32):
 *   Received/<date> <kind> - <sender>.<ext>
 * The browser opens each sealed box with the folder key, checks it is the
 * document the sender described (SHA-256), writes it, and tells the server,
 * which then deletes the hold. The request log records the delivery
 * (document_received) at its next sync. A Web Lock keeps two tabs from
 * writing the same document twice.
 */
import { reconnectLocalFolder, getLocalFolderStatus } from './localFolder';
import { getFolderPrivateKey } from './folderKey';
import { openSealedBytes, FOLDER_DOCUMENT_INFO, type SealedBox } from '../gnap/sealedBox';

export const RECEIVED_DIR = 'Received';

export const KIND_LABELS: Record<string, string> = {
  'radiology-report': 'Radiology report', 'lab-report': 'Lab report', 'visit-note': 'Visit note',
  'discharge-summary': 'Discharge summary', imaging: 'Image', other: 'Document'
};
const EXT: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'text/plain': 'txt' };

export interface ReceivedDocument {
  id: string;
  kind: string;
  title: string;
  mediaType: string;
  size: number;
  sha256: string;
  receivedAt: string;
  acceptedAt?: string | null;
  sender: { name: string | null; email: string | null; emailVerified: boolean };
}

export type DeliverResult = 'none' | 'delivered' | 'no-folder' | 'no-permission' | 'no-key' | 'failed';

/** Text a sender wrote, made safe as part of a file name: no path
 *  separators or characters a file system refuses, and not too long. */
export const safeNamePart = (s: string, max = 60) => String(s || '')
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, ' ')
  .replace(/^[.\s]+/, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max)
  .trim();

/** "2026-09-24 Radiology report - Dr Jane Smith.pdf", with " (2)"… when taken. */
export function receivedFileName(d: Pick<ReceivedDocument, 'kind' | 'mediaType' | 'receivedAt' | 'sender'>, taken: Set<string>): string {
  const date = String(d.receivedAt || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  const sender = safeNamePart(d.sender?.name || d.sender?.email || '') || 'unknown sender';
  const stem = `${date} ${KIND_LABELS[d.kind] || 'Document'} - ${sender}`;
  const ext = EXT[d.mediaType] || 'bin';
  let name = `${stem}.${ext}`;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem} (${n}).${ext}`;
  return name;
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Open one sealed document (a held one for a preview, or an accepted one). */
export async function openReceived(userId: string, id: string, expectSha256?: string): Promise<Uint8Array> {
  const key = await getFolderPrivateKey(userId);
  if (!key) throw Object.assign(new Error('This browser doesn’t have your folder key.'), { code: 'no-key' });
  const r = await fetch(`/api/received/${encodeURIComponent(id)}/box?userId=${encodeURIComponent(userId)}`, { credentials: 'include', cache: 'no-store' });
  if (!r.ok) throw new Error('The document is no longer waiting.');
  const bytes = await openSealedBytes(key, (await r.json()) as SealedBox, FOLDER_DOCUMENT_INFO);
  if (expectSha256 && hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource)) !== expectSha256) {
    throw new Error('The document doesn’t match what the sender described.');
  }
  return bytes;
}

async function deliverUnlocked(userId: string): Promise<DeliverResult> {
  const list = await fetch(`/api/received?userId=${encodeURIComponent(userId)}`, { credentials: 'include', cache: 'no-store' });
  const data = await list.json().catch(() => ({}));
  if (!list.ok || !data.success) return 'failed';
  const docs: ReceivedDocument[] = data.documents || [];
  if (!docs.length) return 'none';
  const folder = await reconnectLocalFolder(userId);
  if (!folder) return (await getLocalFolderStatus(userId)).configured ? 'no-permission' : 'no-folder';
  if (!(await getFolderPrivateKey(userId))) return 'no-key';
  const dir = await folder.handle.getDirectoryHandle(RECEIVED_DIR, { create: true });
  const taken = new Set<string>();
  for await (const entry of (dir as unknown as { values(): AsyncIterable<{ name: string }> }).values()) taken.add(entry.name.toLowerCase());
  let delivered = 0;
  for (const d of docs) {
    try {
      const bytes = await openReceived(userId, d.id, d.sha256);
      const name = receivedFileName(d, taken);
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(bytes as BufferSource);
      await w.close();
      taken.add(name.toLowerCase());
      const ok = await fetch(`/api/received/${encodeURIComponent(d.id)}/delivered`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, fileName: name })
      });
      if (ok.ok) delivered++;
    } catch (e) {
      console.warn('[received] a document could not be saved yet:', e);
    }
  }
  return delivered ? 'delivered' : 'failed';
}

/** Save every accepted document into Received/ (one tab at a time). */
export async function deliverReceived(userId: string): Promise<DeliverResult> {
  if (!userId) return 'failed';
  try {
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (locks?.request) return (await locks.request(`maia-received:${userId}`, () => deliverUnlocked(userId))) as DeliverResult;
    return await deliverUnlocked(userId);
  } catch {
    return 'failed';
  }
}
