/**
 * Recognized requesters (group_requests.md §10.6, §10.13). After a client
 * instance verifies an email with a patient's AS, the AS gives it an
 * `instance_id` (RFC 9635 §2.3). A later request that presents it, signed
 * by the same key, is judged at `verified-email` without a new code — for
 * 12 months, until the patient chooses Forget, or until they change their
 * request link (an instance belongs to the address it was issued at).
 *
 *   ci_<id> → { userId, asId, clientKey, email, displayName, expiresAt, forgottenAt }
 * The as_<asId> doc lists its instances ({ id, email }) so Forget can find
 * every instance of one requester.
 */
import { GnapError, INSTANCE_TTL_MS, newHandle } from './grants.js';
import { GNAP_DB, getDoc, updateDoc } from './store.js';

const MAX_INSTANCES_PER_AS = 200;

/** Issue (or return) the grant's instance_id once its requester verified an email. */
export async function issueInstance(cloudant, grant, now = Date.now()) {
  if (grant.instanceId) return grant.instanceId;
  const id = newHandle();
  await cloudant.saveDocument(GNAP_DB, {
    _id: `ci_${id}`, type: 'gnap_instance', userId: grant.userId, asId: grant.asId,
    clientKey: grant.clientKey, keyThumbprint: grant.keyThumbprint,
    email: grant.requester.email, displayName: grant.displayName || '',
    verifiedAt: new Date(now).toISOString(), expiresAt: new Date(now + INSTANCE_TTL_MS).toISOString(),
    forgottenAt: null
  });
  await updateDoc(cloudant, grant._id, (g) => { g.instanceId = id; return true; });
  await updateDoc(cloudant, `as_${grant.asId}`, (a) => {
    a.instances = [...(a.instances || []), { id, email: grant.requester.email }].slice(-MAX_INSTANCES_PER_AS);
    return true;
  });
  return id;
}

/** The instance a returning client presents, if it is still recognized here. */
export async function resolveInstance(cloudant, asId, instanceId, now = Date.now()) {
  const inst = await getDoc(cloudant, `ci_${instanceId}`);
  if (!inst || inst.type !== 'gnap_instance' || inst.asId !== asId || inst.forgottenAt || Date.parse(inst.expiresAt) < now) {
    throw new GnapError('invalid_client', 'Unknown client instance', 401);
  }
  return inst;
}

/** The patient's Forget: every instance of this grant's requester, at this address. */
export async function forgetRequester(cloudant, grantHandle, at = new Date().toISOString()) {
  const grant = await getDoc(cloudant, `gr_${grantHandle}`);
  const email = grant?.requester?.email;
  if (!grant || !email) return 0;
  const as = await getDoc(cloudant, `as_${grant.asId}`);
  const ids = new Set([
    ...(as?.instances || []).filter((i) => i.email === email).map((i) => i.id),
    ...(grant.instanceId ? [grant.instanceId] : [])
  ]);
  for (const id of ids) {
    await updateDoc(cloudant, `ci_${id}`, (c) => { if (c.forgottenAt) return false; c.forgottenAt = at; return true; });
  }
  return ids.size;
}
