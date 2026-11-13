//! Agenda Wave 2's vault side (#1173): a task's link, a list's and a calendar's colour and icon, an
//! event's travel time and two alerts, what an Apple Reminders import carries, and what is attached
//! to a task or an event.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::commands::container::{LIST_COLORS, LIST_ICONS};
use centraid_vault::{Command, CommandStatus, Principal};
use serde_json::{Value, json};

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new() -> Self {
        Self {
            scratch: common::Scratch::founded_with_blobs("wave2").expect("a vault"),
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn run(&self, name: &str, input: Value) -> centraid_vault::CommandOutcome {
        self.scratch
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .unwrap_or_else(|error| panic!("`{name}`: {error}"))
    }

    fn ok(&self, name: &str, input: Value) -> Value {
        let outcome = self.run(name, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    fn refused(&self, name: &str, input: Value) -> String {
        let outcome = self.run(name, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Failed,
            "{name} was not refused"
        );
        outcome.reason.expect("a sentence")
    }

    fn id(&self, name: &str, input: Value) -> String {
        self.ok(name, input)["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    fn one<T: rusqlite::types::FromSql>(&self, sql: &str, params: &[&str]) -> T {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row(sql, rusqlite::params_from_iter(params), |r| r.get(0))?))
            .expect("a row")
    }

    fn bytes(&self, seed: &str) -> String {
        let hash = centraid_vault::blob::content_digest(seed.as_bytes());
        self.ok("blob.stage", json!({ "hash": hash, "size": seed.len() }));
        hash
    }

    fn photo(&self, seed: &str) -> String {
        let blob = self.bytes(seed);
        self.id(
            "photo.add",
            json!({ "blob": blob, "media_type": "image/jpeg" }),
        )
    }

    fn document(&self, title: &str, seed: &str) -> String {
        let blob = self.bytes(seed);
        self.id(
            "document.add",
            json!({ "title": title, "blob": blob, "media_type": "application/pdf" }),
        )
    }
}

// ---------------------------------------------------------------------------
// A task's link
// ---------------------------------------------------------------------------

#[test]
fn a_task_link_is_set_edited_and_cleared_and_a_blank_one_is_refused() {
    let w = World::new();
    let id = w.id(
        "task.add",
        json!({ "title": "Read", "url": "  https://example.com/a  " }),
    );
    assert_eq!(
        w.one::<Option<String>>("SELECT url FROM task WHERE id = ?1", &[&id])
            .as_deref(),
        Some("https://example.com/a"),
        "the link is kept trimmed"
    );
    w.ok(
        "task.edit",
        json!({ "id": id, "url": "https://example.com/b" }),
    );
    assert_eq!(
        w.one::<Option<String>>("SELECT url FROM task WHERE id = ?1", &[&id])
            .as_deref(),
        Some("https://example.com/b")
    );
    w.ok("task.edit", json!({ "id": id, "title": "Read it" }));
    assert_eq!(
        w.one::<Option<String>>("SELECT url FROM task WHERE id = ?1", &[&id])
            .as_deref(),
        Some("https://example.com/b"),
        "an edit that does not say the link leaves it"
    );
    assert!(
        w.refused("task.edit", json!({ "id": id, "url": "   " }))
            .contains("needs an address")
    );
    assert!(
        w.refused("task.add", json!({ "title": "X", "url": "" }))
            .contains("needs an address")
    );
    w.ok("task.edit", json!({ "id": id, "url": null }));
    assert_eq!(
        w.one::<Option<String>>("SELECT url FROM task WHERE id = ?1", &[&id]),
        None
    );
}

#[test]
fn the_next_occurrence_of_a_repeating_task_keeps_its_link() {
    let w = World::new();
    let id = w.id(
        "task.add",
        json!({ "title": "Water", "due": "2026-03-02", "rule": "FREQ=DAILY",
                "url": "https://example.com/plants" }),
    );
    let done = w.ok("task.complete", json!({ "id": id }));
    let next = done["next_id"].as_str().expect("a successor").to_owned();
    assert_eq!(
        w.one::<Option<String>>("SELECT url FROM task WHERE id = ?1", &[&next])
            .as_deref(),
        Some("https://example.com/plants")
    );
}

// ---------------------------------------------------------------------------
// What an Apple Reminders import carries
// ---------------------------------------------------------------------------

#[test]
fn a_reminders_import_fits_in_task_add_and_the_flag() {
    let w = World::new();
    let list = w.id(
        "container.create",
        json!({ "kind": "project", "title": "Groceries" }),
    );
    let parent = w.id(
        "task.add",
        json!({ "title": "Party", "project_id": list, "due": "2026-03-02" }),
    );
    let id = w.id(
        "task.add",
        json!({
            "title": "Buy cake",
            "project_id": list,
            "parent_id": parent,
            "due": "2026-03-02T09:30",
            "zone": "Europe/Paris",
            "priority": 5,
            "rule": "FREQ=WEEKLY",
            "remind_before_min": 15,
            "url": "https://shop.example/cake",
            "description": "the chocolate one",
        }),
    );
    w.ok("flag.set", json!({ "id": id, "flag": "starred" }));
    let row: (String, String, i64, String, i64, String, String, String) = w
        .scratch
        .vault
        .read(|c| {
            Ok(c.query_row(
                "SELECT due, zone, priority, rule, remind_before_min, url, project_id, parent_id
                   FROM task WHERE id = ?1",
                [&id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                    ))
                },
            )?)
        })
        .expect("the task");
    assert_eq!(row.0, "2026-03-02T09:30", "a due date AND time");
    assert_eq!(row.1, "Europe/Paris");
    assert_eq!((row.2, row.4), (5, 15));
    assert_eq!(row.3, "FREQ=WEEKLY");
    assert_eq!((row.6, row.7), (list, parent));
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel = 'tagged' AND to_id = 'flag:starred'",
            &[&id]
        ),
        1,
        "the flag"
    );
}

#[test]
fn a_completed_reminder_is_founded_done_with_its_completion_time() {
    let w = World::new();
    let id = w.id(
        "task.add",
        json!({ "title": "Old chore", "due": "2026-01-05", "done_at": "2026-01-04T18:00:00Z" }),
    );
    assert_eq!(
        w.one::<String>("SELECT status FROM task WHERE id = ?1", &[&id]),
        "done"
    );
    assert_eq!(
        w.one::<String>("SELECT done_at FROM task WHERE id = ?1", &[&id]),
        "2026-01-04T18:00:00.000Z"
    );
    let sentence = w.refused(
        "task.add",
        json!({ "title": "Bad", "done_at": "last tuesday" }),
    );
    assert!(sentence.contains("done_at"), "{sentence}");
    // A completed repeating item is a record, not a live series: it spawns nothing.
    let rec = w.id(
        "task.add",
        json!({ "title": "Done weekly", "due": "2026-01-05", "rule": "FREQ=WEEKLY",
                "done_at": "2026-01-05T08:00:00Z" }),
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM task WHERE series_id = ?1", &[&rec]),
        0
    );
}

// ---------------------------------------------------------------------------
// A list's and a calendar's colour and icon
// ---------------------------------------------------------------------------

#[test]
fn the_curated_icons_are_all_in_icons_toml_and_the_colours_are_the_list_palette() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let icons = std::fs::read_to_string(root.join("design/icons.toml")).expect("icons.toml");
    for key in LIST_ICONS {
        assert!(
            icons
                .lines()
                .any(|line| line.starts_with(&format!("{key} = "))),
            "`{key}` is not an icon of design/icons.toml"
        );
    }
    let mut sorted = LIST_ICONS.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), LIST_ICONS.len(), "no icon twice");
    let tokens = std::fs::read_to_string(root.join("design/tokens.toml")).expect("tokens.toml");
    let list: Vec<&str> = tokens
        .split("\n[list]\n")
        .nth(1)
        .and_then(|rest| rest.split("\n[").next())
        .expect("a [list] palette")
        .lines()
        .filter_map(|line| line.split_once(" = ").map(|(key, _)| key.trim()))
        .collect();
    assert_eq!(list, LIST_COLORS, "the palette's eight keys, in its order");
}

fn style_of(w: &World, id: &str) -> (Option<String>, Option<String>) {
    (
        w.one("SELECT color FROM container WHERE id = ?1", &[id]),
        w.one("SELECT icon FROM container WHERE id = ?1", &[id]),
    )
}

#[test]
fn a_list_is_made_renamed_and_styled() {
    let w = World::new();
    let list = w.id(
        "container.create",
        json!({ "kind": "project", "title": "Home", "color": "petrol", "icon": "Home" }),
    );
    assert_eq!(
        style_of(&w, &list),
        (Some("petrol".to_owned()), Some("Home".to_owned()))
    );
    w.ok("entity.retitle", json!({ "id": list, "title": "House" }));
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&list]),
        "House"
    );
    w.ok(
        "container.style",
        json!({ "id": list, "color": "orchid", "icon": "Heart" }),
    );
    assert_eq!(
        style_of(&w, &list),
        (Some("orchid".to_owned()), Some("Heart".to_owned()))
    );
    // A key that is absent is left alone; null clears.
    w.ok("container.style", json!({ "id": list, "color": "blue" }));
    assert_eq!(
        style_of(&w, &list),
        (Some("blue".to_owned()), Some("Heart".to_owned()))
    );
    w.ok("container.style", json!({ "id": list, "icon": null }));
    assert_eq!(style_of(&w, &list), (Some("blue".to_owned()), None));
    // The plain `list` kind wears the same.
    let plain = w.id(
        "container.create",
        json!({ "kind": "list", "title": "Wishes", "icon": "Gift" }),
    );
    assert_eq!(style_of(&w, &plain).1.as_deref(), Some("Gift"));
}

#[test]
fn a_calendar_is_made_renamed_and_styled() {
    let w = World::new();
    let cal = w.id(
        "container.create",
        json!({ "kind": "calendar", "title": "Family", "color": "raspberry", "icon": "Users" }),
    );
    assert_eq!(
        style_of(&w, &cal),
        (Some("raspberry".to_owned()), Some("Users".to_owned()))
    );
    w.ok("entity.retitle", json!({ "id": cal, "title": "Household" }));
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&cal]),
        "Household"
    );
    w.ok(
        "container.style",
        json!({ "id": cal, "color": "indigo", "icon": "Calendar" }),
    );
    assert_eq!(
        style_of(&w, &cal),
        (Some("indigo".to_owned()), Some("Calendar".to_owned()))
    );
    // An event can be put in the new calendar.
    let event = w.id(
        "event.propose",
        json!({ "title": "Dinner", "starts": "2026-03-02T19:00", "calendar_id": cal }),
    );
    assert_eq!(
        w.one::<String>("SELECT calendar_id FROM event WHERE id = ?1", &[&event]),
        cal
    );
}

#[test]
fn a_colour_an_icon_or_a_kind_that_is_not_the_palettes_is_refused_with_a_sentence() {
    let w = World::new();
    let list = w.id(
        "container.create",
        json!({ "kind": "project", "title": "P" }),
    );
    let cal = w.id(
        "container.create",
        json!({ "kind": "calendar", "title": "C" }),
    );
    let notebook = w.id(
        "container.create",
        json!({ "kind": "notebook", "title": "N" }),
    );
    for target in [&list, &cal] {
        let sentence = w.refused(
            "container.style",
            json!({ "id": target, "color": "#FF0000" }),
        );
        assert!(
            sentence.contains("not one of the list colours"),
            "{sentence}"
        );
        let sentence = w.refused("container.style", json!({ "id": target, "icon": "Trash" }));
        assert!(
            sentence.contains("not an icon a list can wear"),
            "{sentence}"
        );
        assert!(
            w.refused("container.style", json!({ "id": target }))
                .contains("say a colour or an icon")
        );
    }
    let sentence = w.refused(
        "container.style",
        json!({ "id": notebook, "color": "blue" }),
    );
    assert!(
        sentence.contains("notebook wears no colour or icon"),
        "{sentence}"
    );
    let sentence = w.refused(
        "container.create",
        json!({ "kind": "calendar", "title": "X", "color": "green" }),
    );
    assert!(
        sentence.contains("not one of the list colours"),
        "{sentence}"
    );
    let sentence = w.refused(
        "container.create",
        json!({ "kind": "project", "title": "X", "icon": "Nope" }),
    );
    assert!(
        sentence.contains("not an icon a list can wear"),
        "{sentence}"
    );
    let sentence = w.refused(
        "container.create",
        json!({ "kind": "notebook", "title": "X", "icon": "Home" }),
    );
    assert!(sentence.contains("does not wear an icon"), "{sentence}");
    assert!(
        !w.refused(
            "container.style",
            json!({ "id": "missing", "color": "blue" })
        )
        .is_empty()
    );
    // Nothing the refusals touched changed.
    assert_eq!(style_of(&w, &list), (None, None));
}

// ---------------------------------------------------------------------------
// An event's editor fields
// ---------------------------------------------------------------------------

#[test]
fn an_event_carries_travel_a_place_availability_a_zone_and_two_alerts() {
    let w = World::new();
    let place = w.id(
        "place.add",
        json!({ "title": "Office", "address": "1 Main St" }),
    );
    let id = w.id(
        "event.propose",
        json!({ "title": "Meeting", "starts": "2026-03-02T09:00", "ends": "2026-03-02T10:00",
                "zone": "Europe/Paris", "place_id": place, "busy": false, "travel_min": 25,
                "reminders": [30, 5] }),
    );
    let read = |w: &World| -> (
        Option<i64>,
        Option<String>,
        i64,
        String,
        Option<String>,
        String,
    ) {
        w.scratch
            .vault
            .read(|c| {
                Ok(c.query_row(
                    "SELECT travel_min, place_id, busy, timing, zone, (SELECT group_concat(offset_min) FROM (SELECT offset_min FROM reminder WHERE entity_id = ?1 ORDER BY offset_min)) FROM event WHERE id = ?1",
                    [&id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
                )?)
            })
            .expect("the event")
    };
    let (travel, at, busy, timing, zone, alerts) = read(&w);
    assert_eq!(travel, Some(25));
    assert_eq!(at.as_deref(), Some(place.as_str()));
    assert_eq!(busy, 0, "availability: free");
    assert_eq!(
        (timing.as_str(), zone.as_deref()),
        ("zoned", Some("Europe/Paris"))
    );
    assert_eq!(
        alerts, "5,30",
        "the first and the second alert, smallest first"
    );
    w.ok(
        "event.edit",
        json!({ "id": id, "travel_min": 40, "reminders": [60, 10], "busy": true }),
    );
    let (travel, _, busy, _, _, alerts) = read(&w);
    assert_eq!((travel, busy), (Some(40), 1));
    assert_eq!(alerts, "10,60");
    w.ok(
        "event.edit",
        json!({ "id": id, "travel_min": null, "place_id": null }),
    );
    let (travel, at, ..) = read(&w);
    assert_eq!((travel, at), (None, None), "set and clear");
    let negative = w.run("event.edit", json!({ "id": id, "travel_min": -5 }));
    assert_ne!(
        negative.status,
        CommandStatus::Executed,
        "a negative travel is refused"
    );
}

// ---------------------------------------------------------------------------
// Attachments on a task and an event
// ---------------------------------------------------------------------------

fn attached(w: &World, from: &str) -> i64 {
    w.one(
        "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel = 'attached'",
        &[from],
    )
}

#[test]
fn a_task_and_an_event_attach_and_detach_a_photo_and_a_document() {
    let w = World::new();
    let task = w.id("task.add", json!({ "title": "Fix" }));
    let event = w.id(
        "event.propose",
        json!({ "title": "Visit", "starts": "2026-03-02T09:00" }),
    );
    let photo = w.photo("tap");
    let doc = w.document("Quote", "quote");
    for from in [&task, &event] {
        for to in [&photo, &doc] {
            w.ok(
                "edge.add",
                json!({ "from": from, "rel": "attached", "to": to }),
            );
        }
        assert_eq!(attached(&w, from), 2);
        w.ok(
            "edge.remove",
            json!({ "from": from, "rel": "attached", "to": photo }),
        );
        assert_eq!(attached(&w, from), 1);
    }
    // A note's, a person's or another task's id is not something to attach.
    let other = w.id("task.add", json!({ "title": "Other" }));
    let sentence = w.refused(
        "edge.add",
        json!({ "from": task, "rel": "attached", "to": other }),
    );
    assert!(!sentence.is_empty());
}

#[test]
fn an_attachment_outlives_its_owner_in_the_trash_and_its_bytes_are_released_on_purge() {
    let w = World::new();
    let task = w.id("task.add", json!({ "title": "Fix" }));
    let photo = w.photo("tap-two");
    let blob: String = w.one("SELECT blob FROM photo WHERE id = ?1", &[&photo]);
    w.ok(
        "edge.add",
        json!({ "from": task, "rel": "attached", "to": photo }),
    );
    // The task is trashed: the attachment stays attached, the bytes stay.
    w.ok("entity.trash", json!({ "id": task }));
    assert_eq!(attached(&w, &task), 1);
    assert!(
        w.ok("blob.collect", json!({}))["released"]
            .as_array()
            .expect("a list")
            .is_empty()
    );
    w.ok("entity.restore", json!({ "id": task }));
    // Purging the photo while it is attached drops the edge with it and releases the bytes.
    w.ok("entity.trash", json!({ "id": photo }));
    let purged = w.ok("entity.purge", json!({ "id": photo }));
    assert!(
        purged["released"]
            .as_array()
            .expect("a list")
            .iter()
            .any(|hash| hash.as_str() == Some(&blob)),
        "the bytes nothing names any more are released: {purged}"
    );
    assert_eq!(attached(&w, &task), 0, "no edge points at a purged photo");
    // Purging the task drops its edges and leaves the document it held.
    let doc = w.document("Quote", "quote-two");
    w.ok(
        "edge.add",
        json!({ "from": task, "rel": "attached", "to": doc }),
    );
    w.ok("entity.trash", json!({ "id": task }));
    w.ok("entity.purge", json!({ "id": task }));
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM entity WHERE id = ?1", &[&doc]),
        1,
        "the document is its own thing"
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM edge WHERE to_id = ?1", &[&doc]),
        0
    );
}
