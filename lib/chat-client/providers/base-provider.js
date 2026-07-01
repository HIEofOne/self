/**
 * Base chat provider class
 * All AI providers should extend this class
 */

export class BaseChatProvider {
  constructor(name, config = {}) {
    this.name = name;
    this.config = config;
  }

  /**
   * Chat with the AI provider
   * @param {Array} messages - Array of message objects { role, content, name? }
   * @param {Object} options - Chat options (model, temperature, etc.)
   * @param {Function} onUpdate - Optional callback for streaming updates (chunk, isComplete)
   * @returns {Promise<Object>} Chat response
   */
  async chat(messages, options = {}, onUpdate = null) {
    throw new Error(`chat() method must be implemented by ${this.name} provider`);
  }

  /**
   * Format messages for provider-specific API
   * Override in subclasses if needed
   */
  formatMessages(messages) {
    return messages.map(msg => ({
      role: msg.role,
      content: msg.content
    }));
  }

  /**
   * Handle provider-specific errors
   */
  handleError(error) {
    // Try to extract detailed error message from OpenAI SDK format
    let errorMessage = error.message || 'Unknown error';

    if (error.response?.data?.error?.message) {
      errorMessage = error.response.data.error.message;
    } else if (error.response?.data?.message) {
      errorMessage = error.response.data.message;
    } else if (error.error?.message) {
      errorMessage = error.error.message;
    }

    const wrapped = new Error(errorMessage);
    wrapped.status = error.status || error.statusCode || (error.response && error.response.status) || 500;
    wrapped.type = this.name;
    return wrapped;
  }

  /**
   * Validate configuration
   */
  validateConfig() {
    return true;
  }
}

