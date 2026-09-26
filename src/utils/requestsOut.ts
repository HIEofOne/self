/**
 * The user's requests to other MAIAs (P11, server/routes/gnap-out.js): this
 * MAIA sends them for its user, on the user's Send only, waits for the
 * answers on the server, and saves each answer to Received/ in the folder.
 */
export interface OutRequest {
  id: string;
  label: string;
  host: string;
  pageUrl: string;
  what: string;
  why: string;
  message: string;
  draftedBy: 'user' | 'private-ai';
  state: 'sending' | 'verify' | 'waiting' | 'answered' | 'declined' | 'expired' | 'withdrawn' | 'failed';
  error: string | null;
  recognized: boolean;
  verifyUrl: string | null;
  saved: string | boolean | null;
  createdAt: string;
  answeredAt: string | null;
}

export interface SendOut {
  link: string;
  label: string;
  what: string;
  why: string;
  message: string;
  fromName: string;
  draftedBy: 'user' | 'private-ai';
}

const SEND_ERRORS: Record<string, string> = {
  BAD_LINK: 'That isn’t a MAIA request link. It looks like https://…/r/ followed by 32 letters and digits.',
  OWN_LINK: 'That is your own request link.',
  NO_FOLDER_KEY: 'Connect your MAIA folder first: answers are saved there.',
  TOO_MANY_TODAY: 'You have sent a lot of requests today. Try again tomorrow.',
  NAME_NEEDED: 'Say your name, so they know who is asking.',
  LINK_GONE: 'That link doesn’t work anymore. Ask them for their current link.',
  INVALID_REQUEST: 'Choose what you are asking for and why.'
};

const post = (url: string, body: Record<string, unknown>) => fetch(url, {
  method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

/** Send (the user's click). → the request, or throws with a readable reason. */
export async function sendOut(userId: string, s: SendOut): Promise<OutRequest> {
  const r = await post('/api/gnap/out', { userId, ...s });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.success) throw new Error(SEND_ERRORS[d.error] || 'The request couldn’t be sent. Try again.');
  return d.request as OutRequest;
}

export async function listOut(userId: string): Promise<OutRequest[]> {
  const r = await fetch(`/api/gnap/out?userId=${encodeURIComponent(userId)}`, { credentials: 'include', cache: 'no-store' });
  const d = await r.json().catch(() => ({}));
  return r.ok && d.success ? d.requests : [];
}

export async function refreshOut(userId: string, id: string): Promise<OutRequest | null> {
  const r = await post(`/api/gnap/out/${encodeURIComponent(id)}/refresh`, { userId });
  const d = await r.json().catch(() => ({}));
  return r.ok && d.success ? d.request : null;
}

export async function withdrawOut(userId: string, id: string): Promise<OutRequest | null> {
  const r = await post(`/api/gnap/out/${encodeURIComponent(id)}/withdraw`, { userId });
  const d = await r.json().catch(() => ({}));
  return r.ok && d.success ? d.request : null;
}

/** What a request's state means, for the user. */
export const OUT_STATE: Record<OutRequest['state'], { label: string; color: string }> = {
  sending: { label: 'Sending', color: 'grey-6' },
  verify: { label: 'Confirm your email', color: 'orange-8' },
  waiting: { label: 'Waiting for their answer', color: 'primary' },
  answered: { label: 'Answered', color: 'green-7' },
  declined: { label: 'Declined', color: 'grey-7' },
  expired: { label: 'Expired', color: 'grey-6' },
  withdrawn: { label: 'Withdrawn', color: 'grey-6' },
  failed: { label: 'Not sent', color: 'negative' }
};

/** After Send: what to tell the user. */
export const afterSendNote = (r: OutRequest) => (r.state === 'verify'
  ? 'Sent. The first time, they need to know it’s you: confirm your email on their MAIA’s page.'
  : r.state === 'answered' ? 'They shared it. MAIA saves it in your MAIA folder, in Received.'
    : r.state === 'declined' ? 'They declined this request.'
      : r.state === 'failed' ? (r.error || 'The request couldn’t be sent.')
        : 'Sent. Your MAIA waits for their answer and tells you when there is one.');
