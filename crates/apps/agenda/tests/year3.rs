//! YEAR-3 AGENDA VOLUME ([#1135](https://github.com/srikanth235/centraid/issues/1135)).
//!
//! `centraid_apps_kit::fixtures::year3_events` writes the profile `YEAR3_EVENTS`
//! declares: 12,000 events (2,000 all-day), 800 DAILY series (600 with moved and
//! cancelled occurrences), cancelled and trashed events and 3,000 with guests.
//! This suite states two truths. A realistic calendar (a few dozen series, a
//! handful daily) answers its default window WHOLE. The year-3 calendar TRIPS
//! `MAX_TOTAL_INSTANCES`, and the read errors naming the size it reaches
//! (`FanOutExceeded`, which the core answers as `ReadBoundReached` and the shell
//! shows as "too much to show at once") rather than returning a short agenda
//! that reads as a whole one (D-1020-D3-12).
//!
//! **A timing here is a DEBUG build** and is projected provenance, never a ceiling.

use std::sync::Arc;
use std::time::Instant;

use centraid_apps_agenda::queries::load_upcoming;
use centraid_apps_kit::error::KitError;
use centraid_apps_kit::fixtures::{
    YEAR3_EVENTS, Year3EventsCounts, Year3EventsShape, year3_events,
};
use centraid_apps_kit::testdoor::TestDoor;
use centraid_vault::Vault;
use centraid_vault::clock::{FixedClock, SeededIds};
use centraid_vault::time::zone::FireZone;

const SEED: u64 = 1_135_004;
const NOW: &str = "2025-06-02T09:00:00.000Z";
const FROM: &str = "2025-06-02T00:00:00.000Z";
const TO: &str = "2025-07-16T00:00:00.000Z";

/// A realistic calendar in the SHAPE of the declared profile; a field added to
/// the shape fails this literal rather than being inherited silently.
const REALISTIC: Year3EventsShape = Year3EventsShape {
    timed: 2_400,
    all_day: 600,
    series: 30,
    daily: 3,
    overridden: 10,
    cancelled: 90,
    trashed: 60,
    guests: 100,
    guested: 900,
};

/// A tenth of the declared profile, still every series daily: the same bound
/// trip, small enough for the gate.
const SHRUNKEN: Year3EventsShape = Year3EventsShape {
    timed: 1_000,
    all_day: 200,
    series: 80,
    daily: 80,
    overridden: 60,
    cancelled: 30,
    trashed: 20,
    guests: 40,
    guested: 300,
};

struct Seeded {
    dir: std::path::PathBuf,
    vault: Vault,
    counts: Year3EventsCounts,
}

impl Drop for Seeded {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn seeded(shape: Year3EventsShape) -> Seeded {
    let dir = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&dir).expect("a scratch directory");
    let vault = Vault::create_with(
        dir.join("vault.db"),
        Box::new(Arc::new(FixedClock::frozen())),
        Box::new(SeededIds::new("year3")),
    )
    .expect("a vault");
    vault.found("Year 3", "Owner").expect("founded");
    let counts = vault
        .commit(|tx| Ok(year3_events(tx.connection(), shape, SEED).expect("seeded")))
        .expect("the corpus lands")
        .value;
    Seeded { dir, vault, counts }
}

fn utc() -> FireZone {
    FireZone::named("Etc/UTC").expect("UTC is in the bundled database")
}

fn upcoming_result(
    world: &Seeded,
) -> Result<Vec<centraid_apps_agenda::queries::EventRow>, KitError> {
    world
        .vault
        .read(|connection| {
            let door = TestDoor::new(connection);
            Ok(
                load_upcoming(&door, Some(FROM), Some(TO), NOW, &utc()).map(|(data, denial)| {
                    assert!(denial.is_none(), "{denial:?}");
                    data.events
                }),
            )
        })
        .expect("a read")
}

fn upcoming(world: &Seeded) -> Vec<centraid_apps_agenda::queries::EventRow> {
    upcoming_result(world).expect("upcoming reads")
}

/// THE BOUND IS REACHED, AND IT NAMES THE SIZE IT REACHES.
fn assert_trips(world: &Seeded) {
    match upcoming_result(world) {
        Err(KitError::FanOutExceeded { query, cap }) => {
            assert_eq!(query, "agenda.upcoming.expansion");
            assert_eq!(cap, centraid_apps_agenda::MAX_TOTAL_INSTANCES);
        }
        other => panic!(
            "the year-3 window answers a bound, not {:?}",
            other.map(|rows| rows.len())
        ),
    }
}

/// THE WINDOW HOLDS ITS DAYS' EVENTS AND THE SERIES EXPANDED, AND NO TRASHED ONE.
#[test]
fn a_window_holds_its_days_expanded_series_and_no_trashed_event() {
    let world = seeded(REALISTIC);
    // A trashed series is not counted, and carries no overrides.
    assert!(world.counts.series > REALISTIC.series * 9 / 10);
    assert!(world.counts.overrides > REALISTIC.overridden);
    assert_eq!(world.counts.trashed, REALISTIC.trashed);
    let started = Instant::now();
    let events = upcoming(&world);
    eprintln!(
        "year3 agenda (sample): a six-week window of {} instances in {:?}",
        events.len(),
        started.elapsed()
    );
    assert!(!events.is_empty());
    // A series shows more than once in six weeks; a one-off shows once.
    let mut seen = std::collections::HashMap::<&str, usize>::new();
    for row in &events {
        *seen.entry(row.event_id.as_str()).or_default() += 1;
    }
    assert!(
        seen.values().any(|count| *count > 1),
        "a series is expanded inside the window"
    );
    // None of what the window holds is in the trash.
    assert!(!world.counts.trashed_ids.is_empty());
    assert!(
        world
            .counts
            .trashed_ids
            .iter()
            .all(|id| !seen.contains_key(id.as_str())),
        "a trashed event is on the agenda"
    );
    // The window is ordered by start.
    assert!(
        events
            .windows(2)
            .all(|pair| pair[0].dtstart <= pair[1].dtstart)
    );
}

/// A YEAR-3 CALENDAR TRIPS THE EXPANSION BOUND: eighty daily series over the
/// default window are thousands of occurrences against 1,500.
#[test]
fn a_year3_calendar_trips_the_expansion_bound_and_names_it() {
    assert_trips(&seeded(SHRUNKEN));
}

/// The declared profile, run on demand:
/// `cargo test -p centraid-apps-agenda --test year3 -- --ignored --nocapture`.
#[test]
#[ignore = "the declared 12,000-event profile; run for the receipt's numbers"]
fn the_declared_profile() {
    let started = Instant::now();
    let world = seeded(YEAR3_EVENTS);
    eprintln!(
        "year3 agenda: seeded {} events ({} series) in {:?}",
        world.counts.live,
        world.counts.series,
        started.elapsed()
    );
    let started = Instant::now();
    assert_trips(&world);
    eprintln!(
        "year3 agenda: the default window tripped the bound in {:?}",
        started.elapsed()
    );
}
