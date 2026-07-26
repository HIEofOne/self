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

- [ ] **A — Pipeline backbone** (`server/records-pipeline.js`): reorder
  `PIPELINE_STAGES`; `decideNextAction` returns a human `label` per stage/flavor.
- [ ] **B — Wizard single button** (`ChatInterface.vue`): one CTA bound to the
  next-action label; X → chat + keep the ring spinning; reopen recomputes from
  `fetchPipeline`.
- [ ] **C — Feedback** (`ChatInterface.vue`): index tokens + elapsed on
  complete; auto-run the draft after indexing with the step-list + elapsed in
  the wizard.
- [ ] **D — Patch on meds-verify** (`MyStuffDialog.vue`): patch-only
  (`replaceMedicationsInSummary`), no regenerate; auto-open PS, drop Lists
  highlight. Supersedes the #232 no-draft regenerate band-aid.
- [ ] **E — Clean exit** (`ChatInterface.vue` / `MyStuffDialog.vue`): PS verify →
  save + close Workbook + clear chat files + blank slate.
- [ ] **F — Flavor branching + tests**: finalize per-flavor CTA/skip; CDP
  setup-run test per flavor.

## Verification

Drive each flavor end-to-end through the live app with the CDP harness
(`scratchpad/deck/cdp.js`): welcome form → GET STARTED → wizard, capturing the
exported setup log + screenshots at each CTA. A correct run's log is a clean
linear sequence (index → draft (timed) → Show Current Medications → verify → PS
shown → verify → chat blank slate) with **no** Workbook open/dismiss churn.
`npm run build` (vue-tsc) green per PR.
