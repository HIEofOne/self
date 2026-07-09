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
            <q-item-label caption :class="g.recoveryKitLastExportedAt ? 'text-grey-7' : 'text-orange-9'">
              Recovery kit: {{ g.recoveryKitLastExportedAt ? `exported ${formatDate(g.recoveryKitLastExportedAt)} (${g.recoveryKitExportCount}×)` : 'never exported — download and store it securely' }}
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
            <div class="row no-wrap">
              <q-btn
                flat
                dense
                round
                icon="person_add"
                color="primary"
                @click="openMembersDialog(g)"
              >
                <q-tooltip>Members &amp; invites</q-tooltip>
              </q-btn>
              <q-btn
                flat
                dense
                round
                icon="key"
                :color="g.recoveryKitLastExportedAt ? 'grey-7' : 'orange-9'"
                @click="confirmRecoveryKit(g)"
              >
                <q-tooltip>Download recovery kit</q-tooltip>
              </q-btn>
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
            </div>
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

    <!-- Members & invites dialog -->
    <q-dialog v-model="showMembersDialog">
      <q-card style="min-width: 480px; max-width: 640px">
        <q-card-section>
          <div class="text-h6">Members — {{ membersGroup?.name }}</div>
        </q-card-section>

        <q-card-section class="q-pt-none">
          <div class="row items-center q-gutter-sm">
            <q-input
              v-model="inviteEmail"
              dense
              outlined
              type="email"
              label="Invite by email"
              style="flex: 1; min-width: 220px"
              :disable="sendingInvite"
              @keyup.enter="sendInvite"
            />
            <q-btn
              unelevated
              dense
              color="primary"
              label="Send invite"
              :loading="sendingInvite"
              :disable="!inviteEmail.trim()"
              @click="sendInvite"
            />
          </div>
          <q-banner v-if="lastInviteLink" class="bg-green-1 q-mt-sm" rounded dense>
            <div class="text-caption">
              Invite {{ lastInviteEmailSent ? 'emailed' : 'created (email not configured)' }} — link
              valid 14 days:
            </div>
            <div class="row items-center no-wrap q-mt-xs">
              <div class="text-caption ellipsis" style="max-width: 440px">{{ lastInviteLink }}</div>
              <q-btn flat dense round size="sm" icon="content_copy" @click="copyInviteLink">
                <q-tooltip>Copy link</q-tooltip>
              </q-btn>
            </div>
          </q-banner>
        </q-card-section>

        <q-card-section class="q-pt-none">
          <div v-if="loadingMembers" class="text-body2 text-grey-7">Loading members…</div>
          <div v-else-if="members.length === 0" class="text-body2 text-grey-7">
            No members yet — send the first invite above.
          </div>
          <q-list v-else separator dense>
            <q-item v-for="m in members" :key="m.pairwiseId">
              <q-item-section>
                <q-item-label>
                  {{ m.alias || m.inviteEmail || m.pairwiseId }}
                  <q-badge
                    class="q-ml-sm"
                    :color="m.status === 'active' ? 'green' : m.status === 'invited' ? 'orange' : 'grey'"
                    :label="m.status"
                  />
                  <q-badge v-if="m.mentor" class="q-ml-xs" color="teal" label="mentor" />
                </q-item-label>
                <q-item-label caption>
                  <template v-if="m.status === 'invited'">
                    Invited {{ formatDate(m.invitedAt) }}
                    · {{ m.inviteOpenedAt ? `link opened ${formatDate(m.inviteOpenedAt)}` : 'link not opened yet' }}
                    · expires {{ formatDate(m.inviteExpiresAt) }}
                  </template>
                  <template v-else-if="m.status === 'active'">
                    Joined {{ formatDate(m.joinedAt) }}
                  </template>
                  <template v-else>
                    Revoked {{ formatDate(m.revokedAt) }}
                  </template>
                </q-item-label>
              </q-item-section>
              <q-item-section side v-if="m.status !== 'revoked'">
                <q-btn
                  flat
                  dense
                  round
                  size="sm"
                  :icon="m.status === 'invited' ? 'close' : 'person_remove'"
                  color="negative"
                  @click="confirmRemoveMember(m)"
                >
                  <q-tooltip>{{ m.status === 'invited' ? 'Cancel invite' : 'Revoke membership' }}</q-tooltip>
                </q-btn>
              </q-item-section>
            </q-item>
          </q-list>
        </q-card-section>

        <q-card-actions align="right">
          <q-btn flat label="Close" v-close-popup />
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
  recoveryKitLastExportedAt: string | null;
  recoveryKitExportCount: number;
}

const groups = ref<GroupSummary[]>([]);
const loading = ref(false);
const loadError = ref('');

const showDialog = ref(false);
const saving = ref(false);
const editingGroupId = ref<string | null>(null);
const form = ref({ name: '', description: '', tags: '' });

const formatDate = (iso: string | null | undefined): string => {
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
    const wasCreate = !editingGroupId.value;
    await loadGroups();
    $q.notify({
      type: 'positive',
      message: wasCreate ? `Group created: ${data.group?.groupId}` : 'Group updated.'
    });
    // §6.7: the recovery kit is OFFERED AT CREATION — the group's private
    // signing key lives only in CouchDB, so the admin should hold an
    // offline copy from day one.
    if (wasCreate && data.group?.groupId) {
      confirmRecoveryKit(data.group as GroupSummary, true);
    }
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Failed to save group'
    });
  } finally {
    saving.value = false;
  }
};

/** Confirmation before exporting the group's private key material. */
const confirmRecoveryKit = (g: GroupSummary, justCreated = false) => {
  $q.dialog({
    title: 'Download recovery kit',
    message:
      (justCreated ? `Your group "${g.name}" was created. ` : '') +
      'The recovery kit contains the group\'s PRIVATE signing key — the only copy outside the server database. ' +
      'If the database is ever lost without it, the group cannot recover: all memberships expire within 24 hours. ' +
      'Store the file offline and securely; anyone holding it can issue membership credentials for this group. ' +
      'Every export is audit-logged.',
    ok: { label: 'Download', color: 'primary' },
    cancel: { label: justCreated ? 'Later' : 'Cancel', flat: true },
    persistent: justCreated
  }).onOk(() => {
    void downloadRecoveryKit(g);
  });
};

const downloadRecoveryKit = async (g: GroupSummary) => {
  try {
    const res = await fetch(`/api/groups/${encodeURIComponent(g.groupId)}/recovery-kit`, {
      credentials: 'include'
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `maia-group-recovery-${g.groupId}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    await loadGroups(); // refresh lastExportedAt display
    $q.notify({ type: 'positive', message: 'Recovery kit downloaded — store it securely offline.' });
  } catch (err) {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Failed to download recovery kit'
    });
  }
};

// ── Members & invites ─────────────────────────────────────────────

interface MemberSummary {
  pairwiseId: string;
  alias: string | null;
  status: 'invited' | 'active' | 'revoked';
  invitedAt: string | null;
  joinedAt: string | null;
  revokedAt: string | null;
  inviteEmail: string | null;
  inviteExpiresAt: string | null;
  inviteOpenedAt: string | null;
  mentor: boolean;
}

const showMembersDialog = ref(false);
const membersGroup = ref<GroupSummary | null>(null);
const members = ref<MemberSummary[]>([]);
const loadingMembers = ref(false);
const inviteEmail = ref('');
const sendingInvite = ref(false);
const lastInviteLink = ref('');
const lastInviteEmailSent = ref(false);

const openMembersDialog = async (g: GroupSummary) => {
  membersGroup.value = g;
  members.value = [];
  inviteEmail.value = '';
  lastInviteLink.value = '';
  showMembersDialog.value = true;
  await loadMembers();
};

const loadMembers = async () => {
  if (!membersGroup.value) return;
  loadingMembers.value = true;
  try {
    const res = await fetch(`/api/groups/${encodeURIComponent(membersGroup.value.groupId)}/members`, {
      credentials: 'include'
    });
    const data = await res.json();
    if (res.ok && data.success) members.value = data.members || [];
  } catch {
    /* dialog shows empty state */
  } finally {
    loadingMembers.value = false;
  }
};

const sendInvite = async () => {
  if (!membersGroup.value || !inviteEmail.value.trim()) return;
  sendingInvite.value = true;
  try {
    const res = await fetch(`/api/groups/${encodeURIComponent(membersGroup.value.groupId)}/invites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email: inviteEmail.value.trim() })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    lastInviteLink.value = data.invite?.inviteLink || '';
    lastInviteEmailSent.value = !!data.invite?.emailSent;
    inviteEmail.value = '';
    await loadMembers();
    await loadGroups(); // refresh member counts on the card
    $q.notify({
      type: 'positive',
      message: lastInviteEmailSent.value ? 'Invitation emailed.' : 'Invite created — copy the link below.'
    });
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to send invite' });
  } finally {
    sendingInvite.value = false;
  }
};

const copyInviteLink = async () => {
  try {
    await navigator.clipboard.writeText(lastInviteLink.value);
    $q.notify({ type: 'positive', message: 'Invite link copied.' });
  } catch {
    $q.notify({ type: 'negative', message: 'Could not copy — select the link text manually.' });
  }
};

const confirmRemoveMember = (m: MemberSummary) => {
  const isInvite = m.status === 'invited';
  $q.dialog({
    title: isInvite ? 'Cancel invite' : 'Revoke membership',
    message: isInvite
      ? `Cancel the pending invite for ${m.inviteEmail || 'this member'}?`
      : `Revoke ${m.alias || m.pairwiseId}? Their membership credential stops refreshing and expires within 24 hours.`,
    ok: { label: isInvite ? 'Cancel invite' : 'Revoke', color: 'negative' },
    cancel: { label: 'Keep', flat: true }
  }).onOk(() => {
    void removeMember(m);
  });
};

const removeMember = async (m: MemberSummary) => {
  if (!membersGroup.value) return;
  try {
    const res = await fetch(
      `/api/groups/${encodeURIComponent(membersGroup.value.groupId)}/members/${encodeURIComponent(m.pairwiseId)}`,
      { method: 'DELETE', credentials: 'include' }
    );
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    await loadMembers();
    await loadGroups();
    $q.notify({ type: 'positive', message: data.action === 'invite_cancelled' ? 'Invite cancelled.' : 'Membership revoked.' });
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to remove member' });
  }
};

onMounted(loadGroups);
</script>
