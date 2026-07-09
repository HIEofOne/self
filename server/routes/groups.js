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
  const counts = { active: 0, invited: 0, revoked: 0 };
  for (const m of doc.members || []) {
    if (m?.status && counts[m.status] !== undefined) counts[m.status]++;
  }
  return counts;
};

/** Admin-facing view: everything except the private signing key and any
 *  invite emails. The private key NEVER leaves the server via this view —
 *  the sole, deliberate exception is the recovery-kit export (§6.7). */
const adminGroupView = (doc) => ({
  groupId: doc._id,
  name: doc.name,
  description: doc.description || '',
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
  tagVocabulary: doc.tagVocabulary || [],
  publicKeyJwk: doc.signingKey?.publicKeyJwk || null,
  activeMemberCount: memberCounts(doc).active
});

export default function setupGroupRoutes(app, cloudant, auditLog, { sendEmail } = {}) {
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
      const { name, description = '', tagVocabulary = [] } = req.body || {};
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
      if (tagVocabulary !== undefined) doc.tagVocabulary = normalizeTags(tagVocabulary);
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
    mentor: !!m.mentor
  });

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
        inviteExpiresAt: new Date(now.getTime() + INVITE_TTL_MS).toISOString()
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
              `You've been invited to join the patient group "${doc.name}".`,
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

  // GET /api/groups/:groupId/members — member list (admin).
  app.get('/api/groups/:groupId/members', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const doc = await cloudant.getDocument(GROUPS_DB, req.params.groupId);
      if (!doc || doc.type !== 'group') {
        return res.status(404).json({ success: false, error: 'Group not found' });
      }
      res.json({ success: true, members: (doc.members || []).map(memberAdminView) });
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
          groupPublicKeyJwk: doc.signingKey?.publicKeyJwk || null
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
        .map((m) => ({ pairwiseId: m.pairwiseId, alias: m.alias || '(member)' }));
      res.json({
        success: true,
        stats: { activeMembers: active.length, recentlyActiveMembers: recentlyActive.length },
        mentors
      });
    } catch (error) {
      console.error('[groups] directory failed:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch directory' });
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

  // Sweep expired relay messages + expired invites (called by the daily
  // cron in server/index.js). Returns counts for logging.
  const sweepExpired = async () => {
    const nowIso = new Date().toISOString();
    let relayDeleted = 0;
    let invitesExpired = 0;
    try {
      const all = await cloudant.getAllDocuments(RELAY_DB);
      for (const m of all || []) {
        if (m && m.type === 'relay_message' && m.expiresAt && m.expiresAt < nowIso) {
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
  const membershipView = (m) => ({
    groupId: m.groupId,
    groupName: m.groupName,
    registryUrl: m.registryUrl,
    pairwiseId: m.pairwiseId,
    alias: m.alias,
    joinedAt: m.joinedAt,
    credentialExpiresAt: m.credential?.expiresAt || null,
    mentor: !!m.mentor
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
        joinedAt: new Date().toISOString()
      };
      if (!userDoc.asId) userDoc.asId = randomBytes(16).toString('hex');
      userDoc.groupMemberships = [...(userDoc.groupMemberships || []), membership];
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

  // GET /api/user-groups — the patient's memberships (no private keys).
  app.get('/api/user-groups', async (req, res) => {
    const userId = requireMatchingUser(req, res);
    if (!userId) return;
    try {
      const userDoc = await cloudant.getDocument(USERS_DB, userId);
      if (!userDoc) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }
      res.json({ success: true, memberships: (userDoc.groupMemberships || []).map(membershipView) });
    } catch (error) {
      console.error('[user-groups] list failed:', error);
      res.status(500).json({ success: false, error: 'Failed to list memberships' });
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
  const refreshMembership = async (membership) => {
    const { payload, signature } = signWithMembership(membership, {
      action: 'refresh',
      groupId: membership.groupId,
      pairwiseId: membership.pairwiseId,
      ts: new Date().toISOString()
    });
    // Ack messages we already stored last time (delivered).
    const ackMessageIds = (membership.inbox || []).map((msg) => msg.id).filter(Boolean);
    const res = await fetch(`${registryBase(membership)}/api/groups/${encodeURIComponent(membership.groupId)}/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairwiseId: membership.pairwiseId, payload, signature, ackMessageIds })
    });
    const data = await res.json().catch(() => ({}));
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
    let added = 0;
    const asRequests = [];
    for (const m of data.messages || []) {
      if (existingIds.has(m.id)) continue;
      let text = null;
      try {
        text = openFrom(membership.encryptionKeyPair.privateKeyJwk, m.box);
      } catch {
        text = null; // undecryptable — skip rather than store garbage
      }
      if (text == null) continue;

      // AS request envelope? (sealed JSON with maiaType === 'as-request')
      let envelope = null;
      try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.maiaType === 'as-request') envelope = parsed;
      } catch { /* plain text message */ }

      if (envelope) {
        asRequests.push({
          relayId: m.id,
          fromPairwiseId: m.fromPairwiseId,
          receivedAt: m.createdAt,
          action: String(envelope.action || 'message'),
          resource: String(envelope.resource || ''),
          computationClass: envelope.computationClass || null,
          payment: envelope.payment || null, // reserved (§3.4); unused in Phase 1
          nonce: envelope.nonce || null,
          created: envelope.created || null,
          payload: envelope.payload ?? null
        });
        added++;
        continue;
      }

      membership.inbox = membership.inbox || [];
      membership.inbox.push({ id: m.id, fromPairwiseId: m.fromPairwiseId, text, receivedAt: m.createdAt });
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
  const deliverSealed = async (membership, toPairwiseId, plaintext) => {
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
      body: JSON.stringify({ fromPairwiseId: membership.pairwiseId, toPairwiseId, box, payload: rq.payload, signature: rq.signature })
    });
    const relayData = await relayRes.json().catch(() => ({}));
    if (!relayRes.ok || !relayData.success) {
      return { ok: false, status: 502, error: relayData.error || 'Relay failed' };
    }
    return { ok: true };
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
      const result = await deliverSealed(membership, toPairwiseId, String(text));
      if (!result.ok) return res.status(result.status).json({ success: false, error: result.error });
      auditLog.logEvent({ type: 'user_group_message_sent', userId, ip: req.ip, details: { groupId, toPairwiseId } });
      res.json({ success: true });
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
        computationClass: 'answer-from-record', // §3.4 action ladder (Phase 1 floor)
        payment: null, // §3.4 reserved payment slot; unused in Phase 1
        nonce: randomBytes(8).toString('hex'),
        created: new Date().toISOString(),
        payload: payload ?? null
      });
      const result = await deliverSealed(membership, toPairwiseId, envelope);
      if (!result.ok) return res.status(result.status).json({ success: false, error: result.error });
      auditLog.logEvent({ type: 'user_group_request_sent', userId, ip: req.ip, details: { groupId, toPairwiseId, action } });
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
          action: r.action,
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
      res.json({ success: true, messages: membership.inbox || [] });
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
      res.json({ success: true, stats: data.stats, mentors: data.mentors || [] });
    } catch (error) {
      console.error('[user-groups] directory failed:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch directory' });
    }
  });

  /**
   * Persist AS requests pulled during a refresh (Phase-1 "escalate
   * everything" dispatch — no Cedar yet): store each as a pending
   * maia_as_requests doc and best-effort notify the patient. A blocked
   * sender is silently dropped (spam), the Phase-1 stand-in for a Cedar
   * forbid. Returns the number stored.
   */
  const ingestAsRequests = async (userDoc, membership, requests) => {
    let stored = 0;
    const blocked = new Set(membership.blockedSenders || []);
    for (const r of requests) {
      if (blocked.has(r.fromPairwiseId)) continue; // spam-drop
      const now = Date.now();
      const doc = {
        _id: `asreq_${now}_${randomBytes(6).toString('hex')}`,
        type: 'as_request',
        userId: userDoc.userId,
        groupId: membership.groupId,
        groupName: membership.groupName,
        toPairwiseId: membership.pairwiseId,
        fromPairwiseId: r.fromPairwiseId,
        action: r.action,
        resource: r.resource,
        computationClass: r.computationClass,
        payment: r.payment, // reserved (§3.4)
        payload: r.payload,
        nonce: r.nonce,
        createdAt: r.created || new Date(now).toISOString(),
        receivedAt: new Date(now).toISOString(),
        status: 'pending' // Phase 1: every request escalates to the patient
      };
      try {
        await cloudant.saveDocument(AS_REQUESTS_DB, doc);
        stored++;
      } catch (e) {
        console.warn('[as-requests] store failed:', e?.message || e);
      }
    }
    // Best-effort patient notification (in-app inbox is the primary channel).
    if (stored > 0 && userDoc.email && typeof sendEmail === 'function') {
      try {
        const appUrl = (process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
        await sendEmail(
          userDoc.email,
          `New request in your MAIA group "${membership.groupName}"`,
          [
            `You have ${stored} new request from a member of "${membership.groupName}".`,
            '',
            'Open MAIA → Workbook → Groups → Requests to review and respond.',
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
  const refreshUserMemberships = async (userDoc) => {
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
          const r = await refreshUserMemberships(userDoc);
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

  return { runDailyGroupMaintenance };
}
