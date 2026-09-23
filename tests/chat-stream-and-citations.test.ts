import { describe, it, expect } from 'vitest';
import { createSseParser } from '../src/utils/sseStream';
import { citationFileMatches, citationFileKey } from '../src/utils/citationFileMatch';

/**
 * Regression for garbled long chat answers (v1.6.1, victoria71 / Qwen):
 * the chat reader parsed every network read on its own, so any event split
 * across two reads was dropped. The parser must reassemble events no matter
 * where the stream is cut.
 */
const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

describe('createSseParser', () => {
  const answer = 'Adrian Gropper, 74-year-old male — [Health Records - Adrian Gropper - 2026-07-03 at 12.43.26.pdf p.1] ✓';
  const deltas = answer.match(/.{1,3}/gsu) as string[];
  const stream = deltas.map((d) => sse({ delta: d, isComplete: false })).join('') + sse({ delta: '', content: answer, isComplete: true });

  it('reassembles every delta for every possible cut position (one split per stream)', () => {
    for (let cut = 1; cut < stream.length; cut++) {
      const p = createSseParser();
      const events = [...p.push(stream.slice(0, cut)), ...p.push(stream.slice(cut)), ...p.flush()] as any[];
      const text = events.map((e) => e.delta || '').join('');
      expect(text, `cut at ${cut}`).toBe(answer);
      expect(events[events.length - 1].isComplete).toBe(true);
    }
  });

  it('survives many tiny reads, as a slow network delivers them', () => {
    const p = createSseParser();
    const events: any[] = [];
    for (let i = 0; i < stream.length; i += 7) events.push(...p.push(stream.slice(i, i + 7)));
    events.push(...p.flush());
    expect(events.map((e) => e.delta || '').join('')).toBe(answer);
  });

  it('parses a final event that arrives without its trailing blank line', () => {
    const p = createSseParser();
    const events = [...p.push(`data: ${JSON.stringify({ isComplete: true, content: 'x' })}`), ...p.flush()] as any[];
    expect(events).toEqual([{ isComplete: true, content: 'x' }]);
  });

  it('skips malformed events without losing the ones around them', () => {
    const p = createSseParser();
    const events = p.push(sse({ delta: 'a' }) + 'data: {not json}\n\n' + sse({ delta: 'b' })) as any[];
    expect(events.map((e) => e.delta)).toEqual(['a', 'b']);
  });
});

describe('citationFileMatches', () => {
  const stored = 'Health Records - Adrian Gropper - 2026-07-03 at 12.43.26.pdf';

  it('matches the underscore form models write for a stored name with spaces', () => {
    expect(citationFileMatches(stored, 'Health_Records_-_Adrian_Gropper_-_2026-07-03_at_12.43.26.pdf')).toBe(true);
    expect(citationFileKey(stored)).toBe(citationFileKey('HEALTH_RECORDS_-_ADRIAN_GROPPER_-_2026-07-03_AT_12.43.26'));
  });

  it('keeps the old exact and partial behaviour', () => {
    expect(citationFileMatches(stored, stored)).toBe(true);
    expect(citationFileMatches(stored, 'Health Records - Adrian Gropper')).toBe(true);
  });

  it('does not match unrelated files or trivially short fragments', () => {
    expect(citationFileMatches(stored, 'Radiology Report 2019.pdf')).toBe(false);
    expect(citationFileMatches(stored, 'He')).toBe(false);
    expect(citationFileMatches(stored, '')).toBe(false);
  });
});
