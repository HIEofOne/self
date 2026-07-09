import { describe, it, expect } from 'vitest';
import { inspectFolderForForeignAccount } from '../src/utils/localFolder';

/**
 * Mock a FileSystemDirectoryHandle with the two methods the guard uses:
 * async `values()` (entry iteration) and `getFileHandle()` (to read
 * maia-state.json via readFileFromFolder).
 */
function mockHandle(files: Record<string, string>, dirs: string[] = []) {
  const entries = [
    ...Object.keys(files).map((name) => ({ kind: 'file' as const, name })),
    ...dirs.map((name) => ({ kind: 'directory' as const, name }))
  ];
  return {
    name: 'picked-folder',
    async *values() {
      for (const e of entries) yield e;
    },
    async getFileHandle(name: string) {
      if (!(name in files)) {
        const err: any = new Error('NotFound');
        err.name = 'NotFoundError';
        throw err;
      }
      return { async getFile() { return { async text() { return files[name]; } }; } };
    }
  } as unknown as FileSystemDirectoryHandle;
}

const stateFor = (userId: string) => JSON.stringify({ schemaVersion: 2, userDoc: { userId } });

describe('inspectFolderForForeignAccount', () => {
  it('BLOCKS a folder that holds a different account\'s maia-state.json', async () => {
    const h = mockHandle({ 'maia-state.json': stateFor('alexis87') });
    const c = await inspectFolderForForeignAccount(h, 'caleb59');
    expect(c?.severity).toBe('block');
    expect(c?.kind).toBe('other-account');
    expect(c?.otherUserId).toBe('alexis87');
  });

  it('allows the user\'s OWN folder (same userId state file)', async () => {
    const h = mockHandle({ 'maia-state.json': stateFor('caleb59') });
    expect(await inspectFolderForForeignAccount(h, 'caleb59')).toBeNull();
  });

  it('WARNS on a MAIA subfolder (artifacts, no state file) — the "chats" case', async () => {
    const h = mockHandle({
      'MAIA chat 2026-07-04 12-48.pdf': 'x',
      'maia-for-Adrian-as-alexis87.webloc': 'x'
    });
    const c = await inspectFolderForForeignAccount(h, 'caleb59');
    expect(c?.severity).toBe('warn');
    expect(c?.kind).toBe('maia-workspace');
  });

  it('WARNS when maia-log.pdf is present without a state file', async () => {
    const h = mockHandle({ 'maia-log.pdf': 'x' });
    expect((await inspectFolderForForeignAccount(h, 'caleb59'))?.severity).toBe('warn');
  });

  it('allows a fresh, empty folder', async () => {
    expect(await inspectFolderForForeignAccount(mockHandle({}), 'caleb59')).toBeNull();
  });

  it('allows a folder with only unrelated files', async () => {
    const h = mockHandle({ 'notes.txt': 'x', 'photo.jpg': 'x' });
    expect(await inspectFolderForForeignAccount(h, 'caleb59')).toBeNull();
  });
});
