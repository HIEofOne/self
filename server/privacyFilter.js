/**
 * Privacy-filter pseudonymization — the single implementation of the
 * name-mapping transform (userDoc.privacyFilter.pseudonymMapping, managed in
 * Workbook → Privacy Filter). Used by:
 *   - POST /api/user-groups/filter-text (share-to-peer text, routes/groups.js)
 *   - the auto-generated privacy-filtered Patient Summary (server/index.js)
 *
 * Replacement style matches the CHAT-AREA filter (the original): the stored
 * pseudonym string is substituted verbatim — pseudonyms carry two-digit
 * markers on both parts ("Emily45 Johnson67") so filtered names are obviously
 * fake. The matched separator (space vs underscore) and name order are
 * preserved, and "Title + LastName" forms ("Dr. Gropper") get the pseudonym's
 * last part.
 */
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function applyPseudonymMapping(mapping, text) {
  let out = String(text || '');
  const list = (Array.isArray(mapping) ? mapping : [])
    .filter((m) => m && m.original && m.pseudonym)
    // Longest original first so "John Smith" is replaced before "John".
    .sort((a, b) => String(b.original).length - String(a.original).length);
  for (const { original, pseudonym } of list) {
    const parts = String(original).trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    const firstName = parts[0];
    const lastName = parts[parts.length - 1];
    const pseudoParts = String(pseudonym).trim().split(/\s+/).filter(Boolean);
    const pseudoFirst = pseudoParts[0] || pseudonym;
    const pseudoLast = pseudoParts.length >= 2 ? pseudoParts[pseudoParts.length - 1] : pseudoFirst;
    // "First Last" (prose) → pseudonym, word-bounded.
    out = out.replace(
      new RegExp(`\\b${esc(firstName)}\\s+${esc(lastName)}\\b`, 'gi'),
      `${pseudoFirst} ${pseudoLast}`
    );
    // "Last First" (prose, reversed) → order preserved.
    out = out.replace(
      new RegExp(`\\b${esc(lastName)}\\s+${esc(firstName)}\\b`, 'gi'),
      `${pseudoLast} ${pseudoFirst}`
    );
    // Underscore forms (file keys like "Gropper_Adrian_05-12.pdf"): \b never
    // fires next to "_" (a word character), so these run WITHOUT boundaries —
    // matching the original share-to-peer behavior.
    out = out.replace(
      new RegExp(`${esc(firstName)}_${esc(lastName)}`, 'gi'),
      `${pseudoFirst}_${pseudoLast}`
    );
    out = out.replace(
      new RegExp(`${esc(lastName)}_${esc(firstName)}`, 'gi'),
      `${pseudoLast}_${pseudoFirst}`
    );
    // "Dr. Gropper" / "Mr Gropper" → title kept, last name pseudonymized
    // (same title set the chat filter handles).
    out = out.replace(
      new RegExp(`\\b(Dr|Mr|Mrs|Ms|Prof)(\\.?\\s+)${esc(lastName)}\\b`, 'g'),
      (_m, title, sep) => `${title}${sep}${pseudoLast}`
    );
  }
  return out;
}
