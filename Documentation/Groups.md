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

1. Membership credential lifetime / refresh cadence (revocation latency)
2. First-contact handshake: does `relay-message` from a group member escalate
   on first contact per sender, going autonomous only after the patient
   accepts once?
3. Relay mailbox retention policy (store-and-forward duration and deletion)
4. Autonomous resource ceiling: standing posture is "autonomy for
   communication and access mediation; humans for clinical records" — confirm
   as a permanent principle or define an exception process
5. Match-query expressiveness: free text evaluated by private AI vs. a
   controlled vocabulary
6. Registry multi-tenancy: one deployment hosting many groups (lean yes)

## 7. Implementation Log

Entries are appended as work lands: date, version, branch/PR, what changed,
and any design decisions resolved.

- **2026-07-06** — Document created; feature branch `claude/group-feature`
  cut from main at v1.4.99. No implementation yet; design discussion in
  progress.
