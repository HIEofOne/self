/**
 * File N citations become page links (src/utils/fileNCitations.ts),
 * including a citation whose page the AI didn't know: `[File N]` or
 * `[File N p.??]` opens the file at its first page.
 */
import { describe, it, expect } from 'vitest';
import { processFileNCitations } from '../src/utils/fileNCitations';

const FILES = [
  { fileName: 'Health Records - Pat.pdf', bucketKey: 'u1/Health Records - Pat.pdf' },
  { fileName: 'MRI.pdf', bucketKey: 'u1/MRI.pdf' }
];

describe('File N citations', () => {
  it('links a cited page', () => {
    const out = processFileNCitations('Seen 2026-05-07 [File 2 p.14].', FILES);
    expect(out).toContain('data-page="14"');
    expect(out).toContain('data-filename="MRI.pdf"');
    expect(out).toContain('>File 2 p.14</a>');
  });

  it('links a citation without a page, or with "p.??", to the file itself', () => {
    for (const text of ['Dr. Lien [File 1 p.??]', 'Dr. Lien [File 1]', 'Dr. Lien [ File 1 p. ? ]']) {
      const out = processFileNCitations(text, FILES);
      expect(out).toContain('data-page="1"');
      expect(out).toContain('>File 1</a>');
      expect(out).toContain('**File 1**: Health Records - Pat.pdf');
    }
  });

  it('leaves a file number it can\'t resolve as text', () => {
    expect(processFileNCitations('See [File 9].', FILES)).toBe('See [File 9].');
  });

  it('turns a raw filename citation into File N', () => {
    expect(processFileNCitations('[MRI.pdf p.3]', FILES)).toContain('>File 2 p.3</a>');
  });
});
