//! What the index file holds, read the way a test can compare: every posting of both search tables
//! (the `instance` view of `fts5vocab`: term, row, column, offset), every point of `geo`, and the
//! word list; and the REFERENCE a full rebuild gives, from a copy of the vault's rows alone.
#![allow(dead_code)]

use std::collections::BTreeSet;
use std::path::Path;

use centraid_vault::Vault;
use rusqlite::{Connection, OpenFlags};

/// One line per posting, point and word, so two dumps compare with `assert_eq!` and a difference
/// names itself.
pub type Dump = BTreeSet<String>;

/// The index file beside a vault's directory.
pub fn index_path(dir: &Path) -> std::path::PathBuf {
    dir.join("vault.index.db")
}

/// Read an index file (read-only: it never changes what it reads).
pub fn dump_file(path: &Path) -> Dump {
    let raw = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("the index file opens");
    raw.execute_batch(
        "CREATE VIRTUAL TABLE temp.si USING fts5vocab(main, search, instance);
         CREATE VIRTUAL TABLE temp.pi USING fts5vocab(main, search_past, instance);",
    )
    .expect("the vocab views");
    let mut out = Dump::new();
    for (table, label) in [("si", "search"), ("pi", "past")] {
        let mut statement = raw
            .prepare(&format!(
                "SELECT term, doc, col, \"offset\" FROM temp.{table}"
            ))
            .expect("prepares");
        let rows = statement
            .query_map([], |row| {
                Ok(format!(
                    "{label}|{}|{}|{}|{}",
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?
                ))
            })
            .expect("queries");
        for row in rows {
            out.insert(row.expect("a row"));
        }
    }
    let mut geo = raw
        .prepare("SELECT n, min_lon, max_lon, min_lat, max_lat FROM geo")
        .expect("prepares");
    for row in geo
        .query_map([], |row| {
            Ok(format!(
                "geo|{}|{}|{}|{}|{}",
                row.get::<_, i64>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, f64>(3)?,
                row.get::<_, f64>(4)?
            ))
        })
        .expect("queries")
    {
        out.insert(row.expect("a row"));
    }
    out
}

/// The word list of an index file.
pub fn words_file(path: &Path) -> BTreeSet<String> {
    let raw = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("the index file opens");
    let mut statement = raw
        .prepare("SELECT word FROM search_word")
        .expect("prepares");
    statement
        .query_map([], |row| row.get::<_, String>(0))
        .expect("queries")
        .collect::<rusqlite::Result<_>>()
        .expect("rows")
}

/// The live index file's postings.
pub fn dump(dir: &Path) -> Dump {
    dump_file(&index_path(dir))
}

/// Run the idle pass to the end; returns how many batches it took.
pub fn drain(vault: &Vault) -> usize {
    let mut steps = 0;
    loop {
        steps += 1;
        if vault.reindex_owed().expect("a batch") == 0 {
            return steps;
        }
    }
}

/// WHAT A FULL REBUILD GIVES, from the vault's rows alone: a copy of `vault.db` with no index file
/// beside it, opened (which founds the index again and owes it every entity) and drained. The
/// live vault and its index file are not touched.
pub fn reference(dir: &Path) -> (Dump, BTreeSet<String>) {
    let work = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&work).expect("a directory");
    let copy = work.join("vault.db");
    {
        let raw =
            Connection::open_with_flags(dir.join("vault.db"), OpenFlags::SQLITE_OPEN_READ_ONLY)
                .expect("opens the live vault");
        raw.execute("VACUUM INTO ?1", [copy.to_string_lossy().as_ref()])
            .expect("copies the rows");
    }
    let vault = Vault::open(&copy).expect("the copy opens and founds its index");
    assert!(vault.index_owed().expect("asks"), "a copy owes everything");
    drain(&vault);
    assert!(!vault.index_owed().expect("asks"));
    vault.finish().expect("closes");
    let index = work.join("vault.index.db");
    let out = (dump_file(&index), words_file(&index));
    let _ = std::fs::remove_dir_all(&work);
    out
}

/// The live index equals the reference: every posting and point exactly, and the word list as the
/// reference's words plus (only) words an edit left behind, which no row holds and a rebuild drops.
pub fn assert_equals_a_rebuild(dir: &Path, when: &str) {
    let (rebuilt, words) = reference(dir);
    let live = dump(dir);
    assert_eq!(live, rebuilt, "the index differs from a rebuild {when}");
    let kept = words_file(&index_path(dir));
    assert!(
        words.is_subset(&kept),
        "{when}: the word list misses {:?}",
        words.difference(&kept).collect::<Vec<_>>()
    );
}
