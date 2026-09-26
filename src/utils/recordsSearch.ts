/**
 * "Search all my records" (feature `records-index`) in the Personal AS
 * edition (group_requests.md §9, P10): once the patient turns it on, the
 * records already in MAIA are indexed on the server (the pipeline's
 * index-records step) and the private AI searches them. These read and
 * start that step; the index itself is the full edition's, unchanged.
 */
import { fetchPipeline, advancePipeline, type PipelineAdvance } from './pipeline';

export type IndexState = 'no-records' | 'pending' | 'running' | 'done' | 'error' | 'off' | 'unknown';

export const indexStateOf = (p: PipelineAdvance | null): IndexState => {
  if (!p) return 'unknown';
  const { imported, indexed } = p.pipeline.stages;
  if (imported?.status !== 'done') return 'no-records';
  if (!indexed || indexed.status === 'skipped') return 'off';
  return indexed.status as IndexState;
};

export const recordsIndexState = async (userId: string): Promise<IndexState> => indexStateOf(await fetchPipeline(userId));

/** Start indexing the records in MAIA (a no-op when there is nothing to do). */
export async function startRecordsIndexing(userId: string): Promise<IndexState> {
  const r = await advancePipeline(userId, 'index-records');
  if (r?.next.action === 'indexing-running') return 'running';
  return indexStateOf(r);
}

export const INDEX_WORDS: Record<IndexState, string> = {
  'no-records': 'There are no record files in MAIA yet. When you add some, index them in Workbook → More features.',
  pending: 'Your records aren’t indexed yet.',
  running: 'Indexing your records. This takes a few minutes; you can keep using MAIA.',
  done: 'Your records are indexed: your private AI can search all of them.',
  error: 'Indexing stopped with an error. Try again.',
  off: '',
  unknown: ''
};
