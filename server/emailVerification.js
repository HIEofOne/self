/**
 * Pre-auth email verification (welcome onboarding).
 *
 * The visitor has no account yet, and CloudantSessionStore only persists
 * sessions that carry a userId — so the pending code can't live in the
 * session. Instead it lives here, in-memory, keyed by an opaque token the
 * client holds and echoes back. Single-deployment Phase 1: one process, so a
 * Map is sufficient; entries self-expire (10-min code, GC'd every 30 min).
 *
 * This module only guards the short-lived code. The 72h retention rule
 * applies to the address AFTER it's promoted onto the userDoc — enforced by
 * the daily sweep in routes/groups.js, not here.
 */
import { randomBytes } from 'crypto';

const CODE_TTL_MS = 10 * 60 * 1000;  // a code is valid 10 minutes
const RESEND_MS = 30 * 1000;         // min gap between sends for one token
const MAX_ATTEMPTS = 5;              // wrong-code tries before the token dies
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// token -> { email, code, expiresAt, attempts, verified, verifiedAt, lastSentAt }
const pending = new Map();

const gc = setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000; // keep 1h past expiry, then drop
  for (const [t, v] of pending) if (v.expiresAt < cutoff) pending.delete(t);
}, 30 * 60 * 1000);
if (typeof gc.unref === 'function') gc.unref();

export function isValidEmail(email) {
  return EMAIL_RE.test(String(email || '').trim());
}

/** Issue a fresh code for `email`. Reuses `token` when given (resend), else
 *  mints a new one. Returns { token, code, email } or { error }. */
export function issueCode(email, token) {
  const addr = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(addr)) return { error: 'INVALID_EMAIL' };
  let t = (typeof token === 'string' && /^[a-f0-9]{32}$/.test(token)) ? token : null;
  const existing = t ? pending.get(t) : null;
  if (existing && existing.email === addr && Date.now() - existing.lastSentAt < RESEND_MS) {
    return { error: 'RATE_LIMITED' };
  }
  if (!t) t = randomBytes(16).toString('hex');
  const code = String(Math.floor(100000 + Math.random() * 900000));
  pending.set(t, {
    email: addr, code, expiresAt: Date.now() + CODE_TTL_MS,
    attempts: 0, verified: false, lastSentAt: Date.now()
  });
  return { token: t, code, email: addr };
}

/** Check a code against a token. Returns { email } on success or { error }. */
export function checkCode(token, code) {
  const v = (typeof token === 'string') ? pending.get(token) : null;
  if (!v) return { error: 'NO_PENDING' };
  if (Date.now() > v.expiresAt) { pending.delete(token); return { error: 'CODE_EXPIRED' }; }
  if (v.attempts >= MAX_ATTEMPTS) { pending.delete(token); return { error: 'TOO_MANY_ATTEMPTS' }; }
  v.attempts += 1;
  if (!code || String(code).trim() !== v.code) return { error: 'BAD_CODE' };
  v.verified = true; v.verifiedAt = Date.now();
  return { email: v.email };
}

/** Current verification state for a token (cross-fill on reload). */
export function statusOf(token) {
  const v = (typeof token === 'string') ? pending.get(token) : null;
  return { email: v?.email || null, verified: !!(v && v.verified) };
}

/** Account-creation check: is `token` a VERIFIED match for `email`? */
export function isVerified(token, email) {
  const v = (typeof token === 'string') ? pending.get(token) : null;
  if (!v || !v.verified) return false;
  return v.email === String(email || '').trim().toLowerCase();
}
