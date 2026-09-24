<template>
  <div class="welcome-content">
    <template v-for="(node, i) in nodes" :key="i">
      <!-- Live component slots (badges / policies / checkboxes / footer) -->
      <div v-if="node.type === 'slot'" class="wc-slot" :class="'wc-slot--' + node.name">
        <slot :name="node.name" />
      </div>

      <!-- FAQ item: expands one at a time -->
      <div v-else-if="node.type === 'faq'" class="wc-faq">
        <button
          type="button"
          class="wc-faq-head"
          :class="{ open: openFaq === node.idx }"
          :aria-expanded="openFaq === node.idx"
          @click="toggleFaq(node.idx)"
        >
          <span class="wc-faq-title">{{ node.title }}</span>
          <svg class="wc-faq-chevron" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
            <path d="M6 8l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <transition name="wc-expand" @enter="onEnter" @afterEnter="onAfterEnter" @leave="onLeave">
          <div v-show="openFaq === node.idx" class="wc-faq-body-wrap">
            <div class="wc-faq-body wc-prose">
              <div v-html="node.html"></div>
              <!-- Live editor / request table embedded in this FAQ item -->
              <div v-if="node.slot" class="wc-faq-slot" :class="'wc-slot--' + node.slot">
                <slot :name="node.slot" />
              </div>
            </div>
          </div>
        </transition>
      </div>

      <!-- Plain prose (headline, tagline). Clicks on a `#` link fire sign-in. -->
      <div v-else class="wc-prose" :class="{ 'wc-lede': node.lede }" v-html="node.html" @click="onProseClick"></div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import MarkdownIt from 'markdown-it';
import raw from '../content/welcome_A.md?raw';

const emit = defineEmits<{ 'sign-in': [] }>();

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
const defaultLinkOpen = md.renderer.rules.link_open
  || ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet('href') || '';
  if (/^https?:\/\//.test(href)) {
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener');
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

type Node =
  | { type: 'slot'; name: string }
  | { type: 'faq'; idx: number; title: string; html: string; slot?: string }
  | { type: 'prose'; html: string; lede: boolean };

// Map the natural-language marker text to a section kind by keyword, so
// the editable file can describe each marker in prose ("Policies editor,
// request, and response examples goes here") rather than a code token.
const markerKind = (text: string): 'header' | 'faq' | 'policies' | 'request' | 'checkboxes' | 'footer' | 'prose' => {
  const t = text.toLowerCase();
  // Order matters: the checkboxes marker text mentions "...after the
  // welcome FAQ", so the specific slots are matched BEFORE the /faq/
  // fallback, which then only catches the actual "Welcome FAQ" marker.
  // "request" is checked before "polic": the request/response marker text
  // ("Policies editor, request, and response blocks go here") contains both.
  if (/badge|header/.test(t)) return 'header';
  if (/request|response/.test(t)) return 'request';
  if (/polic/.test(t)) return 'policies';
  if (/checkbox|setup/.test(t)) return 'checkboxes';
  if (/footer/.test(t)) return 'footer';
  if (/faq/.test(t)) return 'faq';
  return 'prose';
};

/** Parse welcome_*.md into ordered nodes. `<<< ... >>>` markers delimit
 *  sections (matched by keyword); `### Heading` lines become FAQ items
 *  (expand one at a time, in file order); everything else is prose.
 *  In the header section the "Welcome to MAIA" title and the sign-in
 *  sentence are rendered by the LIVE badges component slotted above, so
 *  they're dropped here to avoid a duplicate. */
const nodes = computed<Node[]>(() => {
  const body = raw.replace(/<!--[\s\S]*?-->/g, '').trim();
  const lines = body.split('\n');
  const out: Node[] = [];
  let faqIdx = 0;
  let buf: string[] = [];
  let blockMode: 'prose' | 'faq' = 'prose';
  let inHeader = false;
  let faqTitle = '';

  const flush = () => {
    let text = buf.join('\n').trim();
    buf = [];
    if (blockMode === 'faq') {
      out.push({ type: 'faq', idx: faqIdx++, title: faqTitle, html: md.render(text) });
      return;
    }
    if (inHeader) {
      // Drop the lines the live badges/sign-in component already shows.
      text = text.split('\n')
        .filter((l) => !/^welcome to maia\.?$/i.test(l.trim()))
        .filter((l) => !/sign-in with a passkey/i.test(l))
        .join('\n').trim();
    }
    if (text) out.push({ type: 'prose', html: md.render(text), lede: /^##\s/m.test(text) });
  };

  for (const line of lines) {
    const marker = line.match(/^<<<\s*(.+?)\s*>>>\s*$/);
    if (marker) {
      const kind = markerKind(marker[1]);
      // A policies/request marker that immediately follows a FAQ item is
      // embedded INSIDE that item's collapsible body (so the editor +
      // request table expand and collapse together with the question),
      // rather than rendered as a standalone section.
      if ((kind === 'policies' || kind === 'request') && blockMode === 'faq') {
        out.push({ type: 'faq', idx: faqIdx++, title: faqTitle, html: md.render(buf.join('\n').trim()), slot: kind });
        buf = [];
        blockMode = 'prose';
        inHeader = false;
        continue;
      }
      flush();
      blockMode = 'prose';
      if (kind === 'header') {
        // The live sign-in + badges render just ABOVE this component; the
        // header marker here only carries the editable headline/tagline.
        inHeader = true;
      } else {
        inHeader = false;
        if (kind !== 'faq') out.push({ type: 'slot', name: kind });
        // FAQ marker: no slot — the following ### items are the content.
      }
      continue;
    }
    const h3 = line.match(/^###\s+(.*)$/);
    if (h3) { flush(); blockMode = 'faq'; inHeader = false; faqTitle = h3[1].trim(); continue; }
    buf.push(line);
  }
  flush();
  return out;
});

// One FAQ open at a time.
const openFaq = ref<number | null>(null);
const toggleFaq = (idx: number) => { openFaq.value = openFaq.value === idx ? null : idx; };

// The sign-in link in the header prose is a `#` anchor — route it to the
// live passkey flow instead of navigating.
const onProseClick = (e: MouseEvent) => {
  const a = (e.target as HTMLElement).closest('a');
  if (a && (a.getAttribute('href') === '#' || /sign-in/i.test(a.textContent || ''))) {
    e.preventDefault();
    emit('sign-in');
  }
};

// Height animation for expand/collapse.
const onEnter = (el: Element) => {
  const e = el as HTMLElement;
  e.style.height = '0'; void e.offsetHeight;
  e.style.height = e.scrollHeight + 'px';
};
const onAfterEnter = (el: Element) => { (el as HTMLElement).style.height = 'auto'; };
const onLeave = (el: Element) => {
  const e = el as HTMLElement;
  e.style.height = e.scrollHeight + 'px'; void e.offsetHeight;
  e.style.height = '0';
};
</script>

<style scoped>
.welcome-content { max-width: 760px; margin: 0 auto; }
.wc-slot { margin: 20px 0; }
.wc-slot--header { margin: 0 0 6px; }

/* Prose */
.wc-prose { color: #46586a; line-height: 1.6; }
.wc-prose :deep(h2) {
  font-size: clamp(24px, 3.4vw, 32px); font-weight: 650; color: #17222e;
  text-align: center; margin: 4px 0 10px; line-height: 1.15; text-wrap: balance;
}
.wc-lede :deep(p) { text-align: center; max-width: 640px; margin: 0 auto 4px; font-size: 15.5px; }
.wc-prose :deep(a) { color: #0e7490; text-decoration: underline; }
.wc-prose :deep(ul) { margin: 6px 0; padding-left: 20px; }
.wc-prose :deep(li) { margin: 5px 0; }
.wc-prose :deep(strong) { color: #17222e; }

/* FAQ accordion */
.wc-faq { border-bottom: 1px solid #e6ecf1; }
.wc-faq:first-of-type { border-top: 1px solid #e6ecf1; }
.wc-faq-head {
  width: 100%; appearance: none; background: transparent; border: none; cursor: pointer;
  display: flex; align-items: center; gap: 14px; text-align: left;
  padding: 15px 4px; font: inherit; color: #17222e;
}
.wc-faq-head:hover { color: #0e7490; }
.wc-faq-head:focus-visible { outline: 2px solid #0e7490; outline-offset: 2px; border-radius: 6px; }
.wc-faq-title { flex: 1; font-size: 16.5px; font-weight: 600; line-height: 1.35; }
.wc-faq-chevron { flex: 0 0 auto; color: #6b7b8b; transition: transform .2s ease; }
.wc-faq-head.open .wc-faq-chevron { transform: rotate(180deg); color: #0e7490; }
.wc-faq-body-wrap { overflow: hidden; }
.wc-faq-body { padding: 0 4px 16px; font-size: 14.5px; }
.wc-faq-slot { margin-top: 14px; }

.wc-expand-enter-active, .wc-expand-leave-active { transition: height .22s ease; }
@media (prefers-reduced-motion: reduce) {
  .wc-expand-enter-active, .wc-expand-leave-active { transition: none; }
  .wc-faq-chevron { transition: none; }
}
</style>
