# Recovery: backup / restore / recover

When backup, restore, or blank-machine `recover` strands mid-flight. Product paths live in `packages/gateway` backup service and `@centraid/backup`.

## Invariants (do not violate while recovering)

| Rule | Detail |
| --- | --- |
| Restore is **side-directory** | Never overwrite the live vault tree in place |
| **Lazy default** | Blobs may fetch on first access; `--full` is explicit |
| **Fencing** | Successful recover adopts with generation bump so the old machine's next register fails (no split-brain) |
| Keys | Sealing keys / recovery kit are outside casual vault copy — need the kit + provider credentials |

## Symptoms

- Restore job stuck in `fetching` / `replaying`
- `recover` failed after partial download
- Two machines both think they are primary
- PITR / WAL replay error
- Disk full mid-restore

## Steps — restore-to-side stranded

1. **Stop** retry storms; note the job id / CLI invocation and logs ([logs.md](../logs.md)).
2. Identify `destDir` — if partial, **delete the incomplete side dir** only after confirming it is not the live vault path.
3. Free disk / fix provider credentials / network.
4. Re-run restore/recover with the same snapshot intent (`--at` / seq if used). Prefer lazy unless you need `--full`.
5. **Adopt** only when the service reports success; do not manually rename half trees into `vault/`.

## Steps — blank-machine `recover` failed mid-phase

Phases (conceptually): `discovering → fetching → replaying → fencing → adopting → warming`.

1. Read gateway logs + any recover progress SSE/UI state.
2. If failure was before **adopting**, retry `recover` with the recovery kit; partial cache may be reused depending on implementation — if unsure, clear the recover staging dir documented by the CLI error, not the provider's remote objects.
3. If failure was **during/after fencing**, treat as high risk of split-brain:
   - Do not start the old machine's gateway against the same vault without maintainer guidance.
   - Prefer completing recover on the new machine; old machine should see registration **409** / fence errors — that is success of fencing.
4. Confirm backup health metrics after adopt (inventory reconcile, seal verify).

## Steps — accidental live-tree copy / cp

1. Do not open the torn copy as production.
2. Prefer provider snapshot + `recover` / restore-to-side from last good snapshot.
3. See [traps/wal-checkpoint.md](../traps/wal-checkpoint.md).

## Steps — provider credentials lost

1. Without recovery kit + provider access, ciphertext is unrecoverable by design.
2. Rotate provider keys only via documented backup settings; update kit if the product stores grant material there.

## What not to do

- `cp -a` live `vault.db` as backup while gateway runs
- Delete remote WAL/snapshot objects to "clean up" a failed restore
- Run two gateways with the same vault id and write traffic after a partial recover

## Related

- ARCHITECTURE — restore/recover summary
- `packages/gateway/src/backup/recover.ts`
- `receipts/issue-439-restore-as-product.md`
