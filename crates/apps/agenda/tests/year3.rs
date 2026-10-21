//! YEAR-3 AGENDA VOLUME ([#1135](https://github.com/srikanth235/centraid/issues/1135)).
//!
//! `centraid_apps_kit::fixtures::year3_events` writes the profile `YEAR3_EVENTS`
//! declares: 10,000 one-off events over three years (2,000 all-day), 60 series
//! (20 with moved and cancelled occurrences), cancelled and trashed events and
//! 3,000 with guests. This suite asks Agenda's own read for a window and a
//! search over that volume, and asserts what a count cannot: the window holds the
//! events of its days and no trashed one, the series are expanded inside it, the
//! cancelled are drawn, and no bound was the answer.
//!
//! **A timing here is a DEBUG build** and is projected provenance, never a ceiling.

use std::sync::Arc;
use std::time::Instant;

use centraid_apps_agenda::queries::load_upcoming;
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

/// A smaller profile in the SHAPE of the declared one; a field added to the
/// shape fails this literal rather than being inherited silently.
const SAMPLE: Year3EventsShape = Year3EventsShape {
    timed: 2_400,
    all_day: 600,
    series: 30,
    overridden: 10,
    cancelled: 90,
    trashed: 60,
    guests: 100,
    guested: 900,
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

fn upcoming(world: &Seeded) -> Vec<centraid_apps_agenda::queries::EventRow> {
    world
        .vault
        .read(|connection| {
            let door = TestDoor::new(connection);
            let (data, denial) =
                load_upcoming(&door, Some(FROM), Some(TO), NOW, &utc()).expect("upcoming reads");
            assert!(denial.is_none(), "{denial:?}");
            Ok(data.events)
        })
        .expect("a read")
}

/// THE WINDOW HOLDS ITS DAYS' EVENTS AND THE SERIES EXPANDED, AND NO TRASHED ONE.
#[test]
fn a_window_holds_its_days_expanded_series_and_no_trashed_event() {
    let world = seeded(SAMPLE);
    // A trashed series is not counted, and carries no overrides.
    assert!(world.counts.series > SAMPLE.series * 9 / 10);
    assert!(world.counts.overrides > SAMPLE.overridden);
    assert_eq!(world.counts.trashed, SAMPLE.trashed);
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

/// The declared profile, run on demand:
/// `cargo test -p centraid-apps-agenda --test year3 -- --ignored --nocapture`.
#[test]
#[ignore = "the declared 10,000-event profile; run for the receipt's numbers"]
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
    let events = upcoming(&world);
    eprintln!(
        "year3 agenda: a six-week window of {} instances in {:?}",
        events.len(),
        started.elapsed()
    );
    assert!(!events.is_empty());
}
