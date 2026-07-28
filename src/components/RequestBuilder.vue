<template>
  <div class="rqb">
    <!-- ── Request matrix ───────────────────────────────── -->
    <div class="rqb-matrix">
      <div v-for="col in columns" :key="col.key" class="rqb-col">
        <div class="rqb-col-head">{{ col.head }}</div>
        <button
          v-for="opt in col.options"
          :key="opt.v"
          type="button"
          class="rqb-cell"
          :class="{ 'is-sel': sel[col.key] === opt.v }"
          :aria-pressed="sel[col.key] === opt.v"
          @click="pick(col.key, opt.v)"
        >
          <span>{{ opt.label }}</span>
          <span v-if="opt.sub" class="rqb-sub">{{ opt.sub }}</span>
        </button>
      </div>
    </div>

    <!-- ── Expandable message / special instructions ────── -->
    <div class="rqb-msg">
      <label for="rqb-msg-input" class="rqb-msg-label">Message to the group (optional)</label>
      <textarea
        id="rqb-msg-input"
        ref="msgEl"
        v-model="message"
        class="rqb-msg-input"
        rows="1"
        placeholder="Optionally, enter a message or special instructions here."
        @input="autoGrow"
      ></textarea>
    </div>

    <!-- ── Requester identity (required to really send) ──── -->
    <div v-if="props.group" class="rqb-identity">
      <div class="rqb-identity-row">
        <input v-model="requesterName" class="rqb-text" type="text" placeholder="Your name (required)" maxlength="80" />
        <input v-model="requesterOrg" class="rqb-text" type="text" placeholder="Organization (optional)" maxlength="120" />
      </div>
      <div class="rqb-verify">
        <EmailVerifyBox label="Your email — verify it to receive responses" />
      </div>
    </div>

    <!-- ── Live request line ────────────────────────────── -->
    <div class="rqb-card-stage">
      <div v-if="!ready" class="rqb-card-empty">
        Pick who you are, what you’re asking for, and why — then send it to the group.
      </div>
      <div v-else class="rqb-card">
        <span class="rqb-badge">● Your request</span>
        <p class="rqb-sentence" v-html="sentenceHtml"></p>
      </div>
    </div>

    <!-- ── Try it ───────────────────────────────────────── -->
    <div class="rqb-actions">
      <q-btn unelevated color="primary" :label="props.group ? 'Preview the outcome' : 'Try It — send to the group'" :disable="!ready" @click="runTry" />
      <q-btn
        v-if="props.group"
        unelevated color="green-8"
        label="Send request to the group"
        :loading="sending"
        :disable="!canSend"
        @click="sendRequest"
      />
      <span v-if="!ready" class="rqb-hint">Pick an identity, a scope, and a purpose to send.</span>
      <span v-else-if="props.group && !canSend" class="rqb-hint">Add your name and a verified email to send for real.</span>
      <q-btn v-if="response || sentResult" flat color="grey-8" label="Clear" @click="clearAll" />
    </div>

    <!-- ── Real send result ─────────────────────────────── -->
    <div v-if="sentResult" class="rqb-response forward">
      <div class="rqb-response-head">✓ Request sent</div>
      <div class="rqb-response-body">
        Delivered to <b>{{ sentResult.delivered }}</b> member<span v-if="sentResult.delivered !== 1">s</span>.
        <b>{{ sentResult.responded }}</b> of <b>{{ sentResult.delivered }}</b> responded so far<span v-if="sentResult.responded > 0"> ({{ sentResult.accepted }} accepted · {{ sentResult.declined }} declined)</span>.
        Each member’s MAIA decides per their sharing policy; responses also arrive
        at <b>{{ sentEmail }}</b> as they come in.
      </div>
    </div>

    <!-- ── Response block ───────────────────────────────── -->
    <div v-if="response" class="rqb-response" :class="response.cls">
      <div class="rqb-response-head">{{ response.head }}</div>
      <div class="rqb-response-body" v-html="response.body"></div>
      <div v-if="response.speaker" class="rqb-speaker" :class="{ ai: response.speakerAI }">
        <div class="rqb-speaker-from">{{ response.speakerFrom }}</div>
        <div v-html="response.speaker"></div>
      </div>
      <div v-if="emailNote" class="rqb-emailnote">{{ emailNote }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, nextTick, onUnmounted } from 'vue';
import { useQuasar } from 'quasar';
import { useVerifiedEmail } from '../composables/verifiedEmail';
import EmailVerifyBox from './EmailVerifyBox.vue';

// The group the request is really sent to (the welcome page passes the Trustee
// group + its registry origin). Without it, the builder stays a preview.
const props = defineProps<{ group?: { groupId: string; name: string; origin?: string } | null }>();
const $q = useQuasar();
// Shared welcome-page verified-email state — the SAME address the setup form and
// policy table use. A verified email is required to really send, so responses
// can come back to the requester.
const { state: verifiedEmail } = useVerifiedEmail();

const requesterName = ref('');
const requesterOrg = ref('');
const sending = ref(false);
const sentResult = ref<{ delivered: number; responded: number; accepted: number; declined: number } | null>(null);
const sentEmail = ref('');
let statusTimer: ReturnType<typeof setInterval> | null = null;
const stopPolling = () => { if (statusTimer) { clearInterval(statusTimer); statusTimer = null; } };
onUnmounted(stopPolling);

type ColKey = 'signature' | 'scope' | 'purpose' | 'payment';
interface CellOpt { v: string; label: string; sub?: string }
interface Column { key: ColKey; head: string; options: CellOpt[] }

// The request the visitor composes. Labels + column order mirror
// PolicyCardBuilder's matrix (Scope · Purpose · Signature Strength · Deposit)
// so "what you present" here reads the same as "what they present" there.
const columns: Column[] = [
  { key: 'scope', head: 'Scope of Request', options: [
    { v: 'notification-only', label: 'Patient notification only', sub: 'reach them, no record data' },
    { v: 'meds-allergies', label: 'Current medications' },
    { v: 'patient-summary', label: 'Patient summary' },
    { v: 'not-sensitive', label: 'Everything not sensitive' },
    { v: 'everything', label: 'Everything' }
  ]},
  { key: 'purpose', head: 'Claimed Purpose', options: [
    { v: 'peer-support', label: 'Peer support' },
    { v: 'clinical', label: 'Clinical' },
    { v: 'research', label: 'Research' },
    { v: 'public-health', label: 'Public health' },
    { v: 'marketing', label: 'Marketing' }
  ]},
  { key: 'signature', head: 'Signature Strength', options: [
    { v: 'unverified', label: 'Unverified', sub: 'no identity check' },
    { v: 'verified-email', label: 'Verified email' },
    { v: 'group-member', label: 'Group member' },
    { v: 'npi', label: 'NPI verified', sub: 'licensed provider' },
    { v: 'doximity', label: 'Doximity verified', sub: 'verified clinician' }
  ]},
  { key: 'payment', head: 'Deposit or Payment', options: [
    { v: 'none', label: 'None' },
    { v: 'spam-deposit', label: 'Spam evaluation deposit', sub: 'returnable' },
    { v: 'notification-deposit', label: 'Request evaluation payment' },
    { v: 'sharing-payment', label: 'Payment for information' }
  ]}
];

const sel = reactive<Record<ColKey, string | null>>({
  signature: null, scope: null, purpose: null, payment: null
});
const message = ref('');
const msgEl = ref<HTMLTextAreaElement | null>(null);

const pick = (key: ColKey, v: string) => { sel[key] = sel[key] === v ? null : v; };
// Payment is optional — it defaults to "None" if the visitor doesn't pick one.
const ready = computed(() => !!(sel.signature && sel.scope && sel.purpose));

const autoGrow = () => {
  const el = msgEl.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 220) + 'px';
};

const SIG_LABEL: Record<string, string> = {
  unverified: 'unverified', 'verified-email': 'a verified email', 'group-member': 'a group member',
  npi: 'an NPI-verified provider', doximity: 'a Doximity-verified clinician'
};
const SCOPE_HUMAN: Record<string, string> = {
  'notification-only': 'to send you a message', 'meds-allergies': 'your current medications',
  'patient-summary': 'your patient summary', 'not-sensitive': 'your record except sensitive categories',
  everything: 'your whole record'
};
const PURPOSE_HUMAN: Record<string, string> = {
  'peer-support': 'peer support', clinical: 'clinical care', research: 'research',
  'public-health': 'public health', marketing: 'marketing'
};
const PAY_HUMAN: Record<string, string> = {
  none: '', 'spam-deposit': ', with a returnable spam-evaluation deposit',
  'notification-deposit': ', with a request-evaluation payment', 'sharing-payment': ', offering to pay for the information'
};
const SIG_RANK: Record<string, number> = { unverified: 0, 'verified-email': 1, 'group-member': 2, npi: 3, doximity: 3 };

const sentenceHtml = computed(() => {
  const who = SIG_LABEL[sel.signature || 'unverified'];
  const asked = SCOPE_HUMAN[sel.scope || 'patient-summary'];
  const why = PURPOSE_HUMAN[sel.purpose || 'clinical'];
  const pay = PAY_HUMAN[sel.payment || 'none'];
  const verb = sel.scope === 'notification-only' ? 'as' : 'for';
  return `Someone presenting <b>${who}</b> is asking ${sel.scope === 'notification-only' ? '' : 'for '}` +
    `<b>${asked}</b> ${verb === 'as' ? '' : verb + ' '}<b>${why}</b>${pay}.`;
});

interface Response { cls: string; head: string; body: string; speaker?: string; speakerFrom?: string; speakerAI?: boolean; }
const response = ref<Response | null>(null);

const emailNote = computed(() =>
  response.value && SIG_RANK[sel.signature!] >= 1
    ? 'Because your request carries a verified identity, each member’s response comes back to you as it arrives.'
    : (response.value ? 'Add a verified email to receive responses as they come in.' : ''));

// Real send needs a target group, a full request, a name, and a VERIFIED email
// (so members' responses have somewhere to go).
const canSend = computed(() => !!(
  ready.value && props.group && requesterName.value.trim() &&
  verifiedEmail.verified && verifiedEmail.email
));

// Really submit the request to the group (W3 outside-request). The registry
// seals it to each member's inbox; members' MAIAs decide per policy and any
// response comes back to the requester's email — the registry never brokers it.
const sendRequest = async () => {
  if (!canSend.value || sending.value || !props.group) return;
  sending.value = true;
  try {
    const res = await fetch('/api/groups/outside-request-proxy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({
        origin: props.group.origin || window.location.origin,
        groupId: props.group.groupId,
        name: requesterName.value.trim(),
        email: verifiedEmail.email,
        organization: requesterOrg.value.trim() || undefined,
        message: message.value.trim(),
        scope: sel.scope,
        purpose: sel.purpose
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    sentEmail.value = verifiedEmail.email;
    sentResult.value = { delivered: data.delivered || 0, responded: 0, accepted: 0, declined: 0 };
    response.value = null; // the real result replaces the preview
    if (data.requestId) startStatusPoll(String(data.requestId));
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Could not send request' });
  } finally {
    sending.value = false;
  }
};

// Poll the public tally (counts only) so the requester sees responses arrive
// while this page stays open. Responses also come by email — so we poll for a
// bounded window, then stop (the visitor has likely moved on by then).
const startStatusPoll = (requestId: string) => {
  stopPolling();
  const origin = props.group?.origin || window.location.origin;
  const groupId = props.group?.groupId;
  if (!groupId) return;
  const url = `${origin}/api/groups/${encodeURIComponent(groupId)}/outside-request/${encodeURIComponent(requestId)}/status`;
  const started = Date.now();
  const tick = async () => {
    try {
      const r = await fetch(url, { credentials: 'include' });
      if (r.ok) {
        const d = await r.json();
        if (d?.success && sentResult.value) {
          sentResult.value.responded = d.responded || 0;
          sentResult.value.accepted = d.accepted || 0;
          sentResult.value.declined = d.declined || 0;
        }
      }
    } catch { /* transient; next tick retries */ }
    if (Date.now() - started > 10 * 60 * 1000) stopPolling(); // give up after 10 min
  };
  void tick();
  statusTimer = setInterval(() => { void tick(); }, 5000);
};

const clearAll = () => {
  (Object.keys(sel) as ColKey[]).forEach((k) => { sel[k] = null; });
  message.value = '';
  response.value = null;
  sentResult.value = null;
  requesterName.value = '';
  requesterOrg.value = '';
  stopPolling();
  nextTick(autoGrow);
};

const runTry = () => {
  if (!ready.value) return;
  const idRank = SIG_RANK[sel.signature!];
  const paid = !!sel.payment && sel.payment !== 'none';
  const hasMsg = message.value.trim().length > 0;
  const asked = SCOPE_HUMAN[sel.scope!];
  const why = PURPOSE_HUMAN[sel.purpose!];

  // 1. Ignored as spam — anonymous, offering nothing, reaching broadly.
  if (idRank === 0 && !paid && (sel.purpose === 'marketing' || sel.scope === 'everything' || sel.scope === 'not-sensitive')) {
    response.value = {
      cls: 'spam', head: '○ Likely ignored as spam',
      body: 'With no verified identity and nothing offered, most members’ private AI drops a broad request like this. You get no reply, and you won’t know it was seen.'
    };
    return;
  }

  // 2. Forwarded to the patient — you’re reaching them, or a credible request carries a note.
  if (sel.scope === 'notification-only' || (hasMsg && idRank >= 1) || (idRank >= 2 && (sel.purpose === 'peer-support' || sel.purpose === 'clinical'))) {
    response.value = {
      cls: 'forward', head: '● Forwarded to the patient',
      body: 'Each member’s private AI passes your request to the patient as a message. They decide whether to reply or share.',
      speaker: sel.scope === 'notification-only'
        ? (hasMsg ? `“${message.value.trim()}”` : 'Your message reaches the patient. They may reply if they choose.')
        : `A requester (${why}) would like <b>${asked}</b>.${hasMsg ? ` They add: “${message.value.trim()}”` : ''} Share it?`,
      speakerFrom: 'Delivered to the patient', speakerAI: false
    };
    return;
  }

  // 3. A suggestion from the patient’s private AI on how to improve the request.
  const tips: string[] = [];
  if (idRank === 0) tips.push('verify your email so members can trust the request');
  if (sel.scope === 'everything' || sel.scope === 'not-sensitive') tips.push('narrow your request — most members share a patient summary, not the whole record');
  if (!paid && idRank <= 1) tips.push('include a returnable spam-evaluation deposit to show you’re serious');
  if (sel.purpose === 'marketing') tips.push('state a clinical, research, or peer-support purpose');
  if (!tips.length) tips.push('add a short message explaining what you need and why');
  response.value = {
    cls: 'suggest', head: '◆ A suggestion to improve your request',
    body: 'The patient’s private AI didn’t forward this as-is, but it can tell you how to get through.',
    speaker: `To reach this patient: ${tips.slice(0, 2).join('; ')}.`,
    speakerFrom: 'Patient’s private AI → you', speakerAI: true
  };
};
</script>

<style scoped lang="scss">
.rqb {
  --rqb-accent: #0e7490;
  --rqb-accent-soft: #e2f1f4;
  --rqb-line: #dde5eb;
  --rqb-chip: #f1f5f8;
  --rqb-ink: #17222e;
  --rqb-muted: #6b7b8b;
  color: var(--rqb-ink);
  font-size: 14px;
}

/* Matrix */
.rqb-matrix {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 0;
  border: 1px solid var(--rqb-line); border-radius: 10px; overflow: hidden; background: #fff;
}
.rqb-col { border-right: 1px solid var(--rqb-line); display: flex; flex-direction: column; }
.rqb-col:last-child { border-right: none; }
.rqb-col-head {
  font-size: 11px; letter-spacing: .05em; text-transform: uppercase; font-weight: 700;
  color: #46586a; padding: 10px 11px; background: var(--rqb-chip);
  border-bottom: 1px solid var(--rqb-line); min-height: 40px; display: flex; align-items: center;
}
.rqb-cell {
  appearance: none; text-align: left; width: 100%; cursor: pointer; background: transparent;
  border: none; border-bottom: 1px solid var(--rqb-line); color: var(--rqb-ink);
  font: inherit; font-size: 13px; padding: 10px 11px; line-height: 1.32; position: relative;
  transition: background .12s ease, color .12s ease;
}
.rqb-col .rqb-cell:last-child { border-bottom: none; }
.rqb-cell:hover { background: var(--rqb-accent-soft); }
.rqb-cell:focus-visible { outline: 2px solid var(--rqb-accent); outline-offset: -2px; }
.rqb-cell.is-sel { background: var(--rqb-accent); color: #fff; font-weight: 600; }
.rqb-cell.is-sel::after { content: "✓"; position: absolute; right: 9px; top: 12px; font-size: 11px; opacity: .9; }
.rqb-sub { display: block; font-size: 11px; color: var(--rqb-muted); margin-top: 2px; }
.rqb-cell.is-sel .rqb-sub { color: rgba(255,255,255,.85); }

/* Message box */
.rqb-msg { margin-top: 16px; }
.rqb-msg-label { display: block; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--rqb-muted); font-weight: 700; margin-bottom: 5px; }
.rqb-msg-input {
  width: 100%; font: inherit; font-size: 13.5px; line-height: 1.5; resize: none; overflow: hidden;
  padding: 10px 12px; border-radius: 9px; border: 1px solid #c4d0da; background: #fbfcfd; color: var(--rqb-ink);
}
.rqb-msg-input:focus { outline: none; border-color: var(--rqb-accent); box-shadow: 0 0 0 3px var(--rqb-accent-soft); }
.rqb-msg-input::placeholder { color: #9aa8b4; }

/* Requester identity (real send) */
.rqb-identity { margin-top: 14px; }
.rqb-identity-row { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.rqb-text {
  flex: 1 1 180px; font: inherit; font-size: 13.5px; padding: 9px 12px; border-radius: 9px;
  border: 1px solid #c4d0da; background: #fbfcfd; color: var(--rqb-ink);
}
.rqb-text:focus { outline: none; border-color: var(--rqb-accent); box-shadow: 0 0 0 3px var(--rqb-accent-soft); }
.rqb-text::placeholder { color: #9aa8b4; }
.rqb-verify { max-width: 460px; }

/* Live request line */
.rqb-card-stage { margin-top: 16px; }
.rqb-card-empty {
  border: 1px dashed #c4d0da; border-radius: 10px; padding: 18px; text-align: center;
  color: var(--rqb-muted); font-size: 13.5px;
}
.rqb-card {
  background: #fff; border: 1px solid var(--rqb-line); border-left: 5px solid var(--rqb-accent);
  border-radius: 10px; padding: 14px 16px; box-shadow: 0 6px 20px rgba(20,40,60,.06);
}
.rqb-badge {
  display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 700;
  letter-spacing: .04em; text-transform: uppercase; padding: 3px 9px; border-radius: 999px; margin-bottom: 8px;
  background: var(--rqb-accent-soft); color: #0b5566;
}
.rqb-sentence { font-size: 15px; line-height: 1.5; margin: 0; }
:deep(.rqb-sentence b) { color: #0b5566; font-weight: 650; }

/* Actions */
.rqb-actions { display: flex; align-items: center; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
.rqb-hint { font-size: 12.5px; color: var(--rqb-muted); }

/* Response */
.rqb-response { margin-top: 14px; border-radius: 10px; padding: 14px 16px; border: 1px solid var(--rqb-line); }
.rqb-response.forward { background: #e7f4ec; border-color: rgba(21,128,61,.35); }
.rqb-response.suggest { background: #fbefdd; border-color: rgba(180,83,9,.35); }
.rqb-response.spam { background: #f1f3f5; border-color: #d5dbe0; }
.rqb-response-head { font-weight: 700; font-size: 14.5px; margin-bottom: 5px; }
.rqb-response.forward .rqb-response-head { color: #15803d; }
.rqb-response.suggest .rqb-response-head { color: #b45309; }
.rqb-response.spam .rqb-response-head { color: #6b7b8b; }
.rqb-response-body { font-size: 13.5px; line-height: 1.5; }
.rqb-speaker { margin-top: 11px; padding: 11px 13px; border-radius: 9px; background: #fff; border: 1px solid var(--rqb-line); font-size: 13px; }
.rqb-speaker-from { font-size: 10.5px; letter-spacing: .04em; text-transform: uppercase; color: var(--rqb-muted); font-weight: 700; margin-bottom: 4px; }
.rqb-speaker.ai .rqb-speaker-from { color: var(--rqb-accent); }
.rqb-emailnote { margin-top: 10px; font-size: 12px; color: var(--rqb-muted); }

@media (max-width: 640px) {
  .rqb-matrix { grid-template-columns: 1fr; }
  .rqb-col { border-right: none; border-bottom: 1px solid var(--rqb-line); }
}
</style>
