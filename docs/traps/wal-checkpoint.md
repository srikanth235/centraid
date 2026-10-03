# Trap: copying a live vault

## What goes wrong

Copying `vault.db` with `cp` — or any byte-for-byte copy — while the core has it open produces a **torn, incomplete or empty** file. Committed rows live in the `-wal` until a checkpoint moves them into the main file, and a copy that read some pages before a commit and some after holds two states of the database at once. The copy opens, or opens empty, and nothing says it is wrong.

The vault is on the phone and only the phone writes it ([#1029](https://github.com/srikanth235/centraid/issues/1029)); its backup is a snapshot taken through SQLite's own online backup API ([#1080](https://github.com/srikanth235/centraid/issues/1080)). That is the only way a live vault is copied.

## Invariants (code)

- **The phone is the vault's single writer.** `crates/vault`'s `Vault::wrap` is the one funnel that opens a connection, and it states the whole pragma set on every one: `journal_mode = wal`, `synchronous = FULL`, `journal_size_limit` and `foreign_keys`, with `wal_autocheckpoint` left at SQLite's default. `page_size` is pinned at 4096 and `auto_vacuum` is `NONE`, both stated in `Vault::create_with` where a header pragma can take.
- **`synchronous = FULL` is the durability order and it is explicit, never inherited** (F11). Under WAL the compiled default is `NORMAL`, which acknowledges a commit before its frames reach the disk, and a snapshot could then carry a commit the phone itself loses.
- **A snapshot is `sqlite3_backup` into a scratch file, in one step, under the vault's write lock** ([R-1080-B6](../decisions.md#the-sealed-format-and-the-snapshot-plane-1080-wave-1-lane-b)). The copy runs on the vault's own connection while the caller holds `&Vault`, and `Vault` is `!Sync`, so it cannot interleave with a commit: it holds exactly the commits made before it, whether or not they have been checkpointed, because the online backup API reads through the WAL. A copy asked for from inside a commit is refused by name.
- **Page-identical, so pages must stay where they are.** The online backup API copies page N to page N, which is what keeps an unchanged 64 KiB range's bytes, and so its name, from one snapshot to the next. `VACUUM` never runs and `auto_vacuum` stays `NONE`: renumbering pages would make every range new and upload the whole file again.
- **The census is counted on the scratch copy**, after the vault is released ([R-1080-B7](../decisions.md#the-sealed-format-and-the-snapshot-plane-1080-wave-1-lane-b)), so there is no running counter for a write around the commit guard to make wrong.
- **A gateway holds no key and no plaintext.** Its data directory holds its TLS identity, `state.db` and sealed objects; there is no vault there to copy.

## How agents get it wrong

1. **`cp vault.db vault.db.bak` while the core is open** — WAL frames are not in the main file; the copy is incomplete.
2. **Copying only `vault.db` without its `-wal` and `-shm` sidecars** when the process was not cleanly closed. This is the trap read from the other end too, and it was live: `seed-demo-vault` left a 4 KB file beside a 19 MB `-wal`, `mobile/scripts/demo-vault.sh` copied the database and dropped the sidecars — as it must, they belong to the copy — and the simulator opened a vault with no rows in it. A writer that hands its file to someone else owes the checkpoint; see the safe pattern below.
3. **Opening a second connection that writes.** The commit guard — receipts, change events, the command registry — is on the core's one writable connection; a second writer's rows are real and nothing in the vault heard them.
4. **Running `VACUUM` to "tidy" a vault.** It renumbers pages, so every range of the next snapshot is new and the whole file is uploaded again.
5. **Treating a filesystem snapshot of the phone's vault directory as a backup product.** The product is the snapshot plane: sealed ranges and a manifest a gateway acknowledged.

## Safe patterns

| Goal | Do |
| --- | --- |
| Product backup | A pass takes a snapshot and uploads what a gateway lacks — in the foreground, in the windows the OS grants, and on iOS by the system's background session while the app is suspended. There is no copy gesture. |
| Blank-phone recovery | The 24 words and a gateway's pairing payload, on a fresh install — see [../recovery/backup-restore.md](../recovery/backup-restore.md). |
| Checking a vault file | `centraid doctor --data-dir <dir> [--json]` — read-only and lock-free, against a copy or a drill's restore. |
| Checking a gateway | `centraid-gateway health --data-dir <dir>` asks a running gateway over TLS; `centraid-gateway scrub --data-dir <dir>` re-hashes every stored object now. No key is involved in either. |
| Tests | Temp directories per test — never a live vault. |
| A fixture whose artifact IS the file (`seed-demo-vault`) | End it with `Vault::finish` (`Handle::close_file` over the ABI side), which checkpoints `TRUNCATE` and then closes, so the `.db` alone carries the rows. |

## Related

- `crates/vault/src/backup/snapshot.rs` — the copy, its ranges, its census and its manifest
- `crates/vault/src/backup/drill.rs` — the drill every gate profile runs
- [../recovery/backup-restore.md](../recovery/backup-restore.md)
