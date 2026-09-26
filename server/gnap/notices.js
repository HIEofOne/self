/**
 * What MAIA tells the patient about requests, and when (group_requests.md
 * §8.2–8.3, §7 retention; D5, D10). Personal AS edition.
 *
 *   - Your MAIA shared automatically → an email each time (data left).
 *   - A request needs your decision → at most one email per 6 hours, listing
 *     every new ask since the last one; the hourly run sends what waited.
 *   - Weekly digest: counts by outcome, what is waiting, automatic shares,
 *     top requesters, and whether the folder's request log is up to date.
 *     A quiet month gets a short "your MAIA is on" heartbeat instead.
 *   - Retention: a decided request is kept 90 days, then pruned once the
 *     folder has it (logSyncedThrough); a 365-day cap; undecided never.
 *
 * Emails name the requester with their proof level, what and why, and the
 * outcome — never health data, an artifact, or the requester's message
 * (I-31). The renderers are pure so a test can hold them to that.
 * Per-patient state: nt_<userId> in maia_gnap.
 */
import { GNAP_DB, getDoc, updateDoc } from './store.js';
import { KIND_WORDS, isLiveHold } from './documents.js';

const USERS_DB = 'maia_users';
const AS_REQUESTS_DB = 'maia_as_requests';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
export const ASK_QUIET_MS = 6 * HOUR;
export const DIGEST_EVERY_MS = 7 * DAY;
export const HEARTBEAT_EVERY_MS = 30 * DAY;
export const KEEP_DECIDED_MS = 90 * DAY;
export const KEEP_MAX_MS = 365 * DAY;
export const GRANT_LIFE_MS = 30 * DAY;

const SCOPE_WORDS = {
  'notification-only': 'a note that they would like to be in touch',
  'meds-allergies': 'your current medications and allergies',
  'patient-summary': 'your Patient Summary',
  'not-sensitive': 'your record except sensitive categories',
  everything: 'your whole record',
  'ah-category': 'Apple Health data'
};
const scopeWords = (s) => SCOPE_WORDS[s] || 'information';
/** A document's kind, never its title: a title can carry health information (I-31). */
const kindWords = (r) => KIND_WORDS[r.document?.kind] || 'a document';
const askWords = (r) => (r.document ? `wants to add ${kindWords(r)}` : `asks for ${scopeWords(r.resource)} for ${purposeWords(r.purpose)}`);
const purposeWords = (p) => (p && p !== 'any' ? `${String(p).replace(/-/g, ' ')} use` : 'any purpose');

/** "Dr. Test, Local Clinic (email verified: dr@x.org)" — who asked, and how sure. */
export function requesterLine(r) {
  if (r.fromOutsider === false) return `${r.fromAlias || 'A member'} (a member of ${r.groupName || 'your group'})`;
  const name = r.requester?.name || 'Someone';
  const proof = r.requester?.emailVerified && r.requester?.email
    ? `email verified: ${r.requester.email}` : 'email not verified';
  const via = r.route === 'gnap-group' ? `, through ${r.groupName}` : '';
  return `${name} (${proof}${via})`;
}

const eventTime = (r) => [r.receivedAt, r.decidedAt, r.withdrawnAt, r.stoppedAt, r.forgottenAt,
  r.document?.acceptedAt, r.document?.deliveredAt, r.document?.expiredAt]
  .filter(Boolean).sort().pop() || r.receivedAt || '';
const decided = (r) => r.status && r.status !== 'pending';

// ── Email bodies (pure) ─────────────────────────────────────────────────

export function renderShared(r, appUrl) {
  if (r.document) {
    return {
      subject: 'A document was added to your MAIA',
      text: [
        `${requesterLine(r)} added ${kindWords(r)} to your MAIA, under one of your rules.`,
        'MAIA saves it in your MAIA folder, in Received, the next time you open MAIA. Until then only your folder’s key can open it.',
        '',
        `Open MAIA: ${appUrl}`
      ].join('\n')
    };
  }
  return {
    subject: 'Your MAIA shared information',
    text: [
      `Your MAIA shared ${scopeWords(r.resource)} for ${purposeWords(r.purpose)} with ${requesterLine(r)}, under one of your sharing rules.`,
      'Only the privacy-filtered copy leaves your MAIA, and you can stop sharing at any time in Requests.',
      '',
      `See it in MAIA: ${appUrl}`
    ].join('\n')
  };
}

export function renderAsks(asks, appUrl) {
  const n = asks.length;
  return {
    subject: n === 1 ? 'A request is waiting for you in MAIA' : `${n} requests are waiting for you in MAIA`,
    text: [
      n === 1
        ? (asks[0].document ? 'Someone wants to add a document to your MAIA. Your rules didn’t decide it, so it is waiting for you:'
          : 'Someone asked your MAIA for information. Your rules didn’t decide it, so it is waiting for you:')
        : `${n} requests reached your MAIA that your rules didn’t decide. They are waiting for you:`,
      '',
      ...asks.slice(0, 20).map((r) => `- ${requesterLine(r)} ${askWords(r)}.`),
      ...(n > 20 ? [`- and ${n - 20} more`] : []),
      '',
      `Decide in MAIA → Requests: ${appUrl}`
    ].join('\n')
  };
}

/** What happened since `since`: the digest's content, from request records. */
export function summarize(requests, { since, now, logSyncedThrough = '' }) {
  const inPeriod = (t) => t && t > since && t <= now;
  const received = requests.filter((r) => inPeriod(r.receivedAt));
  const decidedNow = requests.filter((r) => decided(r) && inPeriod(r.decidedAt || r.stoppedAt || r.withdrawnAt));
  const count = (pred) => decidedNow.filter(pred).length;
  const pending = requests.filter((r) => r.status === 'pending')
    .sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
  const expired = pending.filter((r) => Date.parse(r.receivedAt) + GRANT_LIFE_MS < Date.parse(now));
  const waiting = pending.filter((r) => !expired.includes(r));
  const byWho = new Map();
  for (const r of received) {
    const who = requesterLine(r);
    byWho.set(who, (byWho.get(who) || 0) + 1);
  }
  const newest = requests.map(eventTime).filter(Boolean).sort().pop() || '';
  return {
    received: received.length,
    sharedByRule: count((r) => r.status === 'accepted' && r.autonomous && !r.document),
    sharedByYou: count((r) => r.status === 'accepted' && !r.autonomous && !r.document),
    documentsAccepted: count((r) => r.status === 'accepted' && !!r.document),
    // Accepted documents the folder doesn't have yet: deleted after 90 days.
    documentsUnsaved: requests.filter((r) => r.document?.state === 'accepted').length,
    declined: count((r) => r.status === 'declined'),
    ignored: count((r) => r.status === 'blocked'),
    withdrawn: count((r) => r.status === 'withdrawn'),
    stopped: count((r) => r.status === 'stopped'),
    waiting,
    expired: expired.length,
    autoShares: decidedNow.filter((r) => r.status === 'accepted' && r.autonomous && !r.document),
    topRequesters: [...byWho.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3),
    logBehind: requests.filter((r) => eventTime(r) > (logSyncedThrough || '')).length,
    logEverSynced: !!logSyncedThrough,
    newest
  };
}

export const hasActivity = (s) => s.received > 0 || s.waiting.length > 0 || s.documentsUnsaved > 0
  || s.sharedByRule + s.sharedByYou + s.documentsAccepted + s.declined + s.ignored + s.withdrawn + s.stopped > 0;

export function renderDigest(s, { appUrl, sharing }) {
  const lines = ['Your MAIA this week:', ''];
  lines.push(`- ${s.received} new request${s.received === 1 ? '' : 's'}`);
  if (s.sharedByRule) lines.push(`- ${s.sharedByRule} shared automatically by your rules`);
  if (s.sharedByYou) lines.push(`- ${s.sharedByYou} shared by you`);
  if (s.documentsAccepted) lines.push(`- ${s.documentsAccepted} document${s.documentsAccepted === 1 ? '' : 's'} added to your MAIA`);
  if (s.declined) lines.push(`- ${s.declined} declined`);
  if (s.ignored) lines.push(`- ${s.ignored} ignored`);
  if (s.withdrawn) lines.push(`- ${s.withdrawn} withdrawn by the requester`);
  if (s.stopped) lines.push(`- sharing stopped for ${s.stopped}`);
  if (s.expired) lines.push(`- ${s.expired} expired without an answer`);
  if (s.waiting.length) {
    lines.push('', `Waiting for your decision (${s.waiting.length}):`);
    for (const r of s.waiting.slice(0, 10)) lines.push(`- ${requesterLine(r)}: ${r.document ? `wants to add ${kindWords(r)}` : `${scopeWords(r.resource)} for ${purposeWords(r.purpose)}`}`);
  }
  if (s.documentsUnsaved) {
    lines.push('', `${s.documentsUnsaved} accepted document${s.documentsUnsaved === 1 ? ' is' : 's are'} waiting to be saved in your MAIA folder. Open MAIA to save ${s.documentsUnsaved === 1 ? 'it' : 'them'}: documents not saved within 90 days are deleted.`);
  }
  if (s.autoShares.length) {
    lines.push('', 'Shared automatically:');
    for (const r of s.autoShares.slice(0, 10)) lines.push(`- ${scopeWords(r.resource)} with ${requesterLine(r)}`);
  }
  if (s.topRequesters.length) {
    lines.push('', 'Who asked most:');
    for (const [who, n] of s.topRequesters) lines.push(`- ${who}: ${n}`);
  }
  lines.push('', !s.logEverSynced
    ? 'Your MAIA folder doesn’t have a request log yet. Open MAIA → Requests to write one.'
    : s.logBehind
      ? `Your folder’s request log is missing ${s.logBehind} request${s.logBehind === 1 ? '' : 's'}. Open MAIA → Requests to update it.`
      : 'Your folder’s request log is up to date.');
  lines.push(`Sharing is ${sharing}.`, '', `Open MAIA: ${appUrl}`);
  return { subject: 'Your MAIA this week', text: lines.join('\n') };
}

export function renderHeartbeat({ appUrl, sharing }) {
  return {
    subject: 'Your MAIA is on',
    text: [
      'Nothing reached your MAIA in the last month. It is running, and it will email you when a request needs you.',
      `Sharing is ${sharing}.`,
      '',
      `Open MAIA: ${appUrl}`
    ].join('\n')
  };
}

// ── State and scheduling ────────────────────────────────────────────────

export function createNotices({ cloudant, sendEmail = async () => false, now = () => Date.now(), appUrl = () => process.env.PUBLIC_APP_URL } = {}) {
  const url = () => String(appUrl() || '').replace(/\/$/, '');
  const iso = (t) => new Date(t).toISOString();
  const stateId = (userId) => `nt_${userId}`;
  const getState = async (userId) => (await getDoc(cloudant, stateId(userId))) || { _id: stateId(userId), type: 'gnap_notice_state', userId };
  const saveState = async (userId, mutate) => {
    const existing = await getDoc(cloudant, stateId(userId));
    if (!existing) {
      const doc = { _id: stateId(userId), type: 'gnap_notice_state', userId };
      mutate(doc);
      try { await cloudant.saveDocument(GNAP_DB, doc); return; } catch { /* created meanwhile: update below */ }
    }
    await updateDoc(cloudant, stateId(userId), (d) => { mutate(d); return true; });
  };
  const requestsOf = async (userId) => ((await cloudant.getAllDocuments(AS_REQUESTS_DB).catch(() => [])) || [])
    .filter((r) => r && r.type === 'as_request' && r.userId === userId);
  const recipient = (userDoc) => (userDoc?.emailVerified && userDoc.email ? userDoc.email : null);
  const sharingWords = (userDoc) => (userDoc?.asState === 'active' ? 'on' : userDoc?.asState === 'paused' ? 'paused' : 'not on yet');
  /** true only when the email provider accepted it (false = delivery off). */
  const send = async (to, { subject, text }) => {
    try { return (await sendEmail(to, subject, text)) === true; } catch { return false; }
  };

  /** Every automatic share, at once. */
  const shared = async (userDoc, requestId) => {
    const to = recipient(userDoc);
    const r = to ? await cloudant.getDocument(AS_REQUESTS_DB, requestId).catch(() => null) : null;
    if (r) await send(to, renderShared(r, url()));
  };

  const sendAskBatch = async (userDoc) => {
    const to = recipient(userDoc);
    if (!to) return false;
    const state = await getState(userDoc.userId);
    const through = state.askEmailedThrough || '';
    const asks = (await requestsOf(userDoc.userId))
      .filter((r) => r.status === 'pending' && String(r.receivedAt) > through)
      .sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));
    if (!asks.length) {
      await saveState(userDoc.userId, (d) => { d.askPending = false; });
      return false;
    }
    if (!(await send(to, renderAsks(asks, url())))) return false;
    await saveState(userDoc.userId, (d) => {
      d.lastAskEmailAt = iso(now());
      d.askEmailedThrough = asks[asks.length - 1].receivedAt;
      d.askPending = false;
    });
    return true;
  };

  /** A new ask: email now, or once the 6-hour quiet period is over. */
  const ask = async (userDoc) => {
    if (!recipient(userDoc)) return;
    const state = await getState(userDoc.userId);
    if (now() - (Date.parse(state.lastAskEmailAt || '') || 0) < ASK_QUIET_MS) {
      await saveState(userDoc.userId, (d) => { d.askPending = true; });
      return;
    }
    await sendAskBatch(userDoc);
  };

  const states = async () => ((await cloudant.getAllDocuments(GNAP_DB).catch(() => [])) || [])
    .filter((d) => d?.type === 'gnap_notice_state');

  /** Hourly: asks that waited out the quiet period. */
  const sendDueAsks = async () => {
    let sent = 0;
    for (const st of await states()) {
      if (!st.askPending || now() - (Date.parse(st.lastAskEmailAt || '') || 0) < ASK_QUIET_MS) continue;
      const userDoc = await cloudant.getDocument(USERS_DB, st.userId).catch(() => null);
      if (userDoc && (await sendAskBatch(userDoc))) sent++;
    }
    return sent;
  };

  /** Daily: the weekly digest, or the monthly heartbeat when nothing happened. */
  const sendDigests = async () => {
    const users = ((await cloudant.getAllDocuments(USERS_DB).catch(() => [])) || [])
      .filter((u) => u?.userId && recipient(u) && !u.isDeepLink);
    let sent = 0;
    for (const u of users) {
      const st = await getState(u.userId);
      const since = st.lastDigestAt || u.createdAt || '1970-01-01T00:00:00.000Z';
      if (now() - Date.parse(since) < DIGEST_EVERY_MS) continue;
      const s = summarize(await requestsOf(u.userId), { since, now: iso(now()), logSyncedThrough: st.logSyncedThrough || '' });
      if (hasActivity(s)) {
        if (await send(recipient(u), renderDigest(s, { appUrl: url(), sharing: sharingWords(u) }))) {
          await saveState(u.userId, (d) => { d.lastDigestAt = iso(now()); });
          sent++;
        }
        continue;
      }
      const lastBeat = st.lastHeartbeatAt || u.createdAt || since;
      if (now() - Date.parse(lastBeat) >= HEARTBEAT_EVERY_MS) {
        if (await send(recipient(u), renderHeartbeat({ appUrl: url(), sharing: sharingWords(u) }))) {
          await saveState(u.userId, (d) => { d.lastDigestAt = iso(now()); d.lastHeartbeatAt = iso(now()); });
          sent++;
        }
        continue;
      }
      // A quiet week: nothing to send; the next digest covers from now.
      await saveState(u.userId, (d) => { d.lastDigestAt = iso(now()); });
    }
    return sent;
  };

  /** The folder now holds the log through `through` (the client says so). */
  const markLogSynced = (userId, through) => saveState(userId, (d) => {
    if (!d.logSyncedThrough || through > d.logSyncedThrough) d.logSyncedThrough = through;
    d.logSyncedAt = iso(now());
  });

  /** Daily: drop decided requests the folder has (90 days), or any past 365. */
  const prune = async () => {
    const all = ((await cloudant.getAllDocuments(AS_REQUESTS_DB).catch(() => [])) || []).filter((r) => r?.type === 'as_request');
    const synced = new Map((await states()).map((s) => [s.userId, s.logSyncedThrough || '']));
    let pruned = 0;
    for (const r of all) {
      // A document still waiting on the server is the hold sweep's to end.
      if (!decided(r) || isLiveHold(r)) continue;
      const at = Date.parse(r.decidedAt || r.stoppedAt || r.withdrawnAt || r.receivedAt);
      if (!at) continue;
      const age = now() - at;
      const inFolder = eventTime(r) <= (synced.get(r.userId) || '');
      if (age > KEEP_MAX_MS || (age > KEEP_DECIDED_MS && inFolder)) {
        try { await cloudant.deleteDocument(AS_REQUESTS_DB, r._id); pruned++; } catch { /* next run */ }
      }
    }
    return pruned;
  };

  return { shared, ask, sendDueAsks, sendDigests, markLogSynced, prune, getState };
}

/** The request log's events for one patient (the folder's requests.jsonl). */
export function requestEvents(requests) {
  const events = [];
  for (const r of requests) {
    const base = {
      requestId: r._id, route: r.route || null, groupName: r.groupName || null,
      requester: r.fromOutsider === false
        ? { name: r.fromAlias || 'A member', member: true }
        : { name: r.requester?.name || null, email: r.requester?.emailVerified ? r.requester.email : null, emailVerified: !!r.requester?.emailVerified },
      what: r.resource, why: r.purpose || 'any', message: typeof r.payload === 'string' ? r.payload : '',
      // A document: what the sender described. The folder is the patient's
      // own, so its log keeps the title and the SHA-256 (§10.12).
      ...(r.document ? {
        document: { kind: r.document.kind, title: r.document.title || '', mediaType: r.document.mediaType, size: r.document.size, sha256: r.document.sha256 },
        grant: r.gnapGrant || null
      } : {})
    };
    const add = (type, at, extra = {}) => { if (at) events.push({ id: `${r._id}:${type}`, at, type, ...base, ...extra }); };
    add('received', r.receivedAt, r.payment ? { payment: r.payment.type || r.payment } : {});
    if (r.document) {
      const d = r.document;
      if (d.acceptedAt || (r.status === 'accepted' && r.decidedAt)) add('accepted', d.acceptedAt || r.decidedAt, { by: r.autonomous ? 'rule' : 'you' });
      if (r.status === 'declined') add('declined', r.decidedAt, { by: r.autonomous ? 'rule' : 'you' });
      if (r.status === 'blocked') add('ignored', r.decidedAt, { by: 'you' });
      if (d.deliveredAt) add('document_received', d.deliveredAt, { fileName: d.fileName || null });
      if (d.expiredAt) add('expired', d.expiredAt);
      if (r.forgottenAt) add('forgotten', r.forgottenAt);
      continue;
    }
    if (r.status === 'accepted') add('shared', r.decidedAt, { by: r.autonomous ? 'rule' : 'you' });
    if (r.status === 'declined') add('declined', r.decidedAt, { by: r.autonomous ? 'rule' : 'you' });
    if (r.status === 'blocked') add('ignored', r.decidedAt, { by: 'you' });
    if (r.status === 'stopped') { add('shared', r.decidedAt, { by: r.autonomous ? 'rule' : 'you' }); add('stopped', r.stoppedAt); }
    if (r.status === 'withdrawn') add('withdrawn', r.withdrawnAt || r.decidedAt);
    if (r.forgottenAt) add('forgotten', r.forgottenAt);
  }
  return events.sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id));
}
