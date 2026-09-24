/**
 * Editions and the feature registry (Documentation/group_requests.md §4).
 *
 * One codebase, two editions, chosen once at boot by MAIA_EDITION:
 *  - 'full' (default): today's MAIA. Every existing feature is on.
 *  - 'personal-as': the Personal AS edition. Core features are on; the
 *    rest stay off until the user turns them on.
 *
 * The server enforces this (I-26): server/edition-routes.js maps every
 * route to a feature, and its /api guard answers 403 FEATURE_OFF for a
 * feature that is off, whatever the UI shows. The registry is also the
 * only source of the text that describes a feature: when the private AI
 * suggests turning one on, the confirm card quotes this text, never the
 * AI's (I-27).
 */

export const EDITIONS = Object.freeze(['full', 'personal-as']);
export const DEFAULT_EDITION = 'full';

// A feature's mode in each edition:
//   'on'          always on
//   'unlockable'  off until the user turns it on (userDoc.features[key].enabledAt)
//   'off'         not available in this edition
export const FEATURE_MODES = Object.freeze(['on', 'unlockable', 'off']);

const feature = (name, description, whatItMeans, modes) =>
  Object.freeze({ name, description, whatItMeans, modes: Object.freeze(modes) });

const CORE = { full: 'on', 'personal-as': 'on' };
const UNLOCKABLE = { full: 'on', 'personal-as': 'unlockable' };
// New with the Personal AS edition; the full edition keeps today's
// request path until D14 is decided.
const EDITION_ONLY = { full: 'off', 'personal-as': 'on' };

export const FEATURES = Object.freeze({
  account: feature('Account',
    'Sign in with a passkey, your verified email, your MAIA folder, and backup and restore.',
    null, CORE),
  'groups-core': feature('Groups',
    'Join a group, receive its suggested policies and their updates, and send and receive requests through the group.',
    null, CORE),
  policies: feature('Sharing policies',
    'Your rules for who may see or add what, with a way to test them before you turn sharing on.',
    null, CORE),
  requests: feature('Requests',
    'Every request to your MAIA in one list, where you decide, stop sharing, and see what happened.',
    null, CORE),
  summary: feature('Patient Summary',
    'Your Patient Summary and Current Medications, the privacy-filtered copy that may be shared, and PDF copies in your folder.',
    null, CORE),
  advisor: feature('Private AI',
    'A private AI that helps you understand and edit your policies, your summary and your requests.',
    null, CORE),
  notifications: feature('Email notifications',
    'An email when something was shared or needs your decision, and a weekly summary.',
    null, CORE),
  gnap: feature('Request API (GNAP)',
    'The standard way people, apps and other MAIAs ask your MAIA for information. Your request pages use it too.',
    null, EDITION_ONLY),
  'documents-in': feature('Documents from others',
    'Lets others add documents, such as a radiology report, to your folder when your rules allow it.',
    null, EDITION_ONLY),
  'requests-out': feature('Requests you send',
    'Lets your MAIA ask other MAIAs for information for you, after you click Send.',
    null, EDITION_ONLY),

  'records-index': feature('Search all my records',
    'Indexes the record files in your folder so your private AI can answer questions from all of them.',
    'Copies your record files into a private search index at the hosting service. Indexing takes a few minutes, and the host pays for a search cluster.',
    UNLOCKABLE),
  'lists-full': feature('Lists',
    'Categories, encounters, out-of-range labs and medication worksheets built from your records.',
    null, UNLOCKABLE),
  'second-ai': feature('Second private AI',
    'A second private AI, on an open-weights model you choose, for a second opinion.',
    'Creates a second AI agent at the hosting service.',
    UNLOCKABLE),
  'public-ai': feature('Public AIs',
    'Chat with commercial AI models from Anthropic, OpenAI, DeepSeek or Google.',
    'What you send in those chats goes to that model\'s provider.',
    UNLOCKABLE),
  'saved-chats': feature('Saved chats',
    'Keep chats so you can come back to them.',
    'Chat text is stored on the MAIA server.',
    UNLOCKABLE),
  'deep-links': feature('Links for clinicians',
    'Share a link that lets a clinician chat with your private AI about your records.',
    'Anyone with the link can ask your private AI questions until you remove the link.',
    UNLOCKABLE),
  'peer-messaging': feature('Messages with members',
    'Message threads with other members of your groups, the Everyone channel, the member directory and mentors.',
    null, UNLOCKABLE),
  vouch: feature('People I vouch for',
    'Give people you know stronger standing, so your rules can treat them as verified by you.',
    null, UNLOCKABLE),
  diary: feature('Patient Diary',
    'A private diary in your Workbook.',
    null, UNLOCKABLE),
  references: feature('References',
    'Links and reference documents you keep for your private AI.',
    null, UNLOCKABLE),
  'privacy-filter-editor': feature('Privacy filter editor',
    'Edit the full list of names and details that are replaced before anything is shared. Reviewing your Patient Summary\'s replacements stays part of Patient Summary.',
    null, UNLOCKABLE),

  'legacy-requests': feature('Request form with email delivery',
    'The original group request form, which answers requesters by email.',
    null, { full: 'on', 'personal-as': 'off' })
});

export const resolveEdition = (raw) => {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return DEFAULT_EDITION;
  if (EDITIONS.includes(value)) return value;
  console.warn(`[edition] Unknown MAIA_EDITION "${raw}"; using "${DEFAULT_EDITION}"`);
  return DEFAULT_EDITION;
};

let currentEdition = resolveEdition(process.env.MAIA_EDITION);

export const getEdition = () => currentEdition;

/** Tests only. The edition is otherwise fixed at boot. */
export const setEditionForTests = (edition) => {
  currentEdition = resolveEdition(edition);
  return currentEdition;
};

export const featureMode = (key, edition = currentEdition) =>
  FEATURES[key]?.modes?.[edition] || 'off';

/** Is `key` on for this user? `userDoc` matters only for unlockable features. */
export const isFeatureEnabled = (key, userDoc = null, edition = currentEdition) => {
  const mode = featureMode(key, edition);
  if (mode === 'on') return true;
  if (mode === 'unlockable') return !!userDoc?.features?.[key]?.enabledAt;
  return false;
};

/** The body of GET /api/edition. */
export const describeEdition = (userDoc = null, edition = currentEdition) => ({
  edition,
  features: Object.fromEntries(Object.entries(FEATURES).map(([key, f]) => {
    const mode = f.modes[edition] || 'off';
    return [key, {
      name: f.name,
      description: f.description,
      whatItMeans: f.whatItMeans,
      available: mode !== 'off',
      defaultOn: mode === 'on',
      unlockable: mode === 'unlockable',
      enabled: isFeatureEnabled(key, userDoc, edition)
    }];
  }))
});

/**
 * May the server create this user's primary private AI agent now?
 * Personal AS edition: only once the email is verified, so an unverified
 * visitor (or a bot) never creates a DO resource (§9, I-26).
 */
export const mayCreatePrimaryAgent = (userDoc, edition = currentEdition) =>
  edition !== 'personal-as' || !!userDoc?.emailVerified;
