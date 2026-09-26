/**
 * Group routing for GNAP (group_requests.md §10.9). The group is not an AS:
 * it checks the requester's signed request once, verifies their email (and
 * holds any credits) once, and then carries a COPY of the signed request to
 * each member's AS through the relay, with an attestation signed by the
 * group key. Each member's AS verifies both signatures and decides alone;
 * answers come back sealed to the requester's X25519 key.
 *
 * The copy a member receives (sealed to them, relay sender `gnap:<bcast>`):
 *   { maiaType: 'gnap-copy', v: 1, bcast,
 *     request: { method, targetUri, headers, body },   // exactly as signed
 *     attestation: { payload, signature } }             // by the group key
 * The attestation payload binds the copy to this group and request:
 *   { groupId, bcast, receivedAt, expiresAt, targetUri, bodySha256,
 *     requester: { email, emailVerified }, payment, answerUri }
 */
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'crypto';

export const GNAP_COPY = 'gnap-copy';
export const COPY_SENDER_PREFIX = 'gnap:';

export const bodySha256 = (body) => createHash('sha256').update(String(body)).digest('base64url');

/** The headers a member needs to re-verify the requester's signature. */
export const SIGNED_HEADERS = ['content-type', 'content-digest', 'signature-input', 'signature'];

export function signAttestation(groupPrivateJwk, claim) {
  const payload = Buffer.from(JSON.stringify(claim)).toString('base64url');
  const key = createPrivateKey({ key: groupPrivateJwk, format: 'jwk' });
  return { payload, signature: edSign(null, Buffer.from(payload), key).toString('base64url') };
}

/** The attested claim, or null when the group key didn't sign it. */
export function verifyAttestation(att, groupPublicJwk) {
  try {
    if (!att?.payload || !att?.signature || !groupPublicJwk) return null;
    const key = createPublicKey({ key: groupPublicJwk, format: 'jwk' });
    if (!edVerify(null, Buffer.from(String(att.payload)), key, Buffer.from(String(att.signature), 'base64url'))) return null;
    return JSON.parse(Buffer.from(String(att.payload), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
