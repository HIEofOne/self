/**
 * Chat routes for AI provider integrations
 */

import { ChatClient } from '../../lib/chat-client/index.js';
import { DigitalOceanProvider } from '../../lib/chat-client/providers/digitalocean.js';
import { getOrCreateAgentApiKey, recreateAgentApiKey } from '../utils/agent-helper.js';
import { ensureUserAgent } from './auth.js';

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

export default function setupChatRoutes(app, chatClient, cloudant, doClient) {
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

          const apiKey = await getOrCreateAgentApiKey(doClient, cloudant, userId, agentId);

          userAgentProvider = new DigitalOceanProvider(apiKey, {
            baseURL: profileEndpoint
          });

          if (profileModelName) {
            options.model = profileModelName;
          } else {
            options.model = profileAgentName;
          }
        } else {
          return res.status(404).json({
            error: 'Private AI agent not provisioned for this user',
            type: 'AGENT_NOT_FOUND',
            status: 404
          });
        }
      }

      const startTime = Date.now();

      // Check if streaming is requested
      const stream = options.stream || req.headers.accept === 'text/event-stream';

      // Use user-specific agent provider if available, otherwise use default
      if (stream) {
        // Setup SSE streaming
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // Handle streaming updates
        if (userAgentProvider) {
          await userAgentProvider.chat(messages, { ...options, stream: true }, 
            (update) => {
              res.write(`data: ${JSON.stringify(update)}\n\n`);
              
              if (update.isComplete) {
                res.end();
              }
            }
          );
        } else {
          await chatClient.chat(provider, messages, { ...options, stream: true }, 
            (update) => {
              res.write(`data: ${JSON.stringify(update)}\n\n`);
              
              if (update.isComplete) {
                res.end();
              }
            }
          );
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
      
      // Handle 401 Unauthorized on agent endpoints - recreate the API key
      const resolvedUserId = agentOwnerId || userId || bodyUserId;
      const resolvedAgentId = agentId;
      if (statusCode === 401 && userAgentProvider && resolvedUserId && resolvedAgentId && cloudant && doClient) {
        console.error(`401 Unauthorized on agent endpoint for agent ${resolvedAgentId}. Attempting to recreate API key...`);
        
        try {
          // Recreate the API key (already imported at top of file)
          const newApiKey = await recreateAgentApiKey(doClient, cloudant, resolvedUserId, resolvedAgentId);
          console.log(`✅ Successfully recreated API key for agent ${resolvedAgentId}`);
          
          errorMessage = 'Authentication failed for your Private AI agent. The API key has been automatically recreated. Please try your request again.';
        } catch (recreateError) {
          console.error(`Failed to recreate API key for agent ${resolvedAgentId}:`, recreateError.message);
          errorMessage = 'Authentication failed for your Private AI agent. Please contact support if this issue persists.';
        }
      } else if (statusCode === 401 && userAgentProvider) {
        errorMessage = 'Authentication failed for your Private AI agent. The API key may need to be recreated.';
        console.error('401 Unauthorized on agent endpoint (could not recreate key - missing info)');
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

  /** Log "Excluding Private AI" at most once per userId per process. */
  const excludedPrivateAILogged = new Set();

  /**
   * List available chat providers
   * GET /api/chat/providers
   * Private AI (digitalocean) is included when the user (or for deep link, the owner) has agent deployed.
   * For deep link sessions, also requires owner's allowDeepLinkPrivateAI !== false.
   */
  app.get('/api/chat/providers', async (req, res) => {
    let providers = chatClient.getAvailableProviders();
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
            if (ownerHasAgent && ownerAllows) {
              res.json({ providers });
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
        }
      } catch (err) {
        console.warn('[chat/providers] Could not load user doc, excluding Private AI:', err?.message);
        providers = providers.filter((p) => p !== 'digitalocean');
      }
    } else {
      providers = providers.filter((p) => p !== 'digitalocean');
    }
    res.json({ providers });
  });
}
