//! What Health reads, against a vault the product founds and Health's own commands
//! fill (#1135): a fortnight of days recorded through `measurement.record`, two
//! workouts followed through `follow.health`, and each answer asked through the
//! paged door a phone's core asks through.

use std::sync::Arc;

use centraid_apps_health::civil::{format_day, parse_day};
use centraid_apps_health::figures::Metric;
use centraid_apps_health::queries::{self, Range};
use centraid_apps_kit::page::PageRequest;
use centraid_apps_kit::testdoor::TestDoor;
use centraid_vault::clock::{FixedClock, SeededIds};
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal, Vault};
use serde_json::{Value, json};

struct World {
    dir: std::path::PathBuf,
    vault: Vault,
    registry: Registry,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl World {
    fn founded() -> Self {
        let dir = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let vault = Vault::create_with(
            dir.join("vault.db"),
            Box::new(Arc::new(FixedClock::frozen())),
            Box::new(SeededIds::new("health")),
        )
        .expect("a vault");
        vault.found("Home", "Owner").expect("founded");
        Self {
            dir,
            vault,
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn ok(&self, name: &str, input: Value) -> Value {
        let outcome = self
            .vault
            .execute(
                &self.registry,
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

    fn read<T>(&self, body: impl FnOnce(&TestDoor<'_>) -> T) -> T {
        self.vault
            .read(|connection| Ok(body(&TestDoor::new(connection))))
            .expect("reads")
    }

    fn workout_id(&self, external: &str) -> String {
        self.read(|door| {
            centraid_apps_kit::reads::read_by_id(
                door,
                "health.test.workout",
                "entity_id, external_id",
                "source",
                "external_id",
                external,
            )
            .expect("the door answers")
            .and_then(|row| centraid_apps_kit::row::text_of(&row, "entity_id"))
        })
        .expect("a followed workout")
    }
}

const TODAY: &str = "2026-10-20";

fn today() -> i64 {
    parse_day(TODAY).expect("a day")
}

/// A fortnight of steps and sleep, two weigh-ins, a run this morning and a walk
/// two days ago.
fn fortnight() -> World {
    let world = World::founded();
    let mut days = Vec::new();
    for index in 0..14_i64 {
        let day = format!("2026-10-{:02}", 7 + index);
        days.push(json!({ "day": day, "metric": "steps", "value": 5_000 + 100 * index }));
        days.push(json!({ "day": day, "metric": "sleep_min", "value": 420 }));
    }
    days.push(json!({ "day": "2026-10-10", "metric": "weight_kg", "value": 72.0 }));
    days.push(json!({ "day": "2026-10-17", "metric": "weight_kg", "value": 71.4 }));
    assert_eq!(
        world.ok("measurement.record", json!({ "days": days }))["written"],
        30
    );
    world.ok(
        "follow.health",
        json!({
            "origin": { "ref": "store:apple-health", "label": "Apple Health" },
            "records": [
                { "external_id": "wk-run", "fields": {
                    "kind": "run", "starts": "2026-10-20T07:00:00Z", "ends": "2026-10-20T07:41:00Z",
                    "workout": { "recorded_by": "Apple Watch", "moving_s": 2400,
                                 "distance_m": 8012.5, "heart_bpm": 151, "climb_m": 38.5 },
                } },
                { "external_id": "wk-walk", "fields": {
                    "kind": "walk", "starts": "2026-10-18T17:30:00Z", "ends": "2026-10-18T18:10:00Z",
                } },
            ],
        }),
    );
    world
}

#[test]
fn today_reads_the_days_the_workouts_of_the_day_and_whether_a_store_is_followed() {
    let world = fortnight();
    let answer = world.read(|door| {
        queries::today(
            door,
            today(),
            "2026-10-20T00:00:00.000Z",
            "2026-10-21T00:00:00.000Z",
        )
        .expect("today")
    });
    let steps = answer
        .metrics
        .iter()
        .find(|metric| metric.metric == Metric::Steps)
        .expect("steps");
    assert_eq!(steps.value.as_ref().map(|(_, value)| *value), Some(6_300.0));
    assert_eq!(answer.workouts.len(), 1);
    let run = &answer.workouts[0];
    assert_eq!(
        (
            run.kind.key.as_str(),
            run.kind.label.as_str(),
            run.moving_sec,
            run.avg_hr_bpm
        ),
        ("run", "Run", Some(2_400), Some(151))
    );
    assert_eq!(run.activity_id, world.workout_id("wk-run"));
    assert!(answer.connected);
    // A vault no store was ever followed in is not connected.
    let bare = World::founded();
    assert!(
        !bare
            .read(|door| queries::today(door, today(), "a", "b").expect("today"))
            .connected
    );
}

#[test]
fn workouts_page_newest_first_with_every_kind_counted_and_a_trashed_one_gone() {
    let world = fortnight();
    let first =
        world.read(|door| queries::workouts(door, None, &PageRequest::first(1)).expect("workouts"));
    assert_eq!(first.rows.len(), 1);
    assert_eq!(first.rows[0].activity_id, world.workout_id("wk-run"));
    assert!(first.next.is_some());
    let kinds: Vec<(&str, usize)> = first
        .kinds
        .iter()
        .map(|kind| (kind.kind.label.as_str(), kind.count))
        .collect();
    assert_eq!(kinds, [("Run", 1), ("Walk", 1)]);
    let second = world.read(|door| {
        queries::workouts(
            door,
            None,
            &PageRequest {
                limit: 1,
                after: first.next.clone(),
            },
        )
        .expect("workouts")
    });
    assert_eq!(second.rows.len(), 1);
    assert_eq!(second.rows[0].activity_id, world.workout_id("wk-walk"));
    let walks = world.read(|door| {
        queries::workouts(door, Some("workout_kind:walk"), &PageRequest::first(50))
            .expect("workouts")
    });
    assert_eq!(walks.rows.len(), 1);
    // The member's delete is the shared trash; a workout in it is in no list.
    world.ok("entity.trash", json!({ "id": world.workout_id("wk-walk") }));
    let after = world
        .read(|door| queries::workouts(door, None, &PageRequest::first(50)).expect("workouts"));
    assert_eq!(after.rows.len(), 1);
    let none =
        world.read(|door| queries::workout(door, &world.workout_id("wk-walk")).expect("workout"));
    assert!(none.is_none());
}

#[test]
fn a_series_and_the_follow_view_read_the_days_and_the_latests() {
    let world = fortnight();
    let series = world
        .read(|door| queries::series(door, Metric::Steps, Range::Week, today()).expect("series"));
    assert_eq!(series.buckets.len(), 7);
    assert_eq!(series.average.map(|average| average.round()), Some(6_000.0));
    let view = world.read(|door| {
        queries::follow_view(door, today(), |instant| parse_day(&instant[..10])).expect("view")
    });
    assert_eq!(view.latest_day.as_deref(), Some("2026-10-20"));
    assert_eq!(
        view.latest_workout_started_at.as_deref(),
        Some("2026-10-20T07:00:00.000Z")
    );
    assert!(
        view.days
            .iter()
            .all(|day| parse_day(&day.day) >= Some(view.totals_from))
    );
}

/// `count` days of `metric` ending on `TODAY`, `value(n)` for the day `n` days before today.
fn record_days(world: &World, metric: &str, count: i64, value: impl Fn(i64) -> f64) {
    for chunk in (0..count).rev().collect::<Vec<_>>().chunks(100) {
        let days: Vec<_> = chunk
            .iter()
            .map(|back| {
                json!({
                    "day": format_day(today() - back),
                    "metric": metric,
                    "value": value(*back),
                })
            })
            .collect();
        world.ok("measurement.record", json!({ "days": days }));
    }
}

#[test]
fn today_carries_the_last_seven_days_and_the_thirty_day_change_the_trends_would_say() {
    let world = World::founded();
    // 30 days at 5,000 steps, then 30 at 6,000: +20%. Sleep only the last three nights.
    record_days(&world, "steps", 60, |back| {
        if back < 30 { 6_000.0 } else { 5_000.0 }
    });
    record_days(&world, "sleep_min", 3, |_| 420.0);
    let answer = world.read(|door| {
        queries::today(
            door,
            today(),
            "2026-10-20T00:00:00.000Z",
            "2026-10-21T00:00:00.000Z",
        )
        .expect("today")
    });
    let steps = &answer.metrics[0];
    assert_eq!(steps.metric, Metric::Steps);
    assert_eq!(steps.week.len(), 7);
    assert_eq!(steps.week[0].first, today() - 6);
    assert_eq!(steps.week[6].last, today());
    assert!(
        steps
            .week
            .iter()
            .all(|bucket| bucket.value == Some(6_000.0))
    );
    assert_eq!(steps.month_change_pct.map(f64::round), Some(20.0));
    // The Trends' 30-day change for the same metric is the same figure.
    let trends = world
        .read(|door| queries::trends(door, queries::TrendRange::Days30, today()).expect("trends"));
    let trend = trends
        .trends
        .iter()
        .find(|trend| trend.metric == Metric::Steps)
        .expect("steps trend");
    assert_eq!(steps.month_change_pct, trend.change_pct);
    // A night with no row is a gap in the week, and the month has nothing before to compare.
    let sleep = &answer.metrics[1];
    let values: Vec<Option<f64>> = sleep.week.iter().map(|bucket| bucket.value).collect();
    assert_eq!(
        values,
        [
            None,
            None,
            None,
            None,
            Some(420.0),
            Some(420.0),
            Some(420.0)
        ]
    );
    assert_eq!(sleep.month_change_pct, None);
}

#[test]
fn six_months_is_twenty_six_weeks_ending_today_against_the_twenty_six_before() {
    let world = World::founded();
    // The 26 weeks before at 4,000 a day, the last 26 at 8,000.
    record_days(&world, "steps", 364, |back| {
        if back < 182 { 8_000.0 } else { 4_000.0 }
    });
    let series = world.read(|door| {
        queries::series(door, Metric::Steps, Range::SixMonths, today()).expect("series")
    });
    assert_eq!(series.buckets.len(), 26);
    assert_eq!(series.buckets[0].first, today() - 181);
    assert_eq!(series.buckets[25].last, today());
    assert!(
        series
            .buckets
            .iter()
            .all(|bucket| bucket.last - bucket.first == 6 && bucket.days == 7)
    );
    // Contiguous: each week starts the day after the one before ended.
    assert!(
        series
            .buckets
            .windows(2)
            .all(|pair| pair[1].first == pair[0].last + 1)
    );
    assert_eq!(series.average, Some(8_000.0));
    assert_eq!(series.previous_average, Some(4_000.0));
    // Like a year, the typical is the period before's average, with no range of its own.
    assert_eq!(series.typical, Some(4_000.0));
    assert_eq!((series.typical_low, series.typical_high), (None, None));
    assert_eq!((series.above_typical, series.counted), (26, 26));
    assert_eq!(series.total, Some(8_000.0 * 182.0));
}

#[test]
fn a_weeks_typical_range_is_the_quartiles_of_the_thirty_days_before() {
    let world = World::founded();
    // The day n back is n × 1,000 steps, so the 30 whole days before today are 1,000 to 30,000.
    record_days(&world, "steps", 31, |back| 1_000.0 * back as f64);
    let series = world
        .read(|door| queries::series(door, Metric::Steps, Range::Week, today()).expect("series"));
    assert_eq!(series.typical, Some(15_500.0));
    assert_eq!(series.typical_low, Some(8_250.0));
    assert_eq!(series.typical_high, Some(22_750.0));
}
