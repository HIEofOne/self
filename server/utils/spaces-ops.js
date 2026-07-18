import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getFileNameFromKey, getFolderLabelFromKey, logWizMove } from './spaces-logger.js';

/** S3 user metadata rides in x-amz-meta-* HTTP headers, which are part
 *  of the request signature. Non-ASCII bytes there (e.g. the invisible
 *  NARROW NO-BREAK SPACE macOS puts before "PM" in screenshot filenames)
 *  make the SDK sign one byte sequence while the wire carries another →
 *  SignatureDoesNotMatch and the whole upload fails. Object KEYS are
 *  sanitized by callers; metadata values were not — so encode any
 *  non-ASCII value (RFC 3986, reversible with decodeURIComponent). */
export const asciiSafeMetadata = (metadata) => {
  if (!metadata) return metadata;
  const out = {};
  for (const [k, v] of Object.entries(metadata)) {
    const str = String(v ?? '');
    // eslint-disable-next-line no-control-regex
    out[k] = /^[\x20-\x7e]*$/.test(str) ? str : encodeURIComponent(str);
  }
  return out;
};

export async function putObjectWithLog({
  s3Client,
  bucketName,
  key,
  body,
  contentType,
  metadata,
  fromLabel = 'local'
}) {
  await s3Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: body,
    ContentType: contentType,
    Metadata: asciiSafeMetadata(metadata)
  }));
  logWizMove(getFileNameFromKey(key), fromLabel, getFolderLabelFromKey(key));
}

export async function deleteObjectWithLog({
  s3Client,
  bucketName,
  key,
  fromLabel
}) {
  await s3Client.send(new DeleteObjectCommand({
    Bucket: bucketName,
    Key: key
  }));
  const label = fromLabel || getFolderLabelFromKey(key);
  logWizMove(getFileNameFromKey(key), label, 'deleted');
}
