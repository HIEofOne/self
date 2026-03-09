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

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
