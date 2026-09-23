/**
 * Loose file-name matching for chat citations like "[<filename> p.<page>]".
 *
 * Models (and DigitalOcean's knowledge-base metadata) often write the
 * stored name with separators changed — "Health_Records_-_Adrian_Gropper_-
 * _2026-07-03_at_12.43.26.pdf" for "Health Records - Adrian Gropper -
 * 2026-07-03 at 12.43.26.pdf" — which an exact comparison never matches,
 * so the link fell back to the document chooser. Case, the .pdf extension,
 * and spaces / underscores / hyphens / dots are ignored.
 */
export const citationFileKey = (name: string): string =>
  String(name || '').toLowerCase().replace(/\.pdf$/i, '').replace(/[\s_\-.]+/g, '');

const MIN_PARTIAL_KEY = 6; // a fragment this short would match too much

export const citationFileMatches = (fileName: string, cited: string): boolean => {
  const a = citationFileKey(fileName);
  const b = citationFileKey(cited);
  if (!a || !b) return false;
  if (a === b) return true;
  return (b.length >= MIN_PARTIAL_KEY && a.includes(b)) || (a.length >= MIN_PARTIAL_KEY && b.includes(a));
};
