//! THE YEAR-3 AGENDA AXIS (#1020, D-1020-D3-7, D-1020-S4).
//!
//! v0's year-3 generator writes **no `core_event` rows at all** (#1020 apps
//! §5.2), so Agenda's five declared bounds — `EVENT_WINDOW_CAP`,
//! `RECURRING_ANCHOR_CAP`, `MAX_TOTAL_INSTANCES`, `PARTY_CAP` and `TASK_CAP` —
//! had no golden artifact behind them. [`centraid_apps_kit::fixtures::year3_agenda`]
//! is that artifact.
//!
//! The full run is `#[ignore]`d for the reason Docs' and Photos' are: it seeds
//! 12,000 events and is longer than the whole `local` gate budget. A SHRUNKEN
//! axis runs unignored, through the same statements, so the generator cannot
//! rot while the measured number waits for a machine.
//!
//! ## What the full profile is for, and the one thing it proves that the
//! shrunken one cannot
//!
//! **`MAX_TOTAL_INSTANCES` is reachable.** 800 daily series over a 19-day
//! window is roughly 15,000 occurrences; the cap is 1,500. So the year-3
//! agenda TRIPS it, and the bound has to report the size it reaches rather
//! than returning a short agenda that reads as a whole one (D-1020-D3-12). The
//! shrunken axis below trips it too, at a smaller shape — which is why it can
//! run in the gate.

use std::fs;
use std::path::{Path, PathBuf};

use centraid_apps_agenda::queries::{load_day_context, load_parties, load_upcoming};
use centraid_apps_kit::contract_vault::open_contract_vault;
use centraid_apps_kit::error::KitError;
use centraid_apps_kit::fixtures::{YEAR3_AGENDA, Year3AgendaShape, year3_agenda};
use centraid_apps_kit::testdoor::TestDoor;

/// The instant every case reads at.
const NOW: &str = "2026-03-06T00:00:00.000Z";
const SEED: u64 = 679_003;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .to_path_buf()
}

fn empty_vault() -> rusqlite::Connection {
    let ddl = fs::read_to_string(root().join("contracts/schema/vault-ddl.sql"))
        .expect("the committed DDL is readable");
    open_contract_vault(&ddl, "[]").expect("an empty fixture vault is built")
}

/// A hundredth of the year-3 shape: the same statements, the same DST anchor,
/// and small enough for the gate.
const SHRUNKEN: Year3AgendaShape = Year3AgendaShape {
    events: 260,
    recurring: 120,
    exceptions: 60,
    attendees: 200,
    calendars: 3,
    parties: 40,
    starred: 6,
    due_tasks: 120,
};

#[test]
fn the_shrunken_axis_seeds_and_every_query_reads_it() {
    let connection = empty_vault();
    let counts = year3_agenda(&connection, SHRUNKEN, SEED).expect("the axis seeds");
    assert_eq!(counts.events, SHRUNKEN.events);
    assert_eq!(counts.recurring, SHRUNKEN.recurring);
    assert_eq!(counts.calendars, SHRUNKEN.calendars);
    assert_eq!(counts.parties, SHRUNKEN.parties);
    assert_eq!(counts.starred, SHRUNKEN.starred);
    assert_eq!(counts.due_tasks, SHRUNKEN.due_tasks);

    let door = TestDoor::new(&connection);
    // A NARROW window, so the expansion stays under the cap and the rows can
    // be read.
    let (data, denial) = load_upcoming(
        &door,
        Some("2026-03-06T00:00:00.000Z"),
        Some("2026-03-08T00:00:00.000Z"),
        NOW,
    )
    .expect("a narrow window reads");
    assert!(denial.is_none());
    assert!(!data.events.is_empty(), "the agenda is not empty");
    assert_eq!(data.calendars.len(), SHRUNKEN.calendars);
    // Every expanded row carries the series' OWN id and an instance key that
    // is not it.
    for event in data
        .events
        .iter()
        .filter(|event| event.is_recurrence_instance)
    {
        assert!(
            event.instance_key.starts_with(&event.event_id),
            "{} does not carry its series",
            event.instance_key
        );
        assert_ne!(event.instance_key, event.event_id);
        assert!(event.original_start_local.is_some());
    }

    let (grid, denial) = load_day_context(&door, Some("2026-03-06"), Some("2026-04-06"), NOW)
        .expect("the grid reads");
    assert!(denial.is_none());
    assert!(!grid.birthdays.is_empty(), "the birthday rail is not empty");
    assert!(
        grid.birthdays
            .iter()
            .any(|birthday| birthday.tier == "inner"),
        "a starred party reads as `inner`"
    );
    assert!(!grid.due.is_empty(), "the due shelf is not empty");
    assert!(
        grid.due.iter().all(|due| due.tasks.len() <= 8),
        "a shelf LISTS at most SHELF_CAP"
    );

    let (directory, denial) = load_parties(&door).expect("the directory reads");
    assert!(denial.is_none());
    // The owner plus the guests, and the owner sorts first.
    assert_eq!(directory.parties.len(), SHRUNKEN.parties + 1);
    assert!(directory.parties[0].is_you);
}

/// THE CAP IS REACHABLE, AND IT REPORTS THE SIZE IT REACHES.
///
/// 120 daily series over a six-month window is tens of thousands of
/// occurrences against a cap of 1,500. v0 returns the first 1,500 and says nothing; the port errors naming
/// the number it stopped at, because a short agenda that reads as a whole one
/// is the truncation flag again (D-1020-D3-12).
#[test]
fn the_expansion_cap_errors_at_the_size_it_reaches() {
    let connection = empty_vault();
    year3_agenda(&connection, SHRUNKEN, SEED).expect("the axis seeds");
    let door = TestDoor::new(&connection);
    let error = load_upcoming(
        &door,
        Some("2026-03-06T00:00:00.000Z"),
        Some("2026-09-06T00:00:00.000Z"),
        NOW,
    )
    .expect_err("the cap is reached");
    match error {
        KitError::FanOutExceeded { query, cap } => {
            assert_eq!(query, "agenda.upcoming.expansion");
            assert_eq!(cap, centraid_apps_agenda::MAX_TOTAL_INSTANCES);
        }
        other => panic!("the wrong refusal: {other}"),
    }
}

/// THE MEASURED PROFILE. Ignored by default; run it with
/// `cargo test -p centraid-apps-agenda --test year3 -- --ignored --nocapture`
/// and record the numbers in the receipt as projected provenance.
#[test]
#[ignore = "seeds 12,000 events; longer than the whole local gate budget"]
fn the_year3_agenda_axis_measures_the_calendars_own_ceilings() {
    let connection = empty_vault();
    let counts = year3_agenda(&connection, YEAR3_AGENDA, SEED).expect("the axis seeds");
    assert_eq!(counts.events, YEAR3_AGENDA.events);
    assert_eq!(counts.recurring, YEAR3_AGENDA.recurring);
    let door = TestDoor::new(&connection);
    let narrow = load_upcoming(
        &door,
        Some("2026-03-06T00:00:00.000Z"),
        Some("2026-03-07T00:00:00.000Z"),
        NOW,
    )
    .expect("one day reads");
    println!(
        "year3 agenda: {} events, {} series, {} exceptions, one day = {} rows",
        counts.events,
        counts.recurring,
        counts.exceptions,
        narrow.0.events.len()
    );
    assert!(
        load_upcoming(
            &door,
            Some("2026-03-06T00:00:00.000Z"),
            Some("2026-09-06T00:00:00.000Z"),
            NOW,
        )
        .is_err(),
        "six months of a year-3 calendar reaches MAX_TOTAL_INSTANCES"
    );
}
