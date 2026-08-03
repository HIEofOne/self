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
    if (parts.length === 1) {
      // Single-name original (a patient header like "Margarita, 68, Female"):
      // word-bounded replace with the pseudonym's FIRST part, so prose stays
      // readable ("Margarita has Crohn's" → "Blake45 has Crohn's").
      const single = parts[0];
      const pseudoSingle = String(pseudonym).trim().split(/\s+/)[0] || pseudonym;
      out = out.replace(new RegExp(`\\b${esc(single)}\\b`, 'gi'), pseudoSingle);
      continue;
    }
    const firstName = parts[0];
    const lastName = parts[parts.length - 1];
    const pseudoParts = String(pseudonym).trim().split(/\s+/).filter(Boolean);
    const pseudoFirst = pseudoParts[0] || pseudonym;
    const pseudoLast = pseudoParts.length >= 2 ? pseudoParts[pseudoParts.length - 1] : pseudoFirst;
    // Full exact phrase FIRST, so middle names never leak ("Caroline
    // Macharia Mwangi" — the First+Last rule below only matches adjacent
    // first/last and would skip it entirely).
    if (parts.length > 2) {
      out = out.replace(
        new RegExp(`\\b${parts.map(esc).join('\\s+')}\\b`, 'gi'),
        `${pseudoFirst} ${pseudoLast}`
      );
    }
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
// vocabulary plus organization words ("Boston Medical Center",
// "PARTNERS HEALTHCARE").
const NOT_A_NAME = /\b(Patient|Verified|File|Health|Healthcare|Summary|Medication|Medications|Documented|Telephone|Encounter|Instructions|Note|Notes|Outpatient|Telemedicine|Progress|Records|History|Apple|Hospital|Clinic|Center|Centre|Medical|General|Department|Lab|Labs|Laboratory|Radiology|Imaging|Associates|Group|Practice|Services|Partners|System|Network|Foundation|Institute|University|College|Pharmacy|Insurance|Care|Clinical|Visit|Report|Letter|Plan|Referral|Consult|Consultation|Discharge|Admission|Office|Emergency|Medicine|Surgery|Exam|Examination|Assessment|Procedure|Operative|Pathology|Physical|Annual|Wellness|Immunization|Vaccination|Screening|Preventive|Order|Orders|Message|Document|Results?)\b/i;

/** Credentials that mark the preceding capitalized phrase as a PERSON —
 *  the strongest, format-independent signal in every summary variant. */
const CRED = 'MD|DO|NP|CNP|PA|RN|CRNA|DDS|DPM|OD|PhD|PsyD|APRN|LPN|LCSW|CNM|PharmD';

/** Would this capitalized phrase plausibly be a person's name?
 *  Shared by extraction AND by the refresh-time pruning of entries the
 *  auto-seeder created before this check existed. */
export function looksLikePersonName(raw) {
  const nm = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!nm || /\d/.test(nm)) return false;
  if (NOT_A_NAME.test(nm)) return false;
  const words = nm.split(' ');
  if (words.length > 4) return false;
  // ALL-CAPS multi-word phrases are organizations or document headings
  // ("PARTNERS HEALTHCARE"), never how a summary writes a person.
  if (words.length >= 2 && nm === nm.toUpperCase()) return false;
  // A pure-caps ACRONYM word inside a mixed phrase ("MGH Lab Waltham",
  // "UCLA Health West") marks an organization too.
  if (words.length >= 2 && words.some((w) => w.length >= 2 && /^[A-Z]+$/.test(w))) return false;
  return true;
}

/** Names the USER removed from the mapping — auto-seeding must never
 *  resurrect them. */
const suppressedSet = (userDoc) =>
  new Set((userDoc.privacyFilter?.suppressed || []).map((s) => String(s).toLowerCase()));

/** Extract the people a Patient Summary names. Formats the generator is
 *  known to emit:
 *   - patient header: "Adrian Gropper, 74 y, M" / "Adrian Gropper, 74, M"
 *     / single first name "Margarita, 68, Female"
 *   - providers with a credential ANYWHERE: "Theodor Sauer, MD (ORG)",
 *     "– Sharon Chou, MD, PARTNERS HEALTHCARE"
 *   - providers, parenthesized: "(Wei Lien, MD)", "(Harshal Patil)"
 *   - providers, prose: "by Wei Lien, MD", "by Prasanna Gaonkar"          */
export function extractSummaryNames(summaryText) {
  const text = String(summaryText || '');
  const names = new Set();
  // Patient header: allow a SINGLE name ("Margarita, 68, Female") — the
  // age anchor keeps single capitalized words from false-matching.
  const patient = text.match(/^\s*([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+)*),\s*\d{1,3}\s*(?:y|,|$)/m);
  if (patient) {
    const nm = patient[1].replace(/\s+/g, ' ').trim();
    if (!/\d/.test(nm) && !NOT_A_NAME.test(nm) && (nm.split(' ').length === 1 || looksLikePersonName(nm))) names.add(nm);
  }
  const consider = (raw) => {
    const nm = String(raw).replace(/\s+/g, ' ').trim();
    if (nm.split(' ').length < 2) return; // providers need first + last
    if (!looksLikePersonName(nm)) return;
    names.add(nm);
  };
  let m;
  // Credential-anchored (works in EVERY visit-line format).
  const credRe = new RegExp(`([A-Z][A-Za-z'’-]+(?:\\s+[A-Z][A-Za-z'’.-]+){1,3}),\\s*(?:${CRED})\\b`, 'g');
  while ((m = credRe.exec(text)) !== null) consider(m[1]);
  // Parenthesized people — "(Wei Lien, MD)", "(Harshal Patil)". STRUCTURAL
  // exclusion: a paren group that immediately FOLLOWS a credential
  // ("Theodor Sauer, MD (Clinical Note)") is a document type or an
  // organization, never a person — the provider already stands before it.
  const provRe = new RegExp(`\\(([A-Z][A-Za-z'’-]+(?:\\s+[A-Z][A-Za-z'’.-]+)+?)(?:,\\s*(?:${CRED})\\b[^)]*)?\\)`, 'g');
  const credBeforeParen = new RegExp(`(?:${CRED})[.,]?\\s*$`);
  while ((m = provRe.exec(text)) !== null) {
    if (credBeforeParen.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
    consider(m[1]);
  }
  const byRe = /\bby\s+([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’.-]+){1,3})/g;
  while ((m = byRe.exec(text)) !== null) consider(m[1]);
  return [...names];
}

/** Seed userDoc.privacyFilter.pseudonymMapping from the summary when the
 *  user has never configured one. Never touches an existing mapping, and a
 *  user who EXPLICITLY emptied theirs (lastUpdated set, list empty) has
 *  made a choice — only the never-configured state seeds. Returns true when
 *  a mapping was written. */
/** Deterministic, obviously-fake pseudonym: two-digit markers on BOTH
 *  parts ("Emily45 Johnson67"). Digits are hash-derived → stable across
 *  regenerations; `used` avoids collisions within one mapping. */
const makePseudonym = (original, used) => {
  let h = hashName(String(original).toLowerCase());
  let pseudonym;
  do {
    const firstNum = 10 + (h % 90);
    const lastNum = 10 + (Math.floor(h / 90) % 90);
    pseudonym = `${PSEUDO_FIRST[h % PSEUDO_FIRST.length]}${firstNum} ${PSEUDO_LAST[Math.floor(h / 7) % PSEUDO_LAST.length]}${lastNum}`;
    h++;
  } while (used.has(pseudonym));
  used.add(pseudonym);
  return pseudonym;
};

export function seedPseudonymMappingFromSummary(userDoc, summaryText) {
  const existing = userDoc.privacyFilter?.pseudonymMapping || [];
  if (existing.length > 0) return false;
  if (userDoc.privacyFilter?.lastUpdated) return false;
  const suppressed = suppressedSet(userDoc);
  const names = extractSummaryNames(summaryText).filter((n) => !suppressed.has(n.toLowerCase()));
  if (names.length === 0) return false;
  const used = new Set();
  const mapping = names.map((original) => ({ original, pseudonym: makePseudonym(original, used), source: 'auto-summary' }));
  if (!userDoc.privacyFilter) userDoc.privacyFilter = {};
  userDoc.privacyFilter.pseudonymMapping = mapping;
  userDoc.privacyFilter.lastUpdated = new Date().toISOString();
  console.log(`[privacy-filter] Seeded ${mapping.length} pseudonym(s) from the verified summary for ${userDoc.userId}`);
  return true;
}

/** ADDITIVE reseed for a mapping that is still entirely auto-generated:
 *  a regenerated summary can introduce people (new providers, a
 *  differently-formatted patient header) the original seed missed. Adds
 *  entries for extracted names not yet mapped; never modifies or removes
 *  anything. Callers gate on "every existing entry is auto-summary" so a
 *  hand-curated mapping is never touched. Returns count added. */
export function seedMissingNames(userDoc, summaryText) {
  const entries = userDoc.privacyFilter?.pseudonymMapping || [];
  const have = new Set(entries.map((e) => String(e?.original || '').toLowerCase()));
  const suppressed = suppressedSet(userDoc);
  const used = new Set(entries.map((e) => String(e?.pseudonym || '')));
  let added = 0;
  for (const original of extractSummaryNames(summaryText)) {
    if (have.has(original.toLowerCase()) || suppressed.has(original.toLowerCase())) continue;
    entries.push({ original, pseudonym: makePseudonym(original, used), source: 'auto-summary' });
    have.add(original.toLowerCase());
    added++;
  }
  if (added > 0) {
    if (!userDoc.privacyFilter) userDoc.privacyFilter = {};
    userDoc.privacyFilter.pseudonymMapping = entries;
    userDoc.privacyFilter.lastUpdated = new Date().toISOString();
    console.log(`[privacy-filter] Added ${added} pseudonym(s) from the current summary for ${userDoc.userId}`);
  }
  return added;
}
