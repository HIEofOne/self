/**
 * Local Folder Access via File System Access API (Chrome 122+)
 *
 * Provides persistent read/write access to a user-chosen local folder.
 * The folder stores documents, app state (maia-state.json), and setup logs.
 * Only one IndexedDB entry is used: the FileSystemDirectoryHandle.
 * Everything else lives in the local folder as real files.
 */

// ── File System Access API type augmentations (Chrome 122+) ────────
// These APIs are not in the default TypeScript DOM lib.

type FileSystemPermissionMode = 'read' | 'readwrite';

interface FileSystemHandlePermissionDescriptor {
  mode?: FileSystemPermissionMode;
}

interface FileSystemDirectoryPickerOptions {
  mode?: FileSystemPermissionMode;
  startIn?: FileSystemHandle | 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';
}

declare global {
  interface FileSystemHandle {
    queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  }
  interface FileSystemDirectoryHandle {
    values(): AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>;
  }
  interface Window {
    showDirectoryPicker(options?: FileSystemDirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
  }
}

// ── Feature detection ──────────────────────────────────────────────

export function isFileSystemAccessSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.showDirectoryPicker === 'function'
  );
}

// ── Types ──────────────────────────────────────────────────────────

export interface MaiaFileEntry {
  name: string;
  size: number;
  lastModified: number;
  fileHandle: FileSystemFileHandle;
}

export interface MaiaState {
  version: number;
  userId: string;
  displayName?: string;
  updatedAt: string;
  files?: Array<{
    fileName: string;
    size?: number;
    cloudStatus?: 'indexed' | 'pending' | 'not_in_kb' | 'uploaded';
    bucketKey?: string;
  }>;
  currentMedications?: string | null;
  patientSummary?: string | null;
  savedChats?: any;
  currentChat?: any;
  settings?: Record<string, any>;
}

const STATE_FILE_NAME = 'maia-state.json';

// ── IndexedDB handle storage ───────────────────────────────────────
// Minimal raw IndexedDB usage — one database, one store, one entry per user.
// FileSystemDirectoryHandle requires structured clone (no JSON, no cookies).

const HANDLE_DB_NAME = 'maia-folder-handles';
const HANDLE_STORE_NAME = 'handles';
const HANDLE_DB_VERSION = 1;

function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DB_NAME, HANDLE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE_NAME)) {
        db.createObjectStore(HANDLE_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeHandle(
  userId: string,
  handle: FileSystemDirectoryHandle
): Promise<void> {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE_NAME, 'readwrite');
    tx.objectStore(HANDLE_STORE_NAME).put(handle, userId);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function getStoredHandle(
  userId: string
): Promise<FileSystemDirectoryHandle | null> {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE_NAME, 'readonly');
    const req = tx.objectStore(HANDLE_STORE_NAME).get(userId);
    req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

// ── Handle lifecycle ───────────────────────────────────────────────

/**
 * Open a directory picker and store the handle. Must be called from a user gesture.
 */
export async function pickLocalFolder(
  userId: string
): Promise<{ handle: FileSystemDirectoryHandle; folderName: string } | null> {
  if (!isFileSystemAccessSupported()) return null;
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await storeHandle(userId, handle);
    return { handle, folderName: handle.name };
  } catch (e: any) {
    // User cancelled the picker
    if (e?.name === 'AbortError') return null;
    console.warn('[localFolder] pickLocalFolder failed:', e);
    return null;
  }
}

/**
 * Reconnect to a previously chosen folder (silent on Chrome 122+).
 * Returns null if no handle stored or permission denied.
 */
export async function reconnectLocalFolder(
  userId: string
): Promise<{ handle: FileSystemDirectoryHandle; folderName: string } | null> {
  if (!isFileSystemAccessSupported()) return null;
  try {
    const handle = await getStoredHandle(userId);
    if (!handle) return null;
    // Use queryPermission only — requestPermission requires a user gesture and
    // throws SecurityError when called during page load without user interaction.
    // If the browser has persistent permission (Chrome 122+) queryPermission
    // returns 'granted' silently; otherwise we defer until a user gesture.
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return null;
    return { handle, folderName: handle.name };
  } catch (e) {
    console.warn('[localFolder] reconnectLocalFolder failed:', e);
    return null;
  }
}

/**
 * Reconnect using requestPermission (requires active user gesture).
 * Use this when a user action (e.g. clicking paperclip) provides the gesture context
 * that queryPermission-only reconnect can't use.
 */
export async function reconnectLocalFolderWithGesture(
  userId: string
): Promise<{ handle: FileSystemDirectoryHandle; folderName: string } | null> {
  if (!isFileSystemAccessSupported()) return null;
  try {
    const handle = await getStoredHandle(userId);
    if (!handle) return null;
    // requestPermission works here because we're in a user gesture context
    const perm = await handle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return null;
    return { handle, folderName: handle.name };
  } catch (e) {
    console.warn('[localFolder] reconnectLocalFolderWithGesture failed:', e);
    return null;
  }
}

/**
 * Check folder connection status without requesting permission.
 */
export async function getLocalFolderStatus(
  userId: string
): Promise<{ configured: boolean; folderName: string | null; hasPermission: boolean }> {
  if (!isFileSystemAccessSupported()) {
    return { configured: false, folderName: null, hasPermission: false };
  }
  try {
    const handle = await getStoredHandle(userId);
    if (!handle) return { configured: false, folderName: null, hasPermission: false };
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    return {
      configured: true,
      folderName: handle.name,
      hasPermission: perm === 'granted',
    };
  } catch {
    return { configured: false, folderName: null, hasPermission: false };
  }
}

/**
 * Remove the stored handle for a user.
 */
export async function clearDirectoryHandle(userId: string): Promise<void> {
  try {
    const db = await openHandleDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE_NAME, 'readwrite');
      tx.objectStore(HANDLE_STORE_NAME).delete(userId);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch {
    // ignore — handle may not exist
  }
}

// ── File operations ────────────────────────────────────────────────

/**
 * List files in the folder root, optionally filtered by extension.
 */
export async function listFolderFiles(
  handle: FileSystemDirectoryHandle,
  options?: { extensions?: string[] }
): Promise<MaiaFileEntry[]> {
  const files: MaiaFileEntry[] = [];
  const exts = options?.extensions?.map(e => e.toLowerCase());
  for await (const entry of handle.values()) {
    if (entry.kind !== 'file') continue;
    if (exts) {
      const ext = entry.name.split('.').pop()?.toLowerCase();
      if (!ext || !exts.includes(ext)) continue;
    }
    try {
      const fileHandle = entry as FileSystemFileHandle;
      const file = await fileHandle.getFile();
      files.push({
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        fileHandle,
      });
    } catch {
      // skip files we can't read
    }
  }
  return files.sort((a, b) => b.lastModified - a.lastModified);
}

/**
 * Read a file from the folder by name. Returns null if not found.
 */
export async function readFileFromFolder(
  handle: FileSystemDirectoryHandle,
  fileName: string
): Promise<File | null> {
  try {
    const fileHandle = await handle.getFileHandle(fileName);
    return await fileHandle.getFile();
  } catch {
    return null;
  }
}

/**
 * Write a file to the folder root. Creates or overwrites.
 */
export async function writeFileToFolder(
  handle: FileSystemDirectoryHandle,
  fileName: string,
  content: string | ArrayBuffer | Blob
): Promise<void> {
  const fileHandle = await handle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

// ── State file (maia-state.json) ───────────────────────────────────

/**
 * Read and parse maia-state.json from the folder. Returns null if missing.
 */
export async function readStateFile(
  handle: FileSystemDirectoryHandle
): Promise<MaiaState | null> {
  const file = await readFileFromFolder(handle, STATE_FILE_NAME);
  if (!file) return null;
  try {
    const text = await file.text();
    return JSON.parse(text) as MaiaState;
  } catch {
    console.warn('[localFolder] Failed to parse maia-state.json');
    return null;
  }
}

/**
 * Write maia-state.json to the folder (replaces PouchDB snapshot).
 */
export async function writeStateFile(
  handle: FileSystemDirectoryHandle,
  state: MaiaState
): Promise<void> {
  state.updatedAt = new Date().toISOString();
  const json = JSON.stringify(state, null, 2);
  await writeFileToFolder(handle, STATE_FILE_NAME, json);
}

/**
 * Write a maia.webloc file (macOS web shortcut) to the folder.
 */
export async function writeWeblocFile(
  handle: FileSystemDirectoryHandle,
  url: string
): Promise<void> {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>URL</key>
  <string>${url}</string>
</dict>
</plist>`;
  await writeFileToFolder(handle, 'maia.webloc', plist);
}
