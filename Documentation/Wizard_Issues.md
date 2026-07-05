# Wizard Issues: Current State and Restructuring Plan

**Date:** 2026-07-05
**Version at time of writing:** 1.4.98
**Related docs:** `Wizards.md` (lifecycle flows), `Wizards2.md` (API inventory)

> **Status note (v1.4.98):** The single-source-of-truth restructuring in
> sections 3.1–3.7 is still the correct long-term plan and remains **unstarted**.
> The reload-resume fix in v1.4.96 (section 5) is a targeted mitigation of the
> most visible symptom, not the structural cure. See section 6 for how File N
> citation links are handled across the app — a related area that had its own
> "renders as plain text, then links appear seconds later" class of bugs.

---

## 1. The Problem

The Setup Wizard is the most bug-prone part of the MAIA codebase. Every release
cycle produces UI-state bugs where the wizard's visual indicators (spinners,
orange borders, green checkmarks, elapsed timers) disagree with what actually
happened. The maia-log PDF captures the correct sequence of events, but the
on-screen UI tells a different story.

Recent examples (v1.4.54 -- v1.4.58):

- **Elapsed timer killed prematurely:** `refreshWizardState()` called from 15+
  places; one call site stopped the timer during Draft PS generation because it
  checked `indexingStatus.phase !== 'indexing'` without guarding for the
  preparation phase.
- **Indexing spinner persists after completion:** `handleIndexingFinished` didn't
  clear the polling interval ref (`stage3IndexingPoll`), so the computed
  `stage3IndexingActive` stayed true even though the server reported completion.
- **Orange "My Lists" border persists after setup complete:** The
  `medsNeedsVerify` computed checked server-derived state
  (`userResourceStatus.hasCurrentMedications`) independently of the wizard flow.
  A stale server response could override the in-memory completion flag.
- **Wizard spinner ring persists after setup complete:** Same root cause -- the
  `wizardActive` computed checked server-derived state without consulting the
  definitive in-memory `wizardPatientSummary` flag.

All of these share a common root cause: **there is no single source of truth for
wizard state.** Instead, multiple refs, computeds, server responses, localStorage
entries, and sessionStorage flags each hold a partial view, and they can
disagree.

---

## 2. Current Architecture (Why It's Fragile)

### 2.1 Scale of the Problem

The wizard implementation spans ~1,000+ lines across an 8,500-line single file
(`ChatInterface.vue`), with additional UI in `MyStuffDialog.vue` (7,400 lines).
The code audit found:

| Category | Count |
|----------|-------|
| Wizard-related refs (reactive state variables) | 55+ |
| Assignments to `wizardFlowPhase` | 11 |
| Call sites for `refreshWizardState()` | 23+ |
| Computed properties derived from wizard state | 14 |
| Watchers observing wizard state | 12 |
| Timers/intervals (setInterval + setTimeout) | 11 |
| Event channels between ChatInterface and MyStuffDialog | 8+ |

### 2.2 Three Competing State Systems

The wizard's visible state is driven by three independent systems that can
disagree:

**A. In-memory refs (session-local)**

These are the "source of truth" for the guided flow:

- `wizardFlowPhase` -- `'running'` | `'medications'` | `'summary'` | `'done'`
- `wizardPatientSummary` -- true when the user clicks Verify on Patient Summary
- `wizardCurrentMedications` -- true when the user clicks Verify on Medications
- `wizardStage1Complete` -- true when the agent is deployed
- `wizardDraftPsStatus` -- `'idle'` | `'running'` | `'done'` | `'failed'`

These are set by direct user actions (clicking Verify, completing deployment).
They are always correct in the moment.

**B. Server-derived state (async, can lag)**

`userResourceStatus` is an object rebuilt from `/api/user-status` responses by
two different functions:

- `refreshWizardState()` (line 2882) -- fetches 3 endpoints in parallel, rebuilds
  the entire object
- `updateContextualTip()` (line 7876) -- fetches 1 endpoint, also rebuilds the
  entire object

Both functions overwrite `userResourceStatus` with a fresh object. If the server
hasn't persisted a change yet (CouchDB conflict, write lag), the new object
reverts a field that was optimistically set to `true` back to `false`.

UI elements driven by `userResourceStatus`:

- `medsNeedsVerify` (orange border on My Lists) -- checks `hasCurrentMedications`
- `wizardActive` (yellow spinner ring) -- checks `hasPatientSummary`,
  `kbIndexingActive`, `workflowStage`
- `isRequestSent` (request-sent modal) -- checks `workflowStage`

**C. Persisted state (localStorage / sessionStorage)**

- `localStorage[wizardUserStorageKey]` -- JSON with `stage2Complete`,
  `stage3Complete`, `stage4Complete`; OR-merged into refs on reload
- `sessionStorage['wizardSetupCompleted']` -- prevents reload recovery from
  re-entering the guided flow
- `sessionStorage['autoProcessInitialFile']` -- triggers auto-processing on reload
- `sessionStorage[agentSetupKey]` -- persists deployment start timestamp

These survive page reloads but not browser restarts (sessionStorage) or
cross-device (both). They can become stale if the server state changes
independently (e.g., admin action).

### 2.3 The Overwrite Problem

The core fragility is that `refreshWizardState()` and `updateContextualTip()`
both **replace the entire `userResourceStatus` object** every time they run.
Each function fetches from the server, builds a new object, and assigns it.

If an optimistic update set `hasCurrentMedications = true` at 5:14:32 PM, and
`refreshWizardState()` fires at 5:14:33 PM but the server response was fetched
at 5:14:32.5 PM (before the save propagated), the optimistic update is lost.

The current mitigations are fragile:

- `priorHasPatientSummary` preservation (line 2881) -- only covers one field
- Optimistic update in `handleMyStuffMedsSaved` (line 7700) -- overwritten by
  the next `refreshWizardState()` call
- `inGuidedFlow` guard (line 2982) -- prevents auto-setting
  `wizardPatientSummary` during guided flow, but doesn't prevent the
  `userResourceStatus` overwrite that affects `wizardActive`

### 2.4 Implicit State Machine

`wizardFlowPhase` is the closest thing to a state machine, but:

- It's set from 11 different places across the file
- There's no validation that transitions are legal (e.g., nothing prevents
  going from `'done'` back to `'running'`)
- The reload recovery logic (line 6865) reconstructs the phase from server
  state, which may not match what the user actually did
- The dismiss-count logic (line 8010) adds a hidden sub-state that isn't
  reflected in `wizardFlowPhase`

### 2.5 Timer Proliferation

The wizard uses 3 interval timers and 8+ one-shot timeouts. Cleanup calls
(`clearInterval`, `stopStage3ElapsedTimer`, `stopAgentSetupTimer`) appear 15+
times, scattered across event handlers, watchers, and lifecycle hooks. A missed
cleanup means:

- Elapsed timer counts past completion
- Polling continues after the job is done
- Memory leaks from orphaned intervals

### 2.6 refreshWizardState as a Side-Effect Bomb

`refreshWizardState()` is a ~340-line function that:

1. Fetches 3 API endpoints in parallel
2. Updates 20+ refs
3. Starts/stops timers
4. Reads/writes localStorage
5. Conditionally triggers UI changes (open dialogs, set tab focus)

It's called from 23+ places, including inside watchers that fire on ref changes
that `refreshWizardState` itself sets -- creating potential feedback loops
(guarded by `if` checks, but hard to reason about).

---

## 3. Restructuring Plan

### 3.1 Goal

Replace the scattered state management with a single, auditable state machine
that makes illegal states unrepresentable and eliminates the possibility of
UI/log disagreement.

### 3.2 Phase 1: Extract Wizard State into a Composable

**File:** `src/composables/useWizardState.ts`

Move all 55+ wizard refs, 14 computed properties, and the `wizardFlowPhase`
state machine into a single composable. This is a mechanical extraction -- no
behavior changes, just consolidation.

```
// Rough shape
export function useWizardState(userId: Ref<string | null>) {
  // All wizard refs live here
  const phase = ref<WizardPhase>('idle')
  const agentDeployed = ref(false)
  const kbIndexed = ref(false)
  const medsVerified = ref(false)
  const summaryVerified = ref(false)
  // ...

  // All computeds derive from these refs
  const isActive = computed(() => ...)
  const medsNeedsVerify = computed(() => ...)

  // State transitions are methods, not scattered assignments
  function advanceToMedications() { ... }
  function advanceToSummary() { ... }
  function complete() { ... }

  return { phase, isActive, medsNeedsVerify, ... }
}
```

**Benefit:** All wizard state is in one file. Every transition is a named method
call instead of a bare assignment. You can grep for `advanceToSummary` to find
every place the flow advances, instead of grepping for
`wizardFlowPhase.value = 'summary'` and hoping you found them all.

**Risk:** Low. This is a refactor, not a rewrite. ChatInterface.vue imports the
composable and calls the same methods.

### 3.3 Phase 2: Formal State Machine with Transition Guards

Replace the implicit `wizardFlowPhase` ref with an explicit state machine that
validates transitions:

```
type WizardPhase =
  | 'idle'           // No wizard activity
  | 'deploying'      // Agent being provisioned
  | 'uploading'      // Files being uploaded
  | 'indexing'       // KB indexing in progress
  | 'preparing'      // Draft PS + medication worksheets generating
  | 'verify-meds'    // Waiting for user to verify medications
  | 'verify-summary' // Waiting for user to verify patient summary
  | 'complete'       // All done

const VALID_TRANSITIONS: Record<WizardPhase, WizardPhase[]> = {
  'idle':            ['deploying'],
  'deploying':       ['uploading', 'idle'],
  'uploading':       ['indexing', 'uploading'],
  'indexing':        ['preparing', 'indexing'],
  'preparing':       ['verify-meds'],
  'verify-meds':     ['verify-summary'],
  'verify-summary':  ['complete'],
  'complete':        ['idle'],  // Only via explicit re-run
}

function transition(to: WizardPhase) {
  if (!VALID_TRANSITIONS[phase.value].includes(to)) {
    console.error(`Invalid wizard transition: ${phase.value} -> ${to}`)
    return
  }
  phase.value = to
  logProvisioningEvent({ event: 'phase-transition', from: phase.value, to })
}
```

**Benefit:** Illegal transitions (like `'complete'` -> `'verify-meds'`) are
caught immediately instead of silently corrupting state. Every transition is
logged, so the maia-log always matches reality.

**Key rule:** Once `phase` reaches `'complete'`, no server response, timer
callback, or `refreshWizardState` call can move it backward. The UI indicators
(`wizardActive`, `medsNeedsVerify`, orange borders) derive directly from
`phase`, not from server state.

### 3.4 Phase 3: Split refreshWizardState

Break the 340-line `refreshWizardState()` into focused functions:

| Function | Fetches | Updates |
|----------|---------|---------|
| `fetchAgentStatus()` | `/api/agent-setup-status` | `agentDeployed`, `agentId` |
| `fetchFileStatus()` | `/api/user-files` | `files`, `kbIndexed`, `tokenCount` |
| `fetchSummaryStatus()` | `/api/patient-summary` | `hasSummary`, `summaryText` |
| `syncServerState()` | All three | Calls the above, updates `userResourceStatus` |

Each function updates only its own slice of state. No function overwrites fields
managed by another function. The phase machine's `complete` state is never
overridden by any fetch result.

**Benefit:** When a bug appears in the indexing display, you look at
`fetchFileStatus()`. When the summary flag is wrong, you look at
`fetchSummaryStatus()`. You don't have to read 340 lines to find which of the
20+ ref assignments is wrong.

### 3.5 Phase 4: Centralize Timer Management

Create a timer registry that tracks all active timers:

```
const timers = useTimerRegistry()

// Starting a timer
timers.start('indexing-elapsed', () => tick.value++, 1000)
timers.start('indexing-poll', () => pollKbStatus(), 10000)

// Stopping is explicit and named
timers.stop('indexing-elapsed')

// Phase transitions auto-clear timers registered to the previous phase
function transition(to: WizardPhase) {
  timers.clearPhase(phase.value)
  phase.value = to
}
```

**Benefit:** No orphaned timers. When the phase changes, all timers from the
previous phase are automatically cleared. No more hunting for 15 scattered
`clearInterval` calls.

### 3.6 Phase 5: Eliminate Dual-Path State Updates

The current architecture has two functions (`refreshWizardState` and
`updateContextualTip`) that both overwrite `userResourceStatus`. This should be
reduced to one:

- `updateContextualTip` should read from `userResourceStatus` (already populated
  by `refreshWizardState`), not re-fetch and overwrite it.
- If `updateContextualTip` needs fresh data, it should call `syncServerState()`
  (the refactored version) which knows not to overwrite in-memory completion
  flags.

### 3.7 Phase 6: Derived UI State

All UI indicators should derive from the phase machine, not from independent
computeds that consult server state:

```
const wizardActive = computed(() =>
  phase.value !== 'idle' && phase.value !== 'complete'
)

const medsNeedsVerify = computed(() =>
  phase.value === 'verify-meds'
)

const showIndexingSpinner = computed(() =>
  phase.value === 'indexing'
)
```

**Benefit:** The UI is a pure function of the phase. If the log says "Setup
complete," the phase is `'complete'`, and every UI indicator reflects that. There
is no second state system that can disagree.

---

## 4. Migration Strategy

### Ordering

The phases are designed to be done incrementally, one PR at a time:

1. **Phase 1** (composable extraction) can be done first with zero behavior
   change. It just moves code. This is the highest-value lowest-risk step.
2. **Phase 2** (state machine) changes how transitions work but keeps the same
   states. Test by running the wizard end-to-end and verifying the maia-log
   matches the UI at every step.
3. **Phases 3-6** can be done in any order after Phase 2.

### Testing

There is no automated test suite for the wizard. Each phase should be validated
by:

1. Running the full wizard flow (upload files, index KB, verify meds, verify PS)
2. Checking the maia-log PDF matches the on-screen state at every step
3. Reloading mid-flow and confirming the wizard resumes correctly
4. Running the Restore flow and confirming it doesn't conflict

### What Not to Change

- The maia-log PDF generation (`logProvisioningEvent` + `generateSetupLogPdf`)
  is working correctly and should not be restructured. It's the one reliable
  record of what happened.
- The MyStuffDialog rail UI and tab structure are fine. The problem is in what
  drives the `wizardActive` and `medsNeedsVerify` props.

---

## 5. Fixes Applied (v1.4.58 -- v1.4.65)

### v1.4.58 — Post-completion UI guards

- `wizardActive` now returns `false` immediately if `wizardPatientSummary` is
  true, before consulting any server-derived state.
- `medsNeedsVerify` now returns `false` immediately if `wizardPatientSummary` is
  true, since medications must have been verified before the patient summary
  (the flow enforces this order).

### v1.4.59 — Prevent worksheet from auto-provisioning secondary agent

- `triggerSetupWorksheets` changed from `['default', 'gpt']` to `['default']`
  only. The `'gpt'` entry caused `/api/medications/worksheet` to call
  `ensureSecondaryAgent` during setup, creating the secondary agent without user
  action.

### v1.4.60 — Tab override fix

- `handlePatientSummaryVerified` now resets `myStuffInitialTab` to `'files'` when
  setup completes, preventing the stale `'summary'` value from overriding user
  tab navigation on reopen.

### v1.4.61 — Indexing spinner race + secondary agent lazy provisioning

**Bug: Indexing spinner persists alongside Draft PS generation.**

Root cause: a race between the frontend's 10-second indexing poll and
`refreshWizardState`. The frontend poll detects indexing completion (via
`inferredComplete`: tokens > 0 and DO API not active) and sets
`indexingStatus.value.phase = 'complete'`. This triggers the preparation-phase
watcher, which starts Draft PS generation. But the poll handler also calls
`refreshWizardState()`, which fetches `/api/user-files`. The server's own 15s KB
polling hasn't persisted `backendCompleted: true` yet, so the response contains
stale data (`phase: 'indexing'`). At line 2950, `refreshWizardState` overwrites
`indexingStatus.value` with `{ phase: 'indexing' }`, making `stage3IndexingActive`
true again and reviving the spinner.

Fix: guard the overwrite at line 2950 with
`indexingStatus.value?.phase !== 'complete'` — never regress a completed phase
with stale server data.

**Bug: Secondary agent auto-deploying without user action.**

Root cause: the `/api/chat/providers` endpoint in `server/routes/chat.js`
lazily calls `ensureSecondaryAgent` whenever the primary agent is deployed and a
KB exists, even if the user has never deployed the secondary agent. This fires
every time `loadProviders()` is called from `refreshWizardState`, which happens
many times during setup. The secondary agent silently gets created as a side
effect of loading the provider dropdown list.

Fix: changed the guard to require `agentProfiles.gpt.agentId` to already
exist — i.e., only repair an agent that was previously deployed, never
auto-create one from scratch. First creation is now the user's action via the
Deploy button in My AI Agent, or the wizard's automatic secondary deploy step.

### v1.4.62 — Secondary AI tab unreachable

**Bug: Clicking "Secondary AI" tab reloads the primary tab instead.**

Root cause: `loadAgent()` in MyStuffDialog reset `activeAgentProfile` to the
first deployed profile when the current tab wasn't in the deployed-profiles list.
Since the 'gpt' tab is always rendered (showing a Deploy button when undeployed),
the reset was wrong — it prevented the user from ever reaching the secondary tab.

Fix: removed the `activeAgentProfile` reset from `loadAgent()`.

### v1.4.63 — Provider dropdown revert, response mislabel, reasoning mode

**Bug: Chat provider dropdown reverts to Primary AI after selecting Secondary.**

Root cause (path 1): `loadProviders()` unconditionally reset `selectedProvider`
to the first Private AI profile label. After the user selected Secondary and
sent a message, the streaming response triggered `loadProviders()` which
overrode the selection.

Fix: guard the reset with `isPrivateAiLabel` check — only reset if the current
selection isn't already a valid Private AI label.

**Bug: Chat response mislabeled as Primary AI when using Secondary.**

Root cause: `providerLabel` for the assistant message was captured at
response-time (after `loadProviders` had already reset `selectedProvider` back to
Primary). The label showed the wrong agent.

Fix: capture `providerLabel` at send-time, before the fetch call, so it reflects
the user's actual selection.

**Feature: Reasoning mode for Kimi K2.5 via DO GenAI agents.**

The DigitalOcean provider's `streamChat` only handled `delta.content`. Kimi K2.5
(a reasoning model) sends `delta.reasoning_content` for its chain-of-thought.

Fix: added `reasoning_content` chunk handling to `digitalocean.js`, matching the
pattern already used in `openai.js` for DeepSeek R1.

### v1.4.64 — Provider dropdown revert (second path)

**Bug: Dropdown still reverted via the `providers` watcher.**

Root cause (path 2): a `watch()` on `providers.value` also reset
`selectedProvider` to `defaultPrivateAiLabel()` whenever the providers list
changed, independent of `loadProviders`.

Fix: same `isPrivateAiLabel` guard applied to the watcher.

### v1.4.65 — Wizard secondary deploy, dropdown label, reasoning filter,
secondary agent controls

**Feature: Wizard automatically deploys secondary agent after primary.**

The wizard checklist now includes a "Deploy Secondary AI Agent" step that fires
automatically once the primary agent is ready. It polls
`/api/agents/ensure-secondary` every 5s with a 3-minute timeout, showing a
spinner and elapsed time. The secondary deploy runs in parallel with KB indexing.

On page refresh, `refreshWizardState` also triggers secondary deploy if the
primary is ready but the secondary isn't yet deployed.

**Bug: Dropdown shows bare "Private AI" instead of full profile label on reload.**

Root cause: both `loadProviders` and the `providers` watcher used an
`isPrivateAiLabel` guard that matched the generic "Private AI" fallback label.
On page reload, `selectedProvider` started as "Private AI" (the fallback), the
guard said "that's a valid Private AI label," and skipped updating it to the
full profile label like "Private AI Primary (GPT)."

Fix: changed the guard to check `privateAiProfiles.value.some(pr => pr.label ===
currentLabel)` — only skip the reset if the current selection matches a specific
profile label, not just the generic fallback.

**Bug: GPT-OSS-120B (non-reasoning model) showing reasoning section.**

Root cause: the `reasoning_content` streaming handler in `digitalocean.js`
surfaced reasoning chunks from all models, not just reasoning models.
GPT-OSS-120B apparently returns `reasoning_content` via the DO GenAI agent
platform.

Fix: only emit reasoning chunks when the model name contains 'kimi' or
'deepseek-r1'.

**Feature: Secondary AI tab now has same controls as Primary.**

The My AI Agent > Secondary AI tab now shows the same controls as the Primary
tab when the agent is deployed: deep link toggle, editable agent instructions,
knowledge base connection checkboxes with "Index Now", and indexed files list.
All data functions (`loadAgent`, `saveInstructions`, `applyKbChanges`) already
used `activeAgentProfile.value` for per-agent scoping, so only the template
needed to change.

### v1.4.86–v1.4.98 — Medication data flow, citations, verify, reload-resume

This range reworked the medication half of the guided flow and fixed several
File N citation bugs (the latter documented in section 6).

**Medication data flow (v1.4.90–v1.4.96).** After KB indexing the wizard now
merges two medication sources for verification:

- the deterministic Apple Health list (`/api/medications/current`, with the
  18-month "Current" cutoff), and
- medications extracted from the draft Patient Summary. `ChatInterface`
  extracts them (`extractMedsFromDraftPS`) and passes them through
  `MyStuffDialog` to `Lists` as the `draftPsMeds` prop.

The merge dedups by **generic drug name** (first alphabetic token, after
stripping dose/date/citation) so the same drug extracted two ways — e.g.
`levothyroxine 137 MCG tablet` (Apple Health) vs `Levothyroxine 137 µg tablet
(most recent 15 Jun 2026) [File 1 p.127]` (draft PS) — no longer appears twice.
The clean Apple Health entry is kept; draft-PS-only drugs are appended. When
Apple Health returns nothing, the draft-PS meds are the fallback. Zero-med
patients verify "None" (`handleVerifyCurrentMedications` saves `'None'`).

The redundant "Update Patient Summary?" modal is suppressed during the wizard —
`ChatInterface` patches the draft PS directly via the `update-summary-meds`
action, so there is no second AI regeneration.

**Verify Patient Summary (v1.4.95).** `handleVerifySummaryTab` now compares the
PS's Current Medications against the **server's** verified list
(`/api/user-status`), not the `Lists` component ref. Because `q-tab-panels` has
no `keep-alive`, the Lists panel is unmounted while the Summary tab is active, so
that ref was `null` and produced a phantom "Custom Medications" mismatch modal on
every verify. The warning now fires only on a genuine manual PS edit.

**Draft PS prompt (v1.4.92, v1.4.95).** `clinical-prompts.md`
`patient-summary.draft` now tells the AI a medication is "Current" only if
prescribed/refilled within 18 months (matching `/api/medications/current`), and
to cite sources as `[<filename> p.<page>]` with no `Source:` label.

**Wizard reload-resume (v1.4.96).** If the user reloaded after verifying meds but
before verifying the summary, the wizard reopened into a dead state: "Draft
Patient Summary" shown incomplete (though it was generated) plus a perpetual
"Verify your Patient Summary to continue." spinner going nowhere. Cause: on
reload `refreshWizardState` restored `wizardCurrentMedications` and the committed
summary but never rehydrated the draft PS (`preGeneratedSummary` /
`wizardDraftPsStatus`), and `wizardFlowPhase` stayed its default `'done'`, so no
phase watcher resumed — a direct instance of the section 2 root cause (state
assembled from many refs, only a subset restored on reload).

Fix (client-only — `GET /api/patient-summary` already returns the hidden `draft`,
and `loadPatientSummary` already displays it): rehydrate the draft in
`refreshWizardState`, and `maybeResumeInterruptedWizard` re-enters the correct
phase and opens the workbook at the finishing step (Patient Summary if meds are
verified, else Current Medications). It fires at most once per session
(`wizardResumeAttempted`) and never mid-live-flow (only when
`wizardFlowPhase === 'done'`). This is a targeted mitigation, **not** the
sections 3.1–3.7 cure.

**Chat citation timing (v1.4.98).** Covered in section 6.4.

---

## 6. File Links (File N Citations): How They Work

File N citation links have their own recurring bug class — "renders as plain
text, then links appear a few seconds later" — with the same shape as the wizard
state bugs (a render that depends on async state that hasn't loaded yet). This
section documents the pipeline so those bugs stop recurring.

### 6.1 What a File N citation is

The AI cites sources it found in the knowledge base. It does **not** know the
app's "File N" numbering — it only sees filenames in the KB chunk metadata — so
it emits citations by filename, in inconsistent shapes:

```
[medications.pdf p.12]
[Source: GROPPER_ADRIAN_05-12-2026_to2016.PDF p.75]
【Health Records.pdf p.3】        (CJK brackets)
[See labs.pdf, page 9]
```

A shared post-processor normalizes all of these into clickable `File N` links
plus a legend footer.

### 6.2 The shared processor — `src/utils/fileNCitations.ts`

`processFileNCitations(content, availableFiles, nameFilter?)` runs four passes
over the markdown before it is rendered to HTML:

0. **Raw filename → `File N`.** For each PDF (matched against both the display
   name AND the sanitized bucket-key form the KB stores), rewrite
   `[<filename> p.N]` → `[File N p.N]`. Tolerant of an optional label prefix
   (`Source:` / `See` / `Ref:` / …), CJK `【 】` brackets, and a comma before the
   page number.
1. **Bracketed `[File N p.N]` → anchor** — `<a class="page-link" data-filename
   data-page data-bucket-key>`.
2. **Bare `File N p.N` → anchor** — for citations the AI wove into prose without
   brackets.
3. **Legend footer** — appends `**File legend**` listing only the File N's
   actually referenced, so `File 3` etc. can be identified without hovering.

`File N` maps to the Nth entry of the user's **PDF-only, References-excluded**
file list. The optional `nameFilter` runs each display name through the privacy
filter so the legend shows the pseudonymized filename.

### 6.3 Where it is applied (three render sites)

| Site | Entry point | File-list source |
|------|-------------|------------------|
| Chat messages | `processPageReferences` → `messageDisplayHtml` (`ChatInterface.vue`) | `availableUserFiles` |
| Workbook → Patient Summary tab | `renderPsHtml` → `patientSummaryHtml` (`MyStuffDialog.vue`) | `userFiles` |
| Workbook → Lists → Current Medications rows | `medRowsHtml` + `medsFileLegend` (`Lists.vue`) | `userFiles` prop (passed from `MyStuffDialog`) |

Every `.page-link` anchor carries `data-filename` / `data-page` /
`data-bucket-key`; each site wires a click handler
(`handlePageLinkClick` / `handlePsCitationClick` / `handleMedCitationClick`) that
opens the PDF viewer at that page.

### 6.4 The critical dependency: the file list must be loaded FIRST

`processFileNCitations` returns the content **unchanged** when the file list is
empty (no PDFs → nothing to map). So if a citation-bearing message renders before
its file list has loaded, it shows as **plain text with no links and no legend**,
then gains links a few seconds later when the list loads and the computed
re-renders. Fixes:

- **Chat (`availableUserFiles`):** it is loaded once at mount — which, for a
  fresh setup, happens *before* any file is uploaded. It is now also refreshed in
  `handleIndexingFinished` (files exist once the KB is indexed) and awaited in the
  stored-Patient-Summary SEND path before the message is pushed. (v1.4.98)
- **Workbook (`userFiles`):** loaded eagerly when the Workbook dialog opens, not
  only when the Files tab is visited. (v1.4.94)
- **Lists rows:** `userFiles` is a prop from `MyStuffDialog`, so it is present as
  soon as the workbook has loaded its file list.

### 6.5 Adding new citation sources

Because the AI invents citation shapes, Pass 0 must stay liberal. If a new shape
appears that Pass 0 does not recognize, the citation silently stays as plain text
(no error is thrown). When adding a source of citations, do **both**: teach the
prompt the canonical `[<filename> p.<page>]` form (see `clinical-prompts.md`),
and keep Pass 0's prefix/bracket tolerance as the safety net. Always confirm the
render site has its file list loaded before the cited content can appear
(section 6.4).

---

## 7. General Observations

The tactical fixes in section 5 address specific symptoms but don't address the
underlying architectural problem of multiple independent state systems. The
restructuring plan in sections 3.1–3.7 remains the correct long-term solution.

The model configuration was also updated in this version range:
- Primary agent: GPT-OSS-120B (`MODEL_PRIMARY = MODEL_GPT`)
- Secondary agent: Kimi K2.5 (`MODEL_SECONDARY = MODEL_KIMI`)
- `MODEL_PRIMARY` / `MODEL_SECONDARY` constants exported from `auth.js`
- Secondary agent instruction: `'Do not hallucinate.'` (intentionally minimal
  and different from the primary's MAIA identity prompt)
