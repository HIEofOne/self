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
 * @param {object} doc          the user document
 * @param {object} opts
 * @param {boolean} opts.groupRequired  this host lists a group to join
 */
export const deriveSetupStatus = (doc, { groupRequired = false } = {}) => {
  const memberships = Array.isArray(doc?.groupMemberships) ? doc.groupMemberships : [];
  const steps = [
    { key: 'email', required: true, done: !!doc?.emailVerified },
    { key: 'passkey', required: true, done: !!doc?.credentialID },
    { key: 'folder', required: true, done: !!doc?.folderConnectedAt },
    {
      key: 'group',
      required: groupRequired,
      done: memberships.length > 0,
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
  const hostListsGroup = async () => {
    try {
      const all = await cloudant.getAllDocuments(GROUPS_DB);
      return (all || []).some((d) => d && d.type === 'group' && d.publiclyListed === true);
    } catch {
      return false;
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
      res.json({ success: true, ...deriveSetupStatus(doc, { groupRequired: await hostListsGroup() }) });
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
        return res.json({ success: true, ...deriveSetupStatus(doc, { groupRequired: await hostListsGroup() }) });
      }
      return res.status(409).json({ success: false, error: 'CONFLICT' });
    } catch (e) {
      console.error('[setup] folder-connected failed:', e?.message || e);
      res.status(500).json({ success: false, error: 'SAVE_FAILED' });
    }
  });
}
