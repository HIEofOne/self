/**
 * The E2E sealed box (Groups.md §6.3): X25519 ECDH → HKDF-SHA256 →
 * AES-256-GCM. The sender seals to the recipient's X25519 public key with
 * an ephemeral key pair; whoever stores or carries the box (the group
 * relay, a group's GNAP answer slot) never holds a key. Used for relay
 * messages and for sealed GNAP group answers (group_requests.md §10.9);
 * the browser twin is src/gnap/sealedBox.ts.
 */
import {
  generateKeyPairSync, createPrivateKey, createPublicKey, randomBytes,
  diffieHellman, hkdfSync, createCipheriv, createDecipheriv
} from 'crypto';

const RELAY_HKDF_INFO = Buffer.from('maia-group-relay-v1');

export const sealTo = (recipientEncPubJwk, plaintext) => {
  const eph = generateKeyPairSync('x25519');
  const recipientPub = createPublicKey({ key: recipientEncPubJwk, format: 'jwk' });
  const secret = diffieHellman({ privateKey: eph.privateKey, publicKey: recipientPub });
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), RELAY_HKDF_INFO, 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return {
    v: 1,
    epk: eph.publicKey.export({ format: 'jwk' }),
    iv: iv.toString('base64url'),
    ct: ct.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url')
  };
};

export const openFrom = (recipientEncPrivJwk, box) => {
  const priv = createPrivateKey({ key: recipientEncPrivJwk, format: 'jwk' });
  const epk = createPublicKey({ key: box.epk, format: 'jwk' });
  const secret = diffieHellman({ privateKey: priv, publicKey: epk });
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), RELAY_HKDF_INFO, 32));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(box.ct, 'base64url')), decipher.final()]).toString('utf8');
};

/** A public X25519 JWK (a requester's sealing key), and nothing else. */
export const isX25519PublicJwk = (jwk) => !!jwk && typeof jwk === 'object' && jwk.kty === 'OKP'
  && jwk.crv === 'X25519' && typeof jwk.x === 'string' && /^[A-Za-z0-9_-]{43}$/.test(jwk.x) && !jwk.d;

/** A box as sealTo makes it (shape only; opening proves the rest). */
export const isSealedBox = (box) => !!box && typeof box === 'object' && box.v === 1
  && isX25519PublicJwk(box.epk) && typeof box.iv === 'string' && typeof box.ct === 'string'
  && typeof box.tag === 'string' && box.ct.length <= 16384;
