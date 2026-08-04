<template>
  <div class="pm-matrix">
    <div v-for="col in POLICY_MATRIX" :key="col.key" class="pm-col">
      <div class="pm-col-head">
        {{ col.head }}
        <q-tooltip class="pm-tip" max-width="280px" :delay="300">{{ col.headTip }}</q-tooltip>
      </div>
      <button
        v-for="opt in col.options"
        :key="opt.v"
        type="button"
        class="pm-cell"
        :class="[opt.cls, {
          'is-sel': modelValue[col.key] === opt.v,
          'is-disabled': isDisabled(col, opt)
        }]"
        :aria-pressed="modelValue[col.key] === opt.v"
        :aria-disabled="isDisabled(col, opt) || undefined"
        @click="onPick(col, opt)"
      >
        <span>{{ opt.label }}</span>
        <span v-if="opt.sub" class="pm-sub">{{ opt.sub }}</span>
        <span
          v-if="opt.ah && context === 'author' && modelValue[col.key] === opt.v"
          class="pm-ah"
          @click.stop
        >
          <select :value="ahCategory" @click.stop @change="onAhChange">
            <option v-for="cat in ahCategoryList" :key="cat" :value="cat">{{ cat }}</option>
          </select>
        </span>
        <!-- The teaching layer: every cell explains itself, in every
             context — a visitor can learn the whole policy vocabulary
             before they ever create an account. Disabled cells say why. -->
        <q-tooltip class="pm-tip" max-width="280px" :delay="300">
          {{ opt.tip }}<template v-if="disabledReason(col, opt)"> Disabled here: {{ disabledReason(col, opt) }}</template>
        </q-tooltip>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { POLICY_MATRIX, type MatrixCell, type MatrixColumn, type MatrixContext } from '../utils/policyCards';

const props = withDefaults(defineProps<{
  context: MatrixContext;
  /** Current selection per column key (null/undefined = none). */
  modelValue: Record<string, string | null | undefined>;
  ahCategory?: string;
  ahCategories?: string[];
}>(), { ahCategory: '', ahCategories: undefined });

const emit = defineEmits<{ pick: [key: string, value: string]; 'update:ahCategory': [value: string] }>();

const DEFAULT_AH = ['Lab Results', 'Clinical Vitals', 'Immunizations', 'Conditions', 'Procedures', 'Allergies'];
const ahCategoryList = computed(() => (props.ahCategories?.length ? props.ahCategories : DEFAULT_AH));

const disabledReason = (col: MatrixColumn, opt: MatrixCell): string =>
  col.disabledIn?.[props.context] || opt.disabledIn?.[props.context] || '';
const isDisabled = (col: MatrixColumn, opt: MatrixCell): boolean => !!disabledReason(col, opt);

const onPick = (col: MatrixColumn, opt: MatrixCell) => {
  if (isDisabled(col, opt)) return;
  emit('pick', col.key, opt.v);
};
const onAhChange = (e: Event) => emit('update:ahCategory', (e.target as HTMLSelectElement).value);
</script>

<style scoped>
.pm-matrix {
  --pm-accent: #0e7490;
  --pm-accent-soft: #e2f1f4;
  --pm-respond: #15803d;
  --pm-deny: #b91c1c;
  --pm-ask: #b45309;
  --pm-line: #dde5eb;
  --pm-chip: #f1f5f8;
  --pm-ink: #17222e;
  --pm-muted: #6b7b8b;
  display: grid; grid-template-columns: repeat(5, 1fr); gap: 0;
  border: 1px solid var(--pm-line); border-radius: 10px; overflow: hidden; background: #fff;
  color: var(--pm-ink); font-size: 14px;
}
.pm-col { border-right: 1px solid var(--pm-line); display: flex; flex-direction: column; }
.pm-col:last-child { border-right: none; }
.pm-col-head {
  font-size: 11px; letter-spacing: .05em; text-transform: uppercase; font-weight: 700;
  color: #46586a; padding: 10px 11px; background: var(--pm-chip);
  border-bottom: 1px solid var(--pm-line); min-height: 54px; display: flex; align-items: center;
}
.pm-cell {
  appearance: none; text-align: left; width: 100%; cursor: pointer; background: transparent;
  border: none; border-bottom: 1px solid var(--pm-line); color: var(--pm-ink);
  font: inherit; font-size: 13px; padding: 10px 11px; line-height: 1.32; position: relative;
  transition: background .12s ease, color .12s ease;
}
.pm-col .pm-cell:last-child { border-bottom: none; }
.pm-cell:hover { background: var(--pm-accent-soft); }
.pm-cell:focus-visible { outline: 2px solid var(--pm-accent); outline-offset: -2px; }
.pm-cell.is-sel { background: var(--pm-accent); color: #fff; font-weight: 600; }
.pm-cell.is-sel::after { content: "✓"; position: absolute; right: 9px; top: 12px; font-size: 11px; opacity: .9; }
.pm-cell.act-respond.is-sel { background: var(--pm-respond); }
.pm-cell.act-deny.is-sel { background: var(--pm-deny); }
.pm-cell.act-ask.is-sel { background: var(--pm-ask); }
.pm-cell.is-disabled { opacity: .45; cursor: not-allowed; }
.pm-cell.is-disabled:hover { background: transparent; }
.pm-sub { display: block; font-size: 11px; color: var(--pm-muted); margin-top: 2px; }
.pm-cell.is-sel .pm-sub { color: rgba(255,255,255,.85); }
.pm-ah { display: block; margin-top: 6px; }
.pm-ah select { width: 100%; font: inherit; font-size: 12px; padding: 4px 5px; border-radius: 6px; border: 1px solid #c4d0da; background: #fff; color: var(--pm-ink); }
@media (max-width: 640px) {
  .pm-matrix { grid-template-columns: 1fr; }
  .pm-col { border-right: none; border-bottom: 1px solid var(--pm-line); }
}
</style>
