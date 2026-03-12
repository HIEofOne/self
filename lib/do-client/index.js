/**
 * lib-maia-do-client
 * 
 * Clean DigitalOcean GenAI API client for MAIA
 */

import { KbClient } from './kb.js';
import { AgentClient } from './agent.js';
import { IndexingClient } from './indexing.js';

/**
 * Main DigitalOcean GenAI client
 */
export class DigitalOceanClient {
  constructor(apiKey, options = {}) {
    if (!apiKey) {
      throw new Error('DigitalOcean API key is required');
    }

    this.apiKey = apiKey;
    this.baseUrl = options.baseUrl || 'https://api.digitalocean.com';
    this.region = options.region || 'tor1';

    // Initialize sub-clients
    this.kb = new KbClient(this);
    this.agent = new AgentClient(this);
    this.indexing = new IndexingClient(this);
  }

  /**
   * Base request method for all DigitalOcean API calls
   */
  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const { timeout = 25000, ...restOptions } = options;
    const headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      ...restOptions.headers
    };

    const config = {
      signal: AbortSignal.timeout(timeout),
      headers,
      ...restOptions
    };

    const response = await fetch(url, config);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`DigitalOcean API error: ${response.status} - ${errorText}`);
    }

    return response.json();
  }
}

// Export convenience methods
export { KbClient } from './kb.js';
export { AgentClient } from './agent.js';
export { IndexingClient } from './indexing.js';

// Export default
export default DigitalOceanClient;

