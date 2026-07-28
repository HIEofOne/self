# MAIA fix backlog

Running list of regressions, small bugs, and incomplete features to work
through. Captured 2026-07-26 (v1.5.110). Check items off and link the PR as
they land. Pointers are starting points, not final scope.

**Status: all 8 items shipped as of v1.5.124.** The only open action is a live
delete→restore verification for #8 (see that item).

## Email & notifications

- [x] **1. Require verified email for everyone.** Email verification was
  *offered*, not required. **Done** (#248 new accounts + verification logged to
  maia-log, #249 Groups tab join gated server-side, #250 deep-link visitors
  *alerted* rather than required). Touched the welcome setup form (`src/App.vue`),
  `GroupsPanel.vue` / `PendingJoinCard.vue`, and the join endpoints in
  `server/routes/groups.js`.
- [x] **2. Group message notifications.** **Done** (#251). When a sealed message
  lands at the relay, `notifyGroupMessageRecipient` (`groups.js`) emails the
  recipient a nudge — gated on a verified email, de-bounced to the first unread,
  best-effort via the injected `sendEmail` (Resend).
- [x] **3. Request → response emails (the AS loop).** **Done** (#252). The
  welcome `RequestBuilder.vue` now really submits (name + verified email →
  `outside-request-proxy`) and shows reach; the patient's Accept/Decline in the
  Requests inbox emails the requester the outcome (+ optional note) and logs
  `as_request_responded`. Human-in-the-loop; the patient-notify email and
  silent-deny logging already existed.

## Chat / inference

- [x] **4. 500 / 400 on Private AI chat.** **Done** (#242 + #246). #242 fixed the
  GPT **500** (chat fell back to the agent *name* as the model). #246 fixed the
  Kimi secondary **400**: DO's Kimi K2.5 hard-requires `temperature: 1` **and**
  `top_p: 0.95`; the provider now pins both for `kimi` models.

## Deep links & sharing

- [x] **5. Deep links don't auto-update the conversation.** **Done** (#244/#245
  added a poll, then #247 replaced it). Per direction, dropped polling for an
  explicit **Save + email** model: deep-link visitors get a "Save & alert the
  patient" button; the server emails the other party on save. Also removed the
  per-bubble "Share to peer" action.
- [x] **6. STORED CHATS sidebar link doesn't copy.** **Done** (#243). The link
  icon / badge now copies the share URL to the clipboard.

## Groups / requests UX

- [x] **7. Group request reach/response counts.** **Done** (#253, on top of #3).
  RequestBuilder shows reach ("Delivered to N members") immediately and polls a
  privacy-preserving tally (counts only) for **"N of M responded (X accepted · Y
  declined)"**; responses also arrive by email.

## Setup / restore

- [x] **8. Fix Restore-after-deletion.** **Code done** (#254 + #255). #254 logs
  the deletion durably (`maia_audit_log` + `bufferLogEvent` into maia-log). Part 2
  (restore as live wizard rows) was **already implemented** in
  `RestoreWizard.vue`. #255 **re-enabled DELETE CLOUD ACCOUNT**. **Open action:**
  a real delete→restore cycle on `test.agropper.xyz` must confirm the maia-log
  shows the deletion and the RestoreWizard restores cleanly; if it fails,
  re-disable the two controls. See `Setup_Sequence.md` →
  "Restore-after-deletion".

---

**Context:** the new-user setup rationalization (`Setup_Sequence.md`, PRs
#234–#239) landed first; this backlog (captured at 1.5.110) is now fully worked
through (1.5.124). Only #8's live verification remains.
