/**
 * "Ask about MAIA": the welcome page's question box (server/ask-maia.js).
 *
 *   GET  /api/ask-maia   { available } — whether this host can answer
 *   POST /api/ask-maia   { question, history? } → an SSE stream:
 *                        { delta } … then { done, sources, model }, or { error }
 *
 * Public, before any sign-in, and it never touches an account. Answers
 * come only from Claude (the chat client's 'anthropic' provider, which runs
 * through DigitalOcean's serverless inference). Limits keep it cheap: a
 * question of at most 1,000 characters, a few earlier turns, a per-address
 * hourly and daily count and a daily cap for the whole host. Nothing a
 * visitor types is stored or logged.
 */
import { buildHandbook, buildAskPrompt } from '../ask-maia.js';
import { describeEdition } from '../edition.js';

export const ASK_LIMITS = Object.freeze({
  questionChars: 1000,
  historyTurns: 6,
  historyChars: 8000,
  perHour: 12,
  perDay: 40,
  hostPerDay: 300,
  maxTokens: 900
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

/** The Claude model this host can reach, or null. */
export const claudeModel = (chatClient) => {
  try {
    if (!chatClient?.isProviderAvailable?.('anthropic')) return null;
    const model = chatClient.getProviderModels?.().anthropic || '';
    return /claude/i.test(model) ? model : null;
  } catch { return null; }
};

/** Earlier turns from the page, trimmed to the limits; the visitor's own
 *  questions are returned too, to help find the right sections. */
export const cleanHistory = (history, { historyTurns, historyChars }) => {
  if (!Array.isArray(history)) return { messages: [], questions: [] };
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
  return { messages: kept, questions: kept.filter((m) => m.role === 'user').map((m) => m.content) };
};

/** This host, as the answers describe it. */
const thisHost = () => {
  const { edition, hostRole } = describeEdition();
  return { url: process.env.PUBLIC_APP_URL, edition, hostRole };
};

/**
 * @param {import('express').Express} app
 * @param {object} deps
 * @param {object} deps.chatClient     lib/chat-client ChatClient
 * @param {string} deps.rootDir        the repository, for the handbook
 * @param {() => object} [deps.describeHost]  { url, edition, hostRole }; this host by default
 * @param {object} [deps.limits]       overrides of ASK_LIMITS
 * @param {() => number} [deps.now]
 */
export default function setupAskMaiaRoutes(app, { chatClient, rootDir, describeHost = thisHost, limits = {}, now = Date.now }) {
  const L = { ...ASK_LIMITS, ...limits };
  const envCap = Number(process.env.MAIA_ASK_DAILY_LIMIT);
  if (Number.isFinite(envCap) && envCap >= 0 && limits.hostPerDay === undefined) L.hostPerDay = envCap;
  const limiter = createAskLimiter(L, now);
  let handbook = null;
  const getHandbook = () => (handbook ||= buildHandbook(rootDir));

  app.get('/api/ask-maia', (_req, res) => {
    res.json({ available: !!claudeModel(chatClient) && L.hostPerDay > 0 });
  });

  app.post('/api/ask-maia', async (req, res) => {
    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    if (!question) return res.status(400).json({ error: 'QUESTION_REQUIRED' });
    if (question.length > L.questionChars) return res.status(400).json({ error: 'QUESTION_TOO_LONG', max: L.questionChars });

    const model = claudeModel(chatClient);
    if (!model) return res.status(503).json({ error: 'NOT_AVAILABLE' });

    const slot = limiter.take(req.ip || req.socket?.remoteAddress || 'unknown');
    if (!slot.ok) {
      res.set('Retry-After', String(slot.retryAfter));
      return res.status(429).json({ error: slot.scope === 'host' ? 'HOST_LIMIT' : 'TOO_MANY', retryAfter: slot.retryAfter });
    }

    const { messages, questions } = cleanHistory(req.body?.history, L);
    let prompt;
    try {
      prompt = buildAskPrompt(getHandbook(), question, questions, describeHost() || {});
    } catch (e) {
      console.error('[ask-maia] handbook failed:', e?.message || e);
      return res.status(500).json({ error: 'HANDBOOK_FAILED' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const send = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
    let closed = false;
    res.on('close', () => { closed = true; });

    try {
      await chatClient.chat('anthropic', [...messages, { role: 'user', content: question }], {
        system: prompt.system, stream: true, maxTokens: L.maxTokens, temperature: 0.3
      }, (u) => { if (!closed && u?.delta) send({ delta: u.delta }); });
      send({ done: true, sources: prompt.sources, model });
    } catch (e) {
      console.warn('[ask-maia] answer failed:', e?.message || e);
      send({ error: 'The answer couldn’t be finished. Try again in a moment.' });
    } finally {
      if (!res.writableEnded) res.end();
    }
  });
}
