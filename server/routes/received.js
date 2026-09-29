/**
 * The patient's side of documents others add (group_requests.md §7, §10.12):
 * the folder key, and the sealed holds the browser opens and writes to the
 * folder. The server holds the public half of the folder key; the private
 * half lives in the folder (maia-folder-key.json) and the browser. The
 * server may also keep a copy of the private half encrypted with a secret
 * only the patient's passkey produces (WebAuthn PRF), so a phone or Safari,
 * where there is no folder, can open member messages: the server can't
 * decrypt that copy.
 *
 *   GET  /api/folder-key                the public half the server seals to
 *   POST /api/folder-key                { publicJwk } — set it (setup step 3,
 *                                       or a folder connected in a new browser)
 *   GET  /api/folder-key/wrapped        the passkey-encrypted copy, if any
 *   PUT  /api/folder-key/wrapped        { credentialId, x, iv, ct } — keep one,
 *                                       for this account's passkey and folder key
 *   GET  /api/received                  accepted documents not yet in the folder
 *   GET  /api/received/:id/box          one sealed box (a held one, for a preview)
 *   POST /api/received/:id/delivered    { fileName } — it is in Received/; delete the hold
 * Also answers the user's MAIA collected from other MAIAs (P11, gnap-out.js):
 * the same sealed hold, the same path into Received/ (I-33).
 * Feature `documents-in`. Every route acts only for the session's own account.
 */
import { requestedUserId } from '../utils/api-guard.js';
import { isX25519PublicJwk } from '../utils/sealed-box.js';
import { isLiveHold } from '../gnap/documents.js';
import { GNAP_DB } from '../gnap/store.js';

/** What a collected answer is, for its file name in Received/. */
const ANSWER_LABELS = {
  'patient-summary': 'Patient Summary', 'meds-allergies': 'Medications and allergies',
  'not-sensitive': 'Record except sensitive categories', everything: 'Whole record', 'notification-only': 'Note'
};

const USERS_DB = 'maia_users';

/** The passkey copy of the folder key, when it is for the account's current
 *  passkey and current folder key (else it's stale, and null). */
export const wrappedFor = (u) => {
  const w = u?.folderKeyWrapped;
  if (!w || w.v !== 1 || !u.credentialID || w.credentialId !== u.credentialID || w.x !== u.folderKeyJwk?.x) return null;
  return { v: 1, credentialId: w.credentialId, x: w.x, iv: w.iv, ct: w.ct, at: w.at || null };
};
const AS_REQUESTS_DB = 'maia_as_requests';
const MAX_FILE_NAME = 160;

export default function setupReceivedRoutes(app, { cloudant, holds, auditLog = { logEvent: () => {} }, now = () => Date.now() }) {
  const sessionUser = (req, res) => {
    const userId = requestedUserId(req) || req.session?.userId;
    if (!userId || req.session?.userId !== userId) {
      res.status(401).json({ success: false, error: 'NOT_AUTHENTICATED' });
      return null;
    }
    return userId;
  };
  const log = (type, userId, details) => { try { auditLog.logEvent({ type, userId, details }); } catch { /* best-effort */ } };
  const ownRequest = async (userId, id) => {
    const r = await cloudant.getDocument(AS_REQUESTS_DB, id).catch(() => null);
    return r && r.type === 'as_request' && r.userId === userId && r.document ? r : null;
  };
  // An answer collected from another MAIA (og_<id> in maia_gnap).
  const ownAnswer = async (userId, id) => {
    if (!String(id).startsWith('og_')) return null;
    const og = await cloudant.getDocument(GNAP_DB, id).catch(() => null);
    return og && og.type === 'gnap_out_request' && og.userId === userId && og.hold ? og : null;
  };
  const answerItem = (og) => ({
    id: og._id, kind: 'answer', label: `${ANSWER_LABELS[og.access.datatypes[0]] || 'Answer'} (requested)`, title: '',
    mediaType: 'text/plain', size: og.hold.size, sha256: og.hold.sha256, receivedAt: og.answeredAt || og.createdAt, acceptedAt: og.answeredAt || null,
    sender: { name: og.label || new URL(og.grantEndpoint).host, email: null, emailVerified: false }
  });

  app.get('/api/folder-key', async (req, res) => {
    const userId = sessionUser(req, res);
    if (!userId) return;
    try {
      const u = await cloudant.getDocument(USERS_DB, userId);
      if (!u) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, publicJwk: isX25519PublicJwk(u.folderKeyJwk) ? u.folderKeyJwk : null });
    } catch {
      res.status(500).json({ success: false, error: 'FOLDER_KEY_FAILED' });
    }
  });

  // A new key replaces the old one: documents still sealed to the old key
  // can be opened only by a browser or folder that still has it.
  app.post('/api/folder-key', async (req, res) => {
    const userId = sessionUser(req, res);
    if (!userId) return;
    const jwk = req.body?.publicJwk;
    if (!isX25519PublicJwk(jwk)) return res.status(400).json({ success: false, error: 'INVALID_KEY' });
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const u = await cloudant.getDocument(USERS_DB, userId);
        if (!u) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
        if (u.folderKeyJwk?.x === jwk.x) return res.json({ success: true, replaced: false });
        const replaced = !!u.folderKeyJwk;
        const at = new Date(now()).toISOString();
        u.folderKeyJwk = { kty: 'OKP', crv: 'X25519', x: jwk.x };
        u.folderKeyCreatedAt = at;
        // The passkey copy was of the old key.
        delete u.folderKeyWrapped;
        u.updatedAt = at;
        try {
          await cloudant.saveDocument(USERS_DB, u);
        } catch (e) {
          if (e?.statusCode === 409 && attempt < 3) continue;
          throw e;
        }
        log('folder_key_set', userId, { replaced });
        return res.json({ success: true, replaced });
      }
      return res.status(409).json({ success: false, error: 'CONFLICT' });
    } catch {
      res.status(500).json({ success: false, error: 'FOLDER_KEY_FAILED' });
    }
  });

  // The folder key's private half, encrypted in the browser with a key
  // derived from the passkey's PRF secret. Opaque here: only the passkey
  // (on any device it syncs to) can open it.
  app.get('/api/folder-key/wrapped', async (req, res) => {
    const userId = sessionUser(req, res);
    if (!userId) return;
    try {
      const u = await cloudant.getDocument(USERS_DB, userId);
      if (!u) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, wrapped: wrappedFor(u), credentialId: u.credentialID || null });
    } catch {
      res.status(500).json({ success: false, error: 'FOLDER_KEY_FAILED' });
    }
  });

  app.put('/api/folder-key/wrapped', async (req, res) => {
    const userId = sessionUser(req, res);
    if (!userId) return;
    const { credentialId, x, iv, ct } = req.body || {};
    const b64u = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v);
    if (!b64u(credentialId, 1400) || !b64u(x, 64) || !b64u(iv, 32) || !b64u(ct, 600)) {
      return res.status(400).json({ success: false, error: 'INVALID_WRAPPED_KEY' });
    }
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const u = await cloudant.getDocument(USERS_DB, userId);
        if (!u) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
        // Only for this account's own passkey and its current folder key.
        if (credentialId !== u.credentialID) return res.status(409).json({ success: false, error: 'NOT_THIS_PASSKEY' });
        if (x !== u.folderKeyJwk?.x) return res.status(409).json({ success: false, error: 'NOT_THIS_FOLDER_KEY' });
        const at = new Date(now()).toISOString();
        u.folderKeyWrapped = { v: 1, credentialId, x, iv, ct, at };
        u.updatedAt = at;
        try {
          await cloudant.saveDocument(USERS_DB, u);
        } catch (e) {
          if (e?.statusCode === 409 && attempt < 3) continue;
          throw e;
        }
        log('folder_key_wrapped', userId, {});
        return res.json({ success: true });
      }
      return res.status(409).json({ success: false, error: 'CONFLICT' });
    } catch {
      res.status(500).json({ success: false, error: 'FOLDER_KEY_FAILED' });
    }
  });

  app.get('/api/received', async (req, res) => {
    const userId = sessionUser(req, res);
    if (!userId) return;
    try {
      const mine = ((await cloudant.getAllDocuments(AS_REQUESTS_DB).catch(() => [])) || [])
        .filter((r) => r?.type === 'as_request' && r.userId === userId && r.document?.state === 'accepted');
      const answers = ((await cloudant.getAllDocuments(GNAP_DB).catch(() => [])) || [])
        .filter((d) => d?.type === 'gnap_out_request' && d.userId === userId && d.hold?.state === 'accepted');
      res.set('Cache-Control', 'no-store');
      res.json({
        success: true,
        documents: [...answers.map(answerItem), ...mine.map((r) => ({
          id: r._id, kind: r.document.kind, title: r.document.title || '', mediaType: r.document.mediaType,
          size: r.document.size, sha256: r.document.sha256, receivedAt: r.receivedAt, acceptedAt: r.document.acceptedAt || r.decidedAt || null,
          sender: { name: r.requester?.name || null, email: r.requester?.emailVerified ? r.requester.email : null, emailVerified: !!r.requester?.emailVerified }
        }))]
      });
    } catch {
      res.status(500).json({ success: false, error: 'RECEIVED_FAILED' });
    }
  });

  app.get('/api/received/:id/box', async (req, res) => {
    const userId = sessionUser(req, res);
    if (!userId) return;
    try {
      const og = await ownAnswer(userId, req.params.id);
      const r = og ? null : await ownRequest(userId, req.params.id);
      const holdKey = og ? (og.hold.state === 'accepted' ? og.hold.holdKey : null) : (r && isLiveHold(r) ? r.document.holdKey : null);
      if (!holdKey) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
      const text = await holds.get(holdKey);
      if (!text) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
      res.set('Cache-Control', 'no-store');
      res.type('json').send(text);
    } catch {
      res.status(500).json({ success: false, error: 'BOX_FAILED' });
    }
  });

  app.post('/api/received/:id/delivered', async (req, res) => {
    const userId = sessionUser(req, res);
    if (!userId) return;
    try {
      const fileName = String(req.body?.fileName || '').replace(/[\u0000-\u001f\u007f/\\]/g, ' ').trim().slice(0, MAX_FILE_NAME);
      const og = await ownAnswer(userId, req.params.id);
      if (og) {
        if (og.hold.state === 'delivered') return res.json({ success: true });
        try { await holds.del(og.hold.holdKey); } catch (e) { console.warn('[received] hold delete failed:', e?.message || e); }
        og.hold = { ...og.hold, state: 'delivered', deliveredAt: new Date(now()).toISOString(), fileName: fileName || null, holdKey: null };
        await cloudant.saveDocument(GNAP_DB, og);
        log('answer_delivered', userId, { request: og._id });
        return res.json({ success: true });
      }
      const r = await ownRequest(userId, req.params.id);
      if (!r) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
      if (r.document.state === 'delivered') return res.json({ success: true });
      if (r.document.state !== 'accepted') return res.status(400).json({ success: false, error: 'NOT_ACCEPTED' });
      try { await holds.del(r.document.holdKey); } catch (e) { console.warn('[received] hold delete failed:', e?.message || e); }
      r.document = { ...r.document, state: 'delivered', deliveredAt: new Date(now()).toISOString(), fileName: fileName || null, holdKey: null };
      await cloudant.saveDocument(AS_REQUESTS_DB, r);
      log('document_delivered', userId, { request: r._id });
      res.json({ success: true });
    } catch {
      res.status(500).json({ success: false, error: 'DELIVERED_FAILED' });
    }
  });
}
