#!/usr/bin/env node
/**
 * GNAP reference client for a patient's personal MAIA (group_requests.md
 * §10.11). Asks for access, waits and continues as told, optionally sends
 * you to the email-verification page, and reads the artifact from the
 * resource server — the software counterpart of the request pages.
 *
 *   node scripts/gnap-client.mjs --as https://test.agropper.xyz/gnap/as/<asId> \
 *     [--datatype patient-summary] [--purpose clinical] [--name "Dr. Test"] \
 *     [--message "text"] [--interact] [--key ~/.maia-gnap-client.json] [--max-wait 300]
 *
 * The patient finds their address with GET /api/gnap/request-link while
 * signed in (P5 shows it on screen). The client key is Ed25519, kept in
 * --key (created on first use); it signs every request (RFC 9421).
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { generateKeyPairSync, randomBytes } from 'crypto';
import { signRequest } from '../server/gnap/httpsig.js';

const ACCESS_TYPE = 'urn:maia:access:record:v1';

const args = (() => {
  const out = { datatype: 'patient-summary', purpose: 'clinical', name: 'MAIA reference client', maxWait: 300 };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    const v = () => a[++i];
    if (k === '--as') out.as = v();
    else if (k === '--datatype') out.datatype = v();
    else if (k === '--purpose') out.purpose = v();
    else if (k === '--name') out.name = v();
    else if (k === '--message') out.message = v();
    else if (k === '--key') out.key = v();
    else if (k === '--max-wait') out.maxWait = Number(v());
    else if (k === '--interact') out.interact = true;
    else if (k === '--help' || k === '-h') out.help = true;
    else { console.error(`Unknown option ${k}`); process.exit(2); }
  }
  return out;
})();

if (args.help || !args.as) {
  console.log('Usage: node scripts/gnap-client.mjs --as <grant endpoint URL> [--datatype patient-summary|meds-allergies|…] [--purpose clinical|…] [--name "…"] [--message "…"] [--interact] [--key file] [--max-wait seconds]');
  process.exit(args.help ? 0 : 2);
}

const keyFile = args.key || path.join(homedir(), '.maia-gnap-client.json');
const loadKey = () => {
  if (existsSync(keyFile)) return JSON.parse(readFileSync(keyFile, 'utf8'));
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = { ...privateKey.export({ format: 'jwk' }), kid: `maia-client-${randomBytes(6).toString('hex')}` };
  writeFileSync(keyFile, JSON.stringify(jwk, null, 2), { mode: 0o600 });
  console.log(`New client key saved to ${keyFile}`);
  return jwk;
};
const priv = loadKey();
const pub = { kty: priv.kty, crv: priv.crv, x: priv.x, kid: priv.kid };

const signedFetch = async (method, url, { body = null, token = null } = {}) => {
  const text = body ? JSON.stringify(body) : null;
  const headers = { ...(text ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `GNAP ${token}` } : {}) };
  const sig = signRequest({ method, targetUri: url, headers, body: text, privateJwk: priv });
  const r = await fetch(url, { method, headers: { ...headers, ...sig }, ...(text ? { body: text } : {}) });
  const data = r.status === 204 ? null : await r.json().catch(() => ({}));
  return { status: r.status, data };
};

const sleep = (s) => new Promise((res) => setTimeout(res, s * 1000));

const readArtifact = async (at) => {
  const loc = at.access?.[0]?.locations?.[0];
  const r = await signedFetch('GET', loc, { token: at.value });
  if (r.status !== 200) {
    console.error(`Resource server said ${r.status}:`, r.data?.error || r.data);
    process.exit(1);
  }
  console.log(`\n── ${r.data.datatype} (retrieved ${r.data.retrievedAt}) ──\n${r.data.text}\n\n${r.data.attribution}`);
};

const main = async () => {
  const grant = {
    access_token: { access: [{ type: ACCESS_TYPE, actions: [args.datatype === 'notification-only' ? 'notify' : 'read'], datatypes: [args.datatype], purpose: args.purpose }] },
    client: { key: { proof: 'httpsig', jwk: pub }, display: { name: args.name } },
    ...(args.interact ? { interact: { start: ['redirect'] } } : {}),
    ...(args.message ? { maia_message: args.message } : {})
  };
  let r = await signedFetch('POST', args.as, { body: grant });
  const started = Date.now();
  for (;;) {
    if (r.data?.access_token) {
      console.log('Allowed. Reading…');
      return readArtifact(r.data.access_token);
    }
    if (r.data?.error) {
      console.log(`Finished: ${r.data.error.code || r.data.error}${r.data.error.description ? ` (${r.data.error.description})` : ''}`);
      process.exit(r.data.error.code === 'request_denied' ? 0 : 1);
    }
    if (!r.data?.continue) {
      console.error(`Unexpected response (${r.status}):`, r.data);
      process.exit(1);
    }
    if (r.data.interact?.redirect) {
      console.log(`To verify your email, open:\n  ${r.data.interact.redirect}`);
    }
    const { uri, wait, access_token: ct } = r.data.continue;
    if ((Date.now() - started) / 1000 + wait > args.maxWait) {
      console.log(`Still waiting for the patient. Continue later at ${uri} (not saved; rerun to ask again).`);
      process.exit(0);
    }
    console.log(`Waiting ${wait} s for the patient…`);
    await sleep(wait);
    r = await signedFetch('POST', uri, { token: ct.value });
  }
};

main().catch((e) => { console.error(e?.message || e); process.exit(1); });
