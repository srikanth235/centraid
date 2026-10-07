//! RUNG TEN OVER A FILE WRITTEN BEFORE IT
//! ([#1080](https://github.com/srikanth235/centraid/issues/1080)).
//!
//! A vault at rung nine holds the old backup plane's index — rung three's range
//! tables and rung four's blob custody — with rows in them, because a phone
//! that backed up under that plane wrote them. Rung ten drops all four, and the
//! claim is three things:
//!
//! 1. **the four tables and their indexes are gone**, rows and all;
//! 2. **the climbed file and a freshly founded one are the same schema**,
//!    object for object and SQL for SQL, so a phone that upgraded and a phone
//!    that was set up today hold one shape;
//! 3. **no foreign key dangles**: `foreign_key_check` is empty, the placement
//!    rows' reference into custody having gone with both tables.

mod common;

use std::collections::BTreeMap;

use centraid_vault::Vault;
use centraid_vault::migrations::{BACKUP_INDEX_SQL, BLOB_CUSTODY_SQL};

const DROPPED: [&str; 8] = [
    "backup_base_range",
    "backup_base_range_by_hash",
    "backup_blob_custody",
    "backup_blob_custody_by_role",
    "backup_blob_placement",
    "backup_blob_placement_by_object",
    "backup_object_range",
    "backup_object_range_by_object",
];

/// Every named object's SQL, keyed by `(type, name)`.
fn schema_of(connection: &rusqlite::Connection) -> BTreeMap<(String, String), String> {
    connection
        .prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL")
        .expect("the schema reads")
        .query_map([], |row| Ok(((row.get(0)?, row.get(1)?), row.get(2)?)))
        .expect("the schema reads")
        .collect::<rusqlite::Result<_>>()
        .expect("the schema reads")
}

#[test]
fn rung_ten_drops_the_backup_index_and_the_climbed_file_is_a_fresh_one() {
    let fresh = common::Scratch::founded("rung-ten-fresh").expect("a vault is founded");
    let fresh_schema = fresh
        .vault
        .read(|connection| Ok(schema_of(connection)))
        .expect("the fresh schema reads");
    assert!(
        DROPPED
            .iter()
            .all(|name| !fresh_schema.keys().any(|(_, found)| found == name)),
        "a vault founded today holds none of the old plane's tables"
    );

    let dir = tempfile::tempdir().expect("a scratch directory");
    let path = dir.path().join("vault.db");
    {
        let old = Vault::create(&path).expect("a vault is founded");
        old.found("Test", "Test Owner").expect("founded");
        old.close().expect("closed");
    }
    // WIND THE FILE BACK TO RUNG NINE: rungs three and four's tables come back
    // with the rows the old plane wrote into them, a placement row pointing at
    // its custody row included.
    {
        let raw = rusqlite::Connection::open(&path).expect("the file opens");
        raw.execute_batch("PRAGMA foreign_keys = ON;")
            .expect("foreign keys");
        raw.execute_batch(BACKUP_INDEX_SQL)
            .expect("rung three's tables come back");
        raw.execute_batch(BLOB_CUSTODY_SQL)
            .expect("rung four's tables come back");
        let h = "ab".repeat(32);
        let object = "cd".repeat(32);
        raw.execute_batch(common::UNDO_RUNG_ELEVEN)
            .expect("rung eleven's chat leaves");
        raw.execute_batch(&format!(
            "BEGIN;
             INSERT INTO backup_object_range
               (plaintext_hash, object_name, object_bytes, plaintext_bytes, created_at)
             VALUES ('{h}', '{object}', 4096, 4096, '2026-09-01T00:00:00Z');
             INSERT INTO backup_base_range
               (generation, range_index, byte_offset, byte_length, plaintext_hash, object_name)
             VALUES ('{generation}', 0, 0, 4096, '{h}', '{object}');
             INSERT INTO backup_blob_custody
               (plaintext_hash, file_key, plaintext_bytes, blob_role, created_at)
             VALUES ('{h}', zeroblob(32), 4096, 'original', '2026-09-01T00:00:00Z');
             INSERT INTO backup_blob_placement
               (plaintext_hash, part_index, object_name, byte_offset, byte_length)
             VALUES ('{h}', 0, '{object}', 0, 4096);
             PRAGMA user_version = 9;
             COMMIT;",
            generation = "0".repeat(32),
        ))
        .expect("the rung-nine file is written");
    }

    // THE REAL PATH: `Vault::open` sees rung nine, snapshots, and climbs.
    let migrated = Vault::open(&path).expect("the file climbs rung ten");
    assert_eq!(migrated.schema_version(), centraid_vault::head_version());
    let (schema, orphans) = migrated
        .read(|connection| {
            let orphans: i64 = connection.query_row(
                "SELECT COUNT(*) FROM pragma_foreign_key_check",
                [],
                |row| row.get(0),
            )?;
            Ok((schema_of(connection), orphans))
        })
        .expect("the climbed file reads");

    for name in DROPPED {
        assert!(
            !schema.keys().any(|(_, found)| found == name),
            "`{name}` survived rung ten"
        );
    }
    assert_eq!(orphans, 0, "no foreign key dangles after the drop");
    let differences: Vec<String> = fresh_schema
        .keys()
        .chain(schema.keys())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .filter(|key| fresh_schema.get(*key) != schema.get(*key))
        .map(|(kind, name)| format!("{kind} `{name}`"))
        .collect();
    assert_eq!(
        differences,
        Vec::<String>::new(),
        "the climbed file and a founded one are one schema"
    );
    assert!(schema.len() > 500, "not vacuous: {} objects", schema.len());
}
