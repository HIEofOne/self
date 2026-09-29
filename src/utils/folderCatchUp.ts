/**
 * Changes made where there is no MAIA folder (a phone, or Safari): the
 * folder's PDFs catch up on the computer. A folder-less browser notes on the
 * server what changed (the Patient Summary, the sharing rules); at the next
 * sign-in on the computer the PDFs are rewritten and the note cleared.
 * Documents others sent (Received/) and the request log already catch up
 * there by themselves.
 */
import { isFileSystemAccessSupported } from './localFolder';
import { writeSummaryPdfs, writeSharingPoliciesPdf, type FolderPdfResult } from './folderPdfs';

export type CatchUpWhat = 'summary' | 'rules';

const post = (userId: string, what: CatchUpWhat, done = false) => fetch('/api/setup/folder-catch-up', {
  method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId, what, ...(done ? { done: true } : {}) })
}).then((r) => r.ok).catch(() => false);

/** A folder PDF couldn't be written here: note it when this browser has no folder at all. */
export async function noteFolderCatchUp(userId: string, what: CatchUpWhat, result: FolderPdfResult): Promise<void> {
  if (result === 'no-folder' && !isFileSystemAccessSupported()) await post(userId, what);
}

/** On the computer: rewrite what a folder-less browser changed. */
export async function catchUpFolder(userId: string): Promise<CatchUpWhat[]> {
  if (!isFileSystemAccessSupported()) return [];
  const done: CatchUpWhat[] = [];
  try {
    const s = await (await fetch(`/api/setup-status?userId=${encodeURIComponent(userId)}`, { credentials: 'include' })).json();
    const notes = s?.folderCatchUp || {};
    if (notes.summary) {
      const r = await writeSummaryPdfs(userId);
      if (r === 'written' || r === 'not-verified') { await post(userId, 'summary', true); done.push('summary'); }
    }
    if (notes.rules) {
      const list = await (await fetch(`/api/user-policies?userId=${encodeURIComponent(userId)}`, { credentials: 'include' })).json();
      if (list?.success && (await writeSharingPoliciesPdf(userId, { cards: list.policies || [], asState: list.asState })) === 'written') {
        await post(userId, 'rules', true);
        done.push('rules');
      }
    }
  } catch { /* next sign-in */ }
  return done;
}
