<template>
  <q-dialog :model-value="modelValue" persistent @update:model-value="$emit('update:modelValue', $event)">
    <q-card style="min-width: 560px; max-width: 680px">
      <q-card-section>
        <div class="text-h6">
          {{ phase === 'complete' ? 'Restore Complete' : 'Restoring Your MAIA' }}
        </div>
        <div v-if="phase !== 'complete'" class="text-caption text-grey-7 q-mt-xs">
          Rebuilding cloud account for <strong>{{ userId }}</strong> from local backup
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

/** Get the KB name for this user, creating one if needed */
const resolveKbName = async (uid: string): Promise<string | null> => {
  try {
    const resp = await fetch(`/api/user-status?userId=${encodeURIComponent(uid)}`, { credentials: 'include' });
    if (resp.ok) {
      const data = await resp.json();
      if (data.kbName) return data.kbName;
    }
  } catch { /* fall through */ }
  // Default KB name pattern
  return `${uid}-kb`;
};

const buildRestoreItems = () => {
  const items: RestoreItem[] = [];
  const state = props.localState;
  const files = state?.files || [];

  // Individual file lines
  for (const f of files) {
    items.push({
      key: `file:${f.fileName}`,
      label: f.fileName,
      needed: true,
      status: 'pending'
    });
  }

  // Agent deployment
  items.push({ key: 'agent', label: 'Deploy AI Agent', needed: true, status: 'pending' });

  // Knowledge Base indexing
  if (files.length > 0) {
    items.push({ key: 'kb', label: 'Index Knowledge Base', needed: true, status: 'pending' });
  }

  // Current Medications (from local state)
  if (state?.currentMedications) {
    items.push({ key: 'medications', label: 'Restore Current Medications', needed: true, status: 'pending' });
  }

  // Patient Summary (from local state)
  if (state?.patientSummary) {
    items.push({ key: 'summary', label: 'Restore Patient Summary', needed: true, status: 'pending' });
  }

  // Saved Chats
  const chatCount = Array.isArray(state?.savedChats?.chats) ? state.savedChats.chats.length : 0;
  if (chatCount > 0) {
    items.push({ key: 'chats', label: `Restore ${chatCount} saved chat${chatCount === 1 ? '' : 's'}`, needed: true, status: 'pending' });
  }

  // Agent Instructions
  if (state?.agentInstructions) {
    items.push({ key: 'instructions', label: 'Restore Agent Instructions', needed: true, status: 'pending' });
  }

  restoreItems.value = items;
};

const executeRestore = async () => {
  phase.value = 'execute';
  const uid = props.userId;
  const state = props.localState;
  const files = state?.files || [];
  let filesUploaded = 0;

  console.log(`[RestoreWizard] executeRestore starting for ${uid}`);
  console.log(`[RestoreWizard] Local state: files=${files.length}, meds=${!!state?.currentMedications}, summary=${!!state?.patientSummary}, chats=${state?.savedChats?.chats?.length || 0}, instructions=${!!state?.agentInstructions}`);
  console.log(`[RestoreWizard] Folder handle: ${!!props.localFolderHandle}, Safari files: ${props.safariFolderFiles?.length || 0}`);

  try {
    // Resolve KB name for file uploads
    const kbName = await resolveKbName(uid);
    console.log(`[RestoreWizard] Resolved KB name: ${kbName}`);

    // 1. Upload files to KB folder so they're ready for indexing
    const uploadFile = async (file: File, fileName: string) => {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('userId', uid);
      if (kbName) {
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
        } else {
          console.log(`[RestoreWizard] files/register OK for ${fileName}`);
        }
      } catch (regError: any) {
        console.error(`[RestoreWizard] files/register network error:`, regError?.message);
      }
      return data;
    };

    console.log(`[RestoreWizard] Step 1: Upload ${files.length} files. hasHandle=${!!props.localFolderHandle}, hasSafariFiles=${!!props.safariFolderFiles}`);
    if (files.length > 0 && props.localFolderHandle) {
      for (const fileInfo of files) {
        const key = `file:${fileInfo.fileName}`;
        updateItem(key, { status: 'running' });
        try {
          console.log(`[RestoreWizard] Uploading file: ${fileInfo.fileName}`);
          const fileHandle = await props.localFolderHandle.getFileHandle(fileInfo.fileName);
          const file = await fileHandle.getFile();
          const result = await uploadFile(file, fileInfo.fileName);
          filesUploaded++;
          console.log(`[RestoreWizard] File uploaded: ${fileInfo.fileName}, bucketKey=${result?.fileInfo?.bucketKey}`);
          updateItem(key, { status: 'done', progress: 'Uploaded' });
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
        updateItem(key, { status: 'running' });
        try {
          await uploadFile(safariFile, fileInfo.fileName);
          filesUploaded++;
          updateItem(key, { status: 'done', progress: 'Uploaded' });
        } catch (e: any) {
          updateItem(key, { status: 'error', errorMsg: e?.message || 'Upload failed' });
        }
      }
    } else if (files.length > 0) {
      for (const fileInfo of files) {
        updateItem(`file:${fileInfo.fileName}`, { status: 'error', errorMsg: 'No local folder connected' });
      }
    }

    // 2. Deploy Agent (create if needed)
    console.log(`[RestoreWizard] Step 2: Deploy agent for ${uid}`);
    let agentDeployed = false;
    updateItem('agent', { status: 'running' });
    try {
      const syncResp = await fetch('/api/sync-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userId: uid, create: true })
      });
      const syncData = await syncResp.json();
      console.log(`[RestoreWizard] /api/sync-agent response: status=${syncResp.status}`, JSON.stringify(syncData));
      if (!syncResp.ok) throw new Error(syncData.error || 'Agent deployment failed');
      if (syncData.success || syncData.agentId) {
        agentDeployed = true;
        updateItem('agent', { status: 'done', progress: syncData.created ? 'Created' : 'Synced' });
        console.log(`[RestoreWizard] Agent deployed: agentId=${syncData.agentId}, created=${syncData.created}`);
      } else {
        throw new Error(syncData.error || 'Agent not available');
      }
    } catch (e: any) {
      console.error(`[RestoreWizard] Agent deploy failed:`, e?.message);
      updateItem('agent', { status: 'error', errorMsg: e?.message || 'Failed' });
    }

    // 3. Index Knowledge Base (files are already in KB folder)
    console.log(`[RestoreWizard] Step 3: Index KB. filesUploaded=${filesUploaded}`);
    const kbItem = restoreItems.value.find(i => i.key === 'kb' && i.needed);
    if (kbItem && filesUploaded > 0) {
      updateItem('kb', { status: 'running', progress: 'Creating...' });
      try {
        console.log(`[RestoreWizard] Calling /api/update-knowledge-base for ${uid}`);
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
        const jobId = indexData.jobId;

        if (jobId) {
          updateItem('kb', { progress: 'Indexing...' });
          let done = false;
          let attempts = 0;
          while (!done && attempts < 120) {
            await new Promise(r => setTimeout(r, 3000));
            try {
              const statusResp = await fetch(`/api/kb-indexing-status/${jobId}`, { credentials: 'include' });
              if (statusResp.ok) {
                const statusData = await statusResp.json();
                if (statusData.status === 'completed' || statusData.completed) {
                  done = true;
                  const tokens = statusData.tokenCount || statusData.total_tokens || 0;
                  updateItem('kb', { status: 'done', progress: tokens ? `${tokens.toLocaleString()} tokens indexed` : 'Indexed' });
                } else if (statusData.status === 'failed') {
                  throw new Error(statusData.error || 'Indexing failed');
                } else {
                  const tokens = statusData.tokenCount || statusData.total_tokens || 0;
                  const tokenStr = tokens > 0 ? ` — ${tokens.toLocaleString()} tokens` : '';
                  updateItem('kb', { progress: `Indexing...${tokenStr} (${Math.round((attempts * 3) / 60)}m)` });
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
          updateItem('kb', { status: 'done', progress: 'Created' });
        }
      } catch (e: any) {
        updateItem('kb', { status: 'error', errorMsg: e?.message || 'Failed' });
      }
    } else if (kbItem) {
      updateItem('kb', { status: 'error', errorMsg: 'No files uploaded' });
    }

    // 4. Restore Current Medications
    console.log(`[RestoreWizard] Step 4: Restore medications. has=${!!state?.currentMedications}`);
    const medsItem = restoreItems.value.find(i => i.key === 'medications' && i.needed);
    if (medsItem && state?.currentMedications) {
      updateItem('medications', { status: 'running' });
      try {
        const resp = await fetch('/api/user-current-medications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ userId: uid, currentMedications: state.currentMedications })
        });
        if (!resp.ok) throw new Error(`Save failed: ${resp.status}`);
        updateItem('medications', { status: 'done', progress: 'Saved' });
      } catch (e: any) {
        updateItem('medications', { status: 'error', errorMsg: e?.message || 'Failed' });
      }
    }

    // 5. Restore Patient Summary
    console.log(`[RestoreWizard] Step 5: Restore summary. has=${!!state?.patientSummary}`);
    const summaryItem = restoreItems.value.find(i => i.key === 'summary' && i.needed);
    if (summaryItem && state?.patientSummary) {
      updateItem('summary', { status: 'running' });
      try {
        const resp = await fetch('/api/patient-summary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ userId: uid, summary: state.patientSummary })
        });
        if (!resp.ok) throw new Error(`Save failed: ${resp.status}`);
        updateItem('summary', { status: 'done', progress: 'Saved' });
      } catch (e: any) {
        updateItem('summary', { status: 'error', errorMsg: e?.message || 'Failed' });
      }
    }

    // 6. Restore Saved Chats
    console.log(`[RestoreWizard] Step 6: Restore chats. count=${state?.savedChats?.chats?.length || 0}`);
    const chatsItem = restoreItems.value.find(i => i.key === 'chats' && i.needed);
    if (chatsItem && state?.savedChats?.chats) {
      updateItem('chats', { status: 'running' });
      try {
        const chats = state.savedChats.chats;
        let restored = 0;
        for (const chat of chats) {
          try {
            await fetch('/api/save-group-chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({
                userId: uid,
                chatId: chat._id || chat.chatId,
                messages: chat.messages || [],
                title: chat.title || 'Restored chat',
                providerKey: chat.providerKey || 'Private AI'
              })
            });
            restored++;
          } catch { /* continue */ }
        }
        updateItem('chats', { status: 'done', progress: `${restored} restored` });
      } catch (e: any) {
        updateItem('chats', { status: 'error', errorMsg: e?.message || 'Failed' });
      }
    }

    // 7. Restore Agent Instructions (only if agent was deployed)
    console.log(`[RestoreWizard] Step 7: Restore instructions. has=${!!state?.agentInstructions}, agentDeployed=${agentDeployed}`);
    const instrItem = restoreItems.value.find(i => i.key === 'instructions' && i.needed);
    if (instrItem && state?.agentInstructions) {
      if (!agentDeployed) {
        console.warn(`[RestoreWizard] Skipping instructions — agent not deployed`);
        updateItem('instructions', { status: 'error', errorMsg: 'Agent not deployed' });
      } else {
        updateItem('instructions', { status: 'running' });
        try {
          const resp = await fetch('/api/agent-instructions', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ userId: uid, instructions: state.agentInstructions })
          });
          if (!resp.ok) throw new Error(`Save failed: ${resp.status}`);
          updateItem('instructions', { status: 'done', progress: 'Saved' });
        } catch (e: any) {
          updateItem('instructions', { status: 'error', errorMsg: e?.message || 'Failed' });
        }
      }
    }

    // Build summary
    console.log(`[RestoreWizard] All steps complete. Items:`, restoreItems.value.map(i => `${i.key}:${i.status}`).join(', '));
    const doneItems = restoreItems.value.filter(i => i.status === 'done');
    const errorItems = restoreItems.value.filter(i => i.status === 'error');
    const parts: string[] = [];
    if (filesUploaded > 0) parts.push(`${filesUploaded} file${filesUploaded === 1 ? '' : 's'} uploaded`);
    if (doneItems.some(i => i.key === 'agent')) parts.push('agent deployed');
    if (doneItems.some(i => i.key === 'kb')) parts.push('knowledge base indexed');
    if (doneItems.some(i => i.key === 'medications')) parts.push('medications restored');
    if (doneItems.some(i => i.key === 'summary')) parts.push('summary restored');
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
