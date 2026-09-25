/**
 * The route inventory and the /api feature gate (server/edition-routes.js;
 * I-26). The inventory test is the control for group_requests.md risk 1:
 * a route the table doesn't classify fails CI instead of slipping past the
 * gate.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { serve } from '../helpers/serve.js';
import { EDITIONS, FEATURES, getEdition, setEditionForTests } from '../../server/edition.js';
import {
  ROUTE_FEATURES, NON_FEATURE_CLASSES, matchRoute, routeFeature, createFeatureGuard
} from '../../server/edition-routes.js';
import { PRE_AUTH_ROUTES } from '../../server/utils/api-guard.js';

const originalEdition = getEdition();
afterAll(() => setEditionForTests(originalEdition));

const SERVER_DIR = path.resolve(__dirname, '../../server');
const jsFiles = (dir) => readdirSync(dir).flatMap((name) => {
  const full = path.join(dir, name);
  if (statSync(full).isDirectory()) return jsFiles(full);
  return name.endsWith('.js') ? [full] : [];
});
const definedRoutes = () => {
  const found = new Set();
  const re = /app\.(get|post|put|delete|patch)\(\s*['`]([^'`]+)['`]/g;
  for (const file of jsFiles(SERVER_DIR)) {
    for (const m of readFileSync(file, 'utf8').matchAll(re)) found.add(`${m[1].toUpperCase()} ${m[2]}`);
  }
  return found;
};

const isClass = (v) => NON_FEATURE_CLASSES.includes(v) || !!FEATURES[v];

describe('route inventory', () => {
  const routes = definedRoutes();

  it('finds the server routes (sanity check on the scanner)', () => {
    expect(routes.size).toBeGreaterThan(200);
  });

  it('classifies every route the server defines', () => {
    const missing = [...routes].filter((r) => !(r in ROUTE_FEATURES));
    expect(missing).toEqual([]);
  });

  it('has no entries for routes that no longer exist', () => {
    const stale = Object.keys(ROUTE_FEATURES).filter((r) => !routes.has(r));
    expect(stale).toEqual([]);
  });

  it('maps every route to a feature or a non-feature class', () => {
    const sampleReqs = [
      { query: {}, body: {} },
      { query: { agentProfileKey: 'gpt' }, body: {} },
      { query: {}, body: { options: { agentProfileKey: 'gpt' } } }
    ];
    for (const [route, value] of Object.entries(ROUTE_FEATURES)) {
      if (typeof value === 'function') {
        for (const req of sampleReqs) {
          for (const provider of ['digitalocean', 'anthropic']) {
            expect(isClass(value(req, { provider })), route).toBe(true);
          }
        }
      } else {
        expect(isClass(value), route).toBe(true);
      }
    }
  });

  it('never gates a route that runs before sign-in', () => {
    for (const route of PRE_AUTH_ROUTES) {
      const entries = Object.entries(ROUTE_FEATURES).filter(([k]) => k.endsWith(` ${route}`));
      expect(entries.length, route).toBeGreaterThan(0);
      for (const [key, value] of entries) {
        const ok = value === 'public' || value === 'admin' || FEATURES[value]?.modes['personal-as'] === 'on';
        expect(ok, key).toBe(true);
      }
    }
  });
});

describe('matchRoute', () => {
  it('prefers a literal path over a parameterized one', () => {
    expect(matchRoute('GET', '/api/groups/public').entry.path).toBe('/api/groups/public');
  });
  it('extracts params, and lets (*) span slashes', () => {
    const m = matchRoute('GET', '/api/files/get-text/alice01/archived/a%20b.pdf');
    expect(m.entry.path).toBe('/api/files/get-text/:bucketKey(*)');
    expect(m.params.bucketKey).toBe('alice01/archived/a b.pdf');
    expect(matchRoute('GET', '/api/load-chat-by-share/abc123').params.shareId).toBe('abc123');
  });
  it('matches on the method too, and returns null for unknown routes', () => {
    expect(matchRoute('DELETE', '/api/user-settings')).toBeNull();
    expect(matchRoute('GET', '/api/no-such-route')).toBeNull();
  });
});

describe('features chosen from the request', () => {
  const feature = (method, url, body = {}, query = {}) => {
    const req = { method, body, query };
    return routeFeature(req, matchRoute(method, url));
  };
  it('chat: the private AI is core, the secondary is second-ai, everything else is public-ai', () => {
    expect(feature('POST', '/api/chat/digitalocean')).toBe('advisor');
    expect(feature('POST', '/api/chat/digitalocean', { options: { agentProfileKey: 'gpt' } })).toBe('second-ai');
    expect(feature('POST', '/api/chat/digitalocean', { agentProfileKey: 'gpt' })).toBe('second-ai');
    expect(feature('POST', '/api/chat/anthropic')).toBe('public-ai');
    expect(feature('POST', '/api/chat/gemini')).toBe('public-ai');
  });
  it('agent instructions: second-ai only for the secondary profile', () => {
    expect(feature('GET', '/api/agent-instructions', {}, {})).toBe('advisor');
    expect(feature('GET', '/api/agent-instructions', {}, { agentProfileKey: 'gpt' })).toBe('second-ai');
    expect(feature('PUT', '/api/agent-instructions', { agentProfileKey: 'gpt' })).toBe('second-ai');
  });
});

// ── The guard ────────────────────────────────────────────────────────────
class FakeCloudant {
  constructor(docs = {}) { this.docs = new Map(Object.entries(docs)); }
  async getDocument(_db, id) { return this.docs.get(id) ?? null; }
}
const ON = { enabledAt: '2026-09-24T12:00:00Z', via: 'settings' };
const SHARES = { 'share-alice': 'alice01', 'share-bob': 'bob02' };

// x-test-user signs a user in; x-test-share makes a clinician's guest
// session for that share.
const makeApp = (guardDeps) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const user = req.get('x-test-user');
    const share = req.get('x-test-share');
    req.session = user ? { userId: user } : share ? { isDeepLink: true, deepLinkShareId: share } : {};
    next();
  });
  app.use('/api', createFeatureGuard(guardDeps));
  app.all('/api/*', (_req, res) => res.json({ success: true }));
  return app;
};

describe.each(EDITIONS)('feature guard, edition "%s"', (edition) => {
  const full = edition === 'full';
  const gated = (status) => (full ? 200 : status);
  let server;
  beforeEach(async () => {
    setEditionForTests(edition);
    const cloudant = new FakeCloudant({
      alice01: { _id: 'alice01', userId: 'alice01', features: { 'records-index': ON, 'lists-full': ON } },
      bob02: { _id: 'bob02', userId: 'bob02' }
    });
    server = await serve(makeApp({
      loadUserDoc: (id) => cloudant.getDocument('maia_users', id),
      getShareOwnerId: async (shareId) => SHARES[shareId] || null
    }));
  });

  it('lets core, public, admin and registry routes through for anyone', async () => {
    expect((await request(server).get('/api/user-settings')).status).toBe(200);
    expect((await request(server).get('/health')).status).toBe(404); // not under /api: never reaches the guard
    expect((await request(server).get('/api/edition')).status).toBe(200);
    expect((await request(server).get('/api/admin/users')).status).toBe(200);
    expect((await request(server).get('/api/groups/g1/info')).status).toBe(200);
    expect((await request(server).post('/api/user-policies').send({})).status).toBe(200);
  });

  it("judges an unlockable route on the user's own unlocks", async () => {
    expect((await request(server).post('/api/update-knowledge-base')).status).toBe(gated(403));
    expect((await request(server).post('/api/update-knowledge-base').set('x-test-user', 'bob02')).status).toBe(gated(403));
    expect((await request(server).post('/api/update-knowledge-base').set('x-test-user', 'alice01')).status).toBe(200);
    const off = await request(server).post('/api/patient-diary').set('x-test-user', 'alice01');
    expect(off.status).toBe(gated(403));
    if (!full) expect(off.body).toEqual({ success: false, error: 'FEATURE_OFF', feature: 'diary' });
  });

  it('uses the account a request names (checked by the account guard first)', async () => {
    const res = await request(server).get('/api/kb2-indexing-status?userId=alice01').set('x-test-user', 'admin');
    expect(res.status).toBe(200);
  });

  it('turns the old request path off in personal-as, for everyone', async () => {
    expect((await request(server).post('/api/groups/g1/outside-request').send({})).status).toBe(gated(403));
    expect((await request(server).post('/api/user-groups/request').set('x-test-user', 'alice01')).status).toBe(gated(403));
  });

  it('gates public AIs and the secondary Private AI, not the private AI', async () => {
    const as = (req) => req.set('x-test-user', 'alice01');
    expect((await as(request(server).post('/api/chat/digitalocean')).send({})).status).toBe(200);
    expect((await as(request(server).post('/api/chat/anthropic')).send({})).status).toBe(gated(403));
    expect((await as(request(server).post('/api/chat/digitalocean')).send({ options: { agentProfileKey: 'gpt' } })).status).toBe(gated(403));
    expect((await as(request(server).post('/api/agents/ensure-secondary')).send({})).status).toBe(gated(403));
  });

  it('judges a clinician guest on the unlocks of the patient who shared', async () => {
    // Clinician links are on for everyone; what the guest may then read
    // depends on the sharing patient: lists-full is on for alice only.
    expect((await request(server).post('/api/deep-link/login').send({ shareId: 'share-bob' })).status).toBe(200);
    expect((await request(server).get('/api/load-chat-by-share/share-bob')).status).toBe(200);
    expect((await request(server).get('/api/deep-link/session?shareId=share-alice')).status).toBe(200);
    expect((await request(server).get('/api/labs/history').set('x-test-share', 'share-alice')).status).toBe(200);
    expect((await request(server).get('/api/labs/history').set('x-test-share', 'share-bob')).status).toBe(gated(403));
    expect((await request(server).get('/api/labs/history').set('x-test-share', 'no-such-share')).status).toBe(gated(403));
  });

  it('passes unknown routes through (they 404 later)', async () => {
    expect((await request(server).get('/api/no-such-route')).status).toBe(200);
  });

  it('fails closed (503) when the account cannot be read', async () => {
    const failing = await serve(makeApp({ loadUserDoc: async () => { throw new Error('db down'); }, getShareOwnerId: async () => null }));
    const res = await request(failing).post('/api/update-knowledge-base').set('x-test-user', 'alice01');
    expect(res.status).toBe(full ? 200 : 503);
  });
});
