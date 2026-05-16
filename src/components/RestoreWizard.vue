<template>
  <q-dialog :model-value="modelValue" persistent @update:model-value="emit('update:modelValue', $event)">
    <q-card style="min-width: 560px; max-width: 680px">
      <q-card-section>
        <div class="row items-center no-wrap">
          <div class="text-h6 col">
            {{ phase === 'complete' ? 'Restore Complete' : 'Restoring Your MAIA' }}
          </div>
          <q-btn flat round dense icon="close" color="grey-6" @click="handleClose">
            <q-tooltip>Close restore wizard</q-tooltip>
          </q-btn>
        </div>
        <div v-if="phase !== 'complete'" class="text-caption text-grey-7 q-mt-xs">
          Rebuilding cloud account for <strong>{{ userId }}</strong> from local backup. This can take 5 to 60 minutes.
        </div>
      </q-card-section>

      <!-- Live progress checklist -->
      <q-card-section v-if="phase === 'execute'" class="text-body2">
        <q-list dense>
          <q-item v-for="item in restoreItems" :key="item.key" dense class="q-py-xs">
            <q-item-section avatar style="min-width: 28px">
              <q-spinner v-if="item.status === 'running'" size="sm" color="primary" />
              <q-icon v-else-if="item.status === 'done'" name="check_circle" color="green" size="sm" />
              <q-icon v-else-if="item.status === 'error'" name="error" color="negative" size="sm" />
              <q-icon v-else name="radio_button_unchecked" color="grey-4" size="sm" />
            </q-item-section>
            <q-item-section>
              <q-item-label :class="{ 'text-grey-5': item.status === 'pending' }">
                {{ item.label }}
                <q-chip v-if="item.isAppleHealth" color="blue-6" text-color="white" size="sm" dense class="q-ml-xs">Apple Health</q-chip>
                <span v-if="item.status === 'running' && item.progress" class="text-primary text-caption q-ml-sm">{{ item.progress }}</span>
                <span v-if="item.status === 'done' && item.progress" class="text-green text-caption q-ml-sm">{{ item.progress }}</span>
              </q-item-label>
              <q-item-label v-if="item.status === 'error' && item.errorMsg" caption class="text-negative">{{ item.errorMsg }}</q-item-label>
            </q-item-section>
          </q-item>
        </q-list>
      </q-card-section>

      <!-- Completion phase -->
      <q-card-section v-else-if="phase === 'complete'" class="text-body2">
        <div class="text-center q-py-md">
          <q-icon name="cloud_done" color="green" size="3em" />
          <div class="text-h6 text-green q-mt-sm">All Restored</div>
          <p class="q-mt-md text-grey-7">Your MAIA account has been fully restored from your local backup.</p>
          <div v-if="restoreSummary" class="text-caption text-grey-6 q-mt-sm">{{ restoreSummary }}</div>
        </div>
      </q-card-section>

      <q-card-actions align="right">
        <q-btn v-if="phase === 'complete'" unelevated label="Continue" color="primary" @click="emit('restore-complete')" />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import type { MaiaState } from '../utils/localFolder';

interface RestoreItem {
  key: string;
  label: string;
  needed: boolean;
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped';
  progress?: string;
  errorMsg?: string;
  isAppleHealth?: boolean;
}

interface CloudHealth {
  database?: { ok: boolean; error?: string };
  agent?: { ok: boolean; error?: string };
  knowledgeBase?: { ok: boolean; error?: string };
  spacesFiles?: { ok: boolean; error?: string; count?: number };
}

const props = defineProps<{
  modelValue: boolean;
  userId: string;
  cloudHealth: CloudHealth | null;
  localState: MaiaState | null;
  localFolderHandle: FileSystemDirectoryHandle | null;
  safariFolderFiles?: File[] | null;
  kbName?: string | null;
  testMode?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  'restore-complete': [];
}>();

const logProvisioningEvent = async (eventData: Record<string, any>) => {
  let delivered = false;
  try {
    const resp = await fetch('/api/provisioning-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId: props.userId, ...eventData })
    });
    // fetch only throws on network failure; a 401 is a resolved promise
    // with ok=false. The server now also returns 200 with
    // {success:false} when it couldn't persist (so the browser logs no
    // error line) — treat that as "not delivered" too.
    if (resp.ok) {
      const body = await resp.json().catch(() => ({}));
      delivered = body?.success !== false;
    }
  } catch (err) {
    console.warn('Failed to log provisioning event:', eventData.event, err);
  }
  if (!delivered) {
    // Server didn't accept it (session gone during destroy/restore is
    // the common case). Buffer locally so maia-log.pdf still shows it.
    try {
      const { bufferLogEvent } = await import('../utils/localFolder');
      bufferLogEvent({ userId: props.userId, ...eventData });
    } catch { /* ignore */ }
  }
};

const handleClose = () => {
  if (phase.value === 'complete') {
    emit('restore-complete');
  } else {
    // Allow closing mid-restore — it continues in the background
    emit('update:modelValue', false);
  }
};

const phase = ref<'execute' | 'complete'>('execute');
const restoreItems = ref<RestoreItem[]>([]);
const restoreSummary = ref('');

const updateItem = (key: string, updates: Partial<RestoreItem>) => {
  const idx = restoreItems.value.findIndex(i => i.key === key);
  if (idx >= 0) {
    restoreItems.value[idx] = { ...restoreItems.value[idx], ...updates };
  }
};

/** Get the KB name for this user — prefer the prop passed from recreate response */
const resolveKbName = async (uid: string): Promise<string | null> => {
  // 1. Use the kbName prop (set at user doc creation time, always correct)
  if (props.kbName) return props.kbName;
  // 2. Fall back to user-status (which now also falls back to userDoc.kbName)
  try {
    const resp = await fetch(`/api/user-status?userId=${encodeURIComponent(uid)}`, { credentials: 'include' });
    if (resp.ok) {
      const data = await resp.json();
      if (data.kbName) return data.kbName;
    }
  } catch { /* fall through */ }
  // 3. Last resort — should not happen if recreate worked correctly
  console.warn(`[RestoreWizard] Could not resolve kbName for ${uid}, using fallback`);
  return `${uid}-kb`;
};

// Rebuild the My Lists categories from the Apple Health PDF. Both restore
// paths (legacy executeRestore and v2 executeRehydrate) need this: the
// lists-restore step only writes a single restored.md, NOT the per-
// category files (Medications.md, Conditions.md, …) the Lists tab
// renders. process-initial-file regenerates them and self-heals
// userDoc.files[].isAppleHealth. Returns true if a rebuild was triggered.
const rebuildAppleHealthCategories = async (
  files: Array<{ fileName: string; bucketKey?: string; isAppleHealth?: boolean }>
): Promise<boolean> => {
  try {
    const APPLE_EXPORT_FOOTER = 'This summary displays certain health information made available to you by your healthcare provider and may not completely';
    const appleFooterNorm = APPLE_EXPORT_FOOTER.toLowerCase().replace(/\s+/g, ' ').trim();
    let appleBucketKey: string | null = null;
    let appleFileName: string | null = null;

    // Fast path: a file flagged isAppleHealth (content-detected at Setup,
    // preserved through the v2 userDoc round-trip).
    const flagged = files.find(f => f.isAppleHealth && f.bucketKey);
    if (flagged?.bucketKey) {
      appleBucketKey = flagged.bucketKey;
      appleFileName = flagged.fileName;
    } else {
      // Slow path: content-detect across every restored PDF. Heals
      // older snapshots that predate the isAppleHealth field.
      for (const f of files) {
        if (!f.bucketKey || !/\.pdf$/i.test(f.fileName)) continue;
        try {
          const r = await fetch(`/api/files/parse-pdf-first-page/${encodeURIComponent(f.bucketKey)}`, { credentials: 'include' });
          if (!r.ok) continue;
          const data = await r.json();
          const text = String(data?.firstPageText || '').toLowerCase().replace(/\s+/g, ' ').trim();
          if (text.includes(appleFooterNorm)) {
            appleBucketKey = f.bucketKey;
            appleFileName = f.fileName;
            break;
          }
        } catch { /* next */ }
      }
    }
    if (appleBucketKey && appleFileName) {
      await fetch('/api/files/lists/process-initial-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ bucketKey: appleBucketKey, fileName: appleFileName })
      });
      return true;
    }
    console.log('[RestoreWizard] No Apple Health file detected — skipping category rebuild');
    return false;
  } catch (e: any) {
    console.warn('[RestoreWizard] Category rebuild failed (non-fatal):', e?.message);
    return false;
  }
};

const buildRestoreItems = () => {
  const items: RestoreItem[] = [];
  const state = props.localState;
  const files = state?.files || [];

  // Individual file lines. The Apple Health badge follows the flag that
  // was preserved in maia-state.json — detection was done content-based
  // (PDF first-page footer) during the original Setup; we never re-guess
  // from the filename here.
  for (const f of files) {
    items.push({
      key: `file:${f.fileName}`,
      label: f.fileName,
      needed: true,
      status: 'pending',
      isAppleHealth: !!(f as any).isAppleHealth
    });
  }

  // Knowledge Base indexing (starts as soon as files are in Spaces, does NOT need agent)
  // Only needed if at least one file was previously indexed or pending — archived-only files skip KB
  const hasKBFiles = files.some(f => f.cloudStatus === 'indexed' || f.cloudStatus === 'pending');
  if (files.length > 0 && hasKBFiles) {
    items.push({ key: 'kb', label: 'Index Knowledge Base', needed: true, status: 'pending' });
  }

  // Agent deployment (runs in parallel with KB indexing)
  items.push({ key: 'agent', label: 'Deploy AI Agent', needed: true, status: 'pending' });

  // Agent Instructions (needs agent deployed)
  if (state?.agentInstructions) {
    items.push({ key: 'instructions', label: 'Restore Agent Instructions', needed: true, status: 'pending' });
  }

  // Current Medications (from local backup)
  if (state?.currentMedications) {
    items.push({ key: 'medications', label: 'Restore Current Medications', needed: true, status: 'pending' });
  }

  // Patient Summary (from local backup)
  if (state?.patientSummary) {
    items.push({ key: 'summary', label: 'Restore Patient Summary', needed: true, status: 'pending' });
  }

  // My Lists (from local backup)
  if (state?.listsMarkdown) {
    items.push({ key: 'lists', label: 'Restore My Lists', needed: true, status: 'pending' });
  }

  // Saved Chats — handle both formats: { chats: [...] } or bare array
  const chatsArray = Array.isArray(state?.savedChats?.chats) ? state.savedChats.chats
    : Array.isArray(state?.savedChats) ? state.savedChats : [];
  const chatCount = chatsArray.length;
  if (chatCount > 0) {
    items.push({ key: 'chats', label: `Restore ${chatCount} saved chat${chatCount === 1 ? '' : 's'}`, needed: true, status: 'pending' });
  }

  restoreItems.value = items;
};

// ── Phase 1: new rehydrate flow ─────────────────────────────────────
// One PUT replaces userDoc on the server; server tells us which files
// are missing in Spaces; we stream them up; second PUT confirms KB is
// rebuilt and indexing is triggered. The cloud doesn't have to remember
// anything — we push everything that matters from maia-state.json.
//
// Falls back to the legacy executeRestore body below ONLY if it throws
// before the userDoc is pushed (rehydratePastNoReturn still false).
// After that point every error is handled in-line and the wizard always
// reaches phase='complete' — falling back later would re-run a full
// 7-minute restore on top of a half-rehydrated account.
let rehydratePastNoReturn = false;
const executeRehydrate = async () => {
  const state = props.localState as any;
  const uid = props.userId;
  const userDoc = state?.userDoc;
  if (!userDoc) throw new Error('rehydrate: no userDoc in state');

  // Build the folder inventory (used for added/removed diff and for
  // looking up the source file when uploading missing bytes).
  let folderInventory: Array<{ name: string; size?: number; mtime?: number }> = [];
  let folderNameToHandle: Record<string, FileSystemFileHandle> = {};
  let folderNameToSafariFile: Record<string, File> = {};
  if (props.localFolderHandle) {
    try {
      const { listFolderFiles } = await import('../utils/localFolder');
      const entries = await listFolderFiles(props.localFolderHandle);
      for (const e of entries) {
        const lower = e.name.toLowerCase();
        if (lower === 'maia-log.pdf' || lower === 'maia-state.json' || lower.endsWith('.webloc')) continue;
        folderInventory.push({ name: e.name, size: e.size, mtime: e.lastModified });
        folderNameToHandle[e.name] = e.fileHandle;
      }
    } catch (e) {
      console.warn('[Rehydrate] Folder scan failed:', e);
    }
  } else if (props.safariFolderFiles) {
    for (const f of props.safariFolderFiles) {
      const lower = f.name.toLowerCase();
      if (lower === 'maia-log.pdf' || lower === 'maia-state.json' || lower.endsWith('.webloc')) continue;
      folderInventory.push({ name: f.name, size: f.size, mtime: f.lastModified });
      folderNameToSafariFile[f.name] = f;
    }
  }

  // Pass 1: push the full userDoc; server reports which file bytes it
  // doesn't have in Spaces yet. THIS is the only place executeRehydrate
  // is allowed to throw — before it, falling back to the legacy path is
  // safe (no server-side mutation yet). After pass 1 succeeds the userDoc
  // has been replaced server-side; from here on every failure is handled
  // in-line and we ALWAYS reach phase='complete'. Throwing past this
  // point would make executeRestore's catch run the legacy path on top
  // of a half-rehydrated account — that's the "Restore ran twice / a
  // second 7-minute index" bug.
  const r1 = await fetch('/api/account/rehydrate', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      schemaVersion: state.schemaVersion || 2,
      userDoc,
      folderFiles: folderInventory
    })
  });
  if (!r1.ok) {
    const err = await r1.json().catch(() => ({}));
    throw new Error(err.error || `rehydrate failed: ${r1.status}`);
  }
  rehydratePastNoReturn = true;
  const data1 = await r1.json();

  // Surface the folder diff in maia-log.pdf, same shape the legacy path
  // already emits, so the user-facing log stays consistent.
  const folderAdded: string[] = Array.isArray(data1.folderDiff?.added) ? data1.folderDiff.added : [];
  const folderRemoved: string[] = Array.isArray(data1.folderDiff?.removed) ? data1.folderDiff.removed : [];
  if (folderAdded.length > 0) {
    logProvisioningEvent({
      event: 'restore-folder-added',
      count: folderAdded.length,
      files: folderAdded,
      action: 'will ingest'
    });
  }
  if (folderRemoved.length > 0) {
    // The server already dropped these from userDoc.files before the
    // pass-1 save, so they will not be re-requested or re-indexed.
    logProvisioningEvent({
      event: 'restore-folder-removed',
      count: folderRemoved.length,
      files: folderRemoved,
      action: 'dropped from cloud'
    });
  }

  // Mark agent and per-file checklist as "running" → done based on what
  // the server reports back.
  if (data1.rebuilt?.agent) {
    updateItem('agent', { status: 'done', progress: data1.rebuilt.agent === 'created' ? 'Recreated' : 'Reused' });
  }

  // Stream missing file bytes back. The server already knows where each
  // file belongs (its bucketKey was supplied in the userDoc).
  const missing = Array.isArray(data1.missingFiles) ? data1.missingFiles : [];
  let filesUploaded = 0;
  let totalUploadedBytes = 0;
  for (const m of missing) {
    const key = `file:${m.fileName}`;
    updateItem(key, { status: 'running' });
    try {
      let file: File | null = null;
      if (folderNameToHandle[m.fileName]) {
        file = await folderNameToHandle[m.fileName].getFile();
      } else if (folderNameToSafariFile[m.fileName]) {
        file = folderNameToSafariFile[m.fileName];
      }
      if (!file) {
        updateItem(key, { status: 'error', errorMsg: 'Not found in local folder' });
        continue;
      }
      const fd = new FormData();
      fd.append('file', file);
      fd.append('bucketKey', m.bucketKey);
      const upResp = await fetch('/api/files/restore-bytes', {
        method: 'POST',
        credentials: 'include',
        body: fd
      });
      if (!upResp.ok) {
        const t = await upResp.text().catch(() => '');
        updateItem(key, { status: 'error', errorMsg: `Upload failed: ${upResp.status} ${t}` });
        continue;
      }
      filesUploaded++;
      totalUploadedBytes += file.size;
      updateItem(key, { status: 'done', progress: 'Uploaded' });
    } catch (e: any) {
      updateItem(key, { status: 'error', errorMsg: e?.message || 'Upload failed' });
    }
  }
  // For files that were already in S3 (not in `missing`), mark done now.
  for (const f of (userDoc.files || [])) {
    const k = `file:${f.fileName}`;
    if (!missing.some((mf: any) => mf.bucketKey === f.bucketKey)) {
      updateItem(k, { status: 'done', progress: 'Already in cloud' });
    }
  }

  if (filesUploaded > 0) {
    logProvisioningEvent({
      event: 'files-uploaded',
      count: filesUploaded,
      totalKB: Math.round(totalUploadedBytes / 1024),
      method: 'restore-bytes'
    });
  }

  // Ingest folder-ADDED files. These are files the user dropped into
  // the local folder while signed out — they are NOT in userDoc.files,
  // so the server never listed them as "missing". Upload each to the
  // KB folder and register it so pass 2 + the KB reindex pick it up.
  // AH detection is content-based and happens in the category-rebuild
  // step below (we have no content-detected flag for new files yet).
  const addedFileEntries: Array<{ fileName: string; bucketKey: string }> = [];
  if (folderAdded.length > 0) {
    const kbName = await resolveKbName(uid);
    let addedUploaded = 0;
    let addedBytes = 0;
    for (const fileName of folderAdded) {
      const key = `file:${fileName}`;
      updateItem(key, { label: fileName, needed: true, status: 'running' });
      try {
        let file: File | null = null;
        if (folderNameToHandle[fileName]) {
          file = await folderNameToHandle[fileName].getFile();
        } else if (folderNameToSafariFile[fileName]) {
          file = folderNameToSafariFile[fileName];
        }
        if (!file) {
          updateItem(key, { status: 'error', errorMsg: 'Not found in local folder' });
          continue;
        }
        const fd = new FormData();
        fd.append('file', file);
        fd.append('userId', uid);
        if (kbName) {
          fd.append('isInitialImport', 'true');
          fd.append('subfolder', kbName);
        }
        const upResp = await fetch('/api/files/upload', {
          method: 'POST',
          credentials: 'include',
          body: fd
        });
        if (!upResp.ok) {
          const t = await upResp.text().catch(() => '');
          updateItem(key, { status: 'error', errorMsg: `Upload failed: ${upResp.status} ${t}` });
          continue;
        }
        const upData = await upResp.json();
        const bucketKey = upData?.fileInfo?.bucketKey;
        // Register so KB reindex (pass 2 / update-knowledge-base) finds
        // it. isAppleHealth is left false here; rebuildAppleHealthCategories
        // content-detects and self-heals the flag afterward.
        if (bucketKey) {
          try {
            await fetch('/api/files/register', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({
                userId: uid,
                fileName,
                bucketKey,
                fileSize: upData?.fileInfo?.size || file.size
              })
            });
          } catch (regErr: any) {
            console.error('[Rehydrate] register added file failed:', regErr?.message);
          }
          addedFileEntries.push({ fileName, bucketKey });
        }
        addedUploaded++;
        addedBytes += file.size;
        updateItem(key, { status: 'done', progress: 'Ingested (added in folder)' });
      } catch (e: any) {
        updateItem(key, { status: 'error', errorMsg: e?.message || 'Ingest failed' });
      }
    }
    if (addedUploaded > 0) {
      logProvisioningEvent({
        event: 'files-uploaded',
        count: addedUploaded,
        totalKB: Math.round(addedBytes / 1024),
        method: 'folder-added-ingest',
        files: addedFileEntries.map(e => e.fileName)
      });
    }
  }

  // Pass 2: now that all bytes are in S3, ask the server to finalize —
  // ensures KB exists and triggers indexing. This is also where any
  // newly-needed cloud resources get created.
  //
  // IMPORTANT: pass 1 + restore-bytes + /api/files/register have mutated
  // the SERVER's userDoc (folder-removed files dropped, folder-added
  // files registered). The client's in-memory `userDoc` is now stale —
  // sending it back would clobber those server-side changes. Re-fetch
  // the authoritative server doc and send THAT as the pass-2 body.
  let pass2Doc: any = userDoc;
  try {
    const fresh = await fetch('/api/user-doc/full', { credentials: 'include' });
    if (fresh.ok) {
      const fd = await fresh.json();
      if (fd && (fd.userDoc || fd.userId)) pass2Doc = fd.userDoc || fd;
    }
  } catch (e: any) {
    console.warn('[Rehydrate] pass-2 doc refetch failed, using client copy:', e?.message);
  }
  const r2 = await fetch('/api/account/rehydrate', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      schemaVersion: state.schemaVersion || 2,
      userDoc: pass2Doc,
      folderFiles: folderInventory
    })
  });
  if (!r2.ok) {
    const err = await r2.json().catch(() => ({}));
    throw new Error(err.error || `rehydrate pass-2 failed: ${r2.status}`);
  }
  const data2 = await r2.json();

  // Rebuild + reindex the KB. After a cloud destroy the KB, agent, and
  // Spaces files are all gone, so this is a full re-index (7+ min for a
  // typical 2-file set). /api/update-knowledge-base is ASYNC — it kicks
  // off the indexing job and returns 200 immediately. We MUST poll
  // /api/kb-indexing-status until the job actually completes, otherwise
  // the wizard races to "done" in milliseconds and the user is dropped
  // into a chat with an empty KB (the bug the user hit). This mirrors
  // the legacy path's polling loop exactly.
  {
    updateItem('kb', { status: 'running', progress: 'Creating knowledge base...' });
    const kbStartTime = Date.now();
    const kbResp = await fetch('/api/update-knowledge-base', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId: uid })
    });
    if (!kbResp.ok) {
      const errData = await kbResp.json().catch(() => ({}));
      updateItem('kb', { status: 'error', errorMsg: errData.message || `KB update failed: ${kbResp.status}` });
    } else {
      const indexData = await kbResp.json();
      const kbId = indexData.kbId;
      const jobId = indexData.jobId || kbId;
      const filesCount = indexData.filesIndexed || indexData.filesCount || 0;
      const seedTokens = indexData.totalTokens || indexData.tokenCount || 0;
      if (kbId) {
        updateItem('kb', { progress: 'Indexing...' });
        let done = false;
        let attempts = 0;
        // 300 × 3s = 15 min ceiling. Typical 2-file set is ~7-8 min.
        while (!done && attempts < 300) {
          await new Promise(r => setTimeout(r, 3000));
          try {
            const statusResp = await fetch(
              `/api/kb-indexing-status/${jobId}?userId=${encodeURIComponent(uid)}`,
              { credentials: 'include' }
            );
            if (statusResp.ok) {
              const sd = await statusResp.json();
              if (sd.completed || sd.backendCompleted) {
                done = true;
                const t = sd.tokens || sd.tokenCount || sd.total_tokens || seedTokens || 0;
                const f = sd.filesIndexed || filesCount || 0;
                const parts: string[] = [];
                if (f) parts.push(`${f} file${f === 1 ? '' : 's'}`);
                if (t) parts.push(`${Number(t).toLocaleString()} tokens`);
                updateItem('kb', { status: 'done', progress: parts.join(', ') || 'Indexed' });
                logProvisioningEvent({
                  event: 'kb-indexed',
                  tokens: Number(t) || 0,
                  fileCount: Number(f) || 0,
                  elapsedMs: Date.now() - kbStartTime
                });
              } else if (sd.status === 'INDEX_JOB_STATUS_FAILED') {
                throw new Error(sd.error || 'Indexing failed');
              } else {
                const t = sd.tokens || sd.tokenCount || 0;
                const tokenStr = Number(t) > 0 ? ` — ${Number(t).toLocaleString()} tokens` : '';
                const elapsedSec = attempts * 3;
                const mins = Math.floor(elapsedSec / 60);
                const secs = elapsedSec % 60;
                const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
                updateItem('kb', { progress: `Indexing...${tokenStr} (${timeStr})` });
              }
            }
          } catch (pollErr: any) {
            if (pollErr?.message?.includes('failed')) throw pollErr;
          }
          attempts++;
        }
        if (!done) {
          updateItem('kb', { status: 'done', progress: 'Indexing continues in background' });
          logProvisioningEvent({ event: 'kb-indexed', tokens: 0, fileCount: 0, elapsedMs: Date.now() - kbStartTime });
        }
      } else if (seedTokens > 0) {
        updateItem('kb', { status: 'done', progress: `${filesCount} file${filesCount === 1 ? '' : 's'}, ${Number(seedTokens).toLocaleString()} tokens` });
        logProvisioningEvent({ event: 'kb-indexed', tokens: Number(seedTokens), fileCount: Number(filesCount), elapsedMs: Date.now() - kbStartTime });
      } else {
        updateItem('kb', { status: 'done', progress: 'Created' });
      }
    }
  }

  // Rebuild My Lists categories from the Apple Health PDF (same as the
  // legacy path). userDoc.files carries the content-detected
  // isAppleHealth flag through the v2 round-trip, so the fast path
  // usually hits without re-parsing any PDF.
  try {
    // Include folder-added files so a newly-added Apple Health export
    // is content-detected and its categories built (it isn't in
    // userDoc.files yet on this client-side copy).
    const filesForRebuild = [...(userDoc.files || []), ...addedFileEntries];
    const rebuilt = await rebuildAppleHealthCategories(filesForRebuild);
    if (rebuilt) {
      updateItem('lists', { status: 'done', progress: 'Restored' });
      logProvisioningEvent({ event: 'lists-restored' });
    }
  } catch (e: any) {
    console.warn('[Rehydrate] Category rebuild failed (non-fatal):', e?.message);
  }

  // The metadata items (medications, summary, chats, instructions) are
  // already part of userDoc, so they're restored as a side effect of
  // pass 1. Mark them done in the UI and log the same events the legacy
  // path emitted, so maia-log.pdf reads the same as before.
  if (userDoc.currentMedications) {
    updateItem('medications', { status: 'done', progress: 'Restored' });
    logProvisioningEvent({
      event: 'medications-restored',
      lines: String(userDoc.currentMedications).split('\n').filter((l: string) => l.trim()).length
    });
  }
  if (userDoc.patientSummary || userDoc.patientSummaries?.length) {
    const summaryText = userDoc.patientSummary
      || (userDoc.patientSummaries && userDoc.patientSummaries[userDoc.patientSummaries.length - 1]?.text)
      || '';
    updateItem('summary', { status: 'done', progress: 'Restored' });
    if (summaryText) {
      logProvisioningEvent({
        event: 'summary-restored',
        lines: summaryText.split('\n').filter((l: string) => l.trim()).length,
        chars: summaryText.length
      });
    }
  }
  if (userDoc.agentInstructions) {
    updateItem('instructions', { status: 'done', progress: 'Applied' });
    logProvisioningEvent({ event: 'instructions-restored' });
  }
  if (Array.isArray(userDoc.savedChats?.chats) && userDoc.savedChats.chats.length > 0) {
    updateItem('chats', { status: 'done', progress: `${userDoc.savedChats.chats.length} restored` });
    logProvisioningEvent({ event: 'chats-restored', count: userDoc.savedChats.chats.length });
  }
  if (userDoc.listsMarkdown) {
    updateItem('lists', { status: 'done', progress: 'Restored' });
    logProvisioningEvent({ event: 'lists-restored' });
  }

  await logProvisioningEvent({ event: 'restore-complete' });
  restoreSummary.value = 'Account restored from local backup.';
  phase.value = 'complete';
};

const executeRestore = async () => {
  phase.value = 'execute';
  const uid = props.userId;
  const state = props.localState;
  const expectedFiles = state?.files || [];
  let filesUploaded = 0;
  let filesUploadedToKB = 0;

  // Bold start entry
  await logProvisioningEvent({
    event: 'restore-started',
    test: props.testMode || undefined,
    method: 'restore',
    client: {
      browser: navigator.userAgent,
      appUrl: window.location.origin,
      folder: 'restore',
      version: ''
    }
  });

  // Phase 1 of the local-first redesign: if maia-state.json is v2 (carries
  // a full userDoc backup), take the new rehydrate path. Otherwise fall
  // through to the legacy per-field reconstruction below. See
  // Documentation/NewRestore.md for the model.
  const stateAny = state as any;
  const hasV2 = !!(stateAny?.schemaVersion && stateAny.schemaVersion >= 2 && stateAny.userDoc);
  // Always log which path we're taking so the user / support can see it
  // in maia-log.pdf without inspecting the JSON.
  logProvisioningEvent({
    event: 'restore-path-chosen',
    path: hasV2 ? 'rehydrate-v2' : 'legacy-v1',
    snapshotSchemaVersion: stateAny?.schemaVersion || 1,
    hasUserDocInState: !!stateAny?.userDoc
  });
  if (hasV2) {
    rehydratePastNoReturn = false;
    try {
      await executeRehydrate();
      return;
    } catch (e: any) {
      if (rehydratePastNoReturn) {
        // The userDoc was already pushed and (likely) the KB indexed.
        // Falling back to the legacy path here would run a SECOND full
        // restore on top of a half-rehydrated account — the "Restore
        // ran twice / second 7-minute index" bug. Surface the error,
        // mark complete, and stop. The account is already mostly
        // restored; a reload + manual retry is safer than auto-rerun.
        console.error('[RestoreWizard] Rehydrate failed AFTER commit — NOT falling back:', e);
        logProvisioningEvent({
          event: 'restore-postcommit-error',
          reason: e?.message || 'post-commit failure'
        });
        restoreSummary.value = 'Account restored (with a post-step warning — see log).';
        phase.value = 'complete';
        return;
      }
      console.error('[RestoreWizard] Rehydrate failed before commit, falling back to legacy:', e);
      logProvisioningEvent({
        event: 'restore-fallback-to-legacy',
        reason: e?.message || 'rehydrate failed'
      });
      // fall through to legacy path (safe — no server mutation yet)
    }
  }

  // Folder diff: users can add/remove PDFs in Finder while signed out.
  // maia-state.json is the snapshot of "what the folder contained at last
  // sign-off"; the actual folder is the source of truth right now. Detect
  // both directions and surface them in maia-log.pdf so the user / support
  // can see why post-restore Saved Files differs from pre-sign-out.
  const MAIA_GENERATED = new Set(['maia-log.pdf', 'maia-state.json']);
  const isMaiaGenerated = (name: string) => {
    const lower = name.toLowerCase();
    return MAIA_GENERATED.has(lower) || lower.endsWith('.webloc');
  };
  let presentFileNames: string[] = [];
  if (props.localFolderHandle) {
    try {
      const { listFolderFiles } = await import('../utils/localFolder');
      const folderFiles = await listFolderFiles(props.localFolderHandle, { extensions: ['pdf'] });
      presentFileNames = folderFiles.map(f => f.name).filter(n => !isMaiaGenerated(n));
    } catch (e: any) {
      console.warn('[RestoreWizard] Folder scan failed:', e?.message);
    }
  } else if (props.safariFolderFiles) {
    presentFileNames = props.safariFolderFiles.map(f => f.name).filter(n => !isMaiaGenerated(n));
  }

  const expectedNameSet = new Set(expectedFiles.map(f => f.fileName));
  const presentNameSet = new Set(presentFileNames);
  const addedFiles = presentFileNames.filter(n => !expectedNameSet.has(n));
  const removedFiles = expectedFiles.map(f => f.fileName).filter(n => !presentNameSet.has(n));

  if (presentFileNames.length > 0 && (addedFiles.length > 0 || removedFiles.length > 0)) {
    if (addedFiles.length > 0) {
      logProvisioningEvent({
        event: 'restore-folder-added',
        count: addedFiles.length,
        files: addedFiles
      });
    }
    if (removedFiles.length > 0) {
      logProvisioningEvent({
        event: 'restore-folder-removed',
        count: removedFiles.length,
        files: removedFiles
      });
    }
  }

  // Build the actual upload set. Skip expected files that have been removed
  // from the folder (would error otherwise); treat folder-added files as new
  // KB-bound uploads alongside the previously-indexed set.
  const filesToRestore = expectedFiles.filter(f => presentNameSet.has(f.fileName));

  // Surface gaps in maia-state.json. If the snapshot is missing fields
  // that a fully-finished setup would have had, the user (or support) needs
  // to see that on the log so they know why post-restore tabs are empty.
  const stateGaps: string[] = [];
  if (!state?.currentMedications) stateGaps.push('Current Medications');
  if (!state?.patientSummary) stateGaps.push('Patient Summary');
  if (stateGaps.length > 0) {
    logProvisioningEvent({
      event: 'restore-state-incomplete',
      missing: stateGaps
    });
  }

  try {
    // Resolve KB name for file uploads
    const kbName = await resolveKbName(uid);

    // 1. Upload files — KB-bound files go to KB folder, archived-only files go to root (auto-archived later)
    const uploadFile = async (file: File, fileName: string, toKB: boolean = true, isAppleHealth: boolean = false) => {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('userId', uid);
      if (toKB && kbName) {
        formData.append('isInitialImport', 'true');
        formData.append('subfolder', kbName);
      }
      const resp = await fetch('/api/files/upload', {
        method: 'POST',
        credentials: 'include',
        body: formData
      });
      if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`);
      const data = await resp.json();
      // Register file in user doc so KB update can find it. The
      // isAppleHealth flag rides through the body so the server sets it
      // correctly on userDoc.files[] — detection is content-based, done
      // by the caller (either from preserved state, or from a post-upload
      // first-page parse for files added since last sign-off).
      try {
        const regResp = await fetch('/api/files/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            userId: uid,
            fileName,
            bucketKey: data.fileInfo?.bucketKey,
            fileSize: data.fileInfo?.size,
            ...(isAppleHealth ? { isAppleHealth: true } : {})
          })
        });
        if (!regResp.ok) {
          const regErr = await regResp.text().catch(() => '');
          console.error(`[RestoreWizard] files/register failed: ${regResp.status} ${regErr}`);
        }
      } catch (regError: any) {
        console.error(`[RestoreWizard] files/register network error:`, regError?.message);
      }
      return data;
    };

    let totalUploadedBytes = 0;
    const uploadedFileNames: string[] = [];
    let appleHealthCount = 0;

    // Track bucketKeys of folder-added files so we can content-detect them
    // for AH after upload (we don't have content for them in state).
    const addedBucketKeys: Array<{ fileName: string; bucketKey: string }> = [];

    if (filesToRestore.length > 0 && props.localFolderHandle) {
      for (const fileInfo of filesToRestore) {
        const key = `file:${fileInfo.fileName}`;
        const shouldGoToKB = fileInfo.cloudStatus === 'indexed' || fileInfo.cloudStatus === 'pending';
        // AH flag is preserved from maia-state.json (content-detected at
        // last Setup). No filename guessing.
        const stateIsAH = !!(fileInfo as any).isAppleHealth;
        updateItem(key, { status: 'running' });
        try {
          const fileHandle = await props.localFolderHandle.getFileHandle(fileInfo.fileName);
          const file = await fileHandle.getFile();
          await uploadFile(file, fileInfo.fileName, shouldGoToKB, stateIsAH);
          filesUploaded++;
          if (shouldGoToKB) filesUploadedToKB++;
          totalUploadedBytes += file.size;
          uploadedFileNames.push(fileInfo.fileName);
          if (stateIsAH) appleHealthCount++;
          updateItem(key, { status: 'done', progress: shouldGoToKB ? 'Uploaded to KB' : 'Uploaded to archive' });
        } catch (e: any) {
          console.error(`[RestoreWizard] File upload failed: ${fileInfo.fileName}:`, e?.message);
          updateItem(key, { status: 'error', errorMsg: e?.message || 'Upload failed' });
        }
      }
    } else if (filesToRestore.length > 0 && props.safariFolderFiles) {
      for (const fileInfo of filesToRestore) {
        const key = `file:${fileInfo.fileName}`;
        const safariFile = props.safariFolderFiles.find(f => f.name === fileInfo.fileName);
        if (!safariFile) {
          updateItem(key, { status: 'error', errorMsg: 'File not found in local folder' });
          continue;
        }
        const shouldGoToKB = fileInfo.cloudStatus === 'indexed' || fileInfo.cloudStatus === 'pending';
        const stateIsAH = !!(fileInfo as any).isAppleHealth;
        updateItem(key, { status: 'running' });
        try {
          await uploadFile(safariFile, fileInfo.fileName, shouldGoToKB, stateIsAH);
          filesUploaded++;
          if (shouldGoToKB) filesUploadedToKB++;
          totalUploadedBytes += safariFile.size;
          uploadedFileNames.push(fileInfo.fileName);
          if (stateIsAH) appleHealthCount++;
          updateItem(key, { status: 'done', progress: shouldGoToKB ? 'Uploaded to KB' : 'Uploaded to archive' });
        } catch (e: any) {
          updateItem(key, { status: 'error', errorMsg: e?.message || 'Upload failed' });
        }
      }
    } else if (expectedFiles.length > 0) {
      for (const fileInfo of expectedFiles) {
        updateItem(`file:${fileInfo.fileName}`, { status: 'error', errorMsg: 'No local folder connected' });
      }
    }

    // Upload folder-added files. We don't have a content-based AH flag for
    // these yet; we set isAppleHealth=false on register and the category-
    // rebuild step below content-detects them and re-calls /api/files/
    // register with isAppleHealth: true for the one that matches.
    if (addedFiles.length > 0 && props.localFolderHandle) {
      for (const fileName of addedFiles) {
        try {
          const fileHandle = await props.localFolderHandle.getFileHandle(fileName);
          const file = await fileHandle.getFile();
          const data = await uploadFile(file, fileName, true, false);
          filesUploaded++;
          filesUploadedToKB++;
          totalUploadedBytes += file.size;
          uploadedFileNames.push(fileName);
          if (data?.fileInfo?.bucketKey) {
            addedBucketKeys.push({ fileName, bucketKey: data.fileInfo.bucketKey });
          }
        } catch (e: any) {
          console.error(`[RestoreWizard] Added-file upload failed: ${fileName}:`, e?.message);
        }
      }
    } else if (addedFiles.length > 0 && props.safariFolderFiles) {
      for (const fileName of addedFiles) {
        const safariFile = props.safariFolderFiles.find(f => f.name === fileName);
        if (!safariFile) continue;
        try {
          const data = await uploadFile(safariFile, fileName, true, false);
          filesUploaded++;
          filesUploadedToKB++;
          totalUploadedBytes += safariFile.size;
          uploadedFileNames.push(fileName);
          if (data?.fileInfo?.bucketKey) {
            addedBucketKeys.push({ fileName, bucketKey: data.fileInfo.bucketKey });
          }
        } catch (e: any) {
          console.error(`[RestoreWizard] Added-file upload failed: ${fileName}:`, e?.message);
        }
      }
    }

    if (filesUploaded > 0) {
      logProvisioningEvent({
        event: 'files-uploaded',
        count: filesUploaded,
        totalKB: Math.round(totalUploadedBytes / 1024),
        files: uploadedFileNames,
        appleHealthCount
      });
    }

    // 2. Start KB indexing AND agent deployment IN PARALLEL
    // KB indexing only needs files in Spaces — it does NOT need the agent.
    // Agent deployment takes ~60-90s. KB creation + indexing is independent.
    // --- KB indexing promise (runs independently) ---
    const kbItem = restoreItems.value.find(i => i.key === 'kb' && i.needed);
    const kbPromise = (async () => {
      if (!kbItem || filesUploadedToKB === 0) {
        if (kbItem) updateItem('kb', { status: 'skipped', errorMsg: filesUploaded > 0 ? 'No files need indexing' : 'No files uploaded' });
        return;
      }
      updateItem('kb', { status: 'running', progress: 'Creating...' });
      const kbStartTime = Date.now();
      try {
        const indexResp = await fetch('/api/update-knowledge-base', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ userId: uid })
        });
        if (!indexResp.ok) {
          const errData = await indexResp.json().catch(() => ({}));
          console.error(`[RestoreWizard] KB update failed: status=${indexResp.status}`, JSON.stringify(errData));
          throw new Error(errData.message || `KB update failed: ${indexResp.status}`);
        }
        const indexData = await indexResp.json();
        const kbId = indexData.kbId;
        const jobId = indexData.jobId || kbId; // Prefer jobId for status polling
        const filesCount = indexData.filesIndexed || indexData.filesCount || 0;
        const tokens = indexData.totalTokens || indexData.tokenCount || 0;

        if (kbId) {
          updateItem('kb', { progress: 'Indexing...' });
          let done = false;
          let attempts = 0;
          while (!done && attempts < 120) {
            await new Promise(r => setTimeout(r, 3000));
            try {
              const statusResp = await fetch(`/api/kb-indexing-status/${jobId}?userId=${encodeURIComponent(uid)}`, { credentials: 'include' });
              if (statusResp.ok) {
                const statusData = await statusResp.json();
                if (statusData.completed || statusData.backendCompleted) {
                  done = true;
                  const t = statusData.tokens || statusData.tokenCount || statusData.total_tokens || tokens || 0;
                  const f = statusData.filesIndexed || filesCount || 0;
                  const parts = [];
                  if (f) parts.push(`${f} file${f === 1 ? '' : 's'}`);
                  if (t) parts.push(`${Number(t).toLocaleString()} tokens`);
                  updateItem('kb', { status: 'done', progress: parts.join(', ') || 'Indexed' });
                  logProvisioningEvent({
                    event: 'kb-indexed',
                    tokens: t || 0,
                    fileCount: f || 0,
                    elapsedMs: Date.now() - kbStartTime
                  });
                } else if (statusData.status === 'INDEX_JOB_STATUS_FAILED') {
                  throw new Error(statusData.error || 'Indexing failed');
                } else {
                  const t = statusData.tokens || statusData.tokenCount || 0;
                  const tokenStr = Number(t) > 0 ? ` — ${Number(t).toLocaleString()} tokens` : '';
                  const elapsedSec = attempts * 3;
                  const mins = Math.floor(elapsedSec / 60);
                  const secs = elapsedSec % 60;
                  const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
                  updateItem('kb', { progress: `Indexing...${tokenStr} (${timeStr})` });
                }
              }
            } catch (pollErr: any) {
              if (pollErr?.message?.includes('failed')) throw pollErr;
            }
            attempts++;
          }
          if (!done) {
            updateItem('kb', { status: 'done', progress: 'Indexing continues in background' });
          }
        } else {
          // No kbId returned — check if indexing succeeded via token count
          if (tokens > 0) {
            updateItem('kb', { status: 'done', progress: `${filesCount} file${filesCount === 1 ? '' : 's'}, ${Number(tokens).toLocaleString()} tokens` });
          } else {
            updateItem('kb', { status: 'done', progress: 'Created' });
          }
        }
      } catch (e: any) {
        updateItem('kb', { status: 'error', errorMsg: e?.message || 'Failed' });
      }
    })();

    // --- Agent deployment promise (runs independently) ---
    let agentDeployed = false;
    const agentPromise = (async () => {
      updateItem('agent', { status: 'running' });
      const agentStartTime = Date.now();
      try {
        const syncResp = await fetch('/api/sync-agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ userId: uid, create: true })
        });
        const syncData = await syncResp.json();
        if (!syncResp.ok) throw new Error(syncData.error || 'Agent deployment failed');
        if (syncData.success || syncData.agentId) {
          // Poll for agent endpoint to become ready (deployment takes ~30-90s)
          updateItem('agent', { progress: 'Deploying... (0s)' });
          let endpointReady = !!syncData.agentEndpoint;
          let elapsedSeconds = 0;
          let lastStatus = 'Deploying';
          const maxSeconds = 200;
          const pollIntervalSec = 5;
          while (!endpointReady && elapsedSeconds < maxSeconds) {
            await new Promise(r => setTimeout(r, 1000));
            elapsedSeconds++;
            updateItem('agent', { progress: `${lastStatus}... (${elapsedSeconds}s)` });
            if (elapsedSeconds % pollIntervalSec === 0) {
              try {
                const statusResp = await fetch('/api/agent-setup-status', { credentials: 'include' });
                if (statusResp.ok) {
                  const statusData = await statusResp.json();
                  if (statusData.endpointReady) {
                    endpointReady = true;
                  } else if (statusData.status) {
                    lastStatus = statusData.status;
                  }
                }
              } catch { /* continue polling */ }
            }
          }
          agentDeployed = true;
          updateItem('agent', { status: 'done', progress: endpointReady ? 'Ready' : 'Deploying in background' });
          logProvisioningEvent({
            event: 'agent-deployed',
            agentId: syncData.agentId || null,
            elapsedMs: Date.now() - agentStartTime
          });
        } else {
          throw new Error(syncData.error || 'Agent not available');
        }
      } catch (e: any) {
        console.error(`[RestoreWizard] Agent deploy failed:`, e?.message);
        updateItem('agent', { status: 'error', errorMsg: e?.message || 'Failed' });
      }
    })();

    // Wait for BOTH to complete
    await Promise.all([kbPromise, agentPromise]);

    // 3. Restore metadata via single server-side coordinator
    // This batches medications, summary, chats, and instructions into one call
    const savedChatsArr = Array.isArray(state?.savedChats?.chats) ? state.savedChats.chats
      : Array.isArray(state?.savedChats) ? state.savedChats : [];
    const hasMetadata = state?.currentMedications || state?.patientSummary || savedChatsArr.length > 0 || state?.agentInstructions;
    if (hasMetadata) {
      for (const key of ['medications', 'summary', 'chats', 'instructions']) {
        const item = restoreItems.value.find(i => i.key === key && i.needed);
        if (item) updateItem(key, { status: 'running' });
      }

      try {
        const restoreResp = await fetch('/api/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            currentMedications: state?.currentMedications || null,
            patientSummary: state?.patientSummary || null,
            // Normalize savedChats to always be { chats: [...] } for the server
            savedChats: (() => {
              const arr = Array.isArray(state?.savedChats?.chats) ? state.savedChats.chats
                : Array.isArray(state?.savedChats) ? state.savedChats : [];
              return arr.length > 0 ? { chats: arr } : null;
            })(),
            agentInstructions: agentDeployed ? (state?.agentInstructions || null) : null
          })
        });

        if (!restoreResp.ok) {
          const errData = await restoreResp.json().catch(() => ({}));
          throw new Error(errData.error || `Restore failed: ${restoreResp.status}`);
        }

        const restoreData = await restoreResp.json();
        const r = restoreData.results || {};
        if (restoreItems.value.find(i => i.key === 'medications' && i.needed)) {
          updateItem('medications', r.medications ? { status: 'done', progress: 'Restored' } : { status: 'error', errorMsg: 'Not saved' });
          if (r.medications) {
            const medsText = state?.currentMedications || '';
            logProvisioningEvent({
              event: 'medications-restored',
              lines: medsText.split('\n').filter((l: string) => l.trim()).length
            });
          }
        }
        if (restoreItems.value.find(i => i.key === 'summary' && i.needed)) {
          updateItem('summary', r.summary ? { status: 'done', progress: 'Restored' } : { status: 'error', errorMsg: 'Not saved' });
          if (r.summary) {
            const summaryText = state?.patientSummary || '';
            logProvisioningEvent({
              event: 'summary-restored',
              lines: summaryText.split('\n').filter((l: string) => l.trim()).length,
              chars: summaryText.length
            });
          }
        }
        if (restoreItems.value.find(i => i.key === 'chats' && i.needed)) {
          updateItem('chats', { status: 'done', progress: r.chats > 0 ? `${r.chats} restored` : 'None' });
          if (r.chats > 0) {
            logProvisioningEvent({
              event: 'chats-restored',
              count: r.chats || 0
            });
          }
        }
        if (restoreItems.value.find(i => i.key === 'instructions' && i.needed)) {
          if (!agentDeployed) {
            updateItem('instructions', { status: 'error', errorMsg: 'Agent not deployed' });
          } else {
            updateItem('instructions', r.instructions ? { status: 'done', progress: 'Applied' } : { status: 'error', errorMsg: 'Not saved' });
            if (r.instructions) {
              logProvisioningEvent({ event: 'instructions-restored' });
            }
          }
        }
      } catch (e: any) {
        console.error(`[RestoreWizard] /api/restore failed:`, e?.message);
        for (const key of ['medications', 'summary', 'chats', 'instructions']) {
          const item = restoreItems.value.find(i => i.key === key && i.needed && i.status === 'running');
          if (item) updateItem(key, { status: 'error', errorMsg: e?.message || 'Failed' });
        }
      }
    }

    // 4. Restore Lists markdown to S3
    const listsItem = restoreItems.value.find(i => i.key === 'lists' && i.needed);
    if (listsItem && state?.listsMarkdown) {
      updateItem('lists', { status: 'running' });
      try {
        const listsResp = await fetch('/api/files/lists/restore-markdown', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ markdown: state.listsMarkdown })
        });
        if (!listsResp.ok) {
          const errData = await listsResp.json().catch(() => ({}));
          throw new Error(errData.error || `Lists restore failed: ${listsResp.status}`);
        }
        updateItem('lists', { status: 'done', progress: 'Restored' });
        logProvisioningEvent({ event: 'lists-restored' });
      } catch (e: any) {
        console.error(`[RestoreWizard] Lists restore failed:`, e?.message);
        updateItem('lists', { status: 'error', errorMsg: e?.message || 'Failed' });
      }
    }

    // 5. Re-extract Apple Health categories. The lists-restore step above
    // writes a single restored.md back to S3 but doesn't rebuild the
    // per-category files (Medications.md, Conditions.md, ...) that
    // Lists.vue renders from. Without this step, the My Lists tab is
    // empty after Restore even though "My Lists restored" was logged.
    //
    // To find the AH file we read the first page of each restored PDF
    // looking for the Apple Health export footer (same approach Setup
    // uses via detectAppleHealthFromBucket). Filename-based detection
    // is unreliable because the real Apple Health export is named
    // "Health Records - <Patient Name> - YYYY-MM-DD at HH.MM.SS.pdf"
    // — it does not start with "apple".
    try {
      const APPLE_EXPORT_FOOTER = 'This summary displays certain health information made available to you by your healthcare provider and may not completely';
      const appleFooterNorm = APPLE_EXPORT_FOOTER.toLowerCase().replace(/\s+/g, ' ').trim();
      const kbName = await resolveKbName(uid);
      const kbPrefix = `${uid}/${kbName}`;
      let appleBucketKey: string | null = null;
      let appleFileName: string | null = null;

      // Fast path: state.files preserves the AH flag (content-detected at
      // the original Setup). If we have it, no PDF parsing needed.
      const stateAH = filesToRestore.find(f => (f as any).isAppleHealth);
      if (stateAH) {
        appleBucketKey = `${kbPrefix}/${stateAH.fileName.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
        appleFileName = stateAH.fileName;
      } else {
        // Slow path: content-detect across every PDF we just uploaded.
        // This covers TWO cases:
        //   1. maia-state.json was written by an older version that didn't
        //      preserve isAppleHealth (the field is now in MaiaState but
        //      pre-fix snapshots have it absent on every file).
        //   2. Files added in Finder since last sign-off — they have no
        //      state entry at all.
        // We iterate ALL uploaded PDFs (state-known + added) rather than
        // just added ones, so older snapshots heal automatically.
        const stateKnownCandidates = filesToRestore
          .filter(f => /\.pdf$/i.test(f.fileName))
          .map(f => ({ fileName: f.fileName, bucketKey: `${kbPrefix}/${f.fileName.replace(/[^a-zA-Z0-9.-]/g, '_')}` }));
        const candidates = [...stateKnownCandidates, ...addedBucketKeys];
        for (const c of candidates) {
          try {
            const r = await fetch(`/api/files/parse-pdf-first-page/${encodeURIComponent(c.bucketKey)}`, { credentials: 'include' });
            if (!r.ok) continue;
            const data = await r.json();
            const text = String(data?.firstPageText || '').toLowerCase().replace(/\s+/g, ' ').trim();
            if (text.includes(appleFooterNorm)) {
              appleBucketKey = c.bucketKey;
              appleFileName = c.fileName;
              break;
            }
          } catch { /* try next */ }
        }
      }
      if (appleBucketKey && appleFileName) {
        // process-initial-file self-heals userDoc.files[].isAppleHealth
        // when it sees the AH footer in the markdown, so we don't need a
        // separate /api/files/register call here.
        await fetch('/api/files/lists/process-initial-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ bucketKey: appleBucketKey, fileName: appleFileName })
        });
      } else {
        console.log('[RestoreWizard] No Apple Health file detected — skipping category rebuild');
      }
    } catch (e: any) {
      console.warn('[RestoreWizard] Category rebuild failed (non-fatal):', e?.message);
    }

    // Build summary
    const doneItems = restoreItems.value.filter(i => i.status === 'done');
    const errorItems = restoreItems.value.filter(i => i.status === 'error');
    const parts: string[] = [];
    if (filesUploaded > 0) parts.push(`${filesUploaded} file${filesUploaded === 1 ? '' : 's'} uploaded`);
    if (doneItems.some(i => i.key === 'agent')) parts.push('agent deployed');
    if (doneItems.some(i => i.key === 'kb')) parts.push('knowledge base indexed');
    if (doneItems.some(i => i.key === 'medications')) parts.push('medications restored');
    if (doneItems.some(i => i.key === 'summary')) parts.push('summary restored');
    if (doneItems.some(i => i.key === 'lists')) parts.push('lists restored');
    if (doneItems.some(i => i.key === 'chats')) parts.push('chats restored');
    if (errorItems.length > 0) parts.push(`${errorItems.length} failed`);
    restoreSummary.value = parts.join(', ') + '.';
    await logProvisioningEvent({ event: 'restore-complete' });

    phase.value = 'complete';
  } catch (e) {
    console.error('[RestoreWizard] Unexpected error:', e);
    restoreSummary.value = 'Restore completed with errors.';
    phase.value = 'complete';
  }
};

// Auto-start when dialog opens
watch(() => props.modelValue, (open) => {
  if (open) {
    buildRestoreItems();
    executeRestore();
  }
}, { immediate: true });
</script>
