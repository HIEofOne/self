/**
 * The pipeline's indexed stage reports a running indexing job's progress
 * (start, tokens, files): "Search all my records", Saved Files and the
 * chat card show it. A job under way counts as running even when earlier
 * records are indexed (adding new ones), unless it went quiet two hours ago.
 */
import { describe, it, expect } from 'vitest';
import { computeRecordsPipeline, indexEstimateMinutes } from '../../server/records-pipeline.js';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const doc = (ks, extra = {}) => ({
  userId: 'ann01',
  files: [{ fileName: 'Records.pdf', bucketKey: 'ann01/Records.pdf' }],
  kbIndexingStatus: ks,
  ...extra
});
const indexed = (d) => computeRecordsPipeline(d, { indexing: true, now: NOW }).stages.indexed;

describe('indexing progress in the pipeline', () => {
  it('a running job reports its start, tokens and files', () => {
    expect(indexed(doc({ phase: 'indexing', startedAt: '2026-09-27T11:57:00Z', tokens: '41200', filesIndexed: 1, backendCompleted: false })))
      .toMatchObject({ status: 'running', at: '2026-09-27T11:57:00Z', tokens: 41200, filesIndexed: 1 });
  });

  it('adding new records: a live job counts as running although earlier files are indexed', () => {
    const d = doc({ phase: 'starting', startedAt: '2026-09-27T11:59:00Z', backendCompleted: false }, { kbIndexedBucketKeys: ['ann01/kb/Old.pdf'] });
    expect(indexed(d).status).toBe('running');
  });

  it('a job quiet for over two hours no longer hides the index that exists', () => {
    const d = doc({ phase: 'indexing', startedAt: '2026-09-27T09:00:00Z', backendCompleted: false }, { kbIndexedBucketKeys: ['ann01/kb/Old.pdf'] });
    expect(indexed(d).status).toBe('done');
  });

  it('a finished job is done, with its counts', () => {
    expect(indexed(doc({ phase: 'complete', backendCompleted: true, completedAt: '2026-09-27T11:59:00Z', tokens: 50000, filesIndexed: 2 })))
      .toMatchObject({ status: 'done', tokens: 50000, filesIndexed: 2 });
  });

  it('reports the files to index and the estimate: about a minute per MB plus one, never under two', () => {
    const d = doc(null, { files: [
      { fileName: 'A.pdf', bucketKey: 'ann01/A.pdf', fileSize: 2_400_000 },
      { fileName: 'B.pdf', bucketKey: 'ann01/B.pdf', fileSize: 1_300_000 },
      { fileName: 'Guide.pdf', bucketKey: 'ann01/references/Guide.pdf', fileSize: 9_000_000, isReference: true }
    ] });
    expect(indexed(d)).toMatchObject({ status: 'pending', filesTotal: 2, estimateMinutes: 5 });
    expect(indexEstimateMinutes(0)).toBe(2);
    expect(indexEstimateMinutes(500_000)).toBe(2);
    expect(indexEstimateMinutes(12_800_000)).toBe(14);
  });
});
