/**
 * Setup-Restore Test — Verification Utilities
 *
 * Provides tab verification and comparison for the automated test cycle.
 * The actual test flow is driven by the wizard in auto-pilot mode (testMode flag),
 * not by this module. This module only reads and compares server state.
 */

// ── Types ──────────────────────────────────────────────────────────

export interface TabVerification {
  files: { count: number; names: string[] };
  agentReady: boolean;
  kbIndexed: boolean;
  kbTokens: number;
  medications: { text: string; lines: number };
  summary: { text: string; lines: number; chars: number };
  chats: { count: number };
  instructions: { text: string | null };
  lists: { text: string | null };
}

export interface ComparisonResult {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; expected: string; actual: string }>;
}

export interface TestPhaseResult {
  phase: string;
  passed: boolean;
  message: string;
  detail?: string;
  timestamp: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

const fetchJson = async (url: string) => {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
};

const countLines = (text: string | null | undefined): number =>
  text ? text.split('\n').filter(l => l.trim()).length : 0;

// ── Verify All Tabs ──────────────────────────────────────────────

export async function verifyAllTabs(userId: string): Promise<TabVerification> {
  const [userStatus, patientSummary, sharedChats, agentStatus, agentInstructions, listsMarkdown] =
    await Promise.all([
      fetchJson(`/api/user-status?userId=${encodeURIComponent(userId)}`),
      fetchJson(`/api/patient-summary?userId=${encodeURIComponent(userId)}`).catch(() => ({ summary: null })),
      fetchJson(`/api/shared-group-chats?userId=${encodeURIComponent(userId)}`).catch(() => ({ chats: [] })),
      fetchJson(`/api/agent-setup-status?userId=${encodeURIComponent(userId)}`).catch(() => ({ agentReady: false })),
      fetchJson(`/api/agent-instructions?userId=${encodeURIComponent(userId)}`).catch(() => ({ instructions: null })),
      fetchJson(`/api/files/lists/markdown?userId=${encodeURIComponent(userId)}`).catch(() => ({ markdown: null }))
    ]);

  const userFiles = await fetchJson(`/api/user-files?userId=${encodeURIComponent(userId)}&source=saved`).catch(() => ({ files: [] }));

  const medsText = userStatus.currentMedications || '';
  const summaryText = patientSummary.summary || '';

  return {
    files: {
      count: userFiles.files?.length || userStatus.fileCount || 0,
      names: (userFiles.files || []).map((f: any) => f.fileName || f.name)
    },
    agentReady: agentStatus.agentReady || userStatus.agentReady || false,
    kbIndexed: userStatus.hasKB || false,
    kbTokens: userStatus.kbTokens || 0,
    medications: { text: medsText, lines: countLines(medsText) },
    summary: { text: summaryText, lines: countLines(summaryText), chars: summaryText.length },
    chats: { count: sharedChats.chats?.length || 0 },
    instructions: { text: agentInstructions.instructions || null },
    lists: { text: listsMarkdown.markdown || null }
  };
}

// ── Compare Setup vs Restore ──────────────────────────────────────

export function compareResults(setup: TabVerification, restore: TabVerification): ComparisonResult {
  const checks: ComparisonResult['checks'] = [];

  const check = (name: string, expected: any, actual: any) => {
    const expStr = String(expected);
    const actStr = String(actual);
    checks.push({ name, passed: expStr === actStr, expected: expStr, actual: actStr });
  };

  check('Saved Files count', setup.files.count, restore.files.count);
  check('Agent ready', setup.agentReady, restore.agentReady);
  check('KB indexed', setup.kbIndexed, restore.kbIndexed);
  check('Medications lines', setup.medications.lines, restore.medications.lines);
  check('Medications content', setup.medications.text, restore.medications.text);
  check('Summary lines', setup.summary.lines, restore.summary.lines);
  check('Summary content', setup.summary.text, restore.summary.text);
  check('Lists', setup.lists.text || '', restore.lists.text || '');

  return {
    passed: checks.every(c => c.passed),
    checks
  };
}

// ── Validate maia-state.json ──────────────────────────────────────

export function validateBackupState(state: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!state) {
    errors.push('maia-state.json is null or unreadable');
    return { valid: false, errors };
  }

  if (!state.currentMedications || state.currentMedications === 'verified') {
    errors.push(`currentMedications is "${state.currentMedications || 'empty'}" — expected actual text`);
  }

  if (!state.patientSummary || state.patientSummary === 'verified') {
    errors.push(`patientSummary is "${state.patientSummary || 'empty'}" — expected actual text`);
  }

  if (!state.files || state.files.length === 0) {
    errors.push('No files in backup state');
  }

  return { valid: errors.length === 0, errors };
}

// ── Format Results ──────────────────────────────────────────────

export function formatPhaseResults(phases: TestPhaseResult[]): string {
  const lines: string[] = [];
  lines.push('Setup-Restore Test');
  lines.push('==================');

  for (const p of phases) {
    const icon = p.passed ? '\u2713' : '\u2717';
    lines.push(`${icon} ${p.phase}: ${p.message}`);
    if (p.detail) lines.push(`  ${p.detail}`);
  }

  const allPassed = phases.every(p => p.passed);
  lines.push('');
  lines.push(allPassed ? 'RESULT: PASS' : 'RESULT: FAIL');

  return lines.join('\n');
}

export function formatVerification(label: string, v: TabVerification): string {
  const lines: string[] = [];
  lines.push(`${label}:`);
  lines.push(`  Files: ${v.files.count} — ${v.files.names.join(', ') || '(none)'}`);
  lines.push(`  Agent: ${v.agentReady ? 'ready' : 'not ready'}`);
  lines.push(`  KB: ${v.kbIndexed ? `indexed (${v.kbTokens.toLocaleString()} tokens)` : 'not indexed'}`);
  lines.push(`  Medications: ${v.medications.lines} lines`);
  lines.push(`  Summary: ${v.summary.lines} lines, ${v.summary.chars.toLocaleString()} chars`);
  lines.push(`  Chats: ${v.chats.count}`);
  lines.push(`  Instructions: ${v.instructions.text ? 'yes' : 'none'}`);
  lines.push(`  Lists: ${v.lists.text ? 'yes' : 'none'}`);
  return lines.join('\n');
}

export function formatComparison(c: ComparisonResult): string {
  const lines: string[] = [];
  lines.push('Comparison (setup vs restore):');
  for (const check of c.checks) {
    const icon = check.passed ? '\u2713' : '\u2717';
    if (check.passed) {
      lines.push(`  ${icon} ${check.name}: match`);
    } else {
      // Truncate long values
      const exp = check.expected.length > 40 ? check.expected.slice(0, 40) + '...' : check.expected;
      const act = check.actual.length > 40 ? check.actual.slice(0, 40) + '...' : check.actual;
      lines.push(`  ${icon} ${check.name}: "${exp}" !== "${act}"`);
    }
  }
  return lines.join('\n');
}
