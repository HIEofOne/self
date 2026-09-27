/**
 * A group-only host (MAIA_HOST_ROLE=group-only; trustee.ai as a
 * demonstration host) runs groups and nothing else: it creates no patient
 * account and no private AI, and its welcome page learns that it is one,
 * and which MAIA hosts to offer for joining. The default host role changes
 * nothing.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { serve } from '../helpers/serve.js';
import setupAuthRoutes from '../../server/routes/auth.js';
import {
  describeEdition, mayCreatePrimaryAgent, parseMemberHosts, setHostRoleForTests, getHostRole,
  setEditionForTests, getEdition
} from '../../server/edition.js';

const originalRole = getHostRole();
const originalEdition = getEdition();
const originalHosts = process.env.MAIA_MEMBER_HOSTS;
afterAll(() => {
  setHostRoleForTests(originalRole);
  setEditionForTests(originalEdition);
  if (originalHosts === undefined) delete process.env.MAIA_MEMBER_HOSTS; else process.env.MAIA_MEMBER_HOSTS = originalHosts;
});

class FakeCloudant {
  constructor() { this.docs = new Map(); }
  async getDocument(_db, id) { const d = this.docs.get(id); return d ? JSON.parse(JSON.stringify(d)) : null; }
  async saveDocument(_db, doc) { this.docs.set(doc._id, JSON.parse(JSON.stringify(doc))); return { ok: true }; }
  async findDocuments() { return { docs: [] }; }
  async getAllDocuments() { return [...this.docs.values()]; }
}

let server, cloudant;
beforeEach(async () => {
  setEditionForTests('personal-as');
  cloudant = new FakeCloudant();
  const app = express();
  app.use(cookieParser('test-secret'));
  app.use(express.json());
  app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
  const passkeyService = { rpID: 'localhost', generateRegistrationOptions: async () => ({ challenge: 'c' }), resolveExpectedOrigin: () => 'http://localhost' };
  setupAuthRoutes(app, passkeyService, cloudant, { agent: { list: async () => [], get: async () => null } }, { logEvent: () => {} }, {});
  server = await serve(app);
});

describe('group-only host', () => {
  it('creates no patient account: Get Started and recreate are refused', async () => {
    setHostRoleForTests('group-only');
    const start = await request(server).post('/api/temporary/start').send({ desiredUserId: 'ann01', email: 'ann@example.com' });
    expect(start.status).toBe(403);
    expect(start.body.error).toBe('GROUP_ONLY_HOST');
    const recreate = await request(server).post('/api/account/recreate').send({ userId: 'ann01', displayName: 'Ann' });
    expect(recreate.body.error).toBe('GROUP_ONLY_HOST');
    expect(cloudant.docs.size).toBe(0);
  });

  it('never creates a private AI, even for a verified account', () => {
    setHostRoleForTests('group-only');
    expect(mayCreatePrimaryAgent({ emailVerified: true })).toBe(false);
    setHostRoleForTests('patients');
    expect(mayCreatePrimaryAgent({ emailVerified: true })).toBe(true);
  });

  it('tells the welcome page what it is and which MAIA hosts to join from', () => {
    process.env.MAIA_MEMBER_HOSTS = 'https://maia.agropper.xyz/, http://evil.example, not a url, https://test.agropper.xyz';
    setHostRoleForTests('group-only');
    expect(describeEdition()).toMatchObject({ hostRole: 'group-only', memberHosts: ['https://maia.agropper.xyz', 'https://test.agropper.xyz'] });
    setHostRoleForTests('patients');
    expect(describeEdition().hostRole).toBe('patients');
    expect(describeEdition()).not.toHaveProperty('memberHosts');
    expect(parseMemberHosts('')).toEqual([]);
  });

  it('the default host role creates accounts as before', async () => {
    setHostRoleForTests('patients');
    const start = await request(server).post('/api/temporary/start').send({});
    expect(start.body.error).not.toBe('GROUP_ONLY_HOST');
  });
});
