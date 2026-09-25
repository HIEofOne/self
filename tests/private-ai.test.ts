/**
 * Waiting for a new account's private AI before a Patient Summary draft:
 * a draft started while the AI is still deploying used to fail at once.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { waitForPrivateAi } from '../src/utils/privateAi';

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

  it('waits through a deploy, telling the page once', async () => {
    answers([{ endpointReady: false }, { endpointReady: false }, { endpointReady: true }]);
    const onWaiting = vi.fn();
    expect(await waitForPrivateAi({ onWaiting, intervalMs: 1 })).toBe('ready');
    expect(onWaiting).toHaveBeenCalledTimes(1);
  });

  it('stops on a failed start, and gives up after the timeout', async () => {
    answers([{ status: 'provision_failed' }]);
    expect(await waitForPrivateAi({ intervalMs: 1 })).toBe('failed');
    answers([{ endpointReady: false }]);
    expect(await waitForPrivateAi({ intervalMs: 1, timeoutMs: 20 })).toBe('timeout');
  });
});
