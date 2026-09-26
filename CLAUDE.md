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
Line counts as of v1.6.4 (September 2026); whole repo ≈ 71,000 lines (`src/` 39,000 + `server/` 31,600 + `scripts/` 645), plus `tests/` 3,400.
- `server/index.js` — main backend (~15,200 lines)
- `src/components/ChatInterface.vue` — wizard, chat UI (~10,500 lines)
- `src/components/MyStuffDialog.vue` — Workbook: saved files, patient summary, lists, privacy filter (~8,300 lines)
- `src/App.vue` — main frontend entry, auth, welcome page (~4,300 lines)
- `src/components/Lists.vue` — deterministic lists, meds verification (~3,400 lines)
- `server/routes/groups.js` — group registry, membership, relay, outside requests (~4,300 lines)
- `server/routes/files.js` — file upload, PDF parsing (~3,100 lines)
- `server/routes/auth.js` — passkey auth, agent provisioning (~1,700 lines)
- `server/routes/chat.js` — chat providers, deep link resolution (~1,000 lines)
- `server/credits.js` — credits ledger, Stripe webhook (~440 lines)
- `server/routes/policies.js` — sharing-policy cards, vocabulary, evaluator (~300 lines)
- `server/records-pipeline.js` — derived view of a user's records journey (~180 lines)
- `server/edition.js` — edition switch (`MAIA_EDITION`) and feature registry (~190 lines)
- `server/edition-routes.js` — every route's feature, and the /api feature gate. **Adding a route? Add it to `ROUTE_FEATURES`**, or `tests/backend/edition-routes.test.js` fails
- `server/utils/api-guard.js` — /api account-access guard: the session decides the account (~100 lines)
- `server/routes/gnap.js` + `server/gnap/` — GNAP personal AS (direct route): RFC 9421 signatures, grants, RS; reference client `scripts/gnap-client.mjs`
- `server/gnap/documents.js` + `server/routes/received.js` — documents others add (P9): descriptor and type checks, holds sealed to the patient's folder key, limits; the folder key and the holds for the patient's browser (`src/utils/folderKey.ts`, `src/utils/received.ts` write them to `Received/`)
- `server/routes/gnap-group.js` + `server/gnap/group.js` — GNAP group routing: the group's endpoint, fan-out of signed copies with a group attestation, sealed answers (the member's side is `receiveGroupCopy` in `routes/gnap.js`)
- `src/gnap/` + `src/components/RequestPage.vue` / `GroupRequestPage.vue` — the browser GNAP client and the requester's pages at `/r/<asId>` and `/g/<groupId>/request` (mounted by `main.ts`); `RequestsPanel.vue` is the patient's side
- `Documentation/group_requests.md` — design of the Personal AS edition (phases P0–P12); `public/MAIA_Request_Map.html` (who runs what, how requests travel) and `public/MAIA_Group_Network.html` (how hosts, groups and people connect), served at those paths and linked from the welcome page — update them when a request path changes

## Environment Variables

The goal is to minimize secrets. Several values are **derived from the DO token** at startup so they don't need separate env vars.

### Production (DO App Platform) — required env vars

| Variable | Purpose |
|---|---|
| `DIGITALOCEAN_TOKEN` | Master secret. Used for DO API calls, to derive CouchDB password, session secret, admin passphrase, create DO Inference Model Access Key, and auto-discover/create the OpenSearch cluster. |
| `SPACES_AWS_ACCESS_KEY_ID` | S3-compatible access key for DO Spaces (cannot be derived from DO token — Spaces uses the separate S3 API). |
| `SPACES_AWS_SECRET_ACCESS_KEY` | S3-compatible secret key for DO Spaces. |
| `PUBLIC_APP_URL` | The public URL of the app (e.g. `https://test.agropper.xyz`). Controls secure cookies, trust proxy, and passkey origin. |

Optional: `MAIA_EDITION` = `full` (default) or `personal-as`, read once at startup (see `Documentation/Environment.md`).

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
- `npm test` runs every vitest suite; `npm run test:backend` runs `tests/backend/`. Most suites use in-memory fakes. `auth`, `cloudant` and `health` need a local CouchDB (Docker, `admin`/`adminpass` at `localhost:5984`).
- Edition work: new backend tests run under both editions (`describe.each(EDITIONS)` with `setEditionForTests`), and `full` must behave exactly as before.
- supertest: pass `await serve(app)` (`tests/helpers/serve.js`), not the bare app. `request(app)` listens on `[::]` but connects to `127.0.0.1`, and on macOS another program's `127.0.0.1` listener can answer instead (intermittent 404s).
- UI flows still need manual testing in the running app.
- Build check: `npm run build` — the DO deploy runs `vue-tsc && vite build`, and `vue-tsc` fails on things vite tolerates (e.g. TS6133 unused declarations). `npx vite build` alone is NOT sufficient.
