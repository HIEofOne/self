/**
 * Tests for the deterministic lab-history parser. Covers the v1.4.7
 * sidecar format (analyte readings preserved) AND the legacy
 * "(N lines)" format (graceful degradation: dates parsed but rows=0).
 */

import { describe, it, expect } from 'vitest';
import {
  resolveAnalyte,
  parseLabResultsMarkdown,
  selectAnalyteHistory,
  buildLabHistory,
  toIsoDate
} from '../../server/utils/lab-history.js';

describe('toIsoDate', () => {
  it('converts AH-style "Aug 11, 2025" to ISO', () => {
    expect(toIsoDate('Aug 11, 2025')).toBe('2025-08-11');
    expect(toIsoDate('Feb 18, 2025')).toBe('2025-02-18');
  });

  it('handles single-digit days zero-padded', () => {
    expect(toIsoDate('Jan 1, 2020')).toBe('2020-01-01');
    expect(toIsoDate('Dec 31, 1999')).toBe('1999-12-31');
  });

  it('returns null on garbage input', () => {
    expect(toIsoDate('')).toBe(null);
    expect(toIsoDate('not a date')).toBe(null);
    expect(toIsoDate('2025-01-15')).toBe(null); // wrong format
    expect(toIsoDate(null)).toBe(null);
  });
});

describe('resolveAnalyte', () => {
  it('canonicalizes known synonyms', () => {
    expect(resolveAnalyte('TSH').canonical).toBe('tsh');
    expect(resolveAnalyte('thyroid stimulating hormone').canonical).toBe('tsh');
    expect(resolveAnalyte('thyrotropin').canonical).toBe('tsh');
    expect(resolveAnalyte('HbA1c').canonical).toBe('a1c');
    expect(resolveAnalyte('hemoglobin a1c').canonical).toBe('a1c');
  });

  it('returns the user term as-is when no synonym matches', () => {
    const r = resolveAnalyte('foobar');
    expect(r.canonical).toBe('foobar');
    expect(r.terms).toEqual(['foobar']);
  });

  it('returns null on empty input', () => {
    expect(resolveAnalyte('')).toBe(null);
    expect(resolveAnalyte(null)).toBe(null);
  });
});

describe('parseLabResultsMarkdown', () => {
  it('parses the v1.4.7 sidecar format (analyte readings preserved)', () => {
    const md = `# Lab Results
**Total Observations:** 2
**Date:** Aug 11, 2025 | **Page:** 64
Aug 11, 2025 TSH 6.13 uIU/mL; Hemoglobin A1c 5.7 %; LDL 102 mg/dL
---
**Date:** Feb 18, 2025 | **Page:** 58
Feb 18, 2025 TSH 5.12 uIU/mL; LDL 88 mg/dL
`;
    const entries = parseLabResultsMarkdown(md);
    expect(entries.length).toBe(2);
    // Reverse-chronological
    expect(entries[0].isoDate).toBe('2025-08-11');
    expect(entries[1].isoDate).toBe('2025-02-18');
    expect(entries[0].page).toBe(64);
    expect(entries[0].body).toContain('TSH 6.13');
    expect(entries[0].body).toContain('Hemoglobin A1c 5.7');
  });

  it('parses the legacy "(N lines)" sidecar (date kept, body essentially empty)', () => {
    const md = `# Lab Results
**Total Observations:** 1
**Date:** Aug 11, 2025 | **Page:** 64
Aug 11, 2025 (4 lines)
---
`;
    const entries = parseLabResultsMarkdown(md);
    expect(entries.length).toBe(1);
    expect(entries[0].isoDate).toBe('2025-08-11');
    // Body is empty (or whitespace) — the "(N lines)" tag is stripped.
    expect(entries[0].body.replace(/[;,\s]/g, '')).toBe('');
  });

  it('separates out the Out of Range marker into its own field', () => {
    const md = `# Lab Results
**Date:** Aug 11, 2025 | **Page:** 64
Aug 11, 2025 TSH 6.13 uIU/mL; HbA1c 5.7 % | **Out of Range:** TSH HIGH; HbA1c HIGH
---`;
    const entries = parseLabResultsMarkdown(md);
    expect(entries.length).toBe(1);
    expect(entries[0].outOfRange).toContain('TSH HIGH');
    // The OOR marker is stripped from `body`.
    expect(entries[0].body).not.toContain('Out of Range');
  });

  it('returns [] on empty / non-AH input', () => {
    expect(parseLabResultsMarkdown('')).toEqual([]);
    expect(parseLabResultsMarkdown(null)).toEqual([]);
    expect(parseLabResultsMarkdown('# Not lab results\n\nSome other text')).toEqual([]);
  });
});

describe('selectAnalyteHistory', () => {
  const entries = parseLabResultsMarkdown(`# Lab Results
**Date:** Aug 11, 2025 | **Page:** 64
Aug 11, 2025 TSH 6.13 uIU/mL (H); Hemoglobin A1c 5.7 %; LDL 102 mg/dL
---
**Date:** Feb 18, 2025 | **Page:** 58
Feb 18, 2025 TSH 5.12 uIU/mL; LDL 88 mg/dL
---
**Date:** Aug 24, 2023 | **Page:** 41
Aug 24, 2023 TSH 6.13 uIU/mL (H); Free T4 1.2 ng/dL
---`);

  it('finds every occurrence of an analyte (the "list all" property)', () => {
    const rows = selectAnalyteHistory(entries, resolveAnalyte('TSH'));
    expect(rows.length).toBe(3);
    // Each row has the parsed value, units, and the H flag if present.
    const aug11 = rows.find(r => r.isoDate === '2025-08-11');
    expect(aug11.value).toBe('6.13');
    expect(aug11.units).toBe('uIU/mL');
    expect(aug11.flag).toBe('H');
    const feb18 = rows.find(r => r.isoDate === '2025-02-18');
    expect(feb18.value).toBe('5.12');
    expect(feb18.flag).toBe(''); // no H/L flag
  });

  it('matches synonyms (HbA1c → a1c)', () => {
    const rows = selectAnalyteHistory(entries, resolveAnalyte('A1c'));
    expect(rows.length).toBe(1);
    expect(rows[0].value).toBe('5.7');
    expect(rows[0].units).toBe('%');
  });

  it('returns [] when the analyte is absent', () => {
    const rows = selectAnalyteHistory(entries, resolveAnalyte('PSA'));
    expect(rows).toEqual([]);
  });
});

describe('buildLabHistory — end-to-end', () => {
  it('returns the full time series for the requested analyte', () => {
    const md = `# Lab Results
**Date:** Aug 11, 2025 | **Page:** 64
Aug 11, 2025 TSH 6.13 uIU/mL (H)
---
**Date:** Feb 18, 2025 | **Page:** 58
Feb 18, 2025 TSH 5.12 uIU/mL
---
**Date:** Aug 24, 2023 | **Page:** 41
Aug 24, 2023 TSH 6.13 uIU/mL (H)
---
**Date:** Mar 8, 2022 | **Page:** 30
Mar 8, 2022 TSH 2.74 uIU/mL
---
**Date:** Oct 30, 2007 | **Page:** 4
Oct 30, 2007 TSH 11.78 uIU/mL (H)
---`;
    const result = buildLabHistory(md, 'TSH');
    expect(result.analyte.canonical).toBe('tsh');
    expect(result.entryCount).toBe(5);
    expect(result.total).toBe(5);
    // Sorted newest first.
    expect(result.rows[0].isoDate).toBe('2025-08-11');
    expect(result.rows[4].isoDate).toBe('2007-10-30');
    // The 2007 reading carries the H flag for an out-of-range result.
    expect(result.rows[4].flag).toBe('H');
  });

  it('demonstrates the "RAG cannot do this" property: every entry returned, no top-k cap', () => {
    // Build a synthetic sidecar with 50 entries — more than any
    // RAG retriever's k. The deterministic parser returns all 50.
    const blocks = [];
    for (let i = 0; i < 50; i++) {
      const year = 1980 + Math.floor(i / 2);
      const month = i % 2 === 0 ? 'Jan' : 'Jul';
      const value = (5 + Math.random() * 3).toFixed(2);
      blocks.push(`**Date:** ${month} 15, ${year} | **Page:** ${i + 1}\n${month} 15, ${year} TSH ${value} uIU/mL`);
    }
    const md = '# Lab Results\n' + blocks.join('\n---\n') + '\n';
    const result = buildLabHistory(md, 'TSH');
    expect(result.total).toBe(50);
  });

  it('handles unknown analyte gracefully (no synonym match, literal substring tried)', () => {
    const md = `**Date:** Aug 11, 2025 | **Page:** 64
Aug 11, 2025 Apolipoprotein B 95 mg/dL
---`;
    const result = buildLabHistory(md, 'Apolipoprotein B');
    expect(result.total).toBe(1);
    expect(result.rows[0].value).toBe('95');
  });
});
