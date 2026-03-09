import { CloudantClient } from '../../lib/cloudant/index.js';

const TEST_DB_PREFIX = 'test_maia_';
const DATABASES = ['sessions', 'users', 'audit_log', 'chats'];

export function getTestCloudant() {
  return new CloudantClient({
    url: process.env.CLOUDANT_URL || 'http://localhost:5984',
    username: process.env.CLOUDANT_USERNAME || 'admin',
    password: process.env.CLOUDANT_PASSWORD || 'adminpass',
  });
}

export function getTestDbName(base) {
  return `${TEST_DB_PREFIX}${base}`;
}

export async function ensureTestDatabases() {
  const cloudant = getTestCloudant();
  for (const db of DATABASES) {
    await cloudant.createDatabase(getTestDbName(db));
  }
  return cloudant;
}

export async function cleanupTestDatabases() {
  const cloudant = getTestCloudant();
  for (const db of DATABASES) {
    try {
      await cloudant.db.db.destroy(getTestDbName(db));
    } catch (e) {
      // ignore — database may not exist
    }
  }
}
