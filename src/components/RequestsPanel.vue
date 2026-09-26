<template>
  <div class="rp">
    <!-- The personal request link (group_requests.md §10.2) -->
    <div class="rp__link">
      <div class="text-subtitle2">Your request link</div>
      <div class="text-caption text-grey-7 q-mb-sm">
        Give this link to a clinician, a family member or anyone who needs
        information from you. They ask on that page, and your sharing rules
        answer, or ask you here first.
      </div>
      <div v-if="link" class="rp__link-row">
        <code class="rp__url">{{ link.pageUrl }}</code>
        <q-btn dense flat no-caps color="primary" :icon="copied ? 'check' : 'content_copy'" :label="copied ? 'Copied' : 'Copy'" @click="copyLink" />
        <q-btn dense flat no-caps color="primary" icon="qr_code_2" :label="qr ? 'Hide QR code' : 'QR code'" @click="toggleQr" />
        <q-btn dense flat no-caps color="grey-8" icon="autorenew" label="Change link" @click="confirmRotate = true" />
      </div>
      <div v-else-if="linkError" class="text-negative text-caption">{{ linkError }}</div>
      <q-spinner v-else size="18px" color="primary" />
      <div v-if="qr" class="rp__qr">
        <img :src="qr" alt="QR code for your request link" width="200" height="200" />
        <div class="text-caption text-grey-7">Someone can scan this with their phone's camera to open your request page.</div>
      </div>
    </div>

    <q-dialog v-model="confirmRotate">
      <q-card style="max-width: 420px">
        <q-card-section>
          <div class="text-h6">Change your request link?</div>
          <p class="q-mt-sm q-mb-none">
            The old link stops working, and every request made through it
            stops too, including answers already shared. Use this if the link
            reached people you don't want asking.
          </p>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat no-caps label="Keep this link" v-close-popup />
          <q-btn unelevated no-caps color="negative" label="Change link" :loading="rotating" @click="rotate" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Requests, newest first; the ones that need the patient on top (§8.4) -->
    <div class="rp__list">
      <div class="row items-center q-mb-sm">
        <div class="text-subtitle2">Requests</div>
        <q-space />
        <q-btn v-if="groups.length" dense flat no-caps size="sm" color="primary" icon="forum" label="Ask your group" class="q-mr-xs" @click="openAsk" />
        <q-btn dense flat round size="sm" icon="refresh" :loading="loading" @click="load"><q-tooltip>Refresh</q-tooltip></q-btn>
      </div>
      <div v-if="requests.length" class="rp__filters">
        <button v-for="f in FILTERS" :key="f.id" type="button" class="rp__filter" :aria-pressed="filter === f.id" @click="filter = f.id">
          {{ f.label }}<template v-if="f.id === 'pending' && pendingCount"> ({{ pendingCount }})</template>
        </button>
      </div>
      <div class="rp__log text-caption">
        <q-icon :name="logState.icon" size="15px" :color="logState.color" />
        <span>{{ logState.text }}</span>
        <q-btn v-if="logResult === 'no-permission'" dense flat no-caps size="sm" color="primary" label="Allow" @click="allowFolder" />
      </div>
      <div v-if="!loading && !requests.length" class="text-caption text-grey-7">
        No requests yet. When someone uses your link, the request appears here.
      </div>
      <div v-else-if="requests.length && !ordered.length" class="text-caption text-grey-7">Nothing here.</div>

      <div v-for="r in ordered" :key="r.id" class="rp__item" :class="{ 'rp__item--pending': r.status === 'pending' }">
        <div class="row items-center no-wrap">
          <q-badge :color="STATUS[r.status]?.color || 'grey'" :label="STATUS[r.status]?.label || r.status" />
          <span class="text-caption text-grey-7 q-ml-sm">{{ when(r.receivedAt) }} · {{ r.groupName || 'Direct request' }}</span>
        </div>
        <div class="q-mt-xs">
          <strong>{{ r.requester?.name || r.fromAlias || 'Someone' }}</strong>
          <span v-if="r.fromOutsider === false" class="text-caption text-grey-7"> (a member of {{ r.groupName }})</span>
          <span v-else class="text-caption text-grey-7"> (name not verified)</span>
          asks for <strong>{{ scopeLabel(r.resource) }}</strong> for <strong>{{ purposeLabel(r.purpose) }}</strong>.
        </div>
        <div v-if="r.fromOutsider !== false" class="text-caption q-mt-xs">
          <template v-if="r.requester?.email && r.requester?.emailVerified">
            <q-icon name="verified" color="green-7" size="14px" /> Email verified: {{ r.requester.email }}
          </template>
          <template v-else><q-icon name="help_outline" color="grey-6" size="14px" /> Email not verified</template>
          <template v-if="r.recognized"> · recognized from an earlier verified request</template>
        </div>
        <div v-if="r.gnapPayment" class="text-caption q-mt-xs">
          <q-icon name="toll" color="amber-9" size="14px" /> Came with {{ PAYMENT_WORDS[r.gnapPayment.type] || r.gnapPayment.type }} ({{ r.gnapPayment.amount }} credits)
        </div>
        <div v-if="r.payload && typeof r.payload === 'string'" class="rp__message">{{ r.payload }}</div>
        <div v-if="r.decidedBySentence && r.autonomous" class="text-caption text-grey-7 q-mt-xs">
          Decided by your rule: “{{ r.decidedBySentence }}”
        </div>

        <div v-if="r.status === 'pending'" class="q-mt-sm q-gutter-sm">
          <q-btn dense unelevated no-caps size="sm" color="primary" label="Share" :loading="busyId === r.id" @click="decide(r, 'accept')">
            <q-tooltip>Share your privacy-filtered {{ scopeLabel(r.resource) }}. Names are replaced before anything leaves.</q-tooltip>
          </q-btn>
          <q-btn dense flat no-caps size="sm" color="grey-8" label="Decline" :disable="busyId === r.id" @click="decide(r, 'decline')">
            <q-tooltip>They are told the request was declined.</q-tooltip>
          </q-btn>
          <q-btn dense flat no-caps size="sm" color="negative" label="Ignore" :disable="busyId === r.id" @click="decide(r, 'block')">
            <q-tooltip>They are never told. To them it looks like no answer yet.</q-tooltip>
          </q-btn>
        </div>
        <div v-else-if="r.status === 'accepted' && r.route" class="q-mt-sm">
          <q-btn dense flat no-caps size="sm" color="negative" icon="stop_circle" label="Stop sharing" :loading="busyId === r.id" @click="stop(r)">
            <q-tooltip>They can't read it again from now on.</q-tooltip>
          </q-btn>
        </div>
        <div v-if="r.route === 'gnap-direct' && r.requester?.emailVerified && !r.forgottenAt && r.status !== 'pending'" class="q-mt-xs">
          <q-btn dense flat no-caps size="sm" color="grey-8" icon="person_off" label="Forget this requester" :disable="busyId === r.id" @click="forget(r)">
            <q-tooltip>Their next request will need a new email check.</q-tooltip>
          </q-btn>
        </div>
        <div v-if="r.route" class="q-mt-xs">
          <q-btn dense flat no-caps size="sm" color="primary" icon="rule" label="Always handle requests like this…" @click="openRule(r)">
            <q-tooltip>Make a sharing rule from this request, so the next one like it is handled without asking you.</q-tooltip>
          </q-btn>
        </div>
      </div>
      <div v-if="error" class="text-negative text-caption q-mt-sm">{{ error }}</div>
    </div>

    <!-- "Always handle requests like this…": a rule born from a decision (§8.4) -->
    <q-dialog v-model="ruleOpen">
      <q-card style="min-width: 360px; max-width: 540px">
        <q-card-section>
          <div class="text-h6">Always handle requests like this</div>
          <div class="text-caption text-grey-7">A rule made from this request. It applies from the next request, and you can change or turn it off in Sharing Policies.</div>
        </q-card-section>
        <q-card-section class="q-pt-none">
          <q-option-group v-model="ruleOutcome" :options="RULE_OUTCOMES" dense />
          <div class="rp__sentence">{{ ruleSentence }}</div>
          <div v-if="asState !== 'active'" class="text-caption text-orange-9 q-mt-sm">
            Sharing isn't on yet, so rules don't act until you turn it on in Sharing Policies.
          </div>
          <div v-if="ruleError" class="text-negative text-caption q-mt-sm">{{ ruleError }}</div>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat no-caps label="Cancel" v-close-popup />
          <q-btn unelevated no-caps color="primary" label="Add this rule" :loading="ruleSaving" @click="saveRule" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Requests this member sent to their groups (§10.9, §8.4 "Sent") -->
    <div v-if="sent.length" class="rp__list">
      <div class="text-subtitle2 q-mb-sm">Sent</div>
      <div v-for="s in sent" :key="s.id" class="rp__item">
        <div class="row items-center no-wrap">
          <q-badge :color="s.state === 'sent' ? 'primary' : 'grey-6'" :label="s.state === 'sent' ? 'Open' : s.state === 'withdrawn' ? 'Withdrawn' : 'Closed'" />
          <span class="text-caption text-grey-7 q-ml-sm">{{ when(s.createdAt) }} · {{ s.groupName }}</span>
        </div>
        <div class="q-mt-xs">
          You asked <strong>{{ s.to ? (s.toAlias || 'one member') : 'everyone' }}</strong> in {{ s.groupName }}
          for <strong>{{ scopeLabel(s.what) }}</strong> for <strong>{{ purposeLabel(s.why) }}</strong>.
        </div>
        <div class="text-caption text-grey-7 q-mt-xs">
          Reached {{ s.counts.delivered }} · {{ s.counts.shared }} shared · {{ s.counts.declined }} declined
        </div>
        <div v-if="s.message" class="rp__message">{{ s.message }}</div>
        <div v-for="(a, i) in s.answers" :key="a.id" class="q-mt-sm">
          <div class="row items-center">
            <span class="text-caption">Answer {{ i + 1 }}</span>
            <q-btn v-if="a.status === 'ready' && !answerTexts[a.id]?.text" dense flat no-caps size="sm" color="primary" label="Read"
                   :loading="answerTexts[a.id]?.loading" @click="readAnswer(s, a.id)" class="q-ml-sm" />
            <span v-if="a.status !== 'ready'" class="text-caption text-grey-6 q-ml-sm">couldn't be opened</span>
          </div>
          <div v-if="answerTexts[a.id]?.error" class="text-caption text-grey-7">{{ answerTexts[a.id].error }}</div>
          <div v-if="answerTexts[a.id]?.text !== undefined" class="rp__answer" v-html="answerToHtml(answerTexts[a.id].text || '')"></div>
        </div>
        <div v-if="s.state === 'sent'" class="q-mt-sm q-gutter-sm">
          <q-btn dense flat no-caps size="sm" color="primary" icon="refresh" label="Check for answers" :loading="busyId === s.id" @click="refreshSent(s)" />
          <q-btn dense flat no-caps size="sm" color="grey-8" label="Withdraw" :disable="busyId === s.id" @click="withdrawSent(s)" />
        </div>
      </div>
      <div class="text-caption text-grey-7">
        Answers stay at each member's MAIA: Read fetches one from there, and it can be read again for an hour.
      </div>
    </div>

    <q-dialog v-model="askOpen">
      <q-card style="min-width: 360px; max-width: 520px">
        <q-card-section>
          <div class="text-h6">Ask your group</div>
          <div class="text-caption text-grey-7">
            Your MAIA sends this to every other member. Each member's own rules decide:
            they may share, ask the member first, or decline. They see your group alias, not your name.
          </div>
        </q-card-section>
        <q-card-section class="q-pt-none q-gutter-sm">
          <q-select v-model="ask.groupId" :options="groups" option-value="groupId" option-label="groupName" emit-value map-options dense outlined label="Group" />
          <q-select v-model="ask.datatype" :options="WHAT" emit-value map-options dense outlined label="What you're asking for" />
          <q-select v-model="ask.purpose" :options="WHY" emit-value map-options dense outlined label="What it is for" />
          <q-input v-model="ask.message" dense outlined autogrow type="textarea" maxlength="1000" label="Message (optional)" />
          <div v-if="askError" class="text-negative text-caption">{{ askError }}</div>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat no-caps label="Cancel" v-close-popup />
          <q-btn unelevated no-caps color="primary" label="Send" :loading="asking" :disable="!ask.groupId" @click="sendAsk" />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup lang="ts">
/**
 * The Requests tab (Personal AS edition, group_requests.md §8.4): the
 * patient's personal request link, and every request to their MAIA with
 * its decision. Share / Decline / Ignore decide a request the rules left
 * to the patient; Stop sharing revokes what was shared.
 */
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue';
import QRCode from 'qrcode';
import { SCOPE_OPTIONS, PURPOSE_OPTIONS, sentenceFor, type PolicyCard, type AsState } from '../utils/policyCards';
import { WHAT, WHY, answerToHtml } from '../gnap/requestForm';
import { syncRequestLog, type LogSyncResult } from '../utils/requestLog';
import { reconnectLocalFolderWithGesture } from '../utils/localFolder';
import { useFolderPdfs } from '../composables/useFolderPdfs';

const props = defineProps<{ userId: string }>();
const emit = defineEmits<{ changed: [] }>();

interface RequestRow {
  id: string;
  groupId?: string | null;
  groupName?: string | null;
  fromAlias?: string | null;
  requester?: { name?: string | null; email?: string | null; emailVerified?: boolean } | null;
  resource: string;
  purpose: string;
  payload?: unknown;
  receivedAt: string;
  status: string;
  route?: string | null;
  fromOutsider?: boolean;
  recognized?: boolean;
  forgottenAt?: string | null;
  gnapPayment?: { type: string; amount: number } | null;
  autonomous?: boolean;
  decidedBySentence?: string | null;
}

const STATUS: Record<string, { label: string; color: string }> = {
  pending: { label: 'Needs your decision', color: 'orange-8' },
  accepted: { label: 'Shared', color: 'green-7' },
  declined: { label: 'Declined', color: 'grey-7' },
  blocked: { label: 'Ignored', color: 'grey-7' },
  withdrawn: { label: 'Withdrawn', color: 'grey-6' },
  stopped: { label: 'Sharing stopped', color: 'blue-grey-6' }
};

const PAYMENT_WORDS: Record<string, string> = {
  'spam-deposit': 'a spam deposit', 'notification-deposit': 'an evaluation fee', 'sharing-payment': 'a sharing payment'
};

const link = ref<{ pageUrl: string } | null>(null);
const qr = ref('');
const toggleQr = async () => {
  if (qr.value || !link.value) { qr.value = ''; return; }
  qr.value = await QRCode.toDataURL(link.value.pageUrl, { width: 400, margin: 1 }).catch(() => '');
};
const linkError = ref('');
const copied = ref(false);
const confirmRotate = ref(false);
const rotating = ref(false);
const requests = ref<RequestRow[]>([]);
const loading = ref(false);
const busyId = ref('');
const error = ref('');

const q = () => `userId=${encodeURIComponent(props.userId)}`;
const post = (url: string, body: Record<string, unknown> = {}) => fetch(url, {
  method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId: props.userId, ...body })
});

const scopeLabel = (v: string) => SCOPE_OPTIONS.find((o) => o.value === v)?.label || v;
const purposeLabel = (v: string) => (PURPOSE_OPTIONS.find((o) => o.value === v)?.label || v).toLowerCase();
const when = (iso: string) => { try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return iso; } };

// Filters (§8.4): needs your decision / shared / declined / all.
const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Needs your decision' },
  { id: 'shared', label: 'Shared' },
  { id: 'declined', label: 'Declined' }
] as const;
const filter = ref<'all' | 'pending' | 'shared' | 'declined'>('all');
const inFilter = (r: RequestRow) => filter.value === 'all'
  || (filter.value === 'pending' && r.status === 'pending')
  || (filter.value === 'shared' && (r.status === 'accepted' || r.status === 'stopped'))
  || (filter.value === 'declined' && (r.status === 'declined' || r.status === 'blocked'));
const pendingCount = computed(() => requests.value.filter((r) => r.status === 'pending').length);
const ordered = computed(() => requests.value.filter(inFilter).sort((a, b) =>
  (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || String(b.receivedAt).localeCompare(String(a.receivedAt))));

// ── The request log in the MAIA folder (§7) ─────────────────────────────
const logResult = ref<LogSyncResult | 'syncing' | ''>('');
const logState = computed(() => ({
  '': { icon: 'folder', color: 'grey-6', text: 'Request log in your MAIA folder: checking…' },
  syncing: { icon: 'sync', color: 'grey-6', text: 'Updating the request log in your MAIA folder…' },
  written: { icon: 'check_circle', color: 'green-7', text: 'Request log saved in your MAIA folder: Requests/Request Log.html' },
  unchanged: { icon: 'check_circle', color: 'green-7', text: 'Request log in your MAIA folder is up to date: Requests/Request Log.html' },
  'no-permission': { icon: 'lock', color: 'orange-8', text: 'MAIA needs your permission to write the request log in your MAIA folder.' },
  'no-folder': { icon: 'folder_off', color: 'grey-6', text: 'Connect your MAIA folder to keep a request log there.' },
  failed: { icon: 'error_outline', color: 'orange-8', text: 'The request log couldn’t be written. MAIA tries again later.' }
}[logResult.value]));
let syncing = false;
const syncLog = async () => {
  if (syncing || !props.userId) return;
  syncing = true;
  if (!logResult.value) logResult.value = 'syncing';
  try { logResult.value = await syncRequestLog(props.userId); } catch { logResult.value = 'failed'; } finally { syncing = false; }
};
const allowFolder = async () => {
  if (await reconnectLocalFolderWithGesture(props.userId)) await syncLog();
};

// ── "Always handle requests like this…" ────────────────────────────────
type RuleChoice = 'allow' | 'ask' | 'deny-respond' | 'deny-silent';
const RULE_OUTCOMES: Array<{ value: RuleChoice; label: string }> = [
  { value: 'allow', label: 'Share automatically' },
  { value: 'ask', label: 'Always ask me first' },
  { value: 'deny-respond', label: 'Decline, and tell them' },
  { value: 'deny-silent', label: 'Ignore, without telling them' }
];
const ruleOpen = ref(false);
const ruleFrom = ref<RequestRow | null>(null);
const ruleOutcome = ref<RuleChoice>('allow');
const ruleSaving = ref(false);
const ruleError = ref('');
const asState = ref<AsState>('setup');
const { saveSharingPoliciesPdf } = useFolderPdfs();
const ruleCard = (r: RequestRow, choice: RuleChoice): PolicyCard => {
  const member = r.fromOutsider === false;
  return {
    id: 'draft',
    outcome: choice.startsWith('deny') ? 'deny' : (choice as 'allow' | 'ask'),
    ...(choice.startsWith('deny') ? { denyMode: choice === 'deny-respond' ? 'respond' : 'silent' } : {}),
    enabled: true,
    provenance: 'user',
    createdFrom: 'request',
    elements: {
      party: member ? { type: 'group', groupId: r.groupId || '', groupName: r.groupName || '' } : { type: 'anyone' },
      purpose: (r.purpose || 'any') as PolicyCard['elements']['purpose'],
      scope: r.resource as PolicyCard['elements']['scope'],
      filtered: true,
      signature: member ? 'group-member' : (r.requester?.emailVerified ? 'verified-email' : 'unverified'),
      payment: (r.gnapPayment?.type || 'none') as PolicyCard['elements']['payment']
    }
  } as PolicyCard;
};
const ruleSentence = computed(() => (ruleFrom.value ? sentenceFor(ruleCard(ruleFrom.value, ruleOutcome.value)) : ''));
const openRule = async (r: RequestRow) => {
  ruleFrom.value = r;
  ruleError.value = '';
  ruleOutcome.value = r.status === 'declined' ? 'deny-respond' : r.status === 'blocked' ? 'deny-silent' : 'allow';
  ruleOpen.value = true;
  try {
    const d = await (await fetch(`/api/user-policies?${q()}`, { credentials: 'include' })).json();
    if (d.success) asState.value = d.asState;
  } catch { /* the note about sharing just stays */ }
};
const saveRule = async () => {
  if (!ruleFrom.value) return;
  ruleSaving.value = true;
  ruleError.value = '';
  try {
    const { id: _draft, ...policy } = ruleCard(ruleFrom.value, ruleOutcome.value);
    void _draft;
    const res = await post('/api/user-policies', { policy });
    const d = await res.json();
    if (!res.ok || !d.success) throw new Error(d.error || 'save failed');
    ruleOpen.value = false;
    // Keep the Sharing Policies PDF in the folder in step (§7).
    const list = await (await fetch(`/api/user-policies?${q()}`, { credentials: 'include' })).json();
    if (list.success) void saveSharingPoliciesPdf(props.userId, { cards: list.policies, asState: list.asState });
  } catch (e) {
    ruleError.value = e instanceof Error && e.message.startsWith('Policy limit') ? e.message : 'The rule couldn’t be added. Try again.';
  } finally { ruleSaving.value = false; }
};

const loadLink = async () => {
  linkError.value = '';
  try {
    const r = await fetch(`/api/gnap/request-link?${q()}`, { credentials: 'include' });
    const d = await r.json();
    if (!r.ok || !d.success) throw new Error();
    link.value = d;
  } catch { linkError.value = "Your request link couldn't be loaded."; }
};

const load = async () => {
  if (!props.userId) return;
  loading.value = true;
  error.value = '';
  try {
    const r = await fetch(`/api/user-groups/requests?${q()}`, { credentials: 'include' });
    const d = await r.json();
    if (r.ok && d.success) requests.value = d.requests || [];
  } catch { error.value = "Requests couldn't be loaded."; } finally { loading.value = false; }
};

const copyLink = async () => {
  if (!link.value) return;
  try { await navigator.clipboard.writeText(link.value.pageUrl); copied.value = true; setTimeout(() => { copied.value = false; }, 2000); } catch { /* select it by hand */ }
};

const rotate = async () => {
  rotating.value = true;
  try {
    const r = await post('/api/gnap/request-link/rotate');
    const d = await r.json();
    if (r.ok && d.success) { link.value = d; qr.value = ''; confirmRotate.value = false; await load(); }
  } finally { rotating.value = false; }
};

const decide = async (r: RequestRow, decision: 'accept' | 'decline' | 'block') => {
  busyId.value = r.id;
  error.value = '';
  try {
    const res = await post(`/api/user-groups/requests/${encodeURIComponent(r.id)}/decision`, { decision });
    if (!res.ok) throw new Error();
    await load();
    emit('changed');
    void syncLog();
  } catch { error.value = "That decision couldn't be saved. Try again."; } finally { busyId.value = ''; }
};

const stop = async (r: RequestRow) => {
  busyId.value = r.id;
  error.value = '';
  try {
    const res = await post(`/api/user-groups/requests/${encodeURIComponent(r.id)}/stop-sharing`);
    if (!res.ok) throw new Error();
    await load();
    emit('changed');
    void syncLog();
  } catch { error.value = "Sharing couldn't be stopped. Try again."; } finally { busyId.value = ''; }
};

const forget = async (r: RequestRow) => {
  busyId.value = r.id;
  error.value = '';
  try {
    const res = await post(`/api/user-groups/requests/${encodeURIComponent(r.id)}/forget-requester`);
    if (!res.ok) throw new Error();
    await load();
    void syncLog();
  } catch { error.value = "That requester couldn't be forgotten. Try again."; } finally { busyId.value = ''; }
};

// ── Requests this member sent to their groups ──────────────────────────
interface SentRequest {
  id: string; groupId: string; groupName: string; to: string | null; toAlias: string | null;
  what: string; why: string; message: string; state: string; createdAt: string;
  counts: { delivered: number; shared: number; declined: number };
  answers: Array<{ id: string; status: string }>;
}
const sent = ref<SentRequest[]>([]);
const groups = ref<Array<{ groupId: string; groupName: string }>>([]);
const answerTexts = reactive<Record<string, { text?: string; error?: string; loading?: boolean }>>({});
const askOpen = ref(false);
const asking = ref(false);
const askError = ref('');
const ask = reactive({ groupId: '', datatype: 'patient-summary', purpose: 'peer-support', message: '' });

const loadSent = async () => {
  if (!props.userId) return;
  try {
    const r = await fetch(`/api/gnap/member-requests?${q()}`, { credentials: 'include' });
    const d = await r.json();
    if (r.ok && d.success) { sent.value = d.sent || []; groups.value = d.groups || []; }
  } catch { /* the Sent list stays as it was */ }
};
const replaceSent = (next: SentRequest) => { sent.value = sent.value.map((x) => (x.id === next.id ? next : x)); };
const openAsk = () => {
  askError.value = '';
  ask.groupId = groups.value[0]?.groupId || '';
  ask.message = '';
  askOpen.value = true;
};
const sendAsk = async () => {
  asking.value = true;
  askError.value = '';
  try {
    const r = await post('/api/gnap/member-requests', { ...ask });
    const d = await r.json();
    if (!r.ok || !d.success) throw new Error(d.error || `HTTP ${r.status}`);
    askOpen.value = false;
    await loadSent();
  } catch (e) {
    askError.value = e instanceof Error && e.message !== 'TOO_MANY_TODAY' ? `Not sent: ${e.message}` : 'Not sent: you have asked a lot today. Try again tomorrow.';
  } finally { asking.value = false; }
};
const refreshSent = async (s: SentRequest) => {
  busyId.value = s.id;
  try {
    const r = await post(`/api/gnap/member-requests/${encodeURIComponent(s.id)}/refresh`);
    const d = await r.json();
    if (r.ok && d.success) replaceSent(d.request);
  } finally { busyId.value = ''; }
};
const withdrawSent = async (s: SentRequest) => {
  busyId.value = s.id;
  try {
    const r = await post(`/api/gnap/member-requests/${encodeURIComponent(s.id)}/withdraw`);
    const d = await r.json();
    if (r.ok && d.success) replaceSent(d.request);
  } finally { busyId.value = ''; }
};
const READ_ERRORS: Record<string, string> = {
  EXPIRED: 'This answer was readable for an hour after you first opened it.',
  STOPPED: 'The member stopped sharing this.',
  DECLINED: 'The member declined after all.'
};
const readAnswer = async (s: SentRequest, answerId: string) => {
  answerTexts[answerId] = { loading: true };
  try {
    const r = await post(`/api/gnap/member-requests/${encodeURIComponent(s.id)}/answers/${encodeURIComponent(answerId)}/read`);
    const d = await r.json();
    answerTexts[answerId] = r.ok && d.success
      ? { text: d.answer.text }
      : { error: READ_ERRORS[d.error] || "This answer couldn't be read." };
  } catch {
    answerTexts[answerId] = { error: "This answer couldn't be read." };
  }
};

let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  void loadLink();
  void load();
  void loadSent();
  void syncLog();
  // While the tab is open: new requests, and the folder log kept in step.
  timer = setInterval(() => { void load(); void loadSent(); void syncLog(); }, 60000);
});
onUnmounted(() => { if (timer) clearInterval(timer); });
watch(() => props.userId, () => { void loadLink(); void load(); void loadSent(); });
</script>

<style scoped>
.rp { padding: 16px; display: flex; flex-direction: column; gap: 20px; }
.rp__link-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.rp__filters { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.rp__filter { font: 500 12.5px inherit; font-family: inherit; border: 1px solid #d6dde4; background: #fff; border-radius: 999px; padding: 3px 11px; cursor: pointer; color: #37474f; }
.rp__filter[aria-pressed="true"] { background: #1976d2; border-color: #1976d2; color: #fff; }
.rp__filter:focus-visible { outline: 2px solid #1976d2; outline-offset: 2px; }
.rp__log { display: flex; align-items: center; gap: 6px; color: #607080; margin-bottom: 10px; min-height: 26px; }
.rp__sentence { margin-top: 10px; padding: 8px 10px; border-left: 3px solid #1976d2; background: #f5f8fc; font-size: 13.5px; }
.rp__qr { margin-top: 10px; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
.rp__url { background: #f5f5f5; border-radius: 4px; padding: 4px 8px; font-size: 12px; word-break: break-all; }
.rp__item { border: 1px solid #e0e0e0; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
.rp__item--pending { border-color: #ffb74d; background: #fffaf2; }
.rp__answer { white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.45; background: #fafafa; border: 1px solid #eee; border-radius: 6px; padding: 8px 10px; margin-top: 4px; }
.rp__message { white-space: pre-wrap; word-break: break-word; font-size: 13px; background: #fafafa; border-left: 3px solid #e0e0e0; padding: 4px 8px; margin-top: 6px; }
</style>
