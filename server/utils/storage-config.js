import { getDoRegion } from './new-agent-config.js';

/** Region used for Spaces (env DO_REGION/SPACES_REGION or NEW-AGENT.txt App Platform Settings). */
export function getSpacesRegion() {
  return process.env.DO_REGION || process.env.SPACES_REGION || getDoRegion();
}

/** Derived Spaces endpoint from region; no env var needed. */
export function getSpacesEndpoint() {
  return `https://${getSpacesRegion()}.digitaloceanspaces.com`;
}

/** Spaces bucket name. Production default 'maia'; a second deployment
 *  sharing the Spaces subscription sets SPACES_BUCKET (e.g. 'maia-test')
 *  to keep its user folders in its own bucket at no extra cost. */
export function getSpacesBucketName() {
  return process.env.SPACES_BUCKET || 'maia';
}

export function normalizeStorageEnv() {
  if (!process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID && process.env.SPACES_AWS_ACCESS_KEY_ID) {
    process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID = process.env.SPACES_AWS_ACCESS_KEY_ID;
  }
  if (!process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY && process.env.SPACES_AWS_SECRET_ACCESS_KEY) {
    process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY = process.env.SPACES_AWS_SECRET_ACCESS_KEY;
  }

  const endpoint = getSpacesEndpoint();
  const accessKeyId =
    process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID;
  const secretAccessKey =
    process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY;
  const region = getSpacesRegion();

  if (accessKeyId) {
    process.env.DIGITALOCEAN_AWS_ACCESS_KEY_ID = accessKeyId;
  }
  if (secretAccessKey) {
    process.env.DIGITALOCEAN_AWS_SECRET_ACCESS_KEY = secretAccessKey;
  }
  if (process.env.S3_FORCE_PATH_STYLE === undefined) {
    process.env.S3_FORCE_PATH_STYLE = 'false';
  }

  return {
    backend: 'spaces',
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket: getSpacesBucketName(),
    region
  };
}
