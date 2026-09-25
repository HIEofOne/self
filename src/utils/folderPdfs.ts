/**
 * The PDFs MAIA keeps in the patient's folder (Personal AS edition,
 * group_requests.md §7, phase P7b):
 *
 *   MAIA Patient Summary.pdf                     the verified summary
 *   MAIA Patient Summary - privacy filtered.pdf  exactly what can leave automatically
 *   MAIA Sharing Policies.pdf                    the confirmed rules + whether sharing is on
 *
 * Writing the summary PDFs is part of Verify; an edit clears the stamp and
 * the PDFs are rewritten only at the next Verify. The filtered PDF is the
 * stored privacy-filtered text verbatim — the same text a request releases —
 * and never carries the pseudonym mapping. Made client-side with jsPDF (the
 * same path as maia-log.pdf) and written through the File System Access
 * handle the patient granted; nothing here goes to the server.
 */
import { jsPDF } from 'jspdf';
import {
  MAIA_FOLDER_PDFS, getLocalFolderStatus, reconnectLocalFolder, writeFileToFolder
} from './localFolder';
import { sentenceFor, type AsState, type PolicyCard } from './policyCards';

export type FolderPdfResult = 'written' | 'no-folder' | 'no-permission' | 'not-verified' | 'failed';

// ── Text ────────────────────────────────────────────────────────────────

// jsPDF's built-in fonts cover Latin-1 only; a single character outside it
// switches the whole line to an encoding that prints as spaced garbage.
const PDF_TEXT_MAP: Array<[RegExp, string]> = [
  [/\r/g, ''],
  [/\t/g, '    '],
  [/[    ]/g, ' '],
  [/[‘’‚′]/g, "'"],
  [/[“”„″]/g, '"'],
  [/[‐-―−]/g, '-'],
  [/[•‣⁃●◦▪]/g, '-'],
  [/…/g, '...'],
  [/≥/g, '>='],
  [/≤/g, '<='],
  [/≠/g, '!='],
  [/[→⇒]/g, '->'],
  [/™/g, '(TM)']
];

export const toPdfText = (s: string | null | undefined): string => {
  let t = String(s ?? '').normalize('NFC');
  for (const [re, rep] of PDF_TEXT_MAP) t = t.replace(re, rep);
  return t.replace(/[^\n\x20-\x7E -ÿ]/g, '?');
};

const stripInline = (s: string): string =>
  s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/`([^`]*)`/g, '$1')
    .replace(/(^|[^*\w])\*(\S[^*]*?)\*(?!\w)/g, '$1$2');

export interface PdfLine { kind: 'heading' | 'bullet' | 'text' | 'blank'; text: string; indent?: number }

/** The summary's light markdown as lines to lay out. */
export const summaryLines = (text: string): PdfLine[] => {
  const out: PdfLine[] = [];
  for (const raw of toPdfText(text).split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      if (out.length && out[out.length - 1].kind !== 'blank') out.push({ kind: 'blank', text: '' });
      continue;
    }
    const h = line.match(/^\s*#{1,6}\s+(.*)$/) || line.match(/^\s*\*\*([^*]+?)\*\*:?\s*$/);
    if (h) { out.push({ kind: 'heading', text: stripInline(h[1]).replace(/:$/, '') }); continue; }
    const b = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (b) { out.push({ kind: 'bullet', text: stripInline(b[2]), indent: b[1].length >= 2 ? 1 : 0 }); continue; }
    out.push({ kind: 'text', text: stripInline(line.trim()) });
  }
  while (out.length && out[out.length - 1].kind === 'blank') out.pop();
  return out;
};

const dateLabel = (iso?: string | null): string => {
  const d = iso ? new Date(iso) : new Date();
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
};

// ── Layout ──────────────────────────────────────────────────────────────

interface PdfSpec {
  title: string;
  subtitle?: string;
  notes?: string[];
  lines: PdfLine[];
  generatedAt: string;
}

const MARGIN = 18;

const layout = (spec: PdfSpec): jsPDF => {
  const doc = new jsPDF({ unit: 'mm', format: 'letter' });
  doc.setProperties({ title: spec.title, creator: 'MAIA', subject: 'MAIA folder copy' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const maxW = pageW - MARGIN * 2;
  const bottom = pageH - 20;
  let y = 22;
  const room = (h: number) => { if (y + h > bottom) { doc.addPage(); y = 22; } };
  const para = (text: string, x: number, width: number, size: number, step: number) => {
    doc.setFontSize(size);
    for (const part of doc.splitTextToSize(text, width) as string[]) {
      room(step);
      doc.text(part, x, y);
      y += step;
    }
  };

  doc.setFont('helvetica', 'bold');
  para(toPdfText(spec.title), MARGIN, maxW, 16, 8);
  doc.setFont('helvetica', 'normal');
  if (spec.subtitle) {
    doc.setTextColor(90, 90, 90);
    para(toPdfText(spec.subtitle), MARGIN, maxW, 10, 5);
  }
  for (const note of spec.notes || []) {
    doc.setTextColor(90, 90, 90);
    y += 1;
    para(toPdfText(note), MARGIN, maxW, 9, 4.5);
  }
  doc.setTextColor(0, 0, 0);
  y += 3;
  doc.setDrawColor(200, 200, 200);
  doc.line(MARGIN, y, pageW - MARGIN, y);
  y += 7;

  for (const l of spec.lines) {
    if (l.kind === 'blank') { y += 2.5; continue; }
    if (l.kind === 'heading') {
      y += 2;
      room(12);
      doc.setFont('helvetica', 'bold');
      para(l.text, MARGIN, maxW, 11.5, 6);
      doc.setFont('helvetica', 'normal');
      continue;
    }
    if (l.kind === 'bullet') {
      const x = MARGIN + 2 + (l.indent || 0) * 5;
      room(5);
      doc.setFontSize(10);
      doc.text('-', x, y);
      para(l.text, x + 4, maxW - (x + 4 - MARGIN), 10, 5);
      continue;
    }
    para(l.text, MARGIN, maxW, 10, 5);
  }

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(130, 130, 130);
    doc.text(`Made by MAIA on ${dateLabel(spec.generatedAt)}`, MARGIN, pageH - 10);
    doc.text(`Page ${i} of ${pages}`, pageW - MARGIN, pageH - 10, { align: 'right' });
  }
  doc.setTextColor(0, 0, 0);
  return doc;
};

// ── The three documents ─────────────────────────────────────────────────

export const patientSummaryPdf = (text: string, o: { verifiedAt: string; generatedAt?: string }): jsPDF =>
  layout({
    title: 'Patient Summary',
    subtitle: `Verified by you on ${dateLabel(o.verifiedAt)}.`,
    notes: ['Your own copy. MAIA replaces it each time you verify your summary.'],
    lines: summaryLines(text),
    generatedAt: o.generatedAt || new Date().toISOString()
  });

export const filteredSummaryPdf = (text: string, o: { verifiedAt: string; generatedAt?: string }): jsPDF =>
  layout({
    title: 'Patient Summary - privacy filtered',
    subtitle: `From the summary you verified on ${dateLabel(o.verifiedAt)}.`,
    notes: [
      'This is exactly what your sharing rules can send without asking you. Names are replaced with made-up ones.'
    ],
    lines: summaryLines(text),
    generatedAt: o.generatedAt || new Date().toISOString()
  });

const OUTCOME_ORDER: Array<{ outcome: PolicyCard['outcome']; heading: string }> = [
  { outcome: 'deny', heading: 'Declined' },
  { outcome: 'ask', heading: 'Needs my approval' },
  { outcome: 'allow', heading: 'Shared automatically' }
];

const SHARING_STATE: Record<AsState, string> = {
  active: 'Sharing is on. These rules answer requests automatically.',
  paused: 'Sharing is paused. Every request comes to you as a question; these rules are not acting.',
  setup: 'Sharing is off. Every request comes to you as a question until you turn sharing on.'
};

/** Confirmed, enabled rules — the only ones that ever act (I-24) — in the
 *  order they are applied. */
export const sharingPoliciesPdf = (cards: PolicyCard[], o: { asState: AsState; generatedAt?: string }): jsPDF => {
  const acting = cards.filter((c) => c.enabled !== false && !!c.confirmedAt);
  const waiting = cards.filter((c) => c.enabled !== false && !c.confirmedAt).length;
  const off = cards.filter((c) => c.enabled === false).length;
  const lines: PdfLine[] = [];
  for (const { outcome, heading } of OUTCOME_ORDER) {
    const group = acting.filter((c) => c.outcome === outcome);
    if (!group.length) continue;
    lines.push({ kind: 'heading', text: heading });
    for (const c of group) {
      lines.push({ kind: 'bullet', text: toPdfText(`${sentenceFor(c)} (Confirmed ${dateLabel(c.confirmedAt)}.)`) });
    }
    lines.push({ kind: 'blank', text: '' });
  }
  if (!acting.length) lines.push({ kind: 'text', text: 'You have not confirmed any rules yet.' }, { kind: 'blank', text: '' });
  const notListed: string[] = [];
  if (waiting) notListed.push(`${waiting} ${waiting === 1 ? 'rule is' : 'rules are'} waiting for your confirmation`);
  if (off) notListed.push(`${off} ${off === 1 ? 'rule is' : 'rules are'} turned off`);
  if (notListed.length) {
    const one = waiting + off === 1;
    const until = [waiting ? `confirm ${one ? 'it' : 'them'}` : '', off ? `turn ${one ? 'it' : 'them'} on` : ''].filter(Boolean).join(' or ');
    lines.push({ kind: 'text', text: `Not listed: ${notListed.join(' and ')}. ${one ? "It doesn't" : "They don't"} act until you ${until}.` });
  }
  lines.push({ kind: 'text', text: "Anything these rules don't cover comes to you as a question." });
  const generatedAt = o.generatedAt || new Date().toISOString();
  return layout({
    title: 'Sharing Policies',
    subtitle: `${SHARING_STATE[o.asState] || SHARING_STATE.setup} As of ${dateLabel(generatedAt)}.`,
    lines,
    generatedAt
  });
};

// ── Writing to the folder ───────────────────────────────────────────────

const folderFor = async (userId: string): Promise<{ handle: FileSystemDirectoryHandle | null; missing: FolderPdfResult }> => {
  const r = await reconnectLocalFolder(userId);
  if (r) return { handle: r.handle, missing: 'written' };
  const status = await getLocalFolderStatus(userId);
  return { handle: null, missing: status.configured ? 'no-permission' : 'no-folder' };
};

const toBlob = (doc: jsPDF): Blob => doc.output('blob');

/** After Verify: the verified summary and its privacy-filtered copy. Reads
 *  both from the server, so it writes only what is actually verified. */
export const writeSummaryPdfs = async (
  userId: string,
  opts: { handle?: FileSystemDirectoryHandle | null } = {}
): Promise<FolderPdfResult> => {
  try {
    let handle = opts.handle ?? null;
    if (!handle) {
      const f = await folderFor(userId);
      if (!f.handle) return f.missing;
      handle = f.handle;
    }
    const r = await fetch(`/api/patient-summary?userId=${encodeURIComponent(userId)}`, { credentials: 'include' });
    const j = await r.json().catch(() => ({}));
    const text = String(j?.summary || '').trim();
    if (!r.ok || !text || !j?.verifiedAt) return 'not-verified';
    await writeFileToFolder(handle, MAIA_FOLDER_PDFS.summary, toBlob(patientSummaryPdf(text, { verifiedAt: j.verifiedAt })));
    const filtered = String(j?.privacyFiltered?.text || '').trim();
    if (filtered) {
      await writeFileToFolder(handle, MAIA_FOLDER_PDFS.filtered, toBlob(filteredSummaryPdf(filtered, { verifiedAt: j.verifiedAt })));
    }
    return 'written';
  } catch (e) {
    console.warn('[folderPdfs] summary PDFs not written:', e);
    return 'failed';
  }
};

/** After any change to the rules or the sharing switch. */
export const writeSharingPoliciesPdf = async (
  userId: string,
  data: { cards: PolicyCard[]; asState: AsState },
  opts: { handle?: FileSystemDirectoryHandle | null } = {}
): Promise<FolderPdfResult> => {
  try {
    let handle = opts.handle ?? null;
    if (!handle) {
      const f = await folderFor(userId);
      if (!f.handle) return f.missing;
      handle = f.handle;
    }
    await writeFileToFolder(handle, MAIA_FOLDER_PDFS.policies, toBlob(sharingPoliciesPdf(data.cards, { asState: data.asState })));
    return 'written';
  } catch (e) {
    console.warn('[folderPdfs] Sharing Policies PDF not written:', e);
    return 'failed';
  }
};
