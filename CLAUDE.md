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
- `server/index.js` — main backend (~9,800 lines)
- `src/App.vue` — main frontend entry, auth, welcome page
- `src/components/ChatInterface.vue` — wizard, chat UI
- `src/components/MyStuffDialog.vue` — saved files management
- `server/routes/auth.js` — passkey auth, agent provisioning
- `server/routes/files.js` — file upload, PDF parsing
- `server/routes/chat.js` — chat providers, deep link resolution

## Testing
- No automated test suite currently; test manually via the running app
- Build check: `npx vite build`
