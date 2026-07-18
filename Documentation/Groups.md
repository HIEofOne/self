# Groups & Authorization Server — Implementation Documentation

**Status:** Pre-implementation (design discussion in progress)
**Started:** 2026-07-06
**Branch:** `claude/group-feature`

This is the living implementation record for the Groups feature. It is updated
as implementation proceeds — each change appends an entry to the
Implementation Log at the bottom. Design rationale and strategy discussions are
maintained separately and are not part of this document.

---

## 1. Feature Overview

Patient groups let members with a shared disease or situation connect and
exchange insights with peers, mediated by their own MAIAs, without any central
database of members' private records or interests.

Core principles:

- **Membership-only registry.** The database defining a group holds only what
  is needed to control membership and to enable mediated, privacy-preserving
  notification and communication. No clinical data. No interest profiles.
- **Per-patient Authorization Server (AS).** Each patient's MAIA operates an
  AS that processes external requests — from group members or unaffiliated
  requesting parties (RqPs). The AS is machine-native (signed JSON, no browser
  session): agent-to-agent by design. Deep links remain a separate,
  human-facing channel; an approved request *may* result in a patient choosing
  to mint one, but the AS never depends on the deep-link mechanism.
- **Three-outcome pipeline.** Every AS request resolves to exactly one of:
  autonomous response, patient notification (escalation), or spam-drop.
- **Deterministic policy, Cedar.** AS behavior is controlled by policies in
  the [Cedar policy language](https://www.cedarpolicy.com/) — a group
  administrator publishes a policy pack; the patient may modify their own
  overlay. The patient is the final authority over their own AS.
- **AI assists, never grants.** The patient's private AI may summarize,
  classify, or draft on the escalation path. Access is granted only by an
  explicit Cedar permit or an explicit patient action.
- **Standards trajectory.** The request protocol is shaped for later
  alignment with GNAP (RFC 9635) and HTTP Message Signatures (RFC 9421);
  standardization is a later phase, not a launch dependency.

## 2. Terminology

| Term | Meaning |
|---|---|
| Group | A membership set administered by a group admin, defined in the group registry |
| Group admin | The admin-role holder who controls group membership and publishes the group policy pack |
| Member | A patient whose MAIA holds a membership credential for a group; identified within the group by a pairwise pseudonym + patient-chosen alias |
| AS | The Authorization Server operated by each patient's MAIA |
| RqP | Requesting party — any external requester; may be a group member or unaffiliated |
| Policy pack | A versioned, signed set of Cedar policies published by a group admin |
| Patient overlay | Cedar policies set by the patient on their own AS; forbids always win |
| Membership credential | A signed artifact `{groupId, pairwiseId, memberPublicKey, expiresAt}` verifiable offline against the group's published key |
| Match-probe | A peer-matching query evaluated locally by each member's MAIA against its own records |

## 3. Architecture Components

### 3.1 Group Registry (group admin's deployment)

- New CouchDB database: `maia_groups`
- Group doc: metadata, admin identity, policy pack (versioned), membership
  list (pairwise pseudonyms, aliases, public keys, status)
- Publishes: group signing key, policy pack at a well-known URL

### 3.2 Per-patient Authorization Server (every deployment)

- New route surface: `/api/as/{asId}/…` where `asId` is an opaque per-patient
  identifier (not the userId)
- Request pipeline: verify signature/credential → classify principal → build
  Cedar request → evaluate → dispatch (autonomous / escalate / drop)
- New CouchDB database: `maia_as_requests` (statuses:
  `pending | auto-approved | patient-approved | denied | spam | expired`)
- Every decision is written to the existing `maia_audit_log` with the policy
  IDs that determined it
- Patient-facing **Requests** inbox: new Workbook rail tab; email
  notifications via the existing Resend infrastructure

### 3.3 Policy System

- Engine: `@cedar-policy/cedar-wasm` (official Cedar WASM build), evaluated
  in-process on the patient's deployment
- Cedar schema (entity/action vocabulary) versioned in this repo — the shared
  contract that admin-published packs must validate against
- Two policy layers: group pack (adopted baseline) + patient overlay
  (sovereign; Cedar forbid-overrides-permit)
- Patient policy UI: template toggles that generate Cedar, with the generated
  policy visible read-only

### 3.4 Reserved shapes (implemented as vocabulary now, capability later)

- **Action ladder** in the Cedar schema:
  `answer-from-record` < `compute-aggregate` < `run-simulation` <
  `act-under-protocol`. Phase 1 implements only `answer-from-record`-class
  actions; the ladder names the contract for later phases.
- **Computation-class field** in the AS request envelope, so future request
  types share the same pipeline and audit trail.
- **Machine attribution:** any AI-generated AS response is labeled as
  produced by the member's MAIA from documented records — never presented as
  the human.
- **Policy pack issuer role** metadata (`group-admin` vs
  `supervising-physician`), reserved for future delegation instruments.
- **State, not weights:** personalization of any per-patient agent behavior
  comes from the patient's evolving record (state), never from fine-tuning
  (weights).
- **Payment slot** in the AS request envelope: a proof-format-agnostic field
  reserved so request-attached payments ("stamps") can arrive in a later
  phase without re-architecture — a payment proof is just another credential
  in the envelope. The Cedar context vocabulary likewise reserves `price` /
  `stampValue` so pricing is policy (group packs set defaults; the patient
  overlay can price their own attention). An unpaid request that policy
  prices above zero receives an HTTP 402 challenge — a parameterized deny,
  not a new pipeline outcome. See §6.8.

## 4. Data Model (planned)

| Store | New/Existing | Contents |
|---|---|---|
| `maia_groups` | new | Group docs: metadata, policy packs, membership lists |
| `maia_as_requests` | new | AS request inbox per patient |
| `maia_audit_log` | existing | AS decision audit trail |
| `maia_users` userDoc | existing | + `asId`, per-group membership keys/credentials, patient policy overlay |

## 5. Phasing

| Phase | Delivers |
|---|---|
| **1 — Groups & membership** | `maia_groups`, admin UI, email invites, join flow (pairwise keys + signed credentials), member directory, Requests inbox + email notify. All requests escalate to the patient. Admin-hosted member onboarding (joining a group can provision the member's MAIA on the group's deployment). Aggregate liquidity signals. Mentor role (opt-in discoverability). |
| **2 — Cedar AS** | Policy engine, group packs + patient overlay UI, autonomous permits for message relay, RFC 9421 request signatures, audit-log wiring |
| **3 — Matching** | Relay fan-out with pull inboxes, local match evaluation by the member's private AI, match → notify / no-match → silence, double-consent introductions |
| **4 — Hardening & standards** | GNAP profiling, key rotation, cross-deployment trust policy |

Phase 1 note: because members can be provisioned on the group admin's
deployment, Phase 1 traffic is largely single-deployment. Federation *formats*
(pairwise keys, signed credentials, signed request envelopes) are built from
the start; cross-deployment federation *plumbing* is exercised when a member
actually resides on another domain.

## 6. Open Design Decisions (TBD)

Tracked here until resolved; resolution gets recorded in the Implementation Log.

1. ~~Membership credential lifetime / refresh cadence~~ — **RESOLVED
   2026-07-06**, see Implementation Log
2. ~~First-contact handshake~~ — **RESOLVED 2026-07-06**, see Implementation
   Log
3. ~~Relay mailbox retention policy~~ — **RESOLVED 2026-07-06**, see
   Implementation Log (includes E2E-encryption amendment to §3.2)
4. ~~Autonomous resource ceiling~~ — **RESOLVED 2026-07-06**, see
   Implementation Log (asymmetric ceiling; pack-validation constraint)
5. ~~Match-query expressiveness~~ — **RESOLVED 2026-07-06**, see
   Implementation Log (group-curated tags + free-text elaboration)
6. ~~Registry multi-tenancy~~ — **RESOLVED 2026-07-06**, see Implementation
   Log (multi-group from day one; per-group signing keys)

All six initial design decisions are resolved. New open items get added here
as implementation surfaces them.

7. ~~Group signing-key durability & recovery~~ — **RESOLVED 2026-07-06**,
   see Implementation Log (admin recovery kit in PR-2; CouchDB snapshot
   requirement; Phase 4 rotation doubles as recovery)

8. **Payments** — direction accepted 2026-07-06; per-phase implementation
   decisions remain open. The accepted invariants:
   1. **Payment identity binds to the hosting relationship (userId ↔ host),
      never to the group protocol (pairwiseId).** No payment data in the
      registry, the relay, or any AS message — payments must never become
      the correlation vector that deanonymizes pairwise membership.
   2. **No pairwise amounts persist in the middle.** Request-attached
      payments ("stamps") are flat-rate per request class and accounted as
      counters only (stamps-spent / stamps-earned per member) — the same
      privacy class as the §6.3 rate-limit counters. Cross-domain
      settlement is periodic host-to-host netting, never member-to-member.
   3. **Price is Cedar context; payment proof is an envelope credential**
      (see §3.4 reserved shapes). Group packs set default prices; the
      patient overlay prices the patient's own attention. Unpaid requests
      get an HTTP 402 challenge. One mechanism serves spam economics
      (no stamp, no escalation), mentor compensation, and consent-gated
      research queries ("answers, never data").
   4. **Credits redeem in service, never cash** (hosting offsets, AI usage,
      request fees) — keeps the group outside money-transmitter scope until
      a deliberate, counseled bearer-token/mint phase (L402/blinded ecash
      is the standards-track endgame for unlinkable request payments).
   5. Revenue objects and payer models: hosting share (seat-based group
      billing via the host as the default for the group archetype;
      member-pays-host for solo/practice archetypes), metered AI use
      (per-user usage ledger on the member's own deployment; pooled group
      token budgets preferred over per-member overage), and
      requester-pays stamps.
   Phasing: P0 usage ledger + reserved shapes (rides Phase 1–2) →
   P1 seat billing → P2 metered AI → P3 stamps/402/Cedar pricing (with
   Phase 3 matching) → P4 bearer tokens + federation netting.

## 7. Phase 1 Implementation Plan

Scoped 2026-07-06 from the resolved §6 decisions. Each work item is a
PR-sized unit landing on `main` behind natural gating (Groups UI only appears
when a deployment has a group or the user has a membership), so `main` stays
releasable throughout.

### 7.1 Data model

**`maia_groups`** (new db, on the group host) — one doc per group:

```json
{
  "_id": "<groupId>",
  "type": "group",
  "name": "…", "description": "…",
  "signingKey": { "publicKeyJwk": {}, "privateKeyJwk": {} },
  "tagVocabulary": ["mentorship", "newly-diagnosed", "…"],
  "policyPackVersion": 0,
  "members": [{
    "pairwiseId": "…",
    "alias": "…",
    "signingPublicKeyJwk": {},
    "encryptionPublicKeyJwk": {},
    "status": "invited | active | revoked",
    "invitedAt": "…", "joinedAt": "…",
    "inviteEmail": "(retained only while status=invited; deleted at join)",
    "mentor": false,
    "lastRefreshAt": "…"
  }]
}
```

Registry-minimalism rule: the invite email is deleted the moment the member
joins — after that, the registry knows only alias, keys, status, and the
refresh heartbeat. All member contact is mediated (relay), never direct.

**`maia_relay`** (new db, on the group host) — transient mailbox messages:
`{groupId, toPairwiseId, fromPairwiseId, ciphertext, createdAt, expiresAt}`.
Deleted on acknowledged pull; TTL-swept at 30 days (§6.3).

**`maia_as_requests`** (new db, on the member's deployment) — the patient's
AS inbox: `{userId, requester{kind, groupId, pairwiseId, alias}, action,
computationClass, payload, receivedAt, status, aiSummary?, decidedAt?,
decidedBy: 'patient'|'policy'}`. Statuses per §3.2.

**`maia_users` userDoc additions** (member side): `asId` (opaque, generated
once), `groupMemberships[]` — per group: registry URL, pairwiseId, alias,
signing + encryption keypairs, current credential (refreshed daily),
mentor flag, receipt switches, accepted-senders list, blocked list.

### 7.2 Cryptography (Phase 1)

- **Signing:** Ed25519 (Node built-in). The group key signs membership
  credentials; member keys sign requests/refresh calls.
- **Encryption:** X25519 ECDH + AES-256-GCM (sealed-box pattern) to the
  recipient's per-group encryption key. Members therefore hold two keypairs
  per group (sign + encrypt), both public halves in the registry.
- **Interim request signing:** detached JWS-style signature over the JSON
  body. RFC 9421 HTTP Message Signatures replace this in Phase 2; the
  envelope shape (incl. the reserved `computationClass` field) is final now.

### 7.3 Endpoint surface

Group registry (host deployment):

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/groups` | admin session | Create group (generates signing keypair) |
| `GET /api/groups` | admin session | List groups |
| `PUT /api/groups/:groupId` | admin session | Update metadata / tag vocabulary |
| `POST /api/groups/:groupId/invites` | admin session | Email invite w/ one-time token (Resend) |
| `DELETE /api/groups/:groupId/members/:pairwiseId` | admin session | Revoke membership |
| `GET /api/groups/:groupId/info` | public | Metadata + group public key (well-known) |
| `POST /api/groups/:groupId/join` | invite token | Submit keys + alias → signed credential |
| `POST /api/groups/:groupId/refresh` | member signature | Daily heartbeat: fresh credential + receipt-prefs sync + mailbox pull |
| `POST /api/groups/:groupId/relay` | member signature | Send `{toPairwiseId, ciphertext}` |
| `GET /api/groups/:groupId/directory` | member signature | Aliases + mentor flags |
| `GET /api/groups/:groupId/stats` | member signature | Aggregate liquidity only |

Patient AS (member deployment) — session-authenticated UI endpoints only:
`GET /api/as/requests`, `POST /api/as/requests/:id/decision`
(accept / decline / block — decisions write durable policy facts to the
userDoc per §6.2). **Phase 1 has no public inbound AS endpoint**: all intake
is via the member's own MAIA pulling the relay, so nothing listens for
unsolicited traffic until Phase 2 introduces the signed public endpoint.

Server cron: daily per-membership refresh+poll; TTL sweeps (relay messages,
expired invites, expired pending requests).

### 7.4 Frontend

- **Admin:** new `AdminGroups.vue` alongside AdminUsers — create group, edit
  tag vocabulary, invite by email, member list with revoke.
- **Patient:** new Workbook rail tab **Groups** containing: memberships
  (join via invite link, alias choice, mentor toggle, receipt switches),
  member directory, and the **Requests** inbox (pending cards with sender
  alias + group + AI summary, full text behind a tap; Accept / Decline /
  Block).
- **Invite → join flow:** invite email links to the host deployment with the
  token. Existing user: sign in → choose alias → join. New user: the token
  rides through the setup wizard, membership finalizes when setup completes
  (join-group ≡ get-a-MAIA).
- Email notification (Resend) to the patient on each new pending request.

### 7.5 Work breakdown (PR-sized, in order)

1. **PR-1 — Registry & admin UI:** `maia_groups`, group CRUD endpoints,
   per-group signing keys, `AdminGroups.vue` (create / tags / list).
2. **PR-2 — Invites & join:** invite emails + tokens, join endpoint
   (keys/alias/credential), patient Groups tab skeleton with membership
   list, invite-through-wizard path.
3. **PR-3 — Relay & heartbeat:** `maia_relay`, relay/refresh endpoints,
   E2E encryption, daily cron (refresh + poll + TTL sweeps).
4. **PR-4 — Requests inbox:** `maia_as_requests`, poller→inbox conversion,
   inbox UI cards, accept/decline/block writing policy facts, Resend
   notifications, private-AI request summaries.
5. **PR-5 — Directory & liquidity:** member directory view, mentor flag,
   receipt switches, aggregate stats.

Micro-decisions embedded above, flagged for veto: (a) invite email deleted
from the registry at join; (b) no public inbound AS endpoint until Phase 2;
(c) two keypairs per membership (sign + encrypt); (d) interim detached
signature before RFC 9421.

## 8. Implementation Log

Entries are appended as work lands: date, version, branch/PR, what changed,
and any design decisions resolved.

- **2026-07-06** — Document created; feature branch `claude/group-feature`
  cut from main at v1.4.99. No implementation yet; design discussion in
  progress.
- **2026-07-06** — **§6.1 RESOLVED: membership credential lifetime.**
  24-hour credentials with automatic server-side daily refresh. Offline
  verification preserved (registry never observes member-to-member
  interactions; refresh heartbeats are the only registry contact and double
  as the liveness signal for aggregate liquidity stats). Revocation
  characteristics: relayed traffic revokes instantly (the relay lives on the
  registry's own deployment and checks live membership); direct AS-to-AS
  contact honors the credential for at most 24 h after revocation; any
  patient can instantly and unilaterally block a pairwiseId via an overlay
  forbid. A dormant MAIA stops refreshing and fades out fail-safe, matching
  MAIA's existing dormancy model. Dial-down option if abuse patterns warrant:
  shorten lifetime to 4–6 h; architecture unchanged.
- **2026-07-06** — **§6.2 RESOLVED: first-contact handshake.** Pairwise
  handshake ON by default: the first `relay-message` from a sender the
  patient has not dealt with escalates (notification card: sender alias +
  group + private-AI one-line summary, full text one tap away); subsequent
  messages from an accepted sender flow autonomously. Accept / Decline /
  Block are one-click inbox actions that write durable policy facts: Accept
  adds the sender's pairwiseId to the patient's accepted-senders entity set;
  Block writes an overlay forbid. The default is a patient-overlay toggle;
  the mentor policy pack auto-accepts first contact by design (volunteering
  to be reachable is what the mentor role means). Side effect: during the
  ≤24 h credential revocation tail (§6.1), a revoked member can only send
  connection requests, not deliver content to non-accepted members.
- **2026-07-06** — **§6.3 RESOLVED: relay mailbox retention** (with a
  structural amendment to §3.2):
  1. **E2E encryption (amendment):** relayed payloads are encrypted to the
     recipient's per-group public key (already published in the registry);
     the relay stores ciphertext + routing envelope only. The content
     honeypot is eliminated by construction, not by retention policy.
  2. Delivered messages are deleted on acknowledged pull; messages then live
     only at the edges (sender's and recipient's own MAIAs, each
     audit-logging locally).
  3. Undelivered TTL: 30 days, then silent deletion.
  4. **Receipts are recipient policy** (AG amendment): per-patient overlay
     switches for delivery and read receipts, default OFF; receipts are only
     ever issued to accepted senders (first-contact strangers always get
     silence — no probe oracle); expiry notices are issued by the relay per
     the recipient's preference, synced privately at refresh time; the
     mentor pack defaults receipts ON. Receipt issuance is expressed as
     Cedar actions (`issue-delivery-receipt`, `issue-read-receipt`).
  5. Relay retains only rolling per-sender rate-limit counters and aggregate
     liquidity statistics — no per-message logs after disposition.
  6. The daily mailbox poll piggybacks on the §6.1 daily credential-refresh
     heartbeat (one trip).
- **2026-07-06** — **§6.4 RESOLVED: autonomous resource ceiling —
  asymmetric.** Who authors a permit determines what it can say:
  1. **Group packs and shipped templates can never grant autonomous
     clinical-resource release.** Enforced structurally: pack validation
     rejects any policy permitting `request-resource`-class autonomous
     actions on clinical resources (schema-level constraint in the pack
     publishing pipeline, built into Phase 2 validation from the start).
     Joining a group can never open a member's records.
  2. **The patient overlay CAN pre-authorize release of the patient's own
     existing records** — via a deliberate, high-friction, per-resource,
     per-principal-class opt-in flow (names the resource and principal
     class, shows a sample matching request, requires typed confirmation).
  3. **Break-glass is the flagship application**: a patient-authored
     standing permit granting, e.g., a verified emergency clinician
     autonomous access to the Patient Summary, with immediate notification
     and full audit. The policy slot exists from the start; the emergency
     credential proof is defined in a later phase.
  4. **The absolute line:** autonomous release means disclosure of existing
     records with citations — AI-synthesized clinical content is never
     delivered to a third party without patient review, regardless of any
     policy. (This is the method-to-device boundary applied to the AS.)
  Principle: defaults never release; admins can never release; patients may
  deliberately pre-authorize release of their own existing records;
  AI-generated clinical content to others always has a human in the loop.
- **2026-07-06** — **§6.5 RESOLVED: match-query expressiveness — hybrid.**
  A match query = one topic tag from a small group-curated vocabulary
  (maintained by the group admin, versioned with the policy pack; ~a dozen
  condition-appropriate entries) + optional free-text elaboration. Division
  of labor: Cedar filters deterministically on the tag (the patient overlay
  tunes which tags may reach notification); the patient's private AI judges
  relevance of the full query against the KB; match → notify patient,
  no-match → silence (unchanged). Security note recorded: the three-outcome
  pipeline structurally contains prompt-injection blast radius — a match
  evaluation has no outward channel (its only outputs are notify-patient or
  silence), so hostile queries can annoy but cannot extract. Notification
  cards render attacker-controlled text defensively (sanitized AI summary;
  raw text behind a tap). Queries are signed, attributable to a pairwiseId,
  and rate-limited by the relay's existing counters.
- **2026-07-06** — **§6.6 RESOLVED: registry multi-tenancy — yes, from day
  one.** One deployment hosts many groups. Two commitments pinned: (1)
  **signing keys are per-group, not per-deployment** — credentials verify
  against the group's own key, so a group can migrate hosts without
  re-keying members; (2) **pairwise IDs remain per-group even when groups
  share a host** — the protocol never links a patient's identities across
  groups. Phase 1: group admin = deployment admin; delegated per-group
  admin roles are a noted future enhancement (the per-group key
  architecture already accommodates them).
- **2026-07-06** — **§7 Phase 1 Implementation Plan drafted** — data model
  (`maia_groups`, `maia_relay`, `maia_as_requests`, userDoc additions),
  cryptography (Ed25519 + X25519/AES-GCM, interim detached signatures),
  endpoint surface (registry + session-authed inbox; no public inbound AS
  endpoint until Phase 2), frontend (AdminGroups.vue, patient Groups tab
  with Requests inbox, invite-through-wizard), and a 5-PR work breakdown.
- **2026-07-06** — **§6.7 RESOLVED: group signing-key durability &
  recovery.** The per-group private key lives only in the `maia_groups` doc
  (random entropy — deliberately NOT derived from the DO token: token
  rotation would break group identity, and a derived key contradicts §6.6
  portability). Server restarts and app rebuilds are safe (stateless app;
  state in CouchDB). Loss of CouchDB without backup kills the group within
  24 h (§6.1 refresh stops). Resolution: (a) **admin recovery kit** — a
  download of the group's key material offered at group creation,
  held by the admin; ships in its own dedicated PR; (b) **operations
  requirement**: the CouchDB droplet must have snapshots enabled —
  `maia_groups` is the one database reconstructible from neither derivation
  nor patient-side backups; (c) the Phase 4 key-rotation protocol doubles
  as graceful recovery.
- **2026-07-06** — **PR-1 merged** (#141, v1.5.1 — starts the 1.5.x minor
  line for the Groups feature): group registry (`maia_groups`), admin CRUD
  endpoints, per-group Ed25519 signing keys (private key never leaves the
  server), public `/api/groups/:groupId/info` well-known endpoint, tag
  vocabulary normalization, audit-log events, `AdminGroups.vue` embedded in
  the admin page. (Docs PR #140 merged the same day; this log's §6.7
  entries were recovered into the recovery-kit PR after a merge race.)
- **2026-07-06** — **Recovery kit implemented (§6.7(a) and (b))**:
  `GET /api/groups/:groupId/recovery-kit` (admin-gated) downloads the
  group's key material as `maia-group-recovery-<groupId>.json` — the ONLY
  code path that exports the private signing key. Deliberately
  re-downloadable rather than strictly one-time (a failed first download
  must not brick recovery; the admin can read CouchDB regardless); every
  export is audit-logged (`group_recovery_kit_exported`) and counted, and
  the admin UI shows last-export time and count so unexpected exports are
  visible. AdminGroups.vue: key-icon download button with an explanatory
  confirmation, offered automatically at group creation; the group row
  warns in orange until the first export. Operations note added to
  `Documentation/Environment.md` (CouchDB droplet snapshots required).
- **2026-07-06** — **PR-2: invites & join flow.** Registry side: single-use
  invite tokens (only the SHA-256 hash is stored; 14-day TTL; re-invite
  replaces), invite email via Resend with copyable-link fallback when email
  is unconfigured, `POST /join` redeems the token — activates the member,
  DELETES the invite email and token hash (registry-minimalism enforced at
  the moment of join), and returns a signed 24 h membership credential
  (`maia-group-credential-v1`: base64url(JSON) + '.' + base64url(Ed25519
  sig), §6.1/§7.2 interim format). Member management: admin members list
  (email visible only while invited), cancel-invite (entry removed) vs
  revoke (status kept for audit attribution). Patient side:
  `POST /api/user-groups/join` generates per-group Ed25519 + X25519
  keypairs, redeems at the registry over HTTP (the federation seam — same
  host in Phase 1), stores the membership + private keys on the userDoc,
  assigns `asId` on first join; `GET /api/user-groups` returns memberships
  with no private-key material. Frontend: Groups rail tab in the Workbook
  (`GroupsPanel.vue`) with membership list and pending-invite banner;
  invite capture in App.vue stores the link params in localStorage so the
  invite survives the setup wizard (join-group ≡ get-a-MAIA) with zero
  wizard code changes; AdminGroups members/invites dialog (invite by email,
  copy link, cancel/revoke). Tested end-to-end locally including offline
  Ed25519 credential verification against the member-cached group key,
  token single-use across users, and registry email deletion at join.
- **2026-07-07** — **PR-2.1: invite UX polish** (from AG's live test of
  v1.5.3 on test.agropper.xyz). (1) Welcome-page invite banner: an invitee
  landing from the email now sees the group name and what to do next; when
  the browser lacks the File System Access API (e.g. Safari opening the
  email link), the banner explains MAIA needs Chrome and offers a
  copy-link button — the token is durable, so re-opening in Chrome works.
  (2) Post-auth notification with an "Open Groups" action (suppressed
  while the setup wizard is active — the invite waits in localStorage).
  (3) New public `GET /api/groups/:groupId/invite-info?token=…` returns
  group metadata + invite validity and marks `inviteOpenedAt` (first
  open); the admin members dialog now shows invited → link-opened →
  joined progress, and dead tokens clear the patient-side banner
  immediately. `inviteOpenedAt` is deleted at join with the other invite
  fields (registry-minimalism). (4) Admin user list gains a **Groups**
  column (group-name badges from `userDoc.groupMemberships`). (5) App
  version shown in the admin page header.
- **2026-07-07** — **PR-2.2: dead invite tokens explain themselves** (from
  AG's re-test: the invite banner flashed sub-second and vanished in both
  browsers). Cause: when `invite-info` reported the token invalid, the
  banner was cleared silently — and the tested link was dead because a
  newer invite to the same address had replaced it (single-active-invite
  design). Fix: invalid tokens now swap the banner for a persistent,
  dismissible explanation (used/replaced vs expired wording) on both the
  welcome page and the Groups tab, including the join-failure path; the
  admin invite-result note now states that a new invite replaces older
  links.
- **2026-07-08** — **PR-2.3: admin UX + banner overflow + admin session.**
  From AG's v1.5.5 test: (1) Welcome-page invite banners overflowed their
  box — root cause was flexbox `min-width: auto` preventing shrink;
  rewritten as plain flex divs with `min-width: 0` + `word-break`. (2)
  Admin header collapsed: a single combined status line (users, deep-link
  users, passkey rpID/origin) just before the header; Customer Balance
  collapsed to a single line just below it. (3) Patient Groups redesigned
  from cards+modal to an inline table: one single-line header per group
  (name, id, counts, tags, created, recovery-kit state, action icons)
  with member rows beneath (email/alias · status · accepted/invited/opened
  dates · mentor) and a red trash per member (cancel invite / revoke /
  remove revoked entry, each behind a confirm). Server DELETE now
  hard-removes an already-revoked member (`member_removed`) so the trash
  is meaningful in every state. (4) **Admin session reuse**: the `/admin`
  route now checks `/api/current-user` before prompting for a passkey, so
  a tab reload within the 24 h session (including Chrome incognito, where
  the cookie persists for the window's life) no longer re-prompts. No new
  cookie was needed — the 24 h express-session cookie already existed; the
  frontend simply wasn't consulting it on the admin route.
- **2026-07-09** — **PR-2.4: leave a group + clearer re-invite handling.**
  From AG's test: a user re-invited to a group they already belong to got
  silently blocked (a MAIA holds one membership per group), leaving them
  stuck under the old alias while the registry accumulated a second entry.
  Added the missing primitive — **leaving a group**: `POST
  /api/user-groups/leave` signs a `{action:'leave',groupId,pairwiseId,ts}`
  claim with the membership's pairwise Ed25519 key and calls the new
  registry endpoint `POST /api/groups/:groupId/leave`, which verifies the
  signature against the stored member public key and removes the entry
  (a minimal early instance of the RFC 9421 signed member→registry
  requests coming in a later phase). The local membership is dropped even
  if the registry call fails (credential then dies within 24 h). The
  Groups tab now shows a **Leave** button per membership (with confirm),
  and a pending invite for a group you're already in shows a clear
  "already a member as {alias} — Leave first to switch names" message
  instead of vanishing. Tested locally: join → leave (signature verified,
  registry entry removed) → membership gone; forged-signature leave
  rejected with 403 and the member stays active.
- **2026-07-09** — **PR-3: relay + heartbeat + daily cron** (§6.1/§6.3/§7.3).
  New `maia_relay` db (transient sealed messages). **E2E encryption**:
  X25519 ECDH → HKDF-SHA256 → AES-256-GCM sealed box; the relay stores only
  the opaque box + routing envelope and never holds a key (verified: no
  plaintext in `maia_relay`). Registry endpoints (all pairwise-Ed25519
  signed): `refresh` (renew 24h credential, stamp `lastRefreshAt` liveness,
  return pending messages, delete acked ones, report `revoked` for
  revoked/removed members), `relay` (store sealed msg; sender+recipient must
  both be active → instant revocation for relayed traffic), `member-key`
  (signed lookup of a member's X25519 key for sealing), `stats` (aggregate
  active + recently-active counts only). Member side: `/api/user-groups/`
  `refresh` (renews all memberships, **drops any the registry reports
  revoked** — reconciles registry-side revocation, closing the earlier
  staleness caveat), `send` (looks up recipient key, seals, relays —
  reply-to-sender needs no directory), `messages` (decrypted inbox stored on
  the userDoc). Daily cron (`setInterval`, 5 min after boot then every 24h):
  runs the member refresh across all users + sweeps expired relay messages
  (30-day TTL) and expired invites. GroupsPanel: per-membership inbox
  (expand, refresh, reply) with E2E send. Tested locally end-to-end: send →
  relay ciphertext-only → refresh pull+decrypt → ack-delete → admin revoke →
  member refresh drops membership → relay to revoked member blocked;
  forged-signature relay/refresh rejected. Deferred to PR-5 (directory):
  first-contact compose to arbitrary members (PR-3 supports reply-to-sender).
- **2026-07-09** — **PR-4: AS requests inbox** (§4 three-outcome pipeline,
  Phase-1 "escalate everything" — no Cedar yet). New `maia_as_requests` db.
  Per §7.3 there is no public inbound AS endpoint in Phase 1: **AS requests
  travel over the PR-3 relay**. A request is a sealed envelope with
  `maiaType:'as-request'` carrying `action`, `resource`, and the reserved
  `computationClass` + `payment` slots (§3.4); the kind lives INSIDE the
  sealed payload, so the relay still can't tell a request from a message.
  On refresh, the member's MAIA decrypts and routes: as-request →
  `maia_as_requests` (status `pending`), plain text → message inbox.
  Dispatch is Phase-1 simple: every request escalates to the patient
  (stored pending + best-effort email to `userDoc.email`); a request from a
  **blocked** sender is silently spam-dropped on ingest (the Phase-1
  stand-in for a Cedar forbid). Endpoints: `POST /api/user-groups/request`
  (send an AS request — envelope, not text), `GET /api/user-groups/requests`
  (patient inbox), `POST /api/user-groups/requests/:id/decision`
  (accept / decline / block). accept→acceptedSenders, block→blockedSenders
  on the membership — the §6.2 policy facts Cedar will formalize in Phase 2.
  GroupsPanel gains a Requests section (cards + accept/decline/block).
  Tested locally: AS request routed to requests (plain message to inbox);
  block sets status + spam-drops the sender's next request (newRequests 0).
  Deferred: server-side private-AI request summaries (best-effort AI on the
  escalation path, §4) — the deterministic pipeline lands first.
  NOTE: PR-4 was first opened stacked on PR-3's branch (#150). After #149
  merged, #150 was accidentally merged into the (now-stale) PR-3 branch
  instead of main — so main never received PR-4 and the deploy stayed at
  1.5.8. Re-landed here as a clean PR-4-only diff off main. Lesson: don't
  stack a PR on another PR's branch — wait for the base PR to merge, then
  branch off main.
- **2026-07-09** — **PR-5: directory & liquidity + mentor role** (§6.6, §7.5;
  completes Phase-1 peer reachability). Registry: `GET /api/groups/:groupId/
  directory` (signed, member-only) returns aggregate liquidity
  (`activeMembers`, `recentlyActiveMembers`) PLUS the opt-in-discoverable
  members (mentors) by alias + pairwiseId — **regular members are never
  individually listed** ("aggregate liquidity, individual silence"); the
  caller is excluded from the mentor list. `PUT /api/groups/:groupId/
  members/:pairwiseId/mentor` (admin) toggles a member's mentor flag —
  admin-curated mentor supply for launch (member self-opt-in is a noted
  follow-up). Member side: `GET /api/user-groups/directory` signs and
  proxies to the registry. **First-contact compose**: the Groups tab's
  "Find peers" panel shows liquidity + mentors, each with a Message button
  that composes to that mentor via the existing E2E `/send` — closing the
  deferral from PR-3/PR-4 (previously reply-to-sender only). AdminGroups:
  a star toggle per active member sets mentor. Tested locally: directory
  lists only mentors while the aggregate count reflects all active members;
  admin mentor toggle; caller excluded from own directory; first-contact
  message to a mentor delivered; forged/non-member directory requests
  rejected 403. Deferred: member self-opt-in as mentor; reaching a specific
  non-mentor member (via match-probe in Phase 3 or an introduction).
- **2026-07-10** — **Groups UX + Signal-style redesign** (post-PR-5 polish,
  PRs #153–#156). Local-folder nesting guard: picking a folder that holds
  another account's `maia-state.json` is blocked; a folder with MAIA
  artifacts but no state file (e.g. a `chats` subfolder) warns before use.
  Groups rail icon gained a blue-triangle alert (pending invitation /
  request / new messages; `GET /api/user-groups/alerts`) with informative
  hover text. Admin sessions that open a group-invite link now get an
  explanatory banner instead of a silent bounce to /admin. The Groups tab
  was rebuilt as a two-pane Signal-style layout: left rail of groups with
  per-peer conversations (avatar, snippet, unread, "wants to connect"),
  right pane with a bubble thread + composer; first-contact requests
  render inline as message-request cards (Accept/Decline/Block). Sent
  messages are now recorded per membership (`outbox`, capped, userDoc
  only — never the registry) so threads show both sides; sender/recipient
  aliases resolve best-effort via the signed member-key lookup. Full
  two-member E2E test passed on the test deployment.
- **2026-07-10** — **PR-6: quick-start onboarding tier** (§7 adoption
  floor; "chat + Private AI, no records yet"). The Setup Wizard offers
  "Quick start — no records yet" beside the standard folder pick: the
  user picks a new (typically empty) MAIA folder, the private AI agents
  deploy (≈1 min), and setup completes WITHOUT records upload, KB
  indexing, or patient-summary drafting. The account lands on a new
  `workflowStage: 'chat_ready'` (set via `POST /api/wizard/quick-start-
  complete`; never downgrades a completed account), which counts as
  wizard-done (no perpetual setup spinner, no meds-verify nag), and the
  Workbook opens on the Groups tab — join a group and chat immediately.
  A dismissible "Add records" banner above the chat composer upgrades
  the account: it re-runs the standard wizard over the same folder
  (already-deployed agents complete instantly; new records upload, index,
  and the draft-summary → medications → summary verification flow runs
  exactly as first-time setup, advancing the stage past `chat_ready`).
  Quick-start selection survives reloads mid-deploy. Groups membership
  and the agent persist across the upgrade. Deferred to PR-7: transient
  context documents + privacy-filter wiring for chat+AI.
- **2026-07-10** — **PR-6.5: frictionless invitee onboarding** (quick-start
  polish from first local testing). (1) **Folder deferred**: quick start no
  longer picks a local folder at all — agents were already requested at
  account creation and mount-time polling detects readiness, so the run is
  literally zero-decision; the folder is asked for when first needed (the
  "Add records" upgrade opens the standard folder pick). (2) **Invite-aware
  welcome**: with a pending group invite, GET STARTED becomes
  "JOIN <group>" and the wizard auto-selects quick start (sessionStorage
  handoff; never affects restores/existing accounts) — the invitee goes
  from one button click to a deploying private AI with no fork, no folder,
  no jargon (subtitle: "Setting up your private AI — about a minute").
  (3) **Alias = MAIA pseudonym**: the join card prefills the display name
  with the userId (editable) — no second naming ceremony; join is one
  click. (4) **Groups landing fixed**: quick-start completion previously
  raced the wizard-resume machinery (status refresh against a stale
  workflowStage could reopen My Lists); completion now lands on
  Workbook → Groups synchronously, marks resume as attempted, and
  refreshes status afterwards.
- **2026-07-12** — **PR-8: member-initiated invites + seeded first thread +
  passkey nudge** (adoption sequence per design review). Registry:
  `POST /api/groups/:groupId/member-invites` — an ACTIVE member (signed
  member-invite claim) invites by email, subject to the group's new
  `memberInvitesAllowed` admin policy (default ON; toggle in the admin
  create/edit dialog; enforced at the registry). The invite entry records
  `invitedByPairwiseId`; the invite email names the inviter by group alias.
  Shared `mintInvite` helper now backs both admin and member invites.
  Join returns `inviter { pairwiseId, alias }` (if still active); the
  joiner's membership stores `invitedBy` and pre-accepts the inviter
  (mutual consent). Member side: `POST /api/user-groups/invite` proxy;
  Groups tab's group-info pane gains an "Invite someone" email box (link
  shown for copy/paste when email isn't configured). The invitee's rail
  always shows the inviter as a conversation ("Invited you — say hi") and
  joining lands directly in that thread — the empty-room problem is gone.
  Passkey nudge: temporary quick-start accounts see a dismissible banner
  ("your account only exists in this browser — add a passkey") wired to
  the existing add-passkey dialog.
- **2026-07-13** — **PR-9: shareable join-request link + QR + approval
  queue** (adoption sequence step 2; the join-mode enum IS the Layer-2
  admin policy). Group gains `joinMode` ('invite-only' default |
  'link-approval') and an admin-rotatable `joinLinkToken`. Registry:
  public `GET join-info` (validates a link for the request card),
  `POST join-requests` (creates a 'requested' member entry carrying the
  requester's pairwise public keys — no email ever stored), signed
  `GET join-requests/:pairwiseId/status` (approval hands over credential +
  group key), admin `PUT members/:pairwiseId/approve`, `POST
  rotate-join-link` (voids old links/QR instantly; DELETE now rejects
  'requested' entries outright). Member side: `POST /api/user-groups/
  request-join` (keys + request + pendingGroupJoins on the userDoc) and
  `POST poll-joins` (approval → full membership; the Groups panel's 5s
  auto-poll calls it, so admission lands within seconds). UI: welcome
  page captures ?groupJoin= (button becomes "REQUEST TO JOIN <group>",
  quick start preselected); Groups tab shows the request card (prefilled
  pseudonym) and hourglass "waiting for approval" rail rows; AdminGroups
  edit dialog gains the join-by-link toggle with the link, a QR code
  (qrcode dep), and Rotate; requested members show purple with
  Approve/Reject. Also: group-row tooltip now mentions invites (PR-8
  feedback).
- **2026-07-13** — **PR-10: posting-policy form v1** (adoption sequence
  step 3; Layer-1 "displayed" policy — joining is accepting). Group gains
  admin-authored free-text `postingPolicy` (create/edit dialog textarea,
  4000-char cap). Shown wherever someone decides to join: the email-invite
  card and the join-request card render it under "Group policy — joining
  means you accept it"; members re-read it in the group-info pane (carried
  on the signed directory response). Also on the public invite-info/info
  views (a posting policy is community guidelines, not a secret). No
  machine enforcement yet by design — the join-mode enum (PR-9) is the
  enforceable Layer 2; Cedar execution is Phase 2.
- **2026-07-13** — **PR-11: existing-MAIA join** ("already have a MAIA? no
  new one needed"). The Groups rail gains a link button → "Join a group by
  link" dialog: paste any invite (?groupInvite=) or join (?groupJoin=)
  URL and the same card/join machinery runs with the LINK's origin as the
  registry — the member's account stays on their own deployment. The two
  browser-side registry reads (invite-info / join-info) now go through
  member-server proxies (GET /api/user-groups/invite-info|join-info,
  session-gated, http(s)-only registry validation) so CORS stays closed;
  every other federation call was already server-to-server (no Origin
  header → passes the existing CORS gate). Signed claims carry no
  timestamp-freshness check, so cross-host clock skew is a non-issue in
  the interim format. Welcome-page invite banner now tells existing MAIA
  owners about the paste path. Needs the two-deployment test (localhost
  member ↔ test deployment registry) before relying on it.
- **2026-07-14** — **PR-12: Sharing Policies tab (policy cards v1)**
  (Refinement 7 foundation; the §6.2 Phase-1 stand-ins get their real
  successor). New Workbook tab "Sharing Policies". A policy CARD is the
  canonical structured object — Requesting Party (anyone | group | peer),
  Purpose, Scope, privacy-filter flag, minimum Signature level, Payment —
  stored on the userDoc (`sharingPolicies`, CRUD at /api/user-policies,
  server/routes/policies.js, enum-validated). The plain-language sentence
  is a DETERMINISTIC projection (src/utils/policyCards.ts `sentenceFor`);
  the editor shows it live as chips are changed. Evaluation is
  Cedar-style and deterministic (`evaluate`: enabled deny wins → allow →
  else ASK ME): the stated default stays "MAIA asks you about everything
  unless you've told it otherwise". The tab includes the "Try it"
  simulator (hypothetical requester → ALLOW / ASK ME / DENY + which card
  decided) and provenance sections (group-suggested vs user cards; group
  policy-pack delivery rides the reserved policyPackVersion in a later
  PR). Deliberately deferred: born-from-decisions inbox hook (today's AS
  requests are messaging-scoped, already remembered as accepted/blocked
  senders — data-scoped requests arrive with Cedar/Phase 2), Cedar code
  projection, AI assist roles (Refinement 7a), AS enforcement wiring.
- **2026-07-14** — **PR-13: AS enforcement wiring** (policy cards become
  live). `ingestAsRequests` now evaluates each incoming AS request
  against the user's sharing-policy cards (server-side ports of the
  deterministic evaluator/sentence renderer, exported from
  server/routes/policies.js) whenever the request's `resource` maps to a
  policy scope: an enabled DENY match drops it silently (audited,
  `as_request_policy_denied`), an ALLOW match stores it pre-accepted with
  the deciding card's sentence SNAPSHOTTED on the doc (audit shows the
  sentence as it read at decision time) and pre-accepts the sender (same
  fact the human Accept writes), anything else stays 'pending' (ASK ME).
  Messaging requests (resource 'inbox') have no policy scope and always
  escalate — no dishonest data cards. Request envelopes now carry an
  optional `purpose` (validated enum, default 'any'); the requests API
  returns purpose + decidedBySentence, and the peer thread shows
  "Auto-accepted by your policy: <sentence>" — the audit trail teaches
  the policy system. Signature is 'group-member' (what the relay proves);
  NPI/Doximity levels and payment enforcement arrive with their
  respective infrastructure. The AI remains outside the enforcement path.
- **2026-07-14** — **Refinement 6 step 1: peer threads open in the chat
  area.** New src/components/PeerThreadView.vue — the E2E thread as a
  self-contained component: identity header (peer alias + "member of
  <group>" chip + "your AI is not part of this conversation"), bubbles
  with per-message sender labels, pending-request card
  (Accept/Decline/Block), "auto-accepted by your policy" note, composer,
  "Request records" dialog, and its own 5s pull. Clicking a conversation
  in Workbook → Groups now emits open-thread → the Workbook closes and
  the MAIN chat area renders the thread (back-arrow returns to the AI
  chat). GroupsPanel shrinks to discovery + group management (rail,
  invites, join links, group info); its embedded thread/composer/request
  code was removed. Two surfaces remain by design (AG choice: "thread
  opens in chat area"); the unified conversation rail and AI-chat
  identity chips are candidate next steps.
- **2026-07-14** — **Refinement 6 step 3: unified share action (queue
  complete).** Every AI answer in the chat area gains a "Share to peer"
  button → dialog that lists the peers you already converse with (built
  from memberships × message history), applies the MANDATORY privacy
  filter (restored POST /api/user-groups/filter-text — the
  userDoc.privacyFilter name mapping, same source as physician deep-link
  sharing), shows the filtered text for human review, and sends over the
  existing E2E /send. If no mapping is configured the user is warned to
  review carefully. The AI is the assistant; the human performs the
  share; the AI is never a participant in the E2E channel. This retires
  the reverted PR-7's remaining durable plumbing back into service.
  Refinement 6 ("one chat, three doors") is now complete: threads in the
  chat area (step 1), grounded identity chips/probe (step 2), one share
  action (step 3).
- **2026-07-14** — **Unified conversation rail (chat-area counterparty
  selector).** New src/components/ConversationRail.vue: a left sidebar in
  the chat area listing every counterparty under shaded category headers
  — Private AI, Public AI, Stored Chats (incl. deep links), and one
  section per Group with its peer conversations. Category accents MATCH
  the message-chip color (Private AI deep-purple, Public AI blue-grey,
  Stored brown, Group teal; user chips stay primary/blue). The bottom
  AI-provider dropdown is REMOVED — the rail drives selectedProvider;
  stored chats load via handleChatSelected; peers open PeerThreadView;
  each group's ＋ opens the Groups tab. Self-fetches memberships +
  messages + saved chats (15s); hidden for deep-link sessions; sits just
  right of the Workbook rail.
- **2026-07-16** — **Organizer-first welcome page** (adoption redesign;
  design in the local doc as Refinement 8). The welcome page now recruits
  GROUP ORGANIZERS: hero ("Health AI that answers to you" + volunteer/
  open-source identity), two accent doors (See a live group / Start a
  group), the explicit 4-step organizer journey, a demoted member row
  (Get your own MAIA — quick start; Have an invitation? — pre-auth
  paste-a-link capture; Learn more → trustee.substack.com + demo video
  link), a generic "How MAIA is different" comparison, and a "Groups
  hosted here" section. New public surface: groups gain an admin opt-in
  `publiclyListed` flag (default OFF — invite-only groups stay
  invisible); GET /api/groups/public returns name, description, posting
  policy, aggregate member count, and the join link only when
  link-approval is on — never a roster. The welcome video and the four
  numbered steps are removed from the page (video demoted to Learn more;
  the wizard teaches by doing). Next per Refinement 8: full public group
  page (W2) and outsider requests v1 with email verification (W3).
- **2026-07-16** — **Deploy template + featured peer registries**
  (Refinement 8 infrastructure). `.do/deploy.template.yaml` powers a
  Deploy-to-DigitalOcean button (README gains a "Set up a group" section:
  one-click app creation, the four env prompts, the CouchDB-droplet step
  App Platform can't automate, and the email-safe CNAME custom-domain
  recipe — never switch nameservers on a domain whose registrar handles
  email forwarding). New `FEATURED_GROUP_REGISTRIES` env: comma-separated
  peer MAIA deployments whose public groups this welcome page also
  features — fetched server-to-server (60 s cache, 3 s timeout, no CORS),
  labeled "hosted at <host>", listed before local groups. Join links are
  absolute with their own registry= param, so cross-host Ask-to-join
  rides the existing federation path. Verified with two local instances:
  port 3002 featuring port 3001 lists the peer's group first with
  originHost set. This is how maia.agropper.xyz will feature the
  standalone Trustee group at trustee.ai.
- **2026-07-18** — **Open join mode** (the last funnel gap: approval
  latency). `joinMode` gains 'open': anyone with the join link becomes a
  member INSTANTLY — the registry creates the entry born ACTIVE and the
  member's MAIA collects its credential in the same round trip
  (join-requests returns `immediate`; request-join then fetches the
  signed status inline and responds `joined:true` with the full
  membership — no pending state, no polling, no dead air; if the inline
  collection fails it falls back to the normal pending+poll path). The
  admin can still revoke members and rotate the link; approval mode and
  invite-only are unchanged. Admin dialog: the join toggle became a
  three-way select. Join cards and the welcome page's public group cards
  adapt their copy ("Join now" / "CREATE MY MAIA & JOIN <group>" / "no
  approval wait"); the public list exposes joinMode. Verified end to end
  locally: throwaway temp user → request-join against an open group →
  joined:true with complete membership in one request (test member
  revoked, demo group's mode restored). Intended use: the Trustee
  bootstrap group runs open; cautious groups keep approval.
- **2026-07-18** — **Group deletion** (needed before the Trustee rollout
  replaces the IBD demo). Admin: DELETE /api/groups/:groupId + a trash
  button per group with a type-the-name confirm stating the blast radius
  (N members lose access; credentials die within 24 h; undelivered
  messages discarded; recovery kit is the only way back; audited as
  group_deleted). Member side: a registry 404 on refresh now reads
  exactly like a revoked membership, so every member's MAIA drops the
  membership cleanly on its next refresh instead of erroring forever
  against a missing group. Verified live: create → delete → /info 404.
