/**
 * The patient's side of documents others add (group_requests.md §7, §10.12):
 * the folder key, and the sealed holds the browser opens and writes to the
 * folder. The server holds only the public half of the folder key; the
 * private half lives in the folder (maia-folder-key.json) and the browser.
 *
 *   GET  /api/folder-key                the public half the server seals to
 *   POST /api/folder-key                { publicJwk } — set it (setup step 3,
 *                                       or a folder connected in a new browser)
 *   GET  /api/received                  accepted documents not yet in the folder
 *   GET  /api/received/:id/box          one sealed box (a held one, for a preview)
 *   POST /api/received/:id/delivered    { fileName } — it is in Received/; delete the hold
 * Feature `documents-in`. Every route acts only for the session's own account.
 */
import { requestedUserId } from '../utils/api-guard.js';
import { isX25519PublicJwk } from '../utils/sealed-box.js';
import { isLiveHold } from '../gnap/documents.js';

const USERS_DB = 'maia_users';
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

  app.get('/api/received', async (req, res) => {
    const userId = sessionUser(req, res);
    if (!userId) return;
    try {
      const mine = ((await cloudant.getAllDocuments(AS_REQUESTS_DB).catch(() => [])) || [])
        .filter((r) => r?.type === 'as_request' && r.userId === userId && r.document?.state === 'accepted');
      res.set('Cache-Control', 'no-store');
      res.json({
        success: true,
        documents: mine.map((r) => ({
          id: r._id, kind: r.document.kind, title: r.document.title || '', mediaType: r.document.mediaType,
          size: r.document.size, sha256: r.document.sha256, receivedAt: r.receivedAt, acceptedAt: r.document.acceptedAt || r.decidedAt || null,
          sender: { name: r.requester?.name || null, email: r.requester?.emailVerified ? r.requester.email : null, emailVerified: !!r.requester?.emailVerified }
        }))
      });
    } catch {
      res.status(500).json({ success: false, error: 'RECEIVED_FAILED' });
    }
  });

  app.get('/api/received/:id/box', async (req, res) => {
    const userId = sessionUser(req, res);
    if (!userId) return;
    try {
      const r = await ownRequest(userId, req.params.id);
      if (!r || !isLiveHold(r) || !r.document.holdKey) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
      const text = await holds.get(r.document.holdKey);
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
      const r = await ownRequest(userId, req.params.id);
      if (!r) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
      if (r.document.state === 'delivered') return res.json({ success: true });
      if (r.document.state !== 'accepted') return res.status(400).json({ success: false, error: 'NOT_ACCEPTED' });
      const fileName = String(req.body?.fileName || '').replace(/[\u0000-\u001f\u007f/\\]/g, ' ').trim().slice(0, MAX_FILE_NAME);
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
