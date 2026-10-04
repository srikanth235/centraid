# Receipt — backups from first principles ([#1080](https://github.com/srikanth235/centraid/issues/1080))

<!-- governance:front-page start -->
**Law** · window door · range `23e46810..f619515d` · law digest `a0140aaf3917` → `a0140aaf3917`

| Rule | Door | Verdict | Findings |
| --- | --- | --- | --- |
| `amendment-pairing` | hook | ✓ pass | 0 |
| `commit-message-format` | hook | ✓ pass | 0 |
| `constitution-coverage` | window | ✓ pass | 0 |
| `doc-integrity` | hook | ✓ pass | 0 |
| `doctrine-citation` | window | ✓ pass | 0 |
| `estate-separation` | hook | ✓ pass | 0 |
| `managed-tree-integrity` | hook | ✓ pass | 0 |
| `receipt-per-issue` | window | ✓ pass | 0 |
| `registry-completeness` | window | ✓ pass | 0 |
| `waiver-docket` | hook | ✓ pass | 0 |

law estate: 11 paths, CODEOWNERS in sync

### Registries

- rulings recorded: #8, #1020, #1025, #1029, #1045, #1080 in `docs/decisions.md`
- changelog entries: #1029, #1080
- no gates moved
- no waivers used
- proposal link unverified (offline)
- token cost: not recorded
<!-- governance:front-page end -->

Umbrella receipt. One receipt for the whole umbrella; each lane appends its own section below and never edits a section above it. The state this umbrella produces lives in [docs/decisions.md](../docs/decisions.md#backups-from-first-principles-1080) and, from the doc pass, in the state documents #1080 names; where this receipt and a doc disagree, the doc is current.

The umbrella is worked by orchestration ([docs/multi-agent.md](../docs/multi-agent.md)): wave 1 runs lane A (the gateway protocol v2, `crates/gateway2`) and lane B (the sealed format and the vault snapshot plane) in parallel; wave 2 is the cut-over; wave 3 the shells; wave 4 the doc pass and the close. The root's amendments to #1080 are in its seam contract; the two that reached lane B are named where they apply.

## What changed

### The umbrella, closed

The phone's backup is a **snapshot plane over sealed objects, moved by direct HTTPS to gateways the member controls**; the log-shipping plane, the iroh carrier and its relay, the lease, the device certificate and the running census are gone. Each lane's section below records its own files and commands; this close records the whole.

- **The gateway** (`crates/gateway`, lane A, renamed at the cut-over): protocol v2 over a self-signed P-256 certificate pinned at pairing, bearer tokens stored as BLAKE3, a writer epoch and `MOVED`, a filesystem store with tombstones, sweeps and a scrub, mDNS on the LAN, the `centraid-gateway` CLI (`serve`, `pair`, `pairings`, `scrub`, `health`, `install`), systemd and launchd units, the container image, and a 30-case conformance suite run in memory and over the wire.
- **The sealed format and the snapshot plane** (`crates/media::sealed`, `crates/vault::backup`, lane B): `centraid-sealed/2`, 64 KiB ranges (A14), keyed names, the ledger `<stem>.backup.db`, the spool, the mover, retention 7/4/6 and garbage as pure functions, restore refusals, the drill.
- **The phone core on the plane** (`crates/core::phone`, lane C): pair, drain, handoff, settle, reconcile, pins, fetch original, forget destination, releasable and released, restore from the 24 words with the old phone frozen; the stage door v2 that seals a library item in the same stream it hashes; the directory content store (`crates/blobs`); rung 010; the cut-over's deletions; the end-to-end drill across the real gateway in the gate.
- **The shared half** (`mobile/shared`, lane D): the pass model (prepare, move, settle), the walker streaming from the OS library, the Backup screen and Home's line, pairing v2, free up space through an installed deleter, the Restore gate on a pairing code (A23), the ask bit (A24).
- **The native shells** (`mobile/iosApp`, `mobile/androidApp`, lane E): the iOS background URLSession mover and its windows, the Android process session and jobs, the Backup screens, the library deleters behind the system's own confirmation, the device hand-off rows.
- **The docs** (lane F, two rounds, stopped by the owner before its third): ARCHITECTURE, SECURITY, README, TESTING, docs/gateway.md, the recovery runbooks, mobile-offline, photos, glossary, the retired traps, decisions supersessions; the root's close pass covered what the gates needed after the cut-over.

### Wave 1, lane B — the sealed format and the vault snapshot plane

Everything here stands beside the plane it replaces and nothing a member runs calls it yet: `crates/vault/src/backup/**`, `crates/media/src/object/**` and the migration ladder are untouched, and the cut-over wires the new plane and deletes the old one.

**`centraid-sealed/2`** (`crates/media/src/sealed.rs`). Every object a gateway stores is a part of at most 64 MiB of one file's plaintext. A file is hashed and sealed in the same stream (`FileSealer`), so a source is read once — the root's amendment A8, which replaced the first cut of the format (a sealed header carrying `h`, commit `bb58ef9f`) with a 30-byte clear header that carries nothing about the file: magic, version, flags, part index, part length and a 16-byte random salt, the AAD of every chunk. A part's key is `derive_key("centraid backup v2 object", K_backup ‖ salt)`; its name is `hex(keyed_hash(K_name, h ‖ u32be(i)))`, computed once `h` is known. Chunks are 4 MiB of payload under XChaCha20-Poly1305 with a random nonce each, AAD `header ‖ u32be(index) ‖ u8(is_last)`; ranges and manifests are zstd level 3, media is not. Opening needs only `K_backup`; a file's identity is checked where it is known — `open_whole` against the name a one-part file was fetched by, `assemble` and the streaming `Assembler` against `h`. A part whose length the sealer did not know is re-sealed from its own temp file. `contracts/crypto/sealed-vectors.json` pins every derived value and opens committed samples on every run.

**The snapshot plane** (`crates/vault/src/backup2/`, beside `crate::backup`):

- `naming` — the vault's keys from the root key's bytes, and the names its content items and derivatives imply;
- `store` — the synchronous `Store` trait (the protocol v2 object and head routes as Rust calls) and `MemoryStore`, which models the compare-and-set head, the tombstone grace, `HEAD_IN_USE` and the epoch fence;
- `ledger` — `<stem>.backup.db` with #1080's five tables, `application_id` `CBL1`, a version that refuses a newer ledger;
- `spool` — `<stem>.spool/`, one sealed part per name, written as a `.partial`, fsynced and renamed, under a budget of 2 GiB or a tenth of the free space;
- `snapshot` — the page-identical copy in one `sqlite3_backup` step, under a scratch name no other copy can share, the census, 4 MiB ranges and their names, the manifest in #1080's key order; `plan`, `spool` (which re-checks each range's bytes against its name before sealing) and `settle`;
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
| `2a2a12a8` | docs(receipts): open the #1080 receipt with lane B's wave 1 (#1080) |
| `42454fd4` | fix(vault): never share a scratch copy, and verify a range before sealing (#1080) |

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
| `crates/vault/src/backup2/snapshot.rs` | new; 7 unit tests |
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

### On the closed tree

Run by the root in `/home/user/centraid` on the umbrella branch at `7916e23d8`, 2026-10-04, `CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=/home/user/cargo-target-shared`:

```sh
cargo xtask gate --profile pr
cargo xtask gate --profile mobile-jvm
cargo check --workspace --all-targets --target x86_64-pc-windows-gnu
bash .governance/run.sh < /dev/null
grep -c iroh Cargo.lock
```

- `cargo xtask gate --profile pr` — PASS. `fmt`, `clippy`, `test` (237.3 s, `cargo test --workspace`), `restore-drill` (30.0 s: back a vault up, lose it with its ledger and spool, restore it row for row; then lose the phone, restore from 24 words across the real gateway, and freeze the old one), `rules` (4 rules, clean), `ledgers` (5 hold against `23e46810`), `buf` (lint and breaking against `main`, 0 tags in the window), `release-build` (204.7 s of 1,400 s), `ts-static`, `emitters`, `advisory`, `lockfile`, `call-budget`, `fault-door` all ok. Loud skips, not passes: `deny`, `ci-policy`, `secrets` and `osv`, because `cargo-deny`, `actionlint`, `gitleaks` and `osv-scanner` are not installed in this container; `gate.yml` installs and runs them in CI.
- `cargo xtask gate --profile mobile-jvm` — PASS, 49.1 s of a 420 s budget (the generated trees `design`, `copy`, `mobile` and `contracts/screens` unchanged after the emitters and the JVM tests).
- The Windows type-check — exit 0 on `0a5a51b71`'s tree with a mingw cross-compiler (`gcc-mingw-w64-x86-64`), every workspace target; the MSVC target cannot be checked here because SQLite's and zstd's bundled C need MSVC, so CI's Windows legs are the proof for that triple.
- `bash .governance/run.sh < /dev/null` — every directive passes; the law's window door runs 10 rules with no findings (the receipt staged).
- `grep -c iroh Cargo.lock` — `0`.

Run in this worktree with `CARGO_TARGET_DIR=/home/user/cargo-target-lane-b`, on 2026-10-03, at `42454fd4`.

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
- `cargo test -p centraid-vault` — passed, exit 0: 519 tests in 35 binaries, 0 failed; the lib's 272 include the plane's 34, `backup2_snapshot` 3, `backup2_drill` 1 (8.7 s to 17.8 s across runs); the old plane's tests, `baseline`, `ladder_ddl` and `one_hash` all green. The base commit `23e46810` ran 481 in the same binaries less the two new ones.
- `export-ladder-ddl` and `diff` — exit 0, no diff: the ladder did not move.
- `cargo xtask rules` — exit 0: `sql-confinement` green after `af60ff2b` (it was red on the vectors' sample, the finding that commit fixes), `abi-five-symbols`, `no-listening-socket`, `commonmain-no-platform-import` green.
- `grep -rn "sha256" …` — no match, exit 1.
- Red first, each recorded at the test that holds it: a flipped byte in every header field, a nonce, a ciphertext and a tag refuses; a part under another salt or another vault's keys does not open; the `!Sync` assertion fails to compile for a `Sync` type; a manifest forged with the vault's own keys is refused by the census and by `db_hash`; the vectors test failed on the changed sample before it was regenerated; `a_scratch_copy_that_changed_after_it_was_named_is_not_spooled` failed with the check disabled.
- `cargo build -p centraid-core` — not run: the root dropped it from lane B's exit list, because nothing lane B changed is visible to `crates/core`.

## Audit

**REFUTED**, on one class of claim; every command the lanes quote reproduces. The umbrella's state documents say a member gets an original back by opening it (`docs/photos/README.md:127`), that originals follow a restore under the transfer rule (`docs/recovery/backup-restore.md:43`), and that the phone browses for a moved gateway (`docs/gateway.md:145`, `docs/recovery/pairing.md:45`, `SECURITY.md:50`). None of the three is wired: nothing serves `ScreenEffect.FetchOriginal`, nothing fetches originals by rule, and no shell browses. That refutes lane F's "every state document describes the new plane as current state", and it leaves Free up space with no in-app way back to what it deletes. The format, the gateway, the snapshot plane, the restore, the fence and blindness all held under tamper and an adversarial run. Reviewed at `03d49d0f8`. Lane E's last round, the library deleters, had not merged by 22:47 UTC, so lane E is audited as of that tip; once those deleters are installed, a member can reach finding 1.

| Check | Command | Result | Verdict |
| --- | --- | --- | --- |
| 1a. Lane A: 30 conformance cases in memory and over the wire | `cargo test -p centraid-gateway --test conformance --test conformance_wire` | 2 passed, 30 named cases each | PASS |
| 1b. Lane B: R-1080-B1/B3, a part carries neither plaintext nor `h`, any flipped byte refuses | `cargo test -p centraid-media --lib sealed::`, `--test sealed_vectors` | 18 and 1 passed | PASS |
| 1c. Lane C: a restore claims only after its checks; rung 010 | `cargo test -p centraid-core --test phone_backup`; `-p centraid-vault --test backup_snapshot --test backup_v2_rung`; `export-ladder-ddl` diffed | 6, 3 and 1 passed; no diff | PASS |
| 1d. Lane D: A24, only "Back up now" asks | `cargo test -p centraid-core --lib under_manual_only_the_members_tap_lets_an_original_through`; `mobile/gradlew -p mobile :shared:jvmTest --tests '*ShelfDrainSpec*' --tests '*CoreBackupDoorsSpec*' --offline --rerun` | 1 passed; 19 and 8, 0 failed | PASS |
| 1e. Lane E: one background session, exact-DER pin, launch events, power and network on both submitters | `grep -rn "background(withIdentifier\|sessionSendsLaunchEvents\|SecCertificateCopyData\|requiresExternalPower"` over `mobile/iosApp/Sources`, `mobile/shared/src/iosMain` | as claimed (`BackgroundUploads.swift:358`, `presented == pinned`, both submitters `true`); uncompiled here, hand-off rows 8.x | PASS |
| 2. Blindness, and tamper | both canaries; a throwaway drill copy scanning 68 needles (the 24 words, seed, identity, box, Locker and root keys, `K_backup`, `K_name`, token, pairing secret, vault and note text, `db_hash`) after each snapshot; byte flips in the gateway's files | 0 hits in 59 and 78 files. Flip, digest stale: `fetch_original` `UNREACHABLE`, nothing stored. Flip, digest forged: refused, `chunk 0 does not open`. Head range flipped and forged: restore refused, writer epoch still 2. Malformed name `400 BAD_REQUEST`, traversal `404`, wrong digest `DIGEST_MISMATCH` | PASS |
| 3. Adversarial, real gateway | throwaway test on `server::harness::spawn` and the client | `NAME_TAKEN` with the held digest, first bytes kept; head without manifest `NOT_FOUND`; another vault's, an unknown vault's and a forged token `UNAUTHORIZED`; `fetch` of 1,001 names `TOO_MANY`, 4 × 64 MiB `TOO_LARGE`; `PUT` 80 MiB + 1 `TOO_LARGE`; read grant writes `MOVED{1}`; claim without `head_seen` `HEAD_CONFLICT`, replayed `EPOCH_CONFLICT`; old token after the claim `MOVED{2}`, reads still answer, the new writer's objects included; a token after `forget_destination` still writes. As the rules say, except the last (finding 2) | PASS |
| 4. Sweeps | CHECK values against writers; the 25 names #1080 reserved against `crates/`, `mobile/` `.kt` and `.swift`; `grep -c iroh Cargo.lock`; `grep -rn "sha256\|Sha256" crates`; `cargo xtask rules` | 010 has no CHECK; every ledger and gateway CHECK value has a writer, none outside. One reserved name live (finding 6). `iroh` 0. `sha256`: `identity`'s RFC 9180 files only, pre-#1080 and allowlisted (`one_hash` 4 passed). Rules 4 ok | PASS |
| 5. Gates | `cargo xtask gate --profile local`, warm, twice; `bash .governance/run.sh < /dev/null` | every step ok (test 241.8 s, restore-drill 30.3 s), `FAIL — over budget`, 286.9 s of 120 s, as before #1080 (#1029: 152.7 s; #1020: 285.7 s); lane C's PASS was cold. run.sh: one finding, this verdict | PASS, budget open |
| 6. Rulings | below | three stay, one question, one should not wait | — |

### Findings

1. **No original comes back in the product.** `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/sync/ScreenRuntime.kt:265`: `ScreenEffect.FetchOriginal` (emitted by `PhotosGridMachine.kt:216`, `PhotoLightboxMachine.kt:463`) has no consumer, and `CoreBackupDoors.fetchOriginal` (`:77`) has no caller outside its spec. `crates/core/src/phone/fetch.rs`' only callers are the tap and the restore's derivatives, so nothing fetches by rule, and `ByteStore::sweep`, the eviction `docs/photos/README.md:127` describes, has no caller. Fix: serve the effect through `fetchOriginal` and settle the cell; correct both documents; keep Free up space's row off until the tap lands.
2. **A gateway token is never revoked.** `crates/core/src/phone/mod.rs:321` deletes the ledger row only, and the gateway has no revoking route or verb (`pairings` lists). A forgotten or superseded phone reads every later snapshot. Fix: a self-revoke route `forget_destination` calls, `centraid-gateway pairings revoke`, and the residual named in `SECURITY.md`'s "A lost phone".
3. **A browse that does not exist.** It is described in `docs/gateway.md:145`, `docs/recovery/pairing.md:45` ("found again"), `SECURITY.md:50,56` and `mobile/iosApp/project.yml:189-191`; no `NWBrowser` or `NsdManager` exists under `mobile/`. Fix: "pair again after an address change" until Q-1080-D3 lands.
4. **MANUAL reports time as the wait.** `crates/core/src/phone/drain.rs:268-273`: an original MANUAL holds back reports `WAIT_REASON_WINDOW` ("nothing but time"), but only a tap moves it. Fix: its own reason when the rule is MANUAL and the pass was not asked.
5. **Damage and impostors read as unreachable.** `crates/core/src/phone/link.rs:93-98` folds `Untrusted` and `Protocol` (bytes failing their digest) into `Unreachable`. Fix: their own `StoreError` and outcome.
6. **Stale names.** `mobile/iosApp/Tests/ScreenFixtureTests.swift:129` asserts the reserved `backup.transport == .irohBlobs`, so the iOS test target cannot compile. Also stale: `VaultFileProtection.swift:38` (`backup2/ledger.rs`), `ScreenMachine.kt:190-199` and `ScreenRuntime.kt:265-276` (no `fetch_original` arm, `backup_blob_placement`), `crates/centraid/src/cmd/mod.rs:44` ("a base and a txid"). Fix: delete or reword each.
7. **The drills run twice per local loop.** `crates/xtask/src/gate.rs:743`: `test` already runs both `restore_drill` binaries (29 s). Fix: exclude them from `test`.

### Re-judged rulings

- **R-1080-C13** stays. Sealing a film costs battery and heat, and MANUAL is the member's choice. It is honest only once finding 4 is fixed.
- **R-1080-C14** is a question for the owner. The records are the vault, a 64 KiB-range snapshot is a few MB, and a tap is consent. (a) Keep it; (b) a tap sends records over a metered link under any rule but MANUAL. **Recommend (b).**
- **A22** stays. FILE's consumer, the #1029 gateway speaking core.v1, is gone, and a shell ships with its core. WIRE_JSON still guards the numbers, wire types and JSON names the committed `.bin` fixtures need.
- **A24** stays. Without the tap's own bit, C13 and MANUAL cannot tell a member from a schedule.
- **Q-1080-D1** can stay open. It is copy only; "computer" fits a VPS or a NAS.
- **Q-1080-D3** should not be a follow-up. The Decision names the browse, iOS already asks for the local network and declares the type, and four documents promise it. Build (a) for v1, or fix finding 3 now. Q-1080-1, 2 and 4 remain the owner's.

### Re-audit on `b916aea42`

**PASS.** The claim that refuted the first verdict is gone, and each of the seven findings is fixed in the tree or recorded where the round said it would be.
- An opened original now reaches `fetch_original` and settles its cell.
- The documents promise neither a refill by rule nor a browse.
- A phone revokes its own token when it forgets a gateway, and an operator can revoke a lost phone's token.

Lane E's deleters section, at the end of this receipt, was re-read. Its three shell fixes are in the tree. Its "found" items are resolved in the documents, except the camera string, which waits on Q-1080-D1. C14 is superseded by R-1080-C38, as recommended. The first table's `sha256` row undercounted: a `head` cut the grep short. The full grep matches 13 files under `crates/`, each with the same count at `23e46810`, and none in the #1080 plane.

| Finding | Command | Result | Verdict |
| --- | --- | --- | --- |
| 1. An original back on demand | `mobile/gradlew -p mobile :shared:jvmTest --rerun --offline`; consumers of `ScreenEffect.FetchOriginal` | 1,112 tests in 75 suites, 0 failed (`PhotoLightboxSpec` 45, `CoreBackupDoorsSpec` 11, `FreeUpSpec` 9). `ScreenRuntime.serveFetch` serves the grid's and the lightbox's taps, and both settle `FetchSettled` | PASS |
| 2. Revocation | `cargo test --workspace --test conformance --test conformance_wire --test revoke --test phone_backup`; a throwaway revoke-then-read against the harness | 31 cases each way; `revoke` 2 passed; `forgetting_a_gateway_revokes_this_phones_token_there` passed. Throwaway: a phone's forget answered `revoked true`, then `UNAUTHORIZED` on its `PUT` and head. A superseded token read the new writer's object; after `revoke_hash` from a second open of the served data directory (the CLI's path), it got `UNAUTHORIZED`. An epoch-0 token revoked itself; another vault's token cannot revoke here; the writer still writes | PASS |
| 3. No browse claimed | `grep -rn -i browse` over the state documents and `project.yml` | every one says no shell browses; the payload lists `<host>.local` last (`addrs.rs:38`) | PASS |
| 4. MANUAL waits for a tap | `cargo test --workspace --lib -- phone::drain::` | 7 passed, `an_original_manual_holds_waits_for_the_members_tap` among them; `WAIT_REASON_ASK` is mapped (`CoreBackupDoors.kt:162`) | PASS |
| 5. Damage and impostors | `phone_backup` (8 passed, `a_machine_that_is_not_the_pinned_gateway_is_untrusted_and_a_damaged_copy_is_damaged` among them); `-- backup::mover::` (10 passed); the first audit's tamper run, again | a stale digest gives `FETCH_OUTCOME_DAMAGED`, and so does a forged one, with nothing landed; canary, 0 of 68 needles; a tampered head range: the restore is refused and the epoch stays 2 | PASS |
| 6. Stale names | greps for `irohBlobs`, `backup2`, `backup_blob_placement`, `custody::open_blob`, `txid` | none | PASS |
| 7. Budget and the twice-run drill | `QUALITY.md:6`; `cargo xtask gate --profile local` | recorded as pre-existing. Every step ok; 288.8 s against 120 s; `FAIL — over budget` as before | PASS (recorded) |
| C38, gates | `a_tap_sends_the_records_over_a_metered_link_under_any_rule`; `cargo xtask gate --profile mobile-jvm`; `bash .governance/run.sh < /dev/null` | passed; `PASS`, 71.8 s of 420 s; all 6 directives pass, the law included | PASS |

Two small items remain. No receipt claims otherwise.

1. **The `.local` name can be cut from the payload.** `crates/gateway/src/server/addrs.rs:38-40` pushes the name after every interface address and then calls `truncate(MAX_ADDRS)` (8). A host with eight or more IPv4 addresses, such as one with Docker networks or a VPN, loses the name the documents say is listed. Fix: cap the interface addresses at `MAX_ADDRS - 1` before pushing the name.
2. **A damaged head reports `INTERNAL`.** `crates/core/src/phone/restore.rs:313` answers a restore that meets a damaged head with `INTERNAL` ("core invariant … does not open"). The restore is refused and claims nothing, as it should, but the member hears an internal error. Fix: give `StoreError::Damaged` and an unopenable range their own refusal.

### Lane F — the docs

Every state document #1080 names now describes the new plane as current state, and the old one only as history cited by issue link: gateways the member controls reached over direct HTTPS with a pinned certificate, snapshots in 64 KiB ranges, sealed originals and derivatives, the ledger and the spool, the pass, and the restore that reads, checks, then claims. Written from the issue, the root's seam contract (A1–A18), lane B's merged plane, lane A's merged crate and its README (the source of truth for the gateway, on the root's word), lane D's merged shared module, and lane E's and lane C's work in flight. No build was run: the lane's checks are the docs' own.

Branch `worktree-agent-ad555fbcf690bfe7d`, cut from `23e46810` and fast-forwarded to the umbrella tip `1e620bf7` before its first commit; the umbrella was merged in again at `e0079c08` when lanes A and D landed.

| Commit | Subject |
| --- | --- |
| `c056362c` | docs(gateway): protocol v2, its runbooks and the deploy READMEs (#1080) |
| `734d285f` | docs: architecture, threat model and README describe backup v2 (#1080) |
| `0da954e9` | docs: the pass, glossary, traps and gate docs describe backup v2 (#1080) |
| `e0079c08` | Merge branch 'ccr-ffb8b956-lwxeta' into worktree-agent-ad555fbcf690bfe7d |
| `9378b364` | docs(gateway): follow the merged gateway2 README and A16 to A18 (#1080) |
| this commit | docs(decisions): what #1080 superseded, and the lane F receipt (#1080) |

| File | Change |
| --- | --- |
| `docs/gateway.md` | rewritten: protocol v2's routes, objects, tokens and writer epochs, the three pairing kinds, refusal codes, the six commands, the certificate, pairing and the safety number, discovery, the data directory and what a stolen copy yields, the sweeps, self-hosting, mirroring as designed-not-built, versioning |
| `docs/recovery/backup-restore.md` | rewritten: what a backup is, the pass, retention, invariants, restore step by step, the symptoms with the v2 codes, the drill, the schema-change checklist with rung 010 as its example, what not to do |
| `docs/recovery/pairing.md` | rewritten: pairing v2, more than one gateway, durable state with `tls.key` as the identity, `node.key` as history, recovery steps including `PIN_MISMATCH` and a stolen data directory |
| `deploy/README.md` | rewritten: one gateway, one way in; the service units; the container on the host's network; the installer |
| `deploy/gateway-server/README.md` | rewritten: running a gateway on a box you own |
| `ARCHITECTURE.md` | the shape, the two programs, the crate table (`gateway`, `media`, `blobs`, `identity`), the shell, what crosses to a gateway, authorization, on-disk layouts, at-rest formats, backup and recovery |
| `SECURITY.md` | the threat model and the claim register rewritten; the threat-model heading kept byte-identical for the three decisions rows that link it |
| `README.md` | the pitch, the diagram, getting started, gateway install, the command list, the Devices row |
| `docs/mobile-offline.md` | current sections first (files, the pass, the rule, the spool budget, the per-state promise); #1029's seat-plane record kept below a rule |
| `docs/photos/README.md` | Derivatives; Keeping originals, and freeing space; the Backup row |
| `docs/glossary.md` | a Backup section; pairing, gateway, transport, byte plane, drain, drill, daemon, the Owners section and five synonym rows rewritten; the pair ticket, custody state and the generation vocabulary retired |
| `docs/traps/wal-checkpoint.md` | rewritten around the online backup API |
| `docs/traps/README.md` | four rows removed, the WAL row rewritten |
| `docs/traps/worktrees.md` | the seat socket and seat processes |
| `docs/traps/byte-store-lock.md` | deleted: iroh-blobs leaves |
| `docs/traps/census-around-the-guard.md` | deleted: the census is counted on the scratch copy |
| `docs/traps/first-dial-readiness.md` | deleted: iroh leaves |
| `docs/traps/migration-header-is-a-format.md` | deleted: no dictionary |
| `TESTING.md` | profiles as `gate.rs` has them, the drill row, no `vps-smoke`, the vectors, the `backup-measurement` device lane, no `no_listener.rs` |
| `docs/toolchain.md` | the same profile facts and the device lane |
| `docs/release.md` | installing a gateway and the real-VPS hand-off |
| `docs/dev-environment.md` | the gateway loop and the profile rows |
| `docs/logs.md` | the two binaries, where a gateway's output lands, the phone's backup state and settle codes, the drill's timing path, what is not a log |
| `docs/protocol.md` | the gateway transport section, the version paragraph, the queued-backup paragraph |
| `docs/external-review-scope.md` | the covered table, Review A's gateway plane and sealed format, Review C's egress list |
| `docs/decisions.md` | appended: four open questions and Q-1080-B1's answer to lane B's table; `### Supersessions closed by #1080` |
| `CHANGELOG.md` | one line under Unreleased for the docs |
| `receipts/issue-1080-backups-v2.md` | this section |

**Rulings this lane took** (the root records them):

| Id | Ruling and reason |
| --- | --- |
| **F-D1** | Commit trailers name the model that wrote them, as the root accepted for C-D9 and A-D1 (#1080). |
| **F-D2** | #1029's seat-plane record stays in `docs/mobile-offline.md`, below a rule and after every current section, because `docs/blueprint-seats.md` links `#one-stream-three-occasions` and an append-only decisions row links `#background-work-and-push-privacy`; its two links into the deleted `crates/seat` became text (#1080). |
| **F-D3** | The gate docs follow `crates/xtask/src/gate.rs`, which they had drifted from before #1080: `restore-drill` is in `local` and so in every profile, there is no `vps-smoke`, and `artifact-identity` and `prebuilt-core-required` are `release`'s (#1080). |
| **F-D4** | The write claim's wire kind is written `claim`, as lane A's `PairKind` and README spell it; A18 calls the two claims `read` and `write` (#1080). |
| **F-D5** | The open questions continue lane B's `### Open questions for the owner (#1080)` table, the file's last lines, instead of a second subsection whose anchor would collide; Q-1080-B1's answer is a new row (#1080). |
| **F-D6** | `no-listening-socket` is registered as enforced statically, with no runtime half, because `crates/centraid/tests/no_listener.rs` went with the seat plane in #1029 and three documents still cited it (#1080). |

**Found outside this lane's files**, for the root:

- `mobile/README.md` (lane D): `:186` the iOS transfer experiment row; `:316` pairing by `centraid-gateway invite`, "claims the lease"; `:327` and `:329` the device secret; `:330` "grant the lease", "moved no lease"; `:333` "No Bonjour and no local-network permission" — `grep -n "ios-transfer\|invite\|lease\|device secret\|No Bonjour" mobile/README.md`.
- No lane owns: `AGENTS.md:35` (the vocabulary still defines a generation as a base plus its segments); `docs/enrollment.md:85,89,90,99` (invites, `node.key`, and a link to the `#nodekey` section `docs/gateway.md` no longer has); `docs/config-ownership.md:36` (the device key and `backup/laptop.json`); `docs/vault-ontology.md:32` (generation, base, segments, dictionary, `object-vectors.json`); `docs/blueprint-seats.md` (links into the seat record); `scripts/docs-site/src/content/{learn,index,understand,devices,start}.html` name iroh — `grep -rlni iroh scripts/docs-site/src/content/`.
- Lane C's: `contracts/README.md:20` and `crates/core/README.md:16` link the deleted traps; `contracts/README.md:21,22,24` describe `object-vectors.json`, the gateway schema's leases and invites, and the old units' tests; `crates/core/src/app_query/docs_tests.rs:483` cites `byte-store-lock.md`; the `ios-transfer-experiment` device lane in `gate.rs`, `gate-nightly.yml:193` and `contracts/handoff/E/device-lane-bodies.md`; the deploy tree beside the new image (`deploy/docker`, `deploy/gateway-server/Dockerfile`, `deploy/systemd`, `deploy/launchd`, `deploy/vps/install.sh`), whose units run `centraid gateway --data-dir`, a verb `centraid` no longer has.
- `docs/decisions.md:1821` (T-1029-1) and `:2077` (R-1047-R1) link two deleted traps; both rows are append-only, so the supersessions table records the links as history.
- Lane E's Photos More sheet offers no "Free up space" verb, while #1080's shell scope and this lane's brief describe one; R-1080-E1 ("never cross a metered link") predates A10's `allows_cellular`.
- `CHANGELOG.md`'s first #1080 line says 4 MiB ranges; A14 made them 64 KiB, which the cut-over's own line can say.

**Waiting on another lane.** Twelve links resolve when the cut-over renames `crates/gateway2` to `crates/gateway` (four) and lane E's `mobile/maestro/backup-measurement.md` and its decisions section land (eight). Facts written from the contract and checked when lane C reports: the drill the `restore-drill` step runs, the pragmas, `centraid`'s verbs, the identity files that leave, `local_bytes`, and the restore's multi-vault claim test the claim register names.

#### Verification

Run in this worktree on 2026-10-03, at this commit's tree. No cargo command: the lane changes no code.

```sh
bun run format && bun run format:check
grep -rln "internal-doc-links\|markdown-link\|checkLinks\|broken internal link" scripts .governance/law crates/xtask package.json
python3 <scratchpad>/linkcheck.py . <the 23 touched markdown files>
grep -n "iroh\|pkarr\|iroh-dns\|gateway-core\|gateway-client\|gateway-server\|invite\b\|GATEWAY_HEAD_CONFLICT\|acked_txid\|backup_blob_custody\|ios-transfer" <the owned state docs>
git diff 9378b364 -- docs/decisions.md | grep -c "^-[^-]"
bash .governance/run.sh
```

- `bun run format` then `bun run format:check` — "All matched files use the correct format", 525 files.
- The link-checker grep — `scripts/docs-site/smoke.mjs` and its README (the built site's smoke) and one law fixture: the repo has no committed checker for markdown links, so a scratch one resolved every relative path and GitHub anchor in the 23 files. 14 unresolved: the twelve forward links above, and the two decisions rows above.
- The old-names grep — nine lines, eight citing history by issue link (`ARCHITECTURE.md:45`, `README.md:145`, `docs/recovery/backup-restore.md:74`, `docs/recovery/pairing.md:34`, `docs/mobile-offline.md:215`, `docs/glossary.md:58,62,287`); the ninth, `deploy/README.md:15`, is the path of `deploy/gateway-server/README.md` itself, which the cut-over can move beside `deploy/gateway/`.
- `docs/decisions.md` is a pure append: 0 removed lines.
- `bash .governance/run.sh` — one finding, `receipt-per-issue`: this receipt's `## Audit` records no verdict, which the close pass writes. Every other directive and rule green.
## Wave 3 — the native shells (lane E)

The iOS background mover, the processing windows, the Android jobs, the Backup screen and Home's backup line, on both shells. **Nothing here has been compiled**: there is no Xcode and no Android SDK in the container that wrote it, so every claim that needs one is a device hand-off row in [v1-handoffs.md §8](../docs/release/v1-handoffs.md#8-the-backups-native-halves-1080) with the command that proves it. Built in parallel with lanes C and D against the seam contract the root fixed on 2026-10-03 (its §1–§4, amendments A1–A9); the umbrella's proto commit (`f9791e17`) is merged in, and lane D's Kotlin seam and `screen.proto`'s Backup block are not yet, so every name this lane needed beyond the contract is listed below as an assumption.

### What landed

**Slice 1 — the iOS mover and the windows** (`32b0533d`):

| File | Change |
| --- | --- |
| `mobile/iosApp/Sources/BackgroundUploads.swift` | new: the one background `URLSession` (`dev.centraid.uploads`) behind `BackgroundUploads`; exact-DER pinning per task's gateway; the ordered settle road to `UploadEvents` with relaunch hold and completion-handler cap; `UploadPins`; `ForegroundGrace` (the `beginBackgroundTask` wrapper) |
| `mobile/iosApp/Sources/AppDelegate.swift` | new: `handleEventsForBackgroundURLSession` and the launch-time reconnect |
| `mobile/iosApp/Sources/BackgroundPasses.swift` | processing request on power and network; `resubmitAll()` at every background entry; resubmit after each pass; cold-launch wait for the pass; `setTaskCompleted` exactly once |
| `mobile/iosApp/Sources/CentraidApp.swift` | the delegate adaptor, `ShellModel.shared`, `.background` arms the windows |
| `mobile/iosApp/Sources/ShellModel.swift` | `static let shared`; graced foreground passes; `wentToBackground()`; the mover's seam in one place (`wireUploads`, `refreshUploadPins`) |
| `mobile/iosApp/Sources/VaultFileProtection.swift` | the R-1029-8 table: vault, store, ledger, spool and the pins file named |
| `mobile/iosApp/project.yml`, `mobile/iosApp/Resources/Info.plist` | `NSBonjourServices: [_centraid-gateway._tcp]`; the local-network sentence says the phone finds the laptop too |
| `mobile/iosApp/Tests/BackgroundUploadTests.swift` | new: 13 XCTests over the pure half, each law with its negative case |

**Slice 2 — the Android jobs** (`aa94e868`):

| File | Change |
| --- | --- |
| `mobile/androidApp/src/main/kotlin/dev/centraid/android/backup/ProcessSession.kt` | new: one `HomeSession` per process, counted, acquired and released on one thread in order |
| `mobile/androidApp/src/main/kotlin/dev/centraid/android/backup/BackupNow.kt` | new: the user-initiated job (API 34+), the `dataSync` foreground service (below 34), their notification, and the pass body they share |
| `mobile/androidApp/src/main/kotlin/dev/centraid/android/CentraidApplication.kt` | installs the worker body and the backlog hook |
| `mobile/androidApp/src/main/kotlin/dev/centraid/android/MainActivity.kt` | holds the process session for the composition's life; the first pass launched, not awaited |
| `mobile/androidApp/src/main/AndroidManifest.xml` | `ACCESS_MEDIA_LOCATION`, `RUN_USER_INITIATED_JOBS`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC`, `POST_NOTIFICATIONS`; the two services |
| `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/PhotoAccessRemedy.kt` | the photo request carries `ACCESS_MEDIA_LOCATION` from Android 10 |

**Slice 3 — the screens** (`fe2729ae`, `7afffede`, `00ac3ee8`):

| File | Change |
| --- | --- |
| `mobile/iosApp/Sources/BackupViews.swift` | new: `BackupScreenModel`, `BackupEvents`, `BackupLineView`, `BackupView` (idle timer while "Back up now" runs) |
| `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/backup/BackupScreens.kt` | new: the same model and events, `BackupLineRow`, `BackupSheets` (notification grant at the tap, the job, the battery remedy) |
| `mobile/iosApp/Sources/HomeView.swift`, `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/HomeScreen.kt` | the backup line under the lockup |
| `mobile/iosApp/Sources/ShellModel.swift`, `mobile/iosApp/Sources/CentraidApp.swift`, `mobile/androidApp/src/main/kotlin/dev/centraid/android/MainActivity.kt` | the Backup sheet, its bridge, "Add a gateway" handing over to `pair.laptop`, a grace held while "Back up now" runs, pins refreshed when the gateways change |
| `mobile/iosApp/Sources/PhotosMoreSheet.swift`, `mobile/iosApp/Sources/StateViews.swift`, `mobile/iosApp/Sources/BackupStatus.swift`, `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/PhotosGridScreen.kt` | the camera-roll import sheets lose the transport row and stop speaking of a backup |
| `mobile/iosApp/Sources/VaultHeader.swift`, `mobile/androidApp/src/main/kotlin/dev/centraid/android/kit/VaultHeader.kt` | the lockup's comment points at the backup line that now exists |
| `mobile/maestro/flows/selectors.md` | the Backup screen's ids, one string on both shells |

**Slice 4 — the measurement** (`ac6cd258`): `mobile/maestro/ios-transfer-experiment.md` deleted; `mobile/maestro/backup-measurement.md` new; `mobile/maestro/README.md` points at it.

**Registry**: this section; `docs/decisions.md` (R-1080-E1…E10 and two supersessions); `docs/release/v1-handoffs.md` (§8, rows 8.1–8.15; row 7.1 marked superseded).

### Rulings spent

#1080 rulings 1 (the pin), 2 (the OS carries the bytes on iOS), 6 (media from where it lives — the location grant) and 7 (acknowledgement is the PUT's success, the ledger a cache that `reconcile` repairs); [R-1029-8](../docs/decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21) (every vault-derived path out of OS backup — the sweep's table names the ledger, the spool, the store and the pins file); [R-1020-20](../docs/decisions.md#v1-platform--rust-core-kmp-shell-electron-seat-gateway-anywhere-1020) (no simulator number is promoted — the measurement names a reference device); D-1025-S7-72 and S7-75 (the prompt is real; a limited grant keeps "Select more photos").

### Decisions this lane made

Each is recorded in [docs/decisions.md](../docs/decisions.md#the-native-shells-backup-half-1080) with its reason.

| Id | Decision |
| --- | --- |
| **R-1080-E1** | OS-moved uploads never cross a metered link: a part carries no media kind ([#1080](https://github.com/srikanth235/centraid/issues/1080) ruling 2's session cannot keep "a video never on cellular" per part). Deviates from the brief's "`allowsCellularAccess` from the rule". |
| **R-1080-E2** | One background session, `dev.centraid.uploads`, not discretionary ([#1080](https://github.com/srikanth235/centraid/issues/1080)); iOS makes background-started transfers discretionary itself. |
| **R-1080-E3** | The pin is exact DER equality per task's gateway, kept in `Documents/.centraid-upload-pins.plist` for a cold relaunch ([#1080](https://github.com/srikanth235/centraid/issues/1080) ruling 1, A6). |
| **R-1080-E4** | One `ShellModel` per process on iOS; a window waits up to 20 s for the pass ([#1080](https://github.com/srikanth235/centraid/issues/1080)). |
| **R-1080-E5** | The processing window asks for power and a network and is re-armed at every background entry and after every pass ([#1080](https://github.com/srikanth235/centraid/issues/1080)); supersedes #1029 W18-1's "a network, not a charger". |
| **R-1080-E6** | One `HomeSession` per Android process, counted and ordered ([#1080](https://github.com/srikanth235/centraid/issues/1080); R-1020-24), with its stated rotation cost. |
| **R-1080-E7** | "Back up now" on Android: user-initiated job from 34, `dataSync` service below, 30 minutes, any network ([#1080](https://github.com/srikanth235/centraid/issues/1080)). |
| **R-1080-E8** | Forgetting a gateway asks no confirmation ([#1080](https://github.com/srikanth235/centraid/issues/1080) A5). |
| **R-1080-E9** | The Backup screen's rule control is the existing transfer rule; "include videos" negates into `exclude_videos` in the machine ([#1080](https://github.com/srikanth235/centraid/issues/1080) A3). |
| **R-1080-E10** | A settle's error is a code, never a sentence ([#1080](https://github.com/srikanth235/centraid/issues/1080) ruling 7). |

### What this lane assumed beyond the seam contract

The contract names the interfaces; it does not name how the two sides are handed to each other, and lane D's Backup block was not yet written. Each assumption sits in one place per platform so reconciling it is one edit.

| # | Assumed | Where it is read |
| --- | --- | --- |
| E-A1 | `HomeBridge.installUploads(uploads: BackgroundUploads): UploadEvents` — the shell hands Kotlin its mover and takes the core's sink, before the core opens | `ShellModel.wireUploads` |
| E-A2 | `HomeBridge.uploadPins(onPins: (List<UploadPin>) -> Unit)` with `UploadPin(gateway, certDer, addrs)`, answered only with the core's `pins` answer (a refusal does not call back with an empty list, which would wipe the kept pins) | `ShellModel.refreshUploadPins` |
| E-A3 | `UploadEvents.settled(name, httpStatus, error, gatewayId, vaultId)` — the contract's signature with A6's vault | `CoreUploadSink` |
| E-A4 | `SyncPass.installBacklog((Boolean) -> Unit)` in `androidMain`, the hook `BackgroundTasks.backlog(start)` reaches the job through | `CentraidApplication.onCreate` |
| E-A5 | `screen.proto`'s Backup block carries words as well as §3's data: `BackupScreenState.{title, add_destination_label, forget_label, rule_label, include_videos_label, back_up_now_label, progress, battery_sentence, battery_label}`, `BackupLine.sentence`, `BackupWaitingRow.sentence`, `BackupDestinationRow.{gateway_id, label, detail}`, and events `BackUpNow`, `SetIncludeVideos{include}`, `ForgetDestination{gateway_id}`, `Dismissed` | `BackupScreenModel` / `BackupEvents` (both shells), `BackupLineView`, `BackupLineRow` |
| E-A6 | `BackupBridge` in `dev.centraid.shared.sync`, shaped like every kit bridge: `attach`, `observe`/`states`, `open`, `send`/`forward` | `ShellModel`, `BackupSheets` |
| E-A7 | `HomeState.backup_line: BackupLine` | `HomeView`, `HomeScreen` |
| E-A8 | `HomeBridge.drain(deadlineMs:onDone:)` and `ShelfDrain.run(deadlineMs)` keep their signatures, the rule, link and power read inside from `PowerAndLink`; every iOS pass ends with `reconcile` → `handoff` → `enqueue`, the background-entry pass included, so what it sealed is carried while suspended | `BackgroundPasses`, `ShellModel.wentToBackground`, `BackupNow.run`, `CentraidApplication` |

### Found, not this lane's

1. **`NavigationAndMountSpec` "no gateway id names anything under mobile/" fails on the contract's own names.** Its regex `\bgatewayId\b|\bgatewayHex\b|\bgateway_id\b` flags four lines of this lane (`BackgroundUploads.swift:529` `part.gateway_id`, `:644` `gatewayId:`, `BackupScreens.kt:113` and `:144` `gateway_id`), and lane D's `UploadEvents` declaration trips it too. Its subject is D-1025-S5-2's mount key; #1080 ruling 8 brings gateway ids back as destination ids. Lane D owns the spec; narrowing it to the mount is theirs.
2. **`BackgroundPassLawSpec` "the URLSession seam stays retired" passes for the wrong reason.** It scans for the Objective-C spellings (`NSURLSessionUploadTask`, `backgroundSessionConfigurationWithIdentifier`) and this lane's Swift spells `URLSessionConfiguration.background(withIdentifier:)`. #1080 ruling 2 inverts its subject; it should become a positive assertion (one `background(withIdentifier:`, `sessionSendsLaunchEvents`, `SecCertificateCopyData`, `handleEventsForBackgroundURLSession`). Lane D's file.
3. **The deleted experiment is still named** by `crates/xtask/src/gate.rs` (the `ios-transfer-experiment` device lane, its evidence path and messages, and a test asserting the name), `.github/workflows/gate-nightly.yml:193`, `crates/xtask/README.md:49`, `TESTING.md:122,126`, `docs/toolchain.md:165`, `docs/mobile-offline.md:218`, `docs/decisions.md:1384,1580`, `mobile/README.md:186` and `contracts/handoff/E/device-lane-bodies.md` — `grep -rn "ios-transfer" --include=*.md --include=*.yml --include=*.rs .`. The lane should read `receipts/experiments/backup/` and the protocol `backup-measurement.md`; lane C owns `gate.rs`, lane F the docs.
4. **`DrainCopy.POSTURE_SENTENCE` and `FORCE_QUIT_SENTENCE`** (`mobile/shared/.../sync/DrainPass.kt:222-238`) say Centraid "does not upload while the app is closed"; on iOS it now does. Lane D's copy.
5. **`mobile/README.md`** still says pairing has "no Bonjour" (`:333`) and lists the experiment in its hand-off table (`:186`). Lane D's and lane F's sections.

### Device hand-offs

Rows 8.1–8.15 of [v1-handoffs.md](../docs/release/v1-handoffs.md#8-the-backups-native-halves-1080), each with its command, its evidence and its destination: the iOS compile and the 13 `BackgroundUploadTests` (8.1); a part handed off while suspended lands and the next batch chains (8.2); the pin refusing another certificate (8.3); the processing window on both paths (8.4); a foreground part finished under the grace (8.5); the idle timer (8.6); the local-network prompt and the Bonjour type (8.7); the Android compile and lint (8.8); the periodic worker with no activity (8.9); the user-initiated job (8.10); the foreground service below 34 (8.11); EXIF location surviving the read (8.12); rotation during a background pass (8.13); the battery remedy (8.14); and the three backup claims of `backup-measurement.md` (8.15).

### Verification

| Command | Result |
| --- | --- |
| `./mobile/gradlew -p mobile :shared:jvmTest` | 1028 tests, 1 failed: `NavigationAndMountSpec` on the four contract lines in "Found" 1. Every other spec green, `BackgroundIdentifierSpec`, `NativeAccessibilityLintSpec`, `PartyHueWheelSpec` and Konsist's `CommonMainIsPlatformFreeSpec`/`PerAppLayoutSpec` among them. The first run, before any change, failed resolving `junit-jupiter-api` with HTTP 429 from Maven Central and is not a baseline. |
| `bun contracts/tools/export-native-theme.ts && bun contracts/tools/build-screen-fixtures.ts && bun run format`, then the drift diff over `design copy mobile contracts/screens` (the `mobile-jvm` profile's drift check) | exit 0; the tree clean |
| `:core:jvmTest` | not run: it needs the core's cdylib built by cargo, and this lane changed nothing under `mobile/core` |
| `project.yml` against `Resources/Info.plist`, by a script that loads both | 11 source keys, all present and equal; 8 XcodeGen defaults; 0 mismatches; keys sorted. The same script refuses a copy with `NSBonjourServices` changed (exit 1). |
| `grep -rn "background(withIdentifier" mobile/iosApp/Sources` | one: `BackgroundUploads.swift:344` |
| `grep -rn "beginBackgroundTask" mobile/iosApp/Sources` | one: `BackgroundUploads.swift:674`, `ForegroundGrace` |
| `grep -n "ACCESS_MEDIA_LOCATION\|RUN_USER_INITIATED_JOBS\|FOREGROUND_SERVICE_DATA_SYNC\|POST_NOTIFICATIONS" mobile/androidApp/src/main/AndroidManifest.xml` | all four `uses-permission` lines (35, 56, 58, 59) |
| `oxfmt --check mobile/iosApp/project.yml` | formatted |
| the manifest parsed as XML, every comment checked for `--` | parses; none |
| the commit hooks on every commit | green: `format-check`, `lint-check`, `law` (6 rules), `commit-message-format`, `estate-separation` |

## Wave 3, reconciled — the native shells on lane D's seam (lane E)

Lane E's second round on [#1080](https://github.com/srikanth235/centraid/issues/1080), after lane D's interim seam (`20dfdfd5`) and lane B's receipt reached the umbrella branch. Like lane E's first section, it was written with no Xcode and no Android SDK in the container, so neither shell has been compiled; every device claim is a row of [v1-handoffs.md §8](../docs/release/v1-handoffs.md#8-the-backups-native-halves-1080).

### What changed

| Commit | What |
| --- | --- |
| `16b5f798f` | The umbrella branch merged, never rebased. This receipt and `docs/decisions.md` keep the upstream text first and lane E's sections after it, byte for byte. |
| `88a9399e0` | Both shells matched to lane D's seam, in the five places lane D found: a header's value is Wire's `value_`; leaving the app on iOS calls `enteredBackground(graceMs:onDone:)`, which forces a snapshot, not `drain(deadlineMs:)`; both Backup screens draw `notice` and `background_notice`; "Back up now" follows `back_up_now_enabled`, dimmed and disabled like the shared primary control, where the views had decided from `frozen` and `backing_up_now`; Android's rule writes, from the Backup screen and the Home header's sheet, go through one `writeTransferRule` that calls `HomeSession.ruleChanged()`. `battery_sentence` and `battery_label` needed nothing. Home's line now draws lane D's `tone`, `detail` and `accessibility_label`. |
| `d33340545` | #1080 A10 on iOS: `UploadOrder.allowsCellular` from `HandoffPart.allows_cellular`, false when absent; each request's cellular and expensive-network flags follow it; the session allows both, so the request decides; Low Data Mode is refused on both; a changed rule cancels every task iOS holds. `BackgroundUploadTests` go from 13 to 15, the negative case among them. |
| this section's commit | `docs/decisions.md`: R-1080-E1 struck and **superseded by R-1080-E11 (#1080 A10)**; E5, E7 and E9 brought to the reconciled behaviour. `docs/release/v1-handoffs.md`: row 8.6 rewritten, 8.1 expects 15 tests, rows 8.16–8.18 new. |

Three things lane D's seam made redundant are gone, each a second owner of one job. The Backup screen set the idle timer, and its `onDisappear` let the phone lock mid-run; the core's `backlog` hook (`IosBackgroundTasks`) now owns it for the whole run. Android's sheet started the job itself as well as through `installBacklog`; it now only sends the event, once the notification grant is answered. iOS held a grace while `backing_up_now`, which ended early because the screen's state stops describing a run once the screen is dismissed; `enteredBackground` waits for a running pass inside its own grace.

### Found, for the root

1. **`allows_cellular` is not on the umbrella branch yet.** `grep -rn allows_cellular crates/api-proto` finds nothing. `BackgroundUploads.swift`'s Kotlin-visible extension reads `part.allows_cellular`, so the Xcode build waits on lane C's A10 field (`HandoffPart`, field 9) and the core that sets it. The XCTests do not depend on it.
2. **A changed rule did not reach tasks iOS already held**, for up to a day. The iOS shell now cancels them (`ShellModel.setTransferRule`). The same call could live in `HomeSession.ruleChanged()` through `BackgroundUploads.cancelAll()`, lane D's files; the shell's call would then be redundant and harmless.
3. **`SyncPass.installNotice` stays uninstalled**, so an Android nudge is an ordinary one-off rather than expedited. Installing it needs WorkManager's `SystemForegroundService` declared with a `dataSync` type for API 34, which this lane would not add without a compiler.

### Verification

| Command | Result |
| --- | --- |
| `./mobile/gradlew -p mobile :shared:jvmTest` | BUILD SUCCESSFUL: 1,085 tests in 72 suites, 0 failed, 0 skipped, lane D's narrowed `NavigationAndMountSpec` and positive `BackgroundPassLawSpec` row 3 among them |
| `grep -rn "background(withIdentifier" mobile/iosApp/Sources` | one: `BackgroundUploads.swift:358` |
| `grep -rn "beginBackgroundTask" mobile/iosApp/Sources` | one: `BackgroundUploads.swift:693`, in `ForegroundGrace` |
| `grep -rn "idleTimerDisabled" mobile/iosApp/Sources mobile/shared/src/iosMain` | one: `PlatformServices.ios.kt:346`, the core's `backlog` hook |
| `grep -rn "BackupNow.start\|BackupNow.stop" mobile/androidApp/src` | one: `CentraidApplication.kt:48`, the `installBacklog` body |
| `grep -n "requiresExternalPower\|requiresNetworkConnectivity"` over `BackgroundPasses.swift` and `PlatformServices.ios.kt` | both `true` in both submitters (#1080 A12) |
| `oxfmt --check` over the three Markdown files this round touched | formatted |
| the commit hooks on every commit | green |

#### Round two — the documents no lane owned, and the site

The root grew this lane's files by the ones no lane owned — `AGENTS.md`, `docs/enrollment.md`, `docs/config-ownership.md`, `docs/vault-ontology.md`'s backup paragraph, `docs/blueprint-seats.md`, and the five docs-site pages that named iroh — and added lane B's CHANGELOG line and the root's amendment A19 (Free up space). The branch fast-forwarded to the umbrella at `8d18e4f0` first. `CLAUDE.md` is a symlink to `AGENTS.md` (`ls -l`), so one edit covers both.

| Commit | Subject |
| --- | --- |
| this commit | docs: the unowned docs and the site describe backup v2 (#1080) |

| File | Change |
| --- | --- |
| `AGENTS.md` | the intro's gateway is any machine the member controls; the vocabulary row names the pass, the snapshot and "backed up", and says there is no generation, base, segment, lease or custody table |
| `docs/enrollment.md` | §6 rewritten for pairing v2 — the QR from `serve` or `pair`, the pin, the one-use secret, the ledger, the safety number, more than one gateway — and its two restart facts (a pairing secret's hash in `state.db`; the identity as `tls.key`, `tls.crt`, `gateway.id`); §7's pairing bullet |
| `docs/config-ownership.md` | the gateway data directory as v2 has it; `centraid-gateway install` as the one unit generator; pairing state on both ends; the gateway token in the ledger where `backup/laptop.json` was |
| `docs/vault-ontology.md` | the backup paragraph: snapshots in 64 KiB ranges, the manifest's census, no custody table, rung 010's four drops, `sealed-vectors.json` |
| `docs/blueprint-seats.md` | the banner; the seat table's byte flow, danger state and Free up space rows; machinery items 2 and 3; the SQL-confinement crate list as `rules.rs` has it |
| `docs/photos/README.md` | Free up space as A19 has it: `releasable`, the system's own deletion, `released`, the row and thumbnail kept, `fetch_original` |
| `docs/decisions.md` | Q-1080-3's answer appended as a row of the open-questions table; this lane's own R-1029-PH-1 supersession row points at it |
| `CHANGELOG.md` | lane B's line says 64 KiB ranges; this lane's line names the round's documents |
| `README.md` | the docs-site table's Start and Devices rows |
| `scripts/docs-site/src/content/devices.html` | the chapter rewritten: the phone as the vault, a vault in every request, pairing v2, pinned HTTPS, one writer and the claim, and what v0 does not have; every section id kept |
| `scripts/docs-site/src/content/start.html` | §06–§08: pairing a gateway, an always-on gateway and its unit, the 24 words |
| `scripts/docs-site/src/content/learn.html` | §06: the primer on pinned HTTPS in place of iroh |
| `scripts/docs-site/src/content/index.html`, `scripts/docs-site/src/content/understand.html` | the iroh mentions, the Devices card, the subsystem rows for topology, pairing, connectivity, runtimes and the phone app |
| `receipts/issue-1080-backups-v2.md` | this subsection |

**Rulings this round took** (the root records them):

| Id | Ruling and reason |
| --- | --- |
| **F-D7** | Q-1080-3's answer is a new row of the open-questions table, as Q-1080-B1's was, and this lane's own R-1029-PH-1 supersession row — written in this umbrella, below every other lane's text — changes its last sentence to point at it rather than gaining a twin row (#1080). |
| **F-D8** | The docs-site pages keep every section id their `.astro` rails link (`#iroh`, `#replica` and `#p2p` among them), because the rails are not this lane's files; each section's eyebrow and heading say what it now holds (#1080). |

**Found outside this lane's files**, for the root:

- `scripts/docs-site/src/pages/{devices,learn,understand,index,start}.astro`: the titles, descriptions and search keywords name iroh, peer-to-peer QUIC, the desktop shell, harness runtimes and replicas, and `devices.astro`'s rail labels §05 "Replica" and §08 "Mobile companion", where the sections now read "one writer" and "the phone app". Renaming the `#iroh` id moves the rail and the two links into it together.
- `scripts/docs-site/src/content/backups.html` describes the v0 recovery kit and provider plane, and `data.html` the hosted-era vault; `understand.html`'s offsite-backup, recovery and conversation-ledger rows and its Data card ("blob custody") point at them. `start.html` §01–§05 and `index.html`'s first path card describe the desktop shell; README's Start row now says so.
- `docs/vault-ontology.md:36`'s table counts and `:120`'s `blob_custody_*` change when rung 010 lands and the DDL is regenerated.
- `docs/mobile-offline.md`'s seat record has no inbound link left now that `docs/blueprint-seats.md` points at `#the-pass`, so F-D2's reason for keeping it is gone; it can be deleted.
- `docs/blueprint-seats.md` item 1 names `centraid_blobs::Budget::admits_original` in `crates/blobs/src/plan.rs`, whose wants come from the custody rows rung 010 drops; it stays until lane C says where the rule's decision lives.
- `crates/api-proto/proto/centraid/screen/v1/screen.proto:1741` says the Free up space row is a statement and that there is no "releasable"; A19 makes it a verb.
- `mobile/iosApp/project.yml:189` says "No Bonjour", while the issue and `docs/gateway.md`, `docs/recovery/pairing.md` and `SECURITY.md` have the phone browse `_centraid-gateway._tcp` in the foreground; lane E's brief adds `NSBonjourServices`.

**Still waiting.** Lane C's facts — the drill step, the pragmas, `centraid`'s verbs, the identity files that leave, `local_bytes`, the restore test names, and the device secret's fate, on which `docs/config-ownership.md`'s "two secrets per vault" sentence and `docs/enrollment.md` §7's device-secret bullet wait — and lane E's merge, which resolves eight forward links.

#### Verification, round two

Run in this worktree on 2026-10-03, at this commit's tree. No cargo command and no site build: the round changes no code.

```sh
bun run format && bun run format:check
python3 <scratchpad>/linkcheck.py . <the 26 markdown files this lane owns>
python3 <scratchpad>/htmlcheck.py devices.html start.html learn.html index.html understand.html
grep -n -i -E 'iroh|laptop\.json|node\.key|\blease\b|invite|endpoint id|object-vectors|4 MiB ranges|drain runs|custodian' <this round's files>
bash .governance/run.sh
```

- `bun run format` then `bun run format:check` — no change; "All matched files use the correct format", 525 files.
- The link check — 26 files, 14 unresolved: the same twelve forward links and two append-only decisions rows as round one, and nothing new.
- The page check (a scratch parser over the content fragments) — every tag closed in all five pages, and every `../<page>/#<id>` link resolves to an id on that page; seven `../ontology/` links are reported only because that route is built from `ontology-body.html`.
- The old-names grep — no hit but history cited by issue link, the `#iroh` section id (F-D8), and `docs/blueprint-seats.md:51`'s "work-lease lane", which is the enrichment plane's.
- `bash .governance/run.sh` — one finding, `receipt-per-issue`: the `## Audit` verdict the close pass writes. Every other directive and rule green.

## Wave 3 — the shared half (lane D)

The phone's half of the new backup in `mobile/shared`: the pass and its triggers, scheduling, the iOS mover's Kotlin half, the backup line and the Backup screen, pairing v2, the camera-roll walker and free up space, built against the seam contract (A1–A13, A19, A20) and the proto at `f9791e17`. Branch `worktree-agent-a52fb3e3ab127d10e`, cut from `23e46810`; the umbrella was merged in at `49e8c2ef` (the proto), `acedd039` and `7aa589ea` (lanes A, B, E and F). Rulings are [R-1080-D1…D13](../docs/decisions.md#the-shared-half-of-the-backup-1080); questions Q-1080-D1…D3 sit beside them.

| Commit | Subject |
| --- | --- |
| `1c1881d2` | feat(mobile): pass input, launch registration and wake reasons (#1080) |
| `37135526` | feat(screen): the Backup block of screen.proto (#1080) |
| `eb289bf9` | refactor(screen): name a backup destination's id, not a gateway's (#1080) |
| `619754f1` | feat(mobile): the backup line, its status store and backup.home (#1080) |
| `92e15ad9` | feat(screen): the Backup block and Home's line, as the shells read them (#1080) |
| `20dfdfd5` | feat(mobile): the mover's seam, Backup screen and pairing v2 (#1080) |
| `812d9b38` | feat(mobile): the walker streams from the OS library (#1080) |
| `bd592552` | feat(mobile): free up space frees what a gateway holds whole (#1080) |
| `f3a734b2` | fix(mobile): a changed rule lets go of the uploads iOS holds (#1080) |
| `01466ec4` | refactor(mobile): free up space through an installed deleter (#1080) |
| this commit | docs(mobile): the shared half's README, decisions and receipt (#1080) |

| Area | Files |
| --- | --- |
| the pass | `sync/{ShelfDrain,DrainPass,DrainCopy,PassConditions,BackgroundWindows,TransferRule,CoreDoors,ContentHash}.kt` |
| scheduling | `platform/PlatformServices.kt` (`PowerAndLink`, `BackgroundTasks.register/resubmit/nudge/backlog`), the iOS, Android and JVM actuals, `androidMain/.../AndroidBackgroundWork.kt` |
| the mover | `sync/BackgroundUploads.kt` (`BackgroundUploads`, `UploadEvents`, `UploadLoop`, `UploadPin`), `sync/CoreBackupDoors.kt`, `shell/HomeBridge.kt` (`installUploads`, `uploadPins`, `enteredBackground`) |
| status and screen | `sync/{BackupStatus,BackupLines,BackupScreen,BackupBridge}.kt`, `shell/{HomeSession,HomeMachine}.kt`, `screen.proto`'s Backup block, `HomeState.backup_line`, `copy/shared.json` + `SharedCopy.kt` |
| pairing v2 | `custody/{PairLaptop,PairAndRestore}.kt`, `copy/words.json` + `WordsCopy.kt`, `shell/Shelf.kt` (no reopen) |
| the walker | `shell/{CameraRoll,LibraryFeed,Staging}.kt`, `iosMain/.../IosLibraryStream.kt`, the iOS and Android `MediaLibrary` actuals |
| free up space | `apps/photos/KeepOriginals.kt` (`FreeUpFlow`), `sync/FreeUpDoors.kt` (`LibraryDeleter`), `PhotosGridMachine.kt`, `screen.proto`'s `FreeUpSpace` and `FreeUpTapped` |
| specs | `BackgroundSchedulingSpec`, `BackgroundPassLawSpec` (row 3 positive, A13), `NavigationAndMountSpec` (narrowed to the mount key, A13), `ShelfDrainSpec`, `DrainPassSpec`, `BackupStatusSpec`, `BackupScreenSpec`, `CoreBackupDoorsSpec`, `UploadLoopSpec`, `CameraRollSpec`, `CameraRollStreamSpec`, `WalkerPlatformLawSpec`, `FreeUpSpec`, `HomeMachineSpec`, `PairAndRestoreSpec`, `WordsShelfSpec` |
| docs | `mobile/README.md` (pairing v2, restore and the held-seed restore's pairing code, discovery, `Shelf.forget`, the frozen line, the secure store's contents, the `sync/` layout, the hand-off rows, "The backup plane, shared half"), `docs/decisions.md`, `CHANGELOG.md`, `Shelf.forget`'s comment and `VAULTS_FORGET_BODY` in `copy/shared.json` + `SharedCopy.kt`, this section |

**Not done, and why.** The `:core:jvmTest` round trips and `cargo xtask gate --profile mobile-jvm` wait on lane C's core. `CoreFreeUpDoors` answers no answer until lane C's `releasable` (29) and `released` (30) arms merge, and `Staging`'s `osEdited` reaches `StageBegin.os_edited` (7) only then. Backing up an edited asset's camera original and adjustment data is an owner question (A20); the walker stages the current rendition. The iOS and Android walker and scheduling actuals are uncompiled here. Comments in this lane's files still name the lease, generations and the invite code (`Shelf.kt`, `HomeSession.kt`, `Enrollment.kt`, `PairAndRestore.kt`, `PairLaptop.kt`, `ReadFailures.kt`, `Instants.kt`), and the restore's pairing-code field is "the laptop address" in `WordsEntry.kt`'s comments as in `screen.proto`'s words section; they describe `lease.proto`, `ERROR_CODE_NO_RELAY_REACHABLE` and `RestoreResponse.device_secret`, which stand until the cut-over, and move with it. The `custody` package keeps its name: a rename reaches 11 lines of lane E's shells.

**Found outside this lane's files**, for the root:

- Android's `screens/HomeScreen.kt:310` comment says a forgotten vault has no copy anywhere else; `HomeWords.VAULTS_FORGET_BODY` now says a paired gateway keeps one.
- `mobile/maestro/backup-measurement.md`'s corpus counts edited photographs as "an original plus its adjustment data", which A20 defers.
- `BackupState.Transport` still names `TRANSPORT_IROH_BLOBS`, and the `photos/limited-selection` fixture carries it (`ScreenFixtureSpec`); the walker no longer sets it.
- No shell browses `_centraid-gateway._tcp` (Q-1080-D3).

### Verification

Run in this worktree on 2026-10-03 at `7aa589ea` plus `01466ec4`; no cargo command, by the brief, until the core lands.

```sh
mobile/gradlew -p mobile :shared:jvmTest
grep -rn "backgroundTasks.register" mobile/shared/src/commonMain
grep -rn "NSTemporaryDirectory\|centraid-stage-" mobile/shared/src/iosMain
cd crates/api-proto/proto && buf lint && buf breaking --against '../../../.git#ref=23e468100,subdir=crates/api-proto/proto'
bun contracts/tools/export-native-theme.ts && bun contracts/tools/build-screen-fixtures.ts && bun run format
bun run format:check
bash .governance/run.sh
```

- `:shared:jvmTest` — 1,105 tests in 75 suites, 0 failures on the merged tree, and the same with this commit's edits; on lane D alone before lane E merged, 1,104 and the one failure was row 3 over lane E's `BackgroundUploads.swift`.
- `backgroundTasks.register` — one call site, `shell/HomeSession.kt`.
- The temporary-copy grep — no match.
- `buf lint`, `buf breaking` — clean.
- The emitters and `bun run format` — no drift outside this lane's edits; `bun run format:check` — all 525 files formatted.
- `bash .governance/run.sh` — every directive passes but `law`, with one finding at the window door: `receipt-per-issue`, because this receipt's `## Audit` holds no PASS or REFUTED verdict yet. The verdict is the umbrella's independent review's to write at the close, above this section.
- Red first: removing the launch `register()` turned two scheduling specs red; a line that called everything whole turned `BackupStatusSpec` red; the walker's platform laws were red against `20dfdfd5`'s actuals (a temporary file, `available()`, images only); the rule-change spec was red with `uploads?.cancelAll()` removed.

### Round two — on lane C's phone core

The umbrella at `477ad015` (lane C's `618c1525`, merged at `8cbc5039`) fast-forwarded this branch, which it already contained at `3aa8bcda`. Kotlin only: no cargo command ran, because lane C's cut-over was rebuilding in the shared target directory.

| File | Change |
| --- | --- |
| `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/sync/FreeUpDoors.kt` | `CoreFreeUpDoors` sends `releasable = 29` and `released = 30`. |
| `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/sync/CoreBackupDoors.kt` | The envelope helper is `internal askDoor`, shared with the free-up doors. |
| `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/shell/Staging.kt` | `osEdited` crosses as `StageBegin.os_edited = 7`, only with `STAGE_SOURCE_OS_LIBRARY`; `poster` is named among the tiers. |
| `mobile/core/src/commonMain/kotlin/dev/centraid/core/CentraidCore.kt`, `CoreFailure.kt` | `CoreConfiguration.deviceSecretHex` and the `device` key it wrote are gone (#1080 A21); the open-refused text names no device secret. |
| `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/custody/VaultSecrets.kt` | `deviceSecret`, `rememberDeviceSecret`, `forgetDeviceSecret` and their constants are gone. |
| `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/{shell/Shelf,shell/HomeSession,custody/Enrollment,custody/PairAndRestore,sync/CoreDoors}.kt` | `adoptRestored` takes no secret, `openCore` no vault id, `RestoreAnswer` no `deviceSecretHex`; the restore door does not read `RestoreResponse.device_secret`. |
| `crates/api-proto/proto/centraid/screen/v1/screen.proto` | The words section names the restore's field as the gateway's pairing code, which the core requires; the pair section's header describes pairing v2; `BackupState.transport` is retired as `reserved 5; reserved "transport";` and its enum deleted, which WIRE_JSON allows once the field is reserved. |
| `contracts/screens/photos/limited-selection.{textproto,bin}` | No transport; the `.bin` is `build-screen-fixtures.ts`'s output. |
| `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/custody/WordsEntry.kt` | Comments: the pairing code, not a laptop address. |
| `mobile/README.md` | The secure store's row and the bearer-token line follow A21. |
| `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/{CoreBackupDoorsSpec,VaultSecretsSpec,WordsShelfSpec,EnrollmentSpec,VaultWordsSpec,WordsEntrySpec,ScreenFixtureSpec}.kt`, `mobile/core/src/jvmTest/kotlin/dev/centraid/core/ConfigurationJsonSpec.kt` | `allows_cellular` reaches the mover; `os_edited` is sent for a library item and never for an owned one; the free-up doors cross both ways and a refusal is no answer; no open carries a `device` key and no device key is stored; the fixture decodes with no unknown fields. |

**Not done.** `:core:jvmTest` and `cargo xtask gate --profile mobile-jvm` wait for the cut-over. `mobile/iosApp/Tests/ScreenFixtureTests.swift:129` asserts `state.backup.transport == .irohBlobs`; it is lane E's line to delete, and the iOS test target does not compile until it is. Secure-store keys `device-secret.<vaultId>` that earlier builds wrote are not purged; nothing reads them.

**Found.** words.enter enables Restore with no pairing code, and the re-key that offers a restore never draws the code's field; the core refuses an empty payload as `INVALID_REQUEST` (`crates/core/src/phone/restore.rs:128`), which `CoreRestoreDoor` reads as "could not reach your laptop". `buf breaking` against `main` reports nine deletions in `core/v1/phone.proto` under FILE, all lane C's reservations.

#### Verification, round two

```sh
mobile/gradlew -p mobile :shared:jvmTest :core:compileTestKotlinJvm
mobile/gradlew -p mobile :shared:jvmTest --rerun
buf lint && buf breaking --against '.git#ref=477ad015a,subdir=crates/api-proto/proto'
bun contracts/tools/export-native-theme.ts && bun contracts/tools/build-screen-fixtures.ts && bun run format && bun run format:check
bash .governance/run.sh
```

- `:shared:jvmTest` — 1,102 tests in 75 suites, 0 failures: four device-secret cases left with the device secret, one free-up case joined. `:core:compileTestKotlinJvm` compiled; no cargo task ran.
- `buf lint` — exit 0; `buf breaking` against the umbrella tip — exit 0.
- The emitters — only `limited-selection.bin` changed (126 bytes to 124); `bun run format:check` — clean.
- Red first: `ScreenFixtureSpec` failed against the old `.bin` and passed against the new one.
- `bash .governance/run.sh` — every directive passes but `law`, whose one finding is still `receipt-per-issue`: the `## Audit` verdict the umbrella's independent review writes at the close.

### Round three — A23, and nothing left naming what lane C's 3a deletes

On the umbrella at `217c876b`; Kotlin only, no cargo command.

| File | Change |
| --- | --- |
| `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/custody/WordsEntry.kt` | #1080 A23: `Entry.restores` is true for every purpose but a re-key, and for a re-key that offers the restore instead; such a screen draws the pairing code's field, keeps `primary_enabled` false until a non-blank code is pasted, and does nothing on a tap without one. |
| `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/WordsEntrySpec.kt` | The negative case (valid words, no code: closed, a tap asks nothing, blank is no code), the re-key path's field and gate, and the held-seed restore's gate. |
| `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/VaultMovedProducerSpec.kt` | Names no `ERROR_CODE_GATEWAY_*`: the near misses are `UNAUTHORIZED` and `PEER_UNREACHABLE`, which stay. |
| `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/{shell/Shelf,shell/HomeSession,sync/ReadFailures,sync/Instants,sync/TransferRule,apps/photos/PhotosReads,custody/PairAndRestore,custody/Enrollment,custody/PairLaptop}.kt`, `mobile/core/src/commonMain/kotlin/dev/centraid/core/CentraidCore.kt`, `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/{VaultMovedSpec,PhotoCellStateSpec,WordsShelfSpec,EnrollmentSpec,PairAndRestoreSpec,WordsEntrySpec}.kt` | Comments: `VaultMoved` is `error.proto`'s; the core's `phone::drain::Conditions` replaces `Budget::admits_original`; `safety_number_of_bytes` replaces `pairing_safety_number`; the lease, generations and the invite code give way to writer epochs, snapshots and the pairing code. |
| `crates/api-proto/proto/centraid/screen/v1/screen.proto`, `mobile/README.md` | The code's field is drawn wherever the primary restores, and the control waits for it. |

#### Verification, round three

```sh
mobile/gradlew -p mobile :shared:jvmTest :core:compileTestKotlinJvm
grep -rn "ERROR_CODE_GATEWAY_" mobile/ --include=*.kt --include=*.swift
grep -rn -E "lease\.proto|pair\.proto|gateway\.proto|backup\.proto|admin\.proto|pairing_safety_number|admits_original" mobile/shared/src mobile/core/src --include=*.kt
buf lint
bun run format && bun run format:check
bash .governance/run.sh
```

- `:shared:jvmTest` — 1,103 tests in 75 suites, 0 failures (the A23 negative case is the one added); `:core:compileTestKotlinJvm` compiled.
- Both greps — no match.
- `buf lint` — exit 0; `bun run format:check` — clean.
- Red first: against the machine at `217c876b`, the three A23 cases in `WordsEntrySpec` failed; against this one they pass.
- `bash .governance/run.sh < /dev/null` — every directive passes but `law`, whose one finding is still the `## Audit` verdict for the close. (Without `< /dev/null`, `pre-push-gate` waits on stdin for the refs a push would send.)

### Round four — the cut-over, and A24

On the umbrella at `b9590be6` (lane C's cut-over), which fast-forwarded this branch. `1079683e` makes "Back up now" the only pass that asks (#1080 A24): `WakeReason.asked` is set by `BACK_UP_NOW` alone, `DrainInput.asked` carries it, and `CoreDrainDoor` sends it as `DrainRequest.asked`; the need-bytes rounds of the same pass keep the ask and drop the snapshot. **[Q-1080-D2](../docs/decisions.md#the-shared-halfs-questions-for-the-owner-1080) is answered by A24** ([R-1080-C13](../docs/decisions.md#the-phone-core-and-the-cut-over-1080-lane-c)): leaving the screen and a finished restore force a snapshot and ask nothing, and only the member's tap seals an original under MANUAL or a video's original off the charger. Files: `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/sync/{PassConditions,DrainPass,CoreDoors,ShelfDrain}.kt`, `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/{ShelfDrainSpec,CoreBackupDoorsSpec}.kt`, `mobile/core/src/jvmTest/kotlin/dev/centraid/core/ConfigurationJsonSpec.kt` (a case name), `mobile/README.md`.

#### Verification, round four

```sh
grep -rn "ERROR_CODE_GATEWAY_" mobile/ --include=*.kt --include=*.swift
grep -rn -E "gateway2|backup2|centraid-gateway2" mobile/
CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=/home/user/cargo-target-shared cargo build -p centraid-core-ffi
CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=/home/user/cargo-target-shared mobile/gradlew -p mobile :shared:jvmTest :core:jvmTest
mobile/gradlew -p mobile :shared:jvmTest --rerun
touch crates/api-proto/build.rs
CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=/home/user/cargo-target-shared cargo xtask gate --profile mobile-jvm
bun run format && bun run format:check
bash .governance/run.sh < /dev/null
```

- `ERROR_CODE_GATEWAY_` — no match.
- `gateway2|backup2` — one match, outside this lane's files: `mobile/iosApp/Sources/VaultFileProtection.swift:38` names `backup2/ledger.rs`, which is now `crates/vault/src/backup/ledger.rs`.
- `cargo build -p centraid-core-ffi` — finished in 53 s.
- `:core:jvmTest` — 32 tests in 10 suites, 0 failures: the real ABI round trips, and `ConfigurationJsonSpec`'s case that no open carries a device key. `:shared:jvmTest` — 1,104 tests in 75 suites, 0 failures (the A24 case is the one added), executed with `--rerun` after the combined run took it from the build cache.
- `cargo xtask gate --profile mobile-jvm` — `ok mobile-jvm 48.4s git diff --exit-code -- design copy mobile contracts/screens`; `gate mobile-jvm: PASS`, 48.4 s of a 420 s budget.
- Red first: the A24 case in `ShelfDrainSpec` failed with `ENTERED_BACKGROUND` given an ask, and passes without one.
- `bun run format:check` — clean. `bash .governance/run.sh < /dev/null` — every directive passes but `law`, whose one finding is the `## Audit` verdict for the close.

### Round five — the way back (the audit's finding 1), and two wait reasons

On the umbrella at `511a20ee` (the audit), which fast-forwarded this branch. Kotlin only, no cargo command.

| File | Change |
| --- | --- |
| `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/sync/ScreenRuntime.kt` | Serves `ScreenEffect.FetchOriginal` for its own screen through `CoreBackupDoors.fetchOriginal` (arm 25), the vault pinned at the tap; `ScreenReads.fetchSettled` (null by default) carries the outcome back, and no answer is `FETCH_NO_ANSWER`'s line. The comment that said `Request` has no `fetch_original` arm is gone. |
| `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/sync/CoreBackupDoors.kt` | `FetchedOriginal` gains `UNTRUSTED` and `DAMAGED`, `fetched` and `sentence`. Lane C's `FETCH_OUTCOME_UNTRUSTED`, `FETCH_OUTCOME_DAMAGED`, `WAIT_REASON_ASK` and `WAIT_REASON_UNTRUSTED` are matched by name, so the file compiles on both sides of the merge that adds them. |
| `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/photos/{PhotosReads,PhotoLightboxReads}.kt` | `fetchSettled` as each screen's `FetchSettled`. |
| `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/apps/photos/{PhotosGridMachine,PhotoLightboxMachine}.kt` | A success re-reads, because an original the phone already held settles with no change event; the grid's failure line lands on `write_failure`. |
| `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/screen/ScreenMachine.kt` | `FetchOriginal`'s comment says what serves it. |
| `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/sync/{BackupStatus,BackupLines}.kt`, `copy/shared.json`, `mobile/shared/src/commonMain/kotlin/dev/centraid/design/copy/SharedCopy.kt`, `crates/api-proto/proto/centraid/screen/v1/screen.proto` (the Backup block: `REASON_ASK = 7`, `REASON_UNTRUSTED = 8`) | The two waits and the five fetch lines. |
| `mobile/README.md` | The way back. |
| `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/{PhotoLightboxSpec,FreeUpSpec,BackupStatusSpec}.kt` | The tap crosses to arm 25 with the raw hash; a success re-reads; each failure shows its line and stops the spinner; every outcome is fetched or a line; the two wait rows. |

**Waiting on lane C's proto.** The wire rows — `WAIT_REASON_ASK` and `WAIT_REASON_UNTRUSTED` to `WaitReason`, `FETCH_OUTCOME_UNTRUSTED` and `FETCH_OUTCOME_DAMAGED` to `FetchedOriginal` — have no constants to name in a spec until it merges; the Kotlin rows behind them are specced.

#### Verification, round five

```sh
mobile/gradlew -p mobile :shared:jvmTest --rerun
buf lint && buf breaking --against '.git#ref=511a20ee3,subdir=crates/api-proto/proto'
bun contracts/tools/export-native-theme.ts && bun contracts/tools/build-screen-fixtures.ts && bun run format && bun run format:check
bash .governance/run.sh < /dev/null
```

- `:shared:jvmTest` — 1,109 tests in 75 suites, 0 failures (five added).
- `buf lint`, `buf breaking` against the umbrella — exit 0.
- The emitters — no drift beyond `copy/shared.json`'s seven keys; `bun run format:check` — clean.
- `bash .governance/run.sh < /dev/null` — all 6 directives pass.
- Red first: with the runtime's new branch disabled and the two machines as at `511a20ee`, the grid case, the lightbox re-read case and the runtime case failed; restored, they pass.

### Round six — lane C's names, typed, and what a forget and a stop say

On the umbrella at `02081b55` (lane C's audit fix round), which fast-forwarded this branch. Kotlin only, no cargo command.

| File | Change |
| --- | --- |
| `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/sync/CoreBackupDoors.kt` | Typed, exhaustive arms for `WAIT_REASON_ASK`, `WAIT_REASON_UNTRUSTED`, `FETCH_OUTCOME_UNTRUSTED` and `FETCH_OUTCOME_DAMAGED`, replacing round five's by-name match; `forget` answers a `ForgetAnswer(forgotten, revoked)` from `ForgetDestinationResponse.revoked`. |
| `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/sync/{CoreDoors,DrainPass,DrainCopy}.kt` | `DRAIN_STOP_UNTRUSTED` reads as `DrainAnswer.Stopped.UNTRUSTED` in an exhaustive `when`, with its sentence: the machine that answered is not your laptop, it was sent nothing, nothing was lost. |
| `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/sync/BackupLines.kt` | A line with anything waiting on an untrusted machine takes the attention tone. |
| `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/sync/{BackupScreen,BackupBridge}.kt`, `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/shell/HomeSession.kt` | The forget answer reaches the screen; its notice says whether the laptop will refuse this phone from now on, or that it could not be told and how to revoke the phone there. |
| `copy/shared.json`, `mobile/shared/src/commonMain/kotlin/dev/centraid/design/copy/SharedCopy.kt` | `BACKUP_FORGOTTEN` is replaced by `BACKUP_FORGOTTEN_REVOKED` and `BACKUP_FORGOTTEN_NOT_REVOKED`. |
| `mobile/README.md` | The Backup screen's forget, and the line's tone. |
| `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/{CoreBackupDoorsSpec,BackupScreenSpec,BackupStatusSpec,DrainPassSpec,PhotoLightboxSpec}.kt` | The four wire values round five left pending; every `FetchOutcome` on the wire; the untrusted and unspecified stops; forget revoked and not; both notices, through the flow; the tone; the lightbox's untrusted and damaged lines. |

#### Verification, round six

```sh
mobile/gradlew -p mobile :shared:jvmTest --rerun
bun run format && bun run format:check
bash .governance/run.sh < /dev/null
```

- `:shared:jvmTest` — 1,112 tests in 75 suites, 0 failures (three added).
- `bun run format:check` — clean.
- `bash .governance/run.sh < /dev/null` — all 6 directives pass.
- Red first: with `DRAIN_STOP_UNTRUSTED` read as unreachable and the tone rule disabled, the stop case and the wait-row case failed; restored, they pass.

### Lane A — the gateway v2 (`crates/gateway2`, renamed `crates/gateway` at the cut-over)

Branch `worktree-agent-ad02a969bfe46e45e`, from `23e46810`; merged as `bccf0763`. Eight commits: `ceae39b71` the protocol v2 rules and their conformance suite; `9b8b25479` the HTTPS gateway, pinned client and wire suite; `d29922f4d` the CLI, pairing QR and safety line; `6a46b349d` store semantics for the phone and streamed bundles (A14, A15); `f999ef590` a user unit that can start with its data at home; `46bb10dee` sweeps paced by the clock and kept on disk; `c1d3760ff` the README and the container image; `f21084b0a` no other hash named in the digest-header test.

**What landed.** `src/rules/{ids,limits,wire,code,claim,state,engine,bundle,payload,range,memory,conformance}.rs`: the pure protocol over an in-memory state and a store trait, with a 30-case conformance suite (24 cases plus 6 for A15) that runs in memory and again over the wire. `src/server/{mod,tls,state,sql/*.sql,store,http,serve,sweeps,harness,addrs,service,qr,report}.rs`: the P-256 self-signed identity minted at first `serve`, the SQLite state file (its SQL under `sql/*.sql` through `include_str!`, because `sql-confinement` scans `.rs` literals), the filesystem store (temp file, verified digest, rename), the routes, one listener with mDNS, the sweeps due by wall clock against `sweeps.json`, the test harness `server::harness::spawn`, and the systemd/launchd units (`ProtectHome=tmpfs` with bind paths so the data directory may live under the member's home; `StartLimit*` under `[Unit]`; `UMask=0077`). `src/client/{mod,tls}.rs`: the pinned client (exact DER, or `blake3(DER) == pin` on first contact) with every route, `client::Put` outcomes `Stored`/`AlreadyStored`/`NameTaken`, `bundle_parts` and `fetch_each` streaming (a 252 MiB bundle grows either end by about 5 MiB; the test samples VmRSS). `src/bin/centraid-gateway2.rs`: `serve`, `pair` (the QR payload and the half-block QR), `pairings`, `scrub`, `health`, `install`; the safety line printed when a pairing lands. `crates/xtask/src/rules.rs`: `no-listening-socket` allows `crates/gateway2/src/server/serve.rs` beside the old file until the cut-over. `deploy/gateway2/Dockerfile`, `crates/gateway2/README.md`.

**Exit list.** `cargo fmt --all --check` clean; `cargo clippy -p centraid-gateway2 --all-features --all-targets -- -D warnings` clean, also with `--no-default-features` and `--features client`; `cargo test -p centraid-gateway2 --all-features` 78 passed (30 conformance cases in memory and 30 over the wire); `cargo test -p centraid-gateway2 --no-default-features` 34 passed; `cargo xtask rules` 4 rules ok (`no-listening-socket` scanned 409 files, 2 on the allowlist); `cargo check -p centraid-gateway-server -p centraid-gateway-client` ok; `grep -rn sha256 crates/gateway2` empty; `cargo test -p centraid-vault --test one_hash` failed on a `"sha-256="` test string (the scan folds hyphens) and passes after `f21084b0a`; `bash .governance/run.sh` two findings, both outside the lane (the receipt and the CHANGELOG line, lane B's).

**Not done.** `mirror` (a later wave); the Docker image not built (no daemon here; `cargo check --locked --features server --bin centraid-gateway2` resolves); the unit not started under a live systemd (checked against `systemd-analyze verify`); mDNS untried on a real LAN; `cargo deny` not installed (licences read from manifests: MIT, Apache-2.0, BSD-3-Clause); `DISK_FULL` unit-tested only.

**Found outside the lane.** `centraid_identity::pairing_safety_number` decodes both inputs as Ed25519 points, so a BLAKE3 pin is accepted only about half the time (ruled A17: a variant over two 32-byte strings, both ends). The v1 systemd unit could not start with its data under `~` (`ProtectHome=true` drops `ReadWritePaths`; `StartLimitIntervalSec` under `[Service]` is ignored); fixed in the v2 unit, v1 leaves at the cut-over. A grep for `sha256` is weaker than `crates/vault/tests/one_hash.rs`, which folds case and hyphens. `MemoryStore::get` answered `Missing` for a tombstoned object while the gateway serves it until the purge (ruled A16: served).

**Falsification.** The streaming claim: with `bundle_parts` made to collect its body and `fetch_each` to read its whole answer, the 252 MiB test measured 248 MiB and 258 MiB of growth and failed both times. The A15 claim: with the old per-name `NOT_FOUND` delete and the serving of damaged objects restored in the engine, `store/deleting-an-absent-name-succeeds`, `delete/a-tombstone-keeps-its-bytes-until-the-grace-ends` and `scrub/rot-is-found-without-a-key-and-the-name-reads-missing` failed by name.

**Rulings** (recorded under #1080 in docs/decisions.md as R-1080-A1…A17 by the cut-over lane): A-D1 trailers name the authoring model; A-D2 the state SQL lives in `.sql` files; A-D3 a `read` claim at epoch 0 gives a token that never writes; A-D4 a claim on an unknown vault is `UNAUTHORIZED` and `EPOCH_CONFLICT` carries the epoch and head; A-D5 `GET head` reports the writer epoch and `NO_HEAD` carries it; A-D6 a tombstone is missing to `exists`, absent from the listing, brought back by a `PUT`, and delete is idempotent; A-D7 the scrub marks damaged rows, a damaged name reads as missing and a `PUT` replaces it; A-D8 `PUT head` needs a held manifest and setting the standing head succeeds; A-D9 `fetch` leaves out what `GET` would not serve, `TOO_LARGE` above 256 MiB in total, `TOO_MANY` above 1000 names; A-D10 default features are server plus client; A-D11 the extra codes `BAD_REQUEST`, `EPOCH_CONFLICT`, `NOT_FOUND`, `TOO_MANY`, `BAD_RANGE`, `INTERNAL`, and the `centraid-code` header; A-D12 a bundle answer carries `already` per frame; A-D13 a refusal whose status is not its code's is a protocol error; A-D14 damaged objects are not served, tombstoned ones are until the purge; A-D15 the unit's `ProtectHome=tmpfs` and bind paths; A-D16 sweeps due by wall clock, a failed sweep retried an hour later; A-D17 `bundle_parts` refuses `TOO_LARGE` before sending.

## Lane C — the cut-over: the phone core on the new plane, and the old planes leave

Branch `worktree-agent-ae7cc58a4348ed43a`, from `23e46810`, merged into the umbrella at every seam. Its own commits, oldest first: `f9791e176` the backup v2 wire contract (slice 0); `94376cf99` a directory content store and `local_bytes` (slice 1); `570b640aa` 64 KiB ranges and bundles both ways, `c4c89c5d1` one safety number over any two 32-byte strings, `618c15258` the phone core on the backup plane v2 (slice 2); `4c4957bad` the old plane and the iroh gateway leave, `f8fbd337d` one gateway, one backup plane, by name (slice 3); `fa51a8d71` the restore drill crosses the real gateway, with A24 (slice 4); and the slice-5 commit carrying this section. The lane was relaunched once mid-slice-2 from its milestone note; the relaunch kept the uncommitted ledger and content work and rewrote nothing committed.

### What landed

- **The wire contract** (`phone.proto`, `envelope.proto`, `content.proto`): `handoff`, `settle`, `fetch_original`, `pins`, `reconcile`, `forget_destination`, `releasable`, `released`; the stage door v2 (`source`, `os_ref`, `os_edited`, `for_hash`, `tier`); `HandoffPart.allows_cellular` (A10); `DrainRequest.asked` (A24). Every field the old plane needed is reserved by number and name.
- **The content store is a directory** (`crates/blobs`): `<stem>.bytes/` of files named by their BLAKE3, with no lock and no index; the ledger's `local_bytes` says where an OS-library item lives, and the byte door answers a store path, a library identifier or nothing.
- **The phone core** (`crates/core/src/phone/{mod,pair,drain,link,fetch,restore}.rs`, `crates/core/src/stage.rs`): pairing from the QR's text with the safety number both ends print and a takeover by claim on `VAULT_KNOWN`; a pass that moves the records and sets the head before any media, then seals and moves derivatives and originals under `Conditions`; the OS hand-off, settle and reconcile; derivatives in bundles and an original by name; a restore that checks every vault under a read grant before it claims any, adopts the ledger and brings the derivatives back; and `MOVED` freezing the old phone. `phone::drain::Conditions` (`may_prepare`, `may_move`, `allows_cellular`) is what replaced `centraid_blobs::Budget::admits_original`; `crates/blobs/src/plan.rs` is deleted.
- **The old planes leave**: `crates/gateway-core`, `crates/gateway-server`, `crates/gateway-client`, `crates/vault/src/backup` (the #1029 plane), `crates/media/src/object` (`centraid-object/1`), `crates/identity/src/{certificate,discovery,record,ticket}.rs`, `contracts/crypto/{object,discovery}-vectors.json`, `contracts/gateway/`, `contracts/deploy/`, the five old-plane protos, every test that drove them, and iroh, pkarr, `iroh-dns-server`, reqwest, `tokio-rustls-acme` and url from the workspace. Rung ten (`contracts/migrations/010_backup_v2.sql`) drops the four custody and range tables.
- **The renames**: `crates/gateway2` → `crates/gateway` (package `centraid-gateway`, binary `centraid-gateway`, service label `dev.centraid.gateway`), `crates/vault/src/backup2` → `crates/vault/src/backup`, `deploy/gateway2` → `deploy/gateway`.
- **The vault**: SQLite's checkpoint default and no `NO_CKPT_ON_CLOSE`; the `PERSIST_WAL` shim, the running census, `Vault::census` and `Vault::enrol_device` gone; `restore_check` beside the new restore; `FsBlobStore` in the byte door.
- **The gate**: `no-listening-socket` allows `crates/gateway/src/server/serve.rs` alone; the nightly device lane is `backup-measurement`; `restore-drill` runs both drills; core.v1 is held to `WIRE_JSON` (A22).
- **The drill**: `crates/centraid/tests/restore_drill.rs` — pair, back up a real JPEG with core-derived tiers, the shell's derivatives, a library photograph and a film above 64 MiB; every name confirmed in the ledger and held by the gateway; no plaintext, plaintext hash or key in the gateway's directory; fifty commits and a second snapshot; a phone holding nothing restores from the words at writer epoch 2; every row equal; every derivative back; the film fetched by name verifies; the old phone refused `VAULT_MOVED`.

### Rulings

R-1080-C1 to R-1080-C37, the root's amendment A22, and lane A's R-1080-A1 to R-1080-A17 are in [docs/decisions.md](../docs/decisions.md#the-gateway-v2-and-the-cut-over-1080). Two are product-visible and flagged as such: C13 (a video waits for a charger, and under MANUAL originals wait for the member's tap — the tap is `DrainRequest.asked` since A24) and C14 (a metered link takes a snapshot only under `WIFI_AND_CELLULAR_PHOTOS`). Red first: the staged-renditions test failed without `promote_staged_renditions`; `confirm_held`'s test asserted `Waiting` first; the last-close WAL test fails under the old pragmas; the A24 test failed with `asked` read from `wants_snapshot` and passes with it read from the tap.

### Open items

- **A library item above the spool budget**: an OS-library original is sealed through `FileSealer` into the spool in the stage stream, so one larger than the spool's budget waits; an owned file is sealed part by part and does not.
- **Batching the spool's per-range syncs**: a snapshot's ranges are written to the spool one fsync each; batching them is a measured follow-up, not built.
- **The release tarball does not ship `centraid-gateway`**: `lane-prebuilt-core.yml` builds `--bin centraid` alone, so `deploy/vps/install.sh` installs no gateway and refuses `--with-service` until it does.
- **No consumer, not changed**: the `access_device` and `access_device_secret` tables (no writer; no rung drops them); `centraid_media::format::derive_data_key`; `change.proto`'s `ConnectivityState`; `command.proto`'s `SyncWindow` and `SyncBudget`.
- **Stale outside this lane's files**: `docs/blueprint-seats.md` item 1 cites the deleted `plan.rs`; `scripts/docs-site` describes the #1029 gateway's verbs; `docs/release.md`, `docs/release/v1-handoffs.md`, `docs/toolchain.md` and `flake.nix` name the old binary or images; `.governance/law/out/arrival.json` lists deleted paths; `mobile/iosApp/Sources/VaultFileProtection.swift` names `backup2`.

### Verification

Run on the slice-5 tree, with `CARGO_TARGET_DIR` the shared target emptied by the root before slice 3b (a cold build).

- `cargo xtask gate --profile local` — **PASS**, scored cold (337.9 s of the 3,200 s `coldLocalProfileSeconds` ceiling):
  - `ok fmt 1.6s cargo fmt --all --check`
  - `ok clippy 33.9s cargo clippy --workspace --all-targets -- -D warnings`
  - `ok test 272.1s cargo test --workspace`
  - `ok restore-drill 30.0s back a vault up, lose it with its ledger and spool, and restore it row for row; then lose the PHONE, restore from 24 words across the real gateway, and freeze the old one, in 30.0s (no budget slot by ruling)`
  - `ok rules 0.2s 4 rule(s) applied` — `sql-confinement` 219 files clean, `abi-five-symbols` 9 clean, `no-listening-socket` 335 clean with 1 file on the listener allowlist, `commonmain-no-platform-import` 210 clean
  - `ok ledgers 0.0s 5 ledger(s) hold against 23e46810`
- `cargo run -p centraid-vault --bin export-ladder-ddl` diffed against `contracts/schema/vault-ddl.sql` — no diff.
- `buf lint` — exit 0; `buf breaking --against '.git#branch=main,subdir=crates/api-proto/proto'` — exit 0, under `WIRE_JSON` (A22), with no `v*` tag in the window. The gate's `buf` step is required in CI and skipped loudly where `buf` is absent, so this is where it is proved locally.
- `grep -n iroh Cargo.lock` — empty. `grep -rn iroh crates --include=*.rs` — four lines, each citing #1080: `crates/identity/src/lib.rs:15`, `crates/xtask/src/rules.rs:397`, `crates/vault/tests/baseline.rs:82`, `crates/vault/tests/common/mod.rs:186`.
- `grep -rn "backup2\|gateway2" crates Cargo.toml deploy scripts` — empty. `ls crates | grep gateway` — `gateway`. `ls crates/vault/src/backup` — `drill files ledger mod mover naming restore retention snapshot spool store`.
- `cargo run -p centraid-gateway --features server --bin centraid-gateway -- --help` — `serve`, `pair`, `pairings`, `scrub`, `health`, `install`.
- `bun scripts/security/unsafe-edge-audit.mjs` — OK (core-ffi 97 after the `PERSIST_WAL` shim left; `crates/gateway` 0).
- Per slice, crate-scoped: slice 3a `cargo test` over vault, media, identity, blobs, api-proto, core, core-ffi, centraid, apps-docs, protocol and xtask green, `cargo clippy --workspace --all-targets -- -D warnings` clean; slice 3b the same over gateway, vault, core, core-ffi, centraid, xtask, blobs, api-proto after a cold `cargo check --workspace --all-targets`; slice 4 `cargo test -p centraid --test restore_drill` 1 passed in 20 s.
- `bash .governance/run.sh < /dev/null` — every directive passes but `law`, whose one finding is `receipt-per-issue`: the receipt's `## Audit` records no PASS/REFUTED verdict yet, which is the independent reviewer's verdict at the umbrella's close, not a lane's.

### Every file this lane changed, by commit

**`f9791e176` feat(api-proto): the backup v2 wire contract and its six doors (#1080)**

- Changed (12): `crates/api-proto/proto/centraid/core/v1/content.proto`, `crates/api-proto/proto/centraid/core/v1/envelope.proto`, `crates/api-proto/proto/centraid/core/v1/phone.proto`, `crates/centraid/tests/drain_wire.rs`, `crates/centraid/tests/restore_drill.rs`, `crates/core-ffi/CONTRACT.md`, `crates/core-ffi/tests/contract.rs`, `crates/core/src/api.rs`, `crates/core/src/app_query/docs_tests.rs`, `crates/core/src/handle.rs`, `crates/core/src/phone/drain.rs`, `crates/core/src/phone/mod.rs`.

**`94376cf99` feat(blobs): a directory content store, and local_bytes lands (#1080)**

- Added (1): `crates/vault/src/bytes.rs`.
- Changed (32): `Cargo.lock`, `Cargo.toml`, `crates/blobs/Cargo.toml`, `crates/blobs/src/door.rs`, `crates/blobs/src/hash.rs`, `crates/blobs/src/lib.rs`, `crates/blobs/src/plan.rs`, `crates/blobs/src/store.rs`, `crates/blobs/tests/eviction.rs`, `crates/blobs/tests/reopen.rs`, `crates/centraid/src/bin/seed-demo-vault.rs`, `crates/centraid/tests/derive_sweep.rs`, `crates/centraid/tests/restore_drill.rs`, `crates/core-ffi/CONTRACT.md`, `crates/core-ffi/src/lib.rs`, `crates/core-ffi/tests/reopen.rs`, `crates/core/src/api.rs`, `crates/core/src/app_query/docs_tests.rs`, `crates/core/src/handle.rs`, `crates/vault/Cargo.toml`, `crates/vault/src/backup/store.rs`, `crates/vault/src/backup2/ledger.rs`, `crates/vault/src/commands/mod.rs`, `crates/vault/src/content.rs`, `crates/vault/src/file.rs`, `crates/vault/src/lib.rs`, `crates/vault/src/page.rs`, `crates/vault/tests/common/mod.rs`, `crates/vault/tests/media_commands.rs`, `crates/vault/tests/one_hash.rs`, `deny.toml`, `scripts/security/rust-supply-chain.mjs`.

**`570b640aa` feat(vault): 64 KiB ranges, and bundles both ways (#1080)**

- Changed (8): `Cargo.lock`, `crates/vault/src/backup2/ledger.rs`, `crates/vault/src/backup2/mod.rs`, `crates/vault/src/backup2/mover.rs`, `crates/vault/src/backup2/restore.rs`, `crates/vault/src/backup2/snapshot.rs`, `crates/vault/src/backup2/store.rs`, `crates/vault/tests/backup2_snapshot.rs`.

**`c4c89c5d1` feat(identity): one safety number over any two 32-byte strings (#1080)**

- Changed (4): `crates/gateway2/README.md`, `crates/gateway2/src/server/report.rs`, `crates/identity/src/lib.rs`, `crates/identity/src/safety_number.rs`.

**`618c15258` feat(core): the phone core on the backup plane v2 (#1080)**

- Added (4): `crates/core/src/phone/fetch.rs`, `crates/core/src/phone/pair.rs`, `crates/core/tests/phone_backup.rs`, `crates/vault/src/backup2/files.rs`.
- Changed (34): `Cargo.lock`, `Cargo.toml`, `crates/api-proto/proto/centraid/core/v1/content.proto`, `crates/api-proto/proto/centraid/core/v1/envelope.proto`, `crates/api-proto/proto/centraid/core/v1/phone.proto`, `crates/blobs/src/door.rs`, `crates/centraid/Cargo.toml`, `crates/centraid/src/bin/seed-demo-vault.rs`, `crates/centraid/tests/restore_drill.rs`, `crates/core-ffi/CONTRACT.md`, `crates/core-ffi/src/marshal.rs`, `crates/core-ffi/tests/contract.rs`, `crates/core/Cargo.toml`, `crates/core/src/app_query/locker_tests.rs`, `crates/core/src/config.rs`, `crates/core/src/error.rs`, `crates/core/src/handle.rs`, `crates/core/src/lib.rs`, `crates/core/src/originals.rs`, `crates/core/src/phone/drain.rs`, `crates/core/src/phone/link.rs`, `crates/core/src/phone/mod.rs`, `crates/core/src/phone/restore.rs`, `crates/core/src/stage.rs`, `crates/vault/src/backup2/drill.rs`, `crates/vault/src/backup2/ledger.rs`, `crates/vault/src/backup2/mod.rs`, `crates/vault/src/backup2/mover.rs`, `crates/vault/src/backup2/snapshot.rs`, `crates/vault/src/commands/core.rs`, `crates/vault/src/content.rs`, `crates/vault/src/originals.rs`, `crates/vault/tests/media_commands.rs`, `crates/vault/tests/one_hash.rs`.
- Deleted (1): `crates/centraid/tests/drain_wire.rs`.

**`4c4957bad` refactor(backup): the old plane and the iroh gateway leave (#1080)**

- Added (2): `contracts/migrations/010_backup_v2.sql`, `crates/vault/tests/backup_v2_rung.rs`.
- Changed (67): `.github/workflows/gate-nightly.yml`, `Cargo.lock`, `Cargo.toml`, `buf.yaml`, `contracts/crypto/blake3-vectors.json`, `contracts/handoff/E/device-lane-bodies.md`, `contracts/schema/vault-ddl.sql`, `crates/api-proto/README.md`, `crates/api-proto/build.rs`, `crates/api-proto/proto/centraid/core/v1/error.proto`, `crates/api-proto/proto/centraid/core/v1/phone.proto`, `crates/api-proto/proto/centraid/core/v1/vault.proto`, `crates/api-proto/tests/roundtrip.rs`, `crates/apps/docs/tests/door.rs`, `crates/blobs/src/lib.rs`, `crates/centraid/Cargo.toml`, `crates/centraid/src/cmd/doctor.rs`, `crates/centraid/src/cmd/mod.rs`, `crates/core-ffi/CONTRACT.md`, `crates/core-ffi/include/centraid.h`, `crates/core-ffi/src/lib.rs`, `crates/core-ffi/src/marshal.rs`, `crates/core/src/error.rs`, `crates/core/src/phone/restore.rs`, `crates/core/tests/phone_backup.rs`, `crates/identity/Cargo.toml`, `crates/identity/src/derive.rs`, `crates/identity/src/lib.rs`, `crates/identity/src/phrase.rs`, `crates/identity/src/safety_number.rs`, `crates/media/Cargo.toml`, `crates/media/src/format.rs`, `crates/media/src/lib.rs`, `crates/media/src/renditions.rs`, `crates/media/tests/primitives.rs`, `crates/protocol/src/lib.rs`, `crates/vault/src/backup2/mod.rs`, `crates/vault/src/backup2/naming.rs`, `crates/vault/src/backup2/restore.rs`, `crates/vault/src/bytes.rs`, `crates/vault/src/commands/core.rs`, `crates/vault/src/content.rs`, `crates/vault/src/custody/locker_key.rs`, `crates/vault/src/custody/mod.rs`, `crates/vault/src/file.rs`, `crates/vault/src/lib.rs`, `crates/vault/src/log/guard.rs`, `crates/vault/src/log/mod.rs`, `crates/vault/src/migrations.rs`, `crates/vault/src/page.rs`, `crates/vault/tests/baseline.rs`, `crates/vault/tests/change_census.rs`, `crates/vault/tests/collection_kind.rs`, `crates/vault/tests/common/mod.rs`, `crates/vault/tests/docs_commands.rs`, `crates/vault/tests/ladder_ddl.rs`, `crates/vault/tests/locker_plaintext_gate.rs`, `crates/vault/tests/one_hash.rs`, `crates/vault/tests/restore_drill.rs`, `crates/vault/tests/snapshot_faults.rs`, `crates/xtask/README.md`, `crates/xtask/src/gate.rs`, `crates/xtask/src/measure.rs`, `crates/xtask/src/rules.rs`, `deny.toml`, `scripts/security/rust-supply-chain.mjs`, `scripts/security/rust-unsafe-ledger.json`.
- Deleted (103): `contracts/crypto/discovery-vectors.json`, `contracts/crypto/object-vectors.json`, `crates/api-proto/proto/centraid/core/v1/admin.proto`, `crates/api-proto/proto/centraid/core/v1/backup.proto`, `crates/api-proto/proto/centraid/core/v1/gateway.proto`, `crates/api-proto/proto/centraid/core/v1/lease.proto`, `crates/api-proto/proto/centraid/core/v1/pair.proto`, `crates/blobs/src/plan.rs`, `crates/centraid/tests/restore_drill.rs`, `crates/core-ffi/src/wal.rs`, `crates/core-ffi/tests/wal_persistence.rs`, `crates/gateway-client/Cargo.toml`, `crates/gateway-client/src/client.rs`, `crates/gateway-client/src/directory.rs`, `crates/gateway-client/src/lib.rs`, `crates/gateway-client/src/outcome.rs`, `crates/gateway-client/src/publish.rs`, `crates/gateway-client/src/signer.rs`, `crates/gateway-client/src/spool.rs`, `crates/gateway-client/src/transport.rs`, `crates/gateway-core/Cargo.toml`, `crates/gateway-core/README.md`, `crates/gateway-core/src/auth.rs`, `crates/gateway-core/src/commit.rs`, `crates/gateway-core/src/conformance.rs`, `crates/gateway-core/src/engine.rs`, `crates/gateway-core/src/error.rs`, `crates/gateway-core/src/ids.rs`, `crates/gateway-core/src/lease.rs`, `crates/gateway-core/src/lib.rs`, `crates/gateway-core/src/memory.rs`, `crates/gateway-core/src/plan.rs`, `crates/gateway-core/src/retention.rs`, `crates/gateway-core/src/scrub.rs`, `crates/gateway-core/src/store.rs`, `crates/gateway-core/src/time.rs`, `crates/gateway-core/src/upload.rs`, `crates/gateway-core/src/version.rs`, `crates/gateway-core/tests/audit_ledger.rs`, `crates/gateway-core/tests/conformance.rs`, `crates/gateway-core/tests/pure_rules.rs`, `crates/gateway-server/Cargo.toml`, `crates/gateway-server/README.md`, `crates/gateway-server/src/acme.rs`, `crates/gateway-server/src/bin/centraid-gateway.rs`, `crates/gateway-server/src/bytes/configured.rs`, `crates/gateway-server/src/bytes/fs.rs`, `crates/gateway-server/src/bytes/mod.rs`, `crates/gateway-server/src/clock.rs`, `crates/gateway-server/src/config.rs`, `crates/gateway-server/src/http.rs`, `crates/gateway-server/src/lib.rs`, `crates/gateway-server/src/serve.rs`, `crates/gateway-server/src/service.rs`, `crates/gateway-server/src/sql.rs`, `crates/gateway-server/src/state.rs`, `crates/gateway-server/src/sweeps.rs`, `crates/gateway-server/src/tenancy.rs`, `crates/gateway-server/tests/audit_ledger.rs`, `crates/gateway-server/tests/canary.rs`, `crates/gateway-server/tests/common/mod.rs`, `crates/gateway-server/tests/conformance.rs`, `crates/gateway-server/tests/container.rs`, `crates/gateway-server/tests/first_run.rs`, `crates/gateway-server/tests/no_rules_here.rs`, `crates/gateway-server/tests/sweeps.rs`, `crates/gateway-server/tests/tenancy.rs`, `crates/gateway-server/tests/wire_iroh.rs`, `crates/identity/src/certificate.rs`, `crates/identity/src/discovery.rs`, `crates/identity/src/record.rs`, `crates/identity/src/ticket.rs`, `crates/identity/tests/discovery_round_trip.rs`, `crates/identity/tests/discovery_vectors.rs`, `crates/media/src/object/dict.rs`, `crates/media/src/object/header.rs`, `crates/media/src/object/mod.rs`, `crates/media/src/object/pack.rs`, `crates/media/src/object/pad.rs`, `crates/media/tests/object.rs`, `crates/media/tests/object_vectors.rs`, `crates/vault/src/backup/base.rs`, `crates/vault/src/backup/capture.rs`, `crates/vault/src/backup/custody.rs`, `crates/vault/src/backup/drill.rs`, `crates/vault/src/backup/manifest.rs`, `crates/vault/src/backup/mod.rs`, `crates/vault/src/backup/objects.rs`, `crates/vault/src/backup/policy.rs`, `crates/vault/src/backup/restore.rs`, `crates/vault/src/backup/segment.rs`, `crates/vault/src/backup/spool.rs`, `crates/vault/src/backup/store.rs`, `crates/vault/src/backup/wal.rs`, `crates/vault/src/devices.rs`, `crates/vault/src/log/census.rs`, `crates/vault/src/wal_persistence.rs`, `crates/vault/tests/backup2_drill.rs`, `crates/vault/tests/backup_crash_matrix.rs`, `crates/vault/tests/dictionary_durability.rs`, `crates/vault/tests/relaunch.rs`, `crates/vault/tests/restore_grid.rs`, `crates/vault/tests/running_census.rs`.

**`f8fbd337d` refactor(gateway): one gateway, one backup plane, by name (#1080)**

- Changed (45): `.github/dependabot.yml`, `.github/workflows/lane-release-gateway-image.yml`, `Cargo.lock`, `Cargo.toml`, `buf.yaml`, `contracts/README.md`, `crates/api-proto/README.md`, `crates/api-proto/proto/centraid/core/v1/error.proto`, `crates/api-proto/proto/centraid/core/v1/phone.proto`, `crates/api-proto/tests/roundtrip.rs`, `crates/blobs/src/door.rs`, `crates/blobs/src/lib.rs`, `crates/centraid/Cargo.toml`, `crates/centraid/README.md`, `crates/centraid/src/cmd/doctor.rs`, `crates/centraid/src/cmd/mod.rs`, `crates/centraid/src/main.rs`, `crates/centraid/src/run.rs`, `crates/core/Cargo.toml`, `crates/core/README.md`, `crates/core/src/error.rs`, `crates/core/src/handle.rs`, `crates/core/src/phone/drain.rs`, `crates/core/src/phone/fetch.rs`, `crates/core/src/phone/link.rs`, `crates/core/src/phone/mod.rs`, `crates/core/src/phone/pair.rs`, `crates/core/src/phone/restore.rs`, `crates/core/src/stage.rs`, `crates/core/tests/phone_backup.rs`, `crates/vault/src/commands/core.rs`, `crates/vault/src/lib.rs`, `crates/vault/tests/common/mod.rs`, `crates/vault/tests/locker_plaintext_gate.rs`, `crates/vault/tests/media_commands.rs`, `crates/vault/tests/one_hash.rs`, `crates/vault/tests/restore_drill.rs`, `crates/xtask/README.md`, `crates/xtask/src/gate.rs`, `crates/xtask/src/measure.rs`, `crates/xtask/src/rules.rs`, `deploy/README.md`, `deploy/vps/install.sh`, `docs/identifiers.md`, `scripts/security/rust-unsafe-ledger.json`.
- Renamed (76): `crates/gateway2/Cargo.toml` → `crates/gateway/Cargo.toml`, `crates/gateway2/README.md` → `crates/gateway/README.md`, `crates/gateway2/src/bin/centraid-gateway2.rs` → `crates/gateway/src/bin/centraid-gateway.rs`, `crates/gateway2/src/client/mod.rs` → `crates/gateway/src/client/mod.rs`, `crates/gateway2/src/client/tls.rs` → `crates/gateway/src/client/tls.rs`, `crates/gateway2/src/lib.rs` → `crates/gateway/src/lib.rs`, `crates/gateway2/src/rules/bundle.rs` → `crates/gateway/src/rules/bundle.rs`, `crates/gateway2/src/rules/claim.rs` → `crates/gateway/src/rules/claim.rs`, `crates/gateway2/src/rules/code.rs` → `crates/gateway/src/rules/code.rs`, `crates/gateway2/src/rules/conformance.rs` → `crates/gateway/src/rules/conformance.rs`, `crates/gateway2/src/rules/engine.rs` → `crates/gateway/src/rules/engine.rs`, `crates/gateway2/src/rules/ids.rs` → `crates/gateway/src/rules/ids.rs`, `crates/gateway2/src/rules/limits.rs` → `crates/gateway/src/rules/limits.rs`, `crates/gateway2/src/rules/memory.rs` → `crates/gateway/src/rules/memory.rs`, `crates/gateway2/src/rules/mod.rs` → `crates/gateway/src/rules/mod.rs`, `crates/gateway2/src/rules/payload.rs` → `crates/gateway/src/rules/payload.rs`, `crates/gateway2/src/rules/range.rs` → `crates/gateway/src/rules/range.rs`, `crates/gateway2/src/rules/state.rs` → `crates/gateway/src/rules/state.rs`, `crates/gateway2/src/rules/wire.rs` → `crates/gateway/src/rules/wire.rs`, `crates/gateway2/src/server/addrs.rs` → `crates/gateway/src/server/addrs.rs`, `crates/gateway2/src/server/harness.rs` → `crates/gateway/src/server/harness.rs`, `crates/gateway2/src/server/http.rs` → `crates/gateway/src/server/http.rs`, `crates/gateway2/src/server/mod.rs` → `crates/gateway/src/server/mod.rs`, `crates/gateway2/src/server/qr.rs` → `crates/gateway/src/server/qr.rs`, `crates/gateway2/src/server/report.rs` → `crates/gateway/src/server/report.rs`, `crates/gateway2/src/server/serve.rs` → `crates/gateway/src/server/serve.rs`, `crates/gateway2/src/server/service.rs` → `crates/gateway/src/server/service.rs`, `crates/gateway2/src/server/sql.rs` → `crates/gateway/src/server/sql.rs`, `crates/gateway2/src/server/sql/begin.sql` → `crates/gateway/src/server/sql/begin.sql`, `crates/gateway2/src/server/sql/commit.sql` → `crates/gateway/src/server/sql/commit.sql`, `crates/gateway2/src/server/sql/head_select.sql` → `crates/gateway/src/server/sql/head_select.sql`, `crates/gateway2/src/server/sql/head_upsert.sql` → `crates/gateway/src/server/sql/head_upsert.sql`, `crates/gateway2/src/server/sql/object_delete.sql` → `crates/gateway/src/server/sql/object_delete.sql`, `crates/gateway2/src/server/sql/object_select.sql` → `crates/gateway/src/server/sql/object_select.sql`, `crates/gateway2/src/server/sql/object_upsert.sql` → `crates/gateway/src/server/sql/object_upsert.sql`, `crates/gateway2/src/server/sql/objects_all_select.sql` → `crates/gateway/src/server/sql/objects_all_select.sql`, `crates/gateway2/src/server/sql/objects_live_select.sql` → `crates/gateway/src/server/sql/objects_live_select.sql`, `crates/gateway2/src/server/sql/purgeable_select.sql` → `crates/gateway/src/server/sql/purgeable_select.sql`, `crates/gateway2/src/server/sql/rollback.sql` → `crates/gateway/src/server/sql/rollback.sql`, `crates/gateway2/src/server/sql/schema.sql` → `crates/gateway/src/server/sql/schema.sql`, `crates/gateway2/src/server/sql/secret_select.sql` → `crates/gateway/src/server/sql/secret_select.sql`, `crates/gateway2/src/server/sql/secret_upsert.sql` → `crates/gateway/src/server/sql/secret_upsert.sql`, `crates/gateway2/src/server/sql/secrets_select.sql` → `crates/gateway/src/server/sql/secrets_select.sql`, `crates/gateway2/src/server/sql/snapshot_delete.sql` → `crates/gateway/src/server/sql/snapshot_delete.sql`, `crates/gateway2/src/server/sql/snapshot_insert.sql` → `crates/gateway/src/server/sql/snapshot_insert.sql`, `crates/gateway2/src/server/sql/snapshots_select.sql` → `crates/gateway/src/server/sql/snapshots_select.sql`, `crates/gateway2/src/server/sql/token_insert.sql` → `crates/gateway/src/server/sql/token_insert.sql`, `crates/gateway2/src/server/sql/token_select.sql` → `crates/gateway/src/server/sql/token_select.sql`, `crates/gateway2/src/server/sql/tokens_select.sql` → `crates/gateway/src/server/sql/tokens_select.sql`, `crates/gateway2/src/server/sql/vault_select.sql` → `crates/gateway/src/server/sql/vault_select.sql`, `crates/gateway2/src/server/sql/vault_upsert.sql` → `crates/gateway/src/server/sql/vault_upsert.sql`, `crates/gateway2/src/server/sql/vaults_select.sql` → `crates/gateway/src/server/sql/vaults_select.sql`, `crates/gateway2/src/server/state.rs` → `crates/gateway/src/server/state.rs`, `crates/gateway2/src/server/store.rs` → `crates/gateway/src/server/store.rs`, `crates/gateway2/src/server/sweeps.rs` → `crates/gateway/src/server/sweeps.rs`, `crates/gateway2/src/server/tls.rs` → `crates/gateway/src/server/tls.rs`, `crates/gateway2/tests/conformance.rs` → `crates/gateway/tests/conformance.rs`, `crates/gateway2/tests/conformance_wire.rs` → `crates/gateway/tests/conformance_wire.rs`, `crates/gateway2/tests/pair_from_payload.rs` → `crates/gateway/tests/pair_from_payload.rs`, `crates/gateway2/tests/pure_rules.rs` → `crates/gateway/tests/pure_rules.rs`, `crates/gateway2/tests/store_client.rs` → `crates/gateway/tests/store_client.rs`, `crates/gateway2/tests/tls.rs` → `crates/gateway/tests/tls.rs`, `crates/vault/src/backup2/drill.rs` → `crates/vault/src/backup/drill.rs`, `crates/vault/src/backup2/files.rs` → `crates/vault/src/backup/files.rs`, `crates/vault/src/backup2/ledger.rs` → `crates/vault/src/backup/ledger.rs`, `crates/vault/src/backup2/mod.rs` → `crates/vault/src/backup/mod.rs`, `crates/vault/src/backup2/mover.rs` → `crates/vault/src/backup/mover.rs`, `crates/vault/src/backup2/naming.rs` → `crates/vault/src/backup/naming.rs`, `crates/vault/src/backup2/restore.rs` → `crates/vault/src/backup/restore.rs`, `crates/vault/src/backup2/retention.rs` → `crates/vault/src/backup/retention.rs`, `crates/vault/src/backup2/snapshot.rs` → `crates/vault/src/backup/snapshot.rs`, `crates/vault/src/backup2/spool.rs` → `crates/vault/src/backup/spool.rs`, `crates/vault/src/backup2/store.rs` → `crates/vault/src/backup/store.rs`, `crates/vault/tests/backup2_snapshot.rs` → `crates/vault/tests/backup_snapshot.rs`, `deploy/gateway2/Dockerfile` → `deploy/gateway/Dockerfile`, `deploy/gateway-server/README.md` → `deploy/gateway/README.md`.
- Deleted (39): `contracts/deploy/units/README.md`, `contracts/deploy/units/centraid-gateway.user.service.expected`, `contracts/deploy/units/centraid-gateway@.system.service.expected`, `contracts/deploy/units/dev.centraid.gateway.plist.expected`, `contracts/deploy/units/export-v0-units.ts`, `contracts/gateway/queries/account_upsert.sql`, `contracts/gateway/queries/base_object_clear.sql`, `contracts/gateway/queries/base_object_insert.sql`, `contracts/gateway/queries/base_objects_select.sql`, `contracts/gateway/queries/base_upsert.sql`, `contracts/gateway/queries/bases_select.sql`, `contracts/gateway/queries/client_base_delete_select.sql`, `contracts/gateway/queries/client_base_delete_upsert.sql`, `contracts/gateway/queries/client_delete_insert.sql`, `contracts/gateway/queries/head_select.sql`, `contracts/gateway/queries/head_update.sql`, `contracts/gateway/queries/invite_insert.sql`, `contracts/gateway/queries/invite_redeem.sql`, `contracts/gateway/queries/invite_select.sql`, `contracts/gateway/queries/invites_select.sql`, `contracts/gateway/queries/object_select.sql`, `contracts/gateway/queries/object_upsert.sql`, `contracts/gateway/queries/objects_select.sql`, `contracts/gateway/queries/table_dump.sql`, `contracts/gateway/queries/tables_select.sql`, `contracts/gateway/queries/vault_select.sql`, `contracts/gateway/queries/vault_upsert.sql`, `contracts/gateway/queries/vaults_select.sql`, `contracts/gateway/schema.sql`, `contracts/gateway/standalone.sql`, `crates/centraid/src/cmd/gateway_install.rs`, `crates/centraid/src/cmd/units.rs`, `crates/centraid/tests/container.rs`, `crates/centraid/tests/gateway_install.rs`, `deploy/docker/Dockerfile`, `deploy/gateway-server/Dockerfile`, `deploy/launchd/dev.centraid.gateway.plist`, `deploy/systemd/centraid-gateway.service`, `deploy/systemd/system/centraid-gateway@.service`.

**`fa51a8d71` test(centraid): the restore drill crosses the real gateway (#1080)**

- Added (1): `crates/centraid/tests/restore_drill.rs`.
- Changed (9): `Cargo.lock`, `crates/api-proto/proto/centraid/core/v1/phone.proto`, `crates/centraid/Cargo.toml`, `crates/core-ffi/CONTRACT.md`, `crates/core/src/phone/drain.rs`, `crates/core/tests/phone_backup.rs`, `crates/vault/src/backup/drill.rs`, `crates/xtask/README.md`, `crates/xtask/src/gate.rs`.

**The slice-5 commit** (receipt, decisions, changelog, READMEs)

- Added (1): `crates/blobs/README.md`.
- Changed (6): `CHANGELOG.md`, `crates/core/README.md`, `crates/media/README.md`, `crates/vault/README.md`, `docs/decisions.md`, `receipts/issue-1080-backups-v2.md`.

### The audit's fix round

On the umbrella at `511a20ee3` (the audit's first verdict, REFUTED), which fast-forwarded this branch. Each finding red first, then green.

- **Finding 2, tokens are revoked** (`c69c3ec47`). `POST /v2/v/{vault}/revoke` forgets the bearer token that calls it, so it is `UNAUTHORIZED` on every route after, a second revoke included; any token of the vault may revoke itself, a superseded writer's too. The rules gain `State::remove_token`, `Gateway::revoke` and `Gateway::revoke_hash`; the conformance suite gains its 31st case, `auth/a-revoked-token-is-unauthorized-everywhere`, in memory and over the wire; the client gains `Client::revoke`. `centraid-gateway pairings` prints each token's id (the first 12 hex characters of its BLAKE3) and `pairings revoke <token id>` forgets the one it names, for a lost phone. `forget_destination` revokes this phone's token first, best-effort, and `ForgetDestinationResponse.revoked` (2) says whether the gateway answered so; an unreachable gateway is forgotten all the same. Red first: a no-op token delete failed both `tests/revoke.rs` cases (a revoked token's `PUT` and `GET`), a no-op revoke failed the conformance case, and a forget that never dialled failed `forgetting_a_gateway_revokes_this_phones_token_there`. `docs/gateway.md` has the route row and `SECURITY.md` the lost-phone line.
- **Finding 4** (`8f379ef44`). `WAIT_REASON_ASK` (7): an original `MANUAL` holds waits for the member's tap, a video off the charger included, since the tap lets that through too. Red first: `an_original_manual_holds_waits_for_the_members_tap` answered `WINDOW`.
- **Finding 5** (`89cba7738`). A wrong certificate and a damaged copy are no longer an absent gateway. `StoreError::Untrusted` and `StoreError::Damaged`; the client's digest failures are `ClientError::Damaged`; the mover stops `Stop::Untrusted`; `link::reach` says when the machine that answered was not the pinned gateway. A pass stops `DRAIN_STOP_UNTRUSTED` (4) and `backup_status` waits `WAIT_REASON_UNTRUSTED` (8) until a pass reaches the gateway again; a fetch answers `FETCH_OUTCOME_UNTRUSTED` (5), or `FETCH_OUTCOME_DAMAGED` (6) for bytes off their digest, a part that does not open or parts that are not their file, and lands nothing. Red first: the phone test's flipped bit answered `UNREACHABLE`, the link mapping test failed, and the mover's impostor stopped `Unreachable`.
- **Finding 6c** (`b02c8f696`). `crates/centraid/src/cmd/mod.rs` no longer says a restore picks "a base and a txid".
- **R-1080-C14 is superseded by R-1080-C38** (`7a7e8472f`): "Back up now" sends the snapshot over a metered link under any rule, `MANUAL` included; originals still follow the rule. Red first: `a_tap_sends_the_records_over_a_metered_link_under_any_rule` failed on `WIFI_ONLY`.

**For the shells.** New wire values with no copy yet: `WAIT_REASON_ASK` 7, `WAIT_REASON_UNTRUSTED` 8, `DRAIN_STOP_UNTRUSTED` 4, `FETCH_OUTCOME_UNTRUSTED` 5, `FETCH_OUTCOME_DAMAGED` 6, `ForgetDestinationResponse.revoked` 2. Stale outside this lane's files: `docs/mobile-offline.md:36` lists a pass's stops without `UNTRUSTED`, and `:52` and `:79` say no snapshot is taken on a metered link, which a tap now overrides (R-1080-C38).

**Verification.** `cargo test -p centraid-gateway -p centraid-core -p centraid-vault`: 694 passed in 45 suites, none failed. `cargo xtask gate --profile local`, warm: every step ok (fmt 1.4 s, clippy 22.6 s, test 250.0 s, restore-drill 30.0 s, rules 0.2 s, ledgers 0.0 s), and `FAIL — over budget`, 304.2 s of 120 s, the budget the audit already records as open. `buf lint` and `buf breaking --against '.git#branch=main,subdir=crates/api-proto/proto'`: exit 0. `bun run format`: clean. `bash .governance/run.sh < /dev/null`: all six directives pass.

**Files, by commit.** `c69c3ec47`: `SECURITY.md`, `docs/gateway.md`, `crates/gateway/{Cargo.toml,README.md}`, `crates/gateway/src/{bin/centraid-gateway.rs,client/mod.rs}`, `crates/gateway/src/rules/{conformance,engine,memory,state,wire}.rs`, `crates/gateway/src/server/{http,report,sql,state}.rs`, `crates/gateway/src/server/sql/token_delete.sql` (added), `crates/gateway/tests/{conformance,conformance_wire}.rs`, `crates/gateway/tests/revoke.rs` (added), `crates/api-proto/proto/centraid/core/v1/phone.proto`, `crates/core-ffi/CONTRACT.md`, `crates/core/src/{handle.rs,phone/mod.rs}`, `crates/core/tests/phone_backup.rs`. `8f379ef44`: `phone.proto`, `crates/core/src/phone/drain.rs`. `89cba7738`: `phone.proto`, `crates/core/src/phone/{drain,fetch,link,mod,restore}.rs`, `crates/core/tests/phone_backup.rs`, `crates/gateway/{README.md,src/client/mod.rs}`, `crates/vault/src/backup/{mover,store}.rs`. `b02c8f696`: `crates/centraid/src/cmd/mod.rs`. `7a7e8472f`: `phone.proto`, `crates/core-ffi/CONTRACT.md`, `crates/core/src/phone/drain.rs`, `docs/decisions.md`. This receipt's commit: `receipts/issue-1080-backups-v2.md`, `CHANGELOG.md`.

## Lane E — free up space's two deleters, on the cut-over

Lane E's third round on [#1080](https://github.com/srikanth235/centraid/issues/1080): the shells' half of amendments A19 and A20, and three stale lines other lanes and the audit found in the shells. The round was relaunched from the first agent's uncommitted work, which is kept whole. Like lane E's earlier sections, it was written with no Xcode and no Android SDK in the container, so neither shell has been compiled; every device claim is a row of [v1-handoffs.md §8](../docs/release/v1-handoffs.md#8-the-backups-native-halves-1080).

### What changed

| Commit | What |
| --- | --- |
| `88e372946` | The two `LibraryDeleter`s. iOS: `PhotoLibraryDeleter` runs `PHAssetChangeRequest.deleteAssets` inside `performChanges`, so Photos' own alert is the confirmation; its pure half, `LibraryDeletion`, has six XCTests, each rule's refusal among them; `ShellModel` installs it once through `HomeBridge.installLibraryDeleter`. Android: `MediaStoreDeleter` asks `MediaStore.createDeleteRequest` through a launcher `MainActivity` registers as a field, installed on the session when it opens and cleared when the activity goes, only if still its own; `NONE` below API 30. Home's forget-vault comment, the measurement corpus's edited-photograph line, R-1080-E12 and E13, hand-off rows 8.19 and 8.20, owner question PH4. |
| `71cc358ac` | The umbrella at `02081b557` merged, never rebased. `docs/decisions.md` resolves as a union, the umbrella's text first and byte for byte (`head -n 2365` equals the umbrella's file), then lane E's section; `docs/release/v1-handoffs.md` merged clean. |
| this section's commit | `ScreenFixtureTests` stops asserting the reserved `BackupState.transport`; `VaultFileProtection` names `crates/vault/src/backup/ledger.rs`; `project.yml`'s camera and local-network comments say what is true today; R-1080-E14; row 8.1 runs `ScreenFixtureTests` too; this section. |

| File | Change |
| --- | --- |
| `mobile/iosApp/Sources/PhotoLibraryDeleter.swift` (added) | `LibraryDeletion` (which assets may go, what an answer meant) and `PhotoLibraryDeleter` (the `LibraryDeleter`) |
| `mobile/iosApp/Tests/LibraryDeletionTests.swift` (added) | six tests: an offered photo may go; an edited asset, a Live Photo without its movie and a movie row alone are kept; a ref names its asset; a yes, a no and a failure |
| `mobile/androidApp/src/main/kotlin/dev/centraid/android/backup/MediaStoreDeleter.kt` (added) | the `LibraryDeleter` over `createDeleteRequest`, its launcher, the request kept across a rotation |
| `mobile/iosApp/Sources/ShellModel.swift` | installs the deleter beside the mover's seam |
| `mobile/androidApp/src/main/kotlin/dev/centraid/android/MainActivity.kt` | the deleter as a field; installed when the session opens, cleared when the activity goes |
| `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/HomeScreen.kt` | the forget dialog's comment: what can survive a forget is the sealed backup on each paired gateway, as far as it acknowledged, and only the 24 words bring it back |
| `mobile/maestro/backup-measurement.md` | the corpus's edited photographs: the walker stages the current rendition; the original and its adjustment data are the owner question A20 recorded |
| `mobile/iosApp/Tests/ScreenFixtureTests.swift` | the `transport` assertion deleted; the test stays, because it is the limited-selection case |
| `mobile/iosApp/Sources/VaultFileProtection.swift` | the ledger row names `crates/vault/src/backup/ledger.rs` |
| `mobile/iosApp/project.yml` | the camera comment names `serve` and `pair`, not `invite`; the local-network comment says no shell browses, why the type is still declared, and how an address change is survived today. `NSBonjourServices` kept; no key or value changed, so `Resources/Info.plist` is unchanged |
| `docs/decisions.md` | R-1080-E12, E13 and E14, appended at the end |
| `docs/release/v1-handoffs.md` | rows 8.1 (extended), 8.19 and 8.20; owner question PH4 |
| `receipts/issue-1080-backups-v2.md` | this section |

### Decisions this round made

| Id | Decision |
| --- | --- |
| **R-1080-E12** | iOS deletes whole, unedited assets through Photos' own alert, and reports exactly the request's rows on a yes ([decisions](../docs/decisions.md#the-native-shells-library-deleters-1080)). |
| **R-1080-E13** | Android deletes through `MediaStore.createDeleteRequest` from API 30 only, reporting only rows the store no longer answers for ([decisions](../docs/decisions.md#the-native-shells-library-deleters-1080)). |
| **R-1080-E14** | The bundle declares `_centraid-gateway._tcp` while no shell browses, so the browse Q-1080-D3 recommends needs no bundle change ([decisions](../docs/decisions.md#finding-a-gateway-on-ios-until-a-shell-browses-1080)). |

### What this round assumed beyond the seam contract

| # | Assumed | Where it is read |
| --- | --- | --- |
| E-A9 | A Live Photo's movie row is the still's `os_ref` plus `#pairedVideo`, spelled as `IosMediaLibrary.PAIRED_VIDEO` spells it; nothing ties the two spellings but a comment | `LibraryDeletion.pairedVideoSuffix` |
| E-A10 | An Android `os_ref` is `image:<id>` or `video:<id>`, as `AndroidMediaLibrary` stages it | `MediaStoreDeleter.uriOf` |
| E-A11 | `done` may be called on any thread: Photos' completion queue on iOS, the deleter's own thread on Android. `FreeUpFlow` resumes a continuation with it, which is safe from any thread | both deleters |

### Found, for the root

1. **The pairing payload lists `<host>.local` last, not first.** `crates/gateway/src/server/addrs.rs:15-41` pushes every interface address and then `format!("{host}.local:{port}")`, and its tests' payload is `["192.168.1.20:8443", "[fd00::20]:8443", "ada-laptop.local:8443"]`; the client dials them in turn from the one that answered last (`crates/gateway/src/client/mod.rs`, `connect`). `docs/gateway.md:146` and `docs/recovery/pairing.md:45` say "first"; the conclusion they draw (a moved address on one network is reached by name) holds either way. `project.yml` says what the code does.
2. **`SECURITY.md:50`** says the phone's one LAN act is a Bonjour browse while the app is open; no shell browses (`grep -rn "NWBrowser\|NetServiceBrowser\|NsdManager" mobile/iosApp/Sources mobile/androidApp/src mobile/shared/src` finds nothing).
3. **`mobile/README.md:335`** says an address that changed needs the pairing again, which the `.local` fallback contradicts on one network.
4. **`NSCameraUsageDescription`** tells the member "the square your laptop shows"; the word waits on Q-1080-D1, and changing it means regenerating the plist, so it is unchanged.

### Verification

Run in this worktree on 2026-10-03, at this commit's tree. No cargo command: the round changes no Rust.

| Command | Result |
| --- | --- |
| `mobile/gradlew -p mobile :shared:jvmTest --rerun` | BUILD SUCCESSFUL: 1,109 tests in 75 suites, 0 failed, 0 skipped. Before the merge it did not compile: `WordsShelfSpec` named `RestoreRequest.endpoint` and `device_secret`, which the umbrella's `217c876b4` had already brought to lane C's proto |
| `bun run format` then `bun run format:check` | no change; "All matched files use the correct format", 517 files |
| `bash .governance/run.sh < /dev/null` | all 6 directives pass; the law's window door, 10 rules, no findings |
| `python3 plist_check.py mobile/iosApp` (a scratch comparison of `project.yml`'s info properties with `Resources/Info.plist`) | 11 keys, 0 mismatches, the plist's keys sorted |
| `grep -rn "gateway2\|backup2\|centraid-gateway2" mobile/iosApp mobile/androidApp mobile/maestro` | nothing (exit 1) |
| `grep -rn "transport" mobile/iosApp/Tests` | nothing (exit 1) |
| `grep -rn "deleteAssets\|createDeleteRequest(" mobile/iosApp/Sources mobile/androidApp/src`, comments aside | one each: `PhotoLibraryDeleter.swift:120`, `MediaStoreDeleter.kt:94` |
| `grep -rn "installLibraryDeleter" mobile/iosApp/Sources mobile/androidApp/src`, comments aside | `ShellModel.swift:396`; `MainActivity.kt:290` (install) and `:303` (clear) |
| the commit hooks on every commit | green |

## Close

### The issue's acceptance boxes, reconciled

| Box | State | Evidence |
| --- | --- | --- |
| A fresh vault with 2,000 content items of mixed sizes, one above 64 MiB, backed up to a harness gateway; no plaintext, plaintext hash or key in the store | **Met in kind, not in count.** The drill backs up a real JPEG with its derived tiers, the shell's own derivatives, a library photo and a film above 64 MiB (two parts), plus fifty notes; the blindness canary scans the gateway's whole data directory for every plaintext, every plaintext hash and every key. 2,000 items at drill scale would spend the local gate's budget on one test; a scale run is an owner hand-off (H-5). | `crates/centraid/tests/restore_drill.rs`; `crates/core/tests/phone_backup.rs` |
| A second snapshot after 50 commits uploads only the changed ranges; the gateway's list shows exactly those names | Met. Lane B measured 13 of 15 ranges re-sealed at 4 MiB and ruled 64 KiB (A14); the vault drill asserts the second snapshot seals fewer ranges than it has, and the gateway drill checks what the gateway holds against the ledger by `exists`. | `crates/vault/tests/restore_drill.rs`; R-1080-B-measurement in lane B's section |
| Destroy the vault, spool and ledger; restore passes `integrity_check`, census, `db_hash`, opens through the ladder, rows equal | Met. | `crates/vault/tests/restore_drill.rs`; `crates/centraid/tests/restore_drill.rs` (row for row) |
| A restore claims the writer epoch only after the checks; the old phone's next write is refused `MOVED` and freezes | Met. | `phone_backup.rs` (restore, the head moved between check and claim, `VAULT_MOVED`); the gateway drill's last step |
| Retention 7/4/6 under a fixed clock; GC deletes exactly the unreferenced names | Met. `retention::keep` and `garbage` are pure and tested under a fixed clock; `phone::drain::retain` applies them each pass and deletes the garbage through the store. | `crates/vault/src/backup/retention.rs` tests; `crates/core/src/phone/drain.rs` `retain` |
| Rung 010 migrates a file holding the custody tables to a fresh file's schema with a clean `foreign_key_check` | Met. | `crates/vault/tests/backup_v2_rung.rs` |
| `iroh`, `iroh-blobs`, `iroh-dns-server` absent from `Cargo.lock`; no listening socket | Met. | `grep -c iroh Cargo.lock` → 0; `cargo xtask rules` (`no-listening-socket`, one file on the allowlist: `crates/gateway/src/server/serve.rs`) |
| Both shells schedule the pass at launch, carry the rule, Home reads `backup_status`; JVM specs prove it | Met on the JVM. | lane D's and lane E's sections (`BackupStatusSpec`, `UploadLoopSpec`, the scheduling specs); `cargo xtask gate --profile mobile-jvm` |
| The iOS mover and the Android jobs are written and listed as device hand-offs with exact commands | Met as hand-offs: written, uncompiled here (no Xcode, no Android SDK). | `docs/release/v1-handoffs.md` §8; `mobile/maestro/backup-measurement.md` |
| Docs describe the new plane only; every superseded ruling has a supersession row; the receipt records every file and command | Met for the state docs and decisions; **not met for the docs site**: lane F was stopped before its third round, so `scripts/docs-site` still describes the old gateway verbs in its backups and data chapters (QUALITY.md records it; H-7). | lane F's section; `docs/decisions.md` supersessions; this receipt |

### Inherited red

| Check | State | Why it is not this umbrella's |
| --- | --- | --- |
| `buf breaking` in CI against `main` | expected green | core.v1 is WIRE_JSON since A22 and every deleted field reserves its number and name; `buf breaking --against '.git#branch=main,subdir=crates/api-proto/proto'` exits 0 locally (lane C's section). |
| The iOS test target | red until compiled | `ScreenFixtureTests.swift` lost its transport assertion in lane E's last round; the first real Xcode build is hand-off 8.x. |

### Corrections to the plan

- Rung 010 moved from lane B to lane C, because the old plane still wrote the tables it drops (F-B1).
- Lanes C, D, E and F ran in parallel after the proto-first slice instead of as two waves; the seam contract (`A1…A24`, recorded as the `R-1080-*` rows) was the single source for cross-lane names.
- The range size moved from 4 MiB to 64 KiB on lane B's measurement (A14, Q-1080-B1 answered).
- Lane F was stopped by the owner after two rounds; the root's close pass took over only what the gates needed.
- The lanes' early commits were authored under the owner's git identity by the container's environment; the root rewrote the branch's authorship to `Claude <noreply@anthropic.com>` before the final push (tree hashes unchanged).

### Open items (not built here)

- A library item larger than the spool budget (2 GiB) has no path through the one-pass sealer (lane C).
- The spool syncs once per range; a first snapshot of ~900 ranges is ~900 syncs (lane C).
- The drain does not poll `Cancel`; it is bounded by its deadline (as before).
- `access_device` and `access_device_secret` have no writer and no rung drops them; `media::format::derive_data_key`, `change.proto` `ConnectivityState`, `command.proto` `SyncWindow`/`SyncBudget` have no consumer (lane C).
- Old `device-secret.<vaultId>` keys from earlier builds stay in the secure stores; nothing reads them (D-D18).
- The `custody` Kotlin package keeps its name; a rename reaches 11 lines of the shells (lane E).
- A restore that meets a damaged snapshot is refused correctly but reported as `INTERNAL` (`crates/core/src/phone/restore.rs`, `restore_error`); a damaged copy wants its own refusal code (re-audit item 2).
- Mirroring between gateways is designed, not built (R-1080-8).

### Owner hand-offs

- **H-1 (product).** R-1080-C13: a video's original waits for a charger unless the member tapped Back up now; R-1080-C14: on a metered link a snapshot is taken only under `WIFI_AND_CELLULAR_PHOTOS`, including on Back up now. Both are one-line policy changes if you want them otherwise.
- **H-2 (policy).** A22: `centraid.core.v1` dropped from buf's FILE category to WIRE_JSON at the cut-over, because nothing in it crosses to another install any more. Veto reverts `buf.yaml` and un-reserves nothing (the fields stay reserved either way).
- **H-3 (release).** The Linux and macOS tarballs now ship `centraid-gateway`; Windows tarballs do not, because `centraid-gateway install` has no Windows unit. Decide whether a Windows gateway is wanted for v1.
- **H-4 (devices).** The first real Xcode and Android Studio builds, `BackgroundUploadTests`, and the device measurement in `mobile/maestro/backup-measurement.md` (hand-offs 8.1–8.18 and lane E's last rows).
- **H-5 (scale).** A 2,000-item drill at nightly scale (box 1).
- **H-6 (minSdk).** Android below API 30 gets no library deleter (A20); decide whether to raise minSdk.
- **H-7 (docs site).** `scripts/docs-site`'s backups and data chapters, and the desktop-shell leftovers from #1029 (QUALITY.md).
- **H-8 (issue).** Reconcile the issue body to what shipped (the boxes above) and close it when the PR merges; no PR was opened by the root.
