# The Patient Summary / Medications / Citations Pipeline — as it actually is

Mapped 2026-07-19 by reading server/index.js end to end. No code changed.
This is the substrate under every recent "instability" report.

> **Since v2.0.6 (October 2026): the draft reads the records themselves.** When the patient's record PDFs fit the budget (`server/utils/records-text.js`: about 100,000 tokens, 75,000 for GPT-oss), `buildPatientSummaryPromptForUser` sends their full text, page by page as `=== File N, page P ===` in the citation links' File N order, with the prompt `patient-summary.records-in-context`. The deterministic blocks stay only as anchors where they are facts: the identity, verified or Apple Health medications, Apple Health allergies and flagged labs. The prompt adds a **Notable Lab Trends** section. Over the budget, the builder falls back to the extracts and knowledge base described below. Why: a Quest-only Apple Health export (Edith Pargh, 19 pages of labs) gave the extracts nothing but two flagged labs, and knowledge-base retrieval missed every LDL row; with the records in context, Qwen3.8-Max, GLM-5.3 and DeepSeek V4 Pro all produced accurate, fully cited summaries. Qwen3.8-Max is the default private AI for new accounts (`MAIA_PRIMARY_MODEL` overrides).

## 1. Generators (who writes summary text)

| Path | Endpoint | Prompt | Notes |
|---|---|---|---|
| Patient Summary tab → generate | `POST /api/generate-patient-summary` (11929) | `buildPatientSummaryPromptForUser` | Same builder as chat |
| Chat typed "patient summary" / wizard draft | `POST /api/patient-summary/draft` (11787) | `buildPatientSummaryPromptForUser` | Same builder |
| Chat fallback (non-DO provider, or draft 202) | raw `/api/chat/*` RAG | none of the injections | Free-form output |
| **Read-time splice** | `GET /api/patient-summary` | `serverReplaceMedicationsInSummary` (11244) | Splices VERIFIED meds into the stored text at read time — the displayed summary can differ from the saved text |

## 2. The one prompt builder (`buildPatientSummaryPromptForUser`, 11279)

- **Current Medications**: injected as AUTHORITATIVE **only if `userDoc.currentMedications` is non-empty** (i.e. patient has VERIFIED). Otherwise the placeholder is empty and the AI free-extracts from the KB — or writes "Not documented in the available records" if the KB has nothing yet. **This single conditional explains both brandon91 ("Not documented" — KB not indexed yet) and michael11 (AI-extracted meds with fill dates — KB indexed, meds unverified).** Two behaviors, one builder, gated on verification + KB state.
- Deterministic injections: patient identity (PDF headers + filename mining), Out-of-Range Labs (pdfjs over the AH PDF), Encounters (extractor/sidecar), Stopped Medications, Radiology.
- **Citation rule `[File N p.<page>]` + legend is attached ONLY to the Radiology block (11552) and the Stopped-Medications block.** Every other section may cite raw filenames — free-form.

## 3. Renderers (who makes citations clickable)

- **Tab renderer** (MyStuffDialog `renderPsHtml` → `processFileNCitations`): parses **`File N p.X`** tags only. Full-filename citations = dead text.
- **Chat renderer** (`messageDisplayHtml`, separate pipeline): also File-N based, plus lazy file-list loading.
- ⇒ Dead links whenever a section outside Radiology/Stopped-Meds cites filenames — **format mismatch, not a loading bug.** (michael11's meds section: filename citations → dead.)

## 4. Medication candidates for Lists (`resolvePatientMedicationSource`, 12599)

Priority: (1) Apple Health `Lists/medication_records.md` sidecar → (2) Epic "Medication List" extraction over PDFs → (3) none (manual entry card).
Two hard gates inside:

- `kbFiles` filter: when a KB exists, only files **whose bucketKey is inside the KB folder** count. A chat-imported file at `userId/<file>` (not yet indexed/moved) is **invisible to the meds resolver** even though Saved Files shows it and categories may exist.
- The AH branch reads the `medication_records.md` **sidecar**, which is written asynchronously by `process-initial-file`. Load Lists before the sidecar lands → manual-entry card; reload seconds later → candidates. ("Filled in after a few seconds.")

**⇒ michael11's empty meds card**: AH file either not yet inside the KB folder, or sidecar not yet written, at the moment Lists loaded — and nothing retries or signals progress.

## 5. Async jobs with silent failure (the nondeterminism engine)

- Import-time `process-initial-file` (categories + sidecars): fire-and-forget.
- Import-time `/api/medications/worksheet`: fire-and-forget; fails silently if the agent is deploying. **No retry, no visible state.**
- Indexing: the only path that MOVES files into the KB folder — a precondition the meds resolver silently depends on.

## 6. Entry points (superset)

Chat SEND-default; chat typed; tab generate; wizard guided flow; Lists GENERATE/REFRESH buttons; read-time splice on every GET.

## 7. The stabilization plan (agreed sequence, one PR each)

1. **Jobs made honest**: meds/categories/worksheet become visible, retryable jobs (status on the Lists tab; auto-retry when the agent turns ready; re-run after indexing moves files).
2. **One citation contract**: the `[File N p.X]` + legend rule moves from the Radiology block to the TOP-LEVEL prompt (all sections), and both renderers share one linkifier.
3. **Meds resolver sees pre-KB files**: candidates should resolve from any registered AH file (root or KB) — indexing changes storage, not truth.
4. Re-verify the meds gate & review-gate behaviors on that substrate.
