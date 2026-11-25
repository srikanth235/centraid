//! The founded file's vocabularies (#1214): the lookup tables are fixed (K2), every Rust enum that
//! mirrors one equals its rows (K3), and a vault is founded with its index file beside it (K1).

mod common;

use std::collections::BTreeSet;

use centraid_vault::lookups::{LOOKUP_TABLES, REFUSAL};
use centraid_vault::model::{Kind, Rel};

fn words(scratch: &common::Scratch, sql: &str) -> BTreeSet<String> {
    scratch
        .vault
        .read(|connection| {
            Ok(connection
                .prepare(sql)?
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<BTreeSet<_>>>()?)
        })
        .expect("a read")
}

fn rust_words<'a>(words: impl IntoIterator<Item = &'a str>) -> BTreeSet<String> {
    words.into_iter().map(str::to_owned).collect()
}

// ---------------------------------------------------------------------------------------------
// K2: a lookup row is written only by a migration
// ---------------------------------------------------------------------------------------------

#[test]
fn the_lookup_list_is_the_tables_founding_seeds_beyond_the_three_that_hold_members() {
    let scratch = common::Scratch::empty("lookups_list").expect("a vault");
    let tables = words(
        &scratch,
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
            AND name NOT LIKE '%\\_%' ESCAPE '\\' OR type = 'table' AND name LIKE '%\\_%' ESCAPE '\\'
            AND name NOT LIKE 'sqlite_%'",
    );
    let mut seeded = BTreeSet::new();
    for table in &tables {
        let rows: i64 = scratch
            .vault
            .read(|c| {
                Ok(
                    c.query_row(&format!("SELECT COUNT(*) FROM \"{table}\""), [], |r| {
                        r.get(0)
                    })?,
                )
            })
            .expect("a count");
        if rows > 0 {
            seeded.insert(table.clone());
        }
    }
    // The seeded entities, their concept and container rows are the founding's own members: a
    // member may edit, trash and add to them. Everything else founding seeds is vocabulary.
    for member_table in ["entity", "concept", "container"] {
        assert!(seeded.remove(member_table), "{member_table} is seeded");
    }
    assert_eq!(
        seeded,
        rust_words(LOOKUP_TABLES),
        "the tables founding seeds, beyond the members', are `lookups::LOOKUP_TABLES`"
    );
}

#[test]
fn nothing_writes_a_lookup_table_after_founding() {
    let scratch = common::Scratch::founded("lookups_fixed").expect("a vault");
    for table in LOOKUP_TABLES {
        let first: String = scratch
            .vault
            .read(|c| {
                Ok(c.query_row(
                    &format!("SELECT name FROM pragma_table_info('{table}') ORDER BY cid LIMIT 1"),
                    [],
                    |r| r.get(0),
                )?)
            })
            .expect("a column");
        for (verb, sql) in [
            (
                "insert",
                format!("INSERT INTO {table} SELECT * FROM {table} LIMIT 1"),
            ),
            ("update", format!("UPDATE {table} SET {first} = {first}")),
            ("delete", format!("DELETE FROM {table}")),
        ] {
            let refusal = scratch
                .vault
                .commit(|tx| {
                    tx.connection().execute(&sql, [])?;
                    Ok(())
                })
                .expect_err(&format!("a {verb} of {table} was taken"))
                .to_string();
            assert!(
                refusal.contains(REFUSAL),
                "{verb} of {table} was refused, but not as a fixed lookup: {refusal}"
            );
        }
    }
}

// ---------------------------------------------------------------------------------------------
// K3: every enum that mirrors a lookup equals its rows
// ---------------------------------------------------------------------------------------------

#[test]
fn kind_is_the_entity_kind_lookup_and_its_attributes() {
    let scratch = common::Scratch::empty("lookups_kind").expect("a vault");
    assert_eq!(
        words(&scratch, "SELECT code FROM entity_kind"),
        rust_words(Kind::ALL.map(Kind::as_str))
    );
    assert_eq!(
        words(&scratch, "SELECT code FROM entity_kind WHERE linkable = 1"),
        rust_words(Kind::LINK_ENDS.map(Kind::as_str)),
        "`link_end` is `entity_kind.linkable`"
    );
    assert_eq!(
        words(&scratch, "SELECT code FROM concept_kind"),
        rust_words(Kind::CONCEPTS.map(Kind::as_str))
    );
    assert_eq!(
        words(&scratch, "SELECT code FROM container_kind"),
        rust_words(Kind::CONTAINERS.map(Kind::as_str))
    );
}

#[test]
fn rel_is_the_set_of_relations_edge_shape_holds() {
    let scratch = common::Scratch::empty("lookups_rel").expect("a vault");
    assert_eq!(
        words(&scratch, "SELECT DISTINCT rel FROM edge_shape"),
        rust_words(Rel::ALL.map(Rel::as_str))
    );
}

#[test]
fn a_label_colour_is_a_palette_key() {
    let scratch = common::Scratch::empty("lookups_palette").expect("a vault");
    let palette = words(&scratch, "SELECT key FROM palette");
    for color in centraid_vault::commands::tag::LABEL_COLORS {
        assert!(palette.contains(color), "{color} is not a palette key");
    }
}

// ---------------------------------------------------------------------------------------------
// K1: a vault is founded with its index file
// ---------------------------------------------------------------------------------------------

#[test]
fn a_founded_vault_has_its_index_file_attached_and_its_tables_are_not_the_vaults() {
    let scratch = common::Scratch::founded("lookups_index").expect("a vault");
    let index = scratch.dir().join("vault.index.db");
    assert!(
        index.exists(),
        "{} is founded beside the vault",
        index.display()
    );
    // The index tables answer through the vault's connection...
    for table in [
        "search",
        "search_past",
        "search_word",
        "alert",
        "geo",
        "index_state",
    ] {
        scratch
            .vault
            .read(|c| {
                Ok(
                    c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| {
                        r.get::<_, i64>(0)
                    })?,
                )
            })
            .unwrap_or_else(|error| panic!("{table} does not answer: {error}"));
    }
    // ...but they are not in the vault's own schema, so no snapshot of it holds one.
    let vault_tables = words(
        &scratch,
        "SELECT name FROM main.sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
    );
    for table in [
        "search",
        "search_past",
        "search_word",
        "alert",
        "geo",
        "index_state",
    ] {
        assert!(!vault_tables.contains(table), "{table} is in vault.db");
    }
    scratch
        .vault
        .read(|c| {
            let attached: String = c.query_row(
                "SELECT file FROM pragma_database_list WHERE name = 'ix'",
                [],
                |r| r.get(0),
            )?;
            assert!(attached.ends_with("vault.index.db"), "{attached}");
            Ok(())
        })
        .expect("a read");
    // The file carries its own tag and rung.
    let plain = rusqlite::Connection::open(&index).expect("opens as a plain file");
    let tag: i64 = plain
        .query_row("PRAGMA application_id", [], |r| r.get(0))
        .expect("a tag");
    let rung: i64 = plain
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .expect("a rung");
    assert_eq!(tag, centraid_vault::format::INDEX_APPLICATION_ID);
    assert_eq!(rung, centraid_vault::migrations::index_head_version());
}

/// A founded vault's file, closed so its index file is on disk too, in a scratch directory of its own.
fn closed_vault() -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
    let dir = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&dir).expect("a directory");
    let file = dir.join("vault.db");
    let vault = centraid_vault::Vault::create(&file).expect("a vault");
    vault.found("Test", "Owner").expect("founded");
    vault.finish().expect("closes");
    let index = dir.join("vault.index.db");
    (dir, file, index)
}

#[test]
fn a_missing_index_file_is_founded_again_and_owes_every_entity() {
    let (dir, file, index) = closed_vault();
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", index.display()));
    }
    let vault = centraid_vault::Vault::open(&file).expect("opens without its index");
    assert!(index.exists(), "the index file is founded again");
    let owed: i64 = vault
        .read(|c| Ok(c.query_row("SELECT COUNT(*) FROM search_owed", [], |r| r.get(0))?))
        .expect("a count");
    let entities: i64 = vault
        .read(|c| Ok(c.query_row("SELECT COUNT(*) FROM entity", [], |r| r.get(0))?))
        .expect("a count");
    assert_eq!(owed, entities, "a new index file owes every entity");
    drop(vault);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_database_that_is_not_ours_at_the_index_path_is_refused_and_left_alone() {
    let (dir, file, index) = closed_vault();
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", index.display()));
    }
    {
        let plain = rusqlite::Connection::open(&index).expect("a plain file");
        plain
            .pragma_update(None, "application_id", 0x5a5a_5a5a_i64)
            .expect("a tag");
        plain
            .execute_batch("CREATE TABLE theirs (x TEXT)")
            .expect("a table");
    }
    let before = std::fs::read(&index).expect("bytes");
    let refused = match centraid_vault::Vault::open(&file) {
        Ok(_) => panic!("opened over a database that is not ours"),
        Err(error) => error.to_string(),
    };
    assert!(refused.contains("is not a Centraid vault"), "{refused}");
    assert_eq!(
        std::fs::read(&index).expect("bytes"),
        before,
        "left byte-identical"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
