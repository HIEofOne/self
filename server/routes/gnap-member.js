/**
 * A member's MAIA as a GNAP client, asking the other members of a group
 * (group_requests.md §10.9 "member to member", §10.13). Only after the
 * member clicks Send (I-33): the MAIA signs with the member's per-group key,
 * which the group knows, so the group attests `group-member` and needs no
 * email check. Answers are sealed to the member's per-group X25519 key; this
 * host opens them and keeps only continuations and short-lived tokens. An
 * answer is read from the answering member's MAIA when the member opens it,
 * and is never stored here (until P9 delivers answers into the folder).
 *
 *   POST /api/gnap/member-requests                        send
 *   GET  /api/gnap/member-requests                        the Sent list (+ the member's groups)
 *   POST /api/gnap/member-requests/:id/refresh            check for answers now
 *   POST /api/gnap/member-requests/:id/answers/:aid/read  read one answer
 *   POST /api/gnap/member-requests/:id/withdraw           withdraw
 * Feature `requests-out` (server/edition-routes.js).
 */
import { randomBytes } from 'crypto';
import { requestedUserId } from '../utils/api-guard.js';
import { signRequest } from '../gnap/httpsig.js';
import { ACCESS_TYPE, GRANT_TTL_MS } from '../gnap/grants.js';
import { POLICY_SCOPES, POLICY_PURPOSES } from './policies.js';
import { GNAP_DB, getDoc, updateDoc } from '../gnap/store.js';
import { openFrom } from '../utils/sealed-box.js';

const USERS_DB = 'maia_users';
const SENT_PER_USER_PER_DAY = 10;
const MAX_MESSAGE = 1000;

/** A continuation or resource URL an answer may point at. */
const okUrl = (u) => /^https:\/\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(u);

export default function setupGnapMemberRoutes(app, {
  cloudant, auditLog = { logEvent: () => {} }, sendEmail = async () => false,
  now = () => Date.now(), publicBaseUrl = () => process.env.PUBLIC_APP_URL
} = {}) {
  const iso = (t) => new Date(t).toISOString();
  const log = (type, userId, details) => { try { auditLog.logEvent({ type, userId, details }); } catch { /* best-effort */ } };
  const ownBase = () => String(publicBaseUrl() || `http://localhost:${process.env.PORT || 3001}`).replace(/\/$/, '');

  const sessionUser = (req, res) => {
    const userId = requestedUserId(req) || req.session?.userId;
    if (!userId || req.session?.userId !== userId) {
      res.status(401).json({ success: false, error: 'NOT_AUTHENTICATED' });
      return null;
    }
    return userId;
  };

  // The group's address as the group signs it: a membership made on this
  // host without a registry URL is this host's public address.
  const groupBase = (m) => {
    const r = String(m.registryUrl || '').replace(/\/$/, '');
    return !r || r === `http://localhost:${process.env.PORT || 3001}` ? ownBase() : r;
  };
  const memberKid = (m) => `member-${m.pairwiseId}`;

  /** A GNAP call signed with the member's per-group key. */
  const signedCall = async (m, method, url, { body = null, token = null } = {}) => {
    const text = body ? JSON.stringify(body) : null;
    const headers = { ...(text ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `GNAP ${token}` } : {}) };
    const sig = signRequest({ method, targetUri: url, headers, body: text, privateJwk: { ...m.signingKeyPair.privateKeyJwk, kid: memberKid(m) } });
    const r = await fetch(url, { method, headers: { ...headers, ...sig }, ...(text ? { body: text } : {}) });
    return { status: r.status, body: r.status === 204 ? {} : await r.json().catch(() => ({})) };
  };

  const loadUser = (userId) => cloudant.getDocument(USERS_DB, userId).catch(() => null);
  const membershipOf = (userDoc, groupId) => (userDoc?.groupMemberships || []).find((m) => m.groupId === groupId) || null;
  const loadSent = async (userId, id) => {
    const sr = await getDoc(cloudant, `sr_${id}`);
    return sr && sr.type === 'gnap_sent_request' && sr.userId === userId ? sr : null;
  };

  /** Open the new sealed answers; keep each one's continuation (not its content). */
  const openNew = (sr, m, boxes) => {
    const known = new Set((sr.answers || []).map((a) => a.id));
    const out = [];
    for (const b of boxes || []) {
      if (!b?.id || known.has(b.id)) continue;
      try {
        const msg = JSON.parse(openFrom(m.encryptionKeyPair.privateKeyJwk, b.box));
        const uri = String(msg?.continue?.uri || '');
        if (msg?.kind !== 'ready' || !okUrl(uri)) throw new Error('not ready');
        out.push({ id: b.id, status: 'ready', continueUri: uri, continueToken: msg.continue.access_token?.value || null, receivedAt: iso(now()) });
      } catch {
        out.push({ id: b.id, status: 'unreadable', receivedAt: iso(now()) });
      }
    }
    return out;
  };

  /** Ask the group for counts and new answers. → { sr, fresh } */
  const refresh = async (sr, userDoc) => {
    const m = membershipOf(userDoc, sr.groupId);
    if (!m || sr.state !== 'sent' || !sr.continueToken) return { sr, fresh: 0 };
    const r = await signedCall(m, 'POST', sr.continueUri, { token: sr.continueToken });
    if (r.body?.continue) {
      const fresh = openNew(sr, m, r.body.maia_group?.answers);
      const next = await updateDoc(cloudant, sr._id, (x) => {
        x.continueUri = r.body.continue.uri;
        x.continueToken = r.body.continue.access_token?.value || null;
        x.nextPollAt = now() + (r.body.continue.wait || 60) * 1000;
        x.counts = r.body.maia_group?.counts || x.counts;
        x.answers = [...(x.answers || []), ...fresh];
        return true;
      });
      return { sr: next, fresh: fresh.length };
    }
    if (r.body?.error?.code === 'invalid_continuation') {
      return { sr: await updateDoc(cloudant, sr._id, (x) => { x.state = 'expired'; x.continueToken = null; return true; }), fresh: 0 };
    }
    return { sr, fresh: 0 }; // too_fast or unreachable: try later
  };

  const view = (sr) => ({
    id: sr._id.slice(3), groupId: sr.groupId, groupName: sr.groupName, to: sr.to || null, toAlias: sr.toAlias || null,
    what: sr.access.datatypes[0], why: sr.access.purpose, message: sr.message || '',
    state: sr.state, counts: sr.counts || { delivered: 0, shared: 0, declined: 0 }, createdAt: sr.createdAt,
    answers: (sr.answers || []).map((a) => ({ id: a.id, status: a.status, receivedAt: a.receivedAt }))
  });

  // ── Send ────────────────────────────────────────────────────────────────

  app.post('/api/gnap/member-requests', async (req, res) => {
    const userId = sessionUser(req, res);
    if (!userId) return;
    try {
      const { groupId, to = null, toAlias = null, datatype, purpose } = req.body || {};
      const message = typeof req.body?.message === 'string' ? req.body.message.trim().slice(0, MAX_MESSAGE) : '';
      if (!POLICY_SCOPES.includes(datatype) || datatype === 'ah-category' || !POLICY_PURPOSES.includes(purpose) || purpose === 'any') {
        return res.status(400).json({ success: false, error: 'INVALID_REQUEST' });
      }
      const userDoc = await loadUser(userId);
      const m = membershipOf(userDoc, groupId);
      if (!m?.signingKeyPair?.privateKeyJwk || !m.encryptionKeyPair?.publicKeyJwk) {
        return res.status(404).json({ success: false, error: 'NOT_A_MEMBER' });
      }
      // A few a day per member (I-33: no amplification through a group).
      const dayAgo = now() - 24 * 60 * 60 * 1000;
      const mine = ((await cloudant.getAllDocuments(GNAP_DB).catch(() => [])) || [])
        .filter((d) => d?.type === 'gnap_sent_request' && d.userId === userId && Date.parse(d.createdAt) > dayAgo);
      if (mine.length >= SENT_PER_USER_PER_DAY) return res.status(429).json({ success: false, error: 'TOO_MANY_TODAY' });

      const url = `${groupBase(m)}/gnap/group/${encodeURIComponent(groupId)}`;
      const r = await signedCall(m, 'POST', url, {
        body: {
          access_token: { access: [{ type: ACCESS_TYPE, actions: [datatype === 'notification-only' ? 'notify' : 'read'], datatypes: [datatype], purpose }] },
          client: { key: { proof: 'httpsig', jwk: { kty: 'OKP', crv: 'Ed25519', x: m.signingKeyPair.publicKeyJwk.x, kid: memberKid(m) } }, display: { name: m.alias || '' } },
          maia_seal_jwk: m.encryptionKeyPair.publicKeyJwk,
          ...(to ? { maia_to: String(to) } : {}),
          ...(message ? { maia_message: message } : {})
        }
      });
      if (!r.body?.continue) {
        const status = r.status === 429 ? 429 : (r.status >= 400 && r.status < 500 ? 400 : 502);
        return res.status(status).json({ success: false, error: r.body?.error?.description || `The group refused the request (HTTP ${r.status})` });
      }
      const id = randomBytes(12).toString('base64url');
      const t = now();
      const sr = {
        _id: `sr_${id}`, type: 'gnap_sent_request', userId, groupId, groupName: m.groupName || groupId,
        to: to || null, toAlias: to ? (typeof toAlias === 'string' ? toAlias.slice(0, 60) : null) : null,
        access: { type: ACCESS_TYPE, datatypes: [datatype], purpose }, message,
        state: 'sent', continueUri: r.body.continue.uri, continueToken: r.body.continue.access_token?.value || null,
        nextPollAt: t + (r.body.continue.wait || 30) * 1000,
        counts: r.body.maia_group?.counts || { delivered: 0, shared: 0, declined: 0 }, answers: [],
        createdAt: iso(t), expiresAt: iso(t + GRANT_TTL_MS), notifiedAnswers: 0
      };
      await cloudant.saveDocument(GNAP_DB, sr);
      log('gnap_member_request_sent', userId, { groupId, to: to ? 'one' : 'all', datatype, purpose, delivered: sr.counts.delivered });
      res.json({ success: true, request: view(sr) });
    } catch (e) {
      console.warn('[gnap-member] send failed:', e?.message || e);
      res.status(500).json({ success: false, error: 'SEND_FAILED' });
    }
  });

  // ── The Sent list ───────────────────────────────────────────────────────

  app.get('/api/gnap/member-requests', async (req, res) => {
    const userId = sessionUser(req, res);
    if (!userId) return;
    try {
      const userDoc = await loadUser(userId);
      const sent = ((await cloudant.getAllDocuments(GNAP_DB).catch(() => [])) || [])
        .filter((d) => d?.type === 'gnap_sent_request' && d.userId === userId)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .map(view);
      const groups = (userDoc?.groupMemberships || []).map((m) => ({ groupId: m.groupId, groupName: m.groupName || m.groupId }));
      res.json({ success: true, groups, sent });
    } catch {
      res.status(500).json({ success: false, error: 'LIST_FAILED' });
    }
  });

  app.post('/api/gnap/member-requests/:id/refresh', async (req, res) => {
    const userId = sessionUser(req, res);
    if (!userId) return;
    try {
      const sr = await loadSent(userId, req.params.id);
      if (!sr) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
      const { sr: next } = await refresh(sr, await loadUser(userId));
      res.json({ success: true, request: view(next) });
    } catch {
      res.status(500).json({ success: false, error: 'REFRESH_FAILED' });
    }
  });

  // Read one answer at the answering member's MAIA: trade its continuation
  // for a key-bound token (once), then read with the token (for an hour).
  app.post('/api/gnap/member-requests/:id/answers/:aid/read', async (req, res) => {
    const userId = sessionUser(req, res);
    if (!userId) return;
    try {
      const sr = await loadSent(userId, req.params.id);
      const a = sr?.answers?.find((x) => x.id === req.params.aid);
      if (!sr || !a || a.status !== 'ready') return res.status(404).json({ success: false, error: 'NOT_FOUND' });
      const m = membershipOf(await loadUser(userId), sr.groupId);
      if (!m) return res.status(404).json({ success: false, error: 'NOT_A_MEMBER' });
      let token = a.token && a.token.expiresAt > now() ? a.token : null;
      if (!token) {
        if (!a.continueToken) return res.status(410).json({ success: false, error: 'EXPIRED' });
        const t = await signedCall(m, 'POST', a.continueUri, { token: a.continueToken });
        const at = t.body?.access_token;
        const location = at?.access?.[0]?.locations?.[0];
        if (!at?.value || !okUrl(String(location || ''))) {
          return res.status(t.status === 400 ? 410 : 502).json({ success: false, error: t.body?.error?.code === 'request_denied' ? 'DECLINED' : 'UNAVAILABLE' });
        }
        token = { value: at.value, location, expiresAt: now() + (at.expires_in || 3600) * 1000 };
        await updateDoc(cloudant, sr._id, (x) => {
          x.answers = (x.answers || []).map((y) => (y.id === a.id ? { ...y, token, continueToken: null } : y));
          return true;
        });
      }
      const rs = await signedCall(m, 'GET', token.location, { token: token.value });
      if (rs.status !== 200) {
        return res.status(410).json({ success: false, error: rs.body?.error?.code === 'invalid_token' ? 'STOPPED' : 'UNAVAILABLE' });
      }
      log('gnap_member_answer_read', userId, { groupId: sr.groupId });
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, answer: { datatype: rs.body.datatype, text: rs.body.text, retrievedAt: rs.body.retrievedAt, attribution: rs.body.attribution } });
    } catch {
      res.status(500).json({ success: false, error: 'READ_FAILED' });
    }
  });

  app.post('/api/gnap/member-requests/:id/withdraw', async (req, res) => {
    const userId = sessionUser(req, res);
    if (!userId) return;
    try {
      const sr = await loadSent(userId, req.params.id);
      if (!sr) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
      const m = membershipOf(await loadUser(userId), sr.groupId);
      if (m && sr.continueToken) await signedCall(m, 'DELETE', sr.continueUri, { token: sr.continueToken }).catch(() => null);
      const next = await updateDoc(cloudant, sr._id, (x) => { x.state = 'withdrawn'; x.continueToken = null; return true; });
      res.json({ success: true, request: view(next) });
    } catch {
      res.status(500).json({ success: false, error: 'WITHDRAW_FAILED' });
    }
  });

  /**
   * Hourly: check open requests whose wait is over, and email the member
   * when new answers arrived (counts only — the answers stay at the
   * answering members' MAIAs until read).
   */
  const pollSentRequests = async () => {
    let all = [];
    try { all = (await cloudant.getAllDocuments(GNAP_DB)) || []; } catch { return 0; }
    let told = 0;
    for (const sr of all) {
      if (sr?.type !== 'gnap_sent_request' || sr.state !== 'sent' || now() < (sr.nextPollAt || 0)) continue;
      if (Date.parse(sr.expiresAt) < now()) {
        await updateDoc(cloudant, sr._id, (x) => { x.state = 'expired'; x.continueToken = null; return true; });
        continue;
      }
      try {
        const userDoc = await loadUser(sr.userId);
        const { sr: next } = await refresh(sr, userDoc);
        const readable = (next.answers || []).filter((a) => a.status === 'ready').length;
        if (readable > (next.notifiedAnswers || 0) && userDoc?.emailVerified && userDoc.email) {
          await updateDoc(cloudant, sr._id, (x) => { x.notifiedAnswers = readable; return true; });
          await sendEmail(userDoc.email, `Members of ${next.groupName} answered your request`, [
            `${readable} member${readable === 1 ? ' has' : 's have'} shared with you in ${next.groupName}.`,
            '',
            `Read the answers in MAIA → Requests → Sent: ${ownBase()}`
          ].join('\n')).catch(() => {});
          told++;
        }
      } catch (e) {
        console.warn('[gnap-member] poll failed:', e?.message || e);
      }
    }
    return told;
  };

  return { pollSentRequests };
}
