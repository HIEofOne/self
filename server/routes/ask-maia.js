/**
 * "Ask about MAIA": the welcome page's question box (server/ask-maia.js).
 *
 *   GET  /api/ask-maia   { available, model } — whether this host can answer
 *   POST /api/ask-maia   { question, history? } → an SSE stream:
 *                        { step } for each lookup, then { delta } (the
 *                        answer), then { done, looked, model }, or { error }
 *
 * Public, before any sign-in, and it never touches an account. Claude
 * (MAIA_ASK_MODEL, through DigitalOcean's serverless inference) researches
 * each question in this repository with read-only tools, for a few rounds,
 * then answers. Limits keep it affordable: a question of at most 1,000
 * characters, a few earlier turns, per-address hourly and daily counts, a
 * daily cap for the whole host (MAIA_ASK_DAILY_LIMIT), and per-question
 * caps on rounds, lookups and context. Nothing a visitor types is stored
 * or logged.
 */
import { buildRepo, buildResearchPrompt, runResearchTool, RESEARCH_TOOLS } from '../ask-maia.js';
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
  maxRounds: 6,          // model calls that may use tools; one more to answer
  maxToolCalls: 12,      // lookups per question
  toolCallsPerRound: 4,
  maxContextTokens: 60000, // past this, the next call must answer
  maxTokens: 1500
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

/** One chat completion with the research tools. */
async function complete({ key, model, messages, toolChoice, maxTokens, fetchImpl }) {
  const resp = await fetchImpl(`${DO_INFERENCE_URL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, tools: RESEARCH_TOOLS, tool_choice: toolChoice, max_tokens: maxTokens, temperature: 0.2 }),
    signal: AbortSignal.timeout(120000)
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(body?.error?.message || body?.message || `inference ${resp.status}`);
  return body;
}

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
export default function setupAskMaiaRoutes(app, { rootDir, getInference = () => null, describeHost = thisHost, limits = {}, fetchImpl = fetch, now = Date.now }) {
  const L = { ...ASK_LIMITS, ...limits };
  const envCap = Number(process.env.MAIA_ASK_DAILY_LIMIT);
  if (process.env.MAIA_ASK_DAILY_LIMIT !== undefined && Number.isFinite(envCap) && envCap >= 0 && limits.hostPerDay === undefined) L.hostPerDay = envCap;
  const limiter = createAskLimiter(L, now);
  let repo = null;
  const getRepo = () => (repo ||= buildRepo(rootDir));

  app.get('/api/ask-maia', (_req, res) => {
    const inf = getInference();
    res.json({ available: !!(inf?.key && inf?.model) && L.hostPerDay > 0, model: inf?.model || null });
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

    let r;
    let system;
    try {
      r = getRepo();
      system = buildResearchPrompt(r, describeHost() || {});
    } catch (e) {
      console.error('[ask-maia] repository index failed:', e?.message || e);
      return res.status(500).json({ error: 'INDEX_FAILED' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    let closed = false;
    res.on('close', () => { closed = true; });
    const send = (obj) => { if (!closed && !res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

    const messages = [{ role: 'system', content: system }, ...cleanHistory(req.body?.history, L), { role: 'user', content: question }];
    const looked = new Map();
    let toolCalls = 0;
    let context = 0;
    let rounds = 0;
    try {
      let answer = '';
      for (;;) {
        if (closed) return;
        const mustAnswer = rounds >= L.maxRounds || toolCalls >= L.maxToolCalls || context >= L.maxContextTokens;
        const out = await complete({ key: inf.key, model: inf.model, messages, toolChoice: mustAnswer ? 'none' : 'auto', maxTokens: L.maxTokens, fetchImpl });
        rounds += 1;
        context = Number(out?.usage?.prompt_tokens) || context;
        const msg = out?.choices?.[0]?.message || {};
        const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls.slice(0, Math.min(L.toolCallsPerRound, L.maxToolCalls - toolCalls)) : [];
        if (mustAnswer || !calls.length) {
          answer = String(msg.content || '').trim();
          break;
        }
        messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
        for (const c of calls) {
          const result = runResearchTool(r, c.function?.name, parseArgs(c.function?.arguments));
          toolCalls += 1;
          send({ step: result.step });
          for (const l of result.looked) looked.set(`${l.path}:${l.start}`, l);
          messages.push({ role: 'tool', tool_call_id: c.id, content: result.text });
        }
      }
      if (!answer) throw new Error('empty answer');
      send({ delta: answer });
      send({ done: true, model: inf.model, looked: [...looked.values()].slice(0, 12) });
      console.log(`[ask-maia] answered: ${rounds} call(s), ${toolCalls} lookup(s), context ${context} tokens`);
    } catch (e) {
      console.warn('[ask-maia] answer failed:', e?.message || e);
      send({ error: 'The answer couldn’t be finished. Try again in a moment.' });
    } finally {
      if (!res.writableEnded) res.end();
    }
  });
}
