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
| **Browser** | IndexedDB folder handles (per-user), PouchDB snapshots, sessionStorage flags, `maia-state.json` in local folder |

---

## 2. Welcome Page (App.vue)

Every session begins here when the user is not authenticated.

### Discovered User Cards

If `discoverUsers()` finds entries (from IndexedDB directory handles),
each is displayed as a status card with color-coded border and icon:

| Cloud status | Border color | Icon | Action button |
|-------------|-------------|------|---------------|
| `ready` | Green | check_circle | SIGN IN / CONTINUE |
| `loading` | Grey | hourglass_empty | (spinner) |
| `restore` | Orange | warning | RESTORE |

Each card shows the user's display name, userId, folder name, and action
buttons:
- **RESTORE** button (orange, shown when `cloudStatus === 'restore'`)
- **X** button to remove from this device

Below the cards, an "Add family member" button starts a fresh new-user
flow. If no discovered users exist, a simple text line offers to sign in
with a passkey or create a new account.

### Welcome Page Controls

- **GET STARTED** button (blue, full width) — calls
  `handleGetStartedNoPassword()`. When restorable users exist, shows a
  disambiguation dialog first (see below).
- **Introduction** — loaded from `public/welcome.md`, rendered via
  vue-markdown.
- **Footer links**: Privacy | User Guide | FAQ | About — each opens a static HTML
  page (`/privacy.html`, `/User_Guide.html`, `/faq.html`, `/about.html`) in a new
  tab. These HTML files live in `public/` and are hand-edited.

### Get Started Disambiguation

**Modal: `showGetStartedChoiceDialog`**

When a user clicks GET STARTED and there are restorable (destroyed) users
among discovered users, this dialog appears to prevent accidentally creating a new
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
authenticated and the main ChatInterface loads. The directory handle is
stored in IndexedDB for the new userId.

If `sharedComputerMode` is true, passkey registration is started
immediately after authentication.

### Step 3: Setup Wizard (ChatInterface)

**Modal: `showAgentSetupDialog`** (persistent, dismissible via Continue
button or X once agent deployment completes)

The wizard displays a vertical checklist of steps. The first three run
in parallel; the last two require user verification.

**Stage 1 — Private AI Agent Deployment**
- Triggered automatically on ChatInterface mount.
- ChatInterface polls `GET /api/agent-setup-status` every few seconds.
- This endpoint calls `ensureUserAgent()` to create a DO agent if none
  exists.
- A countdown timer shows elapsed time (typically 2-5 minutes).
- Complete when `assignedAgentId` exists and agent is deployed.
- Status line: "Ready" when done.

**Stage 2 — File Upload and Import**
- User picks a local folder (via File System Access API) or selects
  individual files (Safari/other browsers).
- Files are uploaded via `POST /api/files/upload`.
- If an Apple Health PDF is detected, it becomes the `initialFile` and
  is marked for list/medication extraction after indexing.

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

### Guided Flow: Post-Indexing Transition

When both Stage 1 (agent) and Stage 3 (indexing) complete, the wizard
enters a **guided flow** controlled by `wizardFlowPhase`:

```
'running' → 'medications' → 'summary' → 'done'
```

**Phase: 'running' → 'medications' (automatic)**

The wizard dialog stays open with "Preparing..." spinners on the
Current Medications and Patient Summary checklist items while:
1. Patient Summary is generated via `/api/generate-patient-summary`
   and saved to the server.
2. The subtitle changes to "Preparing health records... Almost done."
3. The Continue/X buttons are hidden to prevent premature dismissal.

Once the summary is saved, the wizard dialog closes and the My Stuff
dialog opens on the **My Lists** tab. Lists.vue auto-processes the
Apple Health file (if present), extracts category lists, and uses AI
to generate Current Medications from the medication records.

The user reviews, edits, and verifies the Current Medications.

**Phase: 'medications' → 'summary'**

When the user saves/verifies medications, the My Stuff dialog switches
to the **Patient Summary** tab. If a pre-generated summary exists, it
is updated with the verified medications. Otherwise, a new summary is
generated.

**Phase: 'summary' → 'done'**

When the user saves or verifies the Patient Summary, the guided flow
completes. The wizard emits `'wizard-complete'` and My Stuff stays
open for the user to explore.

**Guided Flow Dismissal Handling**

If the user closes My Stuff during the guided flow:
- First dismissal: dialog reopens on the same tab (via `nextTick`).
- Second dismissal in 'medications' phase: skips to 'summary' phase,
  reopens on Patient Summary tab.
- Second dismissal in 'summary' phase: completes the wizard without
  summary verification.

`guidedFlowDismissCount` tracks dismissals per phase and resets on
each phase transition.

### Wizard State Persistence

- `wizardFlowPhase` is **not persisted** to storage — it resets to
  `'done'` on page reload.
- On reload, a resume watcher checks whether indexing is complete and
  agent is ready but medications/summary are still pending. If so, it
  re-enters the appropriate phase and reopens My Stuff.
- `wizardAutoFlow` flag is stored in `sessionStorage.wizardMyListsAuto`
  to tell Lists.vue to auto-process files.
- `autoProcessInitialFile` flag is stored in
  `sessionStorage.autoProcessInitialFile`.

### Wizard Logging

Every stage transition and modal open/close is logged to the setup log
file via `POST /api/wizard-log`. The `logWizardEvent()` function in
Lists.vue and `addSetupLogLine()` in ChatInterface.vue handle this.
Progress entries are written every ~60 seconds during polling.

Tab opens are emitted by MyStuffDialog via `'tab-opened'` events and
logged by ChatInterface's `handleMyStuffTabOpened()`. Brief Saved Files
tab opens (< 1 second) are suppressed.

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
2. Adds log entries: "Cloud account deleted by user" (bold) and
   "Local backup preserved in folder for restore"
3. Regenerates `maia-log.pdf` with the deletion entries
4. Calls `POST /api/self/delete`, which runs
   `deleteUserAndResources(userId)`:
   - Deletes Spaces files under `{userId}/`
   - Deletes Knowledge Base by stored `kbId`
   - Deletes Agent by `assignedAgentId` + scans for orphan agents
   - Deletes session documents
   - Deletes the user document from CouchDB
5. Clears IndexedDB snapshot with `keepDirectoryHandle: true` — this
   preserves the folder handle so `discoverUsers()` can find the user
   and show an orange-bordered card with RESTORE button
6. Resets auth state (back to Welcome page)

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

**Modal: RestoreWizard component** (persistent dialog with X close button)

Runs automatically on mount — no user interaction required. The user can
close the dialog mid-restore via the X button; the restore continues in
the background.

Emits `restore-log` events at each step, which App.vue forwards to
ChatInterface's `addSetupLogLine()`. The log starts with a bold
"Restore started" entry listing file count, medications, and summary
availability.

- **Step 1**: Upload files from local state → `POST /api/files/upload`
  and register metadata (each file logged individually)
- **Step 2** (parallel): Deploy agent → `POST /api/sync-agent?create=true`
- **Step 3** (parallel): Index KB → `POST /api/update-knowledge-base`
- **Steps 4-7**: Restore medications, patient summary, saved chats,
  and agent instructions from the local state snapshot via
  `POST /api/restore` (each item logged)
- **Step 8**: Restore My Lists markdown via
  `POST /api/files/lists/restore-markdown`

After RestoreWizard completes, a bold "Restore complete" log entry is
added with a summary, and `maia-log.pdf` is regenerated.

### Post-Restore Verification

After the RestoreWizard completes:
- Folder identity is re-stamped with the current userId
- A personalized `.webloc` shortcut is written
- Local state snapshot is updated
- Agent status is checked to confirm endpoint is ready
- ChatInterface's `loadProviders()` is triggered (via `restoreActive`
  watcher) so the AI dropdown switches from "Anthropic" to "Private AI"
- `maia-log.pdf` is regenerated with all restore log entries

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

### The Discovered Users System

User discovery has been refactored from a localStorage-based
`knownUsers[]` array to a dynamic **`discoverUsers()`** function that
scans IndexedDB for stored `FileSystemDirectoryHandle` entries.

Each discovered user is represented by a `DiscoveredUser` interface:
- `userId` — unique identifier (e.g. "chloe73")
- `displayName` — patient name extracted from `.webloc` or state file
- `folderName` — local folder name
- `handle` — `FileSystemDirectoryHandle` (if permission granted)
- `cloudStatus` — `'ready'` | `'loading'` | `'restore'`

The Welcome page displays a card for each discovered user with their
current cloud status, determined by checking server-side existence.

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

---

## 10. Recently Fixed Issues

The following issues were identified and fixed:

- **Patient Summary "I'm sorry" blocking wizard flow**: When the AI
  returned a refusal like "I'm sorry..." as the summary (due to KB not
  yet indexed), the medications→summary transition would display this
  text and stop, requiring manual user action. **Fixed** by always
  triggering `'generate-summary'` or `'update-summary-meds'` when
  transitioning from medications to summary phase, instead of skipping
  the action when medications didn't change.

- **Verify dialog interrupting wizard**: During the wizard medications
  phase, the verify prompt dialog appeared immediately, removing the red
  EDIT/VERIFY button borders. **Fixed** by suppressing the dialog during
  `wizardAutoFlow` and keeping `needsVerifyAction` true when dismissed.

- **Edit mode flash during wizard**: Medications briefly showed in edit
  mode (blank textarea) before data loaded. **Fixed** by deferring to
  file processing during wizard flow instead of opening manual entry.

- **Patient Summary tab flash**: Stale or loading content briefly
  appeared when switching to the summary tab. **Fixed** by always
  setting `loadingSummary = true` on tab switch.

- **Orange badge missing after DELETE CLOUD ACCOUNT**: The
  `clearUserSnapshot` function was removing the directory handle from
  IndexedDB, making the user invisible to `discoverUsers()`. **Fixed**
  by adding `keepDirectoryHandle: true` option.

- **RESTORE button missing from orange badge**: Dropped during the
  Welcome page refactor from `knownUsers` to `DiscoveredUser`.
  **Fixed** by re-adding a conditional RESTORE button.

- **`ku.userId` reference error**: Lines in `handleUserCardRestore`
  referenced old parameter name `ku` instead of `du` after refactor.
  **Fixed** by updating to `du.userId`.

- **maia-log not updated during DELETE CLOUD ACCOUNT**: No logging
  mechanism existed for App.vue to write to the setup log. **Fixed**
  by exposing `addSetupLogLine` and `generateSetupLogPdf` via
  `defineExpose` on ChatInterface.

- **RestoreWizard had no close button**: Unlike the Setup Wizard, the
  restore dialog was persistent with no X button. **Fixed** by adding
  an X close button that allows the restore to continue in the
  background.

- **RestoreWizard was a logging black hole**: Zero `addSetupLogLine`
  calls throughout the entire restore process. **Fixed** by adding
  `restore-log` emit events at each step, forwarded through App.vue
  to ChatInterface's setup log.

- **Provider selection not updating after restore**: The AI dropdown
  showed "Anthropic" instead of "Private AI" after restore because
  `loadProviders()` wasn't triggered. **Fixed** by adding a watcher
  on `restoreActive` that calls `loadProviders()` when restore
  completes.

- **Lists Source File footer shown during wizard**: The "LISTS SOURCE
  FILE" section appeared during the guided flow. **Fixed** — template
  already has `&& !wizardAutoFlow` guard.

- **Dialog-to-dialog transition flash**: The wizard closing before
  My Stuff opened could cause a single-frame flash. **Fixed** — code
  now opens My Stuff before closing the wizard (same tick, Vue batches).

- **Setup wizard logging gaps**: Several transitions were not logged:
  initial 'running' phase entry, reload-triggered phase resumption,
  and first guided-flow dismissals. **Fixed** by adding
  `addSetupLogLine` calls at all six locations (Chrome/Safari running
  entry, two reload resume paths, two first-dismiss paths).

---

## 11. Remaining Known Issues and Improvement Suggestions

### Issue: Lists component not wrapped in KeepAlive

The Lists component inside MyStuffDialog's tab panel is recreated every
time the user switches away and back. This means `onMounted` re-runs,
triggering `loadCurrentMedications()`, `checkInitialFile()`, and
potentially `attemptAutoProcessInitialFile()` again. During the wizard
flow, this can cause redundant API calls and brief UI flashes.

**Suggestion**: Either wrap Lists in `<KeepAlive>` so it preserves
state across tab switches, or add guards in `onMounted` to detect that
the component was previously initialized for this session.

### Issue: Two separate onActivated hooks in Lists.vue

Lists.vue has two `onActivated()` hooks at different locations (lines
2179 and 2535). Both fire independently when the component is
re-activated. The first handles wizard/verify state; the second handles
category reloading and auto-processing. This separation makes the
activation flow harder to reason about and increases the risk of
competing triggers.

**Suggestion**: Merge into a single `onActivated` hook with clear
sequential logic.

### Issue: Reload handling is fragile for both wizards

**Setup Wizard**: `wizardFlowPhase` resets to `'done'` on every page
reload. A resume watcher tries to detect mid-flow state by checking
server-side flags. This mostly works but:
- If the user reloads during the 'running' phase (indexing in progress),
  the wizard dialog disappears. When indexing later completes, the
  wizard dialog suddenly reappears — potentially confusing.

**Restore Wizard**: If the user reloads during a restore, the wizard
state is completely lost. The restore processes continue on the server
but the UI has no way to resume or show progress. The user sees a
normal chat interface with no indication that restore is still running.

**Suggestion**: For both wizards:
1. Persist wizard state to sessionStorage (`wizardFlowPhase`,
   `restoreActive`, current step).
2. On reload, detect active wizard state and show an appropriate
   "Resuming..." indicator.
3. For RestoreWizard, poll server-side status to determine what has
   already completed and resume the checklist accordingly.
4. Add a `workflowStage: 'restoring'` value to CouchDB that blocks
   the setup wizard from launching during an active restore.

### Issue: No guard rails on user tab switching during guided flow

During the guided flow, the user can freely click other tabs (Saved
Files, Privacy, Diary, etc.), breaking the expected flow. There are no
warnings, no prevention, and no easy way back.

**Suggestion**: Either disable non-relevant tabs during the guided
flow, or show a "Return to {current step}" banner when the user
navigates away.
