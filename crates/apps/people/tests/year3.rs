//! THE YEAR-3 PEOPLE AXIS (#1020, D-1020-D3-7, slot 4c).
//!
//! v0's year-3 generator writes **5,000 `core_party` rows and no
//! `people_profile` at all** (`packages/test-kit/src/year3-vault.ts:77`-`:92`),
//! so People's stated ceilings — a 20–10,000 roster window, a dashboard that
//! folds over 9,999 rows, a 500-row trash shelf — had no golden artifact behind
//! them. [`year3_people`] is that artifact.
//!
//! The full run is `#[ignore]`d for the reason Docs' and Photos' are: it seeds
//! five thousand people, twelve thousand important dates and twenty thousand
//! interactions, and is longer than the whole `local` gate budget. A SHRUNKEN
//! axis runs unignored, through the same statements, so the generator cannot rot
//! while the measured number waits for a machine — and the shrunken run is what
//! proves the fixture's SHAPE, which is the half a measurement cannot.

use std::fs;
use std::path::{Path, PathBuf};

use centraid_apps_kit::contract_vault::open_contract_vault;
use centraid_apps_kit::fixtures::{YEAR3_PEOPLE, Year3PeopleShape, year3_people};
use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_people::dashboard::load_dashboard;
use centraid_apps_people::dates::{CivilDate, parse_instant};
use centraid_apps_people::roster::{PeopleInput, load_people, load_trash};

/// The seed every run uses, so two runs of one shape write one fixture.
const SEED: u64 = 679_003;
/// The instant the folds are measured against, and the vault's own civil date.
const NOW: &str = "2099-06-01T09:00:00.000Z";
const TODAY: CivilDate = CivilDate::new(2099, 6, 1);

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

/// A shrunken axis: the same generator, the same statements, one twenty-fifth
/// of the rows.
const SHRUNKEN: Year3PeopleShape = Year3PeopleShape {
    people: 200,
    trashed: 20,
    starred: 16,
    lists: 4,
    filed: 120,
    important_dates: 480,
    reminders: 240,
    interactions: 800,
    notes: 160,
    bindings: 36,
    obligations: 24,
    start: "2097-01-01",
};

#[test]
fn a_shrunken_axis_is_readable_through_the_roster_the_shelf_and_the_dashboard() {
    let connection = empty_vault();
    let counts = year3_people(&connection, SHRUNKEN, SEED).expect("the axis seeds");
    assert_eq!(counts.profiles, SHRUNKEN.people);
    assert_eq!(counts.trashed, SHRUNKEN.trashed);
    assert_eq!(counts.live_profiles, SHRUNKEN.people - SHRUNKEN.trashed);
    assert_eq!(counts.important_dates, SHRUNKEN.important_dates);
    assert_eq!(counts.reminders, SHRUNKEN.reminders);
    assert_eq!(counts.activities, SHRUNKEN.interactions);
    // Every interaction is an activity, a link and an annotation; the owner's
    // own notes are annotations too.
    assert_eq!(counts.links, SHRUNKEN.interactions);
    assert_eq!(counts.annotations, SHRUNKEN.interactions + SHRUNKEN.notes);
    assert_eq!(counts.bindings, SHRUNKEN.bindings);
    assert_eq!(counts.obligations, SHRUNKEN.obligations);

    let door = TestDoor::new(&connection);
    let (roster, denial) =
        load_people(&door, PeopleInput { limit: Some(500) }).expect("the roster reads");
    assert!(denial.is_none(), "the axis is not denied: {denial:?}");
    // THE WINDOW IS WALKED, NOT CLAMPED. 180 live people is under the 500 the
    // caller asked for, so the walk ends on its own and `truncated` is false —
    // and the count is the whole live set, which a single clamped page of 500
    // would also have given. The clamp is proved at volume below.
    assert_eq!(roster.people.len(), SHRUNKEN.people - SHRUNKEN.trashed);
    assert!(!roster.truncated);
    assert_eq!(roster.lists.len(), SHRUNKEN.lists);
    assert!(roster.links.known(), "the share plane answered");
    let linked = roster
        .people
        .iter()
        .filter(|row| {
            roster
                .links
                .ready()
                .is_some_and(|links| links.linked(&row.party_id))
        })
        .count();
    assert!(
        linked > 0,
        "no roster row is linked: the plane proves nothing"
    );
    // AT MOST ONE LIVE BINDING PER PARTY (finding PE-F6): `vault_count` is a
    // boolean wearing a number's clothes, and the fixture holds the DDL to it.
    assert!(
        roster.people.iter().all(|row| {
            roster
                .links
                .ready()
                .is_some_and(|links| links.vault_count(&row.party_id) <= 1)
        }),
        "a party holds two live bindings, which the partial unique index forbids"
    );

    let (shelf, denial) = load_trash(&door).expect("the shelf reads");
    assert!(denial.is_none());
    assert_eq!(shelf.people.len(), SHRUNKEN.trashed);
    assert!(!shelf.truncated);

    let now_ms = parse_instant(NOW).expect("an instant");
    let (dashboard, denial) = load_dashboard(&door, TODAY, now_ms).expect("the summary reads");
    assert!(denial.is_none());
    // THE COUNTS ARE A FOLD OVER THE WHOLE LIVE SET, which is the half v0 gets
    // wrong at volume (finding PE-F3).
    assert_eq!(dashboard.counts.all, SHRUNKEN.people - SHRUNKEN.trashed);
    assert!(!dashboard.truncated);
    assert!(
        dashboard.counts.upcoming > 0,
        "the Upcoming rail is empty: the reminder fold proves nothing"
    );
    assert!(
        dashboard.counts.reconnect > 0,
        "nobody is overdue: the cadence fold proves nothing"
    );
    assert!(dashboard.recent.len() <= 30, "the recent rail is a window");
    // THE PAIR IS KNOWN AND CONSISTENT.
    let links = dashboard.links.ready().expect("the plane answered");
    assert_eq!(links.linked + links.to_link, dashboard.counts.all);

    // THE LEAP-DAY CASE IS IN THE CORPUS, because a birthday rail without one
    // cannot show the clamp (D-1020-PE7).
    assert!(
        dashboard
            .upcoming
            .iter()
            .any(|row| row.month_day == "02-29"),
        "no 29 February reminder: the clamp proves nothing"
    );
}

/// THE MEASURED RUN. `#[ignore]`d; `cargo test -p centraid-apps-people --test
/// year3 -- --ignored --nocapture` prints the numbers this lane's receipt
/// quotes as projected provenance (D-1020-D3-7).
#[test]
#[ignore = "seeds 5,000 people and 20,000 interactions; longer than the local gate budget"]
fn the_year_three_roster_walks_its_declared_window() {
    let connection = empty_vault();
    let seeded = std::time::Instant::now();
    let counts = year3_people(&connection, YEAR3_PEOPLE, SEED).expect("the axis seeds");
    let seeding = seeded.elapsed();
    assert_eq!(counts.profiles, YEAR3_PEOPLE.people);

    let door = TestDoor::new(&connection);
    let read = std::time::Instant::now();
    let (roster, denial) = load_people(
        &door,
        PeopleInput {
            limit: Some(centraid_apps_people::queries::ROSTER_MAX),
        },
    )
    .expect("the roster reads");
    let walked = read.elapsed();
    assert!(denial.is_none());
    // FOUR THOUSAND SEVEN HUNDRED AND FIFTY LIVE PEOPLE, WALKED. v0 asks for
    // this as ONE page and the host clamps it to 500 (finding PE-F3).
    assert_eq!(
        roster.people.len(),
        YEAR3_PEOPLE.people - YEAR3_PEOPLE.trashed
    );
    assert!(!roster.truncated, "the whole live set is inside the window");

    let now_ms = parse_instant(NOW).expect("an instant");
    let folded = std::time::Instant::now();
    let (dashboard, denial) = load_dashboard(&door, TODAY, now_ms).expect("the summary reads");
    let folding = folded.elapsed();
    assert!(denial.is_none());
    assert_eq!(
        dashboard.counts.all,
        YEAR3_PEOPLE.people - YEAR3_PEOPLE.trashed
    );

    println!(
        "year3-people: seeded {} people / {} dates / {} interactions in {seeding:?}; \
         roster walked {} rows in {walked:?}; dashboard folded {} in {folding:?}",
        counts.profiles,
        counts.important_dates,
        counts.activities,
        roster.people.len(),
        dashboard.counts.all
    );
}
