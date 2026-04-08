# Configuration Documentation

This document lists the APIs related to each environment variable used in the MAIA Cloud User App.

## DigitalOcean Environment Variables

### DIGITALOCEAN_PERSONAL_API_KEY
**No longer used.** Private AI uses the per-user agent API key (Stage 1). See ENVIRONMENTAL_VARS.md.

---

### DIGITALOCEAN_TOKEN
**API:** DigitalOcean GenAI REST API v2

**Base URL:** `https://api.digitalocean.com` (default)

**Endpoints:**
- `GET /v2/gen-ai/agents` - List agents
- `GET /v2/gen-ai/agents/{agentId}` - Get agent details
- `POST /v2/gen-ai/agents` - Create agent
- `PUT /v2/gen-ai/agents/{agentId}` - Update agent
- `DELETE /v2/gen-ai/agents/{agentId}` - Delete agent
- `POST /v2/gen-ai/agents/{agentId}/knowledge_bases/{kbId}` - Attach KB to agent
- `DELETE /v2/gen-ai/agents/{agentId}/knowledge_bases/{kbId}` - Detach KB from agent
- `GET /v2/gen-ai/agents/{agentId}/api_keys` - List agent API keys
- `POST /v2/gen-ai/agents/{agentId}/api_keys` - Create agent API key
- `GET /v2/gen-ai/knowledge_bases` - List knowledge bases
- `GET /v2/gen-ai/knowledge_bases/{kbId}` - Get knowledge base details
- `POST /v2/gen-ai/knowledge_bases` - Create knowledge base
- `PUT /v2/gen-ai/knowledge_bases/{kbId}` - Update knowledge base
- `DELETE /v2/gen-ai/knowledge_bases/{kbId}` - Delete knowledge base
- `GET /v2/gen-ai/knowledge_bases/{kbId}/data_sources` - List data sources
- `POST /v2/gen-ai/knowledge_bases/{kbId}/data_sources` - Add data source
- `DELETE /v2/gen-ai/knowledge_bases/{kbId}/data_sources/{dataSourceId}` - Delete data source
- `POST /v2/gen-ai/knowledge_bases/{kbId}/indexing_jobs` - Start indexing job
- `POST /v2/gen-ai/indexing_jobs` - Start global indexing job
- `GET /v2/gen-ai/indexing_jobs/{jobId}` - Get indexing job status
- `GET /v2/gen-ai/knowledge_bases/{kbId}/indexing_jobs` - List indexing jobs for KB
- `DELETE /v2/gen-ai/indexing_jobs/{jobId}` - Cancel indexing job

**Usage:**
- Primary authentication token for DigitalOcean GenAI REST API
- Used by `DigitalOceanClient` in `lib/do-client/index.js`
- Authorized via `Authorization: Bearer {DIGITALOCEAN_TOKEN}` header

**Related Files:**
- `lib/do-client/index.js`
- `lib/do-client/agent.js`
- `lib/do-client/kb.js`
- `lib/do-client/indexing.js`
- `server/index.js` (line 311)

---

### DIGITALOCEAN_BASE_URL
**Status:** Not used in codebase

**Note:** This environment variable is not referenced anywhere in the codebase. The base URL for DigitalOcean GenAI REST API is hardcoded as `https://api.digitalocean.com` in `lib/do-client/index.js`.

---

### S3_FORCE_PATH_STYLE
**Status:** Optional

**Usage:**
- When set to `true`, forces path-style S3 URLs
- Defaults to `false` for DigitalOcean Spaces

**Related Files:**
- `server/index.js`
- `server/routes/files.js`
- `server/routes/auth.js`
- `scripts/sync-kb-names-and-files.js`

---

### KB_USE_EPHEMERAL_SPACES
**Status:** Optional

**Usage:**
- When `true`, uses a temporary Spaces bucket for KB indexing

**Related Files:**
- `server/index.js`

---

### SPACES_ENDPOINT_URL
**No longer used.** Spaces endpoint is derived from `DO_REGION` or `SPACES_REGION` via `getSpacesEndpoint()` in `server/utils/storage-config.js`.

---

### SPACES_REGION
**Status:** Optional

**Default:** `tor1`

**Usage:**
- Region used for Spaces datasources in DO KB indexing

**Related Files:**
- `server/index.js`

---

### SPACES_AWS_ACCESS_KEY_ID
**Status:** Optional

**Usage:**
- Spaces access key for ephemeral KB indexing bucket

**Related Files:**
- `server/index.js`

---

### SPACES_AWS_SECRET_ACCESS_KEY
**Status:** Optional

**Usage:**
- Spaces secret key for ephemeral KB indexing bucket

**Related Files:**
- `server/index.js`

---

### SPACES_BUCKET_PREFIX
**Status:** Optional

**Default:** `maia-kb-temp`

**Usage:**
- Prefix used when creating ephemeral Spaces buckets for indexing

**Related Files:**
- `server/index.js`

---

Bucket name is defined in NEW-AGENT.txt and returned by `getSpacesBucketName()` in `server/utils/storage-config.js`. No env var.

---

### DIGITALOCEAN_AWS_ACCESS_KEY_ID
**API:** DigitalOcean Spaces (S3-compatible API)

**Usage:**
- AWS-compatible access key ID for Spaces authentication
- Used as part of S3 client credentials configuration

**Related Files:**
- `server/routes/files.js` (line 549)
- `server/index.js` (multiple locations)
- `server/routes/auth.js` (line 55)

---

### DIGITALOCEAN_AWS_SECRET_ACCESS_KEY
**API:** DigitalOcean Spaces (S3-compatible API)

**Usage:**
- AWS-compatible secret access key for Spaces authentication
- Used as part of S3 client credentials configuration

**Related Files:**
- `server/routes/files.js` (line 550)
- `server/index.js` (multiple locations)
- `server/routes/auth.js` (line 56)

---

The Spaces endpoint is derived from `DO_REGION` (or `SPACES_REGION`) as `https://<region>.digitaloceanspaces.com` via `getSpacesEndpoint()` in `server/utils/storage-config.js`. No env var.

---

### DO_REGION
**API:** DigitalOcean GenAI REST API v2

**Default:** `tor1`

**Usage:**
- Specifies the region for DigitalOcean GenAI resources
- Used when creating knowledge bases, agents, and other resources
- Passed to `DigitalOceanClient` constructor

**Related Files:**
- `lib/do-client/index.js` (line 22)
- `lib/do-client/kb.js` (line 50, 62)
- `server/index.js` (line 312)

---

### DO_PROJECT_ID
**API:** DigitalOcean GenAI REST API v2

**Endpoints:**
- Used when creating agents: `POST /v2/gen-ai/agents`
- Used when creating knowledge bases: `POST /v2/gen-ai/knowledge_bases`

**Usage:**
- UUID of the DigitalOcean project containing GenAI resources
- Required for creating agents and knowledge bases

**Related Files:**
- `lib/do-client/agent.js` (line 52)
- `lib/do-client/kb.js` (line 48)
- `server/index.js` (lines 2738, 6952)

---

### OpenSearch / database_id (DO-managed)
The database UUID is auto-discovered via the DO API (`GET /v2/databases?engine=opensearch`), or a new cluster is created if none exists. Cached in CouchDB (`maia_config/opensearch_database_id`). One cluster per account enforced. Legacy fallback: `OPENSEARCH_URL` env var. See `server/utils/opensearch-config.js`.

---

### DO_EMBEDDING_MODEL_ID
**API:** DigitalOcean GenAI REST API v2

**Endpoints:**
- Used when creating knowledge bases: `POST /v2/gen-ai/knowledge_bases` (optional field `embedding_model_uuid`)

**Usage:**
- UUID of the embedding model to use for knowledge base vectorization
- Optional parameter for knowledge base creation
- If not provided, DigitalOcean uses default embedding model

**Related Files:**
- `lib/do-client/kb.js` (line 67-68)
- `server/index.js` (lines 2923, 6954)

---

## Passkey / WebAuthn Environment Variables

### PASSKEY_RPID
**Purpose:** Relying party ID (domain scope for passkeys).

**Usage:**
- Set to the apex domain to cover subdomains (e.g., `agropper.xyz`).

**Related Files:**
- `lib/passkey/passkey-service.js`
- `server/index.js`

---

### PASSKEY_ORIGIN
**Purpose:** Default expected origin for WebAuthn verification.

**Usage:**
- Must be a single origin, e.g. `https://self.agropper.xyz`.
- Do **not** provide a comma‑separated list here.

**Related Files:**
- `lib/passkey/passkey-service.js`
- `server/index.js`

---

### PASSKEY_ORIGINS
**Purpose:** Allowlist of multiple origins for WebAuthn verification.

**Usage:**
- Comma‑separated origins:
  `https://self.agropper.xyz,https://maia.agropper.xyz`
- If set, the server validates `Origin` against this list.

**Related Files:**
- `lib/passkey/passkey-service.js`
- `server/routes/auth.js`

### DATABASE_URL
**Status:** Not used in codebase

**Note:** This environment variable is not referenced anywhere in the codebase. The application uses separate Cloudant environment variables (`CLOUDANT_URL`, `CLOUDANT_USERNAME`, `CLOUDANT_PASSWORD`) for database connections instead.

---

## Summary

### APIs Used:
1. **DigitalOcean GenAI Personal AI Chat API** (OpenAI-compatible)
   - Per-user agent endpoint and API key (from user doc); no env vars required. Base URL default in `lib/chat-client/providers/digitalocean.js`.

2. **DigitalOcean GenAI REST API v2**
   - Environment Variables: `DIGITALOCEAN_TOKEN`, `DO_REGION`, `DO_PROJECT_ID`, `DO_EMBEDDING_MODEL_ID`
   - Base URL: `https://api.digitalocean.com`

3. **DigitalOcean Spaces (S3-compatible API)**
   - Environment Variables: `DIGITALOCEAN_AWS_ACCESS_KEY_ID`, `DIGITALOCEAN_AWS_SECRET_ACCESS_KEY`; endpoint and bucket from code (DO_REGION / NEW-AGENT.txt)
   - Uses AWS SDK S3Client for operations

### Not Used:
- `DIGITALOCEAN_BASE_URL` - Not referenced in codebase
- `DATABASE_URL` - Not referenced in codebase (uses CLOUDANT_* variables instead)

