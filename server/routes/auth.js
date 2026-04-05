/**
 * Authentication routes for user app
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { findUserAgent } from '../utils/agent-helper.js';
import { getProjectIdForGenAI } from '../utils/project-config.js';
import { getDoRegion } from '../utils/new-agent-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Helper to get client info for audit logging
function getClientInfo(req) {
  return {
    ip: req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown',
    userAgent: req.headers['user-agent'] || 'unknown'
  };
}

function buildAgentName(userId) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
  return `${userId}-agent-${timestamp}`;
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
      await cloudant.saveDocument('maia_users', freshDoc);
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

async function resolveModelAndProject(doClient) {
  let modelId = process.env.DO_MODEL_ID;
  let projectId = process.env.DO_PROJECT_ID;

  if (!isValidUUID(modelId) || !isValidUUID(projectId)) {
    try {
      const agents = await doClient.agent.list();
      if (agents.length > 0) {
        const existingAgent = await doClient.agent.get(agents[0].uuid || agents[0].id);
        if (!isValidUUID(modelId) && existingAgent.model?.uuid && isValidUUID(existingAgent.model.uuid)) {
          modelId = existingAgent.model.uuid;
        }
        if (!isValidUUID(projectId) && existingAgent.project_id && isValidUUID(existingAgent.project_id)) {
          projectId = existingAgent.project_id;
        }
      }
    } catch (error) {
      // Continue with fallback
    }
  }

  if (!isValidUUID(modelId)) {
    try {
      const modelsResponse = await doClient.request('/v2/gen-ai/models');
      const models = modelsResponse.models || modelsResponse.data?.models || [];
      if (models.length > 0) {
        const preferredModel = models.find(m =>
          m.inference_name === 'openai-gpt-oss-120b' || m.name === 'OpenAI GPT-oss-120b'
        );
        const selectedModel = preferredModel || models[0];
        if (selectedModel && selectedModel.uuid && isValidUUID(selectedModel.uuid)) {
          modelId = selectedModel.uuid;
        }
      }
    } catch (error) {
      // Continue
    }
  }

  if (!isValidUUID(projectId)) {
    projectId = await getProjectIdForGenAI(doClient) || projectId;
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
  const adminUsername = process.env.ADMIN_USERNAME?.trim();
  const uid = (userId && typeof userId === 'string') ? userId.trim().toLowerCase() : '';
  if (!adminUsername || uid !== adminUsername.toLowerCase()) {
    return { required: false, ok: true };
  }
  const configuredSecret = process.env.ADMIN_SECRET;
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
  let lockResolve = null;
  if (needsCreation) {
    let lockReject;
    const lockPromise = new Promise((resolve, reject) => { lockResolve = resolve; lockReject = reject; });
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
        maxTokens: 16384,
        topP: 1,
        temperature: 0.1,
        k: 10,
        retrievalMethod: 'RETRIEVAL_METHOD_NONE'
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
  userDoc.workflowStage = endpoint ? 'agent_deployed' : 'agent_named';
  userDoc.agentSetupInProgress = !endpoint;
  userDoc.updatedAt = new Date().toISOString();

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
        userDoc.workflowStage = endpoint ? 'agent_deployed' : 'agent_named';
        userDoc.agentSetupInProgress = !endpoint;
        userDoc.updatedAt = new Date().toISOString();
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

export default function setupAuthRoutes(app, passkeyService, cloudant, doClient, auditLog) {
  // Check if user exists and has passkey
  app.get('/api/passkey/check-user', async (req, res) => {
    try {
      const { userId } = req.query;

      if (!userId) {
        return res.status(400).json({ error: 'User ID required' });
      }

      const adminUsername = process.env.ADMIN_USERNAME?.trim();
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
            ? 'Admin passkey is not configured. Set ADMIN_SECRET (and ADMIN_USERNAME) on the server.'
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
      if (existingUser && existingUser.credentialID && !adminSecretCheck.required) {
        return res.status(400).json({ 
          error: 'User already has a passkey',
          hasExistingPasskey: true
        });
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
            ? 'Admin passkey is not configured. Set ADMIN_SECRET on the server.'
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

      // Update user with credential info
      const updatedUser = result.userDoc;
      updatedUser.challenge = undefined; // Remove challenge
      
      console.log(`[NEW FLOW 2] Passkey verified; minimal user setup for ${updatedUser.userId}`);
      updatedUser.workflowStage = 'active';
      updatedUser.initialFile = null;
      updatedUser.temporaryAccount = false;
      
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
      const isAdminUser = agentReadyUser.userId?.toLowerCase() === process.env.ADMIN_USERNAME?.trim()?.toLowerCase();
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

      const isAdminUser = userDoc.userId?.toLowerCase() === process.env.ADMIN_USERNAME?.trim()?.toLowerCase();
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
      const updatedUser = result.userDoc;
      updatedUser.challenge = undefined; // Remove challenge
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

      const isAdminUser = agentReadyUser.userId?.toLowerCase() === process.env.ADMIN_USERNAME?.trim()?.toLowerCase();
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
        res.clearCookie(TEMP_USER_COOKIE);
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

      // Wizard complete: derived from data presence — does the user have everything the wizard produces?
      const wizardComplete = agentExists
        && kbExists
        && !!userDoc?.agentEndpoint
        && !!(userDoc?.patientSummary && String(userDoc.patientSummary).trim())
        && !!(userDoc?.currentMedications && String(userDoc.currentMedications).trim());

      console.log(`[WELCOME] agent-exists for ${userId}: agent=${agentExists}, savedFiles=${savedFileCount}/${allFiles.length}, kb=${kbExists}, linked=${agentLinkedToKb}, wizardDone=${wizardComplete}, stage=${userDoc?.workflowStage || 'none'}`);

      res.json({
        success: true,
        exists: agentExists,
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

      // Check if user doc already exists (shouldn't, but be safe)
      try {
        const existing = await cloudant.getDocument('maia_users', userId);
        if (existing) {
          // User doc exists — just sign them in
          req.session.userId = userId;
          req.session.username = userId;
          req.session.displayName = existing.displayName || userId;
          req.session.isTemporary = true;
          req.session.authenticatedAt = new Date().toISOString();
          req.session.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
          res.cookie(TEMP_USER_COOKIE, userId, {
            maxAge: TEMP_USER_COOKIE_MAX_AGE,
            httpOnly: true,
            sameSite: 'lax'
          });
          return res.json({
            success: true,
            authenticated: true,
            user: {
              userId: existing.userId,
              displayName: existing.displayName || userId,
              isTemporary: true
            }
          });
        }
      } catch (e) {
        // 404 expected — user was destroyed, proceed to recreate
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
      console.log(`[RECREATE] User doc recreated for ${userId} with kbName=${kbName}`);

      // Sign them in
      req.session.userId = userId;
      req.session.username = userId;
      req.session.displayName = userDoc.displayName;
      req.session.isTemporary = true;
      req.session.authenticatedAt = new Date().toISOString();
      req.session.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      res.cookie(TEMP_USER_COOKIE, userId, {
        maxAge: TEMP_USER_COOKIE_MAX_AGE,
        httpOnly: true,
        sameSite: 'lax'
      });

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
  app.post('/api/temporary/start', async (req, res) => {
    try {
      const forceNew = req.body?.forceNew === true;
      const cookieUserId = req.cookies?.[TEMP_USER_COOKIE];
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
            res.cookie(TEMP_USER_COOKIE, existingUser.userId, {
              maxAge: TEMP_USER_COOKIE_MAX_AGE,
              httpOnly: true,
              sameSite: 'lax'
            });
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

      let userId = null;
      let displayName = null;
      let userDoc = null;
      let attempts = 0;
      while (!userId && attempts < 30) {
        attempts += 1;
        const name = pickRandomTempName();
        const suffix = String(Math.floor(Math.random() * 100)).padStart(2, '0');
        const candidateId = formatTempUserId(name, suffix);
        const candidateDisplayName = `${name}${suffix}`;
        const dateStr = new Date().toISOString().replace(/[-:]/g, '').split('T')[0];
        const candidateKbName = `${candidateId}-kb-${dateStr}${Date.now().toString().slice(-6)}`;
        const candidateDoc = {
          _id: candidateId,
          userId: candidateId,
          displayName: candidateDisplayName,
          email: null,
          domain: passkeyService.rpID,
          type: 'user',
          workflowStage: 'active',
          temporaryAccount: true,
          kbName: candidateKbName,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        try {
          await cloudant.saveDocument('maia_users', candidateDoc);
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

      res.cookie(TEMP_USER_COOKIE, userId, {
        maxAge: TEMP_USER_COOKIE_MAX_AGE,
        httpOnly: true,
        sameSite: 'lax'
      });

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

      req.session.userId = userDoc.userId;
      req.session.username = userDoc.userId;
      req.session.displayName = userDoc.displayName || userDoc.userId;
      req.session.isTemporary = true;
      req.session.authenticatedAt = new Date().toISOString();
      req.session.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      res.cookie(TEMP_USER_COOKIE, userDoc.userId, {
        maxAge: TEMP_USER_COOKIE_MAX_AGE,
        httpOnly: true,
        sameSite: 'lax'
      });

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
      const cookieUserId = req.cookies?.[TEMP_USER_COOKIE];
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
    res.json({ adminUsername: process.env.ADMIN_USERNAME || null });
  });

  // Current user
  app.get('/api/current-user', (req, res) => {
    if (!req.session || !req.session.userId) {
      return res.json({ authenticated: false });
    }

    const isAdminUser = req.session.userId?.toLowerCase() === process.env.ADMIN_USERNAME?.trim()?.toLowerCase();
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
          provisionAttempted
        });
      }
      const deploymentStatus = agent?.deployment?.status || agent?.deployment_status || agent?.status || 'unknown';
      const endpoint = agent?.deployment?.url ? `${agent.deployment.url}/api/v1` : null;

      const cacheKey = `${userId}:${agentId}`;
      const previousStatus = agentStatusCache.get(cacheKey);
      if (!previousStatus || previousStatus !== deploymentStatus) {
        console.log(`[AGENT] Deployment status for ${userId} (${agentId}): ${deploymentStatus}`);
        agentStatusCache.set(cacheKey, deploymentStatus);
      }

      if (endpoint && userDoc.agentEndpoint !== endpoint) {
        await saveUserDocWithRetry(cloudant, userId, (doc) => {
          doc.agentEndpoint = endpoint;
          doc.agentSetupInProgress = false;
          doc.workflowStage = 'agent_deployed';
          doc.updatedAt = new Date().toISOString();
        });
      } else if (!endpoint && userDoc.agentSetupInProgress !== true) {
        await saveUserDocWithRetry(cloudant, userId, (doc) => {
          doc.agentSetupInProgress = true;
          if (doc.workflowStage !== 'agent_named') {
            doc.workflowStage = 'agent_named';
          }
          doc.updatedAt = new Date().toISOString();
        });
      }

      return res.json({
        success: true,
        status: deploymentStatus,
        endpointReady: !!endpoint,
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

