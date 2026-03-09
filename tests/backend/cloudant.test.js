import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getTestCloudant } from '../helpers/db.js';

let cloudant;
const TEST_DB = 'test_vitest_cloudant';

beforeAll(async () => {
  cloudant = getTestCloudant();
  await cloudant.createDatabase(TEST_DB);
});

afterAll(async () => {
  try { await cloudant.db.db.destroy(TEST_DB); } catch (e) { /* ignore */ }
});

describe('CloudantClient', () => {
  it('testConnection returns true for local CouchDB', async () => {
    const result = await cloudant.testConnection();
    expect(result).toBe(true);
  });

  it('getDocument returns null for non-existent doc', async () => {
    const doc = await cloudant.getDocument(TEST_DB, 'does-not-exist');
    expect(doc).toBeNull();
  });

  it('saveDocument + getDocument round-trip', async () => {
    const doc = { _id: 'test-1', name: 'hello', createdAt: new Date().toISOString() };
    const result = await cloudant.saveDocument(TEST_DB, doc);
    expect(result.ok).toBe(true);

    const retrieved = await cloudant.getDocument(TEST_DB, 'test-1');
    expect(retrieved.name).toBe('hello');
  });

  it('deleteDocument removes the doc', async () => {
    await cloudant.saveDocument(TEST_DB, { _id: 'test-del', val: 1 });
    await cloudant.deleteDocument(TEST_DB, 'test-del');
    const gone = await cloudant.getDocument(TEST_DB, 'test-del');
    expect(gone).toBeNull();
  });

  it('findDocuments with selector', async () => {
    await cloudant.saveDocument(TEST_DB, { _id: 'find-1', type: 'fruit', name: 'apple' });
    await cloudant.saveDocument(TEST_DB, { _id: 'find-2', type: 'fruit', name: 'banana' });

    const result = await cloudant.findDocuments(TEST_DB, {
      selector: { type: 'fruit' },
    });
    expect(result.docs.length).toBeGreaterThanOrEqual(2);
  });

  it('createDatabase is idempotent', async () => {
    const result = await cloudant.createDatabase(TEST_DB);
    expect(result).toBe(true);
  });
});
