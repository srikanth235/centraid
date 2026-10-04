# Recovery: backup and restore

**Recovery is 24 words and a gateway.** There is no recovery kit file, no password, no key escrow and no reset link. Every key a vault has derives from one BIP39 phrase through a SLIP-0010 hardened tree; the phone keeps the 64-byte seed in the synced keychain, and the written phrase is the fallback. A gateway holds the sealed copy, and nothing it holds opens without the words.

The rulings are [decisions.md](../decisions.md#backups-from-first-principles-1080); the protocol is [../gateway.md](../gateway.md); pairing is [pairing.md](pairing.md).

## What a backup is

"Backed up" means one thing: **the gateway acknowledged that object, and the phone recorded the acknowledgement durably** ([R-1080-7](../decisions.md#backups-from-first-principles-1080)). Every object is a sealed **part**, and the vault's database plus the 24 words is the whole index of them: a part's name and key derive from the vault's backup key and the BLAKE3 of the file's plaintext, which the vault already stores for every content item and derivative ([R-1080-4](../decisions.md#backups-from-first-principles-1080)).

| Piece | What it is |
| --- | --- |
| **snapshot** | The vault file copied page for page with SQLite's online backup API into a scratch copy, in one step that cannot interleave with a commit ([R-1080-B6](../decisions.md#the-sealed-format-and-the-snapshot-plane-1080-wave-1-lane-b)). Taken hourly while a gateway is reachable on an unmetered link, on the first pass to a gateway just paired, on **Back up now**, when the app leaves the screen, and after a restore completes ([R-1080-5](../decisions.md#backups-from-first-principles-1080)). |
| **range** | A page-aligned 64 KiB slice of a snapshot, compressed and sealed as a file named from its own bytes. Page-identical copies keep an unchanged range's bytes and therefore its name, so a snapshot uploads only the ranges that changed ([Q-1080-B1](../decisions.md#open-questions-for-the-owner-1080), answered). |
| **manifest** | A snapshot's sealed JSON: `{v: 2, vault_id, taken_at_ms, page_size, db_len, db_hash, user_version, app, ranges: [{i, name, len}], census}`. The census is every member table's row count, counted on the scratch copy ([R-1080-B7](../decisions.md#the-sealed-format-and-the-snapshot-plane-1080-wave-1-lane-b)). The gateway's **head** names the newest manifest. |
| **part** | What a gateway stores: at most 64 MiB of one file's plaintext in `centraid-sealed/2`. A range, a manifest, an original and a thumbnail are all parts. |
| **ledger** | `<stem>.backup.db` beside the vault: the paired gateways, the queue of parts to move, every name each gateway confirmed, the snapshots this phone took, and where each content hash's bytes are on this phone. Device-local and derived — a cache of the gateways' truth, reconciled against their `exists` answers on every launch. |
| **spool** | `<stem>.spool/`: sealed parts waiting to move, one file per name, bounded at 2 GiB or a tenth of the free space, whichever is smaller; an original larger than that is sealed a window at a time ([R-1080-C39](../decisions.md#the-phone-core-and-the-cut-over-1080-lane-c)). A part is sealed once and the same bytes are sent on every retry; on iOS the operating system uploads spool files by path while the app is suspended. |

**A pass** prepares, moves and settles ([mobile-offline.md](../mobile-offline.md#the-pass)): it takes a snapshot if one is due, asks `exists` and seals into the spool only what the gateway lacks — ranges, the manifest, and every original and derivative with no confirmed name (a body kept in its own row, a note's or a text document's, travels in the snapshot and is not sealed by name) — moves the spool to the preferred reachable gateway, then records each acknowledgement, deletes the spool file, and sets the head once every range of the snapshot is confirmed. A manifest moves after every part it names ([R-1080-B8](../decisions.md#the-sealed-format-and-the-snapshot-plane-1080-wave-1-lane-b)).

**Retention is the phone's.** It keeps 7 daily, 4 weekly and 6 monthly snapshots, deregisters the rest by deleting their manifests, and asks the gateway to delete every name nothing it keeps refers to: the ranges of kept manifests, the names every content hash in the vault implies, the kept manifests, and anything still in flight ([R-1080-B5](../decisions.md#the-sealed-format-and-the-snapshot-plane-1080-wave-1-lane-b)). A deleted object keeps its bytes for seven days.

## Invariants (do not violate while recovering)

| Rule | Detail |
| --- | --- |
| A gateway holds **no key** | Every part is sealed on the phone under keys derived from the 24 words. A copy of a gateway's whole data directory yields ciphertext under names nobody can invert, sizes and times. |
| Storage is **write-once** | A name is a function of the plaintext. Re-sending a part is free, and `NAME_TAKEN` — the name held under another digest — is an acknowledgement, not an error ([R-1080-B4](../decisions.md#the-sealed-format-and-the-snapshot-plane-1080-wave-1-lane-b)). |
| The head moves under a **compare-and-set** | Two writers racing produce one winner and one that is told `HEAD_CONFLICT` with the head as it stands. |
| A restore builds a **fresh file** | It writes `<out>.partial` and renames it only when every check passed. It never repairs a file in place. |
| A restored phone **claims at epoch + 1, after the checks** | The old phone's next write is refused `MOVED` and it freezes read-only with what it holds still visible (F1). That is the fence working. |
| The ledger and the spool are **derived** | Neither is inside the vault or in a snapshot. Losing them costs a re-pair, a reconcile and a re-upload, never a backup. |
| **Forward-only schema** | A file below the binary is migrated with a pre-migration snapshot first; a file above it is refused, never guessed down ([`migrations.rs`](../../crates/vault/src/migrations.rs)). |

## Restoring onto a new phone

1. Install Centraid and choose **Restore**.
2. Type the 24 words — or restore from the seed the keychain synced, with none typed ([R-1047-E9](../decisions.md#the-24-words-on-the-phone-1047-e1)). `RecoveryPhrase::parse` refuses a bad checksum rather than deriving from nonsense.
3. Scan or paste a gateway's pairing payload — the QR `centraid-gateway pair` prints. It tells the phone where the gateway is and which certificate to trust. The vault's identity key, derived from the words, is what proves the phone may read the vault there.
4. For each vault, the phone takes a **read** grant, fetches the head's manifest and its ranges in `fetch` bundles, writes each range at its offset, truncates to `db_len`, and checks the result: `db_hash`, `integrity_check`, the page size and `user_version`, and the census table by table. Only then does it open the file through the migration ladder.
5. **Only a snapshot that passed every check** has the phone claim the vault at the writer epoch plus one, naming the head it checked. If the old phone set a new head in between, the gateway refuses `HEAD_CONFLICT` and moves nothing; the phone checks the new head and claims that. A refused snapshot moves nothing either: no file is left on the new phone and the old phone goes on backing up.
6. **Then the grid.** Every derivative comes back by its computed name in `fetch` bundles, so the library draws in full; an original comes back on demand when it is opened (`fetch_original`), one at a time, and stays in the phone's store until the member frees space. A bulk refill of originals under the transfer rule is not built ([#1080](https://github.com/srikanth235/centraid/issues/1080), open items).
7. **Compare the safety number** per vault. Each vault has its own identity key, so one number for all of them would confirm nothing about any of them.

A restore never touches a vault this phone already holds. There is **no gateway-side vault listing**: a restoring phone derives its vaults' ids from the phrase and asks for each, so a gateway cannot link a member's vaults to each other ([Q-1029-9](../decisions.md#open-questions-for-the-owner-1029)).

## Symptoms

| Symptom | What it means |
| --- | --- |
| `MOVED` on the old phone | A restore or a takeover claimed the vault at a higher epoch. The phone is frozen read-only, which is the design. See [pairing.md](pairing.md). |
| `HEAD_CONFLICT` | Two writers raced, or the head a restore checked moved before its claim. The loser is told the head as it stands; the compare-and-set is doing its job. |
| `EPOCH_CONFLICT` | A claim that was not the writer epoch plus one: another claim landed first. Read the head and the epoch again before claiming. |
| `PIN_MISMATCH` | The phone reached an address where its gateway should be and found another certificate. It sends nothing there. See [pairing.md](pairing.md#the-phone-says-pin_mismatch). |
| `UNAUTHORIZED` | The gateway does not know this phone's token — it was forgotten, or the gateway's `state.db` was lost — or a pairing secret was spent or expired. Pair again. |
| `DISK_FULL` | The gateway's disk refused a write. Nothing is lost: the part stays in the spool and moves once there is room. |
| `ERROR_CODE_PEER_UNREACHABLE` naming the seed | The core has its vault and not its keys — the shell has not handed the seed in ([W15-D2](../decisions.md#w15--the-phones-request-contract-1029)). The member sees "unlock to back up". |
| A restore refused naming `db_hash`, `integrity_check` or a range | The ranges did not reassemble into the file the manifest named. Suspect a damaged object on the gateway: run `centraid-gateway scrub`, which marks it missing so the old phone, if it still has the bytes, sends it again. |
| A restore refused naming a table | The snapshot's census disagrees with the rows the rebuilt file holds — a forged or damaged manifest, or a bug in the copy. The claim did not move, so the old phone still backs up. |
| A restore completes and the vault is empty | `integrity_check` speaks about pages, not rows: a perfect page tree with no rows is a clean structural report and a total loss. The census is what says the rows came back, which is why the drill compares a dump of every row. |

## The drill

[`crates/vault/src/backup/drill.rs`](../../crates/vault/src/backup/drill.rs), run by the `restore-drill` step of every gate profile, asserts the whole durability chain end to end: found a vault and commit through the command plane; snapshot, upload and set the head; back up every content item by name and prove the ledger confirms every name; commit fifty more times and prove the second snapshot sealed only the ranges that changed; let retention and garbage collection delete exactly what only the dropped snapshot named; **destroy the vault, its WAL, the spool, the ledger and the scratch copy**; restore from the head and prove the census, `db_hash` and a dump of every row equal the lost vault's, and that a file fetched by name verifies against its hash; then claim at the next epoch and prove the old writer is refused `MOVED`. The plane takes any store, so the drill runs against an in-memory store and against a real gateway the test harness spawns.

What it does not cover is a phone: restore onto a second real device, a library of real photographs, and the operating system moving bytes while the app is closed. Those are the device hand-offs in [`mobile/maestro/backup-measurement.md`](../../mobile/maestro/backup-measurement.md).

## Schema-change checklist

Every change that creates a durable table or column completes this in the same PR; "the SQLite file is copied" is not evidence on its own:

- append the rung under [`contracts/migrations/`](../../contracts/migrations) — **never edit one that has shipped**: a vault's `user_version` names the rung it reached, and two builds that disagree about a rung's bytes disagree about what a vault at that version holds;
- prove a fresh file and a migrated file land on the same schema with a clean `foreign_key_check`. Rung `010_backup_v2.sql` ([#1080](https://github.com/srikanth235/centraid/issues/1080)) is the worked example: it drops `backup_object_range`, `backup_base_range`, `backup_blob_custody` and `backup_blob_placement` with their indexes, `crates/vault/tests/baseline.rs`'s `DROPPED_OBJECTS` names them so a resurrected table is red, and the drill proves a migrated file and a fresh file agree;
- regenerate `contracts/schema/vault-ddl.sql` (`cargo run -p centraid-vault --bin export-ladder-ddl`) and let [`ladder_ddl.rs`](../../crates/vault/tests/ladder_ddl.rs) confirm it is still derivable;
- seed the new data in the drill and assert the exact rows and references are readable after recovery. A snapshot is the whole file, so a new table is carried, and the census counts every table a member has rows in, so it is checked too;
- keep **device-local** facts out of the vault: anything true of one phone's disk — where bytes are, what was uploaded, which gateway is paired — belongs in the ledger, because the vault is restored onto the next phone ([W15-D1](../decisions.md#w15--the-phones-request-contract-1029)'s argument, which the ledger now carries);
- verify an older binary refuses a newer file before mutating recovery material.

## What not to do

- `cp` the phone's live `vault.db` as a backup. A snapshot is taken with the online backup API under the vault's write lock — see [../traps/wal-checkpoint.md](../traps/wal-checkpoint.md).
- Delete files from a gateway's `objects/` to "clean up". Retention is the phone's and goes through `delete`, with a week's grace; a file removed by hand reads as missing, and the phone can send it again only while it still holds the bytes — an original it already evicted cannot come back.
- Edit a gateway's `state.db`, or replace its `tls.key`, `tls.crt` or `gateway.id`: every paired phone refuses a gateway whose certificate changed.
- Treat a gateway as a second copy of the vault. It holds nothing that opens one without the 24 words.
- Rely on one gateway alone. **A laptop-only backup is a local backup** — fire or theft takes phone and laptop together; a second gateway elsewhere is the off-site copy ([R-1080-8](../decisions.md#backups-from-first-principles-1080)).

## Related

- [../gateway.md](../gateway.md) · [pairing.md](pairing.md) · [vault-erase.md](vault-erase.md)
- [ARCHITECTURE.md](../../ARCHITECTURE.md) — backup and recovery in context
- [`crates/vault/src/backup/`](../../crates/vault/src/backup) — naming, store, ledger, spool, snapshot, mover, retention, restore, drill
