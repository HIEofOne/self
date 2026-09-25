/**
 * Route inventory: which feature each route belongs to (I-26;
 * Documentation/group_requests.md §4, risk 1).
 *
 * Every route the server defines must appear here exactly once; a test
 * scans server/ and fails on any route that is missing or stale, so a new
 * route can't slip past the edition gate unclassified.
 *
 * A value is a feature key from server/edition.js, a function of the
 * request that returns one, or one of these non-feature classes, which
 * the gate never blocks:
 *   'public'    before sign-in, or infrastructure (health, logs, webhook)
 *   'admin'     admin surfaces, unchanged in both editions (§4.2)
 *   'registry'  the group registry's own endpoints, called by visitors and
 *               by member hosts on any edition (member claims, not a user
 *               session). What a member does from their own account is
 *               gated on the member-side /api/user-groups routes instead.
 */
import { requestedUserId } from './utils/api-guard.js';
import { FEATURES, featureMode, isFeatureEnabled } from './edition.js';

export const NON_FEATURE_CLASSES = Object.freeze(['public', 'admin', 'registry']);

const SECONDARY_PROFILE = 'gpt';
const profileKey = (req) =>
  req.query?.agentProfileKey || req.body?.agentProfileKey || req.body?.options?.agentProfileKey || null;

// The private AI is 'advisor' (core), except the user-chosen secondary.
const privateAiFeature = (req) => (profileKey(req) === SECONDARY_PROFILE ? 'second-ai' : 'advisor');

export const ROUTE_FEATURES = Object.freeze({
  // ── Public and infrastructure ─────────────────────────────────────────
  'GET *': 'public',
  'GET /Privacy.md': 'public',
  'GET /health': 'public',
  'GET /api/edition': 'public',
  'POST /api/client-log': 'public',
  'GET /api/admin-username': 'public',
  'GET /api/current-user': 'public',
  'POST /api/sign-out': 'public',
  'POST /api/auth/clear-temp-cookie': 'public',
  'GET /api/agent-exists': 'public',
  'GET /api/cloud-health': 'public',
  'GET /api/welcome-status': 'public',
  'GET /api/setup-wizard-messages': 'public',
  'GET /api/random-names': 'public',
  'POST /api/credits/balance': 'public',
  'POST /api/stripe/webhook': 'public',

  // ── Admin (unchanged in both editions) ────────────────────────────────
  'GET /api/admin/agent-diagnostic': 'admin',
  'POST /api/admin/broadcast-email': 'admin',
  'POST /api/admin/credits-config': 'admin',
  'POST /api/admin/credits-grant': 'admin',
  'GET /api/admin/credits-stats': 'admin',
  'GET /api/admin/provision': 'admin',
  'GET /api/admin/provision-logs': 'admin',
  'GET /api/admin/provision-status': 'admin',
  'POST /api/admin/provision/confirm': 'admin',
  'GET /api/admin/users': 'admin',
  'DELETE /api/admin/users/:userId': 'admin',
  'POST /api/admin/users/:userId/recover': 'admin',
  'GET /api/billing/balance': 'admin',

  // ── account ───────────────────────────────────────────────────────────
  'GET /api/passkey/check-user': 'account',
  'POST /api/passkey/register': 'account',
  'POST /api/passkey/register-verify': 'account',
  'POST /api/passkey/registration-complete': 'account',
  'POST /api/passkey/authenticate': 'account',
  'POST /api/passkey/authenticate-verify': 'account',
  'GET /api/temporary/suggested-id': 'account',
  'POST /api/temporary/start': 'account',
  'POST /api/temporary/restore': 'account',
  'POST /api/account/recreate': 'account',
  'POST /api/account/dormant': 'account',
  'PUT /api/account/rehydrate': 'account',
  'POST /api/email/send-code': 'account',
  'POST /api/email/verify-code': 'account',
  'POST /api/email/verification-status': 'account',
  'GET /api/user-settings': 'account',
  'PUT /api/user-settings': 'account',
  'GET /api/user-status': 'account',
  'POST /api/user-status': 'account',
  'GET /api/user-doc/full': 'account',
  'POST /api/restore': 'account',
  'POST /api/files/restore-bytes': 'account',
  'POST /api/self/delete': 'account',
  'POST /api/local/delete': 'account',
  'GET /api/provisioning-log': 'account',
  'POST /api/provisioning-log': 'account',
  'POST /api/wizard-log': 'account',
  'POST /api/wizard/quick-start-complete': 'account',
  'POST /api/welcome-email': 'account',
  'POST /api/user-features': 'account',
  'GET /api/setup-status': 'account',
  'POST /api/setup/folder-connected': 'account',

  // ── notifications ─────────────────────────────────────────────────────
  'GET /api/user/notification-email': 'notifications',
  'POST /api/user/notification-email': 'notifications',

  // ── summary: record files, the deterministic Lists build that feeds the
  //    Patient Summary, Current Medications, the privacy-filter mapping
  //    (shared with privacy-filter-editor, which has no routes of its own) ─
  'POST /api/files/upload': 'summary',
  'POST /api/files/register': 'summary',
  'POST /api/files/parse-pdf': 'summary',
  'GET /api/files/get-text/:bucketKey(*)': 'summary',
  'GET /api/files/proxy-pdf/:bucketKey(*)': 'summary',
  'GET /api/files/:bucketKey/url': 'summary',
  'GET /api/files/storage-usage': 'summary',
  'GET /api/files/parse-pdf-first-page/:bucketKey(*)': 'summary',
  'GET /api/files/parse-pdf-from-bucket/:bucketKey(*)': 'summary',
  'POST /api/files/pdf-to-markdown': 'summary',
  'POST /api/files/pdf-to-markdown/:bucketKey(*)': 'summary',
  'GET /api/files/verify-patient-consistency': 'summary',
  'GET /api/files/lists/categories': 'summary',
  'GET /api/files/lists/category/:categoryName': 'summary',
  'POST /api/files/lists/cleanup-markdown': 'summary',
  'POST /api/files/lists/cleanup-user-doc': 'summary',
  'POST /api/files/lists/clear-cache': 'summary',
  'POST /api/files/lists/current-medications': 'summary',
  'GET /api/files/lists/markdown': 'summary',
  'POST /api/files/lists/process-category': 'summary',
  'POST /api/files/lists/process-initial-file': 'summary',
  'POST /api/files/lists/restore-markdown': 'summary',
  'GET /api/files/lists/results': 'summary',
  'POST /api/files/lists/save-category': 'summary',
  'GET /api/user-files': 'summary',
  'POST /api/user-file-metadata': 'summary',
  'DELETE /api/delete-file': 'summary',
  'POST /api/archive-user-files': 'summary',
  'POST /api/cleanup-imported-files': 'summary',
  'GET /api/verify-file-state': 'summary',
  'POST /api/user-apple-file-status': 'summary',
  'GET /api/patient-summary': 'summary',
  'POST /api/patient-summary': 'summary',
  'POST /api/patient-summary/draft': 'summary',
  'POST /api/patient-summary/interview': 'summary',
  'GET /api/patient-summary/interview': 'summary',
  'POST /api/patient-summary/verify': 'summary',
  'POST /api/patient-summary/swap': 'summary',
  'PATCH /api/patient-summary/medications': 'summary',
  'POST /api/generate-patient-summary': 'summary',
  'GET /api/agent-instructions/patient-summary': 'summary',
  'POST /api/agent-instructions/patient-summary': 'summary',
  'POST /api/medications/extract': 'summary',
  'GET /api/medications/current': 'summary',
  'POST /api/user-current-medications': 'summary',
  'GET /api/verify-medications-token': 'summary',
  'POST /api/test-medications-token': 'summary',
  'GET /api/privacy-filter-mapping': 'summary',
  'POST /api/privacy-filter-mapping': 'summary',
  'GET /api/pipeline': 'summary',
  'POST /api/pipeline/advance': 'summary',

  // ── advisor (the private AI), second-ai, public-ai ────────────────────
  'GET /api/agent-setup-status': 'advisor',
  'POST /api/sync-agent': 'advisor',
  'GET /api/chat/providers': 'advisor', // filters providers per feature itself
  'GET /api/agent-instructions': privateAiFeature,
  'PUT /api/agent-instructions': privateAiFeature,
  'POST /api/chat/:provider': (req, params) =>
    (params.provider === 'digitalocean' ? privateAiFeature(req) : 'public-ai'),
  'GET /api/secondary-models': 'second-ai',
  'POST /api/agents/ensure-secondary': 'second-ai',
  'POST /api/patient-summary/generate-pair': 'second-ai',

  // ── policies ──────────────────────────────────────────────────────────
  'GET /api/user-policies': 'policies',
  'POST /api/user-policies': 'policies',
  'PUT /api/user-policies/:id': 'policies',
  'DELETE /api/user-policies/:id': 'policies',
  // ── gnap: the personal AS's request API (§10; P4). The /gnap paths are
  // outside /api, so routes/gnap.js checks the feature itself.
  'POST /gnap/as/:asId': 'gnap',
  'POST /gnap/continue/:grant': 'gnap',
  'DELETE /gnap/continue/:grant': 'gnap',
  'GET /gnap/interact/:ix': 'gnap',
  'POST /gnap/interact/:ix/code': 'gnap',
  'POST /gnap/interact/:ix/verify': 'gnap',
  'DELETE /gnap/token/:tok': 'gnap',
  'GET /gnap/rs/:res': 'gnap',
  'GET /api/gnap/request-link': 'gnap',
  'POST /api/gnap/request-link/rotate': 'gnap',
  'POST /api/user-policies/:id/confirm': 'policies',
  'POST /api/as-state': 'policies',
  'POST /api/user-groups/import-suggested-policies': 'policies',
  'POST /api/user-groups/remove-suggested-policies': 'policies',

  // ── requests (the member's own inbox and decisions) ───────────────────
  'GET /api/user-groups/requests': 'requests',
  'POST /api/user-groups/requests/:id/decision': 'requests',
  'POST /api/user-groups/requests/:id/stop-sharing': 'requests',

  // ── groups-core (member side) ─────────────────────────────────────────
  'GET /api/user-groups': 'groups-core',
  'GET /api/user-groups/alerts': 'groups-core',
  'POST /api/user-groups/alias': 'groups-core',
  'GET /api/user-groups/invite-info': 'groups-core',
  'POST /api/user-groups/join': 'groups-core',
  'GET /api/user-groups/join-info': 'groups-core',
  'POST /api/user-groups/leave': 'groups-core',
  'POST /api/user-groups/poll-joins': 'groups-core',
  'POST /api/user-groups/refresh': 'groups-core',
  'POST /api/user-groups/request-join': 'groups-core',

  // ── records-index ─────────────────────────────────────────────────────
  'POST /api/update-knowledge-base': 'records-index',
  'POST /api/toggle-file-knowledge-base': 'records-index',
  'POST /api/attach-kb-to-agent': 'records-index',
  'POST /api/reset-kb': 'records-index',
  'POST /api/cancel-kb-indexing': 'records-index',
  'GET /api/kb-indexing-status/:jobId': 'records-index',
  'GET /api/kb2-indexing-status': 'records-index',
  'POST /api/toggle-kb-connection': 'records-index',

  // ── lists-full (worksheets and explorers beyond Current Medications) ──
  'GET /api/medications/worksheet': 'lists-full',
  'POST /api/medications/worksheet': 'lists-full',
  'GET /api/encounters/worksheet': 'lists-full',
  'POST /api/encounters/worksheet': 'lists-full',
  'GET /api/encounters/find': 'lists-full',
  'GET /api/labs/history': 'lists-full',
  'GET /api/labs/oor-worksheet': 'lists-full',
  'POST /api/labs/oor-worksheet': 'lists-full',

  // ── saved-chats, deep-links ───────────────────────────────────────────
  'POST /api/save-group-chat': 'saved-chats',
  'PUT /api/save-group-chat/:chatId': 'saved-chats',
  'GET /api/user-chats': 'saved-chats',
  'GET /api/load-chat/:chatId': 'saved-chats',
  'DELETE /api/delete-chat/:chatId': 'saved-chats',
  'GET /api/shared-group-chats': 'saved-chats',
  'GET /api/user-deep-links': 'deep-links',
  // Guest-facing: judged on the unlocks of the patient who shared (see
  // subjectUserId below).
  'POST /api/deep-link/login': 'deep-links',
  'GET /api/deep-link/session': 'deep-links',
  'GET /api/load-chat-by-share/:shareId': 'deep-links',

  // ── peer-messaging, vouch (member side) ───────────────────────────────
  'POST /api/user-groups/send': 'peer-messaging',
  'GET /api/user-groups/messages': 'peer-messaging',
  'GET /api/user-groups/directory': 'peer-messaging',
  'POST /api/user-groups/invite': 'peer-messaging',
  'POST /api/user-groups/mentor': 'peer-messaging',
  'POST /api/user-groups/message-prefs': 'peer-messaging',
  'POST /api/user-groups/filter-text': 'peer-messaging',
  'POST /api/user-groups/vouch': 'vouch',
  'POST /api/user-groups/vouch-revoke': 'vouch',
  'GET /api/user-groups/vouches': 'vouch',

  // ── diary ─────────────────────────────────────────────────────────────
  'GET /api/patient-diary': 'diary',
  'POST /api/patient-diary': 'diary',
  'POST /api/patient-diary/delete': 'diary',
  'POST /api/patient-diary/mark-posted': 'diary',
  'POST /api/patient-diary/update-bubble-id': 'diary',

  // ── legacy-requests: today's request path, replaced by GNAP in the
  //    Personal AS edition (D12). Includes the group request builder's AI.
  'POST /api/groups/:groupId/outside-request': 'legacy-requests',
  'GET /api/groups/:groupId/outside-request/:reqId/status': 'legacy-requests',
  'POST /api/groups/:groupId/outside-request/:reqId/responded': 'legacy-requests',
  'POST /api/groups/outside-request-proxy': 'legacy-requests',
  'POST /api/groups/:groupId/advisor': 'legacy-requests',
  'POST /api/user-groups/request': 'legacy-requests',

  // ── registry ──────────────────────────────────────────────────────────
  'GET /api/groups': 'registry',
  'POST /api/groups': 'registry',
  'GET /api/groups/public': 'registry',
  'PUT /api/groups/:groupId': 'registry',
  'DELETE /api/groups/:groupId': 'registry',
  'POST /api/groups/:groupId/alias-change': 'registry',
  'POST /api/groups/:groupId/broadcast-keys': 'registry',
  'GET /api/groups/:groupId/directory': 'registry',
  'GET /api/groups/:groupId/info': 'registry',
  'GET /api/groups/:groupId/invite-info': 'registry',
  'POST /api/groups/:groupId/invites': 'registry',
  'POST /api/groups/:groupId/join': 'registry',
  'GET /api/groups/:groupId/join-info': 'registry',
  'POST /api/groups/:groupId/join-requests': 'registry',
  'GET /api/groups/:groupId/join-requests/:pairwiseId/status': 'registry',
  'POST /api/groups/:groupId/leave': 'registry',
  'POST /api/groups/:groupId/member-invites': 'registry',
  'GET /api/groups/:groupId/member-key/:pairwiseId': 'registry',
  'GET /api/groups/:groupId/members': 'registry',
  'DELETE /api/groups/:groupId/members/:pairwiseId': 'registry',
  'PUT /api/groups/:groupId/members/:pairwiseId/approve': 'registry',
  'PUT /api/groups/:groupId/members/:pairwiseId/mentor': 'registry',
  'POST /api/groups/:groupId/mentor-optin': 'registry',
  'POST /api/groups/:groupId/message-prefs': 'registry',
  'GET /api/groups/:groupId/recovery-kit': 'registry',
  'POST /api/groups/:groupId/refresh': 'registry',
  'POST /api/groups/:groupId/relay': 'registry',
  'POST /api/groups/:groupId/rotate-join-link': 'registry',
  'GET /api/groups/:groupId/stats': 'registry',
  'POST /api/groups/:groupId/vouch/assert-options': 'registry',
  'POST /api/groups/:groupId/vouch/assert-verify': 'registry',
  'POST /api/groups/:groupId/vouch/redeem-options': 'registry',
  'POST /api/groups/:groupId/vouch/redeem-verify': 'registry',
  'POST /api/groups/:groupId/vouches': 'registry',
  'POST /api/groups/:groupId/vouches/revoke': 'registry',
  'POST /api/groups/:groupId/vouches/status': 'registry'
});

// ── Matching ─────────────────────────────────────────────────────────────
const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

const compile = (path) => {
  const names = [];
  const pattern = path.split('/').map((seg) => {
    const m = seg.match(/^:(\w+)(\(\*\))?$/);
    if (!m) return escapeRe(seg);
    names.push(m[1]);
    return m[2] ? '(.+)' : '([^/]+)';
  }).join('/');
  return { re: new RegExp(`^${pattern}/?$`), names };
};

const TABLE = Object.entries(ROUTE_FEATURES)
  .filter(([key]) => key.split(' ')[1].startsWith('/api/'))
  .map(([key, value]) => {
    const [method, path] = key.split(' ');
    return { method, path, value, ...compile(path) };
  })
  // Literal paths before parameterized ones (e.g. /api/groups/public
  // before /api/groups/:groupId).
  .sort((a, b) => a.names.length - b.names.length);

/** The table entry for this method and /api path, with its route params. */
export const matchRoute = (method, path) => {
  for (const entry of TABLE) {
    if (entry.method !== method) continue;
    const m = entry.re.exec(path);
    if (!m) continue;
    const params = {};
    entry.names.forEach((name, i) => { try { params[name] = decodeURIComponent(m[i + 1]); } catch { params[name] = m[i + 1]; } });
    return { entry, params };
  }
  return null;
};

/** The feature (or non-feature class) a request belongs to, or null. */
export const routeFeature = (req, match) => {
  if (!match) return null;
  const { value } = match.entry;
  return typeof value === 'function' ? value(req, match.params) : value;
};

/**
 * The /api feature gate. Mount right after the account guard, so a userId
 * named in the request has already been checked against the session.
 *
 * Unlockable features are judged on one account's unlocks: the account the
 * request names, else the signed-in user, else — for a clinician's guest
 * session or a guest signing in — the patient who shared the chat.
 *
 * @param {object} deps
 * @param {(userId: string) => Promise<object|null>} deps.loadUserDoc
 * @param {(shareId: string) => Promise<string|null>} deps.getShareOwnerId
 */
export function createFeatureGuard({ loadUserDoc, getShareOwnerId }) {
  const subjectUserId = async (req, params) => {
    const named = requestedUserId(req) || req.session?.userId;
    if (named) return named;
    const shareId = params.shareId || req.body?.shareId || req.query?.shareId || req.session?.deepLinkShareId;
    if (shareId && typeof shareId === 'string' && getShareOwnerId) return getShareOwnerId(shareId);
    return null;
  };

  return async function featureGuard(req, res, next) {
    const path = req.path.startsWith('/api') ? req.path : `/api${req.path}`;
    const match = matchRoute(req.method, path);
    const key = routeFeature(req, match);
    if (!key || NON_FEATURE_CLASSES.includes(key) || !FEATURES[key]) return next();

    const mode = featureMode(key);
    if (mode === 'on') return next();
    const off = () => res.status(403).json({ success: false, error: 'FEATURE_OFF', feature: key });
    if (mode !== 'unlockable') return off();

    try {
      const userId = await subjectUserId(req, match.params);
      if (!userId) return off();
      const userDoc = await loadUserDoc(userId);
      return isFeatureEnabled(key, userDoc) ? next() : off();
    } catch (e) {
      console.warn(`[edition] feature check for "${key}" failed:`, e?.message || e);
      return res.status(503).json({ success: false, error: 'FEATURE_CHECK_FAILED', feature: key });
    }
  };
}
