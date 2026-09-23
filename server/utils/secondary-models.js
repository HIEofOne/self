/**
 * Models a user may choose for their SECONDARY Private AI agent.
 *
 * The secondary agent is no longer created automatically: the user picks
 * a model in Workbook → AI Agents. The candidates are read live from the
 * DigitalOcean catalog and filtered to:
 *
 *  - agent-capable (`usecases=MODEL_USECASE_AGENT`) — only an agent can
 *    have the user's knowledge base attached;
 *  - DO-HOSTED — the catalog entry carries a DO inference endpoint.
 *    Commercial entries (Anthropic, OpenAI GPT-5.x…) have
 *    `endpoints: null` because DO forwards those requests to the vendor;
 *    they are public AIs and never qualify as a Private AI;
 *  - active lifecycle, not a public preview, text chat output;
 *  - not the primary agent's own model.
 */

export const DEFAULT_SECONDARY_MODEL_ID = 'qwen3.8-max';
export const PRIMARY_MODEL_ID = 'openai-gpt-oss-120b';

const CACHE_TTL_MS = 10 * 60 * 1000;
let cache = { at: 0, models: null };

// DO's API serializes some integers as strings (context_window: "1000000"),
// so every numeric field is parsed rather than type-checked.
const num = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const perMillion = (v) => (num(v) == null ? null : Math.round(num(v) * 1e6 * 100) / 100);

/** "…95 billion active…", "(17B active", "49B active per token" → 95 / 17 / 49 */
const activeParamsB = (description) => {
  const m = /(\d+(?:\.\d+)?)\s*(?:B|billion)\s+active/i.exec(String(description || ''));
  return m ? Number(m[1]) : null;
};

export const isSecondaryCandidate = (m) => !!m
  && Array.isArray(m.endpoints) && m.endpoints.length > 0
  && m.lifecycle_status === 'active'
  && !/preview/i.test(m.name || '')
  && (m.type === 'chat' || m.type === 'reasoning')
  && Array.isArray(m.modalities?.output) && m.modalities.output.includes('text')
  && typeof m.uuid === 'string' && !!m.id
  && m.id !== PRIMARY_MODEL_ID;

export const toSecondaryCandidate = (m) => {
  const maxTokSetting = (m.settings || []).find((s) => s && s.name === 'max_tokens');
  return {
    uuid: m.uuid,
    id: m.id,
    name: m.name,
    paramsTotalB: num(m.parameter_count),
    paramsActiveB: activeParamsB(m.description),
    contextWindow: num(m.context_window),
    imageInput: Array.isArray(m.modalities?.input) && m.modalities.input.includes('image'),
    priceInPerM: perMillion(m.pricing?.input_price_per_million),
    priceOutPerM: perMillion(m.pricing?.output_price_per_million),
    maxOutputTokens: num(maxTokSetting?.max),
    description: String(m.description || '').slice(0, 400),
    isDefault: m.id === DEFAULT_SECONDARY_MODEL_ID
  };
};

/** Default first, then most expensive (a rough proxy for size) first. */
export const filterSecondaryCandidates = (models) => (Array.isArray(models) ? models : [])
  .filter(isSecondaryCandidate)
  .map(toSecondaryCandidate)
  .sort((a, b) => (b.isDefault - a.isDefault) || ((b.priceInPerM ?? 0) - (a.priceInPerM ?? 0)) || a.name.localeCompare(b.name));

export async function listSecondaryModels(doClient, { force = false } = {}) {
  if (!force && cache.models && Date.now() - cache.at < CACHE_TTL_MS) return cache.models;
  const resp = await doClient.request('/v2/gen-ai/models?per_page=200&usecases=MODEL_USECASE_AGENT');
  const models = filterSecondaryCandidates(resp?.models || resp?.data?.models || []);
  cache = { at: Date.now(), models };
  return models;
}

/** Resolve a user's choice (catalog id or uuid) to an allowed candidate, or null. */
export async function resolveSecondaryModel(doClient, idOrUuid) {
  if (!idOrUuid || typeof idOrUuid !== 'string') return null;
  const models = await listSecondaryModels(doClient);
  return models.find((m) => m.id === idOrUuid || m.uuid === idOrUuid) || null;
}

/** Test hook. */
export const _resetSecondaryModelCache = () => { cache = { at: 0, models: null }; };
