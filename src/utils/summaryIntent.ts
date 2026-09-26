/**
 * Is a typed chat message an explicit Patient Summary request?
 *
 *   'show'   the whole message asks to see it ("show my patient summary",
 *            "what's in my summary?") → the stored summary, no inference.
 *   'write'  the whole message asks to write or update it ("update my
 *            patient summary") → the private AI drafts, and the review
 *            dialog is offered; nothing is saved without Verify.
 *   null     anything else, including a question that merely mentions the
 *            summary ("does this report change my patient summary?") → an
 *            ordinary answer from the AI.
 */
export type SummaryIntent = 'show' | 'write' | null;

const THE_SUMMARY = String.raw`(?:my |the )?(?:current |saved |latest )?(?:patient )?summary`;
const SHOW = new RegExp(String.raw`^(?:(?:show|display|open|give|get|view|read|print|see)(?: me)? ${THE_SUMMARY}|what(?:'s| is) in ${THE_SUMMARY}|what does ${THE_SUMMARY} say|${THE_SUMMARY})$`);
const WRITE = new RegExp(String.raw`^(?:write|create|generate|draft|make|update|redo|regenerate|rewrite|refresh|revise)(?: me)?(?: a| an)?(?: new| updated)? ${THE_SUMMARY}$`);

const normalize = (text: string) => String(text || '')
  .toLowerCase()
  .replace(/[’‘]/g, "'")
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/[.!?]+$/, '')
  .replace(/^(?:hi|hello|hey)[, ]+/, '')
  .replace(/^(?:please |can you |could you |would you |will you |i want to |i'd like to |let me )+/, '')
  .replace(/[, ]+please$/, '')
  .trim();

export function summaryIntent(text: string): SummaryIntent {
  const t = normalize(text);
  if (!/\bsummary\b/.test(t)) return null;
  if (SHOW.test(t)) return 'show';
  if (WRITE.test(t)) return 'write';
  return null;
}
