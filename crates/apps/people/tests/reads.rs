//! What People reads, against a vault the product founds and People's own
//! commands fill: the roster, the dashboard, the sheet, the search and the trash
//! shelf, each asked through the paged door a phone's core asks through.

use std::sync::Arc;

use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_people::dashboard::load_dashboard;
use centraid_apps_people::dates::{CivilDate, parse_instant};
use centraid_apps_people::person::load_person;
use centraid_apps_people::roster::{PeopleInput, SearchHit, load_people, load_search, load_trash};
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
            Box::new(SeededIds::new("people")),
        )
        .expect("a vault")
        // Documents keep their bytes: a few tests attach one.
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

    fn person(&self, title: &str, extra: serde_json::Value) -> String {
        let mut input = json!({ "title": title });
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        self.ok("person.add", input)["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn read<T>(&self, body: impl FnOnce(&TestDoor<'_>) -> T) -> T {
        self.vault
            .read(|c| Ok(body(&TestDoor::new(c))))
            .expect("a read")
    }
}

#[test]
fn the_roster_carries_the_star_the_list_the_reminders_and_when_they_were_last_touched() {
    let w = World::new();
    let list = w.ok(
        "container.create",
        json!({ "kind": "list", "title": "Family" }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let ada = w.person("Ada", json!({ "role": "Mathematician", "birthday": "12-10", "cadence_days": 30, "list_id": list }));
    w.clock.advance_days(1);
    let bob = w.person("Bob", json!({}));
    w.ok(
        "person.add_relationship",
        json!({ "id": bob, "name": "Rex", "kind": "pet", "pet": "dog" }),
    );
    w.ok("flag.set", json!({ "id": ada, "flag": "starred" }));
    w.ok(
        "person.add_date",
        json!({ "id": ada, "label": "Anniversary", "month_day": "06-01", "reminder_on": true }),
    );
    w.ok(
        "person.add_date",
        json!({ "id": ada, "label": "Quiet day", "month_day": "07-01" }),
    );
    w.clock.advance_days(2);
    w.ok(
        "person.log_interaction",
        json!({ "id": ada, "kind": "call" }),
    );
    w.clock.advance_days(1);
    w.ok(
        "person.log_interaction",
        json!({ "id": ada, "kind": "met-up", "text": "coffee" }),
    );

    let (roster, denial) = w.read(|door| load_people(door, PeopleInput::default()).expect("reads"));
    assert!(denial.is_none() && !roster.truncated);
    let names: Vec<&str> = roster.people.iter().map(|row| row.name.as_str()).collect();
    assert_eq!(
        names,
        ["Bob", "Ada"],
        "newest added first; the owner and the pet are not in the circle"
    );
    let ada_row = &roster.people[1];
    assert!(ada_row.starred);
    assert_eq!(ada_row.list_id.as_deref(), Some(list.as_str()));
    assert_eq!(ada_row.cadence_days, 30);
    assert_eq!(
        ada_row.last_contacted_at.as_deref(),
        Some("2026-01-05T00:00:00.000Z"),
        "the newest touch"
    );
    let reminders: Vec<&str> = ada_row.reminders.iter().map(|r| r.label.as_str()).collect();
    assert_eq!(
        reminders,
        ["Anniversary", "Birthday"],
        "by day of the year: the birthday has one by default, the quiet day none"
    );
    assert_eq!(roster.people[0].last_contacted_at, None);
    assert_eq!(
        roster
            .lists
            .iter()
            .map(|l| l.name.as_str())
            .collect::<Vec<_>>(),
        ["Family"]
    );
    // A list in the trash is no list.
    w.ok("entity.trash", json!({ "id": list }));
    let (roster, _) = w.read(|door| load_people(door, PeopleInput::default()).expect("reads"));
    assert!(roster.lists.is_empty() && roster.people.iter().all(|row| row.list_id.is_none()));
}

#[test]
fn the_dashboard_says_who_is_overdue_what_is_coming_and_the_latest_touches() {
    let w = World::new();
    let ada = w.person("Ada", json!({ "cadence_days": 7, "birthday": "01-20" }));
    let bob = w.person("Bob", json!({ "cadence_days": 7 }));
    let cy = w.person("Cy", json!({}));
    w.ok(
        "person.log_interaction",
        json!({ "id": bob, "kind": "message", "text": "hello" }),
    );
    w.clock.advance_days(10);
    w.ok(
        "person.log_interaction",
        json!({ "id": ada, "kind": "call" }),
    );
    w.clock.advance_days(1);
    let now = parse_instant("2026-01-12T00:00:00.000Z").unwrap();
    let (dash, denial) =
        w.read(|door| load_dashboard(door, CivilDate::new(2026, 1, 12), now).expect("reads"));
    assert!(denial.is_none());
    // Ada was touched yesterday; Bob 11 days ago against a 7-day cadence; Cy has no cadence.
    assert_eq!(
        dash.reconnect
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>(),
        ["Bob"]
    );
    assert_eq!(dash.days_over.get(&bob), Some(&4));
    assert_eq!(dash.counts.all, 3);
    assert_eq!(dash.upcoming.len(), 1);
    assert_eq!(
        (dash.upcoming[0].label.as_str(), dash.upcoming[0].in_days),
        ("Birthday", 8)
    );
    let recent: Vec<(&str, &str, &str)> = dash
        .recent
        .iter()
        .map(|r| (r.card.name.as_str(), r.kind.as_str(), r.text.as_str()))
        .collect();
    assert_eq!(
        recent,
        [("Ada", "Call", ""), ("Bob", "Message", "hello")],
        "newest first, with the kind's title and what was said"
    );
    let _ = cy;
}

#[test]
fn a_sheet_has_the_contact_points_dates_notes_and_touches_of_one_person() {
    let w = World::new();
    let ada = w.person(
        "Ada",
        json!({ "nickname": "Countess", "met": "at a salon", "birthday": "1815-12-10" }),
    );
    let bob = w.person("Bob", json!({}));
    for (person, value) in [(&ada, "+44 20 7946 0958"), (&bob, "+442079460958")] {
        w.ok("person.save_contact_point", json!({ "id": person, "kind": "phone", "value": value, "label": "home", "preferred": true }));
    }
    w.ok(
        "person.add_note",
        json!({ "id": ada, "text": "likes engines" }),
    );
    w.ok(
        "person.log_interaction",
        json!({ "id": ada, "kind": "call", "text": "long call" }),
    );
    let owner = w.vault.self_id().unwrap().unwrap();
    let pet = w.ok(
        "person.add_relationship",
        json!({ "id": ada, "name": "Rex", "kind": "pet", "pet": "dog" }),
    )["related_id"]
        .as_str()
        .unwrap()
        .to_owned();

    let (data, denial) = w.read(|door| load_person(door, &ada).expect("reads"));
    assert!(denial.is_none());
    let sheet = data.person.expect("a sheet");
    assert_eq!(
        (sheet.nickname.as_str(), sheet.met.as_str()),
        ("Countess", "at a salon")
    );
    assert_eq!(sheet.contact.len(), 1);
    assert_eq!(
        sheet.contact[0].duplicate_names,
        ["Bob"],
        "the same number spelled another way is the same value"
    );
    assert!(sheet.contact[0].preferred);
    assert_eq!(
        sheet
            .dates
            .iter()
            .map(|d| (d.label.as_str(), d.month_day.as_str()))
            .collect::<Vec<_>>(),
        [("Birthday", "12-10")]
    );
    assert_eq!(
        sheet
            .notes
            .iter()
            .map(|n| n.text.as_str())
            .collect::<Vec<_>>(),
        ["likes engines"]
    );
    assert_eq!(
        sheet
            .touches
            .iter()
            .map(|t| (t.kind.as_str(), t.label.as_str(), t.text.as_str()))
            .collect::<Vec<_>>(),
        [("call", "Call", "long call")]
    );
    // No live person: an unknown id and a pet are not sheets. (The owner's own card is one,
    // below: My card.)
    let _ = &owner;
    for id in ["nobody", pet.as_str()] {
        assert!(
            w.read(|door| load_person(door, id).expect("reads"))
                .0
                .person
                .is_none(),
            "{id}"
        );
    }
    w.ok("entity.trash", json!({ "id": ada }));
    assert!(
        w.read(|door| load_person(door, &ada).expect("reads"))
            .0
            .person
            .is_none()
    );
}

#[test]
fn the_trash_shelf_and_the_search_answer_in_the_roster_s_shape() {
    let w = World::new();
    let ada = w.person("Ada", json!({ "role": "Mathematician" }));
    let bob = w.person("Bob", json!({}));
    w.ok("entity.trash", json!({ "id": bob }));
    let (shelf, denial) = w.read(|door| load_trash(door).expect("reads"));
    assert!(denial.is_none() && !shelf.truncated);
    assert_eq!(
        shelf
            .people
            .iter()
            .map(|row| row.name.as_str())
            .collect::<Vec<_>>(),
        ["Bob"]
    );
    assert!(shelf.people[0].purge_at.is_some());
    // The hits arrive ranked; a trashed person and the owner are hits of the index and no one here.
    let owner = w.vault.self_id().unwrap().unwrap();
    let hits: Vec<SearchHit> = [&bob, &owner, &ada]
        .into_iter()
        .map(|id| SearchHit {
            party_id: id.clone(),
            snippet: Some(format!("about {id}")),
        })
        .collect();
    let (found, _) = w.read(|door| load_search(door, &hits).expect("reads"));
    assert_eq!(found.people.len(), 1);
    assert_eq!(found.people[0].name, "Ada");
    assert_eq!(
        found.people[0].snippet.as_deref(),
        Some(format!("about {ada}").as_str())
    );
}

#[test]
fn an_empty_vault_answers_every_read_empty() {
    let w = World::new();
    let now = parse_instant("2026-06-01T00:00:00.000Z").unwrap();
    let (roster, denial) = w.read(|door| load_people(door, PeopleInput::default()).expect("reads"));
    assert!(denial.is_none() && roster.people.is_empty() && !roster.truncated);
    let (dash, _) =
        w.read(|door| load_dashboard(door, CivilDate::new(2026, 6, 1), now).expect("reads"));
    assert!(dash.reconnect.is_empty() && dash.upcoming.is_empty() && dash.recent.is_empty());
    assert!(
        w.read(|door| load_trash(door).expect("reads"))
            .0
            .people
            .is_empty()
    );
    assert!(
        w.read(|door| load_search(door, &[]).expect("reads"))
            .0
            .people
            .is_empty()
    );
}

#[test]
fn in_your_vault_is_what_else_is_about_the_person_events_tasks_notes_in_that_order_capped_by_kind()
{
    use centraid_apps_people::queries::VAULT_PER_KIND;
    let w = World::new();
    let ada = w.person("Ada", json!({}));
    let bob = w.person("Bob", json!({}));
    let event = |title: &str, extra: serde_json::Value| -> String {
        let mut input = json!({
            "title": title,
            "starts": "2026-11-07T12:30:00",
            "timing": "floating",
        });
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        w.ok("event.propose", input)["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    // Nothing yet: no links, and no "more".
    let links = |id: &str| {
        let (data, denial) = w.read(|door| load_person(door, id).expect("reads"));
        assert!(denial.is_none());
        data.person.expect("a sheet").vault
    };
    assert!(links(&ada).items.is_empty() && links(&ada).more == 0);

    // A guest of the event, and an event about them (the edge says so): both are theirs.
    w.clock.advance_days(1);
    let lunch = event("Lunch with Ada", json!({ "attendees": [ada] }));
    w.clock.advance_days(1);
    let about = event("Ada's talk", json!({}));
    w.ok(
        "edge.add",
        json!({ "from": about, "rel": "about", "to": ada }),
    );
    // Not theirs: a repeating event shows no start, a yearly date is a date, a cancelled
    // one is off the calendar, one in the trash is gone, and another person's is theirs.
    w.clock.advance_days(1);
    let standing = event(
        "Standing call",
        json!({ "attendees": [ada], "rule": "FREQ=WEEKLY" }),
    );
    w.ok(
        "person.add_date",
        json!({ "id": ada, "label": "Anniversary", "month_day": "06-01", "reminder_on": true }),
    );
    event(
        "Cancelled lunch",
        json!({ "attendees": [ada], "status": "cancelled" }),
    );
    let trashed = event("Old lunch", json!({ "attendees": [ada] }));
    w.ok("entity.trash", json!({ "id": trashed }));
    event("Bob's party", json!({ "attendees": [bob] }));

    // A task about them, a note that links to them; a note written about them is theirs in
    // People (`notes`), not a link from another app.
    w.clock.advance_days(1);
    let task = w.ok(
        "person.add_task",
        json!({ "id": ada, "text": "Send Ada the book" }),
    )["task_id"]
        .as_str()
        .unwrap()
        .to_owned();
    w.clock.advance_days(1);
    let note = w.ok(
        "note.create",
        json!({ "title": "Chess night", "body": "with Ada" }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    w.ok(
        "edge.add",
        json!({ "from": note, "rel": "links", "to": ada }),
    );
    w.ok(
        "person.add_note",
        json!({ "id": ada, "text": "likes engines" }),
    );

    let seen = links(&ada);
    assert_eq!(seen.more, 0);
    assert_eq!(
        seen.items
            .iter()
            .map(|item| (item.kind.key(), item.title.as_str()))
            .collect::<Vec<_>>(),
        [
            ("event", "Standing call"),
            ("event", "Ada's talk"),
            ("event", "Lunch with Ada"),
            ("task", "Send Ada the book"),
            ("note", "Chess night"),
        ],
        "events, tasks, notes; newest first within a kind"
    );
    let by_id = |id: &str| seen.items.iter().find(|item| item.id == id).unwrap();
    assert_eq!(
        by_id(&lunch).starts.as_deref(),
        Some("2026-11-07T12:30:00"),
        "an event carries its start"
    );
    assert_eq!(by_id(&lunch).timing.as_deref(), Some("floating"));
    assert_eq!(
        by_id(&standing).starts,
        None,
        "a repeating event has no one start"
    );
    assert_eq!(
        (by_id(&task).starts.clone(), by_id(&note).starts.clone()),
        (None, None)
    );
    // Bob has his own: only his party.
    assert_eq!(
        links(&bob)
            .items
            .iter()
            .map(|i| i.title.as_str())
            .collect::<Vec<_>>(),
        ["Bob's party"]
    );

    // The cap is by kind: five more tasks, three shown, and the rest counted.
    for n in 0..5 {
        w.clock.advance_days(1);
        w.ok(
            "person.add_task",
            json!({ "id": ada, "text": format!("Task {n}") }),
        );
    }
    let capped = links(&ada);
    let tasks: Vec<&str> = capped
        .items
        .iter()
        .filter(|item| item.kind.key() == "task")
        .map(|item| item.title.as_str())
        .collect();
    assert_eq!(
        tasks,
        ["Task 4", "Task 3", "Task 2"],
        "newest first, {VAULT_PER_KIND} of them"
    );
    assert_eq!(capped.more, 3, "6 tasks - 3 shown");
    assert_eq!(capped.items.len(), 3 + 3 + 1, "3 events, 3 tasks, 1 note");
    assert_eq!(
        capped
            .items
            .iter()
            .map(|i| i.kind.key())
            .collect::<Vec<_>>(),
        ["event", "event", "event", "task", "task", "task", "note"],
        "the kinds stay in order after the cap"
    );
}

#[test]
fn in_your_vault_lists_the_documents_attached_to_the_person_or_to_what_is_about_them() {
    let w = World::new();
    let ada = w.person("Ada", json!({}));
    let bob = w.person("Bob", json!({}));
    let links = |id: &str| {
        let (data, denial) = w.read(|door| load_person(door, id).expect("reads"));
        assert!(denial.is_none());
        data.person.expect("a sheet").vault
    };
    let document = |title: &str| -> String {
        w.ok(
            "document.create_text",
            json!({ "title": title, "body_text": title, "media_type": "text/plain" }),
        )["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    // Nothing attached: nothing listed.
    assert!(links(&ada).items.is_empty());

    let lunch = w.ok(
        "event.propose",
        json!({ "title": "Lunch with Ada", "starts": "2026-11-07T12:30:00", "timing": "floating",
                "attendees": [ada] }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let passport = document("Passport scan");
    let menu = document("Menu");
    let gone = document("Old receipt");
    let elsewhere = document("Bob's lease");
    let both = document("Both");
    w.ok("edge.add", json!({ "from": ada, "rel": "attached", "to": passport }));
    w.ok("edge.add", json!({ "from": lunch, "rel": "attached", "to": menu }));
    w.ok("edge.add", json!({ "from": lunch, "rel": "attached", "to": gone }));
    w.ok("entity.trash", json!({ "id": gone }));
    w.ok("edge.add", json!({ "from": bob, "rel": "attached", "to": elsewhere }));
    w.ok("edge.add", json!({ "from": ada, "rel": "attached", "to": both }));
    w.ok("edge.add", json!({ "from": lunch, "rel": "attached", "to": both }));

    let seen = links(&ada);
    let docs: Vec<(&str, Option<&str>)> = seen
        .items
        .iter()
        .filter(|item| item.kind.key() == "document")
        .map(|item| (item.title.as_str(), item.via.as_deref()))
        .collect();
    assert_eq!(docs.len(), 3, "{docs:?}: a trashed one and Bob's are not Ada's");
    assert!(docs.contains(&("Passport scan", None)), "attached to the person");
    assert!(docs.contains(&("Menu", Some("Lunch with Ada"))), "attached to their event");
    assert!(
        docs.contains(&("Both", None)),
        "attached to both: once, and the person's own"
    );
    assert_eq!(
        seen.items.last().map(|item| item.kind.key()),
        Some("document"),
        "documents come after events, tasks and notes"
    );
    assert_eq!(
        links(&bob)
            .items
            .iter()
            .map(|item| item.title.as_str())
            .collect::<Vec<_>>(),
        ["Bob's lease"]
    );
}

#[test]
fn the_owner_s_own_card_is_a_sheet_and_the_roster_names_the_owner_apart() {
    let w = World::new();
    let ada = w.person("Ada", json!({}));
    let owner = w.vault.self_id().unwrap().unwrap();
    let (mine, denial) = w.read(|door| load_person(door, &owner).expect("reads"));
    assert!(denial.is_none());
    let mine = mine.person.expect("My card is a sheet");
    assert!(mine.is_me);
    assert_eq!(mine.profile.party_id, owner);
    let (hers, _) = w.read(|door| load_person(door, &ada).expect("reads"));
    assert!(!hers.person.expect("a sheet").is_me);
    // The circle still leaves the owner out; the roster says who they are.
    let (roster, _) = w.read(|door| load_people(door, PeopleInput::default()).expect("reads"));
    assert_eq!(
        roster
            .people
            .iter()
            .map(|p| p.party_id.as_str())
            .collect::<Vec<_>>(),
        [ada.as_str()]
    );
    let card = roster.owner.expect("an owner card");
    assert_eq!(card.party_id, owner);
    assert_eq!(card.name, mine.profile.name);
}
