/**
 * Proof for the welcome page's delete, which runs signed out: a session for
 * the account (or the admin's), this browser's signed temporary-account
 * cookie for it, or the account's passkey — an assertion over the challenge
 * /api/passkey/authenticate just issued. The passkey path deletes without
 * signing in, so no private AI is started for an account that is about to go.
 */
import { provesAccount } from './api-guard.js';

/**
 * @returns {Promise<{ok: true} | {ok: false, status: number, body: object}>}
 */
export async function deletionProof(req, userId, { cloudant, passkeyService }) {
  if (provesAccount(req, userId)) return { ok: true };
  const doc = await cloudant.getDocument('maia_users', userId).catch(() => null);
  const hasPasskey = !!doc?.credentialID;
  const assertion = req.body?.passkeyResponse;
  if (!assertion || !hasPasskey || !doc.challenge) {
    return { ok: false, status: 401, body: { success: false, error: 'PROOF_REQUIRED', passkey: hasPasskey } };
  }
  try {
    const expectedOrigin = passkeyService.resolveExpectedOrigin(req.get?.('origin'));
    const result = await passkeyService.verifyAuthentication({
      response: assertion, expectedChallenge: doc.challenge, userDoc: doc, expectedOrigin
    });
    if (result?.verified) return { ok: true };
  } catch (e) {
    console.warn(`[LOCAL-DELETE] passkey check failed for ${userId}: ${e?.message || e}`);
  }
  return { ok: false, status: 401, body: { success: false, error: 'PASSKEY_NOT_VERIFIED', passkey: true } };
}
