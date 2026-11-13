# Spike 0.2: read the vault's pages without a plaintext copy

Row 0.2 of [#1191](https://github.com/srikanth235/centraid/issues/1191). Question: can the snapshot read the vault's pages without writing a plaintext copy of the vault to disk, on every target? Candidate: SQLite's `sqlite_dbpage` virtual table in the bundled build.

**Verdict: page read works: B11 builds on it,** after one build flag is added. It is not compiled in today.

## Is `sqlite_dbpage` compiled in? No, and which flag turns it on

- The workspace builds SQLite from source: `rusqlite 0.41` with `bundled`, which compiles `libsqlite3-sys 0.39.1`'s amalgamation (SQLite 3.54.1) with `cc` (root `Cargo.toml`, the `rusqlite` entry).
- `libsqlite3-sys`'s `build.rs` passes a fixed flag list. It includes `SQLITE_ENABLE_DBSTAT_VTAB`, `SQLITE_ENABLE_FTS5`, `SQLITE_ENABLE_SESSION` and others, and **does not include `SQLITE_ENABLE_DBPAGE_VTAB`**. The amalgamation compiles the table only under `#if defined(SQLITE_ENABLE_DBPAGE_VTAB)` (`sqlite3.c`, the `dbpage` section).
- `build.rs` appends whatever the environment variable **`LIBSQLITE3_FLAGS`** holds (words starting `-D` or `-U`, or `SQLITE_…`), and re-runs when it changes. Nothing in the repo sets it (searched `*.toml`, `*.rs`, `*.sh`, `*.yml`, `*.kts`).
- Observed on Linux without the variable: `SELECT count(*) FROM sqlite_dbpage` fails with `no such table: sqlite_dbpage`, and `PRAGMA compile_options` has `ENABLE_DBSTAT_VTAB` but no `ENABLE_DBPAGE_VTAB`.
- Observed with `LIBSQLITE3_FLAGS=-DSQLITE_ENABLE_DBPAGE_VTAB`: the table answers, and `compile_options` lists `ENABLE_DBPAGE_VTAB`.

**To enable it for every target:** add to the repo's `.cargo/config.toml`

```toml
[env]
LIBSQLITE3_FLAGS = "-DSQLITE_ENABLE_DBPAGE_VTAB"
```

Cargo applies `[env]` to every build run from the repo, and both mobile build scripts run `cargo build` from the repo root (`mobile/scripts/ios-core.sh`, `mobile/scripts/android-core.sh`), as do the CI lanes that call them. `[env]` does not override a variable already set in the environment; B11 adds a gate check that the flag is in the effective list (`PRAGMA compile_options` read through a test), and the `rules` check should fail if any workflow or script sets `LIBSQLITE3_FLAGS` without it.

**Which targets I ran, and which I inferred.** *Ran:* Linux x86_64 (this container), both builds above. *Inferred, not run:* iOS (`aarch64-apple-ios`, simulator) and Android (`aarch64-linux-android`): they compile the same `sqlite3.c` and read the same `build.rs`, which reads `LIBSQLITE3_FLAGS` with no target condition (only `cfg.flag(...)` calls on the `cc::Build`), so the flag reaches the target compiler. The vtab uses only the pager (no OS call), so no target difference is expected. **Unverified until B11 builds the iOS and Android cores** (the owner hand-off in L3, or the `mobile-jvm`/prebuilt-core lanes for compilation). The core's size ratchet (`contracts/ledgers/library-size.json`) will move by the vtab's few kilobytes; that is a number that rises once, deliberately, with B11.

## Run on Linux: a read transaction over a WAL vault, every page, equal to the online-backup copy

The spike was a single test (not kept: the capability depends on a flag the workspace does not yet set, so it would fail in `main`; B11 recreates it as `no_plaintext_vault_copy_on_disk` and `page_read_equals_online_backup`). It founded a vault with `Vault::create` and `found` (WAL, 4096-byte pages), grew it with 20 commits of 50 rows through a second writer (1157 pages), then:

1. pinned reader R: a read-only connection, `BEGIN`, read page count (1157);
2. pinned copy connection: a second read-only connection, `BEGIN` and one read, then `rusqlite::backup` into a file in steps of 128 pages exactly as `snapshot.rs`'s `step_through` does, **with a writer committing one row between each step (9 commits landed mid-copy)**;
3. R read every page with one prepared statement `SELECT data FROM sqlite_dbpage WHERE pgno = ?1`, hashing the pages with BLAKE3 as they arrived and comparing each with the copy.

Output (counts only; no timing):

```text
page_size 4096, pages 1157
commits that landed while the copy ran: 9
statement executions: 1157 for 1157 pages
blake3 via dbpage : 94aaaa5cda02ae6dd93a2ea96bc164bc2c4977ddacefd9bad3e35255cc972493
blake3 of the copy: 704e41f6d983e01f9956f61166af445a25f5ec435a1110785376607dc50a7a95
pages that differ from the copy: 1
  page 1: byte offsets [27, 43, 95]
pinned reader: 1157 pages, 1000 rows; fresh reader: 1166 pages, 1009 rows
range reads: 73 statements returned 1157 pages
write through the table on a read-only connection: Err("attempt to write a readonly database")
```

What it shows:

- **1156 of 1157 pages are byte-identical to the online-backup copy, including while 9 commits landed.** R still sees 1157 pages and 1000 rows after the writer moved to 1166 pages and 1009 rows: the read transaction pins one consistent view, so the pages R reads are one moment of the vault.
- **The one difference is page 1, at byte offsets 27, 43 and 95.** Those are the low bytes of the file change counter (header bytes 24 to 27), the schema cookie (40 to 43) and "version-valid-for" (92 to 95). The online-backup API writes the destination in rollback-journal mode and bumps them on the copy it makes; `sqlite_dbpage` returns the page exactly as the live (WAL) file holds it. The whole-file hashes therefore differ (as printed) while every page of the vault's data is the same. This does not matter to a restore: the manifest's `db_hash` is the hash of what the snapshot read, and the restore checks the file it rebuilds against that same hash, then `integrity_check`. It means B11's `db_hash` is not equal to a hash of an `sqlite3_backup` copy, and nothing may compare the two. I did not find any code that does, but did not audit every caller (`unverified`).
- **Counts.** One statement execution per page (1157), or one per 64 KiB range (16 pages) with `WHERE pgno BETWEEN ?1 AND ?2`: 73 statements returned the 1157 pages, with the same bytes length per page. Either bounds the memory: **one page (4 KiB) or one 64 KiB range at a time**, no file written.
- The table is writable by design (`UPDATE sqlite_dbpage` rewrites a page). On the read-only snapshot connection SQLite refuses it (`attempt to write a readonly database`).

## What it costs the read pin

- The pin is the same kind the copy uses today: a WAL read transaction held open on a read-only connection. While it is open the writer may commit; the WAL cannot be checkpointed past R's mark, so the `-wal` file grows by the commits made during the pin and is truncated by the first checkpoint after R ends (`journal_size_limit` bounds what stays). That is the cost the online-backup copy pays today, no more.
- **The pin must cover reading, hashing and sealing the changed ranges, not only hashing.** Today the copy goes to a scratch file and the pin ends before sealing. Without a copy there is nothing to seal from after the pin ends, so B11 must, under the pin, for each 64 KiB range: read its pages, hash them to the range name, compare with the previous head's manifest entry at the same index, and seal the range to the spool only if the name changed. Unchanged ranges (the common case) cost a hash. The pin never spans network I/O. A first snapshot, where every range is new, seals the whole vault under the pin; the spool budget bounds that, and a vault whose changed ranges do not fit the budget ends the pass with the existing "no room" wait reason and releases the pin, as the copy does when the spool is full today. This corrects the issue text "the read pin covers hashing only": it covers hashing and sealing what changed.
- The vault's single writer connection is untouched; R is a second connection, as `step_through`'s is.

## What B11 must do

If the flag is added (the verdict): `snapshot.rs` drops `copy_from`, `step_through`, the scratch directory (`make_private_dir`, `create_private_file`, `remove_copy`, the core-open sweep of leftovers) and the "scratch copy" in the backup skill; the census is counted on the pinned connection (`count(*)` per table) under the same pin, by ordinary queries on R; `db_hash` is the BLAKE3 over the pages in order; `check.rs` still needs its scratch copy to *restore into* (a restore, not a snapshot), whose size rule (vault + tenth + 64 MiB) is unchanged. Harden: set `SQLITE_DBCONFIG_DEFENSIVE` on the writer so `sqlite_dbpage` cannot be written through the vault's own connection (I did not test whether DEFENSIVE blocks it in this build; B11 tests it, and a vault command surface has no raw SQL today). Add `LIBSQLITE3_FLAGS` to `.cargo/config.toml`, the compile-option check above, `page_read_equals_online_backup` and `no_plaintext_vault_copy_on_disk`.

If the flag cannot be had on a target (a build there fails, or the table is absent in `compile_options`): "not available: B11 keeps a copy that is sealed, streamed and removed". That is: the online-backup copy is written in chunks of 128 pages straight into a `FileSealer`-style stream (each 64 KiB range sealed with the same key and naming, never a plaintext file), the unsealed copy never reaches disk, and the sealed copy is removed after the last range is spooled. The sealed copy must be readable page by page to hash ranges, which means reading it back under its own key, and the copy would be the size of the vault in sealed form for the length of the pass. B11 should pick one path for all targets, because the two give different `db_hash`es (page 1) and a mixed fleet would not dedupe ranges across them.

## Reproducing

A spike test (kept in the session scratchpad, not committed) opens the vault, grows it, and runs the three steps above; run it with `LIBSQLITE3_FLAGS="-DSQLITE_ENABLE_DBPAGE_VTAB" cargo test -p centraid-vault --test <name> -- --nocapture`, and without the variable to see the absent-table answer.
