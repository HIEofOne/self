/**
 * Test-app email verification bypass (MAIA_EMAIL_VERIFY_BYPASS): only the
 * exact listed addresses skip the code, nothing does when it's unset, and
 * the token it issues satisfies the account-creation check.
 */
import { describe, it, expect } from 'vitest';
import {
  bypassesVerification, issueVerified, isVerified, statusOf, issueCode
} from '../../server/emailVerification.js';

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
