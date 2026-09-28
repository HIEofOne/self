/**
 * The Community Forum (Discourse): questions asked on the "Ask Claude about
 * MAIA" page are posted there as new topics (the question only, never the
 * answer), and the forum's webhook tells the maintainer by email when
 * someone signs in, signs up or posts.
 *
 * Posting (a host with all three set):
 *   DISCOURSE_URL           https://forum.agropper.xyz
 *   DISCOURSE_API_KEY       a key allowed to create topics
 *   DISCOURSE_ASK_CATEGORY  the category's id ("Ask Claude about MAIA")
 *   DISCOURSE_API_USERNAME  who posts them (default: system)
 *
 * Notifications (the one host the forum's webhook calls):
 *   DISCOURSE_WEBHOOK_SECRET  the webhook's secret; its signature is checked
 *   FORUM_NOTIFY_EMAIL        where the emails go
 */
import { createHmac, timingSafeEqual } from 'crypto';

const TITLE_PREFIX = 'Ask Claude about MAIA: ';
const MAX_TITLE = 250;

export const forumConfig = (env = process.env) => {
  const url = String(env.DISCOURSE_URL || '').replace(/\/+$/, '');
  return {
    url,
    askPosting: !!(url && env.DISCOURSE_API_KEY && env.DISCOURSE_ASK_CATEGORY),
    apiKey: env.DISCOURSE_API_KEY || '',
    username: env.DISCOURSE_API_USERNAME || 'system',
    category: Number(env.DISCOURSE_ASK_CATEGORY) || null,
    webhookSecret: env.DISCOURSE_WEBHOOK_SECRET || '',
    notifyEmail: env.FORUM_NOTIFY_EMAIL || ''
  };
};

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** The topic for a question: its title and first post. */
export function askTopic(question, { host = '', now = new Date() } = {}) {
  const q = oneLine(question);
  const room = MAX_TITLE - TITLE_PREFIX.length;
  const title = TITLE_PREFIX + (q.length > room ? `${q.slice(0, room - 1).replace(/\s+\S*$/, '')}…` : q);
  const quoted = String(question).trim().split('\n').map((l) => `> ${l}`).join('\n');
  const where = host ? `the [Ask Claude about MAIA](https://${host}/ask) page on ${host}` : 'the Ask Claude about MAIA page';
  const raw = `${quoted}\n\nAsked on ${where}, ${now.toISOString().slice(0, 10)}. Claude's answer went only to the person who asked; anyone may answer here.`;
  return { title, raw };
}

/**
 * Post a question as a new topic. A title the forum already has gets the
 * time added. → { ok, url } or { ok: false, status }. Never throws.
 */
export async function postAskQuestion(question, { cfg = forumConfig(), host = '', fetchImpl = fetch, now = () => new Date() } = {}) {
  if (!cfg.askPosting) return { ok: false, status: 'off' };
  const topic = askTopic(question, { host, now: now() });
  const post = (title) => fetchImpl(`${cfg.url}/posts.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Api-Key': cfg.apiKey, 'Api-Username': cfg.username },
    body: JSON.stringify({ title, raw: topic.raw, category: cfg.category }),
    signal: AbortSignal.timeout(15000)
  });
  try {
    let r = await post(topic.title);
    if (r.status === 422) {
      const stamp = now().toISOString().slice(0, 16).replace('T', ' ');
      r = await post(`${topic.title.slice(0, MAX_TITLE - stamp.length - 3)} (${stamp})`);
    }
    if (!r.ok) return { ok: false, status: r.status };
    const d = await r.json().catch(() => ({}));
    return { ok: true, url: d.topic_id ? `${cfg.url}/t/${d.topic_slug || 'topic'}/${d.topic_id}` : cfg.url };
  } catch (e) {
    return { ok: false, status: e?.name || 'error' };
  }
}

/** Is this the forum's webhook: `sha256=<hex HMAC of the exact body>`? */
export function webhookSignatureOk(secret, rawBody, header) {
  if (!secret || !rawBody || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const want = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'));
  const got = Buffer.from(header.slice('sha256='.length));
  return want.length === got.length && timingSafeEqual(want, got);
}

const textOf = (post) => oneLine(post?.raw || String(post?.cooked || '').replace(/<[^>]+>/g, ' '));

/** The email for a forum event, or null for events that don't need one. */
export function forumEventEmail(event, body, forumUrl) {
  const who = (u) => (u?.name && u.name !== u.username ? `${u.username} (${u.name})` : u?.username || 'someone');
  if (event === 'post_created' && body?.post) {
    const p = body.post;
    const link = `${forumUrl}/t/${p.topic_slug || 'topic'}/${p.topic_id}/${p.post_number || 1}`;
    const excerpt = textOf(p);
    const first = p.post_number === 1;
    return {
      subject: `Forum: ${who(p)} ${first ? 'started' : 'replied in'} “${p.topic_title || 'a topic'}”`,
      text: [excerpt.length > 800 ? `${excerpt.slice(0, 799)}…` : excerpt, '', link].join('\n')
    };
  }
  if ((event === 'user_logged_in' || event === 'user_created') && body?.user) {
    const u = body.user;
    return {
      subject: event === 'user_created' ? `Forum: new account ${who(u)}` : `Forum: ${who(u)} signed in`,
      text: `${forumUrl}/u/${encodeURIComponent(u.username || '')}`
    };
  }
  return null;
}

/**
 * POST /api/forum/webhook: the forum's webhook (Discourse). Checks the
 * signature over the exact body, then emails FORUM_NOTIFY_EMAIL about sign-ins,
 * new accounts and posts. Anything else is acknowledged and ignored.
 */
export function forumWebhookHandler({ cfg = forumConfig(), sendEmail }) {
  return async (req, res) => {
    if (!cfg.webhookSecret || !cfg.notifyEmail) return res.status(404).json({ error: 'NOT_CONFIGURED' });
    if (!webhookSignatureOk(cfg.webhookSecret, req.rawBody, req.get('X-Discourse-Event-Signature'))) {
      return res.status(401).json({ error: 'BAD_SIGNATURE' });
    }
    const mail = forumEventEmail(req.get('X-Discourse-Event'), req.body, cfg.url);
    if (mail) {
      try { await sendEmail(cfg.notifyEmail, mail.subject, mail.text); } catch (e) {
        console.warn('[forum] notification email failed:', e?.message || e);
      }
    }
    res.json({ ok: true });
  };
}
