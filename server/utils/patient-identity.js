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
export function parsePatientIdentityFromText(text, maxScanChars = 8000) {
  const head = String(text || '').slice(0, maxScanChars);

  // DOB
  let dobIso = null;
  const dobPatterns = [
    /\bDate of birth[:\s]+(\d{1,2})\/(\d{1,2})\/(\d{4})\b/i,
    /\bDOB[:\s]+(\d{1,2})\/(\d{1,2})\/(\d{4})\b/i,
    /\bBirth date[:\s]+(\d{1,2})\/(\d{1,2})\/(\d{4})\b/i,
    /\bBorn[:\s]+(\d{1,2})\/(\d{1,2})\/(\d{4})\b/i
  ];
  for (const re of dobPatterns) {
    const m = head.match(re);
    if (m) {
      dobIso = `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
      break;
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
  let name = null;
  const nameMatches = [
    /^\s*Name[:\s]+([A-Z][A-Za-z][A-Za-z\-'’\. ]{1,80})\s*$/m,
    /^\s*([A-Z][A-Za-z\-'’]+,\s+[A-Z][A-Za-z\-'’]+(?:\s+[A-Z][A-Za-z\-'’]+)?)\s*$/m
  ];
  for (const re of nameMatches) {
    const m = head.match(re);
    if (m) {
      let n = m[1].trim();
      // Convert "Last, First" → "First Last"
      if (/^[A-Za-z\-'’]+,\s+[A-Za-z\-'’]+/.test(n)) {
        const [last, rest] = n.split(/,\s+/);
        n = `${rest} ${last}`.trim();
      }
      // Skip "Page N", "Address ..." false positives.
      if (!/\b(page|address|mrn|generated)\b/i.test(n)) {
        name = n;
        break;
      }
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
