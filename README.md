# MAIA (Medical AI Assistant)

Patients increasingly receive medical advice from both public AI and clinicians. That advice improves when it can reference the complete record across providers, but patients are understandably reluctant to upload hundreds of pages of sensitive records to public AI, and clinicians rarely have the time to review everything. In practice, many decisions end up based on a brief chat rather than the full record.

MAIA introduces a patient-controlled Private AI agent that sits between a patient's complete health record and public AIs. Patients can see and edit chats, share them with clinicians, and manage current medications, a patient summary, a diary of symptoms and observations, relevant references, and a privacy filter that pseudonymizes names before sending anything to public AI.

### Trust Model

MAIA reduces the number of parties that must be trusted with private information. The host running the service (DigitalOcean in this implementation) must be trusted to run the code without modification. The publisher of the open source code and any verifier also need to be trusted for the integrity of the code they release or audit.

The design goal is that the author does not need access to anyone's private data. A verifier, even an excellent coding AI, can help confirm the code has no back doors, but they cannot attest to the operational access of whoever provisions a patient's account. This is why MAIA supports user-driven provisioning without third-party assistance.

When running MAIA, use your own credit card to pay for hosting. If someone else pays for the service, they control the billing account and can likely control access to your data even if the code has been verified.

---

## Top 20 User Features

1. **Get Started** simple, passwordless entry for new users with self-provisioning wizard.
2. **Passkey registration** optional to create web-accessible account.
3. **Local only/no‑passkey or password mode** for private devices.
4. **Sign Out** with optional local snapshot for deleted account restoration.
5. **Setup Wizard** with multi‑page guidance and feature review.
6. **My Stuff** dialog for private AI agent instruction, document and privacy management.
7. **Saved Files** list with KB inclusion checkboxes.
8. **Saved Files** indexing status and KB summary.
9. **Upload file** from paperclip / file picker.
10. **PDF Viewer** modal with paging.
11. **Text/Markdown Viewer** with page links for source confirmation.
12. **My Lists** linked to PDF source pages.
13. **Create Categorized Lists** from Apple Health file.
14. **AI-assisted Current Medications** patient-reconciled and verified.
15. **Generate Patient Summary** with editing and verification.
16. **Switch AI provider** dropdown (Private AI + public models).
17. **Saved Chats** to local computer and as deep links.
18. **Open deep link** as guest (isolated view).
19. **Privacy Filtering** substitutes all names in a chat for pseudonymity.
20. **Admin Account** and user management page.
---

## Key User Account Provisioning Steps

1. **Passkey registration** creates the user document and session.
2. **Agent provisioning** (admin-triggered or auto in some flows):
   - Creates agent, waits for deployment, stores endpoint + API key.
3. **File import**:
   - Uploads land in root, metadata stored in Cloudant.
4. **KB build and indexing**:
   - Files are moved into `userId/<kbName>/`.
   - Indexing starts on the folder datasource.
   - Polling persists status to `userDoc.kbIndexingStatus`.
5. **KB attachment**:
   - Automatically attaches when agent is ready and indexing is complete.
6. **Current Medications / Patient Summary**:
   - Generated and verified through My Lists and Patient Summary flows.

---

## Hosting Configuration Notes (Key Env Vars)

### Passkeys / WebAuthn (single env)
- `PUBLIC_APP_URL`  
  **Single source:** passkey origin and allowed origins are derived from this; RPID is derived as the apex domain (e.g. `https://maia.adriang.xyz` → origin `https://maia.adriang.xyz`, RPID `adriang.xyz`). Used for deep links and app URL.
- `PASSKEY_RPID` (optional)  
  Override RPID if you need a different domain scope (e.g. full hostname instead of apex).
- `PASSKEY_ORIGINS` (optional)  
  Comma-separated allowlist if you need more than the single derived origin.

### Cloudant (users, sessions, audit log)
- `CLOUDANT_URL`, `CLOUDANT_USERNAME`, `CLOUDANT_PASSWORD`  
  Required for user docs, sessions, and audit logs.

### CouchDB Droplet (optional, self-hosted database)
When `USE_COUCHDB_DROPLET=true`, the server auto-creates a DigitalOcean droplet (`ubuntu-s-1vcpu-1gb-tor1-01`) with Dockerized CouchDB and sets `CLOUDANT_*` from it. Credentials are stored in Spaces at `couchdb/credentials.json` so they survive redeploys. Requires `DIGITALOCEAN_TOKEN`, `DIGITALOCEAN_AWS_ACCESS_KEY_ID`, `DIGITALOCEAN_AWS_SECRET_ACCESS_KEY` (bucket name is from NEW-AGENT.txt).

### DigitalOcean GenAI (agents, KBs, indexing)
- `DIGITALOCEAN_TOKEN`  
  Auth for DO GenAI REST API.
- `DO_REGION`, `DO_PROJECT_ID`  
  Required to create agents and KBs.
- `DO_EMBEDDING_MODEL_ID` (optional)  
  Overrides default embedding model. OpenSearch database UUID is auto-discovered via the DO API and cached in CouchDB.

### DigitalOcean Spaces (file storage)
- Bucket name is fixed in code (see NEW-AGENT.txt; `getSpacesBucketName()`).
- `DIGITALOCEAN_AWS_ACCESS_KEY_ID`, `DIGITALOCEAN_AWS_SECRET_ACCESS_KEY`  
  S3-compatible access to Spaces (endpoint derived from `DO_REGION`).

### OpenSearch (KB creation only)
- The OpenSearch cluster is auto-discovered via the DO API and created if needed at first KB creation. One cluster per account is enforced. No env var required.

### App + Email
- **`PUBLIC_APP_URL`** — Canonical app URL (also drives passkey config; see Passkeys above).
- `PORT` — Server listen port.

---

## Hosting Environment

- **App Platform**: Runs the frontend + Node server.
- **Droplet with Dockerized CouchDB**: Cloudant-compatible data store for users, chats, sessions, and audit log. Can be auto-provisioned via `USE_COUCHDB_DROPLET=true` (see CouchDB Droplet env vars).
- **GenAI Agent**: DigitalOcean Private AI agent per user.
- **Knowledge Base**: DigitalOcean KB per user, indexed from the Spaces folder datasource.
- **OpenSearch 2 Database**: Clinical notes indexing/search store.
- **Spaces File Store**: S3-compatible storage for all user files and lists.

---

## Local Development

```bash
npm install
cp .env.example .env
npm run dev       # Vite (frontend)
npm run start     # Node (backend)
```

Health check:

```bash
curl http://localhost:3001/health
```
