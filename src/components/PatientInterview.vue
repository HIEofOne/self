<template>
  <q-dialog :model-value="modelValue" :persistent="drafting" @update:model-value="(v) => emit('update:modelValue', v)">
    <q-card class="pi-card">
      <q-card-section class="q-pb-sm">
        <div class="text-h6">Your Patient Summary</div>
        <div class="text-caption text-grey-8">
          Answer what you can; your private AI writes a summary a new doctor can read.
          You review it before anything is saved.
        </div>
      </q-card-section>

      <q-card-section v-if="drafting" class="q-pt-none">
        <div class="row items-center no-wrap q-gutter-sm q-pa-md">
          <q-spinner size="1.6em" color="primary" />
          <div class="text-body2">{{ waitingForAi ? PRIVATE_AI_WAIT_TEXT : 'Your private AI is writing your summary. This usually takes about a minute.' }}</div>
        </div>
      </q-card-section>

      <q-card-section v-else class="q-pt-none pi-fields">
        <div class="row q-col-gutter-sm">
          <div class="col-12 col-sm-6"><q-input v-model="a.name" dense outlined label="Your name" maxlength="120" /></div>
          <div class="col-6 col-sm-3"><q-input v-model="a.dateOfBirth" dense outlined label="Date of birth" maxlength="40" /></div>
          <div class="col-6 col-sm-3"><q-input v-model="a.sex" dense outlined label="Sex" maxlength="40" /></div>
        </div>
        <q-input v-model="a.conditions" type="textarea" autogrow dense outlined maxlength="4000"
                 label="Health conditions and past surgeries" />
        <q-input v-model="a.medications" type="textarea" autogrow dense outlined maxlength="4000"
                 label="Medicines you take now (name, dose, how often)" />
        <q-input v-model="a.allergies" type="textarea" autogrow dense outlined maxlength="2000"
                 label="Allergies (and what happens)" />
        <q-input v-model="a.recentVisits" type="textarea" autogrow dense outlined maxlength="4000"
                 label="Doctors you've seen in the past year, and why (optional)" />
        <q-input v-model="a.other" type="textarea" autogrow dense outlined maxlength="4000"
                 label="Anything else a new doctor should know (optional)" />
        <div v-if="error" class="text-negative text-caption">{{ error }}</div>
      </q-card-section>

      <q-card-actions v-if="!drafting" align="right" class="q-px-md q-pb-md">
        <q-btn flat no-caps label="Cancel" @click="emit('update:modelValue', false)" />
        <q-btn unelevated no-caps color="primary" label="Write my summary" :disable="!enough" @click="submit" />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { waitForStageDone } from '../utils/pipeline';
import { PRIVATE_AI_WAIT_TEXT, privateAiNotReadyText, waitForPrivateAi } from '../utils/privateAi';

/**
 * Patient Summary by interview (Personal AS edition, D11): the answers go to
 * the private AI, and the draft comes back to the caller, which opens the
 * existing review dialog — the only way to save and verify a summary.
 */
const props = defineProps<{ modelValue: boolean; userId: string }>();
const emit = defineEmits<{
  'update:modelValue': [open: boolean];
  drafted: [text: string];
}>();

const blank = () => ({ name: '', dateOfBirth: '', sex: '', conditions: '', medications: '', allergies: '', recentVisits: '', other: '' });
const a = reactive(blank());
const drafting = ref(false);
const waitingForAi = ref(false);
const error = ref('');
const enough = computed(() => !!(a.conditions.trim() || a.medications.trim() || a.allergies.trim()));

// Prefill with the answers given last time.
watch(() => props.modelValue, async (open) => {
  if (!open || drafting.value) return;
  error.value = '';
  try {
    const r = await fetch(`/api/patient-summary/interview?userId=${encodeURIComponent(props.userId)}`, { credentials: 'include' });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.answers) Object.assign(a, blank(), d.answers);
  } catch { /* start blank */ }
});

const submit = async () => {
  if (!enough.value || drafting.value) return;
  error.value = '';
  drafting.value = true;
  try {
    // A new account's private AI may still be deploying: wait for it.
    const ready = await waitForPrivateAi({ onWaiting: () => { waitingForAi.value = true; } });
    waitingForAi.value = false;
    if (ready !== 'ready') throw new Error(privateAiNotReadyText(ready));
    const r = await fetch('/api/patient-summary/interview', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: props.userId, answers: { ...a } })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.success) throw new Error(d.message || d.error || 'Could not start your summary.');
    const status = await waitForStageDone(props.userId, 'summaryDrafted', 5 * 60 * 1000, 4000);
    if (status !== 'done') {
      throw new Error(status === 'timeout'
        ? 'Your summary is taking longer than usual. Try again in a few minutes.'
        : 'Your private AI could not write the summary. Try again.');
    }
    const g = await fetch(`/api/patient-summary?userId=${encodeURIComponent(props.userId)}`, { credentials: 'include' });
    const gd = await g.json().catch(() => ({}));
    const text = String(gd?.draft?.text || '').trim();
    if (!text) throw new Error('The summary was written but could not be loaded. Open Patient Summary again.');
    emit('update:modelValue', false);
    emit('drafted', text);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    drafting.value = false;
    waitingForAi.value = false;
  }
};
</script>

<style scoped>
.pi-card {
  width: 640px;
  max-width: 95vw;
}
.pi-fields > * + * {
  margin-top: 10px;
}
</style>
