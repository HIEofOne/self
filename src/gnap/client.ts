/**
 * The browser GNAP client behind a patient's personal request page
 * (/r/:asId, group_requests.md §10.10). Its Ed25519 signing key is made
 * here, non-extractable, and kept in this browser's IndexedDB: an answer
 * can be collected only from the browser that asked (D13). The request's
 * progress is kept there too, so the requester can close the page and
 * come back.
 */
import { signRequest, jwkThumbprint, randomToken, interactionHash, type PublicJwk } from './httpsig';

export const ACCESS_TYPE = 'urn:maia:access:record:v1';

// ── IndexedDB ────────────────────────────────────────────────────────────

const DB_NAME = 'maia-gnap-client';
const STORE = 'kv';

const openDb = () => new Promise<IDBDatabase>((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => req.result.createObjectStore(STORE);
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const kvGet = async <T>(key: string): Promise<T | undefined> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE).objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result as T | undefined);
    r.onerror = () => reject(r.error);
  });
};
const kvSet = async (key: string, value: unknown) => {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

// ── The signing key ──────────────────────────────────────────────────────

export interface ClientKey { privateKey: CryptoKey; jwk: PublicJwk }

export class UnsupportedBrowserError extends Error {}

/** This browser's signing key, made on first use (private half non-extractable). */
export async function getClientKey(): Promise<ClientKey> {
  const saved = await kvGet<ClientKey>('signing-key');
  if (saved?.privateKey && saved.jwk?.kid) return saved;
  let pair: CryptoKeyPair;
  try {
    pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']) as CryptoKeyPair;
  } catch {
    throw new UnsupportedBrowserError('This browser cannot make the key a request needs. Use a current Chrome, Edge, Safari or Firefox.');
  }
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const base = { kty: 'OKP' as const, crv: 'Ed25519' as const, x: String(pub.x) };
  const key: ClientKey = { privateKey: pair.privateKey, jwk: { ...base, kid: await jwkThumbprint(base) } };
  await kvSet('signing-key', key);
  return key;
}

// ── Signed calls ─────────────────────────────────────────────────────────

export interface GnapResult { status: number; body: any }

async function signedCall(key: ClientKey, method: string, url: string, { body = null as unknown, token = null as string | null } = {}): Promise<GnapResult> {
  const text = body ? JSON.stringify(body) : null;
  const headers: Record<string, string> = {
    ...(text ? { 'content-type': 'application/json' } : {}),
    ...(token ? { authorization: `GNAP ${token}` } : {})
  };
  const sig = await signRequest({ method, url, headers, body: text, privateKey: key.privateKey, kid: key.jwk.kid });
  const res = await fetch(url, { method, headers: { ...headers, ...sig }, body: text, credentials: 'omit', cache: 'no-store' });
  const out = res.status === 204 ? {} : await res.json().catch(() => ({}));
  return { status: res.status, body: out };
}

// ── A request's saved progress ───────────────────────────────────────────

export type RequestStatus = 'verify' | 'waiting' | 'ready' | 'declined' | 'withdrawn' | 'expired';

export interface SavedRequest {
  id: string;
  asId: string;
  displayName?: string;
  grantEndpoint: string;
  createdAt: string;
  what: string;
  why: string;
  status: RequestStatus;
  continueUri?: string;
  continueToken?: string;
  nextPollAt?: number;
  interact?: { redirect: string; clientNonce: string; serverNonce?: string };
  token?: { value: string; location: string; expiresAt: number };
}

const requestsKey = (asId: string) => `requests:${asId}`;

// ── Recognition (§10.6) ──────────────────────────────────────────────────
// After an email check the AS gives this browser an instance_id; the next
// request to the same link presents it instead of a new code.

export interface SavedInstance { id: string; displayName: string }
const instanceKey = (asId: string) => `instance:${asId}`;
export const loadInstance = async (asId: string) => (await kvGet<SavedInstance>(instanceKey(asId))) || null;
export const forgetInstance = (asId: string) => kvSet(instanceKey(asId), null);
const rememberInstance = async (r: SavedRequest, res: GnapResult) => {
  const id = res.body?.instance_id;
  if (typeof id === 'string' && id) await kvSet(instanceKey(r.asId), { id, displayName: r.displayName || '' }).catch(() => {});
};
export const loadRequests = async (asId: string) => (await kvGet<SavedRequest[]>(requestsKey(asId))) || [];
export async function saveRequest(r: SavedRequest) {
  // A plain copy: the page hands in Vue-reactive objects, which IndexedDB
  // can't clone (and a token the AS just issued must not be lost to that).
  const plain: SavedRequest = JSON.parse(JSON.stringify(r));
  const all = await loadRequests(plain.asId);
  const i = all.findIndex((x) => x.id === plain.id);
  if (i >= 0) all[i] = plain; else all.push(plain);
  await kvSet(requestsKey(plain.asId), all);
}

/** Apply a grant or continue response to the saved request. */
export function applyResponse(r: SavedRequest, res: GnapResult, now = Date.now()): SavedRequest {
  const b = res.body || {};
  if (b.access_token?.value) {
    return {
      ...r, status: 'ready', continueToken: undefined,
      token: { value: b.access_token.value, location: b.access_token.access?.[0]?.locations?.[0], expiresAt: now + (b.access_token.expires_in || 3600) * 1000 }
    };
  }
  if (b.continue) {
    return {
      ...r,
      status: r.status === 'verify' && b.interact ? 'verify' : 'waiting',
      continueUri: b.continue.uri,
      continueToken: b.continue.access_token?.value,
      nextPollAt: now + (b.continue.wait || 60) * 1000
    };
  }
  const code = b.error?.code;
  if (code === 'request_denied') return { ...r, status: 'declined', continueToken: undefined };
  if (code === 'invalid_continuation') return { ...r, status: 'expired', continueToken: undefined };
  return r; // too_fast and transient errors: keep waiting
}

// ── The grant, continue, cancel and read ─────────────────────────────────

export interface RequestForm {
  name: string;
  organization: string;
  datatype: string;
  purpose: string;
  message: string;
}

/** Ask. A first-time requester is then sent to verify an email (and may
 *  add credits there), and the AS brings them back to `returnUrl`. A
 *  recognized one skips that, unless they want to add credits. */
export async function startRequest(asId: string, form: RequestForm, returnUrl: string, { withCredits = false } = {}): Promise<SavedRequest> {
  const key = await getClientKey();
  const grantEndpoint = `${location.origin}/gnap/as/${asId}`;
  const clientNonce = randomToken();
  const known = await loadInstance(asId);
  const display = known ? known.displayName : [form.name.trim(), form.organization.trim()].filter(Boolean).join(', ');
  const interact = !known || withCredits;
  const res = await signedCall(key, 'POST', grantEndpoint, {
    body: {
      access_token: { access: [{ type: ACCESS_TYPE, actions: [form.datatype === 'notification-only' ? 'notify' : 'read'], datatypes: [form.datatype], purpose: form.purpose }] },
      client: known ? known.id : { key: { proof: 'httpsig', jwk: key.jwk }, display: { name: display } },
      ...(interact ? { interact: { start: ['redirect'], finish: { method: 'redirect', uri: returnUrl, nonce: clientNonce } } } : {}),
      ...(form.message.trim() ? { maia_message: form.message.trim() } : {})
    }
  });
  // No longer recognized (the patient chose Forget, or changed the link):
  // start over as a first-time requester.
  if (known && res.status === 401 && res.body?.error?.code === 'invalid_client') {
    await forgetInstance(asId);
    const named = form.name.trim() ? form : { ...form, name: known.displayName, organization: '' };
    return startRequest(asId, named, returnUrl);
  }
  if (res.status >= 400 && res.body?.error?.code !== 'request_denied') {
    throw new Error(res.body?.error?.description || `The request failed (HTTP ${res.status})`);
  }
  const saved: SavedRequest = {
    id: randomToken(9), asId, displayName: display, grantEndpoint, createdAt: new Date().toISOString(),
    what: form.datatype, why: form.purpose, status: 'verify',
    ...(res.body?.interact?.redirect
      ? { interact: { redirect: res.body.interact.redirect, clientNonce, serverNonce: res.body.interact.finish } }
      : {})
  };
  const next = applyResponse(saved, res);
  if (!res.body?.interact && next.status === 'verify') next.status = 'waiting';
  await saveRequest(next);
  return next;
}

/** Back from the email check: confirm the hash, then continue at once. */
export async function finishInteraction(r: SavedRequest, interactRef: string, hash: string): Promise<SavedRequest> {
  if (!r.interact?.serverNonce || !r.continueUri || !r.continueToken) throw new Error('This request is not waiting for an email check');
  const expected = await interactionHash(r.interact.clientNonce, r.interact.serverNonce, interactRef, r.grantEndpoint);
  if (expected !== hash) throw new Error('The email check came back altered. Make the request again.');
  const key = await getClientKey();
  const res = await signedCall(key, 'POST', r.continueUri, { token: r.continueToken, body: { interact_ref: interactRef } });
  await rememberInstance(r, res);
  const next = applyResponse({ ...r, status: 'waiting', interact: undefined }, res);
  await saveRequest(next).catch(() => { /* the answer is still shown now */ });
  return next;
}

/** Ask again whether there is an answer (respecting the wait given). */
export async function poll(r: SavedRequest): Promise<SavedRequest> {
  if (!r.continueUri || !r.continueToken) return r;
  const key = await getClientKey();
  const res = await signedCall(key, 'POST', r.continueUri, { token: r.continueToken });
  await rememberInstance(r, res);
  const next = applyResponse(r, res);
  await saveRequest(next).catch(() => { /* the answer is still shown now */ });
  return next;
}

export async function withdraw(r: SavedRequest): Promise<SavedRequest> {
  if (r.continueUri && r.continueToken) {
    const key = await getClientKey();
    await signedCall(key, 'DELETE', r.continueUri, { token: r.continueToken }).catch(() => null);
  }
  const next: SavedRequest = { ...r, status: 'withdrawn', continueToken: undefined };
  await saveRequest(next);
  return next;
}

export interface Answer { datatype: string; text: string; retrievedAt: string; attribution: string }

/** Read the answer from the patient's MAIA with the key-bound token. */
export async function readAnswer(r: SavedRequest): Promise<Answer> {
  if (!r.token?.location) throw new Error('No answer to read');
  const key = await getClientKey();
  const res = await signedCall(key, 'GET', r.token.location, { token: r.token.value });
  if (res.status !== 200) {
    const code = res.body?.error?.code;
    throw Object.assign(new Error(
      code === 'invalid_token' ? 'This answer is no longer available: it expired, or the patient stopped sharing it.'
        : code === 'not_available' ? 'The patient has nothing to share of this kind yet.'
          : 'The answer could not be read.'
    ), { code });
  }
  return res.body as Answer;
}
