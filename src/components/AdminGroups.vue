<template>
  <q-card class="q-mt-md">
    <q-card-section>
      <div class="row items-center justify-between q-mb-sm">
        <div class="text-h6">Patient Groups</div>
        <q-btn
          unelevated
          dense
          color="primary"
          icon="group_add"
          label="Create Group"
          @click="openCreateDialog"
        />
      </div>

      <div v-if="loading" class="text-body2 text-grey-7">Loading groups…</div>
      <div v-else-if="loadError" class="text-body2 text-negative">{{ loadError }}</div>
      <div v-else-if="groups.length === 0" class="text-body2 text-grey-7">
        No groups yet. Create one to invite members.
      </div>

      <q-list v-else separator>
        <q-item v-for="g in groups" :key="g.groupId">
          <q-item-section>
            <q-item-label>
              <span class="text-weight-bold">{{ g.name }}</span>
              <span class="text-grey-7 text-caption q-ml-sm">{{ g.groupId }}</span>
            </q-item-label>
            <q-item-label caption v-if="g.description">{{ g.description }}</q-item-label>
            <q-item-label caption>
              Members: {{ g.memberCounts.active }} active<span v-if="g.memberCounts.invited">, {{ g.memberCounts.invited }} invited</span><span v-if="g.memberCounts.revoked">, {{ g.memberCounts.revoked }} revoked</span>
              · Created {{ formatDate(g.createdAt) }}
            </q-item-label>
            <div v-if="g.tagVocabulary.length" class="q-mt-xs">
              <q-chip
                v-for="tag in g.tagVocabulary"
                :key="tag"
                dense
                size="sm"
                color="blue-1"
                text-color="primary"
              >
                {{ tag }}
              </q-chip>
            </div>
          </q-item-section>
          <q-item-section side>
            <q-btn
              flat
              dense
              round
              icon="edit"
              color="grey-7"
              @click="openEditDialog(g)"
            >
              <q-tooltip>Edit group</q-tooltip>
            </q-btn>
          </q-item-section>
        </q-item>
      </q-list>
    </q-card-section>

    <!-- Create / Edit dialog -->
    <q-dialog v-model="showDialog">
      <q-card style="min-width: 420px; max-width: 560px">
        <q-card-section>
          <div class="text-h6">{{ editingGroupId ? 'Edit Group' : 'Create Group' }}</div>
        </q-card-section>
        <q-card-section class="q-gutter-y-md">
          <q-input
            v-model="form.name"
            label="Group name"
            dense
            outlined
            autofocus
            :rules="[(v) => !!(v && v.trim()) || 'Name is required']"
          />
          <q-input
            v-model="form.description"
            label="Description"
            dense
            outlined
            type="textarea"
            autogrow
          />
          <q-input
            v-model="form.tags"
            label="Match-query tags (comma-separated)"
            dense
            outlined
            hint="Small, condition-appropriate vocabulary, e.g. mentorship, newly-diagnosed, biologics"
          />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="Cancel" v-close-popup :disable="saving" />
          <q-btn
            unelevated
            color="primary"
            :label="editingGroupId ? 'Save' : 'Create'"
            :loading="saving"
            @click="saveGroup"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-card>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';

const $q = useQuasar();

interface GroupSummary {
  groupId: string;
  name: string;
  description: string;
  tagVocabulary: string[];
  publicKeyJwk: Record<string, string> | null;
  policyPackVersion: number;
  memberCounts: { active: number; invited: number; revoked: number };
  createdAt: string;
  updatedAt: string;
}

const groups = ref<GroupSummary[]>([]);
const loading = ref(false);
const loadError = ref('');

const showDialog = ref(false);
const saving = ref(false);
const editingGroupId = ref<string | null>(null);
const form = ref({ name: '', description: '', tags: '' });

const formatDate = (iso: string): string => {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
};

const loadGroups = async () => {
  loading.value = true;
  loadError.value = '';
  try {
    const res = await fetch('/api/groups', { credentials: 'include' });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    groups.value = data.groups || [];
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : 'Failed to load groups';
  } finally {
    loading.value = false;
  }
};

const openCreateDialog = () => {
  editingGroupId.value = null;
  form.value = { name: '', description: '', tags: '' };
  showDialog.value = true;
};

const openEditDialog = (g: GroupSummary) => {
  editingGroupId.value = g.groupId;
  form.value = {
    name: g.name,
    description: g.description,
    tags: g.tagVocabulary.join(', ')
  };
  showDialog.value = true;
};

const saveGroup = async () => {
  if (!form.value.name.trim()) return;
  saving.value = true;
  try {
    const body = {
      name: form.value.name.trim(),
      description: form.value.description.trim(),
      tagVocabulary: form.value.tags
    };
    const url = editingGroupId.value
      ? `/api/groups/${encodeURIComponent(editingGroupId.value)}`
      : '/api/groups';
    const res = await fetch(url, {
      method: editingGroupId.value ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    showDialog.value = false;
    await loadGroups();
    $q.notify({
      type: 'positive',
      message: editingGroupId.value ? 'Group updated.' : `Group created: ${data.group?.groupId}`
    });
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Failed to save group'
    });
  } finally {
    saving.value = false;
  }
};

onMounted(loadGroups);
</script>
