# Account Lifecycle: Welcome, Setup, Sign-out, Destroy, and Restore

This document describes MAIA's account lifecycle flows, the modals involved
in each, verification steps, and how multiple family members are kept
separate.

---

## 1. Architecture Overview

Account state lives in three systems:

| System | What it stores |
|--------|---------------|
| **CouchDB** (`maia_users`) | User doc: `assignedAgentId`, `kbId`, `kbName`, `files[]`, `workflowStage`, `currentMedications`, `patientSummary` |
| **DigitalOcean** | Agent (GenAI platform), Knowledge Base, Spaces (S3) files |
| **Browser** | IndexedDB folder handle, localStorage (`knownUsers[]`, snapshot data), sessionStorage flags, `maia-state.json` in local folder |

---

## 2. Welcome Page (App.vue)

Every session begins here when the user is not authenticated.

### Known User Cards

If `knownUsers` (from localStorage) contains entries, each is displayed as
a status card with color-coded border and icon:

| Cloud status | Border color | Icon | Action button |
|-------------|-------------|------|---------------|
| `ready` | Green | check_circle | SIGN IN / CONTINUE |
| `loading` | Grey | hourglass_empty | (spinner) |
| `restore` | Orange | warning | RESTORE |

Each card shows the user's display name, userId, folder name, and an X
button to remove from this device. Below the cards, an "Add family member"
button starts a fresh new-user flow.

If no known users exist, a simple text line offers to sign in with a
passkey or create a new account.

### Welcome Page Controls

- **GET STARTED** button (blue, full width) — calls
  `handleGetStartedNoPassword()`. When restorable users exist, shows a
  disambiguation dialog first (see below).
- **Introduction** — loaded from `public/welcome.md`, rendered via
  vue-markdown.
- **Footer links**: Privacy | FAQ | About — each opens
  `WelcomeContentDialog` with the corresponding markdown section.

### Get Started Disambiguation

**Modal: `showGetStartedChoiceDialog`**

When a user clicks GET STARTED and there are restorable (destroyed) users
in knownUsers, this dialog appears to prevent accidentally creating a new
account when the user intended to restore:

- One **Restore {name}** button per restorable user
- An **Add a new family member** button for genuinely new accounts

---

## 3. New User Setup

### Step 1: Device Privacy Dialog

When a truly new user clicks GET STARTED (no knownUsers at all):

**Modal: `showDevicePrivacyDialog`** (persistent)
- "Is this a private computer or a shared computer?"
- **PRIVATE**: Sets `sharedComputerMode = false`, proceeds to create
  session.
- **SHARED**: Sets `sharedComputerMode = true`, shows a warning that a
  passkey will be required, then proceeds.

### Step 2: Temporary Session

`startTemporarySession()` calls `POST /api/temporary-session`, which
creates a CouchDB user doc and returns a session cookie. The user is now
authenticated and the main ChatInterface loads. The new userId is added
to `knownUsers` in localStorage.

If `sharedComputerMode` is true, passkey registration is started
immediately after authentication.

### Step 3: Setup Wizard (ChatInterface)

**Modal: `showAgentSetupDialog`** (persistent, non-dismissible until
complete)

The wizard has three stages displayed as a vertical checklist:

**Stage 1 — Private AI Agent Deployment**
- Triggered automatically on ChatInterface mount.
- ChatInterface polls `GET /api/agent-setup-status` every few seconds.
- This endpoint calls `ensureUserAgent()` to create a DO agent if none
  exists.
- A countdown timer shows elapsed time (typically 2-5 minutes).
- Complete when `assignedAgentId` exists and agent is deployed.
- Status line: "Ready to chat" when done.

**Stage 2 — File Upload and Import**
- User can pick a local folder (via File System Access API) or select
  individual files.
- Files are uploaded via `POST /api/files/upload`.
- If an Apple Health PDF is detected, it becomes the `initialFile` and
  triggers Current Medications extraction.
- Medications verification: user reviews AI-extracted medication list
  before proceeding to Stage 3.
- "No device" option: user can skip file upload entirely.

**Stage 3 — Knowledge Base Indexing**
- Triggered by `POST /api/update-knowledge-base`.
- Server creates or reuses a DO Knowledge Base, copies files into an
  ephemeral Spaces bucket, and starts an indexing job.
- **Server-side polling** (every 15s): tracks DO job status, token
  counts, and token stability. Completion is detected by:
  1. DO API job status transitioning to "completed"
  2. Token-stable detection: tokens > 0 and unchanged for 4+ polls (60s)
  3. Time-based fallback: 15 minutes elapsed
- **Client-side polling** (every 15s): reads `kbIndexingStatus` from
  CouchDB. Completion fallbacks:
  1. `backendCompleted` flag set by server
  2. `inferredComplete`: no active job and tokens > 0
  3. `tokenTimeoutComplete`: tokens > 0 and 7 minutes elapsed
  4. `pureTimeoutComplete`: 20 minutes elapsed (catches 0-token case)
- Console logging is state-change-only (logs only when poll state
  differs from previous poll).

**Wizard Completion**
- All three stages green → FINISH button enabled.
- `handleWizardComplete()` writes `maia-state.json` and a personalized
  `.webloc` shortcut to the user's local folder.
- Wizard state is persisted to localStorage so it survives page reload.

### Wizard Logging

Every stage transition and modal open/close is logged to the setup log
file via `POST /api/wizard-event`. Progress entries are written every
~60 seconds during polling.

---

## 4. Sign-out Flows

Sign-out behavior depends on the account type.

### Temporary Account Sign-out

**Modal: `showTempSignOutDialog`**
- "You're signed into a temporary account."
- **CREATE A PASSKEY**: Opens passkey registration (converts temporary
  to persistent).
- **DESTROY ACCOUNT**: Opens the Destroy dialog (see Section 5).
- **SIGN OUT**: Calls `handleTemporarySignOut()` — signs out without
  destroying. The temp session cookie persists; user can resume later.

### Authenticated (Passkey) Account Sign-out

1. If the user has shared deep links: shows the Dormant Dialog.
2. If no deep links and no local backup: offers Passkey Backup first.
3. Otherwise: proceeds directly to dormant sign-out.

**Modal: `showDormantDialog`**
- "Deep links require a running server."
- **KEEP SERVER LIVE**: Signs out locally but server stays active for
  deep-link recipients. Saves local snapshot.
- **GO DORMANT**: Saves local snapshot, calls `POST /api/account/dormant`
  to pause the server, then signs out.

### Passkey Backup Flow

**Modal: `showPasskeyBackupPromptModal`**
- "Encrypt a backup with a 4-digit PIN?"
- **NO**: Skips backup, proceeds to sign-out. Sets a flag so the prompt
  doesn't repeat.
- **YES**: Opens PIN dialog.

**Modal: `showPasskeyBackupPinDialog`**
- User enters a 4-digit PIN.
- Snapshot is encrypted with the PIN and saved to localStorage.
- Then proceeds to sign-out.

### Local State Snapshot

During sign-out, `saveLocalSnapshot()` writes the user's current state
to their local folder as `maia-state.json` (files list, medications,
patient summary, saved chats, agent instructions). This enables restore.

---

## 5. Account Destruction

### From Sign-out Dialog

Temporary users can reach Destroy via the sign-out dialog's
"DESTROY ACCOUNT" button.

**Modal: `showDestroyDialog`** (persistent)

**Verification step**: user must type their exact userId to confirm.

- Displays: "This permanently deletes your cloud data for {userId}.
  Signing out is reversible; destroying is not."
- Input field: "Enter user ID"
- **DESTROY** button: enabled only when typed text matches `user.userId`
  exactly.

### Destroy Process

`destroyTemporaryAccount()`:
1. Saves a local state snapshot (for potential restore)
2. Calls `POST /api/self/delete`, which runs
   `deleteUserAndResources(userId)`:
   - Deletes Spaces files under `{userId}/`
   - Deletes Knowledge Base by stored `kbId`
   - Deletes Agent by `assignedAgentId` + scans for orphan agents
   - Deletes session documents
   - Deletes the user document from CouchDB
3. Clears IndexedDB snapshot
4. Resets auth state (back to Welcome page)
5. The `knownUsers` entry is preserved with `cloudStatus: 'restore'`
   so the Welcome page shows the user card with a RESTORE button.

---

## 6. Account Restoration

When a destroyed user's card shows on the Welcome page with status
"restore" (orange), the user clicks RESTORE.

### Restore Flow (`handleUserCardRestore`)

1. **Read local state**: Tries in order:
   - Stored folder handle → reads `maia-state.json`
   - IndexedDB saved handle → reads `maia-state.json`
   - Prompts user to pick their local folder
   - Falls back to IndexedDB snapshot
2. **Recreate user doc**: `POST /api/account/recreate` → creates fresh
   CouchDB user doc with `kbName` pre-set (from snapshot or generated).
3. **Cloud health check**: `GET /api/cloud-health` → verifies what
   exists in DigitalOcean.
4. **Launch RestoreWizard**: Opens with local state and cloud health.

### RestoreWizard

**Modal: RestoreWizard component** (full-screen dialog)

Runs automatically on mount — no user interaction required:

- **Step 1**: Upload files from local state → `POST /api/files/upload`
  and register metadata
- **Step 2**: Deploy agent → `POST /api/sync-agent?create=true`
- **Step 3**: Index KB → `POST /api/update-knowledge-base`
- **Steps 4-7**: Restore medications, patient summary, saved chats,
  and agent instructions from the local state snapshot

After RestoreWizard completes, the setup wizard reopens if there are
rehydration files (files that need re-uploading from the user's device).

### Post-Restore Verification

After the RestoreWizard completes:
- Folder identity is re-stamped with the current userId
- A personalized `.webloc` shortcut is written
- Local state snapshot is updated
- Agent status is checked to confirm endpoint is ready

---

## 7. More Choices (Account Management)

Accessed via the **MORE CHOICES** button on the Welcome page.

**Modal: `showOtherAccountOptionsDialog`**

Available actions depend on user type:
- **Sign in as a different user**: Opens passkey auth.
- **Delete Cloud Account for {userId}**: Requires passkey verification
  first.
- **Delete Local Storage for {userId}**: Clears localStorage snapshot.

### Cloud Account Deletion

**Modal: `showMoreChoicesConfirmDialog`** (kind = 'delete-cloud')

For cloud users (with passkey):
- **Keep local backup and delete cloud**: Saves snapshot locally, then
  calls `POST /api/account/dormant`.
- **Delete everything**: Calls `POST /api/self/delete` and clears local
  snapshot.

For local-only users:
- Single **DELETE** button: restores temp session, calls
  `POST /api/self/delete`, clears snapshot, signs out.

### Local Storage Deletion

**Modal: `showMoreChoicesConfirmDialog`** (kind = 'delete-local')
- Single **DELETE** button: clears `userSnapshot` for the userId from
  localStorage, reloads welcome status.

---

## 8. Multi-Family-Member Separation

MAIA supports multiple family members using the same device.

### The knownUsers Registry

`knownUsers` is an array in localStorage. Each entry contains:
- `userId` — unique identifier (e.g. "chloe73")
- `displayName` — patient name for display
- `folderName` — local folder associated with this user
- `hasPasskey` — whether the user has registered a passkey

The Welcome page displays a card for each known user with their current
cloud status.

### Cloud Isolation
- Each user has their own CouchDB document, DO agent, KB, and Spaces
  folder (all prefixed by userId).
- Session cookies are per-user.

### Local Storage Isolation
- Snapshots are keyed by userId in localStorage.
- Folder handles in IndexedDB are per-user.
- `maia-state.json` in each user's folder stores their state.

### Verification Safeguards
- **Destroy**: Requires typing the exact userId to confirm.
- **Passkey**: Each user registers their own passkey, tied to their
  userId.
- **Shared device mode**: Forces passkey registration immediately after
  account creation, preventing unauthorized access.
- **User cards**: Color-coded (green/grey/orange) to make each user's
  status immediately obvious.
- **Disambiguation dialog**: When restorable users exist and someone
  clicks GET STARTED, a dialog prevents accidentally creating a new
  account instead of restoring.

### Removing a Family Member

Each user card has an X button that calls `handleDeleteLocalUser()`:
1. Removes the user from `knownUsers`
2. Cleans MAIA files from their local folder (if handle available)
3. Clears their IndexedDB snapshot
4. Optionally deletes their cloud account if still active

---

## 9. Versioning

MAIA uses semantic versioning with these rules:

| Segment | When it changes |
|---------|----------------|
| **Major** (X.0.0) | Incompatible database or backup/restore format changes |
| **Minor** (0.X.0) | Major new functionality added |
| **Patch** (0.0.X) | Each app update (bug fixes, UI tweaks, minor improvements) |

The version is stored in `package.json` and can be displayed in the
app's About section. A major version bump signals that existing backups
or CouchDB documents may not be compatible and migration steps are
needed.
