/**
 * Anthropic Claude provider with streaming support
 */

import { BaseChatProvider } from './base-provider.js';
import Anthropic from '@anthropic-ai/sdk';
import { SSEParser } from '../streaming/stream-parser.js';
import { StreamingMessageBuilder } from '../streaming/message-builder.js';

export class AnthropicProvider extends BaseChatProvider {
  constructor(apiKey, config = {}) {
    super('anthropic', config);
    this.apiKey = apiKey;
    this.client = null;
    
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
    }
  }

  validateConfig() {
    if (!this.apiKey) {
      throw new Error('Anthropic API key is required');
    }
    return true;
  }

  /**
   * Chat with Claude
   */
  async chat(messages, options = {}, onUpdate = null) {
    if (!this.client) {
      throw new Error('Anthropic client not initialized');
    }

    const formattedMessages = this.formatMessages(messages);
    // Using Claude Opus 4.6 as default (latest available model)
    const model = options.model || 'claude-opus-4-6';
    const temperature = options.temperature || 0.7;
    const maxTokens = options.maxTokens || 4096;
    const system = options.system;

    // Add system message to the beginning if provided
    if (system && formattedMessages[0].role !== 'system') {
      formattedMessages.unshift({ role: 'user', content: system });
    }

    try {
      // If streaming requested and callback provided
      if (options.stream && onUpdate) {
        return await this.streamChat(formattedMessages, {
          model,
          temperature,
          max_tokens: maxTokens
        }, onUpdate);
      }

      // Non-streaming request
      const response = await this.client.messages.create({
        model,
        max_tokens: maxTokens,
        temperature,
        messages: formattedMessages,
        system
      });

      const content = response.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('');

      return {
        role: 'assistant',
        content,
        model: model,
        usage: response.usage
      };

    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Stream chat response
   */
  async streamChat(messages, params, onUpdate) {
    const streamBuilder = new StreamingMessageBuilder(onUpdate);

    try {
      const stream = await this.client.messages.stream({
        ...params,
        messages
      });

      // Handle Anthropic streaming
      stream.on('text', (textDelta) => {
        streamBuilder.addChunk({ type: 'text', text: textDelta });
      });

      stream.on('content_block_delta', (delta) => {
        streamBuilder.addChunk(delta);
      });

      stream.on('content_block_done', () => {
        streamBuilder.complete();
      });

      // Handle errors using a Promise-based approach
      const streamError = new Promise((resolve, reject) => {
        stream.on('error', (error) => {
          reject(error);
        });
      });

      // Wait for either the stream to complete or an error to occur
      const finalMessage = await Promise.race([
        stream.finalMessage(),
        streamError
      ]);
      
      streamBuilder.complete({
        model: params.model,
        usage: finalMessage.usage
      });

      return {
        role: 'assistant',
        content: streamBuilder.getContent(),
        model: params.model,
        usage: finalMessage.usage
      };
    } catch (error) {
      // Re-throw with proper error formatting
      throw this.handleError(error);
    }
  }

  /**
   * Mock chat for testing
   */
  async mockChat(messages, options, onUpdate) {
    const lastMessage = messages[messages.length - 1];
    const mockResponse = `[Anthropic Claude] I'm a mock response to: "${lastMessage.content}". This is for local testing without an API key.`;

    if (onUpdate && options.stream) {
      // Simulate streaming
      const words = mockResponse.split(' ');
      for (let i = 0; i < words.length; i++) {
        const chunk = i === words.length - 1 ? words[i] : words[i] + ' ';
        onUpdate({
          delta: chunk,
          content: words.slice(0, i + 1).join(' '),
          isComplete: i === words.length - 1
        });
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }

    return {
      role: 'assistant',
      content: mockResponse,
      model: 'claude-3-mock',
      mock: true
    };
  }
}

