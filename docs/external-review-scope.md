# External review scope and formal-model note

Centraid's security posture is currently self-asserted. Every claim in
[SECURITY.md](../SECURITY.md) is backed by tests this repo wrote about code
this repo wrote, judged by the same agents that authored both. That is a
closed loop, and the closed loop is the limitation: it can prove internal
consistency and it cannot prove the threat model is the right threat model.

Two things break the loop. One is a **paid external review** by people with
no stake in the design being correct. The other is a **formal model** of the
core invariants, which is an adversary of a different kind — it does not read
the code at all, so it cannot inherit the code's assumptions.

Both are blocked here for honest reasons. External review needs money and a
third party; a formal model needs a modelling effort measured in weeks, not
a slice. What is *not* blocked is stating precisely what should be reviewed,
why that scope and not another, what a reviewer must be handed, and what a
model would and would not settle. That is this document. It is the input to
the engagement, not a placeholder for it.

## What is already covered, and therefore not what to buy

An external reviewer's time is worth more than re-running gates. These
already exist and should be handed over as *evidence*, not commissioned as
*work*:

| Covered | Where |
| --- | --- |
| Sealed-column confidentiality across storage, SQL, export, ledger, FTS, replica, backup and provider context | T3 canary in `tests/quality/user-facing-qualities.test.ts` |
| Every HTTP prefix classified fail-closed at boot | T4 in the same file, `packages/server/src/routes/route-security.ts` |
| Bundled-manifest scope denial, including a closed refusal grammar and property fuzz | `packages/server/src/serve/manifest-scope-denial.*.test.ts` |
| Bearer tokens and seal keys never echoed on error paths | `packages/server/src/serve/secret-log.smoke.test.ts` |
| Diagnostics/support-bundle redaction against a seeded multi-class sentinel corpus | `tests/quality/diagnostics-redaction-canary.test.ts` |
| Prompt-injection corpus, hostile-peer harness, DAST sweep, parser fuzz | the #842 adversary lanes, [TESTING.md](../TESTING.md) |

## Review A — cryptography and peer protocol

**Why this first.** It is the only area where being wrong is unrecoverable.
A route-authorization bug is a patch; a key-custody or AEAD-construction bug
silently invalidates every vault already written, and there is no server-side
re-encryption to fix it with, because there is no server. It is also the area
where in-repo testing is structurally weakest: a test can confirm that
`sealValue`/`unsealValue` round-trip and that ciphertext is not plaintext,
and cannot confirm that the construction resists an adversary who was not
imagined by the person who wrote the test.

**Scope.**

- The sealed-column construction end to end: key derivation, the AAD binding
  (`sealAad(entity, column, rowId)`), nonce discipline and reuse resistance
  under row updates and restores, and whether the AAD binding actually
  prevents cross-row and cross-column ciphertext substitution.
- Seal-key and identity-seed custody: the `keys/` sibling directory, the
  OS keystore envelopes, what a backup or a `centraid-gateway recover` moves
  and what it deliberately does not, and the failure mode when custody and
  database disagree.
- The peer plane: Iroh `EndpointId` binding, the pairing ceremony, ticket
  lifetime and replay, and what a malicious peer can cause a host to do.
  The in-repo hostile-peer harness models a peer that misbehaves within the
  protocol; a reviewer should model one that does not.
- Share-grant revocation as a *security* property rather than a liveness
  one, including the pinned defect D1 (see [decisions.md](decisions.md#adversary-lanes-and-provisional-evidence-839)).

**Questions the engagement must answer in writing.** Can a nonce repeat
under any sequence of updates, restores and merges? Does the AAD binding
survive a schema migration that renames an entity or column? Can a paired
peer that is later revoked recover any plaintext it did not already hold?
Is there any construction here that would fail a standard misuse-resistance
review, independent of whether an exploit is demonstrated?

**Out of scope.** Reviewing the choice of primitives if they are standard,
UI, and anything covered by the table above.

**Unblock condition.** A signed engagement with a firm that does protocol
and applied-cryptography review (not a generic pentest shop), a budget in
the low tens of thousands, and a two-to-three week window with the
maintainer available for questions. Deliverable: a written report with
severity-rated findings and a re-test after fixes.

## Review B — application and authorization security

**Why.** The gate this repo runs is a denial *sweep*: it enumerates declared
scopes and asserts the undeclared ones refuse. That proves the policy is
enforced as written. It cannot find the case where the policy as written is
the wrong policy, or where two correct-in-isolation surfaces compose into an
authorization bypass — the class that needs somebody hostile and unfamiliar.

**Scope.** The gateway HTTP surface as a whole, with the route-security
registry handed over as the intended policy and the reviewer asked to break
it: control vs device session isolation, the owner-tier recovery doors, the
web PWA's cookie and origin binding, service-worker wake paths, the
extension's message channel, and the assistant turn stream. Explicitly
including the *composition* question — can a device-tier caller reach an
owner-tier effect by chaining two individually-correct endpoints.

**Questions.** Is there a path from an unauthenticated or device-tier
position to any vault read the tier does not own? Does any error, timing or
length side channel distinguish "absent" from "refused" where the design
says it must not (the roster topology-hiding rule)? Does the experimental
feature gate hold on every surface it claims?

**Unblock condition.** A pentest engagement against a maintainer-hosted
instance with real data volume, one to two weeks, with the route-security
registry and threat model supplied up front so the time goes to breaking
rather than mapping.

## Review C — privacy and egress

**Why.** This is the review that maps to the product's actual promise. The
sovereign-vault claim is not a cryptographic claim; it is a claim about
where bytes go. Three surfaces can move bytes off-device — the enrichment
cascade's `provider` egress class, the mobile real-map basemap traffic, and
the support bundle this slice built — and each is governed by different
machinery. Nobody outside this repo has checked that the three stories add
up to the one sentence the product tells users.

**Scope.**

- The egress cascade: whether the E-ceiling rule (only the vault-default
  layer sets the ceiling; no rule, profile or per-item choice can widen it)
  actually holds in the implementation, and whether the consent receipts are
  what a data-protection reviewer would accept as a record.
- The support bundle: whether the redaction model in
  `packages/server/src/serve/diagnostics-redaction.ts` is adequate for an
  artifact a user may attach to a public issue, and specifically the two
  residuals its own header records — a short low-entropy unquoted value in a
  log line, and a credential stored under a key whose name is not
  secret-shaped.
- The Assist OAuth worker's Analytics Engine dataset and the surrounding
  "keep logs off" rules in [logs.md](logs.md), which are operational
  discipline rather than an enforced property.
- Store-facing privacy declarations for iOS and Android against what the app
  actually does.

**Unblock condition.** A privacy counsel or data-protection reviewer, one
week, handed this document, `SECURITY.md`, the decisions file's enrichment
and cartography sections, and a generated support bundle from a real vault.

## Formal-model note

A formal model is worth building for exactly the invariants where the
failure is a *reachable state*, not a bug in a line of code — because that
is the class tests sample and models exhaust. Three qualify. The rest do
not, and saying so is half the value of this note.

### M1 — the egress lattice (highest value)

**The invariant.** Egress class is ordered `on-device < gateway < provider`.
The vault-default layer sets a ceiling. A scoped cascade of rules, profiles
and per-item selections computes an effective class. The claim is
**monotonicity**: for every reachable configuration, `effective ≤ ceiling`,
and no sequence of edits to rules, profiles or per-item choices can produce
an effective class above the ceiling that was in force when consent was
recorded.

**Why a model.** This is a lattice property over a configuration space that
grows combinatorially in (domains × rules × profiles × scopes). Tests sample
it; they cannot cover it. It is also the property whose violation is
invisible — nothing errors, a byte just leaves.

**Tool.** Alloy. The state is small and relational (domains, rules,
profiles, engines, scopes), the property is a first-order constraint, and
Alloy's bounded exhaustive search over small scopes is exactly the right
shape. TLA+ would work and costs more; the temporal dimension here is thin.

**What it would prove.** That within the modelled bounds no reachable
configuration violates the ceiling, or a concrete counterexample
configuration. **What it would not prove.** That the implementation
implements the model — that gap is closed by deriving the cascade's test
corpus from the model's counterexample generator, not by the model alone.

### M2 — the share-grant fulfillment state machine

**The invariant.** A grant's fulfillment state and the audience vault's
actual holdings do not diverge in the direction the copy does not warn
about: the owner is never told a share is gone while the projection is still
held.

**Why a model.** Defect D1 (already pinned) is exactly this, and it was
found by a simulator that happened to reach one schedule. A model of the
state machine — `pending → syncing → delivered`, with revocation reading
that state, and with the peer reachable/unreachable per pass — enumerates
every interleaving instead of sampling them. The pinned defect is the
strongest possible argument for building this model: the class is real and
demonstrated, and the current adversary found one member of it by luck.

**Tool.** TLA+ with TLC. This one *is* temporal — the property is about
sequences of transitions under an adversarial scheduler, which is TLA+'s
home ground.

**What it would prove.** Whether D1 is a single bug or an instance of a
family, and whether the proposed fix (the engine remembering what it
delivered) is sufficient or merely narrows the window.

### M3 — the sealed-column read boundary

**The invariant.** Every read path yields either the placeholder or a
receipted reveal; there is no third outcome, and no path yields plaintext
without a receipt.

**Why a model, and why it ranks third.** The T3 canary already enumerates
the declared surfaces and enforcement points, and the registry-parity
assertions make a new surface fail the suite rather than slip past. The
model's marginal value is limited to proving the *enumeration* is complete
— that the set of read paths is closed — which is a code-structure question
a model expressed over an abstract path set cannot answer honestly. Build it
only after M1 and M2, and only if a surface is ever found that the registry
missed.

### Explicitly not worth modelling

- **Redaction.** The property is "no sensitive substring appears in the
  output", which is a property of string data and pattern rules, not of
  reachable states. The adversarial sentinel sweep is the right adversary
  and it already found four real weaknesses in the rules it tests. A model
  would restate the rules, not challenge them.
- **Route classification.** Already a closed enumeration checked at boot;
  a model would encode the same list twice.
- **Protocol version refusal.** One comparison, no state space.

## Sequencing

Review A first (unrecoverable failure class), then M1 (largest untested
space, and its counterexamples feed the enrichment corpus), then Review C
(the product's actual promise), then M2, then Review B. M3 stays deferred.

## Related

- [SECURITY.md](../SECURITY.md) — threat model and the automated gates
- [decisions.md](decisions.md) — the egress, sharing and adversary-lane rulings
- [TESTING.md](../TESTING.md) — lane placement for anything a review adds
- [logs.md](logs.md) — the operational rules Review C examines
