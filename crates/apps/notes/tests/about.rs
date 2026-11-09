//! NOTES SHOWS `about` (#1173, item 19): a note about a person, an event, a task or a document
//! is on the shelf with its subject, a journal entry (a note about the owner) is in the Journal
//! only, and the exclusion no longer walks every `about` edge of the vault (the ontology audit's
//! must-fix 4).

use std::sync::Arc;

use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_notes::journal::read_journal_ids;
use centraid_apps_notes::queries::{load_journal, load_library};
use centraid_vault::clock::{FixedClock, SeededIds};
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal, Vault};
use serde_json::json;

struct World {
    dir: std::path::PathBuf,
    vault: Vault,
    registry: Registry,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl World {
    fn new() -> Self {
        let dir = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let vault = Vault::create_with(
            dir.join("vault.db"),
            Box::new(Arc::new(FixedClock::frozen())),
            Box::new(SeededIds::new("about")),
        )
        .expect("a vault");
        vault.found("Home", "Owner").expect("founded");
        Self {
            dir,
            vault,
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn id(&self, name: &str, input: serde_json::Value) -> String {
        let outcome = self
            .vault
            .execute(
                &self.registry,
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
        outcome.output["id"].as_str().unwrap_or_default().to_owned()
    }

    fn join(&self, from: &str, to: &str) {
        self.id(
            "edge.add",
            json!({ "from": from, "rel": "about", "to": to }),
        );
    }

    fn read<T>(&self, body: impl FnOnce(&TestDoor<'_>) -> T) -> T {
        self.vault
            .read(|c| Ok(body(&TestDoor::new(c))))
            .expect("a read")
    }
}

#[test]
fn a_note_about_a_person_a_task_or_an_event_is_on_the_shelf_with_its_subject_and_a_journal_entry_is_not()
 {
    let w = World::new();
    let owner = w.vault.self_id().expect("read").expect("an owner");
    let maya = w.id("person.add", json!({ "title": "Maya" }));
    let task = w.id("task.add", json!({ "title": "Ring Maya" }));
    let plain = w.id("note.create", json!({ "title": "Plain", "body": "x" }));
    let about_maya = w.id("note.create", json!({ "title": "On Maya", "body": "x" }));
    let about_task = w.id(
        "note.create",
        json!({ "title": "On the call", "body": "x" }),
    );
    let journal = w.id("note.create", json!({ "title": "Today", "body": "x" }));
    w.join(&about_maya, &maya);
    w.join(&about_task, &task);
    w.join(&journal, &owner);
    // A thing that is not a note about the owner makes no journal entry.
    w.join(&task, &owner);

    let (library, denial) = w.read(|door| load_library(door, Some(200)).expect("folds"));
    assert!(denial.is_none());
    let mut shelf: Vec<(&str, Vec<&str>)> = library
        .notes
        .iter()
        .map(|row| {
            (
                row.title.as_deref().unwrap_or_default(),
                row.about
                    .iter()
                    .filter_map(|card| card.title.as_deref())
                    .collect(),
            )
        })
        .collect();
    shelf.sort();
    assert_eq!(
        shelf,
        [
            ("On Maya", vec!["Maya"]),
            ("On the call", vec!["Ring Maya"]),
            ("Plain", vec![]),
        ],
        "the shelf holds the notes about something, each with its subject; the journal entry is not on it"
    );
    let (entries, _) = w.read(|door| load_journal(door, Some(200)).expect("reads"));
    assert_eq!(
        entries
            .entries
            .iter()
            .map(|e| e.note_id.as_str())
            .collect::<Vec<_>>(),
        [journal.as_str()],
        "the Journal holds the notes about the owner and only those"
    );
    let _ = plain;
}

#[test]
fn the_journal_set_does_not_count_what_is_about_everything_else() {
    let w = World::new();
    let owner = w.vault.self_id().expect("read").expect("an owner");
    let maya = w.id("person.add", json!({ "title": "Maya" }));
    // More `about` edges than a page of the walk, none of them about the owner: the bound is
    // spent on the owner's edges alone.
    w.vault
        .commit(|tx| {
            tx.set_producer("test.fixture");
            for n in 0..1_200 {
                let task = format!("task-{n:05}");
                tx.insert_entity(&task, centraid_vault::model::Kind::Task, "t", "2026-01-01T00:00:00.000Z")?;
                tx.connection().execute(
                    "INSERT INTO task (id, status) VALUES (?1, 'open')",
                    [&task],
                )?;
                tx.connection().execute(
                    "INSERT INTO edge (from_id, rel, to_id, created_at) VALUES (?1, 'about', ?2, '2026-01-01T00:00:00.000Z')",
                    [&task, &maya],
                )?;
            }
            Ok(())
        })
        .expect("seeds");
    let note = w.id("note.create", json!({ "title": "Today", "body": "x" }));
    w.join(&note, &owner);
    let ids = w.read(|door| read_journal_ids(door).expect("reads"));
    assert_eq!(ids, [note], "only the owner's edges are walked");
}
