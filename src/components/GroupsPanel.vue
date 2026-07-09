<template>
  <div class="q-pa-md">
    <div class="text-h6 q-mb-xs">Groups</div>
    <div class="text-body2 text-grey-7 q-mb-md">
      Connect with patients who share your situation. Your records never leave
      your MAIA — groups only mediate introductions and messages you approve.
    </div>

    <!-- Pending invite banner -->
    <q-banner v-if="pendingInvite" class="bg-blue-1 q-mb-md" rounded>
      <template v-slot:avatar>
        <q-icon name="mail" color="primary" />
      </template>
      <div class="text-body2">
        <template v-if="inviteGroupName">
          You've been invited to join <strong>{{ inviteGroupName }}</strong>
          <span v-if="inviteGroupDescription" class="text-grey-7"> — {{ inviteGroupDescription }}</span>
        </template>
        <template v-else>
          You have a pending group invitation.
        </template>
      </div>
      <div class="row items-center q-mt-sm q-gutter-sm">
        <q-input
          v-model="aliasInput"
          dense
          outlined
          label="Your display name in this group"
          hint="Members will know you by this name"
          style="min-width: 260px"
          :disable="joining"
        />
        <q-btn
          unelevated
          color="primary"
          label="Join group"
          :loading="joining"
          :disable="!aliasInput.trim()"
          @click="joinPendingGroup"
        />
        <q-btn flat color="grey-7" label="Dismiss" :disable="joining" @click="dismissInvite" />
      </div>
    </q-banner>

    <!-- Dead invite token: persistent explanation, dismissible -->
    <q-banner v-if="invalidInviteMessage" class="bg-red-1 q-mb-md" rounded>
      <template v-slot:avatar>
        <q-icon name="link_off" color="negative" />
      </template>
      <div class="text-body2">{{ invalidInviteMessage }}</div>
      <template v-slot:action>
        <q-btn flat dense color="negative" label="Dismiss" @click="invalidInviteMessage = ''" />
      </template>
    </q-banner>

    <!-- Requests inbox (AS, Phase 1 — every request escalates to you) -->
    <div v-if="requests.length" class="q-mb-md">
      <div class="row items-center q-mb-xs">
        <div class="text-subtitle2">Requests</div>
        <q-btn flat dense round size="sm" icon="refresh" :loading="loadingRequests" class="q-ml-xs" @click="loadRequests">
          <q-tooltip>Refresh requests</q-tooltip>
        </q-btn>
      </div>
      <div
        v-for="r in requests"
        :key="r.id"
        class="q-pa-sm q-mb-xs"
        style="border: 1px solid #e0e0e0; border-radius: 8px"
      >
        <div class="text-body2">
          A member of <strong>{{ r.groupName }}</strong> sent a request
          <span class="text-grey-7">({{ r.action }})</span>
        </div>
        <div v-if="r.aiSummary" class="text-caption text-grey-8 q-mt-xs">{{ r.aiSummary }}</div>
        <div v-else-if="r.payload" class="text-caption text-grey-8 q-mt-xs" style="white-space: pre-wrap; word-break: break-word">
          {{ typeof r.payload === 'string' ? r.payload : JSON.stringify(r.payload) }}
        </div>
        <div class="text-caption text-grey-6 q-mt-xs">{{ formatDate(r.receivedAt) }}</div>
        <div v-if="r.status === 'pending'" class="q-mt-xs q-gutter-sm">
          <q-btn dense unelevated size="sm" color="primary" label="Accept" :loading="deciding === r.id" @click="decide(r, 'accept')" />
          <q-btn dense flat size="sm" color="grey-8" label="Decline" :loading="deciding === r.id" @click="decide(r, 'decline')" />
          <q-btn dense flat size="sm" color="negative" label="Block sender" :loading="deciding === r.id" @click="decide(r, 'block')" />
        </div>
        <div v-else class="q-mt-xs">
          <q-badge :color="r.status === 'accepted' ? 'green' : r.status === 'blocked' ? 'negative' : 'grey'" :label="r.status" />
        </div>
      </div>
    </div>

    <!-- Memberships -->
    <div v-if="loading" class="text-center q-pa-md">
      <q-spinner size="2em" />
      <div class="q-mt-sm text-grey-7">Loading your groups…</div>
    </div>
    <div v-else-if="memberships.length === 0 && !pendingInvite" class="text-body2 text-grey-7">
      You're not in any groups yet. Group admins send invitations by email —
      the invite link brings you back here to join.
    </div>
    <q-list v-else separator>
      <template v-for="m in memberships" :key="m.groupId">
        <q-item>
          <q-item-section avatar>
            <q-icon name="groups" color="primary" />
          </q-item-section>
          <q-item-section>
            <q-item-label class="text-weight-bold">{{ m.groupName }}</q-item-label>
            <q-item-label caption>
              You appear as <strong>{{ m.alias }}</strong> · Joined {{ formatDate(m.joinedAt) }}
              <q-badge v-if="m.mentor" color="teal" label="Mentor" class="q-ml-sm" />
            </q-item-label>
          </q-item-section>
          <q-item-section side>
            <div class="row items-center no-wrap q-gutter-xs">
              <q-btn
                flat dense
                :icon="expandedGroup === m.groupId ? 'expand_less' : 'expand_more'"
                :label="`Messages${(messagesByGroup[m.groupId] || []).length ? ' (' + messagesByGroup[m.groupId].length + ')' : ''}`"
                @click="toggleMessages(m)"
              />
              <q-btn flat dense icon="people" label="Find peers" @click="toggleDirectory(m)" />
              <q-btn flat dense round icon="refresh" :loading="refreshing === m.groupId" @click="refreshMessages(m)">
                <q-tooltip>Check for new messages</q-tooltip>
              </q-btn>
              <q-btn flat dense color="negative" label="Leave" :loading="leaving === m.groupId" @click="confirmLeave(m)" />
            </div>
          </q-item-section>
        </q-item>

        <!-- Directory / find peers for this membership -->
        <q-item v-if="expandedDirectory === m.groupId">
          <q-item-section>
            <div v-if="loadingDirectory === m.groupId" class="text-caption text-grey-6 q-pl-md">Loading…</div>
            <template v-else>
              <div class="text-caption text-grey-7 q-pl-md q-mb-xs">
                <template v-if="directoryByGroup[m.groupId]">
                  {{ directoryByGroup[m.groupId].stats.activeMembers }} member(s) ·
                  {{ directoryByGroup[m.groupId].stats.recentlyActiveMembers }} active recently
                </template>
              </div>
              <div
                v-if="directoryByGroup[m.groupId] && !directoryByGroup[m.groupId].mentors.length"
                class="text-caption text-grey-6 q-pl-md"
              >
                No mentors are listed yet. You can still reply to anyone who messages you.
              </div>
              <div
                v-for="mentor in (directoryByGroup[m.groupId] ? directoryByGroup[m.groupId].mentors : [])"
                :key="mentor.pairwiseId"
                class="row items-center no-wrap q-pl-md q-py-xs"
                style="border-bottom: 1px solid #f0f0f0"
              >
                <div class="col">
                  <span class="text-body2">{{ mentor.alias }}</span>
                  <q-badge color="teal" label="mentor" class="q-ml-sm" />
                </div>
                <q-btn flat dense size="sm" color="primary" label="Message" @click="openCompose(m, mentor)" />
              </div>
            </template>
          </q-item-section>
        </q-item>

        <!-- Inbox for this membership -->
        <q-item v-if="expandedGroup === m.groupId">
          <q-item-section>
            <div v-if="!(messagesByGroup[m.groupId] || []).length" class="text-caption text-grey-6 q-pl-md">
              No messages yet.
            </div>
            <div
              v-for="msg in (messagesByGroup[m.groupId] || [])"
              :key="msg.id"
              class="q-pl-md q-py-xs"
              style="border-bottom: 1px solid #f0f0f0"
            >
              <div class="text-caption text-grey-7">
                From a group member · {{ formatDate(msg.receivedAt) }}
              </div>
              <div class="text-body2" style="white-space: pre-wrap; word-break: break-word">{{ msg.text }}</div>
              <q-btn flat dense size="sm" color="primary" label="Reply" @click="openReply(m, msg)" />
            </div>
          </q-item-section>
        </q-item>
      </template>
    </q-list>

    <!-- Compose / reply dialog -->
    <q-dialog v-model="showReplyDialog">
      <q-card style="min-width: 420px; max-width: 560px">
        <q-card-section>
          <div class="text-h6">{{ replyTo && replyTo.alias ? `Message ${replyTo.alias}` : 'Reply' }}</div>
          <div class="text-caption text-grey-7">Your message is end-to-end encrypted to the recipient.</div>
        </q-card-section>
        <q-card-section class="q-pt-none">
          <q-input v-model="replyText" type="textarea" outlined autogrow autofocus :disable="sendingReply" label="Message" />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="Cancel" v-close-popup :disable="sendingReply" />
          <q-btn unelevated color="primary" label="Send" :loading="sendingReply" :disable="!replyText.trim()" @click="sendReply" />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';

const $q = useQuasar();

const props = defineProps<{ userId: string }>();

interface Membership {
  groupId: string;
  groupName: string;
  registryUrl: string;
  pairwiseId: string;
  alias: string;
  joinedAt: string;
  credentialExpiresAt: string | null;
  mentor: boolean;
}

interface PendingInvite {
  token: string;
  groupId: string;
  registry: string;
  capturedAt?: string;
}

const INVITE_LS_KEY = 'maiaGroupInvite';

const memberships = ref<Membership[]>([]);
const loading = ref(false);
const pendingInvite = ref<PendingInvite | null>(null);
/** Persistent explanation when the invite token is dead (used/replaced/expired). */
const invalidInviteMessage = ref('');
const inviteGroupName = ref('');
const inviteGroupDescription = ref('');
const aliasInput = ref('');
const joining = ref(false);
const leaving = ref<string | null>(null);

interface GroupMessage {
  id: string;
  fromPairwiseId: string;
  text: string;
  receivedAt: string;
}
const expandedGroup = ref<string | null>(null);
const messagesByGroup = ref<Record<string, GroupMessage[]>>({});
const refreshing = ref<string | null>(null);
const showReplyDialog = ref(false);
const replyText = ref('');
const replyTo = ref<{ groupId: string; toPairwiseId: string; alias?: string } | null>(null);
const sendingReply = ref(false);

interface Directory {
  stats: { activeMembers: number; recentlyActiveMembers: number };
  mentors: { pairwiseId: string; alias: string }[];
}
const expandedDirectory = ref<string | null>(null);
const directoryByGroup = ref<Record<string, Directory>>({});
const loadingDirectory = ref<string | null>(null);

interface AsRequest {
  id: string;
  groupId: string;
  groupName: string;
  fromPairwiseId: string;
  action: string;
  resource: string;
  payload: unknown;
  receivedAt: string;
  status: string;
  aiSummary: string | null;
}
const requests = ref<AsRequest[]>([]);
const loadingRequests = ref(false);
const deciding = ref<string | null>(null);

const formatDate = (iso: string): string => {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
};

const loadMemberships = async () => {
  if (!props.userId) return;
  loading.value = true;
  try {
    const res = await fetch(`/api/user-groups?userId=${encodeURIComponent(props.userId)}`, {
      credentials: 'include'
    });
    const data = await res.json();
    if (res.ok && data.success) {
      memberships.value = data.memberships || [];
    }
  } catch {
    /* non-fatal — empty list shown */
  } finally {
    loading.value = false;
  }
};

const loadPendingInvite = async () => {
  try {
    const raw = localStorage.getItem(INVITE_LS_KEY);
    if (!raw) return;
    const invite = JSON.parse(raw) as PendingInvite;
    if (!invite?.token || !invite?.groupId) {
      localStorage.removeItem(INVITE_LS_KEY);
      return;
    }
    // Already a member of this group? A MAIA holds one membership per
    // group, so a second invite (e.g. to a different email) can't be
    // accepted as a new identity. Explain that clearly instead of silently
    // dropping it — and tell them how to switch aliases (leave, then use
    // the new invite).
    const existing = memberships.value.find((m) => m.groupId === invite.groupId);
    if (existing) {
      localStorage.removeItem(INVITE_LS_KEY);
      invalidInviteMessage.value =
        `You're already a member of this group as "${existing.alias}". ` +
        `A new invitation isn't needed. To join under a different name, use Leave on the group below, then open the new invitation.`;
      return;
    }
    pendingInvite.value = invite;
    // Group metadata for the banner + invite validity. invite-info also
    // marks the invite "opened" at the registry (admin-visible progress).
    try {
      const base = (invite.registry || window.location.origin).replace(/\/$/, '');
      const res = await fetch(
        `${base}/api/groups/${encodeURIComponent(invite.groupId)}/invite-info?token=${encodeURIComponent(invite.token)}`
      );
      const data = await res.json();
      if (res.ok && data.success) {
        inviteGroupName.value = data.group?.name || '';
        inviteGroupDescription.value = data.group?.description || '';
        if (data.invite && data.invite.valid === false) {
          // Dead token — persistent explanation, never a silent vanish.
          localStorage.removeItem(INVITE_LS_KEY);
          pendingInvite.value = null;
          const label = data.group?.name ? `"${data.group.name}"` : 'a patient group';
          invalidInviteMessage.value = data.invite.expired
            ? `Your invitation to join ${label} has expired. Ask your group administrator to send a new one.`
            : `This invitation link to join ${label} is no longer valid — it may have already been used, or a newer invitation replaced it (only the most recent invitation link works). Check your email for a newer invitation, or ask your group administrator to send one.`;
          return;
        }
      }
    } catch {
      /* banner falls back to generic text */
    }
  } catch {
    /* corrupted storage — clear it */
    localStorage.removeItem(INVITE_LS_KEY);
  }
};

const joinPendingGroup = async () => {
  if (!pendingInvite.value || !aliasInput.value.trim()) return;
  joining.value = true;
  try {
    const res = await fetch('/api/user-groups/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        groupId: pendingInvite.value.groupId,
        token: pendingInvite.value.token,
        alias: aliasInput.value.trim(),
        registryUrl: pendingInvite.value.registry || window.location.origin
      })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    localStorage.removeItem(INVITE_LS_KEY);
    pendingInvite.value = null;
    await loadMemberships();
    $q.notify({ type: 'positive', message: `Welcome to ${data.membership?.groupName || 'the group'}!` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to join group';
    // A dead token can't succeed on retry — swap the join banner for a
    // persistent explanation.
    if (/invalid|already|expired/i.test(msg)) {
      localStorage.removeItem(INVITE_LS_KEY);
      pendingInvite.value = null;
      invalidInviteMessage.value =
        `${msg}. Ask your group administrator to send a new invitation if needed.`;
    }
    $q.notify({ type: 'negative', message: msg });
  } finally {
    joining.value = false;
  }
};

const dismissInvite = () => {
  localStorage.removeItem(INVITE_LS_KEY);
  pendingInvite.value = null;
};

const confirmLeave = (m: Membership) => {
  $q.dialog({
    title: `Leave ${m.groupName}?`,
    message:
      `You'll no longer be reachable through this group, and you'll need a new invitation to rejoin. ` +
      `Your health records are unaffected — they never left your MAIA.`,
    ok: { label: 'Leave group', color: 'negative' },
    cancel: { label: 'Stay', flat: true }
  }).onOk(() => {
    void leaveGroup(m);
  });
};

const leaveGroup = async (m: Membership) => {
  leaving.value = m.groupId;
  try {
    const res = await fetch('/api/user-groups/leave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId: props.userId, groupId: m.groupId })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    await loadMemberships();
    $q.notify({
      type: 'positive',
      message: data.registryNotified
        ? `You've left ${m.groupName}.`
        : `You've left ${m.groupName} (the group registry will finalize within 24 hours).`
    });
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to leave group' });
  } finally {
    leaving.value = null;
  }
};

const loadMessages = async (groupId: string) => {
  try {
    const res = await fetch(
      `/api/user-groups/messages?userId=${encodeURIComponent(props.userId)}&groupId=${encodeURIComponent(groupId)}`,
      { credentials: 'include' }
    );
    const data = await res.json();
    if (res.ok && data.success) {
      messagesByGroup.value = { ...messagesByGroup.value, [groupId]: data.messages || [] };
    }
  } catch {
    /* keep prior list */
  }
};

const toggleMessages = async (m: Membership) => {
  if (expandedGroup.value === m.groupId) {
    expandedGroup.value = null;
    return;
  }
  expandedGroup.value = m.groupId;
  await loadMessages(m.groupId);
};

const refreshMessages = async (m: Membership) => {
  refreshing.value = m.groupId;
  try {
    const res = await fetch('/api/user-groups/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId: props.userId })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    await loadMessages(m.groupId);
    await loadMemberships(); // a revoked membership would drop off here
    await loadRequests(); // AS requests arrive via the same pull
    if (expandedGroup.value !== m.groupId) expandedGroup.value = m.groupId;
    const bits = [];
    if (data.newMessages) bits.push(`${data.newMessages} message(s)`);
    if (data.newRequests) bits.push(`${data.newRequests} request(s)`);
    $q.notify({
      type: bits.length ? 'positive' : 'info',
      message: bits.length ? `New: ${bits.join(', ')}.` : 'Nothing new.'
    });
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to check messages' });
  } finally {
    refreshing.value = null;
  }
};

const openReply = (m: Membership, msg: GroupMessage) => {
  replyTo.value = { groupId: m.groupId, toPairwiseId: msg.fromPairwiseId };
  replyText.value = '';
  showReplyDialog.value = true;
};

const loadDirectory = async (groupId: string) => {
  loadingDirectory.value = groupId;
  try {
    const res = await fetch(
      `/api/user-groups/directory?userId=${encodeURIComponent(props.userId)}&groupId=${encodeURIComponent(groupId)}`,
      { credentials: 'include' }
    );
    const data = await res.json();
    if (res.ok && data.success) {
      directoryByGroup.value = {
        ...directoryByGroup.value,
        [groupId]: { stats: data.stats, mentors: data.mentors || [] }
      };
    }
  } catch {
    /* panel shows nothing */
  } finally {
    loadingDirectory.value = null;
  }
};

const toggleDirectory = async (m: Membership) => {
  if (expandedDirectory.value === m.groupId) {
    expandedDirectory.value = null;
    return;
  }
  expandedDirectory.value = m.groupId;
  await loadDirectory(m.groupId);
};

const openCompose = (m: Membership, mentor: { pairwiseId: string; alias: string }) => {
  replyTo.value = { groupId: m.groupId, toPairwiseId: mentor.pairwiseId, alias: mentor.alias };
  replyText.value = '';
  showReplyDialog.value = true;
};

const sendReply = async () => {
  if (!replyTo.value || !replyText.value.trim()) return;
  sendingReply.value = true;
  try {
    const res = await fetch('/api/user-groups/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        groupId: replyTo.value.groupId,
        toPairwiseId: replyTo.value.toPairwiseId,
        text: replyText.value.trim()
      })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    showReplyDialog.value = false;
    $q.notify({ type: 'positive', message: 'Message sent.' });
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to send message' });
  } finally {
    sendingReply.value = false;
  }
};

const loadRequests = async () => {
  loadingRequests.value = true;
  try {
    const res = await fetch(`/api/user-groups/requests?userId=${encodeURIComponent(props.userId)}`, {
      credentials: 'include'
    });
    const data = await res.json();
    if (res.ok && data.success) requests.value = data.requests || [];
  } catch {
    /* keep prior list */
  } finally {
    loadingRequests.value = false;
  }
};

const decide = async (r: AsRequest, decision: 'accept' | 'decline' | 'block') => {
  deciding.value = r.id;
  try {
    const res = await fetch(`/api/user-groups/requests/${encodeURIComponent(r.id)}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId: props.userId, decision })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    await loadRequests();
    $q.notify({ type: 'positive', message: `Request ${data.status}.` });
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to record decision' });
  } finally {
    deciding.value = null;
  }
};

onMounted(async () => {
  await loadMemberships();
  await loadRequests();
  await loadPendingInvite();
});
</script>
