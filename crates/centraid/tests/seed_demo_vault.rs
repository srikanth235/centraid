//! THE DEV SEEDER REFUSES A FILE THAT IS ALREADY A VAULT (#1025 S5).
//!
//! `seed-demo-vault` deletes `<dir>/<file>` and its `-wal`, `-shm` and
//! `.bytes` siblings before it founds, because a demo seeded on top of a
//! previous run has counts nobody can predict. Pointed at a gateway's own
//! vault directory — which is one `--file vault.db` away — that deleted the
//! vault a gateway was serving and founded a new one under a new `vault_id` in
//! a directory still named after the old one. It printed `CENTRAID_SEEDED` and
//! looked like a success; a seat then bootstrapped off it and drew the founding
//! state while `MAX(seq)` in the log had gone 1101 → 146.
//!
//! This is the guard, tested through the shipped binary rather than through the
//! function: the refusal has to happen before the removal, and "before" is a
//! property of `main`, not of a helper.

use centraid_api_proto::core_v1 as wire;
use std::process::Command;

/// Run the seeder and hand back `(status code, stderr)`.
fn seed(dir: &std::path::Path, file: &str, extra: &[&str]) -> (Option<i32>, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_seed-demo-vault"))
        .arg(dir)
        .arg("--file")
        .arg(file)
        // The smallest scenario there is: this test is about the guard, not
        // about the corpus, and seeding seven apps to assert one refusal would
        // put photograph bytes in the way of a unit of behaviour.
        .args(["--only", "tasks"])
        .args(extra)
        .output()
        .expect("the seeder binary runs");
    (
        output.status.code(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

/// Found a vault at `path` and answer its id.
fn found(path: &std::path::Path) -> String {
    let vault = centraid_vault::Vault::create(path).expect("a vault is founded");
    vault.found("Someone's Vault", "Owner").expect("founded");
    let id = vault
        .vault_id()
        .expect("it reads")
        .expect("a founded vault has an id");
    vault.close().expect("it closes");
    id
}

#[test]
fn the_seeder_refuses_a_file_that_already_holds_a_vault_and_names_it() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let path = dir.path().join("vault.db");
    let vault_id = found(&path);

    let (code, complaint) = seed(dir.path(), "vault.db", &[]);
    assert_eq!(code, Some(2), "the seeder did not refuse: {complaint}");
    // BY NAME. The id is what tells a caller which vault they were about to
    // lose; the path is what tells them how they got there.
    assert!(
        complaint.contains(&vault_id),
        "the refusal did not name the vault it found: {complaint}"
    );
    assert!(
        complaint.contains("vault.db"),
        "the refusal did not name the file: {complaint}"
    );
    assert!(
        complaint.contains("--force"),
        "the refusal offered no way past: {complaint}"
    );

    // AND THE VAULT IS STILL THERE, whole, with the id it had. This is the
    // assertion the defect would have failed: the removal runs before the
    // founding, so a guard that fired too late would leave no file at all.
    let vault = centraid_vault::Vault::open(&path).expect("the vault is still a vault");
    assert_eq!(
        vault.vault_id().expect("reads"),
        Some(vault_id),
        "the refused run changed the vault's identity anyway"
    );
    vault.close().expect("it closes");
}

/// A FILE THAT IS NOT A VAULT IS NOT A REFUSAL. An empty file left by an
/// aborted run — and a path that does not exist at all — is exactly what this
/// tool is for, and a guard that refused those would have made the seeder
/// unusable rather than safe.
#[test]
fn the_seeder_still_seeds_an_empty_directory_and_a_file_that_is_not_a_vault() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let (code, complaint) = seed(dir.path(), "demo.db", &[]);
    assert_eq!(code, Some(0), "a fresh directory was refused: {complaint}");

    let leftover = dir.path().join("aborted.db");
    std::fs::write(&leftover, b"not a database").expect("written");
    let (code, complaint) = seed(dir.path(), "aborted.db", &[]);
    assert_eq!(
        code,
        Some(0),
        "a file that is not a vault was refused: {complaint}"
    );
}

/// `--force` IS THE WAY PAST, and it says so on the way through: a caller who
/// meant it gets a line naming what they overwrote.
#[test]
fn force_overwrites_a_vault_and_says_which_one() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let path = dir.path().join("vault.db");
    let vault_id = found(&path);

    let (code, said) = seed(dir.path(), "vault.db", &["--force"]);
    assert_eq!(code, Some(0), "--force was refused anyway: {said}");
    assert!(
        said.contains(&vault_id),
        "--force overwrote a vault without naming it: {said}"
    );
    // A NEW VAULT, which is what `--force` asked for. The old id is gone and
    // the caller was told so before it went.
    let vault = centraid_vault::Vault::open(&path).expect("the seeded vault opens");
    assert_ne!(
        vault.vault_id().expect("reads"),
        Some(vault_id),
        "--force left the old vault in place, so it did nothing"
    );
    vault.close().expect("it closes");
}

/// THE FILE IT NAMES IS THE WHOLE VAULT, on its own (#1020 wave A).
///
/// `Vault::apply_pragmas` sets `wal_autocheckpoint = 0` and
/// `SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE`, so a vault that is merely closed keeps
/// every row this binary wrote in its `-wal` — the seeder left a 4 KB file
/// beside a 19 MB sidecar. `mobile/scripts/demo-vault.sh` then copied the
/// database and dropped the sidecars, as it must (they belong to the copy), and
/// the simulator opened a vault with nothing in it. Nothing refused anything
/// anywhere along that path, which is why this is asserted on the ARTIFACT
/// rather than on a call: `Handle::close_file` is what makes it true today, and
/// the claim that matters is that a copy of the `.db` alone carries the rows.
#[test]
fn the_seeded_file_carries_its_rows_without_its_sidecars() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let (code, complaint) = seed(dir.path(), "seeded.sqlite3", &[]);
    assert_eq!(code, Some(0), "the seeder did not succeed: {complaint}");

    // THE COPY IS THE TEST. A `-wal` of zero length would prove the checkpoint
    // ran; opening a copy made the way the placement script makes one proves
    // the thing a member would see.
    let elsewhere = tempfile::tempdir().expect("a second temp dir");
    let copy = elsewhere.path().join("placed.sqlite3");
    std::fs::copy(dir.path().join("seeded.sqlite3"), &copy).expect("the database file copies");

    let vault = centraid_vault::Vault::open(&copy).expect("the copy opens as a vault");
    let id = vault
        .vault_id()
        .expect("it reads")
        .expect("a copy of a seeded vault still holds its `core_vault` row");
    assert!(!id.is_empty(), "the copied vault has no id");
    vault.close().expect("it closes");
}

/// Run the seeder over ONE app's scenario and hand back the file it wrote.
///
/// A second runner rather than a parameter on [`seed`]: that one exists to
/// exercise the refusal and deliberately seeds the smallest scenario there is,
/// and widening it would make three tests about a guard depend on which apps a
/// fourth one happens to need.
fn seed_only(dir: &std::path::Path, file: &str, only: &str) -> std::path::PathBuf {
    let output = Command::new(env!("CARGO_BIN_EXE_seed-demo-vault"))
        .arg(dir)
        .args(["--file", file])
        .args(["--only", only])
        .output()
        .expect("the seeder binary runs");
    assert!(
        output.status.success(),
        "the seeder did not succeed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    dir.join(file)
}

/// THE DOCS TILE'S TRAILING META COLUMN HAS SOMETHING IN IT (#1029).
///
/// Home's Docs tile is a ruled row with a size in the `annot` role at its
/// trailing edge, and on the simulator that column was blank on every row. The
/// cause was not the seed — `core.add_document` has always written the
/// `core_content_item.byte_size` the bytes actually are — but the DOOR: there
/// was no way for a caller to ask for a size, so the one honest thing the shell
/// could put in `TileBody.Docs.Row.size` was the empty string. Nothing failed.
///
/// So this is asserted through the door the tile reads, over the artifact the
/// placement script places, in the shape `HomeReads.READS` sends: a `.sqlite3`
/// copied WITHOUT its sidecars, the `home.docs` statement, and the appended
/// column after the three the read names.
///
/// **The sizes are the seed's own.** This test asserts that each is a real
/// phrase about real bytes, never which phrase — a demo corpus whose documents
/// change length would otherwise fail a test about the tile.
#[test]
fn every_seeded_document_carries_a_size_the_docs_tile_can_draw() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let seeded = seed_only(dir.path(), "demo.sqlite3", "docs");

    // THE COPY IS THE TEST, for the reason the sidecar test above gives: the
    // vault a member opens is the one `mobile/scripts/demo-vault.sh` placed,
    // which is this file alone.
    let elsewhere = tempfile::tempdir().expect("a second temp dir");
    let placed = elsewhere.path().join("placed.sqlite3");
    std::fs::copy(&seeded, &placed).expect("the database file copies");

    let handle = centraid_core::Core::open(centraid_core::CoreConfig::new(&placed))
        .expect("the placed vault opens");
    // `HomeReads.READS`' docs entry, spelled here rather than shared: the shell
    // is Kotlin and this is the wire, and the only thing that keeps them
    // honest about each other is that both are the contract's own words.
    let request = wire::Request {
        kind: Some(wire::request::Kind::Page(wire::PageRequest {
            query: Some(wire::PageQuery {
                name: "home.docs".to_owned(),
                select: vec![
                    "document_id".to_owned(),
                    "title".to_owned(),
                    "updated_at".to_owned(),
                ],
                from: "core_document".to_owned(),
                r#where: None,
                bind: Vec::new(),
                order: Some(wire::PageOrder {
                    sort_column: "updated_at".to_owned(),
                    pk_column: "document_id".to_owned(),
                    descending: true,
                }),
                with_held_thumbnail: false,
                with_note_body: false,
                with_document_size: true,
            }),
            limit: 200,
            after: None,
        })),
    };
    let response = handle.call(&request).expect("the docs page answers");
    let Some(wire::response::Kind::Page(page)) = response.kind else {
        panic!("the door answered something that is not a page");
    };
    assert!(
        !page.rows.is_empty(),
        "the docs scenario seeded no documents at all"
    );
    for row in &page.rows {
        // THE APPENDED COLUMN RIDES AFTER THE THREE THE READ NAMED, always in
        // the same place — the positional contract the shell counts past its
        // own `select` list to reach.
        assert_eq!(row.values.len(), 4, "the size column did not ride along");
        let title = match row.values[1].kind.as_ref() {
            Some(wire::value::Kind::Text(text)) => text.clone(),
            other => panic!("a document's title is text, got {other:?}"),
        };
        let said = match row.values[3].kind.as_ref() {
            Some(wire::value::Kind::Text(text)) => text.clone(),
            // THIS IS THE DEFECT, and it is what the assertion is for: a NULL
            // here is the blank column the tile drew, and it would reach the
            // phone looking exactly like a document nobody has the bytes of.
            other => panic!("`{title}` has no size the tile can draw: {other:?}"),
        };
        assert!(
            !said.is_empty(),
            "`{title}` reported an empty size, which the tile draws as nothing"
        );
        // A PHRASE ABOUT REAL BYTES. The unit is the vault's and the number is
        // the document's, so what is asserted is that a member is told
        // something — never the exact count, which moves with the corpus.
        let (count, unit) = said
            .split_once(' ')
            .unwrap_or_else(|| panic!("`{title}` said `{said}`, which is not a count and a unit"));
        assert!(
            ["bytes", "byte", "KB", "MB", "GB"].contains(&unit),
            "`{title}` said `{said}`, whose unit is not one the core composes"
        );
        assert!(
            count.chars().next().is_some_and(|first| first.is_ascii_digit()),
            "`{title}` said `{said}`, which does not begin with a number"
        );
        assert_ne!(
            said, "0 bytes",
            "`{title}` reported no bytes at all, and a seeded document has some"
        );
    }
}
