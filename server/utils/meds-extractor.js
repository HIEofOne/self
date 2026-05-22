/**
 * Deterministic medication extractor for Epic / MGB exports.
 *
 * Epic "Medication List" sections carry structured, dated entries:
 *   <drug name + strength>
 *   Instructions: ...
 *   Authorized by: <provider>Ordered on: <M/D/YYYY>
 *   Start date: <M/D/YYYY>Quantity: ...
 *   (or, for stopped meds)
 *   Discontinued by: <provider>Discontinued on: <M/D/YYYY>
 *
 * We anchor on the "Ordered on:" / "Discontinued on:" lines (which only
 * appear in medication lists), pull the REAL prescription/stop date, and
 * map the entry to its PDF page via the same footer-based page map the
 * encounters extractor uses. The repeating "Generated on … Page N" footer
 * date is therefore NEVER mistaken for a prescription date (the bug when
 * the worksheet relied on KB retrieval over the raw PDF).
 */

import { buildLinePageMap, toIsoDate } from './encounters-extractor.js';

// A line that looks like a medication name carries a strength/form token.
const STRENGTH = /(\d+\s*(mg|mcg|ml|%|gauge|unit|meq)\b|\btablet|\bcapsule|\binjection|\bcream|\bointment|\bsolution|\bspray|\bpatch|\bsyrg\b|syringe|\binhaler|suspension|\bdrops|\blotion|\bgel\b|\bsupp|\bnebul)/i;
// Field/section/boilerplate lines that are NOT a medication name.
const FIELD_LINE = /^(instructions:|authorized by:|start date:|refill:|reason for|action:|quantity:|disp(?:ense)?:|sig:|generated on|encounter date:|mrn:|acct\s*#|medication list|active at the end|stopped in visit|not active|current outpatient|prior to admission|facility-administered|new prescriptions|discontinued medications|modified medications|previous medications|no medications|electronically signed|this report is|active at the|hospital-administered)/i;

const ORDERED_RE = /ordered on:\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i;
const DISCONTINUED_RE = /discontinued on:\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i;
const STARTDATE_RE = /start date:\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i;

/** Normalize a med line to a drug-identity key (ignore brand + strength). */
function drugKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')      // drop (BRAND, ...)
    .replace(/\d.*$/, ' ')            // drop from first digit (strength/form)
    .replace(/[^a-z\- ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract dated medications from one file's pdf-parse text.
 * Returns { meds: [{ name, status:'active'|'discontinued', isoDate, page, fileTag }], found }.
 */
export function extractEpicMedications(text, numPages, fileTag) {
  const lines = String(text || '').split('\n');
  const linePage = buildLinePageMap(lines, numPages || 1);
  const raw = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const ord = line.match(ORDERED_RE);
    const disc = line.match(DISCONTINUED_RE);
    const start = line.match(STARTDATE_RE);
    if (!ord && !disc && !start) continue;

    // Find the medication name: nearest preceding non-field line with a
    // strength/form token.
    let nameIdx = -1;
    for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
      const pl = lines[j].trim();
      if (!pl) continue;
      if (FIELD_LINE.test(pl)) continue;
      if (STRENGTH.test(pl)) { nameIdx = j; break; }
    }
    if (nameIdx === -1) continue;

    const name = lines[nameIdx].trim();
    const isDisc = !!disc;
    const dateRaw = disc ? disc[1] : (ord ? ord[1] : start[1]);
    const isoDate = toIsoDate(dateRaw);
    if (!isoDate) continue;
    raw.push({ name, status: isDisc ? 'discontinued' : 'active', isoDate, page: linePage[nameIdx] || 1, fileTag });
  }

  return { meds: raw, found: raw.length > 0 };
}

/**
 * Merge medications across files, de-duplicate by drug (ignoring dose),
 * keeping the entry with the most recent date, and return a clean,
 * reverse-chronological list. Status = the most recent entry's status.
 */
export function mergeMedications(allMeds) {
  const byDrug = new Map();
  for (const m of allMeds) {
    const key = drugKey(m.name) || m.name.toLowerCase();
    const existing = byDrug.get(key);
    if (!existing || m.isoDate > existing.isoDate) byDrug.set(key, m);
  }
  return [...byDrug.values()].sort((a, b) => (a.isoDate < b.isoDate ? 1 : a.isoDate > b.isoDate ? -1 : 0));
}

/**
 * Build the clean, inline medication-list text fed to the agent. Each line
 * gives the medication, its authoritative action+date, and the page. The
 * agent must use THESE dates (never a document footer date).
 */
export function buildMedListText(meds) {
  return meds.map(m => {
    const action = m.status === 'discontinued' ? `discontinued ${m.isoDate}` : `ordered ${m.isoDate}`;
    return `- ${m.name} | last action: ${action} | ${m.fileTag} p.${m.page}`;
  }).join('\n');
}
