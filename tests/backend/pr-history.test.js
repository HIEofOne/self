/**
 * The PR history for "Ask about MAIA" (server/pr-history.js): merged PRs
 * from GitHub's public API, each summarized in one line; a failed fetch
 * keeps the last good copy, which CouchDB holds across restarts.
 */
import { describe, it, expect } from 'vitest';
import { fetchMergedPrs, summarize, cleanBody, createPrHistory } from '../../server/pr-history.js';

const pr = (number, merged, title, body = '') => ({ number, merged_at: merged, title, body });
const githubFake = (pages) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const page = Number(new URL(url).searchParams.get('page'));
    if (pages instanceof Error) return { ok: false, status: 403, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => pages[page - 1] || [] };
  };
  return { calls, fetchImpl };
};
class FakeCloudant {
  constructor() { this.docs = new Map(); }
  async getDocument(_db, id) { const d = this.docs.get(id); if (!d) { const e = new Error('missing'); e.statusCode = 404; throw e; } return JSON.parse(JSON.stringify(d)); }
  async saveDocument(_db, doc) { this.docs.set(doc._id, { ...JSON.parse(JSON.stringify(doc)), _rev: `${Date.now()}` }); return { ok: true }; }
  async createDatabase() {}
}

describe('summaries', () => {
  it('take the first plain paragraph, without headings, markup or the sign-off', () => {
    expect(summarize('## What this adds\n\n**Ask about MAIA.** The box [links](https://x) to `code`.\n\nMore.')).toBe('Ask about MAIA. The box links to code.');
    expect(summarize('- first bullet\n- second')).toBe('first bullet second');
    expect(summarize('word '.repeat(80), 40)).toMatch(/^(word ){6}word…$/);
    expect(cleanBody('Text\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\nCo-Authored-By: X <x@y>')).toBe('Text');
    expect(summarize('')).toBe('');
  });
});

describe('fetching', () => {
  it('reads every page, keeps merged PRs only, newest first', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => pr(300 - i, i % 10 ? '2026-09-20T10:00:00Z' : null, `PR ${300 - i}`));
    const page2 = [pr(150, '2026-08-01T00:00:00Z', 'Old one', 'Body')];
    const gh = githubFake([page1, page2]);
    const prs = await fetchMergedPrs(gh.fetchImpl);
    expect(prs).toHaveLength(91);
    expect(prs[0]).toEqual({ number: 299, mergedAt: '2026-09-20', title: 'PR 299', body: '' });
    expect(prs[prs.length - 1]).toMatchObject({ number: 150, mergedAt: '2026-08-01', body: 'Body' });
    expect(gh.calls.map((c) => new URL(c.url).searchParams.get('page'))).toEqual(['1', '2']);
    expect(gh.calls[0].url).toContain('https://api.github.com/repos/HIEofOne/self/pulls?state=closed&per_page=100');
    expect(gh.calls[0].headers['User-Agent']).toBeTruthy();
  });

  it('keeps the last good copy when GitHub fails, and CouchDB holds it across restarts', async () => {
    const cloudant = new FakeCloudant();
    let t = Date.parse('2026-09-27T12:00:00Z');
    const good = createPrHistory({ cloudant, fetchImpl: githubFake([[pr(7, '2026-09-01T00:00:00Z', 'Seven', 'About seven.')]]).fetchImpl, now: () => t, log: () => {} });
    expect(await good.refresh()).toBe(true);
    expect(good.get().prs.map((p) => p.number)).toEqual([7]);
    expect(good.stale()).toBe(false);
    t += 25 * 60 * 60 * 1000;
    expect(good.stale()).toBe(true);

    const failing = createPrHistory({ cloudant, fetchImpl: githubFake(new Error('rate limited')).fetchImpl, log: () => {} });
    expect(await failing.refresh()).toBe(false);
    expect(failing.get()).toMatchObject({ prs: [{ number: 7, title: 'Seven' }], fetchedAt: '2026-09-27T12:00:00.000Z' });

    const none = createPrHistory({ fetchImpl: githubFake(new Error('down')).fetchImpl, log: () => {} });
    expect(await none.refresh()).toBe(false);
    expect(none.get()).toEqual({ prs: [], fetchedAt: null });
  });
});
