/**
 * Member messages sealed in the browser: a message sealed to a member's
 * message key (the public half of their MAIA folder key) opens with the
 * folder key and nothing else; the browser opens what it can and shows the
 * rest as locked; sending seals to every recipient who has a message key,
 * and hands the text to the host only for those who don't.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { sealString, openSealedBytes } from '../src/gnap/sealedBox';
import { openBytesFrom, sealBytesTo } from '../server/utils/sealed-box.js';

const keyFor = vi.hoisted(() => ({ current: null as CryptoKey | null }));
vi.mock('../src/utils/folderKey', () => ({ getFolderPrivateKey: async () => keyFor.current }));

import { MESSAGE_INFO, LOCKED_TEXT, openMessages, sendMemberMessage } from '../src/utils/memberMessages';

/** A folder key: the server's JWKs, and the browser's CryptoKey for the private half. */
async function folderKey() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const pub = publicKey.export({ format: 'jwk' }) as JsonWebKey;
  const priv = privateKey.export({ format: 'jwk' }) as JsonWebKey;
  const cryptoKey = await crypto.subtle.importKey('jwk', { ...priv, key_ops: undefined, ext: true }, { name: 'X25519' }, false, ['deriveBits']);
  return { pub: { kty: 'OKP', crv: 'X25519', x: pub.x } as JsonWebKey, priv, cryptoKey };
}

describe('the message label', () => {
  it('the browser seals, the key holder opens; the label keeps messages apart from relay traffic and documents', async () => {
    const k = await folderKey();
    const box = await sealString(k.pub, 'hello, sealed', MESSAGE_INFO);
    expect(openBytesFrom(k.priv, box, MESSAGE_INFO).toString('utf8')).toBe('hello, sealed');
    expect(() => openBytesFrom(k.priv, box)).toThrow();
    expect(() => openBytesFrom(k.priv, box, 'maia-folder-document-v1')).toThrow();
    const other = await folderKey();
    expect(() => openBytesFrom(other.priv, box, MESSAGE_INFO)).toThrow();

    const back = sealBytesTo(k.pub, Buffer.from('and back'), MESSAGE_INFO);
    expect(new TextDecoder().decode(await openSealedBytes(k.cryptoKey, back, MESSAGE_INFO))).toBe('and back');
  });
});

describe('opening messages in the browser', () => {
  it('opens what the folder key opens, leaves plain messages as they are, and shows the rest as locked', async () => {
    const me = await folderKey();
    const stranger = await folderKey();
    keyFor.current = me.cryptoKey;
    const list = [
      { id: 'm1', sealed: await sealString(me.pub, JSON.stringify({ maiaType: 'member-message', text: 'for me', broadcast: true }), MESSAGE_INFO) },
      { id: 'm2', text: 'an older message, sealed by the host' },
      { id: 'm3', sealed: await sealString(stranger.pub, JSON.stringify({ maiaType: 'member-message', text: 'not for me' }), MESSAGE_INFO) }
    ];
    const out = await openMessages('ann01', list);
    expect(out[0]).toMatchObject({ id: 'm1', text: 'for me', broadcast: true });
    expect(out[1]).toEqual(list[1]);
    expect(out[2]).toMatchObject({ id: 'm3', text: LOCKED_TEXT, locked: true });
  });

  it('without the folder in this browser, sealed messages are locked', async () => {
    const me = await folderKey();
    keyFor.current = null;
    const out = await openMessages('ann01', [{ id: 'm9', sealed: await sealString(me.pub, 'x', MESSAGE_INFO) }]);
    expect(out[0]).toMatchObject({ text: LOCKED_TEXT, locked: true });
  });
});

describe('sending', () => {
  const realFetch = globalThis.fetch;
  let posted: any = null;
  beforeEach(() => { posted = null; });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('seals to each member with a message key and to the sender; the host gets the text only for members without one', async () => {
    const jess = await folderKey();
    const me = await folderKey();
    globalThis.fetch = (async (url: string, opts: any = {}) => {
      if (String(url).startsWith('/api/user-groups/recipient-keys')) {
        return new Response(JSON.stringify({ success: true, selfKey: me.pub, recipients: [
          { pairwiseId: 'pw-jess', messagePublicKeyJwk: jess.pub },
          { pairwiseId: 'pw-old', messagePublicKeyJwk: null }
        ] }));
      }
      posted = JSON.parse(opts.body);
      return new Response(JSON.stringify({ success: true, sent: { id: 'out_1', toPairwiseId: '@everyone', sealed: posted.selfBox, sentAt: 'now' }, locked: 1, hostReadable: 1 }));
    }) as typeof fetch;

    const r = await sendMemberMessage('ann01', 'grp1', '@everyone', 'hello everyone');
    expect(r).toMatchObject({ locked: 1, hostReadable: 1, sent: { id: 'out_1', text: 'hello everyone' } });
    expect(posted.boxes.map((b: any) => b.toPairwiseId)).toEqual(['pw-jess']);
    expect(posted.hostSeal).toEqual({ text: 'hello everyone', for: ['pw-old'] });
    expect(JSON.stringify(posted.boxes)).not.toContain('hello everyone');
    const opened = JSON.parse(openBytesFrom(jess.priv, posted.boxes[0].box, MESSAGE_INFO).toString('utf8'));
    expect(opened).toEqual({ maiaType: 'member-message', text: 'hello everyone', broadcast: true });
    expect(JSON.parse(openBytesFrom(me.priv, posted.selfBox, MESSAGE_INFO).toString('utf8')).text).toBe('hello everyone');

    // The sender's own copy opens from the cache, even without the folder key.
    keyFor.current = null;
    const [mine] = await openMessages('ann01', [{ id: 'out_1', sealed: posted.selfBox }]);
    expect(mine).toMatchObject({ text: 'hello everyone' });
  });

  it('when every recipient has a message key, the host gets no text at all', async () => {
    const jess = await folderKey();
    globalThis.fetch = (async (url: string, opts: any = {}) => {
      if (String(url).startsWith('/api/user-groups/recipient-keys')) {
        return new Response(JSON.stringify({ success: true, selfKey: null, recipients: [{ pairwiseId: 'pw-jess', messagePublicKeyJwk: jess.pub }] }));
      }
      posted = JSON.parse(opts.body);
      return new Response(JSON.stringify({ success: true, sent: { id: 'out_2' }, locked: 1, hostReadable: 0 }));
    }) as typeof fetch;
    await sendMemberMessage('ann01', 'grp1', 'pw-jess', 'just for jess');
    expect(posted.hostSeal).toBeUndefined();
    expect(posted.selfBox).toBeNull();
    expect(JSON.stringify(posted)).not.toContain('just for jess');
  });
});
