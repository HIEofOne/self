/**
 * What the request pages share: the form's choices (a subset of the policy
 * vocabulary, §10.3) and how an answer is shown.
 */
export const WHAT = [
  { value: 'patient-summary', label: 'Their Patient Summary' },
  { value: 'meds-allergies', label: 'Their current medications and allergies' },
  { value: 'notification-only', label: "Just let them know I'd like to be in touch" }
];
export const WHY = [
  { value: 'clinical', label: 'Clinical care' },
  { value: 'peer-support', label: 'Peer support' },
  { value: 'research', label: 'Research' },
  { value: 'public-health', label: 'Public health' }
];
export const whatLabel = (v: string) => ({
  'patient-summary': 'their Patient Summary', 'meds-allergies': 'their current medications and allergies',
  'notification-only': 'a note that you would like to be in touch'
} as Record<string, string>)[v] || v;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** The summary is Markdown-ish text. Escape everything first, then allow
 *  bold and headings only: nothing from an answer is ever markup. */
export const answerToHtml = (text: string) => escapeHtml(text || '')
  .replace(/^#{1,4}\s+(.+)$/gm, '<strong>$1</strong>')
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

/** Adding a document (§10.12, D15): what it is, and the files accepted. */
export const DOCUMENT_KINDS = [
  { value: 'radiology-report', label: 'Radiology report' },
  { value: 'lab-report', label: 'Lab report' },
  { value: 'visit-note', label: 'Visit note' },
  { value: 'discharge-summary', label: 'Discharge summary' },
  { value: 'imaging', label: 'Image' },
  { value: 'other', label: 'Other document' }
];
export const DOCUMENT_TYPES: Record<string, string> = {
  'application/pdf': 'PDF', 'image/jpeg': 'JPEG image', 'image/png': 'PNG image', 'text/plain': 'text file'
};
export const DOCUMENT_ACCEPT = '.pdf,.jpg,.jpeg,.png,.txt,application/pdf,image/jpeg,image/png,text/plain';
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
