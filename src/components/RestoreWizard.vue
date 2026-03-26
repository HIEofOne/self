<template>
  <q-dialog :model-value="modelValue" persistent @update:model-value="$emit('update:modelValue', $event)">
    <q-card style="min-width: 560px; max-width: 680px">
      <q-card-section>
        <div class="text-h6">
          {{ phase === 'assess' ? 'Checking Account...' : phase === 'explain' ? 'Restore Your MAIA' : phase === 'execute' ? 'Restoring...' : 'Restore Complete' }}
        </div>
      </q-card-section>

      <!-- Assessment phase: spinner -->
      <q-card-section v-if="phase === 'assess'" class="text-center q-py-lg">
        <q-spinner size="2.5em" color="primary" />
        <div class="text-body2 text-grey-7 q-mt-md">Checking what needs to be restored...</div>
      </q-card-section>

      <!-- Explanation phase: checklist of what will be restored -->
      <q-card-section v-else-if="phase === 'explain'" class="text-body2">
        <p>Some cloud resources for <strong>{{ userId }}</strong> are missing. The following will be restored from your local backup:</p>
        <q-list dense class="q-mt-sm">
          <q-item v-for="item in restoreItems" :key="item.key" dense>
            <q-item-section avatar style="min-width: 28px">
              <q-icon :name="item.needed ? 'check_box_outline_blank' : 'check_box'" :color="item.needed ? 'grey-5' : 'green'" size="sm" />
            </q-item-section>
            <q-item-section>
              <q-item-label>{{ item.label }}</q-item-label>
              <q-item-label caption v-if="item.detail">{{ item.detail }}</q-item-label>
            </q-item-section>
          </q-item>
        </q-list>
      </q-card-section>

      <!-- Execution phase: live checklist with progress -->
      <q-card-section v-else-if="phase === 'execute'" class="text-body2">
        <q-list dense>
          <q-item v-for="item in restoreItems" :key="item.key" dense>
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
              </q-item-label>
              <q-item-label v-if="item.status === 'error' && item.errorMsg" caption class="text-negative">{{ item.errorMsg }}</q-item-label>
            </q-item-section>
          </q-item>
        </q-list>
      </q-card-section>

      <!-- Completion phase -->
      <q-card-section v-else class="text-body2">
        <div class="text-center q-py-md">
          <q-icon name="cloud_done" color="green" size="3em" />
          <div class="text-h6 text-green q-mt-sm">All Restored</div>
          <p class="q-mt-md text-grey-7">Your MAIA account has been fully restored from your local backup.</p>
          <div v-if="restoreSummary" class="text-caption text-grey-6 q-mt-sm">{{ restoreSummary }}</div>
        </div>
      </q-card-section>

      <q-card-actions align="right">
        <q-btn v-if="phase === 'explain'" flat label="Cancel" color="grey-7" @click="$emit('update:modelValue', false)" />
        <q-btn v-if="phase === 'explain'" unelevated label="Start Restore" color="primary" @click="executeRestore" />
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
  detail?: string;
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

const phase = ref<'assess' | 'explain' | 'execute' | 'complete'>('assess');
const restoreItems = ref<RestoreItem[]>([]);
const restoreSummary = ref('');

const buildRestoreItems = () => {
  const items: RestoreItem[] = [];
  const health = props.cloudHealth;
  const state = props.localState;

  // Database/user doc (only if destroyed — normally ok)
  if (health?.database && !health.database.ok) {
    items.push({
      key: 'database',
      label: 'Recreate user account',
      detail: `Restore ${props.userId} in cloud database`,
      needed: true,
      status: 'pending'
    });
  }

  // Files upload
  const fileCount = state?.files?.length || 0;
  if (health?.spacesFiles && !health.spacesFiles.ok && fileCount > 0) {
    items.push({
      key: 'files',
      label: `Upload ${fileCount} file${fileCount === 1 ? '' : 's'} to cloud storage`,
      detail: state?.files?.map(f => f.fileName).join(', '),
      needed: true,
      status: 'pending'
    });
  } else {
    items.push({ key: 'files', label: 'Cloud storage', detail: 'Already available', needed: false, status: 'skipped' });
  }

  // Knowledge Base
  if (health?.knowledgeBase && !health.knowledgeBase.ok) {
    const tokens = state?.kbStats?.tokenCount || 0;
    items.push({
      key: 'kb',
      label: `Create Knowledge Base and index ${fileCount} file${fileCount === 1 ? '' : 's'}`,
      detail: tokens > 0 ? `~${tokens.toLocaleString()} tokens` : undefined,
      needed: true,
      status: 'pending'
    });
  } else {
    items.push({ key: 'kb', label: 'Knowledge Base', detail: 'Already available', needed: false, status: 'skipped' });
  }

  // Agent
  if (health?.agent && !health.agent.ok) {
    items.push({
      key: 'agent',
      label: 'Deploy AI Agent',
      detail: state?.agentInstructions ? 'With saved instructions' : undefined,
      needed: true,
      status: 'pending'
    });
  } else {
    items.push({ key: 'agent', label: 'AI Agent', detail: 'Already available', needed: false, status: 'skipped' });
  }

  // Medications
  if (state?.currentMedications) {
    items.push({
      key: 'medications',
      label: 'Restore Current Medications',
      needed: true,
      status: 'pending'
    });
  }

  // Patient Summary
  if (state?.patientSummary) {
    items.push({
      key: 'summary',
      label: 'Restore Patient Summary',
      needed: true,
      status: 'pending'
    });
  }

  // Saved Chats
  const chatCount = Array.isArray(state?.savedChats?.chats) ? state.savedChats.chats.length : 0;
  if (chatCount > 0) {
    items.push({
      key: 'chats',
      label: `Restore ${chatCount} Saved Chat${chatCount === 1 ? '' : 's'}`,
      needed: true,
      status: 'pending'
    });
  }

  // Agent Instructions
  if (state?.agentInstructions) {
    items.push({
      key: 'instructions',
      label: 'Restore Agent Instructions',
      needed: true,
      status: 'pending'
    });
  }

  restoreItems.value = items;
};

const updateItem = (key: string, updates: Partial<RestoreItem>) => {
  const idx = restoreItems.value.findIndex(i => i.key === key);
  if (idx >= 0) {
    restoreItems.value[idx] = { ...restoreItems.value[idx], ...updates };
  }
};

const executeRestore = async () => {
  phase.value = 'execute';
  const uid = props.userId;
  const state = props.localState;
  let filesUploaded = 0;

  try {
    // 0. Recreate user doc if destroyed
    const dbItem = restoreItems.value.find(i => i.key === 'database' && i.needed);
    if (dbItem) {
      updateItem('database', { status: 'running' });
      try {
        const resp = await fetch('/api/account/recreate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ userId: uid })
        });
        if (!resp.ok) throw new Error('Failed to recreate account');
        updateItem('database', { status: 'done' });
      } catch (e: any) {
        updateItem('database', { status: 'error', errorMsg: e?.message || 'Failed' });
        // Can't continue without user doc
        phase.value = 'complete';
        restoreSummary.value = 'Account recreation failed. Cannot proceed with restore.';
        return;
      }
    }

    // 1. Upload files
    const filesItem = restoreItems.value.find(i => i.key === 'files' && i.needed);
    if (filesItem && props.localFolderHandle) {
      updateItem('files', { status: 'running', progress: '0/' + (state?.files?.length || 0) });
      const folderFiles = state?.files || [];
      for (let i = 0; i < folderFiles.length; i++) {
        const fileInfo = folderFiles[i];
        try {
          const fileHandle = await props.localFolderHandle.getFileHandle(fileInfo.fileName);
          const file = await fileHandle.getFile();
          const formData = new FormData();
          formData.append('file', file);
          formData.append('userId', uid);
          await fetch('/api/files/upload', {
            method: 'POST',
            credentials: 'include',
            body: formData
          });
          filesUploaded++;
          updateItem('files', { progress: `${filesUploaded}/${folderFiles.length}` });
        } catch (e) {
          console.warn(`[RestoreWizard] Failed to upload ${fileInfo.fileName}:`, e);
        }
      }
      updateItem('files', { status: 'done', progress: `${filesUploaded} uploaded` });
    } else if (filesItem && props.safariFolderFiles) {
      // Safari: use the File objects directly
      updateItem('files', { status: 'running', progress: '0/' + props.safariFolderFiles.length });
      for (let i = 0; i < props.safariFolderFiles.length; i++) {
        const file = props.safariFolderFiles[i];
        try {
          const formData = new FormData();
          formData.append('file', file);
          formData.append('userId', uid);
          await fetch('/api/files/upload', {
            method: 'POST',
            credentials: 'include',
            body: formData
          });
          filesUploaded++;
          updateItem('files', { progress: `${filesUploaded}/${props.safariFolderFiles.length}` });
        } catch (e) {
          console.warn(`[RestoreWizard] Failed to upload ${file.name}:`, e);
        }
      }
      updateItem('files', { status: 'done', progress: `${filesUploaded} uploaded` });
    } else if (filesItem) {
      // Files need restoring but no folder handle or Safari files available
      updateItem('files', { status: 'error', errorMsg: 'No local folder connected. Files cannot be uploaded.' });
      console.warn('[RestoreWizard] Files needed but no folder handle or Safari files available');
    }

    // 2. Create/index Knowledge Base
    const kbItem = restoreItems.value.find(i => i.key === 'kb' && i.needed);
    if (kbItem) {
      updateItem('kb', { status: 'running', progress: 'Creating...' });
      try {
        const indexResp = await fetch('/api/update-knowledge-base', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ userId: uid })
        });
        if (!indexResp.ok) throw new Error('KB update failed');
        const indexData = await indexResp.json();
        const jobId = indexData.jobId;

        if (jobId) {
          updateItem('kb', { progress: 'Indexing...' });
          // Poll for completion
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
                  updateItem('kb', { status: 'done', progress: tokens ? `${tokens.toLocaleString()} tokens` : 'Complete' });
                } else if (statusData.status === 'failed') {
                  throw new Error(statusData.error || 'Indexing failed');
                } else {
                  updateItem('kb', { progress: `Indexing... (${Math.round((attempts * 3) / 60)}m)` });
                }
              }
            } catch {
              // continue polling
            }
            attempts++;
          }
          if (!done) {
            updateItem('kb', { status: 'done', progress: 'Indexing in background' });
          }
        } else {
          updateItem('kb', { status: 'done', progress: 'Created' });
        }
      } catch (e: any) {
        updateItem('kb', { status: 'error', errorMsg: e?.message || 'Failed' });
      }
    }

    // 3. Deploy Agent
    const agentItem = restoreItems.value.find(i => i.key === 'agent' && i.needed);
    if (agentItem) {
      updateItem('agent', { status: 'running' });
      try {
        const syncResp = await fetch('/api/sync-agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ userId: uid })
        });
        if (!syncResp.ok) throw new Error('Agent sync failed');
        updateItem('agent', { status: 'done' });
      } catch (e: any) {
        updateItem('agent', { status: 'error', errorMsg: e?.message || 'Failed' });
      }
    }

    // 4. Restore Medications
    const medsItem = restoreItems.value.find(i => i.key === 'medications' && i.needed);
    if (medsItem && state?.currentMedications) {
      updateItem('medications', { status: 'running' });
      try {
        await fetch('/api/user-current-medications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ userId: uid, medications: state.currentMedications })
        });
        updateItem('medications', { status: 'done' });
      } catch (e: any) {
        updateItem('medications', { status: 'error', errorMsg: e?.message || 'Failed' });
      }
    }

    // 5. Restore Patient Summary
    const summaryItem = restoreItems.value.find(i => i.key === 'summary' && i.needed);
    if (summaryItem && state?.patientSummary) {
      updateItem('summary', { status: 'running' });
      try {
        await fetch('/api/patient-summary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ userId: uid, summary: state.patientSummary })
        });
        updateItem('summary', { status: 'done' });
      } catch (e: any) {
        updateItem('summary', { status: 'error', errorMsg: e?.message || 'Failed' });
      }
    }

    // 6. Restore Saved Chats
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
          } catch {
            // continue with next chat
          }
        }
        updateItem('chats', { status: 'done', progress: `${restored} restored` });
      } catch (e: any) {
        updateItem('chats', { status: 'error', errorMsg: e?.message || 'Failed' });
      }
    }

    // 7. Restore Agent Instructions
    const instrItem = restoreItems.value.find(i => i.key === 'instructions' && i.needed);
    if (instrItem && state?.agentInstructions) {
      updateItem('instructions', { status: 'running' });
      try {
        await fetch('/api/agent-instructions', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ instructions: state.agentInstructions })
        });
        updateItem('instructions', { status: 'done' });
      } catch (e: any) {
        updateItem('instructions', { status: 'error', errorMsg: e?.message || 'Failed' });
      }
    }

    // Build summary
    const doneItems = restoreItems.value.filter(i => i.status === 'done' && i.needed);
    const errorItems = restoreItems.value.filter(i => i.status === 'error');
    restoreSummary.value = `${doneItems.length} item${doneItems.length === 1 ? '' : 's'} restored${errorItems.length > 0 ? `, ${errorItems.length} failed` : ''}.`;

    phase.value = 'complete';
  } catch (e) {
    console.error('[RestoreWizard] Unexpected error:', e);
    restoreSummary.value = 'Restore completed with errors.';
    phase.value = 'complete';
  }
};

// Auto-assess when dialog opens
watch(() => props.modelValue, (open) => {
  if (open) {
    phase.value = 'assess';
    buildRestoreItems();
    // If we already have cloudHealth, skip to explain
    if (props.cloudHealth) {
      phase.value = 'explain';
    }
  }
}, { immediate: true });
</script>
