/**
 * The browser GNAP client behind a patient's personal request page
 * (/r/:asId, group_requests.md §10.10). Its Ed25519 signing key is made
 * here, non-extractable, and kept in this browser's IndexedDB: an answer
 * can be collected only from the browser that asked (D13). The request's
 * progress is kept there too, so the requester can close the page and
 * come back. It also adds a document for the patient (§10.12): the file is
 * kept here until the patient's MAIA gives an upload token, then sent once.
 */
import { signRequest, jwkThumbprint, randomToken, interactionHash, sha256, type PublicJwk } from './httpsig';
import { newSealingKeyPair, openSealed, type SealedBox } from './sealedBox';

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

export type RequestStatus = 'verify' | 'waiting' | 'ready' | 'declined' | 'withdrawn' | 'expired'
  // Adding a document: an upload token is here / the document was accepted / it waits for the patient.
  | 'upload' | 'delivered' | 'held';

export interface DocumentDescriptor { kind: string; title: string; mediaType: string; size: number; sha256: string }

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
  /** Set when this request adds a document rather than asks for information. */
  document?: DocumentDescriptor;
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
      ...r, status: r.document ? 'upload' : 'ready', continueToken: undefined,
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

// ── Adding a document (§10.12) ──────────────────────────────────────────

export interface DocumentForm {
  name: string;
  organization: string;
  purpose: string;
  message: string;
  kind: string;
  title: string;
}

const uploadKey = (id: string) => `upload:${id}`;
const hexOf = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Offer a document. The file stays in this browser until the patient's MAIA
 * answers with an upload token (after the email check, for a new sender);
 * the grant request describes it exactly, SHA-256 included.
 */
export async function startDocument(asId: string, form: DocumentForm, file: File, returnUrl: string): Promise<SavedRequest> {
  const key = await getClientKey();
  const grantEndpoint = `${location.origin}/gnap/as/${asId}`;
  const clientNonce = randomToken();
  const known = await loadInstance(asId);
  const display = known ? known.displayName : [form.name.trim(), form.organization.trim()].filter(Boolean).join(', ');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const document: DocumentDescriptor = {
    kind: form.kind, title: form.title.trim(), mediaType: file.type, size: bytes.length, sha256: hexOf(await sha256(bytes))
  };
  const id = randomToken(9);
  // Kept here across the email check (a page load away).
  await kvSet(uploadKey(id), new Blob([bytes as BlobPart], { type: file.type }));
  const res = await signedCall(key, 'POST', grantEndpoint, {
    body: {
      access_token: { access: [{ type: ACCESS_TYPE, actions: ['add'], datatypes: ['document'], purpose: form.purpose, document }] },
      client: known ? known.id : { key: { proof: 'httpsig', jwk: key.jwk }, display: { name: display } },
      ...(known ? {} : { interact: { start: ['redirect'], finish: { method: 'redirect', uri: returnUrl, nonce: clientNonce } } }),
      ...(form.message.trim() ? { maia_message: form.message.trim() } : {})
    }
  });
  if (known && res.status === 401 && res.body?.error?.code === 'invalid_client') {
    await forgetInstance(asId);
    await kvSet(uploadKey(id), null);
    const named = form.name.trim() ? form : { ...form, name: known.displayName, organization: '' };
    return startDocument(asId, named, file, returnUrl);
  }
  if (res.status >= 400 && res.body?.error?.code !== 'request_denied') {
    await kvSet(uploadKey(id), null);
    throw new Error(res.body?.error?.description || `The document couldn't be offered (HTTP ${res.status})`);
  }
  const saved: SavedRequest = {
    id, asId, displayName: display, grantEndpoint, createdAt: new Date().toISOString(),
    what: 'document', why: form.purpose, status: 'verify', document,
    ...(res.body?.interact?.redirect
      ? { interact: { redirect: res.body.interact.redirect, clientNonce, serverNonce: res.body.interact.finish } }
      : {})
  };
  const next = applyResponse(saved, res);
  if (!res.body?.interact && next.status === 'verify') next.status = 'waiting';
  await saveRequest(next);
  return next;
}

/** Send the document once, on the upload token the patient's MAIA gave. */
export async function uploadDocument(r: SavedRequest): Promise<SavedRequest> {
  if (r.status !== 'upload' || !r.token?.location || !r.document) return r;
  const blob = await kvGet<Blob | null>(uploadKey(r.id));
  if (!blob) throw new Error('This browser no longer has the file. Offer the document again.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const key = await getClientKey();
  const headers: Record<string, string> = { 'content-type': r.document.mediaType, authorization: `GNAP ${r.token.value}` };
  const sig = await signRequest({ method: 'PUT', url: r.token.location, headers, body: bytes, privateKey: key.privateKey, kid: key.jwk.kid });
  const res = await fetch(r.token.location, { method: 'PUT', headers: { ...headers, ...sig }, body: bytes as BodyInit, credentials: 'omit', cache: 'no-store' });
  const out = await res.json().catch(() => ({}));
  let next: SavedRequest;
  if (res.status === 201) next = { ...r, status: out.status === 'accepted' ? 'delivered' : 'held', token: undefined };
  else if (res.status === 403 || (res.status === 401 && r.token.expiresAt < Date.now())) next = { ...r, status: 'declined', token: undefined };
  else throw new Error(out?.error?.description || `The document couldn't be sent (HTTP ${res.status})`);
  await kvSet(uploadKey(r.id), null);
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

// ── Group requests (§10.9) ───────────────────────────────────────────────
// One request to every member of a group. The group verifies the email and
// carries the request; each member's MAIA decides and answers sealed to this
// browser's X25519 key, which never leaves it. An answer that says "ready"
// holds a continuation at that member's MAIA, which this key alone can use.


export interface SealingKey { privateKey: CryptoKey; jwk: { kty: 'OKP'; crv: 'X25519'; x: string } }

/** This browser's sealing key, made on first use (private half non-extractable). */
export async function getSealingKey(): Promise<SealingKey> {
  const saved = await kvGet<SealingKey>('sealing-key');
  if (saved?.privateKey && saved.jwk?.x) return saved;
  let pair: CryptoKeyPair;
  try {
    pair = await newSealingKeyPair();
  } catch {
    throw new UnsupportedBrowserError('This browser cannot make the key a group request needs. Use a current Chrome, Edge, Safari or Firefox.');
  }
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const key: SealingKey = { privateKey: pair.privateKey, jwk: { kty: 'OKP', crv: 'X25519', x: String(pub.x) } };
  await kvSet('sealing-key', key);
  return key;
}

export interface GroupAnswer {
  id: string;
  status: 'ready' | 'unreadable';
  token?: { value: string; location: string; expiresAt: number };
  error?: string;
}

export interface GroupRequest {
  id: string;
  groupId: string;
  grantEndpoint: string;
  createdAt: string;
  what: string;
  why: string;
  status: 'verify' | 'sent' | 'withdrawn' | 'expired';
  continueUri?: string;
  continueToken?: string;
  nextPollAt?: number;
  interact?: { redirect: string; clientNonce: string; serverNonce?: string };
  counts?: { delivered: number; shared: number; declined: number };
  answers: GroupAnswer[];
}

const groupKey = (groupId: string) => `group-requests:${groupId}`;
export const loadGroupRequests = async (groupId: string) => (await kvGet<GroupRequest[]>(groupKey(groupId))) || [];
export async function saveGroupRequest(r: GroupRequest) {
  const plain: GroupRequest = JSON.parse(JSON.stringify(r));
  const all = await loadGroupRequests(plain.groupId);
  const i = all.findIndex((x) => x.id === plain.id);
  if (i >= 0) all[i] = plain; else all.push(plain);
  await kvSet(groupKey(plain.groupId), all);
}

export async function startGroupRequest(groupId: string, form: RequestForm, returnUrl: string): Promise<GroupRequest> {
  const key = await getClientKey();
  const seal = await getSealingKey();
  const grantEndpoint = `${location.origin}/gnap/group/${encodeURIComponent(groupId)}`;
  const clientNonce = randomToken();
  const display = [form.name.trim(), form.organization.trim()].filter(Boolean).join(', ');
  const res = await signedCall(key, 'POST', grantEndpoint, {
    body: {
      access_token: { access: [{ type: ACCESS_TYPE, actions: [form.datatype === 'notification-only' ? 'notify' : 'read'], datatypes: [form.datatype], purpose: form.purpose }] },
      client: { key: { proof: 'httpsig', jwk: key.jwk }, display: { name: display } },
      interact: { start: ['redirect'], finish: { method: 'redirect', uri: returnUrl, nonce: clientNonce } },
      maia_seal_jwk: seal.jwk,
      ...(form.message.trim() ? { maia_message: form.message.trim() } : {})
    }
  });
  if (res.status >= 400 || !res.body?.continue) throw new Error(res.body?.error?.description || `The request failed (HTTP ${res.status})`);
  const r: GroupRequest = {
    id: randomToken(9), groupId, grantEndpoint, createdAt: new Date().toISOString(),
    what: form.datatype, why: form.purpose, status: 'verify',
    continueUri: res.body.continue.uri, continueToken: res.body.continue.access_token?.value,
    nextPollAt: Date.now() + (res.body.continue.wait || 30) * 1000,
    interact: { redirect: res.body.interact?.redirect, clientNonce, serverNonce: res.body.interact?.finish },
    answers: []
  };
  await saveGroupRequest(r);
  return r;
}

/** Open new sealed answers and, for each "ready" one, trade its continuation
 *  for a key-bound token at that member's MAIA right away. */
async function collectAnswers(r: GroupRequest, boxes: Array<{ id: string; box: SealedBox }>): Promise<GroupAnswer[]> {
  const known = new Set(r.answers.map((a) => a.id));
  const fresh = boxes.filter((b) => !known.has(b.id));
  if (!fresh.length) return r.answers;
  const seal = await getSealingKey();
  const key = await getClientKey();
  const out = [...r.answers];
  for (const b of fresh) {
    try {
      const msg = JSON.parse(await openSealed(seal.privateKey, b.box));
      const uri = String(msg?.continue?.uri || '');
      // Only an https continuation (http on this machine, for development).
      if (msg?.kind !== 'ready' || !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(uri)) throw new Error('not a ready answer');
      const res = await signedCall(key, 'POST', uri, { token: msg.continue.access_token?.value });
      const at = res.body?.access_token;
      if (!at?.value) throw new Error(res.body?.error?.description || 'no token');
      out.push({ id: b.id, status: 'ready', token: { value: at.value, location: at.access?.[0]?.locations?.[0], expiresAt: Date.now() + (at.expires_in || 3600) * 1000 } });
    } catch (e) {
      out.push({ id: b.id, status: 'unreadable', error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

async function applyGroupResponse(r: GroupRequest, res: GnapResult): Promise<GroupRequest> {
  const b = res.body || {};
  if (b.continue) {
    const g = b.maia_group || {};
    return {
      ...r,
      status: g.state === 'sent' ? 'sent' : r.status,
      continueUri: b.continue.uri,
      continueToken: b.continue.access_token?.value,
      nextPollAt: Date.now() + (b.continue.wait || 60) * 1000,
      counts: g.counts || r.counts,
      answers: await collectAnswers(r, Array.isArray(g.answers) ? g.answers : [])
    };
  }
  if (b.error?.code === 'invalid_continuation') return { ...r, status: 'expired', continueToken: undefined };
  return r; // too_fast and transient errors: keep waiting
}

export async function finishGroupInteraction(r: GroupRequest, interactRef: string, hash: string): Promise<GroupRequest> {
  if (!r.interact?.serverNonce || !r.continueUri || !r.continueToken) throw new Error('This request is not waiting for an email check');
  const expected = await interactionHash(r.interact.clientNonce, r.interact.serverNonce, interactRef, r.grantEndpoint);
  if (expected !== hash) throw new Error('The email check came back altered. Make the request again.');
  const key = await getClientKey();
  const res = await signedCall(key, 'POST', r.continueUri, { token: r.continueToken, body: { interact_ref: interactRef } });
  const next = await applyGroupResponse({ ...r, interact: undefined }, res);
  await saveGroupRequest(next).catch(() => {});
  return next;
}

export async function pollGroup(r: GroupRequest): Promise<GroupRequest> {
  if (!r.continueUri || !r.continueToken) return r;
  const key = await getClientKey();
  const res = await signedCall(key, 'POST', r.continueUri, { token: r.continueToken });
  const next = await applyGroupResponse(r, res);
  await saveGroupRequest(next).catch(() => {});
  return next;
}

export async function withdrawGroup(r: GroupRequest): Promise<GroupRequest> {
  if (r.continueUri && r.continueToken) {
    const key = await getClientKey();
    await signedCall(key, 'DELETE', r.continueUri, { token: r.continueToken }).catch(() => null);
  }
  const next: GroupRequest = { ...r, status: 'withdrawn', continueToken: undefined };
  await saveGroupRequest(next);
  return next;
}

/** Read one member's answer at their MAIA. */
export const readGroupAnswer = (groupId: string, a: GroupAnswer): Promise<Answer> =>
  readAnswer({ id: a.id, asId: groupId, grantEndpoint: '', createdAt: '', what: '', why: '', status: 'ready', token: a.token } as SavedRequest);
