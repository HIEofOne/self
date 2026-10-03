/**
 * A Patient Summary asked for while the records are being indexed waits for
 * the index (the patient chose "Index all now" so the summary could use it),
 * shows progress, and can be written at once instead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const pipe = vi.hoisted(() => ({ answers: [] as Array<string>, calls: 0, error: null as string | null }));
vi.mock('../src/utils/pipeline', () => ({
  advancePipeline: async () => null,
  fetchPipeline: async () => {
    const s = pipe.answers[Math.min(pipe.calls++, pipe.answers.length - 1)];
    return { pipeline: { stages: { imported: { status: 'done' }, indexed: { status: s, at: '2026-10-01T12:00:00Z', filesIndexed: pipe.calls, filesTotal: 5, estimateMinutes: 6, error: pipe.error } } } };
  }
}));

import { waitForIndexing, recordsIndexProgress, indexErrorWords } from '../src/utils/recordsSearch';

beforeEach(() => { pipe.calls = 0; pipe.error = null; });

describe('waitForIndexing', () => {
  it('waits while indexing runs, reporting progress, until it is done', async () => {
    pipe.answers = ['running', 'running', 'done'];
    const seen: number[] = [];
    expect(await waitForIndexing('ann01', { intervalMs: 1, onProgress: (p) => seen.push(p.filesIndexed) })).toBe('done');
    expect(seen).toEqual([1, 2]);
  });

  it('stops at once when the patient writes the summary now', async () => {
    pipe.answers = ['running'];
    let stop = false;
    const waiting = waitForIndexing('ann01', { intervalMs: 5000, onProgress: () => { stop = true; }, shouldStop: () => stop });
    expect(await waiting).toBe('skipped');
    expect(pipe.calls).toBe(1);
  });

  it('a failed index or one never started does not hold the summary', async () => {
    pipe.answers = ['error'];
    expect(await waitForIndexing('ann01', { intervalMs: 1 })).toBe('error');
    pipe.answers = ['skipped'];
    expect(await waitForIndexing('ann01', { intervalMs: 1 })).toBe('done');
  });
});

describe('why indexing stopped', () => {
  it('comes from the server, and is said plainly', async () => {
    pipe.answers = ['error'];
    pipe.error = "DigitalOcean's indexing job failed: quota exceeded";
    expect((await recordsIndexProgress('ann01')).error).toBe("DigitalOcean's indexing job failed: quota exceeded");
    expect(indexErrorWords(pipe.error)).toBe("Indexing stopped: DigitalOcean's indexing job failed: quota exceeded.");
    expect(indexErrorWords('Error: HTTP 500.')).toBe('Indexing stopped: HTTP 500.');
    expect(indexErrorWords(null)).toBe('Indexing stopped with an error.');
    expect(indexErrorWords('error')).toBe('Indexing stopped with an error.');
    expect(indexErrorWords('x'.repeat(400)).length).toBeLessThan(200);
  });

  it('is not reported while indexing runs', async () => {
    pipe.answers = ['running'];
    pipe.error = 'old';
    expect((await recordsIndexProgress('ann01')).error).toBeNull();
  });
});
