<template>
  <div class="secondary-model-chooser">
    <div class="text-body2 q-mb-sm">
      Choose the model for your secondary Private AI. Every model listed runs on
      DigitalOcean's own servers, like your primary Private AI; none sends your
      records to a public AI company. The agent is connected to your knowledge base.
    </div>
    <div class="text-caption text-grey-7 q-mb-md">
      Prices are DigitalOcean's, per million tokens (input / output); you pay only
      for what the agent processes. A typical question costs well under a cent.
    </div>

    <div v-if="loading" class="text-center q-pa-md">
      <q-spinner size="2em" color="primary" />
      <div class="q-mt-sm text-grey-7">Loading models from DigitalOcean…</div>
    </div>

    <q-banner v-else-if="loadError" class="bg-red-1 text-red-9 rounded-borders q-mb-md">
      <template v-slot:avatar><q-icon name="error" color="red" /></template>
      {{ loadError }}
      <template v-slot:action>
        <q-btn flat color="red" label="Retry" @click="load" />
      </template>
    </q-banner>

    <template v-else>
      <q-markup-table flat bordered dense separator="horizontal" class="q-mb-md">
        <thead>
          <tr>
            <th class="text-left" style="width: 36px"></th>
            <th class="text-left">Model</th>
            <th class="text-right">Parameters<br><span class="text-grey-6">total / active</span></th>
            <th class="text-right">Context</th>
            <th class="text-center">Reads images</th>
            <th class="text-right">$ per 1M tokens<br><span class="text-grey-6">in / out</span></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="m in models"
            :key="m.id"
            class="cursor-pointer"
            :class="{ 'bg-blue-1': selected === m.id }"
            @click="selected = m.id"
          >
            <td><q-radio v-model="selected" :val="m.id" dense :disable="busy" /></td>
            <td>
              <span class="text-weight-medium">{{ m.name }}</span>
              <q-badge v-if="m.isDefault" color="primary" class="q-ml-xs" label="Suggested" />
              <q-badge v-if="m.id === currentModelId" color="grey-7" class="q-ml-xs" label="Current" />
              <q-tooltip v-if="m.description" max-width="360px">{{ m.description }}</q-tooltip>
            </td>
            <td class="text-right">{{ fmtParams(m) }}</td>
            <td class="text-right">{{ fmtContext(m.contextWindow) }}</td>
            <td class="text-center">
              <q-icon :name="m.imageInput ? 'check' : 'remove'" :color="m.imageInput ? 'green-7' : 'grey-5'" />
            </td>
            <td class="text-right">{{ fmtPrice(m.priceInPerM) }} / {{ fmtPrice(m.priceOutPerM) }}</td>
          </tr>
        </tbody>
      </q-markup-table>

      <div class="row items-center q-gutter-sm">
        <q-btn
          color="primary"
          icon="rocket_launch"
          :label="actionLabel"
          :loading="busy"
          :disable="busy || !selected || selected === currentModelId"
          @click="choose"
        />
        <q-btn v-if="cancellable" flat label="Cancel" :disable="busy" @click="emit('cancel')" />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';

interface SecondaryModel {
  id: string;
  name: string;
  paramsTotalB: number | null;
  paramsActiveB: number | null;
  contextWindow: number | null;
  imageInput: boolean;
  priceInPerM: number | null;
  priceOutPerM: number | null;
  description: string;
  isDefault: boolean;
}

const props = withDefaults(defineProps<{
  userId: string;
  actionLabel?: string;
  currentModelId?: string | null;
  busy?: boolean;
  cancellable?: boolean;
}>(), {
  actionLabel: 'Create secondary Private AI',
  currentModelId: null,
  busy: false,
  cancellable: false
});

const emit = defineEmits<{
  choose: [model: { id: string; name: string }];
  cancel: [];
}>();

const models = ref<SecondaryModel[]>([]);
const selected = ref<string>('');
const loading = ref(false);
const loadError = ref('');

const load = async () => {
  loading.value = true;
  loadError.value = '';
  try {
    const r = await fetch(`/api/secondary-models?userId=${encodeURIComponent(props.userId)}`, { credentials: 'include' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.success) throw new Error(d.message || d.error || `HTTP ${r.status}`);
    models.value = Array.isArray(d.models) ? d.models : [];
    // First choice: pre-select the suggested model. Changing an existing
    // agent: pre-select nothing, so the new model is a deliberate pick.
    const current = props.currentModelId || d.current?.id || null;
    selected.value = current ? '' : (d.defaultId || '');
    if (!models.value.length) loadError.value = 'DigitalOcean currently lists no eligible models.';
  } catch (e) {
    loadError.value = `Could not load the model list: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    loading.value = false;
  }
};

const choose = () => {
  const m = models.value.find(x => x.id === selected.value);
  if (m) emit('choose', { id: m.id, name: m.name });
};

const fmtB = (b: number) => (b >= 1000 ? `${(b / 1000).toFixed(b % 1000 === 0 ? 0 : 1)}T` : `${b}B`);
const fmtParams = (m: SecondaryModel) => {
  const total = m.paramsTotalB != null ? fmtB(m.paramsTotalB) : '—';
  const active = m.paramsActiveB != null ? fmtB(m.paramsActiveB) : '—';
  return `${total} / ${active}`;
};
const fmtContext = (n: number | null) => {
  if (!n) return '—';
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  return `${Math.round(n / 1000)}k`;
};
const fmtPrice = (p: number | null) => (p == null ? '—' : `$${p.toFixed(2)}`);

onMounted(load);
</script>
