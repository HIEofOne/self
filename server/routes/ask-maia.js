/**
 * "Ask about MAIA": the welcome page's question box (server/ask-maia.js).
 *
 *   GET  /api/ask-maia   { available, model } — whether this host can answer
 *   POST /api/ask-maia   { question, history? } → an SSE stream:
 *                        { step } for each lookup, then { delta } (the
 *                        answer), then { done, looked, model }, or { error }
 *
 * Public, before any sign-in, and it never touches an account. Claude
 * (MAIA_ASK_MODEL, through DigitalOcean's serverless inference) gets the
 * knowledge pack (server/ask-maia.js) with every question, cached by the
 * provider, and reads what it needs with read-only tools for a few rounds;
 * then it must answer. Limits keep it affordable: a question of at most
 * 1,000 characters, a few earlier turns, per-address hourly and daily
 * counts, a daily cap for the whole host (MAIA_ASK_DAILY_LIMIT), and
 * per-question caps on rounds and lookups. Nothing a visitor types is
 * stored or logged here; where the host posts to the Community Forum
 * (`forum`), each question, never the answer, becomes a public topic there
 * (server/forum.js), and the page says so.
 */
import { buildKnowledge, buildResearchPrompt, runResearchTool, RESEARCH_TOOLS } from '../ask-maia.js';
import { summarize } from '../pr-history.js';
import { describeEdition } from '../edition.js';

export const DEFAULT_ASK_MODEL = 'anthropic-claude-opus-5.5';
export const FALLBACK_ASK_MODEL = 'anthropic-claude-4.6-sonnet';
export const DO_INFERENCE_URL = 'https://inference.do-ai.run/v1';

export const ASK_LIMITS = Object.freeze({
  questionChars: 1000,
  historyTurns: 6,
  historyChars: 8000,
  perHour: 12,
  perDay: 40,
  hostPerDay: 100,
  maxRounds: 4,          // model calls that may use tools; then it must answer
  maxToolCalls: 8,       // lookups per question
  toolCallsPerRound: 4,
  maxTokens: 2500
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Per-address and whole-host counts, in memory (they reset on restart). */
export function createAskLimiter({ perHour, perDay, hostPerDay }, now = Date.now) {
  const byAddress = new Map();
  let host = { day: '', count: 0 };
  return {
    /** Count one question, or say how long to wait. */
    take(address) {
      const t = now();
      const day = new Date(t).toISOString().slice(0, 10);
      if (host.day !== day) host = { day, count: 0 };
      if (host.count >= hostPerDay) return { ok: false, scope: 'host', retryAfter: Math.ceil((Date.parse(`${day}T00:00:00Z`) + DAY - t) / 1000) };
      const times = (byAddress.get(address) || []).filter((x) => t - x < DAY);
      const lastHour = times.filter((x) => t - x < HOUR);
      if (lastHour.length >= perHour) return { ok: false, scope: 'address', retryAfter: Math.ceil((lastHour[0] + HOUR - t) / 1000) };
      if (times.length >= perDay) return { ok: false, scope: 'address', retryAfter: Math.ceil((times[0] + DAY - t) / 1000) };
      times.push(t);
      byAddress.set(address, times);
      host.count += 1;
      if (byAddress.size > 5000) {
        for (const [a, ts] of byAddress) if (!ts.length || t - ts[ts.length - 1] >= DAY) byAddress.delete(a);
      }
      return { ok: true };
    }
  };
}

/** Earlier turns from the page, trimmed to the limits. */
export const cleanHistory = (history, { historyTurns, historyChars }) => {
  if (!Array.isArray(history)) return [];
  const turns = history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-historyTurns)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
  let total = 0;
  const kept = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    total += turns[i].content.length;
    if (total > historyChars) break;
    kept.unshift(turns[i]);
  }
  while (kept.length && kept[0].role !== 'user') kept.shift();
  return kept;
};

const parseArgs = (raw) => {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
};

/** One chat completion, with the research tools unless `tools` is false. */
async function complete({ key, model, messages, tools = true, maxTokens, fetchImpl }) {
  const resp = await fetchImpl(`${DO_INFERENCE_URL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, ...(tools ? { tools: RESEARCH_TOOLS, tool_choice: 'auto' } : {}), max_tokens: maxTokens, temperature: 0.2 }),
    signal: AbortSignal.timeout(120000)
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(body?.error?.message || body?.message || `inference ${resp.status}`);
  return body;
}

// The last round says so. (tool_choice 'none' isn't enough: when the model
// still wants a lookup it writes one, and the provider drops the text.)
const ANSWER_NOW = 'No more lookups are possible. Answer the question now from the knowledge pack and what you have read, and say what you couldn\'t check.';

/** This host, as the answers describe it. */
const thisHost = () => {
  const { edition, hostRole } = describeEdition();
  return { url: process.env.PUBLIC_APP_URL, edition, hostRole };
};

/**
 * @param {import('express').Express} app
 * @param {object} deps
 * @param {string} deps.rootDir              the repository the tools read
 * @param {() => ({key: string, model: string}|null)} deps.getInference  set once the inference key and model are known
 * @param {() => object} [deps.describeHost] { url, edition, hostRole }; this host by default
 * @param {object} [deps.limits]             overrides of ASK_LIMITS
 * @param {Function} [deps.fetchImpl]
 * @param {() => number} [deps.now]
 */
export default function setupAskMaiaRoutes(app, { rootDir, getInference = () => null, getPrs = () => ({ prs: [], fetchedAt: null }), describeHost = thisHost, limits = {}, fetchImpl = fetch, now = Date.now, forum = null }) {
  const L = { ...ASK_LIMITS, ...limits };
  const envCap = Number(process.env.MAIA_ASK_DAILY_LIMIT);
  if (process.env.MAIA_ASK_DAILY_LIMIT !== undefined && Number.isFinite(envCap) && envCap >= 0 && limits.hostPerDay === undefined) L.hostPerDay = envCap;
  const limiter = createAskLimiter(L, now);
  // The knowledge, rebuilt when the PR history changes.
  let knowledge = null;
  let knowledgeFor = undefined;
  const getKnowledge = () => {
    const pr = getPrs() || { prs: [], fetchedAt: null };
    if (!knowledge || knowledgeFor !== pr.fetchedAt) {
      knowledge = buildKnowledge(rootDir, pr.prs || [], summarize);
      knowledgeFor = pr.fetchedAt;
    }
    return knowledge;
  };

  app.get('/api/ask-maia', (_req, res) => {
    const inf = getInference();
    res.json({
      available: !!(inf?.key && inf?.model) && L.hostPerDay > 0, model: inf?.model || null,
      // Questions are posted to the Community Forum: the page says so.
      postsToForum: !!forum, forumUrl: forum?.url || null
    });
  });

  app.post('/api/ask-maia', async (req, res) => {
    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    if (!question) return res.status(400).json({ error: 'QUESTION_REQUIRED' });
    if (question.length > L.questionChars) return res.status(400).json({ error: 'QUESTION_TOO_LONG', max: L.questionChars });

    const inf = getInference();
    if (!inf?.key || !inf?.model || L.hostPerDay <= 0) return res.status(503).json({ error: 'NOT_AVAILABLE' });

    const slot = limiter.take(req.ip || req.socket?.remoteAddress || 'unknown');
    if (!slot.ok) {
      res.set('Retry-After', String(slot.retryAfter));
      return res.status(429).json({ error: slot.scope === 'host' ? 'HOST_LIMIT' : 'TOO_MANY', retryAfter: slot.retryAfter });
    }

    // The question (never the answer) goes to the forum as a new topic; the
    // answer doesn't wait for it.
    if (forum) void Promise.resolve().then(() => forum.post(question)).catch(() => {});

    let k;
    let system;
    try {
      k = getKnowledge();
      system = buildResearchPrompt(k, describeHost() || {});
    } catch (e) {
      console.error('[ask-maia] knowledge pack failed:', e?.message || e);
      return res.status(500).json({ error: 'INDEX_FAILED' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    let closed = false;
    res.on('close', () => { closed = true; });
    const send = (obj) => { if (!closed && !res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

    // The pack is the same for every question on this host: the provider
    // caches it for an hour, so later rounds and later questions read it at
    // a tenth of the price. Today's date follows it, outside the cache.
    const messages = [
      {
        role: 'system',
        content: [
          { type: 'text', text: system, cache_control: { type: 'ephemeral', ttl: '1h' } },
          { type: 'text', text: `Today is ${new Date(now()).toISOString().slice(0, 10)}.` }
        ]
      },
      ...cleanHistory(req.body?.history, L),
      { role: 'user', content: question }
    ];
    const looked = new Map();
    const usage = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    const call = async (opts) => {
      const out = await complete({ key: inf.key, model: inf.model, messages, maxTokens: L.maxTokens, fetchImpl, ...opts });
      const u = out?.usage || {};
      usage.calls += 1;
      usage.input += Number(u.prompt_tokens) || 0;
      usage.cacheRead += Number(u.cache_read_input_tokens) || 0;
      usage.cacheWrite += Number(u.cache_created_input_tokens) || 0;
      usage.output += Number(u.completion_tokens) || 0;
      return out?.choices?.[0]?.message || {};
    };
    let toolCalls = 0;
    let rounds = 0;
    try {
      let answer = '';
      for (;;) {
        if (closed) return;
        const last = rounds >= L.maxRounds || toolCalls >= L.maxToolCalls;
        if (last) messages.push({ role: 'user', content: ANSWER_NOW });
        const msg = await call({});
        rounds += 1;
        const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls.slice(0, Math.min(L.toolCallsPerRound, L.maxToolCalls - toolCalls)) : [];
        answer = String(msg.content || '').trim();
        if (last || !calls.length) {
          // Still reaching for a lookup, or silent: ask once more, without tools.
          if (!answer || calls.length) {
            if (!last) messages.push({ role: 'user', content: ANSWER_NOW });
            answer = String((await call({ tools: false })).content || '').trim();
          }
          break;
        }
        messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
        for (const c of calls) {
          const result = runResearchTool(k, c.function?.name, parseArgs(c.function?.arguments));
          toolCalls += 1;
          send({ step: result.step });
          for (const l of result.looked) looked.set(`${l.path}:${l.start || ''}`, l);
          messages.push({ role: 'tool', tool_call_id: c.id, content: result.text });
        }
      }
      if (!answer) throw new Error('empty answer');
      send({ delta: answer });
      send({ done: true, model: inf.model, looked: [...looked.values()].slice(0, 12) });
      console.log(`[ask-maia] answered: ${usage.calls} call(s), ${toolCalls} lookup(s); tokens in ${usage.input} (cache read ${usage.cacheRead}, written ${usage.cacheWrite}), out ${usage.output}`);
    } catch (e) {
      console.warn('[ask-maia] answer failed:', e?.message || e);
      send({ error: 'The answer couldn’t be finished. Try again in a moment.' });
    } finally {
      if (!res.writableEnded) res.end();
    }
  });
}
