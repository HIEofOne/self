# New-user setup sequence — source of truth

This document defines the target new-user setup experience. It is the spec the
code must match; when behavior and this doc disagree, the doc wins (or the doc
is updated deliberately). It supersedes the setup portion of
`New_User_Flows.md §5`.

## Principles

- **The Setup Wizard modal is the guide.** It is the one good modal. No other
  modals are added; everything else is inline feedback in the Workbook tabs.
- **One next step at a time.** Whenever the wizard is open — including after a
  reload — it shows **one** action button labeled with the next suggested step,
  computed from the server pipeline (`decideNextAction`, `records-pipeline.js`).
- **Closing the wizard (X) is allowed.** It drops the user into chat; the rail's
  Setup Wizard ring keeps spinning while setup is incomplete.
- **The summary is drafted once.** Right after indexing, in the background, with
  progress shown in the wizard. It is **hidden**. Verifying Current Medications
  **patches** that draft (no second AI call) and displays it as the Patient
  Summary. A new AI call happens only if the user explicitly requests a new
  summary later.

## Pipeline stage order

`imported → listsBuilt → indexed → summaryDrafted → medsVerified → summaryVerified`

(Changed from the previous order: `summaryDrafted` now comes **before**
`medsVerified` so the draft exists to patch when meds are verified.)

## Stage → wizard CTA → surface → completion

| Stage (current) | Wizard status row | Single CTA button | On completion |
|---|---|---|---|
| agents deploying | "Deploy … Agent" + elapsed | disabled · "Setting up…" | auto-advance |
| `indexed` (running) | "Index Knowledge Base — {tokens} ({elapsed})" | disabled · "Indexing…" | show **final elapsed + tokens** |
| `summaryDrafted` (running) | Draft row shows the manual PS step-list ("Parsing identity…", "Extracting meds…") + elapsed | disabled · "Drafting summary…" | draft saved to `userDoc.draftPatientSummary` (hidden); show **draft elapsed** |
| `medsVerified` (pending) | — | **"Show Current Medications"** → Lists ▸ Current Medications | user clicks Verify → **patch draft** with verified meds; remove the Lists nav highlight |
| `summaryVerified` (pending) | — | **"Show Patient Summary"** → PS tab shows the patched draft | user clicks Verify (or Edit) |
| `complete` | — | **"Go to chat"** | save PS, close Workbook, **clear imported setup files from chat context**, land on empty "New conversation" |

## The four new-user flavors

| Flavor | Lists / Meds | Sequence |
|---|---|---|
| **No files (group interest only)** | skipped | agents ready → **"Go to chat"** (or "Join {group}" if a group was chosen but not joined). No index/draft/meds/summary. |
| **One file — Apple Health** | yes | index → draft → **Show Current Medications** → verify (patch) → **Show Patient Summary** → verify → chat |
| **One file — not Apple Health** | skipped (no sidecars) | index → draft → **Show Patient Summary** → verify → chat (the draft *is* the PS; no meds step) |
| **Folder of files (± Apple Health)** | meds only if any file is AH | same as single, N files in the Index row |
| **Restore (after cloud delete)** | already done | KB/summary exist → generation stages `done`; wizard shows "Restored" → **"Go to chat"**. Uses `/api/temporary/restore`. |

## Implementation phases (tracking checklist)

Each phase is a small, independently reviewed PR that references this doc.

- [x] **A — Pipeline backbone** (`server/records-pipeline.js`): reorder
  `PIPELINE_STAGES`; `decideNextAction` returns a human `label` per stage/flavor.
- [x] **B — Wizard single button** (`ChatInterface.vue`): the footer is now one
  CTA whose label is `wizardNextStep.label` (from `fetchPipeline` →
  `decideNextAction`), refreshed on wizard-open and on flow signals. Disabled +
  spinner while `kind` is `wait`/`client` (auto-advancing); clickable for the
  user's moments — dispatch: `verify-medications`→Lists, `review-summary`→PS,
  else→chat (`dismissWizard`, which already keeps the rail ring spinning while
  `flowPhase !== 'done'`). Flavor-aware labels (group-only "Go to chat" instead
  of "Add a health record") remain Phase F.
- [x] **C — Records flow runs whenever files exist** (`ChatInterface.vue`): the
  records watcher fires on `stage3HasFiles` (not folder flags); the draft/meds/
  summary rows gate on `stage3HasFiles` (not `!wizardQuickStart`); and the
  quick-start "AI-ready → Groups" completion **defers** when files are present,
  so it no longer jumps to Groups before indexing finishes. This removes the
  Groups→Lists churn. (Index/draft timing rows already render.)
- [x] **D — Patch on meds-verify** (`MyStuffDialog.vue`): **decided: no change.**
  With Phase C the draft reliably exists after indexing, so
  `updateSummaryWithVerifiedMeds` takes the **patch** path
  (`replaceMedicationsInSummary`) in the normal flow — no recalc, as intended.
  The #232 regenerate now only fires if the draft is genuinely missing (a draft
  *failure*), which is a sensible safety net, not a band-aid. Reverting it would
  reintroduce the stall on failure, so it's kept. (The auto-open-PS + drop-Lists-
  highlight that Phase D also mentioned is already handled by the records
  watcher / patch path.)
- [ ] **E — Clean exit** (`ChatInterface.vue` / `MyStuffDialog.vue`): PS verify →
  save + close Workbook + clear chat files + blank slate.
- [x] **F — Flavor CTA + acceptance matrix**: the wizard CTA now reads
  **"Go to chat"** (not "Add a health record") when `!stage3HasFiles`
  (group-only / no records), and clicking drops into chat. Per-flavor CDP
  setup runs need live AI/KB provisioning, so they run against the deployed
  app; the acceptance matrix below is the spec.

### Per-flavor acceptance matrix (live-run checklist)

Run each on `test.agropper.xyz` and confirm the log is a clean linear sequence:

| Flavor | Expect |
|---|---|
| **No files (group only)** | Agents deploy → lands on **Groups**; if the wizard is opened its one button says **"Go to chat"**. No index/draft/meds/summary rows. |
| **1 file — Apple Health** | index → **Draft saved (hidden)** → Tab: lists → meds verified → **Patient Summary saved** (same second = patched) → verified → Setup complete → **blank chat, no file chip**. One button throughout: Indexing… → Drafting summary… → **Show Current Medications** → **Show Patient Summary** → done. |
| **1 file — not Apple Health** | index → draft → **Show Patient Summary** (no meds step) → verify → chat. |
| **Folder (± Apple Health)** | as the single-file cases, N files in the Index row; meds step only if any file is Apple Health. |
| **Restore** | generation stages already done → **"Go to chat"**; no re-draft. |

No **"Custom Medications"** modal, no Groups→Lists churn, no "Click SEND to get
the patient summary" prompt behind the wizard, and GET STARTED stays disabled
until a checked file/folder is actually selected.

## Implementation notes (from the Phase B–D investigation)

The machinery mostly exists but is gated wrong:

- **The records flow already exists.** A watcher in `ChatInterface.vue` (~8793 →
  the block at ~8820) already: generates the draft (`POST /api/patient-summary/
  draft`, sets `wizardDraftPsStatus`/`preGeneratedSummary`/`draftPsMeds`), then
  opens Lists ▸ Current Medications (`wizardFlowPhase='medications'`). Index and
  draft **timing rows already render** (`~658–676`, `~694–716`).
- **Root cause of the confusion:** that flow is gated by `wizardQuickStart`
  (the Draft/Meds/Summary rows are `v-if="!wizardQuickStart"`) and by folder
  conditions (`localFolderHandle || safariFolderName || wizardFolderlessRun`).
  **Quick-start WITH a file** — the logged case — indexes the file but skips the
  draft flow, so there's no draft to patch and the user is stranded. Fix: run
  the records flow whenever `files.length > 0`, independent of the quick-start
  tier and folder presence.
- **CTA today** is just `Continue → dismissWizard` (`~791`). Phase B adds a
  reactive `wizardNextStep` (from `fetchPipeline`/`decideNextAction`, now
  carrying `label`) bound to one button, with a dispatch by `action`
  (`start-indexing` / `verify-medications`→open Lists / `review-summary`→open PS
  / `complete`→chat). Disabled with status text while `kind==='wait'`.
- **Phase D:** `MyStuffDialog.updateSummaryWithVerifiedMeds` currently
  regenerates when no draft exists (the #232 band-aid). Once the draft reliably
  exists (above), revert to **patch-only** (`replaceMedicationsInSummary`).

Because these are interlocking changes to `ChatInterface.vue` (~10k lines) and
`MyStuffDialog.vue` (~8k lines) on the core onboarding path, B–D land together
and must be verified with a **live setup run** (real AI/KB calls), not just a
type-check.

## Verification

Drive each flavor end-to-end through the live app with the CDP harness
(`scratchpad/deck/cdp.js`): welcome form → GET STARTED → wizard, capturing the
exported setup log + screenshots at each CTA. A correct run's log is a clean
linear sequence (index → draft (timed) → Show Current Medications → verify → PS
shown → verify → chat blank slate) with **no** Workbook open/dismiss churn.
`npm run build` (vue-tsc) green per PR.

## Restore-after-deletion — code in place, pending live verification

**Status (v1.5.124):** both parts of the fix are now in the code, and **DELETE
CLOUD ACCOUNT is RE-ENABLED** (`src/App.vue`, both the primary button and the
"more choices" option) so the delete→restore cycle can be verified live. If that
live run surfaces a problem, disable the two controls again (`:disable="true"`)
until it's fixed.

**Diagnosis (v1.5.109, zachary08 log):**
- `deleteUserAndResources` (`server/index.js:8934`) *does* delete Spaces (§1),
  both KBs (§2: `kbId` + `kb2.kbId`), and all agents (§3: stored + GPT + orphan
  scan for `${userId}-agent-*`), tracking results in `deletionDetails`. But it
  only `console.log`s — **no `appendUserProvisioningEvent`** — so nothing reaches
  `maia-log.pdf`; the log shows `Account deleted: No` and no delete events.
- The maia-log is built from `userDoc.provisioningLog`, and this function
  **deletes the userDoc** — so delete events written there vanish with it. They
  must be captured **client-side** (the endpoint already returns
  `deletionDetails`) and written to the **folder-backed** log before deletion.
- Restore infra exists (`/api/temporary/restore` `auth.js:1383`;
  `restore-started`/`restore-complete` events; App.vue's Files/Agent/KB/
  Medications verification `~3101`) but the wizard never surfaces it — a
  re-entry logs as a normal setup, so restore runs blind.

**Fix plan (two parts):**
1. **Log what's deleted (verified). — DONE (v1.5.123).** `deleteUserAndResources`
   now emits durable `account_delete_started` + `account_deleted {deletionDetails}`
   to the **audit log** (`maia_audit_log`) — the one record that survives the
   userDoc. Client-side, the `delete-only` handler (`App.vue`) captures the
   endpoint's returned `details` and `bufferLogEvent`s `account-delete-started` /
   `account-deleted` / `account-delete-failed` — `bufferLogEvent` persists in
   localStorage independent of the destroyed account, so **maia-log renders them**
   (no folder-state/`clearUserSnapshot` interaction). `ChatInterface`'s renderer
   has cases for all three (Spaces/KB/Agent + counts + error count), colored.
2. **Track restore. — DONE (already implemented).** `src/components/RestoreWizard.vue`
   is a full live-progress wizard: a destroyed account is detected
   (`showDestroyedRestoreDialog`), `handleDestroyedRestore` recreates the userDoc
   and launches the wizard, and `watch(modelValue)` → `executeRestore` drives a
   **live checklist** (per-step spinner/check/error + timing + running-status
   footer). It logs `restore-started` → per-step (`agent-deployed`, `kb-indexed`,
   `lists/chats/instructions-restored`, `gpt-agent-ready`) → `restore-complete`,
   with a `bufferLogEvent` fallback so events survive a session destroyed mid-
   restore. (The v1.5.109 "restore runs blind" diagnosis predated this component.)

**Verification requires a real delete→restore cycle against DigitalOcean**
(agents, KB, Spaces) — cannot be type-checked alone. Confirm on that run: (a) the
maia-log shows the deletion (Part 1), and (b) the RestoreWizard shows live rows
and restores cleanly (Part 2). If it passes, **#8 is closed**; if not, re-disable
the two DELETE CLOUD ACCOUNT controls and fix.
