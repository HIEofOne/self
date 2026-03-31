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
};

/** Remove local snapshot for a user (destroy IndexedDB, clear per-user keys). */
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
