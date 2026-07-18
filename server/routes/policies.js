/**
 * Sharing Policies (PR-12; Groups_Design.md Refinement 7).
 *
 * A policy CARD is the canonical, structured object — the plain-language
 * sentence and (later) the Cedar code are projections of it, never
 * independently edited artifacts. Cards live on the userDoc
 * (`sharingPolicies` array); the authorization server consults them when
 * routing incoming requests: an 'allow' match → autonomous, a 'deny'
 * match → silent drop, no match → ASK ME (the Phase-1 escalate-everything
 * behavior, which remains the default mental model: "MAIA asks you about
 * everything unless you've told it otherwise").
 *
 * Enforcement stays deterministic (forbid wins, then allow, else ask) —
 * the Private AI proposes and explains cards but is never in the
 * enforcement path ("AI assists, never grants", Refinement 7a).
 */

const USERS_DB = 'maia_users';
const MAX_POLICIES = 200;

const PURPOSES = ['any', 'clinical', 'research', 'public-health', 'marketing'];
const SCOPES = ['everything', 'not-sensitive', 'past-months', 'apple-health-category', 'meds-allergies', 'patient-summary'];
const SIGNATURES = ['unverified', 'verified-email', 'group-member', 'npi', 'doximity'];
const PAYMENTS = ['none', 'spam-deposit', 'notification-deposit', 'ai-prepay', 'sharing-payment'];
const PARTY_TYPES = ['anyone', 'group', 'peer'];
const OUTCOMES = ['allow', 'deny'];

/** Validate + normalize a card sent by the client. Returns the clean
 *  card or null. Unknown enum values are rejected rather than coerced —
 *  a policy that silently means something else is worse than an error. */
export const normalizeCard = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw.elements || {};
  const party = e.party || {};
  if (!OUTCOMES.includes(raw.outcome)) return null;
  if (!PARTY_TYPES.includes(party.type)) return null;
  if (!PURPOSES.includes(e.purpose)) return null;
  if (!SCOPES.includes(e.scope)) return null;
  if (!SIGNATURES.includes(e.signature)) return null;
  if (!PAYMENTS.includes(e.payment)) return null;
  const card = {
    outcome: raw.outcome,
    enabled: raw.enabled !== false,
    provenance: typeof raw.provenance === 'string' && raw.provenance.startsWith('group:')
      ? raw.provenance.slice(0, 80)
      : 'user',
    elements: {
      party: {
        type: party.type,
        ...(party.type === 'group' ? {
          groupId: String(party.groupId || '').slice(0, 80),
          groupName: String(party.groupName || '').slice(0, 120)
        } : {}),
        ...(party.type === 'peer' ? {
          pairwiseId: String(party.pairwiseId || '').slice(0, 80),
          alias: String(party.alias || '').slice(0, 60)
        } : {})
      },
      purpose: e.purpose,
      scope: e.scope,
      ...(e.scope === 'past-months' ? { scopeMonths: Math.max(1, Math.min(120, parseInt(e.scopeMonths, 10) || 12)) } : {}),
      ...(e.scope === 'apple-health-category' ? { scopeCategory: String(e.scopeCategory || '').slice(0, 80) } : {}),
      filtered: e.filtered !== false, // privacy-filtered response is the safe default
      signature: e.signature,
      payment: e.payment
    },
    ...(raw.createdFrom === 'request' ? { createdFrom: 'request' } : { createdFrom: 'manual' })
  };
  if (card.elements.party.type === 'group' && !card.elements.party.groupId) return null;
  if (card.elements.party.type === 'peer' && !card.elements.party.pairwiseId) return null;
  return card;
};

// ── Server-side projections (PR-13) ────────────────────────────────
// JS ports of src/utils/policyCards.ts `sentenceFor` and `evaluate`.
// The server snapshots the deciding card's sentence onto the request doc
// at decision time (cards can change later; the audit trail must show
// the sentence as it read when it decided).

export const POLICY_SCOPES = SCOPES;
export const POLICY_PURPOSES = PURPOSES;

const SIGNATURE_RANK = { unverified: 0, 'verified-email': 1, 'group-member': 2, npi: 3, doximity: 3 };
const SCOPE_LABELS = {
  everything: 'everything in my record',
  'not-sensitive': 'my record except sensitive categories',
  'meds-allergies': 'Current Medications and Allergies',
  'patient-summary': 'my Patient Summary'
};
const PAYMENT_LABELS = {
  'spam-deposit': 'a returnable spam deposit',
  'notification-deposit': 'a notification deposit',
  'ai-prepay': 'prepayment of AI costs',
  'sharing-payment': 'a sharing payment'
};

export const policySentence = (card) => {
  const e = card.elements;
  const who = e.party.type === 'group' ? `Anyone in ${e.party.groupName || 'the group'}`
    : e.party.type === 'peer' ? (e.party.alias || 'This member') : 'Anyone';
  const sig = e.signature === 'unverified' ? '(no identity check)' : `with ${e.signature} identity or stronger`;
  const verb = card.outcome === 'allow' ? 'may receive' : 'may NOT receive';
  const what = e.scope === 'past-months' ? `records from the past ${e.scopeMonths || 12} months`
    : e.scope === 'apple-health-category' ? `my "${e.scopeCategory || 'selected'}" Apple Health records`
    : (SCOPE_LABELS[e.scope] || e.scope);
  const why = e.purpose === 'any' ? 'for any purpose' : `for ${e.purpose} use`;
  const filt = e.filtered !== false ? 'privacy-filtered' : 'unfiltered';
  const pay = e.payment === 'none' ? '' : `, if they provide ${PAYMENT_LABELS[e.payment] || e.payment}`;
  return `${who} ${sig} ${verb} ${what} ${why}, ${filt}${pay}.`;
};

const cardMatches = (card, req) => {
  const e = card.elements;
  if (e.party.type === 'group' && (req.party.type !== 'group' || req.party.groupId !== e.party.groupId)) return false;
  if (e.party.type === 'peer' && req.party.pairwiseId !== e.party.pairwiseId) return false;
  if (e.purpose !== 'any' && e.purpose !== req.purpose) return false;
  if (e.scope !== req.scope) return false;
  if ((SIGNATURE_RANK[req.signature] ?? 0) < (SIGNATURE_RANK[e.signature] ?? 0)) return false;
  if (e.payment !== 'none' && req.payment !== e.payment) return false;
  return true;
};

/** Deterministic, Cedar-style: enabled DENY wins, then ALLOW, else ASK. */
export const evaluatePolicies = (cards, req) => {
  const active = (cards || []).filter((c) => c && c.enabled !== false);
  const deny = active.find((c) => c.outcome === 'deny' && cardMatches(c, req));
  if (deny) return { outcome: 'deny', decidedBy: deny };
  const allow = active.find((c) => c.outcome === 'allow' && cardMatches(c, req));
  if (allow) return { outcome: 'allow', decidedBy: allow };
  return { outcome: 'ask', decidedBy: null };
};

export default function setupPolicyRoutes(app, cloudant, auditLog) {
  const requireMatchingUser = (req, res) => {
    const userId = req.body?.userId || req.query?.userId;
    if (!userId) {
      res.status(400).json({ success: false, error: 'userId is required' });
      return null;
    }
    const sessionUserId = req.session?.userId;
    if (sessionUserId && sessionUserId !== userId) {
      res.status(403).json({ success: false, error: 'Cannot act for another user' });
      return null;
    }
    return userId;
  };

  // GET /api/user-policies?userId= — all of the user's policy cards.
  app.get('/api/user-policies', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const userDoc = await cloudant.getDocument(USERS_DB, userId);
      if (!userDoc) return res.status(404).json({ success: false, error: 'User not found' });
      res.json({ success: true, policies: userDoc.sharingPolicies || [] });
    } catch (error) {
      console.error('[policies] list failed:', error);
      res.status(500).json({ success: false, error: 'Failed to list policies' });
    }
  });

  // POST /api/user-policies — create a card.
  app.post('/api/user-policies', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const card = normalizeCard(req.body?.policy);
      if (!card) return res.status(400).json({ success: false, error: 'Invalid policy card' });
      const userDoc = await cloudant.getDocument(USERS_DB, userId);
      if (!userDoc) return res.status(404).json({ success: false, error: 'User not found' });
      const policies = userDoc.sharingPolicies || [];
      if (policies.length >= MAX_POLICIES) {
        return res.status(400).json({ success: false, error: `Policy limit reached (${MAX_POLICIES})` });
      }
      const now = new Date().toISOString();
      const stored = { id: `pol_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, ...card, createdAt: now, updatedAt: now };
      userDoc.sharingPolicies = [...policies, stored];
      userDoc.updatedAt = now;
      await cloudant.saveDocument(USERS_DB, userDoc);
      auditLog.logEvent({
        type: 'sharing_policy_created',
        userId,
        ip: req.ip,
        details: { policyId: stored.id, outcome: stored.outcome, createdFrom: stored.createdFrom }
      });
      res.json({ success: true, policy: stored });
    } catch (error) {
      console.error('[policies] create failed:', error);
      res.status(500).json({ success: false, error: 'Failed to create policy' });
    }
  });

  // PUT /api/user-policies/:id — update a card (edit, enable/disable).
  app.put('/api/user-policies/:id', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const card = normalizeCard(req.body?.policy);
      if (!card) return res.status(400).json({ success: false, error: 'Invalid policy card' });
      const userDoc = await cloudant.getDocument(USERS_DB, userId);
      const policies = userDoc?.sharingPolicies || [];
      const idx = policies.findIndex((p) => p.id === req.params.id);
      if (idx === -1) return res.status(404).json({ success: false, error: 'Policy not found' });
      const now = new Date().toISOString();
      policies[idx] = { ...policies[idx], ...card, id: policies[idx].id, createdAt: policies[idx].createdAt, updatedAt: now };
      userDoc.sharingPolicies = policies;
      userDoc.updatedAt = now;
      await cloudant.saveDocument(USERS_DB, userDoc);
      auditLog.logEvent({ type: 'sharing_policy_updated', userId, ip: req.ip, details: { policyId: req.params.id } });
      res.json({ success: true, policy: policies[idx] });
    } catch (error) {
      console.error('[policies] update failed:', error);
      res.status(500).json({ success: false, error: 'Failed to update policy' });
    }
  });

  // DELETE /api/user-policies/:id
  app.delete('/api/user-policies/:id', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const userDoc = await cloudant.getDocument(USERS_DB, userId);
      const policies = userDoc?.sharingPolicies || [];
      const idx = policies.findIndex((p) => p.id === req.params.id);
      if (idx === -1) return res.status(404).json({ success: false, error: 'Policy not found' });
      userDoc.sharingPolicies = policies.filter((p) => p.id !== req.params.id);
      userDoc.updatedAt = new Date().toISOString();
      await cloudant.saveDocument(USERS_DB, userDoc);
      auditLog.logEvent({ type: 'sharing_policy_deleted', userId, ip: req.ip, details: { policyId: req.params.id } });
      res.json({ success: true });
    } catch (error) {
      console.error('[policies] delete failed:', error);
      res.status(500).json({ success: false, error: 'Failed to delete policy' });
    }
  });
}
