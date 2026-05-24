/**
 * Multi-patient detection.
 *
 * The real-world scenario this guards against: a user uploads their
 * own records AND a spouse/dependent's records to the same MAIA
 * account. The KB then contains two patients' data and the Patient
 * Summary mixes them — clinically unsafe. We block on DOB mismatch
 * (the strong signal); name mismatch alone is too noisy (PDF
 * extraction artifacts, maiden/married names, Jr./Sr.) to trigger.
 */

import { describe, it, expect } from 'vitest';
import { detectPatientMismatch } from '../../server/utils/patient-consistency.js';
import {
  splitCamelCase,
  parsePatientIdentityFromText,
  extractNameFromFilenames,
  mergeIdentityWithFilenamePair
} from '../../server/utils/patient-identity.js';

describe('splitCamelCase (PDF-extraction concatenation repair)', () => {
  it('inserts a space at lowercase→uppercase boundaries', () => {
    expect(splitCamelCase('ArnoldGlicksman')).toBe('Arnold Glicksman');
    expect(splitCamelCase('MargaretVolya')).toBe('Margaret Volya');
  });
  it('is idempotent on already-spaced names', () => {
    expect(splitCamelCase('Arnold Glicksman')).toBe('Arnold Glicksman');
    expect(splitCamelCase('Adrian Gropper')).toBe('Adrian Gropper');
  });
  it('handles mid-name apostrophes and hyphens correctly', () => {
    expect(splitCamelCase("MaryO'Brien")).toBe("Mary O'Brien");
    expect(splitCamelCase("Jean-LucPicard")).toBe("Jean-Luc Picard");
  });
  it('collapses doubled internal whitespace', () => {
    expect(splitCamelCase('Arnold  Glicksman')).toBe('Arnold Glicksman');
  });
  it('handles empty / null gracefully', () => {
    expect(splitCamelCase('')).toBe('');
    expect(splitCamelCase(null)).toBe(null);
  });
});

describe('parsePatientIdentityFromText — AH "Margarita" format (the sierra08 bug)', () => {
  it('extracts name + DOB from the line-above-DOB anchor with a spelled-out month', () => {
    // Verbatim from sierra08's Apple Health PDF header.
    const text = `

Margarita
Date of Birth: Jul 26, 1958 (Age 67)Mass General Brigham
Allergies
ALLRGYONSTRCORDD`;
    const id = parsePatientIdentityFromText(text);
    expect(id.name).toBe('Margarita');
    expect(id.dobIso).toBe('1958-07-26');
    expect(id.age).toBeGreaterThan(60); // depends on test clock; sanity check
  });

  it('extracts a multi-word name on the line above the DOB', () => {
    const text = `

Margaret Volya
Date of Birth: Jul 26, 1958 (Age 67)Mass General Brigham`;
    const id = parsePatientIdentityFromText(text);
    expect(id.name).toBe('Margaret Volya');
    expect(id.dobIso).toBe('1958-07-26');
  });

  it('rejects an anchor-line that looks like boilerplate (does NOT pick "Allergies")', () => {
    // No name line at all — the line above DOB is the institution
    // banner / a category header. The parser should leave name=null
    // instead of silently grabbing the wrong thing.
    const text = `

Allergies
Date of Birth: Jul 26, 1958 (Age 67)Mass General Brigham`;
    const id = parsePatientIdentityFromText(text);
    expect(id.name).toBe(null);
    expect(id.dobIso).toBe('1958-07-26');
  });

  it('handles the day-first DOB variant ("26 Jul 1958")', () => {
    const text = 'Patient\nDOB: 26 Jul 1958';
    const id = parsePatientIdentityFromText(text);
    expect(id.dobIso).toBe('1958-07-26');
  });

  it('handles ISO DOB ("1958-07-26")', () => {
    const text = 'Patient\nDate of Birth: 1958-07-26';
    const id = parsePatientIdentityFromText(text);
    expect(id.dobIso).toBe('1958-07-26');
  });
});

describe('extractNameFromFilenames + mergeIdentityWithFilenamePair (the Volya last-name case)', () => {
  it('mines the surname from real Epic filenames (LASTNAME_FIRSTNAME_*)', () => {
    const names = [
      'Health Records - Margarita - 2026-05-18 at 10.56.10.pdf', // AH — ignored
      'VOLYA_MARGARET_Volya_ Margaret _Rita__999762983-5_12_10_25_1527-20251210124737943.PDF',
      'VOLYA_MARGARET_Volya_ Margaret _Rita__999762983-5_12_10_25_1526-20251210124550936.PDF'
    ];
    const pair = extractNameFromFilenames(names);
    expect(pair).not.toBeNull();
    expect(pair.last).toBe('Volya');
    expect(pair.first).toBe('Margaret');
  });

  it('handles the GROPPER_ADRIAN-style filename', () => {
    const names = ['GROPPER_ADRIAN_05_12_26_1233-main.PDF'];
    const pair = extractNameFromFilenames(names);
    expect(pair.last).toBe('Gropper');
    expect(pair.first).toBe('Adrian');
  });

  it('returns null when no filename matches the LASTNAME_FIRSTNAME pattern', () => {
    expect(extractNameFromFilenames(['Health Records - Margarita - 2026.pdf'])).toBeNull();
    expect(extractNameFromFilenames(['lab-report.pdf', 'visit_summary.pdf'])).toBeNull();
    expect(extractNameFromFilenames([])).toBeNull();
    expect(extractNameFromFilenames(null)).toBeNull();
  });

  it('picks the most frequent pair when multiple distinct LASTNAME_FIRSTNAME prefixes appear', () => {
    const names = [
      'VOLYA_MARGARET_a.pdf',
      'VOLYA_MARGARET_b.pdf',
      'VOLYA_MARGARET_c.pdf',
      'SMITH_JOHN_one.pdf'
    ];
    const pair = extractNameFromFilenames(names);
    expect(pair.last).toBe('Volya');
    expect(pair.first).toBe('Margaret');
  });

  it('merges: first-name-only header + filename pair → full name with surname', () => {
    // The exact sierra08 scenario: AH header gives "Margarita", Epic
    // filenames carry "Volya, Margaret".
    const merged = mergeIdentityWithFilenamePair(
      { name: 'Margarita', dobIso: '1958-07-26', sex: 'Female', age: 67 },
      { first: 'Margaret', last: 'Volya' }
    );
    expect(merged.name).toBe('Margarita Volya');
    // Other fields preserved.
    expect(merged.dobIso).toBe('1958-07-26');
    expect(merged.sex).toBe('Female');
  });

  it('merges: empty header + filename pair → "First Last" from the filename', () => {
    const merged = mergeIdentityWithFilenamePair(
      { name: null, dobIso: '1980-01-01' },
      { first: 'Margaret', last: 'Volya' }
    );
    expect(merged.name).toBe('Margaret Volya');
  });

  it('does NOT touch a header name that already has 2+ tokens', () => {
    const merged = mergeIdentityWithFilenamePair(
      { name: 'Margaret Volya', dobIso: '1958-07-26' },
      { first: 'Margaret', last: 'Volya' }
    );
    expect(merged.name).toBe('Margaret Volya');
  });

  it('does NOT touch a header name when it conflicts with a different-surname filename', () => {
    // Don't auto-correct a 2-token header just because the filename
    // disagrees — too risky (could clobber a valid married name).
    const merged = mergeIdentityWithFilenamePair(
      { name: 'Margaret Johnson', dobIso: '1958-07-26' },
      { first: 'Margaret', last: 'Volya' }
    );
    expect(merged.name).toBe('Margaret Johnson');
  });

  it('handles the Margarita ↔ Margaret diminutive (shares 3-char prefix → keep preferred name)', () => {
    const merged = mergeIdentityWithFilenamePair(
      { name: 'Margarita' },
      { first: 'Margaret', last: 'Volya' }
    );
    // Header form (preferred name) wins for the first name; filename
    // contributes the surname.
    expect(merged.name).toBe('Margarita Volya');
  });

  it('uses the filename pair when the header token does NOT share a prefix with the filename FIRST', () => {
    // Header has a middle name or unrelated nickname; filename is
    // the more structured source so use it.
    const merged = mergeIdentityWithFilenamePair(
      { name: 'Rita' },
      { first: 'Margaret', last: 'Volya' }
    );
    expect(merged.name).toBe('Margaret Volya');
  });
});

describe('MGB Patient Extract format (the mackenzie58 bug)', () => {
  it('parses the duplicated-overlay LASTNAME,FIRSTNAME (no space after comma)', () => {
    // Verbatim shape pdf-parse produces on the MGB Patient Extract
    // export. The 4× duplication is real; the comma-no-space is real.
    const text = `Partners HealthCare System, Inc.
MASSACHUSETTS GENERAL HOSPITAL
MRN: 4786557 (MGH)MRN: 4786557 (MGH)MRN: 4786557 (MGH)MRN: 4786557 (MGH)
VOLYA,MARGARETVOLYA,MARGARETVOLYA,MARGARETVOLYA,MARGARET
Date of Birth: 07/26/1958
Sex: F`;
    const id = parsePatientIdentityFromText(text);
    expect(id.name).toBe('MARGARET VOLYA');
    expect(id.dobIso).toBe('1958-07-26');
    expect(id.sex).toBe('Female');
  });

  it('rejects "Name:ARNOLDGALICKSMAN" when preceded by ContactPerson / Friend / Relationship labels', () => {
    // Verbatim from mackenzie58 / sierra08's MGB Patient Extract:
    // the patient is VOLYA,MARGARET but the document also lists an
    // emergency contact under "ContactPerson: / Name:ARNOLDGALICKSMAN /
    // Relationship:FRIEND". The parser must take VOLYA,MARGARET and
    // ignore the emergency contact.
    const text = `Partners HealthCare
MRN: 4786557 (MGH)
VOLYA,MARGARET
Date of Birth: 07/26/1958
Sex: F
…
Phone:(508)756-7176
ContactPerson:
Name:ARNOLDGALICKSMAN
Relationship:FRIEND
Telephone:3393680067
HealthCareProxy:
Name:`;
    const id = parsePatientIdentityFromText(text);
    expect(id.name).toBe('MARGARET VOLYA');
    expect(id.name).not.toMatch(/arnold/i);
    expect(id.name).not.toMatch(/galicksman/i);
  });

  it('extracts encounters from MGB datetime + type lines after overlay dedup', async () => {
    const { extractEncountersFromText } = await import('../../server/utils/encounters-extractor.js');
    // 4× duplicated header lines, one MGB visit line. The extractor
    // must dedup first, then find the visit.
    const text = `Discharge Reports From 1/1/1993 through 5/29/2015Discharge Reports From 1/1/1993 through 5/29/2015Discharge Reports From 1/1/1993 through 5/29/2015Discharge Reports From 1/1/1993 through 5/29/2015
11/03/2012 03:2311/03/2012 03:2311/03/2012 03:2311/03/2012 03:23Patient Care ReferralPatient Care ReferralPatient Care ReferralPatient Care Referral`;
    const r = extractEncountersFromText(text, 1, 'File 4');
    expect(r.mode).toBe('mgb-patient-extract');
    expect(r.encounters.length).toBeGreaterThanOrEqual(1);
    const enc = r.encounters.find(e => e.isoDate === '2012-11-03');
    expect(enc).toBeDefined();
    expect(enc.description).toContain('Patient Care Referral');
  });

  it('pairs Admission + Discharge into one inpatient encounter', async () => {
    const { extractEncountersFromText } = await import('../../server/utils/encounters-extractor.js');
    const text = `Admission:11/3/2012
Discharge:11/6/2012`;
    const r = extractEncountersFromText(text, 1, 'File 4');
    expect(r.mode).toBe('mgb-patient-extract');
    // ONE row — not two. Anchored to the admission date.
    expect(r.encounters.length).toBe(1);
    expect(r.encounters[0].isoDate).toBe('2012-11-03');
    expect(r.encounters[0].type).toBe('Inpatient');
    expect(r.encounters[0].description).toMatch(/discharged 2012-11-06/);
  });

  it('parses "Encounter Date:" with the following descriptor line', async () => {
    const { extractEncountersFromText } = await import('../../server/utils/encounters-extractor.js');
    const text = `Encounter Date: 6/10/2021
Report - Radiology - Scan on 6/10/2021 12:03 PM`;
    const r = extractEncountersFromText(text, 1, 'File 5');
    expect(r.mode).toBe('mgb-patient-extract');
    expect(r.encounters.length).toBeGreaterThanOrEqual(1);
    const enc = r.encounters.find(e => e.isoDate === '2021-06-10');
    expect(enc).toBeDefined();
    expect(enc.description).toMatch(/radiology/i);
  });

  it('rejects section banners ("from M/D/YYYY through M/D/YYYY") as encounters', async () => {
    const { extractEncountersFromText } = await import('../../server/utils/encounters-extractor.js');
    const text = `Discharge Reports From 1/1/1993 through 5/29/2015
Discharge Reports from 1/1/1993 through 5/29/2015 (cont)`;
    const r = extractEncountersFromText(text, 1, 'File 4');
    // No real encounters in this snippet — only banners. Must NOT
    // emit a row dated 1/1/1993 or 5/29/2015.
    expect(r.encounters.find(e => /1993|2015/.test(e.isoDate))).toBeUndefined();
  });

  it('dedupOverlay collapses real-world 4× overlay duplication', async () => {
    const { dedupOverlay } = await import('../../server/utils/encounters-extractor.js');
    expect(dedupOverlay('VOLYA,MARGARETVOLYA,MARGARETVOLYA,MARGARETVOLYA,MARGARET'))
      .toBe('VOLYA,MARGARET');
    expect(dedupOverlay('11/03/2012 03:2311/03/2012 03:2311/03/2012 03:2311/03/2012 03:23'))
      .toBe('11/03/2012 03:23');
    // Idempotent on non-duplicated text.
    expect(dedupOverlay('Hello world')).toBe('Hello world');
    // Doesn't disturb innocuous short repeats (4-char minimum guard).
    expect(dedupOverlay('Mississippi')).toBe('Mississippi');
  });
});

describe('parsePatientIdentityFromText — guards against picking the SPOUSE name', () => {
  it('does not pull "Arnold Glicksman" from a spouse / emergency-contact line', () => {
    // The line above "Spouse:" is the spouse — NOT the patient.
    // The line above "Date of birth:" is the patient. The parser
    // should prefer the DOB anchor and ignore the spouse block.
    const text = `

Margaret Volya
Date of Birth: 7/26/1958
MRN: 999762983
Spouse:
Arnold Glicksman
Emergency Contact: Arnold Glicksman, 555-1234`;
    const id = parsePatientIdentityFromText(text);
    expect(id.name).toBe('Margaret Volya');
    // Must NOT have wandered to the spouse name.
    expect(id.name).not.toMatch(/arnold/i);
    expect(id.name).not.toMatch(/glicksman/i);
  });
});

describe('detectPatientMismatch — the spouse case (the bug that prompted this module)', () => {
  it('flags multi-patient files when DOBs differ — even with same surname', () => {
    // The Glicksman/Volya scenario: spouses with different DOBs.
    const identities = [
      { fileName: 'AH - Margaret.pdf', isAppleHealth: true,  name: 'Margaret Volya',     dobIso: '1957-06-12', sex: 'Female' },
      { fileName: 'Epic - Margaret.pdf', isAppleHealth: false, name: 'Margaret Volya',   dobIso: '1957-06-12', sex: 'Female' },
      { fileName: 'Arnold - cardiology.pdf', isAppleHealth: false, name: 'Arnold Glicksman', dobIso: '1955-03-08', sex: 'Male' }
    ];
    const result = detectPatientMismatch(identities);
    expect(result.consistent).toBe(false);
    expect(result.primary.name).toBe('Margaret Volya');
    expect(result.primary.dobIso).toBe('1957-06-12');
    expect(result.primary.fromFiles).toHaveLength(2);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0].fileName).toBe('Arnold - cardiology.pdf');
    expect(result.reason).toMatch(/SAFETY/);
    expect(result.reason).toMatch(/Margaret/);
    expect(result.reason).toMatch(/Arnold/);
  });

  it('prefers the Apple Health file as the primary on cohort-size tie', () => {
    const identities = [
      { fileName: 'Epic - PatientA.pdf', isAppleHealth: false, name: 'Patient A', dobIso: '1960-01-01' },
      { fileName: 'AH - PatientB.pdf',   isAppleHealth: true,  name: 'Patient B', dobIso: '1970-02-02' }
    ];
    const result = detectPatientMismatch(identities);
    expect(result.consistent).toBe(false);
    expect(result.primary.name).toBe('Patient B'); // AH wins the tie
  });
});

describe('detectPatientMismatch — happy paths (must NOT false-alarm)', () => {
  it('treats a single patient across multiple files as consistent', () => {
    const identities = [
      { fileName: 'AH.pdf',        isAppleHealth: true,  name: 'Adrian Gropper', dobIso: '1952-06-15' },
      { fileName: 'Epic-1.pdf',    isAppleHealth: false, name: 'Adrian Gropper', dobIso: '1952-06-15' },
      { fileName: 'Epic-2.pdf',    isAppleHealth: false, name: 'Adrian Gropper', dobIso: '1952-06-15' }
    ];
    const result = detectPatientMismatch(identities);
    expect(result.consistent).toBe(true);
    expect(result.mismatches).toEqual([]);
    expect(result.primary.dobIso).toBe('1952-06-15');
  });

  it('does not false-alarm on same DOB with different surname (married/maiden case)', () => {
    // Same patient, married name on AH, maiden name on older lab report.
    const identities = [
      { fileName: 'AH.pdf',       isAppleHealth: true,  name: 'Mary Johnson',  dobIso: '1980-05-01' },
      { fileName: 'Old-lab.pdf',  isAppleHealth: false, name: 'Mary Smith',    dobIso: '1980-05-01' }
    ];
    const result = detectPatientMismatch(identities);
    expect(result.consistent).toBe(true);
    expect(result.mismatches).toEqual([]);
  });

  it('does not false-alarm on Jr./Sr. (same surname, DOB differs but treated correctly as mismatch)', () => {
    // Father and son with same first/last name but different DOB.
    // Our DOB-first rule correctly flags this as a mismatch — even
    // though the names match identically. That's the right call:
    // even Jr./Sr. records should NOT be co-mingled in one MAIA
    // account.
    const identities = [
      { fileName: 'sr.pdf', isAppleHealth: true,  name: 'John Doe', dobIso: '1950-01-01' },
      { fileName: 'jr.pdf', isAppleHealth: false, name: 'John Doe', dobIso: '1980-01-01' }
    ];
    const result = detectPatientMismatch(identities);
    expect(result.consistent).toBe(false); // safety wins
  });

  it('skips files with no parseable identity (some lab reports lack patient headers)', () => {
    const identities = [
      { fileName: 'AH.pdf',     isAppleHealth: true,  name: 'Adrian Gropper', dobIso: '1952-06-15' },
      { fileName: 'lab-no-header.pdf', isAppleHealth: false, name: null, dobIso: null }
    ];
    const result = detectPatientMismatch(identities);
    expect(result.consistent).toBe(true);
    expect(result.primary.name).toBe('Adrian Gropper');
  });

  it('returns consistent=true when only one file has an identity (no comparison possible)', () => {
    const identities = [
      { fileName: 'AH.pdf', isAppleHealth: true,  name: 'Adrian Gropper', dobIso: '1952-06-15' },
      { fileName: 'a.pdf',  isAppleHealth: false, name: null, dobIso: null },
      { fileName: 'b.pdf',  isAppleHealth: false, name: null, dobIso: null }
    ];
    const result = detectPatientMismatch(identities);
    expect(result.consistent).toBe(true);
    expect(result.reason).toMatch(/Only one file/);
  });

  it('returns consistent=true with empty file list', () => {
    const result = detectPatientMismatch([]);
    expect(result.consistent).toBe(true);
    expect(result.primary).toBe(null);
    expect(result.groups).toEqual([]);
  });
});

describe('detectPatientMismatch — DOB-less edge cases (name-only)', () => {
  it('treats name-only files with the same surname as consistent', () => {
    const identities = [
      { fileName: 'a.pdf', isAppleHealth: false, name: 'Adrian Gropper',  dobIso: null },
      { fileName: 'b.pdf', isAppleHealth: false, name: 'A. Gropper',      dobIso: null }
    ];
    const result = detectPatientMismatch(identities);
    expect(result.consistent).toBe(true);
  });

  it('surfaces a SOFT mismatch (consistent=true, but mismatches populated) for different surnames with no DOBs', () => {
    // Intentionally lenient: PDF extraction can mangle names enough
    // that we shouldn't BLOCK on name-only data. Surface it as
    // advisory information instead.
    const identities = [
      { fileName: 'a.pdf', isAppleHealth: false, name: 'Adrian Gropper',  dobIso: null },
      { fileName: 'b.pdf', isAppleHealth: false, name: 'Margaret Volya',  dobIso: null }
    ];
    const result = detectPatientMismatch(identities);
    expect(result.consistent).toBe(true); // soft — don't block
    expect(result.mismatches.length).toBeGreaterThan(0);
    expect(result.reason).toMatch(/multiple surnames/i);
  });

  it('flags a DOB-less file with a surname mismatch against the primary (DOB-having) group', () => {
    const identities = [
      { fileName: 'AH.pdf',      isAppleHealth: true,  name: 'Adrian Gropper', dobIso: '1952-06-15' },
      { fileName: 'lab.pdf',     isAppleHealth: false, name: 'Margaret Volya', dobIso: null }
    ];
    const result = detectPatientMismatch(identities);
    // Soft mismatch — DOBs alone all match (only one DOB present), but
    // the no-DOB file has a non-matching surname, so it's surfaced.
    expect(result.mismatches.length).toBeGreaterThan(0);
    expect(result.mismatches[0].fileName).toBe('lab.pdf');
  });
});
