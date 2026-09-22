# Group Requests — a simplified "Personal AS" edition of MAIA

- **Date:** 2026-09-22
- **Status:** Proposal, not built. Nothing in this document is implemented yet.
- **Base:** `HIEofOne/self` main at `8323936` (v1.5.175) when reviewed; both remotes are now at `f53580d` (v1.5.176, adds PR #309)
- **Scope:** HIEofOne/self only. `agropper/self` and maia.agropper.xyz stay as the demo (tag `demo-v1.5.176`).
- **Version line:** v1.6.0 starts the 1.6.x minor line for this work, as v1.5.1 did for Groups.
- **Companion docs:** `MAIA_Request_Security_Privacy_Design.md` (the security baseline and invariants I-1…I-23 this design extends), `Groups.md` (implementation log), `Setup_Sequence.md` / `New_User_Flows.md` (onboarding lessons), `Policy_Vocab_Changelog.md`.

---

## 0. Summary

**The use-case.** A patient runs a *personal authorization server* (AS). A group (Trustee is the first example) publishes a small set of suggested policies at its site (for example trustee.ai). The patient adopts those policies, reviews and confirms them with help from a private AI, and from then on their MAIA answers requests on their behalf. Requests come from the group's public request form, and, new in this version, from software clients over **GNAP (RFC 9635)**. The patient hears about some requests right away, gets every request in a weekly email, and keeps a copy of the request log and their Patient Summary in a local folder. Everything else MAIA can do stays hidden until the patient asks for it or the private AI suggests it.

**Recommended approach, in one paragraph.** Keep **one codebase**. Add an **edition switch** (`MAIA_EDITION=personal-as`; the default stays `full`, so no current deployment changes behavior). The server enforces a **feature registry**, so hidden features are actually off, not just out of sight. Build the edition's onboarding, Requests tab, and GNAP endpoint as **new, small components**, and don't add more conditions to the 10,600-line wizard in `ChatInterface.vue`. **Freeze agropper as the demo** (now v1.5.176, after the #309 security fix was promoted) by stopping promotion, and tag that commit. Ship in eight PR-sized phases (§14). Every phase keeps the existing security invariants and adds new ones (§3). The main new rule: **no policy acts until the patient has confirmed it, and nothing is shared until the patient turns sharing on.**

**What you need to decide** is listed in §17. The ones that most affect the build are D2 (how the private AI is hosted), D3 (whether a passkey is required), and D7 (what "posts a public request form to all members' accounts" means).

---

## 1. Starting point (verified 2026-09-22)

### 1.1 Repository sync

| Check | Result |
|---|---|
| `origin/main` (HIEofOne) vs `upstream/main` (agropper) | **Identical**: both at `8323936`, 0 commits ahead/behind either way |
| Local `main` vs `origin/main` | Identical |
| Version | 1.5.175 |
| `upstream/stable` | **Dead**: last commit Feb 18 2026, 445 commits behind, version 0.1.0. Not what production deploys. Consider deleting it so it doesn't cause confusion. |
| Tags | None exist on either remote |
| Stale branches | 134 `origin/claude/*` branches. Squash merges mean none of their tips are ancestors of main, so ancestry checks can't prune them. Cleaning them up would need a PR-state check. This is housekeeping, not a blocker. |

Production (maia-self → maia.agropper.xyz) deploys `agropper/self@main` (per the two-app topology notes). **Confirm in the DO console** that maia-self has `deploy_on_push` on `main` before relying on the freeze in §13.

### 1.2 What already exists for this use-case

Most of the pieces are already built. The work is mainly about *subtraction, gating, and three new surfaces*.

| Requirement | Today (v1.5.175) | Gap |
|---|---|---|
| Group publishes simple policies | `suggestedPolicies` on the group doc. They are normalized at admin save (`server/routes/groups.js:337-350`), shown on the invite landing, and imported on join | They are imported **enabled** (`groups.js:2395`) and go live right away, even during the pre-join preview. (Join-time import skipped `normalizeCard` until PR #309, §1.4.) There are no test cases and no pack version or update flow |
| Group sells tokens to anyone | Credits ledger + Stripe Payment Link + signed webhook (`server/credits.js`), keyed by verified email on the registry host. `RequestBuilder.vue` shows the balance and a buy link | Naming only (see D6) |
| Public request form to all members | W3 outside request (`groups.js:816`): verified email, optional payment, vouch, delivery-time + ingest-time evaluation, per-member sealed envelopes, counts-only tally | Make it the group page's primary action. Otherwise done |
| Welcome page in Chrome only | `showNotChromeDialog` offers **CONTINUE IN THIS BROWSER** (`src/App.vue:650, 2935`) | Needs a hard gate based on the File System Access capability |
| New users verify email | The welcome form requires it (PR #248). `/api/temporary/start` stamps `emailVerified` when the token matches (`server/routes/auth.js:1238+`) | **The server accepts a missing email.** The edition must enforce it on the server |
| New users pick a private folder | Optional ("Just run the wizard without a local folder"). Deliberately deferred for adoption (Groups.md, PR-6.5) | Make it required in the edition. This intentionally reverses the adoption-funnel choice (§16) |
| Urged to create PS + Current Medications, saved to folder as PDF | The PS/CM pipeline exists with consent-gated verification stamps (PRs #264–#267, #296). The folder currently receives only `maia-state.json`, `maia-log.pdf`, `maia.webloc` | **No PS PDF in the folder.** PS drafting needs an agent, and without Apple Health it relies on KB/RAG |
| Confirm (and test) policies before sharing | "Try it" simulator in `PoliciesPanel.vue` (PR-12) | **No gate.** Cards act as soon as they are stored |
| Private AI to verify and edit policies | Policy Advisor (`server/routes/chat.js:24`, PR #297): server-assembled cards + last 15 requests + record profile; fenced `policy-card` proposals saved only by the user | Needs folder context, feature-unlock proposals, and a single lazily provisioned agent |
| Email on some requests | Ask-escalations are emailed at ingest. Send-time nudges are debounced (6 h). Hourly mail pull bounds cross-host latency | Notification rules need to be explicit (§8.2) |
| Weekly summary email | **None** | New |
| Request log in folder | Requests live only in `maia_as_requests` (server) | New |
| Hide everything else | **No feature-flag mechanism exists.** The Workbook has 10 rail tabs (`MyStuffDialog.vue:2373`). Every new user gets **two** DO agents at setup, because `/api/agent-setup-status` auto-provisions (`auth.js:1544`) and a secondary agent is added in parallel | New: edition + feature registry (§4) |
| GNAP API | Envelope fields were named for the mapping. Member claims use bespoke Ed25519, not RFC 9421. There is no public inbound AS endpoint, by design (Groups.md §7.3) | New (§10) |

### 1.3 Documentation review: findings

- **CLAUDE.md is stale.** Line counts are "as of v1.5.79". Current counts: `ChatInterface.vue` 10,590, `server/index.js` 15,079, `MyStuffDialog.vue` 8,278, `App.vue` 4,332, `groups.js` 4,299. It also says "No automated test suite currently", which is wrong: there are 14 backend suites (about 148 cases) run by `npm run test:backend`, including the two-host federation simulation. That suite is the main safety net for this redesign.
- **Security design doc §5** says "There is no policy write path that bypasses `normalizeCard`". That wasn't true for join-time import until PR #309 fixed it (§1.4). §14.1 says 135 tests; the count has drifted since.
- **Groups.md** still says "Status: Pre-implementation / Branch: claude/group-feature". Its log stops at 2026-07-19. Later work (policy matrix, credits, vouch, vocabulary editions) is recorded only in the security design doc.
- **Environment.md** lists 5 CouchDB databases. Groups added `maia_groups`, `maia_relay`, `maia_as_requests`, and credits added `maia_credits`.
- **Fix_Backlog.md** checkboxes were never updated. Every item shipped by v1.5.124.
- **Setup_Sequence.md** Phase E ("clean exit") is still unchecked. **Wizard_Issues.md** says its restructuring plan is still unstarted. This is the main reason §4.4 recommends building the edition's onboarding as a new component instead of reconfiguring the wizard.
- **README** "Top 19 features" and "Key provisioning steps" describe the full edition. The edition will need its own short version.

### 1.4 Pre-existing issue found during review — FIXED in PR #309 (v1.5.176, promoted to agropper 2026-09-22)

At join time, `importSuggestedPolicies` (`groups.js:2395`) writes cards taken from the **registry's response** (`m.suggestedPolicies` in the three join paths at `groups.js:2508, 2781, 2852`) without calling `normalizeCard`, and stores them `enabled`. Only the pre-join preview endpoint (`groups.js:3063`) normalizes.

This matters because `cardMatches` treats an unknown signature as rank 0 (`SIGNATURE_RANK[e.signature] ?? 0`, `server/routes/policies.js`). So an out-of-vocabulary signature **fails open** and matches any requester. A missing `elements.party` would throw during ingest. The cards also skip the I-23 stamps (`vocabVersion`, `authoredSentence`).

How much this adds to the risk depends on the host. A malicious registry can already suggest valid but permissive cards, and the privacy-filter ceiling (I-3) still limits what leaves. The gap matters most for a remote registry, which the security doc treats as only partly trusted (§12.2-1). **Fixed in PR #309 (both editions, now live on both remotes):** every imported card passes `normalizeCard` after its provenance and groupId are stamped; invalid cards are dropped. The test for it also showed that a single `null` card crashed the whole join (500); that is fixed too. P3's rule that "imported cards arrive unconfirmed" still removes the remaining risk from valid-but-permissive cards.

---

## 2. The use-case as three journeys

**Group admin (Trustee at trustee.ai).**
1. Deploys MAIA with `MAIA_EDITION=personal-as`.
2. Creates the group: open join, publicly listed.
3. Writes the **policy pack**: a few suggested cards, a set of **test requests** showing what those cards do, and the vocabulary edition.
4. Configures credits: Stripe Payment Link, prices, disclosed charity.
5. The welcome page *is* the group page. It shows what the group is, lets a visitor join, sign in, make a request (the public form, which fans out to every member), and buy credits.

**Patient (member).**
1. Opens trustee.ai in Chrome.
2. Selects JOIN, then verifies email, creates a passkey, and picks their MAIA folder.
3. Joins. The group's cards arrive **unconfirmed**.
4. Is urged to create a Patient Summary with Current Medications. The verified PDF lands in the folder.
5. Reviews each policy with the private AI, runs the group's test requests, edits as needed, and confirms.
6. Turns sharing on.
7. From then on: immediate emails for requests that need a decision or that the AS answered automatically, a weekly digest of everything, and the request log synced into the folder whenever MAIA is open.
8. Everything else (indexing, public AIs, deep links, peer chat, diary…) appears only if the patient turns it on, usually after the private AI suggests it.

**Requester.**
- **Human:** fills in the group's public request form (existing W3). Verifies email and may attach credits. Receives the privacy-filtered artifact, a decline, or nothing, and watches a counts-only tally.
- **Software:** a GNAP client sends a signed grant request to one patient's **personal AS URL** (which the patient gave it). It gets a key-bound access token to fetch the privacy-filtered artifact, a "wait" continuation while the patient decides, or a denial (§10).

---

## 3. Principles and new invariants

The edition changes *what users see*. It does not change *what the system guarantees*. Every invariant I-1…I-23 in the security design doc carries over unchanged. The new ones continue that numbering and belong in its Appendix A once implemented:

- **I-24 — Unconfirmed policy never acts.** Imported cards (group-suggested, restored, or pack updates) arrive with no `confirmedAt` and take no part in evaluation until the patient confirms them. While the patient's AS is not `active`, every request escalates to *ask* and nothing leaves automatically. The safe failure direction is the same as I-23's: the worst case is extra questions.
- **I-25 — Import is a write path.** Every card written to a patient's record, by any route, passes `normalizeCard`. Implemented by PR #309 (§1.4), which made the security doc §5 claim true.
- **I-26 — Edition gates are server-enforced.** Hiding something in the UI is never the only control. A route behind a feature that is off returns `403 FEATURE_OFF`, and no cost-bearing resource (agent, KB, OpenSearch cluster) is created for a feature the user hasn't turned on.
- **I-27 — Unlocking is a user act.** The private AI may *suggest* turning a feature on. The confirm card's text comes from the feature registry, not from the AI, and only the user's click turns the feature on. This extends I-14.
- **I-28 — GNAP tokens are key-bound, and stored as hashes.** Continuation, access, and management tokens are bound to the client key. A request for the `bearer` flag is refused (`invalid_flag`). The server keeps only SHA-256 of each token value, as it already does for invite tokens and vouch codes. This applies I-18 to GNAP.
- **I-29 — Declines are indistinguishable.** Over GNAP, a policy decline and a human decline return the same response (`request_denied`, never `user_denied`). A silent deny behaves exactly like an ask the patient never answered: the client keeps getting "wait" until the grant expires. This extends I-4 and I-5 to a protocol where silence has to be modeled explicitly.
- **I-30 — One decision function.** The group form, the member relay, and GNAP all build the same evaluator input (`{party, purpose, scope, signature, payment}`) and are bound by the same privacy-filter ceiling (I-3, I-22). A transport can change *how* a request arrives, never *how it is decided*.

Two design disciplines (not invariants):
- **Derive, don't store, setup state.** The lesson of `New_User_Flows.md` §4 is that each surface owned a fragment of the pipeline. The edition's setup checklist is a view computed from facts that already exist (email verified, passkey present, folder connected, membership, stamps, confirmed cards, AS state).
- **Build small and new, don't conditionalize large and fragile.** New components for the edition. The full edition's wizard and Workbook stay untouched.

---

## 4. The edition mechanism

### 4.1 Configuration

- `MAIA_EDITION` env var: `full` (default, today's behavior) | `personal-as`. Read once at boot and exposed at `GET /api/edition` as `{ edition, features: { <key>: { available, defaultOn, unlockable } } }`.
- `server/edition.js`: the **feature registry**. For each feature: key, user-facing name, one-paragraph description, what turning it on costs (time, AI usage, where data goes), and the routes it guards.
- `requireFeature(key)` middleware: allowed if the edition includes the feature by default *or* `userDoc.features[key].enabledAt` is set. Otherwise `403 { error: 'FEATURE_OFF', feature }`.
- Client: a `useEdition()` composable, with `has(key)` for `v-if` at a small number of points (Workbook rail list, conversation rail categories, welcome page sections, chat composer extras).
- Per-user unlocks: `userDoc.features = { 'records-index': { enabledAt, via: 'settings' | 'advisor' } }`, written only by `POST /api/user-features` from a user click (I-27). Turning a feature off hides it again; it does not delete data.

### 4.2 Feature matrix

| Feature key | What it covers | Edition default |
|---|---|---|
| `account` | Passkey, verified email, folder, backup/restore, sign-out | **Core** |
| `groups-core` | Join (invite / link / open), credential refresh, leave, request intake over the relay, pack updates | **Core** |
| `policies` | Sharing Policies tab: cards, simulator, group test requests, confirm, AS on/pause | **Core** |
| `requests` | New Requests tab: log, decisions, "stop sharing" (token revocation) | **Core** |
| `summary` | PS + Current Medications (verify flows), Privacy Filtered view + mapping review, PDFs to folder | **Core** |
| `advisor` | Private AI chat scoped to policies, PS, and requests | **Core** (agent provisioned lazily) |
| `notifications` | Immediate emails + weekly digest | **Core** |
| `gnap` | Personal AS endpoint + co-located RS | **Core** (answers "ask" until sharing is on) |
| `records-index` | KB + OpenSearch indexing, "ask about my whole record" | Unlockable (largest cost) |
| `lists-full` | Categories, encounters, out-of-range labs, medication worksheets | Unlockable |
| `second-ai` | Secondary private agent, PS generate-pair | Unlockable |
| `public-ai` | Anthropic / OpenAI / DeepSeek / Gemini via DO Inference | Unlockable |
| `saved-chats`, `deep-links` | Stored chats, clinician deep links | Unlockable |
| `peer-messaging` | Threads, Everyone broadcast, directory, mentors, member invites | Unlockable |
| `vouch` | "People I vouch for" (`verified-by-me`) | Unlockable |
| `diary`, `references`, `privacy-filter-editor` | The corresponding Workbook tabs (the PS pseudonym mapping stays core, inside Summary) | Unlockable |

Admin surfaces (`/admin`, AdminUsers, AdminGroups, credits config) are unchanged in both editions.

### 4.3 Migration when a deployment switches edition

A fresh trustee.ai deployment needs no migration. When an existing deployment switches (for example the test app), a feature is treated as turned on for a user if they already have its artifacts (`kbId` → `records-index`, `sharingPolicies` saved by the user → those cards count as confirmed, and so on), so nothing a user relies on disappears. Test accounts are disposable anyway.

### 4.4 Why new components rather than conditions in the wizard

`ChatInterface.vue` (10.6k lines) carries the setup wizard, whose restructuring is still unstarted (`Wizard_Issues.md`) and whose history is a series of flow-combination bugs (`New_User_Flows.md` §4). Adding an edition axis to it multiplies the flow matrix again. The edition instead gets:

- `SetupChecklist.vue`: 6 rows, server-derived (§5).
- `RequestsPanel.vue`: one inbox and log (§8).
- A slim edition branch of the welcome page (`WelcomeContent.vue` is already a separate component).

The full edition keeps its wizard, unchanged.

---

## 5. Patient onboarding in the edition

One checklist, each row computed from `GET /api/setup-status` (derived, §3):

| # | Step | Required? | Done when |
|---|---|---|---|
| 0 | **Chrome gate** (before anything) | Hard gate | `showDirectoryPicker` exists and the device isn't mobile. Checked by capability, not user-agent, so Chromium browsers such as Edge also pass, even though the page copy says "Chrome". A non-capable browser gets "Open this page in Chrome on a computer" plus a copy-link button. There is no continue option |
| 1 | Verify email | Required (server-enforced, closing the §1.2 gap) | `userDoc.emailVerified` |
| 2 | Create passkey | Required (D3) | `userDoc.credentialID` |
| 3 | Choose MAIA folder | Required | Client reports `folderConnectedAt`; `maia-state.json` written |
| 4 | Join the group | Required on a group host | Membership active; cards imported **unconfirmed** (I-24) |
| 5 | Patient Summary + Current Medications | **Urged, skippable** | `currentMedicationsVerifiedAt` + `patientSummaryVerifiedAt`; PDFs written (§7) |
| 6 | Review, test, and confirm policies → **Turn on sharing** | Required before any sharing | Every card confirmed or disabled; `asState = 'active'` |

If step 5 is skipped, sharing can still be turned on. Allow cards for PS or meds then escalate to ask, because no filtered artifact exists (the existing fail-closed rule, I-3). The confirm screen says so plainly: "Your policies allow sharing your summary, but you don't have one yet, so those requests will come to you."

**Patient Summary routes in v1 (D11):**
1. **Apple Health export.** The deterministic Lists build extracts medications, allergies, conditions, encounters, and labs without a KB. The existing draft builder turns those authoritative blocks into a PS using one agent. This is the best-quality route.
2. **Interview.** The private AI asks about conditions, current medications, and allergies, and drafts a PS in the standard section format. The draft goes through the existing review dialog, which remains the only save path, and the patient verifies it.
3. Other record PDFs → offered the `records-index` unlock (full RAG), or a later phase adds an in-context draft without a KB for small record sets.

Current Medications verification reuses the existing Lists CM verify card. The rest of Lists stays behind `lists-full`.

---

## 6. Policies: group-initialized, patient-confirmed

### 6.1 Card lifecycle

```
group pack ──import (normalizeCard, I-25)──► UNCONFIRMED ──patient confirms / edits+saves──► CONFIRMED
                                                 │                                              │
                                                 └──── disable / delete ◄──────────────────────┘
```

- `card.confirmedAt` is stamped only by a user act: the confirm button, or saving an edit through `/api/user-policies`. It is cleared when the card is re-imported by a pack update.
- `evaluatePolicies` (both twins, parity-tested) filters to `enabled !== false && confirmedAt`. Unconfirmed cards are shown, simulated ("would do X once confirmed"), and explained by the AI, but they never decide anything.
- Cards the patient authored themselves are confirmed when saved. The existing save *is* the confirmation.

### 6.2 AS state

`userDoc.asState`: `setup` (new accounts) → `active` (**Turn on sharing**) ⇄ `paused` (one click, any time).

While the state is not `active`:
- Every request, from any transport, is stored as *ask*.
- No autonomous message of any kind goes out: no allow, and no deny-respond notice.
- GNAP returns "wait" continuations (§10.5).

The patient sees these requests once active, or in the digest. This state is also the natural "vacation / I'm worried" switch.

### 6.3 Testing policies

The group's pack carries **test requests**, for example: "an unverified researcher asks for your Patient Summary"; "a verified-email clinician asks for your medications for clinical use"; "a marketer asks for everything". The confirm screen runs them through the simulator against the patient's current cards (confirmed plus pending) and shows a table: *request → outcome → which of your cards decided*. This is the existing "Try it" machinery fed with curated inputs. The patient can also add their own test requests. A GNAP reference client (§10.10) gives technically minded patients and group admins a real end-to-end self-test.

### 6.4 Pack updates

The pack gets a version and an Ed25519 signature from the group key, which members already hold. A new version appears as "Trustee updated its suggested policies" with a diff (old sentence beside new). Changed or new cards arrive unconfirmed. **Confirmed cards are never modified by the group** (I-16, I-23).

---

## 7. The local folder

The File System Access folder becomes where the patient's own copy of the record lives. It is also what the private AI reads (§9).

```
<MAIA folder>/
  maia-state.json                          existing: full userDoc backup (incl. group pairwise keys)
  maia-log.pdf                             existing: setup/provisioning log
  Patient Summary.pdf                      NEW: verified PS incl. Current Medications (regenerated on each verify)
  Patient Summary - privacy filtered.pdf   NEW: exactly what can leave automatically
  Sharing Policies.pdf                     NEW: confirmed cards as rendered sentences + AS state + date
  Requests/requests.jsonl                  NEW: append-only request events (canonical, dedup by id+event)
  Requests/Request Log.html                NEW: human-readable, regenerated from the jsonl
  Records/                                 the patient's record files (e.g. Apple Health export)
```

- PDFs are made client-side with the existing `jspdf`/`html2pdf` dependencies (the same path as `generateSetupLogPdf`). They are written through `writeFileToFolder`. **Writing the PDF is part of the Verify action**, not a separate step to remember.
- **Honest limitation:** File System Access writes happen only while a MAIA tab is open with permission granted. The server is the AS and holds the operating copy. The folder is synced at sign-in and while the Requests tab is open (`GET /api/requests/log?since=<cursor>`), and it trails the server between visits. The weekly digest reminds the patient when the folder log is out of date.
- **Server retention (D10):** request records are kept at least 90 days after a decision. Older ones are pruned only after the client confirms they are in the folder (`logSyncedThrough`), with a 365-day hard cap. Undecided requests are never pruned. This keeps the local-first model from `NewRestore.md` (the folder is the durable record; the cloud is disposable) without the AS losing the history the advisor uses.

---

## 8. Requests: intake, notification, digest, log

### 8.1 Sources, one decision function (I-30)

| Source | Transport | Signature level derivable today |
|---|---|---|
| Group public form (W3) | Registry → sealed per-member envelope | `unverified`, `verified-email`, `verified-by-me` (vouch, only if `vouch` is on) |
| Group member | Sealed relay (`peer-messaging` off → only `as-request` envelopes, not chat) | `group-member` |
| Software client | **GNAP** (§10) | `unverified` (any signed key), `verified-email` (via interaction) |

All three go through `toPolicyRequest()` → `evaluatePolicies()` → the same dispatch: autonomous (privacy-filtered artifact only), ask, deny-respond, or deny-silent. The request record is stored in `maia_as_requests`, with a `transport` field added.

### 8.2 Notification rules (D5)

| Event | Immediate email to patient | Weekly digest |
|---|---|---|
| Request needs your decision (ask) | Yes. Debounced: at most one email per 6 h listing all new asks (reusing the send-time nudge debounce) | Yes |
| Your MAIA shared automatically (allow) | **Yes, each time.** Data left, so the patient should know promptly | Yes |
| Declined automatically (deny-respond / deny-silent) | No | Counts only |
| Grant expired unanswered | No | Yes |

Emails carry **no PHI and no artifact**. They include the requester's stated name and organization, labeled with its proof level ("email verified" / "not verified"), plus scope, purpose, outcome, and a sign-in link. Patients can't unsubscribe from decision-needed emails while sharing is on. Pausing the AS is the off switch.

### 8.3 Weekly digest

This hangs off the existing daily cron (`runDailyGroupMaintenance`, `server/index.js:1593`). For each user with a verified email, when `now − lastDigestAt ≥ 7 days`, send a digest containing:
- counts by outcome
- the pending list
- automatic shares
- top requesters
- the folder-log status

With no activity, a short monthly "your MAIA is on, nothing happened" heartbeat is sent instead, so the patient knows the AS is alive. `lastDigestAt` is set only after Resend accepts the email, so a failed send retries the next day.

### 8.4 Requests tab

`RequestsPanel.vue` is one list, newest first. Filters: needs decision / shared / declined / all.

Each row shows who (proof-labeled), what, why, outcome, and decided-by. The deciding card's sentence is shown here only, never to requesters (I-4). Actions:
- **Share** / **Decline** / **Block**, which write the existing accepted- and blocked-sender facts.
- For any share: **Stop sharing**, which revokes GNAP tokens.
- **Always handle requests like this…**, which pre-fills a card from the actual request. This is Groups_Design Refinement 7's "policies are born from decisions", finally reachable.

This replaces the message-request cards in the conversation rail for edition users.

---

## 9. Private AI in the edition

- **One agent, provisioned lazily.** No agent is created at signup. The first action that needs one (PS draft, interview, or the first advisor question) provisions it, with visible progress (≈30–60 s). No secondary agent (`second-ai`) and no KB (`records-index`). In the edition, `/api/agent-setup-status` must not auto-provision (it does today at `auth.js:1544`).
- **Context.**
  - Server-assembled and authoritative: the existing `buildPolicyAdvisorContext`, extended with AS state and confirmed/unconfirmed status per card.
  - Folder-derived: PS text, the medication list, and a request-log excerpt that the client reads from the folder and attaches as "the patient's own files".
  - **Requester free text is never included.** Request messages come from requesters, so they are an injection channel. The advisor sees who / what / why / outcome, not message bodies.
- **Outputs are proposals only.** Fenced `policy-card` blocks (existing) and new fenced `maia-feature` blocks (`{"feature":"records-index","reason":"…"}`) render as confirm cards. The card's description of what turning it on does comes from the feature registry, so the model can't misstate what the button does (I-27). Nothing is saved or turned on without a click (I-14).
- **What the advisor should suggest.** Unlocks come from context. Examples:
  - "you have 40 PDFs in Records/ and asked about a 2019 result → index my records"
  - "you want to send your summary to Dr. X for a visit → deep links"
  - "you want to give your sister's requests stronger standing → vouch"

  The group's pack can also carry a short "what members usually turn on" note that the advisor may cite.
- **D2 alternative (cost).** Use DO Serverless Inference with a DO-hosted open-weights model for the advisor, with no per-user agent at all. It is faster to start and has less to clean up, but drafting the PS needs a non-agent path, and per-user key isolation is lost. Recommendation: ship v1 with the lazy single agent (reuses the proven PS path), then measure.

---

## 10. GNAP API (personal AS)

### 10.1 Scope for this version

GNAP becomes the **external API of each patient's AS**, sharing the evaluator with the other transports (I-30). v1 covers:
- the grant request
- asynchronous RO authorization with polling (RFC 9635 §1.6.4, which is exactly MAIA's "ask" path: the AS contacts the patient by email while the client waits)
- one interaction mode for requester identity (email verification)
- key-bound opaque access tokens
- a co-located resource server serving privacy-filtered artifacts
- token management (revoke)

Deferred to later phases (§10.9): payments, group-member and vouch proofs over GNAP, the MCP facade, RFC 9767 external RS connections, structured tokens, and Cedar.

This is the first **unsolicited public inbound AS surface** (Groups.md §7.3 deliberately had none). §10.8 covers the hardening that follows from that.

### 10.2 Endpoints (per host; one logical AS per patient)

| Method + path | Purpose |
|---|---|
| `OPTIONS /gnap/as/:asId` | Discovery (RFC 9635 §9): `grant_request_endpoint`, `interaction_start_modes_supported: ["redirect"]`, `interaction_finish_methods_supported: ["redirect","push"]`, `key_proofs_supported: ["httpsig"]`, `key_rotation_supported: false` |
| `POST /gnap/as/:asId` | Grant request |
| `POST /gnap/as/:asId/continue/:grant` | Continue (poll, or finish after interaction with `interact_ref`) |
| `DELETE /gnap/as/:asId/continue/:grant` | Client cancels the grant |
| `GET /gnap/as/:asId/interact/:ix` | Requester's interaction page (verify email by code; later vouch/payment) |
| `DELETE /gnap/as/:asId/token/:tok` | Token management: revoke |
| `GET /gnap/rs/:asId/:datatype` | Co-located RS: returns the privacy-filtered artifact for a valid key-bound token |

- `asId` already exists (16 random bytes, `groups.js:2506`). In the edition it is assigned at account creation.
- The patient can **rotate** it ("Change my AS address"), which invalidates all pending grants and tokens. This is the spam escape hatch.
- The personal AS URL is shown to the patient (copy / QR) so they can hand it to a clinician's app or an agent.
- The registry **never** publishes members' AS URLs (roster privacy is unchanged).

### 10.3 Access rights: MAIA's `type`

RFC 9635 §8 leaves the fields inside an access object to its `type` and recommends a URI. The proposed type (D8):

```json
{
  "type": "urn:maia:access:record:v1",
  "actions": ["read"],
  "datatypes": ["patient-summary"],
  "purpose": "clinical"
}
```

- `datatypes` must be exactly one value from `POLICY_SCOPES` (the scope lattice applies unchanged).
- `purpose` is a type-defined field taking values from `POLICY_PURPOSES`.
- `actions`: `read`, or `notify` for `notification-only`.
- Unknown values are rejected with `invalid_request`, never coerced (the `normalizeCard` philosophy).
- The type carries the policy vocabulary edition (`…:v1` ↔ `POLICY_VOCAB_VERSION` mapping recorded in `Policy_Vocab_Changelog.md`). A vocabulary bump that changes the type's semantics mints `…:v2`.

### 10.4 Key proofing: RFC 9421 `httpsig`

Per RFC 9635 §7.3.1 (verified against the RFC text):
- The signature must cover `@method` and `@target-uri`, plus `content-digest` (RFC 9530) when there is a body, plus `authorization` when a token is presented.
- It must carry `tag="gnap"` and `created`.
- `nonce` is recommended. If present, the verifier must enforce uniqueness over a window of several minutes.
- For JWK keys, `keyid` must be the JWK `kid` and the algorithm must be the JWK's `alg`.

Implementation plan:
- `server/gnap/httpsig.js`, a small hand-written module for auditability: a structured-field parser for `Signature-Input`/`Signature`, signature-base construction, Ed25519 verification through Node `crypto`, Content-Digest `sha-256`/`sha-512`.
- It is verified against the **RFC 9421 Appendix B test vectors** (Ed25519 key B.1.4, example B.2.6).
- v1 accepts Ed25519 JWKs only; P-256 can come later.
- Two operational pitfalls to handle:
  1. `@target-uri` has to be rebuilt from `PUBLIC_APP_URL` + `originalUrl`, because DO App Platform proxies requests.
  2. The raw body has to be kept for the digest check. This uses the same `express.json` verify-hook technique already used for the Stripe webhook.
- `created` skew: ±5 min. In-memory nonce cache: 10 min.

### 10.5 Outcome mapping

| MAIA outcome | GNAP response | Notes |
|---|---|---|
| **allow** (confirmed card, AS active, filtered artifact exists) | `access_token { value, access, expires_in: 3600, manage: { uri, access_token } }`. `access[].locations` = the RS URL | Key-bound, no `bearer` flag (I-28). The patient is emailed immediately (§8.2). The artifact carries machine attribution (I-17) |
| **ask** (explicit or default; also every request while AS is not active) | `continue { access_token, uri, wait }` | The patient is emailed (debounced). `wait` starts at 60 s and grows to 3600 s. A poll before `wait` gets `too_fast` |
| patient **accepts** later | the next continue returns `access_token` | The same evaluator re-checks the cards at decision time |
| patient **declines** / **deny-respond** card | error `request_denied` | Never `user_denied` (I-29) |
| **deny-silent** / patient never answers | "wait" continuations until the grant expires (30 days, same as relay/tally TTL), then `invalid_continuation` | Silent deny and an ignored ask look identical (I-29) |
| client asks for `flags: ["bearer"]` | `invalid_flag` | I-28 |

### 10.6 Interaction: requester identity

If the client includes `interact.start: ["redirect"]`, the AS returns `interact.redirect` → the MAIA page at `/gnap/as/:asId/interact/:ix`. There the human requester verifies their email with the existing code flow (`/api/email/send-code`, same TTL, attempt limits, and 72 h retention). The page then redirects or pushes to the client's `finish` URI with `interact_ref` + hash (RFC 9635 §4.2.3). The grant is evaluated at `verified-email` **for this grant only**. v1 does not remember key → email bindings. The verification is **host-local**, as in §12.2-4 of the security doc.

The self-asserted `client.display.name` is shown to the patient labeled "not verified" unless email proof backs it.

### 10.7 Tokens and the co-located RS

- **Storage.** New `maia_gnap` database: grant docs (`asId`, client JWK thumbprint, access, state, evaluator input, expiry, linked `maia_as_requests` id) and token docs (SHA-256 of the value, grant, key thumbprint, expiry, revoked). Token values are never stored.
- **RS check.** `GET /gnap/rs/:asId/patient-summary` with `Authorization: GNAP <token>` + httpsig covering `authorization`. The RS checks:
  1. the token hash exists, isn't expired or revoked, and belongs to this asId
  2. the signature was made by the bound key
  3. the requested datatype is within the granted access (`SCOPE_COVERS`)
  4. **the cards still allow it**: invocation re-checks policy, the standing invariant from the security doc §15.4

  It then returns `privacyFilteredSummary` or the pseudonymized meds.
- **What a token grants.** A 1-hour token reads the *current* filtered artifact. There is no standing access: a new grant is evaluated afresh.
- **Stopping access.** "Stop sharing" in the Requests tab revokes the token. Rotating the asId revokes everything.
- **Audit events.** `gnap_grant_received`, `gnap_decided`, `gnap_token_issued`, `gnap_rs_read`, `gnap_token_revoked`, with policy ids on the member side only.

### 10.8 Hardening for the first public inbound endpoint

- Rate limits per IP and per client key (grant creation and polling), plus a cap on pending grants per asId. Excess gets HTTP 429.
- Unknown asId and rotated asId return the same 404 as any other nonexistent path, so there is no enumeration oracle.
- Request bodies are size-capped.
- Everything a requester controls (display name, URIs) is rendered as data, and it never reaches the advisor's context as instructions (§9).
- Nonce and replay cache (§10.4). Each continue response issues a new continuation token and invalidates the previous one, as RFC 9635 §5 recommends. This limits token replay.

### 10.9 Relationship to the group form and relay, and what's deferred

- **The group form stays a sealed fan-out, not GNAP.** A GNAP grant addressed to "every member" would hand the requester one continuation per member, which leaks the roster. The counts-only tally is the right shape for a group. What changes: the sealed envelope gains the same `access[]` array (`gnapAccess`), so the member's ingest and the GNAP endpoint call literally the same `toPolicyRequest()` (I-30).
- **Deferred, in the order the roadmap already set (security doc §15):**
  1. **payments over GNAP**, as an interaction step that holds credits on the AS's host. Credits are host-scoped today, so paid GNAP requests to a member on another host need registry attestation or credits on the member host (design both before building).
  2. `group-member` and `verified-by-me` proofs as GNAP `subject.assertions` (a MAIA assertion format for the membership credential; a WebAuthn step in interaction for the vouch).
  3. The **MCP facade**: an MCP tool wrapping the reference client, so an agent can request a patient's filtered summary under the patient's cards.
  4. **RFC 9767** `/.well-known/gnap-as-rs` + introspection + structured JWT tokens for external RSs (the hospital FHIR boundary, security doc §15.5).
  5. Cedar as the evaluation engine behind all of it.

### 10.10 Reference client and tests

- `scripts/gnap-client.mjs`: generates an Ed25519 JWK, signs a grant, handles `wait`/continue, optionally opens the interaction URL, and fetches the artifact. It is the demo, the admin's self-test, and the basis for the MCP facade.
- Tests (vitest, in-memory `FakeCloudant`, real handlers, in the style of `crosshost-autonomous.test.js`):
  - RFC 9421 vectors
  - Content-Digest tamper
  - wrong key on continue / RS
  - replayed nonce
  - stale `created`
  - bearer request → `invalid_flag`
  - allow → token → RS read → revoke → RS 401
  - ask → accept → token
  - ask → decline → `request_denied`
  - deny-silent vs ignored-ask produce byte-identical response sequences (I-29)
  - AS in `setup` → wait even with an allow card (I-24)
  - unconfirmed allow card → wait (I-24)
  - scope subsumption at the RS
  - asId rotation kills grants

---

## 11. Group side (trustee.ai)

| Item | Today | Edition work |
|---|---|---|
| Suggested policies | Cards on the group doc | Becomes a **signed, versioned policy pack**: cards + test requests + vocabulary edition + optional "commonly turned-on features" note (§6.3–6.4) |
| Public request form | W3 form + tally | Primary action on the group page. Fields unchanged. Envelope gains `gnapAccess` (§10.9) |
| Selling credits ("tokens") | Stripe Payment Link + webhook, balance keyed by verified email | Visible "Buy credits" on the group page for anyone with a verified email. Keep the word **credits** (D6) |
| Welcome page | Organizer-first page (Refinement 8) | Edition variant: group hero, JOIN, Sign in, Make a request, Buy credits, Learn more. "Start a group" and the comparison section are hidden |
| Admin | AdminGroups, credits config | Pack editor gains test requests + publish-new-version. Everything else unchanged |

**Trust model disclosure.** On trustee.ai the group's host also hosts members' ASes. The README's rule applies: whoever pays for hosting controls the infrastructure. The edition's welcome page should say, in one line, who hosts and pays. Members who want their own host can join from their own MAIA through the existing federation path (PR-11).

---

## 12. Operating cost

| Resource | Full edition today | Personal-AS edition |
|---|---|---|
| DO GenAI agents | **2 per user at signup** (primary via `agent-setup-status` auto-provision + secondary in parallel) | **0 at signup; 1 when first needed; the second only if turned on**. A member who never uses AI costs no agent |
| Knowledge base + OpenSearch | One KB per user at first indexing; the account's OpenSearch cluster is created at the first KB | **None unless `records-index` is turned on.** A fresh trustee.ai deployment may never create the cluster, a fixed monthly cost avoided |
| Public-AI inference | Available to everyone | Off unless turned on |
| Spaces objects | Uploaded records persist (root / archived / KB) | Same in v1. Later: transient upload → parse → delete, with the folder as the only persistent copy |
| Server chats (`maia_chats`) | Yes | Off unless `saved-chats` is on |
| Email (Resend) | Requests, invites, nudges | + weekly digests (small volume) |
| Fixed per deployment | App Platform + CouchDB droplet + Spaces subscription (README: about $10–40/month total) | Same fixed base; OpenSearch avoided until needed |

The biggest per-member saving comes from not provisioning two agents and a KB for members who only need their AS to answer requests. The biggest fixed saving is never creating OpenSearch on an edition host.

---

## 13. The safest path: repos, branches, deploys

1. **Freeze the demo.** *(Done 2026-09-22.)* Tag `f53580d` as `demo-v1.5.176` on both remotes (the v1.5.175 baseline plus the #309 security fix, promoted 2026-09-22). **Stop running** `git push upstream origin/main:main` until you decide otherwise. maia.agropper.xyz keeps serving v1.5.176. Confirm in the DO console that maia-self tracks agropper `main` (§1.1).
2. **One codebase, no fork, no long-lived branch.** Every phase lands in HIEofOne/self `main` as a small PR behind `MAIA_EDITION` (default `full`). The repo's own history shows the cost of long-lived branches (the 52-commit `wizard-spinner-verify-flow` divergence) and of stacked PRs (the PR-4 mis-merge). One short-lived branch per phase, cut fresh from `origin/main`, never stacked.
3. **Test bed.** Set `MAIA_EDITION=personal-as` on the test app (claude-self → test.agropper.xyz) when P1 lands (D4). Accounts there are disposable. The alternative is a third DO app so test.agropper.xyz keeps exercising the full edition, which costs another App Platform instance.
4. **trustee.ai production.** A new DO app, ideally in a DO account that Trustee pays for (§11 trust note), with its own CouchDB droplet and snapshots enabled (Environment.md: group keys exist only there). maia.agropper.xyz's `FEATURED_GROUP_REGISTRIES` can keep featuring it.
5. **Keeping options open for agropper.** Because agropper stays a strict ancestor of HIEofOne main, a later fast-forward promotion is still clean. The demo would keep the full edition simply by not setting the flag. "Update agropper or not" stays a configuration decision, not a merge project.
6. **Per-PR gates.** `npm run build` (vue-tsc; plain vite isn't enough), `npm run test:backend` green, version bump, and edition-parameterized tests: every new backend test runs under both `full` and `personal-as`, and `full` must behave exactly as before.

---

## 14. Phased plan

Each row is one PR (or two small ones) into HIEofOne/self and references this doc. Server-only phases can overlap once their dependencies merge. P7 needs P3 and can run alongside P4–P6.

| Phase | Delivers | Key tests / acceptance |
|---|---|---|
| **P0 — Groundwork** (no visible change) | ~~Demo tag~~ (done: `demo-v1.5.176`) + promotion freeze. `server/edition.js` registry, `GET /api/edition`, `requireFeature`, `useEdition()`. (The §1.4 import bypass, I-25, already shipped in #309.) Refresh CLAUDE.md (counts, tests exist) | `full` edition: every existing test passes unchanged |
| **P1 — Edition shell** | Chrome capability gate. Edition welcome page. Workbook rail filtered to core tabs. Conversation rail = Private AI only. Server gates on unlockable routes (I-26). Stop auto-provisioning in `agent-setup-status` for the edition | Hidden routes return 403 `FEATURE_OFF` in the edition and 200 in `full`. Signup creates no DO agent |
| **P2 — Setup checklist** | `SetupChecklist.vue` + derived `GET /api/setup-status`. Server-enforced verified email. Required passkey (D3) + folder. Join. Lazy single agent | Fresh user reaches "joined" with 0 agents. Reload at any step resumes correctly (derived state) |
| **P3 — Confirmed policies + AS state** | `confirmedAt`, `asState` (setup / active / paused) in both twin evaluators + parity test. Confirm screen with pack test requests + simulator. Turn on / pause. `Sharing Policies.pdf` | Two-host suite extended: an unconfirmed allow card never releases. `setup` → everything asks. Pause → asks again. Parity holds |
| **P4 — PS/CM to folder** | Verify writes `Patient Summary.pdf` + privacy-filtered PDF. PS interview route. Apple Health route with one agent | Verify → both PDFs in the folder. Edit clears stamp → PDFs regenerated only on re-verify |
| **P5 — Requests, notifications, log** | `RequestsPanel.vue` (decide, stop sharing, "always handle like this"). Notification rules. Weekly digest + monthly heartbeat. `requests.jsonl` + HTML sync. Retention | Digest idempotent across cron re-runs. No PHI in any email (template test). Log dedup across tabs |
| **P6 — Advisor for the edition** | Folder context. Fenced `maia-feature` proposals → registry-authored confirm cards → `POST /api/user-features`. First unlock flow end to end: `records-index` | Advisor output can't turn anything on without a click (I-27). Requester text absent from the advisor context |
| **P7 — GNAP v1** | `httpsig.js` + RFC vectors. Grant / continue / interact / token / RS endpoints. `maia_gnap`. `toPolicyRequest()` shared with ingest (I-30). `gnapAccess` in envelopes. Reference client. Security doc §15.4 + Appendix A (I-24…I-30) | Full §10.10 list. Reference client completes allow and ask→accept against test.agropper.xyz |
| **P8 — Launch** | trustee.ai deploy. Pack authored with test requests. Edition user guide + README section. Live acceptance run (a fresh member through every checklist row, a form request, a GNAP request, a digest) | Acceptance checklist signed off on trustee.ai |
| Later | GNAP payments → group-member/vouch assertions → MCP facade → RFC 9767 + JWT → transient Spaces → serverless-inference advisor (if D2 changes) → Cedar | Per the security doc §15 roadmap |

---

## 15. Testing and verification

- **Backend (automated):** every phase adds to `tests/backend/`, runs under both editions, and uses the in-memory two-host harness for anything that crosses the registry/member seam. Target: every new invariant I-24…I-30 is covered by at least one named test, as in security doc §14.1.
- **Frontend (manual + CDP harness):** the checklist, Requests tab, and confirm screen are verified by live runs on the test app, following the `Setup_Sequence.md` acceptance-matrix habit: one run per path (with Apple Health / interview / skip PS; sharing on then paused; GNAP self-test).
- **Deploy discipline:** merge → wait for the deploy → check the version banner → test. This avoids the "still broken" reports that were really version skew (`New_User_Flows.md` §4.8).

---

## 16. Risks

1. **Hidden isn't removed.** Dormant code still ships and still runs unless the server gates it. I-26 plus the "403 in edition, 200 in full" tests are the control. P1 should include a route inventory so no unlockable route is missed.
2. **More friction at onboarding.** The adoption work of July (PR-6.5: folder deferred, zero-decision quick start) deliberately removed the folder and passkey from the join path. This edition deliberately puts them back, because a personal AS that has to stay reachable and keep a durable log needs both. Expect fewer, more committed members. That fits the use-case, but it is a real change of direction.
3. **Chrome and desktop only.** File System Access isn't available in Safari, Firefox, or mobile browsers. The folder log only updates while a tab is open. The digest softens this; it can't remove it.
4. **First public inbound AS endpoint.** GNAP opens the surface Groups.md §7.3 kept closed. §10.8 covers it, and the red-team list in the security doc §14.3 should gain "GNAP enumeration, replay, and silence-distinguishability".
5. **Two editions double the test matrix.** Edition-parameterized backend tests are required, not optional.
6. **The privacy filter becomes more central.** Autonomous release is the point of this edition, and the filter is heuristic (§12.2-2). The confirm screen should show the privacy-filtered PDF next to every allow card that would release it.
7. **Email deliverability.** Digests and immediate emails from a new domain (trustee.ai) need Resend domain verification (SPF/DKIM) before launch.
8. **Host trust.** Members hosted on Trustee's deployment trust Trustee's DO account. This needs plain disclosure (§11).

---

## 17. Decisions needed

| # | Decision | Recommendation |
|---|---|---|
| D1 | Edition name (env value and UI name) | `personal-as` / "Personal AS" (placeholder) |
| D2 | Private AI hosting in the edition | v1: **one lazily provisioned per-user agent, no KB**. Revisit serverless open-weights later for cost |
| D3 | Passkey required at setup? | **Yes.** An AS the patient returns to after a digest email must survive a cleared cookie |
| D4 | Where the edition is tested | Switch claude-self (test.agropper.xyz) to `personal-as` at P1 |
| D5 | Notification rules (§8.2), digest cadence | Immediate for ask (debounced) + every automatic share. Weekly digest. Monthly heartbeat when quiet |
| D6 | "Tokens" the group sells | Keep calling them **credits** in the UI. "Token" will mean GNAP access tokens in this version |
| D7 | Meaning of "a group posts a public request form to all members' accounts" | Assumed: **the group-hosted public form (W3) delivered to every member's AS**. Alternatives: (a) group-authored requests *to* members (the group as requester, which the envelope already supports); (b) a per-member public request page (would be the human face of each member's GNAP endpoint). Please confirm |
| D8 | GNAP access `type` identifier | `urn:maia:access:record:v1`, or an https URI on a domain you control long-term |
| D9 | Publish this document? | **Decided 2026-09-22: committed** to the public repo (like the security design doc); it contains no strategy content |
| D10 | Folder log format + server retention | `requests.jsonl` + `Request Log.html`; 90 days after decision, pruned only once synced; 365-day cap |
| D11 | PS routes in v1 | Apple Health + interview; other PDFs → offer `records-index` |

---

## 18. Documentation follow-ups (small, can ride P0)

- CLAUDE.md: current line counts; the test suite exists (`npm run test:backend`); add `policies.js`, `credits.js`, `records-pipeline.js` to key files; note the edition switch once it lands.
- Security design doc: correct §5's `normalizeCard` claim after the P0 fix; update the §14.1 test count; add I-24…I-30 and a GNAP section when P7 ships (and regenerate the posted PDF, per the standing rule).
- Groups.md: update the status header; point to the security design doc for work after July.
- Environment.md: current database list; add `MAIA_EDITION`; note that OpenSearch is only created on first indexing.
- Fix_Backlog.md: tick the shipped items.
- README: an edition section and a short feature list for the Personal AS edition.
