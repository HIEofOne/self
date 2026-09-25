/**
 * Editions and the feature registry (server/edition.js; group_requests.md §4).
 * Every behavior test runs under both editions: `full` must stay exactly
 * today's MAIA, and `personal-as` must gate on the server (I-26).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { serve } from '../helpers/serve.js';
import {
  EDITIONS, FEATURES, FEATURE_MODES, resolveEdition, getEdition, setEditionForTests,
  featureMode, isFeatureEnabled, mayCreatePrimaryAgent
} from '../../server/edition.js';
import setupEditionRoutes from '../../server/routes/edition.js';
import setupChatRoutes from '../../server/routes/chat.js';
import { ensureUserAgent } from '../../server/routes/auth.js';

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
  async getDocument(_db, id) { const d = this.docs.get(id); return d ? JSON.parse(JSON.stringify(d)) : null; }
  async saveDocument(_db, doc) { this.docs.set(doc._id, JSON.parse(JSON.stringify(doc))); return { ok: true }; }
  async findDocuments() { return { docs: [] }; }
}

const UNLOCKED_AT = '2026-09-24T12:00:00Z';
const makeCloudant = () => new FakeCloudant({
  alice01: { _id: 'alice01', userId: 'alice01', features: { 'records-index': { enabledAt: UNLOCKED_AT, via: 'settings' } } },
  bob02: { _id: 'bob02', userId: 'bob02' }
});

// A signed-in user is simulated with the x-test-user header.
const withSession = (app) => app.use((req, _res, next) => {
  const user = req.get('x-test-user');
  req.session = user ? { userId: user } : {};
  next();
});
const makeApp = (cloudant, auditLog = null) => {
  const app = express();
  app.use(express.json());
  withSession(app);
  setupEditionRoutes(app, cloudant, auditLog);
  return app;
};

describe.each(EDITIONS)('edition "%s"', (edition) => {
  const full = edition === 'full';
  let cloudant;
  beforeEach(() => {
    setEditionForTests(edition);
    cloudant = makeCloudant();
  });

  it('GET /api/edition answers before sign-in and describes every feature', async () => {
    const res = await request(await serve(makeApp(cloudant))).get('/api/edition');
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
    const server = await serve(makeApp(cloudant));
    const alice = await request(server).get('/api/edition').set('x-test-user', 'alice01');
    expect(alice.body.features['records-index'].enabled).toBe(true);
    expect(alice.body.features['second-ai'].enabled).toBe(full);
    const bob = await request(server).get('/api/edition').set('x-test-user', 'bob02');
    expect(bob.body.features['records-index'].enabled).toBe(full);
  });

  it('POST /api/user-features turns an unlockable feature on and off, and logs it', async () => {
    const events = [];
    const server = await serve(makeApp(cloudant, { logEvent: (e) => events.push(e) }));
    const turnOn = await request(server).post('/api/user-features').set('x-test-user', 'bob02')
      .send({ feature: 'diary', on: true });
    if (full) {
      // Nothing is unlockable in the full edition: every feature is simply on.
      expect(turnOn.status).toBe(400);
      expect(turnOn.body.error).toBe('NOT_UNLOCKABLE');
      return;
    }
    expect(turnOn.status).toBe(200);
    expect(turnOn.body.features.diary.enabled).toBe(true);
    expect(cloudant.docs.get('bob02').features.diary).toMatchObject({ via: 'settings' });
    const turnOff = await request(server).post('/api/user-features').set('x-test-user', 'bob02')
      .send({ feature: 'diary', on: false, via: 'advisor' });
    expect(turnOff.body.features.diary.enabled).toBe(false);
    expect(cloudant.docs.get('bob02').features.diary).toMatchObject({ enabledAt: null, via: 'advisor' });
    expect(events.map((e) => e.type)).toEqual(['feature_turned_on', 'feature_turned_off']);
  });

  it('POST /api/user-features refuses core, off and unknown features, and anonymous callers', async () => {
    const server = await serve(makeApp(cloudant));
    const as = (body) => request(server).post('/api/user-features').set('x-test-user', 'bob02').send(body);
    expect((await as({ feature: 'account', on: true })).body.error).toBe('NOT_UNLOCKABLE');
    expect((await as({ feature: 'legacy-requests', on: true })).body.error).toBe('NOT_UNLOCKABLE');
    expect((await as({ feature: 'no-such-feature', on: true })).status).toBe(400);
    expect((await as({ feature: 'diary', on: 'yes' })).body.error).toBe('INVALID_REQUEST');
    expect((await request(server).post('/api/user-features').send({ feature: 'diary', on: true })).status).toBe(401);
  });
});

describe('creating the private AI agent', () => {
  // A DO client that records every call and fails it, so no test can
  // create a real resource.
  const recordingDoClient = (calls) => new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'agent') {
        return new Proxy({}, { get: (_a, method) => async () => { calls.push(`agent.${String(method)}`); throw new Error('DO_CALLED'); } });
      }
      return async () => { calls.push(String(prop)); throw new Error('DO_CALLED'); };
    }
  });
  const attempt = async (edition, userDoc) => {
    setEditionForTests(edition);
    const calls = [];
    try { await ensureUserAgent(recordingDoClient(calls), makeCloudant(), userDoc); } catch { /* DO_CALLED */ }
    return calls;
  };

  it('mayCreatePrimaryAgent: personal-as waits for a verified email; full never waits', () => {
    expect(mayCreatePrimaryAgent({}, 'full')).toBe(true);
    expect(mayCreatePrimaryAgent({}, 'personal-as')).toBe(false);
    expect(mayCreatePrimaryAgent({ emailVerified: true }, 'personal-as')).toBe(true);
  });

  it('personal-as: an unverified account creates nothing and calls DO not at all', async () => {
    expect(await attempt('personal-as', { _id: 'carol03', userId: 'carol03' })).toEqual([]);
  });

  it('once the email is verified (or in full), creation goes ahead as before', async () => {
    expect((await attempt('personal-as', { _id: 'dave04', userId: 'dave04', emailVerified: true })).length).toBeGreaterThan(0);
    expect((await attempt('full', { _id: 'erin05', userId: 'erin05' })).length).toBeGreaterThan(0);
  });
});

describe.each(EDITIONS)('GET /api/chat/providers, edition "%s"', (edition) => {
  const full = edition === 'full';
  const running = { deployment: { status: 'STATUS_RUNNING', url: 'https://agent.example' } };
  const doClient = { agent: { get: async () => running } };
  const chatClient = {
    getAvailableProviders: () => ['digitalocean', 'anthropic', 'gemini'],
    getProviderModels: () => ({}),
    isProviderAvailable: () => true
  };
  const userWith = (features = {}) => ({
    _id: 'frank06', userId: 'frank06', features,
    assignedAgentId: 'agent-default', agentEndpoint: 'https://agent.example/api/v1',
    agentProfiles: { gpt: { agentId: 'agent-gpt', endpoint: 'https://gpt.example/api/v1', modelName: 'qwen3.8-max' } }
  });
  const providersFor = async (doc) => {
    setEditionForTests(edition);
    const app = express();
    withSession(app);
    setupChatRoutes(app, chatClient, new FakeCloudant({ frank06: doc }), doClient);
    return (await request(await serve(app)).get('/api/chat/providers').set('x-test-user', 'frank06')).body;
  };

  it('hides public AIs and the secondary unless the account has them on', async () => {
    const body = await providersFor(userWith());
    expect(body.providers).toEqual(full ? ['digitalocean', 'anthropic', 'gemini'] : ['digitalocean']);
    expect(body.privateAiProfiles.map((p) => p.key)).toEqual(full ? ['default', 'gpt'] : ['default']);
  });

  it('shows them once the account turned them on', async () => {
    const body = await providersFor(userWith({ 'public-ai': { enabledAt: UNLOCKED_AT }, 'second-ai': { enabledAt: UNLOCKED_AT } }));
    expect(body.providers).toEqual(['digitalocean', 'anthropic', 'gemini']);
    expect(body.privateAiProfiles.map((p) => p.key)).toEqual(['default', 'gpt']);
  });
});
