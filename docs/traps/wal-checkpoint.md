# Trap: WAL / checkpoint vault copies

## What goes wrong

Copying `vault.db` with `cp` while the core has it open, or letting a second opener checkpoint the WAL under a running capture, produces a **torn, incomplete or empty** result. A backup then "succeeds" with stale data, or a generation ships with frames that were silently dropped.

Under [#1029](https://github.com/srikanth235/centraid/issues/1029) the vault moved to the phone and the gateway became a blind store, so who holds the connection changed — the trap did not.

## Invariants (code)

- **The phone is the vault's single writer.** `crates/vault`'s `Vault::wrap` is the one funnel that opens a connection, and it states the whole pragma set on every one: `journal_mode = wal`, `synchronous = FULL`, `wal_autocheckpoint = 0`, `journal_size_limit`, `SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE`, `foreign_keys`. `page_size` is pinned at 4096 and `auto_vacuum` is `NONE`, both stated in `Vault::create_with` where a header pragma can take.
- **`synchronous = FULL` is the durability order and it is explicit, never inherited** (F11). Under WAL the compiled default is `NORMAL`, which acknowledges a commit before its frames reach the disk — and that leaves the spool holding a commit the phone lost, whose txid the next one collides with.
- **`wal_autocheckpoint = 0` means nothing checkpoints behind the capture's back.** Any other opener with the default — an iOS share extension, a debugging tool, a second process "just reading" — restarts the WAL under the capture. **One opener, one pragma set, one connection per vault.**
- **Capture is commit-driven and debounced, not on an RPO timer** (`crates/vault/src/backup/capture.rs`). It reads the `-wal` file's frames, respects the byte order the header magic names, follows the checksum chain, and ignores trailing frames that fail it exactly as SQLite does — those are a crash mid-write, not corruption.
- **A WAL restart with new salts is normal** after every truncate. The break rule is a salt mismatch mid-cursor, not a file that got shorter: SQLite restarts the WAL _in place_ with new salts at the same length, which is the defect a length comparison missed (B6). `(salt1, salt2, frame index)` is recorded durably before the checkpoint that makes it stale.
- **A base is page-aligned ranges of the live file, sealed.** `VACUUM INTO` renumbers pages, which is why WAL frames could not be replayed onto the old base (B4), and why `VACUUM` never runs and `auto_vacuum` stays `NONE`. `PRAGMA optimize` writes `sqlite_stat1`, so it is a commit: run it, capture, then checkpoint.
- **A gateway holds no key and no plaintext.** The laptop's data directory holds `node.key`, the state file and the object store; there is no vault there to copy.

## How agents get it wrong

1. **`cp vault.db vault.db.bak` while the core is open** — WAL frames are not in the main file; the copy is incomplete.
2. **Copying only `vault.db` without its `-wal` and `-shm` sidecars** when the process was not cleanly closed. This is the trap read from the other end too, and it was live: `seed-demo-vault` left a 4 KB file beside a 19 MB `-wal`, `mobile/scripts/demo-vault.sh` copied the database and dropped the sidecars — as it must, they belong to the copy — and the simulator opened a vault with no rows in it. A writer that hands its file to someone else owes the checkpoint; see the safe pattern below.
3. **Opening a second connection "just to read".** If it is the last one to close, it checkpoints the WAL out from under the capture's offsets; if it uses the default `wal_autocheckpoint`, it restarts the WAL while the capture is mid-cursor.
4. **Editing a migration rung to fix a comment.** The ladder's bytes train the backup dictionary — see [migration-header-is-a-format.md](migration-header-is-a-format.md).
5. **Treating a filesystem snapshot of the phone's vault directory as a backup product.** The product is the drain: sealed objects committed to the laptop under a manifest head.

## Safe patterns

| Goal | Do |
| --- | --- |
| Product backup | The phone drains its spool to the paired laptop — in the foreground, or in the background window the OS grants ([R-1029-2](../decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21)). There is no copy gesture. |
| Blank-phone recovery | The 24 words, on a fresh install. Nothing else is needed and nothing else is kept — see [../recovery/backup-restore.md](../recovery/backup-restore.md). |
| Health check on a gateway | `centraid doctor --data-dir <dir> [--json]` — read-only and lock-free, which is why the container health check runs it. |
| Bit-rot check on stored objects | `centraid-gateway scrub --data-dir <dir> [--repair]`, or the quarterly sweep the server runs itself. No key is involved. |
| Tests | Temp directories per test — never a live vault. |
| A fixture whose artifact IS the file (`seed-demo-vault`) | End it with `Vault::finish` (`Handle::close_file` over the ABI side), which checkpoints `TRUNCATE` and then closes, so the `.db` alone carries the rows. A plain close cannot: `NO_CKPT_ON_CLOSE` is set, by design, so every row a short-lived writer wrote stays in the `-wal`. **Only for a vault no spool is tracking** — under a live capture the door is `backup::capture::checkpoint`, which seals first. |

## Related

- `crates/vault/src/backup/` — capture, seal, manifest, restore ordering
- `crates/vault/src/backup/drill.rs` — the drill the `release` profile runs
- [../recovery/backup-restore.md](../recovery/backup-restore.md)
- [migration-header-is-a-format.md](migration-header-is-a-format.md)
