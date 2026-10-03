# Receipt — backups from first principles ([#1080](https://github.com/srikanth235/centraid/issues/1080))

Umbrella receipt. One receipt for the whole umbrella; each lane appends its own section below and never edits a section above it. The state this umbrella produces lives in [docs/decisions.md](../docs/decisions.md#backups-from-first-principles-1080) and, from the doc pass, in the state documents #1080 names; where this receipt and a doc disagree, the doc is current.

The umbrella is worked by orchestration ([docs/multi-agent.md](../docs/multi-agent.md)): wave 1 runs lane A (the gateway protocol v2, `crates/gateway2`) and lane B (the sealed format and the vault snapshot plane) in parallel; wave 2 is the cut-over; wave 3 the shells; wave 4 the doc pass and the close. The root's amendments to #1080 are in its seam contract; the two that reached lane B are named where they apply.

## What changed

### Wave 1, lane B — the sealed format and the vault snapshot plane

Everything here stands beside the plane it replaces and nothing a member runs calls it yet: `crates/vault/src/backup/**`, `crates/media/src/object/**` and the migration ladder are untouched, and the cut-over wires the new plane and deletes the old one.

**`centraid-sealed/2`** (`crates/media/src/sealed.rs`). Every object a gateway stores is a part of at most 64 MiB of one file's plaintext. A file is hashed and sealed in the same stream (`FileSealer`), so a source is read once — the root's amendment A8, which replaced the first cut of the format (a sealed header carrying `h`, commit `bb58ef9f`) with a 30-byte clear header that carries nothing about the file: magic, version, flags, part index, part length and a 16-byte random salt, the AAD of every chunk. A part's key is `derive_key("centraid backup v2 object", K_backup ‖ salt)`; its name is `hex(keyed_hash(K_name, h ‖ u32be(i)))`, computed once `h` is known. Chunks are 4 MiB of payload under XChaCha20-Poly1305 with a random nonce each, AAD `header ‖ u32be(index) ‖ u8(is_last)`; ranges and manifests are zstd level 3, media is not. Opening needs only `K_backup`; a file's identity is checked where it is known — `open_whole` against the name a one-part file was fetched by, `assemble` and the streaming `Assembler` against `h`. A part whose length the sealer did not know is re-sealed from its own temp file. `contracts/crypto/sealed-vectors.json` pins every derived value and opens committed samples on every run.

**The snapshot plane** (`crates/vault/src/backup2/`, beside `crate::backup`):

- `naming` — the vault's keys from the root key's bytes, and the names its content items and derivatives imply;
- `store` — the synchronous `Store` trait (the protocol v2 object and head routes as Rust calls) and `MemoryStore`, which models the compare-and-set head, the tombstone grace, `HEAD_IN_USE` and the epoch fence;
- `ledger` — `<stem>.backup.db` with #1080's five tables, `application_id` `CBL1`, a version that refuses a newer ledger;
- `spool` — `<stem>.spool/`, one sealed part per name, written as a `.partial`, fsynced and renamed, under a budget of 2 GiB or a tenth of the free space;
- `snapshot` — the page-identical copy in one `sqlite3_backup` step, the census, 4 MiB ranges and their names, the manifest in #1080's key order; `plan`, `spool` and `settle`;
- `mover` — the `PUT`s, the confirmations they earn, and `reconcile` against `exists`;
- `retention` — 7 daily, 4 weekly and 6 monthly snapshots, live names and garbage as pure functions;
- `restore` — the file rebuilt from a head and refused unless its `db_hash`, `integrity_check`, header and census are the snapshot's;
- `drill` — back up, lose everything, restore, prove it.

**Rung 010 is not here.** #1080's plan gave it to this lane; lane B found the old plane still writes the four tables it drops, and the root moved the rung to the cut-over lane, which deletes those writers in the same commit (finding F-B1 below).

**Measured on the drill** (`crates/vault/tests/backup2_drill.rs`): a vault of 240 notes is 57 MiB in 15 ranges; fifty small notes later the second snapshot sealed 13 of the 15 and the store grew by exactly those 13 ranges and one manifest (256 → 270 objects); 240 content files went up as 240 parts and every name they imply was confirmed; garbage collection deleted the 13 ranges only the dropped snapshot named; the restore passed all six checks and a dump of every row equalled the lost vault's.

| Commit | Subject |
| --- | --- |
| `bb58ef9f` | feat(media): the centraid-sealed/2 part format and its vectors (#1080) |
| `24bb76e0` | feat(vault): the backup2 store, ledger, spool and retention (#1080) |
| `3852eaa0` | feat(media): seal a file in one pass, keyed by a per-part salt (#1080) |
| `d182e01f` | feat(vault): backup2 snapshot, mover and restore (#1080) |
| `9c2861c3` | feat(vault): the backup2 drill, end to end against MemoryStore (#1080) |
| `af60ff2b` | fix(media): keep SQL out of the sealed vectors' samples (#1080) |

| File | Change |
| --- | --- |
| `crates/media/src/sealed.rs` | new: the format, `PartSealer`, `FileSealer`, the opener, `open_whole`, `assemble`, `Assembler`, 18 unit tests |
| `crates/media/src/lib.rs` | `pub mod sealed;` and its row in the module table |
| `crates/media/tests/sealed_vectors.rs` | new: the vectors test |
| `contracts/crypto/sealed-vectors.json` | new: the vectors |
| `crates/media/Cargo.toml` | `tempfile` as a dev-dependency, for `FileSealer`'s tests |
| `Cargo.lock` | `tempfile` in `centraid-media`'s dependency list |
| `crates/vault/src/lib.rs` | `pub mod backup2;` |
| `crates/vault/src/backup2/mod.rs` | new: the plane's header and `PlaneError` |
| `crates/vault/src/backup2/naming.rs` | new |
| `crates/vault/src/backup2/store.rs` | new |
| `crates/vault/src/backup2/ledger.rs` | new |
| `crates/vault/src/backup2/spool.rs` | new |
| `crates/vault/src/backup2/snapshot.rs` | new |
| `crates/vault/src/backup2/mover.rs` | new |
| `crates/vault/src/backup2/retention.rs` | new |
| `crates/vault/src/backup2/restore.rs` | new |
| `crates/vault/src/backup2/drill.rs` | new |
| `crates/vault/tests/backup2_snapshot.rs` | new: the round trip, the writer-thread snapshot, the restore refusals |
| `crates/vault/tests/backup2_drill.rs` | new: the drill |
| `receipts/issue-1080-backups-v2.md` | new: this receipt |
| `docs/decisions.md` | appended: `## Backups from first principles (#1080)` |
| `CHANGELOG.md` | one line under Unreleased |

## Decisions

Lane B's rulings are rows in [docs/decisions.md](../docs/decisions.md#backups-from-first-principles-1080); each is summarised here with its evidence.

| Id | Ruling and evidence |
| --- | --- |
| **R-1080-B1** | The format is A8's: a 30-byte clear header (A8's field list sums to 30 where its text says 26), a key from the part's salt, and no `h` on the object (#1080). Evidence: `sealed::tests::the_header_is_thirty_bytes_in_a8s_order`, `the_sealed_bytes_carry_neither_the_plaintext_nor_its_hash`. |
| **R-1080-B2** | A part whose length the sealer did not know is re-sealed from its own temp file, never re-read from the source (#1080). Evidence: `a_file_is_sealed_in_one_pass_whatever_its_declared_length` over a right, a missing, a short and a long declaration. |
| **R-1080-B3** | The framing is canonical: the length field excludes the tag, every chunk but the last is full, only an empty part ends in an empty chunk (#1080). Evidence: `chunk_boundaries_frame_canonically`, `a_missing_final_chunk_and_a_trailing_byte_are_named`. |
| **R-1080-B4** | `NAME_TAKEN` is an acknowledgement (#1080). Evidence: `mover::tests::name_taken_is_an_acknowledgement`. |
| **R-1080-B5** | A retention period counts only if it holds a snapshot (#1080). Evidence: `retention::tests::a_gap_does_not_spend_the_periods`, red under the now-relative reading, which keeps today alone. |
| **R-1080-B6** | A snapshot cannot interleave with a commit, by construction (#1080). Evidence: the compile-time `!Sync` assertion, which fails with E0283 pointed at a `Sync` type (run once, reverted); `no_copy_is_made_inside_a_commit_and_one_between_holds_what_committed`, which also shows SQLite answers `BUSY` underneath; `a_snapshot_taken_while_another_thread_commits_is_exactly_a_committed_state`. |
| **R-1080-B7** | The census is counted on the scratch copy by the commit guard's rule (#1080). Evidence: `a_snapshot_tiles_the_file_and_names_its_ranges_from_their_bytes`, and the forged-census refusal. |
| **R-1080-B8** | A manifest moves after the parts it names and is spooled only once they are (#1080). Evidence: `the_queue_is_in_order_and_requeuing_replaces`, `a_pass_confirms_what_was_acknowledged_and_empties_the_spool`. |
| **R-1080-B9** | A part leaves the spool when the destination it moved to confirms it; other destinations by mirroring (#1080, [R-1080-8](../docs/decisions.md#backups-from-first-principles-1080)). |
| **Q-1080-B1** | The range size, put to the owner with the measurement: 4 MiB ranges re-seal 52 of 57 MiB after fifty small notes, 64 KiB ranges 6 MiB; recommended 64 KiB (#1080). The measurement used a throwaway `dbstat` test over two copies of the drill's vault, deleted after the run: about 300 of 14,601 pages changed, spread over some fifty b-trees. |

Findings outside lane B's files:

- **F-B1** — the old plane writes the tables rung 010 drops (#1080): `grep -rn "backup_object_range\|backup_base_range\|backup_blob_custody\|backup_blob_placement" crates --include=*.rs` → 25 lines in `crates/vault/src/backup/{base,custody,restore}.rs`, `crates/vault/tests/baseline.rs` and `crates/vault/tests/ladder_ddl.rs`. The root moved the rung to the cut-over.
- **F-B2** — `crates/media/README.md`'s conformance paragraph names two fixtures under `contracts/crypto/` and not `sealed-vectors.json`; the doc pass owns that file (#1080).

## Verification

Run in this worktree with `CARGO_TARGET_DIR=/home/user/cargo-target-lane-b`, on 2026-10-03, at `af60ff2b` plus this commit's registry files.

```sh
cargo fmt --all --check
cargo clippy -p centraid-media -p centraid-vault --all-targets -- -D warnings
cargo test -p centraid-media
cargo test -p centraid-vault
cargo run -p centraid-vault --bin export-ladder-ddl > ddl.sql && diff ddl.sql contracts/schema/vault-ddl.sql
cargo xtask rules
grep -rn "sha256" crates/media/src/sealed.rs crates/vault/src/backup2
```

- `cargo fmt --all --check` — exit 0, clean.
- `cargo clippy … -D warnings` — exit 0, no warnings.
- `cargo test -p centraid-media` — passed, exit 0: lib 84 (18 in `sealed`), `object` 7, `object_vectors` 1, `primitives` 2, `sealed_vectors` 1, doc-tests 0.
- `cargo test -p centraid-vault` — passed, exit 0: 517 tests in 35 binaries, 0 failed; the lib's 270 include the plane's 32, `backup2_snapshot` 3, `backup2_drill` 1 (13.9 s to 17.8 s); the old plane's tests, `baseline`, `ladder_ddl` and `one_hash` all green. The base commit `23e46810` ran 481 in the same binaries less the two new ones.
- `export-ladder-ddl` and `diff` — exit 0, no diff: the ladder did not move.
- `cargo xtask rules` — exit 0: `sql-confinement` green after `af60ff2b` (it was red on the vectors' sample, the finding that commit fixes), `abi-five-symbols`, `no-listening-socket`, `commonmain-no-platform-import` green.
- `grep -rn "sha256" …` — no match, exit 1.
- Red first, each recorded at the test that holds it: a flipped byte in every header field, a nonce, a ciphertext and a tag refuses; a part under another salt or another vault's keys does not open; the `!Sync` assertion fails to compile for a `Sync` type; a manifest forged with the vault's own keys is refused by the census and by `db_hash`; the vectors test failed on the changed sample before it was regenerated.
- `cargo build -p centraid-core` — not run: the root dropped it from lane B's exit list, because nothing lane B changed is visible to `crates/core`.

## Audit

No verdict from the author. The umbrella's independent review records one for lane B's section, against the diff and the commands above, at the close.
