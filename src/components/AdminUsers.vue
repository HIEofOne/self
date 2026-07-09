<template>
  <q-page class="q-pa-md">
    <div class="q-mb-lg">
      <!-- Single combined status line, just before the header -->
      <div class="text-caption text-grey-7 q-mb-xs">
        Total Users: {{ totalUsers }} &nbsp;•&nbsp; Deep Link Users: {{ totalDeepLinkUsers }}
        <template v-if="passkeyConfig">
          &nbsp;•&nbsp; Passkey rpID: {{ passkeyConfig.rpID }}
          &nbsp;•&nbsp; Origin: {{ passkeyConfig.origin }}
        </template>
      </div>
      <div class="row items-center justify-between q-mb-xs">
        <div class="text-h4">
          User Administration
          <span class="text-caption text-grey-6 q-ml-sm">v{{ appVersion }}</span>
        </div>
        <q-btn
          flat
          dense
          color="negative"
          label="Sign Out"
          icon="logout"
          :loading="signingOut"
          @click="signOutAdmin"
        />
      </div>
      <!-- Customer balance collapsed to a single line just below the header -->
      <div class="text-caption text-grey-7 q-mb-md">
        <template v-if="balanceLoading">Customer balance: loading…</template>
        <template v-else-if="balanceError">
          <span class="text-negative">Customer balance: {{ balanceError }}</span>
          <span v-if="balanceHint" class="text-orange-9">&nbsp;({{ balanceHint }})</span>
        </template>
        <template v-else>
          Customer balance —
          <template v-for="(entry, i) in balanceEntries" :key="entry.key">
            <span v-if="i > 0">&nbsp;•&nbsp;</span><strong>{{ entry.label }}:</strong> {{ entry.value }}
          </template>
        </template>
      </div>

    <!-- Patient Groups management (Groups & AS feature — Documentation/Groups.md) -->
    <AdminGroups />
    </div>

    <q-table
      :rows="users"
      :columns="columns"
      row-key="userId"
      :loading="loading"
      :pagination="{ rowsPerPage: 50 }"
      class="admin-users-table"
    >
      <template v-slot:body-cell-userId="props">
        <q-td :props="props">
          <span class="text-weight-bold">{{ props.value }}</span>
          <span v-if="props.row.domain" class="text-grey-7"> ({{ props.row.domain }})</span>
        </q-td>
      </template>

      <template v-slot:body-cell-workflowStage="props">
        <q-td :props="props">
          <q-badge :color="getWorkflowStageColor(props.value)" :label="props.value" />
        </q-td>
      </template>

  <template v-slot:body-cell-hasPasskey="props">
    <q-td :props="props">
      <q-badge :color="props.value ? 'green' : 'grey'" :label="props.value ? 'Yes' : 'No'" />
    </q-td>
  </template>

      <template v-slot:body-cell-provisionedDate="props">
        <q-td :props="props">
          {{ formatDate(props.value) }}
        </q-td>
      </template>

      <template v-slot:body-cell-totalStorageMB="props">
        <q-td :props="props">
          {{ props.value.toFixed(2) }} MB
        </q-td>
      </template>

      <template v-slot:body-cell-deepLinkUsersCount="props">
        <q-td :props="props">
          {{ props.value }}
        </q-td>
      </template>

      <template v-slot:body-cell-groups="props">
        <q-td :props="props">
          <template v-if="props.row.groupNames && props.row.groupNames.length">
            <q-badge
              v-for="name in props.row.groupNames"
              :key="name"
              color="blue-1"
              text-color="primary"
              :label="name"
              class="q-mr-xs"
            />
          </template>
          <span v-else class="text-grey-5">—</span>
        </q-td>
      </template>

      <template v-slot:body-cell-actions="props">
        <q-td :props="props">
          <q-btn
            flat
            round
            dense
            color="primary"
            icon="refresh"
            @click="recoverUser(props.row.userId)"
            :loading="recoveringUsers.has(props.row.userId)"
            title="Recover provisioning - check DO API and update user document"
            class="q-mr-xs"
          />
          <q-btn
            flat
            round
            dense
            color="negative"
            icon="delete"
            @click="confirmDelete(props.row.userId)"
            :loading="deletingUsers.has(props.row.userId)"
          />
        </q-td>
      </template>
    </q-table>

    <q-card class="q-mt-lg">
      <q-card-section>
        <div class="text-h6 q-mb-sm">Usage List</div>
        <q-table
          :rows="usageList"
          :columns="usageColumns"
          row-key="date"
          dense
          :pagination="{ rowsPerPage: 10 }"
          :loading="loading"
        >
          <template v-slot:body-cell-date="props">
            <q-td :props="props">
              {{ formatDate(props.value) }}
            </q-td>
          </template>
          <template v-slot:body-cell-monthToDateUsage="props">
            <q-td :props="props">
              {{ props.value ?? '—' }}
            </q-td>
          </template>
          <template v-slot:body-cell-changeFromPrevious="props">
            <q-td :props="props">
              {{ props.value ?? '—' }}
            </q-td>
          </template>
          <template v-slot:body-cell-deletedUserId="props">
            <q-td :props="props">
              {{ props.value || '—' }}
            </q-td>
          </template>
        </q-table>
      </q-card-section>
    </q-card>

    <q-btn
      v-if="!loading"
      label="Refresh"
      color="primary"
      class="q-mt-md"
      @click="loadUsers"
    />
  </q-page>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useQuasar } from 'quasar';
import AdminGroups from './AdminGroups.vue';
import packageJson from '../../package.json';

const appVersion = packageJson.version;

const $q = useQuasar();

interface User {
  userId: string;
  domain: string | null;
  workflowStage: string;
  lastActivity: string;
  provisionedDate: string | null;
  totalStorageMB: number;
  filesIndexed: number;
  savedChatsCount: number;
  deepLinkUsersCount: number;
  hasPasskey: boolean;
  groupNames: string[];
}

interface PasskeyConfig {
  rpID: string;
  origin: string;
}

interface UsageEntry {
  date: string;
  monthToDateUsage: string | null;
  changeFromPrevious: string | null;
  deletedUserId: string | null;
}

const users = ref<User[]>([]);
const loading = ref(false);
const totalUsers = ref(0);
const totalDeepLinkUsers = ref(0);
const passkeyConfig = ref<PasskeyConfig | null>(null);
const usageList = ref<UsageEntry[]>([]);
const deletingUsers = ref(new Set<string>());
const recoveringUsers = ref(new Set<string>());
const signingOut = ref(false);
const balanceLoading = ref(false);
const balanceError = ref('');
const balanceHint = ref('');
const balanceData = ref<any | null>(null);

const columns = [
  {
    name: 'actions',
    label: 'Actions',
    align: 'center' as const,
    field: 'actions',
    sortable: false
  },
  {
    name: 'userId',
    required: true,
    label: 'User ID',
    align: 'left' as const,
    field: 'userId',
    sortable: true
  },
  {
    name: 'workflowStage',
    label: 'Workflow Stage',
    align: 'left' as const,
    field: 'workflowStage',
    sortable: true
  },
  {
    name: 'hasPasskey',
    label: 'Passkey',
    align: 'center' as const,
    field: 'hasPasskey',
    sortable: true
  },
  {
    name: 'lastActivity',
    label: 'Last Activity',
    align: 'left' as const,
    field: 'lastActivity',
    sortable: true
  },
  {
    name: 'provisionedDate',
    label: 'Provisioned On',
    align: 'left' as const,
    field: 'provisionedDate',
    sortable: true
  },
  {
    name: 'totalStorageMB',
    label: 'Storage (MB)',
    align: 'right' as const,
    field: 'totalStorageMB',
    sortable: true
  },
  {
    name: 'filesIndexed',
    label: 'Saved Files',
    align: 'center' as const,
    field: 'filesIndexed',
    sortable: true
  },
  {
    name: 'savedChatsCount',
    label: 'Saved Chats',
    align: 'center' as const,
    field: 'savedChatsCount',
    sortable: true
  },
  {
    name: 'deepLinkUsersCount',
    label: '# Deep Link Users',
    align: 'center' as const,
    field: 'deepLinkUsersCount',
    sortable: true
  },
  {
    name: 'groups',
    label: 'Groups',
    align: 'left' as const,
    field: 'groupNames',
    sortable: false
  }
];

const usageColumns = [
  {
    name: 'date',
    label: 'Date',
    align: 'left' as const,
    field: 'date',
    sortable: true
  },
  {
    name: 'monthToDateUsage',
    label: 'Month to Date Usage',
    align: 'left' as const,
    field: 'monthToDateUsage',
    sortable: true
  },
  {
    name: 'changeFromPrevious',
    label: 'Change',
    align: 'left' as const,
    field: 'changeFromPrevious',
    sortable: true
  },
  {
    name: 'deletedUserId',
    label: 'Deleted User ID',
    align: 'left' as const,
    field: 'deletedUserId',
    sortable: true
  }
];

const balanceEntries = computed(() => {
  if (!balanceData.value) return [];
  const entries: Array<{ key: string; label: string; value: string }> = [];
  const balance = balanceData.value.balance;
  if (balance && typeof balance === 'object') {
    for (const [key, value] of Object.entries(balance)) {
      entries.push({ key: `balance.${key}`, label: key.replace(/_/g, ' '), value: String(value) });
    }
  }
  for (const [key, value] of Object.entries(balanceData.value)) {
    if (key === 'balance') continue;
    entries.push({ key, label: key.replace(/_/g, ' '), value: String(value) });
  }
  return entries;
});

const loadCustomerBalance = async () => {
  balanceLoading.value = true;
  balanceError.value = '';
  balanceHint.value = '';
  try {
    const response = await fetch('/api/billing/balance', {
      credentials: 'include'
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const status = errorData.status || response.status;
      const msg = errorData.error || errorData.message || 'Unknown error';
      balanceHint.value = errorData.hint || '';
      throw new Error(`HTTP ${status} — ${msg}`);
    }
    balanceData.value = await response.json();
  } catch (err) {
    balanceError.value = err instanceof Error ? err.message : 'Failed to load customer balance';
  } finally {
    balanceLoading.value = false;
  }
};

function getWorkflowStageColor(stage: string): string {
  const colors: Record<string, string> = {
    'request_sent': 'orange',
    'provisioned': 'green',
    'active': 'blue',
    'unknown': 'grey'
  };
  return colors[stage] || 'grey';
}

function formatDate(dateString: string | null): string {
  if (!dateString) return '—';
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  } catch {
    return dateString;
  }
}

async function loadUsers() {
  loading.value = true;
  try {
    const response = await fetch('/api/admin/users', {
      credentials: 'include'
    });
    const data = await response.json();
    
    if (data.success) {
      users.value = data.users;
      totalUsers.value = data.totalUsers;
      totalDeepLinkUsers.value = data.totalDeepLinkUsers;
      passkeyConfig.value = data.passkeyConfig || null;
      usageList.value = Array.isArray(data.usageList) ? data.usageList : [];
    } else {
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'negative',
          message: `Error loading users: ${data.error || 'Unknown error'}`
        });
      } else {
        console.error('Error loading users:', data.error || 'Unknown error');
      }
    }
  } catch (error) {
    console.error('Error loading users:', error);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: 'Failed to load users. Please try again.'
      });
    } else {
      console.error('Failed to load users. Please try again.');
    }
  } finally {
    loading.value = false;
  }
}

function confirmDelete(userId: string) {
  if ($q && typeof $q.dialog === 'function') {
    $q.dialog({
      title: 'Confirm Deletion',
      message: `Are you sure you want to permanently delete user "${userId}"? This will delete:
- All files in their Spaces folder
- Their Knowledge Base
- Their Agent
- Their user document
- All their sessions
- All their saved chats

This action cannot be undone.`,
      cancel: {
        label: 'CANCEL',
        color: 'grey',
        flat: true
      },
      ok: {
        label: 'DELETE',
        color: 'negative'
      },
      persistent: true
    }).onOk(() => {
      deleteUser(userId);
    });
  } else {
    // Fallback to native confirm if dialog plugin not available
    if (window.confirm(`Are you sure you want to permanently delete user "${userId}"? This will delete all their files, Knowledge Base, Agent, user document, and sessions. This action cannot be undone.`)) {
      deleteUser(userId);
    }
  }
}

async function deleteUser(userId: string) {
  deletingUsers.value.add(userId);
  try {
    const response = await fetch(`/api/admin/users/${userId}`, {
      method: 'DELETE',
      credentials: 'include'
    });
    
    const data = await response.json();
    
    if (data.success) {
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'positive',
          message: `User ${userId} deleted successfully`,
          timeout: 3000
        });
      } else {
        alert(`User ${userId} deleted successfully`);
      }
      // Reload users list
      await loadUsers();
    } else {
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'negative',
          message: `Failed to delete user: ${data.error || 'Unknown error'}`,
          timeout: 5000
        });
      } else {
        alert(`Failed to delete user: ${data.error || 'Unknown error'}`);
      }
    }
  } catch (error) {
    console.error('Error deleting user:', error);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: 'Failed to delete user. Please try again.'
      });
    } else {
      alert('Failed to delete user. Please try again.');
    }
  } finally {
    deletingUsers.value.delete(userId);
  }
}

async function recoverUser(userId: string) {
  recoveringUsers.value.add(userId);
  try {
    const response = await fetch(`/api/admin/users/${userId}/recover`, {
      method: 'POST',
      credentials: 'include'
    });
    
    const data = await response.json();
    
    if (data.success) {
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'positive',
          message: data.message || `User ${userId} recovered successfully`,
          timeout: 5000
        });
      } else {
        alert(data.message || `User ${userId} recovered successfully`);
      }
      // Reload users list to show updated status
      await loadUsers();
    } else {
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'negative',
          message: `Recovery failed: ${data.error || 'Unknown error'}`,
          timeout: 5000
        });
      } else {
        alert(`Recovery failed: ${data.error || 'Unknown error'}`);
      }
    }
  } catch (error) {
    console.error('Error recovering user:', error);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: 'Failed to recover user. Please try again.'
      });
    } else {
      alert('Failed to recover user. Please try again.');
    }
  } finally {
    recoveringUsers.value.delete(userId);
  }
}

const signOutAdmin = async () => {
  signingOut.value = true;
  try {
    const response = await fetch('/api/sign-out', {
      method: 'POST',
      credentials: 'include'
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to sign out');
    }
    window.location.href = '/';
  } catch (error) {
    console.error('Error signing out:', error);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to sign out'
      });
    } else {
      alert('Failed to sign out');
    }
  } finally {
    signingOut.value = false;
  }
};

onMounted(() => {
  loadUsers();
  loadCustomerBalance();
});
</script>

<style scoped>
.admin-users-table {
  background: white;
}
</style>

