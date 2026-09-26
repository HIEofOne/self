<template>
  <div class="fp">
    <div class="text-subtitle2">More features</div>
    <div class="text-caption text-grey-7 q-mb-md">
      MAIA starts simple. Each of these stays off until you turn it on, and
      turning one off hides it again without deleting anything. Your private
      AI may suggest one when it would help with what you're doing.
    </div>
    <div v-if="!features.length" class="text-caption text-grey-7">Nothing more to turn on here.</div>
    <div v-for="f in features" :key="f.key" class="fp__item" :class="{ 'fp__item--on': f.enabled }">
      <div class="row items-start no-wrap">
        <div class="col">
          <div class="text-body2 text-weight-medium">{{ f.name }}</div>
          <div class="text-caption text-grey-8">{{ f.description }}</div>
          <div v-if="f.whatItMeans" class="text-caption text-grey-7 q-mt-xs">What turning it on means: {{ f.whatItMeans }}</div>
        </div>
        <q-toggle :model-value="f.enabled" :disable="busy === f.key" color="primary" @update:model-value="(v: boolean) => toggle(f.key, v)"
                  :aria-label="`${f.enabled ? 'Turn off' : 'Turn on'} ${f.name}`" />
      </div>
      <!-- Search all my records: the index is built once turned on -->
      <div v-if="f.key === 'records-index' && f.enabled" class="fp__index text-caption">
        <q-spinner v-if="indexState === 'running'" size="14px" color="primary" />
        <q-icon v-else-if="indexState === 'done'" name="check_circle" color="green-7" size="15px" />
        <q-icon v-else-if="indexState === 'error'" name="error_outline" color="orange-8" size="15px" />
        <span>{{ INDEX_WORDS[indexState] }}</span>
        <q-btn v-if="indexState === 'pending' || indexState === 'error'" dense flat no-caps size="sm" color="primary"
               label="Index my records now" :loading="busy === 'index'" @click="index" />
      </div>
    </div>
    <div v-if="error" class="text-negative text-caption q-mt-sm">{{ error }}</div>
  </div>
</template>

<script setup lang="ts">
/**
 * More features (Personal AS edition, group_requests.md §4.2, I-27): every
 * feature the patient can turn on, in the feature registry's own words,
 * with a switch only the patient flips. "Search all my records" also shows
 * its index and can start it.
 */
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useEdition } from '../composables/useEdition';
import { setFeature } from '../utils/advisorProposals';
import { recordsIndexState, startRecordsIndexing, INDEX_WORDS, type IndexState } from '../utils/recordsSearch';

const props = defineProps<{ userId: string }>();
const { state, load } = useEdition();

const features = computed(() => Object.entries(state.features)
  .filter(([, f]) => f.available && f.unlockable)
  .map(([key, f]) => ({ key, ...f })));

const busy = ref('');
const error = ref('');
const indexState = ref<IndexState>('unknown');
let timer: ReturnType<typeof setInterval> | null = null;
const stopPolling = () => { if (timer) { clearInterval(timer); timer = null; } };
const refreshIndex = async () => {
  if (!props.userId || !state.features['records-index']?.enabled) return;
  indexState.value = await recordsIndexState(props.userId);
  if (indexState.value === 'running' && !timer) timer = setInterval(refreshIndex, 10000);
  if (indexState.value !== 'running') stopPolling();
};

const index = async () => {
  busy.value = 'index';
  try { indexState.value = await startRecordsIndexing(props.userId); } finally { busy.value = ''; }
  await refreshIndex();
};

const toggle = async (key: string, on: boolean) => {
  busy.value = key;
  error.value = '';
  try {
    if (!(await setFeature(props.userId, key, on, 'settings'))) throw new Error();
    await load(true);
    if (key === 'records-index' && on) await index();
  } catch {
    error.value = 'That change couldn’t be saved. Try again.';
  } finally {
    busy.value = '';
  }
};

onMounted(() => { void load(true).then(refreshIndex); });
onUnmounted(stopPolling);
watch(() => state.features['records-index']?.enabled, (on) => { if (on) void refreshIndex(); else stopPolling(); });
</script>

<style scoped>
.fp { padding: 16px; }
.fp__item { border: 1px solid #e0e0e0; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
.fp__item--on { border-color: #90caf9; background: #f7fbff; }
.fp__index { display: flex; align-items: center; gap: 6px; margin-top: 8px; color: #455a64; }
</style>
