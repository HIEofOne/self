/**
 * The welcome page's delete runs signed out. Its proof: a session, this
 * browser's signed temporary-account cookie, or the account's passkey —
 * verified against the challenge the server just issued, without signing
 * in (so no private AI is started for an account about to be deleted).
 */
import { describe, it, expect } from 'vitest';
import { deletionProof } from '../../server/utils/delete-proof.js';
import { TEMP_USER_COOKIE } from '../../server/utils/api-guard.js';

const cloudantWith = (doc) => ({ getDocument: async (_db, id) => (doc && doc._id === id ? { ...doc } : null) });
const passkeyService = (verified, seen = []) => ({
  resolveExpectedOrigin: () => 'https://test.agropper.xyz',
  verifyAuthentication: async (params) => { seen.push(params); return { verified }; }
});
const req = (over = {}) => ({ session: {}, body: {}, get: () => 'https://test.agropper.xyz', ...over });
const PASSKEY_USER = { _id: 'aaron19', userId: 'aaron19', credentialID: 'cred', challenge: 'chal-1' };

describe('deletionProof', () => {
  it('a session or the signed temporary-account cookie is enough', async () => {
    const deps = { cloudant: cloudantWith(PASSKEY_USER), passkeyService: passkeyService(false) };
    expect((await deletionProof(req({ session: { userId: 'aaron19' } }), 'aaron19', deps)).ok).toBe(true);
    expect((await deletionProof(req({ signedCookies: { [TEMP_USER_COOKIE]: 'aaron19' } }), 'aaron19', deps)).ok).toBe(true);
  });

  it('otherwise the page is told the account has a passkey to ask for', async () => {
    const r = await deletionProof(req(), 'aaron19', { cloudant: cloudantWith(PASSKEY_USER), passkeyService: passkeyService(true) });
    expect(r).toMatchObject({ ok: false, status: 401, body: { error: 'PROOF_REQUIRED', passkey: true } });
  });

  it('a verified passkey assertion over the issued challenge proves it', async () => {
    const seen = [];
    const r = await deletionProof(req({ body: { passkeyResponse: { id: 'x' } } }), 'aaron19',
      { cloudant: cloudantWith(PASSKEY_USER), passkeyService: passkeyService(true, seen) });
    expect(r.ok).toBe(true);
    expect(seen[0]).toMatchObject({ expectedChallenge: 'chal-1', response: { id: 'x' } });
  });

  it('a failed assertion, or one with no challenge issued, does not', async () => {
    const bad = await deletionProof(req({ body: { passkeyResponse: { id: 'x' } } }), 'aaron19',
      { cloudant: cloudantWith(PASSKEY_USER), passkeyService: passkeyService(false) });
    expect(bad).toMatchObject({ ok: false, body: { error: 'PASSKEY_NOT_VERIFIED' } });
    const noChallenge = await deletionProof(req({ body: { passkeyResponse: { id: 'x' } } }), 'aaron19',
      { cloudant: cloudantWith({ ...PASSKEY_USER, challenge: undefined }), passkeyService: passkeyService(true) });
    expect(noChallenge.ok).toBe(false);
  });

  it('an account without a passkey offers none to ask for', async () => {
    const r = await deletionProof(req(), 'temp01', { cloudant: cloudantWith({ _id: 'temp01' }), passkeyService: passkeyService(true) });
    expect(r.body).toMatchObject({ error: 'PROOF_REQUIRED', passkey: false });
  });
});
