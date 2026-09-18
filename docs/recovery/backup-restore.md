# Recovery: backup / restore / recover

When a backup, an export, or a blank-machine `centraid recover` strands mid-flight. The product paths are the `centraid backup now`, `centraid export` and `centraid recover` verbs ([`crates/centraid/src/cmd`](../../crates/centraid/src/cmd)) over `centraid_vault::backup` ([`crates/vault/src/backup`](../../crates/vault/src/backup/mod.rs)). Every verb prints facts to stderr and one JSON report to stdout; exit `0` is success, `1` a refusal, `2` a usage error.

## The data directory

One layout, stated once in [`crates/centraid/src/cmd/mod.rs`](../../crates/centraid/src/cmd/mod.rs):

| Path | Role |
| --- | --- |
| `<data-dir>/vault/<vaultId>/vault.db` | the vault — one database file; a data dir holding two vaults is refused rather than guessed at |
| `<data-dir>/vault/<vaultId>/vault.bytes`, `vault.snapshots` | the byte plane's index and the seat bootstrap scratch, beside the file |
| `<data-dir>/keys/` | the key store: `seal.key`, `identity.seed`, `backup.master.key`, `export.master.key`, the gateway's endpoint key. Export, backup and copy gestures never move it |
| `<data-dir>/blobs/` | the backup plane's content-addressed store (local filesystem) |
| `<data-dir>/gateway.lock` | the pid of the `recover` run holding the directory; removed when it finishes. A second run refuses while that pid is live (checked through `/proc`, so only on Linux). The gateway itself does not take this lock, so stopping it before a restore is the operator's step |

## Invariants (do not violate while recovering)

| Rule | Detail |
| --- | --- |
| A **generation** is a complete base copy + sealed WAL segments + one `centraid-snapshot/2` manifest | The gateway seals a WAL segment every capture tick; `centraid backup now --data-dir <dir> [--force]` takes a generation now |
| Restore goes into a **fresh directory** | `recover` refuses a `vault/<vaultId>/vault.db` that already exists, so the copy you have is still there if the restore goes wrong |
| **Lazy default** | Content blobs are fetched on demand; `--full` materialises every blob now |
| **Fencing** | A successful recover bumps the replica epoch (`epoch_reason = 'backup-restore'`), so every seat paired to the original must re-bootstrap. No split-brain |
| A **snapshot never carries a key** | `keys/` is outside every generation; the recovery kit is the one artefact that carries keys ([custody](../../crates/vault/src/custody/README.md)) |
| The gateway holds **no Locker member key** | A kit written on the gateway carries the seal key and the identity seed and no member key; `recover` counts a kit's member-key entries, names them, and does not import them into the host ([#1020](https://github.com/srikanth235/centraid/issues/1020), D-1020-L1) |
| A **kit passphrase meets a floor when it is written, never when it is read** | At least 12 characters or at least 4 words (`assert_passphrase_floor` in [`crates/vault/src/backup/kit.rs`](../../crates/vault/src/backup/kit.rs), [#1014](https://github.com/srikanth235/centraid/issues/1014)). Opening a kit never applies it: a kit written under a weaker policy must still open |
| **Passwords come from a file** | `--password-file`, never a flag: a flag is in the shell history and every `ps` listing |
| The kit is an **export**, not a first-run artifact | Nothing mints a kit for you. `centraid export --data-dir <dir> --out <dir> --password-file <file>` writes a generation plus `custody/recovery-kit.json` _before_ you need it |
| **Forward-only schema** | A file below the binary is migrated with a pre-migration snapshot first; a file above it is refused, never guessed down ([`crates/vault/src/migrations.rs`](../../crates/vault/src/migrations.rs)) |

## Schema-change recovery checklist

Every change that creates a durable table or column must complete this checklist in the same PR; "the SQLite file is copied" is not evidence on its own:

- add the rung under [`contracts/migrations/`](../../contracts/migrations) and prove a fresh file and a migrated file land on the same schema with a clean `foreign_key_check`;
- seed the new data in the restore drill ([`crates/vault/src/backup/drill.rs`](../../crates/vault/src/backup/drill.rs), run as a process by [`crates/centraid/tests/restore_drill.rs`](../../crates/centraid/tests/restore_drill.rs) and by the `release` gate's `restore-drill` step) and assert the exact rows and references are readable after recovery;
- confirm the base copy carries the table — the seat snapshot deliberately drops private tables, which is why the backup base is its own artefact ([`crates/vault/src/backup/base.rs`](../../crates/vault/src/backup/base.rs));
- include new blob/content references in the manifest's chunk index where applicable;
- verify an older binary refuses a newer file before mutating recovery material.

## Symptoms

- `recover` stops at a named phase (`discovering`, `fetching`, `replaying`, `fencing`, `adopting`, `warming`)
- `recover` reports "a live gateway (pid N) holds …" (another `recover` run holds the lock)
- `recover` refuses because the kit's seal key does not match the vault
- `--at` replay leaves segments unapplied
- Disk full mid-restore

## Steps — `recover` failed mid-phase

`recover` is an offline verb: stop the gateway that uses the data directory first.

1. Read the stderr phase lines — each is `centraid: [<phase>] …` — and the gateway's log ([logs.md](../logs.md)).
2. Re-run with the same intent:

   ```sh
   centraid recover --kit <kit.json> --password-file <file> --data-dir <dir> \
     [--at YYYY-MM-DDTHH:MM:SSZ] [--vault <vaultId>] [--full] --yes
   ```

   Without `--yes` the verb prints what it would restore (and how many bytes, with `--full`) and refuses. `--vault` is required when the kit carries more than one vault. A malformed `--at` is exit 2 and touches nothing.

3. If the failure left a partial `vault/<vaultId>/vault.db` in a fresh directory, remove **that** directory only after confirming it is not the live vault path, then re-run.
4. After `fencing`, every seat paired to the original vault must re-bootstrap — that is the fence working, not a fault.
5. A kit that carries member-key entries prints a line naming them. Those keys are restored on a seat, never on the gateway; without them the vault's Locker secrets do not open.
6. Confirm the result with `centraid doctor --data-dir <dir> --json`: `integrity_check`, `foreign_key_check` and the seal-key fingerprint.

## Steps — accidental live-tree copy

1. Do not open the torn copy as production.
2. Prefer `recover` from the last good generation.
3. See [traps/wal-checkpoint.md](../traps/wal-checkpoint.md).

## Steps — kit or key store lost

Without the recovery kit and its password, sealed cells are unrecoverable by design. A `keys/` directory that was lost with the kit still held is exactly what `recover`'s `adopting` phase restores (`seal.key`, `identity.seed`).

## What not to do

- `cp -a` a live `vault.db` as a backup while the gateway runs
- Delete generations or WAL segments from the blob store to "clean up" a failed restore
- Run two gateways over the same vault after a partial recover

## Related

- [ARCHITECTURE.md](../../ARCHITECTURE.md) — restore/recover summary
- [`crates/centraid/src/cmd/recover.rs`](../../crates/centraid/src/cmd/recover.rs), [`export.rs`](../../crates/centraid/src/cmd/export.rs), [`backup.rs`](../../crates/centraid/src/cmd/backup.rs), [`doctor.rs`](../../crates/centraid/src/cmd/doctor.rs)
- [vault-erase.md](vault-erase.md) — erase destroys keys, so its recovery story differs
- [`receipts/issue-439-restore-as-product.md`](../../receipts/issue-439-restore-as-product.md)
