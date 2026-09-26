# Policy Vocabulary Changelog

Every change to the policy vocabulary (the axes and values of
`POLICY_MATRIX`, the signature ladder, the scope lattice) gets an entry
here **before** `POLICY_VOCAB_VERSION` is bumped (the constant lives in
`server/routes/policies.js` and `src/utils/policyCards.ts`, parity-tested).

Each entry classifies its changes:

- **compatible** — pure addition at the edge of an axis; no stored card's
  extension changes.
- **narrowing** — stored cards can only match *fewer* requests than
  before; safe direction, migrate silently.
- **consent-affecting** — a stored card could match requests its author
  never decided about (level removal/reorder, lattice edits, purpose
  splits). Requires a stated per-card migration rule; when equivalence
  can't be proven mechanically, the card is queued for the patient's
  review and **fails closed to ask** until reviewed. A card must never
  silently change meaning (invariant I-6/I-23, design doc §15.6).

---

## v3 — 2026-09-26 (app v1.6.35)

- **Added** the card element `action`, with values `read` and `add`, and the
  scope value `document`, which pairs only with `add` (and `add` only with
  `document`). *Compatible.* A card without `action` means `read`, exactly
  as before, and matching requires the card's action to equal the
  request's, so no stored card changes its extension and none of them can
  accept an add (I-32). Read requests carry no action and are matched as
  before; `document` is a new, exact-match point in the scope lattice that
  no read scope covers.
- `normalizeCard` refuses an add card that asks for no identity check:
  adding always needs at least `verified-email` (D15). It stamps an add
  card edition 3 at least; every other card keeps the edition it was
  stamped with.
- `policySentence` / `sentenceFor`: "Anyone with verified-email identity or
  stronger may add documents to my MAIA for clinical use."
- The older request paths (the full edition's form and relay) accept only
  the read scopes (`READ_SCOPES`), so they behave exactly as before.

## v2 — 2026-08-09 (app v1.5.173)

- **Removed** signature level `npi` from the authorable vocabulary
  (matrix cell, option lists, advisor prompts). *Consent-affecting
  removal.* Migration rule: legacy stored cards requiring `npi` keep
  their rank (above `verified-email`/`group-member`, equal to
  `doximity`, below `verified-by-me`) and remain accepted by
  `normalizeCard`, so they stay strictly unsatisfiable and editable.
  Rationale: dropping a level from the rank maps would make
  `SIGNATURE_RANK[e.signature]` undefined and the card would match
  **every** request — a removal must never weaken the card it strands.
  `normalizeCard` stamps any card still using `npi` as edition 1.

## v1 — baseline (through app v1.5.172)

The original vocabulary as shipped with the policy matrix (PR #276–#295):
scopes `notification-only | meds-allergies | patient-summary |
not-sensitive | everything | ah-category` with the downward-subsumption
lattice; purposes `any | peer-support | clinical | research |
public-health | marketing`; signatures `unverified < verified-email <
group-member < npi = doximity < verified-by-me`; payments `none |
spam-deposit | notification-deposit | ai-prepay | sharing-payment`;
actions `deny-silent | deny-respond | ask | respond`. Cards without a
`vocabVersion` stamp are edition-1 cards by definition.
