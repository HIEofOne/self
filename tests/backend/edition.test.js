/**
 * Editions and the feature registry (server/edition.js; group_requests.md §4).
 * Every behavior test runs under both editions: `full` must stay exactly
 * today's MAIA, and `personal-as` must gate on the server (I-26).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  EDITIONS, FEATURES, FEATURE_MODES, resolveEdition, getEdition, setEditionForTests,
  featureMode, isFeatureEnabled, createRequireFeature
} from '../../server/edition.js';
import setupEditionRoutes from '../../server/routes/edition.js';

const originalEdition = getEdition();
afterAll(() => setEditionForTests(originalEdition));

// group_requests.md §4.2
const CORE = ['account', 'groups-core', 'policies', 'requests', 'summary', 'advisor', 'notifications',
  'gnap', 'documents-in', 'requests-out'];
const UNLOCKABLE = ['records-index', 'lists-full', 'second-ai', 'public-ai', 'saved-chats', 'deep-links',
  'peer-messaging', 'vouch', 'diary', 'references', 'privacy-filter-editor'];
const NEW_REQUEST_PATH = ['gnap', 'documents-in', 'requests-out'];

describe('resolveEdition', () => {
  it('defaults to full', () => {
    expect(resolveEdition(undefined)).toBe('full');
    expect(resolveEdition('')).toBe('full');
  });
  it('accepts the known editions, ignoring case and spaces', () => {
    expect(resolveEdition('personal-as')).toBe('personal-as');
    expect(resolveEdition(' Personal-AS ')).toBe('personal-as');
    expect(resolveEdition('FULL')).toBe('full');
  });
  it('falls back to full for an unknown value', () => {
    expect(resolveEdition('personal')).toBe('full');
  });
});

describe('feature registry', () => {
  it('covers exactly the features of group_requests.md §4.2', () => {
    expect(Object.keys(FEATURES).sort()).toEqual([...CORE, ...UNLOCKABLE, 'legacy-requests'].sort());
  });

  it('gives every feature user-facing text and a valid mode in each edition', () => {
    for (const [key, f] of Object.entries(FEATURES)) {
      expect(f.name, key).toBeTruthy();
      expect(f.description.length, key).toBeGreaterThan(20);
      for (const edition of EDITIONS) expect(FEATURE_MODES, `${key}/${edition}`).toContain(f.modes[edition]);
    }
  });

  it('full: every existing feature is on; only the new request path is off (D14)', () => {
    for (const key of Object.keys(FEATURES)) {
      expect(featureMode(key, 'full'), key).toBe(NEW_REQUEST_PATH.includes(key) ? 'off' : 'on');
    }
  });

  it('personal-as: core on, the rest unlockable, the old request path off', () => {
    for (const key of CORE) expect(featureMode(key, 'personal-as'), key).toBe('on');
    for (const key of UNLOCKABLE) expect(featureMode(key, 'personal-as'), key).toBe('unlockable');
    expect(featureMode('legacy-requests', 'personal-as')).toBe('off');
  });

  it('an unknown feature is off everywhere', () => {
    for (const edition of EDITIONS) expect(isFeatureEnabled('no-such-feature', null, edition)).toBe(false);
  });

  it('unlocking needs a stored enabledAt, and never turns on a feature that is off', () => {
    const unlocked = { features: { vouch: { enabledAt: '2026-09-24T00:00:00Z' }, 'legacy-requests': { enabledAt: '2026-09-24T00:00:00Z' } } };
    expect(isFeatureEnabled('vouch', null, 'personal-as')).toBe(false);
    expect(isFeatureEnabled('vouch', { features: { vouch: {} } }, 'personal-as')).toBe(false);
    expect(isFeatureEnabled('vouch', unlocked, 'personal-as')).toBe(true);
    expect(isFeatureEnabled('legacy-requests', unlocked, 'personal-as')).toBe(false);
  });
});

class FakeCloudant {
  constructor(docs = {}) { this.docs = new Map(Object.entries(docs)); }
  async getDocument(_db, id) { return this.docs.get(id) ?? null; }
}

const UNLOCKED_AT = '2026-09-24T12:00:00Z';
const makeCloudant = () => new FakeCloudant({
  alice01: { _id: 'alice01', userId: 'alice01', features: { 'records-index': { enabledAt: UNLOCKED_AT, via: 'settings' } } },
  bob02: { _id: 'bob02', userId: 'bob02' }
});

// A signed-in user is simulated with the x-test-user header.
const makeApp = (cloudant, gates = {}) => {
  const app = express();
  app.use((req, _res, next) => {
    const user = req.get('x-test-user');
    req.session = user ? { userId: user } : {};
    next();
  });
  setupEditionRoutes(app, cloudant);
  for (const [path, gate] of Object.entries(gates)) app.get(path, gate, (_req, res) => res.json({ success: true }));
  return app;
};

describe.each(EDITIONS)('edition "%s"', (edition) => {
  const full = edition === 'full';
  let cloudant, requireFeature;
  beforeEach(() => {
    setEditionForTests(edition);
    cloudant = makeCloudant();
    requireFeature = createRequireFeature((id) => cloudant.getDocument('maia_users', id));
  });

  it('GET /api/edition answers before sign-in and describes every feature', async () => {
    const res = await request(makeApp(cloudant)).get('/api/edition');
    expect(res.status).toBe(200);
    expect(res.body.edition).toBe(edition);
    expect(Object.keys(res.body.features).sort()).toEqual(Object.keys(FEATURES).sort());
    expect(res.body.features.account).toMatchObject({ available: true, defaultOn: true, enabled: true });
    expect(res.body.features['records-index']).toMatchObject({
      name: FEATURES['records-index'].name,
      available: true,
      defaultOn: full,
      unlockable: !full,
      enabled: full
    });
    expect(res.body.features.gnap.enabled).toBe(!full);
    expect(res.body.features['legacy-requests'].enabled).toBe(full);
  });

  it("GET /api/edition reflects the signed-in user's own unlocks", async () => {
    const app = makeApp(cloudant);
    const alice = await request(app).get('/api/edition').set('x-test-user', 'alice01');
    expect(alice.body.features['records-index'].enabled).toBe(true);
    expect(alice.body.features['second-ai'].enabled).toBe(full);
    const bob = await request(app).get('/api/edition').set('x-test-user', 'bob02');
    expect(bob.body.features['records-index'].enabled).toBe(full);
  });

  it('requireFeature: a core feature passes for anyone', async () => {
    const app = makeApp(cloudant, { '/api/core': requireFeature('account') });
    expect((await request(app).get('/api/core')).status).toBe(200);
  });

  it("requireFeature: an unlockable feature needs the user's own unlock", async () => {
    const app = makeApp(cloudant, { '/api/index': requireFeature('records-index') });
    const anonymous = await request(app).get('/api/index');
    const bob = await request(app).get('/api/index').set('x-test-user', 'bob02');
    const alice = await request(app).get('/api/index').set('x-test-user', 'alice01');
    const aliceByQuery = await request(app).get('/api/index?userId=alice01').set('x-test-user', 'admin');
    expect(anonymous.status).toBe(full ? 200 : 403);
    expect(bob.status).toBe(full ? 200 : 403);
    if (!full) expect(bob.body).toEqual({ success: false, error: 'FEATURE_OFF', feature: 'records-index' });
    expect(alice.status).toBe(200);
    expect(aliceByQuery.status).toBe(200); // judged on the named account's unlocks
  });

  it('requireFeature: a feature that is off stays off, even with a stored unlock', async () => {
    cloudant.docs.get('alice01').features['legacy-requests'] = { enabledAt: UNLOCKED_AT };
    const app = makeApp(cloudant, {
      '/api/legacy': requireFeature('legacy-requests'),
      '/api/gnap': requireFeature('gnap')
    });
    expect((await request(app).get('/api/legacy').set('x-test-user', 'alice01')).status).toBe(full ? 200 : 403);
    expect((await request(app).get('/api/gnap').set('x-test-user', 'alice01')).status).toBe(full ? 403 : 200);
  });

  it('requireFeature fails closed (503) when the account cannot be read', async () => {
    const failing = createRequireFeature(async () => { throw new Error('db down'); });
    const app = makeApp(cloudant, { '/api/index': failing('records-index') });
    const res = await request(app).get('/api/index').set('x-test-user', 'alice01');
    // In `full` the feature is simply on, so no account read is needed.
    expect(res.status).toBe(full ? 200 : 503);
  });
});

describe('requireFeature setup', () => {
  it('rejects an unknown feature key when the route is defined', () => {
    expect(() => createRequireFeature(async () => null)('no-such-feature')).toThrow(/unknown feature/);
  });
});
