# Recovery: the origin of a shared container is gone

A share is a **subscription** ([#929](https://github.com/srikanth235/centraid/issues/929)): one vault — the **origin** — holds the container, answers who may read it (`share_authority`), composes the shape and is the single writer. Every audience holds ordinary rows in its own vault, claimed by `share_subscription_lineage`.

This page is what to do when the origin stops answering: lost device, wiped machine, person unreachable.

There is **no ceremony to run**. The commons plane's steward-transfer ceremony — supersession, a fresh genesis chain, re-invitation of every member — was deleted with the rail it belonged to. What replaces it is the model itself: the audience already holds the rows.

## What is true while the origin is silent

| Fact | Why |
| --- | --- |
| Every audience **keeps its copy** | Projected rows are real rows in the audience vault. Only a revocation removes them, and only the origin can revoke |
| Nothing drifts | The origin is the single writer, so a silent origin means no new versions — never a divergence to reconcile |
| Deliveries **queue, they do not fail** | `share_fulfillment` falls back to `syncing` or `awaiting_channel` and the sweep retries. `delivered_at` is durable, so a copy already delivered is remembered as delivered |
| A member's write is **refused, not lost privately** | An `edit` member writes by signed intent to the origin. With no origin to execute it the intent stays queued on the member's seat and is visible there |

Nothing here needs an operator. A returning origin resumes on the next sweep.

## If the origin is gone for good

The container cannot be re-founded in place: the audience's rows are claimed by the shape, and releasing a claim removes the rows rather than adopting them (`releaseShapeRows`, `packages/vault/src/share/subscription-seat.ts`). What a group does instead is start again from a copy that is already on someone's machine:

1. **Pick the new origin.** Any member who holds the projection can be it.
2. **Make it theirs.** Create the container in that vault — a new album, folder or group — and put the copies in it. This is ordinary authoring, not a transfer: the new rows are the new origin's own.
3. **Share it onward.** One standing answer per member, exactly as the first origin did. Members ingest it as a second shape; the old shape's rows stay where they are until someone removes them.

Ledger history (Tally expenses, document revisions) travels with the rows the members already hold, so nothing is reconstructed from an op log — there is none.

## Verify

```
bun run --cwd packages/vault test src/share
```

`subscription-sim.test.ts` is the standing proof of the invariants above: a delivered projection survives a host that loses reach mid-life, and a revocation still severs.
