#!/usr/bin/env node
/**
 * Build static HTML pages (Privacy, FAQ, About) from public/welcome.md.
 *
 * Reads sections delimited by `<!-- SECTION:name -->` from welcome.md and
 * generates standalone HTML pages in public/ matching User_Guide.html styling.
 *
 * Run automatically as part of `npm run build`. Re-run manually after editing
 * welcome.md: `node scripts/build-welcome-pages.js`
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import MarkdownIt from 'markdown-it';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, '../public');
const WELCOME_MD = resolve(PUBLIC_DIR, 'welcome.md');

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

const PAGE_META = {
  privacy: { title: 'Privacy — MAIA', heading: 'Privacy' },
  faq: { title: 'FAQ — MAIA', heading: 'Frequently Asked Questions' },
  about: { title: 'About — MAIA', heading: 'About' }
};

function extractSection(markdown, sectionName) {
  const marker = `<!-- SECTION:${sectionName} -->`;
  const start = markdown.indexOf(marker);
  if (start === -1) return '';
  const contentStart = start + marker.length;
  const nextMarker = markdown.indexOf('<!-- SECTION:', contentStart);
  return (nextMarker === -1
    ? markdown.slice(contentStart)
    : markdown.slice(contentStart, nextMarker)).trim();
}

/**
 * Parse FAQ markdown into question/answer pairs.
 * Format: top-level `* **Question?**` followed by indented `  * answer` lines.
 */
function parseFaqItems(markdown) {
  const items = [];
  const lines = markdown.split('\n');
  let currentQuestion = '';
  let answerLines = [];

  const flush = () => {
    if (currentQuestion) {
      items.push({ question: currentQuestion, answer: answerLines.join('\n').trim() });
    }
    currentQuestion = '';
    answerLines = [];
  };

  for (const line of lines) {
    const qMatch = line.match(/^\*\s+\*\*(.+?)\*\*\s*$/);
    if (qMatch) {
      flush();
      currentQuestion = qMatch[1];
      continue;
    }
    if (currentQuestion && line.match(/^\s{2,}\*/)) {
      answerLines.push(line.replace(/^\s{2,}\*\s*/, '- '));
    } else if (currentQuestion && line.trim() === '') {
      answerLines.push('');
    }
  }
  flush();
  return items;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderFaqHtml(faqItems) {
  return faqItems
    .map(item => `<details class="faq-item">
  <summary>${escapeHtml(item.question)}</summary>
  <div class="faq-answer">
${md.render(item.answer)}
  </div>
</details>`)
    .join('\n');
}

function htmlTemplate(title, heading, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      max-width: 800px;
      margin: 0 auto;
      padding: 2rem 1.5rem;
      color: #333;
      background: #fff;
    }
    h1 {
      color: #1976d2;
      border-bottom: 2px solid #1976d2;
      padding-bottom: 0.5rem;
    }
    h2 {
      color: #1976d2;
      margin-top: 2rem;
    }
    a { color: #1976d2; }
    p { margin: 0.8rem 0; }
    ul, ol { margin: 0.8rem 0 0.8rem 1.5rem; }
    li { margin: 0.3rem 0; }
    strong { font-weight: 600; }
    .faq-item {
      border-bottom: 1px solid #e0e0e0;
      padding: 0.75rem 0;
    }
    .faq-item:last-child { border-bottom: none; }
    .faq-item summary {
      cursor: pointer;
      font-weight: 600;
      font-size: 1.05rem;
      padding: 0.25rem 0;
      list-style: none;
    }
    .faq-item summary::-webkit-details-marker { display: none; }
    .faq-item summary::before {
      content: '\u25B6';
      display: inline-block;
      margin-right: 0.5rem;
      transition: transform 0.15s ease;
      color: #1976d2;
    }
    .faq-item[open] summary::before { transform: rotate(90deg); }
    .faq-answer {
      padding: 0.5rem 0 0.5rem 1.5rem;
      color: #555;
    }
    .footer {
      margin-top: 3rem;
      padding-top: 1rem;
      border-top: 1px solid #e0e0e0;
      text-align: center;
      font-size: 0.85rem;
      color: #888;
    }
  </style>
</head>
<body>

<h1>${escapeHtml(heading)}</h1>

${bodyHtml}

<div class="footer">
  CC-BY MAIA by Adrian Gropper, MD &middot; <a href="/">Back to MAIA</a>
</div>

</body>
</html>
`;
}

function buildPage(sectionName, markdown) {
  const meta = PAGE_META[sectionName];
  const sectionMd = extractSection(markdown, sectionName);
  if (!sectionMd) {
    throw new Error(`Section "${sectionName}" not found in welcome.md`);
  }

  let bodyHtml;
  if (sectionName === 'faq') {
    const items = parseFaqItems(sectionMd);
    if (items.length === 0) {
      throw new Error('FAQ section parsed to zero items — check welcome.md format');
    }
    bodyHtml = renderFaqHtml(items);
  } else {
    bodyHtml = md.render(sectionMd);
  }

  return htmlTemplate(meta.title, meta.heading, bodyHtml);
}

function main() {
  const markdown = readFileSync(WELCOME_MD, 'utf-8');

  for (const section of Object.keys(PAGE_META)) {
    const html = buildPage(section, markdown);
    const outPath = resolve(PUBLIC_DIR, `${section}.html`);
    writeFileSync(outPath, html, 'utf-8');
    console.log(`✓ Wrote ${outPath}`);
  }
}

main();
