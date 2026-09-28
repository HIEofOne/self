/**
 * Setup's folder step (Personal AS): the record PDFs in the MAIA folder go
 * to MAIA at once, so Saved Files shows them all. The folder's Apple Health
 * export is registered as such (the Patient Summary's Apple Health route
 * looks for it), and only one: never when MAIA already has one. MAIA's own
 * files and records MAIA already has are left alone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const folder = vi.hoisted(() => ({ files: [] as Array<{ name: string; text: string }> }));
vi.mock('../src/utils/localFolder', () => ({
  reconnectLocalFolder: async () => ({ handle: {} }),
  reconnectLocalFolderWithGesture: async () => null,
  getLocalFolderStatus: async () => ({ configured: true }),
  isMaiaGeneratedFile: (name: string) => name.startsWith('MAIA '),
  listFolderFiles: async () => folder.files.map((f) => ({ name: f.name, fileHandle: { getFile: async () => new File([f.text], f.name) } }))
}));

import { uploadFolderRecords } from '../src/utils/recordsSearch';

const detect = async (f: Blob) => (await f.text()).includes('APPLE HEALTH');

describe('the folder step uploads the folder records', () => {
  const realFetch = globalThis.fetch;
  let registered: any[] = [];
  let inMaia: Array<{ fileName: string; isAppleHealth?: boolean }> = [];
  beforeEach(() => {
    registered = [];
    globalThis.fetch = (async (url: string, opts: any = {}) => {
      if (String(url).startsWith('/api/records/files')) return new Response(JSON.stringify({ success: true, files: inMaia }));
      if (url === '/api/files/upload') {
        const name = (opts.body as FormData).get('file') as File;
        return new Response(JSON.stringify({ fileInfo: { fileName: name.name, bucketKey: `ann01/${name.name}`, userFolder: 'ann01/', size: name.size, uploadedAt: 'now' } }));
      }
      if (url === '/api/user-file-metadata') { registered.push(JSON.parse(opts.body)); return new Response('{}'); }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('uploads every record, marks the first Apple Health export, and skips MAIA files', async () => {
    inMaia = [];
    folder.files = [
      { name: 'Clinic visit.pdf', text: 'notes' },
      { name: 'Health Records - Pat.pdf', text: 'APPLE HEALTH export' },
      { name: 'Older export.pdf', text: 'APPLE HEALTH export' },
      { name: 'MAIA Patient Summary.pdf', text: 'ours' }
    ];
    const r = await uploadFolderRecords('ann01', () => {}, { markAppleHealth: true, detect });
    expect(r).toMatchObject({ found: 3, uploaded: 3, alreadyInMaia: 0, failed: 0, appleHealth: 'Health Records - Pat.pdf' });
    expect(registered.map((b) => [b.fileMetadata.fileName, b.fileMetadata.isAppleHealth, b.updateInitialFile])).toEqual([
      ['Clinic visit.pdf', false, false],
      ['Health Records - Pat.pdf', true, true],
      ['Older export.pdf', false, false]
    ]);
  });

  it('never marks a second export when MAIA has one, and leaves records MAIA already has', async () => {
    inMaia = [{ fileName: 'Health Records - Pat.pdf', isAppleHealth: true }];
    folder.files = [{ name: 'Health Records - Pat.pdf', text: 'APPLE HEALTH' }, { name: 'New export.pdf', text: 'APPLE HEALTH' }];
    const r = await uploadFolderRecords('ann01', () => {}, { markAppleHealth: true, detect });
    expect(r).toMatchObject({ found: 2, uploaded: 1, alreadyInMaia: 1 });
    expect(registered.map((b) => b.fileMetadata.isAppleHealth)).toEqual([false]);
  });

  it('without markAppleHealth (indexing from More features), nothing is marked', async () => {
    inMaia = [];
    folder.files = [{ name: 'Health Records - Pat.pdf', text: 'APPLE HEALTH' }];
    await uploadFolderRecords('ann01', () => {}, { detect });
    expect(registered[0].fileMetadata.isAppleHealth).toBe(false);
  });
});
