/**
 * HTTP Message Signatures with the GNAP profile (server/gnap/httpsig.js,
 * group_requests.md §10.4): the RFC 9421 Appendix B vectors, then the GNAP
 * rules — covered components, Content-Digest, created window, keyid,
 * replayed nonce, wrong key.
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import {
  parseDictionary, serializeSignatureParams, signatureBase, signRequest, verifySignature,
  verifyGnapRequest, createNonceCache, contentDigest, contentDigestMatches, jwkThumbprint
} from '../../server/gnap/httpsig.js';

// RFC 9421 B.1.4 — test-key-ed25519
const TEST_KEY = {
  kty: 'OKP', crv: 'Ed25519', kid: 'test-key-ed25519',
  d: 'n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU',
  x: 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs'
};
// RFC 9421 B.2 — the test request
const TEST_REQUEST = {
  method: 'POST',
  targetUri: 'https://example.com/foo?param=Value&Pet=dog',
  headers: {
    host: 'example.com',
    date: 'Tue, 20 Apr 2021 02:07:55 GMT',
    'content-type': 'application/json',
    'content-digest': 'sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:',
    'content-length': '18'
  },
  rawBody: Buffer.from('{"hello": "world"}')
};
const B26_COMPONENTS = ['date', '@method', '@path', '@authority', 'content-type', 'content-length'];
const B26_PARAMS = [['created', 1618884473], ['keyid', 'test-key-ed25519']];
const B26_SIGNATURE = 'wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw==';

describe('RFC 9421 Appendix B', () => {
  it('B.2.6: the signature base matches the RFC text', () => {
    expect(signatureBase(TEST_REQUEST, B26_COMPONENTS, B26_PARAMS)).toBe([
      '"date": Tue, 20 Apr 2021 02:07:55 GMT',
      '"@method": POST',
      '"@path": /foo',
      '"@authority": example.com',
      '"content-type": application/json',
      '"content-length": 18',
      '"@signature-params": ("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"'
    ].join('\n'));
  });

  it('B.2.6: signing reproduces the RFC signature exactly (Ed25519 is deterministic)', () => {
    const h = signRequest({
      method: TEST_REQUEST.method, targetUri: TEST_REQUEST.targetUri, headers: TEST_REQUEST.headers,
      privateJwk: TEST_KEY, label: 'sig-b26', components: B26_COMPONENTS, extraParams: B26_PARAMS
    });
    expect(h['Signature']).toBe(`sig-b26=:${B26_SIGNATURE}:`);
    expect(h['Signature-Input']).toBe(`sig-b26=${serializeSignatureParams(B26_COMPONENTS, B26_PARAMS)}`);
  });

  it('B.2.6: the RFC signature verifies with the public key, and fails once tampered', () => {
    const msg = {
      ...TEST_REQUEST,
      headers: {
        ...TEST_REQUEST.headers,
        'signature-input': 'sig-b26=("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"',
        signature: `sig-b26=:${B26_SIGNATURE}:`
      }
    };
    const pub = { kty: 'OKP', crv: 'Ed25519', kid: 'test-key-ed25519', x: TEST_KEY.x };
    expect(verifySignature(msg, pub).ok).toBe(true);
    expect(verifySignature({ ...msg, method: 'GET' }, pub).ok).toBe(false);
  });

  it('the test request\'s Content-Digest matches its body; a changed body does not', () => {
    expect(contentDigestMatches(TEST_REQUEST.headers['content-digest'], TEST_REQUEST.rawBody)).toBe(true);
    expect(contentDigestMatches(TEST_REQUEST.headers['content-digest'], Buffer.from('{"hello": "World"}'))).toBe(false);
  });

  it('parses structured-field dictionaries with byte sequences, strings and integers', () => {
    const d = parseDictionary('sig1=("@method" "@target-uri");created=1;keyid="k";tag="gnap", sig2=:AQID:');
    expect(d.get('sig1').innerList.map((i) => i.value)).toEqual(['@method', '@target-uri']);
    expect(Object.fromEntries(d.get('sig1').params)).toEqual({ created: 1, keyid: 'k', tag: 'gnap' });
    expect([...d.get('sig2').value]).toEqual([1, 2, 3]);
  });
});

describe('the GNAP profile', () => {
  const keyPair = () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const jwk = { ...privateKey.export({ format: 'jwk' }), kid: 'client-1' };
    return { priv: jwk, pub: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, kid: jwk.kid } };
  };
  const signed = (priv, { body = '{"a":1}', method = 'POST', uri = 'https://maia.test/gnap/as/abc', headers = {}, created } = {}) => {
    const h = signRequest({ method, targetUri: uri, headers, body, privateJwk: priv, ...(created ? { created } : {}) });
    return {
      method, targetUri: uri, rawBody: body ? Buffer.from(body) : Buffer.alloc(0),
      headers: Object.fromEntries(Object.entries({ ...headers, ...h }).map(([k, v]) => [k.toLowerCase(), v]))
    };
  };

  it('accepts a proper request and names the key by its thumbprint', () => {
    const { priv, pub } = keyPair();
    const r = verifyGnapRequest(signed(priv), pub, { nonceCache: createNonceCache() });
    expect(r).toEqual({ ok: true, thumbprint: jwkThumbprint(pub) });
  });

  it('a body changed after signing fails the Content-Digest check', () => {
    const { priv, pub } = keyPair();
    const msg = signed(priv);
    msg.rawBody = Buffer.from('{"a":2}');
    expect(verifyGnapRequest(msg, pub).error).toBe('content-digest mismatch');
  });

  it('a digest recomputed for the new body still fails the signature', () => {
    const { priv, pub } = keyPair();
    const msg = signed(priv);
    msg.rawBody = Buffer.from('{"a":2}');
    msg.headers['content-digest'] = contentDigest('{"a":2}');
    expect(verifyGnapRequest(msg, pub).ok).toBe(false);
  });

  it('another key cannot use the grant', () => {
    const a = keyPair();
    const b = keyPair();
    expect(verifyGnapRequest(signed(a.priv), { ...b.pub, kid: 'client-1' }).ok).toBe(false);
  });

  it('a replayed nonce is refused', () => {
    const { priv, pub } = keyPair();
    const cache = createNonceCache();
    const msg = signed(priv);
    expect(verifyGnapRequest(msg, pub, { nonceCache: cache }).ok).toBe(true);
    expect(verifyGnapRequest(msg, pub, { nonceCache: cache }).error).toBe('replayed nonce');
  });

  it('a stale created is refused', () => {
    const { priv, pub } = keyPair();
    const msg = signed(priv, { created: Math.floor(Date.now() / 1000) - 600 });
    expect(verifyGnapRequest(msg, pub).error).toBe('created outside the allowed window');
  });

  it('a token presented must be covered by the signature', () => {
    const { priv, pub } = keyPair();
    const msg = signed(priv, { headers: { authorization: 'GNAP tok' } });
    expect(verifyGnapRequest(msg, pub).ok).toBe(true);
    msg.headers.authorization = 'GNAP other';
    expect(verifyGnapRequest(msg, pub).ok).toBe(false);
  });

  it('keyid must name the bound key', () => {
    const { priv, pub } = keyPair();
    expect(verifyGnapRequest(signed(priv), { ...pub, kid: 'someone-else' }).error).toBe('keyid does not match the key');
  });
});
