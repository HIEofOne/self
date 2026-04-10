# MAIA (Medical AI Assistant)

Patients increasingly receive medical advice from both public AI and clinicians. That advice improves when it can reference the complete record across providers, but patients are understandably reluctant to upload hundreds of pages of sensitive records to public AI, and clinicians rarely have the time to review everything. In practice, many decisions end up based on a brief chat rather than the full record.

MAIA introduces a patient-controlled Private AI agent that sits between a patient's complete health record and public AIs. Patients can see and edit chats, share them with clinicians, and manage current medications, a patient summary, a diary of symptoms and observations, relevant references, and a privacy filter that pseudonymizes names before sending anything to public AI.

### Trust Model

Unlike Public AI agents, MAIA's trust model does not bundle the AI model policies with the AI hosting policies. The host running the service (DigitalOcean in this implementation) is to be trusted to run this open source code and open source Private AI without modification. The publisher of the open source code and any verifier also needs to be trusted for the integrity of the code they release. Independent verification of code and host is facilitated by the open source design of MAIA.

A key design goal is that the MAIA software author does not need access to anyone's private data. A verifier, even an excellent coding AI, can help confirm the code has no back doors, but they cannot attest to the operational access of whoever provisions a patient's account. This is why MAIA supports user-driven provisioning without third-party access.

When running MAIA, use your own credit card to pay for hosting. If someone else pays for the service, they control the billing account and can likely control access to your data even if the MAIA code has been verified free of back doors.

---

## Top 19 User Features

1. **Get Started** simple, passwordless entry for new users with self-provisioning wizard.
2. **Passkey registration** optional to create web-accessible account.
3. **Local-only mode** (no passkey or password required) for private devices.
4. **Sign Out** with optional local snapshot for deleted account restoration.
5. **Setup Wizard** with multi‑page guidance and feature review.
6. **My Stuff** dialog for private AI agent instruction, document and privacy management.
7. **Saved Files** list with KB inclusion checkboxes and indexing status.
8. **Upload file** from paperclip / file picker.
9. **PDF Viewer** modal with paging.
10. **Text/Markdown Viewer** with page links for source confirmation.
11. **My Lists** linked to PDF source pages.
12. **Create Categorized Lists** from Apple Health file.
13. **AI-assisted Current Medications** patient-reconciled and verified.
14. **Generate Patient Summary** with editing and verification.
15. **Switch AI provider** dropdown (Private AI + public models).
16. **Saved Chats** to local computer and as deep links.
17. **Open deep link** as guest (isolated view).
18. **Privacy Filtering** substitutes all names in a chat for pseudonymity.
19. **Admin Account** and user management page.
---

## Key User Account Provisioning Steps

1. **Local folder registration** creates the user document and session.
2. **Agent provisioning** (admin-triggered or auto in some flows):
   - Creates agent, waits for deployment, stores endpoint + API key.
3. **File(s) upload**:
   - Records are prepared for access by the knowledge base (KB)
4. **KB indexing**:
   - Uploaded files are indexed into the knowledge base for Private AI retrieval.
5. **KB attachment**:
   - Knowledge base is automatically attached to the agent when ready.
6. **Current Medications / Patient Summary**:
   - Generated and verified through My Lists and Patient Summary flows.

---

## Documentation

- [User Guide](public/User_Guide.html) — end-user guide to MAIA features
- [Environment & Hosting](Documentation/Environment.md) — configuration, secrets, DO token derivation
- [Account Lifecycle & Wizards](Documentation/Wizards.md) — welcome, setup, sign-out, destroy, and restore flows

---

## Hosting Environment

- **App Platform**: Runs the frontend + Node server.
- **Droplet with Dockerized CouchDB**: Cloudant-compatible data store for users, chats, sessions, and audit log. Auto-provisioned when `PUBLIC_APP_URL` uses HTTPS (see [Environment.md](Documentation/Environment.md)).
- **GenAI Agent**: DigitalOcean Private AI agent per user.
- **Knowledge Base**: DigitalOcean KB per user, indexed from the Spaces folder datasource.
- **OpenSearch 2 Database**: Clinical notes indexing/search store with embeddings.
- **Spaces File Store**: S3-compatible storage for all user files and lists.

---

## Local Development

```bash
npm install
# Create .env with required variables — see Documentation/Environment.md
npm run dev       # Vite (frontend)
npm run start     # Node (backend)
```

Health check:

```bash
curl http://localhost:3001/health
```
