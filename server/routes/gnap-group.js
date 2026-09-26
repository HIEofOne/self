/**
 * GNAP group routing — the group's side (group_requests.md §10.9, P6).
 * One signed request reaches every active member of a group, without the
 * requester learning who they are, and without the group being an AS:
 *
 *   OPTIONS /gnap/group/:groupId                    discovery (+ the group's name)
 *   POST    /gnap/group/:groupId                    the requester's signed grant request
 *   GET     /gnap/group-interact/:ix                verify an email once (+ credits)
 *   POST    /gnap/group-interact/:ix/{code,verify,finish}, GET …/credits
 *   POST    /gnap/group/:groupId/continue/:bcast    the requester's poll: counts + sealed answers
 *   DELETE  /gnap/group/:groupId/continue/:bcast    withdraw
 *   POST    /gnap/group/:groupId/answer/:bcast      a member's AS posts a sealed answer (no identity)
 *
 * Once the email is verified, a copy of the exact signed request goes to each
 * member's relay inbox with the group's signed attestation (server/gnap/group.js).
 * Each member's AS decides with its own cards and answers sealed to the
 * requester's X25519 key: the group stores boxes it can't open, and counts.
 * Personal AS edition only (feature `gnap`).
 */
import { randomBytes } from 'crypto';
import { isFeatureEnabled } from '../edition.js';
import * as emailVerification from '../emailVerification.js';
import { verifyGnapRequest, createNonceCache } from '../gnap/httpsig.js';
import {
  GnapError, parseGrantRequest, newHandle, newTokenValue, hashToken, nextWait, interactionHash, GRANT_TTL_MS
} from '../gnap/grants.js';
import { getDoc, updateDoc } from '../gnap/store.js';
import { attachPayment, settleGrantPayment, creditsFor } from '../gnap/payments.js';
import { signAttestation, bodySha256, GNAP_COPY, COPY_SENDER_PREFIX, SIGNED_HEADERS } from '../gnap/group.js';
import { sealTo, isX25519PublicJwk, isSealedBox } from '../utils/sealed-box.js';
import { interactionPage, SCOPE_WORDS } from './gnap.js';

const GROUPS_DB = 'maia_groups';
const RELAY_DB = 'maia_relay';
const MAX_BODY = 64 * 1024;
const MAX_STORED_ANSWERS = 500;
const REQUESTS_PER_GROUP_PER_DAY = 100;
const REQUESTS_PER_EMAIL_PER_DAY = 5;
const GRANTS_PER_IP_PER_10MIN = 30;
const NOTIFY_QUIET_MS = 30 * 60 * 1000;
const FIRST_GROUP_WAIT_S = 30;

export default function setupGnapGroupRoutes(app, {
  cloudant, auditLog = { logEvent: () => {} }, sendEmail = async () => false,
  pullNow = async () => {}, now = () => Date.now(), publicBaseUrl = () => process.env.PUBLIC_APP_URL
} = {}) {
  const nonceCache = createNonceCache();
  const ipWindow = new Map();
  const on = () => isFeatureEnabled('gnap');
  const base = () => String(publicBaseUrl() || `http://localhost:${process.env.PORT || 3001}`).replace(/\/$/, '');
  const log = (type, details) => { try { auditLog.logEvent({ type, details }); } catch { /* best-effort */ } };
  const iso = (t) => new Date(t).toISOString();
  const saveNew = (doc) => cloudant.saveDocument('maia_gnap', doc);

  const fail = (res, e) => {
    const code = e instanceof GnapError ? e.code : 'invalid_request';
    const status = e instanceof GnapError ? e.status : 400;
    return res.status(status).json({ error: { code, description: e?.message || code } });
  };
  const cors = (res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Content-Digest, Signature, Signature-Input');
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  };
  const lowerHeaders = (req) => Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const checkSignature = (req, jwk) => {
    const r = verifyGnapRequest({ method: req.method, targetUri: base() + req.originalUrl, headers: lowerHeaders(req), rawBody: req.rawBody || Buffer.alloc(0) }, jwk, { nonceCache, now: now() });
    if (!r.ok) throw new GnapError('invalid_client', `Signature: ${r.error}`, 401);
    return r;
  };
  const presentedToken = (req) => (/^GNAP\s+(\S+)$/.exec(String(req.headers.authorization || '')) || [])[1] || null;
  const rateLimited = (ip) => {
    const t = now();
    const list = (ipWindow.get(ip) || []).filter((x) => t - x < 10 * 60 * 1000);
    list.push(t);
    ipWindow.set(ip, list);
    return list.length > GRANTS_PER_IP_PER_10MIN;
  };

  const loadGroup = async (groupId) => {
    const g = await cloudant.getDocument(GROUPS_DB, groupId).catch(() => null);
    return g && g.type === 'group' ? g : null;
  };
  const activeMembers = (g) => (g.members || []).filter((m) => m.status === 'active' && m.encryptionPublicKeyJwk);
  const groupEndpoint = (groupId) => `${base()}/gnap/group/${encodeURIComponent(groupId)}`;
  const requestPage = (groupId) => `${base()}/g/${encodeURIComponent(groupId)}/request`;

  /** A daily counter (kept in maia_gnap, never on the group doc, which every
   *  member's refresh writes): false once `limit` is reached today. */
  const countToday = async (prefix, limit) => {
    const day = iso(now()).slice(0, 10);
    const id = `${prefix}_${day}`;
    const c = await getDoc(cloudant, id);
    if ((c?.count || 0) >= limit) return false;
    if (c) await updateDoc(cloudant, id, (x) => { x.count = (x.count || 0) + 1; return true; });
    else await saveNew({ _id: id, type: 'gnap_quota', count: 1, day }).catch(() => {});
    return true;
  };

  // ── Fan-out: a copy of the signed request to every member ──────────────

  const fanOut = async (bcast) => {
    const gb = await getDoc(cloudant, `gb_${bcast}`);
    if (!gb || gb.state !== 'pending' || !gb.requester?.emailVerified) return 0;
    const group = await loadGroup(gb.groupId);
    if (!group?.signingKey?.privateKeyJwk) return 0;
    const attestation = signAttestation(group.signingKey.privateKeyJwk, {
      groupId: gb.groupId, bcast, receivedAt: gb.createdAt, expiresAt: gb.expiresAt,
      targetUri: gb.signed.targetUri, bodySha256: bodySha256(gb.signed.body),
      requester: gb.requester, payment: gb.payment?.type || null,
      answerUri: `${groupEndpoint(gb.groupId)}/answer/${bcast}`
    });
    const copy = JSON.stringify({ maiaType: GNAP_COPY, v: 1, bcast, request: gb.signed, attestation });
    const members = activeMembers(group);
    const t = now();
    let delivered = 0;
    for (const m of members) {
      try {
        await cloudant.saveDocument(RELAY_DB, {
          _id: `relay_${t}_${randomBytes(6).toString('hex')}`, type: 'relay_message', groupId: gb.groupId,
          fromPairwiseId: `${COPY_SENDER_PREFIX}${bcast}`, toPairwiseId: m.pairwiseId,
          box: sealTo(m.encryptionPublicKeyJwk, copy), createdAt: iso(t), expiresAt: gb.expiresAt
        });
        delivered++;
      } catch (e) {
        console.warn('[gnap-group] relay store failed:', e?.message || e);
      }
    }
    await updateDoc(cloudant, gb._id, (g) => { g.state = 'sent'; g.sentAt = iso(t); g.counts = { ...g.counts, delivered }; return true; });
    log('gnap_group_request_sent', { groupId: gb.groupId, bcast, delivered });
    // Members on this host pull now: their cards may answer at once.
    Promise.resolve(pullNow(gb.groupId, members.map((m) => m.pairwiseId)))
      .catch((e) => console.warn('[gnap-group] same-host pull failed:', e?.message || e));
    return delivered;
  };

  // ── Discovery and the grant request ────────────────────────────────────

  app.options('/gnap/group/:groupId', async (req, res, next) => {
    if (!on()) return next();
    const group = await loadGroup(req.params.groupId);
    if (!group) return next();
    cors(res);
    res.json({
      grant_request_endpoint: groupEndpoint(group._id),
      interaction_start_modes_supported: ['redirect'],
      interaction_finish_methods_supported: ['redirect'],
      key_proofs_supported: ['httpsig'],
      key_rotation_supported: false,
      maia_group: { name: group.name, members: activeMembers(group).length }
    });
  });

  app.post('/gnap/group/:groupId', async (req, res, next) => {
    if (!on()) return next();
    cors(res);
    try {
      const group = await loadGroup(req.params.groupId);
      if (!group) return next();
      const raw = req.rawBody || Buffer.alloc(0);
      if (raw.length > MAX_BODY) throw new GnapError('invalid_request', 'Request too large', 413);
      if (rateLimited(req.ip || 'unknown')) throw new GnapError('too_many_attempts', 'Too many requests', 429);
      const parsed = parseGrantRequest(req.body);
      if (!parsed.clientKey) throw new GnapError('invalid_client', 'A group request presents its key, not an instance', 400);
      if (!parsed.interact?.finish) throw new GnapError('invalid_request', 'A group request needs interact (redirect start and finish): the email check');
      if (!isX25519PublicJwk(req.body?.maia_seal_jwk)) throw new GnapError('invalid_request', 'maia_seal_jwk must be a public X25519 JWK');
      const sig = checkSignature(req, parsed.clientKey);
      if (activeMembers(group).length === 0) throw new GnapError('invalid_request', 'This group has no members who can receive requests yet', 409);
      if (!(await countToday(`gg_${hashToken(group._id)}`, REQUESTS_PER_GROUP_PER_DAY))) {
        throw new GnapError('too_many_attempts', 'Too many requests to this group today', 429);
      }

      const bcast = newHandle();
      const ix = newHandle();
      const t = now();
      const value = newTokenValue();
      const gb = {
        _id: `gb_${bcast}`, type: 'gnap_group_request', groupId: group._id, groupName: group.name,
        clientKey: parsed.clientKey, keyThumbprint: sig.thumbprint, sealJwk: req.body.maia_seal_jwk,
        access: parsed.access, displayName: parsed.displayName, message: parsed.message,
        requester: { email: null, emailVerified: false },
        // The request exactly as signed: members re-verify it.
        signed: {
          method: 'POST', targetUri: base() + req.originalUrl,
          headers: Object.fromEntries(SIGNED_HEADERS.map((h) => [h, lowerHeaders(req)[h]]).filter(([, v]) => v !== undefined)),
          body: raw.toString('utf8')
        },
        interact: { ix, finish: parsed.interact.finish, serverNonce: randomBytes(12).toString('base64url'), ref: null, verifiedAt: null },
        state: 'pending', counts: { delivered: 0, shared: 0, declined: 0 }, answers: [],
        continueTokenHash: hashToken(value), polls: 0, nextPollAt: 0,
        createdAt: iso(t), expiresAt: iso(t + GRANT_TTL_MS)
      };
      await saveNew({ _id: `gix_${ix}`, type: 'gnap_group_ix', bcast });
      await saveNew(gb);
      log('gnap_group_request_received', { groupId: group._id, bcast, datatype: parsed.access.datatypes[0], purpose: parsed.access.purpose });
      return res.json({
        continue: { access_token: { value }, uri: `${groupEndpoint(group._id)}/continue/${bcast}`, wait: FIRST_GROUP_WAIT_S },
        interact: { redirect: `${base()}/gnap/group-interact/${ix}`, finish: gb.interact.serverNonce }
      });
    } catch (e) {
      return fail(res, e);
    }
  });

  // ── The requester's poll and withdrawal ────────────────────────────────

  const loadForClient = async (req) => {
    const gb = await getDoc(cloudant, `gb_${req.params.bcast}`);
    if (!gb || gb.groupId !== req.params.groupId) throw new GnapError('invalid_continuation', 'Unknown request', 404);
    const token = presentedToken(req);
    if (!token || !gb.continueTokenHash || hashToken(token) !== gb.continueTokenHash) {
      throw new GnapError('invalid_continuation', 'Invalid continuation token', 401);
    }
    checkSignature(req, gb.clientKey);
    if (Date.parse(gb.expiresAt) < now() || gb.state === 'canceled') throw new GnapError('invalid_continuation', 'The request is closed', 400);
    return gb;
  };

  app.post('/gnap/group/:groupId/continue/:bcast', async (req, res, next) => {
    if (!on()) return next();
    cors(res);
    try {
      const gb = await loadForClient(req);
      const interactRef = typeof req.body?.interact_ref === 'string' ? req.body.interact_ref : null;
      if (interactRef && interactRef !== gb.interact?.ref) throw new GnapError('invalid_interaction', 'Unknown interaction reference');
      // New answers since the last poll can be collected at once (the
      // requester is often back from the "answers" email), and bring the
      // wait back down.
      const fresh = (gb.answers || []).length > (gb.answersAtLastPoll || 0);
      if (!interactRef && !fresh && now() < (gb.nextPollAt || 0)) throw new GnapError('too_fast', 'Continue after the wait you were given');
      const polls = fresh ? 0 : (gb.polls || 0);
      const wait = gb.state === 'pending' ? FIRST_GROUP_WAIT_S : nextWait(polls);
      const value = newTokenValue();
      const g = await updateDoc(cloudant, gb._id, (x) => {
        x.continueTokenHash = hashToken(value);
        x.polls = polls + 1;
        x.nextPollAt = now() + wait * 1000;
        x.answersAtLastPoll = (x.answers || []).length;
        return true;
      });
      return res.json({
        continue: { access_token: { value }, uri: `${groupEndpoint(g.groupId)}/continue/${req.params.bcast}`, wait },
        maia_group: {
          name: g.groupName,
          state: g.state === 'sent' ? 'sent' : 'verify',
          counts: g.counts,
          answers: (g.answers || []).map((a) => ({ id: a.id, box: a.box }))
        }
      });
    } catch (e) {
      return fail(res, e);
    }
  });

  app.delete('/gnap/group/:groupId/continue/:bcast', async (req, res, next) => {
    if (!on()) return next();
    cors(res);
    try {
      const gb = await loadForClient(req);
      await updateDoc(cloudant, gb._id, (x) => { x.state = 'canceled'; x.continueTokenHash = null; return true; });
      await settleGrantPayment(cloudant, gb._id, 'withdrawn');
      log('gnap_group_request_withdrawn', { groupId: gb.groupId, bcast: req.params.bcast });
      return res.status(204).end();
    } catch (e) {
      return fail(res, e);
    }
  });

  // ── A member's answer ──────────────────────────────────────────────────
  // The bcast id is the capability, and nothing identifies the member. The
  // count can't exceed the members the request reached.

  app.post('/gnap/group/:groupId/answer/:bcast', async (req, res, next) => {
    if (!on()) return next();
    try {
      const outcome = req.body?.outcome;
      const box = req.body?.box;
      if (!['shared', 'declined'].includes(outcome) || (outcome === 'shared' && !isSealedBox(box))) {
        return res.status(400).json({ success: false, error: 'outcome shared|declined, and a sealed box for shared' });
      }
      let accepted = false;
      const gb = await updateDoc(cloudant, `gb_${req.params.bcast}`, (x) => {
        accepted = false;
        if (x.groupId !== req.params.groupId || x.state !== 'sent' || Date.parse(x.expiresAt) < now()) return false;
        const c = x.counts || { delivered: 0, shared: 0, declined: 0 };
        if ((c.shared || 0) + (c.declined || 0) >= (c.delivered || 0)) return false;
        x.counts = { ...c, [outcome]: (c[outcome] || 0) + 1 };
        if (outcome === 'shared') {
          x.answers = [...(x.answers || []), { id: randomBytes(9).toString('base64url'), box, at: iso(now()) }].slice(-MAX_STORED_ANSWERS);
        }
        accepted = true;
        return true;
      });
      if (!gb) return next();
      if (!accepted) return res.status(410).json({ success: false, error: 'This request is closed' });
      await settleGrantPayment(cloudant, gb._id, outcome === 'shared' ? 'accepted' : 'answered');
      log('gnap_group_answer', { groupId: gb.groupId, bcast: req.params.bcast, outcome });

      // "Answers are waiting" (§8.2): counts only, at most every 30 minutes.
      const to = gb.requester?.emailVerified ? gb.requester.email : null;
      const quiet = Date.parse(gb.lastNotifiedAt || '') || 0;
      if (to && now() - quiet > NOTIFY_QUIET_MS) {
        await updateDoc(cloudant, gb._id, (x) => { x.lastNotifiedAt = iso(now()); return true; });
        const n = (gb.counts.shared || 0) + (gb.counts.declined || 0);
        sendEmail(to, `Members of ${gb.groupName} answered your request`, [
          `${n} member${n === 1 ? ' has' : 's have'} answered your request to ${gb.groupName} so far.`,
          '',
          `See the answers on your request page, in the same browser you used to ask: ${requestPage(gb.groupId)}`
        ].join('\n')).catch((e) => console.warn('[gnap-group] answer email failed:', e?.message || e));
      }
      return res.status(204).end();
    } catch (e) {
      return res.status(500).json({ success: false, error: 'ANSWER_FAILED' });
    }
  });

  // ── The group's email check (once for all members) ────────────────────

  const loadIx = async (ix) => {
    const link = await getDoc(cloudant, `gix_${ix}`);
    const gb = link ? await getDoc(cloudant, `gb_${link.bcast}`) : null;
    if (!gb || gb.interact?.ix !== ix || gb.state !== 'pending' || Date.parse(gb.expiresAt) < now()) return null;
    return { link, gb };
  };

  const finishInteraction = async (gbId) => {
    const ref = newHandle();
    const gb = await updateDoc(cloudant, gbId, (g) => { g.interact = { ...g.interact, ref }; return true; });
    const f = gb.interact.finish;
    const hash = interactionHash(f.nonce, gb.interact.serverNonce, ref, groupEndpoint(gb.groupId));
    const u = new URL(f.uri);
    u.searchParams.set('hash', hash);
    u.searchParams.set('interact_ref', ref);
    return { success: true, done: true, redirect: u.toString() };
  };

  /** Send the request on to the members; at most a few a day per email. */
  const sendOn = async (gb) => {
    if (!(await countToday(`gq_${hashToken(gb.requester.email.toLowerCase())}`, REQUESTS_PER_EMAIL_PER_DAY))) return false;
    await fanOut(gb._id.slice(3));
    return true;
  };

  app.get('/gnap/group-interact/:ix', async (req, res, next) => {
    if (!on()) return next();
    const found = await loadIx(req.params.ix);
    if (!found) return next();
    const { gb } = found;
    res.set('Cache-Control', 'no-store');
    res.type('html').send(interactionPage({
      what: SCOPE_WORDS[gb.access.datatypes[0]] || gb.access.datatypes[0], purpose: gb.access.purpose,
      verified: !!gb.interact.verifiedAt, audience: `the members of ${gb.groupName}`
    }));
  });

  app.post('/gnap/group-interact/:ix/code', async (req, res, next) => {
    if (!on()) return next();
    try {
      const found = await loadIx(req.params.ix);
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
      // As on the personal page: the code reaches the page only when delivery
      // is switched off (local development), never on a failed send.
      const sent = await sendEmail(r.email, 'Your MAIA verification code',
        `Your MAIA email verification code is ${r.code}. It expires in 10 minutes.\n\nIf you didn't request this, you can ignore this message.`);
      return res.json({ success: true, sent: !!sent, ...(sent ? {} : { devCode: r.code }) });
    } catch {
      return res.status(500).json({ success: false, error: 'SEND_FAILED' });
    }
  });

  app.post('/gnap/group-interact/:ix/verify', async (req, res, next) => {
    if (!on()) return next();
    try {
      const found = await loadIx(req.params.ix);
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
      const gb = await updateDoc(cloudant, found.gb._id, (g) => {
        g.requester = { email, emailVerified: true };
        g.interact = { ...g.interact, verifiedAt: iso(now()) };
        return true;
      });
      const credits = await creditsFor(cloudant, email);
      if (credits.balance > 0) return res.json({ success: true, verified: true, credits });
      if (!(await sendOn(gb))) return res.status(429).json({ success: false, error: 'TOO_MANY_TODAY' });
      return res.json(await finishInteraction(gb._id));
    } catch {
      return res.status(500).json({ success: false, error: 'VERIFY_FAILED' });
    }
  });

  app.get('/gnap/group-interact/:ix/credits', async (req, res, next) => {
    if (!on()) return next();
    const found = await loadIx(req.params.ix);
    if (!found) return next();
    const r = found.gb.requester;
    if (!r?.emailVerified) return res.status(403).json({ success: false, error: 'EMAIL_NOT_VERIFIED' });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, credits: await creditsFor(cloudant, r.email) });
  });

  app.post('/gnap/group-interact/:ix/finish', async (req, res, next) => {
    if (!on()) return next();
    try {
      const found = await loadIx(req.params.ix);
      if (!found) return next();
      if (!found.gb.requester?.emailVerified) return res.status(403).json({ success: false, error: 'EMAIL_NOT_VERIFIED' });
      const payment = typeof req.body?.payment === 'string' && req.body.payment ? req.body.payment : null;
      if (payment) {
        const r = await attachPayment(cloudant, found.gb._id, payment);
        if (!r.ok) return res.status(r.error === 'NOT_ENOUGH_CREDITS' ? 402 : 400).json({ success: false, error: r.error });
      }
      const gb = await getDoc(cloudant, found.gb._id);
      if (!(await sendOn(gb))) {
        if (payment) await settleGrantPayment(cloudant, gb._id, 'withdrawn');
        return res.status(429).json({ success: false, error: 'TOO_MANY_TODAY' });
      }
      return res.json(await finishInteraction(gb._id));
    } catch {
      return res.status(500).json({ success: false, error: 'FINISH_FAILED' });
    }
  });

  return { fanOut };
}
