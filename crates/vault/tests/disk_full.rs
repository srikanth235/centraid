//! Disk full is a typed answer, and the commit that hit it did not happen.
//!
//! ## Two mechanisms, because the two paths run out of room differently
//!
//! **The log insert** exhausts SQLite PAGES, so `PRAGMA max_page_count` makes
//! it return `SQLITE_FULL` deterministically on a scratch file — aimed at
//! exactly the statement in question, which a full filesystem cannot be.
//!
//! **The snapshot build never exhausts pages at all** (D-1020-D1-17). The
//! brief proposed capping the copy's page count; measured, that cannot work:
//! every step after the copy only ever FREES pages (drops, a truncation, a
//! VACUUM), and SQLite clamps `max_page_count` UP to the current size, so
//! there is nothing for a cap to refuse. What a build can run out of is DISK,
//! at the two file writes — the `VACUUM INTO` and the gzip. So the fault
//! redirects the copy to `/dev/full`, which returns ENOSPC on every write and
//! makes SQLite report a genuine `SQLITE_FULL` (verified: code 13,
//! `database or disk is full`). Privilege-free and deterministic on Linux.
//!
//! `VaultError::DiskFull` is classified on SQLite's PRIMARY CODE, never on the
//! message: `disk I/O error` and `database or disk is full` are both things
//! SQLite says and only one of them is this. And the classification lives in
//! `From<rusqlite::Error>`, not in a helper a call site has to remember —
//! because a handler's own `?` is the commonest way one reaches a caller.

mod common;

use centraid_vault::log;

/// The page count a scratch vault is capped at, chosen so the schema fits and
/// a handful of rows do not.
fn cap_pages(vault: &centraid_vault::Vault, pages: i64) {
    vault
        .commit(|tx| {
            tx.connection()
                .pragma_update(None, "max_page_count", pages)?;
            Ok(())
        })
        .expect("the cap is set");
}

fn page_count(vault: &centraid_vault::Vault) -> i64 {
    vault
        .read(|connection| Ok(connection.query_row("PRAGMA page_count", [], |row| row.get(0))?))
        .expect("the count reads")
}

#[test]
fn a_full_disk_at_the_log_insert_rolls_the_whole_commit_back() {
    let scratch = common::Scratch::founded("diskfull").expect("a vault is founded");
    let before = log::log_state(&scratch.vault).expect("the state reads");
    let rows_before: i64 = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row("SELECT COUNT(*) FROM replica_log", [], |row| row.get(0))?)
        })
        .expect("the count reads");
    let parties_before: i64 = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row("SELECT COUNT(*) FROM core_party", [], |row| row.get(0))?)
        })
        .expect("the count reads");

    // One page of headroom: the schema is already written, so the very next
    // allocation fails — and the log insert is an allocation, because the row
    // images are the biggest thing the commit writes.
    cap_pages(&scratch.vault, page_count(&scratch.vault) + 1);

    let mut error = None;
    // Enough rows that the log insert cannot fit in one page. The first few
    // commits may succeed; the assertion is about the one that does not.
    for index in 0..200 {
        let outcome = scratch.vault.commit(|tx| {
            tx.set_producer("test.full");
            for inner in 0..20 {
                tx.connection().execute(
                    "INSERT INTO core_party
                       (party_id, kind, display_name, sort_name, created_at, updated_at)
                     VALUES (?1, 'person', ?2, ?2, ?3, ?3)",
                    rusqlite::params![
                        format!("full-{index}-{inner}"),
                        // A long value, so the image is worth a page.
                        "X".repeat(400),
                        "2026-01-01T00:00:00.000Z"
                    ],
                )?;
            }
            Ok(())
        });
        if let Err(failure) = outcome {
            error = Some(failure);
            break;
        }
    }

    let error = error.expect("the cap was never reached");
    // A TYPED ANSWER. The product renders "your disk is full", and a caller
    // that had to grep a message for it would eventually stop.
    assert!(
        error.is_disk_full(),
        "the error is not DiskFull: {error} ({error:?})"
    );
    assert!(error.to_string().contains("disk is full"));

    // THE COMMIT IS ROLLED BACK WHOLE. Not "mostly": the position did not
    // move, so no seat can be told about a commit that did not happen.
    let after = log::log_state(&scratch.vault).expect("the state reads");
    let (rows_after, parties_after): (i64, i64) = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT (SELECT COUNT(*) FROM replica_log), (SELECT COUNT(*) FROM core_party)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .expect("the counts read");

    // The failing commit contributed nothing, and `commit_seq` counts only
    // commits that landed.
    assert_eq!(
        after.commit_seq,
        commits_in_log(&scratch.vault),
        "commit_seq {} does not match the {} commits in the log",
        after.commit_seq,
        commits_in_log(&scratch.vault)
    );
    assert!(after.commit_seq >= before.commit_seq);
    assert!(rows_after >= rows_before);
    assert!(parties_after >= parties_before);
    // Every party that IS there has its full log row: no half commit.
    let orphans: i64 = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT COUNT(*) FROM core_party p
                  WHERE p.party_id LIKE 'full-%'
                    AND NOT EXISTS (
                      SELECT 1 FROM replica_log l
                       WHERE l.\"table\" = 'core_party'
                         AND l.pk_json = json_array(p.party_id))",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("the count reads");
    assert_eq!(orphans, 0, "a row landed with no log row: half a commit");

    // AND THE SESSIONS WERE ABANDONED. A next commit, after the cap is
    // lifted, must not replay the rolled-back rows.
    scratch
        .vault
        .commit(|tx| {
            tx.connection()
                .pragma_update(None, "max_page_count", 1_073_741_823_i64)?;
            Ok(())
        })
        .expect("the cap lifts");
    let recovered = scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.after");
            tx.connection().execute(
                "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
                 VALUES ('after-full', 'person', 'After', ?1, ?1)",
                [&"2026-01-01T00:00:00.000Z"],
            )?;
            Ok(())
        })
        .expect("the vault still works");
    // Only the new row and its entity row, not a replay of the 20 that failed.
    assert_eq!(
        recovered.rows, 2,
        "the rolled-back commit replayed: {} rows",
        recovered.rows
    );
}

fn commits_in_log(vault: &centraid_vault::Vault) -> i64 {
    vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT COUNT(DISTINCT commit_seq) FROM replica_log",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("the count reads")
}

#[test]
fn a_full_disk_during_a_snapshot_build_leaves_no_partial_artifact() {
    let scratch = common::Scratch::founded("snapfull").expect("a vault is founded");
    common::insert_note(&scratch.vault, "something to copy").expect("a note is written");
    let dir = scratch.join("snap");
    std::fs::create_dir_all(&dir).expect("the directory is made");

    // A REAL ENOSPC at the copy. `/dev/full` accepts an open and fails every
    // write with ENOSPC, which SQLite reports as `SQLITE_FULL` — the same code
    // a genuinely full filesystem produces, and the same code the log-insert
    // test produces by a different route.
    scratch
        .vault
        .inject_fault(Some(centraid_vault::Fault::CopyTo("/dev/full")));

    let outcome = centraid_vault::build_snapshot(&scratch.vault, &dir);
    let error = outcome.expect_err("a capped copy must fail");
    assert!(
        error.is_disk_full(),
        "the snapshot failure is not DiskFull: {error}"
    );

    // NO PARTIAL ARTIFACT. Nothing under a final name, and the scratch files
    // are gone too — the rename is the publication, so a `.building` left
    // behind would be a file the next build has to clear anyway.
    let leftovers: Vec<String> = std::fs::read_dir(&dir)
        .expect("the directory reads")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(
        leftovers,
        Vec::<String>::new(),
        "the failed build left {leftovers:?}"
    );

    // AND THE LIVE VAULT IS STILL A VAULT. The copy is where the work happens,
    // so a failure there cannot have sanitised the gateway's own file.
    let state = log::log_state(&scratch.vault).expect("the state reads");
    assert!(state.commit_seq > 0);
    let privates: i64 = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'access_device_secret'",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("the count reads");
    assert_eq!(privates, 1, "the live vault lost a private table");

    scratch.vault.inject_fault(None);
    let head = centraid_vault::build_snapshot(&scratch.vault, &dir).expect("the retry builds");
    assert!(dir.join(&head.name).exists());
}
