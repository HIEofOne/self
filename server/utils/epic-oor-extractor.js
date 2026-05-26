// Epic OOR (Out-Of-Range) lab extractor — deterministic scan of
// non-Apple-Health PDF text for lab values flagged as out-of-range.
//
// Apple Health PDFs explicitly annotate OOR observations with the
// literal string "[OUT OF RANGE]" in their structured markdown, so
// we can pull those out cheaply. Epic exports DON'T carry that
// annotation — they use compact column flags (H / L / HIGH / LOW /
// CRITICAL / *) next to the value, and/or a reference range from
// which we can derive the flag numerically.
//
// This extractor is conservative: it only emits a row when we can
// identify all of (a) an analyte name, (b) a numeric value, and (c)
// either a flag token OR a parseable reference range that places the
// value outside. False positives (drug names, plain numbers, dates)
// are suppressed by an allowlist of recognizable lab analytes —
// extended on demand.
//
// Output: array of {
//   analyte,      // canonical lab name
//   value,        // numeric value as string (preserves original digits)
//   units,        // unit string, may be ''
//   refLow,       // numeric low end of reference range, or null
//   refHigh,      // numeric high end, or null
//   refRange,     // raw range text as displayed (for the user)
//   flag,         // 'H'/'L'/'HIGH'/'LOW'/'CRITICAL'/'*'/'OUT' (derived)
//   isoDate,      // YYYY-MM-DD if found near the line, else ''
//   page,         // page number where the line was found
//   fileTag       // 'File N' style legend tag
// }

const HFLAG_RE = /\b(HIGH|LOW|CRITICAL|H|L)\b/;
const STAR_FLAG = '*';

// Conservative allowlist of common lab analytes. Lowercase keys; the
// canonical display form is the value. Easy to extend.
const KNOWN_ANALYTES = {
  // Chemistry
  'glucose': 'Glucose',
  'creatinine': 'Creatinine',
  'bun': 'BUN',
  'urea nitrogen': 'BUN',
  'sodium': 'Sodium',
  'potassium': 'Potassium',
  'chloride': 'Chloride',
  'co2': 'CO2',
  'calcium': 'Calcium',
  'magnesium': 'Magnesium',
  'phosphorus': 'Phosphorus',
  'phosphate': 'Phosphate',
  'albumin': 'Albumin',
  'protein, total': 'Total Protein',
  'total protein': 'Total Protein',
  'bilirubin': 'Bilirubin',
  'bilirubin, total': 'Total Bilirubin',
  'total bilirubin': 'Total Bilirubin',
  'alkaline phosphatase': 'Alkaline Phosphatase',
  'alt': 'ALT',
  'ast': 'AST',
  'ggt': 'GGT',
  'ldh': 'LDH',
  'uric acid': 'Uric Acid',
  'egfr': 'eGFR',
  'gfr': 'eGFR',
  // Lipids
  'cholesterol': 'Cholesterol',
  'cholesterol, total': 'Total Cholesterol',
  'total cholesterol': 'Total Cholesterol',
  'hdl': 'HDL',
  'ldl': 'LDL',
  'triglycerides': 'Triglycerides',
  'lipoprotein(a)': 'Lipoprotein(a)',
  'lp(a)': 'Lipoprotein(a)',
  // Endocrine
  'tsh': 'TSH',
  'free t4': 'Free T4',
  't4': 'T4',
  'free t3': 'Free T3',
  't3': 'T3',
  'hba1c': 'HbA1c',
  'hemoglobin a1c': 'HbA1c',
  'a1c': 'HbA1c',
  // Hematology
  'wbc': 'WBC',
  'rbc': 'RBC',
  'hemoglobin': 'Hemoglobin',
  'hgb': 'Hemoglobin',
  'hematocrit': 'Hematocrit',
  'hct': 'Hematocrit',
  'platelet': 'Platelets',
  'platelets': 'Platelets',
  'mcv': 'MCV',
  'mch': 'MCH',
  'mchc': 'MCHC',
  'rdw': 'RDW',
  'neutrophils': 'Neutrophils',
  'lymphocytes': 'Lymphocytes',
  'monocytes': 'Monocytes',
  'eosinophils': 'Eosinophils',
  'basophils': 'Basophils',
  // Inflammation / cardiac / other
  'crp': 'CRP',
  'c-reactive protein': 'CRP',
  'esr': 'ESR',
  'ferritin': 'Ferritin',
  'iron': 'Iron',
  'tibc': 'TIBC',
  'transferrin': 'Transferrin',
  'vitamin d': 'Vitamin D',
  '25-hydroxy vitamin d': 'Vitamin D',
  'vitamin b12': 'Vitamin B12',
  'b12': 'Vitamin B12',
  'folate': 'Folate',
  'psa': 'PSA',
  'troponin': 'Troponin',
  'pth': 'PTH',
  'parathyroid hormone': 'PTH',
  'cortisol': 'Cortisol',
  'inr': 'INR',
  'pt': 'PT',
  'aptt': 'aPTT',
  'ptt': 'PTT',
  'd-dimer': 'D-Dimer'
};

// Build a regex that matches any of the analyte aliases as a leading
// label on a line. Case-insensitive; longest-first to avoid
// partial-match precedence problems (e.g. "A1c" inside "HbA1c").
const ANALYTE_KEYS = Object.keys(KNOWN_ANALYTES).sort((a, b) => b.length - a.length);

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ANALYTE_PATTERN = new RegExp(
  '^\\s*(' + ANALYTE_KEYS.map(escapeRegex).join('|') + ')\\b',
  'i'
);

// Reference range fragment: `(0.4-4.5)` or `(0.4 - 4.5 mIU/L)` or
// `0.4 - 4.5` (no parens, sometimes seen). Allow optional units after.
const RANGE_PATTERN = /(?:\(\s*(-?\d+(?:\.\d+)?)\s*[-–]\s*(-?\d+(?:\.\d+)?)[^)]*\)|(?:^|\s)(-?\d+(?:\.\d+)?)\s*[-–]\s*(-?\d+(?:\.\d+)?)\s*(?:[A-Za-z\/%μ]+)?(?:\s|$))/;

// A numeric value (the lab result). Allow leading minus, decimals.
const VALUE_PATTERN = /(?:^|\s)(-?\d+(?:\.\d+)?)(?=\s|$|[A-Za-z%\/])/;

// Date near a line — Epic often labels result blocks with a header
// `Collected: <date>` or `Result Date <date>`. We bubble up the
// nearest date observed in the prior 20 lines.
const DATE_PATTERNS = [
  /\b(\d{4})-(\d{2})-(\d{2})\b/,                     // 2024-01-15
  /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/,               // 1/15/2024
  /\b(\d{1,2})\/(\d{1,2})\/(\d{2})\b/                // 1/15/24
];

function toIso(m) {
  if (!m) return '';
  if (m[0].includes('-') && m[1].length === 4) return `${m[1]}-${m[2]}-${m[3]}`;
  if (m[0].includes('/')) {
    const mm = String(m[1]).padStart(2, '0');
    const dd = String(m[2]).padStart(2, '0');
    let yyyy = m[3];
    if (yyyy.length === 2) yyyy = '20' + yyyy; // pragmatic 2-digit assumption
    return `${yyyy}-${mm}-${dd}`;
  }
  return '';
}

function detectDate(line) {
  for (const re of DATE_PATTERNS) {
    const m = line.match(re);
    if (m) return toIso(m);
  }
  return '';
}

/**
 * Scan a single line (with the line index, prior-line cache for
 * date context, and page number) for an OOR lab result. Returns
 * a row object or null.
 */
function scanLine(line, opts) {
  const { dateContext, page, fileTag } = opts;
  const analyteMatch = line.match(ANALYTE_PATTERN);
  if (!analyteMatch) return null;
  const analyteRaw = analyteMatch[1].toLowerCase();
  const analyte = KNOWN_ANALYTES[analyteRaw] || analyteMatch[1];
  // Strip the analyte prefix so subsequent matches don't accidentally
  // capture characters that belong to the name.
  const after = line.slice(analyteMatch[0].length);

  // Value: first numeric token after the analyte.
  const valM = after.match(VALUE_PATTERN);
  if (!valM) return null;
  const value = valM[1];

  // Flag detection.
  let flag = null;
  if (HFLAG_RE.test(after)) {
    flag = (after.match(HFLAG_RE) || [])[1].toUpperCase();
  } else if (after.includes(STAR_FLAG)) {
    flag = '*';
  } else if (/\bOUT\s+OF\s+RANGE\b/i.test(line)) {
    flag = 'OUT';
  }

  // Reference range — used both to display and (if no explicit flag)
  // to derive the flag numerically.
  const rangeM = after.match(RANGE_PATTERN);
  let refLow = null, refHigh = null, refRange = '';
  if (rangeM) {
    const low = rangeM[1] ?? rangeM[3];
    const high = rangeM[2] ?? rangeM[4];
    if (low != null && high != null) {
      refLow = parseFloat(low);
      refHigh = parseFloat(high);
      refRange = `${low}-${high}`;
    }
  }

  // If no flag yet, derive from range.
  if (!flag && refLow != null && refHigh != null) {
    const v = parseFloat(value);
    if (!Number.isNaN(v)) {
      if (v < refLow) flag = 'L';
      else if (v > refHigh) flag = 'H';
    }
  }

  // Require SOME signal of OOR — bail out if neither flag nor range
  // can place this value outside.
  if (!flag) return null;

  // Units: cheap grab — first alphabetic token after the value that
  // isn't the flag itself. Optional.
  let units = '';
  const unitsM = after.match(/(?:-?\d+(?:\.\d+)?)\s*([a-zA-Z%/μ][\w%/μ]*)/);
  if (unitsM && !HFLAG_RE.test(unitsM[1])) units = unitsM[1];

  return {
    analyte,
    value,
    units,
    refLow,
    refHigh,
    refRange,
    flag,
    isoDate: dateContext || detectDate(line),
    page,
    fileTag
  };
}

/**
 * Extract OOR lab rows from a single PDF's text + per-line page map.
 *
 * `lines`     — array of text lines as produced by pdf-parse
 * `linePage`  — parallel array (linePage[i] = printed/logical page for lines[i])
 * `fileTag`   — 'File N' to attribute matches to
 */
export function extractEpicOorLabs(lines, linePage, fileTag) {
  if (!Array.isArray(lines) || lines.length === 0) return [];
  const out = [];
  let dateContext = '';
  for (let i = 0; i < lines.length; i++) {
    // Refresh date context if this line carries a date — keeps the
    // nearest preceding date attached to lab lines that don't repeat
    // the date themselves.
    const lineDate = detectDate(lines[i]);
    if (lineDate) dateContext = lineDate;
    const row = scanLine(lines[i], { dateContext, page: linePage[i] || 1, fileTag });
    if (row) out.push(row);
  }
  // Dedupe by (analyte, isoDate, value) — Epic sometimes prints the
  // same result block multiple times.
  const seen = new Set();
  return out.filter(r => {
    const k = `${r.analyte}|${r.isoDate}|${r.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
