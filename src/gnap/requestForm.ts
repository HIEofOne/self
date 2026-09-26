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
