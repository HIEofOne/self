/**
 * Encounters extractor
 *
 * Builds a reverse-chronological list of clinical encounters from a
 * patient's source PDFs. Optimized for Epic / Mass General Brigham
 * exports (whose encounter headers are highly regular) and degrades
 * gracefully to a generic dated-section heuristic for other formats.
 *
 * Works on the plain text from `pdf-parse` (which preserves clean line
 * breaks). Page numbers are recovered from the repeating "… Page N"
 * footers (Epic prints these on every page); the printed page number
 * matches the PDF page index, so the in-app viewer opens to the right
 * place. When a file has no such footers, pages are approximated
 * proportionally so links still land in the right neighborhood.
 */

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

/** Normalize an M/D/YYYY (or "Mon D, YYYY") string to ISO YYYY-MM-DD, else ''. */
export function toIsoDate(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let [, mo, d, y] = m;
    if (y.length === 2) y = (Number(y) > 50 ? '19' : '20') + y;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  m = s.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  }
  return '';
}

/**
 * Classify an encounter descriptor into Outpatient | Telemedicine |
 * Inpatient (the three buckets the worksheet uses). ED / emergency and
 * admissions map to Inpatient (facility-administered context); video /
 * phone / e-consult map to Telemedicine; everything else (office/OP
 * visit, procedure, imaging, lab) is Outpatient.
 */
export function classifyEncounterType(descriptor) {
  const d = String(descriptor || '').toLowerCase();
  if (/(telemedicine|telehealth|video visit|video encounter|telephone|phone visit|audio only|e-consult|econsult)/.test(d)) {
    return 'Telemedicine';
  }
  if (/(admission|admitted|inpatient|hospital encounter|discharge|discharged|\bed\b|emergency)/.test(d)) {
    return 'Inpatient';
  }
  return 'Outpatient';
}

/**
 * Map every line index to a printed page number using the repeating
 * "… Page N" footer (footer marks the END of page N, so lines after it
 * belong to N+1). If too few footers are found relative to numPages,
 * fall back to proportional distribution across numPages.
 */
export function buildLinePageMap(lines, numPages) {
  const footerRe = /\bPage\s+(\d+)\s*$/i;
  const linePage = new Array(lines.length).fill(1);
  let cur = 1;
  let footerHits = 0;
  for (let i = 0; i < lines.length; i++) {
    linePage[i] = cur;
    const m = lines[i].match(footerRe);
    if (m) {
      footerHits++;
      const n = parseInt(m[1], 10);
      cur = (Number.isFinite(n) ? n : cur) + 1;
    }
  }
  // If footers were unreliable, approximate proportionally.
  if (numPages > 1 && footerHits < Math.ceil(numPages * 0.5)) {
    for (let i = 0; i < lines.length; i++) {
      linePage[i] = Math.min(numPages, Math.floor((i / lines.length) * numPages) + 1);
    }
  }
  return linePage;
}

// Epic encounter header, e.g. "08/27/2025 - Telemedicine in Department of Urology"
const EPIC_HEADER = /^(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(.+?)\s*$/;

/**
 * Detect Epic-style encounters from text lines. Each distinct encounter
 * (date + descriptor) is emitted once, anchored to the page of its FIRST
 * occurrence (the "(continued)" repeats on later pages collapse to it).
 */
export function extractEpicEncounters(lines, linePage, fileTag) {
  const byKey = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const m = line.match(EPIC_HEADER);
    if (!m) continue;
    const dateRaw = m[1];
    const descriptor = m[2].replace(/\s*\(continued\)\s*$/i, '').trim();
    if (!descriptor || descriptor.length > 160) continue;
    const isoDate = toIsoDate(dateRaw);
    if (!isoDate) continue;
    const key = `${isoDate}|${descriptor.toLowerCase()}`;
    const type = classifyEncounterType(descriptor);
    // Keep the full descriptor ("<kind> in <location>") so same-day visits
    // of different kinds (e.g. Office Visit vs Procedure visit) stay distinct
    // and the row is informative beyond the 3-way Type bucket.
    const description = descriptor;
    const page = linePage[i] || 1;
    const existing = byKey.get(key);
    if (!existing || page < existing.page) {
      byKey.set(key, { isoDate, dateRaw, type, description, encounter: descriptor, page, fileTag });
    }
  }
  return [...byKey.values()];
}

/**
 * Generic fallback for non-Epic PDFs: lines that begin with a date and
 * carry encounter-ish context. Lower precision; only used when no Epic
 * headers are found in a file.
 */
export function extractGenericEncounters(lines, linePage, fileTag) {
  const byKey = new Map();
  const dateLead = /^((?:\d{1,2}\/\d{1,2}\/\d{2,4})|(?:[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}))\b\s*(.*)$/;
  const contextRe = /(visit|encounter|admission|consult|telemedicine|telehealth|office|clinic|hospital|procedure|appointment|department|emergency)/i;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length < 6 || line.length > 160) continue;
    const m = line.match(dateLead);
    if (!m) continue;
    const isoDate = toIsoDate(m[1]);
    if (!isoDate) continue;
    const rest = (m[2] || '').trim();
    if (!contextRe.test(rest)) continue;
    const description = rest.replace(/^[-–:\s]+/, '').slice(0, 120) || 'Encounter';
    const key = `${isoDate}|${description.toLowerCase()}`;
    if (!byKey.has(key)) {
      byKey.set(key, { isoDate, dateRaw: m[1], type: classifyEncounterType(rest), description, encounter: rest, page: linePage[i] || 1, fileTag });
    }
  }
  return [...byKey.values()];
}

/**
 * Extract encounters from one file's pdf-parse text. Epic-first, generic
 * fallback. Returns { encounters, mode } (mode: 'epic'|'generic'|'none').
 */
export function extractEncountersFromText(text, numPages, fileTag) {
  const lines = String(text || '').split('\n');
  const linePage = buildLinePageMap(lines, numPages || 1);
  const epic = extractEpicEncounters(lines, linePage, fileTag);
  if (epic.length > 0) return { encounters: epic, mode: 'epic' };
  const generic = extractGenericEncounters(lines, linePage, fileTag);
  return { encounters: generic, mode: generic.length ? 'generic' : 'none' };
}

/**
 * Strip repeating page headers/footers from raw text (for cleaner KB
 * indexing / snippets). Frequency-based plus obvious footer patterns.
 * Returns the cleaned text. Not used for encounter boundary detection.
 */
export function stripHeadersFooters(text, numPages) {
  const lines = String(text || '').split('\n');
  const freq = new Map();
  for (const raw of lines) {
    const t = raw.trim();
    if (!t || t.length > 80) continue;
    const norm = t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');
    freq.set(norm, (freq.get(norm) || 0) + 1);
  }
  const threshold = Math.max(3, Math.ceil((numPages || 1) * 0.3));
  const patterns = [
    /generated on\b/i, /\bpage\s+\d+\s*$/i, /^mrn[:\s]/i,
    /\bdob[:\s]/i, /^acct\s*#/i, /legal sex[:\s]/i
  ];
  const out = [];
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) { out.push(''); continue; }
    const norm = t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');
    const frequent = t.length <= 80 && (freq.get(norm) || 0) >= threshold;
    const matched = patterns.some(re => re.test(t));
    if (frequent || matched) continue;
    out.push(raw);
  }
  return out.join('\n');
}

/**
 * Parse the Apple Health "Clinical Notes" category markdown into the same
 * normalized encounter shape used elsewhere. AH Clinical Notes ARE the
 * encounters for Apple Health exports (in-person visit notes, telephone /
 * video encounters, patient messages). The category markdown format
 * mirrors `medication_records.md`:
 *
 *   **Date:** May 7, 2026 | **Page:** 1
 *   May 7, 2026 **Telephone Encounter** by **Wei Lien, MD**
 *   ---
 *
 * The note-type word ("Telephone Encounter", "Progress Notes", "Video
 * Encounter", "Patient Instructions", …) drives the type classification.
 */
export function parseAppleHealthClinicalNotes(text, fileTag) {
  const out = [];
  const blocks = String(text || '').split(/\n---\n/);
  for (const block of blocks) {
    const head = block.match(/\*\*Date:\*\*\s*([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})\s*\|\s*\*\*Page:\*\*\s*(\d+)/);
    if (!head) continue;
    const isoDate = toIsoDate(head[1]);
    const page = parseInt(head[2], 10);
    if (!isoDate || !Number.isFinite(page)) continue;
    // Bolded tokens after the header: [<note type>, <author>?]
    const remainder = block.slice(head.index + head[0].length);
    const bolded = [...remainder.matchAll(/\*\*([^*]+?)\*\*/g)]
      .map(m => m[1].trim())
      .filter(s => s && !/^(date|page)\s*:/i.test(s));
    if (bolded.length < 1) continue;
    const noteType = bolded[0];
    const author = bolded[1] || '';
    const description = author ? `${noteType} by ${author}` : noteType;
    const type = classifyEncounterType(noteType);
    out.push({ isoDate, dateRaw: head[1], type, description, encounter: description, page, fileTag, source: 'apple-health' });
  }
  return out;
}

/**
 * Merge encounters across files. Dedupe by ISO **date only** — multiple
 * sources reporting an encounter on the same date are merged into ONE row
 * whose Source cell lists every contributing `File N p.<page>` so the user
 * can click through to any source. Sorted reverse-chronological. Rendered
 * with the same column convention so the existing client renderer works.
 */
export function buildEncountersTable(allEncounters) {
  // Group by ISO date so a visit reported in multiple source files becomes
  // a single row. Within a group we PREFER non-Apple-Health contributors
  // for the displayed descriptor and source link order — Apple Health
  // entries are summary-only ("Telephone Encounter by Dr X"), while the
  // original source PDF (e.g. an Epic export) carries the actual note
  // content. AH contributors are still included in the Source cell so
  // the user can navigate to them, but they appear after the non-AH
  // sources.
  const isAh = (e) => e?.source === 'apple-health';
  const byDate = new Map();
  for (const e of allEncounters) {
    if (!e?.isoDate) continue;
    const existing = byDate.get(e.isoDate);
    if (!existing) {
      byDate.set(e.isoDate, {
        isoDate: e.isoDate,
        type: e.type,
        descriptions: [{ text: e.description || '', isAh: isAh(e) }],
        sources: [{ fileTag: e.fileTag, page: e.page, isAh: isAh(e) }]
      });
    } else {
      existing.descriptions.push({ text: e.description || '', isAh: isAh(e) });
      // Type promotion: a more specific type from any contributor wins.
      if (existing.type === 'Outpatient' && e.type && e.type !== 'Outpatient') {
        existing.type = e.type;
      }
      const key = `${e.fileTag}|${e.page}`;
      if (!existing.sources.some(s => `${s.fileTag}|${s.page}` === key)) {
        existing.sources.push({ fileTag: e.fileTag, page: e.page, isAh: isAh(e) });
      }
    }
  }

  // Pick the best descriptor: longest non-AH; if no non-AH contributor,
  // longest AH. Order sources non-AH first.
  const pickDescription = (descs) => {
    const nonAh = descs.filter(d => !d.isAh && d.text);
    const pool = nonAh.length > 0 ? nonAh : descs.filter(d => d.text);
    if (pool.length === 0) return '';
    return pool.reduce((best, d) => d.text.length > best.length ? d.text : best, '');
  };
  const orderSources = (sources) => {
    const nonAh = sources.filter(s => !s.isAh);
    const ah    = sources.filter(s =>  s.isAh);
    return [...nonAh, ...ah];
  };

  const rows = [...byDate.values()]
    .map(g => ({
      isoDate: g.isoDate,
      type: g.type,
      description: pickDescription(g.descriptions),
      sources: orderSources(g.sources)
    }))
    .sort((a, b) => (a.isoDate < b.isoDate ? 1 : a.isoDate > b.isoDate ? -1 : 0));

  const esc = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
  const header = '| Date | Type | Encounter | Source |\n| --- | --- | --- | --- |';
  const fmtSources = (sources) => sources.map(s => `${s.fileTag} p.${s.page}`).join(', ');
  const body = rows.map(e => `| ${e.isoDate} | ${e.type} | ${esc(e.description)} | ${fmtSources(e.sources)} |`).join('\n');
  return { table: rows.length ? `${header}\n${body}` : header, count: rows.length };
}
