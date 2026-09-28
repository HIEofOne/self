/**
 * Changes to the private AI's standing instructions (NEW-AGENT.txt) that
 * existing agents should get too. An agent keeps the instructions it was
 * created with, and a restore puts back the ones in the patient's backup,
 * so each change is a sentence swapped where it appears unchanged: an
 * instruction the patient rewrote is left as they wrote it.
 */

export const INSTRUCTION_CHANGES = Object.freeze([
  {
    // Only a health question gets the patient's name, age and sex on top.
    id: 'health-only-patient-header',
    from: 'Always start your response with the patient\'s name, age and sex.',
    to: 'When you answer a question about the patient\'s health or records, start your response with the patient\'s name, age and sex; for other questions, such as how to use MAIA, don\'t.'
  }
]);

/** The instruction with every change applied (unchanged when none applies). */
export const modernizeInstruction = (text) => {
  if (typeof text !== 'string') return text;
  return INSTRUCTION_CHANGES.reduce((t, c) => t.split(c.from).join(c.to), text);
};

/**
 * Apply the changes to every private AI on this host, once per change.
 * A change is marked done only when every agent was reached, so a DO
 * outage means another try at the next start.
 *
 * @param {object} deps { cloudant, doClient, log }
 */
export async function migrateAgentInstructions({ cloudant, doClient, log = console.log }) {
  const DB = 'maia_config';
  const ID = 'agent_instruction_changes';
  let record = null;
  try { record = await cloudant.getDocument(DB, ID); } catch { /* none yet */ }
  const done = new Set(record?.done || []);
  const pending = INSTRUCTION_CHANGES.filter((c) => !done.has(c.id));
  if (!pending.length) return { changed: 0, done: true };

  const users = ((await cloudant.getAllDocuments('maia_users')) || []).filter((u) => u && !String(u._id || '').startsWith('_design'));
  const agentIds = new Set();
  for (const u of users) {
    if (u.assignedAgentId) agentIds.add(u.assignedAgentId);
    for (const p of Object.values(u.agentProfiles || {})) if (p?.agentId) agentIds.add(p.agentId);
  }
  let changed = 0;
  let failed = 0;
  for (const agentId of agentIds) {
    try {
      const agent = await doClient.agent.get(agentId);
      const next = modernizeInstruction(agent?.instruction);
      if (typeof next === 'string' && next !== agent.instruction) {
        await doClient.agent.update(agentId, { instruction: next });
        changed += 1;
      }
    } catch (e) {
      // A deleted agent (404) has nothing to change; anything else, try again later.
      if (!/404|not found/i.test(String(e?.message || ''))) failed += 1;
    }
  }
  if (!failed) {
    try {
      await cloudant.createDatabase?.(DB);
    } catch { /* exists */ }
    try {
      await cloudant.saveDocument(DB, { _id: ID, ...(record?._rev ? { _rev: record._rev } : {}), done: [...done, ...pending.map((c) => c.id)], updatedAt: new Date().toISOString() });
    } catch (e) { log(`[agent-instructions] could not record the change: ${e?.message || e}`); }
  }
  log(`[agent-instructions] ${pending.map((c) => c.id).join(', ')}: ${changed} of ${agentIds.size} agent(s) updated${failed ? `, ${failed} not reached (will retry)` : ''}`);
  return { changed, failed, agents: agentIds.size, done: !failed };
}
