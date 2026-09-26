/**
 * Chat routes for AI provider integrations
 */

import { ChatClient } from '../../lib/chat-client/index.js';
import { DigitalOceanProvider } from '../../lib/chat-client/providers/digitalocean.js';
import { getOrCreateAgentApiKey, recreateAgentApiKey } from '../utils/agent-helper.js';
import { ensureUserAgent, ensureSecondaryAgent } from './auth.js';
import { policySentence, READ_SCOPES, POLICY_PURPOSES } from './policies.js';
import { buildPolicyAdvisorContext, buildEditionAdvisorContext, advisorContextKind } from '../advisor-context.js';
import { isVerified as emailTokenVerified } from '../emailVerification.js';
import { chargeCredits, ADVISOR_QUESTION_CREDITS } from '../credits.js';
import { isFeatureEnabled } from '../edition.js';

// One SSE event per streaming update. Intermediate updates carry only the
// new delta: the provider's running totals (content / reasoningContent)
// grow with every token, so repeating them made the stream O(n²) in size
// and made events ever more likely to straddle network reads. The final
// isComplete event keeps the full text so the client can use it as the
// authoritative answer.
const sseEvent = (update) => {
  let payload = update;
  if (update && !update.isComplete) {
    const { content, reasoningContent, ...rest } = update;
    payload = rest;
  }
  return `data: ${JSON.stringify(payload)}\n\n`;
};

const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

const findChatByShareId = async (cloudant, shareId) => {
  if (!shareId) return null;
  try {
    const result = await cloudant.findDocuments('maia_chats', {
      selector: { shareId: { $eq: shareId } },
      limit: 1
    });
    if (result?.docs?.length) {
      return result.docs[0];
    }
  } catch (error) {
    console.warn('Unable to look up chat by shareId:', error.message);
  }
  return null;
};

const looksLikeDeepLinkId = (userId) => typeof userId === 'string' && userId.includes('-dl-');

const extractOwnerIdFromChatId = (chatId) => {
  if (typeof chatId !== 'string') return null;
  const dashIndex = chatId.indexOf('-chat_');
  if (dashIndex > 0) {
    return chatId.slice(0, dashIndex);
  }
  return null;
};

const resolveAgentOwnerId = (chatDoc) => {
  if (!chatDoc || typeof chatDoc !== 'object') return null;
  const candidates = [
    chatDoc.patientOwner,
    chatDoc.ownerId,
    chatDoc.owner,
    chatDoc.ownerUserId,
    chatDoc.currentUser
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && !looksLikeDeepLinkId(candidate)) {
      return candidate;
    }
  }

  const derived = extractOwnerIdFromChatId(chatDoc._id);
  if (derived && !looksLikeDeepLinkId(derived)) {
    return derived;
  }

  return null;
};

/**
 * For deep link sessions, return the owner (patient) userId of the shared chat.
 * Used by file routes to allow deep link users to access owner's files only.
 */
export async function getOwnerIdForDeepLinkSession(req, cloudant) {
  if (!req.session?.isDeepLink || !req.session?.deepLinkShareId) return null;
  const chat = await findChatByShareId(cloudant, req.session.deepLinkShareId);
  return chat ? resolveAgentOwnerId(chat) : null;
}

/** The patient who shared the chat behind `shareId`, or null. */
export async function getShareOwnerId(cloudant, shareId) {
  if (!shareId || typeof shareId !== 'string') return null;
  const chat = await findChatByShareId(cloudant, shareId);
  return chat ? resolveAgentOwnerId(chat) : null;
}

export default function setupChatRoutes(app, chatClient, cloudant, doClient, appendUserProvisioningEvent) {
  /**
   * Main chat endpoint - routes to appropriate provider
   * POST /api/chat/:provider
   */
  app.post('/api/chat/:provider', async (req, res) => {
    // Declare userAgentProvider outside try block for error handling
    let userAgentProvider = null;
    let agentOwnerId = null;
    let userId = null;
    let agentId = null;
    // Captured so the 401 handler can transparently re-run the request
    // with a freshly recreated API key (no user-visible error).
    let retryCtx = null;
    
    try {
      const { provider } = req.params;
      const { messages } = req.body;
      let options = req.body.options || {};
      const shareIdFromOptions = options?.shareId;
      if (shareIdFromOptions) {
        options = { ...options };
        delete options.shareId;
      }
      const shareIdForRequest = shareIdFromOptions || req.session?.deepLinkShareId || null;

      // Which Private AI the user picked in the dropdown (e.g. 'default'
      // = Deepseek, 'gpt' = GPT-OSS-120B). Stripped from options so it
      // is never forwarded to the LLM provider as a model option.
      const requestedProfileKey = options?.agentProfileKey || req.body?.agentProfileKey || null;
      if (options?.agentProfileKey) {
        options = { ...options };
        delete options.agentProfileKey;
      }

      if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: 'Messages array required' });
      }

      // Check if provider is available
      if (!chatClient.isProviderAvailable(provider)) {
        return res.status(400).json({ 
          error: `Provider '${provider}' not available`,
          available: chatClient.getAvailableProviders()
        });
      }

      // For DigitalOcean provider, check if user has a specific agent
      const bodyUserId = req.body?.userId || null;
      const sessionUserId = req.session?.userId || null;
      if (sessionUserId && bodyUserId && sessionUserId !== bodyUserId) {
        return res.status(403).json({
          error: 'User ID mismatch',
          type: 'USER_ID_MISMATCH',
          status: 403
        });
      }
      userId = sessionUserId || bodyUserId || null;
      let userDoc = null;
      let ownerChatDoc = null;
      
      if (provider === 'digitalocean' && cloudant && doClient) {
        let effectiveUserId = userId;

        if (!effectiveUserId && req.session?.isDeepLink) {
          const candidateShares = [
            shareIdForRequest,
            req.session.deepLinkShareId,
            ...(Array.isArray(req.session.deepLinkShareIds) ? req.session.deepLinkShareIds : [])
          ].filter(Boolean);

          for (const candidateShare of candidateShares) {
            ownerChatDoc = await findChatByShareId(cloudant, candidateShare);
            if (ownerChatDoc) {
              effectiveUserId = resolveAgentOwnerId(ownerChatDoc);
              if (effectiveUserId) {
                break;
              }
            }
          }

          if (!effectiveUserId) {
            return res.status(403).json({
              error: 'Shared chat is not linked to an agent owner',
              type: 'DEEPLINK_FORBIDDEN',
              status: 403
            });
          }
        }

        if (!effectiveUserId) {
          return res.status(401).json({
            error: 'User not authenticated',
            type: 'NOT_AUTHENTICATED',
            status: 401
          });
        }

        userId = effectiveUserId;
        agentOwnerId = effectiveUserId;
        if (bodyUserId && agentOwnerId && bodyUserId !== agentOwnerId) {
          return res.status(403).json({
            error: 'User ID mismatch',
            type: 'USER_ID_MISMATCH',
            status: 403
          });
        }

        try {
          userDoc = await cloudant.getDocument('maia_users', userId);
        } catch (docError) {
          return res.status(404).json({
            error: 'Agent owner not found',
            type: 'AGENT_OWNER_NOT_FOUND',
            status: 404
          });
        }

        const agentProfiles = isPlainObject(userDoc.agentProfiles) ? userDoc.agentProfiles : {};
        const defaultProfileKey = userDoc.agentProfileDefaultKey || 'default';

        let profileKeyToUse = defaultProfileKey;
        let overrideValue = null;
        if (shareIdForRequest && isPlainObject(userDoc.deepLinkAgentOverrides)) {
          overrideValue = userDoc.deepLinkAgentOverrides[shareIdForRequest];
        }

        // Explicit dropdown selection wins over the deep-link override
        // and the default. Deep-link visitors (no selector) fall back
        // to the override / default as before.
        if (requestedProfileKey && isPlainObject(agentProfiles[requestedProfileKey])) {
          profileKeyToUse = requestedProfileKey;
          overrideValue = null;
        }

        if (overrideValue) {
          if (agentProfiles[overrideValue]) {
            profileKeyToUse = overrideValue;
          } else {
            const matchedEntry = Object.entries(agentProfiles).find(([, profile]) => (
              isPlainObject(profile) && profile.agentId === overrideValue
            ));
            if (matchedEntry) {
              profileKeyToUse = matchedEntry[0];
            }
          }
        }

        const selectedProfile = isPlainObject(agentProfiles[profileKeyToUse])
          ? agentProfiles[profileKeyToUse]
          : null;

        const profileAgentId = selectedProfile?.agentId || userDoc.assignedAgentId || null;
        const profileAgentName = selectedProfile?.agentName || userDoc.assignedAgentName || null;
        const profileEndpoint = selectedProfile?.endpoint || userDoc.agentEndpoint || null;
        const profileModelName = selectedProfile?.modelName || userDoc.agentModelName || null;

        if (profileAgentId && profileEndpoint && profileAgentName) {
          agentId = profileAgentId;

          const apiKey = await getOrCreateAgentApiKey(doClient, cloudant, userId, agentId, profileKeyToUse);

          userAgentProvider = new DigitalOceanProvider(apiKey, {
            baseURL: profileEndpoint
          });

          // Send a real MODEL name, never the agent NAME. The DO agent's
          // OpenAI-compatible endpoint 500s on an invalid model (the agent
          // name is not a model). When the profile has no modelName, fall back
          // exactly like the draft-summary path (which works) — the account's
          // agentModelName, then the primary default — rather than the agent
          // name, which was the cause of the "500 Internal server error" on
          // Private AI chat while the draft Patient Summary succeeded.
          options.model = profileModelName || userDoc.agentModelName || 'openai-gpt-oss-120b';

          retryCtx = { endpoint: profileEndpoint, profileKey: profileKeyToUse };

          // Ground the agent's self-identity (Refinement 6 amendment):
          // "What model are you?" must travel the REAL inference path and
          // come back true — a user-runnable end-to-end wiring probe. The
          // UI chip (metadata) and this live answer must agree; if they
          // ever disagree, that disagreement is itself the diagnostic
          // that the wrong agent or model is wired up. Never let the
          // model improvise its identity (it hallucinates "GPT-4").
          const identityModel = profileModelName || 'an unknown model';
          if (Array.isArray(messages)) messages.unshift({
            role: 'system',
            content:
              `You are MAIA, this patient's private medical AI assistant, ` +
              `running as their dedicated agent "${profileAgentName}" on model "${identityModel}" ` +
              `on their own MAIA deployment. If asked what AI or model you are, state exactly that ` +
              `(agent "${profileAgentName}", model "${identityModel}") and do not speculate about ` +
              `your architecture beyond it.`
          });
        } else {
          return res.status(404).json({
            error: 'Private AI agent not provisioned for this user',
            type: 'AGENT_NOT_FOUND',
            status: 404
          });
        }
      }

      const startTime = Date.now();

      // Advisor context (server-assembled): the full edition's Policy
      // Advisor when the patient opens it; in the Personal AS edition,
      // every turn with the patient's own private AI (§9, P10). Never for
      // deep-link visitors or shared chats — the context contains the
      // owner's summary, policies and request history.
      const advisorKind = advisorContextKind({
        provider, policyAdvisor: req.body?.policyAdvisor === true,
        isDeepLink: !!req.session?.isDeepLink, shareId: shareIdForRequest, userId
      });
      if (advisorKind && Array.isArray(messages)) {
        try {
          const advisorDoc = userDoc || await cloudant?.getDocument('maia_users', userId);
          if (advisorDoc) {
            const content = advisorKind === 'edition'
              ? await buildEditionAdvisorContext(cloudant, advisorDoc)
              : await buildPolicyAdvisorContext(cloudant, advisorDoc);
            messages.unshift({ role: 'system', content });
          }
        } catch (e) {
          console.warn('[chat] advisor context failed (chat continues without it):', e?.message || e);
        }
      }

      // Check if streaming is requested
      const stream = options.stream || req.headers.accept === 'text/event-stream';

      // Use user-specific agent provider if available, otherwise use default
      if (stream) {
        // Setup SSE streaming
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // Track whether the provider callback emitted isComplete=true
        // (and thus called res.end()). If the provider's promise
        // resolves WITHOUT having sent an isComplete update — which
        // we've observed on certain deep-link sessions where the DO
        // agent returns no body, and on transient upstream errors —
        // we need to send a final SSE event AND end the response.
        // Without this, the connection stays open and the client
        // hangs at "Thinking…" with no console error.
        let completedFromProvider = false;
        const writeUpdate = (update) => {
          try {
            res.write(sseEvent(update));
          } catch { /* connection already closed */ }
          if (update.isComplete) {
            completedFromProvider = true;
            try { res.end(); } catch { /* already ended */ }
          }
        };

        try {
          if (userAgentProvider) {
            await userAgentProvider.chat(messages, { ...options, stream: true }, writeUpdate);
          } else {
            await chatClient.chat(provider, messages, { ...options, stream: true }, writeUpdate);
          }
        } catch (streamErr) {
          // Send the error to the client as a visible SSE event so the
          // chat bubble shows the message instead of staying blank.
          const errMsg = streamErr?.message || streamErr?.error?.message || 'Chat request failed';
          console.error(`[chat/${provider}] streaming error:`, errMsg);
          if (!completedFromProvider && !res.writableEnded) {
            try {
              res.write(`data: ${JSON.stringify({
                delta: `Error: ${errMsg}`,
                isComplete: true,
                error: true
              })}\n\n`);
            } catch { /* connection closed */ }
            completedFromProvider = true;
            try { res.end(); } catch { /* already ended */ }
          }
          // Log to maia-log so the error appears in the setup log PDF
          const chatUserId = agentOwnerId || userId || req.body?.userId || req.session?.userId;
          if (chatUserId && appendUserProvisioningEvent) {
            appendUserProvisioningEvent(chatUserId, {
              event: 'chat-error',
              provider,
              error: errMsg
            }).catch(() => {});
          }
        } finally {
          // Fallback: provider returned but never reported isComplete.
          // Emit a synthetic completion event + close the stream so
          // the client's read loop can exit normally.
          if (!completedFromProvider && !res.writableEnded) {
            try {
              res.write(`data: ${JSON.stringify({ isComplete: true, reason: 'provider-stream-ended-without-isComplete' })}\n\n`);
            } catch { /* ignore */ }
            try { res.end(); } catch { /* ignore */ }
          }
        }
      } else {
        // Non-streaming response
        let response;
        if (userAgentProvider) {
          response = await userAgentProvider.chat(messages, options);
        } else {
          response = await chatClient.chat(provider, messages, options);
        }
        const responseTime = Date.now() - startTime;

        res.json({
          ...response,
          _meta: {
            responseTime,
            provider
          }
        });
      }

    } catch (error) {
      console.error('Chat error:', error);
      const statusCode = error.status || error.statusCode || 500;
      
      let errorMessage = error.message || 'Chat request failed';
      
      // Handle 401/403 on a Private AI agent endpoint by REPAIRING the
      // agent, not just its key. After a Restore the selected profile
      // (esp. the secondary "gpt" agent) can point at a destroyed agent
      // — that returns 403, and recreating only the API key can't fix a
      // dead endpoint. So: re-ensure the agent for the active profile
      // (recreates it + refreshes endpoint/agentId), recreate the key
      // for the resolved agent, then transparently retry against the
      // FRESH endpoint.
      const resolvedUserId = agentOwnerId || userId || bodyUserId;
      const resolvedAgentId = agentId;
      const isAuthFail = statusCode === 401 || statusCode === 403;
      if (isAuthFail && userAgentProvider && resolvedUserId && resolvedAgentId && cloudant && doClient) {
        const profileKey = retryCtx?.profileKey || 'default';
        console.error(`${statusCode} on agent endpoint for agent ${resolvedAgentId} (profile ${profileKey}). Repairing agent + key...`);

        try {
          let freshEndpoint = retryCtx?.endpoint || null;
          let freshAgentId = resolvedAgentId;
          try {
            let udoc = await cloudant.getDocument('maia_users', resolvedUserId);
            if (udoc) {
              udoc = (profileKey === 'gpt')
                ? await ensureSecondaryAgent(doClient, cloudant, udoc)
                : await ensureUserAgent(doClient, cloudant, udoc);
              const prof = udoc?.agentProfiles?.[profileKey];
              if (prof?.endpoint) freshEndpoint = prof.endpoint;
              if (prof?.agentId) freshAgentId = prof.agentId;
              else if (profileKey !== 'gpt' && udoc?.assignedAgentId) freshAgentId = udoc.assignedAgentId;
            }
          } catch (ensureErr) {
            console.error(`Agent re-ensure failed (profile ${profileKey}):`, ensureErr.message);
          }

          const newApiKey = await recreateAgentApiKey(doClient, cloudant, resolvedUserId, freshAgentId, profileKey);
          console.log(`✅ Repaired agent ${freshAgentId} (profile ${profileKey}); endpoint=${freshEndpoint ? 'fresh' : 'unknown'}`);

          // Transparently re-run the request against the fresh endpoint
          // + key, as long as no body has been sent yet.
          if (retryCtx && freshEndpoint && !res.headersSent) {
            try {
              const freshProvider = new DigitalOceanProvider(newApiKey, { baseURL: freshEndpoint });
              const reqMessages = req.body?.messages;
              const reqOptions = req.body?.options || {};
              if (reqOptions.model == null && options?.model != null) reqOptions.model = options.model;
              const wantStream = reqOptions.stream || req.headers.accept === 'text/event-stream';
              if (wantStream) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                await freshProvider.chat(reqMessages, { ...reqOptions, stream: true }, (update) => {
                  res.write(sseEvent(update));
                  if (update.isComplete) res.end();
                });
              } else {
                const retryResponse = await freshProvider.chat(reqMessages, reqOptions);
                res.json({ ...retryResponse, _meta: { provider, recovered: true } });
              }
              console.log(`✅ Auto-retried chat after repairing agent ${freshAgentId} (no user-visible error)`);
              return;
            } catch (retryError) {
              console.error(`Auto-retry after repair failed for agent ${freshAgentId}:`, retryError.message);
              // Fall through to the user-facing message below.
            }
          }

          errorMessage = 'Your Private AI agent was repaired automatically. Please try your request again.';
        } catch (recreateError) {
          console.error(`Failed to repair agent ${resolvedAgentId}:`, recreateError.message);
          errorMessage = 'Your Private AI agent could not be reached. Please try again shortly or contact support if this persists.';
        }
      } else if (isAuthFail && userAgentProvider) {
        errorMessage = 'Authentication failed for your Private AI agent. It may need to be recreated.';
        console.error(`${statusCode} on agent endpoint (could not repair - missing info)`);
      }
      
      // Enhance error messages for token limit errors (400 status with token limit message)
      // IMPORTANT: Use req.body.messages directly (never reference try-block variables)
      // Wrap in try-catch to ensure error enhancement never crashes the error handler
      if (statusCode === 400 && errorMessage && errorMessage.toLowerCase().includes('token')) {
        try {
          // Extract token limit from error message if present
          const tokenLimitMatch = errorMessage.match(/(\d+)\s*tokens?/i);
          const tokenLimit = tokenLimitMatch ? tokenLimitMatch[1] : null;
          
          // Safely access messages from req.body (always available from request)
          const messages = req.body?.messages;
          let estimatedTokens = null;
          
          if (messages && Array.isArray(messages)) {
            try {
              const totalChars = messages.reduce((sum, msg) => {
                if (msg?.content) {
                  return sum + (typeof msg.content === 'string' ? msg.content.length : JSON.stringify(msg.content).length);
                }
                return sum;
              }, 0);
              estimatedTokens = Math.ceil(totalChars / 4);
            } catch (calcError) {
              // If calculation fails, just skip token count enhancement
              console.warn('Could not calculate token count for error enhancement:', calcError.message);
            }
          }
          
          // Build helpful error message only if we have the necessary data
          if (tokenLimit || estimatedTokens !== null) {
            let enhancedMessage = errorMessage;
            
            if (tokenLimit && estimatedTokens !== null) {
              enhancedMessage = `**Request too large**\n\n` +
                `Your request contains approximately ${estimatedTokens.toLocaleString()} tokens, which exceeds the model's maximum input limit of ${parseInt(tokenLimit).toLocaleString()} tokens.\n\n` +
                `**Suggestions:**\n` +
                `- Try reducing the size of attached files\n` +
                `- Split large documents into smaller sections\n` +
                `- Remove unnecessary context from your message\n` +
                `- Try asking more specific questions about smaller portions of your documents`;
            } else if (tokenLimit) {
              enhancedMessage = `**Request too large**\n\n` +
                `Your request exceeds the model's maximum input limit of ${parseInt(tokenLimit).toLocaleString()} tokens.\n\n` +
                `**Suggestions:**\n` +
                `- Try reducing the size of attached files\n` +
                `- Split large documents into smaller sections\n` +
                `- Remove unnecessary context from your message`;
            } else if (estimatedTokens !== null) {
              enhancedMessage = `**Request too large**\n\n` +
                `Your request contains approximately ${estimatedTokens.toLocaleString()} tokens, which exceeds the model's context limit.\n\n` +
                `**Suggestions:**\n` +
                `- Try reducing the size of attached files\n` +
                `- Split large documents into smaller sections\n` +
                `- Remove unnecessary context from your message`;
            }
            
            errorMessage = enhancedMessage;
          }
        } catch (enhancementError) {
          // If error enhancement fails, log it but don't crash - just use original error message
          console.warn('Error enhancement failed (non-critical):', enhancementError.message);
          // Continue with original errorMessage
        }
      }
      
      // Guard: if we already started streaming, headers are sent — don't try to send again
      if (res.headersSent) {
        // Try to end the stream gracefully so the client knows something went wrong
        try { res.end(); } catch (_) { /* already closed */ }
        return;
      }
      res.status(statusCode).json({
        error: errorMessage,
        type: error.type,
        status: statusCode
      });
    }
  });

  // Get shared group chats
  app.get('/api/shared-group-chats', async (req, res) => {
    try {
      const { userId } = req.query;
      const sessionUserId = req.session?.userId || null;

      if (!userId) {
        return res.status(400).json({
          success: false,
          message: 'User ID is required',
          error: 'MISSING_USER_ID'
        });
      }

      if (sessionUserId && sessionUserId !== userId) {
        return res.status(403).json({
          success: false,
          message: 'User ID mismatch',
          error: 'USER_ID_MISMATCH'
        });
      }

      // Get all chats for this user from maia_chats
      const allChats = await cloudant.getAllDocuments('maia_chats');

      // Filter to only shared group chats owned by this user
      const sharedChats = allChats.filter(chat =>
        chat._id.startsWith(`${userId}-`) &&
        chat.type === 'group_chat' &&
        chat.isShared === true
      );

      res.json({
        success: true,
        chats: sharedChats,
        count: sharedChats.length
      });
    } catch (error) {
      console.error('❌ Error fetching shared group chats:', error);
      res.status(500).json({
        success: false,
        message: `Failed to fetch chats: ${error.message}`,
        error: 'FETCH_FAILED'
      });
    }
  });

  // ── Group Advisor (Policy Assist Phase 2) ──────────────────────────
  // PUBLIC endpoint: a welcome-page visitor with a VERIFIED email can ask
  // the group's AI how to compose a request. The context is strictly what
  // the join page already publishes — the group's posting policy and
  // suggested policy cards, plus the request mechanics. HARD EXCLUSIONS:
  // member lists, individual members' policies, request logs, records,
  // per-member outcomes. This advisor describes what the GROUP suggests,
  // never what any MEMBER holds — a brochure, not a reconnaissance tool.
  // Runs on a host-level provider (never any patient's agent).
  const groupAdvisorRate = new Map(); // emailVerifyToken -> { count, resetAt }
  const GROUP_ADVISOR_MAX_PER_WINDOW = 10;
  const GROUP_ADVISOR_WINDOW_MS = 10 * 60 * 1000;

  const buildGroupAdvisorContext = (doc) => {
    const suggested = Array.isArray(doc.suggestedPolicies) ? doc.suggestedPolicies : [];
    const cardLines = suggested.length
      ? suggested.map((c, i) => `${i + 1}. ${policySentence(c)}`).join('\n')
      : '(this group has not published suggested policies yet)';
    return [
      `You are the public request advisor for the patient group "${doc.name}" on MAIA.`,
      'Your job: help an OUTSIDE requester (a visitor with a verified email) compose a',
      'request for health information that group members\' own AIs are likely to answer.',
      '',
      `Group description: ${doc.description || '(none)'}`,
      `Group posting policy: ${doc.postingPolicy || '(none)'}`,
      '',
      'THE GROUP\'S SUGGESTED POLICIES (members adopt these as their own editable cards;',
      'each member may have changed or disabled them — you CANNOT know any member\'s',
      'actual policies, records, or history, and you must say so if asked):',
      cardLines,
      '',
      'HOW REQUESTS WORK: the request goes to EVERY active member; each member\'s own',
      'policy cards decide deterministically (deny wins, then ask-me-first, then allow,',
      'else the member is asked personally). Allow responses are AUTOMATIC and contain',
      'only PRIVACY-FILTERED artifacts (names replaced by pseudonyms). Some members may',
      'silently ignore a request. Responses arrive at the requester\'s verified email as',
      'they come in; a public tally shows counts only.',
      'Identity: the visitor can prove only "verified-email" today (their code-verified',
      `address). Claims of Doximity verification evaluate as unverified until real`,
      'verification exists.',
      'PAYMENTS (credits: 100 for $2, bought from the host, non-refundable): a request',
      'may attach a returnable spam deposit (5 credits — returned when anyone answers,',
      'forfeited if everyone silently ignores it), a request evaluation payment',
      '(2 credits, charged at delivery), or a sharing payment (25 credits — charged',
      'only when a member accepts). Attaching one can satisfy member cards that',
      'require it; a card requiring no payment matches any request. One payment',
      'covers the whole request regardless of member count.',
      `Scopes a request may name: ${JSON.stringify(READ_SCOPES.filter((s) => s !== 'ah-category'))}.`,
      `Purposes: ${JSON.stringify(POLICY_PURPOSES.filter((p) => p !== 'any'))}.`,
      'Broader scopes are HARDER to get; narrow, well-explained requests with a clear',
      'purpose do best. A short personal message helps members trust the request.',
      '',
      'When you recommend a concrete request, ALSO output exactly one fenced code block',
      'with language tag `request-suggestion` containing ONLY JSON:',
      '{"scope":"<scope>","purpose":"<purpose>","message":"<one- or two-sentence message to the group>"}',
      'The visitor reviews it in the request table and sends it themselves — never imply',
      'you sent anything or know what any specific member will answer.'
    ].join('\n');
  };

  app.post('/api/groups/:groupId/advisor', async (req, res) => {
    try {
      const { messages, email, emailVerifyToken } = req.body || {};
      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ success: false, error: 'messages array required' });
      }
      // Verified-email gate: same proof the real send requires; doubles as
      // the anti-abuse identity for rate limiting.
      const addr = String(email || '').trim();
      if (!emailVerifyToken || !addr || !emailTokenVerified(String(emailVerifyToken), addr)) {
        return res.status(403).json({ success: false, error: 'EMAIL_NOT_VERIFIED' });
      }
      // Metering: the first GROUP_ADVISOR_MAX_PER_WINDOW questions per
      // window are free; past that, each question COSTS a credit (2¢) —
      // the AI bill is real, and credits are how heavy users cover it.
      // No credits → 402 with the price, never a silent refusal.
      const now = Date.now();
      const rl = groupAdvisorRate.get(emailVerifyToken);
      let metered = false;
      if (rl && now < rl.resetAt && rl.count >= GROUP_ADVISOR_MAX_PER_WINDOW) {
        const paid = await chargeCredits(cloudant, addr, ADVISOR_QUESTION_CREDITS,
          `group advisor question beyond free ${GROUP_ADVISOR_MAX_PER_WINDOW}/window`);
        if (!paid) {
          return res.status(402).json({
            success: false,
            error: 'INSUFFICIENT_CREDITS',
            required: ADVISOR_QUESTION_CREDITS
          });
        }
        metered = true; // paid questions don't advance the free counter
      }
      if (!metered) {
        groupAdvisorRate.set(emailVerifyToken, (!rl || now >= rl.resetAt)
          ? { count: 1, resetAt: now + GROUP_ADVISOR_WINDOW_MS }
          : { count: rl.count + 1, resetAt: rl.resetAt });
      }
      if (groupAdvisorRate.size > 500) {
        for (const [k, v] of groupAdvisorRate) if (now >= v.resetAt) groupAdvisorRate.delete(k);
      }

      const doc = await cloudant.getDocument('maia_groups', req.params.groupId);
      if (!doc || doc.type !== 'group' || doc.publiclyListed !== true) {
        return res.status(404).json({ success: false, error: 'Group not found' });
      }

      // Sanitize history: bounded, roles constrained, content capped.
      const history = messages.slice(-10)
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
      if (!history.length) {
        return res.status(400).json({ success: false, error: 'no valid messages' });
      }

      const provider = ['deepseek', 'anthropic', 'openai', 'gemini']
        .find((p) => chatClient.isProviderAvailable(p));
      if (!provider) {
        return res.status(503).json({ success: false, error: 'No advisor model available' });
      }
      const response = await chatClient.chat(provider, [
        { role: 'system', content: buildGroupAdvisorContext(doc) },
        ...history
      ], {});
      res.json({ success: true, reply: String(response?.content || '').slice(0, 20000) });
    } catch (error) {
      console.error('[group-advisor] failed:', error?.message || error);
      res.status(500).json({ success: false, error: 'Advisor unavailable — try again shortly' });
    }
  });

  /** Log "Excluding Private AI" at most once per userId per process. */
  const excludedPrivateAILogged = new Set();

  /**
   * List available chat providers
   * GET /api/chat/providers
   * Private AI (digitalocean) is included when the user (or for deep link, the owner) has agent deployed.
   * For deep link sessions, also requires owner's allowDeepLinkPrivateAI !== false.
   */
  // Verify an agent is actually LIVE in DigitalOcean (resolves and has
  // a deployment URL) before we advertise it in the dropdown. A profile
  // can carry a stale agentId/endpoint round-tripped from a maia-state
  // backup that points at a destroyed agent — listing it produced the
  // "selected GPT, got 403" bug. Cached briefly so the frequently-
  // polled /api/chat/providers doesn't hammer the DO API.
  const agentLiveCache = new Map(); // agentId -> { live, ts }
  const AGENT_LIVE_TTL_MS = 30000;
  const verifyAgentLive = async (agentId) => {
    if (!agentId || !doClient) return false;
    const cached = agentLiveCache.get(agentId);
    if (cached && (Date.now() - cached.ts) < AGENT_LIVE_TTL_MS) return cached.live;
    let live = false;
    try {
      const a = await doClient.agent.get(agentId);
      // BOTH conditions required: a deployment URL AND STATUS_RUNNING.
      // A URL alone can return 403 on the first request while the agent
      // is still booting (the regression behind "selected the agent, got
      // AGENT_NOT_READY / 403"). Restore declared itself complete on
      // URL-present, then the dropdown advertised an agent that wasn't
      // actually serving yet.
      const status = a?.deployment?.status;
      live = !!(a?.deployment?.url) && status === 'STATUS_RUNNING';
    } catch {
      live = false; // 404 / destroyed / unreachable → not live
    }
    agentLiveCache.set(agentId, { live, ts: Date.now() });
    return live;
  };

  // Describe which Private AI agents (profiles) are deployed for a doc.
  // The frontend renders one dropdown entry per ready profile and sends
  // `agentProfileKey` alongside provider 'digitalocean'.
  // Label is derived from the ACTUAL model behind each profile, not from
  // the profile key. Profile keys 'default' / 'gpt' are historical slots.
  // A user-chosen secondary carries the catalog's display name
  // (modelDisplayName); older agents fall back to a family name.
  const labelForModel = (modelName, displayName) => {
    if (displayName) return `Private AI (${displayName})`;
    const m = String(modelName || '').toLowerCase();
    if (m.includes('kimi')) return 'Private AI (Kimi)';
    if (m.includes('gpt')) return 'Private AI (GPT)';
    if (m.includes('deepseek')) return 'Private AI (Deepseek)';
    if (m.includes('qwen')) return 'Private AI (Qwen)';
    return 'Private AI';
  };
  // Primary ('default') always first, then the secondary ('gpt').
  const sortKeyForProfile = (key) => (key === 'default' ? 0 : 1);

  const buildPrivateAiProfiles = async (doc) => {
    if (!doc) return [];
    const out = [];
    const profiles = (doc.agentProfiles && typeof doc.agentProfiles === 'object') ? doc.agentProfiles : {};

    // 'default' slot — also satisfied by the flat fields for legacy docs
    // that predate agentProfiles. Same liveness gate as the other slot:
    // STATUS_RUNNING + URL (a URL-only / STATUS_DEPLOYING agent 403s on
    // first request).
    const def = profiles.default || {};
    const primaryAgentId = def.agentId || doc.assignedAgentId || null;
    const primaryEndpoint = def.endpoint || doc.agentEndpoint || null;
    if (primaryAgentId && primaryEndpoint && await verifyAgentLive(primaryAgentId)) {
      const model = def.modelName || doc.agentModelName || 'openai-gpt-oss-120b';
      out.push({ key: 'default', label: labelForModel(model), model });
    }

    // 'gpt' slot (historical name — may hold GPT, Deepseek, or other model).
    const gpt = profiles.gpt || {};
    if (gpt.agentId && gpt.endpoint && await verifyAgentLive(gpt.agentId)) {
      const model = gpt.modelName || gpt.modelId || 'secondary';
      out.push({ key: 'gpt', label: labelForModel(model, gpt.modelDisplayName), model });
    }

    out.sort((a, b) => sortKeyForProfile(a.key) - sortKeyForProfile(b.key));
    return out;
  };

  // Personal AS edition: public AIs and the secondary Private AI appear
  // only when the account has them turned on (the feature guard refuses
  // the chat calls too). No-op in the full edition.
  const editionFiltered = (providers, profiles, doc) => ({
    providers: isFeatureEnabled('public-ai', doc) ? providers : providers.filter((p) => p === 'digitalocean'),
    privateAiProfiles: isFeatureEnabled('second-ai', doc) ? profiles : profiles.filter((p) => p.key !== 'gpt')
  });

  app.get('/api/chat/providers', async (req, res) => {
    let providers = chatClient.getAvailableProviders();
    let featureDoc = null;
    let privateAiProfiles = [];
    const userId = req.session?.userId;
    const isDeepLink = !!req.session?.isDeepLink;

    if (isDeepLink && (req.session?.deepLinkShareId || req.session?.deepLinkChatId) && cloudant) {
      try {
        let chat = null;
        if (req.session.deepLinkShareId) {
          chat = await findChatByShareId(cloudant, req.session.deepLinkShareId);
        }
        if (!chat && req.session.deepLinkChatId) {
          try {
            chat = await cloudant.getDocument('maia_chats', req.session.deepLinkChatId);
          } catch (_) {}
        }
        if (chat) {
          const ownerId = resolveAgentOwnerId(chat);
          if (ownerId) {
            const ownerDoc = await cloudant.getDocument('maia_users', ownerId);
            const ownerHasAgent = ownerDoc?.workflowStage === 'agent_deployed' ||
              !!(ownerDoc?.assignedAgentId && ownerDoc?.agentEndpoint);
            const ownerAllows = ownerDoc?.allowDeepLinkPrivateAI !== false;
            featureDoc = ownerDoc;
            if (ownerHasAgent && ownerAllows) {
              res.json(editionFiltered(providers, await buildPrivateAiProfiles(ownerDoc), ownerDoc));
              return;
            }
          }
        }
      } catch (err) {
        console.warn('[chat/providers] Deep link owner check failed:', err?.message);
      }
      providers = providers.filter((p) => p !== 'digitalocean');
    } else if (userId && cloudant && doClient) {
      try {
        let userDoc = await cloudant.getDocument('maia_users', userId);
        featureDoc = userDoc;
        let hasAgentDeployed = userDoc?.workflowStage === 'agent_deployed' ||
          (userDoc?.assignedAgentId && userDoc?.agentEndpoint);
        // If user has a KB (or active workflow) but no agent yet, create agent so it can become ready
        if (!hasAgentDeployed && (userDoc?.kbId || userDoc?.workflowStage === 'active' || userDoc?.workflowStage === 'files_archived' || userDoc?.workflowStage === 'indexing')) {
          try {
            userDoc = await ensureUserAgent(doClient, cloudant, userDoc);
            hasAgentDeployed = userDoc?.workflowStage === 'agent_deployed' ||
              !!(userDoc?.assignedAgentId && userDoc?.agentEndpoint);
          } catch (ensureErr) {
            console.warn('[chat/providers] ensureUserAgent failed:', ensureErr?.message);
          }
        }
        if (!hasAgentDeployed) {
          if (providers.includes('digitalocean')) {
            if (!excludedPrivateAILogged.has(userId)) {
              excludedPrivateAILogged.add(userId);
              console.log(`[chat/providers] Excluding Private AI for ${userId}: workflowStage=${userDoc?.workflowStage ?? 'undefined'} assignedAgentId=${userDoc?.assignedAgentId ? 'set' : 'unset'} agentEndpoint=${userDoc?.agentEndpoint ? 'set' : 'unset'}`);
            }
          }
          providers = providers.filter((p) => p !== 'digitalocean');
        } else {
          // REPAIR (not create) the secondary agent if it was previously
          // deployed but is now stale (destroyed agent, missing endpoint
          // after Restore). Only repair when agentProfiles.gpt.agentId
          // already exists — first creation is the user's action via the
          // Deploy button in My AI Agent.
          if (userDoc?.kbId && isFeatureEnabled('second-ai', userDoc)) {
            const gptProf = userDoc?.agentProfiles?.gpt;
            if (gptProf?.agentId) {
              const gptLive = await verifyAgentLive(gptProf.agentId);
              if (!gptProf?.endpoint || !gptLive) {
                try {
                  userDoc = await ensureSecondaryAgent(doClient, cloudant, userDoc);
                  const newId = userDoc?.agentProfiles?.gpt?.agentId;
                  if (newId) agentLiveCache.delete(newId);
                } catch (gptErr) {
                  console.warn('[chat/providers] ensureSecondaryAgent repair failed:', gptErr?.message);
                }
              }
            }
            // Connect the user's KB to a secondary chosen before the KB
            // existed (e.g. picked before the first indexing). Once per KB,
            // and never when the user disconnected it from this agent.
            const gp = userDoc?.agentProfiles?.gpt;
            if (gp?.agentId && gp.endpoint && gp.kbAttachedId !== userDoc.kbId
                && userDoc.kbConnections?.gpt?.kb1 !== false) {
              let attached = false;
              try {
                await doClient.agent.attachKB(gp.agentId, userDoc.kbId);
                attached = true;
              } catch (e) {
                const msg = String(e?.message || '');
                attached = msg.includes('already') || msg.includes('409');
                if (!attached) console.warn('[chat/providers] secondary KB attach failed (will retry):', msg);
              }
              for (let attempt = 0; attached && attempt < 3; attempt++) {
                try {
                  const doc = await cloudant.getDocument('maia_users', userId);
                  if (!doc?.agentProfiles?.gpt) break;
                  doc.agentProfiles.gpt.kbAttachedId = userDoc.kbId;
                  doc.updatedAt = new Date().toISOString();
                  await cloudant.saveDocument('maia_users', doc);
                  userDoc = doc;
                  break;
                } catch (err) {
                  if (err?.statusCode !== 409) break;
                }
              }
            }
          }
          privateAiProfiles = await buildPrivateAiProfiles(userDoc);
        }
      } catch (err) {
        console.warn('[chat/providers] Could not load user doc, excluding Private AI:', err?.message);
        providers = providers.filter((p) => p !== 'digitalocean');
      }
    } else {
      providers = providers.filter((p) => p !== 'digitalocean');
    }
    res.json({ ...editionFiltered(providers, privateAiProfiles, featureDoc), providerModels: chatClient.getProviderModels() });
  });
}
