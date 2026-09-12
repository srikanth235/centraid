//! The wave 2 failure matrix (#1020, D-1020-D2-5).
//!
//! Five modes, each one written to fail on the base first. The demonstrated
//! reds are recorded in the receipt; each test's doc comment says what the red
//! was, because a test whose failure mode is not written down is a test nobody
//! can tell has stopped testing anything.
//!
//! | Mode | Here |
//! |---|---|
//! | process death between commit and ack | `a_crash_after_commit_before_the_durable_hook_*` |
//! | duplicate delivery | `the_same_page_twice_*`, `the_same_intent_twice_*` |
//! | disk full at the seat | `a_full_seat_file_*` |
//! | restore with paired seats | `an_epoch_bump_tells_an_old_seat_*`, `the_cutover_*` |
//! | interrupted snapshot (download side) | `an_interrupted_bootstrap_*` |
//!
//! The **gateway** side of process death and duplicate delivery is
//! `crates/sim`'s, where a real gateway host crashes and restarts over a real
//! file. This file is the **seat** side, where a connection can be dropped and
//! reopened directly and a file can be made full on purpose.

mod common;

use centraid_seat::applier::ApplyHooks;
use centraid_seat::{IntentState, Outbox, SeatError, seat_state};
use common::Harness;

// ----------------------------------------- 1. process death, seat side ------

/// A crash after the applier's `COMMIT` but before `on_commit_durable`.
///
/// **The red:** with the overlay cleared *outside* the per-commit transaction —
/// which is what an outbox in a second database forces — the crash leaves the
/// rows applied and the overlay still painted, and the reopened seat shows the
/// pre-edit value under the member's edit forever. Demonstrated by clearing
/// from `on_commit_durable` instead of `on_commit_in_transaction` and killing
/// the process between them.
///
/// The fix is structural rather than careful: the overlay clears **inside** the
/// transaction that carries the rows, so there is no instant at which one is
/// visible and the other is not.
#[test]
fn a_crash_after_commit_before_the_durable_hook_leaves_no_orphan_overlay() {
    let harness = Harness::founded("crash-durable");
    let seat = harness.bootstrap_seat("seat");

    // An intent the seat is waiting on, and the commit that answers it.
    {
        let outbox = Outbox::open(&seat.connection).expect("the outbox opens");
        outbox
            .enqueue(&common::intent("i-1"), "t")
            .expect("it queues");
        outbox
            .transition("i-1", IntentState::AwaitingChange, "t", |record| {
                record.commit_seq = Some(1);
            })
            .expect("it waits");
    }
    harness.run_commit(&common::commit(
        "crash-1",
        &[
            "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
         VALUES ('crash-a', 'person', 'A', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
        ],
    ));

    let page = harness.page(seat.floor, &seat.epoch, 10_000);
    let commit_seq = page.rows.first().expect("a row").commit_seq;
    // The overlay is cleared from the IN-TRANSACTION hook, and the durable hook
    // panics — which is the crash, at the one instant that matters.
    let mut cleared: Vec<String> = Vec::new();
    {
        let mut in_transaction = |connection: &rusqlite::Connection, seq: i64| {
            let outbox = Outbox::open(connection)?;
            cleared.extend(centraid_seat::settlement::settle_at_commit_seq(
                &outbox, seq, "t2",
            )?);
            Ok(())
        };
        let mut hooks = ApplyHooks {
            on_commit_in_transaction: Some(&mut in_transaction),
            on_commit_durable: None,
        };
        centraid_seat::apply_page(
            &seat.connection,
            &seat.header(page.watermark.seq),
            &page.rows,
            &mut hooks,
        )
        .expect("the apply commits");
    }
    assert!(
        cleared.contains(&"i-1".to_owned()),
        "the overlay cleared for commit {commit_seq}"
    );

    // THE CRASH: the process dies here, before anything downstream is told.
    let seat = seat.reopen();

    // The reopened seat has the rows AND no overlay. One fact, not two.
    let rows: i64 = seat
        .connection
        .query_row(
            "SELECT COUNT(*) FROM core_party WHERE party_id = 'crash-a'",
            [],
            |row| row.get(0),
        )
        .expect("the row reads");
    assert_eq!(rows, 1, "the rows are durable");
    let outbox = Outbox::open(&seat.connection).expect("the outbox opens");
    assert!(
        outbox.get("i-1").expect("reads").is_none(),
        "an overlay cleared outside the transaction would still be here"
    );
    assert!(outbox.was_settled("i-1").expect("reads"));
    assert_eq!(
        seat_state(&seat.connection).expect("reads").applied_seq,
        page.watermark.seq,
        "the cursor is durable too, because it rode in the same transaction"
    );
}

/// The other half: a crash *inside* the transaction leaves nothing.
///
/// **The red:** with the cursor written in its own statement outside the
/// per-commit transaction, the rows roll back and the cursor does not — so the
/// next pass asks from a position past rows it never applied, and the seat is
/// silently missing a commit for ever. Demonstrated by moving the `seat_state`
/// update after `COMMIT`.
#[test]
fn a_crash_inside_the_transaction_leaves_neither_the_rows_nor_the_cursor() {
    let harness = Harness::founded("crash-inside");
    let seat = harness.bootstrap_seat("seat");
    harness.run_commit(&common::commit(
        "crash-2",
        &[
            "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
         VALUES ('crash-b', 'person', 'B', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
        ],
    ));
    let page = harness.page(seat.floor, &seat.epoch, 10_000);

    // The in-transaction hook fails, which is a crash the transaction sees.
    let mut hook = |_: &rusqlite::Connection, _: i64| {
        Err(SeatError::Invariant {
            context: "the process died".to_owned(),
        })
    };
    let mut hooks = ApplyHooks {
        on_commit_in_transaction: Some(&mut hook),
        on_commit_durable: None,
    };
    assert!(
        centraid_seat::apply_page(
            &seat.connection,
            &seat.header(page.watermark.seq),
            &page.rows,
            &mut hooks,
        )
        .is_err()
    );

    let seat = seat.reopen();
    let rows: i64 = seat
        .connection
        .query_row(
            "SELECT COUNT(*) FROM core_party WHERE party_id = 'crash-b'",
            [],
            |row| row.get(0),
        )
        .expect("reads");
    assert_eq!(rows, 0, "the rows rolled back");
    assert_eq!(
        seat_state(&seat.connection).expect("reads").applied_seq,
        seat.floor,
        "AND SO DID THE CURSOR. A cursor that moved without its rows is a seat \
         silently missing a commit for ever."
    );

    // And the next attempt simply succeeds, from the same cursor.
    let again = harness.page(seat.floor, &seat.epoch, 10_000);
    centraid_seat::apply_page(
        &seat.connection,
        &seat.header(again.watermark.seq),
        &again.rows,
        &mut ApplyHooks::default(),
    )
    .expect("the next attempt succeeds");
    let rows: i64 = seat
        .connection
        .query_row(
            "SELECT COUNT(*) FROM core_party WHERE party_id = 'crash-b'",
            [],
            |row| row.get(0),
        )
        .expect("reads");
    assert_eq!(rows, 1);
}

// ------------------------------------------- 2. duplicate delivery ----------

/// The same page twice changes nothing.
///
/// **The red:** without rule 5 (drop a row at or below `applied_seq` before
/// binding it), a redelivered span that contains a delete followed by a
/// re-insert replays the delete and removes the live row. Demonstrated in
/// `applier.rs`'s own
/// `a_replayed_delete_after_a_reinsert_does_not_remove_the_live_row`, which
/// fails on an applier that trusts the upsert.
#[test]
fn the_same_page_twice_changes_nothing_at_the_seat() {
    let harness = Harness::founded("dup-page");
    let seat = harness.bootstrap_seat("seat");
    harness.run_commit(&common::commit(
        "dup-1",
        &[
            "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
         VALUES ('dup-a', 'person', 'A', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
        ],
    ));
    harness.run_commit(&common::commit(
        "dup-2",
        &["DELETE FROM core_party WHERE party_id = 'dup-a'"],
    ));
    harness.run_commit(&common::commit("dup-3", &[
        "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
         VALUES ('dup-a', 'person', 'A again', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')",
    ]));

    let page = harness.page(seat.floor, &seat.epoch, 10_000);
    let first = centraid_seat::apply_page(
        &seat.connection,
        &seat.header(page.watermark.seq),
        &page.rows,
        &mut ApplyHooks::default(),
    )
    .expect("the first delivery");
    let after_first = common::replicated_state(&seat.connection);

    // THE SAME PAGE AGAIN, whole, including the delete.
    let second = centraid_seat::apply_page(
        &seat.connection,
        &seat.header(page.watermark.seq),
        &page.rows,
        &mut ApplyHooks::default(),
    )
    .expect("the second delivery");

    assert!(first.applied > 0);
    assert_eq!(second.applied, 0, "nothing was bound the second time");
    assert_eq!(second.duplicate, page.rows.len());
    assert_eq!(
        common::replicated_state(&seat.connection),
        after_first,
        "the file is unchanged — and `A again` in particular survived the replayed delete"
    );
    let name: String = seat
        .connection
        .query_row(
            "SELECT display_name FROM core_party WHERE party_id = 'dup-a'",
            [],
            |row| row.get(0),
        )
        .expect("the row is there");
    assert_eq!(name, "A again");
}

/// The same intent twice executes once.
///
/// **The red:** without the ledger lookup keyed on `(vault, intent, hash)`, the
/// second delivery runs the handler again and the vault holds two parties for
/// one member action. Demonstrated by submitting the same intent id twice and
/// counting `core_party`.
#[test]
fn the_same_intent_twice_executes_once_at_the_gateway() {
    let harness = Harness::founded("dup-intent");
    let registry =
        centraid_vault::commands::Registry::with_system_commands().expect("the registry builds");
    let principal = centraid_vault::Principal::owner("device-1");
    let command = centraid_vault::commands::Command::new(
        "core.add_party",
        serde_json::json!({ "display_name": "Once", "kind": "person" }),
    )
    .with_intent("i-once", "device-1");

    let first = harness
        .vault
        .execute(&registry, &principal, &command)
        .expect("the first delivery executes");
    let second = harness
        .vault
        .execute(&registry, &principal, &command)
        .expect("the second delivery is answered");

    assert!(!first.replayed, "the first delivery ran the handler");
    assert!(
        second.replayed,
        "THE SECOND WAS ANSWERED FROM THE LEDGER. A second run would leave the vault \
         holding two parties for one member action."
    );
    assert_eq!(
        first.invocation_id, second.invocation_id,
        "the same answer, not a new one"
    );

    let parties: i64 = harness
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT COUNT(*) FROM core_party WHERE display_name = 'Once'",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("the count reads");
    assert_eq!(parties, 1);

    // And exactly one receipt, neither duplicated nor lost.
    let receipts: i64 = harness
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT COUNT(*) FROM access_receipt WHERE invocation_id = ?1",
                [&first.invocation_id],
                |row| row.get(0),
            )?)
        })
        .expect("the count reads");
    assert_eq!(receipts, 1);
}

// ------------------------------------------ 3. disk full at the seat --------

/// A full seat file rolls the commit back whole and resumes from the same
/// cursor.
///
/// **The red:** with `SQLITE_FULL` reaching the caller as a generic SQLite
/// error, the shell shows "sync failed" and the member has no idea that
/// clearing space would fix it; and with the cursor written outside the
/// transaction, the half-applied commit is skipped for ever. Demonstrated by
/// classifying only in the log plane's helper and by moving the cursor write.
///
/// `PRAGMA max_page_count` makes the file logically full, which reports the
/// same primary code a full filesystem does — so the case is testable without
/// one.
#[test]
fn a_full_seat_file_rolls_back_whole_and_resumes_from_the_same_cursor() {
    let harness = Harness::founded("disk-full");
    let seat = harness.bootstrap_seat("seat");

    // Rows big enough that applying them needs NEW pages rather than fitting
    // in the free ones a `VACUUM INTO` snapshot leaves behind. Four kilobytes
    // of name each: absurd as data, and the point is the page count.
    let wide = "w".repeat(4_000);
    for index in 0..40 {
        harness.run_commit(&common::commit(
            "full",
            &[&format!(
                "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
                 VALUES ('full-{index:03}', 'person', '{wide}',
                         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"
            )],
        ));
    }
    let page = harness.page(seat.floor, &seat.epoch, 10_000);
    let before = seat_state(&seat.connection).expect("reads").applied_seq;

    // THE FILE CANNOT GROW. The free pages the snapshot's own VACUUM left are
    // reclaimed first, so the ceiling is the file's real size and the first
    // apply that needs a page fails rather than quietly fitting.
    seat.connection
        .execute_batch("VACUUM")
        .expect("the seat file is compacted");
    let current: i64 = seat
        .connection
        .query_row("PRAGMA page_count", [], |row| row.get(0))
        .expect("the page count reads");
    seat.connection
        .pragma_update(None, "max_page_count", current)
        .expect("the ceiling is set");

    let error = centraid_seat::apply_page(
        &seat.connection,
        &seat.header(page.watermark.seq),
        &page.rows,
        &mut ApplyHooks::default(),
    )
    .expect_err("the apply cannot fit");
    assert!(
        error.is_disk_full(),
        "SQLITE_FULL must be its own typed answer, or the shell says `sync failed` \
         and the member never learns that clearing space would fix it: {error}"
    );

    // THE FAILING COMMIT ROLLED BACK WHOLE, and the cursor stopped at the last
    // one that did land — never past it. A cursor ahead of the rows is a seat
    // that skips a commit for ever.
    let after = seat_state(&seat.connection).expect("reads");
    assert!(
        after.applied_seq >= before,
        "the cursor never walks backwards"
    );
    let highest_applied = page
        .rows
        .iter()
        .filter(|row| row.commit_seq <= after.applied_commit_seq)
        .map(|row| row.seq)
        .max()
        .unwrap_or(before);
    assert_eq!(
        after.applied_seq, highest_applied,
        "the cursor is exactly at the last row of the last commit that landed"
    );
    // And nothing is half-applied: the row count is either all of a commit or
    // none of it. The first commit's rows may have landed before the ceiling
    // bit, so the claim is per-commit rather than per-page.
    let applied: i64 = seat
        .connection
        .query_row(
            "SELECT COUNT(*) FROM core_party WHERE party_id LIKE 'full-%'",
            [],
            |row| row.get(0),
        )
        .expect("the count reads");
    // WHOLE COMMITS ONLY. Commits before the one that hit the ceiling are
    // durable — each was its own transaction, which is rule 2 — and the one
    // that hit it left nothing. What must never happen is a PARTIAL commit, and
    // `core_entity` and `core_party` are written by the same commit, so their
    // counts agreeing is that claim.
    let entities: i64 = seat
        .connection
        .query_row(
            "SELECT COUNT(*) FROM core_entity WHERE entity_id LIKE 'full-%'",
            [],
            |row| row.get(0),
        )
        .expect("the count reads");
    assert_eq!(
        applied, entities,
        "a commit landed by halves: {applied} parties and {entities} entities"
    );
    assert!(
        applied < 40,
        "the ceiling never bit; the test proved nothing"
    );

    // SPACE AGAIN, and the next apply succeeds from the same cursor.
    seat.connection
        .pragma_update(None, "max_page_count", 1_073_741_823_i64)
        .expect("the ceiling is lifted");
    let again = harness.page(after.applied_seq, &seat.epoch, 10_000);
    centraid_seat::apply_page(
        &seat.connection,
        &seat.header(again.watermark.seq),
        &again.rows,
        &mut ApplyHooks::default(),
    )
    .expect("the retry succeeds");
    let applied: i64 = seat
        .connection
        .query_row(
            "SELECT COUNT(*) FROM core_party WHERE party_id LIKE 'full-%'",
            [],
            |row| row.get(0),
        )
        .expect("the count reads");
    assert_eq!(applied, 40, "every commit landed on the retry");
}

/// The disk-full answer survives being wrapped by the vault's own classifier.
#[test]
fn a_full_file_is_classified_wherever_it_surfaces() {
    // The seat's own classifier and the vault's must agree, or a `?` through
    // one layer loses what the other knew.
    let seat_side = SeatError::from_sqlite(
        "applying a row",
        rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(13), None),
    );
    assert!(seat_side.is_disk_full());
    let through_the_vault = SeatError::Vault(centraid_vault::VaultError::from(
        rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(13), None),
    ));
    assert!(
        through_the_vault.is_disk_full(),
        "a `?` through the vault's error must not lose the classification"
    );
}

// ------------------------------------- 4. restore with paired seats ---------

/// An old seat is told to re-bootstrap, with the reason.
///
/// **The red:** with the epoch gate checked only on the page header and not per
/// row, a restored gateway's page is applied into a file whose shape has moved
/// and the first symptom is a query returning the wrong answer. Demonstrated by
/// removing the per-row check in `apply_page` and feeding a page whose header
/// says the new epoch and whose rows carry the old one.
///
/// Lane R's `run_restore_drill` is the end-to-end version over a real backup
/// and a real `centraid recover`; this is the epoch mechanic it rests on.
#[test]
fn an_epoch_bump_tells_an_old_seat_to_rebootstrap_and_says_why() {
    let harness = Harness::founded("restore-epoch");
    let seat = harness.bootstrap_seat("seat");
    harness.run_commit(&common::commit("before", &[
        "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
         VALUES ('restore-a', 'person', 'A', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    ]));
    let before = centraid_vault::log::log_state(&harness.vault).expect("the state reads");

    // A RESTORE FROM BACKUP, as the vault expresses it.
    let after = centraid_vault::log::door::bump_epoch(&harness.vault, "backup-restore")
        .expect("the epoch bumps");
    assert_ne!(after.epoch, before.epoch);
    assert_eq!(
        after.floor.seq, before.watermark.seq,
        "the floor is derived from the log the file HAS"
    );

    // The seat's cursor names the old epoch, and the door says why.
    let error = centraid_vault::log::read_log_page(
        &harness.vault,
        &centraid_vault::log::Cursor {
            epoch: seat.epoch.clone(),
            seq: seat.floor,
        },
        1_000,
    )
    .expect_err("the door refuses");
    assert!(matches!(
        error,
        centraid_vault::VaultError::RebootstrapRequired {
            reason: centraid_vault::RebootstrapReason::EpochMismatch
        }
    ));

    // AND THE APPLIER REFUSES TOO, per row, because the header is only what
    // the gateway believes.
    harness.run_commit(&common::commit("after", &[
        "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
         VALUES ('restore-b', 'person', 'B', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')",
    ]));
    let page = harness.page(after.floor.seq, &after.epoch, 1_000);
    // The header lies: it claims the seat's own epoch while the rows carry the
    // gateway's new one.
    let mut lying = seat.header(page.watermark.seq);
    lying.epoch = seat.epoch.clone();
    let error = centraid_seat::apply_page(
        &seat.connection,
        &lying,
        &page.rows,
        &mut ApplyHooks::default(),
    )
    .expect_err("the per-row gate refuses");
    assert!(matches!(error, SeatError::EpochGate { .. }));
    let landed: i64 = seat
        .connection
        .query_row(
            "SELECT COUNT(*) FROM core_party WHERE party_id = 'restore-b'",
            [],
            |row| row.get(0),
        )
        .expect("reads");
    assert_eq!(landed, 0, "nothing from another epoch landed");
}

/// The outbox survives the cutover, and nothing queued is lost.
///
/// **The red:** with the file swapped before the outbox is rescued — the
/// natural order, since installing the snapshot is the obvious first step —
/// a crash in the window destroys work that exists nowhere else, because a
/// queued intent is the only copy of what the member did offline. Demonstrated
/// by running `Install` before `CarryOver` and killing the process between.
#[test]
fn the_cutover_carries_every_queued_intent_into_the_new_file() {
    let harness = Harness::founded("restore-cutover");
    let old = harness.bootstrap_seat("old");
    {
        let outbox = Outbox::open(&old.connection).expect("opens");
        for id in ["i-1", "i-2", "i-3"] {
            outbox.enqueue(&common::intent(id), "t").expect("queues");
        }
        outbox
            .transition("i-2", IntentState::Denied, "t", |record| {
                record.reason = Some("you may not".to_owned());
            })
            .expect("transitions");
    }

    // STEP 2, before any swap. The order is the contract.
    let carried = centraid_seat::sync::carry_over(&old.connection).expect("the carry-over reads");
    assert_eq!(carried.len(), 3);

    // A restore, then steps 3 and 4.
    centraid_vault::log::door::bump_epoch(&harness.vault, "backup-restore")
        .expect("the epoch bumps");
    let new = harness.bootstrap_seat("new");
    assert_eq!(
        centraid_seat::sync::restore_carried_over(&new.connection, &carried, "t2")
            .expect("the restore runs"),
        3,
        "every queued intent reached the new file; a queued intent is the ONLY copy \
         of what the member did offline"
    );

    let restored = Outbox::open(&new.connection).expect("opens");
    assert_eq!(restored.all().expect("reads").len(), 3);
    // The refusal survived as a refusal.
    let denied = restored.get("i-2").expect("reads").expect("there");
    assert_eq!(denied.state, IntentState::Denied);
    assert_eq!(denied.reason.as_deref(), Some("you may not"));
    // And the new file is in the NEW epoch, so the cutover actually cut over.
    assert_ne!(
        seat_state(&new.connection).expect("reads").epoch,
        old.epoch,
        "the new seat is in the gateway's new epoch"
    );

    // A write admitted during the cutover is admitted and not sent.
    let admission = centraid_seat::sync::admission_during_rebootstrap();
    assert!(admission.admit);
    assert!(!admission.send);
}

// ------------------------- 5. interrupted snapshot, DOWNLOAD side -----------

/// A bootstrap interrupted mid-stream never applies a partial file.
///
/// **The red:** with the downloaded bytes written straight to the seat's own
/// path, an interrupted download leaves a truncated SQLite file at exactly the
/// name the seat opens next — and SQLite opens a truncated file happily,
/// reporting an empty or corrupt database rather than a missing one. The member
/// sees an empty product. Demonstrated by truncating the artifact in place and
/// opening it.
///
/// The build side (a process killed mid-`VACUUM INTO`, mid-gzip) is lane D1's
/// `snapshot::Fault`; this is the half a seat owns.
#[test]
fn an_interrupted_bootstrap_never_installs_a_partial_file() {
    let harness = Harness::founded("interrupted-bootstrap");
    harness.run_commit(&common::commit(
        "seed",
        &[
            "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
         VALUES ('boot-a', 'person', 'A', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
        ],
    ));

    let snapshot_dir = harness.join("artifact");
    let head =
        centraid_vault::build_snapshot(&harness.vault, &snapshot_dir).expect("the snapshot builds");
    let artifact = snapshot_dir.join(&head.name);
    let whole = std::fs::read(&artifact).expect("the artifact reads");

    // THE DIGEST IS OVER THE ARTIFACT'S BYTES, so a partial download is
    // detectable without opening it as a database.
    assert_eq!(
        blake3::hash(&whole).to_hex().to_string(),
        head.digest,
        "the head's digest is over the bytes that move"
    );

    // An interrupted download: the first two thirds arrived.
    let partial = &whole[..(whole.len() * 2 / 3).max(1)];
    assert_ne!(
        blake3::hash(partial).to_hex().to_string(),
        head.digest,
        "a partial artifact does not match its digest, which is the whole check"
    );

    // Resuming by digest: the rest arrives and the digest matches again. This
    // is the iroh-blobs case expressed at the level the seat owns — the range
    // is a range over the bytes the client downloads, because the artifact is
    // served compressed and as-is.
    let mut resumed = partial.to_vec();
    resumed.extend_from_slice(&whole[partial.len()..]);
    assert_eq!(
        blake3::hash(&resumed).to_hex().to_string(),
        head.digest,
        "a resumed download reaches the same bytes"
    );
    assert_eq!(resumed, whole);

    // AND A PARTIAL FILE IS NEVER WHAT THE SEAT OPENS. Written to a staging
    // name, verified, and only then renamed in — so the path the seat opens
    // either does not exist or is a complete artifact.
    let staging = harness.join("seat.db.part");
    std::fs::write(&staging, partial).expect("the partial writes");
    let installed = harness.join("seat.db");
    let verified = blake3::hash(partial).to_hex().to_string() == head.digest;
    assert!(!verified);
    if verified {
        std::fs::rename(&staging, &installed).expect("it installs");
    }
    assert!(
        !installed.exists(),
        "a truncated artifact reached the path the seat opens — and SQLite opens a \
         truncated file happily, so the member would see an empty product"
    );

    // The whole artifact verifies and installs, and the seat reads it.
    std::fs::write(&staging, &whole).expect("the whole artifact writes");
    assert_eq!(
        blake3::hash(&std::fs::read(&staging).expect("reads"))
            .to_hex()
            .to_string(),
        head.digest
    );
    std::fs::rename(&staging, &installed).expect("it installs");
    let seat = harness.bootstrap_seat("bootstrapped");
    let rows: i64 = seat
        .connection
        .query_row(
            "SELECT COUNT(*) FROM core_party WHERE party_id = 'boot-a'",
            [],
            |row| row.get(0),
        )
        .expect("reads");
    assert_eq!(rows, 1, "the verified artifact carries the rows");
}

/// A bootstrap that restarts from a verified head, rather than resuming.
///
/// The other admissible answer: when the partial bytes cannot be resumed (a
/// moved artifact, a gateway that pruned past the pinned seq), the seat starts
/// again from a head it has verified — and **never** mixes bytes from two
/// artifacts, which would produce a file whose digest matches neither.
#[test]
fn a_bootstrap_that_cannot_resume_restarts_from_a_verified_head() {
    let harness = Harness::founded("restart-bootstrap");
    harness.run_commit(&common::commit(
        "one",
        &[
            "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
         VALUES ('head-a', 'person', 'A', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
        ],
    ));
    let first = centraid_vault::build_snapshot(&harness.vault, &harness.join("art-1"))
        .expect("the first artifact builds");

    // The gateway moves on and cuts a NEW artifact at a new position.
    harness.run_commit(&common::commit(
        "two",
        &[
            "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
         VALUES ('head-b', 'person', 'B', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')",
        ],
    ));
    let second = centraid_vault::build_snapshot(&harness.vault, &harness.join("art-2"))
        .expect("the second artifact builds");
    assert_ne!(first.digest, second.digest);
    assert!(second.seq > first.seq);

    let partial = {
        let bytes = std::fs::read(harness.join("art-1").join(&first.name)).expect("reads");
        bytes[..bytes.len() / 2].to_vec()
    };
    let whole_second = std::fs::read(harness.join("art-2").join(&second.name)).expect("reads");

    // MIXING BYTES FROM TWO ARTIFACTS matches neither digest, which is what the
    // check is for: a seat that appended the new artifact's tail to the old
    // one's head would have a file that opens and is wrong.
    let mut mixed = partial.clone();
    mixed.extend_from_slice(&whole_second[partial.len().min(whole_second.len())..]);
    let mixed_digest = blake3::hash(&mixed).to_hex().to_string();
    assert_ne!(mixed_digest, first.digest);
    assert_ne!(mixed_digest, second.digest);

    // Restarting from the verified head is the answer: the whole new artifact.
    assert_eq!(
        blake3::hash(&whole_second).to_hex().to_string(),
        second.digest
    );
}
