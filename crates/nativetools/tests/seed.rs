//! Seeding is deterministic: the same world twice is the same vault, as the
//! tools read it, and the same script over it answers the same.

mod common;

use centraid_nativetools::vaultio::{Handle, SetClock};
use centraid_nativetools::world::World;
use serde_json::{Value, json};

/// Everything the tools read — except `updated_at`, which several vault
/// commands stamp from the host's wall clock (the runtime reads it nowhere).
fn dump(path: &std::path::Path) -> String {
    let handle = Handle::open(path, SetClock::at(0), "dump").unwrap();
    let world = World::load(&handle).unwrap();
    let mut out = String::new();
    for row in world.rows.values() {
        out.push_str(&format!(
            "{:?} {} {:?} {:?} {:?} trashed={} {}\n",
            row.kind, row.id, row.name, row.date, row.fields, row.trashed, row.created
        ));
    }
    for edge in &world.edges {
        out.push_str(&format!(
            "{:?} -> {:?} via {:?}\n",
            edge.from, edge.to, edge.via
        ));
    }
    out
}

fn script(world: &common::World) -> Vec<Value> {
    let mut session = world.session();
    let mut out = vec![session.prompt(), session.user("neha and the cabin")];
    for (tool, args) in [
        ("find", json!({"kind": "task", "name": "cabin"})),
        (
            "act",
            json!({"verb": "complete", "kind": "task", "name": "cabin", "more": true}),
        ),
        (
            "act",
            json!({"verb": "create", "args": {"kind": "note", "name": "Seed", "body": "x"}}),
        ),
    ] {
        out.push(session.call(tool, &args));
    }
    out.push(session.user("undo"));
    out.push(session.call("act", &json!({"verb": "undo"})));
    out
}

#[test]
fn the_same_world_seeds_the_same_vault() {
    let first = common::seeded();
    let second = common::seeded();
    assert_eq!(first.keys, second.keys, "the same ids for the same keys");
    let (a, b) = (dump(first.path()), dump(second.path()));
    assert!(a.lines().count() > 40, "{a}");
    assert_eq!(a, b);
}

#[test]
fn the_same_script_over_the_same_world_answers_the_same() {
    let (first, second) = (common::seeded(), common::seeded());
    assert_eq!(script(&first), script(&second));
}

#[test]
fn the_seeded_world_reads_back_as_written() {
    let world = common::seeded();
    let handle = Handle::open(world.path(), SetClock::at(0), "read").unwrap();
    let read = World::load(&handle).unwrap();
    let row = |key: &str| {
        read.rows
            .values()
            .find(|row| row.id == world.id(key))
            .unwrap_or_else(|| panic!("{key}"))
            .clone()
    };
    assert_eq!(row("dal").created, "2026-09-10T08:00:00.000Z");
    assert!(row("old").trashed && row("library").trashed);
    assert_eq!(
        row("report").field("status").map(|v| v.show(None)),
        Some("completed".to_owned())
    );
    assert_eq!(
        row("neha_r").date.map(|d| d.vault()),
        Some("2026-09-01T10:00:00".to_owned())
    );
    assert!(row("w2").starred() && row("wifi").starred() && row("beach").starred());
    assert_eq!(
        row("empty_album").kind,
        centraid_nativetools::meta::Kind::Album
    );
    assert_eq!(
        row("empty_nb").kind,
        centraid_nativetools::meta::Kind::Notebook
    );
    let bad = serde_json::json!({"people": [{"key": "a", "name": "A"}, {"key": "a", "name": "B"}]});
    let dir = tempfile::tempdir().unwrap();
    let error = centraid_nativetools::seed::seed(&bad, &dir.path().join("v.db")).unwrap_err();
    assert!(error.contains("used twice"), "{error}");
}
