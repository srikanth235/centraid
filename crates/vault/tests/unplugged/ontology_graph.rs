//! The graph catalogue is held to the founded file, and the one reading of it
//! presents edges and foreign-key columns together (#1173, O1).

mod common;

use centraid_ontology::graph::{
    COLUMN_LINKS, Direction, EDGE_RELATIONS, Via, links_at, links_outside_locker,
};
use centraid_vault::commands::Registry;
use centraid_vault::model::Rel;
use centraid_vault::{Command, CommandStatus, Principal};
use serde_json::json;

#[test]
fn the_catalogue_names_the_relations_and_the_columns_the_file_has() {
    let named: Vec<&str> = Rel::ALL.iter().map(|rel| rel.as_str()).collect();
    assert_eq!(named, EDGE_RELATIONS);
    let scratch = common::Scratch::founded("graph-catalogue").expect("a vault");
    scratch
        .vault
        .read(|c| {
            for link in COLUMN_LINKS {
                let sql: String = c.query_row(
                    "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?1",
                    [link.table],
                    |row| row.get(0),
                )?;
                assert!(
                    sql.contains(&format!("{} ", link.column)),
                    "{}.{} is not a column of the file",
                    link.table,
                    link.column
                );
                let pointed: i64 = c.query_row(
                    &format!(
                        "SELECT COUNT(*) FROM pragma_foreign_key_list('{}') WHERE \"from\" = '{}' OR \"from\" LIKE '{}%'",
                        link.table, link.column, link.column
                    ),
                    [],
                    |row| row.get(0),
                )?;
                assert!(
                    pointed > 0,
                    "{}.{} has no foreign key",
                    link.table,
                    link.column
                );
            }
            Ok(())
        })
        .expect("reads");
}

#[test]
fn one_reading_presents_edges_and_columns_and_marks_the_locker_wall() {
    let scratch = common::Scratch::founded_with_blobs("graph-read").expect("a vault");
    scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.fixture");
            tx.connection().execute(
                "INSERT INTO locker_key (key_id, created_at) VALUES ('k1', '2026-01-01T00:00:00.000Z')",
                [],
            )?;
            Ok(())
        })
        .expect("key");
    let registry = Registry::with_system_commands().expect("registry");
    let run = |name: &str, input: serde_json::Value| -> serde_json::Value {
        let outcome = scratch
            .vault
            .execute(
                &registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .expect("runs");
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    };
    let id = |o: serde_json::Value| o["id"].as_str().expect("id").to_owned();
    let maya = id(run("person.add", json!({"title": "Maya"})));
    let book = id(run(
        "container.create",
        json!({"kind": "notebook", "title": "Trips"}),
    ));
    let note = id(run(
        "note.create",
        json!({"title": "Maya", "body": "x", "notebook_id": book}),
    ));
    run(
        "edge.add",
        json!({"from": note, "rel": "about", "to": maya}),
    );
    run(
        "locker.add_item",
        json!({"item_id": "lk1", "type": "login", "title": "Bank"}),
    );
    run(
        "edge.add",
        json!({"from": "lk1", "rel": "about", "to": maya}),
    );
    scratch
        .vault
        .read(|c| {
            let all = links_at(c, &maya, Direction::Incoming)?;
            assert_eq!(all.len(), 2, "{all:?}");
            assert!(all.iter().any(|l| l.touches_locker()));
            let outside = links_outside_locker(c, &maya, Direction::Incoming)?;
            assert_eq!(outside.len(), 1);
            assert_eq!(outside[0].from, note);
            assert_eq!(outside[0].relation, "about");
            assert_eq!(outside[0].via, Via::Edge);
            // The note's own links: its subject by an edge, its notebook by a column.
            let own = links_outside_locker(c, &note, Direction::Outgoing)?;
            let seen: Vec<(&str, Via)> = own.iter().map(|l| (l.relation, l.via)).collect();
            assert_eq!(seen, vec![("about", Via::Edge), ("notebook", Via::Column)]);
            // A trashed end is no end.
            Ok(())
        })
        .expect("reads");
}
