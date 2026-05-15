# Restore (and Setup) Resilience to Page Reload

Last revised: 2026-05-14
Version: v1.3.37+

This document describes how MAIA's Setup Wizard and Restore Wizard cope with
the user reloading the browser tab mid-flow, what state survives across the
reload, and how the two wizards distinguish themselves on boot.

## The situation

MAIA has two wizard flows the user can land in immediately after sign-in:

- **Setup Wizard** — runs once per account, after a new user signs up and
  picks a local folder. Uploads PDFs, deploys the agent, indexes the KB,
  drafts a Patient Summary, extracts Current Medications, lets the user
  verify both, then exits.

- **Restore Wizard** — runs when a user re-attaches a previously-used folder
  to a recreated account. Re-uploads files based on `maia-state.json`,
  re-creates the KB, redeploys the agent, restores Current Medications +
  Patient Summary + saved chats + agent instructions from the snapshot, then
  exits.

Both wizards take several minutes (KB indexing alone is 5–25 min on a
typical 4-PDF set). During that time the user may legitimately reload
the tab — refreshing Chrome, navigating away by mistake, restarting the
browser. Before the changes described here, a mid-flow reload had two
distinct failure modes:

1. **Reload mid-Restore showed Setup instead.** The Restore Wizard's
   in-progress state (`showRestoreWizard`, `restoreWizardLocalState`,
   `localFolderHandle`) lives in in-memory Vue refs in `App.vue`. Reload
   resets them all to `false` / `null`. On reload, `App.vue` saw a signed-in
   user with no Patient Summary on `userDoc` yet and the auto-show logic in
   `ChatInterface.vue` fired the **Setup** Wizard instead of resuming the
   Restore.

2. **Setup re-fired after a successful Restore.** The Restore Wizard
   committed `currentMedications` and `patientSummary` to the user doc, but
   `ChatInterface.vue`'s `wizardPatientSummary` ref stayed at its boot
   default (`false`) because nothing called `refreshWizardState` after
   Restore completion. The `shouldHideSetupWizard` computed property
   evaluates `(!wizardRestoreActive && wizardPatientSummary)`; with the
   right-hand side false, Setup auto-shows again, ~10 minutes later
   (whenever the next user-status watcher fires).

A third, related issue: `maia-state.json` is the snapshot the Restore Wizard
reads from. If the snapshot was written at an unfortunate moment (e.g.
mid-sign-out, after the in-memory `currentMedications` was already cleared
but before the user-doc was re-fetched), the snapshot may be missing fields
even though the prior Setup had verified them. Restore then has nothing to
restore. Nothing on the maia-log.pdf told the user *why* the post-restore
Saved Files / Current Medications tabs were empty.

## The mechanism

### 1. Restore-in-progress sentinel

`src/utils/localFolder.ts` exports three helpers:

```ts
export function setRestoreActive(userId: string, source?: ...): void
export function clearRestoreActive(): void
export function getRestoreActive(): RestoreActiveSentinel | null
```

The sentinel is a `localStorage` entry at key `maia:restore-active` with
shape `{ userId, startedAt, source }`. It's set at every site that launches
the Restore Wizard:

- Welcome → "Continue with this account" (App.vue:1107)
- TEST-mode auto-run (App.vue:2049)
- Cloud-health "Restore" button (App.vue:2362)
- Destroyed-account dialog "Restore" (App.vue:2681)

It's cleared in three places:

- `handleRestoreWizardComplete` (success path)
- `watch(showRestoreWizard)` (catch-all for cancel / outside-click / ESC)
- The `onMounted` resume path itself, if it can't read maia-state.json

The folder handle survives the reload independently in IndexedDB via
`storeDirectoryHandle(userId, handle)` — that storage was already there for
"recognize the folder on next sign-in", we just piggy-back on it.

### 2. Boot-time resume

In `App.vue`'s `onMounted`, right after `/api/current-user` returns
authenticated, the code now:

1. Reads the sentinel.
2. If it's present and the `userId` matches the signed-in user:
3. Calls `readStateFileByUserId(userId)` which:
   - Looks up the folder handle from IndexedDB
   - `queryPermission({ mode: 'readwrite' })` against it
   - Reads `maia-state.json` from the folder
4. If both succeed, sets `localFolderHandle.value`,
   `restoreWizardLocalState.value`, `suppressWizard.value = true`,
   `showRestoreWizard.value = true`. The Restore Wizard re-opens at the
   start of its flow and walks through its checklist; steps that were
   already done last time (e.g. agent already deployed) complete fast.
5. If either step fails (no handle, permission revoked, file missing or
   corrupt), the sentinel is cleared so subsequent reloads don't loop, and
   the normal Setup/Welcome flow proceeds.

The Restore Wizard's `executeRestore` is **idempotent in practice**:
re-uploads overwrite the same bucket key, agent-deploy poll exits quickly
when the agent is already running, `/api/update-knowledge-base` detects
an active indexing job and reuses it instead of starting a second, and
`/api/restore` is a single coordinator that PATCHes user-doc fields. So
resuming mid-flow may repeat work but does not corrupt state.

### 3. Sync wizard flags after Restore completes

`handleRestoreWizardComplete` in `App.vue` now calls
`chatInterfaceRef.value.refreshWizardState()` after Restore success, which
re-fetches user-status and patient-summary and writes the in-memory wizard
flags (`wizardPatientSummary`, `wizardCurrentMedications`,
`wizardStage1Complete`). `refreshWizardState` was already exposed on the
ChatInterface but had to be added to the `defineExpose` block to be
callable through the parent ref. Without this sync the Setup Wizard's
auto-show watcher fires after a few seconds of idle.

### 4. State-incompleteness log entry

`RestoreWizard.executeRestore` now inspects the snapshot at start and emits
`restore-state-incomplete` with a `missing` array (e.g.
`["Current Medications", "Patient Summary"]`) when fields the user has
likely already filled in are absent from `maia-state.json`. The maia-log.pdf
renderer turns this into:

```
[HH:MM:SS] maia-state.json is missing: Current Medications, Patient Summary
           — manual entry will be required after restore
```

so the user / support can see exactly why a tab is empty after Restore.

## What is **not** persistent across reload

The following Setup-Wizard substate is still in-memory only and is reset by
reload. The Setup Wizard's own boot logic (driven primarily by user-doc
state) usually recovers, but it's worth knowing:

| State | Where | Reset on reload |
|---|---|---|
| `wizardFlowPhase` (`running` / `medications` / `summary` / `complete`) | `ChatInterface.vue` | Yes |
| `localFolderAutoRunActive` / `localFolderAutoRunPhase` | `ChatInterface.vue` | Yes |
| `stage3IndexingStartedAt` (the timer) | `ChatInterface.vue` | Persisted to sessionStorage when indexing starts; recovered if the indexing job is still running on the server |
| `preGeneratedSummary` (the draft text held in a ref) | `ChatInterface.vue` | Yes, but recoverable from `userDoc.draftPatientSummary` via `/api/patient-summary` GET (which now returns the draft when no committed summary exists) |
| Wizard auto-run mid-upload progress | `ChatInterface.vue` | Yes — the wizard re-scans the folder and re-attempts the upload loop. Files already uploaded are skipped by the read-after-write check. |

A future improvement would be a Setup-Wizard sentinel mirroring the Restore
one, plus a periodic heartbeat (every 5 s) so we know within seconds of
reload whether to resume Setup or start fresh. That work is deliberately
out of scope here.

## How to test

### Test 1 — Reload during Restore
1. From a clean state, sign in and Restore.
2. While Restore is mid-flow (e.g. during "Indexing knowledge base…"),
   reload the tab.
3. Expected: after the auth check, the Restore Wizard re-opens to its
   checklist view and resumes. The maia-log.pdf should *not* start a
   "--- Setup ---" section after the partial restore.

### Test 2 — Successful Restore + idle wait
1. Run Restore through to "Restore complete".
2. Don't touch anything for 5–10 minutes.
3. Expected: the Setup Wizard should *not* auto-show. `shouldHideSetupWizard`
   evaluates true because `refreshWizardState` populated
   `wizardPatientSummary` from the user-doc.

### Test 3 — Restore with incomplete snapshot
1. Sign up, do a full Setup so Current Medications and Patient Summary
   are saved.
2. Open the local folder in Finder and edit `maia-state.json` — remove the
   `currentMedications` field.
3. Sign out, delete cloud account, Restore.
4. Expected: a `maia-state.json is missing: Current Medications` line
   appears near the start of the `--- Restore ---` section of
   maia-log.pdf. The user can manually enter meds afterward.

### Test 4 — Reload during Setup (no resume yet)
1. Pick a folder, let Setup start uploading.
2. Reload during upload.
3. Expected: Setup Wizard re-launches and re-runs from upload phase (this is
   the **existing** Setup auto-show behavior; it works because
   `userDoc.workflowStage` and folder presence drive the launch). Eventually
   reaches the same "Setup complete" state as if no reload had happened.

## Sentinel key reference

```
localStorage['maia:restore-active'] = JSON.stringify({
  userId: 'jane42',
  startedAt: '2026-05-14T21:48:21.123Z',
  source: 'welcome'   // or 'cloud-health' | 'destroyed-account' | 'test-mode'
})
```

Clearing this key (e.g. via DevTools Application → Local Storage) is a
safe way to recover from a stuck "always tries to resume Restore" state.
The next reload will fall through to the normal welcome / setup flow.
