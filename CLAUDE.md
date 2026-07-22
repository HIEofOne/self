# Claude Code Project Instructions

## Repository
- **Primary remote:** `origin` = `HIEofOne/self` (all PRs and pushes go here)
- **Upstream fork:** `upstream` = `agropper/self` (do NOT push or create PRs here without explicit permission)
- When creating PRs, always use `--repo HIEofOne/self`

## Branching
- Feature branches: `claude/<short-description>`
- PRs target `main`

## Version Bumping
- A pre-commit hook (`scripts/pre-commit-version-bump.sh`) auto-increments the patch version in `package.json` when `server/` or `src/` files are staged
- Do not manually bump versions unless doing a minor or major release

## Stack
- **Frontend:** Vue 3 (SFC, Composition API), Vite, TypeScript for utilities
- **Backend:** Express.js (ESM), CouchDB/Cloudant, DigitalOcean GenAI agents + Spaces (S3)
- **Auth:** Passkey/WebAuthn with temporary (no-passkey) user fallback
- **Local storage:** File System Access API (primary, Chrome 122+), PouchDB/IndexedDB (fallback)

## Key files
Line counts as of v1.5.79 (July 2026); whole repo ≈ 62,000 lines (`src/` 34,216 + `server/` 27,378 + `scripts/` 645).
- `server/index.js` — main backend (~14,100 lines)
- `src/components/ChatInterface.vue` — wizard, chat UI (~10,000 lines)
- `src/components/MyStuffDialog.vue` — Workbook: saved files, patient summary, lists, privacy filter (~7,900 lines)
- `src/App.vue` — main frontend entry, auth, welcome page (~4,000 lines)
- `src/components/Lists.vue` — deterministic lists, meds verification (~3,400 lines)
- `server/routes/files.js` — file upload, PDF parsing (~3,100 lines)
- `server/routes/groups.js` — group registry, membership, messaging (~3,100 lines)
- `server/routes/auth.js` — passkey auth, agent provisioning (~1,600 lines)
- `server/routes/chat.js` — chat providers, deep link resolution (~750 lines)

## Environment Variables

The goal is to minimize secrets. Several values are **derived from the DO token** at startup so they don't need separate env vars.

### Production (DO App Platform) — required env vars

| Variable | Purpose |
|---|---|
| `DIGITALOCEAN_TOKEN` | Master secret. Used for DO API calls, to derive CouchDB password, session secret, admin passphrase, create DO Inference Model Access Key, and auto-discover/create the OpenSearch cluster. |
| `SPACES_AWS_ACCESS_KEY_ID` | S3-compatible access key for DO Spaces (cannot be derived from DO token — Spaces uses the separate S3 API). |
| `SPACES_AWS_SECRET_ACCESS_KEY` | S3-compatible secret key for DO Spaces. |
| `PUBLIC_APP_URL` | The public URL of the app (e.g. `https://test.agropper.xyz`). Controls secure cookies, trust proxy, and passkey origin. |

Chat provider keys (`ANTHROPIC_API_KEY`, `CHATGPT_API_KEY`, `DEEPSEEK_API_KEY`) are **not needed** in production. All three providers are routed through DO Serverless Inference automatically. `GEMINI_API_KEY` is optional (Gemini is not available on DO Inference).

### Derived from DO token (no env var needed)

| Value | Derivation |
|---|---|
| CouchDB password | `HMAC-SHA256(token, 'maia-couchdb-admin')` base64url, first 32 chars |
| Session secret | `HMAC-SHA256(token, 'maia-session-secret')` base64url, first 32 chars |
| Admin passphrase | DO token used directly (pasted once at first admin login, then passkey takes over) |
| Admin username | Hard-coded to `admin` |
| CouchDB username | Hard-coded to `admin` |
| DO Inference key | Created via DO API, cached in CouchDB `maia_config/do_inference_key` |
| OpenSearch database ID | Discovered via DO API (`GET /v2/databases?engine=opensearch`), or created if none exists. Cached in CouchDB `maia_config/opensearch_database_id`. One cluster per account enforced. |
| Port | Defaults to `3001`; DO App Platform sets `PORT` automatically |

### Local development — `.env` file

| Variable | Typical value | Purpose |
|---|---|---|
| `PUBLIC_APP_URL` | `http://localhost:5173` | Local Vite dev server |
| `CLOUDANT_URL` | `http://localhost:5984` | Local Docker CouchDB |
| `DIGITALOCEAN_TOKEN` | `dop_v1_...` | Required for DO API calls |
| `SPACES_AWS_ACCESS_KEY_ID` | `DO00...` | Same as production |
| `SPACES_AWS_SECRET_ACCESS_KEY` | `f1Ru...` | Same as production |

For detailed environment documentation, see `Documentation/Environment.md`.

### DO token rotation warning

If the DO token is rotated, the derived CouchDB password changes but the CouchDB droplet still has the old one. Update the CouchDB admin password via `PUT /_node/_local/_config/admins/admin` or SSH to the droplet. Delete `maia_config/do_inference_key` and `maia_config/opensearch_database_id` in CouchDB so they are re-created on next startup. Session secret rotation logs out all users (they re-authenticate with passkeys).

## Testing
- No automated test suite currently; test manually via the running app
- Build check: `npm run build` — the DO deploy runs `vue-tsc && vite build`, and `vue-tsc` fails on things vite tolerates (e.g. TS6133 unused declarations). `npx vite build` alone is NOT sufficient.
