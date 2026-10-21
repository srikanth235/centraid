//! What Tasks reads, against a vault the product founds and the task commands
//! fill: the board's windows and families, the trash, what hangs off a row (tags,
//! what it is about, attachments), the project chrome, one task, and the search,
//! each asked through the paged door a phone's core asks through.

use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_tasks::queries::{load_board, load_search_term, load_task};
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

    fn board(&self, limit: Option<i64>) -> centraid_apps_tasks::BoardData {
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

fn titles(rows: &[centraid_apps_tasks::TaskRow]) -> Vec<&str> {
    rows.iter().map(|row| row.title.as_str()).collect()
}

#[test]
fn the_board_holds_the_open_work_its_families_and_what_hangs_off_a_row() {
    let world = World::new();
    let mum = world.id("person.add", json!({ "title": "Mum" }));
    let area = world.id(
        "container.create",
        json!({ "kind": "area", "title": "Home life" }),
    );
    let project = world.id(
        "container.create",
        json!({ "kind": "project", "title": "Garden", "parent": area, "color": "green", "position": 2 }),
    );
    let section = world.id(
        "container.create",
        json!({ "kind": "section", "title": "Spring", "parent": project }),
    );
    let parent = world.id(
        "task.add",
        json!({ "title": "Dig the beds", "project_id": project, "section_id": section,
                "due": "2099-06-05", "priority": 4 }),
    );
    world.ok(
        "task.add",
        json!({ "title": "Buy a spade", "parent_id": parent }),
    );
    let done_child = world.id(
        "task.add",
        json!({ "title": "Borrow a barrow", "parent_id": parent }),
    );
    world.ok("task.complete", json!({ "id": done_child }));
    world.ok(
        "edge.add",
        json!({ "from": parent, "rel": "about", "to": mum }),
    );
    world.ok("tag.add", json!({ "id": parent, "label": "outdoors" }));
    world.ok("flag.set", json!({ "id": parent, "flag": "starred" }));
    let closed = world.id("task.add", json!({ "title": "Mow the lawn" }));
    world.ok("task.complete", json!({ "id": closed }));
    let wont = world.id("task.add", json!({ "title": "Prune the oak" }));
    world.ok("task.cancel", json!({ "id": wont }));
    let trashed = world.id("task.add", json!({ "title": "Trashed" }));
    world.ok("entity.trash", json!({ "id": trashed }));

    let board = world.board(None);
    // One open root with its whole family below it; a trashed task is on no place.
    assert_eq!(titles(&board.open), ["Dig the beds"]);
    let root = &board.open[0];
    assert_eq!(titles(&root.children), ["Borrow a barrow", "Buy a spade"]);
    assert_eq!(root.done_children, Some(1));
    assert_eq!(root.status, "open");
    assert_eq!(root.due_at.as_deref(), Some("2099-06-05"));
    assert_eq!(root.project_id.as_deref(), Some(project.as_str()));
    assert_eq!(root.section_id.as_deref(), Some(section.as_str()));
    // A star is a flag and not a tag; a tag is its label; what it is about is its kind and id.
    assert_eq!(
        root.tags
            .iter()
            .map(|tag| tag.label.as_str())
            .collect::<Vec<_>>(),
        ["outdoors"]
    );
    assert_eq!(
        root.references
            .iter()
            .map(|reference| (reference.to_type.as_str(), reference.to_id.as_str()))
            .collect::<Vec<_>>(),
        [("person", mum.as_str())]
    );
    assert_eq!(board.tags.len(), 1);
    // The logbook: done and cancelled, the done one first.
    assert_eq!(titles(&board.logbook), ["Mow the lawn", "Prune the oak"]);
    assert_eq!(board.logbook[1].status, "cancelled");
    // The chrome: the project, in its area, with its color, and its section.
    assert_eq!(board.projects.len(), 1);
    assert_eq!(board.projects[0].name.as_deref(), Some("Garden"));
    assert_eq!(board.projects[0].area.as_deref(), Some("Home life"));
    assert_eq!(board.projects[0].color.as_deref(), Some("green"));
    assert_eq!(board.projects[0].sort_order, Some(2));
    assert_eq!(board.sections.len(), 1);
    assert_eq!(
        board.sections[0].project_id.as_deref(),
        Some(project.as_str())
    );
    assert!(!board.truncated);
}

#[test]
fn an_archived_project_leaves_the_chrome_and_a_trashed_one_takes_its_work() {
    let world = World::new();
    let kept = world.id(
        "container.create",
        json!({ "kind": "project", "title": "Kept" }),
    );
    let old = world.id(
        "container.create",
        json!({ "kind": "project", "title": "Old" }),
    );
    world.ok("flag.set", json!({ "id": old, "flag": "archived" }));
    let gone = world.id(
        "container.create",
        json!({ "kind": "project", "title": "Gone" }),
    );
    let task = world.id(
        "task.add",
        json!({ "title": "In gone", "project_id": gone }),
    );
    world.ok("entity.trash", json!({ "id": gone }));
    let board = world.board(None);
    assert_eq!(
        board
            .projects
            .iter()
            .map(|p| p.project_id.as_str())
            .collect::<Vec<_>>(),
        [kept.as_str()]
    );
    assert!(board.open.iter().all(|row| row.task_id != task));
}

#[test]
fn the_open_window_is_the_newest_by_creation_and_says_when_there_is_more() {
    let world = World::new();
    for n in 0..30 {
        world.ok("task.add", json!({ "title": format!("Task {n:02}") }));
    }
    let board = world.board(Some(20));
    assert_eq!(board.open.len(), 20);
    assert!(board.truncated, "the walk's own cursor says more exists");
    let all = world.board(Some(500));
    assert_eq!(all.open.len(), 30);
    assert!(!all.truncated);
}

#[test]
fn a_subtask_whose_parent_fell_outside_the_window_is_not_promoted() {
    let world = World::new();
    let parent = world.id("task.add", json!({ "title": "Old parent" }));
    for n in 0..25 {
        world.ok("task.add", json!({ "title": format!("Filler {n:02}") }));
    }
    world.ok(
        "task.add",
        json!({ "title": "Newest child", "parent_id": parent }),
    );
    let board = world.board(Some(20));
    assert!(
        board.open.iter().all(|row| row.title != "Newest child"),
        "the child is below its parent, not a root of its own"
    );
    let root = board
        .open
        .iter()
        .find(|row| row.task_id == parent)
        .expect("the family stays whole");
    assert_eq!(titles(&root.children), ["Newest child"]);
}

#[test]
fn one_task_whole_and_the_search_in_rank_order() {
    let world = World::new();
    let zone = FireZone::named("Etc/UTC").expect("a zone");
    let parent = world.id(
        "task.add",
        json!({ "title": "Book the cabin", "description": "the cabin by the lake", "due": "2099-06-03" }),
    );
    let child = world.id(
        "task.add",
        json!({ "title": "Pay deposit", "parent_id": parent }),
    );
    world.ok("task.add", json!({ "title": "Dentist" }));
    let (detail, denial) = world
        .vault
        .read(|connection| {
            Ok(load_task(&TestDoor::new(connection), &child, NOW, &zone).expect("reads"))
        })
        .expect("a read");
    assert!(denial.is_none());
    assert_eq!(detail.parent.expect("its parent").task_id, parent);
    let (none, _) = world
        .vault
        .read(|connection| {
            Ok(load_task(&TestDoor::new(connection), "no-such-task", NOW, &zone).expect("reads"))
        })
        .expect("a read");
    assert!(none.task.is_none());
    let (found, denial) = world
        .vault
        .read(|connection| {
            let search = centraid_search::SqliteDoor::open(connection).expect("the index opens");
            Ok(load_search_term(
                &TestDoor::new(connection),
                &search,
                &centraid_search::Principal::Owner,
                "cabin",
                10,
                NOW,
                &zone,
            )
            .expect("search reads"))
        })
        .expect("a read");
    assert!(denial.is_none());
    assert_eq!(found.tasks.len(), 1);
    assert_eq!(found.tasks[0].task_id, parent);
    assert!(
        found.tasks[0]
            .snippet
            .as_deref()
            .is_some_and(|s| s.contains('⟦'))
    );
}
