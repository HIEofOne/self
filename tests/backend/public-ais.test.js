/**
 * Public AIs in the chat's AI menu (server/public-ais.js): the default
 * four (at least one reasoning model, all read images), the
 * MAIA_PUBLIC_AI_MODELS override, the startup probe, and one chat
 * provider per model that answers.
 */
import { describe, it, expect } from 'vitest';
import { ChatClient } from '../../lib/chat-client/index.js';
import {
  DEFAULT_PUBLIC_AI_MODELS, publicAiModels, labelFromId, probePublicAi, enablePublicAis
} from '../../server/public-ais.js';

const reply = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('the list', () => {
  it('defaults to four models, at least one reasoning, all reading images', () => {
    const list = publicAiModels(undefined);
    expect(list.map((m) => m.id)).toEqual(DEFAULT_PUBLIC_AI_MODELS.map((m) => m.id));
    expect(list).toHaveLength(4);
    expect(list.some((m) => m.reasoning)).toBe(true);
    expect(list.every((m) => m.images)).toBe(true);
  });

  it('MAIA_PUBLIC_AI_MODELS replaces it, dropping bad or repeated ids', () => {
    const list = publicAiModels(' openai-o1, anthropic-claude-opus-5.5,, NOT OK!, openai-o1 ');
    expect(list.map((m) => m.id)).toEqual(['openai-o1', 'anthropic-claude-opus-5.5']);
    expect(list[0]).toMatchObject({ label: 'OpenAI o1', reasoning: true, images: true });
    expect(list[1]).toMatchObject({ label: 'Claude Opus 5.5', reasoning: false, images: false });
    expect(publicAiModels('   ')).toHaveLength(4);
  });

  it('names a model from its id', () => {
    expect(labelFromId('openai-gpt-5.5')).toBe('GPT-5.5');
    expect(labelFromId('deepseek-v4-pro')).toBe('V4 Pro');
    expect(labelFromId('anthropic-claude-4.6-sonnet')).toBe('Claude 4.6 Sonnet');
  });
});

describe('the probe', () => {
  it('counts a model that answers, or refuses only for the one-token limit', async () => {
    expect(await probePublicAi('k', 'm', async () => reply(200))).toBe(true);
    expect(await probePublicAi('k', 'm', async () => reply(400, { message: 'Could not finish the message because max_tokens or model output limit was reached.' }))).toBe(true);
    expect(await probePublicAi('k', 'm', async () => reply(400, { message: 'bad request' }))).toBe(false);
    expect(await probePublicAi('k', 'm', async () => reply(404, { message: 'model not found' }))).toBe(false);
    expect(await probePublicAi('k', 'm', async () => { throw new Error('ECONNRESET'); })).toBe(false);
  });

  it('asks each model for one token, with the key', async () => {
    const calls = [];
    await probePublicAi('secret', 'openai-o1', async (url, init) => { calls.push({ url, init }); return reply(200); });
    expect(calls[0].url).toBe('https://inference.do-ai.run/v1/chat/completions');
    expect(calls[0].init.headers.Authorization).toBe('Bearer secret');
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ model: 'openai-o1', max_tokens: 1 });
  });
});

describe('registration', () => {
  it('registers one provider per model that answers, keyed by its id', async () => {
    const chat = new ChatClient({});
    const ready = await enablePublicAis(chat, 'key', {
      fetchImpl: async (_url, init) => reply(JSON.parse(init.body).model === 'openai-o1' ? 404 : 200),
      log: () => {}
    });
    expect(ready.map((m) => m.id)).toEqual(['openai-gpt-5.4-pro', 'anthropic-claude-fable-5.1', 'openai-gpt-6-astra']);
    expect(chat.isProviderAvailable('openai-gpt-5.4-pro')).toBe(true);
    expect(chat.isProviderAvailable('openai-o1')).toBe(false);
    expect(chat.getProvider('anthropic-claude-fable-5.1').defaultModel).toBe('anthropic-claude-fable-5.1');
    expect(chat.getPublicModels().map((m) => m.label)).toEqual(['GPT-5.4 Pro', 'Claude Fable 5.1', 'GPT-6 Astra']);
  });

  it('a new set replaces the old one; no key registers nothing', async () => {
    const chat = new ChatClient({});
    chat.enablePublicModels('key', [{ id: 'openai-o1', label: 'OpenAI o1' }]);
    chat.enablePublicModels('key', [{ id: 'openai-gpt-6-astra', label: 'GPT-6 Astra' }]);
    expect(chat.isProviderAvailable('openai-o1')).toBe(false);
    expect(chat.getPublicModels().map((m) => m.id)).toEqual(['openai-gpt-6-astra']);
    expect(await enablePublicAis(chat, '', { log: () => {} })).toEqual([]);
  });

  it('never replaces a vendor provider of the same name', () => {
    const chat = new ChatClient({ anthropic: { apiKey: 'a' } });
    chat.enablePublicModels('key', [{ id: 'anthropic', label: 'x' }]);
    expect(chat.getPublicModels()).toEqual([]);
    expect(chat.getProvider('anthropic').constructor.name).toBe('AnthropicProvider');
  });
});
