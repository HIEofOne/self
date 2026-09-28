/**
 * Sends the bare domain to the www address the app is served at: when
 * PUBLIC_APP_URL is https://www.example.org, a request for example.org goes
 * to https://www.example.org with its path and query (301, or 308 so a POST
 * stays a POST). Sign-in, cookies and passkeys all belong to the one address.
 * The bare domain reaches the app through an ALIAS record and its own
 * certificate (Documentation/Trustee_Host.md). Any other host passes through.
 */

/** @returns {import('express').RequestHandler | null} null when there is nothing to redirect */
export function bareDomainRedirect(publicAppUrl) {
  let canonical;
  try { canonical = new URL(String(publicAppUrl || '')); } catch { return null; }
  if (canonical.protocol !== 'https:' || !canonical.hostname.startsWith('www.')) return null;
  const bare = canonical.hostname.slice('www.'.length);
  return (req, res, next) => {
    // The Host header the platform received (not X-Forwarded-Host): a
    // spoofed value can only earn a redirect to the canonical address.
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    if (host !== bare) return next();
    const code = req.method === 'GET' || req.method === 'HEAD' ? 301 : 308;
    res.redirect(code, `${canonical.origin}${req.originalUrl || '/'}`);
  };
}
