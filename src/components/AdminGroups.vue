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

      <div v-else>
        <div v-for="g in groups" :key="g.groupId" class="q-mb-md">
          <!-- Group header: single line -->
          <div class="row items-center no-wrap group-header q-py-sm q-px-sm">
            <div class="col" style="min-width: 0">
              <span class="text-weight-bold">{{ g.name }}</span>
              <span class="text-grey-6 text-caption q-ml-sm">{{ g.groupId }}</span>
              <span class="text-caption text-grey-7 q-ml-sm">
                · {{ g.memberCounts.active }} active / {{ g.memberCounts.invited }} invited / {{ g.memberCounts.revoked }} revoked
                · created {{ formatDate(g.createdAt) }}
                <template v-if="g.tagVocabulary.length"> · tags: {{ g.tagVocabulary.join(', ') }}</template>
                <span :class="g.recoveryKitLastExportedAt ? 'text-grey-7' : 'text-orange-9 text-weight-medium'">
                  · recovery kit: {{ g.recoveryKitLastExportedAt ? 'exported' : 'NOT exported' }}
                </span>
              </span>
            </div>
            <div class="col-auto row no-wrap items-center">
              <q-btn flat dense round icon="person_add" color="primary" @click="openInviteDialog(g)">
                <q-tooltip>Invite a member</q-tooltip>
              </q-btn>
              <q-btn flat dense round icon="key" :color="g.recoveryKitLastExportedAt ? 'grey-7' : 'orange-9'" @click="confirmRecoveryKit(g)">
                <q-tooltip>Download recovery kit</q-tooltip>
              </q-btn>
              <q-btn flat dense round icon="edit" color="grey-7" @click="openEditDialog(g)">
                <q-tooltip>Edit group</q-tooltip>
              </q-btn>
            </div>
          </div>

          <!-- Member rows -->
          <div v-if="loadingMembers[g.groupId]" class="text-caption text-grey-6 q-pl-md q-py-xs">
            Loading members…
          </div>
          <div v-else-if="!(membersByGroup[g.groupId] || []).length" class="text-caption text-grey-6 q-pl-md q-py-xs">
            No members yet — use the invite button to add one.
          </div>
          <div
            v-for="m in (membersByGroup[g.groupId] || [])"
            :key="m.pairwiseId"
            class="row items-center no-wrap member-row q-py-xs"
          >
            <div class="member-cell" style="flex: 2 1 0; min-width: 0">
              <span class="ellipsis">{{ m.inviteEmail || m.alias || m.pairwiseId }}</span>
            </div>
            <div class="member-cell" style="flex: 0 0 130px">
              <q-badge
                :color="m.status === 'active' ? 'green' : m.status === 'invited' ? 'orange' : m.status === 'requested' ? 'purple' : 'grey'"
                :label="m.status"
              />
              <q-badge v-if="m.mentor" color="teal" label="mentor" class="q-ml-xs" />
            </div>
            <div class="member-cell text-caption text-grey-7" style="flex: 3 1 0; min-width: 0">
              <template v-if="m.status === 'active'">
                accepted {{ formatDate(m.joinedAt) }}
              </template>
              <template v-else-if="m.status === 'invited'">
                invited {{ formatDate(m.invitedAt) }}
                · {{ m.inviteOpenedAt ? 'link opened ' + formatDate(m.inviteOpenedAt) : 'link not opened' }}
                · expires {{ formatDate(m.inviteExpiresAt) }}
              </template>
              <template v-else-if="m.status === 'requested'">
                requested {{ formatDate(m.requestedAt) }} · approve to admit
              </template>
              <template v-else>
                revoked {{ formatDate(m.revokedAt) }}
              </template>
            </div>
            <div class="member-cell" style="flex: 0 0 120px; text-align: right">
              <q-btn
                v-if="m.status === 'requested'"
                flat dense round size="sm" icon="how_to_reg" color="primary"
                @click="approveRequest(g, m)"
              >
                <q-tooltip>Approve join request</q-tooltip>
              </q-btn>
              <q-btn
                v-if="m.status === 'active'"
                flat dense round size="sm"
                :icon="m.mentor ? 'star' : 'star_border'"
                :color="m.mentor ? 'teal' : 'grey-6'"
                @click="toggleMentor(g, m)"
              >
                <q-tooltip>{{ m.mentor ? 'Remove mentor (hide from directory)' : 'Make mentor (list in directory)' }}</q-tooltip>
              </q-btn>
              <q-btn flat dense round size="sm" icon="delete" color="negative" @click="confirmRemoveMember(g, m)">
                <q-tooltip>
                  {{ m.status === 'invited' ? 'Cancel invite' : m.status === 'requested' ? 'Reject request' : m.status === 'active' ? 'Revoke membership' : 'Remove entry' }}
                </q-tooltip>
              </q-btn>
            </div>
          </div>
        </div>
      </div>
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
          <q-input v-model="form.description" label="Description" dense outlined type="textarea" autogrow />
          <q-input
            v-model="form.postingPolicy"
            label="Group policy (shown when people join)"
            dense outlined type="textarea" autogrow
            hint="Plain language: what this group is for, what members should and shouldn't post. Joining means accepting it."
          />
          <q-input
            v-model="form.tags"
            label="Match-query tags (comma-separated)"
            dense
            outlined
            hint="Small, condition-appropriate vocabulary, e.g. mentorship, newly-diagnosed, biologics"
          />
          <q-toggle
            v-model="form.memberInvitesAllowed"
            label="Members may invite new people"
            dense
          >
            <q-tooltip>
              When on (recommended), any active member can send email
              invitations; the invitee's first conversation is their inviter.
              When off, only you can invite.
            </q-tooltip>
          </q-toggle>
          <q-toggle
            v-model="form.publiclyListed"
            label="List this group publicly on the welcome page"
            dense
          >
            <q-tooltip>
              Shows the group's name, description, posting policy, and member
              count on this server's welcome page. Never a member roster.
              Off = invisible to visitors.
            </q-tooltip>
          </q-toggle>
          <q-select
            v-model="form.joinMode"
            :options="[
              { value: 'invite-only', label: 'Invite only — you send each invitation' },
              { value: 'link-approval', label: 'Link + approval — anyone may request; you approve each' },
              { value: 'open', label: 'Open — anyone with the link joins instantly' }
            ]"
            emit-value map-options dense outlined
            label="How people join"
            hint="Open is the zero-friction bootstrap mode: you can still revoke members and rotate the link."
          />
          <div v-if="form.joinMode !== 'invite-only' && editingJoinLink" class="q-mt-sm">
            <div class="text-caption text-grey-7">Share this link or QR code:</div>
            <div class="text-caption q-mt-xs" style="word-break: break-all">
              {{ editingJoinLink }}
              <q-btn dense flat size="sm" icon="content_copy" @click="copyJoinLink">
                <q-tooltip>Copy link</q-tooltip>
              </q-btn>
            </div>
            <img v-if="joinLinkQr" :src="joinLinkQr" alt="Join QR code" style="width: 160px; height: 160px" class="q-mt-xs" />
            <div>
              <q-btn dense flat size="sm" color="negative" icon="autorenew" label="Rotate link" :loading="rotatingLink" @click="rotateJoinLink">
                <q-tooltip>Old links and printed QR codes stop working</q-tooltip>
              </q-btn>
            </div>
          </div>
          <div v-else-if="form.joinMode !== 'invite-only' && editingGroupId" class="text-caption text-grey-7">
            Save to generate the link and QR code.
          </div>
          <div v-else-if="form.joinMode !== 'invite-only'" class="text-caption text-grey-7">
            The link and QR code appear after the group is created (edit the group to see them).
          </div>
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

    <!-- Compact invite dialog -->
    <q-dialog v-model="showInviteDialog">
      <q-card style="min-width: 460px; max-width: 620px">
        <q-card-section>
          <div class="text-h6">Invite to {{ inviteGroup?.name }}</div>
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
          <div
            v-if="lastInviteLink"
            class="q-mt-sm"
            style="padding: 12px; border-radius: 8px; background: #e8f5e9;"
          >
            <div class="text-caption">
              Invite {{ lastInviteEmailSent ? 'emailed' : 'created (email not configured)' }} — link valid
              14 days. Replaces any earlier invite to this address (older links stop working):
            </div>
            <div class="row items-center q-gutter-sm q-mt-xs">
              <div class="text-caption" style="flex: 1 1 auto; min-width: 0; word-break: break-all">{{ lastInviteLink }}</div>
              <q-btn flat dense round size="sm" icon="content_copy" style="flex: 0 0 auto" @click="copyInviteLink">
                <q-tooltip>Copy link</q-tooltip>
              </q-btn>
            </div>
          </div>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="Close" v-close-popup />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-card>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import QRCode from 'qrcode';

const $q = useQuasar();

interface GroupSummary {
  groupId: string;
  name: string;
  description: string;
  memberInvitesAllowed?: boolean;
  postingPolicy?: string;
  publiclyListed?: boolean;
  joinMode?: string;
  joinLink?: string | null;
  tagVocabulary: string[];
  publicKeyJwk: Record<string, string> | null;
  policyPackVersion: number;
  memberCounts: { active: number; invited: number; revoked: number };
  createdAt: string;
  updatedAt: string;
  recoveryKitLastExportedAt: string | null;
  recoveryKitExportCount: number;
}

interface MemberSummary {
  pairwiseId: string;
  alias: string | null;
  status: 'invited' | 'active' | 'revoked' | 'requested';
  invitedAt: string | null;
  joinedAt: string | null;
  revokedAt: string | null;
  inviteEmail: string | null;
  inviteExpiresAt: string | null;
  inviteOpenedAt: string | null;
  requestedAt?: string | null;
  mentor: boolean;
}

const groups = ref<GroupSummary[]>([]);
const loading = ref(false);
const loadError = ref('');
const membersByGroup = ref<Record<string, MemberSummary[]>>({});
const loadingMembers = ref<Record<string, boolean>>({});

const showDialog = ref(false);
const saving = ref(false);
const editingGroupId = ref<string | null>(null);
const form = ref({ name: '', description: '', tags: '', postingPolicy: '', memberInvitesAllowed: true, joinMode: 'invite-only', publiclyListed: false });

/** Join link of the group being edited (server-computed once saved). */
const editingJoinLink = computed(() => {
  const g = groups.value.find((x) => x.groupId === editingGroupId.value);
  return g?.joinLink || null;
});
const joinLinkQr = ref('');
watch(editingJoinLink, async (link) => {
  joinLinkQr.value = link ? await QRCode.toDataURL(link, { width: 320, margin: 1 }).catch(() => '') : '';
}, { immediate: true });
const rotatingLink = ref(false);

const copyJoinLink = async () => {
  if (!editingJoinLink.value) return;
  try {
    await navigator.clipboard.writeText(editingJoinLink.value);
    $q.notify({ type: 'positive', message: 'Link copied.' });
  } catch {
    $q.notify({ type: 'warning', message: 'Copy failed — select and copy the link manually.' });
  }
};

const rotateJoinLink = async () => {
  if (!editingGroupId.value) return;
  rotatingLink.value = true;
  try {
    const res = await fetch(`/api/groups/${encodeURIComponent(editingGroupId.value)}/rotate-join-link`, {
      method: 'POST',
      credentials: 'include'
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    await loadGroups();
    $q.notify({ type: 'positive', message: 'Join link rotated — old links and QR codes are dead.' });
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to rotate link' });
  } finally {
    rotatingLink.value = false;
  }
};

const approveRequest = async (g: GroupSummary, m: MemberSummary) => {
  try {
    const res = await fetch(`/api/groups/${encodeURIComponent(g.groupId)}/members/${encodeURIComponent(m.pairwiseId)}/approve`, {
      method: 'PUT',
      credentials: 'include'
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    await loadMembers(g.groupId);
    await loadGroups();
    $q.notify({ type: 'positive', message: `${m.alias || 'Member'} approved — they'll be connected within seconds.` });
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to approve request' });
  }
};

const showInviteDialog = ref(false);
const inviteGroup = ref<GroupSummary | null>(null);
const inviteEmail = ref('');
const sendingInvite = ref(false);
const lastInviteLink = ref('');
const lastInviteEmailSent = ref(false);

const formatDate = (iso: string | null | undefined): string => {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
};

const loadMembers = async (groupId: string) => {
  loadingMembers.value = { ...loadingMembers.value, [groupId]: true };
  try {
    const res = await fetch(`/api/groups/${encodeURIComponent(groupId)}/members`, { credentials: 'include' });
    const data = await res.json();
    if (res.ok && data.success) {
      membersByGroup.value = { ...membersByGroup.value, [groupId]: data.members || [] };
    }
  } catch {
    /* row shows empty state */
  } finally {
    loadingMembers.value = { ...loadingMembers.value, [groupId]: false };
  }
};

const loadGroups = async () => {
  loading.value = true;
  loadError.value = '';
  try {
    const res = await fetch('/api/groups', { credentials: 'include' });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    groups.value = data.groups || [];
    // Load members for every group inline.
    await Promise.all(groups.value.map((g) => loadMembers(g.groupId)));
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : 'Failed to load groups';
  } finally {
    loading.value = false;
  }
};

const openCreateDialog = () => {
  editingGroupId.value = null;
  form.value = { name: '', description: '', tags: '', postingPolicy: '', memberInvitesAllowed: true, joinMode: 'invite-only', publiclyListed: false };
  showDialog.value = true;
};

const openEditDialog = (g: GroupSummary) => {
  editingGroupId.value = g.groupId;
  form.value = {
    name: g.name,
    description: g.description,
    tags: g.tagVocabulary.join(', '),
    postingPolicy: g.postingPolicy || '',
    memberInvitesAllowed: g.memberInvitesAllowed !== false,
    joinMode: g.joinMode || 'invite-only',
    publiclyListed: g.publiclyListed === true
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
      tagVocabulary: form.value.tags,
      postingPolicy: form.value.postingPolicy.trim(),
      memberInvitesAllowed: form.value.memberInvitesAllowed,
      joinMode: form.value.joinMode,
      publiclyListed: form.value.publiclyListed
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
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    showDialog.value = false;
    const wasCreate = !editingGroupId.value;
    await loadGroups();
    $q.notify({
      type: 'positive',
      message: wasCreate ? `Group created: ${data.group?.groupId}` : 'Group updated.'
    });
    // §6.7: offer the recovery kit at creation.
    if (wasCreate && data.group?.groupId) {
      confirmRecoveryKit(data.group as GroupSummary, true);
    }
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to save group' });
  } finally {
    saving.value = false;
  }
};

/** Confirmation before exporting the group's private key material (§6.7). */
const confirmRecoveryKit = (g: GroupSummary, justCreated = false) => {
  $q.dialog({
    title: 'Download recovery kit',
    message:
      (justCreated ? `Your group "${g.name}" was created. ` : '') +
      "The recovery kit contains the group's PRIVATE signing key — the only copy outside the server database. " +
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
    const res = await fetch(`/api/groups/${encodeURIComponent(g.groupId)}/recovery-kit`, { credentials: 'include' });
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
    await loadGroups();
    $q.notify({ type: 'positive', message: 'Recovery kit downloaded — store it securely offline.' });
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to download recovery kit' });
  }
};

const openInviteDialog = (g: GroupSummary) => {
  inviteGroup.value = g;
  inviteEmail.value = '';
  lastInviteLink.value = '';
  showInviteDialog.value = true;
};

const sendInvite = async () => {
  if (!inviteGroup.value || !inviteEmail.value.trim()) return;
  sendingInvite.value = true;
  try {
    const res = await fetch(`/api/groups/${encodeURIComponent(inviteGroup.value.groupId)}/invites`, {
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
    await loadGroups();
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

const toggleMentor = async (g: GroupSummary, m: MemberSummary) => {
  try {
    const res = await fetch(
      `/api/groups/${encodeURIComponent(g.groupId)}/members/${encodeURIComponent(m.pairwiseId)}/mentor`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ mentor: !m.mentor })
      }
    );
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    await loadMembers(g.groupId);
    $q.notify({ type: 'positive', message: data.mentor ? 'Marked as mentor (now in the directory).' : 'Removed from mentors.' });
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to update mentor' });
  }
};

const confirmRemoveMember = (g: GroupSummary, m: MemberSummary) => {
  const who = m.inviteEmail || m.alias || m.pairwiseId;
  let title: string;
  let message: string;
  let okLabel: string;
  if (m.status === 'invited') {
    title = 'Cancel invite';
    message = `Cancel the pending invite for ${who}?`;
    okLabel = 'Cancel invite';
  } else if (m.status === 'active') {
    title = 'Revoke membership';
    message = `Revoke ${who}? Their membership credential stops refreshing and expires within 24 hours.`;
    okLabel = 'Revoke';
  } else {
    title = 'Remove entry';
    message = `Remove the revoked entry for ${who} from this group?`;
    okLabel = 'Remove';
  }
  $q.dialog({
    title,
    message,
    ok: { label: okLabel, color: 'negative' },
    cancel: { label: 'Keep', flat: true }
  }).onOk(() => {
    void removeMember(g, m);
  });
};

const removeMember = async (g: GroupSummary, m: MemberSummary) => {
  try {
    const res = await fetch(
      `/api/groups/${encodeURIComponent(g.groupId)}/members/${encodeURIComponent(m.pairwiseId)}`,
      { method: 'DELETE', credentials: 'include' }
    );
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    await loadGroups();
    const msg =
      data.action === 'invite_cancelled' ? 'Invite cancelled.'
      : data.action === 'member_removed' ? 'Entry removed.'
      : 'Membership revoked.';
    $q.notify({ type: 'positive', message: msg });
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to remove member' });
  }
};

onMounted(loadGroups);
</script>

<style scoped>
.group-header {
  background: #f5f5f5;
  border-radius: 6px;
}
.member-row {
  border-bottom: 1px solid #eee;
  padding-left: 24px;
  padding-right: 8px;
}
.member-cell {
  padding-right: 8px;
}
</style>
