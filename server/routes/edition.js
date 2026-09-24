/**
 * Edition routes (Documentation/group_requests.md §4.1).
 *
 * GET /api/edition — which edition this server runs and which features are
 * on. Public: the welcome page reads it before sign-in. With a session it
 * also reflects the user's own unlocks.
 *
 * POST /api/user-features — the user turns an unlockable feature on or
 * off. Only the user's own click writes this (I-27): the private AI can
 * suggest a feature, never turn it on. Turning a feature off hides it
 * again; it deletes nothing.
 */
import { describeEdition, featureMode } from '../edition.js';
import { requestedUserId } from '../utils/api-guard.js';

const USERS_DB = 'maia_users';

export default function setupEditionRoutes(app, cloudant, auditLog = null) {
  app.get('/api/edition', async (req, res) => {
    let userDoc = null;
    const userId = req.session?.userId;
    if (userId) {
      try {
        userDoc = await cloudant.getDocument(USERS_DB, userId);
      } catch (e) {
        console.warn('[edition] could not load user for /api/edition:', e?.message || e);
      }
    }
    res.json({ success: true, ...describeEdition(userDoc) });
  });

  app.post('/api/user-features', async (req, res) => {
    const userId = requestedUserId(req) || req.session?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'NOT_AUTHENTICATED', message: 'Sign in required' });
    }
    const { feature, on } = req.body || {};
    if (typeof on !== 'boolean') {
      return res.status(400).json({ success: false, error: 'INVALID_REQUEST', message: '`on` must be true or false' });
    }
    if (featureMode(feature) !== 'unlockable') {
      return res.status(400).json({ success: false, error: 'NOT_UNLOCKABLE', feature });
    }
    const via = req.body.via === 'advisor' ? 'advisor' : 'settings';

    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const doc = await cloudant.getDocument(USERS_DB, userId);
        if (!doc) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
        const now = new Date().toISOString();
        doc.features = { ...(doc.features || {}) };
        doc.features[feature] = on
          ? { enabledAt: now, via }
          : { ...(doc.features[feature] || {}), enabledAt: null, disabledAt: now, via };
        doc.updatedAt = now;
        try {
          await cloudant.saveDocument(USERS_DB, doc);
        } catch (e) {
          if (e?.statusCode === 409 && attempt < 2) continue;
          throw e;
        }
        auditLog?.logEvent?.({
          type: on ? 'feature_turned_on' : 'feature_turned_off',
          userId,
          ip: req.ip,
          details: { feature, via }
        });
        return res.json({ success: true, ...describeEdition(doc) });
      }
      return res.status(409).json({ success: false, error: 'CONFLICT' });
    } catch (e) {
      console.error('[edition] user-features failed:', e?.message || e);
      return res.status(500).json({ success: false, error: 'SAVE_FAILED' });
    }
  });
}
