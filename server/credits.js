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

/** Admin adds purchased credits to an account. */
export async function grantCredits(cloudant, email, amount, note) {
  const n = Math.floor(Number(amount));
  if (!Number.isFinite(n) || n <= 0) return false;
  const r = await withAccount(cloudant, email, (doc) => {
    doc.balance = (doc.balance || 0) + n;
    doc.totals.granted = (doc.totals.granted || 0) + n;
    pushLedger(doc, { kind: 'grant', amount: n, ...(note ? { note: String(note).slice(0, 200) } : {}) });
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
    return { purchaseUrl: doc?.purchaseUrl || '', charity: doc?.charity || '' };
  } catch {
    return { purchaseUrl: '', charity: '' };
  }
}

export async function setCreditsConfig(cloudant, { purchaseUrl, charity }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let doc = null;
    try { doc = await cloudant.getDocument(CONFIG_DB, CONFIG_DOC_ID); } catch { /* new */ }
    if (!doc) doc = { _id: CONFIG_DOC_ID };
    doc.purchaseUrl = String(purchaseUrl || '').trim().slice(0, 500);
    doc.charity = String(charity || '').trim().slice(0, 300);
    doc.updatedAt = new Date().toISOString();
    try { await cloudant.saveDocument(CONFIG_DB, doc); return true; } catch (e) {
      if (e?.statusCode === 409 && attempt < 2) continue;
      throw e;
    }
  }
  return false;
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

  app.get('/api/admin/credits-stats', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const stats = await creditsStats(cloudant);
      const config = await getCreditsConfig(cloudant);
      res.json({
        success: true,
        stats,
        config,
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
        charity: req.body?.charity
      });
      res.json({ success: true, config: await getCreditsConfig(cloudant) });
    } catch (error) {
      console.error('[credits] config failed:', error?.message || error);
      res.status(500).json({ success: false, error: 'Failed to save config' });
    }
  });
}
