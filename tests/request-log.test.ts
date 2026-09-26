/**
 * P8: the request log in the patient's folder (Requests/requests.jsonl and
 * Request Log.html). Two tabs, or a re-run, must never duplicate an event;
 * a torn line must not break the log; the HTML shows one row per request
 * and escapes everything a requester wrote.
 */
import { describe, it, expect } from 'vitest';
import { parseJsonl, mergeEvents, toJsonl, renderLogHtml, type RequestEvent } from '../src/utils/requestLog';

const ev = (id: string, at: string, over: Partial<RequestEvent> = {}): RequestEvent => ({
  id, at, type: 'received', requestId: id.split(':')[0], route: 'gnap-direct', groupName: 'Direct request',
  requester: { name: 'Dr. Test', email: 'dr@example.com', emailVerified: true }, what: 'patient-summary', why: 'clinical', ...over
});

describe('the jsonl log', () => {
  it('skips torn or foreign lines', () => {
    const text = `${JSON.stringify(ev('r1:received', '2026-09-20T10:00:00.000Z'))}\n{"id":"x"\nnot json\n\n`;
    expect(parseJsonl(text).map((e) => e.id)).toEqual(['r1:received']);
  });

  it('merges by id, in time order: re-runs and a second tab add nothing', () => {
    const a = [ev('r1:received', '2026-09-20T10:00:00.000Z'), ev('r2:received', '2026-09-22T10:00:00.000Z')];
    const b = [ev('r2:received', '2026-09-22T10:00:00.000Z'), ev('r1:shared', '2026-09-21T10:00:00.000Z', { type: 'shared', by: 'rule' })];
    const merged = mergeEvents(a, b, b);
    expect(merged.map((e) => e.id)).toEqual(['r1:received', 'r1:shared', 'r2:received']);
    expect(parseJsonl(toJsonl(merged))).toEqual(merged);
  });
});

describe('Request Log.html', () => {
  it('one row per request with its outcomes; what requesters wrote is escaped', () => {
    const html = renderLogHtml([
      ev('r1:received', '2026-09-20T10:00:00.000Z', { message: '<script>alert(1)</script>' }),
      ev('r1:shared', '2026-09-21T10:00:00.000Z', { type: 'shared', by: 'rule' }),
      ev('m1:received', '2026-09-22T10:00:00.000Z', { requestId: 'm1', route: 'gnap-group', groupName: 'Trustee', requester: { name: 'cy55', member: true } })
    ], '2026-09-26T12:00:00.000Z');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Shared by your rule');
    expect(html).toContain('cy55 (a member of Trustee)');
    expect(html.match(/<tr>/g)?.length).toBe(3); // header + 2 requests
  });
});
