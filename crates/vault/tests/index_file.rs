//! THE INDEX FILE IS DERIVED DATA, SO IT IS NEVER TRUSTED ON THE FILE'S WORD (#1214, A15): a missing
//! one, one that belongs to another vault, and one written under another tokenizer are founded
//! again and owe every entity; a foreign database at its path is refused and left exactly as it was.
//! And the backup plane can ask which file it is, to keep it out of a snapshot.

mod common;

use std::path::{Path, PathBuf};

use centraid_vault::Vault;
use common::index::{assert_equals_a_rebuild, drain, dump_file, index_path};
use rusqlite::Connection;

/// A founded vault with a few notes, closed, in a directory of its own.
fn closed_vault() -> PathBuf {
    let dir = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&dir).expect("a directory");
    let vault = Vault::create(dir.join("vault.db")).expect("a vault");
    vault.found("Test", "Owner").expect("founded");
    for (title, body) in [
        ("Alpha", "apples"),
        ("Beta", "bananas"),
        ("Gamma", "cherries"),
    ] {
        common::insert_note_with(&vault, title, body).expect("a note");
    }
    vault.finish().expect("closes");
    dir
}

fn remove_index(dir: &Path) {
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", index_path(dir).display()));
    }
}

fn counts(vault: &Vault) -> (i64, i64) {
    vault
        .read(|c| {
            Ok((
                c.query_row("SELECT count(*) FROM search_owed", [], |r| r.get(0))?,
                c.query_row("SELECT count(*) FROM entity", [], |r| r.get(0))?,
            ))
        })
        .expect("counts")
}

fn state(dir: &Path) -> Option<(String, i64, String)> {
    let raw = Connection::open(index_path(dir)).expect("opens");
    raw.query_row(
        "SELECT self_id, tokenizer, built_at FROM index_state",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .ok()
}

/// Open, see everything owed, drain, and hold the result to a rebuild's.
fn rebuilt_on_open(dir: &Path, why: &str) {
    let vault = Vault::open(dir.join("vault.db")).expect("opens");
    let (owed, entities) = counts(&vault);
    assert_eq!(
        owed, entities,
        "{why}: the file is founded again and owes every entity"
    );
    let steps = drain(&vault);
    assert!(steps >= 1);
    assert_eq!(counts(&vault).0, 0, "{why}: nothing is owed after the pass");
    let own = vault.self_id().expect("asks").expect("a self");
    vault.finish().expect("closes");
    assert_equals_a_rebuild(dir, why);
    let (self_id, tokenizer, _) = state(dir).expect("the new file says what it is a copy of");
    assert_eq!(self_id, own);
    assert_eq!(tokenizer, centraid_vault::index::TOKENIZER_VERSION);
}

#[test]
fn a_missing_index_file_is_rebuilt_not_trusted() {
    let dir = closed_vault();
    remove_index(&dir);
    rebuilt_on_open(&dir, "a missing file");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_index_file_of_another_vault_is_rebuilt_not_trusted() {
    let dir = closed_vault();
    {
        let raw = Connection::open(index_path(&dir)).expect("opens");
        raw.execute("UPDATE index_state SET self_id = 'someone-else'", [])
            .expect("claims another owner");
        // And a row only the other vault has.
        raw.execute(
            "INSERT INTO search (rowid, title, body) VALUES (99999, 'strangers', 'words')",
            [],
        )
        .expect("a stranger's row");
    }
    rebuilt_on_open(&dir, "another vault's file");
    assert!(
        !dump_file(&index_path(&dir))
            .iter()
            .any(|l| l.contains("strangers")),
        "nothing of the other vault's rows survives"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_index_file_written_under_another_tokenizer_is_rebuilt_not_trusted() {
    let dir = closed_vault();
    {
        let raw = Connection::open(index_path(&dir)).expect("opens");
        raw.execute(
            "UPDATE index_state SET tokenizer = ?1",
            [centraid_vault::index::TOKENIZER_VERSION + 1],
        )
        .expect("another version");
    }
    rebuilt_on_open(&dir, "another tokenizer's file");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_current_file_is_trusted_and_a_reopen_owes_nothing() {
    let dir = closed_vault();
    let vault = Vault::open(dir.join("vault.db")).expect("opens");
    assert_eq!(
        counts(&vault).0,
        0,
        "a file that says it is ours owes nothing"
    );
    vault.finish().expect("closes");
    assert!(state(&dir).is_some());
    assert_equals_a_rebuild(&dir, "after a plain reopen");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_database_that_is_not_ours_at_the_index_path_is_refused_and_left_unchanged() {
    let dir = closed_vault();
    remove_index(&dir);
    let index = index_path(&dir);
    {
        let plain = Connection::open(&index).expect("a plain file");
        plain
            .pragma_update(None, "application_id", 0x5a5a_5a5a_i64)
            .expect("a tag");
        plain
            .execute_batch("CREATE TABLE theirs (x TEXT); INSERT INTO theirs VALUES ('mine');")
            .expect("a table");
    }
    let before = std::fs::read(&index).expect("bytes");
    let before_vault = std::fs::read(dir.join("vault.db")).expect("bytes");
    let refused = match Vault::open(dir.join("vault.db")) {
        Ok(_) => panic!("opened over a database that is not ours"),
        Err(error) => error.to_string(),
    };
    assert!(refused.contains("is not a Centraid vault"), "{refused}");
    assert_eq!(
        std::fs::read(&index).expect("bytes"),
        before,
        "left unchanged"
    );
    assert_eq!(
        std::fs::read(dir.join("vault.db")).expect("bytes"),
        before_vault,
        "the vault was not written either: no queue was owed to a file that is refused"
    );
    let sidecars: Vec<_> = std::fs::read_dir(&dir)
        .expect("lists")
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("vault.index.db") && name != "vault.index.db")
        .collect();
    assert!(
        sidecars.is_empty(),
        "no sidecar was made beside it: {sidecars:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_index_file_and_its_sidecars_are_named_so_the_backup_plane_can_leave_them_out() {
    let vault_path = Path::new("/data/member/vault.db");
    let is = |name: &str| {
        centraid_vault::index::is_index_file(vault_path, &Path::new("/data/member").join(name))
    };
    for name in [
        "vault.index.db",
        "vault.index.db-wal",
        "vault.index.db-shm",
        "vault.index.db-journal",
        "vault.index.db.founding",
        "vault.index.db.founding-wal",
    ] {
        assert!(is(name), "{name} is the index file's");
    }
    for name in [
        "vault.db",
        "vault.db-wal",
        "vault.db-shm",
        "vault.bytes",
        "vault.index.db.bak",
        "other.index.db",
    ] {
        assert!(!is(name), "{name} is not");
    }
    assert!(
        !centraid_vault::index::is_index_file(vault_path, Path::new("/elsewhere/vault.index.db")),
        "the same name in another directory is not this vault's"
    );
    assert_eq!(
        centraid_vault::index::index_file_for(vault_path),
        Path::new("/data/member/vault.index.db")
    );
    // On a real directory the names the vault keeps split into the vault's and the index's.
    let dir = closed_vault();
    let vault = Vault::open(dir.join("vault.db")).expect("opens");
    common::insert_note_with(&vault, "Delta", "dates").expect("a note");
    let mut index_side = Vec::new();
    let mut vault_side = Vec::new();
    for entry in std::fs::read_dir(&dir).expect("lists").flatten() {
        let path = entry.path();
        if centraid_vault::index::is_index_file(&dir.join("vault.db"), &path) {
            index_side.push(entry.file_name().to_string_lossy().into_owned());
        } else {
            vault_side.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    assert!(
        index_side.contains(&"vault.index.db".to_owned()),
        "{index_side:?}"
    );
    assert!(
        vault_side.contains(&"vault.db".to_owned()),
        "{vault_side:?}"
    );
    assert!(
        vault_side.iter().all(|name| !name.contains("index")),
        "{vault_side:?}"
    );
    vault.finish().expect("closes");
    let _ = std::fs::remove_dir_all(&dir);
}
