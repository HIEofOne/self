/**
 * P9, the browser's side of documents (group_requests.md §10.12, I-32): an
 * upload signed over the document's own bytes verifies on the server; a
 * document the server seals to the folder key opens in the browser with
 * it, and only with it; the Received/ file name is safe whatever the sender
 * wrote; the folder log shows the document, escaped.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { signRequest, jwkThumbprint } from '../src/gnap/httpsig';
import { verifyGnapRequest } from '../server/gnap/httpsig.js';
import { openSealedBytes, FOLDER_DOCUMENT_INFO } from '../src/gnap/sealedBox';
import { sealDocument } from '../server/gnap/documents.js';
import { receivedFileName, safeNamePart } from '../src/utils/received';
import { renderLogHtml, type RequestEvent } from '../src/utils/requestLog';

const PDF = new Uint8Array(Buffer.from('%PDF-1.4\nReport body\n%%EOF\n'));

describe('the upload signature', () => {
  it('covers the document bytes: verifies as sent, fails if one byte changes', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']) as CryptoKeyPair;
    const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const base = { kty: 'OKP' as const, crv: 'Ed25519' as const, x: String(pub.x) };
    const jwk = { ...base, kid: await jwkThumbprint(base) };
    const url = 'https://test.agropper.xyz/gnap/rs/abc';
    const headers = { 'content-type': 'application/pdf', authorization: 'GNAP tok123' };
    const sig = await signRequest({ method: 'PUT', url, headers, body: PDF, privateKey: pair.privateKey, kid: jwk.kid });
    const msg = (bytes: Uint8Array) => ({
      method: 'PUT', targetUri: url,
      headers: Object.fromEntries(Object.entries({ ...headers, ...sig }).map(([k, v]) => [k.toLowerCase(), v])),
      rawBody: Buffer.from(bytes)
    });
    expect(verifyGnapRequest(msg(PDF), jwk)).toMatchObject({ ok: true });
    const changed = PDF.slice(); changed[12] ^= 1;
    expect(verifyGnapRequest(msg(changed), jwk).ok).toBe(false);
  });
});

describe('the folder key opens what the server sealed', () => {
  it('opens with the folder key, and not with another', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair;
    const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const box = sealDocument({ kty: 'OKP', crv: 'X25519', x: pub.x }, Buffer.from(PDF));
    const opened = await openSealedBytes(pair.privateKey, box, FOLDER_DOCUMENT_INFO);
    expect(Buffer.from(opened).equals(Buffer.from(PDF))).toBe(true);
    expect(createHash('sha256').update(opened).digest('hex')).toBe(createHash('sha256').update(PDF).digest('hex'));
    const other = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']) as CryptoKeyPair;
    await expect(openSealedBytes(other.privateKey, box, FOLDER_DOCUMENT_INFO)).rejects.toBeTruthy();
    // A relay answer's label doesn't open a folder document either.
    await expect(openSealedBytes(pair.privateKey, box)).rejects.toBeTruthy();
  });
});

describe('Received/ file names', () => {
  const d = { kind: 'radiology-report', mediaType: 'application/pdf', receivedAt: '2026-09-24T10:00:00.000Z', sender: { name: 'Dr Jane Smith', email: null, emailVerified: true } };

  it('date, kind and sender; a counter when the name is taken', () => {
    expect(receivedFileName(d, new Set())).toBe('2026-09-24 Radiology report - Dr Jane Smith.pdf');
    const taken = new Set(['2026-09-24 radiology report - dr jane smith.pdf']);
    expect(receivedFileName(d, taken)).toBe('2026-09-24 Radiology report - Dr Jane Smith (2).pdf');
  });

  it('what a sender wrote can’t leave the folder or break the name', () => {
    const name = receivedFileName({ ...d, sender: { name: '../../etc/passwd\\x:*?"<>|\u0000', email: null, emailVerified: true } }, new Set());
    expect(name).not.toMatch(/[/\\:*?"<>|\u0000]/);
    expect(name.startsWith('2026-09-24 Radiology report - ')).toBe(true);
    expect(safeNamePart('...hidden')).toBe('hidden');
    expect(safeNamePart('x'.repeat(200)).length).toBe(60);
    expect(receivedFileName({ ...d, sender: { name: '', email: null, emailVerified: false } }, new Set())).toContain('unknown sender');
  });
});

describe('the folder log shows documents', () => {
  it('kind and title, escaped, with where it was saved', () => {
    const base = { requestId: 'r1', route: 'gnap-direct', groupName: 'Direct request', requester: { name: 'Dr Ray', email: 'ray@x', emailVerified: true },
      what: 'document', why: 'clinical', document: { kind: 'radiology-report', title: '<b>MRI</b>', mediaType: 'application/pdf', size: 10, sha256: 'a'.repeat(64) } };
    const html = renderLogHtml([
      { ...base, id: 'r1:received', at: '2026-09-24T10:00:00.000Z', type: 'received' },
      { ...base, id: 'r1:accepted', at: '2026-09-24T10:01:00.000Z', type: 'accepted', by: 'rule' },
      { ...base, id: 'r1:document_received', at: '2026-09-25T09:00:00.000Z', type: 'document_received', fileName: '2026-09-24 Radiology report - Dr Ray.pdf' }
    ] as RequestEvent[]);
    expect(html).toContain('Radiology report “&lt;b&gt;MRI&lt;/b&gt;”');
    expect(html).toContain('Accepted by your rule');
    expect(html).toContain('Saved in your folder: Received/2026-09-24 Radiology report - Dr Ray.pdf');
  });
});
