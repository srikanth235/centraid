//! What Docs reads, against a vault the product founds and Docs' own commands
//! fill: the drive, its three own-read shelves, the history, the activity rail
//! and the search, each asked through the paged door a phone's core asks through.

use std::sync::Arc;

use centraid_apps_docs::queries::{
    DriveInput, ShelfArm, count_shelf_arm, load_activity, load_document, load_drive, load_history,
    load_search_term, load_shelf_arm,
};
use centraid_apps_kit::testdoor::TestDoor;
use centraid_vault::clock::{FixedClock, SeededIds};
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal, Vault};
use serde_json::json;

struct World {
    dir: std::path::PathBuf,
    vault: Vault,
    clock: Arc<FixedClock>,
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
        let clock = Arc::new(FixedClock::frozen());
        let vault = Vault::create_with(
            dir.join("vault.db"),
            Box::new(Arc::clone(&clock)),
            Box::new(SeededIds::new("docs")),
        )
        .expect("a vault")
        .with_blobs(Box::new(
            centraid_vault::bytes::FsBlobStore::open(dir.join("bytes")).expect("a store"),
        ));
        vault.found("Home", "Owner").expect("founded");
        Self {
            dir,
            vault,
            clock,
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

    /// A PDF-shaped document over bytes only this seed has: staged, then added.
    fn file(&self, title: &str, seed: &str, folder: Option<&str>) -> String {
        let hash = centraid_vault::blob::content_digest(seed.as_bytes());
        self.ok("blob.stage", json!({ "hash": hash, "size": seed.len() }));
        self.ok(
            "document.add",
            json!({ "title": title, "blob": hash, "media_type": "application/pdf",
                     "folder_id": folder }),
        )["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    fn folder(&self, title: &str, parent: Option<&str>) -> String {
        self.ok(
            "container.create",
            json!({ "kind": "folder", "title": title, "parent": parent }),
        )["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    fn read<T>(&self, body: impl FnOnce(&TestDoor<'_>) -> T) -> T {
        self.vault
            .read(|c| Ok(body(&TestDoor::new(c))))
            .expect("a read")
    }
}

fn titles(rows: &[centraid_apps_docs::queries::DocumentRow]) -> Vec<&str> {
    rows.iter().filter_map(|row| row.title.as_deref()).collect()
}

#[test]
fn the_drive_carries_folders_stars_labels_sizes_and_the_trash() {
    let w = World::new();
    let home = w.folder("Home", None);
    let leases = w.folder("Leases", Some(&home));
    let lease = w.file("Lease 2099", "lease pages", Some(&leases));
    w.clock.advance_ms(1_000);
    let deed = w.file("Deed", "deed", Some(&home));
    w.clock.advance_ms(1_000);
    let loose = w.file("Loose", "loose", None);
    w.ok("flag.set", json!({ "id": lease, "flag": "starred" }));
    w.ok("tag.add", json!({ "id": lease, "label": "Tax" }));
    w.ok("entity.trash", json!({ "id": deed }));
    let (drive, denial) = w.read(|door| load_drive(door, DriveInput::default()).expect("reads"));
    assert!(denial.is_none() && !drive.truncated);
    assert_eq!(
        drive
            .folders
            .iter()
            .map(|f| (f.name.as_deref(), f.parent_id.as_deref()))
            .collect::<Vec<_>>(),
        [(Some("Home"), None), (Some("Leases"), Some(home.as_str()))]
    );
    // Newest made first; the trash is in the window, the shelves cut it.
    assert_eq!(titles(&drive.documents), ["Loose", "Deed", "Lease 2099"]);
    let row = |id: &str| {
        drive
            .documents
            .iter()
            .find(|row| row.document_id == id)
            .expect("a row")
    };
    assert!(row(&lease).starred && !row(&lease).trashed);
    assert_eq!(row(&lease).folder_id.as_deref(), Some(leases.as_str()));
    assert_eq!(
        row(&lease)
            .tags
            .iter()
            .map(|t| t.label.as_str())
            .collect::<Vec<_>>(),
        ["Tax"]
    );
    assert_eq!(row(&lease).byte_size, Some(11));
    assert_eq!(row(&lease).media_type.as_deref(), Some("application/pdf"));
    assert!(row(&deed).trashed && row(&deed).purge_at.is_some());
    assert_eq!(row(&loose).folder_id, None);
}

#[test]
fn a_document_attached_to_something_and_filed_nowhere_shows_only_where_it_is_attached() {
    let w = World::new();
    let event = w.ok(
        "event.propose",
        json!({ "title": "Viewing", "starts": "2099-06-01T10:00", "ends": "2099-06-01T11:00",
                     "zone": "UTC" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let receipt = w.file("Receipt", "receipt", None);
    w.clock.advance_ms(1_000);
    let filed = w.file(
        "Filed receipt",
        "filed receipt",
        Some(&w.folder("Receipts", None)),
    );
    w.clock.advance_ms(1_000);
    w.file("Plain", "plain", None);
    for document in [&receipt, &filed] {
        w.ok(
            "edge.add",
            json!({ "from": event, "rel": "attached", "to": document }),
        );
    }
    let (drive, _) = w.read(|door| load_drive(door, DriveInput::default()).expect("reads"));
    // The attached, unfiled one is the event's; the attached, filed one is also the
    // member's own filing.
    assert_eq!(titles(&drive.documents), ["Plain", "Filed receipt"]);
    // It opens by id all the same.
    let (opened, _) = w.read(|door| load_document(door, &receipt).expect("reads"));
    assert_eq!(
        opened.row.expect("the document").title.as_deref(),
        Some("Receipt")
    );
    // And no shelf draws it.
    for arm in [ShelfArm::Recent, ShelfArm::Starred, ShelfArm::Trash] {
        let (arm, _) = w.read(|door| load_shelf_arm(door, arm, 50).expect("reads"));
        assert!(!titles(&arm.documents).contains(&"Receipt"));
    }
}

#[test]
fn the_shelves_the_window_does_not_define_read_for_themselves() {
    let w = World::new();
    let mut ids = Vec::new();
    for index in 0..25 {
        w.clock.advance_ms(60_000);
        ids.push(w.file(&format!("Doc {index:02}"), &format!("body {index}"), None));
    }
    for index in [0, 1, 2] {
        w.ok("flag.set", json!({ "id": ids[index], "flag": "starred" }));
    }
    for index in [1, 3] {
        w.ok("entity.trash", json!({ "id": ids[index] }));
    }
    let (drive, _) =
        w.read(|door| load_drive(door, DriveInput { limit: Some(20) }).expect("reads"));
    assert!(drive.truncated);
    assert_eq!(
        drive.documents.len(),
        20,
        "the window is the newest twenty made"
    );
    // Trash, Starred (minus the trashed one) and Recent are not cut by it.
    let (trash, _) = w.read(|door| load_shelf_arm(door, ShelfArm::Trash, 20).expect("reads"));
    assert_eq!(titles(&trash.documents).len(), 2);
    assert!(!trash.filled);
    let (starred, _) = w.read(|door| load_shelf_arm(door, ShelfArm::Starred, 20).expect("reads"));
    let mut names: Vec<&str> = titles(&starred.documents);
    names.sort_unstable();
    assert_eq!(names, ["Doc 00", "Doc 02"]);
    let (recent, _) = w.read(|door| load_shelf_arm(door, ShelfArm::Recent, 50).expect("reads"));
    assert_eq!(recent.documents.len(), 23);
    assert_eq!(titles(&recent.documents)[0], "Doc 24");
    let (count, _) = w.read(|door| count_shelf_arm(door, ShelfArm::Starred, 20).expect("reads"));
    assert_eq!((count.rows, count.filled), (2, false));
    // A shelf longer than its window says so.
    let (short, _) = w.read(|door| load_shelf_arm(door, ShelfArm::Recent, 5).expect("reads"));
    assert!(short.filled && short.documents.len() == 5);
}

#[test]
fn the_history_numbers_its_versions_by_seq_and_dates_each_when_it_became_current() {
    let w = World::new();
    let id = w.ok(
        "document.create_text",
        json!({ "title": "Lease", "body_text": "first" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let made = "2026-01-01T00:00:00.000Z";
    w.clock.advance_ms(60_000);
    w.ok("document.edit", json!({ "id": id, "body_text": "second" }));
    w.clock.advance_ms(60_000);
    w.ok("document.edit", json!({ "id": id, "body_text": "third" }));
    let (history, denial) = w.read(|door| load_history(door, &id).expect("reads"));
    assert!(denial.is_none());
    let numbers: Vec<usize> = history.versions.iter().map(|v| v.number).collect();
    assert_eq!(numbers, [3, 2, 1]);
    assert!(history.versions[0].current && history.versions[1..].iter().all(|v| !v.current));
    assert_eq!(history.versions[2].byte_size, Some(5));
    // Version 1 became current when the document was made, version 3 when 2 was replaced.
    assert_eq!(history.versions[2].asserted_at.as_deref(), Some(made));
    assert_eq!(
        history.versions[1].asserted_at.as_deref(),
        Some("2026-01-01T00:01:00.000Z")
    );
    assert_eq!(
        history.versions[0].asserted_at.as_deref(),
        Some("2026-01-01T00:02:00.000Z")
    );
    // The reader's body is the head's words.
    let (opened, _) = w.read(|door| load_document(door, &id).expect("reads"));
    assert_eq!(opened.body.as_deref(), Some("third"));
    // A stale link is a state.
    let (missing, _) = w.read(|door| load_document(door, "no-such").expect("reads"));
    assert!(missing.row.is_none() && missing.body.is_none());
}

#[test]
fn search_is_the_indexs_rank_order_over_documents_and_the_activity_is_the_journals() {
    let w = World::new();
    let lease = w.ok(
        "document.create_text",
        json!({ "id": "doc-lease", "title": "Lease agreement",
                                                        "body_text": "rent is paid monthly" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    w.file("Recipe", "flour and eggs", None);
    w.ok("flag.set", json!({ "id": lease, "flag": "starred" }));
    let (found, denial) = w
        .vault
        .read(|connection| {
            let index = centraid_search::SqliteDoor::open(connection, w.vault.words())
                .expect("the index opens");
            Ok(load_search_term(
                &TestDoor::new(connection),
                &index,
                &centraid_search::Principal::Owner,
                "rent",
                10,
            )
            .expect("reads"))
        })
        .expect("a read");
    assert!(denial.is_none());
    assert_eq!(titles(&found.documents), ["Lease agreement"]);
    assert!(found.documents[0].snippet.is_some());
    let (rail, _) = w.read(|door| load_activity(door, &lease).expect("reads"));
    let said: Vec<&str> = rail
        .events
        .iter()
        .filter_map(|e| e.activity.as_deref())
        .collect();
    assert_eq!(said, ["flag.set", "document.create_text"]);
}
