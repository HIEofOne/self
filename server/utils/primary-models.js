/**
 * Models a user may choose for their PRIMARY Private AI (Workbook → AI
 * Agents): the four most expensive open models DigitalOcean hosts itself,
 * newest per model family, plus the default if it isn't among them and the
 * low-cost openai-gpt-oss-120b, read live from the DO catalog. The default
 * (what a new account gets) is Qwen3.8-Max, or MAIA_PRIMARY_MODEL: in a
 * Patient Summary comparison on real Apple Health exports it was the
 * fastest and accurate, with a million-token context and image input,
 * where GPT-oss-120b dropped and mis-ordered values. Like the secondary's (utils/secondary-models.js),
 * every one is DO-hosted and agent-capable, so the knowledge base can be
 * attached and no record goes to a public AI company.
 */
import { isHostedAgentModel, toSecondaryCandidate, PRIMARY_MODEL_ID } from './secondary-models.js';

export const DEFAULT_PRIMARY_MODEL_ID = process.env.MAIA_PRIMARY_MODEL || 'qwen3.8-max';
/** Still offered: the low-cost model every account used before 2.0.6. */
export const BUDGET_PRIMARY_MODEL_ID = PRIMARY_MODEL_ID;
export const PRIMARY_CHOICES = 4;

const CACHE_TTL_MS = 10 * 60 * 1000;
let cache = { at: 0, models: null };

/** "kimi-k3" and "kimi-k2.6" → "kimi-k"; "glm-5.2" and "glm-5.3" → "glm". */
export const modelFamily = (id) => String(id).toLowerCase().replace(/[\d.]+/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');

/**
 * The most expensive hosted models (output price, then input price), one
 * per family (the newest when prices tie), then the default if it isn't
 * among them, then the low-cost model. `isDefault` marks the default.
 */
export function pickPrimaryModels(catalog, { choices = PRIMARY_CHOICES, defaultId = DEFAULT_PRIMARY_MODEL_ID } = {}) {
  const hosted = (Array.isArray(catalog) ? catalog : []).filter(isHostedAgentModel).map(toSecondaryCandidate);
  const byPrice = [...hosted].sort((a, b) => ((b.priceOutPerM ?? 0) - (a.priceOutPerM ?? 0))
    || ((b.priceInPerM ?? 0) - (a.priceInPerM ?? 0))
    || b.id.localeCompare(a.id));
  const families = new Set();
  const picked = [];
  for (const m of byPrice) {
    if (m.id === BUDGET_PRIMARY_MODEL_ID) continue;
    const fam = modelFamily(m.id);
    if (families.has(fam)) continue;
    families.add(fam);
    picked.push({ ...m, isDefault: m.id === defaultId });
    if (picked.length >= choices) break;
  }
  for (const id of [defaultId, BUDGET_PRIMARY_MODEL_ID]) {
    const m = hosted.find((x) => x.id === id);
    if (m && !picked.some((p) => p.id === id)) picked.push({ ...m, isDefault: id === defaultId });
  }
  return picked;
}

export async function listPrimaryModels(doClient, { force = false } = {}) {
  if (!force && cache.models && Date.now() - cache.at < CACHE_TTL_MS) return cache.models;
  const resp = await doClient.request('/v2/gen-ai/models?per_page=200&usecases=MODEL_USECASE_AGENT');
  const models = pickPrimaryModels(resp?.models || resp?.data?.models || []);
  cache = { at: Date.now(), models };
  return models;
}

/** A user's choice (catalog id or uuid) → an allowed model, or null. */
export async function resolvePrimaryModel(doClient, idOrUuid) {
  if (!idOrUuid || typeof idOrUuid !== 'string') return null;
  const models = await listPrimaryModels(doClient);
  return models.find((m) => m.id === idOrUuid || m.uuid === idOrUuid) || null;
}

/** Test hook. */
export const _resetPrimaryModelCache = () => { cache = { at: 0, models: null }; };
