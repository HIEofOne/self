import { useQuasar } from 'quasar';
import { reconnectLocalFolderWithGesture, MAIA_FOLDER_PDFS } from '../utils/localFolder';
import { writeSharingPoliciesPdf, writeSummaryPdfs, type FolderPdfResult } from '../utils/folderPdfs';
import type { AsState, PolicyCard } from '../utils/policyCards';

/**
 * Personal AS edition (group_requests.md §7): keep the folder's PDFs in step
 * with Verify and with the sharing rules, and tell the patient when the
 * browser needs their permission again to write there.
 */
export function useFolderPdfs() {
  const $q = useQuasar();

  // The browser can drop folder permission between visits; asking again
  // needs a click, so the notice carries the button.
  const askPermission = (userId: string, retry: () => Promise<FolderPdfResult>, what: string) => {
    $q.notify({
      type: 'warning',
      message: `MAIA needs your permission to save ${what} in your MAIA folder.`,
      timeout: 0,
      actions: [
        {
          label: 'Allow', color: 'white',
          handler: async () => {
            const ok = await reconnectLocalFolderWithGesture(userId);
            if (ok) report(await retry(), what);
          }
        },
        { label: 'Not now', color: 'white' }
      ]
    });
  };

  const report = (result: FolderPdfResult, what: string, onPermission?: () => void) => {
    if (result === 'no-permission' && onPermission) onPermission();
    else if (result === 'failed') $q.notify({ type: 'warning', message: `MAIA couldn't save ${what} in your folder.` });
  };

  /** Write the verified summary and its privacy-filtered copy. */
  const saveSummaryPdfs = async (userId: string): Promise<FolderPdfResult> => {
    const what = 'your Patient Summary';
    const result = await writeSummaryPdfs(userId);
    if (result === 'written') {
      $q.notify({ type: 'positive', message: `Saved in your MAIA folder: "${MAIA_FOLDER_PDFS.summary}" and its privacy-filtered copy.` });
    }
    report(result, what, () => askPermission(userId, async () => {
      const r = await writeSummaryPdfs(userId);
      if (r === 'written') $q.notify({ type: 'positive', message: `Saved in your MAIA folder: "${MAIA_FOLDER_PDFS.summary}".` });
      return r;
    }, what));
    return result;
  };

  /** Rewrite the Sharing Policies PDF (quietly when it works). */
  const saveSharingPoliciesPdf = async (userId: string, data: { cards: PolicyCard[]; asState: AsState }): Promise<FolderPdfResult> => {
    const what = 'your sharing rules';
    const result = await writeSharingPoliciesPdf(userId, data);
    report(result, what, () => askPermission(userId, () => writeSharingPoliciesPdf(userId, data), what));
    return result;
  };

  return { saveSummaryPdfs, saveSharingPoliciesPdf };
}
