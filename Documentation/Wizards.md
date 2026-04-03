# Account Provisioning, Destroy, and Restore

This document describes how new user setup, account destruction, and account
restoration work in MAIA, including known fragility points and architectural
issues that have caused recurring bugs.

---

## 1. Architecture Overview

Account lifecycle involves three systems that must stay in sync:

| System | What it stores | Source of truth? |
|--------|---------------|-----------------|
| **CouchDB** (`maia_users`) | User doc with `assignedAgentId`, `kbId`, `kbName`, `files[]`, `workflowStage` | For user metadata and file registry |
| **DigitalOcean API** | Agent (GenAI platform), Knowledge Base, Spaces (S3) files | For actual cloud resources |
| **Browser** | IndexedDB folder handle, localStorage `knownUsers`, sessionStorage flags, `maia-state.json` in local folder | For local/offline state |

The fundamental fragility is that these three systems are updated independently
by multiple code paths, with no transaction or saga pattern to ensure
consistency. A failure or race at any point leaves them out of sync.

---

## 2. New User Setup (Provisioning)

### Flow

1. **Welcome page** → user clicks "Get Started"
2. **`startTemporarySession`** (App.vue) → `POST /api/temporary-session` →
   creates CouchDB user doc, returns session cookie
3. **ChatInterface setup wizard** opens (`showAgentSetupDialog`)
4. User picks local folder → files scanned
5. Files uploaded via `POST /api/files/upload` with `isInitialImport=true`
6. **Agent created** by `/api/agent-setup-status` polling (see below)
7. **KB indexed** via `POST /api/update-knowledge-base`
8. Medications and Summary verified via AI
9. Wizard complete → `maia-state.json` and `.webloc` written to local folder

### Agent Creation During Setup

The agent is created by the **ChatInterface deployment poller**, not by the
wizard directly. On mount, ChatInterface starts polling
`GET /api/agent-setup-status` every few seconds. This endpoint calls
`ensureUserAgent()` if no `assignedAgentId` exists on the user doc, which
creates a new DO agent and saves the ID to the user doc.

**Key point**: Agent creation is a side effect of a polling endpoint, not an
explicit wizard step.

### KB Name Generation

When a user doc has no `kbName` field, `getKBNameFromUserDoc()` calls
`generateKBName(userId)` which produces a **timestamped** name:

```
{userId}-kb-{YYYYMMDD}{last6msDigits}
// Example: chloe73-kb-20260403885202
```

`ensureKBNameOnUserDoc()` then persists this generated name to the user doc.
The timestamp portion makes every generated name unique, which means **calling
`getKBNameFromUserDoc` twice without persisting produces two different names**.

---

## 3. Account Destruction

### Flow

1. User clicks Destroy on Welcome page
2. **`destroyTemporaryAccount`** (App.vue) → `POST /api/self/delete`
3. Server calls `deleteUserAndResources(userId)`:
   - Deletes Spaces files under `{userId}/`
   - Deletes KB by `userDoc.kbId` (if stored)
   - Deletes agent by `userDoc.assignedAgentId` + scans for orphans
   - Deletes session docs
   - Deletes user doc from CouchDB
4. Post-destroy verification logs (agent 404, KB 404, Spaces empty, doc gone)
5. Client clears IndexedDB snapshot, but keeps `knownUsers` entry (for restore)

### Fragility Points

**KB deletion relies on stored `kbId`**: If `kbId` was never saved to the user
doc (e.g. because the save got a 409 conflict), the KB in DigitalOcean becomes
orphaned. The destroy code does attempt to find the KB by name pattern as a
fallback, but the name lookup can race with validation code that clears the ID.

**Agent stored vs actual**: Before the orphan-scan fix, destroy only deleted
`userDoc.assignedAgentId`. If multiple agents were created (see below), the
extras were orphaned in DigitalOcean.

**User doc null guard**: If the user doc was already deleted (e.g. by a
previous destroy attempt), `deleteUserAndResources` crashes with
`Cannot read properties of null (reading 'assignedAgentId')` because it reads
the user doc early and doesn't guard against null throughout.

---

## 4. Account Restoration

### Flow

1. Welcome page shows destroyed user card with "GET STARTED" button
2. **`handleUserCardRestore`** (App.vue):
   a. `POST /api/account/recreate` → creates fresh user doc (no agent, no KB,
      no files, no kbName)
   b. Reads local state from folder handle (`maia-state.json`)
   c. `GET /api/cloud-health` → checks what exists in cloud
   d. Launches **RestoreWizard** with local state
3. **RestoreWizard** `executeRestore()` runs automatically:
   - Step 1: Upload files from local folder → `POST /api/files/upload` +
     `POST /api/files/register`
   - Step 2: Deploy agent → `POST /api/sync-agent?create=true`
   - Step 3: Index KB → `POST /api/update-knowledge-base`
   - Step 4-7: Restore medications, summary, chats, instructions

### The Restore Runs Instantly

The RestoreWizard auto-executes all steps as soon as it mounts. There is no
user interaction required. The entire flow completes in ~2 seconds (file upload
+ agent create + KB attempt + metadata restore). The user sees the wizard flash
briefly and then it's done — but with errors.

**The "too fast" perception is correct**: the wizard completes all steps
without waiting for any of them to actually propagate. The agent is created but
not yet deployed. The KB indexing fails. The user ends up in a half-restored
state.

---

## 5. Root Cause: KB Name Mismatch (NO_KB_FILES)

This is the central bug that has persisted across multiple fix attempts.

### What happens

1. `/api/account/recreate` creates a user doc with **no `kbName` field**
2. RestoreWizard calls `resolveKbName(uid)` which fetches `/api/user-status`
   → user doc has no `kbName` → falls back to simple `"{userId}-kb"`
3. Files are uploaded to Spaces under `{userId}/{userId}-kb/{file}`
4. Files are registered in user doc with `bucketKey: "{userId}/{userId}-kb/{file}"`
5. RestoreWizard calls `POST /api/update-knowledge-base`
6. Server calls `ensureKBNameOnUserDoc()` → `getKBNameFromUserDoc()` → no
   `kbName` stored → `generateKBName()` → creates **timestamped** name
   `"{userId}-kb-20260403885202"` and saves it to user doc
7. Server looks for files with prefix `{userId}/{userId}-kb-20260403885202/`
8. User doc files have prefix `{userId}/{userId}-kb/` → **NO MATCH → 400 NO_KB_FILES**

### Terminal proof

```
[files/register] ✅ Registered ... bucketKey=chloe73/chloe73-kb/GROPPER_ADRIAN_6KB.PDF
[KB-INDEX] Looking for files with prefix: chloe73/chloe73-kb-20260403885202/
[KB-INDEX] userDoc.files: ["chloe73/chloe73-kb/GROPPER_ADRIAN_6KB.PDF", ...]
[KB-INDEX] Files matching KB prefix: 0 []
```

### Why it works for new users

During new user setup, `ensureKBNameOnUserDoc` is called BEFORE file upload
(during agent provisioning or the first `/api/files/upload` call). So the
timestamped name gets persisted to the user doc first, and then the upload
uses that same name. The RestoreWizard's `resolveKbName` would also find the
stored `kbName` if it had been set.

### Fix required

Either:
- (a) RestoreWizard should call an endpoint to generate and persist the KB name
  BEFORE uploading files, so both upload and index use the same name
- (b) The server's `/api/update-knowledge-base` should accept a `kbName`
  parameter and use it instead of generating a new one
- (c) `/api/account/recreate` should generate and store `kbName` in the new
  user doc

Option (c) is simplest and most correct: the recreated user doc should have a
`kbName` from the start, just like a normally-provisioned user doc does.

---

## 6. Duplicate Agent Creation

### What happens

1. RestoreWizard calls `POST /api/sync-agent?create=true` → creates agent A,
   saves `assignedAgentId=A` to user doc
2. Meanwhile, ChatInterface mounts and starts polling
   `GET /api/agent-setup-status`
3. The polling endpoint finds no `assignedAgentId` (because the sync-agent
   save hasn't completed yet, or there was a 409 conflict) → calls
   `ensureUserAgent()` → creates agent B
4. Result: two agents in DigitalOcean, only one stored in user doc

### Terminal proof

```
[SYNC-AGENT] No agent found for chloe73, creating...
[AGENT] Deployment status for chloe73 (779e0f19...): STATUS_WAITING_FOR_DEPLOYMENT
                                        ^^^^^^^^ agent from polling
📝 Updating agent instructions for ... agent 78da697d...
                                              ^^^^^^^^ agent from sync-agent
[AGENT] Deployment status for chloe73 (78da697d...): STATUS_WAITING_FOR_DEPLOYMENT
                                        ^^^^^^^^ now polling finds this one too
```

### Why it happens

Three different code paths can create agents:
1. `POST /api/sync-agent` with `create=true` → calls `ensureUserAgent()`
2. `GET /api/agent-setup-status` polling → calls `ensureUserAgent()` if no
   `assignedAgentId`
3. `POST /api/temporary-session` during initial provisioning → calls
   `ensureUserAgent()`

All three use `ensureUserAgent()` which checks `userDoc.assignedAgentId`, but
they can race: if two requests read the user doc before either saves the new
agent ID, both will create an agent.

### Fix required

- RestoreWizard should suppress the ChatInterface agent-setup-status polling
  during restore, OR
- `ensureUserAgent` should use a mutex/lock per userId, OR
- The sync-agent endpoint should be the ONLY path that creates agents during
  restore, with polling disabled until restore is complete

---

## 7. Other Issues

### Webloc file missing after restore

The RestoreWizard's completion handler writes a generic `maia.webloc` instead
of the personalized `maia-for-{patientName}-as-{userId}.webloc`. The original
wizard writes the personalized version during `handleWizardComplete`. The
restore path needs to replicate this.

### My Lists tab reloading (regression)

After restore, the `process-initial-file` endpoint is called repeatedly (10+
times in the terminal log) for the same Apple Health file. This suggests a
watcher or polling loop is re-triggering the file processing, likely because
the `initialFile` field on the user doc keeps changing or the completion flag
isn't being set.

### Cloud health check returns agent.ok=true after destroy

After destroy and recreate, `GET /api/cloud-health` returns
`agent.ok: true` even though no agent has been created yet. This is because
the endpoint checks `!userDoc?.agentId` (line 8294): if `agentId` was never
set (which it wasn't on the fresh recreated doc), it considers agent status
"ok". This is misleading — "no agent needed" is different from "agent is
healthy".

---

## 8. State Fragmentation Summary

The following fields track overlapping state across the system:

| Field | Location | Set by | Problem |
|-------|----------|--------|---------|
| `assignedAgentId` | CouchDB | ensureUserAgent, sync-agent | Multiple writers race |
| `kbName` | CouchDB | ensureKBNameOnUserDoc | Generated differently each call if not stored |
| `kbId` | CouchDB | update-knowledge-base | May not get saved (409 conflict) |
| `files[]` | CouchDB | files/register, files/upload | Can be overwritten by stale doc saves |
| `workflowStage` | CouchDB | Multiple endpoints | Set to different values by different paths |
| `wizardComplete` | maia-state.json | handleWizardComplete | Only in local folder, not in cloud |
| `knownUsers` | localStorage | App.vue | Survives destroy, used for restore card |
| `folderHandle` | IndexedDB | App.vue | Requires re-permission grant on new session |
| `agentSetupInProgress` | CouchDB | agent-setup-status | Races with workflowStage updates |

The fundamental issue is that there is no single "provision" or "restore"
transaction. Each step independently reads and writes the user doc, and any
step can fail or race with any other step, leaving the system in a partially
consistent state.

---

## 9. Recommended Architecture Changes

1. **Single provisioning coordinator**: A server-side function that creates all
   resources in order (user doc → KB name → agent → upload → index) and
   returns the complete result. No client-side orchestration of individual
   endpoints.

2. **Idempotent KB name**: `kbName` should be set exactly once (at user doc
   creation) and never regenerated. Remove `generateKBName()` from
   `getKBNameFromUserDoc()` — if no name is stored, return null rather than
   generating a new one.

3. **Agent creation mutex**: Use a per-user lock or "creating" flag in the user
   doc to prevent concurrent agent creation from racing.

4. **RestoreWizard should wait**: The wizard should show progress and wait for
   actual completion (agent deployed, KB indexed) before dismissing, like the
   new user wizard does.
