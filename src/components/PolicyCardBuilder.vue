<template>
  <div class="pcb">
    <!-- ── Selection matrix ─────────────────────────────── -->
    <div class="pcb-matrix">
      <div v-for="col in columns" :key="col.key" class="pcb-col">
        <div class="pcb-col-head">{{ col.head }}</div>
        <button
          v-for="opt in col.options"
          :key="opt.v"
          type="button"
          class="pcb-cell"
          :class="[opt.cls, { 'is-sel': sel[col.key] === opt.v }]"
          :aria-pressed="sel[col.key] === opt.v"
          @click="pick(col.key, opt.v)"
        >
          <span>{{ opt.label }}</span>
          <span v-if="opt.sub" class="pcb-sub">{{ opt.sub }}</span>
          <span
            v-if="opt.ah && sel.scope === 'ah-category'"
            class="pcb-ah"
            @click.stop
          >
            <select v-model="ahCategory" @click.stop>
              <option v-for="cat in ahCategoryList" :key="cat" :value="cat">{{ cat }}</option>
            </select>
          </span>
        </button>
      </div>
    </div>

    <!-- ── Live card ────────────────────────────────────── -->
    <div class="pcb-card-stage">
      <div v-if="!complete" class="pcb-card-empty">
        Pick one cell in every column and MAIA writes the rule here.
      </div>
      <div v-else class="pcb-card" :class="cardClass">
        <span class="pcb-badge" :class="badgeClass">● {{ badgeText }}</span>
        <p class="pcb-sentence" v-html="sentenceHtml"></p>
        <div class="pcb-meta">
          <span class="pcb-kv"><b>id</b> {{ sigLabel }}</span>
          <span class="pcb-kv"><b>scope</b> {{ sel.scope === 'ah-category' ? ahCategory : sel.scope }}</span>
          <span class="pcb-kv"><b>purpose</b> {{ sel.purpose }}</span>
          <span class="pcb-kv"><b>payment</b> {{ sel.payment }}</span>
          <span class="pcb-kv"><b>action</b> {{ sel.action }}</span>
        </div>
        <div class="pcb-card-actions">
          <q-btn
            v-if="mode === 'edit'"
            unelevated color="primary" :loading="saving"
            :label="existing ? 'Done — update this card' : 'Done — save this card'"
            @click="emitSave"
          />
          <q-btn flat color="grey-8" label="Clear" @click="clearAll" />
        </div>
      </div>
    </div>

    <!-- ── Try it ───────────────────────────────────────── -->
    <div class="pcb-tryit" :class="{ locked: !complete }">
      <div class="pcb-try-head">
        Try it <span>— see the decision this card would make</span>
      </div>
      <div class="pcb-req-grid">
        <div class="pcb-field">
          <label>Identity they present</label>
          <select v-model="req.signature">
            <option v-for="o in SIGNATURE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </div>
        <div class="pcb-field">
          <label>What they ask for</label>
          <select v-model="req.scope">
            <option v-for="o in SCOPE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </div>
        <div class="pcb-field">
          <label>Purpose they claim</label>
          <select v-model="req.purpose">
            <option v-for="o in reqPurposeOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </div>
        <div class="pcb-field">
          <label>What they offer</label>
          <select v-model="req.payment">
            <option v-for="o in PAYMENT_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </div>
      </div>
      <div class="pcb-try-actions">
        <q-btn unelevated color="primary" label="Send the request" :disable="!complete" @click="runTry" />
        <span v-if="!complete" class="pcb-hint">Finish the card above to unlock this.</span>
      </div>
      <div v-if="verdict" class="pcb-verdict" :class="verdict.cls">
        <div class="pcb-verdict-head">{{ verdict.head }}</div>
        <div class="pcb-verdict-body" v-html="verdict.body"></div>
        <div v-if="verdict.why" class="pcb-verdict-why">{{ verdict.why }}</div>
        <div v-if="verdict.speaker" class="pcb-speaker" :class="{ ai: verdict.speakerAI }">
          <div class="pcb-speaker-from">{{ verdict.speakerFrom }}</div>
          <div v-html="verdict.speaker"></div>
          <div v-if="verdict.cls === 'ask'" class="pcb-ask-choices">
            <q-btn dense unelevated color="primary" size="sm" label="Approve once" />
            <q-btn dense flat color="grey-8" size="sm" label="Ignore" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed } from 'vue';
import {
  SIGNATURE_OPTIONS, SCOPE_OPTIONS, PURPOSE_OPTIONS, PAYMENT_OPTIONS,
  sentenceFor, evaluate,
  type PolicyCard, type PolicyRequest, type Scope, type Signature, type Purpose, type Payment
} from '../utils/policyCards';

const props = withDefaults(defineProps<{
  mode?: 'demo' | 'edit';
  existing?: PolicyCard | null;
  ahCategories?: string[];
  saving?: boolean;
}>(), { mode: 'demo', existing: null, saving: false });

const emit = defineEmits<{ save: [card: PolicyCard]; cancel: [] }>();

const DEFAULT_AH = ['Lab Results', 'Clinical Vitals', 'Immunizations', 'Conditions', 'Procedures', 'Allergies'];
const ahCategoryList = computed(() => (props.ahCategories?.length ? props.ahCategories : DEFAULT_AH));
const ahCategory = ref(ahCategoryList.value[0]);

type ColKey = 'signature' | 'scope' | 'purpose' | 'payment' | 'action';
interface CellOpt { v: string; label: string; sub?: string; cls?: string; ah?: boolean }
interface Column { key: ColKey; head: string; options: CellOpt[] }

// Payment labels here follow the proposed table; the stored enum is MAIA's.
const columns: Column[] = [
  { key: 'signature', head: 'ID Strength', options: [
    { v: 'unverified', label: 'Unverified', sub: 'no identity check' },
    { v: 'verified-email', label: 'Verified email' },
    { v: 'group-member', label: 'Group member' },
    { v: 'npi', label: 'NPI verified', sub: 'licensed provider' },
    { v: 'doximity', label: 'Doximity verified', sub: 'verified clinician' },
    { v: 'verified-by-me', label: 'Verified by me', sub: 'someone you vouched for' }
  ]},
  { key: 'scope', head: 'Scope of Request', options: [
    { v: 'notification-only', label: 'Patient notification only', sub: 'reach you, no record data' },
    { v: 'meds-allergies', label: 'Current medications' },
    { v: 'patient-summary', label: 'Patient summary' },
    { v: 'not-sensitive', label: 'Everything not sensitive' },
    { v: 'everything', label: 'Everything' },
    { v: 'ah-category', label: 'Apple Health category', ah: true }
  ]},
  { key: 'purpose', head: 'Claimed Purpose', options: [
    { v: 'peer-support', label: 'Peer support' },
    { v: 'clinical', label: 'Clinical' },
    { v: 'research', label: 'Research' },
    { v: 'public-health', label: 'Public health' },
    { v: 'marketing', label: 'Marketing' }
  ]},
  { key: 'payment', head: 'Deposit or Payment', options: [
    { v: 'none', label: 'None' },
    { v: 'spam-deposit', label: 'Spam evaluation deposit', sub: 'returnable' },
    { v: 'notification-deposit', label: 'Request evaluation payment' },
    { v: 'sharing-payment', label: 'Payment for information' }
  ]},
  { key: 'action', head: 'MAIA Action', options: [
    { v: 'deny-silent', label: 'Deny silently', sub: 'requester hears nothing', cls: 'act-deny' },
    { v: 'deny-respond', label: 'Deny with response', sub: 'a reason for the decline', cls: 'act-deny' },
    { v: 'respond', label: 'Respond', sub: 'fulfil the request', cls: 'act-respond' }
  ]}
];

const sel = reactive<Record<ColKey, string | null>>({
  signature: null, scope: null, purpose: null, payment: null, action: null
});

// Prefill from an existing card (edit mode).
if (props.existing) {
  const e = props.existing.elements;
  sel.signature = e.signature;
  sel.scope = e.scope;
  sel.purpose = e.purpose === 'any' ? null : e.purpose;
  sel.payment = e.payment;
  sel.action = props.existing.outcome === 'allow'
    ? 'respond'
    : (props.existing.denyMode === 'respond' ? 'deny-respond' : 'deny-silent');
  if (e.scope === 'ah-category' && e.ahCategory) ahCategory.value = e.ahCategory;
}

const pick = (key: string, v: string) => { sel[key as ColKey] = sel[key as ColKey] === v ? null : v; };
const complete = computed(() => !!(sel.signature && sel.scope && sel.purpose && sel.payment && sel.action));

// ── Build the card object from selections ──
const builtCard = computed<PolicyCard>(() => ({
  id: props.existing?.id || 'preview',
  outcome: sel.action === 'respond' ? 'allow' : 'deny',
  ...(sel.action === 'deny-respond' ? { denyMode: 'respond' as const } : (sel.action === 'deny-silent' ? { denyMode: 'silent' as const } : {})),
  enabled: true,
  provenance: props.existing?.provenance || 'user',
  elements: {
    party: { type: 'anyone' },
    purpose: (sel.purpose || 'clinical') as Purpose,
    scope: (sel.scope || 'patient-summary') as Scope,
    ...(sel.scope === 'ah-category' ? { ahCategory: ahCategory.value } : {}),
    filtered: true,
    signature: (sel.signature || 'group-member') as Signature,
    payment: (sel.payment || 'none') as Payment
  }
}));

const sigLabel = computed(() => SIGNATURE_OPTIONS.find((o) => o.value === sel.signature)?.label || sel.signature);
const cardClass = computed(() => sel.action === 'respond' ? 'is-respond' : 'is-deny');
const badgeClass = computed(() => sel.action === 'respond' ? 'respond' : 'deny');
const badgeText = computed(() =>
  sel.action === 'respond' ? 'Respond'
  : sel.action === 'deny-respond' ? 'Deny · with reason'
  : 'Deny · silent');
const sentenceHtml = computed(() => sentenceFor(builtCard.value)
  .replace(/(Doximity-verified|NPI-verified|verified-email|group-member|verified by me)/g, '<b>$1</b>'));

const clearAll = () => {
  (Object.keys(sel) as ColKey[]).forEach((k) => { sel[k] = null; });
  verdict.value = null;
};
const emitSave = () => emit('save', builtCard.value);

// ── Try it ──
const reqPurposeOptions = PURPOSE_OPTIONS.filter((o) => o.value !== 'any');
const req = reactive<PolicyRequest>({
  party: { type: 'anyone' }, signature: 'doximity' as Signature,
  scope: 'patient-summary' as Scope, purpose: 'clinical' as Purpose, payment: 'none' as Payment
});

const SIG_RANK: Record<string, number> = { unverified: 0, 'verified-email': 1, 'group-member': 2, npi: 3, doximity: 3, 'verified-by-me': 4 };
const HUMAN_SCOPE: Record<string, string> = {
  'notification-only': 'a way to reach you', 'meds-allergies': 'your current medications & allergies',
  'patient-summary': 'your patient summary', 'not-sensitive': 'your record except sensitive categories',
  everything: 'your whole record', 'ah-category': 'an Apple Health category'
};

interface Verdict { cls: string; head: string; body: string; why?: string; speaker?: string; speakerFrom?: string; speakerAI?: boolean; }
const verdict = ref<Verdict | null>(null);

const runTry = () => {
  if (!complete.value) return;
  const reqObj: PolicyRequest = { ...req, ...(req.scope === 'ah-category' ? { ahCategory: ahCategory.value } : {}) };
  const decision = evaluate([builtCard.value], reqObj);
  const asked = HUMAN_SCOPE[req.scope] || req.scope;
  const sigLbl = SIGNATURE_OPTIONS.find((o) => o.value === req.signature)?.label || req.signature;
  const purLbl = PURPOSE_OPTIONS.find((o) => o.value === req.purpose)?.label || req.purpose;

  if (decision.outcome === 'ask') {
    const reasons: string[] = [];
    if (SIG_RANK[req.signature] < SIG_RANK[sel.signature!]) reasons.push(`identity too weak (needs ${sigLabel.value}+)`);
    if (sel.scope !== req.scope) reasons.push('different scope than the card');
    if (sel.purpose !== req.purpose) reasons.push('different purpose than the card');
    if (sel.payment !== 'none' && req.payment !== sel.payment) reasons.push('required payment not offered');
    verdict.value = {
      cls: 'ask', head: '◆ MAIA asks you',
      body: 'This request doesn’t match your card, so MAIA doesn’t decide alone — it brings it to <span class="who">you</span>.',
      why: reasons.length ? `Card didn’t apply: ${reasons.join('; ')}.` : undefined,
      speaker: `A requester presenting <b>${sigLbl}</b> wants <b>${asked}</b> for <b>${purLbl}</b>. Share it?`,
      speakerFrom: 'Notification to you'
    };
  } else if (decision.outcome === 'allow') {
    verdict.value = {
      cls: 'respond', head: '● MAIA responds',
      body: 'The request matches your <b>Respond</b> card, so your Private AI answers automatically — privacy-filtered.',
      speaker: req.scope === 'notification-only'
        ? 'Message delivered to the patient. They may reply if they choose.'
        : `Here is ${asked}, privacy-filtered per the patient’s policy. Sensitive categories are withheld.`,
      speakerFrom: 'Your Private AI → requester', speakerAI: true
    };
  } else if (sel.action === 'deny-respond') {
    verdict.value = {
      cls: 'deny', head: '● Declined with a reason',
      body: 'The request matches your <b>Deny · with reason</b> card, so your Private AI explains why it can’t be fulfilled.',
      speaker: `The patient’s policy declines ${purLbl} requests for ${asked} at your identity level. A ${sigLabel.value} identity or a different scope may be accepted.`,
      speakerFrom: 'Your Private AI → requester', speakerAI: true
    };
  } else {
    verdict.value = {
      cls: 'deny', head: '● Silently denied',
      body: 'The request matches your <b>Deny · silent</b> card. It’s dropped — the requester gets no reply and you’re not interrupted.'
    };
  }
};

defineExpose({ complete, builtCard });
</script>

<style scoped lang="scss">
.pcb {
  --pcb-accent: #0e7490;
  --pcb-accent-soft: #e2f1f4;
  --pcb-respond: #15803d;
  --pcb-deny: #b91c1c;
  --pcb-line: #dde5eb;
  --pcb-chip: #f1f5f8;
  --pcb-ink: #17222e;
  --pcb-muted: #6b7b8b;
  color: var(--pcb-ink);
  font-size: 14px;
}

/* Matrix */
.pcb-matrix {
  display: grid; grid-template-columns: repeat(5, 1fr); gap: 0;
  border: 1px solid var(--pcb-line); border-radius: 10px; overflow: hidden; background: #fff;
}
.pcb-col { border-right: 1px solid var(--pcb-line); display: flex; flex-direction: column; }
.pcb-col:last-child { border-right: none; }
.pcb-col-head {
  font-size: 11px; letter-spacing: .05em; text-transform: uppercase; font-weight: 700;
  color: #46586a; padding: 10px 11px; background: var(--pcb-chip);
  border-bottom: 1px solid var(--pcb-line); min-height: 54px; display: flex; align-items: center;
}
.pcb-cell {
  appearance: none; text-align: left; width: 100%; cursor: pointer; background: transparent;
  border: none; border-bottom: 1px solid var(--pcb-line); color: var(--pcb-ink);
  font: inherit; font-size: 13px; padding: 10px 11px; line-height: 1.32; position: relative;
  transition: background .12s ease, color .12s ease;
}
.pcb-col .pcb-cell:last-child { border-bottom: none; }
.pcb-cell:hover { background: var(--pcb-accent-soft); }
.pcb-cell:focus-visible { outline: 2px solid var(--pcb-accent); outline-offset: -2px; }
.pcb-cell.is-sel { background: var(--pcb-accent); color: #fff; font-weight: 600; }
.pcb-cell.is-sel::after { content: "✓"; position: absolute; right: 9px; top: 12px; font-size: 11px; opacity: .9; }
.pcb-cell.act-respond.is-sel { background: var(--pcb-respond); }
.pcb-cell.act-deny.is-sel { background: var(--pcb-deny); }
.pcb-sub { display: block; font-size: 11px; color: var(--pcb-muted); margin-top: 2px; }
.pcb-cell.is-sel .pcb-sub { color: rgba(255,255,255,.85); }
.pcb-ah { display: block; margin-top: 6px; }
.pcb-ah select { width: 100%; font: inherit; font-size: 12px; padding: 4px 5px; border-radius: 6px; border: 1px solid #c4d0da; background: #fff; color: var(--pcb-ink); }

/* Card */
.pcb-card-stage { margin-top: 16px; }
.pcb-card-empty {
  border: 1px dashed #c4d0da; border-radius: 10px; padding: 22px; text-align: center;
  color: var(--pcb-muted); font-size: 13.5px;
}
.pcb-card {
  background: #fff; border: 1px solid var(--pcb-line); border-left: 5px solid var(--pcb-accent);
  border-radius: 10px; padding: 16px 18px; box-shadow: 0 6px 20px rgba(20,40,60,.06);
}
.pcb-card.is-respond { border-left-color: var(--pcb-respond); }
.pcb-card.is-deny { border-left-color: var(--pcb-deny); }
.pcb-badge {
  display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 700;
  letter-spacing: .04em; text-transform: uppercase; padding: 3px 9px; border-radius: 999px; margin-bottom: 9px;
}
.pcb-badge.respond { background: #e7f4ec; color: var(--pcb-respond); }
.pcb-badge.deny { background: #fbe9e9; color: var(--pcb-deny); }
.pcb-sentence { font-size: 15.5px; line-height: 1.5; margin: 0 0 12px; }
:deep(.pcb-sentence b) { color: #0b5566; font-weight: 650; }
.pcb-meta { display: flex; flex-wrap: wrap; gap: 6px; font-family: ui-monospace, Menlo, monospace; font-size: 11px; padding-top: 11px; border-top: 1px solid var(--pcb-line); }
.pcb-kv { background: var(--pcb-chip); border-radius: 6px; padding: 2px 7px; color: #46586a; }
.pcb-kv b { color: var(--pcb-ink); font-weight: 600; }
.pcb-card-actions { display: flex; gap: 8px; margin-top: 14px; }

/* Try it */
.pcb-tryit { margin-top: 22px; background: #fff; border: 1px solid var(--pcb-line); border-radius: 10px; padding: 16px 18px; }
.pcb-tryit.locked { opacity: .55; }
.pcb-tryit.locked .pcb-req-grid { pointer-events: none; }
.pcb-try-head { font-weight: 650; font-size: 15px; margin-bottom: 12px; }
.pcb-try-head span { color: var(--pcb-muted); font-weight: 400; font-size: 13px; }
.pcb-req-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 11px 16px; }
.pcb-field label { display: block; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--pcb-muted); font-weight: 700; margin-bottom: 4px; }
.pcb-field select { width: 100%; font: inherit; font-size: 13px; padding: 7px 8px; border-radius: 7px; border: 1px solid #c4d0da; background: #fbfcfd; color: var(--pcb-ink); }
.pcb-try-actions { display: flex; align-items: center; gap: 10px; margin-top: 13px; }
.pcb-hint { font-size: 12.5px; color: var(--pcb-muted); }

.pcb-verdict { margin-top: 14px; border-radius: 10px; padding: 14px 16px; border: 1px solid var(--pcb-line); }
.pcb-verdict.respond { background: #e7f4ec; border-color: rgba(21,128,61,.35); }
.pcb-verdict.ask { background: #fbefdd; border-color: rgba(180,83,9,.35); }
.pcb-verdict.deny { background: #fbe9e9; border-color: rgba(185,28,28,.35); }
.pcb-verdict-head { font-weight: 700; font-size: 14.5px; margin-bottom: 5px; }
.pcb-verdict.respond .pcb-verdict-head { color: var(--pcb-respond); }
.pcb-verdict.ask .pcb-verdict-head { color: #b45309; }
.pcb-verdict.deny .pcb-verdict-head { color: var(--pcb-deny); }
.pcb-verdict-body { font-size: 13.5px; line-height: 1.5; }
:deep(.pcb-verdict-body .who) { color: #46586a; }
.pcb-verdict-why { margin-top: 6px; font-size: 12px; color: var(--pcb-muted); }
.pcb-speaker { margin-top: 11px; padding: 11px 13px; border-radius: 9px; background: #fff; border: 1px solid var(--pcb-line); font-size: 13px; }
.pcb-speaker-from { font-size: 10.5px; letter-spacing: .04em; text-transform: uppercase; color: var(--pcb-muted); font-weight: 700; margin-bottom: 4px; }
.pcb-speaker.ai .pcb-speaker-from { color: var(--pcb-accent); }
.pcb-ask-choices { display: flex; gap: 7px; margin-top: 9px; }

@media (max-width: 640px) {
  .pcb-matrix { grid-template-columns: 1fr; }
  .pcb-col { border-right: none; border-bottom: 1px solid var(--pcb-line); }
  .pcb-req-grid { grid-template-columns: 1fr; }
}
</style>
