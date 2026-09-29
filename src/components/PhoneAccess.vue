<template>
  <div v-if="line" class="phone-access" :class="{ 'phone-access--warn': line.warn }">
    <q-icon :name="line.icon" size="16px" class="phone-access__icon" />
    <span>{{ line.text }}</span>
    <q-btn v-if="line.action" flat dense no-caps size="sm" color="primary" class="phone-access__btn"
           :label="line.action" :loading="busy" @click="run" />
  </div>
</template>

<script setup lang="ts">
/**
 * Member messages on a phone or in Safari: the folder key travels with the
 * passkey (utils/passkeyFolderKey.ts). On the computer, "Set up with your
 * passkey" stores the passkey copy; on a device without the folder, "Unlock
 * with your passkey" opens it. A passkey sign-in on the computer stores the
 * copy by itself; this line is for doing it now. In the setup checklist and
 * in Workbook → More features.
 */
import { ref, computed, watch } from 'vue';
import { isFileSystemAccessSupported } from '../utils/localFolder';
import { getFolderPrivateJwk } from '../utils/folderKey';
import { preparePasskeyUnlock, passkeyUnlock } from '../utils/passkeyFolderKey';

interface KeyStatus { passkey: boolean; hasFolderKey: boolean; folderKeyOnPasskey: boolean }

const props = defineProps<{
  userId: string;
  /** From the setup checklist's status; fetched here when not given. */
  status?: KeyStatus | null;
}>();
const emit = defineEmits<{ changed: [] }>();

const folderCapable = isFileSystemAccessSupported();
const own = ref<KeyStatus | null>(null);
const hasKeyHere = ref<boolean | null>(null);
const busy = ref(false);
const note = ref('');

const load = async () => {
  if (!props.userId) return;
  hasKeyHere.value = !!(await getFolderPrivateJwk(props.userId).catch(() => null));
  if (props.status) return;
  try {
    const s = await (await fetch(`/api/setup-status?userId=${encodeURIComponent(props.userId)}`, { credentials: 'include' })).json();
    if (s?.success) own.value = { passkey: !!s.steps?.find((x: { key: string; done: boolean }) => x.key === 'passkey')?.done, hasFolderKey: !!s.hasFolderKey, folderKeyOnPasskey: !!s.folderKeyOnPasskey };
  } catch { /* no line */ }
};
watch(() => [props.userId, props.status], () => { void load(); }, { immediate: true });

const status = computed(() => props.status || own.value);
const line = computed(() => {
  const s = status.value;
  if (!s || !s.passkey || !s.hasFolderKey) return null;
  if (note.value) return { icon: 'info_outline', text: note.value, warn: true };
  if (folderCapable) {
    return s.folderKeyOnPasskey
      ? { icon: 'phone_iphone', text: 'Your messages also open on your phone and in Safari, with your passkey.' }
      : { icon: 'phone_iphone', text: 'Read your messages on your phone or in Safari too.', action: 'Set up with your passkey' };
  }
  if (hasKeyHere.value) return { icon: 'lock_open', text: 'Your messages open on this device.' };
  return s.folderKeyOnPasskey
    ? { icon: 'lock', text: 'Your messages are locked on this device.', action: 'Unlock with your passkey' }
    : { icon: 'lock', text: 'To read your messages here, sign in once on your computer with your passkey, then come back.', warn: true };
});

// Safari opens a passkey prompt only straight from a click: fetch its options first.
watch(() => line.value?.action, (a) => { if (a && props.userId) void preparePasskeyUnlock(props.userId); }, { immediate: true });

const run = async () => {
  if (!props.userId || busy.value) return;
  busy.value = true;
  note.value = '';
  try {
    const r = await passkeyUnlock(props.userId);
    if (r === 'no-secret') note.value = 'This passkey can’t carry your folder key (some security keys can’t). Your messages still open on your computer.';
    else if (r === 'failed' || r === 'no-copy') note.value = 'That didn’t work. Try again.';
    own.value = null;
    await load();
    emit('changed');
  } catch {
    note.value = 'The passkey prompt was closed. Try again.';
  } finally {
    busy.value = false;
  }
};
</script>

<style scoped>
.phone-access { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; font-size: 0.75rem; color: #455a64; }
.phone-access--warn { color: #b35c00; }
.phone-access__icon { flex: none; }
.phone-access__btn { margin-left: 2px; }
</style>
