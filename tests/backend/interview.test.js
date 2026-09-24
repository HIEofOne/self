/**
 * Patient Summary by interview (Personal AS edition, group_requests.md §5
 * D11): answers → a draft from the private AI, stored where every draft is
 * stored; never saved or verified here (the review dialog stays the only
 * save path — PS/CM invariants).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import setupInterviewRoutes, {
  normalizeInterview, hasSubstance, buildInterviewPrompt, INTERVIEW_FIELDS
} from '../../server/routes/interview.js';
import { EDITIONS, getEdition, setEditionForTests } from '../../server/edition.js';

const originalEdition = getEdition();
afterAll(() => setEditionForTests(originalEdition));

describe('interview answers and prompt', () => {
  it('trims answers, caps their length, and ignores unknown fields', () => {
    const a = normalizeInterview({ conditions: '  asthma  ', medications: 'x'.repeat(9000), hack: 'ignore me', name: 7 });
    expect(a.conditions).toBe('asthma');
    expect(a.medications.length).toBe(INTERVIEW_FIELDS.medications);
    expect(a.name).toBe('');
    expect(a).not.toHaveProperty('hack');
  });

  it('needs at least conditions, medications, or allergies', () => {
    expect(hasSubstance(normalizeInterview({ name: 'Pat' }))).toBe(false);
    expect(hasSubstance(normalizeInterview({ allergies: 'penicillin (hives)' }))).toBe(true);
  });

  it("builds the prompt from the patient's own answers, marking what they left out", () => {
    const prompt = buildInterviewPrompt(normalizeInterview({
      name: 'Pat Doe', dateOfBirth: '1960-05-01', conditions: 'Type 2 diabetes', medications: 'Metformin 500 mg twice daily'
    }), '2026-09-24');
    expect(prompt).toContain('Pat Doe');
    expect(prompt).toContain('Metformin 500 mg twice daily');
    expect(prompt).toContain('2026-09-24');
    expect(prompt).toContain('(not provided)'); // allergies, visits, …
    expect(prompt).toContain('Not provided by the patient.');
    for (const heading of ['Medical History', 'Current Medications', 'Allergies', 'Out of Range Labs']) {
      expect(prompt).toContain(heading);
    }
    expect(prompt).not.toMatch(/\{[a-zA-Z]+\}/); // every placeholder filled
  });
});

class FakeCloudant {
  constructor(docs = {}) { this.docs = new Map(Object.entries(docs)); }
  async getDocument(_db, id) { const d = this.docs.get(id); return d ? JSON.parse(JSON.stringify(d)) : null; }
  async saveDocument(_db, doc) { this.docs.set(doc._id, JSON.parse(JSON.stringify(doc))); return { ok: true }; }
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const ANSWERS = { conditions: 'Hypertension', medications: 'Lisinopril 10 mg daily', allergies: 'None known' };

describe.each(EDITIONS)('interview route, edition "%s"', (edition) => {
  const pa = edition === 'personal-as';
  let cloudant, app, prompts, agentReply, events;
  const setDraftJob = async (userId, patch) => {
    const d = cloudant.docs.get(userId);
    d.draftJob = { ...(d.draftJob || {}), ...patch };
  };
  beforeEach(() => {
    setEditionForTests(edition);
    prompts = [];
    events = [];
    agentReply = async () => ({ content: '**Pat Doe**, 66, F\n\n**Medical History**\nHypertension.' });
    cloudant = new FakeCloudant({
      carol03: {
        _id: 'carol03', userId: 'carol03', assignedAgentId: 'a1', agentEndpoint: 'https://agent',
        patientSummaries: [{ text: 'old verified summary' }], patientSummaryVerifiedAt: '2026-09-01T00:00:00Z'
      },
      dave04: { _id: 'dave04', userId: 'dave04' } // private AI not ready
    });
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { const u = req.get('x-test-user'); req.session = u ? { userId: u } : {}; next(); });
    setupInterviewRoutes(app, {
      cloudant,
      chatWithPrimaryAgent: async (_doc, messages) => { prompts.push(messages[0].content); return agentReply(); },
      setDraftJob,
      logEvent: async (_u, e) => { events.push(e.event); }
    });
  });

  const start = (user, answers = ANSWERS) =>
    request(app).post('/api/patient-summary/interview').set('x-test-user', user).send({ userId: user, answers });

  it('is part of the Personal AS edition only', async () => {
    const r = await start('carol03');
    if (!pa) {
      expect(r.body.error).toBe('NOT_IN_THIS_EDITION');
      return;
    }
    expect(r.status).toBe(202);
  });

  it('refuses without a sign-in, without enough answers, or before the private AI is ready', async () => {
    if (!pa) return;
    expect((await request(app).post('/api/patient-summary/interview').send({ answers: ANSWERS })).status).toBe(401);
    expect((await start('carol03', { name: 'Pat' })).body.error).toBe('NOT_ENOUGH_ANSWERS');
    expect((await start('dave04')).body.error).toBe('AGENT_NOT_READY');
    expect(prompts).toEqual([]);
  });

  it('drafts from the answers into the usual draft slot — and saves or verifies nothing', async () => {
    if (!pa) return;
    expect((await start('carol03')).status).toBe(202);
    await settle();
    const d = cloudant.docs.get('carol03');
    expect(prompts[0]).toContain('Lisinopril 10 mg daily');
    expect(d.patientInterview.answers.conditions).toBe('Hypertension');
    expect(d.draftPatientSummary).toMatchObject({ source: 'interview' });
    expect(d.draftPatientSummary.text).toContain('Hypertension');
    expect(d.draftJob.status).toBe('done');
    // The committed, verified summary is untouched: the review dialog decides.
    expect(d.patientSummaries).toEqual([{ text: 'old verified summary' }]);
    expect(d.patientSummaryVerifiedAt).toBe('2026-09-01T00:00:00Z');
    expect(events).toEqual(['summary-interview-started', 'summary-interview-drafted']);
    const g = await request(app).get('/api/patient-summary/interview').set('x-test-user', 'carol03');
    expect(g.body.answers.medications).toBe('Lisinopril 10 mg daily');
  });

  it('a failed draft is reported on the draft job, not swallowed — and never shows an older draft', async () => {
    if (!pa) return;
    agentReply = async () => { throw new Error('agent down'); };
    cloudant.docs.get('carol03').draftPatientSummary = { text: 'an older unsaved draft' };
    await start('carol03');
    await settle();
    const d = cloudant.docs.get('carol03');
    expect(d.draftJob).toMatchObject({ status: 'error', error: 'agent down' });
    expect(d.draftPatientSummary).toBeUndefined();
  });

  it('one draft at a time', async () => {
    if (!pa) return;
    cloudant.docs.get('carol03').draftJob = { status: 'running', startedAt: new Date().toISOString() };
    expect((await start('carol03')).body.error).toBe('DRAFT_RUNNING');
  });
});
