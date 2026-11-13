//! Disk full is a typed answer, and the commit that hit it did not happen.
//!
//! ## A full disk, caused for real
//!
//! **The log insert** exhausts SQLite PAGES, so `PRAGMA max_page_count` makes
//! it return `SQLITE_FULL` deterministically on a scratch file — aimed at
//! exactly the statement in question, which a full filesystem cannot be.
//!
//! `VaultError::DiskFull` is classified on SQLite's PRIMARY CODE, never on the
//! message: `disk I/O error` and `database or disk is full` are both things
//! SQLite says and only one of them is this. For a Rust write it is
//! `ErrorKind::StorageFull` (ENOSPC). Both classifications live in a `From`,
//! not in a helper a call site has to remember — because a handler's own `?`
//! is the commonest way one reaches a caller.

mod common;

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
    let parties_before: i64 = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row("SELECT COUNT(*) FROM person", [], |row| row.get(0))?)
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
                // A long value, so the row is worth a page.
                common::add_person(
                    tx,
                    &format!("full-{index}-{inner}"),
                    &"X".repeat(400),
                    "2026-01-01T00:00:00.000Z",
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

    // THE COMMIT IS ROLLED BACK WHOLE. Not "mostly": no row of it survived.
    let (rows_after, parties_after): (i64, i64) = scratch
        .vault
        .read(|connection| {
            Ok(
                connection.query_row("SELECT 0, (SELECT COUNT(*) FROM person)", [], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?,
            )
        })
        .expect("the counts read");

    // The failing commit contributed nothing.
    assert!(parties_after >= parties_before);
    assert_eq!(rows_after, 0, "the sentinel column");

    // AND THE NEXT COMMIT IS ITS OWN. After the cap is lifted, a fresh commit
    // must report only what IT wrote — the `update_hook` census is per commit
    // and must not have absorbed the rolled-back one.
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
            common::add_person(tx, "after-full", "After", "2026-01-01T00:00:00.000Z")?;
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

// ---------------------------------------------------------------------------------------------
// Founding and migration (#1191, M6): the disk fills at a named stage; the vault is absent or
// whole, and the error is typed.
// ---------------------------------------------------------------------------------------------

use centraid_vault::stage::{self, Stage};
use centraid_vault::{Vault, VaultError};

fn full_at_the_flush(stage: Stage) -> std::io::Result<()> {
    if stage == Stage::FoundingCheckpointed {
        return Err(std::io::Error::from(std::io::ErrorKind::StorageFull));
    }
    Ok(())
}

fn full_in_a_rung(stage: Stage) -> std::io::Result<()> {
    if stage == Stage::RungWritten {
        return Err(std::io::Error::from(std::io::ErrorKind::StorageFull));
    }
    Ok(())
}

#[test]
fn a_full_disk_while_founding_leaves_no_vault_and_no_side_file_and_says_so() {
    let dir = centraid_ontology::scratch::scratch_dir().join("full-founding");
    std::fs::create_dir_all(&dir).expect("a directory");
    let path = dir.join("vault.db");
    stage::set_hook(Some(full_at_the_flush));
    let outcome = Vault::create(&path);
    stage::set_hook(None);
    match outcome {
        Err(VaultError::DiskFull { .. }) => {}
        Err(other) => panic!("expected DiskFull, got {other}"),
        Ok(_) => panic!("a founding that hit a full disk succeeded"),
    }
    assert!(!path.exists(), "no vault is left at the path");
    let leftovers: Vec<_> = std::fs::read_dir(&dir)
        .expect("lists")
        .map(|entry| entry.expect("an entry").file_name())
        .collect();
    assert!(
        leftovers.is_empty(),
        "nothing is left behind: {leftovers:?}"
    );
    // Once there is room it founds, and opens.
    Vault::create(&path)
        .expect("founds again")
        .close()
        .expect("closes");
    Vault::open(&path).expect("opens").close().expect("closes");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_full_disk_in_a_migration_at_open_changes_nothing_and_the_file_opens_when_there_is_room() {
    let dir = centraid_ontology::scratch::scratch_dir().join("full-migration");
    std::fs::create_dir_all(&dir).expect("a directory");
    let path = dir.join("vault.db");
    {
        // A file below the head of the ladder: tagged, empty, at rung 0.
        let lower = centraid_vault::rusqlite::Connection::open(&path).expect("a file");
        lower
            .pragma_update(
                None,
                "application_id",
                centraid_vault::format::APPLICATION_ID,
            )
            .expect("tagged");
        lower
            .pragma_update(None, "journal_mode", "wal")
            .expect("wal");
    }
    stage::set_hook(Some(full_in_a_rung));
    let outcome = Vault::open(&path);
    stage::set_hook(None);
    match outcome {
        Err(VaultError::DiskFull { .. }) => {}
        Err(other) => panic!("expected DiskFull, got {other}"),
        Ok(_) => panic!("a migration that hit a full disk succeeded"),
    }
    let tables: i64 = {
        let connection = centraid_vault::rusqlite::Connection::open(&path).expect("reads");
        connection
            .query_row("SELECT COUNT(*) FROM sqlite_schema", [], |row| row.get(0))
            .expect("counts")
    };
    assert_eq!(tables, 0, "the rung that failed wrote nothing");
    Vault::open(&path)
        .expect("with room, the same file migrates and opens")
        .close()
        .expect("closes");
    let _ = std::fs::remove_dir_all(&dir);
}
