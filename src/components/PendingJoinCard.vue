<template>
  <div v-if="pendingInvite || pendingJoinLink || invalidMessage">
    <!-- Pending email invite -->
    <div v-if="pendingInvite" class="join-card">
      <div class="row items-center no-wrap q-gutter-xs">
        <q-icon name="mail" color="primary" size="18px" />
        <div class="text-caption">
          <template v-if="inviteGroupName">
            Invited to <strong>{{ inviteGroupName }}</strong>
          </template>
          <template v-else>Group invitation</template>
        </div>
      </div>
      <div v-if="inviteGroupDescription" class="text-caption text-grey-7 q-mt-xs">
        {{ inviteGroupDescription }}
      </div>
      <div v-if="inviteGroupPolicy" class="join-policy-note q-mt-xs">
        <div class="text-caption text-weight-medium">Group policy — joining means you accept it:</div>
        <div class="text-caption" style="white-space: pre-wrap">{{ inviteGroupPolicy }}</div>
      </div>
      <div v-if="inviteSuggestedCount" class="text-caption text-grey-7 q-mt-xs">
        Joining adds {{ inviteSuggestedCount }} suggested sharing
        {{ inviteSuggestedCount === 1 ? 'policy' : 'policies' }} from this group
        to your list — yours to edit or turn off.
      </div>
      <q-input
        v-model="aliasInput"
        dense outlined
        class="q-mt-sm"
        label="Your display name in this group"
        hint="Members will know you by this name — change it if you like"
        :disable="joining"
      />
      <div class="row q-gutter-xs q-mt-sm">
        <q-btn
          dense unelevated size="sm" color="primary" label="Join"
          :loading="joining" :disable="!aliasInput.trim()"
          @click="joinPendingGroup"
        />
        <q-btn dense flat size="sm" color="grey-7" label="Dismiss" :disable="joining" @click="dismissInvite" />
      </div>
    </div>

    <!-- Shareable join link -->
    <div v-if="pendingJoinLink" class="join-card">
      <div class="row items-center no-wrap q-gutter-xs">
        <q-icon name="how_to_reg" color="primary" size="18px" />
        <div class="text-caption">
          <template v-if="joinLinkMode === 'open'">
            Join <strong>{{ joinLinkGroupName || 'this group' }}</strong>
            — you'll be a member immediately.
          </template>
          <template v-else>
            Request to join
            <strong>{{ joinLinkGroupName || 'this group' }}</strong>
            — the group's administrator approves each request.
          </template>
        </div>
      </div>
      <div v-if="joinLinkGroupPolicy" class="join-policy-note q-mt-xs">
        <div class="text-caption text-weight-medium">Group policy — joining means you accept it:</div>
        <div class="text-caption" style="white-space: pre-wrap">{{ joinLinkGroupPolicy }}</div>
      </div>
      <div v-if="joinLinkSuggestedCount" class="text-caption text-grey-7 q-mt-xs">
        Joining adds {{ joinLinkSuggestedCount }} suggested sharing
        {{ joinLinkSuggestedCount === 1 ? 'policy' : 'policies' }} from this group
        to your list — yours to edit or turn off.
      </div>
      <q-input
        v-model="joinAliasInput"
        dense outlined
        class="q-mt-sm"
        label="Your display name in this group"
        hint="Members will know you by this name — change it if you like"
        :disable="requestingJoin"
      />
      <div class="row q-gutter-xs q-mt-sm">
        <q-btn
          dense unelevated size="sm" color="primary"
          :label="joinLinkMode === 'open' ? 'Join group' : 'Request to join'"
          :loading="requestingJoin" :disable="!joinAliasInput.trim()"
          @click="submitJoinRequest"
        />
        <q-btn dense flat size="sm" color="grey-7" label="Dismiss" :disable="requestingJoin" @click="dismissJoinLink" />
      </div>
    </div>

    <!-- Dead token: persistent explanation, dismissible -->
    <div v-if="invalidMessage" class="join-card join-card--invalid">
      <div class="row items-start no-wrap q-gutter-xs">
        <q-icon name="link_off" color="negative" size="18px" class="q-mt-xs" />
        <div class="text-caption">{{ invalidMessage }}</div>
      </div>
      <q-btn dense flat size="sm" color="negative" label="Dismiss" class="q-mt-xs" @click="invalidMessage = ''" />
    </div>
  </div>
</template>

<script setup lang="ts">
// Pending group invite/join-link card — the single shared implementation
// used at the top of the Sharing Policies tab (a new member's landing
// after the wizard) and in the Groups rail. Reads the tokens captured in
// localStorage by App.vue, fetches group info through OUR server proxy,
// and performs the join; parents react via emits.
import { ref, computed, watch, onMounted } from 'vue';
import { useQuasar } from 'quasar';

const $q = useQuasar();

const props = defineProps<{
  userId: string;
  /** Existing memberships (for "already a member" dedupe). Optional —
   *  without it the server rejects duplicates and we surface the error. */
  memberships?: Array<{ groupId: string; alias?: string }>;
  /** Group ids with a join request already pending admin approval. */
  pendingJoinGroupIds?: string[];
}>();

const emit = defineEmits<{
  /** Membership exists NOW (invite join, or open-mode instant join). */
  (e: 'joined', payload: { groupId: string }): void;
  /** Link-approval request sent — pending the admin. */
  (e: 'requested'): void;
  /** Whether the card is showing anything (parents gate empty-states). */
  (e: 'active', value: boolean): void;
}>();

const INVITE_LS_KEY = 'maiaGroupInvite';
const JOIN_LINK_LS_KEY = 'maiaGroupJoin';

interface PendingInvite { token: string; groupId: string; registry: string }

const pendingInvite = ref<PendingInvite | null>(null);
const invalidMessage = ref('');
const inviteGroupName = ref('');
const inviteGroupDescription = ref('');
const inviteGroupPolicy = ref('');
const inviteSuggestedCount = ref(0);
const aliasInput = ref('');
const joining = ref(false);

const pendingJoinLink = ref<{ token: string; groupId: string; registry: string } | null>(null);
const joinLinkGroupName = ref('');
const joinLinkGroupPolicy = ref('');
const joinLinkSuggestedCount = ref(0);
const joinLinkMode = ref<'link-approval' | 'open'>('link-approval');
const joinAliasInput = ref('');
const requestingJoin = ref(false);

const isActive = computed(() => !!(pendingInvite.value || pendingJoinLink.value || invalidMessage.value));
watch(isActive, (v) => emit('active', v), { immediate: true });

const loadPendingInvite = async () => {
  try {
    const raw = localStorage.getItem(INVITE_LS_KEY);
    if (!raw) return;
    const invite = JSON.parse(raw);
    if (!invite?.token || !invite?.groupId) {
      localStorage.removeItem(INVITE_LS_KEY);
      return;
    }
    // Already a member: an old invite link can't re-join, and silently
    // dropping it would be confusing — explain, and how to switch aliases.
    const existing = (props.memberships || []).find((m) => m.groupId === invite.groupId);
    if (existing) {
      localStorage.removeItem(INVITE_LS_KEY);
      invalidMessage.value =
        `You're already a member of this group as "${existing.alias || 'your current name'}". ` +
        `A new invitation isn't needed. To join under a different name, open the group and use Leave, then open the new invitation.`;
      return;
    }
    pendingInvite.value = invite;
    // Prefill with the MAIA pseudonym so joining is one click; editable.
    if (!aliasInput.value.trim() && props.userId) aliasInput.value = props.userId;
    try {
      // Proxied through OUR server (PR-11): works when the group's
      // registry is a different deployment, with CORS staying closed.
      const base = (invite.registry || window.location.origin).replace(/\/$/, '');
      const res = await fetch(
        `/api/user-groups/invite-info?userId=${encodeURIComponent(props.userId)}&registry=${encodeURIComponent(base)}` +
        `&groupId=${encodeURIComponent(invite.groupId)}&token=${encodeURIComponent(invite.token)}`,
        { credentials: 'include' }
      );
      const data = await res.json();
      if (res.ok && data.success) {
        inviteGroupName.value = data.group?.name || '';
        inviteGroupDescription.value = data.group?.description || '';
        inviteGroupPolicy.value = data.group?.postingPolicy || '';
        inviteSuggestedCount.value = (data.group?.suggestedPolicies || []).length;
        if (data.invite && data.invite.valid === false) {
          // Dead token — persistent explanation, never a silent vanish.
          localStorage.removeItem(INVITE_LS_KEY);
          pendingInvite.value = null;
          const label = data.group?.name ? `"${data.group.name}"` : 'a patient group';
          invalidMessage.value = data.invite.expired
            ? `Your invitation to join ${label} has expired. Ask your group administrator to send a new one.`
            : `This invitation link to join ${label} is no longer valid — it may have already been used, or a newer invitation replaced it (only the most recent invitation link works). Check your email for a newer invitation, or ask your group administrator to send one.`;
          return;
        }
      }
    } catch { /* banner falls back to generic text */ }
  } catch {
    localStorage.removeItem(INVITE_LS_KEY);
  }
};

const loadPendingJoinLink = async () => {
  try {
    const raw = localStorage.getItem(JOIN_LINK_LS_KEY);
    if (!raw) return;
    const link = JSON.parse(raw);
    if (!link?.token || !link?.groupId) {
      localStorage.removeItem(JOIN_LINK_LS_KEY);
      return;
    }
    if ((props.memberships || []).some((m) => m.groupId === link.groupId) ||
        (props.pendingJoinGroupIds || []).includes(link.groupId)) {
      localStorage.removeItem(JOIN_LINK_LS_KEY); // already joined/requested
      return;
    }
    pendingJoinLink.value = link;
    if (!joinAliasInput.value.trim() && props.userId) joinAliasInput.value = props.userId;
    try {
      const base = String(link.registry || window.location.origin).replace(/\/$/, '');
      const res = await fetch(
        `/api/user-groups/join-info?userId=${encodeURIComponent(props.userId)}&registry=${encodeURIComponent(base)}` +
        `&groupId=${encodeURIComponent(link.groupId)}&token=${encodeURIComponent(link.token)}`,
        { credentials: 'include' }
      );
      const data = await res.json();
      if (res.ok && data.success) {
        if (!data.valid) {
          localStorage.removeItem(JOIN_LINK_LS_KEY);
          pendingJoinLink.value = null;
          invalidMessage.value =
            'This join link is no longer active — it may have been rotated or turned off. Ask the group for a fresh link or QR code.';
          return;
        }
        joinLinkGroupName.value = data.group?.name || '';
        joinLinkGroupPolicy.value = data.group?.postingPolicy || '';
        joinLinkSuggestedCount.value = (data.group?.suggestedPolicies || []).length;
        joinLinkMode.value = data.joinMode || 'link-approval';
      }
    } catch { /* generic card text */ }
  } catch {
    localStorage.removeItem(JOIN_LINK_LS_KEY);
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
    const groupId = pendingInvite.value.groupId;
    pendingInvite.value = null;
    $q.notify({ type: 'positive', message: `Welcome to ${data.membership?.groupName || 'the group'}!` });
    emit('joined', { groupId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to join group';
    // A dead token can't succeed on retry — swap the card for a
    // persistent explanation.
    if (/invalid|already|expired/i.test(msg)) {
      localStorage.removeItem(INVITE_LS_KEY);
      pendingInvite.value = null;
      invalidMessage.value =
        `${msg}. Ask your group administrator to send a new invitation if needed.`;
    }
    $q.notify({ type: 'negative', message: msg });
  } finally {
    joining.value = false;
  }
};

const submitJoinRequest = async () => {
  if (!pendingJoinLink.value || !joinAliasInput.value.trim()) return;
  requestingJoin.value = true;
  try {
    const res = await fetch('/api/user-groups/request-join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        groupId: pendingJoinLink.value.groupId,
        token: pendingJoinLink.value.token,
        alias: joinAliasInput.value.trim(),
        registryUrl: pendingJoinLink.value.registry || window.location.origin
      })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    localStorage.removeItem(JOIN_LINK_LS_KEY);
    const groupId = pendingJoinLink.value.groupId;
    pendingJoinLink.value = null;
    if (data.joined && data.membership) {
      // Open-mode group: admitted in the same round trip.
      $q.notify({ type: 'positive', message: `You're in — welcome to ${data.membership.groupName}!` });
      emit('joined', { groupId });
    } else {
      $q.notify({
        type: 'positive',
        message: `Request sent. You'll be connected as soon as ${data.pending?.groupName || 'the group'}'s administrator approves.`
      });
      emit('requested');
    }
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to send join request' });
  } finally {
    requestingJoin.value = false;
  }
};

const dismissInvite = () => {
  localStorage.removeItem(INVITE_LS_KEY);
  pendingInvite.value = null;
};

const dismissJoinLink = () => {
  localStorage.removeItem(JOIN_LINK_LS_KEY);
  pendingJoinLink.value = null;
};

const reload = async () => {
  await loadPendingInvite();
  await loadPendingJoinLink();
};
defineExpose({ reload });

// Memberships often arrive after mount (parent loads them async) —
// re-run the dedupe so a stale card for an already-joined group clears.
watch(
  () => [props.memberships, props.pendingJoinGroupIds],
  () => {
    if (pendingInvite.value &&
        (props.memberships || []).some((m) => m.groupId === pendingInvite.value?.groupId)) {
      dismissInvite();
    }
    if (pendingJoinLink.value &&
        ((props.memberships || []).some((m) => m.groupId === pendingJoinLink.value?.groupId) ||
         (props.pendingJoinGroupIds || []).includes(pendingJoinLink.value.groupId))) {
      dismissJoinLink();
    }
  },
  { deep: true }
);

onMounted(reload);
</script>

<style scoped lang="scss">
.join-card {
  margin: 0 8px 8px;
  padding: 10px;
  border: 1px solid #bbdefb;
  border-radius: 10px;
  background: #e3f2fd;

  &--invalid {
    border-color: #ffcdd2;
    background: #ffebee;
  }
}

.join-policy-note {
  border-left: 3px solid #90caf9;
  padding-left: 8px;
}
</style>
