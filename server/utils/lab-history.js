/**
 * Deterministic per-analyte lab history.
 *
 * RAG over the indexed KB cannot reliably answer "list all TSH labs by
 * date" — top-k retrieval is structurally incompatible with "list ALL"
 * queries. A patient with 30 TSH readings will see at most `k` of them
 * surface (k=15 today), and the two Private AIs each retrieve a
 * different top-15, producing inconsistent and incomplete lists.
 *
 * This module sidesteps RAG entirely: it parses
 * `${userId}/Lists/lab_results.md` (built by lists-processor.js from
 * the Apple Health PDF) and returns the COMPLETE per-analyte time
 * series. As long as the AH lab_results.md sidecar exists, the answer
 * is exhaustive and deterministic.
 *
 * Format of `Lists/lab_results.md` (after the v1.4.7 fix):
 *
 *   # Lab Results
 *   **Total Observations:** 87
 *   **Date:** Aug 11, 2025 | **Page:** 64
 *   Aug 11, 2025 TSH 6.13 uIU/mL; Hemoglobin A1c 5.7 %; ...
 *   ---
 *   **Date:** Feb 18, 2025 | **Page:** 58
 *   Feb 18, 2025 TSH 5.12 uIU/mL; ...
 *   ---
 *   ...
 *
 * Pre-v1.4.7 sidecars only carried `Aug 11, 2025 (4 lines)` — the
 * parser handles both: when the body is the old (N lines) form, it
 * returns the date with `null` value so the caller can fall back to
 * RAG / explain to the user that re-uploading AH would help.
 */

/**
 * Build a list of common analyte synonyms so that user queries with
 * lay or abbreviated names match the names the AH PDF actually used.
 * The match function does a case-insensitive substring test on the
 * observation text; this list is a small set of well-known aliases
 * — not a comprehensive medical thesaurus.
 */
const ANALYTE_SYNONYMS = {
  // Endocrine
  'tsh':            ['tsh', 'thyroid stimulating hormone', 'thyrotropin'],
  'free t4':        ['free t4', 'ft4', 'thyroxine free'],
  'free t3':        ['free t3', 'ft3'],
  // Diabetes / glucose
  'a1c':            ['a1c', 'hba1c', 'hemoglobin a1c', 'glycated hemoglobin', 'glycohemoglobin'],
  'glucose':        ['glucose', 'blood sugar', 'fasting glucose'],
  // Lipids
  'ldl':            ['ldl', 'ldl cholesterol', 'ldl-c', 'low density lipoprotein'],
  'hdl':            ['hdl', 'hdl cholesterol', 'hdl-c', 'high density lipoprotein'],
  'triglycerides':  ['triglycerides', 'trig', 'tg'],
  'cholesterol':    ['total cholesterol', 'cholesterol total', 'cholesterol'],
  // Renal / metabolic
  'creatinine':     ['creatinine', 'serum creatinine', 'creat'],
  'bun':            ['bun', 'blood urea nitrogen', 'urea nitrogen'],
  'egfr':           ['egfr', 'estimated gfr', 'glomerular filtration rate'],
  'potassium':      ['potassium', 'k+', 'serum potassium'],
  'sodium':         ['sodium', 'na+', 'serum sodium'],
  // CBC
  'hemoglobin':     ['hemoglobin', 'hgb', 'hb'],
  'hematocrit':     ['hematocrit', 'hct'],
  'wbc':            ['wbc', 'white blood cell', 'leukocyte count'],
  'platelet':       ['platelet', 'plt', 'platelet count'],
  // Liver
  'alt':            ['alt', 'sgpt', 'alanine aminotransferase'],
  'ast':            ['ast', 'sgot', 'aspartate aminotransferase'],
  // Prostate
  'psa':            ['psa', 'prostate specific antigen'],
  // Vitamins
  'vitamin d':      ['vitamin d', '25-oh vitamin d', '25-hydroxy vitamin d', '25-oh-d'],
  'b12':            ['b12', 'vitamin b12', 'cyanocobalamin'],
  // Inflammation
  'crp':            ['crp', 'c-reactive protein', 'c reactive protein']
};

/**
 * Resolve a free-text user term to its canonical key + match list.
 * Returns `{ canonical, terms }` where `terms` is the array of
 * synonyms to try. If the user term isn't in the synonym table,
 * returns the user term as a single-element list so we still attempt
 * a literal substring match.
 */
export function resolveAnalyte(rawQuery) {
  const q = String(rawQuery || '').toLowerCase().trim();
  if (!q) return null;
  for (const [canonical, terms] of Object.entries(ANALYTE_SYNONYMS)) {
    if (terms.some(t => q === t || q.includes(t) || t.includes(q))) {
      return { canonical, terms };
    }
  }
  return { canonical: q, terms: [q] };
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

/** "Aug 11, 2025" → "2025-08-11" */
export function toIsoDate(raw) {
  if (!raw) return null;
  const m = String(raw).trim().match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (!m) return null;
  const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (!mon) return null;
  const day = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  if (!Number.isFinite(day) || !Number.isFinite(year)) return null;
  return `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Split `lab_results.md` into one entry per date. Each entry yields
 * `{ isoDate, dateRaw, page, body, outOfRange }`. `body` is the joined
 * analyte readings ("TSH 6.13 uIU/mL; Hemoglobin A1c 5.7 %; …") OR
 * the legacy "(N lines)" summary for sidecars built before v1.4.7.
 */
export function parseLabResultsMarkdown(md) {
  const text = String(md || '');
  const out = [];
  const blocks = text.split(/\n---\n/);
  for (const block of blocks) {
    const head = block.match(/\*\*Date:\*\*\s*([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})\s*\|\s*\*\*Page:\*\*\s*(\d+)/);
    if (!head) continue;
    const dateRaw = head[1];
    const isoDate = toIsoDate(dateRaw);
    const page = parseInt(head[2], 10);
    if (!isoDate || !Number.isFinite(page)) continue;
    // Everything after the **Date:** line is the body — collapse it
    // onto one logical line so the per-analyte filter below works
    // regardless of whether the sidecar's analytes were emitted on
    // one line (`Aug 11 TSH 6.13; HbA1c 5.7`) or several.
    const remainder = block.slice(head.index + head[0].length)
      .replace(/^\s*\n/, '')
      .replace(/\n/g, '; ')
      .trim();
    // Strip a leading repeat of the dateRaw (the formatter prefixes
    // the body with the date), and drop the legacy "(N lines)" tail.
    const body = remainder
      .replace(new RegExp(`^${dateRaw}\\s*[;:]?\\s*`, 'i'), '')
      .replace(/\(\s*\d+\s+line[s]?\s*\)/i, '')
      .trim();
    // Out-of-Range markers embedded by the formatter.
    const oorMatch = body.match(/\*\*Out of Range:\*\*\s*(.+?)$/i);
    const outOfRange = oorMatch ? oorMatch[1].trim() : '';
    const cleanBody = oorMatch ? body.slice(0, oorMatch.index).trim().replace(/[;|]\s*$/, '').trim() : body;
    out.push({ isoDate, dateRaw, page, body: cleanBody, outOfRange });
  }
  return out.sort((a, b) => (a.isoDate < b.isoDate ? 1 : a.isoDate > b.isoDate ? -1 : 0));
}

/**
 * Per-analyte time series. Walks every parsed entry; for each one,
 * scans the body for occurrences of any synonym in `analyte.terms`
 * and captures the analyte + value + units fragment. The matcher is
 * a small grammar:
 *
 *   <analyte text>  <number with optional decimal>  <units like uIU/mL>
 *
 * with optional `(H)` / `(L)` / `(N)` flags after the units. Returns
 * one row per analyte per date, sorted reverse-chronological.
 */
export function selectAnalyteHistory(entries, analyte) {
  if (!analyte || !Array.isArray(entries)) return [];
  const rows = [];
  // Build a single regex that finds any synonym + a value+units fragment.
  // Escape regex special chars in synonym strings.
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const synAlt = analyte.terms.map(esc).join('|');
  // `value` captures a numeric (with optional decimal); `units` captures
  // the next whitespace-delimited token that looks like units (anything
  // not just digits). `flag` captures (H)/(L)/(N) suffix optionally.
  const re = new RegExp(
    `\\b(${synAlt})\\b\\s*[:=]?\\s*([\\d]+(?:\\.\\d+)?)\\s*([A-Za-zµ%/³^]+(?:/[A-Za-zµ%]+)?)?\\s*(\\((?:H|L|N|HIGH|LOW)\\))?`,
    'gi'
  );
  for (const e of entries) {
    if (!e?.body) continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(e.body)) !== null) {
      const matchedTerm = m[1];
      const value = m[2];
      const units = m[3] || '';
      const flag = m[4] ? m[4].replace(/[()]/g, '').toUpperCase() : '';
      rows.push({
        isoDate: e.isoDate,
        dateRaw: e.dateRaw,
        page: e.page,
        analyteMatched: matchedTerm,
        value,
        units,
        flag
      });
    }
  }
  return rows;
}

/**
 * High-level convenience: feed it the raw `lab_results.md` text and
 * an analyte query ("TSH"), get back the full time series.
 */
export function buildLabHistory(labResultsMd, analyteQuery) {
  const analyte = resolveAnalyte(analyteQuery);
  if (!analyte) return { analyte: null, rows: [], total: 0 };
  const entries = parseLabResultsMarkdown(labResultsMd);
  const rows = selectAnalyteHistory(entries, analyte);
  return { analyte, rows, total: rows.length, entryCount: entries.length };
}
