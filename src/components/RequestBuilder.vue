<template>
  <div class="rqb">
    <!-- ── Request matrix: the ONE policy table (PolicyMatrix), request
         context. Cells that don't apply to an outside requester are shown
         but disabled — the tooltips teach the whole vocabulary either way. -->
    <PolicyMatrix context="request" :model-value="sel" @pick="pick" />

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

    <!-- ── Ask the group's AI (Policy Assist Phase 2) ────── -->
    <!-- Public advisor on the registry host: it knows ONLY what the join
         page publishes (posting policy + suggested cards + mechanics) —
         never any member's actual policies, records, or history. Gated
         behind the same verified email the real send requires. -->
    <div v-if="props.group" class="rqb-advisor">
      <div class="rqb-advisor-head">Ask the {{ props.group.name }} group’s AI how to request</div>
      <div v-if="!verifiedEmail.verified" class="rqb-hint q-mt-xs">
        Verify your email above first — the advisor (like the request itself) needs it.
      </div>
      <template v-else>
        <div v-for="(am, ai) in advisorMessages" :key="ai" class="rqb-advisor-msg" :class="am.role">
          <div class="rqb-advisor-from">{{ am.role === 'user' ? 'You' : `${props.group.name} advisor` }}</div>
          <div style="white-space: pre-wrap; word-break: break-word;">{{ am.content }}</div>
          <div v-if="am.suggestion" class="rqb-advisor-suggestion">
            <span>Suggested request: <b>{{ suggestionLabel(am.suggestion) }}</b></span>
            <q-btn dense size="sm" outline color="primary" label="Apply to the table" @click="applySuggestion(am.suggestion)" />
          </div>
        </div>
        <div class="row q-gutter-sm items-center q-mt-sm no-wrap">
          <input
            v-model="advisorInput"
            class="rqb-text col"
            type="text"
            placeholder="e.g. What’s the fastest way to see a member’s medications for a consult?"
            :disabled="advisorLoading"
            @keyup.enter="sendAdvisorMessage"
          />
          <q-btn dense unelevated color="primary" label="Ask" :loading="advisorLoading" :disable="!advisorInput.trim()" @click="sendAdvisorMessage" />
        </div>
        <div v-if="advisorError" class="text-negative q-mt-xs" style="font-size: 12.5px;">{{ advisorError }}</div>
        <div class="rqb-advisor-note">
          The advisor knows only the group’s public policies — never any member’s
          records, personal settings, or what a specific member will answer.
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, nextTick, onUnmounted } from 'vue';
import { useQuasar } from 'quasar';
import { useVerifiedEmail } from '../composables/verifiedEmail';
import EmailVerifyBox from './EmailVerifyBox.vue';
import PolicyMatrix from './PolicyMatrix.vue';

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

// The visitor's selections. The matrix itself comes from POLICY_MATRIX
// (PolicyMatrix.vue, context "request") — the identical table every other
// surface shows, with requester-inapplicable cells disabled.
type ColKey = 'signature' | 'scope' | 'purpose' | 'payment';

const sel = reactive<Record<ColKey, string | null>>({
  signature: null, scope: null, purpose: null, payment: null
});
const message = ref('');
const msgEl = ref<HTMLTextAreaElement | null>(null);

const pick = (key: string, v: string) => {
  if (!(key in sel)) return; // action column is disabled in request context
  const k = key as ColKey;
  sel[k] = sel[k] === v ? null : v;
};

// ── Group advisor (Policy Assist Phase 2) ────────────────────────────
interface AdvisorSuggestion { scope: string; purpose: string; message?: string }
interface AdvisorMessage { role: 'user' | 'assistant'; content: string; suggestion?: AdvisorSuggestion }
const advisorMessages = ref<AdvisorMessage[]>([]);
const advisorInput = ref('');
const advisorLoading = ref(false);
const advisorError = ref('');

const SUGGESTION_SCOPES = ['notification-only', 'meds-allergies', 'patient-summary', 'not-sensitive', 'everything'];
const SUGGESTION_PURPOSES = ['peer-support', 'clinical', 'research', 'public-health', 'marketing'];

const suggestionLabel = (s: AdvisorSuggestion): string =>
  `${SCOPE_HUMAN[s.scope] || s.scope} for ${PURPOSE_HUMAN[s.purpose] || s.purpose}`;

/** Pull a ```request-suggestion fence out of the advisor's reply. */
const extractSuggestion = (text: string): { content: string; suggestion?: AdvisorSuggestion } => {
  const m = /```request-suggestion\s*\n([\s\S]*?)```/.exec(text);
  if (!m) return { content: text.trim() };
  try {
    const parsed = JSON.parse(m[1]);
    if (SUGGESTION_SCOPES.includes(parsed.scope) && SUGGESTION_PURPOSES.includes(parsed.purpose)) {
      return {
        content: text.replace(/```request-suggestion\s*\n[\s\S]*?```/g, '').replace(/\n{3,}/g, '\n\n').trim(),
        suggestion: {
          scope: parsed.scope,
          purpose: parsed.purpose,
          message: typeof parsed.message === 'string' ? parsed.message.slice(0, 500) : undefined
        }
      };
    }
  } catch { /* fence wasn't valid JSON — leave it visible */ }
  return { content: text.trim() };
};

/** Fill the request table from the advisor's suggestion — the visitor still
 *  previews and sends it themselves. */
const applySuggestion = (s: AdvisorSuggestion) => {
  sel.scope = s.scope;
  sel.purpose = s.purpose;
  sel.signature = 'verified-email'; // the only level a visitor can actually prove
  if (!sel.payment) sel.payment = 'none';
  if (s.message) {
    message.value = s.message;
    void nextTick(autoGrow);
  }
  $q.notify({ type: 'positive', message: 'Applied — review the table above, then preview or send.' });
};

const sendAdvisorMessage = async () => {
  const text = advisorInput.value.trim();
  if (!text || advisorLoading.value || !props.group) return;
  advisorError.value = '';
  advisorMessages.value.push({ role: 'user', content: text });
  advisorInput.value = '';
  advisorLoading.value = true;
  try {
    const res = await fetch(`/api/groups/${encodeURIComponent(props.group.groupId)}/advisor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        messages: advisorMessages.value.map((m) => ({ role: m.role, content: m.content })),
        email: verifiedEmail.email,
        emailVerifyToken: verifiedEmail.token || undefined
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      throw new Error(data.error === 'RATE_LIMITED'
        ? 'Too many questions for now — try again in a few minutes.'
        : data.error === 'EMAIL_NOT_VERIFIED'
          ? 'Verify your email above first.'
          : (data.error || `HTTP ${res.status}`));
    }
    const { content, suggestion } = extractSuggestion(String(data.reply || ''));
    advisorMessages.value.push({ role: 'assistant', content: content || '(no reply)', suggestion });
  } catch (err) {
    advisorError.value = err instanceof Error ? err.message : 'The advisor is unavailable — try again shortly.';
    advisorMessages.value.pop(); // let the user re-send their question
    advisorInput.value = text;
  } finally {
    advisorLoading.value = false;
  }
};
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
        purpose: sel.purpose,
        // Lets the registry prove 'verified-email' when evaluating the
        // members' policies at delivery time (autonomous demo responses).
        emailVerifyToken: verifiedEmail.token || undefined
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

/* Group advisor (Phase 2) */
.rqb-advisor { margin-top: 22px; background: #fff; border: 1px solid var(--rqb-line); border-radius: 10px; padding: 14px 16px; }
.rqb-advisor-head { font-weight: 650; font-size: 15px; margin-bottom: 6px; }
.rqb-advisor-msg { margin-top: 10px; padding: 9px 12px; border-radius: 9px; border: 1px solid var(--rqb-line); font-size: 13px; background: #fbfcfd; }
.rqb-advisor-msg.assistant { background: #f0f7f9; border-color: #cfe3e9; }
.rqb-advisor-from { font-size: 10.5px; letter-spacing: .04em; text-transform: uppercase; color: var(--rqb-muted); font-weight: 700; margin-bottom: 3px; }
.rqb-advisor-suggestion { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px; padding: 7px 9px; border-radius: 7px; background: #fff; border: 1px dashed #9fc1cc; font-size: 12.5px; }
.rqb-advisor-note { margin-top: 8px; font-size: 11.5px; color: var(--rqb-muted); }

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

</style>
