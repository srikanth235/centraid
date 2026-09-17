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

// FOUR TESTS STOOD HERE, AND THEIR SUBJECT IS DELETED (#1029 §1).
//
// `the_private_canary_is_absent_from_the_files_bytes`,
// `no_private_table_and_no_trigger_except_fts_sync_survive`,
// `the_log_is_truncated_its_cursor_is_kept_and_the_numbers_come_from_the_copy`
// and `retained_fts_content_still_answers_and_carries_no_private_text` all
// asserted the SANITISATION a snapshot did on its way to a SEAT: drop every
// private table, drop every trigger but the FTS sync, redact the excluded JSON
// keys, truncate `replica_log` and keep `replica_meta`'s cursor.
//
// There is no seat, so there is no sanitised artifact, and the builder no
// longer does any of it — a snapshot is a compacted copy of the file. The
// private tables are therefore IN the copy, which is exactly #1029's defect B1
// ("the base copy is stored unsealed: a gzipped `VACUUM INTO` copy that
// includes `locker_key` and `access_device_secret`"). The protection is
// SEALING the base, which W3 builds; a `DROP TABLE` that ran for a reader who
// no longer exists was never the protection, and keeping these tests would
// have made it look like one.

#[test]
fn the_artifact_is_content_addressed_and_the_same_position_names_the_same_file() {
    let scratch = founded_with_a_canary("addressed");
    let first =
        centraid_vault::build_snapshot(&scratch.vault, &scratch.join("a")).expect("it builds");
    let again =
        centraid_vault::build_snapshot(&scratch.vault, &scratch.join("b")).expect("it builds");
    // The NAME is a pure function of the artifact's own BYTES. It used to be a
    // function of the log position, which is deleted (#1029 §1); content
    // addressing is what it always meant and is what survives.
    assert_eq!(first.name, again.name);
    assert!(first.name.starts_with("snapshot-"));
    assert!(first.name.ends_with(".db.gz"));
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
        Step::Numbered,
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
