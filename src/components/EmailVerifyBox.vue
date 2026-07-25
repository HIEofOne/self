<template>
  <div class="evb">
    <!-- Verified -->
    <div v-if="state.verified" class="evb-verified">
      <q-icon name="verified" size="18px" class="evb-check" />
      <span class="evb-verified-text">Email verified: <b>{{ state.email }}</b></span>
      <button type="button" class="evb-link" @click="beginEdit">Change</button>
    </div>

    <!-- Enter email → send code -->
    <template v-else>
      <div class="evb-row">
        <q-input
          v-model="emailModel"
          dense outlined type="email"
          :label="label"
          class="evb-input"
          :disable="state.sending"
          @keydown.enter.prevent="onSend"
        />
        <q-btn
          unelevated color="primary" no-caps
          :label="state.codeSent ? 'Resend code' : 'Send code'"
          :loading="state.sending"
          :disable="!isValid(state.email)"
          @click="onSend"
        />
      </div>

      <!-- Enter the code → verify -->
      <div v-if="state.codeSent" class="evb-row evb-code-row">
        <q-input
          v-model="code"
          dense outlined
          label="6-digit code"
          class="evb-code-input"
          inputmode="numeric"
          maxlength="6"
          :disable="state.verifying"
          @keydown.enter.prevent="onVerify"
        />
        <q-btn
          unelevated color="primary" no-caps label="Verify"
          :loading="state.verifying"
          :disable="!code.trim()"
          @click="onVerify"
        />
      </div>

      <div v-if="state.codeSent && !state.error" class="evb-hint">
        We sent a code to <b>{{ state.email }}</b>. Enter it above.
        <span v-if="state.devCode" class="evb-dev">(dev: {{ state.devCode }})</span>
      </div>
      <div v-if="state.error" class="evb-error">{{ state.error }}</div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useVerifiedEmail } from '../composables/verifiedEmail';

withDefaults(defineProps<{ label?: string }>(), { label: 'Email address' });

const { state, isValid, setEmail, sendCode, verifyCode, beginEdit } = useVerifiedEmail();
const code = ref('');

const emailModel = computed({
  get: () => state.email,
  set: (v: string) => setEmail(v)
});

const onSend = async () => { await sendCode(); };
const onVerify = async () => { const ok = await verifyCode(code.value); if (ok) code.value = ''; };
</script>

<style scoped>
.evb { font-size: 14px; }
.evb-row { display: flex; gap: 8px; align-items: flex-start; }
.evb-input { flex: 1 1 auto; min-width: 0; }
.evb-code-row { margin-top: 8px; }
.evb-code-input { flex: 0 0 150px; }
.evb-hint { margin-top: 6px; font-size: 12.5px; color: #6b7b8b; }
.evb-dev { color: #b45309; font-weight: 600; }
.evb-error { margin-top: 6px; font-size: 12.5px; color: #b91c1c; }

.evb-verified { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 8px; background: #e7f4ec; border: 1px solid rgba(21,128,61,.3); }
.evb-check { color: #15803d; }
.evb-verified-text { color: #17222e; font-size: 13.5px; }
.evb-link { appearance: none; background: none; border: none; padding: 0; margin-left: auto; color: #0e7490; font: inherit; font-size: 12.5px; text-decoration: underline; cursor: pointer; }
</style>
