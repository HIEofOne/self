/**
 * COUCHDB_DB_PREFIX: per-app database namespace applied inside
 * CloudantClient at the nano boundary, so two MAIA apps can share one
 * CouchDB instance with separate `<prefix>maia_*` databases.
 */
import { describe, it, expect } from 'vitest';
import { CloudantClient } from '../../lib/cloudant/document-client.js';

const mk = (dbPrefix) => new CloudantClient({ url: 'http://localhost:5984', password: 'x', dbPrefix });

describe('CloudantClient database prefix', () => {
  it('default (no prefix) resolves names unchanged — production untouched', () => {
    const c = mk(undefined);
    expect(c._name('maia_users')).toBe('maia_users');
  });

  it('applies the configured prefix', () => {
    const c = mk('test_');
    expect(c._name('maia_users')).toBe('test_maia_users');
    expect(c._name('maia_groups')).toBe('test_maia_groups');
  });

  it('sanitizes to CouchDB-legal name characters', () => {
    const c = mk('Test App!_');
    expect(c._name('maia_users')).toBe('testapp_maia_users');
  });

  it('empty string prefix is a no-op', () => {
    const c = mk('');
    expect(c._name('maia_sessions')).toBe('maia_sessions');
  });
});
