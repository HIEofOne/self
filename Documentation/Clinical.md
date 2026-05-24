# Clinical Features

A living reference for MAIA's clinical-data-handling features:
**My Lists Categories**, **Current Medications**, **Medication
Worksheets**, **Encounters**, **Patient Summary**, and the supporting
indexing/agent architecture.

## Architecture: three layers

MAIA splits "what each clinical process does" across three files so each
concern is editable in one place and the layers don't drift:

| Layer | File | Contents | Edited by |
|---|---|---|---|
| 1. **Provisioning / infra config** | `NEW-AGENT.txt` (repo root) | Models, KB params (embedding/reranking/chunking), OpenSearch rule, regions, setup-wizard text, random names, App Platform settings, and the **generic guardrail** System Instruction (`## MAIA INSTRUCTION TEXT`). Runtime-parsed by `server/routes/auth.js`, `server/utils/kb-config.js`, etc. | Admin / operator |
| 2. **Clinical prompt registry** | `clinical-prompts.md` (repo root) | The **per-request prompts** MAIA sends to a Private AI for each clinical deliverable: medication worksheets (Apple Health / Epic / KB-retrieval), current-medications extraction, patient-summary draft. One block per prompt id with `{placeholder}` substitution. Loaded by `server/utils/clinical-prompts.js`; auto-reloads on file change. | Clinical author |
| 3. **Reference docs** | `Documentation/Clinical.md` (this file) | How the flows work end-to-end, which endpoint, which prompt id, which source. **No verbatim prompts** — points at Layer 2 by id. Includes the moved Agent API spec and footer-stripped indexing details. | Engineer |

The **system prompt** (Layer 1) is the generic guardrail — applied to
every chat and every inference. The **per-deliverable prompts** (Layer 2)
specify the *shape* of each thing MAIA produces. Drift between them is
prevented by single-source-of-truth: code requests prompts by id
(`getClinicalPrompt('worksheet.epic-medication-list', vars)`), and this
file *references* the same ids — never re-types them.

Other companion docs:
- `Documentation/Wizards.md` / `Wizards2.md` — Setup and Restore flow.
- `Documentation/NewRestore.md` — full-doc backup / rehydrate design.

---

## 1. My Lists Categories

### What they are
Per-patient, structured lists of clinical information extracted from an
**Apple Health Export PDF** ("Health Records — \<Name\> — \<date\>.pdf").
Each category is saved as its own markdown file so the user can view,
edit, and download structured slices of their record without re-reading
the whole PDF.

Typical categories (driven entirely by `### Heading` rows in the Apple
Health export, not a fixed list):
- `Medications` — see §2 below for how this one is also used to seed
  Current Medications.
- `Conditions`
- `Allergies`
- `Procedures`
- `Immunizations`
- `Lab Results` — preserves the **actual analyte readings** (since
  v1.4.7), not just `(N lines)` summaries. Each entry renders as
  `<Date> <analyte> <value> <units>; <analyte> <value>; …`. This is
  what the deterministic `/api/labs/history` endpoint (§4.5) parses
  to answer "list all TSH labs by date" queries.
- `Vital Signs` — same v1.4.7 fix: per-date entries carry the actual
  vital readings.
- `Care Team` / `Encounters` / others as Apple Health emits them.

### When and how they are created

1. **Apple Health detection.** When a PDF is uploaded (Setup, Restore
   folder-added, or via the wizard), `POST /api/files/restore-bytes`
   parses the first page server-side and matches the Apple Health
   footer text. If matched, `userDoc.files[i].isAppleHealth` is stamped
   `true` (this is the single source of truth — never filename-based).
   See `NEW-AGENT.txt` → *Knowledge Bases* and the
   `restore-bytes` endpoint in `server/index.js`.

2. **PDF → markdown.** `process-initial-file`
   (`server/routes/files.js`) reads the AH PDF from DigitalOcean
   Spaces, converts it to markdown, and saves the full markdown to
   `${userId}/Lists/<sanitised-AH-filename>.md`.

3. **Category extraction.** When the file is confirmed Apple Health
   (`isAppleHealth: true` OR the AH footer text is present in the
   generated markdown), `extractAndSaveCategoryFiles`
   (`server/utils/lists-processor.js`) walks the markdown:
   - **Each `### <Category Name>` heading** in the AH markdown becomes
     one category file.
   - Lines under the heading until the next `### ` or `## ` heading
     become that category's body.
   - Each category is written to `${userId}/Lists/<category>.md` in
     Spaces.

4. **Persistence flags.** After a successful run:
   - `userDoc.appleHealthCategoriesBuiltAt` = ISO timestamp.
   - `userDoc.appleHealthCategoriesSourceKey` = bucketKey of the AH
     PDF the categories were built from.
   These let later code know "already built", and they round-trip
   in the v2 backup so Restore knows what to recreate.

5. **Rebuild rules.** `process-initial-file` rebuilds categories when:
   - `force: true` is passed (used by Restore — the cloud KB and
     category files were wiped, even though `appleHealthCategoriesBuiltAt`
     is still set in the round-tripped backup), **or**
   - not yet built, **or**
   - the source AH file's bucketKey changed (`appleHealthCategoriesSourceKey
     !== initialFileBucketKey`).

6. **Self-heal `isAppleHealth`.** If categories are being built because
   the content footer matches (not the flag), `process-initial-file`
   also writes `userDoc.files[i].isAppleHealth = true` so downstream
   consumers (Lists.vue's `appleHealthFileInfo`, the Apple Health badge,
   the Restore category-rebuild fast path) see it.

### The Lists UI
`src/components/Lists.vue` lists all `${userId}/Lists/*.md` files except
the source markdown, lets the user view/download each, and provides the
**Categories index** entry-point (which requires an Apple Health source —
hence the "requires an Apple Health Export PDF" message when none is
configured). The `appleHealthFileInfo` ref is derived from
`userDoc.files.find(f => f.isAppleHealth)`, which is why correct
`isAppleHealth` self-healing matters.

### Endpoints involved
- `POST /api/files/lists/process-initial-file` — generate markdown +
  categories (called from Setup, Restore, and manual triggers).
- `GET /api/files/lists/markdown` — list category files.
- The flags `appleHealthCategoriesBuiltAt` /
  `appleHealthCategoriesSourceKey` live on `userDoc` and round-trip in
  `maia-state.json`.

---

## 2. Current Medications

Current Medications is a **user-verified** authoritative medication list
that supersedes anything an AI pulls out of the knowledge base. When
saved (`userDoc.currentMedications`) it is injected into the Patient
Summary draft via the `{currentMedications}` placeholder of
`patient-summary.draft` (Layer 2) — replacing the old system-prompt
"Current Medications Priority" rule.

### Unified pipeline (v1.3.99+, Step 4)

`Lists.vue → loadCurrentMedications()` makes **one** deterministic call
to `GET /api/medications/current`. The server:

1. Calls `resolvePatientMedicationSource(userId)` which picks the best
   *dated* structured source, in this priority order:
   - **Apple Health** — parses `${userId}/Lists/medication_records.md`
     deterministically (`parseAppleHealthMedRecords`). Source mode
     `apple-health`.
   - **Epic / MGB** — extracts the dated "Medication List" entries
     from each PDF in the KB folder (`extractEpicMedications`). Source
     mode `epic`.
   - **none** — KB-only patient with no structured source.
2. Merges + dedupes by drug (`mergeMedications`, keeping the latest
   entry per drug).
3. Returns the **Current candidates**: rows where `status === 'active'`
   AND `isoDate >= cutoffDate` (today − 18 months). No agent call.

The client pre-fills the verify/edit card with these. On Verify the user
POSTs to `/api/user-current-medications` → `userDoc.currentMedications`
(authoritative), which the Patient Summary then injects.

#### Sources of the displayed list

| `currentMedicationsSource` | Meaning |
|---|---|
| `user-doc` | A verified list already existed on the user doc (Restore / re-open) — re-offered as-is. |
| `apple-health` | Deterministic from `medication_records.md`. |
| `epic` | Deterministic from Epic "Medication List" entries. |
| `manual` | No structured source produced any candidates; the user enters meds manually. |
| `patient-summary` (legacy) | Older pre-Step-4 source label (the old `/api/medications/extract` from-summary path). Retained for backward display compatibility. |

The legacy `/api/medications/extract` endpoint (modes `from-summary` /
`apple-health`) is left in place but is **no longer called** by the
client. It can be removed once any external callers have migrated.

### Prompts (Layer 2 ids — edit in `clinical-prompts.md`)

Two layers drive every AI extraction:

**(a) Standing system instructions** — the agent is created with the
`## MAIA INSTRUCTION TEXT` from `NEW-AGENT.txt`. MAIA keeps this
**generic** (a guardrail applied to every chat and inference) — agent
perspective, redaction policy, output language/formatting. It does
**not** carry deliverable-specific rules; those live in Layer 2.

**(b) Deterministic Current Medications** (default since Step 4): no
agent call. `GET /api/medications/current` returns the dated Current
candidates from the unified pipeline above; the client pre-fills the
verify/edit card from them.

**(c) Legacy per-request prompts** — `POST /api/medications/extract`
still exists and uses these Layer-2 prompt ids, but is **not called by
the current client**. Kept for backward compatibility:

| Mode | Prompt id (legacy) | Placeholders |
|---|---|---|
| `from-summary` | `current-medications.extract.from-summary` | `{draftText}` |
| `apple-health` | `current-medications.extract.apple-health`   | `{appleHealthMd}` `{contextBlock}` |

These prompts can be edited in `clinical-prompts.md` (loader auto-reloads
on save) but only matter if the deprecated endpoint is invoked by an
external caller.

### Verification → Save

- The wizard logs `medications-offered` with the source and outcome
  (`success`, `ai-refusal`, `ai-error`, `ai-empty`, `summary-empty`,
  `no-source`, `agent-not-ready`, `extract-error`) so the path is
  visible in `maia-log.pdf`.
- The user edits/accepts in the **My Lists → Current Medications** card
  and presses **Verify**.
- On Verify, the list is saved to `userDoc.currentMedications` and
  emitted as `medications-saved`.
- The wizard then splices the verified list into the draft Patient
  Summary at a "Current Medications" heading, regenerates the summary
  block, and offers it for verification.

### Why the agent matters
Both extractions run through the **primary Private AI agent** (Deepseek
V4 Pro by default; see `NEW-AGENT.txt`) so the agent's system
instructions — especially the "Errors and Redactions" block (e.g.,
omit sexual-function medications) — apply at extraction time, not just
at chat time.

### Endpoints involved
- `POST /api/patient-summary/draft` — draft Patient Summary used as the
  source for the `from-summary` extraction path.
- `POST /api/medications/extract` — modes `apple-health` and
  `from-summary`; soft-skips with `medications-extract-skipped` on
  expected early-wizard misses.
- `POST /api/current-medications` (and the `/api/patient-summary` save
  path) — persist the verified list.

---

## 2.5 Current Medications Worksheets (Deepseek + GPT)

As of v1.3.83 the Setup wizard **no longer runs** the old Current
Medications extract → verify → splice step (§2). Instead, each of the
two Private AIs builds its own **Current Medications Worksheet** — from
the Apple Health medication-records markdown when available, otherwise by
retrieving from the knowledge base.

- **Endpoint**: `POST /api/medications/worksheet`
  (`agentProfileKey: 'default'|'gpt'`). Reads back via `GET
  /api/medications/worksheet`. Result persists to
  `userDoc.medsWorksheets[profileKey] = {table, legend, model,
  generatedAt, sourceMode}`.
- **Source resolution** (most reliable first; recorded as `sourceMode`):
  1. **Apple Health** (`apple-health-markdown`): the structured
     `${userId}/Lists/medication_records.md` (dated, paged) passed inline.
  2. **Epic / MGB** (`epic-medication-list`, v1.3.94): the dated
     "Medication List" entries are extracted **deterministically** from
     the PDFs (`server/utils/meds-extractor.js`) — each med's REAL
     `Ordered on:` / `Discontinued on:` date and its PDF page (via the
     same footer-based page map the Encounters list uses) — then merged,
     deduped by drug, and passed inline. **This fixed a bug where KB
     retrieval reported the document's "Generated on …" footer date as
     the prescription date.** The footer date is never used.
  3. **KB retrieval** (`kb-retrieval`): last-resort fallback when no
     structured source exists; the prompt explicitly tells the agent to
     ignore "Generated on/Exported on" footer dates. The endpoint
     attaches the KB and calls `ensureAgentRetrieval` in this path only.
  In all cases the dated list is passed **inline to each agent**
  (Deepseek + GPT) so they format/dedupe/redact consistently from clean
  input — `k=10` retrieval over a large multi-hundred-page record
  routinely missed the medication pages entirely.
- **GPT auto-provisioning**: for `gpt`, the endpoint calls
  `ensureSecondaryAgent`; if the agent isn't deployed yet it returns
  `202 {pending:true}` and the client (My Lists REFRESH) retries.
- **Prompt**: one GFM table, columns `Medication | Status | Last date
  prescribed | Source`. Status is exactly one of Current / Discontinued
  / Inpatient. The actual prompt text lives in `clinical-prompts.md`
  (see prompt-id table at the end of this section). Two key rules:
  - **De-duplication by drug, not dose** — all entries for the same drug
    collapse to ONE row using the latest-dated entry's strength; dose
    changes never create extra rows.
  - **18-month cutoff** — a drug is **Current** only if its Last date
    prescribed is on or after a server-computed cutoff (today − 18
    months, formatted `YYYY-MM-DD` and interpolated as `${cutoffDate}`);
    anything older is Discontinued (or Inpatient for hospital
    administrations). The cutoff is computed server-side so it does not
    depend on the model knowing today's date.
  - **Source** cites a short `File N` tag with page (e.g. `File 1 p.127`),
    not the full filename; the server supplies the `File N = <filename>`
    legend so numbering is stable across both agents and the model can't
    invent names. The legend renders as a footnote, and each Source cell
    is a hyperlink that opens the PDF at that page (`Lists.vue`).
  - **UI sorting**: `Lists.vue` sorts rows so Current appears first, then
    Inpatient, then Discontinued (`worksheetView`).
- **UI**: two cards in My Lists — "Current Medications Worksheet
  (Deepseek)" and "(GPT)" — each with a Generate/Refresh button. The
  Apple Health categories block is labeled "Categories from Apple
  Health".
- **Setup**: when KB indexing completes, the wizard generates the draft
  Patient Summary, fires `triggerSetupWorksheets()` for both profiles,
  then opens the Patient Summary tab. Setup completion is **gated on both
  Private AIs being provisioned** (`ensureGptProvisioned` polls
  `POST /api/agents/ensure-secondary`).
- **Agent readiness (v1.3.93)**: an agent is "ready" only when its DO
  deployment is `STATUS_RUNNING` — not merely when a `deployment.url`
  appears (DO populates the URL while still deploying, and the inference
  endpoint 403s until RUNNING). `/agent-status` and
  `/api/agents/ensure-secondary` both enforce this; the agent-dependent
  endpoints (`/patient-summary/draft`, `/medications/extract`,
  `/medications/worksheet`) retry once on 401/403 and, if still not
  serving, return a structured **202 `AGENT_NOT_READY`** (or soft-skip)
  instead of a 500.
- **Concurrent provisioning (v1.3.93)**: the GPT agent is created as soon
  as KB **indexing starts** (`ensureGptProvisioned` silent kickoff in
  `handleIndexingStarted`), so both agents deploy in parallel during the
  long indexing window instead of GPT being created lazily at the end.
- **Log**: rendered in `maia-log.pdf` (which also carries a static "How
  the My Lists tab works" reference page): `meds-worksheet-generated`
  (with `sourceMode`); the GPT lifecycle `gpt-agent-created` →
  `gpt-agent-deployed`; and failure events `draft-summary-failed`,
  `meds-worksheet-failed`, `meds-worksheet-pending` (so the *cause* of a
  skipped/blank step is visible, not just the symptom).

### Worksheet prompts (Layer 2 ids — edit in `clinical-prompts.md`)

The three worksheet prompts are stored under stable ids; each `sourceMode`
maps to one prompt id. To change worksheet output, edit the corresponding
prompt body in `clinical-prompts.md` (no code change needed; loader
auto-reloads on save):

| `sourceMode` | Prompt id | Placeholders |
|---|---|---|
| `apple-health-markdown` | `worksheet.apple-health-markdown` | `{ahFileTag}` `{medMarkdown}` `{legendLines}` `{cutoffDate}` |
| `epic-medication-list`  | `worksheet.epic-medication-list`  | `{medListText}` `{legendLines}` `{cutoffDate}` |
| `kb-retrieval`          | `worksheet.kb-retrieval`          | `{legendLines}` `{cutoffDate}` |

Placeholder semantics:
- `{cutoffDate}` — server-computed (today − 18 months, `YYYY-MM-DD`).
- `{ahFileTag}` — the `File N` tag of the Apple Health source file.
- `{legendLines}` — the `File N = <filename>` legend, one line each.
- `{medMarkdown}` — the Apple Health `medication_records.md` body.
- `{medListText}` — the deterministic Epic medication list (one line
  per drug: name | last action+date | `File N p.page`).

The hardcoded prompt in `server/index.js`'s `build*Prompt` helpers is
preserved as a safety-net fallback in case `clinical-prompts.md` is
missing or malformed.

---

## 2.6 Encounters Worksheet

A reverse-chronological list of clinical **encounters** across **all** of
the patient's source PDFs, shown as an "Encounters" card in My Lists.
Unlike the medication worksheets, it is **deterministic** — built by
parsing the source files directly, with **no agent call and no KB
retrieval** — so it is fast, reproducible, and independent of agent
state.

- **Endpoint**: `POST /api/encounters/worksheet` (build) / `GET` (read).
  Persists to `userDoc.encountersWorksheet = {table, legend,
  generatedAt, fileCount, encounterCount, modes}`.
- **Auto-builds at Setup** (since v1.4.3): `triggerSetupWorksheets()`
  in `ChatInterface.vue` fires the build alongside the two Medication
  Worksheets, gated on KB indexing completion. No more "press Generate
  to populate" — the list is ready by the time the user opens My Lists.
- **Extraction** (`server/utils/encounters-extractor.js`): each PDF in
  the KB folder is fetched from Spaces and parsed with `pdf-parse`;
  `extractEncountersFromText` detects encounter headers and maps each to
  a page.
  - **Epic-optimized**: matches the MGB/Epic header
    `MM/DD/YYYY - <kind> in <location>` (e.g. "08/27/2025 - Telemedicine
    in Department of Urology"); `(continued)` repeats collapse to the
    encounter's first page.
  - **Graceful degradation**: files with no Epic headers fall back to a
    generic "dated line with encounter-ish context" heuristic; unknown
    formats contribute nothing rather than erroring. Per-file `mode`
    (`epic`/`generic`/`none`) is recorded.
  - **Type** is classified into **Outpatient / Telemedicine /
    Inpatient** (`classifyEncounterType`): video/phone/e-consult →
    Telemedicine; admission/ED/discharge → Inpatient; office/OP/procedure/
    imaging/lab → Outpatient.
- **Page links**: page numbers come from the printed "… Page N" footers
  (which match the PDF page index); the Source column renders as
  `File N p.<page>` and links open that PDF at the page (same
  `openWorksheetSource` path as the medication worksheets). When a file
  lacks footers, pages are approximated proportionally.
- **Multiple files**: encounters from all PDFs are merged, deduped by
  date+descriptor, and sorted newest-first. The legend lists `File N =
  <filename>` with bucketKeys for the links.
- **Footer stripping**: `stripHeadersFooters(text, numPages)` removes
  repeating page header/footer boilerplate (institution/address, MRN/DOB,
  "Generated on … Page N"). It is available for cleaner KB indexing; the
  encounters detector itself runs on raw lines (encounter headers are
  unique, so they survive). Wiring footer-stripped text into the KB
  indexing pipeline is a separate, pending change (relevant to the
  medication-retrieval work).

---

## 3. Reference: Agents and Knowledge Bases

For the canonical parameters, see **`NEW-AGENT.txt`** at the repo root.
Do not duplicate those values here — link to the sections instead.

- **`## MAIA INSTRUCTION TEXT`** — the seed System Instructions used to
  create both Private AI agents. As currently configured it carries the
  agent's perspective, the redaction policy (e.g. sexual-function
  meds/syringes), and output formatting — deliverable-specific logic is
  NOT in the system instructions; it lives in the per-request prompts
  in `clinical-prompts.md` (see §2, §2.5, §4). Per-agent instructions
  diverge after creation (editable in My Stuff → My AI Agent sub-tabs).
- **`## Private AI Agents`** — two agents per user (since v1.4.0 the
  primary is GPT, not Deepseek):
  - **Primary**: Private AI (GPT) — `inference_name:
    openai-gpt-oss-120b`. Profile slot key `default`. The agent used
    by Setup/Restore wizard automation, by the medication-extraction
    and summary-draft endpoints, and selected by default in the chat
    dropdown.
  - **Secondary**: Private AI (Deepseek) — `inference_name:
    deepseek-v4-pro`. Profile slot key `gpt` (historical — see the
    note in NEW-AGENT.txt § Private AI Agents). Provisioned at Setup
    in parallel with the primary; Setup completion waits for both.
  - **UI labels derive from the actual stored model name**, not the
    slot key — for accounts created before the v1.4.0 swap, the
    `default` slot still holds a Deepseek agent, and the dropdown
    correctly labels it that way (`server/routes/chat.js` →
    `buildPrivateAiProfiles` reads each profile's `modelName` and
    labels accordingly).
- **`## Knowledge Bases`** — KB-creation parameters actually sent to
  DigitalOcean:
  - `embedding_model: GTE Large EN v1.5` (resolved to a UUID at
    runtime; overrideable via `DO_EMBEDDING_MODEL_ID`).
  - `reranking_model: BGE Reranker v2 m3` (resolved to model `id`
    `bge-reranker-v2-m3`).
  - `chunking_strategy`: **`hierarchical` (KB-1 default since v1.4.4)**
    or `semantic`. The two KB slots ALWAYS use OPPOSITE strategies —
    KB-1 hierarchical → KB-2 semantic (new accounts); KB-1 semantic
    → KB-2 hierarchical (pre-v1.4.4 accounts). The actual strategy
    each KB was created with is persisted on
    `userDoc.kbChunkingStrategy` (KB-1) and `userDoc.kb2.chunking`
    (KB-2); UI labels read those fields so they can never lie.
  - Hierarchical defaults: `parent_chunk_size=1500`,
    `child_chunk_size=400`.
  - Semantic defaults: `max_chunk_size=1200`, `similarity_threshold=0.4`.
  - Agent retrieval: `k=15`, `max_tokens=32768`,
    `retrieval_method=RETRIEVAL_METHOD_REWRITE`. See §7 for the
    rationale.
  - **OpenSearch database is NOT configurable** — always reuse the
    existing account cluster; create only if none exists. See the
    "OpenSearch database (NOT a configurable parameter)" note in
    `NEW-AGENT.txt`.

The actual parameters used at each KB creation are logged to
`maia-log.pdf` in the **"Knowledge base created"** entry.

---

## 4. Patient Summary

A clinical summary of the patient generated by the user's primary
Private AI (**GPT** as of v1.4.0) from the indexed knowledge base,
with deterministic "authoritative blocks" injected by the server to
remove the most common RAG failure modes.

- **Endpoints**: every Patient Summary endpoint shares ONE prompt
  builder (`buildPatientSummaryPromptForUser`) so they can never
  drift apart.
  - `POST /api/patient-summary/draft` — wizard flow (single-agent
    draft on the primary). Also the target for chat-intent routing:
    a typed message containing "patient summary" routes here instead
    of raw `/api/chat/digitalocean` so the same Layer-2 prompt always
    applies.
  - `POST /api/patient-summary/generate-pair` — runs the same prompt
    on BOTH Private AIs in parallel; the user picks one in the
    Patient Summary chooser. Per-agent failures (e.g. secondary not
    deployed yet) come back as `{ok:false, reason}` so a single-agent
    issue never 500s the call.
- **Prompt**: `patient-summary.draft` in `clinical-prompts.md`. The
  deliverable spec (the section list) lives in the prompt BODY —
  **not** in the System Instructions, which stay generic.
- **Three-tier source precedence** (since v1.4.2): the prompt tells
  the agent to prefer authoritative blocks → KB search → "Not
  documented in the available records." The agent must consult the
  KB before giving up on a section. The strict "must emit every
  heading" rule keeps the layout consistent regardless of which tier
  produced each section.
- **Authoritative blocks** (server-injected placeholders that
  override RAG):

  | Placeholder | Source | Notes |
  |---|---|---|
  | `{patientIdentity}` | PDF header parse (AH + Epic) | Name / DOB / age / sex |
  | `{medicalHistory}` | AH `### Conditions` + `### Procedures` + `### Past Medical History` + `### Family History` | Synthesized to narrative by the agent |
  | `{currentMedications}` | `userDoc.currentMedications` (patient-verified) | Used AS-IS when present |
  | `{stoppedMedications}` | `resolvePatientMedicationSource` filtered to entries > 18mo or status=discontinued | Same redaction as Current |
  | `{allergies}` | AH `Lists/allergies.md` (with inline AH-PDF fallback if sidecar missing) | Used AS-IS |
  | `{encounters}` | AH `Lists/clinical_notes.md` + Epic PDF parse, deduped by date | Past 12 months |
  | `{outOfRangeLabs}` | pdfjs walk of AH PDF preserving "OUT OF RANGE" red-text annotation | Date + analyte + page |
  | `{socialHistory}` | AH `### Social History` | Tobacco / alcohol / drugs / employment / living |
  | `{radiology}` | AH `### Radiology` / `### Imaging` / `### Diagnostic Imaging` (stitched) | Reverse-chronological |

  When no AH PDF is present, the placeholders not derivable from
  Epic alone are empty and the 3-tier spec falls through to RAG.
- **Resilience**: on a 401/403 (agent still deploying) the endpoint
  recreates the API key and retries; on persistent not-ready it
  returns `202 AGENT_NOT_READY` and logs `draft-summary-failed`.
- **Post-Restore**: a restored Patient Summary comes back as a draft.
  The post-reload guided-flow resume re-opens Setup at the summary
  step and logs `setup-resumed` so maia-log explains the re-entry.

---

## 4.5 Deterministic "list all X" queries

RAG is structurally incompatible with "list ALL X" queries — top-k
retrieval returns at most `k=15` chunks, and a patient with 30 TSH
readings can never see more than 15 surface in one query. The two
Private AIs each retrieve a different top-15, producing inconsistent
and incomplete lists.

For lab analytes we sidestep RAG entirely:

- **`GET /api/labs/history?analyte=TSH`** parses
  `${userId}/Lists/lab_results.md` deterministically and returns the
  COMPLETE per-analyte time series with date / value / units / H/L
  flag. ~25 common analytes are recognized by synonym
  (`server/utils/lab-history.js` `ANALYTE_SYNONYMS`). When no AH
  sidecar exists, returns `200 { available: false }` so the client
  falls through to RAG silently.
- **Chat intent routing**: a typed message matching
  `list all / show all / history / trend / timeline / over time /
  sorted by date` + a known analyte routes through `/api/labs/history`
  instead of raw chat. The pattern table lives in
  `src/components/ChatInterface.vue` (`LAB_ANALYTE_TERMS`); keep it
  in sync with the server's `ANALYTE_SYNONYMS`.
- **Sidecar format**: `Lists/lab_results.md` preserves the actual
  analyte readings as of v1.4.7 (each entry like
  `Aug 11, 2025 TSH 6.13 uIU/mL; HbA1c 5.7 %; …`). Pre-v1.4.7
  sidecars were summary-only (`Aug 11, 2025 (4 lines)`) and the
  parser degrades cleanly when it sees that legacy format.

**Known gap (v1.4.9)**: the deterministic path only fires for
accounts with an Apple Health PDF. Epic exports also contain lab
tables (per-visit), but we don't yet parse them into a per-analyte
index. Accounts with Epic-only KBs fall back to raw RAG for
"list all X" queries with the same top-k limitation. An Epic
lab-extraction module would mirror the meds-extractor / encounters-
extractor pattern (deterministic parse → sidecar) and is a natural
follow-up.

This pattern (deterministic endpoint + chat-intent route) is the
recommended template for any other "list all X" feature.

---

## 5. Reference: DigitalOcean Agent API

The exact GradientAI Platform API calls MAIA makes
(<https://docs.digitalocean.com/reference/api/digitalocean/#tag/GradientAI-Platform>).
(Moved from `NEW-AGENT.txt`.)

### Create agent
`POST /v2/gen-ai/agents`

```
{
  "name": "{userId}-agent-{YYYYMMDDThhmmss}",
  "instruction": "<seed from ## MAIA INSTRUCTION TEXT>",
  "model": { "uuid": "{model_uuid}" },
  "project_id": "{project_id}",
  "region": "tor1",
  "max_tokens": 16384,
  "top_p": 1,
  "temperature": 0.1,
  "k": 10,
  "retrieval_method": "RETRIEVAL_METHOD_REWRITE"
}
```
Required: `name`, `model.uuid`, `project_id`. Response's
`deployment.status` starts `STATUS_PENDING`.

> **`retrieval_method` MUST NOT be `RETRIEVAL_METHOD_NONE`.** `NONE`
> disables KB retrieval — every answer comes back "no records found"
> (caused blank Patient Summaries and worksheets historically). MAIA
> creates agents with `RETRIEVAL_METHOD_REWRITE` and `ensureAgentRetrieval`
> heals any existing agent still set to `NONE`.

### Update agent instruction
`PUT /v2/gen-ai/agents/{agent_uuid}` — body `{ "instruction": "…" }`.
`name`, `model`, `project_id` cannot change after creation.

### Poll deployment
`GET /v2/gen-ai/agents/{agent_uuid}` — poll until
`deployment.status === "STATUS_RUNNING"` (1–3 min typical); then read
`deployment.url` as the agent's inference endpoint. MAIA requires
RUNNING (not just URL-present) before marking the agent ready, because
the inference endpoint 403s until then.

### Create agent API key
`POST /v2/gen-ai/agents/{agent_uuid}/api_keys` — key name
`agent-{agent_uuid}-api-key`; secret stored per profile in
`userDoc.agentProfiles[<key>].apiKey` (flat `agentApiKey` is the primary
agent's key only).

### Knowledge base
`POST /v2/gen-ai/knowledge_bases` (create — see §3),
`GET /v2/gen-ai/knowledge_bases/{kb_uuid}/indexing_jobs`,
`…/data_sources`.

### Resolution rules
- **Model UUID** — primary: `DO_MODEL_ID` env → DO catalog match for
  `deepseek-v4-pro` → existing agent's model → first catalog model.
  Alternate: DO catalog match for `openai-gpt-oss-120b` only.
- **Project ID** — `DO_PROJECT_ID` env → discovered from an existing
  agent / the account's default project.
- **`k` (top-k retrieval)** — DO valid range 1–50 (probed; 100+ rejected).

---

## 6. Reference: Footer-stripped (clean-index) KB indexing

(Moved from `NEW-AGENT.txt`.)

KBs created from **v1.3.95** on (`userDoc.kbCleanIndex === true`) do
**not** index the raw PDFs. At KB creation each PDF is parsed and its
repeating page header/footer boilerplate — institution/address, MRN/DOB,
and especially the **"Generated on `<date>` Page N"** footer — is
stripped deterministically (`generateCleanIndexSidecars` →
`stripHeadersFooters` in `server/utils/encounters-extractor.js`). The
footer-free text is written to `${userId}/${kbName}/_clean/<name>.txt`
and the DO data source `item_path` points at `_clean/`. This keeps the
report generation date/time out of every retrieved chunk (RAG was
otherwise reporting that date as the prescription date).

PDFs remain in the KB folder untouched — viewing, page-links, file
membership (`kbIndexedBucketKeys`), and Restore all continue to use them.
`isKbFolderDataSourcePath` recognizes both the PDF folder and `_clean/`
as "the KB's folder data source". Re-index regenerates sidecars first.
If sidecar generation yields nothing (no PDFs / parse failure), the KB
falls back to indexing the raw PDF folder. Pre-v1.3.95 KBs keep
indexing raw PDFs until re-created.

**Restore always sets `kbCleanIndex = true`** (rehydrate), so a restored
account's KB is rebuilt/re-indexed against the `_clean/` sidecars —
upgrading pre-v1.3.95 accounts on restore. A KB that literally survived
a partial rehydrate (still has its old PDF-folder data source) is the
one exception until it is re-created.

Logged in `maia-log.pdf` as `clean-index-built (N files)`.

---

## 7. Reference: Chunking, embedding, retrieval — and why these defaults

The KB knobs live in `NEW-AGENT.txt § Knowledge Bases` (parsed by
`server/utils/kb-config.js`). This section documents the **rationale**
behind the current defaults — what we tuned, what we explicitly chose
*not* to expose, and what to change if your workload differs from the
typical MAIA account.

### What's typical

A typical MAIA account holds **5–15 PDFs**, ~**1M tokens**, mixing two
very different document populations:

1. **Apple Health export** (1 PDF if present). Hundreds of short, dated
   entries grouped by `### Category` (Conditions, Medications, Lab
   Results, Clinical Notes, …). Each entry is 3–4 lines: a date/page
   header, the observation, then a `---` separator. Strong, tiny
   semantic boundaries.
2. **Epic / MGB / hospital exports** (1–10 PDFs). Long narrative prose
   (visit notes, discharge summaries, operative reports) interleaved
   with structured tables (medication lists, lab panels). Soft, large
   semantic boundaries — paragraphs of 200–500 tokens.

The two populations behave very differently under retrieval, which is
why the defaults below combine **per-data-source chunking** with a
**deterministic-first prompt strategy** (see §4 Patient Summary).

### Defaults and the reasoning

| Knob | Value | Why |
|---|---|---|
| `embedding_model` | GTE Large EN v1.5 (1024-dim) | Best English-only embedding on the DO catalog. Note: **English-only**. Patients with non-English records (Spanish discharge summaries, etc.) will under-retrieve; consider a multilingual embedding if that applies. |
| `reranking_model` | BGE Reranker v2 m3 | Top non-proprietary reranker; multilingual; fast on short queries. Reranking is what turns "top-50 embed candidates" into the actual top-`k` the LLM sees. |
| `chunking_strategy` | `hierarchical` | Child chunks (small) used for retrieval; parent chunks (larger) returned to the LLM. Better for the structured + narrative mix than flat semantic chunking. |
| `hierarchical_max_parent_chunk_size` | 1500 tokens | Keeps a full visit note / one Epic medication-list page intact in the LLM context. |
| `hierarchical_max_child_chunk_size` | 400 tokens | Small enough for precise embedding retrieval; large enough to carry a coherent paragraph. |
| `ah_lists_max_chunk_size` | 200 tokens | **Per-source override** for the AH `Lists/*.md` sidecar data source — one observation per chunk so the agent retrieves the *specific* records it asked about, not a 30-entry blob. Semantic (not hierarchical) since each entry is naturally self-contained. |
| Agent `retrieval_method` | `RETRIEVAL_METHOD_REWRITE` | DO's query-rewriting RAG. `NONE` disables retrieval entirely; `BASIC` is a worse fit for the multi-part Patient Summary query. |
| Agent `k` | 15 | The Patient Summary asks for ~9 distinct sections. With `k=10` the agent often gets <2 chunks per section; 15 covers most sections at least twice. |
| Agent `max_tokens` | 32768 | `k=15` × `parent_chunk_size=1500` = up to 22k context, plus the prompt and the response. 16k was too tight after these increases. |
| OpenSearch database | **not configurable** | One cluster per DO account; MAIA always reuses it. See `server/utils/opensearch-config.js`. |

### The AH-Lists data source

When a user uploads an Apple Health PDF, MAIA writes per-category
sidecars to `${userId}/Lists/*.md` (driven by
`server/utils/lists-processor.js`). The KB-creation code (`setupKnowledgeBase`)
adds **two data sources** to the KB:

1. **`${userId}/${kbName}/_clean/`** — the footer-stripped PDFs.
   Hierarchical chunks (`parent=1500`, `child=400`).
2. **`${userId}/Lists/`** — the AH sidecars. Semantic chunks
   (`max=200`). Skipped when no AH PDF is present.

`ensureAppleHealthListsBuilt` runs synchronously before KB creation so
the sidecars exist when DO crawls the path. This is also defensive:
the patient-summary draft endpoint runs the same helper, so even a
race-modified userDoc can't strand the AH PDF without sidecars.

### Two KB slots, opposite strategies

Each account has two KB slots:

- **KB-1** (primary) — created at Setup; the agent retrieves from
  this by default. Hierarchical chunking (the v1.4.4 default).
  Recorded as `userDoc.kbId` + `userDoc.kbChunkingStrategy`.
- **KB-2** (alternate) — opt-in via My Stuff → My AI Agent. Always
  created with the OPPOSITE strategy from KB-1 (so when KB-1 is
  hierarchical, KB-2 is semantic, and vice versa for pre-v1.4.4
  accounts). Lets the user compare retrieval quality between
  strategies on the same corpus. Recorded as `userDoc.kb2 = {kbId,
  kbName, chunking, createdAt}`.

The UI labels in *My AI Agent* derive from these stored strategy
fields (`server/index.js` → `/api/agent-instructions`), so they
can never lie about what each KB actually is. For accounts
created in the brief window between the v1.4.4 default switch and
the v1.4.8 persistence code landing, the label falls back to the
current configured strategy — which was what those KBs were
actually created with.

### When to change the defaults

- **Lots of long discharge summaries / op reports** → bump
  `hierarchical_max_parent_chunk_size` to 2000–2500 so a full report
  fits in one parent. May require `max_tokens` to climb to 64k.
- **Only Apple Health, no clinical PDFs** → switch
  `chunking_strategy: semantic` with `semantic_max_chunk_size: 200` for
  the main source too (the hierarchical strategy adds little when every
  document is short-entry-shaped).
- **Multilingual records** → swap `embedding_model` for a multilingual
  embedding (e.g. `multilingual-e5-large`); the reranker is already
  multilingual so no change there.
- **Sub-second chat latency required** → drop `k` to 8 and
  `hierarchical_max_child_chunk_size` to 300 — embedding lookup and
  reranking both shrink linearly with these.

### Per-account override (not yet implemented)

All of the above is **server-wide** today. A future change could store
overrides on `userDoc.kbConfig` so accounts with unusual workloads (a
research account with thousands of PDFs, a translator with bilingual
records) can tune without affecting other users. The plumbing is
already there: `getKbConfig()` is the single read point.

---

## Change log

- *2026-05-24* — v1.4.9. Documentation drift sweep across all three
  layers (Layer 1 NEW-AGENT.txt, Layer 2 clinical-prompts.md, Layer 3
  this file). Fixed:
  - §3 / NEW-AGENT.txt § Private AI Agents — primary is **GPT** (not
    Deepseek) since v1.4.0; profile-key/model decoupling explained.
  - §3 / §7 — `chunking_strategy` default is **hierarchical** for
    KB-1 (not semantic). KB-2 is always the opposite strategy.
    `userDoc.kbChunkingStrategy` is the source of truth; UI labels
    derive from it.
  - §4 — Patient Summary endpoint list trimmed to the two that
    actually exist (`draft`, `generate-pair`). The three-tier source
    precedence (authoritative block → KB → "Not documented") and the
    full authoritative-block table (9 placeholders incl. v1.4.2/4.6
    additions for Medical History, Social History, Radiology,
    Stopped Medications) are now documented.
  - §4.5 (new) — Deterministic "list all X" queries:
    `/api/labs/history` + analyte-synonym chat-intent routing. Known
    gap flagged (Epic-only accounts fall back to RAG).
  - §1 — Lab Results & Vital Signs sidecars preserve actual analyte
    readings (v1.4.7), not `(N lines)` summaries.
  - §2.6 — Encounters worksheet now auto-builds at Setup (v1.4.3).
- *2026-05-19* — Initial version. Documents My Lists Categories and
  Current Medications as of v1.3.81 (multi-KB, soft-skip extraction,
  primary/alternate Private AI agents).
- *2026-05-20* — v1.3.89. Documented the exact current per-request
  prompts (Current Medications extract + both worksheet builders),
  including de-duplication by drug (not dose) and the 18-month "Current"
  cutoff. Clarified that medication logic lives in the prompts, not the
  System Instructions, and noted worksheet UI sorting + Source-page
  hyperlinks.
- *2026-05-23* — v1.3.107. `{outOfRangeLabs}` extraction fixed for
  Apple Health. The AH "OUT OF RANGE" annotation is rendered as red
  text in the PDF and is preserved only by **pdfjs**' structured
  markdown — `pdf-parse` drops it. `extractAppleHealthOorLabs` now
  walks the `extractPdfWithPages` fullMarkdown, tracking `## Page N`
  markers across the whole document (so page numbers stay correct even
  though the Lab Results heading starts after a page marker), tracks
  the visit-date line at each lab session, and captures every
  observation ending in "OUT OF RANG[E]?". Output is a clean
  per-observation list with date + page injected into
  `{outOfRangeLabs}`. Verified on natalie86's AH export: 26 OOR rows
  with accurate dates and pages (Hemoglobin A1c, Potassium, BUN, LDL,
  Triglycerides, ALT, etc.).
- *2026-05-23* — v1.3.106. Patient Summary gains `{outOfRangeLabs}`
  placeholder. When the user has an Apple Health PDF, the server slices
  its Lab Results section (`extractAppleHealthLabSection`) and hands it
  to the agent as authoritative — the agent lists only entries marked
  out of range / abnormal / High / Low / critical. With no AH file, the
  block instructs the agent to write a fixed note: *"Ask the Private AI
  for lists or graphs of specific lab results."* (User-edited prompt also
  dropped "(past 12 months)" qualifiers from sections other than Recent
  Visits.)
- *2026-05-23* — v1.3.105. Patient Summary improvements:
  - **{patientIdentity}** placeholder injects deterministically-extracted
    name / DOB / age / sex from the source PDF header
    (`server/utils/patient-identity.js`; covers Apple Health "Name:/Date
    of birth:/Legal sex:" and Epic "LastName, FirstName / DOB:/Legal
    Sex:" formats). Fixes summaries that said "age and sex not
    specified" even though the values were in the header.
  - **Per-agent Patient Summary instructions**: each Private AI can
    have its own prompt override at
    `userDoc.agentProfiles[profileKey].patientSummaryPrompt`. Endpoints
    `GET / POST /api/agent-instructions/patient-summary?profileKey=…`;
    `generate-pair` uses per-agent overrides; My Stuff → Patient Summary
    gained sub-tabs **Summary / Instructions for Deepseek / Instructions
    for GPT** with textarea + Save / Reset to default. The same
    `{patientIdentity} {currentMedications} {encounters} {allergies}`
    placeholders are substituted in overrides.
- *2026-05-23* — v1.3.103. Encounters: AH Clinical Notes (`clinical_notes.md`)
  is now the authoritative encounter source for Apple Health files
  (`parseAppleHealthClinicalNotes`); falls back to PDF parsing if the
  sidecar is missing. `buildEncountersTable` dedupes by **ISO date only**
  — same-date encounters across multiple files collapse into one row whose
  Source cell lists every contributing `File N p.<page>` (rendered as
  individual links in `Lists.vue`). Patient Summary draft prompt gained
  `{allergies}`: Apple Health's `allergies.md` is injected as an
  authoritative Allergies block when present.
- *2026-05-22* — v1.3.102. "Request New Summary" was using a different
  endpoint with a stub prompt that returned near-empty output. All
  Patient Summary paths now share `buildPatientSummaryPromptForUser`
  (Layer-2 spec + verified meds + past-12-month encounters). New
  `/api/patient-summary/generate-pair` runs the same prompt on BOTH
  Private AIs in parallel; MyStuffDialog renders both candidates with a
  "Choose this one" button per candidate (routes through the existing
  save flow).
- *2026-05-22* — v1.3.101. Wizard now verifies Current Medications
  before Patient Summary (restored). The unified `/api/medications/current`
  pre-fills the verify card instantly from the deterministic source. A
  server-side redaction filter (`server/utils/medication-redactor.js`,
  matching the System Instructions "sexual function + syringes" rule)
  drops obvious matches (sildenafil/tadalafil/vardenafil/avanafil/
  alprostadil/papaverine/phentolamine/trimix/yohimbine) before the list
  reaches the user. The Patient Summary draft prompt gained an
  `{encounters}` placeholder, populated by inline encounters extraction
  (past 12 months) so the agent has authoritative dated visits for the
  Recent Visits section.
- *2026-05-22* — v1.3.100. **Step 4 — unified Current Medications.**
  New `GET /api/medications/current` returns deterministic Current
  candidates via `resolvePatientMedicationSource(userId)` (Apple Health
  `medication_records.md` → Epic "Medication List" → none) +
  18-month cutoff. Lists.vue replaces the dual `/api/medications/extract`
  agent calls with this single deterministic fetch. New
  `parseAppleHealthMedRecords()` produces the same normalized shape as
  `extractEpicMedications`. The legacy extract endpoint is retained but
  no longer called.
- *2026-05-22* — v1.3.99. **Step 3 — Patient Summary spec.**
  `patient-summary.draft` (Layer 2) expanded into the full deliverable;
  `{currentMedications}` injection moves the "Current Medications
  Priority" rule out of the system prompt into the per-request prompt.
- *2026-05-22* — v1.3.98. Three-layer architecture: Layer 1 infra config
  (`NEW-AGENT.txt`, slimmed), Layer 2 clinical prompts (`clinical-prompts.md`,
  single editable source of truth), Layer 3 reference docs (this file).
  Removed verbatim prompt blocks from this file in favor of prompt-id
  references; moved the Agent API spec (§5) and footer-stripped indexing
  reference (§6) here from `NEW-AGENT.txt`; added §4 Patient Summary.
- *2026-05-22* — v1.3.94. Medication worksheets now extract the dated
  Epic "Medication List" deterministically (real Ordered-on/Discontinued-on
  dates + accurate page links, footer-stripped) and feed it inline to both
  agents — fixing the bug where the "Generated on" footer date was reported
  as the prescription date. KB-retrieval fallback now told to ignore footer
  dates.
- *2026-05-22* — v1.3.93. Stabilized agent provisioning: readiness now
  requires `STATUS_RUNNING` (fixes the 403→500 on draft summary /
  worksheets); agent endpoints retry 401/403 and return 202
  `AGENT_NOT_READY` instead of 500; GPT is provisioned concurrently with
  Deepseek at indexing start; added GPT lifecycle + failure events to
  maia-log.
- *2026-05-20* — v1.3.86. Worksheets and the legacy Current Medications
  extract now build from the Apple Health `medication_records.md`
  (dated, paged) passed inline, instead of unreliable `k=10` KB
  retrieval — fixes blank worksheets/lists (Deepseek especially). Also
  fixed the real root cause that agents were created with
  `retrieval_method: RETRIEVAL_METHOD_NONE` (KB ignored); now
  `RETRIEVAL_METHOD_REWRITE` + `ensureAgentRetrieval` self-heal.
- *2026-05-20* — v1.3.83. Added §2.5 Current Medications Worksheets
  (Deepseek + GPT). Setup now bypasses the old extract/verify/splice
  meds step, generates both worksheets, and gates completion on both
  Private AIs being provisioned. Worksheet endpoint attaches the KB
  before calling (fixes blank-table bug). maia-log.pdf gained a "How
  the My Lists tab works" reference page.
