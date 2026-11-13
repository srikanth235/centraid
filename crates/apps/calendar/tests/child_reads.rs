//! The rows an event carries beside its own (its guests, its alerts, the days of a series that
//! were moved), read for a window of events a page at a time.
//!
//! A page of these reads holds [`WIDE`](centraid_apps_calendar::queries::WIDE) rows. A read keyed
//! on the event's id alone loses the rest of an event's rows where a page ends inside them; these
//! tests seed more rows than one page holds and count the pages the walk took.

use std::cell::RefCell;

use centraid_apps_calendar::load_upcoming;
use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::page::{Page, PageRequest};
use centraid_apps_kit::reads::PageDoor;
use centraid_apps_kit::row::Row;
use centraid_apps_kit::statement::PageQuery;
use centraid_apps_kit::testdoor::TestDoor;
use centraid_vault::commands::Registry;
use centraid_vault::time::zone::FireZone;
use centraid_vault::{Command, CommandStatus, Principal, Vault};
use serde_json::{Value, json};

/// A page holds this many rows (`queries::WIDE`'s page size).
const PAGE: usize = 500;

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

    fn id(&self, name: &str, input: Value) -> String {
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
        outcome.output["id"].as_str().expect("an id").to_owned()
    }

    fn guests(&self, count: usize) -> Vec<String> {
        (0..count)
            .map(|at| self.id("person.add", json!({ "title": format!("Guest {at:04}") })))
            .collect()
    }

    fn event(&self, title: &str, month: u32, day: u32, fields: Value) -> String {
        let mut input = json!({
            "title": title,
            "starts": format!("2026-{month:02}-{day:02}T09:00"),
            "ends": format!("2026-{month:02}-{day:02}T10:00"),
            "zone": "Etc/UTC",
        });
        for (key, value) in fields.as_object().expect("fields").clone() {
            input[key] = value;
        }
        self.id("event.propose", input)
    }
}

/// A door that records the name of every page it answers.
struct Counting<'a> {
    inner: TestDoor<'a>,
    names: RefCell<Vec<String>>,
}

impl PageDoor for Counting<'_> {
    fn page(&self, query: &PageQuery, request: &PageRequest) -> KitResult<Page<Row>> {
        let page = self.inner.page(query, request)?;
        self.names
            .borrow_mut()
            .push(format!("{} x{}", query.name, page.rows.len()));
        Ok(page)
    }
}

/// A month of 2026 as the Agenda reads it: its events, and the name of every page the read took.
fn month(
    world: &World,
    month: u32,
) -> (Vec<centraid_apps_calendar::queries::EventRow>, Vec<String>) {
    let zone = FireZone::named("Etc/UTC").expect("a zone");
    world
        .vault
        .read(|connection| {
            let door = Counting {
                inner: TestDoor::new(connection),
                names: RefCell::new(Vec::new()),
            };
            let (upcoming, denial) = load_upcoming(
                &door,
                Some(&format!("2026-{month:02}-01T00:00:00.000Z")),
                Some(&format!("2026-{:02}-01T00:00:00.000Z", month + 1)),
                &format!("2026-{month:02}-01T00:00:00.000Z"),
                &zone,
            )
            .expect("reads");
            assert!(denial.is_none());
            Ok((upcoming.events, door.names.into_inner()))
        })
        .expect("a read")
}

fn pages_of(names: &[String], read: &str) -> usize {
    names
        .iter()
        .filter(|name| name.starts_with(&format!("{read} x")))
        .count()
}

fn titled<'a>(
    events: &'a [centraid_apps_calendar::queries::EventRow],
    title: &str,
) -> &'a centraid_apps_calendar::queries::EventRow {
    events
        .iter()
        .find(|event| event.summary.as_deref() == Some(title))
        .expect("the event is in the window")
}

/// One vault for both guest tests: a guest is a person, and a person costs a command.
#[test]
fn the_guests_of_an_event_survive_a_page_that_ends_inside_them_or_between_two_events() {
    let world = World::new();
    let people = world.guests(PAGE + 1);

    // January: one event with more guests than a page holds.
    world.event("Party", 1, 2, json!({ "attendees": people }));
    let (events, names) = month(&world, 1);
    let party = titled(&events, "Party");
    assert_eq!(party.attendees.len(), PAGE + 1, "every guest comes back");
    let named: Vec<&str> = party
        .attendees
        .iter()
        .map(|each| each.name.as_str())
        .collect();
    let mut ordered = named.clone();
    ordered.sort_unstable();
    assert_eq!(named, ordered, "in their order");
    assert_eq!(
        party
            .attendees
            .iter()
            .map(|each| each.party_id.as_str())
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        PAGE + 1,
        "none twice"
    );
    assert_eq!(
        pages_of(&names, "calendar.events.guests"),
        2,
        "a full page and the one row after it"
    );

    // June: the first page ends exactly where two events end.
    let half = &people[..PAGE / 2];
    world.event("First", 6, 2, json!({ "attendees": half }));
    world.event("Second", 6, 3, json!({ "attendees": half }));
    world.event("Third", 6, 4, json!({ "attendees": [half[0]] }));
    let (events, names) = month(&world, 6);
    assert_eq!(titled(&events, "First").attendees.len(), PAGE / 2);
    assert_eq!(titled(&events, "Second").attendees.len(), PAGE / 2);
    assert_eq!(titled(&events, "Third").attendees.len(), 1);
    assert_eq!(pages_of(&names, "calendar.events.guests"), 2, "{names:?}");
}

#[test]
fn an_event_with_more_alerts_than_a_page_holds_keeps_every_alert() {
    let world = World::new();
    let minutes: Vec<i64> = (1..=i64::try_from(PAGE).expect("small") + 1).collect();
    world.event("Reminded", 3, 2, json!({ "reminders": minutes }));
    let (events, names) = month(&world, 3);
    assert_eq!(
        titled(&events, "Reminded").reminders,
        minutes.iter().rev().copied().collect::<Vec<_>>(),
        "every alert, longest lead first"
    );
    assert_eq!(pages_of(&names, "calendar.events.reminders"), 2);
}
