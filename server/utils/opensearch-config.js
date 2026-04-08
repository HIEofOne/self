/**
 * OpenSearch (DO-managed) config: one database per DO account, shared across all knowledge bases.
 *
 * Resolution order:
 *   1. In-memory cache (fast path after first call)
 *   2. CouchDB maia_config/opensearch_database_id (persists across restarts)
 *   3. DO API: list existing OpenSearch databases — use the one that exists
 *   4. DO API: create a new OpenSearch database if none exists
 *   5. Legacy fallback: parse UUID from env OPENSEARCH_URL (backward compat)
 *
 * Enforces ONE database per account — never creates a second.
 */

const CONFIG_DB = 'maia_config';
const CONFIG_DOC_ID = 'opensearch_database_id';

/** Match UUID in DO dashboard URL: .../databases/95abbf7a-...?i=... */
const OPENSEARCH_URL_UUID = /\/databases\/([a-f0-9-]{36})/i;

let cachedDbId = undefined;
let loggedSource = false;

function maskUuid(uuid) {
  if (!uuid || typeof uuid !== 'string') return '(none)';
  const t = uuid.trim();
  if (t.length < 8) return t.length ? '***' : '(empty)';
  return `${t.slice(0, 4)}...${t.slice(-4)}`;
}

/**
 * Cache the database ID in CouchDB for persistence across restarts.
 */
async function cacheInCouchDB(cloudant, databaseId) {
  try {
    await cloudant.saveDocument(CONFIG_DB, {
      _id: CONFIG_DOC_ID,
      database_id: databaseId,
      cached_at: new Date().toISOString()
    });
    console.log('[OpenSearch] Cached database_id in CouchDB');
  } catch (err) {
    console.warn(`[OpenSearch] Failed to cache database_id in CouchDB: ${err.message}`);
  }
}

/**
 * List OpenSearch databases in the DO account.
 * Returns array of { id, name, engine, status, ... }.
 */
async function listOpenSearchDatabases(doClient) {
  const response = await doClient.request('/v2/databases?engine=opensearch');
  return response.databases || [];
}

/**
 * Create a new OpenSearch database cluster.
 * Uses the smallest size to minimize cost.
 */
async function createOpenSearchDatabase(doClient) {
  const response = await doClient.request('/v2/databases', {
    method: 'POST',
    timeout: 60000,
    body: JSON.stringify({
      name: `maia-opensearch-${Date.now()}`,
      engine: 'opensearch',
      version: '2',
      region: doClient.region || 'tor1',
      size: 'db-s-1vcpu-2gb',
      num_nodes: 1
    })
  });
  return response.database || response;
}

/**
 * Get or create the single OpenSearch database ID for this DO account.
 *
 * Guarantees at most one OpenSearch cluster per DIGITALOCEAN_TOKEN:
 *   - If one exists, uses it
 *   - If zero exist, creates one
 *   - If multiple exist (legacy), uses the oldest and logs a warning
 *
 * @param {object} doClient - DigitalOceanClient instance
 * @param {object} cloudant - CloudantClient instance
 * @returns {Promise<string|null>} The OpenSearch database UUID, or null if unavailable
 */
export async function getOrCreateOpenSearchDatabaseId(doClient, cloudant) {
  // 1. In-memory cache
  if (cachedDbId !== undefined && cachedDbId !== null) {
    return cachedDbId;
  }

  // 2. CouchDB cache
  if (cloudant) {
    try {
      const doc = await cloudant.getDocument(CONFIG_DB, CONFIG_DOC_ID);
      if (doc.database_id) {
        cachedDbId = doc.database_id;
        if (!loggedSource) {
          console.log(`[OpenSearch] database_id: ${maskUuid(cachedDbId)} (from CouchDB cache)`);
          loggedSource = true;
        }
        return cachedDbId;
      }
    } catch (_) { /* doc doesn't exist yet */ }
  }

  // 3. Query DO API for existing OpenSearch databases
  if (doClient) {
    try {
      const databases = await listOpenSearchDatabases(doClient);

      if (databases.length === 1) {
        cachedDbId = databases[0].id;
        console.log(`[OpenSearch] database_id: ${maskUuid(cachedDbId)} (from DO API — 1 cluster found)`);
        loggedSource = true;
        if (cloudant) await cacheInCouchDB(cloudant, cachedDbId);
        return cachedDbId;
      }

      if (databases.length > 1) {
        // Use the oldest to be deterministic; warn about extras
        const sorted = databases.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        cachedDbId = sorted[0].id;
        console.warn(`[OpenSearch] WARNING: Found ${databases.length} OpenSearch clusters. Using oldest: ${maskUuid(cachedDbId)}. Delete extras to avoid unnecessary cost.`);
        loggedSource = true;
        if (cloudant) await cacheInCouchDB(cloudant, cachedDbId);
        return cachedDbId;
      }

      // 4. No databases exist — create one
      console.log('[OpenSearch] No OpenSearch cluster found. Creating one (this may take a few minutes)...');
      const newDb = await createOpenSearchDatabase(doClient);
      cachedDbId = newDb.id;
      console.log(`[OpenSearch] Created new cluster: ${maskUuid(cachedDbId)}`);
      loggedSource = true;
      if (cloudant) await cacheInCouchDB(cloudant, cachedDbId);
      return cachedDbId;

    } catch (err) {
      console.warn(`[OpenSearch] DO API lookup failed: ${err.message}`);
    }
  }

  // 5. Legacy fallback: parse from OPENSEARCH_URL env var
  const url = process.env.OPENSEARCH_URL;
  if (url && typeof url === 'string') {
    const m = url.match(OPENSEARCH_URL_UUID);
    if (m) {
      cachedDbId = m[1];
      if (!loggedSource) {
        console.log(`[OpenSearch] database_id: ${maskUuid(cachedDbId)} (from OPENSEARCH_URL — consider removing this env var)`);
        loggedSource = true;
      }
      if (cloudant) await cacheInCouchDB(cloudant, cachedDbId);
      return cachedDbId;
    }
  }

  // Nothing worked
  cachedDbId = null;
  if (!loggedSource) {
    console.log('[OpenSearch] database_id: not available (no DO token, no CouchDB, no OPENSEARCH_URL)');
    loggedSource = true;
  }
  return cachedDbId;
}
