//! The log door, the epoch gate, the cursors, retention and the epoch bump.
//!
//! The paging rules are the part of the plane a port is most likely to get
//! subtly wrong, because every mistake looks like "it works" until a page
//! boundary lands somewhere nobody tested.

mod common;

use centraid_vault::Clock as _;
use centraid_vault::error::RebootstrapReason;
use centraid_vault::log::{self, Cursor};
use centraid_vault::{Value, VaultError};

/// Write `count` separate commits, each inserting one party.
fn commits(vault: &centraid_vault::Vault, prefix: &str, count: usize) {
    for index in 0..count {
        vault
            .commit(|tx| {
                tx.set_producer("test.fill");
                tx.connection().execute(
                    "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
                     VALUES (?1, 'person', ?2, ?3, ?3)",
                    rusqlite::params![
                        format!("{prefix}-{index}"),
                        format!("P{index}"),
                        "2026-01-01T00:00:00.000Z"
                    ],
                )?;
                Ok(())
            })
            .expect("the commit runs");
    }
}

fn floor_cursor(vault: &centraid_vault::Vault) -> Cursor {
    log::log_state(vault).expect("the state reads").floor
}

#[test]
fn a_page_from_the_floor_serves_every_row_and_next_is_the_watermark() {
    let scratch = common::Scratch::founded("page").expect("a vault is founded");
    commits(&scratch.vault, "p", 3);
    let state = log::log_state(&scratch.vault).expect("the state reads");
    let page = log::read_log_page(
        &scratch.vault,
        &Cursor {
            epoch: state.epoch.clone(),
            seq: 0,
        },
        1_000,
    )
    .expect("the page serves");
    assert!(!page.rows.is_empty());
    assert!(!page.has_more);
    // `next` is the WATERMARK when there is no more, not the last served seq:
    // a seat that asked again from the last row would re-read it forever.
    assert_eq!(page.next, page.watermark);
    assert_eq!(page.next.seq, state.watermark.seq);
    assert_eq!(page.vault_epoch, state.epoch);
    assert_eq!(page.ddl_version, log::constants().ddl_version);
    // The rows come back in seq order, which is the order a seat applies them.
    let seqs: Vec<i64> = page.rows.iter().map(|row| row.seq).collect();
    let mut sorted = seqs.clone();
    sorted.sort_unstable();
    assert_eq!(seqs, sorted);
}

#[test]
fn a_page_never_ends_mid_commit_even_at_limit_one() {
    // THE RULE. A seat applies one commit per transaction with its cursor in
    // it; half a commit is a transaction it cannot close. So the tail of the
    // last row's commit is appended WHATEVER the limit says.
    let scratch = common::Scratch::founded("tail").expect("a vault is founded");
    // One commit that writes two rows: a party and its `core_entity` row.
    commits(&scratch.vault, "t", 1);
    let state = log::log_state(&scratch.vault).expect("the state reads");
    let last_commit = state.commit_seq;
    let page = log::read_log_page(
        &scratch.vault,
        &Cursor {
            epoch: state.epoch.clone(),
            // Start just below the last commit's first row.
            seq: state.watermark.seq - 2,
        },
        1,
    )
    .expect("the page serves");
    let in_last: Vec<&log::LogRow> = page
        .rows
        .iter()
        .filter(|row| row.commit_seq == last_commit)
        .collect();
    assert!(
        in_last.len() >= 2,
        "a limit of 1 served {} of the last commit's rows",
        in_last.len()
    );
    // And the page is complete: the last commit's highest seq is served.
    assert_eq!(
        page.rows.last().map(|row| row.seq),
        Some(state.watermark.seq)
    );
}

#[test]
fn local_rows_are_filtered_and_not_gapped() {
    // They occupy `seq` numbers a seat never sees, so a reader must not treat
    // `seq > since` as "the next row is since + 1".
    let scratch = common::Scratch::founded("filter").expect("a vault is founded");
    scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.local");
            tx.connection().execute(
                "INSERT INTO replica_intent_outcome
                   (intent_id, device_id, app_id, action, payload_hash, status,
                    created_at, updated_at)
                 VALUES ('i-filtered', 'd', 'tally', 'a', 'h', 'queued', ?1, ?1)",
                [&"2026-01-01T00:00:00.000Z"],
            )?;
            Ok(())
        })
        .expect("the local commit runs");
    commits(&scratch.vault, "f", 1);

    let state = log::log_state(&scratch.vault).expect("the state reads");
    let page = log::read_log_page(
        &scratch.vault,
        &Cursor {
            epoch: state.epoch.clone(),
            seq: 0,
        },
        1_000,
    )
    .expect("the page serves");
    assert!(
        page.rows.iter().all(|row| !row.local),
        "a local row was served"
    );
    assert!(
        !page
            .rows
            .iter()
            .any(|row| row.table == "replica_intent_outcome"),
        "the local lane reached a seat"
    );
    // The sequence HAS a gap and the page still reaches the watermark, which is
    // the whole point: the numbers are not contiguous and `next` is right.
    assert_eq!(page.next.seq, state.watermark.seq);
    assert!(!page.has_more);
}

#[test]
fn a_page_of_nothing_but_local_rows_still_advances() {
    // Without this a vault with a run of local rows serves the same empty page
    // forever and the seat never moves.
    let scratch = common::Scratch::founded("advance").expect("a vault is founded");
    let before = log::log_state(&scratch.vault).expect("the state reads");
    for index in 0..3 {
        scratch
            .vault
            .commit(|tx| {
                tx.set_producer("test.local");
                tx.connection().execute(
                    "INSERT INTO replica_intent_outcome
                       (intent_id, device_id, app_id, action, payload_hash, status,
                        created_at, updated_at)
                     VALUES (?1, 'd', 'tally', 'a', 'h', 'queued', ?2, ?2)",
                    rusqlite::params![format!("i{index}"), "2026-01-01T00:00:00.000Z"],
                )?;
                Ok(())
            })
            .expect("the local commit runs");
    }
    let after = log::log_state(&scratch.vault).expect("the state reads");
    assert!(after.watermark.seq > before.watermark.seq);
    let page =
        log::read_log_page(&scratch.vault, &before.watermark, 1_000).expect("the page serves");
    assert!(page.rows.is_empty());
    assert!(!page.has_more);
    assert_eq!(
        page.next.seq, after.watermark.seq,
        "an all-filtered page must still advance"
    );
}

#[test]
fn has_more_is_a_probe_and_next_is_the_last_served_seq_while_it_holds() {
    let scratch = common::Scratch::founded("more").expect("a vault is founded");
    commits(&scratch.vault, "m", 5);
    let state = log::log_state(&scratch.vault).expect("the state reads");
    let page = log::read_log_page(
        &scratch.vault,
        &Cursor {
            epoch: state.epoch.clone(),
            seq: 0,
        },
        2,
    )
    .expect("the page serves");
    assert!(page.has_more);
    assert_eq!(
        page.next.seq,
        page.rows.last().expect("rows were served").seq,
        "while there is more, `next` is the last SERVED seq"
    );
    // Walking to the end terminates and serves every row exactly once.
    let mut cursor = Cursor {
        epoch: state.epoch.clone(),
        seq: 0,
    };
    let mut seen: Vec<i64> = Vec::new();
    for _ in 0..50 {
        let page = log::read_log_page(&scratch.vault, &cursor, 2).expect("the page serves");
        seen.extend(page.rows.iter().map(|row| row.seq));
        cursor = page.next.clone();
        if !page.has_more {
            break;
        }
    }
    let mut unique = seen.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(seen.len(), unique.len(), "a row was served twice");
    assert_eq!(
        unique.last().copied(),
        Some(state.watermark.seq),
        "the walk did not reach the watermark"
    );
}

#[test]
fn the_three_gates_on_a_cursor_each_name_their_reason() {
    let scratch = common::Scratch::founded("gates").expect("a vault is founded");
    commits(&scratch.vault, "g", 2);
    let state = log::log_state(&scratch.vault).expect("the state reads");

    let cases: &[(Cursor, RebootstrapReason)] = &[
        (
            Cursor {
                epoch: "another-epoch".to_owned(),
                seq: 0,
            },
            RebootstrapReason::EpochMismatch,
        ),
        (
            Cursor {
                epoch: state.epoch.clone(),
                seq: state.watermark.seq + 1,
            },
            RebootstrapReason::CursorAhead,
        ),
    ];
    for (cursor, expected) in cases {
        match log::read_log_page(&scratch.vault, cursor, 10) {
            Err(VaultError::RebootstrapRequired { reason }) => assert_eq!(reason, *expected),
            other => panic!("expected {expected:?}, got {:?}", other.map(|_| ())),
        }
    }

    // `retention` needs a floor above the cursor, which a prune produces.
    let clock_now = 1_767_225_600_000_i64 + 60 * 86_400_000;
    log::prune(&scratch.vault, clock_now).expect("the prune runs");
    let floor = floor_cursor(&scratch.vault);
    assert!(floor.seq > 0, "the prune moved no floor");
    match log::read_log_page(
        &scratch.vault,
        &Cursor {
            epoch: floor.epoch.clone(),
            seq: floor.seq - 1,
        },
        10,
    ) {
        Err(VaultError::RebootstrapRequired { reason }) => {
            assert_eq!(reason, RebootstrapReason::Retention);
        }
        other => panic!("expected Retention, got {:?}", other.map(|_| ())),
    }
    // The wire spellings are the closed vocabulary, unchanged from v0.
    assert_eq!(RebootstrapReason::EpochMismatch.as_wire(), "epoch-mismatch");
    assert_eq!(RebootstrapReason::Retention.as_wire(), "retention");
    assert_eq!(RebootstrapReason::CursorAhead.as_wire(), "cursor-ahead");
}

#[test]
fn a_limit_outside_one_to_ten_thousand_is_refused() {
    let scratch = common::Scratch::founded("limit").expect("a vault is founded");
    let state = log::log_state(&scratch.vault).expect("the state reads");
    let at = |seq| Cursor {
        epoch: state.epoch.clone(),
        seq,
    };
    for limit in [0, -1, 10_001] {
        assert!(
            log::read_log_page(&scratch.vault, &at(0), limit).is_err(),
            "a limit of {limit} was accepted"
        );
    }
    assert!(log::read_log_page(&scratch.vault, &at(0), 1).is_ok());
    assert!(log::read_log_page(&scratch.vault, &at(0), 10_000).is_ok());
}

#[test]
fn a_seat_cursor_never_moves_backwards() {
    let scratch = common::Scratch::founded("cursor").expect("a vault is founded");
    common::enrol(&scratch.vault, "d1", "pk-1").expect("the device enrols");
    assert!(log::record_seat_cursor(&scratch.vault, "d1", 10).expect("it records"));
    assert!(log::record_seat_cursor(&scratch.vault, "d1", 20).expect("it records"));
    // THE GUARD. A retry, or a restored file, re-sends an older position; a
    // cursor that went back would un-pin the retention floor and then re-pin
    // it, and the floor would oscillate.
    assert!(
        !log::record_seat_cursor(&scratch.vault, "d1", 5).expect("it runs"),
        "the cursor moved backwards"
    );
    let devices = scratch.vault.live_devices().expect("the list reads");
    assert_eq!(devices[0].sync_cursor, Some(20));
    // The same position again is not a move backwards.
    assert!(log::record_seat_cursor(&scratch.vault, "d1", 20).expect("it runs"));
}

#[test]
fn a_behind_seat_holds_the_floor_and_an_abandoned_one_stops_pinning() {
    let scratch = common::Scratch::founded("hold").expect("a vault is founded");
    commits(&scratch.vault, "h", 4);
    common::enrol(&scratch.vault, "behind", "pk").expect("the device enrols");
    // THE CURSOR IS STAMPED LATE. Retention is 30 days and the seat hold is
    // 14, so a cursor stamped at the same instant as the rows has already
    // stopped pinning by the time they age out — which is the tension the two
    // windows genuinely have, and the reason this test moves the clock.
    scratch.clock.advance_days(50);
    let state = log::log_state(&scratch.vault).expect("the state reads");
    // The seat has applied the first commit and no more.
    let first_commit_end: i64 = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT MAX(seq) FROM replica_log WHERE commit_seq = 2",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("the seq reads");
    assert!(first_commit_end < state.watermark.seq);
    log::record_seat_cursor(&scratch.vault, "behind", first_commit_end).expect("it records");

    let now = scratch.clock.now_ms() + 10 * 86_400_000;
    let pruned = log::prune(&scratch.vault, now).expect("the prune runs");
    assert_eq!(pruned.held_by_seat, Some(first_commit_end));
    assert!(
        pruned.floor <= first_commit_end,
        "the prune crossed a live seat's cursor: {} > {first_commit_end}",
        pruned.floor
    );
    // AND THE FLOOR IS ON A COMMIT EDGE. A floor inside a commit serves a seat
    // the second half of a transaction it cannot apply as one.
    if pruned.floor > 0 {
        let straddles: i64 = scratch
            .vault
            .read(|connection| {
                Ok(connection.query_row(
                    "SELECT COUNT(*) FROM replica_log
                      WHERE commit_seq = (SELECT commit_seq FROM replica_log WHERE seq = ?1)
                        AND seq > ?1",
                    [pruned.floor],
                    |row| row.get(0),
                )?)
            })
            .expect("the count reads");
        assert_eq!(straddles, 0, "the floor landed INSIDE a commit");
    }

    // A cursor last seen longer ago than the hold stops pinning: a phone lost
    // a year ago must not hold the log at its last position forever.
    let much_later = now + 30 * 86_400_000;
    let after = log::prune(&scratch.vault, much_later).expect("the prune runs");
    assert_eq!(
        after.held_by_seat, None,
        "an abandoned cursor still pins the floor"
    );
    assert!(after.floor >= pruned.floor);
}

#[test]
fn an_epoch_bump_derives_the_floor_from_the_log_and_invalidates_every_cursor() {
    let scratch = common::Scratch::founded("bump").expect("a vault is founded");
    commits(&scratch.vault, "b", 2);
    let before = log::log_state(&scratch.vault).expect("the state reads");

    let after = log::bump_epoch(&scratch.vault, "backup-restore").expect("the bump runs");
    assert_ne!(after.epoch, before.epoch);
    // FROM THE LOG THE FILE HAS. The earlier derivation read
    // `sqlite_sequence`, which made every seat go silently and permanently
    // stale on every schema change and every restore.
    assert_eq!(after.floor.seq, before.watermark.seq);
    assert_eq!(after.floor.epoch, after.epoch);

    // The old cursor is refused with `epoch-mismatch`.
    match log::read_log_page(&scratch.vault, &before.watermark, 10) {
        Err(VaultError::RebootstrapRequired { reason }) => {
            assert_eq!(reason, RebootstrapReason::EpochMismatch);
        }
        other => panic!("the old cursor was served: {:?}", other.map(|_| ())),
    }

    // And new rows continue ABOVE the prior watermark, so a seat that
    // bootstraps after the bump does not see a reused number.
    commits(&scratch.vault, "after", 1);
    let rows = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row::<i64, _, _>(
                "SELECT MIN(seq) FROM replica_log WHERE epoch = ?1",
                [&after.epoch],
                |row| row.get(0),
            )?)
        })
        .expect("the seq reads");
    assert!(
        rows > before.watermark.seq,
        "a new epoch's first row is at {rows}, at or below the old watermark {}",
        before.watermark.seq
    );
}

#[test]
fn a_prune_deletes_a_foreign_epochs_rows_whatever_their_age() {
    // An epoch bump has already told every seat to re-bootstrap, so the old
    // epoch's rows are not retention — they are garbage.
    let scratch = common::Scratch::founded("foreign").expect("a vault is founded");
    commits(&scratch.vault, "old", 2);
    let before: i64 = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row("SELECT COUNT(*) FROM replica_log", [], |row| row.get(0))?)
        })
        .expect("the count reads");
    log::bump_epoch(&scratch.vault, "schema-change").expect("the bump runs");
    commits(&scratch.vault, "new", 1);

    // The clock has not moved at all, so nothing is old enough to age out.
    let pruned = log::prune(&scratch.vault, 1_767_225_600_000).expect("the prune runs");
    assert_eq!(pruned.foreign_deleted, before);
    let remaining: Vec<String> = scratch
        .vault
        .read(|connection| {
            let mut statement = connection.prepare("SELECT DISTINCT epoch FROM replica_log")?;
            Ok(statement
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()?)
        })
        .expect("the epochs read");
    assert_eq!(remaining.len(), 1, "two epochs survive: {remaining:?}");
}

#[test]
fn the_log_state_ddl_version_is_the_build_constant_and_not_the_files_column() {
    // SEAM 5's third pair. A file's `ddl_version` records what wrote its rows;
    // `log_state` says what THIS BUILD serves, and conflating them makes an
    // additive column look like a full re-bootstrap.
    let scratch = common::Scratch::founded("ddl").expect("a vault is founded");
    scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.forge");
            tx.connection().execute(
                "UPDATE replica_meta SET ddl_version = 99 WHERE singleton = 1",
                [],
            )?;
            Ok(())
        })
        .expect("the forge commits");
    let state = log::log_state(&scratch.vault).expect("the state reads");
    assert_eq!(state.ddl_version, log::constants().ddl_version);
    assert_ne!(state.ddl_version, 99);
}

#[test]
fn a_cursor_is_the_wire_form_both_ways() {
    let scratch = common::Scratch::founded("wire").expect("a vault is founded");
    let state = log::log_state(&scratch.vault).expect("the state reads");
    let text = log::format_cursor(&state.watermark);
    assert_eq!(
        log::parse_cursor(&text).expect("it parses"),
        state.watermark
    );
    assert!(text.contains(':'));
    // The epoch is a uuid, so it carries no colon of its own — which is what
    // makes the split unambiguous.
    assert_eq!(text.matches(':').count(), 1);
    // A key the log stores round-trips too, so a `pk_json` is readable by both.
    assert_eq!(
        centraid_vault::value::key_from_json("[\"a\"]").expect("it parses"),
        vec![Value::Text("a".to_owned())]
    );
}
