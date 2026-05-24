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
