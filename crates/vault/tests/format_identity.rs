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
