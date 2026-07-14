<template>
  <div class="groups-shell">
    <!-- ── Left rail: groups + peer conversations (Signal-style) ────── -->
    <div class="groups-rail">
      <div class="groups-rail__header">
        <div class="text-subtitle1 text-weight-bold">Groups</div>
        <div class="row no-wrap items-center">
          <q-btn flat dense round size="sm" icon="add_link" @click="showPasteLinkDialog = true">
            <q-tooltip>Join a group with an invite or join link — including groups hosted on another MAIA</q-tooltip>
          </q-btn>
          <q-btn
            flat dense round size="sm" icon="refresh"
            :loading="refreshingAll"
            @click="refreshAll"
          >
            <q-tooltip>Check for new messages</q-tooltip>
          </q-btn>
        </div>
      </div>

      <!-- Pending invite (compact card) -->
      <div v-if="pendingInvite" class="groups-invite-card">
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
        <div v-if="inviteGroupPolicy" class="groups-policy-note q-mt-xs">
          <div class="text-caption text-weight-medium">Group policy — joining means you accept it:</div>
          <div class="text-caption" style="white-space: pre-wrap">{{ inviteGroupPolicy }}</div>
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

      <!-- Dead invite token: persistent explanation, dismissible -->
      <div v-if="invalidInviteMessage" class="groups-invite-card groups-invite-card--invalid">
        <div class="row items-start no-wrap q-gutter-xs">
          <q-icon name="link_off" color="negative" size="18px" class="q-mt-xs" />
          <div class="text-caption">{{ invalidInviteMessage }}</div>
        </div>
        <q-btn dense flat size="sm" color="negative" label="Dismiss" class="q-mt-xs" @click="invalidInviteMessage = ''" />
      </div>

      <!-- Shareable join link (PR-9): request to join, admin approves -->
      <div v-if="pendingJoinLink" class="groups-invite-card">
        <div class="row items-center no-wrap q-gutter-xs">
          <q-icon name="how_to_reg" color="primary" size="18px" />
          <div class="text-caption">
            Request to join
            <strong>{{ pendingJoinLinkGroupName || 'this group' }}</strong>
            — the group's administrator approves each request.
          </div>
        </div>
        <div v-if="joinLinkGroupPolicy" class="groups-policy-note q-mt-xs">
          <div class="text-caption text-weight-medium">Group policy — joining means you accept it:</div>
          <div class="text-caption" style="white-space: pre-wrap">{{ joinLinkGroupPolicy }}</div>
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
            dense unelevated size="sm" color="primary" label="Request to join"
            :loading="requestingJoin" :disable="!joinAliasInput.trim()"
            @click="submitJoinRequest"
          />
          <q-btn dense flat size="sm" color="grey-7" label="Dismiss" :disable="requestingJoin" @click="dismissJoinLink" />
        </div>
      </div>

      <div v-if="loading" class="text-center q-pa-md">
        <q-spinner size="1.5em" />
      </div>
      <div
        v-else-if="memberships.length === 0 && !pendingInvite"
        class="text-caption text-grey-7 q-pa-md"
      >
        You're not in any groups yet. Group admins send invitations by email —
        the invite link brings you back here to join.
      </div>

      <!-- Group sections -->
      <div v-for="m in memberships" :key="m.groupId" class="groups-rail__section">
        <button
          type="button"
          class="groups-rail__group"
          :class="{ 'is-selected': isSelected(m.groupId, null) }"
          @click="selectGroup(m)"
        >
          <q-icon name="groups" size="18px" color="primary" />
          <span class="groups-rail__group-name">{{ m.groupName }}</span>
          <q-icon name="info_outline" size="14px" class="text-grey-6">
            <q-tooltip>Group info: find peers, invite someone, leave</q-tooltip>
          </q-icon>
        </button>

        <!-- Conversations (peers) inside this group -->
        <div
          v-for="c in conversationsFor(m.groupId)"
          :key="c.peerId"
          class="groups-rail__convo"
          :class="{ 'is-selected': isSelected(m.groupId, c.peerId) }"
          role="button"
          tabindex="0"
          @click="selectPeer(m, c.peerId)"
          @keydown.enter="selectPeer(m, c.peerId)"
        >
          <div class="groups-rail__avatar" :style="{ background: avatarColor(c.peerId) }">
            {{ (c.alias || '?').slice(0, 1).toUpperCase() }}
          </div>
          <div class="groups-rail__convo-body">
            <div class="row items-center no-wrap">
              <span class="groups-rail__convo-name" :class="{ 'text-weight-bold': c.unread > 0 }">
                {{ c.alias || 'Group member' }}
              </span>
              <q-icon v-if="c.mentor" name="star" size="12px" color="teal" class="q-ml-xs" style="flex: 0 0 auto">
                <q-tooltip>Mentor</q-tooltip>
              </q-icon>
              <span class="groups-rail__convo-time">{{ shortTime(c.lastAt) }}</span>
            </div>
            <div class="row items-center no-wrap">
              <span class="groups-rail__convo-snippet" :class="{ 'text-weight-medium': c.unread > 0 }">
                <template v-if="c.hasPendingRequest">Wants to connect</template>
                <template v-else>{{ c.snippet }}</template>
              </span>
              <q-badge v-if="c.unread > 0" rounded color="primary" :label="c.unread" class="q-ml-xs" />
              <q-icon v-else-if="c.hasPendingRequest" name="person_add" size="14px" color="primary" class="q-ml-xs" />
            </div>
          </div>
        </div>
      </div>
      <!-- Join requests awaiting admin approval (PR-9) -->
      <div
        v-for="p in pendingJoins"
        :key="`pending:${p.groupId}`"
        class="groups-rail__convo"
        style="cursor: default; opacity: 0.75"
      >
        <q-icon name="hourglass_top" size="20px" color="grey-6" style="flex: 0 0 auto" />
        <div class="groups-rail__convo-body">
          <div class="groups-rail__convo-name">{{ p.groupName }}</div>
          <div class="groups-rail__convo-snippet">Waiting for approval as {{ p.alias }}</div>
        </div>
      </div>
    </div>

    <!-- ── Right pane: thread / group info / empty state ─────────────── -->
    <div class="groups-main">
      <!-- Empty state -->
      <div v-if="!selected" class="groups-main__empty">
        <q-icon name="forum" size="52px" class="text-grey-4" />
        <div class="text-body2 text-grey-6 q-mt-sm" style="max-width: 380px; text-align: center">
          Connect with patients who share your situation. Your records never
          leave your MAIA — groups only mediate introductions and messages you
          approve.
        </div>
        <div v-if="memberships.length" class="text-caption text-grey-5 q-mt-sm">
          Select a conversation, or open a group to find peers.
        </div>
      </div>

      <!-- Group info / find peers -->
      <template v-else-if="selected && !selected.peerId && selectedMembership">
        <div class="groups-main__header">
          <q-icon name="groups" color="primary" size="22px" />
          <div class="groups-main__header-text">
            <div class="text-subtitle2">{{ selectedMembership.groupName }}</div>
            <div class="text-caption text-grey-7">
              You appear as <strong>{{ selectedMembership.alias }}</strong>
              · Joined {{ formatDate(selectedMembership.joinedAt) }}
              <q-badge v-if="selectedMembership.mentor" color="teal" label="Mentor" class="q-ml-xs" />
            </div>
          </div>
          <q-space />
          <q-btn
            flat dense color="negative" size="sm" label="Leave"
            :loading="leaving === selectedMembership.groupId"
            @click="confirmLeave(selectedMembership)"
          />
        </div>

        <div class="groups-main__scroll q-pa-md">
          <div class="text-caption text-grey-7 q-mb-sm" v-if="directoryByGroup[selectedMembership.groupId]">
            {{ directoryByGroup[selectedMembership.groupId].stats.activeMembers }} member(s) ·
            {{ directoryByGroup[selectedMembership.groupId].stats.recentlyActiveMembers }} active recently
          </div>
          <div v-if="loadingDirectory === selectedMembership.groupId" class="text-caption text-grey-6">
            Loading peers…
          </div>
          <template v-else>
            <div v-if="directoryByGroup[selectedMembership.groupId]?.postingPolicy" class="q-mb-md">
              <div class="text-subtitle2 q-mb-xs">Group policy</div>
              <div class="text-caption text-grey-8" style="white-space: pre-wrap">
                {{ directoryByGroup[selectedMembership.groupId]?.postingPolicy }}
              </div>
            </div>
            <div class="text-subtitle2 q-mb-xs">Peers you can reach</div>
            <div
              v-if="directoryByGroup[selectedMembership.groupId] && !directoryByGroup[selectedMembership.groupId].mentors.length"
              class="text-caption text-grey-6"
            >
              No mentors are listed yet. You can still reply to anyone who
              messages you — and anyone in the group can message you.
            </div>
            <div
              v-for="mentor in (directoryByGroup[selectedMembership.groupId]?.mentors || [])"
              :key="mentor.pairwiseId"
              class="groups-peer-row"
            >
              <div class="groups-rail__avatar" :style="{ background: avatarColor(mentor.pairwiseId) }">
                {{ mentor.alias.slice(0, 1).toUpperCase() }}
              </div>
              <span class="text-body2">{{ mentor.alias }}</span>
              <q-badge color="teal" label="mentor" />
              <q-space />
              <q-btn
                dense flat size="sm" color="primary" label="Message"
                @click="selectPeer(selectedMembership, mentor.pairwiseId)"
              />
            </div>

            <!-- Member-initiated invite (PR-8): any member can grow the
                 group unless the admin disabled it (registry enforces). -->
            <div class="text-subtitle2 q-mt-md q-mb-xs">Invite someone</div>
            <div class="text-caption text-grey-7 q-mb-sm">
              Know someone who belongs here? They'll get an email invitation,
              and you'll be their first conversation when they join.
            </div>
            <div class="row items-center q-gutter-sm">
              <q-input
                v-model="inviteEmailInput"
                dense outlined type="email"
                label="Their email"
                style="min-width: 240px"
                :disable="sendingInvite"
                @keydown.enter.prevent="sendMemberInvite"
              />
              <q-btn
                dense unelevated color="primary" label="Invite"
                :loading="sendingInvite"
                :disable="!inviteEmailInput.trim()"
                @click="sendMemberInvite"
              />
            </div>
            <div v-if="lastInviteLink" class="text-caption q-mt-sm" style="word-break: break-all">
              <template v-if="lastInviteEmailSent">Invitation emailed.</template>
              <template v-else>Email isn't configured on this server — share this link yourself:</template>
              <div class="q-mt-xs">
                <a :href="lastInviteLink" @click.prevent>{{ lastInviteLink }}</a>
                <q-btn dense flat size="sm" icon="content_copy" @click="copyInviteLink">
                  <q-tooltip>Copy link</q-tooltip>
                </q-btn>
              </div>
            </div>
          </template>
        </div>
      </template>

      <!-- Peer conversation thread -->
      <template v-else-if="selected && selected.peerId && selectedMembership">
        <div class="groups-main__header">
          <div class="groups-rail__avatar" :style="{ background: avatarColor(selected.peerId) }">
            {{ (selectedPeerAlias || '?').slice(0, 1).toUpperCase() }}
          </div>
          <div class="groups-main__header-text">
            <div class="text-subtitle2">{{ selectedPeerAlias || 'Group member' }}</div>
            <div class="text-caption text-grey-7">{{ selectedMembership.groupName }} · end-to-end encrypted</div>
          </div>
          <q-space />
          <q-btn flat dense round size="sm" icon="rule" color="primary" @click="openRequestDialog">
            <q-tooltip>Request records from {{ selectedPeerAlias || 'this member' }} — their sharing policies (or they themselves) decide</q-tooltip>
          </q-btn>
        </div>

        <div ref="threadScrollEl" class="groups-main__scroll groups-thread">
          <div v-if="!threadItems.length && !pendingRequestFromPeer" class="text-caption text-grey-6 text-center q-mt-lg">
            No messages yet. Say hello — your message is end-to-end encrypted
            to {{ selectedPeerAlias || 'this member' }}.
          </div>

          <div
            v-for="item in threadItems"
            :key="item.id"
            class="groups-bubble-row"
            :class="item.direction === 'out' ? 'is-out' : 'is-in'"
          >
            <div class="groups-bubble" :class="item.direction === 'out' ? 'groups-bubble--out' : 'groups-bubble--in'">
              <div class="groups-bubble__text">{{ item.text }}</div>
              <div class="groups-bubble__time">{{ bubbleTime(item.at) }}</div>
            </div>
          </div>

          <!-- A request auto-accepted by a sharing policy: show WHICH card
               decided (the audit trail teaches the policy system) -->
          <div v-if="policyDecidedForPeer" class="text-caption text-grey-7 text-center q-my-sm">
            <q-icon name="policy" size="14px" color="green" />
            Auto-accepted by your policy: “{{ policyDecidedForPeer }}”
          </div>

          <!-- Pending first-contact request from this peer (Signal's
               "message request" pattern) -->
          <div v-if="pendingRequestFromPeer" class="groups-request-card">
            <div class="text-body2">
              <strong>{{ selectedPeerAlias || 'A group member' }}</strong> wants to connect
              <span class="text-grey-7">({{ pendingRequestFromPeer.action }})</span>
            </div>
            <div v-if="pendingRequestFromPeer.aiSummary" class="text-caption text-grey-8 q-mt-xs">
              {{ pendingRequestFromPeer.aiSummary }}
            </div>
            <div
              v-else-if="pendingRequestFromPeer.payload"
              class="text-caption text-grey-8 q-mt-xs"
              style="white-space: pre-wrap; word-break: break-word"
            >
              {{ typeof pendingRequestFromPeer.payload === 'string' ? pendingRequestFromPeer.payload : JSON.stringify(pendingRequestFromPeer.payload) }}
            </div>
            <div class="text-caption text-grey-6 q-mt-xs">{{ formatDate(pendingRequestFromPeer.receivedAt) }}</div>
            <div class="q-mt-sm q-gutter-sm">
              <q-btn dense unelevated size="sm" color="primary" label="Accept" :loading="deciding === pendingRequestFromPeer.id" @click="decide(pendingRequestFromPeer, 'accept')" />
              <q-btn dense flat size="sm" color="grey-8" label="Decline" :loading="deciding === pendingRequestFromPeer.id" @click="decide(pendingRequestFromPeer, 'decline')" />
              <q-btn dense flat size="sm" color="negative" label="Block" :loading="deciding === pendingRequestFromPeer.id" @click="decide(pendingRequestFromPeer, 'block')" />
            </div>
          </div>
        </div>

        <!-- Composer -->
        <div class="groups-composer">
          <q-input
            v-model="composerText"
            dense outlined autogrow
            :max-height="120"
            placeholder="Message"
            :disable="sending"
            class="groups-composer__input"
            @keydown.enter.exact.prevent="sendMessage"
          />
          <q-btn
            round unelevated color="primary" icon="send" size="sm"
            :loading="sending" :disable="!composerText.trim()"
            @click="sendMessage"
          />
        </div>
      </template>
    </div>

    <!-- Data request (PR-13): ask a peer for part of their record. Their
         AS decides: a matching allow card answers autonomously, a deny
         card drops it silently, otherwise they get asked. -->
    <q-dialog v-model="showRequestDialog">
      <q-card style="min-width: 460px; max-width: 600px">
        <q-card-section>
          <div class="text-h6">Request records from {{ selectedPeerAlias || 'this member' }}</div>
          <div class="text-caption text-grey-7">
            Delivered to their MAIA's authorization server — their sharing
            policies decide automatically, or they're asked. You'll see a
            reply if and when they (or their policies) allow it.
          </div>
        </q-card-section>
        <q-card-section class="q-pt-none">
          <div class="row q-col-gutter-sm">
            <q-select v-model="reqScope" :options="SCOPE_OPTIONS" emit-value map-options dense outlined label="What you're asking for" class="col-12" />
            <q-select v-model="reqPurpose" :options="PURPOSE_OPTIONS" emit-value map-options dense outlined label="Purpose" class="col-12" />
            <q-input v-model="reqNote" dense outlined autogrow label="Note (optional)" class="col-12" />
          </div>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="Cancel" v-close-popup :disable="sendingDataRequest" />
          <q-btn unelevated color="primary" label="Send request" :loading="sendingDataRequest" @click="sendDataRequest" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Paste an invite / join link (PR-11: works for groups hosted on
         ANY MAIA deployment — your account stays right here) -->
    <q-dialog v-model="showPasteLinkDialog">
      <q-card style="min-width: 420px; max-width: 560px">
        <q-card-section>
          <div class="text-h6">Join a group by link</div>
          <div class="text-caption text-grey-7">
            Paste the invitation or join link you received. The group can be
            hosted on this MAIA or any other — you join with the account
            you're signed into now.
          </div>
        </q-card-section>
        <q-card-section class="q-pt-none">
          <q-input
            v-model="pasteLinkInput"
            dense outlined autofocus
            label="Invite or join link"
            placeholder="https://…/?groupInvite=…&groupId=…"
            @keydown.enter.prevent="applyPastedLink"
          />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="Cancel" v-close-popup />
          <q-btn unelevated color="primary" label="Continue" :disable="!pasteLinkInput.trim()" @click="applyPastedLink" />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import { useQuasar } from 'quasar';
import { SCOPE_OPTIONS, PURPOSE_OPTIONS, type Scope, type Purpose } from '../utils/policyCards';

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
  /** Set when this membership came from a member's invitation — seeds
   *  the first conversation with the inviter. */
  invitedBy?: { pairwiseId: string; alias: string | null } | null;
}

interface PendingInvite {
  token: string;
  groupId: string;
  registry: string;
  capturedAt?: string;
}

const INVITE_LS_KEY = 'maiaGroupInvite';
const JOIN_LINK_LS_KEY = 'maiaGroupJoin';
/** Per-thread "last seen" timestamps (client-side unread tracking). */
const THREAD_SEEN_LS_KEY = 'maia.groupThreadSeen';

const memberships = ref<Membership[]>([]);
const loading = ref(false);
const pendingInvite = ref<PendingInvite | null>(null);
/** Persistent explanation when the invite token is dead (used/replaced/expired). */
const invalidInviteMessage = ref('');
const inviteGroupName = ref('');
const inviteGroupDescription = ref('');
const inviteGroupPolicy = ref('');
const aliasInput = ref('');
const joining = ref(false);
const leaving = ref<string | null>(null);

interface GroupMessage {
  id: string;
  fromPairwiseId: string;
  fromAlias?: string | null;
  text: string;
  receivedAt: string;
}
interface SentMessage {
  id: string;
  toPairwiseId: string;
  toAlias?: string | null;
  text: string;
  sentAt: string;
}
const messagesByGroup = ref<Record<string, GroupMessage[]>>({});
const sentByGroup = ref<Record<string, SentMessage[]>>({});
const refreshingAll = ref(false);

interface Directory {
  stats: { activeMembers: number; recentlyActiveMembers: number };
  postingPolicy?: string;
  mentors: { pairwiseId: string; alias: string }[];
}
const directoryByGroup = ref<Record<string, Directory>>({});
const loadingDirectory = ref<string | null>(null);

interface AsRequest {
  id: string;
  groupId: string;
  groupName: string;
  fromPairwiseId: string;
  fromAlias?: string | null;
  action: string;
  resource: string;
  decidedBySentence?: string | null;
  payload: unknown;
  receivedAt: string;
  status: string;
  aiSummary: string | null;
}
const requests = ref<AsRequest[]>([]);
const deciding = ref<string | null>(null);

// ── Selection (Signal-style): a group (info pane) or a peer (thread) ──
const selected = ref<{ groupId: string; peerId: string | null } | null>(null);
const composerText = ref('');
const sending = ref(false);
const threadScrollEl = ref<HTMLElement | null>(null);

const selectedMembership = computed(() =>
  selected.value ? memberships.value.find((m) => m.groupId === selected.value?.groupId) || null : null
);

const isSelected = (groupId: string, peerId: string | null) =>
  !!selected.value && selected.value.groupId === groupId && selected.value.peerId === peerId;

// ── Per-thread unread tracking (localStorage) ──────────────────────
const threadSeen = ref<Record<string, string>>({});
const seenKey = (groupId: string, peerId: string) => `${groupId}|${peerId}`;
const loadThreadSeen = () => {
  try {
    threadSeen.value = JSON.parse(window.localStorage.getItem(`${THREAD_SEEN_LS_KEY}.${props.userId}`) || '{}');
  } catch { threadSeen.value = {}; }
};
const markThreadSeen = (groupId: string, peerId: string) => {
  threadSeen.value = { ...threadSeen.value, [seenKey(groupId, peerId)]: new Date().toISOString() };
  try {
    window.localStorage.setItem(`${THREAD_SEEN_LS_KEY}.${props.userId}`, JSON.stringify(threadSeen.value));
  } catch { /* ignore */ }
};

// ── Alias resolution: message tags → requests → directory → fallback ──
const aliasFor = (groupId: string, peerId: string): string | null => {
  for (const msg of messagesByGroup.value[groupId] || []) {
    if (msg.fromPairwiseId === peerId && msg.fromAlias) return msg.fromAlias;
  }
  for (const s of sentByGroup.value[groupId] || []) {
    if (s.toPairwiseId === peerId && s.toAlias) return s.toAlias;
  }
  const req = requests.value.find((r) => r.groupId === groupId && r.fromPairwiseId === peerId && r.fromAlias);
  if (req) return req.fromAlias || null;
  const mentor = (directoryByGroup.value[groupId]?.mentors || []).find((x) => x.pairwiseId === peerId);
  if (mentor) return mentor.alias;
  const inviter = memberships.value.find((m) => m.groupId === groupId)?.invitedBy;
  if (inviter && inviter.pairwiseId === peerId) return inviter.alias || null;
  return null;
};

const selectedPeerAlias = computed(() =>
  selected.value?.peerId ? aliasFor(selected.value.groupId, selected.value.peerId) : null
);

// ── Rail conversations: one item per peer with any history/request,
//    PLUS the group's mentors (directories auto-load on mount) so a
//    fresh member immediately sees someone to talk to — no clicks. ──
interface Convo {
  peerId: string;
  alias: string | null;
  snippet: string;
  lastAt: string;
  unread: number;
  hasPendingRequest: boolean;
  mentor: boolean;
}
const conversationsFor = (groupId: string): Convo[] => {
  const peers = new Map<string, { lastAt: string; snippet: string; unread: number; hasPendingRequest: boolean; mentor: boolean }>();
  const bump = (peerId: string, at: string, snippet: string, unreadInc: number) => {
    const cur = peers.get(peerId) || { lastAt: '', snippet: '', unread: 0, hasPendingRequest: false, mentor: false };
    if (!cur.lastAt || at > cur.lastAt) { cur.lastAt = at; cur.snippet = snippet; }
    cur.unread += unreadInc;
    peers.set(peerId, cur);
  };
  for (const msg of messagesByGroup.value[groupId] || []) {
    const seen = threadSeen.value[seenKey(groupId, msg.fromPairwiseId)] || '';
    bump(msg.fromPairwiseId, msg.receivedAt, msg.text, msg.receivedAt > seen ? 1 : 0);
  }
  for (const s of sentByGroup.value[groupId] || []) {
    bump(s.toPairwiseId, s.sentAt, `You: ${s.text}`, 0);
  }
  for (const r of requests.value) {
    if (r.groupId !== groupId) continue;
    const cur = peers.get(r.fromPairwiseId) || { lastAt: '', snippet: '', unread: 0, hasPendingRequest: false, mentor: false };
    if (!cur.lastAt || r.receivedAt > cur.lastAt) cur.lastAt = r.receivedAt;
    if (r.status === 'pending') cur.hasPendingRequest = true;
    peers.set(r.fromPairwiseId, cur);
  }
  // Mentors appear even with no history — the "say hello" affordance a
  // brand-new member needs. Never removes anyone; only adds/flags.
  for (const mentor of directoryByGroup.value[groupId]?.mentors || []) {
    const cur = peers.get(mentor.pairwiseId);
    if (cur) {
      cur.mentor = true;
    } else {
      peers.set(mentor.pairwiseId, {
        lastAt: '', snippet: 'Mentor — say hello', unread: 0, hasPendingRequest: false, mentor: true
      });
    }
  }
  // The member who invited you is always a conversation — even before
  // any messages. This is the invitee's obvious first move.
  const inviter = memberships.value.find((m) => m.groupId === groupId)?.invitedBy;
  if (inviter && !peers.has(inviter.pairwiseId)) {
    peers.set(inviter.pairwiseId, {
      lastAt: '', snippet: 'Invited you — say hi', unread: 0, hasPendingRequest: false, mentor: false
    });
  }
  return Array.from(peers.entries())
    .map(([peerId, p]) => ({
      peerId,
      alias: aliasFor(groupId, peerId),
      snippet: p.snippet,
      lastAt: p.lastAt,
      unread: p.unread,
      hasPendingRequest: p.hasPendingRequest,
      mentor: p.mentor
    }))
    // Real conversations first (newest on top); history-less mentors last.
    .sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''));
};

// ── Thread for the selected peer: merge in + out, oldest first ──────
interface ThreadItem { id: string; direction: 'in' | 'out'; text: string; at: string }
const threadItems = computed<ThreadItem[]>(() => {
  if (!selected.value?.peerId) return [];
  const { groupId, peerId } = selected.value;
  const items: ThreadItem[] = [];
  for (const msg of messagesByGroup.value[groupId] || []) {
    if (msg.fromPairwiseId === peerId) items.push({ id: msg.id, direction: 'in', text: msg.text, at: msg.receivedAt });
  }
  for (const s of sentByGroup.value[groupId] || []) {
    if (s.toPairwiseId === peerId) items.push({ id: s.id, direction: 'out', text: s.text, at: s.sentAt });
  }
  return items.sort((a, b) => (a.at || '').localeCompare(b.at || ''));
});

/** Sentence of the policy that auto-decided the most recent request
 *  from the selected peer (empty when every decision was human). */
const policyDecidedForPeer = computed(() => {
  if (!selected.value?.peerId) return '';
  const { groupId, peerId } = selected.value;
  const r = requests.value.find(
    (x) => x.groupId === groupId && x.fromPairwiseId === peerId && x.decidedBySentence
  );
  return r?.decidedBySentence || '';
});

const pendingRequestFromPeer = computed(() => {
  if (!selected.value?.peerId) return null;
  const { groupId, peerId } = selected.value;
  return requests.value.find(
    (r) => r.groupId === groupId && r.fromPairwiseId === peerId && r.status === 'pending'
  ) || null;
});

// ── Selection actions ───────────────────────────────────────────────
const selectGroup = async (m: Membership) => {
  selected.value = { groupId: m.groupId, peerId: null };
  // Per-group invite widget state — don't leak group A's link into B.
  inviteEmailInput.value = '';
  lastInviteLink.value = '';
  lastInviteEmailSent.value = false;
  await loadDirectory(m.groupId);
};

const selectPeer = async (m: Membership, peerId: string) => {
  selected.value = { groupId: m.groupId, peerId };
  markThreadSeen(m.groupId, peerId);
  composerText.value = '';
  await nextTick();
  scrollThreadToBottom();
};

const scrollThreadToBottom = () => {
  const el = threadScrollEl.value;
  if (el) el.scrollTop = el.scrollHeight;
};

// ── Presentation helpers ────────────────────────────────────────────
const formatDate = (iso: string): string => {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString(); } catch { return iso; }
};

/** Signal-style compact time: today → clock; this year → "Jul 3"; else date. */
const shortTime = (iso: string): string => {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    if (d.getFullYear() === now.getFullYear()) {
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
    return d.toLocaleDateString();
  } catch { return ''; }
};

const bubbleTime = (iso: string): string => {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  } catch { return ''; }
};

/** Stable pastel avatar color from the peer id. */
const avatarColor = (peerId: string): string => {
  let h = 0;
  for (let i = 0; i < peerId.length; i++) h = (h * 31 + peerId.charCodeAt(i)) % 360;
  return `hsl(${h}, 45%, 55%)`;
};

// ── Data loading ────────────────────────────────────────────────────
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
      pendingJoins.value = data.pendingJoins || [];
    }
  } catch {
    /* non-fatal — empty list shown */
  } finally {
    loading.value = false;
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
      sentByGroup.value = { ...sentByGroup.value, [groupId]: data.sent || [] };
    }
  } catch {
    /* keep prior list */
  }
};

const loadAllMessages = async () => {
  await Promise.all(memberships.value.map((m) => loadMessages(m.groupId)));
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
        [groupId]: { stats: data.stats, postingPolicy: data.postingPolicy || '', mentors: data.mentors || [] }
      };
    }
  } catch {
    /* panel shows nothing */
  } finally {
    loadingDirectory.value = null;
  }
};

const loadRequests = async () => {
  try {
    const res = await fetch(`/api/user-groups/requests?userId=${encodeURIComponent(props.userId)}`, {
      credentials: 'include'
    });
    const data = await res.json();
    if (res.ok && data.success) requests.value = data.requests || [];
  } catch {
    /* keep prior list */
  }
};

/** Load directories for every membership so mentors appear in the rail
 *  without any clicks (a fresh member must SEE someone to talk to). */
const loadAllDirectories = async () => {
  await Promise.all(memberships.value.map((m) => loadDirectory(m.groupId)));
};

/** Pull relay mail for all memberships, then reload local state.
 *  Silent unless `notify` — the auto-poll uses the silent form. */
const pullMail = async (notify: boolean) => {
  const res = await fetch('/api/user-groups/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ userId: props.userId })
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
  await loadMemberships(); // a revoked membership would drop off here
  await Promise.all([loadAllMessages(), loadRequests()]);
  if (notify) {
    const bits = [];
    if (data.newMessages) bits.push(`${data.newMessages} message(s)`);
    if (data.newRequests) bits.push(`${data.newRequests} request(s)`);
    $q.notify({
      type: bits.length ? 'positive' : 'info',
      message: bits.length ? `New: ${bits.join(', ')}.` : 'Nothing new.'
    });
  }
};

const refreshAll = async () => {
  refreshingAll.value = true;
  try {
    await pullMail(true);
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to check messages' });
  } finally {
    refreshingAll.value = false;
  }
};

// Auto-poll: pull relay mail while the Groups tab is open so messages
// and requests appear without a manual refresh.
// TESTING CADENCE — 5 s is for convenient local/two-tab testing; raise
// substantially (e.g. 60 s+) before production scale-out.
const AUTO_PULL_MS = 5000;
let autoPullTimer: ReturnType<typeof setInterval> | null = null;
let autoPullBusy = false;
const autoPull = async () => {
  if (autoPullBusy || refreshingAll.value || !props.userId) return;
  if (memberships.value.length === 0 && pendingJoins.value.length === 0) return; // nothing to poll
  autoPullBusy = true;
  try {
    if (pendingJoins.value.length > 0) await pollJoins();
    if (memberships.value.length > 0) await pullMail(false);
  } catch { /* silent — next tick retries */ }
  finally { autoPullBusy = false; }
};

// ── Invite join flow ────────────────────────────────────────────────
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
        `A new invitation isn't needed. To join under a different name, open the group and use Leave, then open the new invitation.`;
      return;
    }
    pendingInvite.value = invite;
    // Prefill the group display name with the MAIA pseudonym (userId) so
    // joining is one click — no second naming ceremony. Editable: members
    // who prefer a different name in this group just type over it.
    if (!aliasInput.value.trim() && props.userId) {
      aliasInput.value = props.userId;
    }
    // Group metadata for the banner + invite validity. invite-info also
    // marks the invite "opened" at the registry (admin-visible progress).
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
    // Land the new member somewhere with an obvious next move: the
    // conversation with whoever invited them (member invite), else the
    // group's info pane where mentors/"Find peers" live.
    const joined = memberships.value.find((m) => m.groupId === data.membership?.groupId);
    if (joined?.invitedBy) {
      await loadDirectory(joined.groupId); // aliases for the rail
      await selectPeer(joined, joined.invitedBy.pairwiseId);
    } else if (joined) {
      await selectGroup(joined);
    }
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

// ── Leave group ─────────────────────────────────────────────────────
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
    if (selected.value?.groupId === m.groupId) selected.value = null;
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

// ── Send from the composer ──────────────────────────────────────────
const sendMessage = async () => {
  if (!selected.value?.peerId || !composerText.value.trim() || sending.value) return;
  const { groupId, peerId } = selected.value;
  sending.value = true;
  try {
    const res = await fetch('/api/user-groups/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        groupId,
        toPairwiseId: peerId,
        text: composerText.value.trim()
      })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    // Append the server-recorded sent message so the thread updates
    // immediately (no full reload needed).
    if (data.sent) {
      sentByGroup.value = {
        ...sentByGroup.value,
        [groupId]: [...(sentByGroup.value[groupId] || []), data.sent]
      };
    }
    composerText.value = '';
    await nextTick();
    scrollThreadToBottom();
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to send message' });
  } finally {
    sending.value = false;
  }
};

// ── Paste an invite/join link (PR-11: existing-MAIA join) ──────────
const showPasteLinkDialog = ref(false);
const pasteLinkInput = ref('');

/** Parse a pasted invite/join URL and hand it to the same localStorage +
 *  card machinery a clicked link uses. The registry defaults to the
 *  link's own origin, so links from OTHER deployments work — that's the
 *  whole point ("already have a MAIA? no new one needed"). */
const applyPastedLink = async () => {
  let url: URL;
  try {
    url = new URL(pasteLinkInput.value.trim());
  } catch {
    $q.notify({ type: 'negative', message: 'That does not look like a link — paste the full URL from the invitation.' });
    return;
  }
  const params = url.searchParams;
  const registry = params.get('registry') || url.origin;
  const groupId = params.get('groupId');
  const inviteToken = params.get('groupInvite');
  const joinToken = params.get('groupJoin');
  if (!groupId || (!inviteToken && !joinToken)) {
    $q.notify({ type: 'negative', message: 'No invitation found in that link. It should contain groupInvite or groupJoin.' });
    return;
  }
  try {
    if (inviteToken) {
      localStorage.setItem(INVITE_LS_KEY, JSON.stringify({
        token: inviteToken, groupId, registry, capturedAt: new Date().toISOString()
      }));
    } else {
      localStorage.setItem(JOIN_LINK_LS_KEY, JSON.stringify({
        token: joinToken, groupId, registry, capturedAt: new Date().toISOString()
      }));
    }
  } catch { /* storage unavailable */ }
  showPasteLinkDialog.value = false;
  pasteLinkInput.value = '';
  if (inviteToken) await loadPendingInvite();
  else await loadPendingJoinLink();
};

// ── Shareable join link (PR-9): request → admin approval ───────────
interface PendingJoin { groupId: string; groupName: string; alias: string; requestedAt: string }
const pendingJoins = ref<PendingJoin[]>([]);
const pendingJoinLink = ref<{ token: string; groupId: string; registry: string } | null>(null);
const pendingJoinLinkGroupName = ref('');
const joinLinkGroupPolicy = ref('');
const joinAliasInput = ref('');
const requestingJoin = ref(false);

const loadPendingJoinLink = async () => {
  try {
    const raw = localStorage.getItem(JOIN_LINK_LS_KEY);
    if (!raw) return;
    const link = JSON.parse(raw);
    if (!link?.token || !link?.groupId) {
      localStorage.removeItem(JOIN_LINK_LS_KEY);
      return;
    }
    if (memberships.value.some((m) => m.groupId === link.groupId) ||
        pendingJoins.value.some((p) => p.groupId === link.groupId)) {
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
          invalidInviteMessage.value =
            'This join link is no longer active — it may have been rotated or turned off. Ask the group for a fresh link or QR code.';
          return;
        }
        pendingJoinLinkGroupName.value = data.group?.name || '';
        joinLinkGroupPolicy.value = data.group?.postingPolicy || '';
      }
    } catch { /* generic card text */ }
  } catch {
    localStorage.removeItem(JOIN_LINK_LS_KEY);
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
    pendingJoinLink.value = null;
    await loadMemberships(); // pendingJoins now includes it
    $q.notify({
      type: 'positive',
      message: `Request sent. You'll be connected as soon as ${data.pending?.groupName || 'the group'}'s administrator approves.`
    });
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to send join request' });
  } finally {
    requestingJoin.value = false;
  }
};

const dismissJoinLink = () => {
  localStorage.removeItem(JOIN_LINK_LS_KEY);
  pendingJoinLink.value = null;
};

/** Poll pending join requests; an approval becomes a membership. */
const pollJoins = async () => {
  try {
    const res = await fetch('/api/user-groups/poll-joins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId: props.userId })
    });
    const data = await res.json();
    if (!res.ok || !data.success) return;
    if (data.activated?.length) {
      await loadMemberships();
      await Promise.all([loadAllMessages(), loadAllDirectories()]);
      for (const a of data.activated) {
        $q.notify({ type: 'positive', message: `You're in — welcome to ${a.groupName}!` });
      }
      const first = memberships.value.find((m) => m.groupId === data.activated[0].groupId);
      if (first) await selectGroup(first);
    }
    if (data.rejected?.length) {
      await loadMemberships();
      for (const rj of data.rejected) {
        $q.notify({ type: 'warning', message: `Your request to join ${rj.groupName} was not approved.` });
      }
    }
  } catch { /* next tick retries */ }
};

// ── Member-initiated invites (PR-8) ─────────────────────────────────
const inviteEmailInput = ref('');
const sendingInvite = ref(false);
const lastInviteLink = ref('');
const lastInviteEmailSent = ref(false);

const sendMemberInvite = async () => {
  const groupId = selected.value?.groupId;
  const email = inviteEmailInput.value.trim();
  if (!groupId || !email || sendingInvite.value) return;
  sendingInvite.value = true;
  try {
    const res = await fetch('/api/user-groups/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId: props.userId, groupId, email })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    lastInviteLink.value = data.invite?.inviteLink || '';
    lastInviteEmailSent.value = !!data.invite?.emailSent;
    inviteEmailInput.value = '';
    $q.notify({
      type: 'positive',
      message: lastInviteEmailSent.value
        ? `Invitation sent to ${email}.`
        : 'Invitation created — email is not configured, so share the link yourself.'
    });
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to send invitation' });
  } finally {
    sendingInvite.value = false;
  }
};

const copyInviteLink = async () => {
  try {
    await navigator.clipboard.writeText(lastInviteLink.value);
    $q.notify({ type: 'positive', message: 'Link copied.' });
  } catch {
    $q.notify({ type: 'warning', message: 'Copy failed — select and copy the link manually.' });
  }
};

// ── Outgoing data requests (PR-13) ─────────────────────────────────
const showRequestDialog = ref(false);
const reqScope = ref<Scope>('patient-summary');
const reqPurpose = ref<Purpose>('clinical');
const reqNote = ref('');
const sendingDataRequest = ref(false);

const openRequestDialog = () => {
  reqNote.value = '';
  showRequestDialog.value = true;
};

const sendDataRequest = async () => {
  if (!selected.value?.peerId || sendingDataRequest.value) return;
  sendingDataRequest.value = true;
  try {
    const res = await fetch('/api/user-groups/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        groupId: selected.value.groupId,
        toPairwiseId: selected.value.peerId,
        action: 'share-request',
        resource: reqScope.value,
        purpose: reqPurpose.value,
        payload: reqNote.value.trim() || null
      })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    showRequestDialog.value = false;
    $q.notify({ type: 'positive', message: 'Request sent — their sharing policies (or they themselves) will decide.' });
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to send request' });
  } finally {
    sendingDataRequest.value = false;
  }
};

// ── Requests (AS, Phase 1 — every request escalates to you) ─────────
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
    // Blocking someone removes the conversation with them.
    if (decision === 'block' && selected.value?.peerId === r.fromPairwiseId) {
      selected.value = { groupId: r.groupId, peerId: null };
    }
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to record decision' });
  } finally {
    deciding.value = null;
  }
};

onMounted(async () => {
  loadThreadSeen();
  await loadMemberships();
  await Promise.all([loadAllMessages(), loadRequests(), loadAllDirectories()]);
  await loadPendingInvite();
  await loadPendingJoinLink();
  autoPullTimer = setInterval(autoPull, AUTO_PULL_MS);
});

onUnmounted(() => {
  if (autoPullTimer) clearInterval(autoPullTimer);
});
</script>

<style scoped lang="scss">
// ── Signal-style two-pane layout ────────────────────────────────────
.groups-shell {
  display: flex;
  height: 100%;
  min-height: 420px;
  overflow: hidden;
}

// Left rail: conversation list
.groups-rail {
  width: 280px;
  flex: 0 0 280px;
  border-right: 1px solid #e0e0e0;
  overflow-y: auto;
  background: #fafafa;
}
.groups-rail__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 12px 8px;
  position: sticky;
  top: 0;
  background: #fafafa;
  z-index: 1;
}
.groups-policy-note {
  border-left: 3px solid #90caf9;
  padding-left: 8px;
}

.groups-invite-card {
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
.groups-rail__section {
  padding-bottom: 4px;
}
.groups-rail__group {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 8px 12px;
  text-align: left;
  font-size: 13px;
  font-weight: 600;
  color: #444;
  border-radius: 8px;

  &:hover { background: rgba(0, 0, 0, 0.05); }
  &.is-selected { background: rgba(25, 118, 210, 0.1); color: #1976d2; }
}
.groups-rail__group-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.groups-rail__convo {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px 8px 16px;
  cursor: pointer;
  border-radius: 8px;

  &:hover { background: rgba(0, 0, 0, 0.05); }
  &.is-selected { background: rgba(25, 118, 210, 0.12); }
}
.groups-rail__avatar {
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  border-radius: 50%;
  color: white;
  font-weight: 600;
  font-size: 15px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.groups-rail__convo-body {
  flex: 1;
  min-width: 0;
}
.groups-rail__convo-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13.5px;
  color: #222;
}
.groups-rail__convo-time {
  flex: 0 0 auto;
  font-size: 11px;
  color: #999;
  margin-left: 6px;
}
.groups-rail__convo-snippet {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: #777;
}

// Right pane
.groups-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: #fff;
}
.groups-main__empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.groups-main__header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid #e0e0e0;
  flex: 0 0 auto;
}
.groups-main__header-text {
  min-width: 0;
}
.groups-main__scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.groups-peer-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 4px;
  border-bottom: 1px solid #f0f0f0;
}

// Thread bubbles
.groups-thread {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.groups-bubble-row {
  display: flex;

  &.is-in { justify-content: flex-start; }
  &.is-out { justify-content: flex-end; }
}
.groups-bubble {
  max-width: 72%;
  padding: 8px 12px;
  border-radius: 16px;
  font-size: 14px;

  &--in {
    background: #f0f0f0;
    color: #222;
    border-bottom-left-radius: 4px;
  }
  &--out {
    background: #1976d2;
    color: #fff;
    border-bottom-right-radius: 4px;
  }
}
.groups-bubble__text {
  white-space: pre-wrap;
  word-break: break-word;
}
.groups-bubble__time {
  font-size: 10.5px;
  opacity: 0.65;
  margin-top: 2px;
  text-align: right;
}
.groups-request-card {
  align-self: center;
  max-width: 420px;
  margin-top: 12px;
  padding: 12px;
  border: 1px solid #bbdefb;
  border-radius: 12px;
  background: #e3f2fd;
}

// Composer
.groups-composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid #e0e0e0;
  flex: 0 0 auto;
}
.groups-composer__input {
  flex: 1;
}
</style>
