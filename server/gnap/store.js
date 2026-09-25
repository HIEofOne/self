/**
 * The maia_gnap database (group_requests.md §10.7). Every lookup is by
 * document id, so no query indexes are needed:
 *   as_<asId>        → the patient behind a personal AS address
 *   gr_<handle>      → a grant (the continue URI's handle)
 *   ix_<handle>      → an interaction page → its grant
 *   rs_<handle>      → a resource-server location → its grant
 *   tok_<sha256>     → an access token, by the hash of its value (I-28)
 *   tm_<handle>      → a token-management URI → its token
 * Token values are never stored, only their SHA-256.
 */
export const GNAP_DB = 'maia_gnap';

export const getDoc = async (cloudant, id) => {
  try { return await cloudant.getDocument(GNAP_DB, id); } catch { return null; }
};

/** Save with a conflict retry: `mutate(doc)` is re-applied to a fresh copy. */
export async function updateDoc(cloudant, id, mutate) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const doc = await getDoc(cloudant, id);
    if (!doc) return null;
    const keep = mutate(doc);
    if (keep === false) return doc;
    try {
      await cloudant.saveDocument(GNAP_DB, doc);
      return doc;
    } catch (e) {
      if (e?.statusCode === 409 && attempt < 2) continue;
      throw e;
    }
  }
  return null;
}

/**
 * The patient decided an "ask" in their requests list. Accept → the next
 * continue gets a token; decline → request_denied; block → silence, like a
 * deny-silent card (I-29). Nothing is emailed with an artifact (I-31).
 */
export const recordPatientDecision = (cloudant, grantHandle, decision) =>
  updateDoc(cloudant, `gr_${grantHandle}`, (g) => {
    if (g.state !== 'pending') return false;
    const at = new Date().toISOString();
    if (decision === 'accept') {
      g.state = 'approved';
      g.decision = { outcome: 'allow', by: 'patient', policyId: null, at };
    } else if (decision === 'decline') {
      g.state = 'denied';
      g.decision = { outcome: 'deny-respond', by: 'patient', policyId: null, at };
    } else {
      g.silent = true;
      g.decision = { outcome: 'deny-silent', by: 'patient', policyId: null, at };
    }
    return true;
  });
