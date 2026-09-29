/**
 * The folder key travels with the passkey, so a phone or Safari, where
 * there is no MAIA folder, can still open member messages. A passkey can
 * produce a secret of its own for this site (the WebAuthn PRF extension):
 * the same secret on every device the passkey syncs to, and never sent
 * anywhere. The browser derives an AES key from it and encrypts the folder
 * key's private half; the server keeps only that encrypted copy
 * (/api/folder-key/wrapped) and can't open it.
 *
 * On a computer with the folder, a passkey sign-in stores the copy; on a
 * phone, a passkey sign-in opens it and keeps the key in this browser.
 * A passkey without PRF (some hardware keys) simply can't carry it.
 */
import { getFolderPrivateJwk, keepFolderKeyInBrowser, type PrivateJwk } from './folderKey';
import { startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';

/** The PRF input: fixed, so the passkey gives the same secret every time. */
const PRF_INPUT = new TextEncoder().encode('maia-folder-key-wrap-v1');
const HKDF_INFO = new TextEncoder().encode('maia-folder-key-wrap-v1');

const toB64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** Ask the passkey for its PRF secret along with a sign-in. */
export function withPrf(optionsJSON: PublicKeyCredentialRequestOptionsJSON): PublicKeyCredentialRequestOptionsJSON {
  const extensions = { ...(optionsJSON.extensions || {}), prf: { eval: { first: PRF_INPUT } } };
  return { ...optionsJSON, extensions: extensions as PublicKeyCredentialRequestOptionsJSON['extensions'] };
}

/**
 * Take the PRF secret out of an assertion (so it's never sent to the
 * server) → its bytes, or null when the passkey has no PRF.
 */
export function takePrfSecret(assertion: { clientExtensionResults?: Record<string, unknown> }): Uint8Array | null {
  const ext = assertion?.clientExtensionResults as { prf?: { results?: { first?: ArrayBuffer | Uint8Array } } } | undefined;
  const first = ext?.prf?.results?.first;
  if (ext && 'prf' in ext) delete (ext as Record<string, unknown>).prf;
  if (!first) return null;
  const bytes = first instanceof Uint8Array ? first : new Uint8Array(first);
  return bytes.length >= 16 ? new Uint8Array(bytes) : null;
}

// This page's PRF secrets, by account (memory only; gone on reload).
const secrets = new Map<string, { credentialId: string; secret: Uint8Array }>();

export function rememberPrfSecret(userId: string, credentialId: string, secret: Uint8Array | null): void {
  if (userId && credentialId && secret) secrets.set(userId, { credentialId, secret });
}
export const hasPrfSecret = (userId: string) => secrets.has(userId);

async function aesKeyFrom(secret: Uint8Array): Promise<CryptoKey> {
  const raw = new Uint8Array(secret.byteLength);
  raw.set(secret);
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: HKDF_INFO }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export interface WrappedFolderKey { credentialId: string; x: string; iv: string; ct: string }

/** Encrypt the private folder key with the passkey's secret. */
export async function wrapKey(jwk: PrivateJwk, secret: Uint8Array, credentialId: string): Promise<WrappedFolderKey> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(credentialId) }, await aesKeyFrom(secret), plain));
  return { credentialId, x: jwk.x, iv: toB64u(iv), ct: toB64u(ct) };
}

/** Open it again: the private folder key, or null if this secret can't. */
export async function unwrapKey(w: WrappedFolderKey, secret: Uint8Array): Promise<PrivateJwk | null> {
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(w.iv), additionalData: new TextEncoder().encode(w.credentialId) }, await aesKeyFrom(secret), fromB64u(w.ct));
    const k = JSON.parse(new TextDecoder().decode(plain));
    return k && k.kty === 'OKP' && k.crv === 'X25519' && k.x === w.x && typeof k.d === 'string' ? k : null;
  } catch {
    return null;
  }
}

const getWrapped = async (userId: string): Promise<{ wrapped: WrappedFolderKey | null; credentialId: string | null } | null> => {
  const r = await fetch(`/api/folder-key/wrapped?userId=${encodeURIComponent(userId)}`, { credentials: 'include', cache: 'no-store' });
  const d = await r.json().catch(() => ({}));
  return r.ok && d.success ? { wrapped: d.wrapped || null, credentialId: d.credentialId || null } : null;
};

export type PasskeyKeyResult = 'stored' | 'already' | 'unlocked' | 'no-secret' | 'no-key' | 'no-copy' | 'failed';

/**
 * After a passkey ceremony on this page: a browser with the folder key
 * stores the passkey copy (when the server lacks this one); a browser
 * without it opens the copy and keeps the key.
 */
export async function syncFolderKeyWithPasskey(userId: string): Promise<PasskeyKeyResult> {
  const s = secrets.get(userId);
  if (!s) return 'no-secret';
  try {
    const current = await getWrapped(userId);
    if (!current) return 'failed';
    const local = await getFolderPrivateJwk(userId);
    if (local) {
      if (current.wrapped?.credentialId === s.credentialId && current.wrapped.x === local.x) return 'already';
      if (current.credentialId && current.credentialId !== s.credentialId) return 'failed';
      const w = await wrapKey(local, s.secret, s.credentialId);
      const r = await fetch('/api/folder-key/wrapped', {
        method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, ...w })
      });
      return r.ok ? 'stored' : 'failed';
    }
    if (!current.wrapped) return 'no-copy';
    if (current.wrapped.credentialId !== s.credentialId) return 'failed';
    const jwk = await unwrapKey(current.wrapped, s.secret);
    if (!jwk) return 'failed';
    await keepFolderKeyInBrowser(userId, jwk);
    return 'unlocked';
  } catch {
    return 'failed';
  }
}

// Safari opens a passkey prompt only straight from a click, so the prompt's
// options are fetched beforehand (preparePasskeyUnlock, when the button shows).
let prepared: { userId: string; options: PublicKeyCredentialRequestOptionsJSON; credentialId: string; at: number } | null = null;

/** Fetch what the unlock prompt needs, before the click. */
export async function preparePasskeyUnlock(userId: string): Promise<boolean> {
  try {
    const info = await getWrapped(userId);
    if (!info?.credentialId) return false;
    const o = await fetch('/api/passkey/discover', { method: 'POST', credentials: 'include' });
    if (!o.ok) return false;
    prepared = { userId, options: await o.json(), credentialId: info.credentialId, at: Date.now() };
    return true;
  } catch {
    return false;
  }
}

/**
 * A passkey prompt just for the secret (the user is already signed in):
 * "Set up" on the computer, "Unlock" on a phone. Run it from a click, after
 * preparePasskeyUnlock. → the result, or 'no-secret' if this passkey has no PRF.
 */
export async function passkeyUnlock(userId: string): Promise<PasskeyKeyResult> {
  if (!prepared || prepared.userId !== userId || Date.now() - prepared.at > 4 * 60 * 1000) {
    if (!(await preparePasskeyUnlock(userId))) return 'failed';
  }
  const p = prepared!;
  prepared = null;
  const assertion = await startAuthentication({
    optionsJSON: withPrf({ ...p.options, allowCredentials: [{ id: p.credentialId, type: 'public-key' }] })
  });
  const secret = takePrfSecret(assertion as unknown as { clientExtensionResults?: Record<string, unknown> });
  if (!secret) return 'no-secret';
  rememberPrfSecret(userId, assertion.id, secret);
  return syncFolderKeyWithPasskey(userId);
}
