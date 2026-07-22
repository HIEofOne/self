/**
 * Modal open/choice logging (New_User_Flows.md §5, step 4).
 *
 * Fewer than a third of the ~30 new-user-flow modals left any trace in
 * the provisioning log, so "I clicked something and ended up here"
 * reports could not be reconstructed. Every records-flow modal now logs
 * one event per open and per choice — 'modal:<id>:<action>' — through
 * the same /api/wizard-log the wizard events use, so they land in
 * maia-log.pdf in order with everything else.
 *
 * Fire-and-forget: logging never blocks or breaks the UI.
 */
export const logModalEvent = (
  userId: string | null | undefined,
  modal: string,
  action: string,
  details?: Record<string, unknown>
): void => {
  if (!userId) return; // pre-provisioning modals have no user log to land in
  void fetch('/api/wizard-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ event: `modal:${modal}:${action}`, userId, details: details || {} })
  }).catch(() => { /* never surface logging failures */ });
};
