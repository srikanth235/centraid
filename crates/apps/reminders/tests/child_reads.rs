//! What the board reads beside a task, for a task that holds more edges than a page does: its tags
//! and what it is about. A page holds `WIDE`'s 500 rows, and a read keyed on the task's id alone
//! loses the rest of its edges where a page ends inside them.

use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_reminders::task::queries::load_board;
use centraid_vault::commands::Registry;
use centraid_vault::time::zone::FireZone;
use centraid_vault::{Command, CommandStatus, Principal, Vault};
use serde_json::json;

const NOW: &str = "2099-06-02T12:00:00.000Z";

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
        let vault = Vault::create(dir.join("vault.db")).expect("a vault");
        vault.found("Home", "Owner").expect("founded");
        Self {
            dir,
            vault,
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn ok(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
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
        outcome.output
    }

    fn id(&self, name: &str, input: serde_json::Value) -> String {
        self.ok(name, input)["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    fn board(&self, limit: Option<i64>) -> centraid_apps_reminders::task::BoardData {
        let zone = FireZone::named("Etc/UTC").expect("a zone");
        self.vault
            .read(|connection| {
                let (data, denial) =
                    load_board(&TestDoor::new(connection), limit, NOW, &zone).expect("reads");
                assert!(denial.is_none());
                Ok(data)
            })
            .expect("a read")
    }
}

/// A page holds this many rows.
const PAGE: usize = 500;

#[test]
fn a_task_with_more_tags_than_a_page_holds_keeps_every_one() {
    let world = World::new();
    let task = world.id("task.add", json!({ "title": "Labelled" }));
    let mum = world.id("person.add", json!({ "title": "Mum" }));
    world.ok(
        "edge.add",
        json!({ "from": task, "rel": "about", "to": mum }),
    );
    for at in 0..=PAGE {
        world.ok(
            "tag.add",
            json!({ "id": task, "label": format!("label-{at:04}") }),
        );
    }
    let board = world.board(None);
    let root = &board.open[0];
    assert_eq!(root.tags.len(), PAGE + 1, "every tag");
    assert_eq!(board.tags.len(), PAGE + 1, "every chip");
    assert_eq!(root.references.len(), 1, "and what it is about");
}

/// Two top-level tasks, the first holding `first` subtasks and the second `second`: the board's
/// children read walks them `(parent_id, id)` a page at a time. Returns what each root came back
/// with, in the board's order of roots by their own title.
fn subtask_counts(first: usize, second: usize) -> Vec<(String, usize, usize)> {
    let world = World::new();
    let one = world.id("task.add", json!({ "title": "One" }));
    let two = world.id("task.add", json!({ "title": "Two" }));
    for (parent, count) in [(&one, first), (&two, second)] {
        for at in 0..count {
            world.ok(
                "task.add",
                json!({ "title": format!("sub-{at:04}"), "parent_id": parent }),
            );
        }
    }
    let board = world.board(None);
    let mut found: Vec<(String, usize, usize)> = board
        .open
        .iter()
        .map(|root| {
            let ids: std::collections::BTreeSet<&str> = root
                .children
                .iter()
                .map(|child| child.task_id.as_str())
                .collect();
            (root.title.clone(), root.children.len(), ids.len())
        })
        .collect();
    found.sort();
    found
}

#[test]
fn a_task_with_more_subtasks_than_a_page_holds_keeps_every_one_once() {
    // The first page of 500 ends inside One's subtasks; the second holds the rest and Two's.
    assert_eq!(
        subtask_counts(PAGE + 2, 3),
        vec![
            ("One".to_owned(), PAGE + 2, PAGE + 2),
            ("Two".to_owned(), 3, 3)
        ]
    );
}

#[test]
fn a_page_boundary_between_two_parents_keeps_every_subtask_once() {
    // One's subtasks fill the first page exactly; Two's begin the second.
    assert_eq!(
        subtask_counts(PAGE, 3),
        vec![("One".to_owned(), PAGE, PAGE), ("Two".to_owned(), 3, 3)]
    );
}
