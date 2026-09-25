/**
 * HTTP Message Signatures (RFC 9421) with the GNAP profile (RFC 9635
 * §7.3.1) — group_requests.md §10.4.
 *
 * Hand-written and small on purpose, for auditability: a parser for the
 * Structured Field dictionaries in Signature-Input / Signature (RFC 8941),
 * signature-base construction, Ed25519 through Node's crypto, and
 * Content-Digest (RFC 9530). Checked against the RFC 9421 Appendix B test
 * vectors (tests/backend/gnap-httpsig.test.js). Shared by the server and
 * the reference client (scripts/gnap-client.mjs).
 */
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, randomBytes } from 'crypto';

// ── Structured Fields (just what signatures use) ─────────────────────────

class SfParser {
  constructor(input) { this.s = String(input || ''); this.i = 0; }
  ws() { while (this.i < this.s.length && (this.s[this.i] === ' ' || this.s[this.i] === '\t')) this.i++; }
  peek() { return this.s[this.i]; }
  fail(msg) { throw new Error(`structured field: ${msg} at ${this.i}`); }
  key() {
    const m = /^[a-z*][a-z0-9_\-.*]*/.exec(this.s.slice(this.i));
    if (!m) this.fail('key');
    this.i += m[0].length;
    return m[0];
  }
  bareItem() {
    const c = this.peek();
    if (c === '"') {
      this.i++;
      let out = '';
      while (this.i < this.s.length) {
        const ch = this.s[this.i++];
        if (ch === '\\') { out += this.s[this.i++]; continue; }
        if (ch === '"') return out;
        out += ch;
      }
      this.fail('unterminated string');
    }
    if (c === ':') {
      const end = this.s.indexOf(':', this.i + 1);
      if (end < 0) this.fail('unterminated byte sequence');
      const b64 = this.s.slice(this.i + 1, end);
      this.i = end + 1;
      return Buffer.from(b64, 'base64');
    }
    if (c === '?') { this.i++; const v = this.s[this.i++]; return v === '1'; }
    const num = /^-?\d+(\.\d+)?/.exec(this.s.slice(this.i));
    if (num) { this.i += num[0].length; return Number(num[0]); }
    const tok = /^[A-Za-z*][A-Za-z0-9!#$%&'*+\-.^_`|~:/]*/.exec(this.s.slice(this.i));
    if (tok) { this.i += tok[0].length; return { token: tok[0] }; }
    this.fail('item');
  }
  params() {
    const out = [];
    while (this.peek() === ';') {
      this.i++;
      this.ws();
      const k = this.key();
      let v = true;
      if (this.peek() === '=') { this.i++; v = this.bareItem(); }
      out.push([k, v]);
    }
    return out;
  }
  itemOrInnerList() {
    if (this.peek() === '(') {
      this.i++;
      const items = [];
      for (;;) {
        this.ws();
        if (this.peek() === ')') { this.i++; break; }
        const v = this.bareItem();
        const p = this.params();
        items.push({ value: v, params: p });
        if (this.peek() !== ' ' && this.peek() !== ')') this.fail('inner list');
      }
      return { innerList: items, params: this.params() };
    }
    const v = this.bareItem();
    return { value: v, params: this.params() };
  }
  dictionary() {
    const out = new Map();
    this.ws();
    while (this.i < this.s.length) {
      const k = this.key();
      let member = { value: true, params: [] };
      if (this.peek() === '=') { this.i++; member = this.itemOrInnerList(); } else { member.params = this.params(); }
      out.set(k, member);
      this.ws();
      if (this.i >= this.s.length) break;
      if (this.peek() !== ',') this.fail('dictionary');
      this.i++;
      this.ws();
    }
    return out;
  }
}

export const parseDictionary = (header) => new SfParser(header).dictionary();

const serializeParamValue = (v) => {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '' : '=?0';
  if (v && typeof v === 'object' && 'token' in v) return v.token;
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};

/** The `@signature-params` value: the inner list of covered components
 *  with its parameters, in order. */
export const serializeSignatureParams = (components, params) =>
  `(${components.map((c) => `"${c}"`).join(' ')})` +
  params.map(([k, v]) => (v === true ? `;${k}` : `;${k}=${serializeParamValue(v)}`)).join('');

// ── Component values and the signature base ─────────────────────────────

/** A request as the signer or verifier sees it. `targetUri` is absolute. */
export const componentValue = (name, msg) => {
  const url = new URL(msg.targetUri);
  switch (name) {
    case '@method': return String(msg.method || '').toUpperCase();
    case '@target-uri': return url.href;
    case '@authority': return url.host.toLowerCase();
    case '@scheme': return url.protocol.replace(/:$/, '').toLowerCase();
    case '@path': return url.pathname;
    case '@query': return url.search || '?';
    case '@request-target': return url.pathname + url.search;
    default: {
      if (name.startsWith('@')) throw new Error(`unsupported derived component ${name}`);
      const v = msg.headers?.[name.toLowerCase()];
      if (v === undefined || v === null) throw new Error(`missing header ${name}`);
      return (Array.isArray(v) ? v.join(', ') : String(v)).trim();
    }
  }
};

export const signatureBase = (msg, components, params) => [
  ...components.map((c) => `"${c}": ${componentValue(c, msg)}`),
  `"@signature-params": ${serializeSignatureParams(components, params)}`
].join('\n');

// ── Keys ─────────────────────────────────────────────────────────────────

const isEd25519Jwk = (jwk) => jwk && jwk.kty === 'OKP' && jwk.crv === 'Ed25519' && typeof jwk.x === 'string';

/** RFC 7638 thumbprint (base64url SHA-256 of the canonical members). */
export const jwkThumbprint = (jwk) => createHash('sha256')
  .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
  .digest('base64url');

/** The public half of a JWK (never keep `d` around by accident). */
export const publicJwk = (jwk) => ({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, ...(jwk.kid ? { kid: jwk.kid } : {}), ...(jwk.alg ? { alg: jwk.alg } : {}) });

export const isAcceptableClientKey = (jwk) => isEd25519Jwk(jwk) && !jwk.d && typeof jwk.kid === 'string' && jwk.kid.length > 0 && jwk.kid.length <= 200;

// ── Content-Digest (RFC 9530) ────────────────────────────────────────────

export const contentDigest = (body, alg = 'sha-256') =>
  `${alg}=:${createHash(alg === 'sha-512' ? 'sha512' : 'sha256').update(body || '').digest('base64')}:`;

/** Does the header carry a sha-256 or sha-512 digest matching the body? */
export const contentDigestMatches = (header, rawBody) => {
  let dict;
  try { dict = parseDictionary(header); } catch { return false; }
  let checked = false;
  for (const [alg, algo] of [['sha-256', 'sha256'], ['sha-512', 'sha512']]) {
    const m = dict.get(alg);
    if (!m || !Buffer.isBuffer(m.value)) continue;
    checked = true;
    const want = createHash(algo).update(rawBody || Buffer.alloc(0)).digest();
    if (!want.equals(m.value)) return false;
  }
  return checked;
};

// ── Signing (the client side; also the RFC vector test) ─────────────────

/**
 * Sign a request. Returns the headers to add: Signature-Input, Signature,
 * and Content-Digest when there is a body (covered automatically).
 */
export function signRequest({
  method, targetUri, headers = {}, body = null, privateJwk, label = 'sig',
  components = null, created = Math.floor(Date.now() / 1000), nonce = randomBytes(16).toString('base64url'),
  tag = 'gnap', extraParams = null
}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const hasBody = body !== null && body !== undefined && String(body).length > 0;
  if (hasBody && !h['content-digest']) h['content-digest'] = contentDigest(body);
  const comps = components || [
    '@method', '@target-uri',
    ...(hasBody ? ['content-digest'] : []),
    ...(h.authorization ? ['authorization'] : [])
  ];
  const params = extraParams || [
    ['created', created],
    ...(nonce ? [['nonce', nonce]] : []),
    ['keyid', privateJwk.kid],
    ...(tag ? [['tag', tag]] : [])
  ];
  const msg = { method, targetUri, headers: h };
  const base = signatureBase(msg, comps, params);
  const key = createPrivateKey({ key: privateJwk, format: 'jwk' });
  const sig = edSign(null, Buffer.from(base), key).toString('base64');
  return {
    ...(hasBody ? { 'Content-Digest': h['content-digest'] } : {}),
    'Signature-Input': `${label}=${serializeSignatureParams(comps, params)}`,
    'Signature': `${label}=:${sig}:`
  };
}

/** Verify one labeled signature against a public JWK (no GNAP rules). */
export function verifySignature(msg, publicKeyJwk, { label = null } = {}) {
  const inputs = parseDictionary(msg.headers?.['signature-input']);
  const sigs = parseDictionary(msg.headers?.signature);
  const lbl = label || [...inputs.keys()][0];
  const input = inputs.get(lbl);
  const sig = sigs.get(lbl);
  if (!input?.innerList || !sig || !Buffer.isBuffer(sig.value)) return { ok: false, error: 'no signature' };
  const components = input.innerList.map((it) => String(it.value));
  const base = signatureBase(msg, components, input.params);
  const key = createPublicKey({ key: publicJwk(publicKeyJwk), format: 'jwk' });
  const ok = edVerify(null, Buffer.from(base), key, sig.value);
  return ok ? { ok: true, label: lbl, components, params: Object.fromEntries(input.params) } : { ok: false, error: 'bad signature' };
}

// ── The GNAP profile (RFC 9635 §7.3.1) ──────────────────────────────────

const MAX_SKEW_S = 5 * 60;
const NONCE_TTL_MS = 10 * 60 * 1000;

/** A replay cache for nonces (per key), 10 minutes. */
export function createNonceCache({ ttlMs = NONCE_TTL_MS } = {}) {
  const seen = new Map();
  return {
    /** true the first time within the window; false for a replay */
    use(key, nonce, now = Date.now()) {
      for (const [k, t] of seen) if (now - t > ttlMs) seen.delete(k);
      const id = `${key} ${nonce}`;
      if (seen.has(id)) return false;
      seen.set(id, now);
      return true;
    },
    size: () => seen.size
  };
}

/**
 * Verify a GNAP request signed with the client's bound key.
 * @param {{method, targetUri, headers, rawBody}} msg — headers lowercased
 * @param {object} publicKeyJwk — the key bound to the grant
 * @returns {{ok: true, thumbprint} | {ok: false, error}}
 */
export function verifyGnapRequest(msg, publicKeyJwk, { nonceCache = null, now = Date.now() } = {}) {
  if (!isEd25519Jwk(publicKeyJwk)) return { ok: false, error: 'unsupported key' };
  let inputs;
  try { inputs = parseDictionary(msg.headers?.['signature-input']); } catch { return { ok: false, error: 'malformed Signature-Input' }; }
  // The GNAP signature is the one tagged "gnap".
  const label = [...inputs.entries()].find(([, v]) => v.params?.some(([k, val]) => k === 'tag' && val === 'gnap'))?.[0];
  if (!label) return { ok: false, error: 'no gnap-tagged signature' };
  const input = inputs.get(label);
  const components = (input.innerList || []).map((it) => String(it.value));
  const params = Object.fromEntries(input.params);
  const hasBody = msg.rawBody && msg.rawBody.length > 0;
  for (const c of ['@method', '@target-uri', ...(hasBody ? ['content-digest'] : []), ...(msg.headers?.authorization ? ['authorization'] : [])]) {
    if (!components.includes(c)) return { ok: false, error: `signature must cover ${c}` };
  }
  if (hasBody && !contentDigestMatches(msg.headers['content-digest'], msg.rawBody)) return { ok: false, error: 'content-digest mismatch' };
  if (!Number.isInteger(params.created)) return { ok: false, error: 'created is required' };
  if (Math.abs(now / 1000 - params.created) > MAX_SKEW_S) return { ok: false, error: 'created outside the allowed window' };
  if (Number.isInteger(params.expires) && now / 1000 > params.expires) return { ok: false, error: 'signature expired' };
  if (publicKeyJwk.kid && params.keyid !== publicKeyJwk.kid) return { ok: false, error: 'keyid does not match the key' };
  if (params.alg !== undefined && params.alg !== 'ed25519') return { ok: false, error: 'unsupported alg' };
  let result;
  try { result = verifySignature(msg, publicKeyJwk, { label }); } catch (e) { return { ok: false, error: e?.message || 'bad signature' }; }
  if (!result.ok) return result;
  const thumbprint = jwkThumbprint(publicKeyJwk);
  if (params.nonce !== undefined && nonceCache && !nonceCache.use(thumbprint, String(params.nonce), now)) {
    return { ok: false, error: 'replayed nonce' };
  }
  return { ok: true, thumbprint };
}
