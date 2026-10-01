/**
 * Lab rows an Apple Health export flags OUT OF RANGE, with their test name
 * even when a long name wrapped around the values: pdfjs renders Quest's
 * "VITAMIN D,25-OH,TOTAL,IA" as "VITAMIN D,25-" above the values line and
 * "OH,TOTAL,IA" below it, and the values line alone ("29.0 ng/mL 30 to 100
 * OUT OF RANGE") names no test. Mirrored in src/utils/oorLines.ts.
 */
export const isOutOfRangeLine = (l) => /OUT\s+OF\s+RANG/i.test(String(l || ''));

const strip = (l) => String(l || '').replace(/^#+\s*/, '').trim();

// A wrapped piece of a test name: starts with a letter, no column gaps,
// no result, not page furniture.
const isNamePiece = (l) => !!l && l.length <= 60 && /^[A-Za-z][A-Za-z0-9 ,()/\-'+.:]*$/.test(l)
  && !/\s{2,}/.test(l) && !isOutOfRangeLine(l) && !/^(lab results|page\b|continued\b|test\b)/i.test(l);

/** The flagged row at `i`, its test name restored from the lines around it if needed. */
export function oorLineWithName(lines, i) {
  const t = strip(lines[i]);
  if (/^[A-Za-z]/.test(t)) return t; // the name is on the row
  const before = strip(lines[i - 1]);
  if (!isNamePiece(before)) return t;
  const after = strip(lines[i + 1]);
  const name = isNamePiece(after) ? (/[-,]$/.test(before) ? before + after : `${before} ${after}`) : before;
  return `${name}   ${t}`;
}

/** Every flagged row in `lines`, each with its test name. */
export const outOfRangeLines = (lines) => (lines || [])
  .map((l, i) => (isOutOfRangeLine(l) ? oorLineWithName(lines, i) : null))
  .filter(Boolean);
