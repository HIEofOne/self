/**
 * Multi-patient detection for a single user's file set.
 *
 * Background: a MAIA account is for ONE patient. If a user accidentally
 * uploads files for two different people (a spouse's records, a
 * dependent's records, a colleague's PDF), the resulting Patient
 * Summary may pull data from BOTH patients into one narrative —
 * objectively wrong and clinically unsafe. This module detects that
 * case and exposes a result the wizards / UI can use to block KB
 * creation until the user resolves the mismatch.
 *
 * The detection runs `parsePatientIdentityFromText` (from
 * `patient-identity.js`) against every PDF in the user's file set,
 * then compares results. **DOB is the authoritative signal**: it's
 * a structured date, less prone to extraction errors, and unique
 * enough that even close family members differ. Name matching is
 * a weak signal because PDF text extraction can mangle names
 * (concatenation, OCR drift, maiden/married/Jr./Sr. variants), so
 * a name mismatch alone never triggers — DOBs must differ too.
 *
 * Files without a parseable identity (some lab reports lack a
 * patient block) contribute nothing to the comparison — they can't
 * witness consistency in either direction.
 */

import { parsePatientIdentityFromText } from './patient-identity.js';

/**
 * Pull identity from every PDF in `files`. Returns one row per file,
 * including files with no parseable identity (those rows just have
 * null fields and are skipped by the comparator). `deps` carries the
 * S3 reader so this module stays I/O-injected and testable.
 */
export async function extractIdentitiesForFiles(files, deps) {
  if (!Array.isArray(files) || files.length === 0) return [];
  const out = [];
  for (const f of files) {
    if (!f?.bucketKey || !f?.fileName) continue;
    if (!/\.pdf$/i.test(f.fileName) && !/pdf/i.test(f.fileType || '')) continue;
    let identity = { name: null, dobIso: null, sex: null, age: null };
    try {
      const buf = await deps.readSpacesObjectBuffer(f.bucketKey);
      if (buf) {
        // Use pdf-parse here (same as patient-identity's existing
        // call site in server/index.js) — fast and enough for the
        // header. pdfjs is heavier and we don't need its red-text
        // annotation preservation for identity extraction.
        const pdfParse = (await import('pdf-parse')).default;
        const data = await pdfParse(buf);
        identity = parsePatientIdentityFromText(data.text);
      }
    } catch (e) {
      // Per-file parse failures are non-fatal — the row stays "no
      // identity parsed" and gets skipped by the comparator.
      deps.log?.warn?.(`[patient-consistency] parse failed for ${f.fileName}: ${e?.message || e}`);
    }
    out.push({
      fileName: f.fileName,
      bucketKey: f.bucketKey,
      isAppleHealth: !!f.isAppleHealth,
      name: identity?.name || null,
      dobIso: identity?.dobIso || null,
      sex: identity?.sex || null,
      age: identity?.age ?? null
    });
  }
  return out;
}

/**
 * Normalize a name for fuzzy comparison: strip non-letters, fold case,
 * collapse whitespace. Used only as a secondary signal — see file
 * header for why name matches alone don't trigger.
 */
function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z\s'\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compare an array of per-file identities and decide whether they
 * describe the same patient.
 *
 * Returns:
 *   {
 *     consistent: true | false,
 *     primary:    { name, dobIso, fromFiles: [fileName, ...] } | null,
 *     groups:     [{ name, dobIso, files: [{fileName, name, dobIso}, ...] }, ...],
 *     mismatches: [{fileName, name, dobIso}, ...]  // files NOT in the primary group
 *     reason:     string                            // human-readable summary
 *   }
 *
 * Decision rules:
 *   - Files with no DOB AND no name are excluded from the comparison.
 *   - If 0 or 1 file has a parseable identity → consistent.
 *   - Otherwise group files by DOB. If more than one DOB group is
 *     present → MISMATCH. The "primary" group is the largest one
 *     (ties broken by Apple Health > other; then by file order).
 *   - DOB-less files with a parseable name are matched against the
 *     primary group by normalized last-name token; non-matches are
 *     reported as soft mismatches in the `mismatches` array but the
 *     `consistent` flag stays based on DOB alone (don't false-alarm
 *     on extraction artifacts).
 */
export function detectPatientMismatch(identities) {
  const all = Array.isArray(identities) ? identities : [];
  const withSomething = all.filter(i => i.dobIso || i.name);
  if (withSomething.length <= 1) {
    const only = withSomething[0] || null;
    return {
      consistent: true,
      primary: only ? { name: only.name, dobIso: only.dobIso, fromFiles: [only.fileName] } : null,
      groups: only ? [{ name: only.name, dobIso: only.dobIso, files: [only] }] : [],
      mismatches: [],
      reason: only
        ? `Only one file has a parseable patient identity (${only.fileName}); no comparison possible.`
        : 'No files had a parseable patient identity; nothing to compare.'
    };
  }

  // Primary partition: group by DOB. DOB-less files go in a separate
  // null bucket and are reconciled afterwards by name.
  const byDob = new Map();
  const noDob = [];
  for (const i of withSomething) {
    if (i.dobIso) {
      if (!byDob.has(i.dobIso)) byDob.set(i.dobIso, []);
      byDob.get(i.dobIso).push(i);
    } else {
      noDob.push(i);
    }
  }

  // No DOB anywhere → can only compare by name (weak). Group by
  // normalized last-name token. If everyone matches the dominant
  // surname, treat as consistent. This is intentionally lenient.
  if (byDob.size === 0) {
    const bySurname = new Map();
    for (const i of withSomething) {
      const lastTok = normalizeName(i.name).split(' ').slice(-1)[0] || '';
      if (!bySurname.has(lastTok)) bySurname.set(lastTok, []);
      bySurname.get(lastTok).push(i);
    }
    const groups = [...bySurname.entries()].map(([surname, files]) => ({
      name: files[0].name, dobIso: null, surname, files
    }));
    if (groups.length <= 1) {
      const g = groups[0];
      return {
        consistent: true,
        primary: g ? { name: g.name, dobIso: null, fromFiles: g.files.map(f => f.fileName) } : null,
        groups,
        mismatches: [],
        reason: 'No DOB parsed from any file; names share a common surname.'
      };
    }
    // Multiple surnames AND no DOBs — soft mismatch, but don't block
    // (too easy to false-alarm on extraction artifacts).
    return {
      consistent: true,
      primary: { name: groups[0].name, dobIso: null, fromFiles: groups[0].files.map(f => f.fileName) },
      groups,
      mismatches: groups.slice(1).flatMap(g => g.files),
      reason: `No DOB parsed; multiple surnames detected (${groups.map(g => g.surname).join(', ')}). Possible mismatch — verify manually.`
    };
  }

  // We have at least one DOB. Pick the "primary" group = largest
  // DOB cohort; ties broken by Apple Health > other; then file order.
  const dobGroups = [...byDob.entries()].map(([dobIso, files]) => ({
    name: files.find(f => f.name)?.name || null,
    dobIso,
    files,
    score: files.length * 1000 + (files.some(f => f.isAppleHealth) ? 10 : 0)
  })).sort((a, b) => b.score - a.score);

  const primaryGroup = dobGroups[0];
  const mismatchGroups = dobGroups.slice(1);
  const mismatchFiles = mismatchGroups.flatMap(g => g.files);

  // Reconcile DOB-less files against the primary by normalized
  // last-name. Files whose surname doesn't match the primary's
  // surname are surfaced as additional soft mismatches.
  const primarySurname = normalizeName(primaryGroup.name).split(' ').slice(-1)[0] || '';
  for (const f of noDob) {
    const surname = normalizeName(f.name).split(' ').slice(-1)[0] || '';
    if (surname && primarySurname && surname !== primarySurname) {
      mismatchFiles.push(f);
    }
  }

  if (mismatchGroups.length === 0 && mismatchFiles.length === 0) {
    return {
      consistent: true,
      primary: { name: primaryGroup.name, dobIso: primaryGroup.dobIso, fromFiles: primaryGroup.files.map(f => f.fileName) },
      groups: dobGroups,
      mismatches: [],
      reason: `All ${primaryGroup.files.length} files with parseable identity match DOB ${primaryGroup.dobIso}.`
    };
  }

  const otherDobs = mismatchGroups.map(g => `${g.name || '(unnamed)'} DOB=${g.dobIso}`).join('; ');
  const reason = mismatchGroups.length > 0
    ? `SAFETY: Files for multiple patients detected. Primary: ${primaryGroup.name || '(unnamed)'} (DOB ${primaryGroup.dobIso}, ${primaryGroup.files.length} file(s)). Other: ${otherDobs}.`
    : `Some files lack a DOB and have surnames that don't match the primary (${primaryGroup.name}). Verify manually.`;

  return {
    consistent: mismatchGroups.length === 0, // soft (no-DOB) mismatches don't flip consistent
    primary: { name: primaryGroup.name, dobIso: primaryGroup.dobIso, fromFiles: primaryGroup.files.map(f => f.fileName) },
    groups: dobGroups,
    mismatches: mismatchFiles,
    reason
  };
}
