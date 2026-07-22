/**
 * maia-cloud-user-app server
 * User app backend with passkey authentication
 */

import express from 'express';
import multer from 'multer';
import dotenv from 'dotenv';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { createHmac, createPrivateKey, sign as edSign } from 'crypto';

import { CloudantClient, CloudantSessionStore, AuditLogService } from '../lib/cloudant/index.js';
import { DigitalOceanClient } from '../lib/do-client/index.js';
import { PasskeyService } from '../lib/passkey/index.js';
import { generateCurrentMedicationsToken } from './utils/token-service.js';
import { computeRecordsPipeline, decideNextAction } from './records-pipeline.js';
import { moveObjectWithVerify } from './utils/spaces-move.js';
import { deleteObjectWithLog , asciiSafeMetadata } from './utils/spaces-ops.js';
import { ChatClient } from '../lib/chat-client/index.js';
import { findUserAgent, getOrCreateAgentApiKey } from './utils/agent-helper.js';
import { getClinicalPrompt } from './utils/clinical-prompts.js';
import { normalizeStorageEnv, getSpacesEndpoint, getSpacesBucketName, getSpacesRegion } from './utils/storage-config.js';
import { getDoRegion, getPort } from './utils/new-agent-config.js';
import { getOrCreateOpenSearchDatabaseId } from './utils/opensearch-config.js';
import { getEmbeddingModelIdForKb, getEmbeddingModelNameFromNewAgent } from './utils/embedding-model-config.js';
import { getChunkingForDataSource, getChunkingForStrategy, getRerankingModelName } from './utils/kb-config.js';
import { getProjectIdForGenAI } from './utils/project-config.js';
import setupAuthRoutes from './routes/auth.js';
import setupChatRoutes, { getOwnerIdForDeepLinkSession } from './routes/chat.js';
import setupFileRoutes from './routes/files.js';
import { getUserBucketSize } from './routes/files.js';
import setupGroupRoutes from './routes/groups.js';
import setupPolicyRoutes from './routes/policies.js';
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
  GetObjectCommand,
  PutObjectCommand
} from '@aws-sdk/client-s3';

dotenv.config();

// Defense-in-depth: a stray unhandled promise rejection (e.g. a DO API
// timeout in a fire-and-forget path) must NEVER take down the whole
// server — that turns one failed call into every endpoint returning
// 500. Log it loudly and keep running.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] (non-fatal, server kept alive):',
    reason instanceof Error ? `${reason.name}: ${reason.message}` : reason);
});

const storageConfig = normalizeStorageEnv();

/**
 * Get or create a DO Inference Model Access Key.
 * Creates key via DO API and caches it in CouchDB for persistence across restarts.
 * Returns the secret key string, or null if unavailable.
 */
async function getOrCreateModelAccessKey(cloudant) {
  const token = process.env.DIGITALOCEAN_TOKEN;
  if (!token) return null;

  const configDb = 'maia_config';
  const docId = 'do_inference_key';

  // Ensure the config database exists
  try { await cloudant.createDatabase(configDb); } catch (_) { /* already exists */ }

  // Try to read cached key from CouchDB, then validate it
  try {
    const doc = await cloudant.getDocument(configDb, docId);
    if (doc.secret_key) {
      // Validate the cached key with a lightweight models list call
      try {
        const check = await fetch('https://inference.do-ai.run/v1/models', {
          headers: { 'Authorization': `Bearer ${doc.secret_key}` }
        });
        if (check.ok) {
          try {
            const modelsData = await check.json();
            const ids = (modelsData.data || []).map(m => m.id);
            originalConsoleLog(`[DO Inference] Using cached Model Access Key (validated). Available models: ${ids.join(', ')}`);
          } catch (_) {
            originalConsoleLog('[DO Inference] Using cached Model Access Key (validated)');
          }
          return doc.secret_key;
        }
        originalConsoleLog(`[DO Inference] Cached key returned ${check.status} — rotating`);
        // Delete the stale doc so we create a fresh key below
        try { await cloudant.deleteDocument(configDb, docId, doc._rev); } catch (_) { /* ignore */ }
      } catch (valErr) {
        originalConsoleLog(`[DO Inference] Cached key validation failed: ${valErr.message} — rotating`);
        try { await cloudant.deleteDocument(configDb, docId, doc._rev); } catch (_) { /* ignore */ }
      }
    }
  } catch (_) { /* doc doesn't exist — create below */ }

  // Create a new key via DO API
  try {
    const resp = await fetch('https://api.digitalocean.com/v2/gen-ai/models/api_keys', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: `maia-inference-${Date.now()}` })
    });
    if (!resp.ok) {
      originalConsoleLog(`[DO Inference] Failed to create Model Access Key: ${resp.status}`);
      return null;
    }
    const data = await resp.json();
    const secretKey = data.api_key_info?.secret_key;
    if (!secretKey) return null;

    // Cache in CouchDB for persistence across restarts
    try {
      await cloudant.saveDocument(configDb, {
        _id: docId,
        secret_key: secretKey,
        uuid: data.api_key_info.uuid,
        created_at: data.api_key_info.created_at
      });
    } catch (e) {
      originalConsoleLog('[DO Inference] Could not cache key in CouchDB:', e.message);
    }

    originalConsoleLog('[DO Inference] Created new Model Access Key');
    return secretKey;
  } catch (e) {
    originalConsoleLog('[DO Inference] Error creating key:', e.message);
    return null;
  }
}

/** Derive a stable session secret from the DO token (same approach as CouchDB password). */
function deriveSessionSecret() {
  const token = process.env.DIGITALOCEAN_TOKEN;
  if (token) {
    return createHmac('sha256', token).update('maia-session-secret').digest('base64url').slice(0, 32);
  }
  return 'change-this-secret';
}

const SUPPRESSED_LOG_PATTERN = /\[(NEW FLOW 2|STARTUP|STORAGE|WELCOME|WIZARD|LOCAL|KB UPDATE|KB AUTO|KB|WIZ|CATCH-ALL)\]/i;
const shouldSuppressLog = (args) =>
  Array.isArray(args) && args.some(arg => typeof arg === 'string' && SUPPRESSED_LOG_PATTERN.test(arg));
const originalConsoleLog = console.log.bind(console);
const originalConsoleWarn = console.warn.bind(console);
const originalConsoleError = console.error.bind(console);
const wizAttachLogState = new Map();
console.log = (...args) => {
  if (shouldSuppressLog(args)) return;
  originalConsoleLog(...args);
};
console.warn = (...args) => {
  if (shouldSuppressLog(args)) return;
  originalConsoleWarn(...args);
};
console.error = (...args) => {
  if (shouldSuppressLog(args)) return;
  originalConsoleError(...args);
};

const logWizAttachCheck = (key, state, message) => {
  const serialized = JSON.stringify(state);
  if (wizAttachLogState.get(key) === serialized) return;
  wizAttachLogState.set(key, serialized);
  console.log(message);
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function logStorageConfig(_config) {}

function getBucketName(bucketUrl) {
  if (!bucketUrl) return 'maia';
  const withoutProtocol = bucketUrl.replace(/^https?:\/\//, '');
  const hostOrName = withoutProtocol.split('/')[0];
  return hostOrName.split('.')[0] || 'maia';
}

async function ensureBucketExists() {
  const bucketUrl = getSpacesBucketName();
  if (!bucketUrl) {
    return;
  }

  const bucketName = getBucketName(bucketUrl);
  const endpoint = getSpacesEndpoint();
  const accessKeyId = process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '';
  const secretAccessKey = process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || '';
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true';

  if (!accessKeyId || !secretAccessKey) {
    return;
  }

  const s3Client = new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle,
    credentials: {
      accessKeyId,
      secretAccessKey
    }
  });

  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
  } catch (error) {
    const statusCode = error?.$metadata?.httpStatusCode;
    if (statusCode === 404 || error?.name === 'NotFound') {
      try {
        await s3Client.send(new CreateBucketCommand({ Bucket: bucketName }));
      } catch (createError) {
      }
      return;
    }
  }
}

function shouldUseEphemeralSpaces() {
  if (process.env.KB_USE_EPHEMERAL_SPACES === 'true') {
    return true;
  }
  return false;
}

function getSpacesConfig() {
  const endpoint = getSpacesEndpoint();
  const region = getSpacesRegion();
  const accessKeyId = process.env.SPACES_AWS_ACCESS_KEY_ID || process.env.SPACES_ACCESS_KEY_ID;
  const secretAccessKey = process.env.SPACES_AWS_SECRET_ACCESS_KEY || process.env.SPACES_SECRET_ACCESS_KEY;
  const bucketPrefix = process.env.SPACES_BUCKET_PREFIX || 'maia-kb-temp';

  if (!accessKeyId || !secretAccessKey) {
    return null;
  }

  return { endpoint, region, accessKeyId, secretAccessKey, bucketPrefix };
}

function createSpacesClient(config) {
  return new S3Client({
    endpoint: config.endpoint,
    region: 'us-east-1',
    forcePathStyle: false,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  });
}

function buildEphemeralBucketName(prefix, userId, kbName) {
  const base = `${prefix}-${userId}-${kbName}-${Date.now()}`;
  const sanitized = base
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return sanitized.slice(0, 63).replace(/-+$/g, '') || `${prefix}-${Date.now()}`;
}

async function createEphemeralSpacesBucket(config, userId, kbName) {
  const bucketName = buildEphemeralBucketName(config.bucketPrefix, userId, kbName);
  const spacesClient = createSpacesClient(config);

  await spacesClient.send(new CreateBucketCommand({ Bucket: bucketName }));
  console.log(`🪣 [SPACES] Created ephemeral bucket: ${bucketName}`);

  return { bucketName, client: spacesClient };
}

async function copyKeysToSpaces({ sourceClient, sourceBucket, destClient, destBucket, keys, destKeyFor }) {
  for (const key of keys) {
    const destKey = typeof destKeyFor === 'function' ? destKeyFor(key) : key;
    const getResponse = await sourceClient.send(new GetObjectCommand({
      Bucket: sourceBucket,
      Key: key
    }));

    const contentLength = getResponse.ContentLength;
    const body = getResponse.Body;

    if (!contentLength) {
      const chunks = [];
      for await (const chunk of body) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      await destClient.send(new PutObjectCommand({
        Bucket: destBucket,
        Key: destKey,
        Body: buffer,
        ContentLength: buffer.length,
        ContentType: getResponse.ContentType || 'application/octet-stream'
      }));
      continue;
    }

    await destClient.send(new PutObjectCommand({
      Bucket: destBucket,
      Key: destKey,
      Body: body,
      ContentLength: contentLength,
      ContentType: getResponse.ContentType || 'application/octet-stream'
    }));
  }
}

const TEMP_KB_PREFIX = 'kb-src-';

function normalizeDataSourcePath(path) {
  if (!path) return null;
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

function buildTempKbFolder(userId, kbName) {
  return `${userId}/${kbName}/`;
}

// Clean-index sidecar subfolder. For KBs created with footer-stripped
// indexing (userDoc.kbCleanIndex === true), the DO data source points at
// this subfolder (which contains only the cleaned .txt sidecars), NOT the
// PDF folder — so RAG never sees the repeating "Generated on … Page N"
// footer dates / boilerplate. The PDFs stay in the KB folder for viewing,
// page-links, membership, and Restore (all unchanged).
const CLEAN_INDEX_SUBFOLDER = '_clean';
function kbCleanIndexFolder(userId, kbName) {
  return `${userId}/${kbName}/${CLEAN_INDEX_SUBFOLDER}/`;
}

function buildKbDataSourcePath(userId, kbName, _sourceKey, useEphemeralSpaces, cleanIndex = false) {
  if (useEphemeralSpaces) {
    return buildTempKbFolder(userId, kbName);
  }
  if (cleanIndex) {
    return kbCleanIndexFolder(userId, kbName);
  }
  return `${userId}/${kbName}/`;
}

function buildTempKbObjectKey(userId, kbName, sourceKey) {
  const fileName = sourceKey.split('/').pop() || sourceKey;
  return `${buildTempKbFolder(userId, kbName)}${fileName}`;
}


function isKbFolderDataSourcePath(path, userId, kbName) {
  const normalizedPath = normalizeDataSourcePath(path);
  if (!normalizedPath) return false;
  // Accept the PDF folder (legacy/standard) OR the clean-index sidecar
  // folder (footer-stripped KBs). Both represent "the KB's folder data
  // source" for membership/dedup/restore purposes.
  return normalizedPath === `${userId}/${kbName}` ||
         normalizedPath === `${userId}/${kbName}/${CLEAN_INDEX_SUBFOLDER}`;
}

async function ensureSingleKbDataSource(kbId, bucketName, folderPath, region, userId, kbName) {
  const dataSources = await doClient.kb.listDataSources(kbId);
  const normalizedFolder = normalizeDataSourcePath(folderPath);
  let folderDataSource = null;
  const deletions = [];

  for (const ds of dataSources || []) {
    const dsPath = ds.item_path || ds.path || ds.spaces_data_source?.item_path;
    const normalizedPath = normalizeDataSourcePath(dsPath);
    const isSpaces = !!ds.spaces_data_source;
    const isFolderPath = isKbFolderDataSourcePath(dsPath, userId, kbName);

    if (isFolderPath) {
      if (!folderDataSource) {
        folderDataSource = ds;
      } else {
        deletions.push(ds);
      }
      continue;
    }

    if (isSpaces && normalizedPath && normalizedFolder && normalizedPath.startsWith(`${normalizedFolder}/`)) {
      deletions.push(ds);
    } else if (isSpaces && dsPath && dsPath.includes(`/${TEMP_KB_PREFIX}`)) {
      deletions.push(ds);
    }
  }

  for (const ds of deletions) {
    const dsUuid = ds.uuid || ds.id;
    if (!dsUuid) continue;
    try {
      await doClient.kb.deleteDataSource(kbId, dsUuid);
    } catch (error) {
      console.warn(`[KB Update] ⚠️ Failed to delete legacy datasource ${dsUuid}: ${error.message}`);
    }
  }

  if (!folderDataSource) {
    const created = await doClient.kb.addDataSource(kbId, {
      bucketName,
      itemPath: folderPath,
      region
    });
    folderDataSource = created;
  }

  const folderUuid = folderDataSource?.uuid || folderDataSource?.id || folderDataSource?.knowledge_base_data_source?.uuid || null;
  return {
    dataSourceUuid: folderUuid,
    dataSources: Array.isArray(dataSources) ? dataSources : [],
    folderPath
  };
}

async function deleteSpacesBucket(config, bucketName) {
  const spacesClient = createSpacesClient(config);
  let continuationToken;

  do {
    const listResponse = await spacesClient.send(new ListObjectsV2Command({
      Bucket: bucketName,
      ContinuationToken: continuationToken
    }));

    const objects = (listResponse.Contents || []).map(obj => ({ Key: obj.Key }));
    if (objects.length > 0) {
      await spacesClient.send(new DeleteObjectsCommand({
        Bucket: bucketName,
        Delete: { Objects: objects }
      }));
    }

    continuationToken = listResponse.IsTruncated ? listResponse.NextContinuationToken : undefined;
  } while (continuationToken);

  await spacesClient.send(new DeleteBucketCommand({ Bucket: bucketName }));
  console.log(`🪣 [SPACES] Deleted ephemeral bucket: ${bucketName}`);
}

/**
 * Generate agent name for a user
 * Format: {userId}-agent-{YYYYMMDD}-{HHMMSS}
 */
function generateAgentName(userId) {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0].replace(/-/g, ''); // YYYYMMDD in UTC
  const timeStr = now.toISOString().split('T')[1].split('.')[0].replace(/:/g, ''); // HHMMSS in UTC
  return `${userId}-agent-${dateStr}-${timeStr}`;
}

/**
 * Generate KB name for a user
 * Format: {userId}-kb-{YYYYMMDD}{timestamp}
 */
function generateKBName(userId) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('T')[0]; // YYYYMMDD
  // New KBs are the PRIMARY (semantic) KB → "-1" suffix. The alternate
  // hierarchical KB is "-2" (see deriveKb2Name). Existing accounts keep
  // their original (suffix-less) name and are adopted as KB-1.
  return `${userId}-kb-${timestamp}${Date.now().toString().slice(-6)}-1`;
}

// Derive the alternate (KB-2) name from the primary KB name. Replaces a
// trailing "-1" with "-2"; legacy names with no suffix just get "-2".
function deriveKb2Name(kb1Name) {
  if (!kb1Name) return null;
  return /-1$/.test(kb1Name) ? kb1Name.replace(/-1$/, '-2') : `${kb1Name}-2`;
}

/**
 * Create bucket folders for a user (root, archived, and KB subfolder)
 * This is called during registration to enable file uploads before admin approval
 */
async function createUserBucketFolders(userId, kbName) {
  const bucketUrl = getSpacesBucketName();
  if (!bucketUrl) {
    throw new Error('DigitalOcean bucket not configured');
  }
  
  const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';
  
  try {
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const s3Client = new S3Client({
      endpoint: getSpacesEndpoint(),
      region: 'us-east-1',
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      credentials: {
        accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
      }
    });
    
    // Create placeholder files to make folders visible in dashboard
    const rootPlaceholder = `${userId}/.keep`;
    const archivedPlaceholder = `${userId}/archived/.keep`;
    
    // Create root userId folder placeholder (for new imports)
    // Use Buffer.from('') instead of empty string to avoid SDK warning about stream length
    await s3Client.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: rootPlaceholder,
      Body: Buffer.from(''),
      ContentType: 'text/plain',
      ContentLength: 0,
      Metadata: {
        createdBy: 'registration',
        createdAt: new Date().toISOString()
      }
    }));
    // Create archived folder placeholder (for files moved from root)
    await s3Client.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: archivedPlaceholder,
      Body: Buffer.from(''),
      ContentType: 'text/plain',
      ContentLength: 0,
      Metadata: {
        createdBy: 'registration',
        createdAt: new Date().toISOString()
      }
    }));
    return { root: `${userId}/`, archived: `${userId}/archived/`, kb: `${userId}/${kbName}/` };
  } catch (err) {
    throw new Error(`Failed to create bucket folders: ${err.message}`);
  }
}

/**
 * Generate footer-stripped text "sidecars" for clean-index KBs.
 *
 * For each PDF in the KB folder, extract its text (pdf-parse), strip the
 * repeating page header/footer boilerplate (including the "Generated on …
 * Page N" date/time), and upload the result to the KB's `_clean/`
 * subfolder as `<originalName>.txt`. The DO data source for a clean-index
 * KB points at `_clean/`, so RAG indexes only this footer-free text. The
 * original PDFs are untouched (viewing / page-links / membership / Restore
 * all keep using them). Best-effort: a file that fails to parse is skipped.
 *
 * Returns { written, skipped, folder }.
 */
async function generateCleanIndexSidecars(userId, kbName, kbFiles) {
  const bucketUrl = getSpacesBucketName();
  if (!bucketUrl) return { written: 0, skipped: 0, folder: null };
  const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';
  const folder = kbCleanIndexFolder(userId, kbName);
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const s3Client = new S3Client({
    endpoint: getSpacesEndpoint(),
    region: 'us-east-1',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    credentials: {
      accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || process.env.SPACES_AWS_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || process.env.SPACES_AWS_SECRET_ACCESS_KEY || ''
    }
  });
  const pdfParse = (await import('pdf-parse')).default;
  const { stripHeadersFooters } = await import('./utils/encounters-extractor.js');

  const pdfs = (kbFiles || []).filter(f =>
    f?.bucketKey && (/\.pdf$/i.test(f.fileName || '') || /pdf/i.test(f.fileType || ''))
  );
  let written = 0, skipped = 0;
  for (const f of pdfs) {
    try {
      const buf = await readSpacesObjectBuffer(f.bucketKey);
      if (!buf) { skipped++; continue; }
      const data = await pdfParse(buf);
      const cleaned = stripHeadersFooters(data.text, data.numpages);
      const base = (f.fileName || f.bucketKey.split('/').pop() || 'document.pdf')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/\.pdf$/i, '');
      await s3Client.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: `${folder}${base}.txt`,
        Body: Buffer.from(cleaned, 'utf-8'),
        ContentType: 'text/plain'
      }));
      written++;
    } catch (e) {
      skipped++;
      console.warn(`[clean-index] sidecar failed for ${f.fileName}: ${e?.message || e}`);
    }
  }
  console.log(`[clean-index] ${userId}/${kbName}: wrote ${written} sidecar(s), skipped ${skipped} → ${folder}`);
  return { written, skipped, folder };
}

async function deleteKbFolderPlaceholder(userId, kbName) {
  const bucketUrl = getSpacesBucketName();
  if (!bucketUrl || !userId || !kbName) return;
  const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';
  try {
    const { S3Client } = await import('@aws-sdk/client-s3');
    const s3Client = new S3Client({
      endpoint: getSpacesEndpoint(),
      region: 'us-east-1',
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      credentials: {
        accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
      }
    });
    const kbPlaceholder = `${userId}/${kbName}/.keep`;
    await deleteObjectWithLog({
      s3Client,
      bucketName,
      key: kbPlaceholder
    });
  } catch (error) {
    // Ignore if not present or deletion fails
  }
}

/**
 * Get KB name from user document
 * 
 * Naming Convention:
 * - kbName: PERMANENT KB name set during provisioning (NEVER deleted or changed)
 *   This is the source of truth for the KB name and prevents generating new names.
 *   It's set once during provisioning and remains forever, even after KB exists in DO.
 * - connectedKBs: Array of KB names that actually exist in DigitalOcean and are connected
 *   Used for runtime tracking, but kbName takes precedence.
 * - connectedKB: Legacy field for backward compatibility (should indicate actual connected KB)
 * 
 * Priority order:
 * 1. kbName (permanent, set during provisioning - ALWAYS use this if it exists)
 * 2. connectedKBs array (runtime tracking of actual connected KBs)
 * 3. connectedKB field (legacy, for migration)
 * 4. Generate new name ONLY if kbName was never set (shouldn't happen after provisioning)
 */
function getKBNameFromUserDoc(userDoc, userId) {
  // Priority order — return null if no name is stored.
  // NEVER generate a new name here; that causes different callers to get
  // different names (see Documentation/Wizards.md section 5).
  // KB names should only be generated once, at user doc creation time.

  // 1. kbName - PERMANENT KB name set during provisioning (NEVER deleted)
  if (userDoc.kbName) {
    return userDoc.kbName;
  }
  // 2. connectedKBs array - runtime tracking of actual connected KBs
  if (userDoc.connectedKBs && Array.isArray(userDoc.connectedKBs) && userDoc.connectedKBs.length > 0) {
    return userDoc.connectedKBs[0];
  }
  // 3. connectedKB field - legacy field for backward compatibility
  if (userDoc.connectedKB) {
    return userDoc.connectedKB;
  }
  // No KB name found — caller must handle null
  return null;
}

async function ensureKBNameOnUserDoc(userDoc, userId) {
  if (!userDoc) return null;
  let resolved = getKBNameFromUserDoc(userDoc, userId);
  // If no KB name exists anywhere, generate one and persist it.
  // This is the ONLY place a new KB name should be generated.
  if (!resolved) {
    resolved = generateKBName(userId);
  }
  if (!userDoc.kbName) {
    userDoc.kbName = resolved;
    userDoc.updatedAt = new Date().toISOString();
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
          userDoc.kbName = resolved;
          userDoc.updatedAt = new Date().toISOString();
        } else {
          throw error;
        }
      }
    }
  }
  return resolved;
}

/**
 * Read MAIA instruction text from NEW-AGENT.txt file
 * Extracts the instruction text from the "## MAIA INSTRUCTION TEXT" section
 */
function getMaiaInstructionText() {
  try {
    const newAgentFilePath = path.join(__dirname, '../NEW-AGENT.txt');
    const fileContent = readFileSync(newAgentFilePath, 'utf-8');
    
    // Find the start of the instruction section
    const instructionStartMarker = '## MAIA INSTRUCTION TEXT';
    const instructionStartIndex = fileContent.indexOf(instructionStartMarker);
    
    if (instructionStartIndex === -1) {
      throw new Error('MAIA INSTRUCTION TEXT section not found in NEW-AGENT.txt');
    }
    
    // Find the content after the marker and optional comment line
    let startIndex = instructionStartIndex + instructionStartMarker.length;
    const lines = fileContent.substring(startIndex).split('\n');
    
    // Skip empty lines and the comment line "(Full instruction from sun6 agent)"
    let instructionLines = [];
    let foundContent = false;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Stop at the next section marker (---)
      if (line.trim() === '---') {
        break;
      }
      
      // Skip empty lines at the start
      if (!foundContent && line.trim() === '') {
        continue;
      }
      
      // Skip comment lines in parentheses
      if (line.trim().startsWith('(') && line.trim().endsWith(')')) {
        continue;
      }
      
      foundContent = true;
      instructionLines.push(line);
    }
    
    // Join lines and trim
    const instructionText = instructionLines.join('\n').trim();
    
    if (!instructionText) {
      throw new Error('No instruction text found in MAIA INSTRUCTION TEXT section');
    }
    
    return instructionText;
  } catch (error) {
    console.error('❌ Error reading MAIA instruction text from NEW-AGENT.txt:', error.message);
    throw new Error(`Failed to load agent instructions: ${error.message}`);
  }
}

const app = express();
const PORT = getPort();

// Derive passkey/app URLs from PUBLIC_APP_URL (single source of truth); override with PASSKEY_RPID if needed
function getAppUrlConfig() {
  const raw = process.env.PUBLIC_APP_URL?.trim();
  const devOrigin = 'http://localhost:5173';
  if (raw) {
    try {
      const u = new URL(raw);
      const origin = u.origin;
      const host = u.hostname;
      const rpID = process.env.PASSKEY_RPID?.trim() || (host.includes('.') ? host.split('.').slice(-2).join('.') : host);
      // Include dev origin when PUBLIC_APP_URL is production so passkeys work in local dev
      const allowedOrigins = origin === devOrigin ? [origin] : [origin, devOrigin];
      return { appOrigin: origin, derivedRpID: rpID, allowedOrigins };
    } catch (_) {}
  }
  return {
    appOrigin: devOrigin,
    derivedRpID: process.env.PASSKEY_RPID?.trim() || 'localhost',
    allowedOrigins: [devOrigin]
  };
}
const appUrlConfig = getAppUrlConfig();

// Client-side diagnostic logging endpoint (shows browser events in server terminal)
app.post('/api/client-log', express.json(), (req, res) => {
  const { tag, msg } = req.body || {};
  console.log(`[CLIENT ${tag || '?'}] ${msg || ''}`);
  res.json({ ok: true });
});

// Start listening immediately so readiness probes pass while CouchDB droplet setup runs
app.get('/health', (req, res) => res.json({ status: 'ok', app: 'maia-cloud-user-app' }));
app.listen(PORT, () => console.log(`User app server listening on port ${PORT} (startup in progress)`));

// Auto-provision CouchDB droplet for cloud deployments (any non-localhost URL = cloud)
const appUrl = process.env.PUBLIC_APP_URL || '';
const isCloudDeployment = appUrl && !appUrl.includes('localhost') && !appUrl.includes('127.0.0.1');
if (isCloudDeployment || process.env.USE_COUCHDB_DROPLET === 'true') {
  const { ensureCouchDBDroplet } = await import('./utils/couchdb-droplet.js');
  await ensureCouchDBDroplet();
}

// Initialize clients
const cloudant = new CloudantClient({
  url: process.env.CLOUDANT_URL || 'http://localhost:5984',
  username: process.env.CLOUDANT_USERNAME || 'admin',
  password: process.env.CLOUDANT_PASSWORD || 'adminpass'
});

logStorageConfig(storageConfig);
ensureBucketExists();

// Initialize databases (retry Cloudant connection when CouchDB droplet is still warming)
(async () => {
  const useDroplet = isCloudDeployment || process.env.USE_COUCHDB_DROPLET === 'true';
  const cloudantUrl = process.env.CLOUDANT_URL || '';
  const targetHost = cloudantUrl.replace(/^https?:\/\//, '').replace(/^[^@]+@/, '').split('/')[0] || 'not set';
  console.log(`[Cloudant] Target: ${targetHost} (USE_COUCHDB_DROPLET=${useDroplet})`);

  const maxAttempts = useDroplet ? 10 : 1; // 5 min @ 30s (CouchDB can take 2.5+ min)
  const intervalMs = useDroplet ? 30000 : 0;
  let connected = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await cloudant.testConnection();
    if (result === true) { connected = true; break; }
    if (result === 'auth_error') {
      console.error(`❌ CouchDB authentication failed — stopping retries to avoid brute-force lockout.`);
      console.error('   Check CLOUDANT_USERNAME and CLOUDANT_PASSWORD. If using CouchDB droplet:');
      console.error('   SSH into droplet and run: docker inspect couchdb | grep COUCHDB_PASSWORD');
      console.error('   Then set the correct CLOUDANT_PASSWORD in App Platform environment variables.');
      return;
    }
    if (attempt < maxAttempts) {
      console.warn(`[Cloudant] Connection attempt ${attempt}/${maxAttempts} failed, retrying in ${intervalMs / 1000}s...`);
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }
  if (!connected) {
    console.error(`❌ Cloudant connection failed after ${maxAttempts} attempt(s). Target: ${targetHost}`);
    console.error('   Check CLOUDANT_URL, CLOUDANT_USERNAME, CLOUDANT_PASSWORD. If using CouchDB droplet: droplet running, port 5984 open, CouchDB bound to 0.0.0.0.');
    return;
  }

  const databases = ['maia_sessions', 'maia_users', 'maia_audit_log', 'maia_chats', 'maia_groups', 'maia_relay', 'maia_as_requests'];

  for (const dbName of databases) {
    try {
      await cloudant.createDatabase(dbName);
    } catch (error) {
    }
  }

  await runStartupUserValidation();
})();

const auditLog = new AuditLogService(cloudant, 'maia_audit_log');

// In-memory store for provisioning status (keyed by userId)
const provisioningStatus = new Map();

// In-memory store for provisioning logs (keyed by userId)
const provisioningLogs = new Map();

// Helper function to log provisioning events
const logProvisioning = (userId, message, level = 'info') => {
  if (!provisioningLogs.has(userId)) {
    provisioningLogs.set(userId, []);
  }
  const logs = provisioningLogs.get(userId);
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    message
  };
  logs.push(logEntry);
  // Keep only last 500 log entries per user
  if (logs.length > 500) {
    logs.shift();
  }
  // Do not log provisioning messages to console
};

// Append a structured event to the user's PERSISTENT provisioningLog
// (the array the client reads to render maia-log.pdf). Conflict-tolerant
// and never throws — telemetry must not break provisioning.
async function appendUserProvisioningEvent(userId, evt) {
  if (!userId || !evt) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fresh = await cloudant.getDocument('maia_users', userId);
      if (!fresh) return;
      if (!Array.isArray(fresh.provisioningLog)) fresh.provisioningLog = [];
      const maxId = fresh.provisioningLog.reduce((m, e) => Math.max(m, e.id || 0), 0);
      fresh.provisioningLog.push({ id: maxId + 1, time: new Date().toISOString(), ...evt });
      fresh.updatedAt = new Date().toISOString();
      await cloudant.saveDocument('maia_users', fresh);
      return;
    } catch (err) {
      if (err?.statusCode === 409 && attempt < 2) continue;
      console.warn(`[provisioning-log] could not append ${evt.event} for ${userId}: ${err?.message || err}`);
      return;
    }
  }
}

async function runStartupUserValidation() {
  try {
    const userDocs = await cloudant.getAllDocuments('maia_users');
    const users = userDocs.filter(doc => doc && (doc.type === 'user' || doc.userId));

    if (users.length === 0) {
      return;
    }
    for (const userDoc of users) {
      const userId = userDoc.userId || userDoc._id;
      if (!userId) {
        continue;
      }

      try {
        const kbName = getKBNameFromUserDoc(userDoc, userId);
        if (kbName) {
          await createUserBucketFolders(userId, kbName);
        }

        await validateUserResources(userId);
      } catch (error) {}
    }
  } catch (error) {}
}

// Log token presence for debugging (first 4 + last 4 chars only)
function maskToken(token) {
  if (!token || typeof token !== 'string') return '(not set)';
  const t = String(token).trim();
  if (t.length < 8) return t.length ? '(too short to display)' : '(empty)';
  return `${t.slice(0, 4)}...${t.slice(-4)}`;
}

const doToken = process.env.DIGITALOCEAN_TOKEN;
console.log(`[DO] DIGITALOCEAN_TOKEN at startup: ${doToken ? maskToken(doToken) : '(not set)'}`);

const doClient = new DigitalOceanClient(doToken, {
  region: getDoRegion()
});

// Resolve OpenSearch database_id at startup (for KB creation) — async, warms the cache
getOrCreateOpenSearchDatabaseId(doClient, cloudant).catch(err =>
  console.warn(`[OpenSearch] Startup resolution failed: ${err.message}`)
);

// Simple in-memory caches to reduce repeated DO API calls
const RESOURCE_CACHE_TTL = 30 * 1000; // 30 seconds
const KB_LIST_CACHE_TTL = 60 * 1000; // 1 minute
const AGENT_CACHE_TTL = 30 * 1000;
const KB_CACHE_TTL = 30 * 1000;

const resourceValidationCache = new Map(); // userId -> { timestamp, data }
const agentDetailsCache = new Map(); // agentId -> { timestamp, value }
const kbDetailsCache = new Map(); // kbId -> { timestamp, value }
let kbListCache = { timestamp: 0, value: null };

const isCacheEntryValid = (entry, ttl) => entry && Date.now() - entry.timestamp < ttl;

const isRateLimitError = (error) => {
  if (!error) return false;
  const message = (error.message || '').toLowerCase();
  return error.status === 429 || error.code === 429 || message.includes('too many requests') || message.includes('rate limit');
};

const getCachedAgent = async (agentId) => {
  if (!agentId) return null;
  const cacheEntry = agentDetailsCache.get(agentId);
  if (isCacheEntryValid(cacheEntry, AGENT_CACHE_TTL)) {
    return cacheEntry.value;
  }
  const value = await doClient.agent.get(agentId);
  agentDetailsCache.set(agentId, { timestamp: Date.now(), value });
  return value;
};

const getCachedKB = async (kbId) => {
  if (!kbId) return null;
  const cacheEntry = kbDetailsCache.get(kbId);
  if (isCacheEntryValid(cacheEntry, KB_CACHE_TTL)) {
    return cacheEntry.value;
  }
  const value = await doClient.kb.get(kbId);
  kbDetailsCache.set(kbId, { timestamp: Date.now(), value });
  return value;
};

const getCachedKBList = async () => {
  if (isCacheEntryValid(kbListCache, KB_LIST_CACHE_TTL) && Array.isArray(kbListCache.value)) {
    return kbListCache.value;
  }
  const list = await doClient.kb.list();
  kbListCache = { timestamp: Date.now(), value: list };
  return list;
};

const resolveKbForUserFromDo = async (userId, options = {}) => {
  if (!userId) return null;
  const forceRefresh = !!options.forceRefresh;
  const kbList = forceRefresh ? await doClient.kb.list() : await getCachedKBList();
  if (forceRefresh) {
    kbListCache = { timestamp: Date.now(), value: kbList };
  }
  const kbArray = Array.isArray(kbList)
    ? kbList
    : (kbList?.knowledge_bases || kbList?.data || []);
  const prefix = `${userId}-kb-`;
  const matches = kbArray
    .filter(kb => typeof kb?.name === 'string' && kb.name.startsWith(prefix))
    .map(kb => ({
      id: kb.uuid || kb.id || null,
      name: kb.name || null,
      createdAt: kb.created_at || kb.createdAt || kb.updated_at || kb.updatedAt || null
    }))
    .filter(kb => kb.id && kb.name);
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    const aTime = new Date(a.createdAt || 0).getTime();
    const bTime = new Date(b.createdAt || 0).getTime();
    return bTime - aTime;
  });
  return matches[0];
};

const isIndexingActiveStatus = (status) => (
  status === 'INDEX_JOB_STATUS_PENDING' ||
  status === 'INDEX_JOB_STATUS_RUNNING' ||
  status === 'INDEX_JOB_STATUS_IN_PROGRESS' ||
  status === 'pending' ||
  status === 'running' ||
  status === 'in_progress'
);

const persistKbIndexingStatus = async (userId, statusPayload) => {
  if (!userId || !statusPayload) return;
  let attempts = 0;
  while (attempts < 3) {
    attempts += 1;
    const doc = await cloudant.getDocument('maia_users', userId);
    if (!doc) return;
    doc.kbIndexingStatus = {
      ...(doc.kbIndexingStatus || {}),
      ...statusPayload,
      updatedAt: new Date().toISOString()
    };
    try {
      await cloudant.saveDocument('maia_users', doc);
      if (statusPayload.backendCompleted || statusPayload.phase === 'complete') {
        console.log(`[KB Status] ✅ Persisted kbIndexingStatus for ${userId}: phase=${statusPayload.phase} tokens=${statusPayload.tokens} backendCompleted=${statusPayload.backendCompleted}`);
      }
      return;
    } catch (error) {
      if (error?.statusCode === 409 && attempts < 3) {
        console.log(`[KB Status] ⚠️ CouchDB conflict writing kbIndexingStatus (attempt ${attempts}/3)`);
        continue;
      }
      console.error(`[KB Status] ❌ Failed to persist kbIndexingStatus for ${userId}:`, error.message);
      return;
    }
  }
};

const isIndexingCompletedStatus = (status) => (
  status === 'INDEX_JOB_STATUS_COMPLETED' ||
  status === 'INDEX_JOB_STATUS_NO_CHANGES' ||
  status === 'completed' ||
  status === 'COMPLETED'
);

const getKbIndexingStatusFromDo = async (kbId) => {
  if (!kbId) return null;
  const indexingJobs = await doClient.indexing.listForKB(kbId);
  const jobsArray = Array.isArray(indexingJobs)
    ? indexingJobs
    : (indexingJobs?.jobs || indexingJobs?.indexing_jobs || indexingJobs?.data || []);
  if (jobsArray.length === 0) {
    return { activeJobId: null, activeStatus: null, latestJobId: null, latestStatus: null, isActive: false };
  }
  const sortedJobs = [...jobsArray].sort((a, b) => {
    const aTime = new Date(a.updated_at || a.finished_at || a.created_at || 0).getTime();
    const bTime = new Date(b.updated_at || b.finished_at || b.created_at || 0).getTime();
    return bTime - aTime;
  });
  const activeJob = sortedJobs.find(job => isIndexingActiveStatus(job.status || job.job_status || job.state));
  const latestJob = sortedJobs[0];
  const activeJobId = activeJob?.uuid || activeJob?.id || activeJob?.indexing_job_id || null;
  const activeStatus = activeJob?.status || activeJob?.job_status || activeJob?.state || null;
  const latestJobId = latestJob?.uuid || latestJob?.id || latestJob?.indexing_job_id || null;
  const latestStatus = latestJob?.status || latestJob?.job_status || latestJob?.state || null;
  return {
    activeJobId,
    activeStatus,
    latestJobId,
    latestStatus,
    isActive: !!activeJobId
  };
};

const invalidateResourceCache = (userId) => {
  if (userId) {
    resourceValidationCache.delete(userId);
  }
};

/**
 * Centralized validation function to verify user resources exist in DigitalOcean
 * This is the single source of truth for resource validation - DO API is authoritative
 * @param {string} userId - User ID to validate resources for
 * @returns {Promise<{hasAgent: boolean, kbStatus: string, userDoc: object, cleaned: boolean}>}
 * kbStatus: 'none' | 'not_attached' | 'attached'
 */
async function validateUserResources(userId) {
  const cachedEntry = resourceValidationCache.get(userId);
  if (isCacheEntryValid(cachedEntry, RESOURCE_CACHE_TTL)) {
    return cachedEntry.data;
  }

  let userDoc = await cloudant.getDocument('maia_users', userId);
  if (!userDoc) {
    const result = { hasAgent: false, kbStatus: 'none', userDoc: null, cleaned: false };
    resourceValidationCache.set(userId, { timestamp: Date.now(), data: result });
    return result;
  }

  let cleaned = false;
  let hasAgent = false;
  let kbStatus = 'none'; // 'none' | 'not_attached' | 'attached'

  const finishAndCache = () => {
    const result = { hasAgent, kbStatus, userDoc, cleaned };
    resourceValidationCache.set(userId, { timestamp: Date.now(), data: result });
    return result;
  };

  // Helper function to check if error is a 404/not found
  const isNotFoundError = (error) => {
    return error.status === 404 || 
           error.message?.includes('404') || 
           error.message?.includes('not found') ||
           error.message?.toLowerCase().includes('not_found');
  };

  // 1. Validate Agent - verify it exists in DigitalOcean
  if (userDoc.assignedAgentId && typeof userDoc.assignedAgentId === 'string' && userDoc.assignedAgentId.trim().length > 0) {
    try {
      const agent = await getCachedAgent(userDoc.assignedAgentId);
      if (agent && agent.uuid === userDoc.assignedAgentId) {
        // Verify agent name matches expected pattern
        const expectedPattern = new RegExp(`^${userId}-agent-`);
        if (expectedPattern.test(agent.name)) {
          hasAgent = true;
          const endpointFromAgent = agent.deployment?.url ? `${agent.deployment.url}/api/v1` : null;
          const modelNameFromAgent = agent.model?.inference_name || agent.model?.name || null;
          const timestamp = new Date().toISOString();
          const defaultProfileKey = userDoc.agentProfileDefaultKey || 'default';
          const mergeResult = mergeAgentProfileOnDoc(userDoc, defaultProfileKey, {
            agentId: agent.uuid,
            agentName: agent.name,
            endpoint: endpointFromAgent,
            modelName: modelNameFromAgent
          }, timestamp);
          if (mergeResult.changed) {
            cleaned = true;
          }
          if (userDoc.assignedAgentName !== agent.name) {
            userDoc.assignedAgentName = agent.name;
            cleaned = true;
          }
          if (userDoc.assignedAgentId !== agent.uuid) {
            userDoc.assignedAgentId = agent.uuid;
            cleaned = true;
          }
          if (endpointFromAgent && userDoc.agentEndpoint !== endpointFromAgent) {
            userDoc.agentEndpoint = endpointFromAgent;
            cleaned = true;
          }
          if (modelNameFromAgent && userDoc.agentModelName !== modelNameFromAgent) {
            userDoc.agentModelName = modelNameFromAgent;
            cleaned = true;
          }
          if (!userDoc.agentProfileDefaultKey) {
            userDoc.agentProfileDefaultKey = defaultProfileKey;
            cleaned = true;
          }
          if (ensureDeepLinkAgentOverrides(userDoc)) {
            cleaned = true;
          }
        } else {
          // Agent exists but name doesn't match pattern - clear it
          console.log(`⚠️ Agent ${userDoc.assignedAgentId} exists but name "${agent.name}" doesn't match pattern for user ${userId}. Clearing.`);
          userDoc.assignedAgentId = null;
          userDoc.assignedAgentName = null;
          userDoc.agentEndpoint = null;
          userDoc.agentModelName = null;
          userDoc.agentApiKey = null;
          userDoc.workflowStage = 'agent_named';
          cleaned = true;
        }
      } else {
        // Agent ID mismatch - clear it
        console.log(`⚠️ Agent ${userDoc.assignedAgentId} found in database but UUID mismatch in DigitalOcean. Clearing.`);
        userDoc.assignedAgentId = null;
        userDoc.assignedAgentName = null;
        userDoc.agentEndpoint = null;
        userDoc.agentModelName = null;
        userDoc.agentApiKey = null;
        userDoc.workflowStage = 'agent_named';
        cleaned = true;
      }
    } catch (error) {
      if (isNotFoundError(error)) {
        // Agent doesn't exist in DO - clear it from database
        console.log(`⚠️ Agent ${userDoc.assignedAgentId} not found in DigitalOcean. Clearing from user document.`);
        userDoc.assignedAgentId = null;
        userDoc.assignedAgentName = null;
        userDoc.agentEndpoint = null;
        userDoc.agentModelName = null;
        userDoc.agentApiKey = null;
        userDoc.workflowStage = 'agent_named';
        cleaned = true;
      } else if (isRateLimitError(error)) {
        console.warn(`⚠️ Rate limit while checking agent for user ${userId}. Using cached validation result.`);
        return finishAndCache();
      } else {
        // Other error - log but don't fail validation
        console.error(`❌ Error checking agent existence in DO for user ${userId}:`, error.message);
        hasAgent = false;
      }
    }
  }

  // 2. Validate KB - verify it exists in DigitalOcean and check attachment status
  let kbExists = false;
  let kbIdFound = null;
  
  // First, check if KB exists in DO (either from database or by searching)
  if (userDoc.kbId && typeof userDoc.kbId === 'string' && userDoc.kbId.trim().length > 0) {
    try {
      const kb = await getCachedKB(userDoc.kbId);
      if (kb && kb.uuid === userDoc.kbId) {
        kbExists = true;
        kbIdFound = userDoc.kbId;
      } else {
        // KB ID mismatch - clear it
        console.log(`⚠️ KB ${userDoc.kbId} found in database but UUID mismatch in DigitalOcean. Clearing KB from user document.`);
        userDoc.kbId = null;
        userDoc.connectedKBs = [];
        userDoc.connectedKB = null; // Clear legacy field
        cleaned = true;
      }
    } catch (error) {
      if (isNotFoundError(error)) {
        // KB doesn't exist in DO - clear it from database
        console.log(`⚠️ KB ${userDoc.kbId} not found in DigitalOcean. Clearing KB from user document.`);
        userDoc.kbId = null;
        userDoc.connectedKBs = [];
        userDoc.connectedKB = null; // Clear legacy field
        cleaned = true;
      } else if (isRateLimitError(error)) {
        console.warn(`⚠️ Rate limit while fetching KB ${userDoc.kbId} for user ${userId}. Returning cached result.`);
        return finishAndCache();
      } else {
        // Other error - log but don't fail validation
        console.error(`❌ Error checking KB existence in DO for user ${userId}:`, error.message);
      }
    }
  }
  
  // If no KB in database or KB not found, try to find KB by name pattern
  if (!kbExists) {
    try {
      const kbName = getKBNameFromUserDoc(userDoc, userId);
      if (kbName) {
      const allKBs = await getCachedKBList();
      const foundKB = allKBs.find(kb => kb.name === kbName);

      if (foundKB) {
        // KB exists in DO but not in database - sync it
        kbExists = true;
        kbIdFound = foundKB.uuid || foundKB.id;
        console.log(`ℹ️ Found KB ${kbName} in DO but not in database. Syncing kbId: ${kbIdFound}`);
        userDoc.kbId = kbIdFound;
        // Set connectedKBs since KB actually exists and is found
        if (!userDoc.connectedKBs || !Array.isArray(userDoc.connectedKBs)) {
          userDoc.connectedKBs = [];
        }
        if (!userDoc.connectedKBs.includes(kbName)) {
          userDoc.connectedKBs.push(kbName);
        }
        // Also set legacy connectedKB field for backward compatibility
        if (!userDoc.connectedKB) {
          userDoc.connectedKB = kbName;
        }
        cleaned = true;
      }
      }
    } catch (error) {
      if (isRateLimitError(error)) {
        console.warn(`⚠️ Rate limit while listing KBs for user ${userId}. Using cached validation result.`);
        return finishAndCache();
      }
      console.error(`❌ Error searching for KB in DO for user ${userId}:`, error.message);
    }
  }
  
  // If KB exists, check if it's attached to agent
  if (kbExists && kbIdFound && hasAgent && userDoc.assignedAgentId) {
    try {
      const agentDetails = await getCachedAgent(userDoc.assignedAgentId);
      
      // Check multiple possible field names for attached KBs in agent details
      // Agent might have: knowledge_bases, knowledge_base_ids, connected_knowledge_bases, etc.
      const attachedKBs = agentDetails.knowledge_bases || 
                          agentDetails.connected_knowledge_bases ||
                          agentDetails.knowledge_base_ids ||
                          agentDetails.knowledge_base_uuids ||
                          agentDetails.kbs ||
                          [];
      
      // Check if our KB is in the attached list
      // Handle both array of strings (UUIDs) and array of objects with uuid/id fields
      const isAttached = attachedKBs.some((kb) => {
        if (!kb) return false;
        const kbId = typeof kb === 'string' ? kb : (kb.uuid || kb.id || kb.knowledge_base_uuid);
        return kbId === kbIdFound;
      });
      
      if (isAttached) {
        kbStatus = 'attached';
        // Only log attachment on first detection or when state changes (not on every validation)
        // This is informational, not an error, so no need to spam logs
      } else {
        kbStatus = 'not_attached';
        // If agent is ready and indexing completed, attach now
        logWizAttachCheck(
          `validate:${userId}`,
          {
            agentEndpoint: !!userDoc.agentEndpoint,
            indexed: !!userDoc.kbIndexingStatus?.backendCompleted,
            kbId: kbIdFound || 'none',
            agentId: userDoc.assignedAgentId || 'none'
          },
          `[WIZ] Attach check (validate): agentEndpoint=${!!userDoc.agentEndpoint} indexed=${!!userDoc.kbIndexingStatus?.backendCompleted} kbId=${kbIdFound || 'none'} agentId=${userDoc.assignedAgentId || 'none'}`
        );
        if (userDoc.agentEndpoint && userDoc.kbIndexingStatus?.backendCompleted) {
          try {
            await doClient.agent.attachKB(userDoc.assignedAgentId, kbIdFound);
            kbStatus = 'attached';
            console.log(`[WIZ] ✅ Attached KB ${kbIdFound} to agent ${userDoc.assignedAgentId} after indexing completion (validate).`);
          } catch (attachError) {
            if (!attachError.message || !attachError.message.includes('already')) {
              console.error(`[WIZ] ❌ Attach failed (validate):`, attachError.message);
            }
          }
        }
        // Don't log this - it's a normal state and validateUserResources is called frequently
        // The status is already reflected in the API response
      }
    } catch (error) {
      if (isRateLimitError(error)) {
        console.warn(`⚠️ Rate limit while checking KB attachment for user ${userId}. Using cached result.`);
        return finishAndCache();
      }
      console.error(`❌ Error checking KB attachment status for user ${userId}:`, error.message);
      // Default to not_attached if we can't verify
      kbStatus = 'not_attached';
    }
  } else if (kbExists && kbIdFound) {
    // KB exists but no agent - can't be attached
    kbStatus = 'not_attached';
    // Don't log this - it's a normal state during provisioning
  }

  // Save cleaned user document if any resources were removed or synced
  // Use retry logic to handle 409 conflicts (document update conflicts)
  if (cleaned) {
    let retries = 3;
    let saved = false;
    
    while (retries > 0 && !saved) {
      try {
        await cloudant.saveDocument('maia_users', userDoc);
        saved = true;
      } catch (error) {
        // Handle 409 conflict - document was updated by another process
        if (error.statusCode === 409 || error.error === 'conflict') {
          retries--;
          if (retries > 0) {
            // Get fresh document with latest _rev
            const freshDoc = await cloudant.getDocument('maia_users', userId);
            if (freshDoc) {
              // Re-apply our changes to the fresh document
              if (userDoc.assignedAgentId === null) {
                freshDoc.assignedAgentId = null;
                freshDoc.assignedAgentName = null;
                freshDoc.agentEndpoint = null;
                freshDoc.agentModelName = null;
                freshDoc.agentApiKey = null;
                freshDoc.workflowStage = 'agent_named';
                freshDoc.agentProfiles = {};
                freshDoc.agentProfileDefaultKey = freshDoc.agentProfileDefaultKey || 'default';
                freshDoc.deepLinkAgentOverrides = {};
              } else if (userDoc.assignedAgentId) {
                freshDoc.assignedAgentId = userDoc.assignedAgentId;
                freshDoc.assignedAgentName = userDoc.assignedAgentName;
                freshDoc.agentEndpoint = userDoc.agentEndpoint;
                freshDoc.agentModelName = userDoc.agentModelName;
                if (userDoc.agentApiKey !== undefined) {
                  freshDoc.agentApiKey = userDoc.agentApiKey;
                }
                if (isPlainObject(userDoc.agentProfiles)) {
                  freshDoc.agentProfiles = userDoc.agentProfiles;
                }
                if (userDoc.agentProfileDefaultKey) {
                  freshDoc.agentProfileDefaultKey = userDoc.agentProfileDefaultKey;
                }
                if (isPlainObject(userDoc.deepLinkAgentOverrides)) {
                  freshDoc.deepLinkAgentOverrides = userDoc.deepLinkAgentOverrides;
                }
              }
              if (userDoc.kbId === null) {
                freshDoc.kbId = null;
                freshDoc.connectedKBs = [];
              }
              if (userDoc.kbId && userDoc.connectedKBs) {
                freshDoc.kbId = userDoc.kbId;
                freshDoc.connectedKBs = userDoc.connectedKBs;
              }
              userDoc = freshDoc;
              // Wait a bit before retrying
              await new Promise(resolve => setTimeout(resolve, 100));
            } else {
              // User document was deleted? Shouldn't happen, but break
              break;
            }
          } else {
            console.error(`⚠️ Failed to save user document after 3 retries for user ${userId} due to conflicts. Continuing with current state.`);
            // Don't throw - continue with current document state
            // The validation results are still valid even if save failed
          }
        } else {
          // Other error - throw it
          throw error;
        }
      }
    }
  }

  return finishAndCache();
}

const passkeyService = new PasskeyService({
  rpID: appUrlConfig.derivedRpID,
  origin: appUrlConfig.appOrigin,
  allowedOrigins: process.env.PASSKEY_ORIGINS
    ? process.env.PASSKEY_ORIGINS.split(',').map(entry => entry.trim()).filter(Boolean)
    : appUrlConfig.allowedOrigins
});

// Initialize ChatClient — DO Inference key will be resolved async and upgrade providers
const chatClient = new ChatClient({
  digitalocean: {},
  anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
  openai: { apiKey: process.env.OPENAI_API_KEY || process.env.CHATGPT_API_KEY },
  gemini: { apiKey: process.env.GEMINI_API_KEY },
  deepseek: { apiKey: process.env.DEEPSEEK_API_KEY }
});

// Middleware
// CORS configuration - allow both local development and production origins
// Check if we're in production first (needed for CORS logic)
const distPathForCors = path.join(__dirname, '../dist');
const distExistsForCors = existsSync(distPathForCors);
const isProductionForCors = process.env.NODE_ENV === 'production' || distExistsForCors;

// CORS allowed origins - can be set via CORS_ALLOWED_ORIGINS (comma-separated) or use defaults
const corsOriginsEnv = process.env.CORS_ALLOWED_ORIGINS;
const allowedOrigins = corsOriginsEnv 
  ? corsOriginsEnv.split(',').map(origin => origin.trim())
  : [
      'http://localhost:5173', // Local development
      appUrlConfig.appOrigin
    ].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // Check if origin is in allowed list
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      // Allow DigitalOcean App Platform URLs (ending with .ondigitalocean.app)
      if (origin.endsWith('.ondigitalocean.app')) {
        callback(null, true);
      } else {
        // In production, be more strict
        if (isProductionForCors) {
          console.warn(`⚠️ [CORS] Blocked origin: ${origin}`);
          callback(new Error('Not allowed by CORS'));
        } else {
          // In development, allow all origins
          callback(null, true);
        }
      }
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Trust the reverse proxy (DO App Platform) so secure cookies work behind HTTPS load balancers
if ((process.env.PUBLIC_APP_URL || '').startsWith('https://')) {
  app.set('trust proxy', 1);
}

app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || deriveSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: (process.env.PUBLIC_APP_URL || '').startsWith('https://'),
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  },
  store: new CloudantSessionStore({
    cloudantClient: cloudant,
    dbName: 'maia_sessions'
  })
}));

// Passkey routes
setupAuthRoutes(app, passkeyService, cloudant, doClient, auditLog, { invalidateResourceCache });

// Chat routes
setupChatRoutes(app, chatClient, cloudant, doClient, appendUserProvisioningEvent);

// File routes
setupFileRoutes(app, cloudant, doClient);

// Group registry routes (Groups & AS feature — see Documentation/Groups.md).
// sendEmail is injected lazily: initResend is a hoisted function declaration
// defined further down; it resolves the Resend client (or null when
// RESEND_API_KEY is unset — invites then rely on the copyable link).
// Sharing Policies (Groups_Design.md Refinement 7): structured policy
// cards on the userDoc; the AS consults them for incoming requests.
setupPolicyRoutes(app, cloudant, auditLog);

const { runDailyGroupMaintenance } = setupGroupRoutes(app, cloudant, auditLog, {
  sendEmail: async (to, subject, text) => {
    const resend = await initResend();
    if (!resend) return false;
    const from = process.env.RESEND_FROM_EMAIL || 'noreply@maia.healthurl.com';
    await resend.emails.send({ from, to, subject, text });
    return true;
  }
});

// Groups daily maintenance (Groups.md §6.1/§6.3/§7.3): renew 24h membership
// credentials, reconcile registry-side revocation, pull relay mail, and
// sweep expired messages + invites. Runs ~5 min after boot (let startup
// settle) and every 24h thereafter. A single-deployment interval is fine
// for Phase 1; a durable scheduler can replace it later.
const GROUP_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
setTimeout(() => {
  runDailyGroupMaintenance().catch((e) => console.warn('[groups-cron] initial run failed:', e?.message || e));
  setInterval(() => {
    runDailyGroupMaintenance().catch((e) => console.warn('[groups-cron] run failed:', e?.message || e));
  }, GROUP_MAINTENANCE_INTERVAL_MS);
}, 5 * 60 * 1000);

const DEEP_LINK_COOKIE = 'maia_deep_link_user';
const DEEP_LINK_COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

const sanitizeName = (value = '') => value
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-zA-Z0-9\s'-]/g, '')
  .trim();

const slugifyName = (value = '') => {
  const cleaned = sanitizeName(value).toLowerCase();
  const slug = cleaned.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'guest';
};

const ensureArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

/**
 * Resolve userId from session, body, and query — and enforce that body/query
 * cannot override the session userId.  Returns the resolved userId or null
 * (after sending a 403 response) when there is a mismatch.
 */
function resolveUserId(req, res) {
  const sessionUserId = req.session?.userId || null;
  const requestUserId = req.body?.userId || req.query?.userId || null;

  if (sessionUserId && requestUserId && sessionUserId !== requestUserId) {
    res.status(403).json({
      success: false,
      message: 'User ID mismatch',
      error: 'USER_ID_MISMATCH'
    });
    return null;
  }

  return sessionUserId || requestUserId;
}

const getChatByShareId = async (shareId) => {
  if (!shareId) return null;
  const result = await cloudant.findDocuments('maia_chats', {
    selector: { shareId: { $eq: shareId } },
    limit: 1
  });
  if (result?.docs?.length) {
    return result.docs[0];
  }
  const allChats = await cloudant.getAllDocuments('maia_chats');
  return allChats.find(chat => chat.shareId === shareId) || null;
};

const findDeepLinkUsersByDisplayName = async (displayName, normalizedKey) => {
  const selector = {
    type: { $eq: 'user' },
    isDeepLink: { $eq: true }
  };

  if (normalizedKey) {
    selector.$or = [{ deepLinkNameKey: { $eq: normalizedKey } }];
  }

  if (displayName) {
    if (selector.$or) {
      selector.$or.push({ displayName: { $eq: displayName } });
    } else {
      selector.displayName = { $eq: displayName };
    }
  }

  const result = await cloudant.findDocuments('maia_users', { selector });
  return result?.docs || [];
};

const getDeepLinkUserById = async (userId) => {
  if (!userId) return null;
  return await cloudant.getDocument('maia_users', userId);
};

// Add deep link user to chat's deepLinkUserIds array
const addDeepLinkUserToChat = async (chat, deepLinkUserId) => {
  if (!chat || !deepLinkUserId) return chat;
  
  // Ensure deepLinkUserIds array exists
  if (!Array.isArray(chat.deepLinkUserIds)) {
    chat.deepLinkUserIds = [];
  }
  
  // Add user if not already in the list
  if (!chat.deepLinkUserIds.includes(deepLinkUserId)) {
    chat.deepLinkUserIds.push(deepLinkUserId);
    chat.updatedAt = new Date().toISOString();
    
    // Save the updated chat document
    try {
      await cloudant.saveDocument('maia_chats', chat);
    } catch (error) {
      console.error(`[Deep Link Tracking] Error saving chat ${chat._id} with deep link user ${deepLinkUserId}:`, error.message);
      // Don't throw - this is non-critical tracking
    }
  }
  
  return chat;
};

const attachShareToUserDoc = (userDoc, shareId) => {
  const shares = ensureArray(userDoc.deepLinkShareIds);
  if (shareId && !shares.includes(shareId)) {
    shares.push(shareId);
  }
  userDoc.deepLinkShareIds = shares;
  return shares;
};

const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

const ensureDeepLinkAgentOverrides = (userDoc) => {
  if (!isPlainObject(userDoc.deepLinkAgentOverrides)) {
    userDoc.deepLinkAgentOverrides = {};
    return true;
  }
  return false;
};

const mergeAgentProfileOnDoc = (userDoc, profileKey, profileData, timestamp = new Date().toISOString()) => {
  if (!isPlainObject(userDoc.agentProfiles)) {
    userDoc.agentProfiles = {};
  }

  const existingProfile = isPlainObject(userDoc.agentProfiles[profileKey])
    ? { ...userDoc.agentProfiles[profileKey] }
    : {};

  const { agentId, agentName, endpoint, modelName, apiKey, lastSyncedAt } = profileData || {};

  let changed = false;
  if (agentId !== undefined && existingProfile.agentId !== agentId) {
    existingProfile.agentId = agentId;
    changed = true;
  }
  if (agentName !== undefined && existingProfile.agentName !== agentName) {
    existingProfile.agentName = agentName;
    changed = true;
  }
  if (endpoint !== undefined && existingProfile.endpoint !== endpoint) {
    existingProfile.endpoint = endpoint;
    changed = true;
  }
  if (modelName !== undefined && existingProfile.modelName !== modelName) {
    existingProfile.modelName = modelName;
    changed = true;
  }
  if (apiKey !== undefined && existingProfile.apiKey !== apiKey) {
    existingProfile.apiKey = apiKey;
    changed = true;
  }

  if (!existingProfile.createdAt) {
    existingProfile.createdAt = timestamp;
    changed = true;
  }

  if (lastSyncedAt !== undefined) {
    if (existingProfile.lastSyncedAt !== lastSyncedAt) {
      existingProfile.lastSyncedAt = lastSyncedAt;
      changed = true;
    }
  } else if (changed) {
    existingProfile.lastSyncedAt = timestamp;
  }

  if (changed) {
    existingProfile.updatedAt = timestamp;
  } else if (!existingProfile.updatedAt) {
    existingProfile.updatedAt = existingProfile.createdAt;
  }

  userDoc.agentProfiles[profileKey] = existingProfile;
  return { changed, profile: existingProfile };
};

const setDeepLinkSession = (req, userDoc, shareId, chatId) => {
  if (!req.session) return;
  req.session.isDeepLink = true;
  req.session.deepLinkUserId = userDoc.userId;
  req.session.deepLinkDisplayName = userDoc.displayName || userDoc.userId;
  req.session.deepLinkShareIds = ensureArray(userDoc.deepLinkShareIds);
  if (shareId) {
    if (!req.session.deepLinkShareIds.includes(shareId)) {
      req.session.deepLinkShareIds.push(shareId);
    }
    req.session.deepLinkShareId = shareId;
  }
  if (chatId) {
    req.session.deepLinkChatId = chatId;
  }
  req.session.deepLinkAuthenticatedAt = new Date().toISOString();
  req.session.deepLinkExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
};

const isDeepLinkSession = (req) => !!req.session?.isDeepLink;

/**
 * Resolve the owner userId for endpoints that a deep-link guest
 * might call to view the sharing patient's data (encounters
 * worksheet, OOR labs worksheet, etc). For a normal session,
 * returns the caller's own userId. For a deep-link session,
 * looks up the shared chat and returns its patientOwner so the
 * guest sees the owner's data, not their own (empty) doc.
 *
 * Falls back to caller's userId if the lookup fails, matching
 * the pre-deep-link behavior (endpoint will 404 on missing doc).
 *
 * NOTE: previously imported/defined at v1.4.20 (PR #106) and used
 * by /api/encounters/find, /api/labs/history, /api/labs/oor-
 * worksheet. Restored here after an inadvertent removal.
 */
async function resolveOwnerUserId(req, res) {
  const callerId = resolveUserId(req, res);
  if (!callerId) return null;
  if (!isDeepLinkSession(req)) return callerId;
  try {
    const ownerId = await getOwnerIdForDeepLinkSession(req, cloudant);
    return ownerId || callerId;
  } catch (e) {
    console.warn('[resolveOwnerUserId] owner lookup failed, using caller:', e?.message);
    return callerId;
  }
}

const generateDeepLinkUserId = (nameSlug, shareId) => {
  const randomPart = Math.random().toString(36).slice(2, 8);
  const timePart = Date.now().toString(36);
  const sharePart = (shareId || 'dl').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 8);
  return `${nameSlug}-DL-${sharePart}-${timePart}-${randomPart}`.toLowerCase();
};

// Deep link session check
app.get('/api/deep-link/session', async (req, res) => {
  try {
    const shareId = req.query.shareId;

    if (!shareId || typeof shareId !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Share ID is required',
        error: 'MISSING_SHARE_ID'
      });
    }

    const chat = await getChatByShareId(shareId);
    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Shared chat not found',
        error: 'CHAT_NOT_FOUND'
      });
    }

    if (req.session?.userId) {
      const deepLink = isDeepLinkSession(req);
      const response = {
        success: true,
        authenticated: true,
        deepLink,
        user: {
          userId: req.session.userId,
          displayName: req.session.displayName || req.session.userId,
          isDeepLink: deepLink
        }
      };

      if (deepLink) {
        // Add deep link user to chat's tracking list
        const deepLinkUserId = req.session.deepLinkUserId || req.session.userId;
        if (deepLinkUserId) {
          await addDeepLinkUserToChat(chat, deepLinkUserId);
        }
        
        if (!req.session.deepLinkShareIds?.includes(shareId)) {
          req.session.deepLinkShareIds = ensureArray(req.session.deepLinkShareIds);
          req.session.deepLinkShareIds.push(shareId);
        }
        req.session.deepLinkShareId = shareId;
        req.session.deepLinkChatId = chat._id;
        response.deepLinkInfo = {
          shareId,
          chatId: chat._id
        };
      } else {
        response.deepLinkInfo = {
          shareId,
          chatId: chat._id
        };
      }

      return res.json(response);
    } else if (isDeepLinkSession(req) && req.session.deepLinkUserId) {
      const deepLinkUserId = req.session.deepLinkUserId;
      // Add deep link user to chat's tracking list
      await addDeepLinkUserToChat(chat, deepLinkUserId);
      
      const shareIds = ensureArray(req.session.deepLinkShareIds);
    if (!shareIds.includes(shareId)) {
      shareIds.push(shareId);
    }
    req.session.deepLinkShareIds = shareIds;
    req.session.deepLinkShareId = shareId;
    req.session.deepLinkChatId = chat._id;
      return res.json({
        success: true,
        authenticated: true,
        deepLink: true,
        user: {
          userId: deepLinkUserId,
          displayName: req.session.deepLinkDisplayName || deepLinkUserId,
          isDeepLink: true
        },
        deepLinkInfo: {
        shareId,
        chatId: chat._id
        }
      });
    }

    const cookieUserId = req.cookies?.[DEEP_LINK_COOKIE];
    if (cookieUserId) {
      const userDoc = await getDeepLinkUserById(cookieUserId);
      if (userDoc && userDoc.isDeepLink) {
        attachShareToUserDoc(userDoc, shareId);
        userDoc.updatedAt = new Date().toISOString();
        await cloudant.saveDocument('maia_users', userDoc);

        // Add deep link user to chat's tracking list
        await addDeepLinkUserToChat(chat, userDoc.userId);

        setDeepLinkSession(req, userDoc, shareId, chat._id);
        res.cookie(DEEP_LINK_COOKIE, userDoc.userId, {
          maxAge: DEEP_LINK_COOKIE_MAX_AGE,
          httpOnly: true,
          sameSite: 'lax'
        });

        return res.json({
          success: true,
          authenticated: true,
          deepLink: true,
          user: {
            userId: userDoc.userId,
            displayName: userDoc.displayName || userDoc.userId,
            isDeepLink: true
          },
          deepLinkInfo: {
            shareId,
            chatId: chat._id
          }
        });
      }
    }

    res.json({
      success: true,
      authenticated: false,
      needsRegistration: true
    });
  } catch (error) {
    console.error('❌ Error checking deep-link session:', error);
    res.status(500).json({
      success: false,
      message: `Failed to verify deep-link session: ${error.message}`,
      error: 'DEEPLINK_SESSION_ERROR'
    });
  }
});

// Deep link login / registration
app.post('/api/deep-link/login', async (req, res) => {
  try {
    const { shareId, name, email, emailPreference } = req.body || {};

    if (!shareId || typeof shareId !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Share ID is required',
        error: 'MISSING_SHARE_ID'
      });
    }

    const chat = await getChatByShareId(shareId);
    if (!chat) {
      return res.status(404).json({
        success: false,
        message: 'Shared chat not found',
        error: 'CHAT_NOT_FOUND'
      });
    }

    const rawName = typeof name === 'string' ? name.trim() : '';
    if (!rawName) {
      return res.status(400).json({
        success: false,
        message: 'Name is required',
        error: 'MISSING_NAME'
      });
    }

    const normalizedNameKey = sanitizeName(rawName).toLowerCase();
    if (!normalizedNameKey) {
      return res.status(400).json({
        success: false,
        message: 'Name is invalid',
        error: 'INVALID_NAME'
      });
    }

    const normalizedEmail = typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : null;
    const nameSlug = slugifyName(rawName);

    const existingMatches = await findDeepLinkUsersByDisplayName(rawName, normalizedNameKey);
    let userDoc = existingMatches[0] || null;

    const cookieUserId = req.cookies?.[DEEP_LINK_COOKIE];
    if (!userDoc && cookieUserId) {
      const cookieUser = await getDeepLinkUserById(cookieUserId);
      if (cookieUser && cookieUser.isDeepLink) {
        userDoc = cookieUser;
      }
    }

    if (!userDoc) {
      const userId = generateDeepLinkUserId(nameSlug, shareId);
      userDoc = {
        _id: userId,
        userId,
        type: 'user',
        isDeepLink: true,
        displayName: rawName,
        deepLinkNameKey: normalizedNameKey,
        email: normalizedEmail,
        deepLinkShareIds: [shareId],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        domain: 'deeplink'
      };
    } else {
      // Existing user: handle email differences
      const existingEmail = userDoc.email ? String(userDoc.email).toLowerCase() : null;
      if (normalizedEmail && existingEmail && existingEmail !== normalizedEmail) {
        if (!emailPreference) {
          return res.status(409).json({
            success: false,
            conflict: true,
            existingEmail: userDoc.email,
            message: 'Email differs from previous registration'
          });
        }

        if (emailPreference === 'new') {
          userDoc.email = normalizedEmail;
        }
      } else if (normalizedEmail && !existingEmail) {
        userDoc.email = normalizedEmail;
      }

      userDoc.displayName = rawName;
      userDoc.deepLinkNameKey = normalizedNameKey;
      attachShareToUserDoc(userDoc, shareId);
      userDoc.updatedAt = new Date().toISOString();
    }

    await cloudant.saveDocument('maia_users', userDoc);

    // Add deep link user to chat's tracking list
    await addDeepLinkUserToChat(chat, userDoc.userId);

    setDeepLinkSession(req, userDoc, shareId, chat._id);
    res.cookie(DEEP_LINK_COOKIE, userDoc.userId, {
      maxAge: DEEP_LINK_COOKIE_MAX_AGE,
      httpOnly: true,
      sameSite: 'lax'
    });

    res.json({
      success: true,
      authenticated: true,
      deepLink: true,
      user: {
        userId: userDoc.userId,
        displayName: userDoc.displayName || userDoc.userId,
        isDeepLink: true
      },
      deepLinkInfo: {
        shareId,
        chatId: chat._id
      }
    });
  } catch (error) {
    console.error('❌ Error processing deep-link login:', error);
    res.status(500).json({
      success: false,
      message: `Failed to process deep-link login: ${error.message}`,
      error: 'DEEPLINK_LOGIN_ERROR'
    });
  }
});

// Agent sync endpoint - find and configure user's agent
app.post('/api/sync-agent', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return; // 403 already sent on mismatch

    // First, validate existing resources to clean up any stale references
    const { userDoc: validatedUserDoc } = await validateUserResources(userId);
    
    if (!validatedUserDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }
    
    // Find user's agent in DigitalOcean (source of truth)
    const userAgent = await findUserAgent(doClient, userId);
    
    if (!userAgent) {
      // No agent found in DO — create one if requested (restore flow)
      const shouldCreate = req.body?.create === true || req.query?.create === 'true';
      if (shouldCreate) {
        console.log(`[SYNC-AGENT] No agent found for ${userId}, creating...`);
        try {
          const { ensureUserAgent } = await import('./routes/auth.js');
          const updatedDoc = await ensureUserAgent(doClient, cloudant, validatedUserDoc);
          if (updatedDoc?.assignedAgentId) {
            return res.json({
              success: true,
              created: true,
              agentId: updatedDoc.assignedAgentId,
              agentName: updatedDoc.assignedAgentName,
              agentEndpoint: updatedDoc.agentEndpoint
            });
          }
        } catch (createErr) {
          console.error(`[SYNC-AGENT] Agent creation failed for ${userId}:`, createErr.message);
          return res.status(500).json({ success: false, error: createErr.message || 'Agent creation failed' });
        }
      }
      if (validatedUserDoc.assignedAgentId) {
        console.log(`⚠️ No agent found in DO for user ${userId}, but database has ${validatedUserDoc.assignedAgentId}. Already cleaned by validateUserResources.`);
      }
      return res.status(200).json({
        success: false,
        message: 'No agent found for user',
        error: 'AGENT_NOT_FOUND'
      });
    }
    
    // Agent exists in DO - sync with database
    // Use the validated document as base (may have been cleaned/updated by validateUserResources)
    let userDoc = validatedUserDoc;
    
    // Check if agent info needs updating
    const agentModelName = userAgent.model?.inference_name || userAgent.model?.name || null;
    const agentEndpointFromDetails = userAgent.deployment?.url ? `${userAgent.deployment.url}/api/v1` : null;
    const needsUpdate = 
      userDoc.assignedAgentId !== userAgent.uuid ||
      userDoc.assignedAgentName !== userAgent.name ||
      userDoc.agentModelName !== agentModelName ||
      !agentEndpointFromDetails ||
      userDoc.agentEndpoint !== agentEndpointFromDetails;
    
    if (needsUpdate) {
      // Retry logic for 409 conflicts
      let retries = 3;
      let saved = false;
      
      while (retries > 0 && !saved) {
        try {
      userDoc.assignedAgentId = userAgent.uuid;
      userDoc.assignedAgentName = userAgent.name;
      userDoc.agentEndpoint = agentEndpointFromDetails;
      // Store model inference_name for API requests
      userDoc.agentModelName = userAgent.model?.inference_name || userAgent.model?.name || null;
      const syncTimestamp = new Date().toISOString();
      const defaultProfileKey = userDoc.agentProfileDefaultKey || 'default';
      mergeAgentProfileOnDoc(userDoc, defaultProfileKey, {
        agentId: userAgent.uuid,
        agentName: userAgent.name,
        endpoint: userDoc.agentEndpoint,
        modelName: userDoc.agentModelName
      }, syncTimestamp);
      if (!userDoc.agentProfileDefaultKey) {
        userDoc.agentProfileDefaultKey = defaultProfileKey;
      }
      ensureDeepLinkAgentOverrides(userDoc);
      
      await cloudant.saveDocument('maia_users', userDoc);
      console.log(`✅ Synced agent ${userAgent.name} for user ${userId}`);
          saved = true;
        } catch (error) {
          // Handle 409 conflict - document was updated by another process
          if (error.statusCode === 409 || error.error === 'conflict') {
            retries--;
            if (retries > 0) {
              // Get fresh document with latest _rev
              userDoc = await cloudant.getDocument('maia_users', userId);
              // Wait a bit before retrying
              await new Promise(resolve => setTimeout(resolve, 100));
            } else {
              console.error(`⚠️ Failed to save agent sync after 3 retries for user ${userId} due to conflicts. Agent info may be slightly out of sync.`);
              // Don't throw - return success anyway since agent exists in DO
              // The next sync will pick up the correct values
            }
          } else {
            // Other error - throw it
            throw error;
          }
        }
      }
    }
    
    res.json({
      success: true,
      agent: {
        id: userAgent.uuid,
        name: userAgent.name,
        endpoint: userAgent.deployment?.url ? `${userAgent.deployment.url}/api/v1` : null
      }
    });
  } catch (error) {
    console.error('Error syncing agent:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Failed to sync agent',
      error: 'SYNC_ERROR'
    });
  }
});

// Helper function to generate polling page HTML
function getProvisionPage(userId) {
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Provisioning User</title>
        <meta charset="UTF-8">
        <style>
          body {
            font-family: Arial, sans-serif;
            max-width: 1200px;
            margin: 20px auto;
            padding: 20px;
            background-color: #f5f5f5;
          }
          .container {
            background-color: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          .section {
            margin: 20px 0;
          }
          .section h3 {
            margin-top: 0;
            border-bottom: 2px solid #1976d2;
            padding-bottom: 10px;
          }
          .verification-checklist {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 10px;
            margin: 15px 0;
          }
          .check-item {
            padding: 10px;
            border: 1px solid #ddd;
            border-radius: 4px;
            display: flex;
            align-items: center;
            gap: 10px;
          }
          .check-item.passed {
            background-color: #e8f5e9;
            border-color: #388e3c;
          }
          .check-item.failed {
            background-color: #ffebee;
            border-color: #d32f2f;
          }
          .check-item.pending {
            background-color: #fff3e0;
            border-color: #f57c00;
          }
          .status-icon {
            font-size: 20px;
          }
          .terminal-view {
            background-color: #1e1e1e;
            color: #d4d4d4;
            padding: 15px;
            border-radius: 4px;
            font-family: 'Courier New', monospace;
            font-size: 12px;
            max-height: 400px;
            overflow-y: auto;
            white-space: pre-wrap;
            word-wrap: break-word;
          }
          .log-entry {
            margin: 2px 0;
          }
          .log-entry.info { color: #d4d4d4; }
          .log-entry.success { color: #4ec9b0; }
          .log-entry.error { color: #f48771; }
          .log-entry.warning { color: #dcdcaa; }
          .status-box {
            background-color: #e3f2fd;
            padding: 15px;
            border-radius: 4px;
            margin: 20px 0;
          }
          .error-box {
            background-color: #ffebee;
            padding: 15px;
            border-radius: 4px;
            margin: 20px 0;
            color: #c62828;
          }
          .success-box {
            background-color: #e8f5e9;
            padding: 15px;
            border-radius: 4px;
            margin: 20px 0;
          }
          .step {
            margin: 10px 0;
            padding: 10px;
            border-left: 3px solid #1976d2;
          }
          .step.completed {
            border-left-color: #388e3c;
          }
          .step.error {
            border-left-color: #d32f2f;
          }
          pre {
            background-color: #f5f5f5;
            padding: 10px;
            border-radius: 4px;
            overflow-x: auto;
            font-size: 12px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h2 id="status-header">🔄 Provisioning in Progress...</h2>
          <div id="status-container">
            <div class="status-box">
              <p id="current-step">Starting provisioning...</p>
            </div>
            <div id="steps-container"></div>
          </div>
          
          <div class="section">
            <h3>Verification Checklist</h3>
            <div id="verification-checklist" class="verification-checklist">
              <div class="check-item pending">
                <span class="status-icon">⏳</span>
                <div>
                  <strong>KB Name</strong>
                  <div class="check-message" style="font-size: 11px; color: #666;">Waiting...</div>
                </div>
              </div>
              <div class="check-item pending">
                <span class="status-icon">⏳</span>
                <div>
                  <strong>Bucket Folders</strong>
                  <div class="check-message" style="font-size: 11px; color: #666;">Waiting...</div>
                </div>
              </div>
              <div class="check-item pending">
                <span class="status-icon">⏳</span>
                <div>
                  <strong>Agent Exists</strong>
                  <div class="check-message" style="font-size: 11px; color: #666;">Waiting...</div>
                </div>
              </div>
              <div class="check-item pending">
                <span class="status-icon">⏳</span>
                <div>
                  <strong>Agent Deployed</strong>
                  <div class="check-message" style="font-size: 11px; color: #666;">Waiting...</div>
                </div>
              </div>
              <div class="check-item pending">
                <span class="status-icon">⏳</span>
                <div>
                  <strong>Agent Config</strong>
                  <div class="check-message" style="font-size: 11px; color: #666;">Waiting...</div>
                </div>
              </div>
              <div class="check-item pending">
                <span class="status-icon">⏳</span>
                <div>
                  <strong>API Key</strong>
                  <div class="check-message" style="font-size: 11px; color: #666;">Waiting...</div>
                </div>
              </div>
              <div class="check-item pending">
                <span class="status-icon">⏳</span>
                <div>
                  <strong>API Key Works</strong>
                  <div class="check-message" style="font-size: 11px; color: #666;">Waiting...</div>
                </div>
              </div>
            </div>
          </div>
          
          <div class="section">
            <h3>Server Logs</h3>
            <div id="logs-container" class="terminal-view">Loading logs...</div>
          </div>
        </div>
        <script>
          const userId = '${userId}';
          let pollInterval;
          
          function updatePage(data) {
            const header = document.getElementById('status-header');
            const currentStep = document.getElementById('current-step');
            const stepsContainer = document.getElementById('steps-container');
            const statusContainer = document.getElementById('status-container');
            
            // Update verification checklist if available
            if (data.verification) {
              updateVerification(data.verification);
            }
            
            if (data.status === 'completed') {
              header.innerHTML = '✅ User Successfully Provisioned';
              header.style.color = '#388e3c';
              clearInterval(pollInterval);
              
              const result = data.result || {};
              statusContainer.innerHTML = \`
                <div class="success-box">
                  <p><strong>User:</strong> \${userId}</p>
                  <p><strong>Agent Name:</strong> \${result.agentName || 'N/A'}</p>
                  <p><strong>Agent ID:</strong> \${result.agentId || 'N/A'}</p>
                  <p><strong>Model:</strong> \${result.model || 'Unknown'}</p>
                  <p><strong>Endpoint:</strong> \${result.endpoint || 'Not available'}</p>
                  <p><strong>Total Time:</strong> \${result.totalTime || 0} seconds</p>
                </div>
                <h3>Provisioning Steps</h3>
                <div id="steps-list"></div>
                \${result.testResult && !result.testResult.error ? \`
                  <div class="status-box">
                    <h4>Test Query Result</h4>
                    <p><strong>Query:</strong> "What model are you?"</p>
                    <p><strong>Response:</strong> \${escapeHtml(result.testResult.content || 'No response')}</p>
                  </div>
                \` : ''}
                <p style="margin-top: 30px;">
                  <a href="http://localhost:5173">Go to App</a>
                </p>
              \`;
              
              // Render steps
              const stepsList = document.getElementById('steps-list');
              if (data.steps && data.steps.length > 0) {
                stepsList.innerHTML = data.steps.map(step => {
                  const details = step.details ? '<pre>' + escapeHtml(JSON.stringify(step.details, null, 2)) + '</pre>' : '';
                  return \`<div class="step completed">
                    <strong>✅ \${escapeHtml(step.step)}</strong>
                    <span style="color: #666; font-size: 12px; margin-left: 10px;">\${escapeHtml(step.timestamp)}</span>
                    \${details}
                  </div>\`;
                }).join('');
              }
            } else if (data.status === 'failed') {
              header.innerHTML = '❌ Provisioning Failed';
              header.style.color = '#d32f2f';
              clearInterval(pollInterval);
              
              statusContainer.innerHTML = \`
                <div class="error-box">
                  <p><strong>Error:</strong> \${escapeHtml(data.error || 'Unknown error')}</p>
                </div>
                <h3>Steps Completed</h3>
                <div id="steps-list"></div>
              \`;
              
              const stepsList = document.getElementById('steps-list');
              if (data.steps && data.steps.length > 0) {
                stepsList.innerHTML = data.steps.map(step => {
                  const details = step.details ? '<pre>' + escapeHtml(JSON.stringify(step.details, null, 2)) + '</pre>' : '';
                  return \`<div class="step \${data.status === 'failed' ? 'error' : 'completed'}">
                    <strong>\${data.status === 'failed' ? '❌' : '✅'} \${escapeHtml(step.step)}</strong>
                    <span style="color: #666; font-size: 12px; margin-left: 10px;">\${escapeHtml(step.timestamp)}</span>
                    \${details}
                  </div>\`;
                }).join('');
              }
            } else {
              // In progress
              currentStep.textContent = data.currentStep || 'Processing...';
              
              if (data.steps && data.steps.length > 0) {
                stepsContainer.innerHTML = '<h3>Steps</h3>' + data.steps.map(step => {
                  const details = step.details ? '<pre>' + escapeHtml(JSON.stringify(step.details, null, 2)) + '</pre>' : '';
                  return \`<div class="step">
                    <strong>🔄 \${escapeHtml(step.step)}</strong>
                    <span style="color: #666; font-size: 12px; margin-left: 10px;">\${escapeHtml(step.timestamp)}</span>
                    \${details}
                  </div>\`;
                }).join('');
              }
            }
          }
          
          function escapeHtml(text) {
            if (!text) return '';
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
          }
          
          function pollStatus() {
            fetch(\`/api/admin/provision-status?userId=\${userId}\`)
              .then(res => res.json())
              .then(data => {
                updatePage(data);
              })
              .catch(error => {
                console.error('Polling error:', error);
              });
          }
          
          // Update verification checklist
          function updateVerification(verification) {
            if (!verification || !verification.results) return;
            
            const checks = {
              'KB Name': verification.results.kbName,
              'Bucket Folders': verification.results.bucketFolders,
              'Agent Exists': verification.results.agentExists,
              'Agent Deployed': verification.results.agentDeployed,
              'Agent Config': verification.results.agentConfig,
              'API Key': verification.results.apiKey,
              'API Key Works': verification.results.apiKeyWorks
            };
            
            Object.keys(checks).forEach((key, index) => {
              const checkItem = document.querySelectorAll('.check-item')[index];
              if (!checkItem) return;
              
              const result = checks[key];
              const statusIcon = checkItem.querySelector('.status-icon');
              const checkMessage = checkItem.querySelector('.check-message');
              
              if (result && result.passed !== undefined) {
                checkItem.className = 'check-item ' + (result.passed ? 'passed' : 'failed');
                statusIcon.textContent = result.passed ? '✅' : '❌';
                checkMessage.textContent = result.message || (result.passed ? 'Passed' : 'Failed');
              }
            });
          }
          
          // Poll logs
          let lastLogTimestamp = null;
          function pollLogs() {
            const since = lastLogTimestamp ? '&since=' + encodeURIComponent(lastLogTimestamp) : '';
            fetch('/api/admin/provision-logs?userId=' + userId + since)
              .then(res => res.json())
              .then(data => {
                if (data.success && data.logs) {
                  const logsContainer = document.getElementById('logs-container');
                  data.logs.forEach(log => {
                    const logEntry = document.createElement('div');
                    logEntry.className = 'log-entry ' + log.level;
                    const time = new Date(log.timestamp).toLocaleTimeString();
                    logEntry.textContent = '[' + time + '] ' + log.message;
                    logsContainer.appendChild(logEntry);
                    lastLogTimestamp = log.timestamp;
                  });
                  // Auto-scroll to bottom
                  logsContainer.scrollTop = logsContainer.scrollHeight;
                }
              })
              .catch(error => console.error('Log polling error:', error));
          }
          
          // Poll immediately, then every 5 seconds
          pollStatus();
          pollLogs();
          pollInterval = setInterval(() => {
            pollStatus();
            pollLogs();
          }, 5000);
        </script>
      </body>
    </html>
  `;
}

// Provision status endpoint - for polling
app.get('/api/admin/provision-status', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return; // 403 already sent on mismatch

    const status = provisioningStatus.get(userId);
    if (!status) {
      return res.json({ status: 'not_started' });
    }
    
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Provision logs endpoint - for viewing server logs
app.get('/api/admin/provision-logs', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return; // 403 already sent on mismatch
    const { since } = req.query;

    const logs = provisioningLogs.get(userId) || [];
    
    // Filter by timestamp if 'since' parameter provided
    let filteredLogs = logs;
    if (since) {
      const sinceDate = new Date(since);
      filteredLogs = logs.filter(log => new Date(log.timestamp) > sinceDate);
    }
    
    res.json({
      success: true,
      logs: filteredLogs,
      total: logs.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin agent diagnostic endpoint - identify which agent is connected to a user
app.get('/api/admin/agent-diagnostic', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return; // 403 already sent on mismatch

    // Get user document
    let userDoc;
    try {
      userDoc = await cloudant.getDocument('maia_users', userId);
    } catch (error) {
      return res.status(404).send(`
        <html>
          <head><title>Agent Diagnostic</title></head>
          <body style="font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px;">
            <h2 style="color: #d32f2f;">❌ User Not Found</h2>
            <p>User "${userId}" not found in database.</p>
          </body>
        </html>
      `);
    }

    if (!userDoc) {
      return res.status(404).send(`
        <html>
          <head><title>Provision Error</title></head>
          <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
            <h2 style="color: #d32f2f;">❌ Provisioning Failed</h2>
            <p>User not found: ${userId}</p>
          </body>
        </html>
      `);
    }

    const storedAgentId = userDoc.assignedAgentId || null;
    const storedAgentName = userDoc.assignedAgentName || null;
    const agentProfile = userDoc.agentProfiles?.[userDoc.agentProfileDefaultKey || 'default'] || null;
    const profileAgentId = agentProfile?.agentId || null;

    // Find all agents matching the user's name pattern
    const agentPattern = new RegExp(`^${userId}-agent-`);
    let matchingAgents = [];
    let errorMessage = null;

    try {
      const allAgents = await doClient.agent.list();
      matchingAgents = allAgents.filter(agent => agentPattern.test(agent.name));
      
      // Get full details for each matching agent
      const agentDetails = await Promise.all(
        matchingAgents.map(async (agent) => {
          try {
            const details = await doClient.agent.get(agent.uuid || agent.id);
            // Extract temperature - DigitalOcean API may omit temperature field in some cases
            // According to DO API docs, temperature is a top-level field
            // We set temperature to 0.1, so it should be present in the response
            let extractedTemperature;
            if (details.temperature !== undefined) {
              extractedTemperature = details.temperature;
            } else {
              // Temperature field is missing - show as unknown
              extractedTemperature = 'unknown (not returned by API)';
            }
            
            return {
              uuid: details.uuid || agent.uuid || agent.id,
              name: details.name || agent.name,
              maxTokens: details.max_tokens ?? details.maxTokens ?? 'unknown',
              temperature: extractedTemperature,
              topP: details.top_p ?? details.topP ?? 'unknown',
              deploymentStatus: details.deployment?.status || 'unknown',
              deploymentUrl: details.deployment?.url || null,
              createdAt: details.created_at || 'unknown',
              isStoredAgent: (details.uuid || agent.uuid || agent.id) === storedAgentId,
              isProfileAgent: (details.uuid || agent.uuid || agent.id) === profileAgentId
            };
          } catch (err) {
            return {
              uuid: agent.uuid || agent.id,
              name: agent.name,
              error: err.message
            };
          }
        })
      );
      matchingAgents = agentDetails;
    } catch (err) {
      errorMessage = err.message;
    }

    // Generate HTML report
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Agent Diagnostic - ${userId}</title>
          <meta charset="UTF-8">
          <style>
            body {
              font-family: Arial, sans-serif;
              max-width: 1000px;
              margin: 20px auto;
              padding: 20px;
              background-color: #f5f5f5;
            }
            .container {
              background-color: white;
              padding: 30px;
              border-radius: 8px;
              box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            }
            h1 { color: #1976d2; margin-top: 0; }
            h2 { color: #388e3c; border-bottom: 2px solid #388e3c; padding-bottom: 10px; }
            h3 { color: #f57c00; margin-top: 30px; }
            .info-box {
              background-color: #e3f2fd;
              padding: 15px;
              border-radius: 4px;
              margin: 15px 0;
              border-left: 4px solid #1976d2;
            }
            .agent-box {
              background-color: #fff3e0;
              padding: 20px;
              border-radius: 4px;
              margin: 15px 0;
              border-left: 4px solid #f57c00;
            }
            .agent-box.connected {
              background-color: #e8f5e9;
              border-left-color: #388e3c;
            }
            .agent-box.disconnected {
              background-color: #ffebee;
              border-left-color: #d32f2f;
            }
            .badge {
              display: inline-block;
              padding: 4px 8px;
              border-radius: 4px;
              font-size: 12px;
              font-weight: bold;
              margin-left: 10px;
            }
            .badge.connected { background-color: #388e3c; color: white; }
            .badge.disconnected { background-color: #d32f2f; color: white; }
            .badge.warning { background-color: #f57c00; color: white; }
            code {
              background-color: #f5f5f5;
              padding: 2px 6px;
              border-radius: 3px;
              font-family: 'Courier New', monospace;
              font-size: 13px;
            }
            .config-table {
              width: 100%;
              border-collapse: collapse;
              margin: 10px 0;
            }
            .config-table th,
            .config-table td {
              padding: 8px;
              text-align: left;
              border-bottom: 1px solid #ddd;
            }
            .config-table th {
              background-color: #f5f5f5;
              font-weight: bold;
            }
            .action-box {
              background-color: #fff9c4;
              padding: 15px;
              border-radius: 4px;
              margin: 20px 0;
              border-left: 4px solid #fbc02d;
            }
            .error-box {
              background-color: #ffebee;
              padding: 15px;
              border-radius: 4px;
              margin: 15px 0;
              border-left: 4px solid #d32f2f;
              color: #c62828;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Agent Diagnostic Report</h1>
            <p><strong>User:</strong> <code>${userId}</code></p>

            <h2>Database Information</h2>
            <div class="info-box">
              <p><strong>Stored Agent ID:</strong> <code>${storedAgentId || 'NOT SET'}</code></p>
              <p><strong>Stored Agent Name:</strong> <code>${storedAgentName || 'NOT SET'}</code></p>
              ${profileAgentId ? `<p><strong>Agent Profile ID:</strong> <code>${profileAgentId}</code></p>` : ''}
            </div>

            ${errorMessage ? `
              <div class="error-box">
                <h3>Error Fetching Agents</h3>
                <p>${errorMessage}</p>
              </div>
            ` : ''}

            <h2>Agents in DigitalOcean</h2>
            ${matchingAgents.length === 0 ? `
              <div class="info-box">
                <p>No agents found matching pattern: <code>${userId}-agent-*</code></p>
              </div>
            ` : `
              <p>Found <strong>${matchingAgents.length}</strong> agent(s) matching pattern: <code>${userId}-agent-*</code></p>
              
              ${matchingAgents.map((agent, idx) => {
                const isConnected = agent.isStoredAgent || agent.isProfileAgent;
                const isCorrect = isConnected && (agent.maxTokens === 16384 || agent.maxTokens === 'unknown');
                return `
                  <div class="agent-box ${isConnected ? 'connected' : 'disconnected'}">
                    <h3>Agent ${idx + 1} ${isConnected ? '<span class="badge connected">CONNECTED</span>' : '<span class="badge disconnected">NOT CONNECTED</span>'}</h3>
                    <table class="config-table">
                      <tr><th>UUID</th><td><code>${agent.uuid}</code></td></tr>
                      <tr><th>Name</th><td><code>${agent.name}</code></td></tr>
                      <tr><th>Max Tokens</th><td><code>${agent.maxTokens}</code> ${agent.maxTokens === 16384 ? '✅' : agent.maxTokens !== 'unknown' ? '⚠️ Should be 16384' : ''}</td></tr>
                      <tr><th>Temperature</th><td><code>${agent.temperature}</code></td></tr>
                      <tr><th>Top P</th><td><code>${agent.topP}</code></td></tr>
                      <tr><th>Deployment Status</th><td><code>${agent.deploymentStatus}</code></td></tr>
                      <tr><th>Deployment URL</th><td><code>${agent.deploymentUrl || 'Not available'}</code></td></tr>
                      <tr><th>Created At</th><td><code>${agent.createdAt}</code></td></tr>
                      <tr><th>Matches Stored ID</th><td>${agent.isStoredAgent ? '✅ YES' : '❌ NO'}</td></tr>
                      <tr><th>Matches Profile ID</th><td>${agent.isProfileAgent ? '✅ YES' : '❌ NO'}</td></tr>
                    </table>
                    ${!isConnected ? `
                      <div class="action-box">
                        <strong>⚠️ This agent is NOT connected to the user.</strong><br>
                        You can safely delete this agent in the DigitalOcean dashboard.
                      </div>
                    ` : isCorrect ? `
                      <div class="action-box" style="background-color: #e8f5e9; border-left-color: #388e3c;">
                        <strong>✅ This is the correct agent.</strong><br>
                        Keep this agent - it's connected to the user and has the correct configuration.
                      </div>
                    ` : `
                      <div class="action-box" style="background-color: #fff3e0; border-left-color: #f57c00;">
                        <strong>⚠️ This agent is connected but has incorrect max_tokens.</strong><br>
                        The agent should have max_tokens=16384 but shows ${agent.maxTokens}.<br>
                        Consider updating the agent configuration or recreating it.
                      </div>
                    `}
                  </div>
                `;
              }).join('')}
            `}

            ${matchingAgents.length > 1 ? `
              <div class="action-box">
                <h3>Summary</h3>
                <p><strong>Connected Agent:</strong> ${matchingAgents.find(a => a.isStoredAgent) ? matchingAgents.find(a => a.isStoredAgent).uuid : 'NONE FOUND'}</p>
                <p><strong>Agents to Delete:</strong> ${matchingAgents.filter(a => !a.isStoredAgent && !a.isProfileAgent).map(a => a.uuid).join(', ') || 'NONE'}</p>
                <p><em>Go to DigitalOcean dashboard and delete the disconnected agents listed above.</em></p>
              </div>
            ` : ''}
          </div>
        </body>
      </html>
    `;

    res.send(html);
  } catch (error) {
    console.error('❌ Agent diagnostic error:', error);
    res.status(500).send(`
      <html>
        <head><title>Agent Diagnostic Error</title></head>
        <body style="font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px;">
          <h2 style="color: #d32f2f;">❌ Diagnostic Error</h2>
          <p>An error occurred while generating the diagnostic report:</p>
          <pre style="background-color: #f5f5f5; padding: 15px; border-radius: 4px; overflow-x: auto;">${error.message}</pre>
        </body>
      </html>
    `);
  }
});

// Admin provision endpoint - create agent for user
app.get('/api/admin/provision', async (req, res) => {
  try {
    const { token, userId } = req.query;

    if (!token || !userId) {
      return res.status(400).send(`
        <html>
          <head><title>Provision Error</title></head>
          <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
            <h2 style="color: #d32f2f;">❌ Provisioning Failed</h2>
            <p>Missing required parameters (token and userId).</p>
          </body>
        </html>
      `);
    }

    // Get user document
    let userDoc;
    try {
      userDoc = await cloudant.getDocument('maia_users', userId);
    } catch (error) {
      return res.status(404).send(`
        <html>
          <head><title>Provision Error</title></head>
          <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
            <h2 style="color: #d32f2f;">❌ Provisioning Failed</h2>
            <p>User not found: ${userId}</p>
          </body>
        </html>
      `);
    }

    // Validate token (allow viewing completed provisioning for 24 hours)
    if (!userDoc.provisionToken || userDoc.provisionToken !== token) {
      // If user is already provisioned, allow viewing the page without token for 24 hours
      if (userDoc.provisioned && userDoc.provisionedAt) {
        const provisionedAt = new Date(userDoc.provisionedAt);
        const hoursSinceProvisioned = (Date.now() - provisionedAt.getTime()) / (1000 * 60 * 60);
        if (hoursSinceProvisioned <= 24) {
          // Allow viewing completed provisioning page for 24 hours without token
          // This allows admins to view the results even after the page auto-refreshes
        } else {
          return res.status(401).send(`
            <html>
              <head><title>Provision Error</title></head>
              <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
                <h2 style="color: #d32f2f;">❌ Invalid Token</h2>
                <p>The provisioning token is invalid or has expired. Provisioning was completed more than 24 hours ago.</p>
              </body>
            </html>
          `);
        }
      } else {
        return res.status(401).send(`
          <html>
            <head><title>Provision Error</title></head>
            <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
              <h2 style="color: #d32f2f;">❌ Invalid Token</h2>
              <p>The provisioning token is invalid or has expired.</p>
            </body>
          </html>
        `);
      }
    }

    // Check if user already has an agent
    if (userDoc.assignedAgentId) {
      // User already provisioned - return success
      if (!provisioningLogs.has(userId)) {
        provisioningLogs.set(userId, []);
      }
      logProvisioning(userId, `ℹ️  Provision link opened but user ${userId} already has agent: ${userDoc.assignedAgentId}`, 'info');
      return res.send(`
        <html>
          <head><title>User Already Provisioned</title></head>
          <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
            <h2 style="color: #388e3c;">✅ User Already Provisioned</h2>
            <p><strong>User:</strong> ${userId}</p>
            <p><strong>Agent:</strong> ${userDoc.assignedAgentName || userDoc.assignedAgentId}</p>
            <p>The user already has an agent assigned.</p>
          </body>
        </html>
      `);
    }

    const existingStatus = provisioningStatus.get(userId);
    if (existingStatus && existingStatus.status === 'in_progress') {
      return res.send(getProvisionPage(userId));
    }

    if (!provisioningLogs.has(userId)) {
      provisioningLogs.set(userId, []);
    }
    logProvisioning(userId, `👀 Provisioning confirmation page viewed for user: ${userId}`, 'info');

    const confirmationPage = `
      <html>
        <head><title>Confirm Provisioning</title></head>
        <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
          <h2 style="color: #1976d2;">Confirm Provisioning</h2>
          <p>This will create a new DigitalOcean agent, configure storage, and update onboarding records for <strong>${userId}</strong>.</p>
          <p>Please confirm that you intend to provision this user.</p>
          <div style="margin-top: 30px;">
            <form method="post" action="/api/admin/provision/confirm" style="display: inline-block; margin-right: 10px;">
              <input type="hidden" name="userId" value="${userId}">
              <input type="hidden" name="token" value="${token}">
              <button type="submit" name="action" value="accept" style="padding: 10px 20px; background-color: #388e3c; color: white; border: none; border-radius: 4px; cursor: pointer;">Accept</button>
            </form>
            <form method="post" action="/api/admin/provision/confirm" style="display: inline-block;">
              <input type="hidden" name="userId" value="${userId}">
              <input type="hidden" name="token" value="${token}">
              <button type="submit" name="action" value="reject" style="padding: 10px 20px; background-color: #d32f2f; color: white; border: none; border-radius: 4px; cursor: pointer;">Reject</button>
            </form>
          </div>
        </body>
      </html>
    `;

    res.send(confirmationPage);
  } catch (error) {
    console.error('❌ Provision error:', error);
    res.status(500).send(`
      <html>
        <head><title>Provision Error</title></head>
        <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
          <h2 style="color: #d32f2f;">❌ Provisioning Failed</h2>
          <p>An error occurred while starting provisioning:</p>
          <pre style="background-color: #f5f5f5; padding: 15px; border-radius: 4px; overflow-x: auto;">${error.message}</pre>
        </body>
      </html>
    `);
  }
});

app.post('/api/admin/provision/confirm', async (req, res) => {
  try {
    const { token, userId, action } = req.body || {};

    if (!token || !userId || !action) {
      return res.status(400).send(`
        <html>
          <head><title>Provision Error</title></head>
          <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
            <h2 style="color: #d32f2f;">❌ Provisioning Failed</h2>
            <p>Missing required parameters (token, userId, or action).</p>
          </body>
        </html>
      `);
    }

    let userDoc;
    try {
      userDoc = await cloudant.getDocument('maia_users', userId);
    } catch (error) {
      return res.status(404).send(`
        <html>
          <head><title>Provision Error</title></head>
          <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
            <h2 style="color: #d32f2f;">❌ Provisioning Failed</h2>
            <p>User not found: ${userId}</p>
          </body>
        </html>
      `);
    }

    if (!userDoc.provisionToken || userDoc.provisionToken !== token) {
      return res.status(401).send(`
        <html>
          <head><title>Provision Error</title></head>
          <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
            <h2 style="color: #d32f2f;">❌ Invalid Token</h2>
            <p>The provisioning token is invalid or has expired.</p>
          </body>
        </html>
      `);
    }

    if (!provisioningLogs.has(userId)) {
      provisioningLogs.set(userId, []);
    }

    if (action === 'reject') {
      console.log(`[NEW FLOW 2] Admin rejected provisioning for user: ${userId}`);
      logProvisioning(userId, `⛔️ Provisioning rejected for user ${userId}`, 'warning');
      
      // Cleanup: Delete bucket folder and user document (keep audit log)
      try {
        console.log(`[NEW FLOW 2] Starting cleanup for rejected user: ${userId}`);
        
        // Delete all files in user's bucket folder
        const bucketUrl = getSpacesBucketName();
        if (bucketUrl) {
          const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';
        const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
          const s3Client = new S3Client({
            endpoint: getSpacesEndpoint(),
            region: 'us-east-1',
            forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
            credentials: {
              accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
              secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
            }
          });
          
          // List all objects with userId prefix (with pagination)
          let deletedCount = 0;
          let continuationToken = null;
          
          do {
            // Create a new command for each iteration (commands are immutable)
            const listCommand = new ListObjectsV2Command({
              Bucket: bucketName,
              Prefix: `${userId}/`,
              ContinuationToken: continuationToken || undefined
            });
            
            const listResult = await s3Client.send(listCommand);
            
            if (listResult.Contents && listResult.Contents.length > 0) {
              for (const object of listResult.Contents) {
                if (object.Key) {
                  try {
                    await deleteObjectWithLog({
                      s3Client,
                      bucketName,
                      key: object.Key
                    });
                    deletedCount++;
                    console.log(`[NEW FLOW 2] Deleted file: ${object.Key}`);
                  } catch (deleteErr) {
                    console.error(`[NEW FLOW 2] Failed to delete ${object.Key}:`, deleteErr.message);
                  }
                }
              }
            }
            
            // Get continuation token for next iteration (if any)
            continuationToken = listResult.NextContinuationToken || null;
          } while (continuationToken);
          
          console.log(`[NEW FLOW 2] Deleted ${deletedCount} files from bucket folder for ${userId}`);
        }
        
        // Delete user document
        try {
          await cloudant.deleteDocument('maia_users', userId);
          console.log(`[NEW FLOW 2] Deleted user document for ${userId}`);
        } catch (deleteErr) {
          console.error(`[NEW FLOW 2] Failed to delete user document:`, deleteErr.message);
        }
        
        console.log(`[NEW FLOW 2] ✅ Cleanup completed for rejected user: ${userId}`);
      } catch (cleanupErr) {
        console.error(`[NEW FLOW 2] ❌ Error during cleanup:`, cleanupErr.message);
        // Continue even if cleanup fails
      }
      
      return res.send(`
        <html>
          <head><title>Provisioning Cancelled</title></head>
          <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
            <h2 style="color: #d32f2f;">Provisioning Cancelled</h2>
            <p>The provisioning request for <strong>${userId}</strong> has been cancelled. The user account and associated files have been removed.</p>
          </body>
        </html>
      `);
    }

    if (action !== 'accept') {
      return res.status(400).send(`
        <html>
          <head><title>Provision Error</title></head>
          <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
            <h2 style="color: #d32f2f;">❌ Provisioning Failed</h2>
            <p>Unsupported action: ${action}</p>
          </body>
        </html>
      `);
    }

    if (userDoc.assignedAgentId) {
      logProvisioning(userId, `ℹ️  Provision confirmation received but user already has agent: ${userDoc.assignedAgentId}`, 'info');
      return res.send(`
        <html>
          <head><title>User Already Provisioned</title></head>
          <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
            <h2 style="color: #388e3c;">✅ User Already Provisioned</h2>
            <p><strong>User:</strong> ${userId}</p>
            <p><strong>Agent:</strong> ${userDoc.assignedAgentName || userDoc.assignedAgentId}</p>
            <p>No provisioning actions were performed.</p>
          </body>
        </html>
      `);
    }

    const existingStatus = provisioningStatus.get(userId);
    if (existingStatus && existingStatus.status === 'in_progress') {
      logProvisioning(userId, `ℹ️  Provision confirmation received but provisioning already in progress`, 'info');
      return res.send(getProvisionPage(userId));
    }

    logProvisioning(userId, `🔵 Admin confirmed provisioning for user: ${userId}`, 'info');
    logProvisioning(userId, `📍 Setting workflowStage to 'approved'`, 'info');
    userDoc.workflowStage = 'approved';
    await cloudant.saveDocument('maia_users', userDoc);

    provisioningStatus.set(userId, {
      status: 'in_progress',
      steps: [],
      startTime: Date.now(),
      currentStep: 'Starting...'
    });

    logProvisioning(userId, `🚀 Starting async provisioning for user: ${userId}`, 'info');

    provisionUserAsync(userId, token).catch(error => {
      logProvisioning(userId, `❌ Unhandled error in async provisioning: ${error.message}`, 'error');
      const status = provisioningStatus.get(userId);
      if (status) {
        status.status = 'failed';
        status.error = error.message;
        status.completedAt = Date.now();
      }
    });

    res.send(getProvisionPage(userId));
  } catch (error) {
    console.error('❌ Provision confirmation error:', error);
    res.status(500).send(`
      <html>
        <head><title>Provision Error</title></head>
        <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
          <h2 style="color: #d32f2f;">❌ Provisioning Failed</h2>
          <p>An error occurred while processing your request:</p>
          <pre style="background-color: #f5f5f5; padding: 15px; border-radius: 4px; overflow-x: auto;">${error.message}</pre>
        </body>
      </html>
    `);
  }
});

/*
// Comprehensive verification function
async function verifyProvisioningComplete(userId, agentId, agentName, kbName, expectedConfig) {
  logProvisioning(userId, `🔍 Starting comprehensive verification...`, 'info');
  
  const verificationResults = {
    kbName: { passed: false, message: '' },
    bucketFolders: { passed: false, message: '' },
    agentExists: { passed: false, message: '' },
    agentDeployed: { passed: false, message: '' },
    agentConfig: { passed: false, message: '' },
    apiKey: { passed: false, message: '' },
    apiKeyWorks: { passed: false, message: '' }
  };
  
  try {
    // 0. Verify KB name is set
    if (kbName) {
      verificationResults.kbName.passed = true;
      verificationResults.kbName.message = `KB name: ${kbName}`;
      logProvisioning(userId, `✅ KB name verified: ${kbName}`, 'success');
    } else {
      verificationResults.kbName.message = 'KB name not set';
      logProvisioning(userId, `❌ KB name not set`, 'error');
    }
    
    // 1. Verify bucket folders (check accessibility)
    try {
      const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
      const bucketUrl = getSpacesBucketName();
      if (bucketUrl) {
        const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';
        const s3Client = new S3Client({
          endpoint: getSpacesEndpoint(),
          region: 'us-east-1',
          forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
          credentials: {
            accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
            secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
          }
        });
        
        // Check if folders exist by looking for the .keep placeholder files
        try {
          const { GetObjectCommand } = await import('@aws-sdk/client-s3');
          
          // Check root folder (for new imports)
          const rootKeep = `${userId}/.keep`;
          const rootCheck = await s3Client.send(new GetObjectCommand({
            Bucket: bucketName,
            Key: rootKeep
          }));
          
          // Check archived folder
          const archivedKeep = `${userId}/archived/.keep`;
          const archivedCheck = await s3Client.send(new GetObjectCommand({
            Bucket: bucketName,
            Key: archivedKeep
          }));
          if (rootCheck && archivedCheck) {
            verificationResults.bucketFolders.passed = true;
            verificationResults.bucketFolders.message = `Bucket folders verified: ${userId}/ (root) and ${userId}/archived/ (archived); KB folder is implicit`;
            logProvisioning(userId, `✅ Bucket folders verified`, 'success');
          } else {
            verificationResults.bucketFolders.message = `Bucket folders missing .keep files`;
            logProvisioning(userId, `⚠️  Bucket folders missing .keep files`, 'warning');
          }
        } catch (err) {
          // If .keep files don't exist, try listing as fallback
          try {
            const listResult = await s3Client.send(new ListObjectsV2Command({
              Bucket: bucketName,
              Prefix: `${userId}/`,
              MaxKeys: 1
            }));
            verificationResults.bucketFolders.passed = true;
            verificationResults.bucketFolders.message = `Bucket folders accessible (via listing): ${userId}/ (root) and ${userId}/${kbName}/ (KB)`;
            logProvisioning(userId, `✅ Bucket folders verified via listing`, 'success');
          } catch (listErr) {
          verificationResults.bucketFolders.message = `Bucket access check failed: ${err.message}`;
          logProvisioning(userId, `⚠️  Bucket folder check: ${verificationResults.bucketFolders.message}`, 'warning');
          }
        }
      } else {
        verificationResults.bucketFolders.message = 'Bucket not configured';
        logProvisioning(userId, `⚠️  Bucket not configured, skipping folder check`, 'warning');
      }
    } catch (err) {
      verificationResults.bucketFolders.message = `Bucket verification error: ${err.message}`;
      logProvisioning(userId, `⚠️  ${verificationResults.bucketFolders.message}`, 'warning');
    }
    
    // 3. Verify agent via DO API
    try {
      const agentDetails = await doClient.agent.get(agentId);
      if (agentDetails && agentDetails.uuid === agentId) {
        verificationResults.agentExists.passed = true;
        verificationResults.agentExists.message = `Agent exists: ${agentDetails.name}`;
        logProvisioning(userId, `✅ Agent exists: ${agentDetails.name}`, 'success');
        
        // Verify deployment status
        if (agentDetails.deployment?.status === 'STATUS_RUNNING') {
          verificationResults.agentDeployed.passed = true;
          verificationResults.agentDeployed.message = `Agent deployed and running`;
          logProvisioning(userId, `✅ Agent deployed: STATUS_RUNNING`, 'success');
        } else {
          verificationResults.agentDeployed.message = `Agent deployment status: ${agentDetails.deployment?.status || 'unknown'}`;
          logProvisioning(userId, `❌ Agent not fully deployed: ${verificationResults.agentDeployed.message}`, 'error');
        }
        
        // Verify agent config matches expected
        // Note: API might return different field names or types, so we need to handle both
        // Also handle undefined/null values
        const actualMaxTokens = agentDetails.max_tokens || agentDetails.maxTokens;
        const actualTemperature = agentDetails.temperature ?? null; // Will fail comparison if undefined/null
        const actualTopP = agentDetails.top_p || agentDetails.topP;
        
        // Normalize values for comparison (convert to numbers if needed)
        const normalizedMaxTokens = Number(actualMaxTokens);
        const normalizedTemperature = Number(actualTemperature);
        const normalizedTopP = Number(actualTopP);
        
        const configMatches = 
          normalizedMaxTokens === expectedConfig.maxTokens &&
          normalizedTemperature === expectedConfig.temperature &&
          normalizedTopP === expectedConfig.topP;
        
        if (configMatches) {
          verificationResults.agentConfig.passed = true;
          verificationResults.agentConfig.message = `Agent config matches expected values`;
          logProvisioning(userId, `✅ Agent config verified`, 'success');
        } else {
          // Log actual values for debugging
          const actualValues = `Actual: maxTokens=${normalizedMaxTokens}, temp=${normalizedTemperature}, topP=${normalizedTopP}`;
          const expectedValues = `Expected: maxTokens=${expectedConfig.maxTokens}, temp=${expectedConfig.temperature}, topP=${expectedConfig.topP}`;
          verificationResults.agentConfig.message = `Config mismatch. ${expectedValues} | ${actualValues}`;
          logProvisioning(userId, `⚠️  Agent config mismatch: ${verificationResults.agentConfig.message}`, 'warning');
        }
      } else {
        verificationResults.agentExists.message = `Agent not found or UUID mismatch`;
        logProvisioning(userId, `❌ Agent verification failed: ${verificationResults.agentExists.message}`, 'error');
      }
    } catch (err) {
      verificationResults.agentExists.message = `DO API error: ${err.message}`;
      logProvisioning(userId, `❌ Agent verification error: ${err.message}`, 'error');
    }
    
    // 4. Verify API key
    // Fetch user document to check API key and agent details
    let userDoc = null;
    try {
      userDoc = await cloudant.getDocument('maia_users', userId);
    } catch (err) {
      verificationResults.apiKey.message = `Error fetching user document: ${err.message}`;
      logProvisioning(userId, `❌ Error fetching user document for API key verification: ${err.message}`, 'error');
    }
    
    if (userDoc && userDoc.agentApiKey) {
      verificationResults.apiKey.passed = true;
      verificationResults.apiKey.message = `API key exists`;
      logProvisioning(userId, `✅ API key exists`, 'success');
      
      // Test API key with actual API call
      try {
        const { DigitalOceanProvider } = await import('../lib/chat-client/providers/digitalocean.js');
        const agentEndpoint = userDoc.agentEndpoint;
        if (agentEndpoint) {
          const testProvider = new DigitalOceanProvider(userDoc.agentApiKey, { baseURL: agentEndpoint });
          const modelName = userDoc.agentModelName || 'unknown';
          
          logProvisioning(userId, `🔑 Testing API key with test request...`, 'info');
          const testResult = await testProvider.chat(
            [{ role: 'user', content: 'test' }],
            { model: modelName, stream: false }
          );
          
          if (testResult && !testResult.error && testResult.content) {
            verificationResults.apiKeyWorks.passed = true;
            verificationResults.apiKeyWorks.message = `API key works - test request successful`;
            logProvisioning(userId, `✅ API key verified - test request successful`, 'success');
          } else {
            // Check if error is a Cloudflare DNS/infrastructure issue
            const errorMsg = testResult?.error || String(testResult) || 'no response';
            const isCloudflareError = errorMsg.includes('Cloudflare') || 
                                     errorMsg.includes('DNS points to prohibited IP') ||
                                     errorMsg.includes('Error 1000');
            
            if (isCloudflareError) {
              // Cloudflare/infrastructure issue - API key likely works, just infrastructure blocking
              verificationResults.apiKeyWorks.passed = true; // Mark as passed since it's not an API key issue
              verificationResults.apiKeyWorks.message = `API key likely valid - Cloudflare/infrastructure blocking test (non-critical)`;
              logProvisioning(userId, `⚠️  API key test blocked by Cloudflare/infrastructure (API key likely valid)`, 'warning');
            } else {
              verificationResults.apiKeyWorks.message = `API key test failed: ${errorMsg}`;
            logProvisioning(userId, `❌ API key test failed: ${verificationResults.apiKeyWorks.message}`, 'error');
            }
          }
        } else {
          verificationResults.apiKeyWorks.message = `Agent endpoint not available`;
          logProvisioning(userId, `⚠️  Cannot test API key: no agent endpoint`, 'warning');
        }
      } catch (err) {
        // Check if error is a Cloudflare DNS/infrastructure issue
        const errorMsg = err.message || String(err);
        const isCloudflareError = errorMsg.includes('Cloudflare') || 
                                 errorMsg.includes('DNS points to prohibited IP') ||
                                 errorMsg.includes('Error 1000');
        
        if (isCloudflareError) {
          // Cloudflare/infrastructure issue - API key likely works, just infrastructure blocking
          verificationResults.apiKeyWorks.passed = true; // Mark as passed since it's not an API key issue
          verificationResults.apiKeyWorks.message = `API key likely valid - Cloudflare/infrastructure blocking test (non-critical)`;
          logProvisioning(userId, `⚠️  API key test blocked by Cloudflare/infrastructure (API key likely valid): ${errorMsg.substring(0, 100)}`, 'warning');
        } else {
          verificationResults.apiKeyWorks.message = `API key test error: ${errorMsg}`;
          logProvisioning(userId, `❌ API key test error: ${errorMsg}`, 'error');
        }
      }
    } else {
      verificationResults.apiKey.message = `API key not found in user document`;
      logProvisioning(userId, `❌ API key not found`, 'error');
    }
    
  } catch (error) {
    logProvisioning(userId, `❌ Verification error: ${error.message}`, 'error');
  }
  
  // Calculate overall result
  // Note: KB name is not a critical check - KB doesn't exist during provisioning, only intended name is stored
  const criticalChecks = [
    verificationResults.agentExists,
    verificationResults.agentDeployed,
    verificationResults.apiKey,
    verificationResults.apiKeyWorks
  ];
  
  const allCriticalPassed = criticalChecks.every(check => check.passed);
  const allPassed = Object.values(verificationResults).every(result => result.passed);
  
  // Only log if critical checks failed (success is logged per-check)
  if (!allCriticalPassed) {
    logProvisioning(userId, `❌ Verification failed - critical checks did not pass`, 'error');
  }
  
  return {
    allCriticalPassed,
    allPassed,
    results: verificationResults
  };
}
*/

// Async provisioning function
async function provisionUserAsync(userId, token) {
  logProvisioning(userId, `Starting provisioning for user: ${userId}`, 'info');
  
  try {
    // Helper function to safely update user document with conflict retry
    const updateUserDoc = async (updates, retries = 3) => {
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          // Re-read document to get latest _rev
          const latestDoc = await cloudant.getDocument('maia_users', userId);
          
          const updatePayload = typeof updates === 'function'
            ? updates(latestDoc)
            : updates;
          
          // Merge updates with latest document
          const updatedDoc = {
            ...latestDoc,
            ...(updatePayload || {}),
            updatedAt: new Date().toISOString()
          };
          
          // Save with latest _rev
          await cloudant.saveDocument('maia_users', updatedDoc);
          logProvisioning(userId, `✅ User document updated successfully (attempt ${attempt})`, 'success');
          return updatedDoc;
        } catch (error) {
          if (error.statusCode === 409 && attempt < retries) {
            // Conflict - retry after short delay
            logProvisioning(userId, `⚠️  Document conflict (attempt ${attempt}/${retries}), retrying...`, 'warning');
            await new Promise(resolve => setTimeout(resolve, 200 * attempt)); // Exponential backoff
            continue;
          }
          throw error;
        }
      }
    };

    // Get user document
    let userDoc = await cloudant.getDocument('maia_users', userId);
    const kbInfo = (userDoc.connectedKBs && userDoc.connectedKBs.length > 0) 
      ? `connectedKBs=[${userDoc.connectedKBs.join(',')}]` 
      : (userDoc.connectedKB ? `connectedKB=${userDoc.connectedKB}` : 'no KB');
    logProvisioning(userId, `✅ User document loaded: workflowStage=${userDoc.workflowStage}, ${kbInfo}, kbStatus=${userDoc.kbStatus || 'none'}`, 'info');

    // Update status (internal status tracking only, no verbose logging)
    const updateStatus = (step, details = {}) => {
      const status = provisioningStatus.get(userId);
      if (status) {
        status.currentStep = step;
        status.steps.push({ step, timestamp: new Date().toISOString(), ...details });
      }
      // Only log important steps, not every status update
      // logProvisioning(userId, `📍 ${step}${details ? ': ' + JSON.stringify(details) : ''}`, 'info');
    };

    // Need to create agent - get model and project ID
    // Based on NEW-AGENT.txt specification
    let modelId = process.env.DO_MODEL_ID;
    let projectId = process.env.DO_PROJECT_ID;

    // Validate UUID format helper
    const isValidUUID = (str) => {
      if (!str || typeof str !== 'string') return false;
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      return uuidRegex.test(str.trim());
    };

    updateStatus('Resolving model and project IDs...');
    logProvisioning(userId, `🔍 Resolving model and project IDs...`, 'info');

    // Project ID may still come from an existing agent
    if (!isValidUUID(projectId)) {
      try {
        const agents = await doClient.agent.list();
        if (agents.length > 0) {
          const existingAgent = await doClient.agent.get(agents[0].uuid);
          if (!isValidUUID(projectId) && existingAgent.project_id && isValidUUID(existingAgent.project_id)) {
            projectId = existingAgent.project_id;
          }
        }
      } catch (error) {
        // Continue with fallback
      }
    }

    // If still no valid project, resolve via API (default or first project)
    if (!isValidUUID(projectId)) {
      projectId = await getProjectIdForGenAI(doClient) || projectId;
    }

    // PREFERRED PATH: look up Kimi K2.5 (the primary model) in the DO
    // catalog FIRST. Only fall back to an existing agent's model if the
    // catalog lookup fails.
    if (!isValidUUID(modelId)) {
      try {
        const modelsResponse = await doClient.request('/v2/gen-ai/models');
        const models = modelsResponse.models || modelsResponse.data?.models || [];
        if (models.length > 0) {
          const preferredModel = models.find(m =>
            m.inference_name === 'kimi-k2.5' || m.name === 'Kimi K2.5' || m.id === 'kimi-k2.5'
          );
          if (preferredModel && preferredModel.uuid && isValidUUID(preferredModel.uuid)) {
            modelId = preferredModel.uuid;
          }
        }
      } catch (error) {
        // Continue
      }
    }

    // FALLBACK: reuse an existing agent's model UUID
    if (!isValidUUID(modelId)) {
      try {
        const agents = await doClient.agent.list();
        if (agents.length > 0) {
          const existingAgent = await doClient.agent.get(agents[0].uuid);
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

    // Final validation
    if (!isValidUUID(modelId) || !isValidUUID(projectId)) {
      logProvisioning(userId, `❌ Failed to resolve IDs - Model: ${modelId || 'Not found'}, Project: ${projectId || 'Not found'}`, 'error');
      throw new Error(`Could not determine valid model ID or project ID. Model ID: ${modelId || 'Not found'}, Project ID: ${projectId || 'Not found'}`);
    }
    
    logProvisioning(userId, `✅ Resolved IDs - Model: ${modelId}, Project: ${projectId}`, 'success');

    // MAIA medical assistant instruction (from NEW-AGENT.txt)
    const maiaInstruction = getMaiaInstructionText();

    // Use pre-generated agent name from user document (created during registration)
    // If not found, generate one (backward compatibility)
    const agentName = userDoc.assignedAgentName || generateAgentName(userId);
    if (!userDoc.assignedAgentName) {
      logProvisioning(userId, `⚠️  Agent name not found in user doc, generating: ${agentName}`, 'warning');
    } else {
      logProvisioning(userId, `✅ Using pre-generated agent name: ${agentName}`, 'info');
    }

    const agentClient = doClient.agent;

    // Final validation
    if (!isValidUUID(modelId) || !isValidUUID(projectId)) {
      throw new Error(`Cannot create agent: Invalid modelId or projectId`);
    }

    // Step 1: Create bucket folder (KB folder) - Note: Folders should already exist from registration
    // This is kept here for backward compatibility, but should be a no-op if folders already exist
    updateStatus('Verifying bucket folders...');
    logProvisioning(userId, `📁 Verifying bucket folders for user: ${userId}`, 'info');
    
    const bucketUrl = getSpacesBucketName();
    if (!bucketUrl) {
      throw new Error('DigitalOcean bucket not configured');
    }
    
    const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';
    const kbName = await ensureKBNameOnUserDoc(userDoc, userId);
    
    // Check if folders already exist (created during registration)
    try {
      const { S3Client, PutObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
      const s3Client = new S3Client({
        endpoint: getSpacesEndpoint(),
        region: 'us-east-1',
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
        credentials: {
          accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
          secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
        }
      });
      
      // Check if folders already exist
      const rootPlaceholder = `${userId}/.keep`;
      const archivedPlaceholder = `${userId}/archived/.keep`;
      const kbPlaceholder = `${userId}/${kbName}/.keep`;
      
      let foldersExist = false;
      try {
        await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: rootPlaceholder }));
        await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: archivedPlaceholder }));
        await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: kbPlaceholder }));
        foldersExist = true;
        logProvisioning(userId, `✅ Bucket folders already exist (created during registration)`, 'info');
      } catch (checkErr) {
        // Folders don't exist, create them (backward compatibility)
        logProvisioning(userId, `📁 Creating bucket folders (not found during registration)`, 'info');
      }
      
      if (!foldersExist) {
        // Create placeholder files to make folders visible in dashboard
        // Use Buffer.from('') instead of empty string to avoid SDK warning about stream length
        // Create root userId folder placeholder (for new imports)
        await s3Client.send(new PutObjectCommand({
          Bucket: bucketName,
          Key: rootPlaceholder,
          Body: Buffer.from(''),
          ContentType: 'text/plain',
          ContentLength: 0,
          Metadata: {
            createdBy: 'provisioning',
            createdAt: new Date().toISOString()
          }
        }));
        
        // Create archived folder placeholder (for files moved from root)
        await s3Client.send(new PutObjectCommand({
          Bucket: bucketName,
          Key: archivedPlaceholder,
          Body: Buffer.from(''),
          ContentType: 'text/plain',
          ContentLength: 0,
          Metadata: {
            createdBy: 'provisioning',
            createdAt: new Date().toISOString()
          }
        }));
        
        // Create KB folder placeholder
        await s3Client.send(new PutObjectCommand({
          Bucket: bucketName,
          Key: kbPlaceholder,
          Body: Buffer.from(''),
          ContentType: 'text/plain',
          ContentLength: 0,
          Metadata: {
            createdBy: 'provisioning',
            createdAt: new Date().toISOString()
          }
        }));
        
        logProvisioning(userId, `✅ Bucket folders created: ${userId}/ (root), ${userId}/archived/ (archived), and ${userId}/${kbName}/ (KB)`, 'success');
      }
      
      // Ensure KB name is stored in user document
      if (!userDoc.kbName) {
        await updateUserDoc({
          kbName: kbName
        });
      }
      
      updateStatus('Bucket folders verified', { 
        root: `${userId}/`,
        kb: `${userId}/${kbName}/`
      });
    } catch (err) {
      logProvisioning(userId, `❌ Failed to verify/create bucket folders: ${err.message}`, 'error');
      throw new Error(`Failed to verify/create bucket folders: ${err.message}`);
    }

    // Step 2: KB creation is deferred to /api/update-knowledge-base
    // Never create a KB without a per-file datasource.
    let kbId = userDoc.kbId || null;
    updateStatus('Knowledge base will be created on first indexing request');
    logProvisioning(
      userId,
      `ℹ️  KB creation deferred until files are indexed via /api/update-knowledge-base`,
      'info'
    );

    // Step 2.4: Process Initial File for Lists (NEW - before indexing)
    // Extract categories and observations, save as separate category files
    if (userDoc.initialFile && userDoc.initialFile.bucketKey) {
      try {
        const initialFileBucketKey = userDoc.initialFile.bucketKey;
        const initialFileName = userDoc.initialFile.fileName;
        
        logProvisioning(userId, `Processing initial file for Lists: ${initialFileName}`, 'info');
        updateStatus('Processing Lists from initial file...', { fileName: initialFileName });
        
        // Verify file exists in S3
        const { S3Client, HeadObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
        const s3Client = new S3Client({
          endpoint: getSpacesEndpoint(),
          region: 'us-east-1',
          forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
          credentials: {
            accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
            secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
          }
        });
        
        try {
          await s3Client.send(new HeadObjectCommand({
            Bucket: bucketName,
            Key: initialFileBucketKey
          }));
          
          // Get PDF buffer
          const getCommand = new GetObjectCommand({
            Bucket: bucketName,
            Key: initialFileBucketKey
          });
          const pdfResponse = await s3Client.send(getCommand);
          const chunks = [];
          for await (const chunk of pdfResponse.Body) {
            chunks.push(chunk);
          }
          const pdfBuffer = Buffer.concat(chunks);
          
          // Extract PDF to markdown
          const { extractPdfWithPages } = await import('./utils/pdf-parser.js');
          const result = await extractPdfWithPages(pdfBuffer);
          let fullMarkdown = result.pages.map(p => `## Page ${p.page}\n\n${p.markdown}`).join('\n\n---\n\n');
          
          // Clean up page footers (same logic as in files.js)
          const pageFooterPattern = /^.*[Hh]ealth\s+[Pp]age\s+(\d+)\s+of\s+\d+.*$/;
          const continuedOnPattern = /^.*[Cc]ontinued\s+on\s+.*$/;
          const lines = fullMarkdown.split('\n');
          const cleanedLines = [];
          let i = 0;
          
          while (i < lines.length) {
            const line = lines[i];
            const trimmedLine = line.trim();
            const footerMatch = trimmedLine.match(pageFooterPattern);
            
            if (footerMatch) {
              const footerPageNum = parseInt(footerMatch[1], 10);
              const nextPageNum = footerPageNum + 1;
              
              // Look backward for "Continued on " pattern
              let lookBackIndex = cleanedLines.length - 1;
              let foundContinuedOn = false;
              let continuedOnIndex = -1;
              let linesChecked = 0;
              
              while (lookBackIndex >= 0 && linesChecked < 3) {
                const prevTrimmed = cleanedLines[lookBackIndex].trim();
                if (prevTrimmed.match(continuedOnPattern)) {
                  foundContinuedOn = true;
                  continuedOnIndex = lookBackIndex;
                  break;
                }
                if (prevTrimmed !== '') {
                  linesChecked++;
                }
                lookBackIndex--;
              }
              
              if (foundContinuedOn && continuedOnIndex >= 0) {
                cleanedLines.splice(continuedOnIndex, 1);
              }
              
              // Look ahead for next "###" header
              let j = i + 1;
              let foundNextHeader = false;
              let nextHeaderIndex = -1;
              
              while (j < lines.length) {
                const nextTrimmed = lines[j].trim();
                if (nextTrimmed.startsWith('###')) {
                  foundNextHeader = true;
                  nextHeaderIndex = j;
                  break;
                }
                j++;
              }
              
              if (foundNextHeader && nextHeaderIndex > i) {
                cleanedLines.push(`## Page ${nextPageNum}`);
                i = nextHeaderIndex;
                continue;
              } else {
                cleanedLines.push(`## Page ${nextPageNum}`);
                i++;
                continue;
              }
            }
            
            cleanedLines.push(line);
            i++;
          }
          
          fullMarkdown = cleanedLines.join('\n');
          
          // Remove last 4 lines
          const markdownLines = fullMarkdown.split('\n');
          if (markdownLines.length > 4) {
            markdownLines.splice(-4);
            fullMarkdown = markdownLines.join('\n');
          }
          
          // Save main markdown file
          const listsFolder = `${userId}/Lists/`;
          const cleanFileName = initialFileName.replace(/[^a-zA-Z0-9.-]/g, '_');
          const markdownFileName = cleanFileName.replace(/\.pdf$/i, '.md');
          const markdownBucketKey = `${listsFolder}${markdownFileName}`;
          
          const { PutObjectCommand } = await import('@aws-sdk/client-s3');
          await s3Client.send(new PutObjectCommand({
            Bucket: bucketName,
            Key: markdownBucketKey,
            Body: fullMarkdown,
            ContentType: 'text/markdown',
            Metadata: asciiSafeMetadata({
              fileName: initialFileName,
              processedAt: new Date().toISOString(),
              userId: userId
            })
          }));
          
          logProvisioning(userId, `Saved markdown file: ${markdownBucketKey}`, 'success');
          
          // Extract and save category files
          const { extractAndSaveCategoryFiles } = await import('./utils/lists-processor.js');
          const categoryFiles = await extractAndSaveCategoryFiles(
            fullMarkdown,
            userId,
            listsFolder,
            s3Client,
            bucketName
          );
          
          logProvisioning(userId, `Saved ${categoryFiles.length} category file(s)`, 'success');
          updateStatus('Lists processing complete', { categoryFilesCount: categoryFiles.length });
        } catch (listsErr) {
          logProvisioning(userId, `Error processing Lists: ${listsErr.message}. Continuing provisioning.`, 'warning');
          // Continue provisioning even if Lists processing fails
        }
      } catch (listsError) {
        logProvisioning(userId, `Error in Lists processing step: ${listsError.message}. Continuing provisioning.`, 'warning');
        // Continue provisioning even if Lists processing fails
      }
    }

    // Step 2.5: Index Initial File (if provided)
    // This happens BEFORE agent creation so the agent can use the indexed data immediately
    if (userDoc.initialFile && userDoc.initialFile.bucketKey) {
      logProvisioning(
        userId,
        `ℹ️  Initial file indexing deferred until user triggers Update and Index KB`,
        'info'
      );
    }
    // Step 3: Create Agent
    updateStatus('Creating agent...');
    logProvisioning(userId, `🤖 Creating agent with name: ${agentName}`, 'info');
    
    const newAgent = await agentClient.create({
      name: agentName,
      instruction: maiaInstruction,
      modelId: modelId.trim(), // Ensure no whitespace
      projectId: projectId.trim(), // Ensure no whitespace
      region: getDoRegion(),
      maxTokens: 32768,
      topP: 1,
      temperature: 0.1,
      k: 15,
      retrievalMethod: 'RETRIEVAL_METHOD_REWRITE'
    });

    if (!newAgent || !newAgent.uuid) {
      throw new Error('Agent creation failed - no UUID returned');
    }

    updateStatus('Agent created', { agentId: newAgent.uuid, agentName });

    // Set workflowStage to agent_named after agent is successfully created
    userDoc = await updateUserDoc({ workflowStage: 'agent_named' });

    // Step 4: Attach KB to Agent (only if KB already exists)
    if (kbId) {
      updateStatus('Attaching knowledge base to agent...');
      logProvisioning(userId, `🔗 Attaching KB ${kbId} to agent ${newAgent.uuid}`, 'info');
      
      try {
        await doClient.agent.attachKB(newAgent.uuid, kbId);
        logProvisioning(userId, `✅ Attached KB to agent`, 'success');
        updateStatus('Knowledge base attached to agent', { kbId });
      } catch (attachError) {
        // If already attached, that's fine
        if (attachError.message && attachError.message.includes('already')) {
          logProvisioning(userId, `ℹ️  KB already attached to agent`, 'info');
          updateStatus('Knowledge base already attached', { kbId });
        } else {
          logProvisioning(userId, `⚠️  Failed to attach KB to agent: ${attachError.message}`, 'warning');
          // Continue - attachment can be done later
        }
      }
    } else {
      logProvisioning(
        userId,
        `ℹ️  No KB to attach yet - will attach after first indexing`,
        'info'
      );
    }

    // Step 5: Wait for Deployment (monitor every 30 seconds for up to 10 minutes)
    updateStatus('Waiting for agent deployment...');
    logProvisioning(userId, `⏳ Waiting for agent deployment (agentId: ${newAgent.uuid})...`, 'info');
    
    // Wait 3 seconds before first check
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Poll for deployment status
    const successStatuses = ['STATUS_RUNNING', 'RUNNING', 'STATUS_SUCCEEDED', 'SUCCEEDED', 'STATUS_READY', 'READY'];
    let agentDetails = null;
    let deploymentStatus = 'STATUS_PENDING';
    const pollIntervalMs = 30000; // 30 seconds
    const maxAttempts = 50; // 25 minutes max (50 attempts @ 30s interval)
    let attempts = 0;

    while (attempts < maxAttempts && !successStatuses.includes(deploymentStatus)) {
      try {
        agentDetails = await agentClient.get(newAgent.uuid);
        const rawDeploymentStatus = agentDetails?.deployment?.status || agentDetails?.deployment?.state || null;
        const agentStatus = agentDetails?.status || agentDetails?.state || null;
        deploymentStatus = rawDeploymentStatus || agentStatus || 'STATUS_PENDING';
        
        // Log every attempt (since we're only polling every 30 seconds)
          logProvisioning(userId, `📊 Deployment status check (${attempts}/${maxAttempts}): ${deploymentStatus}`, 'info');
        
        if (successStatuses.includes(deploymentStatus)) {
          logProvisioning(userId, `✅ Agent deployment reached ${deploymentStatus} after ${attempts} attempts`, 'success');
          break;
        } else if (['STATUS_FAILED', 'FAILED', 'STATUS_ERROR'].includes(deploymentStatus)) {
          // If STATUS_FAILED occurs within first 2 minutes (first 4 attempts), wait 2 minutes and recheck
          // DO sometimes reports STATUS_FAILED early but then succeeds
          const isEarlyFailure = attempts < 4; // First 2 minutes (4 attempts * 30s = 120s)
          if (isEarlyFailure) {
            logProvisioning(userId, `⚠️ Early STATUS_FAILED detected on attempt ${attempts} (within first 2 minutes). Waiting 2 minutes before rechecking...`, 'warning');
            await new Promise(resolve => setTimeout(resolve, 120000)); // Wait 2 minutes
            
            // Recheck status after waiting
            try {
              agentDetails = await agentClient.get(newAgent.uuid);
              const recheckDeploymentStatus = agentDetails?.deployment?.status || agentDetails?.deployment?.state || agentDetails?.status || agentDetails?.state || 'STATUS_PENDING';
              logProvisioning(userId, `📊 Status after 2-minute wait: ${recheckDeploymentStatus}`, 'info');
              
              if (successStatuses.includes(recheckDeploymentStatus)) {
                deploymentStatus = recheckDeploymentStatus;
                logProvisioning(userId, `✅ Agent deployment succeeded after waiting. Status: ${deploymentStatus}`, 'success');
                break;
              } else if (['STATUS_FAILED', 'FAILED', 'STATUS_ERROR'].includes(recheckDeploymentStatus)) {
                logProvisioning(userId, `❌ Agent deployment still failed after 2-minute wait. Status: ${recheckDeploymentStatus}`, 'error');
          throw new Error('Agent deployment failed');
              } else {
                // Status changed to something else (e.g., STATUS_DEPLOYING), continue polling
                deploymentStatus = recheckDeploymentStatus;
                logProvisioning(userId, `ℹ️ Status changed to ${deploymentStatus}. Continuing to poll...`, 'info');
              }
            } catch (recheckError) {
              logProvisioning(userId, `❌ Error rechecking status after wait: ${recheckError.message}`, 'error');
              throw new Error('Agent deployment failed');
            }
          } else {
            // Not an early failure, fail immediately
            logProvisioning(userId, `❌ Agent deployment failed with status: ${deploymentStatus} (attempt ${attempts})`, 'error');
            throw new Error('Agent deployment failed');
          }
        }
        
        attempts++;
        if (attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, pollIntervalMs)); // Wait 30 seconds
        }
      } catch (error) {
        if (attempts === 0) {
          // First attempt might fail if agent is still initializing
          await new Promise(resolve => setTimeout(resolve, 5000));
          attempts++;
        } else {
          throw error;
        }
      }
    }

    if (!successStatuses.includes(deploymentStatus)) {
      let finalStatus = deploymentStatus;
      try {
        const agents = await agentClient.list();
        const matchingAgent = agents.find(agent => agent.uuid === newAgent.uuid || agent.id === newAgent.uuid);
        if (matchingAgent) {
          finalStatus = matchingAgent.status || matchingAgent.state || finalStatus;
          logProvisioning(userId, `ℹ️ Agent list status after timeout: ${finalStatus}`, 'info');
        } else {
          logProvisioning(userId, 'ℹ️ Agent not found in list after timeout check', 'warning');
        }
      } catch (statusError) {
        logProvisioning(userId, `⚠️ Unable to verify agent status after timeout: ${statusError.message}`, 'warning');
      }

      if (successStatuses.includes(finalStatus)) {
        deploymentStatus = finalStatus;
        logProvisioning(userId, '✅ Agent reported as running in final verification step; continuing provisioning.', 'success');
      } else {
        throw new Error(`Agent deployment timed out after ${attempts} attempts. Status: ${deploymentStatus}. Final reported status: ${finalStatus}`);
      }
    }

    updateStatus('Agent deployed', {
      status: deploymentStatus,
      endpoint: agentDetails?.deployment?.url ? `${agentDetails.deployment.url}/api/v1` : null,
      attempts
    });

    // Ensure deployment endpoint becomes available
    let agentEndpointUrl = agentDetails?.deployment?.url ? `${agentDetails.deployment.url}/api/v1` : null;
    if (!agentEndpointUrl) {
      updateStatus('Waiting for deployment endpoint...');
      logProvisioning(userId, '📡 Deployment running but endpoint not yet available. Polling for endpoint...', 'info');

      const endpointAttempts = 20; // 10 minutes max (20 attempts @ 30s interval)
      const endpointIntervalMs = 30000;
      let endpointReady = false;

      for (let attempt = 0; attempt < endpointAttempts; attempt++) {
        if (attempt > 0) {
          await new Promise(resolve => setTimeout(resolve, endpointIntervalMs));
        }

        try {
          const refreshedDetails = await agentClient.get(newAgent.uuid);
          const refreshedEndpoint = refreshedDetails?.deployment?.url ? `${refreshedDetails.deployment.url}/api/v1` : null;
          logProvisioning(
            userId,
            `📡 Agent endpoint poll (${attempt + 1}/${endpointAttempts}): ${refreshedEndpoint || 'pending'}`,
            'info'
          );

          if (refreshedEndpoint) {
            agentDetails = refreshedDetails;
            agentEndpointUrl = refreshedEndpoint;
            endpointReady = true;
            break;
          }
        } catch (endpointError) {
          logProvisioning(
            userId,
            `⚠️ Endpoint poll (${attempt + 1}/${endpointAttempts}) failed: ${endpointError.message}`,
            'warning'
          );
        }
      }

      if (!endpointReady || !agentEndpointUrl) {
        logProvisioning(userId, '❌ Agent deployment never exposed an endpoint URL', 'error');
        throw new Error('Agent deployment did not expose an endpoint within the expected time');
      }

      updateStatus('Deployment endpoint ready', { endpoint: agentEndpointUrl });
    }

    // Set workflowStage to agent_deployed when deployment reaches STATUS_RUNNING
    userDoc = await updateUserDoc({ workflowStage: 'agent_deployed' });

    // Step 3: Update Agent (to ensure all config is set)
    updateStatus('Updating agent configuration...');
    logProvisioning(userId, `📝 Updating agent config: temperature=0.1, max_tokens=16384, top_p=1`, 'info');
    
    await agentClient.update(newAgent.uuid, {
      instruction: maiaInstruction,
      max_tokens: 32768,
      top_p: 1,
      temperature: 0.1,
      k: 15,
      retrieval_method: 'RETRIEVAL_METHOD_REWRITE'
    });

    // Verify temperature was actually set to 0.1
    try {
      const verifyDetails = await agentClient.get(newAgent.uuid);
      const actualTemp = verifyDetails.temperature;
      
      // Temperature should be 0.1 as specified in NEW-AGENT.txt
      if (actualTemp === 0.1) {
        logProvisioning(userId, `✅ Temperature verified as 0.1`, 'success');
      } else {
        logProvisioning(userId, `⚠️  Temperature update may have failed - expected 0.1, got ${actualTemp}. Retrying update...`, 'warning');
        // Retry the update with explicit 0.1
        await agentClient.update(newAgent.uuid, {
          temperature: 0.1
        });
        // Verify again
        const retryDetails = await agentClient.get(newAgent.uuid);
        const retryTemp = retryDetails.temperature;
        if (retryTemp === 0.1) {
          logProvisioning(userId, `✅ Temperature corrected to 0.1 after retry`, 'success');
        } else {
          logProvisioning(userId, `❌ Temperature still incorrect after retry - expected 0.1, got ${retryTemp}`, 'error');
        }
      }
    } catch (verifyError) {
      logProvisioning(userId, `⚠️  Could not verify temperature after update: ${verifyError.message}`, 'warning');
    }

    updateStatus('Agent configuration updated', { updated: true });

    // Step 6: Create API Key
    updateStatus('Creating API key...');
    logProvisioning(userId, `🔑 Creating API key for agent: ${newAgent.uuid}`, 'info');
    
    const apiKey = await agentClient.createApiKey(newAgent.uuid, `agent-${newAgent.uuid}-api-key`);

    if (!apiKey) {
      logProvisioning(userId, `❌ API key creation failed - no key returned`, 'error');
      throw new Error('API key creation failed - no key returned');
    }

    logProvisioning(userId, `✅ API key created successfully (length: ${apiKey.length} chars)`, 'success');
    updateStatus('API key created', { keyCreated: true });

    // Step 7: Update User Document (before verification)
    updateStatus('Updating user document...');
    
    const agentModelName = agentDetails?.model?.inference_name || agentDetails?.model?.name || null;
    
    userDoc = await updateUserDoc((latestDoc) => {
      const docClone = { ...latestDoc };
      const timestamp = new Date().toISOString();
      const endpointToStore = agentEndpointUrl || docClone.agentEndpoint || null;
      const modelNameToStore = agentModelName || docClone.agentModelName || null;
      const defaultProfileKey = docClone.agentProfileDefaultKey || 'default';

      mergeAgentProfileOnDoc(docClone, defaultProfileKey, {
        agentId: newAgent.uuid,
        agentName,
        endpoint: endpointToStore,
        modelName: modelNameToStore,
        apiKey
      }, timestamp);

      docClone.agentProfileDefaultKey = defaultProfileKey;
      ensureDeepLinkAgentOverrides(docClone);

      return {
        assignedAgentId: newAgent.uuid,
        assignedAgentName: agentName,
        agentEndpoint: endpointToStore,
        agentModelName: modelNameToStore,
        agentApiKey: apiKey,
        agentProfiles: docClone.agentProfiles,
        agentProfileDefaultKey: docClone.agentProfileDefaultKey,
        deepLinkAgentOverrides: docClone.deepLinkAgentOverrides,
        provisioned: true,
        provisionedAt: timestamp,
        // Keep provisionToken for 24 hours after completion so the tracking page remains accessible
        // Token will be cleared after 24 hours by a separate cleanup process if needed
        // provisionToken: undefined,  // Keep token for viewing completed provisioning
        // provisionTokenCreatedAt: undefined  // Keep timestamp for viewing completed provisioning
      };
    });

    updateStatus('User document updated', { 
      updated: true,
      agentId: newAgent.uuid,
      agentName: agentName
    });

    // If indexing already completed, attach KB now that agent is ready
    logWizAttachCheck(
      `provision:${userId}`,
      {
        kbId: userDoc?.kbId || 'none',
        indexed: !!userDoc?.kbIndexingStatus?.backendCompleted,
        agentId: newAgent.uuid
      },
      `[WIZ] Attach check (provision): kbId=${userDoc?.kbId || 'none'} indexed=${!!userDoc?.kbIndexingStatus?.backendCompleted} agentId=${newAgent.uuid}`
    );
    if (userDoc?.kbId && userDoc?.kbIndexingStatus?.backendCompleted) {
      try {
        await doClient.agent.attachKB(newAgent.uuid, userDoc.kbId);
        invalidateResourceCache(userId);
        console.log(`[WIZ] ✅ Attached KB ${userDoc.kbId} to agent ${newAgent.uuid} after provisioning.`);
      } catch (attachError) {
        if (!attachError.message || !attachError.message.includes('already')) {
          console.error(`[WIZ] ❌ Attach failed (provision):`, attachError.message);
        }
      }
    }

    // Step 7.4: Generate Current Medications Token (UNCONDITIONAL - always generate token after agent is ready)
    // This ensures users can always edit Current Medications, even if AI generation fails or no markdown exists
    console.log(`[CUR MEDS] Step 7.4: Generating Current Medications token (unconditional)`);
    if (agentEndpointUrl && apiKey) {
      try {
        console.log(`[CUR MEDS] Agent is ready - generating token unconditionally`);
        const tokenData = generateCurrentMedicationsToken(userId);
        console.log(`[CUR MEDS] Token generated: ${tokenData.token.substring(0, 8)}... (expires: ${tokenData.expiresAt})`);
        
        // Save token to user document (even if Current Medications content is empty)
        await updateUserDoc({
          currentMedicationsToken: tokenData.token,
          currentMedicationsTokenExpiresAt: tokenData.expiresAt
        });
        console.log(`[CUR MEDS] ✅ Token saved to user document (unconditional)`);
        logProvisioning(userId, `🔗 [CURRENT MEDICATIONS] Deep link token generated and saved (unconditional)`, 'info');
      } catch (tokenError) {
        console.log(`[CUR MEDS] ❌ Error generating token: ${tokenError.message}`);
        console.log(`[CUR MEDS] Error stack: ${tokenError.stack}`);
        logProvisioning(userId, `⚠️  [CURRENT MEDICATIONS] Error generating token: ${tokenError.message}. Continuing provisioning.`, 'warning');
        // Don't fail provisioning if token generation fails
      }
    } else {
      console.log(`[CUR MEDS] ⚠️  Agent not ready - cannot generate token yet`);
    }

    // Step 7.5: Generate Current Medications Content (OPTIONAL - tries to pre-populate from markdown)
    // This is separate from token generation - token is always created, content is optional
    console.log(`[CUR MEDS] Step 7.5: Starting Current Medications content generation (optional)`);
    console.log(`[CUR MEDS] Prerequisites check: initialFile=${!!userDoc.initialFile}, bucketKey=${!!userDoc.initialFile?.bucketKey}, agentEndpointUrl=${!!agentEndpointUrl}, apiKey=${!!apiKey}`);
    
    if (userDoc.initialFile && userDoc.initialFile.bucketKey && agentEndpointUrl && apiKey) {
      console.log(`[CUR MEDS] ✅ All prerequisites met, proceeding with Current Medications generation`);
      try {
        const initialFileName = userDoc.initialFile.fileName;
        const listsFolder = `${userId}/Lists/`;
        // Sanitize filename to match how it's saved (spaces -> underscores)
        const cleanFileName = initialFileName.replace(/[^a-zA-Z0-9.-]/g, '_');
        const markdownFileName = cleanFileName.replace(/\.pdf$/i, '.md');
        const markdownBucketKey = `${listsFolder}${markdownFileName}`;
        console.log(`[CUR MEDS] Looking for markdown file: ${markdownBucketKey}`);
        
        // Check if Lists markdown file exists
        const { S3Client, GetObjectCommand, HeadObjectCommand } = await import('@aws-sdk/client-s3');
        
        // Get S3 client (same pattern as in files.js)
        const bucketUrl = getSpacesBucketName();
        if (!bucketUrl) {
          console.log(`[CUR MEDS] ⚠️  DigitalOcean bucket not configured. Skipping.`);
          logProvisioning(userId, `⚠️  [CURRENT MEDICATIONS] DigitalOcean bucket not configured. Skipping.`, 'warning');
        } else {
          console.log(`[CUR MEDS] Bucket URL: ${bucketUrl}`);
          const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';
          const s3Client = new S3Client({
            endpoint: getSpacesEndpoint(),
            region: 'us-east-1',
            forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
            credentials: {
              accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
              secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
            }
          });
          
          let markdownExists = false;
          try {
            console.log(`[CUR MEDS] Checking if markdown file exists: ${markdownBucketKey}`);
            await s3Client.send(new HeadObjectCommand({
              Bucket: bucketName,
              Key: markdownBucketKey
            }));
            markdownExists = true;
            console.log(`[CUR MEDS] ✅ Markdown file exists`);
          } catch (headErr) {
            console.log(`[CUR MEDS] ⚠️  Markdown file not found: ${markdownBucketKey}`);
            console.log(`[CUR MEDS] Error: ${headErr.message}`);
            logProvisioning(userId, `ℹ️  [CURRENT MEDICATIONS] Lists markdown not found: ${markdownBucketKey}. Skipping Current Medications generation.`, 'info');
          }
          
          if (markdownExists) {
          console.log(`[CUR MEDS] ✅ Markdown exists, proceeding with Current Medications content generation`);
          const contentGenStartTime = Date.now();
          updateStatus('Generating Current Medications...', { fileName: initialFileName });
          logProvisioning(userId, `💊 [CURRENT MEDICATIONS] Generating current medications from Lists markdown...`, 'info');
          
          try {
            // Read markdown file
            const getCommand = new GetObjectCommand({
              Bucket: bucketName,
              Key: markdownBucketKey
            });
            const markdownResponse = await s3Client.send(getCommand);
            
            const chunks = [];
            for await (const chunk of markdownResponse.Body) {
              chunks.push(chunk);
            }
            const markdownContent = Buffer.concat(chunks).toString('utf-8');
            
            // Extract Medication Records observations
            const lines = markdownContent.split('\n');
            let inMedicationCategory = false;
            let medicationStartLine = -1;
            let medicationEndLine = -1;
            const medicationObservations = [];
            
            // Find Medication Records category boundaries
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i].trim();
              
              // Check for Medication Records category
              if (line.startsWith('### ') && line.toLowerCase().includes('medication')) {
                if (line.toLowerCase().includes('record')) {
                  inMedicationCategory = true;
                  medicationStartLine = i;
                } else if (inMedicationCategory) {
                  // Next category found - end of Medication Records
                  medicationEndLine = i - 1;
                  break;
                }
              } else if (inMedicationCategory && line.startsWith('### ')) {
                // Another category found - end of Medication Records
                medicationEndLine = i - 1;
                break;
              }
            }
            
            // If we found the category, extract [D+P] lines
            if (inMedicationCategory && medicationStartLine >= 0) {
              if (medicationEndLine < 0) {
                medicationEndLine = lines.length - 1;
              }
              
              for (let i = medicationStartLine; i <= medicationEndLine; i++) {
                const line = lines[i];
                if (line.includes('[D+P]')) {
                  // Extract the observation text (everything after [D+P])
                  const observationText = line.replace(/^.*?\[D\+P\](?:\s+\w+)?\s*/, '').trim();
                  if (observationText) {
                    medicationObservations.push({
                      display: observationText,
                      date: observationText.split(/\s+/)[0] || ''
                    });
                  }
                }
              }
            }
            
            if (medicationObservations.length > 0) {
              logProvisioning(userId, `💊 [CURRENT MEDICATIONS] Found ${medicationObservations.length} medication observations`, 'info');
              
              // Format observations for AI prompt
              const medicationsText = medicationObservations.map((obs, idx) => {
                return `${idx + 1}. ${obs.display || obs.date || 'Unknown medication'}`;
              }).join('\n');
              
              // Call Private AI to generate current medications
              const { DigitalOceanProvider } = await import('../lib/chat-client/providers/digitalocean.js');
              const agentProvider = new DigitalOceanProvider(apiKey, {
                baseURL: agentEndpointUrl
              });
              
              const prompt = `What are the current medications from this list?\n\n${medicationsText}\n\nPlease list only the medications that are currently active or being taken. Format your response as a clear, readable list.`;
              
              logProvisioning(userId, `🤖 [CURRENT MEDICATIONS] Calling Private AI to identify current medications...`, 'info');
              console.log(`[CUR MEDS] Calling Private AI with prompt (first 200 chars): ${prompt.substring(0, 200)}...`);
              
              const response = await agentProvider.chat(
                [{ role: 'user', content: prompt }],
                { 
                  model: agentModelName || 'openai-gpt-oss-120b',
                  stream: false
                }
              );
              
              const currentMedications = (response.content || response.text || '').trim();
              console.log(`[CUR MEDS] Private AI response length: ${currentMedications.length}`);
              console.log(`[CUR MEDS] Private AI response (first 200 chars): ${currentMedications.substring(0, 200)}...`);
              
              // Step 5: Save content to user document
              if (currentMedications && currentMedications.length > 0) {
                console.log(`[CUR MEDS] [Step 5/5] Saving Current Medications content to user document...`);
                const saveStartTime = Date.now();
                // Note: Token was already generated in Step 7.4, so we only update the content here
                await updateUserDoc({
                  currentMedications: currentMedications
                });
                const saveDuration = Date.now() - saveStartTime;
                const totalDuration = Date.now() - contentGenStartTime;
                console.log(`[CUR MEDS] [Step 5/5] ✅ Content saved to user document (${saveDuration}ms)`);
                console.log(`[CUR MEDS] ✅ Current Medications content generation complete (total: ${totalDuration}ms, ${currentMedications.length} chars)`);
                
                logProvisioning(userId, `✅ [CURRENT MEDICATIONS] Current medications content generated and saved successfully`, 'success');
                updateStatus('Current Medications generated', { medicationsGenerated: true });
              } else {
                const totalDuration = Date.now() - contentGenStartTime;
                console.log(`[CUR MEDS] [Step 5/5] ⚠️  Empty response from Private AI - skipping content save`);
                console.log(`[CUR MEDS] ⚠️  Content generation completed but no content to save (total: ${totalDuration}ms, token still available)`);
                logProvisioning(userId, `⚠️  [CURRENT MEDICATIONS] Empty response from Private AI - user can still edit manually`, 'warning');
              }
            } else {
              const totalDuration = Date.now() - contentGenStartTime;
              console.log(`[CUR MEDS] ℹ️  No medication observations found in Lists markdown (total: ${totalDuration}ms)`);
              logProvisioning(userId, `ℹ️  [CURRENT MEDICATIONS] No medication observations found in Lists markdown`, 'info');
            }
          } catch (medError) {
            console.log(`[CUR MEDS] ❌ Error generating current medications: ${medError.message}`);
            console.log(`[CUR MEDS] Error stack: ${medError.stack}`);
            logProvisioning(userId, `⚠️  [CURRENT MEDICATIONS] Error generating current medications: ${medError.message}. Continuing provisioning.`, 'warning');
            // Don't fail provisioning if Current Medications generation fails
          }
          }
        }
      } catch (currentMedsError) {
        console.log(`[CUR MEDS] ❌ Error in Current Medications step: ${currentMedsError.message}`);
        console.log(`[CUR MEDS] Error stack: ${currentMedsError.stack}`);
        logProvisioning(userId, `⚠️  [CURRENT MEDICATIONS] Error in Current Medications step: ${currentMedsError.message}. Continuing provisioning.`, 'warning');
        // Don't fail provisioning
      }
    } else {
      console.log(`[CUR MEDS] ⚠️  Agent not ready - skipping Current Medications generation`);
      console.log(`[CUR MEDS] assignedAgentId: ${userDoc.assignedAgentId}, agentEndpoint: ${userDoc.agentEndpoint}`);
    }

    // Step 7.6: Generate Patient Summary (if initial file was indexed)
    // No KB verification to avoid churn
    if (userDoc.initialFile && userDoc.initialFile.bucketKey && agentEndpointUrl && apiKey) {
      logProvisioning(userId, `⏸️  [PATIENT SUMMARY] Automatic generation is temporarily disabled`, 'info');
    }
    if (false) {
    if (userDoc.initialFile && userDoc.initialFile.bucketKey && agentEndpointUrl && apiKey) {
      try {
        // Check if indexing completed for initial file
        const currentUserDoc = await cloudant.getDocument('maia_users', userId);
        const initialFileIndexed = Array.isArray(currentUserDoc?.files) &&
          currentUserDoc.files.some(file => file.bucketKey === userDoc.initialFile.bucketKey);
        
        if (initialFileIndexed) {
          // Step 7.5: Generate patient summary
          updateStatus('Generating patient summary...', { fileName: userDoc.initialFile.fileName });
          logProvisioning(userId, `📝 [PATIENT SUMMARY] Generating patient summary from indexed initial file...`, 'info');
          
          try {
            const { DigitalOceanProvider } = await import('../lib/chat-client/providers/digitalocean.js');
            const agentProvider = new DigitalOceanProvider(apiKey, {
              baseURL: agentEndpointUrl
            });

            // Build prompt - simple trigger, rely on agent instruction text for format
            // Include Current Medications if available (user-reviewed list takes precedence)
            let summaryPrompt = 'Please generate a patient summary.';
            
            // Get latest user document to check for Current Medications
            const latestUserDoc = await cloudant.getDocument('maia_users', userId);
            if (latestUserDoc.currentMedications && latestUserDoc.currentMedications.trim().length > 0) {
              summaryPrompt += `\n\nUse this as the authoritative source for Current Medications (the patient has reviewed and confirmed this list):\n\n${latestUserDoc.currentMedications}`;
            }

            const summaryResponse = await agentProvider.chat(
              [{ role: 'user', content: summaryPrompt }],
              { model: agentModelName || 'openai-gpt-oss-120b' }
            );

            const summary = summaryResponse.content || summaryResponse.text || '';

            if (!summary || summary.trim().length === 0) {
              logProvisioning(userId, `❌ [PATIENT SUMMARY] Patient summary generation returned empty result`, 'error');
            } else {
              const summaryUserDoc = await cloudant.getDocument('maia_users', userId);
              if (summaryUserDoc) {
                // Use helper function to add new summary (default to 'newest' strategy)
                addNewSummary(summaryUserDoc, summary, 'newest');
                summaryUserDoc.workflowStage = 'patient_summary';
                await cloudant.saveDocument('maia_users', summaryUserDoc);
                invalidateResourceCache(userId);
                updateStatus('Patient summary generated', { summaryLength: summary.length });
              } else {
                logProvisioning(userId, `❌ [PATIENT SUMMARY] Could not load user document to save patient summary`, 'error');
              }
            }
          } catch (summaryError) {
            logProvisioning(userId, `❌ [PATIENT SUMMARY] Error generating patient summary: ${summaryError.message}`, 'error');
            // Don't fail provisioning if summary generation fails
          }
        } else {
          logProvisioning(userId, `ℹ️  [PATIENT SUMMARY] Initial file not yet indexed - summary will be generated when indexing completes`, 'info');
        }
      } catch (summaryCheckError) {
        logProvisioning(userId, `⚠️  [PATIENT SUMMARY] Error checking indexing status for summary generation: ${summaryCheckError.message}`, 'warning');
        // Continue - summary can be generated later
      }
    }
    }

    const status = provisioningStatus.get(userId);
    if (status) {
      updateStatus('Provisioning complete');
    }

    logProvisioning(userId, `✅ Provisioning completed successfully for user: ${userId}, agent: ${agentName}`, 'success');

    // Mark as completed
    if (status) {
      const totalTime = ((Date.now() - status.startTime) / 1000).toFixed(1);
      status.status = 'completed';
      status.completedAt = Date.now();
      status.result = {
        agentId: newAgent.uuid,
        agentName,
        model: agentDetails?.model?.name || agentDetails?.model?.inference_name || 'Unknown',
        endpoint: userDoc.agentEndpoint || 'Not available',
        totalTime
      };
    }
    
    // No email notifications in self-hosted flow
  } catch (error) {
    logProvisioning(userId, `❌ Provisioning failed for user ${userId}: ${error.message}`, 'error');
    logProvisioning(userId, `❌ Error stack: ${error.stack}`, 'error');
    
    const status = provisioningStatus.get(userId);
    if (status) {
      status.status = 'failed';
      status.error = error.message;
      status.completedAt = Date.now();
    }
    
    // Log error details
    if (error.statusCode === 409) {
      logProvisioning(userId, `❌ Document conflict detected - this is a concurrency issue`, 'error');
    }
    
    // No email notifications in self-hosted flow
  }
}

// Save group chat endpoint
app.post('/api/save-group-chat', async (req, res) => {
  try {
    const { chatHistory, uploadedFiles, connectedKB } = req.body;
    const sessionUserId = req.session?.userId;
    const deepLinkSession = isDeepLinkSession(req);

    if (deepLinkSession) {
      return res.status(403).json({
        success: false,
        message: 'Deep link users cannot create new group chats',
        error: 'DEEPLINK_FORBIDDEN'
      });
    }

    const effectiveUserId = sessionUserId || req.body?.currentUser;
    if (!effectiveUserId) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated',
        error: 'NOT_AUTHENTICATED'
      });
    }
    
    if (!chatHistory || chatHistory.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'No chat history to save',
        error: 'MISSING_CHAT_HISTORY'
      });
    }

    // Generate a secure, random share ID
    const generateShareId = () => {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      let result = '';
      for (let i = 0; i < 12; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return result;
    };

    const shareId = generateShareId();
    
    // Process uploadedFiles - only store metadata, not large content
    const processedFiles = (uploadedFiles || []).map(file => ({
      id: file.id,
      name: file.name,
      size: file.size,
      type: file.type,
      bucketKey: file.bucketKey,
      bucketPath: file.bucketPath,
      uploadedAt: file.uploadedAt?.toISOString ? file.uploadedAt.toISOString() : file.uploadedAt
    }));
    
    // Generate _id starting with username
    const userName = effectiveUserId || 'anonymous';
    const randomId = Math.random().toString(36).substr(2, 9);
    const chatId = `${userName}-chat_${Date.now()}_${randomId}`;
    
    const groupChatDoc = {
      _id: chatId,
      type: 'group_chat',
      shareId: shareId,
      currentUser: effectiveUserId,
      patientOwner: effectiveUserId,
      connectedKB: connectedKB || 'No KB connected',
      chatHistory,
      uploadedFiles: processedFiles,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      participantCount: chatHistory.filter(msg => msg.role === 'user').length,
      messageCount: chatHistory.length,
      isShared: true,
      deepLinkUserIds: [] // Array to track deep link users who have accessed this chat
    };

    // Save to maia_chats database
    const result = await cloudant.saveDocument('maia_chats', groupChatDoc);
    
    // Set workflowStage to link_stored when chat is saved with shareId
    try {
      const userDoc = await cloudant.getDocument('maia_users', effectiveUserId);
      if (userDoc) {
        userDoc.workflowStage = 'link_stored';
        await cloudant.saveDocument('maia_users', userDoc);
      }
    } catch (err) {
      console.error('Error setting workflowStage to link_stored:', err);
      // Don't fail the request if workflowStage update fails
    }
    
    res.json({ 
      success: true, 
      chatId: result.id,
      shareId: shareId,
      message: 'Group chat saved successfully',
      result,
      shareUrl: `${appUrlConfig.appOrigin}/?share=${shareId}`
    });
  } catch (error) {
    console.error('❌ Save group chat error:', error);
    res.status(500).json({ 
      success: false,
      message: `Failed to save group chat: ${error.message}`,
      error: 'SAVE_CHAT_ERROR'
    });
  }
});

// Update existing group chat
app.put('/api/save-group-chat/:chatId', async (req, res) => {
  try {
    const { chatId } = req.params;
    const { chatHistory, uploadedFiles, connectedKB, shareId } = req.body;
    const sessionUserId = req.session?.userId;
    const deepLinkSession = isDeepLinkSession(req);

    if (!chatId) {
      return res.status(400).json({
        success: false,
        message: 'Chat ID is required',
        error: 'MISSING_CHAT_ID'
      });
    }

    if (!chatHistory || chatHistory.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No chat history to save',
        error: 'MISSING_CHAT_HISTORY'
      });
    }

    const existingChat = await cloudant.getDocument('maia_chats', chatId);

    if (!existingChat) {
      return res.status(404).json({
        success: false,
        message: 'Chat not found',
        error: 'CHAT_NOT_FOUND'
      });
    }

    const effectiveUserId = sessionUserId || req.body?.currentUser || existingChat.currentUser;

    if (!effectiveUserId) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated',
        error: 'NOT_AUTHENTICATED'
      });
    }

    const isOwner = existingChat.patientOwner && existingChat.patientOwner === effectiveUserId;

    if (deepLinkSession) {
      const allowedShares = ensureArray(req.session.deepLinkShareIds || []);
      if (!allowedShares.includes(existingChat.shareId)) {
        return res.status(403).json({
          success: false,
          message: 'Deep link users may only update the shared chat',
          error: 'DEEPLINK_FORBIDDEN'
        });
      }
      if (shareId && shareId !== existingChat.shareId) {
        return res.status(400).json({
          success: false,
          message: 'Cannot change share link for deep link chat',
          error: 'DEEPLINK_SHARE_MISMATCH'
        });
      }
    } else if (existingChat.currentUser && existingChat.currentUser !== effectiveUserId) {
      if (!isOwner) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to update this chat',
          error: 'CHAT_UPDATE_FORBIDDEN'
        });
      }
    }

    const processedFiles = (uploadedFiles || []).map(file => ({
      id: file.id,
      name: file.name,
      size: file.size,
      type: file.type,
      bucketKey: file.bucketKey,
      bucketPath: file.bucketPath,
      uploadedAt: file.uploadedAt?.toISOString ? file.uploadedAt.toISOString() : file.uploadedAt
    }));

    existingChat.chatHistory = chatHistory;
    existingChat.uploadedFiles = processedFiles;
    existingChat.connectedKB = connectedKB || existingChat.connectedKB;
    existingChat.updatedAt = new Date().toISOString();
    existingChat.messageCount = chatHistory.length;
    existingChat.participantCount = chatHistory.filter(msg => msg.role === 'user').length;
    existingChat.shareId = shareId || existingChat.shareId;
    if (!deepLinkSession || isOwner) {
      existingChat.currentUser = effectiveUserId;
    }

    await cloudant.saveDocument('maia_chats', existingChat);

    // Keep workflowStage in sync when chats are updated
    try {
      const userDoc = await cloudant.getDocument('maia_users', effectiveUserId);
      if (userDoc) {
        userDoc.workflowStage = 'link_stored';
        await cloudant.saveDocument('maia_users', userDoc);
      }
    } catch (stageError) {
      console.warn('⚠️ Unable to update workflow stage after chat update:', stageError.message);
    }

    res.json({
      success: true,
      message: 'Group chat updated successfully',
      chatId: existingChat._id,
      shareId: existingChat.shareId
    });
  } catch (error) {
    console.error('❌ Update group chat error:', error);
    res.status(500).json({
      success: false,
      message: `Failed to update group chat: ${error.message}`,
      error: 'UPDATE_CHAT_ERROR'
    });
  }
});

// Get user's saved chats
app.get('/api/user-chats', async (req, res) => {
  try {
    const { userId } = req.query;
    const sessionUserId = req.session?.userId;
    const deepLinkSession = isDeepLinkSession(req);
    
    if (!sessionUserId && !userId && !deepLinkSession) {
      return res.status(401).json({
        success: false, 
        message: 'User not authenticated',
        error: 'NOT_AUTHENTICATED'
      });
    }

    const effectiveUserId = sessionUserId || userId;

    if (sessionUserId && userId && sessionUserId !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Cannot request chats for another user',
        error: 'CHAT_ACCESS_FORBIDDEN'
      });
    }

    if (deepLinkSession) {
      const shareId = req.session.deepLinkShareId;
      const chatId = req.session.deepLinkChatId;
      const chats = [];
      if (chatId) {
        const chat = await cloudant.getDocument('maia_chats', chatId);
        if (chat && ensureArray(req.session.deepLinkShareIds).includes(chat.shareId)) {
          chats.push(chat);
        }
      } else if (shareId) {
        const chat = await getChatByShareId(shareId);
        if (chat) {
          chats.push(chat);
        }
      }

      return res.json({
        success: true,
        chats,
        count: chats.length
      });
    }

    const allChats = await cloudant.getAllDocuments('maia_chats');
    const userChats = allChats.filter(chat => chat._id.startsWith(`${effectiveUserId}-`));

    // Only log if there are chats (0 is the default/expected state)
    if (userChats.length > 0) {
    console.log(`✅ Found ${userChats.length} chats for user ${effectiveUserId}`);
    }
    
    res.json({
      success: true,
      chats: userChats,
      count: userChats.length
    });
  } catch (error) {
    console.error('❌ Error fetching user chats:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to fetch chats: ${error.message}`,
      error: 'FETCH_CHATS_ERROR'
    });
  }
});

// Load a specific chat by ID
app.get('/api/load-chat/:chatId', async (req, res) => {
  try {
    const { chatId } = req.params;
    
    const chat = await cloudant.getDocument('maia_chats', chatId);
    
    if (!chat) {
      return res.status(404).json({ 
        success: false, 
        message: 'Chat not found',
        error: 'CHAT_NOT_FOUND'
      });
    }
    
    if (isDeepLinkSession(req)) {
      const allowedShares = ensureArray(req.session.deepLinkShareIds);
      const allowedChatId = req.session.deepLinkChatId;
      if (chat._id !== allowedChatId && !allowedShares.includes(chat.shareId)) {
        return res.status(403).json({
          success: false,
          message: 'Deep link users may only access the shared chat',
          error: 'DEEPLINK_FORBIDDEN'
        });
      }
      
      // Add deep link user to chat's tracking list
      const deepLinkUserId = req.session.deepLinkUserId || req.session.userId;
      if (deepLinkUserId) {
        await addDeepLinkUserToChat(chat, deepLinkUserId);
      }
      
      req.session.deepLinkChatId = chat._id;
    }
    
    res.json({
      success: true,
      chat: chat
    });
  } catch (error) {
    console.error('❌ Error loading chat:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to load chat: ${error.message}`,
      error: 'LOAD_CHAT_ERROR'
    });
  }
});

// Load a specific chat by shareId (for deep links)
app.get('/api/load-chat-by-share/:shareId', async (req, res) => {
  try {
    const { shareId } = req.params;
    
    if (!shareId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Share ID is required',
        error: 'MISSING_SHARE_ID'
      });
    }
    
    const chat = await getChatByShareId(shareId);
    
    if (!chat) {
      return res.status(404).json({ 
        success: false, 
        message: 'Chat not found',
        error: 'CHAT_NOT_FOUND'
      });
    }
    
    if (isDeepLinkSession(req)) {
      const allowedShares = ensureArray(req.session.deepLinkShareIds);
      if (!allowedShares.includes(shareId)) {
        return res.status(403).json({
          success: false,
          message: 'Deep link users may only access the shared chat',
          error: 'DEEPLINK_FORBIDDEN'
        });
      }
      
      // Add deep link user to chat's tracking list
      const deepLinkUserId = req.session.deepLinkUserId || req.session.userId;
      if (deepLinkUserId) {
        await addDeepLinkUserToChat(chat, deepLinkUserId);
      }
      
      req.session.deepLinkChatId = chat._id;
    }
    
    res.json({
      success: true,
      chat: chat
    });
  } catch (error) {
    console.error('❌ Error loading chat by shareId:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to load chat: ${error.message}`,
      error: 'LOAD_CHAT_ERROR'
    });
  }
});

// Delete a specific chat
app.delete('/api/delete-chat/:chatId', async (req, res) => {
  try {
    const { chatId } = req.params;
    
    await cloudant.deleteDocument('maia_chats', chatId);
    
    console.log(`✅ Deleted chat ${chatId}`);
    
    res.json({
      success: true,
      message: 'Chat deleted successfully'
    });
  } catch (error) {
    console.error('❌ Error deleting chat:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to delete chat: ${error.message}`,
      error: 'DELETE_CHAT_ERROR'
    });
  }
});

// User file metadata endpoint - updates user document with file info
app.post('/api/user-file-metadata', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return; // 403 already sent on mismatch
    const { fileMetadata, updateInitialFile } = req.body;

    if (!fileMetadata) {
      return res.status(400).json({
        success: false,
        message: 'File metadata is required',
        error: 'MISSING_REQUIRED_FIELDS'
      });
    }

    let saved = false;
    let attempts = 0;
    let userDoc = null;
    let opLabel = 'unknown';
    while (!saved && attempts < 3) {
      attempts += 1;
      userDoc = await cloudant.getDocument('maia_users', userId);
      
      if (!userDoc) {
        return res.status(404).json({ 
          success: false, 
          message: 'User not found',
          error: 'USER_NOT_FOUND'
        });
      }

      // Initialize files array if it doesn't exist
      if (!userDoc.files) {
        userDoc.files = [];
      }

      // Check if file already exists (by bucketKey)
      const existingFileIndex = userDoc.files.findIndex(f => f.bucketKey === fileMetadata.bucketKey);
      opLabel = existingFileIndex >= 0 ? 'update' : 'insert';
      
      if (existingFileIndex >= 0) {
        // Update existing file metadata
        userDoc.files[existingFileIndex] = {
          ...userDoc.files[existingFileIndex],
          ...fileMetadata,
          updatedAt: new Date().toISOString()
        };
      } else {
        // Add new file metadata
        userDoc.files.push({
          ...fileMetadata,
          addedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }

      // Update initialFile if requested (for Lists source file replacement)
      if (updateInitialFile) {
        userDoc.initialFile = {
          fileName: fileMetadata.fileName,
          bucketKey: fileMetadata.bucketKey,
          fileSize: fileMetadata.fileSize || 0,
          uploadedAt: new Date().toISOString()
        };
      }

      // Set workflowStage to files_stored only if not already past that stage
      const postFileStages = ['files_archived', 'indexing', 'patient_summary', 'link_stored'];
      if (userDoc.files.length > 0 && !postFileStages.includes(userDoc.workflowStage)) {
        userDoc.workflowStage = 'files_stored';
      }

      try {
        await cloudant.saveDocument('maia_users', userDoc);
        saved = true;
      } catch (saveError) {
        if (saveError?.statusCode === 409 && attempts < 3) {
          continue;
        }
        throw saveError;
      }
    }

    if (!saved) {
      return res.status(500).json({
        success: false,
        message: 'Failed to update file metadata after retries',
        error: 'UPDATE_FAILED'
      });
    }

    let verifyCount = userDoc?.files?.length || 0;
    try {
      const verifyDoc = await cloudant.getDocument('maia_users', userId);
      if (verifyDoc) {
        if (!Array.isArray(verifyDoc.files)) {
          verifyDoc.files = [];
        }
        const exists = verifyDoc.files.find(f => f.bucketKey === fileMetadata.bucketKey);
        if (!exists) {
          verifyDoc.files.push({
            ...fileMetadata,
            addedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
          await cloudant.saveDocument('maia_users', verifyDoc);
        }
        verifyCount = verifyDoc.files.length;
      }
    } catch (verifyError) {
      // ignore verification errors
    }

    const appleLabel = fileMetadata?.isAppleHealth ? 'Apple Health' : 'Not Apple Health';
    console.log(`[WIZ] Import ${fileMetadata.fileName || 'unknown'}: ${appleLabel}`);
    
    res.json({
      success: true,
      message: 'File metadata updated successfully',
      fileCount: userDoc.files.length
    });
  } catch (error) {
    console.error('❌ Error updating user file metadata:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to update file metadata: ${error.message}`,
      error: 'UPDATE_FAILED'
    });
  }
});

// Cleanup imported files at root level (delete them, don't archive)
// Called on page reload to remove files that were imported but not explicitly saved
app.post('/api/cleanup-imported-files', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return; // 403 already sent on mismatch

    // Get the user document
    let userDoc = await cloudant.getDocument('maia_users', userId);

    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    // Import S3 client operations
    const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');

    // Setup S3/Spaces client
    const bucketUrl = getSpacesBucketName();
    if (!bucketUrl) {
      return res.status(500).json({
        success: false,
        error: 'BUCKET_NOT_CONFIGURED',
        message: 'DigitalOcean bucket not configured'
      });
    }

    const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';

    const s3Client = new S3Client({
      endpoint: getSpacesEndpoint(),
      region: 'us-east-1',
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      credentials: {
        accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
      }
    });

    // List all files at root level (userId/ but not in subfolders)
    const listCommand = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: `${userId}/`
    });

    const listResult = await s3Client.send(listCommand);
    
    // Find files at root level (exactly userId/filename, not in subfolders)
    const rootFiles = (listResult.Contents || []).filter(file => {
      const key = file.Key || '';
      const parts = key.split('/').filter(p => p !== '');
      return parts.length === 2 && 
             parts[0] === userId && 
             !key.endsWith('.keep') &&
             parts[1] !== '.keep';
    });

    let deletedCount = 0;
    const deletedFiles = [];

    // Delete each root-level file
    for (const file of rootFiles) {
      const fileName = file.Key?.split('/').pop() || '';
      if (!fileName || fileName === '.keep') continue;

      const sourceKey = file.Key;

      try {
        // Delete from bucket
        await deleteObjectWithLog({
          s3Client,
          bucketName,
          key: sourceKey
        });

        // Remove file metadata from user document
        if (userDoc.files) {
          const fileIndex = userDoc.files.findIndex(f => f.bucketKey === sourceKey);
          if (fileIndex >= 0) {
            userDoc.files.splice(fileIndex, 1);
            deletedFiles.push(fileName);
          }
        }

        deletedCount++;
        console.log(`[Cleanup] ✅ Deleted imported file: ${sourceKey}`);
      } catch (err) {
        console.error(`[Cleanup] ❌ Error deleting file ${fileName}:`, err);
      }
    }

    // Save updated user document if files were deleted
    if (deletedCount > 0 && userDoc.files) {
      // Reset workflowStage if no files remain
      if (userDoc.files.length === 0) {
        // Revert to agent_deployed if agent exists, otherwise keep current stage
        if (userDoc.assignedAgentId) {
          userDoc.workflowStage = 'agent_deployed';
        }
      }
      await cloudant.saveDocument('maia_users', userDoc);
    }

    res.json({
      success: true,
      message: `Cleaned up ${deletedCount} imported file(s)`,
      deletedCount,
      deletedFiles
    });
  } catch (error) {
    console.error('❌ Error cleaning up imported files:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to cleanup imported files: ${error.message}`,
      error: 'CLEANUP_FAILED'
    });
  }
});

// Auto-archive files at root level (move from userId/ to userId/archived/)
// Only called when user explicitly opens Saved Files tab
app.post('/api/archive-user-files', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return; // 403 already sent on mismatch

    // Get the user document
    let userDoc = await cloudant.getDocument('maia_users', userId);

    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    // Import S3 client operations
    const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');

    // Setup S3/Spaces client
    const bucketUrl = getSpacesBucketName();
    if (!bucketUrl) {
      return res.status(500).json({
        success: false,
        error: 'BUCKET_NOT_CONFIGURED',
        message: 'DigitalOcean bucket not configured'
      });
    }

    const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';

    const s3Client = new S3Client({
      endpoint: getSpacesEndpoint(),
      region: 'us-east-1',
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      credentials: {
        accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
      }
    });

    // List all files at root level (userId/ but not in subfolders)
    // Note: We list all files with userId/ prefix, then filter for root-level files
    const listCommand = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: `${userId}/`
    });

    const listResult = await s3Client.send(listCommand);
    
    // Find files at root level (exactly userId/filename, not in subfolders)
    const rootFiles = (listResult.Contents || []).filter(file => {
      const key = file.Key || '';
      // Only files at exactly userId/filename (not userId/archived/filename or userId/kb/filename)
      // Check that key has exactly 2 parts when split by '/' (userId and filename)
      const parts = key.split('/').filter(p => p !== ''); // Filter empty parts
      return parts.length === 2 && 
             parts[0] === userId && 
             !key.endsWith('.keep') &&
             parts[1] !== '.keep'; // Exclude .keep files
    });

    let archivedCount = 0;
    const archivedFiles = [];
    const failedFiles = [];
    
    // Save original state for rollback
    const originalFiles = JSON.parse(JSON.stringify(userDoc.files || []));
    const originalWorkflowStage = userDoc.workflowStage;

    // Move each root-level file to archived
    for (const file of rootFiles) {
      const fileName = file.Key?.split('/').pop() || '';
      if (!fileName || fileName === '.keep') continue;

      const sourceKey = file.Key;
      const destKey = `${userId}/archived/${fileName}`;

      try {
        await moveObjectWithVerify({
          s3Client,
          bucketName,
          sourceKey,
          destKey
        });

        // Update file metadata in user document
        if (userDoc.files) {
          const fileIndex = userDoc.files.findIndex(f => f.bucketKey === sourceKey);
          if (fileIndex >= 0) {
            userDoc.files[fileIndex].bucketKey = destKey;
            userDoc.files[fileIndex].updatedAt = new Date().toISOString();
            archivedFiles.push(fileName);
            archivedCount++;
          } else {
            userDoc.files.push({
              fileName,
              bucketKey: destKey,
              bucketPath: `${userId}/archived/`,
              fileSize: file.Size || 0,
              uploadedAt: file.LastModified ? new Date(file.LastModified).toISOString() : new Date().toISOString(),
              addedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            });
            archivedFiles.push(fileName);
            archivedCount++;
          }
        }
      } catch (err) {
        console.error(`❌ Error archiving file ${fileName}:`, err);
        failedFiles.push({ fileName, error: err.message });
        // Rollback this file's metadata change if it was made
        if (userDoc.files) {
          const fileIndex = userDoc.files.findIndex(f => f.bucketKey === destKey);
          if (fileIndex >= 0) {
            // Restore original bucketKey
            const originalFile = originalFiles.find(f => f.fileName === fileName || f.bucketKey === sourceKey);
            if (originalFile) {
              userDoc.files[fileIndex].bucketKey = originalFile.bucketKey;
            }
          }
        }
      }
    }

    // Save updated user document if files were moved successfully
    if (archivedCount > 0 && userDoc.files) {
      // Set workflowStage to files_archived when files are archived
      userDoc.workflowStage = 'files_archived';
      
      // Save with retry logic for conflicts
      let saved = false;
      let retries = 3;
      while (!saved && retries > 0) {
        try {
      await cloudant.saveDocument('maia_users', userDoc);
          saved = true;
        } catch (saveError) {
          if (saveError.statusCode === 409 && retries > 1) {
            retries--;
            const freshDoc = await cloudant.getDocument('maia_users', userId);
            // Re-apply archived file changes
            for (const fileName of archivedFiles) {
              const freshFileIndex = freshDoc.files.findIndex(f => 
                f.fileName === fileName || f.bucketKey === `${userId}/${fileName}`
              );
              if (freshFileIndex >= 0) {
                freshDoc.files[freshFileIndex].bucketKey = `${userId}/archived/${fileName}`;
                freshDoc.files[freshFileIndex].updatedAt = new Date().toISOString();
              }
            }
            freshDoc.workflowStage = 'files_archived';
            userDoc = freshDoc;
            await new Promise(resolve => setTimeout(resolve, 200 * (4 - retries)));
          } else {
            // If save fails completely, rollback user document
            userDoc.files = originalFiles;
            userDoc.workflowStage = originalWorkflowStage;
            throw saveError;
          }
        }
      }
      
      if (!saved) {
        // Rollback user document
        userDoc.files = originalFiles;
        userDoc.workflowStage = originalWorkflowStage;
        throw new Error('Failed to save user document after archiving files');
      }
    }

    res.json({
      success: true,
      message: `Archived ${archivedCount} file(s)${failedFiles.length > 0 ? `, ${failedFiles.length} failed` : ''}`,
      archivedCount,
      archivedFiles,
      failedFiles: failedFiles.length > 0 ? failedFiles : undefined
    });
  } catch (error) {
    console.error('❌ Error archiving user files:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to archive files: ${error.message}`,
      error: 'ARCHIVE_FAILED'
    });
  }
});

// Verify file state synchronization between Spaces and user document
app.get('/api/verify-file-state', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }

    // Get the user document
    let userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    // Setup S3/Spaces client
    const bucketUrl = getSpacesBucketName();
    if (!bucketUrl) {
      return res.status(500).json({
        success: false,
        error: 'BUCKET_NOT_CONFIGURED',
        message: 'DigitalOcean bucket not configured'
      });
    }

    const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';

    const { S3Client, HeadObjectCommand, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const s3Client = new S3Client({
      endpoint: getSpacesEndpoint(),
      region: 'us-east-1',
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      credentials: {
        accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
      }
    });

    // Get all files from user document
    const docFiles = userDoc.files || [];
    const inconsistencies = [];
    const verified = [];

    // Verify each file in the user document exists in Spaces at the expected location
    for (const file of docFiles) {
      const bucketKey = file.bucketKey;
      if (!bucketKey) {
        inconsistencies.push({
          fileName: file.fileName || 'unknown',
          issue: 'Missing bucketKey in user document',
          bucketKey: null
        });
        continue;
      }

      try {
        const headCommand = new HeadObjectCommand({
          Bucket: bucketName,
          Key: bucketKey
        });
        await s3Client.send(headCommand);
        verified.push({
          fileName: file.fileName || bucketKey.split('/').pop(),
          bucketKey: bucketKey,
          status: 'verified'
        });
      } catch (headError) {
        // File not found at expected location
        inconsistencies.push({
          fileName: file.fileName || bucketKey.split('/').pop(),
          issue: 'File not found in Spaces at expected location',
          bucketKey: bucketKey
        });
      }
    }

    // Check for orphaned files in Spaces (files in Spaces but not in user document)
    const listCommand = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: `${userId}/`
    });
    const listResult = await s3Client.send(listCommand);
    const spacesFiles = (listResult.Contents || [])
      .map(file => file.Key)
      .filter(key => key && !key.endsWith('.keep'));

    const docBucketKeys = new Set(docFiles.map(f => f.bucketKey).filter(Boolean));
    const orphanedFiles = spacesFiles.filter(key => !docBucketKeys.has(key));

    const isConsistent = inconsistencies.length === 0 && orphanedFiles.length === 0;

    res.json({
      success: true,
      isConsistent,
      verified: verified.length,
      inconsistencies: inconsistencies.length,
      orphanedFiles: orphanedFiles.length,
      details: {
        verified,
        inconsistencies,
        orphanedFiles: orphanedFiles.map(key => ({
          bucketKey: key,
          issue: 'File exists in Spaces but not in user document'
        }))
      }
    });
  } catch (error) {
    console.error('❌ Error verifying file state:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to verify file state: ${error.message}`,
      error: 'VERIFICATION_FAILED'
    });
  }
});

// Get user files
app.get('/api/user-files', async (req, res) => {
  try {
    const { subfolder, source } = req.query;
    let { userId } = req.query;

    // Deep-link guests have their own (empty) user doc — if we honor
    // their userId here, the client's availableUserFiles list is empty
    // and processPageReferences can't hyperlink any [<file> p.<page>]
    // citation that the agent (or our deterministic worksheet
    // endpoints) returns. Override to the owner's userId for deep-link
    // sessions. The proxy-pdf endpoint already authorizes deep-link
    // access to any bucketKey under the owner's prefix, so handing the
    // file list over is consistent with what they can actually fetch.
    if (isDeepLinkSession(req)) {
      try {
        const ownerId = await getOwnerIdForDeepLinkSession(req, cloudant);
        if (ownerId) userId = ownerId;
      } catch (e) {
        console.warn('[user-files] deep-link owner lookup failed:', e?.message);
      }
    }

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }

    // Get the user document
    let userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    const kbNameResolved = await ensureKBNameOnUserDoc(userDoc, userId);
    if (kbNameResolved && !userDoc.kbName) {
      userDoc.kbName = kbNameResolved;
    }

    let files = userDoc.files || [];
    if (files.length === 0 && source) {
      try {
        await new Promise(resolve => setTimeout(resolve, 100));
        const retryDoc = await cloudant.getDocument('maia_users', userId);
        if (retryDoc?.files && Array.isArray(retryDoc.files)) {
          files = retryDoc.files;
        }
      } catch (retryError) {
        // ignore retry errors
      }
    }
    const rawCount = Array.isArray(files) ? files.length : 0;
    const sampleKeys = Array.isArray(files)
      ? files.slice(0, 3).map(file => file.bucketKey || 'missing')
      : [];
    
    // Filter by subfolder if specified
    if (subfolder) {
      const subfolderPath = `${userId}/${subfolder}/`;
      files = files.filter((file) => {
        const bucketKey = file.bucketKey || '';
        return bucketKey.startsWith(subfolderPath);
      });
    } else {
      // When NO subfolder is specified (e.g., SAVED FILES tab), exclude References folder files
      // References files should never appear in SAVED FILES because they're not for KB indexing
      const referencesPath = `${userId}/References/`;
      files = files.filter((file) => {
        const bucketKey = file.bucketKey || '';
        // Exclude files in References subfolder
        if (bucketKey.startsWith(referencesPath)) {
          return false;
        }
        // Also exclude files explicitly marked as references
        if (file.isReference === true) {
          return false;
        }
        return true;
      });
    }

    const kbInfo = await resolveKbForUserFromDo(userId, { forceRefresh: true });
    // File "in KB" membership is the CANONICAL primary KB-1 folder —
    // the folder files are physically moved into by
    // update-knowledge-base (getKBNameFromUserDoc). It must NOT follow
    // resolveKbForUserFromDo, which returns whichever KB is attached to
    // the agent: when the user connects KB-2 (which has no folder of
    // its own — it indexes KB-1's folder) that would flip the prefix to
    // `<kb>-2/` and report every file as not-in-KB.
    const kbName = getKBNameFromUserDoc(userDoc, userId) || kbInfo?.name || null;
    const kbFolderPrefix = kbName ? `${userId}/${kbName}/` : null;

    if (source === 'wizard') {
      const rootPrefix = `${userId}/`;
      const archivedPrefix = `${userId}/archived/`;
      const kbPrefix = kbFolderPrefix ? kbFolderPrefix : null;
      files = files.filter((file) => {
        const bucketKey = file.bucketKey || '';
        if (!bucketKey.startsWith(rootPrefix)) return false;
        if (archivedPrefix && bucketKey.startsWith(archivedPrefix)) return false;
        if (kbPrefix && bucketKey.startsWith(kbPrefix)) return true;
        return bucketKey.split('/').filter(Boolean).length === 2;
      });
    }

    // Deduplicate files by filename - prefer KB folder entries over archived/root entries

    const filesByFileName = new Map();
    
    for (const file of files) {
      const bucketKey = file.bucketKey || '';
      const fileName = bucketKey.split('/').pop() || '';
      
      if (!fileName) continue; // Skip files without valid filenames
      
      const existing = filesByFileName.get(fileName);
      
      if (!existing) {
        // First occurrence of this filename - add it
        filesByFileName.set(fileName, file);
      } else {
        const mergedAppleHealth = !!existing.isAppleHealth || !!file.isAppleHealth;
        // Duplicate filename found - prefer KB folder entry
        const existingIsInKB = kbFolderPrefix ? (existing.bucketKey || '').startsWith(kbFolderPrefix) : false;
        const currentIsInKB = kbFolderPrefix ? (file.bucketKey || '').startsWith(kbFolderPrefix) : false;
        
        if (currentIsInKB && !existingIsInKB) {
          // Current file is in KB, existing is not - replace
          file.isAppleHealth = mergedAppleHealth;
          filesByFileName.set(fileName, file);
        } else if (!currentIsInKB && !existingIsInKB) {
          // Neither is in KB - prefer the one with better metadata
          const existingHasMetadata = existing.fileSize && existing.uploadedAt;
          const currentHasMetadata = file.fileSize && file.uploadedAt;
          
          if (currentHasMetadata && !existingHasMetadata) {
            // Current has metadata, existing doesn't - replace
            file.isAppleHealth = mergedAppleHealth;
            filesByFileName.set(fileName, file);
          } else {
            existing.isAppleHealth = mergedAppleHealth;
          }
          // Otherwise keep existing (first one wins if both have same metadata quality)
        }
        // If existing is in KB and current is not, keep existing (don't replace)
        if (existingIsInKB && !currentIsInKB) {
          existing.isAppleHealth = mergedAppleHealth;
        }
      }
    }
    
    // Convert map back to array and ensure all files have required metadata
    files = Array.from(filesByFileName.values()).map(file => {
      // Ensure fileSize and uploadedAt are present (use defaults if missing)
      if (!file.fileSize && file.size) {
        file.fileSize = file.size; // Some entries use 'size' instead of 'fileSize'
      }
      if (!file.uploadedAt && file.addedAt) {
        file.uploadedAt = file.addedAt; // Fallback to addedAt if uploadedAt missing
      }
      if (!file.uploadedAt) {
        file.uploadedAt = new Date().toISOString(); // Last resort: use current date
      }
      const bucketKey = file.bucketKey || '';
      const inKnowledgeBase = kbFolderPrefix ? bucketKey.startsWith(kbFolderPrefix) : false;
      return {
        ...file,
        inKnowledgeBase
      };
    });
    
    let kbTotalTokens = null;
    let kbLastIndexedAt = null;
    let kbDataSourceCount = null;
    let kbIndexedDataSourceCount = null;
    let kbIndexingActive = false;
    let kbIndexingJobId = null;
    let kbLatestJobId = null;
    let kbLatestJobStatus = null;
    const kbIndexedBucketKeys = Array.isArray(userDoc.kbIndexedBucketKeys) ? userDoc.kbIndexedBucketKeys : [];
    if (!subfolder && kbInfo?.id) {
      try {
        const dataSources = await doClient.kb.listDataSources(kbInfo.id);
        const kbFolderPath = kbName ? `${userId}/${kbName}/` : null;
        const folderDataSource = (dataSources || []).find(ds => {
          const dsPath = ds?.item_path || ds?.path || ds?.spaces_data_source?.item_path;
          return kbName ? isKbFolderDataSourcePath(dsPath, userId, kbName) : false;
        });
        kbDataSourceCount = folderDataSource ? 1 : 0;
        kbIndexedDataSourceCount = folderDataSource?.last_datasource_indexing_job ? 1 : 0;
        try {
          const kbDetails = await doClient.kb.get(kbInfo.id);
          kbTotalTokens = kbDetails?.total_tokens || kbDetails?.token_count || kbDetails?.tokens || null;
          kbLastIndexedAt = kbDetails?.last_indexed_at || kbDetails?.lastIndexedAt || kbDetails?.updated_at || kbDetails?.updatedAt || null;
        } catch (kbTokenError) {
          console.warn('[KB Update] ⚠️ Failed to read KB total tokens:', kbTokenError.message);
        }
        try {
          const status = await getKbIndexingStatusFromDo(kbInfo.id);
          kbIndexingActive = !!status?.isActive;
          kbIndexingJobId = status?.activeJobId || null;
          kbLatestJobId = status?.latestJobId || null;
          kbLatestJobStatus = status?.latestStatus || null;
        } catch (jobError) {
          console.warn('[KB Update] ⚠️ Failed to read indexing job status:', jobError.message);
        }
      } catch (tokenError) {
        console.warn('[KB Update] ⚠️ Failed to read per-file token counts:', tokenError.message);
      }
    }

    // Canonical indexing state for Saved Files (INDEXING_SAVED_FILES_SOURCE_OF_TRUTH.md)
    const indexedSet = new Set(kbIndexedBucketKeys);
    const kbFiles = files.filter(f => f.inKnowledgeBase);
    const allKbFilesIndexed = kbFiles.length === 0 || kbFiles.every(f => (f.bucketKey && indexedSet.has(f.bucketKey)));
    const indexingState = { allKbFilesIndexed };

    const response = {
      success: true,
      files: files,
      kbIndexingActive: kbIndexingActive,
      kbIndexingJobId: kbIndexingJobId,
      kbLatestJobId: kbLatestJobId,
      kbLatestJobStatus: kbLatestJobStatus,
      kbTotalTokens: kbTotalTokens,
      kbDataSourceCount: kbDataSourceCount,
      kbIndexedDataSourceCount: kbIndexedDataSourceCount,
      kbName: kbName,
      kbLastIndexedAt: kbLastIndexedAt,
      kbIndexedBucketKeys,
      kbIndexingStatus: userDoc.kbIndexingStatus || null,
      indexingState
    };

    // Intentionally quiet: no debug logging on file listing
    res.json(response);
  } catch (error) {
    console.error('❌ Error fetching user files:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to fetch files: ${error.message}`,
      error: 'FETCH_FAILED'
    });
  }
});

// Toggle file knowledge base status
app.post('/api/toggle-file-knowledge-base', async (req, res) => {
  try {
    const { userId, bucketKey, inKnowledgeBase } = req.body;
    
    if (!userId || !bucketKey || typeof inKnowledgeBase !== 'boolean') {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID, bucketKey, and inKnowledgeBase are required',
        error: 'MISSING_REQUIRED_FIELDS'
      });
    }

    // Get the user document
    let userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    const kbNameResolved = await ensureKBNameOnUserDoc(userDoc, userId);
    if (kbNameResolved && !userDoc.kbName) {
      userDoc.kbName = kbNameResolved;
    }
    if (!userDoc?.files) {
      userDoc = { ...userDoc, files: [] };
    }

    // Find the file
    let fileIndex = userDoc.files.findIndex(f => f.bucketKey === bucketKey);
    if (fileIndex === -1) {
      const fallbackName = bucketKey.split('/').pop() || bucketKey;
      userDoc.files.push({
        fileName: fallbackName,
        bucketKey,
        fileSize: 0,
        uploadedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      fileIndex = userDoc.files.length - 1;
    }

    const kbName = getKBNameFromUserDoc(userDoc, userId);
    if (!kbName) {
      return res.status(400).json({
        success: false,
        error: 'NO_KB_NAME',
        message: 'No knowledge base name configured. Please complete setup first.'
      });
    }

    // Block file moves while indexing is truly active (not cancelled)
    const kbInfo = await resolveKbForUserFromDo(userId, { forceRefresh: true });
    if (kbInfo?.id) {
      // If user cancelled indexing, allow file moves even if DO job hasn't stopped yet
      const persistedPhase = userDoc.kbIndexingStatus?.phase;
      if (persistedPhase !== 'cancelled') {
        const indexingStatus = await getKbIndexingStatusFromDo(kbInfo.id);
        if (indexingStatus?.isActive) {
          return res.status(409).json({
            success: false,
            message: 'Indexing in progress. Try again when indexing completes.',
            error: 'INDEXING_IN_PROGRESS'
          });
        }
      }
    }

    userDoc.files[fileIndex].updatedAt = new Date().toISOString();

    // Import S3 client operations for file moves
    const { S3Client } = await import('@aws-sdk/client-s3');

    // Setup S3/Spaces client
    const bucketUrl = getSpacesBucketName();
    if (!bucketUrl) {
      return res.status(500).json({
        success: false,
        error: 'BUCKET_NOT_CONFIGURED',
        message: 'DigitalOcean bucket not configured'
      });
    }

    const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';

    const s3Client = new S3Client({
      endpoint: getSpacesEndpoint(),
      region: 'us-east-1',
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      credentials: {
        accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
      }
    });

    // Determine source and destination paths
    const fileName = bucketKey.split('/').pop();
    let sourceKey = bucketKey;
    
    // Check if file is at root level (not archived yet)
    const isRootLevel = sourceKey.startsWith(`${userId}/`) && 
                        !sourceKey.startsWith(`${userId}/archived/`) && 
                        !sourceKey.startsWith(`${userId}/${kbName}/`) &&
                        sourceKey.split('/').length === 2; // Only userId/filename
    
    let destKey;
    let intermediateKey = null;

    if (inKnowledgeBase) {
      // Adding to KB
      if (isRootLevel) {
        // File is at root level - archive it first, then move to KB
        intermediateKey = `${userId}/archived/${fileName}`;
        destKey = `${userId}/${kbName}/${fileName}`;
      } else {
        // File is already archived, move directly to KB
        destKey = `${userId}/${kbName}/${fileName}`;
      }
    } else {
      // Removing from KB - always move to archived
      destKey = `${userId}/archived/${fileName}`;
    }

    // Save original state for rollback in case of failure
    const originalBucketKey = userDoc.files[fileIndex].bucketKey;
    
    try {
      // Handle intermediate step (root -> archived) if needed
      if (intermediateKey && sourceKey !== intermediateKey) {
        await moveObjectWithVerify({
          s3Client,
          bucketName,
          sourceKey,
          destKey: intermediateKey
        });
        sourceKey = intermediateKey;
        userDoc.files[fileIndex].bucketKey = intermediateKey;
      }

      // Move file to final destination if different from source
      if (sourceKey !== destKey) {
        await moveObjectWithVerify({
          s3Client,
          bucketName,
          sourceKey,
          destKey
        });
        userDoc.files[fileIndex].bucketKey = destKey;
        console.log(`[KB Update] Moved file ${fileName} into KB folder: ${destKey}`);
      }
    } catch (moveError) {
      // Rollback: restore original state in user document
      userDoc.files[fileIndex].bucketKey = originalBucketKey;
      userDoc.files[fileIndex].bucketKey = originalBucketKey;
      
      // Try to save rollback state (non-blocking)
      try {
        await cloudant.saveDocument('maia_users', userDoc);
      } catch (rollbackError) {
        console.error('❌ Failed to rollback user document after file move failure:', rollbackError);
      }
      
      throw moveError;
    }

    userDoc.files[fileIndex].updatedAt = new Date().toISOString();

    // Save the updated user document with retry logic for conflicts
    let saved = false;
    let retries = 3;
    while (!saved && retries > 0) {
      try {
        await cloudant.saveDocument('maia_users', userDoc);
        saved = true;
      } catch (saveError) {
        if (saveError.statusCode === 409 && retries > 1) {
          // Conflict - re-read document and retry
          retries--;
          const freshDoc = await cloudant.getDocument('maia_users', userId);
          // Re-apply our changes to the fresh document
          const freshFileIndex = freshDoc.files.findIndex(f => f.bucketKey === originalBucketKey || f.bucketKey === destKey);
          if (freshFileIndex >= 0) {
            freshDoc.files[freshFileIndex].bucketKey = destKey;
            freshDoc.files[freshFileIndex].updatedAt = new Date().toISOString();
            userDoc = freshDoc;
            await new Promise(resolve => setTimeout(resolve, 200 * (4 - retries)));
          } else {
            throw new Error('File not found in fresh user document during retry');
          }
        } else {
          throw saveError;
        }
      }
    }
    
    if (!saved) {
      throw new Error('Failed to save user document after file move');
    }
    
    res.json({
      success: true,
      message: 'Knowledge base status updated',
      inKnowledgeBase: inKnowledgeBase,
      newBucketKey: sourceKey !== destKey ? destKey : bucketKey
    });
  } catch (error) {
    console.error('❌ Error toggling file knowledge base:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to update knowledge base status: ${error.message}`,
      error: 'UPDATE_FAILED'
    });
  }
});

// Get agent instructions
// Resolve which DO agent id an instructions/KB request targets. With
// two Private AI agents the caller passes agentProfileKey ('default' =
// Deepseek, 'gpt' = GPT). Falls back to the primary for legacy callers.
function resolveAgentIdForProfile(userDoc, profileKey) {
  const profiles = (userDoc && typeof userDoc.agentProfiles === 'object') ? userDoc.agentProfiles : {};
  if (profileKey && profiles[profileKey]?.agentId) return profiles[profileKey].agentId;
  return userDoc?.assignedAgentId || profiles.default?.agentId || null;
}

app.get('/api/agent-instructions', async (req, res) => {
  try {
    const { userId, agentProfileKey } = req.query;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }

    // Get the user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    const targetAgentId = resolveAgentIdForProfile(userDoc, agentProfileKey);

    if (!userDoc || !targetAgentId) {
      return res.status(404).json({
        success: false,
        message: 'User agent not found',
        error: 'AGENT_NOT_FOUND'
      });
    }

    // Get agent from DigitalOcean
    const agent = await doClient.agent.get(targetAgentId);

    if (!agent) {
      return res.status(404).json({
        success: false,
        message: 'Agent not found in DigitalOcean',
        error: 'AGENT_NOT_FOUND'
      });
    }

    // Get KB info and connection status (DO API only)
    let kbInfo = null;
    const resolvedKb = await resolveKbForUserFromDo(userId, { forceRefresh: true });
    if (resolvedKb?.id) {
      const agentDetails = await doClient.agent.get(targetAgentId);
      const attachedKBs = agentDetails.knowledge_bases || 
                          agentDetails.connected_knowledge_bases ||
                          agentDetails.knowledge_base_ids ||
                          agentDetails.knowledge_base_uuids ||
                          agentDetails.kbs ||
                          [];
      const connected = attachedKBs.some((kb) => {
        if (!kb) return false;
        const kbId = typeof kb === 'string' ? kb : (kb.uuid || kb.id || kb.knowledge_base_uuid);
        return kbId === resolvedKb.id;
      });

      const dataSources = await doClient.kb.listDataSources(resolvedKb.id);
      const folderDs = (dataSources || []).find(ds => {
        const dsPath = ds?.item_path || ds?.path || ds?.spaces_data_source?.item_path;
        return isKbFolderDataSourcePath(dsPath, userId, resolvedKb.name);
      });

      kbInfo = {
        name: resolvedKb.name,
        kbId: resolvedKb.id,
        connected,
        indexedDataSourceCount: folderDs?.last_datasource_indexing_job ? 1 : 0
      };
    }

    // Per-agent connection state for BOTH knowledge bases (so the My
    // Agent sub-tab can show independent KB-1 / KB-2 toggles).
    const attachedSet = new Set(
      (agent.knowledge_bases || agent.connected_knowledge_bases ||
       agent.knowledge_base_ids || agent.knowledge_base_uuids || agent.kbs || [])
        .map(kb => (typeof kb === 'string' ? kb : (kb?.uuid || kb?.id || kb?.knowledge_base_uuid)))
        .filter(Boolean)
    );
    // Derive the KB labels from the actual stored chunking strategy
    // for each KB. KB-1 has been hierarchical since v1.4.4 (was semantic
    // before that); KB-2 is always the OPPOSITE strategy from KB-1 so
    // the two slots offer a comparison. Hardcoded labels would lie
    // about what the KB actually is.
    // For accounts created in the brief window after the v1.4.4 default
    // switched but BEFORE userDoc.kbChunkingStrategy was persisted (a
    // few accounts like aaron23), fall back to the CURRENT configured
    // strategy — which is what those KBs were actually created with.
    // For very old (pre-v1.4.4) accounts the label may still be wrong,
    // but per direction we don't migrate those.
    const { getKbConfig } = await import('./utils/kb-config.js');
    const currentStrategy = String(getKbConfig().chunking_strategy || 'hierarchical').toLowerCase();
    const kb2 = userDoc.kb2 || null;
    const kb1Strategy = String(userDoc.kbChunkingStrategy || currentStrategy).toLowerCase();
    const kb2Strategy = String(kb2?.chunking || (kb1Strategy === 'semantic' ? 'hierarchical' : 'semantic')).toLowerCase();
    const kbs = [
      {
        key: 'kb1',
        label: `Primary KB — ${kb1Strategy}`,
        name: userDoc.kbId ? getKBNameFromUserDoc(userDoc, userId) : null,
        kbId: userDoc.kbId || null,
        exists: !!userDoc.kbId,
        connected: !!(userDoc.kbId && attachedSet.has(userDoc.kbId)),
        chunking: kb1Strategy
      },
      {
        key: 'kb2',
        label: `Alternate KB — ${kb2Strategy}`,
        name: kb2?.kbName || null,
        kbId: kb2?.kbId || null,
        exists: !!kb2?.kbId,
        connected: !!(kb2?.kbId && attachedSet.has(kb2.kbId)),
        chunking: kb2Strategy
      }
    ];

    res.json({
      success: true,
      instructions: agent.instruction || '',
      kbInfo: kbInfo,
      kbs
    });
  } catch (error) {
    console.error('❌ Error fetching agent instructions:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to fetch agent instructions: ${error.message}`,
      error: 'FETCH_FAILED'
    });
  }
});

// Update agent instructions
app.put('/api/agent-instructions', async (req, res) => {
  try {
    const { userId, instructions, agentProfileKey } = req.body;

    if (!userId || typeof instructions !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'User ID and instructions are required',
        error: 'MISSING_REQUIRED_FIELDS'
      });
    }

    // Get the user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    const targetAgentId = resolveAgentIdForProfile(userDoc, agentProfileKey);

    if (!userDoc || !targetAgentId) {
      return res.status(404).json({
        success: false,
        message: 'User agent not found',
        error: 'AGENT_NOT_FOUND'
      });
    }

    console.log(`📝 Updating agent instructions for user ${userId}, agent ${targetAgentId} (profile ${agentProfileKey || 'default'})`);

    // Update agent instructions via DigitalOcean API
    const updatedAgent = await doClient.agent.update(targetAgentId, {
      instruction: instructions
    });

    console.log(`✅ Agent instructions updated successfully for agent ${targetAgentId}`);

    res.json({
      success: true,
      message: 'Agent instructions updated',
      agentId: targetAgentId
    });
  } catch (error) {
    console.error('❌ Error updating agent instructions:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to update agent instructions: ${error.message}`,
      error: 'UPDATE_FAILED'
    });
  }
});

// Get user settings
app.get('/api/user-settings', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }

    // Get the user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    // Return settings (default to true for backward compatibility)
    res.json({
      success: true,
      allowDeepLinkPrivateAI: userDoc.allowDeepLinkPrivateAI !== undefined ? userDoc.allowDeepLinkPrivateAI : true
    });
  } catch (error) {
    console.error('❌ Error fetching user settings:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to fetch user settings: ${error.message}`,
      error: 'FETCH_FAILED'
    });
  }
});

// Save current medications to user document
app.post('/api/user-current-medications', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return; // 403 already sent on mismatch
    const currentMedications = req.body.currentMedications;

    if (currentMedications === undefined) {
      return res.status(400).json({
        success: false,
        message: 'currentMedications is required',
        error: 'MISSING_REQUIRED_FIELDS'
      });
    }

    // Get the user document
    let userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    // Update current medications. `currentMedicationsUpdatedAt` is
    // written every save so the /api/patient-summary GET can tell
    // whether the saved Patient Summary was generated BEFORE these
    // meds and is therefore stale (Current Medications section
    // reflects an older, possibly-empty meds list).
    userDoc.currentMedications = currentMedications;
    userDoc.currentMedicationsUpdatedAt = new Date().toISOString();
    userDoc.updatedAt = userDoc.currentMedicationsUpdatedAt;

    // Save with retry logic for conflicts
    let retries = 3;
    let saved = false;
    
    while (retries > 0 && !saved) {
      try {
        await cloudant.saveDocument('maia_users', userDoc);
        saved = true;
      } catch (error) {
        if (error.statusCode === 409 && retries > 1) {
          // Conflict - re-read and retry
          userDoc = await cloudant.getDocument('maia_users', userId);
          userDoc.currentMedications = currentMedications;
          userDoc.updatedAt = new Date().toISOString();
          retries--;
          await new Promise(resolve => setTimeout(resolve, 100));
        } else {
          throw error;
        }
      }
    }
    
    res.json({
      success: true,
      message: 'Current medications saved',
      currentMedications: currentMedications
    });
  } catch (error) {
    console.error('❌ Error saving current medications:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to save current medications: ${error.message}`,
      error: 'SAVE_FAILED'
    });
  }
});

// Test endpoint: Generate a test Current Medications token for existing user
// This allows testing the deep link flow without creating a new patient
app.post('/api/test-medications-token', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return; // 403 already sent on mismatch

    // Get the user document
    const userDoc = await cloudant.getDocument('maia_users', userId);

    if (!userDoc) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    // Generate new token
    const tokenData = generateCurrentMedicationsToken(userId);
    
    // Save to user document
    userDoc.currentMedicationsToken = tokenData.token;
    userDoc.currentMedicationsTokenExpiresAt = tokenData.expiresAt;
    userDoc.updatedAt = new Date().toISOString();
    
    await cloudant.saveDocument('maia_users', userDoc);
    
    // Build deep link URL
    const frontendUrl = process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || appUrlConfig.appOrigin;
    const deepLinkUrl = `${frontendUrl}/?editMedications=${tokenData.token}&userId=${userId}`;
    
    return res.json({
      success: true,
      token: tokenData.token,
      expiresAt: tokenData.expiresAt,
      deepLinkUrl: deepLinkUrl,
      message: 'Test token generated successfully'
    });
  } catch (error) {
    console.error('❌ Error generating test medications token:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to generate test token: ${error.message}`,
      error: 'TOKEN_GENERATION_FAILED'
    });
  }
});

// Verify Current Medications token
app.get('/api/verify-medications-token', async (req, res) => {
  try {
    const { token, userId } = req.query;
    
    if (!token || !userId) {
      return res.status(400).json({ 
        success: false, 
        valid: false,
        message: 'Token and userId are required',
        error: 'MISSING_REQUIRED_FIELDS'
      });
    }

    // Get the user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        valid: false,
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    // Check if token matches and is not expired
    const storedToken = userDoc.currentMedicationsToken;
    const expiresAt = userDoc.currentMedicationsTokenExpiresAt;
    
    if (!storedToken || storedToken !== token) {
      return res.json({
        success: true,
        valid: false,
        expired: false,
        message: 'Invalid token'
      });
    }
    
    if (!expiresAt) {
      return res.json({
        success: true,
        valid: false,
        expired: true,
        message: 'Token has no expiration date'
      });
    }
    
    const expirationDate = new Date(expiresAt);
    const now = new Date();
    
    if (now > expirationDate) {
      return res.json({
        success: true,
        valid: false,
        expired: true,
        message: 'Token has expired'
      });
    }
    
    // Token is valid
    return res.json({
      success: true,
      valid: true,
      expired: false,
      message: 'Token is valid'
    });
  } catch (error) {
    console.error('❌ Error verifying medications token:', error);
    res.status(500).json({ 
      success: false, 
      valid: false,
      message: `Failed to verify token: ${error.message}`,
      error: 'VERIFICATION_FAILED'
    });
  }
});

// Update user settings
app.put('/api/user-settings', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return; // 403 already sent on mismatch
    const { allowDeepLinkPrivateAI } = req.body;

    if (typeof allowDeepLinkPrivateAI !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'allowDeepLinkPrivateAI (boolean) is required',
        error: 'MISSING_REQUIRED_FIELDS'
      });
    }

    // Get the user document
    let userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    // Update the setting
    userDoc.allowDeepLinkPrivateAI = allowDeepLinkPrivateAI;
    userDoc.updatedAt = new Date().toISOString();

    // Save with retry logic for conflicts
    let retries = 3;
    let saved = false;
    
    while (retries > 0 && !saved) {
      try {
        await cloudant.saveDocument('maia_users', userDoc);
        saved = true;
      } catch (error) {
        if (error.statusCode === 409 && retries > 1) {
          // Conflict - re-read and retry
          userDoc = await cloudant.getDocument('maia_users', userId);
          userDoc.allowDeepLinkPrivateAI = allowDeepLinkPrivateAI;
          userDoc.updatedAt = new Date().toISOString();
          retries--;
          await new Promise(resolve => setTimeout(resolve, 100));
        } else {
          throw error;
        }
      }
    }
    
    res.json({
      success: true,
      message: 'User settings updated',
      allowDeepLinkPrivateAI: allowDeepLinkPrivateAI
    });
  } catch (error) {
    console.error('❌ Error updating user settings:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to update user settings: ${error.message}`,
      error: 'UPDATE_FAILED'
    });
  }
});

// Delete file from Spaces and user document
app.delete('/api/delete-file', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return; // 403 already sent on mismatch
    const { bucketKey } = req.body;

    if (!bucketKey) {
      return res.status(400).json({
        success: false,
        message: 'Bucket key is required',
        error: 'MISSING_REQUIRED_FIELDS'
      });
    }

    // Import S3 client operations
    const { S3Client } = await import('@aws-sdk/client-s3');

    // Setup S3/Spaces client
    const bucketUrl = getSpacesBucketName();
    if (!bucketUrl) {
      return res.status(500).json({
        success: false,
        error: 'BUCKET_NOT_CONFIGURED',
        message: 'DigitalOcean bucket not configured'
      });
    }

    const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';

    const s3Client = new S3Client({
      endpoint: getSpacesEndpoint(),
      region: 'us-east-1',
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      credentials: {
        accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
      }
    });

    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }
    
    const kbInfo = await resolveKbForUserFromDo(userId, { forceRefresh: true });
    if (kbInfo?.id) {
      const indexingStatus = await getKbIndexingStatusFromDo(kbInfo.id);
      if (indexingStatus?.isActive) {
        return res.status(409).json({
          success: false,
          message: 'Indexing in progress. Try again when indexing completes.',
          error: 'INDEXING_IN_PROGRESS'
        });
      }
    }
    
    // Delete file from Spaces (only after data source is deleted)
    await deleteObjectWithLog({
      s3Client,
      bucketName,
      key: bucketKey
    });
    console.log(`✅ Deleted file from Spaces: ${bucketKey}`);

    // Check if the deleted file is the Apple Health source
    const deletedFile = (userDoc.files || []).find(f => f.bucketKey === bucketKey);
    const wasAppleHealth = deletedFile?.isAppleHealth;

    // Update user document
    if (userDoc.files) {
      // Remove file from userDoc.files
      userDoc.files = userDoc.files.filter(f => f.bucketKey !== bucketKey);
    }

    if (wasAppleHealth) {
      // Clear stale Apple Health metadata so the next AH upload rebuilds
      delete userDoc.appleHealthCategoriesBuiltAt;
      delete userDoc.appleHealthCategoriesSourceKey;
      // Clear cached worksheet data derived from the old AH file
      delete userDoc.oorLabsWorksheet;
      delete userDoc.encountersWorksheet;
      delete userDoc.medsWorksheets;
      console.log(`🧹 Cleared Apple Health metadata and cached worksheets for ${userId}`);

      // Delete Lists sidecars from Spaces (best-effort)
      try {
        const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
        const listsPrefix = `${userId}/Lists/`;
        const listResp = await s3Client.send(new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: listsPrefix
        }));
        if (listResp.Contents?.length) {
          for (const obj of listResp.Contents) {
            await deleteObjectWithLog({ s3Client, bucketName, key: obj.Key });
          }
          console.log(`🧹 Deleted ${listResp.Contents.length} Lists sidecar(s) for ${userId}`);
        }
      } catch (listsErr) {
        console.warn(`[delete-file] Lists sidecar cleanup failed (non-fatal): ${listsErr?.message}`);
      }
    }

    await cloudant.saveDocument('maia_users', userDoc);
    console.log(`✅ Removed file metadata from user document: ${bucketKey}`);

    res.json({
      success: true,
      message: 'File deleted successfully',
      wasAppleHealth: !!wasAppleHealth
    });
  } catch (error) {
    console.error('❌ Error deleting file:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to delete file: ${error.message}`,
      error: 'DELETE_FAILED'
    });
  }
});

/**
 * Setup knowledge base in DigitalOcean
 * This function only creates the KB if it doesn't exist. Indexing is handled automatically by DO.
 * 
 * @param {string} userId - User ID
 * @param {string} kbName - KB name (permanent, from userDoc.kbName)
 * @param {string[]} filesInKB - Array of bucketKeys in KB folder (unused, kept for compatibility)
 * @param {string} bucketName - S3 bucket name (required for KB creation)
 * @param {string|null} existingJobId - Existing indexing job ID (unused, kept for compatibility)
 * @returns {Promise<{kbId: string, kbDetails: object}|{error: string, message: string}>}
 */
async function setupKnowledgeBase(userId, kbName, filesInKB, bucketName, existingJobId = null, useEphemeralSpaces = false) {
  // Step 1: Check DO API to see if KB already exists (by name)
  let kbId = null;
  let kbDetails = null;
  let existingKbFound = false;
  let allKBsCache = null; // Cache KB list for reuse
  
  try {
    // List all KBs from DO API
    console.log(`[KB AUTO] Calling doClient.kb.list() to check for existing KB: ${kbName}`);
    allKBsCache = await doClient.kb.list();
    
    // Find KB by name (case-sensitive match)
    const foundKB = allKBsCache.find(kb => kb.name === kbName);
    
    if (foundKB) {
      // KB exists in DO - use it
      kbId = foundKB.uuid || foundKB.id;
      existingKbFound = true;
      console.log(`✅ Found existing KB in DO: ${kbName} (${kbId})`);
      
      // Get full KB details
      console.log(`[KB AUTO] Calling doClient.kb.get(${kbId}) to get KB details`);
      kbDetails = await doClient.kb.get(kbId);
    }
  } catch (error) {
    console.error('❌ Error checking for existing KB in DO API:', error);
    return { error: 'KB_CHECK_FAILED', message: `Failed to check for existing KB: ${error.message}` };
  }
  
  // Step 2: Create KB if it doesn't exist
  if (!existingKbFound) {
    if (!Array.isArray(filesInKB) || filesInKB.length === 0) {
      return {
        error: 'KB_CREATION_REQUIRES_FILE',
        message: 'Knowledge base creation requires at least one file.'
      };
    }

    // Get required values: projectId from env or DO API; databaseId via DO API/CouchDB cache; embedding from NEW-AGENT.txt (resolved via DO API) or DO_EMBEDDING_MODEL_ID
    const projectId = await getProjectIdForGenAI(doClient);
    const databaseId = await getOrCreateOpenSearchDatabaseId(doClient, cloudant);
    const embeddingModelId = await getEmbeddingModelIdForKb(doClient) || null;
    
    // Validate UUID format helper
    const isValidUUID = (str) => {
      if (!str || typeof str !== 'string') return false;
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      return uuidRegex.test(str.trim());
    };
    
    // Validate required configuration
    if (!isValidUUID(projectId)) {
      return { 
        error: 'PROJECT_ID_NOT_CONFIGURED', 
        message: 'Project ID is required for KB creation. Set DO_PROJECT_ID in .env or ensure your DO account has a (default) project; the app can discover it via the API.' 
      };
    }
    
    if (!isValidUUID(databaseId)) {
      return {
        error: 'DATABASE_ID_NOT_CONFIGURED',
        message: 'OpenSearch database_id is required. Ensure DIGITALOCEAN_TOKEN is set — the database is auto-discovered or created via the DO API.'
      };
    }

    // SAFETY GATE: refuse to index a KB whose files describe more than
    // one patient. A MAIA account is for ONE patient; if the user
    // accidentally uploaded a spouse's / dependent's / colleague's
    // records, the resulting KB would produce a Patient Summary that
    // mixes both — clinically unsafe. DOB mismatch is the trigger
    // (name alone is too noisy). Skipped for ephemeral / re-index
    // paths where the userDoc.files list hasn't necessarily changed.
    if (!useEphemeralSpaces) {
      try {
        const userDocForCheck = await cloudant.getDocument('maia_users', userId);
        const kbPrefix = `${userId}/${kbName}/`;
        const checkFiles = (userDocForCheck?.files || []).filter(f =>
          f?.fileName && f?.bucketKey && f.bucketKey.startsWith(kbPrefix) &&
          (/\.pdf$/i.test(f.fileName) || /pdf/i.test(f.fileType || ''))
        );
        if (checkFiles.length >= 2) {
          const { extractIdentitiesForFiles, detectPatientMismatch } = await import('./utils/patient-consistency.js');
          const identities = await extractIdentitiesForFiles(checkFiles, {
            readSpacesObjectBuffer, log: console
          });
          const consistencyResult = detectPatientMismatch(identities);
          if (!consistencyResult.consistent) {
            await appendUserProvisioningEvent(userId, {
              event: 'patient-consistency-mismatch',
              context: 'kb-setup-blocked',
              primary: consistencyResult.primary?.name || null,
              primaryDob: consistencyResult.primary?.dobIso || null,
              mismatchFiles: consistencyResult.mismatches.map(m => m.fileName),
              reason: consistencyResult.reason
            });
            return {
              error: 'PATIENT_CONSISTENCY_MISMATCH',
              message: consistencyResult.reason,
              detail: consistencyResult
            };
          }
        }
      } catch (e) {
        console.warn(`[KB Setup] patient-consistency check failed (non-fatal — proceeding): ${e?.message || e}`);
      }
    }

    // Clean-index (footer-stripped) indexing is opt-in for NEW KBs created
    // via the standard (non-ephemeral) Spaces flow. Generate the cleaned
    // `_clean/` sidecars first, then point the data source at that folder so
    // DO indexes footer-free text. Best-effort: if no sidecars are written
    // (e.g. parse failure / no PDFs), fall back to the raw PDF folder.
    let cleanIndex = false;
    if (!useEphemeralSpaces) {
      try {
        const sidecar = await generateCleanIndexSidecars(userId, kbName, filesInKB);
        cleanIndex = (sidecar?.written || 0) > 0;
        if (cleanIndex) {
          await appendUserProvisioningEvent(userId, {
            event: 'clean-index-built', kbName, fileCount: sidecar.written, folder: sidecar.folder
          });
        }
      } catch (e) {
        console.warn(`[clean-index] generation failed (using raw PDFs): ${e?.message || e}`);
      }
    }

    try {
      console.log(`📝 Creating new KB in DO: ${kbName} (cleanIndex=${cleanIndex})`);
    // KB tuning from NEW-AGENT.txt "## Knowledge Bases": chunking is
    // per-datasource; reranking is top-level on the KB. (OpenSearch DB
    // is NOT configured here — always the existing account cluster.)
    const chunking = getChunkingForDataSource();
    const datasources = [
      {
        spaces_data_source: {
          bucket_name: bucketName,
          item_path: buildKbDataSourcePath(userId, kbName, null, useEphemeralSpaces, cleanIndex),
          region: getDoRegion()
        },
        ...chunking
      }
    ];

    // Apple Health Lists/*.md sidecar data source (Recommendation #4+#6
    // from Documentation/Clinical.md §7). If the user has an AH PDF, the
    // category-split sidecars (medication_records.md, clinical_notes.md,
    // allergies.md, conditions.md, lab_results.md, …) are a MUCH better
    // representation for KB retrieval than the raw PDF:
    //   - One observation per chunk instead of 30 per chunk
    //   - No PDF artifact text (page footers, generation dates)
    //   - Each chunk is naturally typed by category
    // We add Lists/ as a SECOND data source with small-chunk semantic
    // splitting, alongside the main `_clean/` PDFs source. Idempotent:
    // ensureAppleHealthListsBuilt() is a no-op when the sidecars already
    // exist.
    if (!useEphemeralSpaces) {
      try {
        const userDocForKb = await cloudant.getDocument('maia_users', userId);
        const hasAh = Array.isArray(userDocForKb?.files) &&
          userDocForKb.files.some(f => f?.isAppleHealth && f?.bucketKey);
        if (hasAh) {
          const { ensureAppleHealthListsBuilt } = await import('./utils/lists-builder.js');
          const { S3Client } = await import('@aws-sdk/client-s3');
          const s3Client = new S3Client({
            endpoint: getSpacesEndpoint(),
            region: 'us-east-1',
            forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
            credentials: {
              accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || process.env.SPACES_AWS_ACCESS_KEY_ID || '',
              secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || process.env.SPACES_AWS_SECRET_ACCESS_KEY || ''
            }
          });
          const outcome = await ensureAppleHealthListsBuilt(userId, userDocForKb, {
            readSpacesObjectBuffer, readSpacesTextObject,
            s3Client, bucketName, cloudant
          });
          if (outcome === 'built' || outcome === 'cached') {
            const { getChunkingForAppleHealthListsSource } = await import('./utils/kb-config.js');
            const ahChunking = getChunkingForAppleHealthListsSource();
            datasources.push({
              spaces_data_source: {
                bucket_name: bucketName,
                item_path: `${userId}/Lists/`,
                region: getDoRegion()
              },
              ...ahChunking
            });
            console.log(`[KB Setup] Added AH Lists/ data source (chunk=${ahChunking.chunking_options.max_chunk_size}) — sidecars ${outcome}`);
          }
        }
      } catch (e) {
        console.warn(`[KB Setup] AH Lists data source skipped: ${e?.message || e}`);
      }
    }

      let rerankingConfig = null;
      try {
        const rerankModel = await getRerankingModelName(doClient);
        if (rerankModel) rerankingConfig = { enabled: true, model: rerankModel };
      } catch (e) {
        console.warn('[KB Setup] reranking model resolution failed (non-fatal):', e?.message);
      }

      const kbCreateOptions = {
        name: kbName,
        description: `Knowledge base for ${userId}`,
        projectId: projectId,
        databaseId: databaseId,
        bucketName: bucketName,
        datasources,
        region: getDoRegion(),
        ...(rerankingConfig ? { rerankingConfig } : {})
      };

      // Add embedding model ID if provided
      if (embeddingModelId && isValidUUID(embeddingModelId)) {
        kbCreateOptions.embeddingModelId = embeddingModelId;
        console.log(`[KB Setup] Using embedding model ID: ${embeddingModelId}`);
      }

      console.log(`[KB AUTO] Calling doClient.kb.create() name=${kbName} project=${projectId} database=${databaseId} bucket=${bucketName} embedding=${embeddingModelId || 'default'} chunking=${chunking.chunking_algorithm} reranking=${rerankingConfig?.model || 'none'}`);
      const kbResult = await doClient.kb.create(kbCreateOptions);
      
      kbId = kbResult.uuid || kbResult.id;
      console.log(`✅ Created new KB: ${kbName} (${kbId})`);

      // Persist the clean-index flag AND the actual chunking strategy
      // used for KB-1 so re-index / restore keep pointing at `_clean/`
      // and the My-Agent UI can label the KB with what it really was
      // (not just whatever today's getKbConfig() default happens to be).
      // The chunking algorithm comes from DO's constants —
      // CHUNKING_ALGORITHM_HIERARCHICAL / _SEMANTIC — we normalize to
      // the short form ('hierarchical' / 'semantic') for storage and
      // the label.
      const kb1ChunkingStrategy = /HIERARCHICAL/i.test(chunking.chunking_algorithm)
        ? 'hierarchical'
        : 'semantic';
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const doc = await cloudant.getDocument('maia_users', userId);
          if (!doc) break;
          if (cleanIndex) doc.kbCleanIndex = true;
          doc.kbChunkingStrategy = kb1ChunkingStrategy;
          doc.updatedAt = new Date().toISOString();
          await cloudant.saveDocument('maia_users', doc);
          break;
        } catch (e) {
          if (e?.statusCode === 409 && attempt < 2) continue;
          console.warn(`[KB-1] could not persist KB metadata for ${userId}: ${e?.message || e}`);
          break;
        }
      }

      // Record the ACTUAL parameters used to create this KB so they
      // appear in the user's maia-log.pdf (rendered by the
      // 'kb-created' case in generateSetupLogPdf).
      await appendUserProvisioningEvent(userId, {
        event: 'kb-created',
        kbName,
        kbId,
        projectId,
        databaseId,
        embeddingModelId: embeddingModelId || null,
        embeddingModelName: getEmbeddingModelNameFromNewAgent() || null,
        rerankingModel: rerankingConfig?.model || null,
        chunkingAlgorithm: chunking.chunking_algorithm,
        chunkingOptions: chunking.chunking_options,
        bucketName,
        itemPath: datasources?.[0]?.spaces_data_source?.item_path || null,
        region: getDoRegion()
      });

      // Get KB details
      kbDetails = await doClient.kb.get(kbId);
      
      invalidateResourceCache(userId);
      
      return {
        kbId: kbId,
        kbDetails: kbDetails
      };
    } catch (error) {
      console.error('❌ Error creating KB:', error);
      return { error: 'KB_CREATION_FAILED', message: `Failed to create knowledge base: ${error.message}` };
    }
  }
  
  // KB exists - return it
  invalidateResourceCache(userId);
  
  return {
    kbId: kbId,
    kbDetails: kbDetails
  };
}

// Lazily create the ALTERNATE knowledge base (KB-2): HIERARCHICAL
// chunking over the SAME Spaces folder KB-1 already indexes (no file
// duplication). Idempotent: returns the existing KB-2 if it resolves.
// Stored on userDoc.kb2 = { kbId, kbName, createdAt }. KB-1 is left
// untouched (userDoc.kbId/kbName remain the primary).
const kb2CreationLocks = new Map();
async function ensureKb2(userId) {
  if (!userId) return { error: 'NO_USER' };
  const existingDoc = await cloudant.getDocument('maia_users', userId);
  if (!existingDoc) return { error: 'USER_NOT_FOUND' };

  // Reuse if already created and still resolves in DO.
  const existingKb2Id = existingDoc.kb2?.kbId || null;
  if (existingKb2Id) {
    try {
      await doClient.kb.get(existingKb2Id);
      return { kbId: existingKb2Id, kbName: existingDoc.kb2.kbName, reused: true };
    } catch { /* gone — recreate below */ }
  }

  if (kb2CreationLocks.has(userId)) {
    try { await kb2CreationLocks.get(userId); } catch { /* ignore */ }
    const fresh = await cloudant.getDocument('maia_users', userId);
    if (fresh?.kb2?.kbId) return { kbId: fresh.kb2.kbId, kbName: fresh.kb2.kbName, reused: true };
  }

  let release;
  kb2CreationLocks.set(userId, new Promise(r => { release = r; }));
  try {
    const kb1Name = getKBNameFromUserDoc(existingDoc, userId);
    if (!kb1Name) return { error: 'NO_PRIMARY_KB', message: 'Primary knowledge base must exist before the alternate KB can be created.' };
    const kb2Name = deriveKb2Name(kb1Name);

    const projectId = await getProjectIdForGenAI(doClient);
    const databaseId = await getOrCreateOpenSearchDatabaseId(doClient, cloudant);
    const embeddingModelId = await getEmbeddingModelIdForKb(doClient) || null;
    const isUUID = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim());
    if (!isUUID(projectId) || !isUUID(databaseId)) {
      return { error: 'KB2_CONFIG', message: 'Project/Database not configured for KB-2 creation.' };
    }

    const bucketUrl = getSpacesBucketName();
    const bucketName = bucketUrl ? (bucketUrl.split('//')[1]?.split('.')[0] || 'maia') : 'maia';
    // KB-2 indexes the SAME folder KB-1 uses → no duplicate uploads.
    const itemPath = `${userId}/${kb1Name}/`;
    // KB-2 deliberately uses the OPPOSITE chunking strategy from KB-1,
    // so the two slots offer the user a comparison ("does hierarchical
    // or semantic chunking retrieve better for this corpus?"). KB-1 was
    // semantic before v1.4.4 → KB-2 was hierarchical. KB-1 is now
    // hierarchical → KB-2 should be semantic. The strategy KB-1 actually
    // used is stored on userDoc.kbChunkingStrategy when KB-1 was
    // created; fall back to the current config's opposite if absent.
    const primaryStrategy = String(existingDoc?.kbChunkingStrategy || '').toLowerCase();
    const kb2Strategy = primaryStrategy === 'semantic'
      ? 'hierarchical'
      : (primaryStrategy === 'hierarchical' ? 'semantic' : 'semantic');
    const chunking = getChunkingForStrategy(kb2Strategy);

    let rerankingConfig = null;
    try {
      const rerankModel = await getRerankingModelName(doClient);
      if (rerankModel) rerankingConfig = { enabled: true, model: rerankModel };
    } catch { /* non-fatal */ }

    console.log(`[KB-2] Creating alternate KB ${kb2Name} (${kb2Strategy}, opposite of KB-1=${primaryStrategy || 'unknown'}) over ${itemPath} for ${userId}`);
    const kbResult = await doClient.kb.create({
      name: kb2Name,
      description: `Alternate (${kb2Strategy}) knowledge base for ${userId}`,
      projectId,
      databaseId,
      bucketName,
      region: getDoRegion(),
      datasources: [
        { spaces_data_source: { bucket_name: bucketName, item_path: itemPath, region: getDoRegion() }, ...chunking }
      ],
      ...(isUUID(embeddingModelId) ? { embeddingModelId } : {}),
      ...(rerankingConfig ? { rerankingConfig } : {})
    });
    const kb2Id = kbResult.uuid || kbResult.id;

    // Persist on userDoc.kb2 (conflict-tolerant). KB-1 untouched.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const doc = await cloudant.getDocument('maia_users', userId);
        doc.kb2 = { kbId: kb2Id, kbName: kb2Name, chunking: kb2Strategy, createdAt: new Date().toISOString() };
        doc.updatedAt = new Date().toISOString();
        await cloudant.saveDocument('maia_users', doc);
        break;
      } catch (e) {
        if (e?.statusCode === 409 && attempt < 2) continue;
        console.warn(`[KB-2] could not persist kb2 for ${userId}: ${e?.message || e}`);
        break;
      }
    }
    await appendUserProvisioningEvent(userId, {
      event: 'kb-created',
      kbName: kb2Name,
      kbId: kb2Id,
      role: 'alternate',
      chunkingAlgorithm: chunking.chunking_algorithm,
      chunkingOptions: chunking.chunking_options,
      rerankingModel: rerankingConfig?.model || null,
      itemPath
    });
    invalidateResourceCache(userId);
    console.log(`✅ [KB-2] Created alternate KB ${kb2Name} (${kb2Id})`);
    return { kbId: kb2Id, kbName: kb2Name, created: true };
  } catch (error) {
    console.error(`[KB-2] creation failed for ${userId}:`, error.message);
    return { error: 'KB2_CREATE_FAILED', message: error.message };
  } finally {
    kb2CreationLocks.delete(userId);
    if (release) release();
  }
}

// Update knowledge base - setup KB and trigger indexing (files already moved by checkboxes)
app.post('/api/update-knowledge-base', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return; // 403 already sent on mismatch
    let cleanupEphemeralIndexing = async () => {};

    originalConsoleLog(`[KB-INDEX] Received request for userId: ${userId}`);

    // Get user document (files may need relocation to KB folder)
    let userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    const kbNameResolved = await ensureKBNameOnUserDoc(userDoc, userId);
    if (kbNameResolved && !userDoc.kbName) {
      userDoc.kbName = kbNameResolved;
    }

    // Get KB name from user document
    const kbName = getKBNameFromUserDoc(userDoc, userId);
    if (!kbName) {
      return res.status(400).json({
        success: false,
        error: 'NO_KB_NAME',
        message: 'No knowledge base name configured.'
      });
    }

    // Get bucket name for data source path
    const bucketUrl = getSpacesBucketName();
    if (!bucketUrl) {
      return res.status(500).json({
        success: false,
        error: 'BUCKET_NOT_CONFIGURED',
        message: 'DigitalOcean bucket not configured'
      });
    }
    const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';
    const useEphemeralSpaces = shouldUseEphemeralSpaces();
    let indexingBucketName = bucketName;
    let indexingRegion = getDoRegion();
    let ephemeralContext = null;
    let spacesConfig = null;

    const storageClient = new S3Client({
      endpoint: getSpacesEndpoint(),
      region: 'us-east-1',
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      credentials: {
        accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
      }
    });

    if (!useEphemeralSpaces) {
      const kbFolderPrefix = `${userId}/${kbName}/`;
      const archivedPrefix = `${userId}/archived/`;
      let movedCount = 0;

      for (let idx = 0; idx < (userDoc.files || []).length; idx += 1) {
        const file = userDoc.files[idx];
        const bucketKey = file.bucketKey || '';
        const isInKB = bucketKey.startsWith(kbFolderPrefix);
        if (!isInKB) {
          continue;
        }
        const sourceKey = file.bucketKey;
        if (!sourceKey || sourceKey.startsWith(kbFolderPrefix)) continue;

        const fileName = sourceKey.split('/').pop();
        if (!fileName) continue;
        let currentSource = sourceKey;
        let intermediateKey = null;
        const isRootLevel = currentSource.startsWith(`${userId}/`) &&
          !currentSource.startsWith(archivedPrefix) &&
          !currentSource.startsWith(kbFolderPrefix) &&
          currentSource.split('/').length === 2;

        if (isRootLevel) {
          intermediateKey = `${archivedPrefix}${fileName}`;
        }

        const destKey = `${kbFolderPrefix}${fileName}`;
        if (currentSource === destKey) continue;

        try {
          if (intermediateKey && currentSource !== intermediateKey) {
            await moveObjectWithVerify({
              s3Client: storageClient,
              bucketName,
              sourceKey: currentSource,
              destKey: intermediateKey
            });
            currentSource = intermediateKey;
          }

          await moveObjectWithVerify({
            s3Client: storageClient,
            bucketName,
            sourceKey: currentSource,
            destKey
          });

          userDoc.files[idx].bucketKey = destKey;
          userDoc.files[idx].updatedAt = new Date().toISOString();
          movedCount += 1;
        } catch (moveError) {
          console.error(`[KB Update] ❌ Failed to move file into KB folder: ${currentSource} -> ${destKey}:`, moveError.message);
          return res.status(500).json({
            success: false,
            error: 'KB_FILE_MOVE_FAILED',
            message: `Failed to move file into KB folder: ${fileName}`
          });
        }
      }

      if (movedCount > 0) {
        await cloudant.saveDocument('maia_users', userDoc);
        invalidateResourceCache(userId);
        console.log(`[KB Update] Moved ${movedCount} KB file(s) into ${kbFolderPrefix}`);
      }
    }

    // Remove KB folder placeholder to avoid indexing it
    await deleteKbFolderPlaceholder(userId, kbName);

    // Get list of files currently in KB (tracked by folder path)
    // Re-read userDoc in case files were registered after initial read
    userDoc = await cloudant.getDocument('maia_users', userId);
    const kbFolderPrefix = `${userId}/${kbName}/`;
    originalConsoleLog(`[KB-INDEX] Looking for files with prefix: ${kbFolderPrefix}`);
    originalConsoleLog(`[KB-INDEX] userDoc.files (${(userDoc.files || []).length} total):`, JSON.stringify((userDoc.files || []).map(f => f.bucketKey)));
    let filesInKB = (userDoc.files || [])
      .map(file => file.bucketKey)
      .filter(key => typeof key === 'string' && key.startsWith(kbFolderPrefix));
    originalConsoleLog(`[KB-INDEX] Files matching KB prefix: ${filesInKB.length}`, filesInKB);

    if (filesInKB.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'NO_KB_FILES',
        message: 'Knowledge base creation requires at least one file.'
      });
    }

    if (useEphemeralSpaces) {
      spacesConfig = getSpacesConfig();
      if (!spacesConfig) {
        return res.status(500).json({
          success: false,
          error: 'SPACES_NOT_CONFIGURED',
          message: 'SPACES_AWS_ACCESS_KEY_ID and SPACES_AWS_SECRET_ACCESS_KEY are required for ephemeral indexing.'
        });
      }

      const { bucketName: tempBucket, client: spacesClient } = await createEphemeralSpacesBucket(spacesConfig, userId, kbName);
      indexingBucketName = tempBucket;
      indexingRegion = spacesConfig.region;
      ephemeralContext = {
        bucketName: tempBucket,
        spacesClient,
        dataSourceUuids: [],
        config: spacesConfig
      };

      if (filesInKB.length > 0) {
        console.log(`[KB Update] Copying ${filesInKB.length} file(s) to ephemeral Spaces bucket ${tempBucket}...`);
        await copyKeysToSpaces({
          sourceClient: storageClient,
          sourceBucket: bucketName,
          destClient: spacesClient,
          destBucket: tempBucket,
          keys: filesInKB,
          destKeyFor: (key) => buildTempKbObjectKey(userId, kbName, key)
        });
        console.log(`[KB Update] ✅ Copied files to ephemeral Spaces bucket ${tempBucket}`);
      } else {
        await spacesClient.send(new PutObjectCommand({
          Bucket: tempBucket,
          Key: `${userId}/${kbName}/.keep`,
          Body: Buffer.from('')
        }));
      }
    }
    
    // Setup KB (just create it - no datasource or indexing management)
    const kbSetupResult = await setupKnowledgeBase(
      userId,
      kbName,
      filesInKB,
      indexingBucketName,
      null, // No existing job ID needed
      useEphemeralSpaces
    );
    
    if (kbSetupResult.error) {
      return res.status(400).json({
        success: false,
        error: kbSetupResult.error,
        message: kbSetupResult.message,
        kbId: kbSetupResult.kbId || null,
        // Pass through the patient-consistency detail so the wizard
        // can render a per-file SAFETY banner without re-running
        // the scan.
        detail: kbSetupResult.detail || null
      });
    }
    
    const { kbId } = kbSetupResult;
    let kbDetails = kbSetupResult.kbDetails;
    
    const persistKbState = async () => {
      let retries = 3;
      let docSaved = false;
      let lastError = null;

      while (retries > 0 && !docSaved) {
        try {
          const currentDoc = retries === 3 ? userDoc : await cloudant.getDocument('maia_users', userId);
          if (!currentDoc) {
            throw new Error('User document not found during KB update');
          }

          currentDoc.kbId = kbId;

          if (!currentDoc.kbCreatedAt && kbDetails) {
            currentDoc.kbCreatedAt = new Date().toISOString();
          }

          if (!Array.isArray(currentDoc.connectedKBs)) {
            currentDoc.connectedKBs = [];
          }
          if (!currentDoc.connectedKBs.includes(kbName)) {
            currentDoc.connectedKBs.push(kbName);
          }
          currentDoc.connectedKB = kbName; // Legacy field

          await cloudant.saveDocument('maia_users', currentDoc);
          userDoc = currentDoc;
          docSaved = true;
        } catch (err) {
          lastError = err;
          if (err.statusCode === 409 || err.error === 'conflict') {
            retries -= 1;
            if (retries === 0) {
              console.error(`[KB AUTO] Document conflict while updating KB state for ${userId}: ${err.message}`);
              throw err;
            }
            await new Promise(resolve => setTimeout(resolve, 200 * (4 - retries)));
          } else {
            throw err;
          }
        }
      }
      return userDoc;
    };

    cleanupEphemeralIndexing = async (reason) => {
      if (!ephemeralContext?.bucketName) {
        return;
      }

      const tempBucket = ephemeralContext.bucketName;
      const datasourceUuids = ephemeralContext.dataSourceUuids || [];

      console.log(`🧹 [KB Update] Cleaning up ephemeral Spaces resources (${reason})...`);

      if (datasourceUuids.length > 0) {
        console.log(`ℹ️  [KB Update] Keeping ${datasourceUuids.length} datasource(s); DO KB API is the source of truth.`);
      }

      try {
        await deleteSpacesBucket(ephemeralContext.config, tempBucket);
      } catch (bucketError) {
        console.warn(`⚠️ [KB Update] Failed to delete ephemeral bucket ${tempBucket}: ${bucketError.message}`);
      }
    };

    userDoc = await persistKbState();
    
    // KB update requests always trigger indexing when files exist.
    const filesChanged = true;
    const indexingRequested = true;
    
    let jobId = null;
    let indexingStarted = false;
    
    // If files changed OR indexing was explicitly requested, start a new indexing job
    if (filesChanged || indexingRequested) {
      if (!filesChanged && indexingRequested) {
        console.log(`[KB Update] Indexing requested by user, files in KB: ${filesInKB.length}`);
      }
      try {
        const activeStatus = await getKbIndexingStatusFromDo(kbId);
        if (activeStatus?.isActive && activeStatus.activeJobId) {
          console.log(`[KB Update] ⚠️ Indexing job ${activeStatus.activeJobId} is already running - using existing job`);
          jobId = activeStatus.activeJobId;
          indexingStarted = true;
        }
        
        // Before starting a new job, check if there are any active jobs via listForKB
        // This prevents getting stuck waiting for a job that doesn't exist
        if (!jobId) {
          try {
            const existingJobs = await doClient.indexing.listForKB(kbId);
            const jobsArray = Array.isArray(existingJobs) ? existingJobs : 
                            (existingJobs?.jobs || existingJobs?.indexing_jobs || existingJobs?.data || []);
            
            // Find any active indexing job
            const activeJob = jobsArray.find(j => {
              const jobStatus = j.status || j.job_status || j.state;
              return jobStatus === 'INDEX_JOB_STATUS_PENDING' || 
                     jobStatus === 'INDEX_JOB_STATUS_RUNNING' ||
                     jobStatus === 'INDEX_JOB_STATUS_IN_PROGRESS' ||
                     jobStatus === 'pending' ||
                     jobStatus === 'running' ||
                     jobStatus === 'in_progress';
            });
            
            if (activeJob) {
              const foundJobId = activeJob.uuid || activeJob.id || activeJob.indexing_job_id;
              console.log(`[KB Update] ⚠️ Found active indexing job ${foundJobId} via listForKB - using existing job`);
              jobId = foundJobId;
              indexingStarted = true;
              
            }
          } catch (listError) {
            console.error(`[KB Update] ❌ Error listing indexing jobs:`, listError.message);
            // Continue to start new job if listing fails
          }
        }
        
        // Start new indexing job if no active job found
        if (!jobId) {
          // Get current datasources from KB
          let datasources = kbDetails?.datasources || kbDetails?.data_sources || kbDetails?.knowledge_base_data_sources || [];
          const useSingleBucketDatasource = true;
          // Clean-index KBs index the footer-stripped `_clean/` folder.
          // Regenerate the sidecars first (files may have changed since the
          // last index) so the re-index picks up current content.
          const cleanIndex = userDoc?.kbCleanIndex === true && !useEphemeralSpaces;
          if (cleanIndex) {
            try {
              await generateCleanIndexSidecars(userId, kbName, (userDoc.files || []).filter(f => (f.bucketKey || '').startsWith(`${userId}/${kbName}/`) && !(f.bucketKey || '').includes(`/${CLEAN_INDEX_SUBFOLDER}/`)));
            } catch (e) {
              console.warn(`[clean-index] re-index sidecar refresh failed: ${e?.message || e}`);
            }
          }
          const kbFolderPath = buildKbDataSourcePath(userId, kbName, null, useEphemeralSpaces, cleanIndex);
          let folderDataSourceUuid = null;

          if (useSingleBucketDatasource) {
            const ensured = await ensureSingleKbDataSource(
              kbId,
              indexingBucketName,
              kbFolderPath,
              indexingRegion,
              userId,
              kbName
            );
            datasources = ensured?.dataSources || datasources;
            folderDataSourceUuid = ensured?.dataSourceUuid || null;
          }

          const listToIndex = folderDataSourceUuid ? [folderDataSourceUuid] : [];
          if (listToIndex.length === 0) {
            await cleanupEphemeralIndexing('no_datasources');
            return res.status(400).json({
              success: false,
              error: 'NO_KB_DATASOURCE',
              message: 'KB folder data source is missing; cannot start indexing.'
            });
          }

          try {
            const indexingJob = await doClient.indexing.startGlobal(kbId, listToIndex);
            jobId = indexingJob.uuid || indexingJob.id || indexingJob.indexing_job?.uuid || indexingJob.indexing_job?.id || indexingJob.job?.uuid || indexingJob.job?.id;
            if (jobId) {
              console.log(`✅ Started indexing job: ${jobId}`);
              indexingStarted = true;
            } else {
              console.warn(`[KB Update] ⚠️ Indexing job started but no jobId found in response`);
            }
          } catch (startError) {
            if (startError.message && startError.message.includes('already') && startError.message.includes('running')) {
              const activeStatus = await getKbIndexingStatusFromDo(kbId);
              jobId = activeStatus?.activeJobId || null;
              if (jobId) {
                console.log(`[KB Update] ✅ Found active indexing job: ${jobId}`);
                indexingStarted = true;
              }
            } else {
              throw startError;
            }
          }
        }
      } catch (indexingError) {
        console.error(`[KB Update] ❌ Error starting indexing job:`, indexingError.message);
        // Continue - background polling will try to find the job
      }
    }
    
    // Return response with jobId if available
    if (!indexingStarted) {
      await cleanupEphemeralIndexing('no_indexing');
    }

    // Persist new indexing status BEFORE responding so the client's first
    // poll never sees stale backendCompleted:true from a previous job.
    if (jobId) {
      await persistKbIndexingStatus(userId, {
        jobId,
        status: 'INDEX_JOB_STATUS_IN_PROGRESS',
        phase: 'indexing',
        tokens: '0',
        filesIndexed: '0',
        progress: 0,
        backendCompleted: false
      });
    }

    res.json({
      success: true,
      message: indexingStarted ? 'Knowledge base updated, indexing started' : 'Knowledge base updated successfully',
      kbId: kbId,
      filesInKB: filesInKB,
      jobId: jobId || null,
      phase: indexingStarted ? 'indexing_started' : 'kb_created'
    });
    
    // Only start polling if we actually started a new job
    // Don't poll if we didn't start a job - that would find old completed jobs incorrectly
    if (jobId && indexingStarted) {
      // Verify the job actually exists and is active before starting to poll
      // This prevents getting stuck waiting for a job that doesn't exist
      try {
        const verifyJobs = await doClient.indexing.listForKB(kbId);
        const verifyJobsArray = Array.isArray(verifyJobs) ? verifyJobs : 
                              (verifyJobs?.jobs || verifyJobs?.indexing_jobs || verifyJobs?.data || []);
        
        const verifyJob = verifyJobsArray.find(j => {
          const currentJobId = j.uuid || j.id || j.indexing_job_id;
          return currentJobId === jobId;
        });
        
        if (!verifyJob) {
          console.warn(`[KB Update] ⚠️ Job ${jobId} not found in active jobs list - will not start polling`);
          // Job doesn't exist - don't start polling
          return;
        }
        
        const verifyStatus = verifyJob.status || verifyJob.job_status || verifyJob.state;
        const isActive = verifyStatus === 'INDEX_JOB_STATUS_PENDING' || 
                        verifyStatus === 'INDEX_JOB_STATUS_RUNNING' ||
                        verifyStatus === 'INDEX_JOB_STATUS_IN_PROGRESS' ||
                        verifyStatus === 'pending' ||
                        verifyStatus === 'running' ||
                        verifyStatus === 'in_progress';
        
        if (!isActive) {
          console.warn(`[KB Update] ⚠️ Job ${jobId} is not active (status: ${verifyStatus}) - will not start polling`);
          // Job is not active - don't start polling
          return;
        }
        
        console.log(`[KB Update] ✅ Verified job ${jobId} is active (status: ${verifyStatus}) - starting polling for kbId=${kbId} userId=${userId}`);
      } catch (verifyError) {
        console.warn(`[KB Update] ⚠️ Could not verify job before polling:`, verifyError.message);
        // Continue with polling if verification fails (might be a transient error)
      }
      console.log(`[KB Status] Polling started in this terminal — you will see status here every 15s until indexing completes.`);
    // Start polling for indexing jobs in background (non-blocking)
      // Poll every 15 seconds for max 60 minutes
    let startTime = Date.now();
    const pollDelayMs = 15000; // 15 seconds
    const maxPolls = Math.ceil((60 * 60 * 1000) / pollDelayMs);
    let pollCount = 0;
      let activeJobId = jobId; // Track the specific job we started
    let finished = false;
    let pollTimer = null;
    let notFoundLogged = false;
    let lastKbStatusKey = '';
    let errorPollLogged = false;
    let lastTokenValue = '0';
    let tokenStableCount = 0;

    const clearPollTimer = () => {
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    };

    const logFinalIndexingStatus = async (reason) => {
      try {
        const finalDoc = await cloudant.getDocument('maia_users', userId);
        const status = finalDoc?.kbIndexingStatus || null;
        if (status) {
          const job = status.jobId || activeJobId;
          const phase = status.phase || 'unknown';
          const state = status.status || 'unknown';
          const tokens = status.tokens || '0';
          const files = status.filesIndexed || 0;
          const completed = status.backendCompleted === true;
          console.log(`[KB AUTO] ℹ️ Final status for job ${job} (reason=${reason}) phase=${phase} status=${state} files=${files} tokens=${tokens} completed=${completed}`);
        } else {
          console.log(`[KB AUTO] ℹ️ Final status for job ${activeJobId} (reason=${reason}) status=unknown`);
        }
      } catch (error) {
        console.log(`[KB AUTO] ℹ️ Final status for job ${activeJobId} (reason=${reason}) status=unavailable`);
      }
    };

    const scheduleNextPoll = () => {
      if (finished) return;
      pollTimer = setTimeout(runPoll, pollDelayMs);
    };

    const completeIndexing = async (job, fileCount, tokenValue, indexedFiles, completionReason = 'status_completed') => {
      if (finished) return;
      finished = true;
      clearPollTimer();

      const elapsedTime = Math.round((Date.now() - startTime) / 1000); // seconds
      const elapsedMinutes = Math.floor(elapsedTime / 60);
      const elapsedSeconds = elapsedTime % 60;

      const finalTokens = String(job.tokens || job.total_tokens || tokenValue || 0);
      const finalFileCount = job.data_source_jobs?.[0]?.indexed_file_count || fileCount;

      try {
        const finalUserDoc = await cloudant.getDocument('maia_users', userId);
        if (finalUserDoc?.workflowStage === 'indexing') {
          if (finalUserDoc.files && finalUserDoc.files.length > 0) {
            finalUserDoc.workflowStage = 'files_archived';
          } else {
            finalUserDoc.workflowStage = 'agent_deployed';
          }
          await cloudant.saveDocument('maia_users', finalUserDoc);
        }

        const kbName = getKBNameFromUserDoc(finalUserDoc, userId);
        if (kbName) {
          const kbFolderPrefix = `${userId}/${kbName}/`;
          const indexedKeys = Array.isArray(finalUserDoc.files)
            ? finalUserDoc.files
              .map(file => file?.bucketKey)
              .filter(key => typeof key === 'string' && key.startsWith(kbFolderPrefix))
            : [];
          finalUserDoc.kbIndexedBucketKeys = indexedKeys;
          finalUserDoc.kbIndexedAt = new Date().toISOString();
          await cloudant.saveDocument('maia_users', finalUserDoc);
        }

        console.log(`[KB INDEXING] ✅ Indexing completed successfully (reason=${completionReason}): ${finalFileCount} files, ${finalTokens} tokens, ${elapsedMinutes}m ${elapsedSeconds}s`);
        await persistKbIndexingStatus(userId, {
          jobId: activeJobId,
          status: 'INDEX_JOB_STATUS_COMPLETED',
          phase: 'complete',
          tokens: finalTokens,
          filesIndexed: finalFileCount,
          progress: 1.0,
          backendCompleted: true,
          completedAt: new Date().toISOString()
        });

        // Attach KB to agent if needed
        try {
          if (finalUserDoc && finalUserDoc.assignedAgentId && finalUserDoc.agentEndpoint) {
            await doClient.agent.attachKB(finalUserDoc.assignedAgentId, kbId);
          } else {
            console.log(`[KB AUTO] ⏳ Agent not ready, skipping KB attach for job ${activeJobId}`);
          }
        } catch (attachError) {
          if (!attachError.message || !attachError.message.includes('already')) {
            console.error(`[KB AUTO] ❌ Error attaching KB to agent:`, attachError.message);
          }
        }
      } catch (error) {
        console.error('[KB AUTO] ❌ Error finalizing indexing:', error.message);
      }

      await cleanupEphemeralIndexing('completed');
    };

const runPoll = async () => {
      if (finished) return;
      pollCount += 1;

      try {
        // Always get fresh user document to ensure we have current state
        const currentUserDoc = await cloudant.getDocument('maia_users', userId);
        if (!currentUserDoc) {
          console.log(`[KB AUTO] ⚠️ User doc not found while polling. Stopping polling for job ${activeJobId}.`);
          console.log(`[KB AUTO] ⚠️ Polling stopped for job ${activeJobId} (reason=user_doc_missing)`);
          await logFinalIndexingStatus('user_doc_missing');
          finished = true;
          clearPollTimer();
          return;
        }

        // Check if cancel was requested — stop polling immediately
        if (currentUserDoc.kbIndexingStatus?.phase === 'cancelled') {
          console.log(`[KB AUTO] ⚠️ Indexing cancelled for job ${activeJobId} — stopping polling`);
          finished = true;
          clearPollTimer();
          return;
        }

        const indexingJobs = await doClient.indexing.listForKB(kbId);
         
         // listForKB already returns the jobs array, so indexingJobs should be an array
         // But handle case where it might still be wrapped
         let jobsArray = indexingJobs;
         if (Array.isArray(indexingJobs)) {
           jobsArray = indexingJobs;
         } else if (indexingJobs.jobs && Array.isArray(indexingJobs.jobs)) {
           jobsArray = indexingJobs.jobs; // API returns { "jobs": [...] }
         } else if (indexingJobs.indexing_jobs && Array.isArray(indexingJobs.indexing_jobs)) {
           jobsArray = indexingJobs.indexing_jobs;
         } else if (indexingJobs.data && Array.isArray(indexingJobs.data)) {
           jobsArray = indexingJobs.data;
             } else {
           jobsArray = [];
         }
         
         // First, try to find the specific job we're tracking by ID
         let job = jobsArray.find(j => {
           const currentJobId = j.uuid || j.id || j.indexing_job_id;
           return currentJobId === activeJobId;
         });
         
         // If not found by ID, find any active or completed job (fallback)
         if (!job) {
           job = jobsArray.find(j => {
           const jobStatus = j.status || j.job_status || j.state;
           return jobStatus === 'INDEX_JOB_STATUS_PENDING' || 
                  jobStatus === 'INDEX_JOB_STATUS_RUNNING' ||
                    jobStatus === 'INDEX_JOB_STATUS_IN_PROGRESS' ||
                  jobStatus === 'INDEX_JOB_STATUS_COMPLETED' ||
                  jobStatus === 'INDEX_JOB_STATUS_NO_CHANGES' ||
                  jobStatus === 'pending' ||
                  jobStatus === 'running' ||
                  jobStatus === 'in_progress' ||
                  jobStatus === 'completed';
         });
         }
         
        if (job) {
           const currentJobId = job.uuid || job.id || job.indexing_job_id;
           const status = job.status || job.job_status || job.state;
           
           // Update activeJobId only if we found a different job (shouldn't happen, but handle it)
           if (currentJobId && currentJobId !== activeJobId) {
             console.log(`[KB AUTO] ⚠️ Found different job ID: ${currentJobId} (expected ${activeJobId}). Updating tracking.`);
             activeJobId = currentJobId;
           }

           const kbDetails = await getCachedKB(kbId);
           const kbTotalTokens = kbDetails?.total_tokens || kbDetails?.token_count || kbDetails?.tokens || 0;
           const jobTokens = job.tokens || job.total_tokens || 0;
           const tokens = String(kbTotalTokens || jobTokens || 0);
           if (pollCount <= 3 || pollCount % 10 === 0) {
             console.log(`[KB Status] kbDetails keys=${kbDetails ? Object.keys(kbDetails).join(',') : 'null'} total_tokens=${kbDetails?.total_tokens} token_count=${kbDetails?.token_count} jobTokens=${jobTokens}`);
           }

           const kbNameForFiles = getKBNameFromUserDoc(currentUserDoc, userId);
           const kbFolderPrefix = kbNameForFiles ? `${userId}/${kbNameForFiles}/` : null;
           const indexedFiles = kbFolderPrefix && Array.isArray(currentUserDoc.files)
             ? currentUserDoc.files
               .map(file => file?.bucketKey)
               .filter(key => typeof key === 'string' && key.startsWith(kbFolderPrefix))
             : [];
           const fileCount = job.data_source_jobs?.[0]?.indexed_file_count || indexedFiles.length;

          // Only mark as complete if this is the job we're tracking AND it's actually completed
          const statusCompleted = (status === 'INDEX_JOB_STATUS_COMPLETED' ||
                             status === 'INDEX_JOB_STATUS_NO_CHANGES' ||
                             status === 'completed' ||
                             status === 'COMPLETED' ||
                             (job.completed === true) ||
                             (job.phase === 'BATCH_JOB_PHASE_COMPLETED') ||
                            (job.phase === 'BATCH_JOB_PHASE_SUCCEEDED')) &&
                            // Only complete if this is EXACTLY the job we started
                            currentJobId === activeJobId;

          // Token-stable completion: if tokens > 0 and haven't changed for 4+ consecutive
          // polls (60+ seconds) AND DO has reported indexed_file_count >= expected files,
          // treat as complete. The file-count gate prevents firing while DO is still
          // working through the remaining files (a gap between two file's tokenization
          // can otherwise look like "stable tokens" and end the poll prematurely).
          if (Number(tokens) > 0 && tokens === lastTokenValue) {
            tokenStableCount++;
          } else {
            tokenStableCount = 0;
          }
          lastTokenValue = tokens;
          const expectedFileCount = indexedFiles.length;
          const allFilesIndexed = expectedFileCount > 0
            ? Number(fileCount) >= expectedFileCount
            : Number(fileCount) > 0;
          const tokenStableCompleted = Number(tokens) > 0 && tokenStableCount >= 4 && allFilesIndexed;
          if (tokenStableCompleted && !statusCompleted) {
            console.log(`[KB AUTO] ✅ Token-stable completion for job ${activeJobId}: tokens=${tokens} stable for ${tokenStableCount} polls files=${fileCount}/${expectedFileCount} (status still=${status})`);
          }

          // Time-based fallback: if polling for 30+ minutes with no completion signal,
          // the DO API job status is stuck. Complete with whatever state we have. Raised
          // from 15→30 min because legitimately large KBs (4-10 PDFs) can take 15-25 min.
          const elapsedPollingMs = Date.now() - startTime;
          const timeBasedCompleted = !statusCompleted && !tokenStableCompleted && elapsedPollingMs > 30 * 60 * 1000;
          if (timeBasedCompleted) {
            console.log(`[KB AUTO] ✅ Time-based completion for job ${activeJobId}: elapsed=${Math.floor(elapsedPollingMs / 60000)}m tokens=${tokens} status=${status}`);
          }

          const isCompleted = statusCompleted || tokenStableCompleted || timeBasedCompleted;

           const phase = isCompleted
             ? 'complete'
             : (status === 'INDEX_JOB_STATUS_PENDING' ? 'indexing_started' : 'indexing');
           // Don't overwrite backendCompleted here — completeIndexing() sets it to true.
           // Writing false on every poll created a race where the client could read
           // false between this write and the completeIndexing() write.
           const statusUpdate = {
             jobId: currentJobId || activeJobId,
             status,
             phase,
             tokens,
             filesIndexed: fileCount,
             progress: isCompleted ? 1.0 : (phase === 'indexing_started' ? 0.1 : 0.5)
           };
           if (!isCompleted) {
             await persistKbIndexingStatus(userId, statusUpdate);
           }

           if (isCompleted) {
            const reason = statusCompleted ? 'status_completed' : tokenStableCompleted ? 'token_stable' : 'time_based';
            console.log(`[KB AUTO] ✅ Completion detected for job ${activeJobId} (reason=${reason} status=${status} tokens=${tokens})`);
            await completeIndexing(job, fileCount, tokens, indexedFiles, reason);
            await logFinalIndexingStatus(reason);
             return;
           }
          const statusKey = `${status}|${fileCount}|${tokens}`;
          if (statusKey !== lastKbStatusKey) lastKbStatusKey = statusKey;
          const elapsedMs = Date.now() - startTime;
          const em = Math.floor(elapsedMs / 60000);
          const es = Math.floor((elapsedMs % 60000) / 1000);
          console.log(`[KB Status] job=${activeJobId} poll=${pollCount}/${maxPolls} (every ${pollDelayMs / 1000}s) elapsed ${em}m ${es}s status=${status} files=${fileCount} tokens=${tokens}`);
        } else {
          if (!notFoundLogged) {
            console.log(`[KB AUTO] ⚠️ Job ${activeJobId} not found in list (reason=not_found jobs=${jobsArray.length})`);
            notFoundLogged = true;
          }
          try {
            const kbDetails = await doClient.kb.get(kbId);
            const lastIndexedAt = kbDetails?.last_indexed_at || kbDetails?.lastIndexedAt || kbDetails?.updated_at || kbDetails?.updatedAt || null;
            const lastIndexedMs = lastIndexedAt ? Date.parse(lastIndexedAt) : NaN;
            if (!Number.isNaN(lastIndexedMs) && lastIndexedMs >= startTime) {
              const kbName = getKBNameFromUserDoc(currentUserDoc, userId);
              const kbFolderPrefix = kbName ? `${userId}/${kbName}/` : null;
              const kbFileCount = kbFolderPrefix && Array.isArray(currentUserDoc.files)
                ? currentUserDoc.files.filter(file => typeof file?.bucketKey === 'string' && file.bucketKey.startsWith(kbFolderPrefix)).length
                : 0;
              const tokens = String(kbDetails?.total_tokens || kbDetails?.token_count || kbDetails?.tokens || 0);
              const completionReason = 'kb_last_indexed_at_advanced';
              console.log(`[KB AUTO] ✅ Completion inferred for job ${activeJobId} (reason=${completionReason})`);
              await completeIndexing({
                tokens,
                total_tokens: tokens,
                data_source_jobs: [{ indexed_file_count: kbFileCount }]
              }, kbFileCount, tokens, completionReason);
              return;
            }
          } catch (fallbackError) {
            console.warn('[KB AUTO] ⚠️ Failed fallback completion check:', fallbackError.message);
          }
           // No job found - check if it failed or if we should continue
           const failedJob = jobsArray.find(j => {
             const currentJobId = j.uuid || j.id || j.indexing_job_id;
             return currentJobId === activeJobId && (
               j.status === 'INDEX_JOB_STATUS_FAILED' || 
               j.job_status === 'INDEX_JOB_STATUS_FAILED' ||
               j.state === 'INDEX_JOB_STATUS_FAILED' ||
               j.status === 'failed' || 
               j.job_status === 'failed' ||
               j.state === 'failed' ||
               j.status === 'FAILED' ||
               j.job_status === 'FAILED' ||
               j.state === 'FAILED' ||
               (j.failed === true)
             );
           });

           if (failedJob) {
             finished = true;
             clearPollTimer();
             const failedJobId = failedJob.uuid || failedJob.id || failedJob.indexing_job_id;
            const failReason = failedJob.error || failedJob.message || 'Unknown error';
            console.error(`[KB AUTO] ❌ Indexing job ${failedJobId} failed:`, failReason);
            console.log(`[KB AUTO] ❌ Polling stopped for job ${activeJobId} (reason=job_failed)`);
            await logFinalIndexingStatus('job_failed');
            await cleanupEphemeralIndexing('failed');
             return;
           }
         }
       } catch (error) {
        if (!errorPollLogged) {
          errorPollLogged = true;
          const errElapsedMs = Date.now() - startTime;
          const errEm = Math.floor(errElapsedMs / 60000);
          const errEs = Math.floor((errElapsedMs % 60000) / 1000);
          console.log(`[KB Status] job=${activeJobId} poll=${pollCount}/${maxPolls} (every ${pollDelayMs / 1000}s) elapsed ${errEm}m ${errEs}s status=error error=${error.message}`);
          console.error(`[KB AUTO] ❌ Error polling indexing status (poll ${pollCount}):`, error.message);
        }
         if (isRateLimitError(error) && pollCount > 0) {
           pollCount -= 1; // do not count this attempt when rate limited
         }
       }

       if (!finished) {
         if (pollCount >= maxPolls) {
           finished = true;
           clearPollTimer();
          console.error(`[KB AUTO] ⚠️ Polling timeout: No indexing job found after ${maxPolls} polls (${Math.round((maxPolls * pollDelayMs) / 60000)} minutes)`);
          console.log(`[KB AUTO] ⚠️ Polling stopped for job ${activeJobId} (reason=timeout)`);
          await logFinalIndexingStatus('timeout');
          await cleanupEphemeralIndexing('timeout');
         } else {
           scheduleNextPoll();
         }
       }
     };

     runPoll();
    } // End of polling block - only runs if jobId || indexingStarted || (filesChanged || indexingRequested)
  } catch (error) {
    console.error('❌ Error updating knowledge base:', error);
    if (typeof cleanupEphemeralIndexing === 'function') {
      try {
        await cleanupEphemeralIndexing('error');
      } catch (cleanupError) {
        console.warn(`⚠️ [KB Update] Failed to cleanup ephemeral resources: ${cleanupError.message}`);
      }
    }
    res.status(500).json({ 
      success: false, 
      message: `Failed to update knowledge base: ${error.message}`,
      error: 'UPDATE_FAILED'
    });
  }
});

// Get KB indexing status (DO API only)
app.get('/api/kb-indexing-status/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }

    const userDoc = await cloudant.getDocument('maia_users', userId);
    if (userDoc?.kbIndexingStatus && (!jobId || userDoc.kbIndexingStatus.jobId === jobId)) {
      const stored = userDoc.kbIndexingStatus;
      return res.json({
        success: stored.status !== 'INDEX_JOB_STATUS_FAILED',
        phase: stored.phase || 'indexing',
        status: stored.status || 'INDEX_JOB_STATUS_RUNNING',
        kb: userDoc.kbName || null,
        tokens: stored.tokens || '0',
        filesIndexed: stored.filesIndexed || 0,
        completed: !!stored.backendCompleted,
        backendCompleted: !!stored.backendCompleted,
        progress: stored.progress || 0
      });
    }
    return res.json({
      success: true,
      phase: 'indexing',
      status: 'INDEX_JOB_STATUS_PENDING',
      kb: userDoc?.kbName || null,
      tokens: '0',
      filesIndexed: 0,
      completed: false,
      backendCompleted: false,
      progress: 0
    });
  } catch (error) {
    console.error('❌ Error in KB indexing status endpoint:', error);
    res.status(500).json({
      success: false,
      error: 'STATUS_CHECK_FAILED',
      message: `Failed to get indexing status: ${error.message}`,
      phase: 'error'
    });
  }
});

// Live indexing status for the ALTERNATE KB (KB-2). Reads the DO
// indexing job directly (not userDoc.kbIndexingStatus, which tracks
// KB-1's Setup job). Polled inline by the My Agent tab so KB-2
// progress never touches the Saved Files panel/badges.
app.get('/api/kb2-indexing-status', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return;
    const userDoc = await cloudant.getDocument('maia_users', userId);
    const kb2Id = userDoc?.kb2?.kbId || null;
    if (!kb2Id) {
      return res.json({ success: true, exists: false, completed: false });
    }
    let jobs = [];
    try {
      jobs = await doClient.indexing.listForKB(kb2Id);
    } catch (e) {
      return res.json({ success: true, exists: true, completed: false, error: e?.message || 'list failed' });
    }
    const job = Array.isArray(jobs) && jobs.length > 0 ? jobs[0] : null;
    if (!job) {
      return res.json({ success: true, exists: true, completed: false, phase: 'pending', tokens: '0', filesIndexed: 0 });
    }
    const status = String(job.status || job.phase || '').toUpperCase();
    const completed = /COMPLET|SUCCEED|DONE/.test(status);
    const failed = /FAIL|ERROR|CANCEL/.test(status);
    const tokens = String(job.tokens || job.total_tokens || job.tokenized_tokens || 0);
    const filesIndexed = job.data_source_jobs?.[0]?.indexed_file_count
      || job.completed_datasources || 0;
    return res.json({
      success: !failed,
      exists: true,
      kbName: userDoc.kb2?.kbName || null,
      jobId: job.uuid || job.id || null,
      phase: completed ? 'complete' : (failed ? 'error' : 'indexing'),
      status,
      tokens,
      filesIndexed,
      completed,
      failed
    });
  } catch (error) {
    console.error('❌ kb2-indexing-status error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Cancel KB indexing and restore files to archived folder
app.post('/api/cancel-kb-indexing', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return;
    const { jobId } = req.body;

    if (!jobId) {
      return res.status(400).json({ success: false, error: 'MISSING_JOB_ID', message: 'Job ID is required' });
    }

    let userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc) {
      return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
    }

    // Check if already completed
    if (userDoc.kbIndexingStatus?.backendCompleted && userDoc.kbIndexingStatus?.jobId === jobId) {
      return res.json({ success: false, alreadyCompleted: true, error: 'ALREADY_COMPLETED', message: 'Indexing has already completed.' });
    }

    // Cancel via DO API (best-effort)
    try {
      await doClient.indexing.cancel(jobId);
      console.log(`[KB Cancel] Cancelled indexing job ${jobId} for ${userId}`);
    } catch (cancelError) {
      const code = cancelError.statusCode || cancelError.$metadata?.httpStatusCode;
      if (code === 405 || code === 404) {
        console.log(`[KB Cancel] Job ${jobId} cannot be cancelled (${code}) — may already be done`);
      } else {
        console.warn(`[KB Cancel] Error cancelling job ${jobId}:`, cancelError.message);
      }
    }

    // Move files from KB folder back to archived
    const kbName = getKBNameFromUserDoc(userDoc, userId);
    if (kbName) {
      const { S3Client, CopyObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
      const bucketUrl = getSpacesBucketName();
      const bucketName = bucketUrl?.split('//')[1]?.split('.')[0] || 'maia';
      const s3Client = new S3Client({
        endpoint: getSpacesEndpoint(),
        region: 'us-east-1',
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
        credentials: {
          accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
          secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
        }
      });

      const kbPrefix = `${userId}/${kbName}/`;
      const listResult = await s3Client.send(new ListObjectsV2Command({ Bucket: bucketName, Prefix: kbPrefix }));
      const kbFiles = (listResult.Contents || []).filter(f => f.Key && f.Key !== kbPrefix);

      for (const file of kbFiles) {
        const fileName = file.Key.split('/').pop();
        if (!fileName) continue;
        const archivedKey = `${userId}/archived/${fileName}`;
        try {
          await s3Client.send(new CopyObjectCommand({ Bucket: bucketName, CopySource: `${bucketName}/${file.Key}`, Key: archivedKey }));
          await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: file.Key }));
          // Update userDoc.files bucketKey
          const idx = userDoc.files?.findIndex(f => f.bucketKey === file.Key);
          if (idx >= 0) {
            userDoc.files[idx].bucketKey = archivedKey;
            userDoc.files[idx].updatedAt = new Date().toISOString();
          }
          console.log(`[KB Cancel] Restored: ${file.Key} → ${archivedKey}`);
        } catch (fileErr) {
          console.warn(`[KB Cancel] Failed to restore ${file.Key}:`, fileErr.message);
        }
      }
    }

    // Clear indexing status
    userDoc.kbIndexingStatus = {
      jobId,
      phase: 'cancelled',
      backendCompleted: false,
      updatedAt: new Date().toISOString()
    };
    await cloudant.saveDocument('maia_users', userDoc);

    res.json({ success: true, message: 'Indexing cancelled and files restored to archived folder' });
  } catch (error) {
    console.error('[KB Cancel] Error:', error);
    res.status(500).json({ success: false, error: 'CANCEL_FAILED', message: error.message });
  }
});

const ADMIN_USAGE_LIST_ID = 'admin_usage_list';

const fetchBillingBalance = async () => {
  const token = process.env.DIGITALOCEAN_TOKEN;
  if (!token) return null;
  try {
    const response = await fetch('https://api.digitalocean.com/v2/customers/my/balance', {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch (_error) {
    return null;
  }
};

const extractMonthToDateUsage = (balanceData) => {
  if (!balanceData || typeof balanceData !== 'object') return null;
  const candidates = [
    balanceData.month_to_date_usage,
    balanceData?.balance?.month_to_date_usage,
    balanceData.month_to_date_balance,
    balanceData?.balance?.month_to_date_balance
  ];
  const found = candidates.find(value => value !== undefined && value !== null);
  if (found === undefined || found === null) return null;
  return typeof found === 'number' ? found.toFixed(2) : String(found);
};

const appendAdminUsageEntry = async (deletedUserId) => {
  try {
    const balanceData = await fetchBillingBalance();
    const monthToDateUsage = extractMonthToDateUsage(balanceData);
    const entry = {
      date: new Date().toISOString(),
      monthToDateUsage: monthToDateUsage,
      deletedUserId: deletedUserId || null,
      changeFromPrevious: null
    };

    let usageDoc = await cloudant.getDocument('maia_users', ADMIN_USAGE_LIST_ID);
    if (!usageDoc) {
      usageDoc = {
        _id: ADMIN_USAGE_LIST_ID,
        type: 'admin_usage_list',
        entries: []
      };
    }

    const previous = Array.isArray(usageDoc.entries) && usageDoc.entries.length > 0 ? usageDoc.entries[0] : null;
    const currentValue = monthToDateUsage !== null ? parseFloat(monthToDateUsage) : NaN;
    const previousValue = previous?.monthToDateUsage !== undefined && previous?.monthToDateUsage !== null
      ? parseFloat(previous.monthToDateUsage)
      : NaN;
    if (!Number.isNaN(currentValue) && !Number.isNaN(previousValue)) {
      entry.changeFromPrevious = (currentValue - previousValue).toFixed(2);
    }

    const existingEntries = Array.isArray(usageDoc.entries) ? usageDoc.entries : [];
    usageDoc.entries = [entry, ...existingEntries];
    await cloudant.saveDocument('maia_users', usageDoc);
  } catch (error) {
    console.error('Failed to append admin usage entry:', error);
  }
};

// ── New-user email notification ─────────────────────────────────────
// Sends an email summary when setup completes or the account is deleted.
// Fire-and-forget: errors are logged but never block the caller.
// If RESEND_API_KEY is not set the function silently no-ops (logged once at startup).

let resendClient = null;
const RESEND_WARNED = { value: false };
async function initResend() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    if (!RESEND_WARNED.value) {
      console.log('[NOTIFY] RESEND_API_KEY not set — email notifications disabled');
      RESEND_WARNED.value = true;
    }
    return null;
  }
  if (!resendClient) {
    const { Resend } = await import('resend');
    resendClient = new Resend(apiKey);
  }
  return resendClient;
}

/**
 * Send a new-user notification email.
 * @param {string} userId
 * @param {object} options
 * @param {boolean} [options.deleted] — true if the account was just deleted
 * @param {object} [options.userDoc] — pre-fetched user doc (required for deletion since doc is gone after)
 */
async function sendNewUserNotification(userId, options = {}) {
  try {
    const resend = await initResend();
    if (!resend) return;

    const toEmail = 'maia@trustee.ai';
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'noreply@maia.healthurl.com';
    const appUrl = process.env.PUBLIC_APP_URL || 'http://localhost:5173';

    // Get user doc (use pre-fetched if provided, e.g. before deletion)
    let userDoc = options.userDoc || null;
    if (!userDoc) {
      try {
        userDoc = await cloudant.getDocument('maia_users', userId);
      } catch { /* user may already be deleted */ }
    }

    // Dedup: only notify once per account lifecycle. Skip if an admin-notified
    // event already exists after the most recent account-deleted event.
    // Deletion notifications (options.deleted=true) always fire.
    if (!options.deleted && Array.isArray(userDoc?.provisioningLog)) {
      const log = userDoc.provisioningLog;
      let alreadyNotified = false;
      for (let i = log.length - 1; i >= 0; i--) {
        const ev = log[i]?.event;
        if (ev === 'account-deleted') break; // deletion resets notification state
        if (ev === 'admin-notified') { alreadyNotified = true; break; }
      }
      if (alreadyNotified) {
        console.log(`[NOTIFY] Skipping duplicate notification for ${userId} (already notified in this account lifecycle)`);
        return;
      }
    }

    // File info from user doc
    const files = Array.isArray(userDoc?.files) ? userDoc.files : [];
    const fileLines = files.map((f, i) => {
      const sizeKB = Math.round((f.fileSize || f.size || 0) / 1024);
      const tag = f.isAppleHealth ? ' (Apple Health)' : '';
      return `  File ${i + 1}: ${sizeKB.toLocaleString()} KB${tag}`;
    });
    const totalSizeKB = files.reduce((sum, f) => sum + (f.fileSize || f.size || 0), 0) / 1024;

    // KB tokens — prefer stored indexing status (always populated), fall back to DO API
    let kbTokens = 'unknown';
    if (userDoc?.kbIndexingStatus?.tokens) {
      kbTokens = Number(userDoc.kbIndexingStatus.tokens).toLocaleString();
    } else if (userDoc?.kbId) {
      try {
        const kbDetails = await doClient.kb.get(userDoc.kbId);
        const t = kbDetails?.total_tokens || kbDetails?.token_count || kbDetails?.tokens || 0;
        if (t > 0) kbTokens = Number(t).toLocaleString();
      } catch { /* KB may not exist */ }
    }

    // Passkey
    const hasPasskey = !!(userDoc?.credentialID);

    // Account deleted
    const deleted = !!options.deleted;

    // Errors from provisioning log
    const log = Array.isArray(userDoc?.provisioningLog) ? userDoc.provisioningLog : [];
    const errorEvents = new Set([
      'current-medications-recovery-failed', 'medications-dismissed',
      'agent-deploy-failed', 'kb-index-failed', 'summary-generation-failed',
      'restore-error', 'setup-error'
    ]);
    const errors = [];
    for (const ev of log) {
      const name = ev?.event;
      if (errorEvents.has(name)) {
        errors.push(`${name}${ev.error ? ': ' + ev.error : ''}`);
      } else if (name === 'medications-offered' && ev.outcome && ev.outcome !== 'verified' && ev.outcome !== 'shown' && ev.outcome !== 'success') {
        errors.push(`medications-offered: ${ev.outcome}`);
      }
    }

    // Month-to-date balance
    let mtdBalance = 'unavailable';
    try {
      const balanceData = await fetchBillingBalance();
      const mtd = extractMonthToDateUsage(balanceData);
      if (mtd !== null) mtdBalance = `$${mtd}`;
    } catch { /* non-fatal */ }

    // Is this a TEST run?
    const isTest = log.some(e => e?.event === 'test-started');
    const testTag = isTest ? ' (TEST)' : '';

    // Build email body. MTD is admin-only (shown in email, hidden from user PDF log).
    const commonLines = [
      `User ID: ${userId}`,
      `Files: ${files.length}`,
      ...fileLines,
      `Total size: ${Math.round(totalSizeKB).toLocaleString()} KB`,
      `KB tokens: ${kbTokens}`,
      `Passkey: ${hasPasskey ? 'Yes' : 'No'}`,
      `Account deleted: ${deleted ? 'Yes' : 'No'}`,
      ...(errors.length > 0 ? [`Errors (${errors.length}):`, ...errors.map(e => `  - ${e}`)] : [])
    ];
    const emailBody = [...commonLines, `MTD balance: ${mtdBalance}`, '', `App: ${appUrl}`].join('\n');
    const userBody = [...commonLines, '', `App: ${appUrl}`].join('\n');
    const subject = `MAIA: new account ${userId}${testTag}`;

    await resend.emails.send({
      from: fromEmail,
      to: toEmail,
      subject,
      text: emailBody
    });
    console.log(`[NOTIFY] ✅ Email sent for ${userId} to ${toEmail}`);

    // Log email contents to provisioning log so the user's maia-log.pdf shows it
    if (userDoc && !deleted) {
      // Retry up to 3 times — client may be writing to the doc concurrently
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const freshDoc = await cloudant.getDocument('maia_users', userId);
          if (freshDoc) {
            if (!Array.isArray(freshDoc.provisioningLog)) freshDoc.provisioningLog = [];
            const maxId = freshDoc.provisioningLog.reduce((m, e) => Math.max(m, e.id || 0), 0);
            freshDoc.provisioningLog.push({
              event: 'admin-notified',
              id: maxId + 1,
              time: new Date().toISOString(),
              from: fromEmail,
              to: toEmail,
              subject,
              body: userBody
            });
            freshDoc.updatedAt = new Date().toISOString();
            await cloudant.saveDocument('maia_users', freshDoc);
            break; // success
          }
        } catch (logErr) {
          if (attempt < 2 && logErr.message && logErr.message.includes('conflict')) {
            await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
            continue;
          }
          console.warn('[NOTIFY] Failed to log email to provisioning log:', logErr.message);
        }
      }
    }
  } catch (err) {
    console.error('[NOTIFY] ❌ Email notification failed:', err.message || err);
  }
}

// Admin: Get all users with statistics
app.get('/api/admin/users', async (req, res) => {
  try {
    // Allow unauthenticated access when running locally (only check hostname, not NODE_ENV)
    const isLocalhost = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
    
    // If not localhost, require authentication and check for ADMIN_USERNAME
    if (!isLocalhost) {
      const sessionUserId = req.session?.userId;
      const adminUsername = (process.env.ADMIN_USERNAME || 'admin');
      
      if (!sessionUserId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required'
        });
      }
      
      if (!adminUsername || sessionUserId !== adminUsername) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. Admin privileges required.'
        });
      }
    }
    
    // Get all users from maia_users database
    const allUsers = await cloudant.getAllDocuments('maia_users');
    
    // Filter out design documents and non-user documents
    const users = allUsers.filter(doc => doc.userId && !doc._id.startsWith('_design'));
    
    // Get all sessions to find last activity (include deep link sessions keyed by deepLinkUserId)
    const allSessions = await cloudant.getAllDocuments('maia_sessions');
    const sessionsByUserId = new Map();
    allSessions.forEach(session => {
      if (session._id.startsWith('_design')) return;
      // Skip mapping docs (session_xxx) – they have no lastActivity; use only actual session docs
      if (session._id.startsWith('session_') || session.type === 'session_mapping') return;
      const uid =
        session.userId ||
        session.deepLinkUserId ||
        (session._id.startsWith('deeplink_') ? session._id.replace(/^deeplink_/, '') : null);
      if (!uid) return;
      const existing = sessionsByUserId.get(uid);
      if (!existing || (session.lastActivity && (!existing.lastActivity || session.lastActivity > existing.lastActivity))) {
        sessionsByUserId.set(uid, session);
      }
    });
    
    // Get all chats to count saved chats per user
    const allChats = await cloudant.getAllDocuments('maia_chats');
    const chatsByUserId = new Map();
    allChats.forEach(chat => {
      if (chat.currentUser && !chat._id.startsWith('_design')) {
        const count = chatsByUserId.get(chat.currentUser) || 0;
        chatsByUserId.set(chat.currentUser, count + 1);
      }
    });
    
    // Count deep link users (users with isDeepLink flag)
    const deepLinkUserIds = new Set();
    users.forEach(user => {
      if (user.isDeepLink === true) {
        deepLinkUserIds.add(user.userId);
      }
    });
    
    // Calculate statistics for each user
    const userStats = await Promise.all(users.map(async (userDoc) => {
      const userId = userDoc.userId;
      
      // Get last activity from sessions, falling back to userDoc.lastActivity (stamped on sign-out)
      const session = sessionsByUserId.get(userId);
      let lastActivity = null;
      const lastActivityRaw = session?.lastActivity || userDoc.lastActivity;
      if (lastActivityRaw) {
        const lastActivityDate = new Date(lastActivityRaw);
        const now = new Date();
        const diffMs = now - lastActivityDate;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);
        
        if (diffMins < 60) {
          lastActivity = `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
        } else if (diffHours < 24) {
          lastActivity = `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
        } else {
          lastActivity = `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
        }
      }
      
      // Get provisioned date
      const provisionedDate = userDoc.createdAt || userDoc.provisionedAt || null;
      
      // Get total file storage in MB (using same calculation as file routes)
      let totalStorageMB = 0;
      try {
        const bucketUrl = getSpacesBucketName();
        if (bucketUrl && process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID && process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY) {
          const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';
          const s3Client = new S3Client({
            endpoint: getSpacesEndpoint(),
            region: 'us-east-1',
            forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
            credentials: {
              accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID,
              secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY
            }
          });
          // Use the same getUserBucketSize function as file routes
          const totalSizeBytes = await getUserBucketSize(s3Client, bucketName, userId);
          // Convert to MB (same as storage-usage endpoint)
          totalStorageMB = Math.round((totalSizeBytes / (1024 * 1024)) * 100) / 100;
        }
      } catch (error) {
        // Silently fail - storage calculation is optional for admin view
        // Errors are already logged by getUserBucketSize if needed
      }
      
      // Saved files count: exclude References folder (same logic as Saved Files tab)
      const allFiles = Array.isArray(userDoc.files) ? userDoc.files : [];
      const referencesPath = `${userId}/References/`;
      const savedFilesCount = allFiles.filter(f => {
        const bk = f.bucketKey || '';
        return !bk.startsWith(referencesPath) && f.isReference !== true;
      }).length;
      // KB indexing status is DO-only; keep admin count minimal
      const filesIndexed = savedFilesCount;
      
      // Get saved chats count
      const savedChatsCount = chatsByUserId.get(userId) || 0;
      
      // Count deep link users that have accessed this user's chats
      // Each chat has a deepLinkUserIds array tracking which deep link users accessed it
      const userChats = allChats.filter(chat => {
        const ownerId = chat.patientOwner || chat.currentUser;
        // Also try to extract from chat _id if patientOwner is missing
        if (!ownerId && chat._id) {
          const match = chat._id.match(/^([^-]+)-chat_/);
          return match && match[1] === userId;
        }
        return ownerId === userId;
      });
      
      // Collect all unique deep link user IDs from this user's chats
      const uniqueDeepLinkUserIds = new Set();
      userChats.forEach(chat => {
        if (Array.isArray(chat.deepLinkUserIds)) {
          chat.deepLinkUserIds.forEach(deepLinkUserId => {
            uniqueDeepLinkUserIds.add(deepLinkUserId);
          });
        }
      });
      
      const deepLinkUsersCount = uniqueDeepLinkUserIds.size;

      // Group memberships (Groups & AS feature): names only, for the
      // admin user list's Groups column.
      const groupNames = (userDoc.groupMemberships || [])
        .map((m) => m?.groupName || m?.groupId)
        .filter(Boolean);

      return {
        userId: userId,
        domain: userDoc.domain || null,
        workflowStage: userDoc.workflowStage || 'unknown',
        lastActivity: lastActivity || 'Never',
        provisionedDate: provisionedDate,
        totalStorageMB: totalStorageMB,
        filesIndexed: filesIndexed,
        savedChatsCount: savedChatsCount,
        deepLinkUsersCount: deepLinkUsersCount,
        hasPasskey: !!userDoc.credentialID,
        groupNames: groupNames
      };
    }));
    
    // Count total deep link users
    const totalDeepLinkUsers = deepLinkUserIds.size;
    
    const usageDoc = await cloudant.getDocument('maia_users', ADMIN_USAGE_LIST_ID);
    const usageList = Array.isArray(usageDoc?.entries) ? usageDoc.entries : [];

    res.json({
      success: true,
      users: userStats,
      totalUsers: userStats.length,
      totalDeepLinkUsers: totalDeepLinkUsers,
      usageList: usageList,
      passkeyConfig: {
        rpID: passkeyService.rpID,
        origin: passkeyService.origin
      }
    });
  } catch (error) {
    console.error('Error fetching admin users:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Admin: Recover user provisioning - check DO API and update user document
app.post('/api/admin/users/:userId/recover', async (req, res) => {
  try {
    // Allow unauthenticated access when running locally (only check hostname, not NODE_ENV)
    const isLocalhost = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
    
    // If not localhost, require authentication and check for ADMIN_USERNAME
    if (!isLocalhost) {
      const sessionUserId = req.session?.userId;
      const adminUsername = (process.env.ADMIN_USERNAME || 'admin');
      
      if (!sessionUserId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required'
        });
      }
      
      if (!adminUsername || sessionUserId !== adminUsername) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. Admin privileges required.'
        });
      }
    }
    
    const { userId } = req.params;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'User ID is required'
      });
    }

    // Get user document
    let userDoc;
    try {
      userDoc = await cloudant.getDocument('maia_users', userId);
    } catch (error) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    console.log(`[RECOVERY] Starting recovery for user: ${userId}`);
    console.log(`[RECOVERY] Current state: workflowStage=${userDoc.workflowStage}, assignedAgentId=${userDoc.assignedAgentId || 'none'}`);

    // Find agent by name pattern: {userId}-agent-{pattern}
    const agentNamePattern = new RegExp(`^${userId}-agent-`);
    let matchingAgent = null;
    let agentDetails = null;

    try {
      const agents = await doClient.agent.list();
      console.log(`[RECOVERY] Found ${agents.length} total agents in DO`);
      
      // Find agent matching user's name pattern
      for (const agent of agents) {
        if (agent.name && agentNamePattern.test(agent.name)) {
          matchingAgent = agent;
          console.log(`[RECOVERY] Found matching agent: ${agent.name} (UUID: ${agent.uuid || agent.id})`);
          break;
        }
      }

      if (!matchingAgent) {
        return res.status(404).json({
          success: false,
          error: `No agent found matching pattern for user ${userId}`
        });
      }

      // Get full agent details
      const agentId = matchingAgent.uuid || matchingAgent.id;
      agentDetails = await doClient.agent.get(agentId);
      console.log(`[RECOVERY] Agent details retrieved: status=${agentDetails?.deployment?.status || agentDetails?.status || 'unknown'}`);

      // Check if agent is deployed
      const deploymentStatus = agentDetails?.deployment?.status || agentDetails?.deployment?.state || agentDetails?.status || agentDetails?.state || 'UNKNOWN';
      const successStatuses = ['STATUS_RUNNING', 'RUNNING', 'STATUS_SUCCEEDED', 'SUCCEEDED', 'STATUS_READY', 'READY'];
      
      if (!successStatuses.includes(deploymentStatus)) {
        return res.status(400).json({
          success: false,
          error: `Agent is not deployed. Current status: ${deploymentStatus}. Agent must be in STATUS_RUNNING to complete recovery.`
        });
      }

      // Get agent endpoint
      let agentEndpointUrl = agentDetails?.deployment?.url ? `${agentDetails.deployment.url}/api/v1` : null;
      if (!agentEndpointUrl) {
        return res.status(400).json({
          success: false,
          error: 'Agent is deployed but endpoint URL is not available yet. Please wait a few minutes and try again.'
        });
      }

      console.log(`[RECOVERY] Agent is deployed and ready. Endpoint: ${agentEndpointUrl}`);

      // Check if API key exists, create if needed
      let apiKey = userDoc.agentApiKey;
      if (!apiKey) {
        console.log(`[RECOVERY] No API key found, creating new one...`);
        try {
          apiKey = await doClient.agent.createApiKey(agentId, `agent-${agentId}-api-key-recovery`);
          console.log(`[RECOVERY] API key created successfully`);
        } catch (apiKeyError) {
          console.error(`[RECOVERY] Failed to create API key: ${apiKeyError.message}`);
          return res.status(500).json({
            success: false,
            error: `Failed to create API key: ${apiKeyError.message}`
          });
        }
      } else {
        console.log(`[RECOVERY] Using existing API key`);
      }

      // Get agent model name
      const agentModelName = agentDetails?.model?.inference_name || agentDetails?.model?.name || null;

      // Helper function to safely update user document
      const updateUserDoc = async (updates, retries = 3) => {
        for (let attempt = 1; attempt <= retries; attempt++) {
          try {
            const latestDoc = await cloudant.getDocument('maia_users', userId);
            const updatedDoc = {
              ...latestDoc,
              ...(typeof updates === 'function' ? updates(latestDoc) : updates),
              updatedAt: new Date().toISOString()
            };
            await cloudant.saveDocument('maia_users', updatedDoc);
            return updatedDoc;
          } catch (error) {
            if (error.statusCode === 409 && attempt < retries) {
              await new Promise(resolve => setTimeout(resolve, 200 * attempt));
              continue;
            }
            throw error;
          }
        }
      };

      // Update user document with all missing fields
      const timestamp = new Date().toISOString();
      const agentName = matchingAgent.name;
      const defaultProfileKey = userDoc.agentProfileDefaultKey || 'default';

      // Clone user doc for merging
      const docClone = { ...userDoc };

      // Merge agent profile
      mergeAgentProfileOnDoc(docClone, defaultProfileKey, {
        agentId: agentId,
        agentName: agentName,
        endpoint: agentEndpointUrl,
        modelName: agentModelName,
        apiKey: apiKey
      }, timestamp);

      docClone.agentProfileDefaultKey = defaultProfileKey;
      ensureDeepLinkAgentOverrides(docClone);

      // Update user document
      await updateUserDoc({
        assignedAgentId: agentId,
        assignedAgentName: agentName,
        agentEndpoint: agentEndpointUrl,
        agentModelName: agentModelName,
        agentApiKey: apiKey,
        agentProfiles: docClone.agentProfiles,
        agentProfileDefaultKey: docClone.agentProfileDefaultKey,
        deepLinkAgentOverrides: docClone.deepLinkAgentOverrides,
        workflowStage: 'agent_deployed',
        provisioned: true,
        provisionedAt: timestamp
      });

      console.log(`[RECOVERY] User document updated successfully`);

      // Generate Current Medications token if agent is ready
      try {
        const tokenData = generateCurrentMedicationsToken(userId);
        await updateUserDoc({
          currentMedicationsToken: tokenData.token,
          currentMedicationsTokenExpiresAt: tokenData.expiresAt
        });
        console.log(`[RECOVERY] Current Medications token generated`);
      } catch (tokenError) {
        console.error(`[RECOVERY] Failed to generate Current Medications token: ${tokenError.message}`);
        // Don't fail recovery if token generation fails
      }

      return res.json({
        success: true,
        message: `User ${userId} recovered successfully. Agent ${agentName} is now linked and ready.`,
        agentId: agentId,
        agentName: agentName,
        endpoint: agentEndpointUrl,
        workflowStage: 'agent_deployed'
      });

    } catch (error) {
      console.error(`[RECOVERY] Error during recovery: ${error.message}`);
      console.error(`[RECOVERY] Stack: ${error.stack}`);
      return res.status(500).json({
        success: false,
        error: `Recovery failed: ${error.message}`
      });
    }
  } catch (error) {
    console.error('Recovery endpoint error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

async function deleteUserAndResources(userId, options = {}) {
  const { deleteAgent = true } = options;
  console.log(`[DESTROY] Starting deletion for ${userId}`);
  // Get user document first to collect information
  let userDoc;
  try {
    userDoc = await cloudant.getDocument('maia_users', userId);
  } catch (error) {
    const notFound = new Error('User not found');
    notFound.statusCode = 404;
    throw notFound;
  }

  const deletionDetails = {
    spacesDeleted: false,
    filesDeleted: 0,
    kbDeleted: false,
    agentDeleted: false,
    userDocDeleted: false,
    sessionsDeleted: 0,
    deepLinkUsersDeleted: 0,
    chatsDeleted: 0,
    groupsLeft: 0,
    errors: []
  };

  // 0. Leave every group (and withdraw pending join requests) BEFORE the
  // userDoc — and with it the pairwise signing keys — is destroyed.
  // Skipping this leaves a permanently unreachable "active" ghost at the
  // registry: publicly counted, mentor-listable, receiving Everyone
  // broadcasts into the void, and silently eating peer messages. The
  // registry's leave endpoint accepts any signed non-invited member, so
  // the same claim withdraws a pending ('requested') join. Best-effort
  // per group; a down registry never blocks account deletion.
  const groupEntries = [
    ...(userDoc.groupMemberships || []),
    ...(userDoc.pendingGroupJoins || [])
  ];
  for (const m of groupEntries) {
    try {
      if (!m?.groupId || !m?.pairwiseId || !m?.signingKeyPair?.privateKeyJwk) continue;
      const payload = JSON.stringify({
        action: 'leave',
        groupId: m.groupId,
        pairwiseId: m.pairwiseId,
        ts: new Date().toISOString()
      });
      const priv = createPrivateKey({ key: m.signingKeyPair.privateKeyJwk, format: 'jwk' });
      const signature = edSign(null, Buffer.from(payload), priv).toString('base64url');
      const base = String(m.registryUrl || `http://localhost:${process.env.PORT || 3001}`).replace(/\/$/, '');
      const r = await fetch(`${base}/api/groups/${encodeURIComponent(m.groupId)}/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairwiseId: m.pairwiseId, payload, signature })
      });
      if (r.ok) {
        deletionDetails.groupsLeft++;
        console.log(`[DESTROY] Left group ${m.groupId} (${m.groupName || 'unnamed'}) for ${userId}`);
      } else {
        console.warn(`[DESTROY] Registry declined leave for ${m.groupId} (HTTP ${r.status})`);
      }
    } catch (error) {
      console.warn(`[DESTROY] Group leave failed for ${m?.groupId}:`, error?.message || error);
      deletionDetails.errors.push(`Group leave failed: ${m?.groupId}`);
    }
  }

  // 1. Delete all files from Spaces folder
  try {
    console.log(`[DESTROY] Deleting stored files for ${userId}`);
    const bucketUrl = getSpacesBucketName();
    if (bucketUrl) {
      const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';
      const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
      
      const s3Client = new S3Client({
        endpoint: getSpacesEndpoint(),
        region: 'us-east-1',
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
        credentials: {
          accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
          secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
        }
      });

      // List all files with userId prefix
      let continuationToken = null;
      do {
        const listCommand = new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: `${userId}/`,
          ContinuationToken: continuationToken || undefined
        });

        const listResult = await s3Client.send(listCommand);
        
        if (listResult.Contents && listResult.Contents.length > 0) {
          // Delete all files
          for (const file of listResult.Contents) {
            if (file.Key) {
              try {
                await deleteObjectWithLog({
                  s3Client,
                  bucketName,
                  key: file.Key
                });
                deletionDetails.filesDeleted++;
              } catch (err) {
                deletionDetails.errors.push(`Failed to delete file ${file.Key}: ${err.message}`);
              }
            }
          }
        }

        continuationToken = listResult.NextContinuationToken || null;
      } while (continuationToken);

      deletionDetails.spacesDeleted = true;
    }
  } catch (error) {
    deletionDetails.errors.push(`Failed to delete Spaces folder: ${error.message}`);
  }

  // 2. Delete Knowledge Base
  try {
    console.log(`[DESTROY] Deleting knowledge base(s) for ${userId}`);
    // Delete BOTH the primary (KB-1) and the alternate (KB-2) if present.
    const kbIds = [userDoc.kbId, userDoc.kb2?.kbId].filter(Boolean);
    if (kbIds.length > 0) {
      for (const kbId of kbIds) {
        try {
          await doClient.kb.delete(kbId);
          console.log(`[DESTROY] Deleted KB ${kbId}`);
        } catch (error) {
          if (error.statusCode === 404 || error.message?.includes('not found')) {
            console.log(`[DESTROY] KB not found (already gone): ${kbId}`);
          } else {
            throw error;
          }
        }
      }
      deletionDetails.kbDeleted = true;
    } else {
      deletionDetails.kbDeleted = true; // No KB to delete
    }
  } catch (error) {
    deletionDetails.errors.push(`Failed to delete Knowledge Base: ${error.message}`);
  }

  // 3. Delete Agent (optional) — delete ALL agents matching userId pattern, not just stored ID
  if (deleteAgent) {
    try {
      console.log(`[DESTROY] Deleting agents for ${userId}`);
      let deletedCount = 0;
      // First delete the stored agent ID
      const storedAgentId = userDoc.assignedAgentId;
      if (storedAgentId) {
        try {
          await doClient.agent.delete(storedAgentId);
          deletedCount++;
          console.log(`[DESTROY] Deleted stored agent ${storedAgentId}`);
        } catch (error) {
          if (error.statusCode === 404 || error.message?.includes('not found')) {
            console.log(`[DESTROY] Stored agent not found: ${storedAgentId}`);
          } else {
            throw error;
          }
        }
      }
      // Explicitly delete the secondary "Private AI (Deepseek)" agent. (It
      // is also caught by the orphan scan below since its name matches
      // `${userId}-agent-`, but delete it directly so it goes even if
      // the naming convention ever changes.)
      const gptAgentId = userDoc.agentProfiles?.gpt?.agentId;
      if (gptAgentId && gptAgentId !== storedAgentId) {
        try {
          await doClient.agent.delete(gptAgentId);
          deletedCount++;
          console.log(`[DESTROY] Deleted GPT agent ${gptAgentId}`);
        } catch (error) {
          if (error.statusCode === 404 || error.message?.includes('not found')) {
            console.log(`[DESTROY] GPT agent not found: ${gptAgentId}`);
          } else {
            throw error;
          }
        }
      }
      // Then scan for any orphaned agents matching the naming pattern
      try {
        const { AgentClient } = await import('../lib/do-client/agent.js');
        const agentClient = new AgentClient(doClient);
        const allAgents = await agentClient.list();
        const agentPattern = new RegExp(`^${userId}-agent-`);
        const orphanedAgents = allAgents.filter(a => agentPattern.test(a.name) && (a.uuid || a.id) !== storedAgentId);
        for (const orphan of orphanedAgents) {
          const orphanId = orphan.uuid || orphan.id;
          try {
            await doClient.agent.delete(orphanId);
            deletedCount++;
            console.log(`[DESTROY] Deleted orphaned agent ${orphan.name} (${orphanId})`);
          } catch (err) {
            if (!(err.statusCode === 404 || err.message?.includes('not found'))) {
              console.warn(`[DESTROY] Failed to delete orphaned agent ${orphanId}: ${err.message}`);
            }
          }
        }
      } catch (listErr) {
        console.warn(`[DESTROY] Could not scan for orphaned agents: ${listErr.message}`);
      }
      deletionDetails.agentDeleted = true;
      console.log(`[DESTROY] Agent cleanup complete: ${deletedCount} deleted`);
    } catch (error) {
      console.error(`[DESTROY] Agent deletion failed for ${userId}:`, error.message);
      deletionDetails.errors.push(`Failed to delete Agent: ${error.message}`);
    }
  } else {
    deletionDetails.agentDeleted = false;
    console.log(`[LOCAL] Skipping agent deletion for ${userId}`);
  }

  // 4. Delete user sessions from maia_sessions
  try {
    console.log(`[DESTROY] Deleting sessions for ${userId}`);
    const allSessions = await cloudant.getAllDocuments('maia_sessions');
    const userSessions = allSessions.filter(session => session.userId === userId && !session._id.startsWith('_design'));
    
    for (const session of userSessions) {
      try {
        await cloudant.deleteDocument('maia_sessions', session._id);
        deletionDetails.sessionsDeleted++;
      } catch (err) {
        deletionDetails.errors.push(`Failed to delete session ${session._id}: ${err.message}`);
      }
    }
  } catch (error) {
    deletionDetails.errors.push(`Failed to delete sessions: ${error.message}`);
  }

  // 5. Delete deep link users and user chats from maia_chats
  try {
    console.log(`[DESTROY] Deleting chats and deep links for ${userId}`);
    const allChats = await cloudant.getAllDocuments('maia_chats');
    // Find chats owned by this user (check patientOwner, currentUser, or extract from _id)
    const userChats = allChats.filter(chat => {
      if (chat._id.startsWith('_design')) return false;
      const ownerId = chat.patientOwner || chat.currentUser;
      if (ownerId === userId) return true;
      // Also try to extract from chat _id if patientOwner is missing
      if (!ownerId && chat._id) {
        const match = chat._id.match(/^([^-]+)-chat_/);
        return match && match[1] === userId;
      }
      return false;
    });
    
    // Collect all unique deep link user IDs from these chats
    const deepLinkUserIdsToDelete = new Set();
    userChats.forEach(chat => {
      if (Array.isArray(chat.deepLinkUserIds)) {
        chat.deepLinkUserIds.forEach(deepLinkUserId => {
          deepLinkUserIdsToDelete.add(deepLinkUserId);
        });
      }
    });
      
    // Delete each deep link user
    let deepLinkUsersDeleted = 0;
    for (const deepLinkUserId of deepLinkUserIdsToDelete) {
      try {
        await cloudant.deleteDocument('maia_users', deepLinkUserId);
        deepLinkUsersDeleted++;
      } catch (err) {
        // Deep link user might not exist or already deleted - log but continue
        if (err.statusCode !== 404) {
          deletionDetails.errors.push(`Failed to delete deep link user ${deepLinkUserId}: ${err.message}`);
        }
      }
    }
    
    if (deepLinkUsersDeleted > 0) {
      deletionDetails.deepLinkUsersDeleted = deepLinkUsersDeleted;
    }
    
    // Now delete the chats
    for (const chat of userChats) {
      try {
        await cloudant.deleteDocument('maia_chats', chat._id);
        deletionDetails.chatsDeleted++;
      } catch (err) {
        deletionDetails.errors.push(`Failed to delete chat ${chat._id}: ${err.message}`);
      }
    }
  } catch (error) {
    deletionDetails.errors.push(`Failed to delete chats and deep link users: ${error.message}`);
  }

  // 6. Delete user document (do this last)
  try {
    console.log(`[DESTROY] Deleting user document for ${userId}`);
    await cloudant.deleteDocument('maia_users', userId);
    deletionDetails.userDocDeleted = true;
  } catch (error) {
    deletionDetails.errors.push(`Failed to delete user document: ${error.message}`);
    const deleteError = new Error('Failed to delete user document');
    deleteError.details = deletionDetails;
    throw deleteError;
  }

  console.log(`[DESTROY] Completed deletion for ${userId}:`, JSON.stringify(deletionDetails));

  // ── Post-deletion verification ──────────────────────────────────
  console.log(`[DESTROY-VERIFY] Verifying deletion for ${userId}...`);

  // Verify CouchDB user doc is gone
  try {
    const checkDoc = await cloudant.getDocument('maia_users', userId);
    if (checkDoc) {
      console.error(`[DESTROY-VERIFY] ❌ User doc STILL EXISTS in CouchDB for ${userId}`);
    } else {
      console.log(`[DESTROY-VERIFY] ✅ User doc deleted from CouchDB`);
    }
  } catch (e) {
    if (e.statusCode === 404 || e.message?.includes('not found')) {
      console.log(`[DESTROY-VERIFY] ✅ User doc deleted from CouchDB (404)`);
    } else {
      console.warn(`[DESTROY-VERIFY] CouchDB check error:`, e.message);
    }
  }

  // Verify DO agent is gone
  const agentId = userDoc?.assignedAgentId;
  if (agentId) {
    try {
      const agentCheck = await doClient.agent.get(agentId);
      if (agentCheck) {
        console.error(`[DESTROY-VERIFY] ❌ Agent STILL EXISTS in DO: ${agentId}`);
      }
    } catch (e) {
      if (e.statusCode === 404 || e.message?.includes('not found')) {
        console.log(`[DESTROY-VERIFY] ✅ Agent deleted from DO (${agentId})`);
      } else {
        console.warn(`[DESTROY-VERIFY] Agent check error:`, e.message);
      }
    }
  } else {
    console.log(`[DESTROY-VERIFY] ℹ️ No agent ID was stored`);
  }

  // Verify DO KB is gone
  const kbId = userDoc?.kbId;
  if (kbId) {
    try {
      const kbCheck = await doClient.kb.get(kbId);
      if (kbCheck) {
        console.error(`[DESTROY-VERIFY] ❌ KB STILL EXISTS in DO: ${kbId}`);
      }
    } catch (e) {
      if (e.statusCode === 404 || e.message?.includes('not found')) {
        console.log(`[DESTROY-VERIFY] ✅ KB deleted from DO (${kbId})`);
      } else {
        console.warn(`[DESTROY-VERIFY] KB check error:`, e.message);
      }
    }
  } else {
    console.log(`[DESTROY-VERIFY] ℹ️ No KB ID was stored`);
  }

  // Verify Spaces files are gone
  try {
    const bucketUrl = getSpacesBucketName();
    if (bucketUrl) {
      const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';
      const s3Verify = new S3Client({
        endpoint: getSpacesEndpoint(),
        region: 'us-east-1',
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
        credentials: {
          accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
          secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
        }
      });
      const listResp = await s3Verify.send(new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: `${userId}/`,
        MaxKeys: 5
      }));
      const remaining = listResp.KeyCount || 0;
      if (remaining > 0) {
        console.error(`[DESTROY-VERIFY] ❌ ${remaining} files STILL in Spaces under ${userId}/`);
      } else {
        console.log(`[DESTROY-VERIFY] ✅ Spaces bucket empty for ${userId}/`);
      }
    }
  } catch (e) {
    console.warn(`[DESTROY-VERIFY] Spaces check error:`, e.message);
  }

  console.log(`[DESTROY-VERIFY] Verification complete for ${userId}`);
  return deletionDetails;
}

// Admin: Delete user and all associated resources
app.delete('/api/admin/users/:userId', async (req, res) => {
  try {
    // Allow unauthenticated access when running locally (only check hostname, not NODE_ENV)
    const isLocalhost = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
    
    // If not localhost, require authentication and check for ADMIN_USERNAME
    if (!isLocalhost) {
      const sessionUserId = req.session?.userId;
      const adminUsername = (process.env.ADMIN_USERNAME || 'admin');
      
      if (!sessionUserId) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required'
        });
      }
      
      if (!adminUsername || sessionUserId !== adminUsername) {
        return res.status(403).json({
          success: false,
          error: 'Access denied. Admin privileges required.'
        });
      }
    }
    
    const { userId } = req.params;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'User ID is required'
      });
    }

    const deletionDetails = await deleteUserAndResources(userId);
    await appendAdminUsageEntry(userId);

    res.json({
      success: true,
      message: 'User and all associated resources deleted',
      details: deletionDetails
    });
  } catch (error) {
    console.error('Error deleting user:', error);
    const status = error.statusCode || 500;
    res.status(status).json({
      success: false,
      error: error.message || 'Failed to delete user',
      details: error.details
    });
  }
});

// Self-service deletion (signed-in user only)
app.post('/api/self/delete', async (req, res) => {
  try {
    const sessionUserId = req.session?.userId;
    const confirmUserId = req.body?.userId;
    if (!sessionUserId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    if (!confirmUserId || confirmUserId !== sessionUserId) {
      return res.status(400).json({ success: false, error: 'User ID confirmation does not match' });
    }

    console.log(`[SELF-DELETE] Account deletion requested by ${sessionUserId}`);
    // Capture user doc before deletion for the notification email
    let preDeleteUserDoc = null;
    try { preDeleteUserDoc = await cloudant.getDocument('maia_users', sessionUserId); } catch { /* ok */ }
    const deletionDetails = await deleteUserAndResources(sessionUserId);
    console.log(`[SELF-DELETE] Deletion completed for ${sessionUserId}:`, JSON.stringify(deletionDetails.errors?.length ? { errors: deletionDetails.errors } : { ok: true }));
    await appendAdminUsageEntry(sessionUserId);
    // Notify admin (fire-and-forget) — only if no setup-complete was logged (otherwise already notified)
    if (preDeleteUserDoc) {
      const log = Array.isArray(preDeleteUserDoc.provisioningLog) ? preDeleteUserDoc.provisioningLog : [];
      const alreadyNotified = log.some(e => e?.event === 'admin-notified');
      if (!alreadyNotified) {
        void sendNewUserNotification(sessionUserId, { deleted: true, userDoc: preDeleteUserDoc });
      }
    }

    // Destroy session — use a try/catch since session may already be invalid
    try {
      if (req.session) {
        await new Promise((resolve) => {
          req.session.destroy((err) => {
            if (err) console.warn('[SELF-DELETE] Session destroy warning:', err.message);
            resolve(undefined);
          });
        });
      }
    } catch (e) {
      console.warn('[SELF-DELETE] Session cleanup error (non-fatal):', e.message);
    }
    res.clearCookie('maia_temp_user');
    res.json({
      success: true,
      message: 'User account deleted',
      details: deletionDetails
    });
  } catch (error) {
    console.error('[SELF-DELETE] Error deleting user account:', error);
    const status = error.statusCode || 500;
    res.status(status).json({
      success: false,
      error: error.message || 'Failed to delete user account',
      details: error.details
    });
  }
});

// Unauthenticated delete for local (temporary, non-admin) users from the welcome page
app.post('/api/local/delete', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ success: false, error: 'userId required' });
    }
    // Basic sanitization: alphanumeric, hyphens, underscores, dots, @; max 128 chars
    const safeIdRegex = /^[a-zA-Z0-9_@.\-]{1,128}$/;
    if (!safeIdRegex.test(userId.trim())) {
      return res.status(400).json({ success: false, error: 'Invalid userId format' });
    }
    // Never allow deleting the admin user
    const adminUsername = (process.env.ADMIN_USERNAME || 'admin')?.trim();
    if (adminUsername && userId.trim().toLowerCase() === adminUsername.toLowerCase()) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    console.log(`[LOCAL-DELETE] Unauthenticated deletion requested for ${userId}`);
    // Capture user doc before deletion for the notification email
    let preDeleteUserDoc = null;
    try { preDeleteUserDoc = await cloudant.getDocument('maia_users', userId); } catch { /* ok */ }
    const deletionDetails = await deleteUserAndResources(userId);
    console.log(`[LOCAL-DELETE] Deletion completed for ${userId}`);
    // Notify admin (fire-and-forget) — only if no setup-complete was logged
    if (preDeleteUserDoc) {
      const log = Array.isArray(preDeleteUserDoc.provisioningLog) ? preDeleteUserDoc.provisioningLog : [];
      const alreadyNotified = log.some(e => e?.event === 'admin-notified');
      if (!alreadyNotified) {
        void sendNewUserNotification(userId, { deleted: true, userDoc: preDeleteUserDoc });
      }
    }
    res.json({ success: true, details: deletionDetails });
  } catch (error) {
    if (error?.statusCode === 404) {
      return res.json({ success: true, message: 'User not found (may already be deleted)' });
    }
    console.error('[LOCAL-DELETE] Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to delete user' });
  }
});

// Store Apple Health export availability (wizard stage 3)
app.post('/api/user-apple-file-status', async (req, res) => {
  try {
    const sessionUserId = req.session?.userId;
    const { userId, hasAppleFile } = req.body || {};

    if (!sessionUserId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }
    if (!userId || userId !== sessionUserId) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    if (typeof hasAppleFile !== 'boolean') {
      return res.status(400).json({ success: false, error: 'Invalid hasAppleFile value' });
    }

    const userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    userDoc.hasAppleFile = hasAppleFile;
    userDoc.updatedAt = new Date().toISOString();
    await cloudant.saveDocument('maia_users', userDoc);

    res.json({ success: true, hasAppleFile });
  } catch (error) {
    console.error('❌ Error updating Apple Health export status:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update Apple Health export status'
    });
  }
});

// Cloud health check — verify all four cloud resources are accessible
app.get('/api/cloud-health', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ healthy: false, error: 'userId required' });
    }

    const details = {
      database: { ok: false },
      agent: { ok: false },
      knowledgeBase: { ok: false },
      spacesFiles: { ok: false, fileCount: 0 }
    };

    // 1. Check database
    let userDoc;
    try {
      userDoc = await cloudant.getDocument('maia_users', userId);
      details.database.ok = !!userDoc;
      if (!userDoc) details.database.error = 'User document not found';
    } catch (e) {
      details.database.error = e.message || 'Database check failed';
    }

    // 2. Check agent
    const agentId = userDoc?.assignedAgentId;
    if (agentId) {
      try {
        const agent = await getCachedAgent(agentId);
        details.agent.ok = !!agent;
        details.agent.agentId = agentId;
        if (!agent) details.agent.error = 'Agent not found';
      } catch (e) {
        details.agent.error = e.message || 'Agent check failed';
        details.agent.agentId = agentId;
      }
    } else {
      // No agent configured — only an issue if user previously had one
      details.agent.ok = !userDoc?.agentId; // ok if never had an agent
      if (!details.agent.ok) details.agent.error = 'Agent ID missing from user record';
    }

    // 3. Check KB
    const kbId = userDoc?.kbId;
    if (kbId) {
      try {
        const kb = await getCachedKB(kbId);
        details.knowledgeBase.ok = !!kb;
        details.knowledgeBase.kbId = kbId;
        if (!kb) details.knowledgeBase.error = 'Knowledge base not found';
      } catch (e) {
        details.knowledgeBase.error = e.message || 'KB check failed';
        details.knowledgeBase.kbId = kbId;
      }
    } else {
      // No KB configured — ok if user never had files indexed
      details.knowledgeBase.ok = true;
    }

    // 4. Check Spaces files
    try {
      const bucketUrl = getSpacesBucketName();
      if (bucketUrl) {
        const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';
        const s3 = new S3Client({
          endpoint: getSpacesEndpoint(),
          region: 'us-east-1',
          forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
          credentials: {
            accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
            secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
          }
        });
        const listResp = await s3.send(new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: `${userId}/`,
          MaxKeys: 10
        }));
        const count = listResp.KeyCount || 0;
        details.spacesFiles.ok = true; // Spaces accessible even if no files yet
        details.spacesFiles.fileCount = count;
      } else {
        details.spacesFiles.ok = true; // No Spaces configured — not an error
      }
    } catch (e) {
      details.spacesFiles.error = e.message || 'Spaces check failed';
    }

    const healthy = details.database.ok && details.agent.ok &&
                    details.knowledgeBase.ok && details.spacesFiles.ok;

    res.json({ healthy, details });
  } catch (error) {
    console.error('Cloud health check error:', error);
    res.status(500).json({
      healthy: false,
      error: error.message || 'Health check failed'
    });
  }
});

// POST /api/wizard/quick-start-complete — mark a quick-start account
// (chat + private AI, no health records yet) as setup-complete. Sets
// workflowStage 'chat_ready', a legitimate wizard-done state: the agent
// is deployed, there is no KB/patient summary, and the Groups tab is the
// primary surface. Adding records later runs the full wizard, whose
// patient-summary verification advances the stage past 'chat_ready'.
// Never downgrades an account that already completed the full wizard.
app.post('/api/wizard/quick-start-complete', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) {
      return res.status(400).json({ success: false, error: 'User ID is required' });
    }
    const isLocalhost = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
    if (!isLocalhost && req.session?.userId !== userId) {
      return res.status(403).json({ success: false, error: 'Not authorized for this user' });
    }
    const userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    const COMPLETED_STAGES = new Set(['patient_summary', 'link_stored']);
    if (!COMPLETED_STAGES.has(userDoc.workflowStage)) {
      userDoc.workflowStage = 'chat_ready';
      userDoc.updatedAt = new Date().toISOString();
      await cloudant.saveDocument('maia_users', userDoc);
    }
    res.json({ success: true, workflowStage: userDoc.workflowStage });
  } catch (error) {
    console.error('[Wizard] quick-start-complete failed:', error);
    res.status(500).json({ success: false, error: 'Failed to record quick start' });
  }
});

// Get user status (for contextual tip)
app.get('/api/user-status', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }

    // Validate user resources against DigitalOcean (single source of truth)
    const { hasAgent, kbStatus, userDoc } = await validateUserResources(userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }
    
    // Include initial file info if available
    // If initialFile exists but bucketKey is missing, try to reconstruct it from KB name
    let initialFile = null;
    const kbInfo = await resolveKbForUserFromDo(userId);
    if (userDoc.initialFile) {
      let bucketKey = userDoc.initialFile.bucketKey;
      
      // If bucketKey is missing, try to reconstruct it from KB name and fileName
      if (!bucketKey && userDoc.initialFile.fileName) {
        if (kbInfo?.name) {
          // File should be in userId/KB/FileName.pdf
          const cleanFileName = userDoc.initialFile.fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
          bucketKey = `${userId}/${kbInfo.name}/${cleanFileName}`;
          // Update user document with the reconstructed bucketKey
          try {
            userDoc.initialFile.bucketKey = bucketKey;
            await cloudant.saveDocument('maia_users', userDoc);
          } catch (updateErr) {
            // Failed to update user document - continue
          }
        }
      }
      
      initialFile = {
        fileName: userDoc.initialFile.fileName,
        bucketKey: bucketKey,
        fileSize: userDoc.initialFile.fileSize,
        uploadedAt: userDoc.initialFile.uploadedAt
      };
      
    }

    const workflowStage = userDoc.workflowStage || 'unknown';
    const fileCount = userDoc.files ? userDoc.files.length : 0;
    
    // Convert kbStatus to hasKB for backward compatibility, but also return kbStatus
    const hasKB = kbStatus === 'attached' || kbStatus === 'not_attached';

    const kbName = kbInfo?.name || userDoc.kbName || null;
    let hasFilesInKB = false;
    if (kbInfo?.id && kbName) {
      try {
        const dataSources = await doClient.kb.listDataSources(kbInfo.id);
        const folderDs = (dataSources || []).find(ds => {
          const dsPath = ds?.item_path || ds?.path || ds?.spaces_data_source?.item_path;
          return isKbFolderDataSourcePath(dsPath, userId, kbName);
        });
        hasFilesInKB = !!folderDs?.last_datasource_indexing_job;
      } catch (error) {
        hasFilesInKB = false;
      }
    }
    // Fallback: DO API can fail (e.g. 404 "Failed to list indexing jobs") or be out of sync.
    // Saved Files uses userDoc.kbIndexedBucketKeys; if we have that or backendCompleted, treat as indexed
    // so the "Index your records" modal does not show when Saved Files already shows indexed records.
    if (!hasFilesInKB && userDoc.kbIndexingStatus?.backendCompleted === true) {
      hasFilesInKB = true;
    }
    if (!hasFilesInKB && Array.isArray(userDoc.kbIndexedBucketKeys) && userDoc.kbIndexedBucketKeys.length > 0) {
      hasFilesInKB = true;
    }

    const agentReady = !!(userDoc.assignedAgentId && userDoc.agentEndpoint);
    logWizAttachCheck(
      `user-status:${userId}`,
      {
        agentReady,
        kbStatus,
        kbId: userDoc.kbId || 'none',
        indexed: !!userDoc.kbIndexingStatus?.backendCompleted
      },
      `[WIZ] Attach check (user-status): agentReady=${agentReady} kbStatus=${kbStatus} kbId=${userDoc.kbId || 'none'} indexed=${!!userDoc.kbIndexingStatus?.backendCompleted}`
    );
    let resolvedKbStatus = kbStatus;
    if (agentReady && kbStatus === 'not_attached' && userDoc?.kbId && userDoc?.kbIndexingStatus?.backendCompleted) {
      try {
        await doClient.agent.attachKB(userDoc.assignedAgentId, userDoc.kbId);
        resolvedKbStatus = 'attached';
        invalidateResourceCache(userId);
        console.log(`[WIZ] ✅ Attached KB ${userDoc.kbId} to agent ${userDoc.assignedAgentId} after indexing completion (user-status).`);
      } catch (attachError) {
        if (!attachError.message || !attachError.message.includes('already')) {
          console.error(`[WIZ] ❌ Attach failed (user-status):`, attachError.message);
        }
      }
    }
    res.json({
      success: true,
      workflowStage,
      hasAgent,
      agentReady,
      fileCount,
      hasKB,
      hasFilesInKB,
      kbStatus: resolvedKbStatus, // 'none' | 'not_attached' | 'attached'
      kbName, // KB folder name (e.g., 'userId-agent-YYYYMMDD-HHMMSS')
      hasAppleFile: (Array.isArray(userDoc.files) && userDoc.files.some((f) => f && f.isAppleHealth))
        || (typeof userDoc.hasAppleFile === 'boolean' ? userDoc.hasAppleFile : null),
      listsBuild: userDoc.listsBuild || null,
      initialFile,
      currentMedications: userDoc.currentMedications || null,
      recordsPipeline: computeRecordsPipeline(userDoc, { hasFilesInKB })
    });
  } catch (error) {
    console.error('❌ Error fetching user status:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to fetch user status: ${error.message}`,
      error: 'FETCH_FAILED'
    });
  }
});

// Update user workflow stage (used by RestoreWizard completion)
app.post('/api/user-status', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return; // 403 already sent on mismatch
    const { workflowStage } = req.body;
    if (!workflowStage) {
      return res.status(400).json({ success: false, error: 'workflowStage required' });
    }
    let saved = false;
    let attempts = 0;
    while (!saved && attempts < 3) {
      attempts++;
      const userDoc = await cloudant.getDocument('maia_users', userId);
      if (!userDoc) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }
      userDoc.workflowStage = workflowStage;
      userDoc.updatedAt = new Date().toISOString();
      try {
        await cloudant.saveDocument('maia_users', userDoc);
        saved = true;
      } catch (saveErr) {
        if (saveErr?.statusCode === 409 && attempts < 3) continue;
        throw saveErr;
      }
    }
    res.json({ success: true });
  } catch (error) {
    console.error('[user-status POST] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── recordsPipeline (New_User_Flows.md §5, step 1) ──────────────────────
// The server-owned view of the records journey: imported → listsBuilt →
// medsVerified → indexed → summaryDrafted → summaryVerified. Derived from
// existing userDoc fields (no migration). GET reads it; POST /advance is
// THE trigger — it returns the server's decision on the next step. In
// step 1 execution stays on the existing surfaces (the response says what
// to run); step 3 moves 'client'-kind executions here.

// ── The start-indexing worker (recordsPipeline step 3c) ────────────────
// Reuses the EXACT flow the wizard's client ran: move each root file
// into the KB folder (toggle endpoint), then /api/update-knowledge-base
// (the DO data-source orchestration, ~860 lines, already server-side).
// Both accept a body userId, so the worker drives them as internal HTTP
// calls rather than extracting them. kbIndexingStatus is the job marker
// the pipeline derives from; 'starting' makes the stage show 'running'
// immediately.
const runStartIndexing = async (userId) => {
  const base = `http://127.0.0.1:${PORT}`;
  try {
    await persistKbIndexingStatus(userId, { phase: 'starting', startedAt: new Date().toISOString(), backendCompleted: false, error: null });
    const userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc) throw new Error('USER_NOT_FOUND');
    const files = Array.isArray(userDoc.files) ? userDoc.files : [];
    const candidates = files.filter((f) => f?.bucketKey
      && !f.inKnowledgeBase
      && !f.isReference
      && !/\/archived\//i.test(f.bucketKey)
      && !/references\//i.test(f.bucketKey));
    for (const f of candidates) {
      const r = await fetch(`${base}/api/toggle-file-knowledge-base`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, bucketKey: f.bucketKey, inKnowledgeBase: true })
      });
      if (!r.ok) console.warn(`[pipeline] toggle→KB failed for ${f.fileName || f.bucketKey}: ${r.status}`);
    }
    const r2 = await fetch(`${base}/api/update-knowledge-base`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId })
    });
    console.log(`[pipeline] indexing for ${userId}: update-knowledge-base ${r2.status}`);
    if (!r2.ok) {
      const j = await r2.json().catch(() => ({}));
      await persistKbIndexingStatus(userId, { phase: 'error', error: j.message || j.error || `HTTP ${r2.status}` });
    }
  } catch (e) {
    console.error(`[pipeline] indexing for ${userId} failed:`, e.message);
    try { await persistKbIndexingStatus(userId, { phase: 'error', error: String(e?.message || e) }); } catch { /* bookkeeping */ }
  }
};

app.get('/api/pipeline', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ success: false, error: 'MISSING_USER_ID' });
    }
    const userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc) {
      return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
    }
    const pipeline = computeRecordsPipeline(userDoc);
    res.json({ success: true, pipeline, next: decideNextAction(pipeline) });
  } catch (error) {
    console.error('[pipeline GET] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/pipeline/advance', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return; // 403 already sent on mismatch
    const userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc) {
      return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
    }
    const { intent } = req.body || {};
    const pipeline = computeRecordsPipeline(userDoc);
    let next = decideNextAction(pipeline);
    // Step 3: advance EXECUTES what the server can. The Lists build runs
    // here (fire-and-forget; the guard in runInitialFileBuild dedupes
    // races with the upload-time trigger); the caller polls the pipeline.
    if (next.action === 'process-initial-file' && typeof req.app.locals.runInitialFileBuild === 'function') {
      const force = !!next.params?.force;
      void req.app.locals.runInitialFileBuild({ userId, force })
        .then((out) => console.log(`[pipeline] lists build for ${userId} finished: ${out.httpStatus}${out.body?.alreadyRunning ? ' (already running)' : ''}`))
        .catch((e) => console.error(`[pipeline] lists build for ${userId} failed:`, e.message));
      next = { kind: 'wait', action: 'lists-build-running', started: true };
    }
    // Step 3c: indexing. The worker replays the wizard's client flow
    // (toggle files into the KB folder → update-knowledge-base) entirely
    // server-side; kbIndexingStatus is the visible job state.
    if (next.action === 'start-indexing') {
      void runStartIndexing(userId)
        .then(() => console.log(`[pipeline] indexing kick for ${userId} finished`))
        .catch((e) => console.error(`[pipeline] indexing kick for ${userId} failed:`, e.message));
      next = { kind: 'wait', action: 'indexing-running', started: true };
    }
    // Step 3b: the draft-summary job. Runs when the pipeline itself asks
    // for a draft (stage pending/error) — or on the caller's explicit
    // intent, which also covers REGENERATION for users whose pipeline is
    // already complete. Gates always win: an intent never bypasses them.
    const gateActions = ['add-records', 'process-initial-file', 'lists-build-running', 'verify-medications', 'start-indexing', 'indexing-running'];
    if (!gateActions.includes(next.action)) {
      if (pipeline.stages.summaryDrafted.status === 'running') {
        next = { kind: 'wait', action: 'draft-running' };
      } else if (next.action === 'request-draft' || intent === 'draft-summary') {
        void runDraftGeneration(userId)
          .then((out) => console.log(`[pipeline] draft for ${userId} finished: ${out.httpStatus}`))
          .catch((e) => console.error(`[pipeline] draft for ${userId} failed:`, e.message));
        next = { kind: 'wait', action: 'draft-running', started: true };
      }
    }
    console.log(`[pipeline] advance ${userId}${intent ? ` intent=${intent}` : ''}: current=${pipeline.current} next=${next.kind}/${next.action}`);
    res.json({ success: true, pipeline, next });
  } catch (error) {
    console.error('[pipeline advance] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Multer for the restore-bytes endpoint. 50 MB matches the limit used by
// the wizard's /api/files/upload in server/routes/files.js.
const restoreBytesUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ── Phase 1 of the local-first redesign (see Documentation/NewRestore.md) ──
//
// Three endpoints implement the "maia-state.json is the full backup of
// userDoc; the cloud is a disposable accelerator" model. The existing
// per-field /api/restore + RestoreWizard orchestration stays in place
// during transition; the new path is preferred when MaiaState.schemaVersion
// >= 2 is present in the snapshot.
//
//   GET  /api/user-doc/full         — read the whole userDoc (minus secrets)
//   PUT  /api/account/rehydrate     — push it back; rebuild missing cloud bits
//   POST /api/files/restore-bytes   — stream a file to a specific bucketKey

const REGENERABLE_SECRET_FIELDS = ['agentApiKey', 'agentApiKeyId', 'challenge'];

function sanitizeUserDocForExport(userDoc) {
  if (!userDoc) return null;
  const clone = { ...userDoc };
  // Strip CouchDB internals — they'll be reapplied on import.
  delete clone._rev;
  // Strip regenerable secrets. The DO API can issue a fresh agent API key
  // on demand (recreateAgentApiKey), so backing this up is both unnecessary
  // and a footgun if the local folder leaks.
  for (const f of REGENERABLE_SECRET_FIELDS) delete clone[f];
  // Per-profile API keys are also regenerable (recreated against the
  // live DO agent on rehydrate). Strip them from every agent profile.
  if (clone.agentProfiles && typeof clone.agentProfiles === 'object') {
    const sanitizedProfiles = {};
    for (const [k, prof] of Object.entries(clone.agentProfiles)) {
      if (prof && typeof prof === 'object') {
        const { apiKey, ...rest } = prof;
        sanitizedProfiles[k] = rest;
      } else {
        sanitizedProfiles[k] = prof;
      }
    }
    clone.agentProfiles = sanitizedProfiles;
  }
  return clone;
}

// Full userDoc export. Used by saveLocalSnapshot at sign-out so
// maia-state.json carries a verbatim copy. Read-only; doesn't mutate.
app.get('/api/user-doc/full', async (req, res) => {
  try {
    const sessionUserId = req.session?.userId || null;
    if (!sessionUserId) {
      return res.status(401).json({ success: false, error: 'NOT_AUTHENTICATED' });
    }
    const userId = sessionUserId;
    const userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
    res.json({
      success: true,
      schemaVersion: 1,         // userDoc shape version; bump on breaking changes
      exportedAt: new Date().toISOString(),
      userDoc: sanitizeUserDocForExport(userDoc)
    });
  } catch (error) {
    console.error('[user-doc/full] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Rehydrate the cloud from a local backup. Idempotent: if the cloud is
// already in sync with the supplied userDoc, this returns success with
// nothing rebuilt. Otherwise it replaces userDoc, ensures agent+KB exist
// (regenerating their UUIDs if the DO records are gone), and returns the
// list of files the client still needs to re-upload via
// POST /api/files/restore-bytes.
//
// Request body: {
//   schemaVersion: number,
//   userDoc: { ... full userDoc, no _rev / no secrets ... },
//   folderFiles?: [{ name, size, mtime, sha256 }, ...]  // optional, for diff
// }
//
// Response: {
//   success: true,
//   rebuilt: { agent?: 'created'|'reused', kb?: 'created'|'reused' },
//   missingFiles: [{ fileName, bucketKey }, ...],
//   folderDiff?: { added: [...], removed: [...] }
// }
app.put('/api/account/rehydrate', async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ success: false, error: 'Authentication required' });

    const { schemaVersion, userDoc: incoming, folderFiles } = req.body || {};
    if (!incoming || typeof incoming !== 'object') {
      return res.status(400).json({ success: false, error: 'MISSING_USER_DOC' });
    }
    if (incoming.userId && incoming.userId !== userId) {
      return res.status(403).json({ success: false, error: 'USER_ID_MISMATCH' });
    }

    const rebuilt = {};
    const errors = [];

    // 1. Replace userDoc. Preserve _id and _rev from any existing doc so
    // CouchDB accepts the write; otherwise create fresh. Strip the
    // incoming doc of fields we don't want to round-trip (regenerable
    // secrets, _rev). The supplied schemaVersion is recorded so future
    // migrations have a baseline.
    let existing = null;
    try {
      existing = await cloudant.getDocument('maia_users', userId);
    } catch { /* may not exist */ }

    const docToWrite = {
      ...incoming,
      _id: existing?._id || userId,
      userId,
      maiaStateSchemaVersionAtRestore: schemaVersion || 1,
      restoredAt: new Date().toISOString()
    };
    // Strip any secrets the client may have included.
    for (const f of REGENERABLE_SECRET_FIELDS) delete docToWrite[f];
    if (existing?._rev) docToWrite._rev = existing._rev;

    // Restore always rebuilds/re-indexes the KB from re-uploaded files, so
    // make it footer-stripped (clean-index) — the current standard. This
    // upgrades pre-v1.3.95 accounts to clean-index on restore. The flag is
    // read by /api/update-knowledge-base (re-index → regenerates `_clean/`
    // sidecars and points the data source there); a from-scratch rebuild
    // via setupKnowledgeBase clean-indexes new KBs regardless.
    docToWrite.kbCleanIndex = true;

    // assignedAgentId / kbId in the incoming backup are STALE pointers to
    // resources destroyed by "Destroy Cloud Account". They're hints, not
    // truth. If a previous rehydrate pass already created live resources
    // and recorded their IDs on the existing doc, keep those — otherwise
    // pass 2 would clobber the freshly-created agent's ID with the dead
    // one and force a redundant agent recreation (leaving orphans).
    if (existing?.assignedAgentId) {
      docToWrite.assignedAgentId = existing.assignedAgentId;
    }
    if (existing?.kbId) {
      docToWrite.kbId = existing.kbId;
    }
    if (existing?.agentEndpoint && !docToWrite.agentEndpoint) {
      docToWrite.agentEndpoint = existing.agentEndpoint;
    }

    // Reconcile folder changes BEFORE the save. The user may have
    // added or removed files in the local folder (Finder) while signed
    // out. maia-state.json is the snapshot of "what the folder held at
    // sign-off"; the folder is the source of truth now.
    //  - REMOVED: drop the entry from userDoc.files so it is neither
    //    re-requested as a "missing" file (which would surface a
    //    "Not found in local folder" error) nor left in the KB.
    //  - ADDED: the server can't read the user's local disk, but it
    //    knows the real KB folder name. It creates a userDoc.files
    //    entry with the correct KB bucketKey so the file (a) registers
    //    in Saved Files and (b) gets indexed by update-knowledge-base,
    //    then the existing Spaces-HEAD loop flags it "missing" and the
    //    client streams the bytes via the proven /api/files/restore-
    //    bytes path — the SAME path that already works for restored
    //    files. No separate, kbName-guessing client upload flow.
    let folderDiff = null;
    if (Array.isArray(folderFiles)) {
      // Exclude MAIA-generated artifacts AND OS junk (dotfiles such as
      // .DS_Store). These are never user content and must not be
      // ingested or indexed.
      const MAIA_GENERATED = /^(maia-log\.pdf|maia-state\.json)$/i;
      const isIgnorable = (n) =>
        !n ||
        n.startsWith('.') ||
        MAIA_GENERATED.test(n) ||
        /\.webloc$/i.test(n);
      const presentNames = new Set(
        folderFiles.map(f => f && f.name).filter(n => !isIgnorable(n))
      );
      const docFiles = Array.isArray(docToWrite.files) ? docToWrite.files : [];
      const expectedNames = new Set(docFiles.map(f => f.fileName));
      const removed = docFiles
        .map(f => f.fileName)
        .filter(n => n && !presentNames.has(n));
      const added = [...presentNames].filter(n => !expectedNames.has(n));
      folderDiff = { added, removed };
      if (removed.length > 0) {
        const removedSet = new Set(removed);
        docToWrite.files = docFiles.filter(f => !removedSet.has(f.fileName));
        console.log(`[rehydrate] Dropped ${removed.length} folder-removed file(s) from userDoc.files: ${removed.join(', ')}`);
      }
      if (added.length > 0) {
        // Resolve the permanent KB name (round-tripped in the backup).
        const kbName = getKBNameFromUserDoc(docToWrite, userId) || generateKBName(userId);
        docToWrite.kbName = docToWrite.kbName || kbName;
        if (!Array.isArray(docToWrite.files)) docToWrite.files = [];
        const sizeByName = {};
        for (const f of folderFiles) if (f && f.name) sizeByName[f.name] = f.size || 0;
        for (const name of added) {
          const cleanName = name.replace(/[^a-zA-Z0-9.-]/g, '_');
          const bucketKey = `${userId}/${kbName}/${cleanName}`;
          if (docToWrite.files.some(f => f.bucketKey === bucketKey)) continue;
          docToWrite.files.push({
            fileName: name,
            bucketKey,
            fileSize: sizeByName[name] || 0,
            uploadedAt: new Date().toISOString(),
            cloudStatus: 'pending'
          });
        }
        console.log(`[rehydrate] Registered ${added.length} folder-added file(s) into KB folder: ${added.join(', ')}`);
      }
    }

    // Save with conflict retry.
    let writeAttempts = 0;
    while (writeAttempts < 3) {
      writeAttempts += 1;
      try {
        await cloudant.saveDocument('maia_users', docToWrite);
        break;
      } catch (err) {
        if (err.statusCode === 409 && writeAttempts < 3) {
          const fresh = await cloudant.getDocument('maia_users', userId);
          if (fresh?._rev) docToWrite._rev = fresh._rev;
          continue;
        }
        throw err;
      }
    }

    // 2. Ensure agent exists in DO. If userDoc.assignedAgentId no longer
    // resolves, ensureUserAgent (called from auth.js's path) creates a
    // fresh one and updates the doc.
    let agentResolved = null;
    if (docToWrite.assignedAgentId) {
      try {
        agentResolved = await doClient.agent.get(docToWrite.assignedAgentId);
        rebuilt.agent = 'reused';
      } catch (e) {
        if (e?.status === 404 || e?.statusCode === 404 || /not[_ ]?found/i.test(e?.message || '')) {
          agentResolved = null; // fall through to recreate
        } else {
          errors.push(`agent.get: ${e.message || e}`);
        }
      }
    }
    if (!agentResolved) {
      try {
        const freshDoc = await cloudant.getDocument('maia_users', userId);
        const { ensureUserAgent } = await import('./routes/auth.js');
        const updated = await ensureUserAgent(doClient, cloudant, freshDoc);
        rebuilt.agent = 'created';
        if (updated?.assignedAgentId) docToWrite.assignedAgentId = updated.assignedAgentId;
      } catch (e) {
        errors.push(`ensureUserAgent: ${e.message || e}`);
      }
    }

    // Rebuild the SECONDARY "Private AI (Deepseek)" agent too if its backed-up
    // id no longer resolves (Destroy Cloud Account removed it). Its KB is
    // re-attached by the post-restore /api/chat/providers poll once the
    // KB exists. Best-effort — never fail the whole restore over it.
    try {
      const gptId = docToWrite.agentProfiles?.gpt?.agentId;
      let gptLive = false;
      if (gptId) {
        try { await doClient.agent.get(gptId); gptLive = true; } catch { gptLive = false; }
      }
      if (!gptLive) {
        const freshDoc = await cloudant.getDocument('maia_users', userId);
        const { ensureSecondaryAgent } = await import('./routes/auth.js');
        const updated = await ensureSecondaryAgent(doClient, cloudant, freshDoc);
        rebuilt.gptAgent = gptId ? 'recreated' : 'created';
        if (updated?.agentProfiles?.gpt) docToWrite.agentProfiles = updated.agentProfiles;
      } else {
        rebuilt.gptAgent = 'reused';
      }
    } catch (e) {
      errors.push(`ensureSecondaryAgent: ${e.message || e}`);
    }

    // Alternate KB-2: the backup may show KB-2 was connected to one or
    // more agents, but the DO KB itself was destroyed. The stale pointer
    // is dropped; if any saved per-agent connection had kb2, recreate
    // KB-2 (hierarchical, over KB-1's folder) and reattach it to those
    // agents. KB-1 reattachment is handled by the normal flow /
    // ensureSecondaryAgent. Best-effort — never fail the restore.
    try {
      const conns = (docToWrite.kbConnections && typeof docToWrite.kbConnections === 'object')
        ? docToWrite.kbConnections : {};
      const profilesWantingKb2 = Object.entries(conns)
        .filter(([, v]) => v && v.kb2 === true)
        .map(([pk]) => pk);
      // Stale KB-2 id from the backup points at a destroyed KB.
      if (docToWrite.kb2) docToWrite.kb2 = null;
      if (profilesWantingKb2.length > 0) {
        const kb2res = await ensureKb2(userId); // recreate over KB-1 folder
        if (kb2res?.kbId) {
          const freshDoc = await cloudant.getDocument('maia_users', userId);
          for (const pk of profilesWantingKb2) {
            const aId = resolveAgentIdForProfile(freshDoc, pk);
            if (!aId) continue;
            try {
              await doClient.agent.attachKB(aId, kb2res.kbId);
              await appendUserProvisioningEvent(userId, {
                event: 'kb-connection-changed',
                kbKey: 'kb2', kbName: kb2res.kbName,
                kbRole: 'alternate (hierarchical)',
                agentProfileKey: pk, action: 'connected'
              });
            } catch (attErr) {
              errors.push(`kb2 reattach ${pk}: ${attErr.message || attErr}`);
            }
          }
          rebuilt.kb2 = 'recreated';
        }
      }
    } catch (e) {
      errors.push(`kb2 restore: ${e.message || e}`);
    }

    // 3. Inspect Spaces against userDoc.files. For each entry whose
    // bucketKey isn't in Spaces, add it to missingFiles. The client
    // uploads each via POST /api/files/restore-bytes.
    const missingFiles = [];
    try {
      const { S3Client, HeadObjectCommand, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
      const bucketUrl = getSpacesBucketName();
      const bucketName = bucketUrl ? (bucketUrl.split('//')[1]?.split('.')[0] || 'maia') : null;
      if (bucketName) {
        const s3Client = new S3Client({
          endpoint: getSpacesEndpoint(),
          region: 'us-east-1',
          forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
          credentials: {
            accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
            secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
          }
        });
        for (const f of (docToWrite.files || [])) {
          if (!f.bucketKey || !f.fileName) continue;
          try {
            await s3Client.send(new HeadObjectCommand({ Bucket: bucketName, Key: f.bucketKey }));
          } catch (headErr) {
            if (headErr?.$metadata?.httpStatusCode === 404 || headErr?.name === 'NotFound') {
              missingFiles.push({ fileName: f.fileName, bucketKey: f.bucketKey });
            }
            // Other errors: leave it; client retry will surface them.
          }
        }
      }
    } catch (e) {
      errors.push(`spaces inspect: ${e.message || e}`);
    }

    // 4. KB will be reconciled after the client uploads any missing files
    // (calling POST /api/account/rehydrate a second time after the file
    // uploads completes, OR POST /api/update-knowledge-base). We don't
    // ensure KB here because triggering indexing with a partial file set
    // is worse than waiting one more round-trip.
    if (missingFiles.length === 0 && docToWrite.kbId) {
      try {
        await doClient.kb.get(docToWrite.kbId);
        rebuilt.kb = 'reused';
      } catch (e) {
        if (e?.status === 404 || e?.statusCode === 404) {
          // KB gone; rebuild on next pass when client may explicitly
          // request /api/update-knowledge-base. Mark for follow-up.
          rebuilt.kb = 'needs-rebuild';
        }
      }
    }

    res.json({
      success: true,
      rebuilt,
      missingFiles,
      folderDiff,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('[rehydrate] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Restore-only file upload. The rehydrate endpoint returns a list of
// missingFiles by bucketKey; the client streams each here. Unlike the
// general /api/files/upload, this writes to an explicit bucketKey
// (preserving what userDoc.files already says) and does NOT mutate the
// user doc — the entry already exists from the rehydrate step.
//
// multipart/form-data:
//   file=<bytes>
//   bucketKey=userId/kbName/filename.ext
app.post('/api/files/restore-bytes', restoreBytesUpload.single('file'), async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const { bucketKey } = req.body || {};
    if (typeof bucketKey !== 'string' || !bucketKey.startsWith(`${userId}/`)) {
      return res.status(400).json({ error: 'INVALID_BUCKET_KEY' });
    }
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const bucketUrl = getSpacesBucketName();
    if (!bucketUrl) return res.status(500).json({ error: 'BUCKET_NOT_CONFIGURED' });
    const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';
    const s3Client = new S3Client({
      endpoint: getSpacesEndpoint(),
      region: 'us-east-1',
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      credentials: {
        accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
      }
    });
    await s3Client.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: bucketKey,
      Body: req.file.buffer,
      ContentType: req.file.mimetype || 'application/octet-stream'
    }));
    console.log(`[restore-bytes] PUT ${bucketKey} (${req.file.size} bytes)`);

    // Apple Health detection — SINGLE SOURCE OF TRUTH.
    //
    // We have the actual PDF bytes right here, at the authoritative
    // moment. Detect Apple Health from content NOW and stamp
    // userDoc.files[].isAppleHealth, instead of relying on a fragile
    // post-restore client rebuild that re-derives it from a stale doc
    // snapshot. After this, every downstream consumer (Lists.vue,
    // rebuildAppleHealthCategories' fast path, the wizard badge) just
    // reads the flag — no re-detection, no ordering hazards.
    let isAppleHealth = false;
    try {
      const isPdf = /\.pdf$/i.test(bucketKey) ||
        (req.file.mimetype || '').toLowerCase().includes('pdf');
      if (isPdf) {
        const { extractPdfWithPages } = await import('./utils/pdf-parser.js');
        const parsed = await extractPdfWithPages(req.file.buffer);
        const firstPageText = String(parsed?.pages?.[0]?.text || '')
          .toLowerCase().replace(/\s+/g, ' ').trim();
        const AH_FOOTER = 'this summary displays certain health information made available to you by your healthcare provider and may not completely';
        if (firstPageText.includes(AH_FOOTER)) {
          isAppleHealth = true;
          // Persist the flag on the matching files[] entry (conflict-
          // tolerant; never fail the upload over this).
          for (let attempt = 0; attempt < 4; attempt++) {
            try {
              const doc = await cloudant.getDocument('maia_users', userId);
              if (!Array.isArray(doc.files)) break;
              const idx = doc.files.findIndex(f => f?.bucketKey === bucketKey);
              if (idx < 0) break;
              if (doc.files[idx].isAppleHealth === true) break;
              doc.files[idx].isAppleHealth = true;
              doc.updatedAt = new Date().toISOString();
              await cloudant.saveDocument('maia_users', doc);
              console.log(`[restore-bytes] Apple Health detected & flagged: ${bucketKey}`);
              break;
            } catch (saveErr) {
              if (saveErr?.statusCode === 409 && attempt < 3) continue;
              console.warn(`[restore-bytes] isAppleHealth flag save failed (non-fatal): ${saveErr?.message}`);
              break;
            }
          }
        }
      }
    } catch (ahErr) {
      console.warn(`[restore-bytes] Apple Health detection skipped (non-fatal): ${ahErr?.message}`);
    }

    res.json({ success: true, bucketKey, size: req.file.size, isAppleHealth });
  } catch (error) {
    console.error('[restore-bytes] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Server-side restore coordinator (see Documentation/Wizards.md section 9)
// Handles agent creation + KB indexing + metadata restore in a single call
// after the client has uploaded files.
app.post('/api/restore', async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ success: false, error: 'Authentication required' });

    const { currentMedications, patientSummary, agentInstructions, savedChats } = req.body;
    const results = { agent: null, kb: null, medications: false, summary: false, chats: 0, instructions: false, errors: [] };

    // 1. Create/sync agent (mutex-protected via ensureUserAgent)
    try {
      const userDoc = await cloudant.getDocument('maia_users', userId);
      if (!userDoc) throw new Error('User not found');
      const { ensureUserAgent } = await import('./routes/auth.js');
      const updatedDoc = await ensureUserAgent(doClient, cloudant, userDoc);
      results.agent = { agentId: updatedDoc?.assignedAgentId, agentName: updatedDoc?.assignedAgentName };
    } catch (err) {
      results.errors.push(`Agent: ${err.message}`);
    }

    // 2. Trigger KB indexing (files should already be uploaded and registered)
    try {
      const userDoc = await cloudant.getDocument('maia_users', userId);
      const kbName = getKBNameFromUserDoc(userDoc, userId);
      if (kbName) {
        const kbFolderPrefix = `${userId}/${kbName}/`;
        const filesInKB = (userDoc.files || []).filter(f => f.bucketKey?.startsWith(kbFolderPrefix));
        if (filesInKB.length > 0) {
          results.kb = { status: 'triggered', files: filesInKB.length };
          // KB indexing is handled asynchronously by update-knowledge-base — just signal it's ready
        }
      }
    } catch (err) {
      results.errors.push(`KB check: ${err.message}`);
    }

    // 3. Save medications
    if (currentMedications) {
      try {
        const userDoc = await cloudant.getDocument('maia_users', userId);
        if (userDoc) {
          userDoc.currentMedications = currentMedications;
          userDoc.updatedAt = new Date().toISOString();
          await cloudant.saveDocument('maia_users', userDoc);
          results.medications = true;
        }
      } catch (err) {
        results.errors.push(`Medications: ${err.message}`);
      }
    }

    // 4. Save patient summary
    if (patientSummary) {
      try {
        const userDoc = await cloudant.getDocument('maia_users', userId);
        if (userDoc) {
          userDoc.patientSummary = patientSummary;
          userDoc.updatedAt = new Date().toISOString();
          await cloudant.saveDocument('maia_users', userDoc);
          results.summary = true;
        }
      } catch (err) {
        results.errors.push(`Summary: ${err.message}`);
      }
    }

    // 5. Save chats — preserve original _id so /api/user-chats filter works
    // (filter expects _id starting with "${userId}-")
    if (savedChats?.chats?.length > 0) {
      console.log(`[RESTORE] Restoring ${savedChats.chats.length} saved chat(s) for ${userId}`);
      for (const chat of savedChats.chats) {
        try {
          // Strip _rev so CouchDB treats it as a new doc
          const { _rev, ...chatFields } = chat;
          // Ensure _id starts with userId prefix for user-chats filter
          let chatId = chat._id;
          if (!chatId || !chatId.startsWith(`${userId}-`)) {
            chatId = `${userId}-chat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          }
          const chatDoc = {
            ...chatFields,
            _id: chatId,
            updatedAt: new Date().toISOString()
          };
          await cloudant.saveDocument('maia_chats', chatDoc);
          results.chats++;
          console.log(`[RESTORE] Chat saved: ${chatId}`);
        } catch (chatErr) {
          console.warn(`[RESTORE] Chat save failed for ${chat._id || 'unknown'}:`, chatErr.message);
          results.errors.push(`Chat ${chat._id || 'unknown'}: ${chatErr.message}`);
        }
      }
    } else {
      console.log(`[RESTORE] No saved chats to restore (savedChats=${JSON.stringify(savedChats ? { hasChats: !!savedChats.chats, length: savedChats.chats?.length } : null)})`);
    }

    // 6. Save agent instructions (only if agent was created)
    if (agentInstructions && results.agent?.agentId) {
      try {
        const agentId = results.agent.agentId;
        await doClient.agent.update(agentId, { instruction: agentInstructions });
        results.instructions = true;
      } catch (err) {
        results.errors.push(`Instructions: ${err.message}`);
      }
    }

    // 7. Update restore metadata (wizard completion is now derived from data presence,
    // not from flags — having patientSummary + currentMedications + agent + KB = complete)
    try {
      const userDoc = await cloudant.getDocument('maia_users', userId);
      if (userDoc) {
        userDoc.workflowStage = 'patient_summary';
        userDoc.restoredAt = new Date().toISOString();
        userDoc.updatedAt = new Date().toISOString();
        await cloudant.saveDocument('maia_users', userDoc);
      }
    } catch (err) {
      results.errors.push(`Restore metadata: ${err.message}`);
    }

    res.json({ success: true, results });
  } catch (error) {
    console.error('[restore] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get customer balance from DigitalOcean
app.get('/api/billing/balance', async (_req, res) => {
  try {
    const token = process.env.DIGITALOCEAN_TOKEN;
    if (!token) {
      console.log('[DO] billing/balance: DIGITALOCEAN_TOKEN not set');
      return res.status(500).json({ error: 'DigitalOcean API token not configured' });
    }
    console.log(`[DO] billing/balance using token: ${maskToken(token)}`);
    const response = await fetch('https://api.digitalocean.com/v2/customers/my/balance', {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}`;
      const text = await response.text();
      if (text) {
        try {
          const errorPayload = JSON.parse(text);
          if (errorPayload?.message) {
            errorMessage = errorPayload.message;
          } else if (errorPayload?.error) {
            errorMessage = errorPayload.error;
          } else if (typeof errorPayload === 'string') {
            errorMessage = errorPayload;
          }
        } catch (_err) {
          errorMessage = text;
        }
      }
      // Self-diagnosing hint: the DO balance endpoint needs a token
      // with billing read scope. A rotated/expired or granular-scope
      // PAT works everywhere else but 401/403s here.
      let hint = null;
      if (response.status === 401) {
        hint = 'DIGITALOCEAN_TOKEN appears invalid or expired (rotated?). Update it in the App Platform env and redeploy.';
      } else if (response.status === 403) {
        hint = 'DIGITALOCEAN_TOKEN lacks billing read scope. Regenerate the PAT with billing access (or use a legacy full-access token).';
      }
      console.log(`[DO] billing/balance failed: HTTP ${response.status} — ${errorMessage}`);
      return res.status(response.status).json({ error: errorMessage, status: response.status, hint });
    }
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.log(`[DO] billing/balance threw: ${error.message}`);
    res.status(500).json({ error: error.message || 'Failed to fetch customer balance', status: 500, hint: null });
  }
});

// Wizard debug logging (client -> server terminal)
app.post('/api/wizard-log', (req, res) => {
  try {
    const userId = req.session?.userId || req.body?.userId || 'unknown';
    const event = req.body?.event || 'unknown_event';
    const details = req.body?.details || {};
    const timestamp = new Date().toISOString();
    console.log(`[WIZARD] ${timestamp} ${userId} ${event}`, details);
    // Step 4 (modal diet): modal open/choice events go into the user's
    // provisioning log so any flow report can be replayed from
    // maia-log.pdf — that was the whole point; console-only logging
    // reconstructed nothing.
    if (userId !== 'unknown' && String(event).startsWith('modal:')) {
      void appendUserProvisioningEvent(userId, { event, ...details }).catch(() => {});
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Provisioning log — append an event to the user's provisioningLog array
app.post('/api/provisioning-log', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return; // 403 already sent on mismatch

    const { event, ...extraFields } = req.body;
    if (!event) {
      return res.status(400).json({
        success: false,
        message: 'event is required',
        error: 'MISSING_REQUIRED_FIELDS'
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

    // Append the log entry with conflict-tolerant save. The userDoc is
    // under heavy concurrent mutation during Restore (the rehydrate
    // endpoint replaces the whole doc while restore events stream in),
    // so 409s are EXPECTED here, not exceptional. Re-read + re-apply on
    // every conflict, with backoff, up to a generous attempt count.
    const isConflict = (err) =>
      err?.statusCode === 409 ||
      err?.status === 409 ||
      err?.error === 'conflict' ||
      /conflict/i.test(err?.message || '');

    const entry = { ...extraFields, event, id: 0, time: new Date().toISOString() };
    let saved = false;
    let lastErr = null;
    const MAX_ATTEMPTS = 8;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !saved; attempt++) {
      try {
        // Always work from a fresh copy so the _rev is current.
        const fresh = attempt === 1 ? userDoc : await cloudant.getDocument('maia_users', userId);
        if (!fresh) break; // user deleted mid-restore — nothing to append to
        if (!Array.isArray(fresh.provisioningLog)) fresh.provisioningLog = [];
        entry.id = fresh.provisioningLog.reduce((m, e) => Math.max(m, e.id || 0), 0) + 1;
        fresh.provisioningLog.push(entry);
        fresh.updatedAt = new Date().toISOString();
        await cloudant.saveDocument('maia_users', fresh);
        saved = true;
      } catch (error) {
        lastErr = error;
        if (isConflict(error) && attempt < MAX_ATTEMPTS) {
          await new Promise(r => setTimeout(r, 80 * attempt)); // linear backoff
          continue;
        }
        break;
      }
    }

    if (!saved) {
      // A provisioning-log entry is non-essential telemetry. Never 500
      // the client over it — that just produces an alarming red console
      // line during Restore and the client buffers the event anyway.
      // Return 202 so the client's `resp.ok` is false → it buffers the
      // event locally (maia-log.pdf still shows it) without surfacing a
      // server error.
      console.warn(`⚠️ provisioning-log entry not persisted after ${MAX_ATTEMPTS} attempts (event=${event}): ${lastErr?.message || lastErr}`);
      // 200 (not 4xx/5xx) so the browser logs no error line. The body's
      // success:false tells the client to buffer the event locally.
      return res.status(200).json({ success: false, buffered: true, error: 'NOT_PERSISTED' });
    }

    // Fire-and-forget: send admin notification on setup-complete or test-completed
    if (event === 'setup-complete' || event === 'test-completed') {
      void sendNewUserNotification(userId);
    }

    res.json({ success: true, id: entry.id });
  } catch (error) {
    console.error('❌ Error saving provisioning log entry:', error);
    // Still don't 500 — non-essential telemetry. 200 + success:false so
    // the client buffers it instead of logging an Internal Server Error.
    res.status(200).json({
      success: false,
      buffered: true,
      message: `provisioning log not saved: ${error.message}`,
      error: 'SAVE_FAILED'
    });
  }
});

// Provisioning log — return the full log plus a derived currentState summary
app.get('/api/provisioning-log', async (req, res) => {
  try {
    const userId = req.query?.userId;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'userId query parameter is required',
        error: 'MISSING_USER_ID'
      });
    }

    let userDoc;
    try {
      userDoc = await cloudant.getDocument('maia_users', userId);
    } catch (err) {
      if (err.statusCode === 404) {
        return res.status(404).json({
          success: false,
          message: 'User not found',
          error: 'USER_NOT_FOUND'
        });
      }
      throw err;
    }

    if (!userDoc) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    const log = Array.isArray(userDoc.provisioningLog) ? userDoc.provisioningLog : [];

    // Find the last setup-started or restore-started event
    let startIdx = -1;
    for (let i = log.length - 1; i >= 0; i--) {
      if (log[i].event === 'setup-started' || log[i].event === 'restore-started') {
        startIdx = i;
        break;
      }
    }

    // Derive currentState from events after (and including) the start event
    const currentState = {
      method: null,
      inProgress: false,
      filesUploaded: 0,
      agentReady: false,
      kbIndexed: false,
      kbTokens: 0,
      medicationsDone: false,
      medicationsLines: 0,
      summaryDone: false,
      summaryLines: 0,
      chatCount: 0,
      instructionsDone: false,
      listsDone: false
    };

    if (startIdx >= 0) {
      const startEvent = log[startIdx];
      currentState.method = startEvent.event === 'setup-started' ? 'setup' : 'restore';
      currentState.inProgress = true; // assume in-progress until we find a complete event

      const slice = log.slice(startIdx);
      for (const entry of slice) {
        switch (entry.event) {
          case 'setup-complete':
          case 'restore-complete':
            currentState.inProgress = false;
            break;
          case 'files-uploaded':
            currentState.filesUploaded = entry.count || 0;
            break;
          case 'agent-deployed':
            currentState.agentReady = true;
            break;
          case 'kb-indexed':
            currentState.kbIndexed = true;
            currentState.kbTokens = entry.tokens || 0;
            break;
          case 'medications-saved':
          case 'medications-restored':
            currentState.medicationsDone = true;
            currentState.medicationsLines = entry.lines || 0;
            break;
          case 'summary-saved':
          case 'summary-restored':
            currentState.summaryDone = true;
            currentState.summaryLines = entry.lines || 0;
            break;
          case 'chats-restored':
            currentState.chatCount = entry.count || 0;
            break;
          case 'instructions-restored':
            currentState.instructionsDone = true;
            break;
          case 'lists-restored':
            currentState.listsDone = true;
            break;
        }
      }
    }

    res.json({ success: true, log, currentState });
  } catch (error) {
    console.error('❌ Error reading provisioning log:', error);
    res.status(500).json({
      success: false,
      message: `Failed to read provisioning log: ${error.message}`,
      error: 'READ_FAILED'
    });
  }
});

// Toggle KB connection to Agent endpoint (attach/detach)
// Persist the per-agent KB attachment state so Restore can reattach.
// userDoc.kbConnections = { [profileKey]: { kb1?: bool, kb2?: bool } }
async function recordKbConnection(userId, profileKey, kbKey, connected) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const doc = await cloudant.getDocument('maia_users', userId);
      if (!doc) return;
      if (!doc.kbConnections || typeof doc.kbConnections !== 'object') doc.kbConnections = {};
      const pk = profileKey || 'default';
      if (!doc.kbConnections[pk] || typeof doc.kbConnections[pk] !== 'object') doc.kbConnections[pk] = {};
      doc.kbConnections[pk][kbKey] = !!connected;
      doc.updatedAt = new Date().toISOString();
      await cloudant.saveDocument('maia_users', doc);
      return;
    } catch (e) {
      if (e?.statusCode === 409 && attempt < 2) continue;
      console.warn(`[kbConnections] could not persist ${kbKey}=${connected} for ${userId}: ${e?.message || e}`);
      return;
    }
  }
}

app.post('/api/toggle-kb-connection', async (req, res) => {
  try {
    // action: 'attach'|'detach'; kbKey: 'kb1' (primary/semantic, default)
    // | 'kb2' (alternate/hierarchical); agentProfileKey: 'default'|'gpt'
    const { userId, action, agentProfileKey } = req.body;
    const kbKey = req.body.kbKey === 'kb2' ? 'kb2' : 'kb1';
    const profileKey = agentProfileKey || 'default';

    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID is required', error: 'MISSING_USER_ID' });
    }
    if (!action || (action !== 'attach' && action !== 'detach')) {
      return res.status(400).json({ success: false, message: 'Action must be "attach" or "detach"', error: 'INVALID_ACTION' });
    }

    const userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc) {
      return res.status(404).json({ success: false, message: 'User not found', error: 'USER_NOT_FOUND' });
    }

    const targetAgentId = resolveAgentIdForProfile(userDoc, profileKey);
    if (!targetAgentId) {
      return res.status(400).json({ success: false, message: 'User has no assigned agent', error: 'NO_AGENT' });
    }

    // Resolve the KB id for the requested KB. KB-2 is created lazily on
    // its first attach (hierarchical, over KB-1's folder).
    let kbId = null;
    let kbName = null;
    let justCreatedKb2 = false;
    if (kbKey === 'kb1') {
      if (!userDoc.kbId) {
        return res.status(400).json({ success: false, message: 'User has no primary knowledge base', error: 'NO_KB' });
      }
      kbId = userDoc.kbId;
      kbName = getKBNameFromUserDoc(userDoc, userId);
    } else {
      if (action === 'attach') {
        const r = await ensureKb2(userId); // create or reuse
        if (r.error) {
          return res.status(400).json({ success: false, message: r.message || 'Could not create the alternate knowledge base', error: r.error });
        }
        kbId = r.kbId; kbName = r.kbName; justCreatedKb2 = !!r.created;
      } else {
        if (!userDoc.kb2?.kbId) {
          // Nothing to detach — treat as success (already disconnected).
          await recordKbConnection(userId, profileKey, 'kb2', false);
          return res.json({ success: true, connected: false, kbKey, agentProfileKey: profileKey, alreadyDetached: true });
        }
        kbId = userDoc.kb2.kbId; kbName = userDoc.kb2.kbName;
      }
    }

    const finish = async (connected, extra = {}) => {
      invalidateResourceCache(userId);
      await recordKbConnection(userId, profileKey, kbKey, connected);
      await appendUserProvisioningEvent(userId, {
        event: 'kb-connection-changed',
        kbKey,
        kbName,
        kbRole: kbKey === 'kb1' ? 'primary (semantic)' : 'alternate (hierarchical)',
        agentProfileKey: profileKey,
        action: connected ? 'connected' : 'disconnected'
      });
      // When KB-2 is freshly created, DO auto-starts an indexing job
      // over KB-1's folder. Surface its job id so the client can show
      // progress in the Saved Files panel (no /api/update-knowledge-base
      // call, so the per-file badges are NOT touched).
      let indexJobId = null;
      if (kbKey === 'kb2' && connected && justCreatedKb2 && kbId) {
        try {
          const jobs = await doClient.indexing.listForKB(kbId);
          const latest = Array.isArray(jobs) && jobs.length > 0 ? jobs[0] : null;
          indexJobId = latest?.uuid || latest?.id || latest?.indexing_job_uuid || null;
        } catch (e) {
          console.warn(`[KB-2] could not list indexing jobs for ${kbId}: ${e?.message || e}`);
        }
      }
      res.json({ success: true, connected, kbKey, kbId, kbName, agentId: targetAgentId, agentProfileKey: profileKey, indexing: justCreatedKb2, indexJobId, ...extra });
    };

    try {
      if (action === 'attach') {
        await doClient.agent.attachKB(targetAgentId, kbId);
        console.log(`✅ Attached ${kbKey} (${kbId}) to agent ${targetAgentId} (profile ${profileKey})`);
        await finish(true);
      } else {
        await doClient.agent.detachKB(targetAgentId, kbId);
        console.log(`✅ Detached ${kbKey} (${kbId}) from agent ${targetAgentId} (profile ${profileKey})`);
        await finish(false);
      }
    } catch (error) {
      const msg = error?.message || '';
      if ((msg.includes('already') || msg.includes('409')) && action === 'attach') {
        await finish(true, { alreadyAttached: true });
      } else if (msg.includes('404') && action === 'detach') {
        await finish(false, { alreadyDetached: true });
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error('Error toggling KB connection:', error);
    res.status(500).json({
      success: false,
      message: `Failed to ${req.body.action || 'toggle'} KB connection: ${error.message}`,
      error: error.message
    });
  }
});

// Attach KB to Agent endpoint (kept for backward compatibility)
app.post('/api/attach-kb-to-agent', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }

    // Get user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    if (!userDoc.assignedAgentId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User has no assigned agent',
        error: 'NO_AGENT'
      });
    }

    if (!userDoc.kbId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User has no knowledge base',
        error: 'NO_KB'
      });
    }

    try {
      // Attach KB to agent
      await doClient.agent.attachKB(userDoc.assignedAgentId, userDoc.kbId);
      console.log(`✅ Attached KB ${userDoc.kbId} to agent ${userDoc.assignedAgentId}`);
      // Ensure the agent actually retrieves from its KB (heal legacy NONE).
      await ensureAgentRetrieval(userDoc.assignedAgentId);

      res.json({
        success: true, 
        message: 'Knowledge base attached to agent successfully',
        agentId: userDoc.assignedAgentId,
        kbId: userDoc.kbId
      });
    } catch (error) {
      console.error('❌ Error attaching KB to agent:', error);
      // Check if KB is already attached (might return 409 or similar)
      if (error.message && (error.message.includes('already') || error.message.includes('409'))) {
        console.log('ℹ️ KB already attached to agent');
        res.json({ 
          success: true, 
          message: 'Knowledge base is already attached to agent',
          agentId: userDoc.assignedAgentId,
          kbId: userDoc.kbId,
          alreadyAttached: true
        });
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error('Error attaching KB to agent:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to attach KB to agent: ${error.message}`,
      error: error.message 
    });
  }
});

// Reset KB endpoint - clears all KB-related fields except kbName
app.post('/api/reset-kb', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }

    // Get user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    // Clear all KB-related fields except kbName (which is permanent)
    userDoc.kbId = null;
    userDoc.connectedKBs = [];
    userDoc.connectedKB = null; // Legacy field
    userDoc.kbIndexingStartedAt = null;
    userDoc.kbCreatedAt = null;
    userDoc.kbLastIndexedAt = null;

    // Save updated user document
    await cloudant.saveDocument('maia_users', userDoc);

    console.log(`✅ Reset KB for user ${userId} (kbName preserved: ${userDoc.kbName || 'none'})`);

    res.json({ 
      success: true, 
      message: 'Knowledge base reset successfully',
      kbName: userDoc.kbName || null
    });
  } catch (error) {
    console.error('Error resetting KB:', error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to reset KB: ${error.message}`,
      error: error.message 
    });
  }
});

// Generate Patient Summary endpoint
/**
 * Post-process a Patient Summary draft from the LLM: replace any raw-
 * filename citations `[<fileName> p.<page>]` with `[File N p.<page>]`
 * using the same PDF-only, References-excluded ordering that the
 * client renderer uses to resolve File N back to a real file. This is
 * deterministic and runs regardless of whether the LLM followed the
 * legend-tag instruction in the prompt — necessary because LLMs (esp.
 * GPT-OSS-120B) sometimes ignore the citation-format rule and spell
 * the filename out verbatim, which renders unreadably for long Epic-
 * export filenames and breaks the client's File-N click resolver.
 *
 * Matches both square `[]` and CJK 【】 brackets — Deepseek emits the
 * latter occasionally. Whitespace around the page word is tolerant.
 */
function rewriteCitationsToFileLegend(text, userDoc, userId) {
  if (!text || typeof text !== 'string') return text;
  const referencesPrefix = `${userId}/References/`;
  const pdfs = (Array.isArray(userDoc?.files) ? userDoc.files : [])
    .filter(f => f && f.fileName && /\.pdf$/i.test(f.fileName))
    .filter(f => !(f.bucketKey || '').startsWith(referencesPrefix))
    .filter(f => f.isReference !== true);
  if (pdfs.length === 0) return text;

  // The KB indexes files under their SANITIZED bucket-key name (per
  // /api/files/upload: replace(/[^a-zA-Z0-9.-]/g, '_')), so the LLM
  // cites the cleaned form (e.g. `__Margaret__`) even when the
  // userDoc display name preserves the original spaces (`_ Margaret _`).
  // We therefore try BOTH forms when rewriting.
  const sanitize = (s) => String(s || '').replace(/[^a-zA-Z0-9.-]/g, '_');

  // Build longest-first so a filename that's a prefix of another
  // (e.g. `A.PDF` vs `A.PDF-extra.PDF`) doesn't get matched as the
  // shorter one inside a longer citation. Include both display and
  // sanitized variants per file; dedupe identical strings.
  const candidates = [];
  pdfs.forEach((f, i) => {
    const display = f.fileName;
    const clean = sanitize(display);
    candidates.push({ idx: i, name: display });
    if (clean !== display) candidates.push({ idx: i, name: clean });
  });
  const ordered = candidates.sort((a, b) => b.name.length - a.name.length);

  let out = text;
  for (const { idx, name } of ordered) {
    const escName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Either [<filename> p.<page>] or 【<filename> p.<page>】 .
    // Allow Page / page / p. between filename and number.
    const re = new RegExp(
      `[\\[\\u3010]\\s*${escName}\\s+(?:Page|page|p\\.?)\\s*(\\d+)\\s*[\\]\\u3011]`,
      'gi'
    );
    out = out.replace(re, (_full, page) => `[File ${idx + 1} p.${page}]`);
  }
  return out;
}

app.post('/api/generate-patient-summary', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }

    // Get user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    if (!userDoc.assignedAgentId || !userDoc.agentEndpoint) {
      return res.status(400).json({ 
        success: false, 
        message: 'User agent is not properly configured',
        error: 'AGENT_NOT_CONFIGURED'
      });
    }

    if (!userDoc.agentApiKey) {
      try {
        const apiKey = await getOrCreateAgentApiKey(doClient, cloudant, userId, userDoc.assignedAgentId);
        userDoc.agentApiKey = apiKey;
      } catch (error) {
        return res.status(500).json({
          success: false,
          message: 'Unable to prepare agent API key',
          error: 'AGENT_API_KEY_MISSING'
        });
      }
    }

    // Ensure KB is attached to agent before generating summary.
    // Without an attached KB the agent has no patient documents and returns a stub.
    if (userDoc.kbId && userDoc.assignedAgentId) {
      try {
        await doClient.agent.attachKB(userDoc.assignedAgentId, userDoc.kbId);
        console.log(`[SUMMARY] ✅ Confirmed KB ${userDoc.kbId} attached to agent ${userDoc.assignedAgentId}`);
      } catch (attachError) {
        // "already attached" is fine — any other error is a real problem
        if (attachError.message && attachError.message.includes('already')) {
          // Already attached — good
        } else {
          console.error(`[SUMMARY] ❌ Failed to attach KB before summary generation:`, attachError.message);
          return res.status(503).json({
            success: false,
            message: 'Knowledge base is not yet available. Please try again shortly.',
            error: 'KB_NOT_ATTACHED'
          });
        }
      }
    } else if (!userDoc.kbId) {
      console.warn(`[SUMMARY] ⚠️ No KB found for user ${userId} — summary will lack patient context`);
    }

    // Use the agent to generate a patient summary
    // We'll use the DigitalOcean provider directly to call the agent
    const { DigitalOceanProvider } = await import('../lib/chat-client/providers/digitalocean.js');
    const agentProvider = new DigitalOceanProvider(userDoc.agentApiKey, {
      baseURL: userDoc.agentEndpoint
    });

    // Use the shared Patient Summary prompt builder so the manual "Request
    // New Summary" produces the same structured output as the wizard draft
    // (Layer-2 spec + verified currentMedications + past-12mo encounters
    // context). Replaces the old stub "Please generate a patient summary."
    // that returned near-empty output once the system prompt was trimmed.
    const summaryPrompt = await buildPatientSummaryPromptForUser(userId, userDoc);

    try {
      // chat() method signature: chat(messages, options, onUpdate)
      const chatMessages = [{ role: 'user', content: summaryPrompt }];
      const chatOptions = { model: userDoc.agentModelName || 'openai-gpt-oss-120b', stream: false };

      let summaryResponse;
      try {
        summaryResponse = await agentProvider.chat(chatMessages, chatOptions);
      } catch (firstError) {
        const statusCode = firstError.status || firstError.statusCode || 0;
        if (statusCode === 401 && userDoc.assignedAgentId) {
          // Agent API key is stale — recreate and retry once
          console.warn(`⚠️ [SUMMARY] 401 from agent for ${userId}, recreating API key...`);
          const { recreateAgentApiKey } = await import('./utils/agent-helper.js');
          const newApiKey = await recreateAgentApiKey(doClient, cloudant, userId, userDoc.assignedAgentId);
          console.log(`✅ [SUMMARY] Recreated API key for agent ${userDoc.assignedAgentId}`);
          const retryProvider = new DigitalOceanProvider(newApiKey, { baseURL: userDoc.agentEndpoint });
          summaryResponse = await retryProvider.chat(chatMessages, chatOptions);
        } else if (statusCode >= 500 && statusCode < 600) {
          // DO GenAI 5xx is usually transient (overloaded backend,
          // brief availability blip). Retry once after a short
          // delay before giving up. Without this, the user sees
          // "Failed to generate patient summary" and has to click
          // Retry themselves — but the error is almost always
          // gone by then.
          console.warn(`⚠️ [SUMMARY] ${statusCode} from agent for ${userId}, retrying once after 2s...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          try {
            summaryResponse = await agentProvider.chat(chatMessages, chatOptions);
            console.log(`✅ [SUMMARY] Retry succeeded for ${userId}`);
          } catch (retryError) {
            console.warn(`❌ [SUMMARY] Retry ALSO failed for ${userId}:`, retryError.message || retryError);
            throw retryError;
          }
        } else {
          throw firstError;
        }
      }

      let summary = summaryResponse.content || summaryResponse.text || '';

      if (!summary || summary.trim().length === 0) {
        throw new Error('Empty summary received from agent');
      }

      // Rewrite any raw-filename citations the LLM produced into the
      // File N legend-tag form. LLMs (especially GPT-OSS-120B) often
      // ignore the prompt's "use [File N p.<page>] only" instruction
      // for sections like Radiology and Social History, leaving the
      // unreadable Epic-export filename verbatim. This deterministic
      // pass guarantees consistent output regardless of compliance.
      summary = rewriteCitationsToFileLegend(summary, userDoc, userId);

      // Re-fetch user document to get latest revision (may have been updated by background polling)
      // Retry up to 3 times to handle document conflicts
      let saved = false;
      let retries = 0;
      const maxRetries = 3;
      
      // Get current summary for undo (don't save yet - frontend will choose replace strategy)
      let savedCurrentSummary = null;
      try {
        const freshUserDoc = await cloudant.getDocument('maia_users', userId);
        if (freshUserDoc) {
          const summaries = initializeSummariesArray(freshUserDoc);
          savedCurrentSummary = summaries.length > 0 ? summaries[summaries.length - 1] : null;
        }
      } catch (err) {
        console.warn('Failed to get current summary for undo:', err);
      }
      
      // Store for response
      res.locals.savedCurrentSummary = savedCurrentSummary;
      saved = true; // Mark as "saved" (actually just prepared, frontend will save)

      // Get current summaries array (before saving new one)
      const finalUserDoc = await cloudant.getDocument('maia_users', userId);
      const summaries = initializeSummariesArray(finalUserDoc);
      
      res.json({ 
        success: true, 
        summary,
        message: 'Patient summary generated successfully',
        summaries: summaries.map((s, index) => ({
          text: s.text,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          isCurrent: index === summaries.length - 1
        })),
        savedCurrentSummary: res.locals.savedCurrentSummary || null
      });
    } catch (error) {
      console.error('❌ Error generating patient summary:', error);
      throw error;
    }
  } catch (error) {
    console.error('Error generating patient summary:', error);
    res.status(500).json({ 
      success: false,
      message: `Failed to generate patient summary: ${error.message}`,
      error: error.message
    });
  }
});

/**
 * Build the per-request Patient Summary prompt for a user. Single source
 * of truth used by EVERY summary endpoint (the wizard draft, the manual
 * "Request New Summary", and the dual-AI generate-pair). Substitutes the
 * Layer-2 `patient-summary.draft` prompt with:
 *   {currentMedications} — the verified meds block (authoritative), or ''
 *   {encounters}         — past-12-month deterministic encounters list, or ''
 * Returns the substituted prompt string. Falls back to a minimal default
 * if Layer 2 is missing/broken.
 */
/**
 * Extract Apple Health "Out of Range" lab observations from the structured
 * pdfjs markdown of an AH PDF (produced by extractPdfWithPages — pdf-parse
 * does NOT preserve the red-text "OUT OF RANGE" annotation that AH uses).
 * The Lab Results section is page-segmented (`## Page N`) and dated lines
 * like "Apr 8, 2026   Mass General Brigham" head each lab visit; abnormal
 * results are individual lines ending with "OUT   OF   RANG" (multi-space).
 * Returns [{ isoDate, page, line }] in document order.
 */
function extractAppleHealthOorLabs(fullMarkdown) {
  const out = [];
  const lines = String(fullMarkdown || '').split('\n');
  let currentPage = 1;
  let currentIso = '';
  let inLab = false;
  // Walk the WHOLE document. `## Page N` markers can appear BEFORE the
  // `### Lab Results` heading on the page where the section starts, so
  // tracking page+section across the full document is more reliable than
  // starting at the heading.
  for (let i = 0; i < lines.length; i++) {
    const t = (lines[i] || '').trim();
    const pg = t.match(/^##\s*Page\s+(\d+)/i);
    if (pg) { currentPage = parseInt(pg[1], 10); continue; }
    if (/^#{3,4}\s*Lab Results\b/i.test(t)) { inLab = true; continue; }
    // A sibling `###`-level heading ends the Lab Results section.
    if (inLab && /^#{3,4}\s+/.test(t) && !/^#{3,4}\s*Lab Results/i.test(t)) {
      inLab = false;
      continue;
    }
    if (!inLab) continue;
    const d = t.match(/^([A-Z][a-z]{2,8}\.?\s+\d{1,2},\s+\d{4})\b/);
    if (d) {
      const iso = toIsoDateMonthName(d[1]);
      if (iso) currentIso = iso;
      continue;
    }
    if (/OUT\s+OF\s+RANG/i.test(t)) {
      // Strip the trailing "OUT OF RANG[E]?" marker (the final E is often
      // dropped in the pdfjs text extraction) so the cleaned line shows just
      // the observation.
      const clean = t.replace(/\s+/g, ' ').replace(/\s*OUT\s+OF\s+RANG[A-Z]*\s*$/i, '').trim();
      out.push({ isoDate: currentIso, page: currentPage, line: clean });
    }
  }
  return out;
}

/** Lightweight "Mon D, YYYY" → YYYY-MM-DD parser (avoids importing). */
function toIsoDateMonthName(s) {
  const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
  const m = String(s || '').match(/^([A-Za-z]{3,})\.?\s+(\d{1,2}),\s+(\d{4})$/);
  if (!m) return '';
  const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (!mo) return '';
  return `${m[3]}-${String(mo).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
}

/** Substitute `{name}` placeholders. Unknown names pass through unchanged. */
function substitutePromptPlaceholders(body, vars) {
  return String(body || '').replace(/\{([A-Za-z0-9_]+)\}/g, (_, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name] ?? '') : `{${name}}`);
}

// Splice a verified Current Medications list into an existing
// Patient Summary text — no AI call. Ported from
// MyStuffDialog.replaceMedicationsInSummary so /api/patient-summary
// can return a PS whose Current Medications section is always in
// sync with `userDoc.currentMedications`, even if the PS was
// generated before the meds were verified. Idempotent: if the
// section is already in sync, returns the original string unchanged.
function serverReplaceMedicationsInSummary(summaryText, newMedsText, markVerified = false) {
  if (!summaryText) return summaryText;
  const lines = summaryText.split('\n');
  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].toLowerCase().replace(/[#*_`]/g, '').trim();
    if (stripped.startsWith('current medications')) {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx < 0) {
    if (!newMedsText || !newMedsText.trim()) return summaryText;
    return `${summaryText.trimEnd()}\n\n## Current Medications${markVerified ? ' (Patient Verified)' : ''}\n\n${newMedsText}\n`;
  }
  if (!newMedsText || !newMedsText.trim()) {
    return summaryText;
  }
  const startIdx = headingIdx + 1;
  let endIdx = lines.length;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.match(/^#{1,3}\s+/) || (line.match(/^\*{2}.+\*{2}$/) && !line.toLowerCase().includes('medication'))) {
      endIdx = i;
      break;
    }
  }
  let heading = lines[headingIdx];
  heading = heading.replace(/\s*\((?:patient[\s-]?(?:verified|confirmed))\)\s*/gi, '').replace(/\s+$/, '');
  if (markVerified) heading = `${heading} (Patient Verified)`;
  const before = lines.slice(0, headingIdx);
  const after = lines.slice(endIdx);
  return [...before, heading, '', newMedsText, '', ...after].join('\n').trim();
}

async function buildPatientSummaryPromptForUser(userId, userDoc, profileKey = 'default') {
  const verifiedMeds = String(userDoc?.currentMedications || '').trim();
  console.log(`[buildPatientSummaryPromptForUser] userId=${userId} profileKey=${profileKey} verifiedMedsPresent=${verifiedMeds.length > 0} verifiedMedsLen=${verifiedMeds.length} snippet="${verifiedMeds.slice(0, 200)}"`);
  const currentMedications = verifiedMeds
    ? `**Authoritative Current Medications (verified by the patient):**\n${verifiedMeds}\n\nUse this list AS-IS for the "Current Medications" section above — do NOT replace it with anything from the knowledge base.`
    : '';

  // Patient identity (name / DOB / age / sex) — deterministic from the
  // PDF header (Apple Health "Date of birth: …" / Epic "DOB: …, Legal
  // Sex: …"). Also: locate the Apple Health PDF so the {outOfRangeLabs}
  // builder below can run pdfjs on it (pdf-parse misses the red-text
  // "OUT OF RANGE" annotation; pdfjs preserves it).
  let patientIdentity = '';
  let ahBuf = null;
  let hasAppleHealth = false;
  try {
    const { parsePatientIdentityFromText, renderPatientIdentityBlock } = await import('./utils/patient-identity.js');
    const pdfParse = (await import('pdf-parse')).default;
    const kbNamePI = getKBNameFromUserDoc(userDoc, userId);
    const kbPrefixPI = kbNamePI ? `${userId}/${kbNamePI}/` : null;
    const pdfFilesPI = (userDoc?.files || []).filter(f =>
      f?.fileName && (!kbPrefixPI || (f.bucketKey || '').startsWith(kbPrefixPI)) &&
      (/\.pdf$/i.test(f.fileName) || /pdf/i.test(f.fileType || ''))
    );
    hasAppleHealth = pdfFilesPI.some(f => f.isAppleHealth);
    pdfFilesPI.sort((a, b) => (b.isAppleHealth ? 1 : 0) - (a.isAppleHealth ? 1 : 0));
    let id = null;
    for (const f of pdfFilesPI) {
      if (!f.bucketKey) continue;
      const buf = await readSpacesObjectBuffer(f.bucketKey);
      if (!buf) continue;
      try {
        const data = await pdfParse(buf);
        if (f.isAppleHealth && !ahBuf) ahBuf = buf;
        if (!id) {
          const parsed = parsePatientIdentityFromText(data.text);
          if (parsed && (parsed.dobIso || parsed.name || parsed.sex)) id = parsed;
        }
        if (id && (ahBuf || !hasAppleHealth)) break;
      } catch { /* try next file */ }
    }
    // Filename enrichment: the AH header now often gives only a
    // first name (e.g. "Margarita") and Epic image PDFs return
    // blank text. The Epic file*names* almost always carry
    // LASTNAME_FIRSTNAME_… so we mine that to recover the
    // surname. Header data wins where it's already complete.
    try {
      const { extractNameFromFilenames, mergeIdentityWithFilenamePair, renderPatientIdentityBlock: rerender } = await import('./utils/patient-identity.js');
      const pair = extractNameFromFilenames(pdfFilesPI.map(f => f.fileName));
      if (pair && pair.last) {
        const merged = mergeIdentityWithFilenamePair(id || {}, pair);
        if (merged?.name) {
          id = { ...(id || {}), ...merged };
        }
      }
      patientIdentity = rerender(id);
    } catch (mErr) {
      console.warn(`[patient-summary] filename enrichment failed: ${mErr?.message || mErr}`);
      patientIdentity = renderPatientIdentityBlock(id);
    }
  } catch (e) {
    console.warn(`[patient-summary] identity extraction failed: ${e?.message || e}`);
  }

  // FAIL LOUDLY when identity extraction returned nothing for every
  // file in the KB. Silent degradation is what produced the sierra08
  // bug — when {patientIdentity} is empty the LLM falls back to RAG
  // and may pick up a spouse / contact name as the patient. Inject a
  // STRICT instruction telling the agent not to guess, AND log a red
  // event to maia-log so the user sees the failure on the next
  // setup-log regeneration.
  if (!patientIdentity || !patientIdentity.trim()) {
    patientIdentity =
      '**Patient identity could not be parsed deterministically from the PDF headers.**\n\n' +
      'Use the literal string "Patient name not parseable from records" as the first line of the summary. ' +
      'DO NOT GUESS A NAME by extracting one from the knowledge base — emergency-contact, spouse, next-of-kin, ' +
      'physician, referring-provider, and witness fields all contain person names that are NOT the patient. ' +
      'It is better to say the name is missing than to confidently use the wrong one.';
    try {
      await appendUserProvisioningEvent(userId, {
        event: 'patient-identity-extraction-failed',
        context: 'patient-summary-build',
        reason: 'No file in the KB yielded a parseable Name / DOB / Sex. Check the source PDFs.'
      });
    } catch { /* non-fatal */ }
  }

  // Out-of-Range Labs:
  //   • With an Apple Health PDF — run pdfjs (extractPdfWithPages) to get
  //     the structured markdown that preserves the "OUT OF RANGE" annotation
  //     (pdf-parse drops it). Build a clean per-lab list with date + page
  //     and inject it AUTHORITATIVELY for the Out of Range Labs section.
  //   • Without an AH PDF — emit a fixed instruction telling the agent to
  //     write the standing "Ask the Private AI for lists or graphs of
  //     specific lab results." note.
  let outOfRangeLabs = '';
  if (ahBuf) {
    try {
      const { extractPdfWithPages } = await import('./utils/pdf-parser.js');
      const result = await extractPdfWithPages(ahBuf);
      const fullMarkdown = (result?.pages || [])
        .map(p => `## Page ${p.page}\n\n${p.markdown}`)
        .join('\n\n---\n\n');
      const oors = extractAppleHealthOorLabs(fullMarkdown);
      if (oors.length > 0) {
        const lines = oors.map(o =>
          `- ${o.isoDate || '(undated)'} (p.${o.page}): ${o.line} [OUT OF RANGE]`
        ).join('\n');
        outOfRangeLabs = `**Authoritative Out-of-Range Labs (from Apple Health):**\n${lines}\n\nUse these AS-IS for the "Out of Range Labs" section above (drop the bracketed "[OUT OF RANGE]" flag and the leading dash if you reformat — the data is authoritative). If empty, write exactly: "No out-of-range labs in the provided records."`;
      } else {
        outOfRangeLabs = `**For the "Out of Range Labs" section above**, write exactly: "No out-of-range labs in the provided records."`;
      }
    } catch (e) {
      console.warn(`[patient-summary] OOR extraction failed: ${e?.message || e}`);
    }
  } else if (!hasAppleHealth) {
    // Without an Apple Health PDF we can't extract OOR labs
    // authoritatively for the Patient Summary inline — the AH PDF
    // markdown preserves "[OUT OF RANGE]" flags that Epic exports
    // don't. Point the user to the deterministic Epic OOR scanner in
    // My Lists, which they can run on demand.
    outOfRangeLabs = `**For the "Out of Range Labs" section above**, write exactly this and nothing more: "Out-of-range labs work best when an Apple Health file is available. Open My Lists → Out of Range Labs to run a deterministic scan over the patient's non-Apple-Health PDFs."`;
  }

  // Encounters context: extract deterministically from PDFs and keep the
  // past 12 months so the agent has authoritative dated visits for the
  // "Recent Visits (past 12 months)" section.
  let encounters = '';
  try {
    const { extractEncountersFromText, parseAppleHealthClinicalNotes } = await import('./utils/encounters-extractor.js');
    const pdfParse = (await import('pdf-parse')).default;
    const kbName = getKBNameFromUserDoc(userDoc, userId);
    const kbPrefix = kbName ? `${userId}/${kbName}/` : null;
    const pdfFiles = (userDoc?.files || []).filter(f =>
      f?.fileName && (!kbPrefix || (f.bucketKey || '').startsWith(kbPrefix)) &&
      (/\.pdf$/i.test(f.fileName) || /pdf/i.test(f.fileType || ''))
    );
    const collected = [];
    for (let i = 0; i < pdfFiles.length; i++) {
      const f = pdfFiles[i];
      if (!f.bucketKey) continue;
      // Apple Health: prefer Clinical Notes sidecar (it IS the encounters).
      if (f.isAppleHealth) {
        const cn = await readSpacesTextObject(`${userId}/Lists/clinical_notes.md`);
        if (cn) {
          const enc = parseAppleHealthClinicalNotes(cn, `File ${i + 1}`);
          if (enc.length > 0) { collected.push(...enc); continue; }
        }
      }
      const buf = await readSpacesObjectBuffer(f.bucketKey);
      if (!buf) continue;
      try {
        const data = await pdfParse(buf);
        const { encounters: enc } = extractEncountersFromText(data.text, data.numpages, `File ${i + 1}`);
        collected.push(...enc);
      } catch { /* per-file best-effort */ }
    }
    const cutoff12 = new Date(); cutoff12.setMonth(cutoff12.getMonth() - 12);
    const cutoff12Iso = cutoff12.toISOString().slice(0, 10);
    const seen = new Map();
    for (const e of collected) {
      if (!e.isoDate || e.isoDate < cutoff12Iso) continue;
      const key = `${e.isoDate}|${(e.description || '').toLowerCase()}`;
      if (!seen.has(key)) seen.set(key, e);
    }
    const recent = [...seen.values()].sort((a, b) => (a.isoDate < b.isoDate ? 1 : a.isoDate > b.isoDate ? -1 : 0));
    if (recent.length > 0) {
      const lines = recent.map(e => `- ${e.isoDate} (${e.type || 'Visit'}) — ${e.description || ''}`).join('\n');
      encounters = `**Recent encounters (past 12 months, reverse-chronological)** — extracted deterministically from this patient's records. Use these for the "Recent Visits (past 12 months)" section above and do NOT re-extract visits from the knowledge base for that section:\n${lines}`;
    }
  } catch (e) {
    console.warn(`[patient-summary] encounters context build failed: ${e?.message || e}`);
  }

  // Allergies context: Apple Health's `allergies.md` is the authoritative
  // structured list. If present, inject it so the agent uses it AS-IS for
  // the Allergies section.
  //
  // Race-resistant fallback: during Setup, the PS draft is fired
  // immediately after KB indexing completes, but the Lists/*.md sidecars
  // (built by the Apple Health category-split pipeline) may not be
  // written yet. If allergies.md is missing AND we already have the AH
  // PDF markdown loaded in memory (`ahBuf`, used above for OOR labs),
  // extract the "### Allergies" section inline so the placeholder is
  // never empty just because the sidecar was racing.
  let allergies = '';
  try {
    let allergiesMd = await readSpacesTextObject(`${userId}/Lists/allergies.md`);
    if ((!allergiesMd || !allergiesMd.trim()) && ahBuf) {
      try {
        const { extractPdfWithPages } = await import('./utils/pdf-parser.js');
        const { extractAllergiesFromAppleHealthMarkdown } = await import('./utils/ah-section-extract.js');
        const result = await extractPdfWithPages(ahBuf);
        const fullMd = (result?.pages || []).map(p => p.markdown).join('\n\n');
        const section = extractAllergiesFromAppleHealthMarkdown(fullMd);
        if (section && section.trim()) allergiesMd = section;
      } catch (e) {
        console.warn(`[patient-summary] inline AH allergies fallback failed: ${e?.message || e}`);
      }
    }
    if (allergiesMd && allergiesMd.trim()) {
      allergies = `**Authoritative Allergies (from Apple Health):**\n${allergiesMd.trim()}\n\nUse this for the "Allergies" section above — do NOT replace it with anything from the knowledge base.`;
    }
  } catch { /* no AH allergies — agent extracts from KB */ }

  // Medical History / Social History / Radiology blocks: all extracted
  // deterministically from the AH PDF's category sections. Previously
  // these were RAG-only sections — and the agent reliably under-retrieved
  // even when the source data was clearly indexed. Injecting them as
  // authoritative blocks matches the Allergies / Encounters / OOR Labs
  // pattern. We pull the AH markdown ONCE and reuse it for all three.
  // When no AH PDF is present, each placeholder is empty and the 3-tier
  // spec falls through to KB-RAG → "Not documented" as a last resort.
  let medicalHistory = '';
  let socialHistory = '';
  let globalCitationContract = '';
  let radiology = '';
  if (ahBuf) {
    try {
      const { extractPdfWithPages } = await import('./utils/pdf-parser.js');
      const {
        extractMedicalHistoryFromAppleHealthMarkdown,
        extractSocialHistoryFromAppleHealthMarkdown,
        extractRadiologyFromAppleHealthMarkdown
      } = await import('./utils/ah-section-extract.js');
      const result = await extractPdfWithPages(ahBuf);
      const fullMd = (result?.pages || []).map(p => p.markdown).join('\n\n');

      const mhBlock = extractMedicalHistoryFromAppleHealthMarkdown(fullMd);
      if (mhBlock && mhBlock.trim()) {
        medicalHistory = `**Authoritative Medical History (from Apple Health categories):**\n${mhBlock.trim()}\n\nUse this for the "Medical History" section above — synthesize it into a concise narrative (don't just bullet-dump). Surgical history belongs here too; include relevant items from the Procedures block. Do NOT replace these with anything from the knowledge base.`;
      }

      const shBlock = extractSocialHistoryFromAppleHealthMarkdown(fullMd);
      if (shBlock && shBlock.trim()) {
        socialHistory = `**Authoritative Social History (from Apple Health):**\n${shBlock.trim()}\n\nUse this for the "Social History" section above — summarize tobacco / alcohol / drug use, employment / school, living situation. Do NOT replace it with anything from the knowledge base.`;
      }

      const radBlock = extractRadiologyFromAppleHealthMarkdown(fullMd);
      if (radBlock && radBlock.trim()) {
        radiology = `**Authoritative Radiology / Imaging (from Apple Health):**\n${radBlock.trim()}\n\nUse this for the "Radiology" section above — give a brief reverse-chronological list of imaging studies (modality, body part, date, conclusion if available). Do NOT replace it with anything from the knowledge base.`;
      }
    } catch (e) {
      console.warn(`[patient-summary] AH narrative-section extraction failed: ${e?.message || e}`);
    }
  }

  // Build a File N → fileName legend covering ALL user PDFs (AH and
  // non-AH alike), and append a citation-format constraint to the
  // Radiology block. Radiology is the section most likely to fall
  // through to free-form KB-RAG (no AH source for most users), and
  // when raw filenames are long/mangled (e.g. Epic portal exports
  // that pack two filenames into one: `<A>-<B>.PDF`), the LLM emits
  // them verbatim and the citation becomes unreadable. With the
  // legend in scope, the agent can — and is told to — cite as
  // `[File N p.<page>]` instead, which the client renderer auto-
  // links via processPageReferences (using availableUserFiles to
  // resolve File N → real filename → clickable PDF URL).
  //
  // Same approach as the Stopped-Medications block (line ~11215),
  // generalized: we include the legend even when there's no
  // deterministic Radiology source, because the agent will still
  // be doing KB-RAG and we want its citations constrained.
  // Filter MUST mirror /api/user-files (exclude References folder and
  // isReference=true) so that File N in the prompt resolves to the
  // SAME index the client uses when matching against
  // availableUserFiles. Then PDF-only and stable insertion order.
  const referencesPrefix = `${userId}/References/`;
  const pdfFilesForLegend = (Array.isArray(userDoc?.files) ? userDoc.files : [])
    .filter(f => f && f.fileName && /\.pdf$/i.test(f.fileName))
    .filter(f => !(f.bucketKey || '').startsWith(referencesPrefix))
    .filter(f => f.isReference !== true);
  if (pdfFilesForLegend.length > 0) {
    const fileLegend = pdfFilesForLegend
      .map((f, i) => `File ${i + 1}=${f.fileName}`)
      .join('; ');
    const citationRule =
      `\n\n**Citation format for the Radiology section:** When citing any imaging study, use \`[File N p.<page>]\` only (e.g. \`[File 3 p.118]\`). NEVER spell out the raw filename — many filenames are long Epic export strings that render unreadably. (Legend: ${fileLegend})`;
    // Step 2 of the stabilization plan (Documentation/SummaryPipeline.md):
    // the same contract, TOP-LEVEL — every section, not just Radiology.
    // Raw-filename citations are the #1 cause of dead links: only
    // [File N p.X] is guaranteed linkable by both renderers.
    globalCitationContract =
      `\n\n**Citation format (ALL sections):** cite sources ONLY as \`[File N p.<page>]\` (e.g. \`[File 2 p.81]\`). NEVER write a raw filename inside a citation. (Legend: ${fileLegend})`;
    if (radiology) {
      radiology += citationRule;
    } else {
      // No AH-derived Radiology block. The agent will do KB-RAG; we
      // still inject the legend + citation rule so any imaging it
      // surfaces is cited in tag form.
      radiology = `**Radiology / Imaging:** No deterministic Apple Health Radiology source available — synthesize from the knowledge base.${citationRule}`;
    }
  }

  // GLOBAL File N tag list for the whole-summary citation rule (not just
  // Radiology). Same PDF-only, References-excluded ordering the client
  // renderer uses to resolve File N back to a real file, so `[File N p.X]`
  // citations link everywhere. Injected via the {fileTags} placeholder.
  // Having the AI cite File N directly (instead of spelling filenames)
  // avoids the failure where it invents a filename that no exact-match
  // rewrite can map — the root of the "same summary, different links in
  // chat vs workbook" bug.
  const fileTags = pdfFilesForLegend.length > 0
    ? pdfFilesForLegend.map((f, i) => `File ${i + 1} = ${f.fileName}`).join('\n')
    : '(no source files available — cite page numbers only)';

  // Stopped or Inactive Medications block: same deterministic source as
  // Current Medications (`resolvePatientMedicationSource` — Apple Health
  // medication_records.md or Epic Medication List). Splits on the 18-
  // month cutoff: anything OLDER than cutoff, OR explicitly status
  // 'discontinued' (Epic only), goes into this block. Deduped by drug
  // (most recent entry wins, same as the Current logic), so a drug
  // currently active won't also appear here.
  let stoppedMedications = '';
  try {
    const { mode, meds, legend } = await resolvePatientMedicationSource(userId, userDoc);
    if (meds.length > 0) {
      const { mergeMedications } = await import('./utils/meds-extractor.js');
      const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 18);
      const cutoffDate = cutoff.toISOString().slice(0, 10);
      const merged = mergeMedications(meds);
      const stopped = merged.filter(m => m.status === 'discontinued' || (m.isoDate && m.isoDate < cutoffDate));
      // Apply the same redaction the Current path uses (sex-fn meds, etc.)
      const { redactMedications } = await import('./utils/medication-redactor.js');
      const { kept } = redactMedications(stopped);
      if (kept.length > 0) {
        const lines = kept.map(m => {
          const tag = m.fileTag ? ` [${m.fileTag}${m.page ? ` p.${m.page}` : ''}]` : '';
          const date = m.isoDate ? ` (last ${m.isoDate})` : '';
          return `- ${m.name}${date}${tag}`;
        }).join('\n');
        const srcNote = mode === 'apple-health'
          ? 'from Apple Health Medication Records (entries not seen in the past 18 months)'
          : (mode === 'epic' ? 'from the Epic Medication List (discontinued, or last action > 18 months ago)' : '');
        stoppedMedications = `**Authoritative Stopped or Inactive Medications** (${srcNote}):\n${lines}\n\nUse this AS-IS for the "Stopped or Inactive Medications" section above — list each drug once with its last-seen date. Do NOT replace it with anything from the knowledge base. (Legend: ${legend.map(l => `${l.tag}=${l.fileName}`).join('; ')})`;
      }
    }
  } catch (e) {
    console.warn(`[patient-summary] stopped-meds extraction failed: ${e?.message || e}`);
  }

  const vars = {
    patientIdentity,
    currentMedications,
    stoppedMedications,
    encounters,
    allergies,
    outOfRangeLabs,
    medicalHistory,
    socialHistory,
    radiology,
    fileTags
  };
  // Per-agent override (My Stuff → Patient Summary → "Instructions for
  // <Agent>"). When set, takes precedence over the Layer-2 default; the
  // same `{placeholders}` are substituted so the user can rearrange the
  // template and still get the injected data.
  const override = userDoc?.agentProfiles?.[profileKey]?.patientSummaryPrompt;
  if (override && override.trim()) {
    return substitutePromptPlaceholders(override, vars) + globalCitationContract;
  }
  return (getClinicalPrompt('patient-summary.draft', vars)
    || 'Please generate a patient summary.') + globalCitationContract;
}

/**
 * Dual-AI Patient Summary: run the shared Patient Summary prompt against
 * BOTH Private AIs (Deepseek + GPT) in parallel and return both summaries
 * so the user can compare and choose. Used by the manual "Request New
 * Summary" button on the Patient Summary tab. Each agent result includes
 * the model name and a per-agent error (so a single-agent failure or
 * GPT-not-ready returns partial results, not 500).
 */
app.post('/api/patient-summary/generate-pair', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return;
    const userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
    if (!userDoc.assignedAgentId || !userDoc.agentEndpoint) {
      return res.status(400).json({ success: false, error: 'AGENT_NOT_CONFIGURED' });
    }

    // Build the prompt PER AGENT — each can have its own "Instructions for
    // <Agent>" override (My Stuff → Patient Summary sub-tabs). When neither
    // agent has an override, both get the same Layer-2 default; placeholder
    // data (identity, meds, encounters, allergies) is the same for both.
    const defaultPrompt = await buildPatientSummaryPromptForUser(userId, userDoc, 'default');
    const gptPrompt     = await buildPatientSummaryPromptForUser(userId, userDoc, 'gpt');

    // Resolve both agents. GPT may need lazy provisioning; on not-ready
    // we surface a per-agent reason rather than failing the whole call.
    const { DigitalOceanProvider } = await import('../lib/chat-client/providers/digitalocean.js');

    // Default (Deepseek) — ensure key + KB attach + retrieval method.
    if (!userDoc.agentApiKey) {
      userDoc.agentApiKey = await getOrCreateAgentApiKey(doClient, cloudant, userId, userDoc.assignedAgentId);
    }
    if (userDoc.kbId && userDoc.assignedAgentId) {
      try { await doClient.agent.attachKB(userDoc.assignedAgentId, userDoc.kbId); } catch { /* may already be attached */ }
    }
    await ensureAgentRetrieval(userDoc.assignedAgentId);

    // GPT — resolve via the secondary-agent helper. Returns null when not ready.
    let gptAgentId = userDoc.agentProfiles?.gpt?.agentId || null;
    let gptEndpoint = userDoc.agentProfiles?.gpt?.endpoint || null;
    let gptModel = userDoc.agentProfiles?.gpt?.modelName || 'openai-gpt-oss-120b';
    let gptApiKey = userDoc.agentProfiles?.gpt?.apiKey || null;
    let gptError = null;
    if (!gptAgentId || !gptEndpoint) {
      try {
        const { ensureSecondaryAgent } = await import('./routes/auth.js');
        const updated = await ensureSecondaryAgent(doClient, cloudant, userDoc);
        gptAgentId = updated?.agentProfiles?.gpt?.agentId || null;
        gptEndpoint = updated?.agentProfiles?.gpt?.endpoint || null;
        gptApiKey = updated?.agentProfiles?.gpt?.apiKey || gptApiKey;
        if (!gptEndpoint) gptError = 'GPT_NOT_READY';
      } catch (e) {
        gptError = e?.message || 'GPT_PROVISIONING_FAILED';
      }
    }
    if (gptAgentId && gptEndpoint && !gptApiKey) {
      try {
        gptApiKey = await getOrCreateAgentApiKey(doClient, cloudant, userId, gptAgentId, 'gpt');
      } catch (e) {
        gptError = gptError || (e?.message || 'GPT_KEY_FAILED');
      }
    }
    if (gptAgentId) {
      try { if (userDoc.kbId) await doClient.agent.attachKB(gptAgentId, userDoc.kbId); } catch { /* may already be attached */ }
      await ensureAgentRetrieval(gptAgentId);
    }

    // Each call is independently resilient (401/403 recreate-and-retry) and
    // never throws past Promise.allSettled.
    const callOne = async (apiKey, endpoint, modelName, profileKey, agentId, promptText) => {
      const t0 = Date.now();
      const msgs = [{ role: 'user', content: promptText }];
      try {
        let resp;
        try {
          resp = await new DigitalOceanProvider(apiKey, { baseURL: endpoint }).chat(msgs, { model: modelName, stream: false });
        } catch (firstError) {
          const sc = firstError.status || firstError.statusCode || 0;
          if ((sc === 401 || sc === 403) && agentId) {
            const { recreateAgentApiKey } = await import('./utils/agent-helper.js');
            const newKey = await recreateAgentApiKey(doClient, cloudant, userId, agentId, profileKey);
            resp = await new DigitalOceanProvider(newKey, { baseURL: endpoint }).chat(msgs, { model: modelName, stream: false });
          } else {
            throw firstError;
          }
        }
        let text = (resp.content || resp.text || '').trim();
        if (!text) throw new Error('Empty summary');
        // Same deterministic citation-rewrite as the single-agent path.
        text = rewriteCitationsToFileLegend(text, userDoc, userId);
        return { ok: true, profileKey, model: modelName, text, generationSeconds: Math.round(((Date.now() - t0) / 1000) * 10) / 10 };
      } catch (e) {
        const sc = e.status || e.statusCode || 0;
        return { ok: false, profileKey, model: modelName, error: e?.message || 'error', status: sc || undefined, reason: (sc === 401 || sc === 403) ? 'AGENT_NOT_READY' : undefined };
      }
    };

    const tasks = [
      callOne(userDoc.agentApiKey, userDoc.agentEndpoint, userDoc.agentModelName || 'openai-gpt-oss-120b', 'default', userDoc.assignedAgentId, defaultPrompt)
    ];
    if (gptAgentId && gptEndpoint && gptApiKey && !gptError) {
      tasks.push(callOne(gptApiKey, gptEndpoint, gptModel, 'gpt', gptAgentId, gptPrompt));
    }
    const settled = await Promise.allSettled(tasks);
    const results = settled.map(s => s.status === 'fulfilled' ? s.value : { ok: false, error: String(s.reason?.message || s.reason) });
    const defaultResult = results.find(r => r.profileKey === 'default') || null;
    const gptResult = results.find(r => r.profileKey === 'gpt')
      || (gptError ? { ok: false, profileKey: 'gpt', model: gptModel, error: gptError, reason: 'GPT_NOT_READY' } : null);

    try {
      await appendUserProvisioningEvent(userId, {
        event: 'patient-summary-pair-generated',
        defaultOk: !!defaultResult?.ok,
        gptOk: !!gptResult?.ok,
        gptReason: gptResult?.reason || null
      });
    } catch { /* non-fatal */ }

    res.json({
      success: true,
      generatedAt: new Date().toISOString(),
      default: defaultResult,
      gpt: gptResult
    });
  } catch (error) {
    console.error('[patient-summary/generate-pair] error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Per-agent Patient Summary prompt (override).
 *
 * Each Private AI agent can have its own Patient Summary instruction text
 * stored at `userDoc.agentProfiles[profileKey].patientSummaryPrompt`. When
 * set, it replaces the Layer-2 `patient-summary.draft` body for that agent
 * (the `{patientIdentity} {currentMedications} {encounters} {allergies}`
 * placeholders are still substituted). Edited from My Stuff → Patient
 * Summary → "Instructions for <Agent>" sub-tabs.
 */
app.get('/api/agent-instructions/patient-summary', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return;
    const profileKey = req.query?.profileKey === 'gpt' ? 'gpt' : 'default';
    const userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
    const override = userDoc?.agentProfiles?.[profileKey]?.patientSummaryPrompt || null;
    const def = getClinicalPrompt('patient-summary.draft', {}) || '';
    res.json({
      success: true,
      profileKey,
      override,
      default: def,
      effective: (override && override.trim()) ? override : def
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/agent-instructions/patient-summary', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return;
    const { profileKey: pkRaw, prompt } = req.body || {};
    const profileKey = pkRaw === 'gpt' ? 'gpt' : 'default';
    const incoming = typeof prompt === 'string' ? prompt : '';
    // Empty string clears the override (revert to Layer-2 default).
    const toStore = incoming.trim() ? incoming : null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const doc = await cloudant.getDocument('maia_users', userId);
        if (!doc) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
        if (!doc.agentProfiles) doc.agentProfiles = {};
        if (!doc.agentProfiles[profileKey]) doc.agentProfiles[profileKey] = {};
        if (toStore === null) {
          delete doc.agentProfiles[profileKey].patientSummaryPrompt;
        } else {
          doc.agentProfiles[profileKey].patientSummaryPrompt = toStore;
        }
        doc.updatedAt = new Date().toISOString();
        await cloudant.saveDocument('maia_users', doc);
        return res.json({ success: true, profileKey, cleared: toStore === null });
      } catch (e) {
        if (e?.statusCode === 409 && attempt < 2) continue;
        throw e;
      }
    }
    res.status(500).json({ success: false, error: 'SAVE_CONFLICT' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Generate a DRAFT patient summary against the full KB and store it on userDoc.draftPatientSummary
// (separate from the committed patientSummaries array). The wizard runs this after indexing
// completes; the draft is NOT shown to the user until they verify medications and the summary.
/** Persisted status for the draft-summary job (same pattern as
 *  listsBuild): the ~3-minute generation is a VISIBLE, retryable job so
 *  /api/pipeline/advance can run it in the background and every surface
 *  can render its progress. Best-effort with 409 retry. */
const setDraftJob = async (userId, patch) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const doc = await cloudant.getDocument('maia_users', userId);
      if (!doc) return;
      doc.draftJob = { ...(doc.draftJob || {}), ...patch };
      doc.updatedAt = new Date().toISOString();
      await cloudant.saveDocument('maia_users', doc);
      return;
    } catch (e) {
      if (e?.statusCode !== 409) return;
    }
  }
};

// ── The draft-summary worker (recordsPipeline step 3b) ─────────────────
// Extracted from the route body so /api/pipeline/advance can execute the
// generation server-side. Returns { httpStatus, body }.
const runDraftGeneration = async (userId) => {
  const startedAt = Date.now();
  try {
    await setDraftJob(userId, { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, error: null });
    let userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc) {
      await setDraftJob(userId, { status: 'error', finishedAt: new Date().toISOString(), error: 'USER_NOT_FOUND' });
      return { httpStatus: 404, body: { success: false, error: 'USER_NOT_FOUND' } };
    }

    // Self-healing: provision missing agents instead of failing
    if (!userDoc.assignedAgentId || !userDoc.agentEndpoint) {
      console.log(`[DRAFT SUMMARY] Primary agent missing for ${userId} — attempting to provision`);
      const provStartedAt = Date.now();
      try {
        const { ensureUserAgent } = await import('./routes/auth.js');
        userDoc = await ensureUserAgent(doClient, cloudant, userDoc);
        const provElapsed = ((Date.now() - provStartedAt) / 1000).toFixed(1);
        console.log(`[DRAFT SUMMARY] Primary agent provisioned for ${userId} in ${provElapsed}s`);
        await appendUserProvisioningEvent(userId, { event: 'draft-summary-auto-provision-primary', elapsedSeconds: Number(provElapsed), agentId: userDoc.assignedAgentId || null });
      } catch (provErr) {
        const provElapsed = ((Date.now() - provStartedAt) / 1000).toFixed(1);
        console.warn(`[DRAFT SUMMARY] Primary agent provisioning failed for ${userId} in ${provElapsed}s: ${provErr.message}`);
        await appendUserProvisioningEvent(userId, { event: 'draft-summary-auto-provision-primary-failed', elapsedSeconds: Number(provElapsed), reason: provErr.message });
      }
    }
    const hasPrimaryAgent = userDoc.assignedAgentId && userDoc.agentEndpoint;
    if (!hasPrimaryAgent) {
      await setDraftJob(userId, { status: 'error', finishedAt: new Date().toISOString(), error: 'AGENT_NOT_CONFIGURED' });
      return { httpStatus: 400, body: { success: false, error: 'AGENT_NOT_CONFIGURED' } };
    }

    await appendUserProvisioningEvent(userId, { event: 'draft-summary-started', primaryModel: userDoc.agentModelName || null });

    if (userDoc.kbId && userDoc.assignedAgentId) {
      try {
        await doClient.agent.attachKB(userDoc.assignedAgentId, userDoc.kbId);
        await appendUserProvisioningEvent(userId, { event: 'draft-summary-kb-attached', agentId: userDoc.assignedAgentId, kbId: userDoc.kbId });
      } catch (attachError) {
        if (!attachError.message?.includes('already')) {
          console.error(`[DRAFT SUMMARY] Failed to attach KB: ${attachError.message}`);
          await appendUserProvisioningEvent(userId, { event: 'draft-summary-kb-attach-failed', reason: attachError.message });
        }
      }
      await ensureAgentRetrieval(userDoc.assignedAgentId);
    } else if (!userDoc.kbId) {
      await setDraftJob(userId, { status: 'error', finishedAt: new Date().toISOString(), error: 'NO_KB' });
      return { httpStatus: 400, body: { success: false, error: 'NO_KB' } };
    }

    const { DigitalOceanProvider } = await import('../lib/chat-client/providers/digitalocean.js');
    let agentProvider;
    if (hasPrimaryAgent) {
      if (!userDoc.agentApiKey) {
        userDoc.agentApiKey = await getOrCreateAgentApiKey(doClient, cloudant, userId, userDoc.assignedAgentId);
      }
      agentProvider = new DigitalOceanProvider(userDoc.agentApiKey, { baseURL: userDoc.agentEndpoint });
    } else {
      // No primary agent — go straight to secondary
      console.log(`[DRAFT SUMMARY] No primary agent for ${userId} — using secondary agent`);
      const gptProfile = userDoc.agentProfiles.gpt;
      let gptApiKey = gptProfile.apiKey;
      if (!gptApiKey) {
        gptApiKey = await getOrCreateAgentApiKey(doClient, cloudant, userId, gptProfile.agentId, 'gpt');
      }
      agentProvider = new DigitalOceanProvider(gptApiKey, { baseURL: gptProfile.endpoint });
      // Override the model so the chat call uses the secondary model
      userDoc.agentModelName = gptProfile.modelName || 'openai-gpt-oss-120b';
    }

    // Synchronously ensure Apple Health Lists/*.md sidecars exist before
    // building the prompt. Without this, Setup races the category-split
    // pipeline and emits a PS with empty Allergies / Recent Visits
    // sections (the fragility described in clinical-prompts.md). Helper
    // is idempotent — a no-op if the sidecars are already in place.
    try {
      const { ensureAppleHealthListsBuilt } = await import('./utils/lists-builder.js');
      const bucketUrl = getSpacesBucketName();
      const bucketName = bucketUrl ? (bucketUrl.split('//')[1]?.split('.')[0] || 'maia') : null;
      if (bucketName) {
        const { S3Client } = await import('@aws-sdk/client-s3');
        const s3Client = new S3Client({
          endpoint: getSpacesEndpoint(),
          region: 'us-east-1',
          forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
          credentials: {
            accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || process.env.SPACES_AWS_ACCESS_KEY_ID || '',
            secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || process.env.SPACES_AWS_SECRET_ACCESS_KEY || ''
          }
        });
        const outcome = await ensureAppleHealthListsBuilt(userId, userDoc, {
          readSpacesObjectBuffer, readSpacesTextObject,
          s3Client, bucketName, cloudant
        });
        if (outcome === 'built') {
          // Re-fetch userDoc so the prompt builder sees the freshly-set
          // appleHealthCategoriesBuiltAt / isAppleHealth flags.
          const refreshed = await cloudant.getDocument('maia_users', userId);
          if (refreshed) userDoc = refreshed;
        }
        await appendUserProvisioningEvent(userId, { event: 'draft-summary-ah-lists', outcome: outcome || 'no-op' });
      }
    } catch (e) {
      console.warn(`[DRAFT SUMMARY] AH lists pre-build failed (non-fatal): ${e?.message || e}`);
      await appendUserProvisioningEvent(userId, { event: 'draft-summary-ah-lists-failed', reason: e?.message || String(e) });
    }

    // Build the prompt via the shared helper (Layer-2 spec + currentMedications
    // + past-12mo encounters context). Used by every summary endpoint so they
    // can never drift.
    const draftPrompt = await buildPatientSummaryPromptForUser(userId, userDoc);
    await appendUserProvisioningEvent(userId, { event: 'draft-summary-prompt-built', promptLength: draftPrompt.length });
    const chatMessages = [{ role: 'user', content: draftPrompt }];
    const chatModel = userDoc.agentModelName || 'openai-gpt-oss-120b';
    const chatOptions = { model: chatModel, stream: false };
    console.log(`[DRAFT SUMMARY] Calling Private AI for ${userId} (model: ${chatModel})...`);
    const aiStartedAt = Date.now();

    let chatResp;
    let usedModel = chatModel;

    // --- Primary agent attempt ---
    if (hasPrimaryAgent) {
      try {
        chatResp = await agentProvider.chat(chatMessages, chatOptions);
      } catch (primaryErr) {
        const sc = primaryErr.status || primaryErr.statusCode || 0;
        console.warn(`[DRAFT SUMMARY] Primary agent failed for ${userId} (status: ${sc}): ${primaryErr.message}`);
        await appendUserProvisioningEvent(userId, { event: 'draft-summary-primary-failed', model: chatModel, status: sc || undefined, reason: primaryErr.message });

        // 401/403 — try recreating the API key once before giving up on primary
        if ((sc === 401 || sc === 403) && userDoc.assignedAgentId) {
          try {
            const { recreateAgentApiKey } = await import('./utils/agent-helper.js');
            const newApiKey = await recreateAgentApiKey(doClient, cloudant, userId, userDoc.assignedAgentId);
            const retry = new DigitalOceanProvider(newApiKey, { baseURL: userDoc.agentEndpoint });
            chatResp = await retry.chat(chatMessages, chatOptions);
            console.log(`[DRAFT SUMMARY] Primary agent succeeded after key recreation for ${userId}`);
            await appendUserProvisioningEvent(userId, { event: 'draft-summary-primary-key-recreated', model: chatModel });
          } catch (retryErr) {
            const rsc = retryErr.status || retryErr.statusCode || 0;
            console.warn(`[DRAFT SUMMARY] Primary agent retry also failed for ${userId} (status: ${rsc}): ${retryErr.message}`);
            await appendUserProvisioningEvent(userId, { event: 'draft-summary-primary-retry-failed', model: chatModel, status: rsc || undefined, reason: retryErr.message });
            // Don't throw — fall through to secondary
          }
        }
        // For non-401/403 errors, chatResp stays null — fall through to secondary
      }
    }

    const aiElapsedMs = Date.now() - aiStartedAt;
    console.log(`[DRAFT SUMMARY] Private AI responded for ${userId} in ${(aiElapsedMs / 1000).toFixed(1)}s (model: ${usedModel})`);

    let summary = (chatResp.content || chatResp.text || '').trim();
    if (!summary) throw new Error('Empty draft from agent');
    // Same deterministic citation-rewrite as the other PS endpoints.
    summary = rewriteCitationsToFileLegend(summary, userDoc, userId);
    const generationSeconds = Math.round(((Date.now() - startedAt) / 1000) * 10) / 10;

    let saved = false;
    let attempts = 0;
    while (!saved && attempts < 3) {
      attempts += 1;
      const freshDoc = await cloudant.getDocument('maia_users', userId);
      if (!freshDoc) {
        await setDraftJob(userId, { status: 'error', finishedAt: new Date().toISOString(), error: 'USER_NOT_FOUND' });
        return { httpStatus: 404, body: { success: false, error: 'USER_NOT_FOUND' } };
      }
      freshDoc.draftPatientSummary = {
        text: summary,
        draftAt: new Date().toISOString(),
        generationSeconds
      };
      try {
        await cloudant.saveDocument('maia_users', freshDoc);
        saved = true;
      } catch (err) {
        if (err.statusCode === 409 && attempts < 3) continue;
        throw err;
      }
    }

    const lines = summary.split('\n').filter(l => l.trim()).length;
    const totalElapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    await appendUserProvisioningEvent(userId, { event: 'draft-summary-succeeded', model: usedModel, elapsedSeconds: Number(totalElapsed), lines, chars: summary.length });
    await setDraftJob(userId, { status: 'done', finishedAt: new Date().toISOString(), error: null });
    return { httpStatus: 200, body: { success: true, summary, lines, chars: summary.length, generationSeconds } };
  } catch (error) {
    console.error('Error generating draft patient summary:', error);
    const sc = error.status || error.statusCode || 0;
    const failElapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    try { await appendUserProvisioningEvent(userId, { event: 'draft-summary-failed', reason: error.message || 'error', status: sc || undefined, totalElapsedSeconds: Number(failElapsed) }); } catch { /* non-fatal */ }
    await setDraftJob(userId, { status: 'error', finishedAt: new Date().toISOString(), error: String(error?.message || error) });
    return { httpStatus: 500, body: { success: false, error: error.message } };
  }
};

app.post('/api/patient-summary/draft', async (req, res) => {
  const userId = resolveUserId(req, res);
  if (!userId) return;
  const out = await runDraftGeneration(userId);
  res.status(out.httpStatus).json(out.body);
});

// Extract a Current Medications list using the user's agent (so their system-prompt
// hide-rules apply). Two modes:
//   mode=from-summary   → extract from userDoc.draftPatientSummary.text
//   mode=apple-health   → extract from the Apple Health markdown in Lists/, optionally
//                          using `contextMeds` (the result of a prior from-summary call)
//                          as context so the agent can reconcile/dedupe.
app.post('/api/medications/extract', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return;
    const { mode, contextMeds } = req.body || {};
    if (mode !== 'from-summary' && mode !== 'apple-health') {
      return res.status(400).json({ success: false, error: 'INVALID_MODE' });
    }

    // Soft-skip helper: this AH-extract is an OPTIONAL enhancement —
    // Lists.vue already falls back to the patient-summary meds. So
    // instead of a hard 4xx (red console error the user keeps seeing,
    // and invisible in maia-log.pdf), return 200 with skipped:true and
    // record the reason as a provisioning event so it shows in the log.
    const softSkip = async (reason) => {
      try {
        await appendUserProvisioningEvent(userId, {
          event: 'medications-extract-skipped', mode: mode || null, reason
        });
      } catch { /* non-fatal */ }
      return res.json({ success: true, skipped: true, reason, medications: [] });
    };

    // Resolve the user doc, tolerating a resolved-id miss by trying the
    // explicit body userId (covers temp/local-only id edge cases).
    let userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc && req.body?.userId && req.body.userId !== userId) {
      userDoc = await cloudant.getDocument('maia_users', req.body.userId);
    }
    if (!userDoc) return softSkip('USER_NOT_FOUND');
    if (!userDoc.assignedAgentId || !userDoc.agentEndpoint) {
      return softSkip('AGENT_NOT_CONFIGURED');
    }
    const draftText = userDoc.draftPatientSummary?.text;
    if (!draftText) {
      return softSkip('NO_DRAFT_SUMMARY');
    }

    let prompt;
    if (mode === 'from-summary') {
      prompt = getClinicalPrompt('current-medications.extract.from-summary', { draftText })
        || `Below is a patient summary. Extract the Current Medications as a simple list, one medication per line, no commentary. Follow your system instructions for any medications that must be omitted or redacted.\n\n${draftText}`;
    } else {
      const appleHealthFile = (userDoc.files || []).find(f => f && f.isAppleHealth);
      if (!appleHealthFile || !appleHealthFile.fileName) {
        return softSkip('NO_APPLE_HEALTH_FILE');
      }
      // Prefer the focused, dated "Medication Records" category markdown —
      // every entry has a date, so the agent can reliably determine the
      // patient's CURRENT medications. Fall back to the full Apple Health
      // markdown only if the medication category isn't present.
      let appleHealthMd = '';
      const medMd = await findMedicationRecordsMarkdown(userId);
      if (medMd?.text) {
        appleHealthMd = medMd.text;
      } else {
        const cleanName = String(appleHealthFile.fileName).replace(/[^a-zA-Z0-9.-]/g, '_');
        const mdName = cleanName.replace(/\.pdf$/i, '.md');
        appleHealthMd = await readSpacesTextObject(`${userId}/Lists/${mdName}`) || '';
        if (!appleHealthMd) {
          // Lists/*.md not written yet (race with process-initial-file).
          // Optional enhancement — soft-skip so Lists.vue cleanly uses
          // the patient-summary meds and the log records it.
          return softSkip('APPLE_HEALTH_MARKDOWN_MISSING');
        }
      }

      const contextBlock = Array.isArray(contextMeds) && contextMeds.length > 0
        ? `\n\nFor context, these medications were identified in the patient summary you generated earlier from the full knowledge base:\n${contextMeds.map(m => '- ' + m).join('\n')}\n\nUse this list as a starting point, then reconcile and refine against the Apple Health data below.\n`
        : '';
      prompt = getClinicalPrompt('current-medications.extract.apple-health', { appleHealthMd, contextBlock })
        || `Below are this patient's dated medication records from their Apple Health export. Identify the patient's CURRENT medications: for each distinct drug, the most recent dated entry reflects the current prescription (and current strength). Exclude entries that are clearly one-time inpatient/anesthesia administrations (e.g. propofol, fentanyl, IV infusions) and older strengths that have been superseded by a newer one. Apply your system instructions for any medications that must be omitted or redacted (e.g. sexual-function drugs/syringes).

Output ONLY the list of current medications — one medication per line (name and current strength). Do NOT include the patient's name or age, any heading, any dates, any bullets, any bold, any blank lines, or any other commentary.${contextBlock}\n\n${appleHealthMd}`;
    }

    if (!userDoc.agentApiKey) {
      userDoc.agentApiKey = await getOrCreateAgentApiKey(doClient, cloudant, userId, userDoc.assignedAgentId);
    }

    const { DigitalOceanProvider } = await import('../lib/chat-client/providers/digitalocean.js');
    const agentProvider = new DigitalOceanProvider(userDoc.agentApiKey, { baseURL: userDoc.agentEndpoint });
    const chatOptions = { model: userDoc.agentModelName || 'openai-gpt-oss-120b', stream: false };

    let chatResp;
    try {
      chatResp = await agentProvider.chat([{ role: 'user', content: prompt }], chatOptions);
    } catch (firstError) {
      const sc = firstError.status || firstError.statusCode || 0;
      if ((sc === 401 || sc === 403) && userDoc.assignedAgentId) {
        try {
          const { recreateAgentApiKey } = await import('./utils/agent-helper.js');
          const newApiKey = await recreateAgentApiKey(doClient, cloudant, userId, userDoc.assignedAgentId);
          const retry = new DigitalOceanProvider(newApiKey, { baseURL: userDoc.agentEndpoint });
          chatResp = await retry.chat([{ role: 'user', content: prompt }], chatOptions);
        } catch (retryError) {
          const rsc = retryError.status || retryError.statusCode || 0;
          // Agent still not serving → soft-skip (this extract is optional;
          // Lists.vue falls back). Records the reason in maia-log.
          if (rsc === 401 || rsc === 403) return softSkip('AGENT_NOT_READY');
          throw retryError;
        }
      } else {
        throw firstError;
      }
    }

    const raw = (chatResp.content || chatResp.text || '').trim();
    const medications = raw.split('\n')
      .map(l => l.replace(/^\s*[-*••\d.)]+\s*/, '').trim())
      .map(l => l.replace(/\*\*/g, '').trim()) // drop bold markers
      .filter(l => l.length > 0)
      // Drop preamble/heading lines a model might add despite instructions:
      // markdown headings, a "Current Medications" label, the patient
      // name/age line, and AI refusals ("no current medications…").
      .filter(l => !/^#{1,6}\s/.test(l))
      .filter(l => !/^current medications\b/i.test(l))
      .filter(l => !/\b(year[- ]old|age\s|sex\s|\bmale\b|\bfemale\b)/i.test(l) || /\d+\s*(mg|mcg|ml|%|unit|tablet|capsule|cream|injection|inhaler|patch|solution|spray)/i.test(l))
      .filter(l => !/^(based on|there are no|no current medications|the (provided|available))/i.test(l));

    res.json({
      success: true,
      medications,
      lines: medications.length,
      source: mode === 'apple-health' ? 'apple health' : 'patient summary',
      raw
    });
  } catch (error) {
    console.error('Error extracting medications:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Current Medications Worksheet — a structured medication table built by
// a specific Private AI agent (profile 'default' = Deepseek, 'gpt' =
// GPT) using its attached knowledge base (retrieval). One row per
// medication: Status (Current/Discontinued/Inpatient), Last date
// prescribed, and a Source cited as "File N p.#" against a file legend
// the SERVER supplies (so numbering is consistent across both agents
// and the model can't invent file names). Result is persisted to
// userDoc.medsWorksheets[profile] and rendered in My Lists.

// Self-heal: agents created before v1.3.85 used retrieval_method
// RETRIEVAL_METHOD_NONE, which makes the agent IGNORE its attached
// knowledge base (every answer comes back "no records found"). Flip any
// such agent to RETRIEVAL_METHOD_REWRITE so KB retrieval actually runs.
// Idempotent and best-effort — never throws.
async function ensureAgentRetrieval(agentId) {
  if (!agentId) return;
  try {
    const agent = await doClient.agent.get(agentId);
    const method = agent?.retrieval_method;
    if (!method || method === 'RETRIEVAL_METHOD_NONE') {
      await doClient.agent.update(agentId, { retrieval_method: 'RETRIEVAL_METHOD_REWRITE' });
      console.log(`[retrieval] healed agent ${agentId}: ${method || 'unset'} -> RETRIEVAL_METHOD_REWRITE`);
    }
  } catch (e) {
    console.warn(`[retrieval] ensureAgentRetrieval(${agentId}) failed: ${e?.message || e}`);
  }
}

function buildWorksheetPrompt(legendLines, cutoffDate) {
  // Prefer the editable Layer-2 prompt; fall back to the hardcoded text
  // below if the config file is missing/broken so the flow never breaks.
  const fromFile = getClinicalPrompt('worksheet.kb-retrieval', { legendLines, cutoffDate });
  if (fromFile != null) return fromFile;
  return `You are building a Current Medications Worksheet from this patient's records in your knowledge base. Use ONLY information found in your knowledge base; never infer, assume, or add a medication that is not present. Include EVERY medication you find.

Output a GitHub-flavored Markdown table with EXACTLY these columns — no title, no notes, no text before or after the table:

| Medication | Status | Last date prescribed | Source |

Rules per column:
- Medication: the drug name with the strength/form FROM ITS MOST RECENT entry (e.g. "atorvastatin 20 MG tablet"). One row per drug — see de-duplication below.
- Status: exactly one of —
    Current — this drug's most recent entry is actively prescribed (not stopped/held/discontinued) AND its Last date prescribed is on or after ${cutoffDate} (within the last 18 months).
    Discontinued — this drug's most recent entry is explicitly stopped/inactive/held, OR its Last date prescribed is BEFORE ${cutoffDate} (more than 18 months ago). A medication not prescribed in over 18 months is NOT current.
    Inpatient — administered during a hospital/inpatient encounter, not an outpatient take-home prescription.
  A drug can only be Current if its Last date prescribed is on or after ${cutoffDate}. Do not invent a status.
- Last date prescribed: the most recent date the drug was actually prescribed/ordered (e.g. an "Ordered on" or "Start date"), as YYYY-MM-DD; "—" if none is found. IGNORE document footer dates such as "Generated on <date>" / "Exported on <date>" — those are when the report was printed, NOT when the medication was prescribed.
- Source: cite the entry that established the Last date prescribed, formatted as "File N p.<page>" using the file tags below. Do NOT write full file names in the table — use only the "File N" tag. If you cannot determine a page, use just "File N".

De-duplication (IMPORTANT): treat all entries for the same drug as ONE medication, regardless of strength or dose. A change in dose/strength over time is NOT a separate medication. Output exactly ONE row per drug, using ONLY the entry with the most recent Last date prescribed — its strength, date, and page. Do NOT create extra rows or a "Discontinued" row for older strengths/doses of the same drug; simply drop the older entries.

Apply your system instructions for any medications that must be omitted or redacted.

Source file tags (use only these in the Source column):
${legendLines}`;
}

// Worksheet prompt built from a structured Apple Health "Medication
// Records" markdown passed INLINE (each entry has a date, the medication,
// and a page number). This is far more reliable than k=10 KB retrieval
// over a large multi-hundred-page record — the agent sees every entry,
// so both Deepseek and GPT produce complete tables. `ahFileTag` is the
// "File N" legend tag for the Apple Health source file.
function buildWorksheetPromptFromMarkdown(ahFileTag, medMarkdown, legendLines, cutoffDate) {
  const fromFile = getClinicalPrompt('worksheet.apple-health-markdown', { ahFileTag, medMarkdown, legendLines, cutoffDate });
  if (fromFile != null) return fromFile;
  return `Below are this patient's medication records, extracted directly from their Apple Health export (${ahFileTag}). Each entry shows a date, the medication name and strength, and the page number it appears on.

Build a GitHub-flavored Markdown table with EXACTLY these columns — no title, no notes, no text before or after the table:

| Medication | Status | Last date prescribed | Source |

Rules per column:
- Medication: the drug name with the strength/form FROM ITS MOST RECENT entry (e.g. "atorvastatin 20 MG tablet"). One row per drug — see de-duplication below.
- Status: exactly one of —
    Current — this drug's most recent entry is an outpatient prescription (not stopped/held/discontinued) AND its Last date prescribed is on or after ${cutoffDate} (within the last 18 months).
    Discontinued — this drug's most recent entry is explicitly stopped/inactive/held, OR its Last date prescribed is BEFORE ${cutoffDate} (more than 18 months ago). A medication not prescribed in over 18 months is NOT current.
    Inpatient — administered during a hospital/inpatient encounter (e.g. anesthesia agents like propofol/fentanyl, IV infusions), not an outpatient take-home prescription.
  A drug can only be Current if its Last date prescribed is on or after ${cutoffDate}. Do not invent a status.
- Last date prescribed: the most recent date for that drug, as YYYY-MM-DD.
- Source: "${ahFileTag} p.<page>" using the page number of that most-recent entry. If no page is shown, use just "${ahFileTag}".

De-duplication (IMPORTANT): treat all entries for the same drug as ONE medication, regardless of strength or dose. A change in dose/strength over time is NOT a separate medication. Output exactly ONE row per drug, using ONLY the entry with the latest date — that entry's strength, date, and page. Do NOT create extra rows or a "Discontinued" row for older strengths/doses of the same drug; simply drop the older entries. (Different salts/formulations that are clinically distinct may be separate rows.)

Include EVERY distinct drug present in the records below (one row each). Apply your system instructions for any medications that must be omitted or redacted (e.g. sexual-function drugs/syringes).

File tags (for the Source column):
${legendLines}

Medication records:
${medMarkdown}`;
}

// Read a UTF-8 text object from the Spaces "maia" bucket. Returns null on
// any miss/error. Used to pull the Apple Health category markdown.
async function readSpacesTextObject(key) {
  const bucketUrl = getSpacesBucketName();
  if (!bucketUrl) return null;
  const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';
  try {
    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
    const s3Client = new S3Client({
      endpoint: getSpacesEndpoint(),
      region: 'us-east-1',
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      credentials: {
        accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || process.env.SPACES_AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || process.env.SPACES_AWS_SECRET_ACCESS_KEY || ''
      }
    });
    const r = await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
    const chunks = [];
    for await (const c of r.Body) chunks.push(c);
    return Buffer.concat(chunks).toString('utf-8');
  } catch {
    return null;
  }
}

// Worksheet prompt built from a deterministically-extracted, dated Epic
// medication list (name | action+date | File N p.page). The dates here are
// the REAL Ordered-on / Discontinued-on dates, so the agent must use them
// verbatim and must NOT pull dates from the document body (in particular
// the repeating "Generated on …" footer date).
function buildWorksheetPromptFromMedList(medListText, legendLines, cutoffDate) {
  const fromFile = getClinicalPrompt('worksheet.epic-medication-list', { medListText, legendLines, cutoffDate });
  if (fromFile != null) return fromFile;
  return `Below is this patient's medication list, extracted directly from the record. Each line gives the medication (name and strength), its most recent action and date (ordered or discontinued), and the page it appears on. These actions and dates are AUTHORITATIVE.

Build a GitHub-flavored Markdown table with EXACTLY these columns — no title, no notes, no text before or after the table:

| Medication | Status | Last date prescribed | Source |

Rules per column:
- Medication: the drug name with strength/form exactly as given. One row per drug — see de-duplication.
- Status: exactly one of —
    Current — the action is "ordered" AND the date is on or after ${cutoffDate} (within the last 18 months).
    Discontinued — the action is "discontinued", OR the date is before ${cutoffDate} (more than 18 months ago).
    Inpatient — a hospital/inpatient administration (e.g. anesthesia agents, IV infusions).
  A drug can only be Current if its date is on or after ${cutoffDate}.
- Last date prescribed: the date given for that medication, as YYYY-MM-DD. Use ONLY the date provided on that medication's line. Do NOT use any other date from the documents, and NEVER use a document "Generated on" footer date.
- Source: the "File N p.<page>" exactly as given on that medication's line.

De-duplication: one row per drug, regardless of strength/dose changes.

Apply your system instructions for any medications that must be omitted or redacted (e.g. sexual-function drugs/syringes).

File tags (for the Source column):
${legendLines}

Medication list:
${medListText}`;
}

// Read a binary object (e.g. a PDF) from the Spaces "maia" bucket as a
// Buffer. Returns null on any miss/error.
async function readSpacesObjectBuffer(key) {
  const bucketUrl = getSpacesBucketName();
  if (!bucketUrl) return null;
  const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';
  try {
    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
    const s3Client = new S3Client({
      endpoint: getSpacesEndpoint(),
      region: 'us-east-1',
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      credentials: {
        accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || process.env.SPACES_AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || process.env.SPACES_AWS_SECRET_ACCESS_KEY || ''
      }
    });
    const r = await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
    const chunks = [];
    for await (const c of r.Body) chunks.push(c);
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

// Locate the Apple Health "Medication Records" category markdown for a
// user (e.g. `${userId}/Lists/medication_records.md`). Lists the Lists/
// prefix and returns the first non-source markdown whose name mentions
// "medication". Returns { key, text } or null.
async function findMedicationRecordsMarkdown(userId) {
  const bucketUrl = getSpacesBucketName();
  if (!bucketUrl) return null;
  const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';
  try {
    const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const s3Client = new S3Client({
      endpoint: getSpacesEndpoint(),
      region: 'us-east-1',
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      credentials: {
        accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || process.env.SPACES_AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || process.env.SPACES_AWS_SECRET_ACCESS_KEY || ''
      }
    });
    const list = await s3Client.send(new ListObjectsV2Command({ Bucket: bucketName, Prefix: `${userId}/Lists/` }));
    const key = (list.Contents || [])
      .map(o => o.Key)
      .find(k => /\/medication[^/]*\.md$/i.test(k));
    if (!key) return null;
    const text = await readSpacesTextObject(key);
    return text ? { key, text } : null;
  } catch {
    return null;
  }
}

app.post('/api/medications/worksheet', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return;
    const profileKey = req.body?.agentProfileKey === 'gpt' ? 'gpt' : 'default';

    let userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });

    // Resolve the agent endpoint/id/key/model for the requested profile.
    let agentId, endpoint, model;
    if (profileKey === 'gpt') {
      let gpt = userDoc.agentProfiles?.gpt;
      // Auto-provision GPT on demand if missing/not yet deployed.
      if (!gpt?.agentId || !gpt?.endpoint) {
        try {
          const { ensureSecondaryAgent } = await import('./routes/auth.js');
          userDoc = await ensureSecondaryAgent(doClient, cloudant, userDoc);
          gpt = userDoc.agentProfiles?.gpt;
        } catch (e) {
          return res.status(202).json({ success: false, pending: true, reason: 'GPT_PROVISIONING', message: 'Provisioning Private AI (Deepseek)…' });
        }
        if (!gpt?.endpoint) {
          // Created but still deploying — caller should retry shortly.
          return res.status(202).json({ success: false, pending: true, reason: 'GPT_DEPLOYING', message: 'Private AI (Deepseek) is deploying — try Refresh in a few minutes.' });
        }
      }
      agentId = gpt.agentId;
      endpoint = gpt.endpoint;
      model = gpt.modelName || 'openai-gpt-oss-120b';
    } else {
      if (!userDoc.assignedAgentId || !userDoc.agentEndpoint) {
        return res.status(400).json({ success: false, error: 'AGENT_NOT_CONFIGURED' });
      }
      agentId = userDoc.assignedAgentId;
      endpoint = userDoc.agentEndpoint;
      model = userDoc.agentModelName || 'openai-gpt-oss-120b';
    }

    // File legend from the indexed KB files (File 1..N). Server-supplied
    // so the table's "File N" tags are stable across both agents.
    const kbName = getKBNameFromUserDoc(userDoc, userId);
    const kbPrefix = kbName ? `${userId}/${kbName}/` : null;
    const kbFiles = (userDoc.files || []).filter(f =>
      f?.fileName && (!kbPrefix || (f.bucketKey || '').startsWith(kbPrefix))
    );
    if (kbFiles.length === 0) {
      return res.status(400).json({ success: false, error: 'NO_INDEXED_FILES', message: 'No indexed files to build a worksheet from.' });
    }
    // legend carries bucketKey so the client's Source links can open the
    // exact file (not just the Apple Health initial file).
    const legend = kbFiles.map((f, i) => ({ tag: `File ${i + 1}`, fileName: f.fileName, bucketKey: f.bucketKey || null }));
    const legendLines = legend.map(l => `${l.tag} = ${l.fileName}`).join('\n');

    // Prefer the structured Apple Health "Medication Records" markdown as
    // the source (every entry has a date + page number), passed INLINE.
    // This is reliable across models — k=10 KB retrieval over a large
    // record routinely misses the medication pages (especially Deepseek),
    // producing blank worksheets. Fall back to KB retrieval when no Apple
    // Health medication markdown exists.
    // 18-month "Current" cutoff (YYYY-MM-DD): any medication whose most
    // recent prescription predates this is Discontinued/Inpatient, never
    // Current. Computed server-side so it doesn't depend on the model
    // knowing today's date.
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 18);
    const cutoffDate = cutoff.toISOString().slice(0, 10);

    let prompt;
    let worksheetSourceMode = 'kb-retrieval';

    // 1) Apple Health: the structured "Medication Records" markdown (dated,
    //    paged) passed inline.
    const ahFileIdx = kbFiles.findIndex(f => f.isAppleHealth);
    if (ahFileIdx !== -1) {
      const medMd = await findMedicationRecordsMarkdown(userId);
      if (medMd?.text) {
        const ahFileTag = `File ${ahFileIdx + 1}`;
        prompt = buildWorksheetPromptFromMarkdown(ahFileTag, medMd.text, legendLines, cutoffDate);
        worksheetSourceMode = 'apple-health-markdown';
      }
    }

    // 2) Epic / MGB: deterministically extract the dated "Medication List"
    //    entries (real Ordered-on / Discontinued-on dates + page numbers)
    //    from the PDFs and feed them inline. This avoids KB retrieval, whose
    //    chunks include the repeating "Generated on …" footer date that the
    //    model otherwise reports as the prescription date.
    if (!prompt) {
      try {
        const { extractEpicMedications, mergeMedications, buildMedListText } = await import('./utils/meds-extractor.js');
        const pdfParse = (await import('pdf-parse')).default;
        const pdfFiles = kbFiles.filter(f => /\.pdf$/i.test(f.fileName) || /pdf/i.test(f.fileType || ''));
        const allMeds = [];
        for (let i = 0; i < kbFiles.length; i++) {
          const f = kbFiles[i];
          if (!pdfFiles.includes(f) || !f.bucketKey) continue;
          const buf = await readSpacesObjectBuffer(f.bucketKey);
          if (!buf) continue;
          try {
            const data = await pdfParse(buf);
            const { meds } = extractEpicMedications(data.text, data.numpages, `File ${i + 1}`);
            allMeds.push(...meds);
          } catch (e) {
            console.warn(`[worksheet] meds parse failed for ${f.fileName}: ${e?.message || e}`);
          }
        }
        if (allMeds.length > 0) {
          const merged = mergeMedications(allMeds);
          prompt = buildWorksheetPromptFromMedList(buildMedListText(merged), legendLines, cutoffDate);
          worksheetSourceMode = 'epic-medication-list';
        }
      } catch (e) {
        console.warn(`[worksheet] Epic medication extraction error: ${e?.message || e}`);
      }
    }

    // 3) Fallback: KB retrieval (only when no structured source was found).
    if (!prompt) {
      prompt = buildWorksheetPrompt(legendLines, cutoffDate);
    }

    // Ensure the KB is attached to THIS agent before calling, so retrieval
    // returns the patient's records. Without this the agent answers from an
    // empty context and produces a table with only the header row (the bug
    // that made both worksheets come back blank). Mirrors the
    // /api/patient-summary/draft endpoint, which attaches before calling.
    const worksheetKbId = userDoc.kbId;
    if (worksheetKbId && agentId) {
      try {
        await doClient.agent.attachKB(agentId, worksheetKbId);
      } catch (attachError) {
        if (!attachError.message?.includes('already')) {
          console.warn(`[worksheet] attachKB(${profileKey}) failed (continuing): ${attachError.message}`);
        }
      }
    }
    // Ensure the agent actually retrieves from its KB (heal legacy NONE).
    await ensureAgentRetrieval(agentId);

    const apiKey = await getOrCreateAgentApiKey(doClient, cloudant, userId, agentId, profileKey);
    const { DigitalOceanProvider } = await import('../lib/chat-client/providers/digitalocean.js');
    const chatOptions = { model, stream: false };

    let chatResp;
    try {
      chatResp = await new DigitalOceanProvider(apiKey, { baseURL: endpoint }).chat([{ role: 'user', content: prompt }], chatOptions);
    } catch (firstError) {
      const sc = firstError.status || firstError.statusCode || 0;
      if ((sc === 401 || sc === 403) && agentId) {
        try {
          const { recreateAgentApiKey } = await import('./utils/agent-helper.js');
          const newApiKey = await recreateAgentApiKey(doClient, cloudant, userId, agentId, profileKey);
          chatResp = await new DigitalOceanProvider(newApiKey, { baseURL: endpoint }).chat([{ role: 'user', content: prompt }], chatOptions);
        } catch (retryError) {
          const rsc = retryError.status || retryError.statusCode || 0;
          if (rsc === 401 || rsc === 403) {
            // Agent (e.g. the GPT one) is still deploying — return a structured
            // pending response, not a 500, and record it.
            await appendUserProvisioningEvent(userId, { event: 'meds-worksheet-pending', agentProfileKey: profileKey, reason: 'AGENT_NOT_READY', status: rsc });
            return res.status(202).json({ success: false, pending: true, reason: 'AGENT_NOT_READY', agentProfileKey: profileKey, message: `Private AI (${profileKey === 'gpt' ? 'Deepseek' : 'GPT'}) is still deploying — try Refresh shortly.` });
          }
          throw retryError;
        }
      } else {
        throw firstError;
      }
    }

    const table = (chatResp.content || chatResp.text || '').trim();
    const generatedAt = new Date().toISOString();
    const entry = { table, legend, model, generatedAt, sourceMode: worksheetSourceMode };

    // Persist (conflict-tolerant). Non-fatal if it can't save.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const doc = await cloudant.getDocument('maia_users', userId);
        if (!doc) break;
        if (!doc.medsWorksheets || typeof doc.medsWorksheets !== 'object') doc.medsWorksheets = {};
        doc.medsWorksheets[profileKey] = entry;
        doc.updatedAt = new Date().toISOString();
        await cloudant.saveDocument('maia_users', doc);
        break;
      } catch (e) {
        if (e?.statusCode === 409 && attempt < 2) continue;
        console.warn(`[worksheet] could not persist ${profileKey} for ${userId}: ${e?.message || e}`);
        break;
      }
    }

    await appendUserProvisioningEvent(userId, {
      event: 'meds-worksheet-generated',
      agentProfileKey: profileKey,
      model,
      fileCount: legend.length,
      sourceMode: worksheetSourceMode
    });

    res.json({ success: true, agentProfileKey: profileKey, ...entry });
  } catch (error) {
    console.error('Error building medications worksheet:', error);
    const sc = error.status || error.statusCode || 0;
    try {
      const pk = req.body?.agentProfileKey === 'gpt' ? 'gpt' : 'default';
      await appendUserProvisioningEvent(userId, { event: 'meds-worksheet-failed', agentProfileKey: pk, reason: error.message || 'error', status: sc || undefined });
    } catch { /* non-fatal */ }
    res.status(500).json({ success: false, error: error.message });
  }
});

// Read persisted worksheets (no AI call).
app.get('/api/medications/worksheet', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return;
    const userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
    res.json({ success: true, worksheets: userDoc.medsWorksheets || {} });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Resolve the patient's best dated medication source and return a unified,
 * normalized medication list. Source priority:
 *   1. Apple Health  (`Lists/medication_records.md`, parsed deterministically)
 *   2. Epic / MGB    ("Medication List" entries extracted from PDFs)
 *   3. none          (KB-only patient — no structured source available)
 * Each med: { name, status:'active'|'discontinued', isoDate, page, fileTag }.
 * Returns { mode, meds, legend }.
 */
async function resolvePatientMedicationSource(userId, userDoc) {
  if (!userDoc) userDoc = await cloudant.getDocument('maia_users', userId);
  if (!userDoc) return { mode: 'none', meds: [], legend: [] };

  // Step 3 of the stabilization plan (Documentation/SummaryPipeline.md):
  // resolve from ANY registered file — indexing changes a file's storage
  // location, not its truth. The old KB-prefix filter made a freshly
  // imported (un-indexed) Apple Health file invisible here, so the
  // candidates card showed "enter manually" while Saved Files and the
  // categories panel plainly displayed the same file. Filter mirrors
  // /api/user-files (References excluded) so File-N numbering matches
  // the prompt legend and the client.
  const referencesPrefixMeds = `${userId}/References/`;
  const kbFiles = (userDoc.files || []).filter(f =>
    f?.fileName &&
    !(f.bucketKey || '').startsWith(referencesPrefixMeds) &&
    f.isReference !== true
  );
  const legend = kbFiles.map((f, i) => ({ tag: `File ${i + 1}`, fileName: f.fileName, bucketKey: f.bucketKey || null, isAppleHealth: !!f.isAppleHealth }));

  // 1) Apple Health medication_records.md
  const ahFileIdx = kbFiles.findIndex(f => f.isAppleHealth);
  if (ahFileIdx !== -1) {
    const medMd = await findMedicationRecordsMarkdown(userId);
    if (medMd?.text) {
      const { parseAppleHealthMedRecords } = await import('./utils/meds-extractor.js');
      const meds = parseAppleHealthMedRecords(medMd.text, `File ${ahFileIdx + 1}`);
      if (meds.length > 0) return { mode: 'apple-health', meds, legend };
    }
  }

  // 2) Epic / MGB structured "Medication List" across PDFs
  try {
    const { extractEpicMedications } = await import('./utils/meds-extractor.js');
    const pdfParse = (await import('pdf-parse')).default;
    const pdfFiles = kbFiles.filter(f => /\.pdf$/i.test(f.fileName) || /pdf/i.test(f.fileType || ''));
    const all = [];
    for (let i = 0; i < kbFiles.length; i++) {
      const f = kbFiles[i];
      if (!pdfFiles.includes(f) || !f.bucketKey) continue;
      const buf = await readSpacesObjectBuffer(f.bucketKey);
      if (!buf) continue;
      try {
        const data = await pdfParse(buf);
        const { meds } = extractEpicMedications(data.text, data.numpages, `File ${i + 1}`);
        all.push(...meds);
      } catch (e) {
        console.warn(`[meds-source] Epic parse failed for ${f.fileName}: ${e?.message || e}`);
      }
    }
    if (all.length > 0) return { mode: 'epic', meds: all, legend };
  } catch (e) {
    console.warn(`[meds-source] Epic extraction error: ${e?.message || e}`);
  }

  return { mode: 'none', meds: [], legend };
}

/**
 * Unified Current Medications endpoint. Returns the deterministic Current
 * meds (status=active, last date within 18 months, deduped by drug) from
 * the best structured source — the same source the worksheets use. The
 * client's verify/edit card pre-fills from `currentText`; on Verify, the
 * card POSTs to /api/user-current-medications which writes
 * userDoc.currentMedications (then consumed by the Patient Summary draft
 * via the patient-summary.draft prompt's {currentMedications} placeholder).
 */
app.get('/api/medications/current', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return;
    const userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });

    const { mode, meds, legend } = await resolvePatientMedicationSource(userId, userDoc);
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 18);
    const cutoffDate = cutoff.toISOString().slice(0, 10);

    // Dedupe by drug (latest entry wins), then keep only current candidates.
    const { mergeMedications } = await import('./utils/meds-extractor.js');
    const merged = mergeMedications(meds);
    const candidates = merged.filter(m => m.status === 'active' && m.isoDate >= cutoffDate);

    // Apply server-side redaction (mirrors the System Instructions
    // "remove sexual-function meds" rule). The deterministic pipeline
    // bypasses the agent, so we apply the rule here before the user sees
    // the pre-filled list.
    const { redactMedications } = await import('./utils/medication-redactor.js');
    const { kept: currentMeds, redacted } = redactMedications(candidates);
    const currentText = currentMeds.map(m => `- ${m.name}`).join('\n');

    res.json({
      success: true,
      sourceMode: mode,
      cutoffDate,
      currentMeds,
      currentText,
      allMeds: merged,
      legend,
      redactedCount: redacted.length
    });
  } catch (error) {
    console.error('[medications/current] error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Multi-patient detection. Scans every PDF in the user's file set,
// extracts the patient identity from each header, and reports whether
// the files describe one patient or several. DOB is the authoritative
// signal — name mismatches alone don't block (too easy to false-alarm
// on PDF extraction artifacts, maiden/married names, Jr./Sr.). The
// Setup and Restore wizards call this BEFORE KB creation; the My
// Stuff Saved Files banner calls it whenever the file set changes.
// Returns the full detection result so the caller can render an
// actionable banner.
app.get('/api/files/verify-patient-consistency', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return;
    const userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });

    // Scope to files in the KB folder (skip archived / previous-KB
    // bucketKeys). Same filter the patient-summary builder uses.
    const kbName = getKBNameFromUserDoc(userDoc, userId);
    const kbPrefix = kbName ? `${userId}/${kbName}/` : null;
    const files = (userDoc.files || []).filter(f =>
      f?.fileName && f?.bucketKey &&
      (!kbPrefix || f.bucketKey.startsWith(kbPrefix))
    );
    if (files.length === 0) {
      return res.json({ success: true, consistent: true, primary: null, groups: [], mismatches: [], reason: 'No KB files to check.' });
    }

    const { extractIdentitiesForFiles, detectPatientMismatch } = await import('./utils/patient-consistency.js');
    const identities = await extractIdentitiesForFiles(files, {
      readSpacesObjectBuffer,
      log: console
    });
    const result = detectPatientMismatch(identities);

    // Log only when we detect a real (DOB-based) mismatch — soft
    // name-only mismatches are advisory and don't merit a log entry
    // every time the banner re-checks.
    if (!result.consistent) {
      try {
        await appendUserProvisioningEvent(userId, {
          event: 'patient-consistency-mismatch',
          primary: result.primary?.name || null,
          primaryDob: result.primary?.dobIso || null,
          mismatchFiles: result.mismatches.map(m => m.fileName),
          reason: result.reason
        });
      } catch { /* non-fatal */ }
    }

    res.json({ success: true, ...result, identities });
  } catch (error) {
    console.error('[verify-patient-consistency] error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Deterministic per-analyte lab history. Reads `${userId}/Lists/
// lab_results.md` (built from the Apple Health PDF by lists-processor.js)
// and returns the full time series for a given analyte. Bypasses
// RAG entirely so the result is exhaustive — RAG over the indexed KB
// is structurally incompatible with "list ALL TSH readings" because
// top-k retrieval caps how many matching chunks the agent ever sees.
//
// The chat client uses this endpoint when the user message matches
// "list all/show all/history/trend" + a recognizable analyte. Both
// the AH presence and the sidecar build are required — accounts with
// no AH file get a clean 404 and the client falls through to RAG.
app.get('/api/labs/history', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return;
    const analyteQuery = String(req.query?.analyte || '').trim();
    if (!analyteQuery) return res.status(400).json({ success: false, error: 'ANALYTE_REQUIRED' });

    const md = await readSpacesTextObject(`${userId}/Lists/lab_results.md`);
    if (!md || !md.trim()) {
      // Return 200 (not 404) so the browser doesn't flag this as a
      // console error — "no sidecar" is the expected case for any
      // account without an Apple Health file, not an error. The client
      // checks `available: false` and falls through to raw RAG.
      return res.json({
        success: true,
        available: false,
        reason: 'NO_LAB_RESULTS_SIDECAR',
        message: 'No Apple Health lab results sidecar for this user.',
        rows: [],
        total: 0,
        entryCount: 0
      });
    }

    const { buildLabHistory } = await import('./utils/lab-history.js');
    const { analyte, rows, total, entryCount } = buildLabHistory(md, analyteQuery);

    // Include the user's Apple Health PDF filename so the chat client
    // can render each row's `page` as a clickable [<filename> p.<page>]
    // citation. processPageReferences in ChatInterface only auto-links
    // page refs that name a filename in the same message; without this
    // the deterministic lab history shows dates+values but no link to
    // the source page.
    let ahFileName = null;
    try {
      const udoc = await cloudant.getDocument('maia_users', userId);
      const ahFile = (udoc?.files || []).find(f => f?.isAppleHealth && f?.fileName);
      if (ahFile) ahFileName = ahFile.fileName;
    } catch { /* non-fatal */ }

    res.json({
      success: true,
      analyte: analyte?.canonical || analyteQuery,
      synonymsTried: analyte?.terms || [analyteQuery],
      rows,
      total,
      entryCount,
      source: 'apple-health/lab_results.md',
      ahFileName
    });
  } catch (error) {
    console.error('[labs/history] error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Encounters worksheet — a reverse-chronological list of clinical
// encounters across ALL of the patient's source PDFs. Built
// deterministically (no agent / no KB retrieval): each PDF is parsed,
// encounter headers are detected (Epic-optimized, generic fallback),
// merged, deduped, and rendered as a GFM table with "File N p.<page>"
// Source links. Persisted to userDoc.encountersWorksheet.
app.post('/api/encounters/worksheet', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return;
    const userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });

    // Source files: PDFs in the patient's KB folder.
    // Location-free (stabilization step 3 rule): indexing changes where a
    // file is stored, not its truth. Mirror /api/user-files.
    const referencesPrefixEnc = `${userId}/References/`;
    const pdfFiles = (userDoc.files || []).filter(f =>
      f?.fileName &&
      !(f.bucketKey || '').startsWith(referencesPrefixEnc) &&
      f.isReference !== true &&
      (/\.pdf$/i.test(f.fileName) || /pdf/i.test(f.fileType || ''))
    );
    if (pdfFiles.length === 0) {
      return res.status(400).json({ success: false, error: 'NO_PDF_FILES', message: 'No PDF files to build an encounters list from.' });
    }

    const legend = pdfFiles.map((f, i) => ({ tag: `File ${i + 1}`, fileName: f.fileName, bucketKey: f.bucketKey || null }));

    const { extractEncountersFromText, parseAppleHealthClinicalNotes, buildEncountersTable } = await import('./utils/encounters-extractor.js');
    const pdfParse = (await import('pdf-parse')).default;

    const allEncounters = [];
    const modes = {};
    for (let i = 0; i < pdfFiles.length; i++) {
      const f = pdfFiles[i];
      const tag = `File ${i + 1}`;
      if (!f.bucketKey) { modes[tag] = 'missing-key'; continue; }
      // Apple Health files: prefer the structured Clinical Notes category
      // sidecar (Lists/clinical_notes.md) — these ARE the encounters. Falls
      // back to PDF parsing if the sidecar is missing.
      if (f.isAppleHealth) {
        const cn = await readSpacesTextObject(`${userId}/Lists/clinical_notes.md`);
        if (cn) {
          const enc = parseAppleHealthClinicalNotes(cn, tag);
          if (enc.length > 0) { modes[tag] = 'apple-health-clinical-notes'; allEncounters.push(...enc); continue; }
        }
      }
      const buf = await readSpacesObjectBuffer(f.bucketKey);
      if (!buf) { modes[tag] = 'download-failed'; continue; }
      try {
        const data = await pdfParse(buf);
        const { encounters, mode } = extractEncountersFromText(data.text, data.numpages, tag);
        modes[tag] = mode;
        allEncounters.push(...encounters);
      } catch (e) {
        modes[tag] = 'parse-error';
        console.warn(`[encounters] parse failed for ${f.fileName}: ${e?.message || e}`);
      }
    }

    const { table, count, rows } = buildEncountersTable(allEncounters);
    const generatedAt = new Date().toISOString();
    // Persist the STRUCTURED `rows` alongside the markdown table so
    // /api/encounters/find can deterministically return the non-AH
    // source for any encounter without re-parsing markdown or re-
    // running the (expensive) per-file PDF extraction.
    const entry = { table, rows, legend, generatedAt, fileCount: pdfFiles.length, encounterCount: count, modes };

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const doc = await cloudant.getDocument('maia_users', userId);
        if (!doc) break;
        doc.encountersWorksheet = entry;
        doc.updatedAt = new Date().toISOString();
        await cloudant.saveDocument('maia_users', doc);
        break;
      } catch (e) {
        if (e?.statusCode === 409 && attempt < 2) continue;
        console.warn(`[encounters] could not persist for ${userId}: ${e?.message || e}`);
        break;
      }
    }

    await appendUserProvisioningEvent(userId, {
      event: 'encounters-worksheet-generated',
      fileCount: pdfFiles.length,
      encounterCount: count
    });

    res.json({ success: true, ...entry });
  } catch (error) {
    console.error('Error building encounters worksheet:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Read the persisted encounters worksheet (no parsing).
app.get('/api/encounters/worksheet', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return;
    const userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
    res.json({ success: true, encounters: userDoc.encountersWorksheet || null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Deterministic Out-Of-Range labs worksheet from NON-Apple-Health PDFs
// Deterministic OOR labs scan — Apple Health Lab Results only.
// Uses extractPdfWithPages (pdfjs) to get page-segmented markdown that
// preserves the "OUT OF RANGE" annotations, then extractAppleHealthOorLabs
// to parse them. POST to (re)build, GET to read the cached doc.
app.post('/api/labs/oor-worksheet', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return;
    const userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });

    const ahFile = (userDoc.files || []).find(f => f?.isAppleHealth && f?.bucketKey);
    if (!ahFile) {
      return res.status(400).json({
        success: false,
        error: 'NO_APPLE_HEALTH',
        message: 'No Apple Health file with Lab Results found. Upload an Apple Health export first.'
      });
    }

    const buf = await readSpacesObjectBuffer(ahFile.bucketKey);
    if (!buf) {
      return res.status(500).json({ success: false, error: 'DOWNLOAD_FAILED', message: 'Could not download the Apple Health file.' });
    }

    const { extractPdfWithPages } = await import('./utils/pdf-parser.js');
    const parsed = await extractPdfWithPages(buf);
    const fullMarkdown = (parsed.pages || []).map(p => `## Page ${p.page}\n\n${p.markdown}`).join('\n\n---\n\n');

    const oors = extractAppleHealthOorLabs(fullMarkdown);
    const legend = [{ tag: 'AH', fileName: ahFile.fileName, bucketKey: ahFile.bucketKey }];

    const allRows = oors.map(o => ({
      analyte: o.line,
      value: '',
      flag: 'OUT OF RANGE',
      isoDate: o.isoDate || '',
      page: o.page,
      fileTag: 'AH'
    }));

    allRows.sort((a, b) => {
      if (!a.isoDate && !b.isoDate) return 0;
      if (!a.isoDate) return 1;
      if (!b.isoDate) return -1;
      return a.isoDate < b.isoDate ? 1 : a.isoDate > b.isoDate ? -1 : 0;
    });

    const generatedAt = new Date().toISOString();
    const entry = {
      rows: allRows,
      legend,
      generatedAt,
      fileCount: 1,
      rowCount: allRows.length
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const doc = await cloudant.getDocument('maia_users', userId);
        if (!doc) break;
        doc.oorLabsWorksheet = entry;
        doc.updatedAt = new Date().toISOString();
        await cloudant.saveDocument('maia_users', doc);
        break;
      } catch (e) {
        if (e?.statusCode === 409 && attempt < 2) continue;
        console.warn(`[oor-worksheet] could not persist for ${userId}: ${e?.message || e}`);
        break;
      }
    }

    await appendUserProvisioningEvent(userId, {
      event: 'oor-labs-worksheet-generated',
      fileCount: 1,
      rowCount: allRows.length
    });

    res.json({ success: true, ...entry });
  } catch (error) {
    console.error('Error building OOR labs worksheet:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/labs/oor-worksheet', async (req, res) => {
  try {
    const userId = await resolveOwnerUserId(req, res);
    if (!userId) return;
    const userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
    res.json({ success: true, oorLabs: userDoc.oorLabsWorksheet || null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Deterministic encounter lookup with non-AH-source-first ordering.
//
// Why this exists: the Encounters worksheet's buildEncountersTable
// already prefers non-Apple-Health sources for both the displayed
// descriptor and the source link order (AH is summary-only; the
// hospital export carries the full note text). But when the user
// asks a Private AI "show me a link to the most recent encounter
// note", the agent does plain RAG and may surface an AH chunk first
// — producing a citation to the AH file even when an Epic source
// exists for the same visit. The chat client routes these queries
// through this endpoint instead, which reads the persisted structured
// rows and returns the same non-AH-first ordering the worksheet uses.
//
// Query params:
//   ref=latest         — most recent encounter (default)
//   ref=YYYY-MM-DD     — encounter on a specific date
//   ref=YYYY-MM        — most recent encounter in a month
//   ref=<freeform>     — substring match against the descriptor;
//                        most-recent winner
//
// Response shape:
//   { success, available, row?, allMatches?, reason? }
// where `row` is the chosen encounter enriched with each source's
// fileName + bucketKey from the legend (so the client can render a
// `[<filename> p.<page>]` citation that processPageReferences will
// hyperlink).
app.get('/api/encounters/find', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return;
    const userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });

    const ws = userDoc.encountersWorksheet;
    if (!ws || !Array.isArray(ws.rows) || ws.rows.length === 0) {
      return res.json({
        success: true, available: false,
        reason: 'NO_ENCOUNTERS_WORKSHEET',
        message: 'No encounters worksheet has been built yet. Open My Lists → Encounters to generate one.'
      });
    }

    const ref = String(req.query?.ref || 'latest').trim();
    const legend = Array.isArray(ws.legend) ? ws.legend : [];
    const legendByTag = new Map(legend.map(l => [l.tag, l]));
    const enrichSources = (sources) => (sources || []).map(s => {
      const meta = legendByTag.get(s.fileTag) || {};
      return {
        fileTag: s.fileTag,
        page: s.page,
        isAh: !!s.isAh,
        fileName: meta.fileName || null,
        bucketKey: meta.bucketKey || null
      };
    });

    // Rows are already sorted newest-first by buildEncountersTable.
    // For "latest" / month-level / freeform queries we PREFER rows
    // classified as 'narrative' (real clinical visits) over 'ancillary'
    // (lab orders, imaging requisitions). A FHIR Encounter resource
    // exists for a lab draw but users asking for "the most recent
    // encounter" mean the most recent actual visit. Fall back to
    // ancillary only when no narrative row matches.
    const narrativeOnly = ws.rows.filter(r => (r.klass || 'narrative') === 'narrative');
    let chosen = null;
    let allMatches = [];
    let usedAncillaryFallback = false;
    if (/^(latest|most[\s-]?recent|last)$/i.test(ref)) {
      chosen = narrativeOnly[0] || null;
      if (!chosen && ws.rows.length) { chosen = ws.rows[0]; usedAncillaryFallback = true; }
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(ref)) {
      // Date-specific queries match exactly — don't filter by klass.
      chosen = ws.rows.find(r => r.isoDate === ref) || null;
    } else if (/^\d{4}-\d{2}$/.test(ref)) {
      // Most recent within the month — prefer narrative.
      chosen = narrativeOnly.find(r => String(r.isoDate || '').startsWith(ref)) || null;
      if (!chosen) {
        chosen = ws.rows.find(r => String(r.isoDate || '').startsWith(ref)) || null;
        if (chosen) usedAncillaryFallback = true;
      }
    } else {
      // Free-text substring against descriptor or type.
      const needle = ref.toLowerCase();
      const matches = (r) =>
        String(r.description || '').toLowerCase().includes(needle) ||
        String(r.type || '').toLowerCase().includes(needle);
      const narrativeMatches = narrativeOnly.filter(matches);
      allMatches = narrativeMatches.length ? narrativeMatches : ws.rows.filter(matches);
      if (allMatches.length && narrativeMatches.length === 0) usedAncillaryFallback = true;
      chosen = allMatches[0] || null;
    }

    if (!chosen) {
      return res.json({
        success: true, available: true,
        reason: 'NO_MATCH',
        message: `No encounter matched "${ref}".`,
        ref
      });
    }

    res.json({
      success: true,
      available: true,
      ref,
      row: {
        isoDate: chosen.isoDate,
        type: chosen.type,
        klass: chosen.klass || 'narrative',
        description: chosen.description,
        sources: enrichSources(chosen.sources)
      },
      usedAncillaryFallback,
      allMatchCount: allMatches.length || 1
    });
  } catch (error) {
    console.error('[encounters/find] error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Ensure the secondary "Private AI (Deepseek)" agent is provisioned and report
// whether it has finished deploying (endpoint resolved). The Setup wizard
// calls this and polls until ready:true so BOTH Private AIs exist before
// Setup completes. Safe to call repeatedly (ensureSecondaryAgent is
// idempotent and mutex-guarded).
app.post('/api/agents/ensure-secondary', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return;
    let userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });

    const checkOnly = !!req.body?.checkOnly;
    const existingAgentId = userDoc.agentProfiles?.gpt?.agentId;

    // Check-only mode: return current status without creating the agent
    if (checkOnly && !existingAgentId) {
      return res.json({ success: true, ready: false, status: 'not_created' });
    }

    // Fast path: agent already created — just check if it's running.
    // Avoids redundant DO API calls, KB attaches, and DB writes on every poll.
    if (existingAgentId) {
      let endpoint = null;
      let isRunning = false;
      let status = 'unknown';
      try {
        const live = await doClient.agent.get(existingAgentId);
        status = live?.deployment?.status || live?.deployment_status || 'unknown';
        isRunning = status === 'STATUS_RUNNING';
        endpoint = live?.deployment?.url ? `${live.deployment.url}/api/v1` : null;
      } catch { /* still deploying */ }
      const ready = !!endpoint && isRunning;

      if (ready) {
        const alreadyLogged = !!userDoc.agentProfiles?.gpt?.deployedLoggedAt;
        if (!alreadyLogged) {
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const doc = await cloudant.getDocument('maia_users', userId);
              if (!doc) break;
              if (!doc.agentProfiles) doc.agentProfiles = {};
              doc.agentProfiles.gpt = { ...(doc.agentProfiles.gpt || {}), endpoint, deployedLoggedAt: new Date().toISOString() };
              doc.updatedAt = new Date().toISOString();
              await cloudant.saveDocument('maia_users', doc);
              break;
            } catch (err) {
              if (err?.statusCode === 409 && attempt < 2) continue;
              break;
            }
          }
          try {
            await appendUserProvisioningEvent(userId, { event: 'gpt-agent-deployed', agentId: existingAgentId });
          } catch { /* non-fatal */ }
        }
      }
      console.log(`[ensure-secondary] Poll for ${userId}: status=${status}, ready=${ready}`);
      return res.json({ success: true, ready, agentId: existingAgentId, endpoint, status });
    }

    // Slow path: agent doesn't exist yet — create it.
    const ensureStartedAt = Date.now();
    const { ensureSecondaryAgent } = await import('./routes/auth.js');
    try {
      userDoc = await ensureSecondaryAgent(doClient, cloudant, userDoc);
    } catch (e) {
      return res.json({ success: true, ready: false, provisioning: true, reason: e?.message || 'provisioning' });
    }

    const ensureElapsed = ((Date.now() - ensureStartedAt) / 1000).toFixed(1);
    const gpt = userDoc.agentProfiles?.gpt || {};
    if (gpt.agentId) {
      try {
        await appendUserProvisioningEvent(userId, {
          event: 'gpt-agent-created', agentId: gpt.agentId, agentName: gpt.agentName || null, elapsedSeconds: Number(ensureElapsed)
        });
      } catch { /* non-fatal */ }
    }
    console.log(`[ensure-secondary] Created for ${userId} in ${ensureElapsed}s, agentId=${gpt.agentId}`);
    res.json({ success: true, ready: false, agentId: gpt.agentId || null, endpoint: null, status: 'created' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Splice the verified Current Medications into the saved draft summary's
// "Current Medications" section. Pure text edit; no AI call.
app.patch('/api/patient-summary/medications', async (req, res) => {
  try {
    const userId = resolveUserId(req, res);
    if (!userId) return;
    const { medications } = req.body || {};
    if (!Array.isArray(medications)) {
      return res.status(400).json({ success: false, error: 'MEDICATIONS_ARRAY_REQUIRED' });
    }
    const medsBlock = medications.length > 0
      ? medications.map(m => `- ${m}`).join('\n')
      : '_No current medications_';

    let attempts = 0;
    while (attempts < 3) {
      attempts += 1;
      const userDoc = await cloudant.getDocument('maia_users', userId);
      if (!userDoc) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
      if (!userDoc.draftPatientSummary?.text) {
        return res.status(400).json({ success: false, error: 'NO_DRAFT_SUMMARY' });
      }
      let text = userDoc.draftPatientSummary.text;
      const headingRe = /(^|\n)(##?\s*Current\s*Medications[^\n]*\n)([\s\S]*?)(?=\n##?\s|\n*$)/i;
      if (headingRe.test(text)) {
        text = text.replace(headingRe, (_m, prefix, heading) => `${prefix}${heading}${medsBlock}\n`);
      } else {
        text = `${text.trimEnd()}\n\n## Current Medications\n${medsBlock}\n`;
      }
      userDoc.draftPatientSummary = {
        ...userDoc.draftPatientSummary,
        text,
        medicationsSplicedAt: new Date().toISOString(),
        medicationsCount: medications.length
      };
      try {
        await cloudant.saveDocument('maia_users', userDoc);
        return res.json({
          success: true,
          summary: text,
          lines: text.split('\n').filter(l => l.trim()).length,
          chars: text.length,
          medicationsCount: medications.length
        });
      } catch (err) {
        if (err.statusCode === 409 && attempts < 3) continue;
        throw err;
      }
    }
    return res.status(500).json({ success: false, error: 'SAVE_RETRIES_EXHAUSTED' });
  } catch (error) {
    console.error('Error splicing medications into draft:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Helper functions for managing multiple patient summaries
const MAX_SUMMARIES = 3;

function initializeSummariesArray(userDoc) {
  // Initialize patientSummaries array if it doesn't exist
  if (!userDoc.patientSummaries || !Array.isArray(userDoc.patientSummaries)) {
    userDoc.patientSummaries = [];
  }
  
  // Migrate old patientSummary to array if it exists and array is empty
  if (userDoc.patientSummary && userDoc.patientSummaries.length === 0) {
    const createdAt = userDoc.patientSummaryGeneratedAt || new Date().toISOString();
    userDoc.patientSummaries.push({
      text: userDoc.patientSummary,
      createdAt: createdAt,
      updatedAt: createdAt
    });
  }
  
  return userDoc.patientSummaries;
}

function getCurrentSummary(userDoc) {
  // Current summary is the most recent one (last in array)
  const summaries = initializeSummariesArray(userDoc);
  if (summaries.length === 0) {
    return null;
  }
  return summaries[summaries.length - 1];
}

function addNewSummary(userDoc, summaryText, replaceStrategy = 'newest', replaceIndex = null) {
  const summaries = initializeSummariesArray(userDoc);
  const now = new Date().toISOString();
  const newSummary = {
    text: summaryText,
    createdAt: now,
    updatedAt: now
  };
  
  // Save current summary for undo (if exists)
  const currentSummary = summaries.length > 0 ? summaries[summaries.length - 1] : null;
  
  if (replaceIndex !== null && replaceIndex >= 0 && replaceIndex < summaries.length) {
    // Replace at specific index and make the new summary current (move to end)
    if (replaceIndex === summaries.length - 1) {
      // Replacing current summary - just update it
      summaries[replaceIndex] = newSummary;
    } else {
      // Replacing a non-current summary - remove old one, add new at end
      summaries.splice(replaceIndex, 1);
      summaries.push(newSummary);
    }
  } else if (summaries.length < MAX_SUMMARIES) {
    // Add to array
    summaries.push(newSummary);
  } else {
    // Replace based on strategy
    if (replaceStrategy === 'oldest') {
      // Remove oldest (first) and add new at end
      summaries.shift();
      summaries.push(newSummary);
    } else if (replaceStrategy === 'newest') {
      // Replace newest (last) with new
      summaries[summaries.length - 1] = newSummary;
    }
    // 'keep' strategy means don't add (handled by caller)
  }
  
  // Update backward compatibility fields
  userDoc.patientSummary = newSummary.text;
  userDoc.patientSummaryGeneratedAt = now;
  
  return { summaries, currentSummary };
}

function swapSummary(userDoc, index) {
  const summaries = initializeSummariesArray(userDoc);
  if (index < 0 || index >= summaries.length || index === summaries.length - 1) {
    return false; // Invalid index or already current
  }
  
  // Swap the summary at index with the last one (current)
  const temp = summaries[index];
  summaries[index] = summaries[summaries.length - 1];
  summaries[summaries.length - 1] = temp;
  
  // Update backward compatibility fields
  const current = summaries[summaries.length - 1];
  userDoc.patientSummary = current.text;
  userDoc.patientSummaryGeneratedAt = current.updatedAt || current.createdAt;
  
  return true;
}

// Patient Summary endpoints
app.get('/api/patient-summary', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }

    // Get the user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    // Detect legacy format before mutating (migration never persisted can cause "get new when one exists" to fail)
    const hadLegacyFormat = userDoc.patientSummary &&
      (!userDoc.patientSummaries || !Array.isArray(userDoc.patientSummaries) || userDoc.patientSummaries.length === 0);
    const summaries = initializeSummariesArray(userDoc);
    if (hadLegacyFormat) {
      try {
        await cloudant.saveDocument('maia_users', userDoc);
      } catch (saveErr) {
        console.warn('Failed to persist patient summary migration:', saveErr.message);
      }
    }
    const currentSummary = getCurrentSummary(userDoc);
    const draft = userDoc.draftPatientSummary && userDoc.draftPatientSummary.text
      ? {
          text: userDoc.draftPatientSummary.text,
          draftAt: userDoc.draftPatientSummary.draftAt || null,
          generationSeconds: userDoc.draftPatientSummary.generationSeconds || null,
          medicationsSplicedAt: userDoc.draftPatientSummary.medicationsSplicedAt || null,
          medicationsCount: userDoc.draftPatientSummary.medicationsCount || null
        }
      : null;

    // Splice the verified Current Medications directly into the
    // returned summary text (no AI call, no client-side regen
    // dance). If the section is already in sync, this is a no-op.
    // When it DOES rewrite, we save the patched text back so it
    // sticks, and mark the meds section "(Patient Verified)".
    // This makes the "PS shows Not documented when meds are
    // actually verified" problem impossible.
    const hasVerifiedMeds = !!(userDoc.currentMedications && String(userDoc.currentMedications).trim());
    let returnedSummary = currentSummary ? currentSummary.text : '';
    if (hasVerifiedMeds && returnedSummary) {
      const patched = serverReplaceMedicationsInSummary(returnedSummary, String(userDoc.currentMedications).trim(), true);
      if (patched && patched !== returnedSummary) {
        returnedSummary = patched;
        // Persist the patch so subsequent loads don't have to
        // recompute. Best-effort: if the save fails (e.g.,
        // 409 conflict), we still return the patched text to the
        // client — worst case, the next load re-patches.
        try {
          currentSummary.text = patched;
          currentSummary.updatedAt = new Date().toISOString();
          await cloudant.saveDocument('maia_users', userDoc);
        } catch (e) {
          console.warn(`[patient-summary GET] Could not persist meds-patched summary for ${userId}: ${e?.message || e}`);
        }
      }
    }

    res.json({
      success: true,
      summary: returnedSummary,
      summaries: summaries.map((s, index) => ({
        text: s.text,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        isCurrent: index === summaries.length - 1
      })),
      draft
    });
  } catch (error) {
    console.error('Error fetching patient summary:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch patient summary',
      error: error.message 
    });
  }
});

app.post('/api/patient-summary', async (req, res) => {
  try {
    const { userId, summary, replaceStrategy, replaceIndex } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }

    if (!summary) {
      return res.status(400).json({ 
        success: false, 
        message: 'Summary is required',
        error: 'MISSING_SUMMARY'
      });
    }

    // Get the user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    const saveWithRetry = async (doc) => {
      try {
        await cloudant.saveDocument('maia_users', doc);
        return null;
      } catch (err) {
        return err;
      }
    };

    // Add new summary (or update current if replaceStrategy is 'keep')
    if (replaceStrategy === 'keep') {
      const summaries = initializeSummariesArray(userDoc);
      if (summaries.length > 0) {
        summaries[summaries.length - 1].text = summary;
        summaries[summaries.length - 1].updatedAt = new Date().toISOString();
        userDoc.patientSummary = summary;
      } else {
        addNewSummary(userDoc, summary, 'newest');
      }
    } else {
      addNewSummary(userDoc, summary, replaceStrategy || 'newest', replaceIndex);
    }

    userDoc.updatedAt = new Date().toISOString();
    userDoc.workflowStage = 'patient_summary';
    // Committing a summary supersedes any hidden draft from the wizard flow.
    if (userDoc.draftPatientSummary) {
      delete userDoc.draftPatientSummary;
    }

    let docToReturn = userDoc;
    let saveErr = await saveWithRetry(userDoc);
    if (saveErr && (saveErr.statusCode === 409 || saveErr.error === 'conflict')) {
      const freshDoc = await cloudant.getDocument('maia_users', userId);
      if (freshDoc) {
        if (replaceStrategy === 'keep') {
          const summaries = initializeSummariesArray(freshDoc);
          if (summaries.length > 0) {
            summaries[summaries.length - 1].text = summary;
            summaries[summaries.length - 1].updatedAt = new Date().toISOString();
            freshDoc.patientSummary = summary;
          } else {
            addNewSummary(freshDoc, summary, 'newest');
          }
        } else {
          addNewSummary(freshDoc, summary, replaceStrategy || 'newest', replaceIndex);
        }
        freshDoc.updatedAt = new Date().toISOString();
        freshDoc.workflowStage = 'patient_summary';
        if (freshDoc.draftPatientSummary) {
          delete freshDoc.draftPatientSummary;
        }
        saveErr = await saveWithRetry(freshDoc);
        if (!saveErr) docToReturn = freshDoc;
      }
    }
    if (saveErr) {
      throw saveErr;
    }
    
    const summaries = initializeSummariesArray(docToReturn);
    res.json({ 
      success: true, 
      message: 'Patient summary saved successfully',
      summaries: summaries.map((s, index) => ({
        text: s.text,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        isCurrent: index === summaries.length - 1
      }))
    });
  } catch (error) {
    console.error('Error saving patient summary:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to save patient summary',
      error: error.message 
    });
  }
});

// Swap summary endpoint - make a non-current summary the current one
app.post('/api/patient-summary/swap', async (req, res) => {
  try {
    const { userId, index } = req.body;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        message: 'User ID is required',
        error: 'MISSING_USER_ID'
      });
    }

    if (typeof index !== 'number' || index < 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Valid index is required',
        error: 'MISSING_INDEX'
      });
    }

    // Get the user document
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found',
        error: 'USER_NOT_FOUND'
      });
    }

    const swapped = swapSummary(userDoc, index);
    if (!swapped) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid index or summary is already current',
        error: 'INVALID_SWAP'
      });
    }
    
    userDoc.updatedAt = new Date().toISOString();
    await cloudant.saveDocument('maia_users', userDoc);
    
    const summaries = initializeSummariesArray(userDoc);
    res.json({ 
      success: true, 
      message: 'Summary swapped successfully',
      summaries: summaries.map((s, idx) => ({
        text: s.text,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        isCurrent: idx === summaries.length - 1
      }))
    });
  } catch (error) {
    console.error('Error swapping patient summary:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to swap patient summary',
      error: error.message 
    });
  }
});

// Serve static files from dist in production
// On DigitalOcean App Platform, NODE_ENV might not be set to 'production'
// So we also check if dist folder exists as an indicator

// Check if we're in production (before CORS setup)
const distPath = path.join(__dirname, '../dist');
const distExists = existsSync(distPath);
const isProduction = process.env.NODE_ENV === 'production' || distExists;

// Patient diary, privacy filter, and random-names API routes (must run in both dev and production)
// Get patient diary entries
app.get('/api/patient-diary', async (req, res) => {
  try {
    const userId = req.session?.userId || req.session?.deepLinkUserId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc) {
      return res.json({ success: true, entries: [], entryCount: 0 });
    }
    const entries = userDoc.patientDiary?.entries || [];
    const sortedEntries = [...entries].sort((a, b) => {
      const dateA = new Date(a.dateTime);
      const dateB = new Date(b.dateTime);
      return dateA.getTime() - dateB.getTime();
    });
    sortedEntries.forEach(entry => {
      if (entry.posted === undefined) {
        entry.posted = false;
      }
    });
    res.json({
      success: true,
      entries: sortedEntries,
      entryCount: sortedEntries.length
    });
  } catch (error) {
    console.error('GET patient-diary error:', error);
    res.status(500).json({ error: `Failed to load diary: ${error.message}` });
  }
});

app.post('/api/patient-diary', async (req, res) => {
  try {
    const userId = req.session?.userId || req.session?.deepLinkUserId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { entry } = req.body;
    if (!entry || !entry.message || !entry.dateTime) {
      return res.status(400).json({ error: 'Entry with message and dateTime is required' });
    }
    let userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc) {
      userDoc = {
        _id: userId,
        userId,
        type: 'user',
        workflowStage: 'active',
        patientDiary: { entries: [] },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    }
    if (!userDoc.patientDiary) {
      userDoc.patientDiary = { entries: [] };
    }
    const entryId = `diary-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newEntry = {
      id: entryId,
      message: entry.message.trim(),
      dateTime: entry.dateTime,
      bubbleId: entry.bubbleId || null
    };
    userDoc.patientDiary.entries.push(newEntry);
    userDoc.patientDiary.lastUpdated = new Date().toISOString();
    userDoc.updatedAt = new Date().toISOString();
    await cloudant.saveDocument('maia_users', userDoc);
    res.json({
      success: true,
      message: 'Diary entry saved successfully',
      entryId: entryId,
      entry: newEntry
    });
  } catch (error) {
    console.error('POST patient-diary error:', error);
    res.status(500).json({ error: `Failed to save diary entry: ${error.message}` });
  }
});

app.post('/api/patient-diary/mark-posted', async (req, res) => {
  try {
    const userId = req.session?.userId || req.session?.deepLinkUserId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { entryIds } = req.body;
    if (!entryIds || !Array.isArray(entryIds)) {
      return res.status(400).json({ error: 'Entry IDs array is required' });
    }
    let userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc) {
      return res.json({ success: true, message: 'No diary to update' });
    }
    if (!userDoc.patientDiary) {
      userDoc.patientDiary = { entries: [] };
    }
    let updated = false;
    userDoc.patientDiary.entries.forEach(entry => {
      if (entryIds.includes(entry.id)) {
        entry.posted = true;
        updated = true;
      }
    });
    if (updated) {
      userDoc.patientDiary.lastUpdated = new Date().toISOString();
      userDoc.updatedAt = new Date().toISOString();
      await cloudant.saveDocument('maia_users', userDoc);
    }
    res.json({
      success: true,
      message: 'Entries marked as posted',
      markedCount: entryIds.length
    });
  } catch (error) {
    console.error('Error marking diary entries as posted:', error);
    res.status(500).json({ error: `Failed to mark entries as posted: ${error.message}` });
  }
});

app.post('/api/patient-diary/update-bubble-id', async (req, res) => {
  try {
    const userId = req.session?.userId || req.session?.deepLinkUserId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { entryId, bubbleId } = req.body;
    if (!entryId || !bubbleId) {
      return res.status(400).json({ error: 'Entry ID and bubble ID are required' });
    }
    let userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc || !userDoc.patientDiary) {
      return res.json({ success: true, message: 'No diary to update' });
    }
    const entry = userDoc.patientDiary.entries.find(e => e.id === entryId);
    if (!entry) {
      return res.status(404).json({ error: 'Entry not found' });
    }
    entry.bubbleId = bubbleId;
    userDoc.patientDiary.lastUpdated = new Date().toISOString();
    userDoc.updatedAt = new Date().toISOString();
    await cloudant.saveDocument('maia_users', userDoc);
    res.json({
      success: true,
      message: 'Entry bubbleId updated successfully'
    });
  } catch (error) {
    console.error('Error updating entry bubbleId:', error);
    res.status(500).json({ error: `Failed to update bubbleId: ${error.message}` });
  }
});

app.post('/api/patient-diary/delete', async (req, res) => {
  try {
    const userId = req.session?.userId || req.session?.deepLinkUserId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { entryIds } = req.body;
    if (!entryIds || !Array.isArray(entryIds)) {
      return res.status(400).json({ error: 'Entry IDs array is required' });
    }
    let userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc || !userDoc.patientDiary) {
      return res.json({ success: true, message: 'Entries deleted successfully', deletedCount: 0 });
    }
    const initialLength = userDoc.patientDiary.entries.length;
    userDoc.patientDiary.entries = userDoc.patientDiary.entries.filter(
      entry => !entryIds.includes(entry.id)
    );
    const deletedCount = initialLength - userDoc.patientDiary.entries.length;
    if (deletedCount > 0) {
      userDoc.patientDiary.lastUpdated = new Date().toISOString();
      userDoc.updatedAt = new Date().toISOString();
      await cloudant.saveDocument('maia_users', userDoc);
    }
    res.json({
      success: true,
      message: 'Entries deleted successfully',
      deletedCount
    });
  } catch (error) {
    console.error('Error deleting diary entries:', error);
    res.status(500).json({ error: `Failed to delete entries: ${error.message}` });
  }
});

app.post('/api/privacy-filter-mapping', async (req, res) => {
  try {
    const userId = req.session?.userId || req.session?.deepLinkUserId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const { mapping } = req.body;
    if (!mapping || !Array.isArray(mapping)) {
      return res.status(400).json({ error: 'Mapping array is required' });
    }
    const userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (!userDoc.privacyFilter) {
      userDoc.privacyFilter = {};
    }
    userDoc.privacyFilter.pseudonymMapping = mapping;
    userDoc.privacyFilter.lastUpdated = new Date().toISOString();
    userDoc.updatedAt = new Date().toISOString();
    await cloudant.saveDocument('maia_users', userDoc);
    res.json({
      success: true,
      message: 'Pseudonym mapping saved successfully',
      mappingCount: mapping.length
    });
  } catch (error) {
    console.error('Error saving privacy filter mapping:', error);
    res.status(500).json({ error: `Failed to save mapping: ${error.message}` });
  }
});

app.get('/api/privacy-filter-mapping', async (req, res) => {
  try {
    const userId = req.session?.userId || req.session?.deepLinkUserId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const userDoc = await cloudant.getDocument('maia_users', userId);
    if (!userDoc) {
      return res.json({ success: true, mapping: [], lastUpdated: null, mappingCount: 0 });
    }
    const mapping = userDoc.privacyFilter?.pseudonymMapping || [];
    const lastUpdated = userDoc.privacyFilter?.lastUpdated || null;
    res.json({
      success: true,
      mapping,
      lastUpdated,
      mappingCount: mapping.length
    });
  } catch (error) {
    console.error('Error loading privacy filter mapping:', error);
    res.status(500).json({ error: `Failed to load mapping: ${error.message}` });
  }
});

app.get('/api/random-names', (req, res) => {
  const candidatePaths = [
    path.join(__dirname, '../NEW-AGENT.txt'),
    path.join(process.cwd(), 'NEW-AGENT.txt')
  ];
  const newAgentPath = candidatePaths.find(p => existsSync(p));
  if (!newAgentPath) {
    return res.json({ names: [] });
  }
  try {
    const content = readFileSync(newAgentPath, 'utf-8');
    const randomNamesSection = content.match(/## Random Names\s*\n([\s\S]*?)(?=\n---|\n##|$)/i);
    if (!randomNamesSection) {
      return res.json({ names: [] });
    }
    const names = randomNamesSection[1]
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .map(line => {
        const nameMatch = line.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+(?:\.[A-Z])?)+)/);
        return nameMatch ? nameMatch[1] : null;
      })
      .filter(name => name !== null);
    res.json({ names });
  } catch (err) {
    console.error('Error reading random names:', err);
    res.status(500).json({ error: 'Error loading random names' });
  }
});

if (isProduction) {
  const indexPath = path.join(distPath, 'index.html');
  
  // Check if index.html exists
  const indexExists = existsSync(indexPath);
  
  if (distExists) {
    try {
      const distFiles = readdirSync(distPath);
    } catch (err) {
      console.error(`❌ [STATIC] Error reading dist folder:`, err);
    }
  }
  
  // Serve Privacy.md specifically (before static middleware and catch-all)
  // This route must come BEFORE express.static to ensure it's handled correctly
  app.get('/Privacy.md', (req, res, next) => {
    const privacyPath = path.join(distPath, 'Privacy.md');
    console.log(`📄 [PRIVACY] Request for Privacy.md, checking: ${privacyPath}`);
    
    if (existsSync(privacyPath)) {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
      res.sendFile(privacyPath, (err) => {
        if (err) {
          console.error(`❌ [PRIVACY] Error serving Privacy.md:`, err);
          res.status(500).send('Error loading privacy policy');
        } else {
          console.log(`✅ [PRIVACY] Served Privacy.md from ${privacyPath}`);
        }
      });
    } else {
      console.log(`⚠️ [PRIVACY] Privacy.md not found at ${privacyPath}`);
      res.status(404).json({ error: 'Privacy policy not found' });
    }
  });

  // Serve static assets (JS, CSS, images, etc.)
  // fallthrough: true allows requests to continue to the catch-all if file not found
  // Note: Privacy.md is handled above, so it won't be served by static middleware
  app.use(express.static(distPath, {
    maxAge: '1y', // Cache static assets for 1 year (hashed filenames change on rebuild)
    etag: true,
    fallthrough: true, // Allow fallthrough to catch-all for SPA routes
    setHeaders: (res, filePath) => {
      // index.html must always revalidate — it references hashed chunk filenames
      // that change on every build. Stale index.html → 404 chunks → blank page.
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    }
  }));
  
  
  // Catch-all handler: serve index.html for all non-API routes
  // This enables client-side routing for the Vue SPA
  // IMPORTANT: This must be the LAST route handler
  app.get('*', (req, res) => {
    console.log(`🎯 [CATCH-ALL] Request: ${req.method} ${req.path}`);
    
    // Skip API routes - these should have been handled by API routes above
    if (req.path.startsWith('/api')) {
      console.log(`❌ [CATCH-ALL] API route not found: ${req.method} ${req.path}`);
      return res.status(404).json({ error: 'API endpoint not found' });
    }
    
    // Check if this is a static asset request (CSS, JS, images, etc.)
    const isStaticAsset = req.path.startsWith('/assets/') || 
                          req.path.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|webp|avif)$/);
    
    if (isStaticAsset) {
      // For static assets, check if file exists
      const filePath = path.join(distPath, req.path);
      if (existsSync(filePath)) {
        // File exists - serve it (should have been caught by static middleware, but handle it anyway)
        console.log(`📦 [CATCH-ALL] Serving static asset: ${req.path}`);
        return res.sendFile(filePath);
      } else {
        // File doesn't exist - return 404 with text/plain so browsers don't treat it as HTML
        // (Express's .send() defaults to text/html, which causes "disallowed MIME type" in Firefox for script loads)
        console.log(`❌ [CATCH-ALL] Static asset not found: ${req.path}`);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        return res.status(404).send('Asset not found');
      }
    }
    
    // For SPA routes, serve index.html (SPA fallback)
    // Must revalidate on every request so browsers never serve a stale index.html
    // that references old chunk hashes (which 404 after redeploy → blank page).
    res.setHeader('Cache-Control', 'no-cache');
    console.log(`📄 [CATCH-ALL] Serving index.html for: ${req.path}`);
    res.sendFile(indexPath, (err) => {
      if (err) {
        console.error(`❌ [CATCH-ALL] Error serving index.html from ${indexPath}:`, err);
        console.error(`❌ [CATCH-ALL] Error details:`, err.message);
        res.status(500).send('Error loading application');
      } else {
        console.log(`✅ [CATCH-ALL] Successfully served index.html for: ${req.path}`);
      }
    });
  });
} else {
  // In dev mode, serve Privacy.md from public folder
  const publicPath = path.join(__dirname, '../public');
  app.get('/Privacy.md', (req, res) => {
    const privacyPath = path.join(publicPath, 'Privacy.md');
    if (existsSync(privacyPath)) {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.sendFile(privacyPath, (err) => {
        if (err) {
          console.error(`❌ [PRIVACY] Error serving Privacy.md:`, err);
          res.status(500).send('Error loading privacy policy');
        } else {
          console.log(`✅ [PRIVACY] Served Privacy.md from ${privacyPath}`);
        }
      });
    } else {
      console.log(`⚠️ [PRIVACY] Privacy.md not found at ${privacyPath}`);
      res.status(404).send('Privacy policy not found');
    }
  });

}

// Resolve DO Inference key: prefer explicit DO_INFERENCE_KEY, then auto-create via DO API
{
  const inferenceKey = process.env.DO_INFERENCE_KEY || (process.env.DIGITALOCEAN_TOKEN ? await getOrCreateModelAccessKey(cloudant) : null);
  if (inferenceKey) {
    const source = process.env.DO_INFERENCE_KEY ? 'DO_INFERENCE_KEY env var' : 'auto-created via DO API';
    console.log(`[DO Inference] Using key from ${source}`);
    const modelsToCheck = [
      'anthropic-claude-4.6-sonnet', 'nvidia-nemotron-3-super-120b',
      'openai-gpt-5.5', 'openai-gpt-oss-120b',
      'deepseek-v4-pro', 'deepseek-r1-distill-llama-70b',
      'kimi-k2.5'
    ];
    const availableModels = new Set();
    await Promise.allSettled(modelsToCheck.map(async (model) => {
      try {
        const resp = await fetch('https://inference.do-ai.run/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${inferenceKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1 }),
          signal: AbortSignal.timeout(8000)
        });
        if (resp.ok) {
          availableModels.add(model);
        } else {
          const body = await resp.json().catch(() => ({}));
          console.log(`[DO Inference] Model ${model}: ${resp.status} — ${body.message || 'unavailable'}`);
        }
      } catch (e) {
        if (e.name === 'TimeoutError' || e.name === 'AbortError') {
          availableModels.add(model);
          console.log(`[DO Inference] Model ${model}: OK (accepted, response timed out)`);
        } else {
          console.log(`[DO Inference] Model ${model}: ${e.message}`);
        }
      }
    }));
    console.log(`[DO Inference] Accessible models: ${[...availableModels].join(', ') || 'none'}`);
    chatClient.enableDOInference(inferenceKey, availableModels);
  }
}

// Startup complete (server already listening for readiness probes)
console.log(`User app server ready on port ${PORT}`);
console.log(`Passkey (from PUBLIC_APP_URL): origin=${passkeyService.origin} rpID=${passkeyService.rpID}`);
const providers = chatClient.getAvailableProviders();
const providerModels = chatClient.getProviderModels();
const providerSummary = providers.map(p => {
  const m = providerModels[p];
  return m ? `${p} (${m})` : p;
}).join(', ');
console.log(`📊 Available Chat Providers: ${providerSummary}`);

export default app;
