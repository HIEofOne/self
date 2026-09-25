<template>
  <div class="smr">
    <div v-if="caption" class="text-caption text-grey-7 q-mb-xs">{{ caption }}</div>
    <div v-if="differsFrom" class="smr-differs row items-center no-wrap q-mb-sm q-pa-sm">
      <q-icon name="info_outline" size="18px" color="orange-9" class="q-mr-sm" />
      <div class="col text-caption">Your verified medication list differs from this one.</div>
      <q-btn flat dense no-caps color="primary" label="Use that list" @click="emit('update:modelValue', [...differsFrom])" />
    </div>

    <div v-for="(row, idx) in modelValue" :key="`${idx}-${row}`" class="row items-center no-wrap smr-row">
      <q-btn flat dense round size="sm" icon="delete" color="grey-7" :disable="disabled || editing !== null"
             aria-label="Remove this medicine" @click="remove(idx)">
        <q-tooltip>Remove</q-tooltip>
      </q-btn>
      <q-btn flat dense round size="sm" icon="edit" color="grey-7" :disable="disabled || editing !== null"
             aria-label="Edit this medicine" @click="startEdit(idx)">
        <q-tooltip>Edit</q-tooltip>
      </q-btn>
      <input v-if="editing === idx" ref="editInput" v-model="editText" type="text" class="col q-ml-sm smr-input"
             @keyup.enter="commitEdit" @keyup.esc="editing = null" @blur="commitEdit" />
      <span v-else class="col q-ml-sm text-body2" v-html="renderRow ? renderRow(row) : escape(row)"
            @click="emit('citation-click', $event)"></span>
      <q-badge v-if="needsCheck(row)" outline color="orange-9" class="q-ml-sm" label="check">
        <q-tooltip max-width="260px">Your private AI found this one in your records. Check that you still take it.</q-tooltip>
      </q-badge>
    </div>
    <div v-if="!modelValue.length" class="text-body2 text-grey-8 q-ml-sm q-my-xs">None</div>

    <div class="row items-center no-wrap q-mt-xs">
      <q-icon name="add" size="18px" color="grey-7" class="q-mx-sm" />
      <input v-model="newRow" type="text" class="col smr-input" :disabled="disabled"
             placeholder="Add a medicine (name, dose, how often)" @keyup.enter="add" />
      <q-btn flat dense no-caps color="primary" label="Add" :disable="disabled || !newRow.trim()" @click="add" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref } from 'vue';
import { drugKey } from '../utils/summaryMeds';

/**
 * The Current Medications section of the Patient Summary as rows (P7d): the
 * patient checks, edits, removes or adds medicines right in the summary
 * they are about to verify. The parent joins the rows back into the text.
 */
const props = defineProps<{
  modelValue: string[];
  caption?: string;
  /** Drug keys of the records' own list; a row outside it gets "check".
   *  null = no structured list to compare with (every row is the AI's). */
  recordKeys?: string[] | null;
  /** A separately verified list that differs (offered once, P7d migration). */
  differsFrom?: string[] | null;
  renderRow?: (row: string) => string;
  disabled?: boolean;
}>();
const emit = defineEmits<{
  'update:modelValue': [rows: string[]];
  'citation-click': [event: MouseEvent];
}>();

const editing = ref<number | null>(null);
const editText = ref('');
const newRow = ref('');
const editInput = ref<HTMLInputElement[] | HTMLInputElement | null>(null);

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

const needsCheck = (row: string) => {
  if (props.recordKeys === undefined) return false;
  if (props.recordKeys === null) return true;
  const key = drugKey(row);
  return !!key && !props.recordKeys.includes(key);
};

const remove = (idx: number) => emit('update:modelValue', props.modelValue.filter((_, i) => i !== idx));

const startEdit = async (idx: number) => {
  editing.value = idx;
  editText.value = props.modelValue[idx];
  await nextTick();
  const el = Array.isArray(editInput.value) ? editInput.value[0] : editInput.value;
  el?.focus();
};

const commitEdit = () => {
  if (editing.value === null) return;
  const idx = editing.value;
  editing.value = null;
  const text = editText.value.trim();
  if (text === props.modelValue[idx]) return;
  emit('update:modelValue', text
    ? props.modelValue.map((r, i) => (i === idx ? text : r))
    : props.modelValue.filter((_, i) => i !== idx));
};

const add = () => {
  const text = newRow.value.trim();
  if (!text) return;
  emit('update:modelValue', [...props.modelValue, text]);
  newRow.value = '';
};
</script>

<style scoped>
.smr {
  border-left: 3px solid #1976d2;
  padding: 4px 0 4px 8px;
  margin: 4px 0 12px;
}
.smr-row {
  min-height: 32px;
}
.smr-input {
  border: 1px solid #bbb;
  border-radius: 4px;
  padding: 4px 8px;
  font-family: inherit;
  font-size: 14px;
}
.smr-differs {
  background: #fff8e1;
  border-radius: 4px;
}
</style>
