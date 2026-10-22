//! YEAR-3 PEOPLE VOLUME, and the numbers the receipt reports (#1020, D-1020-PE4;
//! rebuilt on the new model, #1135).
//!
//! `centraid_apps_kit::fixtures::year3_people` writes the profile [`YEAR3_PEOPLE`]
//! declares: 5,000 people (250 trashed) beside 100 pets and the owner, 10,000 yearly
//! dates and 2,000 birthdays, 20,000 touches (8,000 with a note about them), 3,000
//! notes about people and 8,000 contact points. This suite turns that into
//! measurements and asserts what a count cannot: the roster walks past the door's
//! 500-row page and says whether it filled, a pet and the owner are not in the
//! circle, and last-contacted is computed from the touches.
//!
//! **A timing here is `ci-linux-x64-4c` and a DEBUG build.** Every number this file
//! prints is reported as *projected provenance* (D-1020-D3-7's pattern), never as a
//! ceiling.

use std::sync::Arc;
use std::time::Instant;

use centraid_apps_kit::fixtures::{YEAR3_PEOPLE, Year3PeopleShape, year3_people};
use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_people::dashboard::load_dashboard;
use centraid_apps_people::dates::{CivilDate, parse_instant};
use centraid_apps_people::person::load_person;
use centraid_apps_people::roster::{PeopleInput, load_people, load_trash};
use centraid_vault::Vault;
use centraid_vault::clock::{FixedClock, SeededIds};

const SEED: u64 = 679_004;

/// A smaller profile for the suite's own runtime, in the SHAPE of the declared one.
/// Every field is named on purpose: a field added to the shape fails this literal
/// rather than being inherited silently.
const SAMPLE: Year3PeopleShape = Year3PeopleShape {
    people: 1_400,
    trashed: 100,
    pets: 30,
    starred: 120,
    lists: 8,
    filed: 800,
    birthdays: 500,
    dates: 2_400,
    reminded: 1_500,
    touches: 4_800,
    touch_notes: 2_000,
    notes: 700,
    contact_points: 2_000,
};

struct Seeded {
    dir: std::path::PathBuf,
    vault: Vault,
    counts: centraid_apps_kit::fixtures::Year3PeopleCounts,
}

impl Drop for Seeded {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn seeded(shape: Year3PeopleShape) -> Seeded {
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
        .commit(|tx| Ok(year3_people(tx.connection(), shape, SEED).expect("seeded")))
        .expect("the corpus lands")
        .value;
    Seeded { dir, vault, counts }
}

fn read<T>(world: &Seeded, body: impl FnOnce(&TestDoor<'_>) -> T) -> T {
    world
        .vault
        .read(|connection| Ok(body(&TestDoor::new(connection))))
        .expect("a read")
}

/// THE ROSTER WALKS ITS WINDOW, AND THE CIRCLE LEAVES OUT THE OWNER, A PET AND THE TRASH.
#[test]
fn the_roster_walks_past_a_page_and_holds_the_circle_and_nothing_else() {
    let world = seeded(SAMPLE);
    let started = Instant::now();
    let (roster, denial) = read(&world, |door| {
        load_people(door, PeopleInput::default()).expect("folds")
    });
    let elapsed = started.elapsed();
    assert!(denial.is_none());
    eprintln!(
        "year3 people (sample): the roster walked {} people in {elapsed:?}",
        roster.people.len()
    );
    // A page is 500 rows (`MAX_PAGE_ROWS`); the walked window reaches past one.
    assert!(roster.people.len() > 500, "reached {}", roster.people.len());
    // The window fits, so it did not fill; the pets and the trash are not in it.
    assert!(!roster.truncated);
    assert_eq!(roster.people.len(), world.counts.live);
    assert_eq!(
        roster.people.iter().filter(|row| row.starred).count(),
        SAMPLE.starred
    );
    assert_eq!(roster.lists.len(), SAMPLE.lists);
    // LAST CONTACTED IS COMPUTED: a person the touches name has one, and it is the newest of theirs.
    let touched = roster
        .people
        .iter()
        .filter(|row| row.last_contacted_at.is_some())
        .count();
    assert!(
        touched > 0 && touched <= SAMPLE.touches,
        "{touched} people were touched"
    );
    // A narrow window says it did not fill the roster.
    let (narrow, _) = read(&world, |door| {
        load_people(door, PeopleInput { limit: Some(300) }).expect("folds")
    });
    assert!(narrow.truncated && narrow.window == 300);
    assert!(narrow.people.len() <= 300);
}

#[test]
fn the_dashboard_folds_the_whole_circle_and_the_trash_shelf_holds_the_rest() {
    let world = seeded(SAMPLE);
    let now = parse_instant("2026-06-01T00:00:00.000Z").expect("an instant");
    let started = Instant::now();
    let (dashboard, denial) = read(&world, |door| {
        load_dashboard(door, CivilDate::new(2026, 6, 1), now).expect("folds")
    });
    let elapsed = started.elapsed();
    assert!(denial.is_none() && !dashboard.truncated);
    eprintln!(
        "year3 people (sample): the dashboard folded {} people in {elapsed:?}",
        dashboard.counts.all
    );
    assert_eq!(dashboard.counts.all, world.counts.live);
    assert_eq!(dashboard.counts.starred, SAMPLE.starred);
    assert!(dashboard.recent.len() <= 30 && !dashboard.recent.is_empty());
    assert!(
        !dashboard.upcoming.is_empty()
            && dashboard.upcoming.len() <= SAMPLE.reminded + SAMPLE.birthdays
    );
    let (shelf, _) = read(&world, |door| load_trash(door).expect("reads"));
    assert_eq!(shelf.people.len(), SAMPLE.trashed);
}

#[test]
fn one_sheet_opens_over_the_volume() {
    let world = seeded(SAMPLE);
    let (roster, _) = read(&world, |door| {
        load_people(door, PeopleInput::default()).expect("folds")
    });
    let id = roster
        .people
        .iter()
        .find(|row| row.last_contacted_at.is_some())
        .expect("a touched person")
        .party_id
        .clone();
    let started = Instant::now();
    let (data, denial) = read(&world, |door| load_person(door, &id).expect("reads"));
    eprintln!(
        "year3 people (sample): one sheet in {:?}",
        started.elapsed()
    );
    assert!(denial.is_none());
    let sheet = data.person.expect("a sheet");
    assert!(!sheet.touches.is_empty());
    assert_eq!(
        sheet.profile.last_contacted_at.as_deref(),
        sheet.touches.first().map(|t| t.at.as_str())
    );
}

/// The declared profile, run on demand: `cargo test -p centraid-apps-people --test year3 -- --ignored --nocapture`.
#[test]
#[ignore = "the declared 5,000-person profile; run for the receipt's numbers"]
fn the_declared_profile() {
    let started = Instant::now();
    let world = seeded(YEAR3_PEOPLE);
    eprintln!(
        "year3 people: seeded {} people, {} touches in {:?}",
        world.counts.live,
        world.counts.touches,
        started.elapsed()
    );
    let started = Instant::now();
    let (roster, _) = read(&world, |door| {
        load_people(door, PeopleInput::default()).expect("folds")
    });
    eprintln!(
        "year3 people: the roster walked {} in {:?}",
        roster.people.len(),
        started.elapsed()
    );
    let now = parse_instant("2026-06-01T00:00:00.000Z").expect("an instant");
    let started = Instant::now();
    let (dashboard, _) = read(&world, |door| {
        load_dashboard(door, CivilDate::new(2026, 6, 1), now).expect("folds")
    });
    eprintln!(
        "year3 people: the dashboard folded {} in {:?}",
        dashboard.counts.all,
        started.elapsed()
    );
    assert_eq!(roster.people.len(), world.counts.live);
}
