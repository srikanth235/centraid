//! THE DETAIL SCREEN'S READS (#1029, the phone-shell port): an event's place
//! NAME beside its id, and `event` — one event or one occurrence by id, so the
//! detail never depends on a padded `upcoming` window. Against a real vault,
//! written through the registered commands.

use centraid_apps_agenda::detail::{load_event, next_occurrence};
use centraid_apps_agenda::queries::load_upcoming;
use centraid_apps_kit::fixtures;
use centraid_apps_kit::testdoor::TestDoor;
use centraid_vault::Vault;
use centraid_vault::access::Principal;
use centraid_vault::commands::{Command, CommandStatus, Registry};
use centraid_vault::time::zone::FireZone;
use serde_json::{Value, json};

const FROM: &str = "2099-06-01T00:00:00.000Z";
const TO: &str = "2099-06-22T00:00:00.000Z";
const NOW: &str = "2099-06-01T09:00:00.000Z";

struct Scratch {
    dir: std::path::PathBuf,
    vault: Vault,
    registry: Registry,
}

impl Scratch {
    fn founded(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "centraid-agenda-detail-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |since| since.as_nanos())
        ));
        std::fs::create_dir_all(&dir).expect("the directory is made");
        let vault = Vault::create(dir.join("vault.db")).expect("a vault file");
        vault.found("Detail", "Owner").expect("founded");
        let registry = Registry::with_system_commands().expect("the system commands register");
        Self {
            dir,
            vault,
            registry,
        }
    }

    fn run(&self, name: &str, input: Value) -> Value {
        let outcome = self
            .vault
            .execute(
                &self.registry,
                &Principal::owner("agenda-detail-test"),
                &Command::new(name, input),
            )
            .unwrap_or_else(|error| panic!("{name} refused: {error}"));
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    /// The founding calendar, read through the app's own `upcoming` query.
    fn calendar_id(&self) -> String {
        self.vault
            .read(|connection| {
                let door = TestDoor::new(connection);
                let (data, _) =
                    load_upcoming(&door, Some(FROM), Some(TO), NOW, &utc()).expect("upcoming");
                Ok(data
                    .calendars
                    .first()
                    .expect("founding makes a calendar")
                    .calendar_id
                    .clone())
            })
            .expect("the read runs")
    }

    fn place(&self, place_id: &str, name: &str) {
        self.vault
            .commit(|tx| {
                tx.set_producer("test.fixture");
                fixtures::seed_place(tx.connection(), place_id, name, NOW)
                    .expect("the place row is written");
                Ok(())
            })
            .expect("the place lands");
    }

    fn propose(&self, input: Value) -> String {
        let mut input = input;
        input["calendar_id"] = json!(self.calendar_id());
        self.run("schedule.propose_event", input)["event_id"]
            .as_str()
            .expect("an event id")
            .to_owned()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn utc() -> FireZone {
    FireZone::named("Etc/UTC").expect("UTC is bundled")
}

#[test]
fn an_event_carries_its_place_name_on_upcoming_and_on_its_detail() {
    let scratch = Scratch::founded("place");
    scratch.place("place-cafe", "Blue Door Café");
    let event_id = scratch.propose(json!({
        "summary": "Coffee",
        "dtstart": "2099-06-03T09:00:00.000Z",
        "dtend": "2099-06-03T10:00:00.000Z",
        "location_place_id": "place-cafe",
    }));
    scratch
        .vault
        .read(|connection| {
            let door = TestDoor::new(connection);
            let (upcoming, _) =
                load_upcoming(&door, Some(FROM), Some(TO), NOW, &utc()).expect("upcoming");
            assert_eq!(
                upcoming.events[0].location_name.as_deref(),
                Some("Blue Door Café")
            );
            let (detail, denial) = load_event(&door, &event_id, None, None).expect("event");
            assert!(denial.is_none());
            let event = detail.event.expect("the event is there");
            assert_eq!(event.location_name.as_deref(), Some("Blue Door Café"));
            assert_eq!(event.instance_key, event_id);
            // THE CALENDAR ROW RIDES BESIDE IT (#1047), so a detail names the
            // calendar without reading `upcoming`.
            let calendar = detail.calendar.expect("the event's calendar");
            assert_eq!(
                Some(calendar.calendar_id.as_str()),
                event.calendar_id.as_deref()
            );
            assert_eq!(calendar.calendar_id, scratch.calendar_id());
            Ok(())
        })
        .expect("the read runs");
}

#[test]
fn the_detail_answers_one_occurrence_by_its_key_and_nothing_for_a_skip() {
    let scratch = Scratch::founded("occurrence");
    let event_id = scratch.propose(json!({
        "summary": "Standup",
        "dtstart": "2099-05-04T09:00:00",
        "dtend": "2099-05-04T09:30:00",
        "tz": "Asia/Kolkata",
        "rrule": "FREQ=DAILY",
    }));
    scratch.run(
        "schedule.edit_event_occurrence",
        json!({
            "event_id": event_id,
            "original_start_local": "2099-06-10T09:00:00",
            "scope": "occurrence",
            "action": "override",
            "summary": "Standup (moved room)",
        }),
    );
    scratch.run(
        "schedule.edit_event_occurrence",
        json!({
            "event_id": event_id,
            "original_start_local": "2099-06-11T09:00:00",
            "scope": "occurrence",
            "action": "skip",
        }),
    );
    scratch
        .vault
        .read(|connection| {
            let door = TestDoor::new(connection);
            let (by_local, _) =
                load_event(&door, &event_id, None, Some("2099-06-10T09:00:00")).expect("event");
            let occurrence = by_local.event.expect("the occurrence is there");
            assert_eq!(occurrence.dtstart, "2099-06-10T03:30:00.000Z");
            assert_eq!(occurrence.summary.as_deref(), Some("Standup (moved room)"));
            assert_eq!(
                occurrence.instance_key,
                format!("{event_id}:2099-06-10T09:00:00")
            );
            // The list's key alone names the same occurrence.
            let key = format!("{event_id}:2099-06-10T09:00:00");
            let (by_key, _) = load_event(&door, &event_id, Some(&key), None).expect("event");
            assert_eq!(
                by_key.event.map(|event| event.dtstart),
                Some(occurrence.dtstart)
            );
            // A skipped occurrence, an unknown one and an unknown id: absent.
            for (id, local) in [
                (event_id.as_str(), "2099-06-11T09:00:00"),
                (event_id.as_str(), "2099-06-10T10:00:00"),
                ("no-such-event", "2099-06-10T09:00:00"),
            ] {
                let (detail, _) = load_event(&door, id, None, Some(local)).expect("event");
                assert!(detail.event.is_none(), "{id} {local}");
            }
            Ok(())
        })
        .expect("the read runs");
}

/// WHERE A REPEATING SEARCH HIT OPENS (#1047): the first occurrence at or
/// after the vault clock; a one-off has none; a series that ended answers its
/// last occurrence.
#[test]
fn a_series_next_occurrence_is_the_first_after_now_else_its_last() {
    let scratch = Scratch::founded("next");
    let weekly = scratch.propose(json!({
        "summary": "Morning run",
        "dtstart": "2099-05-04T07:00:00.000Z",
        "dtend": "2099-05-04T08:00:00.000Z",
        "rrule": "FREQ=WEEKLY",
    }));
    let ended = scratch.propose(json!({
        "summary": "Evening class",
        "dtstart": "2099-03-02T18:00:00.000Z",
        "dtend": "2099-03-02T19:00:00.000Z",
        "rrule": "FREQ=WEEKLY;COUNT=3",
    }));
    let one_off = scratch.propose(json!({
        "summary": "Dentist",
        "dtstart": "2099-06-10T09:00:00.000Z",
        "dtend": "2099-06-10T10:00:00.000Z",
    }));
    scratch
        .vault
        .read(|connection| {
            let door = TestDoor::new(connection);
            let event = |event_id: &str| {
                load_event(&door, event_id, None, None)
                    .expect("event")
                    .0
                    .event
                    .expect("the series")
            };
            // NOW is Monday 1 June 09:00Z; the run is Mondays 07:00Z, so the
            // next one is 8 June.
            let next = next_occurrence(&door, &event(&weekly), NOW)
                .expect("expands")
                .expect("a next occurrence");
            assert!(
                next.dtstart.starts_with("2099-06-08T07:00"),
                "{}",
                next.dtstart
            );
            assert_eq!(
                next.instance_key,
                format!(
                    "{weekly}:{}",
                    next.original_start_local.as_deref().unwrap_or_default()
                )
            );
            let last = next_occurrence(&door, &event(&ended), NOW)
                .expect("expands")
                .expect("the last occurrence");
            assert!(
                last.dtstart.starts_with("2099-03-16T18:00"),
                "{}",
                last.dtstart
            );
            assert!(
                next_occurrence(&door, &event(&one_off), NOW)
                    .expect("no expansion")
                    .is_none()
            );
            Ok(())
        })
        .expect("the read runs");
}
