/**
 * Opening a sealed box in the browser — the twin of server/utils/sealed-box.js
 * (X25519 ECDH → HKDF-SHA256 → AES-256-GCM). A group request's answers are
 * sealed to the requester's X25519 key, made here and never exported, so
 * the group that carries them can't read them (group_requests.md §10.9).
 * Documents others add are sealed to the patient's folder key, under their
 * own label (§10.12).
 */

export interface SealedBox { v: 1; epk: JsonWebKey; iv: string; ct: string; tag: string }

const INFO = new TextEncoder().encode('maia-group-relay-v1');
export const FOLDER_DOCUMENT_INFO = 'maia-folder-document-v1';

const fromB64url = (s: string) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const toB64url = (bytes: Uint8Array) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/**
 * Seal bytes to an X25519 public key in the browser, with an ephemeral key
 * pair: only the holder of the private key opens it (the server's openFrom /
 * openBytesFrom opens it too, given the same label).
 */
export async function sealBytes(recipientPublicJwk: JsonWebKey, bytes: Uint8Array, info: string | Uint8Array = INFO): Promise<SealedBox> {
  const label = typeof info === 'string' ? new TextEncoder().encode(info) : info;
  const eph = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair;
  const recipient = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'X25519', x: String(recipientPublicJwk.x) }, { name: 'X25519' }, false, []);
  const secret = await crypto.subtle.deriveBits({ name: 'X25519', public: recipient } as unknown as AlgorithmIdentifier, eph.privateKey, 256);
  const hkdfKey = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const keyBits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: label as BufferSource }, hkdfKey, 256);
  const aes = await crypto.subtle.importKey('raw', keyBits, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, bytes as BufferSource));
  const epk = await crypto.subtle.exportKey('jwk', eph.publicKey);
  return { v: 1, epk: { kty: 'OKP', crv: 'X25519', x: epk.x }, iv: toB64url(iv), ct: toB64url(out.slice(0, out.length - 16)), tag: toB64url(out.slice(out.length - 16)) };
}

export const sealString = (recipientPublicJwk: JsonWebKey, text: string, info: string | Uint8Array = INFO) =>
  sealBytes(recipientPublicJwk, new TextEncoder().encode(text), info);

/** A new X25519 key pair; the private half can't be exported. */
export const newSealingKeyPair = () =>
  crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']) as Promise<CryptoKeyPair>;

export async function openSealed(privateKey: CryptoKey, box: SealedBox): Promise<string> {
  return new TextDecoder().decode(await openSealedBytes(privateKey, box));
}

export async function openSealedBytes(privateKey: CryptoKey, box: SealedBox, info: string | Uint8Array = INFO): Promise<Uint8Array> {
  const label = typeof info === 'string' ? new TextEncoder().encode(info) : info;
  const epk = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'X25519', x: String(box.epk.x) }, { name: 'X25519' }, false, []);
  const secret = await crypto.subtle.deriveBits({ name: 'X25519', public: epk } as unknown as AlgorithmIdentifier, privateKey, 256);
  const hkdfKey = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const keyBits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: label as BufferSource }, hkdfKey, 256);
  const aes = await crypto.subtle.importKey('raw', keyBits, 'AES-GCM', false, ['decrypt']);
  const ct = fromB64url(box.ct);
  const tag = fromB64url(box.tag);
  const data = new Uint8Array(ct.length + tag.length);
  data.set(ct);
  data.set(tag, ct.length);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(box.iv) }, aes, data);
  return new Uint8Array(plain);
}
