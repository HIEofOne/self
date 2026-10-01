/**
 * Lab rows an Apple Health export flags OUT OF RANGE, with their test name
 * even when a long name wrapped around the values ("VITAMIN D,25-" above the
 * values line, "OH,TOTAL,IA" below it). Mirrors server/utils/oor-lines.js.
 */
export const isOutOfRangeLine = (l: string | undefined) => /OUT\s+OF\s+RANG/i.test(String(l || ''));

const strip = (l: string | undefined) => String(l || '').replace(/^#+\s*/, '').trim();

const isNamePiece = (l: string) => !!l && l.length <= 60 && /^[A-Za-z][A-Za-z0-9 ,()/\-'+.:]*$/.test(l)
  && !/\s{2,}/.test(l) && !isOutOfRangeLine(l) && !/^(lab results|page\b|continued\b|test\b)/i.test(l);

/** The flagged row at `i`, its test name restored from the lines around it if needed. */
export function oorLineWithName(lines: string[], i: number): string {
  const t = strip(lines[i]);
  if (/^[A-Za-z]/.test(t)) return t;
  const before = strip(lines[i - 1]);
  if (!isNamePiece(before)) return t;
  const after = strip(lines[i + 1]);
  const name = isNamePiece(after) ? (/[-,]$/.test(before) ? before + after : `${before} ${after}`) : before;
  return `${name}   ${t}`;
}

/** Every flagged row in `lines`, each with its test name. */
export const outOfRangeLines = (lines: string[]): string[] => (lines || [])
  .map((l, i) => (isOutOfRangeLine(l) ? oorLineWithName(lines, i) : null))
  .filter((l): l is string => !!l);
