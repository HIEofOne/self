/**
 * The pipeline's indexed stage reports a running indexing job's progress
 * (start, tokens, files): "Search all my records", Saved Files and the
 * chat card show it. A job under way counts as running even when earlier
 * records are indexed (adding new ones), unless it went quiet two hours ago.
 */
import { describe, it, expect } from 'vitest';
import { computeRecordsPipeline } from '../../server/records-pipeline.js';

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
});
