# Trap: WAL / checkpoint vault copies

## What goes wrong

Copying `vault.db` (and `journal.db`) with `cp` while SQLite is in WAL mode, or checkpointing from the wrong process, produces a **torn or incomplete** copy. Backup/restore then "succeeds" with corrupt or stale data. Autocheckpoint from a second connection can also force expensive full base re-uploads in the shipper.

## Invariants (code)

- Vault DBs open with **`PRAGMA wal_autocheckpoint = 0`** — the **shipper is the sole checkpointer** (TRUNCATE-only path). See `packages/vault/src/db.ts`, `packages/vault/src/gateway/custody.ts`.
- Sealing keys live under `keys/` **outside** backup scope — a naive directory copy may miss or incorrectly include them.
- Product restore is **side-directory** only; adopt is a separate step (`recover` / backup admin). Never "fix in place" over a live vault.

## How agents get it wrong

1. **`cp vault.db vault.db.bak` while the gateway is running** — WAL frames not in the main file; restore is incomplete.
2. **Copying only `vault.db` without `journal.db` / WAL sidecars** when the process was not cleanly checkpointed.
3. **Calling checkpoint APIs as non-owner** or from a random script — custody refuses or fights the shipper.
4. **Treating filesystem snapshot of a live dataDir as a backup product** — use `backup` / `recover` paths (`packages/gateway` backup service, `@centraid/backup`).
5. **Deleting `gateway-logs` or enrollment files** thinking they are WAL — different subsystem ([logs.md](../logs.md)).

## Safe patterns

| Goal | Do |
| --- | --- |
| Product backup | Backup policy + provider / CLI backup verbs |
| Blank-machine recovery | `recover` + recovery kit ([recovery/backup-restore.md](../recovery/backup-restore.md)) |
| Dev fixture | Stop gateway; use backup export or test-kit helpers; or copy only from a **closed** DB after checkpoint |
| Tests | `@centraid/test-kit` temp vaults — never the developer's live vault |

## Related

- `packages/vault/src/db.ts` — WAL pragmas
- `packages/backup/README.md`, `FORMAT.md`
- [recovery/backup-restore.md](../recovery/backup-restore.md)
