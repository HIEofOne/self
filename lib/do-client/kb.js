/**
 * Knowledge Base client for DigitalOcean GenAI
 */

export class KbClient {
  constructor(doClient) {
    this.client = doClient;
  }

  /**
   * List all knowledge bases
   */
  async list() {
    const response = await this.client.request('/v2/gen-ai/knowledge_bases');
    return response.knowledge_bases || response.data?.knowledge_bases || [];
  }

  /**
   * Get knowledge base details
   */
  async get(kbId) {
    const response = await this.client.request(`/v2/gen-ai/knowledge_bases/${kbId}`);
    return response.knowledge_base || response.data || response;
  }

  /**
   * Create a new knowledge base
   */
  async create(options) {
    const {
      name,
      description,
      projectId,
      databaseId,
      embeddingModelId,
      bucketName = 'maia',
      itemPath,
      region,
      datasources,
      rerankingConfig
    } = options;

    if (!name || !projectId || !databaseId) {
      throw new Error('name, projectId, and databaseId are required');
    }

    const kbData = {
      name,
      description: description || `${name} description`,
      project_id: projectId,
      database_id: databaseId,
      region: region || this.client.region
    };
    
    // DigitalOcean API requires at least one datasource when creating a KB
    // If itemPath is provided, use it; otherwise create an empty datasource (empty item_path)
    // Empty datasource satisfies API requirement but won't index anything
    // Per-file datasources will be created when files are added
    kbData.datasources = Array.isArray(datasources) && datasources.length > 0
      ? datasources
      : [
          {
            spaces_data_source: {
              bucket_name: bucketName,
              item_path: itemPath || '', // Empty string if no itemPath provided
              region: region || this.client.region
            }
          }
        ];

    if (embeddingModelId) {
      kbData.embedding_model_uuid = embeddingModelId;
    }

    // Cross-encoder reranking during retrieval (top-level on the KB).
    if (rerankingConfig && rerankingConfig.model) {
      kbData.reranking_config = {
        enabled: rerankingConfig.enabled !== false,
        model: rerankingConfig.model
      };
    }

    let response;
    try {
      response = await this.client.request('/v2/gen-ai/knowledge_bases', {
        method: 'POST',
        body: JSON.stringify(kbData)
      });
    } catch (err) {
      // Reranking is an enhancement, never a hard requirement. If DO
      // rejects the reranking model, create the KB WITHOUT it rather
      // than failing the whole KB (which would break Setup/Restore).
      const msg = String(err?.message || '');
      if (kbData.reranking_config && /rerank/i.test(msg)) {
        console.warn(`[KB] reranking rejected ("${msg.trim()}") — creating KB without reranking_config`);
        delete kbData.reranking_config;
        response = await this.client.request('/v2/gen-ai/knowledge_bases', {
          method: 'POST',
          body: JSON.stringify(kbData)
        });
      } else {
        throw err;
      }
    }

    return response.knowledge_base || response.data || response;
  }

  /**
   * Update knowledge base
   */
  async update(kbId, updates) {
    const response = await this.client.request(`/v2/gen-ai/knowledge_bases/${kbId}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    });

    return response.knowledge_base || response.data || response;
  }

  /**
   * Delete knowledge base
   */
  async delete(kbId) {
    await this.client.request(`/v2/gen-ai/knowledge_bases/${kbId}`, {
      method: 'DELETE'
    });
    return { deleted: true };
  }

  /**
   * List data sources for a knowledge base
   */
  async listDataSources(kbId) {
    const response = await this.client.request(`/v2/gen-ai/knowledge_bases/${kbId}/data_sources`);
    
    // Try multiple possible response formats
    if (Array.isArray(response)) {
      return response;
    } else if (response.knowledge_base_data_sources && Array.isArray(response.knowledge_base_data_sources)) {
      return response.knowledge_base_data_sources;
    } else if (response.data_sources && Array.isArray(response.data_sources)) {
      return response.data_sources;
    } else if (response.datasources && Array.isArray(response.datasources)) {
      return response.datasources;
    } else if (response.data && Array.isArray(response.data)) {
      return response.data;
    } else if (response.data && response.data.knowledge_base_data_sources && Array.isArray(response.data.knowledge_base_data_sources)) {
      return response.data.knowledge_base_data_sources;
    } else if (response.data && response.data.data_sources && Array.isArray(response.data.data_sources)) {
      return response.data.data_sources;
    } else {
      return [];
    }
  }

  /**
   * Add data source to knowledge base
   */
  async addDataSource(kbId, dataSourceOptions) {
    const { bucketName = 'maia', itemPath, region } = dataSourceOptions;

    if (!itemPath) {
      throw new Error('itemPath is required for data source');
    }

    const dataSourceData = {
      spaces_data_source: {
        bucket_name: bucketName,
        item_path: itemPath,
        region: region || this.client.region
      }
    };

    const response = await this.client.request(`/v2/gen-ai/knowledge_bases/${kbId}/data_sources`, {
      method: 'POST',
      body: JSON.stringify(dataSourceData)
    });

    return response.data_source || response.data || response;
  }

  /**
   * Delete data source from knowledge base
   */
  async deleteDataSource(kbId, dataSourceId) {
    await this.client.request(`/v2/gen-ai/knowledge_bases/${kbId}/data_sources/${dataSourceId}`, {
      method: 'DELETE'
    });
    return { deleted: true };
  }
}

