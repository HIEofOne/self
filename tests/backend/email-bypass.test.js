/**
 * Test-app email verification bypass (MAIA_EMAIL_VERIFY_BYPASS): only the
 * exact listed addresses skip the code, nothing does when it's unset, and
 * the token it issues satisfies the account-creation check.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { serve } from '../helpers/serve.js';
import {
  bypassesVerification, issueVerified, isVerified, statusOf, issueCode, testEmailAddress
} from '../../server/emailVerification.js';
import setupEditionRoutes from '../../server/routes/edition.js';

describe('MAIA_EMAIL_VERIFY_BYPASS', () => {
  const LIST = 'agropper+tst@gmail.com, qa@example.com';

  it('matches listed addresses exactly (case and spaces aside), nothing else', () => {
    expect(bypassesVerification('agropper+tst@gmail.com', LIST)).toBe(true);
    expect(bypassesVerification('  AGROPPER+TST@gmail.com ', LIST)).toBe(true);
    expect(bypassesVerification('qa@example.com', LIST)).toBe(true);
    expect(bypassesVerification('agropper+tst2@gmail.com', LIST)).toBe(false);
    expect(bypassesVerification('agropper@gmail.com', LIST)).toBe(false);
    expect(bypassesVerification('someone@example.com', LIST)).toBe(false);
  });

  it('is off when unset or empty', () => {
    expect(bypassesVerification('agropper+tst@gmail.com', undefined)).toBe(false);
    expect(bypassesVerification('agropper+tst@gmail.com', '')).toBe(false);
  });

  it('issues a token already verified for that address — and only that address', () => {
    const v = issueVerified('Agropper+tst@gmail.com');
    expect(isVerified(v.token, 'agropper+tst@gmail.com')).toBe(true);
    expect(isVerified(v.token, 'other@example.com')).toBe(false);
    expect(statusOf(v.token)).toEqual({ email: 'agropper+tst@gmail.com', verified: true });
  });

  it('a normal code is still unverified until checked', () => {
    const c = issueCode('someone@example.com');
    expect(isVerified(c.token, 'someone@example.com')).toBe(false);
  });
});

describe('the sign-up address a test app fills in', () => {
  const saved = process.env.MAIA_EMAIL_VERIFY_BYPASS;
  afterEach(() => {
    if (saved === undefined) delete process.env.MAIA_EMAIL_VERIFY_BYPASS;
    else process.env.MAIA_EMAIL_VERIFY_BYPASS = saved;
  });
  const edition = async () => {
    const app = express();
    app.use((req, _res, next) => { req.session = {}; next(); });
    setupEditionRoutes(app, { getDocument: async () => null });
    return (await request(await serve(app)).get('/api/edition')).body;
  };

  it('is the first listed address', () => {
    expect(testEmailAddress(' Agropper+tst@gmail.com , qa@example.com')).toBe('agropper+tst@gmail.com');
    expect(testEmailAddress('')).toBeNull();
    expect(testEmailAddress('not-an-address')).toBeNull();
  });

  it('GET /api/edition reports it only when the bypass is set', async () => {
    delete process.env.MAIA_EMAIL_VERIFY_BYPASS;
    expect(await edition()).not.toHaveProperty('testEmail');
    process.env.MAIA_EMAIL_VERIFY_BYPASS = 'agropper+tst@gmail.com';
    expect((await edition()).testEmail).toBe('agropper+tst@gmail.com');
  });
});

