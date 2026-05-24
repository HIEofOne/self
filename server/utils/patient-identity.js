/**
 * Deterministic patient identity extractor (name / DOB / sex / age) from
 * the header text of a clinical PDF.
 *
 * The Patient Summary's first line must give name, age, and sex — but the
 * agent was sometimes returning "Age and sex not specified" even though
 * DOB and Legal Sex are printed in the header of every Apple Health and
 * Epic export. We extract that header data deterministically and inject
 * it as an authoritative block, so the agent doesn't have to fish for it
 * in the KB chunks.
 *
 * Patterns cover the two known formats (and degrade gracefully otherwise):
 *   Apple Health (page 1):
 *     Name: Adrian Gropper
 *     Date of birth: 6/15/1952
 *     Legal sex: Male
 *   Epic / MGB (printed on every page header):
 *     Gropper, Adrian
 *     MRN: 10029566949, DOB: 6/15/1952, Legal Sex: M
 */

/** Compute age in whole years from an ISO `YYYY-MM-DD` date of birth. */
export function ageFromIsoDob(dobIso) {
  if (!dobIso) return null;
  const today = new Date();
  const dob = new Date(dobIso + 'T00:00:00');
  if (Number.isNaN(dob.getTime())) return null;
  let age = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
  return age >= 0 && age < 130 ? age : null;
}

/**
 * Title-case a single ALL-CAPS or all-lowercase name token.
 * "VOLYA" → "Volya"; "margaret" → "Margaret"; "O'BRIEN" → "O'Brien".
 * Mixed-case input is preserved as-is (assumed already correct).
 */
function titleCaseToken(s) {
  const t = String(s || '').trim();
  if (!t) return t;
  const isAllOneCase = t === t.toUpperCase() || t === t.toLowerCase();
  if (!isAllOneCase) return t;
  return t.toLowerCase().replace(/(^|['’\-\s])([a-z])/g, (_, prefix, ch) => prefix + ch.toUpperCase());
}

/**
 * Mine LASTNAME_FIRSTNAME-style patterns out of an array of filenames
 * to recover a patient name when the in-PDF header parse failed or
 * came back with only a first name. Epic / MGB exports almost always
 * follow:
 *     LASTNAME_FIRSTNAME_(Lastname _Firstname _Middle__)?MRN-...PDF
 * The leading ALL-CAPS `LASTNAME_FIRSTNAME` is the most reliable
 * source for the family name. Apple Health filenames don't match
 * this pattern (they start with "Health Records - …") and are
 * silently skipped. Returns the most-frequent (last, first) pair
 * across all matching filenames as `{ first, last }`, or null when
 * nothing matched.
 */
export function extractNameFromFilenames(fileNames) {
  if (!Array.isArray(fileNames) || fileNames.length === 0) return null;
  const counts = new Map(); // "LAST|FIRST" → count
  for (const raw of fileNames) {
    const s = String(raw || '');
    // Match leading ALL-CAPS LASTNAME_FIRSTNAME at the very start of
    // the filename. Requires at least 2-char each side and the second
    // token to be followed by an underscore (so we don't accidentally
    // grab MRN digits or numeric segments).
    const m = s.match(/^([A-Z]{2,})_([A-Z]{2,})_/);
    if (!m) continue;
    // Reject patterns where one of the captures is a known
    // non-personal-name token. (Empty list today — extend if we
    // see false positives in the wild.)
    const key = `${m[1]}|${m[2]}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (counts.size === 0) return null;
  // Most-frequent winner (ties broken by first-seen via Map iteration).
  let bestKey = null, bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) { bestKey = k; bestN = n; }
  }
  const [LAST, FIRST] = bestKey.split('|');
  return {
    first: titleCaseToken(FIRST),
    last: titleCaseToken(LAST)
  };
}

/**
 * Merge a partially-parsed identity with a filename-derived
 * {first, last} pair. Used to recover the last name when the AH
 * header gave only a first name (the new AH export drops the
 * surname). Returns a new identity object — the input is not
 * mutated. Rules:
 *   - If both header name and filename name are present and the
 *     header name already includes the filename last name, prefer
 *     the header (it's the most authoritative single source).
 *   - If the header name is a single token AND the filename pair's
 *     FIRST matches that token (case-insensitive, including common
 *     diminutives like Margarita ↔ Margaret), append the filename
 *     LAST. "Margarita" + (Volya, Margaret) → "Margarita Volya".
 *   - If the header name is missing entirely, use "FIRST LAST" from
 *     the filename pair.
 *   - Filename match never overrides a multi-token header name.
 */
export function mergeIdentityWithFilenamePair(identity, pair) {
  const id = { ...(identity || {}) };
  if (!pair || !pair.last) return id;
  const headerName = String(id.name || '').trim();
  // Header has 2+ tokens — assume it's complete, don't touch.
  if (headerName && headerName.split(/\s+/).length >= 2) {
    // …unless the last token doesn't match the filename last name AND
    // looks like a nickname. Too risky to auto-correct; skip.
    return id;
  }
  // Header is a single token OR empty.
  if (!headerName) {
    id.name = `${pair.first} ${pair.last}`;
    return id;
  }
  // Single-token header. If it's a diminutive of the filename FIRST
  // (e.g. "Margarita" vs "Margaret"), keep the header form and add
  // the last name. Diminutive check is intentionally loose: same
  // 3+ leading characters case-insensitive.
  const headerLow = headerName.toLowerCase();
  const filenameFirstLow = String(pair.first || '').toLowerCase();
  const sharesPrefix = headerLow.length >= 3 && filenameFirstLow.length >= 3 &&
    headerLow.slice(0, 3) === filenameFirstLow.slice(0, 3);
  if (sharesPrefix || !pair.first) {
    id.name = `${headerName} ${pair.last}`;
  } else {
    // The header single-token isn't a clear match for the filename
    // first name (e.g. middle name, nickname unrelated to the legal
    // first). Use the filename pair instead — it's the more
    // structured source.
    id.name = `${pair.first} ${pair.last}`;
  }
  return id;
}

/**
 * Insert a space at every lowercase→uppercase boundary in a name.
 * Repairs the PDF-extraction artifact where two adjacent text frames
 * with no whitespace character between them produce a concatenated
 * token like "ArnoldGlicksman". Idempotent on already-spaced names.
 * Exported for unit tests.
 */
export function splitCamelCase(name) {
  if (!name) return name;
  // Insert one space at each lowercase/letter → uppercase transition.
  // Handles "ArnoldGlicksman" → "Arnold Glicksman", "MaryO'Brien" →
  // "Mary O'Brien", "JeanBaptiste" → "Jean Baptiste". Doesn't disturb
  // already-spaced names ("Arnold Glicksman" stays as-is).
  return String(name)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalize "Male"/"Female"/"M"/"F" to the long form. */
function normalizeSex(raw) {
  if (!raw) return null;
  const v = String(raw).trim().toLowerCase();
  if (v === 'm' || v.startsWith('male')) return 'Male';
  if (v === 'f' || v.startsWith('female')) return 'Female';
  if (v.includes('non') && v.includes('binary')) return 'Non-binary';
  return raw.trim();
}

/**
 * Parse Name / DOB (ISO) / Sex from a chunk of PDF text. Best-effort: each
 * field returned independently as `null` when not found. Scans the head
 * of the document by default — the patient header is at the top in both
 * Apple Health and Epic.
 */
const MONTH_NAMES = {
  jan: 1, january: 1,  feb: 2, february: 2,
  mar: 3, march: 3,    apr: 4, april: 4,
  may: 5,              jun: 6, june: 6,
  jul: 7, july: 7,     aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12
};
function monthNameToIso(monthRaw, day, year) {
  const mon = MONTH_NAMES[String(monthRaw || '').toLowerCase()];
  if (!mon) return null;
  const d = parseInt(day, 10);
  const y = parseInt(year, 10);
  if (!Number.isFinite(d) || !Number.isFinite(y)) return null;
  return `${y}-${String(mon).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Collapse text-overlay duplication. MGB "Patient Extract" PDFs render
 * the patient banner in 3-4 stacked layers, producing strings like
 * "VOLYA,MARGARETVOLYA,MARGARETVOLYA,MARGARETVOLYA,MARGARET" after
 * pdf-parse. Without dedup, every name / DOB pattern fires on the
 * noisy concatenation and the captures are wrong. Mirrors the helper
 * in encounters-extractor.js; both extractors use it on first read.
 * Exported for tests.
 */
export function dedupOverlay(text) {
  const lines = String(text || '').split('\n');
  const out = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    out[i] = lines[i].replace(/(.{4,}?)\1{1,}/g, '$1');
  }
  return out.join('\n');
}

export function parsePatientIdentityFromText(text, maxScanChars = 8000) {
  // Run overlay dedup FIRST so MGB Patient Extract headers
  // ("VOLYA,MARGARETVOLYA,MARGARETVOLYA,MARGARET" → "VOLYA,MARGARET")
  // become parseable by the patterns below. Idempotent on clean text.
  const head = dedupOverlay(String(text || '')).slice(0, maxScanChars);

  // DOB. Try MM/DD/YYYY first (Epic, AH older format), then spelled-
  // month variants (the newer AH format used "Date of Birth: Jul 26,
  // 1958 (Age 67)…" with the institution name glued to the year),
  // then ISO (YYYY-MM-DD). Matching captures a position too — used
  // below as the anchor for name extraction.
  let dobIso = null;
  let dobMatch = null; // { index } when found
  const dobSlashPatterns = [
    /\bDate of birth[:\s]+(\d{1,2})\/(\d{1,2})\/(\d{4})\b/i,
    /\bDOB[:\s]+(\d{1,2})\/(\d{1,2})\/(\d{4})\b/i,
    /\bBirth date[:\s]+(\d{1,2})\/(\d{1,2})\/(\d{4})\b/i,
    /\bBorn[:\s]+(\d{1,2})\/(\d{1,2})\/(\d{4})\b/i
  ];
  for (const re of dobSlashPatterns) {
    const m = head.match(re);
    if (m) {
      dobIso = `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
      dobMatch = m;
      break;
    }
  }
  // Spelled-month: "Jul 26, 1958" / "July 26, 1958" / "26 Jul 1958".
  // The (?: ?) at the end lets the year run straight into adjacent
  // text (the AH "(Age 67)Mass General Brigham" glob).
  if (!dobIso) {
    const dobMonthPatterns = [
      /\b(?:Date of Birth|DOB|Birth date|Born)[:\s]+([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})\b/i,
      /\b(?:Date of Birth|DOB|Birth date|Born)[:\s]+(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4})\b/i
    ];
    const m1 = head.match(dobMonthPatterns[0]);
    if (m1) {
      const iso = monthNameToIso(m1[1], m1[2], m1[3]);
      if (iso) { dobIso = iso; dobMatch = m1; }
    }
    if (!dobIso) {
      const m2 = head.match(dobMonthPatterns[1]);
      if (m2) {
        const iso = monthNameToIso(m2[2], m2[1], m2[3]);
        if (iso) { dobIso = iso; dobMatch = m2; }
      }
    }
  }
  // ISO date: "Date of Birth: 1958-07-26" — uncommon in EHR exports
  // but cheap to support.
  if (!dobIso) {
    const m = head.match(/\b(?:Date of Birth|DOB|Birth date|Born)[:\s]+(\d{4})-(\d{1,2})-(\d{1,2})\b/i);
    if (m) {
      dobIso = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
      dobMatch = m;
    }
  }

  // Sex / gender
  let sex = null;
  const sexPatterns = [
    /\bLegal\s+sex[:\s]+(Male|Female|Non[- ]?binary|M|F)\b/i,
    /\bGender\s+identity[:\s]+([A-Za-z\- ]{2,15})/i,
    /\bSex[:\s]+(Male|Female|Non[- ]?binary|M|F)\b/i
  ];
  for (const re of sexPatterns) {
    const m = head.match(re);
    if (m) { sex = normalizeSex(m[1]); break; }
  }

  // Name — try a few formats. AH: "Name: First Last". Epic header:
  // "LastName, FirstName" line (often immediately above MRN/DOB).
  //
  // The AH "Name:" pattern allows a concatenated capture (no internal
  // space) because pdfjs/pdf-parse sometimes glues two text frames
  // together when the PDF lays out first/last in adjacent positioned
  // boxes with no explicit whitespace character between them. The
  // `splitCamelCase` post-processing below repairs that.
  let name = null;
  // Order matters — "Last,First" runs FIRST because it's the strongest
  // patient-context anchor (the MGB Patient Extract header puts the
  // name right next to MRN/DOB with no other "Name:" label nearby).
  // The "Name:" pattern is second and context-guarded — a generic
  // "Name:" label can appear under ContactPerson / HealthCareProxy /
  // Provider / Spouse / Referred / etc. The very first occurrence in
  // the head is almost always the patient's emergency contact, NOT
  // the patient (the patient block doesn't use a "Name:" label).
  const nameMatches = [
    // "LastName, FirstName" — allow optional whitespace after comma.
    // The MGB Patient Extract header renders as "VOLYA,MARGARET" with
    // no space after the comma; requiring `,\s+` (as we did) missed it.
    /^\s*([A-Z][A-Za-z\-'’]+,\s*[A-Z][A-Za-z\-'’]+(?:\s+[A-Z][A-Za-z\-'’]+)?)\s*$/m,
    /^\s*Name[:\s]+([A-Z][A-Za-z\-'’\.]+(?:\s+[A-Z][A-Za-z\-'’\.]+)*)\s*$/m,
    // Concatenated AH fallback ("Name: ArnoldGlicksman") — accept a
    // single CamelCase token that has at least one internal lowercase→
    // uppercase boundary. The split function inserts a space there.
    /^\s*Name[:\s]+([A-Z][a-z]+[A-Z][A-Za-z\-'’\.]+)\s*$/m
  ];
  // Labels in the ~200 chars BEFORE a "Name:" match that indicate the
  // match is some OTHER person (not the patient). When any of these
  // appear in the preceding context, the "Name:" capture is rejected.
  const NON_PATIENT_LABELS = /\b(ContactPerson|Contact Person|Spouse|Emergency|HealthCareProxy|Health Care Proxy|Next of Kin|Provider|Physician|Author|Signed|Signature|Referred|Friend|Relationship|Witness|Surrogate|Guarantor)\b/i;
  for (const re of nameMatches) {
    const m = head.match(re);
    if (!m) continue;
    // Context guard: only applied to the two "Name:" patterns
    // (re === nameMatches[1] || nameMatches[2]). The Last,First
    // pattern doesn't need it — it's already specific.
    if (re !== nameMatches[0]) {
      const ctxStart = Math.max(0, m.index - 200);
      const ctx = head.slice(ctxStart, m.index);
      if (NON_PATIENT_LABELS.test(ctx)) continue;
    }
    let n = m[1].trim();
    // Convert "Last, First" or "Last,First" → "First Last". The
    // `\s*` lets us catch the MGB no-space variant.
    if (/^[A-Za-z\-'’]+,\s*[A-Za-z\-'’]+/.test(n)) {
      const [last, rest] = n.split(/,\s*/);
      n = `${rest} ${last}`.trim();
    }
    // Repair PDF-extraction concatenation: "ArnoldGlicksman" →
    // "Arnold Glicksman". Only inserts a space at lowercase→uppercase
    // boundaries; idempotent on names that already have correct
    // spacing. Skips apostrophes and hyphens which are valid mid-name
    // characters that don't indicate a word boundary.
    n = splitCamelCase(n);
    // Skip "Page N", "Address ..." false positives.
    if (!/\b(page|address|mrn|generated)\b/i.test(n)) {
      name = n;
      break;
    }
  }

  // Anchor-line fallback: when no labeled "Name:" or "Last, First"
  // pattern matched, look at the non-empty line IMMEDIATELY ABOVE
  // the DOB match. The current AH export format places the patient's
  // first-name (or full name) alone on the line above the DOB:
  //
  //     Margarita
  //     Date of Birth: Jul 26, 1958 (Age 67)Mass General Brigham
  //
  // This is the strongest patient-context anchor we have — the
  // line right next to the DOB is overwhelmingly the patient,
  // not a referring physician or emergency contact. Much safer
  // than the global "Last, First" regex.
  if (!name && dobMatch && typeof dobMatch.index === 'number') {
    const before = head.slice(0, dobMatch.index).split('\n');
    // Walk backwards through up to 5 lines to find a non-empty,
    // non-noise candidate.
    for (let i = before.length - 1; i >= 0 && i >= before.length - 5; i--) {
      const line = String(before[i] || '').trim();
      if (!line) continue;
      // Reject lines that look like labels / page furniture / boilerplate.
      if (/^(allergies|conditions|clinical|medications|lab|vital|procedures|page|address|mrn|generated|continued|patient|provider|attn|referred|physician|signed|signature|from|to|by|of)\b/i.test(line)) continue;
      // Accept lines that look like a person's name: 1–3 capitalized
      // tokens, each starting with an uppercase letter. Allow common
      // mid-name characters (apostrophe, hyphen).
      const candidate = line.match(/^([A-Z][A-Za-z\-'’]+(?:\s+[A-Z][A-Za-z\-'’]+){0,3})$/);
      if (candidate) {
        name = splitCamelCase(candidate[1]);
        break;
      }
      // Also accept "Last,First" / "Last, First" anchor lines (the
      // MGB Patient Extract header form). Flip to "First Last".
      const commaForm = line.match(/^([A-Z][A-Za-z\-'’]+),\s*([A-Z][A-Za-z\-'’]+)$/);
      if (commaForm) {
        name = `${commaForm[2]} ${commaForm[1]}`;
        break;
      }
      // Also handle the AH "Margarita" single-token case — a single
      // capitalized word on its own line, immediately above DOB.
      const single = line.match(/^([A-Z][a-z]{1,30})$/);
      if (single) {
        name = single[1];
        break;
      }
      // First non-noise non-name line breaks the search.
      break;
    }
  }

  const age = ageFromIsoDob(dobIso);
  return { name, dobIso, sex, age };
}

/**
 * Render an authoritative identity block for the Patient Summary prompt.
 * Returns an empty string when no field was found, so the `{patientIdentity}`
 * placeholder cleanly disappears for sources that lack a parseable header.
 */
export function renderPatientIdentityBlock(id) {
  if (!id) return '';
  const lines = [];
  if (id.name)   lines.push(`- Name: ${id.name}`);
  if (id.dobIso) lines.push(`- Date of birth: ${id.dobIso}`);
  if (id.age != null) lines.push(`- Age: ${id.age} years`);
  if (id.sex)    lines.push(`- Sex: ${id.sex}`);
  if (lines.length === 0) return '';
  return `**Authoritative patient identity** (from the source PDF header):\n${lines.join('\n')}\n\nUse this AS-IS for the patient identification line at the top of the summary; do NOT say "age not specified" or "sex not specified" if the values are given here.`;
}
