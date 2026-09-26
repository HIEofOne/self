/**
 * New activity on the welcome page's account badges, before sign-in
 * (server/routes/welcome-activity.js). While signed in, this browser keeps
 * a token that reads only the account's counts; the welcome page shows
 * them. Nothing else about the account is readable with it.
 */
export interface ActivityCounts { pendingRequests: number; messageCount: number; documentsToSave: number }

const tokenKey = (userId: string) => `maia.activityToken:${userId}`;
/** Messages already seen in Groups (MyStuffDialog marks them), per account. */
export const seenMessagesKey = (userId: string) => `maia.groupsMessagesSeen:${userId}`;
const LEGACY_SEEN_KEY = 'maia.groupsMessagesSeen';

const ls = {
  get: (k: string) => { try { return window.localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { window.localStorage.setItem(k, v); } catch { /* private window */ } },
  del: (k: string) => { try { window.localStorage.removeItem(k); } catch { /* ignore */ } }
};

/** Signed in: keep this account's activity token on this device. */
export async function rememberActivityToken(userId: string): Promise<void> {
  if (!userId || ls.get(tokenKey(userId))) return;
  try {
    const r = await fetch('/api/welcome-activity/token', { method: 'POST', credentials: 'include' });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.success && d.userId === userId && typeof d.token === 'string') ls.set(tokenKey(userId), d.token);
  } catch { /* the badge just shows no activity */ }
}

export const forgetActivityToken = (userId: string) => { ls.del(tokenKey(userId)); ls.del(seenMessagesKey(userId)); };

export const readSeenMessages = (userId: string): number =>
  parseInt(ls.get(seenMessagesKey(userId)) ?? ls.get(LEGACY_SEEN_KEY) ?? '0', 10) || 0;
export const writeSeenMessages = (userId: string, n: number) => { ls.set(seenMessagesKey(userId), String(n)); ls.set(LEGACY_SEEN_KEY, String(n)); };

/** The counts for an account on the welcome page (null without a token). */
export async function fetchActivity(userId: string): Promise<ActivityCounts | null> {
  const token = ls.get(tokenKey(userId));
  if (!token) return null;
  try {
    const r = await fetch(`/api/welcome-activity?userId=${encodeURIComponent(userId)}`, {
      credentials: 'include', cache: 'no-store', headers: { 'X-Maia-Activity': token }
    });
    if (r.status === 401) { ls.del(tokenKey(userId)); return null; }
    const d = await r.json().catch(() => ({}));
    return r.ok && d.success ? { pendingRequests: d.pendingRequests || 0, messageCount: d.messageCount || 0, documentsToSave: d.documentsToSave || 0 } : null;
  } catch { return null; }
}

/** "2 requests waiting · 1 new message": what the badge says, or ''. */
export function activitySummary(c: ActivityCounts | null, seenMessages: number): { total: number; text: string } {
  if (!c) return { total: 0, text: '' };
  const newMessages = Math.max(0, c.messageCount - seenMessages);
  const parts = [
    c.pendingRequests ? `${c.pendingRequests} request${c.pendingRequests === 1 ? '' : 's'} waiting` : '',
    newMessages ? `${newMessages} new message${newMessages === 1 ? '' : 's'}` : '',
    c.documentsToSave ? `${c.documentsToSave} document${c.documentsToSave === 1 ? '' : 's'} to save` : ''
  ].filter(Boolean);
  return { total: c.pendingRequests + newMessages + c.documentsToSave, text: parts.join(' · ') };
}
