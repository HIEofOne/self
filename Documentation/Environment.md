# MAIA Running Environment

MAIA runs on DigitalOcean infrastructure. A single **DigitalOcean API Token** (`DIGITALOCEAN_TOKEN`) serves as the master secret from which most other credentials and access tokens are derived.

---

## DigitalOcean Token Derivations

The DO token is used directly for all DO API calls (App Platform, Droplets, Spaces management, GenAI agents, knowledge bases, serverless inference). Several internal secrets are derived from it using HMAC-SHA256, so they never need to be stored as separate environment variables:

| Derived Value | Derivation | Purpose |
|---|---|---|
| CouchDB admin password | `HMAC-SHA256(token, 'maia-couchdb-admin')` base64url, first 32 chars | Authenticates to the CouchDB database |
| Session secret | `HMAC-SHA256(token, 'maia-session-secret')` base64url, first 32 chars | Signs Express session cookies |
| Admin passphrase | DO token used directly | Pasted once at first admin login, then passkey takes over |
| DO Inference Model Access Key | Created via `POST /v2/gen-ai/models/api_keys`, cached in CouchDB | Authenticates chat requests to all public AI providers |

The CouchDB username and admin username are both hard-coded to `admin`.

**Token rotation warning:** If the DO token is rotated, the derived CouchDB password changes but the CouchDB droplet still has the old one. Before or after rotating, update the CouchDB admin password via the CouchDB config API (`PUT /_node/_local/_config/admins/admin`) or via SSH to the droplet. Session secret rotation simply logs out all users (they re-authenticate with passkeys). The cached inference key in CouchDB (`maia_config/do_inference_key`) will also need to be deleted so a new one is created on next startup.

---

## App Platform

The application runs as a single **DigitalOcean App Platform** web service:

- **Runtime:** Node.js (Express.js backend + Vue 3 SPA frontend)
- **Build:** `npx vite build` produces the `dist/` folder; Express serves it as static files in production
- **Port:** App Platform sets `PORT` automatically; defaults to `3001` locally
- **HTTPS:** App Platform terminates TLS at its load balancer and proxies to the app over HTTP. The app sets `trust proxy` when `PUBLIC_APP_URL` starts with `https://` so secure cookies work correctly behind the reverse proxy.
- **Secure cookies:** Enabled automatically when `PUBLIC_APP_URL` starts with `https://`

---

## CouchDB

### Cloud (DO Droplet)

When `PUBLIC_APP_URL` starts with `https://` (i.e., a cloud deployment), the server automatically provisions a DigitalOcean Droplet running CouchDB 3 in Docker:

- **Droplet:** `s-1vcpu-1gb` Ubuntu 22.04 in `tor1` region
- **Container:** `couchdb:3` with persistent volumes
- **Port:** 5984
- **Credentials:** `admin` / derived password (see token derivations above)
- **Startup:** The server retries the CouchDB connection up to 10 times at 30-second intervals while the droplet warms up

### Local (Docker)

For local development, CouchDB runs in a Docker container:

```
docker run -d --name couchdb -p 5984:5984 \
  -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=adminpass \
  couchdb:3
```

- **URL:** `http://localhost:5984`
- **Credentials:** `admin` / `adminpass` (hard-coded defaults when no DO token is present)

### Databases

| Database | Purpose |
|---|---|
| `maia_sessions` | Express session store |
| `maia_users` | User documents (profile, agent info, KB status, indexing state) |
| `maia_audit_log` | Audit trail |
| `maia_chats` | Saved chat conversations |
| `maia_config` | Server configuration (cached DO Inference key, OpenSearch database ID) |

---

## Vector Database (OpenSearch)

A managed **DigitalOcean OpenSearch** cluster provides vector search for knowledge base queries:

- **Provisioning:** Automatically discovered or created via the DO API at first KB creation. One cluster per account — the server enforces this by checking existing clusters before creating.
- **Access:** The database UUID is resolved via the DO API (`GET /v2/databases?engine=opensearch`), cached in CouchDB (`maia_config/opensearch_database_id`), and used for KB creation via the DO GenAI endpoints.
- **Usage:** Agents query the OpenSearch-backed knowledge base when answering user questions
- **Legacy:** The `OPENSEARCH_URL` env var is still supported as a fallback but is no longer required.

---

## Agents

Each user gets a **DigitalOcean GenAI Agent** provisioned during setup:

- **Model:** `openai-gpt-oss-120b` (DO-hosted open-source model, selected via `DO_MODEL_ID` env var or auto-detected from the `/v2/gen-ai/models` API)
- **Endpoint:** Each agent has a unique endpoint (e.g., `https://<id>.agents.do-ai.run/api/v1`)
- **API Key:** Per-user agent API keys are created and stored in the user's CouchDB document
- **Knowledge Base:** Each agent is attached to a user-specific knowledge base for RAG (retrieval-augmented generation)

---

## Spaces Bucket and Folders

File storage uses a **DigitalOcean Spaces** bucket (S3-compatible):

- **Bucket name:** `maia`
- **Authentication:** `SPACES_AWS_ACCESS_KEY_ID` and `SPACES_AWS_SECRET_ACCESS_KEY` (S3-compatible credentials, cannot be derived from the DO token because Spaces uses the separate AWS S3 API)

### Folder Structure

Each user has three tiers of file storage within the bucket:

| Folder | Path Pattern | Purpose |
|---|---|---|
| Root | `{userId}/filename` | Temporary holding area for newly uploaded files |
| Archived | `{userId}/archived/filename` | Long-term storage; files preserved but not indexed |
| KB | `{userId}/{kbName}/filename` | Files uploaded to the knowledge base for AI indexing |

- `.keep` placeholder files are created to ensure empty directories exist
- Files are moved between folders as their status changes (e.g., root to archived after processing, or root to KB for indexing)

---

## Knowledge Bases

Each user's knowledge base is a **DigitalOcean GenAI Knowledge Base**:

- **Embedding model:** `gte-large-en-v1.5` (resolved from the `/v2/gen-ai/models?usecases=MODEL_USECASE_KNOWLEDGEBASE` API, or overridden with `DO_EMBEDDING_MODEL_ID`)
- **Backed by:** The shared OpenSearch cluster
- **Indexing:** Files in the KB folder are indexed asynchronously; the server polls the DO API for completion
- **Status tracking:** Indexing status (`phase`, `progress`, `indexed files`) is persisted in the user's CouchDB document

---

## Public AIs via Serverless Inference

When individual provider API keys are not set, MAIA routes public AI chat through **DigitalOcean Serverless Inference** at `https://inference.do-ai.run/v1`:

- **Authentication:** A Model Access Key is created automatically from the DO token at startup and cached in CouchDB
- **API format:** OpenAI-compatible (`/v1/chat/completions`)
- **Billing:** All usage billed through the single DO account

### Available Models

| Provider | Model ID on DO Inference | Default for |
|---|---|---|
| Anthropic Claude | `anthropic-claude-4.6-sonnet` | `anthropic` provider |
| OpenAI GPT | `openai-gpt-4o` | `openai` provider |
| DeepSeek | `deepseek-r1-distill-llama-70b` | `deepseek` provider |

### Gemini

Google Gemini is **not available** on DO Inference. To use Gemini, set `GEMINI_API_KEY` as a separate environment variable with a key obtained directly from Google AI Studio. When set, Gemini appears as an additional chat provider.

### Direct Provider Keys (Override)

If an individual provider key is set (e.g., `ANTHROPIC_API_KEY`), it takes precedence over DO Inference for that provider. This is useful for local development or if you prefer direct billing with a specific provider.

---

## Environment Variables

### Production (DO App Platform)

Only these variables are needed in production:

| Variable | Purpose |
|---|---|
| `PUBLIC_APP_URL` | The public URL (e.g., `https://test.agropper.xyz`). Determines secure cookies, trust proxy, and passkey origin. |
| `DIGITALOCEAN_TOKEN` | Master secret for all DO API calls and derived credentials. Also used to auto-discover/create the OpenSearch cluster. |
| `SPACES_AWS_ACCESS_KEY_ID` | S3-compatible access key for DO Spaces. |
| `SPACES_AWS_SECRET_ACCESS_KEY` | S3-compatible secret key for DO Spaces. |

### Local Development

| Variable | Typical Value | Purpose |
|---|---|---|
| `PUBLIC_APP_URL` | `http://localhost:5173` | Local Vite dev server URL |
| `CLOUDANT_URL` | `http://localhost:5984` | Local Docker CouchDB |
| `DIGITALOCEAN_TOKEN` | `dop_v1_...` | Required for DO API calls (agents, spaces, inference) |
| `SPACES_AWS_ACCESS_KEY_ID` | `DO00...` | Same as production |
| `SPACES_AWS_SECRET_ACCESS_KEY` | `f1Ru...` | Same as production |

### Why the Variables Differ Between Local and Cloud

- **`PUBLIC_APP_URL`**: `http://localhost:5173` locally vs `https://...` in production. Controls secure cookies, trust proxy, and passkey configuration.
- **`CLOUDANT_URL`**: Points to local Docker CouchDB (`localhost:5984`). In production, the CouchDB droplet URL is set automatically by the provisioning code.
- **`PORT`**: Not needed as an env var. Defaults to 3001 locally; App Platform sets it automatically.

### Why Spaces Credentials Can't Be Derived from the DO Token

DigitalOcean Spaces uses the **S3-compatible API**, which requires its own access key and secret key pair. These are generated separately in the DO control panel (API > Spaces Keys) and are not related to the main DO API token. There is no API to create Spaces keys programmatically from the DO token.

---

## Setup Log Environment Info

Each **maia-setup-log.pdf** file includes the following environment information at the top:

| Field | Source |
|---|---|
| Generated | Current date and time |
| Version | App version from `package.json` |
| User | User ID |
| App URL | `window.location.origin` |
| Folder | Local folder name |
| Browser | Browser name, version, and OS (parsed from user agent) |
| Chat providers | Available providers with their model names (e.g., "DigitalOcean (openai-gpt-oss-120b), Anthropic (claude-opus-4-6)") |

This information helps diagnose issues by capturing the exact environment at the time of setup.
