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
      <q-item v-for="m in memberships" :key="m.groupId">
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
          <q-btn flat dense color="negative" label="Leave" :loading="leaving === m.groupId" @click="confirmLeave(m)" />
        </q-item-section>
      </q-item>
    </q-list>
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

onMounted(async () => {
  await loadMemberships();
  await loadPendingInvite();
});
</script>
