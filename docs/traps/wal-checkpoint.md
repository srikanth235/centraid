# Trap: WAL / checkpoint vault copies

## What goes wrong

Copying `vault.db` with `cp` while SQLite is in WAL mode, or checkpointing from the wrong process, produces a **torn or incomplete** copy. Backup/restore then "succeeds" with corrupt or stale data. Autocheckpoint from a second connection can also force expensive full base re-uploads in the shipper.

## Invariants (code)

- The vault DB opens with **`PRAGMA wal_autocheckpoint = 0`** — the **shipper is the sole checkpointer** (TRUNCATE-only path). See `packages/vault/src/db.ts`, `packages/vault/src/gateway/custody.ts`.
- The shipper's stream is addressed by **generation**, and each tick writes ONE marker (`wal/tick/{generation}/{tick}`) recording the position the segment stream reached. Restore replays to the newest marker the listing can _prove_ it reached; no marker means the base floor. There is no second database to coordinate with and no pair marker — see `packages/backup/FORMAT.md` for the normative key/nonce/AAD shapes.
- Sealing keys live under `keys/` **outside** backup scope — a naive directory copy may miss or incorrectly include them.
- Product restore is **side-directory** only; adopt is a separate step (`recover` / backup admin). Never "fix in place" over a live vault.
- Fresh bootstrap is the sole pre-shipper exception: after schema/default writes finish, `VaultPlane` truncates the vault's WAL once before attaching the shipper. Since [#916](https://github.com/srikanth235/centraid/issues/916) there is one database file and therefore one WAL — no pair to keep in step. This keeps first-boot footprint bounded without weakening `wal_autocheckpoint = 0` or competing with the shipper.

## How agents get it wrong

1. **`cp vault.db vault.db.bak` while the gateway is running** — WAL frames not in the main file; restore is incomplete.
2. **Copying only `vault.db` without its WAL sidecars** (`-wal`, `-shm`) when the process was not cleanly checkpointed.
3. **Calling checkpoint APIs as non-owner** or from a random script — custody refuses or fights the shipper.
4. **Treating filesystem snapshot of a live dataDir as a backup product** — use `backup` / `recover` paths (`packages/server` backup service, `@centraid/backup`).
5. **Deleting `gateway-logs` or enrollment files** thinking they are WAL — different subsystem ([logs.md](../logs.md)).

## Safe patterns

| Goal | Do |
| --- | --- |
| Product backup | Backup policy + provider / CLI backup verbs |
| Blank-machine recovery | `centraid-gateway recover` + a recovery kit you exported **in advance** with `backup kit` — nothing mints one for you (#603). Daemon stopped; do not boot it against the empty data dir first or it auto-founds a new `Personal` vault over it ([recovery/backup-restore.md](../recovery/backup-restore.md)) |
| Dev fixture | Stop gateway; use backup export or test-kit helpers; or copy only from a **closed** DB after checkpoint |
| Tests | `@centraid/test-kit` temp vaults — never the developer's live vault |

## Related

- `packages/vault/src/db.ts` — WAL pragmas
- `packages/backup/README.md`, `FORMAT.md`
- [recovery/backup-restore.md](../recovery/backup-restore.md)
