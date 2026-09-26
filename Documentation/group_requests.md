# Group Requests — a simplified "Personal AS" edition of MAIA

- **Date:** 2026-09-22. **Revised 2026-09-24:** one request path. In the edition, every request arrives over GNAP, including requests made from a web page (D12, §10.9–10.10).
- **Status:** Proposal, not built. Nothing in this document is implemented yet.
- **Base:** `HIEofOne/self` main at `8323936` (v1.5.175) when reviewed; both remotes are now at `f53580d` (v1.5.176, adds PR #309)
- **Scope:** HIEofOne/self only. `agropper/self` and maia.agropper.xyz stay as the demo (tag `demo-v1.5.176`).
- **Version line:** v1.6.0 starts the 1.6.x minor line for this work, as v1.5.1 did for Groups.
- **Companion docs:** `MAIA_Request_Security_Privacy_Design.md` (the security baseline and invariants I-1…I-23 this design extends), `Groups.md` (implementation log), `Setup_Sequence.md` / `New_User_Flows.md` (onboarding lessons), `Policy_Vocab_Changelog.md`.

---

## User-Centered Requests

*This section explains the goal in plain language. The rest of the document is the technical design.*

### What this version of MAIA is for

Other people and programs sometimes need your health information: a new doctor, a specialist, a researcher, an app, or another patient. Today they usually get it from a hospital or a company that holds your records, and you are rarely asked. It works the other way too. When a doctor writes a new report about you, it usually goes into their records, not yours.

This version of MAIA turns that around. **Your MAIA answers those requests for you, following rules you have approved.** It can also accept new documents for you, such as a radiology report, and save them in your own folder. Think of it as your personal assistant, standing at the door to your health information.

Getting started takes a few steps:

1. You join a group you trust, such as Trustee. The group suggests a few starter rules, for example "a doctor who has confirmed their email may see my current medications".
2. You confirm your email address and choose a folder on your computer. MAIA keeps your own copy of everything there.
3. MAIA helps you write a Patient Summary with your current medications, and saves it in your folder as a PDF.
4. You read each rule, try it out, and change it if you want, with help from a private AI that works only for you.
5. When you are happy with your rules, you turn sharing on. Nothing is shared before that.

MAIA can do much more, such as searching all your records or chatting with public AIs. Those features stay hidden until you ask for them or your private AI suggests one.

### How a request is handled

Every request comes in through **the same door**, and your MAIA handles it the same way every time:

1. **Who is asking?** MAIA checks what the requester can prove, for example that they confirmed their email address, or that they belong to your group.
2. **What do they want, and why?** For example: to see your current medications, for treatment. Or: to add a report to your records.
3. **What do your rules say?** MAIA then does one of three things:
   - **Shares** automatically, if one of your rules allows it. Only the privacy-filtered copy leaves: names and other details that identify you are replaced.
   - **Asks you**, if none of your rules decides. You get an email and decide in MAIA.
   - **Declines**, if one of your rules says no. Depending on the rule, the requester either hears "no" or hears nothing, exactly as if you had not answered yet.

   The requester is never told which of your rules decided.

**Your health information is never sent by email.** If the requester confirmed their email address, they get an email that says "your answer is ready". They collect the answer from a secure page. You get an email whenever something was shared or needs your decision, plus a weekly summary. A log of every request is saved in your folder.

### Three kinds of requests

**1. Someone outside the group asks you directly.**
For example, a new doctor needs your medication list before a visit. You give the doctor your personal MAIA request link, or show them a QR code. The doctor opens it, says who they are and what they need, and confirms their email address. If your rules allow it, MAIA shares right away. If not, MAIA asks you. If you say yes, the doctor gets an email and returns to the same page to collect the answer.

**2. Someone outside the group asks everyone in the group.**
For example, a researcher is looking for people who take a certain medicine. The researcher fills in the group's request page once. The group passes the request to every member's MAIA, but the group cannot read the answers. Each member's MAIA decides for its own patient, using that patient's rules. The researcher sees only how many members answered. They never learn who is in the group, and they receive information only from members whose rules, or personal choice, allowed it.

**3. A group member asks another member.**
For example, another patient in your group asks to see your medication list. Their MAIA sends the request through the group, marked "from a group member". Your rules can treat members differently from strangers, for example by sharing more with members, or by always asking you first.

In all three cases the request comes through the same door and is judged by the same rules. People use a simple web page, members use their own MAIA, and software uses the same programming interface directly.

### Adding a document to your MAIA

Sometimes someone wants to *give* you information instead of getting it. For example, after an MRI, the radiologist's office wants to send you the report.

They use the same request link as before, choose "Add a document", confirm their email address, and attach the file. After that they are done. Your rules decide what happens next, just as they do for requests to see your information:
- If your rules allow it, the report is accepted. You get an email, and the next time you open MAIA the report is saved in your folder, in a "Received" section, labeled with who sent it.
- If none of your rules decides, MAIA asks you. You can look at the report before you accept it. If you decline, it is deleted.
- If your rules say no, nothing is accepted.

Your existing rules about *seeing* your information never let anyone *add* a document. Adding needs its own rule. While a document waits for you, it is locked with a key that exists only in your folder, so not even the server running your MAIA can read it. A new document never changes your Patient Summary by itself. Your private AI may suggest updating the summary, and you decide.

### When the requester has a MAIA too

Your MAIA works for you in both directions. It answers requests that come to you, and it can also make requests for you. So the person asking you may have a MAIA of their own.

For example, suppose your new doctor belongs to a different group, such as a group of doctors, and uses MAIA too. Before your visit, her private AI notices she doesn't have your medication list and prepares a request. Her MAIA follows her rules about what it may ask for. In the first version, she approves each request with one click.

For your MAIA, nothing changes. A request from another MAIA comes through the same door as a request from a web page, and your rules decide. A few things work better, though:
- **She proves who she is once.** The first time, she confirms her email address with your MAIA. After that, your MAIA recognizes her MAIA until you tell it to forget her.
- **Her group can vouch for her.** Later, if her group checks that its members really are doctors, her MAIA will be able to prove that she belongs to it, and your rules can say which groups you trust.
- **She can hand over to a colleague, but only if you allow it.** Later, while she is on vacation, her MAIA will be able to pass your permission to the doctor covering for her. Your rules still decide before that colleague sees anything, and you see who looked.
- **Her MAIA waits patiently.** If your MAIA needs to ask you, hers keeps checking for as long as it takes, and tells her when you answer.
- **What she receives is protected too.** Your summary is saved in her MAIA folder, locked the same way documents sent to you are locked.

**The AIs don't negotiate over your information.** Your rules make the decision, not a conversation between two AIs. Anything her AI writes in the request is shown to you, but it can't talk your MAIA into anything. A MAIA also never sends a request automatically just because it received one, so two MAIAs can't get stuck asking each other back and forth.

It works the same in reverse. Your private AI can prepare a request to someone else's MAIA, and you decide whether to send it.

### Why GNAP matters

The "same door" is a public internet standard called **GNAP**, the Grant Negotiation and Authorization Protocol (RFC 9635, published by the IETF in 2024). It matters for five reasons:

- **People and software are treated alike.** A doctor using a web page, a hospital's computer system and an AI agent all ask in exactly the same way, so your rules apply to all of them equally. MAIA's own request pages use GNAP too, and so does another person's MAIA when it asks for them. It works the same whether someone wants to see your information or add to it.
- **A "yes" can't be passed around.** Each permission is tied to a secret digital key that only the requester's browser or program holds. Anyone who copies the permission can't use it.
- **Permission is short and can be taken back.** Each permission lasts one hour. You can stop sharing at any time, and every use is recorded.
- **"Please wait while I ask" is built in.** GNAP was designed for the case where the owner must be asked first. That is exactly what MAIA does when none of your rules decides.
- **It's a standard, not a MAIA invention.** Any software that follows the standard can ask your MAIA, without a special arrangement with MAIA or with any company.

Having only one door also makes MAIA safer. There is one place to protect, one set of limits, and one log to check.

---

## 0. Summary

**The use-case.** A patient runs a *personal authorization server* (AS). A group (Trustee is the first example) publishes a small set of suggested policies at its site (for example trustee.ai). The patient adopts those policies, reviews and confirms them with help from a private AI, and from then on their MAIA answers requests on their behalf. **Every request arrives over GNAP (RFC 9635)**: a person using the patient's personal request page, a person using the group's request page, another member's MAIA, or a software client. Requests can also **add** a document (for example a radiology report). If the patient's cards allow it, the document is held sealed to a key that exists only in the patient's folder, then written into that folder (§10.12). **MAIA is symmetric:** the requester may be another person's MAIA, acting as a GNAP client for its own user in another group or on another host. It follows the same rules in the other direction: its AI drafts, its user sends, and collected answers are sealed to that user's folder (§10.13). The patient hears about some requests right away, gets every request in a weekly email, and keeps a copy of the request log and their Patient Summary in a local folder. Everything else MAIA can do stays hidden until the patient asks for it or the private AI suggests it.

**Recommended approach, in one paragraph.** Keep **one codebase**. Add an **edition switch** (`MAIA_EDITION=personal-as`; the default stays `full`, so no current deployment changes behavior). The server enforces a **feature registry**, so hidden features are actually off, not just out of sight. Build the edition's onboarding, Requests tab, request pages and GNAP endpoints as **new, small components**, and don't add more conditions to the 10,600-line wizard in `ChatInterface.vue`. **Freeze agropper as the demo** (now v1.5.176, after the #309 security fix was promoted) by stopping promotion, and tag that commit. Ship in thirteen PR-sized phases (§14). Every phase keeps the existing security invariants and adds new ones (§3). The main new rules: **no policy acts until the patient has confirmed it, nothing is shared until the patient turns sharing on, and every request enters and every answer leaves through GNAP** (I-30, I-31).

**One request path (D12, decided 2026-09-24).** In the edition, GNAP is the only way a request reaches a patient's MAIA and the only way data leaves it. The request pages are themselves GNAP clients that run in the requester's browser. The group relay becomes a routing service that carries signed GNAP requests to members and sealed answers back. It can't alter a request or read an answer (§10.9). Today's form, which emails the filtered artifact to the requester (§1.5), stays in the `full` edition only.

**What you need to decide** is listed in §17. The ones that most affect the build are D2 (how the private AI is hosted), D3 (whether a passkey is required), D13 (what happens when a requester loses their browser key), and D16 (whether a MAIA may send requests without a click).

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
| Public request form to all members | W3 outside request (`groups.js:816`): verified email, optional payment, vouch, delivery-time + ingest-time evaluation, per-member sealed envelopes, counts-only tally | Rebuilt as a GNAP client over group routing (§10.9–10.10). Today the artifact itself is emailed to the requester (§1.5) |
| Welcome page in Chrome only | `showNotChromeDialog` offers **CONTINUE IN THIS BROWSER** (`src/App.vue:650, 2935`) | Needs a hard gate based on the File System Access capability |
| New users verify email | The welcome form requires it (PR #248). `/api/temporary/start` stamps `emailVerified` when the token matches (`server/routes/auth.js:1238+`) | **The server accepts a missing email.** The edition must enforce it on the server |
| New users pick a private folder | Optional ("Just run the wizard without a local folder"). Deliberately deferred for adoption (Groups.md, PR-6.5) | Make it required in the edition. This intentionally reverses the adoption-funnel choice (§16) |
| Urged to create PS + Current Medications, saved to folder as PDF | The PS/CM pipeline exists with consent-gated verification stamps (PRs #264–#267, #296). The folder currently receives only `maia-state.json`, `maia-log.pdf`, `maia.webloc` | **No PS PDF in the folder.** PS drafting needs an agent, and without Apple Health it relies on KB/RAG |
| Confirm (and test) policies before sharing | "Try it" simulator in `PoliciesPanel.vue` (PR-12) | **No gate.** Cards act as soon as they are stored |
| Private AI to verify and edit policies | Policy Advisor (`server/routes/chat.js:24`, PR #297): server-assembled cards + last 15 requests + record profile; fenced `policy-card` proposals saved only by the user | Needs folder context, feature-unlock proposals, and a single agent (no secondary) started at email verification |
| Email on some requests | Ask-escalations are emailed at ingest. Send-time nudges are debounced (6 h). Hourly mail pull bounds cross-host latency | Notification rules need to be explicit (§8.2) |
| Weekly summary email | **None** | New |
| Request log in folder | Requests live only in `maia_as_requests` (server) | New |
| Hide everything else | **No feature-flag mechanism exists.** The Workbook has 10 rail tabs (`MyStuffDialog.vue:2373`). Every new user gets **two** DO agents at setup, because `/api/agent-setup-status` auto-provisions (`auth.js:1544`) and a secondary agent is added in parallel | New: edition + feature registry (§4) |
| Others add documents (e.g. a radiology report) | Only the patient uploads files (Saved Files, Apple Health). Policy cards have no action dimension: every card means "may read" | New: an `add` action in the vocabulary, sealed hold, delivery to the folder (§10.12) |
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

### 1.5 Finding (2026-09-24): outside requesters receive the artifact by email

Both ways a W3 request can be answered send the privacy-filtered artifact **as plain text in an email** to the address the requester typed:
- autonomous allow at delivery time (`groups.js:934`)
- the patient's **Accept** in the conversation rail (`groups.js:3676`, the "close the AS loop" path)

That address is verified only if the requester chose to verify it. Whether an unverified requester can receive anything depends on the patient's cards. Once sent, the email can't be revoked, and nobody knows whether it was read. **In the edition this path is replaced, not patched:** the answer email carries no PHI, and the artifact is fetched from the RS with a key-bound token (I-31). The `full` edition keeps today's behavior (`legacy-requests`, §4.2). Whether to change it there too is a separate decision (D14).

---

## 2. The use-case as three journeys

**Group admin (Trustee at trustee.ai).**
1. Deploys MAIA with `MAIA_EDITION=personal-as`.
2. Creates the group: open join, publicly listed.
3. Writes the **policy pack**: a few suggested cards, a set of **test requests** showing what those cards do, and the vocabulary edition.
4. Configures credits: Stripe Payment Link, prices, disclosed charity.
5. The welcome page *is* the group page. It shows what the group is, and lets a visitor join, sign in, buy credits, or make a request on the **group request page**, which asks every member (§10.9).

**Patient (member).**
1. Opens trustee.ai in Chrome.
2. Selects JOIN, then verifies email, creates a passkey, and picks their MAIA folder.
3. Joins. The group's cards arrive **unconfirmed**.
4. Is urged to create a Patient Summary with Current Medications. The verified PDF lands in the folder.
5. Reviews each policy with the private AI, runs the group's test requests, edits as needed, and confirms.
6. Turns sharing on. Gets a **personal request link** (copy / QR) to give to a clinician, or to paste into an app.
7. From then on: immediate emails for requests that need a decision or that the AS answered automatically, a weekly digest of everything, and the request log synced into the folder whenever MAIA is open.
8. Everything else (indexing, public AIs, deep links, peer chat, diary…) appears only if the patient turns it on, usually after the private AI suggests it.

**Requester.** Every requester is a GNAP client (§8.1). The routes differ only in how the request gets to the patient's MAIA.
- **A person, directly:** opens the patient's personal request page. The page is a GNAP client running in their browser: it makes its own signing key and sends a signed grant request to that one patient's AS. The requester verifies their email in the GNAP interaction step. They get the privacy-filtered artifact, a decline, or "wait". When an answer arrives later, they get a no-PHI email saying the answer is ready and return to the page to collect it (§10.10).
- **A person, to the whole group:** uses the group request page. It is the same browser client, but it sends to the group's routing endpoint. The group handles email verification and credits once, then carries a copy of the signed request to every member. The requester sees a counts-only tally, and collects answers only from members who shared (§10.9).
- **Another member:** their MAIA signs the request with its member key and sends it through the group routing endpoint, which attests `group-member`.
- **Software:** the same GNAP API, using the patient's personal AS URL or the group endpoint (§10).
- **Another person's MAIA** (a patient or clinician in another group, or on another host): their private AI drafts the request, they click Send, and their MAIA runs the GNAP client on its server. It confirms their email on first contact and is recognized after that. It waits for as long as the grant lives, and seals what it collects to its own user's folder (§10.13).
- **Anyone adding a document** (for example a radiologist's office): the same personal request page in "Add a document" mode, or the same API. They verify their email, attach the file, and are done. The patient's cards decide whether the document is accepted, held for the patient, or refused (§10.12).

---

## 3. Principles and new invariants

The edition changes *what users see*. It does not change *what the system guarantees*. Every invariant I-1…I-23 in the security design doc carries over unchanged. The new ones continue that numbering and belong in its Appendix A once implemented:

- **I-24 — Unconfirmed policy never acts.** Imported cards (group-suggested, restored, or pack updates) arrive with no `confirmedAt` and take no part in evaluation until the patient confirms them. While the patient's AS is not `active`, every request escalates to *ask* and nothing leaves automatically. The safe failure direction is the same as I-23's: the worst case is extra questions.
- **I-25 — Import is a write path.** Every card written to a patient's record, by any route, passes `normalizeCard`. Implemented by PR #309 (§1.4), which made the security doc §5 claim true.
- **I-26 — Edition gates are server-enforced.** Hiding something in the UI is never the only control. A route behind a feature that is off returns `403 FEATURE_OFF`, and no cost-bearing resource (agent, KB, OpenSearch cluster) is created for a feature the user hasn't turned on.
- **I-27 — Unlocking is a user act.** The private AI may *suggest* turning a feature on. The confirm card's text comes from the feature registry, not from the AI, and only the user's click turns the feature on. This extends I-14.
- **I-28 — GNAP tokens are key-bound, and stored as hashes.** Continuation, access, and management tokens are bound to the client key. A request for the `bearer` flag is refused (`invalid_flag`). The server keeps only SHA-256 of each token value, as it already does for invite tokens and vouch codes. This applies I-18 to GNAP.
- **I-29 — Declines are indistinguishable.** A policy decline and a human decline return the same response (`request_denied`, never `user_denied`). A silent deny behaves exactly like an ask the patient never answered: a direct client keeps getting "wait" until the grant expires, and a group request receives no answer from that member. This extends I-4 and I-5 to a protocol where silence has to be modeled explicitly.
- **I-30 — One door.** In the edition, every request reaches a patient's MAIA as a signed GNAP grant request and is handled by one function, `handleGrantRequest()`. This holds whether the request came over HTTP from a browser or software client, or was carried by the group relay. Each member's AS verifies the requester's signature itself. It relies on the group only for what the group verified (email, payment, membership, vouch), which is the trust members already place in the registry. Every route builds the same evaluator input (`{party, purpose, scope, signature, payment}`) and is bound by the same privacy-filter ceiling (I-3, I-22). A route can change *how* a request arrives, never *how it is decided*.
- **I-31 — One exit.** In the edition, data leaves a patient's MAIA only as a response from the co-located RS to a valid key-bound token (§10.7). No email, relay message, notification or log line carries an artifact or PHI. The group relay carries only signed requests, sealed answers and counts. It never holds a token it could use, or an answer it could read.
- **I-32 — Adding is separate from reading, and arrives sealed.** Only a card with `action: 'add'` can accept a document. A card without an action means read, so no existing card ever lets anyone add. A document added by someone else is stored by the server only as a box sealed to the patient's folder key, whose private half the server never holds. It is written only into the folder's `Received/` directory, never into the Patient Summary, the cards or the advisor's instructions. Its text reaches the advisor only as labeled, quoted data (§9).
- **I-33 — Symmetry: a MAIA asks only as its user allows.** A MAIA sends a GNAP request for its user only after that user clicks **Send**, or, once D16 allows it, when a confirmed outbound card covers the request. Its private AI can draft a request but never send one. A MAIA never sends a request as an automatic reaction to a request or answer it received. Answers it collects are sealed to its own user's folder key and delivered to `Received/`, exactly like added documents (I-32). On the answering side, a request from another MAIA gets no special standing: only the patient's cards decide, based on the proofs the request actually carries.
- **I-34 — A delegation is evidence, not access** (applies once delegation ships, §10.13). Only the patient's AS issues root delegations, and only under a confirmed card that allows delegation. Each link can only narrow its parent. A chain never releases data by itself: the delegate gets data only through a GNAP grant decided by the patient's current cards. A revoked link anywhere in the chain stops it. Depth is at most 1 at first.

Two design disciplines (not invariants):
- **Derive, don't store, setup state.** The lesson of `New_User_Flows.md` §4 is that each surface owned a fragment of the pipeline. The edition's setup checklist is a view computed from facts that already exist (email verified, passkey present, folder connected, membership, stamps, confirmed cards, AS state).
- **Build small and new, don't conditionalize large and fragile.** New components for the edition. The full edition's wizard and Workbook stay untouched.

---

## 4. The edition mechanism

### 4.1 Configuration

- `MAIA_EDITION` env var: `full` (default, today's behavior) | `personal-as`. Read once at boot and exposed at `GET /api/edition` as `{ edition, features: { <key>: { available, defaultOn, unlockable } } }`.
- `server/edition.js`: the **feature registry**. For each feature: key, user-facing name, one-paragraph description, what turning it on costs (time, AI usage, where data goes), and the routes it guards.
- **The feature gate** (built in P1a): `server/edition-routes.js` maps **every** route to a feature, or to `public` / `admin` / `registry`. One `/api` middleware, mounted right after the account guard, answers `403 { error: 'FEATURE_OFF', feature }` when that feature is off for the account. An unlockable feature is judged on the account the request names, else the signed-in user, else (for a clinician's guest session) the patient who shared. A test scans `server/` and fails on any route missing from the table, so a new route can't slip past the gate (risk 1). (P0 had a per-route `requireFeature(key)`; P1a replaced it with the table, so there is one mechanism.)
- Client: a `useEdition()` composable, with `has(key)` for `v-if` at a small number of points (Workbook rail list, conversation rail categories, welcome page sections, chat composer extras).
- Per-user unlocks: `userDoc.features = { 'records-index': { enabledAt, via: 'settings' | 'advisor' } }`, written only by `POST /api/user-features` from a user click (I-27). Turning a feature off hides it again; it does not delete data.

### 4.2 Feature matrix

| Feature key | What it covers | Edition default |
|---|---|---|
| `account` | Passkey, verified email, folder, backup/restore, sign-out | **Core** |
| `groups-core` | Join (invite / link / open), credential refresh, leave, pack updates, group routing of GNAP requests and sealed answers (§10.9) | **Core** |
| `policies` | Sharing Policies tab: cards, simulator, group test requests, confirm, AS on/pause | **Core** |
| `requests` | New Requests tab: log, decisions, "stop sharing" (token revocation) | **Core** |
| `summary` | PS + Current Medications (verify flows), Privacy Filtered view + mapping review, PDFs to folder | **Core** |
| `advisor` | Private AI chat scoped to policies, PS, and requests | **Core** (one agent, started after email verification) |
| `notifications` | Immediate emails + weekly digest | **Core** |
| `gnap` | Personal AS endpoint, co-located RS, personal and group request pages (the browser client) | **Core**, and the only request path (answers "wait" until sharing is on) |
| `documents-in` | Others add documents through GNAP (`action: 'add'`), the sealed hold, delivery to `Received/` (§10.12) | **Core** (default ask: a document is accepted automatically only if a card allows it) |
| `requests-out` | The member's MAIA as a GNAP client: AI-drafted, user-sent requests to other MAIAs' personal links or groups; server-side waiting; collected answers to `Received/` (§10.13) | **Core** (sending on a click only; outbound cards later, D16) |
| `legacy-requests` | Today's W3 form endpoint, relay `as-request` envelopes, artifacts emailed to requesters (§1.5) | **Off, not unlockable** (replaced by `gnap`). On in `full` |
| `records-index` | KB + OpenSearch indexing, "ask about my whole record" | Unlockable (largest cost) |
| `lists-full` | Categories, encounters, out-of-range labs, medication worksheets | Unlockable |
| `second-ai` | Secondary private agent, PS generate-pair | Unlockable |
| `public-ai` | Anthropic / OpenAI / DeepSeek / Gemini via DO Inference | Unlockable |
| `saved-chats`, `deep-links` | Stored chats, clinician deep links | **Core** (each needs the patient's own click; the Saved Chats tab appears with the first saved chat) |
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
- `RequestPage.vue`: the requester-facing page, used for both the personal and the group request page (§10.10).
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
| 3 | Choose MAIA folder | Required | Client reports `folderConnectedAt`; `maia-state.json` written; folder key created (public half on the server, §7) |
| 4 | Join the group | Required on a group host | Membership active; cards imported **unconfirmed** (I-24) |
| 5 | Patient Summary + Current Medications | **Urged, skippable** | `currentMedicationsVerifiedAt` + `patientSummaryVerifiedAt`; PDFs written (§7) |
| 6 | Review, test, and confirm policies → **Turn on sharing** | Required before any sharing | Every card confirmed or disabled; `asState = 'active'` |

If step 5 is skipped, sharing can still be turned on. Allow cards for PS or meds then escalate to ask, because no filtered artifact exists (the existing fail-closed rule, I-3). The confirm screen says so plainly: "Your policies allow sharing your summary, but you don't have one yet, so those requests will come to you."

**Patient Summary routes in v1 (D11):**
1. **Apple Health export.** The deterministic Lists build extracts medications, allergies, conditions, encounters, and labs without a KB. The existing draft builder turns those authoritative blocks into a PS using one agent. This is the best-quality route.
2. **Interview.** The private AI asks about conditions, current medications, and allergies, and drafts a PS in the standard section format. The draft goes through the existing review dialog, which remains the only save path, and the patient verifies it.
3. Other record PDFs → offered the `records-index` unlock (full RAG), or a later phase adds an in-context draft without a KB for small record sets.

**Built (P7c, 2026-09-24): route 1 without a knowledge base.**
- **Where it starts.** With no summary, the Patient Summary tab offers **Use my Apple Health export** (with an (i) note) and **Answer a few questions instead** (the P7a interview).
- **Upload.** The chosen PDF is uploaded, recognized as an Apple Health export, and registered. A PDF that isn't an export is removed again.
- **From the MAIA folder (fix, 2026-09-24).** The export comes from the patient's MAIA folder, not a file picker. When the empty tab shows, MAIA looks in the folder and its `Records/` subfolder (§7) for the newest PDF whose first page carries the Apple Health export sentence. It reads the PDFs in the browser (pdfjs), so no other record leaves the computer. Then:
  - if it finds one, the button uses it directly ("Found in your MAIA folder: …");
  - if not, the tab says so, with **Look again**, and a **Choose the file…** fallback that also copies the file into the folder;
  - if the browser dropped folder permission, a button asks for it again.
- **Pipeline.** Without `records-index`, the records pipeline skips indexing and reorders the rest: build the Lists → the patient verifies Current Medications (done means *verified*) → the private AI drafts → review. So nothing that merely advances the pipeline (such as opening the medications tab) can start a draft from an unverified list. The full edition's order is unchanged.
- **Draft.** `runDraftGeneration` no longer stops with `NO_KB` here. The prompt builder reads every registered record, not only the KB folder, and uses the new clinical prompt `patient-summary.records-only`: the extracted blocks are the only source, and any section without a block says "Not documented in the available records."
- **Not built yet.** Route 3 (the `records-index` unlock for other PDFs) needs an unlock screen, which doesn't exist yet.

~~Current Medications verification reuses the existing Lists CM verify card.~~ Superseded by P7d below: Current Medications are verified *inside* the Patient Summary review. The rest of Lists stays behind `lists-full`.

**P7d (built 2026-09-24): one review for the summary and its medicines.**

*Why.* Current Medications used to be a separate step with its own Verify, a historical relic. It left two copies that could drift apart, plus the machinery to keep them in step: a pipeline stage, redirects to the Lists tab, three consent dialogs, and in the full edition a hidden draft patched after the meds were verified.

*What changed.*
- **One screen, one Verify.** The review dialog and the Patient Summary tab show the summary's **Current Medications section as rows, in place**, each with edit, remove and add controls. One Verify (or Verify & save) stamps both the summary and the medications. Editing a row in the tab turns Verify into **Save & verify**.
- **Where the rows come from.** A caption names the source ("From your Apple Health export: medicines active in the past 18 months. Check each one."). A row that isn't in the records' own list is marked **check**.
- **The draft starts from the records' list.** Even before anything is verified, the draft gets the medication list built from the records: Apple Health medication records or an Epic Medication List, with the 18-month rule and redaction (`computeCurrentMedCandidates`, shared with the Lists card). With a knowledge base and no structured list, the AI extracts as before, so non-Apple-Health records keep working.
- **One source of truth.** A verified save derives `userDoc.currentMedications` from the section (`server/utils/summary-sections.js`, twin of `src/utils/summaryMeds.ts`, parity-tested). The two copies can no longer diverge.
- **Accounts verified before P7d.** If an older separately verified list differs, the review offers it once ("Your verified medication list differs: Use that list").
- **Removed in this edition:** the separate meds pipeline stage (and P7c's reordering), the "verify medications first" redirects, the divergence dialogs, and the Current Medications tab in the side menu (Lists, if unlocked, stays). Setup checklist row 5 is done when the summary is verified.
- **Sharing fix (both editions).** A "meds and allergies" share releases only what the patient verified: the verified summary's Current Medications and Allergies sections from the privacy-filtered copy, else a separately verified list. It used to release the unverified raw list, without allergies.
- **Switch.** `combinedSummaryReview()` in `server/edition.js` (with `isPersonalAs` on the client) is the single switch. The full-edition back-port turns it on there, removes the three dialogs and the old wizard's patch step, and makes the Lists medication card read-only.

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
- Every request, by any route, is stored as *ask*.
- No autonomous answer of any kind goes out: no allow, and no deny-respond notice.
- Direct clients get "wait" continuations (§10.5). Group requests get no answer from this member yet.

The patient sees these requests once active, or in the digest. This state is also the natural "vacation / I'm worried" switch.

### 6.3 Testing policies

The group's pack carries **test requests**, for example: "an unverified researcher asks for your Patient Summary"; "a verified-email clinician asks for your medications for clinical use"; "a marketer asks for everything". The confirm screen runs them through the simulator against the patient's current cards (confirmed plus pending) and shows a table: *request → outcome → which of your cards decided*. This is the existing "Try it" machinery fed with curated inputs. The patient can also add their own test requests. The patient's own request page and the GNAP reference client (§10.11) give technically minded patients and group admins a real end-to-end self-test.

### 6.4 Pack updates

The pack gets a version and an Ed25519 signature from the group key, which members already hold. A new version appears as "Trustee updated its suggested policies" with a diff (old sentence beside new). Changed or new cards arrive unconfirmed. **Confirmed cards are never modified by the group** (I-16, I-23).

---

## 7. The local folder

The File System Access folder becomes where the patient's own copy of the record lives. It is also what the private AI reads (§9).

```
<MAIA folder>/
  maia-state.json                          existing: full userDoc backup (incl. group pairwise keys)
  maia-log.pdf                             existing: setup/provisioning log
  MAIA Patient Summary.pdf                      NEW: verified PS incl. Current Medications (regenerated on each verify)
  MAIA Patient Summary - privacy filtered.pdf   NEW: exactly what can leave automatically
  MAIA Sharing Policies.pdf                     NEW: confirmed cards as rendered sentences + AS state + date
  Requests/requests.jsonl                  NEW: append-only request events (canonical, dedup by id+event)
  Requests/Request Log.html                NEW: human-readable, regenerated from the jsonl
  Records/                                 the patient's record files (e.g. Apple Health export)
  Received/                                NEW: documents others added (§10.12), e.g. "2026-09-24 Radiology report - Dr Jane Smith.pdf"
  maia-folder-key.json                     NEW: private half of the folder key, which opens documents waiting on the server
```

- **The folder key.** At setup step 3 the browser generates an X25519 key pair. The server receives only the public half, which the RS seals incoming documents to. The private half is written to `maia-folder-key.json` and kept in IndexedDB. It is *not* part of `maia-state.json` or the userDoc, so neither a server compromise nor a cloud backup can open a waiting document. Keeping it in the folder adds no exposure, because the documents it opens end up in the same folder in plain form. Connecting the folder in a new browser restores it. If the folder is lost, documents still waiting can't be opened, and the sender has to send them again.

- PDFs are made client-side with the existing `jspdf`/`html2pdf` dependencies (the same path as `generateSetupLogPdf`). They are written through `writeFileToFolder`. **Writing the PDF is part of the Verify action**, not a separate step to remember.
- **Built (P7b, 2026-09-24).** `src/utils/folderPdfs.ts` makes the three PDFs and `useFolderPdfs()` writes them. Details:
  - **Summary PDFs.** Every stamped save writes both summary PDFs: Verify, the review dialog's save, and Edit + Save. The writer re-reads the server and writes nothing unless the summary is verified. The filtered PDF is the stored privacy-filtered text verbatim (the text a request releases), never the pseudonym mapping.
  - **Sharing Policies PDF.** Rewritten after every Confirm, rule save, on/off toggle, delete, and change of the sharing switch. It lists only confirmed, turned-on rules, in the order they apply.
  - **Names.** The files carry a "MAIA " prefix. With plain names, a patient's own "Patient Summary.pdf" from a portal could be overwritten, or skipped on import. `isMaiaGeneratedFile()` in `localFolder.ts` is now the one list every folder scan uses (upload, restore, snapshot inventory), so these files are never taken for records.
  - **Account deletion.** Deleting the account removes the Sharing Policies PDF; the summary PDFs stay as the patient's own copy.
  - **Permission.** If the browser has dropped folder permission, a notice offers an Allow button.
  - **Privacy filter fix.** The first filtered PDF showed real names. The filter's name finder missed a markdown name line (`**Pat Doe**, 66, F`, `## Pat Doe, 66, F`) and titled providers ("Dr. Jane Smith"). `extractSummaryNames` now handles both, in both editions. Existing auto-generated mappings pick up the missed names at the next summary load.
- **Honest limitation:** File System Access writes happen only while a MAIA tab is open with permission granted. The server is the AS and holds the operating copy. The folder is synced at sign-in and while the Requests tab is open (`GET /api/requests/log?since=<cursor>`), and it trails the server between visits. The weekly digest reminds the patient when the folder log is out of date.
- **Server retention (D10):** request records are kept at least 90 days after a decision. Older ones are pruned only after the client confirms they are in the folder (`logSyncedThrough`), with a 365-day hard cap. Undecided requests are never pruned. This keeps the local-first model from `NewRestore.md` (the folder is the durable record; the cloud is disposable) without the AS losing the history the advisor uses.

---

## 8. Requests: intake, notification, digest, log

### 8.1 Routes into one door (I-30)

Every request is a GNAP grant request. The route determines only how it reaches the patient's AS, and which proofs can come with it.

| Route | Who uses it | How it arrives | Signature levels |
|---|---|---|---|
| **Direct** | A person on the patient's personal request page, or any software client given the personal AS URL | `POST /gnap/as/:asId` over HTTP | `unverified` (any signed key); `verified-email` (interaction step); payment only when the member is on the group's host |
| **Group** | A person on the group request page, or software using the group endpoint | `POST /gnap/group/:groupId`. The group verifies email and holds any payment once, then the relay carries a copy to each member (§10.9) | `unverified`, `verified-email`, `verified-by-me` (vouch; only on the vouching member's copy, only if `vouch` is on) |
| **Member** | Another member's MAIA, acting for that signed-in member | The same group endpoint, addressed to one member by pairwise id (or to everyone), signed with the member's key | `group-member` (the group attests that the key belongs to an active member) |

All three reach `handleGrantRequest()` → `toPolicyRequest()` → `evaluatePolicies()` → the same dispatch: allow (key-bound token, privacy-filtered artifact only), ask, deny-respond, or deny-silent. Each grant is stored in `maia_gnap`, linked to a request record in `maia_as_requests` that has a `route` field added. GNAP is the *requester's* API. The patient still manages their own MAIA through the signed-in app.

### 8.2 Notification rules (D5)

| Event | Immediate email to patient | Weekly digest |
|---|---|---|
| Request needs your decision (ask) | Yes. Debounced: at most one email per 6 h listing all new asks (reusing the send-time nudge debounce) | Yes |
| Your MAIA shared automatically (allow) | **Yes, each time.** Data left, so the patient should know promptly | Yes |
| Declined automatically (deny-respond / deny-silent) | No | Counts only |
| Grant expired unanswered | No | Yes |
| A document was added (card allowed it) | **Yes**: who (proof-labeled), what kind, and "open MAIA to save it to your folder" | Yes |
| A document is waiting for your decision | Yes, as an ask (debounced) | Yes |
| Accepted documents not yet saved to the folder | No | Yes, as a reminder, until they are saved |

Emails carry **no PHI and no artifact**. They include the requester's stated name and organization, labeled with its proof level ("email verified" / "not verified"), plus scope, purpose, outcome, and a sign-in link. Patients can't unsubscribe from decision-needed emails while sharing is on. Pausing the AS is the off switch.

**Emails to requesters** follow the same rule (I-31). MAIA emails a requester only at an address verified in the interaction step, and only to say that an answer is ready or the request was declined, with a link back to their request page. A requester who didn't verify an email gets no email, and has to keep the page or return to it. For group requests, the registry sends one email per new batch of answers (debounced like the patient's ask emails). It knows only counts, so the email says "N members have answered".

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
- **Share** / **Decline** / **Block**, which write the existing accepted- and blocked-sender facts. Share makes the grant's next continue return a token (direct), or posts a sealed "ready" answer to the requester (group, member). An optional note from the patient is delivered with the artifact at the RS, never by email.
- For any share: **Stop sharing**, which revokes GNAP tokens.
- **Always handle requests like this…**, which pre-fills a card from the actual request. This is Groups_Design Refinement 7's "policies are born from decisions", finally reachable.

A **Sent** filter lists requests this member made to others, and their answers, which the member's MAIA collects (§10.9, §10.13). Requests the private AI drafted wait there as **Drafts** until the member sends or discards them. For each requester recognized from an earlier verified contact, **Forget** drops that recognition (§10.13).

**Documents added by others** appear as rows too (§10.12). A held document can be **previewed** before deciding: the browser opens it with the folder key, and the server never sees it in the clear. **Accept** saves it to `Received/`, and **Decline** deletes it. Accepted documents show whether they have been saved to the folder yet.

This replaces the message-request cards in the conversation rail for edition users.

---

## 9. Private AI in the edition

- **One agent, started in the background once the email is verified** (D2). The ≈30–60 s deploy then overlaps the passkey, folder and join steps, so the agent is usually ready by the Patient Summary step. Waiting for verified email means an unverified visitor (or a bot) never creates a DO resource. There is no secondary agent (`second-ai`) and no KB (`records-index`). In the edition, `/api/agent-setup-status` must not auto-provision before the email is verified (today it provisions for any session, `auth.js:1544`), and must never create the secondary agent. Agents cost nothing while idle (§12), so starting one early has no cost downside.
- **Context.**
  - Server-assembled and authoritative: the existing `buildPolicyAdvisorContext`, extended with AS state and confirmed/unconfirmed status per card.
  - Folder-derived: PS text, the medication list, and a request-log excerpt that the client reads from the folder and attaches as "the patient's own files".
  - **Requester free text is never included.** Request messages come from requesters, so they are an injection channel. The advisor sees who / what / why / outcome, not message bodies.
  - **Documents in `Received/` are the patient's records now, but they were written by someone else.** When the patient asks about one, its text is attached as quoted data labeled with its source ("added by Dr. Jane Smith, email verified, 2026-09-24"). Instructions inside it are never followed (I-32). The advisor may *suggest* updating the Patient Summary from a new report, but the update goes through the normal review and Verify, as always.
- **Outputs are proposals only.** Fenced `policy-card` blocks (existing) and new fenced `maia-feature` blocks (`{"feature":"records-index","reason":"…"}`) render as confirm cards. The card's description of what turning it on does comes from the feature registry, so the model can't misstate what the button does (I-27). Nothing is saved or turned on without a click (I-14).
- **Drafting requests to others (§10.13).** A fenced `maia-request` block (target, what, why, the proof to present, a credit cap) renders as a confirm card, like `maia-feature`. The card lists what sending will reveal about the member, such as their verified email. Nothing leaves without the member's **Send** (I-33). Content collected from other MAIAs is quoted, labeled data, like documents in `Received/`.
- **What the advisor should suggest.** Unlocks come from context. Examples:
  - "you have 40 PDFs in Records/ and asked about a 2019 result → index my records"
  - "you want to send your summary to Dr. X for a visit → deep links"
  - "you want to give your sister's requests stronger standing → vouch"

  The group's pack can also carry a short "what members usually turn on" note that the advisor may cite.
- **D2 alternative: no per-user agent.** Use DO Serverless Inference with a DO-hosted open-weights model for the advisor. **Cost is not a reason to choose this:** per-user agents are free to create, free while idle, and bill the same token rates (§12). What it would gain is zero deploy wait and one fewer DO resource per member. What it would lose is per-user API-key isolation and the proven agent-based Patient Summary path, which would need a new non-agent draft path. Recommendation: one per-user agent for v1.

---

## 10. GNAP API (personal AS)

### 10.1 Scope for this version

GNAP becomes **the only external API of each patient's AS** in the edition (D12, I-30, I-31). MAIA's own request pages use it too. v1 covers:
- the grant request
- asynchronous RO authorization with polling (RFC 9635 §1.6.4, which is exactly MAIA's "ask" path: the AS contacts the patient by email while the client waits)
- an interaction step for requester identity (email verification) and payment (credits, on the host where they are held)
- key-bound opaque access tokens
- a co-located resource server serving privacy-filtered artifacts
- token management (revoke)
- **group routing**: one request to every member, or member to member, through the relay (§10.9)
- **the browser client** behind the personal and group request pages (§10.10)
- **adding a document**: a request with `actions: ["add"]` and an upload to the RS, held sealed to the patient's folder key (§10.12)
- **MAIA symmetry**: a MAIA as the GNAP client for its own user, and recognition of a returning client instance (§10.13)

Because GNAP is the only path, three items that were deferred in the first draft move into v1: payments (same host), `group-member` proofs, and `verified-by-me` (vouch) on group requests. What is still deferred is listed in §10.15.

This is the first **unsolicited public inbound AS surface** (Groups.md §7.3 deliberately had none). §10.8 covers the hardening that follows from that.

### 10.2 Endpoints and pages (per host; one logical AS per patient)

**Personal AS (direct route):**

| Method + path | Purpose |
|---|---|
| `OPTIONS /gnap/as/:asId` | Discovery (RFC 9635 §9): `grant_request_endpoint`, `interaction_start_modes_supported: ["redirect"]`, `interaction_finish_methods_supported: ["redirect","push"]`, `key_proofs_supported: ["httpsig"]`, `key_rotation_supported: false` |
| `POST /gnap/as/:asId` | Grant request |
| `POST /gnap/continue/:grant` | Continue (poll, or finish after interaction with `interact_ref`) |
| `DELETE /gnap/continue/:grant` | Client cancels the grant |
| `GET /gnap/interact/:ix` | Requester's interaction page (verify email by code; credits where held) |
| `DELETE /gnap/token/:tok` | Token management: revoke |
| `GET /gnap/rs/:res` | Co-located RS: returns the privacy-filtered artifact for a valid key-bound token |
| `PUT /gnap/rs/:res` | Co-located RS: receives one added document for a valid key-bound `add` (or `offer`) token, and seals it to the folder key (§10.12) |

**Group routing (§10.9), on the group's host:**

| Method + path | Purpose |
|---|---|
| `POST /gnap/group/:groupId` | Grant request to every active member, or to one member (`maia_to`, members only) |
| `POST /gnap/group/:groupId/continue/:bcast` | The requester's poll: counts, plus any new sealed answers |
| `POST /gnap/group/:groupId/answer/:bcast` | A member's AS posts a sealed answer and an outcome count. The unguessable `bcast` id is the capability; no identity is sent, as with today's tally |

**Pages (the browser client, §10.10):** `/r/:asId` is the patient's personal request page. `/g/:groupId/request` is the group request page. Both are the same `RequestPage.vue`.

- `asId` already exists (16 random bytes, `groups.js:2522`). In the edition it is assigned at account creation. It appears only in the personal link the patient hands out.
- **Continue, token and RS locations are opaque per-grant handles, never the asId.** So an answer to a group request doesn't reveal the member's personal AS address. A requester can't use one share to start tracking or directly contacting that member.
- The patient can **rotate** the asId ("Change my request link"), which invalidates all pending direct grants and their tokens. This is the spam escape hatch.
- The personal request link is shown to the patient (copy / QR). A person opens it in a browser. Software reads the discovery document at the same address.
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
- `actions`: `read`, or `notify` for `notification-only`, or `add` with `datatypes: ["document"]` (§10.12). An `add` access object also carries a `document` descriptor: `{ kind, title, mediaType, size, sha256 }`. `kind` is a small fixed list (`radiology-report`, `lab-report`, `visit-note`, `discharge-summary`, `imaging`, `other`), and `title` is size-capped free text, treated as data. A single access object can't mix `add` with `read`.
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
- v1 accepts Ed25519 JWKs. Current Chrome exposes Ed25519 (and X25519, §10.10) in WebCrypto, so the browser client uses the same algorithm. P5 confirms this on the browsers requesters use. ECDSA P-256 is the fallback if one lacks it.
- Two operational pitfalls to handle:
  1. `@target-uri` has to be rebuilt from `PUBLIC_APP_URL` + `originalUrl`, because DO App Platform proxies requests.
  2. The raw body has to be kept for the digest check. This uses the same `express.json` verify-hook technique already used for the Stripe webhook.
- `created` skew: ±5 min. In-memory nonce cache: 10 min. For group routing, the group endpoint checks `created` and the nonce when the request arrives. A member's AS re-verifies the signature on its copy, but checks freshness against the group's receipt time, because cross-host pickup can lag by up to an hour (§10.9).

### 10.5 Outcome mapping

| MAIA outcome | GNAP response | Notes |
|---|---|---|
| **allow** (confirmed card, AS active, filtered artifact exists) | `access_token { value, access, expires_in: 3600, manage: { uri, access_token } }`. `access[].locations` = the RS URL | Key-bound, no `bearer` flag (I-28). The patient is emailed immediately (§8.2). The artifact carries machine attribution (I-17) |
| **ask** (explicit or default; also every request while AS is not active) | `continue { access_token, uri, wait }` | The patient is emailed (debounced). `wait` starts at 60 s and grows to 3600 s. A poll before `wait` gets `too_fast` |
| patient **accepts** later | the next continue returns `access_token` | The same evaluator re-checks the cards at decision time |
| patient **declines** / **deny-respond** card | error `request_denied` | Never `user_denied` (I-29) |
| **deny-silent** / patient never answers | "wait" continuations until the grant expires (30 days, same as relay/tally TTL), then `invalid_continuation` | Silent deny and an ignored ask look identical (I-29) |
| client asks for `flags: ["bearer"]` | `invalid_flag` | I-28 |

For group and member requests, the same outcomes travel back as **sealed answers** instead of HTTP responses (§10.9). An allow or a later accept sends "ready: continue here", deny-respond or a decline sends `request_denied`, and deny-silent or an ignored ask sends nothing.

### 10.6 Interaction: identity and payment

If the client includes `interact.start: ["redirect"]`, the AS returns `interact.redirect` → the MAIA page at `/gnap/interact/:ix`. The page then redirects or pushes to the client's `finish` URI with `interact_ref` + hash (RFC 9635 §4.2.3). The page offers, in order:

1. **Verify email.** Uses the existing code flow (`/api/email/send-code`, same TTL, attempt limits, and 72 h retention). The grant is evaluated at `verified-email`. After a successful verification the AS issues the client a GNAP **`instance_id`** and remembers "this client instance verified this email" for 12 months. A later request that presents the `instance_id` (and is signed by the same key) is evaluated at `verified-email` without a new code, until the patient chooses **Forget** (§8.4). This matters most for another MAIA acting as a client (§10.13), and it works the same for the browser client. The verification is **host-local**, as in §12.2-4 of the security doc. For a group request, the verification happens once, on the group's host, and travels to members as a group attestation.
2. **Attach credits (optional, after email).** Credits live on the host that sold them, keyed by verified email (`server/credits.js`). A group request holds one payment on the group host for the whole request, however many members it reaches, and settles it through today's tally transitions (`settleTallyPayment`). A direct request can attach credits only when the member's AS is on that same host, which is every member at trustee.ai's launch. Paying a member on another host is deferred (§10.15).

The self-asserted `client.display.name` is shown to the patient labeled "not verified" unless email proof backs it. The requester's free-text message travels in a MAIA extension field (`maia_message`, size-capped). It is shown to the patient as data, and never reaches the advisor (§9).

### 10.7 Tokens and the co-located RS

- **Storage.** New `maia_gnap` database: grant docs (owner, `route`, client JWK thumbprint, access, state, evaluator input, expiry, linked `maia_as_requests` id; for group and member routes also the `bcast` id and the requester's sealing key) and token docs (SHA-256 of the value, grant, key thumbprint, expiry, revoked). Token values are never stored.
- **RS check.** `GET /gnap/rs/:res` (an opaque per-grant handle) with `Authorization: GNAP <token>` + httpsig covering `authorization`. The RS answers cross-origin (CORS, no cookies), because a group requester's page runs on the group's host. The RS checks:
  1. the token hash exists, isn't expired or revoked, and belongs to this handle
  2. the signature was made by the bound key
  3. the requested datatype is within the granted access (`SCOPE_COVERS`)
  4. **the cards still allow it**: invocation re-checks policy, the standing invariant from the security doc §15.4

  It then returns `privacyFilteredSummary` or the pseudonymized meds.
- **What a token grants.** A 1-hour token reads the *current* filtered artifact. There is no standing access: a new grant is evaluated afresh.
- **Stopping access.** "Stop sharing" in the Requests tab revokes the grant's tokens, whatever the route. Rotating the asId revokes every direct grant. Pausing the AS makes check 4 refuse every read, by any route (§6.2).
- **Audit events.** `gnap_grant_received`, `gnap_decided`, `gnap_token_issued`, `gnap_rs_read`, `gnap_token_revoked`, with policy ids on the member side only.

### 10.8 Hardening for the first public inbound endpoint

- Rate limits per IP and per client key (grant creation and polling), plus a cap on pending grants per asId and per group. Excess gets HTTP 429. The group endpoint also caps broadcasts per verified email per day, because one request fans out to every member.
- Unknown asId and rotated asId return the same 404 as any other nonexistent path, so there is no enumeration oracle.
- Request bodies are size-capped.
- Everything a requester controls (display name, `maia_message`, URIs) is rendered as data, and it never reaches the advisor's context as instructions (§9).
- Nonce and replay cache (§10.4). Each continue response issues a new continuation token and invalidates the previous one, as RFC 9635 §5 recommends. This limits token replay.
- The browser client continues only at `https` URIs taken from answers sealed to its own key, and it sends nothing but its signed continue request. So a forged answer (possible only for someone who knows the `bcast` id) can at worst learn the requester's public key.

### 10.9 Group routing: one request to many, and member to member

A requester who sent GNAP directly to every member would need every member's address, and would get one reply per member. That reveals the roster, which is why the first draft kept the group form outside GNAP. Group routing solves this without a second request path. The relay becomes a **mail slot into each member's one door**: it carries a copy of the requester's own signed GNAP request in, and sealed answers back out.

**Step by step (group request):**
1. The requester's browser makes two keys (§10.10): a signing key and a sealing key. It signs one grant request to `POST /gnap/group/:groupId`. The public sealing key goes in a MAIA extension field (`maia_seal_jwk`).
2. The group host checks the signature, `created` and nonce, and runs the interaction step once: email verification, then optionally credits (§10.6). The group is **not an AS**. It never decides and never issues a token. It returns a group continuation (`bcast` id) whose responses carry counts and sealed answers.
3. For each active member, the relay stores a copy of the signed request plus the group's attestations: email verified, payment held, and `verified-by-me` on the vouching member's copy only. Same-host members get it immediately, through an in-process call to the same `handleGrantRequest()`. Members on other hosts pick it up at the next relay pull (up to an hour today).
4. Each member's AS verifies the requester's signature on its copy, evaluates its own cards, and creates a grant bound to the requester's key. Its answer (§10.5) is **sealed to the requester's sealing key** with the relay's existing sealed-box format (X25519 → HKDF-SHA256 → AES-256-GCM). It posts the answer to `/answer/:bcast` with an outcome count and no identity. For deny-silent or an unanswered ask, it posts nothing.
5. The requester's page polls the group continuation, gets the counts plus any new sealed answers, and opens them in the browser. For each "ready" answer, it continues at that member's opaque continue URI, receives a fresh token, and reads the artifact from the member's RS.
6. When answers arrive after the requester has left, the group host emails their verified address (no PHI, §8.2). The page picks up where it stopped.

**What each party learns:**

| Party | Learns | Never learns |
|---|---|---|
| Requester | Counts. Artifacts from members who shared. Each sharing member's opaque grant handles | The roster, who declined or stayed silent, any member's personal AS address, which rule decided |
| Group host (registry) | That a request was made, by whom, and the counts (as today) | Any answer's content, any usable token (tokens are bound to the requester's key), which member answered |
| Member's AS | Its own copy of the request and the group's attestations | Other members' answers |

When the group's host also hosts a member's AS (every member at trustee.ai's launch), the same server runs both roles. The relay still stores only sealed answers and counts, but the host-trust disclosure in §11 applies.

**Member to member.** A member's MAIA is itself a GNAP client acting for its signed-in member. It signs with the member's existing per-group Ed25519 key, which the group already knows from member claims, so the claims move onto RFC 9421 and the whole system uses one signature format. The request goes to the same group endpoint with `maia_to: <pairwiseId>` (or no `maia_to` for every member). The group attests `group-member` because the key belongs to an active member. Answers are sealed to the member's existing per-group X25519 key. The member's MAIA collects them and shows them under **Sent** in the Requests tab. With `peer-messaging` off, this is the only member-to-member traffic.

The group itself could later become a requester in the same way (D7's option (a)), signing with the group key.

### 10.10 The browser client (request pages)

`RequestPage.vue` + `src/gnap/client.ts` is one small GNAP client that serves both the personal request page (`/r/:asId`) and the group request page (`/g/:groupId/request`).

- **Keys.** On first use the page generates an Ed25519 signing key and an X25519 sealing key with WebCrypto, both **non-extractable**, and stores them in IndexedDB for that page's origin. They never leave the browser. The server never sees a private key.
- **Signing.** The client builds RFC 9421 signatures itself: `@method`, `@target-uri`, `content-digest`, `authorization`, with `tag="gnap"`, `created` and `nonce`. It uses the same test vectors as the server module (§10.4).
- **The form.** The fields are the same as today's form: name, organization, what, why, message, optional credits. The page turns them into `access[]` (§10.3), `client.display`, and the `maia_message` / `maia_seal_jwk` extension fields. Email verification and credits happen on the interaction page, not in the form.
- **Waiting.** While open, the page polls, respecting `wait`. On return (from the "answer ready" email or a bookmark), it reloads the saved grant state from IndexedDB and continues.
- **Collecting.** The page fetches the artifact from the RS and displays it, with Print / Save as PDF. Nothing is uploaded or emailed.
- **Add a document mode** (personal page only, §10.12). The requester picks a file, a kind and a title. The page computes the SHA-256 in the browser and sends the descriptor in the grant request. If the grant allows an upload, the page sends the file at once. The requester is done on that visit: they don't have to come back for the patient's decision.
- **Browser support.** Requester pages need only WebCrypto, so any current browser can make a request. The Chrome-only rule applies to members, who need File System Access for their folder.
- **Lost key.** If the requester clears site data or switches devices, their pending answers can't be collected, and they request again (D13). This is the price of "a yes can't be passed around".

### 10.11 Reference client and tests

- `scripts/gnap-client.mjs`: generates an Ed25519 JWK, signs a grant (direct or group), handles `wait`/continue and sealed group answers, optionally opens the interaction URL, and fetches the artifact. It is the software counterpart of the request pages, the admin's self-test, and the basis for the MCP facade.
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
  - asId rotation kills direct grants
  - one door: the same request delivered directly, by the group same-host, and by the group cross-host gets identical decisions and identical grant records apart from `route` (I-30)
  - group request: the relay stores only sealed answers and counts; no stored answer contains an asId; a silent member and an ignored ask post nothing (I-29, I-31)
  - a copy whose signature doesn't verify at the member is dropped, even though the group attested it
  - `verified-by-me` is honored only on the vouching member's copy
  - one payment per group request, settled by tally transitions
  - `maia_to` from a key that isn't an active member's → refused
  - no artifact or PHI in any email template, to patients or requesters (I-31)
  - legacy W3 and `as-request` routes return 403 `FEATURE_OFF` in the edition, 200 in `full`
  - adding a document: no existing card (no `action`) accepts an add; an `add` allow card → `add` token → upload → sealed hold; no card → `offer` token → held for the patient; a deny card → no token, nothing stored
  - upload whose hash or size differs from the descriptor, or whose content isn't the declared type → refused, nothing stored
  - a second upload on the same token → refused (single use)
  - the stored hold is ciphertext only: nothing readable in Spaces, CouchDB or logs; the server can't open it without the folder key (I-32)
  - `add` over a group broadcast → `invalid_request`
  - hold caps per patient and per requester → 429; expired holds are deleted
  - MAIA to MAIA across two hosts (two-host harness): member A's MAIA sends, B's cards decide, A's MAIA collects and seals to A's folder key; B sees nothing that distinguishes it from any other client except the self-reported `maia_origin`
  - an advisor-drafted `maia-request` sends nothing until the member's Send (I-33)
  - no reflexes: receiving a request or an answer never causes an outgoing request (I-33)
  - `instance_id` recognition: same key → `verified-email` without a code; a different key with the same `instance_id` → refused; after Forget → interaction required again
  - pairwise client keys: two target ASes see two different keys for one requester
- Browser client (vitest + jsdom/WebCrypto): signatures verify against the server module; keys are non-extractable; sealed answers open; a restored page resumes a pending grant; a document sealed by the server opens with the folder key.

### 10.12 Adding a document (inbound)

A clinician, a lab, another member or any other client may want to put a document into a patient's MAIA, for example a radiology report after an imaging study. It uses the same door (I-30) and the same cards. The document ends up in the patient's folder.

**Vocabulary (edition v3).** Cards gain an `action` element: `read` (the default) or `add`. `add` pairs with a new scope value, `document`. A card with no `action` means `read`, so every existing card keeps exactly its meaning and none of them accepts an add. That makes this a *compatible* change under the vocabulary-edition rule, recorded in `Policy_Vocab_Changelog.md`. `policySentence`, the simulator and both twin evaluators learn the new element, and the parity test covers it. Example sentence: "Clinicians who have verified their email may add documents to my MAIA for clinical care." The group pack can suggest such a card, which arrives unconfirmed like any other (I-24).

**Floor.** Adding requires at least a verified email, from the interaction step (D15). An unverified client can't add, whatever the cards say. Adds go over the direct route, or to one member with `maia_to`. A group broadcast can't add, because a document is about one patient.

**Flow:**
1. The client sends a grant request with `actions: ["add"]`, `datatypes: ["document"]`, `purpose`, and the `document` descriptor (§10.3). The interaction step verifies email.
2. `handleGrantRequest()` evaluates the cards on `{party, purpose, scope: 'document', action: 'add', signature, payment}`:
   - **allow** → a single-use `add` token for exactly that descriptor (1 hour)
   - **ask** (no card decides) → a single-use `offer` token. GNAP lets the AS grant different access than was requested: this token uploads into a hold for the patient's review, not into the record
   - **deny** → as for any request (I-29). No token, and nothing is ever stored
3. The client uploads with `PUT /gnap/rs/:res`. The RS checks the token, the bound key, and `content-digest`. It checks that the SHA-256 and size match the descriptor, and that the content really is the declared type (magic bytes, not the header). v1 accepts PDF, JPEG, PNG and plain text, up to 20 MB (D15). The RS then seals the bytes to the patient's folder key (§7) with the relay's sealed-box format and stores only the sealed box in Spaces (`received/` under the user's prefix). The readable file exists only in memory, only for these checks. It is never parsed, rendered, indexed or logged on the server.
4. The client's continue shows "accepted" (allow), "waiting for the patient" (offer), or later `request_denied`. The browser page tells the sender they are done. A verified sender gets a no-PHI email when the patient decides an offered document.
5. **Patient decision (offer only).** In the Requests tab the patient's browser downloads the sealed box and opens it with the folder key for a preview. **Accept** turns it into an accepted document. **Decline** deletes the hold and answers `request_denied`.
6. **Delivery to the folder.** Whenever MAIA is open with the folder connected, the client lists accepted holds (`GET /api/received`, session-authenticated). It opens each one with the folder key and writes it to `Received/<date> <kind> - <sender>.<ext>`. The name comes from sanitized, length-capped requester text with no path separators, plus a counter if the name already exists. The client then appends a `document_received` event to `Requests/requests.jsonl` (sender, proof level, kind, title, SHA-256, grant id) and confirms with `POST /api/received/:id/delivered`. The server then deletes the hold.

**Limits.** At most 10 holds and 100 MB waiting per patient, and a per-sender daily cap. Excess gets 429. Holds that aren't decided or delivered are deleted after 90 days (§7, D10), and the weekly digest reminds the patient before then. Because the server can't open a hold, it can't scan it either. The patient's browser opens it only in the built-in viewer (preview) or writes it to disk, and never runs it.

**What doesn't change.** An added document never modifies the Patient Summary, Current Medications or the cards. It isn't indexed unless `records-index` is on and the patient chooses to index it. The advisor treats it as quoted, labeled data (§9).

### 10.13 MAIA symmetry: a MAIA as the requester

Every MAIA is the AS for its own user, and it can also be a GNAP client for that user. So the requester in §8.1 may be a patient or clinician whose own MAIA, in another group or on another host, makes the request. This is the agent-to-agent case as MAIAs implement it. **The answering MAIA needs nothing new:** the request arrives at the same door, and the same cards decide it (I-30, I-33). The requesting MAIA needs the following.

**Composing and sending.** The private AI proposes a request in a fenced `maia-request` block (§9). It renders as a confirm card whose text comes from the registry, and which lists what sending will reveal about the user. The user clicks **Send**, sets a credit cap if credits apply, or discards the draft. In v1 nothing is sent automatically (D16). The requesting MAIA then runs the GNAP client **on its server**, not in a browser tab. That is the practical difference from §10.10: it can wait for days.

**Client keys.** The requesting MAIA keeps one Ed25519 signing key per user **per target AS** (pairwise), so two patients' MAIAs can't link a requester by key. Their verified email links them only when the requester chooses to present it. Group routes keep using the member's per-group key (§10.9). Keys are stored like today's group keys: in the userDoc and in the folder backup.

**First contact, then recognition.** The first request to a given AS goes through the interaction step (§10.6):
1. The requesting MAIA shows its user the interaction link.
2. The user confirms their email address there.
3. The finish redirect returns to the requesting MAIA at `/gnap/client/finish/:id`, with `interact_ref` and the hash.

The answering AS then issues an `instance_id`. Later requests present it, and are evaluated at `verified-email` without a person in the loop, until that patient chooses **Forget**.

**Waiting and collecting.** The requesting MAIA polls on its server, respecting `wait`, for as long as the grant lives. When a token arrives, it reads the artifact from the RS and immediately seals it to **its own user's folder key**. The artifact reaches that user's `Received/` the next time MAIA is open, labeled "requested from …", through the same hold-and-deliver path as an added document (§10.12, I-32). So the requesting host doesn't keep a readable copy either. Adding a document to another MAIA works the same way, with `actions: ["add"]`.

**Proofs a MAIA can present:**
- `verified-email`: by first contact, as above.
- `group-member` of a group the two users **share**: through group routing (§10.9).
- Membership of **another group**, for example a clinicians' group that checks licenses before admitting members. This works through a membership credential signed by that group's key, carried in GNAP `subject.assertions`. The patient's AS checks it against the group key that the patient's card pinned when it named that group. **Later** (D17, §10.15). This is how a role like "clinician" becomes provable without MAIA checking licenses itself: groups vouch for roles, and each patient chooses which groups to trust.
- `verified-by-me`: through the vouch path, unchanged.

**Attribution.** A MAIA-originated request carries a self-reported `maia_origin` extension: `{ software: "maia", version, drafted_by: "user" | "private-ai", sent_by: "user" }`. The patient sees it labeled "self-reported". Cards don't use it in v1. A dishonest client could simply omit it, so it can never grant anything.

**No reflexes.** A MAIA never sends a request as an automatic reaction to an incoming request or answer (I-33). Outgoing requests are rate-limited per user. Together these rule out ping-pong between two MAIAs, and amplification through a group.

**Later: outbound cards (D16).** The same card structure, pointed the other way: `direction: 'out'` (vocabulary edition v4, where an absent direction means in). For example: "My MAIA may ask patients who gave me their link for their medication list, for clinical care, presenting my verified email and spending at most 5 credits." The same evaluator checks outbound cards before a request leaves. Unconfirmed outbound cards never act (I-24). Outbound cards give the full symmetry, "my AI requests on the basis of my rules", but they should wait until inbound cards have been used for real.

**Later: delegation between MAIAs (UCAN).** A doctor's MAIA may need to pass a patient's permission to a colleague, for example a covering physician, automatically under the doctor's own rules. GNAP has no delegation between clients. UCAN supplies it, and GNAP still makes every decision (I-34). This depends on outbound cards (D16) and cross-group credentials (D17).

*Example.* Dr. Ann and Dr. Ben are both in CareNet, a clinicians' group. Pat is in Trustee. Ann goes on vacation, and Ben covers her patients.

1. **Pat's card allows delegation.** A confirmed allow card may carry `delegation: { depth: 1, to: 'grantee-group', maxDays: 14 }`, which reads "…may pass this on to one covering colleague in their own group, for up to 14 days". A card without a `delegation` element can't be delegated, so every existing card keeps its meaning (vocabulary edition v5, compatible).
2. **The grant carries a root.** When such a card allows Ann's request, the GNAP response includes a MAIA extension field holding a root UCAN delegation, signed by Pat's AS key:
   - `iss` / `sub`: Pat's AS
   - `aud`: Ann's pairwise key
   - `cmd`: `/maia/read`
   - `pol`: the granted datatype and purpose
   - `meta`: the depth and group constraints
   - `exp`: the expiry

   Pat's AS key is per patient, and it changes whenever the asId is rotated.
3. **Ann's MAIA delegates under Ann's rule.** Ann has an outbound delegation card (the D16 family), for example "When I'm marked away, delegate my active clinical grants to my covering colleague". It lets Ann's MAIA sign a narrower UCAN without a click: `iss` Ann, `aud` Ben's CareNet member key, `exp` the end of the away period. Ann's MAIA sends it, sealed, to Ben's MAIA through CareNet's relay, and Ann is notified. A delegation can only narrow its parent, never widen it.
4. **Ben's MAIA asks over GNAP.** The grant request carries the chain in `maia_delegation: { format: "ucan", chain: [...] }`. It is signed (RFC 9421) by Ben's key, which must be the final `aud`. GNAP's key proof doubles as UCAN's proof of audience. Ben's MAIA sends automatically only under Ben's own outbound card; otherwise Ben clicks Send.
5. **Pat's AS decides.** It checks:
   - every signature;
   - that the root is its own and has not been revoked;
   - that each link only narrows the one before (command, policy, expiry, depth);
   - Ben's CareNet membership credential (D17).

   It then evaluates Pat's **current** cards, recording who delegated. If they allow the request, Ben's key gets a fresh key-bound token. If Pat's cards have changed, the request becomes an ask or a denial as usual.
6. **Pat sees it:** "Your MAIA shared your medication list with Dr. Ben (CareNet), covering for Dr. Ann."
7. **Revocation.**
   - Pat's **Stop sharing** on Ann's grant revokes the root, which kills the whole chain.
   - Ann can post a signed UCAN revocation to Pat's AS (`POST /gnap/delegation/revoke`).
   - Rotating the asId changes Pat's AS key and kills every chain.
   - The RS re-checks revocations along with the cards on every read, so a revocation takes effect at once.

*Design choices:*
- **Delegations, not invocations.** MAIA uses UCAN delegations as evidence. It never accepts a UCAN invocation at the RS: the GNAP grant request plays the invocation's role, so asking the patient, waiting, notification and the patient's current cards always apply.
- **UCAN over ZCAP-LD.** Both express capability chains that can only narrow, with conditions and expiry. UCAN 1.0 fits MAIA better:
  - its `did:key` Ed25519 identifiers map directly onto MAIA's JWKs;
  - its `pol` predicates map onto the scope and purpose checks;
  - it has a revocation spec;
  - it is compact.

  ZCAP-LD needs JSON-LD canonicalization with a pinned context loader, and its invocation uses an older HTTP Signatures draft that would sit beside RFC 9421. Both are community specifications, not IETF or W3C standards, and UCAN 1.0 envelopes are DAG-CBOR (IPLD). If no maintained JavaScript library exists when this is built, use a small MAIA JSON profile with UCAN's field names and rules, so that moving to UCAN later is mechanical (D18).
- **What delegation can't do.** It can't stop Ann from forwarding what she has already received. What it does is make the accountable path (fresh, visible, revocable access) easier than copying.

### 10.14 GNAP, MCP and A2A (opinion)

Two agent protocols come up next to this work. They solve different problems from GNAP, and neither should become a second door (I-30). What follows is based on the published specifications as I understand them in 2026. Re-check the details before building anything on either.

- **MCP (Model Context Protocol)** connects an AI model to tools and data: it is the agent-to-tool layer. Its authorization is OAuth-based, with an MCP server acting as an OAuth resource server.
  - *Inside a MAIA:* the private AI could reach MAIA's own functions as MCP tools (draft a request, list requests, read the folder). That is an internal implementation choice, and nothing changes at the door.
  - *For outside agents:* the deferred **MCP facade** is an MCP server that wraps a GNAP *client*. A clinician's general-purpose AI assistant calls a tool such as `request_patient_summary(as_url, purpose)`. Underneath, it is a GNAP grant with the same keys, interaction and tokens. When an email must be confirmed, the tool returns the interaction link for the human. This is simply §10.13 for agents that aren't MAIAs.
  - *Not:* an MCP server on the patient's side that hands records to any OAuth-authorized agent. That would put a second authorization system beside the cards. If one is ever needed, it must accept only GNAP-issued, key-bound tokens and read through the same RS.
- **A2A (Agent2Agent)** lets agents discover each other (an "Agent Card" describing their skills and how to authenticate) and exchange tasks and messages. It deliberately leaves authorization to existing web schemes.
  - *Discovery (later, if a partner needs it):* a MAIA could publish an Agent Card whose skills are "request a record" and "add a document", and which names GNAP at the personal AS URL as the way to get authorized.
  - *Notifications:* A2A task updates could tell a requesting agent that an answer is ready, as an alternative to the email or to polling.
  - *Not:* negotiating access in conversation. A2A's strength is free-form dialogue between agents, which is exactly what must not decide access. A2A message text would be treated like `maia_message`: data shown to people, never input to a decision, and never instructions to the advisor.
- **Why GNAP stays the door.** GNAP separates *asking* from *deciding*, and binds every permission to a key. Its "wait while I ask the owner" flow is MAIA's ask path. MCP and A2A are about *how agents talk*; GNAP is about *who may get what*. Recommendation: GNAP remains the only authorization protocol. MCP is a client-side adapter (the facade), and A2A is an optional discovery and notification wrapper. Add each only when a real partner needs it.

### 10.15 Deferred

In the order the roadmap already set (security doc §15), minus what moved into v1:
1. **Cross-host payments**: paying a member whose AS is on another host needs registry attestation of the hold, or credits on the member host. Design both before building.
2. **`verified-by-me` on direct requests** (a WebAuthn step in the interaction page). Today's vouch works through group routing.
3. **Key recovery for requesters** (D13), for example re-binding a pending grant to a new key after the same email is verified again.
4. **Outbound cards** (D16): automatic sending within the user's own rules (§10.13).
5. **Cross-group membership credentials** (D17): proofs such as "member of a clinicians' group that checks licenses" (§10.13).
6. **Delegation between MAIAs** (UCAN, D18): a doctor's MAIA passes a patient's permission to a covering colleague under both parties' rules; the patient's AS still decides (§10.13, I-34).
7. The **MCP facade**: an MCP tool wrapping the reference client, so an agent can request a patient's filtered summary under the patient's cards (§10.14).
8. **RFC 9767** `/.well-known/gnap-as-rs` + introspection + structured JWT tokens for external RSs (the hospital FHIR boundary, security doc §15.5).
9. Cedar as the evaluation engine behind all of it.

---

## 11. Group side (trustee.ai)

| Item | Today | Edition work |
|---|---|---|
| Suggested policies | Cards on the group doc | Becomes a **signed, versioned policy pack**: cards + test requests + vocabulary edition + optional "commonly turned-on features" note (§6.3–6.4) |
| Public request form | W3 form + tally | Becomes the **group request page**: the browser GNAP client pointed at the group routing endpoint (§10.9–10.10). Fields unchanged; email and credits move to the interaction step. Counts-only tally unchanged. The primary action on the group page |
| Selling credits ("tokens") | Stripe Payment Link + webhook, balance keyed by verified email | Visible "Buy credits" on the group page for anyone with a verified email. Keep the word **credits** (D6) |
| Welcome page | Organizer-first page (Refinement 8) | Edition variant: group hero, JOIN, Sign in, Make a request, Buy credits, Learn more. "Start a group" and the comparison section are hidden |
| Admin | AdminGroups, credits config | Pack editor gains test requests + publish-new-version. Everything else unchanged |

**Trust model disclosure.** On trustee.ai the group's host also hosts members' ASes. The README's rule applies: whoever pays for hosting controls the infrastructure. The edition's welcome page should say, in one line, who hosts and pays. Members who want their own host can join from their own MAIA through the existing federation path (PR-11).

---

## 12. Operating cost

Verified 2026-09-22 against DigitalOcean's published pricing (last verified by DO the same day) and the account's own August 2026 invoice, read through the DO billing API.

### 12.1 How DO bills the AI pieces

- **Agents are limited per DO account** (checked 2026-09-22): 15 at Tier 1, 60 at Tiers 2–4, 120 at Tier 5 (support can raise it), plus a daily creation limit; knowledge bases have the same caps. Both current apps share one account (17 agents that day). **With per-user agents, the agent quota — not money — caps membership**: about 60 members per Tier 2–4 account at one agent each, and a new DO account for trustee.ai starts at 15. This reopens D2.
- **Agents: free to create, and free while idle.** DO charges only for the input and output tokens an agent processes, at the same rates as serverless inference. There is no per-agent, per-hour or per-month fee.
- **Token prices, per 1 million tokens:**

  | Model or service | Price |
  |---|---|
  | gpt-oss-120b (primary agent) | $0.10 input / $0.70 output |
  | DeepSeek V4 Pro (secondary agent) | $1.74 input / $3.48 output |
  | Knowledge-base embedding, gte-large-en-v1.5 | $0.09 |
  | BGE reranker | $0.01 |

- **Knowledge bases** store their embeddings in a managed **OpenSearch cluster**. That cluster is a fixed monthly cost, and one cluster serves every KB on the DO account. The smallest size (1 vCPU, 2 GB, one node, 40 GiB) costs **$19.60/month**, and it is the size this account runs (`genai1-driftwood`).

### 12.2 What the current deployments cost (August 2026 invoice: $55.71)

| Line | $/month |
|---|---|
| OpenSearch cluster (shared by both apps' KBs) | **19.60** |
| App Platform: maia-self 10.00 + claude-self 5.00 | 15.00 |
| Discourse forum droplet (not MAIA) | 9.49 |
| CouchDB droplet (shared, prefix-separated) | 6.00 |
| Spaces subscription | 5.00 |
| Serverless inference (public AIs, group advisor) | 0.19 |
| All per-user agents together (each $0.01–0.06) | < 0.25 |
| All per-user knowledge bases together (each $0.01–0.11) | < 0.25 |

Everything AI-related came to **under $1**. The OpenSearch cluster alone was **35%** of the bill.

### 12.3 Per-member AI cost (estimates from token counts, gpt-oss-120b)

| Use | Tokens (in / out) | Cost |
|---|---|---|
| Policy-advisor question | ~5k / ~600 | ≈ $0.001 |
| Question answered from the patient's indexed records (retrieval k=15) | ~15–20k / ~600 | ≈ $0.002–0.003 |
| Patient Summary draft | ~40k / ~4k | ≈ $0.007 |

A member who asks 1,000 advisor questions costs about $1. The secondary DeepSeek agent costs roughly 5–17× more per token, which is still only cents per member per month. At 100 credits = $2, credits easily cover AI use. They mainly exist to price requesters' attention (§8 of the security design doc), not to recover AI costs.

### 12.4 What the edition actually changes

| Resource | Full edition today | Personal-AS edition | Effect on cost |
|---|---|---|---|
| Per-user agents | 2 per user at setup (primary auto-provisioned by `agent-setup-status`, secondary in parallel) | **1 per member**, started once the email is verified (D2). No secondary unless `second-ai` is turned on | **Negligible either way.** Dropping the secondary agent is about fewer DO resources to create, clean up on deletion, and explain, not about money |
| Knowledge base + OpenSearch | One KB per user at first indexing. The account's OpenSearch cluster is created at the first KB | **None unless `records-index` is turned on** | **The real lever: $19.60/month fixed.** A new edition host on its own DO account (e.g. trustee.ai) never creates the cluster until a member indexes. On the existing shared account the cluster already exists, so the test app saves nothing |
| Public-AI inference | Available to everyone | Off unless turned on | Small, but it's the only AI spend that isn't on DO-hosted open models |
| Spaces objects | Uploaded records persist (root / archived / KB) | Same in v1. Later: transient upload → parse → delete, with the folder as the only persistent copy | None (flat $5 subscription up to 250 GiB). This is a privacy change, not a cost change |
| Server chats (`maia_chats`) | Yes | Only chats the member saves | None (CouchDB is a fixed droplet) |
| Email (Resend) | Requests, invites, nudges | + weekly digests, + "answer ready" emails to verified requesters | Small volume |

**What a minimal edition host costs:** App Platform $5–10 + CouchDB droplet $6 + Spaces $5 ≈ **$16–21/month**, plus **$19.60** only once someone turns on indexing (≈ $36–41). Both figures are inside the README's "$10–40/month" range. Member count barely moves the bill: what scales with members is tokens (cents) and email.

**Conclusion for the design:** make choices about agents on latency, privacy and cleanup grounds, not cost (see D2). Make choices about indexing (`records-index`) with cost in mind, because indexing is what brings in the only large fixed cost.

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

Each row is one PR (or two small ones) into HIEofOne/self and references this doc. Server-only phases can overlap once their dependencies merge. **Revised 2026-09-24:** GNAP is now the backbone of request handling, so it moves up to P4–P6, right after confirmed policies (P3). The Requests tab, notifications and log (P8) are built on grants. P7 (PS/CM to folder) doesn't depend on GNAP and can run alongside P4–P6. P11 (MAIA symmetry) comes after the advisor (P10), because drafting requests is an advisor output. The server-side client itself reuses P6's member-to-member client.

| Phase | Delivers | Key tests / acceptance |
|---|---|---|
| **P0 — Groundwork** (no visible change) | ~~Demo tag~~ (done: `demo-v1.5.176`) + promotion freeze. `server/edition.js` registry, `GET /api/edition`, `requireFeature`, `useEdition()`. (The §1.4 import bypass, I-25, already shipped in #309.) Refresh CLAUDE.md (counts, tests exist) + Environment.md. Found while building P0: startup *created* the OpenSearch cluster when none existed, so `personal-as` now skips that startup step (§12.4) | `full` edition: every existing test passes unchanged. Registry tests run under both editions |
| **P1 — Edition shell** | Chrome capability gate. Edition welcome page. Workbook rail filtered to core tabs. Conversation rail = Private AI only. Server gates on unlockable routes (I-26). In the edition, `agent-setup-status` provisions only after email verification and never the secondary agent. **Split in two PRs.** P1a (server): the route table and gate above; `POST /api/user-features` (the settings toggle that turns an unlockable feature on or off, I-27); the email rule inside `ensureUserAgent`, so no call site can create an agent early; chat providers filtered by feature; `legacy-requests` turned off here rather than in P6, so what `/api/edition` reports is what the server enforces. P1b (client): Chrome gate (no continue option; shared-chat guests and admin pages exempt), a sparse edition welcome (the group's name and description; own computer, verified email and joining the group, each with an (i) explanation; GET STARTED), Workbook and conversation rails filtered by feature, Lists reduced to Current Medications without `lists-full` | Hidden routes return 403 `FEATURE_OFF` in the edition and 200 in `full`. An unverified signup creates no DO agent; a verified one creates exactly one |
| **P2 — Setup checklist** | `SetupChecklist.vue` + derived `GET /api/setup-status`. Server-enforced verified email. Required passkey (D3) + folder. Join. One agent started in the background at email verification. **Built (2026-09-24):** rows 1–5 (row 6 arrives with P3's confirm-and-turn-on). The server refuses a new account without a verified email (`EMAIL_VERIFICATION_REQUIRED`) and a brand-new account from a bare passkey (`START_WITH_EMAIL`), starts the agent in the background at verification, and records only `folderConnectedAt` for the folder. The checklist joins the group automatically once the email is verified, can't be dismissed until the required rows are done, stops polling if the agent fails to start (one-click Try again), and replaces the Workbook's Setup Wizard button. The folder key moves to P9, as planned there | Fresh user reaches "joined" with exactly 1 agent (no secondary), usually already running. Reload at any step resumes correctly (derived state) |
| **P3 — Confirmed policies + AS state** | `confirmedAt`, `asState` (setup / active / paused) in both twin evaluators + parity test. Confirm screen with pack test requests + simulator. Turn on / pause. `Sharing Policies.pdf`. **Built (2026-09-24):** both evaluator twins take `{ requireConfirmed, asState }` (defaults = the full edition), parity-tested; the patient's own save or a Confirm button stamps `confirmedAt`; `POST /api/as-state` turns sharing on only with every enabled rule confirmed, and pauses at any time; checklist row 6 (doesn't block closing the checklist). The Sharing Policies tab shows a sharing bar, Confirm on each unconfirmed rule, and "Test your rules" with built-in sample requests (group-written test requests come with signed packs, §6.4). `Sharing Policies.pdf` moved to P7 with the other folder PDFs | Two-host suite extended: an unconfirmed allow card never releases. `setup` → everything asks. Pause → asks again. Parity holds |
| **P4 — GNAP core (direct route)** | `server/gnap/httpsig.js` + RFC vectors. `handleGrantRequest()` + `toPolicyRequest()`. Grant / continue / interact (email) / token / RS endpoints with opaque per-grant handles. `maia_gnap`. Reference client  **Built (2026-09-25):**
- `server/gnap/httpsig.js` reproduces the RFC 9421 B.2.6 Ed25519 signature byte for byte and enforces the §7.3.1 profile: covered `@method`/`@target-uri`/`content-digest`/`authorization`, `tag="gnap"`, a ±5 min `created`, `keyid` = the JWK `kid`, and a 10-minute nonce cache.
- `server/gnap/grants.js` holds `parseGrantRequest` (unknown values refused), `toPolicyRequest`, `decideGrant` (the same evaluator and I-24 options as every route; allow with no verified artifact → ask) and `mayStillRead`.
- `server/routes/gnap.js` serves discovery, grant, continue (a fresh continuation token each time, `too_fast`), cancel, the email-verification interaction page with redirect/push finish and the §4.2.3 hash, token revoke, and the RS (CORS, scope lattice, re-check at read, pause stops reads).
- The patient's address: `GET /api/gnap/request-link`, and `POST /api/gnap/request-link/rotate`, which stops every direct grant.
- Storage: `maia_gnap`, with id-only lookups and token hashes only.
- Patients and requesters:
  - an ask lands in the patient's existing requests list, and their accept/decline decides the grant (never emailing an artifact);
  - the patient gets a no-PHI notice;
  - the requester is never emailed.
- `scripts/gnap-client.mjs` is the reference client.
- **Left for P5:** `instance_id`, credits in the interaction, "answer ready" emails, and the patient's link on screen. | The direct-route part of §10.11. Reference client completes allow, ask→accept and ask→decline against test.agropper.xyz |
| **P5 — Browser client + personal request page** | `src/gnap/client.ts` (WebCrypto keys in IndexedDB, httpsig signing, sealed-box open). `RequestPage.vue` at `/r/:asId`. Personal request link (copy / QR) for the patient. "Answer ready" emails to verified requesters. Credits in the interaction step (same host). Confirm Ed25519 + X25519 in the target browsers **P5a built (2026-09-25):**
- `src/gnap/httpsig.ts` signs with WebCrypto Ed25519 (the key is non-extractable, kept in IndexedDB); `tests/gnap-client.test.ts` checks its signatures and interaction hash with the server's verifier.
- `src/gnap/client.ts` + `RequestPage.vue` (mounted by `main.ts` for `/r/<asId>`, never the patient app): form → signed grant → email check → back with the hash checked → wait (polling while open) → read the answer at the RS, with Print. Progress survives closing the page; the answer can be read only from the browser that asked.
- The Requests tab (`RequestsPanel.vue`, Personal AS only): the request link (copy, change), every request with Share / Decline / Ignore, and Stop sharing (`POST /api/user-groups/requests/:id/stop-sharing` revokes the grant's tokens).
- "Answer ready" email to a verified requester when the patient shares or declines (never for Ignore); the decision also lifts the requester's wait, so they can collect at once.
- Fixes found on the way: `/gnap/` is exempt from the app's global CORS (which swallowed the OPTIONS discovery and refused other origins and the signature headers); a failed verification email no longer returns the code to the page; the request link is saved conflict-safe.
- **P5b built (2026-09-25):**
  - **Recognition.** After an email check the AS issues an `instance_id` bound to the client's key (`server/gnap/instances.js`, `ci_<id>` in `maia_gnap`). A request that presents it (`client: "<id>"`, RFC 9635 §2.3), signed by that key, is judged at `verified-email` with no code, for 12 months. It stops when the patient chooses **Forget** in the Requests tab or changes the link. The browser client falls back to a new email check when it is no longer recognized.
  - **Credits on the interaction page** (`server/gnap/payments.js`). After verifying, a requester with a balance on this host may attach a spam deposit (5, held), an evaluation fee (2, charged) or a sharing payment (25, held). The grant's `policyRequest.payment` carries it to the cards. Settlement follows the request form's rules:
    - on a share: the sharing payment is captured and the deposit is returned;
    - on a decline, a withdrawal or a link change: holds are returned;
    - when an ignored request expires: the deposit is forfeited and the sharing payment returned (the daily sweep).
    A recognized requester reaches this step by ticking "Offer credits".
  - A QR code for the request link.
- **Left for P6:** X25519 in the browser (sealed group answers). | A clinician-style run in a clean browser: request → verify email → ask → patient accepts → email → return → collect. Key is non-extractable. No PHI in any email |
| **P6 — Group and member routing** | `/gnap/group/:groupId` (+ continue, answer). Relay copies + group attestations. Sealed answers. Same-host fast path through the same handler. Group request page. Member-to-member through `maia_to`, with member claims moved onto RFC 9421. Tally + one payment per request. (`legacy-requests` has been off in the edition since P1a.) Security doc §15.4 + Appendix A (I-24…I-31) **P6a built (2026-09-25), the outside requester's route:**
- `server/routes/gnap-group.js` (the group's side):
  - discovery, and the signed grant request, which needs `interact` and a `maia_seal_jwk`;
  - the group's own email check, with credits;
  - the requester's continue, returning counts plus sealed answers;
  - withdraw;
  - the members' answer slot, capped at the number reached.
  Nothing goes out before the email check.
- **Fan-out** (`server/gnap/group.js`). A copy of the exact signed request, with an attestation signed by the group key, goes to each member's relay inbox, sender `gnap:<bcast>`. The attestation covers the group, the request, receipt and expiry, the target URI, the body hash, the verified email, the payment and the answer URI. Members on the same host pull at once (`pullSameHostMembers`).
- **A member's AS** (`receiveGroupCopy` in `routes/gnap.js`):
  - verifies the attestation and the requester's own signature, fresh as of the group's receipt;
  - makes its own grant (route `group`);
  - decides with its own cards.
  A share or a decline, whether by card or later by the patient, posts an answer sealed to the requester's X25519 key; ignoring posts nothing. A failed post is retried daily.
- **The group** keeps boxes it can't open, and counts. It emails the verified requester at most every 30 minutes, with counts only. One payment covers the whole request: a share captures a sharing payment, any answer returns a deposit, and expiry settles the rest.
- **`GroupRequestPage.vue`** at `/g/<groupId>/request`, with a non-extractable X25519 sealing key (`src/gnap/sealedBox.ts`, tested against the server's `sealTo`). It opens each answer, trades its continuation for a key-bound token at that member's MAIA, and reads the answer there. The admin's group dialog shows the link. The sealed box moved to `server/utils/sealed-box.js`.
- **P6b built (2026-09-25), member to member:**
  - **Asking** (`server/routes/gnap-member.js`). A member's MAIA signs with the member's per-group key, only after the member clicks Send. The group recognizes the registered key and attests `group-member`, the pairwise id and the alias, with no email check. It sends to every other member, or to one (`maia_to`).
  - **Recipients** judge it as the group party at `group-member` strength. A blocked sender is dropped.
  - **Answers** are sealed to the member's per-group X25519 key. The requesting host keeps only continuations and hour-long tokens; answers are read on demand from the answering member's AS and never stored. An hourly check emails the member (counts only).
  - **UI.** The Requests tab has "Ask your group" and a **Sent** list, and a member thread's "Request records" button uses the same path.
  - **Security doc.** A §6.3 GNAP section and I-24…I-31 were added to `MAIA_Request_Security_Privacy_Design.md`.
  - **Not done.** The legacy signed member claims (refresh, relay send, leave) still use their own detached-signature format; moving them onto RFC 9421 is a cleanup, not a security change. | The group and one-door parts of §10.11. Two-host suite: the same request direct, same-host and cross-host decides identically. The relay stores no readable answer |
| **P7 — PS/CM to folder** | Verify writes `Patient Summary.pdf` + privacy-filtered PDF; `Sharing Policies.pdf` (moved from P3). PS interview route. Apple Health route with one agent. **P7a built (2026-09-24):** the interview route. With no records, the Patient Summary tab offers "Write my summary": a short form (name, date of birth, sex, conditions, medicines, allergies, recent visits, anything else). `POST /api/patient-summary/interview` stores the answers and has the private AI draft from them alone (clinical prompt `patient-summary.interview`) into the usual draft slot. The draft opens the existing review dialog, which stays the only way to save and verify. Nothing here indexes records or opens the old wizard. P7b (the three PDFs on verify) and P7c (Apple Health without a knowledge base) follow | Verify → both PDFs in the folder. Edit clears stamp → PDFs regenerated only on re-verify |
| **P7d — One review for the summary and its medicines** | Current Medications become a section of the Patient Summary, edited as rows in the same review and verified with it; the medication list is derived from the verified summary; meds-and-allergies shares release only verified content. **Built (2026-09-24)**, see §5 | One Verify stamps both; the list equals the verified section; an unverified list never leaves |
| **P8 — Requests, notifications, log** | `RequestsPanel.vue` over grants (decide, stop sharing, Sent, "always handle like this"). Notification rules. Weekly digest + monthly heartbeat. `requests.jsonl` + HTML sync. Retention **Built (2026-09-26):**
- **Notices** (`server/gnap/notices.js`). Every automatic share emails at once. Asks send at most one email per 6 hours, listing every new ask; the hourly run sends what waited. The weekly digest covers counts by outcome, what is waiting, automatic shares, top requesters and the folder-log status. A quiet month gets a heartbeat. `lastDigestAt` moves only when the provider accepted the email. Emails name the requester with their proof level, what, why and the outcome, and never carry health data or the requester's message (template test).
- **The folder log** (`src/utils/requestLog.ts`). `Requests/requests.jsonl` holds events deduplicated by id, and `Requests/Request Log.html` is regenerated from it. It is written at sign-in and while the Requests tab is open, under a Web Lock so two tabs don't collide, from `GET /api/requests/log?since=`. The folder reports what it holds (`POST /api/requests/log/synced`).
- **Retention** (daily). A decided request is pruned after 90 days once the folder has it, and after 365 days regardless. Undecided requests are never pruned.
- **Requests tab.** Filters (Needs your decision, Shared, Declined, All), the folder-log status with Allow, and "Always handle requests like this…". That makes a confirmed card from the request (party, purpose, scope, the requester's proof level, payment), with Share, Ask me, Decline or Ignore, and rewrites the Sharing Policies PDF. | Digest idempotent across cron re-runs. No PHI in any email (template test). Log dedup across tabs. Stop sharing → RS 401 |
| **P9 — Adding documents** | Vocabulary v3 (`action`: read / add, scope `document`) in both twin evaluators + parity test + changelog entry. `add`/`offer` grants, `PUT /gnap/rs/:res` with type/hash/size checks, sealing to the folder key, holds in Spaces. Folder key at setup step 3. "Add a document" mode on the personal request page. Requests-tab preview / accept / decline. Delivery to `Received/` + `document_received` log events. Caps and 90-day expiry **Built (2026-09-26):**
- **Vocabulary v3** in both twins (`server/routes/policies.js`, `src/utils/policyCards.ts`), with a `Policy_Vocab_Changelog.md` entry. An add card must require at least `verified-email`. The card builder offers an "Add a document" scope cell and the simulator tests it. The older request paths accept only the read scopes (`READ_SCOPES`).
- **The door** (`server/routes/gnap.js`, `server/gnap/documents.js`). A new sender must include `interact`, and nothing is decided or recorded before the email check. An add card → a single-use `add` token; no deciding card, or sharing off → an `offer` token; a deny card → no token. With no folder key the sender waits as for silence, and the patient sees why. `PUT /gnap/rs/:res` checks the signature over the bytes, size, SHA-256, declared type and real type (magic bytes; UTF-8 for text), claims the token once, re-checks the cards, seals to the folder key and stores the box in Spaces (`<userId>/received/`). The upload's answer says `accepted` or `held`: the sender's page is done at once, and a verified sender is emailed when the patient decides a held one. A group broadcast and a relayed member copy refuse `add`: adding to one member through `maia_to` waits for P11, where a member's MAIA can hold the file.
- **The folder key** (`src/utils/folderKey.ts`). Made at setup step 3 and, for accounts set up earlier, at the next sign-in. The folder copy wins, the browser's copy restores a lost file, and the server gets only the public half (`/api/folder-key`).
- **Patient side** (`server/routes/received.js`, `src/utils/received.ts`, `RequestsPanel.vue`). Document rows with Preview (opened in the browser with the folder key), Accept, Decline and Ignore. Accepted documents are written to `Received/<date> <kind> - <sender>.<ext>` at sign-in, on Accept and while the Requests tab is open, then the hold is deleted. "Always handle requests like this…" on a document makes an add card.
- **Notices, log, retention.** Notices name the kind, never the title. The digest counts added documents and reminds about unsaved ones. The folder log gains `accepted`, `document_received` (with the file name and SHA-256) and `expired`. Holds neither decided nor saved in 90 days are deleted daily, and retention never prunes a request whose hold is still waiting. | The adding-a-document part of §10.11 (`tests/backend/gnap-documents.test.js`, `tests/received-documents.test.ts`). Live, locally: a clean browser offered a PDF → held, previewed, accepted and written to `Received/`; then a rule made from it accepted a PNG from the same (recognized) sender, written at the next sign-in. The server-side hold is ciphertext only |
| **P10 — Advisor for the edition** | Folder context. Fenced `maia-feature` proposals → registry-authored confirm cards → `POST /api/user-features`. First unlock flow end to end: `records-index` | Advisor output can't turn anything on without a click (I-27). Requester text absent from the advisor context |
| **P11 — MAIA symmetry (requests out)** | Fenced `maia-request` drafts → confirm card → Send. Server-side GNAP client for the user: pairwise keys, the interaction hand-off and `/gnap/client/finish/:id`, `instance_id` recognition and Forget, server-side polling. Collected answers sealed to the user's folder key → `Received/`. `maia_origin`. Outgoing rate limits. Drafts and Sent in the Requests tab | The MAIA-symmetry part of §10.11. Live: a member on test.agropper.xyz and a member on a second host request from each other, collect, and find the answers in `Received/` |
| **P12 — Launch** | trustee.ai deploy. Pack authored with test requests. Edition user guide + README section. Live acceptance run (a fresh member through every checklist row, a direct request, a group request, a member request, a software request, a document added, a MAIA-to-MAIA request across two hosts, a digest) | Acceptance checklist signed off on trustee.ai |
| Later | Cross-host payments → vouch on direct requests → requester key recovery → outbound cards (D16) → cross-group credentials (D17) → delegation (UCAN, D18) → MCP facade → RFC 9767 + JWT → transient Spaces → serverless-inference advisor (if D2 changes) → Cedar | Per §10.15 and the security doc §15 roadmap |

---

## 15. Testing and verification

- **Backend (automated):** every phase adds to `tests/backend/`, runs under both editions, and uses the in-memory two-host harness for anything that crosses the registry/member seam. Target: every new invariant I-24…I-33 is covered by at least one named test, as in security doc §14.1.
- **Frontend (manual + CDP harness):** the checklist, Requests tab, confirm screen and request pages are verified by live runs on the test app, following the `Setup_Sequence.md` acceptance-matrix habit: one run per path (with Apple Health / interview / skip PS; sharing on then paused; direct request from a clean browser; group request; member request; a document added with and without an allow card; MAIA to MAIA across two hosts; GNAP self-test).
- **Deploy discipline:** merge → wait for the deploy → check the version banner → test. This avoids the "still broken" reports that were really version skew (`New_User_Flows.md` §4.8).

---

## 16. Risks

1. **Hidden isn't removed.** Dormant code still ships and still runs unless the server gates it. I-26 plus the "403 in edition, 200 in full" tests are the control. P1 should include a route inventory so no unlockable route is missed.
2. **More friction at onboarding.** The adoption work of July (PR-6.5: folder deferred, zero-decision quick start) deliberately removed the folder and passkey from the join path. This edition deliberately puts them back, because a personal AS that has to stay reachable and keep a durable log needs both. Expect fewer, more committed members. That fits the use-case, but it is a real change of direction.
3. **Chrome and desktop only.** File System Access isn't available in Safari, Firefox, or mobile browsers. The folder log only updates while a tab is open. The digest softens this; it can't remove it.
4. **First public inbound AS endpoint.** GNAP opens the surface Groups.md §7.3 kept closed, and group routing adds a public fan-out endpoint. §10.8 covers both. The red-team list in the security doc §14.3 should gain "GNAP enumeration, replay, silence-distinguishability, and roster inference from group answers".
5. **Two editions double the test matrix.** Edition-parameterized backend tests are required, not optional.
6. **The privacy filter becomes more central.** Autonomous release is the point of this edition, and the filter is heuristic (§12.2-2). The confirm screen should show the privacy-filtered PDF next to every allow card that would release it.
7. **Email deliverability.** Digests and immediate emails from a new domain (trustee.ai) need Resend domain verification (SPF/DKIM) before launch.
8. **Host trust.** Members hosted on Trustee's deployment trust Trustee's DO account. This needs plain disclosure (§11).
9. **Requesters must come back.** Answers are collected from a page, not received by email. A clinic used to email attachments will notice. If the requester loses their browser key, pending answers can't be collected (D13). The "answer ready" email and the page's print / save-as-PDF are the mitigation.
10. **More v1 scope.** A single path pulls payments (same host), `group-member` and group vouch into v1, and adds a browser client. P4–P6 are the largest phases. In exchange, the old W3 and relay request code never has to be carried into the edition.
11. **Inbound files are a new attack surface.** A stranger with a verified email can put a file in front of the patient, if the cards allow or the patient previews an offer. The controls are the verified-email floor, type checks by content, size and count caps, never parsing or indexing on the server, and preview only in the browser's built-in viewer. Because a hold is sealed, the server also can't scan it. The patient's own computer is the last line of defense, as it is for email attachments today. If the folder is lost, documents still held can't be opened (§7).
12. **Agents at both ends.** Symmetry means volume can be automated on the requesting side once outbound cards exist (D16), and a requesting MAIA's host holds its users' client keys, so a compromised host can impersonate them. The controls: every decision is made by the answering patient's cards, not by the agents; no reflexes (I-33); outgoing and incoming rate limits; pairwise client keys; Forget; and the host-trust disclosure (§11) applying on both sides. Delegation (later) adds chains of authority; I-34 keeps every decision with the patient's AS.

---

## 17. Decisions needed

| # | Decision | Recommendation |
|---|---|---|
| D1 | Edition name (env value and UI name) | `personal-as` / "Personal AS" (placeholder) |
| D2 | Private AI hosting in the edition | **Reopened (2026-09-23).** Per-user agents cost almost nothing (§12) but are quota-limited per DO account (§12.1), which caps members. Options: (a) one per-user agent started at email verification, with a quota raise from DO support; (b) DO Serverless Inference on a DO-hosted open-weights model for the private AI — no per-member resource, same privacy statement from DO, but no per-user API key and a new non-agent path for drafting the Patient Summary. Per-user agents + KB stay behind `records-index`. Since v1.6.1 the full edition's *secondary* agent is user-chosen (Qwen3.8-Max suggested), so only members who want one use a quota slot |
| D3 | Passkey required at setup? | **Yes** — applied in P2 (a required checklist row). An AS the patient returns to after a digest email must survive a cleared cookie |
| D4 | Where the edition is tested | Switch claude-self (test.agropper.xyz) to `personal-as` **after P2**: through P1 the edition still opens the full edition's setup wizard, whose indexing steps the edition now refuses. P2's setup checklist replaces it |
| D5 | Notification rules (§8.2), digest cadence | Immediate for ask (debounced) + every automatic share. Weekly digest. Monthly heartbeat when quiet |
| D6 | "Tokens" the group sells | Keep calling them **credits** in the UI. "Token" will mean GNAP access tokens in this version |
| D7 | Meaning of "a group posts a public request form to all members' accounts" | **Resolved by D12 (2026-09-24):** both the group request page (every member, through group routing) and a personal request page per member (option (b)), and both are the same GNAP browser client. Option (a), the group itself as a requester, remains possible later as one more GNAP client |
| D8 | GNAP access `type` identifier | `urn:maia:access:record:v1`, or an https URI on a domain you control long-term |
| D9 | Publish this document? | **Decided 2026-09-22: committed** to the public repo (like the security design doc); it contains no strategy content |
| D10 | Folder log format + server retention | `requests.jsonl` + `Request Log.html`; 90 days after decision, pruned only once synced; 365-day cap |
| D11 | PS routes in v1 | Apple Health + interview; other PDFs → offer `records-index` |
| D12 | One request path in the edition | **Decided 2026-09-24: GNAP only.** Request pages are GNAP clients in the requester's browser; the relay carries signed requests and sealed answers (§10.9–10.10); `legacy-requests` is off in the edition |
| D13 | A requester who loses their browser key | v1: **request again** (pending answers can't be collected). Later: re-bind a pending grant to a new key after the same email is verified again (§10.15) |
| D14 | Today's form in the `full` edition (and the demo) emails the artifact (§1.5) | Leave it until you decide whether `full` also moves to GNAP. A smaller interim step would be to stop emailing artifacts to *unverified* addresses in `full` |
| D15 | Rules for adding documents (§10.12) | A verified email is always required. v1 accepts PDF, JPEG, PNG and plain text up to 20 MB. At most 10 holds / 100 MB waiting per patient. The group pack may suggest an `add` card, which arrives unconfirmed |
| D16 | Automatic outgoing requests (outbound cards) in v1? | **No.** In v1 the private AI drafts and the user clicks Send. Outbound cards (`direction: 'out'`) come after launch, once inbound cards have been used for real (§10.13) |
| D17 | How a patient's card trusts *another* group (for example a clinicians' group) | Later. The card pins the other group's registry URL and public key when it is written. If that group rotates its key, the card comes back for review (the I-23 pattern) |
| D18 | Delegation format (§10.13) | **UCAN 1.0** if a maintained JavaScript library exists when this is built; otherwise a small MAIA JSON profile with UCAN's field names and rules. Not ZCAP-LD (JSON-LD canonicalization, and a second HTTP-signature scheme beside RFC 9421) |

---

## 18. Documentation follow-ups (small, can ride P0)

- ~~CLAUDE.md: current line counts; the test suite exists; key files; the edition switch.~~ Done in P0.
- Security design doc: correct §5's `normalizeCard` claim after the P0 fix; update the §14.1 test count; ~~add I-24…I-31 and a GNAP section when P6 ships, including group routing~~ (done in P6b, §6.3; the §1.5 finding still to add), ~~then I-32 and inbound documents when P9 ships~~ (done in P9, §6.3), then I-33 and MAIA symmetry when P11 ships (and regenerate the posted PDF, per the standing rule).
- Groups.md: update the status header; point to the security design doc for work after July.
- ~~Environment.md: current database list; add `MAIA_EDITION`; when OpenSearch is created.~~ Done in P0.
- ~~Policy_Vocab_Changelog.md: the v3 entry (`action`, scope `document`), classified compatible, when P9 ships.~~ (done in P9)
- Fix_Backlog.md: tick the shipped items.
- README: an edition section and a short feature list for the Personal AS edition.
