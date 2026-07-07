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
