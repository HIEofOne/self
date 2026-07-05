# MAIA Clinical Prompts

This file is **editable configuration** — the per-request prompts MAIA
sends to a Private AI for each clinical deliverable (worksheets,
current-medications extraction, patient summary, …). The generic
guardrail "system instruction" stays in `NEW-AGENT.txt`
(`## MAIA INSTRUCTION TEXT`); the prompts **here** specify *what each
deliverable looks like*. Edit freely.

## How this file is parsed

Each prompt is a block of the form:

    ### prompt: <id>
    <!-- placeholders: {name1} {name2} -->
    ```text
    <prompt body — `{name}` placeholders are substituted at call time>
    ```

Rules:
- Keep the heading line exact (`### prompt: <id>`) — the loader matches
  on it.
- The placeholder comment is documentation; the loader substitutes any
  `{name}` it finds in the body.
- The fenced block **must** be ` ```text ` (literal "text" language tag).
- If a prompt id is missing or the file is malformed, the loader returns
  `null` and the caller falls back to a hardcoded default so MAIA keeps
  working — but the editable version stops being used. Don't break the
  format if you can avoid it.

Loaded by `server/utils/clinical-prompts.js`. Reloads automatically when
the file's mtime changes (no restart needed in dev).

---

### prompt: worksheet.epic-medication-list
<!-- placeholders: {medListText} {legendLines} {cutoffDate} -->
```text
Below is this patient's medication list, extracted directly from the record. Each line gives the medication (name and strength), its most recent action and date (ordered or discontinued), and the page it appears on. These actions and dates are AUTHORITATIVE.

Build a GitHub-flavored Markdown table with EXACTLY these columns — no title, no notes, no text before or after the table:

| Medication | Status | Last date prescribed | Source |

Rules per column:
- Medication: the drug name with strength/form exactly as given. One row per drug — see de-duplication.
- Status: exactly one of —
    Current — the action is "ordered" AND the date is on or after {cutoffDate} (within the last 18 months).
    Discontinued — the action is "discontinued", OR the date is before {cutoffDate} (more than 18 months ago).
    Inpatient — a hospital/inpatient administration (e.g. anesthesia agents, IV infusions).
  A drug can only be Current if its date is on or after {cutoffDate}.
- Last date prescribed: the date given for that medication, as YYYY-MM-DD. Use ONLY the date provided on that medication's line. Do NOT use any other date from the documents, and NEVER use a document "Generated on" footer date.
- Source: the "File N p.<page>" exactly as given on that medication's line.

De-duplication: one row per drug, regardless of strength/dose changes.

Apply your system instructions for any medications that must be omitted or redacted (e.g. sexual-function drugs/syringes).

File tags (for the Source column):
{legendLines}

Medication list:
{medListText}
```

---

### prompt: worksheet.apple-health-markdown
<!-- placeholders: {ahFileTag} {medMarkdown} {legendLines} {cutoffDate} -->
```text
Below are this patient's medication records, extracted directly from their Apple Health export ({ahFileTag}). Each entry shows a date, the medication name and strength, and the page number it appears on.

Build a GitHub-flavored Markdown table with EXACTLY these columns — no title, no notes, no text before or after the table:

| Medication | Status | Last date prescribed | Source |

Rules per column:
- Medication: the drug name with the strength/form FROM ITS MOST RECENT entry (e.g. "atorvastatin 20 MG tablet"). One row per drug — see de-duplication below.
- Status: exactly one of —
    Current — this drug's most recent entry is an outpatient prescription (not stopped/held/discontinued) AND its Last date prescribed is on or after {cutoffDate} (within the last 18 months).
    Discontinued — this drug's most recent entry is explicitly stopped/inactive/held, OR its Last date prescribed is BEFORE {cutoffDate} (more than 18 months ago). A medication not prescribed in over 18 months is NOT current.
    Inpatient — administered during a hospital/inpatient encounter (e.g. anesthesia agents like propofol/fentanyl, IV infusions), not an outpatient take-home prescription.
  A drug can only be Current if its Last date prescribed is on or after {cutoffDate}. Do not invent a status.
- Last date prescribed: the most recent date for that drug, as YYYY-MM-DD.
- Source: "{ahFileTag} p.<page>" using the page number of that most-recent entry. If no page is shown, use just "{ahFileTag}".

De-duplication (IMPORTANT): treat all entries for the same drug as ONE medication, regardless of strength or dose. A change in dose/strength over time is NOT a separate medication. Output exactly ONE row per drug, using ONLY the entry with the latest date — that entry's strength, date, and page. Do NOT create extra rows or a "Discontinued" row for older strengths/doses of the same drug; simply drop the older entries. (Different salts/formulations that are clinically distinct may be separate rows.)

Include EVERY distinct drug present in the records below (one row each). Apply your system instructions for any medications that must be omitted or redacted (e.g. sexual-function drugs/syringes).

File tags (for the Source column):
{legendLines}

Medication records:
{medMarkdown}
```

---

### prompt: worksheet.kb-retrieval
<!-- placeholders: {legendLines} {cutoffDate} -->
```text
You are building a Current Medications Worksheet from this patient's records in your knowledge base. Use ONLY information found in your knowledge base; never infer, assume, or add a medication that is not present. Include EVERY medication you find.

Output a GitHub-flavored Markdown table with EXACTLY these columns — no title, no notes, no text before or after the table:

| Medication | Status | Last date prescribed | Source |

Rules per column:
- Medication: the drug name with the strength/form FROM ITS MOST RECENT entry (e.g. "atorvastatin 20 MG tablet"). One row per drug — see de-duplication below.
- Status: exactly one of —
    Current — this drug's most recent entry is actively prescribed (not stopped/held/discontinued) AND its Last date prescribed is on or after {cutoffDate} (within the last 18 months).
    Discontinued — this drug's most recent entry is explicitly stopped/inactive/held, OR its Last date prescribed is BEFORE {cutoffDate} (more than 18 months ago). A medication not prescribed in over 18 months is NOT current.
    Inpatient — administered during a hospital/inpatient encounter, not an outpatient take-home prescription.
  A drug can only be Current if its Last date prescribed is on or after {cutoffDate}. Do not invent a status.
- Last date prescribed: the most recent date the drug was actually prescribed/ordered (e.g. an "Ordered on" or "Start date"), as YYYY-MM-DD; "—" if none is found. IGNORE document footer dates such as "Generated on <date>" / "Exported on <date>" — those are when the report was printed, NOT when the medication was prescribed.
- Source: cite the entry that established the Last date prescribed, formatted as "File N p.<page>" using the file tags below. Do NOT write full file names in the table — use only the "File N" tag. If you cannot determine a page, use just "File N".

De-duplication (IMPORTANT): treat all entries for the same drug as ONE medication, regardless of strength or dose. A change in dose/strength over time is NOT a separate medication. Output exactly ONE row per drug, using ONLY the entry with the most recent Last date prescribed — its strength, date, and page. Do NOT create extra rows or a "Discontinued" row for older strengths/doses of the same drug; simply drop the older entries.

Apply your system instructions for any medications that must be omitted or redacted.

Source file tags (use only these in the Source column):
{legendLines}
```

---

### prompt: current-medications.extract.from-summary
<!-- placeholders: {draftText} -->
```text
Below is a patient summary. Extract the Current Medications as a simple list, one medication per line, no commentary. Follow your system instructions for any medications that must be omitted or redacted.

{draftText}
```

---

### prompt: current-medications.extract.apple-health
<!-- placeholders: {appleHealthMd} {contextBlock} -->
```text
Below are this patient's dated medication records from their Apple Health export. Identify the patient's CURRENT medications: for each distinct drug, the most recent dated entry reflects the current prescription (and current strength). Exclude entries that are clearly one-time inpatient/anesthesia administrations (e.g. propofol, fentanyl, IV infusions) and older strengths that have been superseded by a newer one. Apply your system instructions for any medications that must be omitted or redacted (e.g. sexual-function drugs/syringes).

Output ONLY the list of current medications — one medication per line (name and current strength). Do NOT include the patient's name or age, any heading, any dates, any bullets, any bold, any blank lines, or any other commentary.{contextBlock}

{appleHealthMd}
```

---

### prompt: patient-summary.draft
<!-- placeholders: {patientIdentity} {currentMedications} {stoppedMedications} {encounters} {allergies} {outOfRangeLabs} {medicalHistory} {socialHistory} {radiology} -->
```text
You are creating a Patient Summary for an on-call physician who has never seen this patient. Use ONLY information found in this patient's knowledge base; never fabricate. Apply your system instructions for any items that must be omitted or redacted.

Start with the patient's name, age, and sex on the first line.

{patientIdentity}

Then produce the following sections, in this order, each on its own highlighted heading line followed by a concise prose paragraph or short list (do not invent sub-headings, and do not show your reasoning).

**You MUST emit EVERY heading below, in this exact order**, regardless of how much data you found. Do not skip, merge, or rename headings.

For each section, in order of preference:
1. If an **authoritative block** is provided for that section below (look for "Authoritative …" headers further down), use it AS-IS — those blocks override the knowledge base.
2. Otherwise, **search the knowledge base** for that topic and summarize what you find. Do this BEFORE giving up — the absence of an authoritative block does NOT mean the data is missing; it just means it wasn't extracted deterministically.
3. ONLY if BOTH an authoritative block is absent AND the knowledge base has nothing on the topic, write the heading followed by exactly: "Not documented in the available records."

**Citations.** Whenever you state a fact drawn from the knowledge base, cite its source immediately after the fact in square brackets, formatted EXACTLY as `[<source PDF filename> p.<page number>]` — for example `[Health Records.pdf p.12]`. Use the source filename exactly as it appears in the knowledge base and include the page number when available. Do NOT add a "Source:" label, quotation marks, or any other text inside the brackets — just the filename and page.

- Medical History — a concise narrative including surgical history.
- Recent Visits (past 12 months) — providers seen and the diagnoses from those visits.
- Current Medications — medications the patient is CURRENTLY taking. A medication is current ONLY if it was prescribed, ordered, or refilled within the past 18 months. Medications whose most recent date is older than 18 months belong in Stopped or Inactive Medications, even if never explicitly discontinued.
- Stopped or Inactive Medications — meds explicitly discontinued, OR whose most recent date is more than 18 months ago (no longer current by age alone).
- Allergies
- Social History — brief: employment/school, living situation, tobacco/alcohol/drug use.
- Radiology
- Out of Range Labs
- Other Testing — PFTs, EKGs, etc.

{medicalHistory}

{encounters}

{currentMedications}

{stoppedMedications}

{allergies}

{socialHistory}

{radiology}

{outOfRangeLabs}
```
