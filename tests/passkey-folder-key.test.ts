/**
 * The folder key travels with the passkey: a sign-in asks the passkey for
 * its PRF secret, which never leaves the page; the folder key's private half
 * is encrypted with a key derived from it, bound to the passkey's id; a
 * browser with the folder key stores that copy, one without it opens the
 * copy. And a change made without the folder is noted for the computer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const folder = vi.hoisted(() => ({ local: null as any, kept: [] as any[] }));
vi.mock('../src/utils/folderKey', () => ({
  getFolderPrivateJwk: async () => folder.local,
  keepFolderKeyInBrowser: async (_u: string, jwk: any) => { folder.kept.push(jwk); }
}));

import { withPrf, takePrfSecret, wrapKey, unwrapKey, rememberPrfSecret, syncFolderKeyWithPasskey } from '../src/utils/passkeyFolderKey';
import { noteFolderCatchUp } from '../src/utils/folderCatchUp';

const newJwk = async () => {
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair;
  const k = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { kty: 'OKP' as const, crv: 'X25519' as const, x: String(k.x), d: String(k.d) };
};
const SECRET = crypto.getRandomValues(new Uint8Array(32));

describe('the PRF secret', () => {
  it('is asked for with every sign-in, and kept out of what goes to the server', () => {
    const o = withPrf({ challenge: 'c', rpId: 'agropper.xyz', extensions: { credProps: true } } as any);
    expect(o).toMatchObject({ challenge: 'c', rpId: 'agropper.xyz', extensions: { credProps: true } });
    expect((o.extensions as any).prf.eval.first).toBeInstanceOf(Uint8Array);

    const assertion = { id: 'cred-1', clientExtensionResults: { prf: { results: { first: SECRET.buffer.slice(0) } }, other: 1 } };
    const secret = takePrfSecret(assertion);
    expect(secret && Array.from(secret)).toEqual(Array.from(SECRET));
    expect(JSON.stringify(assertion)).not.toContain('prf');
    expect(takePrfSecret({ clientExtensionResults: {} })).toBeNull();
  });
});

describe('the folder key, encrypted with the passkey', () => {
  it('opens with the same passkey secret, and not with another secret or another passkey id', async () => {
    const jwk = await newJwk();
    const w = await wrapKey(jwk, SECRET, 'cred-1');
    expect(w).toMatchObject({ credentialId: 'cred-1', x: jwk.x });
    expect(JSON.stringify(w)).not.toContain(jwk.d);
    expect(await unwrapKey(w, SECRET)).toEqual(jwk);
    expect(await unwrapKey(w, crypto.getRandomValues(new Uint8Array(32)))).toBeNull();
    expect(await unwrapKey({ ...w, credentialId: 'cred-2' }, SECRET)).toBeNull();
  });
});

describe('after a passkey sign-in', () => {
  const realFetch = globalThis.fetch;
  let stored: any = null;
  let serverCopy: any = null;
  beforeEach(() => {
    stored = null;
    serverCopy = null;
    folder.kept = [];
    globalThis.fetch = (async (url: string, opts: any = {}) => {
      if (String(url).startsWith('/api/folder-key/wrapped') && (opts.method || 'GET') === 'GET') {
        return new Response(JSON.stringify({ success: true, wrapped: serverCopy, credentialId: 'cred-1' }));
      }
      if (url === '/api/folder-key/wrapped' && opts.method === 'PUT') { stored = JSON.parse(opts.body); return new Response('{"success":true}'); }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('without the secret nothing happens', async () => {
    expect(await syncFolderKeyWithPasskey('nobody')).toBe('no-secret');
  });

  it('the computer stores the passkey copy; the server never sees the key or the secret', async () => {
    folder.local = await newJwk();
    rememberPrfSecret('ann01', 'cred-1', SECRET);
    expect(await syncFolderKeyWithPasskey('ann01')).toBe('stored');
    expect(stored).toMatchObject({ userId: 'ann01', credentialId: 'cred-1', x: folder.local.x });
    expect(JSON.stringify(stored)).not.toContain(folder.local.d);
    // Already there: nothing more to do.
    serverCopy = { credentialId: 'cred-1', x: folder.local.x, iv: stored.iv, ct: stored.ct };
    expect(await syncFolderKeyWithPasskey('ann01')).toBe('already');
  });

  it('a phone opens the copy and keeps the key in this browser', async () => {
    const jwk = await newJwk();
    serverCopy = await wrapKey(jwk, SECRET, 'cred-1');
    folder.local = null;
    rememberPrfSecret('ann01', 'cred-1', SECRET);
    expect(await syncFolderKeyWithPasskey('ann01')).toBe('unlocked');
    expect(folder.kept).toEqual([jwk]);
  });

  it('a phone with no copy yet is told so', async () => {
    folder.local = null;
    rememberPrfSecret('ann01', 'cred-1', SECRET);
    expect(await syncFolderKeyWithPasskey('ann01')).toBe('no-copy');
  });
});

describe('the folder catching up', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('a browser without folder access notes what changed; a folder that merely lacks permission does not', async () => {
    const posts: any[] = [];
    globalThis.fetch = (async (_url: string, opts: any) => { posts.push(JSON.parse(opts.body)); return new Response('{}'); }) as typeof fetch;
    await noteFolderCatchUp('ann01', 'summary', 'no-folder');
    await noteFolderCatchUp('ann01', 'rules', 'failed');
    await noteFolderCatchUp('ann01', 'rules', 'written');
    expect(posts).toEqual([{ userId: 'ann01', what: 'summary' }]);
  });
});
