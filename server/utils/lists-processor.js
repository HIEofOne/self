/**
 * Lists Processing Utility
 * Extracts categories and observations from markdown and saves them as separate category files
 * Can be used both in API endpoints and provisioning automation
 */

/**
 * Extract categories and observations from markdown and save as separate category files
 * @param {string} fullMarkdown - Full markdown content (will be labeled with [D+P] if not already)
 * @param {string} userId - User ID
 * @param {string} listsFolder - Lists folder path (e.g., "userId/Lists/")
 * @param {object} s3Client - S3 client instance
 * @param {string} bucketName - S3 bucket name
 * @returns {Promise<Array<{category: string, bucketKey: string, observationCount: number}>>} Array of saved category files
 */
import { putObjectWithLog, deleteObjectWithLog } from './spaces-ops.js';

export async function extractAndSaveCategoryFiles(fullMarkdown, userId, listsFolder, s3Client, bucketName) {
  const categoryFiles = [];
  let lines = fullMarkdown.split('\n');
  const dateLocationPattern = /^[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}\s+\S+/i;
  
  // Label [D+P] lines if not already labeled (for backend processing)
  const categoryFirstDPlusLabeled = new Map();
  let currentCategory = null;
  
  // PRE-PASS: Label [D+P] lines
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const originalLine = lines[i];
    
    // Check for category header: "### Category Name"
    if (line.startsWith('### ')) {
      const categoryName = line.substring(4).trim();
      currentCategory = categoryName;
      if (!categoryFirstDPlusLabeled.has(categoryName)) {
        categoryFirstDPlusLabeled.set(categoryName, false);
      }
      continue;
    }
    
    // Label [D+P] lines
    if (currentCategory && !line.startsWith('[D+P] ') && dateLocationPattern.test(line)) {
      const isFirstDPlus = !categoryFirstDPlusLabeled.get(currentCategory);
      if (isFirstDPlus) {
        lines[i] = `[D+P] ${currentCategory} ${originalLine}`;
        categoryFirstDPlusLabeled.set(currentCategory, true);
      } else {
        lines[i] = `[D+P] ${originalLine}`;
      }
    }
  }
  
  // Track category boundaries: category name -> { startLine, endLine }
  const categoryBoundaries = new Map();
  
  // FIRST PASS: Find all categories and their boundaries
  let currentPage = 1;
  currentCategory = null;
  let currentCategoryStartLine = -1;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Check for page header: "## Page nn"
    const pageMatch = line.match(/^##\s+Page\s+(\d+)$/);
    if (pageMatch) {
      currentPage = parseInt(pageMatch[1], 10);
      continue;
    }
    
    // Check for category header: "### Category Name"
    if (line.startsWith('### ')) {
      // Close previous category if exists
      if (currentCategory && currentCategoryStartLine >= 0) {
        const existing = categoryBoundaries.get(currentCategory);
        if (existing) {
          existing.endLine = i - 1;
        } else {
          categoryBoundaries.set(currentCategory, {
            startLine: currentCategoryStartLine,
            endLine: i - 1,
            page: currentPage
          });
        }
      }
      
      const categoryName = line.substring(4).trim();
      currentCategory = categoryName;
      currentCategoryStartLine = i;
      
      // Initialize boundary tracking
      if (!categoryBoundaries.has(categoryName)) {
        categoryBoundaries.set(categoryName, {
          startLine: i,
          endLine: lines.length - 1,
          page: currentPage
        });
      } else {
        // Update start line if this is earlier
        const existing = categoryBoundaries.get(categoryName);
        if (i < existing.startLine) {
          existing.startLine = i;
          existing.page = currentPage;
        }
      }
      continue;
    }
  }
  
  // Close last category if exists
  if (currentCategory && currentCategoryStartLine >= 0) {
    const existing = categoryBoundaries.get(currentCategory);
    if (existing) {
      existing.endLine = lines.length - 1;
    }
  }
  
  // Helper function to find page for a line index
  const findPageForLine = (lineIndex) => {
    let page = 1;
    for (let i = 0; i <= lineIndex && i < lines.length; i++) {
      const trimmed = lines[i].trim();
      const pageMatch = trimmed.match(/^##\s+Page\s+(\d+)$/);
      if (pageMatch) {
        page = parseInt(pageMatch[1], 10);
      }
    }
    return page;
  };
  
  // SECOND PASS: Extract observations for each category and save to file
  for (const [categoryName, boundaries] of categoryBoundaries.entries()) {
    const observations = [];
    const categoryLower = categoryName.toLowerCase();
    const shouldMergeByDate = categoryLower.includes('clinical vitals') || categoryLower.includes('lab result');
    const mergedByDate = new Map();
    
    let currentObservationStart = -1;
    let currentDate = '';
    let dPlusCount = 0;
    
    // Extract observations from this category's range
    for (let i = boundaries.startLine; i <= boundaries.endLine && i < lines.length; i++) {
      const line = lines[i].trim();
      
      // Check if this is a [D+P] line (start of new observation)
      if (line.startsWith('[D+P] ')) {
        dPlusCount++;
        
        // Save previous observation if exists
        if (currentObservationStart >= 0 && currentDate) {
          const obsLines = lines.slice(currentObservationStart, i);
          const page = findPageForLine(currentObservationStart);
          
          // For Lab Results, track lines with "OUT   OF   RANG*"
          let outOfRangeLines = [];
          if (categoryLower.includes('lab result')) {
            outOfRangeLines = obsLines.filter(l => l.includes('OUT') && l.includes('OF') && l.includes('RANG'));
          }
          
          if (shouldMergeByDate) {
            const existing = mergedByDate.get(currentDate);
            if (existing) {
              existing.lineCount += obsLines.length;
              // Preserve body lines from THIS observation too, so the
              // merged entry carries every analyte reading from every
              // observation on this date (was previously dropped — only
              // a `(N lines)` summary survived).
              existing.bodyLines.push(...obsLines);
              if (categoryLower.includes('lab result') && outOfRangeLines.length > 0) {
                if (!existing.outOfRangeLines) {
                  existing.outOfRangeLines = [];
                }
                existing.outOfRangeLines.push(...outOfRangeLines);
              }
            } else {
              mergedByDate.set(currentDate, {
                lineCount: obsLines.length,
                bodyLines: [...obsLines],
                page,
                outOfRangeLines: categoryLower.includes('lab result') ? outOfRangeLines : undefined
              });
            }
          } else {
            // Format observation based on category type
            const display = formatObservationForCategory(categoryName, currentDate, obsLines, page);
            if (display) {
              observations.push({ date: currentDate, display, page });
            }
          }
        }
        
        // Extract date from [D+P] line
        const dateMatch = line.match(/([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})/);
        if (dateMatch) {
          currentDate = dateMatch[1];
          currentObservationStart = i;
        }
      }
    }
    
    // Save last observation
    if (currentObservationStart >= 0 && currentDate) {
      const obsLines = lines.slice(currentObservationStart, boundaries.endLine + 1);
      const page = findPageForLine(currentObservationStart);
      
      let outOfRangeLines = [];
      if (categoryLower.includes('lab result')) {
        outOfRangeLines = obsLines.filter(l => l.includes('OUT') && l.includes('OF') && l.includes('RANG'));
      }
      
      if (shouldMergeByDate) {
        const existing = mergedByDate.get(currentDate);
        if (existing) {
          existing.lineCount += obsLines.length;
          existing.bodyLines.push(...obsLines);
          if (categoryLower.includes('lab result') && outOfRangeLines.length > 0) {
            if (!existing.outOfRangeLines) {
              existing.outOfRangeLines = [];
            }
            existing.outOfRangeLines.push(...outOfRangeLines);
          }
        } else {
          mergedByDate.set(currentDate, {
            lineCount: obsLines.length,
            bodyLines: [...obsLines],
            page,
            outOfRangeLines: categoryLower.includes('lab result') && outOfRangeLines.length > 0 ? outOfRangeLines : undefined
          });
        }
      } else {
        const display = formatObservationForCategory(categoryName, currentDate, obsLines, page);
        if (display) {
          observations.push({ date: currentDate, display, page });
        }
      }
    }
    
    // For Clinical Vitals and Lab Results, convert merged dates to
    // observations. Pass the accumulated bodyLines (every observation
    // line from every reading on that date) through to the formatter
    // so the actual analyte names + values survive into the sidecar.
    if (shouldMergeByDate) {
      for (const [date, data] of mergedByDate.entries()) {
        const display = formatObservationForCategory(categoryName, date, data.bodyLines || [], data.page, data.lineCount);
        if (display) {
          observations.push({
            date, display, page: data.page, lineCount: data.lineCount,
            outOfRangeLines: data.outOfRangeLines
          });
        }
      }
    }
    
    // Special handling for Allergies: if no [D+P] lines found, treat entire category as one observation
    if (categoryLower.includes('allerg') && dPlusCount === 0 && boundaries.endLine > boundaries.startLine) {
      const allLines = lines.slice(boundaries.startLine, boundaries.endLine + 1);
      const page = findPageForLine(boundaries.startLine);
      const display = formatObservationForCategory(categoryName, '', allLines, page);
      if (display && allLines.length > 1) {
        observations.push({ date: '', display, page });
      }
    }
    
    // Save category file if there are observations
    if (observations.length > 0) {
      // Sanitize category name for filename
      const sanitizedCategoryName = categoryName
        .replace(/[^a-zA-Z0-9\s-]/g, '')
        .replace(/\s+/g, '_')
        .toLowerCase();
      
      const categoryFileName = `${sanitizedCategoryName}.md`;
      const categoryBucketKey = `${listsFolder}${categoryFileName}`;
      
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
      
      // Delete existing category file if it exists
      try {
        await deleteObjectWithLog({
          s3Client,
          bucketName,
          key: categoryBucketKey
        });
      } catch (deleteErr) {
        // File doesn't exist - that's fine
      }
      
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
      
      
      categoryFiles.push({
        category: categoryName,
        bucketKey: categoryBucketKey,
        observationCount: observations.length
      });
    }
  }
  
  return categoryFiles;
}

/**
 * Format observation display based on category type (server-side version)
 */
function formatObservationForCategory(categoryName, date, obsLines, page, lineCount) {
  const categoryLower = categoryName.toLowerCase();
  
  if (categoryLower.includes('allerg')) {
    // Allergies: Display only lines that look like allergy entries
    if (obsLines.length >= 1) {
      const allergyLines = obsLines.filter(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('###') || trimmed.startsWith('## ')) {
          return false;
        }
        const firstChar = trimmed.charAt(0);
        return firstChar === firstChar.toUpperCase() && firstChar !== firstChar.toLowerCase();
      });
      
      if (allergyLines.length > 0) {
        const formattedLines = allergyLines.map(line => {
          const trimmed = line.trim();
          const firstSpaceIndex = trimmed.indexOf(' ');
          if (firstSpaceIndex > 0) {
            const firstWord = trimmed.substring(0, firstSpaceIndex);
            const rest = trimmed.substring(firstSpaceIndex + 1);
            return `**${firstWord}** ${rest}`;
          }
          return `**${trimmed}**`;
        });
        
        return date ? `${date} ${formattedLines.join(' ')}` : formattedLines.join(' ');
      }
    }
    return date || '';
  } else if (categoryLower.includes('medication')) {
    // Medications: Date + medication name + dose (both in bold)
    if (obsLines.length > 1) {
      const nextLine = obsLines[1]?.trim() || '';
      const parts = nextLine.split(/\s+/);
      if (parts.length >= 2) {
        const medicationName = parts[0];
        const dose = parts.slice(1).join(' ');
        return `${date} **${medicationName}** **${dose}**`;
      }
      return `${date} **${nextLine}**`;
    }
    return date || '';
  } else if (categoryLower.includes('clinical notes')) {
    // Clinical Notes: Date + observation name (Line 1 of 5) + Author (Line 2 of 5)
    if (obsLines.length >= 3) {
      const typeLine = obsLines[1]?.trim() || '';
      const authorLine = obsLines[2]?.trim() || '';
      let type = typeLine.replace(/^Type:\s*/i, '').trim();
      let author = authorLine.replace(/^Author:\s*/i, '').trim();
      if (!type) type = typeLine;
      if (!author) author = authorLine;
      return `${date} **${type || 'N/A'}** by **${author || 'N/A'}**`;
    } else if (obsLines.length >= 2) {
      const typeLine = obsLines[1]?.trim() || '';
      return `${date} **${typeLine || 'N/A'}** by **N/A**`;
    }
    return date || '';
  } else if (categoryLower.includes('procedure') || 
             categoryLower.includes('condition') || 
             categoryLower.includes('immunization')) {
    // Procedures, Conditions, Immunizations: Date + entire line following [D+P] (in bold)
    if (obsLines.length > 1) {
      let nextLine = obsLines[1]?.trim() || '';
      if (categoryLower.includes('procedure') && nextLine.startsWith('## ')) {
        nextLine = nextLine.substring(3).trim();
      }
      return `${date} **${nextLine}**`;
    }
    return date || '';
  } else if (categoryLower.includes('clinical vitals') ||
             categoryLower.includes('lab result')) {
    // Clinical Vitals, Lab Results: preserve the actual analyte readings,
    // not just the date + line count (the old behavior wiped out the
    // analyte names and values, which made `Lists/lab_results.md`
    // useless for both RAG retrieval AND deterministic "list all TSH"
    // queries — every entry collapsed to "Aug 11, 2025 (4 lines)").
    //
    // Each observation in the AH PDF looks like one [D+P] header line
    // plus N body lines until the next [D+P]. The header is just a
    // date marker; the body lines carry "TSH: 6.13 uIU/mL (H)" etc.
    // We join the BODY lines (skipping the header line) with a `; `
    // separator so each observation date renders as one line per entry.
    // Out-of-range markers (the lines containing "OUT … OF … RANG")
    // are appended separately by the caller via obs.outOfRangeLines.
    const bodyLines = (obsLines || []).slice(1)
      .map(l => String(l || '').trim())
      .filter(l => l && !l.startsWith('[D+P]') && !l.startsWith('##') && !l.startsWith('### '));
    if (bodyLines.length === 0) {
      // No body — fall back to the old date+count summary so the entry
      // is still represented (better than nothing).
      const count = lineCount ?? obsLines.length;
      return `${date} (${count} line${count !== 1 ? 's' : ''})`;
    }
    return `${date} ${bodyLines.join('; ')}`;
  }
  
  // Default: just show date
  return date || '';
}
