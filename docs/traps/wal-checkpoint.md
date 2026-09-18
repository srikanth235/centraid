# Trap: WAL / checkpoint vault copies

## What goes wrong

Copying `vault.db` with `cp` while SQLite is in WAL mode, or closing the last connection under a running capture, produces a **torn, incomplete or empty** result. Backup/restore then "succeeds" with corrupt or stale data, or a generation ships with no WAL tail and an RPO of "since the last snapshot".

## Invariants (code)

- A data directory has one layout: `<data-dir>/vault/<vaultId>/vault.db`, `<data-dir>/keys/` beside it, and `<data-dir>/blobs/` for the store (`crates/centraid/src/cmd/mod.rs`). `keys/` is deliberately what export, backup and copy gestures do **not** move, which is what makes a copied vault ciphertext.
- **The gateway is the vault's single writer, and it holds its one writable connection for the life of the process** (`crates/centraid/src/run.rs`). In WAL mode SQLite checkpoints and removes the `-wal` file when the last connection closes, so a gateway that closed its connection would leave the capture tick nothing to read.
- **The WAL capture tick runs in the gateway** and reads the `-wal` file, not a connection (`crates/centraid/src/cmd/capture.rs`). Each tick seals the new byte range into the blob store and appends one line to `<data-dir>/wal/pending.jsonl`; `centraid backup now` reads that index. A segment's address is `{db, generation, group, startOffset, endOffset, tickMs}`, with both offsets in the nonce (`crates/vault/src/backup/wal.rs`). When the WAL file gets **shorter** than the last offset, SQLite has checkpointed and restarted it, so the capture bumps the group and resets the offset to zero — without that, two different byte ranges would seal under one address and one nonce.
- `Vault::close` checkpoints the WAL; a core is closed, not dropped-and-hoped (`crates/core/src/handle.rs`).
- **Restore is into a fresh directory only.** `centraid recover` refuses a live gateway's data directory by pid through the lock file, and refuses a target that already holds a `vault.db` ([recovery/backup-restore.md](../recovery/backup-restore.md)). Never "fix in place" over a live vault.

## How agents get it wrong

1. **`cp vault.db vault.db.bak` while the gateway is running** — WAL frames not in the main file; the copy is incomplete.
2. **Copying only `vault.db` without its WAL sidecars** (`-wal`, `-shm`) when the process was not cleanly closed.
3. **Opening and closing a second connection "just to read" and assuming nothing changed** — if it was the last connection, the close checkpointed the WAL out from under the capture's offsets. Reads against a serving gateway go through `centraid doctor`, which is read-only and lock-free.
4. **Treating a filesystem snapshot of a live data directory as a backup product** — use `centraid backup now`, `centraid export` and `centraid recover`.
5. **Deleting `wal/pending.jsonl`** thinking it is a log — the index is the next generation's WAL tail ([logs.md](../logs.md#what-is-not-a-log)).

## Safe patterns

| Goal | Do |
| --- | --- |
| Product backup | `centraid backup now --data-dir <dir>` (a snapshot, the sealed WAL tail, a manifest); `centraid export --data-dir <dir> --out <file> --password-file <file>` for a portable copy plus a password-wrapped recovery kit |
| Blank-machine recovery | `centraid recover --kit <file> --password-file <file> --data-dir <fresh dir>`, with a kit you exported **in advance** — nothing mints one for you ([recovery/backup-restore.md](../recovery/backup-restore.md)) |
| Health check against a serving gateway | `centraid doctor --data-dir <dir> [--json]` |
| Dev fixture | Stop the gateway and copy from a **closed** vault, or seed a fresh one with `cargo run -p centraid --bin seed-demo-vault` |
| Tests | temp directories per test — never the developer's live vault |

## Related

- `crates/centraid/src/cmd/capture.rs` — the capture tick
- `crates/vault/src/backup/` — seal, manifest, restore ordering
- `crates/centraid/tests/restore_drill.rs` — the drill the `release` profile runs
- [recovery/backup-restore.md](../recovery/backup-restore.md)
