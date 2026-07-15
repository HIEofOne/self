<template>
  <div class="conv-rail">
    <!-- Private AI -->
    <div class="conv-rail__header conv-rail__header--private-ai">Private AI</div>
    <button
      v-for="e in privateAiEntries" :key="`pai:${e.label}`"
      type="button"
      class="conv-rail__item conv-rail__item--private-ai"
      :class="{ 'is-active': props.activeKind === 'ai' && activeProviderLabel === e.label }"
      @click="emit('select-ai', e.label)"
    >
      <q-icon name="smart_toy" size="16px" />
      <span class="conv-rail__label">{{ e.label }}</span>
    </button>
    <div v-if="!privateAiEntries.length" class="conv-rail__empty">Not set up yet</div>

    <!-- Public AI -->
    <div class="conv-rail__header conv-rail__header--public-ai">Public AI</div>
    <button
      v-for="e in publicAiEntries" :key="`cai:${e.label}`"
      type="button"
      class="conv-rail__item conv-rail__item--public-ai"
      :class="{ 'is-active': props.activeKind === 'ai' && activeProviderLabel === e.label }"
      @click="emit('select-ai', e.label)"
    >
      <q-icon name="public" size="16px" />
      <span class="conv-rail__label">{{ e.label }}</span>
    </button>
    <div v-if="!publicAiEntries.length" class="conv-rail__empty">None available</div>

    <!-- Stored Chats (including deep links) -->
    <div class="conv-rail__header conv-rail__header--stored">Stored Chats</div>
    <button
      v-for="c in storedChats" :key="`sc:${c._id}`"
      type="button"
      class="conv-rail__item conv-rail__item--stored"
      :class="{ 'is-active': props.activeKind === 'stored' && activeStoredId === c._id }"
      @click="emit('open-stored', c.raw)"
    >
      <q-icon :name="c.isDeepLink ? 'link' : 'history'" size="16px" />
      <span class="conv-rail__label">{{ c.title }}</span>
      <q-badge v-if="c.isDeepLink" color="brown-4" text-color="white" label="link" class="conv-rail__tag" />
    </button>
    <div v-if="!storedChats.length" class="conv-rail__empty">No saved chats yet</div>

    <!-- One section per group -->
    <template v-for="g in groups" :key="`g:${g.groupId}`">
      <div class="conv-rail__header conv-rail__header--group">
        <span class="conv-rail__label">{{ g.groupName }}</span>
        <q-btn flat dense round size="xs" icon="group_add" @click="emit('open-groups')">
          <q-tooltip>Find peers &amp; manage this group</q-tooltip>
        </q-btn>
      </div>
      <button
        v-for="p in g.peers" :key="`p:${g.groupId}:${p.peerId}`"
        type="button"
        class="conv-rail__item conv-rail__item--group"
        :class="{ 'is-active': props.activeKind === 'peer' && activePeer && activePeer.groupId === g.groupId && activePeer.peerId === p.peerId }"
        @click="emit('open-peer', { groupId: g.groupId, peerId: p.peerId, alias: p.alias, groupName: g.groupName })"
      >
        <div class="conv-rail__avatar" :style="{ background: avatarColor(p.peerId) }">{{ (p.alias || '?').slice(0,1).toUpperCase() }}</div>
        <span class="conv-rail__label">{{ p.alias || 'Group member' }}</span>
        <q-badge v-if="p.unread" rounded color="teal" :label="p.unread" class="conv-rail__tag" />
      </button>
      <div v-if="!g.peers.length" class="conv-rail__empty">No conversations — tap ＋ to find peers</div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';

const props = defineProps<{
  userId: string;
  aiEntries: Array<{ label: string; kind: 'private' | 'public' }>;
  activeKind: 'ai' | 'stored' | 'peer';
  activeProviderLabel: string;
  activePeer: { groupId: string; peerId: string } | null;
  activeStoredId: string | null;
}>();
const emit = defineEmits<{
  'select-ai': [label: string];
  'open-peer': [payload: { groupId: string; peerId: string; alias: string | null; groupName: string }];
  'open-stored': [chat: any];
  'open-groups': [];
}>();

const privateAiEntries = computed(() => props.aiEntries.filter((e) => e.kind === 'private'));
const publicAiEntries = computed(() => props.aiEntries.filter((e) => e.kind === 'public'));

const avatarColor = (peerId: string): string => {
  let h = 0;
  for (let i = 0; i < peerId.length; i++) h = (h * 31 + peerId.charCodeAt(i)) % 360;
  return `hsl(${h}, 45%, 55%)`;
};

// ── Stored chats ─────────────────────────────────────────────────────
interface StoredChat { _id: string; title: string; isDeepLink: boolean; raw: any }
const storedChats = ref<StoredChat[]>([]);
const loadStoredChats = async () => {
  try {
    const res = await fetch(`/api/user-chats?userId=${encodeURIComponent(props.userId)}`, { credentials: 'include' });
    const data = await res.json();
    if (!res.ok) return;
    storedChats.value = (data.chats || []).map((c: any) => {
      const first = (c.chatHistory || []).find((m: any) => m?.content);
      const preview = first ? String(first.content).replace(/\s+/g, ' ').slice(0, 32) : '';
      const date = (c.updatedAt || c.createdAt || '').slice(0, 10);
      return { _id: c._id, isDeepLink: !!c.shareId, raw: c, title: preview || `Chat ${date}` };
    }).sort((a: StoredChat, b: StoredChat) =>
      String(b.raw.updatedAt || b.raw.createdAt || '').localeCompare(String(a.raw.updatedAt || a.raw.createdAt || '')));
  } catch { /* keep prior */ }
};

// ── Group peer conversations ─────────────────────────────────────────
interface RailPeer { peerId: string; alias: string | null; lastAt: string; unread: number }
interface RailGroup { groupId: string; groupName: string; peers: RailPeer[] }
const groups = ref<RailGroup[]>([]);
const SEEN_KEY = () => `maia.groupThreadSeen.${props.userId}`;
const seen = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(SEEN_KEY()) || '{}'); } catch { return {}; } };

const loadGroups = async () => {
  try {
    const gRes = await fetch(`/api/user-groups?userId=${encodeURIComponent(props.userId)}`, { credentials: 'include' });
    const gData = await gRes.json();
    if (!gRes.ok || !gData.success) return;
    const seenMap = seen();
    const out: RailGroup[] = [];
    for (const m of (gData.memberships || [])) {
      const mRes = await fetch(`/api/user-groups/messages?userId=${encodeURIComponent(props.userId)}&groupId=${encodeURIComponent(m.groupId)}`, { credentials: 'include' });
      const mData = await mRes.json();
      const peers = new Map<string, RailPeer>();
      const bump = (pid: string, alias: string | null, at: string, unread: number) => {
        const cur = peers.get(pid) || { peerId: pid, alias: null, lastAt: '', unread: 0 };
        if (alias) cur.alias = alias;
        if (!cur.lastAt || at > cur.lastAt) cur.lastAt = at;
        cur.unread += unread;
        peers.set(pid, cur);
      };
      for (const msg of (mData.messages || [])) {
        const s = seenMap[`${m.groupId}|${msg.fromPairwiseId}`] || '';
        bump(msg.fromPairwiseId, msg.fromAlias || null, msg.receivedAt, msg.receivedAt > s ? 1 : 0);
      }
      for (const sent of (mData.sent || [])) bump(sent.toPairwiseId, sent.toAlias || null, sent.sentAt, 0);
      // The inviter is always a conversation, even before any messages.
      if (m.invitedBy?.pairwiseId && !peers.has(m.invitedBy.pairwiseId)) {
        bump(m.invitedBy.pairwiseId, m.invitedBy.alias || null, '', 0);
      }
      out.push({
        groupId: m.groupId,
        groupName: m.groupName,
        peers: Array.from(peers.values()).sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''))
      });
    }
    groups.value = out;
  } catch { /* keep prior */ }
};

const refresh = () => { void loadStoredChats(); void loadGroups(); };
defineExpose({ refresh });

let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => { refresh(); timer = setInterval(refresh, 15000); });
onUnmounted(() => { if (timer) clearInterval(timer); });
</script>

<style scoped lang="scss">
.conv-rail {
  width: 210px;
  flex: 0 0 210px;
  border-right: 1px solid #e0e0e0;
  overflow-y: auto;
  background: #fff;
  padding-bottom: 12px;
}
.conv-rail__header {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  padding: 10px 12px 4px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  position: sticky;
  top: 0;
  background: #fff;
  z-index: 1;

  // Category accents — MUST match the message-chip colors in ChatInterface.
  &--private-ai { color: #5e35b1; }   // deep-purple
  &--public-ai  { color: #546e7a; }   // blue-grey
  &--stored     { color: #6d4c41; }   // brown
  &--group      { color: #00796b; }   // teal
}
.conv-rail__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: none;
  border-left: 3px solid transparent;
  background: transparent;
  cursor: pointer;
  padding: 7px 12px 7px 10px;
  text-align: left;
  font-size: 13px;
  color: #333;

  &:hover { background: rgba(0, 0, 0, 0.04); }
  &.is-active { font-weight: 600; }

  // Shading per category (tint + active left-border), matching the chips.
  &--private-ai { &.is-active { background: #ede7f6; border-left-color: #5e35b1; } }
  &--public-ai  { &.is-active { background: #eceff1; border-left-color: #546e7a; } }
  &--stored     { &.is-active { background: #efebe9; border-left-color: #6d4c41; } }
  &--group      { &.is-active { background: #e0f2f1; border-left-color: #00796b; } }
}
.conv-rail__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conv-rail__tag { flex: 0 0 auto; }
.conv-rail__avatar {
  width: 24px; height: 24px; flex: 0 0 24px;
  border-radius: 50%;
  color: #fff; font-weight: 600; font-size: 12px;
  display: flex; align-items: center; justify-content: center;
}
.conv-rail__empty {
  font-size: 11.5px;
  color: #999;
  padding: 2px 12px 6px;
}
</style>
