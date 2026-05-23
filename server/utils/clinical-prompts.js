/**
 * Clinical-prompt registry / loader.
 *
 * Single source of truth for the per-request prompts MAIA sends to a
 * Private AI as part of a clinical process (worksheets, current-medications
 * extraction, patient summary, …). Editable in `clinical-prompts.md` at the
 * repo root; loaded once at startup (and on-demand if the file mtime
 * changes) so admins can tweak prompts without a redeploy.
 *
 * File format (Layer 2 of the docs/config split):
 *
 *   ### prompt: <id>
 *   <!-- placeholders: {name1} {name2} -->
 *   ```text
 *   <prompt body — may include {placeholders}>
 *   ```
 *
 * Code calls `getClinicalPrompt(id, vars)`; the loader returns the body
 * with `{name}` placeholders replaced by `vars[name]`. Missing prompts
 * return `null` (callers should fall back to a built-in default so a
 * broken file never breaks Setup).
 *
 * The generic guardrail "system instruction" stays in NEW-AGENT.txt; this
 * file is for the specific clinical *deliverables*.
 */

import { readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE_PATH = join(__dirname, '..', '..', 'clinical-prompts.md');

let cache = null; // { prompts: Map<id,body>, placeholders: Map<id,string[]>, mtimeMs }

function loadIfStale() {
  let mtimeMs;
  try {
    mtimeMs = statSync(FILE_PATH).mtimeMs;
  } catch {
    cache = { prompts: new Map(), placeholders: new Map(), mtimeMs: 0, missing: true };
    return cache;
  }
  if (cache && cache.mtimeMs === mtimeMs) return cache;

  const text = readFileSync(FILE_PATH, 'utf-8');
  const prompts = new Map();
  const placeholders = new Map();
  // Match: `### prompt: <id>` then optional `<!-- placeholders: ... -->`
  // then a ```text fenced block.
  const re = /^###\s+prompt:\s+([A-Za-z0-9._-]+)\s*\n(?:<!--\s*placeholders:\s*([^>]*?)\s*-->\s*\n)?```text\s*\n([\s\S]*?)\n```\s*$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const id = m[1];
    const placeholderList = (m[2] || '').match(/\{[A-Za-z0-9_]+\}/g) || [];
    const body = m[3];
    prompts.set(id, body);
    placeholders.set(id, placeholderList.map(p => p.slice(1, -1)));
  }
  cache = { prompts, placeholders, mtimeMs, missing: false };
  console.log(`[clinical-prompts] loaded ${prompts.size} prompt(s) from ${FILE_PATH}`);
  return cache;
}

/**
 * Get a clinical prompt by id with `{name}` placeholder substitution.
 * Returns the substituted string, or `null` if the id is not found (caller
 * should fall back to its built-in default so a broken / out-of-date config
 * file cannot break a clinical flow).
 */
export function getClinicalPrompt(id, vars = {}) {
  const c = loadIfStale();
  const body = c.prompts.get(id);
  if (body == null) return null;
  return body.replace(/\{([A-Za-z0-9_]+)\}/g, (_, name) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) return String(vars[name] ?? '');
    return `{${name}}`; // leave unknown placeholders visible so they're noticed
  });
}

/** List all loaded prompt ids (for diagnostics / admin UI later). */
export function listClinicalPrompts() {
  const c = loadIfStale();
  return [...c.prompts.keys()].map(id => ({ id, placeholders: c.placeholders.get(id) || [] }));
}

/** Force reload (dev/admin). */
export function reloadClinicalPrompts() {
  cache = null;
  return loadIfStale();
}
