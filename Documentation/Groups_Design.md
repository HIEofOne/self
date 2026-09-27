# Groups + Authorization Server — Design Baseline

**Date:** 2026-07-05 / 2026-07-06
**Status:** Baseline — verbatim record of the initial design conversation, kept for reference as the design is discussed and refined.
**Participants:** AG (Adrian Gropper), Claude (design assistant)
**Related docs:** `Wizard_Issues.md` (architecture lessons that inform this design)

> This file preserves the opening design conversation for the Groups /
> Authorization Server feature exactly as it happened. Later revisions of the
> design should be appended below the baseline (or split into a separate
> spec document) — do not rewrite the baseline itself.

---

## AG — initial feature request

We need to add a major new feature designed to encourage patient groups to promote MAIA adoption by their members.

* A group will be managed by the admin role who also controls group membership even if a patient's MAIA is hosted under a different admin domain.
* The primary incentive for belonging to a group is to connect and get insights from patients with prior experience with the disease or situation that matches the patient's situation.
* "Matching" within the group should not require creation and management of a "honeypot" database of group members private records and interests. The database defining the group should be only sufficient to control membership and to allow mediated, privacy-preserving notification and other communication with a group member.
* Each individual MAIA will operate an Authorization Server (AS) to process external requests for information. The requests may come from group members or unaffiliated requesting parties (RqP).
* The AS will either respond autonomously, notify the patient, or treat the request as spam. Requests to the AS may eventually be standardized around the Grant Negotiation and Authorization Protocol (GNAP - RFC 9635) but we can add standardization in a later phase.
* AS behavior will be deterministically controlled by policies that are published by the group administrator and further modified by the patient if they choose.
* The agentic behavior of the AS will be a combination of private AI and the deterministic resource access control based on the Cedar policy language. This is discussed in https://www.technometria.com/p/delegation-as-data-applying-cedar and later posts. We do not have to implement the specifics proposed by that post but I would prefer to build around Cedar rather than inventing a proprietary policy language.

Review relevant MAIA code and suggest the the design approaches we should discuss and refine.

*(Claude began fanning out codebase exploration — admin/user model, deep links, notification infrastructure — and AG interrupted with a course correction before results arrived.)*

---

## AG — course correction: deep links are not the foundation

I stopped you because we don't need to overload or build on the deep-links mechanism that we use to chat with physicians. We certainly can extend deep links but we also need to recognize that deep links are inherently designed for human chatting whereas the AS request processing could be entirely agent-to-agent.

---

## Claude — synthesis: deep links (human channel) vs. AS (machine surface)

Understood — that's an important boundary line, and it actually makes the architecture cleaner. Let me restate it to confirm the framing:

**Deep links** = human-facing channel. A person (physician, family member) clicks a URL in a browser, authenticates lightly, and chats. The unit of interaction is a conversation, and the design assumptions (browser session, email verification, UI gating via `isDeepLink`) all follow from that.

**The AS** = machine-facing surface. A structured, signed request arrives from another agent — a group member's MAIA, a group relay, or an unaffiliated RqP's software — with no browser, no session, no human necessarily present on either end at request time. The pipeline is: authenticate/attribute the request → Cedar policy evaluation → one of three outcomes (autonomous response / patient notification / spam). The unit of interaction is a *grant request*, not a chat.

Keeping the AS machine-native from day one has two concrete payoffs:

1. **GNAP alignment gets much easier later.** GNAP is precisely a JSON, key-bound, no-cookie protocol where a grant request can be decided autonomously or parked pending human interaction. If we build the AS around signed JSON requests with continuation semantics now — even with a proprietary shape — the later standardization phase is a mapping exercise, not a rewrite. Bolting onto deep links would bake in browser-session assumptions we'd have to unwind.

2. **The three-outcome dispatch stays pure.** Cedar evaluates every request the same way regardless of requester type; "notify the patient" is just one possible outcome, and the notification itself can carry whatever artifact makes sense — including, *optionally*, minting a deep link when the patient decides the right response is a human conversation. So deep links become one possible fulfillment a patient chooses, never the transport the AS depends on.

---

## AG

Good synthesis. Keep going.

---

## Claude — full design proposal

Grounding facts confirmed in the codebase: seven CouchDB databases already exist (including `maia_audit_log` — useful), admin is a single hardcoded username per deployment with `AdminUsers.vue` as its panel, Resend email works server-side (`server/index.js:8255`), and — importantly — the draft-PS path already proves a **server-side, no-browser AI inference call** per patient (`new DigitalOceanProvider(userDoc.agentApiKey, { baseURL: userDoc.agentEndpoint })`). That last one is exactly the "agentic" half of the AS.

# MAIA Groups + Authorization Server — Design Proposal

## 1. What we're building on

| Existing asset | Role in this feature |
|---|---|
| One Express deployment per admin domain, N patients each | The AS is naturally multi-tenant: one AS endpoint surface per deployment, routed per patient |
| `maia_users` doc per patient (meds, summaries, KB, agent profiles, passkeys) | The protected resources; the patient overlay policy store |
| Server-side agent inference (`DigitalOceanProvider` w/ per-user key+endpoint) | The AS's private-AI component — request summarization, spam scoring, local match evaluation |
| Resend email | Patient notification channel |
| `maia_audit_log` db | AS decision audit trail (every permit/deny/escalate) |
| Admin role + AdminUsers.vue | Extends to group management |
| Deep links | **Not** a foundation — one optional fulfillment artifact when a patient chooses a human conversation |

## 2. Three new components

1. **Group Registry** — hosted on the group admin's deployment. New `maia_groups` db. Holds *only*: group metadata, membership list (pseudonymous), published policy pack. No clinical data, no interests (initially — see §6).
2. **Per-patient Authorization Server** — new machine-native route surface (`/api/as/...`) on every deployment. Signed JSON in, three outcomes out: autonomous response / notify patient / spam-drop. Plus a patient-facing **Requests inbox** (new Workbook rail tab).
3. **Policy system** — Cedar (`@cedar-policy/cedar-wasm`, the official WASM build — no Rust toolchain, no proprietary language). Group-published policy packs + patient overlay. **Cedar decides; AI explains and assists — AI output never grants access.**

## 3. Identity & cross-domain membership

**Member identity = pairwise pseudonym per group.** When a patient accepts an invite, their MAIA generates a per-group keypair. The registry stores `{alias (patient-chosen), pairwiseId, publicKey, asEndpoint, status, joinedAt}`. Different groups see different pseudonyms for the same patient — no cross-group correlation by identifier.

**Membership as a signed data artifact.** The admin signs a membership credential `{groupId, pairwiseId, memberPublicKey, expiresAt}`. A member presents this when contacting another member's AS; the receiving AS verifies it **offline** against the group's published signing key — no live callback to the registry per request. Revocation = short credential lifetime + periodic refresh (plus registry removal). This is Windley's "delegation as data" applied to membership itself: authority travels as verifiable data, not as a live lookup against a central database.

**Cross-domain is inherent, not special-cased.** A membership record points at any AS endpoint on any deployment. The group admin controls *membership* (the list, the credential issuance, the policy pack); the admin never controls the member's AS — that's the patient's, hosted wherever their MAIA lives.

## 4. The AS request pipeline (machine-native, GNAP-shaped)

Single grant endpoint per patient: `POST /api/as/{asId}/requests` — where `asId` is an opaque identifier on the userDoc, *not* the userId (no user enumeration). Request envelope:

```json
{
  "requester": { "kind": "group-member", "credential": "<signed membership>", "key": "<pub>" },
  "action": "relay-message" | "match-probe" | "request-resource",
  "resource": "inbox" | "peer-match" | "patient-summary" | "...",
  "payload": { },
  "nonce": "...", "created": "..."
}
```

Signed with **HTTP Message Signatures (RFC 9421)** — that's GNAP's key-proofing mechanism, so adopting it now makes the later GNAP phase a mapping exercise (grant request ↔ our request; "pending patient" ↔ GNAP interaction; continuation tokens fit naturally), not a rewrite.

Pipeline: **verify signature/credential → classify principal (member of G / known RqP / unknown) → build Cedar request → evaluate → dispatch.**

The three-outcome dispatch maps onto Cedar's two-valued semantics with a double evaluation:

1. Evaluate the requested action. Explicit `permit` → **autonomous fulfillment**.
2. Otherwise evaluate `Action::"escalate-to-patient"` for the same principal/resource. `permit` → **park as pending, notify patient**.
3. Otherwise → **spam-drop** (silent). Default-deny is the floor.

Every decision writes to `maia_audit_log` with the policy IDs that determined it. Requests live in a new `maia_as_requests` db (statuses: `pending | auto-approved | patient-approved | denied | spam | expired`) — same pattern as `maia_chats`.

**Where AI fits (escalation path only):** when a request parks as pending, the patient's private AI summarizes it in plain language for the email + inbox card, scores spam likelihood, optionally drafts a response. On the *permit* path there is no AI — autonomous grants are purely deterministic. This keeps the trust story clean: the only ways data moves are an explicit Cedar permit or an explicit patient click.

## 5. Cedar policy architecture

**Entity model (v1, deliberately small):** principals `GroupMember`, `GroupAdmin`, `RequestingParty`, `Patient`; resources `Inbox`, `PeerMatch`, `PatientSummary`, `List::Medications`, …; actions `relay-message`, `match-probe`, `request-resource`, `escalate-to-patient`. The schema lives versioned in the repo — it's the shared vocabulary across deployments, so admin-published packs validate against member schemas.

**Two policy layers, one clear sovereignty rule:**

- **Group policy pack** — published by the admin at a well-known URL (`/api/groups/{groupId}/policy-pack`), signed and versioned. Members' MAIAs fetch and pin a version; on update the patient sees a diff and accepts (or has opted into auto-accept). Example:

```cedar
permit(
  principal in Group::"crohns-support",
  action == Action::"relay-message",
  resource == Inbox::"default"
);
permit(
  principal in Group::"crohns-support",
  action == Action::"escalate-to-patient",
  resource == PeerMatch::"default"
);
```

- **Patient overlay** — stored on the patient's own deployment. The patient is the ultimate authority over their AS: the group pack is an *adopted baseline*, and the patient can forbid anything in it (Cedar's forbid-overrides-permit gives us this for free) or grant beyond it for their own resources. The admin's authority is membership and defaults — never the member's data.

**Patient-facing policy UI:** template toggles first ("Group members may leave messages in my inbox: on/off", "Respond to peer-match searches: notify me / off"), with the generated Cedar visible read-only for transparency. Raw Cedar editing is a later power-user feature.

## 6. Matching without a honeypot

The registry stores membership, not medicine. Matching works by **query fan-out + local evaluation**:

1. A member (or their MAIA) submits a peer-match query to the group relay: "looking for members with experience with X."
2. The relay fans it to member inboxes. **Pull, not push, for group-relayed traffic**: each member's MAIA polls the relay's mailbox for its pairwiseId. The relay never needs members' AS endpoints for this, sees only delivery metadata, and it's NAT/firewall-friendly. (Direct AS endpoints remain for unaffiliated RqPs, which is unavoidable — being asked is the AS's purpose.)
3. Each member's AS gates the query with Cedar (is match-probe enabled?), then evaluates the match **locally** — private AI against the patient's own KB at query time. No stored "situation profile" anywhere.
4. **The critical privacy default: match → notify the patient; no-match → silence.** A match-probe must never be an autonomous yes/no oracle — an auto-"yes" leaks "I have condition X" to anyone who can phrase a query. Non-response is indistinguishable from non-match, off-policy, or absence. The requester learns nothing until a matched patient *chooses* to respond.
5. Responses flow back through the relay pseudonymously. Identity or a direct channel (which could be a deep-link chat, if the patient wants a human conversation) is revealed only on **double consent** — a mediated introduction.

Opt-in coarse topic tags in the registry (option 2) are a possible later optimization for routing, but they're a mini-honeypot of interests; hold them out of scope until the fan-out model proves too noisy.

## 7. Spam posture for unaffiliated RqPs

Requests must be key-signed even from unknowns. Defaults: unknown principal + no policy → silent drop. A deployment- or group-level pack can raise specific classes out of spam (e.g., RqPs bearing a verified-email proof, or vouched by a group admin) into the escalate path. Rate limits per key and per source. The patient can flip "accept unaffiliated requests: notify me" in their overlay.

## 8. Phasing

| Phase | Delivers | Notes |
|---|---|---|
| **1 — Groups & membership** | `maia_groups`, admin UI, email invites (Resend), join flow w/ pairwise keys + signed credentials, member directory, Requests inbox tab + email notify. *Every* request escalates to the patient. | Peer value ships immediately via human-approved messaging; "escalate-everything" is trivially the v1 policy |
| **2 — Cedar AS** | `@cedar-policy/cedar-wasm`, group packs + patient overlay (toggle UI), autonomous permits for `relay-message`, RFC 9421 signatures, audit-log wiring | First autonomous behavior, smallest blast radius |
| **3 — Matching** | Relay fan-out (pull inboxes), local private-AI match evaluation, match→notify / no-match→silence, double-consent introductions | The headline incentive |
| **4 — Hardening & standards** | GNAP profiling, key rotation, cross-deployment trust policy, optional coarse tags | Standardization as mapping, not rewrite |

## 9. Open questions to refine together

1. **Registry placement** — on the group admin's deployment (recommendation: it reuses everything) vs. a standalone group service? Can one deployment host many groups (lean yes)?
2. **Alias culture** — support groups often want chosen names and real warmth, not opaque pseudonyms. Patient-chosen alias per group, with the pairwise crypto identity underneath?
3. **Relay retention** — store-and-forward mailboxes hold messages until polled; what's the retention/deletion policy so the relay doesn't become a message honeypot?
4. **Revocation latency** — how short do membership credentials live (hours? a day?) before refresh; is that good enough vs. a live check for sensitive actions?
5. **First-contact friction** — should even `relay-message` from a group member escalate on *first* contact per sender, going autonomous only after the patient accepts once (a "handshake" pattern)?
6. **Autonomous resource ceiling** — is anything clinical *ever* autonomously releasable, or is the permanent posture "autonomy for communication, humans for records"? Lean toward the latter as a standing principle.
7. **Match-query expressiveness** — free text evaluated by private AI is flexible but fuzzy; a small controlled vocabulary is predictable but limiting. Start free-text-with-AI and observe?
8. **Cedar schema governance** — the entity/action vocabulary is a cross-deployment contract. Version it in this repo and require pack validation at publish time?

Suggested starting point for discussion: **§3 (membership-as-credential), §4's three-outcome dispatch, and §6's match-silence default** — those three carry most of the privacy architecture, and everything else adjusts around them.

---

*End of baseline. Design refinements follow below or in a successor spec document.*

---

# Refinement 1 — Adoption Strategy & Network Effects (2026-07-06)

## AG — strategy challenge

Given your understanding of the MAIA app and the success of the AI paper about the physician perspective on MAIA (the NEJM AI Perspective, "The Medical AI Assistant as Publication, Not Device," Gropper, June 2026), I want your insights into how the Group feature will compete with alternatives for getting patients to adopt MAIA.

I want you to consider alternatives to MAIA with groups and the design of the groups feature in a way that will promote a "network effect" to drive its adoption.

---

## Claude — strategic analysis

### The core strategic insight: the privacy constraint *is* the moat

The no-honeypot requirement looks like a self-imposed handicap. It's the opposite — it's the one thing in the design that no incumbent can copy.

Peer matching requires evaluating "does this patient's situation match that query?" Every existing player can only do that evaluation **centrally**, against data they hold. PatientsLikeMe holds the records and sells the derivative data — that's the business model, not a bug they can patch. Epic could match within a health system but will never match across institutions it doesn't control, and its customers (health systems) have zero incentive to connect their patients to other systems' patients. Meta has the people and none of the trust. OpenAI could bolt matching onto ChatGPT memory tomorrow — technically trivially, reputationally radioactively, because the only way a centralized actor can match is to *be* the honeypot.

Honeypot-free matching is only possible when every patient has their own agent, their own record store, and their own policy engine — local evaluation, silence on no-match, consent before contact. That is the MAIA architecture. **The Groups feature isn't a feature MAIA adds; it's a feature only MAIA-shaped systems can have.** Everything else in this analysis follows from that.

### The competitive field, honestly

| Alternative | What it genuinely offers | The structural limit Groups exploits |
|---|---|---|
| ChatGPT / consumer AI | Instant, free, zero-setup AI over pasted records — **the real competitor for the solo patient** | Centralized custody; no provenance to the record; no peers without becoming the honeypot |
| Epic / MyChart AI | Default channel, institutional trust, zero setup | Siloed per system; institution-controlled; cross-institution peer connection is against its customers' interests |
| PatientsLikeMe, MyHealthTeams, registries | Proved patients *will* share deeply to find peers | They monetize the honeypot; sponsor orgs carry breach liability; trust erodes structurally |
| Facebook / Reddit condition groups | Reach, emotional support, existing communities | Zero privacy, zero clinical substance, pharma infiltration, algorithmic feeds |
| Apple Health (+ inevitable AI layer) | On-device aggregation, closest philosophical neighbor | No peer layer, and liability means there never will be; no physician-facing artifact |

Two honest admissions this table forces. First, for a **solo** patient, ChatGPT is close to good enough and infinitely easier — MAIA's solo differentiators (custody, citations, verified summary) appeal to a niche. The Group is precisely the move that changes the comparison class. Second, Facebook groups already have the people. The right posture is **complement, not compete**: a foundation keeps its Facebook group for the feed and adopts a MAIA group as its *private layer* — the place where records, matching, and AI live. Don't build a social feed. Ever. The feed road leads back to the honeypot, and chasing DAU is how you end up there.

### What kind of network effect this actually is

**Local and clustered, not global.** The value of joining is the density of *your* group — 25 engaged Crohn's patients is a complete product; 10,000 scattered users across 500 conditions is nothing. This is the early-Facebook per-campus structure, and it's the favorable kind for cold-start: you never need "scale," you need one dense group at a time.

**Single-player first.** MAIA already delivers standalone value — organized records, cited answers, the verified Patient Summary. That's the classic *come for the tool, stay for the network* pattern, and it means a group with zero matches yet isn't dead; every member still has a working product. The engineering matters here more than it looks: **match quality is a function of record quality**, so the wizard, the meds verification, the KB — the "boring" single-player substrate — is literally what makes the network layer good. Better records → better matches → more value → more members.

**A matching market, which means liquidity is the risk.** Match-probe with silence-on-no-match (correct for privacy) makes early sparseness invisible — a requester can't distinguish "no peers exist" from "nobody's answering." Sparse markets with silent failure die quietly.

### The two flywheels, and where they meet

The NEJM AI Perspective solves the **physician-side legitimacy problem**: adoption of a published methodology is practicing medicine, not operating a device. Groups solve the **patient-side acquisition problem**. They meet in the exam room, and the paper itself names the mechanism — "a patient may provide and fund a MAIA for their physician, analogous to arriving with organized records."

- **Patient→physician loop:** every appointment where a patient opens a verified, citation-linked Patient Summary is a physician demo, and the paper is the professional cover that converts the demo into "you should suggest this to your other complex patients" (the paper's model B). Groups amplify this because members trade scripts: *here's how I used my summary at my GI appointment.*
- **Physician→patient loop:** "join the [Foundation] group" is a far easier physician suggestion than "self-host an AI."
- **The paper's three provision models are three group archetypes:** foundation-run patient groups (patient-provided), practice-affiliated cohorts (physician-suggested), and clinician-operated deployments (physician-operated). The same Groups machinery serves all three — only who holds the admin role changes. The practice-run archetype is a sleeper: it has a motivated, *paying* admin and built-in physician endorsement.

### Design implications — changes/additions to the baseline

1. **Make "join the group" and "get a MAIA" the same act.** The single biggest friction-killer. The group admin's deployment is already multi-tenant per domain — admin-hosted member MAIAs mean an invite email ends with a working MAIA, not a self-hosting tutorial. Backup/restore already gives credible exit (migrate to your own domain later), and credible exit is itself an adoption lever: joining is safe because leaving is real.
2. **The sponsor org's lawyer is a primary buyer persona.** "We hold membership, never PHI" is not just patient privacy — it's near-zero breach liability for the foundation, which is the difference between their counsel approving a community platform and killing it. Sell the no-honeypot design *to the org* as much as to the patient.
3. **Engineer the mentor/veteran role explicitly.** Matching markets need a supply side. Founding members opt into looser discoverability (a "mentor" policy pack — match-probes escalate to them more readily), group-visible aliases, maybe recognition within the group. This is what makes a 20-person group feel liquid on day one.
4. **Aggregate liquidity signals, individual silence.** "34 members have peer-match enabled" tells a requester the market exists without disclosing anyone. Silence stays ambiguous at the individual level, exactly as designed.
5. **The group library: publish-as-a-patient.** MAIA's privacy filter (name→pseudonym) already exists; add a patient act of *deliberately publishing* a privacy-filtered artifact to the group — a journey summary, a "10 questions to ask your MAIA before your appointment" template, a policy pack. This is the content network effect, and it's honeypot-free because publication is an explicit, filtered, per-artifact patient choice. It's also the resonant move: **the group library is to patients what the peer-reviewed paper is to physicians** — the publication model, extended to the other side of the exam table.
6. **A "for your physician" packet.** One click: verified summary + provenance description + the NEJM AI citation. Arm the patient for the exam-room demo; that's the flywheel junction, so instrument it.
7. **Sequence by community, not by condition prevalence.** Launch criteria: organized existing community with a motivated admin, high peer-knowledge value (rare disease umbrellas, transplant, new-diagnosis ALS/long-COVID, IBD), records complex enough that single-player value carries the wait for density. Two or three dense groups beat any breadth play.
8. **Measure match-success and time-to-first-peer, not engagement.** Episodic use is the honest shape of this product. The moment you chase daily engagement you will be pulled toward feeds, notifications, and eventually the honeypot.
9. **The federation protocol is the endgame moat.** Because groups are protocol-federated (GNAP-aligned later), nobody — including the project — owns the network. A well-funded copycat with a central database can't interoperate; a copycat without one is just another node implementing the standard. That's the same open-methodology logic as the paper, applied to the network layer: *the network is a publication, not a platform.*

One boundary note that ties Groups back to the paper's own method-to-device line: AS autonomy must stay confined to **access control and communication mediation** — never autonomous clinical synthesis delivered to another party. Peer exchanges are human-to-human; the match evaluation is the patient's own agent acting privately for its patient, gated by consent. That keeps the entire Group layer on the publication side of the boundary the paper draws.

**Phase 1 scope impact:** items 1, 3, 4, and 6 above belong in Phase 1, not later phases.

---

# Refinement 2 — The Digital Twin Horizon (2026-07-06)

## AG — future state challenge

Before we start, I want you to consider one other future state beyond the groups and federation of groups. I want your insights on MAIA becoming the platform for digital twins of patients. I understand that introducing autonomy in the clinical interaction with a digital twin will tend to violate the guideline-device boundary but at some point, AI and Private AI will be good enough to introduce useful digital twins for some patients in some groups.

---

## Claude — analysis

### Two different things hide inside "digital twin" — separate them first

**The twin as representative.** An agent that speaks *from* the patient's documented record — answers permitted questions, mediates contact, represents the patient's interests when the human is asleep, busy, or overwhelmed. This is retrieval: everything it says is verifiable against source documents.

**The twin as simulator.** A model that predicts *this patient's* trajectory — "what happens to me on drug X vs. drug Y?" This is generation of new clinical claims that cannot be verified against any source document, only against a published model and its validation evidence.

The critical realization: **the Groups design already contains the first twin.** The AS answering a match-probe by evaluating the patient's KB locally *is* a twin-as-representative answering a one-bit question. The Requests inbox is the twin's front door; Cedar is its conscience; the audit log is its memory of conduct. So the strategic question is not "should MAIA add digital twins" — it's "how far up the autonomy ladder does the agent MAIA already has get to climb, and what makes each rung legitimate?"

### Re-reading the boundary: what the paper actually forbids

The NEJM AI Perspective draws the device line at two things: **autonomy over clinically consequential outputs** and **non-republishability** (vendor drift, in-deployment learning). Notice what it does *not* forbid: evolving inputs. "What does change in a deployed MAIA is the input — the patient's record grows."

That sentence is the twin's charter. A twin whose **model is pinned and published** but whose **state is the patient's evolving record** is exactly "same method, new inputs" — the thing the paper explicitly blesses. This gives us the architectural rule that keeps twins republishable:

> **Personalization lives in state, never in weights.** The twin never fine-tunes on its patient. It gets better by its record getting better — which MAIA's whole single-player substrate (the wizard, verified meds, the verified Patient Summary) already optimizes.

The boundary is therefore crossed not by the twin *existing*, *updating*, or even *predicting* — but by the twin **acting** on clinical matters without professional review, or **learning** in ways that break the published-methodology frame.

### The autonomy ladder, with the boundary located precisely

1. **Memoir twin** (retrieval; safe side). Answers questions from documented lived experience with citations: "what was the first year on biologics like for patients like me?" answered by a consenting veteran's MAIA from their actual record. This is RAG — the same epistemic act as today's Patient Summary, pointed outward through the AS. It upgrades the mentor role enormously: mentorship becomes available at 2 a.m., in any language, without burning out the mentor. Requires one hard rule: **machine attribution, always** — a twin's answer is labeled as coming from the member's MAIA, never impersonating the human.
2. **Oracle twin** (simulation; boundary-adjacent). Runs published, pinned predictive models over the patient's state and presents predictions *to humans* — patient and physician — with **prediction provenance**: model hash, validation citation, input snapshot, uncertainty interval. This is CDS in Cures Act terms, and it stays on the methodology side exactly as long as the physician mediates consequential use and the basis is independently reviewable. Note the provenance standard changes meaning here: from "where in the record" to "which published method, validated on whom."
3. **Acting twin** (autonomy; the paper's device side). Communicates clinically with patients or third parties, initiates actions. The paper is unambiguous that unreviewed clinical autonomy is device territory — and the answer is not to argue with that line. The answer is medicine's own precedent:

### Standing orders for twins — the profession-preserving path to autonomy

Medicine already licenses bounded autonomy to non-physicians constantly: standing orders, nurse protocols, pharmacist prescribing under collaborative agreements. The physician doesn't review each act; the physician **publishes, signs, and owns the protocol** that authorizes a bounded class of acts, revocably.

Cedar policy packs are the digital-native version of exactly that instrument. A **physician-signed policy pack** — versioned, published, revocable, audit-logged — that delegates a bounded set of twin actions ("may flag lab trends to the patient as questions-for-your-doctor"; "may complete pre-visit intake from the record") is *delegation-as-data meeting the standing-order tradition*. The practice-affiliated group archetype (the paper's physician-operated provision model) is the natural container: the group's supervising physician publishes the pack; members' twins operate under it; every action lands in `maia_audit_log`.

This resolves the boundary problem the way the paper resolves the regulatory one — **by keeping the profession in charge of its tools**. And it answers the paper's "agentic loops whose intermediate steps the physician cannot inspect" concern by construction: a Cedar-gated, audit-logged twin is the *inspectable* agentic loop. Autonomy without opacity. When some future rung genuinely requires device clearance, the pinned-and-published architecture maps cleanly onto FDA's predetermined change control plans — the device path becomes tractable rather than fatal, and it arrives *late*, after the methodology layers have built the evidence.

### Groups are the twin platform's missing half

A simulator twin is only as credible as its validation, and validation needs cohorts. Everyone else building patient twins (Unlearn.ai's trial twins, mechanistic cardiac twins, pharma in-silico programs) solves this by **bringing data to the model** — the honeypot again. MAIA inverts it: **published models come to the data.**

- **Federated validation**: a candidate twin model for, say, IBD is published (pinned, open); each consenting member's MAIA back-tests it against its own longitudinal record locally; only aggregate fidelity metrics leave, consent-gated through the AS, k-thresholded at the relay. The group *is* the validation cohort — with no registry existing anywhere. The group library publishes the results. This is the paper's republishability standard operating at population scale without centralization.
- **Research as the third side of the market.** The AS design already anticipates unaffiliated RqPs — a researcher is just an RqP whose requests are *computation classes* rather than contact requests. Federated cohort queries — consent-per-query, paid or donated, aggregates only — let foundations fund themselves by mediating **answers, never data**. That's the honeypot-free replacement for the PatientsLikeMe business model, and it hands sponsor organizations a sustainable economics story that today does not exist anywhere in the market.
- The network-effect analysis compounds: better records → better twins → better matches *and* research value → more members → denser validation cohorts → better twins. The flywheel gains a third blade.

### Honest risks

- **Fidelity theater.** LLM-flavored "twins" will be oversold industry-wide. MAIA's defense is the publication gate: no twin model runs in a group until published and federatedly validated *for that condition*. Groups should treat unvalidated twin models the way journals treat unreviewed manuscripts.
- **Impersonation and grief.** Twin-labeled responses are non-negotiable. And communities *will* eventually ask about legacy twins of deceased members — that's a group-governance policy question to anticipate deliberately, not a technology accident to stumble into.
- **Equity.** Twins are only as good as records; data-poor patients get poor twins. Human matching must never be crowded out by twin-mediated matching.
- **Scope creep toward the feed.** An acting twin that nudges daily is an engagement product wearing a lab coat. The standing-order instrument is also the *brake*: no pack, no action.

### What this changes in what we build now — five reserved shapes

Almost nothing gets built earlier — but five small shapes should be reserved so the twin can emerge without re-architecture. These amend the baseline's Cedar (§5) and AS (§4) sections:

1. **Name the action ladder in the Cedar schema now**: `answer-from-record` < `compute-aggregate` < `run-simulation` < `act-under-protocol`. Phase 1 implements only the bottom rung, but the vocabulary is the contract.
2. **Reserve a computation-class field** in the AS request envelope so a match-probe and a future simulation share one pipeline and one audit trail.
3. **Machine-attribution rule from day one**: any AI-generated AS response carries "answered by [alias]'s MAIA from documented records."
4. **Policy pack metadata carries issuer role** (`group-admin` vs `supervising-physician`) — the empty slot where standing orders will live.
5. **State-not-weights as a standing architectural principle** — the one-line rule that keeps every future twin on the publication side as long as possible.

The through-line, one sentence: **Groups build the rails — identity, policy, mediation, federation — and the digital twin is not a new vehicle but the same agent gradually earning the right to carry heavier cargo, one published, physician-signed, audit-logged rung at a time.**

---

# Refinement 3 — Payments (2026-07-06)

## AG — payments challenge

Before I test and we continue, investigate and suggest the best way to introduce payment into the group app.

* Our pivot to group focus is an opportunity to charge users for their share of hosting and for metered AI use
* The group could also manage low-friction micropayments as part of requests

Given the security and privacy design, what are the options for future support for payment?

---

## Claude — analysis

Grounding (from the codebase): the admin panel already tracks the DO account's month-to-date spend with per-day deltas (an `admin_usage_list` doc, attributing deltas to deleted users) — but there is no per-user metering anywhere. Every AI call already routes through the server using a per-user agent + per-user API key, so per-member attribution is structurally trivial to add.

### The core tension, stated plainly

Payment rails are the most identity-rich systems on earth — cards carry legal names, PSPs do KYC, ledgers persist forever. The group protocol is deliberately pseudonymous: pairwise IDs, registry minimalism, counter-only relay accounting. **If payment data ever touches the group protocol layer, it becomes the correlation vector that deanonymizes everything.** A registry that maps `pairwiseId → Stripe customer` is a honeypot with extra steps.

One principle dissolves most of the problem:

> **Payment identity attaches to the *hosting* relationship (userId ↔ host), never to the *group* relationship (pairwiseId ↔ registry/members).**

The host already knows the member's real identity — it hosts their records, their email, their passkeys. Nothing new is disclosed by the member paying their host. The registry, the relay, and other members never need to see a payment instrument. Keep the money boundary congruent with the existing trust boundary and the privacy design survives payments intact.

### The three revenue objects

| Object | Cost shape | Natural payer |
|---|---|---|
| **Hosting share** (agents, KB/OpenSearch, Spaces, droplet share) | ~flat per member-month | Member *or* group |
| **Metered AI use** (inference + indexing tokens) | variable, per-use | Member, or pooled by group |
| **Request micropayments** (AS requests: match-probes, mentor consults, RqP/research queries) | per-event, tiny | **Requester** |

### Option analysis

**1. Hosting share.**
(a) **Group-pays, seat-based — recommended default for the group archetype.** The host invoices the group (one Stripe B2B subscription, priced per active member count — which the registry already knows as a bare number). Members settle with their foundation through dues rails that already exist entirely outside MAIA. Privacy impact: zero. It's also the right sales motion: seat licensing is what a foundation's treasurer and lawyer already understand, and scholarship/sponsorship variance stays inside the community where it belongs.
(b) **Member-pays-host** — Stripe checkout against `userId` at the member's own deployment. Right for the self-hosted and practice archetypes and for cross-domain members (each host bills its own users; roaming needs no protocol support at all). Fine privacy-wise *because* it's at the hosting edge. Both can coexist; the archetype picks the default.

**2. Metered AI use.** The substrate is missing and cheap to build: a **per-user usage ledger** — the server logs tokens in/out + model per call (it mediates every call already). That enables member-visible usage, admin cost attribution, and later metered billing. Notes: usage records are sensitive metadata (*when* a patient consults their AI) — they live on the patient's own deployment, visible to the patient, aggregated to a number for billing, details purged on a retention schedule. For group-paid deployments, prefer **pooled metering** (the group buys a token pool, dashboard shows burn) over per-member overage bills — simpler, more solidary, and avoids the perverse incentive of a sick patient rationing questions to their own medical record.

**3. Request micropayments.** Reject two options fast:
- **Custodial pairwise ledger at the relay** ("A paid B 50¢ on Tuesday") — reconstructs the interaction graph §6.3 refuses to store. Dead on arrival.
- **Direct PSP payment requester→member** — links a real-name payer to a real-name payee, atomizing pairwise pseudonymity. Dead at the protocol layer.

What survives:

(a) **Flat-rate request stamps with counter accounting — the recommendation.** Like postage: a requester buys stamps from *their own host* (identity-bearing PSP transaction at the correct boundary); attaching a stamp to an AS request is the request's cost. The relay accounts with **counters only** — stamps-spent per sender, stamps-earned per recipient — the same privacy class as the §6.3 rate-limit counters. No pairwise amounts persist anywhere. Cross-domain settlement is periodic host-to-host netting of counter totals (airline-interline style), never per-message. One mechanism serves three purposes: **spam economics** (no stamp, no escalation — spam dies of poverty rather than moderation), **mentor compensation** (the liquidity supply side accrues stamp income for attention actually given), and **research revenue** ("sell answers, never data" gets its meter).

(b) **Price is policy.** The AS envelope already reserves a `computationClass` field and carries credentials — a **payment proof is just another credential in the envelope**, and **price is just another Cedar context attribute**: `permit(action == match-probe) when { context.stampValue >= resource.price }`. The group pack sets default prices; the patient overlay overrides for their own attention (a mentor sets it low or zero; a bombarded member raises it). An unpaid request gets an HTTP **402 Payment Required** challenge — not a new pipeline outcome, just a parameterized deny — and 402-challenge patterns (L402) already exist on a standards track that fits the GNAP trajectory.

(c) **Bearer/blinded tokens (Chaumian ecash, L402/Lightning) — the standards-track endgame.** Cryptographically unlinkable payment: the issuer can't correlate purchase with spend — the only option that makes even the counters unnecessary, and the philosophical match for the architecture. But running a mint has real operational and regulatory weight; Phase 4+ material, kept open by designing the envelope's payment slot as proof-format-agnostic now.

### The regulatory guardrail

The moment the group holds member money that can be **cashed out**, someone will argue it's money transmission. The clean posture until that's wanted properly: **credits are denominated in service, not currency** — stamps are bought with real money but redeemed only against fees (hosting offsets, AI usage, request costs), never withdrawn as cash. Mentor "income" is fee offsets or donated onward (mentors sponsoring newly-diagnosed members' stamps is a lovely community mechanic that counters support trivially). Cash-out arrives, if ever, with the mint phase and actual counsel.

### Privacy invariants to pin

1. Payment identity binds to **userId ↔ host**, never to pairwiseId; no payment data in the registry, relay, or any AS message.
2. **No pairwise amounts persist in the middle** — counter/aggregate accounting only, same class as rate-limit counters.
3. **Price is Cedar context; payment proof is an envelope credential** — no new architecture, and patient sovereignty extends to pricing their own attention.
4. **Credits redeem in service, never cash** — until a deliberate, counseled mint phase.
5. Cross-domain money moves **host-to-host by netting**, never member-to-member across the federation seam.

### Sequencing

| Phase | Ships |
|---|---|
| **P0** (rides Phase 1–2) | Per-user usage ledger + per-member cost view in the admin panel; reserve a `payment` slot in the AS envelope + `price`/`stampValue` in the Cedar context vocabulary |
| **P1** | Seat-based group billing (Stripe B2B at the host) + member-pays checkout for solo/practice archetypes |
| **P2** | Metered AI: pooled group token budget with burn dashboard (or per-member overage where chosen) |
| **P3** | Request stamps: purchase at own host, counter accounting at relay, 402 challenge, Cedar-priced requests, mentor accrual + sponsorship |
| **P4** | Blinded bearer tokens / L402, host-to-host netting at federation scale |

The one thing to do **immediately** (before PR-3 freezes envelope shapes): add the payment slot to the reserved shapes, so stamps arrive later without re-architecture — same trick as `computationClass`.

---

# Refinement 4 — Chat + Private AI as the adoption floor (2026-07-09)

## AG — adoption challenge

We're looking to leverage the Groups feature to drive adoption by patient groups and create a network effect. Right now, we assume each new user has a MAIA, private health records in a KB, and the wizard has completed to create a patient summary. That's a high bar for adoption effort, particularly because getting records any way other than from Apple Health takes days. What if someone just wants to join a MAIA group hosted by their admin in order to chat privately with another group member? How can we make that experience seamless without compromising any of the key aspects of Groups_Design.md?

## AG — refinement

Before we do both suggestions, let's refine the plan to allow for some Private AI benefit while chatting peer-to-peer even in the absence of a KB. Secure group chat by itself can be had by running Signal. What would be better is chats where a user can upload a document to add to the context and use AI and privacy filtering to interact. Deploying the Private AIs adds less than a minute to the setup time and has no prerequisites.

**Decision:** drop a pure chat-only tier entirely — the option would just confuse novice users. Ship two tiers.

## Claude — analysis

### The reframe: chatting needs nothing from the AI stack; the bar is the wizard

Grounded in the built code: `POST /api/user-groups/join` requires only a userDoc (no agent, no KB, no patient summary); E2E messaging (PR-3) is pure crypto over the membership keypairs; a lightweight `isTemporary` account path already exists. The adoption bar is not the Groups feature — it is the **wizard**, which forces agent-deploy + KB-index + patient-summary in front of everything, and records take days to obtain.

The chat route already carries **inline context** in the message (the KB is *additional* retrieval, not a prerequisite — the code already contemplates an agent-deployed-without-KB state), `POST /api/files/parse-pdf` turns a document into text without touching the KB, and the privacy filter operates on arbitrary text. The pieces exist.

### Two tiers (pure chat-only dropped)

1. **Chat + Private AI (no KB)** — the adoption floor. Deploy the agent(s) (<1 min, no prerequisites); skip KB create/index/summary. The differentiator over Signal: drop a document into a conversation and your Private AI reads it (explains a lab result, summarizes a discharge note, drafts a peer reply), with privacy filtering so you can share the insight without leaking PII.
2. **Full MAIA** — adds the KB, patient summary, and peer *matching*. The destination.

Pure chat-only (encrypted transport with no AI) is not offered: it is just Signal, and a third tier confuses novices.

### Transient documents — "bring your own context," not a KB

The record-free substitute for RAG, using the existing inline-context path:

1. Upload a doc → `parse-pdf` → text.
2. Prepend that text to the AI request as context **for this conversation only**.
3. **Never indexed, never centralized** — it lives in the user's local storage (File System Access API) or is discarded; no OpenSearch, no shared store. One clinical document fits the context window.

Strictly better than a KB for the "I just got a result and have a question" moment: zero setup, immediate — and the same document later seeds the KB on upgrade.

### Privacy filtering makes sharing safe

The existing name→pseudonym filter, at two points:
- **Before sharing** with a peer over the relay: any AI output or doc-derived text is pseudonymized (mandatory).
- **Optionally before the doc reaches the AI**: defense-in-depth, since inference runs on DO (consistent with how the full KB model already sends records to DO inference).

The boundary stays clean and matches the AS design: the Private AI is the user's **private assistant** (understand the doc, draft a message) — never a participant in the E2E peer channel. Sharing with the peer remains an explicit, privacy-filtered human action. "AI assists, never grants," extended to peer chat.

### Preserves every key aspect of the design

- **No honeypot** — transient docs aren't indexed or stored centrally; no KB, no shared record store. Strengthened.
- **Match-silence (§6.6)** — a KB-less member returns silence to match-probes (no records to match); graceful, no special case.
- **AI-assists-never-grants, pairwise keys, E2E, registry minimalism** — unchanged.
- Same privacy-filter primitive already trusted for physician deep-link sharing, now pointed at peer sharing.

### The flywheel / network effect

Come for the private chat → stay and add records for AI-over-your-history + to be findable by peers. Low-friction chat+AI pulls members in; the visible, one-tap "add your records" upgrade converts some; matching gets liquid; more join. A chat+AI seat costs the admin almost nothing (agent inference only, no KB storage), so cheap seats subsidize group growth under seat-based billing (§6.8). The upgrade must be enticing and non-nagging, reusing the existing wizard verbatim with membership + agent surviving the upgrade.

### What to build

1. **Wizard "Quick start" mode** — deploy agent(s), then stop (skip KB create/index/draft-summary). "Add your health records" is the upgrade to full RAG + matching; agent + membership persist across it.
2. **Transient context attach in chat** — an "add a document to this chat" action that parses to text and stuffs it into the AI context with **no KB write** (distinct from the existing KB upload).
3. **Wire the privacy filter** into the peer-share path (mandatory) and the context-doc→AI path (optional toggle).
4. **Upgrade CTA** chat+AI → full MAIA.
5. Pairs with **PR-5 (directory)** so a member can reach a specific peer.

Happy path: click invite → quick-start (agent, ~1 min) → land in the group → drop a lab PDF into a chat with a peer → "ask my AI what this means" → plain-language explanation → send the peer a privacy-filtered takeaway. No records, no indexing, no days-long wait — and a reason to come back and add records later.

### Implementation sequencing (proposed)

- **PR-5** — directory & liquidity (member discovery + first-contact compose), completing Phase-1 peer reachability.
- **PR-6** — quick-start (agent-only) onboarding tier + `workflowStage: 'chat-only'`/'lite' account state + Workbook that opens on Groups and offers the upgrade.
- **PR-7** — transient context documents + privacy-filter wiring for chat+AI.

(Buildable phasing to be mirrored into the public `Groups.md` when implementation starts.)

# Refinement 5 — Frictionless invitee onboarding (2026-07-10)

First local test of PR-6 (quick start) surfaced onboarding friction: the
wizard is daunting, "pick a clean folder" assumes users know the picker's
New Folder button, completion didn't land on Groups, and an empty Groups
pane leaves a naive user with no next action.

**AG decisions:** defer the folder choice until first needed; use the
MAIA userId as the default group alias (editable); then ship 6.5.

**PR-6.5 (shipped):** folder-less quick start (agents only, zero
decisions); invite-aware welcome (GET STARTED → "JOIN <group>", quick
start auto-selected); alias prefilled with userId; Groups landing race
fixed (wizard-resume suppressed at quick-start completion).

**Adoption scenarios analyzed (build order):**
- **PR-8 — member-initiated invites + seeded first thread** (Alice invites
  Bob; invite carries Alice's pairwiseId; on join both are mutually
  accepted senders and Bob's first conversation is Alice — answers "then
  what?"). Admin policy toggle, auto-approve default. Covers the
  "switch from email/Signal" case (the old channel carries the link).
- **PR-9 — shareable join-request link** (admin forms a group, spreads one
  revocable URL/QR; joiners request, admin approves from a queue).
- **Personal circles** (auto-created one-person groups so anyone can
  invite anyone, Signal-style) — considered and DEFERRED: same
  architecture but dilutes the patient-group story.
- PR-7 (transient context docs + privacy filter) slots after the adoption
  PRs — it deepens the experience but doesn't remove onboarding friction.

Alias-correlation note: defaulting the alias to the userId permits
cross-group alias correlation if a user joins several groups unchanged;
pairwise IDs underneath stay uncorrelated. Accepted as a default-with-
edit for v1 (typical user is in one group).

## Refinement 5a — Agreed adoption sequence (2026-07-12)

AG confirmed the sequencing review; passkey nudge attached to PR-8.
- PR-8: member-initiated invites + seeded first thread + passkey nudge
  for quick-start users.
- PR-9: join-request link + QR + admin approval queue; join-mode enum is
  the Layer-2 admin policy (one PR, not two).
- PR-10: policy form v1 (posting policy displayed at join; admin-editable).
- TEST MILESTONE: full funnel on test deployment (admin deploys → policy
  form → QR → stranger requests → approved → quick start → mentor chat →
  member invites a friend).
- PR-11: existing-MAIA join (paste invite into own MAIA; two-deployment
  CORS/skew test). Federation is second-order adoption — after the loop.
- PR-7: transient docs + privacy filter (retention, not funnel).
- Phase 2: Cedar + agent-processed requests (envelope slots reserved).
Policy layers: 1 displayed (join = accept), 2 enforceable-today (join
mode at registry), 3 machine-executed (Cedar, Phase 2).

# Deployment Status & Component Map (updated 2026-07-13)

Everything below is MERGED to main (v1.5.23+) unless marked open.

| Design element | Shipped in | Components |
|---|---|---|
| Registry, invites, join, E2E relay, credentials | PR-1..5 (#141–#152) | server/routes/groups.js (registry + member endpoints, crypto helpers); DBs maia_groups / maia_relay / maia_as_requests |
| Signal-style Groups tab (rail + threads) | #156 | src/components/GroupsPanel.vue |
| Quick-start tier ('chat_ready', folder deferred) | #157, #158 | src/components/ChatInterface.vue (wizard fork, completion watcher, upgrade + passkey banners); POST /api/wizard/quick-start-complete (server/index.js) |
| Invite-aware welcome (JOIN <group> / REQUEST TO JOIN) | #158, #160 | src/App.vue (URL capture → localStorage maiaGroupInvite / maiaGroupJoin) |
| Blue-triangle alerts (Groups + wizard) | #154, #158 | src/components/MyStuffDialog.vue; GET /api/user-groups/alerts |
| Member invites + seeded first thread + memberInvitesAllowed | PR-8 #159 | groups.js mintInvite / member-invites / invitedBy; GroupsPanel "Invite someone"; AdminGroups toggle |
| Join link + QR + approval queue + joinMode | PR-9 #160 | groups.js join-requests/status/approve/rotate; AdminGroups QR (qrcode dep); GroupsPanel request card + poll-joins |
| Posting policy (Layer-1 displayed) | PR-10 #161 | groups.js postingPolicy on views; AdminGroups textarea; GroupsPanel cards + info pane |
| Existing-MAIA join (federation seam) | PR-11 #162 | GroupsPanel paste-link dialog; /api/user-groups/invite-info|join-info proxies |
| Transient docs + privacy filter (chat+AI floor) | DEFERRED — #163 merged then reverted (#164); branch claude/groups-transient-docs preserved; re-lands with Refinement 6 after policy/AS work | GroupsPanel attach → /api/files/parse-pdf → /api/chat/digitalocean; /api/user-groups/filter-text (mapping from userDoc.privacyFilter) |

Still open/deferred: full-funnel + two-deployment test campaigns; raise the
5 s Groups auto-poll before production; Cedar + agent-processed AS
requests (Phase 2, envelope slots reserved); payments (§6.8); member
self-opt-in as mentor; personal circles (deferred).

# Refinement 6 — Unifying the three chat surfaces (proposal, 2026-07-14)

Testing PR-7 surfaced UX confusion: which AI answered, no follow-up
affordance, unclear share path, three chat paradigms (Chatbot, Deep
Link, Messaging). Code review findings:
- One engine, three surfaces: all AI traffic already flows through
  POST /api/chat/:provider; Deep Link is ChatInterface in isDeepLink
  mode; only Groups embeds a separate one-shot Q&A card (PR-7).
- Three DIFFERENT document semantics: chatbot "+" uploads to Spaces;
  deep-link chats use the KB; messaging paperclip is client-side
  transient. Same gesture, three meanings.
- AI identity is self-reported by the model (hallucinated "GPT-4");
  the wizard's agent-profile labels are the real source of truth.
- The assist consults the FULL agent (KB attached): a group-context
  question answered with the patient's own name, age and sex — records-aware
  answers are surprising in a peer context; mandatory filter proved
  its worth.

PROPOSAL ("one chat, three doors"):
1. MAIA Chat is the only place AI conversations happen — one reusable
   component/object (provider chip, context chips, follow-ups, save).
2. Messaging hosts humans only. "Ask my AI" opens a real chat seeded
   with the transient doc (+ optional KB toggle, default OFF from a
   group context), banner "started from your conversation with X".
3. One share model from any chat: Share to → peer thread (mandatory
   privacy-filtered text) | deep link (professional) — shares are
   policy-governed AS actions regardless of rail (aligns with the
   upcoming messaging access policy work; Cedar governs shares later).
4. Identity chips on ALL responses — AI answers, deep-link users,
   messaging peers — sourced from app metadata (agent-profile label,
   deep-link identity, group alias). AG amendment (2026-07-14): do NOT
   suppress model self-identification. Ground the agent's system prompt
   with its true identity (agent name, model label, deployment) so that
   "What model are you?" travels the real inference path and returns a
   CORRECT answer — a live end-to-end wiring probe. Chip (metadata) and
   self-identification (live probe) must agree; disagreement is itself
   a diagnostic that the wrong agent/model is wired up.
5. Context transparency: chips showing exactly what the AI can see
   (document name, KB on/off, no conversation access).
Deferred pending messaging-access-policy work; no code changed.

# Refinement 7 — "Sharing Policies" Workbook tab UX (design, 2026-07-14)

Canonical form: the STRUCTURE (Requesting Party, Purpose, Scope, Filter,
Signature, Payment). NL and Cedar are PROJECTIONS of it — never three
independently edited artifacts (no sync ambiguity; the structure governs).
The Private AI ELICITS structure and EXPLAINS consequences; it does not
author free prose that then needs interpretation.

1. One policy = one card = one sentence. Mad-Libs template with tappable
   chips: "[Anyone in Test 1 Group] with [NPI-verified] identity may get
   [Patient Summary] for [Clinical] use, [privacy-filtered], if they
   [post a spam deposit]." Editing a chip edits the structure; structure
   compiles to Cedar. Card face = sentence; expand = chip form;
   "advanced" = read-only Cedar (export/copy; direct editing later).
2. Default mental model: "MAIA asks you about everything unless you've
   told it otherwise." Three outcomes map to the AS pipeline:
   permit → autonomous, no match → ASK ME (Phase-1 behavior = default),
   forbid → silent drop. Policies are remembered answers, not a config
   chore.
3. Policies are BORN FROM DECISIONS: when answering a real request in
   the inbox, offer "Always allow/deny requests like this?" → card
   pre-filled from the actual request. Blank-form authoring is the rare
   path (AI-guided interview for it).
4. Provenance stack: Group-suggested (badge per group, from the
   registry policy pack — group doc already reserves policyPackVersion),
   User overrides (pin/disable per group card), User-added. Precedence
   is Cedar's (forbid wins) but is TAUGHT by the simulator, not a manual.
5. "Try it" simulator: compose a hypothetical requester (party,
   signature, purpose, scope, payment) → ALLOW / ASK ME / DENY plus
   WHICH card decided. Every real AS-inbox item likewise shows
   "decided by: <card>". Examples teach; rules don't.
6. Payment chips in plain words: returnable spam deposit, notification
   deposit, AI-cost prepayment, sharing payment (§3.4/§6.8 slots).
7. Structured→Cedar mapping: principal = party+signature; action =
   request; resource = scope; context = purpose+payment; response
   decoration = privacy filter. Signature levels: Group Member (creds
   exist), Verified email, NPI registry, Doximity OAuth, unverified.

## Refinement 7a — the Private AI's five assist roles (2026-07-14)
1. Interview: free-text intent → disambiguating questions → filled
   chips; output is ALWAYS a structured draft the user confirms.
2. Grounded consequence explanation: reads the user's OWN KB to make
   scope concrete ("Not-sensitive would exclude your 2019 HIV test").
3. Inbox triage: plain-language summary + recommendation per incoming
   request (the reserved aiSummary field), citing near-matching cards.
4. Coverage/conflict analysis + simulator narration ("this forbid makes
   your new permit unreachable"; "Marketing has no card → Ask me").
5. NEVER in the enforcement path: Cedar decides deterministically; the
   AI proposes/explains/summarizes only. A hallucinating model cannot
   leak data — "AI assists, never grants" is preserved structurally.

# Refinement 8 — Organizer-first welcome page (approved 2026-07-16)

Adoption sequence is ADMIN-FIRST (AG): (1) someone finds a MAIA welcome
page and points a potential admin at it; (2) admin explores the demo
group and starts a group by developing policies; (3) admin + policy
developers get their own MAIAs and refine policies; (4) the group sends
its own invitations. Invitations are three steps downstream — the page
recruits organizers.

Page order: hero → two ACCENT doors ("See a live group" = demo group;
"Start a group") → journey strip 1-2-3-4 → demoted row (Get your own
MAIA / Have an invitation? / Learn more → trustee.substack.com) →
"How MAIA is different" comparison (generic, no competitor names) →
"Groups hosted here" public cards. Video demoted to Learn-more; the four
numbered steps removed (wizard teaches by doing).

Approved copy:
- H1: "Health AI that answers to you"
- Subhead: "Patient groups that help each other with each patient having
  a private AI — records stay with each patient, sharing rules are
  written by the group and can be modified by each patient. Free and
  open source, built by volunteer patient advocates. No company behind
  it."
- Get your own MAIA: "A private AI and a health record that stays yours.
  Ready in about a minute. Add and index your records as you get them."

Guest constraint stated as a feature: a visitor can see only what the
design allows anyone to see (name, posting policy, aggregate liquidity);
threads are E2E — "You can't browse members' conversations. That's the
point."

Build order: PR-W1 welcome restructure (+ minimal publiclyListed flag,
public groups list endpoint, Look-around expand, Ask-to-join via
link-approval joinLink); PR-W2 full public group page + mentors surface;
PR-W3 outsider requests v1 (email-verify → verified-email signature →
admin queue → admin relays; always labeled as from outside).
