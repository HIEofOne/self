import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/test-app.js';
import { ensureTestDatabases, cleanupTestDatabases } from '../helpers/db.js';

let app, cloudant;

beforeAll(async () => {
  cloudant = await ensureTestDatabases();
  app = createTestApp(cloudant);
});

afterAll(async () => {
  await cleanupTestDatabases();
});

describe('Auth routes', () => {
  describe('GET /api/passkey/check-user', () => {
    it('returns 400 without userId', async () => {
      const res = await request(app).get('/api/passkey/check-user');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('User ID required');
    });

    it('returns exists:false for unknown user', async () => {
      const res = await request(app).get('/api/passkey/check-user?userId=nonexistent');
      expect(res.status).toBe(200);
      expect(res.body.exists).toBe(false);
      expect(res.body.hasPasskey).toBe(false);
    });
  });

  describe('GET /api/current-user', () => {
    it('returns not authenticated when no session', async () => {
      const res = await request(app).get('/api/current-user');
      expect(res.status).toBe(200);
      expect(res.body.authenticated).toBe(false);
    });
  });

  describe('GET /api/welcome-status', () => {
    it('returns 200 with unauthenticated state when no session', async () => {
      const res = await request(app).get('/api/welcome-status');
      expect(res.status).toBe(200);
      expect(res.body.authenticated).toBeFalsy();
    });
  });
});
