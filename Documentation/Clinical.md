# Clinical Features

A living reference for the clinical-data-handling features of MAIA:
**My Lists Categories** and **Current Medications**. Update this file as
clinical features are enhanced.

Companion docs:
- `NEW-AGENT.txt` — agent and knowledge-base configuration (canonical
  source for the parameters below).
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
that supersedes anything an AI pulls out of the knowledge base. The
Patient Summary uses it as its source of truth (see the **MAIA
INSTRUCTION TEXT** section of `NEW-AGENT.txt`, which instructs the
agent: *"if a Current Medications list is provided in the request, use
it as the authoritative source"*).

### Where the list comes from (in order of preference)

The wizard's Current Medications step (`src/components/ChatInterface.vue`
+ `Lists.vue`) tries the following sources and offers the result for
**human verification** before saving:

1. **Apple Health (`source: apple-health`).** If the user has an Apple
   Health Export PDF and the agent endpoint is ready, the client calls
   `POST /api/medications/extract` with `mode: 'apple-health'`. The
   server:
   - reads the focused, dated **`${userId}/Lists/medication_records.md`**
     category markdown (via `findMedicationRecordsMarkdown`); falls back
     to the full AH markdown `${userId}/Lists/<file>.md` only if that
     category file is missing,
   - sends the prompt below (see *Exact Private AI instructions*) to the
     user's **primary Private AI agent** (Deepseek; see `NEW-AGENT.txt`
     → *Private AI Agents*), using any `contextMeds` from an earlier
     `from-summary` extraction as reconciliation context,
   - parses the response into one med per line, then **filters out**
     preamble the model may add (markdown headings, a "Current
     Medications" label, the patient name/age line, bold markers, and
     "no current medications…" refusals).
   - **Soft-skip**: if the AH markdown isn't written yet, the user doc
     isn't found, the agent isn't configured, or there's no AH file,
     the endpoint returns `200 {success:true, skipped:true, reason}`
     and emits a `medications-extract-skipped` provisioning event (so
     the step shows in `maia-log.pdf`). The client cleanly falls back
     to the next source.

2. **Patient-summary draft (`source: patient-summary`).** The wizard
   first generates a draft Patient Summary (`/api/patient-summary/draft`)
   from the full knowledge base, then calls
   `POST /api/medications/extract` with `mode: 'from-summary'`. The
   server prompts the agent to extract Current Medications from the
   draft text.

3. **Existing `userDoc.currentMedications` (`source: user-doc`).** On
   Restore / resume, if a verified list already exists on the user doc
   it's offered as-is for re-verification — no AI call.

4. **Manual (`source: manual`).** If every automated path returns
   nothing, the wizard offers an empty editor for the user to type in.

### Exact Private AI instructions

Two layers drive every AI extraction:

**(a) Standing system instructions** — the agent is created with the
`## MAIA INSTRUCTION TEXT` from `NEW-AGENT.txt` (editable per agent
afterward). MAIA does **not** hard-code medication rules into the system
instructions; the only standing clause that affects medication output is
the redaction policy, currently:

> **Errors and Redactions** — Remove any mention of problems or
> medications for sexual function including syringes that may be
> prescribed.

(This is just an example of a redaction-type instruction; whatever a
user puts in their System Instructions is applied at extraction time.)
All extraction logic lives in the **per-request prompts** below, so it
keeps working regardless of how the user edits their System Instructions.

**(b) Per-request prompts** — sent by `POST /api/medications/extract`
(in `server/index.js`) to the user's **primary Private AI** (Deepseek).
Verbatim as of v1.3.89:

`mode: 'from-summary'` (extract from the draft Patient Summary;
`<draftPatientSummary.text>` is interpolated):
```
Below is a patient summary. Extract the Current Medications as a simple list, one medication per line, no commentary. Follow your system instructions for any medications that must be omitted or redacted.

<draftPatientSummary.text>
```

`mode: 'apple-health'` (extract from the dated medication-records
markdown; `<context block>` is included only when a prior `from-summary`
call supplied `contextMeds`; `<medication records markdown>` is the
`medication_records.md` text):
```
Below are this patient's dated medication records from their Apple Health export. Identify the patient's CURRENT medications: for each distinct drug, the most recent dated entry reflects the current prescription (and current strength). Exclude entries that are clearly one-time inpatient/anesthesia administrations (e.g. propofol, fentanyl, IV infusions) and older strengths that have been superseded by a newer one. Apply your system instructions for any medications that must be omitted or redacted (e.g. sexual-function drugs/syringes).

Output ONLY the list of current medications — one medication per line (name and current strength). Do NOT include the patient's name or age, any heading, any dates, any bullets, any bold, any blank lines, or any other commentary.<context block>

<medication records markdown>
```

where `<context block>` is:
```


For context, these medications were identified in the patient summary you generated earlier from the full knowledge base:
- <med 1>
- <med 2>

Use this list as a starting point, then reconcile and refine against the Apple Health data below.
```

Net effect: a one-medication-per-line list, no preamble; the "apply your
system instructions for omitted/redacted medications" clause defers to
the redaction rules at extraction time; the apple-health path reconciles
against the summary-derived list and dedups dose changes to the latest
strength per drug.
**These prompts must stay in sync with this doc** — if you change the
strings in `/api/medications/extract`, update them here too.

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
- **Source (v1.3.86+)**: when an Apple Health export is present, the
  worksheet is built from the structured **`${userId}/Lists/medication_records.md`**
  category markdown **passed inline** (`sourceMode:
  'apple-health-markdown'`). Every entry has a date and page number, so
  both Deepseek and GPT produce complete tables. This replaced pure KB
  retrieval, which with `k=10` over a large multi-hundred-page record
  routinely missed the medication pages and returned a header-only
  table (Deepseek was especially affected). KB retrieval
  (`sourceMode: 'kb-retrieval'`) remains the fallback when no Apple
  Health medication markdown exists; the endpoint attaches the KB and
  calls `ensureAgentRetrieval` in that path.
- **GPT auto-provisioning**: for `gpt`, the endpoint calls
  `ensureSecondaryAgent`; if the agent isn't deployed yet it returns
  `202 {pending:true}` and the client (My Lists REFRESH) retries.
- **Prompt**: one GFM table, columns `Medication | Status | Last date
  prescribed | Source`. Status is exactly one of Current / Discontinued
  / Inpatient. Two key rules (see verbatim prompts below):
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
  kicks off GPT provisioning, then opens the Patient Summary tab. Setup
  completion is **gated on both Private AIs being provisioned**
  (`ensureGptProvisioned` polls `POST /api/agents/ensure-secondary`).
- **Log**: `meds-worksheet-generated` (with `sourceMode`) and
  `gpt-agent-ready` events are rendered in `maia-log.pdf`, which also
  carries a static "How the My Lists tab works" reference page.

### Exact worksheet prompts

Built in `server/index.js`. `${cutoffDate}` = today − 18 months
(`YYYY-MM-DD`); `${ahFileTag}` = the `File N` tag of the Apple Health
file; `${legendLines}` = the `File N = <filename>` legend;
`${medMarkdown}` = the `medication_records.md` text. Verbatim as of
v1.3.89:

**Apple Health source** (`buildWorksheetPromptFromMarkdown`, used when
an Apple Health medication-records markdown exists →
`sourceMode: 'apple-health-markdown'`):
```
Below are this patient's medication records, extracted directly from their Apple Health export (${ahFileTag}). Each entry shows a date, the medication name and strength, and the page number it appears on.

Build a GitHub-flavored Markdown table with EXACTLY these columns — no title, no notes, no text before or after the table:

| Medication | Status | Last date prescribed | Source |

Rules per column:
- Medication: the drug name with the strength/form FROM ITS MOST RECENT entry (e.g. "atorvastatin 20 MG tablet"). One row per drug — see de-duplication below.
- Status: exactly one of —
    Current — this drug's most recent entry is an outpatient prescription (not stopped/held/discontinued) AND its Last date prescribed is on or after ${cutoffDate} (within the last 18 months).
    Discontinued — this drug's most recent entry is explicitly stopped/inactive/held, OR its Last date prescribed is BEFORE ${cutoffDate} (more than 18 months ago). A medication not prescribed in over 18 months is NOT current.
    Inpatient — administered during a hospital/inpatient encounter (e.g. anesthesia agents like propofol/fentanyl, IV infusions), not an outpatient take-home prescription.
  A drug can only be Current if its Last date prescribed is on or after ${cutoffDate}. Do not invent a status.
- Last date prescribed: the most recent date for that drug, as YYYY-MM-DD.
- Source: "${ahFileTag} p.<page>" using the page number of that most-recent entry. If no page is shown, use just "${ahFileTag}".

De-duplication (IMPORTANT): treat all entries for the same drug as ONE medication, regardless of strength or dose. A change in dose/strength over time is NOT a separate medication. Output exactly ONE row per drug, using ONLY the entry with the latest date — that entry's strength, date, and page. Do NOT create extra rows or a "Discontinued" row for older strengths/doses of the same drug; simply drop the older entries. (Different salts/formulations that are clinically distinct may be separate rows.)

Include EVERY distinct drug present in the records below (one row each). Apply your system instructions for any medications that must be omitted or redacted (e.g. sexual-function drugs/syringes).

File tags (for the Source column):
${legendLines}

Medication records:
${medMarkdown}
```

**Knowledge-base fallback** (`buildWorksheetPrompt`, used when no Apple
Health medication markdown exists → `sourceMode: 'kb-retrieval'`; the
endpoint attaches the KB and calls `ensureAgentRetrieval` first):
```
You are building a Current Medications Worksheet from this patient's records in your knowledge base. Use ONLY information found in your knowledge base; never infer, assume, or add a medication that is not present. Include EVERY medication you find.

Output a GitHub-flavored Markdown table with EXACTLY these columns — no title, no notes, no text before or after the table:

| Medication | Status | Last date prescribed | Source |

Rules per column:
- Medication: the drug name with the strength/form FROM ITS MOST RECENT entry (e.g. "atorvastatin 20 MG tablet"). One row per drug — see de-duplication below.
- Status: exactly one of —
    Current — this drug's most recent entry is actively prescribed (not stopped/held/discontinued) AND its Last date prescribed is on or after ${cutoffDate} (within the last 18 months).
    Discontinued — this drug's most recent entry is explicitly stopped/inactive/held, OR its Last date prescribed is BEFORE ${cutoffDate} (more than 18 months ago). A medication not prescribed in over 18 months is NOT current.
    Inpatient — administered during a hospital/inpatient encounter, not an outpatient take-home prescription.
  A drug can only be Current if its Last date prescribed is on or after ${cutoffDate}. Do not invent a status.
- Last date prescribed: the most recent date the drug was prescribed or ordered, as YYYY-MM-DD (use what is given if only a month/year is present; "—" if no date is found).
- Source: cite the entry that established the Last date prescribed, formatted as "File N p.<page>" using the file tags below. Do NOT write full file names in the table — use only the "File N" tag. If you cannot determine a page, use just "File N".

De-duplication (IMPORTANT): treat all entries for the same drug as ONE medication, regardless of strength or dose. A change in dose/strength over time is NOT a separate medication. Output exactly ONE row per drug, using ONLY the entry with the most recent Last date prescribed — its strength, date, and page. Do NOT create extra rows or a "Discontinued" row for older strengths/doses of the same drug; simply drop the older entries.

Apply your system instructions for any medications that must be omitted or redacted.

Source file tags (use only these in the Source column):
${legendLines}
```

**These prompts must stay in sync with this doc** — if you change the
strings in `buildWorksheetPromptFromMarkdown` / `buildWorksheetPrompt`,
update them here too.

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
  meds/syringes), and output formatting — medication-extraction logic is
  NOT in the system instructions; it lives in the per-request prompts
  (§2, §2.5). Per-agent instructions diverge after creation (editable in
  My Stuff → My AI Agent sub-tabs).
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
