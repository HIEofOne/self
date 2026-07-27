# MAIA fix backlog

Running list of regressions, small bugs, and incomplete features to work
through. Captured 2026-07-26 (v1.5.110). Check items off and link the PR as
they land. Pointers are starting points, not final scope.

## Email & notifications

- [ ] **1. Require verified email for everyone.** Email verification is
  currently *offered*, not required (#228 welcome flow, #229 Groups tab). Make a
  verified email mandatory — at signup and in the Groups tab — so users and the
  system can reliably track who's who. Touches the welcome setup form
  (`src/App.vue` `welcomeFormStart`), `GroupsPanel.vue`, and
  `server/emailVerification.js` + `/api/user/notification-email`.
- [ ] **2. Group message notifications.** When a new group message is available
  for a member, email them a link to the message. Infra exists: the relay/
  message store in `server/routes/groups.js` and `sendEmail` (Resend) wired at
  `server/index.js:1560`. Gate on the member's verified notification email.
- [ ] **3. Request → response emails (the AS loop).** To make a request, a
  visitor must supply a **verified** email. Each patient's agent processing the
  request **logs any response** unless it's silently dropped (policy
  `denyMode: 'silent'`). Patients get a notification email when they're supposed
  to be notified; the requesting party gets emails **as responses come in**.
  Touches the welcome `RequestBuilder.vue` (real submit, not just the sim), the
  AS request evaluation (`server/routes/policies.js` `evaluatePolicies`), and the
  relay/notify path.

## Chat / inference

- [ ] **4. 500 "Internal server error" on Private AI Primary (GPT) chat.** A
  plain chat ("Who are you?") to Private AI Primary (GPT) returns 500, yet the
  **draft Patient Summary** — also GPT — works. Investigate why the chat
  inference route differs from the draft route (`server/routes/chat.js` vs the
  `/api/patient-summary/draft` path in `server/index.js`): prompt/size, tools,
  max_tokens, or the DO Serverless Inference call shape.

## Deep links & sharing

- [ ] **5. Deep links don't auto-update the conversation.** Suspected
  regression — opening a deep link doesn't refresh the conversation view
  automatically. Investigate the deep-link session + chat-load path
  (`server/index.js` deep-link handlers; `ChatInterface.vue` conversation load).
- [ ] **6. STORED CHATS sidebar link doesn't copy.** Clicking the link icon /
  badge in the STORED CHATS sidebar does nothing; you must open the Saved Chats
  Workbook tab to get the share link. Wire copy-to-clipboard on the sidebar
  badge (mirror the Saved Chats tab's copy action).

## Groups / requests UX

- [ ] **7. No clear way to test a group request; no reach/response counts.** The
  welcome-page request test returns one simulated response with no indication of
  **how many members were contacted** or **how many responded**. Add those
  counts to `RequestBuilder.vue` (and, once #3 lands, reflect real numbers).

## Setup / restore

- [ ] **8. Fix Restore-after-deletion.** Broken by the wizard rework; DELETE
  CLOUD ACCOUNT is disabled (#240). Full diagnosis + two-part plan (log what's
  deleted client-side since the userDoc is destroyed; surface restore progress
  as live wizard rows) is in **`Setup_Sequence.md` → "Restore-after-deletion —
  BROKEN"**. Needs a real delete→restore cycle against DO to verify; re-enable
  DELETE CLOUD ACCOUNT only after it passes.

---

**Context:** the new-user setup rationalization (Setup_Sequence.md, PRs
#234–#239) is done and on `main` (1.5.110) for the group-only / 1-file / folder
flavors; restore is the outstanding flavor (#8).
