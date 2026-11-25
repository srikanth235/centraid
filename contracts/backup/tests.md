# Backup tests: the named attacker, durability and gate checks

The named tests for [#1191](https://github.com/srikanth235/centraid/issues/1191): one or more for every trust gap 1 to 8 and every durability gap D1 to D8, then the gate-level checks of the acceptance criteria. Written with the decisions now in the [backup skill](../../.claude/skills/backup/gateway.md) (cited as E1 to E14). Each line: `test_name` (crate, file), what the attacker does or what fault is caused and what must be observed, the checklist row that lands it. A test lands in the same pull request as its fix, so `main` is never red.

Current state: the gateway and vault entries below are tests that exist. The phone-side entries of the plane that #1209 replaced (the outbox, the blob cursor, manifest 4, part read-back, the old `core/tests/backup_*` files) are gone with it; the engine's invariants (truthful status, the commit rule, never deleting needed data, convergence, bounded work, vault scope) and its planted bugs are held by `crates/vault/tests/backup_sim.rs` (spec §8), and the driver by `crates/core/tests/phone_backup.rs`, `backup_check.rs`, `restore_directory.rs`, `restore_edges.rs` and `restore_damaged.rs`.

A name below is the checklist's title for the test; the function in the named file may carry a different name.

Rules for all of them: assertions are on counts (statements, calls, rows, bytes), never on durations; attacker tests play the attacker through the real client against a real gateway (`server::harness::spawn`) unless the line says the rules in memory; durability tests cause the fault for real (a child process that is killed, a page of the file overwritten on disk, a file left at the earlier rung). A new rule gets a named case in `rules::conformance::CASES` so it runs over the rules and over the wire.

Layout used below: `gateway/tests/` is `crates/gateway/tests/`, `gateway/conformance` is a case in `crates/gateway/src/rules/conformance.rs`, `vault/tests/` is `crates/vault/tests/`, `core/tests/` is `crates/core/tests/`, `xtask` is `crates/xtask/src`.

## Trust gaps

### Gap 1: one gateway's unsigned higher epoch freezes the phone

- `a_real_takeover_ends_the_pass_gateway_by_gateway` (core, `core/tests/restore_edges.rs`). A second core restores the vault from the 24 words and claims at every gateway; the first phone's next pass hears `MOVED` with the signed claim at each. Observe: each row reads `moved` with `moved_epoch` above its own, the pass to each stops at its own verified claim, and nothing more is written to either gateway. B3, B4.
- `a_claim_at_one_gateway_leaves_the_others_fed` (core, `core/tests/restore_edges.rs`). The second core claims at gateway A only. Observe: A's row reads `moved` and no write reaches A; B's row stays `ok`, B is still fed (its `ack_ms` moves) and the vault stays writable on the phone; the status line says another phone has taken over. B3, B4.
- `a_moved_claim_is_bound_to_its_gateway` (gateway, `gateway/conformance`: `moved_carries_a_claim_bound_to_the_gateway`). A claim signed for gateway A is shown to the phone by gateway B. Observe: it does not verify (the preimage holds the gateway id). B3.

### Gap 2: a restore believes one gateway's head; a token can point the head back

- `a_token_without_the_vault_key_cannot_set_a_head` (gateway, `gateway/conformance`: `head_needs_the_vault_signature`). A holder of the writer token sends `PUT head` with a bad or missing signature. Observe: `UNAUTHORIZED`, the head is unchanged. B2.
- `an_old_signed_head_replayed_is_out_of_order` (gateway, `gateway/conformance`: `a_head_never_falls_within_an_epoch`). The attacker records a genuine signed head, the phone moves on, the attacker replays the old record with the token. Observe: `OUT_OF_ORDER` carrying the standing generation, the head is unchanged. B2.
- `a_generation_jump_beyond_the_bound_is_refused` (gateway, `gateway/conformance`: `generation_jumps_are_bounded`). A signed head at generation `current + 257`. Observe: `OUT_OF_ORDER`; at `current + 256` it is accepted. B2.
- `a_claim_resets_the_generation_and_the_next_head_is_accepted` (gateway, `gateway/conformance`: `a_claim_may_reset_the_generation`). After a claim, a head at generation 1 is accepted; one at generation 0 or 257 is not. B2, B4.
- `a_head_names_a_held_manifest_only` (gateway, `gateway/conformance`: `a_head_names_a_held_manifest`). Signed head naming an absent or held-deleted manifest. Observe: `NOT_FOUND`. B2.
- `restore_takes_the_newest_signed_head_of_every_gateway` (core, `core/tests/restore_edges.rs`). Gateway A holds a stale genuine head (older generation), gateway B the newest. Observe: restore picks B's by `(epoch, generation)`; with A alone it asks the member with the backup's date (E8). B8.
- `restore_with_one_gateway_shows_the_date_and_asks` (core, `core/tests/restore_edges.rs`). One gateway only, holding a genuine but old head. Observe: nothing is claimed until the member confirms; the answer carries the backup's date and the gateway's label. B8.
- `a_directory_does_not_link_vaults` (gateway, `gateway/conformance`: `canary_directory`). Two vaults of one member on one gateway, each with a directory object. Observe: the canary scan of every byte at rest finds no gateway address, no other vault's id and no plaintext, and the two objects share no name. B8.
- `restore_reaches_a_gateway_only_the_directory_names` (core, `core/tests/restore_edges.rs`). The member knows one gateway; the directory lists a second which holds the newest head. Observe: the restore reads and claims at both. B8.

### Gap 3: a superseded token is answered reads

- `a_takeover_leaves_no_live_older_token` (gateway, `gateway/conformance`: `a_claim_revokes_every_older_token`). A writer token and a read token exist; a claim lands. Observe: every route, reads included (`head`, `snapshots`, `exists`, `objects`, `GET`, `fetch`, `held`), answers both old tokens `MOVED` carrying the claim; the `token` table has no row below the new epoch. B4.
- `a_revoked_token_hears_moved_until_the_tombstone_is_pruned` (gateway, `gateway/conformance`: `revoked_token_tombstones`). Observe: `MOVED` while the tombstone is kept, `UNAUTHORIZED` after `REVOKED_TOKEN_KEEP_MS`, and at most 64 tombstones per vault. B4.
- `a_token_revoked_on_purpose_is_unauthorised_not_moved` (gateway, `gateway/tests/revoke.rs`). `POST revoke` and `pairings revoke`. Observe: `UNAUTHORIZED`, no tombstone row. B4.
- `a_takeover_cancels_held_deletes` (gateway, `gateway/conformance`: `a_claim_cancels_held_deletes`). A held delete exists; a claim lands. Observe: `held_at_ms` and `purge_after_ms` are null on every row, `exists` lists the name held, the purge sweep removes nothing. B4, B5.

### Gap 4: a token holder deletes everything and points the head at nothing

- `a_delete_needs_the_vault_signature` (gateway, `gateway/conformance`: `delete_needs_the_vault_signature`). Unsigned or wrongly signed `delete`. Observe: `UNAUTHORIZED`, no row changes. B5.
- `a_signed_delete_is_held_seven_days_and_stays_listed` (gateway, `gateway/conformance`: `a_delete_is_held`). Signed delete of a manifest and parts. Observe: bytes still served by `GET` and `fetch`, `exists` lists them missing, `held` lists each with `purge_after_ms = held_at_ms + 7 days`, `snapshots` still lists the held snapshot with `held_at_ms`; the purge sweep one tick before the deadline removes nothing, one tick after removes all. B5.
- `a_replayed_delete_is_out_of_order` (gateway, `gateway/conformance`: `a_delete_replay_is_refused`). The attacker replays a recorded signed delete after the names were stored again. Observe: `OUT_OF_ORDER`, the live names stay live. B5.
- `a_head_cannot_be_deleted_and_a_snapshot_row_keeps_its_object` (gateway, `gateway/conformance`: `head_and_snapshot_keep_their_manifest`). Observe: `HEAD_IN_USE` for the head; a held-deleted snapshot's manifest is served until purged. B2, B5.
- `operator_undo_restores_every_hold` (gateway, `gateway/tests/operator.rs`). Delete, then the `undo` verb through the CLI's engine. Observe: holds cleared, `exists` held again, head unchanged. B5.
- `a_frozen_vault_refuses_writes_and_answers_reads` (gateway, `gateway/tests/operator.rs`). `freeze`, then each state-changing route and each read. Observe: `FROZEN` with `since_ms` on every write, claim and secret pairing; reads, `nonce` and read grants answer; the purge sweep removes nothing. B5.
- `unfreeze_gives_back_the_time_it_was_frozen` (gateway, `gateway/tests/operator.rs`). Observe: every `purge_after_ms` rises by exactly `now - frozen_at_ms`. B5.
- `purge_now_needs_yes_and_an_unfrozen_vault` (gateway, `gateway/tests/operator.rs`). Observe: refused without `--yes` or while frozen; with both, the holds purge and the verb prints counts only, never names. B5.
- `a_long_gap_rebases_every_hold` (gateway, `gateway/tests/operator.rs`). The harness clock jumps forward a year between two sweeps. Observe: no object purged, every `purge_after_ms = now + 7 days`. B5.

### Gap 5: the gateway credential is plain text in a database file

- `the_token_comes_through_the_secret_store_and_a_row_waits_for_it` (core, `core/tests/shell_backup.rs`). A fake shell's `SecretBatch` answers not-ok to the put. Observe: no `gateway` row is written. B15.
- `the_device_secret_store_is_this_device_only` (iOS `mobile/iosApp/Tests`, Android `mobile/androidApp/src/test`; named `BackupTokenStoreSpec`). Observe: accessibility is `AfterFirstUnlockThisDeviceOnly`, not synchronizable; Android's key is non-exportable and the preferences file is excluded from backup. B15. The device run is an owner hand-off (L3).

### Gap 6: read-back checks 4 parts of 100,000 and a part only has to open

- `the_rate_sentence_states_what_was_read` (screens, `crates/screens/tests/backup_page.rs`). Observe: the line carries `s` and `n` as read and never says "verified". B13, B16.

### Gap 7: pairing by secret needs no proof of the vault key

- `a_photographer_cannot_squat_the_members_vault` (gateway, `gateway/conformance`: `pair_by_secret_needs_the_vault_signature`). The attacker has the QR's secret and the member's vault id (public) and signs with their own key. Observe: `UNAUTHORIZED`, the secret is not spent, the vault is not created. B6.
- `a_pair_signature_is_bound_to_nonce_secret_and_gateway` (gateway, `gateway/conformance`: `pair_signature_binds_its_fields`). A signature reused with another secret, another gateway, a spent nonce. Observe: each `UNAUTHORIZED`. B6, B4.
- `a_photographer_pairing_their_own_vault_is_visible` (gateway, `gateway/tests/pair_from_payload.rs`). The attacker pairs their own key first. Observe: the member's pair is `UNAUTHORIZED` (secret spent), and the serve console printed the stranger's safety number. This documents the residual in the [backup skill](../../.claude/skills/backup/gateway.md) ("Pairing by secret proves the vault key"). B6.

### Gap 8: read grants and claims carry no nonce and can be replayed

- `a_replayed_read_grant_is_refused` (gateway, `gateway/conformance`: `a_nonce_is_single_use`). A recorded signed read grant is sent again. Observe: `UNAUTHORIZED`; the first use consumed the nonce. B4.
- `a_replayed_claim_after_a_revoke_is_refused` (gateway, `gateway/conformance`: `a_claim_cannot_be_replayed`). Claim, revoke the token, replay the claim bytes. Observe: `UNAUTHORIZED`, no token minted. B4.
- `an_expired_nonce_is_refused_and_pruned` (gateway, `gateway/conformance`: `a_nonce_expires`). Observe: `UNAUTHORIZED` after `NONCE_TTL_MS`, the row gone after the sweep. B4.
- `nonce_storage_is_bounded` (gateway, `gateway/conformance`: `nonces_are_bounded`). Issue until the cap. Observe: `BUSY` with `retry_after_ms` at 4096 live; expired rows are pruned first. B4.
- `the_nonce_route_names_no_vault` (gateway, `gateway/conformance`: `canary_nonce`). Observe: no vault id is in the `nonce` table. B4.

## Durability gaps

### D1: a corrupted vault is backed up faithfully

- `the_quick_check_runs_before_the_head_is_signed` (vault, `vault/tests/backup_snapshot.rs`). Damage lands between the page read and the head. Observe: the head is not signed (counted: zero `PUT head` calls). B11.

### D2: a migrated vault reopens with foreign keys off and no injected clock

- `a_vault_opened_through_a_migration_has_foreign_keys_and_its_clock` (vault, `vault/tests/format_identity.rs`). Open a vault file left at the rung below through `Vault::open` with the injected clock and id source so a migration runs. Observe: `PRAGMA foreign_keys` is 1, an insert with a dangling reference is refused, and the next write carries the injected clock's time and ids. V15.

### D3: the pre-migration copy is plaintext, never deleted

- `a_migration_leaves_no_plaintext_copy_of_the_vault` (vault, `vault/tests/format_identity.rs`). Run a migration on a vault holding a known Locker secret and a known note. Observe: no file beside the vault (list the directory) holds the note's bytes or `locker_key`, no `.gz`. V16.

### D4: no damage check at open; a damaged copy can be kept over a restore

- `open_of_a_damaged_vault_is_a_typed_error` (vault, `vault/tests/format_identity.rs`). Damage a page, `Vault::open`. Observe: `VaultDamaged`, not a panic or a later query error; a healthy vault opens with one `quick_check` call counted. V21.
- `a_restore_prefers_a_healthy_backup_over_a_damaged_local_copy` (core, `core/tests/restore_edges.rs`). A damaged local file has more writes than the backup. Observe: `held_is_newer` does not keep it; the restore replaces it and says so. V21.

### D5: a kill during first-launch founding leaves a file that cannot be created or opened

- `a_process_killed_mid_founding_leaves_a_vault_that_founds_again` (vault, `vault/tests/founding_kill.rs`). A child process (the test binary re-executed with an environment variable) begins founding with a fault hook that pauses after the file exists and before the rename; the parent kills it with `SIGKILL`. Observe: the target path does not exist (only a side file, which a later `Vault::create` removes), and `Vault::create` then `found` succeeds. V17.
- `a_process_killed_mid_commit_loses_the_commit_and_opens_clean` (vault, `vault/tests/commit_kill.rs`). Child process commits a large write with a hook that pauses after the WAL frames are written and before the commit record; killed. Observe: the parent opens the file, `quick_check` passes, the write is absent; a second run killed after the commit shows the write present. V17, V18 (the same test pair covers D6's ordering).

### D6: no `fullfsync` on Apple targets

- `apple_targets_set_fullfsync` (vault, `vault/tests/pragmas.rs`). Observe on every target: `PRAGMA fullfsync` and `checkpoint_fullfsync` are 1 when `target_vendor = "apple"` and the test builds the pragma list for that target (the list is a function over a target flag so Linux can assert it; counts the pragma statements). The device behaviour is unverified off an iOS target. V18.

### D7: a forward clock jump purges the trash and drops action keys

- `a_clock_far_ahead_purges_nothing` (vault, `vault/tests/trash_and_bytes.rs`). Fill the trash, set the injected clock one year past the vault's last commit, run `tidy`. Observe: zero rows purged, zero action keys dropped, and the same call with a clock one day ahead purges the rows that are due. V19.

### D8: a rotted blob is never healed on re-add; sweeps scan the whole library

- `re_adding_a_rotted_blob_replaces_the_bad_file` (vault, `vault/tests/trash_and_bytes.rs`). Flip a byte in a stored blob file on disk, add the same content again. Observe: the file's hash is right again and `store` reports it replaced (counted: one file written). V20.
- `a_sweep_lists_the_directory_once` (blobs, `crates/blobs/tests/sweep_lists_once.rs`). A store of N blobs; count `read_dir` calls (a counting wrapper over the store's directory port). Observe: one listing per sweep, not N; a thumbnail write triggers none. V20.
- `a_sweep_collects_only_the_replaced_hash` (blobs, `crates/blobs/tests/sweep_lists_once.rs`). Observe: the old file of the replaced hash is removed, every other file is untouched. V20.

## Other tests the decisions imply

- `a_kept_snapshot_with_a_missing_leaf_stops_collection` (vault, `vault/tests/backup_snapshot.rs`): zero deletes issued at that gateway however many passes run, nothing counted across passes, the Backup screen says one old backup cannot be read, and collection resumes only when retention drops that snapshot. B9, B10.
- `an_older_gateway_data_directory_is_refused_with_the_sentence` (gateway, `gateway/tests/data_dir.rs`): an earlier gateway's `state.db` fixture; observe exit 2, the exact sentence of E13, and the file's bytes unchanged. B1.
- `a_gateway_below_required_protocol_is_refused` (gateway, `gateway/tests/older_gateway.rs`): a stub answering `/v1/info` with protocol 0; observe `GatewayTooOld { found: 0, required: 1 }` and no second request. B1.
- `a_head_from_the_future_is_refused` (gateway, `gateway/conformance`: `taken_at_is_bounded`): `CLOCK_AHEAD` above 300,000 ms, accepted at the bound. B7.
- `a_bundle_commits_in_one_transaction` (gateway, `gateway/tests/bundle_commit.rs`): the adapter's statement counter shows one `BEGIN IMMEDIATE`/`COMMIT` pair per bundle; a kill between packfile rename and SQLite commit leaves zero rows and one orphan `.pack` file, and `orphans_once` removes it after `ORPHAN_MIN_AGE_MS`. B7.
- `pairing_secrets_are_pruned_and_bounded` (gateway, `gateway/conformance`: `secrets_are_bounded`). B7.
- `delete_vault_needs_a_frozen_vault_and_removes_everything` (gateway, `gateway/tests/operator.rs`). B7.
- `the_release_gateway_does_not_link_the_harness` (xtask, `rules.rs` check `gateway_harness_out_of_release`). B7.

## #1212 regression tests

- `sealed4_vectors` (media, `crates/media/tests/sealed4_vectors.rs`): pins `centraid-sealed/4` (`CSB4`) derived keys, Padmé lengths, encrypted `flags`/`class`, `zstd` level 3 applied only on `records`, names, nonces, objects, and digests against `contracts/crypto/sealed4-vectors.json`.
- `pack_compaction` (gateway, `gateway/tests/pack_compaction.rs`): verifies sparse packfile compaction (`>= 50%` dead bytes) after `purge` and small-pack coalescing (`< 16 MiB` up to `256 MiB`) with atomic CAS `(pack_id, pack_pos)` remap while preserving every byte and digest on `GET`, ranged `GET`, `POST /fetch`, and `scrub`.
- `split_brain_stale_vault_with_later_timestamp_cannot_claim_over_higher_writes_head` (core, `core/tests/restore_edges.rs`): proves a stale split-brain vault with a later local timestamp (`own.last_write_ms >= head.taken_at_ms`) cannot claim over a remote head with higher `writes`; `pair` refuses `VaultMoved` and leaves the gateway's head intact.
- `newly_paired_second_gateway_repairs_cloud_only_original_from_first_gateway` (core, `core/tests/phone_backup.rs`): proves a newly paired second gateway repairs freed cloud-only originals from the first gateway via peer stores and confirms `oroot`.
- `gateway_notes_persist_across_core_reopen` (core, `core/tests/phone_backup.rs`): proves `GatewayNotes` (`collected_ms`, `held_count`, `held_purge_at_ms`, `refusal_code`, `damaged_flag`, `sample_checked`, `sample_of`, `manifest_unreadable`) persist in `state.db` (`CBS2`) across core close and reopen without dialing.
- `back_up_now_streams_all_batches_past_max_rounds_while_asks_advance` (screens, `crates/screens/src/passes/tests.rs`): proves `"Back up now"` streams all advancing `need_bytes` batches past `MAX_ROUNDS` while capping identical stalled asks and keeping non-`"Back up now"` runs bounded at `MAX_ROUNDS`.

## Gate-level checks (the acceptance criteria)

Where each lives: **rules** is a check in `cargo xtask rules` (`crates/xtask/src/rules.rs`, run by the `rules` step of every gate profile), **case** a conformance case, **test** a crate test.

| Check | Name | Where | What fails |
| --- | --- | --- | --- |
| Every database has an id and a version ladder | `every_database_has_an_application_id_and_ladder` | rules | A `.db` the code opens (vault, `state.db`, gateway `state.db`) whose founding does not set `application_id` and `user_version`, or whose ladder directory has a gap in numbering; lists each database with its id |
| No host clock in DDL | `no_host_clock_in_ddl` | rules | `strftime`, `datetime('now')`, `julianday`, `CURRENT_TIMESTAMP`, `unixepoch` in any `.sql` under `contracts/migrations`, a gateway or device-state ladder |
| No key-value state table | `no_key_value_state_table` | rules | A table in a ladder with exactly the columns of a key and a value (a `meta`-shaped table), or named `meta`, `kv`, `settings` |
| Every index has a reader | `every_index_has_a_reader` | test (`core/tests/query_plans.rs`, extended) | An index that no statement's plan in the corpus uses, or an allowlist entry that none needs (the allowlist only falls) |
| Every page seeks | `every_listing_seeks` | test (`gateway/tests/plans.rs`) | A paged statement whose plan scans or sorts instead of walking an index, or that uses `OFFSET` |
| The plan test sees index walks | `the_plan_test_sees_a_walk_and_a_scan` | test (`core/tests/query_plans.rs`) | A planted table scan and a planted index walk are told apart: guards the test itself |
| A takeover leaves no live older token | `a_takeover_leaves_no_live_older_token` | case | See gap 3 |
| An unchanged library costs a pass near nothing | `an_unchanged_library_costs_one_statement_and_one_call_per_gateway` | test | See lane B list; counts statements and calls |
| Generated lists fresh | `generated_lists_are_fresh` | rules (the existing `git diff --exit-code` pattern) | Any L1 generated file (check lists, link shapes, sealed-column lists, blob renters, ontology table list, grace and page-size constants) differs from its generator's output |
| No credential in a database file | `no_credential_is_in_a_database_file` | test | See gap 5; scans the vault file, `state.db`, the gateway's `state.db` and the data directory |
| A damaged page stops a backup | `a_damaged_page_stops_a_backup_pass` | test | See D1 |
| Every member-visible behaviour is the same on both platforms | the existing `native_parity` and `promises` rows | rules | New B16 behaviours get rows in `promises.rs` and shared fixtures under `contracts/backup/` |
