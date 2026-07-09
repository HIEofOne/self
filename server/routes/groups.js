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
import { generateKeyPairSync, createHash, createPrivateKey, randomBytes, sign as edSign } from 'crypto';

const GROUPS_DB = 'maia_groups';
const USERS_DB = 'maia_users';

/** Invite tokens are single-use and expire after 14 days. */
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Membership credentials live 24 hours (Groups.md §6.1). */
const CREDENTIAL_TTL_MS = 24 * 60 * 60 * 1000;

const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
const b64u = (buf) => Buffer.from(buf).toString('base64url');

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
}
