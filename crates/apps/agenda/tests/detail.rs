//! THE DETAIL SCREEN'S READS (#1029, the phone-shell port): an event's place
//! NAME beside its id, and `event` — one event or one occurrence by id, so the
//! detail never depends on a padded `upcoming` window. Against a real vault,
//! written through the registered commands.

use centraid_apps_agenda::detail::load_event;
use centraid_apps_agenda::queries::load_upcoming;
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

    fn calendar_id(&self) -> String {
        self.vault
            .read(|connection| {
                Ok(connection.query_row(
                    "SELECT calendar_id FROM schedule_calendar LIMIT 1",
                    [],
                    |row| row.get(0),
                )?)
            })
            .expect("founding makes a calendar")
    }

    fn place(&self, place_id: &str, name: &str) {
        self.vault
            .commit(|tx| {
                tx.set_producer("test.fixture");
                tx.connection().execute(
                    "INSERT INTO core_place (place_id, name, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?3)",
                    rusqlite::params![place_id, name, NOW],
                )?;
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
