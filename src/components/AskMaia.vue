<template>
  <section v-if="available" class="ask" :class="{ 'ask--full': full }" aria-labelledby="ask-maia-title">
    <div v-if="!full" class="ask__head">
      <q-icon name="forum" color="primary" size="20px" />
      <span id="ask-maia-title" class="ask__title">Ask about MAIA</span>
      <a href="/ask" target="_blank" rel="noopener" class="ask__full-link">Open the full page <q-icon name="open_in_new" size="13px" /></a>
    </div>
    <div class="ask__sub">
      Claude answers from a map of MAIA's code, documents and change history, reading what it
      needs and linking to it. It can take up to a minute. This box isn't private, so please
      don't type health information.
    </div>

    <div v-if="turns.length" ref="logRef" class="ask__log" aria-live="polite">
      <div v-for="(t, i) in turns" :key="i" :class="['ask__turn', `ask__turn--${t.role}`]">
        <div v-if="t.role === 'user'" class="ask__q">{{ t.content }}</div>
        <template v-else>
          <!-- What Claude is looking up, as it goes; folded once answered -->
          <div v-if="t.steps.length" class="ask__steps">
            <div v-if="!t.content && !t.error" class="ask__step-now">
              <q-spinner size="14px" color="primary" /> {{ t.steps[t.steps.length - 1] }}…
            </div>
            <details v-else>
              <summary>Looked up {{ t.steps.length }} thing{{ t.steps.length === 1 ? '' : 's' }}</summary>
              <div v-for="(s, j) in t.steps" :key="j" class="ask__step">{{ s }}</div>
            </details>
          </div>
          <div v-else-if="!t.content && !t.error" class="ask__step-now"><q-spinner-dots color="primary" size="20px" /> Thinking…</div>
          <!-- eslint-disable-next-line vue/no-v-html -- markdown-it with html off -->
          <div v-if="t.content" class="ask__a" v-html="render(t.content)" />
          <div v-if="t.looked.length" class="ask__src">
            Read:
            <template v-for="(l, j) in t.looked" :key="`${l.path}:${l.start}`">
              <a :href="l.url" target="_blank" rel="noopener" :title="l.title || l.path">{{ l.path }}{{ l.start ? ` ${l.start}–${l.end}` : '' }}</a><span v-if="j < t.looked.length - 1"> · </span>
            </template>
          </div>
          <div v-if="t.error" class="ask__err">{{ t.error }}</div>
        </template>
      </div>
    </div>

    <template v-else>
      <template v-if="full">
        <div v-for="g in suggestionGroups" :key="g.who" class="ask__group">
          <div class="ask__group-who">{{ g.who }}</div>
          <div class="ask__chips">
            <q-chip v-for="s in g.items" :key="s" clickable outline color="primary" size="md" @click="ask(s)">{{ s }}</q-chip>
          </div>
        </div>
      </template>
      <div v-else class="ask__chips">
        <q-chip v-for="s in QUICK" :key="s" clickable outline color="primary" size="md" @click="ask(s)">{{ s }}</q-chip>
      </div>
    </template>

    <form class="ask__form" @submit.prevent="ask(draft)">
      <q-input v-model="draft" dense outlined class="ask__input" placeholder="Ask a question about MAIA"
               :maxlength="1000" :disable="busy" aria-label="Your question about MAIA" />
      <q-btn type="submit" unelevated color="primary" icon="send" :loading="busy" :disable="!draft.trim()" aria-label="Ask" />
    </form>
    <div class="ask__foot">
      Answers can be wrong: the code and documents are the reference. Nothing you type is saved.
      <a v-if="turns.length && !busy" href="#" class="welcome-footer-link" @click.prevent="turns = []">Start over</a>
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * "Ask about MAIA" (server/routes/ask-maia.js): anyone can ask how MAIA
 * works, before any account exists. Claude answers from a knowledge pack
 * (the brief, maps of the code and documents, the PR history), reads what
 * it needs (each lookup shows as it goes), and links to what it read. The conversation lives only in this
 * page; nothing is saved. Hidden when this host can't reach Claude.
 *
 * `full`: the page at /ask, with more room and questions for each kind of
 * visitor.
 */
import { ref, nextTick, onMounted } from 'vue';
import MarkdownIt from 'markdown-it';

defineProps<{ full?: boolean }>();

interface Looked { path: string; start?: number; end?: number; title?: string; url: string }
interface Turn { role: 'user' | 'assistant'; content: string; steps: string[]; looked: Looked[]; error?: string }

const QUICK = ['What is MAIA?', 'How do groups work?', 'Who can see my records?', 'How do I get started?'];
const suggestionGroups = [
  { who: 'Patients', items: ['What is MAIA, and what does it cost me?', 'Who can see my records, and how do I control it?', 'How do I get started?'] },
  { who: 'Clinicians', items: ['How do I ask a patient\'s MAIA for their medication list?', 'How can I send a patient a radiology report?', 'Is MAIA regulated as a medical device?'] },
  { who: 'Group organizers', items: ['How do I start a group?', 'What does a group see about its members?', 'How do suggested rules work?'] },
  { who: 'Developers', items: ['Where is the GNAP grant endpoint, and how are requests signed?', 'How is a document someone adds kept sealed until the patient accepts it?', 'How big is the code, and how is it organized?', 'What changed in the last week?'] }
];

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
md.linkify.set({ fuzzyLink: false }); // only full URLs become links, not every "trustee.ai"
const defaultLink = md.renderer.rules.link_open || ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener');
  return defaultLink(tokens, idx, options, env, self);
};
const render = (text: string) => md.render(text);

const available = ref(false);
const turns = ref<Turn[]>([]);
const draft = ref('');
const busy = ref(false);
const logRef = ref<HTMLElement | null>(null);

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
  const history = turns.value.filter((t) => !t.error && t.content).map((t) => ({ role: t.role, content: t.content }));
  turns.value.push({ role: 'user', content: question, steps: [], looked: [] });
  turns.value.push({ role: 'assistant', content: '', steps: [], looked: [] });
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
        let ev: { step?: string; delta?: string; done?: boolean; looked?: Looked[]; error?: string };
        try { ev = JSON.parse(block.slice(6)); } catch { continue; }
        if (ev.step) { live.steps.push(ev.step); scrollDown(); }
        if (ev.delta) { live.content += ev.delta; scrollDown(); }
        if (ev.error) live.error = ev.error;
        if (ev.done && Array.isArray(ev.looked)) live.looked = ev.looked;
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
.ask--full { max-width: 860px; border: none; padding: 0; background: transparent; }
.ask__head { display: flex; align-items: center; gap: 8px; }
.ask__title { font-weight: 600; font-size: 1rem; }
.ask__full-link { margin-left: auto; font-size: 0.8rem; color: #1976d2; text-decoration: none; white-space: nowrap; }
.ask__full-link:hover { text-decoration: underline; }
.ask__sub { color: #5f6b77; font-size: 0.85rem; margin: 4px 0 10px; line-height: 1.4; }
.ask__log { max-height: 420px; overflow-y: auto; margin-bottom: 10px; display: flex; flex-direction: column; gap: 12px; }
.ask--full .ask__log { max-height: calc(100vh - 300px); min-height: 200px; }
.ask__q { align-self: flex-end; margin-left: auto; background: #e8f0fa; border-radius: 12px 12px 2px 12px; padding: 6px 10px; max-width: 85%; white-space: pre-wrap; width: fit-content; }
.ask__turn--user { display: flex; }
.ask__a { line-height: 1.5; font-size: 0.92rem; }
.ask--full .ask__a { font-size: 0.97rem; }
.ask__a :deep(p) { margin: 0 0 6px; }
.ask__a :deep(ul), .ask__a :deep(ol) { margin: 0 0 6px; padding-left: 20px; }
.ask__a :deep(code) { background: #f2f4f7; border-radius: 4px; padding: 0 3px; font-size: 0.88em; }
.ask__a :deep(pre) { background: #f2f4f7; border-radius: 6px; padding: 8px 10px; overflow-x: auto; font-size: 0.85em; }
.ask__a :deep(a) { color: #1976d2; }
.ask__steps { font-size: 0.8rem; color: #6b7a89; margin-bottom: 6px; }
.ask__steps summary { cursor: pointer; }
.ask__step { padding-left: 14px; line-height: 1.5; }
.ask__step-now { display: flex; align-items: center; gap: 6px; font-size: 0.82rem; color: #455a64; }
.ask__src { font-size: 0.78rem; color: #6b7a89; margin-top: 4px; line-height: 1.5; }
.ask__src a { color: #1976d2; text-decoration: none; }
.ask__src a:hover { text-decoration: underline; }
.ask__err { color: #b35c00; font-size: 0.85rem; margin-top: 4px; }
.ask__group { margin-bottom: 8px; }
.ask__group-who { font-size: 0.78rem; font-weight: 600; color: #455a64; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 2px; }
.ask__chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 -4px 8px; }
.ask__form { display: flex; gap: 8px; align-items: center; }
.ask__input { flex: 1; min-width: 0; }
.ask__foot { color: #9aa6b2; font-size: 0.75rem; margin-top: 8px; }
</style>
