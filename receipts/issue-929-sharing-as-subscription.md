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
