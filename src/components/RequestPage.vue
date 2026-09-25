<template>
  <div class="rq">
    <div class="rq__card">
      <div class="rq__brand">MAIA</div>
      <h1 class="rq__title">Ask for health information</h1>
      <p class="rq__lead">
        This link reaches one person's MAIA: their own AI agent, which keeps
        their health records and answers requests under the rules they set.
        They may answer at once, ask to decide themselves, or decline.
      </p>

      <div v-if="phase === 'loading'" class="rq__center"><q-spinner size="28px" color="primary" /></div>

      <div v-else-if="phase === 'gone'">
        <p>This request link doesn't work anymore. Ask the person for their current link.</p>
      </div>

      <div v-else-if="phase === 'unsupported'">
        <p>{{ error }}</p>
      </div>

      <!-- The request form -->
      <form v-else-if="phase === 'form'" class="rq__form" @submit.prevent="send">
        <q-input v-model="form.name" outlined dense label="Your name" maxlength="60" :rules="[(v) => !!v.trim() || 'Your name is needed']" />
        <q-input v-model="form.organization" outlined dense label="Organization (optional)" maxlength="60" />
        <q-select v-model="form.datatype" outlined dense emit-value map-options :options="WHAT" label="What are you asking for?" />
        <q-select v-model="form.purpose" outlined dense emit-value map-options :options="WHY" label="What is it for?" class="q-mt-md" />
        <q-input v-model="form.message" outlined dense autogrow type="textarea" maxlength="1000" counter
                 label="Message to the person (optional)" class="q-mt-md" />
        <p class="rq__note">
          Next you'll verify your email, so the person knows who is asking and
          MAIA can tell you when there's an answer. Your browser makes a
          private key for this request: see the answer in this same browser.
        </p>
        <p v-if="error" class="rq__err">{{ error }}</p>
        <q-btn type="submit" color="primary" unelevated no-caps label="Continue" :loading="busy" />
      </form>

      <!-- Came back without finishing the email check -->
      <div v-else-if="phase === 'verify' && current">
        <p>Your request was sent. Verify your email so the person knows who is asking, and so MAIA can tell you when there's an answer.</p>
        <div class="rq__actions">
          <q-btn color="primary" unelevated no-caps label="Verify my email" @click="goVerify" />
          <q-btn flat no-caps color="grey-8" label="Wait without an email" @click="skipVerify" />
        </div>
      </div>

      <div v-else-if="phase === 'waiting' && current">
        <div class="rq__status"><q-icon name="hourglass_top" size="20px" color="amber-8" /> Waiting for an answer</div>
        <p>
          Your request for <strong>{{ whatLabel(current.what) }}</strong> is with the person's MAIA.
          If you verified your email, we'll email you when there's an answer.
          You can close this page: come back to this link, in this browser, to see it.
        </p>
        <p v-if="note" class="rq__muted">{{ note }}</p>
        <div class="rq__actions">
          <q-btn color="primary" outline no-caps label="Check now" :loading="busy" @click="checkNow" />
          <q-btn flat no-caps color="grey-8" label="Withdraw request" :loading="busy" @click="doWithdraw" />
        </div>
      </div>

      <div v-else-if="phase === 'ready' && current">
        <div v-if="!answerError" class="rq__status"><q-icon name="check_circle" size="20px" color="green-7" /> The person shared this with you</div>
        <div v-else class="rq__status"><q-icon name="info" size="20px" color="grey-7" /> {{ answerError }}</div>
        <template v-if="!answerError && answer">
          <p v-if="current.what === 'notification-only'">Their MAIA let them know you'd like to be in touch.</p>
          <div v-else class="rq__answer" v-html="answerHtml"></div>
          <p class="rq__muted">{{ answer.attribution }} Retrieved {{ new Date(answer.retrievedAt).toLocaleString() }}.</p>
          <div class="rq__actions rq__noprint">
            <q-btn v-if="current.what !== 'notification-only'" color="primary" outline no-caps icon="print" label="Print or save as PDF" @click="printAnswer" />
          </div>
        </template>
        <div v-else-if="!answerError" class="rq__center"><q-spinner size="24px" color="primary" /></div>
        <div class="rq__actions rq__noprint">
          <q-btn flat no-caps color="primary" label="Make a new request" @click="newRequest" />
        </div>
      </div>

      <div v-else-if="current && ['declined', 'withdrawn', 'expired'].includes(phase)">
        <div class="rq__status">
          <q-icon :name="phase === 'declined' ? 'block' : 'info'" size="20px" color="grey-7" />
          {{ phase === 'declined' ? 'The person declined this request.' : phase === 'withdrawn' ? 'You withdrew this request.' : 'This request is no longer open.' }}
        </div>
        <div class="rq__actions">
          <q-btn flat no-caps color="primary" label="Make a new request" @click="newRequest" />
        </div>
      </div>

      <p v-if="phase !== 'form' && error" class="rq__err">{{ error }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * A patient's personal request page, /r/:asId (group_requests.md §10.10):
 * one small GNAP client. It signs every call with a key made in this
 * browser, sends the requester to verify an email, waits for the patient,
 * and reads the privacy-filtered answer from the patient's MAIA. Nothing
 * is emailed with record data; the answer is shown here only.
 */
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import {
  startRequest, finishInteraction, poll, withdraw, readAnswer, loadRequests, saveRequest, getClientKey,
  UnsupportedBrowserError, type SavedRequest, type Answer
} from '../gnap/client';

const WHAT = [
  { value: 'patient-summary', label: 'Their Patient Summary' },
  { value: 'meds-allergies', label: 'Their current medications and allergies' },
  { value: 'notification-only', label: "Just let them know I'd like to be in touch" }
];
const WHY = [
  { value: 'clinical', label: 'Clinical care' },
  { value: 'peer-support', label: 'Peer support' },
  { value: 'research', label: 'Research' },
  { value: 'public-health', label: 'Public health' }
];
const whatLabel = (v: string) => ({
  'patient-summary': 'their Patient Summary', 'meds-allergies': 'their current medications and allergies',
  'notification-only': 'a note that you would like to be in touch'
} as Record<string, string>)[v] || v;

type Phase = 'loading' | 'gone' | 'unsupported' | 'form' | SavedRequest['status'];

const asId = (window.location.pathname.match(/^\/r\/([0-9a-f]{32})\/?$/) || [])[1] || '';
const phase = ref<Phase>('loading');
const current = ref<SavedRequest | null>(null);
const busy = ref(false);
const error = ref('');
const note = ref('');
const answer = ref<Answer | null>(null);
const answerError = ref('');
const form = reactive({ name: '', organization: '', datatype: 'patient-summary', purpose: 'clinical', message: '' });

let pollTimer: ReturnType<typeof setTimeout> | null = null;
const stopTimer = () => { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } };
onUnmounted(stopTimer);

const show = async (r: SavedRequest | null) => {
  stopTimer();
  current.value = r;
  phase.value = r ? r.status : 'form';
  if (r?.status === 'waiting') schedule(r);
  if (r?.status === 'ready' && !answer.value) await loadAnswer(r);
};

/** While the page is open, ask again when the wait it was given is over. */
const schedule = (r: SavedRequest) => {
  const delay = Math.max(5000, (r.nextPollAt || 0) - Date.now());
  pollTimer = setTimeout(async () => {
    try { await show(await poll(r)); } catch { schedule(r); }
  }, delay);
};

const loadAnswer = async (r: SavedRequest) => {
  answerError.value = '';
  if (!r.token || r.token.expiresAt < Date.now()) {
    answerError.value = 'This answer was available for an hour after you first opened it. Make a new request to see it again.';
    return;
  }
  try { answer.value = await readAnswer(r); } catch (e) { answerError.value = e instanceof Error ? e.message : String(e); }
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
// The summary is Markdown-ish text. Escape everything first, then allow bold
// and headings only: nothing from the answer is ever markup.
const answerHtml = computed(() => escapeHtml(answer.value?.text || '')
  .replace(/^#{1,4}\s+(.+)$/gm, '<strong>$1</strong>')
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'));

const send = async () => {
  if (!form.name.trim()) return;
  error.value = '';
  busy.value = true;
  try {
    const r = await startRequest(asId, form, `${window.location.origin}/r/${asId}`);
    if (r.status === 'verify' && r.interact?.redirect) {
      window.location.href = r.interact.redirect;
      return;
    }
    await show(r);
  } catch (e) {
    if (e instanceof UnsupportedBrowserError) { error.value = e.message; phase.value = 'unsupported'; return; }
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
};

const goVerify = () => { if (current.value?.interact?.redirect) window.location.href = current.value.interact.redirect; };
const skipVerify = async () => {
  if (!current.value) return;
  const r: SavedRequest = { ...current.value, status: 'waiting', interact: undefined };
  await saveRequest(r);
  await show(r);
};

const checkNow = async () => {
  if (!current.value) return;
  busy.value = true;
  note.value = '';
  try {
    const before = current.value;
    const r = await poll(before);
    if (r.status === 'waiting' && r.continueToken === before.continueToken) note.value = 'No answer yet. MAIA asks again on its own while this page is open.';
    await show(r);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
};

const doWithdraw = async () => {
  if (!current.value) return;
  busy.value = true;
  try { await show(await withdraw(current.value)); } finally { busy.value = false; }
};

const newRequest = () => {
  stopTimer();
  answer.value = null;
  answerError.value = '';
  error.value = '';
  current.value = null;
  phase.value = 'form';
};

const printAnswer = () => window.print();

onMounted(async () => {
  document.title = 'Ask a MAIA';
  if (!asId) { phase.value = 'gone'; return; }
  try {
    // The address answers discovery only while it is the person's current link.
    const d = await fetch(`/gnap/as/${asId}`, { method: 'OPTIONS', cache: 'no-store' });
    const info = d.status === 200 ? await d.json().catch(() => null) : null;
    if (!info?.grant_request_endpoint) { phase.value = 'gone'; return; }
    await getClientKey();
  } catch (e) {
    if (e instanceof UnsupportedBrowserError) { error.value = e.message; phase.value = 'unsupported'; return; }
  }

  const saved = (await loadRequests(asId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const latest = saved[saved.length - 1] || null;

  // Back from the email check: …/r/<asId>?hash=…&interact_ref=…
  const params = new URLSearchParams(window.location.search);
  const ref = params.get('interact_ref');
  const hash = params.get('hash');
  if (ref && hash) {
    window.history.replaceState({}, '', `/r/${asId}`);
    const pending = [...saved].reverse().find((r) => r.status === 'verify');
    if (pending) {
      try { await show(await finishInteraction(pending, ref, hash)); return; } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
      }
    }
  }
  // Opened again (often from the "answer ready" email): ask at once. The
  // patient's decision lifts the wait; if there's no answer yet the AS
  // just says "too fast" and the page waits as it was told.
  if (latest?.status === 'waiting') {
    await show(await poll(latest).catch(() => latest));
    return;
  }
  await show(latest && !['withdrawn'].includes(latest.status) ? latest : null);
});
</script>

<style scoped>
.rq { min-height: 100vh; background: #f5f7fa; padding: 32px 16px; box-sizing: border-box; }
.rq__card { max-width: 560px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 28px 28px 24px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
.rq__brand { font-weight: 700; letter-spacing: .08em; color: #1976d2; font-size: 13px; }
.rq__title { font-size: 22px; line-height: 1.3; margin: 6px 0 8px; font-weight: 600; }
.rq__lead { color: #555; line-height: 1.5; margin-bottom: 20px; }
.rq__form :deep(.q-field) { margin-bottom: 4px; }
.rq__note { color: #666; font-size: 13px; line-height: 1.45; margin: 12px 0 16px; }
.rq__muted { color: #777; font-size: 13px; line-height: 1.45; }
.rq__err { color: #b00020; margin-top: 8px; }
.rq__status { display: flex; align-items: center; gap: 8px; font-weight: 600; margin-bottom: 10px; }
.rq__actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.rq__center { display: flex; justify-content: center; padding: 24px 0; }
.rq__answer { white-space: pre-wrap; word-break: break-word; line-height: 1.5; background: #fafafa; border: 1px solid #eee; border-radius: 8px; padding: 14px 16px; margin: 8px 0 12px; }
@media print {
  .rq { background: #fff; padding: 0; }
  .rq__card { box-shadow: none; padding: 0; }
  .rq__noprint, .rq__lead { display: none; }
}
</style>
