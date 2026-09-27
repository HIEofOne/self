/**
 * Public AIs in the chat's AI menu, below the private AI(s).
 *
 * The four most expensive commercial models on DigitalOcean's serverless
 * inference, newest per model family, chosen 2026-09-27 from the DO
 * catalog by price (output, then input): at least one reasons before it
 * answers and all four read images. MAIA_PUBLIC_AI_MODELS, a
 * comma-separated list of catalog ids, replaces the list.
 *
 * Each model becomes its own chat provider, keyed by its catalog id, so
 * POST /api/chat/<id> reaches it; the feature gate classifies every
 * non-private provider as 'public-ai'. Only models that answer a probe
 * at startup are offered.
 */

export const DO_INFERENCE_URL = 'https://inference.do-ai.run/v1';

export const DEFAULT_PUBLIC_AI_MODELS = Object.freeze([
  Object.freeze({ id: 'openai-gpt-5.4-pro', label: 'GPT-5.4 Pro', reasoning: true, images: true }),
  Object.freeze({ id: 'openai-o1', label: 'OpenAI o1', reasoning: true, images: true }),
  Object.freeze({ id: 'anthropic-claude-fable-5.1', label: 'Claude Fable 5.1', reasoning: false, images: true }),
  Object.freeze({ id: 'openai-gpt-6-astra', label: 'GPT-6 Astra', reasoning: true, images: true })
]);

const KNOWN = new Map(DEFAULT_PUBLIC_AI_MODELS.map((m) => [m.id, m]));
const ID_RE = /^[a-z0-9][a-z0-9.-]{1,80}$/;

/** "anthropic-claude-opus-5.5" → "Claude Opus 5.5" */
export const labelFromId = (id) => String(id)
  .replace(/^(openai|anthropic|google|deepseek|meta|mistral)-/, '')
  .split('-')
  .map((w) => (/^gpt$/i.test(w) ? 'GPT' : w.charAt(0).toUpperCase() + w.slice(1)))
  .join(' ')
  .replace(/^GPT (\d)/, 'GPT-$1');

/** The configured list: MAIA_PUBLIC_AI_MODELS when set, else the default four. */
export function publicAiModels(raw = process.env.MAIA_PUBLIC_AI_MODELS) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_PUBLIC_AI_MODELS.map((m) => ({ ...m }));
  const seen = new Set();
  return String(raw).split(',').map((s) => s.trim()).filter((id) => ID_RE.test(id) && !seen.has(id) && seen.add(id))
    .slice(0, 8)
    .map((id) => ({ ...(KNOWN.get(id) || { id, label: labelFromId(id), reasoning: false, images: false }) }));
}

/**
 * Does this model answer with our key? A 400 about the output limit (our
 * one-token probe) still means it's there; 401/403/404 mean it isn't.
 */
export async function probePublicAi(modelAccessKey, id, fetchImpl = fetch) {
  try {
    const resp = await fetchImpl(`${DO_INFERENCE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${modelAccessKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(20000)
    });
    if (resp.ok) return true;
    if (resp.status === 400) {
      const body = await resp.json().catch(() => ({}));
      return /max_tokens|output limit|length/i.test(String(body?.message || body?.error?.message || ''));
    }
    return false;
  } catch (e) {
    // A timeout means the request was accepted and is slow to finish.
    return e?.name === 'TimeoutError' || e?.name === 'AbortError';
  }
}

/** Probe the configured models and register the ones that answer. */
export async function enablePublicAis(chatClient, modelAccessKey, { models = publicAiModels(), fetchImpl = fetch, log = console.log } = {}) {
  if (!modelAccessKey || !chatClient?.enablePublicModels) return [];
  const results = await Promise.all(models.map(async (m) => ({ m, ok: await probePublicAi(modelAccessKey, m.id, fetchImpl) })));
  const ready = results.filter((r) => r.ok).map((r) => r.m);
  const missing = results.filter((r) => !r.ok).map((r) => r.m.id);
  chatClient.enablePublicModels(modelAccessKey, ready, DO_INFERENCE_URL);
  log(`[public AIs] offered: ${ready.map((m) => m.id).join(', ') || 'none'}${missing.length ? `; not available: ${missing.join(', ')}` : ''}`);
  return ready;
}
