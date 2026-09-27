<template>
  <section v-if="available" class="ask" aria-labelledby="ask-maia-title">
    <div class="ask__head">
      <q-icon name="forum" color="primary" size="20px" />
      <span id="ask-maia-title" class="ask__title">Ask about MAIA</span>
    </div>
    <div class="ask__sub">
      Claude answers from MAIA's public documentation. This box isn't private,
      so please don't type health information.
    </div>

    <div v-if="turns.length" ref="logRef" class="ask__log" aria-live="polite">
      <div v-for="(t, i) in turns" :key="i" :class="['ask__turn', `ask__turn--${t.role}`]">
        <div v-if="t.role === 'user'" class="ask__q">{{ t.content }}</div>
        <template v-else>
          <q-spinner-dots v-if="!t.content && !t.error" color="primary" size="22px" />
          <!-- eslint-disable-next-line vue/no-v-html -- markdown-it with html off -->
          <div v-if="t.content" class="ask__a" v-html="render(t.content)" />
          <div v-if="t.sources.length" class="ask__src">
            Sources:
            <template v-for="(s, j) in t.sources" :key="s.n">
              <a :href="s.url" target="_blank" rel="noopener">{{ s.doc }}{{ s.heading ? ` › ${s.heading}` : '' }}</a><span v-if="j < t.sources.length - 1"> · </span>
            </template>
          </div>
          <div v-if="t.error" class="ask__err">{{ t.error }}</div>
        </template>
      </div>
    </div>

    <div v-else class="ask__chips">
      <q-chip v-for="s in SUGGESTIONS" :key="s" clickable outline color="primary" size="md" @click="ask(s)">{{ s }}</q-chip>
    </div>

    <form class="ask__form" @submit.prevent="ask(draft)">
      <q-input v-model="draft" dense outlined class="ask__input" placeholder="Ask a question about MAIA"
               :maxlength="1000" :disable="busy" aria-label="Your question about MAIA" />
      <q-btn type="submit" unelevated color="primary" icon="send" :loading="busy" :disable="!draft.trim()" aria-label="Ask" />
    </form>
    <div class="ask__foot">
      Answers can be wrong: the documents are the reference. Nothing you type is saved.
      <a v-if="turns.length && !busy" href="#" class="welcome-footer-link" @click.prevent="turns = []">Start over</a>
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * "Ask about MAIA" on the welcome page (server/routes/ask-maia.js): anyone
 * can ask how MAIA works, before any account exists. Claude answers from
 * the public documentation and cites it. The conversation lives only in
 * this page; nothing is saved. Hidden when this host can't reach Claude.
 */
import { ref, nextTick, onMounted } from 'vue';
import MarkdownIt from 'markdown-it';

interface Source { n: number; doc: string; heading: string; url: string }
interface Turn { role: 'user' | 'assistant'; content: string; sources: Source[]; error?: string }

const SUGGESTIONS = ['What is MAIA?', 'How do groups work?', 'Who can see my records?', 'How do I get started?'];

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
md.linkify.set({ fuzzyLink: false }); // only full URLs become links, not every "trustee.ai"
const defaultLink = md.renderer.rules.link_open || ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener');
  return defaultLink(tokens, idx, options, env, self);
};

const available = ref(false);
const turns = ref<Turn[]>([]);
const draft = ref('');
const busy = ref(false);
const logRef = ref<HTMLElement | null>(null);

// The answer ends with "Sources: [1], [3]"; that line becomes links.
const SOURCES_LINE = /\n?[ \t]*\**Sources?\**:?\**[ \t]*((?:\[\d+\][,;\s]*(?:and\s+)?)+)\s*$/i;
const splitSources = (text: string) => {
  const m = text.match(SOURCES_LINE);
  const cited = new Set<number>();
  for (const x of (m ? m[1] : '').matchAll(/\[(\d+)\]/g)) cited.add(Number(x[1]));
  return { body: m ? text.slice(0, m.index).trimEnd() : text, cited };
};
const render = (text: string) => md.render(splitSources(text).body);

const WAIT_WORDS: Record<string, (retry: number) => string> = {
  TOO_MANY: (r) => `You've asked a lot of questions. Try again in ${Math.max(1, Math.round(r / 60))} minute${Math.round(r / 60) === 1 ? '' : 's'}.`,
  HOST_LIMIT: () => 'This host has answered all the questions it can today. Try again tomorrow, or ask on the community forum.',
  NOT_AVAILABLE: () => 'The question box isn’t available on this host right now.',
  QUESTION_TOO_LONG: () => 'Please shorten your question to 1,000 characters.'
};

const scrollDown = () => nextTick(() => { if (logRef.value) logRef.value.scrollTop = logRef.value.scrollHeight; });

async function ask(text: string) {
  const question = text.trim();
  if (!question || busy.value) return;
  const history = turns.value.filter((t) => !t.error && t.content)
    .map((t) => ({ role: t.role, content: t.role === 'assistant' ? splitSources(t.content).body : t.content }));
  turns.value.push({ role: 'user', content: question, sources: [] });
  turns.value.push({ role: 'assistant', content: '', sources: [] });
  const live = turns.value[turns.value.length - 1]; // the reactive copy
  draft.value = '';
  busy.value = true;
  scrollDown();
  try {
    const res = await fetch('/api/ask-maia', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ question, history })
    });
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}));
      live.error = WAIT_WORDS[body.error]?.(Number(body.retryAfter) || 60) || 'Something went wrong. Try again in a moment.';
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() || '';
      for (const block of blocks) {
        if (!block.startsWith('data: ')) continue;
        let ev: { delta?: string; done?: boolean; sources?: Source[]; error?: string };
        try { ev = JSON.parse(block.slice(6)); } catch { continue; }
        if (ev.delta) { live.content += ev.delta; scrollDown(); }
        if (ev.error) live.error = ev.error;
        if (ev.done && Array.isArray(ev.sources)) {
          const { cited } = splitSources(live.content);
          for (const x of live.content.matchAll(/\[(\d+)\]/g)) cited.add(Number(x[1]));
          live.sources = ev.sources.filter((s) => cited.has(s.n));
        }
      }
    }
    if (!live.content && !live.error) live.error = 'No answer came back. Try again in a moment.';
  } catch {
    live.error = 'The question couldn’t be sent. Check your connection and try again.';
  } finally {
    busy.value = false;
    scrollDown();
  }
}

onMounted(async () => {
  try { available.value = !!(await (await fetch('/api/ask-maia')).json()).available; } catch { available.value = false; }
});
</script>

<style scoped>
.ask { max-width: 560px; width: 100%; margin: 0 auto; border: 1px solid #dde3e9; border-radius: 12px; padding: 14px 16px; background: #fff; text-align: left; }
.ask__head { display: flex; align-items: center; gap: 8px; }
.ask__title { font-weight: 600; font-size: 1rem; }
.ask__sub { color: #5f6b77; font-size: 0.85rem; margin: 4px 0 10px; line-height: 1.4; }
.ask__log { max-height: 380px; overflow-y: auto; margin-bottom: 10px; display: flex; flex-direction: column; gap: 10px; }
.ask__q { align-self: flex-end; margin-left: auto; background: #e8f0fa; border-radius: 12px 12px 2px 12px; padding: 6px 10px; max-width: 85%; white-space: pre-wrap; width: fit-content; }
.ask__turn--user { display: flex; }
.ask__a { line-height: 1.5; font-size: 0.92rem; }
.ask__a :deep(p) { margin: 0 0 6px; }
.ask__a :deep(ul), .ask__a :deep(ol) { margin: 0 0 6px; padding-left: 20px; }
.ask__src { font-size: 0.78rem; color: #6b7a89; margin-top: 2px; line-height: 1.5; }
.ask__src a { color: #1976d2; text-decoration: none; }
.ask__src a:hover { text-decoration: underline; }
.ask__err { color: #b35c00; font-size: 0.85rem; margin-top: 4px; }
.ask__chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 -4px 8px; }
.ask__form { display: flex; gap: 8px; align-items: center; }
.ask__input { flex: 1; min-width: 0; }
.ask__foot { color: #9aa6b2; font-size: 0.75rem; margin-top: 8px; }
</style>
