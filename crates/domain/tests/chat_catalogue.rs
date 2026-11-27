//! THE MODEL'S KINDS AND ACTIONS, held to the vault: every table and column a chat kind names
//! exists in the founded file, every enum is the vault's own list, and every name the model says
//! an action's input under is a field of that input.

mod common;

use std::collections::BTreeSet;

use centraid_domain::chat::{ChatKind, KINDS as CHAT_KINDS};
use centraid_domain::{ACTIONS, KINDS};
use common::World;
use rusqlite::{Connection, OpenFlags};

fn connection(world: &World) -> Connection {
    Connection::open_with_flags(world.vault.path(), OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("a file")
}

fn columns(connection: &Connection, table: &str) -> BTreeSet<String> {
    connection
        .prepare(&format!("PRAGMA table_xinfo({table})"))
        .expect("a pragma")
        .query_map([], |row| row.get::<_, String>(1))
        .expect("rows")
        .map(Result::unwrap)
        .collect()
}

/// The words a CHECK list or a lookup table allows for `table.column`.
fn allowed(connection: &Connection, table: &str, column: &str) -> Option<BTreeSet<String>> {
    let lookup = match (table, column) {
        ("account", "type") => Some("SELECT code FROM vocab WHERE domain = 'account_type'".to_owned()),
        ("locker_item", "type") => Some("SELECT code FROM vocab WHERE domain = 'locker_type'".to_owned()),
        ("measurement", "metric") => Some("SELECT code FROM health_metric".to_owned()),
        _ => None,
    };
    if let Some(lookup) = lookup {
        return Some(
            connection
                .prepare(&lookup)
                .expect("a lookup")
                .query_map([], |row| row.get::<_, String>(0))
                .expect("rows")
                .map(Result::unwrap)
                .collect(),
        );
    }
    let sql: String = connection
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE name = ?1",
            [table],
            |row| row.get(0),
        )
        .expect("a table");
    let start = sql.find(&format!("{column} "))?;
    let rest = &sql[start..];
    let line = rest.lines().next()?;
    let list = line.split_once("IN (")?.1.split_once(')')?.0;
    Some(
        list.split(',')
            .map(|word| word.trim().trim_matches('\'').to_owned())
            .collect(),
    )
}

#[test]
fn every_table_and_column_a_chat_kind_names_is_in_the_founded_vault() {
    let world = World::new("chat-sources");
    let connection = connection(&world);
    let mut problems = Vec::new();
    for kind in CHAT_KINDS {
        let known = columns(&connection, kind.table);
        if known.is_empty() {
            problems.push(format!("{}: no table {}", kind.id, kind.table));
        }
        if !known.contains(kind.pk) {
            problems.push(format!("{}: no key {}.{}", kind.id, kind.table, kind.pk));
        }
        let mut sources = vec![("name", kind.name_source)];
        sources.extend(kind.date.map(|(_, source)| ("date", source)));
        sources.extend(kind.fields.iter().map(|field| (field.name, field.source)));
        for (what, (table, column)) in sources {
            if !columns(&connection, table).contains(column) {
                problems.push(format!("{}.{what}: no column {table}.{column}", kind.id));
            }
        }
        for field in kind.fields {
            if field.kind != "enum" {
                continue;
            }
            let (table, column) = field.source;
            let vault: BTreeSet<String> = field
                .values
                .iter()
                .map(|(_, vault)| (*vault).to_owned())
                .collect();
            match allowed(&connection, table, column) {
                Some(list) if field.source == ("measurement", "metric") => {
                    if !vault.is_subset(&list) {
                        problems.push(format!(
                            "{}.{}: {vault:?} is not within {list:?}",
                            kind.id, field.name
                        ));
                    }
                }
                Some(list) => {
                    if vault != list {
                        problems.push(format!(
                            "{}.{}: {vault:?} is not the vault's {list:?}",
                            kind.id, field.name
                        ));
                    }
                }
                None => problems.push(format!(
                    "{}.{}: no list to hold the enum to",
                    kind.id, field.name
                )),
            }
            let models: BTreeSet<&str> = field.values.iter().map(|(model, _)| *model).collect();
            if models.len() != field.values.len() {
                problems.push(format!("{}.{}: a word is said twice", kind.id, field.name));
            }
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

#[test]
fn every_chat_kind_is_an_entity_kind_or_a_table_with_no_kind_of_its_own() {
    let entity: BTreeSet<&str> = KINDS.iter().map(|kind| kind.id).collect();
    let ids: BTreeSet<&str> = CHAT_KINDS.iter().map(|kind| kind.id).collect();
    assert_eq!(ids.len(), CHAT_KINDS.len(), "a chat kind is declared twice");
    let apps: BTreeSet<&str> = CHAT_KINDS.iter().map(|kind| kind.app).collect();
    assert_eq!(apps.len(), 9, "the nine apps own chat kinds: {apps:?}");
    for kind in CHAT_KINDS {
        let own = |kind: &ChatKind| matches!(kind.entity, "measurement" | "budget" | "rule");
        assert!(
            entity.contains(kind.entity) || own(kind),
            "{}: `{}` is neither an entity kind nor a table of its own",
            kind.id,
            kind.entity
        );
        for link in kind.links {
            assert!(
                ids.contains(link.kind),
                "{} links to {}, which is not a chat kind",
                kind.id,
                link.kind
            );
        }
    }
}

#[test]
fn every_name_the_model_says_belongs_to_a_field_of_the_input() {
    for action in ACTIONS {
        let Some(say) = action.says() else {
            continue;
        };
        let fields: BTreeSet<&str> = action.input.iter().map(|field| field.name).collect();
        let mut spoken = BTreeSet::new();
        for (field, names) in say.names {
            assert!(
                fields.contains(field),
                "{}: `{field}` is not an input field",
                action.name()
            );
            assert!(!names.is_empty());
            for name in *names {
                assert!(
                    spoken.insert(*name) || *name == *field,
                    "{}: `{name}` names two fields",
                    action.name()
                );
            }
        }
        for (field, json) in say.fixed.iter().chain(say.filled) {
            assert!(
                fields.contains(field),
                "{}: `{field}` is not an input field",
                action.name()
            );
            serde_json::from_str::<serde_json::Value>(json)
                .unwrap_or_else(|error| panic!("{}.{field}: {error}", action.name()));
        }
    }
}
