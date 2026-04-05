/**
 * File upload and management routes
 * Handles PDF parsing, bucket uploads, and file metadata
 */

import multer from 'multer';
import pdf from 'pdf-parse';
import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { extractPdfWithPages, extractIndividualClinicalNotes } from '../utils/pdf-parser.js';
import { extractAndSaveCategoryFiles } from '../utils/lists-processor.js';
import { putObjectWithLog, deleteObjectWithLog } from '../utils/spaces-ops.js';
import { getSpacesEndpoint, getSpacesBucketName } from '../utils/storage-config.js';
import { getOwnerIdForDeepLinkSession } from './chat.js';

/**
 * Extract medication records from markdown
 * Follows the same pattern as extractIndividualClinicalNotes
 * Each medication record has: date, medication name, and dose
 * @param {string} fullMarkdown - Full markdown text from PDF
 * @param {Array} pages - Array of page objects with page numbers
 * @param {string} fileName - Source file name
 * @returns {Array} Array of medication objects
 */
function extractMedicationRecords(fullMarkdown, pages, fileName = '') {
  const medications = [];
  
  // Find ALL "Medication" or "Medication Records" sections
  // Look for headings like "### Medication Records", "## Medications", etc.
  const medicationPattern = /(?:^|\n)(?:#{1,3})\s*Medication\s+Records?\s*(?:\n|$)/gi;
  const allMatches = [];
  let match;
  
  // Find all matches
  while ((match = medicationPattern.exec(fullMarkdown)) !== null) {
    allMatches.push({
      index: match.index,
      length: match[0].length,
      start: match.index + match[0].length
    });
  }
  
  // Also try "Medications" (without "Records")
  const medicationsPattern = /(?:^|\n)(?:#{1,3})\s*Medications\s*(?:\n|$)/gi;
  while ((match = medicationsPattern.exec(fullMarkdown)) !== null) {
    // Check if this is already in allMatches
    const alreadyFound = allMatches.some(m => Math.abs(m.index - match.index) < 10);
    if (!alreadyFound) {
      allMatches.push({
        index: match.index,
        length: match[0].length,
        start: match.index + match[0].length
      });
    }
  }
  
  if (allMatches.length === 0) {
    return medications;
  }
  
  // Process each Medication section
  for (let sectionIdx = 0; sectionIdx < allMatches.length; sectionIdx++) {
    const medicationsBeforeThisSection = medications.length;
    const sectionMatch = allMatches[sectionIdx];
    const sectionStart = sectionMatch.start;
    
    // Find the end of this section (next major heading or next Medication section or end of document)
    let sectionEnd = fullMarkdown.length;
    
    // Check if there's a next Medication section
    if (sectionIdx < allMatches.length - 1) {
      sectionEnd = allMatches[sectionIdx + 1].index;
    } else {
      // Last section - find next major heading (## or #) or end of document
      const restOfMarkdown = fullMarkdown.substring(sectionStart);
      const nextMajorSectionMatch = restOfMarkdown.match(/\n(?:##|#)\s+/);
      if (nextMajorSectionMatch) {
        sectionEnd = sectionStart + nextMajorSectionMatch.index;
      }
    }
    
    // Extract this Medications section
    let medicationsSection = fullMarkdown.substring(sectionStart, sectionEnd);
    
    // Filter out common headers and footers (similar to Clinical Notes)
    const headerFooterPatterns = [
      /^Page\s+\d+/i,
      /^\d+\s*$/m,
      /^Apple\s+Health/i,
      /^Adrian\s+Gropper/i,
      /^\d{4}-\d{2}-\d{2}/,
      /^Generated\s+on/i,
      /^Exported\s+on/i,
    ];
    
    const lines = medicationsSection.split('\n');
    const filteredLines = [];
    const lineFrequency = new Map();
    
    // First pass: count line frequencies
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && trimmed.length > 0) {
        const normalized = trimmed.toLowerCase().replace(/\s+/g, ' ');
        lineFrequency.set(normalized, (lineFrequency.get(normalized) || 0) + 1);
      }
    }
    
    // Second pass: filter out headers/footers
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length === 0) {
        filteredLines.push(line);
        continue;
      }
      
      const isHeaderFooter = headerFooterPatterns.some(pattern => pattern.test(trimmed));
      const normalized = trimmed.toLowerCase().replace(/\s+/g, ' ');
      const frequency = lineFrequency.get(normalized) || 0;
      const isRepeated = frequency > 5;
      
      if (!isHeaderFooter && !isRepeated) {
        filteredLines.push(line);
      }
    }
    
    medicationsSection = filteredLines.join('\n');
    const processedLines = medicationsSection.split('\n');
    
    // Date patterns (same as Clinical Notes)
    const datePatterns = [
      /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}/i,
      /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/,
      /^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}/,
    ];
    
    // Pattern to identify medication entries:
    // Each medication record typically starts with a date line
    // Followed by location (which we'll skip)
    // Then medication name and dose on the same or next line
    let medicationIndex = 0;
    let currentDate = '';
    let currentMedication = null;
    let linesSinceDate = 0; // Track how many lines since we found a date
    
    for (let i = 0; i < processedLines.length; i++) {
      const line = processedLines[i].trim();
      if (!line) continue;
      
      // Check if this line is a date (at the start of the line)
      const isDate = datePatterns.some(pattern => pattern.test(line));
      
      if (isDate && line.length < 50) {
        // Found a date - this likely starts a new medication record
        // Save previous medication if exists
        if (currentMedication && currentMedication.name) {
          medications.push(currentMedication);
        }
        
        currentDate = line;
        currentMedication = null; // Reset for new medication
        linesSinceDate = 0; // Reset counter
        continue;
      }
      
      // If we have a date, look for medication name and dose
      if (currentDate) {
        linesSinceDate++;
        
        // If we've gone more than 5 lines without finding a valid medication, reset
        // This prevents us from treating headers/footers as medications
        if (linesSinceDate > 5 && !currentMedication) {
          currentDate = '';
          currentMedication = null;
          linesSinceDate = 0;
          continue;
        }
        // Skip location lines (common location patterns)
        const isLocation = /mass general|brigham|hospital|medical center|clinic|health center/i.test(line);
        if (isLocation) {
          continue;
        }
        
        // Skip page markers and continuation markers
        const isPageMarker = /(?:^|\s)(?:##\s*)?Page\s+\d+|Continued\s+(?:on|from)\s+Page\s+\d+|Page\s+\d+\s+of/i.test(line);
        if (isPageMarker) {
          // Reset current date if we hit a page marker - it's not a medication entry
          currentDate = '';
          currentMedication = null;
          continue;
        }
        
        // Skip header/footer patterns
        const isHeaderFooter = /Health\s+Page|Date\s+of\s+Birth|Patient\s+Name|Medical\s+Record|Chart\s+Number|MRN|Account\s+Number/i.test(line);
        if (isHeaderFooter) {
          // Reset current date if we hit header/footer - it's not a medication entry
          currentDate = '';
          currentMedication = null;
          continue;
        }
        
        // Skip lines that are too short (likely not medications) or too long (likely paragraphs)
        if (line.length < 3 || line.length > 200) {
          continue;
        }
        
        // Skip lines that look like dates only (no medication info)
        const isDateOnly = datePatterns.some(pattern => pattern.test(line) && line.length < 30);
        if (isDateOnly) {
          continue;
        }
        
        // Skip common non-medication patterns
        const nonMedicationPatterns = [
          /^Date\s+of\s+Birth/i,
          /^Patient\s+ID/i,
          /^MRN/i,
          /^Account/i,
          /^Chart/i,
          /^Record\s+Date/i,
          /^Printed/i,
          /^Generated/i,
          /^Confidential/i,
          /^Page\s+\d+/i,
          /^##\s*Page/i,
          /Continued\s+(on|from)/i,
        ];
        const isNonMedication = nonMedicationPatterns.some(pattern => pattern.test(line));
        if (isNonMedication) {
          // Reset current date - this is not a medication entry
          currentDate = '';
          currentMedication = null;
          continue;
        }
        
        // Look for medication name and dose patterns
        // Medication name is typically at the start of the line
        // Dose might be on the same line or next line
        // Pattern: medication name, possibly followed by dose (e.g., "Aspirin 81 mg" or "hydroCHLOROthiazide 12.5 mg")
        // Updated to support decimal doses: \d+\.?\d* matches integers and decimals like 12, 12.5, 0.5
        const medicationWithDoseMatch = line.match(/^(.+?)\s+(\d+\.?\d*(?:\s*mg|\s*mcg|\s*units?|\s*ml|\s*tablets?|\s*IU|\s*MEQ)?(?:\s+[a-z]+)?)/i);
        const medicationNameOnlyMatch = line.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/);
        
        if (medicationWithDoseMatch) {
          // Found medication with dose on same line
          const medName = medicationWithDoseMatch[1].trim();
          const dose = medicationWithDoseMatch[2].trim();
          
          // Validate that this looks like a real medication name
          // Exclude common non-medication patterns
          const invalidMedicationPatterns = [
            /^Page\s+\d+/i,
            /^##\s*Page/i,
            /Continued\s+(on|from)/i,
            /Date\s+of\s+Birth/i,
            /Health\s+Page/i,
            /^[A-Z][a-z]+\s+Page/i, // "Health Page", "Patient Page", etc.
            /^\d+\s*$/i, // Just numbers
            /^[A-Z]{1,3}\s*$/i, // Just initials
          ];
          
          const isInvalid = invalidMedicationPatterns.some(pattern => pattern.test(medName));
          if (isInvalid) {
            continue;
          }
          
          // Medication names should be at least 2 characters and not just numbers
          if (medName.length < 2 || /^\d+$/.test(medName)) {
            continue;
          }
          
          // Save previous medication if exists
          if (currentMedication && currentMedication.name) {
            medications.push(currentMedication);
          }
          
          currentMedication = {
            id: `${fileName}-med-${medicationIndex++}`,
            name: medName,
            dosage: dose,
            date: currentDate,
            fileName: fileName,
            page: 0, // Will be determined later
            category: 'Medications',
            content: line,
            markdown: line
          };
          
          linesSinceDate = 0; // Reset counter since we found a valid medication
        } else if (medicationNameOnlyMatch && !currentMedication) {
          // Found medication name without dose (dose might be on next line)
          const medName = medicationNameOnlyMatch[1].trim();
          
          // Validate medication name
          const invalidMedicationPatterns = [
            /^Page\s+\d+/i,
            /^##\s*Page/i,
            /Continued\s+(on|from)/i,
            /Date\s+of\s+Birth/i,
            /Health\s+Page/i,
            /^[A-Z][a-z]+\s+Page/i,
            /^\d+\s*$/i,
            /^[A-Z]{1,3}\s*$/i,
          ];
          
          const isInvalid = invalidMedicationPatterns.some(pattern => pattern.test(medName));
          if (isInvalid || medName.length < 2 || /^\d+$/.test(medName)) {
            continue;
          }
          
          currentMedication = {
            id: `${fileName}-med-${medicationIndex++}`,
            name: medName,
            dosage: '',
            date: currentDate,
            fileName: fileName,
            page: 0,
            category: 'Medications',
            content: line,
            markdown: line
          };
          
          linesSinceDate = 0; // Reset counter since we found a valid medication
        } else if (currentMedication && !currentMedication.dosage) {
          // We have a medication but no dose yet - check if this line has a dose
          // Updated to support decimal doses: \d+\.?\d* matches integers and decimals like 12, 12.5, 0.5
          const doseMatch = line.match(/(\d+\.?\d*(?:\s*mg|\s*mcg|\s*units?|\s*ml|\s*tablets?|\s*IU|\s*MEQ)?(?:\s+[a-z]+)?)/i);
          if (doseMatch) {
            currentMedication.dosage = doseMatch[1].trim();
            currentMedication.content += '\n' + line;
            currentMedication.markdown += '\n' + line;
          } else {
            // Not a dose line, might be continuation - append to content
            currentMedication.content += '\n' + line;
            currentMedication.markdown += '\n' + line;
          }
        } else if (currentMedication) {
          // Continuation line - append to content
          currentMedication.content += '\n' + line;
          currentMedication.markdown += '\n' + line;
        }
      }
    }
    
    // Add last medication if exists
    if (currentMedication && currentMedication.name) {
      medications.push(currentMedication);
    }
  }
  
  // Determine page numbers for medications (similar to Clinical Notes)
  for (let medIdx = 0; medIdx < medications.length; medIdx++) {
    const med = medications[medIdx];
    
    // Calculate the character position of this medication in the full markdown
    // We need to find which section it came from and its position within that section
    let medPage = 1;
    
    // Find which section this medication came from by checking its content
    for (let sectionIdx = 0; sectionIdx < allMatches.length; sectionIdx++) {
      const sectionStart = allMatches[sectionIdx].start;
      const sectionEnd = sectionIdx < allMatches.length - 1 
        ? allMatches[sectionIdx + 1].index 
        : fullMarkdown.length;
      
      const sectionContent = fullMarkdown.substring(sectionStart, sectionEnd);
      
      // Check if this medication's content appears in this section
      if (sectionContent.includes(med.content.substring(0, 50))) {
        // Find position within section
        const positionInSection = sectionContent.indexOf(med.content.substring(0, 50));
        const absolutePosition = sectionStart + positionInSection;
        
        // Find which page this position corresponds to
        let accumulatedLength = 0;
        for (const page of pages) {
          const pageHeader = `## Page ${page.page}\n\n`;
          const pageSeparator = `\n\n---\n\n`;
          const pageLength = pageHeader.length + page.markdown.length + pageSeparator.length;
          
          if (absolutePosition >= accumulatedLength && absolutePosition < accumulatedLength + pageLength) {
            medPage = page.page;
            break;
          }
          
          accumulatedLength += pageLength;
        }
        break;
      }
    }
    
    med.page = medPage;
  }
  
  return medications;
}

// User storage limit: 1 GB
const USER_STORAGE_LIMIT = 1024 * 1024 * 1024; // 1 GB in bytes

/**
 * Calculate total size of all files in a user's bucket folder
 * @param {S3Client} s3Client - S3 client instance
 * @param {string} bucketName - Bucket name
 * @param {string} userId - User ID
 * @returns {Promise<number>} Total size in bytes
 */
export async function getUserBucketSize(s3Client, bucketName, userId) {
  let totalSize = 0;
  let continuationToken = null;

  do {
    const listCommand = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: `${userId}/`,
      ContinuationToken: continuationToken || undefined
    });

    const result = await s3Client.send(listCommand);
    
    if (result.Contents) {
      for (const object of result.Contents) {
        // Exclude .keep files from size calculation
        if (object.Key && !object.Key.endsWith('.keep')) {
          totalSize += object.Size || 0;
        }
      }
    }

    continuationToken = result.NextContinuationToken || null;
  } while (continuationToken);

  return totalSize;
}

// Configure multer for file uploads (in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  }
});

/**
 * Extract markdown categories using Private AI
 * @param {string} markdown - Full markdown content
 * @param {string} userId - User ID
 * @param {object} cloudant - Cloudant client
 * @param {object} doClient - DigitalOcean client
 * @returns {Promise<Array<{category: string, count: number}>>} Array of categories with counts
 */
async function extractMarkdownCategories(markdown, userId, cloudant, doClient) {
  try {
    // Get user document to access agent info
    const userDoc = await cloudant.getDocument('maia_users', userId);
    
    if (!userDoc || !userDoc.assignedAgentId || !userDoc.agentEndpoint || !userDoc.agentApiKey) {
      throw new Error('Private AI agent not configured for user');
    }

    // Import DigitalOcean provider
    const { DigitalOceanProvider } = await import('../../lib/chat-client/providers/digitalocean.js');
    const { getOrCreateAgentApiKey } = await import('../utils/agent-helper.js');
    
    // Get or create API key
    const apiKey = await getOrCreateAgentApiKey(doClient, cloudant, userId, userDoc.assignedAgentId);
    
    // Create provider
    const agentProvider = new DigitalOceanProvider(apiKey, {
      baseURL: userDoc.agentEndpoint
    });

    // Create prompt
    const prompt = `List the top-level (### ....) markdown categories and the number of occurrences of that heading in the file.

Here is the markdown file:

${markdown}

Please provide a list of all top-level markdown categories (### headings) and the count of each one. Format your response as a simple list, one category per line, with the format: "Category Name: count"`;

    console.log(`🤖 [PDF-MD] Calling Private AI to extract markdown categories for user ${userId}`);

    // Call the agent (with 401 retry — stale API key auto-heals)
    const chatMessages = [{ role: 'user', content: prompt }];
    const chatOptions = { model: userDoc.agentModelName || 'openai-gpt-oss-120b', stream: false };

    let response;
    try {
      response = await agentProvider.chat(chatMessages, chatOptions);
    } catch (firstError) {
      const statusCode = firstError.status || firstError.statusCode || 0;
      if (statusCode === 401 && userDoc.assignedAgentId) {
        console.warn(`⚠️ [PDF-MD] 401 from agent for ${userId}, recreating API key...`);
        const { recreateAgentApiKey } = await import('../utils/agent-helper.js');
        const newApiKey = await recreateAgentApiKey(doClient, cloudant, userId, userDoc.assignedAgentId);
        console.log(`✅ [PDF-MD] Recreated API key for agent ${userDoc.assignedAgentId}`);
        const retryProvider = new DigitalOceanProvider(newApiKey, { baseURL: userDoc.agentEndpoint });
        response = await retryProvider.chat(chatMessages, chatOptions);
      } else {
        throw firstError;
      }
    }

    const aiResponse = response.content || response.text || '';
    
    if (!aiResponse || aiResponse.trim().length === 0) {
      throw new Error('Empty response from Private AI');
    }

    // Parse the AI response to extract categories and counts
    const categories = [];
    const lines = aiResponse.split('\n');
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      // Look for patterns like "Category Name: count" or "Category Name - count"
      const match = trimmed.match(/^(.+?)[:\-]\s*(\d+)$/);
      if (match) {
        const category = match[1].trim();
        const count = parseInt(match[2], 10);
        if (category && !isNaN(count)) {
          categories.push({ category, count });
        }
      } else {
        // Try to extract just the category name if no count format found
        // Remove markdown formatting if present
        const cleanCategory = trimmed.replace(/^###\s*/, '').replace(/^\*\s*/, '').replace(/^-\s*/, '').trim();
        if (cleanCategory) {
          categories.push({ category: cleanCategory, count: 0 });
        }
      }
    }

    console.log(`✅ [PDF-MD] Extracted ${categories.length} markdown categories`);
    return categories;
  } catch (error) {
    console.error('❌ [PDF-MD] Error extracting markdown categories:', error);
    throw error;
  }
}

// extractAndSaveCategoryFiles is now imported from '../utils/lists-processor.js'
// The function was moved to a shared utility to be used in both API endpoints and provisioning automation

// Helper function to get S3 client
function getS3Client() {
  const bucketUrl = getSpacesBucketName();
  if (!bucketUrl) {
    throw new Error('DigitalOcean bucket not configured');
  }

  const bucketName = bucketUrl.split('//')[1]?.split('.')[0] || 'maia';

  return {
    client: new S3Client({
      endpoint: getSpacesEndpoint(),
      region: 'us-east-1',
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      credentials: {
        accessKeyId: process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY || ''
      }
    }),
    bucketName
  };
}

// Helper function to parse date strings in various formats
function parseDate(dateStr) {
  if (!dateStr) return null;
  
  // Try common date formats
  // Format: "Oct 27, 2025" or "October 27, 2025"
  const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const monthMatch = dateStr.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})/i);
  if (monthMatch) {
    const month = monthNames.indexOf(monthMatch[1].toLowerCase().substring(0, 3));
    const day = parseInt(monthMatch[2], 10);
    const year = parseInt(monthMatch[3], 10);
    if (month >= 0) {
      return new Date(year, month, day);
    }
  }
  
  // Format: "10/27/2025" or "10-27-2025"
  const numericMatch = dateStr.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (numericMatch) {
    const month = parseInt(numericMatch[1], 10) - 1;
    const day = parseInt(numericMatch[2], 10);
    let year = parseInt(numericMatch[3], 10);
    if (year < 100) year += 2000; // Handle 2-digit years
    return new Date(year, month, day);
  }
  
  // Format: "2025-10-27"
  const isoMatch = dateStr.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10) - 1;
    const day = parseInt(isoMatch[3], 10);
    return new Date(year, month, day);
  }
  
  // Try native Date parsing as fallback
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }
  
  return null;
}

export default function setupFileRoutes(app, cloudant, doClient) {
  /**
   * PDF parsing endpoint
   * POST /api/files/parse-pdf
   */
  app.post('/api/files/parse-pdf', upload.single('pdfFile'), async (req, res) => {
    try {
      // Require authentication (regular user or deep-link user)
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!req.file) {
        return res.status(400).json({ error: 'No PDF file provided' });
      }

      // Security checks
      if (req.file.size === 0) {
        return res.status(400).json({ error: 'Empty file provided' });
      }
      
      if (req.file.size > 50 * 1024 * 1024) {
        return res.status(400).json({ error: 'File too large (max 50MB)' });
      }

      // Parse PDF from buffer using pdf-parse
      const data = await pdf(req.file.buffer);

      // Validate parsed content
      if (!data.text || data.text.length === 0) {
        return res.status(400).json({ error: 'Could not extract text from PDF' });
      }

      res.json({
        success: true,
        text: data.text,
        pages: data.numpages,
        characters: data.text.length
      });
    } catch (error) {
      console.error('❌ PDF parsing error:', error);
      res.status(500).json({ error: `Failed to parse PDF: ${error.message}` });
    }
  });

  /**
   * Upload file to DigitalOcean Spaces bucket
   * POST /api/files/upload
   */
  app.post('/api/files/upload', upload.single('file'), async (req, res) => {
    try {
      // Require authentication (regular user or deep-link user)
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!req.file) {
        return res.status(400).json({ error: 'No file provided' });
      }

      // Check if this is an initial import during registration (goes to KB subfolder)
      const isInitialImport = req.body.isInitialImport === 'true';
      const subfolder = req.body.subfolder || '';
      
      // For initial import, use KB subfolder. Otherwise use specified subfolder or root
      let userFolder;
      if (isInitialImport && subfolder) {
        // Initial import goes directly to KB subfolder
        userFolder = `${userId}/${subfolder}/`;
        console.log(`[NEW FLOW 2] Initial import during registration - uploading to KB folder: ${userFolder}`);
      } else if (subfolder) {
        // Regular subfolder (e.g., "References")
        userFolder = `${userId}/${subfolder}/`;
      } else {
        // Root folder
        userFolder = `${userId}/`;
      }
      
      console.log(`[NEW FLOW 2] File upload - userId: ${userId}, isInitialImport: ${isInitialImport}, userFolder: ${userFolder}`);
      
      const fileName = req.file.originalname;
      
      // Generate a unique key for the file
      const cleanName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
      const bucketKey = `${userFolder}${cleanName}`;

      // Setup S3/Spaces client
      const bucketUrl = getSpacesBucketName();
      if (!bucketUrl) {
        return res.status(500).json({
          error: 'DigitalOcean bucket not configured',
          code: 'BUCKET_NOT_CONFIGURED'
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

      // Check user's current storage usage before upload
      const currentSize = await getUserBucketSize(s3Client, bucketName, userId);
      const newFileSize = req.file.size;
      const totalSizeAfterUpload = currentSize + newFileSize;

      if (totalSizeAfterUpload > USER_STORAGE_LIMIT) {
        const currentSizeGB = (currentSize / (1024 * 1024 * 1024)).toFixed(2);
        const limitGB = (USER_STORAGE_LIMIT / (1024 * 1024 * 1024)).toFixed(2);
        const newFileSizeMB = (newFileSize / (1024 * 1024)).toFixed(2);
        const availableMB = ((USER_STORAGE_LIMIT - currentSize) / (1024 * 1024)).toFixed(2);
        
        return res.status(413).json({ 
          error: 'Storage limit exceeded',
          message: `Upload would exceed your storage limit of ${limitGB} GB. Current usage: ${currentSizeGB} GB. File size: ${newFileSizeMB} MB. Available space: ${availableMB} MB.`,
          currentSize,
          newFileSize,
          limit: USER_STORAGE_LIMIT,
          available: USER_STORAGE_LIMIT - currentSize
        });
      }

      // Upload file as binary
      await putObjectWithLog({
        s3Client,
        bucketName,
        key: bucketKey,
        body: req.file.buffer,
        contentType: req.file.mimetype,
        metadata: {
          uploadedBy: userId,
          uploadedAt: new Date().toISOString(),
          originalName: fileName
        }
      });
      
      if (isInitialImport) {
        console.log(`[NEW FLOW 2] ✅ Initial import file uploaded successfully: ${fileName} to ${bucketKey}`);
        try {
          let saved = false;
          let attempts = 0;
          while (!saved && attempts < 3) {
            attempts += 1;
            const userDoc = await cloudant.getDocument('maia_users', userId);
            if (userDoc) {
              userDoc.initialFile = {
                fileName: fileName,
                bucketKey: bucketKey,
                fileSize: req.file.size,
                uploadedAt: new Date().toISOString()
              };
              try {
                await cloudant.saveDocument('maia_users', userDoc);
                saved = true;
              } catch (saveError) {
                if (saveError?.statusCode === 409 && attempts < 3) {
                  continue;
                }
                throw saveError;
              }
            } else {
              break;
            }
          }
          if (!saved) {
            console.warn('[NEW FLOW 2] ⚠️ Initial file metadata not saved after retries');
          }
        } catch (updateError) {
          console.warn(`[NEW FLOW 2] ⚠️ Failed to store initial file metadata: ${updateError.message}`);
        }
      }

      // Generate signed URL for reading (valid for 7 days)
      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: bucketKey
      });

      const fileUrl = await getSignedUrl(s3Client, getCommand, { expiresIn: 604800 });

      res.json({
        success: true,
        fileInfo: {
          bucketKey,
          fileName,
          fileUrl,
          size: req.file.size,
          mimeType: req.file.mimetype,
          uploadedAt: new Date().toISOString(),
          userFolder
        }
      });
    } catch (error) {
      console.error('❌ File upload error:', error);
      res.status(500).json({ error: `Failed to upload file: ${error.message}` });
    }
  });

  /**
   * Register an uploaded file in the user document's files array.
   * POST /api/files/register
   * Used by RestoreWizard after uploading files to the KB folder.
   */
  app.post('/api/files/register', async (req, res) => {
    try {
      const sessionUserId = req.session?.userId || null;
      const bodyUserId = req.body?.userId || null;
      if (sessionUserId && bodyUserId && sessionUserId !== bodyUserId) {
        return res.status(403).json({ error: 'User ID mismatch', type: 'USER_ID_MISMATCH' });
      }
      const userId = sessionUserId || bodyUserId;
      console.log(`[files/register] Called: userId=${userId}, fileName=${req.body?.fileName}, bucketKey=${req.body?.bucketKey}`);
      if (!userId) return res.status(401).json({ error: 'Authentication required' });
      const { fileName, bucketKey, fileSize } = req.body;
      if (!fileName || !bucketKey) return res.status(400).json({ error: 'fileName and bucketKey required' });

      let saved = false;
      let attempts = 0;
      while (!saved && attempts < 3) {
        attempts++;
        const userDoc = await cloudant.getDocument('maia_users', userId);
        if (!userDoc) return res.status(404).json({ error: 'User not found' });
        if (!Array.isArray(userDoc.files)) userDoc.files = [];
        // Don't duplicate
        if (!userDoc.files.some(f => f.bucketKey === bucketKey)) {
          const isAppleHealth = /^apple/i.test(fileName) && /\.pdf$/i.test(fileName);
          userDoc.files.push({
            fileName,
            bucketKey,
            fileSize: fileSize || 0,
            uploadedAt: new Date().toISOString(),
            ...(isAppleHealth ? { isAppleHealth: true } : {})
          });
          userDoc.updatedAt = new Date().toISOString();
        }
        try {
          await cloudant.saveDocument('maia_users', userDoc);
          saved = true;
          console.log(`[files/register] ✅ Registered ${fileName} for ${userId} (attempt ${attempts}, files now: ${userDoc.files.length})`);
        } catch (saveErr) {
          console.warn(`[files/register] Save attempt ${attempts} failed: ${saveErr?.statusCode || saveErr?.message}`);
          if (saveErr?.statusCode === 409 && attempts < 3) continue;
          throw saveErr;
        }
      }
      if (!saved) {
        console.error(`[files/register] ❌ Failed to register ${fileName} after ${attempts} attempts`);
        return res.status(500).json({ error: 'Failed to save after retries' });
      }
      res.json({ success: true });
    } catch (error) {
      console.error('[files/register] Error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * Proxy PDF files from DigitalOcean Spaces to avoid CORS issues
   * GET /api/files/proxy-pdf/:bucketKey(*)
   * For deep link users, only allows access to files under the shared chat owner's path (ownerId/...).
   */
  app.get('/api/files/proxy-pdf/:bucketKey(*)', async (req, res) => {
    const resolveMovedKey = (key, userId, kbName) => {
      if (!key || !userId || !kbName) return key;
      const kbPrefix = `${userId}/${kbName}/`;
      if (key.startsWith(kbPrefix)) return key;
      const filename = key.split('/').pop();
      if (!filename) return key;
      return `${kbPrefix}${filename}`;
    };

    const isMissingKeyError = (err) => {
      if (!err) return false;
      return err.name === 'NotFound' ||
        err.Code === 'NoSuchKey' ||
        err.$metadata?.httpStatusCode === 404;
    };

    try {
      const { bucketKey } = req.params;
      const isDeepLink = !!req.session?.isDeepLink;
      let effectiveUserId = req.session?.userId || req.session?.deepLinkUserId;
      if (isDeepLink && cloudant) {
        const ownerId = await getOwnerIdForDeepLinkSession(req, cloudant);
        if (!ownerId) {
          return res.status(403).json({ success: false, error: 'No shared chat access' });
        }
        const ownerPrefix = ownerId + '/';
        if (!bucketKey.startsWith(ownerPrefix)) {
          return res.status(403).json({ success: false, error: 'Access denied to this file' });
        }
        effectiveUserId = ownerId;
      }
      const userId = effectiveUserId;
      
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

      let resolvedKey = bucketKey;
      try {
        const getCommand = new GetObjectCommand({
          Bucket: bucketName,
          Key: resolvedKey
        });
        const response = await s3Client.send(getCommand);

        // Set appropriate headers
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${resolvedKey.split('/').pop()}"`);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        
        // Stream the PDF content
        return response.Body.pipe(res);
      } catch (error) {
        if (!isMissingKeyError(error) || !userId) {
          throw error;
        }

        try {
          const userDoc = await cloudant.getDocument('maia_users', userId);
          const kbName = userDoc?.kbName || userDoc?.connectedKB || null;
          resolvedKey = resolveMovedKey(bucketKey, userId, kbName);

          if (resolvedKey === bucketKey) {
            throw error;
          }

          const retryCommand = new GetObjectCommand({
            Bucket: bucketName,
            Key: resolvedKey
          });
          const retryResponse = await s3Client.send(retryCommand);

          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `inline; filename="${resolvedKey.split('/').pop()}"`);
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Methods', 'GET');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
          
          return retryResponse.Body.pipe(res);
        } catch (fallbackError) {
          throw fallbackError;
        }
      }
    } catch (error) {
      if (isMissingKeyError(error)) {
        console.warn('⚠️  PDF not found for proxy request:', bucketKey);
        return res.status(404).json({
          success: false,
          error: 'PDF not found'
        });
      }

      console.error('❌ Error proxying PDF:', error);
      res.status(500).json({
        success: false,
        error: `Failed to proxy PDF: ${error.message}`
      });
    }
  });

  /**
   * Get text/markdown file content from DigitalOcean Spaces
   * GET /api/files/get-text/:bucketKey(*)
   * For deep link users, only allows access to files under the shared chat owner's path (ownerId/...).
   */
  app.get('/api/files/get-text/:bucketKey(*)', async (req, res) => {
    try {
      const isDeepLink = !!req.session?.isDeepLink;
      let effectiveUserId = req.session?.userId || req.session?.deepLinkUserId;
      if (!effectiveUserId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { bucketKey } = req.params;

      if (isDeepLink && cloudant) {
        const ownerId = await getOwnerIdForDeepLinkSession(req, cloudant);
        if (!ownerId) {
          return res.status(403).json({ success: false, error: 'No shared chat access' });
        }
        const ownerPrefix = ownerId + '/';
        if (!bucketKey.startsWith(ownerPrefix)) {
          return res.status(403).json({ success: false, error: 'Access denied to this file' });
        }
        effectiveUserId = ownerId;
      }
      const userId = effectiveUserId;
      
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

      const resolveMovedKey = (key, userId, kbName) => {
        if (!key || !userId || !kbName) return key;
        const kbPrefix = `${userId}/${kbName}/`;
        if (key.startsWith(kbPrefix)) return key;
        const filename = key.split('/').pop();
        if (!filename) return key;
        return `${kbPrefix}${filename}`;
      };

      const isMissingKeyError = (err) => {
        if (!err) return false;
        return err.name === 'NotFound' ||
          err.Code === 'NoSuchKey' ||
          err.$metadata?.httpStatusCode === 404;
      };

      let resolvedKey = bucketKey;
      let response;
      try {
        const getCommand = new GetObjectCommand({
          Bucket: bucketName,
          Key: resolvedKey
        });
        response = await s3Client.send(getCommand);
      } catch (error) {
        if (!isMissingKeyError(error)) {
          throw error;
        }

        const userDoc = await cloudant.getDocument('maia_users', userId);
        const kbName = userDoc?.kbName || userDoc?.connectedKB || null;
        resolvedKey = resolveMovedKey(bucketKey, userId, kbName);

        if (resolvedKey === bucketKey) {
          throw error;
        }

        const retryCommand = new GetObjectCommand({
          Bucket: bucketName,
          Key: resolvedKey
        });
        response = await s3Client.send(retryCommand);
      }
      
      // Read the file content as text
      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      const content = buffer.toString('utf-8');
      
      res.json({
        success: true,
        content
      });
    } catch (error) {
      if (isMissingKeyError(error)) {
        console.warn('⚠️  Text file not found:', bucketKey);
        return res.status(404).json({
          success: false,
          error: 'File not found'
        });
      }

      console.error('❌ Error fetching text file:', error);
      res.status(500).json({
        success: false,
        error: `Failed to fetch text file: ${error.message}`
      });
    }
  });

  /**
   * Parse PDF from bucket
   * GET /api/files/parse-pdf-from-bucket/:bucketKey(*)
   */
  app.get('/api/files/parse-pdf-from-bucket/:bucketKey(*)', async (req, res) => {
    try {
      // Require authentication (regular user or deep-link user)
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { bucketKey } = req.params;
      
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

      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: bucketKey
      });
      
      const response = await s3Client.send(getCommand);
      
      // Read the file content
      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      
      // Parse PDF
      const pdfData = await pdf(buffer);
      const text = pdfData.text;
      const pages = pdfData.numpages;
      
      res.json({
        success: true,
        text,
        pages
      });
    } catch (error) {
      console.error('❌ Error parsing PDF from bucket:', error);
      res.status(500).json({ 
        success: false,
        error: `Failed to parse PDF: ${error.message}` 
      });
    }
  });

  /**
   * Parse PDF first page from bucket
   * GET /api/files/parse-pdf-first-page/:bucketKey(*)
   */
  app.get('/api/files/parse-pdf-first-page/:bucketKey(*)', async (req, res) => {
    try {
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { bucketKey } = req.params;
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

      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: bucketKey
      });
      const response = await s3Client.send(getCommand);

      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      const parsed = await extractPdfWithPages(buffer);
      const firstPage = parsed?.pages?.[0];
      res.json({
        success: true,
        firstPageText: firstPage?.text || '',
        pages: parsed?.totalPages || null
      });
    } catch (error) {
      console.error('❌ Error parsing PDF first page from bucket:', error);
      res.status(500).json({
        success: false,
        error: `Failed to parse PDF: ${error.message}`
      });
    }
  });

  /**
   * Get user's storage usage
   * GET /api/files/storage-usage?userId=xxx
   */
  app.get('/api/files/storage-usage', async (req, res) => {
    try {
      const { userId } = req.query;
      
      if (!userId) {
        return res.status(400).json({ 
          error: 'MISSING_USER_ID',
          message: 'User ID is required'
        });
      }

      const bucketUrl = getSpacesBucketName();
      if (!bucketUrl) {
        return res.status(500).json({
          error: 'DigitalOcean bucket not configured',
          code: 'BUCKET_NOT_CONFIGURED'
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

      const currentSize = await getUserBucketSize(s3Client, bucketName, userId);
      const limit = USER_STORAGE_LIMIT;
      const available = Math.max(0, limit - currentSize);
      const usagePercent = limit > 0 ? ((currentSize / limit) * 100).toFixed(1) : 0;

      res.json({
        success: true,
        currentSize,
        limit,
        available,
        usagePercent: parseFloat(usagePercent),
        currentSizeGB: (currentSize / (1024 * 1024 * 1024)).toFixed(2),
        limitGB: (limit / (1024 * 1024 * 1024)).toFixed(2),
        availableGB: (available / (1024 * 1024 * 1024)).toFixed(2)
      });
    } catch (error) {
      console.error('❌ Error getting storage usage:', error);
      res.status(500).json({ 
        error: `Failed to get storage usage: ${error.message}` 
      });
    }
  });

  /**
   * Get signed URL for a file
   * GET /api/files/:bucketKey/url
   */
  app.get('/api/files/:bucketKey/url', async (req, res) => {
    try {
      const { bucketKey } = req.params;

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

      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: bucketKey
      });

      const fileUrl = await getSignedUrl(s3Client, getCommand, { expiresIn: 604800 });

      res.json({ fileUrl });
    } catch (error) {
      console.error('❌ Get signed URL error:', error);
      res.status(500).json({ error: `Failed to get file URL: ${error.message}` });
    }
  });

  /**
   * Extract PDF to markdown with page boundaries preserved
   * POST /api/files/pdf-to-markdown
   */
  app.post('/api/files/pdf-to-markdown', upload.single('pdfFile'), async (req, res) => {
    try {
      // Require authentication (regular user or deep-link user)
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!req.file) {
        return res.status(400).json({ error: 'No PDF file provided' });
      }

      // Security checks
      if (req.file.size === 0) {
        return res.status(400).json({ error: 'Empty file provided' });
      }
      
      if (req.file.size > 50 * 1024 * 1024) {
        return res.status(400).json({ error: 'File too large (max 50MB)' });
      }

      console.log(`📄 [PDF-MD] Extracting PDF to markdown with page boundaries for user ${userId}`);

      // Extract PDF with page boundaries
      const result = await extractPdfWithPages(req.file.buffer);
      const fullMarkdown = result.pages.map(p => `## Page ${p.page}\n\n${p.markdown}`).join('\n\n---\n\n');

      // Extract markdown categories using Private AI if requested
      const extractCategoriesParam = req.query.extractCategories === 'true';
      let categories = [];
      let categoryError = null;
      if (extractCategoriesParam && cloudant && doClient) {
        try {
          categories = await extractMarkdownCategories(fullMarkdown, userId, cloudant, doClient);
        } catch (error) {
          console.error('❌ [PDF-MD] Failed to extract categories:', error);
          // Store error message to return to client
          categoryError = error.message || error.toString();
          // Continue without categories rather than failing the whole request
        }
      }

      // Note: Clinical Notes processing is now done on-demand when user clicks the category
      // Clear existing files in Lists folder before saving new ones
      const { client: s3Client, bucketName } = getS3Client();
      const listsFolder = `${userId}/Lists/`;
      try {
        const listCommand = new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: listsFolder
        });
        const listResult = await s3Client.send(listCommand);
        const existingFiles = (listResult.Contents || [])
          .filter(obj => obj.Key && !obj.Key.endsWith('.keep'));
        
        for (const file of existingFiles) {
          try {
            await deleteObjectWithLog({
              s3Client,
              bucketName,
              key: file.Key
            });
          } catch (err) {
          }
        }
      } catch (clearError) {
        // Continue with processing even if clearing fails
      }

      // Save PDF and processing results to Lists folder
      let savedPdfBucketKey = null;
      let savedResultsBucketKey = null;
      try {
        const cleanFileName = req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        
        // Save PDF file to Lists folder
        savedPdfBucketKey = `${listsFolder}${cleanFileName}`;
        await putObjectWithLog({
          s3Client,
          bucketName,
          key: savedPdfBucketKey,
          body: req.file.buffer,
          contentType: 'application/pdf',
          metadata: {
            originalName: req.file.originalname,
            processedAt: new Date().toISOString(),
            userId: userId
          }
        });

        // Save processing results as JSON
        const resultsFileName = cleanFileName.replace(/\.pdf$/i, '_results.json');
        savedResultsBucketKey = `${listsFolder}${resultsFileName}`;
        const processingResults = {
          fileName: req.file.originalname,
          totalPages: result.totalPages,
          pages: result.pages,
          categories: categories,
          fullMarkdown: fullMarkdown,
          categoryError: categoryError || undefined,
          processedAt: new Date().toISOString(),
          pdfProcessedAt: new Date().toISOString() // Track when PDF was processed
        };
        
        await putObjectWithLog({
          s3Client,
          bucketName,
          key: savedResultsBucketKey,
          body: JSON.stringify(processingResults, null, 2),
          contentType: 'application/json',
          metadata: {
            originalName: req.file.originalname,
            processedAt: new Date().toISOString(),
            userId: userId
          }
        });
      } catch (saveError) {
        // Don't fail the request if saving fails
      }

      res.json({
        success: true,
        totalPages: result.totalPages,
        pages: result.pages,
        categories: categories,
        fullMarkdown: fullMarkdown,
        categoryError: categoryError || undefined,
        savedPdfBucketKey,
        savedResultsBucketKey
      });
    } catch (error) {
      console.error('❌ PDF to markdown extraction error:', error);
      res.status(500).json({ error: `Failed to extract PDF: ${error.message}` });
    }
  });

  /**
   * Extract PDF to markdown from bucket file
   * POST /api/files/pdf-to-markdown/:bucketKey(*)
   */
  app.post('/api/files/pdf-to-markdown/:bucketKey(*)', async (req, res) => {
    try {
      // Require authentication (regular user or deep-link user)
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { bucketKey } = req.params;
      
      const { client: s3Client, bucketName } = getS3Client();

      // Clear cached list files when re-processing
      try {
        const listsFolder = `${userId}/Lists/`;
        if (bucketKey.startsWith(listsFolder)) {
          // List all _list.json files and delete them
          const listCommand = new ListObjectsV2Command({
            Bucket: bucketName,
            Prefix: listsFolder
          });
          const listResult = await s3Client.send(listCommand);
          const listFiles = (listResult.Contents || [])
            .filter(obj => obj.Key && obj.Key.endsWith('_list.json'));
          
          for (const file of listFiles) {
            try {
              await deleteObjectWithLog({
                s3Client,
                bucketName,
                key: file.Key
              });
            } catch (err) {
              // Failed to delete cached file - continue
            }
          }
        }
      } catch (cacheError) {
        // Continue with processing even if cache clearing fails
      }

      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: bucketKey
      });
      
      let response;
      try {
        response = await s3Client.send(getCommand);
      } catch (s3Error) {
        if (s3Error.name === 'NoSuchKey' || s3Error.$metadata?.httpStatusCode === 404) {
          console.error(`❌ [PDF-MD] File not found: ${bucketKey}`);
          return res.status(404).json({ error: `File not found: ${bucketKey}` });
        }
        throw s3Error;
      }
      
      // Read the PDF file content
      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      const pdfBuffer = Buffer.concat(chunks);

      console.log(`📄 [PDF-MD] Extracting PDF to markdown from bucket file ${bucketKey} for user ${userId}`);

      // Extract PDF with page boundaries
      const result = await extractPdfWithPages(pdfBuffer);
      const fullMarkdown = result.pages.map(p => `## Page ${p.page}\n\n${p.markdown}`).join('\n\n---\n\n');
      const fileName = bucketKey.split('/').pop() || 'unknown.pdf';

      // Extract markdown categories using Private AI if requested
      const extractCategoriesParam = req.query.extractCategories === 'true';
      let categories = [];
      let categoryError = null;
      if (extractCategoriesParam && cloudant && doClient) {
        try {
          categories = await extractMarkdownCategories(fullMarkdown, userId, cloudant, doClient);
        } catch (error) {
          console.error('❌ [PDF-MD] Failed to extract categories:', error);
          // Store error message to return to client
          categoryError = error.message || error.toString();
          // Continue without categories rather than failing the whole request
        }
      }

      // Note: Clinical Notes processing is now done on-demand when user clicks the category
      // Clear existing files in Lists folder before saving new ones
      const listsFolder = `${userId}/Lists/`;
      try {
        const listCommand = new ListObjectsV2Command({
          Bucket: bucketName,
          Prefix: listsFolder
        });
        const listResult = await s3Client.send(listCommand);
        const existingFiles = (listResult.Contents || [])
          .filter(obj => obj.Key && !obj.Key.endsWith('.keep'));
        
        for (const file of existingFiles) {
          try {
            await deleteObjectWithLog({
              s3Client,
              bucketName,
              key: file.Key
            });
          } catch (err) {
          }
        }
      } catch (clearError) {
        // Continue with processing even if clearing fails
      }

      // Save PDF and processing results to Lists folder
      let savedPdfBucketKey = null;
      let savedResultsBucketKey = null;
      try {
        const cleanFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
        
        // Copy PDF file to Lists folder (if not already there)
        if (!bucketKey.startsWith(listsFolder)) {
          savedPdfBucketKey = `${listsFolder}${cleanFileName}`;
          await putObjectWithLog({
            s3Client,
            bucketName,
            key: savedPdfBucketKey,
            body: pdfBuffer,
            contentType: 'application/pdf',
            metadata: {
              originalName: fileName,
              processedAt: new Date().toISOString(),
              userId: userId,
              sourceBucketKey: bucketKey
            }
          });
        } else {
          savedPdfBucketKey = bucketKey;
        }

        // Save processing results as JSON
        const resultsFileName = cleanFileName.replace(/\.pdf$/i, '_results.json');
        savedResultsBucketKey = `${listsFolder}${resultsFileName}`;
        const processingResults = {
          fileName: fileName,
          totalPages: result.totalPages,
          pages: result.pages,
          categories: categories,
          fullMarkdown: fullMarkdown,
          categoryError: categoryError || undefined,
          processedAt: new Date().toISOString(),
          pdfProcessedAt: new Date().toISOString() // Track when PDF was processed
        };
        
        await putObjectWithLog({
          s3Client,
          bucketName,
          key: savedResultsBucketKey,
          body: JSON.stringify(processingResults, null, 2),
          contentType: 'application/json',
          metadata: {
            originalName: fileName,
            processedAt: new Date().toISOString(),
            userId: userId
          }
        });
      } catch (saveError) {
        // Don't fail the request if saving fails
      }

      res.json({
        success: true,
        totalPages: result.totalPages,
        pages: result.pages,
        categories: categories,
        fullMarkdown: fullMarkdown,
        categoryError: categoryError || undefined,
        savedPdfBucketKey,
        savedResultsBucketKey
      });
    } catch (error) {
      console.error('❌ PDF to markdown extraction error:', error);
      res.status(500).json({ error: `Failed to extract PDF: ${error.message}` });
    }
  });

  /**
   * Process Clinical Notes category on demand
   * POST /api/files/lists/process-category
   */
  app.post('/api/files/lists/process-category', async (req, res) => {
    try {
      // Require authentication
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { categoryName, resultsBucketKey } = req.body;
      
      if (!categoryName || !resultsBucketKey) {
        return res.status(400).json({ error: 'categoryName and resultsBucketKey are required' });
      }

      // Support Clinical Notes and Medication Records for now
      const normalizedCategory = categoryName.toLowerCase();
      const isClinicalNotes = normalizedCategory.includes('clinical notes');
      const isMedicationRecords = normalizedCategory.includes('medication');
      
      if (!isClinicalNotes && !isMedicationRecords) {
        return res.status(400).json({ error: 'Only Clinical Notes and Medication Records categories are supported' });
      }

      const { client: s3Client, bucketName } = getS3Client();

      // Load the saved processing results
      const getResultsCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: resultsBucketKey
      });

      const resultsResponse = await s3Client.send(getResultsCommand);
      const resultsChunks = [];
      for await (const chunk of resultsResponse.Body) {
        resultsChunks.push(chunk);
      }
      const resultsJson = Buffer.concat(resultsChunks).toString('utf-8');
      const processingResults = JSON.parse(resultsJson);

      // Check if we have a saved list file for this category
      const listsFolder = `${userId}/Lists/`;
      const cleanFileName = processingResults.fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
      const listFileName = `${cleanFileName.replace(/\.pdf$/i, '')}_${categoryName.toLowerCase().replace(/\s+/g, '_')}_list.json`;
      const listBucketKey = `${listsFolder}${listFileName}`;

      // Check if list file exists and if it's still valid (PDF hasn't been reprocessed)
      let existingList = null;
      let listIsStale = false;
      try {
        const getListCommand = new GetObjectCommand({
          Bucket: bucketName,
          Key: listBucketKey
        });
        const listResponse = await s3Client.send(getListCommand);
        const listChunks = [];
        for await (const chunk of listResponse.Body) {
          listChunks.push(chunk);
        }
        const listJson = Buffer.concat(listChunks).toString('utf-8');
        existingList = JSON.parse(listJson);
        
        // Check if PDF was reprocessed after list was created
        const listProcessedAt = new Date(existingList.processedAt || 0);
        const pdfProcessedAt = new Date(processingResults.pdfProcessedAt || 0);
        listIsStale = pdfProcessedAt > listProcessedAt;
      } catch (err) {
        // List file doesn't exist, that's fine
      }

      // If list exists and is not stale, return it
      if (existingList && !listIsStale) {
        return res.json({
          success: true,
          categoryName,
          list: existingList.list,
          indexed: existingList.indexed,
          processedAt: existingList.processedAt,
          fromCache: true
        });
      }

      // Process the category
      
      let individualItems = [];
      let indexedResult = null;
      
      if (isClinicalNotes) {
        // Clinical Notes: extract for display only (no OpenSearch indexing)
        individualItems = extractIndividualClinicalNotes(
          processingResults.fullMarkdown,
          processingResults.pages,
          processingResults.fileName
        );
        indexedResult = {
          total: individualItems.length,
          indexed: 0,
          errors: [],
          deleted: 0
        };
      } else if (isMedicationRecords) {
        // Process Medication Records
        individualItems = extractMedicationRecords(
          processingResults.fullMarkdown,
          processingResults.pages,
          processingResults.fileName
        );
        
        indexedResult = {
          total: individualItems.length,
          indexed: individualItems.length, // Medications are just extracted, not indexed to OpenSearch
          errors: [],
          deleted: 0
        };
      }

      // Save the processed list to file
      const listData = {
        categoryName,
        fileName: processingResults.fileName,
        list: individualItems,
        indexed: indexedResult,
        processedAt: new Date().toISOString(),
        pdfProcessedAt: processingResults.pdfProcessedAt
      };

      await putObjectWithLog({
        s3Client,
        bucketName,
        key: listBucketKey,
        body: JSON.stringify(listData, null, 2),
        contentType: 'application/json',
        metadata: {
          categoryName: categoryName,
          fileName: processingResults.fileName,
          processedAt: new Date().toISOString(),
          userId: userId
        }
      });

      res.json({
        success: true,
        categoryName,
        list: individualItems,
        indexed: indexedResult,
        processedAt: listData.processedAt,
        fromCache: false
      });
    } catch (error) {
      console.error('❌ Error processing category:', error);
      res.status(500).json({ error: `Failed to process category: ${error.message}` });
    }
  });

  /**
   * Clear all files in Lists folder when PDF is re-processed
   * POST /api/files/lists/clear-cache
   */
  app.post('/api/files/lists/clear-cache', async (req, res) => {
    try {
      // Require authentication
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { client: s3Client, bucketName } = getS3Client();
      const listsFolder = `${userId}/Lists/`;

      // List all files in Lists folder
      const listCommand = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: listsFolder
      });

      const listResult = await s3Client.send(listCommand);
      
      // Delete ALL files in Lists folder (PDF, results, and cached lists)
      const allFiles = (listResult.Contents || [])
        .filter(obj => obj.Key && !obj.Key.endsWith('.keep'));

      let deletedCount = 0;
      
      for (const file of allFiles) {
        try {
          await deleteObjectWithLog({
            s3Client,
            bucketName,
            key: file.Key
          });
          deletedCount++;
        } catch (err) {
        }
      }

      res.json({
        success: true,
        deletedCount
      });
    } catch (error) {
      console.error('❌ Error clearing Lists folder:', error);
      res.status(500).json({ error: `Failed to clear Lists folder: ${error.message}` });
    }
  });

  /**
   * Process initial file for Lists extraction
   * POST /api/files/lists/process-initial-file
   * Accepts optional bucketKey and fileName in request body to process a specific file
   */
  app.post('/api/files/lists/process-initial-file', async (req, res) => {
    try {
      // Require authentication
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { bucketKey: providedBucketKey, fileName: providedFileName } = req.body || {};
      console.log('[SAVE-RESTORE] process-initial-file request', {
        userId,
        providedBucketKey: providedBucketKey || null,
        providedFileName: providedFileName || null
      });
      
      let initialFileBucketKey;
      let initialFileName;
      let userDoc = null;

      // If bucketKey is provided in request, use it directly (for file replacement)
      if (providedBucketKey) {
        initialFileBucketKey = providedBucketKey;
        initialFileName = providedFileName || 'Replaced File';
      } else {
        // Otherwise, get from user document (original flow)
        userDoc = await cloudant.getDocument('maia_users', userId);
        if (!userDoc) {
          return res.status(404).json({ error: 'User not found' });
        }

        if (!userDoc.initialFile || !userDoc.initialFile.bucketKey) {
          console.log('[SAVE-RESTORE] process-initial-file missing initial file', {
            userId,
            hasInitialFile: !!userDoc.initialFile
          });
          return res.status(400).json({ error: 'No initial file found for this user' });
        }

        initialFileBucketKey = userDoc.initialFile.bucketKey;
        initialFileName = userDoc.initialFile.fileName;
      }
      console.log('[SAVE-RESTORE] process-initial-file resolved initial file', {
        userId,
        initialFileBucketKey,
        initialFileName
      });

      if (!userDoc) {
        userDoc = await cloudant.getDocument('maia_users', userId);
      }

      const { client: s3Client, bucketName } = getS3Client();

      // Get PDF from S3
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: initialFileBucketKey
      });
      
      let response;
      try {
        response = await s3Client.send(getCommand);
      } catch (err) {
        console.log('[SAVE-RESTORE] process-initial-file primary lookup failed', {
          userId,
          bucketKey: initialFileBucketKey,
          error: err?.message || String(err)
        });
        if (providedBucketKey) {
          return res.status(404).json({ error: `Initial file not found: ${err.message}` });
        }

        const cleanName = (initialFileName || 'Initial File').replace(/[^a-zA-Z0-9.-]/g, '_');
        const kbName = userDoc.kbName || (Array.isArray(userDoc.connectedKBs) ? userDoc.connectedKBs[0] : null) || userDoc.connectedKB;
        const fallbackKeys = new Set();

        if (kbName) {
          fallbackKeys.add(`${userId}/${kbName}/${cleanName}`);
        }
        fallbackKeys.add(`${userId}/${cleanName}`);
        fallbackKeys.add(`${userId}/archived/${cleanName}`);

        if (Array.isArray(userDoc.files)) {
          userDoc.files.forEach((file) => {
            if (!file?.bucketKey || !file?.fileName) return;
            const normalized = String(file.fileName).replace(/[^a-zA-Z0-9.-]/g, '_');
            if (normalized === cleanName || file.fileName === initialFileName) {
              fallbackKeys.add(file.bucketKey);
            }
          });
        }

        let foundKey = null;
        console.log('[SAVE-RESTORE] process-initial-file fallback keys', {
          userId,
          keys: Array.from(fallbackKeys)
        });
        for (const candidateKey of Array.from(fallbackKeys)) {
          try {
            response = await s3Client.send(new GetObjectCommand({
              Bucket: bucketName,
              Key: candidateKey
            }));
            foundKey = candidateKey;
            break;
          } catch (fallbackErr) {
            // keep trying
          }
        }

        if (!response || !foundKey) {
          console.log('[SAVE-RESTORE] process-initial-file fallback lookup failed', {
            userId,
            initialFileName,
            attempted: Array.from(fallbackKeys)
          });
          return res.status(404).json({ error: `Initial file not found: ${err.message}` });
        }

        try {
          // Re-fetch user doc to avoid revision conflict from concurrent wizard writes
          const freshDoc = await cloudant.getDocument('maia_users', userId);
          freshDoc.initialFile = {
            ...freshDoc.initialFile,
            bucketKey: foundKey,
            fileName: initialFileName || freshDoc.initialFile?.fileName || cleanName
          };
          freshDoc.updatedAt = new Date().toISOString();
          await cloudant.saveDocument('maia_users', freshDoc);
          console.log('[SAVE-RESTORE] process-initial-file initial file updated', {
            userId,
            bucketKey: foundKey
          });
        } catch (updateErr) {
          console.warn('[SAVE-RESTORE] process-initial-file update conflict (non-fatal):', updateErr?.message);
        }
      }

      // Read PDF buffer
      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      const pdfBuffer = Buffer.concat(chunks);

      // Extract PDF with page boundaries (Step 3.1)
      const result = await extractPdfWithPages(pdfBuffer);
      let fullMarkdown = result.pages.map(p => `## Page ${p.page}\n\n${p.markdown}`).join('\n\n---\n\n');
      
      // Clean up page footers: Find "Health   Page nn of mm" patterns
      // Remove all lines from footer up to (but not including) next "###" line
      // Also look backward for "Continued on " lines and remove them
      // Replace with "## Page nn" where nn is the NEXT page (footer is at end of previous page)
      const pageFooterPattern = /^.*[Hh]ealth\s+[Pp]age\s+(\d+)\s+of\s+\d+.*$/;
      const continuedOnPattern = /^.*[Cc]ontinued\s+on\s+.*$/;
      
      let pagesCleaned = 0;
      const lines = fullMarkdown.split('\n');
      const cleanedLines = [];
      let i = 0;

      while (i < lines.length) {
        const line = lines[i];
        const trimmedLine = line.trim();
        
        // Check if current line matches "Health   Page nn of mm" pattern
        const footerMatch = trimmedLine.match(pageFooterPattern);
        
        if (footerMatch) {
          // Footer "Health   Page 32 of 133" is at the END of page 32
          // The content that follows is the START of page 33
          // So we need to use pageNum + 1 for the replacement header
          const footerPageNum = parseInt(footerMatch[1], 10);
          const nextPageNum = footerPageNum + 1;
          
          // Look backward a couple of lines for "Continued on " pattern
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
            
            // Skip empty lines when counting
            if (prevTrimmed !== '') {
              linesChecked++;
            }
            
            lookBackIndex--;
          }
          
          // Remove "Continued on " line if found
          if (foundContinuedOn && continuedOnIndex >= 0) {
            cleanedLines.splice(continuedOnIndex, 1);
          }
          
          // Look ahead to find the next line that starts with "###"
          let j = i + 1;
          let foundNextHeader = false;
          let nextHeaderIndex = -1;
          
          while (j < lines.length) {
            const nextTrimmed = lines[j].trim();
            
            // Check if this line starts with "###"
            if (nextTrimmed.startsWith('###')) {
              foundNextHeader = true;
              nextHeaderIndex = j;
              break;
            }
            
            j++;
          }
          
          if (foundNextHeader && nextHeaderIndex > i) {
            // Found footer and next header - remove all lines from footer to (but not including) next header
            // Replace with "## Page nn" where nn is the NEXT page (footer was at end of previous page)
            cleanedLines.push(`## Page ${nextPageNum}`);
            pagesCleaned++;
            // Skip all lines from footer to just before the next header
            i = nextHeaderIndex;
            continue;
          } else {
            // Footer found but no next header - just remove the footer line and replace with page header
            cleanedLines.push(`## Page ${nextPageNum}`);
            pagesCleaned++;
            i++;
            continue;
          }
        }
        
        // Regular line - keep it
        cleanedLines.push(line);
        i++;
      }
      
      fullMarkdown = cleanedLines.join('\n');
      
      // Remove last 4 lines from markdown
      const markdownLines = fullMarkdown.split('\n');
      if (markdownLines.length > 4) {
        markdownLines.splice(-4);
        fullMarkdown = markdownLines.join('\n');
      }

      // Save markdown to Lists folder
      const listsFolder = `${userId}/Lists/`;
      const cleanFileName = initialFileName.replace(/[^a-zA-Z0-9.-]/g, '_');
      const markdownFileName = cleanFileName.replace(/\.pdf$/i, '.md');
      const markdownBucketKey = `${listsFolder}${markdownFileName}`;

      // Always delete existing markdown file if it exists (to ensure fresh creation)
      try {
        const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
        try {
          await s3Client.send(new HeadObjectCommand({
            Bucket: bucketName,
            Key: markdownBucketKey
          }));
          // File exists - delete it
          await deleteObjectWithLog({
            s3Client,
            bucketName,
            key: markdownBucketKey
          });
        } catch (headErr) {
          // File doesn't exist - that's fine, we'll create it
        }
      } catch (deleteErr) {
        // Continue with processing even if deletion fails
      }

      // Save markdown file
      const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
      
      try {
        await putObjectWithLog({
          s3Client,
          bucketName,
          key: markdownBucketKey,
          body: fullMarkdown,
          contentType: 'text/markdown',
          metadata: {
            fileName: initialFileName,
            processedAt: new Date().toISOString(),
            userId: userId
          }
        });
        
        // Verify the file was actually saved
        try {
          await s3Client.send(new HeadObjectCommand({
            Bucket: bucketName,
            Key: markdownBucketKey
          }));
        } catch (verifyErr) {
          throw new Error(`Markdown file was not saved successfully: ${verifyErr.message}`);
        }
      } catch (saveErr) {
        throw new Error(`Failed to save markdown file: ${saveErr.message}`);
      }

      // Extract categories and observations once, only for Apple Health imports
      let categoryFiles = [];
      const appleHealthSource = Array.isArray(userDoc?.files)
        ? userDoc.files.find(file => file?.bucketKey === initialFileBucketKey && !!file?.isAppleHealth)
        : null;
      const alreadyBuilt = !!userDoc?.appleHealthCategoriesBuiltAt;
      if (appleHealthSource && !alreadyBuilt) {
        categoryFiles = await extractAndSaveCategoryFiles(
          fullMarkdown,
          userId,
          listsFolder,
          s3Client,
          bucketName
        );
        try {
          // Re-fetch to avoid revision conflict from concurrent wizard writes
          const freshUserDoc = await cloudant.getDocument('maia_users', userId);
          freshUserDoc.appleHealthCategoriesBuiltAt = new Date().toISOString();
          freshUserDoc.appleHealthCategoriesSourceKey = initialFileBucketKey;
          await cloudant.saveDocument('maia_users', freshUserDoc);
        } catch (catSaveErr) {
          console.warn('[VIZ] Apple Health categories flag save conflict (non-fatal):', catSaveErr?.message);
        }
        console.log(`[VIZ] Categories built for Apple Health file: ${initialFileName}`);
      }

      res.json({
        success: true,
        fileName: initialFileName,
        totalPages: result.totalPages,
        pages: result.pages,
        fullMarkdown: fullMarkdown,
        markdownBucketKey: markdownBucketKey,
        categoryFiles: categoryFiles
      });
    } catch (error) {
      console.error('❌ Error processing initial file for Lists:', error);
      res.status(500).json({ error: `Failed to process initial file: ${error.message}` });
    }
  });

  /**
   * Save a category file from frontend
   * POST /api/files/lists/save-category
   */
  app.post('/api/files/lists/save-category', async (req, res) => {
    try {
      // Require authentication
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { categoryName, observations } = req.body;
      
      if (!categoryName || !observations || !Array.isArray(observations)) {
        return res.status(400).json({ error: 'categoryName and observations array are required' });
      }

      const { client: s3Client, bucketName } = getS3Client();
      const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
      
      // Sanitize category name for filename
      const sanitizedCategoryName = categoryName
        .replace(/[^a-zA-Z0-9\s-]/g, '')
        .replace(/\s+/g, '_')
        .toLowerCase();
      
      const listsFolder = `${userId}/Lists/`;
      const categoryFileName = `${sanitizedCategoryName}.md`;
      const categoryBucketKey = `${listsFolder}${categoryFileName}`;

      // Check if file already exists
      try {
        await s3Client.send(new HeadObjectCommand({
          Bucket: bucketName,
          Key: categoryBucketKey
        }));
        // File exists - don't overwrite
        return res.json({ 
          success: true, 
          message: 'Category file already exists',
          bucketKey: categoryBucketKey
        });
      } catch (headErr) {
        // File doesn't exist - proceed to save
      }

      // Build markdown content for category file (compact format, preserves metadata and page links)
      const categoryMarkdown = `# ${categoryName}\n` +
        `**Total Observations:** ${observations.length}\n` +
        observations.map(obs => {
          const parts = [];
          if (obs.date) {
            parts.push(`**Date:** ${obs.date}`);
          }
          if (obs.page) {
            parts.push(`**Page:** ${obs.page}`);
          }
          const metadata = parts.length > 0 ? parts.join(' | ') + '\n' : '';
          let line = metadata + obs.display;
          if (obs.outOfRangeLines && obs.outOfRangeLines.length > 0) {
            line += ` | **Out of Range:** ${obs.outOfRangeLines.map(l => l.trim()).join('; ')}`;
          }
          return line;
        }).join('\n---\n');

      // Save category file
      await putObjectWithLog({
        s3Client,
        bucketName,
        key: categoryBucketKey,
        body: categoryMarkdown,
        contentType: 'text/markdown',
        metadata: {
          categoryName: categoryName,
          observationCount: observations.length.toString(),
          processedAt: new Date().toISOString(),
          userId: userId
        }
      });

      res.json({
        success: true,
        bucketKey: categoryBucketKey,
        observationCount: observations.length
      });
    } catch (error) {
      console.error('Error saving category file:', error);
      res.status(500).json({ error: `Failed to save category file: ${error.message}` });
    }
  });

  /**
   * Get category file
   * GET /api/files/lists/category/:categoryName
   */
  app.get('/api/files/lists/category/:categoryName', async (req, res) => {
    try {
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const categoryNameParam = decodeURIComponent(req.params.categoryName);
      const listsFolder = `${userId}/Lists/`;
      
      // The categoryName param is already sanitized (e.g., "clinical_notes")
      // Use it directly as the filename
      const categoryFileName = `${categoryNameParam}.md`;
      const categoryBucketKey = `${listsFolder}${categoryFileName}`;

      const { client: s3Client, bucketName } = getS3Client();
      const { GetObjectCommand, HeadObjectCommand } = await import('@aws-sdk/client-s3');

      // Check if file exists
      try {
        await s3Client.send(new HeadObjectCommand({
          Bucket: bucketName,
          Key: categoryBucketKey
        }));
      } catch (headErr) {
        return res.status(404).json({ error: `Category file not found: ${categoryBucketKey}` });
      }

      // Get file content
      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: categoryBucketKey
      });
      const response = await s3Client.send(getCommand);
      
      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      const content = Buffer.concat(chunks).toString('utf-8');

      // Extract category name from filename for display (replace underscores with spaces)
      const displayCategoryName = categoryNameParam.replace(/_/g, ' ');
      
      res.json({
        success: true,
        category: displayCategoryName,
        content: content,
        bucketKey: categoryBucketKey
      });
    } catch (error) {
      console.error('❌ Error loading category file:', error);
      res.status(500).json({ error: `Failed to load category file: ${error.message}` });
    }
  });

  /**
   * List all category files
   * GET /api/files/lists/categories
   */
  app.get('/api/files/lists/categories', async (req, res) => {
    try {
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const listsFolder = `${userId}/Lists/`;
      const { client: s3Client, bucketName } = getS3Client();
      const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');

      const listCommand = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: listsFolder
      });
      const listResponse = await s3Client.send(listCommand);

      const categoryFiles = [];
      if (listResponse.Contents) {
        // Get the main markdown file name (if it exists) to exclude it
        const mainMarkdownFiles = (listResponse.Contents || [])
          .filter(obj => {
            const key = obj.Key || '';
            if (!key.endsWith('.md')) return false;
            const fileName = key.split('/').pop() || '';
            // Main markdown files have longer names (from PDF filename), not short category names
            // Category files are typically short names like "procedures.md", "medication_records.md"
            return fileName.length > 20 || /[A-Z]/.test(fileName); // Main file has longer name or mixed case
          })
          .map(obj => obj.Key);
        
        for (const obj of listResponse.Contents) {
          const key = obj.Key || '';
          // Only include .md files that are NOT the main markdown file
          if (key.endsWith('.md') && !mainMarkdownFiles.includes(key)) {
            const fileName = key.split('/').pop() || '';
            // Category files are typically short, lowercase names with underscores
            // Exclude if it looks like a main file (long name or mixed case)
            // Note: medication_records.md is 19 chars, so length < 30 is fine
            const isLikelyCategoryFile = fileName.length < 30 && 
              fileName === fileName.toLowerCase();
            
            if (isLikelyCategoryFile) {
              // Extract category name from filename
              const categoryName = fileName.replace(/\.md$/, '').replace(/_/g, ' ');
              categoryFiles.push({
                category: categoryName,
                bucketKey: key,
                fileName: fileName
              });
            }
          }
        }
      }

      res.json({
        success: true,
        categories: categoryFiles
      });
    } catch (error) {
      console.error('❌ Error listing category files:', error);
      res.status(500).json({ error: `Failed to list category files: ${error.message}` });
    }
  });

  /**
   * Clean up user document references to old lists
   * POST /api/files/lists/cleanup-user-doc
   */
  app.post('/api/files/lists/cleanup-user-doc', async (req, res) => {
    try {
      // Require authentication
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      // Get user document
      const userDoc = await cloudant.getDocument('maia_users', userId);
      if (!userDoc) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Remove any Lists-related fields if they exist
      // (Currently there are no Lists-specific fields in userDoc, but this is for future-proofing)
      let updated = false;
      
      // If we add Lists-specific fields later, clean them up here
      // For now, just log that cleanup was requested

      if (updated) {
        await cloudant.saveDocument('maia_users', userDoc);
      }

      res.json({
        success: true,
        message: 'User document cleaned up'
      });
    } catch (error) {
      console.error('❌ Error cleaning up user document:', error);
      res.status(500).json({ error: `Failed to cleanup user document: ${error.message}` });
    }
  });

  /**
   * Get markdown file from Lists folder
   * GET /api/files/lists/markdown
   */
  app.get('/api/files/lists/markdown', async (req, res) => {
    try {
      // Require authentication
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { client: s3Client, bucketName } = getS3Client();
      const listsFolder = `${userId}/Lists/`;

      // List all files in Lists folder
      const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
      const listCommand = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: listsFolder
      });

      const listResult = await s3Client.send(listCommand);
      
      // Log all files found for debugging
      const allFiles = (listResult.Contents || []).map(obj => ({
        key: obj.Key,
        size: obj.Size,
        lastModified: obj.LastModified
      }));
      
      // Find the main markdown file (exclude category files)
      // Category files have sanitized names like "procedures.md", "medication_records.md", etc.
      // The main markdown file has the original PDF filename (e.g., "Apple_Health_for_AG.md")
      const allMarkdownFiles = (listResult.Contents || [])
        .filter(obj => obj.Key && obj.Key.endsWith('.md'));
      
      // Filter out category files - they typically have lowercase names with underscores
      // and don't match the pattern of original PDF filenames
      const mainMarkdownFiles = allMarkdownFiles.filter(obj => {
        const fileName = obj.Key.split('/').pop() || '';
        // Category files are typically short names like "procedures.md", "allergies.md"
        // Main markdown files have longer names from the original PDF
        // Check if it looks like a category file (short, all lowercase with underscores, no mixed case)
        const isLikelyCategoryFile = fileName.length < 30 && 
          fileName === fileName.toLowerCase() && 
          (fileName.includes('_') || !/[A-Z]/.test(fileName));
        return !isLikelyCategoryFile;
      });
      
      // If no main markdown file found, try to find the one that's NOT a category file
      // by checking if it matches the pattern of having the original PDF name
      const markdownFiles = mainMarkdownFiles.length > 0 
        ? mainMarkdownFiles.sort((a, b) => (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0))
        : allMarkdownFiles
            .filter(obj => {
              // Exclude known category file patterns
              const fileName = obj.Key.split('/').pop() || '';
              const categoryPatterns = [
                'procedures', 'medication', 'allerg', 'clinical_notes', 'clinical_vitals',
                'lab_result', 'conditions', 'immunization'
              ];
              return !categoryPatterns.some(pattern => fileName.toLowerCase().includes(pattern));
            })
            .sort((a, b) => (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0));

      if (markdownFiles.length === 0) {
        return res.json({
          success: true,
          hasMarkdown: false,
          debug: {
            listsFolder: listsFolder,
            allFiles: allFiles
          }
        });
      }

      // Get the most recent main markdown file
      const latestMarkdownKey = markdownFiles[0].Key;
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: latestMarkdownKey
      });

      const response = await s3Client.send(getCommand);
      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      const markdown = Buffer.concat(chunks).toString('utf-8');


      res.json({
        success: true,
        hasMarkdown: true,
        markdown: markdown,
        markdownBucketKey: latestMarkdownKey
      });
    } catch (error) {
      console.error('❌ Error retrieving markdown file:', error);
      res.status(500).json({ error: `Failed to retrieve markdown: ${error.message}` });
    }
  });

  /**
   * Clean up markdown file - remove "Continued on Page" and "Continued from Page" lines
   * POST /api/files/lists/cleanup-markdown
   */
  app.post('/api/files/lists/cleanup-markdown', async (req, res) => {
    try {
      // Require authentication
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { client: s3Client, bucketName } = getS3Client();
      const listsFolder = `${userId}/Lists/`;

      // List all files in Lists folder
      const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
      const listCommand = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: listsFolder
      });

      const listResult = await s3Client.send(listCommand);
      
      // Find the most recent .md file
      const markdownFiles = (listResult.Contents || [])
        .filter(obj => obj.Key && obj.Key.endsWith('.md'))
        .sort((a, b) => (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0));

      if (markdownFiles.length === 0) {
        return res.status(404).json({ error: 'No markdown file found in Lists folder' });
      }

      // Get the most recent markdown file
      const markdownKey = markdownFiles[0].Key;
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: markdownKey
      });

      const response = await s3Client.send(getCommand);
      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      let markdown = Buffer.concat(chunks).toString('utf-8');

      // Clean up page footers: Find "Health   Page nn of mm" patterns
      // Remove all lines from footer up to (but not including) next "###" line
      // Also look backward for "Continued on " lines and remove them
      // Replace with "## Page nn" where nn is the NEXT page (footer is at end of previous page)
      const pageFooterPattern = /^.*[Hh]ealth\s+[Pp]age\s+(\d+)\s+of\s+\d+.*$/;
      const continuedOnPattern = /^.*[Cc]ontinued\s+on\s+.*$/;

      let pagesCleaned = 0;
      const lines = markdown.split('\n');
      const cleanedLines = [];
      let i = 0;

      while (i < lines.length) {
        const line = lines[i];
        const trimmedLine = line.trim();
        
        // Check if current line matches "Health   Page nn of mm" pattern
        const footerMatch = trimmedLine.match(pageFooterPattern);
        
        if (footerMatch) {
          // Footer "Health   Page 32 of 133" is at the END of page 32
          // The content that follows is the START of page 33
          // So we need to use pageNum + 1 for the replacement header
          const footerPageNum = parseInt(footerMatch[1], 10);
          const nextPageNum = footerPageNum + 1;
          
          // Look backward a couple of lines for "Continued on " pattern
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
            
            // Skip empty lines when counting
            if (prevTrimmed !== '') {
              linesChecked++;
            }
            
            lookBackIndex--;
          }
          
          // Remove "Continued on " line if found
          if (foundContinuedOn && continuedOnIndex >= 0) {
            cleanedLines.splice(continuedOnIndex, 1);
          }
          
          // Look ahead to find the next line that starts with "###"
          let j = i + 1;
          let foundNextHeader = false;
          let nextHeaderIndex = -1;
          
          while (j < lines.length) {
            const nextTrimmed = lines[j].trim();
            
            // Check if this line starts with "###"
            if (nextTrimmed.startsWith('###')) {
              foundNextHeader = true;
              nextHeaderIndex = j;
              break;
            }
            
            j++;
          }
          
          if (foundNextHeader && nextHeaderIndex > i) {
            // Found footer and next header - remove all lines from footer to (but not including) next header
            // Replace with "## Page nn" where nn is the NEXT page (footer was at end of previous page)
            cleanedLines.push(`## Page ${nextPageNum}`);
            pagesCleaned++;
            // Skip all lines from footer to just before the next header
            i = nextHeaderIndex;
            continue;
          } else {
            // Footer found but no next header - just remove the footer line and replace with page header
            cleanedLines.push(`## Page ${nextPageNum}`);
            pagesCleaned++;
            i++;
            continue;
          }
        }
        
        // Regular line - keep it
        cleanedLines.push(line);
        i++;
      }

      let cleanedMarkdown = cleanedLines.join('\n');

      // Remove last 4 lines from markdown
      const markdownLines = cleanedMarkdown.split('\n');
      if (markdownLines.length > 4) {
        markdownLines.splice(-4);
        cleanedMarkdown = markdownLines.join('\n');
      }

      // Save cleaned markdown back
      await putObjectWithLog({
        s3Client,
        bucketName,
        key: markdownKey,
        body: cleanedMarkdown,
        contentType: 'text/markdown',
        metadata: {
          cleanedAt: new Date().toISOString(),
          pagesCleaned: pagesCleaned.toString(),
          userId: userId
        }
      });


      res.json({
        success: true,
        pagesCleaned: pagesCleaned,
        markdownBucketKey: markdownKey
      });
    } catch (error) {
      console.error('❌ Error cleaning up markdown file:', error);
      res.status(500).json({ error: `Failed to cleanup markdown: ${error.message}` });
    }
  });

  /**
   * Get saved processing results from Lists folder
   * GET /api/files/lists/results
   */
  app.get('/api/files/lists/results', async (req, res) => {
    try {
      // Require authentication (regular user or deep-link user)
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { client: s3Client, bucketName } = getS3Client();
      const listsFolder = `${userId}/Lists/`;

      // List all files in Lists folder
      const listCommand = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: listsFolder
      });

      const listResult = await s3Client.send(listCommand);
      
      // Find the most recent _results.json file
      const resultsFiles = (listResult.Contents || [])
        .filter(obj => obj.Key && obj.Key.endsWith('_results.json'))
        .sort((a, b) => (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0));

      if (resultsFiles.length === 0) {
        return res.json({
          success: true,
          hasResults: false
        });
      }

      // Get the most recent results file
      const latestResultsKey = resultsFiles[0].Key;
      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: latestResultsKey
      });

      const response = await s3Client.send(getCommand);
      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      const resultsJson = Buffer.concat(chunks).toString('utf-8');
      const processingResults = JSON.parse(resultsJson);

      // Find the corresponding PDF file
      const pdfFileName = processingResults.fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
      const pdfKey = `${listsFolder}${pdfFileName}`;

      res.json({
        success: true,
        hasResults: true,
        pdfBucketKey: pdfKey,
        resultsBucketKey: latestResultsKey,
        results: processingResults
      });
    } catch (error) {
      console.error('❌ Error retrieving Lists processing results:', error);
      res.status(500).json({ error: `Failed to retrieve results: ${error.message}` });
    }
  });

  /**
   * POST /api/files/lists/current-medications
   * Get current medications from Medication Records using Private AI
   */
  app.post('/api/files/lists/current-medications', async (req, res) => {
    try {
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { medicationRecords } = req.body;

      if (!medicationRecords || !Array.isArray(medicationRecords)) {
        return res.status(400).json({ error: 'medicationRecords array is required' });
      }

      // Get user document to access agent info
      const userDoc = await cloudant.getDocument('maia_users', userId);
      
      if (!userDoc || !userDoc.assignedAgentId) {
        return res.status(400).json({ error: 'Private AI agent not configured for user' });
      }
      if (!userDoc.agentEndpoint) {
        try {
          const agent = await doClient.agent.get(userDoc.assignedAgentId);
          const endpointFromAgent = agent?.deployment?.url ? `${agent.deployment.url}/api/v1` : null;
          if (endpointFromAgent) {
            userDoc.agentEndpoint = endpointFromAgent;
            const modelNameFromAgent = agent?.model?.inference_name || agent?.model?.name || null;
            if (modelNameFromAgent) {
              userDoc.agentModelName = modelNameFromAgent;
            }
            userDoc.updatedAt = new Date().toISOString();
            await cloudant.saveDocument('maia_users', userDoc);
          }
        } catch (endpointError) {
          // ignore and fall through to error
        }
      }
      if (!userDoc.agentEndpoint) {
        return res.status(400).json({ error: 'Private AI agent not configured for user' });
      }

      // Import DigitalOcean provider
      const { DigitalOceanProvider } = await import('../../lib/chat-client/providers/digitalocean.js');
      const { getOrCreateAgentApiKey } = await import('../utils/agent-helper.js');
      
      // Get or create API key
      const apiKey = await getOrCreateAgentApiKey(doClient, cloudant, userId, userDoc.assignedAgentId);
      
      // Create provider
      const agentProvider = new DigitalOceanProvider(apiKey, {
        baseURL: userDoc.agentEndpoint
      });

      // Format medication records for the prompt
      const medicationsText = medicationRecords.map((obs, idx) => {
        return `${idx + 1}. ${obs.display || obs.date || 'Unknown medication'}`;
      }).join('\n');

      // Create prompt
      const prompt = `What are the current medications from this list?\n\n${medicationsText}\n\nPlease list only the medications that are currently active or being taken. Format your response as a clear, readable list.`;


      // Call the agent (with 401 retry — stale API key auto-heals)
      const chatMessages = [{ role: 'user', content: prompt }];
      const chatOptions = { model: userDoc.agentModelName || 'openai-gpt-oss-120b', stream: false };

      let response;
      try {
        response = await agentProvider.chat(chatMessages, chatOptions);
      } catch (firstError) {
        const statusCode = firstError.status || firstError.statusCode || 0;
        if (statusCode === 401 && userDoc.assignedAgentId) {
          console.warn(`⚠️ [MEDS] 401 from agent for ${userId}, recreating API key...`);
          const { recreateAgentApiKey } = await import('../utils/agent-helper.js');
          const newApiKey = await recreateAgentApiKey(doClient, cloudant, userId, userDoc.assignedAgentId);
          console.log(`✅ [MEDS] Recreated API key for agent ${userDoc.assignedAgentId}`);
          const retryProvider = new DigitalOceanProvider(newApiKey, { baseURL: userDoc.agentEndpoint });
          response = await retryProvider.chat(chatMessages, chatOptions);
        } else {
          throw firstError;
        }
      }

      const aiResponse = response.content || response.text || '';

      if (!aiResponse || aiResponse.trim().length === 0) {
        return res.status(500).json({ error: 'Empty response from Private AI' });
      }

      res.json({
        success: true,
        currentMedications: aiResponse.trim()
      });
    } catch (error) {
      res.status(500).json({ error: `Failed to get current medications: ${error.message}` });
    }
  });

  // ── Restore Lists markdown from local backup ──────────────────────────
  app.post('/api/files/lists/restore-markdown', async (req, res) => {
    try {
      const userId = req.session?.userId || req.session?.deepLinkUserId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { markdown, fileName } = req.body;
      if (!markdown || typeof markdown !== 'string') {
        return res.status(400).json({ error: 'markdown is required' });
      }

      const { client: s3Client, bucketName } = getS3Client();
      const listsFolder = `${userId}/Lists/`;
      // Use provided fileName or default
      const mdFileName = fileName || 'restored.md';
      const bucketKey = `${listsFolder}${mdFileName}`;

      await putObjectWithLog({
        s3Client,
        bucketName,
        key: bucketKey,
        body: markdown,
        contentType: 'text/markdown',
        metadata: {
          restoredAt: new Date().toISOString(),
          userId
        }
      });

      console.log(`✅ [LISTS-RESTORE] Wrote ${bucketKey} (${markdown.length} chars) for ${userId}`);
      res.json({ success: true, bucketKey });
    } catch (error) {
      console.error('❌ [LISTS-RESTORE] Error:', error);
      res.status(500).json({ error: `Failed to restore lists: ${error.message}` });
    }
  });
}

