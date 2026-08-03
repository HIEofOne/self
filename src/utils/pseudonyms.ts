/**
 * Client-side mirror of server/privacyFilter.js applyPseudonymMapping —
 * used to mask names in strings the CLIENT composes after the server-side
 * filtering already ran: the File legend and citation tooltips that
 * processFileNCitations builds from the user's real file names
 * ("GROPPER_ADRIAN_05_12_26.PDF" must not appear on a privacy-filtered
 * surface). Keep the replacement rules in sync with the server.
 */
export interface PseudonymEntry { original: string; pseudonym: string }

const esc = (s: string) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function applyPseudonymsClient(mapping: PseudonymEntry[] | null | undefined, text: string): string {
  let out = String(text || '');
  const list = (Array.isArray(mapping) ? mapping : [])
    .filter((m) => m && m.original && m.pseudonym)
    .sort((a, b) => String(b.original).length - String(a.original).length);
  for (const { original, pseudonym } of list) {
    const parts = String(original).trim().split(/\s+/).filter(Boolean);
    const pseudoParts = String(pseudonym).trim().split(/\s+/).filter(Boolean);
    const pseudoFirst = pseudoParts[0] || pseudonym;
    const pseudoLast = pseudoParts.length >= 2 ? pseudoParts[pseudoParts.length - 1] : pseudoFirst;
    if (parts.length === 1) {
      out = out.replace(new RegExp(`\\b${esc(parts[0]!)}\\b`, 'gi'), pseudoFirst);
      continue;
    }
    const firstName = parts[0]!;
    const lastName = parts[parts.length - 1]!;
    if (parts.length > 2) {
      out = out.replace(new RegExp(`\\b${parts.map(esc).join('\\s+')}\\b`, 'gi'), `${pseudoFirst} ${pseudoLast}`);
    }
    out = out.replace(new RegExp(`\\b${esc(firstName)}\\s+${esc(lastName)}\\b`, 'gi'), `${pseudoFirst} ${pseudoLast}`);
    out = out.replace(new RegExp(`\\b${esc(lastName)}\\s+${esc(firstName)}\\b`, 'gi'), `${pseudoLast} ${pseudoFirst}`);
    // Underscore file-key forms — no \b (underscore is a word character).
    out = out.replace(new RegExp(`${esc(firstName)}_${esc(lastName)}`, 'gi'), `${pseudoFirst}_${pseudoLast}`);
    out = out.replace(new RegExp(`${esc(lastName)}_${esc(firstName)}`, 'gi'), `${pseudoLast}_${pseudoFirst}`);
  }
  return out;
}
