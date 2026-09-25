/**
 * Authentication routes for user app
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { findUserAgent } from '../utils/agent-helper.js';
import { getProjectIdForGenAI } from '../utils/project-config.js';
import { getDoRegion } from '../utils/new-agent-config.js';
import { resolveSecondaryModel } from '../utils/secondary-models.js';
import { isVerified as isEmailVerified } from '../emailVerification.js';
import { mayCreatePrimaryAgent, getEdition } from '../edition.js';

// Wizard-done workflow stages (mirrors WIZARD_DONE_STAGES in
// ChatInterface.vue): agent-status writers must never downgrade these.
const WIZARD_DONE_STAGES_AUTH = new Set(['chat_ready', 'patient_summary', 'link_stored']);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Helper to get client info for audit logging
function getClientInfo(req) {
  return {
    ip: req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown',
    userAgent: req.headers['user-agent'] || 'unknown'
  };
}

function buildAgentName(userId, suffix = '') {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
  return `${userId}-agent-${suffix ? suffix + '-' : ''}${timestamp}`;
}

export const PROFILE_DEFAULT = 'default';
export const PROFILE_GPT = 'gpt';

// Merge an agent profile into userDoc.agentProfiles[key] without
// clobbering an existing per-profile apiKey. Used by both the primary
// (default / Deepseek) and secondary (gpt) provisioners so the chat
// router and My Agent UI can select by profile key.
function setAgentProfile(userDoc, key, fields) {
  if (!userDoc.agentProfiles || typeof userDoc.agentProfiles !== 'object') {
    userDoc.agentProfiles = {};
  }
  const now = new Date().toISOString();
  const prev = (userDoc.agentProfiles[key] && typeof userDoc.agentProfiles[key] === 'object')
    ? userDoc.agentProfiles[key]
    : {};
  userDoc.agentProfiles[key] = {
    ...prev,
    ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v != null && v !== '')),
    createdAt: prev.createdAt || now,
    updatedAt: now
  };
  if (!userDoc.agentProfileDefaultKey) userDoc.agentProfileDefaultKey = PROFILE_DEFAULT;
  if (!userDoc.deepLinkAgentOverrides || typeof userDoc.deepLinkAgentOverrides !== 'object') {
    userDoc.deepLinkAgentOverrides = {};
  }
}

async function saveUserDocWithRetry(cloudant, userId, mutateDoc, maxAttempts = 3) {
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    const freshDoc = await cloudant.getDocument('maia_users', userId);
    if (!freshDoc) {
      const notFound = new Error('User not found');
      notFound.statusCode = 404;
      throw notFound;
    }
    mutateDoc(freshDoc);
    try {
      const saved = await cloudant.saveDocument('maia_users', freshDoc);
      if (saved?.rev) freshDoc._rev = saved.rev;
      return freshDoc;
    } catch (error) {
      if (error?.statusCode === 409 && attempt < maxAttempts) {
        continue;
      }
      throw error;
    }
  }
  return null;
}

function isValidUUID(value) {
  if (!value || typeof value !== 'string') return false;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value.trim());
}

// Model identifier for the PRIMARY Private AI agent, matched against the
// DO catalog by inference_name / name / id. The SECONDARY agent (the
// historical 'gpt' profile slot) has no fixed model: the user chooses
// one from the DO-hosted, agent-capable catalog (utils/secondary-models.js).
// NOTE: profile keys 'default' and 'gpt' stay as historical identifiers
// (kept to avoid migrating every existing userDoc.agentProfiles[*].agentId).
export const MODEL_GPT = { inference_name: 'openai-gpt-oss-120b', name: 'OpenAI GPT-oss-120b', id: 'openai-gpt-oss-120b' };
export const MODEL_PRIMARY = MODEL_GPT;

const matchesModel = (m, spec) =>
  m.inference_name === spec.inference_name ||
  m.name === spec.name ||
  (spec.id && m.id === spec.id);

// DO project that new agents belong to: DO_PROJECT_ID, else an existing
// agent's project, else the account's GenAI project.
async function resolveProjectId(doClient) {
  let projectId = process.env.DO_PROJECT_ID;
  if (!isValidUUID(projectId)) {
    try {
      const agents = await doClient.agent.list();
      if (agents.length > 0) {
        const existingAgent = await doClient.agent.get(agents[0].uuid || agents[0].id);
        if (existingAgent.project_id && isValidUUID(existingAgent.project_id)) {
          projectId = existingAgent.project_id;
        }
      }
    } catch (error) {
      // Continue with fallback
    }
  }
  if (!isValidUUID(projectId)) {
    projectId = await getProjectIdForGenAI(doClient) || projectId;
  }
  return projectId;
}

// `modelSpec` selects which catalog model to resolve (the primary's by
// default). `process.env.DO_MODEL_ID` only applies to the primary agent.
// The secondary agent never comes through here: its model is the user's
// explicit choice, and the fallbacks below could silently substitute one.
async function resolveModelAndProject(doClient, modelSpec = MODEL_PRIMARY) {
  const isPrimary = modelSpec === MODEL_PRIMARY;
  let modelId = isPrimary ? process.env.DO_MODEL_ID : undefined;
  const projectId = await resolveProjectId(doClient);

  // PREFERRED PATH: look up the requested model in the DO catalog FIRST.
  // Only fall back to an existing agent's model if the catalog lookup
  // fails (fallback is primary-only — the GPT agent must use GPT).
  if (!isValidUUID(modelId)) {
    try {
      const modelsResponse = await doClient.request('/v2/gen-ai/models');
      const models = modelsResponse.models || modelsResponse.data?.models || [];
      if (models.length > 0) {
        const preferredModel = models.find(m => matchesModel(m, modelSpec));
        if (preferredModel && preferredModel.uuid && isValidUUID(preferredModel.uuid)) {
          modelId = preferredModel.uuid;
        }
      }
    } catch (error) {
      // Continue
    }
  }

  // FALLBACK: reuse an existing agent's model UUID (primary only —
  // never silently give the secondary agent the wrong model).
  if (!isValidUUID(modelId) && isPrimary) {
    try {
      const agents = await doClient.agent.list();
      if (agents.length > 0) {
        const existingAgent = await doClient.agent.get(agents[0].uuid || agents[0].id);
        if (existingAgent.model?.uuid && isValidUUID(existingAgent.model.uuid)) {
          modelId = existingAgent.model.uuid;
        }
      }
    } catch (error) {
      // Continue
    }
  }

  // LAST RESORT: first model in the catalog
  if (!isValidUUID(modelId)) {
    try {
      const modelsResponse = await doClient.request('/v2/gen-ai/models');
      const models = modelsResponse.models || modelsResponse.data?.models || [];
      if (models.length > 0 && models[0]?.uuid && isValidUUID(models[0].uuid)) {
        modelId = models[0].uuid;
      }
    } catch (error) {
      // Continue
    }
  }

  return { modelId, projectId };
}

function getMaiaInstructionText() {
  try {
    const newAgentFilePath = path.join(__dirname, '../../NEW-AGENT.txt');
    const fileContent = readFileSync(newAgentFilePath, 'utf-8');
    const marker = '## MAIA INSTRUCTION TEXT';
    const markerIndex = fileContent.indexOf(marker);
    if (markerIndex === -1) {
      return '';
    }
    const lines = fileContent.slice(markerIndex + marker.length).split('\n');
    let startIndex = lines.findIndex((line) => line.trim() && !line.trim().startsWith('##'));
    if (startIndex === -1) {
      startIndex = 0;
    }
    const contentLines = [];
    for (let i = startIndex; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim().startsWith('## ')) {
        break;
      }
      contentLines.push(line);
    }
    return contentLines.join('\n').trim();
  } catch (error) {
    console.warn('Unable to read NEW-AGENT.txt for agent instructions:', error.message);
    return '';
  }
}

function requireAdminSecretForUser(userId, adminSecret) {
  const adminUsername = (process.env.ADMIN_USERNAME || 'admin').trim();
  const uid = (userId && typeof userId === 'string') ? userId.trim().toLowerCase() : '';
  if (!adminUsername || uid !== adminUsername.toLowerCase()) {
    return { required: false, ok: true };
  }
  const configuredSecret = process.env.ADMIN_SECRET || process.env.DIGITALOCEAN_TOKEN;
  if (!configuredSecret) {
    return { required: true, ok: false, error: 'ADMIN_SECRET_NOT_CONFIGURED' };
  }
  if (!adminSecret) {
    return { required: true, ok: false, error: 'ADMIN_SECRET_REQUIRED' };
  }
  if (adminSecret !== configuredSecret) {
    return { required: true, ok: false, error: 'ADMIN_SECRET_INVALID' };
  }
  return { required: true, ok: true };
}

function getSetupWizardMessages() {
  try {
    const newAgentFilePath = path.join(__dirname, '../../NEW-AGENT.txt');
    const fileContent = readFileSync(newAgentFilePath, 'utf-8');
    const primaryMarker = '## Private AI Setup Wizard';
    const legacyMarker = '## PRIVATE AI SETUP WIZARD MESSAGES';
    let startIndex = fileContent.indexOf(primaryMarker);
    let mode = 'spec';
    if (startIndex === -1) {
      startIndex = fileContent.indexOf(legacyMarker);
      mode = 'legacy';
    }
    if (startIndex === -1) {
      return {};
    }
    const sliceStart = startIndex + (mode === 'spec' ? primaryMarker.length : legacyMarker.length);
    const lines = fileContent.slice(sliceStart).split('\n');
    const messages = {};
    let introLines = [];
    let seenChecklist = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (mode === 'spec' && !seenChecklist) {
          introLines.push('');
        }
        continue;
      }
      if (trimmed.startsWith('## ')) break;
      if (mode === 'spec') {
        if (!seenChecklist) {
          if (trimmed.startsWith('[ ]')) {
            seenChecklist = true;
          } else {
            introLines.push(line);
            continue;
          }
        }
      }
      let match = null;
      if (mode === 'spec') {
        match = trimmed.match(/^\[\s*\]\s*(\d+)\s*-\s*(.+)$/);
      } else {
        match = trimmed.match(/^(\d+)[).:\-]\s*(.+)$/);
      }
      if (match) {
        const stage = Number(match[1]);
        if (stage >= 1 && stage <= 4) {
          messages[stage] = match[2];
        }
      }
    }
    const intro = introLines.length > 0 ? introLines.join('\n') : null;
    return { messages, intro };
  } catch (error) {
    console.warn('Unable to read setup wizard messages:', error.message);
    return { messages: {}, intro: null };
  }
}

const agentStatusCache = new Map();
const TEMP_USER_COOKIE = 'maia_temp_user';
const TEMP_USER_COOKIE_MAX_AGE = 1000 * 60 * 60 * 24 * 7; // 7 days

// The temporary-account cookie is the ONLY credential of an account without
// a passkey, so it is SIGNED (cookie-parser with the session secret — an
// unsigned cookie could be set to any user id). A legacy unsigned cookie is
// honoured only together with a live session for the same user, and is then
// re-issued signed, so users signed in at upgrade time are not locked out.
const setTempCookie = (res, userId) => {
  res.cookie(TEMP_USER_COOKIE, userId, {
    maxAge: TEMP_USER_COOKIE_MAX_AGE,
    httpOnly: true,
    sameSite: 'lax',
    signed: true
  });
};
const readTempCookie = (req, res) => {
  const signed = req.signedCookies?.[TEMP_USER_COOKIE];
  if (typeof signed === 'string' && signed) return signed;
  const legacy = req.cookies?.[TEMP_USER_COOKIE];
  if (typeof legacy === 'string' && legacy && req.session?.userId === legacy) {
    if (res) setTempCookie(res, legacy);
    return legacy;
  }
  return null;
};
let cachedTempUserNames = null;
let tempUserNamesLoadFailed = false;

function getTempUserFirstNames() {
  try {
    if (cachedTempUserNames) {
      return cachedTempUserNames;
    }
    const newAgentFilePath = path.join(__dirname, '../..', 'NEW-AGENT.txt');
    const fileContent = readFileSync(newAgentFilePath, 'utf-8');
    const marker = '## Random Names';
    const startIndex = fileContent.indexOf(marker);
    if (startIndex === -1) {
      return [];
    }
    const lines = fileContent.slice(startIndex + marker.length).split('\n');
    const names = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('## ')) break;
      const firstName = trimmed.split(/\s+/)[0];
      if (firstName) names.push(firstName);
    }
    cachedTempUserNames = names;
    return cachedTempUserNames;
  } catch (error) {
    if (!tempUserNamesLoadFailed) {
      console.warn('Unable to read temp user names:', error.message);
      tempUserNamesLoadFailed = true;
    }
    return [];
  }
}

function pickRandomTempName() {
  const names = getTempUserFirstNames();
  if (!names.length) return 'Guest';
  const idx = Math.floor(Math.random() * names.length);
  return names[idx];
}

function formatTempUserId(name, suffix) {
  const base = name.toLowerCase().replace(/[^a-z]/g, '') || 'user';
  return `${base}${suffix}`;
}

// Per-user mutex to prevent concurrent agent creation (see Documentation/Wizards.md section 6)
const agentCreationLocks = new Map();

export async function ensureUserAgent(doClient, cloudant, userDoc) {
  if (!userDoc) return userDoc;
  const userId = userDoc.userId;
  if (!userId) return userDoc;
  // Saving a copy without _rev makes saveDocument borrow the latest one and
  // overwrite the account with this copy — erasing whatever was written
  // since it was read. Such a copy is stale: start from the stored one.
  if (!userDoc._rev) {
    const stored = await cloudant.getDocument('maia_users', userId);
    if (stored) userDoc = stored;
  }

  // Acquire per-user lock — if another call is already creating an agent,
  // wait for it to finish then re-read the user doc to get the result.
  if (agentCreationLocks.has(userId)) {
    try {
      await agentCreationLocks.get(userId);
    } catch { /* ignore — we'll re-read below */ }
    // Re-read user doc to pick up the agent created by the other call
    const freshDoc = await cloudant.getDocument('maia_users', userId);
    if (freshDoc?.assignedAgentId) {
      Object.assign(userDoc, freshDoc);
      return userDoc;
    }
  }

  let agent = null;
  if (userDoc.assignedAgentId) {
    try {
      agent = await doClient.agent.get(userDoc.assignedAgentId);
    } catch (error) {
      agent = null;
    }
  }

  // If no agent exists, create one while holding a per-user lock
  let needsCreation = !agent;
  if (needsCreation && !mayCreatePrimaryAgent(userDoc)) {
    // Personal AS edition: no agent before the email is verified. Callers
    // see a user without an agent, exactly as before the first creation.
    console.log(`[AGENT] Not creating an agent for ${userId} yet: email not verified (personal-as edition)`);
    return userDoc;
  }
  let lockResolve = null;
  if (needsCreation) {
    let lockReject;
    const lockPromise = new Promise((resolve, reject) => { lockResolve = resolve; lockReject = reject; });
    // Always consume a rejection so a creation failure (e.g. a DO API
    // timeout) can never become an unhandled rejection that crashes the
    // whole Node process. Waiters still await this same promise and
    // catch the rejection themselves.
    lockPromise.catch(() => {});
    agentCreationLocks.set(userId, lockPromise);

    try {
      const { modelId, projectId } = await resolveModelAndProject(doClient);
      if (!isValidUUID(modelId) || !isValidUUID(projectId)) {
        throw new Error('Unable to resolve model or project ID for agent creation');
      }

      const instruction = getMaiaInstructionText();
      const agentName = buildAgentName(userId);
      agent = await doClient.agent.create({
        name: agentName,
        instruction,
        modelId: modelId.trim(),
        projectId: projectId.trim(),
        region: getDoRegion(),
        maxTokens: 32768,
        topP: 1,
        temperature: 0.1,
        k: 15,
        retrievalMethod: 'RETRIEVAL_METHOD_REWRITE'
      });
    } catch (err) {
      agentCreationLocks.delete(userId);
      lockReject(err);
      throw err;
    }
  }

  const resolvedAgent = await doClient.agent.get(agent.uuid || agent.id);
  const endpoint = resolvedAgent?.deployment?.url ? `${resolvedAgent.deployment.url}/api/v1` : null;
  userDoc.assignedAgentId = resolvedAgent.uuid || resolvedAgent.id;
  userDoc.assignedAgentName = resolvedAgent.name || userDoc.assignedAgentName;
  userDoc.agentEndpoint = endpoint || userDoc.agentEndpoint || null;
  userDoc.agentModelName = resolvedAgent.model?.inference_name || resolvedAgent.model?.name || userDoc.agentModelName || null;
  if (!WIZARD_DONE_STAGES_AUTH.has(userDoc.workflowStage)) {
    userDoc.workflowStage = endpoint ? 'agent_deployed' : 'agent_named';
  }
  userDoc.agentSetupInProgress = !endpoint;
  userDoc.updatedAt = new Date().toISOString();
  // Mirror the primary agent into the 'default' profile so the chat
  // router / My Agent UI can address it by profile key uniformly.
  setAgentProfile(userDoc, PROFILE_DEFAULT, {
    agentId: userDoc.assignedAgentId,
    agentName: userDoc.assignedAgentName,
    endpoint: userDoc.agentEndpoint,
    modelName: userDoc.agentModelName
  });

  // Save with conflict retry
  let saved = false;
  let retries = 3;
  while (!saved && retries > 0) {
    try {
      await cloudant.saveDocument('maia_users', userDoc);
      saved = true;
    } catch (error) {
      if ((error.statusCode === 409 || error.error === 'conflict') && retries > 1) {
        retries -= 1;
        userDoc = await cloudant.getDocument('maia_users', userId);
        userDoc.assignedAgentId = resolvedAgent.uuid || resolvedAgent.id;
        userDoc.assignedAgentName = resolvedAgent.name || userDoc.assignedAgentName;
        userDoc.agentEndpoint = endpoint || userDoc.agentEndpoint || null;
        userDoc.agentModelName = resolvedAgent.model?.inference_name || resolvedAgent.model?.name || userDoc.agentModelName || null;
        if (!WIZARD_DONE_STAGES_AUTH.has(userDoc.workflowStage)) {
          userDoc.workflowStage = endpoint ? 'agent_deployed' : 'agent_named';
        }
        userDoc.agentSetupInProgress = !endpoint;
        userDoc.updatedAt = new Date().toISOString();
        setAgentProfile(userDoc, PROFILE_DEFAULT, {
          agentId: userDoc.assignedAgentId,
          agentName: userDoc.assignedAgentName,
          endpoint: userDoc.agentEndpoint,
          modelName: userDoc.agentModelName
        });
      } else {
        throw error;
      }
    }
  }

  // Release lock so waiting callers pick up the saved agent
  if (needsCreation && lockResolve) {
    agentCreationLocks.delete(userId);
    lockResolve();
  }
  return userDoc;
}

// The SECONDARY Private AI agent, recorded under userDoc.agentProfiles.gpt
// (profile key kept for historical reasons — see MODEL_GPT comment above).
//
// It is NEVER created automatically. The model is the user's choice
// (Workbook → AI Agents), validated against the DO-hosted, agent-capable
// catalog in utils/secondary-models.js:
//  - with `model`: create the agent with that model, or SWITCH an existing
//    agent to it (a new agent is created with the old agent's instructions,
//    the profile is repointed, then the old agent is deleted);
//  - without `model`: REPAIR only — reuse the live agent, or recreate a
//    destroyed one with the model the user chose before. Throws
//    SECONDARY_NOT_CHOSEN when there is no choice to repair, and
//    SECONDARY_MODEL_UNAVAILABLE when that model has left the catalog.
// The user's knowledge base is attached: KB-1 unless the user disconnected
// it from this agent, KB-2 when they connected it (userDoc.kbConnections).
export class SecondaryAgentError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

async function attachSecondaryKbs(doClient, userDoc, agentId) {
  const conns = userDoc.kbConnections?.[PROFILE_GPT] || {};
  const attach = async (kbId) => {
    try {
      await doClient.agent.attachKB(agentId, kbId);
      return true;
    } catch (e) {
      const msg = String(e?.message || '');
      if (msg.includes('already') || msg.includes('409')) return true;
      console.warn(`[secondary-agent] attachKB(${kbId}) to ${agentId} failed: ${msg}`);
      return false;
    }
  };
  let kbAttachedId = null;
  if (userDoc.kbId && conns.kb1 !== false && await attach(userDoc.kbId)) kbAttachedId = userDoc.kbId;
  if (userDoc.kb2?.kbId && conns.kb2 === true) await attach(userDoc.kb2.kbId);
  return kbAttachedId;
}

export async function ensureSecondaryAgent(doClient, cloudant, userDoc, { model = null } = {}) {
  if (!userDoc) return userDoc;
  const userId = userDoc.userId;
  if (!userId) return userDoc;

  const lockKey = `${userId}:${PROFILE_GPT}`;
  if (agentCreationLocks.has(lockKey)) {
    try { await agentCreationLocks.get(lockKey); } catch { /* re-read below */ }
    const freshDoc = await cloudant.getDocument('maia_users', userId);
    const fp = freshDoc?.agentProfiles?.[PROFILE_GPT];
    if (fp?.agentId && (!model || fp.modelId === model.id)) {
      Object.assign(userDoc, freshDoc);
      return userDoc;
    }
    if (freshDoc) Object.assign(userDoc, freshDoc);
  }

  const prev = userDoc.agentProfiles?.[PROFILE_GPT] || {};
  let agent = null;
  if (prev.agentId) {
    try { agent = await doClient.agent.get(prev.agentId); } catch { agent = null; }
  }
  const currentModelId = prev.modelId || agent?.model?.inference_name || prev.modelName || null;
  const switching = !!(agent && model && model.id !== currentModelId);

  let target = model;
  if (!agent && !target) {
    const priorId = prev.modelId || prev.modelName;
    if (!priorId) {
      throw new SecondaryAgentError('SECONDARY_NOT_CHOSEN', 'No secondary Private AI model has been chosen');
    }
    target = await resolveSecondaryModel(doClient, priorId);
    if (!target) {
      throw new SecondaryAgentError('SECONDARY_MODEL_UNAVAILABLE',
        `The secondary Private AI model chosen before (${priorId}) is no longer available`);
    }
  }

  const needsCreation = !agent || switching;
  let lockResolve = null;
  let replacedAgentId = null;
  if (needsCreation) {
    let lockReject;
    const lockPromise = new Promise((resolve, reject) => { lockResolve = resolve; lockReject = reject; });
    // Never let a creation failure become an unhandled rejection (would
    // crash the whole process — every endpoint then 500s).
    lockPromise.catch(() => {});
    agentCreationLocks.set(lockKey, lockPromise);
    try {
      const projectId = await resolveProjectId(doClient);
      if (!isValidUUID(target?.uuid) || !isValidUUID(projectId)) {
        throw new Error('Unable to resolve secondary model or project ID for agent creation');
      }
      // A model switch keeps the user's own instructions for this agent.
      let instruction = 'Do not hallucinate.';
      if (switching) {
        replacedAgentId = agent.uuid || agent.id;
        if (typeof agent.instruction === 'string' && agent.instruction.trim()) instruction = agent.instruction;
      }
      agent = await doClient.agent.create({
        name: buildAgentName(userId, 'gpt'),
        instruction,
        modelId: target.uuid,
        projectId: projectId.trim(),
        region: getDoRegion(),
        // Most catalog models cap output at 8,192 tokens; never ask for more.
        maxTokens: Math.min(32768, target.maxOutputTokens || 32768),
        topP: 1,
        temperature: 0.1,
        k: 15,
        retrievalMethod: 'RETRIEVAL_METHOD_REWRITE'
      });
    } catch (err) {
      agentCreationLocks.delete(lockKey);
      lockReject(err);
      throw err;
    }
  }

  const resolved = await doClient.agent.get(agent.uuid || agent.id);
  const endpoint = resolved?.deployment?.url ? `${resolved.deployment.url}/api/v1` : null;
  const gptAgentId = resolved.uuid || resolved.id;
  const kbAttachedId = await attachSecondaryKbs(doClient, userDoc, gptAgentId);

  let saved = false;
  let retries = 3;
  while (!saved && retries > 0) {
    if (needsCreation) {
      // A new agent starts a fresh profile: the replaced agent's endpoint,
      // API key and deploy markers must not carry over.
      const keep = userDoc.agentProfiles?.[PROFILE_GPT]?.createdAt;
      userDoc.agentProfiles = { ...(userDoc.agentProfiles || {}), [PROFILE_GPT]: keep ? { createdAt: keep } : {} };
    }
    setAgentProfile(userDoc, PROFILE_GPT, {
      agentId: gptAgentId,
      agentName: resolved.name,
      endpoint,
      modelName: resolved.model?.inference_name || target?.id || prev.modelName,
      modelId: target?.id || prev.modelId || resolved.model?.inference_name,
      modelDisplayName: target?.name || prev.modelDisplayName || resolved.model?.name,
      kbAttachedId
    });
    userDoc.updatedAt = new Date().toISOString();
    try {
      await cloudant.saveDocument('maia_users', userDoc);
      saved = true;
    } catch (error) {
      if ((error.statusCode === 409 || error.error === 'conflict') && retries > 1) {
        retries -= 1;
        userDoc = await cloudant.getDocument('maia_users', userId);
      } else {
        if (needsCreation && lockResolve) { agentCreationLocks.delete(lockKey); lockResolve(); }
        throw error;
      }
    }
  }

  if (needsCreation && lockResolve) {
    agentCreationLocks.delete(lockKey);
    lockResolve();
  }

  // Only after the profile points at the new agent: remove the old one.
  if (replacedAgentId) {
    try {
      await doClient.agent.delete(replacedAgentId);
    } catch (e) {
      console.warn(`[secondary-agent] could not delete replaced agent ${replacedAgentId}: ${e?.message || e}`);
    }
  }
  return userDoc;
}

export default function setupAuthRoutes(app, passkeyService, cloudant, doClient, auditLog, { invalidateResourceCache } = {}) {
  // Check if user exists and has passkey
  app.get('/api/passkey/check-user', async (req, res) => {
    try {
      const { userId } = req.query;

      if (!userId) {
        return res.status(400).json({ error: 'User ID required' });
      }

      const adminUsername = (process.env.ADMIN_USERNAME || 'admin').trim();
      const uid = (userId && typeof userId === 'string') ? userId.trim().toLowerCase() : '';
      const isAdminUser = !!adminUsername && uid === adminUsername.toLowerCase();

      try {
        const userDoc = await cloudant.getDocument('maia_users', userId);
        res.json({
          exists: true,
          hasPasskey: !!userDoc.credentialID,
          isAdminUser
        });
      } catch (error) {
        // User doesn't exist
        res.json({
          exists: false,
          hasPasskey: false,
          isAdminUser
        });
      }
    } catch (error) {
      console.error('Check user error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Passkey registration - generate options
  app.post('/api/passkey/register', async (req, res) => {
    try {
      const { userId, displayName, adminSecret } = req.body;

      if (!userId || !displayName) {
        return res.status(400).json({ error: 'User ID and display name required' });
      }

      const adminSecretCheck = requireAdminSecretForUser(userId, adminSecret);
      if (adminSecretCheck.required && !adminSecretCheck.ok) {
        const code = adminSecretCheck.error;
        console.warn(`[Passkey] Admin registration 403 for userId=${userId}: ${code}`);
        const message =
          code === 'ADMIN_SECRET_NOT_CONFIGURED'
            ? 'Admin passkey is not configured. Set ADMIN_SECRET or DIGITALOCEAN_TOKEN on the server.'
            : code === 'ADMIN_SECRET_REQUIRED'
              ? 'Admin secret required to create or update the admin passkey.'
              : 'Invalid admin secret.';
        return res.status(403).json({
          error: message,
          errorCode: code
        });
      }

      // Check if user already exists
      const existingUser = await cloudant.getDocument('maia_users', userId);
      // Personal AS edition: accounts are created only by GET STARTED, with a
      // verified email; a passkey is then added to that account.
      if (!existingUser && !adminSecretCheck.required && getEdition() === 'personal-as') {
        return res.status(403).json({
          error: 'Create your MAIA with GET STARTED first, then add a passkey.',
          code: 'START_WITH_EMAIL'
        });
      }
      if (existingUser && existingUser.credentialID && !adminSecretCheck.required) {
        return res.status(400).json({ 
          error: 'User already has a passkey',
          hasExistingPasskey: true
        });
      }
      // Adding a passkey to an EXISTING account (a temporary account without
      // one) requires proof that the caller owns it — otherwise anyone could
      // attach their own passkey to someone else's account and lock them out.
      if (existingUser && !existingUser.credentialID && !adminSecretCheck.required) {
        const proven = req.session?.userId === userId || readTempCookie(req, res) === userId;
        if (!proven) {
          return res.status(403).json({ error: 'Sign in to this account before adding a passkey', code: 'NOT_ACCOUNT_OWNER' });
        }
      }

      // Generate registration options
      const options = await passkeyService.generateRegistrationOptions({
        userId,
        displayName
      });

      // Store challenge in user document
      const userDoc = existingUser || {
        _id: userId,
        userId,
        displayName,
        email: null,
        domain: passkeyService.rpID,
        type: 'user',
        workflowStage: null,
        createdAt: new Date().toISOString()
      };

      userDoc.challenge = options.challenge;
      userDoc.updatedAt = new Date().toISOString();

      await cloudant.saveDocument('maia_users', userDoc);

      res.json(options);
    } catch (error) {
      console.error(`[Passkey] Registration options error for userId=${req.body?.userId}:`, error?.message || error);
      res.status(500).json({ error: error.message || 'Registration failed' });
    }
  });

  // Passkey registration - verify
  app.post('/api/passkey/register-verify', async (req, res) => {
    try {
      const { userId, response, adminSecret } = req.body;

      if (!userId || !response) {
        return res.status(400).json({ error: 'User ID and response required' });
      }

      const adminSecretCheck = requireAdminSecretForUser(userId, adminSecret);
      if (adminSecretCheck.required && !adminSecretCheck.ok) {
        const code = adminSecretCheck.error;
        console.warn(`[Passkey] Admin verify 403 for userId=${userId}: ${code}`);
        return res.status(403).json({
          error: code === 'ADMIN_SECRET_NOT_CONFIGURED'
            ? 'Admin passkey is not configured. Set ADMIN_SECRET or DIGITALOCEAN_TOKEN on the server.'
            : code === 'ADMIN_SECRET_REQUIRED'
              ? 'Admin secret required to verify the admin passkey.'
              : 'Invalid admin secret.',
          errorCode: code
        });
      }

      // Get user document with challenge
      const userDoc = await cloudant.getDocument('maia_users', userId);
      if (!userDoc || !userDoc.challenge) {
        return res.status(400).json({ error: 'No registration challenge found' });
      }

      let expectedOrigin = null;
      try {
        expectedOrigin = passkeyService.resolveExpectedOrigin(req.get('origin'));
      } catch (error) {
        return res.status(403).json({ error: 'Origin not allowed' });
      }

      // Verify registration
      const result = await passkeyService.verifyRegistration({
        response,
        expectedChallenge: userDoc.challenge,
        userDoc,
        expectedOrigin
      });

      if (!result.verified) {
        return res.status(400).json({ error: 'Registration verification failed' });
      }

      // Save the credential on a fresh copy of the account. ensureUserAgent
      // saves only its own agent fields when it has to retry, and saves
      // nothing when another request is creating the agent — the new
      // passkey must not ride on either.
      console.log(`[NEW FLOW 2] Passkey verified; minimal user setup for ${userId}`);
      const updatedUser = await saveUserDocWithRetry(cloudant, userId, (doc) => {
        Object.assign(doc, result.credentialInfo);
        delete doc.challenge;
        doc.workflowStage = 'active';
        doc.initialFile = null;
        doc.temporaryAccount = false;
        doc.updatedAt = new Date().toISOString();
      });

      const agentReadyUser = await ensureUserAgent(doClient, cloudant, updatedUser);
      console.log(`[NEW FLOW 2] ✅ User document saved (agent ready)`);

      // Set session
      req.session.userId = agentReadyUser.userId;
      req.session.username = agentReadyUser.userId;
      req.session.displayName = agentReadyUser.displayName;
      req.session.isTemporary = false;
      req.session.authenticatedAt = new Date().toISOString();
      req.session.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      // Log passkey registration
      const clientInfo = getClientInfo(req);
      await auditLog.logEvent({
        type: 'passkey_registered',
        userId: agentReadyUser.userId,
        ip: clientInfo.ip,
        userAgent: clientInfo.userAgent
      });

      console.log(`[NEW FLOW 2] Passkey registration logged for ${updatedUser.userId}`);
      console.log(`[NEW FLOW 2] Ready to show app UI - no provisioning steps`);

      // Clear temp cookie — passkey users no longer need it
      res.clearCookie(TEMP_USER_COOKIE);

      // Return success with flag indicating file import dialog should be shown
      // The frontend will handle showing the dialog and uploading files
      const isAdminUser = agentReadyUser.userId?.toLowerCase() === (process.env.ADMIN_USERNAME || 'admin').trim()?.toLowerCase();
      res.json({
        success: true,
        user: {
          userId: agentReadyUser.userId,
          displayName: agentReadyUser.displayName,
          isTemporary: false,
          isAdmin: isAdminUser
        },
        showFileImport: false
      });
    } catch (error) {
      console.error('Registration verify error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Registration complete - legacy endpoint (no initial import)
  app.post('/api/passkey/registration-complete', async (req, res) => {
    try {
      const { userId } = req.body;

      if (!userId) {
        return res.status(400).json({ error: 'User ID required' });
      }

      console.log(`[NEW FLOW 2] Completing registration for user: ${userId}`);

      // Get user document
      const userDoc = await cloudant.getDocument('maia_users', userId);
      if (!userDoc) {
        return res.status(404).json({ error: 'User not found' });
      }

      userDoc.workflowStage = 'active';
      userDoc.initialFile = null;

      await cloudant.saveDocument('maia_users', userDoc);
      console.log(`[NEW FLOW 2] User document updated - no admin provisioning`);

      const isAdminUser = userDoc.userId?.toLowerCase() === (process.env.ADMIN_USERNAME || 'admin').trim()?.toLowerCase();
      res.json({ 
        success: true, 
        user: {
          userId: userDoc.userId,
          displayName: userDoc.displayName,
          isAdmin: isAdminUser
        }
      });
    } catch (error) {
      console.error('[NEW FLOW 2] Registration complete error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Passkey authentication - generate options
  app.post('/api/passkey/authenticate', async (req, res) => {
    try {
      const { userId } = req.body;

      if (!userId) {
        return res.status(400).json({ error: 'User ID required' });
      }

      // Get user document
      const userDoc = await cloudant.getDocument('maia_users', userId);
      if (!userDoc || !userDoc.credentialID) {
        return res.status(404).json({ error: 'User not found or no passkey registered' });
      }

      // Generate authentication options
      const options = await passkeyService.generateAuthenticationOptions({
        userId,
        userDoc
      });

      // Store challenge
      userDoc.challenge = options.challenge;
      await cloudant.saveDocument('maia_users', userDoc);

      res.json(options);
    } catch (error) {
      console.error('Authentication options error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Passkey authentication - verify
  app.post('/api/passkey/authenticate-verify', async (req, res) => {
    try {
      const { userId, response } = req.body;

      if (!userId || !response) {
        return res.status(400).json({ error: 'User ID and response required' });
      }

      // Get user document with challenge
      const userDoc = await cloudant.getDocument('maia_users', userId);
      if (!userDoc || !userDoc.challenge) {
        return res.status(400).json({ error: 'No authentication challenge found' });
      }

      let expectedOrigin = null;
      try {
        expectedOrigin = passkeyService.resolveExpectedOrigin(req.get('origin'));
      } catch (error) {
        return res.status(403).json({ error: 'Origin not allowed' });
      }

      // Verify authentication
      const result = await passkeyService.verifyAuthentication({
        response,
        expectedChallenge: userDoc.challenge,
        userDoc,
        expectedOrigin
      });

      const clientInfo = getClientInfo(req);

      if (!result.verified) {
        // Log failed login attempt
        await auditLog.logEvent({
          type: 'login_failure',
          userId: userId,
          ip: clientInfo.ip,
          userAgent: clientInfo.userAgent,
          details: 'Passkey verification failed'
        });
        return res.status(400).json({ error: 'Authentication verification failed' });
      }

      // Update counter
      // Save the new counter on a fresh copy (see register-verify).
      const newCounter = result.userDoc?.counter;
      const updatedUser = await saveUserDocWithRetry(cloudant, userId, (doc) => {
        if (newCounter !== undefined) doc.counter = newCounter;
        delete doc.challenge;
        doc.updatedAt = new Date().toISOString();
      });
      const agentReadyUser = await ensureUserAgent(doClient, cloudant, updatedUser);

      // Set session
      req.session.userId = agentReadyUser.userId;
      req.session.username = agentReadyUser.userId;
      req.session.displayName = agentReadyUser.displayName;
      req.session.isTemporary = !!agentReadyUser.temporaryAccount;
      req.session.authenticatedAt = new Date().toISOString();
      req.session.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      // Log successful login
      await auditLog.logEvent({
        type: 'login_success',
        userId: agentReadyUser.userId,
        ip: clientInfo.ip,
        userAgent: clientInfo.userAgent
      });

      // Clear temp cookie — passkey users no longer need it
      res.clearCookie(TEMP_USER_COOKIE);

      const isAdminUser = agentReadyUser.userId?.toLowerCase() === (process.env.ADMIN_USERNAME || 'admin').trim()?.toLowerCase();
      res.json({
        success: true,
        user: {
          userId: agentReadyUser.userId,
          displayName: agentReadyUser.displayName,
          isTemporary: !!agentReadyUser.temporaryAccount,
          isAdmin: isAdminUser
        }
      });
    } catch (error) {
      console.error('Authentication verify error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Sign out
  app.post('/api/sign-out', async (req, res) => {
    const userId = req.session?.userId;
    const clientInfo = getClientInfo(req);

    // Stamp lastActivity on user doc before destroying session (so admin can show it)
    if (userId) {
      try {
        const userDoc = await cloudant.getDocument('maia_users', userId);
        if (userDoc) {
          userDoc.lastActivity = new Date().toISOString();
          await cloudant.saveDocument('maia_users', userDoc);
        }
      } catch (e) {
        console.warn(`[SIGN-OUT] Failed to stamp lastActivity on ${userId}:`, e.message);
      }
    }

    req.session.destroy(async (err) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to sign out' });
      }
      try {
        res.clearCookie('maia_deep_link_user');
        // The signed temp cookie is KEPT: for an account without a passkey it
        // is the only proof that lets this browser reopen the account later
        // ("keeps your account for later — you can restore it on this
        // device"). Forgetting the device or deleting the account clears it
        // (/api/auth/clear-temp-cookie); a passkey replaces it.
      } catch (cookieError) {
        console.warn('Unable to clear deep-link cookie on sign-out:', cookieError);
      }
      
      // Log logout
      if (userId) {
        await auditLog.logEvent({
          type: 'logout',
          userId: userId,
          ip: clientInfo.ip,
          userAgent: clientInfo.userAgent
        });
      }
      
      res.json({ success: true });
    });
  });

  // Clear the httpOnly temp-user cookie (used when deleting local storage)
  app.post('/api/auth/clear-temp-cookie', (req, res) => {
    res.clearCookie(TEMP_USER_COOKIE);
    res.json({ success: true });
  });

  // Check if an agent exists for a previous temporary userId
  app.get('/api/agent-exists', async (req, res) => {
    try {
      const userId = req.query?.userId;
      if (!userId || typeof userId !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'User ID is required'
        });
      }

      const [agent, userDoc] = await Promise.all([
        findUserAgent(doClient, userId).catch(() => null),
        cloudant.getDocument('maia_users', userId).catch(() => null)
      ]);
      const agentExists = !!agent;

      // Saved files count: exclude References folder (matches Saved Files tab logic)
      const allFiles = Array.isArray(userDoc?.files) ? userDoc.files : [];
      const referencesPath = `${userId}/References/`;
      const savedFiles = allFiles.filter(f => {
        const bk = f.bucketKey || '';
        return !bk.startsWith(referencesPath) && f.isReference !== true;
      });
      const savedFileCount = savedFiles.length;

      // KB exists: userDoc has a kbId or connectedKBs
      const kbExists = !!(userDoc?.kbId || (Array.isArray(userDoc?.connectedKBs) && userDoc.connectedKBs.length > 0));

      // Agent linked to KB: agent exists AND kbId is set AND agent has an endpoint
      const agentLinkedToKb = agentExists && kbExists && !!userDoc?.agentEndpoint;

      // "Wizard complete" here answers ONE question for the welcome card:
      // does this account need RESTORING? That is true only when the core
      // cloud resource — the agent + endpoint — is gone (the sign-out
      // "delete everything in the cloud" case). Anything else the account
      // might lack (KB for the quick-start tier, records not yet uploaded,
      // meds/summary not yet verified) is wizard CONTINUATION, reachable by
      // simply re-entering the account — the wizard rail icon's attention
      // triangle takes it from there. Requiring a KB here mislabeled every
      // quick-start account (no KB by explicit choice) and every mid-wizard
      // account as "needs restoring" after sign-out.
      const wizardComplete = agentExists && !!userDoc?.agentEndpoint;

      console.log(`[WELCOME] agent-exists for ${userId}: agent=${agentExists}, savedFiles=${savedFileCount}/${allFiles.length}, kb=${kbExists}, linked=${agentLinkedToKb}, wizardDone=${wizardComplete}, stage=${userDoc?.workflowStage || 'none'}`);

      res.json({
        success: true,
        exists: agentExists,
        // The cloud account itself (the Personal AS welcome card uses this:
        // an account without a ready agent continues into the setup
        // checklist; it doesn't need restoring).
        accountExists: !!userDoc,
        agentName: agent?.name || null,
        agentId: agent?.uuid || agent?.id || null,
        savedFileCount,
        cloudFileCount: allFiles.length,
        kbExists,
        agentLinkedToKb,
        wizardComplete,
        workflowStage: userDoc?.workflowStage || null
      });
    } catch (error) {
      console.error('Agent lookup failed:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to lookup agent'
      });
    }
  });

  // Deep link share status for signed-in user
  app.get('/api/user-deep-links', async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'User not authenticated',
          error: 'NOT_AUTHENTICATED'
        });
      }

      const userDoc = await cloudant.getDocument('maia_users', userId);
      if (!userDoc) {
        return res.status(404).json({
          success: false,
          message: 'User not found',
          error: 'USER_NOT_FOUND'
        });
      }

      const shareIds = Array.isArray(userDoc.deepLinkShareIds) ? userDoc.deepLinkShareIds : [];
      res.json({
        success: true,
        count: shareIds.length,
        shareIds
      });
    } catch (error) {
      console.error('Deep link lookup failed:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to read deep link status'
      });
    }
  });

  // Dormant account - delete KB, keep agent
  app.post('/api/account/dormant', async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'User not authenticated',
          error: 'NOT_AUTHENTICATED'
        });
      }

      const userDoc = await cloudant.getDocument('maia_users', userId);
      if (!userDoc) {
        return res.status(404).json({
          success: false,
          message: 'User not found',
          error: 'USER_NOT_FOUND'
        });
      }

      // Preserve KB and all cloud resources — don't delete anything.
      // The user may return and resume with the same KB, agent, and files.
      userDoc.dormantAccount = true;
      userDoc.dormantAt = new Date().toISOString();
      userDoc.updatedAt = new Date().toISOString();

      await cloudant.saveDocument('maia_users', userDoc);

      res.json({
        success: true,
        kbPreserved: !!userDoc.kbId
      });
    } catch (error) {
      console.error('Dormant account error:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to set account dormant',
        error: 'DORMANT_FAILED'
      });
    }
  });

  // Recreate a destroyed account (user doc deleted but local folder has state)
  app.post('/api/account/recreate', async (req, res) => {
    try {
      const { userId, displayName } = req.body || {};
      console.log(`[RECREATE] /api/account/recreate called for userId=${userId}`);
      if (!userId || typeof userId !== 'string') {
        return res.status(400).json({ success: false, error: 'userId required' });
      }
      if (userId.trim().toLowerCase() === String(process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase()) {
        return res.status(403).json({ success: false, error: 'RESERVED_USER_ID' });
      }

      // Only a DESTROYED account can be recreated (restore from the local
      // folder backup). An existing account is never signed into from here:
      // this route has no proof of ownership, so doing so let anyone take
      // over any account by naming it. Existing accounts sign in with their
      // passkey or their (signed) temporary-account cookie.
      let existing = null;
      try { existing = await cloudant.getDocument('maia_users', userId); } catch { existing = null; }
      if (existing) {
        return res.status(409).json({
          success: false,
          error: 'ACCOUNT_EXISTS',
          hasPasskey: !!existing.credentialID,
          message: existing.credentialID
            ? 'This account still exists — sign in with its passkey.'
            : 'This account still exists — sign in from the browser that created it.'
        });
      }

      // Recreate the user doc with the same userId
      // Generate kbName up front so RestoreWizard and update-knowledge-base
      // use the same name (see Documentation/Wizards.md section 5)
      const dateStr = new Date().toISOString().replace(/[-:]/g, '').split('T')[0];
      const kbName = `${userId}-kb-${dateStr}${Date.now().toString().slice(-6)}`;
      const userDoc = {
        _id: userId,
        userId,
        displayName: displayName || userId,
        email: null,
        domain: passkeyService.rpID,
        type: 'user',
        workflowStage: 'active',
        temporaryAccount: true,
        kbName,
        restoredAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await cloudant.saveDocument('maia_users', userDoc);
      // Invalidate the resource cache so /api/sync-agent sees the new doc immediately
      if (invalidateResourceCache) invalidateResourceCache(userId);
      console.log(`[RECREATE] User doc recreated for ${userId} with kbName=${kbName}`);

      // Sign them in
      req.session.userId = userId;
      req.session.username = userId;
      req.session.displayName = userDoc.displayName;
      req.session.isTemporary = true;
      req.session.authenticatedAt = new Date().toISOString();
      req.session.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      setTempCookie(res, userId);

      res.json({
        success: true,
        authenticated: true,
        recreated: true,
        kbName,
        user: {
          userId,
          displayName: userDoc.displayName,
          isTemporary: true
        }
      });
    } catch (error) {
      console.error('[RECREATE] Error:', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to recreate account' });
    }
  });

  // Temporary user start (cookie-backed)
  // Welcome-form support (modal-free setup): suggest an available MAIA ID
  // so the form can SHOW the ID the user will get before GET STARTED.
  app.get('/api/temporary/suggested-id', async (req, res) => {
    try {
      for (let i = 0; i < 10; i++) {
        const name = pickRandomTempName();
        const suffix = String(Math.floor(Math.random() * 100)).padStart(2, '0');
        const candidate = formatTempUserId(name, suffix);
        const existing = await cloudant.getDocument('maia_users', candidate).catch(() => null);
        if (!existing) return res.json({ success: true, userId: candidate });
      }
      res.status(503).json({ success: false, error: 'NO_ID_AVAILABLE' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/temporary/start', async (req, res) => {
    try {
      const forceNew = req.body?.forceNew === true;
      // Welcome-form extras: the pre-shown MAIA ID (best-effort — falls
      // back to generation on conflict) and an optional notification email.
      const desiredUserId = (typeof req.body?.desiredUserId === 'string'
        && /^[a-z]{2,24}[0-9]{2}$/.test(req.body.desiredUserId)) ? req.body.desiredUserId : null;
      const notifyEmail = (typeof req.body?.email === 'string'
        && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.body.email.trim())) ? req.body.email.trim() : null;
      const emailVerifyToken = (typeof req.body?.emailVerifyToken === 'string'
        && /^[a-f0-9]{32}$/.test(req.body.emailVerifyToken)) ? req.body.emailVerifyToken : null;
      const cookieUserId = readTempCookie(req, res);
      if (cookieUserId && !forceNew) {
        try {
          const existingUser = await cloudant.getDocument('maia_users', cookieUserId);
          if (existingUser?.credentialID) {
            return res.json({
              authenticated: false,
              requiresPasskey: true,
              user: {
                userId: existingUser.userId,
                displayName: existingUser.displayName || existingUser.userId
              }
            });
          }
          if (existingUser?.temporaryAccount) {
            req.session.userId = existingUser.userId;
            req.session.username = existingUser.userId;
            req.session.displayName = existingUser.displayName || existingUser.userId;
            req.session.isTemporary = true;
            req.session.authenticatedAt = new Date().toISOString();
            req.session.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
            setTempCookie(res, existingUser.userId);
            return res.json({
              authenticated: true,
              user: {
                userId: existingUser.userId,
                displayName: existingUser.displayName || existingUser.userId,
                isTemporary: true
              }
            });
          }
        } catch (error) {
          // User doc not found (404) — account was destroyed.
          // Signal the client so it can offer a restore from local folder.
          if (error.statusCode === 404) {
            return res.json({
              authenticated: false,
              destroyed: true,
              destroyedUserId: cookieUserId,
              message: 'Account was previously destroyed. Restore from local backup?'
            });
          }
          // Other errors: fall through to create a new user
        }
      }

      // Personal AS edition: a new account needs a verified email (§5 row 1,
      // closing the §1.2 gap). Returning to an existing temporary account
      // (the cookie path above) is unaffected.
      if (getEdition() === 'personal-as' && !(notifyEmail && isEmailVerified(emailVerifyToken, notifyEmail))) {
        return res.status(400).json({
          authenticated: false,
          error: 'EMAIL_VERIFICATION_REQUIRED',
          message: 'Verify your email address to create your MAIA.'
        });
      }

      let userId = null;
      let displayName = null;
      let userDoc = null;
      let attempts = 0;
      let useDesired = !!desiredUserId;
      while (!userId && attempts < 30) {
        attempts += 1;
        const name = pickRandomTempName();
        const suffix = String(Math.floor(Math.random() * 100)).padStart(2, '0');
        const candidateId = useDesired ? desiredUserId : formatTempUserId(name, suffix);
        const candidateDisplayName = useDesired ? desiredUserId : `${name}${suffix}`;
        useDesired = false; // one shot; conflicts fall back to generation
        const dateStr = new Date().toISOString().replace(/[-:]/g, '').split('T')[0];
        const candidateKbName = `${candidateId}-kb-${dateStr}${Date.now().toString().slice(-6)}`;
        // Promote a token-verified email (welcome onboarding): if the visitor
        // verified THIS address before signing up, stamp it verified. A
        // verified notification email is the account holder's to keep,
        // regardless of group membership.
        const emailIsVerified = !!(notifyEmail && isEmailVerified(emailVerifyToken, notifyEmail));
        const candidateDoc = {
          _id: candidateId,
          userId: candidateId,
          displayName: candidateDisplayName,
          email: notifyEmail,
          ...(emailIsVerified ? { emailVerified: true, emailVerifiedAt: new Date().toISOString() } : {}),
          // Record the verification in the persistent log (surfaces in maia-log).
          provisioningLog: emailIsVerified
            ? [{ id: 1, time: new Date().toISOString(), event: 'email-verified', email: notifyEmail }]
            : [],
          domain: passkeyService.rpID,
          type: 'user',
          workflowStage: 'active',
          temporaryAccount: true,
          kbName: candidateKbName,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        try {
          const saved = await cloudant.saveDocument('maia_users', candidateDoc);
          // Keep the revision: the background agent start below saves this
          // object again, and without _rev that save would overwrite
          // whatever landed meanwhile (a group join, the folder).
          candidateDoc._rev = saved.rev;
          userId = candidateId;
          displayName = candidateDisplayName;
          userDoc = candidateDoc;
        } catch (error) {
          if (error.statusCode === 409 || error.error === 'conflict') {
            continue;
          }
          throw error;
        }
      }

      if (!userId || !userDoc) {
        return res.status(500).json({
          authenticated: false,
          error: 'Unable to create temporary user'
        });
      }

      req.session.userId = userId;
      req.session.username = userId;
      req.session.displayName = displayName;
      req.session.isTemporary = true;
      req.session.authenticatedAt = new Date().toISOString();
      req.session.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      setTempCookie(res, userId);

      // Personal AS edition: the email is verified, so start the private AI
      // now, in the background; its deploy overlaps the passkey, folder and
      // join steps (§9). The setup checklist watches it finish.
      if (getEdition() === 'personal-as' && userDoc.emailVerified) {
        ensureUserAgent(doClient, cloudant, userDoc).catch((e) =>
          console.warn(`[AGENT] Background start for ${userId} failed:`, e?.message || e));
      }

      return res.json({
        authenticated: true,
        user: {
          userId,
          displayName,
          isTemporary: true
        }
      });
    } catch (error) {
      console.error('Temporary user start error:', error);
      return res.status(500).json({
        authenticated: false,
        error: error.message || 'Failed to create temporary user'
      });
    }
  });

  // Temporary user restore (reuse previous userId if agent exists)
  app.post('/api/temporary/restore', async (req, res) => {
    try {
      const restoreUserId = req.body?.userId;
      if (!restoreUserId || typeof restoreUserId !== 'string') {
        return res.status(400).json({ success: false, error: 'User ID required' });
      }
      console.log('[SAVE-RESTORE] Temporary restore requested', { userId: restoreUserId });

      // Agent lookup is optional — user may not have a cloud agent yet (wizard will create one)
      let agent = null;
      try {
        agent = await findUserAgent(doClient, restoreUserId);
      } catch (agentErr) {
        console.warn('[SAVE-RESTORE] Agent lookup failed (non-fatal):', agentErr.message);
      }

      let userDoc = null;
      try {
        userDoc = await cloudant.getDocument('maia_users', restoreUserId);
      } catch (error) {
        userDoc = null;
      }

      if (!userDoc) {
        // User doc was destroyed — don't auto-create a bare doc here.
        // Return 404 so the client triggers the full restore wizard which
        // uses /api/account/recreate and restores local state (meds, summary, chats).
        console.log('[SAVE-RESTORE] No user doc found (destroyed?) — returning 404 for restore wizard');
        return res.status(404).json({ success: false, error: 'User not found — account may have been destroyed' });
      }

      // Proof of ownership: this browser's signed temporary-account cookie,
      // or a live session for the same user. Without it, anyone could sign
      // in as any existing account by naming it.
      const proven = req.session?.userId === userDoc.userId || readTempCookie(req, res) === userDoc.userId;
      if (!proven) {
        return res.status(401).json({
          success: false,
          error: 'SIGN_IN_REQUIRED',
          hasPasskey: !!userDoc.credentialID,
          message: userDoc.credentialID
            ? 'Sign in with your passkey to open this account.'
            : 'This account can only be opened from the browser that created it.'
        });
      }

      req.session.userId = userDoc.userId;
      req.session.username = userDoc.userId;
      req.session.displayName = userDoc.displayName || userDoc.userId;
      req.session.isTemporary = true;
      req.session.authenticatedAt = new Date().toISOString();
      req.session.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      setTempCookie(res, userDoc.userId);

      console.log('[SAVE-RESTORE] Temporary user restored', { userId: userDoc.userId });
      res.json({
        authenticated: true,
        user: {
          userId: userDoc.userId,
          displayName: userDoc.displayName || userDoc.userId,
          isTemporary: true
        }
      });
    } catch (error) {
      console.error('[SAVE-RESTORE] Temporary restore error:', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to restore temp user' });
    }
  });

  // Welcome page: session or temp cookie status (for [AUTH] status line and flow branching)
  app.get('/api/welcome-status', async (req, res) => {
    try {
      if (req.session?.userId) {
        return res.json({
          authenticated: true,
          userId: req.session.userId,
          isTemporary: !!req.session.isTemporary
        });
      }
      const cookieUserId = readTempCookie(req, res);
      if (cookieUserId && typeof cookieUserId === 'string') {
        try {
          const userDoc = await cloudant.getDocument('maia_users', cookieUserId);
          const hasPasskey = !!userDoc?.credentialID;
          const cloudFileCount = Array.isArray(userDoc?.files) ? userDoc.files.length : 0;
          const cloudIndexedCount = Array.isArray(userDoc?.kbIndexedBucketKeys)
            ? userDoc.kbIndexedBucketKeys.length
            : (userDoc?.kbIndexedAt ? cloudFileCount : 0);
          return res.json({
            tempCookieUserId: cookieUserId,
            tempCookieHasPasskey: hasPasskey,
            cloudFileCount,
            cloudIndexedCount
          });
        } catch (err) {
          return res.json({ tempCookieUserId: cookieUserId, tempCookieHasPasskey: false });
        }
      }
      return res.json({});
    } catch (error) {
      console.error('[AUTH] welcome-status error:', error?.message || error);
      res.status(500).json({});
    }
  });

  // Return configured admin username (for admin passkey pre-fill on /admin page)
  app.get('/api/admin-username', (req, res) => {
    res.json({ adminUsername: process.env.ADMIN_USERNAME || 'admin' });
  });

  // Current user
  app.get('/api/current-user', (req, res) => {
    if (!req.session || !req.session.userId) {
      return res.json({ authenticated: false });
    }

    const isAdminUser = req.session.userId?.toLowerCase() === (process.env.ADMIN_USERNAME || 'admin').trim()?.toLowerCase();
    res.json({
      authenticated: true,
      user: {
        userId: req.session.userId,
        username: req.session.username,
        displayName: req.session.displayName,
        isTemporary: !!req.session.isTemporary,
        isDeepLink: !!req.session.isDeepLink,
        isAdmin: isAdminUser,
        deepLinkInfo: req.session.isDeepLink ? {
          shareIds: Array.isArray(req.session.deepLinkShareIds)
            ? req.session.deepLinkShareIds
            : (req.session.deepLinkShareIds ? [req.session.deepLinkShareIds] : []),
          activeShareId: req.session.deepLinkShareId || null,
          chatId: req.session.deepLinkChatId || null
        } : null
      }
    });
  });

  app.get('/api/setup-wizard-messages', (req, res) => {
    res.json({
      success: true,
      messages: getSetupWizardMessages()
    });
  });

  app.get('/api/agent-setup-status', async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'User not authenticated',
          error: 'NOT_AUTHENTICATED'
        });
      }

      let userDoc = await cloudant.getDocument('maia_users', userId);
      if (!userDoc) {
        return res.status(404).json({
          success: false,
          message: 'User not found',
          error: 'USER_NOT_FOUND'
        });
      }

      let provisionAttempted = false;
      let agentId = userDoc.assignedAgentId;
      let agent = null;

      if (!agentId) {
        try {
          userDoc = await ensureUserAgent(doClient, cloudant, userDoc);
          provisionAttempted = true;
          agentId = userDoc.assignedAgentId;
        } catch (error) {
          console.error(`[AGENT] Provisioning failed for ${userId}:`, error.message);
          return res.json({
            success: false,
            status: 'provision_failed',
            endpointReady: false,
            error: error.message || 'Agent provisioning failed'
          });
        }
      }

      if (agentId) {
        try {
          agent = await doClient.agent.get(agentId);
        } catch (error) {
          try {
            userDoc = await ensureUserAgent(doClient, cloudant, userDoc);
            provisionAttempted = true;
            agentId = userDoc.assignedAgentId;
            if (agentId) {
              agent = await doClient.agent.get(agentId);
            }
          } catch (provisionError) {
            console.error(`[AGENT] Provisioning retry failed for ${userId}:`, provisionError.message);
            return res.json({
              success: false,
              status: 'provision_failed',
              endpointReady: false,
              error: provisionError.message || 'Agent provisioning failed'
            });
          }
        }
      }

      if (!agent) {
        return res.json({
          success: true,
          status: 'not_started',
          endpointReady: false,
          provisionAttempted,
          ...(mayCreatePrimaryAgent(userDoc) ? {} : { waitingFor: 'email-verification' })
        });
      }
      const deploymentStatus = agent?.deployment?.status || agent?.deployment_status || agent?.status || 'unknown';
      const endpoint = agent?.deployment?.url ? `${agent.deployment.url}/api/v1` : null;
      // CRITICAL: DigitalOcean populates deployment.url while the agent is
      // still STATUS_DEPLOYING; the inference endpoint returns 403 until the
      // deployment is actually RUNNING. "Ready" therefore requires BOTH a URL
      // and STATUS_RUNNING — otherwise the wizard fires the draft summary /
      // worksheets into a not-yet-serving agent and gets 403 → 500.
      const isRunning = deploymentStatus === 'STATUS_RUNNING';
      const endpointReady = !!endpoint && isRunning;

      const cacheKey = `${userId}:${agentId}`;
      const previousStatus = agentStatusCache.get(cacheKey);
      if (!previousStatus || previousStatus !== deploymentStatus) {
        console.log(`[AGENT] Deployment status for ${userId} (${agentId}): ${deploymentStatus}`);
        agentStatusCache.set(cacheKey, deploymentStatus);
      }

      // Only record the endpoint / mark "deployed" once the agent is actually
      // RUNNING. Persisting agentEndpoint while it is merely DEPLOYING would
      // also make chat/providers include a Private AI that 403s (it treats
      // assignedAgentId + agentEndpoint as ready — see server/routes/chat.js).
      if (endpointReady && (userDoc.agentEndpoint !== endpoint || userDoc.agentSetupInProgress !== false)) {
        await saveUserDocWithRetry(cloudant, userId, (doc) => {
          doc.agentEndpoint = endpoint;
          doc.agentSetupInProgress = false;
          // Never DOWNGRADE a wizard-done stage: the quick-start flow
          // marks 'chat_ready' the moment the primary agent turns ready,
          // and this poll (e.g. the secondary agent turning ready a beat
          // later) used to clobber it back to 'agent_deployed' — which
          // made the setup wizard reopen on every reload.
          if (!WIZARD_DONE_STAGES_AUTH.has(doc.workflowStage)) {
            doc.workflowStage = 'agent_deployed';
          }
          doc.updatedAt = new Date().toISOString();
        });
      } else if (!endpointReady && userDoc.agentSetupInProgress !== true) {
        // Not RUNNING yet (no URL, or URL present but still deploying). Mark
        // setup in progress but do NOT clobber an existing workflow stage
        // (e.g. 'indexing'); only backfill the legacy 'agent_named' when the
        // stage is still unset.
        await saveUserDocWithRetry(cloudant, userId, (doc) => {
          doc.agentSetupInProgress = true;
          if (!doc.workflowStage) doc.workflowStage = 'agent_named';
          doc.updatedAt = new Date().toISOString();
        });
      }

      return res.json({
        success: true,
        status: deploymentStatus,
        endpointReady,
        endpoint,
        provisionAttempted
      });
    } catch (error) {
      console.error(`[AGENT] Status check failed for ${req.session?.userId || 'unknown'}:`, error.message || error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to check agent status'
      });
    }
  });
}

