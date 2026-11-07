//! What Agenda Wave 2 reads (#1173), against a vault the product founds: a task's link, an event's
//! travel, availability and two alerts, a list's and a calendar's icon, the guests a phone calendar
//! stated, and an item's attachments a page at a time.

use centraid_apps_agenda::task::queries::{load_chrome, load_task};
use centraid_apps_agenda::{load_attachments, load_event, load_upcoming};
use centraid_apps_kit::page::PageCursor;
use centraid_apps_kit::testdoor::TestDoor;
use centraid_vault::commands::Registry;
use centraid_vault::time::zone::FireZone;
use centraid_vault::{Command, CommandStatus, Principal, Vault};
use serde_json::{Value, json};

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
        let vault = Vault::create(dir.join("vault.db"))
            .expect("a vault")
            .with_blobs(Box::new(
                centraid_vault::bytes::FsBlobStore::open(dir.join("bytes")).expect("a store"),
            ));
        vault.found("Home", "Owner").expect("founded");
        Self {
            dir,
            vault,
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn ok(&self, name: &str, input: Value) -> Value {
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

    fn id(&self, name: &str, input: Value) -> String {
        self.ok(name, input)["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    fn photo(&self, seed: &str) -> String {
        let hash = centraid_vault::blob::content_digest(seed.as_bytes());
        self.ok("blob.stage", json!({ "hash": hash, "size": seed.len() }));
        self.id(
            "photo.add",
            json!({ "blob": hash, "media_type": "image/jpeg" }),
        )
    }

    fn document(&self, title: &str, seed: &str) -> String {
        let hash = centraid_vault::blob::content_digest(seed.as_bytes());
        self.ok("blob.stage", json!({ "hash": hash, "size": seed.len() }));
        self.id(
            "document.add",
            json!({ "title": title, "blob": hash, "media_type": "application/pdf" }),
        )
    }

    fn attach(&self, from: &str, to: &str) {
        self.ok(
            "edge.add",
            json!({ "from": from, "rel": "attached", "to": to }),
        );
    }

    fn page(
        &self,
        item: &str,
        after: Option<PageCursor>,
        limit: usize,
    ) -> centraid_apps_agenda::AttachmentsData {
        self.vault
            .read(|connection| {
                let (data, denial) =
                    load_attachments(&TestDoor::new(connection), item, after, limit)
                        .expect("reads");
                assert!(denial.is_none());
                Ok(data)
            })
            .expect("a read")
    }
}

#[test]
fn a_task_reads_back_its_link_and_a_project_its_icon() {
    let world = World::new();
    let project = world.id(
        "container.create",
        json!({ "kind": "project", "title": "Garden", "color": "petrol", "icon": "Plant" }),
    );
    let task = world.id(
        "task.add",
        json!({ "title": "Buy seeds", "project_id": project, "url": "https://shop.example/seeds" }),
    );
    let zone = FireZone::named("Etc/UTC").expect("a zone");
    world
        .vault
        .read(|connection| {
            let door = TestDoor::new(connection);
            let (detail, denial) =
                load_task(&door, &task, "2099-06-02T12:00:00.000Z", &zone).expect("reads");
            assert!(denial.is_none());
            assert_eq!(
                detail.task.expect("the task").url.as_deref(),
                Some("https://shop.example/seeds")
            );
            let (projects, _) = load_chrome(&door).expect("chrome");
            assert_eq!(projects[0].icon.as_deref(), Some("Plant"));
            assert_eq!(projects[0].color.as_deref(), Some("petrol"));
            Ok(())
        })
        .expect("a read");
    world.ok("task.edit", json!({ "id": task, "url": null }));
    world
        .vault
        .read(|connection| {
            let (detail, _) = load_task(
                &TestDoor::new(connection),
                &task,
                "2099-06-02T12:00:00.000Z",
                &zone,
            )
            .expect("reads");
            assert_eq!(detail.task.expect("the task").url, None);
            Ok(())
        })
        .expect("a read");
}

#[test]
fn an_event_reads_back_travel_availability_two_alerts_and_its_calendars_icon() {
    let world = World::new();
    let calendar = world.id(
        "container.create",
        json!({ "kind": "calendar", "title": "Family", "color": "raspberry", "icon": "Users" }),
    );
    let place = world.id("place.add", json!({ "title": "Office" }));
    let event = world.id(
        "event.propose",
        json!({ "title": "Meeting", "starts": "2026-03-02T09:00", "ends": "2026-03-02T10:00",
                "zone": "Europe/Paris", "calendar_id": calendar, "place_id": place,
                "busy": false, "travel_min": 25, "reminders": [30, 5],
                "url": "https://meet.example/x" }),
    );
    world
        .vault
        .read(|connection| {
            let (detail, denial) =
                load_event(&TestDoor::new(connection), &event, None, None).expect("reads");
            assert!(denial.is_none());
            let row = detail.event.expect("the event");
            assert_eq!(row.travel_min, Some(25));
            assert!(!row.busy, "free");
            assert_eq!(row.reminders, vec![30, 5], "the first and the second alert");
            assert_eq!(row.location_place_id.as_deref(), Some(place.as_str()));
            assert_eq!(
                row.conferencing_uri.as_deref(),
                Some("https://meet.example/x")
            );
            assert_eq!(row.start_tz.as_deref(), Some("Europe/Paris"));
            let calendar = detail.calendar.expect("its calendar");
            assert_eq!(calendar.icon.as_deref(), Some("Users"));
            assert_eq!(calendar.color.as_deref(), Some("raspberry"));
            Ok(())
        })
        .expect("a read");
}

#[test]
fn the_guests_a_phone_stated_are_read_back_beside_the_event() {
    let world = World::new();
    world.ok(
        "follow.calendar",
        json!({ "origin": { "ref": "calendar:work", "label": "Work", "device_id": "phone-1" },
                "complete": true,
                "records": [{ "external_id": "uid:1", "device_id": "phone-1", "fields": {
                    "title": "Sync", "starts": "2026-03-02T09:00", "ends": "2026-03-02T10:00",
                    "timing": "floating", "attendees": [
                        { "name": "Stranger", "email": "who@example.com", "state": "tentative" }
                    ] } }] }),
    );
    let zone = FireZone::named("Etc/UTC").expect("a zone");
    world
        .vault
        .read(|connection| {
            let door = TestDoor::new(connection);
            let (upcoming, _) = load_upcoming(
                &door,
                Some("2026-03-01T00:00:00.000Z"),
                Some("2026-03-31T00:00:00.000Z"),
                "2026-03-01T00:00:00.000Z",
                &zone,
            )
            .expect("reads");
            assert_eq!(upcoming.events.len(), 1);
            let (detail, _) =
                load_event(&door, &upcoming.events[0].event_id, None, None).expect("reads");
            assert_eq!(detail.followed_guests.len(), 1);
            assert_eq!(detail.followed_guests[0].state, "tentative");
            assert_eq!(
                detail.followed_guests[0].email.as_deref(),
                Some("who@example.com")
            );
            Ok(())
        })
        .expect("a read");
}

#[test]
fn an_items_attachments_are_a_keyset_page_that_leaves_out_the_trashed() {
    let world = World::new();
    let task = world.id("task.add", json!({ "title": "Fix the tap" }));
    let event = world.id(
        "event.propose",
        json!({ "title": "Plumber", "starts": "2026-03-02T09:00" }),
    );
    let mut ids = Vec::new();
    for at in 0..5 {
        let id = if at % 2 == 0 {
            world.photo(&format!("photo-{at}"))
        } else {
            world.document(&format!("Quote {at}"), &format!("doc-{at}"))
        };
        world.attach(&task, &id);
        ids.push(id);
    }
    world.attach(&event, &ids[0]);
    // A walk of pages of two reaches all five, once each, in the order of the attached file's id.
    let mut seen = Vec::new();
    let mut after = None;
    let mut pages = 0;
    loop {
        let page = world.page(&task, after, 2);
        assert!(page.attachments.len() <= 2, "the window bounds the page");
        seen.extend(page.attachments.iter().map(|row| row.attachment_id.clone()));
        pages += 1;
        match page.next {
            Some(next) => after = Some(next),
            None => break,
        }
    }
    let mut sorted = ids.clone();
    sorted.sort();
    assert_eq!(seen, sorted);
    assert_eq!(pages, 3);
    let first = world.page(&task, None, 100);
    let doc = first
        .attachments
        .iter()
        .find(|row| row.kind == "document")
        .expect("a document");
    assert!(
        doc.title
            .as_deref()
            .is_some_and(|title| title.starts_with("Quote"))
    );
    assert_eq!(doc.media_type, "application/pdf");
    assert!(doc.byte_size > 0 && doc.content_uri.ends_with(&doc.content_id));
    assert!(first.attachments.iter().any(|row| row.kind == "photo"));
    // The event holds one of them, and the two lists are the items' own.
    assert_eq!(world.page(&event, None, 10).attachments.len(), 1);
    // Detaching removes it; trashing the file hides it until restored.
    world.ok(
        "edge.remove",
        json!({ "from": task, "rel": "attached", "to": ids[1] }),
    );
    assert_eq!(world.page(&task, None, 100).attachments.len(), 4);
    world.ok("entity.trash", json!({ "id": ids[2] }));
    let page = world.page(&task, None, 100);
    assert_eq!(page.attachments.len(), 3);
    assert!(
        page.attachments
            .iter()
            .all(|row| row.attachment_id != ids[2])
    );
    world.ok("entity.restore", json!({ "id": ids[2] }));
    assert_eq!(world.page(&task, None, 100).attachments.len(), 4);
    // Absent is an answer: a missing id, a person and a trashed task answer no attachments.
    assert!(world.page("no-such-id", None, 10).attachments.is_empty());
    let mum = world.id("person.add", json!({ "title": "Mum" }));
    assert!(world.page(&mum, None, 10).attachments.is_empty());
    world.ok("entity.trash", json!({ "id": task }));
    assert!(world.page(&task, None, 10).attachments.is_empty());
}

#[test]
fn a_request_for_more_than_a_page_is_clamped() {
    let world = World::new();
    let task = world.id("task.add", json!({ "title": "Fix" }));
    for at in 0..3 {
        let id = world.photo(&format!("clamp-{at}"));
        world.attach(&task, &id);
    }
    let page = world.page(&task, None, 1_000_000);
    assert_eq!(page.attachments.len(), 3);
    assert!(page.next.is_none());
    let one = world.page(&task, None, 0);
    assert_eq!(
        one.attachments.len(),
        1,
        "a zero window is the smallest one"
    );
    assert!(one.next.is_some());
}
