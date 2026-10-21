//! The doctor, and the schema renderer, over files made on the spot.
//!
//! The model's own checks (kinds, edges, delete rules, the index) are
//! `crates/vault/tests/commitments.rs`; this crate only opens, renders and asks
//! the two engine-level soundness questions.

use centraid_ontology::scratch::scratch_dir;
use centraid_ontology::{
    Vault, ddl_fixture, format_doctor_report, schema_objects_of, vault_doctor,
};

fn file_with(sql: &str) -> (std::path::PathBuf, Vault) {
    let dir = scratch_dir();
    std::fs::create_dir_all(&dir).expect("a directory");
    let path = dir.join("vault.db");
    let connection = rusqlite::Connection::open(&path).expect("a file");
    connection.execute_batch(sql).expect("the schema");
    drop(connection);
    let vault = Vault::open(&path).expect("it opens");
    (dir, vault)
}

#[test]
fn a_sound_file_is_clean() {
    let (dir, vault) = file_with(
        "CREATE TABLE parent (id TEXT PRIMARY KEY) STRICT;
         CREATE TABLE child (id TEXT PRIMARY KEY, parent TEXT REFERENCES parent(id)) STRICT;
         INSERT INTO parent VALUES ('p'); INSERT INTO child VALUES ('c', 'p');",
    );
    let report = vault_doctor(&vault).expect("the doctor runs");
    assert!(report.ok, "{report:?}");
    assert!(format_doctor_report(&report).contains("clean"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_dangling_key_is_one_line_per_violation() {
    let (dir, vault) = file_with(
        "CREATE TABLE parent (id TEXT PRIMARY KEY) STRICT;
         CREATE TABLE child (id TEXT PRIMARY KEY, parent TEXT REFERENCES parent(id)) STRICT;
         PRAGMA foreign_keys = OFF;
         INSERT INTO child VALUES ('c', 'nobody');",
    );
    let report = vault_doctor(&vault).expect("the doctor runs");
    assert!(!report.ok);
    assert_eq!(report.foreign_key_violations.len(), 1);
    assert!(format_doctor_report(&report).contains("references parent"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn the_schema_renders_in_dependency_free_reading_order_and_skips_the_planners_statistics() {
    let (dir, vault) = file_with(
        "CREATE TABLE b (id TEXT PRIMARY KEY) STRICT;
         CREATE TABLE a (id TEXT PRIMARY KEY) STRICT;
         CREATE INDEX a_by_id ON a(id);
         ANALYZE;",
    );
    let objects = schema_objects_of(vault.connection()).expect("reads");
    assert!(
        objects
            .iter()
            .all(|object| !object.name.starts_with("sqlite_stat"))
    );
    let text = ddl_fixture(&vault).expect("renders");
    let at = |needle: &str| text.find(needle).unwrap_or_else(|| panic!("{needle}"));
    // Ordered by type then name: the index, then the tables a, b.
    assert!(at("-- index a_by_id") < at("-- table a on a"));
    assert!(at("-- table a on a") < at("-- table b on b"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_missing_file_is_a_typed_refusal() {
    assert!(matches!(
        Vault::open(scratch_dir().join("nothing.db")),
        Err(centraid_ontology::OntologyError::Missing { .. })
    ));
}
