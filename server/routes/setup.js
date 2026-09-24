/**
 * Setup checklist state (Documentation/group_requests.md §5).
 *
 * GET /api/setup-status is DERIVED from facts the account already holds
 * (verified email, passkey, folder, group membership, verification stamps)
 * — nothing about setup progress is stored separately, so a reload at any
 * step shows exactly where the user is.
 *
 * POST /api/setup/folder-connected records the one fact the server can't
 * see for itself: that the browser connected the user's MAIA folder. Only
 * a timestamp is kept — never the folder's name or contents.
 */
import { getEdition } from '../edition.js';
import { asStateOf } from './policies.js';
import { joinLinkFor } from './groups.js';
import { requestedUserId } from '../utils/api-guard.js';

const USERS_DB = 'maia_users';
const GROUPS_DB = 'maia_groups';

/** The private AI's state, from the account alone. */
const agentState = (doc) => {
  if (getEdition() === 'personal-as' && !doc?.emailVerified) return 'waiting-for-email';
  if (!doc?.assignedAgentId) return 'none';
  return doc.agentEndpoint ? 'ready' : 'creating';
};

/**
 * @param {object} doc  the user document
 * @param {object} opts
 * @param {{groupId: string, name: string, joinLink: string}|null} opts.joinableGroup
 *        the host's group that can be joined directly (open or approval
 *        join link). Only then is joining required.
 * @param {{groupId: string, name: string}|null} opts.inviteOnlyGroup
 *        a listed group that joins only by invitation — offered, never
 *        required (without an invitation nobody could finish setup).
 */
export const deriveSetupStatus = (doc, { joinableGroup = null, inviteOnlyGroup = null } = {}) => {
  const memberships = Array.isArray(doc?.groupMemberships) ? doc.groupMemberships : [];
  const steps = [
    { key: 'email', required: true, done: !!doc?.emailVerified },
    { key: 'passkey', required: true, done: !!doc?.credentialID },
    { key: 'folder', required: true, done: !!doc?.folderConnectedAt },
    {
      key: 'group',
      required: !!joinableGroup,
      done: memberships.length > 0,
      joinable: joinableGroup,
      inviteOnly: joinableGroup ? null : inviteOnlyGroup,
      groups: memberships.map((m) => m.groupName || m.groupId).filter(Boolean),
      // Join requests waiting for a group's approval (finished by poll-joins)
      pending: (Array.isArray(doc?.pendingGroupJoins) ? doc.pendingGroupJoins : [])
        .map((p) => p.groupName || p.groupId).filter(Boolean)
    },
    {
      key: 'summary',
      required: false, // urged, skippable (§5 row 5)
      done: !!(doc?.currentMedicationsVerifiedAt && doc?.patientSummaryVerifiedAt),
      medicationsVerified: !!doc?.currentMedicationsVerifiedAt,
      summaryVerified: !!doc?.patientSummaryVerifiedAt
    },
    {
      // Row 6 (§5): confirm the rules, then turn sharing on. Not needed to
      // close the checklist, but nothing is shared until it's done.
      key: 'sharing',
      required: false,
      done: asStateOf(doc) === 'active',
      asState: asStateOf(doc),
      unconfirmed: (Array.isArray(doc?.sharingPolicies) ? doc.sharingPolicies : [])
        .filter((p) => p && p.enabled !== false && !p.confirmedAt).length
    }
  ];
  return {
    edition: getEdition(),
    steps,
    requiredDone: steps.every((s) => !s.required || s.done),
    agent: agentState(doc)
  };
};

export default function setupSetupRoutes(app, cloudant) {
  // The host's group(s), as the welcome page sees them: publicly listed.
  // A "Trustee" group is preferred, as on the welcome page.
  const hostGroups = async () => {
    try {
      const all = await cloudant.getAllDocuments(GROUPS_DB);
      const listed = (all || [])
        .filter((d) => d && d.type === 'group' && d.publiclyListed === true)
        .sort((a, b) => Number(!/trustee/i.test(a.name || '')) - Number(!/trustee/i.test(b.name || '')));
      const open = listed.find((d) => joinLinkFor(d));
      return {
        joinableGroup: open ? { groupId: open._id, name: open.name, joinLink: joinLinkFor(open) } : null,
        inviteOnlyGroup: listed[0] ? { groupId: listed[0]._id, name: listed[0].name } : null
      };
    } catch {
      return { joinableGroup: null, inviteOnlyGroup: null };
    }
  };

  const loadUser = async (req, res) => {
    const userId = requestedUserId(req) || req.session?.userId;
    if (!userId) {
      res.status(401).json({ success: false, error: 'NOT_AUTHENTICATED', message: 'Sign in required' });
      return null;
    }
    const doc = await cloudant.getDocument(USERS_DB, userId);
    if (!doc) {
      res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
      return null;
    }
    return doc;
  };

  app.get('/api/setup-status', async (req, res) => {
    try {
      const doc = await loadUser(req, res);
      if (!doc) return;
      res.json({ success: true, ...deriveSetupStatus(doc, await hostGroups()) });
    } catch (e) {
      console.error('[setup] status failed:', e?.message || e);
      res.status(500).json({ success: false, error: 'SETUP_STATUS_FAILED' });
    }
  });

  app.post('/api/setup/folder-connected', async (req, res) => {
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const doc = await loadUser(req, res);
        if (!doc) return;
        if (!doc.folderConnectedAt) doc.folderConnectedAt = new Date().toISOString();
        doc.updatedAt = new Date().toISOString();
        try {
          await cloudant.saveDocument(USERS_DB, doc);
        } catch (e) {
          if (e?.statusCode === 409 && attempt < 2) continue;
          throw e;
        }
        return res.json({ success: true, ...deriveSetupStatus(doc, await hostGroups()) });
      }
      return res.status(409).json({ success: false, error: 'CONFLICT' });
    } catch (e) {
      console.error('[setup] folder-connected failed:', e?.message || e);
      res.status(500).json({ success: false, error: 'SAVE_FAILED' });
    }
  });
}
