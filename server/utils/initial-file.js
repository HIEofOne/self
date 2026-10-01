/**
 * The account's initial file (its Apple Health export, userDoc.initialFile)
 * must follow its entry in userDoc.files when indexing or archiving moves
 * the object to a new key; otherwise the Lists page and citation links open
 * a key that no longer exists.
 */
const base = (k) => String(k || '').split('/').pop();
const sane = (s) => String(s || '').replace(/[^a-zA-Z0-9.-]/g, '_');

/** Point initialFile at the current key of the same file. → true if it changed. */
export function healInitialFile(userDoc) {
  const init = userDoc?.initialFile;
  const files = Array.isArray(userDoc?.files) ? userDoc.files : [];
  if (!init || !files.length) return false;
  if (init.bucketKey && files.some((f) => f?.bucketKey === init.bucketKey)) return false;
  const wanted = init.fileName || base(init.bucketKey);
  const same = (f) => f?.bucketKey && (f.fileName === wanted || sane(f.fileName) === sane(wanted) || base(f.bucketKey) === base(init.bucketKey));
  const candidates = files.filter(same);
  const match = candidates.find((f) => f.isAppleHealth && !/\/archived\//i.test(f.bucketKey))
    || candidates.find((f) => !/\/archived\//i.test(f.bucketKey))
    || candidates[0];
  if (!match || match.bucketKey === init.bucketKey) return false;
  init.bucketKey = match.bucketKey;
  return true;
}
