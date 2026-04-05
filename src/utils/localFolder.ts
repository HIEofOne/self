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

export interface MaiaIdentity {
  userId: string;
  displayName: string;
  createdAt: string;
  lastSync: string;
}

export interface MaiaState {
  version: number;
  userId: string;
  displayName?: string;
  updatedAt: string;
  exportedAt?: string;
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
  agentInstructions?: string | null;
  listsMarkdown?: string | null;
  kbStats?: { fileCount: number; tokenCount: number } | null;
  wizardComplete?: boolean;
  settings?: Record<string, any>;
}

const STATE_FILE_NAME = 'maia-state.json';
const IDENTITY_FILE_NAME = 'maia-identity.json';

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

export async function storeDirectoryHandle(
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

/**
 * Check if a stored folder handle exists for this userId (no permission needed).
 */
export async function hasStoredHandle(userId: string): Promise<boolean> {
  if (!isFileSystemAccessSupported()) return false;
  try {
    const handle = await getStoredHandle(userId);
    return handle != null;
  } catch {
    return false;
  }
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
    await storeDirectoryHandle(userId, handle);
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
 * Try to read maia-state.json from the stored folder handle for a userId.
 * Uses queryPermission only (no user gesture needed).
 * Returns { state, handle } if successful, or null if no handle / no permission / no file.
 */
export async function readStateFileByUserId(
  userId: string,
  options?: { requestWrite?: boolean }
): Promise<{ state: MaiaState; handle: FileSystemDirectoryHandle } | null> {
  if (!isFileSystemAccessSupported()) return null;
  try {
    const handle = await getStoredHandle(userId);
    if (!handle) return null;
    // Try readwrite first so the returned handle can be used for writes (sign-out snapshot).
    let perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      // If caller passed requestWrite (has a user gesture), prompt Chrome for permission
      if (options?.requestWrite && perm === 'prompt') {
        perm = await handle.requestPermission({ mode: 'readwrite' });
      }
      if (perm !== 'granted') {
        // Fall back to read-only
        perm = await handle.queryPermission({ mode: 'read' });
        if (perm !== 'granted' && options?.requestWrite) {
          perm = await handle.requestPermission({ mode: 'read' });
        }
        if (perm !== 'granted') return null;
      }
    }
    const state = await readStateFile(handle);
    if (!state) return null;
    return { state, handle };
  } catch {
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
 * Extract patient name from a patient summary text.
 * Tries several formats: "Patient Summary for X", "Summary for X",
 * "Name: X", markdown "**Name:** X", or first capitalized multi-word line.
 * Returns null if no name can be extracted.
 */
export function extractPatientName(summaryText: string | null | undefined): string | null {
  if (!summaryText?.trim()) return null;
  const lines = summaryText.split('\n').map(l => l.trim()).filter(Boolean);

  // Pattern 1: "Patient Summary for X" or "Summary for X" or "Name: X"
  for (const line of lines.slice(0, 5)) {
    const m = line.match(/(?:Patient Summary for|Summary for|Patient:\s*|Name:\s*)\s*(.+)/i);
    if (m?.[1]?.trim()) {
      return m[1].trim().replace(/\*+/g, '').replace(/^#+\s*/, '');
    }
  }
  // Pattern 2: Markdown "**Name:** X" or "**Patient:** X"
  for (const line of lines.slice(0, 10)) {
    const m = line.match(/\*?\*?(?:Name|Patient)\*?\*?:\s*\*?\*?\s*(.+)/i);
    if (m?.[1]?.trim()) {
      return m[1].trim().replace(/\*+/g, '');
    }
  }
  // Pattern 3: "**Name, Age Gender**" or "# Name, Age Gender" (common AI summary format)
  for (const line of lines.slice(0, 3)) {
    const cleaned = line.replace(/^#+\s*/, '').replace(/\*+/g, '').trim();
    // Match "Adrian Gropper, 73 M" — extract just the name before comma/paren/age
    const nameAge = cleaned.match(/^([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+)\s*[,(]\s*\d/);
    if (nameAge?.[1]) {
      return nameAge[1].trim();
    }
  }
  // Pattern 4: First line that looks like a person's name (2-4 capitalized words, no punctuation)
  for (const line of lines.slice(0, 5)) {
    const cleaned = line.replace(/^#+\s*/, '').replace(/\*+/g, '').trim();
    if (/^[A-Z][a-z]+(\s+[A-Z][a-z]+){0,3}$/.test(cleaned) && cleaned.length < 40) {
      return cleaned;
    }
  }
  return null;
}

/**
 * Write a maia.webloc file (macOS web shortcut) to the folder.
 * Filename: maia-for-<patient>-as-<userId>.webloc (with name)
 *           maia-for-<userId>.webloc (without name)
 *           maia.webloc (no userId at all)
 */
export async function writeWeblocFile(
  handle: FileSystemDirectoryHandle,
  url: string,
  opts?: { patientName?: string; userId?: string }
): Promise<void> {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>URL</key>
  <string>${url}</string>
</dict>
</plist>`;
  // Build filename
  let filename = 'maia.webloc';
  if (opts?.userId) {
    if (opts?.patientName) {
      const safeName = opts.patientName.replace(/[^a-zA-Z0-9 _-]/g, '').trim().replace(/\s+/g, '-');
      filename = safeName
        ? `maia-for-${safeName}-as-${opts.userId}.webloc`
        : `maia-for-${opts.userId}.webloc`;
    } else {
      filename = `maia-for-${opts.userId}.webloc`;
    }
  }
  // Write the new file FIRST (most important step)
  await writeFileToFolder(handle, filename, plist);
  // Then clean up old webloc files
  if (filename !== 'maia.webloc') {
    try { await handle.removeEntry('maia.webloc'); } catch { /* doesn't exist */ }
  }
  try {
    for await (const [name] of (handle as any).entries()) {
      if (name.endsWith('.webloc') && name.startsWith('maia-for-') && name !== filename) {
        try { await handle.removeEntry(name); } catch { /* skip */ }
      }
    }
  } catch { /* iteration not supported or failed */ }
}

// ── Identity file (maia-identity.json) ────────────────────────────

/**
 * Read maia-identity.json from the folder. Returns null if missing.
 */
export async function readIdentityFile(
  handle: FileSystemDirectoryHandle
): Promise<MaiaIdentity | null> {
  const file = await readFileFromFolder(handle, IDENTITY_FILE_NAME);
  if (!file) return null;
  try {
    const text = await file.text();
    return JSON.parse(text) as MaiaIdentity;
  } catch {
    console.warn('[localFolder] Failed to parse maia-identity.json');
    return null;
  }
}

/**
 * Write maia-identity.json to the folder.
 */
export async function writeIdentityFile(
  handle: FileSystemDirectoryHandle,
  identity: MaiaIdentity
): Promise<void> {
  const json = JSON.stringify(identity, null, 2);
  await writeFileToFolder(handle, IDENTITY_FILE_NAME, json);
}

// ── Multi-user registry (localStorage) ────────────────────────────
// Tracks all known family members who have used MAIA on this browser.

export interface KnownUser {
  userId: string;
  displayName: string;
  folderName: string | null;
  hasPasskey: boolean;
  lastActive: string;
}

const KNOWN_USERS_KEY = 'maia_known_users';
const ACTIVE_USER_KEY = 'maia_active_user';

export function getKnownUsers(): KnownUser[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(KNOWN_USERS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function addOrUpdateKnownUser(entry: KnownUser): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  const users = getKnownUsers();
  const idx = users.findIndex(u => u.userId === entry.userId);
  if (idx >= 0) {
    users[idx] = { ...users[idx], ...entry };
  } else {
    users.push(entry);
  }
  window.localStorage.setItem(KNOWN_USERS_KEY, JSON.stringify(users));
}

export function removeKnownUser(userId: string): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  const users = getKnownUsers().filter(u => u.userId !== userId);
  window.localStorage.setItem(KNOWN_USERS_KEY, JSON.stringify(users));
}

export function getActiveUserId(): string | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  return window.localStorage.getItem(ACTIVE_USER_KEY);
}

export function setActiveUserId(userId: string | null): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  if (userId) {
    window.localStorage.setItem(ACTIVE_USER_KEY, userId);
  } else {
    window.localStorage.removeItem(ACTIVE_USER_KEY);
  }
}

/**
 * Migrate from the old single-user maia_last_snapshot_user key
 * to the new multi-user registry. Call once on app startup.
 */
export function migrateToKnownUsers(): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  const existing = getKnownUsers();
  if (existing.length > 0) return; // already migrated
  const oldUserId = window.localStorage.getItem('maia_last_snapshot_user');
  if (!oldUserId) return;
  addOrUpdateKnownUser({
    userId: oldUserId,
    displayName: oldUserId,
    folderName: null,
    hasPasskey: false,
    lastActive: new Date().toISOString()
  });
  setActiveUserId(oldUserId);
  // Clean up the old key — knownUsers is now canonical
  window.localStorage.removeItem('maia_last_snapshot_user');
}

/**
 * Recover userIds from IndexedDB folder handles (survives localStorage clear).
 * For each stored handle, tries queryPermission (no user gesture needed).
 * If permission is granted, reads maia-identity.json to get userId/displayName.
 * Returns recoverable users not already in knownUsers.
 */
export async function getAllStoredUserIds(): Promise<Array<{ userId: string; displayName: string; folderName: string }>> {
  if (typeof window === 'undefined' || !window.indexedDB) return [];
  const results: Array<{ userId: string; displayName: string; folderName: string }> = [];
  try {
    const db = await openHandleDb();
    const tx = db.transaction(HANDLE_STORE_NAME, 'readonly');
    const store = tx.objectStore(HANDLE_STORE_NAME);
    // Get all keys (userIds) from the handle store
    const allKeys: string[] = await new Promise((resolve, reject) => {
      const req = store.getAllKeys();
      req.onsuccess = () => resolve(req.result as string[]);
      req.onerror = () => reject(req.error);
    });
    db.close();

    for (const userId of allKeys) {
      try {
        const handle = await getStoredHandle(userId);
        if (!handle) continue;
        const perm = await handle.queryPermission({ mode: 'read' });
        if (perm !== 'granted') continue;
        // Try to read identity file
        const identity = await readIdentityFile(handle);
        results.push({
          userId: identity?.userId || userId,
          displayName: identity?.displayName || userId,
          folderName: handle.name
        });
      } catch {
        // Skip handles we can't access
      }
    }
  } catch {
    // IndexedDB not available
  }
  return results;
}

/**
 * Reconcile knownUsers with all available sources:
 * - Existing knownUsers (localStorage)
 * - Folder handles in IndexedDB (survives localStorage clear)
 * Call on app startup after migrateToKnownUsers().
 */
export async function reconcileKnownUsers(): Promise<void> {
  const existing = getKnownUsers();
  const existingIds = new Set(existing.map(u => u.userId));

  // Recover from IndexedDB folder handles
  const folderUsers = await getAllStoredUserIds();
  for (const fu of folderUsers) {
    if (!existingIds.has(fu.userId)) {
      addOrUpdateKnownUser({
        userId: fu.userId,
        displayName: fu.displayName,
        folderName: fu.folderName,
        hasPasskey: false, // unknown — will be checked by checkAllUserCloudStatus
        lastActive: new Date().toISOString()
      });
      existingIds.add(fu.userId);
    } else {
      // Update folderName if we didn't have it
      const ku = existing.find(u => u.userId === fu.userId);
      if (ku && !ku.folderName && fu.folderName) {
        addOrUpdateKnownUser({ ...ku, folderName: fu.folderName });
      }
    }
  }

  // Ensure active user is set if we have known users
  if (!getActiveUserId() && getKnownUsers().length > 0) {
    setActiveUserId(getKnownUsers()[0].userId);
  }
}
