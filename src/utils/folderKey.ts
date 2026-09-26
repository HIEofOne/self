/**
 * The folder key (group_requests.md §7, §10.12, I-32): an X25519 key pair
 * made in the browser when the MAIA folder is connected. Documents others
 * add wait on the server sealed to its public half; the private half is in
 * the folder (maia-folder-key.json) and in this browser, never on the
 * server, in maia-state.json or in the account. Connecting the folder in a
 * new browser restores it. If the folder is lost, documents still waiting
 * can't be opened, and the sender sends them again.
 */
import { reconnectLocalFolder, getLocalFolderStatus, readFileFromFolder, writeFileToFolder } from './localFolder';

export const FOLDER_KEY_FILE = 'maia-folder-key.json';

interface PrivateJwk { kty: 'OKP'; crv: 'X25519'; x: string; d: string }
export type FolderKeyResult = 'ok' | 'created' | 'restored' | 'no-folder' | 'no-permission' | 'unsupported' | 'failed';

// ── This browser's copy (IndexedDB) ─────────────────────────────────────

const DB_NAME = 'maia-folder-keys';
const STORE = 'keys';
const openDb = () => new Promise<IDBDatabase>((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => req.result.createObjectStore(STORE);
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const idbGet = async (userId: string): Promise<PrivateJwk | null> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE).objectStore(STORE).get(userId);
    r.onsuccess = () => { db.close(); resolve((r.result as PrivateJwk) || null); };
    r.onerror = () => { db.close(); reject(r.error); };
  });
};
const idbSet = async (userId: string, jwk: PrivateJwk) => {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(jwk, userId);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
};

const isPrivateJwk = (j: unknown): j is PrivateJwk => {
  const k = j as PrivateJwk;
  return !!k && k.kty === 'OKP' && k.crv === 'X25519' && typeof k.x === 'string' && typeof k.d === 'string';
};

const fileText = (jwk: PrivateJwk) => `${JSON.stringify({
  about: 'MAIA folder key. It opens documents others sent you while they wait on the server. Keep it in this folder; don’t share it.',
  created: new Date().toISOString(),
  key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d }
}, null, 2)}\n`;

const readKeyFile = async (dir: FileSystemDirectoryHandle): Promise<PrivateJwk | null> => {
  const f = await readFileFromFolder(dir, FOLDER_KEY_FILE);
  if (!f) return null;
  try {
    const k = JSON.parse(await f.text())?.key;
    return isPrivateJwk(k) ? k : null;
  } catch { return null; }
};

const serverKeyX = async (userId: string): Promise<string | null> => {
  const r = await fetch(`/api/folder-key?userId=${encodeURIComponent(userId)}`, { credentials: 'include', cache: 'no-store' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.success) throw new Error('folder key lookup failed');
  return d.publicJwk?.x || null;
};
const publish = async (userId: string, x: string) => {
  const r = await fetch('/api/folder-key', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, publicJwk: { kty: 'OKP', crv: 'X25519', x } })
  });
  if (!r.ok) throw new Error('folder key publish failed');
};

const running = new Map<string, Promise<FolderKeyResult>>();

/**
 * Make sure the folder, this browser and the server agree on one folder
 * key: the folder's copy wins; this browser's copy restores a folder that
 * lost the file; otherwise a new pair is made. The server gets the public
 * half whenever it differs.
 */
export function ensureFolderKey(userId: string): Promise<FolderKeyResult> {
  let p = running.get(userId);
  if (!p) {
    p = ensure(userId).finally(() => { running.delete(userId); });
    running.set(userId, p);
  }
  return p;
}

async function ensure(userId: string): Promise<FolderKeyResult> {
  if (!userId) return 'failed';
  const folder = await reconnectLocalFolder(userId);
  if (!folder) return (await getLocalFolderStatus(userId)).configured ? 'no-permission' : 'no-folder';
  try {
    let result: FolderKeyResult = 'ok';
    let jwk = await readKeyFile(folder.handle);
    const local = await idbGet(userId).catch(() => null);
    if (jwk) {
      if (local?.x !== jwk.x) await idbSet(userId, jwk);
    } else if (local) {
      jwk = local;
      await writeFileToFolder(folder.handle, FOLDER_KEY_FILE, fileText(jwk));
      result = 'restored';
    } else {
      let pair: CryptoKeyPair;
      try {
        pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair;
      } catch { return 'unsupported'; }
      const priv = await crypto.subtle.exportKey('jwk', pair.privateKey);
      jwk = { kty: 'OKP', crv: 'X25519', x: String(priv.x), d: String(priv.d) };
      // The folder first: a key the server seals to must never exist only here.
      await writeFileToFolder(folder.handle, FOLDER_KEY_FILE, fileText(jwk));
      await idbSet(userId, jwk);
      result = 'created';
    }
    if ((await serverKeyX(userId)) !== jwk.x) await publish(userId, jwk.x);
    return result;
  } catch (e) {
    console.warn('[folderKey] could not set up the folder key:', e);
    return 'failed';
  }
}

/** The private folder key, for opening a sealed document (null if this
 *  browser and the folder don't have it). */
export async function getFolderPrivateKey(userId: string): Promise<CryptoKey | null> {
  let jwk = await idbGet(userId).catch(() => null);
  if (!jwk) {
    const folder = await reconnectLocalFolder(userId);
    jwk = folder ? await readKeyFile(folder.handle) : null;
  }
  if (!jwk) return null;
  return crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'X25519', x: jwk.x, d: jwk.d }, { name: 'X25519' }, false, ['deriveBits']);
}
