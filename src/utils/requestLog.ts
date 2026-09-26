/**
 * The request log in the patient's MAIA folder (group_requests.md §7, D10):
 *   Requests/requests.jsonl     every request event, one JSON object a line
 *   Requests/Request Log.html   the same, for people, regenerated each sync
 * The server holds the operating copy; this is the durable one. Written while
 * MAIA is open with folder permission (sign-in, and the Requests tab). Events
 * are deduplicated by id, and a Web Lock keeps two tabs from writing at once.
 * No artifact is ever in the log — only who asked, what, why and the outcome.
 * For a document someone added, the log keeps what they described (kind,
 * title, SHA-256) and the file it was saved as in Received/.
 */
import { reconnectLocalFolder, getLocalFolderStatus } from './localFolder';

export interface RequestEvent {
  id: string;
  at: string;
  type: 'received' | 'shared' | 'declined' | 'ignored' | 'withdrawn' | 'stopped' | 'forgotten'
    | 'accepted' | 'document_received' | 'expired';
  requestId: string;
  route: string | null;
  groupName: string | null;
  requester: { name: string | null; email?: string | null; emailVerified?: boolean; member?: boolean };
  what: string;
  why: string;
  message?: string;
  by?: 'rule' | 'you';
  payment?: string;
  document?: { kind: string; title: string; mediaType: string; size: number; sha256: string };
  grant?: string | null;
  fileName?: string | null;
}

export type LogSyncResult = 'written' | 'unchanged' | 'no-folder' | 'no-permission' | 'failed';

export const LOG_DIR = 'Requests';
export const LOG_JSONL = 'requests.jsonl';
export const LOG_HTML = 'Request Log.html';

/** Parse a jsonl file, skipping lines that aren't events. */
export function parseJsonl(text: string): RequestEvent[] {
  const out: RequestEvent[] = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e.id === 'string' && typeof e.at === 'string') out.push(e);
    } catch { /* a torn or foreign line */ }
  }
  return out;
}

/** Merge event lists: one per id (the later copy wins), in time order. */
export function mergeEvents(...lists: RequestEvent[][]): RequestEvent[] {
  const byId = new Map<string, RequestEvent>();
  for (const list of lists) for (const e of list) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

export const toJsonl = (events: RequestEvent[]) => events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const WHAT: Record<string, string> = {
  'notification-only': 'A note that they would like to be in touch', 'meds-allergies': 'Current medications and allergies',
  'patient-summary': 'Patient Summary', 'not-sensitive': 'Record except sensitive categories', everything: 'Whole record', 'ah-category': 'Apple Health data',
  document: 'To add a document'
};
const KIND: Record<string, string> = {
  'radiology-report': 'Radiology report', 'lab-report': 'Lab report', 'visit-note': 'Visit note',
  'discharge-summary': 'Discharge summary', imaging: 'Image', other: 'Document'
};
const OUTCOME: Record<string, (e: RequestEvent) => string> = {
  received: () => 'Received',
  shared: (e) => (e.by === 'rule' ? 'Shared by your rule' : 'Shared by you'),
  declined: (e) => (e.by === 'rule' ? 'Declined by your rule' : 'Declined by you'),
  ignored: () => 'Ignored',
  withdrawn: () => 'Withdrawn by the requester',
  stopped: () => 'Sharing stopped',
  forgotten: () => 'Requester forgotten',
  accepted: (e) => (e.by === 'rule' ? 'Accepted by your rule' : 'Accepted by you'),
  document_received: (e) => `Saved in your folder${e.fileName ? `: Received/${e.fileName}` : ''}`,
  expired: () => 'Deleted after 90 days, never saved'
};
const when = (iso: string) => { try { return new Date(iso).toLocaleString(); } catch { return iso; } };
const who = (e: RequestEvent) => (e.requester.member
  ? `${e.requester.name || 'A member'} (a member of ${e.groupName || 'your group'})`
  : `${e.requester.name || 'Someone'} (${e.requester.emailVerified && e.requester.email ? `email verified: ${e.requester.email}` : 'email not verified'})`);

/** The human-readable log: one row per request, newest first. */
export function renderLogHtml(events: RequestEvent[], generatedAt = new Date().toISOString()): string {
  const byRequest = new Map<string, RequestEvent[]>();
  for (const e of events) byRequest.set(e.requestId, [...(byRequest.get(e.requestId) || []), e]);
  const rows = [...byRequest.values()]
    .map((list) => list.sort((a, b) => a.at.localeCompare(b.at)))
    .sort((a, b) => b[0].at.localeCompare(a[0].at))
    .map((list) => {
      const first = list.find((e) => e.type === 'received') || list[0];
      const via = first.route === 'gnap-group' ? `Through ${first.groupName}` : first.route === 'gnap-direct' ? 'Your request link' : (first.groupName || '');
      return `<tr>
  <td>${esc(when(first.at))}</td>
  <td>${esc(who(first))}<div class="m">${esc(via)}</div></td>
  <td>${esc(WHAT[first.what] || first.what)}${first.document ? `<div>${esc(KIND[first.document.kind] || 'Document')}${first.document.title ? ` “${esc(first.document.title)}”` : ''}</div>` : ''}<div class="m">for ${esc(String(first.why).replace(/-/g, ' '))} use</div></td>
  <td>${list.map((e) => `<div>${esc(OUTCOME[e.type]?.(e) || e.type)} <span class="m">${esc(when(e.at))}</span></div>`).join('')}</td>
  <td>${first.message ? esc(first.message) : ''}</td>
</tr>`;
    }).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MAIA Request Log</title>
<style>
  body { font: 14px/1.45 -apple-system, 'Segoe UI', Roboto, sans-serif; color: #14202b; margin: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; } p { color: #586675; margin: 0 0 16px; }
  table { border-collapse: collapse; width: 100%; } th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-bottom: 1px solid #dde3e9; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: #586675; } .m { color: #586675; font-size: 12px; }
</style></head><body>
<h1>MAIA Request Log</h1>
<p>Every request to your MAIA and what happened to it. Written by MAIA from Requests/requests.jsonl on ${esc(when(generatedAt))}. No health information from your records is in this log; documents others added are saved in Received/.</p>
<table><thead><tr><th>Received</th><th>Who</th><th>What</th><th>What happened</th><th>Their message</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="5">No requests yet.</td></tr>'}
</tbody></table>
</body></html>
`;
}

const readText = async (dir: FileSystemDirectoryHandle, name: string): Promise<string | null> => {
  try { return await (await (await dir.getFileHandle(name)).getFile()).text(); } catch { return null; }
};
const writeText = async (dir: FileSystemDirectoryHandle, name: string, text: string) => {
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(text);
  await w.close();
};

async function syncUnlocked(userId: string): Promise<LogSyncResult> {
  const r = await reconnectLocalFolder(userId);
  if (!r) return (await getLocalFolderStatus(userId)).configured ? 'no-permission' : 'no-folder';
  try {
    const dir = await r.handle.getDirectoryHandle(LOG_DIR, { create: true });
    const existing = parseJsonl((await readText(dir, LOG_JSONL)) || '');
    // Ask for a little before the newest event held: events that share a
    // timestamp are never lost, and duplicates merge away by id.
    const newest = existing.length ? existing[existing.length - 1].at : '';
    const since = newest ? new Date(Date.parse(newest) - 60 * 1000).toISOString() : '';
    const res = await fetch(`/api/requests/log?userId=${encodeURIComponent(userId)}${since ? `&since=${encodeURIComponent(since)}` : ''}`, { credentials: 'include' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) return 'failed';
    const merged = mergeEvents(existing, data.events || []);
    const changed = merged.length !== existing.length || (await readText(dir, LOG_HTML)) === null;
    if (changed) {
      await writeText(dir, LOG_JSONL, toJsonl(merged));
      await writeText(dir, LOG_HTML, renderLogHtml(merged));
    }
    const through = merged.length ? merged[merged.length - 1].at : '';
    if (through) {
      await fetch('/api/requests/log/synced', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, through })
      }).catch(() => {});
    }
    return changed ? 'written' : 'unchanged';
  } catch {
    return 'failed';
  }
}

/** Bring the folder's request log up to date (one tab at a time). */
export async function syncRequestLog(userId: string): Promise<LogSyncResult> {
  if (!userId) return 'failed';
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (locks?.request) return (await locks.request(`maia-request-log:${userId}`, () => syncUnlocked(userId))) as LogSyncResult;
  return syncUnlocked(userId);
}
