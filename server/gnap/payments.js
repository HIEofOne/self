/**
 * Credits on a direct GNAP request (group_requests.md §10.6, point 2). The
 * requester attaches them on the interaction page, from the balance of the
 * email they verified on this host, and the patient's cards see the payment
 * (`policyRequest.payment`). Prices and settlement are the request form's
 * (credits.js; groups.js settleTallyPayment):
 *   spam-deposit          held; returned on a real answer (shared or
 *                         declined) or a withdrawal; forfeited when the
 *                         request is ignored until it expires.
 *   notification-deposit  charged when attached.
 *   sharing-payment       held; captured when the patient's MAIA shares;
 *                         returned otherwise.
 * Holds are keyed by the grant, and resolveHold is idempotent, so a retry
 * or a racing sweep never settles twice.
 */
import { CREDIT_PRICES, chargeCredits, holdCredits, resolveHold, getAccount } from '../credits.js';
import { GNAP_DB, getDoc, updateDoc } from './store.js';

export const GNAP_PAYMENTS = Object.freeze(Object.keys(CREDIT_PRICES));
export const paymentRef = (grantHandle) => `gnap_${grantHandle}`;

// canceled: the patient changed their request link, which stops the grant.
const SETTLE = {
  'spam-deposit': { accepted: 'release', declined: 'release', withdrawn: 'release', canceled: 'release', expired: 'forfeit' },
  'sharing-payment': { accepted: 'capture', declined: 'release', withdrawn: 'release', canceled: 'release', expired: 'release' }
};
const PAST = { release: 'released', capture: 'captured', forfeit: 'forfeited' };

/** What the requester may attach: prices and their balance here. */
export async function creditsFor(cloudant, email) {
  const acct = email ? await getAccount(cloudant, email) : { balance: 0, held: 0 };
  return { balance: acct.balance, prices: CREDIT_PRICES };
}

/**
 * Attach a payment to a pending grant whose requester verified an email.
 * → { ok: true } | { ok: false, error }
 */
export async function attachPayment(cloudant, grantHandle, type) {
  if (!GNAP_PAYMENTS.includes(type)) return { ok: false, error: 'UNKNOWN_PAYMENT' };
  const grant = await getDoc(cloudant, `gr_${grantHandle}`);
  const email = grant?.requester?.emailVerified ? grant.requester.email : null;
  if (!grant || grant.state !== 'pending' || !email) return { ok: false, error: 'NOT_PAYABLE' };
  if (grant.payment) return { ok: false, error: 'ALREADY_ATTACHED' };
  const amount = CREDIT_PRICES[type];
  const ref = paymentRef(grantHandle);
  const taken = type === 'notification-deposit'
    ? await chargeCredits(cloudant, email, amount, `request evaluation payment (GNAP ${grantHandle})`)
    : await holdCredits(cloudant, email, amount, ref, type);
  if (!taken) return { ok: false, error: 'NOT_ENOUGH_CREDITS' };
  await updateDoc(cloudant, `gr_${grantHandle}`, (g) => {
    const charged = type === 'notification-deposit';
    g.payment = {
      type, email, amount, ref, at: new Date().toISOString(),
      resolved: charged, ...(charged ? { resolution: 'charged' } : {})
    };
    g.policyRequest = { ...g.policyRequest, payment: type };
    return true;
  });
  return { ok: true };
}

/**
 * Settle a grant's held payment for an outcome: accepted, declined,
 * withdrawn, canceled or expired. An ignored request (block, or a deny-silent card)
 * settles only at expiry, like any unanswered one (I-29).
 */
export async function settleGrantPayment(cloudant, grantHandle, outcome) {
  const grant = await getDoc(cloudant, `gr_${grantHandle}`);
  const p = grant?.payment;
  const how = p && !p.resolved ? SETTLE[p.type]?.[outcome] : null;
  if (!how) return null;
  await resolveHold(cloudant, p.email, p.ref, how);
  await updateDoc(cloudant, grant._id, (g) => {
    if (!g.payment || g.payment.resolved) return false;
    g.payment = { ...g.payment, resolved: true, resolution: PAST[how], resolvedAt: new Date().toISOString() };
    return true;
  });
  return PAST[how];
}

/** Daily: settle the payments of grants that expired unanswered. */
export async function sweepExpiredGnapPayments(cloudant, now = Date.now()) {
  let all = [];
  try { all = (await cloudant.getAllDocuments(GNAP_DB)) || []; } catch { return 0; }
  let settled = 0;
  for (const g of all) {
    if (g?.type !== 'gnap_grant' || !g.payment || g.payment.resolved) continue;
    if (Date.parse(g.expiresAt) >= now) continue;
    if (await settleGrantPayment(cloudant, g._id.slice(3), 'expired')) settled++;
  }
  return settled;
}
