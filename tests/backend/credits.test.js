/**
 * Unit tests for the credits ledger (server/credits.js): grant / charge /
 * hold / release / capture / forfeit semantics, idempotency, and the
 * admin stats aggregation. In-memory cloudant fake; no CouchDB needed.
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import {
  grantCredits, chargeCredits, holdCredits, resolveHold,
  getAccount, creditsStats, getCreditsConfig, setCreditsConfig,
  verifyStripeSignature, handleStripeCheckoutEvent,
  CREDIT_PRICES, CREDITS_PER_PURCHASE, PURCHASE_PRICE_USD
} from '../../server/credits.js';

const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));

class FakeCloudant {
  constructor() { this.dbs = new Map(); }
  db(name) { if (!this.dbs.has(name)) this.dbs.set(name, new Map()); return this.dbs.get(name); }
  async getDocument(dbName, id) { return clone(this.db(dbName).get(id) || null); }
  async saveDocument(dbName, doc) { this.db(dbName).set(doc._id, clone(doc)); return { id: doc._id, ok: true }; }
  async getAllDocuments(dbName) { return [...this.db(dbName).values()].map(clone); }
}

describe('credits ledger', () => {
  it('publishes the approved prices: 5/2/25 and 100 credits for $2', () => {
    expect(CREDIT_PRICES['spam-deposit']).toBe(5);
    expect(CREDIT_PRICES['notification-deposit']).toBe(2);
    expect(CREDIT_PRICES['sharing-payment']).toBe(25);
    expect(CREDITS_PER_PURCHASE).toBe(100);
    expect(PURCHASE_PRICE_USD).toBe(2);
  });

  it('grants credits; accounts are keyed by lowercased email', async () => {
    const c = new FakeCloudant();
    expect(await grantCredits(c, 'Buyer@Example.COM', 100, 'purchase')).toBe(true);
    expect((await getAccount(c, 'buyer@example.com')).balance).toBe(100);
    // Bad amounts never mutate anything.
    expect(await grantCredits(c, 'buyer@example.com', 0)).toBe(false);
    expect(await grantCredits(c, 'buyer@example.com', -5)).toBe(false);
    expect((await getAccount(c, 'buyer@example.com')).balance).toBe(100);
  });

  it('charges outright and refuses when the balance cannot cover it', async () => {
    const c = new FakeCloudant();
    await grantCredits(c, 'b@x.com', 3);
    expect(await chargeCredits(c, 'b@x.com', 2, 'evaluation payment')).toBe(true);
    expect((await getAccount(c, 'b@x.com')).balance).toBe(1);
    expect(await chargeCredits(c, 'b@x.com', 2)).toBe(false);
    expect((await getAccount(c, 'b@x.com')).balance).toBe(1);
    // No account at all → refuse, and never create one as a side effect.
    expect(await chargeCredits(c, 'nobody@x.com', 1)).toBe(false);
  });

  it('holds escrow under a ref; duplicate refs and shortfalls are safe', async () => {
    const c = new FakeCloudant();
    await grantCredits(c, 'b@x.com', 10);
    expect(await holdCredits(c, 'b@x.com', 5, 'req1', 'spam-deposit')).toBe(true);
    let a = await getAccount(c, 'b@x.com');
    expect(a.balance).toBe(5);
    expect(a.held).toBe(5);
    // Same ref again (a racing double-send) holds nothing more.
    expect(await holdCredits(c, 'b@x.com', 5, 'req1', 'spam-deposit')).toBe(true);
    a = await getAccount(c, 'b@x.com');
    expect(a.balance).toBe(5);
    expect(a.held).toBe(5);
    // Too big → refused, nothing moves.
    expect(await holdCredits(c, 'b@x.com', 25, 'req2', 'sharing-payment')).toBe(false);
    expect((await getAccount(c, 'b@x.com')).balance).toBe(5);
  });

  it('release returns the hold; capture and forfeit keep it; all idempotent', async () => {
    const c = new FakeCloudant();
    await grantCredits(c, 'b@x.com', 40);
    await holdCredits(c, 'b@x.com', 5, 'r-release', 'spam-deposit');
    await holdCredits(c, 'b@x.com', 25, 'r-capture', 'sharing-payment');
    await holdCredits(c, 'b@x.com', 5, 'r-forfeit', 'spam-deposit');
    expect((await getAccount(c, 'b@x.com')).held).toBe(35);

    expect(await resolveHold(c, 'b@x.com', 'r-release', 'release')).toBe(5);
    expect(await resolveHold(c, 'b@x.com', 'r-capture', 'capture')).toBe(25);
    expect(await resolveHold(c, 'b@x.com', 'r-forfeit', 'forfeit')).toBe(5);

    const a = await getAccount(c, 'b@x.com');
    expect(a.balance).toBe(10); // 40 − 35 held + 5 released
    expect(a.held).toBe(0);

    // Settling an already-settled (or unknown) ref is a no-op.
    expect(await resolveHold(c, 'b@x.com', 'r-release', 'release')).toBe(0);
    expect(await resolveHold(c, 'b@x.com', 'never-held', 'forfeit')).toBe(0);
    expect(await resolveHold(c, 'b@x.com', 'r-capture', 'bogus')).toBe(0);
    expect((await getAccount(c, 'b@x.com')).balance).toBe(10);
  });

  it('stats aggregate across accounts; earned = charged + captured + forfeited', async () => {
    const c = new FakeCloudant();
    await grantCredits(c, 'one@x.com', 100);
    await grantCredits(c, 'two@x.com', 100);
    await chargeCredits(c, 'one@x.com', 2, 'evaluation');
    await holdCredits(c, 'one@x.com', 25, 'ra', 'sharing-payment');
    await resolveHold(c, 'one@x.com', 'ra', 'capture');
    await holdCredits(c, 'two@x.com', 5, 'rb', 'spam-deposit');
    await resolveHold(c, 'two@x.com', 'rb', 'forfeit');
    await holdCredits(c, 'two@x.com', 5, 'rc', 'spam-deposit');

    const s = await creditsStats(c);
    expect(s.accounts).toBe(2);
    expect(s.granted).toBe(200);
    expect(s.charged).toBe(2);
    expect(s.captured).toBe(25);
    expect(s.forfeited).toBe(5);
    expect(s.earned).toBe(32);
    expect(s.held).toBe(5);
    expect(s.outstanding).toBe(100 - 2 - 25 + 100 - 5 - 5);
  });

  it('config round-trips purchase link and charity; blank webhook secret keeps the stored one', async () => {
    const c = new FakeCloudant();
    expect(await getCreditsConfig(c)).toEqual({ purchaseUrl: '', charity: '', webhookSecret: '' });
    await setCreditsConfig(c, { purchaseUrl: 'https://buy.stripe.com/test', charity: 'Médecins Sans Frontières', webhookSecret: 'whsec_abc' });
    expect(await getCreditsConfig(c)).toEqual({
      purchaseUrl: 'https://buy.stripe.com/test',
      charity: 'Médecins Sans Frontières',
      webhookSecret: 'whsec_abc'
    });
    // Re-saving link/charity without a secret must NOT wipe the secret.
    await setCreditsConfig(c, { purchaseUrl: 'https://buy.stripe.com/test2', charity: 'MSF' });
    expect((await getCreditsConfig(c)).webhookSecret).toBe('whsec_abc');
  });
});

describe('Stripe webhook (automatic purchase grants)', () => {
  const SECRET = 'whsec_testsecret';
  const signed = (bodyObj, { secret = SECRET, ts = Math.floor(Date.now() / 1000) } = {}) => {
    const raw = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const sig = createHmac('sha256', secret).update(`${ts}.${raw.toString('utf8')}`).digest('hex');
    return { raw, header: `t=${ts},v1=${sig}` };
  };
  const checkoutEvent = (over = {}, sessionOver = {}) => ({
    id: over.id || `evt_${Math.random().toString(36).slice(2, 12)}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_1', payment_status: 'paid', currency: 'usd', amount_total: 200,
        customer_details: { email: 'Buyer@Example.com' },
        ...sessionOver
      }
    },
    ...over
  });

  it('accepts a genuine signature and rejects tampering, wrong secrets, and stale timestamps', () => {
    const { raw, header } = signed({ hello: 'stripe' });
    expect(verifyStripeSignature(raw, header, SECRET)).toBe(true);
    expect(verifyStripeSignature(Buffer.from('{"hello":"evil"}'), header, SECRET)).toBe(false);
    expect(verifyStripeSignature(raw, header, 'whsec_other')).toBe(false);
    const stale = signed({ hello: 'stripe' }, { ts: Math.floor(Date.now() / 1000) - 3600 });
    expect(verifyStripeSignature(stale.raw, stale.header, SECRET)).toBe(false);
    expect(verifyStripeSignature(raw, 'garbage', SECRET)).toBe(false);
    expect(verifyStripeSignature(raw, header, '')).toBe(false);
  });

  it('a $2 checkout grants 100 credits to the buyer email (lowercased)', async () => {
    const c = new FakeCloudant();
    const out = await handleStripeCheckoutEvent(c, checkoutEvent({ id: 'evt_a1' }));
    expect(out).toMatchObject({ handled: true, credits: 100, email: 'buyer@example.com' });
    expect((await getAccount(c, 'buyer@example.com')).balance).toBe(100);
  });

  it('quantity purchases scale by the amount actually paid (2¢ per credit)', async () => {
    const c = new FakeCloudant();
    await handleStripeCheckoutEvent(c, checkoutEvent({ id: 'evt_q3' }, { amount_total: 600 }));
    expect((await getAccount(c, 'buyer@example.com')).balance).toBe(300);
  });

  it('Stripe redeliveries of the same event never double-grant', async () => {
    const c = new FakeCloudant();
    const evt = checkoutEvent({ id: 'evt_dup' });
    await handleStripeCheckoutEvent(c, evt);
    const again = await handleStripeCheckoutEvent(c, evt);
    expect(again.duplicate).toBe(true);
    expect((await getAccount(c, 'buyer@example.com')).balance).toBe(100);
    // Even with the marker missing (crash before it recorded the grant),
    // the ledger ref makes the grant itself idempotent.
    await grantCredits(c, 'buyer@example.com', 100, 'retry', 'evt_dup');
    expect((await getAccount(c, 'buyer@example.com')).balance).toBe(100);
  });

  it('ignores what it must: other event types, unpaid sessions, non-USD, missing email', async () => {
    const c = new FakeCloudant();
    expect((await handleStripeCheckoutEvent(c, { id: 'evt_x', type: 'invoice.paid', data: { object: {} } })).handled).toBe(false);
    expect((await handleStripeCheckoutEvent(c, checkoutEvent({ id: 'evt_u' }, { payment_status: 'unpaid' }))).handled).toBe(false);
    expect((await handleStripeCheckoutEvent(c, checkoutEvent({ id: 'evt_e' }, { currency: 'eur' }))).handled).toBe(false);
    expect((await handleStripeCheckoutEvent(c, checkoutEvent({ id: 'evt_n' }, { customer_details: {} }))).handled).toBe(false);
    expect((await creditsStats(c)).granted).toBe(0);
  });
});
