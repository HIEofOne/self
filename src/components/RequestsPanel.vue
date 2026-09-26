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
        <q-btn dense flat round size="sm" icon="refresh" :loading="loading" @click="load"><q-tooltip>Refresh</q-tooltip></q-btn>
      </div>
      <div v-if="!loading && !requests.length" class="text-caption text-grey-7">
        No requests yet. When someone uses your link, the request appears here.
      </div>

      <div v-for="r in ordered" :key="r.id" class="rp__item" :class="{ 'rp__item--pending': r.status === 'pending' }">
        <div class="row items-center no-wrap">
          <q-badge :color="STATUS[r.status]?.color || 'grey'" :label="STATUS[r.status]?.label || r.status" />
          <span class="text-caption text-grey-7 q-ml-sm">{{ when(r.receivedAt) }} · {{ r.groupName || 'Direct request' }}</span>
        </div>
        <div class="q-mt-xs">
          <strong>{{ r.requester?.name || r.fromAlias || 'Someone' }}</strong>
          <span class="text-caption text-grey-7"> (name not verified)</span>
          asks for <strong>{{ scopeLabel(r.resource) }}</strong> for <strong>{{ purposeLabel(r.purpose) }}</strong>.
        </div>
        <div class="text-caption q-mt-xs">
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
      </div>
      <div v-if="error" class="text-negative text-caption q-mt-sm">{{ error }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * The Requests tab (Personal AS edition, group_requests.md §8.4): the
 * patient's personal request link, and every request to their MAIA with
 * its decision. Share / Decline / Ignore decide a request the rules left
 * to the patient; Stop sharing revokes what was shared.
 */
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import QRCode from 'qrcode';
import { SCOPE_OPTIONS, PURPOSE_OPTIONS } from '../utils/policyCards';

const props = defineProps<{ userId: string }>();
const emit = defineEmits<{ changed: [] }>();

interface RequestRow {
  id: string;
  groupName?: string | null;
  fromAlias?: string | null;
  requester?: { name?: string | null; email?: string | null; emailVerified?: boolean } | null;
  resource: string;
  purpose: string;
  payload?: unknown;
  receivedAt: string;
  status: string;
  route?: string | null;
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

const ordered = computed(() => [...requests.value].sort((a, b) =>
  (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || String(b.receivedAt).localeCompare(String(a.receivedAt))));

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
  } catch { error.value = "Sharing couldn't be stopped. Try again."; } finally { busyId.value = ''; }
};

const forget = async (r: RequestRow) => {
  busyId.value = r.id;
  error.value = '';
  try {
    const res = await post(`/api/user-groups/requests/${encodeURIComponent(r.id)}/forget-requester`);
    if (!res.ok) throw new Error();
    await load();
  } catch { error.value = "That requester couldn't be forgotten. Try again."; } finally { busyId.value = ''; }
};

let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  void loadLink();
  void load();
  timer = setInterval(load, 60000);
});
onUnmounted(() => { if (timer) clearInterval(timer); });
watch(() => props.userId, () => { void loadLink(); void load(); });
</script>

<style scoped>
.rp { padding: 16px; display: flex; flex-direction: column; gap: 20px; }
.rp__link-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.rp__qr { margin-top: 10px; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
.rp__url { background: #f5f5f5; border-radius: 4px; padding: 4px 8px; font-size: 12px; word-break: break-all; }
.rp__item { border: 1px solid #e0e0e0; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
.rp__item--pending { border-color: #ffb74d; background: #fffaf2; }
.rp__message { white-space: pre-wrap; word-break: break-word; font-size: 13px; background: #fafafa; border-left: 3px solid #e0e0e0; padding: 4px 8px; margin-top: 6px; }
</style>
