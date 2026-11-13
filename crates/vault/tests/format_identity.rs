//! A vault file names its format ([#1146](https://github.com/srikanth235/centraid/issues/1146), D3):
//! a new `application_id` and a digest of the schema, both checked when a file is opened. There is
//! no compatibility with a file of the model before [#1135](https://github.com/srikanth235/centraid/issues/1135)
//! (R-FP-10): it is refused with a sentence, never migrated and never opened by guesswork.

use centraid_vault::Vault;

/// The `application_id` the model before #1135 wrote (`CEN1`).
const EARLIER_APPLICATION_ID: i64 = 0x4345_4e31;

/// A founded vault's file, closed and checkpointed so the `.db` alone is the vault, in a scratch
/// directory of its own.
fn founded_file() -> (std::path::PathBuf, std::path::PathBuf) {
    let dir = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&dir).expect("a directory");
    let file = dir.join("vault.db");
    let vault = Vault::create(&file).expect("a vault");
    vault.found("Test", "Owner").expect("founded");
    vault.finish().expect("closes");
    (dir, file)
}

/// Change the file underneath, as a plain SQLite connection would.
fn tamper(file: &std::path::Path, sql: &str) {
    let connection = rusqlite::Connection::open(file).expect("opens as a plain file");
    connection.execute_batch(sql).expect("tampers");
}

fn refusal(file: &std::path::Path) -> String {
    match Vault::open(file) {
        Ok(_) => panic!("the file was opened"),
        Err(error) => error.to_string(),
    }
}

#[test]
fn a_file_of_the_earlier_model_is_refused_with_a_sentence() {
    let (dir, file) = founded_file();
    tamper(
        &file,
        &format!("PRAGMA application_id = {EARLIER_APPLICATION_ID}"),
    );
    let said = refusal(&file);
    assert!(
        said.contains("made by an earlier version of Centraid that this one cannot open"),
        "{said}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_file_whose_schema_is_not_this_versions_is_refused_with_a_sentence() {
    let (dir, file) = founded_file();
    tamper(&file, "CREATE TABLE intruder (x TEXT)");
    let said = refusal(&file);
    assert!(
        said.contains("does not match this version of Centraid"),
        "{said}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_file_that_is_not_a_vault_at_all_is_still_not_a_vault() {
    let (dir, file) = founded_file();
    tamper(&file, "PRAGMA application_id = 7");
    let said = refusal(&file);
    assert!(said.contains("is not a Centraid vault"), "{said}");
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------------------------
// #1191 V15, V16, V21: a migration at open, no copy beside the vault, a damaged file
// ---------------------------------------------------------------------------------------------

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use centraid_vault::clock::{Clock as _, FixedClock, Ids as _, SeededIds};
use centraid_vault::stage::{self, Stage};

/// A file below the head of the ladder: tagged as a vault, at rung 0, so `Vault::open` migrates it.
fn lower_rung_file(dir: &std::path::Path) -> std::path::PathBuf {
    let file = dir.join("vault.db");
    let lower = rusqlite::Connection::open(&file).expect("a file");
    lower
        .pragma_update(None, "application_id", centraid_vault::APPLICATION_ID)
        .expect("tagged");
    lower
        .pragma_update(None, "journal_mode", "wal")
        .expect("wal");
    file
}

#[test]
fn a_vault_opened_through_a_migration_has_foreign_keys_and_its_clock() {
    let dir = centraid_ontology::scratch::scratch_dir().join("migrated");
    std::fs::create_dir_all(&dir).expect("a directory");
    let file = lower_rung_file(&dir);
    let clock = Arc::new(FixedClock::at(1_800_000_000_000));
    let vault = Vault::open_with(
        &file,
        Box::new(Arc::clone(&clock)),
        Box::new(SeededIds::new("rung")),
    )
    .expect("the lower file opens, migrated");
    let keys: i64 = vault
        .read(|c| Ok(c.query_row("PRAGMA foreign_keys", [], |r| r.get(0))?))
        .expect("reads");
    assert_eq!(keys, 1, "foreign keys survive the migration");
    // A dangling reference is refused: the migration did not leave them off.
    let dangling = vault.commit(|tx| {
        tx.connection().execute(
            "INSERT INTO edge (from_id, rel, to_id, created_at) VALUES ('nobody', 'about', 'nobody', ?1)",
            [clock.now_text()],
        )?;
        Ok(())
    });
    assert!(dangling.is_err(), "a dangling reference was accepted");
    // The injected clock and id source are the ones that stamp.
    let founded = vault.found("Home", "Ada").expect("founds");
    assert_eq!(founded.self_id, SeededIds::new("rung").next());
    let created: String = vault
        .read(|c| Ok(c.query_row("SELECT created_at FROM vault", [], |r| r.get(0))?))
        .expect("reads");
    assert_eq!(created, clock.now_text());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_migration_leaves_no_plaintext_copy_of_the_vault() {
    let dir = centraid_ontology::scratch::scratch_dir().join("no-copy");
    std::fs::create_dir_all(&dir).expect("a directory");
    // What an earlier build left beside a vault it migrated, and a vault that holds a known note.
    let old = dir.join("snapshots");
    std::fs::create_dir_all(&old).expect("a directory");
    std::fs::write(
        old.join("snapshot-0123456789abcdef.db.gz"),
        b"a plaintext copy",
    )
    .expect("a copy");
    let file = lower_rung_file(&dir);
    let vault = Vault::open(&file).expect("migrates");
    vault.found("Home", "Ada").expect("founds");
    vault
        .commit(|tx| {
            tx.connection().execute(
                "INSERT INTO entity (id, kind, title, created_at, updated_at)
                 VALUES ('n1', 'note', 'quokka-title', '2026-03-01T09:00:00.000Z', '2026-03-01T09:00:00.000Z')",
                [],
            )?;
            tx.connection()
                .execute("INSERT INTO note (id, body) VALUES ('n1', 'quokka-body')", [])?;
            Ok(())
        })
        .expect("a note");
    vault.finish().expect("closes");
    // The directory holds the vault (and its sidecars) and nothing else: no `.gz`, no copy, no
    // `snapshots/`, and no other file holds the note's bytes.
    let mut others = Vec::new();
    for entry in std::fs::read_dir(&dir).expect("lists") {
        let path = entry.expect("an entry").path();
        let name = path
            .file_name()
            .expect("a name")
            .to_string_lossy()
            .into_owned();
        assert!(!name.ends_with(".gz"), "a compressed copy: {name}");
        if name.starts_with("vault.db") {
            continue;
        }
        others.push(name.clone());
        if path.is_file() {
            let bytes = std::fs::read(&path).expect("reads");
            assert!(
                !bytes.windows(11).any(|w| w == b"quokka-body"),
                "{name} holds the note's words"
            );
        }
    }
    assert!(others.is_empty(), "files beside the vault: {others:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

static QUICK_CHECKS: AtomicUsize = AtomicUsize::new(0);

fn count_quick_checks(stage: Stage) -> std::io::Result<()> {
    if stage == Stage::QuickChecked {
        QUICK_CHECKS.fetch_add(1, Ordering::SeqCst);
    }
    Ok(())
}

#[test]
fn open_of_a_damaged_vault_is_a_typed_error() {
    let (dir, file) = founded_file();
    // A healthy vault opens with exactly one quick check.
    QUICK_CHECKS.store(0, Ordering::SeqCst);
    stage::set_hook(Some(count_quick_checks));
    Vault::open(&file).expect("opens").finish().expect("closes");
    stage::set_hook(None);
    assert_eq!(QUICK_CHECKS.load(Ordering::SeqCst), 1);
    // A damaged page is `Damaged`, not a panic or a later query error.
    let mut bytes = std::fs::read(&file).expect("reads");
    let page = 4096;
    assert!(
        bytes.len() > 6 * page,
        "the founded file has pages to damage"
    );
    for byte in &mut bytes[4 * page..5 * page] {
        *byte = 0xA5;
    }
    std::fs::write(&file, bytes).expect("writes");
    match Vault::open(&file) {
        Err(centraid_vault::VaultError::Damaged { .. }) => {}
        Err(other) => panic!("expected Damaged, got {other}"),
        Ok(_) => panic!("a damaged vault opened"),
    }
    let _ = std::fs::remove_dir_all(&dir);
}
