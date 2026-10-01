/**
 * Choosing the model the PRIMARY private AI runs on (Workbook → AI Agents):
 * the four most expensive DO-hosted open models, newest per family, plus the
 * default; a switch sets up a new agent with the same instructions and the
 * knowledge bases the old one had, repoints the account, and deletes the old
 * agent last; the check reports ready once the new agent runs, has its
 * address, and has every knowledge base attached.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pickPrimaryModels, modelFamily } from '../../server/utils/primary-models.js';
import { switchPrimaryAgent, checkPrimarySwitch } from '../../server/routes/auth.js';
import { EDITIONS, getEdition, setEditionForTests } from '../../server/edition.js';

const originalEdition = getEdition();
afterAll(() => setEditionForTests(originalEdition));

const hosted = (id, name, inP, outP, extra = {}) => ({
  uuid: `00000000-0000-4000-8000-${String(Math.abs(id.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 1e12).padStart(12, '0')}`,
  id, name, type: 'chat', lifecycle_status: 'active', endpoints: [{ url: 'x' }],
  modalities: { input: ['text'], output: ['text'] },
  pricing: { input_price_per_million: inP / 1e6, output_price_per_million: outP / 1e6 }, ...extra
});
const CATALOG = [
  hosted('glm-5.2', 'GLM-5.2', 1.4, 4.4),
  hosted('kimi-k3', 'Kimi K3', 3, 15),
  hosted('glm-5.3', 'GLM5.3', 1.4, 4.4),
  hosted('kimi-k2.6', 'Kimi K2.6', 0.95, 4),
  hosted('qwen3.8-max', 'Qwen3.8-Max', 2, 6),
  hosted('deepseek-v4-pro-0813', 'DeepSeek V4 Pro 0813', 1.32, 3.96),
  hosted('deepseek-v4-pro', 'Deepseek V4 Pro', 1.74, 3.48),
  hosted('openai-gpt-oss-120b', 'OpenAI GPT-oss-120b', 0.1, 0.7),
  hosted('secret-preview', 'Big Preview', 9, 99),
  { ...hosted('anthropic-claude-x', 'Claude X', 5, 25), endpoints: null },
  { ...hosted('old-model', 'Old', 8, 40), lifecycle_status: 'end_of_life' }
];

describe('the models to choose from', () => {
  it('the four most expensive hosted models, newest per family, then the low-cost one; Qwen3.8-Max is the default', () => {
    const picked = pickPrimaryModels(CATALOG);
    expect(picked.map((m) => m.id)).toEqual(['kimi-k3', 'qwen3.8-max', 'glm-5.3', 'deepseek-v4-pro-0813', 'openai-gpt-oss-120b']);
    expect(picked.map((m) => m.isDefault)).toEqual([false, true, false, false, false]);
    expect(picked[0]).toMatchObject({ name: 'Kimi K3', priceInPerM: 3, priceOutPerM: 15 });
  });

  it('a default outside the top four is still offered, marked default', () => {
    const picked = pickPrimaryModels(CATALOG, { defaultId: 'kimi-k2.6' });
    expect(picked.map((m) => m.id)).toEqual(['kimi-k3', 'qwen3.8-max', 'glm-5.3', 'deepseek-v4-pro-0813', 'kimi-k2.6', 'openai-gpt-oss-120b']);
    expect(picked.find((m) => m.isDefault)?.id).toBe('kimi-k2.6');
  });

  it('a model family is its id without version numbers', () => {
    expect(modelFamily('kimi-k3')).toBe(modelFamily('kimi-k2.6'));
    expect(modelFamily('glm-5.2')).toBe(modelFamily('glm-5.3'));
    expect(modelFamily('deepseek-v4-pro-0813')).toBe(modelFamily('deepseek-v4-pro'));
    expect(modelFamily('qwen3.8-max')).not.toBe(modelFamily('qwen3.5-397b-a17b'));
  });
});

class FakeCloudant {
  constructor(docs) { this.docs = new Map(docs.map((d) => [d._id, JSON.parse(JSON.stringify(d))])); this.saves = 0; }
  async getDocument(_db, id) { const d = this.docs.get(id); return d ? JSON.parse(JSON.stringify(d)) : null; }
  async saveDocument(_db, doc) { this.saves += 1; this.docs.set(doc._id, JSON.parse(JSON.stringify(doc))); return { ok: true }; }
}

function fakeDo({ oldKbs = ['kb-1', 'kb-2'], attachFails = [] } = {}) {
  const calls = [];
  const agents = new Map([
    ['old-agent', { uuid: 'old-agent', name: 'ann01-agent-1', instruction: 'Be careful. Cite pages.', model: { inference_name: 'openai-gpt-oss-120b' }, knowledge_bases: oldKbs.map((uuid) => ({ uuid })), deployment: { status: 'STATUS_RUNNING', url: 'https://old.example' } }],
    ['other-agent', { uuid: 'other-agent', project_id: '11111111-1111-4111-8111-111111111111' }]
  ]);
  const doClient = {
    request: async () => ({ projects: [] }),
    agent: {
      list: async () => [{ uuid: 'other-agent' }],
      get: async (id) => { calls.push(['get', id]); const a = agents.get(id); if (!a) throw new Error('404'); return JSON.parse(JSON.stringify(a)); },
      create: async (opts) => {
        calls.push(['create', opts]);
        agents.set('new-agent', { uuid: 'new-agent', name: opts.name, instruction: opts.instruction, model: { uuid: opts.modelId }, knowledge_bases: [], deployment: { status: 'STATUS_DEPLOYING' } });
        return { uuid: 'new-agent' };
      },
      attachKB: async (agentId, kbId) => {
        calls.push(['attachKB', agentId, kbId]);
        if (attachFails.includes(kbId)) throw new Error('busy');
        agents.get(agentId).knowledge_bases.push({ uuid: kbId });
      },
      delete: async (id) => { calls.push(['delete', id]); agents.delete(id); }
    }
  };
  return { doClient, calls, agents };
}

const MODEL = { id: 'kimi-k3', name: 'Kimi K3', uuid: '22222222-2222-4222-8222-222222222222', maxOutputTokens: null };
const ACCOUNT = {
  _id: 'ann01', userId: 'ann01', assignedAgentId: 'old-agent', assignedAgentName: 'ann01-agent-1', agentEndpoint: 'https://old.example/api/v1',
  agentModelName: 'openai-gpt-oss-120b', agentApiKey: 'old-key', kbId: 'kb-1',
  agentProfiles: { default: { agentId: 'old-agent', endpoint: 'https://old.example/api/v1', modelName: 'openai-gpt-oss-120b', apiKey: 'old-key', createdAt: '2026-09-01T00:00:00Z' } }
};

describe.each(EDITIONS)('switching the primary private AI, edition "%s"', (edition) => {
  beforeEach(() => setEditionForTests(edition));

  it('sets up a new agent with the same instructions and knowledge bases, repoints the account, then deletes the old agent', async () => {
    const { doClient, calls } = fakeDo();
    const cloudant = new FakeCloudant([ACCOUNT]);
    const r = await switchPrimaryAgent(doClient, cloudant, await cloudant.getDocument('maia_users', 'ann01'), MODEL);
    expect(r).toMatchObject({ switched: true, from: 'openai-gpt-oss-120b', kbIds: ['kb-1', 'kb-2'], attached: ['kb-1', 'kb-2'] });
    const create = calls.find((c) => c[0] === 'create')[1];
    expect(create).toMatchObject({ instruction: 'Be careful. Cite pages.', modelId: MODEL.uuid, maxTokens: 32768, retrievalMethod: 'RETRIEVAL_METHOD_REWRITE' });

    const doc = await cloudant.getDocument('maia_users', 'ann01');
    expect(doc).toMatchObject({ assignedAgentId: 'new-agent', agentModelName: 'kimi-k3', agentEndpoint: null });
    expect(doc.agentApiKey).toBeUndefined();
    expect(doc.agentProfiles.default).toMatchObject({ agentId: 'new-agent', modelId: 'kimi-k3', modelDisplayName: 'Kimi K3', createdAt: '2026-09-01T00:00:00Z' });
    expect(doc.agentProfiles.default.apiKey).toBeUndefined();
    expect(doc.pendingPrimarySwitch).toMatchObject({ from: 'openai-gpt-oss-120b', to: 'kimi-k3', toName: 'Kimi K3', oldAgentId: 'old-agent', kbIds: ['kb-1', 'kb-2'] });

    // The old agent goes last, after the account points at the new one.
    const order = calls.map((c) => c[0]);
    expect(order.lastIndexOf('delete')).toBeGreaterThan(order.lastIndexOf('attachKB'));
    expect(calls.filter((c) => c[0] === 'delete')).toEqual([['delete', 'old-agent']]);
  });

  it('keeps the knowledge bases as they were: none attached before, none after', async () => {
    const { doClient, calls } = fakeDo({ oldKbs: [] });
    const cloudant = new FakeCloudant([ACCOUNT]);
    const r = await switchPrimaryAgent(doClient, cloudant, await cloudant.getDocument('maia_users', 'ann01'), MODEL);
    expect(r.kbIds).toEqual([]);
    expect(calls.some((c) => c[0] === 'attachKB')).toBe(false);
  });

  it('changes nothing for the same model, and needs a private AI to switch', async () => {
    const { doClient, calls } = fakeDo();
    const cloudant = new FakeCloudant([ACCOUNT]);
    const same = await switchPrimaryAgent(doClient, cloudant, await cloudant.getDocument('maia_users', 'ann01'), { ...MODEL, id: 'openai-gpt-oss-120b' });
    expect(same.switched).toBe(false);
    expect(calls.some((c) => c[0] === 'create')).toBe(false);
    await expect(switchPrimaryAgent(doClient, cloudant, { userId: 'bob02' }, MODEL)).rejects.toMatchObject({ code: 'NO_PRIMARY_AGENT' });
  });

  it('the check attaches a missing knowledge base, and is ready once the agent runs with its address', async () => {
    const { doClient, agents } = fakeDo({ attachFails: ['kb-2'] });
    const cloudant = new FakeCloudant([ACCOUNT]);
    await switchPrimaryAgent(doClient, cloudant, await cloudant.getDocument('maia_users', 'ann01'), MODEL);
    const logged = [];
    const retrieval = [];
    const opts = { ensureAgentRetrieval: async (id) => retrieval.push(id), logEvent: async (e) => logged.push(e) };

    let st = await checkPrimarySwitch(doClient, cloudant, await cloudant.getDocument('maia_users', 'ann01'), opts);
    expect(st).toMatchObject({ ready: false, status: 'STATUS_DEPLOYING', knowledgeBases: 2, waitingForKnowledgeBase: true });

    agents.get('new-agent').deployment = { status: 'STATUS_RUNNING', url: 'https://new.example' };
    agents.get('new-agent').knowledge_bases.push({ uuid: 'kb-2' }); // attached on a later try
    st = await checkPrimarySwitch(doClient, cloudant, await cloudant.getDocument('maia_users', 'ann01'), opts);
    expect(st).toMatchObject({ ready: true, status: 'ready', model: { id: 'kimi-k3', name: 'Kimi K3' }, waitingForKnowledgeBase: false });
    const doc = await cloudant.getDocument('maia_users', 'ann01');
    expect(doc.agentEndpoint).toBe('https://new.example/api/v1');
    expect(doc.agentProfiles.default.endpoint).toBe('https://new.example/api/v1');
    expect(doc.pendingPrimarySwitch).toBeUndefined();
    expect(retrieval).toEqual(['new-agent']);
    expect(logged).toEqual([expect.objectContaining({ event: 'primary-agent-model-switched', from: 'openai-gpt-oss-120b', to: 'kimi-k3', knowledgeBases: 2 })]);
  });
});
