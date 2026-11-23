//! The vault's pages read through `sqlite_dbpage` on a pinned connection, with no plaintext
//! copy of the vault on disk (#1191 B11, `contracts/backup/spike-page-read.md`).

mod common;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use centraid_vault::pagesource::{PinError, PinnedPages, live_pins};
use common::{Scratch, insert_note, plant_canary};
use rusqlite::{Connection, OpenFlags};

/// Grow a vault with `rounds` commits so it holds many pages.
fn grow(vault: &centraid_vault::Vault, rounds: usize, tag: &str) {
    for round in 0..rounds {
        insert_note(vault, &format!("{tag} {round} {}", "x".repeat(900))).expect("commits");
    }
}

fn path_of(scratch: &Scratch) -> PathBuf {
    scratch.join("vault.db")
}

#[test]
fn this_build_compiles_the_page_table_in() {
    // The flag is `LIBSQLITE3_FLAGS` under `[env]` in `.cargo/config.toml`. Without it the table
    // is absent, and so is the compile option.
    let connection = Connection::open_in_memory().expect("opens");
    let options: Vec<String> = connection
        .prepare("PRAGMA compile_options")
        .expect("prepares")
        .query_map([], |row| row.get(0))
        .expect("queries")
        .collect::<rusqlite::Result<_>>()
        .expect("rows");
    assert!(
        options.iter().any(|option| option == "ENABLE_DBPAGE_VTAB"),
        "SQLITE_ENABLE_DBPAGE_VTAB is not compiled in; `.cargo/config.toml` must set LIBSQLITE3_FLAGS \
         = \"-DSQLITE_ENABLE_DBPAGE_VTAB\" and no environment may replace it: {options:?}"
    );
}

/// Pages that SQLite's online backup changes on page 1: the file change counter, the schema cookie
/// and version-valid-for. The copy is written in rollback-journal mode, the live file is WAL.
fn page_one_counter(offset: usize) -> bool {
    (24..28).contains(&offset) || (40..44).contains(&offset) || (92..96).contains(&offset)
}

#[test]
fn page_read_equals_online_backup() {
    let scratch = Scratch::founded("pages").expect("a vault");
    grow(&scratch.vault, 40, "grow");
    let path = path_of(&scratch);

    let mut pinned = PinnedPages::begin(&path).expect("pins");
    let pages = pinned.page_count();
    assert!(
        pages > 16,
        "a vault of {pages} pages tiles into several ranges"
    );

    // The online-backup copy, taken from its own pin, in small steps with a commit between each.
    let copy_path = scratch.join("online-backup.db");
    {
        let live =
            Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).expect("opens");
        live.execute_batch("BEGIN").expect("pins");
        live.query_row("SELECT count(*) FROM sqlite_schema", [], |row| {
            row.get::<_, i64>(0)
        })
        .expect("reads");
        let mut destination = Connection::open(&copy_path).expect("opens");
        let backup = rusqlite::backup::Backup::new(&live, &mut destination).expect("backs up");
        let mut commits = 0;
        loop {
            match backup.step(32).expect("steps") {
                rusqlite::backup::StepResult::Done => break,
                rusqlite::backup::StepResult::More => {
                    insert_note(&scratch.vault, &format!("mid-copy {commits}")).expect("commits");
                    commits += 1;
                }
                other => panic!("the copy stopped at {other:?}"),
            }
        }
        assert!(commits > 0, "a commit landed while the copy ran");
    }
    // More commits land while the pin reads. The pin does not see them.
    let copy = std::fs::read(&copy_path).expect("reads the copy");
    let page_size = usize::try_from(pinned.page_size()).expect("size");
    assert_eq!(copy.len() as u64, pinned.len(), "the same number of pages");

    let mut seen = Vec::new();
    let mut committed_between = 0;
    let hash = pinned
        .hash_with(&mut |index, bytes| {
            insert_note(&scratch.vault, &format!("between ranges {index}"))?;
            committed_between += 1;
            seen.extend_from_slice(bytes);
            Ok(())
        })
        .expect("reads every range");
    assert!(committed_between > 1);
    assert_eq!(seen.len(), copy.len());
    assert_eq!(
        hash,
        *blake3::hash(&seen).as_bytes(),
        "db_hash is BLAKE3 over the pages in order"
    );

    let mut differing = BTreeSet::new();
    for (page, (read, copied)) in seen
        .chunks(page_size)
        .zip(copy.chunks(page_size))
        .enumerate()
    {
        for (offset, (a, b)) in read.iter().zip(copied).enumerate() {
            if a != b {
                assert!(
                    page == 0 && page_one_counter(offset),
                    "page {} differs at byte {offset}, which is not a page 1 counter",
                    page + 1
                );
                differing.insert(offset);
            }
        }
    }
    // The ranges count statements, not pages: one per range.
    assert_eq!(pinned.reads(), pinned.range_count());
    pinned.end().expect("ends");
}

/// Every file under `dir` that is not the vault's own three, as (path, bytes).
fn others(dir: &Path, vault_name: &str) -> Vec<(PathBuf, Vec<u8>)> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(next) = stack.pop() {
        for entry in std::fs::read_dir(&next).expect("lists") {
            let entry = entry.expect("entry");
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_owned();
            if name == vault_name
                || name == format!("{vault_name}-wal")
                || name == format!("{vault_name}-shm")
            {
                continue;
            }
            out.push((path.clone(), std::fs::read(&path).unwrap_or_default()));
        }
    }
    out
}

#[test]
fn no_plaintext_vault_copy_on_disk() {
    const CANARY: &str = "CANARY-page-source-9f3a1c-do-not-write-me-anywhere";
    let scratch = Scratch::founded("noplain").expect("a vault");
    plant_canary(&scratch.vault, CANARY).expect("plants");
    grow(&scratch.vault, 40, "fill");
    let path = path_of(&scratch);
    let page_size;
    let page_hashes: BTreeSet<[u8; 32]>;
    {
        let mut probe = PinnedPages::begin(&path).expect("pins");
        page_size = usize::try_from(probe.page_size()).expect("size");
        let mut set = BTreeSet::new();
        probe
            .hash_with(&mut |_, bytes| {
                for page in bytes.chunks(page_size) {
                    if page.iter().any(|b| *b != 0) {
                        set.insert(*blake3::hash(page).as_bytes());
                    }
                }
                Ok(())
            })
            .expect("reads");
        page_hashes = set;
        probe.end().expect("ends");
    }
    assert!(page_hashes.len() > 16);

    // A snapshot: pin, read every range with a writer committing between them, find damage.
    let mut pinned = PinnedPages::begin(&path).expect("pins");
    let mut scans = 0;
    pinned
        .hash_with(&mut |index, _| {
            insert_note(&scratch.vault, &format!("writer {index}"))?;
            // Everything the app can write besides the vault's own three files, MID-snapshot.
            for (file, bytes) in others(scratch.dir(), "vault.db") {
                assert!(
                    !bytes.windows(CANARY.len()).any(|w| w == CANARY.as_bytes()),
                    "{} holds the canary in the clear",
                    file.display()
                );
                for page in bytes.chunks(page_size).filter(|p| p.len() == page_size) {
                    assert!(
                        !page_hashes.contains(blake3::hash(page).as_bytes()),
                        "{} holds a page of the vault",
                        file.display()
                    );
                }
            }
            scans += 1;
            Ok(())
        })
        .expect("reads");
    assert_eq!(scans, pinned.range_count());
    pinned.quick_check().expect("the vault is whole");
    pinned.end().expect("ends");
    // After the snapshot too: nothing was left.
    assert!(
        others(scratch.dir(), "vault.db")
            .iter()
            .all(|(_, b)| !b.windows(CANARY.len()).any(|w| w == CANARY.as_bytes()))
    );
}

#[test]
fn a_read_that_fails_part_way_releases_the_pin() {
    let scratch = Scratch::founded("fault").expect("a vault");
    grow(&scratch.vault, 30, "wal");
    let path = path_of(&scratch);
    let mut pinned = PinnedPages::begin(&path).expect("pins");
    // Commits after the pin leave frames in the WAL that the pin holds back.
    grow(&scratch.vault, 5, "after the pin");
    let failed = pinned.hash_with(&mut |index, _| {
        if index == 2 {
            Err(centraid_vault::backup::PlaneError::Invariant {
                context: "the disk filled".to_owned(),
            })
        } else {
            Ok(())
        }
    });
    assert!(failed.is_err());
    drop(pinned);
    // With the pin gone a checkpoint reaches the end of the log: it was not left holding it.
    let writer = Connection::open(&path).expect("opens");
    let (busy, log, checkpointed): (i64, i64, i64) = writer
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .expect("checkpoints");
    assert_eq!(
        (busy, log, checkpointed),
        (0, 0, 0),
        "the log was truncated, so no reader held it"
    );
}

#[test]
fn a_damaged_page_is_found_on_the_pin() {
    let scratch = Scratch::founded("damage").expect("a vault");
    grow(&scratch.vault, 20, "dmg");
    let path = path_of(&scratch);
    // Fold the WAL into the file, then damage a table b-tree leaf in it.
    Connection::open(&path)
        .expect("opens")
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            row.get::<_, i64>(0)
        })
        .expect("checkpoints");
    let mut bytes = std::fs::read(&path).expect("reads");
    let page_size = {
        let pinned = PinnedPages::begin(&path).expect("pins");
        let size = usize::try_from(pinned.page_size()).expect("size");
        pinned.end().expect("ends");
        size
    };
    let leaf = (1..bytes.len() / page_size)
        .find(|page| bytes[page * page_size] == 0x0d)
        .expect("a table leaf");
    // The cell count of a leaf: a number no page could hold.
    bytes[leaf * page_size + 3] = 0xff;
    bytes[leaf * page_size + 4] = 0xff;
    std::fs::write(&path, &bytes).expect("damages");
    let pinned = PinnedPages::begin(&path).expect("the pin itself opens: dbpage verifies nothing");
    assert!(
        pinned.quick_check().is_err(),
        "the check finds the damaged page on the same pin"
    );
}

#[test]
fn a_vault_that_grows_after_the_pin_still_yields_the_pinned_pages() {
    let scratch = Scratch::founded("grows").expect("a vault");
    grow(&scratch.vault, 20, "before");
    let path = path_of(&scratch);
    let mut pinned = PinnedPages::begin(&path).expect("pins");
    let (pages, len, ranges) = (pinned.page_count(), pinned.len(), pinned.range_count());
    // The vault more than doubles while the pin reads.
    grow(&scratch.vault, 60, "after");
    let mut bytes = 0;
    let mut seen = 0;
    pinned
        .hash_with(&mut |_, range| {
            bytes += range.len() as u64;
            seen += 1;
            Ok(())
        })
        .expect("reads");
    assert_eq!((bytes, seen), (len, ranges), "exactly the pinned count");
    assert_eq!(pinned.page_count(), pages);
    pinned.end().expect("ends");
    let fresh = PinnedPages::begin(&path).expect("pins");
    assert!(fresh.page_count() > pages, "the vault did grow");
}

#[test]
fn a_vault_that_is_not_in_wal_mode_is_refused_with_a_typed_error() {
    let dir = tempfile::tempdir().expect("dir");
    let path = dir.path().join("rollback.db");
    let connection = Connection::open(&path).expect("opens");
    connection
        .execute_batch(
            "PRAGMA journal_mode = DELETE; CREATE TABLE t (a); INSERT INTO t VALUES (1);",
        )
        .expect("makes");
    drop(connection);
    assert!(matches!(PinnedPages::begin(&path), Err(PinError::NotWal)));
    assert_eq!(live_pins(), 0, "a refused pin is not counted");
}

/// A stand-in gateway: every call it receives asserts no pin is alive on the calling thread.
struct Gateway {
    calls: std::cell::Cell<u32>,
}

impl Gateway {
    fn exists(&self) {
        assert_eq!(live_pins(), 0, "a gateway was called while a pin was alive");
        self.calls.set(self.calls.get() + 1);
    }
}

#[test]
fn the_pin_never_spans_a_gateway_call() {
    // The shape a caller takes: under the pin read, hash, compare and seal; end it; only then
    // talk to a gateway. `live_pins` is what a caller's own gateway-facing code asserts on.
    let scratch = Scratch::founded("pinned").expect("a vault");
    grow(&scratch.vault, 20, "pin");
    let gateway = Gateway {
        calls: std::cell::Cell::new(0),
    };
    let mut pinned = PinnedPages::begin(&path_of(&scratch)).expect("pins");
    assert_eq!(live_pins(), 1);
    pinned.hash_with(&mut |_, _| Ok(())).expect("reads");
    pinned.end().expect("ends");
    assert_eq!(live_pins(), 0);
    gateway.exists();
    // A failed pass releases the pin too: nothing is left alive to span the next call.
    let mut again = PinnedPages::begin(&path_of(&scratch)).expect("pins");
    let failed = again.hash_with(&mut |_, _| {
        Err(centraid_vault::backup::PlaneError::Invariant {
            context: "stopped".to_owned(),
        })
    });
    assert!(failed.is_err());
    drop(again);
    gateway.exists();
    assert_eq!(gateway.calls.get(), 2);
}

#[test]
#[should_panic(expected = "a gateway was called while a pin was alive")]
fn a_gateway_call_under_a_live_pin_is_caught() {
    let scratch = Scratch::founded("caught").expect("a vault");
    let gateway = Gateway {
        calls: std::cell::Cell::new(0),
    };
    let _pinned = PinnedPages::begin(&path_of(&scratch)).expect("pins");
    gateway.exists();
}
