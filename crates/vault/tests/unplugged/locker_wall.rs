//! THE LOCKER WALL, SWEPT (#1185, owner ruling D11): a Locker item may start a link and is seen
//! only inside Locker. The page door is the one wall: a page over `entity` or `edge` is given
//! without Locker's rows, and without the edges that touch one, unless the read is NAMED as one
//! that may reach them (`page::reaches_locker`).
//!
//! The sweep reads every read name the repository's source declares (`name: "app.read"`), over
//! the two tables a far-end card or a "what is joined to this" read goes through, and holds each
//! one to the wall: a Locker item linked to other items shows nowhere but to a read named for
//! Locker, for Home's count of its items, or for the assistant (the owner's ruling of 2026-10-22).
//! A new read is swept the day it is written, so a missing filter in one query cannot reach a
//! member's page by being added.

mod common;

use std::fs;
use std::path::Path;

use centraid_vault::commands::Registry;
use centraid_vault::page::{KeysetPage, reaches_locker};
use centraid_vault::{Command, CommandStatus, Principal};
use serde_json::json;

const TITLE: &str = "Zq Wall Bank 7";

/// The reads the wall lets reach Locker's rows: Locker's own, Home's count, the assistant's.
fn may_reach_locker(name: &str) -> bool {
    name.starts_with("locker.") || name == "home.locker" || name.starts_with("assist.native.")
}

/// Every `name: "app.read"` in the repository's Rust source outside tests.
fn declared_read_names() -> Vec<String> {
    fn walk(dir: &Path, out: &mut Vec<String>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let file = entry.file_name();
            let file = file.to_string_lossy();
            if path.is_dir() {
                if file != "target" && file != "tests" && file != "node_modules" {
                    walk(&path, out);
                }
            } else if file.ends_with(".rs") && !file.ends_with("_tests.rs") {
                let Ok(text) = fs::read_to_string(&path) else {
                    continue;
                };
                let mut rest = text.as_str();
                while let Some(at) = rest.find("name: \"") {
                    rest = &rest[at + "name: \"".len()..];
                    let Some(end) = rest.find('"') else { break };
                    let name = &rest[..end];
                    let shaped = name.contains('.')
                        && name.len() < 80
                        && name.chars().all(|c| {
                            c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c)
                        });
                    if shaped {
                        out.push(name.to_owned());
                    }
                }
            }
        }
    }
    let mut found = Vec::new();
    walk(
        &centraid_ontology::scratch::repo_root().join("crates"),
        &mut found,
    );
    found.sort();
    found.dedup();
    found
}

fn page(name: &str, from: &str, select: &[&str], sort: &str, pk: &str) -> KeysetPage {
    KeysetPage {
        name: name.to_owned(),
        select: select.iter().map(|c| (*c).to_owned()).collect(),
        from: from.to_owned(),
        predicate: None,
        binds: Vec::new(),
        sort_column: sort.to_owned(),
        pk_column: pk.to_owned(),
        descending: false,
        limit: 500,
        after: None,
        held_thumbnail: false,
        document_size: false,
    }
}

#[test]
fn no_read_but_lockers_homes_or_the_assistants_is_given_a_locker_item_or_an_edge_that_touches_one()
{
    let scratch = common::Scratch::founded("locker-wall").expect("a vault");
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
    let note = id(run("note.create", json!({"title": "Plan", "body": "x"})));
    run(
        "locker.add_item",
        json!({"item_id": "lk1", "type": "login", "title": TITLE}),
    );
    // A Locker item starts links to a person, by `about`, and to a note, by `links`.
    run(
        "edge.add",
        json!({"from": "lk1", "rel": "about", "to": maya}),
    );
    run(
        "edge.add",
        json!({"from": "lk1", "rel": "links", "to": note}),
    );

    let names = declared_read_names();
    assert!(
        names.len() > 50,
        "the sweep read {} names; the scan is broken",
        names.len()
    );
    let mut swept = 0;
    for name in &names {
        // THE WALL IS DECIDED BY THE NAME: only the three named kinds of read may reach Locker.
        assert_eq!(
            reaches_locker(name),
            may_reach_locker(name),
            "`{name}` is {} reach a Locker item, and only Locker's reads, Home's count and the \
             assistant's may",
            if reaches_locker(name) {
                "allowed to"
            } else {
                "not allowed to"
            }
        );
        if may_reach_locker(name) {
            continue;
        }
        swept += 1;
        let entities = scratch
            .vault
            .keyset_page(&page(name, "entity", &["id", "title", "kind"], "id", "id"))
            .expect("a page over entity");
        let seen = format!("{:?}", entities.rows);
        assert!(
            !seen.contains("lk1") && !seen.contains(TITLE) && !seen.contains("locker_item"),
            "`{name}` was served a Locker item over `entity`: {seen}"
        );
        // The people and notes it links are still there: the wall did not empty the page.
        assert!(
            seen.contains(&maya) && seen.contains(&note),
            "`{name}`: {seen}"
        );
        let edges = scratch
            .vault
            .keyset_page(&page(
                name,
                "edge",
                &["from_id", "to_id", "rel"],
                "from_id",
                "to_id",
            ))
            .expect("a page over edge");
        let seen = format!("{:?}", edges.rows);
        assert!(
            !seen.contains("lk1"),
            "`{name}` was served an edge that touches a Locker item: {seen}"
        );
    }
    assert!(swept > 50, "only {swept} reads were held to the wall");

    // And the reads the wall names DO reach it, so the sweep is not passing on an empty page.
    let reaching = scratch
        .vault
        .keyset_page(&page(
            "locker.sweep",
            "entity",
            &["id", "title"],
            "id",
            "id",
        ))
        .expect("Locker's own read");
    assert!(format!("{:?}", reaching.rows).contains(TITLE));
}
