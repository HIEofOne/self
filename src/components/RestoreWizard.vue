<template>
  <q-dialog :model-value="modelValue" persistent @update:model-value="$emit('update:modelValue', $event)">
    <q-card style="min-width: 560px; max-width: 680px">
      <q-card-section>
        <div class="text-h6">
          {{ phase === 'complete' ? 'Restore Complete' : 'Restoring Your MAIA' }}
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
        <q-btn v-if="phase === 'complete'" unelevated label="Continue" color="primary" @click="$emit('restore-complete')" />
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
}>();

defineEmits<{
  'update:modelValue': [value: boolean];
  'restore-complete': [];
}>();

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

const buildRestoreItems = () => {
  const items: RestoreItem[] = [];
  const state = props.localState;
  const files = state?.files || [];

  // Individual file lines
  for (const f of files) {
    // Detect Apple Health files by filename pattern (same as used elsewhere in the app)
    const isAppleHealth = /^apple/i.test(f.fileName) && /\.pdf$/i.test(f.fileName);
    items.push({
      key: `file:${f.fileName}`,
      label: f.fileName,
      needed: true,
      status: 'pending',
      isAppleHealth
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

  // Saved Chats
  const chatCount = Array.isArray(state?.savedChats?.chats) ? state.savedChats.chats.length : 0;
  if (chatCount > 0) {
    items.push({ key: 'chats', label: `Restore ${chatCount} saved chat${chatCount === 1 ? '' : 's'}`, needed: true, status: 'pending' });
  }

  restoreItems.value = items;
};

const executeRestore = async () => {
  phase.value = 'execute';
  const uid = props.userId;
  const state = props.localState;
  const files = state?.files || [];
  let filesUploaded = 0;
  let filesUploadedToKB = 0;

  try {
    // Resolve KB name for file uploads
    const kbName = await resolveKbName(uid);

    // 1. Upload files — KB-bound files go to KB folder, archived-only files go to root (auto-archived later)
    const uploadFile = async (file: File, fileName: string, toKB: boolean = true) => {
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
      // Register file in user doc so KB update can find it
      try {
        const regResp = await fetch('/api/files/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            userId: uid,
            fileName,
            bucketKey: data.fileInfo?.bucketKey,
            fileSize: data.fileInfo?.size
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

    if (files.length > 0 && props.localFolderHandle) {
      for (const fileInfo of files) {
        const key = `file:${fileInfo.fileName}`;
        // Only upload to KB folder if the file was previously indexed or pending indexing.
        // Files that were only in archived/ (not_in_kb) go to root → auto-archived on next Saved Files open.
        const shouldGoToKB = fileInfo.cloudStatus === 'indexed' || fileInfo.cloudStatus === 'pending';
        updateItem(key, { status: 'running' });
        try {
          const fileHandle = await props.localFolderHandle.getFileHandle(fileInfo.fileName);
          const file = await fileHandle.getFile();
          await uploadFile(file, fileInfo.fileName, shouldGoToKB);
          filesUploaded++;
          if (shouldGoToKB) filesUploadedToKB++;
          updateItem(key, { status: 'done', progress: shouldGoToKB ? 'Uploaded to KB' : 'Uploaded to archive' });
        } catch (e: any) {
          console.error(`[RestoreWizard] File upload failed: ${fileInfo.fileName}:`, e?.message);
          updateItem(key, { status: 'error', errorMsg: e?.message || 'Upload failed' });
        }
      }
    } else if (files.length > 0 && props.safariFolderFiles) {
      for (const fileInfo of files) {
        const key = `file:${fileInfo.fileName}`;
        const safariFile = props.safariFolderFiles.find(f => f.name === fileInfo.fileName);
        if (!safariFile) {
          updateItem(key, { status: 'error', errorMsg: 'File not found in local folder' });
          continue;
        }
        const shouldGoToKB = fileInfo.cloudStatus === 'indexed' || fileInfo.cloudStatus === 'pending';
        updateItem(key, { status: 'running' });
        try {
          await uploadFile(safariFile, fileInfo.fileName, shouldGoToKB);
          filesUploaded++;
          if (shouldGoToKB) filesUploadedToKB++;
          updateItem(key, { status: 'done', progress: shouldGoToKB ? 'Uploaded to KB' : 'Uploaded to archive' });
        } catch (e: any) {
          updateItem(key, { status: 'error', errorMsg: e?.message || 'Upload failed' });
        }
      }
    } else if (files.length > 0) {
      for (const fileInfo of files) {
        updateItem(`file:${fileInfo.fileName}`, { status: 'error', errorMsg: 'No local folder connected' });
      }
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
    const hasMetadata = state?.currentMedications || state?.patientSummary || state?.savedChats?.chats?.length || state?.agentInstructions;
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
            savedChats: state?.savedChats || null,
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
        }
        if (restoreItems.value.find(i => i.key === 'summary' && i.needed)) {
          updateItem('summary', r.summary ? { status: 'done', progress: 'Restored' } : { status: 'error', errorMsg: 'Not saved' });
        }
        if (restoreItems.value.find(i => i.key === 'chats' && i.needed)) {
          updateItem('chats', { status: 'done', progress: r.chats > 0 ? `${r.chats} restored` : 'None' });
        }
        if (restoreItems.value.find(i => i.key === 'instructions' && i.needed)) {
          if (!agentDeployed) {
            updateItem('instructions', { status: 'error', errorMsg: 'Agent not deployed' });
          } else {
            updateItem('instructions', r.instructions ? { status: 'done', progress: 'Applied' } : { status: 'error', errorMsg: 'Not saved' });
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
      } catch (e: any) {
        console.error(`[RestoreWizard] Lists restore failed:`, e?.message);
        updateItem('lists', { status: 'error', errorMsg: e?.message || 'Failed' });
      }
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
