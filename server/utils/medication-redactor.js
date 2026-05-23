/**
 * Server-side medication redaction.
 *
 * The Layer-1 system instruction (`## MAIA INSTRUCTION TEXT` in
 * `NEW-AGENT.txt`) tells the agent to "Remove any mention of problems or
 * medications for sexual function including syringes that may be
 * prescribed." That rule applies when *an agent* generates output, but the
 * deterministic `/api/medications/current` pipeline doesn't run the agent,
 * so we apply the same intent here as a server-side filter before the
 * pre-filled verify/edit list reaches the user.
 *
 * Patterns are deliberately conservative — we redact clear matches
 * (oral PDE5 inhibitors and the common intracavernosal/urethral
 * formulations) and leave anything ambiguous (e.g. "insulin syringe")
 * alone. Patterns are hardcoded here for v1.3.101; they can be moved to
 * an editable config later without changing callers.
 */

// Each entry: { id, category, pattern (RegExp), reason }.
// The pattern matches against the lowercased medication name.
const REDACTION_RULES = [
  // PDE5 inhibitors and other erectile-dysfunction drugs (oral and topical)
  { id: 'sildenafil',  category: 'sexual-function', pattern: /\bsildenafi?l\b|\bviagra\b|\brevatio\b/i },
  { id: 'tadalafil',   category: 'sexual-function', pattern: /\btadalafil\b|\bcialis\b|\badcirca\b/i },
  { id: 'vardenafil',  category: 'sexual-function', pattern: /\bvardenafil\b|\blevitra\b|\bstaxyn\b/i },
  { id: 'avanafil',    category: 'sexual-function', pattern: /\bavanafil\b|\bstendra\b|\bspedra\b/i },
  // Intracavernosal / intraurethral injection therapies
  { id: 'alprostadil', category: 'sexual-function', pattern: /\balprostadil\b|\bcaverject\b|\bedex\b|\bmuse\b/i },
  { id: 'papaverine',  category: 'sexual-function', pattern: /\bpapaverine\b/i },
  { id: 'phentolamine',category: 'sexual-function', pattern: /\bphentolamine\b/i },
  { id: 'trimix',      category: 'sexual-function', pattern: /\btrimix\b|\bbi[- ]?mix\b|\bquad[- ]?mix\b/i },
  // Yohimbine (legacy ED treatment, still sometimes listed)
  { id: 'yohimbine',   category: 'sexual-function', pattern: /\byohimbine\b/i }
];

/**
 * Return { redacted: false } or
 *        { redacted: true, ruleId, category } for a single medication name.
 */
export function redactionMatch(name) {
  const s = String(name || '');
  for (const r of REDACTION_RULES) {
    if (r.pattern.test(s)) return { redacted: true, ruleId: r.id, category: r.category };
  }
  return { redacted: false };
}

/**
 * Filter a normalized medication list, dropping entries that match a
 * redaction rule. Returns { kept, redacted } so callers can log how many
 * were filtered (useful for the maia-log / diagnostics).
 */
export function redactMedications(meds) {
  const kept = [];
  const redacted = [];
  for (const m of meds || []) {
    const r = redactionMatch(m?.name);
    if (r.redacted) redacted.push({ ...m, _redaction: r });
    else kept.push(m);
  }
  return { kept, redacted };
}
