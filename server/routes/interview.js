/**
 * Patient Summary by interview (Personal AS edition; group_requests.md §5,
 * D11 route 2).
 *
 * A member with no records answers a few questions; their private AI drafts
 * a Patient Summary from those answers alone (clinical prompt
 * `patient-summary.interview`). The draft lands where every draft lands —
 * userDoc.draftPatientSummary, tracked by userDoc.draftJob — so the
 * existing review dialog stays the only way to save and verify it, and the
 * privacy-filtered copy follows from that verification. Nothing is saved
 * as the patient's summary here, and nothing is verified.
 */
import { getClinicalPrompt } from '../utils/clinical-prompts.js';
import { getEdition } from '../edition.js';
import { requestedUserId } from '../utils/api-guard.js';

const USERS_DB = 'maia_users';

/** The questions and each answer's maximum length. */
export const INTERVIEW_FIELDS = Object.freeze({
  name: 120,
  dateOfBirth: 40,
  sex: 40,
  conditions: 4000,
  medications: 4000,
  allergies: 2000,
  recentVisits: 4000,
  other: 4000
});

export const normalizeInterview = (raw) => {
  const out = {};
  for (const [key, max] of Object.entries(INTERVIEW_FIELDS)) {
    const v = raw && typeof raw[key] === 'string' ? raw[key].trim() : '';
    out[key] = v.slice(0, max);
  }
  return out;
};

/** Enough to write a summary: at least one of the clinical answers. */
export const hasSubstance = (a) => !!(a.conditions || a.medications || a.allergies);

const NOT_GIVEN = '(not provided)';

export const buildInterviewPrompt = (a, today = new Date().toISOString().slice(0, 10)) => {
  const vars = {
    today,
    name: a.name || NOT_GIVEN,
    dateOfBirth: a.dateOfBirth || NOT_GIVEN,
    sex: a.sex || NOT_GIVEN,
    conditions: a.conditions || NOT_GIVEN,
    currentMedications: a.medications || NOT_GIVEN,
    allergies: a.allergies || NOT_GIVEN,
    recentVisits: a.recentVisits || NOT_GIVEN,
    other: a.other || NOT_GIVEN
  };
  const fromFile = getClinicalPrompt('patient-summary.interview', vars);
  if (fromFile) return fromFile;
  // Built-in fallback so a broken prompts file never blocks the interview.
  return [
    'Write a Patient Summary for an on-call physician, using ONLY the patient\'s own answers below. Never add facts.',
    `Today is ${vars.today}. First line: name, age, sex. Then the sections Medical History, Recent Visits (past 12 months),`,
    'Current Medications, Stopped or Inactive Medications, Allergies, Social History, Radiology, Out of Range Labs, Other Testing;',
    'write "Not provided by the patient." for any section without an answer.',
    '',
    `Name: ${vars.name}\nDate of birth: ${vars.dateOfBirth}\nSex: ${vars.sex}`,
    `Health conditions and past surgeries:\n${vars.conditions}`,
    `Medicines taken now:\n${vars.currentMedications}`,
    `Allergies:\n${vars.allergies}`,
    `Doctors seen in the past year:\n${vars.recentVisits}`,
    `Anything else:\n${vars.other}`
  ].join('\n');
};

/**
 * @param {object} deps
 * @param {object} deps.cloudant
 * @param {(userDoc: object, messages: Array<{role: string, content: string}>) => Promise<{content?: string, text?: string}>} deps.chatWithPrimaryAgent
 * @param {(userId: string, patch: object) => Promise<void>} deps.setDraftJob
 * @param {(userId: string, event: object) => Promise<void>} [deps.logEvent]
 */
export default function setupInterviewRoutes(app, { cloudant, chatWithPrimaryAgent, setDraftJob, logEvent = async () => {} }) {
  const draftInBackground = async (userDoc, answers) => {
    const userId = userDoc.userId;
    const startedAt = Date.now();
    try {
      const resp = await chatWithPrimaryAgent(userDoc, [{ role: 'user', content: buildInterviewPrompt(answers) }]);
      const text = String(resp?.content || resp?.text || '').trim();
      if (!text) throw new Error('Empty draft from the private AI');
      const generationSeconds = Math.round(((Date.now() - startedAt) / 1000) * 10) / 10;
      for (let attempt = 0; attempt < 3; attempt++) {
        const doc = await cloudant.getDocument(USERS_DB, userId);
        if (!doc) throw new Error('USER_NOT_FOUND');
        doc.draftPatientSummary = { text, draftAt: new Date().toISOString(), generationSeconds, source: 'interview' };
        doc.updatedAt = new Date().toISOString();
        try {
          await cloudant.saveDocument(USERS_DB, doc);
          break;
        } catch (e) {
          if (e?.statusCode === 409 && attempt < 2) continue;
          throw e;
        }
      }
      await setDraftJob(userId, { status: 'done', finishedAt: new Date().toISOString(), error: null });
      await logEvent(userId, { event: 'summary-interview-drafted', generationSeconds });
    } catch (e) {
      const reason = e?.message || String(e);
      console.warn(`[interview] draft failed for ${userId}: ${reason}`);
      await setDraftJob(userId, { status: 'error', finishedAt: new Date().toISOString(), error: reason });
      await logEvent(userId, { event: 'summary-interview-failed', reason });
    }
  };

  // POST /api/patient-summary/interview { userId, answers } — store the
  // answers and start drafting. 202: poll the pipeline's summaryDrafted
  // stage, then load the draft into the review dialog.
  app.post('/api/patient-summary/interview', async (req, res) => {
    if (getEdition() !== 'personal-as') {
      return res.status(400).json({ success: false, error: 'NOT_IN_THIS_EDITION' });
    }
    const userId = requestedUserId(req) || req.session?.userId;
    if (!userId) return res.status(401).json({ success: false, error: 'NOT_AUTHENTICATED', message: 'Sign in required' });
    const answers = normalizeInterview(req.body?.answers);
    if (!hasSubstance(answers)) {
      return res.status(400).json({
        success: false,
        error: 'NOT_ENOUGH_ANSWERS',
        message: 'Tell MAIA about at least your health conditions, your medicines, or your allergies.'
      });
    }
    try {
      const doc = await cloudant.getDocument(USERS_DB, userId);
      if (!doc) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
      if (!doc.assignedAgentId || !doc.agentEndpoint) {
        return res.status(409).json({
          success: false,
          error: 'AGENT_NOT_READY',
          message: 'Your private AI is still getting ready. Try again in a minute.'
        });
      }
      const dj = doc.draftJob;
      if (dj?.status === 'running' && dj.startedAt && Date.now() - Date.parse(dj.startedAt) < 10 * 60 * 1000) {
        return res.status(409).json({ success: false, error: 'DRAFT_RUNNING', message: 'A summary is already being drafted.' });
      }
      doc.patientInterview = { answers, at: new Date().toISOString() };
      // An older UNSAVED draft would otherwise read as this one's result if
      // this draft failed. (Only the hidden draft — never a saved summary.)
      delete doc.draftPatientSummary;
      doc.updatedAt = doc.patientInterview.at;
      await cloudant.saveDocument(USERS_DB, doc);
      await setDraftJob(userId, { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, error: null, source: 'interview' });
      await logEvent(userId, { event: 'summary-interview-started' });
      void draftInBackground(doc, answers);
      return res.status(202).json({ success: true, started: true });
    } catch (e) {
      console.error('[interview] start failed:', e?.message || e);
      return res.status(500).json({ success: false, error: 'INTERVIEW_FAILED' });
    }
  });

  // GET /api/patient-summary/interview — the answers last given, to prefill
  // a new interview.
  app.get('/api/patient-summary/interview', async (req, res) => {
    const userId = requestedUserId(req) || req.session?.userId;
    if (!userId) return res.status(401).json({ success: false, error: 'NOT_AUTHENTICATED', message: 'Sign in required' });
    try {
      const doc = await cloudant.getDocument(USERS_DB, userId);
      if (!doc) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
      res.json({ success: true, answers: doc.patientInterview?.answers || null, at: doc.patientInterview?.at || null });
    } catch (e) {
      res.status(500).json({ success: false, error: 'INTERVIEW_READ_FAILED' });
    }
  });
}
