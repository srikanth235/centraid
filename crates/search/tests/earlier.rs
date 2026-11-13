//! WHAT AN ITEM SAID BEFORE, THROUGH THE DOOR (#1185): the result is the live item, once; the
//! hit says "in an earlier version" only when nothing matches now. Counts and values only.

use centraid_search::sqlite::SqliteDoor;
use centraid_search::{Answer, EachRequest, Principal, Search, SearchRequest, Target};
use centraid_vault::commands::Registry;
use centraid_vault::model::Kind;
use centraid_vault::{Command, CommandStatus, Principal as VaultPrincipal, Vault};
use serde_json::json;

struct World {
    _dir: tempfile::TempDir,
    vault: Vault,
    registry: Registry,
}

impl World {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = Vault::create(dir.path().join("vault.db")).expect("a vault");
        vault.found("Search", "Ada").expect("founded");
        Self {
            _dir: dir,
            vault,
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn run(&self, name: &str, input: serde_json::Value) {
        let outcome = self
            .vault
            .execute(
                &self.registry,
                &VaultPrincipal::owner("phone"),
                &Command::new(name, input),
            )
            .unwrap_or_else(|error| panic!("`{name}`: {error}"));
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
    }

    fn note(&self, id: &str, title: &str, body: &str) {
        self.run(
            "note.create",
            json!({"id": id, "title": title, "body": body}),
        );
    }

    fn edit(&self, id: &str, body: &str) {
        self.run("note.edit", json!({"id": id, "body": body}));
    }

    fn ask(&self, kinds: &[&str], query: &str) -> Vec<Target> {
        let request = SearchRequest::across(kinds.iter().map(|k| (*k).to_owned()), query, 50);
        self.vault
            .read(|connection| {
                let door = SqliteDoor::open(connection, self.vault.words()).expect("opens");
                match door.query(&Principal::Owner, &request).expect("answers") {
                    Answer::Data { page, .. } => Ok(page.rows),
                    Answer::Denied(_) => panic!("denied"),
                }
            })
            .expect("reads")
    }

    fn each(&self, kinds: &[&str], query: &str) -> Vec<Target> {
        let request = EachRequest::new(kinds.iter().map(|k| (*k).to_owned()), query, 8);
        self.vault
            .read(|connection| {
                let door = SqliteDoor::open(connection, self.vault.words()).expect("opens");
                Ok(door
                    .query_each(&Principal::Owner, &request)
                    .expect("answers"))
            })
            .expect("reads")
    }
}

/// `(id, in_earlier_version)` of each hit.
fn flags(found: &[Target]) -> Vec<(&str, bool)> {
    found
        .iter()
        .map(|t| (t.id.as_str(), t.in_earlier_version))
        .collect()
}

#[test]
fn an_edited_note_is_one_row_flagged_only_when_nothing_matches_now() {
    let world = World::new();
    world.note("n", "Plan", "alpha shared");
    world.edit("n", "beta shared");
    assert_eq!(flags(&world.ask(&["note"], "alpha")), [("n", true)]);
    assert_eq!(flags(&world.ask(&["note"], "beta")), [("n", false)]);
    assert_eq!(
        flags(&world.ask(&["note"], "shared")),
        [("n", false)],
        "a word in both is the live item, once, not flagged"
    );
    // The same through the per-kind statement Home reads.
    assert_eq!(flags(&world.each(&["note"], "alpha")), [("n", true)]);
    assert_eq!(flags(&world.each(&["note"], "shared")), [("n", false)]);
    // A prefix of an earlier word finds it too.
    assert_eq!(flags(&world.ask(&["note"], "alp")), [("n", true)]);
}

#[test]
fn an_item_with_many_matching_versions_is_one_row() {
    let world = World::new();
    world.note("n", "Plan", "heron one");
    for body in ["heron two", "heron three", "heron four", "finally gone"] {
        world.edit("n", body);
    }
    assert_eq!(flags(&world.ask(&["note"], "heron")), [("n", true)]);
    assert_eq!(flags(&world.each(&["note"], "heron")), [("n", true)]);
}

#[test]
fn a_live_match_comes_before_an_earlier_one_and_each_item_is_once() {
    let world = World::new();
    world.note("old", "Old", "otter");
    world.edit("old", "something else");
    world.note("live", "Live", "otter today");
    world.note("both", "Both", "otter");
    world.edit("both", "otter again");
    let found = world.ask(&["note"], "otter");
    assert_eq!(
        flags(&found),
        [("both", false), ("live", false), ("old", true)],
        "{found:?}"
    );
}

#[test]
fn a_window_continues_across_the_live_and_earlier_stages() {
    let world = World::new();
    world.note("a", "Live one", "pelican");
    world.note("b", "Gone one", "pelican");
    world.edit("b", "nothing");
    world.note("c", "Gone two", "pelican");
    world.edit("c", "nothing");
    let mut asked = SearchRequest::across(["note".to_owned()], "pelican", 1);
    let mut seen = Vec::new();
    loop {
        let Answer::Data { page, .. } = world
            .vault
            .read(|connection| {
                let door = SqliteDoor::open(connection, world.vault.words()).expect("opens");
                Ok(door.query(&Principal::Owner, &asked).expect("answers"))
            })
            .expect("reads")
        else {
            panic!("data")
        };
        seen.extend(
            page.rows
                .iter()
                .map(|t| (t.id.clone(), t.in_earlier_version)),
        );
        match page.next {
            Some(next) => asked.page.after = Some(next),
            None => break,
        }
    }
    assert_eq!(
        seen,
        [
            ("a".to_owned(), false),
            ("b".to_owned(), true),
            ("c".to_owned(), true)
        ]
    );
}

#[test]
fn a_trashed_note_is_found_by_neither_word_and_a_restored_one_by_both() {
    let world = World::new();
    world.note("n", "Plan", "alpha");
    world.edit("n", "beta");
    world.run("entity.trash", json!({"id": "n"}));
    assert!(world.ask(&["note"], "alpha").is_empty());
    assert!(world.ask(&["note"], "beta").is_empty());
    world.run("entity.restore", json!({"id": "n"}));
    assert_eq!(flags(&world.ask(&["note"], "alpha")), [("n", true)]);
    assert_eq!(flags(&world.ask(&["note"], "beta")), [("n", false)]);
}

#[test]
fn a_task_a_person_and_a_renamed_title_are_found_the_same_way() {
    let world = World::new();
    world
        .vault
        .commit(|tx| {
            tx.insert_entity(
                "t",
                Kind::Task,
                "Call the plumber",
                "2026-03-01T09:00:00.000Z",
            )?;
            tx.connection().execute(
                "INSERT INTO task (id, description) VALUES ('t', 'copper')",
                [],
            )?;
            tx.insert_entity(
                "p",
                Kind::Person,
                "Ada Lovelace",
                "2026-03-01T09:00:00.000Z",
            )?;
            tx.connection().execute(
                "INSERT INTO person (id, nickname) VALUES ('p', 'Countess')",
                [],
            )?;
            Ok(())
        })
        .expect("seeds");
    world.run("task.edit", json!({"id": "t", "description": "plastic"}));
    world.run("person.edit", json!({"id": "p", "nickname": "Enchantress"}));
    world.run(
        "entity.retitle",
        json!({"id": "t", "title": "Call the roofer"}),
    );
    assert_eq!(flags(&world.ask(&["task"], "copper")), [("t", true)]);
    assert_eq!(flags(&world.ask(&["task"], "plumber")), [("t", true)]);
    assert_eq!(flags(&world.ask(&["task"], "roofer")), [("t", false)]);
    assert_eq!(flags(&world.ask(&["person"], "countess")), [("p", true)]);
    assert_eq!(
        flags(&world.ask(&["person"], "enchantress")),
        [("p", false)]
    );
}

#[test]
fn a_snippet_of_an_earlier_hit_is_the_words_it_said() {
    let world = World::new();
    world.note("n", "Plan", "the quick falcon dives");
    world.edit("n", "nothing of the sort");
    let found = world.ask(&["note"], "falcon");
    assert_eq!(found.len(), 1);
    assert!(
        found[0].snippet.contains("⟦falcon⟧"),
        "the snippet marks the earlier words: {:?}",
        found[0].snippet
    );
}

#[test]
fn a_locker_items_earlier_cells_are_not_found_through_the_door() {
    let world = World::new();
    world
        .vault
        .commit(|tx| {
            tx.insert_entity("lk", Kind::LockerItem, "Bank", "2026-03-01T09:00:00.000Z")?;
            tx.connection().execute(
                "INSERT INTO locker_item (id, type, notes) VALUES ('lk', 'login', 'quokkaold')",
                [],
            )?;
            Ok(())
        })
        .expect("seeds");
    world
        .vault
        .commit(|tx| {
            tx.connection().execute(
                "UPDATE locker_item SET notes = 'quokkanew' WHERE id = 'lk'",
                [],
            )?;
            tx.touch("lk", "2026-03-02T09:00:00.000Z")?;
            Ok(())
        })
        .expect("edits");
    assert!(world.ask(&["locker_item"], "quokkaold").is_empty());
    assert_eq!(
        flags(&world.ask(&["locker_item"], "quokkanew")),
        [("lk", false)]
    );
}

#[test]
fn the_earlier_stage_is_bounded_by_the_cap_and_not_by_the_matching_items() {
    // Many items that match now AND before: the earlier leg must not turn them into rows, and
    // an item found only before is still answered.
    let world = World::new();
    for index in 0..40 {
        let id = format!("n{index:02}");
        world.note(&id, "Common", "kestrel");
        world.edit(&id, "kestrel again");
    }
    world.note("lost", "Lost", "kestrel");
    world.edit("lost", "something else");
    let found = world.ask(&["note"], "kestrel");
    assert_eq!(found.len(), 41);
    assert_eq!(found.iter().filter(|t| t.in_earlier_version).count(), 1);
    assert_eq!(found.last().map(|t| t.id.as_str()), Some("lost"));
}
