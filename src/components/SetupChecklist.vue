<template>
  <q-dialog
    :model-value="state.open"
    :persistent="!requiredDone"
    @update:model-value="(v) => { if (!v) hide(); }"
  >
    <q-card class="setup-checklist">
      <q-card-section class="q-pb-sm">
        <div class="text-h6">Set up your MAIA</div>
      </q-card-section>

      <q-card-section class="q-pt-none">
        <div v-if="!status && state.error" class="text-negative">Couldn't load your setup: {{ state.error }}</div>
        <div v-else-if="!status" class="row justify-center q-pa-md"><q-spinner size="2em" /></div>

        <template v-else>
          <div v-for="row in rows" :key="row.key" class="setup-row">
            <q-icon
              :name="row.done ? 'check_circle' : 'radio_button_unchecked'"
              :color="row.done ? 'green-7' : 'grey-5'"
              size="22px"
              class="setup-row__mark"
            />
            <div class="setup-row__body">
              <div class="setup-row__title">
                <span :class="{ 'text-grey-7': row.done }">{{ row.title }}</span>
                <span v-if="!row.required && !row.done" class="text-caption text-grey-7">(recommended)</span>
                <q-icon name="info_outline" size="18px" color="grey-7" class="setup-row__info" tabindex="0" :aria-label="`About: ${row.title}`">
                  <q-tooltip max-width="300px">{{ row.info }}</q-tooltip>
                </q-icon>
              </div>
              <div v-if="row.detail" class="text-caption text-grey-7">{{ row.detail }}</div>

              <template v-if="!row.done">
                <!-- 1. Email -->
                <div v-if="row.key === 'email'" class="q-mt-xs">
                  <EmailVerifyBox label="Email address" />
                  <div v-if="emailError" class="text-caption text-negative q-mt-xs">{{ emailError }}</div>
                </div>
                <!-- 2. Passkey -->
                <q-btn
                  v-else-if="row.key === 'passkey'"
                  outline dense no-caps color="primary" class="q-mt-xs" label="Create passkey"
                  @click="emit('add-passkey')"
                />
                <!-- 3. Folder -->
                <div v-else-if="row.key === 'folder'" class="q-mt-xs">
                  <q-btn outline dense no-caps color="primary" label="Choose folder" :loading="folderBusy" @click="emit('choose-folder')" />
                  <div v-if="folderError" class="text-caption text-negative q-mt-xs">{{ folderError }}</div>
                </div>
                <!-- 4. Group -->
                <div v-else-if="row.key === 'group'" class="q-mt-xs">
                  <div v-if="groupPending.length" class="text-caption text-grey-8">
                    Waiting for {{ groupPending.join(', ') }} to approve your request.
                  </div>
                  <template v-else>
                    <q-btn
                      outline dense no-caps color="primary" :label="`Join ${groupName}`"
                      :loading="joining" :disable="!emailDone || !group?.joinLink" @click="joinGroup"
                    />
                    <div v-if="!emailDone" class="text-caption text-grey-7 q-mt-xs">Verify your email first.</div>
                    <div v-if="joinError" class="text-caption text-negative q-mt-xs">{{ joinError }}</div>
                  </template>
                </div>
                <!-- 5. Patient Summary + Current Medications -->
                <div v-else-if="row.key === 'summary'" class="q-mt-xs">
                  <q-btn
                    outline dense no-caps color="primary" label="Open Patient Summary"
                    :disable="!requiredDone" @click="emit('open-summary')"
                  />
                  <div v-if="!requiredDone" class="text-caption text-grey-7 q-mt-xs">Finish the steps above first.</div>
                </div>
              </template>
            </div>
          </div>
        </template>
      </q-card-section>

      <q-card-section v-if="status" class="q-pt-none">
        <div v-if="state.agentFailed && status.agent !== 'ready'" class="row items-center no-wrap text-caption text-negative">
          <q-icon name="error_outline" size="16px" class="q-mr-sm" />
          <span>Your private AI couldn't start.</span>
          <q-btn flat dense no-caps size="sm" color="primary" label="Try again" class="q-ml-sm" @click="retryAgent" />
        </div>
        <div v-else class="row items-center no-wrap text-caption text-grey-8">
          <q-spinner v-if="status.agent === 'creating' || status.agent === 'none'" size="14px" class="q-mr-sm" />
          <q-icon v-else :name="status.agent === 'ready' ? 'smart_toy' : 'hourglass_empty'" size="16px" class="q-mr-sm" />
          <span>{{ agentLine }}</span>
        </div>
      </q-card-section>

      <q-card-actions align="between" class="q-px-md q-pb-md">
        <q-btn flat dense no-caps color="grey-8" label="Sign out" @click="emit('sign-out')" />
        <q-btn unelevated color="primary" label="Done" :disable="!requiredDone" @click="hide" />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import EmailVerifyBox from './EmailVerifyBox.vue';
import { useSetupChecklist, type SetupStepKey } from '../composables/useSetupChecklist';
import { useVerifiedEmail } from '../composables/verifiedEmail';

/**
 * Personal AS setup checklist (Documentation/group_requests.md §5).
 * Rows come from GET /api/setup-status. Actions that need App.vue (the
 * passkey dialog, the folder, the Workbook) are emitted; email and joining
 * the group happen here.
 */
const props = defineProps<{
  userId: string;
  group: { groupId: string; name: string; joinLink: string | null } | null;
  folderBusy?: boolean;
  folderError?: string;
}>();
const emit = defineEmits<{
  'add-passkey': [];
  'choose-folder': [];
  'open-summary': [];
  'sign-out': [];
}>();

const { state, refresh, hide, retryAgent } = useSetupChecklist();
const status = computed(() => state.status);
const requiredDone = computed(() => !!status.value?.requiredDone);
const step = (key: SetupStepKey) => status.value?.steps.find((s) => s.key === key);
const emailDone = computed(() => !!step('email')?.done);
const groupName = computed(() => props.group?.name || 'your group');
const groupPending = computed(() => step('group')?.pending || []);

const TEXT: Record<SetupStepKey, { title: () => string; info: () => string }> = {
  email: {
    title: () => 'Verify your email',
    info: () => 'MAIA emails you when a request needs your decision or when something was shared, plus a weekly summary. It never emails your health information.'
  },
  passkey: {
    title: () => 'Create a passkey',
    info: () => 'A passkey lets you sign back in on this computer, for example when MAIA emails you about a request. There is no password to remember.'
  },
  folder: {
    title: () => 'Choose your MAIA folder',
    info: () => 'MAIA keeps your own copy of your records here. Choose an empty folder, or one you use only for MAIA.'
  },
  group: {
    title: () => `Join ${groupName.value}`,
    info: () => `${groupName.value} suggests starting rules for who may see your information. You review every rule before anything is shared.`
  },
  summary: {
    title: () => 'Create your Patient Summary',
    info: () => 'Your Patient Summary, with your current medications, is what your MAIA can share when your rules allow it, always as a privacy-filtered copy. MAIA helps you write it.'
  }
};

const rows = computed(() => (status.value?.steps || [])
  .filter((s) => s.key !== 'group' || s.required || s.done)
  .map((s) => {
    let detail = '';
    if (s.key === 'group' && s.done && s.groups?.length) detail = `Member of ${s.groups.join(', ')}`;
    if (s.key === 'summary' && !s.done && (s.medicationsVerified || s.summaryVerified)) {
      detail = s.medicationsVerified ? 'Current Medications verified' : 'Patient Summary verified';
    }
    return { ...s, title: TEXT[s.key].title(), info: TEXT[s.key].info(), detail };
  }));

const agentLine = computed(() => {
  switch (status.value?.agent) {
    case 'ready': return 'Your private AI is ready.';
    case 'creating': return 'Your private AI is getting ready. This takes about a minute.';
    case 'none': return 'Starting your private AI…';
    default: return 'Your private AI starts once your email is verified.';
  }
});

// ── Email: save a newly verified address to the account ─────────────────
const { state: verifiedEmail } = useVerifiedEmail();
const emailError = ref('');
watch(() => verifiedEmail.verified, async (ok) => {
  if (!ok || emailDone.value || !props.userId) return;
  emailError.value = '';
  try {
    const r = await fetch('/api/user/notification-email', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: props.userId, email: verifiedEmail.email, emailVerifyToken: verifiedEmail.token })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.verified) emailError.value = 'That address could not be saved as verified. Try sending a new code.';
  } catch {
    emailError.value = 'Could not save your email. Check your connection and try again.';
  }
  await refresh();
});

// ── Group: join (automatically once, when the email is verified) ────────
const joining = ref(false);
const joinError = ref('');
let autoJoinTried = false;
const joinGroup = async () => {
  const g = props.group;
  if (!g?.joinLink || !props.userId || joining.value) return;
  let token: string | null = null;
  let groupId = g.groupId;
  let registryUrl = window.location.origin;
  try {
    const u = new URL(g.joinLink, window.location.origin);
    token = u.searchParams.get('groupJoin');
    groupId = u.searchParams.get('groupId') || g.groupId;
    registryUrl = u.searchParams.get('registry') || registryUrl;
  } catch { /* handled below */ }
  if (!token) { joinError.value = "This group's join link isn't valid. Ask the group for a new one."; return; }
  joining.value = true;
  joinError.value = '';
  try {
    const r = await fetch('/api/user-groups/request-join', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: props.userId, groupId, token, alias: props.userId, registryUrl })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.success) joinError.value = d.message || d.error || 'Could not join the group.';
  } catch {
    joinError.value = 'Could not reach the group. Try again.';
  } finally {
    joining.value = false;
    await refresh();
  }
};

// A pending join finishes when the group approves; check at most every 30 s.
let lastPoll = 0;
const pollJoins = async () => {
  if (Date.now() - lastPoll < 30000 || !props.userId) return;
  lastPoll = Date.now();
  try {
    await fetch('/api/user-groups/poll-joins', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: props.userId })
    });
  } catch { /* next time */ }
};

watch(status, async (s) => {
  const g = s?.steps.find((x) => x.key === 'group');
  if (!s || !g || g.done) return;
  if (g.pending?.length) {
    const before = lastPoll;
    await pollJoins();
    if (lastPoll !== before) await refresh();
    return;
  }
  if (g.required && emailDone.value && props.group?.joinLink && !autoJoinTried) {
    autoJoinTried = true;
    await joinGroup();
  }
});
</script>

<style scoped>
.setup-checklist {
  width: 520px;
  max-width: 95vw;
}
.setup-row {
  display: flex;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid #f0f0f0;
}
.setup-row:last-child {
  border-bottom: none;
}
.setup-row__mark {
  flex: 0 0 auto;
  margin-top: 1px;
}
.setup-row__body {
  flex: 1 1 auto;
  min-width: 0;
}
.setup-row__title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
}
.setup-row__info {
  cursor: help;
}
</style>
