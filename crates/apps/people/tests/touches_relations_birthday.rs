//! #1146 wave 6 (M21, D8): a trashed touch stops counting, a relationship shows on both
//! people's sheets, and a birthday's reminder can be turned off.

use std::sync::Arc;

use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_people::dashboard::load_dashboard;
use centraid_apps_people::dates::{CivilDate, parse_instant};
use centraid_apps_people::person::{RelationDirection, load_person};
use centraid_apps_people::roster::{PeopleInput, load_people};
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
fn a_trashed_touch_stops_counting_toward_last_touch_the_log_and_the_dashboard() {
    let w = World::new();
    let ada = w.person("Ada", json!({ "cadence_days": 7 }));
    let first = w.ok("person.log_interaction", json!({ "id": ada, "kind": "call" }))
        ["interaction_id"]
        .as_str()
        .unwrap()
        .to_owned();
    w.clock.advance_days(3);
    let second = w.ok(
        "person.log_interaction",
        json!({ "id": ada, "kind": "met-up", "text": "coffee" }),
    )["interaction_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let last = |w: &World| {
        w.read(|door| load_people(door, PeopleInput::default()).expect("reads"))
            .0
            .people
            .iter()
            .find(|row| row.name == "Ada")
            .and_then(|row| row.last_contacted_at.clone())
    };
    assert_eq!(last(&w).as_deref(), Some("2026-01-04T00:00:00.000Z"));
    w.ok("entity.trash", json!({ "id": second }));
    assert_eq!(
        last(&w).as_deref(),
        Some("2026-01-01T00:00:00.000Z"),
        "the trashed touch no longer sets the last touch"
    );
    let sheet = w
        .read(|door| load_person(door, &ada).expect("reads"))
        .0
        .person
        .expect("a sheet");
    assert_eq!(
        sheet.touches.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        [first.as_str()],
        "nor does it sit in the log"
    );
    w.clock.advance_days(10);
    let now = parse_instant("2026-01-14T00:00:00.000Z").unwrap();
    let (dash, _) =
        w.read(|door| load_dashboard(door, CivilDate::new(2026, 1, 14), now).expect("reads"));
    assert_eq!(dash.recent.len(), 1, "nor the dashboard's rail");
    assert_eq!(dash.days_over.get(&ada), Some(&6), "13 days since the 1st, 7 allowed");
    // Restoring brings it back; trashing the last one leaves no touch at all.
    w.ok("entity.restore", json!({ "id": second }));
    assert_eq!(last(&w).as_deref(), Some("2026-01-04T00:00:00.000Z"));
    w.ok("entity.trash", json!({ "id": first }));
    w.ok("entity.trash", json!({ "id": second }));
    assert_eq!(last(&w), None);
}

#[test]
fn a_relationship_shows_on_both_sheets_each_read_from_its_own_side() {
    let w = World::new();
    let ada = w.person("Ada", json!({}));
    let beth = w.person("Beth", json!({}));
    // Ada lists Beth as her Mum: the edge runs Ada -> Beth, labelled by what Beth is to Ada.
    w.ok(
        "person.add_relationship",
        json!({ "id": ada, "related_id": beth, "name": "Beth", "kind": "Mum" }),
    );
    let relations = |id: &str| {
        w.read(|door| load_person(door, id).expect("reads"))
            .0
            .person
            .expect("a sheet")
            .relations
            .iter()
            .map(|r| (r.name.clone(), r.label.clone(), r.direction))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        relations(&ada),
        [("Beth".to_owned(), "Mum".to_owned(), RelationDirection::Outgoing)],
        "Ada's sheet: Beth is her Mum"
    );
    assert_eq!(
        relations(&beth),
        [("Ada".to_owned(), "Mum".to_owned(), RelationDirection::Incoming)],
        "Beth's sheet: she is Ada's Mum"
    );
    // A relative in the trash is not shown, and a pet is shown on its owner's sheet.
    w.ok(
        "person.add_relationship",
        json!({ "id": ada, "name": "Rex", "kind": "pet", "pet": "dog" }),
    );
    assert_eq!(relations(&ada).len(), 2);
    w.ok("entity.trash", json!({ "id": beth }));
    assert_eq!(
        relations(&ada).iter().map(|r| r.0.as_str()).collect::<Vec<_>>(),
        ["Rex"]
    );
}

#[test]
fn a_birthday_reminder_can_be_turned_off_and_back_on() {
    let w = World::new();
    let ada = w.person("Ada", json!({ "birthday": "01-20" }));
    let bob = w.person("Bob", json!({}));
    let reminder = |w: &World| {
        let sheet = w
            .read(|door| load_person(door, &ada).expect("reads"))
            .0
            .person
            .expect("a sheet");
        let on = sheet.dates.iter().find(|d| d.label == "Birthday").map(|d| d.reminder_on);
        let rostered = sheet.profile.reminders.iter().any(|r| r.label == "Birthday");
        let now = parse_instant("2026-01-12T00:00:00.000Z").unwrap();
        let (dash, _) = w
            .read(|door| load_dashboard(door, CivilDate::new(2026, 1, 12), now).expect("reads"));
        (on, rostered, dash.upcoming.len())
    };
    assert_eq!(reminder(&w), (Some(true), true, 1), "a birthday has its reminder by default");
    w.ok("person.set_birthday_reminder", json!({ "id": ada, "on": false }));
    assert_eq!(
        reminder(&w),
        (Some(false), false, 0),
        "off: the date stays, the reminder and the upcoming rail do not"
    );
    w.ok("person.set_birthday_reminder", json!({ "id": ada, "on": true }));
    assert_eq!(reminder(&w), (Some(true), true, 1));
    // A person with no birthday has no reminder to switch.
    let outcome = w
        .vault
        .execute(
            &w.registry,
            &Principal::owner("phone"),
            &Command::new("person.set_birthday_reminder", json!({ "id": bob, "on": false })),
        )
        .expect("runs");
    assert_eq!(outcome.status, CommandStatus::Failed);
}
