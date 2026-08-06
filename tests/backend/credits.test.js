/**
 * Unit tests for the credits ledger (server/credits.js): grant / charge /
 * hold / release / capture / forfeit semantics, idempotency, and the
 * admin stats aggregation. In-memory cloudant fake; no CouchDB needed.
 */
import { describe, it, expect } from 'vitest';
import {
  grantCredits, chargeCredits, holdCredits, resolveHold,
  getAccount, creditsStats, getCreditsConfig, setCreditsConfig,
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

  it('config round-trips purchase link and charity', async () => {
    const c = new FakeCloudant();
    expect(await getCreditsConfig(c)).toEqual({ purchaseUrl: '', charity: '' });
    await setCreditsConfig(c, { purchaseUrl: 'https://buy.stripe.com/test', charity: 'Médecins Sans Frontières' });
    expect(await getCreditsConfig(c)).toEqual({
      purchaseUrl: 'https://buy.stripe.com/test',
      charity: 'Médecins Sans Frontières'
    });
  });
});
