/**
 * Groups & Authorization Server — Phase 1: Group Registry + membership.
 *
 * The group registry holds ONLY what is needed to control membership and to
 * enable mediated, privacy-preserving communication — never clinical data,
 * never interest profiles. See Documentation/Groups.md (§3.1 data model,
 * §6 resolved design decisions, §7 Phase 1 plan).
 *
 * PR-1: group CRUD + per-group signing keys + public info endpoint +
 *       admin recovery kit (§6.7).
 * PR-2: invites (email + one-time token), join flow (member keypairs +
 *       signed 24h membership credential, §6.1), member management,
 *       and the patient-side /api/user-groups endpoints.
 * PR-3 (relay/heartbeat), PR-4 (requests inbox), PR-5 (directory) follow.
 */
import { evaluatePolicies, policySentence, normalizeCard, POLICY_SCOPES, POLICY_PURPOSES } from './policies.js';
import { applyPseudonymMapping } from '../privacyFilter.js';
import { isVerified as emailTokenVerified } from '../emailVerification.js';
import { CREDIT_PRICES, holdCredits, chargeCredits, resolveHold, getAccount } from '../credits.js';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import {
  generateKeyPairSync, createHash, createPrivateKey, createPublicKey,
  randomBytes, sign as edSign, verify as edVerify,
  diffieHellman, hkdfSync, createCipheriv, createDecipheriv
} from 'crypto';

const GROUPS_DB = 'maia_groups';
const USERS_DB = 'maia_users';
const RELAY_DB = 'maia_relay';
const AS_REQUESTS_DB = 'maia_as_requests';

/** Invite tokens are single-use and expire after 14 days. */
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Membership credentials live 24 hours (Groups.md §6.1). */
const CREDENTIAL_TTL_MS = 24 * 60 * 60 * 1000;
/** Undelivered relay messages are swept after 30 days (Groups.md §6.3). */
const RELAY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A membership is "recently active" (liquidity signal) if refreshed within
 *  48 h — twice the daily refresh cadence, tolerant of a missed beat. */
const LIVENESS_WINDOW_MS = 48 * 60 * 60 * 1000;
/** Cap the decrypted inbox stored per membership on the userDoc. */
const INBOX_MAX = 200;
/** Cap the sent-message log stored per membership on the userDoc. Sent
 *  messages are recorded locally (never at the registry) so the Groups
 *  tab can render both sides of a conversation thread. */
const OUTBOX_MAX = 200;

const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
const b64u = (buf) => Buffer.from(buf).toString('base64url');

// ── E2E sealed box (Groups.md §6.3) ────────────────────────────────
// X25519 ECDH → HKDF-SHA256 → AES-256-GCM. The sender seals to the
// recipient's per-group X25519 public key using an ephemeral keypair; the
// relay stores only the resulting opaque box + routing envelope and never
// holds a key. The recipient's MAIA opens it with its private key.
const RELAY_HKDF_INFO = Buffer.from('maia-group-relay-v1');

const sealTo = (recipientEncPubJwk, plaintext) => {
  const eph = generateKeyPairSync('x25519');
  const recipientPub = createPublicKey({ key: recipientEncPubJwk, format: 'jwk' });
  const secret = diffieHellman({ privateKey: eph.privateKey, publicKey: recipientPub });
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), RELAY_HKDF_INFO, 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return {
    v: 1,
    epk: eph.publicKey.export({ format: 'jwk' }),
    iv: iv.toString('base64url'),
    ct: ct.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url')
  };
};

const openFrom = (recipientEncPrivJwk, box) => {
  const priv = createPrivateKey({ key: recipientEncPrivJwk, format: 'jwk' });
  const epk = createPublicKey({ key: box.epk, format: 'jwk' });
  const secret = diffieHellman({ privateKey: priv, publicKey: epk });
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), RELAY_HKDF_INFO, 32));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(box.ct, 'base64url')), decipher.final()]).toString('utf8');
};

/** Verify a detached Ed25519 signature (base64url) over `payload` (string)
 *  against a JWK public key. Returns the parsed claim on success, else null. */
const verifySignedClaim = (payload, signature, publicKeyJwk, expect = {}) => {
  try {
    const pub = createPublicKey({ key: publicKeyJwk, format: 'jwk' });
    if (!edVerify(null, Buffer.from(String(payload)), pub, Buffer.from(String(signature), 'base64url'))) {
      return null;
    }
    const claim = JSON.parse(String(payload));
    for (const [k, v] of Object.entries(expect)) {
      if (claim[k] !== v) return null;
    }
    return claim;
  } catch {
    return null;
  }
};

/**
 * Membership credential (Groups.md §3.1, interim format per §7.2):
 * base64url(JSON payload) + '.' + base64url(Ed25519 signature).
 * Verifiable OFFLINE against the group's published public key — the
 * registry never observes member-to-member interactions (§6.1).
 */
const signMembershipCredential = (group, member) => {
  const now = Date.now();
  const payload = {
    format: 'maia-group-credential-v1',
    groupId: group._id,
    pairwiseId: member.pairwiseId,
    signingPublicKeyJwk: member.signingPublicKeyJwk,
    iat: new Date(now).toISOString(),
    exp: new Date(now + CREDENTIAL_TTL_MS).toISOString()
  };
  const payloadBuf = Buffer.from(JSON.stringify(payload));
  const key = createPrivateKey({ key: group.signingKey.privateKeyJwk, format: 'jwk' });
  const sig = edSign(null, payloadBuf, key);
  return { value: `${b64u(payloadBuf)}.${b64u(sig)}`, expiresAt: payload.exp };
};

/** Max tags in a group's match-query vocabulary (Groups.md §6.5: small,
 *  admin-curated — "a dozen condition-appropriate entries"). */
const MAX_TAGS = 24;
const MAX_TAG_LENGTH = 32;

const slugify = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/** Normalize a tag vocabulary: accepts an array or comma-separated string;
 *  lowercases, slugifies, dedupes, caps count and length. */
const normalizeTags = (input) => {
  const raw = Array.isArray(input)
    ? input
    : String(input || '').split(',');
  const seen = new Set();
  const tags = [];
  for (const t of raw) {
    const tag = slugify(t).slice(0, MAX_TAG_LENGTH);
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
      if (tags.length >= MAX_TAGS) break;
    }
  }
  return tags;
};

const memberCounts = (doc) => {
  const counts = { active: 0, invited: 0, revoked: 0, requested: 0 };
  for (const m of doc.members || []) {
    if (m?.status && counts[m.status] !== undefined) counts[m.status]++;
  }
  return counts;
};

/** Public join-request link for a link-approval group (PR-9). One stable,
 *  admin-rotatable URL — printable as a QR code. Anyone who opens it can
 *  REQUEST to join; the admin approves each request, so a leaked link
 *  never grants membership by itself. */
const joinLinkFor = (doc) => {
  if (!['link-approval', 'open'].includes(doc.joinMode) || !doc.joinLinkToken) return null;
  const appUrl = (process.env.PUBLIC_APP_URL || 'http://localhost:5173').replace(/\/$/, '');
  return `${appUrl}/?groupJoin=${doc.joinLinkToken}&groupId=${encodeURIComponent(doc._id)}&registry=${encodeURIComponent(appUrl)}`;
};

/** Admin-facing view: everything except the private signing key and any
 *  invite emails. The private key NEVER leaves the server via this view —
 *  the sole, deliberate exception is the recovery-kit export (§6.7). */
const adminGroupView = (doc) => ({
  groupId: doc._id,
  name: doc.name,
  description: doc.description || '',
  // Admin policy: may active members invite new people themselves?
  // Default true (member virality is the adoption engine); the admin
  // can turn it off per group.
  memberInvitesAllowed: doc.memberInvitesAllowed !== false,
  postingPolicy: doc.postingPolicy || '',
  // Admin policy: how people join. 'invite-only' (default),
  // 'link-approval' (anyone with the link can REQUEST; admin approves
  // each), or 'open' (anyone with the link becomes a member INSTANTLY —
  // the zero-latency bootstrap mode; the admin can still revoke, and the
  // link is still rotatable).
  joinMode: ['link-approval', 'open'].includes(doc.joinMode) ? doc.joinMode : 'invite-only',
  joinLink: joinLinkFor(doc),
  // Welcome-page listing (Refinement 8): admin opt-in, default OFF —
  // invite-only groups stay invisible (no honeypot directory).
  publiclyListed: doc.publiclyListed === true,
  // Suggested member policies (group policy pack v1): cards each joiner
  // imports as editable provenance-'group:<id>' cards.
  suggestedPolicies: doc.suggestedPolicies || [],
  tagVocabulary: doc.tagVocabulary || [],
  publicKeyJwk: doc.signingKey?.publicKeyJwk || null,
  policyPackVersion: doc.policyPackVersion ?? 0,
  memberCounts: memberCounts(doc),
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
  recoveryKitLastExportedAt: doc.recoveryKit?.lastExportedAt || null,
  recoveryKitExportCount: doc.recoveryKit?.exportCount || 0
});

/** Public well-known view (Groups.md §7.3): enough for a prospective or
 *  current member's MAIA to identify the group and verify credentials —
 *  metadata + the group's public signing key + aggregate size only. */
const publicGroupView = (doc) => ({
  groupId: doc._id,
  name: doc.name,
  description: doc.description || '',
  // Posting policy (PR-10, Layer-1 "displayed" policy): shown on the
  // join/invite cards — joining is accepting. Free text, admin-authored.
  postingPolicy: doc.postingPolicy || '',
  suggestedPolicies: (doc.suggestedPolicies || []).map((c) => ({ ...c, sentence: policySentence(c) })),
  tagVocabulary: doc.tagVocabulary || [],
  publicKeyJwk: doc.signingKey?.publicKeyJwk || null,
  activeMemberCount: memberCounts(doc).active
});

export default function setupGroupRoutes(app, cloudant, auditLog, { sendEmail, webauthn } = {}) {
  // Same admin gate as GET /api/admin/users: localhost bypass for local
  // development; otherwise the session user must be the admin.
  const requireAdmin = (req, res) => {
    const isLocalhost = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
    if (isLocalhost) return true;
    const sessionUserId = req.session?.userId;
    const adminUsername = (process.env.ADMIN_USERNAME || 'admin');
    if (!sessionUserId) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return false;
    }
    if (sessionUserId !== adminUsername) {
      res.status(403).json({ success: false, error: 'Access denied. Admin privileges required.' });
      return false;
    }
    return true;
  };

  // POST /api/groups — create a group (admin).
  app.post('/api/groups', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { name, description = '', tagVocabulary = [], postingPolicy = '' } = req.body || {};
      if (!name || !String(name).trim()) {
        return res.status(400).json({ success: false, error: 'name is required' });
      }
      const base = slugify(name) || 'group';
      const groupId = `${base}-${Math.random().toString(36).slice(2, 8)}`;

      // Per-group Ed25519 signing keypair (Groups.md §6.6): membership
      // credentials verify against the GROUP's key, not the deployment's,
      // so a group can migrate hosts without re-keying its members.
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');

      const now = new Date().toISOString();
      const doc = {
        _id: groupId,
        type: 'group',
        name: String(name).trim(),
        description: String(description || '').trim(),
        postingPolicy: String(postingPolicy || '').trim().slice(0, 4000),
        tagVocabulary: normalizeTags(tagVocabulary),
        signingKey: {
          publicKeyJwk: publicKey.export({ format: 'jwk' }),
          privateKeyJwk: privateKey.export({ format: 'jwk' })
        },
        policyPackVersion: 0,
        members: [],
        createdAt: now,
        updatedAt: now
      };
      await cloudant.saveDocument(GROUPS_DB, doc);
      auditLog.logEvent({
        type: 'group_created',
        userId: req.session?.userId || 'admin-local',
        ip: req.ip,
        details: { groupId, name: doc.name }
      });
      res.json({ success: true, group: adminGroupView(doc) });
    } catch (error) {
      console.error('[groups] create failed:', error);
      res.status(500).json({ success: false, error: 'Failed to create group' });
    }
  });

  // GET /api/groups — list groups (admin).
  app.get('/api/groups', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const all = await cloudant.getAllDocuments(GROUPS_DB);
      const groups = (all || [])
        .filter((d) => d && d.type === 'group' && !String(d._id).startsWith('_design'))
        .map(adminGroupView)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      res.json({ success: true, groups });
    } catch (error) {
      console.error('[groups] list failed:', error);
      res.status(500).json({ success: false, error: 'Failed to list groups' });
    }
  });

  // PUT /api/groups/:groupId — update metadata / tag vocabulary (admin).
  app.put('/api/groups/:groupId', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') {
        return res.status(404).json({ success: false, error: 'Group not found' });
      }
      const { name, description, tagVocabulary } = req.body || {};
      if (name !== undefined) {
        if (!String(name).trim()) {
          return res.status(400).json({ success: false, error: 'name cannot be empty' });
        }
        doc.name = String(name).trim();
      }
      if (description !== undefined) doc.description = String(description || '').trim();
      if (req.body?.postingPolicy !== undefined) {
        doc.postingPolicy = String(req.body.postingPolicy || '').trim().slice(0, 4000);
      }
      if (tagVocabulary !== undefined) doc.tagVocabulary = normalizeTags(tagVocabulary);
      if (req.body?.memberInvitesAllowed !== undefined) {
        doc.memberInvitesAllowed = !!req.body.memberInvitesAllowed;
      }
      if (req.body?.publiclyListed !== undefined) {
        doc.publiclyListed = !!req.body.publiclyListed;
      }
      if (req.body?.suggestedPolicies !== undefined) {
        const raw = Array.isArray(req.body.suggestedPolicies) ? req.body.suggestedPolicies : [];
        // A group's own suggested cards always refer to THIS group. Stamp the
        // authoritative id/name before normalizing — imported policy files and
        // creation-time authoring otherwise carry a stale or empty groupId
        // (the trustee-0zujj2 vs trustee-mchluz bug: cards that never match).
        const stamped = raw.map((c) => (c?.elements?.party?.type === 'group'
          ? { ...c, elements: { ...c.elements, party: { ...c.elements.party, groupId: doc._id, groupName: doc.name } } }
          : c));
        const clean = stamped.map((c) => normalizeCard(c)).filter(Boolean).slice(0, 20);
        if (clean.length !== raw.length) {
          return res.status(400).json({ success: false, error: 'One or more suggested policies are invalid' });
        }
        doc.suggestedPolicies = clean;
      }
      if (req.body?.joinMode !== undefined) {
        doc.joinMode = ['link-approval', 'open'].includes(req.body.joinMode) ? req.body.joinMode : 'invite-only';
        // Mint the shareable link token on first enable; rotation is a
        // separate explicit action (POST rotate-join-link).
        if (['link-approval', 'open'].includes(doc.joinMode) && !doc.joinLinkToken) {
          doc.joinLinkToken = randomBytes(16).toString('hex');
        }
      }
      doc.updatedAt = new Date().toISOString();
      await cloudant.saveDocument(GROUPS_DB, doc);
      auditLog.logEvent({
        type: 'group_updated',
        userId: req.session?.userId || 'admin-local',
        ip: req.ip,
        details: { groupId: doc._id, fields: Object.keys(req.body || {}) }
      });
      res.json({ success: true, group: adminGroupView(doc) });
    } catch (error) {
      console.error('[groups] update failed:', error);
      res.status(500).json({ success: false, error: 'Failed to update group' });
    }
  });

  // GET /api/groups/public — the deployment's publicly-listed groups for
  // the welcome page (Refinement 8). Admin opt-in per group; returns only
  // what the design allows ANYONE to see: name, description, posting
  // policy, aggregate liquidity — never a roster. The join link is
  // included only when the group accepts link-approval join requests.
  // Featured PEER registries (Refinement 8): FEATURED_GROUP_REGISTRIES is
  // a comma-separated list of other MAIA deployments whose public groups
  // this welcome page also features (e.g. the standalone Trustee demo).
  // Fetched server-to-server (no CORS) with a short cache; each remote
  // card carries originHost so the UI can say "hosted at trustee.ai".
  // Join links are absolute and carry their own registry= param, so
  // Ask-to-join works cross-host via the existing federation path.
  let featuredCache = { at: 0, groups: [] };
  const fetchFeaturedGroups = async () => {
    const raw = (process.env.FEATURED_GROUP_REGISTRIES || '').trim();
    if (!raw) return [];
    if (Date.now() - featuredCache.at < 60_000) return featuredCache.groups;
    const peers = raw.split(',').map((u) => u.trim().replace(/\/$/, '')).filter(Boolean);
    const out = [];
    for (const peer of peers) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3000);
        const r = await fetch(`${peer}/api/groups/public`, { signal: ctrl.signal });
        clearTimeout(t);
        const data = await r.json().catch(() => ({}));
        if (r.ok && data.success) {
          for (const g of data.groups || []) {
            out.push({ ...g, origin: peer, originHost: new URL(peer).hostname });
          }
        }
      } catch { /* peer down — skip */ }
    }
    featuredCache = { at: Date.now(), groups: out };
    return out;
  };

  app.get('/api/groups/public', async (req, res) => {
    try {
      const all = await cloudant.getAllDocuments(GROUPS_DB);
      const local = (all || [])
        .filter((d) => d && d.type === 'group' && d.publiclyListed === true)
        .map((d) => ({
          groupId: d._id,
          name: d.name,
          description: d.description || '',
          postingPolicy: d.postingPolicy || '',
          activeMemberCount: memberCounts(d).active,
          mentors: (d.members || [])
            .filter((m) => m.status === 'active' && m.mentor)
            .map((m) => ({ alias: m.alias || '(member)', tag: m.mentorTag || '' })),
          joinLink: joinLinkFor(d),
          joinMode: ['link-approval', 'open'].includes(d.joinMode) ? d.joinMode : 'invite-only',
          origin: null,
          originHost: null
        }));
      const featured = await fetchFeaturedGroups();
      // Featured (remote) groups first — they are the deployment's chosen
      // demo — then local, both alphabetical.
      const byName = (a, b) => a.name.localeCompare(b.name);
      res.json({ success: true, groups: [...featured.sort(byName), ...local.sort(byName)] });
    } catch (error) {
      console.error('[groups] public list failed:', error);
      res.status(500).json({ success: false, error: 'Failed to list groups' });
    }
  });

  // ── Vouch credentials (Phase 1): 'verified-by-me' made real ─────────
  //
  // A patient who has matched a requester out-of-band (voice or video —
  // biometrics never enter MAIA; the code hand-off IS the trust event)
  // mints a one-time registration code from their Workbook. The requester
  // redeems it on this registry's welcome page and binds a PASSKEY; the
  // vouch record {credential key ↔ voucher pairwiseId} lives here. At
  // send time a passkey assertion proves possession, and the registry
  // attests 'verified-by-me' ONLY in the envelope sealed to the vouching
  // member — the same attestation trust seam member ASes already honor
  // for 'verified-email'. Issuer == evaluator, so revocation is a local
  // fact (the patient revokes; the record flips; sends re-check it).
  //
  // Forward-compatibility (UCAN roadmap): the record binds a SUBJECT KEY,
  // never a bearer secret — the credential public key is the principal a
  // future delegation chain would anchor to.
  const VOUCH_CODE_TTL_MS = 24 * 60 * 60 * 1000; // code: single-use, 24 h
  const VOUCH_TOKEN_TTL_MS = 10 * 60 * 1000;     // proven-possession session
  const CHALLENGE_TTL_MS = 5 * 60 * 1000;
  // Readable-aloud alphabet (no I/L/O/0/1): the patient SPEAKS this code.
  const VOUCH_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const vouchCode = () =>
    Array.from(randomBytes(6)).map((b) => VOUCH_CODE_ALPHABET[b % VOUCH_CODE_ALPHABET.length]).join('');

  const vouchChallenges = new Map(); // token -> { type, groupId, vouchId?, challenge, expiresAt }
  const vouchTokens = new Map();     // token -> { groupId, vouchId, voucherPairwiseId, expiresAt }
  const vouchRate = new Map();       // ip -> { count, resetAt } (redeem/assert attempts)

  const vouchRp = () => {
    const u = new URL(process.env.PUBLIC_APP_URL || 'http://localhost:5173');
    return { rpID: u.hostname, origin: u.origin, rpName: 'MAIA' };
  };

  // Injectable for the two-host simulation; real ceremonies otherwise.
  const wa = webauthn || {
    async registrationOptions({ rpID, rpName, userName }) {
      return await generateRegistrationOptions({
        rpName, rpID,
        userID: randomBytes(16),
        userName,
        attestation: 'none',
        // Discoverable credential so "I've been vouched on this device"
        // works usernameless later; UV required like account passkeys.
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
      });
    },
    async verifyRegistration({ response, expectedChallenge, expectedOrigin, expectedRPID }) {
      const v = await verifyRegistrationResponse({
        response, expectedChallenge, expectedOrigin, expectedRPID, requireUserVerification: true
      });
      if (!v.verified) return null;
      return {
        credentialId: v.registrationInfo.credential.id,
        credentialPublicKey: isoBase64URL.fromBuffer(v.registrationInfo.credential.publicKey),
        counter: v.registrationInfo.credential.counter || 0
      };
    },
    async authenticationOptions({ rpID }) {
      return await generateAuthenticationOptions({ rpID, userVerification: 'required', timeout: 60000 });
    },
    async verifyAuthentication({ response, expectedChallenge, expectedOrigin, expectedRPID, credentialPublicKey, counter }) {
      const v = await verifyAuthenticationResponse({
        response, expectedChallenge, expectedOrigin, expectedRPID,
        credential: { id: response.id, publicKey: isoBase64URL.toBuffer(credentialPublicKey), counter: counter || 0 },
        requireUserVerification: true
      });
      if (!v.verified) return null;
      return { newCounter: v.authenticationInfo?.newCounter ?? counter ?? 0 };
    }
  };

  const vouchRateOk = (ip) => {
    const now = Date.now();
    const rl = vouchRate.get(ip);
    if (rl && now < rl.resetAt && rl.count >= 10) return false;
    vouchRate.set(ip, (!rl || now >= rl.resetAt)
      ? { count: 1, resetAt: now + 10 * 60 * 1000 }
      : { count: rl.count + 1, resetAt: rl.resetAt });
    if (vouchRate.size > 500) {
      for (const [k, v] of vouchRate) if (now >= v.resetAt) vouchRate.delete(k);
    }
    return true;
  };

  const sweepVouchMaps = () => {
    const now = Date.now();
    if (vouchChallenges.size > 500) {
      for (const [k, v] of vouchChallenges) if (now >= v.expiresAt) vouchChallenges.delete(k);
    }
    if (vouchTokens.size > 500) {
      for (const [k, v] of vouchTokens) if (now >= v.expiresAt) vouchTokens.delete(k);
    }
  };

  /** Resolve a send-time vouch token to its voucher, re-checking the
   *  stored record (revocation wins over a still-live session token). */
  const resolveVouch = async (vouchToken, groupId) => {
    if (typeof vouchToken !== 'string' || !vouchToken) return null;
    const vt = vouchTokens.get(vouchToken);
    if (!vt || Date.now() >= vt.expiresAt || vt.groupId !== groupId) return null;
    try {
      const vd = await cloudant.getDocument(GROUPS_DB, vt.vouchId);
      if (!vd || vd.type !== 'vouch' || !vd.redeemed || vd.revoked) return null;
      return { voucherPairwiseId: vd.voucherPairwiseId };
    } catch { return null; }
  };

  // POST /api/groups/:groupId/vouches — a MEMBER registers a vouch code
  // (signed member claim, same seam as directory/member-key). The claim
  // itself carries the code HASH — the registry never sees the code.
  app.post('/api/groups/:groupId/vouches', async (req, res) => {
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') return res.status(404).json({ success: false, error: 'Group not found' });
      const { caller, payload, signature } = req.body || {};
      const member = findActiveMember(doc, caller);
      if (!member || !member.signingPublicKeyJwk) {
        return res.status(403).json({ success: false, error: 'Caller is not an active member' });
      }
      const claim = verifySignedClaim(payload, signature, member.signingPublicKeyJwk, {
        action: 'vouch-create', groupId: doc._id, caller
      });
      if (!claim) return res.status(403).json({ success: false, error: 'Invalid signature' });
      if (!/^[a-f0-9]{64}$/.test(String(claim.codeHash || ''))) {
        return res.status(400).json({ success: false, error: 'Invalid code hash' });
      }
      const exp = new Date(claim.codeExpiresAt || 0).getTime();
      if (!Number.isFinite(exp) || exp <= Date.now() || exp > Date.now() + VOUCH_CODE_TTL_MS + 60000) {
        return res.status(400).json({ success: false, error: 'Invalid code expiry' });
      }
      const id = `vouch_${claim.codeHash}`;
      if (await cloudant.getDocument(GROUPS_DB, id)) {
        return res.status(409).json({ success: false, error: 'Code already registered' });
      }
      await cloudant.saveDocument(GROUPS_DB, {
        _id: id, type: 'vouch', groupId: doc._id,
        voucherPairwiseId: caller,
        createdAt: new Date().toISOString(),
        codeExpiresAt: claim.codeExpiresAt,
        redeemed: false, revoked: false
      });
      auditLog.logEvent({
        type: 'vouch_created', userId: 'member', ip: req.ip,
        details: { groupId: doc._id, vouchId: id }
      });
      res.json({ success: true, vouchId: id });
    } catch (error) {
      console.error('[vouch] create failed:', error);
      res.status(500).json({ success: false, error: 'Failed to register vouch code' });
    }
  });

  // POST /api/groups/:groupId/vouches/status — a member's own vouches
  // (counts + lifecycle only; no credential material leaves).
  app.post('/api/groups/:groupId/vouches/status', async (req, res) => {
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') return res.status(404).json({ success: false, error: 'Group not found' });
      const { caller, payload, signature } = req.body || {};
      const member = findActiveMember(doc, caller);
      if (!member || !verifySignedClaim(payload, signature, member.signingPublicKeyJwk, {
        action: 'vouch-status', groupId: doc._id, caller
      })) {
        return res.status(403).json({ success: false, error: 'Invalid signature' });
      }
      const all = await cloudant.getAllDocuments(GROUPS_DB);
      const vouches = (all || [])
        .filter((d) => d && d.type === 'vouch' && d.groupId === doc._id && d.voucherPairwiseId === caller)
        .map((d) => ({
          vouchId: d._id, redeemed: !!d.redeemed, redeemedAt: d.redeemedAt || null,
          revoked: !!d.revoked, codeExpiresAt: d.codeExpiresAt
        }));
      res.json({ success: true, vouches });
    } catch (error) {
      console.error('[vouch] status failed:', error);
      res.status(500).json({ success: false, error: 'Failed to load vouches' });
    }
  });

  // POST /api/groups/:groupId/vouches/revoke — the voucher (and only the
  // voucher) kills the credential. Revocation beats live session tokens:
  // every send re-reads the record.
  app.post('/api/groups/:groupId/vouches/revoke', async (req, res) => {
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') return res.status(404).json({ success: false, error: 'Group not found' });
      const { caller, payload, signature } = req.body || {};
      const member = findActiveMember(doc, caller);
      const claim = member && verifySignedClaim(payload, signature, member.signingPublicKeyJwk, {
        action: 'vouch-revoke', groupId: doc._id, caller
      });
      if (!claim) return res.status(403).json({ success: false, error: 'Invalid signature' });
      const vd = await cloudant.getDocument(GROUPS_DB, String(claim.vouchId || ''));
      if (!vd || vd.type !== 'vouch' || vd.groupId !== doc._id || vd.voucherPairwiseId !== caller) {
        return res.status(404).json({ success: false, error: 'Vouch not found' });
      }
      vd.revoked = true;
      vd.revokedAt = new Date().toISOString();
      await cloudant.saveDocument(GROUPS_DB, vd);
      auditLog.logEvent({
        type: 'vouch_revoked', userId: 'member', ip: req.ip,
        details: { groupId: doc._id, vouchId: vd._id }
      });
      res.json({ success: true });
    } catch (error) {
      console.error('[vouch] revoke failed:', error);
      res.status(500).json({ success: false, error: 'Failed to revoke' });
    }
  });

  // POST /api/groups/:groupId/vouch/redeem-options — public: the requester
  // types the code the patient read to them; a passkey ceremony starts.
  app.post('/api/groups/:groupId/vouch/redeem-options', async (req, res) => {
    try {
      if (!vouchRateOk(req.ip)) return res.status(429).json({ success: false, error: 'RATE_LIMITED' });
      const code = String(req.body?.code || '').trim().toUpperCase();
      if (!/^[A-Z2-9]{6}$/.test(code)) return res.status(400).json({ success: false, error: 'Invalid code' });
      const vd = await cloudant.getDocument(GROUPS_DB, `vouch_${sha256hex(code)}`);
      if (!vd || vd.type !== 'vouch' || vd.groupId !== req.params.groupId
          || vd.redeemed || vd.revoked || new Date(vd.codeExpiresAt).getTime() <= Date.now()) {
        return res.status(404).json({ success: false, error: 'Unknown or expired code' });
      }
      const rp = vouchRp();
      const options = await wa.registrationOptions({
        rpID: rp.rpID, rpName: rp.rpName,
        userName: `vouched-requester-${vd._id.slice(6, 12)}`
      });
      const token = randomBytes(16).toString('hex');
      sweepVouchMaps();
      vouchChallenges.set(token, {
        type: 'register', groupId: vd.groupId, vouchId: vd._id,
        challenge: options.challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS
      });
      res.json({ success: true, token, options });
    } catch (error) {
      console.error('[vouch] redeem-options failed:', error);
      res.status(500).json({ success: false, error: 'Failed to start redemption' });
    }
  });

  // POST /api/groups/:groupId/vouch/redeem-verify — bind the new passkey
  // to the vouch record; the code is consumed either way it ends.
  app.post('/api/groups/:groupId/vouch/redeem-verify', async (req, res) => {
    try {
      const { token, response } = req.body || {};
      const ch = vouchChallenges.get(String(token || ''));
      vouchChallenges.delete(String(token || ''));
      if (!ch || ch.type !== 'register' || ch.groupId !== req.params.groupId || Date.now() >= ch.expiresAt) {
        return res.status(400).json({ success: false, error: 'Challenge expired — start over' });
      }
      const vd = await cloudant.getDocument(GROUPS_DB, ch.vouchId);
      if (!vd || vd.type !== 'vouch' || vd.redeemed || vd.revoked) {
        return res.status(404).json({ success: false, error: 'Code no longer valid' });
      }
      const rp = vouchRp();
      const cred = await wa.verifyRegistration({
        response, expectedChallenge: ch.challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID
      });
      if (!cred) return res.status(400).json({ success: false, error: 'Passkey verification failed' });
      vd.redeemed = true;
      vd.redeemedAt = new Date().toISOString();
      vd.credentialId = cred.credentialId;
      vd.credentialPublicKey = cred.credentialPublicKey;
      vd.counter = cred.counter || 0;
      await cloudant.saveDocument(GROUPS_DB, vd);
      auditLog.logEvent({
        type: 'vouch_redeemed', userId: 'public', ip: req.ip,
        details: { groupId: vd.groupId, vouchId: vd._id }
      });
      const vt = randomBytes(16).toString('hex');
      vouchTokens.set(vt, {
        groupId: vd.groupId, vouchId: vd._id, voucherPairwiseId: vd.voucherPairwiseId,
        expiresAt: Date.now() + VOUCH_TOKEN_TTL_MS
      });
      res.json({ success: true, vouchToken: vt });
    } catch (error) {
      console.error('[vouch] redeem-verify failed:', error);
      res.status(500).json({ success: false, error: 'Failed to complete redemption' });
    }
  });

  // POST /api/groups/:groupId/vouch/assert-options — public: returning
  // requester proves possession of an already-bound passkey.
  app.post('/api/groups/:groupId/vouch/assert-options', async (req, res) => {
    try {
      if (!vouchRateOk(req.ip)) return res.status(429).json({ success: false, error: 'RATE_LIMITED' });
      const rp = vouchRp();
      const options = await wa.authenticationOptions({ rpID: rp.rpID });
      const token = randomBytes(16).toString('hex');
      sweepVouchMaps();
      vouchChallenges.set(token, {
        type: 'assert', groupId: req.params.groupId,
        challenge: options.challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS
      });
      res.json({ success: true, token, options });
    } catch (error) {
      console.error('[vouch] assert-options failed:', error);
      res.status(500).json({ success: false, error: 'Failed to start verification' });
    }
  });

  // POST /api/groups/:groupId/vouch/assert-verify — verify the assertion
  // against the stored credential; mint a short-lived send-session token.
  app.post('/api/groups/:groupId/vouch/assert-verify', async (req, res) => {
    try {
      const { token, response } = req.body || {};
      const ch = vouchChallenges.get(String(token || ''));
      vouchChallenges.delete(String(token || ''));
      if (!ch || ch.type !== 'assert' || ch.groupId !== req.params.groupId || Date.now() >= ch.expiresAt) {
        return res.status(400).json({ success: false, error: 'Challenge expired — start over' });
      }
      const credId = String(response?.id || '');
      const all = await cloudant.getAllDocuments(GROUPS_DB);
      const vd = (all || []).find((d) => d && d.type === 'vouch' && d.groupId === ch.groupId
        && d.redeemed && !d.revoked && d.credentialId === credId);
      if (!vd) return res.status(404).json({ success: false, error: 'No active vouch for this passkey' });
      const rp = vouchRp();
      const ver = await wa.verifyAuthentication({
        response, expectedChallenge: ch.challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID,
        credentialPublicKey: vd.credentialPublicKey, counter: vd.counter || 0
      });
      if (!ver) return res.status(400).json({ success: false, error: 'Passkey verification failed' });
      vd.counter = ver.newCounter ?? vd.counter ?? 0;
      try { await cloudant.saveDocument(GROUPS_DB, vd); } catch { /* counter update is best-effort */ }
      const vt = randomBytes(16).toString('hex');
      vouchTokens.set(vt, {
        groupId: vd.groupId, vouchId: vd._id, voucherPairwiseId: vd.voucherPairwiseId,
        expiresAt: Date.now() + VOUCH_TOKEN_TTL_MS
      });
      res.json({ success: true, vouchToken: vt });
    } catch (error) {
      console.error('[vouch] assert-verify failed:', error);
      res.status(500).json({ success: false, error: 'Failed to verify' });
    }
  });

  /**
   * Settle an outside request's escrowed payment when its tally records a
   * real answer (mutates the tally in place; the caller saves it):
   *   spam-deposit    → any accept OR decline-with-a-reason RETURNS it
   *                     (the request was evaluated, so it wasn't spam);
   *                     silence until expiry forfeits it (sweep below).
   *   sharing-payment → the FIRST accept captures it for the host;
   *                     declines leave it held (a later accept can still
   *                     earn it) and expiry with no accept returns it.
   * resolveHold is idempotent, so conflict retries re-running this are safe.
   */
  const settleTallyPayment = async (tally, outcome) => {
    const p = tally?.payment;
    if (!p || p.resolved) return;
    const wants = p.type === 'spam-deposit'
      ? (outcome === 'accepted' || outcome === 'declined' ? 'release' : null)
      : (p.type === 'sharing-payment' && outcome === 'accepted' ? 'capture' : null);
    if (!wants) return;
    try {
      await resolveHold(cloudant, p.email, tally.requestId, wants);
      p.resolved = true;
      p.resolution = wants === 'release' ? 'released' : 'captured';
      p.resolvedAt = new Date().toISOString();
    } catch (e) {
      console.warn('[credits] settle failed:', e?.message || e);
    }
  };

  // POST /api/groups/:groupId/outside-request — W3: anyone (a physician,
  // a researcher, a company, a patient kicking the tires) may ASK the
  // members of a group for something. No account needed. The registry
  // seals the request to every active member's relay inbox; each member's
  // OWN policy cards then decide — a matching deny drops it silently, a
  // matching allow auto-accepts, anything else escalates to the member as
  // a question ("MAIA asks you about everything unless you've told it
  // otherwise"). The requester's contact email rides inside the sealed
  // envelope so a member who chooses to respond can reach them; the
  // registry never brokers the reply.
  app.post('/api/groups/:groupId/outside-request', async (req, res) => {
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') {
        return res.status(404).json({ success: false, error: 'Group not found' });
      }
      const b = req.body || {};
      const name = String(b.name || '').trim().slice(0, 80);
      const email = String(b.email || '').trim().slice(0, 120);
      const organization = String(b.organization || '').trim().slice(0, 120);
      const message = String(b.message || '').trim().slice(0, 2000);
      const scope = POLICY_SCOPES.includes(b.scope) ? b.scope : null;
      const purpose = POLICY_PURPOSES.includes(b.purpose) ? b.purpose : null;
      if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ success: false, error: 'A name and a valid contact email are required' });
      }
      if (!scope || !purpose) {
        return res.status(400).json({ success: false, error: 'A valid scope and purpose are required' });
      }
      const members = (doc.members || []).filter((m) => m.status === 'active' && m.encryptionPublicKeyJwk);
      if (members.length === 0) {
        return res.status(409).json({ success: false, error: 'This group has no members who can receive requests yet' });
      }
      const now = Date.now();
      const reqId = randomBytes(8).toString('hex');
      // Honest signature strength: the welcome builder verifies the requester's
      // email through OUR code flow before allowing a real send, so a request
      // carrying a matching verify token evaluates as 'verified-email'.
      // Claims of stronger identities (Doximity) still evaluate as
      // unverified until real verification exists.
      const emailVerifyToken = typeof b.emailVerifyToken === 'string' ? b.emailVerifyToken : null;
      const requestSignature = (emailVerifyToken && emailTokenVerified(emailVerifyToken, email))
        ? 'verified-email' : 'unverified';
      const appUrl = (process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

      // Optional attached payment (credits, Phase 1). Credits are keyed by
      // the verified email, so an unverified sender can't attach one. The
      // money moves BEFORE any delivery: deposits are escrowed under the
      // request id (settled by settleTallyPayment / the expiry sweep), the
      // evaluation payment is charged outright. ONE payment covers the
      // whole request no matter how many members it reaches.
      const payment = Object.prototype.hasOwnProperty.call(CREDIT_PRICES, b.payment) ? b.payment : null;
      if (payment) {
        if (requestSignature !== 'verified-email') {
          return res.status(400).json({ success: false, error: 'A verified email is required to attach a payment' });
        }
        const price = CREDIT_PRICES[payment];
        const taken = payment === 'notification-deposit'
          ? await chargeCredits(cloudant, email, price, `request evaluation payment (request ${reqId})`)
          : await holdCredits(cloudant, email, price, reqId, payment);
        if (!taken) {
          const acct = await getAccount(cloudant, email);
          return res.status(402).json({
            success: false,
            error: 'INSUFFICIENT_CREDITS',
            required: price,
            balance: acct.balance
          });
        }
      }

      // A proven vouch elevates the signature to 'verified-by-me' — but
      // ONLY for the member who issued the vouch. Everyone else's envelope
      // keeps the base level; the per-member sealing makes that free.
      // resolveVouch re-reads the stored record, so a revocation that
      // happened after the passkey assertion still wins here.
      const vouch = await resolveVouch(b.vouchToken, doc._id);

      let delivered = 0;
      let autoAccepted = 0;
      let autoDeclined = 0;
      for (const m of members) {
        const memberSignature = (vouch && vouch.voucherPairwiseId === m.pairwiseId)
          ? 'verified-by-me' : requestSignature;
        // Delivery-time evaluation (Phase 1, single deployment: this server IS
        // each member's authorization server). A member whose sharing-policy
        // cards decide the request gets an AUTONOMOUS outcome right now — the
        // agent works even while the patient is offline. Anything undecided is
        // sealed to the member's relay exactly as before (human-in-the-loop).
        let ownerDoc = null;
        try {
          const rr = await cloudant.findDocuments(USERS_DB, {
            selector: { groupMemberships: { $elemMatch: { groupId: { $eq: doc._id }, pairwiseId: { $eq: m.pairwiseId } } } },
            limit: 1
          });
          ownerDoc = rr?.docs?.[0] || null;
        } catch { /* cross-host / lookup failure → escalate path below */ }

        let decision = { outcome: 'ask', decidedBy: null };
        if (ownerDoc) {
          decision = evaluatePolicies(ownerDoc.sharingPolicies || [], {
            party: { type: 'anyone' }, purpose, scope, signature: memberSignature, payment: payment || 'none'
          });
        }

        // autoDecision rides inside the sealed envelope so the member's MAIA
        // stores the request as already-answered (with the deciding sentence)
        // instead of re-asking.
        let autoDecision = null;
        if (decision.outcome === 'allow' && ownerDoc) {
          // ONLY the privacy-filtered artifacts ever leave (allow cards are
          // filtered-by-default; unfiltered autonomous sharing is not offered).
          const mapping = ownerDoc.privacyFilter?.pseudonymMapping || [];
          let artifact = '';
          let artifactLabel = '';
          if (scope === 'meds-allergies') {
            const meds = String(ownerDoc.currentMedications || '').trim();
            if (meds) {
              artifact = applyPseudonymMapping(mapping, meds);
              artifactLabel = 'privacy-filtered Current Medications';
            }
          } else if (scope !== 'notification-only') {
            const pf = String(ownerDoc.privacyFilteredSummary?.text || '').trim();
            if (pf) {
              artifact = pf;
              artifactLabel = 'privacy-filtered Patient Summary';
            }
          }
          if (artifact && typeof sendEmail === 'function') {
            try {
              await sendEmail(
                email,
                `A "${doc.name}" member's MAIA responded to your request`,
                [
                  // The deciding card is the member's own business — the
                  // requester learns the outcome, never the policy.
                  `A member of the "${doc.name}" group has a sharing policy that allows your request, so their MAIA responded autonomously.`,
                  '',
                  `--- ${artifactLabel} ---`,
                  artifact,
                  '',
                  appUrl
                ].join('\n')
              );
              autoAccepted++;
              autoDecision = { outcome: 'accepted', sentence: policySentence(decision.decidedBy) };
              auditLog.logEvent({
                type: 'as_request_responded',
                userId: ownerDoc.userId,
                ip: req.ip,
                details: { requestId: reqId, groupId: doc._id, outcome: 'accepted', autonomous: true, decidedByPolicyId: decision.decidedBy?.id || null }
              });
            } catch (e) {
              console.warn('[outside-request] autonomous respond failed:', e?.message || e);
            }
          }
          // No filtered artifact to share yet → fall through and escalate (ask).
        } else if (decision.outcome === 'deny' && ownerDoc) {
          const denyMode = decision.decidedBy?.denyMode === 'respond' ? 'respond' : 'silent';
          if (denyMode === 'silent') {
            // Cedar-style silent drop: nothing sealed, requester hears nothing.
            continue;
          }
          if (typeof sendEmail === 'function') {
            try {
              await sendEmail(
                email,
                `Your request to a "${doc.name}" member was declined`,
                // Outcome only — which policy decided is not the requester's
                // business.
                `A member of the "${doc.name}" group has a sharing policy that declines your request, so their MAIA responded autonomously.`
              );
              autoDeclined++;
              auditLog.logEvent({
                type: 'as_request_responded',
                userId: ownerDoc.userId,
                ip: req.ip,
                details: { requestId: reqId, groupId: doc._id, outcome: 'declined', autonomous: true, decidedByPolicyId: decision.decidedBy?.id || null }
              });
            } catch (e) {
              console.warn('[outside-request] autonomous decline failed:', e?.message || e);
            }
          }
          autoDecision = { outcome: 'declined', sentence: policySentence(decision.decidedBy) };
        }

        try {
          const envelope = JSON.stringify({
            maiaType: 'as-request',
            action: 'share',
            resource: scope,
            purpose,
            signature: memberSignature,
            payment: payment || null,
            created: new Date(now).toISOString(),
            nonce: reqId,
            ...(autoDecision ? { autoDecision } : {}),
            payload: {
              message,
              requester: { name, email, organization: organization || null }
            }
          });
          const box = sealTo(m.encryptionPublicKeyJwk, envelope);
          await cloudant.saveDocument(RELAY_DB, {
            _id: `relay_${now}_${randomBytes(6).toString('hex')}`,
            type: 'relay_message',
            groupId: doc._id,
            fromPairwiseId: `outsider:${reqId}`,
            toPairwiseId: m.pairwiseId,
            box,
            createdAt: new Date(now).toISOString(),
            expiresAt: new Date(now + RELAY_TTL_MS).toISOString()
          });
          delivered++;
        } catch (e) {
          console.warn('[groups] outside-request seal/store failed:', e?.message || e);
        }
      }
      // Public tally (counts only — no identities, no content) so the requester
      // can watch reach + responses. Autonomous outcomes count immediately.
      // The tally also carries the escrowed payment's settlement state
      // (email + resolved flag only — no balances) because every event that
      // can settle it is a tally transition.
      try {
        const tally = {
          _id: `outreq_${reqId}`,
          type: 'outside_request_tally',
          groupId: doc._id,
          requestId: reqId,
          delivered,
          responded: autoAccepted + autoDeclined,
          accepted: autoAccepted,
          declined: autoDeclined,
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + RELAY_TTL_MS).toISOString(),
          ...(payment && payment !== 'notification-deposit'
            ? { payment: { type: payment, email: email.toLowerCase(), resolved: false } }
            : {})
        };
        if (autoAccepted > 0) await settleTallyPayment(tally, 'accepted');
        else if (autoDeclined > 0) await settleTallyPayment(tally, 'declined');
        await cloudant.saveDocument(RELAY_DB, tally);
      } catch (e) {
        console.warn('[groups] outside-request tally create failed:', e?.message || e);
      }
      auditLog.logEvent({
        type: 'group_outside_request',
        userId: 'public',
        ip: req.ip,
        details: { groupId: doc._id, requestId: reqId, scope, purpose, recipients: delivered }
      });
      res.json({ success: true, requestId: reqId, delivered });
    } catch (error) {
      console.error('[groups] outside-request failed:', error);
      res.status(500).json({ success: false, error: 'Failed to send request' });
    }
  });

  // GET /api/groups/:groupId/outside-request/:reqId/status — public tally so a
  // requester's page can show reach + how many members responded (counts only;
  // no identities, no content). The registry still never brokers the reply.
  app.get('/api/groups/:groupId/outside-request/:reqId/status', async (req, res) => {
    try {
      const tally = await cloudant.getDocument(RELAY_DB, `outreq_${req.params.reqId}`);
      if (!tally || tally.type !== 'outside_request_tally' || tally.groupId !== req.params.groupId) {
        return res.status(404).json({ success: false, error: 'Unknown request' });
      }
      res.json({
        success: true,
        delivered: tally.delivered || 0,
        responded: tally.responded || 0,
        accepted: tally.accepted || 0,
        declined: tally.declined || 0
      });
    } catch (error) {
      console.error('[groups] outside-request status failed:', error);
      res.status(500).json({ success: false, error: 'Failed to load request status' });
    }
  });

  // POST /api/groups/:groupId/outside-request/:reqId/responded — count an
  // autonomous decision a member's AS made at INGEST time (the cross-host
  // twin of the delivery-time counts above; also the same-host fallback
  // when delivery could not decide). Counts only — no identities, no
  // content; knowing the unguessable reqId is the capability, exactly as
  // for the status GET. Conflict-tolerant like the decision endpoint.
  app.post('/api/groups/:groupId/outside-request/:reqId/responded', async (req, res) => {
    try {
      const outcome = req.body?.outcome === 'declined' ? 'declined' : 'accepted';
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const tally = await cloudant.getDocument(RELAY_DB, `outreq_${req.params.reqId}`);
          if (!tally || tally.type !== 'outside_request_tally' || tally.groupId !== req.params.groupId) {
            return res.status(404).json({ success: false, error: 'Unknown request' });
          }
          tally.responded = (tally.responded || 0) + 1;
          if (outcome === 'accepted') tally.accepted = (tally.accepted || 0) + 1;
          else tally.declined = (tally.declined || 0) + 1;
          await settleTallyPayment(tally, outcome);
          await cloudant.saveDocument(RELAY_DB, tally);
          return res.json({ success: true });
        } catch (e) {
          if (e?.statusCode === 409 && attempt < 2) continue;
          throw e;
        }
      }
      res.status(409).json({ success: false, error: 'Conflict recording response' });
    } catch (error) {
      console.error('[groups] outside-request responded failed:', error);
      res.status(500).json({ success: false, error: 'Failed to record response' });
    }
  });

  // POST /api/groups/outside-request-proxy — same-origin helper for the
  // welcome page: forwards an outside request to a FEATURED (remote)
  // group's registry, since the browser can't POST cross-origin (CORS
  // stays closed). Same federation trust seam as join/request-join,
  // which already fetch caller-supplied registry URLs server-side.
  app.post('/api/groups/outside-request-proxy', async (req, res) => {
    try {
      const { origin, groupId, ...body } = req.body || {};
      const base = safeRegistryBase(origin);
      if (!base || !groupId) {
        return res.status(400).json({ success: false, error: 'origin and groupId are required' });
      }
      const r = await fetch(`${base}/api/groups/${encodeURIComponent(groupId)}/outside-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await r.json().catch(() => ({}));
      res.status(r.status).json(data);
    } catch (error) {
      console.error('[groups] outside-request proxy failed:', error);
      res.status(502).json({ success: false, error: 'The group\'s registry could not be reached' });
    }
  });

  // GET /api/groups/:groupId/info — public well-known endpoint. A member's
  // MAIA (on any deployment) uses this to fetch the group's public signing
  // key for offline credential verification (Groups.md §3.1, §6.1).
  app.get('/api/groups/:groupId/info', async (req, res) => {
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') {
        return res.status(404).json({ success: false, error: 'Group not found' });
      }
      res.json({ success: true, group: publicGroupView(doc) });
    } catch (error) {
      console.error('[groups] info failed:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch group info' });
    }
  });

  // GET /api/groups/:groupId/invite-info?token=… — public. Called by the
  // invite landing page (welcome banner) and the Groups tab banner: returns
  // the group's public view plus the invite's validity, and marks
  // `inviteOpenedAt` on the invited entry the first time the link is
  // opened, so the admin's members dialog can show invited → opened →
  // joined progress. Token is matched by hash; nothing sensitive returns.
  app.get('/api/groups/:groupId/invite-info', async (req, res) => {
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') {
        return res.status(404).json({ success: false, error: 'Group not found' });
      }
      const token = String(req.query?.token || '');
      let invite = { valid: false };
      if (token) {
        const tokenHash = sha256hex(token);
        const member = (doc.members || []).find(
          (m) => m.status === 'invited' && m.inviteTokenHash === tokenHash
        );
        if (member) {
          const expired = member.inviteExpiresAt && new Date(member.inviteExpiresAt).getTime() < Date.now();
          invite = { valid: !expired, expiresAt: member.inviteExpiresAt || null, expired: !!expired };
          if (!member.inviteOpenedAt) {
            member.inviteOpenedAt = new Date().toISOString();
            try {
              await cloudant.saveDocument(GROUPS_DB, doc);
            } catch (e) {
              // Best-effort bookkeeping — never fail the landing page over it.
              console.warn('[groups] invite-opened bookkeeping failed:', e?.message || e);
            }
          }
        }
      }
      res.json({ success: true, group: publicGroupView(doc), invite });
    } catch (error) {
      console.error('[groups] invite-info failed:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch invite info' });
    }
  });

  // GET /api/groups/:groupId/recovery-kit — admin recovery kit (Groups.md
  // §6.7). Downloads the group's key material as a JSON file so group
  // continuity survives loss of CouchDB. This is the ONLY code path that
  // ever exports the private signing key. Deliberately re-downloadable
  // (a strictly one-time export bricks recovery if the first download
  // fails, and adds no security — the admin can read CouchDB anyway);
  // every export is audit-logged and counted, and the admin UI shows the
  // last export time so unexpected exports are visible.
  app.get('/api/groups/:groupId/recovery-kit', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') {
        return res.status(404).json({ success: false, error: 'Group not found' });
      }
      const now = new Date().toISOString();
      const kit = {
        format: 'maia-group-recovery-kit-v1',
        exportedAt: now,
        warning: 'Contains the group PRIVATE signing key. Store offline and securely. Anyone holding this file can issue membership credentials for this group.',
        groupId: doc._id,
        name: doc.name,
        createdAt: doc.createdAt,
        signingKey: {
          publicKeyJwk: doc.signingKey?.publicKeyJwk || null,
          privateKeyJwk: doc.signingKey?.privateKeyJwk || null
        }
      };
      // Record the export before returning it (best-effort — the download
      // must not fail because the bookkeeping write conflicted).
      try {
        doc.recoveryKit = {
          lastExportedAt: now,
          exportCount: (doc.recoveryKit?.exportCount || 0) + 1
        };
        await cloudant.saveDocument(GROUPS_DB, doc);
      } catch (bookkeepErr) {
        console.warn('[groups] recovery-kit bookkeeping failed:', bookkeepErr?.message || bookkeepErr);
      }
      auditLog.logEvent({
        type: 'group_recovery_kit_exported',
        userId: req.session?.userId || 'admin-local',
        ip: req.ip,
        details: { groupId: doc._id, exportCount: doc.recoveryKit?.exportCount || 1 }
      });
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="maia-group-recovery-${doc._id}.json"`);
      res.send(JSON.stringify(kit, null, 2));
    } catch (error) {
      console.error('[groups] recovery-kit export failed:', error);
      res.status(500).json({ success: false, error: 'Failed to export recovery kit' });
    }
  });

  // ── PR-2: invites, join, member management ─────────────────────────

  /** Admin view of a member entry. Registry-minimalism (§3.1): the invite
   *  email is visible only while status='invited' — it is DELETED at join. */
  const memberAdminView = (m) => ({
    pairwiseId: m.pairwiseId,
    alias: m.alias || null,
    status: m.status,
    invitedAt: m.invitedAt || null,
    joinedAt: m.joinedAt || null,
    revokedAt: m.revokedAt || null,
    inviteEmail: m.status === 'invited' ? (m.inviteEmail || null) : null,
    inviteExpiresAt: m.status === 'invited' ? (m.inviteExpiresAt || null) : null,
    inviteOpenedAt: m.status === 'invited' ? (m.inviteOpenedAt || null) : null,
    requestedAt: m.status === 'requested' ? (m.requestedAt || null) : null,
    mentor: !!m.mentor,
    mentorTag: m.mentorTag || ''
  });

  /** Mint an invite on `doc` (replacing any pending invite for the same
   *  email), save, and best-effort email the join link. Shared by the
   *  admin invite endpoint and member-initiated invites (PR-8). When
   *  `invitedBy` is set (a member's pairwiseId), it is recorded on the
   *  entry so the join can seed the inviter⇄invitee conversation, and the
   *  email names the inviter by group alias. */
  const mintInvite = async (doc, email, req, { invitedBy = null, inviterAlias = null } = {}) => {
    const activeWithEmail = (doc.members || []).find(
      (m) => m.status === 'invited' && m.inviteEmail === email
    );
    const token = randomBytes(32).toString('hex');
    const now = new Date();
    const entry = {
      pairwiseId: randomBytes(12).toString('hex'),
      status: 'invited',
      inviteEmail: email,
      inviteTokenHash: sha256hex(token),
      invitedAt: now.toISOString(),
      inviteExpiresAt: new Date(now.getTime() + INVITE_TTL_MS).toISOString(),
      ...(invitedBy ? { invitedByPairwiseId: invitedBy } : {})
    };
    doc.members = (doc.members || []).filter((m) => m !== activeWithEmail);
    doc.members.push(entry);
    doc.updatedAt = now.toISOString();
    await cloudant.saveDocument(GROUPS_DB, doc);

    const appUrl = (process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const inviteLink = `${appUrl}/?groupInvite=${token}&groupId=${encodeURIComponent(doc._id)}&registry=${encodeURIComponent(appUrl)}`;

    let emailSent = false;
    if (typeof sendEmail === 'function') {
      try {
        emailSent = await sendEmail(
          email,
          `You're invited to join "${doc.name}" on MAIA`,
          [
            inviterAlias
              ? `${inviterAlias} invited you to join the patient group "${doc.name}".`
              : `You've been invited to join the patient group "${doc.name}".`,
            '',
            'MAIA is a private medical AI assistant: your health records stay under your control,',
            'and the group can never see them — it only helps you connect with peers.',
            '',
            `Accept the invitation (valid 14 days):`,
            inviteLink,
            '',
            `If you don't want to join, simply ignore this email.`
          ].join('\n')
        );
      } catch (mailErr) {
        console.warn('[groups] invite email failed:', mailErr?.message || mailErr);
      }
    }
    return { entry, inviteLink, emailSent };
  };

  // POST /api/groups/:groupId/invites — invite a member by email (admin).
  // Generates a single-use token (only its hash is stored) and emails a
  // join link. The link is ALSO returned to the admin for copy/paste —
  // essential when email is not configured, and harmless otherwise (the
  // admin could mint invites regardless). Re-inviting an email that is
  // already in 'invited' status replaces that invite (new token, new TTL).
  app.post('/api/groups/:groupId/invites', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') {
        return res.status(404).json({ success: false, error: 'Group not found' });
      }
      const email = String(req.body?.email || '').trim().toLowerCase();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ success: false, error: 'A valid email is required' });
      }
      const { entry, inviteLink, emailSent } = await mintInvite(doc, email, req);
      auditLog.logEvent({
        type: 'group_member_invited',
        userId: req.session?.userId || 'admin-local',
        ip: req.ip,
        details: { groupId: doc._id, pairwiseId: entry.pairwiseId, emailSent }
      });
      res.json({
        success: true,
        invite: {
          pairwiseId: entry.pairwiseId,
          inviteLink,
          expiresAt: entry.inviteExpiresAt,
          emailSent
        }
      });
    } catch (error) {
      console.error('[groups] invite failed:', error);
      res.status(500).json({ success: false, error: 'Failed to create invite' });
    }
  });

  // POST /api/groups/:groupId/member-invites — an ACTIVE MEMBER invites
  // someone by email (PR-8, member virality). Signed like every member→
  // registry call; allowed unless the admin turned memberInvitesAllowed
  // off for the group. The invite records the inviter's pairwiseId so the
  // invitee's join seeds their first conversation with the inviter.
  app.post('/api/groups/:groupId/member-invites', async (req, res) => {
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') {
        return res.status(404).json({ success: false, error: 'Group not found' });
      }
      if (doc.memberInvitesAllowed === false) {
        return res.status(403).json({ success: false, error: 'This group only accepts invitations from its administrator' });
      }
      const { caller, payload, signature } = req.body || {};
      const callerMember = findActiveMember(doc, caller);
      if (!callerMember || !callerMember.signingPublicKeyJwk) {
        return res.status(403).json({ success: false, error: 'Caller is not an active member' });
      }
      const claim = verifySignedClaim(payload, signature, callerMember.signingPublicKeyJwk, {
        action: 'member-invite', groupId: doc._id, caller
      });
      if (!claim) {
        return res.status(403).json({ success: false, error: 'Invalid signature' });
      }
      const email = String(req.body?.email || '').trim().toLowerCase();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ success: false, error: 'A valid email is required' });
      }
      const { entry, inviteLink, emailSent } = await mintInvite(doc, email, req, {
        invitedBy: callerMember.pairwiseId,
        inviterAlias: callerMember.alias || null
      });
      auditLog.logEvent({
        type: 'group_member_invited_by_member',
        userId: null, // registry does not learn the inviter's userId
        ip: req.ip,
        details: { groupId: doc._id, pairwiseId: entry.pairwiseId, invitedBy: callerMember.pairwiseId, emailSent }
      });
      res.json({
        success: true,
        invite: { inviteLink, expiresAt: entry.inviteExpiresAt, emailSent }
      });
    } catch (error) {
      console.error('[groups] member invite failed:', error);
      res.status(500).json({ success: false, error: 'Failed to create invite' });
    }
  });

  // POST /api/groups/:groupId/rotate-join-link — mint a new join-link
  // token (admin). Old links/QR codes stop working immediately; pending
  // requests are unaffected (they're already entries, not links).
  app.post('/api/groups/:groupId/rotate-join-link', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') {
        return res.status(404).json({ success: false, error: 'Group not found' });
      }
      doc.joinLinkToken = randomBytes(16).toString('hex');
      doc.updatedAt = new Date().toISOString();
      await cloudant.saveDocument(GROUPS_DB, doc);
      auditLog.logEvent({
        type: 'group_join_link_rotated',
        userId: req.session?.userId || 'admin-local',
        ip: req.ip,
        details: { groupId: doc._id }
      });
      res.json({ success: true, group: adminGroupView(doc) });
    } catch (error) {
      console.error('[groups] rotate join link failed:', error);
      res.status(500).json({ success: false, error: 'Failed to rotate join link' });
    }
  });

  // GET /api/groups/:groupId/join-info?token= — public: validates a join
  // link and returns just enough for the "request to join" card.
  app.get('/api/groups/:groupId/join-info', async (req, res) => {
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') {
        return res.status(404).json({ success: false, error: 'Group not found' });
      }
      const valid = ['link-approval', 'open'].includes(doc.joinMode)
        && !!doc.joinLinkToken
        && String(req.query?.token || '') === doc.joinLinkToken;
      res.json({
        success: true,
        valid,
        joinMode: valid ? doc.joinMode : null,
        group: valid ? {
          name: doc.name,
          description: doc.description || '',
          postingPolicy: doc.postingPolicy || '',
          suggestedPolicies: (doc.suggestedPolicies || []).map((c) => ({ ...c, sentence: policySentence(c) }))
        } : null
      });
    } catch (error) {
      console.error('[groups] join-info failed:', error);
      res.status(500).json({ success: false, error: 'Failed to check join link' });
    }
  });

  // POST /api/groups/:groupId/join-requests — someone with the join link
  // asks to join (PR-9). Creates a 'requested' member entry carrying the
  // requester's pairwise public keys, so admin approval alone completes
  // the membership — the requester's MAIA then collects its credential by
  // polling the signed status endpoint below. No email is ever stored.
  app.post('/api/groups/:groupId/join-requests', async (req, res) => {
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') {
        return res.status(404).json({ success: false, error: 'Group not found' });
      }
      const { token, alias, signingPublicKeyJwk, encryptionPublicKeyJwk } = req.body || {};
      if (!['link-approval', 'open'].includes(doc.joinMode) || !doc.joinLinkToken || String(token || '') !== doc.joinLinkToken) {
        return res.status(403).json({ success: false, error: 'This group is not accepting join requests via link' });
      }
      if (!alias || !String(alias).trim() || !signingPublicKeyJwk || !encryptionPublicKeyJwk) {
        return res.status(400).json({ success: false, error: 'alias, signingPublicKeyJwk and encryptionPublicKeyJwk are required' });
      }
      // Open mode (zero-latency bootstrap): the link admits instantly —
      // the entry is born ACTIVE; the admin can still revoke and the
      // link is still rotatable. Approval mode: born 'requested'.
      const isOpen = doc.joinMode === 'open';
      const nowIso = new Date().toISOString();
      const entry = {
        pairwiseId: randomBytes(12).toString('hex'),
        status: isOpen ? 'active' : 'requested',
        alias: String(alias).trim().slice(0, 60),
        signingPublicKeyJwk,
        encryptionPublicKeyJwk,
        ...(isOpen ? { joinedAt: nowIso, lastRefreshAt: nowIso } : { requestedAt: nowIso })
      };
      doc.members = [...(doc.members || []), entry];
      doc.updatedAt = entry.requestedAt;
      await cloudant.saveDocument(GROUPS_DB, doc);
      auditLog.logEvent({
        type: 'group_join_requested',
        userId: null, // registry never learns the requester's userId
        ip: req.ip,
        details: { groupId: doc._id, pairwiseId: entry.pairwiseId }
      });
      res.json({ success: true, pairwiseId: entry.pairwiseId, groupName: doc.name, immediate: isOpen });
    } catch (error) {
      console.error('[groups] join request failed:', error);
      res.status(500).json({ success: false, error: 'Failed to submit join request' });
    }
  });

  // GET /api/groups/:groupId/join-requests/:pairwiseId/status — the
  // requester's MAIA polls (signed with the keys it submitted) until the
  // admin decides. 'active' returns the full membership (credential +
  // group key), completing the join. A removed entry reads as 'rejected'.
  app.get('/api/groups/:groupId/join-requests/:pairwiseId/status', async (req, res) => {
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') {
        return res.status(404).json({ success: false, error: 'Group not found' });
      }
      const member = (doc.members || []).find((m) => m.pairwiseId === req.params.pairwiseId);
      const { payload, signature } = req.query || {};
      if (!member || !member.signingPublicKeyJwk) {
        return res.json({ success: true, status: 'rejected' });
      }
      const claim = verifySignedClaim(payload, signature, member.signingPublicKeyJwk, {
        action: 'join-status', groupId: doc._id, caller: member.pairwiseId
      });
      if (!claim) {
        return res.status(403).json({ success: false, error: 'Invalid signature' });
      }
      if (member.status === 'requested') {
        return res.json({ success: true, status: 'requested' });
      }
      if (member.status !== 'active') {
        return res.json({ success: true, status: 'rejected' });
      }
      const credential = signMembershipCredential(doc, member);
      res.json({
        success: true,
        status: 'active',
        membership: {
          groupId: doc._id,
          groupName: doc.name,
          pairwiseId: member.pairwiseId,
          alias: member.alias,
          credential,
          groupPublicKeyJwk: doc.signingKey?.publicKeyJwk || null,
          suggestedPolicies: doc.suggestedPolicies || []
        }
      });
    } catch (error) {
      console.error('[groups] join status failed:', error);
      res.status(500).json({ success: false, error: 'Failed to check join status' });
    }
  });

  // PUT /api/groups/:groupId/members/:pairwiseId/approve — admin approves
  // a pending join request. The requester's next status poll collects the
  // membership credential.
  app.put('/api/groups/:groupId/members/:pairwiseId/approve', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') {
        return res.status(404).json({ success: false, error: 'Group not found' });
      }
      const member = (doc.members || []).find((m) => m.pairwiseId === req.params.pairwiseId);
      if (!member || member.status !== 'requested') {
        return res.status(404).json({ success: false, error: 'No pending request for this member' });
      }
      member.status = 'active';
      member.joinedAt = new Date().toISOString();
      member.lastRefreshAt = member.joinedAt;
      delete member.requestedAt;
      doc.updatedAt = member.joinedAt;
      await cloudant.saveDocument(GROUPS_DB, doc);
      auditLog.logEvent({
        type: 'group_join_approved',
        userId: req.session?.userId || 'admin-local',
        ip: req.ip,
        details: { groupId: doc._id, pairwiseId: member.pairwiseId }
      });
      res.json({ success: true, member: memberAdminView(member) });
    } catch (error) {
      console.error('[groups] approve failed:', error);
      res.status(500).json({ success: false, error: 'Failed to approve request' });
    }
  });

  // GET /api/groups/:groupId/members — member list (admin).
  app.get('/api/groups/:groupId/members', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') {
        return res.status(404).json({ success: false, error: 'Group not found' });
      }
      // Admin view: resolve each active member's account email via the reverse
      // membership lookup. A member whose MAIA account lives on ANOTHER host
      // resolves to nothing — by design (the registry deletes the invite email
      // at join and never learns member emails); flag them so the admin UI
      // can say "cross-host member" instead of showing a confusing blank.
      const members = await Promise.all((doc.members || []).map(async (m) => {
        const view = memberAdminView(m);
        if (m.pairwiseId) {
          try {
            const r = await cloudant.findDocuments(USERS_DB, {
              selector: { groupMemberships: { $elemMatch: { groupId: { $eq: doc._id }, pairwiseId: { $eq: m.pairwiseId } } } },
              limit: 1
            });
            const u = r?.docs?.[0];
            if (u?.email) { view.email = u.email; view.emailVerified = !!u.emailVerified; }
            if (!u && m.status === 'active') view.crossHost = true;
          } catch { /* lookup failed — leave email and crossHost unset */ }
        }
        return view;
      }));
      res.json({ success: true, members });
    } catch (error) {
      console.error('[groups] members list failed:', error);
      res.status(500).json({ success: false, error: 'Failed to list members' });
    }
  });

  // POST /api/groups/:groupId/join — redeem an invite token. Called by the
  // joining member's MAIA server (same deployment in Phase 1; the HTTP seam
  // keeps the federation format). Registry-minimalism happens HERE: on
  // success the invite email and token hash are DELETED from the registry —
  // from then on it knows only alias, keys, status, and heartbeats.
  app.post('/api/groups/:groupId/join', async (req, res) => {
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') {
        return res.status(404).json({ success: false, error: 'Group not found' });
      }
      const { token, alias, signingPublicKeyJwk, encryptionPublicKeyJwk } = req.body || {};
      if (!token || !alias || !String(alias).trim() || !signingPublicKeyJwk || !encryptionPublicKeyJwk) {
        return res.status(400).json({
          success: false,
          error: 'token, alias, signingPublicKeyJwk and encryptionPublicKeyJwk are required'
        });
      }
      const tokenHash = sha256hex(String(token));
      const member = (doc.members || []).find(
        (m) => m.status === 'invited' && m.inviteTokenHash === tokenHash
      );
      if (!member) {
        return res.status(400).json({ success: false, error: 'Invalid or already-used invite token' });
      }
      if (member.inviteExpiresAt && new Date(member.inviteExpiresAt).getTime() < Date.now()) {
        return res.status(400).json({ success: false, error: 'Invite has expired' });
      }
      member.status = 'active';
      member.alias = String(alias).trim().slice(0, 60);
      member.signingPublicKeyJwk = signingPublicKeyJwk;
      member.encryptionPublicKeyJwk = encryptionPublicKeyJwk;
      member.joinedAt = new Date().toISOString();
      member.lastRefreshAt = member.joinedAt;
      // Registry-minimalism: drop the email and the token hash at join.
      delete member.inviteEmail;
      delete member.inviteTokenHash;
      delete member.inviteExpiresAt;
      delete member.inviteOpenedAt;
      doc.updatedAt = member.joinedAt;
      await cloudant.saveDocument(GROUPS_DB, doc);

      const credential = signMembershipCredential(doc, member);
      // Member-initiated invite (PR-8): hand the joiner their inviter's
      // pairwise identity + alias so their MAIA can seed the first
      // conversation ("Alice invited you — say hi"). Only returned if the
      // inviter is still an active member.
      let inviter = null;
      if (member.invitedByPairwiseId) {
        const inviterMember = findActiveMember(doc, member.invitedByPairwiseId);
        if (inviterMember) {
          inviter = { pairwiseId: inviterMember.pairwiseId, alias: inviterMember.alias || null };
        }
      }
      auditLog.logEvent({
        type: 'group_member_joined',
        userId: null, // the registry does not learn the member's userId
        ip: req.ip,
        details: { groupId: doc._id, pairwiseId: member.pairwiseId }
      });
      res.json({
        success: true,
        membership: {
          groupId: doc._id,
          groupName: doc.name,
          pairwiseId: member.pairwiseId,
          alias: member.alias,
          credential,
          groupPublicKeyJwk: doc.signingKey?.publicKeyJwk || null,
          inviter,
          suggestedPolicies: doc.suggestedPolicies || []
        }
      });
    } catch (error) {
      console.error('[groups] join failed:', error);
      res.status(500).json({ success: false, error: 'Failed to join group' });
    }
  });

  // DELETE /api/groups/:groupId/members/:pairwiseId — cancel an invite or
  // revoke a membership (admin). Invited entries are removed outright;
  // active members become 'revoked' (kept for audit attribution — their
  // credential stops refreshing and dies within 24 h, §6.1).
  app.delete('/api/groups/:groupId/members/:pairwiseId', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') {
        return res.status(404).json({ success: false, error: 'Group not found' });
      }
      const member = (doc.members || []).find((m) => m.pairwiseId === req.params.pairwiseId);
      if (!member) {
        return res.status(404).json({ success: false, error: 'Member not found' });
      }
      let action;
      if (member.status === 'invited') {
        doc.members = doc.members.filter((m) => m !== member);
        action = 'invite_cancelled';
      } else if (member.status === 'requested') {
        // Rejecting a join request removes the entry; the requester's
        // status poll then reads 'rejected'.
        doc.members = doc.members.filter((m) => m !== member);
        action = 'join_request_rejected';
      } else if (member.status === 'revoked') {
        // Already revoked — the trash can now hard-removes the entry for
        // list cleanup (its credential already died at revocation).
        doc.members = doc.members.filter((m) => m !== member);
        action = 'member_removed';
      } else {
        member.status = 'revoked';
        member.revokedAt = new Date().toISOString();
        action = 'member_revoked';
      }
      doc.updatedAt = new Date().toISOString();
      await cloudant.saveDocument(GROUPS_DB, doc);
      auditLog.logEvent({
        type: `group_${action}`,
        userId: req.session?.userId || 'admin-local',
        ip: req.ip,
        details: { groupId: doc._id, pairwiseId: req.params.pairwiseId }
      });
      res.json({ success: true, action });
    } catch (error) {
      console.error('[groups] member delete failed:', error);
      res.status(500).json({ success: false, error: 'Failed to remove member' });
    }
  });

  // POST /api/groups/:groupId/leave — member-initiated departure. Unlike the
  // admin DELETE, this is authenticated by the MEMBER's own pairwise signing
  // key (an early, minimal instance of the signed member→registry requests
  // that RFC 9421 formalizes in a later phase). The member's MAIA signs
  // {action:'leave', groupId, pairwiseId, ts} with its Ed25519 pairwise key;
  // the registry verifies against the stored member.signingPublicKeyJwk and
  // removes the entry. No admin involvement — a member can always leave.
  app.post('/api/groups/:groupId/leave', async (req, res) => {
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') {
        return res.status(404).json({ success: false, error: 'Group not found' });
      }
      const { pairwiseId, payload, signature } = req.body || {};
      if (!pairwiseId || !payload || !signature) {
        return res.status(400).json({ success: false, error: 'pairwiseId, payload and signature are required' });
      }
      const member = (doc.members || []).find((m) => m.pairwiseId === pairwiseId);
      if (!member || member.status === 'invited' || !member.signingPublicKeyJwk) {
        return res.status(404).json({ success: false, error: 'Member not found' });
      }
      // Verify the signature against the member's registered pairwise key.
      let ok = false;
      try {
        const pub = createPublicKey({ key: member.signingPublicKeyJwk, format: 'jwk' });
        ok = edVerify(null, Buffer.from(String(payload)), pub, Buffer.from(String(signature), 'base64url'));
      } catch { ok = false; }
      if (!ok) {
        return res.status(403).json({ success: false, error: 'Invalid signature' });
      }
      // Validate the signed payload binds to THIS action, group, and member.
      let claim;
      try { claim = JSON.parse(String(payload)); } catch { claim = null; }
      if (!claim || claim.action !== 'leave' || claim.groupId !== doc._id || claim.pairwiseId !== pairwiseId) {
        return res.status(400).json({ success: false, error: 'Payload does not match request' });
      }
      doc.members = (doc.members || []).filter((m) => m !== member);
      doc.updatedAt = new Date().toISOString();
      await cloudant.saveDocument(GROUPS_DB, doc);
      auditLog.logEvent({
        type: 'group_member_left',
        userId: null, // self-initiated; registry does not learn the userId
        ip: req.ip,
        details: { groupId: doc._id, pairwiseId }
      });
      res.json({ success: true });
    } catch (error) {
      console.error('[groups] leave failed:', error);
      res.status(500).json({ success: false, error: 'Failed to leave group' });
    }
  });

  // ── PR-3: relay + heartbeat (registry side) ────────────────────────
  // All member-facing endpoints here are authenticated by the member's
  // pairwise Ed25519 signing key (no session), so they work agent-to-agent
  // and cross-deployment. The signed claim binds action + groupId +
  // pairwiseId; an active-membership check gives instant revocation.

  const findActiveMember = (doc, pairwiseId) =>
    (doc.members || []).find((m) => m.pairwiseId === pairwiseId && m.status === 'active');

  // POST /api/groups/:groupId/refresh — the daily heartbeat (Groups.md
  // §6.1/§6.3). Verifies the member, renews the 24 h credential, stamps
  // lastRefreshAt (liveness), deletes any messages the member acks as
  // delivered, and returns still-pending sealed messages for this member.
  // A revoked/removed member gets { revoked: true } so their MAIA drops the
  // membership — this reconciles registry-side revocation.
  app.post('/api/groups/:groupId/refresh', async (req, res) => {
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') {
        return res.status(404).json({ success: false, error: 'Group not found' });
      }
      const { pairwiseId, payload, signature, ackMessageIds } = req.body || {};
      const member = (doc.members || []).find((m) => m.pairwiseId === pairwiseId);
      // No live public key or not active → treat as revoked (fail-safe:
      // the member's MAIA will drop the membership).
      if (!member || member.status !== 'active' || !member.signingPublicKeyJwk) {
        // Still require a well-formed request so this can't enumerate.
        if (!pairwiseId || !payload || !signature) {
          return res.status(400).json({ success: false, error: 'pairwiseId, payload and signature are required' });
        }
        return res.json({ success: true, revoked: true });
      }
      const claim = verifySignedClaim(payload, signature, member.signingPublicKeyJwk, {
        action: 'refresh', groupId: doc._id, pairwiseId
      });
      if (!claim) {
        return res.status(403).json({ success: false, error: 'Invalid signature' });
      }

      member.lastRefreshAt = new Date().toISOString();
      await cloudant.saveDocument(GROUPS_DB, doc);

      // Delete acknowledged (delivered) messages.
      if (Array.isArray(ackMessageIds) && ackMessageIds.length) {
        await Promise.all(ackMessageIds.map(async (id) => {
          try {
            const m = await cloudant.getDocument(RELAY_DB, String(id));
            if (m && m.toPairwiseId === pairwiseId) await cloudant.deleteDocument(RELAY_DB, m._id);
          } catch { /* already gone */ }
        }));
      }

      // Return pending messages addressed to this member in this group.
      let messages = [];
      try {
        const all = await cloudant.getAllDocuments(RELAY_DB);
        messages = (all || [])
          .filter((m) => m && m.type === 'relay_message' && m.groupId === doc._id && m.toPairwiseId === pairwiseId)
          .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
          .map((m) => ({ id: m._id, fromPairwiseId: m.fromPairwiseId, box: m.box, createdAt: m.createdAt }));
      } catch { /* empty on error */ }

      const credential = signMembershipCredential(doc, member);
      res.json({ success: true, revoked: false, credential, messages });
    } catch (error) {
      console.error('[groups] refresh failed:', error);
      res.status(500).json({ success: false, error: 'Failed to refresh' });
    }
  });

  // Best-effort message-arrival notification (backlog #2). When a sealed item
  // lands for a member, email them a nudge to open MAIA — the message itself
  // stays E2E and is fetched on their next poll; this replaces polling for
  // *awareness*. Gated on a VERIFIED notification email; de-bounced so only the
  // FIRST unread since their last poll sends an email (a burst never floods).
  // Single-deployment: the recipient's account is in this USERS_DB; a
  // cross-host member simply isn't found here and is skipped. Never throws.
  /** At most one nudge per quiet period per member. Time-based on purpose:
   *  the old count-based de-bounce (skip when >1 undelivered item) went
   *  SILENT precisely for members who hadn't visited in a while — their
   *  queue only grows until they pull, so the busier it got, the fewer
   *  emails they received. Exactly backwards for notify-instead-of-poll. */
  const NUDGE_QUIET_MS = 6 * 60 * 60 * 1000;

  const notifyGroupMessageRecipient = async (groupDoc, toPairwiseId, appUrl) => {
    try {
      if (typeof sendEmail !== 'function' || !groupDoc || !toPairwiseId) return;
      const member = findActiveMember(groupDoc, toPairwiseId);
      if (!member) return;
      const last = member.lastNudgeAt ? new Date(member.lastNudgeAt).getTime() : 0;
      if (Date.now() - last < NUDGE_QUIET_MS) return;
      // Resolve the recipient's local account via their pairwise membership.
      const users = await cloudant.findDocuments(USERS_DB, {
        selector: {
          groupMemberships: { $elemMatch: { groupId: { $eq: groupDoc._id }, pairwiseId: { $eq: toPairwiseId } } }
        },
        limit: 1
      });
      const recip = users?.docs?.[0];
      if (!recip || !recip.email || !recip.emailVerified) return;
      await sendEmail(
        recip.email,
        `New message in "${groupDoc.name}" on MAIA`,
        [
          `You have a new message in the group "${groupDoc.name}".`,
          '',
          `Open MAIA to read it: ${appUrl}`,
          '(Open it in the same browser where you use MAIA.)'
        ]
      );
      // Stamp the quiet period on a FRESH doc (best-effort — a conflict just
      // means one extra nudge is possible later).
      try {
        const fresh = await cloudant.getDocument(GROUPS_DB, groupDoc._id);
        const fm = fresh ? findActiveMember(fresh, toPairwiseId) : null;
        if (fm) {
          fm.lastNudgeAt = new Date().toISOString();
          await cloudant.saveDocument(GROUPS_DB, fresh);
        }
      } catch { /* best-effort */ }
      console.log(`[NOTIFY] ✅ Group-message email sent to ${recip.email} (group ${groupDoc._id})`);
    } catch (err) {
      console.warn('[NOTIFY] group-message notify failed (non-fatal):', err?.message || err);
    }
  };

  // POST /api/groups/:groupId/relay — store a sealed message for another
  // member. Both sender and recipient must be ACTIVE (instant revocation
  // for relayed traffic, Groups.md §6.1). The relay stores only the opaque
  // box + routing envelope; it never holds a key.
  app.post('/api/groups/:groupId/relay', async (req, res) => {
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') {
        return res.status(404).json({ success: false, error: 'Group not found' });
      }
      const { fromPairwiseId, toPairwiseId, box, payload, signature } = req.body || {};
      if (!fromPairwiseId || !toPairwiseId || !box || !payload || !signature) {
        return res.status(400).json({ success: false, error: 'fromPairwiseId, toPairwiseId, box, payload and signature are required' });
      }
      const sender = findActiveMember(doc, fromPairwiseId);
      if (!sender || !sender.signingPublicKeyJwk) {
        return res.status(403).json({ success: false, error: 'Sender is not an active member' });
      }
      const claim = verifySignedClaim(payload, signature, sender.signingPublicKeyJwk, {
        action: 'relay', groupId: doc._id, fromPairwiseId, toPairwiseId
      });
      if (!claim) {
        return res.status(403).json({ success: false, error: 'Invalid signature' });
      }
      if (!findActiveMember(doc, toPairwiseId)) {
        return res.status(404).json({ success: false, error: 'Recipient is not an active member' });
      }
      const now = Date.now();
      const msg = {
        _id: `relay_${now}_${randomBytes(6).toString('hex')}`,
        type: 'relay_message',
        groupId: doc._id,
        fromPairwiseId,
        toPairwiseId,
        box, // opaque sealed box — relay cannot read it
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + RELAY_TTL_MS).toISOString()
      };
      await cloudant.saveDocument(RELAY_DB, msg);
      // Nudge the recipient by email (best-effort, fire-and-forget so the relay
      // response isn't delayed). Replaces polling for message awareness.
      // Senders of AS-request envelopes suppress this generic nudge — the
      // recipient's ingest sends a request-specific email instead (both
      // resolve the recipient the same way, so nothing is lost).
      if (!req.body?.suppressNotify) {
        const appUrl = (process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
        notifyGroupMessageRecipient(doc, toPairwiseId, appUrl).catch(() => {});
      }
      res.json({ success: true, messageId: msg._id });
    } catch (error) {
      console.error('[groups] relay failed:', error);
      res.status(500).json({ success: false, error: 'Failed to relay message' });
    }
  });

  // GET /api/groups/:groupId/member-key/:pairwiseId — signed lookup of a
  // member's X25519 public key so a sender can seal to them. Requires the
  // CALLER to be an active member (signed query params). This is the
  // minimal slice of the directory (PR-5) that relay send needs.
  app.get('/api/groups/:groupId/member-key/:pairwiseId', async (req, res) => {
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') {
        return res.status(404).json({ success: false, error: 'Group not found' });
      }
      const { caller, payload, signature } = req.query || {};
      const callerMember = findActiveMember(doc, caller);
      if (!callerMember || !callerMember.signingPublicKeyJwk) {
        return res.status(403).json({ success: false, error: 'Caller is not an active member' });
      }
      const claim = verifySignedClaim(payload, signature, callerMember.signingPublicKeyJwk, {
        action: 'member-key', groupId: doc._id, caller
      });
      if (!claim) {
        return res.status(403).json({ success: false, error: 'Invalid signature' });
      }
      const target = findActiveMember(doc, req.params.pairwiseId);
      if (!target || !target.encryptionPublicKeyJwk) {
        return res.status(404).json({ success: false, error: 'Member not found' });
      }
      res.json({
        success: true,
        pairwiseId: target.pairwiseId,
        alias: target.alias || null,
        encryptionPublicKeyJwk: target.encryptionPublicKeyJwk
      });
    } catch (error) {
      console.error('[groups] member-key lookup failed:', error);
      res.status(500).json({ success: false, error: 'Failed to look up member key' });
    }
  });

  // GET /api/groups/:groupId/stats — aggregate liquidity only (Groups.md
  // §6.4/§6.6). Signed by an active member. Returns counts, never a roster.
  app.get('/api/groups/:groupId/stats', async (req, res) => {
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') {
        return res.status(404).json({ success: false, error: 'Group not found' });
      }
      const { caller, payload, signature } = req.query || {};
      const callerMember = findActiveMember(doc, caller);
      if (!callerMember || !callerMember.signingPublicKeyJwk) {
        return res.status(403).json({ success: false, error: 'Caller is not an active member' });
      }
      if (!verifySignedClaim(payload, signature, callerMember.signingPublicKeyJwk, {
        action: 'stats', groupId: doc._id, caller
      })) {
        return res.status(403).json({ success: false, error: 'Invalid signature' });
      }
      const cutoff = Date.now() - LIVENESS_WINDOW_MS;
      const active = (doc.members || []).filter((m) => m.status === 'active');
      const recentlyActive = active.filter((m) => m.lastRefreshAt && new Date(m.lastRefreshAt).getTime() >= cutoff);
      res.json({
        success: true,
        stats: { activeMembers: active.length, recentlyActiveMembers: recentlyActive.length }
      });
    } catch (error) {
      console.error('[groups] stats failed:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch stats' });
    }
  });

  // GET /api/groups/:groupId/directory — the member-facing directory
  // (Groups.md §6.6, §7.3). Signed by an active member. Returns aggregate
  // liquidity PLUS the opt-in-discoverable members only (mentors) by alias
  // + pairwiseId. Regular members are NOT individually listed — "aggregate
  // liquidity, individual silence." You reach a non-mentor via reply, a
  // match-probe (Phase 3), or a mentor introduction, never a browsable
  // roster. The caller is excluded from the mentor list.
  app.get('/api/groups/:groupId/directory', async (req, res) => {
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') {
        return res.status(404).json({ success: false, error: 'Group not found' });
      }
      const { caller, payload, signature } = req.query || {};
      const callerMember = findActiveMember(doc, caller);
      if (!callerMember || !callerMember.signingPublicKeyJwk) {
        return res.status(403).json({ success: false, error: 'Caller is not an active member' });
      }
      if (!verifySignedClaim(payload, signature, callerMember.signingPublicKeyJwk, {
        action: 'directory', groupId: doc._id, caller
      })) {
        return res.status(403).json({ success: false, error: 'Invalid signature' });
      }
      const cutoff = Date.now() - LIVENESS_WINDOW_MS;
      const active = (doc.members || []).filter((m) => m.status === 'active');
      const recentlyActive = active.filter((m) => m.lastRefreshAt && new Date(m.lastRefreshAt).getTime() >= cutoff);
      const mentors = active
        .filter((m) => m.mentor && m.pairwiseId !== caller)
        .map((m) => ({ pairwiseId: m.pairwiseId, alias: m.alias || '(member)', tag: m.mentorTag || '' }));
      res.json({
        success: true,
        stats: { activeMembers: active.length, recentlyActiveMembers: recentlyActive.length },
        postingPolicy: doc.postingPolicy || '',
        mentors
      });
    } catch (error) {
      console.error('[groups] directory failed:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch directory' });
    }
  });

  // DELETE /api/groups/:groupId — delete the whole group (admin). Every
  // member's access ends: credentials stop refreshing (dead within 24 h,
  // §6.1) and each member's MAIA drops the membership on its next refresh
  // (the registry 404 reads as revoked). Relay messages and AS requests
  // for the group become undeliverable and are swept by the daily
  // maintenance TTLs. Irreversible without the recovery kit (§6.7).
  app.delete('/api/groups/:groupId', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') {
        return res.status(404).json({ success: false, error: 'Group not found' });
      }
      const counts = memberCounts(doc);
      await cloudant.deleteDocument(GROUPS_DB, doc._id);
      auditLog.logEvent({
        type: 'group_deleted',
        userId: req.session?.userId || 'admin-local',
        ip: req.ip,
        details: { groupId: doc._id, name: doc.name, activeMembers: counts.active }
      });
      res.json({ success: true, deleted: doc._id });
    } catch (error) {
      console.error('[groups] delete failed:', error);
      res.status(500).json({ success: false, error: 'Failed to delete group' });
    }
  });

  // PUT /api/groups/:groupId/members/:pairwiseId/mentor — admin toggles a
  // member's mentor (discoverable) flag. Mentors are the supply side of the
  // matching market (Groups.md §6.6, Refinement 1): the only members listed
  // individually in the directory. Admin-curated for launch; member
  // self-opt-in is a noted follow-up.
  app.put('/api/groups/:groupId/members/:pairwiseId/mentor', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') {
        return res.status(404).json({ success: false, error: 'Group not found' });
      }
      const member = (doc.members || []).find((m) => m.pairwiseId === req.params.pairwiseId);
      if (!member || member.status !== 'active') {
        return res.status(404).json({ success: false, error: 'Active member not found' });
      }
      member.mentor = !!(req.body && req.body.mentor);
      doc.updatedAt = new Date().toISOString();
      await cloudant.saveDocument(GROUPS_DB, doc);
      auditLog.logEvent({
        type: 'group_member_mentor_set',
        userId: req.session?.userId || 'admin-local',
        ip: req.ip,
        details: { groupId: doc._id, pairwiseId: member.pairwiseId, mentor: member.mentor }
      });
      res.json({ success: true, mentor: member.mentor });
    } catch (error) {
      console.error('[groups] mentor toggle failed:', error);
      res.status(500).json({ success: false, error: 'Failed to update mentor flag' });
    }
  });

  // POST /api/groups/:groupId/mentor-optin — member SELF-opt-in (the
  // follow-up noted on the admin toggle above). Mentors are listed
  // publicly and accept peer messages without prior approval, so the
  // choice belongs to the member: a signed claim from the pairwise
  // signing key flips their own flag and sets the public tag.
  app.post('/api/groups/:groupId/mentor-optin', async (req, res) => {
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') {
        return res.status(404).json({ success: false, error: 'Group not found' });
      }
      const { pairwiseId, payload, signature } = req.body || {};
      const member = findActiveMember(doc, pairwiseId);
      if (!member || !member.signingPublicKeyJwk) {
        return res.status(403).json({ success: false, error: 'Not an active member' });
      }
      const claim = verifySignedClaim(payload, signature, member.signingPublicKeyJwk, {
        action: 'mentor-optin', groupId: doc._id, pairwiseId
      });
      if (!claim) {
        return res.status(403).json({ success: false, error: 'Invalid signature' });
      }
      member.mentor = !!claim.mentor;
      member.mentorTag = String(claim.tag || '').trim().slice(0, 60);
      doc.updatedAt = new Date().toISOString();
      await cloudant.saveDocument(GROUPS_DB, doc);
      auditLog.logEvent({
        type: 'group_member_mentor_optin',
        userId: 'member',
        ip: req.ip,
        details: { groupId: doc._id, pairwiseId, mentor: member.mentor, tag: member.mentorTag }
      });
      res.json({ success: true, mentor: member.mentor, tag: member.mentorTag });
    } catch (error) {
      console.error('[groups] mentor opt-in failed:', error);
      res.status(500).json({ success: false, error: 'Failed to update mentor listing' });
    }
  });

  // POST /api/groups/:groupId/broadcast-keys — an active member asks for
  // the sealing keys of everyone who accepts Everyone-messages, to send a
  // group-wide message ("Everyone", like a Zoom conference). Returns
  // pseudonymous {pairwiseId, encryptionPublicKeyJwk} pairs only — no
  // aliases, so the browsable-roster privacy stance holds — excluding the
  // caller and anyone whose "Everyone in the group messages" switch is
  // off (delivery-level muting; a policy-card version may follow).
  app.post('/api/groups/:groupId/broadcast-keys', async (req, res) => {
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') {
        return res.status(404).json({ success: false, error: 'Group not found' });
      }
      const { pairwiseId, payload, signature } = req.body || {};
      const caller = findActiveMember(doc, pairwiseId);
      if (!caller || !caller.signingPublicKeyJwk) {
        return res.status(403).json({ success: false, error: 'Not an active member' });
      }
      if (!verifySignedClaim(payload, signature, caller.signingPublicKeyJwk, {
        action: 'broadcast-keys', groupId: doc._id, pairwiseId
      })) {
        return res.status(403).json({ success: false, error: 'Invalid signature' });
      }
      const active = (doc.members || []).filter((m) => m.status === 'active' && m.encryptionPublicKeyJwk);
      const recipients = active
        .filter((m) => m.pairwiseId !== pairwiseId && m.broadcastMessages !== false)
        .map((m) => ({ pairwiseId: m.pairwiseId, encryptionPublicKeyJwk: m.encryptionPublicKeyJwk }));
      res.json({
        success: true,
        recipients,
        muted: active.length - 1 - recipients.length
      });
    } catch (error) {
      console.error('[groups] broadcast-keys failed:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch broadcast keys' });
    }
  });

  // POST /api/groups/:groupId/message-prefs — member-signed switch:
  // "Everyone in the group messages" (default ON). Off = the member's
  // sealing key is left out of broadcast fan-outs, so muted members
  // never even receive the ciphertext.
  app.post('/api/groups/:groupId/message-prefs', async (req, res) => {
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') {
        return res.status(404).json({ success: false, error: 'Group not found' });
      }
      const { pairwiseId, payload, signature } = req.body || {};
      const member = findActiveMember(doc, pairwiseId);
      if (!member || !member.signingPublicKeyJwk) {
        return res.status(403).json({ success: false, error: 'Not an active member' });
      }
      const claim = verifySignedClaim(payload, signature, member.signingPublicKeyJwk, {
        action: 'message-prefs', groupId: doc._id, pairwiseId
      });
      if (!claim) {
        return res.status(403).json({ success: false, error: 'Invalid signature' });
      }
      member.broadcastMessages = claim.everyone !== false;
      doc.updatedAt = new Date().toISOString();
      await cloudant.saveDocument(GROUPS_DB, doc);
      auditLog.logEvent({
        type: 'group_member_message_prefs',
        userId: 'member',
        ip: req.ip,
        details: { groupId: doc._id, pairwiseId, everyone: member.broadcastMessages }
      });
      res.json({ success: true, everyone: member.broadcastMessages });
    } catch (error) {
      console.error('[groups] message-prefs failed:', error);
      res.status(500).json({ success: false, error: 'Failed to update message preferences' });
    }
  });

  // POST /api/groups/:groupId/alias-change — member-signed display-name
  // change (no more leave-and-rejoin to rename). The directory, mentor
  // list, and future message attributions pick the new alias up
  // immediately; peers' devices keep cached old-alias attributions on
  // messages already delivered (same as renaming a phone contact).
  app.post('/api/groups/:groupId/alias-change', async (req, res) => {
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') {
        return res.status(404).json({ success: false, error: 'Group not found' });
      }
      const { pairwiseId, payload, signature } = req.body || {};
      const member = findActiveMember(doc, pairwiseId);
      if (!member || !member.signingPublicKeyJwk) {
        return res.status(403).json({ success: false, error: 'Not an active member' });
      }
      const claim = verifySignedClaim(payload, signature, member.signingPublicKeyJwk, {
        action: 'alias-change', groupId: doc._id, pairwiseId
      });
      if (!claim) {
        return res.status(403).json({ success: false, error: 'Invalid signature' });
      }
      const alias = String(claim.alias || '').trim().slice(0, 40);
      if (!alias) {
        return res.status(400).json({ success: false, error: 'A display name is required' });
      }
      member.alias = alias;
      doc.updatedAt = new Date().toISOString();
      await cloudant.saveDocument(GROUPS_DB, doc);
      auditLog.logEvent({
        type: 'group_member_alias_changed',
        userId: 'member',
        ip: req.ip,
        details: { groupId: doc._id, pairwiseId, alias }
      });
      res.json({ success: true, alias });
    } catch (error) {
      console.error('[groups] alias change failed:', error);
      res.status(500).json({ success: false, error: 'Failed to change display name' });
    }
  });

  // Sweep expired relay messages + expired invites (called by the daily
  // cron in server/index.js). Returns counts for logging.
  const sweepExpired = async () => {
    const nowIso = new Date().toISOString();
    let relayDeleted = 0;
    let invitesExpired = 0;
    try {
      const all = await cloudant.getAllDocuments(RELAY_DB);
      for (const m of all || []) {
        if (m && (m.type === 'relay_message' || m.type === 'outside_request_tally') && m.expiresAt && m.expiresAt < nowIso) {
          // A request that expires with its escrow still open was never
          // answered by anyone: the spam deposit is FORFEITED (silence is
          // exactly what the deposit priced in), a sharing payment goes
          // BACK (nothing was shared, so nothing was earned).
          if (m.type === 'outside_request_tally' && m.payment && !m.payment.resolved) {
            try {
              await resolveHold(
                cloudant, m.payment.email, m.requestId,
                m.payment.type === 'spam-deposit' ? 'forfeit' : 'release'
              );
            } catch (e) {
              console.warn('[credits] expiry settle failed:', e?.message || e);
            }
          }
          try { await cloudant.deleteDocument(RELAY_DB, m._id); relayDeleted++; } catch { /* ignore */ }
        }
      }
    } catch { /* relay db may not exist yet */ }
    try {
      const groups = await cloudant.getAllDocuments(GROUPS_DB);
      for (const g of groups || []) {
        if (!g || g.type !== 'group' || !Array.isArray(g.members)) continue;
        const before = g.members.length;
        g.members = g.members.filter((m) => !(m.status === 'invited' && m.inviteExpiresAt && m.inviteExpiresAt < nowIso));
        if (g.members.length !== before) {
          invitesExpired += before - g.members.length;
          g.updatedAt = nowIso;
          try { await cloudant.saveDocument(GROUPS_DB, g); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    // NOTE: notification emails are NOT swept here. A verified email only ever
    // reaches a userDoc once the visitor has an actual MAIA (they clicked GET
    // STARTED) and deliberately provided it — that address is theirs to keep,
    // group membership or not. A pre-account "tire-kicker" email never
    // persists past the 10-min in-memory code (server/emailVerification.js);
    // abandoned temporary accounts are cleaned up whole (email included) by
    // the account-cleanup path, so no per-email 72h purge is needed.
    return { relayDeleted, invitesExpired };
  };

  // ── PR-2: patient-side membership endpoints ────────────────────────
  // Session pattern matches existing user endpoints: userId comes from the
  // request; when a session exists it must match (403 on mismatch).

  const requireMatchingUser = (req, res) => {
    const userId = req.body?.userId || req.query?.userId;
    if (!userId) {
      res.status(400).json({ success: false, error: 'userId is required' });
      return null;
    }
    const sessionUserId = req.session?.userId;
    if (sessionUserId && sessionUserId !== userId) {
      res.status(403).json({ success: false, error: 'Cannot act for another user' });
      return null;
    }
    return userId;
  };

  /** Membership view returned to the patient's browser: NO private keys —
   *  those stay on the userDoc for the server-side AS to use. */
  /** Import a group's suggested policy cards as the member's own EDITABLE
   *  cards (provenance 'group:<id>') on first join — the Sharing Policies
   *  tab already renders them in a "Suggested by <group>" section with
   *  enable/edit/delete. Skipped if any card with that provenance exists
   *  (rejoin / re-import must not clobber the member's edits). */
  const importSuggestedPolicies = (userDoc, groupId, cards) => {
    if (!Array.isArray(cards) || cards.length === 0) return;
    const prov = `group:${groupId}`;
    const existing = userDoc.sharingPolicies || [];
    if (existing.some((c) => c.provenance === prov)) return;
    const now = new Date().toISOString();
    const imported = cards.slice(0, 20).map((c, i) => ({
      id: `pol_${Date.now()}_${i}_${randomBytes(3).toString('hex')}`,
      outcome: c.outcome,
      ...(c.outcome === 'deny' ? { denyMode: c.denyMode === 'respond' ? 'respond' : 'silent' } : {}),
      enabled: c.enabled !== false,
      provenance: prov,
      // The card belongs to the group being JOINED — stamp its id so a stale
      // embedded groupId (from a recreated group / imported policy file) can
      // never make the card unmatchable.
      elements: (c.elements?.party?.type === 'group')
        ? { ...c.elements, party: { ...c.elements.party, groupId } }
        : c.elements,
      createdFrom: 'manual',
      createdAt: now,
      updatedAt: now
    }));
    userDoc.sharingPolicies = [...existing, ...imported];
  };

  const membershipView = (m) => ({
    groupId: m.groupId,
    groupName: m.groupName,
    registryUrl: m.registryUrl,
    pairwiseId: m.pairwiseId,
    alias: m.alias,
    joinedAt: m.joinedAt,
    credentialExpiresAt: m.credential?.expiresAt || null,
    mentor: !!m.mentor,
    mentorTag: m.mentorTag || '',
    broadcastMessages: m.broadcastMessages !== false,
    invitedBy: m.invitedBy || null
  });

  // POST /api/user-groups/join — the patient accepts an invite. Their MAIA
  // generates the per-group keypairs (sign + encrypt, §7.2), redeems the
  // token at the registry over HTTP (the federation seam — same host in
  // Phase 1), and stores the membership on the userDoc.
  app.post('/api/user-groups/join', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const { groupId, token, alias, registryUrl } = req.body || {};
      if (!groupId || !token || !alias || !String(alias).trim()) {
        return res.status(400).json({ success: false, error: 'groupId, token and alias are required' });
      }
      const userDoc = await cloudant.getDocument(USERS_DB, userId);
      if (!userDoc) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }
      // A verified notification email is required to join a group: the group
      // needs a reachable address to notify the member (so it never polls).
      if (!userDoc.emailVerified) {
        return res.status(403).json({ success: false, error: 'EMAIL_NOT_VERIFIED', message: 'Verify your notification email before joining a group.' });
      }
      if ((userDoc.groupMemberships || []).some((m) => m.groupId === groupId)) {
        return res.status(400).json({ success: false, error: 'Already a member of this group' });
      }

      // Per-group pairwise keypairs (§3.1, §7.2): Ed25519 for signing,
      // X25519 for sealed-box encryption. Different groups see different
      // keys — no cross-group correlation.
      const signPair = generateKeyPairSync('ed25519');
      const encPair = generateKeyPairSync('x25519');
      const signingPublicKeyJwk = signPair.publicKey.export({ format: 'jwk' });
      const encryptionPublicKeyJwk = encPair.publicKey.export({ format: 'jwk' });

      // Redeem at the registry. Default: this deployment (Phase 1).
      const base = String(registryUrl || `http://localhost:${process.env.PORT || 3001}`).replace(/\/$/, '');
      const joinRes = await fetch(`${base}/api/groups/${encodeURIComponent(groupId)}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, alias, signingPublicKeyJwk, encryptionPublicKeyJwk })
      });
      const joinData = await joinRes.json().catch(() => ({}));
      if (!joinRes.ok || !joinData.success) {
        return res.status(joinRes.status === 400 ? 400 : 502).json({
          success: false,
          error: joinData.error || `Registry join failed (HTTP ${joinRes.status})`
        });
      }

      const m = joinData.membership;
      const membership = {
        groupId: m.groupId,
        groupName: m.groupName,
        registryUrl: base,
        pairwiseId: m.pairwiseId,
        alias: m.alias,
        signingKeyPair: {
          publicKeyJwk: signingPublicKeyJwk,
          privateKeyJwk: signPair.privateKey.export({ format: 'jwk' })
        },
        encryptionKeyPair: {
          publicKeyJwk: encryptionPublicKeyJwk,
          privateKeyJwk: encPair.privateKey.export({ format: 'jwk' })
        },
        credential: m.credential,
        groupPublicKeyJwk: m.groupPublicKeyJwk,
        joinedAt: new Date().toISOString(),
        // Member-invite provenance: seeds the first conversation and
        // pre-accepts the inviter (mutual consent — they invited, we
        // accepted the invitation).
        invitedBy: m.inviter || null,
        acceptedSenders: m.inviter ? [m.inviter.pairwiseId] : []
      };
      if (!userDoc.asId) userDoc.asId = randomBytes(16).toString('hex');
      userDoc.groupMemberships = [...(userDoc.groupMemberships || []), membership];
      importSuggestedPolicies(userDoc, m.groupId, m.suggestedPolicies);
      userDoc.updatedAt = membership.joinedAt;
      await cloudant.saveDocument(USERS_DB, userDoc);

      auditLog.logEvent({
        type: 'user_group_joined',
        userId,
        ip: req.ip,
        details: { groupId: m.groupId, pairwiseId: m.pairwiseId }
      });
      res.json({ success: true, membership: membershipView(membership) });
    } catch (error) {
      console.error('[user-groups] join failed:', error);
      res.status(500).json({ success: false, error: 'Failed to join group' });
    }
  });

  // POST /api/user-groups/invite — a member invites someone to their group
  // by email (PR-8). Signs a member-invite claim with the membership's
  // pairwise key and calls the group registry, which minted-and-emails the
  // invite (subject to the group's memberInvitesAllowed policy).
  app.post('/api/user-groups/invite', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const { groupId, email } = req.body || {};
      if (!groupId || !email || !String(email).trim()) {
        return res.status(400).json({ success: false, error: 'groupId and email are required' });
      }
      const userDoc = await cloudant.getDocument(USERS_DB, userId);
      const membership = (userDoc?.groupMemberships || []).find((m) => m.groupId === groupId);
      if (!membership) return res.status(404).json({ success: false, error: 'Not a member of this group' });
      const { payload, signature } = signWithMembership(membership, {
        action: 'member-invite', groupId: membership.groupId, caller: membership.pairwiseId, ts: new Date().toISOString()
      });
      const r = await fetch(`${registryBase(membership)}/api/groups/${encodeURIComponent(membership.groupId)}/member-invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caller: membership.pairwiseId,
          payload,
          signature,
          email: String(email).trim().toLowerCase()
        })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.success) {
        return res.status(r.status === 403 ? 403 : 502).json({
          success: false,
          error: data.error || 'Registry rejected the invite'
        });
      }
      auditLog.logEvent({
        type: 'user_group_invite_sent',
        userId,
        ip: req.ip,
        details: { groupId: membership.groupId, emailSent: !!data.invite?.emailSent }
      });
      res.json({ success: true, invite: data.invite });
    } catch (error) {
      console.error('[user-groups] invite failed:', error);
      res.status(500).json({ success: false, error: 'Failed to send invitation' });
    }
  });

  // GET /api/user-groups — the patient's memberships (no private keys)
  // plus any join requests still awaiting admin approval.
  app.get('/api/user-groups', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const userDoc = await cloudant.getDocument(USERS_DB, userId);
      if (!userDoc) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }
      res.json({
        success: true,
        memberships: (userDoc.groupMemberships || []).map(membershipView),
        pendingJoins: (userDoc.pendingGroupJoins || []).map((p) => ({
          groupId: p.groupId,
          groupName: p.groupName,
          alias: p.alias,
          requestedAt: p.requestedAt
        }))
      });
    } catch (error) {
      console.error('[user-groups] list failed:', error);
      res.status(500).json({ success: false, error: 'Failed to list memberships' });
    }
  });

  /** Validate a registry base URL for the info proxies below: http(s)
   *  only. The same trust seam as join/request-join, which already fetch
   *  caller-supplied registry URLs server-side (Phase-1 federation). */
  const safeRegistryBase = (raw) => {
    try {
      const u = new URL(String(raw || ''));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.origin;
    } catch { return null; }
  };

  // GET /api/user-groups/invite-info — proxy a (possibly foreign)
  // registry's invite-info so the browser never needs cross-origin CORS
  // (PR-11, existing-MAIA join). Also marks the invite opened, exactly
  // like a same-origin open would.
  app.get('/api/user-groups/invite-info', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const base = safeRegistryBase(req.query?.registry || `http://localhost:${process.env.PORT || 3001}`);
      const { groupId, token } = req.query || {};
      if (!base || !groupId || !token) {
        return res.status(400).json({ success: false, error: 'registry, groupId and token are required' });
      }
      const r = await fetch(`${base}/api/groups/${encodeURIComponent(groupId)}/invite-info?token=${encodeURIComponent(token)}`);
      const data = await r.json().catch(() => ({}));
      res.status(r.ok ? 200 : 502).json(data);
    } catch (error) {
      console.error('[user-groups] invite-info proxy failed:', error);
      res.status(502).json({ success: false, error: 'Registry unreachable' });
    }
  });

  // GET /api/user-groups/join-info — same proxy for shareable join links.
  app.get('/api/user-groups/join-info', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const base = safeRegistryBase(req.query?.registry || `http://localhost:${process.env.PORT || 3001}`);
      const { groupId, token } = req.query || {};
      if (!base || !groupId || !token) {
        return res.status(400).json({ success: false, error: 'registry, groupId and token are required' });
      }
      const r = await fetch(`${base}/api/groups/${encodeURIComponent(groupId)}/join-info?token=${encodeURIComponent(token)}`);
      const data = await r.json().catch(() => ({}));
      res.status(r.ok ? 200 : 502).json(data);
    } catch (error) {
      console.error('[user-groups] join-info proxy failed:', error);
      res.status(502).json({ success: false, error: 'Registry unreachable' });
    }
  });

  // POST /api/user-groups/filter-text — apply the user's privacy-filter
  // name mapping (userDoc.privacyFilter.pseudonymMapping, same source as
  // physician deep-link sharing) to arbitrary text. Mandatory
  // pseudonymization before AI-derived text is shared with a peer
  // (Refinement 6 unified share action; originally PR-7).
  app.post('/api/user-groups/filter-text', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const text = String(req.body?.text || '');
      if (!text.trim()) return res.status(400).json({ success: false, error: 'text is required' });
      const userDoc = await cloudant.getDocument(USERS_DB, userId);
      const mapping = userDoc?.privacyFilter?.pseudonymMapping || [];
      // Single shared implementation (server/privacyFilter.js) — the same
      // transform generates the privacy-filtered Patient Summary.
      const out = applyPseudonymMapping(mapping, text);
      res.json({ success: true, filtered: out, mappingCount: mapping.length });
    } catch (error) {
      console.error('[user-groups] filter-text failed:', error);
      res.status(500).json({ success: false, error: 'Failed to filter text' });
    }
  });

  // POST /api/user-groups/request-join — redeem a shareable join LINK
  // (PR-9): generate pairwise keys, submit a join request to the registry,
  // and remember it on the userDoc until the admin decides.
  // 409-safe userDoc write: joins race the setup-time writers (lists
  // build, quick start, indexing status) — a conflict must re-apply the
  // membership on a FRESH doc, not fail the join (the registry side has
  // already admitted the member by then).
  const saveUserDocWithRetry = async (userId, mutate) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const doc = await cloudant.getDocument(USERS_DB, userId);
      if (!doc) throw new Error('User not found');
      mutate(doc);
      try {
        await cloudant.saveDocument(USERS_DB, doc);
        return doc;
      } catch (e) {
        if (e?.statusCode !== 409 || attempt === 3) throw e;
      }
    }
  };

  app.post('/api/user-groups/request-join', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const { groupId, token, alias, registryUrl } = req.body || {};
      if (!groupId || !token || !alias || !String(alias).trim()) {
        return res.status(400).json({ success: false, error: 'groupId, token and alias are required' });
      }
      const userDoc = await cloudant.getDocument(USERS_DB, userId);
      if (!userDoc) return res.status(404).json({ success: false, error: 'User not found' });
      // A verified notification email is required to join / request a group.
      if (!userDoc.emailVerified) {
        return res.status(403).json({ success: false, error: 'EMAIL_NOT_VERIFIED', message: 'Verify your notification email before joining a group.' });
      }
      if ((userDoc.groupMemberships || []).some((m) => m.groupId === groupId)) {
        return res.status(400).json({ success: false, error: 'Already a member of this group' });
      }
      if ((userDoc.pendingGroupJoins || []).some((p) => p.groupId === groupId)) {
        return res.status(400).json({ success: false, error: 'A join request for this group is already pending' });
      }
      const signPair = generateKeyPairSync('ed25519');
      const encPair = generateKeyPairSync('x25519');
      const signingPublicKeyJwk = signPair.publicKey.export({ format: 'jwk' });
      const encryptionPublicKeyJwk = encPair.publicKey.export({ format: 'jwk' });
      const base = String(registryUrl || `http://localhost:${process.env.PORT || 3001}`).replace(/\/$/, '');
      const r = await fetch(`${base}/api/groups/${encodeURIComponent(groupId)}/join-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, alias: String(alias).trim(), signingPublicKeyJwk, encryptionPublicKeyJwk })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.success) {
        return res.status(r.status === 403 ? 403 : 502).json({
          success: false,
          error: data.error || `Registry rejected the join request (HTTP ${r.status})`
        });
      }
      const pending = {
        groupId,
        groupName: data.groupName || groupId,
        registryUrl: base,
        pairwiseId: data.pairwiseId,
        alias: String(alias).trim().slice(0, 60),
        signingKeyPair: {
          publicKeyJwk: signingPublicKeyJwk,
          privateKeyJwk: signPair.privateKey.export({ format: 'jwk' })
        },
        encryptionKeyPair: {
          publicKeyJwk: encryptionPublicKeyJwk,
          privateKeyJwk: encPair.privateKey.export({ format: 'jwk' })
        },
        requestedAt: new Date().toISOString()
      };

      // Open-mode group (data.immediate): the registry admitted us on the
      // spot — collect the credential NOW via the signed status endpoint
      // and return a full membership in this same round trip. No pending
      // state, no polling, no dead air.
      if (data.immediate) {
        try {
          const { payload: sp, signature: ss } = signWithMembership(pending, {
            action: 'join-status', groupId, caller: pending.pairwiseId, ts: new Date().toISOString()
          });
          const sr = await fetch(
            `${base}/api/groups/${encodeURIComponent(groupId)}/join-requests/${encodeURIComponent(pending.pairwiseId)}/status` +
            `?payload=${encodeURIComponent(sp)}&signature=${encodeURIComponent(ss)}`
          );
          const sd = await sr.json().catch(() => ({}));
          if (sr.ok && sd.success && sd.status === 'active' && sd.membership) {
            const m = sd.membership;
            const membership = {
              groupId: m.groupId,
              groupName: m.groupName,
              registryUrl: base,
              pairwiseId: m.pairwiseId,
              alias: m.alias,
              signingKeyPair: pending.signingKeyPair,
              encryptionKeyPair: pending.encryptionKeyPair,
              credential: m.credential,
              groupPublicKeyJwk: m.groupPublicKeyJwk,
              joinedAt: new Date().toISOString(),
              invitedBy: null,
              acceptedSenders: []
            };
            await saveUserDocWithRetry(userId, (doc) => {
              doc.groupMemberships = [...(doc.groupMemberships || []), membership];
              importSuggestedPolicies(doc, m.groupId, m.suggestedPolicies);
              doc.updatedAt = membership.joinedAt;
            });
            auditLog.logEvent({
              type: 'user_group_joined',
              userId,
              ip: req.ip,
              details: { groupId, pairwiseId: m.pairwiseId, via: 'open-link' }
            });
            return res.json({ success: true, joined: true, membership: membershipView(membership) });
          }
        } catch { /* fall through to the pending path — the poll will finish it */ }
      }

      await saveUserDocWithRetry(userId, (doc) => {
        doc.pendingGroupJoins = [...(doc.pendingGroupJoins || []), pending];
        doc.updatedAt = pending.requestedAt;
      });
      auditLog.logEvent({
        type: 'user_group_join_requested',
        userId,
        ip: req.ip,
        details: { groupId, pairwiseId: data.pairwiseId }
      });
      res.json({ success: true, pending: { groupId, groupName: pending.groupName, alias: pending.alias, requestedAt: pending.requestedAt } });
    } catch (error) {
      console.error('[user-groups] request-join failed:', error);
      res.status(500).json({ success: false, error: 'Failed to submit join request' });
    }
  });

  // POST /api/user-groups/poll-joins — check every pending join request
  // against its registry (signed). Approved → becomes a real membership
  // (the panel's auto-poll calls this, so approval lands within seconds).
  app.post('/api/user-groups/poll-joins', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const userDoc = await cloudant.getDocument(USERS_DB, userId);
      if (!userDoc) return res.status(404).json({ success: false, error: 'User not found' });
      const pendings = userDoc.pendingGroupJoins || [];
      if (pendings.length === 0) return res.json({ success: true, activated: [], rejected: [], pending: 0 });
      const activated = [];
      const rejected = [];
      const still = [];
      for (const p of pendings) {
        try {
          const { payload, signature } = signWithMembership(p, {
            action: 'join-status', groupId: p.groupId, caller: p.pairwiseId, ts: new Date().toISOString()
          });
          const r = await fetch(
            `${p.registryUrl}/api/groups/${encodeURIComponent(p.groupId)}/join-requests/${encodeURIComponent(p.pairwiseId)}/status` +
            `?payload=${encodeURIComponent(payload)}&signature=${encodeURIComponent(signature)}`
          );
          const data = await r.json().catch(() => ({}));
          if (r.ok && data.success && data.status === 'active' && data.membership) {
            const m = data.membership;
            userDoc.groupMemberships = [...(userDoc.groupMemberships || []), {
              groupId: m.groupId,
              groupName: m.groupName,
              registryUrl: p.registryUrl,
              pairwiseId: m.pairwiseId,
              alias: m.alias,
              signingKeyPair: p.signingKeyPair,
              encryptionKeyPair: p.encryptionKeyPair,
              credential: m.credential,
              groupPublicKeyJwk: m.groupPublicKeyJwk,
              joinedAt: new Date().toISOString(),
              invitedBy: null,
              acceptedSenders: []
            }];
            importSuggestedPolicies(userDoc, m.groupId, m.suggestedPolicies);
            activated.push({ groupId: m.groupId, groupName: m.groupName });
          } else if (r.ok && data.success && data.status === 'rejected') {
            rejected.push({ groupId: p.groupId, groupName: p.groupName });
          } else {
            still.push(p); // registry unreachable or still pending
          }
        } catch {
          still.push(p);
        }
      }
      if (activated.length || rejected.length) {
        userDoc.pendingGroupJoins = still;
        userDoc.updatedAt = new Date().toISOString();
        await cloudant.saveDocument(USERS_DB, userDoc);
      }
      res.json({ success: true, activated, rejected, pending: still.length });
    } catch (error) {
      console.error('[user-groups] poll-joins failed:', error);
      res.status(500).json({ success: false, error: 'Failed to poll join requests' });
    }
  });

  // POST /api/user-groups/leave — the patient leaves a group. Signs a leave
  // request with the membership's pairwise Ed25519 key, tells the registry
  // to remove the entry, then drops the membership from the userDoc. The
  // registry call is best-effort: even if it fails (e.g. group host down),
  // we still remove the local membership so the user isn't stuck, and the
  // credential dies within 24 h (§6.1) without refresh.
  app.post('/api/user-groups/leave', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const { groupId } = req.body || {};
      if (!groupId) {
        return res.status(400).json({ success: false, error: 'groupId is required' });
      }
      const userDoc = await cloudant.getDocument(USERS_DB, userId);
      if (!userDoc) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }
      const membership = (userDoc.groupMemberships || []).find((m) => m.groupId === groupId);
      if (!membership) {
        return res.status(404).json({ success: false, error: 'Not a member of this group' });
      }

      // Sign a leave claim with the pairwise signing key, then notify the
      // registry so the member entry is removed there too.
      let registryNotified = false;
      try {
        const payload = JSON.stringify({
          action: 'leave',
          groupId,
          pairwiseId: membership.pairwiseId,
          ts: new Date().toISOString()
        });
        const priv = createPrivateKey({ key: membership.signingKeyPair.privateKeyJwk, format: 'jwk' });
        const signature = edSign(null, Buffer.from(payload), priv).toString('base64url');
        const base = String(membership.registryUrl || `http://localhost:${process.env.PORT || 3001}`).replace(/\/$/, '');
        const r = await fetch(`${base}/api/groups/${encodeURIComponent(groupId)}/leave`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pairwiseId: membership.pairwiseId, payload, signature })
        });
        registryNotified = r.ok;
      } catch (e) {
        console.warn('[user-groups] registry leave notify failed:', e?.message || e);
      }

      userDoc.groupMemberships = (userDoc.groupMemberships || []).filter((m) => m.groupId !== groupId);
      userDoc.updatedAt = new Date().toISOString();
      await cloudant.saveDocument(USERS_DB, userDoc);
      auditLog.logEvent({
        type: 'user_group_left',
        userId,
        ip: req.ip,
        details: { groupId, pairwiseId: membership.pairwiseId, registryNotified }
      });
      res.json({ success: true, registryNotified });
    } catch (error) {
      console.error('[user-groups] leave failed:', error);
      res.status(500).json({ success: false, error: 'Failed to leave group' });
    }
  });

  // POST /api/user-groups/mentor — the member's side of mentor self-opt-in
  // (Sharing Policies tab). Signs a claim with the pairwise key, updates
  // the registry (possibly a different deployment), then mirrors the flag
  // and tag onto the local membership so the UI reflects it immediately.
  app.post('/api/user-groups/mentor', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const { groupId, mentor, tag } = req.body || {};
      if (!groupId) {
        return res.status(400).json({ success: false, error: 'groupId is required' });
      }
      const userDoc = await cloudant.getDocument(USERS_DB, userId);
      const membership = (userDoc?.groupMemberships || []).find((m) => m.groupId === groupId);
      if (!membership) {
        return res.status(404).json({ success: false, error: 'Not a member of this group' });
      }
      const cleanTag = String(tag || '').trim().slice(0, 60);
      const { payload, signature } = signWithMembership(membership, {
        action: 'mentor-optin',
        groupId,
        pairwiseId: membership.pairwiseId,
        mentor: !!mentor,
        tag: cleanTag,
        ts: new Date().toISOString()
      });
      const r = await fetch(`${registryBase(membership)}/api/groups/${encodeURIComponent(groupId)}/mentor-optin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairwiseId: membership.pairwiseId, payload, signature })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.success) {
        return res.status(502).json({ success: false, error: data.error || 'Registry rejected the mentor update' });
      }
      membership.mentor = !!mentor;
      membership.mentorTag = cleanTag;
      userDoc.updatedAt = new Date().toISOString();
      await cloudant.saveDocument(USERS_DB, userDoc);
      auditLog.logEvent({
        type: 'user_group_mentor_optin',
        userId,
        ip: req.ip,
        details: { groupId, mentor: !!mentor, tag: cleanTag }
      });
      res.json({ success: true, mentor: !!mentor, tag: cleanTag });
    } catch (error) {
      console.error('[user-groups] mentor opt-in failed:', error);
      res.status(500).json({ success: false, error: 'Failed to update mentor listing' });
    }
  });

  // POST /api/user-groups/message-prefs — the member's side of the
  // "Everyone in the group messages" switch (default ON). Signs the
  // claim, updates the registry, mirrors the flag locally.
  app.post('/api/user-groups/message-prefs', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const { groupId, everyone } = req.body || {};
      if (!groupId) {
        return res.status(400).json({ success: false, error: 'groupId is required' });
      }
      const userDoc = await cloudant.getDocument(USERS_DB, userId);
      const membership = (userDoc?.groupMemberships || []).find((m) => m.groupId === groupId);
      if (!membership) {
        return res.status(404).json({ success: false, error: 'Not a member of this group' });
      }
      const { payload, signature } = signWithMembership(membership, {
        action: 'message-prefs',
        groupId,
        pairwiseId: membership.pairwiseId,
        everyone: everyone !== false,
        ts: new Date().toISOString()
      });
      const r = await fetch(`${registryBase(membership)}/api/groups/${encodeURIComponent(groupId)}/message-prefs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairwiseId: membership.pairwiseId, payload, signature })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.success) {
        return res.status(502).json({ success: false, error: data.error || 'Registry rejected the preference update' });
      }
      membership.broadcastMessages = everyone !== false;
      userDoc.updatedAt = new Date().toISOString();
      await cloudant.saveDocument(USERS_DB, userDoc);
      auditLog.logEvent({
        type: 'user_group_message_prefs',
        userId,
        ip: req.ip,
        details: { groupId, everyone: everyone !== false }
      });
      res.json({ success: true, everyone: everyone !== false });
    } catch (error) {
      console.error('[user-groups] message-prefs failed:', error);
      res.status(500).json({ success: false, error: 'Failed to update message preferences' });
    }
  });

  // POST /api/user-groups/import-suggested-policies — pull a group's
  // suggested sharing policies into the user's OWN list while a join is
  // still pending, so the normal Sharing Policies editor shows them in
  // canonical form (real toggles, real edit) BEFORE the user commits.
  // Server-fetches the registry payload (never trusts client-supplied
  // cards) and reuses the same skip-if-present import the join paths
  // use, so joining afterwards never duplicates or clobbers edits.
  app.post('/api/user-groups/import-suggested-policies', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const { groupId, token, registryUrl, kind } = req.body || {};
      const base = safeRegistryBase(registryUrl || `http://localhost:${process.env.PORT || 3001}`);
      if (!groupId || !token || !base) {
        return res.status(400).json({ success: false, error: 'groupId, token and a valid registryUrl are required' });
      }
      const info = kind === 'invite' ? 'invite-info' : 'join-info';
      const r = await fetch(`${base}/api/groups/${encodeURIComponent(groupId)}/${info}?token=${encodeURIComponent(token)}`);
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.success) {
        return res.status(502).json({ success: false, error: data.error || 'Registry unavailable' });
      }
      const tokenValid = kind === 'invite' ? data.invite?.valid !== false : data.valid !== false;
      if (!tokenValid) {
        return res.status(410).json({ success: false, error: 'This invitation is no longer valid' });
      }
      const cards = (data.group?.suggestedPolicies || []).map((c) => normalizeCard(c)).filter(Boolean);
      const userDoc = await cloudant.getDocument(USERS_DB, userId);
      if (!userDoc) return res.status(404).json({ success: false, error: 'User not found' });
      const before = (userDoc.sharingPolicies || []).length;
      importSuggestedPolicies(userDoc, groupId, cards);
      const imported = (userDoc.sharingPolicies || []).length - before;
      if (imported > 0) {
        userDoc.updatedAt = new Date().toISOString();
        await cloudant.saveDocument(USERS_DB, userDoc);
        auditLog.logEvent({
          type: 'suggested_policies_previewed',
          userId,
          ip: req.ip,
          details: { groupId, imported }
        });
      }
      res.json({ success: true, imported, groupName: data.group?.name || null });
    } catch (error) {
      console.error('[user-groups] import-suggested failed:', error);
      res.status(500).json({ success: false, error: 'Failed to import suggested policies' });
    }
  });

  // POST /api/user-groups/remove-suggested-policies — the DISMISS side:
  // the user declined the join, so the previewed cards for that group
  // leave with it.
  app.post('/api/user-groups/remove-suggested-policies', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const { groupId } = req.body || {};
      if (!groupId) return res.status(400).json({ success: false, error: 'groupId is required' });
      const userDoc = await cloudant.getDocument(USERS_DB, userId);
      if (!userDoc) return res.status(404).json({ success: false, error: 'User not found' });
      // Never remove cards for a group the user actually belongs to.
      if ((userDoc.groupMemberships || []).some((m) => m.groupId === groupId)) {
        return res.status(409).json({ success: false, error: 'You are a member of this group' });
      }
      const prov = `group:${groupId}`;
      const before = (userDoc.sharingPolicies || []).length;
      userDoc.sharingPolicies = (userDoc.sharingPolicies || []).filter((c) => c.provenance !== prov);
      const removed = before - userDoc.sharingPolicies.length;
      if (removed > 0) {
        userDoc.updatedAt = new Date().toISOString();
        await cloudant.saveDocument(USERS_DB, userDoc);
      }
      res.json({ success: true, removed });
    } catch (error) {
      console.error('[user-groups] remove-suggested failed:', error);
      res.status(500).json({ success: false, error: 'Failed to remove suggested policies' });
    }
  });

  // POST /api/user-groups/alias — the member's side of a display-name
  // change: sign, update the registry, mirror locally.
  app.post('/api/user-groups/alias', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const { groupId, alias } = req.body || {};
      const cleanAlias = String(alias || '').trim().slice(0, 40);
      if (!groupId || !cleanAlias) {
        return res.status(400).json({ success: false, error: 'groupId and a display name are required' });
      }
      const userDoc = await cloudant.getDocument(USERS_DB, userId);
      const membership = (userDoc?.groupMemberships || []).find((m) => m.groupId === groupId);
      if (!membership) {
        return res.status(404).json({ success: false, error: 'Not a member of this group' });
      }
      const { payload, signature } = signWithMembership(membership, {
        action: 'alias-change',
        groupId,
        pairwiseId: membership.pairwiseId,
        alias: cleanAlias,
        ts: new Date().toISOString()
      });
      const r = await fetch(`${registryBase(membership)}/api/groups/${encodeURIComponent(groupId)}/alias-change`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairwiseId: membership.pairwiseId, payload, signature })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.success) {
        return res.status(502).json({ success: false, error: data.error || 'Registry rejected the name change' });
      }
      membership.alias = data.alias;
      userDoc.updatedAt = new Date().toISOString();
      await cloudant.saveDocument(USERS_DB, userDoc);
      auditLog.logEvent({
        type: 'user_group_alias_changed',
        userId,
        ip: req.ip,
        details: { groupId, alias: data.alias }
      });
      res.json({ success: true, alias: data.alias });
    } catch (error) {
      console.error('[user-groups] alias change failed:', error);
      res.status(500).json({ success: false, error: 'Failed to change display name' });
    }
  });

  // ── PR-3: relay + heartbeat (member side) ──────────────────────────

  const signWithMembership = (membership, claimObj) => {
    const payload = JSON.stringify(claimObj);
    const priv = createPrivateKey({ key: membership.signingKeyPair.privateKeyJwk, format: 'jwk' });
    const signature = edSign(null, Buffer.from(payload), priv).toString('base64url');
    return { payload, signature };
  };

  const registryBase = (membership) =>
    String(membership.registryUrl || `http://localhost:${process.env.PORT || 3001}`).replace(/\/$/, '');

  /**
   * Refresh one membership against its registry: renew the credential,
   * pull + decrypt any pending messages into the membership inbox, ack
   * them, and report whether the membership was revoked. Mutates the
   * passed membership object; caller persists the userDoc. Returns
   * { revoked, newMessages }.
   */
  /** Best-effort alias lookup for a fellow member via the registry's
   *  signed member-key endpoint (which already returns alias alongside
   *  the encryption key). Used to label inbound messages/requests with
   *  the sender's display name. Returns null on any failure — a missing
   *  alias never blocks message ingest. `cache` deduplicates lookups
   *  within one refresh pass. */
  const lookupMemberAlias = async (membership, pairwiseId, cache) => {
    if (cache && cache.has(pairwiseId)) return cache.get(pairwiseId);
    let alias = null;
    try {
      const kq = signWithMembership(membership, {
        action: 'member-key', groupId: membership.groupId, caller: membership.pairwiseId, ts: new Date().toISOString()
      });
      const r = await fetch(
        `${registryBase(membership)}/api/groups/${encodeURIComponent(membership.groupId)}/member-key/${encodeURIComponent(pairwiseId)}` +
        `?caller=${encodeURIComponent(membership.pairwiseId)}&payload=${encodeURIComponent(kq.payload)}&signature=${encodeURIComponent(kq.signature)}`
      );
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.success) alias = d.alias || null;
    } catch { /* offline registry / departed member — no alias */ }
    if (cache) cache.set(pairwiseId, alias);
    return alias;
  };

  const refreshMembership = async (membership) => {
    const { payload, signature } = signWithMembership(membership, {
      action: 'refresh',
      groupId: membership.groupId,
      pairwiseId: membership.pairwiseId,
      ts: new Date().toISOString()
    });
    // Ack messages we already stored last time (delivered) — including
    // AS-request envelopes, which never enter the inbox: without acking
    // their relay ids too, every refresh would re-pull and re-ingest the
    // same request as a fresh duplicate.
    const ackMessageIds = [
      ...(membership.inbox || []).map((msg) => msg.id),
      ...(membership.seenRequestRelayIds || [])
    ].filter(Boolean);
    const res = await fetch(`${registryBase(membership)}/api/groups/${encodeURIComponent(membership.groupId)}/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairwiseId: membership.pairwiseId, payload, signature, ackMessageIds })
    });
    const data = await res.json().catch(() => ({}));
    // Group deleted at the registry (404): treat exactly like a revoked
    // membership so the member's userDoc cleans itself up on the next
    // refresh instead of erroring forever against a missing group.
    if (res.status === 404) return { revoked: true, newMessages: 0, asRequests: [] };
    if (!res.ok || !data.success) {
      throw new Error(data.error || `Registry refresh failed (HTTP ${res.status})`);
    }
    if (data.revoked) return { revoked: true, newMessages: 0, asRequests: [] };

    if (data.credential) membership.credential = data.credential;
    membership.lastRefreshAt = new Date().toISOString();

    // Decrypt newly-pulled messages. Two kinds share the relay transport:
    // plain member-to-member messages (stored in the inbox) and AS requests
    // (an envelope the caller routes to maia_as_requests — PR-4). The kind
    // is inside the SEALED payload, so the relay never sees which is which.
    const existingIds = new Set((membership.inbox || []).map((m) => m.id));
    const seenRequestIds = new Set(membership.seenRequestRelayIds || []);
    let added = 0;
    const asRequests = [];
    // One alias lookup per unique sender per refresh (best-effort).
    const aliasCache = new Map();
    for (const m of data.messages || []) {
      if (existingIds.has(m.id) || seenRequestIds.has(m.id)) continue;
      let text = null;
      try {
        text = openFrom(membership.encryptionKeyPair.privateKeyJwk, m.box);
      } catch {
        text = null; // undecryptable — skip rather than store garbage
      }
      if (text == null) continue;

      // AS request envelope? (sealed JSON with maiaType === 'as-request')
      // Broadcast envelope? ('broadcast' — an Everyone message)
      let envelope = null;
      let broadcast = null;
      try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.maiaType === 'as-request') envelope = parsed;
        else if (parsed && parsed.maiaType === 'broadcast' && typeof parsed.text === 'string') broadcast = parsed;
      } catch { /* plain text message */ }

      // Outsider requests (W3) are sealed by the REGISTRY itself under a
      // reserved 'outsider:' sender id (members can never push under one:
      // the relay endpoint verifies the sender's signed member claim), so
      // the prefix is proof the request came from outside the group.
      const isOutsider = String(m.fromPairwiseId || '').startsWith('outsider:');
      const fromAlias = isOutsider
        ? (envelope?.payload?.requester?.name ? `${envelope.payload.requester.name} — outside the group` : 'Outside requester')
        : await lookupMemberAlias(membership, m.fromPairwiseId, aliasCache);

      if (envelope) {
        asRequests.push({
          relayId: m.id,
          fromPairwiseId: m.fromPairwiseId,
          fromAlias,
          fromOutsider: isOutsider,
          receivedAt: m.createdAt,
          action: String(envelope.action || 'message'),
          purpose: POLICY_PURPOSES.includes(envelope.purpose) ? envelope.purpose : 'any',
          resource: String(envelope.resource || ''),
          computationClass: envelope.computationClass || null,
          payment: envelope.payment || null, // §3.4 — credits the registry attested it collected
          nonce: envelope.nonce || null,
          created: envelope.created || null,
          // Verified signature strength the REGISTRY established at delivery
          // (email-verify token → 'verified-email'; passkey-proven vouch →
          // 'verified-by-me'), and any autonomous decision the member's own
          // policies already made there.
          signature: ['verified-email', 'verified-by-me'].includes(envelope.signature) ? envelope.signature : null,
          autoDecision: (envelope.autoDecision && ['accepted', 'declined'].includes(envelope.autoDecision.outcome))
            ? { outcome: envelope.autoDecision.outcome, sentence: String(envelope.autoDecision.sentence || '') }
            : null,
          payload: envelope.payload ?? null
        });
        // Remember the relay id so the next refresh ACKs it (deleting it
        // at the relay) instead of re-ingesting a duplicate. Capped FIFO.
        membership.seenRequestRelayIds = [...(membership.seenRequestRelayIds || []), m.id].slice(-500);
        added++;
        continue;
      }

      membership.inbox = membership.inbox || [];
      membership.inbox.push({
        id: m.id, fromPairwiseId: m.fromPairwiseId, fromAlias,
        text: broadcast ? broadcast.text : text,
        ...(broadcast ? { broadcast: true } : {}),
        receivedAt: m.createdAt
      });
      added++;
    }
    // Cap inbox size (oldest dropped).
    if (membership.inbox && membership.inbox.length > INBOX_MAX) {
      membership.inbox = membership.inbox.slice(-INBOX_MAX);
    }
    return { revoked: false, newMessages: added, asRequests };
  };

  // POST /api/user-groups/refresh — refresh all of a user's memberships
  // (also invoked by the daily cron). Drops any membership the registry
  // reports revoked.
  app.post('/api/user-groups/refresh', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const userDoc = await cloudant.getDocument(USERS_DB, userId);
      if (!userDoc) return res.status(404).json({ success: false, error: 'User not found' });
      const result = await refreshUserMemberships(userDoc);
      if (result.changed) await cloudant.saveDocument(USERS_DB, userDoc);
      res.json({ success: true, ...result.summary });
    } catch (error) {
      console.error('[user-groups] refresh failed:', error);
      res.status(500).json({ success: false, error: 'Failed to refresh memberships' });
    }
  });

  /** Look up the recipient's encryption key (signed), seal `plaintext` to
   *  it, and relay. Shared by plain messages (/send) and AS requests
   *  (/request). Returns { ok } or { ok:false, status, error }. */
  const deliverSealed = async (membership, toPairwiseId, plaintext, { suppressNotify = false } = {}) => {
    const base = registryBase(membership);
    const kq = signWithMembership(membership, {
      action: 'member-key', groupId: membership.groupId, caller: membership.pairwiseId, ts: new Date().toISOString()
    });
    const keyRes = await fetch(
      `${base}/api/groups/${encodeURIComponent(membership.groupId)}/member-key/${encodeURIComponent(toPairwiseId)}` +
      `?caller=${encodeURIComponent(membership.pairwiseId)}&payload=${encodeURIComponent(kq.payload)}&signature=${encodeURIComponent(kq.signature)}`
    );
    const keyData = await keyRes.json().catch(() => ({}));
    if (!keyRes.ok || !keyData.success) {
      return { ok: false, status: keyRes.status === 404 ? 404 : 502, error: keyData.error || 'Recipient not found' };
    }
    const box = sealTo(keyData.encryptionPublicKeyJwk, plaintext);
    const rq = signWithMembership(membership, {
      action: 'relay', groupId: membership.groupId, fromPairwiseId: membership.pairwiseId, toPairwiseId, ts: new Date().toISOString()
    });
    const relayRes = await fetch(`${base}/api/groups/${encodeURIComponent(membership.groupId)}/relay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromPairwiseId: membership.pairwiseId, toPairwiseId, box, payload: rq.payload, signature: rq.signature, ...(suppressNotify ? { suppressNotify: true } : {}) })
    });
    const relayData = await relayRes.json().catch(() => ({}));
    if (!relayRes.ok || !relayData.success) {
      return { ok: false, status: 502, error: relayData.error || 'Relay failed' };
    }
    return { ok: true, toAlias: keyData.alias || null };
  };

  /** Fan a plain message out to every member who accepts Everyone
   *  messages. Sealed per recipient with their own key — the "Everyone"
   *  destination weakens nothing cryptographically. */
  const deliverBroadcast = async (membership, plaintext) => {
    const base = registryBase(membership);
    const kq = signWithMembership(membership, {
      action: 'broadcast-keys', groupId: membership.groupId, pairwiseId: membership.pairwiseId, ts: new Date().toISOString()
    });
    const keyRes = await fetch(`${base}/api/groups/${encodeURIComponent(membership.groupId)}/broadcast-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairwiseId: membership.pairwiseId, payload: kq.payload, signature: kq.signature })
    });
    const keyData = await keyRes.json().catch(() => ({}));
    if (!keyRes.ok || !keyData.success) {
      return { ok: false, status: 502, error: keyData.error || 'Could not fetch group keys' };
    }
    const envelope = JSON.stringify({ maiaType: 'broadcast', text: plaintext });
    let recipients = 0;
    for (const r of keyData.recipients || []) {
      try {
        const box = sealTo(r.encryptionPublicKeyJwk, envelope);
        const rq = signWithMembership(membership, {
          action: 'relay', groupId: membership.groupId, fromPairwiseId: membership.pairwiseId, toPairwiseId: r.pairwiseId, ts: new Date().toISOString()
        });
        const relayRes = await fetch(`${base}/api/groups/${encodeURIComponent(membership.groupId)}/relay`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fromPairwiseId: membership.pairwiseId, toPairwiseId: r.pairwiseId, box, payload: rq.payload, signature: rq.signature })
        });
        const relayData = await relayRes.json().catch(() => ({}));
        if (relayRes.ok && relayData.success) recipients++;
      } catch { /* skip this recipient; count reflects reality */ }
    }
    return { ok: true, recipients };
  };

  // POST /api/user-groups/send — seal a plain message to another member and
  // relay it. Reply-to-sender needs no directory.
  app.post('/api/user-groups/send', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const { groupId, toPairwiseId, text } = req.body || {};
      if (!groupId || !toPairwiseId || !text || !String(text).trim()) {
        return res.status(400).json({ success: false, error: 'groupId, toPairwiseId and text are required' });
      }
      const userDoc = await cloudant.getDocument(USERS_DB, userId);
      const membership = (userDoc?.groupMemberships || []).find((m) => m.groupId === groupId);
      if (!membership) return res.status(404).json({ success: false, error: 'Not a member of this group' });
      let result;
      if (toPairwiseId === '@everyone') {
        // Everyone (like a Zoom conference): fetch the sealing keys of all
        // members who accept broadcasts, then seal + relay INDIVIDUALLY to
        // each — E2E holds; the relay still never reads a byte.
        result = await deliverBroadcast(membership, String(text));
      } else {
        result = await deliverSealed(membership, toPairwiseId, String(text));
      }
      if (!result.ok) return res.status(result.status).json({ success: false, error: result.error });
      // Record the sent message locally (userDoc only — never the registry)
      // so the Groups conversation view can show both sides of a thread.
      const sent = {
        id: `out_${Date.now()}_${randomBytes(4).toString('hex')}`,
        toPairwiseId,
        toAlias: toPairwiseId === '@everyone' ? 'Everyone' : (result.toAlias || null),
        text: String(text),
        sentAt: new Date().toISOString(),
        ...(toPairwiseId === '@everyone' ? { recipients: result.recipients } : {})
      };
      // The message is already delivered — recording it locally must never
      // turn a delivered message into a user-facing "Failed to send". With
      // several tabs open, their polling writes race this one on the
      // userDoc; retry once on conflict with a fresh doc, then degrade to
      // success-without-record.
      try {
        membership.outbox = [...(membership.outbox || []), sent].slice(-OUTBOX_MAX);
        userDoc.updatedAt = new Date().toISOString();
        await cloudant.saveDocument(USERS_DB, userDoc);
      } catch (e) {
        try {
          const fresh = await cloudant.getDocument(USERS_DB, userId);
          const fm = (fresh?.groupMemberships || []).find((m) => m.groupId === groupId);
          if (fm) {
            fm.outbox = [...(fm.outbox || []), sent].slice(-OUTBOX_MAX);
            fresh.updatedAt = new Date().toISOString();
            await cloudant.saveDocument(USERS_DB, fresh);
          }
        } catch (e2) {
          console.warn('[user-groups] outbox record failed (message WAS delivered):', e2?.message || e2);
        }
      }
      auditLog.logEvent({ type: 'user_group_message_sent', userId, ip: req.ip, details: { groupId, toPairwiseId } });
      res.json({ success: true, sent });
    } catch (error) {
      console.error('[user-groups] send failed:', error);
      res.status(500).json({ success: false, error: 'Failed to send message' });
    }
  });

  // POST /api/user-groups/request — send an AS request (an envelope, not a
  // plain message) to another member. Delivered via the relay; the
  // recipient's MAIA routes it to maia_as_requests on refresh (Phase-1
  // "escalate everything"). The envelope carries the reserved
  // computationClass + payment slots (§3.4) for later phases.
  app.post('/api/user-groups/request', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const { groupId, toPairwiseId, action, resource, payload } = req.body || {};
      if (!groupId || !toPairwiseId) {
        return res.status(400).json({ success: false, error: 'groupId and toPairwiseId are required' });
      }
      const userDoc = await cloudant.getDocument(USERS_DB, userId);
      const membership = (userDoc?.groupMemberships || []).find((m) => m.groupId === groupId);
      if (!membership) return res.status(404).json({ success: false, error: 'Not a member of this group' });
      const envelope = JSON.stringify({
        maiaType: 'as-request',
        action: String(action || 'relay-message'),
        resource: String(resource || 'inbox'),
        purpose: POLICY_PURPOSES.includes(req.body?.purpose) ? req.body.purpose : 'any',
        computationClass: 'answer-from-record', // §3.4 action ladder (Phase 1 floor)
        payment: null, // §3.4 reserved payment slot; unused in Phase 1
        nonce: randomBytes(8).toString('hex'),
        created: new Date().toISOString(),
        payload: payload ?? null
      });
      // Same-host precheck BEFORE delivery: only when the recipient's MAIA
      // lives on THIS server can the immediate ingest below send them the
      // request-specific email — and only then is the registry's generic
      // nudge redundant. A CROSS-HOST recipient keeps the nudge: their own
      // host can't ingest until their next pull, and the registry may be
      // exactly the host that knows their address.
      let recipDoc = null;
      try {
        const rr = await cloudant.findDocuments(USERS_DB, {
          selector: { groupMemberships: { $elemMatch: { groupId: { $eq: groupId }, pairwiseId: { $eq: toPairwiseId } } } },
          limit: 1
        });
        recipDoc = rr?.docs?.[0] || null;
      } catch { /* treat as cross-host — the nudge stays on */ }
      const result = await deliverSealed(membership, toPairwiseId, envelope, { suppressNotify: !!recipDoc });
      if (!result.ok) return res.status(result.status).json({ success: false, error: result.error });
      auditLog.logEvent({ type: 'user_group_request_sent', userId, ip: req.ip, details: { groupId, toPairwiseId, action } });
      // Phase 1 same-host shortcut: pull + ingest the recipient's mail NOW
      // instead of waiting for their next login or the daily cron. Their
      // sharing policies answer autonomously (and email this requester)
      // even while they are offline; an ASK emails them the
      // review-and-respond notification immediately. Best-effort: on any
      // failure the request simply waits in the relay for the recipient's
      // normal refresh, exactly as before.
      if (recipDoc) {
        try {
          const r = await refreshUserMemberships(recipDoc);
          if (r.changed) await cloudant.saveDocument(USERS_DB, recipDoc);
        } catch (e) {
          console.warn('[user-groups] delivery-time ingest failed (recipient pulls later):', e?.message || e);
        }
      }
      res.json({ success: true });
    } catch (error) {
      console.error('[user-groups] request failed:', error);
      res.status(500).json({ success: false, error: 'Failed to send request' });
    }
  });

  // GET /api/user-groups/requests?userId= — the patient's AS request inbox.
  app.get('/api/user-groups/requests', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const all = await cloudant.getAllDocuments(AS_REQUESTS_DB);
      const requests = (all || [])
        .filter((r) => r && r.type === 'as_request' && r.userId === userId)
        .sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)))
        .map((r) => ({
          id: r._id,
          groupId: r.groupId,
          groupName: r.groupName,
          fromPairwiseId: r.fromPairwiseId,
          fromAlias: r.fromAlias || null,
          fromOutsider: !!r.fromOutsider,
          requester: r.requester || null,
          action: r.action,
          purpose: r.purpose || 'any',
          decidedBySentence: r.decidedBySentence || null,
          decidedAt: r.decidedAt || null,
          autonomous: !!r.autonomous,
          resource: r.resource,
          payload: r.payload,
          receivedAt: r.receivedAt,
          status: r.status,
          aiSummary: r.aiSummary || null
        }));
      res.json({ success: true, requests });
    } catch (error) {
      console.error('[user-groups] requests list failed:', error);
      res.status(500).json({ success: false, error: 'Failed to load requests' });
    }
  });

  // GET /api/user-groups/alerts?userId= — lightweight counts that feed the
  // Groups rail-icon indicator (the blue triangle) so the UI can flag
  // "something is waiting for you in Groups" without opening the tab:
  //   - pendingRequests: first-contact AS requests still awaiting a decision
  //   - messageCount:    total decrypted peer messages across memberships
  // (Pending invitations are a client-side signal — localStorage — so they
  // are not included here.) Cheap: one AS_REQUESTS scan + one userDoc read.
  app.get('/api/user-groups/alerts', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const all = await cloudant.getAllDocuments(AS_REQUESTS_DB);
      const pendingRequests = (all || []).filter(
        (r) => r && r.type === 'as_request' && r.userId === userId && r.status === 'pending'
      ).length;
      const userDoc = await cloudant.getDocument(USERS_DB, userId);
      const messageCount = (userDoc?.groupMemberships || []).reduce(
        (n, m) => n + ((m.inbox || []).length), 0
      );
      res.json({ success: true, pendingRequests, messageCount });
    } catch (error) {
      console.error('[user-groups] alerts failed:', error);
      res.status(500).json({ success: false, error: 'Failed to load alerts' });
    }
  });

  // POST /api/user-groups/requests/:id/decision — accept / decline / block.
  // Writes the Phase-1 policy facts (§6.2): accept adds the sender to the
  // membership's acceptedSenders; block adds to blockedSenders (future
  // requests from them are spam-dropped on ingest). Cedar replaces these
  // lists with real policies in Phase 2.
  app.post('/api/user-groups/requests/:id/decision', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const { decision } = req.body || {};
      if (!['accept', 'decline', 'block'].includes(decision)) {
        return res.status(400).json({ success: false, error: 'decision must be accept, decline or block' });
      }
      const reqDoc = await cloudant.getDocument(AS_REQUESTS_DB, req.params.id);
      if (!reqDoc || reqDoc.type !== 'as_request' || reqDoc.userId !== userId) {
        return res.status(404).json({ success: false, error: 'Request not found' });
      }
      reqDoc.status = decision === 'accept' ? 'accepted' : decision === 'block' ? 'blocked' : 'declined';
      reqDoc.decidedAt = new Date().toISOString();
      await cloudant.saveDocument(AS_REQUESTS_DB, reqDoc);

      if (decision === 'accept' || decision === 'block') {
        const userDoc = await cloudant.getDocument(USERS_DB, userId);
        const membership = (userDoc?.groupMemberships || []).find((m) => m.groupId === reqDoc.groupId);
        if (membership) {
          const list = decision === 'accept' ? 'acceptedSenders' : 'blockedSenders';
          membership[list] = Array.from(new Set([...(membership[list] || []), reqDoc.fromPairwiseId]));
          userDoc.updatedAt = new Date().toISOString();
          await cloudant.saveDocument(USERS_DB, userDoc);
        }
      }

      // Close the AS loop (backlog #3): when the patient ACCEPTS or DECLINES an
      // OUTSIDE requester's request, email them the outcome (plus any note the
      // patient added) and LOG the response. 'block' stays silent — a spam drop
      // gets no reply. A policy-level silent deny never reaches here at all.
      const responseMessage = String(req.body?.responseMessage || '').trim().slice(0, 2000);
      if (reqDoc.fromOutsider && reqDoc.requester?.email && decision !== 'block') {
        const outcome = decision === 'accept' ? 'accepted' : 'declined';
        // Phase 4 (PS/CM redesign): accepting a patient-summary request sends
        // the PRIVACY-FILTERED Patient Summary by default — the artifact that
        // is auto-refreshed at every Verify/Edit. Only the filtered copy ever
        // leaves; if none exists (summary never verified), nothing is attached
        // and the email says the member may follow up directly.
        let filteredSummaryText = '';
        if (outcome === 'accepted' && reqDoc.resource === 'patient-summary') {
          try {
            const ownerDoc = await cloudant.getDocument(USERS_DB, userId);
            filteredSummaryText = String(ownerDoc?.privacyFilteredSummary?.text || '').trim();
          } catch { /* no filtered summary — fall back to plain accept email */ }
        }
        if (typeof sendEmail === 'function') {
          try {
            const appUrl = (process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
            await sendEmail(
              reqDoc.requester.email,
              `Your MAIA request was ${outcome}`,
              [
                `A member of the "${reqDoc.groupName}" group ${outcome} your request.`,
                responseMessage ? `\nTheir message:\n${responseMessage}` : '',
                '',
                outcome === 'accepted'
                  ? (filteredSummaryText
                      ? 'Their privacy-filtered Patient Summary is below.'
                      : 'They may follow up with the information directly.')
                  : 'You can refine your request and try again.',
                filteredSummaryText ? `\n--- Privacy-filtered Patient Summary ---\n${filteredSummaryText}` : '',
                appUrl ? `\n${appUrl}` : ''
              ].filter(Boolean).join('\n')
            );
          } catch (e) {
            console.warn('[as-requests] requester notify failed:', e?.message || e);
          }
        }
        auditLog.logEvent({
          type: 'as_request_responded',
          userId,
          ip: req.ip,
          details: { requestId: reqDoc._id, groupId: reqDoc.groupId, outcome, hadMessage: !!responseMessage, sharedFilteredSummary: !!filteredSummaryText }
        });
        // Bump the public response tally (counts only) so the requester's page
        // can show how many members responded. Same-host in Phase 1; a
        // cross-host tally simply isn't found and is skipped. Conflict-tolerant.
        if (reqDoc.nonce) {
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const tally = await cloudant.getDocument(RELAY_DB, `outreq_${reqDoc.nonce}`);
              if (!tally || tally.type !== 'outside_request_tally') break;
              tally.responded = (tally.responded || 0) + 1;
              if (outcome === 'accepted') tally.accepted = (tally.accepted || 0) + 1;
              else tally.declined = (tally.declined || 0) + 1;
              await settleTallyPayment(tally, outcome);
              await cloudant.saveDocument(RELAY_DB, tally);
              break;
            } catch (e) {
              if (e?.statusCode === 409 && attempt < 2) continue;
              console.warn('[as-requests] tally bump failed:', e?.message || e);
              break;
            }
          }
        }
      }

      res.json({ success: true, status: reqDoc.status });
    } catch (error) {
      console.error('[user-groups] decision failed:', error);
      res.status(500).json({ success: false, error: 'Failed to record decision' });
    }
  });

  // GET /api/user-groups/messages?userId=&groupId= — decrypted inbox for a
  // membership (stored on the userDoc; populated by refresh).
  app.get('/api/user-groups/messages', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const userDoc = await cloudant.getDocument(USERS_DB, userId);
      const membership = (userDoc?.groupMemberships || []).find((m) => m.groupId === req.query.groupId);
      if (!membership) return res.status(404).json({ success: false, error: 'Not a member of this group' });
      // `messages` = received (inbox); `sent` = locally-recorded outbox so
      // the client can render a two-sided conversation thread.
      res.json({ success: true, messages: membership.inbox || [], sent: membership.outbox || [] });
    } catch (error) {
      console.error('[user-groups] messages failed:', error);
      res.status(500).json({ success: false, error: 'Failed to load messages' });
    }
  });

  // GET /api/user-groups/directory?userId=&groupId= — the member's view of
  // their group: aggregate liquidity + the discoverable mentors they can
  // reach for first contact. Signs a directory claim and calls the registry.
  app.get('/api/user-groups/directory', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const userDoc = await cloudant.getDocument(USERS_DB, userId);
      const membership = (userDoc?.groupMemberships || []).find((m) => m.groupId === req.query.groupId);
      if (!membership) return res.status(404).json({ success: false, error: 'Not a member of this group' });
      const { payload, signature } = signWithMembership(membership, {
        action: 'directory', groupId: membership.groupId, caller: membership.pairwiseId, ts: new Date().toISOString()
      });
      const base = registryBase(membership);
      const r = await fetch(
        `${base}/api/groups/${encodeURIComponent(membership.groupId)}/directory` +
        `?caller=${encodeURIComponent(membership.pairwiseId)}&payload=${encodeURIComponent(payload)}&signature=${encodeURIComponent(signature)}`
      );
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.success) {
        return res.status(502).json({ success: false, error: data.error || 'Directory unavailable' });
      }
      res.json({ success: true, stats: data.stats, postingPolicy: data.postingPolicy || '', mentors: data.mentors || [] });
    } catch (error) {
      console.error('[user-groups] directory failed:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch directory' });
    }
  });

  // ── Member-side vouch management ("People I vouch for") ─────────────
  // The patient mints the one-time code HERE (their own host), registers
  // only its HASH at the group registry via a signed member claim, and
  // keeps the custodial list — label included — on their own userDoc.
  // The registry never learns who the code is for.

  // POST /api/user-groups/vouch — mint a code for someone the patient has
  // personally matched out-of-band. Returns the code ONCE; never stored
  // in plaintext anywhere.
  app.post('/api/user-groups/vouch', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const { groupId, label } = req.body || {};
      const cleanLabel = String(label || '').trim().slice(0, 80);
      if (!groupId || !cleanLabel) {
        return res.status(400).json({ success: false, error: 'A group and a label (who this is for) are required' });
      }
      const userDoc = await cloudant.getDocument(USERS_DB, userId);
      const membership = (userDoc?.groupMemberships || []).find((m) => m.groupId === groupId);
      if (!membership) return res.status(404).json({ success: false, error: 'Not a member of this group' });
      if ((userDoc.vouchedParties || []).filter((v) => v.status !== 'revoked').length >= 100) {
        return res.status(409).json({ success: false, error: 'Vouch list is full — revoke unused entries first' });
      }
      const code = vouchCode();
      const codeHash = sha256hex(code);
      const codeExpiresAt = new Date(Date.now() + VOUCH_CODE_TTL_MS).toISOString();
      const { payload, signature } = signWithMembership(membership, {
        action: 'vouch-create', groupId, caller: membership.pairwiseId,
        codeHash, codeExpiresAt, ts: new Date().toISOString()
      });
      const r = await fetch(`${registryBase(membership)}/api/groups/${encodeURIComponent(groupId)}/vouches`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caller: membership.pairwiseId, payload, signature })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.success) {
        return res.status(502).json({ success: false, error: data.error || 'The group registry could not register the code' });
      }
      userDoc.vouchedParties = [...(userDoc.vouchedParties || []), {
        vouchId: data.vouchId, label: cleanLabel,
        groupId, groupName: membership.groupName || groupId,
        createdAt: new Date().toISOString(), codeExpiresAt,
        status: 'code-issued'
      }];
      userDoc.updatedAt = new Date().toISOString();
      await cloudant.saveDocument(USERS_DB, userDoc);
      auditLog.logEvent({
        type: 'vouch_created', userId, ip: req.ip,
        details: { groupId, vouchId: data.vouchId, label: cleanLabel }
      });
      res.json({ success: true, code, expiresAt: codeExpiresAt, vouchId: data.vouchId });
    } catch (error) {
      console.error('[user-groups] vouch mint failed:', error);
      res.status(500).json({ success: false, error: 'Failed to create vouch code' });
    }
  });

  // GET /api/user-groups/vouches?userId= — the custodial list, refreshed
  // best-effort against each group's registry (redeemed/revoked state).
  app.get('/api/user-groups/vouches', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const userDoc = await cloudant.getDocument(USERS_DB, userId);
      const entries = userDoc?.vouchedParties || [];
      const byGroup = new Map();
      for (const e of entries) {
        if (!byGroup.has(e.groupId)) byGroup.set(e.groupId, []);
        byGroup.get(e.groupId).push(e);
      }
      let changed = false;
      for (const [groupId, groupEntries] of byGroup) {
        const membership = (userDoc.groupMemberships || []).find((m) => m.groupId === groupId);
        if (!membership) continue;
        try {
          const { payload, signature } = signWithMembership(membership, {
            action: 'vouch-status', groupId, caller: membership.pairwiseId, ts: new Date().toISOString()
          });
          const r = await fetch(`${registryBase(membership)}/api/groups/${encodeURIComponent(groupId)}/vouches/status`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ caller: membership.pairwiseId, payload, signature })
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok || !data.success) continue;
          const remote = new Map((data.vouches || []).map((v) => [v.vouchId, v]));
          for (const e of groupEntries) {
            const rv = remote.get(e.vouchId);
            const next = !rv ? e.status
              : rv.revoked ? 'revoked'
              : rv.redeemed ? 'redeemed'
              : (new Date(e.codeExpiresAt).getTime() <= Date.now() ? 'code-expired' : 'code-issued');
            if (next !== e.status) { e.status = next; changed = true; }
            if (rv?.redeemedAt && !e.redeemedAt) { e.redeemedAt = rv.redeemedAt; changed = true; }
          }
        } catch { /* registry offline — show cached statuses */ }
      }
      if (changed) {
        userDoc.updatedAt = new Date().toISOString();
        try { await cloudant.saveDocument(USERS_DB, userDoc); } catch { /* best-effort cache */ }
      }
      res.json({ success: true, vouches: entries });
    } catch (error) {
      console.error('[user-groups] vouches failed:', error);
      res.status(500).json({ success: false, error: 'Failed to load vouches' });
    }
  });

  // POST /api/user-groups/vouch-revoke — one click; the registry record
  // flips and every later send re-check sees it (revocation beats any
  // still-live session token).
  app.post('/api/user-groups/vouch-revoke', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const { vouchId } = req.body || {};
      const userDoc = await cloudant.getDocument(USERS_DB, userId);
      const entry = (userDoc?.vouchedParties || []).find((v) => v.vouchId === vouchId);
      if (!entry) return res.status(404).json({ success: false, error: 'Vouch not found' });
      const membership = (userDoc.groupMemberships || []).find((m) => m.groupId === entry.groupId);
      if (!membership) return res.status(404).json({ success: false, error: 'No longer a member of that group' });
      const { payload, signature } = signWithMembership(membership, {
        action: 'vouch-revoke', groupId: entry.groupId, caller: membership.pairwiseId,
        vouchId, ts: new Date().toISOString()
      });
      const r = await fetch(`${registryBase(membership)}/api/groups/${encodeURIComponent(entry.groupId)}/vouches/revoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caller: membership.pairwiseId, payload, signature })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.success) {
        return res.status(502).json({ success: false, error: data.error || 'The group registry could not revoke' });
      }
      entry.status = 'revoked';
      entry.revokedAt = new Date().toISOString();
      userDoc.updatedAt = new Date().toISOString();
      await cloudant.saveDocument(USERS_DB, userDoc);
      auditLog.logEvent({
        type: 'vouch_revoked', userId, ip: req.ip,
        details: { groupId: entry.groupId, vouchId }
      });
      res.json({ success: true });
    } catch (error) {
      console.error('[user-groups] vouch revoke failed:', error);
      res.status(500).json({ success: false, error: 'Failed to revoke' });
    }
  });

  /**
   * Persist AS requests pulled during a refresh. Dispatch (PR-13): each
   * request is evaluated against the user's sharing-policy cards when its
   * resource maps to a policy scope — an enabled DENY match drops it
   * silently (like a blocked sender), an ALLOW match stores it
   * pre-accepted with the deciding card's sentence snapshotted for the
   * audit trail, and anything else stays 'pending' (ASK ME — the
   * escalate-everything default). Messaging requests (resource 'inbox')
   * have no policy scope and always escalate. Blocked senders drop first.
   */
  const ingestAsRequests = async (userDoc, membership, requests) => {
    let stored = 0;
    let autoAnswered = 0; // stored requests the registry already decided
    const blocked = new Set(membership.blockedSenders || []);
    for (const r of requests) {
      if (blocked.has(r.fromPairwiseId)) continue; // spam-drop

      // Policy evaluation (deterministic; the AI is never in this path).
      // Signature: 'group-member' is what the relay PROVED (signed member
      // claim); stronger levels (Doximity) arrive in a later phase.
      // Payment: the envelope's §3.4 slot carries what the REGISTRY
      // attested it collected in credits before sealing — the registry is
      // the only writer of outsider envelopes, so a member's AS on any
      // host can trust it the same way it trusts the signature level.
      let decision = { outcome: 'ask', decidedBy: null };
      if (r.autoDecision) {
        // The registry already answered this request autonomously at
        // delivery time (the member's own policies, evaluated there).
        // Store it as a record of that decision — no re-evaluation, no
        // silent drop; the requester has already been emailed.
        decision = null;
      } else if (POLICY_SCOPES.includes(r.resource)) {
        // Outsiders (W3) present no membership and no identity — UNLESS
        // the registry proved a verified email at delivery time
        // (r.signature === 'verified-email'). Either way they evaluate
        // as 'anyone'; the signature level is what their proof supports.
        decision = evaluatePolicies(userDoc.sharingPolicies || [], {
          party: r.fromOutsider
            ? { type: 'anyone' }
            : { type: 'group', groupId: membership.groupId, pairwiseId: r.fromPairwiseId },
          purpose: r.purpose || 'any',
          scope: r.resource,
          signature: r.fromOutsider
            ? (['verified-email', 'verified-by-me'].includes(r.signature) ? r.signature : 'unverified')
            : 'group-member',
          payment: Object.prototype.hasOwnProperty.call(CREDIT_PRICES, r.payment) ? r.payment : 'none'
        });
      }
      // The outside requester's stated (registry-validated when signature is
      // 'verified-email') reply address, from the sealed envelope.
      const outsiderEmail = r.fromOutsider
        && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(r.payload?.requester?.email || '').trim())
        ? String(r.payload.requester.email).trim() : '';
      let ingestDeclined = false; // deny-respond decided HERE (stored, emailed)
      let requesterNotice = null; // { to, artifact, artifactLabel } — emailed after the doc stores
      let memberReply = null; // { artifact, artifactLabel } — sealed relay reply to a member requester

      if (decision && decision.outcome === 'deny') {
        // An outsider deny-RESPOND card answers the requester right here —
        // this ingest may be the only evaluation the request ever gets when
        // the member's AS lives on a different host than the registry.
        if (r.fromOutsider && decision.decidedBy?.denyMode === 'respond' && outsiderEmail) {
          ingestDeclined = true;
          requesterNotice = { to: outsiderEmail, artifact: '', artifactLabel: '' };
        } else {
          auditLog.logEvent({
            type: 'as_request_policy_denied',
            userId: userDoc.userId,
            details: { groupId: membership.groupId, fromPairwiseId: r.fromPairwiseId, resource: r.resource, policyId: decision.decidedBy?.id || null }
          });
          continue; // silent drop — the Cedar-style forbid
        }
      }

      // Autonomous fulfilment: an ALLOW card on a data scope means this
      // member's MAIA answers the requester NOW — outside requesters get the
      // privacy-filtered artifact by email; member requesters get it by email
      // (when their account lives on this host) AND as a sealed relay reply
      // (which reaches them on ANY host, in their message thread). Only the
      // privacy-filtered artifacts ever leave; if none exists yet (summary
      // never verified) the request escalates to the human instead of
      // accepting with an empty response.
      if (decision && decision.outcome === 'allow'
          && r.resource && r.resource !== 'notification-only' && POLICY_SCOPES.includes(r.resource)) {
        const mapping = userDoc.privacyFilter?.pseudonymMapping || [];
        let artifact = '';
        let artifactLabel = '';
        if (r.resource === 'meds-allergies') {
          const meds = String(userDoc.currentMedications || '').trim();
          if (meds) { artifact = applyPseudonymMapping(mapping, meds); artifactLabel = 'privacy-filtered Current Medications'; }
        } else {
          const pf = String(userDoc.privacyFilteredSummary?.text || '').trim();
          if (pf) { artifact = pf; artifactLabel = 'privacy-filtered Patient Summary'; }
        }
        if (!artifact) {
          decision = { outcome: 'ask', decidedBy: null };
        } else if (r.fromOutsider) {
          if (outsiderEmail) requesterNotice = { to: outsiderEmail, artifact, artifactLabel };
          // No usable reply address → escalate to the human rather than
          // accept with a response nobody can receive.
          else decision = { outcome: 'ask', decidedBy: null };
        } else {
          memberReply = { artifact, artifactLabel };
          try {
            const rq = await cloudant.findDocuments(USERS_DB, {
              selector: { groupMemberships: { $elemMatch: { groupId: { $eq: membership.groupId }, pairwiseId: { $eq: r.fromPairwiseId } } } },
              limit: 1
            });
            const requester = rq?.docs?.[0];
            if (requester?.email && requester.emailVerified) {
              requesterNotice = { to: requester.email, artifact, artifactLabel };
            }
          } catch { /* cross-host requester — the relay reply still reaches them */ }
        }
      }

      const now = Date.now();
      const doc = {
        // Deterministic id (derived from the relay message id) makes ingest
        // idempotent: a concurrent refresh (the delivery-time trigger racing
        // the recipient's own client) cannot store the same request twice or
        // reset an already-made decision.
        _id: r.relayId ? `asreq_${r.relayId}` : `asreq_${now}_${randomBytes(6).toString('hex')}`,
        type: 'as_request',
        userId: userDoc.userId,
        groupId: membership.groupId,
        groupName: membership.groupName,
        toPairwiseId: membership.pairwiseId,
        fromPairwiseId: r.fromPairwiseId,
        fromAlias: r.fromAlias || null,
        fromOutsider: !!r.fromOutsider,
        requester: r.fromOutsider ? (r.payload?.requester || null) : null,
        action: r.action,
        resource: r.resource,
        purpose: r.purpose || 'any',
        computationClass: r.computationClass,
        payment: r.payment, // §3.4 — registry-attested credits payment
        payload: r.payload,
        nonce: r.nonce,
        createdAt: r.created || new Date(now).toISOString(),
        receivedAt: new Date(now).toISOString(),
        status: r.autoDecision
          ? r.autoDecision.outcome // 'accepted' | 'declined' — decided at the registry
          : (ingestDeclined ? 'declined' : (decision.outcome === 'allow' ? 'accepted' : 'pending')),
        ...(r.autoDecision ? {
          decidedBySentence: r.autoDecision.sentence || null,
          decidedAt: new Date(now).toISOString(),
          autonomous: true
        } : {}),
        ...(decision?.decidedBy ? {
          decidedByPolicyId: decision.decidedBy.id,
          decidedBySentence: policySentence(decision.decidedBy),
          decidedAt: new Date(now).toISOString()
        } : {})
      };
      // Autonomous accept also pre-accepts the sender (same fact the
      // human Accept button writes).
      if (decision?.outcome === 'allow' || r.autoDecision?.outcome === 'accepted') {
        membership.acceptedSenders = Array.from(new Set([...(membership.acceptedSenders || []), r.fromPairwiseId]));
      }
      try {
        if (r.relayId && await cloudant.getDocument(AS_REQUESTS_DB, doc._id)) {
          continue; // a concurrent refresh already ingested (and maybe decided) it
        }
        await cloudant.saveDocument(AS_REQUESTS_DB, doc);
        stored++;
        if (doc.status !== 'pending') autoAnswered++;
      } catch (e) {
        console.warn('[as-requests] store failed:', e?.message || e);
        continue;
      }
      if (requesterNotice && typeof sendEmail === 'function') {
        try {
          const appUrl = (process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
          // Outcome + artifact only — which policy card decided is the
          // responding member's own business, never the requester's.
          if (doc.status === 'declined') {
            await sendEmail(
              requesterNotice.to,
              `Your request to a "${membership.groupName}" member was declined`,
              `A member of the "${membership.groupName}" group has a sharing policy that declines your request, so their MAIA responded autonomously.`
            );
          } else {
            await sendEmail(
              requesterNotice.to,
              `A "${membership.groupName}" member's MAIA responded to your request`,
              [
                r.fromOutsider
                  ? `A member of the "${membership.groupName}" group has a sharing policy that allows your request, so their MAIA responded autonomously.`
                  : `Your request to ${membership.alias || 'a member'} in "${membership.groupName}" matched their sharing policies, so their MAIA responded autonomously.`,
                '',
                `--- ${requesterNotice.artifactLabel} ---`,
                requesterNotice.artifact,
                ...(appUrl ? ['', appUrl] : [])
              ].join('\n')
            );
          }
          auditLog.logEvent({
            type: 'as_request_responded',
            userId: userDoc.userId,
            details: { requestId: doc._id, groupId: membership.groupId, outcome: doc.status, autonomous: true, decidedByPolicyId: decision?.decidedBy?.id || null }
          });
        } catch (e) {
          console.warn('[as-requests] autonomous respond email failed:', e?.message || e);
        }
      }
      // In-app reply to a member requester: sealed to their pairwise key via
      // the registry relay, so it reaches them whichever host their MAIA
      // lives on. The generic relay nudge stays on unless we already emailed
      // them directly above.
      if (memberReply) {
        try {
          await deliverSealed(membership, r.fromPairwiseId, [
            'My MAIA responded to your request automatically:',
            '',
            `--- ${memberReply.artifactLabel} ---`,
            memberReply.artifact
          ].join('\n'), { suppressNotify: !!requesterNotice });
        } catch (e) {
          console.warn('[as-requests] autonomous relay reply failed:', e?.message || e);
        }
      }
      // Count this ingest-side decision in the registry's public tally (the
      // registry may be another host — HTTP either way; counts only). The
      // delivery-time path already counted anything it decided itself
      // (r.autoDecision), so this only fires for decisions made HERE.
      if (r.fromOutsider && !r.autoDecision && r.nonce && doc.status !== 'pending') {
        try {
          await fetch(
            `${registryBase(membership)}/api/groups/${encodeURIComponent(membership.groupId)}/outside-request/${encodeURIComponent(r.nonce)}/responded`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome: doc.status }) }
          );
        } catch (e) {
          console.warn('[as-requests] tally bump failed:', e?.message || e);
        }
      }
    }
    // Best-effort patient notification (in-app inbox is the primary channel).
    // Requests the registry already answered per the member's own policy get
    // a "your MAIA responded" note, not a call to action.
    if (stored > 0 && userDoc.email && typeof sendEmail === 'function') {
      try {
        const appUrl = (process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
        const pending = stored - autoAnswered;
        await sendEmail(
          userDoc.email,
          `New request in your MAIA group "${membership.groupName}"`,
          [
            `You have ${stored} new request${stored === 1 ? '' : 's'} in "${membership.groupName}".`,
            ...(autoAnswered > 0
              ? [`Your MAIA already responded to ${autoAnswered} of them autonomously, per your sharing policies.`]
              : []),
            '',
            pending > 0
              ? 'Open MAIA → Workbook → Groups → Requests to review and respond.'
              : 'Open MAIA → Workbook → Groups → Requests to see what was shared and why.',
            appUrl ? `\n${appUrl}` : ''
          ].join('\n')
        );
      } catch (e) {
        console.warn('[as-requests] notify failed:', e?.message || e);
      }
    }
    return stored;
  };

  /** Refresh every membership on a userDoc; drop revoked ones; ingest any
   *  AS requests. Mutates userDoc.groupMemberships. Returns { changed, summary }. */
  const refreshUserMemberships = async (userDoc, { notifyNewMail = false } = {}) => {
    const memberships = userDoc.groupMemberships || [];
    if (memberships.length === 0) {
      return { changed: false, summary: { refreshed: 0, revoked: 0, newMessages: 0, newRequests: 0 } };
    }
    let changed = false;
    let refreshed = 0;
    let revoked = 0;
    let newMessages = 0;
    let newRequests = 0;
    const kept = [];
    for (const membership of memberships) {
      try {
        const r = await refreshMembership(membership);
        if (r.revoked) {
          revoked++;
          changed = true;
          continue; // drop this membership
        }
        refreshed++;
        if (Array.isArray(r.asRequests) && r.asRequests.length) {
          newRequests += await ingestAsRequests(userDoc, membership, r.asRequests);
        }
        // asRequests count toward newMessages in refreshMembership, but the
        // inbox itself only grew by plain messages.
        newMessages += r.newMessages - (r.asRequests ? r.asRequests.length : 0);
        changed = true;
      } catch (e) {
        console.warn(`[user-groups] refresh failed for ${membership.groupId}:`, e?.message || e);
      }
      kept.push(membership);
    }
    userDoc.groupMemberships = kept;
    if (changed) userDoc.updatedAt = new Date().toISOString();
    // Cron-driven pulls email the member about newly arrived PLAIN messages
    // from THIS host — the only host that knows their address. This is how
    // a CROSS-HOST member ever hears about messages: the registry cannot
    // resolve their email (deleted at join, by design), so its send-time
    // nudge never reaches them. Client-driven refreshes (the user is in
    // the app) never email — notifyNewMail defaults off. As-requests are
    // excluded: ingestAsRequests sends its own, more specific email.
    if (notifyNewMail && newMessages > 0 && userDoc.email && userDoc.emailVerified && typeof sendEmail === 'function') {
      try {
        const appUrl = (process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
        await sendEmail(
          userDoc.email,
          `New message${newMessages === 1 ? '' : 's'} in your MAIA groups`,
          [
            `You have ${newMessages} new message${newMessages === 1 ? '' : 's'} waiting in your MAIA groups.`,
            '',
            'Open MAIA → Workbook → Groups to read and reply.',
            appUrl ? `\n${appUrl}` : ''
          ].join('\n')
        );
      } catch (e) {
        console.warn('[user-groups] new-mail notify failed:', e?.message || e);
      }
    }
    return { changed, summary: { refreshed, revoked, newMessages, newRequests } };
  };

  /**
   * Daily maintenance for the cron (server/index.js): sweep expired relay
   * messages + invites at the registry, then refresh every user's
   * memberships (renewing credentials, reconciling revocation, pulling
   * mail). Best-effort; logs a summary.
   */
  const runDailyGroupMaintenance = async () => {
    const swept = await sweepExpired();
    let usersProcessed = 0;
    let totalRevoked = 0;
    let totalMessages = 0;
    try {
      const users = await cloudant.getAllDocuments(USERS_DB);
      for (const userDoc of users || []) {
        if (!userDoc || !Array.isArray(userDoc.groupMemberships) || userDoc.groupMemberships.length === 0) continue;
        try {
          const r = await refreshUserMemberships(userDoc, { notifyNewMail: true });
          if (r.changed) await cloudant.saveDocument(USERS_DB, userDoc);
          usersProcessed++;
          totalRevoked += r.summary.revoked;
          totalMessages += r.summary.newMessages;
        } catch (e) {
          console.warn(`[groups-cron] user ${userDoc.userId} refresh failed:`, e?.message || e);
        }
      }
    } catch (e) {
      console.warn('[groups-cron] user iteration failed:', e?.message || e);
    }
    console.log(`[groups-cron] maintenance: swept ${swept.relayDeleted} msgs / ${swept.invitesExpired} invites; ` +
      `refreshed ${usersProcessed} users, ${totalRevoked} revoked, ${totalMessages} new messages`);
  };

  /** Lightweight hourly mail pull (server/index.js schedules it): refresh
   *  every member's inbox and email them about newly arrived messages.
   *  This bounds cross-host message-notification latency to ~1h instead
   *  of the daily maintenance cycle. Server-to-server, one refresh per
   *  membership — cheap at this scale, and the only polling the design
   *  permits (a member's host must PULL; the registry can't push to a
   *  host it cannot identify). */
  const runHourlyMailPull = async () => {
    let processed = 0;
    let mails = 0;
    try {
      const users = await cloudant.getAllDocuments(USERS_DB);
      for (const userDoc of users || []) {
        if (!userDoc || !Array.isArray(userDoc.groupMemberships) || userDoc.groupMemberships.length === 0) continue;
        try {
          const r = await refreshUserMemberships(userDoc, { notifyNewMail: true });
          if (r.changed) await cloudant.saveDocument(USERS_DB, userDoc);
          processed++;
          mails += r.summary.newMessages;
        } catch (e) {
          console.warn(`[groups-mail] user ${userDoc.userId} pull failed:`, e?.message || e);
        }
      }
    } catch (e) {
      console.warn('[groups-mail] user iteration failed:', e?.message || e);
    }
    if (mails > 0) console.log(`[groups-mail] pulled ${mails} new message(s) across ${processed} users`);
  };

  return { runDailyGroupMaintenance, runHourlyMailPull };
}
