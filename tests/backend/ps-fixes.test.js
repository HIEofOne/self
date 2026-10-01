/**
 * Patient Summary fixes: a flagged lab row keeps its test name when a long
 * name wrapped around the values (Quest's "VITAMIN D,25-OH,TOTAL,IA"); and
 * the account's initial file follows its record when indexing moves it.
 */
import { describe, it, expect } from 'vitest';
import { outOfRangeLines, oorLineWithName } from '../../server/utils/oor-lines.js';
import { outOfRangeLines as clientOutOfRangeLines } from '../../src/utils/oorLines';
import { healInitialFile } from '../../server/utils/initial-file.js';

// How pdfjs renders page 14 of a Quest-only Apple Health export.
const PAGE = [
  'VITAMIN B12   444.0   pg/mL   200 to 1100',
  '## VITAMIN D,25-',
  '29.0 ng/mL   30 to 100   OUT   OF   RANG',
  '## OH,TOTAL,IA',
  '## WHITE BLOOD CELL',
  '5.5 Thousand/uL',
  'GLUCOSE   102.0 mg/dL   65 to 99   OUT   OF   RANG'
];

describe('out-of-range rows keep their test name', () => {
  it('restores a name that wrapped around the values, and leaves named rows alone', () => {
    expect(outOfRangeLines(PAGE).map((l) => l.replace(/\s+/g, ' '))).toEqual([
      'VITAMIN D,25-OH,TOTAL,IA 29.0 ng/mL 30 to 100 OUT OF RANG',
      'GLUCOSE 102.0 mg/dL 65 to 99 OUT OF RANG'
    ]);
  });

  it('never borrows a full result row as a name', () => {
    expect(oorLineWithName(['ALBUMIN   4.8 g/dL   3.6 to 5.1', '7.0 U/L   10 to 50   OUT OF RANGE'], 1)).toBe('7.0 U/L   10 to 50   OUT OF RANGE');
  });

  it('the browser copy agrees', () => {
    expect(clientOutOfRangeLines(PAGE)).toEqual(outOfRangeLines(PAGE));
  });
});

describe('the initial file follows its record', () => {
  it('takes the current key of the same file after indexing moved it', () => {
    const doc = {
      initialFile: { fileName: 'Health Records - EP.pdf', bucketKey: 'ep01/Health Records - EP.pdf' },
      files: [{ fileName: 'Health Records - EP.pdf', bucketKey: 'ep01/ep01-kb/Health_Records_-_EP.pdf', isAppleHealth: true }]
    };
    expect(healInitialFile(doc)).toBe(true);
    expect(doc.initialFile.bucketKey).toBe('ep01/ep01-kb/Health_Records_-_EP.pdf');
    expect(healInitialFile(doc)).toBe(false); // already current
  });

  it('prefers a live copy over an archived one, and leaves an unknown file alone', () => {
    const doc = {
      initialFile: { fileName: 'AH.pdf', bucketKey: 'a/AH.pdf' },
      files: [{ fileName: 'AH.pdf', bucketKey: 'a/archived/AH.pdf' }, { fileName: 'AH.pdf', bucketKey: 'a/kb/AH.pdf', isAppleHealth: true }]
    };
    healInitialFile(doc);
    expect(doc.initialFile.bucketKey).toBe('a/kb/AH.pdf');
    const other = { initialFile: { fileName: 'gone.pdf', bucketKey: 'a/gone.pdf' }, files: [{ fileName: 'x.pdf', bucketKey: 'a/x.pdf' }] };
    expect(healInitialFile(other)).toBe(false);
    expect(other.initialFile.bucketKey).toBe('a/gone.pdf');
  });
});
