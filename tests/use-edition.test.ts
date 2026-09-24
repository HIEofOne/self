import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useEdition, _resetEditionForTests } from '../src/composables/useEdition';

const answer = (edition: string, enabled: Record<string, boolean>) => ({
  success: true,
  edition,
  features: Object.fromEntries(Object.entries(enabled).map(([key, on]) => [key, {
    name: key, description: '', whatItMeans: null, available: true, defaultOn: on, unlockable: !on, enabled: on
  }]))
});

const stubFetch = (body: unknown, ok = true) => {
  const fn = vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body }));
  vi.stubGlobal('fetch', fn);
  return fn;
};

beforeEach(() => _resetEditionForTests());
afterEach(() => vi.unstubAllGlobals());

describe('useEdition', () => {
  it('reports every feature as on until the server answers (the full edition)', () => {
    const { has, isPersonalAs, state } = useEdition();
    expect(state.loaded).toBe(false);
    expect(has('records-index')).toBe(true);
    expect(isPersonalAs.value).toBe(false);
  });

  it('follows the server once loaded', async () => {
    stubFetch(answer('personal-as', { account: true, 'records-index': false }));
    const { load, has, isPersonalAs, state } = useEdition();
    await load();
    expect(state.loaded).toBe(true);
    expect(isPersonalAs.value).toBe(true);
    expect(has('account')).toBe(true);
    expect(has('records-index')).toBe(false);
    expect(has('no-such-feature')).toBe(false);
  });

  it('keeps the full-edition behavior when the request fails', async () => {
    stubFetch({}, false);
    const { load, has, state } = useEdition();
    await load();
    expect(state.loaded).toBe(false);
    expect(state.error).toMatch(/500/);
    expect(has('records-index')).toBe(true);
  });

  it('shares one request between callers and refetches only when forced', async () => {
    const fetchMock = stubFetch(answer('full', { account: true }));
    const { load } = useEdition();
    await Promise.all([load(), load()]);
    await load();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await load(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
