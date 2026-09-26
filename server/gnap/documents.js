/**
 * Documents others add to a patient's MAIA (group_requests.md §10.12, D15,
 * I-32). A document arrives over the same door as any request, with
 * actions ["add"]; the patient's cards decide. What the server keeps is
 * only a box sealed to the patient's folder key, whose private half is in
 * the patient's folder and browser, never here. The readable bytes exist
 * in memory only while the upload is checked: they are never parsed,
 * rendered, indexed or logged.
 *
 * The patient's browser opens a held box for a preview, and writes an
 * accepted one to Received/ in the folder, then the hold is deleted.
 */
import { createHash } from 'crypto';
import { GnapError } from './grants.js';
import { sealBytesTo, FOLDER_DOCUMENT_INFO, isX25519PublicJwk } from '../utils/sealed-box.js';

export const DOCUMENT_KINDS = Object.freeze(['radiology-report', 'lab-report', 'visit-note', 'discharge-summary', 'imaging', 'other']);
export const KIND_WORDS = Object.freeze({
  'radiology-report': 'a radiology report', 'lab-report': 'a lab report', 'visit-note': 'a visit note',
  'discharge-summary': 'a discharge summary', imaging: 'an image', other: 'a document'
});
/** v1 accepts these, by content, not by the header's word (D15). */
export const DOCUMENT_TYPES = Object.freeze({ 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'text/plain': 'txt' });
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const MAX_TITLE = 120;
export const MAX_HOLDS = 10;
export const MAX_HELD_BYTES = 100 * 1024 * 1024;
export const MAX_PER_SENDER_PER_DAY = 5;
export const HOLD_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

/** The `document` descriptor of an add request (§10.3). Refused, never coerced. */
export function parseDocumentDescriptor(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new GnapError('invalid_request', 'An add request needs a document descriptor');
  if (!DOCUMENT_KINDS.includes(d.kind)) throw new GnapError('invalid_request', `document.kind must be one of: ${DOCUMENT_KINDS.join(', ')}`);
  if (!Object.hasOwn(DOCUMENT_TYPES, d.mediaType)) {
    throw new GnapError('invalid_request', `document.mediaType must be one of: ${Object.keys(DOCUMENT_TYPES).join(', ')}`);
  }
  if (!Number.isInteger(d.size) || d.size < 1 || d.size > MAX_DOCUMENT_BYTES) {
    throw new GnapError('invalid_request', `document.size must be 1 to ${MAX_DOCUMENT_BYTES} bytes`);
  }
  if (typeof d.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(d.sha256)) throw new GnapError('invalid_request', 'document.sha256 must be 64 lowercase hex digits');
  const title = typeof d.title === 'string' ? d.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TITLE) : '';
  return { kind: d.kind, title, mediaType: d.mediaType, size: d.size, sha256: d.sha256 };
}

export const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

/** Is the content really the declared type? Magic bytes, and for text:
 *  valid UTF-8 with no NUL. */
export function matchesDeclaredType(buf, mediaType) {
  const starts = (...bytes) => buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b);
  if (mediaType === 'application/pdf') return starts(0x25, 0x50, 0x44, 0x46, 0x2d); // %PDF-
  if (mediaType === 'image/jpeg') return starts(0xff, 0xd8, 0xff);
  if (mediaType === 'image/png') return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (mediaType === 'text/plain') {
    if (buf.includes(0)) return false;
    try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch { return false; }
  }
  return false;
}

/** Seal a document to the patient's folder key (§7). */
export const sealDocument = (folderKeyJwk, bytes) => sealBytesTo(folderKeyJwk, bytes, FOLDER_DOCUMENT_INFO);

export const hasFolderKey = (userDoc) => isX25519PublicJwk(userDoc?.folderKeyJwk);

export const holdKeyFor = (userId, holdId) => `${userId}/received/${holdId}.sealed.json`;

// ── Where the sealed boxes are kept ─────────────────────────────────────

/** Spaces (S3), under the patient's own prefix (deleted with the account). */
export function createSpacesHoldStore({ getClient, bucket }) {
  return {
    async put(key, text) {
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      await (await getClient()).send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: text, ContentType: 'application/json' }));
    },
    async get(key) {
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      try {
        const out = await (await getClient()).send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
        return await out.Body.transformToString();
      } catch (e) {
        if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },
    async del(key) {
      const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      await (await getClient()).send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
    }
  };
}

/** For tests and for a host without Spaces. */
export function createMemoryHoldStore() {
  const objects = new Map();
  return {
    objects,
    async put(key, text) { objects.set(key, String(text)); },
    async get(key) { return objects.has(key) ? objects.get(key) : null; },
    async del(key) { objects.delete(key); }
  };
}

// ── Limits (§10.12) ─────────────────────────────────────────────────────

/** A document waiting on the server: held for the patient, or accepted and
 *  not yet in the folder. */
export const isLiveHold = (r) => !!r?.document && ['held', 'accepted'].includes(r.document.state);

/**
 * Would one more document of `size` bytes from `senderEmail` go over the
 * limits? → null, or the reason. At most 10 holds and 100 MB waiting per
 * patient, and a few documents a day from one sender.
 */
export function capExceeded(requests, { size, senderEmail, now }) {
  const live = requests.filter(isLiveHold);
  if (live.length >= MAX_HOLDS) return 'Too many documents are waiting for this person';
  if (live.reduce((n, r) => n + (r.document.size || 0), 0) + size > MAX_HELD_BYTES) return 'Too many documents are waiting for this person';
  const email = String(senderEmail || '').toLowerCase();
  const today = requests.filter((r) => r.document && r.document.heldAt && now - Date.parse(r.document.heldAt) < DAY
    && String(r.requester?.email || '').toLowerCase() === email);
  if (email && today.length >= MAX_PER_SENDER_PER_DAY) return 'Too many documents from you today';
  return null;
}

/**
 * Daily: documents neither decided nor saved to the folder within 90 days
 * are deleted (§7, D10). A held one is marked expired; an accepted one that
 * never reached the folder keeps its decision and loses its hold.
 */
export async function sweepExpiredHolds({ cloudant, holds, now = Date.now() }) {
  const all = ((await cloudant.getAllDocuments('maia_as_requests').catch(() => [])) || []).filter(isLiveHold);
  let swept = 0;
  for (const r of all) {
    if (now - Date.parse(r.document.heldAt || r.receivedAt) < HOLD_TTL_MS) continue;
    try {
      await holds.del(r.document.holdKey);
      const at = new Date(now).toISOString();
      r.document = { ...r.document, state: 'expired', expiredAt: at, holdKey: null };
      if (r.status === 'pending') { r.status = 'expired'; r.decidedAt = at; }
      await cloudant.saveDocument('maia_as_requests', r);
      swept++;
    } catch (e) {
      console.warn('[documents] hold sweep failed:', e?.message || e);
    }
  }
  return swept;
}
