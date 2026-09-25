/**
 * Sections of a Patient Summary (group_requests.md P7d).
 *
 * The Current Medications section is the patient's verified medication
 * list: the review screen edits it as rows, a verified save derives
 * userDoc.currentMedications from it, and a "meds and allergies" share
 * releases it with the Allergies section. Twin of src/utils/summaryMeds.ts
 * (parity test: tests/backend/summary-sections.test.js) — keep the rules
 * identical.
 */

// The sections the summary prompts emit; any of them ends the one before.
export const SUMMARY_SECTIONS = [
  'medical history',
  'recent visits',
  'current medications',
  'stopped or inactive medications',
  'allergies',
  'social history',
  'radiology',
  'out of range labs',
  'other testing'
];

const stripDecoration = (line) => String(line || '').toLowerCase().replace(/[#*_`]/g, '').trim();

/** Does this line start a section — a markdown heading, a whole-line bold,
 *  or a known section name on its own line? */
const isHeadingLine = (line) => {
  const t = String(line || '').trim();
  if (!t) return false;
  if (/^#{1,6}\s+\S/.test(t)) return true;
  if (/^\*\*[^*]+\*\*:?\s*(\([^)]*\))?\s*$/.test(t)) return true;
  const s = stripDecoration(t).replace(/[:\s]+$/, '');
  return SUMMARY_SECTIONS.some((name) => s === name || s.startsWith(`${name} (`) || s.startsWith(`${name}:`));
};

/** Text written on the heading line itself: "Allergies: none" → "none". */
const inlineText = (line) => {
  const m = String(line || '').replace(/[#*_`]/g, '').match(/^[^:]*:\s*(.+)$/);
  return m ? m[1].trim() : '';
};

const findHeading = (lines, name) =>
  lines.findIndex((l) => isHeadingLine(l) && stripDecoration(l).startsWith(name));

// "None", "Not documented…", "No current medications", "Not provided…"
const EMPTY_NOTE = /^(none\b|no current|no known|not documented|not provided|nothing reported)/i;

const toRow = (line) => String(line).trim().replace(/^[-*•+]\s+/, '').replace(/^\d+[.)]\s+/, '').trim();

/**
 * Split a summary around its Current Medications section.
 * @returns {{ found: boolean, before: string, heading: string, rows: string[], note: string, after: string }}
 */
export function splitMedsSection(text) {
  const lines = String(text || '').split('\n');
  const h = findHeading(lines, 'current medications');
  if (h < 0) return { found: false, before: String(text || ''), heading: '', rows: [], note: '', after: '' };
  let end = lines.length;
  for (let i = h + 1; i < lines.length; i++) {
    if (isHeadingLine(lines[i])) { end = i; break; }
  }
  const body = [inlineText(lines[h]), ...lines.slice(h + 1, end).map((l) => l.trim())].filter(Boolean);
  const rows = [];
  let note = '';
  for (const l of body) {
    const row = toRow(l);
    if (!row) continue;
    if (EMPTY_NOTE.test(row)) { note = note || row; continue; }
    rows.push(row);
  }
  return {
    found: true,
    before: lines.slice(0, h).join('\n'),
    // Inline text moves into the body, so the heading keeps only its name.
    heading: inlineText(lines[h]) ? lines[h].replace(/:.*$/, '') : lines[h],
    rows,
    note,
    after: lines.slice(end).join('\n')
  };
}

/** Put the rows back as the section's body ("None" when empty). */
export function joinMedsSection(parts, rows) {
  if (!parts?.found) return parts?.before || '';
  const clean = (rows || []).map(toRow).filter(Boolean);
  const body = clean.length ? clean.map((r) => `- ${r}`).join('\n') : 'None';
  return [parts.before.replace(/\s+$/, ''), '', parts.heading, body, '', parts.after.replace(/^\s+/, '')]
    .join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** The body of any section, as written (for sharing). */
export function sectionBody(text, name) {
  const lines = String(text || '').split('\n');
  const h = findHeading(lines, name);
  if (h < 0) return '';
  let end = lines.length;
  for (let i = h + 1; i < lines.length; i++) {
    if (isHeadingLine(lines[i])) { end = i; break; }
  }
  return [inlineText(lines[h]), ...lines.slice(h + 1, end)].join('\n').trim();
}

/** userDoc.currentMedications as derived from a verified summary: the
 *  section's rows as "- " lines, or "None" when it lists nothing. Null when
 *  the summary has no Current Medications section. */
export function medsFromSummary(text) {
  const parts = splitMedsSection(text);
  if (!parts.found) return null;
  return parts.rows.length ? parts.rows.map((r) => `- ${r}`).join('\n') : 'None';
}

/**
 * The artifact a "meds and allergies" share releases, or '' when there is
 * nothing verified to release (the request then comes to the patient).
 *   1. A verified summary: its Current Medications and Allergies sections,
 *      from the privacy-filtered copy.
 *   2. Otherwise a separately verified medication list (full edition, until
 *      its back-port of P7d), with the pseudonym mapping applied.
 */
export function medsAllergiesArtifact(userDoc, applyMapping) {
  if (userDoc?.patientSummaryVerifiedAt) {
    const pf = String(userDoc.privacyFilteredSummary?.text || '');
    const meds = sectionBody(pf, 'current medications');
    const allergies = sectionBody(pf, 'allergies');
    if (meds || allergies) {
      return `Current Medications\n${meds || 'Not documented.'}\n\nAllergies\n${allergies || 'Not documented.'}`;
    }
  }
  const verifiedList = String(userDoc?.currentMedications || '').trim();
  if (userDoc?.currentMedicationsVerifiedAt && verifiedList) {
    return applyMapping(userDoc.privacyFilter?.pseudonymMapping || [], verifiedList);
  }
  return '';
}
