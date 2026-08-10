# Commons fixed-window sync: replacing ack-gated compaction

**Issue:** #731 **Status:** proposed **Owner session:** none

## Goal

Decide whether to replace the steward-side, per-member-cursor-gated compaction of `share_commons_op` with a fixed-window (ring-buffer) retention policy, and if so, scope the deletion. "Done" for this document means a recorded go/no-go with the measurement that would flip it — this is a decision record, not an implementation plan. If the answer is go, the actual deletion becomes its own `docs/refactors/` execution plan.

## Current mechanism

Steward-side state (`packages/vault/src/schema/share-commons.ts:21-108`):

- `share_circle_grant.last_sequence` / `checkpoint_sequence` / `checkpoint_json` — the grant's monotonic op counter, the sequence the last complete snapshot covers, and the snapshot itself.
- `share_commons_op(grant_id, sequence, ...)` — the verbose, signed command log. Rows carry `member_signature` / `signing_vault_id` / `signature_nonce` for replay-nonce dedup (`share_commons_op_signature_replay`).
- `share_commons_replay(grant_id, signing_vault_id, signature_nonce, ...)` — compact record of a signed replay decision, kept forever so a pruned command's nonce can never be re-executed.
- `share_commons_receipt(grant_id, sequence, ...)` — compact outcome history for UI/audit, independent of the verbose op body.
- `share_commons_cursor(grant_id, member_vault_id, sequence, updated_at)` — one logical applied-offset row per `(grant, member vault)`, upserted via `acknowledgeCommonsSeatCursor` (`packages/vault/src/share/commons.ts:423-440`). This is the ack. `docs/protocol.md` ("Commons stream and cursor contract") is explicit that this offset "is not a transport credential and does not authorize a row" — it exists purely to gate compaction.

Compaction (`compactCommonsOperations`, `packages/vault/src/share/commons.ts:445-529`):

1. Runs on a 32-op cadence (`verboseCount < 32` early-return, `commons.ts:456-458`) unless `force`d, so checkpoints don't churn on every command.
2. Computes `expected.n` (current members with a live vault binding) vs. `cursors.n` (members that have ever acked) — a member that has never bootstrapped has no cursor row at all.
3. `laggards = expected.n > 0 && cursors.n < expected.n` — the **never-cursored carve-out**: without it a member that never bootstraps stalls compaction forever (the comment at `commons.ts:486-491` names this as a fix for "the old all-members-advanced gate").
4. `advancedFloor` is the minimum cursor among members that _have_ acked (or `grant.checkpointSequence` if nobody has).
5. `retentionFloor = grant.lastSequence - COMMONS_OP_RETENTION_FLOOR` (256, `commons.ts:376`) — a hard floor so one permanently-stuck laggard can't pin the tail indefinitely either.
6. `through = min(checkpointSequence, laggards ? max(advancedFloor, retentionFloor) : advancedFloor)` — ops up to `through` get archived into `share_commons_receipt` / `share_commons_replay` and deleted from `share_commons_op`.

Bootstrap / catch-up is snapshot+tail already, not full replay (`exportCommonsBootstrap`, `packages/vault/src/share/commons-bootstrap.ts:400-474`; `exportCommonsSyncFrame`, same file `:478-519`): it loads `checkpoint_json` as the base closure, then appends `share_commons_op` rows with `sequence > checkpoint_sequence` as the tail. If any tail row is an executed `command`/`delete`, it rebuilds a fresh full closure instead of trusting the stale snapshot plus tail (`commons-bootstrap.ts:441-454`) — i.e. the snapshot is not append-only safe across arbitrary domain mutations today, only control-only tails are cheaply appliable.

So the protocol has three interacting special cases: the 256-op retention floor, the never-cursored carve-out, and the snapshot-invalidate-on-domain-tail rule. All three exist to make ack-gated compaction terminate under adversarial or absent acks; none of them exist because the ack signal itself is load-bearing for correctness (bootstrap already ignores it and rebuilds from checkpoint+tail).

## Proposal

Keep the last **K** ops in `share_commons_op` unconditionally — a ring buffer, truncated by `sequence`, no member state consulted. Any member whose last-applied sequence is within K of `last_sequence` gets a tail; anyone further behind gets the latest `checkpoint_json` snapshot and re-bootstraps from there, same code path `exportCommonsSyncFrame` already has for laggards today (the `laggards` branch), just unconditional instead of best-effort.

**Delete:**

- `share_commons_cursor` table and its schema block (`share-commons.ts:102-108`).
- `acknowledgeCommonsSeatCursor` (`commons.ts:423-440`) and its call site in `packages/gateway/src/routes/peer-commons-route.ts:160`.
- The `laggards` / `expected` / `cursors` computation and the never-cursored carve-out inside `compactCommonsOperations` (`commons.ts:459-499`).
- `COMMONS_OP_RETENTION_FLOOR` as a _laggard_ concept — repurposed (see K sizing below), not deleted outright.
- The steward-side ack write path — nothing server-side needs to persist "which sequence did member X apply."

**Keep:**

- `share_commons_op`, `share_commons_replay`, `share_commons_receipt` schema and the signed-nonce replay-dedup index — unrelated to member acks, this is steward-side write idempotency, not sync gating.
- `checkpoint_sequence` / `checkpoint_json` on `share_circle_grant` and the 32-op checkpoint cadence in `compactCommonsOperations` — snapshot cadence is orthogonal to retention policy.
- The member-side applied-cursor concept, if one exists in the member's own replica bookkeeping — that's the member deciding "what have I applied," which is a local idempotency concern (`docs/protocol.md`'s "apply only the next sequence after the member's current logical offset" rule), not a steward-side gate. Only the _steward's copy_ of that offset (`share_commons_cursor`) is deleted.
- `exportCommonsSyncFrame` / `applyCommonsBootstrap` and the snapshot-first bootstrap path — this proposal makes it the _only_ path (tail is always bounded by K, snapshot always available), not a new one.

Compaction becomes: on the 32-op cadence, `DELETE FROM share_commons_op WHERE grant_id = ? AND sequence <= (last_sequence - K)`, after (or "at" — see sizing) a checkpoint covering that boundary exists. No member table join, no `laggards` branch, no floor-vs-advancedFloor `min`/`max`.

## Dependency on the hash-chain / signed checkpoint digest work (concurrent)

A parallel effort adds a hash-chain over commons ops and a signed digest over each checkpoint, anchored at snapshot boundaries, with **no optional-field mode** — verification is unconditional, every reader checks it, always. This is a correctness prerequisite for this proposal, not a compatibility concern:

1. A member that re-bootstraps from `checkpoint_json` must verify the checkpoint's digest and re-establish the chain head from it, without needing the discarded verbose ops. Snapshot-first bootstrap already does this today (`commons-bootstrap.ts:429-434` loads `checkpoint_json` directly); fixed-K retention doesn't add a new requirement, it just makes the snapshot-refetch path the common case for laggards instead of the rare one.
2. The one soft spot in today's bootstrap path is `commons-bootstrap.ts:441-454`: it decides whether the stored `checkpoint_json` is still trustworthy by inspecting the _tail_ shape (any executed command/delete forces a rebuild) — a heuristic, not a proof. The signed digest replaces that heuristic with an integrity check the member verifies unconditionally. **Fixed-window retention should not ship ahead of the digest work**: today's snapshot trust is implicit and steward-computed, and turning "the rare laggard path" into "the only path for anyone beyond K" multiplies exposure to a steward that lies about a snapshot. The digest work lands first, or in the same change.

## Sizing K

Two existing constants anchor the choice: the checkpoint cadence is every 32 ops (`commons.ts:458`), and the current retention floor is 256 ops (`commons.ts:376`) — 8 checkpoint intervals. K should stay a multiple of the checkpoint cadence so the truncation boundary always lands on or past a real checkpoint, never mid-interval. `K = 256` — the unchanged floor value, reused as the _only_ retention rule instead of the laggard-only floor — is the conservative starting point: it keeps today's steady-state tail behavior identical for any member already resyncing within the old ack-gated window, and changes one variable (the gating mechanism) at a time rather than also re-deriving the constant.

## Execution outline

Pre-release v0: no dual-run, no bake period, no wire negotiation. The change lands as one straight edit, in this order:

1. Confirm the digest/chain work (prerequisite above) has landed with unconditional verification.
2. In `compactCommonsOperations`, delete the `expected` / `cursors` / `laggards` / `advancedFloor` computation; `through` becomes `min(checkpointSequence, last_sequence - K)`.
3. Drop the `share_commons_cursor` table from `share-commons.ts`; delete `acknowledgeCommonsSeatCursor` and its call site in `peer-commons-route.ts:160`.
4. Any member vault holding a steward-side cursor row under the old schema simply loses it when the table drops. There is nothing to migrate — that member's next sync goes through `exportCommonsSyncFrame`'s existing snapshot-first branch and re-bootstraps from `checkpoint_json`. This is the same path a laggard takes today, just unconditional.
5. Run dogfood instrumentation for one cycle to collect the deciding measurement (below) before treating K=256 as final.

## Risks and the honest counter-argument

The ack protocol is not pure accident — it exists because per-member gating is _strictly better_ for one real case: a **metered or storage-constrained member** (mobile client on cellular data, or a low-power always-behind device) that falls behind by more than K ops under normal, non-adversarial conditions. Under today's scheme, as long as that member acks at all, however slowly, the tail keeps growing to cover it (bounded only by the 256 floor). Under fixed-K, that member unconditionally pays a full snapshot re-fetch every time it falls behind K ops, even if it would have caught up two ops later under the old scheme. For a family/Tally-sized commons the snapshot is small (op-log and closure JSON, not blobs — blobs already travel over CAS sha-dedup per the "byte budgets... deleted with it" note at `commons.ts:366-371`), so the honest read is: this trade is bandwidth-for-simplicity, and the bandwidth side is cheap at this group size. It would stop being cheap if commons groups grow to sizes where the closure JSON itself is large, or if a meaningful fraction of real members are metered-and-often-behind rather than occasionally-behind.

Other risks:

- Losing the "how far behind is this member" signal server-side. Today `share_commons_cursor` is also incidentally useful as an observability source (who's lagging). Fixed-K deletes that. If this signal is wanted for dogfood/support, it needs to move to the member-reported side or a separate lightweight telemetry event, not be reconstructed from deleted state.
- The heuristic-vs-proof gap in `commons-bootstrap.ts:441-454` (see digest section) is a real correctness dependency this plan takes on more heavily. Shipping fixed-K before the digest work would be a regression in blast radius for a compromised/buggy steward, not just a bandwidth trade.

## Go/no-go recommendation

**Conditional go**, gated on two measurements from dogfood instrumentation (`docs/photos-dogfood.md`-style real-usage capture, applied to commons groups) before treating K=256 as final (execution outline step 5):

1. **Op-log size distribution** — is `share_commons_op` row count per grant, in steady state, ever meaningfully larger than 256 for a non-broken member? If yes, K=256 needs to grow, or the case is real and this proposal should stay no-go for those groups.
2. **Member lag distribution** — of real acking members, what fraction ever sit beyond 256 ops behind `last_sequence` for a sustained period (hours, not a single offline nap)? If that fraction is near zero, the never-cursored carve-out and the floor were already doing all the real work and the ack gating in between was never load-bearing — strong go. If a non-trivial fraction of real (non-power-user) members routinely lag that far — e.g. an infrequently-opened mobile Tally participant — the bandwidth trade is not free and the recommendation flips to no-go, keep the ack gate, and instead simplify by deleting only the never-cursored carve-out (which is the one piece of the current code proven unrelated to the real metered-laggard case).

If both measurements confirm laggards beyond 256 ops are rare and short-lived in real usage, proceed with the execution outline above. Land the digest/chain prerequisite first regardless of this decision, since it strictly improves the existing snapshot-trust heuristic either way.

## Progress log

| Date | Step | PR/commit | Notes |
| --- | --- | --- | --- |
| 2026-08-10 | Decision document written | — | No implementation yet; awaiting dogfood instrumentation data before treating K=256 as final. |
| 2026-08-10 | Both go/no-go measurements instrumented and wired into the gateway | #731 | `commonsObservabilityForVault` (`packages/gateway/src/serve/commons-observability.ts`) computes `opLog` (row count, last/checkpoint sequence, rows beyond checkpoint — measurement 1) and `memberLag` (max/p50 ops behind, count beyond the K=256 window — measurement 2) per grant. Read them at `GET /centraid/_gateway/diagnostics` (`config.commons`) or `GET /centraid/_gateway/commons/recovery`; see [docs/logs.md](../logs.md#commons-sync-observability-731). Still no dogfood data collected — this is the instrumentation the execution outline's step 5 needs, not the measurement itself. |

## Rejected alternatives

| Idea | Why rejected |
| --- | --- |
| Drop only the never-cursored carve-out, keep full ack gating | Leaves the more complex `laggards`/`advancedFloor`/retention-floor interaction in place; doesn't address the core ask (delete the ack protocol), and the carve-out alone isn't the part costing the most complexity. |
| Make K adaptive (per-grant, based on observed member behavior) | Reintroduces per-member state and a feedback loop — exactly the complexity this proposal is trying to delete. A fixed constant, revisited by measurement, is simpler and matches how `COMMONS_OP_RETENTION_FLOOR` already works. |
| Ship fixed-K before the checkpoint digest/chain work | Rejected in the execution outline above: turns an unverified snapshot-trust heuristic into the load-bearing path for every laggard, not just the rare case. |

## Out of scope

- The blob/CAS retention and dedup mechanism — unaffected, already separate from the op-log per `commons.ts:366-371`.
- Member-side applied-cursor / replica bookkeeping semantics — unchanged, this document only concerns the steward's copy of that state.
- The chain/digest design itself — referenced as a dependency, not specified here.
- Any change to `share_commons_op`'s signed-replay-nonce dedup — unrelated to member-ack gating.
