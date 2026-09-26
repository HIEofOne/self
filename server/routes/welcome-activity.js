/**
 * New activity on the welcome page, before sign-in: the account's badge
 * shows how many requests wait for a decision, how many relay messages the
 * account holds, and how many accepted documents wait to be saved to the
 * folder. Counts only: no names, no content.
 *
 *   POST /api/welcome-activity/token   (signed in) → a token for this account
 *   GET  /api/welcome-activity?userId= with header X-Maia-Activity: <token>
 *
 * The token is an HMAC of the account id under the session secret, handed
 * only to a signed-in session and kept by that browser, on the device that
 * already holds the account's folder. It reads these counts and nothing
 * else. A session for the account works in place of the token.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { requestedUserId } from '../utils/api-guard.js';

const USERS_DB = 'maia_users';
const AS_REQUESTS_DB = 'maia_as_requests';
export const ACTIVITY_HEADER = 'x-maia-activity';

export const activityToken = (secret, userId) =>
  createHmac('sha256', String(secret)).update(`maia-welcome-activity:${userId}`).digest('base64url');

const sameToken = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

/** The counts, from the account and its request records. */
export function activityCounts(userDoc, requests) {
  const mine = (requests || []).filter((r) => r?.type === 'as_request' && r.userId === userDoc.userId);
  return {
    pendingRequests: mine.filter((r) => r.status === 'pending').length,
    messageCount: (userDoc.groupMemberships || []).reduce((n, m) => n + ((m.inbox || []).length), 0),
    documentsToSave: mine.filter((r) => r.document?.state === 'accepted').length
  };
}

export default function setupWelcomeActivityRoutes(app, { cloudant, secret }) {
  app.post('/api/welcome-activity/token', (req, res) => {
    const userId = req.session?.userId;
    if (!userId || req.session?.isDeepLink) return res.status(401).json({ success: false, error: 'NOT_AUTHENTICATED' });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, userId, token: activityToken(secret, userId) });
  });

  app.get('/api/welcome-activity', async (req, res) => {
    const userId = requestedUserId(req);
    const proven = !!userId && (req.session?.userId === userId
      || sameToken(req.get(ACTIVITY_HEADER), activityToken(secret, userId)));
    res.set('Cache-Control', 'no-store');
    if (!proven) return res.status(401).json({ success: false });
    try {
      const userDoc = await cloudant.getDocument(USERS_DB, userId).catch(() => null);
      if (!userDoc) return res.status(404).json({ success: false });
      const requests = await cloudant.getAllDocuments(AS_REQUESTS_DB).catch(() => []);
      res.json({ success: true, ...activityCounts(userDoc, requests) });
    } catch {
      res.status(500).json({ success: false });
    }
  });
}
