/**
 * A MAIA as the GNAP client for its own user (group_requests.md §10.13,
 * P11): the user asks another person's MAIA, through the personal request
 * link that person gave them. The answering MAIA needs nothing new: the
 * request arrives at its one door and its patient's cards decide (I-30).
 *
 * This side:
 *  - sends only when the user clicks Send (I-33); a draft from the private
 *    AI is a card until then, and nothing is ever sent as a reaction to a
 *    request or an answer received;
 *  - signs with a key made for this user and this target only (pairwise),
 *    so two MAIAs can't link the user by key;
 *  - on first contact sends the user to confirm their email at the other
 *    MAIA, which returns here (/gnap/client/finish/:id) and then recognizes
 *    this client (instance_id) until its patient chooses Forget;
 *  - waits on the server, for days if need be, respecting `wait`;
 *  - reads an answer once, seals it at once to the user's folder key, and
 *    keeps only the sealed box until the user's browser saves it to
 *    Received/ (I-32, I-33). No readable copy stays here.
 *
 *   POST /api/gnap/out                  send (the user's click)
 *   GET  /api/gnap/out                  the user's requests to other MAIAs
 *   POST /api/gnap/out/:id/refresh      check now
 *   POST /api/gnap/out/:id/withdraw     withdraw
 *   GET  /gnap/client/finish/:id        back from the email check
 * Feature `requests-out`.
 */
import { randomBytes, generateKeyPairSync, createHash } from 'crypto';
import { readFileSync } from 'fs';
import { isFeatureEnabled } from '../edition.js';
import { requestedUserId } from '../utils/api-guard.js';
import { signRequest, jwkThumbprint } from '../gnap/httpsig.js';
import { ACCESS_TYPE, GRANT_TTL_MS, interactionHash } from '../gnap/grants.js';
import { READ_SCOPES, POLICY_PURPOSES } from './policies.js';
import { GNAP_DB, getDoc, updateDoc } from '../gnap/store.js';
import { sealDocument, hasFolderKey, holdKeyFor, createMemoryHoldStore } from '../gnap/documents.js';
import { SCOPE_WORDS } from './gnap.js';

const USERS_DB = 'maia_users';
export const OUT_PER_USER_PER_DAY = 10;
const MAX_MESSAGE = 1000;
const MAX_LABEL = 60;
const MAX_ANSWER_CHARS = 200000;
let VERSION = '';
try { VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || ''; } catch { /* unknown */ }

const PRIVATE_HOST = /^(localhost|127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:|\[?fe80:)/i;

/**
 * The other MAIA from the link its patient handed out: …/r/<asId>, or the
 * grant endpoint …/gnap/as/<asId>. https only, and never a private address
 * (this server makes the calls), except on a local development host.
 */
export function parseTarget(link, { allowLocal = false } = {}) {
  let u;
  try { u = new URL(String(link || '').trim()); } catch { return null; }
  const m = /^\/(?:r|gnap\/as)\/([0-9a-f]{32})\/?$/.exec(u.pathname);
  if (!m || u.search || u.username || u.password) return null;
  const local = /^(localhost|127\.0\.0\.1)$/.test(u.hostname);
  if (u.protocol !== 'https:' && !(allowLocal && local && u.protocol === 'http:')) return null;
  if (PRIVATE_HOST.test(u.hostname) && !(allowLocal && local)) return null;
  return { origin: u.origin, asId: m[1], grantEndpoint: `${u.origin}/gnap/as/${m[1]}`, pageUrl: `${u.origin}/r/${m[1]}` };
}

const sameOrigin = (url, origin) => { try { return new URL(url).origin === origin; } catch { return false; } };

export default function setupGnapOutRoutes(app, {
  cloudant, auditLog = { logEvent: () => {} }, sendEmail = async () => false, holds = createMemoryHoldStore(),
  now = () => Date.now(), publicBaseUrl = () => process.env.PUBLIC_APP_URL,
  allowLocal = !String(process.env.PUBLIC_APP_URL || '').startsWith('https://')
} = {}) {
  const on = () => isFeatureEnabled('requests-out');
  const iso = (t) => new Date(t).toISOString();
  const ownBase = () => String(publicBaseUrl() || `http://localhost:${process.env.PORT || 3001}`).replace(/\/$/, '');
  const log = (type, userId, details) => { try { auditLog.logEvent({ type, userId, details }); } catch { /* best-effort */ } };
  const loadUser = (userId) => cloudant.getDocument(USERS_DB, userId).catch(() => null);

  const sessionUser = (req, res) => {
    const userId = requestedUserId(req) || req.session?.userId;
    if (!userId || req.session?.userId !== userId) {
      res.status(401).json({ success: false, error: 'NOT_AUTHENTICATED' });
      return null;
    }
    return userId;
  };

  // ── Pairwise client keys ───────────────────────────────────────────────
  // One Ed25519 key per user per target AS; it also remembers the
  // instance_id that AS gave after the email check.
  const keyId = (userId, grantEndpoint) => `ck_${createHash('sha256').update(`${userId}|${grantEndpoint}`).digest('hex').slice(0, 40)}`;
  const clientKeyFor = async (userId, grantEndpoint) => {
    const id = keyId(userId, grantEndpoint);
    const existing = await getDoc(cloudant, id);
    if (existing) return existing;
    const { privateKey } = generateKeyPairSync('ed25519');
    const priv = privateKey.export({ format: 'jwk' });
    const pub = { kty: 'OKP', crv: 'Ed25519', x: priv.x };
    const doc = {
      _id: id, type: 'gnap_client_key', userId, grantEndpoint,
      publicJwk: { ...pub, kid: jwkThumbprint(pub) }, privateJwk: { ...priv, kid: jwkThumbprint(pub) },
      instanceId: null, displayName: '', createdAt: iso(now())
    };
    try { await cloudant.saveDocument(GNAP_DB, doc); } catch { return (await getDoc(cloudant, id)) || doc; }
    return doc;
  };

  const signedCall = async (ck, method, url, { body = null, token = null } = {}) => {
    const text = body ? JSON.stringify(body) : null;
    const headers = { ...(text ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `GNAP ${token}` } : {}) };
    const sig = signRequest({ method, targetUri: url, headers, body: text, privateJwk: ck.privateJwk });
    const r = await fetch(url, { method, headers: { ...headers, ...sig }, ...(text ? { body: text } : {}), redirect: 'error' });
    return { status: r.status, body: r.status === 204 ? {} : await r.json().catch(() => ({})) };
  };

  // ── Collecting an answer: sealed at once, never kept readable ──────────

  const answerText = (og, rs) => [
    `Requested by you from ${og.label || new URL(og.grantEndpoint).host} (${og.pageUrl}) on ${String(og.createdAt).slice(0, 10)}: ${SCOPE_WORDS[og.access.datatypes[0]] || og.access.datatypes[0]} for ${og.access.purpose} use.`,
    `Collected ${String(rs.retrievedAt || iso(now())).slice(0, 10)}. ${typeof rs.attribution === 'string' ? rs.attribution.slice(0, 300) : ''}`.trim(),
    '',
    String(rs.text || '').slice(0, MAX_ANSWER_CHARS)
  ].join('\n');

  const collect = async (og, at) => {
    const location = at?.access?.[0]?.locations?.[0];
    if (!at?.value || !sameOrigin(location, og.targetOrigin)) return { state: 'failed', error: 'The other MAIA answered from an unexpected address' };
    const ck = await getDoc(cloudant, og.keyId);
    const rs = await signedCall(ck, 'GET', location, { token: at.value });
    if (rs.status !== 200) return { state: 'failed', error: 'The answer couldn’t be read' };
    const userDoc = await loadUser(og.userId);
    if (!hasFolderKey(userDoc)) return { state: 'failed', error: 'Your MAIA folder isn’t connected' };
    const bytes = Buffer.from(answerText(og, rs.body), 'utf8');
    const holdId = randomBytes(18).toString('base64url');
    const holdKey = holdKeyFor(og.userId, holdId);
    await holds.put(holdKey, JSON.stringify(sealDocument(userDoc.folderKeyJwk, bytes)));
    const at2 = iso(now());
    return {
      state: 'answered', answeredAt: at2,
      hold: { holdId, holdKey, state: 'accepted', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), heldAt: at2 }
    };
  };

  /** What a response from the other MAIA means for this request. */
  const apply = async (og, r) => {
    const b = r.body || {};
    const patch = {};
    if (typeof b.instance_id === 'string' && b.instance_id) {
      await updateDoc(cloudant, og.keyId, (k) => { k.instanceId = b.instance_id; return true; });
    }
    if (b.access_token?.value) {
      Object.assign(patch, { continueToken: null }, await collect(og, b.access_token));
    } else if (b.continue) {
      if (!sameOrigin(b.continue.uri, og.targetOrigin)) return updateDoc(cloudant, og._id, (x) => { x.state = 'failed'; x.error = 'The other MAIA answered from an unexpected address'; return true; });
      Object.assign(patch, {
        continueUri: b.continue.uri, continueToken: b.continue.access_token?.value || null,
        nextPollAt: now() + (b.continue.wait || 60) * 1000,
        state: b.interact?.redirect ? 'verify' : (og.state === 'verify' && og.interact && !og.interactDone ? 'verify' : 'waiting')
      });
      if (b.interact?.redirect) patch.interact = { ...(og.interact || {}), redirect: b.interact.redirect, serverNonce: b.interact.finish || null };
    } else if (b.error?.code === 'request_denied') {
      Object.assign(patch, { state: 'declined', continueToken: null, decidedAt: iso(now()) });
    } else if (b.error?.code === 'invalid_continuation') {
      Object.assign(patch, { state: 'expired', continueToken: null });
    } else if (r.status >= 400 && b.error?.code !== 'too_fast') {
      Object.assign(patch, { state: 'failed', error: String(b.error?.description || `HTTP ${r.status}`).slice(0, 200), continueToken: null });
    }
    return updateDoc(cloudant, og._id, (x) => { Object.assign(x, patch); return true; });
  };

  const view = (og) => ({
    id: og._id.slice(3), label: og.label, host: new URL(og.grantEndpoint).host, pageUrl: og.pageUrl,
    what: og.access.datatypes[0], why: og.access.purpose, message: og.message || '', draftedBy: og.draftedBy,
    state: og.state, error: og.error || null, recognized: !!og.recognized,
    verifyUrl: og.state === 'verify' ? og.interact?.redirect || null : null,
    saved: og.hold?.state === 'delivered' ? (og.hold.fileName || true) : og.hold?.state === 'accepted' ? false : null,
    createdAt: og.createdAt, answeredAt: og.answeredAt || null
  });

  const grantBody = (og, ck, { interact }) => ({
    access_token: { access: [{ type: ACCESS_TYPE, actions: [og.access.datatypes[0] === 'notification-only' ? 'notify' : 'read'], datatypes: og.access.datatypes, purpose: og.access.purpose }] },
    client: ck.instanceId && !interact ? ck.instanceId : { key: { proof: 'httpsig', jwk: ck.publicJwk }, display: { name: ck.displayName || '' } },
    ...(interact ? { interact: { start: ['redirect'], finish: { method: 'redirect', uri: `${ownBase()}/gnap/client/finish/${og._id.slice(3)}`, nonce: og.interact.clientNonce } } } : {}),
    ...(og.message ? { maia_message: og.message } : {}),
    maia_origin: { software: 'maia', version: VERSION, drafted_by: og.draftedBy, sent_by: 'user' }
  });

  // ── Send (only ever the user's click) ──────────────────────────────────

  app.post('/api/gnap/out', async (req, res) => {
    const userId = sessionUser(req, res);
    if (!userId) return;
    try {
      const { link, what, why } = req.body || {};
      const target = parseTarget(link, { allowLocal });
      if (!target) return res.status(400).json({ success: false, error: 'BAD_LINK' });
      if (target.origin === ownBase() && (await getDoc(cloudant, `as_${target.asId}`))?.userId === userId) {
        return res.status(400).json({ success: false, error: 'OWN_LINK' });
      }
      if (!READ_SCOPES.includes(what) || what === 'ah-category' || !POLICY_PURPOSES.includes(why) || why === 'any') {
        return res.status(400).json({ success: false, error: 'INVALID_REQUEST' });
      }
      const userDoc = await loadUser(userId);
      if (!hasFolderKey(userDoc)) return res.status(409).json({ success: false, error: 'NO_FOLDER_KEY' });
      const dayAgo = now() - 24 * 60 * 60 * 1000;
      const today = ((await cloudant.getAllDocuments(GNAP_DB).catch(() => [])) || [])
        .filter((d) => d?.type === 'gnap_out_request' && d.userId === userId && Date.parse(d.createdAt) > dayAgo);
      if (today.length >= OUT_PER_USER_PER_DAY) return res.status(429).json({ success: false, error: 'TOO_MANY_TODAY' });

      const label = String(req.body?.label || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_LABEL);
      const fromName = String(req.body?.fromName || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
      const message = typeof req.body?.message === 'string' ? req.body.message.trim().slice(0, MAX_MESSAGE) : '';
      const ck = await clientKeyFor(userId, target.grantEndpoint);
      if (fromName && fromName !== ck.displayName) await updateDoc(cloudant, ck._id, (k) => { k.displayName = fromName; return true; });
      if (!ck.instanceId && !(fromName || ck.displayName)) return res.status(400).json({ success: false, error: 'NAME_NEEDED' });
      const id = randomBytes(12).toString('base64url');
      const t = now();
      const og = {
        _id: `og_${id}`, type: 'gnap_out_request', userId, label, keyId: ck._id,
        targetOrigin: target.origin, grantEndpoint: target.grantEndpoint, pageUrl: target.pageUrl,
        access: { type: ACCESS_TYPE, datatypes: [what], purpose: why }, message,
        draftedBy: req.body?.draftedBy === 'private-ai' ? 'private-ai' : 'user',
        state: 'sending', continueUri: null, continueToken: null, nextPollAt: 0,
        interact: { clientNonce: randomBytes(12).toString('base64url') }, recognized: !!ck.instanceId,
        createdAt: iso(t), expiresAt: iso(t + GRANT_TTL_MS)
      };
      await cloudant.saveDocument(GNAP_DB, og);
      let fresh = await clientKeyFor(userId, target.grantEndpoint);
      let r = await signedCall(fresh, 'POST', target.grantEndpoint, { body: grantBody(og, fresh, { interact: !fresh.instanceId }) });
      // No longer recognized (the other patient chose Forget): confirm the email again.
      if (fresh.instanceId && r.status === 401 && r.body?.error?.code === 'invalid_client') {
        await updateDoc(cloudant, fresh._id, (k) => { k.instanceId = null; return true; });
        fresh = await getDoc(cloudant, fresh._id);
        await updateDoc(cloudant, og._id, (x) => { x.recognized = false; return true; });
        r = await signedCall(fresh, 'POST', target.grantEndpoint, { body: grantBody(og, fresh, { interact: true }) });
      }
      if (r.status === 404) {
        await updateDoc(cloudant, og._id, (x) => { x.state = 'failed'; x.error = 'That link doesn’t work anymore'; return true; });
        return res.status(404).json({ success: false, error: 'LINK_GONE' });
      }
      const next = await apply(await getDoc(cloudant, og._id), r);
      log('gnap_out_sent', userId, { target: target.origin, datatype: what, purpose: why, draftedBy: og.draftedBy, recognized: og.recognized, state: next.state });
      res.json({ success: true, request: view(next) });
    } catch (e) {
      console.warn('[gnap-out] send failed:', e?.message || e);
      res.status(502).json({ success: false, error: 'SEND_FAILED' });
    }
  });

  app.get('/api/gnap/out', async (req, res) => {
    const userId = sessionUser(req, res);
    if (!userId) return;
    try {
      const mine = ((await cloudant.getAllDocuments(GNAP_DB).catch(() => [])) || [])
        .filter((d) => d?.type === 'gnap_out_request' && d.userId === userId)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, requests: mine.map(view) });
    } catch {
      res.status(500).json({ success: false, error: 'LIST_FAILED' });
    }
  });

  const loadOwn = async (userId, id) => {
    const og = await getDoc(cloudant, `og_${id}`);
    return og && og.type === 'gnap_out_request' && og.userId === userId ? og : null;
  };

  /** Continue a waiting request (the poll, or the user's Check now). */
  const poll = async (og) => {
    if (og.state !== 'waiting' || !og.continueToken || !og.continueUri) return og;
    if (Date.parse(og.expiresAt) < now()) return updateDoc(cloudant, og._id, (x) => { x.state = 'expired'; x.continueToken = null; return true; });
    const ck = await getDoc(cloudant, og.keyId);
    return apply(og, await signedCall(ck, 'POST', og.continueUri, { token: og.continueToken }));
  };

  app.post('/api/gnap/out/:id/refresh', async (req, res) => {
    const userId = sessionUser(req, res);
    if (!userId) return;
    try {
      const og = await loadOwn(userId, req.params.id);
      if (!og) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
      // The user's Check now: the other MAIA enforces its own wait (too_fast
      // changes nothing), and a decision there lifts it at once.
      res.json({ success: true, request: view(await poll(og)) });
    } catch {
      res.status(502).json({ success: false, error: 'REFRESH_FAILED' });
    }
  });

  app.post('/api/gnap/out/:id/withdraw', async (req, res) => {
    const userId = sessionUser(req, res);
    if (!userId) return;
    try {
      const og = await loadOwn(userId, req.params.id);
      if (!og) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
      if (og.continueToken && og.continueUri) {
        const ck = await getDoc(cloudant, og.keyId);
        await signedCall(ck, 'DELETE', og.continueUri, { token: og.continueToken }).catch(() => null);
      }
      const next = ['verify', 'waiting', 'sending'].includes(og.state)
        ? await updateDoc(cloudant, og._id, (x) => { x.state = 'withdrawn'; x.continueToken = null; return true; })
        : og;
      res.json({ success: true, request: view(next) });
    } catch {
      res.status(500).json({ success: false, error: 'WITHDRAW_FAILED' });
    }
  });

  // ── Back from the email check at the other MAIA ────────────────────────
  // The browser arrives here; the unguessable request id and the §4.2.3
  // hash are the proof. This server then continues the grant itself.

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const finishPage = (title, text) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MAIA</title><style>body{font-family:-apple-system,system-ui,sans-serif;max-width:460px;margin:56px auto;padding:0 16px;color:#222;line-height:1.5}a{color:#1976d2}</style></head>
<body><h1 style="font-size:20px">${esc(title)}</h1><p>${esc(text)}</p><p><a href="${esc(ownBase())}/">Back to your MAIA</a></p></body></html>`;

  app.get('/gnap/client/finish/:id', async (req, res, next) => {
    if (!on()) return next();
    res.set('Cache-Control', 'no-store');
    try {
      const og = await getDoc(cloudant, `og_${req.params.id}`);
      const ref = typeof req.query.interact_ref === 'string' ? req.query.interact_ref : '';
      const hash = typeof req.query.hash === 'string' ? req.query.hash : '';
      if (!og || og.type !== 'gnap_out_request' || og.state !== 'verify' || !og.interact?.serverNonce || !ref) return next();
      if (hash !== interactionHash(og.interact.clientNonce, og.interact.serverNonce, ref, og.grantEndpoint)) {
        return res.status(400).type('html').send(finishPage('That didn’t work', 'The email check came back altered. Send the request again from MAIA.'));
      }
      await updateDoc(cloudant, og._id, (x) => { x.interactDone = true; x.state = 'waiting'; return true; });
      const ck = await getDoc(cloudant, og.keyId);
      const done = await apply(await getDoc(cloudant, og._id), await signedCall(ck, 'POST', og.continueUri, { token: og.continueToken, body: { interact_ref: ref } }));
      log('gnap_out_verified', og.userId, { target: og.targetOrigin, state: done.state });
      const text = done.state === 'answered'
        ? 'They shared it. MAIA saves it in your MAIA folder, in Received, the next time you open MAIA.'
        : done.state === 'declined' ? 'They declined this request.'
          : 'Your MAIA sent the request. It waits for their answer and tells you when there is one; you can close this page.';
      res.type('html').send(finishPage('Email confirmed', text));
    } catch (e) {
      console.warn('[gnap-out] finish failed:', e?.message || e);
      res.status(502).type('html').send(finishPage('Not finished yet', 'MAIA couldn’t reach the other MAIA. Try Check now in Requests.'));
    }
  });

  /** Hourly: continue waiting requests; tell the user when one is answered. */
  const pollOutRequests = async () => {
    let all = [];
    try { all = (await cloudant.getAllDocuments(GNAP_DB)) || []; } catch { return 0; }
    let told = 0;
    for (const og of all) {
      if (og?.type !== 'gnap_out_request') continue;
      // Never confirmed, or never answered, within the grant's life.
      if (['verify', 'waiting'].includes(og.state) && Date.parse(og.expiresAt) < now()) {
        await updateDoc(cloudant, og._id, (x) => { x.state = 'expired'; x.continueToken = null; return true; });
        continue;
      }
      if (og.state !== 'waiting' || now() < (og.nextPollAt || 0)) continue;
      try {
        const next = await poll(og);
        if (!['answered', 'declined'].includes(next.state)) continue;
        const u = await loadUser(og.userId);
        if (!u?.emailVerified || !u.email) continue;
        const who = og.label || new URL(og.grantEndpoint).host;
        await sendEmail(u.email, next.state === 'answered' ? `${who} answered your request` : `${who} declined your request`, [
          next.state === 'answered'
            ? `${who} shared what you asked for. MAIA saves it in your MAIA folder, in Received, the next time you open MAIA.`
            : `${who} declined your request.`,
          '',
          `Open MAIA: ${ownBase()}`
        ].join('\n')).catch(() => {});
        told++;
      } catch (e) {
        console.warn('[gnap-out] poll failed:', e?.message || e);
      }
    }
    return told;
  };

  return { pollOutRequests };
}
