import { reactive } from 'vue';

/**
 * Shared, single-instance verified-email state for the welcome page.
 *
 * Two entry points touch the same address: the policy table's "Verified email"
 * cell and the setup form's notification-email checkbox. Because both read and
 * write this one reactive object, verifying (or editing) in one place is
 * mirrored in the other — the cross-fill the welcome flow asks for.
 *
 * Pre-auth: the pending code lives in the server session. On GET STARTED the
 * verified address is promoted to the new userDoc; if the user never joins the
 * Trustee group it is purged 72h later (server daily sweep).
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface VerifiedEmailState {
  email: string;
  verified: boolean;
  codeSent: boolean;
  sending: boolean;
  verifying: boolean;
  error: string;
  devCode: string | null; // only when email delivery is disabled (local dev)
  token: string | null;   // opaque handle to the server-side pending code
}

// The token is the only thing worth surviving a reload — the pending code
// lives server-side, keyed by it. sessionStorage keeps it per-tab/session.
const TOKEN_KEY = 'maiaEmailVerifyToken';
const loadToken = (): string | null => {
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
};
const saveToken = (t: string | null) => {
  try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
};

const state = reactive<VerifiedEmailState>({
  email: '', verified: false, codeSent: false, sending: false, verifying: false,
  error: '', devCode: null, token: loadToken()
});

const isValid = (e: string) => EMAIL_RE.test(e.trim());

/** Set the address the user is verifying. Any change invalidates a prior
 *  verification and clears the pending-code UI. */
const setEmail = (e: string) => {
  const next = e ?? '';
  if (next === state.email) return;
  state.email = next;
  state.verified = false;
  state.codeSent = false;
  state.error = '';
  state.devCode = null;
};

const sendCode = async (): Promise<boolean> => {
  const email = state.email.trim();
  if (!isValid(email)) { state.error = 'Enter a valid email address.'; return false; }
  state.sending = true; state.error = '';
  try {
    const r = await fetch('/api/email/send-code', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, token: state.token })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) {
      state.error = j.error === 'RATE_LIMITED'
        ? 'Please wait a moment before requesting another code.'
        : (j.error === 'INVALID_EMAIL' ? 'Enter a valid email address.' : 'Could not send the code. Try again.');
      return false;
    }
    state.token = j.token || state.token;
    saveToken(state.token);
    state.codeSent = true;
    state.devCode = j.devCode || null;
    return true;
  } catch {
    state.error = 'Network error sending the code.';
    return false;
  } finally {
    state.sending = false;
  }
};

const verifyCode = async (code: string): Promise<boolean> => {
  const c = (code || '').trim();
  if (!c) { state.error = 'Enter the code from your email.'; return false; }
  state.verifying = true; state.error = '';
  try {
    const r = await fetch('/api/email/verify-code', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: state.token, code: c })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) {
      state.error = j.error === 'CODE_EXPIRED'
        ? 'That code expired — send a new one.'
        : (j.error === 'TOO_MANY_ATTEMPTS' ? 'Too many tries — send a new code.'
          : (j.error === 'NO_PENDING' ? 'Send a code first.' : 'Incorrect code.'));
      return false;
    }
    state.verified = true;
    state.email = j.email || state.email;
    state.codeSent = false;
    state.devCode = null;
    return true;
  } catch {
    state.error = 'Network error verifying the code.';
    return false;
  } finally {
    state.verifying = false;
  }
};

/** Load any verified address already tied to this token (cross-fill on mount). */
const hydrate = async () => {
  if (!state.token) return;
  try {
    const r = await fetch('/api/email/verification-status', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: state.token })
    });
    const j = await r.json().catch(() => ({}));
    if (j?.email) { state.email = j.email; state.verified = !!j.verified; }
  } catch { /* best-effort */ }
};

const reset = () => {
  state.email = ''; state.verified = false; state.codeSent = false;
  state.sending = false; state.verifying = false; state.error = ''; state.devCode = null;
  state.token = null; saveToken(null);
};

/** Re-open a verified address for editing (keeps the text, drops the badge). */
const beginEdit = () => {
  state.verified = false; state.codeSent = false; state.error = ''; state.devCode = null;
};

export function useVerifiedEmail() {
  return { state, isValid, setEmail, sendCode, verifyCode, hydrate, reset, beginEdit };
}
