# External review scope and formal-model note

Centraid's security posture is currently self-asserted. Every claim in [SECURITY.md](../SECURITY.md) is backed by tests this repo wrote about code this repo wrote, judged by the same agents that authored both. That is a closed loop, and the closed loop is the limitation: it can prove internal consistency and it cannot prove the threat model is the right threat model.

Two things break the loop. One is a **paid external review** by people with no stake in the design being correct. The other is a **formal model** of the core invariants, which is an adversary of a different kind — it does not read the code at all, so it cannot inherit the code's assumptions.

Both are blocked here for honest reasons. External review needs money and a third party; a formal model needs a modelling effort measured in weeks, not a slice. What is _not_ blocked is stating precisely what should be reviewed, why that scope and not another, what a reviewer must be handed, and what a model would and would not settle. That is this document. It is the input to the engagement, not a placeholder for it.

## What is already covered, and therefore not what to buy

An external reviewer's time is worth more than re-running gates. These already exist and should be handed over as _evidence_, not commissioned as _work_:

| Covered | Where |
| --- | --- |
| Locker cell AEAD with the `rowId‖keyId` AAD, and the structural ciphertext predicate | [`crates/vault/src/custody/locker_key.rs`](../crates/vault/src/custody/locker_key.rs) and its tests; [custody README](../crates/vault/src/custody/README.md) |
| No Locker plaintext leaves the vault: every byte-returning door, the backup's snapshot ranges (sealed and opened) and the vault file searched for planted plaintext; `K` is the seed's leaf and never on disk | [`crates/vault/tests/locker_plaintext_gate.rs`](../crates/vault/tests/locker_plaintext_gate.rs); `crates/core/src/app_query/locker_tests.rs` |
| The authority plane: deny as an outcome, enrollment as full trust, unknown and revoked as one refusal | [`crates/vault/src/access.rs`](../crates/vault/src/access.rs) |
| No listener anywhere but a gateway's one serve file | `no-listening-socket` in `cargo xtask rules` — a static scan; nothing checks the kernel's socket table at runtime |
| A gateway holds no plaintext, plaintext hash, key, token or pairing secret at rest; it acknowledges only bytes that hash to their digest; its head moves only by compare-and-set; a superseded writer is refused | `crates/gateway`'s conformance suite (the blindness and credential canaries, the fence), run in memory and over the wire |
| The sealed part format: keys, names, framing and refusals | `contracts/crypto/sealed-vectors.json` and the tests in `crates/media/src/sealed.rs` |
| Committed-secret scan and fault injection through the call boundary | the `secrets` and `fault-door` steps of `cargo xtask gate --profile pr`, [TESTING.md](../TESTING.md) |

## Review A — cryptography and peer protocol

**Why this first.** It is the only area where being wrong is unrecoverable. A route-authorization bug is a patch; a key-custody or AEAD-construction bug silently invalidates every vault already written, and there is no server-side re-encryption to fix it with, because there is no server. It is also the area where in-repo testing is structurally weakest: a test can confirm that `encrypt_under_locker_key`/`decrypt_under_locker_key` round-trip and that ciphertext is not plaintext, and cannot confirm that the construction resists an adversary who was not imagined by the person who wrote the test.

**Scope.**

- The sealed-column construction end to end: key derivation, the AAD binding (`seal_aad(physical, column, row_id)`), nonce discipline and reuse resistance under row updates and restores, and whether the AAD binding actually prevents cross-row and cross-column ciphertext substitution.
- Key custody: the 24 words as the root of every vault key (identity, box, root and the Locker `K`, [D-6](decisions.md#the-owners-rulings-of-2026-09-28-1047)), held in the synced keychain and in the core's memory and never in a key file; what a backup or a restore moves and what it deliberately does not, and the failure mode when the seed and the database disagree.
- The backup's sealed part format, `centraid-sealed/2` ([`crates/media/src/sealed.rs`](../crates/media/src/sealed.rs)): the salt-derived part key, the keyed names, the chunk AAD and framing, and what a gateway learns from sizes, part indexes and timing.
- The gateway plane ([gateway.md](gateway.md)): the self-signed certificate the phone pins and what a phone does when an address answers with another; the pairing secret (one use, 24 hours, hash-only at rest) and the bearer token; the writer epoch and the claim signed by the vault's identity key; and what a malicious gateway can cause a phone to do.
- Share-grant revocation as a _security_ property rather than a liveness one, including the pinned defect D1 (see [decisions.md](decisions.md#adversary-lanes-and-provisional-evidence-839)).

**Questions the engagement must answer in writing.** Can a nonce repeat under any sequence of updates, restores and merges? Does the AAD binding survive a schema migration that renames an entity or column? Can a gateway, or anyone holding a gateway's whole data directory, learn which file a part is — beyond its size — or recover any plaintext? Is there any construction here that would fail a standard misuse-resistance review, independent of whether an exploit is demonstrated?

**Out of scope.** Reviewing the choice of primitives if they are standard, UI, and anything covered by the table above.

**Unblock condition.** A signed engagement with a firm that does protocol and applied-cryptography review (not a generic pentest shop), a budget in the low tens of thousands, and a two-to-three week window with the maintainer available for questions. Deliverable: a written report with severity-rated findings and a re-test after fixes.

## Review B — application and authorization security

**Why.** The gate this repo runs is a denial _sweep_: it enumerates declared scopes and asserts the undeclared ones refuse. That proves the policy is enforced as written. It cannot find the case where the policy as written is the wrong policy, or where two correct-in-isolation surfaces compose into an authorization bypass — the class that needs somebody hostile and unfamiliar.

**Scope.** Every door into the vault, with the access plane ([`crates/vault/src/access.rs`](../crates/vault/src/access.rs)) handed over as the intended policy and the reviewer asked to break it: the one surface the phone's shells speak to the core ([`crates/core-ffi`](../crates/core-ffi)), the Locker session inside it (unlock, reveal and seal, [`crates/core/src/locker/phone.rs`](../crates/core/src/locker/phone.rs)), and, for the sealed backup, the gateway protocol the phone dials ([gateway.md](gateway.md)). There is no desktop socket, no browser host, no MCP child and no fill in v0 ([R-1047-D3](decisions.md#the-extension-fill-plane-deleted-1047)). Explicitly including the _composition_ question — can a read-only principal reach an owner effect by chaining two individually-correct calls.

**Questions.** Is there a path from an unauthenticated or device-tier position to any vault read the tier does not own? Does any error, timing or length side channel distinguish "absent" from "refused" where the design says it must not (the roster topology-hiding rule)? Does the experimental feature gate hold on every surface it claims?

**Unblock condition.** A pentest engagement against a maintainer-hosted instance with real data volume, one to two weeks, with the access plane and threat model supplied up front so the time goes to breaking rather than mapping.

## Review C — privacy and egress

**Why.** This is the review that maps to the product's actual promise. The sovereign-vault claim is not a cryptographic claim; it is a claim about where bytes go. The surfaces that can move bytes off-device — the enrichment cascade's `provider` egress class, an assistant turn routed to a third-party harness, and the gateways a phone uploads its sealed backup to — are each governed by different machinery. Nobody outside this repo has checked that those stories add up to the one sentence the product tells users.

**Scope.**

- The egress cascade: whether the E-ceiling rule (only the vault-default layer sets the ceiling; no rule, profile or per-item choice can widen it) actually holds in the implementation, and whether the consent receipts are what a data-protection reviewer would accept as a record.
- Derivative renditions: that `thumb` and `preview` carry no EXIF, XMP or ICC — the vault's own ([`crates/media/src/renditions.rs`](../crates/media/src/renditions.rs)) and the ones the phone's platform decoder renders — since `thumb` is the rendition that is backed up and restored first.
- The Assist OAuth worker's Analytics Engine dataset and the surrounding "keep logs off" rules in [logs.md](logs.md), which are operational discipline rather than an enforced property.
- Store-facing privacy declarations for iOS and Android against what the app actually does.

**Unblock condition.** A privacy counsel or data-protection reviewer, one week, handed this document, `SECURITY.md`, and the decisions file's enrichment sections.

## Formal-model note

A formal model is worth building for exactly the invariants where the failure is a _reachable state_, not a bug in a line of code — because that is the class tests sample and models exhaust. Three qualify. The rest do not, and saying so is half the value of this note.

### M1 — the egress lattice (highest value)

**The invariant.** Egress class is ordered `on-device < gateway < provider`. The vault-default layer sets a ceiling. A scoped cascade of rules, profiles and per-item selections computes an effective class. The claim is **monotonicity**: for every reachable configuration, `effective ≤ ceiling`, and no sequence of edits to rules, profiles or per-item choices can produce an effective class above the ceiling that was in force when consent was recorded.

**Why a model.** This is a lattice property over a configuration space that grows combinatorially in (domains × rules × profiles × scopes). Tests sample it; they cannot cover it. It is also the property whose violation is invisible — nothing errors, a byte just leaves.

**Tool.** Alloy. The state is small and relational (domains, rules, profiles, engines, scopes), the property is a first-order constraint, and Alloy's bounded exhaustive search over small scopes is exactly the right shape. TLA+ would work and costs more; the temporal dimension here is thin.

**What it would prove.** That within the modelled bounds no reachable configuration violates the ceiling, or a concrete counterexample configuration. **What it would not prove.** That the implementation implements the model — that gap is closed by deriving the cascade's test corpus from the model's counterexample generator, not by the model alone.

### M2 — the share-grant fulfillment state machine

**The invariant.** A grant's fulfillment state and the audience vault's actual holdings do not diverge in the direction the copy does not warn about: the owner is never told a share is gone while the projection is still held.

**Why a model.** Defect D1 (already pinned) is exactly this, and it was found by a simulator that happened to reach one schedule. A model of the state machine — `pending → syncing → delivered`, with revocation reading that state, and with the peer reachable/unreachable per pass — enumerates every interleaving instead of sampling them. The pinned defect is the strongest possible argument for building this model: the class is real and demonstrated, and the current adversary found one member of it by luck.

**Tool.** TLA+ with TLC. This one _is_ temporal — the property is about sequences of transitions under an adversarial scheduler, which is TLA+'s home ground.

**What it would prove.** Whether D1 is a single bug or an instance of a family, and whether the proposed fix (the engine remembering what it delivered) is sufficient or merely narrows the window.

### M3 — the sealed-column read boundary

**The invariant.** Every read path yields either the placeholder or a receipted reveal; there is no third outcome, and no path yields plaintext without a receipt.

**Why a model, and why it ranks third.** The Locker plaintext gate (`crates/vault/tests/locker_plaintext_gate.rs`) already searches every byte-returning door for planted plaintext, and the access plane has no reveal judgement at all: a Locker cell opens only in the core's Locker session, after `locker.reveal_receipt` ([R-1047-D2](decisions.md#the-sealedv1-cell-layer-and-the-retired-locker-generation-deleted-1047)). The model's marginal value is limited to proving the _enumeration_ is complete — that the set of read paths is closed — which is a code-structure question a model expressed over an abstract path set cannot answer honestly. Build it only after M1 and M2, and only if a surface is ever found that the registry missed.

### Explicitly not worth modelling

- **Redaction.** The property is "no sensitive substring appears in the output", which is a property of string data and pattern rules, not of reachable states. A model would restate the rules, not challenge them.
- **Door enumeration.** The command catalogue and the FFI's request kinds are closed enumerations; a model would encode the same list twice.
- **Protocol version refusal.** One comparison, no state space.

## Sequencing

Review A first (unrecoverable failure class), then M1 (largest untested space, and its counterexamples feed the enrichment corpus), then Review C (the product's actual promise), then M2, then Review B. M3 stays deferred.

## Related

- [SECURITY.md](../SECURITY.md) — threat model and the automated gates
- [decisions.md](decisions.md) — the egress, sharing and adversary-lane rulings
- [TESTING.md](../TESTING.md) — lane placement for anything a review adds
- [logs.md](logs.md) — the operational rules Review C examines
