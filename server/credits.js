/**
 * MAIA credits — the mini-payment layer behind the "Deposit or Payment"
 * policy column (Phase 1).
 *
 * Model: 100 credits cost $2 (one credit = 2¢), bought from the HOST admin
 * out-of-band (Stripe Payment Link or equivalent — MAIA never touches card
 * data) and granted manually by the admin. Credits are NON-REFUNDABLE and
 * NON-TRANSFERABLE (they are prepaid service fees, not stored value — the
 * host is not a money transmitter). They exist to cover the host's real
 * hosting + AI costs; any surplus goes to a charity of the admin's choice,
 * which is disclosed to buyers at purchase time.
 *
 * Identity: an account is keyed by the LOWERCASED VERIFIED EMAIL — the same
 * proof the outside-request flow already establishes. No credits without a
 * verified address.
 *
 * Prices (approved): spam-deposit 5 (held; returned on any real answer,
 * FORFEITED if every member silently ignores it until expiry), request
 * evaluation payment 2 (charged at delivery), sharing payment 25 (held;
 * charged only when a member actually accepts, returned otherwise).
 * Advisor questions beyond the free window cost 1 credit each.
 *
 * The ledger is append-only per account (grant/charge/hold/release/
 * capture/forfeit); holds are tracked by an unguessable ref (the request
 * id) and every resolution is idempotent — resolving a ref that no longer
 * has a hold is a no-op, so conflict retries and racing sweeps are safe.
 */

import { createHmac, timingSafeEqual } from 'crypto';

export const CREDITS_DB = 'maia_credits';
const CONFIG_DB = 'maia_config';
const CONFIG_DOC_ID = 'credits_config';

export const CREDIT_PRICES = Object.freeze({
  'spam-deposit': 5,
  'notification-deposit': 2,
  'sharing-payment': 25
});
export const ADVISOR_QUESTION_CREDITS = 1;
export const CREDITS_PER_PURCHASE = 100;
export const PURCHASE_PRICE_USD = 2;
/** 1 credit = 2¢ — the Stripe webhook grants amount_total / 2, so a buyer
 *  who pays for quantity 2 on the Payment Link simply gets 200 credits. */
export const CENTS_PER_CREDIT = 100 * PURCHASE_PRICE_USD / CREDITS_PER_PURCHASE;

const LEDGER_CAP = 300;

const normEmail = (email) => String(email || '').trim().toLowerCase();
const accountId = (email) => `credit_${normEmail(email)}`;

const newAccount = (email) => ({
  _id: accountId(email),
  type: 'credit_account',
  email: normEmail(email),
  balance: 0,
  holds: {}, // ref → { amount, kind, at }
  totals: { granted: 0, charged: 0, captured: 0, forfeited: 0, released: 0 },
  ledger: [],
  createdAt: new Date().toISOString()
});

const pushLedger = (doc, entry) => {
  doc.ledger = [...(doc.ledger || []), { ts: new Date().toISOString(), ...entry }].slice(-LEDGER_CAP);
};

const heldTotal = (doc) => Object.values(doc.holds || {}).reduce((n, h) => n + (h?.amount || 0), 0);

/** Conflict-retried read-modify-write. mutate(doc) returns false to abort
 *  without saving (e.g. insufficient balance). */
async function withAccount(cloudant, email, mutate) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let doc = null;
    try { doc = await cloudant.getDocument(CREDITS_DB, accountId(email)); } catch { /* new account */ }
    if (!doc || doc.type !== 'credit_account') doc = newAccount(email);
    if (mutate(doc) === false) return { ok: false, account: doc };
    doc.updatedAt = new Date().toISOString();
    try {
      await cloudant.saveDocument(CREDITS_DB, doc);
      return { ok: true, account: doc };
    } catch (e) {
      if (e?.statusCode === 409 && attempt < 2) continue;
      throw e;
    }
  }
  return { ok: false, account: null };
}

/** Read-only balance view. Never creates the account. */
export async function getAccount(cloudant, email) {
  let doc = null;
  try { doc = await cloudant.getDocument(CREDITS_DB, accountId(email)); } catch { /* none */ }
  if (!doc || doc.type !== 'credit_account') return { balance: 0, held: 0 };
  return { balance: doc.balance || 0, held: heldTotal(doc) };
}

/** Add purchased credits to an account (admin grant or Stripe webhook).
 *  An optional `ref` makes the grant idempotent: if the ledger already
 *  holds a grant under that ref, nothing is added again — the conflict
 *  retry in withAccount turns racing duplicate deliveries into exactly
 *  one grant. */
export async function grantCredits(cloudant, email, amount, note, ref) {
  const n = Math.floor(Number(amount));
  if (!Number.isFinite(n) || n <= 0) return false;
  const r = await withAccount(cloudant, email, (doc) => {
    if (ref && (doc.ledger || []).some((e) => e.kind === 'grant' && e.ref === ref)) return; // already granted
    doc.balance = (doc.balance || 0) + n;
    doc.totals.granted = (doc.totals.granted || 0) + n;
    pushLedger(doc, {
      kind: 'grant', amount: n,
      ...(ref ? { ref } : {}),
      ...(note ? { note: String(note).slice(0, 200) } : {})
    });
  });
  return r.ok;
}

/** Immediate capture (evaluation payment at delivery, advisor overage).
 *  False when the balance can't cover it. */
export async function chargeCredits(cloudant, email, amount, note) {
  const n = Math.floor(Number(amount));
  if (!Number.isFinite(n) || n <= 0) return false;
  const r = await withAccount(cloudant, email, (doc) => {
    if ((doc.balance || 0) < n) return false;
    doc.balance -= n;
    doc.totals.charged = (doc.totals.charged || 0) + n;
    pushLedger(doc, { kind: 'charge', amount: n, ...(note ? { note: String(note).slice(0, 200) } : {}) });
  });
  return r.ok;
}

/** Escrow: move credits out of the spendable balance under an unguessable
 *  ref (the request id). One hold per ref — a duplicate ref is a no-op
 *  success so racing sends can't double-hold. */
export async function holdCredits(cloudant, email, amount, ref, kind) {
  const n = Math.floor(Number(amount));
  if (!Number.isFinite(n) || n <= 0 || !ref) return false;
  const r = await withAccount(cloudant, email, (doc) => {
    doc.holds = doc.holds || {};
    if (doc.holds[ref]) return; // already held for this request
    if ((doc.balance || 0) < n) return false;
    doc.balance -= n;
    doc.holds[ref] = { amount: n, kind: String(kind || ''), at: new Date().toISOString() };
    pushLedger(doc, { kind: 'hold', amount: n, ref });
  });
  return r.ok;
}

/**
 * Settle a hold: 'release' returns it to the balance; 'capture' (an accept
 * earned it) and 'forfeit' (silently ignored until expiry) keep it out —
 * those credits belong to the host now. Idempotent: no hold under the ref
 * means it was already settled → returns 0.
 */
export async function resolveHold(cloudant, email, ref, resolution) {
  if (!['release', 'capture', 'forfeit'].includes(resolution)) return 0;
  let settled = 0;
  await withAccount(cloudant, email, (doc) => {
    const h = doc.holds?.[ref];
    if (!h) return false; // already settled — nothing to save
    settled = h.amount || 0;
    delete doc.holds[ref];
    if (resolution === 'release') {
      doc.balance = (doc.balance || 0) + settled;
      doc.totals.released = (doc.totals.released || 0) + settled;
    } else if (resolution === 'capture') {
      doc.totals.captured = (doc.totals.captured || 0) + settled;
    } else {
      doc.totals.forfeited = (doc.totals.forfeited || 0) + settled;
    }
    pushLedger(doc, { kind: resolution, amount: settled, ref });
  });
  return settled;
}

/** Host-wide accounting for the admin panel. */
export async function creditsStats(cloudant) {
  let accounts = [];
  try { accounts = (await cloudant.getAllDocuments(CREDITS_DB)) || []; } catch { /* no db yet */ }
  const sum = { accounts: 0, granted: 0, charged: 0, captured: 0, forfeited: 0, released: 0, outstanding: 0, held: 0 };
  for (const a of accounts) {
    if (!a || a.type !== 'credit_account') continue;
    sum.accounts++;
    sum.granted += a.totals?.granted || 0;
    sum.charged += a.totals?.charged || 0;
    sum.captured += a.totals?.captured || 0;
    sum.forfeited += a.totals?.forfeited || 0;
    sum.released += a.totals?.released || 0;
    sum.outstanding += a.balance || 0;
    sum.held += heldTotal(a);
  }
  // Host revenue = everything that permanently left buyer balances.
  sum.earned = sum.charged + sum.captured + sum.forfeited;
  return sum;
}

export async function getCreditsConfig(cloudant) {
  try {
    const doc = await cloudant.getDocument(CONFIG_DB, CONFIG_DOC_ID);
    return {
      purchaseUrl: doc?.purchaseUrl || '',
      charity: doc?.charity || '',
      webhookSecret: doc?.webhookSecret || ''
    };
  } catch {
    return { purchaseUrl: '', charity: '', webhookSecret: '' };
  }
}

/** `webhookSecret` is only overwritten when a non-empty value is supplied —
 *  the admin form sends blank to mean "keep what's stored". */
export async function setCreditsConfig(cloudant, { purchaseUrl, charity, webhookSecret }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let doc = null;
    try { doc = await cloudant.getDocument(CONFIG_DB, CONFIG_DOC_ID); } catch { /* new */ }
    if (!doc) doc = { _id: CONFIG_DOC_ID };
    doc.purchaseUrl = String(purchaseUrl || '').trim().slice(0, 500);
    doc.charity = String(charity || '').trim().slice(0, 300);
    const sec = String(webhookSecret || '').trim();
    if (sec) doc.webhookSecret = sec.slice(0, 200);
    doc.updatedAt = new Date().toISOString();
    try { await cloudant.saveDocument(CONFIG_DB, doc); return true; } catch (e) {
      if (e?.statusCode === 409 && attempt < 2) continue;
      throw e;
    }
  }
  return false;
}

/**
 * Verify a Stripe webhook signature (the `Stripe-Signature` header:
 * `t=<unix>,v1=<hmac>`) against the endpoint's signing secret. The HMAC is
 * computed over `${t}.${rawBody}` — the EXACT bytes Stripe sent, which is
 * why the webhook route needs the raw body preserved. A timestamp outside
 * the tolerance window fails (replay protection), and comparison is
 * timing-safe. No Stripe SDK needed for any of this.
 */
export function verifyStripeSignature(rawBody, sigHeader, secret, toleranceSec = 300) {
  if (!rawBody || !sigHeader || !secret) return false;
  let t = null;
  const v1s = [];
  for (const part of String(sigHeader).split(',')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') v1s.push(v);
  }
  const ts = Number(t);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false;
  const payload = `${t}.${Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody)}`;
  const expected = Buffer.from(createHmac('sha256', secret).update(payload).digest('hex'));
  return v1s.some((sig) => {
    const got = Buffer.from(String(sig));
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

/**
 * Grant credits for a verified `checkout.session.completed` event (Stripe
 * Payment Link purchase). Credits = amount actually paid ÷ 2¢, so quantity
 * purchases just work. Idempotent per Stripe event id — Stripe retries
 * deliveries until it sees a 2xx, and a crash between the marker write and
 * the grant is healed by the retry (the marker only reads `granted: true`
 * after the grant succeeded).
 */
export async function handleStripeCheckoutEvent(cloudant, event) {
  if (event?.type !== 'checkout.session.completed') return { handled: false, reason: 'ignored-event-type' };
  const s = event.data?.object || {};
  if (s.payment_status !== 'paid') return { handled: false, reason: 'not-paid' };
  if (String(s.currency || '').toLowerCase() !== 'usd') return { handled: false, reason: 'not-usd' };
  const email = String(s.customer_details?.email || s.customer_email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { handled: false, reason: 'no-email' };
  const credits = Math.floor(Number(s.amount_total) / CENTS_PER_CREDIT);
  if (!Number.isFinite(credits) || credits <= 0 || credits > 100000) return { handled: false, reason: 'bad-amount' };
  const evtId = String(event.id || '');
  if (!/^evt_[A-Za-z0-9]+$/.test(evtId)) return { handled: false, reason: 'bad-event-id' };

  const markerId = `stripe_${evtId}`;
  let marker = null;
  try { marker = await cloudant.getDocument(CREDITS_DB, markerId); } catch { /* first delivery */ }
  if (marker?.granted) return { handled: true, duplicate: true, credits: 0, email: email.toLowerCase() };
  if (!marker) {
    marker = {
      _id: markerId, type: 'stripe_event', email: email.toLowerCase(),
      credits, sessionId: s.id || null, granted: false, createdAt: new Date().toISOString()
    };
    await cloudant.saveDocument(CREDITS_DB, marker);
  }
  const ok = await grantCredits(cloudant, email, credits, `Stripe purchase ${s.id || evtId}`, evtId);
  if (!ok) return { handled: false, reason: 'grant-failed' };
  marker.granted = true;
  marker.grantedAt = new Date().toISOString();
  try { await cloudant.saveDocument(CREDITS_DB, marker); } catch (e) {
    // Grant landed; a stale marker only risks one extra grant if Stripe
    // retries AND this save raced a concurrent delivery — the initial
    // marker write makes that window effectively unreachable.
    console.warn('[credits] stripe marker update failed:', e?.message || e);
  }
  return { handled: true, credits, email: email.toLowerCase() };
}

/**
 * Routes. The balance GET is gated by the SAME verified-email token the
 * outside-request send uses — knowing a live token for the address is the
 * proof. Admin routes reuse the session gate every other admin endpoint
 * uses (localhost passes for dev).
 */
export function setupCreditRoutes(app, cloudant, { emailTokenVerified }) {
  const requireAdmin = (req, res) => {
    const isLocalhost = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
    if (isLocalhost) return true;
    const sessionUserId = req.session?.userId;
    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    if (!sessionUserId) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return false;
    }
    if (sessionUserId !== adminUsername) {
      res.status(403).json({ success: false, error: 'Access denied. Admin privileges required.' });
      return false;
    }
    return true;
  };

  // Balance + prices + how-to-buy, for the verified visitor. POST so the
  // address and token never appear in a URL (query strings get logged).
  app.post('/api/credits/balance', async (req, res) => {
    try {
      const email = String(req.body?.email || '').trim();
      const token = String(req.body?.token || '');
      if (!email || !token || !emailTokenVerified(token, email)) {
        return res.status(403).json({ success: false, error: 'EMAIL_NOT_VERIFIED' });
      }
      const acct = await getAccount(cloudant, email);
      const config = await getCreditsConfig(cloudant);
      res.json({
        success: true,
        balance: acct.balance,
        held: acct.held,
        prices: CREDIT_PRICES,
        purchase: { credits: CREDITS_PER_PURCHASE, usd: PURCHASE_PRICE_USD },
        purchaseUrl: config.purchaseUrl,
        charity: config.charity
      });
    } catch (error) {
      console.error('[credits] balance failed:', error?.message || error);
      res.status(500).json({ success: false, error: 'Failed to load credits' });
    }
  });

  app.post('/api/admin/credits-grant', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const email = String(req.body?.email || '').trim();
      const credits = Math.floor(Number(req.body?.credits));
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !Number.isFinite(credits) || credits <= 0 || credits > 100000) {
        return res.status(400).json({ success: false, error: 'A valid email and a positive credit amount are required' });
      }
      const ok = await grantCredits(cloudant, email, credits, req.body?.note || 'admin grant');
      if (!ok) return res.status(500).json({ success: false, error: 'Grant failed' });
      const acct = await getAccount(cloudant, email);
      res.json({ success: true, email: normEmail(email), balance: acct.balance });
    } catch (error) {
      console.error('[credits] grant failed:', error?.message || error);
      res.status(500).json({ success: false, error: 'Grant failed' });
    }
  });

  // The signing secret itself never leaves the server — the admin UI only
  // learns whether one is set.
  const publicConfig = (config) => ({
    purchaseUrl: config.purchaseUrl,
    charity: config.charity,
    webhookConfigured: !!config.webhookSecret
  });

  app.get('/api/admin/credits-stats', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const stats = await creditsStats(cloudant);
      const config = await getCreditsConfig(cloudant);
      res.json({
        success: true,
        stats,
        config: publicConfig(config),
        prices: CREDIT_PRICES,
        purchase: { credits: CREDITS_PER_PURCHASE, usd: PURCHASE_PRICE_USD }
      });
    } catch (error) {
      console.error('[credits] stats failed:', error?.message || error);
      res.status(500).json({ success: false, error: 'Failed to load stats' });
    }
  });

  app.post('/api/admin/credits-config', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      await setCreditsConfig(cloudant, {
        purchaseUrl: req.body?.purchaseUrl,
        charity: req.body?.charity,
        webhookSecret: req.body?.webhookSecret // blank keeps the stored one
      });
      res.json({ success: true, config: publicConfig(await getCreditsConfig(cloudant)) });
    } catch (error) {
      console.error('[credits] config failed:', error?.message || error);
      res.status(500).json({ success: false, error: 'Failed to save config' });
    }
  });

  // Stripe webhook: automates the grant the admin previously did by hand.
  // Stripe charges the buyer on its own pages, then calls here with a
  // signed `checkout.session.completed`; a verified signature + the
  // buyer's checkout email are all we need — MAIA still never sees card
  // data. Unconfigured (no signing secret) → 503, so nothing can be
  // granted by unsigned POSTs. Non-2xx makes Stripe retry, so validation
  // failures return errors while ignorable events return 200.
  app.post('/api/stripe/webhook', async (req, res) => {
    try {
      const { webhookSecret } = await getCreditsConfig(cloudant);
      if (!webhookSecret) {
        return res.status(503).json({ received: false, error: 'Webhook not configured' });
      }
      const sig = req.headers?.['stripe-signature'];
      if (!req.rawBody || !verifyStripeSignature(req.rawBody, sig, webhookSecret)) {
        return res.status(400).json({ received: false, error: 'Signature verification failed' });
      }
      const event = JSON.parse(req.rawBody.toString('utf8'));
      const out = await handleStripeCheckoutEvent(cloudant, event);
      if (!out.handled && out.reason === 'grant-failed') {
        // Transient store failure — let Stripe redeliver.
        return res.status(500).json({ received: false, error: 'Grant failed' });
      }
      if (out.credits) {
        console.log(`[credits] Stripe purchase: granted ${out.credits} credits to ${out.email}`);
      }
      res.json({ received: true });
    } catch (error) {
      console.error('[credits] stripe webhook failed:', error?.message || error);
      res.status(500).json({ received: false, error: 'Webhook processing failed' });
    }
  });
}
