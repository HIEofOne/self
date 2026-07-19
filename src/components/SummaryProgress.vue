<template>
  <div>
    <div class="text-subtitle2 q-mb-sm">Generating Patient Summary... {{ elapsed }}s</div>
    <div v-for="(step, i) in steps" :key="i" class="row items-center q-mb-xs" style="font-size: 0.85rem;">
      <q-icon
        :name="i < current ? 'check_circle' : (i === current ? 'hourglass_top' : 'radio_button_unchecked')"
        :color="i < current ? 'positive' : (i === current ? 'primary' : 'grey-5')"
        size="18px"
        class="q-mr-sm"
      />
      <span :class="i <= current ? 'text-dark' : 'text-grey-5'">{{ step.label }}</span>
      <q-spinner v-if="i === current" size="14px" color="primary" class="q-ml-sm" />
    </div>
    <div v-if="current >= steps.length" class="row items-center q-mb-xs" style="font-size: 0.85rem;">
      <q-icon name="hourglass_top" color="primary" size="18px" class="q-mr-sm" />
      <span class="text-dark">AI is drafting your summary — the long step (typically 1–3 minutes, up to 20 for large records)...</span>
      <q-spinner size="14px" color="primary" class="q-ml-sm" />
    </div>
  </div>
</template>

<script setup lang="ts">
// The one Patient Summary progress checklist — used by the Patient
// Summary tab AND the chat-typed request modal, so every trigger shows
// the same steps. The scripted steps are pacing theater; the open-ended
// tail line is the honest part (the AI call runs minutes).
import { ref, onMounted, onUnmounted } from 'vue';

const steps = [
  { label: 'Parsing patient identity from PDF headers', delay: 2 },
  { label: 'Extracting verified medications', delay: 3 },
  { label: 'Scanning Apple Health for out-of-range labs', delay: 6 },
  { label: 'Extracting allergies', delay: 8 },
  { label: 'Extracting encounters (past 12 months)', delay: 11 },
  { label: 'Extracting medical & social history', delay: 14 },
  { label: 'Extracting radiology / imaging', delay: 17 },
  { label: 'Building stopped medications list', delay: 20 },
  { label: 'Querying AI agent with knowledge base...', delay: 23 }
];
const elapsed = ref(0);
const current = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  timer = setInterval(() => {
    elapsed.value++;
    const next = steps.findIndex(s => s.delay > elapsed.value);
    current.value = next < 0 ? steps.length : next;
  }, 1000);
});
onUnmounted(() => { if (timer) clearInterval(timer); });
</script>
