/**
 * Knowledge-base creation parameters, defined in NEW-AGENT.txt under the
 * "## Knowledge Bases" section (the fenced `key: value` block). These
 * are mapped to the DigitalOcean GenAI Create-Knowledge-Base API:
 *   - reranking_model        -> top-level reranking_config.model
 *   - chunking_strategy      -> per-datasource chunking_algorithm
 *   - semantic_*             -> chunking_options (semantic)
 *   - hierarchical_*         -> chunking_options (hierarchical)
 * (embedding_model is resolved separately in embedding-model-config.js.
 *  The OpenSearch database is intentionally NOT a parameter here: the
 *  code always reuses the existing account cluster — see
 *  opensearch-config.js and the "OpenSearch database" note in
 *  NEW-AGENT.txt.)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NEW_AGENT_PATH = path.join(__dirname, '../../NEW-AGENT.txt');

let cachedConfig = null;
let cachedRerankModel; // undefined = not resolved yet

const DEFAULTS = {
  reranking_model: 'BGE Reranker v2 m3',
  chunking_strategy: 'hierarchical',
  semantic_similarity_threshold: 0.4,
  semantic_max_chunk_size: 1200,
  hierarchical_max_parent_chunk_size: 1500,
  hierarchical_max_child_chunk_size: 400,
  // Per-source override applied to the AH Lists/*.md sidecar data
  // source. AH categories are many short entries — small chunks =
  // entry-level retrieval, not 30-entry blobs.
  ah_lists_max_chunk_size: 200
};

/**
 * Parse the `## Knowledge Bases` fenced key:value block. Returns the
 * raw configured values merged over DEFAULTS. Cached after first read.
 */
export function getKbConfig() {
  if (cachedConfig) return cachedConfig;
  const cfg = { ...DEFAULTS };
  try {
    if (fs.existsSync(NEW_AGENT_PATH)) {
      const content = fs.readFileSync(NEW_AGENT_PATH, 'utf8');
      const i = content.indexOf('## Knowledge Bases');
      if (i !== -1) {
        // Section runs until the next "## " heading.
        const after = content.slice(i + '## Knowledge Bases'.length);
        const nextHeading = after.search(/\n##\s/);
        const section = nextHeading === -1 ? after : after.slice(0, nextHeading);
        for (const line of section.split(/\r?\n/)) {
          const m = line.match(/^\s*([a-z_]+)\s*:\s*(.+?)\s*$/);
          if (!m) continue;
          const key = m[1];
          if (!(key in DEFAULTS)) continue;
          let val = m[2].trim();
          if (/^\d+$/.test(val)) val = parseInt(val, 10);
          else if (/^\d*\.\d+$/.test(val)) val = parseFloat(val);
          cfg[key] = val;
        }
      }
    }
  } catch {
    // fall back to DEFAULTS
  }
  cachedConfig = cfg;
  return cfg;
}

/**
 * Build the per-datasource chunking fields for the DO Create-KB API.
 * Returns `{ chunking_algorithm, chunking_options }` to spread onto a
 * datasource entry (sibling of spaces_data_source).
 */
export function getChunkingForStrategy(strategy) {
  const c = getKbConfig();
  if (String(strategy || '').toLowerCase() === 'hierarchical') {
    return {
      chunking_algorithm: 'CHUNKING_ALGORITHM_HIERARCHICAL',
      chunking_options: {
        parent_chunk_size: Number(c.hierarchical_max_parent_chunk_size) || 750,
        child_chunk_size: Number(c.hierarchical_max_child_chunk_size) || 375
      }
    };
  }
  // default: semantic
  return {
    chunking_algorithm: 'CHUNKING_ALGORITHM_SEMANTIC',
    chunking_options: {
      max_chunk_size: Number(c.semantic_max_chunk_size) || 750,
      semantic_threshold: Number(c.semantic_similarity_threshold) || 0.5
    }
  };
}

// Primary KB-1 uses the configured strategy (hierarchical by default).
export function getChunkingForDataSource() {
  return getChunkingForStrategy(getKbConfig().chunking_strategy || 'hierarchical');
}

/**
 * Chunking override for the Apple Health Lists/*.md sidecar data
 * source. Always SEMANTIC with a small max_chunk_size — the AH
 * categories are many short entries (`**Date:** … | **Page:** …`
 * then the observation, then `---`) and at this chunk size each
 * entry is roughly one chunk. Better than hierarchical for entry-
 * level retrieval (e.g., "what was the patient's A1c on 2026-04-08?").
 */
export function getChunkingForAppleHealthListsSource() {
  const c = getKbConfig();
  return {
    chunking_algorithm: 'CHUNKING_ALGORITHM_SEMANTIC',
    chunking_options: {
      max_chunk_size: Number(c.ah_lists_max_chunk_size) || 200,
      semantic_threshold: 0.7 // entries are ~self-contained — higher threshold = split more readily
    }
  };
}

/**
 * Resolve the configured reranking model display name to the DO
 * "internal name" the API expects in reranking_config.model. Resolves
 * via the GenAI models API (RERANKING usecase); falls back to a slug of
 * the configured name. Returns null only if nothing is configured.
 * @param {object} doClient
 */
export async function getRerankingModelName(doClient) {
  if (cachedRerankModel !== undefined) return cachedRerankModel;
  const display = (getKbConfig().reranking_model || '').trim();
  if (!display) { cachedRerankModel = null; return null; }
  const slug = display.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  try {
    if (doClient) {
      const res = await doClient.request('/v2/gen-ai/models?usecases=MODEL_USECASE_RERANKING');
      const models = res.models || res.data?.models || [];
      const want = display.toLowerCase().replace(/\s+/g, ' ').trim();
      const match = models.find(m => {
        const name = (m.name || '').toLowerCase().trim();
        const id = (m.id || '').toLowerCase().trim();
        const inf = (m.inference_name || '').toLowerCase().trim();
        return name === want || id === slug || inf === slug ||
          name.includes(want) || want.includes(name) ||
          (id && (id.includes(slug) || slug.includes(id))) ||
          (inf && (inf.includes(slug) || slug.includes(inf)));
      });
      // The DO reranking_config.model wants the model's API `id`
      // (e.g. "bge-reranker-v2-m3"), NOT its display name (which has
      // spaces and is rejected as "invalid reranking model"). For these
      // models inference_name is null, so id is the authoritative slug.
      const resolved = match?.id || match?.inference_name;
      if (resolved) {
        cachedRerankModel = String(resolved).trim();
        console.log(`[DO] Reranking model: "${cachedRerankModel}" (resolved from NEW-AGENT.txt "${display}")`);
        return cachedRerankModel;
      }
    }
  } catch (err) {
    console.warn('[DO] Could not resolve reranking model from API:', err.message);
  }
  cachedRerankModel = slug; // e.g. "bge-reranker-v2-m3"
  console.log(`[DO] Reranking model: "${cachedRerankModel}" (slug fallback for "${display}")`);
  return cachedRerankModel;
}
