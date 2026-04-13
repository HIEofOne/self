# Wizards2 — Setup & Restore Redesign

## 1. API Endpoints Inventory

Every endpoint used by the Setup wizard, Restore wizard, and MyStuff dialog tabs.

### 1.1 Setup Wizard (`ChatInterface.vue`)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/setup-wizard-messages` | Load wizard instruction messages |
| GET | `/api/user-status` | Get user workflow status, KB name |
| GET | `/api/user-files?source=wizard` | List uploaded files with indexing state |
| GET | `/api/chat/providers` | Get available chat providers |
| GET | `/api/agent-setup-status` | Check if agent is deployed and ready |
| GET | `/api/kb-indexing-status/:jobId` | Poll KB indexing progress |
| POST | `/api/files/upload` | Upload medical record PDFs |
| POST | `/api/user-file-metadata` | Register file metadata (name, bucket key, size) |
| POST | `/api/toggle-file-knowledge-base` | Include/exclude files from KB indexing |
| POST | `/api/update-knowledge-base` | Trigger KB indexing after file uploads |
| POST | `/api/generate-patient-summary` | AI-generate patient summary from documents |
| POST | `/api/save-group-chat` | Save wizard chat conversation |
| POST | `/api/wizard-log` | Log wizard events and progress |
| POST | `/api/files/lists/process-initial-file` | Process lists from initial upload |
| GET/POST | `/api/patient-summary` | Load or save patient summary |
| GET/PUT | `/api/user-settings` | Get/save user preferences (provider selection) |

### 1.2 Restore Wizard (`RestoreWizard.vue`)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/user-status` | Resolve KB name from user document |
| GET | `/api/agent-setup-status` | Poll agent deployment status |
| GET | `/api/kb-indexing-status/:jobId` | Poll KB indexing progress |
| POST | `/api/files/upload` | Upload backup files to cloud storage |
| POST | `/api/files/register` | Register uploaded files in user document |
| POST | `/api/sync-agent` | Deploy/recreate user's AI agent |
| POST | `/api/update-knowledge-base` | Trigger KB indexing for uploaded files |
| POST | `/api/restore` | Batch restore metadata (medications, summary, chats, instructions) |
| POST | `/api/files/lists/restore-markdown` | Restore My Lists markdown content |

### 1.3 MyStuff Dialog (`MyStuffDialog.vue`)

#### My Files tab

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/user-files?source=saved` | List all user files |
| GET | `/api/files/parse-pdf-first-page/:bucketKey` | Extract first page for preview |
| GET | `/api/kb-indexing-status/:jobId` | Monitor KB indexing |
| POST | `/api/files/upload` | Upload new files |
| POST | `/api/user-file-metadata` | Register file metadata |
| POST | `/api/toggle-file-knowledge-base` | Include/exclude from KB |
| POST | `/api/update-knowledge-base` | Trigger KB re-indexing |
| POST | `/api/cancel-kb-indexing` | Cancel in-progress indexing |
| POST | `/api/files/delete` | Delete file from storage |
| POST | `/api/archive-user-files` | Archive selected files |
| DELETE | `/api/delete-file` | Delete file (alternative route) |

#### My Lists / Medications tab

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/user-status` | Get verified medications from user doc |
| POST | `/api/user-current-medications` | Save current medications list |
| POST | `/api/generate-patient-summary` | AI-generate from medications |

#### Patient Summary tab

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/patient-summary` | Load patient summary |
| POST | `/api/patient-summary` | Save patient summary |
| POST | `/api/patient-summary/swap` | Swap summary versions |
| POST | `/api/generate-patient-summary` | AI-generate summary |

#### My Chats tab

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/shared-group-chats` | List shared chats for user |
| GET | `/api/load-chat/:chatId` | Load full chat conversation |
| GET | `/api/load-chat-by-share/:shareId` | Load chat by share ID |
| POST | `/api/save-group-chat` | Save new chat |
| POST | `/api/attach-kb-to-agent` | Attach KB to agent for chat context |

#### Agent Instructions tab

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/agent-instructions` | Get agent system instructions |
| PUT | `/api/agent-instructions` | Save agent system instructions |
| POST | `/api/toggle-kb-connection` | Connect/disconnect KB to agent |
| GET | `/api/user-settings` | Get `allowDeepLinkPrivateAI` toggle state |
| PUT | `/api/user-settings` | Save `allowDeepLinkPrivateAI` toggle state |

#### Privacy Filter / Patient Diary tab

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/privacy-filter-mapping` | Get privacy name mappings |
| POST | `/api/privacy-filter-mapping` | Update privacy name mappings |
| GET | `/api/patient-diary` | Get diary entries |
| POST | `/api/patient-diary` | Create diary entries |
| POST | `/api/patient-diary/mark-posted` | Mark diary entries as posted |
| POST | `/api/patient-diary/delete` | Delete diary entries |
| GET | `/api/random-names` | Get random placeholder names |
| POST | `/api/chat/digitalocean` | Query Private AI with privacy filters |

### 1.4 App-Level (`App.vue`) — Auth, Account, Orchestration

| Method | Endpoint | Purpose | Used By |
|--------|----------|---------|---------|
| GET | `/api/current-user` | Get current authenticated user | Session check |
| GET | `/api/welcome-status` | Get user onboarding status | App startup |
| GET | `/api/passkey/check-user` | Check if passkey exists for user | Auth |
| GET | `/api/agent-exists` | Check if agent deployed for user | Setup flow |
| GET | `/api/cloud-health` | Check cloud services status (DB, agent, KB, files) | Health check |
| GET | `/api/admin-username` | Get admin username | Admin setup |
| GET | `/api/user-deep-links` | Get user's shared chat deep links | Deep links |
| GET | `/api/user-chats` | List user's chats | Chat management |
| GET | `/api/files/lists/markdown` | Get My Lists markdown content | Lists retrieval |
| POST | `/api/sign-out` | Sign out user | Auth |
| POST | `/api/account/recreate` | Recreate user document for restore | Restore flow |
| POST | `/api/account/dormant` | Mark account as dormant | Account mgmt |
| POST | `/api/self/delete` | Delete user account and all data | Destroy flow |
| POST | `/api/local/delete` | Delete local snapshot data | Local cleanup |
| POST | `/api/temporary/start` | Start temporary session for new user | Onboarding |
| POST | `/api/temporary/restore` | Restore from temporary session | Session recovery |
| POST | `/api/auth/clear-temp-cookie` | Clear temporary user cookie | Auth cleanup |
| GET/POST | `/api/user-status` | Get/update user document, workflow status | Status tracking |
| POST | `/api/user-current-medications` | Save medications | Medications |
| GET/POST | `/api/patient-summary` | Get/save patient summary | Summary |

### 1.5 Shared Endpoints (used by multiple components)

| Endpoint | Setup | Restore | MyStuff | App |
|----------|:-----:|:-------:|:-------:|:---:|
| `/api/user-status` | x | x | x | x |
| `/api/files/upload` | x | x | x | |
| `/api/update-knowledge-base` | x | x | x | |
| `/api/kb-indexing-status/:jobId` | x | x | x | |
| `/api/agent-setup-status` | x | x | | |
| `/api/patient-summary` | x | | x | x |
| `/api/generate-patient-summary` | x | | x | |
| `/api/user-current-medications` | | | x | x |
| `/api/save-group-chat` | x | | x | |
| `/api/user-settings` | x | | x | |
| `/api/user-file-metadata` | x | | x | |
| `/api/toggle-file-knowledge-base` | x | | x | |

**Total: ~60 unique endpoints across all components.**

---

## 2. The Problem

Setup and Restore are two paths to the same end state: a user with files, an agent, a knowledge base, medications, a patient summary, saved chats, and agent instructions. But they are implemented as completely separate flows with divergent state management, and the wizard's client-side state leaks into MyStuff rendering.

### 2.0 Critical Bug: "verified" instead of actual content

`saveStateToLocalFolder()` in ChatInterface.vue writes:
```javascript
currentMedications: wizardCurrentMedications.value ? 'verified' : null,
patientSummary: wizardPatientSummary.value ? 'verified' : null,
```

`wizardCurrentMedications` and `wizardPatientSummary` are **booleans**, not the actual text. So `maia-state.json` stores the literal string `"verified"`. During restore, RestoreWizard sends `"verified"` to `POST /api/restore`, which writes it into CouchDB as the medications and summary content. **This is why medications and summary say "verified" after restore.**

### 2.1 Current State Tracking (the mess)

**Setup wizard** tracks progress via ~15 refs in ChatInterface.vue:
- `wizardFlowPhase` ('running' | 'medications' | 'summary' | 'done')
- `wizardStage1Complete`, `indexingStatus`, `stage3IndexingStartedAt`, `stage3IndexingCompletedAt`
- `wizardCurrentMedications`, `wizardPatientSummary` (booleans — not the data itself)
- `wizardRequestAction` (signals MyStuff to generate/update summary)
- `setupLogLines` (persisted to local maia-state.json)
- localStorage keys for completion timestamps

**Restore wizard** tracks progress via its own internal refs in RestoreWizard.vue:
- `phase` ('prepare' | 'execute' | 'complete')
- Per-item status ('pending' | 'running' | 'done' | 'error' | 'skipped')
- `restoreSummary` (completion text)

**MyStuff** receives wizard state via props:
- `wizardActive` — suppresses medications-consistency checks, shows wizard summary actions
- `requestAction` — tells MyStuff to generate or update summary on behalf of the wizard
- `restoreActive` — triggers provider reload on completion

**The server** has its own `workflowStage` field on the user doc:
- 'unknown' → 'approved' → 'agent_named' → 'agent_deployed' → 'patient_summary' → etc.

### 2.2 Why It Breaks

1. **Restore doesn't set wizard refs.** After restore writes medications and summary to CouchDB, the wizard refs (`wizardCurrentMedications`, `wizardPatientSummary`) remain false. When MyStuff opens, it loads data from the server but the wizard layer doesn't know about it, causing display/logging inconsistencies.

2. **Two components race to load the same data.** The tab watcher in MyStuff calls `loadPatientSummary()` while the `requestAction` watcher calls `requestNewSummary()`. Both fire when the summary tab opens during wizard flow.

3. **Logging is split across three layers.** ChatInterface logs wizard events, RestoreWizard emits log events that get buffered/flushed through App.vue, and MyStuff logs its own tab events. Log entries get lost when components aren't mounted yet.

4. **The server `workflowStage` is write-only.** It's set during setup/restore but never read back to drive UI decisions. The client re-derives everything from scattered signals.

5. **Chats are silently dropped during restore.** The `/api/restore` endpoint accepts `savedChats` but RestoreWizard may not send them correctly, and there's no verification that the saved chats actually made it into CouchDB.

---

## 3. Proposed Redesigns

### Design A: Server-Side Provisioning Status (Single Source of Truth)

### 3.1 Core Principle

> **The server is the single source of truth. The client is a renderer.**

Both Setup and Restore update a `provisioningLog` array on the CouchDB user document. Each entry is a timestamped, immutable event. MyStuff never reads from or writes to this log — it loads tab data from its own existing endpoints. No wizard props (`wizardActive`, `requestAction`, `restoreActive`) flow into MyStuff.

### 3.2 Server: `provisioningLog` on the user document

Replace the scattered `workflowStage` string with a structured log array:

```json
{
  "_id": "lauren87",
  "provisioningLog": [
    {
      "id": 1,
      "time": "2026-04-12T20:46:41Z",
      "event": "setup-started",
      "method": "setup",
      "client": {
        "browser": "Chrome 146 on macOS",
        "appUrl": "http://localhost:5173",
        "folder": "AG MAIA files",
        "version": "1.2.0"
      }
    },
    { "id": 2, "time": "...", "event": "files-uploaded", "count": 4, "totalKB": 11071,
      "files": ["GROPPER_ADRIAN_09_24_25_1314-1.PDF", "GROPPER_ADRIAN_6KB.PDF", "GROPPER_ADRIAN_26KB.PDF", "Apple - Adrian Gropper - 2025-11-17.pdf"],
      "appleHealthCount": 1 },
    { "id": 3, "time": "...", "event": "apple-health-detected", "fileName": "Apple - Adrian Gropper - 2025-11-17.pdf" },
    { "id": 4, "time": "...", "event": "agent-deployed", "agentId": "...", "elapsedMs": 69000 },
    { "id": 5, "time": "...", "event": "kb-indexed", "tokens": 177996, "fileCount": 4, "elapsedMs": 341000 },
    { "id": 6, "time": "...", "event": "summary-generated", "lines": 38, "chars": 2941 },
    { "id": 7, "time": "...", "event": "medications-offered", "lines": 12 },
    { "id": 8, "time": "...", "event": "medications-saved", "lines": 12 },
    { "id": 9, "time": "...", "event": "summary-saved", "lines": 24, "chars": 1847 },
    { "id": 10, "time": "...", "event": "setup-complete" },
    { "id": 11, "time": "...", "event": "account-deleted" },
    { "id": 12, "time": "...", "event": "restore-started", "method": "restore",
      "client": { "browser": "Chrome 146 on macOS", "appUrl": "http://localhost:5173", "folder": "AG MAIA files", "version": "1.2.0" }
    },
    { "id": 13, "time": "...", "event": "files-uploaded", "count": 4, "totalKB": 11071,
      "files": ["..."], "appleHealthCount": 1 },
    { "id": 14, "time": "...", "event": "agent-deployed", "agentId": "...", "elapsedMs": 45000 },
    { "id": 15, "time": "...", "event": "kb-indexed", "tokens": 177996, "fileCount": 4, "elapsedMs": 270000 },
    { "id": 16, "time": "...", "event": "medications-restored", "lines": 12 },
    { "id": 17, "time": "...", "event": "summary-restored", "lines": 24, "chars": 1847 },
    { "id": 18, "time": "...", "event": "chats-restored", "count": 1 },
    { "id": 19, "time": "...", "event": "instructions-restored" },
    { "id": 20, "time": "...", "event": "lists-restored" },
    { "id": 21, "time": "...", "event": "restore-complete" }
  ]
}
```

### 3.3 Event Catalog

Every possible `event` value, with required fields:

#### Lifecycle events (Setup or Restore)

| Event | Extra Fields | When |
|-------|-------------|------|
| `setup-started` | `method: "setup"`, `client: {...}` | User clicks GET STARTED, folder selected |
| `restore-started` | `method: "restore"`, `client: {...}` | User clicks RESTORE, folder read |
| `setup-complete` | — | All setup steps done, user verified summary |
| `restore-complete` | — | All restore steps done |
| `account-deleted` | — | User clicks DELETE CLOUD ACCOUNT |
| `error` | `step: string`, `message: string` | Any step fails |

#### Resource events (same for Setup and Restore)

| Event | Extra Fields | Description |
|-------|-------------|-------------|
| `files-uploaded` | `count`, `totalKB`, `files[]`, `appleHealthCount`, `failedCount?`, `failedFiles?[]` | All files uploaded to S3 |
| `apple-health-detected` | `fileName` | Apple Health export found among uploaded files (setup only) |
| `agent-deployed` | `agentId`, `elapsedMs` | Agent ready with endpoint. `elapsedMs` is milliseconds for m:ss display. |
| `kb-indexed` | `tokens`, `fileCount`, `elapsedMs` | KB indexing complete. `elapsedMs` is milliseconds for m:ss display. |

#### Data events

| Event | Extra Fields | Description |
|-------|-------------|-------------|
| `summary-generated` | `lines`, `chars` | Provisional AI-generated patient summary (before medications extraction). Setup only. |
| `medications-offered` | `lines` | AI-extracted medications offered to user for verification. Setup only. |
| `medications-saved` | `lines` | Medications written to CouchDB (setup: user verified/edited) |
| `medications-restored` | `lines` | Medications written to CouchDB (from backup) |
| `summary-saved` | `lines`, `chars` | Final patient summary written (setup: user verified/edited) |
| `summary-restored` | `lines`, `chars` | Patient summary written (from backup) |
| `chats-restored` | `count` | Saved chats written to maia_chats DB |
| `instructions-restored` | — | Agent instructions restored |
| `lists-restored` | — | My Lists markdown restored |

All `elapsedMs` fields are stored in milliseconds. The PDF renderer formats them as `Xm YYs` (e.g., `1m 09s`, `5m 41s`).

### 3.4 New Endpoint: `POST /api/provisioning-log`

Appends one event to the `provisioningLog` array on the user doc.

```
POST /api/provisioning-log
Content-Type: application/json

{
  "event": "files-uploaded",
  "count": 4,
  "totalKB": 11071,
  "files": ["file1.pdf", "file2.pdf", "file3.pdf", "file4.pdf"],
  "appleHealthCount": 1
}
```

Server logic:
1. Read user doc
2. Auto-assign `id` (max existing id + 1) and `time` (server timestamp)
3. Append to `provisioningLog` array
4. Save with conflict retry
5. Return `{ success: true, id: <assigned> }`

### 3.5 New Endpoint: `GET /api/provisioning-log`

Returns the full log. Used by the client on load to render progress and determine current state.

```
GET /api/provisioning-log?userId=lauren87

Response:
{
  "success": true,
  "log": [ ... ],
  "currentState": {
    "method": "setup" | "restore" | null,
    "inProgress": true | false,
    "filesUploaded": 4,
    "agentReady": true,
    "kbIndexed": true,
    "kbTokens": 177996,
    "medicationsDone": true,
    "medicationsLines": 12,
    "summaryDone": true,
    "summaryLines": 24,
    "chatCount": 1,
    "instructionsDone": true,
    "listsDone": true
  }
}
```

The `currentState` summary is **derived** from the log on read — it scans for the latest `setup-started` or `restore-started`, then checks which events follow it. This avoids a separate state field that can get out of sync.

### 3.6 `maia-state.json` Fix: Store Actual Content

The current code saves booleans as the string `"verified"`. The fix:

```javascript
// BEFORE (broken):
currentMedications: wizardCurrentMedications.value ? 'verified' : null,
patientSummary: wizardPatientSummary.value ? 'verified' : null,

// AFTER (correct):
// Fetch actual content from server before saving to local backup
const medsResp = await fetch(`/api/user-status?userId=${userId}`);
const medsData = await medsResp.json();

const summaryResp = await fetch(`/api/patient-summary?userId=${userId}`);
const summaryData = await summaryResp.json();

currentMedications: medsData.currentMedications || null,
patientSummary: summaryData.summary || null,
```

`maia-state.json` must contain the **actual text** so restore can write it back verbatim. The `saveStateToLocalFolder` function should be called:
- After setup-complete (all data finalized on server)
- After any MyStuff save (medications edited, summary edited, chat saved)
- Before account-deleted (final backup snapshot)

### 3.7 Setup Log PDF (maia-log.pdf)

Generated client-side from `GET /api/provisioning-log` response. The server provides the structured events; the client adds the formatting.

#### Header (client-side detail from `client` field in start event)

```
MAIA Setup Log
Generated: 4/12/2026, 9:09:43 PM
Version: 1.2.0
User: lauren87
App URL: http://localhost:5173
Folder: AG MAIA files
Browser: Chrome 146 on macOS
Chat providers: Private AI (openai-gpt-oss-120b), Anthropic (claude-opus-4-6), ChatGPT, DeepSeek
```

#### Summary (derived from `currentState`)

```
Summary
  Files uploaded: 4
  Apple Health: Yes
  Agent ready: Yes (1m 09s)
  KB indexed: Yes — 177,996 tokens (5m 41s)
  Current Medications: Yes (12 lines)
  Patient Summary: Yes (24 lines)
  Saved Chats: 1
```

Note: line counts and elapsed times come from the event metadata, not from re-reading content.

#### Detailed Log (one line per event)

```
--- Setup ---
[8:46:41 PM] Setup started
[8:46:55 PM] Files uploaded: 4 files (10,821 KB total), 1 Apple Health
             GROPPER_ADRIAN_09_24_25_1314-1.PDF, GROPPER_ADRIAN_6KB.PDF,
             GROPPER_ADRIAN_26KB.PDF, Apple - Adrian Gropper - 2025-11-17.pdf
[8:46:55 PM] Apple Health detected: Apple - Adrian Gropper - 2025-11-17.pdf
[8:47:51 PM] Agent deployed (1m 09s)
[8:52:45 PM] Knowledge Base indexed: 4 files, 177,996 tokens (5m 41s)
[8:52:49 PM] Patient Summary generated (38 lines, 2,941 chars)
[8:52:50 PM] Current Medications offered for verification (12 lines)
[9:02:36 PM] Current Medications saved (12 lines)
[9:02:50 PM] Patient Summary saved (24 lines, 1,847 chars)
[9:02:54 PM] Setup complete

[9:03:14 PM] Cloud account deleted

--- Restore ---
[9:03:30 PM] Restore started
[9:04:15 PM] Files uploaded: 4 files (10,821 KB total), 1 Apple Health
[9:05:01 PM] Agent deployed (0m 45s)
[9:09:30 PM] Knowledge Base indexed: 4 files, 177,996 tokens (4m 30s)
[9:09:31 PM] Current Medications restored (12 lines)
[9:09:31 PM] Patient Summary restored (24 lines, 1,847 chars)
[9:09:31 PM] Saved chats restored (1)
[9:09:31 PM] Agent Instructions restored
[9:09:31 PM] My Lists restored
[9:09:31 PM] Restore complete
```

Compared to the current log with ~60 entry types, this is **21 event types** producing clean, readable output. No duplicate entries, no "Indexing Progress" noise, no "State Refreshed" clutter.

`elapsedMs` rendering: `formatElapsed(ms)` → `${Math.floor(ms/60000)}m ${String(Math.floor((ms%60000)/1000)).padStart(2,'0')}s` (e.g., 69000 → `1m 09s`, 341000 → `5m 41s`).

### 3.8 What Gets Removed

#### From ChatInterface.vue (~300 lines removed)

| Remove | Reason |
|--------|--------|
| `wizardFlowPhase` ref and all transitions | Server log replaces phase tracking |
| `wizardStage1Complete` ref | Derived from `currentState.agentReady` |
| `wizardCurrentMedications` ref (boolean) | Derived from `currentState.medicationsDone` |
| `wizardPatientSummary` ref (boolean) | Derived from `currentState.summaryDone` |
| `wizardRequestAction` ref | MyStuff loads its own data |
| `stage3IndexingStartedAt/CompletedAt` refs | Server records elapsed time in event |
| `stage3IndexingPoll` interval | Polling moves to a simple loop; result written to server |
| `setupLogLines` ref (60+ addSetupLogLine calls) | Replaced by ~8 `POST /api/provisioning-log` calls |
| `markIndexingAlreadyCompleted()` | No duplicate-entry problem when server assigns IDs |
| `oneTimeLogSteps` dedup set | Server events are append-only, no dedup needed |
| `pendingSummaryRegeneration` flag | No racing watchers — MyStuff loads data independently |
| `generateSetupLogPdf()` body (~140 lines) | Rewritten to render from server log (much simpler) |
| `saveStateToLocalFolder()` writing `'verified'` | Rewritten to fetch actual content |

#### From MyStuffDialog.vue

| Remove | Reason |
|--------|--------|
| `wizardActive` prop | MyStuff never knows about wizard |
| `requestAction` prop | MyStuff loads its own data |
| `showWizardSummaryActions` computed | Gone |
| `pendingSummaryRegeneration` ref | Gone |
| `requestAction` watcher | Gone |

#### From App.vue

| Remove | Reason |
|--------|--------|
| `restoreLogBuffer` + flush logic | Server stores events directly |
| `handleRestoreLog()` | RestoreWizard writes to server, not via emit |
| `markIndexingAlreadyCompleted()` call | Gone |
| `wizardRequestAction` ref | Gone |
| `@restore-log` event handling | Gone |

#### From RestoreWizard.vue

| Remove | Reason |
|--------|--------|
| `emit('restore-log')` and `logStep()` | Replaced by `POST /api/provisioning-log` calls |
| 20 individual `logStep()` calls | Replaced by ~8 `POST /api/provisioning-log` calls |

### 3.9 MyStuff Independence

MyStuff tabs load data from their existing endpoints. No wizard props. No special behavior during or after setup/restore.

| Tab | Data Source | How It Works |
|-----|-----------|-------------|
| Saved Files | `GET /api/user-files` | Lists files. Always works — files are there or not. |
| My AI Agent | `GET /api/agent-instructions`, `GET /api/user-settings` | Shows instructions, KB connection toggle, deep link toggle. |
| Saved Chats | `GET /api/shared-group-chats` | Lists chats. Empty if none saved yet. |
| Patient Summary | `GET /api/patient-summary` | Shows summary. Empty state if not yet generated. |
| My Lists | `GET /api/files/lists/markdown` | Shows lists. Empty state if none. |
| Privacy Filter | `GET /api/privacy-filter-mapping` | Shows mappings. Empty state if none. |
| Patient Diary | `GET /api/patient-diary` | Shows diary entries. Empty state if none. |
| References | (static content) | No data loading. |

**The guided review flow** (verify medications → verify summary) stays in the wizard component. The wizard opens MyStuff to a specific tab, but MyStuff doesn't know or care that it was opened by the wizard. When MyStuff closes, the wizard checks the server (`GET /api/provisioning-log` → `currentState.medicationsDone`) and moves to the next step.

### 3.10 Setup Flow (revised)

```
 1. User clicks GET STARTED, selects local folder
 2. POST /api/provisioning-log { event: "setup-started", client: {...} }
 3. Upload files → POST /api/files/upload (existing, per file)
 4. POST /api/provisioning-log { event: "files-uploaded", count, files, totalKB, appleHealthCount }
 5. If Apple Health file found:
    POST /api/provisioning-log { event: "apple-health-detected", fileName }
 6. Deploy agent → POST /api/sync-agent (existing)
    Poll /api/agent-setup-status until ready, track start time
 7. POST /api/provisioning-log { event: "agent-deployed", agentId, elapsedMs }
 8. Index KB → POST /api/update-knowledge-base (existing)
    Poll /api/kb-indexing-status/:jobId until done, track start time
 9. POST /api/provisioning-log { event: "kb-indexed", tokens, fileCount, elapsedMs }
10. Generate summary → POST /api/generate-patient-summary (existing)
    Count lines of generated text
    POST /api/provisioning-log { event: "summary-generated", lines, chars }
11. Extract medications from summary, count lines offered
    POST /api/provisioning-log { event: "medications-offered", lines }
12. Open MyStuff to Medications tab (user verifies/edits, saves)
    On save: POST /api/user-current-medications (existing)
    POST /api/provisioning-log { event: "medications-saved", lines: <final count> }
13. Switch MyStuff to Summary tab (user verifies/edits, saves)
    On save: POST /api/patient-summary (existing)
    POST /api/provisioning-log { event: "summary-saved", lines, chars }
14. POST /api/provisioning-log { event: "setup-complete" }
15. Save maia-state.json with ACTUAL content (fetch from server)
16. Generate maia-log.pdf from GET /api/provisioning-log
```

### 3.11 Restore Flow (revised)

```
1. User clicks RESTORE on orange badge
2. Read maia-state.json from local folder (actual content now)
3. POST /api/account/recreate (existing)
4. POST /api/provisioning-log { event: "restore-started", client: {...} }
5. Upload files from local folder → POST /api/files/upload (per file)
6. POST /api/provisioning-log { event: "files-uploaded", count, files, ... }
7. Deploy agent → POST /api/sync-agent
   Poll until ready
8. POST /api/provisioning-log { event: "agent-deployed", agentId, elapsed }
9. Index KB → POST /api/update-knowledge-base
   Poll until done
10. POST /api/provisioning-log { event: "kb-indexed", tokens, fileCount, elapsed }
11. Restore metadata → POST /api/restore {
      currentMedications: <actual text from maia-state.json>,
      patientSummary: <actual text from maia-state.json>,
      savedChats: <actual chat objects from maia-state.json>,
      agentInstructions: <actual text from maia-state.json>
    }
12. POST /api/provisioning-log { event: "medications-restored", lines: <count> }
13. POST /api/provisioning-log { event: "summary-restored", lines: <count>, chars: <count> }
14. POST /api/provisioning-log { event: "chats-restored", count: <n> }
15. POST /api/provisioning-log { event: "instructions-restored" }  (if applicable)
16. Restore lists → POST /api/files/lists/restore-markdown (existing)
17. POST /api/provisioning-log { event: "lists-restored" }  (if applicable)
18. POST /api/provisioning-log { event: "restore-complete" }
19. Re-save maia-state.json (confirms round-trip)
20. Generate maia-log.pdf from GET /api/provisioning-log
```

### 3.12 Delete Cloud Account Flow

```
1. User clicks DELETE CLOUD ACCOUNT
2. Save maia-state.json with ACTUAL content (fetch all from server first)
3. POST /api/self/delete (existing)
4. POST /api/provisioning-log { event: "account-deleted" }
   (This goes to the recreated-minimal user doc, or is appended before deletion
    and preserved in maia-state.json as part of the setupLog field)
5. Welcome page shows orange badge (existing discoverUsers logic)
```

Note: The `account-deleted` event should be saved to `maia-state.json` locally before the server doc is destroyed, so the restore flow can show the full history.

---

## 4. Automated Setup-Restore Testing

### 4.1 Test Cycle

Once a local folder is selected, execute this full cycle automatically:

```
SETUP → auto-verify → DELETE CLOUD → RESTORE → verify all tabs → compare → PASS/FAIL
```

### 4.2 TEST Button

A **TEST** button appears in the folder-select dialog, **only on localhost** (`window.location.hostname === 'localhost'`). It sits next to the existing folder-select button.

When clicked:
1. The user selects their local folder (same File System Access API picker as normal setup)
2. The test runner takes over — no further user interaction needed
3. A test progress panel replaces the wizard UI, showing real-time status
4. At every Verify or Edit choice point, the test runner **auto-verifies** (accepts the AI-generated content without editing) and continues

### 4.3 Client-Side Test Runner

A new module `src/utils/setupRestoreTest.ts` that drives the full cycle using the same API calls the wizard would make:

```javascript
async function runSetupRestoreCycle(folderHandle, userId, onProgress) {
  const results = { setup: {}, delete: {}, restore: {}, verify: {} };

  // ── PHASE 1: SETUP ──
  onProgress('setup', 'Uploading files...');
  const files = await scanFolder(folderHandle);
  await uploadFiles(files, userId);
  const uploadLog = await logEvent({ event: 'files-uploaded', count: files.length, ... });

  onProgress('setup', 'Deploying agent...');
  const agentStart = Date.now();
  const agent = await deployAndWaitForAgent(userId);
  await logEvent({ event: 'agent-deployed', agentId: agent.id, elapsedMs: Date.now() - agentStart });

  onProgress('setup', 'Indexing knowledge base...');
  const kbStart = Date.now();
  const kb = await indexAndWaitForKB(userId);
  await logEvent({ event: 'kb-indexed', tokens: kb.tokens, fileCount: kb.fileCount, elapsedMs: Date.now() - kbStart });

  onProgress('setup', 'Generating patient summary...');
  const summary = await generateSummary(userId);
  const summaryLines = summary.split('\n').filter(l => l.trim()).length;
  await logEvent({ event: 'summary-generated', lines: summaryLines, chars: summary.length });

  // Extract medications from summary
  const meds = extractMedications(summary);
  const medsLines = meds.split('\n').filter(l => l.trim()).length;
  await logEvent({ event: 'medications-offered', lines: medsLines });

  // AUTO-VERIFY: accept medications as-is (no user edit)
  onProgress('setup', 'Auto-verifying medications...');
  await saveMedications(userId, meds);
  await logEvent({ event: 'medications-saved', lines: medsLines });

  // AUTO-VERIFY: accept summary as-is (no user edit)
  onProgress('setup', 'Auto-verifying patient summary...');
  await saveSummary(userId, summary);
  await logEvent({ event: 'summary-saved', lines: summaryLines, chars: summary.length });

  await logEvent({ event: 'setup-complete' });

  // 1b. Verify all tabs after setup
  onProgress('setup', 'Verifying setup...');
  results.setup = await verifyAllTabs(userId);

  // ── PHASE 2: DELETE CLOUD ACCOUNT ──
  onProgress('delete', 'Saving local backup...');
  await saveStateToLocalFolder(folderHandle, userId); // fetches ACTUAL content from server
  const savedState = await readStateFile(folderHandle);

  // Validate maia-state.json before proceeding
  assert(savedState.currentMedications && savedState.currentMedications !== 'verified',
    'maia-state.json has actual medications text');
  assert(savedState.patientSummary && savedState.patientSummary !== 'verified',
    'maia-state.json has actual summary text');
  results.delete = {
    medsLines: savedState.currentMedications.split('\n').filter(l => l.trim()).length,
    summaryLines: savedState.patientSummary.split('\n').filter(l => l.trim()).length,
    chatCount: savedState.savedChats?.chats?.length || 0
  };

  onProgress('delete', 'Deleting cloud account...');
  await deleteCloudAccount(userId);

  // ── PHASE 3: RESTORE ──
  onProgress('restore', 'Recreating account...');
  await recreateAccount(userId);
  await logEvent({ event: 'restore-started', client: getClientInfo() });

  onProgress('restore', 'Uploading files from backup...');
  await uploadFilesFromState(folderHandle, savedState, userId);
  await logEvent({ event: 'files-uploaded', count: savedState.files.length, ... });

  onProgress('restore', 'Deploying agent...');
  const restoreAgentStart = Date.now();
  const restoredAgent = await deployAndWaitForAgent(userId);
  await logEvent({ event: 'agent-deployed', agentId: restoredAgent.id, elapsedMs: Date.now() - restoreAgentStart });

  onProgress('restore', 'Indexing knowledge base...');
  const restoreKbStart = Date.now();
  const restoredKb = await indexAndWaitForKB(userId);
  await logEvent({ event: 'kb-indexed', tokens: restoredKb.tokens, fileCount: restoredKb.fileCount, elapsedMs: Date.now() - restoreKbStart });

  onProgress('restore', 'Restoring metadata...');
  const restoreResult = await restoreMetadata(userId, savedState);
  // Log individual restore events from result
  if (restoreResult.medications)
    await logEvent({ event: 'medications-restored', lines: results.delete.medsLines });
  if (restoreResult.summary)
    await logEvent({ event: 'summary-restored', lines: results.delete.summaryLines, chars: savedState.patientSummary.length });
  if (restoreResult.chats > 0)
    await logEvent({ event: 'chats-restored', count: restoreResult.chats });
  if (restoreResult.instructions)
    await logEvent({ event: 'instructions-restored' });
  if (savedState.listsMarkdown) {
    await restoreLists(userId, savedState.listsMarkdown);
    await logEvent({ event: 'lists-restored' });
  }

  await logEvent({ event: 'restore-complete' });

  // ── PHASE 4: VERIFY ──
  onProgress('verify', 'Verifying restore...');
  results.verify = await verifyAllTabs(userId);

  // Compare setup vs restore
  results.comparison = compareResults(results.setup, results.verify);

  onProgress('done', results.comparison.passed ? 'ALL TESTS PASSED' : 'TESTS FAILED');
  return results;
}
```

### 4.4 `verifyAllTabs()` — What to Check

| Tab | Endpoint | Assertion |
|-----|----------|-----------|
| Saved Files | `GET /api/user-files` | `files.length === expected count` |
| My AI Agent | `GET /api/agent-setup-status` | `agentReady === true` |
| My AI Agent | `GET /api/agent-instructions` | `instructions` exists (if was set) |
| Saved Chats | `GET /api/shared-group-chats` | `chats.length === expected count` |
| Patient Summary | `GET /api/patient-summary` | `summary.length > 0`, `summary !== 'verified'` |
| Patient Summary | — | `summary line count > 0` |
| My Lists | `GET /api/files/lists/markdown` | `markdown.length > 0` (if was set) |
| Medications | `GET /api/user-status` | `currentMedications.length > 0`, `currentMedications !== 'verified'` |
| Medications | — | `medications line count > 0` |
| KB Status | `GET /api/user-status` | `hasKB === true`, `kbStatus === 'attached'` |

### 4.5 Auto-Verify Behavior

During the test cycle, whenever the normal setup flow would present a Verify or Edit choice to the user:

| Choice Point | Normal Flow | TEST Mode |
|-------------|-------------|-----------|
| Current Medications offered | MyStuff opens to My Lists tab, user can edit or verify | Auto-save as-is, log `medications-saved` |
| Patient Summary shown | MyStuff opens to Summary tab, user can edit or verify | Auto-save as-is, log `summary-saved` |
| Any confirmation dialog | User clicks OK | Auto-dismiss |

The test runner calls the same save endpoints the UI would call — it just skips the user interaction. This ensures the test exercises the real code path, not a simulated one.

### 4.6 Test Output

```
Setup-Restore Test Results
==========================
SETUP PHASE
  ✓ Files uploaded: 4
  ✓ Apple Health detected: Apple - Adrian Gropper - 2025-11-17.pdf
  ✓ Agent deployed (1m 09s)
  ✓ KB indexed: 177,996 tokens (5m 41s)
  ✓ Summary generated: 38 lines, 2,941 chars
  ✓ Medications offered: 12 lines
  ✓ Medications auto-verified: 12 lines
  ✓ Summary auto-verified: 24 lines, 1,847 chars

DELETE PHASE
  ✓ maia-state.json saved with actual content
  ✓ maia-state.json medications: 12 lines (not "verified")
  ✓ maia-state.json summary: 24 lines (not "verified")
  ✓ maia-state.json chats: 0
  ✓ Cloud account deleted

RESTORE PHASE
  ✓ Account recreated
  ✓ Files uploaded: 4
  ✓ Agent deployed (0m 45s)
  ✓ KB indexed: 177,996 tokens (4m 30s)
  ✓ Medications restored: 12 lines
  ✓ Summary restored: 24 lines, 1,847 chars

VERIFY PHASE (post-restore data matches post-setup)
  ✓ Saved Files: 4 === 4
  ✓ Agent ready: true === true
  ✓ KB tokens: 177,996 === 177,996
  ✓ Medications lines: 12 === 12
  ✓ Medications content: exact match
  ✓ Summary lines: 24 === 24
  ✓ Summary content: exact match
  ✓ Lists: match (or both empty)

RESULT: PASS (all assertions passed)
Total time: 12m 34s
```

### 4.7 TEST Button Location

In the folder-select dialog (the first thing the user sees after clicking GET STARTED):

```
┌─────────────────────────────────────┐
│  Select Your MAIA Folder            │
│                                     │
│  Choose a local folder to store     │
│  your medical records and backups.  │
│                                     │
│  ┌─────────────┐   ┌──────────┐    │
│  │ SELECT FOLDER│   │   TEST   │    │
│  └─────────────┘   └──────────┘    │
│                     (localhost only) │
└─────────────────────────────────────┘
```

The TEST button:
- Only renders when `window.location.hostname === 'localhost'`
- Opens the same folder picker as SELECT FOLDER
- After folder selection, immediately starts the automated cycle
- Replaces the dialog content with a live progress panel
- Shows the test output (Section 4.6) when complete
