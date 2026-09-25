# Blueprint seats

Settled **2026-08-05** (Photos v4 design session), restated for the one tree by [#1020](https://github.com/srikanth235/centraid/issues/1020). How the client surfaces differ for the bundled apps, which machinery each app class needs, and the north-star product each app mimics. Cite this file instead of re-deriving the split per app; if a decision is wrong in practice, change it here in the same PR that diverges.

**Why north stars at all:** each app deliberately mimics the most popular incumbent in its category so a member switching to Centraid meets no new mental model. Friction is the enemy; novelty is not a goal. When a design question has no answer in the handoff, the north star's behaviour is the default answer.

## Two axes called "seat"

The word names two different things, and they must not be confused ([glossary.md](glossary.md#hosts-and-clients)):

- **The runtime seat** — **retired** with the replica plane ([#1029](https://github.com/srikanth235/centraid/issues/1029)). There is one core and it holds the vault.
- **The byte seat** — `origin` / `custodian` / `viewer`, the subject of this file. **Collapsed to one** by [#1029](https://github.com/srikanth235/centraid/issues/1029); see below.

Form factor says how wide the window is. The byte seat says where bytes live. They are orthogonal: never branch custody logic on width, and never branch layout on seat.

## The byte seats

> **Superseded, 2026-09-21.** The `origin` / `custodian` split described two devices — a phone where bytes are born and a desktop beside the gateway that holds them. The [scope amendment of 2026-09-21](https://github.com/srikanth235/centraid/issues/1029#issuecomment-5755559795) leaves **one device**: the phone is the vault, it owns its bytes with eviction, and the laptop holds sealed parts it cannot open. There is no custodian console and no viewer. What survives is the shared machinery below, read as the phone's.

|  | **Mobile (KMP: `mobile/`)** — the only seat |
| --- | --- |
| Byte flow | up, when a drain runs; down on demand for an original the member asks for |
| Danger state | bytes the spool still holds that the laptop has not acked |
| Offline means | everything reads and writes; bytes cross later |
| "Free up space" | core feature — release originals with a proved copy on the laptop |

## Shared machinery (build once, per-app never)

1. **One transfer rule per device.** `TransferRule` (`mobile/shared/src/commonMain/kotlin/dev/centraid/shared/sync/TransferRule.kt`) is the member's one setting, because what it governs is a data plan and a phone has one. What each rule admits is `centraid_blobs::Budget::admits_original` (`crates/blobs/src/plan.rs`) and nowhere else; no shell computes any part of it ([mobile-offline.md](mobile-offline.md#background-work-and-push-privacy)).
2. **One byte store per vault, and pins are structural.** `ByteStore::sweep` (`crates/blobs/src/store.rs`) subtracts the bytes a pending upload still needs **before** it orders anything, so a pin is never an eviction candidate, and a store over budget _because of_ pins reports `over_budget_by` instead of breaking the promise.
3. **One durability state.** A surface reads connectivity, durability and pending work from the core's own events, never from a poll ([mobile-offline.md](mobile-offline.md#one-stream-three-occasions)).
4. **Origin acts live on the frame; apps register targets.** The camera roll is `mobile/shared/.../shell/CameraRoll.kt`, and bytes enter the core only through the staging door (`Staging.kt`), so the core names them. Camera, scanner, share-sheet-in, notifications and autofill are frame capabilities an app declares in `seats.originActs` — one door for every app.
5. **The refusal grammar.** Outcomes go to the one status line in the member sentence the producer built ([protocol.md](protocol.md#the-member-sentence-and-its-detail-1015-r-ny-10)); disabled controls are visible, inert at the handler, and explained inline (never a tooltip).
6. **One read path.** Every read is a page (#996, R8), defined once in `crates/apps/kit/src/page.rs`: `PageRequest.limit` is required, the answer carries a `(sort_key, pk)` cursor rather than a `truncated` flag, and `page_statement` (`statement.rs`) is the only assembler, so no two callers can drift into two keyset dialects. A window past the ceiling is clamped, and the clamp is a work-counter fact, never a message.
7. **A write is a local transaction.** The phone is the authority, so there is no overlay, no outbox, no per-app projection to declare and nothing to settle: a command runs against the vault and the row is the answer ([protocol.md](protocol.md#canonical-json-and-where-a-hash-is-taken)).
8. **One concept-scheme vocabulary.** A scheme is matched by its `https://centraid.dev/schemes/…` URI, and a typo there is not a crash but a silently empty shelf; the URIs live beside the queries and commands that use them in `crates/apps/*` and `crates/vault/src/commands`.

## App admission

An app is admitted by these claims, each held by a check rather than by review:

1. **A valid manifest.** `crates/apps/kit/src/manifest.rs` is the one parser: `manifestVersion` is checked first, `_`-prefixed and duplicate handler names are refused, `writes` is required on every action (`[]` still means "no database writes"), and the [designed-states](#designed-states) partition is closed. Each app's own `src/manifest.rs` parses its manifest under it and pins its `seats` block.
2. **No SQL outside the confined crates.** `cargo xtask rules`' `sql-confinement` refuses a SQL literal outside `crates/{ontology,vault,seat,search}` and `crates/apps/kit`, tests included.
3. **Parity with the recorded behaviour.** Each app's `crates/apps/<app>/tests/parity.rs` runs its queries against the fixture bundle in `contracts/apps/<app>/` through `contract_vault::open_contract_vault`.

## Enrichment doctrine

Settled **2026-08-06** (issue #712 C5), amended **2026-08-08** by #725 for the #724 reference service. Product code reaches model work only through host-owned seams:

1. **A delegated harness turn**, dispatcher-gated per call for provider egress (#567).
2. **The device work-lease lane** (`enrich_request.required_capability`) — non-model device work such as poster and PDF-text extraction, bytes never leaving the member's own devices.
3. **Deterministic recognition automations** — bundled handlers own and run their ML implementation and persist typed results through a vault command; the automation engine (`crates/automations`) owns schedule, policy, cursor, ledger, and retry. Model assets may be local to the automation runtime.

No app crate, shell, or automation imports a provider SDK, calls a model service, or uses a generic inference primitive; an app crate depends on `crates/apps/kit` and `serde` only. Apps express intent as rows and consume vault projections.

**The trust-domain boundary.** A member's trust domain is their own devices _and_ their own gateway — the gateway is not, by itself, egress. What IS egress is a harness that talks to a **third-party provider**; every harness shipped today happens to be one, which is a fact about the roster, not a definition. The deciding fact is "does this harness egress to a provider", a property of the harness, never of which machine issued the call.

**One axis, ranked.** `crates/automations/src/fire/enrich_gate.rs` holds the one gate, ordered by how far work may run. There is no `provider` tier: provider egress is enforced per call at the dispatcher (#567) and per capability at the consent gate (decision S9), independently of this tier. An enricher declares the **lane** it needs (`EnrichLane`); the gate is one rank comparison, and every enrich domain (`EnrichDomain`: `photos`, `docs`) declares its enrichers' lanes the same way. `domain` being a closed enum is also why **Locker × enrichment** is unrepresentable.

**The policy cascade (#807).** That per-domain tier is the vault-default layer of a scoped cascade — vault → domain → collection → item (`enrich_policy_rule`). Each level states, per capability, up to three things: `enabled`, the engine `profile`, and the `trigger` (`on-ingest | on-view | on-demand`); `null` is inherit, and the fold is most-specific-wins **per field**. The vault layer carries an **egress-class ceiling** no deeper level can raise. There is ONE gate, and an unreadable policy is a refusal, never a default.

**The ceiling is stored, not chosen (#815).** No per-domain tier control is offered to a member: where enrichment runs is not a member's choice. A capability a stored ceiling stops states that at its own row, in ceiling words. A member's remaining enrichment choices are per capability: on or off, and for the delegate-capable capabilities, which engine reads it.

## Worked example: search is not one behaviour

Where the underlying truth differs by seat, the words must differ with it; where it does not, the words are shared verbatim. The rule "a surface never teaches a different fact about the same control" governs **facts**, not strings. Every seat searches its own replica through the one FTS door ([`crates/search`](../crates/search/README.md)), so a result count says it searched this device's copy, and a replica that may be behind the vault says so on the frame's own line rather than in the search copy.

## Per-app seat profile (machine-readable)

Each app's `manifest.json` carries a `seats` block so coding agents get the split without reading this prose:

```json
"seats": {
  "byteBearing": true,
  "originActs": ["camera"],
  "disabledOn": [],
  "northStar": "google-photos"
}
```

Record-only apps declare `"byteBearing": false` and should fail review if they import custody machinery. The kit's parser does not read this block; each app's `src/manifest.rs` tests pin its values.

### Designed states

Beside `seats`, each app's `manifest.json` carries a `states` block naming which honest states the design calls for:

```json
"states": {
  "designed": ["dayone", "pending", "offline", "stale", "conflict", "parked", "denied"],
  "excluded": []
}
```

The seven ids are the canonical designed states (`CANONICAL_DESIGNED_STATES` in `crates/apps/kit/src/manifest.rs`), and the two sides are a **closed partition**: the parser rejects a manifest that omits a canonical state, claims one on both sides, or lists one twice, so an app can never be silent about a state. `designed` is what the design calls for; `excluded` is what the design makes structurally unrepresentable, and each entry costs a `reason` plus a `citation` (both non-empty). "Nobody has built it yet" is a gap, not an exclusion. History: [#839](https://github.com/srikanth235/centraid/issues/839).
