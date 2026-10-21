//! THE YEAR-3 HEALTH VOLUME ([#1135](https://github.com/srikanth235/centraid/issues/1135)).
//!
//! Three years of the six daily totals (1,095 days, 6,570 values) and 1,200
//! workouts, written through the commands the phone's follower uses
//! (`measurement.record`, `follow.health`) and read back through Health's own
//! screens over the paged door. The figures are computed in Rust from what the
//! vault holds, so the test reconciles each against arithmetic done from the
//! generated values alone.
//!
//! The sample is the quick run (one year, 300 workouts); the full profile is
//! `#[ignore]`: `cargo test -p centraid-apps-health --test year3 -- --ignored --nocapture`.
//!
//! **A timing here is a DEBUG build** and is projected provenance, never a ceiling.

use std::sync::Arc;
use std::time::Instant;

use centraid_apps_health::civil::{format_day, parse_day};
use centraid_apps_health::figures::Metric;
use centraid_apps_health::queries::{self, Range, TrendRange};
use centraid_apps_kit::page::PageRequest;
use centraid_apps_kit::testdoor::TestDoor;
use centraid_vault::clock::{FixedClock, SeededIds};
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal, Vault};
use serde_json::{Value, json};

const TODAY: &str = "2026-10-20";
const KINDS: [&str; 6] = ["run", "walk", "swim", "ride", "yoga", "hike"];
const METRICS: [&str; 6] = [
    "steps",
    "active_energy_kcal",
    "exercise_min",
    "sleep_min",
    "resting_hr_bpm",
    "weight_kg",
];
/// The most values one `measurement.record` carries.
const BATCH: usize = 4_000;

/// The declared shape of year-3 Health volume.
struct Shape {
    days: i64,
    workouts: usize,
}

const YEAR3: Shape = Shape {
    days: 1_095,
    workouts: 1_200,
};
const SAMPLE: Shape = Shape {
    days: 365,
    workouts: 300,
};

fn world() -> (std::path::PathBuf, Vault, Registry) {
    let dir = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&dir).expect("a scratch directory");
    let vault = Vault::create_with(
        dir.join("vault.db"),
        Box::new(Arc::new(FixedClock::frozen())),
        Box::new(SeededIds::new("year3")),
    )
    .expect("a vault");
    vault.found("Home", "Owner").expect("founded");
    (
        dir,
        vault,
        Registry::with_system_commands().expect("a registry"),
    )
}

fn ok(vault: &Vault, registry: &Registry, name: &str, input: Value) -> Value {
    let outcome = vault
        .execute(
            registry,
            &Principal::owner("phone"),
            &Command::new(name, input),
        )
        .unwrap_or_else(|error| panic!("`{name}`: {error}"));
    assert_eq!(
        outcome.status,
        CommandStatus::Executed,
        "{name}: {:?}",
        outcome.reason
    );
    outcome.output
}

/// A deterministic stream of integers: the same bytes on every run.
fn mix(index: i64, salt: i64) -> i64 {
    let mut z = (index.wrapping_mul(0x9E37_79B9) ^ salt.wrapping_mul(0x85EB_CA6B)) as u64;
    z = (z ^ (z >> 15)).wrapping_mul(0x2C1B_3C6D);
    z = (z ^ (z >> 12)).wrapping_mul(0x297A_2D39);
    i64::try_from((z ^ (z >> 15)) % 1_000_000).unwrap_or(0)
}

/// One day's value for one metric, in the range a real store reports.
fn value(day: i64, metric: usize) -> f64 {
    let noise = mix(day, metric as i64 + 1);
    match metric {
        0 => 3_000.0 + (noise % 9_000) as f64,
        1 => 200.0 + (noise % 700) as f64,
        2 => (noise % 90) as f64,
        3 => 330.0 + (noise % 200) as f64,
        4 => 50.0 + (noise % 20) as f64,
        _ => 70.0 + (noise % 400) as f64 / 100.0,
    }
}

fn workout(index: usize, shape: &Shape, first_day: i64) -> Value {
    let day = first_day
        + i64::try_from(index).unwrap_or(0) * shape.days
            / i64::try_from(shape.workouts).unwrap_or(1);
    let hour = 6 + (index % 4) * 3;
    let starts = format!("{}T{hour:02}:00:00Z", format_day(day));
    let ends = format!("{}T{:02}:45:00Z", format_day(day), hour);
    json!({
        "external_id": format!("local:{index}"),
        "fields": {
            "kind": KINDS[index % KINDS.len()],
            "starts": starts,
            "ends": ends,
            "workout": {
                "recorded_by": "Watch",
                "moving_s": 2_700,
                "distance_m": 1_000 + (mix(day, 9) % 20_000),
                "heart_bpm": 120 + (mix(day, 10) % 50),
            },
        }
    })
}

fn run(shape: &Shape) {
    let today = parse_day(TODAY).expect("a day");
    let first_day = today - shape.days + 1;
    let (dir, vault, registry) = world();
    let started = Instant::now();

    let mut values: Vec<Value> = Vec::new();
    for day in first_day..=today {
        for (metric, name) in METRICS.iter().enumerate() {
            values.push(
                json!({ "day": format_day(day), "metric": name, "value": value(day, metric) }),
            );
        }
    }
    let mut written = 0;
    for batch in values.chunks(BATCH) {
        written += ok(
            &vault,
            &registry,
            "measurement.record",
            json!({ "days": batch }),
        )["written"]
            .as_u64()
            .unwrap_or(0);
    }
    assert_eq!(written, values.len() as u64);
    let records: Vec<Value> = (0..shape.workouts)
        .map(|at| workout(at, shape, first_day))
        .collect();
    let follow = |records: &[Value]| {
        ok(
            &vault,
            &registry,
            "follow.health",
            json!({
                "origin": { "ref": "store:apple-health", "label": "Apple Health" },
                "records": records,
            }),
        )
    };
    assert_eq!(follow(&records)["added"], shape.workouts);
    println!(
        "{} values and {} workouts in {:?}",
        values.len(),
        shape.workouts,
        started.elapsed()
    );

    // READING THE SAME WINDOW AGAIN WRITES NOTHING.
    let again = ok(
        &vault,
        &registry,
        "measurement.record",
        json!({ "days": &values[..BATCH.min(values.len())] }),
    );
    assert_eq!(again["written"], 0);
    let refollowed = follow(&records);
    assert_eq!(
        (refollowed["added"].as_i64(), refollowed["updated"].as_i64()),
        (Some(0), Some(0))
    );

    let started = Instant::now();
    vault
        .read(|connection| {
            let door = TestDoor::new(connection);
            // A WEEK OF STEPS IS THE MEAN OF THOSE SEVEN DAYS.
            let series = queries::series(&door, Metric::Steps, Range::Week, today).expect("series");
            assert_eq!(series.buckets.len(), 7);
            let week: f64 = (today - 6..=today).map(|day| value(day, 0)).sum::<f64>() / 7.0;
            let average = series.average.expect("an average");
            assert!((average - week).abs() < 1e-6, "{average} vs {week}");
            let year = queries::series(&door, Metric::SleepMin, Range::Year, today).expect("year");
            assert_eq!(year.buckets.len(), 12);
            let trends = queries::trends(&door, TrendRange::Year, today).expect("trends");
            assert_eq!(trends.trends.len(), 6);
            let answer = queries::today(
                &door,
                today,
                "2026-10-20T00:00:00.000Z",
                "2026-10-21T00:00:00.000Z",
            )
            .expect("today");
            assert_eq!(answer.metrics_with_data.len(), 6);
            assert!(answer.connected);

            // EVERY WORKOUT IS REACHED BY WALKING THE PAGES, NEWEST FIRST, EACH ONCE.
            let (mut seen, mut after, mut last) = (0_usize, None, String::new());
            loop {
                let page = queries::workouts(&door, None, &PageRequest { limit: 200, after })
                    .expect("workouts");
                for row in &page.rows {
                    assert!(last.is_empty() || row.started_at <= last, "newest first");
                    last.clone_from(&row.started_at);
                }
                seen += page.rows.len();
                assert_eq!(
                    page.kinds.iter().map(|kind| kind.count).sum::<usize>(),
                    shape.workouts
                );
                after = page.next;
                if after.is_none() {
                    break;
                }
            }
            assert_eq!(seen, shape.workouts);
            let view = queries::follow_view(&door, today, |instant| parse_day(&instant[..10]))
                .expect("view");
            assert_eq!(view.latest_day.as_deref(), Some(TODAY));
            Ok(())
        })
        .expect("reads");
    println!("the screens in {:?}", started.elapsed());
    let _ = std::fs::remove_dir_all(dir);
}

/// ONE YEAR AND 300 WORKOUTS: the shape of the full run.
#[test]
fn a_year_of_days_and_300_workouts_write_read_and_reconcile() {
    run(&SAMPLE);
}

/// THE FULL PROFILE: three years of six totals and 1,200 workouts.
#[test]
#[ignore = "the full year-3 profile; run on its own with --ignored"]
fn three_years_of_days_and_1200_workouts_write_read_and_reconcile() {
    run(&YEAR3);
}
