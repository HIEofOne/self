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
