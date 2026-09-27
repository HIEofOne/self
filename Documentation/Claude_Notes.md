# Working notes for developing MAIA

These are the notes Claude (Anthropic's coding assistant) keeps while working on MAIA with the maintainer, Adrian Gropper. They're published because everything in this repository is public on purpose. They're for anyone, person or AI, who works on the code.

They leave out secrets and anything that would help an attacker: app and droplet identifiers, test addresses, and the details of fixed vulnerabilities. For the repository's instructions, see [CLAUDE.md](../CLAUDE.md). For the Personal AS edition's design and what each phase built, see [group_requests.md](group_requests.md) §14.

## How we work

- **Two repositories.** HIEofOne/self is where development lands: every PR goes there, into `main`. agropper/self mirrors production and is promoted by fast-forward (`git push upstream origin/main:main`) only when the maintainer says so. It is frozen as the demo while the Personal AS edition is built.
- **One short-lived branch per task**, cut fresh from `origin/main` and named `claude/<short-description>`.
  - Never stack a PR on another PR's branch: GitHub doesn't retarget it when the base merges.
  - Never push to a branch whose PR is open: PRs are squash-merged quickly, and late commits are orphaned.
  - Before deleting a branch, check that its tip is an ancestor of `origin/main`.
- **Bump the version with every code change.** The maintainer checks the version shown in the app to confirm new code is live. The pre-commit hook bumps the patch version when `server/` or `src/` files are staged; for parallel PRs, set distinct versions by hand.
- **Check before a PR.** Run `npm run build` (`vue-tsc` fails on things Vite tolerates) and the tests.
- **Stage files by name.** `.claude/settings.local.json` is tracked, but it holds the maintainer's local permission rules: never stage, revert or stash it.
- **Security fixes get minimal PR and commit text.** The repository is public.
- **Some actions stay with the maintainer:** deleting user data, sending email to users, changing production settings, and promoting to agropper/self.

## Hosting

- **DigitalOcean apps:**
  - the test app (test.agropper.xyz, built from HIEofOne/self);
  - production (maia.agropper.xyz, built from agropper/self);
  - trustee.ai, being set up as a group-only host ([Trustee_Host.md](Trustee_Host.md)).
- **Shared infrastructure.** The apps share one CouchDB droplet, one OpenSearch cluster (the code allows one per account) and one Spaces subscription.
  - Each app but production sets `COUCHDB_DB_PREFIX` and `SPACES_BUCKET` (`test_`/`maia-test`, `trustee_`/`maia-trustee`), so their data stays apart. Production sets neither.
  - Never parse the bucket name as a URL.
- **Passkeys.** Hosts under agropper.xyz share one WebAuthn rpID, so user handles are host-qualified (`admin@maia.agropper.xyz`). Never register a bare handle: one host's passkey would evict another's.
- **Redeploy banner.** It appears only for a strictly newer server version. During a rolling deploy an old container can answer `/health`, and that must not look like a downgrade.
- **Cost.** DigitalOcean agents cost nothing while idle and only tokens are billed; OpenSearch is the largest line. Agents are limited by an account quota, though, which caps how many members a host can have. See [group_requests.md](group_requests.md) §12.
- **Email-verification bypass.** `MAIA_EMAIL_VERIFY_BYPASS` exists for testing on the test app only, and should be unset when testing ends. Never set it on production.

## Invariants not to regress

**Accounts and the API**

- The session decides whose account a request acts on (`server/utils/api-guard.js`, which runs before every `/api` route). A route belongs in `PRE_AUTH_ROUTES` only if it carries its own proof. Nothing there may create a session or change data without one.
- Never create a session without proof. The temporary-account cookie is signed.
- Local-development shortcuts use `isLocalDevRequest(req)`, which checks for a non-https `PUBLIC_APP_URL` and a loopback socket, never the Host header.
- Every route is listed in `ROUTE_FEATURES` (`server/edition-routes.js`). A test fails on a missing one.

**Sharing**

- Rules are evaluated in this order: deny, explicit ask, allow, then ask by default. The two evaluators, `server/routes/policies.js` and `src/utils/policyCards.ts`, must agree; a parity test checks them.
- A requester is never told which rule decided. Only privacy-filtered copies leave. With no filtered copy yet, the answer is ask, never an empty share.
- A rule never silently changes meaning. Bumping the policy vocabulary needs a [Policy_Vocab_Changelog.md](Policy_Vocab_Changelog.md) entry. Never remove a value from a rank map while stored rules may use it: an unknown rank fails open.
- In the Personal AS edition:
  - no rule acts until the patient confirms it, and nothing is shared until sharing is on;
  - every request enters through GNAP, and data leaves only from the resource server, to a key-bound token;
  - a MAIA never sends a request just because it received one;
  - the private half of the folder key never reaches the server.
- The AI advises and drafts. The deterministic evaluator and the patient's own clicks are the only deciders.
- Public AIs are listed in the chat's menu but stay locked until the patient turns on Public AIs, and a clinician's guest session sees them only when the patient did. A public AI never gets the private AI's context (summary, rules), only the chat. An image attached in chat stays in the browser, is never saved, and goes only to a model that reads images.
- Credits are prepaid service fees: not refundable, not transferable, not cash.

**Records and the Patient Summary**

- Nothing generates or overwrites the Patient Summary without the patient's consent. Verification is a stamp (`patientSummaryVerifiedAt`) that only the patient's own acts set, and any unverified save clears it.
- In the Personal AS edition, current medications are a section of the summary and are verified with it.
- The MAIA folder is where records live. Never ask the patient to pick a record that is already there. `isMaiaGeneratedFile()` is the one list of files MAIA writes there.
- The secondary private AI is chosen by the user and never created automatically. It never falls back to the primary.

**Storage and logs**

- `saveDocument` upserts and borrows the latest `_rev` when a document has none. Keep the `_rev` you read, or you overwrite someone else's change.
- Never log request bodies: some carry keys.

## Local testing

- **Backend.** Run it against a local CouchDB (Docker, `admin`/`adminpass`, `CLOUDANT_URL=http://localhost:5984` with no credentials in the URL; five failed logins lock the admin out for minutes). Set `DIGITALOCEAN_TOKEN` to an invalid value and leave `RESEND_API_KEY` empty, so no real agents or email are created. Set `MAIA_EDITION=personal-as` for the new edition.
- **Folders in an automated browser.** An origin-private file system handle (`navigator.storage.getDirectory()`), stored as the user's folder handle, stands in for a picked folder.
- **After a backend restart**, `POST /api/temporary/restore {userId}` re-signs a temporary account in the same browser.
- **AI answers without DigitalOcean.** A small OpenAI-compatible mock server, set as a test user's agent endpoint, lets drafts complete locally.
- **supertest:** pass `await serve(app)` (`tests/helpers/serve.js`), not the bare app.
- **Headless Chrome screenshots:** delete the old PNG first, or a failed run leaves the stale file.
- **DigitalOcean model quirk:** Kimi K2.5 needs `temperature=1` and `top_p=0.95`.

## Documents

- [group_requests.md](group_requests.md): the Personal AS edition, its design and a log of each phase.
- [MAIA_Request_Security_Privacy_Design.md](MAIA_Request_Security_Privacy_Design.md): the security baseline and invariants. The PDF in `public/` is an older snapshot, regenerated only when the maintainer asks.
- [Groups.md](Groups.md): how groups were built. [Groups_Design.md](Groups_Design.md) is the design conversation that started them, including adoption strategy, digital twins and payments.
- [Ask_MAIA_Brief.md](Ask_MAIA_Brief.md): the current overview at the head of "Ask about MAIA"'s knowledge pack (the welcome page's box and `/ask`). Update it when something a visitor would ask about changes. The pack also holds a code map built from each file's first comment, so a new file should start with a one-sentence comment saying what it's for, and the PR history, so a PR's first paragraph should say what it changed. The tools read only the allow-listed text files in `server/ask-maia.js`; a new top-level folder needs adding there.
- The diagrams, `public/MAIA_Request_Map.html` and `public/MAIA_Group_Network.html`: update them when a request path changes.
- **The overview slide deck,** `public/MAIA-overview.pdf`, is exported from the maintainer's Keynote master. When generating slides with pptxgenjs, never emit connector lines with a negative width or height; use flipH/flipV instead.
