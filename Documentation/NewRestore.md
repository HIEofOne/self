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

## Known follow-up issues (out of scope here)

These surfaced during multi-cycle Restore testing but are not caused by
the changes above. They are pre-existing and worth fixing in their own
focused changes:

### `ensureUserAgent` has no timeout/retry around `doClient.agent.create`

If the DigitalOcean GenAI API hangs (`undici TimeoutError` after the
default 5 minutes), the unhandled rejection takes down the whole Node
process. Observed during a long test session — backend exited with stack
trace:

```
DOMException [TimeoutError]: The operation was aborted due to timeout
  at AgentClient.create (lib/do-client/agent.js:84)
  at ensureUserAgent (server/routes/auth.js:335)
  at server/routes/chat.js:489
```

Recommended fix: wrap `agent.create` (and the other unbounded `doClient`
calls along that path) in a try/catch with a sane per-call timeout, and
have callers either fail the request cleanly or queue a retry. A
process-level `unhandledRejection` handler would also be defense in
depth — currently any background promise rejection from the DO SDK can
kill the server.

### `resend` package is referenced but not installed

When the admin-notification path fires on cloud-account events
(account-deleted, etc.) the server logs:

```
[NOTIFY] ❌ Email notification failed: Cannot find package 'resend'
  imported from server/index.js
```

The notification feature is gated by `process.env.RESEND_API_KEY` being
set, so this fails silently in normal runs, but the import is at the top
of the call site and throws even when the feature is disabled. Either
add `resend` to `package.json` dependencies, or move the import inside
the function and gate it on the env var.

Neither of these affects the Restore-resume / Apple-Health-preservation
work described above. Filing here so they aren't lost.

---

# Backup & Restore: design fragility and a path to bulletproof

The fixes earlier in this document patched a series of bugs in the
Setup → sign-out → Restore path. Each one removed one specific way the
Apple Health designation, the Current Medications list, the Patient
Summary, or the My Lists categories could be lost. After ~10 commits
the symptom **still recurs**: the user sees a successful "Restore
complete" log but the Apple Health badge is missing from Saved Files,
or categories don't appear, or a fresh draft summary overwrites the
restored one.

This is not a bug in any single function. It is a **design** problem.
This section names the design problem, lists the cases that break, and
sketches what would make it bulletproof. Future work on Setup / Restore
should reference this section instead of adding another patch.

## Why it stays fragile

### Too many setters, no chokepoint

The Apple Health designation (`isAppleHealth: true` on a
`userDoc.files[]` entry) can be written from **nine** different code
paths today:

| # | Caller | Endpoint | Source of the flag |
|---|---|---|---|
| 1 | ChatInterface `runAutoWizard` | `POST /api/user-file-metadata` | `detectAppleHealthFromBucket` (PDF first page) |
| 2 | ChatInterface `runSafariFolderWizard` | `POST /api/user-file-metadata` | `detectAppleHealthFromBucket` |
| 3 | ChatInterface `handleFileSelect` (manual upload) | `POST /api/user-file-metadata` | `detectAppleHealthFromBucket` |
| 4 | ChatInterface `uploadPDFFile` | `POST /api/user-file-metadata` | `detectAppleHealthFromBucket` |
| 5 | ChatInterface `uploadTextFile` | `POST /api/user-file-metadata` | `false` (text never AH) |
| 6 | MyStuffDialog rehydration (line 1495) | `POST /api/user-file-metadata` | `detectAppleHealthFromBucket` |
| 7 | MyStuffDialog upload (line 4750) | `POST /api/user-file-metadata` | `detectAppleHealthFromBucket` |
| 8 | RestoreWizard `uploadFile` | `POST /api/files/register` | state-derived OR `false`, with post-upload first-page parse as fallback |
| 9 | server `process-initial-file` self-heal | direct CouchDB write | content match on full markdown |

Plus **`/api/archive-user-files`** can push a *new* entry to
`userDoc.files[]` if it finds a root-level file in S3 with no matching
entry in the document — and that new entry has no `isAppleHealth`
field at all (server/index.js:5209). That's a **tenth** path that
silently de-flags a file under the right race.

There is no schema for what a "file write" means and no place where
all writes converge. Every new feature that touches files re-implements
the detection.

### Detection runs at write time, never re-validates

`isAppleHealth` is set when the file is *first* registered. From then
on, nothing re-checks the underlying PDF. Consequences:

- If the user **replaces** the Apple Health export with a newer one
  (same filename — Apple's export always names it
  `Health Records - <Patient> - <date> at <time>.pdf` with a fresh
  date), the S3 object changes but the `userDoc.files[]` entry's
  `isAppleHealth` stays whatever it was, and crucially
  `appleHealthCategoriesBuiltAt` is also "true forever". The Lists
  categories are computed from the *old* PDF and never refresh.

- If the user **removes** the Apple Health file and adds a different
  one, `appleHealthCategoriesSourceKey` still points at the deleted
  object. Categories stay stale until the user manually clicks
  refresh.

- If the original Setup's `detectAppleHealthFromBucket` failed for
  *any* reason (network blip, `parse-pdf-first-page` 500, race with
  S3 eventual consistency), the flag is `false` and stays `false`.
  No safety net.

### Two parallel record types: the file list and the "initial file"

`userDoc.initialFile` is a single object — the AH file from
registration time. `userDoc.files[]` is the list. They drift:

- `process-initial-file` keys off `initialFile.bucketKey` to find
  the file in `userDoc.files`, then checks `isAppleHealth` on that
  entry. If `initialFile` is stale (points at a previous bucketKey
  after a toggle / archive cycle), the lookup misses and category
  extraction silently no-ops.

- Restore today does **not** restore `userDoc.initialFile`. Even
  with the categories rebuild fix from earlier in this document,
  post-Restore `userDoc.initialFile` is `null`, so any later code
  that goes through it (Lists tab, certain wizard restarts) starts
  empty-handed.

### Two parallel detection mechanisms: filename and content

Before the recent commits, six call sites used `/^apple/i.test(name)`.
The real Apple Health export does not start with "apple" — Apple
names it `Health Records - <Patient> - …pdf`. Those six checks all
silently mis-classified the real export and stayed wrong forever.
The fixes removed them but the architecture invites the bug back: the
next dev who adds an Apple-Health-aware feature will reach for the
filename, see it works in their test with `applehealth.pdf`, and
re-introduce the heuristic.

### Frontend reads from four caches that can disagree

| Source | Where | Used by |
|---|---|---|
| `userDoc.files[i].isAppleHealth` | server | source of truth |
| `appleHealthFileInfo` ref | `Lists.vue` | meds-extract path, Lists UI |
| `categoriesList` ref | `Lists.vue` | the actual categories panel |
| `file.isAppleHealth` on files row | `MyStuffDialog.vue` Saved Files tab | the badge in the screenshot |
| `item.isAppleHealth` | `RestoreWizard.vue` checklist | Restore UI |
| `restoreWizardLocalState.files[i].isAppleHealth` | `App.vue` | passes to Restore |

Each cache is populated by its own `load*` function on its own
schedule. After Restore, the *server* may have the right answer in
`userDoc.files` (because `process-initial-file` self-healed), but
`MyStuffDialog.userFiles` was loaded a few seconds earlier from the
pre-self-heal response, so the Saved Files badge stays missing
until the user closes and reopens the dialog. The "Restore loses the
badge" bug the user reported on 2026-05-15 was exactly this:
`userDoc.files` was correct, the UI cache was not.

### maia-state.json is a lossy mirror

`saveLocalSnapshot` reduces `userDoc.files[]` to four fields:
`fileName`, `size`, `cloudStatus`, `bucketKey` (the latest fix added
`isAppleHealth`). Anything else on the file entry is dropped on the
floor at sign-out and unrecoverable on Restore: `addedAt`,
`updatedAt`, `bucketPath`, `fileType`, `mimeType`, any future flag.
A new feature that adds a per-file field (say, `priorIndexingErrors`)
will look correct in dev, work through Setup, then silently lose
itself across one sign-out cycle.

There is also no schema version on `maia-state.json`. An older client
that wrote a snapshot without `isAppleHealth` is indistinguishable
from a current client whose AH detection genuinely returned false on
every file. The Restore code has to guess.

## The cases that break (catalog)

1. **First Restore from an old snapshot.** `maia-state.json` predates
   the AH-preservation fix. State has no flag. Restore's fast-path
   finds nothing; the slow path used to only look at *added* files and
   so found nothing either (now fixed, but only once). Categories
   never built.

2. **Restore after a partial Setup (page reload mid-flow).** Setup
   detected AH and called `/api/user-file-metadata`, but `setupWizard`
   crashed between AH detection and the metadata POST. `userDoc.files`
   has the file with no AH flag. Subsequent sign-out writes a snapshot
   that confirms the false negative. Restore has no way to know.

3. **User replaces Apple Health PDF with a newer export.** Same
   filename pattern, new content (more conditions, different med list).
   `userDoc.files[i].bucketKey` is unchanged (or differs only in the
   timestamp portion). `appleHealthCategoriesBuiltAt` is still set,
   so Lists shows the old categories forever. Same drift in the
   meds-from-AH extraction.

4. **User adds a non-AH PDF mid-session.** Goes through
   `runAutoWizard`'s upload path. AH detection runs but returns false.
   No problem here — but the file's metadata POST happens *concurrently*
   with `runAutoWizard`'s next file, and a 409 conflict on userDoc
   can drop the second file's `isAppleHealth: true` if the conflict
   retry re-reads a stale doc.

5. **User deletes the Apple Health file from the folder.** Folder
   diff detects "removed". Restore skips uploading it. But
   `userDoc.appleHealthCategoriesBuiltAt` is still set, so a future
   Lists view still shows categories from a file that doesn't exist
   in the KB anymore.

6. **`/api/archive-user-files` runs and creates a new entry.** When
   Saved Files is opened, this endpoint scans S3 for root-level files
   and moves them to `archived/`. If it finds a file with no matching
   `userDoc.files` entry, it pushes a new entry with no
   `isAppleHealth` field. The badge disappears even though the
   underlying PDF is the same.

7. **A second Restore on the same machine, same folder, different
   account.** `userDoc.files[i].isAppleHealth` from the previous user
   is gone (different userDoc), and `maia-state.json` is now for a
   different userId. The folder picker on Restore re-reads state — if
   the state's `userId` doesn't match, things get unpredictable.

8. **Server-side ChatInterface vs. MyStuffDialog race during
   rehydration.** Both paths call `/api/user-file-metadata` for the
   same bucketKey within seconds (line 1495 in MyStuffDialog, then
   ChatInterface's runAutoWizard for the same file). Last-write wins
   on CouchDB. The first call's `isAppleHealth: true` is overwritten
   by the second call's `isAppleHealth: false` (or vice versa)
   depending on which detection lap finished first.

9. **User signs in on a second device.** Folder picker on device 2
   reads `maia-state.json` from cloud-sync'd disk. Server's
   `userDoc.files` for that user was built on device 1. Both have AH
   flags, but if device 2's client version is older it may drop
   them on the next sign-out.

10. **Account recreate without local snapshot.** User deletes cloud,
    has no backup. Account recreated. They re-upload the Apple Health
    PDF manually via MyStuffDialog (line 4748 path). That path uses
    `detectAppleHealthFromBucket`, so the flag should be set. But if
    detection fails silently (no error UI), the user sees a working
    Saved Files tab with no badge and no idea why.

## What "bulletproof" would look like

Three principles, in priority order:

### 1. **One server-side chokepoint that owns the flag**

Every file write to `userDoc.files[]` — from any caller — goes through
one server function that, before saving, reads the uploaded PDF's first
page from S3 and decides `isAppleHealth` itself. Clients never *send*
the flag; the server *derives* it. The signature stops being
`{ fileName, bucketKey, ..., isAppleHealth }` and becomes just
`{ fileName, bucketKey, ... }`. Detection is a server concern.

This collapses #1–#7 in the setters table into one function, removes
the regex bug surface entirely (clients can't introduce a filename
heuristic because they don't decide), and gives us one place to add
caching, logging, error handling.

Implementation sketch:

```
POST /api/files/register-with-detect  (or fold into existing register)
  body: { fileName, bucketKey, fileSize? }
  server:
    1. await classify(bucketKey)         // reads first page, returns { isAppleHealth }
    2. upsert userDoc.files entry with classification result
    3. if isAppleHealth and !userDoc.appleHealthCategoriesBuiltAt:
         queue category extraction (don't block the response)
    4. emit `file-classified` event so frontends invalidate caches
```

### 2. **Re-validate on every read of "Apple Health files"**

The AH file isn't a static fact; it's a derived property of "which file
in S3 contains the Apple Health export footer". The single source of
truth should be checked, not cached forever.

Concretely: instead of `appleHealthCategoriesBuiltAt` being a boolean
"have we ever built", make it a content hash:
`appleHealthCategoriesSourceETag` plus `appleHealthCategoriesSourceKey`.
On every Lists view:

1. Server resolves which file is the AH file (`userDoc.files.find(f =>
   f.isAppleHealth)`).
2. Compare its current S3 `ETag` against
   `appleHealthCategoriesSourceETag`.
3. If they differ (replaced file) or `bucketKey` differs (moved file)
   or no AH file in the list (removed), trigger rebuild and update.

This makes case #3 (replace) and case #5 (remove) auto-correct without
a manual click.

### 3. **`maia-state.json` should be authoritative for the *folder*, not the *user*. The userDoc should be authoritative for the *user*.**

Today `maia-state.json` is a *partial* snapshot of `userDoc` plus the
folder's file list. Restore tries to rebuild `userDoc` from this
snapshot. The two roles are mixed, and every field we add to one needs
manual mirroring to the other.

A cleaner split:

- `maia-state.json` holds **only** what cannot be recovered from cloud:
  the folder's PDF inventory (filenames + sizes + mtimes), the user's
  device/local preferences, and a pointer (`userId`) to the cloud
  account it belongs to. Nothing about agent state, summaries, meds,
  or AH flags — those are recovered *from cloud*.

- Restore = "this user wants to sign back into their cloud account
  from this folder". The server's userDoc rebuild from cloud backup
  (the maia_accounts_backup CouchDB collection we already maintain, or
  a fresh re-derivation) is the single source of truth.

- The Restore Wizard's job becomes: re-upload the files from the
  folder, then call **one** `/api/account/rehydrate` that does the
  whole reconciliation server-side: agent, KB, files, AH detection,
  category extraction, summary, meds, instructions, chats. No
  client-side orchestration of those nine endpoints.

This removes the duplicated MaiaState schema and the `/^apple/i`
heuristic from the wire entirely. It also fixes case #2 (mid-flow
crash leaves bad userDoc): re-running rehydrate is idempotent.

## A leaner implementation plan

Not all of the above has to ship at once. In order of impact-per-line:

### Phase 1 — Stop the bleeding (a few hours)

- Add `/api/files/audit` server endpoint that:
  - lists every file in `userDoc.files[]`
  - for each, fetches its first PDF page via existing
    `parse-pdf-first-page`
  - flips `isAppleHealth` based on content
  - if the AH file's bucketKey differs from
    `appleHealthCategoriesSourceKey`, clears
    `appleHealthCategoriesBuiltAt` so categories rebuild next view
  - returns `{ changed: number, appleHealthBucketKey: string|null }`
- Call it from `handleRestoreWizardComplete` *after* `markRestoreComplete`,
  and from MyStuffDialog after `loadFiles` if the AH badge would be
  inconsistent with what `loadAppleHealthStatus` finds.
- Remove the front-end `detectAppleHealthFromBucket` calls and the
  client-passed `isAppleHealth` body fields once the audit is the
  single source.

That alone closes cases #1, #2, #6, #7, #10.

### Phase 2 — Schema version + auto-heal (half a day)

- Add `version` field to `MaiaState`. Bump on every schema change.
- Backup-version mismatch on Restore triggers a server-side
  `/api/files/audit` automatically and a one-line maia-log.pdf entry:
  `Snapshot from v3 client — re-detecting Apple Health from PDF content`.

### Phase 3 — Content-hash on category extraction (half a day)

- Store `appleHealthCategoriesSourceETag` alongside the bucketKey.
- On every Lists view fetch, compare to the live S3 `HEAD`. Diff →
  rebuild.

Closes cases #3, #5.

### Phase 4 — Single rehydrate endpoint (1–2 days)

- Collapse the 9 file-touching endpoints into one
  `POST /api/account/rehydrate` that takes the folder file list and
  rebuilds everything. Client just sends the list and uploads the
  bytes; the server decides everything else.

Closes the "next dev re-introduces a heuristic" risk for good.

## Net suggestion

Stop adding restore-path patches. The next thing we do in this area
should be Phase 1 — the audit endpoint — because (a) it removes more
existing bug surface than every patch we've written combined, and
(b) every future patch we'd otherwise write becomes redundant.
