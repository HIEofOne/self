<template>
  <div class="rq">
    <div class="rq__card">
      <div class="rq__brand">MAIA</div>
      <h1 class="rq__title">Ask the members of {{ groupName || 'a group' }}</h1>
      <p class="rq__lead">
        Your request goes to every member of this group<template v-if="memberCount"> ({{ memberCount }} people)</template>.
        Each member's own MAIA decides under the rules they set: it may share, ask them first, or decline.
        You never learn who a member is unless they share with you, and the group can't read the answers.
      </p>

      <div v-if="phase === 'loading'" class="rq__center"><q-spinner size="28px" color="primary" /></div>

      <div v-else-if="phase === 'gone'">
        <p>This group request page doesn't work. Ask for the group's current link.</p>
      </div>

      <div v-else-if="phase === 'unsupported'"><p>{{ error }}</p></div>

      <form v-else-if="phase === 'form'" class="rq__form" @submit.prevent="send">
        <q-input v-model="form.name" outlined dense label="Your name" maxlength="60" :rules="[(v) => !!v.trim() || 'Your name is needed']" />
        <q-input v-model="form.organization" outlined dense label="Organization (optional)" maxlength="60" />
        <q-select v-model="form.datatype" outlined dense emit-value map-options :options="WHAT" label="What are you asking for?" />
        <q-select v-model="form.purpose" outlined dense emit-value map-options :options="WHY" label="What is it for?" class="q-mt-md" />
        <q-input v-model="form.message" outlined dense autogrow type="textarea" maxlength="1000" counter
                 label="Message to the members (optional)" class="q-mt-md" />
        <p class="rq__note">
          Next you'll verify your email: the group sends your request on only
          after that, and MAIA emails you as answers arrive. You can also offer
          credits there. Your browser makes private keys for this request: see
          the answers in this same browser.
        </p>
        <p v-if="error" class="rq__err">{{ error }}</p>
        <q-btn type="submit" color="primary" unelevated no-caps label="Continue" :loading="busy" />
      </form>

      <div v-else-if="phase === 'verify' && current">
        <p>Your request hasn't gone to the members yet: verify your email first.</p>
        <div class="rq__actions">
          <q-btn color="primary" unelevated no-caps label="Verify my email" @click="goVerify" />
          <q-btn flat no-caps color="grey-8" label="Withdraw request" @click="doWithdraw" />
        </div>
      </div>

      <div v-else-if="phase === 'sent' && current">
        <div class="rq__status"><q-icon name="groups" size="20px" color="primary" /> Sent to {{ current.counts?.delivered || 0 }} members</div>
        <p class="rq__muted">
          {{ current.counts?.shared || 0 }} shared · {{ current.counts?.declined || 0 }} declined ·
          {{ Math.max(0, (current.counts?.delivered || 0) - (current.counts?.shared || 0) - (current.counts?.declined || 0)) }} haven't answered.
          Your request for <strong>{{ whatLabel(current.what) }}</strong> stays open for 30 days. MAIA emails you when new answers arrive:
          come back to this page, in this browser, to see them.
        </p>

        <div v-for="(a, i) in current.answers" :key="a.id" class="rq__member">
          <div class="rq__member-title">Member answer {{ i + 1 }}</div>
          <div v-if="a.status === 'unreadable'" class="rq__muted">This answer couldn't be opened.</div>
          <div v-else-if="texts[a.id]?.error" class="rq__muted">{{ texts[a.id].error }}</div>
          <template v-else-if="texts[a.id]?.text !== undefined">
            <p v-if="current.what === 'notification-only'">Their MAIA let them know you'd like to be in touch.</p>
            <div v-else class="rq__answer" v-html="answerToHtml(texts[a.id].text || '')"></div>
          </template>
          <div v-else class="rq__center"><q-spinner size="20px" color="primary" /></div>
        </div>
        <p v-if="current.answers.length" class="rq__muted">
          Released by each member's MAIA under their own sharing rules. Names are replaced with made-up ones.
        </p>
        <p v-if="note" class="rq__muted">{{ note }}</p>
        <div class="rq__actions rq__noprint">
          <q-btn color="primary" outline no-caps label="Check for answers" :loading="busy" @click="checkNow" />
          <q-btn v-if="current.answers.length && current.what !== 'notification-only'" color="primary" outline no-caps icon="print" label="Print or save as PDF" @click="printPage" />
          <q-btn flat no-caps color="grey-8" label="Close this request" :loading="busy" @click="doWithdraw" />
        </div>
      </div>

      <div v-else-if="current && ['withdrawn', 'expired'].includes(phase)">
        <div class="rq__status"><q-icon name="info" size="20px" color="grey-7" />
          {{ phase === 'withdrawn' ? 'You closed this request.' : 'This request is no longer open.' }}</div>
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
 * A group's request page, /g/:groupId/request (group_requests.md §10.9,
 * §10.10). The same GNAP client as a personal page, plus an X25519 sealing
 * key: the group verifies the requester's email once and carries the signed
 * request to every member; each member's MAIA answers sealed to this browser.
 * A "ready" answer holds a continuation at that member's MAIA, which only
 * this browser's key can use; the page trades it for a token at once and
 * reads the member's privacy-filtered answer there.
 */
import { ref, reactive, onMounted, onUnmounted } from 'vue';
import {
  startGroupRequest, finishGroupInteraction, pollGroup, withdrawGroup, readGroupAnswer,
  loadGroupRequests, getClientKey, getSealingKey, UnsupportedBrowserError, type GroupRequest
} from '../gnap/client';
import { WHAT, WHY, whatLabel, answerToHtml } from '../gnap/requestForm';

type Phase = 'loading' | 'gone' | 'unsupported' | 'form' | GroupRequest['status'];

const groupId = decodeURIComponent((window.location.pathname.match(/^\/g\/([^/]+)\/request\/?$/) || [])[1] || '');
const pagePath = `/g/${encodeURIComponent(groupId)}/request`;
const phase = ref<Phase>('loading');
const current = ref<GroupRequest | null>(null);
const groupName = ref('');
const memberCount = ref(0);
const busy = ref(false);
const error = ref('');
const note = ref('');
const texts = reactive<Record<string, { text?: string; error?: string }>>({});
const form = reactive({ name: '', organization: '', datatype: 'patient-summary', purpose: 'clinical', message: '' });

let pollTimer: ReturnType<typeof setTimeout> | null = null;
const stopTimer = () => { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } };
onUnmounted(stopTimer);

/** Read each ready answer at its member's MAIA (once per page view). */
const loadTexts = async (r: GroupRequest) => {
  for (const a of r.answers) {
    if (a.status !== 'ready' || texts[a.id]) continue;
    if (!a.token || a.token.expiresAt < Date.now()) {
      texts[a.id] = { error: 'This answer was available for an hour after it arrived. Make a new request to see it again.' };
      continue;
    }
    texts[a.id] = {};
    try { texts[a.id] = { text: (await readGroupAnswer(groupId, a)).text }; } catch (e) {
      texts[a.id] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
};

const show = async (r: GroupRequest | null) => {
  stopTimer();
  current.value = r;
  phase.value = r ? r.status : 'form';
  if (r?.status === 'sent') {
    schedule(r);
    await loadTexts(r);
  }
};

const schedule = (r: GroupRequest) => {
  const delay = Math.max(5000, (r.nextPollAt || 0) - Date.now());
  pollTimer = setTimeout(async () => {
    try { await show(await pollGroup(r)); } catch { schedule(r); }
  }, delay);
};

const send = async () => {
  if (!form.name.trim()) return;
  error.value = '';
  busy.value = true;
  try {
    const r = await startGroupRequest(groupId, form, `${window.location.origin}${pagePath}`);
    if (r.interact?.redirect) { window.location.href = r.interact.redirect; return; }
    await show(r);
  } catch (e) {
    if (e instanceof UnsupportedBrowserError) { error.value = e.message; phase.value = 'unsupported'; return; }
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
};

const goVerify = () => { if (current.value?.interact?.redirect) window.location.href = current.value.interact.redirect; };

const checkNow = async () => {
  if (!current.value) return;
  busy.value = true;
  note.value = '';
  try {
    const before = current.value;
    const r = await pollGroup(before);
    if (r.continueToken === before.continueToken) note.value = 'Nothing new yet. The page checks again on its own while it is open.';
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
  try { await show(await withdrawGroup(current.value)); } finally { busy.value = false; }
};

const newRequest = () => {
  stopTimer();
  error.value = '';
  current.value = null;
  phase.value = 'form';
};

const printPage = () => window.print();

onMounted(async () => {
  document.title = 'Ask a group';
  if (!groupId) { phase.value = 'gone'; return; }
  try {
    const d = await fetch(`/gnap/group/${encodeURIComponent(groupId)}`, { method: 'OPTIONS', cache: 'no-store' });
    const info = d.status === 200 ? await d.json().catch(() => null) : null;
    if (!info?.grant_request_endpoint) { phase.value = 'gone'; return; }
    groupName.value = info.maia_group?.name || '';
    memberCount.value = info.maia_group?.members || 0;
    document.title = `Ask ${groupName.value || 'a group'}`;
    await getClientKey();
    await getSealingKey();
  } catch (e) {
    if (e instanceof UnsupportedBrowserError) { error.value = e.message; phase.value = 'unsupported'; return; }
  }

  const saved = (await loadGroupRequests(groupId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const latest = saved[saved.length - 1] || null;

  // Back from the group's email check: …/request?hash=…&interact_ref=…
  const params = new URLSearchParams(window.location.search);
  const ref = params.get('interact_ref');
  const hash = params.get('hash');
  if (ref && hash) {
    window.history.replaceState({}, '', pagePath);
    const pending = [...saved].reverse().find((r) => r.status === 'verify');
    if (pending) {
      try { await show(await finishGroupInteraction(pending, ref, hash)); return; } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
      }
    }
  }
  // Opened again (often from the "answers" email): check at once.
  if (latest?.status === 'sent') {
    await show(await pollGroup(latest).catch(() => latest));
    return;
  }
  await show(latest && latest.status !== 'withdrawn' ? latest : null);
});
</script>

<style scoped>
.rq { min-height: 100vh; background: #f5f7fa; padding: 32px 16px; box-sizing: border-box; }
.rq__card { max-width: 620px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 28px 28px 24px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
.rq__brand { font-weight: 700; letter-spacing: .08em; color: #1976d2; font-size: 13px; }
.rq__title { font-size: 22px; line-height: 1.3; margin: 6px 0 8px; font-weight: 600; }
.rq__lead { color: #555; line-height: 1.5; margin-bottom: 20px; }
.rq__form :deep(.q-field) { margin-bottom: 4px; }
.rq__note { color: #666; font-size: 13px; line-height: 1.45; margin: 12px 0 16px; }
.rq__muted { color: #777; font-size: 13px; line-height: 1.45; }
.rq__err { color: #b00020; margin-top: 8px; }
.rq__status { display: flex; align-items: center; gap: 8px; font-weight: 600; margin-bottom: 6px; }
.rq__actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.rq__center { display: flex; justify-content: center; padding: 16px 0; }
.rq__member { border-top: 1px solid #eee; padding-top: 12px; margin-top: 12px; }
.rq__member-title { font-weight: 600; font-size: 14px; margin-bottom: 4px; }
.rq__answer { white-space: pre-wrap; word-break: break-word; line-height: 1.5; background: #fafafa; border: 1px solid #eee; border-radius: 8px; padding: 14px 16px; margin: 4px 0 8px; }
@media print {
  .rq { background: #fff; padding: 0; }
  .rq__card { box-shadow: none; padding: 0; }
  .rq__noprint, .rq__lead { display: none; }
}
</style>
