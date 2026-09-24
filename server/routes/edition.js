/**
 * GET /api/edition — which edition this server runs and which features are
 * on (Documentation/group_requests.md §4.1). Public: the welcome page reads
 * it before sign-in. With a session it also reflects the user's own unlocks.
 */
import { describeEdition } from '../edition.js';

const USERS_DB = 'maia_users';

export default function setupEditionRoutes(app, cloudant) {
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
}
