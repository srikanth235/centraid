//! `upcoming` ANSWERS NOTHING THAT WAS OVER BEFORE `from` ([#1046](https://github.com/srikanth235/centraid/issues/1046)).
//!
//! The storage window reaches 31 days before `from` to find a multi-day
//! event still running when the range opens. Recurrence now uses its actual
//! duration and exception windows; v0 bounded only one-offs afterwards, so
//! every series answered a month of its own past
//! (`tests/parity.rs`, `ENDED_BEFORE_FROM_PER_CASE`). This file holds the
//! bound against a REAL vault written through the registered commands: the
//! past is gone, the occurrence still running at `from` stays, and an empty
//! `from` is today in the REQUEST's zone rather than at 00:00Z.

use centraid_apps_agenda::queries::{EventRow, load_upcoming};
use centraid_apps_kit::testdoor::TestDoor;
use centraid_vault::Vault;
use centraid_vault::access::Principal;
use centraid_vault::commands::{Command, CommandStatus, Registry};
use centraid_vault::time::recurrence::parse_instant_ms;
use centraid_vault::time::zone::FireZone;
use serde_json::json;

const FROM: &str = "2099-06-01T00:00:00.000Z";
const TO: &str = "2099-06-22T00:00:00.000Z";

struct Scratch {
    dir: std::path::PathBuf,
    vault: Vault,
    registry: Registry,
}

impl Scratch {
    fn founded(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "centraid-agenda-bound-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |since| since.as_nanos())
        ));
        std::fs::create_dir_all(&dir).expect("the directory is made");
        let vault = Vault::create(dir.join("vault.db")).expect("a vault file");
        vault.found("Bound", "Owner").expect("founded");
        let registry = Registry::with_system_commands().expect("the system commands register");
        Self {
            dir,
            vault,
            registry,
        }
    }

    fn upcoming(
        &self,
        from: Option<&str>,
        to: Option<&str>,
        now: &str,
        zone: &str,
    ) -> Vec<EventRow> {
        let zone = FireZone::named(zone).expect("a real zone");
        self.vault
            .read(|connection| {
                let door = TestDoor::new(connection);
                let (data, denial) =
                    load_upcoming(&door, from, to, now, &zone).expect("upcoming reads");
                assert!(denial.is_none(), "the owner is not refused");
                Ok(data.events)
            })
            .expect("the read runs")
    }

    fn search_occurrence(&self, id: &str, now: &str) -> Option<EventRow> {
        self.vault
            .read(|connection| {
                let door = TestDoor::new(connection);
                let (detail, denial) =
                    centraid_apps_agenda::load_event(&door, id, None, None).unwrap();
                assert!(denial.is_none());
                Ok(centraid_apps_agenda::next_occurrence(
                    &door,
                    &detail.event.expect("the series exists"),
                    now,
                )
                .expect("search selects an occurrence"))
            })
            .unwrap()
    }

    /// A ZONED event in New York: its `zone` and a `Z` instant.
    fn propose(&self, summary: &str, dtstart: &str, dtend: &str, rrule: Option<&str>) -> String {
        let mut input = json!({
            "title": summary,
            "starts": dtstart,
            "ends": dtend,
            "zone": "America/New_York",
        });
        if let Some(rule) = rrule {
            input["rule"] = json!(rule);
        }
        let outcome = self
            .vault
            .execute(
                &self.registry,
                &Principal::owner("agenda-bound-test"),
                &Command::new("event.propose", input),
            )
            .expect("the proposal runs");
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{:?}",
            outcome.reason
        );
        outcome.output["id"].as_str().expect("event id").to_owned()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn ms(instant: &str) -> i64 {
    parse_instant_ms(instant).expect("an instant")
}

/// A weekly series anchored a year back, and a three-day run that began two
/// days before `from`: no occurrence ended before `from` is answered, and the
/// run still going at `from` is.
#[test]
fn nothing_answered_ended_before_from_and_a_running_occurrence_stays() {
    let scratch = Scratch::founded("past");
    // Five days after the offsite's anchor, so no run meets an offsite: the
    // command plane refuses a conflict.
    scratch.propose(
        "Morning run",
        "2098-06-05T11:00:00.000Z",
        "2098-06-05T12:00:00.000Z",
        Some("FREQ=WEEKLY"),
    );
    // Every fourth week, three days long: thirteen steps on, the occurrence
    // that starts on 2099-05-30 is still running on 1 June — and the one on
    // 2099-05-02, inside the reach-back, is long over.
    scratch.propose(
        "Offsite",
        "2098-05-31T13:00:00.000Z",
        "2098-06-03T13:00:00.000Z",
        Some("FREQ=WEEKLY;INTERVAL=4"),
    );
    let events = scratch.upcoming(Some(FROM), Some(TO), FROM, "America/New_York");
    let from = ms(FROM);
    for event in &events {
        let start = ms(&event.dtstart);
        let end = event.dtend.as_deref().map_or(start, ms);
        assert!(
            end > from || start >= from,
            "{} {} had ended before the range opened",
            event.summary.as_deref().unwrap_or_default(),
            event.dtstart
        );
    }
    assert_eq!(
        events
            .iter()
            .filter(|event| event.summary.as_deref() == Some("Morning run"))
            .count(),
        3,
        "three weeks in range, and none of the month before it"
    );
    let running: Vec<&EventRow> = events
        .iter()
        .filter(|event| event.summary.as_deref() == Some("Offsite"))
        .filter(|event| ms(&event.dtstart) < from)
        .collect();
    assert_eq!(
        running.len(),
        1,
        "the occurrence still running at `from` is what the reach-back is for"
    );
}

/// AN EMPTY `from` IS TODAY IN THE REQUEST ZONE. At 02:00Z on 2 June it is
/// still 1 June in New York, so an evening event there at 23:00Z on the 1st
/// (19:00 EDT) is today's and is answered; read at 00:00Z it would be gone.
#[test]
fn an_empty_from_is_the_first_instant_of_today_in_the_request_zone() {
    let scratch = Scratch::founded("today");
    scratch.propose(
        "Dinner",
        "2099-06-01T23:00:00.000Z",
        "2099-06-02T01:00:00.000Z",
        None,
    );
    scratch.propose(
        "Breakfast",
        "2099-06-01T11:00:00.000Z",
        "2099-06-01T12:00:00.000Z",
        None,
    );
    let now = "2099-06-02T02:00:00.000Z";
    let in_new_york: Vec<String> = scratch
        .upcoming(None, None, now, "America/New_York")
        .into_iter()
        .filter_map(|event| event.summary)
        .collect();
    assert_eq!(
        in_new_york,
        ["Breakfast", "Dinner"],
        "today in New York began at 04:00Z on the 1st"
    );
    let in_utc: Vec<String> = scratch
        .upcoming(None, None, now, "Etc/UTC")
        .into_iter()
        .filter_map(|event| event.summary)
        .collect();
    assert_eq!(
        in_utc,
        ["Dinner"],
        "today in UTC began at 00:00Z on the 2nd, when only dinner was still going"
    );
}

#[test]
fn hourly_series_budget_starts_at_the_visible_day_not_the_storage_lookback() {
    let scratch = Scratch::founded("hourly-window");
    scratch.propose(
        "Check",
        "2098-06-01T00:00:00.000Z",
        "2098-06-01T00:05:00.000Z",
        Some("FREQ=HOURLY"),
    );
    let events = scratch.upcoming(
        Some(FROM),
        Some("2099-06-02T00:00:00.000Z"),
        FROM,
        "Etc/UTC",
    );
    assert_eq!(events.len(), 24);
    assert_eq!(events.first().unwrap().dtstart, "2099-06-01T00:00:00.000Z");
    assert_eq!(events.last().unwrap().dtstart, "2099-06-01T23:00:00.000Z");
}

#[test]
fn a_dense_visible_series_reports_its_bound_instead_of_an_empty_or_short_day() {
    let scratch = Scratch::founded("minute-bound");
    scratch.propose(
        "Check",
        "2098-06-01T00:00:00.000Z",
        "2098-06-01T00:00:15.000Z",
        Some("FREQ=MINUTELY"),
    );
    let result = scratch
        .vault
        .read(|connection| {
            Ok(load_upcoming(
                &TestDoor::new(connection),
                Some(FROM),
                Some("2099-06-02T00:00:00.000Z"),
                FROM,
                &FireZone::named("Etc/UTC").unwrap(),
            ))
        })
        .unwrap();
    assert!(matches!(
        result,
        Err(centraid_apps_kit::error::KitError::FanOutExceeded { cap: 200, .. })
    ));
}

#[test]
fn a_named_minute_occurrence_opens_without_expanding_days_of_history() {
    let scratch = Scratch::founded("minute-detail");
    let id = scratch.propose(
        "Check",
        "2098-06-01T00:00:00.000Z",
        "2098-06-01T00:00:15.000Z",
        Some("FREQ=MINUTELY"),
    );
    let detail = scratch
        .vault
        .read(|connection| {
            Ok(centraid_apps_agenda::detail::load_event(
                &TestDoor::new(connection),
                &id,
                None,
                Some("2099-06-01T08:30:00"),
            ))
        })
        .unwrap()
        .unwrap()
        .0;
    assert_eq!(detail.event.unwrap().dtstart, "2099-06-01T12:30:00.000Z");
}

#[test]
fn search_opens_the_final_minute_of_a_finished_dense_series() {
    let scratch = Scratch::founded("minute-search-past");
    let id = scratch.propose(
        "One day of checks",
        "2099-06-01T00:00:00.000Z",
        "2099-06-01T00:00:15.000Z",
        Some("FREQ=MINUTELY;COUNT=1440"),
    );
    let last = scratch
        .search_occurrence(&id, "2099-06-02T12:00:00.000Z")
        .expect("the final occurrence is within the search reach");
    assert_eq!(last.dtstart, "2099-06-01T23:59:00.000Z");
    assert_eq!(
        last.original_start_local.as_deref(),
        Some("2099-06-01T19:59:00")
    );
}

#[test]
fn search_opens_a_running_minute_else_the_first_future_minute() {
    let scratch = Scratch::founded("minute-search-next");
    let id = scratch.propose(
        "Check",
        "2098-06-01T00:00:00.000Z",
        "2098-06-01T00:00:15.000Z",
        Some("FREQ=MINUTELY"),
    );
    assert_eq!(
        scratch
            .search_occurrence(&id, "2099-06-01T12:30:05.000Z")
            .unwrap()
            .dtstart,
        "2099-06-01T12:30:00.000Z"
    );
    assert_eq!(
        scratch
            .search_occurrence(&id, "2099-06-01T12:30:20.000Z")
            .unwrap()
            .dtstart,
        "2099-06-01T12:31:00.000Z"
    );
}
