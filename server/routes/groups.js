/**
 * Groups & Authorization Server — Phase 1, PR-1: Group Registry + admin CRUD.
 *
 * The group registry holds ONLY what is needed to control membership and to
 * enable mediated, privacy-preserving communication — never clinical data,
 * never interest profiles. See Documentation/Groups.md (§3.1 data model,
 * §6 resolved design decisions, §7 Phase 1 plan).
 *
 * PR-1 scope: group CRUD + per-group signing keys + public info endpoint.
 * Invites/join (PR-2), relay/heartbeat (PR-3), requests inbox (PR-4), and
 * directory/liquidity (PR-5) follow.
 */
import { generateKeyPairSync } from 'crypto';

const GROUPS_DB = 'maia_groups';

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
 *  invite emails. The private key NEVER leaves the server. */
const adminGroupView = (doc) => ({
  groupId: doc._id,
  name: doc.name,
  description: doc.description || '',
  tagVocabulary: doc.tagVocabulary || [],
  publicKeyJwk: doc.signingKey?.publicKeyJwk || null,
  policyPackVersion: doc.policyPackVersion ?? 0,
  memberCounts: memberCounts(doc),
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt
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

export default function setupGroupRoutes(app, cloudant, auditLog) {
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
}
