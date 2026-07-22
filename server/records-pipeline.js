/**
 * recordsPipeline — the one server-owned view of a user's records journey.
 * New_User_Flows.md §5, step 1.
 *
 * Stage statuses are DERIVED from fields the existing surfaces already
 * persist (files, listsBuild, currentMedications, kbIndexingStatus,
 * draftPatientSummary, patientSummaries), so the pipeline is correct for
 * every existing user with no migration and no new writes. Runtime state
 * (running/error/timestamps) rides on those same fields.
 *
 * In step 1 the pipeline is a decision engine: /api/pipeline/advance
 * returns what the next step IS and who runs it ('user' | 'client' |
 * 'wait'). Step 2 migrates gates/wizard/Lists to render from this object;
 * step 3 moves 'client' executions server-side and deletes the
 * surface-specific triggers.
 */

export const PIPELINE_STAGES = [
  'imported',
  'listsBuilt',
  'medsVerified',
  'indexed',
  'summaryDrafted',
  'summaryVerified'
];

const trimmed = (v) => String(v || '').trim();

/**
 * Derive the full pipeline object from a userDoc.
 *
 * @param {object} userDoc
 * @param {object} [opts]
 * @param {boolean|null} [opts.hasFilesInKB] — pass the DO-verified value when
 *   the caller already computed it (user-status does); otherwise it is
 *   derived from the userDoc's own indexing fields, matching user-status's
 *   fallback logic.
 */
export function computeRecordsPipeline(userDoc, opts = {}) {
  const files = Array.isArray(userDoc?.files) ? userDoc.files : [];
  const hasAppleFile = files.some((f) => f && f.isAppleHealth) || userDoc?.hasAppleFile === true;
  const appleFile = files.find((f) => f && f.isAppleHealth) || null;

  const stages = {};

  // imported — any registered health record file
  const uploadTimes = files.map((f) => f && f.uploadedAt).filter(Boolean).sort();
  stages.imported = files.length > 0
    ? { status: 'done', at: uploadTimes[0] || null }
    : { status: 'pending', at: null };

  // listsBuilt — the deterministic categories/sidecar build (Apple Health only)
  const lb = userDoc?.listsBuild || null;
  if (!hasAppleFile) {
    stages.listsBuilt = { status: stages.imported.status === 'done' ? 'skipped' : 'pending', at: null };
  } else if (lb && lb.status === 'done') {
    stages.listsBuilt = { status: 'done', at: lb.finishedAt || null };
  } else if (lb && lb.status === 'running') {
    stages.listsBuilt = { status: 'running', at: lb.startedAt || null };
  } else if (lb && lb.status === 'error') {
    stages.listsBuilt = { status: 'error', at: lb.finishedAt || lb.startedAt || null, error: lb.error || null };
  } else {
    stages.listsBuilt = { status: 'pending', at: null };
  }

  // medsVerified — the user has confirmed Current Medications (the meds
  // gate). Only REQUIRED when an Apple Health file exists: the historic
  // gates never blocked Epic-only users (their candidates come from the
  // slower Epic extraction and verification stays optional), and step 2
  // preserves that behavior.
  if (trimmed(userDoc?.currentMedications)) {
    stages.medsVerified = { status: 'done', at: null };
  } else {
    stages.medsVerified = { status: hasAppleFile ? 'pending' : 'skipped', at: null };
  }

  // indexed — KB has indexed files. Mirror user-status: trust the caller's
  // DO-verified value when given, else the doc's own fallbacks.
  const ks = userDoc?.kbIndexingStatus || null;
  const docSaysIndexed = ks?.backendCompleted === true
    || (Array.isArray(userDoc?.kbIndexedBucketKeys) && userDoc.kbIndexedBucketKeys.length > 0);
  const indexedDone = opts.hasFilesInKB === true || (opts.hasFilesInKB == null && docSaysIndexed);
  if (indexedDone) {
    stages.indexed = { status: 'done', at: ks?.completedAt || null };
  } else if (ks?.phase && ks.phase !== 'complete' && ks.phase !== 'error' && ks.phase !== 'failed') {
    stages.indexed = { status: 'running', at: ks.startedAt || null, phase: ks.phase };
  } else if (ks?.phase === 'error' || ks?.phase === 'failed') {
    stages.indexed = { status: 'error', at: null, error: ks.error || ks.phase };
  } else {
    stages.indexed = { status: 'pending', at: null };
  }

  // summaryDrafted — a governed draft exists (userDoc.draftPatientSummary),
  // or the draft job (userDoc.draftJob, written by runDraftGeneration) is
  // running/failed. A 'running' older than 10 minutes is treated as an
  // error so a died process can't wedge the stage.
  const dj = userDoc?.draftJob || null;
  const djRunningFresh = dj?.status === 'running' && dj.startedAt
    && (Date.now() - Date.parse(dj.startedAt)) < 10 * 60 * 1000;
  if (dj?.status === 'running' && djRunningFresh) {
    stages.summaryDrafted = { status: 'running', at: dj.startedAt || null };
  } else if (dj?.status === 'error' || (dj?.status === 'running' && !djRunningFresh)) {
    stages.summaryDrafted = trimmed(userDoc?.draftPatientSummary?.text)
      ? { status: 'done', at: userDoc.draftPatientSummary.draftAt || null }
      : { status: 'error', at: dj.finishedAt || dj.startedAt || null, error: dj.error || 'stalled' };
  } else if (trimmed(userDoc?.draftPatientSummary?.text)) {
    stages.summaryDrafted = { status: 'done', at: userDoc.draftPatientSummary.draftAt || null };
  } else {
    stages.summaryDrafted = { status: 'pending', at: null };
  }

  // summaryVerified — a summary was saved through the review dialog
  // (patientSummaries array, or the legacy single field)
  const hasSaved = (Array.isArray(userDoc?.patientSummaries) && userDoc.patientSummaries.length > 0)
    || !!trimmed(userDoc?.patientSummary);
  stages.summaryVerified = hasSaved
    ? { status: 'done', at: null }
    : { status: 'pending', at: null };

  const current = PIPELINE_STAGES.find((s) => !['done', 'skipped'].includes(stages[s].status)) || 'complete';

  return {
    stages,
    current,
    hasAppleFile,
    appleFileName: appleFile?.fileName || null,
    computedAt: new Date().toISOString()
  };
}

/**
 * The server's decision on what happens next.
 * kind: 'user'   — needs a human choice/action (open this surface)
 *       'client' — the client should fire this existing call (step 3 will
 *                  move these server-side)
 *       'wait'   — a stage is running; poll
 *       'done'   — pipeline complete
 */
export function decideNextAction(pipeline) {
  const st = pipeline.stages;
  switch (pipeline.current) {
    case 'imported':
      return { kind: 'user', action: 'add-records', description: 'Add a health record file (chat "+" or wizard ADD FILES)' };
    case 'listsBuilt':
      if (st.listsBuilt.status === 'running') return { kind: 'wait', action: 'lists-build-running' };
      return {
        kind: 'client',
        action: 'process-initial-file',
        params: { fileName: pipeline.appleFileName, force: st.listsBuilt.status === 'error' },
        description: 'Build the deterministic Lists from the Apple Health file'
      };
    case 'medsVerified':
      return { kind: 'user', action: 'verify-medications', target: 'lists', description: 'Review and VERIFY Current Medications on the Lists tab' };
    case 'indexed':
      if (st.indexed.status === 'running') return { kind: 'wait', action: 'indexing-running', phase: st.indexed.phase || null };
      return { kind: 'client', action: 'start-indexing', description: 'Index the records into the knowledge base (wizard INDEX MY RECORDS)' };
    case 'summaryDrafted':
      if (st.summaryDrafted.status === 'running') return { kind: 'wait', action: 'draft-running' };
      return { kind: 'client', action: 'request-draft', endpoint: '/api/patient-summary/draft', description: 'Generate the governed Patient Summary draft' };
    case 'summaryVerified':
      return { kind: 'user', action: 'review-summary', target: 'patient-summary', description: 'Review the draft and save it (the review dialog is the only save path)' };
    default:
      return { kind: 'done', action: 'complete' };
  }
}
