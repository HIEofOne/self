<template>
  <q-layout view="hHh lpR fFf">
    <q-page-container>
      <q-page class="ap">
        <div class="ap__inner">
          <div class="ap__host"><a href="/">{{ host }}</a></div>
          <h1 class="ap__title">Ask Claude about MAIA</h1>
          <p class="ap__lead">
            MAIA is open source. Claude, an AI made by Anthropic, answers questions from patients,
            clinicians, group organizers and developers using a map of MAIA's code, its documents and
            the history of every change, the same code this host runs. It can't see anyone's MAIA,
            records or account.
          </p>
          <AskMaia />
          <div class="ap__foot">
            <a href="/">Back to {{ host }}</a>
            · <a :href="REPO_URL" target="_blank" rel="noopener">The code on GitHub</a>
            · <a href="https://forum.agropper.xyz" target="_blank" rel="noopener">Community forum</a>
          </div>
        </div>
      </q-page>
    </q-page-container>
  </q-layout>
</template>

<script setup lang="ts">
/**
 * The full page for "Ask about MAIA" at /ask (mounted by main.ts), linked
 * from the box on the welcome page: more room, and questions for each kind
 * of visitor. Public, like the welcome page.
 */
import AskMaia from './AskMaia.vue';

const REPO_URL = 'https://github.com/HIEofOne/self';
const host = window.location.host;
document.title = `Ask Claude about MAIA · ${host}`;
</script>

<style scoped>
.ap { background: #f7f9fb; min-height: 100vh; }
.ap__inner { max-width: 900px; margin: 0 auto; padding: 28px 20px 32px; }
.ap__host a { font-weight: 700; letter-spacing: 0.08em; color: #1976d2; font-size: 13px; text-transform: uppercase; text-decoration: none; }
.ap__title { font-size: 26px; line-height: 1.3; margin: 6px 0 8px; font-weight: 600; }
.ap__lead { color: #4a5663; line-height: 1.55; margin: 0 0 18px; max-width: 760px; }
.ap__foot { margin-top: 24px; color: #9aa6b2; font-size: 0.82rem; }
.ap__foot a { color: #1976d2; text-decoration: none; }
</style>
