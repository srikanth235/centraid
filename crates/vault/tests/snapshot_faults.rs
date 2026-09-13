//! The snapshot pipeline, and what an interrupted build leaves behind.
//!
//! The correctness tests come first and the fault injection after, because a
//! builder that produces the wrong file atomically is worse than one that
//! produces the right file untidily.

mod common;

use centraid_vault::snapshot::{self, Fault, Step};

/// The canary: a credential planted in a private table, recognisable in raw
/// bytes. A test that looked for it through SQLite would only ever see the
/// pages SQLite admits to — and v0's control planted ten of these and found all
/// ten still readable in 4,360 free pages while `sqlite_schema` read clean.
const CANARY: &str = "CANARY-c0ffee-DO-NOT-REPLICATE";

fn founded_with_a_canary(seed: &str) -> common::Scratch {
    let scratch = common::Scratch::founded(seed).expect("a vault is founded");
    common::enrol(&scratch.vault, "canary-device", CANARY).expect("the device enrols");
    common::insert_note(&scratch.vault, "beach holiday").expect("a note is written");
    scratch
}

/// Inflate a gzipped artifact and return both the path and the raw plain bytes.
fn inflate(gz: &std::path::Path, to: &std::path::Path) -> Vec<u8> {
    use flate2::read::GzDecoder;
    use std::io::Read as _;
    let mut decoder = GzDecoder::new(std::fs::File::open(gz).expect("the artifact opens"));
    let mut plain = Vec::new();
    decoder.read_to_end(&mut plain).expect("it inflates");
    std::fs::write(to, &plain).expect("the copy writes");
    plain
}

#[test]
fn the_private_canary_is_absent_from_the_files_bytes() {
    let scratch = founded_with_a_canary("canary");
    // It IS in the live vault's bytes, or the test proves nothing about the
    // snapshot.
    scratch
        .vault
        .read(|connection| {
            connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
            Ok(())
        })
        .expect("the wal folds in");
    assert!(
        snapshot::file_contains(scratch.vault.path(), CANARY.as_bytes()).expect("the file reads"),
        "the canary is not in the live vault either; the test is vacuous"
    );

    let head =
        centraid_vault::build_snapshot(&scratch.vault, &scratch.join("snap")).expect("it builds");
    let artifact = scratch.join("snap").join(&head.name);
    // THE BYTES, gzipped and inflated. Both, because a gzip stream is not a
    // substring search over the plaintext.
    assert!(
        !snapshot::gzipped_contains(&artifact, CANARY.as_bytes()).expect("the artifact reads"),
        "the canary survived into the snapshot's bytes"
    );
    let plain = scratch.join("plain.db");
    let bytes = inflate(&artifact, &plain);
    assert!(
        !bytes
            .windows(CANARY.len())
            .any(|window| window == CANARY.as_bytes()),
        "the canary survived into the inflated snapshot"
    );
}

#[test]
fn no_private_table_and_no_trigger_except_fts_sync_survive() {
    let scratch = founded_with_a_canary("sanitise");
    let head =
        centraid_vault::build_snapshot(&scratch.vault, &scratch.join("snap")).expect("it builds");
    let plain = scratch.join("plain.db");
    inflate(&scratch.join("snap").join(&head.name), &plain);
    let copy = rusqlite::Connection::open(&plain).expect("the copy opens");

    let mut findings: Vec<String> = Vec::new();
    for private in centraid_ontology::registries::private_table_names() {
        let present: i64 = copy
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [private],
                |row| row.get(0),
            )
            .expect("the count reads");
        if present != 0 {
            findings.push(format!("`{private}` is still in the snapshot"));
        }
    }
    assert_eq!(findings.join("\n"), "");

    let mut statement = copy
        .prepare("SELECT name, COALESCE(sql, '') FROM sqlite_master WHERE type = 'trigger'")
        .expect("the query prepares");
    let triggers: Vec<(String, String)> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("the query runs")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("the rows read");
    assert!(
        !triggers.is_empty(),
        "every trigger went, FTS sync included"
    );
    for (name, sql) in &triggers {
        assert!(
            snapshot::mentions_fts_table(sql),
            "`{name}` survived and is not an FTS sync trigger"
        );
    }
    // THE ONE THAT MUST NOT SURVIVE: the touch trigger mints a `row_version`,
    // and a mirror carries the origin's version rather than minting its own —
    // the seat applier is the ONE legitimate bypass of that trigger, and it
    // only works because the trigger is gone.
    assert!(
        !triggers
            .iter()
            .any(|(name, _)| name.ends_with("_touch_updated_at")),
        "a touch trigger survived into the snapshot"
    );
    // The FTS shadow tables are KEPT: dropping them saves 12 MB and then the
    // 57 retained sync triggers fail on the seat's first write.
    let shadows: i64 = copy
        .query_row(
            r"SELECT COUNT(*) FROM sqlite_master
                WHERE type = 'table' AND name LIKE 'fts\_%\_data' ESCAPE '\'",
            [],
            |row| row.get(0),
        )
        .expect("the count reads");
    assert_eq!(shadows, 18, "an FTS shadow table was dropped");
}

#[test]
fn the_log_is_truncated_its_cursor_is_kept_and_the_numbers_come_from_the_copy() {
    let scratch = founded_with_a_canary("numbers");
    let state = centraid_vault::log::log_state(&scratch.vault).expect("the state reads");
    let head =
        centraid_vault::build_snapshot(&scratch.vault, &scratch.join("snap")).expect("it builds");
    // FROM THE COPY. Reading the live vault around a `VACUUM INTO` — which
    // cannot be in a transaction — produced a file whose `replica_meta` carried
    // one epoch under an identity stamped with another, and a restore under
    // live seats could loop.
    assert_eq!(head.epoch, state.epoch);
    assert_eq!(head.seq, state.watermark.seq);
    assert_eq!(head.schema_epoch, state.schema_epoch);
    assert_eq!(
        head.vault_id,
        scratch
            .vault
            .vault_id()
            .expect("the id reads")
            .expect("the vault is founded")
    );

    let plain = scratch.join("plain.db");
    inflate(&scratch.join("snap").join(&head.name), &plain);
    let copy = rusqlite::Connection::open(&plain).expect("the copy opens");
    let (rows, floor, active): (i64, i64, Option<String>) = copy
        .query_row(
            "SELECT (SELECT COUNT(*) FROM replica_log),
                    (SELECT floor_seq FROM replica_meta WHERE singleton = 1),
                    (SELECT active_commit_id FROM replica_meta WHERE singleton = 1)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("the row reads");
    // THE LOG GOES, THE CURSOR STAYS. A bootstrapped seat starts at a real
    // position rather than at zero, which is what makes its first page the
    // rows it is actually missing.
    assert_eq!(rows, 0);
    assert_eq!(floor, state.watermark.seq);
    assert_eq!(active, None);
}

#[test]
fn retained_fts_content_still_answers_and_carries_no_private_text() {
    let scratch = founded_with_a_canary("fts");
    let head =
        centraid_vault::build_snapshot(&scratch.vault, &scratch.join("snap")).expect("it builds");
    let plain = scratch.join("plain.db");
    inflate(&scratch.join("snap").join(&head.name), &plain);
    let copy = rusqlite::Connection::open(&plain).expect("the copy opens");
    // The note's title reached the index through the retained sync trigger,
    // and the index still answers on the copy — which is the whole reason the
    // shadow tables are kept.
    let hits: i64 = copy
        .query_row(
            "SELECT COUNT(*) FROM fts_knowledge_note WHERE fts_knowledge_note MATCH 'beach'",
            [],
            |row| row.get(0),
        )
        .expect("the search runs");
    assert_eq!(hits, 1, "the retained index does not answer");
}

#[test]
fn the_artifact_is_content_addressed_and_the_same_position_names_the_same_file() {
    let scratch = founded_with_a_canary("addressed");
    let first =
        centraid_vault::build_snapshot(&scratch.vault, &scratch.join("a")).expect("it builds");
    let again =
        centraid_vault::build_snapshot(&scratch.vault, &scratch.join("b")).expect("it builds");
    // The NAME is a pure function of the log position, which is what makes a
    // pinned `?seq=` reuse bytes already on disk instead of rebuilding.
    assert_eq!(first.name, again.name);
    assert!(first.name.starts_with("snapshot-"));
    assert!(first.name.ends_with(&format!("-{}.db.gz", first.seq)));
    // The seq is in the name IN THE CLEAR as well as inside the digest,
    // because eviction has to read it back OUT of the name: sorting a
    // directory listing sorts by the digest prefix, and could delete the
    // artifact a phone is downloading.
    assert!(first.name.contains(&first.seq.to_string()));
    assert_eq!(first.digest.len(), 64, "blake3, hex");
    assert!(first.size > 0);
    // Two builds at one position are the same FILE, not merely the same name.
    assert_eq!(
        std::fs::read(scratch.join("a").join(&first.name)).expect("it reads"),
        std::fs::read(scratch.join("b").join(&again.name)).expect("it reads"),
        "the artifact is not reproducible at one position"
    );
    assert_eq!(first.digest, again.digest);
}

#[test]
fn an_interrupted_build_leaves_no_artifact_and_the_next_one_succeeds() {
    // RED FIRST (D-1020-D1-7). v0 had no test that killed a build mid-way:
    // the build-to-`.building` and rename was correct by construction and by
    // nothing else. `Fault::AbortAfter` is that test's hand.
    let scratch = founded_with_a_canary("interrupted");
    let dir = scratch.join("snap");
    // Fold the WAL in first, or the canary is still in the sidecar and the
    // byte-level check below would read a file that never held it.
    scratch
        .vault
        .read(|connection| {
            connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
            Ok(())
        })
        .expect("the wal folds in");
    let live_before = std::fs::read(scratch.vault.path()).expect("the live vault reads");
    assert!(
        snapshot::file_contains(scratch.vault.path(), CANARY.as_bytes()).expect("the file reads"),
        "the canary is not in the live vault; the checks below would be vacuous"
    );

    let steps = [
        Step::Vacuumed,
        Step::Sanitised,
        Step::Numbered,
        Step::Dropped,
        Step::Redacted,
        Step::LogTruncated,
        Step::Compacted,
        Step::Gzipped,
    ];
    for step in steps {
        scratch.vault.inject_fault(Some(Fault::AbortAfter(step)));
        let outcome = centraid_vault::build_snapshot(&scratch.vault, &dir);
        assert!(
            outcome.is_err(),
            "the fault after {step:?} did not stop the build"
        );

        // NO `.db.gz` WITHOUT `.building`. The only thing that ever appears
        // under a final name is a complete file.
        let published: Vec<String> = std::fs::read_dir(&dir)
            .expect("the directory reads")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.ends_with(".db.gz") && !name.contains(".building"))
            .collect();
        assert_eq!(
            published,
            Vec::<String>::new(),
            "the fault after {step:?} published {published:?}"
        );

        // THE LIVE VAULT IS UNTOUCHED. The sanitisation runs entirely on the
        // copy, so a failure part-way cannot have dropped a private table from
        // the gateway's own file.
        let live_now = std::fs::read(scratch.vault.path()).expect("the live vault reads");
        assert_eq!(
            live_now.len(),
            live_before.len(),
            "the live vault changed size after a fault at {step:?}"
        );
        let survived: i64 = scratch
            .vault
            .read(|connection| {
                Ok(connection.query_row(
                    "SELECT COUNT(*) FROM access_device_secret",
                    [],
                    |row| row.get(0),
                )?)
            })
            .expect("the count reads");
        assert_eq!(survived, 1, "the live private table lost a row at {step:?}");
    }

    // THE LIVE VAULT STILL HOLDS THE CANARY after eight interrupted builds:
    // the sanitisation runs entirely on the copy, so a failure part-way cannot
    // have dropped a private table from the gateway's own file.
    scratch
        .vault
        .read(|connection| {
            connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
            Ok(())
        })
        .expect("the wal folds in");
    assert!(
        snapshot::file_contains(scratch.vault.path(), CANARY.as_bytes()).expect("the file reads"),
        "an interrupted build sanitised the LIVE vault"
    );

    // AND THE NEXT BUILD SUCCEEDS. A builder that could not retry after a
    // crash would be worse than one that left a mess: `VACUUM INTO` refuses an
    // existing destination, so the scratch file has to be cleared.
    scratch.vault.inject_fault(None);
    let head = centraid_vault::build_snapshot(&scratch.vault, &dir).expect("the retry builds");
    assert!(dir.join(&head.name).exists());
    assert!(
        !snapshot::gzipped_contains(&dir.join(&head.name), CANARY.as_bytes())
            .expect("the artifact reads"),
        "the retry after eight faults produced an unsanitised artifact"
    );
}

#[test]
fn a_pre_migration_snapshot_goes_beside_the_vault() {
    // THE ONE-SNAPSHOT RULE's third use. The same builder, the same artifact;
    // only the destination differs, and `Vault::open` uses this path before it
    // runs the ladder.
    let scratch = common::Scratch::founded("premigration").expect("a vault is founded");
    let dir = snapshot::pre_migration_dir(scratch.vault.path());
    assert_eq!(dir.parent(), scratch.vault.path().parent());
    let head = centraid_vault::build_snapshot(&scratch.vault, &dir).expect("it builds");
    assert!(dir.join(&head.name).exists());
    // It is the SAME artifact a backup would produce, which is the claim: one
    // builder, three uses.
    let backup =
        centraid_vault::build_snapshot(&scratch.vault, &scratch.join("backup")).expect("it builds");
    assert_eq!(head.digest, backup.digest);
    assert_eq!(head.name, backup.name);
}
