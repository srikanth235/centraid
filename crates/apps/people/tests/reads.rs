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
        .expect("a vault");
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
        "by day of the year: the birthday always has one, the quiet day none"
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
    // No live person: an unknown id, the owner and a pet are not sheets.
    for id in ["nobody", owner.as_str(), pet.as_str()] {
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
