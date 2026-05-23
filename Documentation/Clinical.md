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
- `Lab Results`
- `Vital Signs`
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
- **`## Private AI Agents`** — two agents per user:
  - **Primary**: Private AI (Deepseek) — `inference_name:
    deepseek-v4-pro`. The agent used by Setup/Restore wizard automation
    and by the medication-extraction and summary-draft endpoints
    described above.
  - **Alternate**: Private AI (GPT) — `inference_name:
    openai-gpt-oss-120b`. Optional, manually connectable per agent
    sub-tab; created lazily on first connect.
- **`## Knowledge Bases`** — KB-creation parameters actually sent to
  DigitalOcean:
  - `embedding_model: GTE Large EN v1.5` (resolved to a UUID at
    runtime; overrideable via `DO_EMBEDDING_MODEL_ID`)
  - `reranking_model: BGE Reranker v2 m3` (resolved to model `id`
    `bge-reranker-v2-m3`)
  - `chunking_strategy`: `semantic` (KB-1 default) or `hierarchical`
    (KB-2)
  - Semantic: `semantic_similarity_threshold`, `semantic_max_chunk_size`
  - Hierarchical: `hierarchical_max_parent_chunk_size`,
    `hierarchical_max_child_chunk_size`
  - **OpenSearch database is NOT configurable** — always reuse the
    existing account cluster; create only if none exists. See the
    "OpenSearch database (NOT a configurable parameter)" note in
    `NEW-AGENT.txt`.

The actual parameters used at each KB creation are logged to
`maia-log.pdf` in the **"Knowledge base created"** entry.

---

## 4. Patient Summary

A clinical summary of the patient generated by the user's primary
Private AI (Deepseek) from the indexed knowledge base.

- **Endpoints**: every Patient Summary endpoint shares ONE prompt
  builder (`buildPatientSummaryPromptForUser`) that applies the Layer-2
  `patient-summary.draft` prompt + `{currentMedications}` + past-12-month
  `{encounters}`. No more drift between paths.
  - `POST /api/patient-summary/draft` — wizard flow (single agent draft).
  - `POST /api/generate-patient-summary` — legacy single-agent endpoint
    (still in use by some flows; now uses the shared builder).
  - `POST /api/patient-summary/generate-pair` (v1.3.102+) — runs the
    same prompt on **both** Private AIs in parallel and returns both
    summaries so the user can compare and pick one. Used by "Request
    New Summary" on the Patient Summary tab. Per-agent failures (e.g.
    GPT not deployed yet) come back as `{ok:false, reason}` so the call
    never 500s on a single-agent issue.
- **Prompt**: `patient-summary.draft` in `clinical-prompts.md`. The
  deliverable spec (sections: Medical History incl. surgical; Recent
  Visits past 12 months with providers + diagnoses; Current Medications;
  Stopped or Inactive Medications; Allergies; Social History; Radiology
  past 12 months; Other Testing past 12 months) lives in the prompt
  body — **not** in the system prompt, which stays generic. A
  `{currentMedications}` placeholder is injected by the endpoint: when
  `userDoc.currentMedications` is set (verified by the patient), the
  prompt instructs the agent to use that list **AS-IS** for the
  Current Medications section (the "Current Medications Priority" rule,
  relocated from the system prompt to this per-request prompt). When
  the verified list is absent, the placeholder is empty and the agent
  extracts meds from the knowledge base as usual.
- **Resilience**: on a 401/403 (agent still deploying) the endpoint
  recreates the API key and retries; on persistent not-ready it returns
  `202 AGENT_NOT_READY` and logs `draft-summary-failed`.
- **Post-Restore**: a restored Patient Summary comes back as a draft.
  The post-reload guided-flow resume re-opens Setup at the summary
  step and logs `setup-resumed` so maia-log explains the re-entry.

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

## Change log

- *2026-05-19* — Initial version. Documents My Lists Categories and
  Current Medications as of v1.3.81 (multi-KB, soft-skip extraction,
  primary/alternate Private AI agents).
- *2026-05-20* — v1.3.89. Documented the exact current per-request
  prompts (Current Medications extract + both worksheet builders),
  including de-duplication by drug (not dose) and the 18-month "Current"
  cutoff. Clarified that medication logic lives in the prompts, not the
  System Instructions, and noted worksheet UI sorting + Source-page
  hyperlinks.
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
