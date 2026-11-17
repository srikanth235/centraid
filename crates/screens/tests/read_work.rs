//! A count-only observation of the real Home tile load boundary. The answers
//! retain their typed rows so this test can print stable request identities and
//! app-level row counts without adding instrumentation to Core or SQLite.

use centraid_api_proto::core_v1 as wire;
use centraid_apps_kit::search_corpus::{SearchCorpusShape, YEAR3_ROWS, year3_search_corpus};
use centraid_core::{Core, CoreConfig};
use centraid_screens::shell::{self, tiles};
use centraid_screens::testing::Driver;
use centraid_vault::clock::{ClockIds, FixedClock};
use std::path::PathBuf;
use std::sync::Arc;

const HOME_APPS: [&str; 9] = [
    "calendar",
    "reminders",
    "photos",
    "money",
    "health",
    "people",
    "locker",
    "notes",
    "docs",
];

fn answer_units(answer: &wire::AppQueryResponse) -> (&'static str, usize) {
    use wire::app_query_response::Answer;
    match answer.answer.as_ref() {
        Some(Answer::AgendaUpcoming(rows)) => ("events", rows.events.len()),
        Some(Answer::AgendaDayContext(rows)) => ("birthdays", rows.birthdays.len()),
        Some(Answer::AgendaTaskBoard(rows)) => (
            "tasks",
            rows.groups.iter().map(|group| group.tasks.len()).sum(),
        ),
        Some(Answer::PhotosShelf(rows)) => ("photo_cells", rows.cells.len()),
        Some(Answer::MoneyHomeTile(rows)) => ("currency_spend_lines", rows.spent.len()),
        Some(Answer::HealthToday(rows)) => (
            "metrics_and_workouts",
            rows.workouts.len() + rows.metrics.len(),
        ),
        Some(Answer::PeopleRoster(rows)) => ("people", rows.people.len()),
        Some(Answer::LockerItems(rows)) => ("locker_items", rows.items.len()),
        Some(Answer::NotesLibrary(rows)) => ("notes", rows.notes.len()),
        Some(Answer::DocsDrive(rows)) => ("documents", rows.documents.len()),
        other => panic!("Home tile returned an unexpected answer type: {other:?}"),
    }
}

struct HomeFixture {
    dir: PathBuf,
    driver: Option<Driver>,
}

impl HomeFixture {
    fn driver(&self) -> &Driver {
        self.driver.as_ref().expect("the driver was opened")
    }
}

impl Drop for HomeFixture {
    fn drop(&mut self) {
        drop(self.driver.take());
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn founded_driver() -> HomeFixture {
    let dir = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&dir).expect("scratch directory");
    let mut fixture = HomeFixture { dir, driver: None };
    let clock = Arc::new(FixedClock::frozen());
    let ids = Arc::new(ClockIds::new(Box::new(clock.clone())));
    let handle = Core::open(CoreConfig::new(fixture.dir.join("vault.db")).with_clock(clock, ids))
        .expect("core opens");
    handle
        .open_own_bytes(fixture.dir.join("vault.bytes"))
        .expect("byte store opens");
    handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Found(wire::FoundRequest {
                display_name: "Read work".to_owned(),
                owner_name: "Owner".to_owned(),
                content: wire::FoundContent::Unspecified as i32,
            })),
        })
        .expect("empty vault is founded");
    fixture.driver = Some(Driver::over_handle(shell::runtime(), handle));
    fixture
}

fn seed_year3(handle: &centraid_core::Handle, shape: SearchCorpusShape) {
    handle
        .with_vault(|vault| {
            vault.commit(|tx| {
                year3_search_corpus(tx.connection(), shape, 1_135_003)
                    .expect("year-three corpus is seeded");
                Ok(())
            })?;
            vault.commit(|tx| {
                centraid_vault::index::rebuild(tx.connection())?;
                Ok(())
            })?;
            Ok(())
        })
        .expect("year-three data and index are ready");
}

struct HomeLoadObservation {
    app: String,
    query: String,
    unit: String,
    count: usize,
}

struct HomeTileCount {
    widget: String,
    value: u32,
}

struct HomeObservation {
    loads: Vec<HomeLoadObservation>,
    tile_counts: Vec<HomeTileCount>,
}

fn read_home(driver: &Driver, label: &str) -> HomeObservation {
    let mut tile_counts = Vec::new();
    let observed = driver.with_load_observer(|ctx, observer| {
        for app in HOME_APPS {
            let made = tiles::read(ctx, app);
            assert!(!made.is_empty(), "{app} has its Home tile");
            for (widget, tile) in made {
                tile_counts.push(HomeTileCount {
                    widget: widget.to_owned(),
                    value: tile.count.map_or(0, |count| count.value),
                });
            }
        }
        let loads = observer.loads();
        let observed: Vec<_> = loads
            .iter()
            .map(|load| {
                let response = load
                    .response
                    .as_ref()
                    .unwrap_or_else(|error| panic!("{} load failed: {error}", load.request.app));
                let answer = response
                    .answer
                    .as_ref()
                    .unwrap_or_else(|| panic!("{} load had no typed answer", load.request.app));
                let (unit, count) = answer_units(answer);
                HomeLoadObservation {
                    app: load.request.app.clone(),
                    query: load.request.query.clone(),
                    unit: unit.to_owned(),
                    count,
                }
            })
            .collect();
        let apps: std::collections::BTreeSet<&str> =
            loads.iter().map(|load| load.request.app.as_str()).collect();
        assert_eq!(apps, HOME_APPS.into_iter().collect());
        let measured: Vec<String> = observed
            .iter()
            .map(|load| {
                format!(
                    "app={} query={} {}={}",
                    load.app, load.query, load.unit, load.count
                )
            })
            .collect();
        println!(
            "{label} Home load request and response units: {}",
            measured.join("; ")
        );
        observed
    });
    HomeObservation {
        loads: observed,
        tile_counts,
    }
}

#[test]
fn home_tile_reads_report_requests_and_units_for_an_empty_founded_vault() {
    let fixture = founded_driver();
    let observed = read_home(fixture.driver(), "empty");
    assert!(observed.tile_counts.iter().all(|count| count.value == 0));
}

fn home_year3_shape() -> SearchCorpusShape {
    SearchCorpusShape {
        vocabulary: 20_000,
        notes: 600,
        long_notes: 60,
        long_note_words: 60,
        note_words: 12,
        documents: 250,
        document_words: 40,
        photos: 1_200,
        people: 120,
        events: 300,
        tasks: 600,
        transactions: 1_200,
        locker_items: 50,
        activities: 250,
        workout_kinds: 8,
        threads: 15,
        messages_per_thread: 10,
        recurring_events: 6,
        occurrences_per_series: 5,
        revisions: 300,
        used: 40,
        measurement_days: 365,
        notebooks: 3,
        folders: 6,
        projects: 4,
        albums: 4,
        places: 20,
        categories: 4,
        accounts: 6,
        tags: 10,
    }
}

#[test]
fn home_tile_reads_report_requests_and_units_for_the_representative_year3_corpus() {
    let shape = home_year3_shape();
    let fixture = founded_driver();
    seed_year3(&fixture.driver().handle, shape);
    let observed = read_home(fixture.driver(), "year3-sample");
    assert_eq!(
        observed
            .loads
            .iter()
            .map(|load| load.app.as_str())
            .collect::<std::collections::BTreeSet<_>>(),
        HOME_APPS.into_iter().collect()
    );
    assert!(
        observed
            .tile_counts
            .iter()
            .any(|count| count.widget == "photos" && count.value > 0)
    );
    assert!(
        observed
            .tile_counts
            .iter()
            .any(|count| count.widget == "docs" && count.value > 0)
    );
}

#[test]
#[ignore = "full shared year-three corpus; run on its own with --ignored"]
fn home_tile_reads_on_the_full_shared_year3_corpus() {
    let fixture = founded_driver();
    seed_year3(&fixture.driver().handle, YEAR3_ROWS);
    let observed = read_home(fixture.driver(), "year3-full");
    assert_eq!(
        observed
            .loads
            .iter()
            .map(|load| load.app.as_str())
            .collect::<std::collections::BTreeSet<_>>(),
        HOME_APPS.into_iter().collect()
    );
}
