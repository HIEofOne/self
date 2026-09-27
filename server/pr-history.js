/**
 * The repository's merged pull requests, for "Ask about MAIA": what
 * changed, when and why. Each PR's number, merge date, title and summary
 * go in the knowledge pack; the full descriptions are searchable.
 *
 * Fetched from GitHub's public API at startup and once a day (no key: the
 * repository is public). The last good copy is kept in CouchDB
 * (maia_config/ask_pr_history), so a failed fetch leaves the previous one.
 */

export const PR_REPO = 'HIEofOne/self';
const CONFIG_DB = 'maia_config';
const DOC_ID = 'ask_pr_history';
const MAX_PAGES = 10;
const DAY = 24 * 60 * 60 * 1000;

/** A PR description without its sign-off and markup noise, trimmed. */
export const cleanBody = (body) => String(body || '')
  .replace(/🤖 Generated with \[Claude Code\]\([^)]*\)/g, '')
  .replace(/Co-Authored-By:.*$/gim, '')
  .replace(/\r/g, '')
  .trim()
  .slice(0, 12000);

/** The first paragraph of plain prose (or the first bullet), as one line. */
export function summarize(body, max = 170) {
  const paras = cleanBody(body).split(/\n{2,}/)
    .map((p) => p.split('\n').filter((l) => !/^#{1,6}\s/.test(l)).join('\n').trim())
    .filter(Boolean);
  const pick = paras.find((p) => !/^\|/.test(p) && !/^```/.test(p)) || '';
  const line = pick.split('\n').map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, '')).join(' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > max ? `${line.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : line;
}

/** Merged PRs from GitHub's API, newest first. */
export async function fetchMergedPrs(fetchImpl = fetch, repo = PR_REPO) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const resp = await fetchImpl(`https://api.github.com/repos/${repo}/pulls?state=closed&per_page=100&page=${page}`, {
      headers: { 'User-Agent': 'maia-ask-about-maia', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(20000)
    });
    if (!resp.ok) throw new Error(`GitHub ${resp.status}`);
    const list = await resp.json();
    if (!Array.isArray(list) || list.length === 0) break;
    for (const p of list) {
      if (!p?.merged_at) continue;
      out.push({ number: p.number, mergedAt: String(p.merged_at).slice(0, 10), title: String(p.title || '').trim(), body: cleanBody(p.body) });
    }
    if (list.length < 100) break;
  }
  return out.sort((a, b) => b.number - a.number);
}

/**
 * @param {object} deps
 * @param {object} [deps.cloudant]  keeps the last good copy
 * @param {Function} [deps.fetchImpl]
 * @param {() => number} [deps.now]
 * @returns {{ refresh: () => Promise<boolean>, get: () => { prs: object[], fetchedAt: string|null } }}
 */
export function createPrHistory({ cloudant = null, fetchImpl = fetch, now = Date.now, log = console.log } = {}) {
  let state = { prs: [], fetchedAt: null };
  let loadedStored = false;

  const loadStored = async () => {
    if (loadedStored || !cloudant) return;
    loadedStored = true;
    try {
      const doc = await cloudant.getDocument(CONFIG_DB, DOC_ID);
      if (doc?.prs?.length && !state.prs.length) state = { prs: doc.prs, fetchedAt: doc.fetchedAt || null };
    } catch { /* none yet */ }
  };

  const store = async () => {
    if (!cloudant) return;
    try { await cloudant.createDatabase?.(CONFIG_DB); } catch { /* exists */ }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const prior = await cloudant.getDocument(CONFIG_DB, DOC_ID).catch(() => null);
        await cloudant.saveDocument(CONFIG_DB, { _id: DOC_ID, ...(prior?._rev ? { _rev: prior._rev } : {}), fetchedAt: state.fetchedAt, prs: state.prs });
        return;
      } catch (e) {
        if (e?.statusCode !== 409) return;
      }
    }
  };

  return {
    /** Fetch again; on failure keep what we have (or the stored copy). */
    async refresh() {
      try {
        const prs = await fetchMergedPrs(fetchImpl);
        if (!prs.length) throw new Error('no merged PRs');
        state = { prs, fetchedAt: new Date(now()).toISOString() };
        await store();
        log(`[ask-maia] PR history: ${prs.length} merged PRs`);
        return true;
      } catch (e) {
        await loadStored();
        log(`[ask-maia] PR history fetch failed (${e?.message || e}); using ${state.prs.length ? `the copy from ${state.fetchedAt}` : 'none'}`);
        return false;
      }
    },
    get: () => state,
    /** True when the copy is over a day old. */
    stale: () => !state.fetchedAt || now() - Date.parse(state.fetchedAt) > DAY
  };
}
