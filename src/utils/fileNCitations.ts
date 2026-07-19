// Shared File-N citation processor for any place that renders LLM
// output containing source citations. Patient Summary (chat + MyStuff
// tab), chat responses, dual-summary candidates, saved-summary
// viewer, and the replace-summary modal all need the same behavior:
//
//   1. Rewrite raw-filename citations `[<filename> p.<N>]` (and CJK
//      `【…】`) into `[File N p.<N>]` legend-tag form. Tries both the
//      display filename AND the sanitized bucket-key form, because
//      the KB stores PDFs under the sanitized name (per
//      /api/files/upload's `replace(/[^a-zA-Z0-9.-]/g, '_')`) and
//      that is what the LLM cites — yet availableUserFiles carries
//      the original display name.
//
//   2. Wrap bracketed `[File N p.<N>]` mentions into clickable
//      anchors using the canonical PDF-only / References-excluded
//      ordering of the user's file list.
//
//   3. Wrap bare-form `File N p.<N>` mentions (no brackets) — LLMs
//      often weave citations into prose without bracketing them.
//
//   4. Append a visible **File legend** footer to the rendered
//      output listing only the File N's actually referenced, so the
//      reader can identify what each tag maps to without hovering.
//
// All four passes share a single anchor builder so the legend
// accumulates references from every pass.

export interface FileNFile {
  fileName: string;
  bucketKey: string;
  fileType?: string;
}

const SANITIZE_RE = /[^a-zA-Z0-9.-]/g;
const sanitizeForKb = (s: string) => String(s || '').replace(SANITIZE_RE, '_');
const escRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Run all four passes on the given markdown content. Returns the
 * (modified) markdown content — caller is responsible for rendering
 * it to HTML via their preferred markdown engine (with `html: true`
 * so the anchors survive). Caller is also responsible for wiring
 * a click handler on `.page-link` anchors (see handlePsCitationClick
 * in MyStuffDialog or handlePageLinkClick in ChatInterface).
 */
export function processFileNCitations(
  content: string,
  availableFiles: FileNFile[],
  nameFilter?: (text: string) => string
): string {
  if (!content || typeof content !== 'string') return content || '';
  // Any registered PDF with a bucketKey is viewable — indexed or not.
  const pdfs = (availableFiles || []).filter(f => /\.pdf$/i.test(f.fileName || '') && (f as any).bucketKey);
  if (pdfs.length === 0) return content;

  const referenced = new Set<number>();
  let out = content;

  // Pass 0: raw-filename → File N rewrite.
  const candidates: Array<{ idx: number; name: string }> = [];
  const seen = new Set<string>();
  pdfs.forEach((f, i) => {
    const display = f.fileName || '';
    if (display && !seen.has(display)) { seen.add(display); candidates.push({ idx: i, name: display }); }
    const clean = sanitizeForKb(display);
    if (clean && clean !== display && !seen.has(clean)) { seen.add(clean); candidates.push({ idx: i, name: clean }); }
  });
  candidates.sort((a, b) => b.name.length - a.name.length);
  // Optional label the LLM sometimes prefixes inside the bracket, e.g.
  // `[Source: <filename> p.12]` / `[See <filename>, page 3]`. We strip it.
  const LABEL = `(?:(?:source|src|see|ref|reference|from|citation|cite)\\s*:?\\s*)?`;
  for (const { idx, name } of candidates) {
    const re = new RegExp(
      `[\\[\\u3010]\\s*${LABEL}${escRegex(name)}\\s*[,;]?\\s+(?:Page|page|pg|p\\.?)\\s*(\\d+)\\s*[\\]\\u3011]`,
      'gi'
    );
    out = out.replace(re, (_full, page) => `[File ${idx + 1} p.${page}]`);
  }

  // Shared anchor builder for passes 1 & 2.
  const buildAnchor = (n: string, p: string): string | null => {
    const idx = parseInt(n, 10) - 1;
    const target = pdfs[idx];
    if (!target) return null;
    referenced.add(idx);
    const pageNum = parseInt(p, 10);
    const label = `File ${n} p.${p}`;
    const escapedLabel = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeFileName = (target.fileName || '').replace(/"/g, '&quot;');
    const safeBucketKey = (target.bucketKey || '').replace(/"/g, '&quot;');
    return `<a href="#" class="page-link" data-filename="${safeFileName}" data-page="${pageNum}" data-bucket-key="${safeBucketKey}" title="${safeFileName}">${escapedLabel}</a>`;
  };

  // Pass 1: bracketed `[File N p.<N>]` → anchor.
  out = out.replace(/\[\s*File\s+(\d+)\s+p\.?\s*(\d+)\s*\]/gi, (full, n, p) => buildAnchor(n, p) ?? full);

  // Pass 2: bare-form `File N p.<N>` → anchor. Conservative guards.
  out = out.replace(/(^|[^>"'\w])File\s+(\d+)\s+p\.?\s*(\d+)\b/gi, (full, pre, n, p) => {
    const a = buildAnchor(n, p);
    return a ? `${pre}${a}` : full;
  });

  // Append legend footer if any File N tags were resolved.
  if (referenced.size > 0) {
    const sorted = [...referenced].sort((a, b) => a - b);
    const lines = sorted.map(idx => {
      const f = pdfs[idx];
      const displayName = f?.fileName || '(unknown)';
      return `- **File ${idx + 1}**: ${nameFilter ? nameFilter(displayName) : displayName}`;
    }).join('\n');
    out = `${out}\n\n---\n**File legend**\n${lines}`;
  }

  return out;
}
