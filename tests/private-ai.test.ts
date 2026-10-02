/**
 * Waiting for a new account's private AI before a Patient Summary draft:
 * a draft started while the AI is still deploying used to fail at once.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { waitForPrivateAi, privateAiWaitText } from '../src/utils/privateAi';

const answers = (list: Array<Record<string, unknown>>) => {
  let i = 0;
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => list[Math.min(i++, list.length - 1)] })));
};
afterEach(() => vi.unstubAllGlobals());

describe('waitForPrivateAi', () => {
  it('returns at once when the AI is running, without saying it is waiting', async () => {
    answers([{ endpointReady: true }]);
    const onWaiting = vi.fn();
    expect(await waitForPrivateAi({ onWaiting, intervalMs: 1 })).toBe('ready');
    expect(onWaiting).not.toHaveBeenCalled();
  });

  it('waits through a deploy, telling the page once, with when the AI started', async () => {
    answers([{ endpointReady: false, startedAt: '2026-10-01T12:00:00Z' }, { endpointReady: false }, { endpointReady: true }]);
    const onWaiting = vi.fn();
    expect(await waitForPrivateAi({ onWaiting, intervalMs: 1 })).toBe('ready');
    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(onWaiting).toHaveBeenCalledWith({ startedAt: '2026-10-01T12:00:00Z' });
  });

  it('stops on a failed start, and gives up after the timeout', async () => {
    answers([{ status: 'provision_failed' }]);
    expect(await waitForPrivateAi({ intervalMs: 1 })).toBe('failed');
    answers([{ endpointReady: false }]);
    expect(await waitForPrivateAi({ intervalMs: 1, timeoutMs: 20 })).toBe('timeout');
  });
});

describe('privateAiWaitText', () => {
  it('says how long so far, not just "about 2 minutes"', () => {
    const t = Date.parse('2026-10-01T12:00:00Z');
    expect(privateAiWaitText('2026-10-01T12:00:00Z', t + 97_000)).toMatch(/getting ready: 1m 37s so far/);
    expect(privateAiWaitText('2026-10-01T12:00:00Z', t - 5_000)).toMatch(/0m 00s so far/);
    expect(privateAiWaitText(null)).not.toMatch(/so far/);
  });
});
