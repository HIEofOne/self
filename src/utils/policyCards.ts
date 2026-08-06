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
  /** 'ask' is an EXPLICIT approval requirement: it carves an ask-me-first
   *  exception out of any broader allow (evaluation: deny → ask → allow →
   *  default ask). The default when nothing matches is still ask. */
  outcome: 'allow' | 'deny' | 'ask';
  /** For a DENY card: 'silent' drops the request (default), 'respond'
   *  sends the requester a reason for the decline. Ignored otherwise. */
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

// ── The ONE policy matrix ────────────────────────────────────────────
// Every matrix surface in MAIA (welcome-page request table, welcome policy
// demo, Sharing Policies editor + Try-it, group editor) renders THIS
// definition via PolicyMatrix.vue. The same table appears everywhere —
// contexts only DISABLE cells that don't apply (with the reason in the
// tooltip), so even a visitor browsing the welcome page sees the whole
// vocabulary and learns what each piece means.
//   author   — composing a policy card (patient or group admin)
//   request  — composing a real request (welcome-page visitor)
//   simulate — testing a hypothetical request (Try-it)

export type MatrixContext = 'author' | 'request' | 'simulate';
export type MatrixColKey = 'scope' | 'purpose' | 'signature' | 'payment' | 'action';

export interface MatrixCell {
  v: string;
  label: string;
  sub?: string;
  cls?: string;
  /** Scope cell that carries the Apple Health category picker (author). */
  ah?: boolean;
  /** Teaching tooltip — shown on EVERY cell, in every context. */
  tip: string;
  /** Context → reason this cell is disabled there (appended to the tip). */
  disabledIn?: Partial<Record<MatrixContext, string>>;
}

export interface MatrixColumn {
  key: MatrixColKey;
  head: string;
  headTip: string;
  options: MatrixCell[];
  /** Context → reason the whole column is disabled there. */
  disabledIn?: Partial<Record<MatrixContext, string>>;
}

const REQ_NO_ACTION = 'The patient’s cards choose the action — requesters only ask.';

export const POLICY_MATRIX: MatrixColumn[] = [
  { key: 'scope', head: 'Scope of Request', headTip: 'How much of the record is involved. Broader scopes cover narrower ones: a card for "Everything" also decides a Patient Summary ask.', options: [
    { v: 'notification-only', label: 'Patient notification only', sub: 'reach them, no record data',
      tip: 'The requester only wants to reach the patient. No record data is involved — accepting delivers their message, and the patient chooses whether to reply.' },
    { v: 'meds-allergies', label: 'Current medications',
      tip: 'The verified Current Medications and Allergies list — the small, high-value slice a clinician needs first. Only the privacy-filtered copy ever leaves.' },
    { v: 'patient-summary', label: 'Patient summary',
      tip: 'The verified Patient Summary. What actually leaves is the privacy-filtered copy, with every name replaced by an obviously-fake pseudonym.' },
    { v: 'not-sensitive', label: 'Everything not sensitive',
      tip: 'The record except sensitive categories (mental health, reproductive health, substance use…). Deliberately does NOT include the Patient Summary — a summary can contain sensitive content.' },
    { v: 'everything', label: 'Everything',
      tip: 'The whole record. A card at this scope also covers every narrower ask — Patient Summary, medications — so pair it with a strong identity floor.' },
    { v: 'ah-category', label: 'Apple Health category', ah: true,
      tip: 'One Apple Health category (labs, vitals, immunizations…). A card names the exact category it covers.',
      disabledIn: {
        request: 'An outside requester can’t know which Apple Health categories a record contains — ask for a broader scope instead.'
      } }
  ]},
  { key: 'purpose', head: 'Claimed Purpose', headTip: 'Why the requester says they want it. MAIA can’t verify a purpose — but your cards decide what each claimed purpose is allowed to receive.', options: [
    { v: 'any', label: 'Any purpose',
      tip: 'Card-only: a card "for any purpose" matches every claimed purpose.',
      disabledIn: {
        request: 'A requester claims one concrete purpose — "any purpose" is something only a card says.',
        simulate: 'A simulated request claims one concrete purpose — "any purpose" is something only a card says.'
      } },
    { v: 'peer-support', label: 'Peer support',
      tip: 'Patient-to-patient help inside a group — the reason groups exist.' },
    { v: 'clinical', label: 'Clinical',
      tip: 'Care delivery by a clinician or care team.' },
    { v: 'research', label: 'Research',
      tip: 'Studies and registries. Patients often pair this with a strong identity floor or a payment requirement.' },
    { v: 'public-health', label: 'Public health',
      tip: 'Population-level reporting to health authorities.' },
    { v: 'marketing', label: 'Marketing',
      tip: 'Commercial outreach — the classic reason for a silent-deny card.' }
  ]},
  { key: 'signature', head: 'Signature Strength', headTip: 'How strongly the requester’s identity is PROVED — not claimed. A card states the minimum level it requires; stronger always qualifies.', options: [
    { v: 'unverified', label: 'Unverified', sub: 'no identity check',
      tip: 'No identity proof at all. Whatever the requester typed about themselves is just a claim.' },
    { v: 'verified-email', label: 'Verified email',
      tip: 'The requester proved control of an email address with a one-time code — exactly what this page’s request form does before sending.' },
    { v: 'group-member', label: 'Group member',
      tip: 'A signed membership credential proves they belong to the patient’s group. Members’ MAIAs present this automatically.' },
    { v: 'npi', label: 'NPI verified', sub: 'licensed provider',
      tip: 'A licensed provider verified against the NPI registry. (Verification is not live yet — until it is, such claims evaluate as unverified.)' },
    { v: 'doximity', label: 'Doximity verified', sub: 'verified clinician',
      tip: 'Clinician identity verified through Doximity. (Not live yet — until it is, such claims evaluate as unverified.)' },
    { v: 'verified-by-me', label: 'Verified by me', sub: 'someone you vouched for',
      tip: 'The patient personally vouched for this requester — the strongest level of all.',
      disabledIn: {
        request: 'A first-time visitor can’t have been vouched for by the patient yet.'
      } }
  ]},
  { key: 'payment', head: 'Deposit or Payment', headTip: 'Money as a spam filter and a fairness tool, paid in credits (100 for $2, bought from the host; non-refundable). Credits cover the host’s real hosting and AI costs; any surplus goes to a charity the host names. One payment covers the whole request, however many members it reaches.', options: [
    { v: 'none', label: 'None',
      tip: 'No money involved — the default. A card requiring no payment matches any request, paid or not.' },
    { v: 'spam-deposit', label: 'Spam evaluation deposit', sub: '5 credits, returnable',
      tip: 'A returnable 5-credit deposit that makes bulk spam uneconomical: returned as soon as ANY member answers (accept or decline-with-a-reason), forfeited to the host if everyone silently ignores the request until it expires (30 days).' },
    { v: 'notification-deposit', label: 'Request evaluation payment', sub: '2 credits',
      tip: 'A 2-credit payment for the work of evaluating the request, charged when the request is delivered — not returned.' },
    { v: 'sharing-payment', label: 'Payment for information', sub: '25 credits',
      tip: 'A 25-credit payment for the information itself: held when the request is sent, charged only when a member actually accepts, returned in full if nobody does. (In this phase captured payments support the host; direct patient payouts come later.)' }
  ]},
  { key: 'action', head: 'MAIA Action', headTip: 'What the patient’s MAIA does when a request matches the card. Anything NO card covers always comes to the patient as a question.',
    disabledIn: { request: REQ_NO_ACTION, simulate: 'The action comes out of the evaluation — pick the request, and the cards decide.' },
    options: [
    { v: 'deny-silent', label: 'Deny silently', sub: 'requester hears nothing', cls: 'act-deny',
      tip: 'The request is dropped. The requester never learns it was even seen — the spam answer.' },
    { v: 'deny-respond', label: 'Deny with response', sub: 'a reason for the decline', cls: 'act-deny',
      tip: 'MAIA declines and tells the requester so — but never which card decided.' },
    { v: 'ask', label: 'Ask me first', sub: 'notify me for approval', cls: 'act-ask',
      tip: 'MAIA notifies the patient and waits. This is also the DEFAULT for anything no card covers; as a card, it pins the approval step even where a broader Respond card would otherwise apply.' },
    { v: 'respond', label: 'Respond', sub: 'fulfil the request', cls: 'act-respond',
      tip: 'MAIA answers automatically with the privacy-filtered artifact — even while the patient is offline.' }
  ]}
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
    : card.outcome === 'ask'
      ? 'needs my approval to receive'
      : (card.denyMode === 'respond' ? 'is declined, with a reason, for' : 'is silently denied');
  const what = e.scope === 'notification-only' ? 'a notification (no record data)' : scopePhrase(e);
  const why = e.purpose === 'any' ? 'for any purpose' : `for ${PURPOSE_OPTIONS.find((o) => o.value === e.purpose)?.label} use`;
  const filt = card.outcome === 'allow' ? (e.filtered ? ', privacy-filtered' : ', unfiltered') : '';
  const pay = e.payment === 'none' ? '' : `, if they provide ${paymentPhrase(e.payment)}`;
  return `${who} ${sig} ${verb} ${what} ${why}${filt}${pay}.`;
};

/** Does this card's constraints cover the request? (Card as pattern.) */
/** Scope containment for card matching: which REQUEST scopes a card scope
 *  covers. Everything ⊇ {not-sensitive, patient-summary, meds-allergies};
 *  not-sensitive and patient-summary each cover meds-allergies but NOT each
 *  other (the PS may contain sensitive-category content). */
const SCOPE_COVERS: Record<string, Scope[]> = {
  'everything': ['everything', 'not-sensitive', 'patient-summary', 'meds-allergies'],
  'not-sensitive': ['not-sensitive', 'meds-allergies'],
  'patient-summary': ['patient-summary', 'meds-allergies'],
  'meds-allergies': ['meds-allergies'],
  'notification-only': ['notification-only'],
  'ah-category': ['ah-category']
};

const matches = (card: PolicyCard, req: PolicyRequest): boolean => {
  const e = card.elements;
  // A card imported from a group (provenance 'group:<id>') belongs to THAT
  // group, whatever groupId its elements embed — heals cards imported with a
  // stale id from a recreated group's policy file (trustee-0zujj2 bug).
  const cardGroupId = card.provenance && card.provenance.startsWith('group:')
    ? card.provenance.slice(6)
    : e.party.groupId;
  if (e.party.type === 'group' && (req.party.type !== 'group' || req.party.groupId !== cardGroupId)) return false;
  if (e.party.type === 'peer' && req.party.pairwiseId !== e.party.pairwiseId) return false;
  if (e.purpose !== 'any' && e.purpose !== req.purpose) return false;
  // Scope subsumption (Cedar-style, downward): a card covers a request asking
  // for the SAME scope or a CONTAINED one — "everything" covers a Patient
  // Summary ask; a Patient Summary card covers a meds ask (the PS contains
  // the meds list). Deliberately NOT a naive chain: "not-sensitive" does NOT
  // cover the Patient Summary, because the PS can carry sensitive-category
  // content. notification-only and ah-category stay exact-match.
  // Applies to allow AND deny alike ("deny everything" blocks any data ask).
  if (!(SCOPE_COVERS[e.scope] || [e.scope]).includes(req.scope)) return false;
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

/** Deterministic evaluation, Cedar-style: forbid wins, then an explicit
 *  ASK ("ask me first" — beats permit so it can carve an approval
 *  requirement out of a broader Respond card), then permit, else ASK
 *  (the default). Disabled cards never participate. */
export const evaluate = (cards: PolicyCard[], req: PolicyRequest): PolicyDecision => {
  const active = cards.filter((c) => c.enabled !== false);
  const deny = active.find((c) => c.outcome === 'deny' && matches(c, req));
  if (deny) return { outcome: 'deny', decidedBy: deny, filtered: true };
  const ask = active.find((c) => c.outcome === 'ask' && matches(c, req));
  if (ask) return { outcome: 'ask', decidedBy: ask, filtered: true };
  const allow = active.find((c) => c.outcome === 'allow' && matches(c, req));
  if (allow) return { outcome: 'allow', decidedBy: allow, filtered: allow.elements.filtered };
  return { outcome: 'ask', decidedBy: null, filtered: true };
};
