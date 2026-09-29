/**
 * Messages between group members, sealed in the browser: each message is
 * sealed to the recipient's message key (the public half of their MAIA
 * folder key) and a copy to the sender's own, so the MAIA hosts and the
 * group relay carry only sealed boxes. Only a browser that holds the
 * folder key (from the MAIA folder) opens them. A member who can't receive
 * a sealed message yet (no message key registered) gets it the old way,
 * sealed by the sender's host to their host's key; the result says so.
 */
import { sealString, openSealedBytes, type SealedBox } from '../gnap/sealedBox';
import { getFolderPrivateKey } from './folderKey';

/** The key label for member messages (domain-separated from documents). */
export const MESSAGE_INFO = 'maia-member-message-v1';

export interface MemberMessage {
  id: string;
  text?: string;
  sealed?: SealedBox;
  broadcast?: boolean;
  /** The message is sealed and this browser has no folder key to open it. */
  locked?: boolean;
  [k: string]: unknown;
}

export const LOCKED_TEXT = '🔒 Locked message. It opens in MAIA on your computer, or here once you unlock it with your passkey.';

const opened = new Map<string, { text: string; broadcast: boolean }>();

/** Fill in the text of sealed messages this browser can open. */
export async function openMessages<T>(userId: string, input: T[]): Promise<T[]> {
  const list = (Array.isArray(input) ? input : []) as unknown as MemberMessage[];
  if (!list.some((m) => m?.sealed)) return input || [];
  const key = await getFolderPrivateKey(userId).catch(() => null);
  const out: MemberMessage[] = [];
  for (const m of list) {
    if (!m?.sealed) { out.push(m); continue; }
    const cached = opened.get(m.id);
    if (cached) { out.push({ ...m, text: cached.text, broadcast: m.broadcast || cached.broadcast }); continue; }
    if (!key) { out.push({ ...m, text: LOCKED_TEXT, locked: true }); continue; }
    try {
      const raw = new TextDecoder().decode(await openSealedBytes(key, m.sealed, MESSAGE_INFO));
      let text = raw;
      let broadcast = !!m.broadcast;
      try {
        const p = JSON.parse(raw);
        if (p && p.maiaType === 'member-message' && typeof p.text === 'string') { text = p.text; broadcast = broadcast || !!p.broadcast; }
      } catch { /* a bare string */ }
      opened.set(m.id, { text, broadcast });
      out.push({ ...m, text, broadcast });
    } catch {
      out.push({ ...m, text: LOCKED_TEXT, locked: true });
    }
  }
  return out as unknown as T[];
}

/** What the sender keeps of a message they sent. */
export interface SentMemberMessage { id: string; toPairwiseId: string; toAlias?: string | null; text: string; sentAt: string; sealed?: SealedBox; hostReadable?: number; recipients?: number }
export interface SendResult { sent: SentMemberMessage; locked: number; hostReadable: number }

/**
 * Seal `text` for `to` (a member's pairwise id, or '@everyone') and send it.
 * Throws with a readable message on failure.
 */
export async function sendMemberMessage(userId: string, groupId: string, to: string, text: string): Promise<SendResult> {
  const q = `userId=${encodeURIComponent(userId)}&groupId=${encodeURIComponent(groupId)}&to=${encodeURIComponent(to)}`;
  const kRes = await fetch(`/api/user-groups/recipient-keys?${q}`, { credentials: 'include' });
  const keys = await kRes.json().catch(() => ({}));
  if (!kRes.ok || !keys.success) throw new Error(keys.error || 'Could not reach the group');
  const broadcast = to === '@everyone';
  const payload = JSON.stringify({ maiaType: 'member-message', text, ...(broadcast ? { broadcast: true } : {}) });
  const boxes: Array<{ toPairwiseId: string; box: SealedBox }> = [];
  const hostFor: string[] = [];
  for (const r of keys.recipients || []) {
    if (r.messagePublicKeyJwk) boxes.push({ toPairwiseId: r.pairwiseId, box: await sealString(r.messagePublicKeyJwk, payload, MESSAGE_INFO) });
    else hostFor.push(r.pairwiseId);
  }
  const selfBox = keys.selfKey ? await sealString(keys.selfKey, payload, MESSAGE_INFO) : null;
  const res = await fetch('/api/user-groups/send-sealed', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId, groupId, toPairwiseId: to, boxes, selfBox,
      ...(hostFor.length ? { hostSeal: { text, for: hostFor } } : {})
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
  if (selfBox && data.sent?.id) opened.set(data.sent.id, { text, broadcast });
  return { sent: { ...data.sent, text }, locked: data.locked || 0, hostReadable: data.hostReadable || 0 };
}
