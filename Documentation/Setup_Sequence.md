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
- [ ] **F — Flavor branching + tests**: finalize per-flavor CTA/skip; CDP
  setup-run test per flavor.

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
