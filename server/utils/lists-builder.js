/**
 * Build Apple Health Lists/*.md sidecars on demand.
 *
 * Background: the Apple Health category-split pipeline normally runs
 * asynchronously during file upload, writing `${userId}/Lists/<cat>.md`
 * files (allergies.md, clinical_notes.md, medication_records.md, …).
 * `buildPatientSummaryPromptForUser` reads these as authoritative data
 * for the Allergies / Recent Visits / Current Medications sections.
 *
 * During Setup, the draft PS fires immediately when KB indexing
 * completes, which races the Lists builder — empty sidecars produced
 * "Not documented in the available records." headings even though the
 * AH PDF clearly contained the data.
 *
 * This helper provides a SYNCHRONOUS, in-process path to build the
 * sidecars from an Apple Health PDF. Used by the patient-summary
 * draft endpoint to guarantee sidecars exist before the agent runs.
 * Idempotent: if `appleHealthCategoriesBuiltAt` is already set on the
 * userDoc AND the canonical sidecar (clinical_notes.md) is present in
 * Spaces, returns early without re-running.
 *
 * The HTTP endpoint `/api/files/lists/process-initial-file` does
 * additional work (page-footer cleanup, "Continued on …" stripping)
 * before saving the full markdown. This helper SKIPS that cosmetic
 * cleanup — the sidecars it produces are correct for the PS pipeline,
 * even if their page-number headers are slightly off. Future work
 * could refactor the route to call this helper for the shared parts.
 */

import { extractPdfWithPages } from './pdf-parser.js';
import { extractAndSaveCategoryFiles } from './lists-processor.js';
import { putObjectWithLog } from './spaces-ops.js';

const APPLE_EXPORT_FOOTER_NORM =
  'this summary displays certain health information made available to you by your healthcare provider and may not completely';

/**
 * Pick the Apple Health PDF entry from `userDoc.files`. Prefers an
 * explicit `isAppleHealth` flag; falls back to filename heuristics
 * (the AH export is normally named "Health Records - <Patient> -
 * <date>.pdf"). Returns null when no candidate is found.
 */
export function findAppleHealthFileEntry(userDoc) {
  const files = Array.isArray(userDoc?.files) ? userDoc.files : [];
  const flagged = files.find(f => f?.isAppleHealth && f?.bucketKey);
  if (flagged) return flagged;
  return files.find(f =>
    f?.bucketKey && f?.fileName &&
    /(^|\b)(apple|health\s+records)\b/i.test(f.fileName)
  ) || null;
}

/**
 * Ensure Lists/*.md sidecars exist for this user's Apple Health PDF.
 * Returns one of: 'built' | 'cached' | 'no-ah-file' | 'pdf-missing' |
 * 'error'. Never throws — the PS pipeline must continue even if the
 * sidecar build fails (the agent's KB-RAG path is the safety net).
 *
 * `deps` shape:
 *   - readSpacesObjectBuffer(key) → Buffer | null
 *   - readSpacesTextObject(key)   → string | null
 *   - s3Client, bucketName        → for extractAndSaveCategoryFiles
 *   - cloudant                    → for the appleHealthCategoriesBuiltAt mark
 *   - log? (optional)             → console-shaped logger
 */
export async function ensureAppleHealthListsBuilt(userId, userDoc, deps) {
  const log = deps.log || console;
  if (!userId || !userDoc) return 'no-ah-file';

  const ahFile = findAppleHealthFileEntry(userDoc);
  if (!ahFile) return 'no-ah-file';

  // Fast path: already built AND the canonical sidecar is there.
  // We probe a sidecar (clinical_notes.md) rather than trust the flag
  // alone because a Restore that wipes Spaces can leave the flag set
  // with no actual sidecars on disk.
  if (userDoc.appleHealthCategoriesBuiltAt) {
    const probe = await deps.readSpacesTextObject(
      `${userId}/Lists/clinical_notes.md`
    );
    if (probe && probe.trim()) return 'cached';
  }

  const pdfBuf = await deps.readSpacesObjectBuffer(ahFile.bucketKey);
  if (!pdfBuf) return 'pdf-missing';

  let fullMarkdown = '';
  try {
    const result = await extractPdfWithPages(pdfBuf);
    fullMarkdown = (result?.pages || [])
      .map(p => `## Page ${p.page}\n\n${p.markdown}`)
      .join('\n\n---\n\n');
  } catch (e) {
    log.warn?.(`[lists-builder] extractPdfWithPages failed: ${e?.message || e}`);
    return 'error';
  }

  // Confirm this PDF actually IS an Apple Health export. If a non-AH
  // file slipped in via the filename heuristic, bail out rather than
  // create garbage sidecars.
  const norm = fullMarkdown.toLowerCase().replace(/\s+/g, ' ');
  if (!norm.includes(APPLE_EXPORT_FOOTER_NORM)) {
    log.info?.(`[lists-builder] ${ahFile.fileName} did not match AH footer — skipping sidecar build`);
    return 'no-ah-file';
  }

  // Also write the full markdown alongside the categories, so other
  // callers that expect `Lists/<name>.md` (Lists.vue, the worksheet
  // builders) work without a separate trip through the HTTP route.
  const listsFolder = `${userId}/Lists/`;
  try {
    const cleanFileName = String(ahFile.fileName).replace(/[^a-zA-Z0-9.-]/g, '_');
    const mdName = cleanFileName.replace(/\.pdf$/i, '.md');
    await putObjectWithLog({
      s3Client: deps.s3Client,
      bucketName: deps.bucketName,
      key: `${listsFolder}${mdName}`,
      body: fullMarkdown,
      contentType: 'text/markdown',
      metadata: { fileName: ahFile.fileName, processedAt: new Date().toISOString(), userId }
    });
  } catch (e) {
    log.warn?.(`[lists-builder] failed to write full markdown sidecar: ${e?.message || e}`);
    // Non-fatal — the category sidecars below are what the PS prompt reads.
  }

  try {
    await extractAndSaveCategoryFiles(
      fullMarkdown, userId, listsFolder, deps.s3Client, deps.bucketName
    );
  } catch (e) {
    log.warn?.(`[lists-builder] extractAndSaveCategoryFiles failed: ${e?.message || e}`);
    return 'error';
  }

  // Mark the userDoc so the fast path triggers next time. Best-effort
  // — a save conflict is non-fatal (the sidecars are already on disk).
  try {
    const fresh = await deps.cloudant.getDocument('maia_users', userId);
    if (fresh) {
      fresh.appleHealthCategoriesBuiltAt = new Date().toISOString();
      fresh.appleHealthCategoriesSourceKey = ahFile.bucketKey;
      if (Array.isArray(fresh.files)) {
        const idx = fresh.files.findIndex(f => f?.bucketKey === ahFile.bucketKey);
        if (idx >= 0 && !fresh.files[idx].isAppleHealth) {
          fresh.files[idx].isAppleHealth = true;
        }
      }
      fresh.updatedAt = new Date().toISOString();
      await deps.cloudant.saveDocument('maia_users', fresh);
    }
  } catch (e) {
    log.warn?.(`[lists-builder] mark-built save conflict (non-fatal): ${e?.message || e}`);
  }

  return 'built';
}
