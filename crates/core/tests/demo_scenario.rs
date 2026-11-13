//! THE DEMO SCENARIO, COUNTED (#1173).
//!
//! `mobile/scripts/demo-vault.sh` seeds the vault each revamped screen is checked
//! against a mockup with, so each screen needs its data to be THERE: a Health
//! summary with a hundred and twenty days, a person with a number and an overdue
//! cadence, a document with three versions, an invitation to answer. This test
//! seeds the scenario the way the dev binary does (a clock that starts
//! [`REWIND_MS`] back and is moved forward by the scenario, on bytes and ids that
//! are a function of that clock) and asserts the counts, so the day a command's
//! refusal or a rename empties one of those screens, a number here moves.
//!
//! Every figure is a count, never a duration (the owner's ruling of 2026-11-04).

use std::sync::Arc;

use centraid_apps_health::civil::parse_day;
use centraid_apps_health::figures::Metric;
use centraid_apps_health::queries::{self, Range};
use centraid_apps_people::dates::CivilDate;
use centraid_core::app_query::VaultDoor;
use centraid_core::example::{self, HEALTH_DAYS, REWIND_MS, WORKOUT_COUNT};
use centraid_core::{Core, CoreConfig, Handle};
use centraid_vault::Principal;
use centraid_vault::clock::{ClockIds, FixedClock};
use centraid_vault::commands::Registry;
use centraid_vault::page::KeysetPage;
use centraid_vault::value::Value;

/// 2026-11-04T12:00:00Z: a Wednesday, noon, so a day is the same day in every zone near UTC.
const NOW: i64 = 1_793_793_600_000;

struct Scenario {
    dir: std::path::PathBuf,
    handle: Handle,
    report: example::Report,
}

impl Drop for Scenario {
    fn drop(&mut self) {
        self.handle.close();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn seeded() -> Scenario {
    let dir = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&dir).expect("the directory is made");
    let path = dir.join("vault.db");
    let clock = Arc::new(FixedClock::at(NOW - REWIND_MS));
    let handle = Core::open(CoreConfig::new(&path).with_clock(
        clock.clone(),
        Arc::new(ClockIds::new(Box::new(clock.clone()))),
    ))
    .expect("a core opens");
    handle
        .open_own_bytes(path.with_extension("bytes"))
        .expect("the byte store opens");
    let report = handle
        .with_vault(|vault| {
            vault.found("Demo vault", "Owner")?;
            let registry = Registry::with_system_commands()?;
            example::seed_demo(
                vault,
                &registry,
                &Principal::owner("demo-device"),
                &|_| true,
                NOW,
                &|ms| clock.advance_ms(ms),
            )
        })
        .expect("the scenario seeds");
    Scenario {
        dir,
        handle,
        report,
    }
}

impl Scenario {
    /// How many rows of `table` satisfy `predicate` (one page: the scenario is far under the page).
    fn count(&self, table: &str, pk: &str, predicate: &str, binds: Vec<Value>) -> usize {
        self.handle
            .with_vault(|vault| {
                let page = vault.keyset_page(&KeysetPage {
                    name: "seed.count".to_owned(),
                    select: vec![pk.to_owned()],
                    from: table.to_owned(),
                    predicate: (!predicate.is_empty()).then(|| predicate.to_owned()),
                    binds,
                    sort_column: pk.to_owned(),
                    pk_column: pk.to_owned(),
                    descending: false,
                    limit: 500,
                    after: None,
                    held_thumbnail: false,
                    document_size: false,
                })?;
                assert!(page.next.is_none(), "{table}: more than one page of rows");
                Ok(page.rows.len())
            })
            .expect("the page reads")
    }

    fn entities(&self, kind: &str) -> usize {
        self.count(
            "entity",
            "id",
            &format!("kind = '{kind}' AND deleted_at IS NULL"),
            vec![],
        )
    }

    fn revisions_of_title(&self, kind: &str, title: &str) -> usize {
        let id = self
            .handle
            .with_vault(|vault| {
                let page = vault.keyset_page(&KeysetPage {
                    name: "seed.count".to_owned(),
                    select: vec!["id".to_owned()],
                    from: "entity".to_owned(),
                    predicate: Some("kind = ?1 AND title = ?2".to_owned()),
                    binds: vec![Value::Text(kind.to_owned()), Value::Text(title.to_owned())],
                    sort_column: "id".to_owned(),
                    pk_column: "id".to_owned(),
                    descending: false,
                    limit: 5,
                    after: None,
                    held_thumbnail: false,
                    document_size: false,
                })?;
                match page.rows.first().and_then(|row| row.get("id")) {
                    Some(Value::Text(id)) => Ok(id.clone()),
                    other => panic!("no {kind} titled {title:?}: {other:?}"),
                }
            })
            .expect("the entity reads");
        self.count(
            "revision",
            "entity_id",
            "entity_id = ?1",
            vec![Value::Text(id)],
        )
    }
}

#[test]
fn the_scenario_seeds_whole_and_every_revamped_screen_has_its_data() {
    let scenario = seeded();
    assert!(
        scenario.report.is_whole(),
        "the scenario seeds whole: {:?}",
        scenario.report
    );

    // PEOPLE: six, five of them with a number, the owner's card has one too, and the
    // edges "In your vault" lists exist (guests, and notes and tasks about a person).
    let owner = scenario
        .handle
        .with_vault(|vault| Ok(vault.self_id()?.expect("a founded vault has an owner")))
        .expect("the owner reads");
    assert_eq!(
        scenario.count(
            "entity",
            "id",
            "kind = 'person' AND deleted_at IS NULL AND id <> ?1",
            vec![Value::Text(owner.clone())]
        ),
        6
    );
    assert_eq!(
        scenario.count("contact_point", "id", "kind = 'phone'", vec![]),
        6
    );
    assert_eq!(
        scenario.count("contact_point", "id", "kind = 'email'", vec![]),
        6
    );
    // The owner's own card has a number and an address, so "My card" has a face.
    assert_eq!(
        scenario.count(
            "contact_point",
            "id",
            "person_id = ?1",
            vec![Value::Text(owner.clone())]
        ),
        2
    );
    // Guests, and the notes and tasks about a person, are the edges "In your vault" lists.
    assert_eq!(
        scenario.count("edge", "from_id", "rel = 'attendee'", vec![]),
        9
    );
    assert_eq!(
        scenario.count("edge", "from_id", "rel = 'about'", vec![]),
        10
    );
    // EXACTLY ONE PERSON IS OVERDUE to reconnect: Chris, last touched 75 days ago on a cadence of 60.
    let (dashboard, _) = scenario
        .handle
        .with_vault(|vault| {
            let door = VaultDoor::new(vault);
            Ok(centraid_apps_people::dashboard::load_dashboard(
                &door,
                CivilDate::parse("2026-11-04").expect("a day"),
                NOW,
            )
            .expect("the dashboard reads"))
        })
        .expect("people read");
    assert_eq!(dashboard.reconnect.len(), 1, "{:?}", dashboard.reconnect);
    assert_eq!(
        dashboard.days_over.values().copied().collect::<Vec<_>>(),
        [15]
    );

    // DOCS: seven documents in three folders (one is Dinner with Maya's attached menu, filed
    // nowhere), one of them with three versions, a PDF and an image beside the text, and labels
    // that wear colours.
    assert_eq!(scenario.count("document", "id", "", vec![]), 7);
    assert_eq!(
        scenario.count("edge", "from_id", "rel = 'attached'", vec![]),
        1,
        "one event carries one attachment"
    );
    assert_eq!(
        scenario.count("document", "id", "media_type = 'application/pdf'", vec![]),
        1
    );
    assert_eq!(
        scenario.count("document", "id", "media_type = 'image/png'", vec![]),
        1
    );
    assert_eq!(scenario.entities("folder"), 3);
    // Two edits, and the document's tag and star: each is a version of its own.
    assert_eq!(
        scenario.revisions_of_title("document", "Tahoe packing list"),
        4
    );

    // NOTES: a pinned one, a checklist, one with three versions, and one linking to a live, a
    // trashed and a missing note (with a trashed note to be linked to).
    assert!(scenario.entities("note") >= 9 && scenario.entities("note") <= 14);
    assert_eq!(
        scenario.count("edge", "from_id", "to_id = 'flag:pinned'", vec![]),
        1
    );
    assert_eq!(scenario.revisions_of_title("note", "Drive vs fly"), 2);

    // PHOTOS: the original roll and the older one, across months and places.
    assert_eq!(scenario.count("photo", "id", "", vec![]), 47);
    assert!(scenario.count("place", "id", "", vec![]) >= 13);
    assert_eq!(scenario.entities("album"), 2);

    // AGENDA: a busy week with overlaps (five FREE events laid over busy ones), an
    // all-day span and an all-day event today, two more calendars (Work, blue; Family,
    // violet) with the week's events filed on them, twenty-five tasks in four coloured lists, and two invitations the
    // member has not answered.
    assert_eq!(scenario.entities("event"), 24);
    assert_eq!(scenario.count("event", "id", "busy = 0", vec![]), 5);
    assert_eq!(
        scenario.count("event", "id", "timing = 'all-day'", vec![]),
        2
    );
    // NONE OF IT IS IN A ZONE: a seeded event is "19:00 wherever the member is" (floating), so
    // a phone in any zone reads the same wall clock on its page, grid and editor.
    assert_eq!(scenario.count("event", "id", "timing = 'zoned'", vec![]), 0);
    assert_eq!(scenario.entities("calendar"), 3);
    assert_eq!(
        scenario.count("event", "id", "calendar_id <> 'calendar:default'", vec![]),
        11
    );
    assert_eq!(scenario.entities("task"), 25);
    assert_eq!(
        scenario.count(
            "container",
            "id",
            "kind = 'project' AND color IS NOT NULL",
            vec![]
        ),
        4
    );
    assert_eq!(
        scenario.count(
            "edge",
            "from_id",
            "rel = 'attendee' AND state = 'needs-action' AND to_id = ?1",
            vec![Value::Text(owner)]
        ),
        2
    );

    // MONEY: a statement of lines across weeks, and two of the three transfers accepted
    // (four halves), the newest left for the member.
    assert_eq!(scenario.count("txn", "id", "", vec![]), 91);
    // A transfer is one row naming its two halves.
    assert_eq!(scenario.count("transfer", "a", "", vec![]), 2);
    assert!(
        scenario.count(
            "txn",
            "id",
            "category_id IS NULL AND amount_minor < -6000",
            vec![]
        ) >= 2
    );
    assert!(
        scenario.count(
            "txn",
            "id",
            "amount_minor > 0 AND amount_minor < 10000",
            vec![]
        ) >= 1
    );
}

#[test]
fn health_is_four_months_of_totals_and_a_dozen_workouts() {
    let scenario = seeded();
    let today = parse_day("2026-11-04").expect("a day");
    let answer = scenario
        .handle
        .with_vault(|vault| {
            let door = VaultDoor::new(vault);
            let day_start = "2026-11-04T00:00:00.000Z";
            let day_end = "2026-11-05T00:00:00.000Z";
            let now = queries::today(&door, today, day_start, day_end).expect("today");
            let steps =
                queries::series(&door, Metric::Steps, Range::SixMonths, today).expect("steps");
            let resting = queries::series(&door, Metric::RestingHrBpm, Range::SixMonths, today)
                .expect("resting");
            let weight =
                queries::series(&door, Metric::WeightKg, Range::SixMonths, today).expect("weight");
            Ok((now, steps, resting, weight))
        })
        .expect("health reads");
    let (now, steps, resting, weight) = answer;
    assert!(now.connected, "a store is followed");
    assert_eq!(now.metrics_with_data.len(), 6, "every metric has a figure");
    // A series counts BUCKETS (a week each over six months), so the days are counted in the rows:
    // every day has its sums and its sleep, and the watch was off some days.
    let days = |metric: &str| {
        scenario.count(
            "measurement",
            "day",
            "metric = ?1",
            vec![Value::Text(metric.to_owned())],
        )
    };
    let whole = usize::try_from(HEALTH_DAYS).expect("days");
    for metric in ["steps", "active_energy_kcal", "exercise_min", "sleep_min"] {
        assert_eq!(days(metric), whole, "{metric}");
    }
    assert!(days("resting_hr_bpm") < whole && days("resting_hr_bpm") > whole - 15);
    assert!(days("weight_kg") > 30 && days("weight_kg") < whole / 2);
    assert!(steps.counted > 0 && resting.counted > 0 && weight.counted > 0);
    assert_eq!(
        scenario.count("workout", "id", "", vec![]),
        WORKOUT_COUNT,
        "a dozen workouts"
    );
}
