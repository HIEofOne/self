/**
 * The Community Forum: an "Ask Claude about MAIA" question becomes a new
 * topic (the question only; a title the forum already has gets the time),
 * and the forum's webhook, once its signature checks out, emails the
 * maintainer about sign-ins, new accounts and posts.
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import express from 'express';
import request from 'supertest';
import { serve } from '../helpers/serve.js';
import { forumConfig, askTopic, postAskQuestion, webhookSignatureOk, forumEventEmail, forumWebhookHandler } from '../../server/forum.js';

const CFG = forumConfig({ DISCOURSE_URL: 'https://forum.example/', DISCOURSE_API_KEY: 'k', DISCOURSE_ASK_CATEGORY: '7', DISCOURSE_WEBHOOK_SECRET: 's3cret', FORUM_NOTIFY_EMAIL: 'me@example.org' });
const NOW = new Date('2026-09-28T21:30:00Z');

describe('posting a question', () => {
  it('is off unless the forum, a key and the category are all set; posts as system by default', () => {
    expect(forumConfig({ DISCOURSE_URL: 'https://f', DISCOURSE_API_KEY: 'k' }).askPosting).toBe(false);
    expect(CFG).toMatchObject({ askPosting: true, url: 'https://forum.example', username: 'system', category: 7 });
  });

  it('titles the topic with the question and quotes it; the answer is never part of it', () => {
    const t = askTopic('How do\n groups work?', { host: 'maia.agropper.xyz', now: NOW });
    expect(t.title).toBe('Ask Claude about MAIA: How do groups work?');
    expect(t.raw).toContain('> How do\n>  groups work?');
    expect(t.raw).toContain('https://maia.agropper.xyz/ask');
    expect(askTopic('x'.repeat(1000)).title.length).toBeLessThanOrEqual(250);
  });

  it('posts to the category; a title already used gets the time', async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
      if (calls.length === 1) return new Response('{"errors":["Title has already been used"]}', { status: 422 });
      return new Response(JSON.stringify({ topic_id: 42, topic_slug: 'ask-claude' }), { status: 200 });
    };
    const r = await postAskQuestion('What is MAIA?', { cfg: CFG, host: 'maia.agropper.xyz', fetchImpl, now: () => NOW });
    expect(r).toEqual({ ok: true, url: 'https://forum.example/t/ask-claude/42' });
    expect(calls[0]).toMatchObject({ url: 'https://forum.example/posts.json', headers: { 'Api-Key': 'k', 'Api-Username': 'system' }, body: { title: 'Ask Claude about MAIA: What is MAIA?', category: 7 } });
    expect(calls[1].body.title).toBe('Ask Claude about MAIA: What is MAIA? (2026-09-28 21:30)');
  });

  it('never throws: a failure is reported', async () => {
    const r = await postAskQuestion('Q?', { cfg: CFG, fetchImpl: async () => { throw new Error('down'); } });
    expect(r.ok).toBe(false);
    expect(await postAskQuestion('Q?', { cfg: forumConfig({}) })).toEqual({ ok: false, status: 'off' });
  });
});

describe('the webhook', () => {
  const sign = (body) => `sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`;

  it('checks the signature over the exact body', () => {
    const body = Buffer.from('{"a":1}');
    expect(webhookSignatureOk('s3cret', body, sign(body))).toBe(true);
    expect(webhookSignatureOk('s3cret', Buffer.from('{"a":2}'), sign(body))).toBe(false);
    expect(webhookSignatureOk('s3cret', body, 'sha256=00')).toBe(false);
    expect(webhookSignatureOk('', body, sign(body))).toBe(false);
  });

  it('writes an email for posts, sign-ins and new accounts, and none for other events', () => {
    const post = forumEventEmail('post_created', { post: { username: 'pat', name: 'Pat', topic_id: 9, topic_slug: 'hello', topic_title: 'Hello', post_number: 1, raw: 'First post' } }, 'https://forum.example');
    expect(post).toEqual({ subject: 'Forum: pat (Pat) started “Hello”', text: 'First post\n\nhttps://forum.example/t/hello/9/1' });
    expect(forumEventEmail('post_created', { post: { username: 'bo', topic_id: 9, topic_title: 'Hello', post_number: 3, cooked: '<p>Reply</p>' } }, 'https://f').subject).toBe('Forum: bo replied in “Hello”');
    expect(forumEventEmail('user_logged_in', { user: { username: 'pat' } }, 'https://f')).toEqual({ subject: 'Forum: pat signed in', text: 'https://f/u/pat' });
    expect(forumEventEmail('user_created', { user: { username: 'new1' } }, 'https://f').subject).toBe('Forum: new account new1');
    expect(forumEventEmail('topic_edited', { topic: {} }, 'https://f')).toBeNull();
  });

  it('emails the maintainer for a signed event, and refuses an unsigned one', async () => {
    const sent = [];
    const app = express();
    app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
    app.post('/api/forum/webhook', forumWebhookHandler({ cfg: CFG, sendEmail: async (...a) => sent.push(a) }));
    const server = await serve(app);
    const body = JSON.stringify({ user: { username: 'pat' } });
    const ok = await request(server).post('/api/forum/webhook').set('Content-Type', 'application/json')
      .set('X-Discourse-Event', 'user_logged_in').set('X-Discourse-Event-Signature', sign(body)).send(body);
    expect(ok.status).toBe(200);
    expect(sent).toEqual([['me@example.org', 'Forum: pat signed in', 'https://forum.example/u/pat']]);
    const bad = await request(server).post('/api/forum/webhook').set('Content-Type', 'application/json')
      .set('X-Discourse-Event', 'user_logged_in').set('X-Discourse-Event-Signature', 'sha256=nope').send(body);
    expect(bad.status).toBe(401);
    expect(sent.length).toBe(1);
  });
});
