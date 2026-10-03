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

No verdict from the author. The umbrella's independent review records one for lane B's section, against the diff and the commands above, at the close.

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
