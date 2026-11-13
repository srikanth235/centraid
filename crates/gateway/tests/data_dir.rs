//! THE DATA DIRECTORY'S VERSION (#1191, B1, E13).
//!
//! A gateway's `state.db` carries `application_id` `CGW3` and a `user_version`
//! ladder. A folder an earlier gateway made — protocol 2, no application id —
//! is refused with the owner's sentence and exit code 2, and **its bytes are
//! not touched**: the member moves it aside, or reads it with the old
//! gateway. Nothing is migrated.

use std::process::Command;

use centraid_gateway::server::state::{
    APPLICATION_ID, OLDER_DATA_DIRECTORY, OpenStateError, SqliteState,
};

/// What the folder was made with: the protocol-2 schema, applied the way that
/// gateway applied it (WAL, no application id, `user_version` 0).
fn v2_data_dir() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("a temp dir");
    let connection = rusqlite::Connection::open(dir.path().join("state.db")).expect("opens");
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .expect("wal");
    connection
        .execute_batch(include_str!("fixtures/v2_state_fixture.sql"))
        .expect("the v2 schema and a vault a phone paired");
    drop(connection);
    dir
}

fn gateway(args: &[&str], dir: &std::path::Path) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_centraid-gateway"))
        .args(args)
        .arg("--data-dir")
        .arg(dir)
        .output()
        .expect("runs the gateway")
}

#[test]
fn an_older_gateway_data_directory_is_refused_with_the_sentence() {
    let dir = v2_data_dir();
    let file = dir.path().join("state.db");
    let before = std::fs::read(&file).expect("reads");

    for verb in ["pairings", "serve"] {
        let output = gateway(&[verb], dir.path());
        assert_eq!(output.status.code(), Some(2), "{verb}: exit code 2");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_eq!(stderr.trim(), OLDER_DATA_DIRECTORY, "{verb}: the sentence");
    }
    assert_eq!(
        std::fs::read(&file).expect("reads"),
        before,
        "the file's bytes are unchanged"
    );
    assert!(
        !dir.path().join("state.db-wal").exists() || {
            std::fs::metadata(dir.path().join("state.db-wal"))
                .map(|meta| meta.len() == 0)
                .unwrap_or(true)
        },
        "nothing was written beside it"
    );
}

#[test]
fn the_sentence_is_the_owners_words() {
    assert_eq!(
        OLDER_DATA_DIRECTORY,
        "This data folder was made by an earlier version of the gateway, and this version cannot open it. Nothing was changed. Move the folder aside and start again; every phone will need to pair again."
    );
}

#[test]
fn a_new_folder_is_founded_with_its_id_and_rung_and_reopens() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let file = dir.path().join("state.db");
    drop(SqliteState::open(&file).expect("founds"));
    let connection = rusqlite::Connection::open(&file).expect("opens");
    let id: i32 = connection
        .pragma_query_value(None, "application_id", |row| row.get(0))
        .expect("reads");
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .expect("reads");
    assert_eq!(id, APPLICATION_ID);
    assert_eq!(version, 1);
    drop(connection);
    drop(SqliteState::open(&file).expect("reopens a founded file"));
}

#[test]
fn a_newer_rung_is_refused_and_left_alone() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let file = dir.path().join("state.db");
    drop(SqliteState::open(&file).expect("founds"));
    let connection = rusqlite::Connection::open(&file).expect("opens");
    connection
        .pragma_update(None, "user_version", 9)
        .expect("a later rung");
    drop(connection);
    let before = std::fs::read(&file).expect("reads");
    match SqliteState::open(&file) {
        Err(OpenStateError::Refused(sentence)) => assert_eq!(
            sentence,
            "This gateway's data was written by a newer version of the gateway (rung 9); this one reads rung 1. Update the gateway; nothing was changed."
        ),
        other => panic!("a newer rung was opened: {other:?}"),
    }
    assert_eq!(std::fs::read(&file).expect("reads"), before);
}

#[test]
fn another_programs_database_is_refused_like_an_older_gateways() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let file = dir.path().join("state.db");
    let connection = rusqlite::Connection::open(&file).expect("opens");
    connection
        .execute_batch(include_str!("fixtures/another_program.sql"))
        .expect("another program's file");
    drop(connection);
    assert!(matches!(
        SqliteState::open(&file),
        Err(OpenStateError::Refused(sentence)) if sentence == OLDER_DATA_DIRECTORY
    ));
}

/// Every path under `dir` with its bytes, sorted: the folder as a whole.
fn folder(dir: &std::path::Path) -> Vec<(String, Vec<u8>)> {
    fn walk(root: &std::path::Path, dir: &std::path::Path, into: &mut Vec<(String, Vec<u8>)>) {
        let mut entries: Vec<_> = std::fs::read_dir(dir)
            .expect("reads")
            .flatten()
            .map(|entry| entry.path())
            .collect();
        entries.sort();
        for path in entries {
            let name = path
                .strip_prefix(root)
                .expect("inside")
                .display()
                .to_string();
            if path.is_dir() {
                into.push((format!("{name}/"), Vec::new()));
                walk(root, &path, into);
            } else {
                into.push((name, std::fs::read(&path).expect("reads")));
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out
}

/// R7: A FOLDER THE GATEWAY WILL NOT OPEN IS LEFT EXACTLY AS IT WAS — the file
/// list as well as the bytes. The state is inspected before an identity, a
/// nonce key or an object directory is made beside it, so a `state.db` copied
/// alone into an empty folder is refused without a single new file.
#[test]
fn a_refused_folder_is_byte_identical_including_its_file_list() {
    let dir = v2_data_dir();
    let before = folder(dir.path());
    assert_eq!(
        before.len(),
        1 + usize::from(dir.path().join("state.db-wal").exists())
            + usize::from(dir.path().join("state.db-shm").exists())
    );
    for verb in ["pairings", "serve", "pair", "scrub"] {
        let output = gateway(&[verb], dir.path());
        assert_eq!(output.status.code(), Some(2), "{verb}: exit code 2");
        assert_eq!(folder(dir.path()), before, "{verb} changed the folder");
    }
}
