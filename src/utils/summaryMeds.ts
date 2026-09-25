/**
 * The Current Medications section of a Patient Summary, as rows (P7d).
 * The review screen splits the summary around the section, lets the patient
 * edit the medicines as a list, and joins it back into one text to verify.
 * Twin of server/utils/summary-sections.js (parity test:
 * tests/backend/summary-sections.test.js) — keep the rules identical.
 */

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

export interface MedsSection {
  found: boolean;
  before: string;
  heading: string;
  rows: string[];
  note: string;
  after: string;
}

const stripDecoration = (line: string) => String(line || '').toLowerCase().replace(/[#*_`]/g, '').trim();

const isHeadingLine = (line: string): boolean => {
  const t = String(line || '').trim();
  if (!t) return false;
  if (/^#{1,6}\s+\S/.test(t)) return true;
  if (/^\*\*[^*]+\*\*:?\s*(\([^)]*\))?\s*$/.test(t)) return true;
  const s = stripDecoration(t).replace(/[:\s]+$/, '');
  return SUMMARY_SECTIONS.some((name) => s === name || s.startsWith(`${name} (`) || s.startsWith(`${name}:`));
};

const inlineText = (line: string): string => {
  const m = String(line || '').replace(/[#*_`]/g, '').match(/^[^:]*:\s*(.+)$/);
  return m ? m[1].trim() : '';
};

const findHeading = (lines: string[], name: string) =>
  lines.findIndex((l) => isHeadingLine(l) && stripDecoration(l).startsWith(name));

const EMPTY_NOTE = /^(none\b|no current|no known|not documented|not provided|nothing reported)/i;

const toRow = (line: string) => String(line).trim().replace(/^[-*•+]\s+/, '').replace(/^\d+[.)]\s+/, '').trim();

export function splitMedsSection(text: string): MedsSection {
  const lines = String(text || '').split('\n');
  const h = findHeading(lines, 'current medications');
  if (h < 0) return { found: false, before: String(text || ''), heading: '', rows: [], note: '', after: '' };
  let end = lines.length;
  for (let i = h + 1; i < lines.length; i++) {
    if (isHeadingLine(lines[i])) { end = i; break; }
  }
  const body = [inlineText(lines[h]), ...lines.slice(h + 1, end).map((l) => l.trim())].filter(Boolean);
  const rows: string[] = [];
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
    heading: inlineText(lines[h]) ? lines[h].replace(/:.*$/, '') : lines[h],
    rows,
    note,
    after: lines.slice(end).join('\n')
  };
}

export function joinMedsSection(parts: MedsSection, rows: string[]): string {
  if (!parts?.found) return parts?.before || '';
  const clean = (rows || []).map(toRow).filter(Boolean);
  const body = clean.length ? clean.map((r) => `- ${r}`).join('\n') : 'None';
  return [parts.before.replace(/\s+$/, ''), '', parts.heading, body, '', parts.after.replace(/^\s+/, '')]
    .join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** The generic drug name a row is about ("**Metformin** 500 mg [File 1]"
 *  → "metformin"), for matching rows against the records' list. */
export const drugKey = (row: string): string => {
  const base = String(row || '').replace(/[*_`]/g, '').replace(/[([【].*$/, '').trim().toLowerCase();
  return (base.split(/\s+/)[0] || base).replace(/[^a-z]/g, '');
};

/** Rows compared as lists, ignoring order, case, spacing and citations. */
export const sameMedList = (a: string[], b: string[]): boolean => {
  const norm = (r: string) => toRow(r).replace(/[*_`]/g, '').replace(/\s*\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const x = a.map(norm).filter(Boolean).sort();
  const y = b.map(norm).filter(Boolean).sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};
