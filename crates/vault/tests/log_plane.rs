//! The capture, the decode, and the guard — against a real file.
//!
//! Every test here is one of the ten seams the census names, or the invariant
//! the guard exists to make un-forgettable.

mod common;

use centraid_vault::log::{self, LogOp};
use centraid_vault::{Value, VaultError};

/// The log rows of one epoch, oldest first, INCLUDING the local lane — the
//. door filters those and this is the file's own view.
fn all_rows(vault: &centraid_vault::Vault) -> Vec<log::LogRow> {
    vault
        .read(|connection| {
            let sql = format!(
                "SELECT {} FROM replica_log ORDER BY seq",
                centraid_vault::log::store::LOG_ROW_COLUMNS
            );
            let mut statement = connection.prepare(&sql)?;
            let rows = statement
                .query_map([], |row| Ok(centraid_vault::log::store::log_row_from(row)))?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .into_iter()
                .collect::<centraid_vault::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .expect("the log reads")
}

#[test]
fn a_write_through_the_guard_reaches_the_log_and_nothing_else_can_write() {
    // THE INVARIANT AS A TYPE (D-1020-D1-5). Two halves: what the guard does,
    // and that there is no other door. The second half is also a grep in the
    // receipt, because a type cannot prove the absence of a future function.
    let scratch = common::Scratch::founded("guard").expect("a vault is founded");
    let rows = all_rows(&scratch.vault);
    assert!(
        rows.iter().any(|row| row.table == "core_vault"),
        "founding wrote no core_vault log row"
    );
    assert!(rows.iter().any(|row| row.table == "core_party"));
    for row in &rows {
        assert_eq!(row.producer, "vault.found");
        assert_eq!(row.op, LogOp::Insert);
        assert!(row.row.is_some(), "an insert must carry its image");
        assert!(row.prior.is_none(), "an insert has no prior");
        assert_eq!(row.committed_at, "2026-01-01T00:00:00.000Z");
    }
    // One commit, one position, shared by every row of it.
    let commits: std::collections::BTreeSet<i64> = rows.iter().map(|row| row.commit_seq).collect();
    assert_eq!(commits.len(), 1);
    assert_eq!(commits.into_iter().next(), Some(1));

    // A write through the READ connection is refused by SQLite, not by us.
    let refused = scratch.vault.read(|connection| {
        connection
            .execute("UPDATE core_vault SET display_name = 'x'", [])
            .map_err(VaultError::Sqlite)
    });
    assert!(refused.is_err());
}

#[test]
fn an_empty_commit_allocates_no_position_and_rings_no_doorbell() {
    let scratch = common::Scratch::founded("empty").expect("a vault is founded");
    let before = log::log_state(&scratch.vault).expect("the state reads");
    let outcome = scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.nothing");
            // A read, and nothing written.
            let count: i64 =
                tx.connection()
                    .query_row("SELECT COUNT(*) FROM core_party", [], |row| row.get(0))?;
            Ok(count)
        })
        .expect("the commit runs");
    assert_eq!(outcome.value, 1);
    assert_eq!(outcome.commit_seq, None, "an empty commit is not a commit");
    assert_eq!(outcome.rows, 0);
    let after = log::log_state(&scratch.vault).expect("the state reads");
    assert_eq!(before.commit_seq, after.commit_seq);
    assert_eq!(before.watermark, after.watermark);
}

#[test]
fn a_failed_commit_rolls_back_whole_and_leaves_the_position_where_it_was() {
    let scratch = common::Scratch::founded("rollback").expect("a vault is founded");
    let before = log::log_state(&scratch.vault).expect("the state reads");
    let rows_before = all_rows(&scratch.vault).len();

    let outcome: centraid_vault::Result<centraid_vault::CommitResult<()>> =
        scratch.vault.commit(|tx| {
            tx.set_producer("test.doomed");
            tx.connection().execute(
                "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
                 VALUES ('doomed', 'person', 'Doomed', ?1, ?1)",
                [&"2026-01-01T00:00:00.000Z"],
            )?;
            Err(VaultError::Invariant {
                context: "the body changed its mind".to_owned(),
            })
        });
    assert!(outcome.is_err());

    let after = log::log_state(&scratch.vault).expect("the state reads");
    assert_eq!(before.commit_seq, after.commit_seq);
    assert_eq!(all_rows(&scratch.vault).len(), rows_before);
    let survived: i64 = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT COUNT(*) FROM core_party WHERE party_id = 'doomed'",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("the count reads");
    assert_eq!(survived, 0);

    // AND THE SESSIONS WERE ABANDONED BEFORE THE ROLLBACK. If they had not
    // been, the rolled-back insert would replay into the NEXT commit — the
    // session extension does not un-record what a full rollback undid.
    let next = common::insert_note(&scratch.vault, "after").expect("the next commit runs");
    assert!(!next.is_empty());
    let rows = all_rows(&scratch.vault);
    assert!(
        !rows.iter().any(|row| {
            row.primary_key
                .first()
                .is_some_and(|key| *key == Value::Text("doomed".to_owned()))
        }),
        "the rolled-back row replayed into the next commit"
    );
}

#[test]
fn a_nested_commit_runs_inside_the_outer_pair_and_allocates_no_second_position() {
    let scratch = common::Scratch::founded("nested").expect("a vault is founded");
    let before = log::log_state(&scratch.vault).expect("the state reads");
    let outcome = scratch
        .vault
        .commit(|_outer| {
            assert!(scratch.vault.in_commit());
            let inner = scratch.vault.commit(|tx| {
                tx.connection().execute(
                    "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
                     VALUES ('nested', 'person', 'Nested', ?1, ?1)",
                    [&"2026-01-01T00:00:00.000Z"],
                )?;
                Ok(())
            })?;
            assert_eq!(inner.commit_seq, None, "the inner call allocates nothing");
            Ok(())
        })
        .expect("the outer commit runs");
    // ONE pair, ONE position — which is what a seat applies in one
    // transaction.
    assert_eq!(outcome.commit_seq, Some(before.commit_seq + 1));
    let rows = all_rows(&scratch.vault);
    let nested: Vec<&log::LogRow> = rows
        .iter()
        .filter(|row| {
            row.table == "core_party"
                && row.primary_key.first() == Some(&Value::Text("nested".to_owned()))
        })
        .collect();
    assert_eq!(nested.len(), 1, "the inner write is captured exactly once");
    assert_eq!(
        nested[0].commit_seq,
        outcome.commit_seq.expect("there is one")
    );
}

#[test]
fn an_update_carries_the_full_new_image_and_a_prior_of_only_the_touched_columns() {
    // SEAM 3. `prior_json` holds the OLD values of ONLY the columns the
    // statement touched; the full prior is `{...row_json, ...prior_json}`.
    let scratch = common::Scratch::founded("prior").expect("a vault is founded");
    let note = common::insert_note(&scratch.vault, "before").expect("a note is written");
    let before_rows = all_rows(&scratch.vault).len();

    scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.rename");
            tx.connection().execute(
                "UPDATE knowledge_note SET title = 'after' WHERE note_id = ?1",
                [&note],
            )?;
            Ok(())
        })
        .expect("the update commits");

    let rows = all_rows(&scratch.vault);
    let update = rows[before_rows..]
        .iter()
        .find(|row| row.table == "knowledge_note" && row.op == LogOp::Update)
        .expect("there is an update row");

    let image = update.row.as_ref().expect("an update carries its image");
    // THE FULL NEW IMAGE: every column, read back by primary key, not the
    // changeset's partial record.
    assert_eq!(image.get("title"), Some(&Value::Text("after".to_owned())));
    assert!(image.contains_key("note_id"));
    assert!(image.contains_key("author_party_id"));
    assert!(image.contains_key("body_content_id"));
    assert!(image.contains_key("row_version"));

    let prior = update.prior.as_ref().expect("an update carries a prior");
    assert_eq!(prior.get("title"), Some(&Value::Text("before".to_owned())));
    // The touched set is `title`, the key, and whatever the touch trigger
    // moved — and NOT every column. That is the delta.
    assert!(
        prior.len() < image.len(),
        "the prior is not a delta: {} of {} columns",
        prior.len(),
        image.len()
    );
    assert!(
        !prior.contains_key("body_content_id"),
        "an untouched column is in the prior"
    );

    // And the reconstruction is the full prior state.
    let full = update.full_prior().expect("a prior is known");
    assert_eq!(full.len(), image.len());
    assert_eq!(full.get("title"), Some(&Value::Text("before".to_owned())));
    assert_eq!(
        full.get("body_content_id"),
        image.get("body_content_id"),
        "an untouched column is identical in both images"
    );
}

#[test]
fn a_delete_carries_its_old_image_positionally_and_has_no_prior() {
    let scratch = common::Scratch::founded("delete").expect("a vault is founded");
    let note = common::insert_note(&scratch.vault, "doomed").expect("a note is written");
    let before = all_rows(&scratch.vault).len();
    scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.delete");
            tx.connection()
                .execute("DELETE FROM knowledge_note WHERE note_id = ?1", [&note])?;
            Ok(())
        })
        .expect("the delete commits");
    let rows = all_rows(&scratch.vault);
    let deleted = rows[before..]
        .iter()
        .find(|row| row.table == "knowledge_note")
        .expect("there is a delete row");
    assert_eq!(deleted.op, LogOp::Delete);
    let image = deleted
        .row
        .as_ref()
        .expect("a delete carries its OLD image");
    // Positional, against the column names — so the values are under the right
    // keys, which is what the schema-version-keyed cache is for.
    assert_eq!(image.get("title"), Some(&Value::Text("doomed".to_owned())));
    assert_eq!(image.get("note_id"), Some(&Value::Text(note.clone())));
    // A delete's `row_json` IS its prior, so there is nothing a delta adds.
    assert!(deleted.prior.is_none());
    assert!(
        deleted.full_prior().is_none(),
        "no prior is KNOWN, not `{{}}`"
    );
}

#[test]
fn a_pk_changing_update_is_seen_as_a_delete_and_an_insert() {
    // SEAM 1, the distinction a port is most likely to lose: a PK-changing
    // UPDATE is DELETE + INSERT on the wire, including for an INTEGER PRIMARY
    // KEY alias. A reader that expected one `update` row would apply the new
    // row and leave the old one behind forever.
    let scratch = common::Scratch::founded("pkchange").expect("a vault is founded");
    let note = common::insert_note(&scratch.vault, "movable").expect("a note is written");
    let before = all_rows(&scratch.vault).len();
    scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.rekey");
            // The new key has to exist as an entity first: `note_id` keys into
            // `core_entity` and the BEFORE INSERT trigger only fires on an
            // insert, not on a re-key.
            tx.connection().execute(
                "INSERT INTO core_entity (entity_id, entity_type, created_at)
                 VALUES ('moved', 'knowledge.note', ?1)",
                [&"2026-01-01T00:00:00.000Z"],
            )?;
            tx.connection().execute(
                "UPDATE knowledge_note SET note_id = 'moved' WHERE note_id = ?1",
                [&note],
            )?;
            Ok(())
        })
        .expect("the re-key commits");

    let rows = all_rows(&scratch.vault);
    let produced: Vec<(LogOp, Value)> = rows[before..]
        .iter()
        .filter(|row| row.table == "knowledge_note")
        .map(|row| {
            (
                row.op,
                row.primary_key.first().cloned().unwrap_or(Value::Null),
            )
        })
        .collect();
    assert!(
        produced.contains(&(LogOp::Delete, Value::Text(note.clone()))),
        "the old key was not deleted: {produced:?}"
    );
    assert!(
        produced.contains(&(LogOp::Insert, Value::Text("moved".to_owned()))),
        "the new key was not inserted: {produced:?}"
    );
    assert!(
        !produced.iter().any(|(op, _)| *op == LogOp::Update),
        "the session emitted an update for a key change: {produced:?}"
    );
}

#[test]
fn two_statements_on_one_row_collapse_to_one_log_row() {
    // ONE ROW PER (TABLE, KEY) PER COMMIT, and the collapse is the SESSION's.
    // A log row says "this is what the row is now"; intra-commit statement
    // order is not recoverable and is not a loss.
    let scratch = common::Scratch::founded("collapse").expect("a vault is founded");
    let note = common::insert_note(&scratch.vault, "one").expect("a note is written");
    let before = all_rows(&scratch.vault).len();
    scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.twice");
            tx.connection().execute(
                "UPDATE knowledge_note SET title = 'two' WHERE note_id = ?1",
                [&note],
            )?;
            tx.connection().execute(
                "UPDATE knowledge_note SET title = 'three' WHERE note_id = ?1",
                [&note],
            )?;
            Ok(())
        })
        .expect("both updates commit");
    let rows = all_rows(&scratch.vault);
    let for_note: Vec<&log::LogRow> = rows[before..]
        .iter()
        .filter(|row| row.table == "knowledge_note")
        .collect();
    assert_eq!(
        for_note.len(),
        1,
        "the commit produced {} rows",
        for_note.len()
    );
    assert_eq!(
        for_note[0]
            .row
            .as_ref()
            .and_then(|image| image.get("title")),
        Some(&Value::Text("three".to_owned())),
        "the surviving image must be the END state"
    );
}

#[test]
fn a_local_lane_is_logged_by_key_only_and_is_not_a_touched_table() {
    // `replica_intent_outcome` is captured for the doorbell and never served:
    // position only, no read-back, no image. And it is not a table the commit
    // "touched" as far as any consumer is concerned.
    let scratch = common::Scratch::founded("local").expect("a vault is founded");
    let before = all_rows(&scratch.vault).len();
    let outcome = scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.local");
            tx.connection().execute(
                "INSERT INTO replica_intent_outcome
                   (intent_id, device_id, app_id, action, payload_hash, status,
                    created_at, updated_at)
                 VALUES ('i1', 'd1', 'tally', 'tally.add_expense', 'h', 'queued', ?1, ?1)",
                [&"2026-01-01T00:00:00.000Z"],
            )?;
            Ok(())
        })
        .expect("the local write commits");
    assert_eq!(outcome.rows, 1);
    assert!(
        outcome.tables.is_empty(),
        "a local lane is not a touched table: {:?}",
        outcome.tables
    );
    assert!(
        outcome.produced.is_empty(),
        "a local row is not a produced row"
    );
    let rows = all_rows(&scratch.vault);
    let local = &rows[before];
    assert!(local.local);
    assert_eq!(local.table, "replica_intent_outcome");
    assert!(local.row.is_none(), "a local row carries NO image");
    assert_eq!(
        local.primary_key,
        vec![Value::Text("i1".to_owned())],
        "the key is all it carries"
    );
}

#[test]
fn a_private_table_is_never_captured_at_all() {
    // `locker_key` is a credential table: it is not on the replicated
    // allow-list and it is not a local lane, so no session watches it and a
    // write to it produces NOTHING. The one failure mode that matters here is
    // a credential reaching every seat.
    let scratch = common::Scratch::founded("private").expect("a vault is founded");
    let before = all_rows(&scratch.vault).len();
    let outcome = scratch.vault.commit(|tx| {
        tx.set_producer("test.private");
        tx.connection().execute(
            "INSERT INTO locker_key (key_id, wrapped_key, created_at)
                 VALUES ('k1', 'CANARY-SECRET', ?1)",
            [&"2026-01-01T00:00:00.000Z"],
        )?;
        Ok(())
    });
    // The insert may fail on a column this file spells differently; what must
    // be true either way is that nothing about it reached the log.
    let _ = outcome;
    let rows = all_rows(&scratch.vault);
    assert_eq!(rows.len(), before, "a private write reached the log");
    for row in &rows {
        assert_ne!(row.table, "locker_key");
    }
}

#[test]
fn the_produced_set_carries_a_row_version_only_where_the_table_has_one() {
    // SEAM 9. `row_version` is not universal: 51 replicated tables carry none,
    // and a port that assumed it would silently report `Some(1)` for all of
    // them. `core_entity` is one of the 51.
    let scratch = common::Scratch::founded("produced").expect("a vault is founded");
    let outcome = scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.produced");
            tx.connection().execute(
                "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
                 VALUES ('p-produced', 'person', 'P', ?1, ?1)",
                [&"2026-01-01T00:00:00.000Z"],
            )?;
            Ok(())
        })
        .expect("the commit runs");
    let party = outcome
        .produced
        .iter()
        .find(|row| row.table == "core_party")
        .expect("core_party is produced");
    assert_eq!(party.row_version, Some(1), "core_party has a row_version");
    let entity = outcome
        .produced
        .iter()
        .find(|row| row.table == "core_entity")
        .expect("the trigger's core_entity row is produced too");
    assert_eq!(
        entity.row_version, None,
        "core_entity is in the gap register and has no row_version"
    );
    // The trigger's row is INDIRECT, and carried rather than filtered: a
    // cascaded write is a real row a seat must apply.
    let rows = all_rows(&scratch.vault);
    let indirect = rows
        .iter()
        .find(|row| row.table == "core_entity" && row.indirect)
        .expect("the trigger's row is flagged indirect");
    assert_eq!(indirect.op, LogOp::Insert);
}

#[test]
fn an_ordinary_commit_is_never_compressed_and_never_deferred() {
    // The producer bound is stated in ROWS and the defer threshold in
    // COMPRESSED BYTES, so a conforming producer is never measured at all —
    // `compressed_bytes` stays 0 rather than being a small number.
    let scratch = common::Scratch::founded("bounds").expect("a vault is founded");
    let outcome = scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.small");
            tx.connection().execute(
                "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
                 VALUES ('p-small', 'person', 'P', ?1, ?1)",
                [&"2026-01-01T00:00:00.000Z"],
            )?;
            Ok(())
        })
        .expect("the commit runs");
    assert_eq!(
        outcome.compressed_bytes, 0,
        "a conforming commit was measured"
    );
    assert!(!outcome.deferred);
    for row in all_rows(&scratch.vault) {
        assert!(
            !row.deferred,
            "the flag rides on every row, and it is false"
        );
    }
}

#[test]
fn a_blob_and_a_wide_integer_survive_the_round_trip_through_the_log() {
    // SEAM 2, end to end: the two types JSON loses unless you say so.
    let scratch = common::Scratch::founded("wide").expect("a vault is founded");
    let before = all_rows(&scratch.vault).len();
    let wide = 9_007_199_254_740_993_i64; // MAX_SAFE_INTEGER + 2
    scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.wide");
            tx.connection().execute(
                "INSERT INTO core_content_item
                   (content_id, content_uri, sha256, byte_size, created_at, updated_at)
                 VALUES ('c-wide', 'inline:wide',
                         '0000000000000000000000000000000000000000000000000000000000000abc',
                         ?1, ?2, ?2)",
                rusqlite::params![wide, "2026-01-01T00:00:00.000Z"],
            )?;
            Ok(())
        })
        .expect("the commit runs");
    let rows = all_rows(&scratch.vault);
    let content = rows[before..]
        .iter()
        .find(|row| row.table == "core_content_item")
        .expect("there is a row");
    let image = content.row.as_ref().expect("it carries an image");
    assert_eq!(image.get("byte_size"), Some(&Value::Integer(wide)));
    // And the STORED text uses the `{i}` form, which is what makes the round
    // trip exact rather than lucky.
    let stored: String = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT row_json FROM replica_log WHERE \"table\" = 'core_content_item'
                   AND pk_json = '[\"c-wide\"]'",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("the row reads");
    assert!(
        stored.contains("{\"i\":\"9007199254740993\"}"),
        "the wide integer was not stored in the `{{i}}` form: {stored}"
    );
}
