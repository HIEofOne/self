/**
 * A Patient Summary asked for while the records are being indexed waits for
 * the index (the patient chose "Index all now" so the summary could use it),
 * shows progress, and can be written at once instead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const pipe = vi.hoisted(() => ({ answers: [] as Array<string>, calls: 0 }));
vi.mock('../src/utils/pipeline', () => ({
  advancePipeline: async () => null,
  fetchPipeline: async () => {
    const s = pipe.answers[Math.min(pipe.calls++, pipe.answers.length - 1)];
    return { pipeline: { stages: { imported: { status: 'done' }, indexed: { status: s, at: '2026-10-01T12:00:00Z', filesIndexed: pipe.calls, filesTotal: 5, estimateMinutes: 6 } } } };
  }
}));

import { waitForIndexing } from '../src/utils/recordsSearch';

beforeEach(() => { pipe.calls = 0; });

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
