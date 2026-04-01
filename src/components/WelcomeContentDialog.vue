<template>
  <q-dialog v-model="isOpen" maximized>
    <q-card>
      <q-card-section class="row items-center q-pb-none">
        <div class="text-h6">{{ title }}</div>
        <q-space />
        <q-btn icon="close" flat round dense v-close-popup />
      </q-card-section>

      <q-card-section style="max-height: calc(100vh - 50px); overflow-y: auto;">
        <div v-if="loading" class="text-center q-pa-lg">
          <q-spinner size="2em" />
          <div class="q-mt-sm">Loading...</div>
        </div>
        <!-- FAQ: accordion of questions -->
        <div v-else-if="props.section === 'faq' && faqItems.length > 0" class="welcome-section-content">
          <q-list>
            <q-expansion-item
              v-for="(item, idx) in faqItems"
              :key="idx"
              :label="item.question"
              header-class="text-weight-medium text-body1"
              expand-icon-class="text-grey-7"
              class="faq-item"
            >
              <q-card>
                <q-card-section class="text-body2 text-grey-8 q-pt-none">
                  <vue-markdown :source="item.answer" />
                </q-card-section>
              </q-card>
            </q-expansion-item>
          </q-list>
        </div>
        <!-- Privacy / About: rendered markdown -->
        <div v-else-if="sectionContent" class="welcome-section-content">
          <vue-markdown :source="sectionContent" />
        </div>
      </q-card-section>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import VueMarkdown from 'vue-markdown-render';

interface Props {
  modelValue: boolean;
  section: 'privacy' | 'faq' | 'about';
}

const props = defineProps<Props>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();

const isOpen = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val)
});

const titles: Record<string, string> = {
  privacy: 'Privacy',
  faq: 'FAQ',
  about: 'About'
};

const title = computed(() => titles[props.section] || '');

interface FaqItem {
  question: string;
  answer: string;
}

const sectionContent = ref<string>('');
const faqItems = ref<FaqItem[]>([]);
const loading = ref(false);

let cachedMarkdown: string | null = null;

const extractSection = (markdown: string, sectionName: string): string => {
  const marker = `<!-- SECTION:${sectionName} -->`;
  const start = markdown.indexOf(marker);
  if (start === -1) return '';

  const contentStart = start + marker.length;

  // Find the next section marker or end of file
  const nextMarker = markdown.indexOf('<!-- SECTION:', contentStart);
  const content = nextMarker === -1
    ? markdown.slice(contentStart)
    : markdown.slice(contentStart, nextMarker);

  return content.trim();
};

/** Parse FAQ markdown into question/answer pairs.
 *  Expects top-level `* **Question?**` with nested `  * answer` lines. */
const parseFaqItems = (markdown: string): FaqItem[] => {
  const items: FaqItem[] = [];
  const lines = markdown.split('\n');
  let currentQuestion = '';
  let answerLines: string[] = [];

  const flush = () => {
    if (currentQuestion) {
      items.push({ question: currentQuestion, answer: answerLines.join('\n').trim() });
    }
    currentQuestion = '';
    answerLines = [];
  };

  for (const line of lines) {
    // Top-level list item with bold text = question
    const qMatch = line.match(/^\*\s+\*\*(.+?)\*\*\s*$/);
    if (qMatch) {
      flush();
      currentQuestion = qMatch[1];
      continue;
    }
    // Nested list item or continuation = answer
    if (currentQuestion && line.match(/^\s{2,}\*/)) {
      // Convert nested `  * text` to markdown bullet
      answerLines.push(line.replace(/^\s{2,}\*\s*/, '- '));
    } else if (currentQuestion && line.trim() === '') {
      answerLines.push('');
    }
  }
  flush();
  return items;
};

const loadSection = async () => {
  if (!props.modelValue) return;

  loading.value = true;
  try {
    if (!cachedMarkdown) {
      const response = await fetch('/welcome.md', { cache: 'no-cache' });
      if (!response.ok) throw new Error(`Failed to load: ${response.status}`);
      cachedMarkdown = await response.text();
    }
    const raw = extractSection(cachedMarkdown, props.section);
    if (props.section === 'faq') {
      faqItems.value = parseFaqItems(raw);
      sectionContent.value = '';
    } else {
      faqItems.value = [];
      sectionContent.value = raw;
    }
  } catch (err) {
    console.error('Error loading welcome content:', err);
    sectionContent.value = 'Unable to load content.';
    faqItems.value = [];
  } finally {
    loading.value = false;
  }
};

watch(() => props.modelValue, (newVal) => {
  if (newVal) loadSection();
});
</script>

<style scoped>
.welcome-section-content {
  line-height: 1.6;
}

.welcome-section-content :deep(h2) {
  font-size: 1.4rem;
  margin-top: 1.2rem;
  margin-bottom: 0.8rem;
  font-weight: bold;
}

.welcome-section-content :deep(p) {
  margin-bottom: 1rem;
}

.welcome-section-content :deep(strong) {
  font-weight: bold;
}

.welcome-section-content :deep(a) {
  color: #1976d2;
  text-decoration: none;
}

.welcome-section-content :deep(a:hover) {
  text-decoration: underline;
}

.welcome-section-content :deep(ul), .welcome-section-content :deep(ol) {
  margin-left: 1.5rem;
  margin-bottom: 1rem;
}

.welcome-section-content :deep(li) {
  margin-bottom: 0.5rem;
}

.faq-item {
  border-bottom: 1px solid #e0e0e0;
}

.faq-item:last-child {
  border-bottom: none;
}
</style>
