/**
 * GNAP for a patient's personal AS — the direct route (group_requests.md
 * §10.1–10.8, phase P4). Every request enters through one grant handler
 * (I-30) and data leaves only through the co-located resource server, to a
 * key-bound token (I-28, I-31).
 *
 *   OPTIONS /gnap/as/:asId              discovery (RFC 9635 §9)
 *   POST    /gnap/as/:asId              grant request
 *   POST    /gnap/continue/:grant       continue (poll, or after interaction)
 *   DELETE  /gnap/continue/:grant       the client cancels
 *   GET     /gnap/interact/:ix          requester's page: verify email
 *   POST    /gnap/interact/:ix/code     … send a code
 *   POST    /gnap/interact/:ix/verify   … check it, then finish
 *   DELETE  /gnap/token/:tok            token management: revoke
 *   GET     /gnap/rs/:res               resource server: the filtered artifact
 * and, for the signed-in patient:
 *   GET     /api/gnap/request-link      the personal AS address (made on first use)
 *   POST    /api/gnap/request-link/rotate   a new address; every direct grant stops
 *
 * Personal AS edition only (feature `gnap`); elsewhere these paths don't exist.
 */
import { randomBytes } from 'crypto';
import { isFeatureEnabled } from '../edition.js';
import { requestedUserId } from '../utils/api-guard.js';
import * as emailVerification from '../emailVerification.js';
import { verifyGnapRequest, createNonceCache } from '../gnap/httpsig.js';
import {
  GnapError, parseGrantRequest, toPolicyRequest, decideGrant, artifactFor, mayStillRead,
  newHandle, newTokenValue, hashToken, nextWait, interactionHash,
  GRANT_TTL_MS, TOKEN_TTL_S
} from '../gnap/grants.js';
import { GNAP_DB, getDoc, updateDoc } from '../gnap/store.js';
import { scopeCovers } from './policies.js';

const USERS_DB = 'maia_users';
const AS_REQUESTS_DB = 'maia_as_requests';
const MAX_BODY = 64 * 1024;
const MAX_PENDING_PER_AS = 50;
const GRANTS_PER_IP_PER_10MIN = 30;

const SCOPE_WORDS = {
  'notification-only': 'a notification', 'meds-allergies': 'current medications and allergies',
  'patient-summary': 'the patient summary', 'not-sensitive': 'non-sensitive records',
  everything: 'all records', 'ah-category': 'Apple Health records'
};

export default function setupGnapRoutes(app, {
  cloudant, auditLog = { logEvent: () => {} }, sendEmail = async () => false,
  now = () => Date.now(), publicBaseUrl = () => process.env.PUBLIC_APP_URL
} = {}) {
  const nonceCache = createNonceCache();
  const ipWindow = new Map(); // ip → [timestamps]
  const on = () => isFeatureEnabled('gnap');
  const base = () => String(publicBaseUrl() || `http://localhost:${process.env.PORT || 3001}`).replace(/\/$/, '');
  const log = (type, details) => { try { auditLog.logEvent({ type, details }); } catch { /* audit is best-effort */ } };

  const fail = (res, e) => {
    const code = e instanceof GnapError ? e.code : 'invalid_request';
    const status = e instanceof GnapError ? e.status : 400;
    return res.status(status).json({ error: { code, description: e?.message || code } });
  };

  // The request as signed: target URI rebuilt from the public URL (the
  // platform proxies requests), headers lowercased, exact body bytes.
  const signedMessage = (req) => ({
    method: req.method,
    targetUri: base() + req.originalUrl,
    headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v])),
    rawBody: req.rawBody || Buffer.alloc(0)
  });
  const checkSignature = (req, jwk) => {
    const r = verifyGnapRequest(signedMessage(req), jwk, { nonceCache, now: now() });
    if (!r.ok) throw new GnapError('invalid_client', `Signature: ${r.error}`, 401);
    return r;
  };
  const presentedToken = (req) => {
    const m = /^GNAP\s+(\S+)$/.exec(String(req.headers.authorization || ''));
    return m ? m[1] : null;
  };
  const cors = (res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Content-Digest, Signature, Signature-Input');
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  };

  const saveNew = (doc) => cloudant.saveDocument(GNAP_DB, doc);
  const rateLimited = (ip) => {
    const t = now();
    const list = (ipWindow.get(ip) || []).filter((x) => t - x < 10 * 60 * 1000);
    list.push(t);
    ipWindow.set(ip, list);
    return list.length > GRANTS_PER_IP_PER_10MIN;
  };

  // ── Responses ──────────────────────────────────────────────────────────

  /** "Wait, then continue here": a fresh continuation token every time
   *  (§10.8). Deny-silent and an unanswered ask look exactly alike (I-29). */
  const waitResponse = async (grant, extra = {}) => {
    const value = newTokenValue();
    const wait = nextWait(grant.polls || 0);
    await updateDoc(cloudant, grant._id, (g) => {
      g.continueTokenHash = hashToken(value);
      g.polls = (g.polls || 0) + 1;
      g.nextPollAt = now() + wait * 1000;
      return true;
    });
    return { continue: { access_token: { value }, uri: `${base()}/gnap/continue/${grant._id.slice(3)}`, wait }, ...extra };
  };

  /** Issue a key-bound access token (never bearer, I-28). */
  const tokenResponse = async (grant) => {
    const value = newTokenValue();
    const manage = newTokenValue();
    const manageHandle = newHandle();
    const tokenId = `tok_${hashToken(value)}`;
    const expiresAt = new Date(now() + TOKEN_TTL_S * 1000).toISOString();
    await saveNew({
      _id: tokenId, type: 'gnap_token', grant: grant._id.slice(3), userId: grant.userId,
      clientKey: grant.clientKey, keyThumbprint: grant.keyThumbprint, rsHandle: grant.rsHandle,
      datatype: grant.access.datatypes[0], expiresAt, revoked: false,
      manageHandle, manageTokenHash: hashToken(manage), createdAt: new Date(now()).toISOString()
    });
    await saveNew({ _id: `tm_${manageHandle}`, type: 'gnap_tm', tokenId });
    await updateDoc(cloudant, grant._id, (g) => {
      g.state = 'finalized';
      g.continueTokenHash = null;
      g.tokenIds = [...(g.tokenIds || []), tokenId];
      return true;
    });
    log('gnap_token_issued', { grant: grant._id.slice(3), userId: grant.userId, expiresAt });
    return {
      access_token: {
        value,
        access: [{ ...grant.access, locations: [`${base()}/gnap/rs/${grant.rsHandle}`] }],
        expires_in: TOKEN_TTL_S,
        manage: { uri: `${base()}/gnap/token/${manageHandle}`, access_token: { value: manage } }
      }
    };
  };

  const deniedResponse = async (grant) => {
    await updateDoc(cloudant, grant._id, (g) => { g.state = 'denied'; g.continueTokenHash = null; return true; });
    return { status: 400, body: { error: { code: 'request_denied', description: 'The request was denied' } } };
  };

  // ── The patient's side: notices (no PHI, no artifact — I-31) ────────────

  const notifyPatient = async (userDoc, kind) => {
    const to = userDoc?.emailVerified ? userDoc.email : null;
    if (!to) return;
    const appUrl = base();
    const [subject, text] = kind === 'shared'
      ? ['Your MAIA answered a request',
        `Your MAIA answered a request under one of your sharing rules. See it in MAIA: ${appUrl}`]
      : ['A request is waiting for you in MAIA',
        `Someone asked your MAIA for information. Your rules didn't decide it, so it is waiting for you. Decide in MAIA: ${appUrl}`];
    try { await sendEmail(to, subject, text); } catch { /* notice is best-effort */ }
  };

  /** The patient's own record of the request (their requests list). */
  const recordRequest = async (grant, status, extra = {}) => {
    const id = `asreq_gnap_${grant._id.slice(3)}`;
    const doc = (await cloudant.getDocument(AS_REQUESTS_DB, id).catch(() => null)) || { _id: id };
    Object.assign(doc, {
      type: 'as_request', userId: grant.userId, route: 'gnap-direct', gnapGrant: grant._id.slice(3),
      groupId: null, groupName: 'Direct request', fromOutsider: true,
      requester: {
        name: grant.displayName || null, nameVerified: false,
        email: grant.requester?.email || null, emailVerified: !!grant.requester?.emailVerified
      },
      action: 'request', resource: grant.access.datatypes[0], purpose: grant.access.purpose,
      payload: grant.message || '', receivedAt: doc.receivedAt || grant.createdAt,
      status, ...extra
    });
    try { await cloudant.saveDocument(AS_REQUESTS_DB, doc); } catch (e) { console.warn('[gnap] request record failed:', e?.message || e); }
    return id;
  };

  /** Decide (or re-decide) a pending grant with the current cards and act. */
  const decideAndRespond = async (grant, userDoc, { first = false, extra = {} } = {}) => {
    const d = decideGrant(userDoc, grant.policyRequest);
    const at = new Date(now()).toISOString();
    if (d.outcome === 'allow') {
      await updateDoc(cloudant, grant._id, (g) => { g.decision = { outcome: 'allow', by: 'policy', policyId: d.policyId, at }; return true; });
      await recordRequest(grant, 'accepted', { autonomous: true, decidedAt: at });
      void notifyPatient(userDoc, 'shared');
      log('gnap_decided', { grant: grant._id.slice(3), userId: grant.userId, outcome: 'allow', policyId: d.policyId });
      return { status: 200, body: await tokenResponse(await getDoc(cloudant, grant._id)) };
    }
    if (d.outcome === 'deny-respond') {
      await recordRequest(grant, 'declined', { autonomous: true, decidedAt: at });
      log('gnap_decided', { grant: grant._id.slice(3), userId: grant.userId, outcome: 'deny', policyId: d.policyId });
      return deniedResponse(grant);
    }
    if (d.outcome === 'deny-silent') {
      if (first) {
        await updateDoc(cloudant, grant._id, (g) => { g.silent = true; g.decision = { outcome: 'deny-silent', by: 'policy', policyId: d.policyId, at }; return true; });
        await recordRequest(grant, 'declined', { autonomous: true, decidedAt: at });
        log('gnap_decided', { grant: grant._id.slice(3), userId: grant.userId, outcome: 'deny-silent', policyId: d.policyId });
      }
      return { status: 200, body: await waitResponse(await getDoc(cloudant, grant._id), extra) };
    }
    // ask: the patient decides in their requests list.
    if (first || !grant.asRequestId) {
      const asRequestId = await recordRequest(grant, 'pending');
      await updateDoc(cloudant, grant._id, (g) => { g.asRequestId = asRequestId; return true; });
      void notifyPatient(userDoc, 'ask');
    }
    return { status: 200, body: await waitResponse(await getDoc(cloudant, grant._id), extra) };
  };

  // ── Discovery and the grant request ────────────────────────────────────

  app.options('/gnap/as/:asId', async (req, res, next) => {
    if (!on()) return next();
    const as = await getDoc(cloudant, `as_${req.params.asId}`);
    if (!as || as.retired) return next();
    cors(res);
    res.json({
      grant_request_endpoint: `${base()}/gnap/as/${req.params.asId}`,
      interaction_start_modes_supported: ['redirect'],
      interaction_finish_methods_supported: ['redirect', 'push'],
      key_proofs_supported: ['httpsig'],
      key_rotation_supported: false
    });
  });

  app.post('/gnap/as/:asId', async (req, res, next) => {
    if (!on()) return next();
    cors(res);
    try {
      const as = await getDoc(cloudant, `as_${req.params.asId}`);
      if (!as || as.retired) return next(); // the same 404 as any other path
      if ((req.rawBody || Buffer.alloc(0)).length > MAX_BODY) throw new GnapError('invalid_request', 'Request too large', 413);
      if (rateLimited(req.ip || 'unknown')) throw new GnapError('too_many_attempts', 'Too many requests', 429);
      const parsed = parseGrantRequest(req.body);
      const sig = checkSignature(req, parsed.clientKey);
      const userDoc = await cloudant.getDocument(USERS_DB, as.userId).catch(() => null);
      if (!userDoc) return next();
      // At most MAX_PENDING_PER_AS new requests to one address a day.
      const dayAgo = now() - 24 * 60 * 60 * 1000;
      if ((as.grants || []).filter((e) => Date.parse(e.at) > dayAgo).length >= MAX_PENDING_PER_AS) {
        throw new GnapError('too_many_attempts', 'Too many requests to this address today', 429);
      }

      const handle = newHandle();
      const createdAt = new Date(now()).toISOString();
      const grant = {
        _id: `gr_${handle}`, type: 'gnap_grant', route: 'direct', userId: as.userId, asId: req.params.asId,
        clientKey: parsed.clientKey, keyThumbprint: sig.thumbprint, displayName: parsed.displayName,
        message: parsed.message, access: parsed.access,
        policyRequest: toPolicyRequest(parsed.access),
        requester: { email: null, emailVerified: false },
        state: 'pending', decision: null, silent: false, asRequestId: null,
        continueTokenHash: null, polls: 0, nextPollAt: 0,
        interact: null, rsHandle: newHandle(), tokenIds: [],
        createdAt, expiresAt: new Date(now() + GRANT_TTL_MS).toISOString()
      };
      let extra = {};
      if (parsed.interact) {
        const ix = newHandle();
        grant.interact = { ix, finish: parsed.interact.finish, serverNonce: randomBytes(12).toString('base64url'), ref: null, verifiedAt: null };
        await saveNew({ _id: `ix_${ix}`, type: 'gnap_ix', grant: handle });
        extra = { interact: { redirect: `${base()}/gnap/interact/${ix}`, ...(parsed.interact.finish ? { finish: grant.interact.serverNonce } : {}) } };
      }
      await saveNew(grant);
      await saveNew({ _id: `rs_${grant.rsHandle}`, type: 'gnap_rs', grant: handle });
      // Kept for rotation (every direct grant stops) and the daily cap;
      // grants older than their 30-day life are dropped from the list.
      await updateDoc(cloudant, as._id, (a) => {
        const cutoff = now() - GRANT_TTL_MS;
        a.grants = [...(a.grants || []).filter((e) => Date.parse(e.at) > cutoff), { h: handle, at: createdAt }];
        return true;
      });
      log('gnap_grant_received', { grant: handle, userId: as.userId, datatype: parsed.access.datatypes[0], purpose: parsed.access.purpose });

      // A verified email may change the outcome: with an interaction pending,
      // an allow for an unverified requester still answers at once.
      const out = await decideAndRespond(grant, userDoc, { first: true, extra });
      return res.status(out.status).json(out.body);
    } catch (e) {
      return fail(res, e);
    }
  });

  // ── Continue and cancel ────────────────────────────────────────────────

  const loadGrantForClient = async (req) => {
    const grant = await getDoc(cloudant, `gr_${req.params.grant}`);
    if (!grant) throw new GnapError('invalid_continuation', 'Unknown grant', 404);
    const token = presentedToken(req);
    if (!token || !grant.continueTokenHash || hashToken(token) !== grant.continueTokenHash) {
      throw new GnapError('invalid_continuation', 'Invalid continuation token', 401);
    }
    checkSignature(req, grant.clientKey);
    if (Date.parse(grant.expiresAt) < now()) throw new GnapError('invalid_continuation', 'The grant expired', 400);
    return grant;
  };

  app.post('/gnap/continue/:grant', async (req, res, next) => {
    if (!on()) return next();
    cors(res);
    try {
      const grant = await loadGrantForClient(req);
      const interactRef = typeof req.body?.interact_ref === 'string' ? req.body.interact_ref : null;
      if (interactRef && (!grant.interact?.ref || interactRef !== grant.interact.ref)) {
        throw new GnapError('invalid_interaction', 'Unknown interaction reference');
      }
      // After an interaction the client may continue at once; otherwise it
      // must respect the wait it was given.
      if (!interactRef && now() < (grant.nextPollAt || 0)) {
        throw new GnapError('too_fast', 'Continue after the wait you were given');
      }
      const userDoc = await cloudant.getDocument(USERS_DB, grant.userId).catch(() => null);
      if (!userDoc || grant.state === 'canceled') throw new GnapError('invalid_continuation', 'The grant is no longer available');
      if (grant.state === 'approved') return res.json(await tokenResponse(grant));
      if (grant.state === 'denied') {
        const out = await deniedResponse(grant);
        return res.status(out.status).json(out.body);
      }
      if (grant.state !== 'pending') throw new GnapError('invalid_continuation', 'The grant is finished');
      if (grant.silent) return res.json(await waitResponse(grant));
      const out = await decideAndRespond(grant, userDoc);
      return res.status(out.status).json(out.body);
    } catch (e) {
      return fail(res, e);
    }
  });

  app.delete('/gnap/continue/:grant', async (req, res, next) => {
    if (!on()) return next();
    cors(res);
    try {
      const grant = await loadGrantForClient(req);
      await updateDoc(cloudant, grant._id, (g) => { g.state = 'canceled'; g.continueTokenHash = null; return true; });
      if (grant.asRequestId) {
        try {
          const r = await cloudant.getDocument(AS_REQUESTS_DB, grant.asRequestId);
          if (r && r.status === 'pending') { r.status = 'withdrawn'; await cloudant.saveDocument(AS_REQUESTS_DB, r); }
        } catch { /* the record stays as it was */ }
      }
      return res.status(204).end();
    } catch (e) {
      return fail(res, e);
    }
  });

  // ── Interaction: the requester verifies an email ───────────────────────

  const loadInteraction = async (ix) => {
    const link = await getDoc(cloudant, `ix_${ix}`);
    const grant = link ? await getDoc(cloudant, `gr_${link.grant}`) : null;
    if (!grant || grant.interact?.ix !== ix || grant.state !== 'pending' || Date.parse(grant.expiresAt) < now()) return null;
    return { link, grant };
  };

  app.get('/gnap/interact/:ix', async (req, res, next) => {
    if (!on()) return next();
    const found = await loadInteraction(req.params.ix);
    if (!found) return next();
    const { grant } = found;
    const what = SCOPE_WORDS[grant.access.datatypes[0]] || grant.access.datatypes[0];
    res.set('Cache-Control', 'no-store');
    res.type('html').send(interactionPage({ what, purpose: grant.access.purpose, verified: !!grant.interact.verifiedAt }));
  });

  app.post('/gnap/interact/:ix/code', async (req, res, next) => {
    if (!on()) return next();
    try {
      const found = await loadInteraction(req.params.ix);
      if (!found) return next();
      const email = String(req.body?.email || '').trim();
      if (emailVerification.bypassesVerification(email)) {
        const v = emailVerification.issueVerified(email);
        await updateDoc(cloudant, found.link._id, (l) => { l.emailToken = v.token; return true; });
        return res.json({ success: true, autoVerified: true });
      }
      const r = emailVerification.issueCode(email, found.link.emailToken);
      if (r.error) return res.status(r.error === 'RATE_LIMITED' ? 429 : 400).json({ success: false, error: r.error });
      await updateDoc(cloudant, found.link._id, (l) => { l.emailToken = r.token; return true; });
      const sent = await sendEmail(r.email, 'Your MAIA verification code',
        `Your MAIA email verification code is ${r.code}. It expires in 10 minutes.\n\nIf you didn't request this, you can ignore this message.`).catch(() => false);
      return res.json({ success: true, sent: !!sent, ...(sent ? {} : { devCode: r.code }) });
    } catch (e) {
      return res.status(500).json({ success: false, error: 'SEND_FAILED' });
    }
  });

  app.post('/gnap/interact/:ix/verify', async (req, res, next) => {
    if (!on()) return next();
    try {
      const found = await loadInteraction(req.params.ix);
      if (!found) return next();
      const token = found.link.emailToken;
      let email = null;
      const status = emailVerification.statusOf(token);
      if (status.verified) email = status.email;
      else {
        const r = emailVerification.checkCode(token, req.body?.code);
        if (r.error) return res.status(r.error === 'TOO_MANY_ATTEMPTS' ? 429 : 400).json({ success: false, error: r.error });
        email = r.email;
      }
      const ref = newHandle();
      const grant = await updateDoc(cloudant, found.grant._id, (g) => {
        g.requester = { email, emailVerified: true };
        g.policyRequest = { ...g.policyRequest, signature: 'verified-email' };
        g.interact = { ...g.interact, ref, verifiedAt: new Date(now()).toISOString() };
        return true;
      });
      if (grant.asRequestId) await recordRequest(grant, 'pending');
      log('gnap_interaction_finished', { grant: grant._id.slice(3), userId: grant.userId });
      const finish = grant.interact.finish;
      if (!finish) return res.json({ success: true, done: true });
      const hash = interactionHash(finish.nonce, grant.interact.serverNonce, ref, `${base()}/gnap/as/${grant.asId}`);
      if (finish.method === 'redirect') {
        const u = new URL(finish.uri);
        u.searchParams.set('hash', hash);
        u.searchParams.set('interact_ref', ref);
        return res.json({ success: true, done: true, redirect: u.toString() });
      }
      try {
        await fetch(finish.uri, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hash, interact_ref: ref })
        });
      } catch { /* the client can still continue by polling */ }
      return res.json({ success: true, done: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: 'VERIFY_FAILED' });
    }
  });

  // ── Token management and the resource server ───────────────────────────

  app.delete('/gnap/token/:tok', async (req, res, next) => {
    if (!on()) return next();
    cors(res);
    try {
      const tm = await getDoc(cloudant, `tm_${req.params.tok}`);
      const tok = tm ? await getDoc(cloudant, tm.tokenId) : null;
      const presented = presentedToken(req);
      if (!tok || !presented || hashToken(presented) !== tok.manageTokenHash) {
        throw new GnapError('invalid_request', 'Invalid management token', 401);
      }
      checkSignature(req, tok.clientKey);
      await updateDoc(cloudant, tok._id, (t) => { t.revoked = true; t.revokedAt = new Date(now()).toISOString(); return true; });
      log('gnap_token_revoked', { grant: tok.grant, userId: tok.userId, by: 'client' });
      return res.status(204).end();
    } catch (e) {
      return fail(res, e);
    }
  });

  app.options('/gnap/*', (req, res, next) => {
    if (!on()) return next();
    cors(res);
    res.status(204).end();
  });

  app.get('/gnap/rs/:res', async (req, res, next) => {
    if (!on()) return next();
    cors(res);
    try {
      const presented = presentedToken(req);
      const tok = presented ? await getDoc(cloudant, `tok_${hashToken(presented)}`) : null;
      if (!tok || tok.revoked || tok.rsHandle !== req.params.res || Date.parse(tok.expiresAt) < now()) {
        throw new GnapError('invalid_token', 'Invalid token', 401);
      }
      checkSignature(req, tok.clientKey);
      const requested = typeof req.query.datatype === 'string' ? req.query.datatype : tok.datatype;
      if (!scopeCovers(tok.datatype, requested)) throw new GnapError('insufficient_access', 'Outside the granted access', 403);
      const grant = await getDoc(cloudant, `gr_${tok.grant}`);
      const userDoc = await cloudant.getDocument(USERS_DB, tok.userId).catch(() => null);
      if (!grant || !userDoc || !mayStillRead(userDoc, grant)) throw new GnapError('insufficient_access', 'No longer shared', 403);
      const artifact = artifactFor(userDoc, requested);
      if (!artifact) throw new GnapError('not_available', 'Nothing to share yet', 404);
      log('gnap_rs_read', { grant: tok.grant, userId: tok.userId, datatype: requested });
      res.set('Cache-Control', 'no-store');
      return res.json({
        datatype: artifact.datatype,
        text: artifact.text,
        retrievedAt: new Date(now()).toISOString(),
        attribution: "Released by the patient's MAIA under the patient's sharing rules. Names are replaced with made-up ones."
      });
    } catch (e) {
      return fail(res, e);
    }
  });

  // ── The patient's personal request address ─────────────────────────────

  const sessionUser = (req, res) => {
    const userId = requestedUserId(req) || req.session?.userId;
    if (!userId || req.session?.userId !== userId) {
      res.status(401).json({ success: false, error: 'NOT_AUTHENTICATED' });
      return null;
    }
    return userId;
  };
  const linkFor = (asId) => ({ asId, grantEndpoint: `${base()}/gnap/as/${asId}`, pageUrl: `${base()}/r/${asId}` });

  const newAsId = async (userId) => {
    const asId = randomBytes(16).toString('hex');
    await saveNew({ _id: `as_${asId}`, type: 'gnap_as', userId, asId, grants: [], createdAt: new Date(now()).toISOString() });
    return asId;
  };

  app.get('/api/gnap/request-link', async (req, res) => {
    const userId = sessionUser(req, res);
    if (!userId) return;
    try {
      const userDoc = await cloudant.getDocument(USERS_DB, userId);
      if (!userDoc) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
      let asId = userDoc.asId;
      const index = asId ? await getDoc(cloudant, `as_${asId}`) : null;
      if (!asId || !index || index.userId !== userId || index.retired) {
        if (asId && !index) {
          // An address made before GNAP (groups.js): index it as it is.
          await saveNew({ _id: `as_${asId}`, type: 'gnap_as', userId, asId, grants: [], createdAt: new Date(now()).toISOString() });
        } else {
          asId = await newAsId(userId);
          userDoc.asId = asId;
          userDoc.updatedAt = new Date(now()).toISOString();
          await cloudant.saveDocument(USERS_DB, userDoc);
        }
      }
      res.json({ success: true, ...linkFor(asId) });
    } catch (e) {
      res.status(500).json({ success: false, error: 'LINK_FAILED' });
    }
  });

  // "Change my request link" — the spam escape hatch (§10.2): the old
  // address stops answering and every direct grant made through it stops,
  // tokens included.
  app.post('/api/gnap/request-link/rotate', async (req, res) => {
    const userId = sessionUser(req, res);
    if (!userId) return;
    try {
      const userDoc = await cloudant.getDocument(USERS_DB, userId);
      if (!userDoc) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
      const old = userDoc.asId ? await getDoc(cloudant, `as_${userDoc.asId}`) : null;
      if (old && old.userId === userId) {
        for (const { h: handle } of old.grants || []) {
          const g = await updateDoc(cloudant, `gr_${handle}`, (x) => { x.state = 'canceled'; x.continueTokenHash = null; return true; });
          for (const tokenId of g?.tokenIds || []) {
            await updateDoc(cloudant, tokenId, (t) => { t.revoked = true; t.revokedAt = new Date(now()).toISOString(); return true; });
          }
        }
        await updateDoc(cloudant, old._id, (a) => { a.retired = true; return true; });
      }
      const asId = await newAsId(userId);
      userDoc.asId = asId;
      userDoc.updatedAt = new Date(now()).toISOString();
      await cloudant.saveDocument(USERS_DB, userDoc);
      log('gnap_link_rotated', { userId, grantsStopped: (old?.grants || []).length });
      res.json({ success: true, ...linkFor(asId) });
    } catch (e) {
      res.status(500).json({ success: false, error: 'ROTATE_FAILED' });
    }
  });
}

// The requester's interaction page: verify an email, then go back to the
// requesting app. Everything shown is data from the request (no PHI).
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function interactionPage({ what, purpose, verified }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MAIA — verify your email</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 460px; margin: 48px auto; padding: 0 16px; color: #222; }
  h1 { font-size: 20px; } p { line-height: 1.45; } .muted { color: #666; font-size: 14px; }
  input { font-size: 16px; padding: 8px; width: 100%; box-sizing: border-box; margin: 6px 0 10px; }
  button { font-size: 15px; padding: 8px 16px; background: #1976d2; color: #fff; border: 0; border-radius: 4px; cursor: pointer; }
  .err { color: #b00020; } [hidden] { display: none !important; }
</style></head>
<body>
  <h1>Verify your email</h1>
  <p>You asked a MAIA for <strong>${escapeHtml(what)}</strong> for <strong>${escapeHtml(purpose)}</strong> use.
     The patient's rules may answer a request from a verified email that an unverified one can't get.</p>
  <div id="step-email"${verified ? ' hidden' : ''}>
    <label>Your email<input id="email" type="email" autocomplete="email"></label>
    <button id="send">Send code</button>
  </div>
  <div id="step-code" hidden>
    <label>The 6-digit code we emailed you<input id="code" inputmode="numeric" autocomplete="one-time-code"></label>
    <button id="verify">Verify</button>
    <p class="muted" id="dev"></p>
  </div>
  <p id="done"${verified ? '' : ' hidden'}>Your email is verified. You can go back to the app that sent your request.</p>
  <p class="err" id="err"></p>
<script>
  const base = location.pathname.replace(/\\/$/, '');
  const $ = (id) => document.getElementById(id);
  const post = async (path, body) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  };
  const finish = async () => {
    const { ok, data } = await post('/verify', { code: $('code').value.trim() });
    if (!ok) { $('err').textContent = data.error === 'BAD_CODE' ? 'That code is not right.' : 'Could not verify. Try again.'; return; }
    if (data.redirect) { location.href = data.redirect; return; }
    $('step-code').hidden = true; $('step-email').hidden = true; $('done').hidden = false;
  };
  $('send').onclick = async () => {
    $('err').textContent = '';
    const { ok, data } = await post('/code', { email: $('email').value.trim() });
    if (!ok) { $('err').textContent = data.error === 'INVALID_EMAIL' ? 'Enter a valid email.' : 'Could not send a code. Try again.'; return; }
    if (data.autoVerified) return finish();
    $('step-email').hidden = true; $('step-code').hidden = false;
    if (data.devCode) $('dev').textContent = '(Email delivery is off here. Code: ' + data.devCode + ')';
  };
  $('verify').onclick = finish;
</script>
</body></html>`;
}
