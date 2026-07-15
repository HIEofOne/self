<template>
  <div class="peer-thread">
    <!-- Header: who you're talking to (identity chips, Refinement 6) -->
    <div class="peer-thread__header">
      <q-btn flat dense round icon="arrow_back" @click="emit('close')">
        <q-tooltip>Back to your AI chat</q-tooltip>
      </q-btn>
      <div class="peer-thread__avatar" :style="{ background: avatarColor(peerId) }">
        {{ (peerAlias || '?').slice(0, 1).toUpperCase() }}
      </div>
      <div style="min-width: 0">
        <div class="text-subtitle2 row items-center q-gutter-xs no-wrap">
          <span>{{ peerAlias || 'Group member' }}</span>
          <q-badge color="teal" outline :label="`member of ${groupName}`" />
        </div>
        <div class="text-caption text-grey-7">end-to-end encrypted · your AI is not part of this conversation</div>
      </div>
      <q-space />
      <q-btn flat dense round size="sm" icon="rule" color="primary" @click="openRequestDialog">
        <q-tooltip>Request records from {{ peerAlias || 'this member' }} — their sharing policies (or they themselves) decide</q-tooltip>
      </q-btn>
    </div>

    <!-- Thread -->
    <div ref="scrollEl" class="peer-thread__scroll">
      <div v-if="!threadItems.length && !pendingRequest" class="text-caption text-grey-6 text-center q-mt-lg">
        No messages yet. Say hello — your message is end-to-end encrypted to
        {{ peerAlias || 'this member' }}.
      </div>

      <div v-for="item in threadItems" :key="item.id" class="peer-thread__row" :class="item.direction === 'out' ? 'is-out' : 'is-in'">
        <div class="peer-thread__bubble" :class="item.direction === 'out' ? 'peer-thread__bubble--out' : 'peer-thread__bubble--in'">
          <div class="peer-thread__who">{{ item.direction === 'out' ? 'You' : (peerAlias || 'Member') }}</div>
          <div style="white-space: pre-wrap; word-break: break-word">{{ item.text }}</div>
          <div class="peer-thread__time">{{ bubbleTime(item.at) }}</div>
        </div>
      </div>

      <!-- Policy-decided note: the audit trail teaches the policy system -->
      <div v-if="policyDecidedSentence" class="text-caption text-grey-7 text-center q-my-sm">
        <q-icon name="policy" size="14px" color="green" />
        Auto-accepted by your policy: “{{ policyDecidedSentence }}”
      </div>

      <!-- Private AI consultations (Refinement 6: consult any AI even in a
           group thread). These are PRIVATE to you — the AI is never in the
           E2E channel. Share the answer with the peer explicitly, filtered. -->
      <div v-for="c in privateConsults" :key="c.id" class="peer-thread__consult">
        <div class="peer-thread__row is-out">
          <div class="peer-thread__bubble peer-thread__bubble--you-private">
            <div class="peer-thread__who">You → {{ c.aiLabel }} (private)</div>
            <div style="white-space: pre-wrap; word-break: break-word">{{ c.question }}</div>
          </div>
        </div>
        <div class="peer-thread__row is-in">
          <div class="peer-thread__bubble peer-thread__bubble--ai-private">
            <div class="peer-thread__who"><q-icon name="smart_toy" size="12px" /> {{ c.aiLabel }} — only you can see this</div>
            <div v-if="c.pending" class="text-grey-7"><q-spinner size="14px" /> thinking…</div>
            <div v-else style="white-space: pre-wrap; word-break: break-word">{{ c.answer }}</div>
            <div v-if="!c.pending && c.answer" class="q-mt-xs">
              <q-btn dense flat size="sm" color="primary" label="Share to peer (filtered)" :loading="c.sharing" @click="shareConsult(c)" />
            </div>
          </div>
        </div>
      </div>

      <!-- Pending request from this peer -->
      <div v-if="pendingRequest" class="peer-thread__request">
        <div class="text-body2">
          <strong>{{ peerAlias || 'A group member' }}</strong> sent a request
          <span class="text-grey-7">({{ pendingRequest.action }}<template v-if="pendingRequest.resource && pendingRequest.resource !== 'inbox'"> · {{ pendingRequest.resource }}</template>)</span>
        </div>
        <div v-if="pendingRequest.payload" class="text-caption text-grey-8 q-mt-xs" style="white-space: pre-wrap; word-break: break-word">
          {{ typeof pendingRequest.payload === 'string' ? pendingRequest.payload : JSON.stringify(pendingRequest.payload) }}
        </div>
        <div class="q-mt-sm q-gutter-sm">
          <q-btn dense unelevated size="sm" color="primary" label="Accept" :loading="deciding" @click="decide('accept')" />
          <q-btn dense flat size="sm" color="grey-8" label="Decline" :loading="deciding" @click="decide('decline')" />
          <q-btn dense flat size="sm" color="negative" label="Block" :loading="deciding" @click="decide('block')" />
        </div>
      </div>
    </div>

    <!-- Composer with the same "To:" selector as the AI chat: send to the
         group member (teal, E2E) OR consult any AI (purple/blue, private).
         Group threads are no longer treated differently from AI chats. -->
    <div class="peer-thread__composer">
      <q-chip
        clickable dense
        :color="target === 'peer' ? 'teal' : (isPrivateLabel(target) ? 'deep-purple' : 'blue-grey')"
        text-color="white"
        :icon="target === 'peer' ? 'person' : 'smart_toy'"
        :label="`To: ${target === 'peer' ? (peerAlias || 'member') : target}`"
        style="flex: 0 0 auto; max-width: 240px"
      >
        <q-tooltip>{{ target === 'peer' ? 'Sent to the group member, end-to-end encrypted' : 'Private consultation — the AI answer is shown only to you' }}</q-tooltip>
        <q-menu auto-close>
          <q-list style="min-width: 220px">
            <q-item clickable :active="target === 'peer'" @click="target = 'peer'">
              <q-item-section avatar style="min-width: 32px"><q-icon name="person" color="teal" size="18px" /></q-item-section>
              <q-item-section>{{ peerAlias || 'Group member' }} <span class="text-caption text-grey-6">· message</span></q-item-section>
            </q-item>
            <q-separator />
            <q-item-label header class="q-py-xs">Consult an AI (private)</q-item-label>
            <q-item v-for="e in aiEntries" :key="e.label" clickable :active="target === e.label" @click="target = e.label">
              <q-item-section avatar style="min-width: 32px">
                <q-icon :name="e.kind === 'private' ? 'smart_toy' : 'public'" :color="e.kind === 'private' ? 'deep-purple' : 'blue-grey'" size="18px" />
              </q-item-section>
              <q-item-section>{{ e.label }}</q-item-section>
            </q-item>
          </q-list>
        </q-menu>
      </q-chip>
      <q-input
        v-model="composerText"
        dense outlined autogrow
        :placeholder="target === 'peer' ? 'Message' : `Ask ${target}…`"
        :disable="sending"
        class="col"
        @keydown.enter.exact.prevent="submitComposer"
      />
      <q-btn round unelevated :color="target === 'peer' ? 'primary' : 'deep-purple'" icon="send" size="sm" :loading="sending" :disable="!composerText.trim()" @click="submitComposer" />
    </div>

    <!-- Outgoing data request -->
    <q-dialog v-model="showRequestDialog">
      <q-card style="min-width: 460px; max-width: 600px">
        <q-card-section>
          <div class="text-h6">Request records from {{ peerAlias || 'this member' }}</div>
          <div class="text-caption text-grey-7">
            Delivered to their MAIA's authorization server — their sharing
            policies decide automatically, or they're asked.
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
          <q-btn flat label="Cancel" v-close-popup :disable="sendingRequest" />
          <q-btn unelevated color="primary" label="Send request" :loading="sendingRequest" @click="sendDataRequest" />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue';
import { useQuasar } from 'quasar';
import { SCOPE_OPTIONS, PURPOSE_OPTIONS, type Scope, type Purpose } from '../utils/policyCards';

const $q = useQuasar();
const props = defineProps<{
  userId: string;
  groupId: string;
  peerId: string;
  peerAlias: string | null;
  groupName: string;
  aiEntries: Array<{ label: string; kind: 'private' | 'public' }>;
  consult: (label: string, question: string) => Promise<string>;
}>();
const emit = defineEmits<{ close: []; 'thread-activity': [] }>();

// Composer target: the peer (E2E) or an AI label (private consultation).
const target = ref<string>('peer');
const isPrivateLabel = (label: string) => props.aiEntries.some((e) => e.label === label && e.kind === 'private');

// Private AI consultations shown inline (never sent to the peer or relay).
interface Consult { id: string; aiLabel: string; question: string; answer: string; pending: boolean; sharing: boolean }
const privateConsults = ref<Consult[]>([]);

interface InMsg { id: string; fromPairwiseId: string; text: string; receivedAt: string }
interface OutMsg { id: string; toPairwiseId: string; text: string; sentAt: string }
interface AsRequest {
  id: string; groupId: string; fromPairwiseId: string; action: string; resource: string;
  payload: unknown; receivedAt: string; status: string; decidedBySentence?: string | null;
}

const inbox = ref<InMsg[]>([]);
const sent = ref<OutMsg[]>([]);
const requests = ref<AsRequest[]>([]);
const composerText = ref('');
const sending = ref(false);
const deciding = ref(false);
const scrollEl = ref<HTMLElement | null>(null);

const threadItems = computed(() => {
  const items: Array<{ id: string; direction: 'in' | 'out'; text: string; at: string }> = [];
  for (const m of inbox.value) if (m.fromPairwiseId === props.peerId) items.push({ id: m.id, direction: 'in', text: m.text, at: m.receivedAt });
  for (const s of sent.value) if (s.toPairwiseId === props.peerId) items.push({ id: s.id, direction: 'out', text: s.text, at: s.sentAt });
  return items.sort((a, b) => (a.at || '').localeCompare(b.at || ''));
});

const pendingRequest = computed(() =>
  requests.value.find((r) => r.groupId === props.groupId && r.fromPairwiseId === props.peerId && r.status === 'pending') || null
);
const policyDecidedSentence = computed(() =>
  requests.value.find((r) => r.groupId === props.groupId && r.fromPairwiseId === props.peerId && r.decidedBySentence)?.decidedBySentence || ''
);

const bubbleTime = (iso: string): string => {
  try {
    const d = new Date(iso);
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  } catch { return ''; }
};
const avatarColor = (peerId: string): string => {
  let h = 0;
  for (let i = 0; i < peerId.length; i++) h = (h * 31 + peerId.charCodeAt(i)) % 360;
  return `hsl(${h}, 45%, 55%)`;
};

const scrollToBottom = async () => {
  await nextTick();
  if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight;
};

// ── Data: load + silent 5s pull (testing cadence, matches GroupsPanel) ──
const loadThread = async () => {
  try {
    const [mRes, rRes] = await Promise.all([
      fetch(`/api/user-groups/messages?userId=${encodeURIComponent(props.userId)}&groupId=${encodeURIComponent(props.groupId)}`, { credentials: 'include' }),
      fetch(`/api/user-groups/requests?userId=${encodeURIComponent(props.userId)}`, { credentials: 'include' })
    ]);
    const mData = await mRes.json();
    if (mRes.ok && mData.success) {
      const hadNew = (mData.messages || []).length !== inbox.value.length;
      inbox.value = mData.messages || [];
      sent.value = mData.sent || [];
      if (hadNew) { emit('thread-activity'); void scrollToBottom(); }
    }
    const rData = await rRes.json();
    if (rRes.ok && rData.success) requests.value = rData.requests || [];
  } catch { /* next tick retries */ }
};

let pullTimer: ReturnType<typeof setInterval> | null = null;
let pullBusy = false;
const pull = async () => {
  if (pullBusy) return;
  pullBusy = true;
  try {
    await fetch('/api/user-groups/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId: props.userId })
    });
    await loadThread();
  } catch { /* silent */ } finally { pullBusy = false; }
};

// Composer submit: route to the peer (E2E) or an AI (private consult).
const submitComposer = () => {
  if (target.value === 'peer') void sendMessage();
  else void consultAi();
};

const sendMessage = async () => {
  if (!composerText.value.trim() || sending.value) return;
  sending.value = true;
  try {
    const res = await fetch('/api/user-groups/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId: props.userId, groupId: props.groupId, toPairwiseId: props.peerId, text: composerText.value.trim() })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.sent) sent.value = [...sent.value, data.sent];
    composerText.value = '';
    void scrollToBottom();
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to send message' });
  } finally { sending.value = false; }
};

// Consult the selected AI privately (the answer stays with you until you
// choose to share it, privacy-filtered, with the peer).
const consultAi = async () => {
  const question = composerText.value.trim();
  const aiLabel = target.value;
  if (!question || sending.value) return;
  const entry: Consult = { id: `c_${Date.now()}`, aiLabel, question, answer: '', pending: true, sharing: false };
  privateConsults.value = [...privateConsults.value, entry];
  composerText.value = '';
  sending.value = true;
  await nextTick(); void scrollToBottom();
  try {
    entry.answer = await props.consult(aiLabel, question);
  } catch (err) {
    entry.answer = `(${err instanceof Error ? err.message : 'consultation failed'})`;
  } finally {
    entry.pending = false;
    sending.value = false;
    await nextTick(); void scrollToBottom();
  }
};

// Share a private AI answer with the peer, mandatorily privacy-filtered.
const shareConsult = async (c: Consult) => {
  if (c.sharing || !c.answer) return;
  c.sharing = true;
  try {
    const fRes = await fetch('/api/user-groups/filter-text', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ userId: props.userId, text: c.answer })
    });
    const fData = await fRes.json();
    const text = (fRes.ok && fData.success) ? fData.filtered : c.answer;
    const res = await fetch('/api/user-groups/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ userId: props.userId, groupId: props.groupId, toPairwiseId: props.peerId, text })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.sent) sent.value = [...sent.value, data.sent];
    $q.notify({ type: 'positive', message: 'Shared with the peer (privacy-filtered).' });
    void scrollToBottom();
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to share' });
  } finally { c.sharing = false; }
};

const decide = async (decision: 'accept' | 'decline' | 'block') => {
  const r = pendingRequest.value;
  if (!r || deciding.value) return;
  deciding.value = true;
  try {
    const res = await fetch(`/api/user-groups/requests/${encodeURIComponent(r.id)}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId: props.userId, decision })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    await loadThread();
    $q.notify({ type: 'positive', message: `Request ${data.status}.` });
    if (decision === 'block') emit('close');
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to record decision' });
  } finally { deciding.value = false; }
};

// ── Outgoing data request ────────────────────────────────────────────
const showRequestDialog = ref(false);
const reqScope = ref<Scope>('patient-summary');
const reqPurpose = ref<Purpose>('clinical');
const reqNote = ref('');
const sendingRequest = ref(false);
const openRequestDialog = () => { reqNote.value = ''; showRequestDialog.value = true; };
const sendDataRequest = async () => {
  if (sendingRequest.value) return;
  sendingRequest.value = true;
  try {
    const res = await fetch('/api/user-groups/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId, groupId: props.groupId, toPairwiseId: props.peerId,
        action: 'share-request', resource: reqScope.value, purpose: reqPurpose.value,
        payload: reqNote.value.trim() || null
      })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    showRequestDialog.value = false;
    $q.notify({ type: 'positive', message: 'Request sent — their sharing policies (or they themselves) will decide.' });
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to send request' });
  } finally { sendingRequest.value = false; }
};

watch(() => [props.groupId, props.peerId], () => { inbox.value = []; sent.value = []; void loadThread().then(scrollToBottom); });

onMounted(async () => {
  await loadThread();
  void scrollToBottom();
  pullTimer = setInterval(pull, 5000); // TESTING CADENCE — raise before production
});
onUnmounted(() => { if (pullTimer) clearInterval(pullTimer); });
</script>

<style scoped lang="scss">
.peer-thread {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 320px;
}
.peer-thread__header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid #e0e0e0;
  flex: 0 0 auto;
}
.peer-thread__avatar {
  width: 34px; height: 34px; flex: 0 0 34px;
  border-radius: 50%;
  color: #fff; font-weight: 600; font-size: 15px;
  display: flex; align-items: center; justify-content: center;
}
.peer-thread__scroll {
  flex: 1; min-height: 0;
  overflow-y: auto;
  padding: 16px;
  display: flex; flex-direction: column; gap: 6px;
}
.peer-thread__row {
  display: flex;
  &.is-in { justify-content: flex-start; }
  &.is-out { justify-content: flex-end; }
}
.peer-thread__bubble {
  max-width: 72%;
  padding: 8px 12px;
  border-radius: 16px;
  font-size: 14px;
  &--in { background: #f0f0f0; color: #222; border-bottom-left-radius: 4px; }
  &--out { background: #1976d2; color: #fff; border-bottom-right-radius: 4px; }
  // Private AI consultation: dashed, muted — visually "only you see this".
  &--you-private { background: #ede7f6; color: #4527a0; border: 1px dashed #b39ddb; }
  &--ai-private { background: #f5f0ff; color: #311b92; border: 1px dashed #b39ddb; }
}
.peer-thread__who { font-size: 10.5px; opacity: 0.7; margin-bottom: 2px; font-weight: 600; }
.peer-thread__time { font-size: 10.5px; opacity: 0.65; margin-top: 2px; text-align: right; }
.peer-thread__request {
  align-self: center;
  max-width: 440px;
  margin-top: 12px;
  padding: 12px;
  border: 1px solid #bbdefb;
  border-radius: 12px;
  background: #e3f2fd;
}
.peer-thread__composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid #e0e0e0;
  flex: 0 0 auto;
}
</style>
