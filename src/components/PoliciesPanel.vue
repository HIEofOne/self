<template>
  <div class="q-pa-md" style="max-width: 860px">
    <div class="text-h6 q-mb-xs">Sharing Policies</div>

    <!-- A new member's landing: the wizard sends users with a captured
         invite/join link HERE, so joining and reviewing the group's
         suggested policies are one screen. Joining imports the group's
         suggestions as the user's own cards — reload to show them. -->
    <PendingJoinCard
      class="q-mb-md"
      :user-id="props.userId"
      :memberships="memberships"
      @joined="handleJoined"
      @requested="loadAll"
      @policies-changed="loadAll"
      @pending-info="pendingGroup = $event"
    />

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

    <!-- Display name: member-signed rename, no leave-and-rejoin -->
    <q-separator class="q-my-md" />
    <div class="text-subtitle2 q-mb-xs">Your display name</div>
    <div v-for="m in memberships" :key="`alias:${m.groupId}`" class="row items-center q-col-gutter-sm q-mb-xs">
      <div class="col-3 text-body2 ellipsis">{{ m.groupName }}</div>
      <div class="col">
        <q-input
          v-model="m.alias"
          dense outlined
          label="Your display name in this group"
          maxlength="40"
          :disable="aliasSaving === m.groupId"
          @blur="saveAlias(m)"
          @keydown.enter.prevent="saveAlias(m)"
        />
      </div>
    </div>
    <div v-if="memberships.length" class="text-caption text-grey-7 q-mb-md">
      Members see the new name on your future messages and in the mentor
      list; messages they already received may keep the old name.
    </div>

    <!-- Group messages: the "Everyone" switch (delivery-level muting;
         may become a policy card with finer muting later) -->
    <q-separator class="q-my-md" />
    <div class="text-subtitle2 q-mb-xs">Group messages</div>
    <div v-for="m in memberships" :key="`bcast:${m.groupId}`" class="q-mb-xs">
      <q-toggle
        :model-value="m.broadcastMessages"
        :label="`Everyone in the group messages — ${m.groupName}`"
        :disable="prefSaving === m.groupId"
        @update:model-value="(v: boolean) => saveMessagePrefs(m, v)"
      />
    </div>
    <div v-if="pendingGroupNotMember" class="q-mb-xs">
      <q-toggle
        :model-value="true"
        disable
        :label="`Everyone in the group messages — ${pendingGroupNotMember.groupName}`"
      />
      <span class="text-caption text-grey-6 q-ml-sm">on by default — available after you join</span>
    </div>
    <div class="text-caption text-grey-7 q-mb-md">
      On (the default), group-wide "Everyone" messages reach you like any
      other message. Off, they are never even delivered to you.
    </div>

    <!-- Mentors: member self-opt-in to the public directory -->
    <q-separator class="q-my-md" />
    <div class="text-subtitle2 q-mb-xs">Mentors</div>
    <div class="text-caption text-grey-7 q-mb-sm">
      Mentors are listed publicly and accept peer messages without prior
      approval.
    </div>
    <div v-if="!memberships.length" class="text-caption text-grey-6 q-mb-md">
      Join a group to offer yourself as a mentor.
    </div>
    <div v-if="pendingGroupNotMember" class="row items-center q-col-gutter-sm q-mb-xs">
      <div class="col-3 text-body2 ellipsis">{{ pendingGroupNotMember.groupName }}</div>
      <div class="col-auto">
        <q-toggle :model-value="false" disable label="Mentor" />
      </div>
      <div class="col">
        <q-input model-value="" dense outlined disable label="Tag the name with:" placeholder="available after you join" />
      </div>
    </div>
    <div v-for="m in memberships" :key="`mentor:${m.groupId}`" class="row items-center q-col-gutter-sm q-mb-xs">
      <div class="col-3 text-body2 ellipsis">{{ m.groupName }}</div>
      <div class="col-auto">
        <q-toggle
          :model-value="m.mentor"
          label="Mentor"
          :disable="mentorSaving === m.groupId"
          @update:model-value="(v: boolean) => saveMentor(m, v, m.mentorTag)"
        />
      </div>
      <div class="col">
        <q-input
          v-model="m.mentorTag"
          dense outlined
          label="Tag the name with:"
          placeholder="e.g. IBD parent · 10 years"
          :disable="!m.mentor || mentorSaving === m.groupId"
          maxlength="60"
          @blur="saveMentor(m, m.mentor, m.mentorTag)"
          @keydown.enter.prevent="saveMentor(m, m.mentor, m.mentorTag)"
        />
      </div>
    </div>

    <!-- Editor: the sentence IS the policy; chips fill the slots -->
    <q-dialog v-model="showEditor">
      <q-card style="min-width: 720px; max-width: 940px">
        <q-card-section class="row items-center q-pb-none">
          <div class="text-h6">{{ editingId ? 'Edit policy' : 'New policy' }}</div>
          <q-space />
          <q-btn flat round dense icon="close" v-close-popup :disable="saving" />
        </q-card-section>
        <q-card-section>
          <div class="text-caption text-grey-7 q-mb-md">
            Pick one cell in each column. MAIA writes the rule below — then try it against a pretend request before you save.
          </div>
          <PolicyCardBuilder
            :key="editorKey"
            mode="edit"
            :existing="editingCard"
            :saving="saving"
            @save="onBuilderSave"
          />
        </q-card-section>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import PendingJoinCard from './PendingJoinCard.vue';
import PolicyCardBuilder from './PolicyCardBuilder.vue';
import { useQuasar } from 'quasar';
import {
  sentenceFor, evaluate,
  PURPOSE_OPTIONS, SCOPE_OPTIONS, SIGNATURE_OPTIONS, PAYMENT_OPTIONS,
  type PolicyCard, type PolicyRequest, type Purpose, type Scope, type Signature, type Payment
} from '../utils/policyCards';

const $q = useQuasar();
const props = defineProps<{ userId: string }>();
const emit = defineEmits<{ 'group-joined': [] }>();

// The card being edited, handed to the builder to prefill its matrix.
const editingCard = ref<PolicyCard | null>(null);
// Bumped on each open so the builder remounts with fresh state.
const editorKey = ref(0);
const onBuilderSave = (card: PolicyCard) => { saveBuiltCard(card); };

/** The group a pending invite/join link points at (from PendingJoinCard).
 *  Its per-group switches render DISABLED before the join, so the user
 *  sees every election on one screen before committing. */
const pendingGroup = ref<{ groupId: string; groupName: string } | null>(null);
const pendingGroupNotMember = computed(() =>
  pendingGroup.value && !memberships.value.some((m) => m.groupId === pendingGroup.value?.groupId)
    ? pendingGroup.value
    : null
);

/** Joined from this tab: refresh the list (imported cards keep any
 *  pre-join edits) and tell the app — it suspends the setup wizard and
 *  shows the "Close the Workbook to chat" prompt. */
const handleJoined = () => {
  void loadAll();
  emit('group-joined');
};

const policies = ref<PolicyCard[]>([]);
const loading = ref(false);
const memberships = ref<Array<{ groupId: string; groupName: string; alias: string; mentor: boolean; mentorTag: string; broadcastMessages: boolean }>>([]);

// ── Display-name change (member-signed; no leave-and-rejoin) ────────
const aliasSaving = ref<string | null>(null);
const aliasSaved = ref<Record<string, string>>({});
const saveAlias = async (m: { groupId: string; groupName: string; alias: string }) => {
  const clean = (m.alias || '').trim();
  if (!clean || aliasSaved.value[m.groupId] === clean) { m.alias = aliasSaved.value[m.groupId] || clean; return; }
  aliasSaving.value = m.groupId;
  try {
    const res = await fetch('/api/user-groups/alias', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId: props.userId, groupId: m.groupId, alias: clean })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    m.alias = data.alias;
    aliasSaved.value[m.groupId] = data.alias;
    $q.notify({ type: 'positive', message: `You're now "${data.alias}" in ${m.groupName}.` });
  } catch (err) {
    m.alias = aliasSaved.value[m.groupId] || m.alias;
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to change display name' });
  } finally {
    aliasSaving.value = null;
  }
};

// ── "Everyone in the group messages" switch (default ON) ────────────
const prefSaving = ref<string | null>(null);
const saveMessagePrefs = async (m: { groupId: string; groupName: string; broadcastMessages: boolean }, everyone: boolean) => {
  prefSaving.value = m.groupId;
  try {
    const res = await fetch('/api/user-groups/message-prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId: props.userId, groupId: m.groupId, everyone })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    m.broadcastMessages = data.everyone;
    $q.notify({
      type: 'positive',
      message: data.everyone
        ? `Everyone messages from ${m.groupName} are on.`
        : `Everyone messages from ${m.groupName} are muted — they won't be delivered to you.`
    });
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to update message preferences' });
  } finally {
    prefSaving.value = null;
  }
};

// ── Mentor self-opt-in (listed publicly; accepts peer messages) ─────
const mentorSaving = ref<string | null>(null);
const mentorSaved = ref<Record<string, string>>({}); // groupId → last saved "<mentor>|<tag>"
const saveMentor = async (m: { groupId: string; groupName: string; mentor: boolean; mentorTag: string }, mentor: boolean, tag: string) => {
  const key = `${mentor}|${(tag || '').trim()}`;
  if (mentorSaved.value[m.groupId] === key) { m.mentor = mentor; return; }
  mentorSaving.value = m.groupId;
  try {
    const res = await fetch('/api/user-groups/mentor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId: props.userId, groupId: m.groupId, mentor, tag })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    m.mentor = data.mentor;
    m.mentorTag = data.tag;
    mentorSaved.value[m.groupId] = `${data.mentor}|${data.tag}`;
    $q.notify({
      type: 'positive',
      message: data.mentor
        ? `You're listed as a mentor in ${m.groupName}.`
        : `You're no longer listed as a mentor in ${m.groupName}.`
    });
  } catch (err) {
    m.mentor = !mentor; // revert the toggle
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to update mentor listing' });
  } finally {
    mentorSaving.value = null;
  }
};

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
    const name = memberships.value.find((m) => m.groupId === gid)?.groupName
      || cards.find((c) => c.elements?.party?.groupName)?.elements.party.groupName
      || gid;
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

const openEditor = (card: PolicyCard | null) => {
  editingId.value = card ? card.id : null;
  editingCard.value = card;       // prefill the builder matrix (null = fresh)
  editorKey.value += 1;           // remount the builder with clean state
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
      memberships.value = (gData.memberships || []).map(
        (m: { groupId: string; groupName: string; alias?: string; mentor?: boolean; mentorTag?: string; broadcastMessages?: boolean }) => ({
          groupId: m.groupId, groupName: m.groupName, alias: m.alias || '', mentor: !!m.mentor, mentorTag: m.mentorTag || '',
          broadcastMessages: m.broadcastMessages !== false
        })
      );
      mentorSaved.value = Object.fromEntries(
        memberships.value.map((m) => [m.groupId, `${m.mentor}|${m.mentorTag.trim()}`])
      );
      aliasSaved.value = Object.fromEntries(
        memberships.value.map((m) => [m.groupId, m.alias])
      );
    }
  } catch { /* empty panel */ } finally {
    loading.value = false;
  }
};

// Save a card composed by PolicyCardBuilder (its @save payload).
const saveBuiltCard = async (card: PolicyCard) => {
  saving.value = true;
  try {
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
