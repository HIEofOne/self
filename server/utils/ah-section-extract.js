/**
 * Inline section extraction from an Apple Health export's markdown.
 *
 * `extractPdfWithPages()` on an Apple Health PDF produces markdown
 * where each clinical category appears under an `### <Category>`
 * heading. The Apple-Health `Lists/<cat>.md` sidecars normally split
 * those into individual files, but on the Setup-wizard timeline the
 * draft Patient Summary can fire BEFORE the sidecars are written.
 * These helpers are the in-process fallback: parse a section straight
 * out of the in-memory markdown so the PS prompt never gets an empty
 * placeholder just because of the race.
 *
 * Pure functions, no I/O — easy to unit-test.
 */

/**
 * Return everything under a `### <heading>` (case-insensitive) up to
 * but not including the next `#`/`##`/`###` heading. Strips empty
 * leading/trailing lines. Returns '' if the section is absent.
 *
 * `heading` matches the WORD at start of line (with optional `s`):
 * `extractCategorySection(md, 'allergies')` matches `### Allergies`,
 * `### Allergy`, `## Allergies`, etc.
 */
export function extractCategorySection(fullMarkdown, heading) {
  if (!fullMarkdown || !heading) return '';
  // Loose stem: strip trailing 'ies' → 'y' or trailing 's', so
  // "Allergies" / "Allergy" / "ALLERGY" / "Allergies:" all match the
  // search term "allergies". Apple Health uses the plural form for
  // category headings but other PDFs may not.
  const stem = (s) => String(s).toLowerCase().trim()
    .replace(/[*_:]/g, '').trim()
    .replace(/ies$/, 'y')
    .replace(/s$/, '');
  const want = stem(heading);
  const lines = String(fullMarkdown).split('\n');
  const out = [];
  let inside = false;
  for (const line of lines) {
    const stripped = line.trim();
    const headerMatch = stripped.match(/^#{1,3}\s+(.+?)\s*$/);
    if (headerMatch) {
      if (!inside && stem(headerMatch[1]) === want) {
        inside = true;
        continue;
      }
      if (inside) break; // next heading of any level ends the section
    }
    if (inside) out.push(line);
  }
  // Trim leading/trailing blank lines.
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join('\n');
}

/** Convenience wrapper used by buildPatientSummaryPromptForUser. */
export function extractAllergiesFromAppleHealthMarkdown(fullMarkdown) {
  return extractCategorySection(fullMarkdown, 'allergies');
}

/**
 * Pull the AH "### Social History" section. AH typically lists tobacco,
 * alcohol, drug use, exercise, employment, and living situation under
 * this heading. Returns '' when absent.
 */
export function extractSocialHistoryFromAppleHealthMarkdown(fullMarkdown) {
  return extractCategorySection(fullMarkdown, 'social history');
}

/**
 * Build a Radiology block from the AH PDF. The AH export labels imaging
 * results inconsistently across versions — "Imaging", "Diagnostic
 * Imaging", and "Radiology" all appear. Try each and stitch what we
 * find. Returns '' when none match.
 */
export function extractRadiologyFromAppleHealthMarkdown(fullMarkdown) {
  const candidates = ['Radiology', 'Imaging', 'Diagnostic Imaging', 'Imaging Studies'];
  const parts = [];
  const seen = new Set();
  for (const heading of candidates) {
    const section = extractCategorySection(fullMarkdown, heading);
    if (section && section.trim() && !seen.has(section)) {
      seen.add(section);
      parts.push(`**${heading}:**\n${section}`);
    }
  }
  return parts.join('\n\n');
}

/**
 * Pull together a Medical History authoritative block from the Apple
 * Health PDF's "Conditions" + "Procedures" + "Past Medical History"
 * categories. These are the sections the agent would have to reason
 * about from KB chunks otherwise — and reliably misses, leaving the
 * Patient Summary's Medical History heading empty. Returns '' if none
 * of the source sections are present.
 *
 * Each contributing section is labeled with its origin header so the
 * agent can preserve the distinction (Conditions vs Procedures) in
 * its narrative — and so a reader debugging an unexpected sentence
 * can trace it back to the right AH category.
 */
export function extractMedicalHistoryFromAppleHealthMarkdown(fullMarkdown) {
  const wanted = [
    { label: 'Conditions',           heading: 'Conditions' },
    { label: 'Procedures',           heading: 'Procedures' },
    { label: 'Past Medical History', heading: 'Past Medical History' },
    { label: 'Family History',       heading: 'Family History' }
  ];
  const parts = [];
  for (const w of wanted) {
    const section = extractCategorySection(fullMarkdown, w.heading);
    if (section && section.trim()) {
      parts.push(`**${w.label}:**\n${section}`);
    }
  }
  return parts.join('\n\n');
}
