/**
 * The private AI's standing instructions change for agents that already
 * exist, and for instructions a restore puts back: the old sentence is
 * swapped where it appears unchanged, once per host, and an instruction the
 * patient rewrote stays as they wrote it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { modernizeInstruction, migrateAgentInstructions, INSTRUCTION_CHANGES } from '../../server/utils/agent-instructions.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OLD = 'Always start your response with the patient\'s name, age and sex. Do not show your reasoning.';

describe('the patient header only for health questions', () => {
  it('swaps the old sentence and leaves everything else', () => {
    expect(modernizeInstruction(OLD)).toBe('When you answer a question about the patient\'s health or records, start your response with the patient\'s name, age and sex; for other questions, such as how to use MAIA, don\'t. Do not show your reasoning.');
    expect(modernizeInstruction('My own instructions.')).toBe('My own instructions.');
    expect(modernizeInstruction(null)).toBe(null);
  });

  it('new agents get the new sentence from NEW-AGENT.txt', () => {
    const text = fs.readFileSync(path.join(ROOT, 'NEW-AGENT.txt'), 'utf8');
    expect(text).not.toContain(INSTRUCTION_CHANGES[0].from);
    expect(text).toContain(INSTRUCTION_CHANGES[0].to);
  });
});

class FakeCloudant {
  constructor(users) { this.dbs = { maia_users: new Map(users.map((u) => [u._id, u])), maia_config: new Map() }; }
  async getDocument(db, id) { const d = this.dbs[db].get(id); if (!d) throw Object.assign(new Error('missing'), { statusCode: 404 }); return JSON.parse(JSON.stringify(d)); }
  async getAllDocuments(db) { return [...this.dbs[db].values()]; }
  async saveDocument(db, doc) { this.dbs[db].set(doc._id, { ...doc, _rev: '1' }); return { ok: true }; }
  async createDatabase() {}
}
const fakeDo = (agents, { failGet = [] } = {}) => ({
  updates: [],
  agent: {
    async get(id) { if (failGet.includes(id)) throw new Error('timeout'); if (!agents[id]) throw new Error('404 not found'); return { uuid: id, instruction: agents[id] }; },
    async update(id, u) { this.parent.updates.push([id, u.instruction]); agents[id] = u.instruction; }
  }
});

describe('the migration', () => {
  it('updates each existing agent once, skips rewritten ones and deleted ones, and records the change', async () => {
    const agents = { a1: OLD, a2: 'Rewritten by the patient.', g1: `Secondary. ${OLD}` };
    const doClient = fakeDo(agents);
    doClient.agent.parent = doClient;
    const cloudant = new FakeCloudant([
      { _id: 'ann01', assignedAgentId: 'a1', agentProfiles: { default: { agentId: 'a1' }, gpt: { agentId: 'g1' } } },
      { _id: 'bob02', assignedAgentId: 'a2' },
      { _id: 'cat03', assignedAgentId: 'gone' }
    ]);
    const r = await migrateAgentInstructions({ cloudant, doClient, log: () => {} });
    expect(r).toMatchObject({ changed: 2, failed: 0, agents: 4, done: true });
    expect(doClient.updates.map(([id]) => id).sort()).toEqual(['a1', 'g1']);
    expect(agents.a2).toBe('Rewritten by the patient.');
    expect((await cloudant.getDocument('maia_config', 'agent_instruction_changes')).done).toEqual(['health-only-patient-header']);
    // Once done, nothing more.
    expect(await migrateAgentInstructions({ cloudant, doClient, log: () => {} })).toEqual({ changed: 0, done: true });
  });

  it('an agent it couldn\'t reach means another try at the next start', async () => {
    const doClient = fakeDo({ a1: OLD }, { failGet: ['a1'] });
    doClient.agent.parent = doClient;
    const cloudant = new FakeCloudant([{ _id: 'ann01', assignedAgentId: 'a1' }]);
    const r = await migrateAgentInstructions({ cloudant, doClient, log: () => {} });
    expect(r).toMatchObject({ changed: 0, failed: 1, done: false });
    await expect(cloudant.getDocument('maia_config', 'agent_instruction_changes')).rejects.toThrow();
  });
});
