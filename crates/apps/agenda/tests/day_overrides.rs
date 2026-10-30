//! A MOVED DAY READS UNDER ITS OWN TIMING, LINK AND PLACE ([#1146](https://github.com/srikanth235/centraid/issues/1146)).
//!
//! H5 and D6, against a REAL vault written through the registered commands and read through the
//! ported statements: an all-day series' day moved to 15:00 is a timed row at 15:00, a zoned
//! series' day made all-day is a date, and a day that names its own link and place shows them
//! while its neighbours show the series'. D7: a followed phone calendar is listed with the
//! colour the phone paints it.

use centraid_apps_agenda::local::place;
use centraid_apps_agenda::queries::{EventRow, load_upcoming};
use centraid_apps_kit::testdoor::TestDoor;
use centraid_vault::Vault;
use centraid_vault::access::Principal;
use centraid_vault::commands::{Command, CommandStatus, Registry};
use centraid_vault::time::recurrence::Semantics;
use centraid_vault::time::zone::FireZone;
use serde_json::{Value, json};

const FROM: &str = "2099-06-01T00:00:00.000Z";
const TO: &str = "2099-06-22T00:00:00.000Z";
const NOW: &str = "2099-06-01T09:00:00.000Z";

fn utc() -> FireZone {
    FireZone::named("Etc/UTC").expect("UTC is in the bundled database")
}

struct Scratch {
    dir: std::path::PathBuf,
    vault: Vault,
    registry: Registry,
}

impl Scratch {
    fn founded(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "centraid-agenda-days-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |since| since.as_nanos())
        ));
        std::fs::create_dir_all(&dir).expect("the directory is made");
        let vault = Vault::create(dir.join("vault.db")).expect("a vault file");
        vault.found("Days", "Owner").expect("founded");
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
                &Principal::owner("agenda-days-test"),
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

    fn id(&self, name: &str, input: Value) -> String {
        self.run(name, input)["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    fn rows(&self) -> (Vec<EventRow>, Vec<(String, Option<String>)>) {
        self.vault
            .read(|connection| {
                let door = TestDoor::new(connection);
                let (data, denial) = load_upcoming(&door, Some(FROM), Some(TO), NOW, &utc())
                    .expect("upcoming reads");
                assert!(denial.is_none(), "the owner is not refused");
                let calendars = data
                    .calendars
                    .into_iter()
                    .filter_map(|calendar| Some((calendar.name?, calendar.color)))
                    .collect();
                Ok((data.events, calendars))
            })
            .expect("the read runs")
    }

    fn day(&self, key: &str) -> EventRow {
        self.rows()
            .0
            .into_iter()
            .find(|row| row.original_start_local.as_deref() == Some(key))
            .unwrap_or_else(|| panic!("the day {key} is on the agenda"))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn an_all_day_series_day_moved_to_a_time_is_a_timed_row_at_that_time() {
    let scratch = Scratch::founded("all-day-moved");
    let series = scratch.id(
        "event.propose",
        json!({ "title": "Trash day", "starts": "2099-06-01", "timing": "all-day",
                "rule": "FREQ=WEEKLY" }),
    );
    scratch.run(
        "event.edit_occurrence",
        json!({ "id": series, "original_start": "2099-06-08", "scope": "occurrence",
                "action": "override", "timing": "floating",
                "starts": "2099-06-08T15:00", "ends": "2099-06-08T16:00" }),
    );
    let moved = scratch.day("2099-06-08");
    assert_eq!(
        moved.semantics(),
        Semantics::Floating,
        "the day reads as a clock"
    );
    assert_eq!(moved.dtstart, "2099-06-08T15:00");
    assert_eq!(moved.dtend.as_deref(), Some("2099-06-08T16:00"));
    let placed = place(&moved, &utc()).expect("it places");
    assert!(
        !placed.all_day,
        "a day moved to 15:00 is not an all-day day"
    );
    assert_eq!(placed.local_start, "2099-06-08T15:00");
    // The neighbours are the series' own.
    let kept = scratch.day("2099-06-15");
    assert_eq!(kept.semantics(), Semantics::AllDay);
    assert_eq!(kept.dtstart, "2099-06-15");
}

#[test]
fn a_zoned_series_day_made_all_day_is_a_date_with_no_borrowed_length() {
    let scratch = Scratch::founded("zoned-all-day");
    let series = scratch.id(
        "event.propose",
        json!({ "title": "Standup", "starts": "2099-06-01T09:00", "ends": "2099-06-01T09:30",
                "zone": "Europe/Paris", "rule": "FREQ=WEEKLY" }),
    );
    scratch.run(
        "event.edit_occurrence",
        json!({ "id": series, "original_start": "2099-06-08T09:00:00", "scope": "occurrence",
                "action": "override", "timing": "all-day", "starts": "2099-06-08" }),
    );
    let moved = scratch.day("2099-06-08T09:00:00");
    assert_eq!(moved.semantics(), Semantics::AllDay);
    assert_eq!(moved.dtstart, "2099-06-08");
    assert_eq!(
        moved.dtend, None,
        "the series' half hour is not this day's length"
    );
    let placed = place(&moved, &utc()).expect("it places");
    assert!(placed.all_day);
    assert_eq!(placed.local_days, ["2099-06-08"]);
    let kept = scratch.day("2099-06-15T09:00:00");
    assert_eq!(kept.semantics(), Semantics::Zoned);
}

#[test]
fn one_day_shows_its_own_link_and_place_and_its_neighbours_the_series() {
    let scratch = Scratch::founded("link-place");
    let hall = scratch.id("place.add", json!({ "title": "Main hall" }));
    let room = scratch.id("place.add", json!({ "title": "Room B" }));
    let series = scratch.id(
        "event.propose",
        json!({ "title": "Standup", "starts": "2099-06-01T09:00", "ends": "2099-06-01T09:30",
                "zone": "Europe/Paris", "rule": "FREQ=WEEKLY", "place_id": hall,
                "url": "https://meet.example/a" }),
    );
    scratch.run(
        "event.edit_occurrence",
        json!({ "id": series, "original_start": "2099-06-08T09:00:00", "scope": "occurrence",
                "action": "override", "url": "https://meet.example/b", "place_id": room }),
    );
    let moved = scratch.day("2099-06-08T09:00:00");
    assert_eq!(
        moved.conferencing_uri.as_deref(),
        Some("https://meet.example/b")
    );
    assert_eq!(moved.location_place_id.as_deref(), Some(room.as_str()));
    assert_eq!(moved.location_name.as_deref(), Some("Room B"));
    let kept = scratch.day("2099-06-15T09:00:00");
    assert_eq!(
        kept.conferencing_uri.as_deref(),
        Some("https://meet.example/a")
    );
    assert_eq!(kept.location_name.as_deref(), Some("Main hall"));
}

#[test]
fn a_followed_phone_calendar_is_listed_by_name_with_the_phone_s_colour() {
    let scratch = Scratch::founded("calendars");
    scratch.run(
        "follow.calendar",
        json!({ "origin": { "ref": "calendar:work", "label": "iCloud: Work",
                             "device_id": "phone-1", "color": "var(--c-rose)" },
                 "complete": true,
                 "records": [{ "external_id": "uid:1", "fields": {
                     "title": "Review", "starts": "2099-06-03T09:00:00",
                     "ends": "2099-06-03T10:00:00", "zone": "Europe/Paris" } }] }),
    );
    let (events, calendars) = scratch.rows();
    assert!(
        calendars.contains(&("iCloud: Work".to_owned(), Some("var(--c-rose)".to_owned()))),
        "{calendars:?}"
    );
    let review = events
        .iter()
        .find(|row| row.summary.as_deref() == Some("Review"));
    let on = review
        .and_then(|row| row.calendar_id.clone())
        .expect("a calendar");
    assert_ne!(on, "calendar:default", "the event is on its phone calendar");
}
