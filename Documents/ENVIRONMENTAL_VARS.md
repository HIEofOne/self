# MAIA environmental variables and how they are used

## Not really secrets

**NODE_ENV=development**  
Controls runtime mode (e.g. `production`). Used for CORS behavior, session cookie `secure` flag, and whether to serve the built frontend; production builds are detected even if `NODE_ENV` is unset when a `dist` folder exists.
**Why do we need NODE_ENV at all?** So the server can turn on production behavior (stricter CORS, secure cookies, serving the built frontend) instead of dev behavior; without it we’d have to guess from the presence of `dist` only.

**PUBLIC_APP_URL=https://maia.adriang.xyz**  
Canonical public URL of the app. Drives passkey origin/rpID, CORS allowed origins, and redirect/frontend URLs in provisioning and auth flows. Single source of truth for “where is this app?” (with optional `PASSKEY_RPID` override).
**When do we need a PASSKEY_RPID override?** When the passkey “relying party ID” must differ from the hostname derived from `PUBLIC_APP_URL` (e.g. you serve the app at `app.example.com` but want rpID `example.com`, or you use a custom domain that doesn’t match the default slice).

**PORT=3001**  
HTTP port the Node server listens on. Read from NEW-AGENT.txt (## App Platform Settings) when set there; otherwise from env; default 3001. Vite dev proxy uses this when proxying API requests to the backend.

**USE_COUCHDB_DROPLET=true**  
When `'true'`, the app uses a CouchDB instance on a DigitalOcean droplet (discovered via DO API) instead of `CLOUDANT_*`; Cloudant client is configured with the droplet’s URL. When false, Cloudant is configured from `CLOUDANT_URL` (and related env).

**DO_REGION=tor1**  
DigitalOcean region (e.g. `tor1`). Read from NEW-AGENT.txt (## App Platform Settings) when set there; otherwise from env; default `tor1`. Used by the DO client and for Spaces/GenAI region selection.
**Do we need SPACES_REGION?** It is used as a fallback in `server/utils/storage-config.js` and in one place in `server/index.js` (before `DO_REGION`). If you set `DO_REGION`, you don’t need `SPACES_REGION`; it’s only for environments that already use the older Spaces-specific name.

**DO_EMBEDDING_MODEL_ID=**  
Optional. DigitalOcean GenAI embedding model UUID used when creating new knowledge bases. **Preferred:** set the embedding model by **display name** in `NEW-AGENT.txt` under `## Embedding model (Knowledge base)` as `embedding_model: GTE Large EN v1.5` (or the name shown in the DO dashboard). At startup / first KB creation the app uses `DIGITALOCEAN_TOKEN` to call the GenAI models API, finds the model whose name matches, and uses its UUID for KB creation. **Override:** set `DO_EMBEDDING_MODEL_ID` in `.env` to a model UUID to skip name resolution. If neither is set, the app does not pass an embedding model and DO may use its default.

**Hard-coded values:** The only value that affects normal app behavior is the default agent base URL in `lib/chat-client/providers/digitalocean.js` (e.g. `…agents.do-ai.run/api/v1`). That default is only used if no `baseURL` is passed; in normal use the server always passes the user’s `agentEndpoint` from the DB, so each user’s Private AI uses their own endpoint. Scripts under `scripts/` show example UUIDs in their usage/error messages; those are examples only, not used at runtime.

---

## Application Secrets

**ADMIN_USERNAME=**  
User ID treated as the admin (e.g. `maia-admin`). Used in auth and several server routes to allow unauthenticated access for this user and to mark admin sessions; compared to `req.session.userId` and to user docs’ `userId`.

**ADMIN_SECRET=**  
Secret required for admin passkey registration and login. If set, unauthenticated admin routes require this (e.g. in request body); auth routes check it and return `ADMIN_SECRET_REQUIRED` or `ADMIN_SECRET_INVALID` when missing or wrong. Leave empty to disable admin-secret gating.

**SESSION_SECRET=**  
Secret used to sign session cookies (express-session). Should be a long random string in production; defaults to a placeholder if unset.
**Why is this needed?** express-session uses it to cryptographically sign the session cookie so the server can detect tampering; without a strong secret, anyone could forge a session cookie and impersonate a user.

---

## Optional access keys to public AI

**ANTHROPIC_API_KEY=**  
API key for the Anthropic (Claude) chat provider. Used when the user selects Anthropic in the chat UI; the server passes it to the chat provider that calls Anthropic’s API.

**DEEPSEEK_API_KEY=**  
API key for the DeepSeek chat provider. Used when the user selects DeepSeek; the server uses it to authenticate requests to DeepSeek’s API.

**GEMINI_API_KEY=**  
API key for the Google Gemini chat provider. Used when the user selects Gemini; the server uses it for Gemini API calls.

**CHATGPT_API_KEY=**  
API key for the OpenAI/ChatGPT chat provider. The server uses `OPENAI_API_KEY` or `CHATGPT_API_KEY` when the user selects the ChatGPT provider for public-AI chat.

---

## Essential secrets that should be internal to the DO account owner

**DIGITALOCEAN_PERSONAL_API_KEY=**  
**No longer used.** Private AI (digitalocean) is available only when the user’s GenAI agent is deployed (Stage 1). The server uses the per-user agent API key from the user document (via `getOrCreateAgentApiKey`), not a global env key. You can remove this from `.env` and cloud environment variables.

**DO_PROJECT_ID=**  
Optional. DigitalOcean project UUID that owns agents/KBs. When unset, the app discovers it at runtime via the DO API: it uses the account’s default project (GET /v2/projects/default) or the first project from the list. Set this in `.env` only if you need to pin a specific project; otherwise leave it unset and the app will resolve it using `DIGITALOCEAN_TOKEN`.

**DIGITALOCEAN_TOKEN=**  
DigitalOcean API token (OAuth or PAT). Used by the DigitalOcean client for management APIs: agents, knowledge bases, indexing, Spaces, and (when `USE_COUCHDB_DROPLET` is true) CouchDB droplet discovery. Required for provisioning and backend DO operations.
**Is this available via API?** You create it in the DigitalOcean control panel (not “from” an API—you use it to call the API). Create a Personal Access Token: [DigitalOcean – API Tokens](https://docs.digitalocean.com/reference/api/create-personal-access-token/) (or in the control panel: API → Tokens / Generate New Token). Use that token as `DIGITALOCEAN_TOKEN`.

## Spaces configuration endpoints and secrets

The Spaces endpoint is derived from `DO_REGION` (or `SPACES_REGION`) as `https://<region>.digitaloceanspaces.com` in `server/utils/storage-config.js` (`getSpacesEndpoint()`). No env var needed. The bucket name is defined in NEW-AGENT.txt and provided by `getSpacesBucketName()` in code; no env var needed.

**DIGITALOCEAN_AWS_ACCESS_KEY_ID=**  
Spaces access key (S3-compatible). Used with `DIGITALOCEAN_AWS_SECRET_ACCESS_KEY` and the derived Spaces endpoint (`getSpacesEndpoint()`) to build S3 clients for the Spaces bucket (name from `getSpacesBucketName()`). **Aliasing:** If you set `SPACES_AWS_ACCESS_KEY_ID` instead, `normalizeStorageEnv()` in `storage-config.js` copies it into `DIGITALOCEAN_AWS_ACCESS_KEY_ID` at startup so the rest of the app (which reads the DO name) still works.

**DIGITALOCEAN_AWS_SECRET_ACCESS_KEY=**  
Spaces secret key (S3-compatible). Used with the access key and endpoint for all Spaces/S3 client configuration. **Aliasing:** If you set `SPACES_AWS_SECRET_ACCESS_KEY` instead, `normalizeStorageEnv()` copies it into `DIGITALOCEAN_AWS_SECRET_ACCESS_KEY` at startup.

## OpenSearch (DO-managed, KB creation only)

OpenSearch is provided by DigitalOcean; one cluster per account, shared by all knowledge bases. The app uses only the **database UUID** (for KB creation so new KBs attach to the existing cluster). No direct OpenSearch access or credentials.

The database UUID is **auto-discovered** from the DO API (`GET /v2/databases?engine=opensearch`) and cached in CouchDB (`maia_config/opensearch_database_id`). If no cluster exists, one is created automatically at first KB creation. The server enforces a maximum of one OpenSearch cluster per account.

**Legacy:** `OPENSEARCH_URL` is still accepted as a fallback (the UUID is parsed from the dashboard URL path) but is no longer required.
