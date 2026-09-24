/**
 * Personal AS setup checklist (group_requests.md §5): the derived status,
 * the folder fact, and the account rules the edition enforces on the
 * server (verified email to create an account; accounts start from GET
 * STARTED, not a bare passkey; the private AI starts at verification).
 * Every behavior test runs under both editions.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { EDITIONS, getEdition, setEditionForTests } from '../../server/edition.js';
import setupSetupRoutes, { deriveSetupStatus } from '../../server/routes/setup.js';
import setupAuthRoutes from '../../server/routes/auth.js';
import { createApiGuard } from '../../server/utils/api-guard.js';
import { issueCode, checkCode } from '../../server/emailVerification.js';

const originalEdition = getEdition();
afterAll(() => setEditionForTests(originalEdition));

class FakeCloudant {
  constructor(docs = {}, groups = []) {
    this.docs = new Map(Object.entries(docs));
    this.groups = groups;
  }
  async getDocument(_db, id) { const d = this.docs.get(id); return d ? JSON.parse(JSON.stringify(d)) : null; }
  async saveDocument(_db, doc) { this.docs.set(doc._id, JSON.parse(JSON.stringify(doc))); return { ok: true }; }
  async findDocuments() { return { docs: [] }; }
  async getAllDocuments(db) { return db === 'maia_groups' ? this.groups : [...this.docs.values()]; }
}

const verifiedToken = (email) => {
  const { token, code } = issueCode(email);
  expect(checkCode(token, code).email).toBe(email);
  return token;
};

// Records every DO call and fails it, so no test can create a resource.
const recordingDoClient = (calls) => new Proxy({}, {
  get: (_t, prop) => {
    if (prop === 'agent') {
      return new Proxy({}, { get: (_a, method) => async () => { calls.push(`agent.${String(method)}`); throw new Error('DO_CALLED'); } });
    }
    return async () => { calls.push(String(prop)); throw new Error('DO_CALLED'); };
  }
});

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('deriveSetupStatus', () => {
  const full = {
    emailVerified: true, credentialID: 'cred', folderConnectedAt: '2026-09-25T00:00:00Z',
    groupMemberships: [{ groupId: 'g1', groupName: 'Trustee' }],
    currentMedicationsVerifiedAt: 'x', patientSummaryVerifiedAt: 'y',
    assignedAgentId: 'a1', agentEndpoint: 'https://agent',
    asState: 'active'
  };

  it('derives every row from the account alone', () => {
    setEditionForTests('personal-as');
    const s = deriveSetupStatus(full, { groupRequired: true });
    expect(s.steps.map((x) => [x.key, x.done])).toEqual([
      ['email', true], ['passkey', true], ['folder', true], ['group', true], ['summary', true], ['sharing', true]
    ]);
    expect(s.requiredDone).toBe(true);
    expect(s.agent).toBe('ready');
    expect(s.steps.find((x) => x.key === 'group').groups).toEqual(['Trustee']);
  });

  it('required: email, passkey, folder, and the group when the host lists one; the summary is urged', () => {
    setEditionForTests('personal-as');
    const fresh = deriveSetupStatus({}, { groupRequired: true });
    expect(fresh.steps.filter((x) => x.required).map((x) => x.key)).toEqual(['email', 'passkey', 'folder', 'group']);
    expect(fresh.requiredDone).toBe(false);
    const noGroupHost = deriveSetupStatus({ ...full, groupMemberships: [] }, { groupRequired: false });
    expect(noGroupHost.requiredDone).toBe(true);
    const noSummary = deriveSetupStatus({ ...full, patientSummaryVerifiedAt: null }, { groupRequired: true });
    expect(noSummary.requiredDone).toBe(true);
    expect(noSummary.steps.find((x) => x.key === 'summary')).toMatchObject({ done: false, medicationsVerified: true });
  });

  it('reports a join waiting for approval', () => {
    const s = deriveSetupStatus({ pendingGroupJoins: [{ groupId: 'g1', groupName: 'Trustee' }] }, { groupRequired: true });
    expect(s.steps.find((x) => x.key === 'group')).toMatchObject({ done: false, pending: ['Trustee'] });
  });

  it('agent: waits for email in personal-as, then none / creating / ready', () => {
    setEditionForTests('personal-as');
    expect(deriveSetupStatus({}).agent).toBe('waiting-for-email');
    expect(deriveSetupStatus({ emailVerified: true }).agent).toBe('none');
    expect(deriveSetupStatus({ emailVerified: true, assignedAgentId: 'a' }).agent).toBe('creating');
    setEditionForTests('full');
    expect(deriveSetupStatus({}).agent).toBe('none');
  });
});

describe.each(EDITIONS)('setup routes, edition "%s"', (edition) => {
  let cloudant, app;
  beforeEach(() => {
    setEditionForTests(edition);
    cloudant = new FakeCloudant(
      { carol03: { _id: 'carol03', userId: 'carol03', emailVerified: true } },
      [{ type: 'group', publiclyListed: true, groupId: 'g1' }]
    );
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { const u = req.get('x-test-user'); req.session = u ? { userId: u } : {}; next(); });
    setupSetupRoutes(app, cloudant);
  });

  it('GET /api/setup-status needs a user, and derives the rows', async () => {
    expect((await request(app).get('/api/setup-status')).status).toBe(401);
    const r = await request(app).get('/api/setup-status').set('x-test-user', 'carol03');
    expect(r.status).toBe(200);
    expect(r.body.steps.find((s) => s.key === 'email').done).toBe(true);
    expect(r.body.steps.find((s) => s.key === 'group').required).toBe(true);
    expect(r.body.requiredDone).toBe(false);
  });

  it('POST /api/setup/folder-connected records only a timestamp, once', async () => {
    const r = await request(app).post('/api/setup/folder-connected').set('x-test-user', 'carol03').send({ folderName: 'secret name' });
    expect(r.status).toBe(200);
    expect(r.body.steps.find((s) => s.key === 'folder').done).toBe(true);
    const first = cloudant.docs.get('carol03').folderConnectedAt;
    expect(first).toBeTruthy();
    expect(JSON.stringify(cloudant.docs.get('carol03'))).not.toContain('secret name');
    await request(app).post('/api/setup/folder-connected').set('x-test-user', 'carol03');
    expect(cloudant.docs.get('carol03').folderConnectedAt).toBe(first);
  });
});

describe.each(EDITIONS)('account rules, edition "%s"', (edition) => {
  const pa = edition === 'personal-as';
  let cloudant, app, doCalls;
  beforeEach(() => {
    setEditionForTests(edition);
    cloudant = new FakeCloudant();
    doCalls = [];
    app = express();
    app.use(cookieParser('test-secret'));
    app.use(express.json());
    app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
    app.use('/api', createApiGuard({}));
    const passkeyService = {
      rpID: 'localhost',
      generateRegistrationOptions: async () => ({ challenge: 'challenge-1' }),
      resolveExpectedOrigin: () => 'http://localhost'
    };
    setupAuthRoutes(app, passkeyService, cloudant, recordingDoClient(doCalls), { logEvent: () => {} }, {});
  });

  it('a new account needs a verified email in personal-as', async () => {
    const r = await request(app).post('/api/temporary/start').send({ forceNew: true });
    if (pa) {
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('EMAIL_VERIFICATION_REQUIRED');
      expect(cloudant.docs.size).toBe(0);
    } else {
      expect(r.body.authenticated).toBe(true);
    }
    const unverified = await request(app).post('/api/temporary/start')
      .send({ forceNew: true, email: 'dan@example.org', emailVerifyToken: 'a'.repeat(32) });
    expect(unverified.status).toBe(pa ? 400 : 200);
  });

  it('with a verified email the account is created verified, and personal-as starts the private AI', async () => {
    const email = `erin-${edition}@example.org`;
    const r = await request(app).post('/api/temporary/start')
      .send({ forceNew: true, email, emailVerifyToken: verifiedToken(email) });
    expect(r.body.authenticated).toBe(true);
    expect(cloudant.docs.get(r.body.user.userId).emailVerified).toBe(true);
    await settle();
    if (pa) expect(doCalls.length).toBeGreaterThan(0); // background start reached DO
    else expect(doCalls).toEqual([]);                  // full: the wizard starts it, as before
  });

  it('personal-as refuses a brand-new account made from a bare passkey', async () => {
    const r = await request(app).post('/api/passkey/register').send({ userId: 'newbie07', displayName: 'newbie07' });
    if (pa) {
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('START_WITH_EMAIL');
      expect(cloudant.docs.has('newbie07')).toBe(false);
    } else {
      expect(r.status).toBe(200);
    }
  });
});
