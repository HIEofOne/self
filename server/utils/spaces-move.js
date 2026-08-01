import { CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { logWizMoveByKey } from './spaces-logger.js';

export async function moveObjectWithVerify({
  s3Client,
  bucketName,
  sourceKey,
  destKey,
  verifyRetries = 3,
  verifyDelayMs = 100,
  logMove = true
}) {
  if (!sourceKey || !destKey || sourceKey === destKey) {
    return;
  }

  // CopySource is transmitted as a URL path and MUST be URL-encoded per
  // segment (AWS SDK does not encode it for you). An unencoded space —
  // e.g. Apple Health's "Health Records - <name> - <date>.pdf" — produces a
  // malformed request that Spaces answers with an unparseable error, which
  // the SDK surfaces as the literal "UnknownError". Slashes stay as
  // delimiters; every other character is encoded.
  const encodedSourceKey = sourceKey.split('/').map(encodeURIComponent).join('/');
  await s3Client.send(new CopyObjectCommand({
    Bucket: bucketName,
    CopySource: `${bucketName}/${encodedSourceKey}`,
    Key: destKey
  }));

  let verified = false;
  for (let attempt = 0; attempt < verifyRetries; attempt++) {
    try {
      await s3Client.send(new HeadObjectCommand({
        Bucket: bucketName,
        Key: destKey
      }));
      verified = true;
      break;
    } catch (verifyError) {
      if (attempt < verifyRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, verifyDelayMs * Math.pow(2, attempt)));
      }
    }
  }

  if (!verified) {
    throw new Error('File move verification failed: File not found at destination. Source file preserved.');
  }

  await s3Client.send(new DeleteObjectCommand({
    Bucket: bucketName,
    Key: sourceKey
  }));

  if (logMove) {
    logWizMoveByKey(sourceKey, destKey);
  }
}
