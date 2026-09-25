/**
 * Account-access guard for /api.
 *
 * The session decides whose account a request acts on. A request that
 * names an account (`userId` in the query or JSON body) must come from:
 *  - a session for that same user,
 *  - an admin session,
 *  - a deep-link guest acting as itself, or reading the account of the
 *    patient who shared the chat on the few routes a guest needs;
 * otherwise it is refused: 401 with no session, 403 for a different user.
 * A short allow-list covers routes that legitimately run before sign-in
 * and carry their own proof (passkey ceremonies, temporary-account
 * restore) or expose only non-sensitive status.
 */

export const isAdminUserId = (userId) => {
  const admin = String(process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
  return !!userId && String(userId).trim().toLowerCase() === admin;
};

/** Local development only: never inferred from Host / X-Forwarded-Host
 *  (client-controlled behind a proxy) — only from a non-https deployment
 *  AND a loopback socket. */
export const isLocalDevRequest = (req) => {
  const publicUrl = String(process.env.PUBLIC_APP_URL || '');
  if (publicUrl.startsWith('https://')) return false;
  const addr = String(req.socket?.remoteAddress || req.connection?.remoteAddress || '');
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
};

/** The temporary-account cookie (signed by cookie-parser with the session
 *  secret); set in routes/auth.js. */
export const TEMP_USER_COOKIE = 'maia_temp_user';

/** Does this request prove it may act for `userId` — a session for that
 *  account (or the admin's), or this browser's signed temporary-account
 *  cookie naming it? Used where a signed-out page acts on its own account
 *  (the welcome page's delete). */
export const provesAccount = (req, userId) => {
  if (!userId) return false;
  const sessionUserId = req.session?.userId || null;
  if (sessionUserId && (sessionUserId === userId || isAdminUserId(sessionUserId))) return true;
  return req.signedCookies?.[TEMP_USER_COOKIE] === userId;
};

// Routes that run before sign-in with a userId and carry their own proof,
// or return only non-sensitive status. Exact paths.
export const PRE_AUTH_ROUTES = new Set([
  '/api/passkey/check-user',
  '/api/passkey/register',
  '/api/passkey/register-verify',
  '/api/passkey/authenticate',
  '/api/passkey/authenticate-verify',
  '/api/temporary/restore',   // requires the signed temp cookie or a matching session
  '/api/account/recreate',    // only recreates a DESTROYED account; never signs into an existing one
  '/api/agent-exists',        // welcome page: does a cloud account exist for a local folder
  '/api/cloud-health',        // welcome page: restore status for a local folder
  '/api/client-log',
  '/api/local/delete',        // welcome page's delete: checks provesAccount itself
  '/api/admin/provision',     // legacy emailed admin link: token-checked
  '/api/admin/provision/confirm'
]);

// Deep-link guests may READ the sharing patient's account here (the guest
// UI passes the owner's id for these). Every other owner access is refused.
export const DEEPLINK_OWNER_READS = new Set([
  '/api/user-settings',
  '/api/user-files',
  '/api/labs/history',
  '/api/labs/oor-worksheet',
  '/api/encounters/find'
]);

/** The account a request names (`userId` in the query, else the JSON body). */
export const requestedUserId = (req) => {
  const q = req.query?.userId;
  if (typeof q === 'string' && q) return q;
  const b = req.body?.userId;
  if (typeof b === 'string' && b) return b;
  return null;
};

/**
 * @param {object} deps
 * @param {(req) => Promise<string|null>} deps.getDeepLinkOwnerId owner of the guest's shared chat
 */
export function createApiGuard({ getDeepLinkOwnerId } = {}) {
  return async function apiAccessGuard(req, res, next) {
    const target = requestedUserId(req);
    if (!target) return next();

    const path = req.path.startsWith('/api') ? req.path : `/api${req.path}`;
    if (PRE_AUTH_ROUTES.has(path)) return next();

    const sessionUserId = req.session?.userId || null;
    if (sessionUserId) {
      if (sessionUserId === target || isAdminUserId(sessionUserId)) return next();
      return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'Cannot act for another user' });
    }

    if (req.session?.isDeepLink) {
      if (target === req.session.deepLinkUserId) return next();
      if (req.method === 'GET' && DEEPLINK_OWNER_READS.has(path) && getDeepLinkOwnerId) {
        try {
          const owner = await getDeepLinkOwnerId(req);
          if (owner && owner === target) return next();
        } catch { /* fall through to refusal */ }
      }
      return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'Not available in a shared chat' });
    }

    return res.status(401).json({ success: false, error: 'NOT_AUTHENTICATED', message: 'Sign in required' });
  };
}
