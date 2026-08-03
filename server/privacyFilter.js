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

// ── Auto-seeding from the verified Patient Summary ───────────────────
// A records-first user who never chats can't build a mapping through the
// chat analyzer — but the summary's own structure names exactly the people
// that must be filtered: the patient header line and the visit providers.

const PSEUDO_FIRST = ['Alex', 'Morgan', 'Jordan', 'Taylor', 'Casey', 'Riley', 'Avery', 'Quinn', 'Rowan', 'Sage', 'Emerson', 'Finley', 'Harper', 'Kendall', 'Logan', 'Marlow', 'Nico', 'Parker', 'Reese', 'Skyler', 'Tatum', 'Devon', 'Ellis', 'Blake'];
const PSEUDO_LAST = ['Ashford', 'Barrett', 'Calloway', 'Draper', 'Ellery', 'Fairbanks', 'Granger', 'Holloway', 'Ingram', 'Jennings', 'Kingsley', 'Lockhart', 'Merritt', 'Norwood', 'Ogden', 'Prescott', 'Quimby', 'Radcliffe', 'Sterling', 'Thornton', 'Underhill', 'Vance', 'Whitfield', 'Yates'];

export const hashName = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };

// Words that mean a capitalized phrase is NOT a person: document/section
// vocabulary plus organization words ("Boston Medical Center").
const NOT_A_NAME = /\b(Patient|Verified|File|Health|Summary|Medication|Medications|Documented|Telephone|Encounter|Instructions|Notes|Outpatient|Telemedicine|Progress|Records|History|Apple|Hospital|Clinic|Center|Medical|General|Department|Laboratory|Radiology|Imaging|Associates|Group|Practice|Services)\b/i;

/** Extract the people a Patient Summary names. Formats the generator is
 *  known to emit:
 *   - patient header: "Adrian Gropper, 74 y, M" / "Adrian Gropper, 74, M"
 *     / "Adrian Gropper, 74"
 *   - providers, parenthesized: "(Wei Lien, MD)", "(Harshal Patil)"
 *   - providers, prose: "by Wei Lien, MD", "by Prasanna Gaonkar"          */
export function extractSummaryNames(summaryText) {
  const text = String(summaryText || '');
  const names = new Set();
  const patient = text.match(/^\s*([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+)+),\s*\d{1,3}\s*(?:y|,|$)/m);
  if (patient) names.add(patient[1].replace(/\s+/g, ' ').trim());
  const consider = (raw) => {
    const nm = String(raw).replace(/\s+/g, ' ').trim();
    if (/\d/.test(nm) || NOT_A_NAME.test(nm) || nm.split(' ').length < 2) return;
    names.add(nm);
  };
  const provRe = /\(([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’.-]+)+?)(?:,\s*(?:MD|DO|NP|CNP|PA|RN|CRNA|DDS|DPM|OD|PhD)\b[^)]*)?\)/g;
  let m;
  while ((m = provRe.exec(text)) !== null) consider(m[1]);
  const byRe = /\bby\s+([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’.-]+){1,3})/g;
  while ((m = byRe.exec(text)) !== null) consider(m[1]);
  return [...names];
}

/** Seed userDoc.privacyFilter.pseudonymMapping from the summary when the
 *  user has never configured one. Never touches an existing mapping, and a
 *  user who EXPLICITLY emptied theirs (lastUpdated set, list empty) has
 *  made a choice — only the never-configured state seeds. Returns true when
 *  a mapping was written. */
export function seedPseudonymMappingFromSummary(userDoc, summaryText) {
  const existing = userDoc.privacyFilter?.pseudonymMapping || [];
  if (existing.length > 0) return false;
  if (userDoc.privacyFilter?.lastUpdated) return false;
  const names = extractSummaryNames(summaryText);
  if (names.length === 0) return false;
  const used = new Set();
  const mapping = [];
  for (const original of names) {
    let h = hashName(original.toLowerCase());
    let pseudonym;
    do {
      // Chat-filter style: two-digit markers on BOTH parts ("Emily45
      // Johnson67") so filtered names are obviously fake, never mistaken for
      // a real person. Digits are hash-derived → stable across regenerations.
      const firstNum = 10 + (h % 90);
      const lastNum = 10 + (Math.floor(h / 90) % 90);
      pseudonym = `${PSEUDO_FIRST[h % PSEUDO_FIRST.length]}${firstNum} ${PSEUDO_LAST[Math.floor(h / 7) % PSEUDO_LAST.length]}${lastNum}`;
      h++;
    } while (used.has(pseudonym));
    used.add(pseudonym);
    mapping.push({ original, pseudonym, source: 'auto-summary' });
  }
  if (!userDoc.privacyFilter) userDoc.privacyFilter = {};
  userDoc.privacyFilter.pseudonymMapping = mapping;
  userDoc.privacyFilter.lastUpdated = new Date().toISOString();
  console.log(`[privacy-filter] Seeded ${mapping.length} pseudonym(s) from the verified summary for ${userDoc.userId}`);
  return true;
}
