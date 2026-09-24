import { computed, reactive, readonly } from 'vue';

/**
 * Which edition the server runs, and which features are on for this user
 * (GET /api/edition; Documentation/group_requests.md §4.1).
 *
 * Hiding something here is cosmetic: the server enforces every gate
 * (I-26). Until the first answer arrives, has() reports every feature as
 * on, which is the full edition's behavior, so a slow or failed request
 * never hides anything there. Edition-only screens should wait for
 * `state.loaded` before deciding what to show.
 */
export type Edition = 'full' | 'personal-as';

export interface EditionFeature {
  name: string;
  description: string;
  whatItMeans: string | null;
  available: boolean;
  defaultOn: boolean;
  unlockable: boolean;
  enabled: boolean;
}

interface EditionState {
  loaded: boolean;
  edition: Edition;
  features: Record<string, EditionFeature>;
  error: string;
}

const state = reactive<EditionState>({ loaded: false, edition: 'full', features: {}, error: '' });
let inflight: Promise<void> | null = null;

/** Fetch the edition. Call again with `force` after sign-in or sign-out,
 *  or after the user turns a feature on, to pick up their own unlocks. */
const load = (force = false): Promise<void> => {
  if (state.loaded && !force) return Promise.resolve();
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch('/api/edition', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.edition = data.edition === 'personal-as' ? 'personal-as' : 'full';
      state.features = data.features || {};
      state.loaded = true;
      state.error = '';
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
};

/** Is this feature on for the current user? */
const has = (key: string): boolean => {
  if (!state.loaded) return true;
  return !!state.features[key]?.enabled;
};

const isPersonalAs = computed(() => state.loaded && state.edition === 'personal-as');

export function useEdition() {
  return { state: readonly(state), load, has, isPersonalAs };
}

/** Tests only. */
export const _resetEditionForTests = () => {
  state.loaded = false; state.edition = 'full'; state.features = {}; state.error = '';
  inflight = null;
};
