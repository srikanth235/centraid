//! THE GENERAL LINK (#1185): any item links to any other item, nothing links to a Locker item, a
//! link made on one page shows on the other, and either page takes it off. The shape table itself
//! is held by `commitments.rs`; this proves the commands and the two reads a page uses.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::links;
use centraid_vault::model::Kind;
use centraid_vault::{Command, CommandStatus, Principal};
use serde_json::json;

const AT: &str = "2026-03-01T09:00:00.000Z";

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new() -> Self {
        let scratch = common::Scratch::founded("links").expect("a vault");
        scratch
            .vault
            .commit(|tx| {
                tx.set_producer("test.fixture");
                for kind in Kind::ALL {
                    tx.insert_entity(&format!("a:{}", kind.as_str()), kind, "Alpha", AT)?;
                    tx.insert_entity(&format!("b:{}", kind.as_str()), kind, "Beta", AT)?;
                }
                Ok(())
            })
            .expect("fixture entities");
        Self {
            scratch,
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn run(&self, name: &str, input: serde_json::Value) -> centraid_vault::CommandOutcome {
        self.scratch
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .unwrap_or_else(|error| panic!("`{name}`: {error}"))
    }

    fn link(&self, from: &str, to: &str) -> centraid_vault::CommandOutcome {
        self.run("edge.add", json!({"from": from, "rel": "links", "to": to}))
    }

    fn unlink(&self, from: &str, to: &str) -> centraid_vault::CommandOutcome {
        self.run(
            "edge.remove",
            json!({"from": from, "rel": "links", "to": to}),
        )
    }

    fn linked(&self, id: &str) -> Vec<links::Linked> {
        self.scratch
            .vault
            .read(|connection| links::linked(connection, id))
            .expect("reads")
    }

    fn edges(&self) -> i64 {
        self.scratch
            .vault
            .read(|c| {
                Ok(
                    c.query_row("SELECT COUNT(*) FROM edge WHERE rel = 'links'", [], |row| {
                        row.get(0)
                    })?,
                )
            })
            .expect("a count")
    }
}

#[test]
fn every_linkable_kind_links_to_every_other_and_nothing_links_to_a_locker_item() {
    let world = World::new();
    let starts: Vec<Kind> = Kind::ALL
        .into_iter()
        .filter(|kind| kind.is_link_start())
        .collect();
    assert_eq!(starts.len(), 11, "the ten ends and the Locker item");
    for from in &starts {
        for to in Kind::LINK_ENDS {
            let outcome = world.link(
                &format!("a:{}", from.as_str()),
                &format!("b:{}", to.as_str()),
            );
            assert_eq!(
                outcome.status,
                CommandStatus::Executed,
                "{} -> {}: {:?}",
                from.as_str(),
                to.as_str(),
                outcome.reason
            );
        }
    }
    assert_eq!(world.edges(), 110);

    // Nothing links to a Locker item, from any kind at all, and the member reads why.
    for from in Kind::ALL {
        let outcome = world.link(&format!("a:{}", from.as_str()), "b:locker_item");
        assert_eq!(outcome.status, CommandStatus::Failed, "{}", from.as_str());
        assert_eq!(
            outcome.reason.as_deref(),
            Some("a Locker item cannot be the target of a link: link from the Locker item instead"),
            "{}",
            from.as_str()
        );
    }
    assert_eq!(world.edges(), 110, "a refused link writes nothing");

    // The kinds that are no items (a tag, a flag, a notebook, a revision's owner) are not linked.
    for from in Kind::ALL.into_iter().filter(|kind| !kind.is_link_start()) {
        let outcome = world.link(&format!("a:{}", from.as_str()), "b:person");
        assert_eq!(outcome.status, CommandStatus::Failed, "{}", from.as_str());
    }
}

#[test]
fn a_link_shows_on_both_pages_and_either_page_takes_it_off() {
    let world = World::new();
    assert_eq!(
        world.link("a:note", "a:event").status,
        CommandStatus::Executed
    );
    let from_note = world.linked("a:note");
    assert_eq!(from_note.len(), 1);
    assert_eq!(
        (from_note[0].id.as_str(), from_note[0].key),
        ("a:event", "event")
    );
    let from_event = world.linked("a:event");
    assert_eq!(from_event.len(), 1, "the event's page shows the note");
    assert_eq!(
        (from_event[0].id.as_str(), from_event[0].key),
        ("a:note", "note")
    );

    // The same link made from the other end is the same link.
    assert_eq!(
        world.link("a:event", "a:note").status,
        CommandStatus::Executed
    );
    assert_eq!(world.edges(), 1);

    // The event's page takes it off, though the note made it.
    assert_eq!(
        world.unlink("a:event", "a:note").status,
        CommandStatus::Executed
    );
    assert_eq!(world.edges(), 0);
    assert!(world.linked("a:note").is_empty());

    // Taking off a link that is not there is a no-op, so an Undo may run twice.
    assert_eq!(
        world.unlink("a:event", "a:note").status,
        CommandStatus::Executed
    );
}

#[test]
fn a_locker_item_is_seen_only_on_its_own_page() {
    let world = World::new();
    assert_eq!(
        world.link("a:locker_item", "a:person").status,
        CommandStatus::Executed
    );
    let own = world.linked("a:locker_item");
    assert_eq!(own.len(), 1);
    assert_eq!(own[0].key, "person");
    assert!(
        world.linked("a:person").is_empty(),
        "the person's page does not name a Locker item"
    );
}

#[test]
fn a_trashed_item_is_not_listed_and_a_workout_is_a_workout() {
    let world = World::new();
    world.link("a:task", "a:photo");
    assert_eq!(world.linked("a:task").len(), 1);
    world
        .scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.fixture");
            tx.connection().execute(
                "UPDATE entity SET deleted_at = ?1, purge_at = ?1 WHERE id = 'a:photo'",
                [AT],
            )?;
            Ok(())
        })
        .expect("trashed");
    assert!(world.linked("a:task").is_empty());
    assert_eq!(links::key_of(Kind::Activity, true), Some("workout"));
    assert_eq!(links::key_of(Kind::Activity, false), None);
    assert_eq!(links::key_of(Kind::Txn, false), Some("transaction"));
    assert_eq!(links::key_of(Kind::Tag, false), None);
}

#[test]
fn the_picker_lists_one_kind_by_typed_term_bounded_and_never_a_locker_item() {
    let world = World::new();
    world
        .scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.fixture");
            for n in 0..(links::MAX_CANDIDATES + 10) {
                tx.insert_entity(&format!("t{n}"), Kind::Task, &format!("Chore {n:03}"), AT)?;
            }
            Ok(())
        })
        .expect("tasks");
    let pick = |key: &str, term: &str, limit: usize| {
        world
            .scratch
            .vault
            .read(|c| links::candidates(c, key, term, limit))
            .expect("reads")
    };
    assert_eq!(pick("task", "", 1_000).len(), links::MAX_CANDIDATES);
    let typed = pick("task", "CHORE 05", 1_000);
    assert!(!typed.is_empty() && typed.iter().all(|c| c.title.contains("Chore 05")));
    assert_eq!(pick("task", "alpha", 1_000)[0].id, "a:task");
    assert!(pick("task", "nothing like it", 10).is_empty());
    assert!(
        pick("locker_item", "", 10).is_empty(),
        "never a Locker item"
    );
    assert!(pick("tag", "", 10).is_empty(), "not an item");
    // The owner leads the people, whatever the order of names.
    let people = pick("person", "", 10);
    assert!(people[0].is_owner, "{people:?}");
}
