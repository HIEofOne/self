/**
 * The browser GNAP client signs with WebCrypto (src/gnap/httpsig.ts); the
 * server verifies with Node crypto (server/gnap/httpsig.js). The two must
 * agree exactly: a signed grant request, a token-bearing read, a replay,
 * a tampered body, and the interaction hash.
 */
import { describe, it, expect } from 'vitest';
import { signRequest, jwkThumbprint, interactionHash } from '../src/gnap/httpsig';
import { verifyGnapRequest, createNonceCache } from '../server/gnap/httpsig.js';
import { interactionHash as serverInteractionHash } from '../server/gnap/grants.js';
import { newSealingKeyPair, openSealed } from '../src/gnap/sealedBox';
import { sealTo, isX25519PublicJwk } from '../server/utils/sealed-box.js';

const makeKey = async () => {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']) as CryptoKeyPair;
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const base = { kty: 'OKP' as const, crv: 'Ed25519' as const, x: String(pub.x) };
  return { privateKey: pair.privateKey, jwk: { ...base, kid: await jwkThumbprint(base) } };
};

const asServerSees = (url: string, method: string, headers: Record<string, string>, body: string | null) => ({
  method,
  targetUri: url,
  headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
  rawBody: Buffer.from(body || '')
});

describe('browser signatures verify on the server', () => {
  it('a grant request with a body', async () => {
    const key = await makeKey();
    const url = 'https://test.agropper.xyz/gnap/as/' + 'a'.repeat(32);
    const body = JSON.stringify({ access_token: { access: [] }, client: { key: { proof: 'httpsig', jwk: key.jwk } } });
    const headers = { 'content-type': 'application/json' };
    const sig = await signRequest({ method: 'POST', url, headers, body, privateKey: key.privateKey, kid: key.jwk.kid });
    const r = verifyGnapRequest(asServerSees(url, 'POST', { ...headers, ...sig }, body), key.jwk, { nonceCache: createNonceCache() });
    expect(r).toMatchObject({ ok: true });
  });

  it('a read with a token covers authorization; a replay and a changed body fail', async () => {
    const key = await makeKey();
    const url = 'https://test.agropper.xyz/gnap/rs/handle123';
    const headers = { authorization: 'GNAP tok-value' };
    const sig = await signRequest({ method: 'GET', url, headers, privateKey: key.privateKey, kid: key.jwk.kid });
    expect(sig['Signature-Input']).toContain('"authorization"');
    const cache = createNonceCache();
    const msg = asServerSees(url, 'GET', { ...headers, ...sig }, null);
    expect(verifyGnapRequest(msg, key.jwk, { nonceCache: cache }).ok).toBe(true);
    expect(verifyGnapRequest(msg, key.jwk, { nonceCache: cache })).toMatchObject({ ok: false, error: 'replayed nonce' });

    const body = '{"interact_ref":"x"}';
    const signed = await signRequest({ method: 'POST', url, headers: { 'content-type': 'application/json' }, body, privateKey: key.privateKey, kid: key.jwk.kid });
    const tampered = asServerSees(url, 'POST', { 'content-type': 'application/json', ...signed }, '{"interact_ref":"y"}');
    expect(verifyGnapRequest(tampered, key.jwk).ok).toBe(false);
  });

  it('another key cannot pass for this one', async () => {
    const key = await makeKey();
    const other = await makeKey();
    const url = 'https://test.agropper.xyz/gnap/continue/abc';
    const sig = await signRequest({ method: 'POST', url, headers: {}, privateKey: other.privateKey, kid: key.jwk.kid });
    expect(verifyGnapRequest(asServerSees(url, 'POST', sig, null), key.jwk).ok).toBe(false);
  });

  it('the interaction hash matches the server\'s', async () => {
    const args = ['client-nonce', 'server-nonce', 'ref-1', 'https://test.agropper.xyz/gnap/as/abc'] as const;
    expect(await interactionHash(...args)).toBe(serverInteractionHash(...args));
  });
});

describe('sealed answers open in the browser', () => {
  it('a box the server seals to a browser-made X25519 key opens with that key only', async () => {
    const pair = await newSealingKeyPair();
    const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const jwk = { kty: 'OKP', crv: 'X25519', x: String(pub.x) };
    expect(isX25519PublicJwk(jwk)).toBe(true);
    const box = sealTo(jwk, JSON.stringify({ kind: 'ready', continue: { uri: 'https://h.example/gnap/continue/abc' } }));
    expect(JSON.parse(await openSealed(pair.privateKey, box)).kind).toBe('ready');
    const other = await newSealingKeyPair();
    await expect(openSealed(other.privateKey, box)).rejects.toBeTruthy();
  });
});
