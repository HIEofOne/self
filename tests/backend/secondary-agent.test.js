/**
 * The secondary Private AI is user-chosen, never automatic.
 *
 *  - The model list is DO-hosted (catalog entry has a DO inference
 *    endpoint), agent-capable, active, non-preview chat models — never a
 *    commercial model DO forwards to a vendor, never the primary's model.
 *  - ensureSecondaryAgent creates only with an explicit model, repairs
 *    only with the model chosen before, switches models without losing the
 *    user's instructions, and connects the user's knowledge base unless
 *    the user disconnected it from this agent.
 *
 * In-memory cloudant + a fake DO client; no CouchDB, no DigitalOcean.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import {
  filterSecondaryCandidates, toSecondaryCandidate, _resetSecondaryModelCache, DEFAULT_SECONDARY_MODEL_ID
} from '../../server/utils/secondary-models.js';
import { ensureSecondaryAgent } from '../../server/routes/auth.js';

const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PROJECT = uuid(999);

const catalogModel = (over) => ({
  uuid: uuid(1), id: 'x', name: 'X', type: 'chat', lifecycle_status: 'active',
  endpoints: [{ endpoint: 'https://abc-private-dedicated-inference.do-infra.ai', capabilities: ['chat_completions'] }],
  modalities: { input: ['text'], output: ['text'] },
  pricing: { input_price_per_million: 1e-06, output_price_per_million: 2e-06 },
  settings: [{ name: 'max_tokens', max: 8192 }],
  parameter_count: 100, context_window: 128000, description: '',
  ...over
});

const QWEN = catalogModel({
  uuid: uuid(1), id: 'qwen3.8-max', name: 'Qwen3.8-Max', parameter_count: 2400, context_window: 1000000,
  modalities: { input: ['text', 'image', 'video'], output: ['text'] },
  pricing: { input_price_per_million: 2e-06, output_price_per_million: 6e-06 },
  description: 'MoE with 2.4 trillion total parameters and 95 billion active parameters per token.'
});
const DEEPSEEK = catalogModel({
  uuid: uuid(2), id: 'deepseek-v4-pro', name: 'Deepseek V4 Pro', parameter_count: 1600,
  pricing: { input_price_per_million: 1.74e-06, output_price_per_million: 3.48e-06 }
});
const KIMI_K3 = catalogModel({
  uuid: uuid(3), id: 'kimi-k3', name: 'Kimi K3',
  pricing: { input_price_per_million: 3e-06, output_price_per_million: 1.5e-05 }
});
const CATALOG = [
  QWEN, DEEPSEEK, KIMI_K3,
  catalogModel({ uuid: uuid(10), id: 'anthropic-claude-5-sonnet', name: 'Anthropic Claude Sonnet 5', endpoints: null }),
  catalogModel({ uuid: uuid(11), id: 'openai-gpt-oss-120b', name: 'OpenAI GPT-oss-120b', type: 'reasoning' }),
  catalogModel({ uuid: uuid(12), id: 'minimax-m2.5', name: 'MiniMax M2.5 (Public Preview)' }),
  catalogModel({ uuid: uuid(13), id: 'kimi-k2.5', name: 'Kimi K2.5', lifecycle_status: 'end_of_life' }),
  catalogModel({ uuid: uuid(14), id: 'gte-large', name: 'GTE Large', type: 'embedding', modalities: { input: ['text'], output: ['vector'] } })
];

describe('secondary model catalog filter', () => {
  it('keeps only DO-hosted, active, non-preview chat models other than the primary', () => {
    const ids = filterSecondaryCandidates(CATALOG).map((m) => m.id);
    expect(ids.sort()).toEqual(['deepseek-v4-pro', 'kimi-k3', 'qwen3.8-max']);
  });

  it('puts the suggested model (Qwen3.8-Max) first, then by price', () => {
    const list = filterSecondaryCandidates(CATALOG);
    expect(DEFAULT_SECONDARY_MODEL_ID).toBe('qwen3.8-max');
    expect(list.map((m) => m.id)).toEqual(['qwen3.8-max', 'kimi-k3', 'deepseek-v4-pro']);
    expect(list[0].isDefault).toBe(true);
  });

  it('exposes the table fields with per-million prices', () => {
    expect(toSecondaryCandidate(QWEN)).toMatchObject({
      id: 'qwen3.8-max', name: 'Qwen3.8-Max', paramsTotalB: 2400, paramsActiveB: 95,
      contextWindow: 1000000, imageInput: true, priceInPerM: 2, priceOutPerM: 6, maxOutputTokens: 8192
    });
    expect(toSecondaryCandidate(DEEPSEEK)).toMatchObject({ priceInPerM: 1.74, priceOutPerM: 3.48, imageInput: false, paramsActiveB: null });
  });

  it('parses numbers DO sends as strings (live API: context_window "1000000")', () => {
    const m = toSecondaryCandidate({ ...QWEN, context_window: '1000000', parameter_count: '2400', settings: [{ name: 'max_tokens', max: '8192' }] });
    expect(m).toMatchObject({ contextWindow: 1000000, paramsTotalB: 2400, maxOutputTokens: 8192 });
  });
});

class FakeCloudant {
  constructor() { this.docs = new Map(); }
  async getDocument(_db, id) { return clone(this.docs.get(id) || null); }
  async saveDocument(_db, doc) { this.docs.set(doc._id, clone(doc)); return { ok: true }; }
}

const makeDo = () => {
  const agents = new Map();
  const calls = { create: [], attach: [], delete: [], order: [] };
  let next = 100;
  const client = {
    async request(path) {
      if (path.startsWith('/v2/gen-ai/models')) return { models: clone(CATALOG) };
      throw new Error(`unexpected request ${path}`);
    },
    agent: {
      async list() { return [...agents.values()]; },
      async get(id) {
        const a = agents.get(id);
        if (!a) throw new Error('404 agent not found');
        return clone(a);
      },
      async create(opts) {
        calls.create.push(opts);
        calls.order.push('create');
        const id = uuid(next++);
        const model = CATALOG.find((m) => m.uuid === opts.modelId);
        agents.set(id, {
          uuid: id, name: opts.name, instruction: opts.instruction, project_id: opts.projectId,
          model: { uuid: opts.modelId, inference_name: model?.id, name: model?.name },
          deployment: { status: 'STATUS_DEPLOYING' }
        });
        return { uuid: id };
      },
      async delete(id) { calls.delete.push(id); calls.order.push('delete'); agents.delete(id); },
      async attachKB(agentId, kbId) { calls.attach.push([agentId, kbId]); }
    }
  };
  return { client, agents, calls };
};

let cloudant, dox, savedProject;
const USER = 'jessica76';
const baseDoc = (extra = {}) => ({ _id: USER, userId: USER, type: 'user', kbId: 'kb-1', ...extra });

beforeAll(() => { savedProject = process.env.DO_PROJECT_ID; process.env.DO_PROJECT_ID = PROJECT; });
afterAll(() => { if (savedProject === undefined) delete process.env.DO_PROJECT_ID; else process.env.DO_PROJECT_ID = savedProject; });

beforeEach(() => {
  _resetSecondaryModelCache();
  cloudant = new FakeCloudant();
  dox = makeDo();
});

const qwenChoice = () => toSecondaryCandidate(QWEN);

describe('ensureSecondaryAgent — user-chosen model only', () => {
  it('never creates an agent when no model has been chosen', async () => {
    await cloudant.saveDocument('maia_users', baseDoc());
    await expect(ensureSecondaryAgent(dox.client, cloudant, baseDoc()))
      .rejects.toMatchObject({ code: 'SECONDARY_NOT_CHOSEN' });
    expect(dox.calls.create).toHaveLength(0);
  });

  it('creates with the chosen model, caps output tokens, and connects the knowledge base', async () => {
    await cloudant.saveDocument('maia_users', baseDoc());
    const doc = await ensureSecondaryAgent(dox.client, cloudant, baseDoc(), { model: qwenChoice() });
    expect(dox.calls.create).toHaveLength(1);
    expect(dox.calls.create[0]).toMatchObject({ modelId: QWEN.uuid, projectId: PROJECT, maxTokens: 8192 });
    const agentId = doc.agentProfiles.gpt.agentId;
    expect(dox.calls.attach).toEqual([[agentId, 'kb-1']]);
    const stored = (await cloudant.getDocument('maia_users', USER)).agentProfiles.gpt;
    expect(stored).toMatchObject({ agentId, modelId: 'qwen3.8-max', modelDisplayName: 'Qwen3.8-Max', kbAttachedId: 'kb-1' });
  });

  it('does not connect a knowledge base the user disconnected from this agent', async () => {
    const d = baseDoc({ kbConnections: { gpt: { kb1: false } } });
    await cloudant.saveDocument('maia_users', d);
    await ensureSecondaryAgent(dox.client, cloudant, d, { model: qwenChoice() });
    expect(dox.calls.attach).toEqual([]);
    expect((await cloudant.getDocument('maia_users', USER)).agentProfiles.gpt.kbAttachedId).toBeUndefined();
  });

  it('reuses a live agent when asked for the model it already runs', async () => {
    await cloudant.saveDocument('maia_users', baseDoc());
    const first = await ensureSecondaryAgent(dox.client, cloudant, baseDoc(), { model: qwenChoice() });
    const again = await ensureSecondaryAgent(dox.client, cloudant, first, { model: qwenChoice() });
    expect(dox.calls.create).toHaveLength(1);
    expect(again.agentProfiles.gpt.agentId).toBe(first.agentProfiles.gpt.agentId);
  });

  it('switches models: new agent keeps the instructions, profile is repointed, then the old agent is deleted', async () => {
    // An existing secondary on Kimi K3 with the user's own instructions,
    // an API key and endpoint from the old agent.
    const oldId = uuid(500);
    dox.agents.set(oldId, {
      uuid: oldId, name: 'old', instruction: 'My custom rules',
      model: { uuid: KIMI_K3.uuid, inference_name: 'kimi-k3', name: 'Kimi K3' },
      deployment: { status: 'STATUS_RUNNING', url: 'https://old.agents.do-ai.run' }
    });
    const d = baseDoc({ agentProfiles: { gpt: { agentId: oldId, modelName: 'kimi-k3', apiKey: 'old-key', endpoint: 'https://old/api/v1', deployedLoggedAt: 'x' } } });
    await cloudant.saveDocument('maia_users', d);

    const doc = await ensureSecondaryAgent(dox.client, cloudant, d, { model: qwenChoice() });
    const gpt = doc.agentProfiles.gpt;
    expect(dox.calls.create).toHaveLength(1);
    expect(dox.calls.create[0].instruction).toBe('My custom rules');
    expect(gpt.agentId).not.toBe(oldId);
    expect(gpt.modelId).toBe('qwen3.8-max');
    expect(gpt.apiKey).toBeUndefined();
    expect(gpt.deployedLoggedAt).toBeUndefined();
    expect(dox.calls.delete).toEqual([oldId]);
    expect(dox.calls.order).toEqual(['create', 'delete']);
    expect((await cloudant.getDocument('maia_users', USER)).agentProfiles.gpt.agentId).toBe(gpt.agentId);
  });

  it('repairs a destroyed agent with the model the user chose before — never a default', async () => {
    const d = baseDoc({ agentProfiles: { gpt: { agentId: uuid(700), modelId: 'deepseek-v4-pro', modelDisplayName: 'Deepseek V4 Pro' } } });
    await cloudant.saveDocument('maia_users', d);
    const doc = await ensureSecondaryAgent(dox.client, cloudant, d);
    expect(dox.calls.create).toHaveLength(1);
    expect(dox.calls.create[0].modelId).toBe(DEEPSEEK.uuid);
    expect(doc.agentProfiles.gpt.modelId).toBe('deepseek-v4-pro');
  });

  it('refuses to repair with a model that has left the catalog (e.g. retired Kimi K2.5)', async () => {
    const d = baseDoc({ agentProfiles: { gpt: { agentId: uuid(701), modelName: 'kimi-k2.5' } } });
    await cloudant.saveDocument('maia_users', d);
    await expect(ensureSecondaryAgent(dox.client, cloudant, d))
      .rejects.toMatchObject({ code: 'SECONDARY_MODEL_UNAVAILABLE' });
    expect(dox.calls.create).toHaveLength(0);
  });
});
