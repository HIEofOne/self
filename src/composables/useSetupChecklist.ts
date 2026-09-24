import { reactive, readonly } from 'vue';

/**
 * Personal AS setup checklist state (Documentation/group_requests.md §5).
 *
 * The status comes from GET /api/setup-status, which derives every row from
 * facts the account already holds, so a reload at any step resumes where
 * the user is. Shared by the checklist dialog (App.vue) and the Workbook
 * rail's Setup button.
 */
export type SetupStepKey = 'email' | 'passkey' | 'folder' | 'group' | 'summary' | 'sharing';

export interface SetupStep {
  key: SetupStepKey;
  required: boolean;
  done: boolean;
  groups?: string[];
  pending?: string[];
  /** The host's group that can be joined directly (open or approval link). */
  joinable?: { groupId: string; name: string; joinLink: string } | null;
  /** A listed group that joins only by invitation (offered, not required). */
  inviteOnly?: { groupId: string; name: string } | null;
  medicationsVerified?: boolean;
  summaryVerified?: boolean;
  asState?: 'setup' | 'active' | 'paused';
  unconfirmed?: number;
}

export type AgentState = 'waiting-for-email' | 'none' | 'creating' | 'ready';

export interface SetupStatus {
  edition: string;
  steps: SetupStep[];
  requiredDone: boolean;
  agent: AgentState;
}

interface ChecklistState {
  open: boolean;
  status: SetupStatus | null;
  error: string;
  /** The private AI couldn't be created; polling stopped until retryAgent(). */
  agentFailed: boolean;
}

const state = reactive<ChecklistState>({ open: false, status: null, error: '', agentFailed: false });

const AGENT_POLL_MS = 5000;
const AGENT_POLL_MAX = 120; // 10 minutes
let agentTimer: ReturnType<typeof setInterval> | null = null;
let agentPolls = 0;

const stopAgentWatch = () => {
  if (agentTimer) clearInterval(agentTimer);
  agentTimer = null;
  agentPolls = 0;
};

// While the private AI is being created, poll /api/agent-setup-status: it
// records the agent's endpoint once the deploy is running, and starts the
// agent if a background start was lost.
const watchAgent = () => {
  if (agentTimer) return;
  agentTimer = setInterval(async () => {
    agentPolls += 1;
    try {
      const r = await fetch('/api/agent-setup-status', { credentials: 'include' });
      const d = await r.json().catch(() => ({}));
      if (d?.endpointReady) {
        stopAgentWatch();
        await refresh();
        return;
      }
      // Don't retry a failed creation every few seconds (each attempt can
      // call DO); the user retries with one click.
      if (d?.status === 'provision_failed') {
        stopAgentWatch();
        state.agentFailed = true;
        return;
      }
    } catch { /* next poll */ }
    if (agentPolls >= AGENT_POLL_MAX) stopAgentWatch();
  }, AGENT_POLL_MS);
};

const refresh = async (): Promise<SetupStatus | null> => {
  try {
    const r = await fetch('/api/setup-status', { credentials: 'include' });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d?.success) throw new Error(d?.error || `HTTP ${r.status}`);
    state.status = { edition: d.edition, steps: d.steps, requiredDone: d.requiredDone, agent: d.agent };
    state.error = '';
    if ((d.agent === 'creating' || d.agent === 'none') && !state.agentFailed) watchAgent();
    else if (d.agent === 'ready') stopAgentWatch();
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  }
  return state.status;
};

const show = () => { state.open = true; void refresh(); };

/** "Try again" after the private AI failed to start. */
const retryAgent = () => {
  state.agentFailed = false;
  watchAgent();
};
const hide = () => { state.open = false; };

/** Sign-out: forget this account's checklist. */
const reset = () => {
  stopAgentWatch();
  state.open = false;
  state.status = null;
  state.error = '';
  state.agentFailed = false;
};

export function useSetupChecklist() {
  return { state: readonly(state), refresh, show, hide, reset, retryAgent };
}
