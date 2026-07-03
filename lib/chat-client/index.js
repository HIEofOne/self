/**
 * lib-maia-chat
 * Unified chat interface for multiple AI providers
 */

import { BaseChatProvider } from './providers/base-provider.js';
import { DigitalOceanProvider } from './providers/digitalocean.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';
import { GeminiProvider } from './providers/gemini.js';
import { DeepSeekProvider } from './providers/deepseek.js';

/**
 * Main ChatClient class
 */
export class ChatClient {
  constructor(config = {}) {
    this.config = config;
    this.providers = new Map();

    // Initialize providers based on config
    this.initializeProviders();
  }

  /**
   * Initialize available providers
   */
  initializeProviders() {
    const doInference = this.config.doInference; // { apiKey } if available

    // DigitalOcean Personal AI: always register so POST /api/chat/digitalocean is accepted.
    // Actual chat uses the per-user agent API key (Stage 1); no global DIGITALOCEAN_PERSONAL_API_KEY needed.
    this.providers.set('digitalocean', new DigitalOceanProvider(
      this.config.digitalocean?.apiKey || '',
      {
        baseURL: this.config.digitalocean?.baseURL
      }
    ));

    // Anthropic — direct API key or DO Inference (OpenAI-compatible)
    if (this.config.anthropic?.apiKey) {
      this.providers.set('anthropic', new AnthropicProvider(
        this.config.anthropic.apiKey,
        {}
      ));
    } else if (doInference?.apiKey) {
      // Route through DO Inference using OpenAI-compatible API
      this.providers.set('anthropic', new OpenAIProvider(
        doInference.apiKey,
        { baseURL: 'https://inference.do-ai.run/v1', defaultModel: 'anthropic-claude-4.6-sonnet' }
      ));
    }

    // OpenAI — direct API key or DO Inference
    if (this.config.openai?.apiKey) {
      this.providers.set('openai', new OpenAIProvider(
        this.config.openai.apiKey,
        {}
      ));
    } else if (doInference?.apiKey) {
      this.providers.set('openai', new OpenAIProvider(
        doInference.apiKey,
        { baseURL: 'https://inference.do-ai.run/v1', defaultModel: 'openai-gpt-5.5' }
      ));
    }

    // Gemini — direct API key only (not available on DO Inference)
    if (this.config.gemini?.apiKey) {
      this.providers.set('gemini', new GeminiProvider(
        this.config.gemini.apiKey,
        {}
      ));
    }

    // DeepSeek — direct API key or DO Inference
    if (this.config.deepseek?.apiKey) {
      this.providers.set('deepseek', new DeepSeekProvider(
        this.config.deepseek.apiKey,
        {}
      ));
    } else if (doInference?.apiKey) {
      this.providers.set('deepseek', new OpenAIProvider(
        doInference.apiKey,
        { baseURL: 'https://inference.do-ai.run/v1', defaultModel: 'deepseek-v4-pro' }
      ));
    }
  }

  /**
   * Upgrade providers to use DO Inference for any that weren't configured with a direct API key.
   * Called after the Model Access Key is resolved at startup.
   * @param {string} modelAccessKey — DO Inference Model Access Key
   * @param {Set<string>} [availableModels] — models confirmed accessible; if provided, skip models not in the set
   */
  enableDOInference(modelAccessKey, availableModels) {
    if (!modelAccessKey) return;

    const doBaseURL = 'https://inference.do-ai.run/v1';

    const doModels = [
      { provider: 'anthropic', models: ['anthropic-claude-4.6-sonnet', 'nvidia-nemotron-3-super-120b'] },
      { provider: 'openai',    models: ['openai-gpt-5.5', 'openai-gpt-oss-120b'] },
      { provider: 'deepseek',  models: ['deepseek-v4-pro', 'deepseek-r1-distill-llama-70b'] },
    ];

    for (const { provider, models } of doModels) {
      if (this.providers.has(provider)) continue;
      const model = availableModels
        ? models.find(m => availableModels.has(m))
        : models[0];
      if (!model) continue;
      this.providers.set(provider, new OpenAIProvider(
        modelAccessKey,
        { baseURL: doBaseURL, defaultModel: model }
      ));
    }

    // Register DeepSeek R1 as a separate provider if available
    if (!this.providers.has('deepseek-r1') && availableModels?.has('deepseek-r1-distill-llama-70b')) {
      this.providers.set('deepseek-r1', new OpenAIProvider(
        modelAccessKey,
        { baseURL: doBaseURL, defaultModel: 'deepseek-r1-distill-llama-70b' }
      ));
    }
  }

  /**
   * Get a provider by name
   */
  getProvider(name) {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Provider '${name}' not available`);
    }
    return provider;
  }

  /**
   * Chat with a specific provider
   */
  async chat(providerName, messages, options = {}, onUpdate = null) {
    const provider = this.getProvider(providerName);
    return await provider.chat(messages, options, onUpdate);
  }

  /**
   * List available providers
   */
  getAvailableProviders() {
    return Array.from(this.providers.keys());
  }

  /**
   * Check if a provider is available
   */
  isProviderAvailable(name) {
    return this.providers.has(name);
  }

  /**
   * Get the default model name for each provider (for display purposes).
   */
  getProviderModels() {
    const models = {};
    for (const [name, provider] of this.providers) {
      models[name] = provider.defaultModel || provider.model || null;
    }
    return models;
  }
}

// Export provider classes
export { BaseChatProvider, DigitalOceanProvider, AnthropicProvider, OpenAIProvider, GeminiProvider, DeepSeekProvider };
export { SSEParser, DelimitedParser } from './streaming/stream-parser.js';
export { StreamingMessageBuilder } from './streaming/message-builder.js';

