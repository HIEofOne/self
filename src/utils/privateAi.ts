/**
 * Wait until the patient's private AI is running. A new account's AI is
 * still deploying for a couple of minutes after the email is verified;
 * anything that needs it (a Patient Summary draft) waits here instead of
 * failing. Asking /api/agent-setup-status is also what records the AI's
 * endpoint once the deployment is running.
 */
export type PrivateAiReadiness = 'ready' | 'failed' | 'timeout';

export async function waitForPrivateAi(opts: {
  timeoutMs?: number;
  intervalMs?: number;
  /** Called once, when the first check finds the AI not ready yet. */
  onWaiting?: () => void;
} = {}): Promise<PrivateAiReadiness> {
  const timeoutMs = opts.timeoutMs ?? 8 * 60 * 1000;
  const intervalMs = opts.intervalMs ?? 5000;
  const t0 = Date.now();
  let told = false;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch('/api/agent-setup-status', { credentials: 'include' });
      const d = await r.json().catch(() => ({}));
      if (d?.endpointReady) return 'ready';
      if (d?.status === 'provision_failed') return 'failed';
    } catch { /* try again */ }
    if (!told) { told = true; opts.onWaiting?.(); }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return 'timeout';
}

export const PRIVATE_AI_WAIT_TEXT =
  'Your private AI is getting ready. This happens once, after you sign up, and takes about two minutes.';

export const privateAiNotReadyText = (r: PrivateAiReadiness): string => (r === 'failed'
  ? "Your private AI couldn't be started. Open Setup and click Try again."
  : 'Your private AI is taking longer than usual to get ready. Try again in a few minutes.');
