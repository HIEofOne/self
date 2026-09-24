import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useSetupChecklist } from '../src/composables/useSetupChecklist';

const status = (agent: string, requiredDone = false) => ({
  success: true, edition: 'personal-as', requiredDone, agent,
  steps: [{ key: 'email', required: true, done: true }]
});

// Routes /api/setup-status and /api/agent-setup-status to canned answers.
const stubFetch = (answers: { setup: unknown[]; agent: unknown[] }) => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    const body = url.includes('agent-setup-status') ? answers.agent.shift() : answers.setup.shift();
    return { ok: true, status: 200, json: async () => body };
  }));
  return calls;
};

beforeEach(() => { vi.useFakeTimers(); useSetupChecklist().reset(); });
afterEach(() => { useSetupChecklist().reset(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('useSetupChecklist', () => {
  it('stores the derived status', async () => {
    stubFetch({ setup: [status('ready', true)], agent: [] });
    const { refresh, state } = useSetupChecklist();
    await refresh();
    expect(state.status?.requiredDone).toBe(true);
    expect(state.status?.agent).toBe('ready');
  });

  it('while the private AI is being created, polls until it is ready, then re-derives', async () => {
    const calls = stubFetch({
      setup: [status('creating'), status('ready')],
      agent: [{ endpointReady: false }, { endpointReady: true }]
    });
    const { refresh, state } = useSetupChecklist();
    await refresh();
    expect(state.status?.agent).toBe('creating');
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(state.status?.agent).toBe('ready');
    const agentPolls = calls.filter((u) => u.includes('agent-setup-status')).length;
    await vi.advanceTimersByTimeAsync(20000);
    expect(calls.filter((u) => u.includes('agent-setup-status')).length).toBe(agentPolls); // stopped
  });

  it('reset (sign-out) forgets the account and stops polling', async () => {
    const calls = stubFetch({ setup: [status('creating')], agent: [] });
    const { refresh, show, reset, state } = useSetupChecklist();
    await refresh();
    show();
    reset();
    expect(state.open).toBe(false);
    expect(state.status).toBeNull();
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(20000);
    expect(calls.length).toBe(before);
  });
});

describe('useSetupChecklist — failed agent', () => {
  it('stops polling when creation fails, and resumes on retry', async () => {
    const calls = stubFetch({
      setup: [status('none'), status('ready')],
      agent: [{ status: 'provision_failed' }, { endpointReady: true }]
    });
    const { refresh, retryAgent, state } = useSetupChecklist();
    await refresh();
    await vi.advanceTimersByTimeAsync(5000);
    expect(state.agentFailed).toBe(true);
    const polls = calls.filter((u) => u.includes('agent-setup-status')).length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(calls.filter((u) => u.includes('agent-setup-status')).length).toBe(polls); // no retry storm
    retryAgent();
    await vi.advanceTimersByTimeAsync(5000);
    expect(state.agentFailed).toBe(false);
    expect(state.status?.agent).toBe('ready');
  });
});
