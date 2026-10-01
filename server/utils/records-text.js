/**
 * The patient's record PDFs as text for the private AI, page by page, so
 * the Patient Summary is drafted from the records themselves — the way a
 * file attached in chat is read — instead of from a few pre-extracted
 * fragments or from search hits. Pages are marked "=== File N, page P ==="
 * in the same File N order the citation links use (recordFilesForLegend),
 * and compacted: repeated rows (an Apple Health export prints many lab rows
 * two or three times), page furniture and the export's footer are dropped.
 *
 * A record set larger than the budget is reported incomplete, and the
 * caller drafts the old way: a summary from half the records would say
 * "not documented" about what sits in the other half.
 */

const FURNITURE = [
  /^continued (on|from) page \d+/i,
  /^page \d+ of \d+$/i,
  /^this summary displays certain health information/i,
  /^accurately reflect your medical history/i,
  /^professional medical judgment/i,
  /^health$/i
];

/** One page of pdf.js markdown, compacted. */
export function compactPageText(markdown) {
  const out = [];
  let prev = '';
  for (const raw of String(markdown || '').split('\n')) {
    const line = raw.replace(/^#+\s*/, '').replace(/[ \t]{2,}/g, '  ').trim();
    if (!line || line === prev || FURNITURE.some((re) => re.test(line))) continue;
    out.push(line);
    prev = line;
  }
  return out.join('\n');
}

/**
 * Characters of record text to send, for the model the private AI runs on:
 * about 100,000 tokens, or 75,000 for a 128k-context model (GPT-oss), leaving
 * room for instructions and the answer (a 136-page Apple Health export is
 * about 140,000 characters). MAIA_SUMMARY_RECORDS_MAX_CHARS overrides.
 */
export function recordsBudgetChars(modelName, env = process.env) {
  const forced = Number(env.MAIA_SUMMARY_RECORDS_MAX_CHARS);
  if (Number.isFinite(forced) && forced > 0) return forced;
  return /gpt-oss/i.test(String(modelName || '')) ? 300000 : 400000;
}

/**
 * @param {Array<{fileName: string, bucketKey: string}>} files  record PDFs, in File N order
 * @param {object} deps
 * @param {(key: string) => Promise<Buffer|null>} deps.readBuffer
 * @param {(buf: Buffer) => Promise<Array<{page: number, markdown: string}>>} deps.extractPages
 * @param {number} deps.maxChars
 * @returns {Promise<{ text: string, chars: number, files: number, pages: number, complete: boolean, unreadable: string[] }>}
 */
export async function buildRecordsText(files, { readBuffer, extractPages, maxChars }) {
  const parts = [];
  let chars = 0;
  let pages = 0;
  let read = 0;
  const unreadable = [];
  for (let i = 0; i < (files || []).length; i++) {
    const f = files[i];
    let filePages = [];
    try {
      const buf = f?.bucketKey ? await readBuffer(f.bucketKey) : null;
      filePages = buf ? await extractPages(buf) : [];
    } catch {
      filePages = [];
    }
    const texts = filePages
      .map((p) => ({ page: p.page, text: compactPageText(p.markdown) }))
      .filter((p) => p.text);
    if (!texts.length) { unreadable.push(f?.fileName || `File ${i + 1}`); continue; }
    read++;
    for (const p of texts) {
      const block = `=== File ${i + 1}, page ${p.page} ===\n${p.text}`;
      chars += block.length + 2;
      if (chars > maxChars) return { text: '', chars, files: read, pages, complete: false, unreadable };
      parts.push(block);
      pages++;
    }
  }
  return { text: parts.join('\n\n'), chars, files: read, pages, complete: true, unreadable };
}
