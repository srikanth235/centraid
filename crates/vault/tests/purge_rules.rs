//! What a purge does with what points at a row (#1214, K4): `PURGE_RULES` is the founded file's own
//! list of foreign keys that delete nothing, so a pointer added to the schema without a rule fails
//! here and not in a member's vault; and the database refuses the delete a rule is there to prepare.

mod common;

use std::collections::BTreeSet;

use centraid_vault::commands::entity::{PURGE_RULES, PurgeRule};
use centraid_vault::model::HOST_TABLES;

/// `(table, columns)` of a foreign key.
type Pointer = (String, String);

/// One foreign key as `pragma_foreign_key_list` states it: where it points, its delete action and
/// its columns with their order.
type Key = (String, String, Vec<(i64, String)>);

#[test]
fn the_purge_rules_are_the_foreign_keys_that_delete_nothing_into_an_entity_or_a_kind() {
    let scratch = common::Scratch::founded("purge_rules").expect("a vault");
    let (derived, nullable): (BTreeSet<Pointer>, BTreeSet<Pointer>) = scratch
        .vault
        .read(|connection| {
            let tables: Vec<String> = connection
                .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")?
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            let mut derived = BTreeSet::new();
            let mut nullable = BTreeSet::new();
            for table in tables {
                let mut keys: std::collections::BTreeMap<i64, Key> = std::collections::BTreeMap::new();
                let mut statement = connection.prepare(
                    "SELECT id, seq, \"table\", \"from\", on_delete FROM pragma_foreign_key_list(?1)",
                )?;
                for row in statement.query_map([&table], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                })? {
                    let (id, seq, to, from, on_delete) = row?;
                    let key = keys.entry(id).or_insert((to, on_delete, Vec::new()));
                    key.2.push((seq, from));
                }
                for (to, on_delete, mut columns) in keys.into_values() {
                    if on_delete != "NO ACTION" || !(to == "entity" || HOST_TABLES.contains(&to.as_str())) {
                        continue;
                    }
                    columns.sort();
                    let columns: Vec<String> = columns.into_iter().map(|(_, name)| name).collect();
                    derived.insert((table.clone(), columns.join(",")));
                    for column in &columns {
                        let not_null: i64 = connection.query_row(
                            "SELECT \"notnull\" FROM pragma_table_xinfo(?1) WHERE name = ?2",
                            [&table, column],
                            |row| row.get(0),
                        )?;
                        if not_null == 0 {
                            nullable.insert((table.clone(), column.clone()));
                        }
                    }
                }
            }
            Ok((derived, nullable))
        })
        .expect("reads the schema");
    let named: BTreeSet<Pointer> = PURGE_RULES
        .iter()
        .map(|(table, columns, _)| ((*table).to_owned(), (*columns).to_owned()))
        .collect();
    assert_eq!(
        named, derived,
        "a pointer without a purge rule, or a rule without a pointer"
    );
    assert_eq!(named.len(), PURGE_RULES.len(), "a pointer is named once");
    // A pointer that lets go is a column that may be NULL.
    for (table, columns, rule) in PURGE_RULES {
        if *rule == PurgeRule::Detach || *rule == PurgeRule::Home {
            for column in columns.split(',') {
                assert!(
                    nullable.contains(&((*table).to_owned(), column.to_owned())),
                    "{table}.{column} lets go of its target, so it may be NULL"
                );
            }
        }
    }
}

#[test]
fn the_database_refuses_to_delete_what_a_row_still_points_at() {
    let scratch = common::Scratch::founded("purge_rules_raw").expect("a vault");
    let at = "2026-03-01T09:00:00.000Z";
    let book = scratch.vault.ids().next();
    let note = scratch.vault.ids().next();
    scratch
        .vault
        .commit(|tx| {
            tx.insert_entity(&book, centraid_vault::model::Kind::Notebook, "B", at)?;
            tx.insert_entity_in(
                &note,
                centraid_vault::model::Kind::Note,
                "N",
                Some(&book),
                at,
            )?;
            Ok(())
        })
        .expect("a notebook with a note");
    for sql in [
        // A holder under what it holds.
        format!("DELETE FROM entity WHERE id = '{book}'"),
        // The owner, which the vault row names.
        "DELETE FROM entity WHERE id = (SELECT self_id FROM vault)".to_owned(),
        // A kind of workout a workout names.
        "DELETE FROM entity WHERE id = 'workout_kind:run'".to_owned(),
    ] {
        if sql.contains("workout_kind") {
            // Nothing names it yet: it goes, and the same delete is refused once a workout does.
            let workout = scratch.vault.ids().next();
            scratch
                .vault
                .commit(|tx| {
                    tx.insert_entity(&workout, centraid_vault::model::Kind::Workout, "Run", at)?;
                    tx.connection().execute(
                        "INSERT INTO workout (id, type_id, starts) VALUES (?1, 'workout_kind:run', ?2)",
                        rusqlite::params![workout, at],
                    )?;
                    Ok(())
                })
                .expect("a workout");
        }
        let refused = scratch
            .vault
            .commit(|tx| {
                tx.connection().execute_batch(&sql)?;
                Ok(())
            })
            .is_err();
        assert!(refused, "the database took `{sql}`");
    }
}
