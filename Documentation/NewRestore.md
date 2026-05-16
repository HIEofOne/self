# Setup and Restore — proposed design

Status: proposal, not yet implemented.
Replaces: `OldNewRestore.md` (archived; describes the current,
patch-heavy implementation).

## The mental model

MAIA is a **local-first** app. The user's local folder — the PDFs, the
XML, the JPEGs, plus the JSON state file MAIA writes alongside them —
is the persistent home for everything that matters. The DigitalOcean
cloud is an **accelerator**: it runs an indexed vector store and a
GenAI agent so that "ask my records a question" answers in seconds
instead of hours. Cloud resources are *disposable*. When the user stops
paying, they vanish. When the user signs back in, they're rebuilt
from the folder.

The only thing that survives a destroyed cloud account is the App
Platform stub that serves this app. Eventually even that becomes
ephemeral (provision-from-repo + credit card).

This inverts the typical web-app architecture. In a typical app the
server is the source of truth and the client caches. Here, the client
*folder* is the source of truth and the server *caches* (indexed) and
*derives* (summaries, lists, chat). That single inversion is what most
of the design fragility in the old document came from — code that
treated the cloud as authoritative kept trying to reconcile partial
mirrors.

## The two artifacts

| Artifact | Lives | Role | Survives cloud destruction? |
|---|---|---|---|
| **Folder files** (PDF, XML, PNG, JPEG, …) | User's filesystem | The records themselves | Yes |
| **`maia-state.json`** | User's filesystem, alongside the files | Full backup of `userDoc` + folder inventory | Yes |
| **`userDoc`** in CouchDB | DO droplet | Server-side working copy of state, used by the agent / KB / API | No |
| **Spaces bucket** | DO Spaces | Working copy of the files for the KB to index | No |
| **DO Agent** | DO GenAI | Inference endpoint with KB attached | No |
| **DO KB** | DO GenAI + OpenSearch + Spaces | Indexed vector store | No |
| **DO Droplet (CouchDB)** | DO compute | Hosts userDoc | No |

When the user signs out, they write `maia-state.json` and walk away.
When they sign back in, MAIA reads `maia-state.json` and asks DO to
rebuild whatever is missing.

## The four operations

### 1. Add a file (during Setup, or any time later)

One server endpoint owns this. Client uploads bytes; server does
everything else.

```
POST /api/files
  multipart: file=<bytes>, fileName=<string>
  server:
    1. PUT into Spaces (userId/kbName/fileName)
    2. Compute sha256
    3. Detect mimeType from magic bytes
    4. Run kind detection:
         if PDF, read first page → flag isAppleHealth on content match
         if XML, look for <Bundle xmlns="http://hl7.org/fhir"> → flag isFhir
         (other detectors plug in here)
    5. Append { fileName, bucketKey, fileSize, sha256, mimeType,
                isAppleHealth?, isFhir?, addedAt } to userDoc.files
    6. Trigger KB indexing for this file (idempotent — DO de-dups
       within the data source)
    7. Return the new file entry
```

No client passes the AH flag. No filename heuristic anywhere. Future
file types add a detector to step 4 and a `kind` field; nothing else
changes.

### 2. Sign out (write the local backup)

```
GET  /api/user-doc/full     →  the entire userDoc as JSON
write maia-state.json {
  schemaVersion: 1,
  exportedAt: <ISO>,
  userDoc: <verbatim>,
  folder: {                       // local-only; doesn't live in userDoc
    files: [{ name, size, mtime, sha256 }, …]
  }
}
```

No selective serialization, no field-by-field mirroring. New fields on
`userDoc` ride for free.

The `folder` block is what enables the "added a file in Finder while
signed out" reconciliation later. It records *what was in the folder at
the moment of sign-out* so Restore can compare against the folder *as
it is now*.

### 3. Restore (push local truth back to cloud)

```
read maia-state.json
list folder files
PUT /api/account/rehydrate {
  schemaVersion, exportedAt, userDoc, folderFiles: [{name,size,mtime,sha256}]
}
  server:
    1. (migrate userDoc shape if schemaVersion < current)
    2. Replace userDoc in CouchDB with the supplied userDoc.
    3. Reconcile S3 against userDoc.files:
         - upload any missing bytes (client streams them as a second
           multipart in the same request, or via a follow-up
           POST /api/files/restore-bytes per missing key)
         - delete any S3 objects not referenced by userDoc.files
           (only inside userId/, never outside)
    4. Reconcile folder vs userDoc.files via folderFiles:
         - if a folder file is missing from userDoc.files: ingest it
           (same chokepoint as op #1)
         - if a userDoc.files entry is missing from the folder: mark
           the entry as `missing: true` (don't delete — user may
           re-add later from another device)
    5. Ensure agent exists; if userDoc.assignedAgentId doesn't resolve
       in DO, create a new agent and overwrite the field.
    6. Ensure KB exists; if userDoc.kbId doesn't resolve, create a new
       KB and trigger one indexing job covering everything currently
       in the data source. Overwrite kbId on userDoc.
    7. Return { rebuilt: [...], skipped: [...], elapsed }
  idempotent: re-running is a no-op once cloud matches the doc.
```

The client's role in Restore reduces to: send the state, stream the
bytes, watch the indexing progress. No client-side orchestration of
"first do meds, then summary, then chats, then agent instructions" —
all of that is just fields on the `userDoc` that already flow back
verbatim in step 2.

### 4. Sign in (no cloud change needed)

```
read maia-state.json (or fetch from /api/user-doc/full if signed in
                      on a fresh device)
hydrate the UI from userDoc
```

If the local folder is intact and the cloud is healthy, nothing needs
to be rebuilt. Restore is only invoked when the cloud is broken.

## File types are open-ended

Apple Health is **a property** of a PDF, detected by reading the PDF's
first page and matching the export footer text. It's one of many
detections that may apply to a file. The schema should treat the
detection result, not the detection input, as the durable fact.

```
userDoc.files[i] = {
  fileName: "Health Records - Adrian Gropper - 2026-05-08.pdf",
  bucketKey: "agropper/agropper-kb-20260508/Health_Records_-_Adrian_Gropper_-_2026-05-08.pdf",
  fileSize: 11313152,
  mimeType: "application/pdf",
  sha256: "a4d9...",
  addedAt: "2026-05-08T13:07:39Z",
  // Detection results, all optional, set by the ingest chokepoint:
  isAppleHealth: true,        // PDF first-page footer match
  isFhir: false,              // not an XML at all
  // Future: isCcd, isClaim, isImagingReport, …
}
```

Lists / categories / meds-from-AH / etc. read from these flags. When a
new file type matters, add a flag and a detector; existing files keep
working because absent flags are falsy.

## Derived state (categories, summaries) ages with content

The current code has `appleHealthCategoriesBuiltAt` — a boolean "have
we ever built." That's why a replaced Apple Health PDF leaves stale
categories forever.

Replace with content-keyed:

```
userDoc.derived = {
  appleHealthCategories: {
    sourceBucketKey: "...",
    sourceSha256: "a4d9...",
    builtAt: "...",
    files: [ "Medications.md", "Conditions.md", ... ]
  },
  // ... future derivations
}
```

On every Lists view (or whenever the UI needs categories), compare
`sourceSha256` against the current AH file's `sha256`. If they differ,
rebuild. If the AH file is gone, clear.

The same pattern applies to the Patient Summary: derived from the
KB, valid as long as the KB hasn't changed. We could go further and
track a KB-content hash, but that's a Phase 3 polish.

## What this design removes

Stuff that goes away once the proposal lands. Every one of these
exists today as a band-aid for the mis-framed model:

- `/api/files/register` — folded into `POST /api/files`.
- `/api/user-file-metadata` — same.
- Client-side `detectAppleHealthFromBucket` calls (six call sites in
  ChatInterface.vue + MyStuffDialog.vue).
- Filename-based AH heuristics (one remaining doc comment, all live
  code already removed).
- `RestoreWizard.executeRestore`'s 9-step client orchestration —
  becomes one HTTP call.
- The `restore-state-incomplete` log entry — `maia-state.json` is
  always a full backup, so "incomplete" stops being possible.
- The `markRestoreComplete` / `postRestoreLockUntil` grace window —
  no longer needed because Restore doesn't kick off the wizard flow's
  side effects in the first place.
- The `kb-attached` polling loop in the medications-phase transition —
  same reason.
- The "selective" `saveLocalSnapshot` mirroring logic — replaced by
  one GET + one write.

## What this design keeps

- The Restore-in-progress sentinel in `localStorage` and the boot-time
  resume path (page-reload recovery). That's orthogonal to where state
  lives.
- The folder-diff log entries (`restore-folder-added` /
  `restore-folder-removed`). The reconciliation in step 4 of Restore
  emits these.
- The maia-log.pdf entries themselves — they're a user-facing audit
  log of what the server did, and the new server-side rehydrate
  endpoint can emit them at the same granularity.
- The two known follow-up issues from the archived doc (DO API
  timeout crashing Node, missing `resend` package). Both are still
  pre-existing and worth fixing in their own changes.

## Implementation plan

### Phase 1 — Full-doc backup and restore (1–2 days)

Goal: replace selective mirroring with whole-doc round-trip. Closes
the entire "Apple Health flag survives Restore" bug class and several
others.

1. `GET /api/user-doc/full` — returns the entire userDoc as JSON
   (minus genuinely-secret fields like `agentApiKey`).
2. `PUT /api/account/rehydrate` — accepts the doc plus
   `folderFiles[]`. Implements steps 1–7 of the Restore section
   above. Re-uses existing helpers (`ensureUserAgent`,
   `setupKnowledgeBase`, etc.).
3. `MaiaState` shape becomes `{ schemaVersion, exportedAt, userDoc,
   folder }`. Old per-field MaiaState fields kept for one release as
   read-only migration source.
4. `saveLocalSnapshot` rewrites to: fetch `/api/user-doc/full`,
   write to disk. One function, one HTTP call, no field plumbing.
5. `RestoreWizard.executeRestore` rewrites to: read state, list
   folder, PUT rehydrate, stream missing bytes, poll indexing
   progress. The current 9-step orchestration becomes ~50 lines.

### Phase 2 — Single file-ingest chokepoint (half a day)

Goal: every file mutation goes through one endpoint that does
detection, persistence, and KB indexing. Removes the nine setters
problem and future-proofs for FHIR/XML/image file types.

1. New `POST /api/files` endpoint per the spec in section "Add a
   file" above.
2. Existing callers — wizard upload, MyStuff upload, file-rename,
   manual add — all switch to this. Their per-site detection code
   deletes.
3. `userDoc.files[i]` shape standardizes to include `sha256` and
   `mimeType`. Migration on read fills these for legacy entries.

### Phase 3 — Content-keyed derived state (half a day)

Goal: stop showing stale categories / summaries / extracts when the
source file changes.

1. `userDoc.derived.appleHealthCategories` carries
   `{ sourceBucketKey, sourceSha256, builtAt, files }`.
2. Lists.vue's category load compares `sourceSha256` to the current
   AH file's `sha256`. Mismatch → call `POST /api/files/lists/
   process-initial-file`, which is allowed to *replace* the derived
   record.
3. Same pattern for Patient Summary if we want it auto-invalidated
   when KB changes (deferrable).

### Phase 4 — Schema versioning + auto-migrate (1 day)

Goal: forward-compatibility. When the schema changes, old snapshots
don't lose data on Restore.

1. `MaiaState.schemaVersion` bumps on every breaking change.
2. Server-side migration table: `migrate[v→v+1]` functions, applied
   in sequence by `PUT /api/account/rehydrate`.
3. Logged in maia-log.pdf so the user sees "Restored from a v3
   backup; migrated to v5."

## Open questions

1. **Where does file ingest happen during Restore?** The folder may
   have hundreds of MB of files. Two options: (a) client streams
   each file as a multipart in a follow-up POST per missing
   bucketKey, or (b) the rehydrate endpoint accepts a tarball.
   (a) is simpler; (b) is faster on slow connections. Default to (a).

2. **What about secrets in the userDoc?** `agentApiKey` is regenerable
   by DO on demand. Don't include in `/api/user-doc/full`; the
   rehydrate endpoint regenerates it via `recreateAgentApiKey` and
   stores the new value.

3. **What about the cloud being healthy but the doc being out of
   sync?** E.g. user uses MAIA in browser A, doesn't sign out,
   signs in on browser B. Browser B's `maia-state.json` is older
   than the live `userDoc`. Today: a sync conflict. Proposal:
   `GET /api/user-doc/full` always returns the live doc; sign-in on a
   second device pulls cloud → folder, not folder → cloud. Restore is
   only the cloud-is-broken path.

4. **The DO Droplet rebuild.** The proposal says cloud is fully
   disposable, including the droplet. Today the CouchDB password is
   derived from `DIGITALOCEAN_TOKEN` — that's already covered. But
   recreating a droplet takes ~2 minutes. Restore should show
   appropriate progress messaging during that window.

5. **Schema for non-PDF file types.** Apple Health is a property of a
   PDF. FHIR is a *whole-file* format (an XML). PNG/JPEG aren't
   structured at all. The `userDoc.files[i]` shape needs both
   "what kind of file is this" (`mimeType` + `kind`) and "what
   detections matched" (`isAppleHealth` etc.). Worth sketching
   end-to-end before Phase 2 lands so the schema is stable.

## What to build first

Phase 1 alone — the full-doc backup and restore — eliminates the
recurring "the Apple Health badge disappears after Restore" bug class
without any new detection plumbing. The detection code that exists
today keeps working; we just stop dropping its results.

Phase 2 is the bigger architectural cleanup but doesn't have to gate
fixing the user-visible regression. Sequence: Phase 1 first, test,
ship; then Phase 2 in a separate change.
