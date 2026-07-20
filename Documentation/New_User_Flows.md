# New User Flows — inventory, failure retrospective, and refactor proposal

Written 2026-07-19 after the stabilization marathon (PRs #189–#204), before
promoting agropper main. Companion to `SummaryPipeline.md` (the summary/meds
data-path map). This document is about the USER-FACING flow surface: who the
new users are, where files enter, every modal they can meet, what broke, and
how to make it stop breaking.

---

## 1. The kinds of new users

Every axis below multiplies the flow matrix. Six binary-ish axes ≈ dozens of
real paths, and most of today's bugs lived in combinations nobody had walked.

| Axis | Values | What it changes |
|---|---|---|
| Arrival | **Invited** (join link/invite → landing → quick-start → Sharing Policies) vs **would-be-admin** (welcome page → Set up a group / Get your own MAIA) | Invitees skip the welcome, auto-quick-start, land on Sharing Policies with the join card; admins see the full fork |
| Records | **Has an Apple Health file** vs not (vs Epic-only PDFs) | AH file unlocks deterministic Lists (categories, meds candidates, encounters, OOR labs); without it, Lists is manual + agent worksheets |
| Browser | **Chrome** (File System Access API) vs Safari (one-shot folder read) vs other | Folder connection, auto-backup, and TEST are Chrome-only; ADD FILES + downloads are the universal floor |
| Local folder | **Has/creates a MAIA folder** vs none | Folder = auto-written maia-state.json, maia-log.pdf, webloc shortcuts; no folder = BACKUP button/downloads only |
| Restorable | **Folder contains a restorable maia-state.json** vs fresh | Restore Wizard path vs new-account path; the get-started chooser branches here |
| Tier intent | **Chat-first** (quick start, no records — the Groups adoption floor) vs **records-first** | Quick start ends at `chat_ready`; records path runs index → verify → summary |

## 2. Workbook tabs (and one non-tab) that touch health record files

| Surface | Role in the file lifecycle |
|---|---|
| **Setup Wizard** | The orchestrator: folder fork, ADD HEALTH RECORD FILES, INDEX MY RECORDS, agent deploy checklist, guided draft→meds→summary flow |
| **Saved Files** | The registry view of `userDoc.files` (bucket contents, KB membership, archived); can move/archive files (a move source of stale-key bugs) |
| **Patient Summary** | Displays/saves the 3 summary slots; REQUEST SUMMARY (gated); per-agent instruction overrides; review dialog is the ONLY save path |
| **Lists** | Deterministic artifacts: meds candidates (+VERIFY — the meds gate's target), categories, encounters, OOR labs; agent worksheets (GPT/Kimi); listsBuild status banner + RETRY; self-heals on open |
| **Chat "+" import** (not a tab) | Uploads to root, registers in `userDoc.files`, detects Apple Health, fires the Lists build, shows the index-nudge modal |

## 3. Modal inventory (new-user + file processing)

IDs: `W` = wizard/chat (ChatInterface), `A` = arrival (App.vue), `S` = summary
(MyStuffDialog), `L` = Lists. "Logged" = an event lands in the provisioning
log (rendered into maia-log.pdf); most dialogs are NOT individually logged —
only the actions behind some of them are.

| ID | Trigger / v-model | Contents & buttons | Logged? |
|---|---|---|---|
| W1 | `showAgentSetupDialog` — "Setting Up Your MAIA" | The wizard. States: fork (bullets + **I have a local MAIA folder / Create a new MAIA folder / Just run the wizard without a local folder / Cancel / TEST**), quick-start link, records-present (**INDEX MY RECORDS (n) / ADD FILES**), agent checklist, guided-flow spinners, **CONTINUE**, X | Yes — `Setup started`, agent deploy, `folderless-index-started`, `quick-start-complete`, kb-indexed, wizard-resumed |
| W2 | `showIndexNudge` — "File saved — make it part of your MAIA?" | Indexing-benefits bullets; **Not yet / Run the Wizard** (auto-starts indexing) | No (the indexing it starts is logged) |
| W3 | `chatSummaryProgress` — SummaryProgress checklist | Scripted steps + open-ended "AI is drafting…" line; no buttons (persistent) | Partially (`draft-summary-call-started`) |
| W4 | `showNewSummaryDialog` — after a chat summary completes | Offer to open the Patient Summary tab (carries the draft to the review dialog); **stay / open tab** | No |
| W5 | `showNeedsIndexingPrompt` — restore detects unindexed KB | **INDEX NOW / not now** | Indexing is logged |
| W6 | `showPostIndexingSummaryPrompt` — "Knowledge Base Updated" | Offer to regenerate the summary; **Not yet / generate** | No |
| W7 | `wizardTimeoutModalVisible` | Agent deploy timeout notice | Yes (timeout event) |
| W8 | `showRequestSentModal` | Approval-pending account notice | No |
| W9 | `showRestoreCompleteDialog` | Restore finished | Yes (restore-complete) |
| W10 | `showPrivateUnavailableDialog` | Private AI not ready | No |
| A1 | `showDevicePrivacyDialog` — "Is this computer private to you?" | **SHARED / PRIVATE** | No |
| A2 | `showGetStartedChoiceDialog` | **Restore <user> / Add a new family member / Cancel** | No |
| A3 | `showNotChromeDialog` — "Chrome Recommended" | **CONTINUE IN THIS BROWSER / get Chrome** | No |
| A4 | `showCreateFolderDialog` — "Create Your MAIA Folder" | Folder naming guidance; create/cancel | Folder events logged |
| A5 | `showConnectFolderDialog` — "Connect Your MAIA Folder" | Reconnect prompt | No |
| A6 | `showTempSignOutDialog` | Temp-account warning; **CANCEL / DELETE <user>** (+ passkey note) | Deletion logged server-side |
| A7 | `showDestroyDialog` / `showDeleteLocalUserDialog` / `showDestroyedRestoreDialog` | Deletion & post-deletion restore flows | Deletion logged |
| A8 | `showCloudHealthDialog` | Cloud/account health check | No |
| A9 | `showGetStartedChoiceDialog` satellites: `showOtherAccountOptionsDialog` ("More Choices"), `showMoreChoicesConfirmDialog`, `showNewAccountConfirmDialog`, `showSharedDeviceWarning` | Account-choice branching | No |
| A10 | `showPasskeyDialog` | Passkey add/sign-in | Passkey events logged |
| A11 | `showWelcomePasteDialog` — "Use an invitation or join link" | Paste field; **Cancel / Continue** | No |
| A12 | Invite landing (full-page, not q-dialog) | Group name, host, policy cards, **MAIA Welcome Page / JOIN** | No |
| S1 | `showReplaceSummaryDialog` — "New Patient Summary Generated" | Rendered draft; **Save as new summary / Replace (per slot) / Close without saving** — THE only save path | Summary saves logged |
| S2 | `showSummaryViewModal` / `showUpdateSummaryDialog` / `showSummaryAvailableModal` | View/update/availability satellites | Partially |
| S3 | `showLocalFolderDeleteReminder` | Folder cleanup reminder | No |
| L1 | `showVerifyPrompt` — "Please verify or edit your Current Medications" | The meds-verification prompt (the meds gate's destination) | `medications-saved` logged |
| L2 | `showRefreshConfirmDialog` / `showSummaryDialog` | Refresh-meds confirm; category summary view | No |
| — | PendingJoinCard (inline card, Sharing Policies/Groups) | Posting policy, suggested-policy note, display name, **JOIN GROUP / DISMISS** | Join logged server-side |

**Observation:** ~30 modals touch the new-user flow; fewer than a third leave
any trace in the provisioning log. When a user reports "I clicked something
and ended up here," we usually cannot reconstruct which dialogs they saw.

## 4. What broke since the wizard split (and why)

The split ("chat before records": quick-start tier ends at `chat_ready`,
records become an any-time upgrade) was the right product call. What it broke
was an ARCHITECTURAL assumption: the wizard was the only path, so ORDER,
TRIGGERS, and STATE TRANSITIONS all lived inside it, implicitly. Opening every
step to every surface exposed each implicit dependency, one bug at a time:

1. **Implicit sequencing became races.** The wizard serialized index → extract
   → verify → summarize. Free-order surfaces generated summaries before meds
   existed ("Not documented in the available records" while candidates sat in
   Lists), forcing the meds gate and index gate to be invented after the fact.
2. **Fire-and-forget triggers.** Lists builds, meds worksheets, and detection
   were one-shot client calls that failed silently (agent not ready, tab
   closed, request lost) — "same code, different outcome." Fixed by persisted
   job state (`listsBuild`), the status banner + RETRY, and Lists self-healing
   on open.
3. **Files move; readers assumed they don't.** Uploads get relocated
   (root → archived, root → KB) by background reconciliation, and every reader
   that trusted a stored bucketKey (Lists build, meds resolver, encounters)
   broke on the stale key. Fixed by location-free filters + fallback search;
   the auto-archiver itself is still unhunted (flagged task).
4. **Three summary generators, two renderers, one contract nowhere.** SEND-
   default fell to ungoverned RAG; citation format was enforced only for
   Radiology; the chat renderer raced the file-list load. Fixed by deleting
   the ungoverned path, top-level citation contract, and the preload.
5. **Auto-saves masqueraded as user intent.** Generated summaries silently
   filled slots (three separate code paths); the review dialog is now the only
   writer.
6. **Gates that warn but don't act create loops.** Verify → request → "index
   first" → request → "index first"… Every gate now performs the action it
   names.
7. **State leaks across sessions/users.** Browser-global rail pref, stale
   join-link captures resurrecting the JOIN page after sign-out, ghost
   welcome banners, chips wiped by unrelated restores. Each fixed by scoping
   state to its owner.
8. **Environment split-brain.** localhost (working tree) vs test.agropper.xyz
   (deploy-lagged main) made several "still broken" reports be version skew;
   the version-number discipline (assert-then-bump) came late.

The meta-cause: **each surface owned a fragment of the pipeline, and no
component owned the pipeline itself.** Every fix that finally held moved
ownership to the right place (Lists owns its artifacts; the review dialog
owns saves; gates own their action; the server owns job state).

## 5. Refactor proposal

Make the implicit pipeline an explicit, server-owned state machine, and make
every surface a *view* of it instead of a *driver* of it.

1. **One `recordsPipeline` state on the userDoc** (extends `listsBuild`):
   `imported → listsBuilt → medsVerified → indexed → summaryDrafted →
   summaryVerified`, each stage with status/timestamps/error, advanced ONLY by
   server-side handlers that are idempotent and re-runnable. `user-status`
   returns it whole; every gate, checklist, banner, and wizard step renders
   from this one object. (The wizard checklist and the SummaryProgress modal
   become the same component reading the same state.)
2. **One trigger API: `POST /api/pipeline/advance`.** Every button and gate
   calls "advance"; the server decides what the next step actually is (build
   lists / await verify / index / draft). Kills the whole class of
   surface-specific trigger bugs — a gate, the nudge, the wizard button, and
   Lists RETRY become the same call.
3. **Bucket keys become lookups, never storage.** A tiny server-side
   `resolveFile(userId, fileId)` that searches root/KB/archived once,
   everywhere (the fallback logic already exists — centralize it and delete
   the per-endpoint copies). Then hunt and neuter the auto-archiver (open
   task) so movement is rare as well as harmless.
4. **Modal diet + logging.** Collapse the ~30 modals toward: one wizard (W1),
   one progress view, one review dialog, one gate toast pattern, and the
   arrival dialogs. Log every modal open/choice as a provisioning event —
   one line each — so any user report can be replayed from maia-log.pdf.
5. **Version/deploy discipline** (process, not code): merge → wait for the
   deploy → test; the assert-then-bump script stays; a `/version` endpoint
   would let the app footer show the deployed hash and end skew debates.

Sequence it like the stabilization plan: (1) pipeline state + advance
endpoint behind the existing surfaces, (2) migrate gates/wizard/Lists to
render from it, (3) delete the surface-specific triggers, (4) modal diet.
Each step is one PR, verified with the real Apple Health export end to end.
