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
