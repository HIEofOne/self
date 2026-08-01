/**
 * Privacy-filter pseudonymization — the single implementation of the
 * name-mapping transform (userDoc.privacyFilter.pseudonymMapping, managed in
 * Workbook → Privacy Filter). Used by:
 *   - POST /api/user-groups/filter-text (share-to-peer text, routes/groups.js)
 *   - the auto-generated privacy-filtered Patient Summary (server/index.js,
 *     PS/CM redesign Phase 4)
 * Matches "First Last", "Last First", "Last_First" and "First_Last" forms,
 * case-insensitively, replacing with the pseudonym in the same shape.
 */
export function applyPseudonymMapping(mapping, text) {
  let out = String(text || '');
  const list = Array.isArray(mapping) ? mapping : [];
  for (const { original, pseudonym } of list) {
    const parts = String(original || '').split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    const firstName = parts[0];
    const lastName = parts[parts.length - 1];
    const pseudoParts = String(pseudonym || '').split(/\s+/).filter(Boolean);
    const pseudoFirst = pseudoParts[0] || pseudonym;
    const pseudoLast = pseudoParts.length >= 2 ? pseudoParts[pseudoParts.length - 1] : pseudoFirst;
    out = out.replace(new RegExp(`${lastName}[_\\s]${firstName}`, 'gi'), `${pseudoLast}_${pseudoFirst}`);
    out = out.replace(new RegExp(`${firstName}[_\\s]${lastName}`, 'gi'), `${pseudoFirst}_${pseudoLast}`);
  }
  return out;
}
