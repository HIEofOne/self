/**
 * Google Gemini provider with streaming support
 */

import { BaseChatProvider } from './base-provider.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { StreamingMessageBuilder } from '../streaming/message-builder.js';

export class GeminiProvider extends BaseChatProvider {
  constructor(apiKey, config = {}) {
    super('gemini', config);
    this.apiKey = apiKey;
    this.defaultModel = 'gemini-3.5-flash';
    this.client = null;
    
    if (apiKey) {
      this.client = new GoogleGenerativeAI(apiKey);
    }
  }

  validateConfig() {
    if (!this.apiKey) {
      throw new Error('Gemini API key is required');
    }
    return true;
  }

  /**
   * Chat with Gemini
   */
  async chat(messages, options = {}, onUpdate = null) {
    if (!this.client) {
      throw new Error('Gemini client not initialized');
    }

    const formattedMessages = this.formatMessages(messages);
    const model = options.model || 'gemini-3.5-flash';
    const temperature = options.temperature || 0.7;
    const maxTokens = options.maxTokens || 4096;
    const system = options.system;

    // Gemini format: convert to history + last message
    let history = [];
    let lastMessage = '';
    
    // Build history from all but the last message
    if (formattedMessages.length > 1) {
      for (let i = 0; i < formattedMessages.length - 1; i++) {
        const msg = formattedMessages[i];
        history.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }]
        });
      }
    }
    
    // Last message becomes the current prompt
    lastMessage = formattedMessages[formattedMessages.length - 1]?.content || '';

    try {
      const geminiModel = this.client.getGenerativeModel({
        model,
        tools: [{ googleSearch: {} }],
      });

      // If streaming requested and callback provided
      if (options.stream && onUpdate) {
        return await this.streamChat(geminiModel, history, lastMessage, {
          temperature,
          maxOutputTokens: maxTokens
        }, onUpdate);
      }

      // Non-streaming request
      const chat = geminiModel.startChat({ history });
      const result = await chat.sendMessage(lastMessage);
      const response = result.response;
      const content = response.text();

      return {
        role: 'assistant',
        content,
        model: model
      };

    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Stream chat response
   */
  async streamChat(geminiModel, history, prompt, params, onUpdate) {
    const streamBuilder = new StreamingMessageBuilder(onUpdate);

    try {
      const chat = geminiModel.startChat({ history });
      const result = await chat.sendMessageStream(prompt);

      // Handle Gemini streaming format
      for await (const chunk of result.stream) {
        const chunkText = chunk.text();
        if (chunkText) {
          streamBuilder.addChunk({ type: 'text', text: chunkText });
        }
      }

      streamBuilder.complete({
        model: params.model || 'gemini-3.5-flash'
      });

      return {
        role: 'assistant',
        content: streamBuilder.getContent(),
        model: params.model || 'gemini-3.5-flash'
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
    const streamBuilder = new StreamingMessageBuilder(onUpdate);
    const mockResponse = "I'm Gemini, an AI assistant created by Google. I'm powered by Gemini Pro.";
    
    // Simulate streaming
    for (let i = 0; i < mockResponse.length; i += 5) {
      const chunk = mockResponse.slice(i, i + 5);
      streamBuilder.addChunk({ type: 'text', text: chunk });
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    streamBuilder.complete({ model: 'gemini-3.5-flash' });

    return {
      role: 'assistant',
      content: streamBuilder.getContent(),
      model: 'gemini-3.5-flash',
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
    };
  }
}

