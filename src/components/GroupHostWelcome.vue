<template>
  <div class="gh">
    <div class="gh__host">{{ host }}</div>
    <h1 class="gh__title">Groups on this MAIA host</h1>
    <p class="gh__lead">
      This host runs groups only. It keeps no patients' MAIAs and no health
      records: each member's MAIA, with their records, stays on their own MAIA
      host, and they join these groups from there.
    </p>

    <div v-if="loading" class="gh__center"><q-spinner size="24px" color="primary" /></div>
    <div v-else-if="!groups.length" class="text-caption text-grey-7">No groups are listed here yet.</div>

    <div v-for="g in groups" :key="g.groupId" class="gh__group">
      <div class="gh__name">{{ g.name }}</div>
      <div v-if="g.description" class="gh__desc">{{ g.description }}</div>
      <div class="gh__meta">
        {{ g.activeMemberCount }} member{{ g.activeMemberCount === 1 ? '' : 's' }} · {{ JOIN_WORDS[g.joinMode] || 'Invitation only' }}
      </div>
      <div class="gh__actions">
        <template v-if="g.joinLink">
          <q-btn v-for="h in memberHosts" :key="h" unelevated no-caps color="primary" icon="group_add"
                 :label="`Join with ${hostOf(h)}`" :href="joinVia(h, g.joinLink)" target="_blank" rel="noopener" />
          <q-btn flat no-caps color="primary" :icon="copied === g.groupId ? 'check' : 'content_copy'"
                 :label="copied === g.groupId ? 'Copied' : 'Copy the join link'" @click="copy(g)" />
        </template>
        <q-btn outline no-caps color="primary" icon="send" label="Ask this group"
               :href="`/g/${encodeURIComponent(g.groupId)}/request`" target="_blank" rel="noopener">
          <q-tooltip>Ask every member at once. Each member's own rules decide; this host can't read the answers.</q-tooltip>
        </q-btn>
      </div>
      <div v-if="g.joinLink" class="gh__hint">
        Have a MAIA somewhere else? In your MAIA, open Workbook → Groups, click the
        <q-icon name="add_link" size="14px" /> link button, and paste the join link.
      </div>
    </div>

    <AskMaia class="q-mt-lg" />

    <WelcomeMaps class="q-mt-lg" />

    <div class="gh__foot">
      <a href="/page.html?doc=Privacy" target="_blank" class="welcome-footer-link">Privacy</a>
      · <a href="https://forum.agropper.xyz" target="_blank" rel="noopener" class="welcome-footer-link">Community forum</a>
      · <a href="/admin" class="welcome-footer-link">Group admin</a>
      · MAIA v{{ version }}
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * The welcome page of a group-only host (MAIA_HOST_ROLE=group-only;
 * trustee.ai as a demonstration host): its public groups, how to join each
 * from your own MAIA host (MAIA_MEMBER_HOSTS), the group request page, and
 * the two diagrams. There is no sign-up here: this host keeps no patients'
 * MAIAs and no health records.
 */
import { ref, onMounted } from 'vue';
import WelcomeMaps from './WelcomeMaps.vue';
import AskMaia from './AskMaia.vue';

defineProps<{ memberHosts: string[]; version: string }>();

interface PublicGroup {
  groupId: string; name: string; description: string; activeMemberCount: number;
  joinLink: string | null; joinMode: string; origin: string | null;
}

const JOIN_WORDS: Record<string, string> = { open: 'Anyone with the link joins', 'link-approval': 'Join with the link; the group approves', 'invite-only': 'Invitation only' };
const host = window.location.hostname;
const groups = ref<PublicGroup[]>([]);
const loading = ref(true);
const copied = ref('');

const hostOf = (h: string) => { try { return new URL(h).host; } catch { return h; } };
/** The same join link, opened on the member's own MAIA host. */
const joinVia = (memberHost: string, joinLink: string) => {
  try { return `${memberHost.replace(/\/$/, '')}/${new URL(joinLink).search}`; } catch { return memberHost; }
};
const copy = async (g: PublicGroup) => {
  if (!g.joinLink) return;
  try { await navigator.clipboard.writeText(g.joinLink); copied.value = g.groupId; setTimeout(() => { copied.value = ''; }, 2000); } catch { /* select it by hand */ }
};

onMounted(async () => {
  try {
    const d = await (await fetch('/api/groups/public')).json();
    groups.value = (d.groups || []).filter((g: PublicGroup) => !g.origin);
  } catch { /* the list stays empty */ } finally { loading.value = false; }
});
</script>

<style scoped>
.gh { max-width: 640px; margin: 0 auto; width: 100%; }
.gh__host { font-weight: 700; letter-spacing: 0.08em; color: #1976d2; font-size: 13px; text-transform: uppercase; }
.gh__title { font-size: 22px; line-height: 1.3; margin: 6px 0 8px; font-weight: 600; }
.gh__lead { color: #555; line-height: 1.5; margin: 0 0 16px; }
.gh__center { display: flex; justify-content: center; padding: 24px 0; }
.gh__group { border: 1px solid #dde3e9; border-radius: 12px; padding: 14px 16px; margin-bottom: 12px; background: #fff; }
.gh__name { font-weight: 600; font-size: 1.05rem; }
.gh__desc { color: #444; margin-top: 4px; line-height: 1.45; }
.gh__meta { color: #6b7a89; font-size: 0.82rem; margin-top: 6px; }
.gh__actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.gh__hint { color: #6b7a89; font-size: 0.8rem; margin-top: 8px; line-height: 1.4; }
.gh__foot { text-align: center; color: #9aa6b2; font-size: 0.8rem; margin-top: 20px; }
</style>
