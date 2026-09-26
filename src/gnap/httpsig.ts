/**
 * RFC 9421 request signing for the browser GNAP client, with the GNAP
 * profile (RFC 9635 §7.3.1) — the twin of server/gnap/httpsig.js's
 * signRequest, using WebCrypto so the private key never leaves the
 * browser (group_requests.md §10.10). tests/gnap-client.test.ts checks
 * these signatures with the server's verifier.
 */

export type PublicJwk = { kty: 'OKP'; crv: 'Ed25519'; x: string; kid: string };

const utf8 = (s: string) => new TextEncoder().encode(s);

const b64 = (bytes: ArrayBuffer | Uint8Array) => {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
};
export const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const sha256 = async (data: string | Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? utf8(data) : (data as BufferSource)));

export const randomToken = (bytes = 16) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

/** RFC 7638 thumbprint of an Ed25519 key (its kid here). */
export const jwkThumbprint = async (jwk: { crv: string; kty: string; x: string }) =>
  b64url(await sha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })));

/** Content-Digest (RFC 9530), sha-256 — of text, or of a document's bytes. */
export const contentDigest = async (body: string | Uint8Array) => `sha-256=:${b64(await sha256(body))}:`;

type Param = [string, string | number];
const serializeParams = (components: string[], params: Param[]) =>
  `(${components.map((c) => `"${c}"`).join(' ')})` +
  params.map(([k, v]) => `;${k}=${typeof v === 'number' ? v : `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`}`).join('');

export interface SignInput {
  method: string;
  url: string;
  /** Lower-case header names. */
  headers: Record<string, string>;
  body?: string | Uint8Array | null;
  privateKey: CryptoKey;
  kid: string;
  created?: number;
  nonce?: string;
}

/**
 * The headers to add to a request: Content-Digest (with a body),
 * Signature-Input and Signature. Covers @method, @target-uri, and
 * content-digest / authorization when present, tagged "gnap".
 */
export async function signRequest({
  method, url, headers, body = null, privateKey, kid,
  created = Math.floor(Date.now() / 1000), nonce = randomToken()
}: SignInput): Promise<Record<string, string>> {
  const h: Record<string, string> = { ...headers };
  const hasBody = typeof body === 'string' ? body.length > 0 : !!body && body.length > 0;
  if (hasBody) h['content-digest'] = await contentDigest(body as string | Uint8Array);
  const components = ['@method', '@target-uri', ...(hasBody ? ['content-digest'] : []), ...(h.authorization ? ['authorization'] : [])];
  const params: Param[] = [['created', created], ['nonce', nonce], ['keyid', kid], ['tag', 'gnap']];
  const value = (c: string) => (c === '@method' ? method.toUpperCase() : c === '@target-uri' ? new URL(url).href : h[c].trim());
  const sigParams = serializeParams(components, params);
  const base = [...components.map((c) => `"${c}": ${value(c)}`), `"@signature-params": ${sigParams}`].join('\n');
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, utf8(base));
  return {
    ...(hasBody ? { 'Content-Digest': h['content-digest'] } : {}),
    'Signature-Input': `sig=${sigParams}`,
    Signature: `sig=:${b64(sig)}:`
  };
}

/** RFC 9635 §4.2.3: the hash the AS sends back with the interaction. */
export const interactionHash = async (clientNonce: string, serverNonce: string, interactRef: string, grantEndpoint: string) =>
  b64url(await sha256([clientNonce, serverNonce, interactRef, grantEndpoint].join('\n')));
