/**
 * Cache policy for dist/ files: only content-hashed /assets/ may cache
 * long-term. Unhashed public/ files (never-changing names) previously
 * shipped with a 1-year TTL and could be served a year stale by browsers
 * and the CDN edge after a deploy.
 */
import { describe, it, expect } from 'vitest';
import { staticCacheControl } from '../../server/utils/static-cache.js';

describe('staticCacheControl', () => {
  it('content-hashed assets cache for a year, immutable', () => {
    expect(staticCacheControl('/app/dist/assets/index-CCu4khzt.js'))
      .toBe('public, max-age=31536000, immutable');
    expect(staticCacheControl('/app/dist/assets/index-D7zu5ZVe.css'))
      .toBe('public, max-age=31536000, immutable');
  });

  it('every .html revalidates (index.html references per-build chunk hashes)', () => {
    expect(staticCacheControl('/app/dist/index.html')).toBe('no-cache');
    expect(staticCacheControl('/app/dist/page.html')).toBe('no-cache');
    expect(staticCacheControl('/app/dist/User_Guide.html')).toBe('no-cache');
  });

  it('unhashed public/ files get a short, revalidating TTL', () => {
    expect(staticCacheControl('/app/dist/pdf.worker.min.js'))
      .toBe('public, max-age=300, must-revalidate');
    expect(staticCacheControl('/app/dist/MAIA_Request_Security_Privacy_Design.pdf'))
      .toBe('public, max-age=300, must-revalidate');
    expect(staticCacheControl('/app/dist/welcome-video.mp4'))
      .toBe('public, max-age=300, must-revalidate');
    expect(staticCacheControl('/app/dist/favicon.ico'))
      .toBe('public, max-age=300, must-revalidate');
  });

  it('handles Windows-style separators', () => {
    expect(staticCacheControl('C:\\app\\dist\\assets\\index-abc.js'))
      .toBe('public, max-age=31536000, immutable');
    expect(staticCacheControl('C:\\app\\dist\\about.html')).toBe('no-cache');
  });
});
