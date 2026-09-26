/**
 * The patient's request log for their MAIA folder (group_requests.md §7, D10).
 * The server holds the operating copy of every request; the folder keeps the
 * durable one, Requests/requests.jsonl, written by the browser while MAIA is
 * open (src/utils/requestLog.ts). Once the folder confirms what it holds, the
 * daily retention run may prune old decided requests here.
 *
 *   GET  /api/requests/log?since=<ISO>   events after `since` (dedup by id)
 *   POST /api/requests/log/synced        { through } — the folder holds the log to here
 * Feature `requests`.
 */
import { requestedUserId } from '../utils/api-guard.js';
import { requestEvents } from '../gnap/notices.js';

const AS_REQUESTS_DB = 'maia_as_requests';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export default function setupRequestLogRoutes(app, { cloudant, notices }) {
  const sessionUser = (req, res) => {
    const userId = requestedUserId(req) || req.session?.userId;
    if (!userId || req.session?.userId !== userId) {
      res.status(401).json({ success: false, error: 'NOT_AUTHENTICATED' });
      return null;
    }
    return userId;
  };

  app.get('/api/requests/log', async (req, res) => {
    const userId = sessionUser(req, res);
    if (!userId) return;
    try {
      const since = typeof req.query.since === 'string' && ISO.test(req.query.since) ? req.query.since : '';
      const mine = ((await cloudant.getAllDocuments(AS_REQUESTS_DB).catch(() => [])) || [])
        .filter((r) => r?.type === 'as_request' && r.userId === userId);
      const events = requestEvents(mine).filter((e) => e.at > since);
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, events });
    } catch {
      res.status(500).json({ success: false, error: 'LOG_FAILED' });
    }
  });

  app.post('/api/requests/log/synced', async (req, res) => {
    const userId = sessionUser(req, res);
    if (!userId) return;
    const through = req.body?.through;
    if (typeof through !== 'string' || !ISO.test(through)) return res.status(400).json({ success: false, error: 'INVALID' });
    try {
      await notices.markLogSynced(userId, through);
      res.json({ success: true });
    } catch {
      res.status(500).json({ success: false, error: 'SYNC_FAILED' });
    }
  });
}
