<template>
  <q-page class="q-pa-md">
    <div class="q-mb-lg">
      <!-- Single combined status line, just before the header -->
      <div class="text-caption text-grey-7 q-mb-xs">
        Total Users: {{ totalUsers }} &nbsp;•&nbsp; Deep Link Users: {{ totalDeepLinkUsers }}
        <template v-if="passkeyConfig">
          &nbsp;•&nbsp; Passkey rpID: {{ passkeyConfig.rpID }}
          &nbsp;•&nbsp; Origin: {{ passkeyConfig.origin }}
        </template>
      </div>
      <div class="row items-center justify-between q-mb-xs">
        <div class="text-h4">
          User Administration
          <span class="text-caption text-grey-6 q-ml-sm">v{{ appVersion }}</span>
        </div>
        <div class="row no-wrap items-center q-gutter-sm">
          <q-btn
            outline
            dense
            color="primary"
            label="Broadcast email"
            icon="campaign"
            @click="openBroadcast"
          >
            <q-tooltip>Email an announcement to all account holders</q-tooltip>
          </q-btn>
          <q-btn
            flat
            dense
            color="negative"
            label="Sign Out"
            icon="logout"
            :loading="signingOut"
            @click="signOutAdmin"
          />
        </div>
      </div>
      <!-- Customer balance collapsed to a single line just below the header -->
      <div class="text-caption text-grey-7 q-mb-md">
        <template v-if="balanceLoading">Customer balance: loading…</template>
        <template v-else-if="balanceError">
          <span class="text-negative">Customer balance: {{ balanceError }}</span>
          <span v-if="balanceHint" class="text-orange-9">&nbsp;({{ balanceHint }})</span>
        </template>
        <template v-else>
          Customer balance —
          <template v-for="(entry, i) in balanceEntries" :key="entry.key">
            <span v-if="i > 0">&nbsp;•&nbsp;</span><strong>{{ entry.label }}:</strong> {{ entry.value }}
          </template>
        </template>
      </div>

    <!-- Patient Groups management (Groups & AS feature — Documentation/Groups.md) -->
    <AdminGroups />

    <!-- Credits accounting: mini-payments behind the Deposit/Payment policy
         column. The admin sells credits out-of-band (Stripe Payment Link),
         grants them here, and watches what the escrow settled. -->
    <q-expansion-item
      icon="paid"
      label="Credits"
      :caption="creditsCaption"
      class="q-mt-sm"
      header-class="text-weight-medium"
      @show="loadCreditsAdmin"
    >
      <q-card flat bordered class="q-pa-md">
        <div v-if="crLoading" class="text-caption text-grey-7">Loading…</div>
        <template v-else>
          <div class="text-caption q-mb-md">
            <b>{{ crStats.accounts }}</b> account{{ crStats.accounts === 1 ? '' : 's' }}
            &nbsp;•&nbsp; granted <b>{{ crStats.granted }}</b>
            &nbsp;•&nbsp; earned <b>{{ crStats.earned }}</b>
            (charged {{ crStats.charged }} + captured {{ crStats.captured }} + forfeited {{ crStats.forfeited }})
            &nbsp;•&nbsp; held in escrow <b>{{ crStats.held }}</b>
            &nbsp;•&nbsp; unspent balances <b>{{ crStats.outstanding }}</b>
            &nbsp;•&nbsp; returned {{ crStats.released }}
            <span class="text-grey-7">— 1 credit = 2¢ ({{ crPurchase.credits }} for ${{ crPurchase.usd }})</span>
          </div>
          <div class="row q-gutter-sm items-center q-mb-md" style="flex-wrap: wrap;">
            <q-input v-model="crGrantEmail" dense outlined label="Buyer's verified email" style="min-width: 240px" :disable="crGranting" />
            <q-input v-model.number="crGrantAmount" dense outlined type="number" label="Credits" style="width: 110px" :disable="crGranting" />
            <q-btn unelevated dense color="primary" label="Grant"
                   :disable="!crGrantEmail.trim() || !(crGrantAmount > 0)"
                   :loading="crGranting" @click="grantCreditsAdmin" />
            <span class="text-caption text-grey-7">Grant AFTER the purchase arrives (Stripe emails you the buyer's address).</span>
          </div>
          <div class="row q-gutter-sm items-center q-mb-sm" style="flex-wrap: wrap;">
            <q-input v-model="crPurchaseUrl" dense outlined label="Purchase link (e.g. Stripe Payment Link)" style="flex: 1; min-width: 280px" :disable="crSavingConfig" />
            <q-input v-model="crCharity" dense outlined label="Surplus charity (shown to buyers)" style="min-width: 220px" :disable="crSavingConfig" />
          </div>
          <div class="row q-gutter-sm items-center" style="flex-wrap: wrap;">
            <q-input
              v-model="crWebhookSecret" dense outlined type="password" autocomplete="off"
              :label="crWebhookConfigured ? 'Stripe webhook signing secret (set — blank keeps it)' : 'Stripe webhook signing secret (whsec_…)'"
              style="flex: 1; min-width: 280px" :disable="crSavingConfig"
            />
            <q-btn outline dense color="primary" label="Save" :loading="crSavingConfig" @click="saveCreditsConfig" />
            <q-icon :name="crWebhookConfigured ? 'check_circle' : 'radio_button_unchecked'"
                    :color="crWebhookConfigured ? 'positive' : 'grey-5'" size="20px">
              <q-tooltip>{{ crWebhookConfigured ? 'Purchases grant credits automatically.' : 'No webhook yet — grant purchases manually above.' }}</q-tooltip>
            </q-icon>
          </div>
          <div class="text-caption text-grey-7 q-mt-sm">
            Automatic grants: in Stripe → Developers → Webhooks, add endpoint
            <code>{{ webhookEndpoint }}</code> for the event
            <code>checkout.session.completed</code>, then paste its signing secret here.
            Each completed Payment Link checkout then credits the buyer's email
            instantly (2¢ per credit, so quantity purchases scale). The grant form
            above stays for corrections and comps.
          </div>
        </template>
      </q-card>
    </q-expansion-item>
    </div>

    <q-table
      :rows="users"
      :columns="columns"
      row-key="userId"
      :loading="loading"
      :pagination="{ rowsPerPage: 50 }"
      class="admin-users-table"
    >
      <template v-slot:body-cell-userId="props">
        <q-td :props="props">
          <div>
            <span class="text-weight-bold">{{ props.value }}</span>
            <span v-if="props.row.domain" class="text-grey-7"> ({{ props.row.domain }})</span>
          </div>
          <div v-if="props.row.email" class="text-caption text-grey-8">
            {{ props.row.email }}
            <q-icon v-if="props.row.emailVerified" name="verified" size="12px" color="green-7" class="q-ml-xs">
              <q-tooltip>Verified email</q-tooltip>
            </q-icon>
          </div>
        </q-td>
      </template>

      <template v-slot:body-cell-workflowStage="props">
        <q-td :props="props">
          <q-badge :color="getWorkflowStageColor(props.value)" :label="props.value" />
        </q-td>
      </template>

  <template v-slot:body-cell-hasPasskey="props">
    <q-td :props="props">
      <q-badge :color="props.value ? 'green' : 'grey'" :label="props.value ? 'Yes' : 'No'" />
    </q-td>
  </template>

      <template v-slot:body-cell-provisionedDate="props">
        <q-td :props="props">
          {{ formatDate(props.value) }}
        </q-td>
      </template>

      <template v-slot:body-cell-totalStorageMB="props">
        <q-td :props="props">
          {{ props.value.toFixed(2) }} MB
        </q-td>
      </template>

      <template v-slot:body-cell-deepLinkUsersCount="props">
        <q-td :props="props">
          {{ props.value }}
        </q-td>
      </template>

      <template v-slot:body-cell-groups="props">
        <q-td :props="props">
          <template v-if="props.row.groupNames && props.row.groupNames.length">
            <q-badge
              v-for="name in props.row.groupNames"
              :key="name"
              color="blue-1"
              text-color="primary"
              :label="name"
              class="q-mr-xs"
            />
          </template>
          <span v-else class="text-grey-5">—</span>
        </q-td>
      </template>

      <template v-slot:body-cell-actions="props">
        <q-td :props="props">
          <q-btn
            flat
            round
            dense
            color="primary"
            icon="refresh"
            @click="recoverUser(props.row.userId)"
            :loading="recoveringUsers.has(props.row.userId)"
            title="Recover provisioning - check DO API and update user document"
            class="q-mr-xs"
          />
          <q-btn
            flat
            round
            dense
            color="negative"
            icon="delete"
            @click="confirmDelete(props.row.userId)"
            :loading="deletingUsers.has(props.row.userId)"
          />
        </q-td>
      </template>
    </q-table>

    <q-card class="q-mt-lg">
      <q-card-section>
        <div class="text-h6 q-mb-sm">Usage List</div>
        <q-table
          :rows="usageList"
          :columns="usageColumns"
          row-key="date"
          dense
          :pagination="{ rowsPerPage: 10 }"
          :loading="loading"
        >
          <template v-slot:body-cell-date="props">
            <q-td :props="props">
              {{ formatDate(props.value) }}
            </q-td>
          </template>
          <template v-slot:body-cell-monthToDateUsage="props">
            <q-td :props="props">
              {{ props.value ?? '—' }}
            </q-td>
          </template>
          <template v-slot:body-cell-changeFromPrevious="props">
            <q-td :props="props">
              {{ props.value ?? '—' }}
            </q-td>
          </template>
          <template v-slot:body-cell-deletedUserId="props">
            <q-td :props="props">
              {{ props.value || '—' }}
            </q-td>
          </template>
        </q-table>
      </q-card-section>
    </q-card>

    <q-btn
      v-if="!loading"
      label="Refresh"
      color="primary"
      class="q-mt-md"
      @click="loadUsers"
    />

    <!-- Broadcast announcement composer. Recipients are enumerated
         server-side at send time; the counts here (from the loaded user
         table) are a preview. Send test first, then the real thing. -->
    <q-dialog v-model="showBroadcast">
      <q-card style="width: 760px; max-width: 95vw">
        <q-card-section class="row items-center q-pb-none">
          <div class="text-h6">Broadcast email to account holders</div>
          <q-space />
          <q-btn flat round dense icon="close" v-close-popup :disable="broadcastSending" />
        </q-card-section>
        <q-card-section class="q-gutter-y-md">
          <div class="text-caption text-grey-7">
            Will go to {{ broadcastRecipientCount }} address{{ broadcastRecipientCount === 1 ? '' : 'es' }}
            ({{ bcOnlyVerified ? 'verified only' : 'any email on file' }}, deduplicated),
            each as an individual email — recipients never see each other.
          </div>
          <q-input v-model="bcSubject" dense outlined label="Subject" maxlength="200" :disable="broadcastSending" />
          <q-input v-model="bcBody" outlined type="textarea" label="Message (plain text)" autogrow
                   input-style="min-height: 220px" maxlength="20000" :disable="broadcastSending" />
          <q-toggle v-model="bcOnlyVerified" dense label="Verified emails only" :disable="broadcastSending" />
          <div class="row items-center q-gutter-sm">
            <q-input v-model="bcTestTo" dense outlined label="Test address" type="email"
                     style="flex: 1; min-width: 220px" :disable="broadcastSending" />
            <q-btn outline dense color="primary" label="Send test"
                   :disable="!bcTestTo.trim() || !bcSubject.trim() || !bcBody.trim() || broadcastSending"
                   :loading="broadcastTesting" @click="sendBroadcast(true)" />
          </div>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="Cancel" v-close-popup :disable="broadcastSending" />
          <q-btn unelevated color="primary" icon="campaign"
                 :label="`Send to ${broadcastRecipientCount} recipient${broadcastRecipientCount === 1 ? '' : 's'}`"
                 :disable="!bcSubject.trim() || !bcBody.trim() || broadcastRecipientCount === 0"
                 :loading="broadcastSending" @click="confirmBroadcast" />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useQuasar } from 'quasar';
import AdminGroups from './AdminGroups.vue';
import packageJson from '../../package.json';

const appVersion = packageJson.version;

const $q = useQuasar();

interface User {
  userId: string;
  domain: string | null;
  email: string | null;
  emailVerified: boolean;
  workflowStage: string;
  lastActivity: string;
  provisionedDate: string | null;
  totalStorageMB: number;
  filesIndexed: number;
  savedChatsCount: number;
  deepLinkUsersCount: number;
  hasPasskey: boolean;
  groupNames: string[];
}

interface PasskeyConfig {
  rpID: string;
  origin: string;
}

interface UsageEntry {
  date: string;
  monthToDateUsage: string | null;
  changeFromPrevious: string | null;
  deletedUserId: string | null;
}

const users = ref<User[]>([]);
const loading = ref(false);
const totalUsers = ref(0);
const totalDeepLinkUsers = ref(0);
const passkeyConfig = ref<PasskeyConfig | null>(null);
const usageList = ref<UsageEntry[]>([]);
const deletingUsers = ref(new Set<string>());
const recoveringUsers = ref(new Set<string>());
const signingOut = ref(false);

// ── Credits (mini-payment accounting) ────────────────────────────────
interface CreditsStats {
  accounts: number; granted: number; charged: number; captured: number;
  forfeited: number; released: number; outstanding: number; held: number; earned: number;
}
const crLoading = ref(false);
const crLoaded = ref(false);
const crStats = ref<CreditsStats>({ accounts: 0, granted: 0, charged: 0, captured: 0, forfeited: 0, released: 0, outstanding: 0, held: 0, earned: 0 });
const crPurchase = ref({ credits: 100, usd: 2 });
const crPurchaseUrl = ref('');
const crCharity = ref('');
const crWebhookSecret = ref('');
const crWebhookConfigured = ref(false);
const webhookEndpoint = `${window.location.origin}/api/stripe/webhook`;
const crGrantEmail = ref('');
const crGrantAmount = ref(100);
const crGranting = ref(false);
const crSavingConfig = ref(false);

const creditsCaption = computed(() =>
  crLoaded.value
    ? `${crStats.value.accounts} accounts • ${crStats.value.earned} earned • ${crStats.value.held} held`
    : 'Sell, grant, and account for credits (100 for $2)');

const loadCreditsAdmin = async () => {
  crLoading.value = true;
  try {
    const res = await fetch('/api/admin/credits-stats', { credentials: 'include' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    crStats.value = { ...crStats.value, ...data.stats };
    if (data.purchase) crPurchase.value = data.purchase;
    crPurchaseUrl.value = data.config?.purchaseUrl || '';
    crCharity.value = data.config?.charity || '';
    crWebhookConfigured.value = !!data.config?.webhookConfigured;
    crLoaded.value = true;
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Failed to load credits' });
  } finally {
    crLoading.value = false;
  }
};

const grantCreditsAdmin = async () => {
  const email = crGrantEmail.value.trim();
  const credits = Math.floor(crGrantAmount.value);
  if (!email || !(credits > 0)) return;
  crGranting.value = true;
  try {
    const res = await fetch('/api/admin/credits-grant', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ email, credits, note: 'admin grant' })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    $q.notify({ type: 'positive', message: `Granted ${credits} credits to ${data.email} — balance now ${data.balance}.` });
    crGrantEmail.value = '';
    void loadCreditsAdmin();
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Grant failed' });
  } finally {
    crGranting.value = false;
  }
};

const saveCreditsConfig = async () => {
  crSavingConfig.value = true;
  try {
    const res = await fetch('/api/admin/credits-config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({
        purchaseUrl: crPurchaseUrl.value.trim(),
        charity: crCharity.value.trim(),
        // Blank keeps the stored secret; only a pasted value replaces it.
        webhookSecret: crWebhookSecret.value.trim() || undefined
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    crWebhookConfigured.value = !!data.config?.webhookConfigured;
    crWebhookSecret.value = ''; // never keep the secret in the form
    $q.notify({ type: 'positive', message: 'Credits settings saved.' });
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Save failed' });
  } finally {
    crSavingConfig.value = false;
  }
};

// ── Broadcast announcement email ─────────────────────────────────────
const showBroadcast = ref(false);
const broadcastSending = ref(false);
const broadcastTesting = ref(false);
const bcOnlyVerified = ref(true);
const bcTestTo = ref('');
const bcSubject = ref('');
const bcBody = ref('');

// Editable draft for the groups-redesign announcement; the admin rewrites
// freely — this just saves starting from a blank page.
const BC_DRAFT_SUBJECT = 'MAIA has changed: patient groups, sharing policies, and verified email';
const BC_DRAFT_BODY = [
  'Hello,',
  '',
  'You are receiving this because you created a MAIA account at maia.agropper.xyz.',
  '',
  'MAIA has been substantially redesigned around patient groups:',
  '',
  '- You can join a patient group (such as the Trustee group) and message other members.',
  '- Requests for your health information are answered by YOUR sharing policies — plain-language cards you author. Only your privacy-filtered Patient Summary ever leaves automatically.',
  '- By policy, Trustee group membership and a VERIFIED email address are now required for group features and notifications.',
  '',
  'One-time step: open https://maia.agropper.xyz and reload the page once (Cmd-Shift-R on Mac, Ctrl-Shift-R on Windows) to get the current version. From now on, MAIA will tell you in the app whenever a new version is available.',
  '',
  'If you no longer want your MAIA account, you can delete it (including its cloud data) from the Workbook — or simply ignore this email.',
  '',
  '— Adrian Gropper, MD'
].join('\n');

const broadcastRecipientCount = computed(() => {
  const seen = new Set<string>();
  for (const u of users.value) {
    const email = (u.email || '').trim().toLowerCase();
    if (!email) continue;
    if (bcOnlyVerified.value && !u.emailVerified) continue;
    seen.add(email);
  }
  return seen.size;
});

const openBroadcast = () => {
  if (!bcSubject.value.trim()) bcSubject.value = BC_DRAFT_SUBJECT;
  if (!bcBody.value.trim()) bcBody.value = BC_DRAFT_BODY;
  showBroadcast.value = true;
};

const sendBroadcast = async (test: boolean) => {
  if (test) broadcastTesting.value = true; else broadcastSending.value = true;
  try {
    const res = await fetch('/api/admin/broadcast-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        subject: bcSubject.value.trim(),
        body: bcBody.value.trim(),
        onlyVerified: bcOnlyVerified.value,
        ...(test ? { testTo: bcTestTo.value.trim() } : {})
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    if (test) {
      $q.notify({ type: 'positive', message: `Test sent to ${bcTestTo.value.trim()}.` });
    } else {
      const failed = Array.isArray(data.failed) ? data.failed.length : 0;
      $q.notify({
        type: failed ? 'warning' : 'positive',
        timeout: 8000,
        message: `Broadcast sent to ${data.sent} of ${data.recipients} recipients${failed ? ` — ${failed} failed (see server logs)` : '.'}`
      });
      showBroadcast.value = false;
    }
  } catch (err) {
    $q.notify({ type: 'negative', message: err instanceof Error ? err.message : 'Broadcast failed' });
  } finally {
    broadcastSending.value = false;
    broadcastTesting.value = false;
  }
};

const confirmBroadcast = () => {
  const n = broadcastRecipientCount.value;
  $q.dialog({
    title: 'Send broadcast?',
    message: `This emails ${n} account holder${n === 1 ? '' : 's'} (${bcOnlyVerified.value ? 'verified addresses only' : 'any email on file'}). This cannot be recalled.`,
    ok: { label: `Send to ${n}`, color: 'primary' },
    cancel: { label: 'Cancel', flat: true },
    persistent: true
  }).onOk(() => { void sendBroadcast(false); });
};
const balanceLoading = ref(false);
const balanceError = ref('');
const balanceHint = ref('');
const balanceData = ref<any | null>(null);

const columns = [
  {
    name: 'actions',
    label: 'Actions',
    align: 'center' as const,
    field: 'actions',
    sortable: false
  },
  {
    name: 'userId',
    required: true,
    label: 'User ID',
    align: 'left' as const,
    field: 'userId',
    sortable: true
  },
  {
    name: 'workflowStage',
    label: 'Workflow Stage',
    align: 'left' as const,
    field: 'workflowStage',
    sortable: true
  },
  {
    name: 'hasPasskey',
    label: 'Passkey',
    align: 'center' as const,
    field: 'hasPasskey',
    sortable: true
  },
  {
    name: 'lastActivity',
    label: 'Last Activity',
    align: 'left' as const,
    field: 'lastActivity',
    sortable: true
  },
  {
    name: 'provisionedDate',
    label: 'Provisioned On',
    align: 'left' as const,
    field: 'provisionedDate',
    sortable: true
  },
  {
    name: 'totalStorageMB',
    label: 'Storage (MB)',
    align: 'right' as const,
    field: 'totalStorageMB',
    sortable: true
  },
  {
    name: 'filesIndexed',
    label: 'Saved Files',
    align: 'center' as const,
    field: 'filesIndexed',
    sortable: true,
    // Narrow column: let the header wrap to multiple lines instead of forcing width.
    headerStyle: 'white-space: normal; max-width: 60px; padding-left: 4px; padding-right: 4px;',
    style: 'max-width: 60px; padding-left: 4px; padding-right: 4px;'
  },
  {
    name: 'savedChatsCount',
    label: 'Saved Chats',
    align: 'center' as const,
    field: 'savedChatsCount',
    sortable: true,
    headerStyle: 'white-space: normal; max-width: 60px; padding-left: 4px; padding-right: 4px;',
    style: 'max-width: 60px; padding-left: 4px; padding-right: 4px;'
  },
  {
    name: 'deepLinkUsersCount',
    label: '# Deep Link Users',
    align: 'center' as const,
    field: 'deepLinkUsersCount',
    sortable: true,
    headerStyle: 'white-space: normal; max-width: 64px; padding-left: 4px; padding-right: 4px;',
    style: 'max-width: 64px; padding-left: 4px; padding-right: 4px;'
  },
  {
    name: 'groups',
    label: 'Groups',
    align: 'left' as const,
    field: 'groupNames',
    sortable: false
  }
];

const usageColumns = [
  {
    name: 'date',
    label: 'Date',
    align: 'left' as const,
    field: 'date',
    sortable: true
  },
  {
    name: 'monthToDateUsage',
    label: 'Month to Date Usage',
    align: 'left' as const,
    field: 'monthToDateUsage',
    sortable: true
  },
  {
    name: 'changeFromPrevious',
    label: 'Change',
    align: 'left' as const,
    field: 'changeFromPrevious',
    sortable: true
  },
  {
    name: 'deletedUserId',
    label: 'Deleted User ID',
    align: 'left' as const,
    field: 'deletedUserId',
    sortable: true
  }
];

const balanceEntries = computed(() => {
  if (!balanceData.value) return [];
  const entries: Array<{ key: string; label: string; value: string }> = [];
  const balance = balanceData.value.balance;
  if (balance && typeof balance === 'object') {
    for (const [key, value] of Object.entries(balance)) {
      entries.push({ key: `balance.${key}`, label: key.replace(/_/g, ' '), value: String(value) });
    }
  }
  for (const [key, value] of Object.entries(balanceData.value)) {
    if (key === 'balance') continue;
    entries.push({ key, label: key.replace(/_/g, ' '), value: String(value) });
  }
  return entries;
});

const loadCustomerBalance = async () => {
  balanceLoading.value = true;
  balanceError.value = '';
  balanceHint.value = '';
  try {
    const response = await fetch('/api/billing/balance', {
      credentials: 'include'
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const status = errorData.status || response.status;
      const msg = errorData.error || errorData.message || 'Unknown error';
      balanceHint.value = errorData.hint || '';
      throw new Error(`HTTP ${status} — ${msg}`);
    }
    balanceData.value = await response.json();
  } catch (err) {
    balanceError.value = err instanceof Error ? err.message : 'Failed to load customer balance';
  } finally {
    balanceLoading.value = false;
  }
};

function getWorkflowStageColor(stage: string): string {
  const colors: Record<string, string> = {
    'request_sent': 'orange',
    'provisioned': 'green',
    'active': 'blue',
    'unknown': 'grey'
  };
  return colors[stage] || 'grey';
}

function formatDate(dateString: string | null): string {
  if (!dateString) return '—';
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  } catch {
    return dateString;
  }
}

async function loadUsers() {
  loading.value = true;
  try {
    const response = await fetch('/api/admin/users', {
      credentials: 'include'
    });
    const data = await response.json();
    
    if (data.success) {
      users.value = data.users;
      totalUsers.value = data.totalUsers;
      totalDeepLinkUsers.value = data.totalDeepLinkUsers;
      passkeyConfig.value = data.passkeyConfig || null;
      usageList.value = Array.isArray(data.usageList) ? data.usageList : [];
    } else {
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'negative',
          message: `Error loading users: ${data.error || 'Unknown error'}`
        });
      } else {
        console.error('Error loading users:', data.error || 'Unknown error');
      }
    }
  } catch (error) {
    console.error('Error loading users:', error);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: 'Failed to load users. Please try again.'
      });
    } else {
      console.error('Failed to load users. Please try again.');
    }
  } finally {
    loading.value = false;
  }
}

function confirmDelete(userId: string) {
  if ($q && typeof $q.dialog === 'function') {
    $q.dialog({
      title: 'Confirm Deletion',
      message: `Are you sure you want to permanently delete user "${userId}"? This will delete:
- All files in their Spaces folder
- Their Knowledge Base
- Their Agent
- Their user document
- All their sessions
- All their saved chats

This action cannot be undone.`,
      cancel: {
        label: 'CANCEL',
        color: 'grey',
        flat: true
      },
      ok: {
        label: 'DELETE',
        color: 'negative'
      },
      persistent: true
    }).onOk(() => {
      deleteUser(userId);
    });
  } else {
    // Fallback to native confirm if dialog plugin not available
    if (window.confirm(`Are you sure you want to permanently delete user "${userId}"? This will delete all their files, Knowledge Base, Agent, user document, and sessions. This action cannot be undone.`)) {
      deleteUser(userId);
    }
  }
}

async function deleteUser(userId: string) {
  deletingUsers.value.add(userId);
  try {
    const response = await fetch(`/api/admin/users/${userId}`, {
      method: 'DELETE',
      credentials: 'include'
    });
    
    const data = await response.json();
    
    if (data.success) {
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'positive',
          message: `User ${userId} deleted successfully`,
          timeout: 3000
        });
      } else {
        alert(`User ${userId} deleted successfully`);
      }
      // Reload users list
      await loadUsers();
    } else {
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'negative',
          message: `Failed to delete user: ${data.error || 'Unknown error'}`,
          timeout: 5000
        });
      } else {
        alert(`Failed to delete user: ${data.error || 'Unknown error'}`);
      }
    }
  } catch (error) {
    console.error('Error deleting user:', error);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: 'Failed to delete user. Please try again.'
      });
    } else {
      alert('Failed to delete user. Please try again.');
    }
  } finally {
    deletingUsers.value.delete(userId);
  }
}

async function recoverUser(userId: string) {
  recoveringUsers.value.add(userId);
  try {
    const response = await fetch(`/api/admin/users/${userId}/recover`, {
      method: 'POST',
      credentials: 'include'
    });
    
    const data = await response.json();
    
    if (data.success) {
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'positive',
          message: data.message || `User ${userId} recovered successfully`,
          timeout: 5000
        });
      } else {
        alert(data.message || `User ${userId} recovered successfully`);
      }
      // Reload users list to show updated status
      await loadUsers();
    } else {
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'negative',
          message: `Recovery failed: ${data.error || 'Unknown error'}`,
          timeout: 5000
        });
      } else {
        alert(`Recovery failed: ${data.error || 'Unknown error'}`);
      }
    }
  } catch (error) {
    console.error('Error recovering user:', error);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: 'Failed to recover user. Please try again.'
      });
    } else {
      alert('Failed to recover user. Please try again.');
    }
  } finally {
    recoveringUsers.value.delete(userId);
  }
}

const signOutAdmin = async () => {
  signingOut.value = true;
  try {
    const response = await fetch('/api/sign-out', {
      method: 'POST',
      credentials: 'include'
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to sign out');
    }
    window.location.href = '/';
  } catch (error) {
    console.error('Error signing out:', error);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to sign out'
      });
    } else {
      alert('Failed to sign out');
    }
  } finally {
    signingOut.value = false;
  }
};

onMounted(() => {
  loadUsers();
  loadCustomerBalance();
});
</script>

<style scoped>
.admin-users-table {
  background: white;
}
</style>

