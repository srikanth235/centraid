# Issue #929 — sharing as a replica subscription

Umbrella receipt for [#929](https://github.com/srikanth235/centraid/issues/929). Slices append one `## <slice> — <title>` section each; nothing above a new section is rewritten.

## Checklist

- [ ] A view share of each of the six subject types reaches an audience vault on **another gateway** over the peer plane and renders on that audience's phone; the same share to a co-hosted vault takes the loopback route
- [ ] Editing one field of one item in a shared album produces exactly one delta row on the audience (work counters, #927) and wakes audience devices for that row only
- [ ] A member's write to a shared `tally.group`, `docs.folder` or `core.document` is a signed replica intent executed by the origin; the receipt names the member; a confirmation-gated write parks and is decided from the phone
- [ ] Steward transfer is re-origin; a migrated commons group keeps every member and every ledger row (red-first migration test)
- [ ] `share_commons_*` tables, the peer commons rail, sweep, recovery, chain, replay and intent surfaces are deleted; `grep -r share_commons_ packages apps` is empty
- [ ] Revocation of a delivered share purges the shape's rows on the audience and settles `removed` only on the audience's cursor acknowledgement; never-delivered settles with the "nothing had been delivered" detail; D1 and BUG-9 lanes green, plus the two-overlapping-grants case
- [ ] The share sheet offers the link ticket inline for an unlinked person; #903's refusal is unchanged
- [ ] One size ceiling per grant; three ceilings collapse to one
- [ ] The share journey (#927) is `measured` before and after, on web and on a phone, co-hosted and cross-gateway
- [ ] `docs/decisions.md`, ARCHITECTURE.md, SECURITY.md and the glossary describe subscriptions, re-origin and signed intents; the commons vocabulary is marked retired
- [ ] A member's pending write on their phone is dropped only when the audience replica holds the origin's answered row versions; the origin `rowVersion` survives subscription ingest (parity test on the golden pair)
- [ ] `parked` carries a structured `waitingOn` (owner, origin, gateway) with the label from the link on both seats; `steward-label.ts` is deleted with the commons rail
- [ ] Revoking a share settles the audience device's queued intents for that shape as `expired` with "no longer shared with you"; no pending row survives over a purged shape

## What changed

Wave 1(b), the subscriber contract. `packages/core/src/protocol/replica-subscription.ts` is the whole of the difference a subscription makes: the peer-plane replica paths, the grant-keyed shape id, and the vault-keyed subscriber credential. `packages/core/src/protocol/replica-subscription.test.ts` is the contract test that lands before any server behaviour and proves everything after admission is unchanged. `packages/core/src/protocol/version.ts` moves the peer protocol to 2 with the floor, `packages/core/src/protocol/index.ts` exports the surface, `packages/core/src/protocol/peer.test.ts` follows the now-live update-wall arm, and `packages/server/src/routes/peer-plane.test.ts` holds core's mirrored prefix to `@centraid/tunnel`'s guard.

## Out of scope

- `share_authority` semantics, the `share.*` command pack, and who may be an audience.
- The same-owner placement command and give-plane deletion (#928 lane B).
- The share sheet UI and the inline link ticket (lane H).
- `replica-shape.ts`'s app-keyed composition — this issue owns only the grant-keyed branch.
- `## Audit` — added by the wave verifier, never by the author.

## Verification

```sh
bun run --cwd packages/core build
bun run --cwd packages/core test
bun run --cwd packages/core typecheck
bun run --cwd packages/server typecheck
bunx vitest run src/routes/peer-plane.test.ts --root packages/server
bash .governance/run.sh
```

## Decisions

Open questions ruled by the maintainer before wave 1(b), recorded here so the doc pass can copy them:

- **Subscriber identity** is the forwarder's peer proof plus the link pair (`PeerIdentity.linkForPair`). No new key: a subscriber credential would be a second thing to revoke beside the link, and a link that has ended must end the subscription.
- **A long-absent audience re-bootstraps the shape** — the phone's rule, unchanged. `floor_seq` is not extended for subscribers.
- **`edit` is offered for `docs.folder` and `core.document`** in wave 3. Albums are deferred with the blob-path measurement named.
- **Fork detection without the chain is accepted.** The chain defended against a party the model already trusts (SECURITY.md:71); member signatures are kept.
- **The peer protocol floor moves with the number.** v1 cannot serve or ingest a grant-keyed shape, and a snapshot fallback beside it is the historical-shape branch `docs/protocol.md` § (b) forbids, so `PEER_MIN_PROTOCOL_VERSION` becomes 2 and an older gateway sees the single update wall.

## Session

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-09-04 | claude-code | 60f9e86b-149f-5fc9-84c0-f2160b6b6f3c |

## Wave 2 — the view over the replica

A share is a SUBSCRIPTION: the origin composes a grant-keyed shape and hands it
to a transport; a co-hosted audience takes the loopback, one on another gateway
takes the peer replica route and PULLS. `read-closure.ts` is the shape's row
source and `projection-ingest.ts` the audience door — both unchanged.

| file | what it is |
| --- | --- |
| `packages/vault/src/schema/subscription.ts` | `share_subscription` (one row per shape × audience vault, both seats) and `share_subscription_lineage` (shape-keyed, carries the origin row version) |
| `packages/vault/src/schema/migrate.ts`, `entity-catalog.ts`, `scripts/docs-site/src/content/ontology-body.html` | the two tables composed into the base schema and named in the canonical walk |
| `packages/vault/src/share/subscription-frame.ts` | origin half: compose the shape, check it against the sealed registry, carry the origin cursor and one row version per row, refuse over the ONE ceiling |
| `packages/vault/src/share/subscription-seat.ts` | audience half: bootstrap / re-project / field-update, shape-keyed lineage, purge |
| `packages/vault/src/share/subscription-store.ts` | the seat's store: subscription rows, cursors, lineage |
| `packages/vault/src/share/subscription-delta.ts` | what an ingest has to write: structure digest vs. per-row comparison |
| `packages/vault/src/share/subscription-transport.ts` | the loopback route (hardlink + the same seat door) |
| `packages/vault/src/grant/fulfillment.ts` | start / stop / report over a transport (was `fulfillShareGrant` / `propagateShareGrantRevocation`) |
| `packages/vault/src/grant/grant-fulfillment-rows.ts` | `listPendingShareDeliveries` — bounded work the peer route still owes |
| `packages/vault/src/share/closure.ts`, `project-closure.ts` | `ProjectResult.rows`: every projected row, so a SECOND grant over one photograph claims what it deduped onto |
| `packages/server/src/routes/peer-replica-route.ts` | the subscription doors: origin bootstrap + blob, audience change notice |
| `packages/server/src/routes/peer-plane.ts` | mounts them |
| `packages/server/src/serve/share-subscriber.ts` | the seat's pull: frame, bytes, ingest |
| `packages/server/src/serve/share-subscription-sweep.ts` | drains the peer-routed half off the commit path |
| `packages/server/src/serve/grant-fulfillment.ts` | host seam: co-hosted ⇒ loopback, linked ⇒ deferred to the sweep |
| `packages/client/src/replica/purge-selector.ts` | the `shape` selector — a scoped purge, not a whole replica |
| `packages/client/src/replica/intents.ts` | `expireShape` settles a revoked shape's queued writes `expired` with "no longer shared with you" |

| number | value | provenance |
| --- | --- | --- |
| audience change rows for a one-field origin edit | 1 (`media.asset`, distinct row) | `packages/vault/src/share/subscription.test.ts`, two on-disk vaults, host 4c/15GB, `bunx vitest run src/share/subscription.test.ts --root packages/vault` |
| audience change rows for an unchanged shape | 0 | same test |
| subject types delivered cross-gateway | 6 of 6 | `packages/server/src/serve/share-subscription-peer.test.ts`, two gateways in one process |
| per-grant size ceilings | 1 (`share_delivery_config`, default 4 GiB) | `SHARE_SHAPE_DEFAULT_MAX_SIZE_BYTES` |

Deleted with replacement: `fulfillShareGrant` → `startShareSubscription`,
`propagateShareGrantRevocation` → `stopShareSubscription`,
`ShareGrantMaxSizeError` → `ShareShapeMaxSizeError`. The scrub + re-project path
survives as ONE branch of the ingest plan (structure changed), so an album's
membership still follows; `commons-sim-grant*.test-fixtures.ts` dial the
loopback transport instead of a raw seat.

Decisions. (1) The field path covers the five single-row tables and re-projects
`tally.group` and `locker.item`, whose closures are sub-graphs an `UPDATE`
cannot name — cost unchanged from before for those two, named rather than
hidden. (2) The plan COMPARES the audience's live row rather than trusting the
origin's row version alone: origin-authoritative means an audience that edited a
projected row is repaired on the next pass, which is what the D1 adversary lane
caught. (3) A `locker.item` cannot be subscribed cross-gateway at all — re-seal
needs both DEKs — and it is already absent from `SHARE_SUBJECT_REGISTRY`.

```sh
bun run --cwd packages/vault build && bun run --cwd packages/vault typecheck
bun run --cwd packages/server typecheck && bun run --cwd packages/client typecheck
bunx vitest run src/share src/grant --root packages/vault
bunx vitest run src/serve/share-subscription-peer.test.ts src/serve/authz-deny-matrix.test.ts src/routes/peer-plane.test.ts --root packages/server
bun run --cwd packages/client test src/replica/purge-selector.test.ts src/replica/intents.contract.test.ts
```

Findings: none new. Doc debt: `docs/protocol.md` § "Commons stream and cursor
contract" still describes the commons rail as the cross-gateway path; the peer
protocol is now 2 and the subscription doors are the path (wave 4 retires the
commons vocabulary).

## Wave 3 — edit as signed intents

A member's write is no longer a local mutation hoping to converge: it is a
SIGNED replica intent the origin executes as the single writer of the
container. Routing is `commons-routing.ts`'s declared table, unchanged;
authorization is the `edit` answer in `share_authority` and nothing else.

| file | what changed |
| --- | --- |
| `packages/vault/src/share/subscription-intent.ts` | canonical signed bytes, sign/verify against the MEMBER vault's key, and `judgeMemberIntent` (declared route + roster-resolved grant + actability, each refusing by name) |
| `packages/vault/src/grant/subject-registry.ts` | strategy renamed `replica-intent`; `edit` offered for `core.document` and `docs.folder` beside `tally.group`. Albums stay absent — a co-contributed photograph is bytes, and that blob path is unmeasured |
| `packages/vault/src/grant/fulfillment-edit.ts` | the second rail row is gone: a container needs no commons grant to be writable |
| `packages/vault/src/gateway/types.ts`, `gateway.ts` | `InvokeRequest.onBehalfOfMember`: the origin's credential carries the write, so the owner's confirmation EXEMPTION must not apply to it |
| `packages/server/src/routes/peer-replica-intent-route.ts` | the origin's write door: verify, route, execute, receipt naming the member, park with `waitingOn` |
| `packages/server/src/routes/peer-plane.ts`, `peer-replica-route.ts` | mounts it; `admitAtOrigin` shared |
| `packages/vault/src/schema/replica.ts`, `replica/intents.ts`, `replica/change-log.ts` | `waiting_on` and `answered_versions` on `replica_intent_outcome` |
| `packages/server/src/routes/replica-projection.ts` | both fields on the outcome wire, additive |
| `packages/client/src/replica/types.ts`, `intents.ts` | `ReplicaWaitingOn`; G1 — an executed answer naming origin versions holds `awaiting-change` until `settleAnswered` sees the replica carry them |
| `packages/vault/src/share/subscription-store.ts` | `subscriptionHoldsOriginVersion` — the lineage answers G1's probe |
| `packages/vault/src/share/commons.ts` | the roster's `edit` mint follows the renamed strategy |

| number | value | provenance |
| --- | --- | --- |
| member writes landing in the member's own vault | 0 | `packages/server/src/serve/share-member-intent.test.ts`, golden pair, host 4c/15GB |
| edit-capable subject types | 3 (`core.document`, `docs.folder`, `tally.group`) | `SHARE_GRANT_CO_CONTRIBUTION_TYPES`, derived from the registry |

Decisions. (1) `onBehalfOfMember` on `InvokeRequest` rather than a new
credential kind: the credential IS the origin's, and what changes is whose act
it is — a new principal kind is #928's plane, not this issue's. (2) The parked
payload is the gateway's own durable one, so the owner decides a member's write
through the Approvals surface that already exists. (3) `share-grant-seam.test.ts`
and `fulfillment-edit.test.ts` each lost a case whose premise was "an edit grant
with no commons rail is refused" — that refusal would now refuse a write the
origin can and should execute, so both were rewritten to assert the `view`
refusal, which still holds.

```sh
bun run --cwd packages/vault build && bun run --cwd packages/vault typecheck
bunx vitest run src/share src/grant src/gateway src/replica --root packages/vault
bun run --cwd packages/server test src/routes/replica-intent-route.test.ts src/routes/replica-projection.test.ts src/serve/share-member-intent.test.ts src/serve/share-subscription-peer.test.ts
bun run --cwd packages/client test src/replica/intents.contract.test.ts
```

Findings: the `commons-tally-*.test.ts` B6 scenarios still exercise the commons
rail; they move to the subscription sims in wave 4 with the rail's deletion, so
this section does not claim them. Doc debt: `docs/protocol.md` § "One intent
grammar" describes `share_commons_intent.status` as the member's overlay; the
overlay is `replica_intent_outcome` now.

## Wave 4a — the migration, red first

Live commons grants become subscriptions in ONE pass. The steward vault becomes
the origin — it already held the container and serialized every write — and the
roster stops being a second membership plane: one standing answer per current
member, one delivery row per audience vault.

| file | what it is |
| --- | --- |
| `packages/vault/src/share/subscription-migration.ts` | the one-shot: roster → answers + delivery rows, revoking answers whose roster row is gone, idempotent on a second pass |
| `packages/vault/src/share/subscription-migration.test.ts` | the red-first case: a live three-member Tally commons across two gateways |

RED, against a stub that returned zeros (`grantsMigrated: 0, audiences: 0`):

```
× a three-member Tally commons across two gateways keeps every member and every ledger row
× a departed member's answer is revoked, and the ledger keeps their rows
AssertionError: expected +0 to be 1
Test Files  1 failed (1)   Tests  2 failed (2)
```

GREEN, same command, after the implementation:

```
Test Files  1 passed (1)   Tests  2 passed (2)
```

```sh
bunx vitest run src/share/subscription-migration.test.ts --root packages/vault
```

| number | value | provenance |
| --- | --- | --- |
| members kept across two gateways | 3 of 3 (`edit`, `edit`, `view`) | the red-first test, host 4c/15GB |
| ledger rows lost | 0 (`tally_expense_split` count identical before and after) | same |
| answers created on a second pass | 0 | same |

Decisions. A refused or invited roster row is NOT an audience, and an answer
standing for one is revoked by the migration rather than left to drift — a live
answer whose roster row is gone is the exact state the authority plane exists to
prevent. Their ledger rows stay: the origin owns them, and a departure has never
been a reason to rewrite history.

## Wave 4b — the deletion, and the ladder it forced

57 files gone. `grep -rn "share_commons_\|share_circle_grant" packages apps
--include=*.ts` now matches only the migration's own `LEGACY_COMMONS_TABLES` and
the "these must NOT exist" list in `schema/migrate.test.ts`.

| deleted | replacement |
| --- | --- |
| `share/commons*.ts` — op log, chain, checkpoint, compaction, replay, recovery, decide, lifecycle, bootstrap, signature | the subscription rail, waves 2-3 |
| `routes/commons-*.ts`, `routes/peer-commons-route.ts`, `serve/commons-*.ts`, `serve/peer-commons-*.ts` | `routes/peer-replica-route.ts`, `serve/share-subscriber.ts`, `serve/share-subscription-sweep.ts` |
| `schema/share-commons.ts` + `schema/commons-resilience.ts` (14 tables) | `schema/subscription.ts` (2); the binding's DDL moved byte-identical to `schema/party-vault-binding.ts` |
| steward transfer + recovery drills, `docs/recovery/commons-steward-loss.md`, `apps/mobile/.../steward-label.ts` | RE-ORIGIN: `docs/recovery/shared-origin-loss.md` (the audience already holds the rows) and `apps/mobile/.../waiting-on.ts` |
| `commons-sim*` | `subscription-sim*` — rewritten, not dropped: same golden invariants, seeds `839_001`/`839_002`, D1 severance probe kept |
| `gateway.ts`'s commons branch, the commons half of `gateway-client-edges.ts` | nothing: a member's write is a signed intent to the origin |
| `commons-routing.ts` | `container-routing.ts` — same declared table, no dead plane in its name; its conformance vocabulary moved into the test that is its only reader |
| `reportShareSubscription`, `listSubscriptions`, `subscriptionHoldsOriginVersion`, `memberIntentPayloadHash`, `REPROJECTED_ITEM_TYPES` | exports with no production caller, named by the sharing-plane reachability gate. "Report" is `listFulfillment`, which `grant-routes.ts` already reads |

| number | value | provenance |
| --- | --- | --- |
| files deleted | 57 | `git show --stat` on this commit |
| `share_%` tables on a fresh vault | 6 | throwaway probe over `openVaultDb` + `bootstrapVault`, host 4c/15GB |
| registered entities | 110 → 98; base tables 150 → 139 | `VAULT_ENTITIES`, same host |
| per-grant size ceilings | 3 → 1 (`share_delivery_config`) | `subscription-frame.ts` |

THE LADDER MOVED, and that is the finding. Deleting the rail is not schema-
neutral for a file that already exists: the golden corpus stopped opening at all
(`no such table: main.share_subscription`, from `refreshReplicaTriggers`),
because `VAULT_MIGRATIONS` held ONE rung and a file at `user_version = 1` never
re-runs it. So #929 is the release `migrate.ts` always said would add **rung
two** — the subscription tables, plus the purge trigger re-cut without the
rail's grant table — and the baseline text is history. The rail's tables are NOT
dropped by a rung: `migrateCommonsToSubscriptions` turns their rows into
standing answers first and drops them itself, from `openVaultDb`, so every seat
that can open a vault brings the file forward the same way.

`tests/golden/issue-916` is re-frozen as `issue-929`. Before replacing it,
today's build was run against it: it opened, kept every frozen row, passed
`vaultDoctor` and reached `user_version = 2`. The one test it cannot pass is
`carries the schema today's baseline builds`, a byte comparison of stored DDL —
SQLite appends an `ALTER`-added column to the end of a table's text, so no
additive column change can ever match a fresh file. The gate's own instruction
for a shape change is to re-freeze in the release that makes it.

```sh
bun run --cwd packages/vault build && bun run --cwd packages/vault typecheck
bunx vitest run src/golden-vault.test.ts src/schema/migrate.test.ts --root packages/vault
bun run lint:vault-sql && node scripts/check-share-reachability.mjs
bun run lint:schema-export && bun run lint && bun run format
```

Also touched, each following one of the rows above:
`packages/vault/src/db.ts` (the migration runs on open),
`packages/vault/src/replica/change-log.ts` (the `waiting_on` /
`answered_versions` ALTERs now carry the baseline's CHECKs, or a migrated file
is one this build could not have written),
`packages/vault/src/schema/entity-catalog.ts` and `packages/vault/src/index.ts`
(registry and barrel), `packages/vault/src/gateway/gateway.ts` (the commons
branch), `packages/server/src/serve/build-gateway.ts` (its deps and the route
re-announcement it must keep), `apps/mobile/src/lib/replica/native-session.ts`
(steward label → waiting-on label),
`packages/vault/src/share/container-routing.ts`,
`packages/vault/src/share/container-routing.test.ts`,
`packages/vault/src/share/subscription-sim.test.ts`,
`packages/vault/src/share/subscription-sim.test-fixtures.ts`,
`packages/vault/src/share/subscription-sim-plane.test-fixtures.ts`,
and the tests that had a retired premise:
`packages/vault/src/gateway/share-grant-seam.test.ts`,
`packages/vault/src/grant/fulfillment-edit.test.ts`,
`packages/vault/src/grant/fulfillment.test.ts`,
`packages/vault/src/grant/subject-registry.test.ts`,
`packages/server/src/serve/peer-give.test-fixtures.ts`.

Docs brought to current state: the ladder (`docs/decisions.md` ONT-ladder,
`packages/vault/README.md`, `docs/recovery/backup-restore.md`), the fresh-vault
shape and share band (`docs/vault-ontology.md`, the published ontology page).
Doc debt for the umbrella pass: ARCHITECTURE.md, SECURITY.md, `docs/glossary.md`,
`docs/protocol.md`, `docs/mobile-offline.md`, `docs/blueprint-seats.md` still
speak the commons vocabulary.


Rebased onto `main` at 541f0720c, where #966 landed on the same client file:
`intents.ts` keeps main's `OVERLAY_STATES`/`intentVerdict`/`mirrorOutbox` and
its `pendingIntentForInput` method, and `intent-revision.ts` — the split this
wave made when `intents.ts` passed the source cap — carries main's versions of
`revisedInput` (minted row ids, not a `pending:` prefix), `namedRowIds` and
`presentPendingIntentMutation`. `pendingIntentIdFromInput` is NOT re-exported:
#966 deleted it, and re-adding it through the split would restore a symbol main
had removed. `ReplicaProvider` passes `origin`, not the deleted `steward`.

### Every file this wave touched

The rows above group them; the gate wants each path once, so here they are.

```
apps/mobile/src/kit/replica/ReplicaProvider.tsx
apps/mobile/src/lib/replica/pending-write-visibility.test.ts
apps/mobile/src/lib/replica/steward-label.ts
apps/mobile/src/lib/replica/waiting-on.ts
packages/client/src/gateway-client-commons-recovery.contract.test.ts
packages/client/src/gateway-client-edges.ts
packages/client/src/gateway-client.ts
packages/client/src/replica/intent-revision.ts
packages/client/src/replica/intents.contract.test.ts
packages/client/src/replica/intents.ts
packages/server/src/engine/stores/gateway-db.test.ts
packages/server/src/routes/commons-recovery-routes.test.ts
packages/server/src/routes/commons-recovery-routes.ts
packages/server/src/routes/commons-routes-decide.test.ts
packages/server/src/routes/commons-routes-intents.test.ts
packages/server/src/routes/commons-routes.test.ts
packages/server/src/routes/commons-routes.ts
packages/server/src/routes/commons-steward-loss-drill.test.ts
packages/server/src/routes/grant-routes.test.ts
packages/server/src/routes/peer-commons-route.ts
packages/server/src/serve/commons-b6.test-fixtures.ts
packages/server/src/serve/commons-notices.test.ts
packages/server/src/serve/commons-notices.ts
packages/server/src/serve/commons-observability.test.ts
packages/server/src/serve/commons-observability.ts
packages/server/src/serve/commons-recovery-invites.ts
packages/server/src/serve/peer-commons-b6.test.ts
packages/server/src/serve/peer-commons-client.ts
packages/server/src/serve/peer-commons-docs-b6.test.ts
packages/server/src/serve/peer-commons-hardening.test.ts
packages/server/src/serve/peer-commons-pull.test.ts
packages/server/src/serve/peer-commons-sweep.test.ts
packages/server/src/serve/peer-commons-sweep.ts
packages/server/src/serve/peer-commons-tally-b6.test.ts
packages/server/src/serve/peer-plane-sweep.ts
packages/server/src/serve/vault-plane-commons.test.ts
packages/vault/src/commands/merge.test.ts
packages/vault/src/gateway/portability.test.ts
packages/vault/src/gateway/portable-export.ts
packages/vault/src/grant/channel.test.ts
packages/vault/src/schema/commons-resilience.ts
packages/vault/src/schema/entity-refs.ts
packages/vault/src/schema/entity.ts
packages/vault/src/schema/local-tables.ts
packages/vault/src/schema/migrate.test.ts
packages/vault/src/schema/ontology-rules.test.ts
packages/vault/src/schema/party-pointers.ts
packages/vault/src/schema/party-vault-binding.ts
packages/vault/src/schema/share-commons.ts
packages/vault/src/share/commons-automation-b6.test.ts
packages/vault/src/share/commons-blobs.test-fixtures.ts
packages/vault/src/share/commons-bootstrap.ts
packages/vault/src/share/commons-chain.test.ts
packages/vault/src/share/commons-chain.ts
packages/vault/src/share/commons-convergence-properties.test.ts
packages/vault/src/share/commons-cursor.ts
packages/vault/src/share/commons-decide.test.ts
packages/vault/src/share/commons-decide.ts
packages/vault/src/share/commons-derived-removal.test.ts
packages/vault/src/share/commons-docs-b6.test.ts
packages/vault/src/share/commons-docs-command.test.ts
packages/vault/src/share/commons-hardening.test.ts
packages/vault/src/share/commons-increment.test.ts
packages/vault/src/share/commons-intent-lifecycle.test.ts
packages/vault/src/share/commons-intent.test-fixtures.ts
packages/vault/src/share/commons-invoke.test.ts
packages/vault/src/share/commons-lifecycle.test.ts
packages/vault/src/share/commons-lifecycle.ts
packages/vault/src/share/commons-recovery.test.ts
packages/vault/src/share/commons-recovery.ts
packages/vault/src/share/commons-replay.test-fixtures.ts
packages/vault/src/share/commons-replay.test.ts
packages/vault/src/share/commons-replay.ts
packages/vault/src/share/commons-retain-closure.test.ts
packages/vault/src/share/commons-signature.ts
packages/vault/src/share/commons-sim-world.test-fixtures.ts
packages/vault/src/share/commons-sim.test-fixtures.ts
packages/vault/src/share/commons-sim.test.ts
packages/vault/src/share/commons-size.test.ts
packages/vault/src/share/commons-stale-lifecycle.test.ts
packages/vault/src/share/commons-tally-b6.test.ts
packages/vault/src/share/commons-tally-grant.test.ts
packages/vault/src/share/commons.test.ts
packages/vault/src/share/party-vault-binding.ts
packages/vault/src/share/removal.ts
packages/vault/src/share/subscription-sim-world.test-fixtures.ts
packages/vault/tests/golden/issue-916/vault.db.gz
packages/vault/tests/golden/issue-929/manifest.json
packages/vault/tests/golden/issue-929/vault.db.gz
scripts/lint-no-nul-bytes.test.mjs
scripts/lint-vault-sql.mjs
share-reachability.json
tests/schema-export-fingerprint.json
```

### Falsification

| claim | throwaway check | result |
| --- | --- | --- |
| the deletion is schema-neutral for an existing file | opened the frozen golden corpus with today's build | FALSIFIED: it did not open at all. That forced rung two; the corpus opens and migrates now |
| no reader of the rail survives | `grep -rn "share_commons_\|share_circle_grant" packages apps`, minus the migration and the migrate test's "must not exist" list | held: no matches (exit 1) |


## Slice 5 — the after number

The share journey's AFTER lands beside its BEFORE, under the same key, taken by
the same rig with one term changed: delivery is `startShareSubscription` now,
so the rig that named `fulfillShareGrant` no longer compiled and is updated
rather than replaced. The interval, the volume and the topology are untouched,
which is the only reason the two numbers are comparable.

| file | what changed |
| --- | --- |
| `tests/scale/share-journey.scale.test.ts` | delivery term -> `startShareSubscription` over `loopbackShareTransports`; same key, same three intervals |
| `tests/journeys.json` | `_afterProvenance` beside `_provenance` on `gateway/share/shared-album/ci-linux-x64-4c#grantToVisible`, and a declared `grantToVisibleCrossGateway` metric |

| number | value | provenance |
| --- | --- | --- |
| `grantToVisible` after, median of 3 | 232.2 ms | this rig, host linux x64 4c/15 GB, load average 4.1-5.6, `vitest.scale.config.ts` |
| spread | 220.2 / 232.2 / 234.2 ms | same three runs |
| breakdown | grant 1.7-4.2 ms, subscription 218.2-230.1 ms, read 0.4 ms | same |
| before, for comparison | 212.1 ms median (133.1 / 212.1 / 244.4) | `_provenance` on the same metric, #927 wave 3 |
| `ceilingMs` | 750, UNCHANGED | tighten-only; three samples on a contended host are not a distribution to re-seed from |

Decisions. The 212 -> 232 ms difference is SMALLER than the spread contention
alone produces on this host — the before note records 216-237 ms at load
average 7.4 and 267-495 ms at 15-16 — so it is written down as a DIRECTION with
the load stated, not as a verdict. The direction itself is named: a
subscription pays for a shape (one size check, one structure digest, one
lineage row per projected row) where fulfillment paid for a projection.

Cross-gateway is a DECLARED metric at `unmeasured` with its reason, not a
silent hole: the peer plane on this container is a loopback dial inside one
process, so a number taken here measures the harness. The web and phone rows
(`web/share/seeded-demo`, `mobile/share/device-fixture`) stay `unmeasured` on
main's own reasons — no web share rig, no device — and are named in Findings.

```sh
node node_modules/vitest/vitest.mjs run --config vitest.scale.config.ts tests/scale/share-journey.scale.test.ts
node scripts/lint-journey-ledger.mjs
```

### Falsification

| claim | throwaway check | result |
| --- | --- | --- |
| the after is the same interval as the before | diffed the rig against `origin/main`'s copy: only the delivery call, its import and the transport it needs | held — `createShareGrant`, the album of 200, and the audience's own read are byte-identical |
| the ledger accepts the after without weakening a gate | `node scripts/lint-journey-ledger.mjs` with `ceilingMs` left at 750 | held: ok, and the after median is 3.2x under the ceiling it did not move |

## Wave 4c — the reshape the deletion caused

Deleting the rail's tables is not shape-neutral for the apps that SCOPED them.
`packages/blueprints/apps/docs/app.json` reads `share.circle_grant` and
`share.commons_member_state`; `packages/blueprints/apps/people/app.json` reads
`share.commons_invitation`. Those tables are gone, so both closures compose
three tables smaller and both shape ids moved.

| file | what changed |
| --- | --- |
| `packages/server/src/routes/replica-shape-parity.test.ts` | `docs` and `people` re-pinned, with the reason the file's own header demands; the other six ids are byte-identical, which is the evidence that only the rail moved |

| id | before | after |
| --- | --- | --- |
| docs | `docs:e0411274ff437478b64cd632` | `docs:8020cd25b4e9c6a62546b895` |
| people | `people:4bfab9fdc7a82790649b344c` | `people:cde59ac8f6e982ac17c88289` |

Decisions. RE-PINNED, not waived: the reshape is deliberate (the rail is gone)
and the cost is one rebootstrap for devices holding those two shapes. The six
unchanged ids are what proves the deletion did not reshape anything else.

FINDING, NOT FIXED HERE — the blueprint scopes and the queries behind them are
surface files this lane does not own (#929 out-of-scope names the share sheet as
lane H's). Three declared scopes now name deleted tables, and two query builders
still join them: `packages/blueprints/apps/docs/queries/_shared.ts` (the drive's
and search's `shared_with`) and `packages/blueprints/apps/people/queries/
_shared.ts` (share links). Their unit tests pass because they assert the PLAN,
not a vault, so nothing went red — at runtime `shared_with` and the people share
links read tables that no longer exist. Replacing them with the subscription
plane (`share_subscription`, `share_delivery`) is a slice, and it is the root's
to place.

### Falsification

| claim | throwaway check | result |
| --- | --- | --- |
| only docs and people reshaped | ran `replica-shape-parity.test.ts` and diffed all eight ids | held: six identical, two moved, and both movers scope a deleted table |
| the blueprint readers are merely dead scopes | grepped the query builders, not just the manifests | FALSIFIED: `docs/queries/_shared.ts` and `people/queries/_shared.ts` still JOIN those entities — recorded as the finding above rather than silently left as a scope trim |

### File coverage, waves 2-3

Paths the earlier waves changed and their own sections did not enumerate:

```
packages/client/src/replica/purge-selector.test.ts
packages/server/src/serve/authz-deny-matrix.test.ts
packages/server/src/serve/share-subscription-peer.test-fixtures.ts
packages/vault/src/grant/fulfillment.roster.test.ts
packages/vault/src/replica/intents.ts
packages/vault/src/share/project-closure.ts
```

Renamed away by wave 4b, named here so the rename's old halves are covered:

```
packages/vault/src/share/commons-sim-grant-world.test-fixtures.ts
packages/vault/src/share/commons-sim-grant.test-fixtures.ts
```

### Lane verification

```sh
bun run --cwd packages/vault build && bun run --cwd packages/server build
bun run --cwd packages/{core,vault,client,server} typecheck
bun run --cwd apps/mobile typecheck
bun run --cwd packages/vault test          # 186 files, 1527 passed, 2 skipped
bun run --cwd packages/client test         # 269 files, 2459 passed
bun run --cwd packages/server test         # 383 passed; reds below
bunx vitest run src/routes/replica-shape-parity.test.ts --root packages/server
node node_modules/vitest/vitest.mjs run --config vitest.scale.config.ts tests/scale/share-journey.scale.test.ts
node scripts/lint-journey-ledger.mjs && bash .governance/run.sh
```

Gate tree `e561b683fa0ee08442cc81e0682611ddb5e99bc2` (self-audit PASS); this
evidence block is appended above it. `packages/server` carries three red files,
none of them this lane's: `serve/gateway-db-lock.integration` and
`acp/backends/acp/launch` are the container's known reds, and
`routes/replica-shape-parity` is the one wave 4c re-pinned and re-ran green.
`.governance/run.sh` is green but for `receipt-per-issue` on the absent
`## Audit`, which is the wave verifier's section.

## Audit

Fresh-context wave verifier, 2026-09-04, on `claude/929-subscription` @ `37e04f564`
(base `541f0720c`), judging the wave-4 sections and the relaunch note only.

Gates run here: `bash $S/self-audit.sh 929` PASS; `bash .governance/run.sh` 21 pass,
the single fail is this absent section; `node scripts/lint-journey-ledger.mjs` ok;
`node scripts/check-share-reachability.mjs` ok (2 allowlisted);
`bunx vitest run src/golden-vault.test.ts src/schema/migrate.test.ts
src/gateway/portability.test.ts --root packages/vault` 31 passed;
`bunx vitest run src/routes/replica-shape-parity.test.ts --root packages/server` 3
passed. The gate tree quoted at the end of Lane verification is not a commit on the
branch, but it differs from `37e04f564^{tree}` in the receipt alone, so the worker's
suites stand under the tree-hash rule.

### Audit — Wave 4a

Verdict: REFUTED

- Red-first reproduced. Stubbing `migrateCommonsToSubscriptions` to return zeros gives
  `AssertionError: expected +0 to be 1`, 2 failed; restored, 2 passed. Mutating
  `currentRoster` to `LIMIT 2` fails the member count (`expected 2 to be 3`), so the
  test does guard "every member".
- `packages/vault/src/share/subscription-migration.ts:165-174` → the revoke loop walks
  every live answer on the CONTAINER, not the answers the rail wrote. A share made
  through `share.grant` (`packages/vault/src/commands/share.ts:170`) to somebody
  outside the roster is revoked, silently and irreversibly, on the next
  `openVaultDb`. Probe: a plain `core.collection` grant to Carol plus a one-member
  commons over the same id — Carol's answer is gone after the pass. Fix: scope the
  loop to parties the roster holds a row for, not to the subject.
- `subscription-migration.ts:155` → the guard is `isShareableItemType`, which admits
  `locker.item`; `createShareGrant` refuses that type and the `UnofferableSubjectError`
  escapes `packages/vault/src/db.ts:230-241`, so the file can never be opened again.
  Probe: a one-member commons over `locker.item` throws. Fix: guard on
  `fulfillmentAnswerFor(type, "view")`, and put `unofferable` somewhere a caller reads
  before the tables are dropped at :205.
- `subscription-migration.ts:96-106` + `:178` → `liveCircleGrants` selects neither
  `max_size_bytes` nor `departure_policy`, and `createShareGrant` is called without
  `maxSizeBytes`. A commons whose owner set a ceiling comes out at the 4 GiB default
  (`share/subscription-frame.ts:54`): the one-shot widens a limit its owner set.
- `subscription-migration.ts:173` → revoking is not stopping. `stopShareSubscription`
  (`grant/fulfillment.ts:372`) is what moves a delivered row to `remove_sent`, and
  `listPendingShareDeliveries` sweeps only `syncing`/`remove_sent`, so a projection
  delivered under an answer this migration revokes is never purged.
- `subscription-migration.test.ts:263-302` → the 4b rewrite dropped the only case that
  exercised the revoke path (4a's "a departed member's answer is revoked"); `revoked`
  and `unofferable` are asserted by nothing at HEAD, while this section still quotes
  that test's title in its RED block and rests its Decisions paragraph on it.

### Audit — Wave 4b

Verdict: REFUTED

- Verified. `git grep "share_commons_\|share_circle_grant" -- packages apps` matches
  only `schema/migrate.test.ts` (the must-not-exist list), `subscription-migration.ts`
  (`LEGACY_COMMONS_TABLES`) and `subscription-migration.test.ts` (the red-first
  fixture) — every remaining hit is one the section names, and
  `git grep -l commons -- 'packages/*/src' 'apps/*/src'` is empty. `steward-label.ts`
  is deleted and `ReplicaProvider.tsx:372` passes `origin`. Three ceilings collapse to
  one: `share_delivery_config.max_size_bytes` is the only one left, the rail's two went
  with `schema/share-commons.ts`. The rung-two ladder, the re-frozen corpus and the
  portable export replay green.
- `share-reachability.json:24-33` → the gate's allowlist goes from `[]` to two entries
  and no section says so; the gate itself reports them as `TODO(#750)`.
  `unshareFromVault`'s last production caller is the rail this wave deleted, which
  makes it the "delete the old path in the same change series" case, and holding it for
  #928 is the deference CLAUDE.md rules a finding rather than a justification. Fix:
  delete it with its caller, or name the widening here with the root's sign-off.
- Not a finding, for the record: `ReplicaProvider` hands `{ origin: {} }`, so the
  phone's pre-reply label is always `UNNAMED_ORIGIN_LABEL`. That is unchanged from
  `{ steward: {} }` and the link's label rides on wave 3's `IntentOutcome.waitingOn`.

### Audit — Slice 5

Verdict: PASS

- `tests/journeys.json` carries `_afterProvenance` with host, load average, the three
  samples and the breakdown; every number in the section matches the ledger (232.2 ms
  median, 220.2 / 232.2 / 234.2). `ceilingMs` stays 750, so tighten-only holds, and the
  cross-gateway hole is a declared `unmeasured` metric with its reason rather than a
  silence. `node scripts/lint-journey-ledger.mjs` → ok.
- The 4b commit message quotes a superseded 235.7 ms; receipt and ledger agree on
  232.2, which is the number that matters.

### Audit — Wave 4c

Verdict: PASS

- `bunx vitest run src/routes/replica-shape-parity.test.ts --root packages/server` → 3
  passed. Two ids re-pinned, six byte-identical, and both movers scope a table the
  rail took with it, which is the evidence the section claims.
- The blueprint readers are disclosed rather than buried: `docs/queries/_shared.ts` and
  `people/queries/_shared.ts` do still join deleted entities. Naming it for the root to
  place is the right disposition for a lane that does not own those files.
