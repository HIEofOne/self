<template>
  <div class="fp">
    <div class="text-subtitle2">More features</div>
    <div class="text-caption text-grey-7 q-mb-md">
      MAIA starts simple. Each of these stays off until you turn it on, and
      turning one off hides it again without deleting anything. Your private
      AI may suggest one when it would help with what you're doing.
    </div>
    <!-- Member messages on a phone or in Safari (the folder key travels with the passkey) -->
    <div class="fp__item">
      <div class="text-body2 text-weight-medium">Your MAIA on your phone and in Safari</div>
      <div class="text-caption text-grey-8 q-mb-xs">
        Sign in there with your passkey to read messages, answer requests and chat with your private AI.
        Your MAIA folder stays on your computer, and catches up there.
      </div>
      <PhoneAccess :user-id="userId" />
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
        <q-spinner v-if="indexState === 'running' || indexState === 'uploading'" size="14px" color="primary" />
        <q-icon v-else-if="indexState === 'done'" name="check_circle" color="green-7" size="15px" />
        <q-icon v-else-if="indexState === 'error'" name="error_outline" color="orange-8" size="15px" />
        <span>{{ indexLine }}</span>
        <q-btn v-if="['pending', 'error', 'done', 'no-records', 'no-permission', 'upload-failed'].includes(indexState)" dense flat no-caps size="sm" color="primary"
               :label="indexState === 'done' ? 'Add new records from my folder' : 'Index my records now'" :loading="busy === 'index'" @click="index" />
      </div>
      <div v-if="f.key === 'records-index' && f.enabled" class="fp__files text-caption">
        <a href="#" @click.prevent="emit('open-files')">See your record files in Saved Files</a>
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
import PhoneAccess from './PhoneAccess.vue';
import { setFeature } from '../utils/advisorProposals';
import { recordsIndexProgress, startRecordsIndexing, uploadWords, progressWords, INDEX_WORDS, type IndexState } from '../utils/recordsSearch';

const props = defineProps<{ userId: string }>();
const emit = defineEmits<{ 'open-files': [] }>();
const { state, load } = useEdition();

const features = computed(() => Object.entries(state.features)
  .filter(([, f]) => f.available && f.unlockable)
  .map(([key, f]) => ({ key, ...f })));

const busy = ref('');
const error = ref('');
const indexState = ref<IndexState>('unknown');
// While indexing runs: the job's start, tokens and files (polled), and a
// clock that ticks every second.
const progress = ref({ startedAt: null as string | null, tokens: 0, filesIndexed: 0, filesTotal: 0, estimateMinutes: null as number | null });
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;
let clock: ReturnType<typeof setInterval> | null = null;
const stopPolling = () => {
  if (timer) { clearInterval(timer); timer = null; }
  if (clock) { clearInterval(clock); clock = null; }
};
const refreshIndex = async () => {
  if (!props.userId || !state.features['records-index']?.enabled) return;
  const p = await recordsIndexProgress(props.userId);
  indexState.value = p.state;
  progress.value = { startedAt: p.startedAt, tokens: p.tokens, filesIndexed: p.filesIndexed, filesTotal: p.filesTotal, estimateMinutes: p.estimateMinutes };
  if (indexState.value === 'running') {
    if (!timer) timer = setInterval(refreshIndex, 5000);
    if (!clock) clock = setInterval(() => { now.value = Date.now(); }, 1000);
  } else {
    stopPolling();
  }
};

// Upload the folder's records MAIA doesn't have yet, then index them.
const uploadNote = ref('');
const lastUpload = ref('');
const indexLine = computed(() => (indexState.value === 'uploading' && uploadNote.value
  ? uploadNote.value
  : [lastUpload.value, indexState.value === 'running' ? progressWords(progress.value, now.value) : INDEX_WORDS[indexState.value]].filter(Boolean).join(' ')));
const index = async () => {
  busy.value = 'index';
  indexState.value = 'uploading';
  try {
    const r = await startRecordsIndexing(props.userId, (done, total, name) => {
      uploadNote.value = total ? `Uploading record files from your MAIA folder: ${done} of ${total}${name ? ` (${name})` : ''}…` : '';
    });
    lastUpload.value = uploadWords(r.upload);
    indexState.value = r.state;
  } finally { busy.value = ''; uploadNote.value = ''; }
  if (!['no-folder', 'no-permission', 'upload-failed'].includes(indexState.value)) await refreshIndex();
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
.fp__files { margin-top: 4px; margin-left: 20px; }
.fp__files a { color: #1976d2; }
</style>
