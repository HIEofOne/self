import PouchDBCore from 'pouchdb-core';
import PouchDBFindImport from 'pouchdb-find';
import PouchDBIdbImport from 'pouchdb-adapter-idb';

const PouchDB = (PouchDBCore as any)?.default || PouchDBCore;
const PouchDBFind = (PouchDBFindImport as any)?.default || PouchDBFindImport;
const PouchDBIdb = (PouchDBIdbImport as any)?.default || PouchDBIdbImport;

PouchDB.plugin(PouchDBIdb);
PouchDB.plugin(PouchDBFind);

type SnapshotPayload = {
  user: {
    userId: string;
    displayName?: string;
    isTemporary?: boolean;
    isAdmin?: boolean;
  };
  files?: any;
  savedChats?: any;
  currentChat?: any;
  currentMedications?: string | null;
  patientSummary?: string | null;
  initialFile?: {
    fileName?: string;
    bucketKey?: string;
  } | null;
  fileStatusSummary?: Array<{
    fileName?: string;
    bucketKey?: string;
    chipStatus: 'indexed' | 'pending' | 'not_in_kb';
  }>;
};

type SnapshotDoc = SnapshotPayload & {
  _id: string;
  type: 'user_snapshot';
  updatedAt: string;
};

const LAST_SNAPSHOT_KEY = 'maia_last_snapshot_user';
const PASSKEY_BACKUP_PROMPT_SKIP_KEY = 'passkey-backup-prompt-skip';

const ENCRYPTED_DOC_ID = 'user_snapshot_encrypted';
const PBKDF2_ITERATIONS = 100000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const KEY_LENGTH = 256;

/** Per-user localStorage key prefixes/suffixes used by wizard and Saved Files (must stay in sync with ChatInterface.vue and MyStuffDialog.vue). */
const PER_USER_LOCAL_STORAGE_KEYS = (userId: string): string[] => [
  `wizard-completion-${userId}`,
  `wizardStage2NoDevice-${userId}`,
  `wizardKbPendingFileName-${userId}`
];

const dbCache = new Map<string, PouchDB.Database>();

export const getUserDb = (userId: string): PouchDB.Database => {
  const key = `maia-user-${userId}`;
  if (!dbCache.has(key)) {
    dbCache.set(key, new PouchDB(key));
  }
  return dbCache.get(key)!;
};

const upsertDoc = async (db: PouchDB.Database, doc: Omit<SnapshotDoc, '_rev'>) => {
  try {
    const existing = await db.get(doc._id);
    return db.put({ ...doc, _rev: existing._rev });
  } catch (error: any) {
    if (error?.status === 404) {
      return db.put(doc);
    }
    throw error;
  }
};

export const saveUserSnapshot = async (payload: SnapshotPayload) => {
  if (!payload?.user?.userId) return;
  const db = getUserDb(payload.user.userId);
  const snapshot: SnapshotDoc = {
    _id: 'user_snapshot',
    type: 'user_snapshot',
    updatedAt: new Date().toISOString(),
    ...payload
  };
  await upsertDoc(db, snapshot);
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(LAST_SNAPSHOT_KEY, payload.user.userId);
  }
};

export const getLastSnapshotUserId = () => {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  return window.localStorage.getItem(LAST_SNAPSHOT_KEY);
};

export const clearLastSnapshotUserId = () => {
  if (typeof window === 'undefined' || !window.localStorage) return;
  window.localStorage.removeItem(LAST_SNAPSHOT_KEY);
};

/** Remove local snapshot for a user (destroy IndexedDB, clear last-snapshot key if it was this user). */
export const clearUserSnapshot = async (userId: string) => {
  if (!userId) return;
  // Clear the File System Access API directory handle (if any)
  try {
    const { clearDirectoryHandle } = await import('./localFolder');
    await clearDirectoryHandle(userId);
  } catch {
    // localFolder module may not be available
  }
  const key = `maia-user-${userId}`;
  const db = dbCache.get(key);
  if (db) {
    try {
      await db.destroy();
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[localDb] PouchDB destroy failed:', e);
    } finally {
      dbCache.delete(key);
    }
  } else {
    const tempDb = new PouchDB(key);
    try {
      await tempDb.destroy();
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[localDb] PouchDB destroy (uncached) failed:', e);
    } finally {
      dbCache.delete(key);
    }
  }
  if (typeof window !== 'undefined' && window.indexedDB) {
    try {
      window.indexedDB.deleteDatabase(key);
      window.indexedDB.deleteDatabase(`_pouch_${key}`);
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[localDb] indexedDB.deleteDatabase fallback failed:', e);
    }
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    if (window.localStorage.getItem(LAST_SNAPSHOT_KEY) === userId) {
      window.localStorage.removeItem(LAST_SNAPSHOT_KEY);
    }
    for (const k of PER_USER_LOCAL_STORAGE_KEYS(userId)) {
      try {
        window.localStorage.removeItem(k);
      } catch {
        // ignore
      }
    }
  }
};

export const getUserSnapshot = async (userId: string) => {
  if (!userId) return null;
  const db = getUserDb(userId);
  try {
    const doc = await db.get<SnapshotDoc>('user_snapshot');
    return doc || null;
  } catch (error: any) {
    if (error?.status === 404) return null;
    throw error;
  }
};

export const getPasskeyBackupPromptSkip = (): boolean => {
  if (typeof window === 'undefined' || !window.localStorage) return false;
  return window.localStorage.getItem(PASSKEY_BACKUP_PROMPT_SKIP_KEY) === 'true';
};export const setPasskeyBackupPromptSkip = (skip: boolean) => {
  if (typeof window === 'undefined' || !window.localStorage) return;
  if (skip) {
    window.localStorage.setItem(PASSKEY_BACKUP_PROMPT_SKIP_KEY, 'true');
  } else {
    window.localStorage.removeItem(PASSKEY_BACKUP_PROMPT_SKIP_KEY);
  }
};/** Encrypt payload with 4-digit PIN (PBKDF2 + AES-GCM) and store in user DB. */
export const saveUserSnapshotEncrypted = async (
  payload: SnapshotPayload,
  pin: string
): Promise<void> => {
  if (!payload?.user?.userId || !pin || pin.length !== 4) {
    throw new Error('User ID and 4-digit PIN required');
  }
  if (typeof crypto !== 'undefined' && !crypto.subtle) {
    throw new Error('Encryption not supported in this browser');
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const enc = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(pin),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    passwordKey,
    { name: 'AES-GCM', length: KEY_LENGTH },
    false,
    ['encrypt']
  );
  const plaintext = enc.encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    key,
    plaintext
  );
  const b64 = (b: ArrayBuffer | Uint8Array) =>
    btoa(String.fromCharCode(...new Uint8Array(b)));
  const doc = {
    _id: ENCRYPTED_DOC_ID,
    type: 'user_snapshot_encrypted',
    encrypted: b64(ciphertext),
    iv: b64(iv),
    salt: b64(salt),
    updatedAt: new Date().toISOString()
  };
  const db = getUserDb(payload.user.userId);
  try {
    const existing = await db.get(ENCRYPTED_DOC_ID);
    await db.put({ ...doc, _rev: (existing as any)._rev });
  } catch (e: any) {
    if (e?.status === 404) {
      await db.put(doc);
    } else {
      throw e;
    }
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(LAST_SNAPSHOT_KEY, payload.user.userId);
  }
};