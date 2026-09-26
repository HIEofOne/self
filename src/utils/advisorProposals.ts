/**
 * What the private AI proposes, lifted out of its answer (group_requests.md
 * §9, I-27). A feature proposal is a fenced `maia-feature` block:
 *   {"feature":"records-index","reason":"…"}
 * It becomes a card whose description of the feature comes from MAIA's
 * feature registry, never from the AI. Only a feature the patient can turn
 * on, and hasn't, becomes a card. Parsing calls nothing and turns nothing
 * on: that is the patient's click (setFeature).
 */
import type { EditionFeature } from '../composables/useEdition';

export interface FeatureProposal {
  feature: string;
  /** The AI's one sentence, shown as its words — never as what the feature does. */
  reason: string;
  state?: 'idle' | 'busy' | 'on' | 'indexing' | 'indexed' | 'dismissed' | 'error';
  note?: string;
}

export const MAX_REASON = 300;
const FENCE = /```maia-feature\s*\n([\s\S]*?)```/g;

const cleanReason = (s: unknown) => String(s ?? '')
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, MAX_REASON);

/** Take the feature proposals out of an answer. Proposals for a feature the
 *  patient can't turn on, or already has, are dropped with their fence. */
export function extractFeatureProposals(content: string, features: Record<string, EditionFeature>): { proposals: FeatureProposal[]; content: string } {
  const proposals: FeatureProposal[] = [];
  let found = false;
  const text = String(content || '').replace(FENCE, (whole, body: string) => {
    let parsed: { feature?: unknown; reason?: unknown } | null = null;
    try { parsed = JSON.parse(body); } catch { return whole; } // not a proposal: leave it visible
    found = true;
    const key = typeof parsed?.feature === 'string' ? parsed.feature : '';
    const f = features[key];
    if (f && f.available && f.unlockable && !f.enabled && !proposals.some((p) => p.feature === key)) {
      proposals.push({ feature: key, reason: cleanReason(parsed?.reason), state: 'idle' });
    }
    return '';
  });
  return { proposals, content: found ? text.replace(/\n{3,}/g, '\n\n').trim() : content };
}

/** The card's words about the feature: the registry's, exactly. */
export function featureCardText(key: string, features: Record<string, EditionFeature>) {
  const f = features[key];
  return f ? { name: f.name, description: f.description, whatItMeans: f.whatItMeans } : null;
}

/** Turn a feature on or off — only ever called from the patient's click. */
export async function setFeature(userId: string, feature: string, on: boolean, via: 'advisor' | 'settings'): Promise<boolean> {
  const res = await fetch('/api/user-features', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, feature, on, via })
  });
  const d = await res.json().catch(() => ({}));
  return res.ok && d.success === true;
}

// ── Requests to another MAIA (P11, I-33) ─────────────────────────────────
// A fenced `maia-request` block is a DRAFT: a card with what sending
// reveals and a Send button. Parsing sends nothing.

export interface RequestDraft {
  link: string;
  to: string;
  what: string;
  why: string;
  message: string;
  state?: 'idle' | 'busy' | 'sent' | 'discarded' | 'error';
  note?: string;
  verifyUrl?: string | null;
}

export const DRAFT_WHAT = ['patient-summary', 'meds-allergies', 'notification-only', 'not-sensitive', 'everything'];
export const DRAFT_WHY = ['clinical', 'peer-support', 'research', 'public-health', 'marketing'];
const REQUEST_FENCE = /```maia-request\s*\n([\s\S]*?)```/g;

/** A personal request link, as a patient hands it out: https://<host>/r/<32 hex>. */
export function isRequestLink(link: string, { allowLocal = false } = {}): boolean {
  try {
    const u = new URL(String(link || '').trim());
    if (!/^\/r\/[0-9a-f]{32}\/?$/.test(u.pathname) || u.search) return false;
    return u.protocol === 'https:' || (allowLocal && u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname));
  } catch { return false; }
}

const oneLine = (s: unknown, max: number) => cleanReason(s).slice(0, max);

export function extractRequestDrafts(content: string, { allowLocal = false } = {}): { drafts: RequestDraft[]; content: string } {
  const drafts: RequestDraft[] = [];
  let found = false;
  const text = String(content || '').replace(REQUEST_FENCE, (whole, body: string) => {
    let p: Record<string, unknown> | null = null;
    try { p = JSON.parse(body); } catch { return whole; }
    found = true;
    const link = String(p?.link || '').trim();
    if (isRequestLink(link, { allowLocal }) && DRAFT_WHAT.includes(String(p?.what)) && DRAFT_WHY.includes(String(p?.why))) {
      drafts.push({
        link, to: oneLine(p?.to, 60), what: String(p?.what), why: String(p?.why),
        message: String(p?.message ?? '').replace(/\r/g, '').trim().slice(0, 1000), state: 'idle'
      });
    }
    return '';
  });
  return { drafts, content: found ? text.replace(/\n{3,}/g, '\n\n').trim() : content };
}
