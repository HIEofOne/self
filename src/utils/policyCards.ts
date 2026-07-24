/**
 * Sharing-policy cards (Groups_Design.md Refinement 7).
 *
 * The STRUCTURE is canonical. The plain-language sentence rendered here is
 * a deterministic projection of it (the "Mad-Libs" view), and the Cedar
 * code (later phase) is another. The Private AI may help fill the slots,
 * but what it produces is always a structured card the user confirms.
 *
 * Evaluation semantics mirror Cedar's: an enabled DENY match wins over
 * everything; otherwise an enabled ALLOW match permits; otherwise the
 * outcome is ASK — "MAIA asks you about everything unless you've told it
 * otherwise."
 */

export type PartyType = 'anyone' | 'group' | 'peer';
export type Purpose = 'any' | 'peer-support' | 'clinical' | 'research' | 'public-health' | 'marketing';
export type Scope = 'notification-only' | 'meds-allergies' | 'patient-summary' | 'not-sensitive' | 'everything' | 'ah-category';
export type Signature = 'unverified' | 'verified-email' | 'group-member' | 'npi' | 'doximity' | 'verified-by-me';
export type Payment = 'none' | 'spam-deposit' | 'notification-deposit' | 'ai-prepay' | 'sharing-payment';

export interface PolicyElements {
  party: { type: PartyType; groupId?: string; groupName?: string; pairwiseId?: string; alias?: string };
  purpose: Purpose;
  scope: Scope;
  ahCategory?: string; // which Apple Health category, when scope === 'ah-category'
  filtered: boolean;
  signature: Signature; // MINIMUM identity level the requester must present
  payment: Payment;
}

export interface PolicyCard {
  id: string;
  outcome: 'allow' | 'deny';
  /** For a DENY card: 'silent' drops the request (default), 'respond'
   *  sends the requester a reason for the decline. Ignored for allow. */
  denyMode?: 'silent' | 'respond';
  enabled: boolean;
  provenance: string; // 'user' | 'group:<groupId>'
  elements: PolicyElements;
  createdFrom?: 'manual' | 'request';
  createdAt?: string;
  updatedAt?: string;
}

/** A hypothetical (simulator) or real incoming request, reduced to the
 *  attributes policies can see. */
export interface PolicyRequest {
  party: { type: PartyType; groupId?: string; pairwiseId?: string };
  purpose: Purpose;
  scope: Scope;
  ahCategory?: string;  // which Apple Health category, when scope === 'ah-category'
  signature: Signature; // level the requester actually presents
  payment: Payment;     // what the requester actually offers
}

export const PURPOSE_OPTIONS: Array<{ value: Purpose; label: string }> = [
  { value: 'any', label: 'Any Purpose' },
  { value: 'peer-support', label: 'Peer Support' },
  { value: 'clinical', label: 'Clinical' },
  { value: 'research', label: 'Research' },
  { value: 'public-health', label: 'Public Health' },
  { value: 'marketing', label: 'Marketing' }
];

export const SCOPE_OPTIONS: Array<{ value: Scope; label: string }> = [
  { value: 'notification-only', label: 'Patient notification only' },
  { value: 'meds-allergies', label: 'Current Medications and Allergies' },
  { value: 'patient-summary', label: 'Patient Summary' },
  { value: 'not-sensitive', label: 'My record except sensitive categories' },
  { value: 'everything', label: 'Everything in my record' },
  { value: 'ah-category', label: 'An Apple Health category' }
];

/** Sentence-friendly scope phrases (select labels are Title-case;
 *  sentences need "my Patient Summary", "everything in my record").
 *  'ah-category' is filled with the chosen category by scopeSentence(). */
const SCOPE_SENTENCES: Record<Scope, string> = {
  'notification-only': 'a notification only (no record data)',
  'meds-allergies': 'Current Medications and Allergies',
  'patient-summary': 'my Patient Summary',
  'not-sensitive': 'my record except sensitive categories',
  everything: 'everything in my record',
  'ah-category': 'a category of my Apple Health data'
};

export const SIGNATURE_OPTIONS: Array<{ value: Signature; label: string }> = [
  { value: 'unverified', label: 'unverified' },
  { value: 'verified-email', label: 'verified-email' },
  { value: 'group-member', label: 'group-member' },
  { value: 'npi', label: 'NPI-verified' },
  { value: 'doximity', label: 'Doximity-verified' },
  { value: 'verified-by-me', label: 'verified by me' }
];

export const PAYMENT_OPTIONS: Array<{ value: Payment; label: string }> = [
  { value: 'none', label: 'no payment' },
  { value: 'spam-deposit', label: 'a returnable spam deposit' },
  { value: 'notification-deposit', label: 'a notification deposit' },
  { value: 'ai-prepay', label: 'prepayment of AI costs' },
  { value: 'sharing-payment', label: 'a sharing payment' }
];

/** Identity strength ladder for "minimum level" comparisons. NPI and
 *  Doximity are treated as equally strong professional verification. */
const SIGNATURE_RANK: Record<Signature, number> = {
  unverified: 0,
  'verified-email': 1,
  'group-member': 2,
  npi: 3,
  doximity: 3,
  'verified-by-me': 4 // strongest: the patient personally vouched for them
};

const partyPhrase = (e: PolicyElements): string => {
  if (e.party.type === 'group') return `Anyone in ${e.party.groupName || 'the group'}`;
  if (e.party.type === 'peer') return e.party.alias || 'This member';
  return 'Anyone';
};

const scopePhrase = (e: PolicyElements): string =>
  e.scope === 'ah-category'
    ? `my ${e.ahCategory || 'Apple Health'} data`
    : (SCOPE_SENTENCES[e.scope] || e.scope);

const paymentPhrase = (p: Payment): string =>
  PAYMENT_OPTIONS.find((o) => o.value === p)?.label || p;

/** The deterministic plain-language projection of a card. */
export const sentenceFor = (card: PolicyCard): string => {
  const e = card.elements;
  const who = partyPhrase(e);
  const sig = e.signature === 'unverified'
    ? '(no identity check)'
    : `with ${SIGNATURE_OPTIONS.find((o) => o.value === e.signature)?.label} identity or stronger`;
  const verb = card.outcome === 'allow'
    ? 'may receive'
    : (card.denyMode === 'respond' ? 'is declined, with a reason, for' : 'is silently denied');
  const what = e.scope === 'notification-only' ? 'a notification (no record data)' : scopePhrase(e);
  const why = e.purpose === 'any' ? 'for any purpose' : `for ${PURPOSE_OPTIONS.find((o) => o.value === e.purpose)?.label} use`;
  const filt = card.outcome === 'allow' ? (e.filtered ? ', privacy-filtered' : ', unfiltered') : '';
  const pay = e.payment === 'none' ? '' : `, if they provide ${paymentPhrase(e.payment)}`;
  return `${who} ${sig} ${verb} ${what} ${why}${filt}${pay}.`;
};

/** Does this card's constraints cover the request? (Card as pattern.) */
const matches = (card: PolicyCard, req: PolicyRequest): boolean => {
  const e = card.elements;
  if (e.party.type === 'group' && (req.party.type !== 'group' || req.party.groupId !== e.party.groupId)) return false;
  if (e.party.type === 'peer' && req.party.pairwiseId !== e.party.pairwiseId) return false;
  if (e.purpose !== 'any' && e.purpose !== req.purpose) return false;
  // Scope: the card covers the request only if it grants the SAME scope.
  // (Scope-subsumption — "everything covers patient-summary" — is a Cedar-
  // phase refinement; exact match keeps v1 predictable.)
  if (e.scope !== req.scope) return false;
  // Apple Health category: a category-specific card only covers a request
  // for that same category (when both name one).
  if (e.scope === 'ah-category' && e.ahCategory && req.ahCategory && e.ahCategory !== req.ahCategory) return false;
  if (SIGNATURE_RANK[req.signature] < SIGNATURE_RANK[e.signature]) return false;
  if (e.payment !== 'none' && req.payment !== e.payment) return false;
  return true;
};

export interface PolicyDecision {
  outcome: 'allow' | 'deny' | 'ask';
  decidedBy: PolicyCard | null;
  filtered: boolean;
}

/** Deterministic evaluation, Cedar-style: forbid wins, then permit,
 *  else ASK (the default). Disabled cards never participate. */
export const evaluate = (cards: PolicyCard[], req: PolicyRequest): PolicyDecision => {
  const active = cards.filter((c) => c.enabled !== false);
  const deny = active.find((c) => c.outcome === 'deny' && matches(c, req));
  if (deny) return { outcome: 'deny', decidedBy: deny, filtered: true };
  const allow = active.find((c) => c.outcome === 'allow' && matches(c, req));
  if (allow) return { outcome: 'allow', decidedBy: allow, filtered: allow.elements.filtered };
  return { outcome: 'ask', decidedBy: null, filtered: true };
};
