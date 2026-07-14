<template>
  <div class="q-pa-md" style="max-width: 860px">
    <div class="text-h6 q-mb-xs">Sharing Policies</div>

    <!-- The default mental model, stated up front -->
    <q-banner dense rounded class="bg-blue-1 text-blue-10 q-mb-md">
      <template #avatar><q-icon name="shield" color="blue-8" /></template>
      MAIA asks you about everything unless you've told it otherwise.
      Policies are answers MAIA remembers: an <strong>allow</strong> card lets a
      matching request through automatically, a <strong>deny</strong> card drops it
      silently, and anything with no matching card comes to you as a question.
    </q-banner>

    <!-- Try it: examples teach, rules don't -->
    <q-expansion-item icon="science" label="Try it — test a hypothetical request" class="q-mb-md" header-class="text-primary">
      <div class="q-pa-sm" style="border: 1px solid #e0e0e0; border-radius: 8px">
        <div class="row q-col-gutter-sm">
          <q-select v-model="sim.partyKind" :options="simPartyOptions" emit-value map-options dense outlined label="Requesting party" class="col-6" />
          <q-select v-model="sim.signature" :options="SIGNATURE_OPTIONS" emit-value map-options dense outlined label="Identity presented" class="col-6" />
          <q-select v-model="sim.purpose" :options="PURPOSE_OPTIONS" emit-value map-options dense outlined label="Purpose" class="col-6" />
          <q-select v-model="sim.scope" :options="SCOPE_OPTIONS" emit-value map-options dense outlined label="Scope requested" class="col-6" />
          <q-select v-model="sim.payment" :options="PAYMENT_OPTIONS" emit-value map-options dense outlined label="Payment offered" class="col-6" />
        </div>
        <div class="q-mt-sm row items-center q-gutter-sm">
          <q-badge :color="simResult.outcome === 'allow' ? 'green' : simResult.outcome === 'deny' ? 'negative' : 'orange'"
                   :label="simResult.outcome === 'ask' ? 'ASK ME' : simResult.outcome.toUpperCase()" />
          <span class="text-caption text-grey-8">
            <template v-if="simResult.decidedBy">decided by: “{{ sentenceFor(simResult.decidedBy) }}”</template>
            <template v-else>no card matches — MAIA would ask you</template>
          </span>
        </div>
      </div>
    </q-expansion-item>

    <div class="row items-center q-mb-sm">
      <div class="text-subtitle2">Your policy cards</div>
      <q-space />
      <q-btn dense unelevated color="primary" icon="add" label="New policy" @click="openEditor(null)" />
    </div>

    <div v-if="loading" class="text-center q-pa-md"><q-spinner size="1.5em" /></div>
    <div v-else-if="!policies.length" class="text-caption text-grey-7 q-mb-md">
      No policies yet — every request comes to you as a question, which is a
      perfectly good way to run. Cards get useful when the questions repeat:
      you can also create one directly from a request in your Groups inbox.
    </div>

    <template v-for="section in sections" :key="section.key">
      <div v-if="section.cards.length" class="q-mb-md">
        <div class="text-caption text-grey-7 q-mb-xs">
          {{ section.label }}
        </div>
        <div v-for="card in section.cards" :key="card.id" class="policy-card" :class="card.outcome === 'deny' ? 'policy-card--deny' : 'policy-card--allow'">
          <div class="row items-start no-wrap q-gutter-sm">
            <q-badge :color="card.outcome === 'deny' ? 'negative' : 'green'" :label="card.outcome" class="q-mt-xs" />
            <div class="col text-body2" :class="{ 'text-grey-5': card.enabled === false }" style="min-width: 0">
              {{ sentenceFor(card) }}
              <span v-if="card.createdFrom === 'request'" class="text-caption text-grey-6">(from a request you answered)</span>
            </div>
            <div class="row no-wrap items-center" style="flex: 0 0 auto">
              <q-toggle :model-value="card.enabled !== false" dense size="sm" @update:model-value="(v: boolean) => toggleCard(card, v)">
                <q-tooltip>{{ card.enabled !== false ? 'On — participates in decisions' : 'Off — kept but ignored' }}</q-tooltip>
              </q-toggle>
              <q-btn flat dense round size="sm" icon="edit" @click="openEditor(card)" />
              <q-btn flat dense round size="sm" icon="delete" color="negative" @click="confirmDelete(card)" />
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- Editor: the sentence IS the policy; chips fill the slots -->
    <q-dialog v-model="showEditor">
      <q-card style="min-width: 520px; max-width: 680px">
        <q-card-section>
          <div class="text-h6">{{ editingId ? 'Edit policy' : 'New policy' }}</div>
          <div class="q-mt-sm q-pa-sm" style="background: #f5f5f5; border-radius: 8px">
            <span class="text-body2">{{ previewSentence }}</span>
          </div>
        </q-card-section>
        <q-card-section class="q-pt-none">
          <div class="row q-col-gutter-sm">
            <q-select v-model="form.outcome" :options="[{value:'allow',label:'Allow automatically'},{value:'deny',label:'Deny silently'}]" emit-value map-options dense outlined label="Decision" class="col-6" />
            <q-select v-model="form.partyKind" :options="editorPartyOptions" emit-value map-options dense outlined label="Requesting party" class="col-6" />
            <q-select v-model="form.signature" :options="SIGNATURE_OPTIONS" emit-value map-options dense outlined label="Minimum identity" class="col-6" />
            <q-select v-model="form.purpose" :options="PURPOSE_OPTIONS" emit-value map-options dense outlined label="Purpose" class="col-6" />
            <q-select v-model="form.scope" :options="SCOPE_OPTIONS" emit-value map-options dense outlined label="Scope" class="col-6" />
            <q-input v-if="form.scope === 'past-months'" v-model.number="form.scopeMonths" type="number" dense outlined label="Months" class="col-3" />
            <q-input v-if="form.scope === 'apple-health-category'" v-model="form.scopeCategory" dense outlined label="Apple Health category" class="col-6" />
            <q-select v-model="form.payment" :options="PAYMENT_OPTIONS" emit-value map-options dense outlined label="Required payment" class="col-6" />
            <div class="col-6 row items-center">
              <q-toggle v-model="form.filtered" dense label="Privacy-filtered response" />
            </div>
          </div>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="Cancel" v-close-popup :disable="saving" />
          <q-btn unelevated color="primary" :label="editingId ? 'Save' : 'Create'" :loading="saving" @click="saveCard" />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import {
  sentenceFor, evaluate,
  PURPOSE_OPTIONS, SCOPE_OPTIONS, SIGNATURE_OPTIONS, PAYMENT_OPTIONS,
  type PolicyCard, type PolicyRequest, type Purpose, type Scope, type Signature, type Payment
} from '../utils/policyCards';

const $q = useQuasar();
const props = defineProps<{ userId: string }>();

const policies = ref<PolicyCard[]>([]);
const loading = ref(false);
const memberships = ref<Array<{ groupId: string; groupName: string }>>([]);

// ── Sections: group-suggested first (badged), then the user's own ──
const sections = computed(() => {
  const groups = new Map<string, PolicyCard[]>();
  const own: PolicyCard[] = [];
  for (const c of policies.value) {
    if (c.provenance?.startsWith('group:')) {
      const k = c.provenance;
      groups.set(k, [...(groups.get(k) || []), c]);
    } else own.push(c);
  }
  const out: Array<{ key: string; label: string; cards: PolicyCard[] }> = [];
  for (const [k, cards] of groups) {
    const gid = k.slice(6);
    const name = memberships.value.find((m) => m.groupId === gid)?.groupName || gid;
    out.push({ key: k, label: `Suggested by ${name} — yours to keep, change, or turn off`, cards });
  }
  out.push({ key: 'user', label: 'Your policies', cards: own });
  return out;
});

// ── Simulator ───────────────────────────────────────────────────────
const sim = ref<{ partyKind: string; purpose: Purpose; scope: Scope; signature: Signature; payment: Payment }>({
  partyKind: 'anyone', purpose: 'clinical', scope: 'patient-summary', signature: 'unverified', payment: 'none'
});
const simPartyOptions = computed(() => [
  { value: 'anyone', label: 'A stranger (not in your groups)' },
  ...memberships.value.map((m) => ({ value: `group:${m.groupId}`, label: `A member of ${m.groupName}` }))
]);
const editorPartyOptions = computed(() => [
  { value: 'anyone', label: 'Anyone' },
  ...memberships.value.map((m) => ({ value: `group:${m.groupId}`, label: `Anyone in ${m.groupName}` }))
]);
const toRequest = (partyKind: string, purpose: Purpose, scope: Scope, signature: Signature, payment: Payment): PolicyRequest => ({
  party: partyKind.startsWith('group:') ? { type: 'group', groupId: partyKind.slice(6) } : { type: 'anyone' },
  purpose, scope, signature, payment
});
const simResult = computed(() =>
  evaluate(policies.value, toRequest(sim.value.partyKind, sim.value.purpose, sim.value.scope, sim.value.signature, sim.value.payment))
);

// ── Editor ──────────────────────────────────────────────────────────
const showEditor = ref(false);
const editingId = ref<string | null>(null);
const saving = ref(false);
const form = ref({
  outcome: 'allow' as 'allow' | 'deny',
  partyKind: 'anyone',
  purpose: 'clinical' as Purpose,
  scope: 'patient-summary' as Scope,
  scopeMonths: 12,
  scopeCategory: '',
  filtered: true,
  signature: 'group-member' as Signature,
  payment: 'none' as Payment
});

const formToCard = (): PolicyCard => {
  const gid = form.value.partyKind.startsWith('group:') ? form.value.partyKind.slice(6) : null;
  return {
    id: editingId.value || 'preview',
    outcome: form.value.outcome,
    enabled: true,
    provenance: 'user',
    elements: {
      party: gid
        ? { type: 'group', groupId: gid, groupName: memberships.value.find((m) => m.groupId === gid)?.groupName || gid }
        : { type: 'anyone' },
      purpose: form.value.purpose,
      scope: form.value.scope,
      ...(form.value.scope === 'past-months' ? { scopeMonths: form.value.scopeMonths } : {}),
      ...(form.value.scope === 'apple-health-category' ? { scopeCategory: form.value.scopeCategory } : {}),
      filtered: form.value.filtered,
      signature: form.value.signature,
      payment: form.value.payment
    }
  };
};
const previewSentence = computed(() => sentenceFor(formToCard()));

const openEditor = (card: PolicyCard | null) => {
  if (card) {
    editingId.value = card.id;
    const e = card.elements;
    form.value = {
      outcome: card.outcome,
      partyKind: e.party.type === 'group' ? `group:${e.party.groupId}` : 'anyone',
      purpose: e.purpose,
      scope: e.scope,
      scopeMonths: e.scopeMonths || 12,
      scopeCategory: e.scopeCategory || '',
      filtered: e.filtered !== false,
      signature: e.signature,
      payment: e.payment
    };
  } else {
    editingId.value = null;
  }
  showEditor.value = true;
};

// ── CRUD ────────────────────────────────────────────────────────────
const loadAll = async () => {
  loading.value = true;
  try {
    const [pRes, gRes] = await Promise.all([
      fetch(`/api/user-policies?userId=${encodeURIComponent(props.userId)}`, { credentials: 'include' }),
      fetch(`/api/user-groups?userId=${encodeURIComponent(props.userId)}`, { credentials: 'include' })
    ]);
    const pData = await pRes.json();
    if (pRes.ok && pData.success) policies.value = pData.policies || [];
    const gData = await gRes.json();
    if (gRes.ok && gData.success) {
      memberships.value = (gData.memberships || []).map((m: { groupId: string; groupName: string }) => ({ groupId: m.groupId, groupName: m.groupName }));
    }
  } catch { /* empty panel */ } finally {
    loading.value = false;
  }
};

const saveCard = async () => {
  saving.value = true;
  try {
    const card = formToCard();
    const url = editingId.value ? `/api/user-policies/${encodeURIComponent(editingId.value)}` : '/api/user-policies';
    const res = await fetch(url, {
      method: editingId.value ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId: props.userId, policy: card })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    showEditor.value = false;
    await loadAll();
    $q.notify({ type: 'positive', message: editingId.value ? 'Policy updated.' : 'Policy created.' });
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to save policy' });
  } finally {
    saving.value = false;
  }
};

const toggleCard = async (card: PolicyCard, enabled: boolean) => {
  try {
    const res = await fetch(`/api/user-policies/${encodeURIComponent(card.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId: props.userId, policy: { ...card, enabled } })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    await loadAll();
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to update policy' });
  }
};

const confirmDelete = (card: PolicyCard) => {
  $q.dialog({
    title: 'Delete this policy?',
    message: `“${sentenceFor(card)}” — requests it covered will come back to you as questions.`,
    ok: { label: 'Delete', color: 'negative' },
    cancel: { label: 'Keep', flat: true }
  }).onOk(async () => {
    try {
      const res = await fetch(`/api/user-policies/${encodeURIComponent(card.id)}?userId=${encodeURIComponent(props.userId)}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      await loadAll();
      $q.notify({ type: 'positive', message: 'Policy deleted.' });
    } catch (err) {
      $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to delete policy' });
    }
  });
};

onMounted(loadAll);
</script>

<style scoped lang="scss">
.policy-card {
  border: 1px solid #e0e0e0;
  border-left-width: 4px;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;

  &--allow { border-left-color: #4caf50; }
  &--deny { border-left-color: #ef5350; }
}
</style>
