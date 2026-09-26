/**
 * GNAP grants for a patient's personal AS — the decision logic, kept pure
 * so every route (direct now; group and member in P6) builds the same
 * evaluator input and decides the same way (I-30, group_requests.md §10).
 */
import { createHash, randomBytes } from 'crypto';
import {
  POLICY_SCOPES, POLICY_PURPOSES, evaluatePolicies, evaluationOptionsFor
} from '../routes/policies.js';
import { applyPseudonymMapping } from '../privacyFilter.js';
import { medsAllergiesArtifact } from '../utils/summary-sections.js';
import { isAcceptableClientKey, publicJwk } from './httpsig.js';

/** MAIA's access type (§10.3, D8). */
export const ACCESS_TYPE = 'urn:maia:access:record:v1';

export const GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // same as relay / tally
/** A client instance that verified an email is recognized this long (§10.6). */
export const INSTANCE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
export const TOKEN_TTL_S = 3600;
export const FIRST_WAIT_S = 60;
export const MAX_WAIT_S = 3600;
export const MAX_MESSAGE = 1000;
export const MAX_DISPLAY_NAME = 80;

export const newHandle = () => randomBytes(18).toString('base64url');
export const newTokenValue = () => randomBytes(32).toString('base64url');
export const hashToken = (value) => createHash('sha256').update(String(value)).digest('hex');

export class GnapError extends Error {
  constructor(code, description, status = 400) {
    super(description || code);
    this.code = code;
    this.status = status;
  }
}

const isHttpsUri = (u) => {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
  } catch { return false; }
};

/**
 * Validate a grant request (RFC 9635 §2). Unknown values are refused, never
 * coerced — the normalizeCard philosophy (§10.3).
 */
export function parseGrantRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new GnapError('invalid_request', 'A JSON object is required');
  const at = body.access_token;
  if (!at || typeof at !== 'object' || Array.isArray(at)) {
    throw new GnapError('invalid_request', 'access_token must be a single access request object');
  }
  const flags = Array.isArray(at.flags) ? at.flags : [];
  if (flags.includes('bearer')) throw new GnapError('invalid_flag', 'Bearer tokens are not issued; tokens are bound to the client key');
  if (flags.some((f) => f !== 'bearer')) throw new GnapError('invalid_flag', 'Unknown flag');
  if (!Array.isArray(at.access) || at.access.length !== 1) throw new GnapError('invalid_request', 'Exactly one access object is supported');
  const a = at.access[0];
  if (!a || typeof a !== 'object' || a.type !== ACCESS_TYPE) throw new GnapError('invalid_request', `access type must be ${ACCESS_TYPE}`);
  if (!Array.isArray(a.datatypes) || a.datatypes.length !== 1 || !POLICY_SCOPES.includes(a.datatypes[0])) {
    throw new GnapError('invalid_request', `datatypes must be exactly one of: ${POLICY_SCOPES.join(', ')}`);
  }
  const scope = a.datatypes[0];
  if (!Array.isArray(a.actions) || a.actions.length !== 1) throw new GnapError('invalid_request', 'Exactly one action is supported');
  const action = a.actions[0];
  if (action === 'add') throw new GnapError('invalid_request', 'Adding documents is not supported yet');
  if (action === 'notify' ? scope !== 'notification-only' : (action !== 'read' || scope === 'notification-only')) {
    throw new GnapError('invalid_request', 'Use actions ["notify"] for notification-only and ["read"] otherwise');
  }
  if (!POLICY_PURPOSES.includes(a.purpose)) throw new GnapError('invalid_request', `purpose must be one of: ${POLICY_PURPOSES.join(', ')}`);
  let ahCategory;
  if (scope === 'ah-category') {
    if (typeof a.ahCategory !== 'string' || !a.ahCategory.trim() || a.ahCategory.length > 60) {
      throw new GnapError('invalid_request', 'ah-category needs an ahCategory');
    }
    ahCategory = a.ahCategory.trim();
  }

  // A returning client presents the instance_id it was given (RFC 9635
  // §2.3); the route looks up its key and checks the signature with it.
  const client = body.client;
  let clientInstance = null;
  if (typeof client === 'string') {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(client)) throw new GnapError('invalid_client', 'Unknown client instance', 401);
    clientInstance = client;
  } else {
    if (!client || typeof client !== 'object' || !client.key || client.key.proof !== 'httpsig') {
      throw new GnapError('invalid_client', 'client.key with proof "httpsig" is required');
    }
    if (!isAcceptableClientKey(client.key.jwk)) {
      throw new GnapError('invalid_client', 'client.key.jwk must be a public Ed25519 JWK with a kid');
    }
  }
  const displayName = typeof client?.display?.name === 'string'
    ? client.display.name.trim().slice(0, MAX_DISPLAY_NAME) : '';

  let interact = null;
  if (body.interact !== undefined) {
    const i = body.interact;
    if (!i || !Array.isArray(i.start) || i.start.length !== 1 || i.start[0] !== 'redirect') {
      throw new GnapError('invalid_request', 'interact.start must be ["redirect"]');
    }
    let finish = null;
    if (i.finish !== undefined) {
      const f = i.finish;
      if (!f || !['redirect', 'push'].includes(f.method) || !isHttpsUri(f.uri)
        || typeof f.nonce !== 'string' || f.nonce.length < 8 || f.nonce.length > 128) {
        throw new GnapError('invalid_request', 'interact.finish needs method redirect|push, an https uri and a nonce');
      }
      finish = { method: f.method, uri: f.uri, nonce: f.nonce };
    }
    interact = { start: ['redirect'], finish };
  }

  const message = typeof body.maia_message === 'string' ? body.maia_message.trim().slice(0, MAX_MESSAGE) : '';
  return {
    access: { type: ACCESS_TYPE, actions: [action], datatypes: [scope], purpose: a.purpose, ...(ahCategory ? { ahCategory } : {}) },
    clientKey: clientInstance ? null : publicJwk(client.key.jwk),
    clientInstance,
    displayName,
    interact,
    message
  };
}

/** The evaluator input (I-30: every route builds the same shape). */
export const toPolicyRequest = (access, { verifiedEmail = false } = {}) => ({
  party: { type: 'anyone' },
  purpose: access.purpose,
  scope: access.datatypes[0],
  ...(access.ahCategory ? { ahCategory: access.ahCategory } : {}),
  signature: verifiedEmail ? 'verified-email' : 'unverified',
  payment: 'none'
});

/**
 * The privacy-filtered artifact a scope releases, or null when there is
 * nothing the patient verified to release (then the request asks, never
 * answers empty). Only filtered artifacts ever leave (I-3, I-22).
 */
export function artifactFor(userDoc, scope) {
  if (scope === 'notification-only') return { datatype: scope, text: '' };
  if (scope === 'meds-allergies') {
    const text = medsAllergiesArtifact(userDoc, applyPseudonymMapping);
    return text ? { datatype: scope, text } : null;
  }
  const pf = String(userDoc?.privacyFilteredSummary?.text || '').trim();
  return pf && userDoc?.patientSummaryVerifiedAt ? { datatype: scope, text: pf } : null;
}

/**
 * Decide with the patient's current cards — the same evaluator and options
 * as every route (I-24: confirmed cards only, and nothing decides while
 * sharing is off). → allow | ask | deny-respond | deny-silent
 */
export function decideGrant(userDoc, policyRequest) {
  const d = evaluatePolicies(userDoc?.sharingPolicies || [], policyRequest, evaluationOptionsFor(userDoc));
  if (d.outcome === 'deny') {
    return { outcome: d.decidedBy?.denyMode === 'respond' ? 'deny-respond' : 'deny-silent', policyId: d.decidedBy?.id || null };
  }
  if (d.outcome === 'allow') {
    if (!artifactFor(userDoc, policyRequest.scope)) return { outcome: 'ask', policyId: null, reason: 'no-artifact' };
    return { outcome: 'allow', policyId: d.decidedBy?.id || null };
  }
  return { outcome: 'ask', policyId: d.decidedBy?.id || null, reason: d.reason || null };
}

/**
 * At the resource server: may this grant still read (§10.7 check 4)?
 * Pausing sharing stops every read; a deny card stops it; a grant the
 * cards allowed must still be allowed now; a grant the patient approved by
 * hand stays readable while no card denies it.
 */
export function mayStillRead(userDoc, grant) {
  const opts = evaluationOptionsFor(userDoc);
  if (opts.asState === 'paused') return false;
  const d = evaluatePolicies(userDoc?.sharingPolicies || [], grant.policyRequest, { ...opts, asState: 'active' });
  if (d.outcome === 'deny') return false;
  if (grant.decision?.by === 'patient') return true;
  return opts.asState === 'active' && d.outcome === 'allow';
}

/** Wait before the next poll: 60 s, doubling to an hour. */
export const nextWait = (polls) => Math.min(MAX_WAIT_S, FIRST_WAIT_S * 2 ** Math.max(0, polls));

/** RFC 9635 §4.2.3 interaction hash. */
export const interactionHash = (clientNonce, serverNonce, interactRef, grantEndpoint) =>
  createHash('sha256').update([clientNonce, serverNonce, interactRef, grantEndpoint].join('\n')).digest('base64url');
