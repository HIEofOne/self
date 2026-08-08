/**
 * Cache-Control policy for files served out of dist/.
 *
 * Only /assets/* filenames are content-hashed by Vite, so only they may be
 * cached long-term. Everything else in dist/ is copied verbatim from
 * public/ under a NEVER-CHANGING name (about.html, faq.html,
 * pdf.worker.min.js, the posted PDFs, welcome-video.mp4, wizard slides…).
 * The old blanket 1-year TTL let browsers and the Cloudflare edge serve
 * year-old copies of those after a deploy — a version-mismatched
 * pdf.worker.min.js paired with an upgraded pdfjs-dist being the worst
 * case (silently broken PDF parsing).
 *
 *   /assets/*       → 1 year, immutable (content-hashed names can't go stale)
 *   *.html          → no-cache (documents must track the deploy; index.html
 *                     references hashed chunk names that change every build)
 *   everything else → 5 minutes + must-revalidate (bounded staleness for
 *                     unhashed media/PDFs/workers, still cache-friendly)
 */
export function staticCacheControl(filePath) {
  const p = String(filePath).replace(/\\/g, '/');
  if (p.includes('/assets/')) return 'public, max-age=31536000, immutable';
  if (p.endsWith('.html')) return 'no-cache';
  return 'public, max-age=300, must-revalidate';
}
