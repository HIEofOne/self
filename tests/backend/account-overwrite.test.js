/**
 * A new account's private AI starts in the background while the patient
 * keeps going (passkey, folder, group join). Its save used to carry the
 * just-created account object, which had no _rev: the CouchDB client then
 * borrowed the latest revision and overwrote the account, erasing the
 * group membership saved meanwhile. The setup checklist joined again, and
 * the registry kept both entries.
 */
import { describe, it, expect } from 'vitest';
import { ensureUserAgent } from '../../server/routes/auth.js';

/** CouchDB's revision rules, plus lib/cloudant's "no _rev → borrow the
 *  latest one" behaviour that made the overwrite possible. */
class RevStore {
  constructor() { this.docs = new Map(); }
  async getDocument(_db, id) {
    const d = this.docs.get(id);
    return d ? structuredClone(d) : null;
  }
  async saveDocument(_db, doc) {
    const current = this.docs.get(doc._id);
    const toSave = structuredClone(doc);
    if (current && !toSave._rev) toSave._rev = current._rev;
    if (current && toSave._rev !== current._rev) {
      throw Object.assign(new Error('Document update conflict.'), { statusCode: 409 });
    }
    const n = current ? Number(current._rev.split('-')[0]) + 1 : 1;
    toSave._rev = `${n}-x`;
    this.docs.set(doc._id, toSave);
    return { id: doc._id, rev: toSave._rev, ok: true };
  }
}

const AGENT = {
  uuid: '11111111-2222-4333-8444-555555555555',
  name: 'david27-agent',
  deployment: { url: 'https://agent.example' },
  model: { inference_name: 'm' }
};

describe('the background agent start never overwrites the account', () => {
  it('keeps a group join saved while the agent was being looked up', async () => {
    const store = new RevStore();
    // The account as created (the object then handed to ensureUserAgent).
    const created = { _id: 'david27', userId: 'david27', emailVerified: true, assignedAgentId: AGENT.uuid };
    await store.saveDocument('maia_users', created);
    delete created._rev; // the create path kept no revision

    const doClient = {
      agent: {
        get: async () => {
          // Meanwhile the setup checklist joins a group.
          const d = await store.getDocument('maia_users', 'david27');
          d.groupMemberships = [{ groupId: 'trustee-test', pairwiseId: 'p1' }];
          await store.saveDocument('maia_users', d);
          return AGENT;
        }
      }
    };

    await ensureUserAgent(doClient, store, created);
    const after = await store.getDocument('maia_users', 'david27');
    expect(after.groupMemberships).toEqual([{ groupId: 'trustee-test', pairwiseId: 'p1' }]);
    expect(after.agentEndpoint).toBe('https://agent.example/api/v1');
  });
});
