/**
 * Client side of the recordsPipeline (New_User_Flows.md §5, step 2).
 * One call answers "what's next and who runs it" — every gate, banner,
 * and nudge renders from this instead of holding its own fragment of
 * the pipeline logic.
 */

export interface PipelineStage {
  status: 'done' | 'pending' | 'running' | 'error' | 'skipped';
  at: string | null;
  error?: string | null;
  phase?: string | null;
}

export interface RecordsPipeline {
  stages: Record<string, PipelineStage>;
  current: string;
  hasAppleFile: boolean;
  appleFileName: string | null;
  computedAt: string;
}

export interface PipelineNext {
  kind: 'user' | 'client' | 'wait' | 'done';
  action: string;
  target?: string;
  endpoint?: string;
  params?: { fileName?: string | null; force?: boolean };
  phase?: string | null;
  description?: string;
  /** advance executed this step server-side just now (step 3) */
  started?: boolean;
}

export interface PipelineAdvance {
  pipeline: RecordsPipeline;
  next: PipelineNext;
}

/** Pure read — never triggers work. Use for visibility checks (nudges, banners). */
export async function fetchPipeline(userId: string): Promise<PipelineAdvance | null> {
  try {
    const res = await fetch(`/api/pipeline?userId=${encodeURIComponent(userId)}`, { credentials: 'include' });
    const j = await res.json().catch(() => null);
    if (res.ok && j?.success && j.pipeline && j.next) {
      return { pipeline: j.pipeline, next: j.next };
    }
    return null;
  } catch {
    return null;
  }
}

/** The one trigger — advances the pipeline (may start server-side work).
 *  `intent: 'draft-summary'` asks for a draft explicitly (covers
 *  regeneration); gates still win server-side.
 *  Best-effort: returns null on any failure (gates fall open, as before). */
export async function advancePipeline(userId: string, intent?: string): Promise<PipelineAdvance | null> {
  try {
    const res = await fetch('/api/pipeline/advance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(intent ? { userId, intent } : { userId })
    });
    const j = await res.json().catch(() => null);
    if (res.ok && j?.success && j.pipeline && j.next) {
      return { pipeline: j.pipeline, next: j.next };
    }
    return null;
  } catch {
    return null;
  }
}

/** Poll (pure reads) until a stage reaches a terminal status.
 *  Resolves 'done' | 'error' | 'timeout'. */
export async function waitForStageDone(
  userId: string,
  stage: string,
  timeoutMs = 10 * 60 * 1000,
  intervalMs = 5000
): Promise<'done' | 'error' | 'timeout'> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await fetchPipeline(userId);
    const st = r?.pipeline.stages[stage]?.status;
    if (st === 'done') return 'done';
    if (st === 'error') return 'error';
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return 'timeout';
}
