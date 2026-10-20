//! Health's arm, through `Handle::call` — the door a shell uses — over a fortnight of daily
//! totals and two workouts written by the real `health.*` commands (#1129).
//!
//! What each test holds:
//!
//! 1. **Each of the six answers reads the real vault** and says what the crate's figures say:
//!    today against the typical of the whole days before it, a week's series and its facts, the
//!    trends, a page of workouts with the kind counts and its cursor, one workout, and the
//!    follower's view.
//! 2. **What the request states is checked, never guessed**: a day the calendar has not got, an
//!    instant with an offset, a page with no limit and an unnamed metric are
//!    `ERROR_CODE_INVALID_REQUEST`.

use super::*;
use crate::config::CoreConfig;
use crate::handle::{Core, Handle};
use serde_json::json;
use wire::app_query_request::Query as Q;

/// 15:00Z on 20 October 2026; the caller's day is the 20th.
const NOW: &str = "2026-10-20T15:00:00.000Z";
const TODAY: &str = "2026-10-20";

struct Scratch {
    dir: std::path::PathBuf,
    handle: Handle,
    writes: std::cell::Cell<u32>,
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Scratch {
    fn founded() -> Self {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("the directory is made");
        let now = centraid_vault::time::recurrence::parse_instant_ms(NOW).expect("an instant");
        let config = CoreConfig::new(dir.join("vault.db")).with_clock(
            std::sync::Arc::new(centraid_vault::clock::FixedClock::at(now)),
            std::sync::Arc::new(centraid_vault::clock::ClockIds::new(Box::new(
                centraid_vault::clock::FixedClock::at(now),
            ))),
        );
        let handle = Core::open(config).expect("it opens");
        handle
            .with_vault(|vault| Ok(vault.found("Health", "Owner")?))
            .expect("it founds");
        Self {
            dir,
            handle,
            writes: std::cell::Cell::new(0),
        }
    }

    fn try_ask(&self, query: Q) -> Result<Answer> {
        match self
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::AppQuery(wire::AppQueryRequest {
                    query: Some(query),
                })),
            })?
            .kind
        {
            Some(wire::response::Kind::AppQuery(answer)) => {
                Ok(answer.answer.expect("an app query is answered"))
            }
            other => panic!("an app query answered as {other:?}"),
        }
    }

    fn ask(&self, query: Q) -> Answer {
        self.try_ask(query).expect("the query answers")
    }

    fn run(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
        self.writes.set(self.writes.get() + 1);
        let response = self
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Command(wire::Command {
                    name: name.to_owned(),
                    input: serde_json::to_vec(&input).expect("json"),
                    invoke_key: format!("health-query-test-{}", self.writes.get()),
                    ..wire::Command::default()
                })),
            })
            .unwrap_or_else(|error| panic!("{name} errored: {error}"));
        let Some(wire::response::Kind::Command(outcome)) = response.kind else {
            panic!("a command answered with something else");
        };
        assert_eq!(
            outcome.status,
            wire::CommandStatus::Executed as i32,
            "{name}: {}",
            outcome.reason
        );
        serde_json::from_slice(&outcome.output).expect("the output is JSON")
    }

    /// A fortnight to today: steps rising by 100 a day from 5,000, seven hours of sleep every
    /// night, and two weigh-ins; a run this morning and a walk two days ago.
    fn fortnight() -> Self {
        let scratch = Self::founded();
        let mut days = Vec::new();
        for index in 0..14_i64 {
            let day = format!("2026-10-{:02}", 7 + index);
            days.push(json!({ "day": day, "metric": "steps", "value": 5_000 + 100 * index }));
            days.push(json!({ "day": day, "metric": "sleep_min", "value": 420 }));
        }
        days.push(json!({ "day": "2026-10-10", "metric": "weight_kg", "value": 72.0 }));
        days.push(json!({ "day": "2026-10-17", "metric": "weight_kg", "value": 71.4 }));
        let written = scratch.run("health.record_days", json!({ "days": days }));
        assert_eq!(written["written"], 30);
        scratch.run(
            "health.follow_workout",
            json!({
                "activity_id": "wk-run", "kind": "run", "phone_kind": "running",
                "started_at": "2026-10-20T07:00:00Z", "ended_at": "2026-10-20T07:41:00Z",
                "recorded_by": "Apple Watch", "moving_sec": 2400, "distance_m": 8012.5,
                "energy_kcal": 412.0, "avg_hr_bpm": 151, "elevation_gain_m": 38.5,
            }),
        );
        scratch.run(
            "health.follow_workout",
            json!({
                "activity_id": "wk-walk", "kind": "walk", "phone_kind": "walking",
                "started_at": "2026-10-18T17:30:00Z", "ended_at": "2026-10-18T18:10:00Z",
            }),
        );
        scratch
    }

    fn today(&self) -> wire::HealthToday {
        match self.ask(Q::HealthToday(wire::HealthTodayRequest {
            today: TODAY.to_owned(),
            day_start: "2026-10-20T00:00:00Z".to_owned(),
            day_end: "2026-10-21T00:00:00Z".to_owned(),
        })) {
            Answer::HealthToday(today) => today,
            other => panic!("today answered as {other:?}"),
        }
    }

    fn series(&self, metric: wire::HealthMetric, range: wire::HealthRange) -> wire::HealthSeries {
        match self.ask(Q::HealthSeries(wire::HealthSeriesRequest {
            metric: metric as i32,
            range: range as i32,
            today: TODAY.to_owned(),
        })) {
            Answer::HealthSeries(series) => series,
            other => panic!("a series answered as {other:?}"),
        }
    }

    fn workouts(
        &self,
        kind: Option<&str>,
        limit: u32,
        after: Option<wire::HealthWorkoutsCursor>,
    ) -> wire::HealthWorkouts {
        match self.ask(Q::HealthWorkouts(wire::HealthWorkoutsRequest {
            kind_concept_id: kind.map(str::to_owned),
            limit,
            after,
        })) {
            Answer::HealthWorkouts(workouts) => workouts,
            other => panic!("workouts answered as {other:?}"),
        }
    }
}

fn close(left: Option<f64>, right: f64) -> bool {
    left.is_some_and(|left| (left - right).abs() < 1e-9)
}

fn metric<'a>(
    today: &'a wire::HealthToday,
    which: wire::HealthMetric,
) -> &'a wire::HealthTodayMetric {
    today
        .metrics
        .iter()
        .find(|metric| metric.metric == which as i32)
        .expect("all six are listed")
}

#[test]
fn today_compares_today_with_the_whole_days_before_it() {
    let scratch = Scratch::fortnight();
    let today = scratch.today();
    assert_eq!(today.today, TODAY);
    let order: Vec<i32> = today.metrics.iter().map(|metric| metric.metric).collect();
    assert_eq!(
        order,
        [
            wire::HealthMetric::Steps,
            wire::HealthMetric::SleepMin,
            wire::HealthMetric::ActiveEnergyKcal,
            wire::HealthMetric::ExerciseMin,
            wire::HealthMetric::RestingHrBpm,
            wire::HealthMetric::WeightKg,
        ]
        .map(|metric| metric as i32)
    );

    // Steps: today's row against the 13 whole days before it (5,000 to 6,200).
    let steps = metric(&today, wire::HealthMetric::Steps);
    assert!(close(steps.value, 6_300.0));
    assert_eq!(steps.day.as_deref(), Some(TODAY));
    assert!(close(steps.typical, 5_600.0));
    assert!(close(steps.low, 5_300.0));
    assert!(close(steps.high, 5_900.0));
    assert_eq!(steps.typical_days, 13);

    // Weight: the newest weigh-in in the 30 days, and the typical of the two before today.
    let weight = metric(&today, wire::HealthMetric::WeightKg);
    assert!(close(weight.value, 71.4));
    assert_eq!(weight.day.as_deref(), Some("2026-10-17"));
    assert!(close(weight.typical, 71.7));
    assert_eq!(weight.typical_days, 2);

    // A metric the store never reported is absent, not zero.
    let heart = metric(&today, wire::HealthMetric::RestingHrBpm);
    assert_eq!(
        (heart.value, heart.typical, heart.typical_days),
        (None, None, 0)
    );
    assert_eq!(
        today.metrics_with_data,
        [
            wire::HealthMetric::Steps as i32,
            wire::HealthMetric::SleepMin as i32,
            wire::HealthMetric::WeightKg as i32
        ]
    );

    // Today's workouts are the ones that started in the caller's day.
    let ids: Vec<&str> = today
        .workouts
        .iter()
        .map(|workout| workout.activity_id.as_str())
        .collect();
    assert_eq!(ids, ["wk-run"]);
    assert_eq!(today.workouts[0].started_at, "2026-10-20T07:00:00.000Z");

    // Connected is a health origin, which the engine registers when the member connects.
    assert!(!today.connected);
    scratch.run(
        "phone.origin",
        json!({ "source": "health", "phone_origin": "store:apple-health", "label": "Apple Health" }),
    );
    assert!(scratch.today().connected);
}

#[test]
fn a_weeks_series_carries_its_buckets_and_the_facts_under_the_chart() {
    let scratch = Scratch::fortnight();
    let week = scratch.series(wire::HealthMetric::Steps, wire::HealthRange::Week);
    let starts: Vec<&str> = week.buckets.iter().map(|b| b.start.as_str()).collect();
    assert_eq!(
        starts,
        [
            "2026-10-14",
            "2026-10-15",
            "2026-10-16",
            "2026-10-17",
            "2026-10-18",
            "2026-10-19",
            "2026-10-20"
        ]
    );
    assert!(close(week.buckets[0].value, 5_700.0));
    assert!(close(week.average, 6_000.0));
    assert!(close(week.previous_average, 5_300.0));
    assert!(close(week.typical, 5_600.0));
    assert!(close(week.total, 42_000.0));
    let best = week.best.expect("a best day");
    assert_eq!(best.start, TODAY);
    assert!(close(best.value, 6_300.0));
    assert_eq!((week.above_typical, week.counted), (7, 7));

    // Weight has no total and no best; its week's figure is its newest.
    let weight = scratch.series(wire::HealthMetric::WeightKg, wire::HealthRange::Week);
    assert!(close(weight.average, 71.4));
    assert_eq!((weight.total, weight.best), (None, None));

    // A year is twelve calendar months, the current one ending today.
    let year = scratch.series(wire::HealthMetric::Steps, wire::HealthRange::Year);
    assert_eq!(year.buckets.len(), 12);
    let october = year.buckets.last().expect("this month");
    assert_eq!(
        (october.start.as_str(), october.end.as_str()),
        ("2026-10-01", TODAY)
    );
    assert_eq!(october.days, 14);
    assert!(close(october.value, 5_650.0));
    assert_eq!(
        year.typical, None,
        "no year before this one to compare with"
    );
}

#[test]
fn the_trends_leave_out_a_metric_with_no_data_and_split_thirty_days_in_nine() {
    let scratch = Scratch::fortnight();
    let Answer::HealthTrends(trends) = scratch.ask(Q::HealthTrends(wire::HealthTrendsRequest {
        range: wire::HealthTrendRange::Days30 as i32,
        today: TODAY.to_owned(),
    })) else {
        panic!("trends answered as something else");
    };
    let metrics: Vec<i32> = trends.trends.iter().map(|trend| trend.metric).collect();
    assert_eq!(
        metrics,
        [
            wire::HealthMetric::Steps as i32,
            wire::HealthMetric::SleepMin as i32,
            wire::HealthMetric::WeightKg as i32
        ]
    );
    let steps = &trends.trends[0];
    assert!(close(steps.average, 5_650.0));
    assert_eq!(steps.previous, None);
    assert_eq!(steps.buckets.len(), 9);
    assert_eq!(steps.buckets[0].start, "2026-09-21");
    assert_eq!(steps.buckets.last().map(|b| b.end.as_str()), Some(TODAY));
    let weight = &trends.trends[2];
    assert!(close(weight.average, 71.4), "weight's figure is its newest");
}

#[test]
fn workouts_page_newest_first_with_every_kind_counted() {
    let scratch = Scratch::fortnight();
    let first = scratch.workouts(None, 1, None);
    assert_eq!(first.workouts.len(), 1);
    let run = &first.workouts[0];
    assert_eq!(
        (
            run.activity_id.as_str(),
            run.kind_key.as_str(),
            run.kind_label.as_str()
        ),
        ("wk-run", "run", "Run")
    );
    assert_eq!(run.kind_concept_id, "health:kind:run");
    assert_eq!(run.phone_kind, "running");
    assert_eq!(run.ended_at, "2026-10-20T07:41:00.000Z");
    assert_eq!(run.moving_sec, Some(2400));
    assert!(close(run.distance_m, 8_012.5));
    assert_eq!(run.avg_hr_bpm, Some(151));
    assert_eq!(run.recorded_by.as_deref(), Some("Apple Watch"));
    let kinds: Vec<(&str, u32)> = first
        .kinds
        .iter()
        .map(|kind| (kind.kind_label.as_str(), kind.count))
        .collect();
    assert_eq!(kinds, [("Run", 1), ("Walk", 1)]);

    let second = scratch.workouts(None, 1, first.next);
    let walk = &second.workouts[0];
    assert_eq!(walk.activity_id, "wk-walk");
    assert_eq!(
        (
            walk.distance_m,
            walk.moving_sec,
            walk.recorded_by.as_deref()
        ),
        (None, None, None)
    );
    assert_eq!(second.next, None, "the walk was the last workout");

    let walks = scratch.workouts(Some("health:kind:walk"), 50, None);
    assert_eq!(walks.workouts.len(), 1);
    assert_eq!(
        walks.kinds.len(),
        2,
        "the chips count every kind whatever the filter"
    );
}

#[test]
fn one_workout_reads_whole_and_an_activity_that_is_not_one_reads_as_none() {
    let scratch = Scratch::fortnight();
    let Answer::HealthWorkout(found) = scratch.ask(Q::HealthWorkout(wire::HealthWorkoutRequest {
        activity_id: "wk-run".to_owned(),
    })) else {
        panic!("a workout answered as something else");
    };
    assert!(close(found.workout.expect("the run").energy_kcal, 412.0));

    let person = scratch.run(
        "people.add_person",
        json!({ "display_name": "Ada", "cadence_days": 30 }),
    )["party_id"]
        .as_str()
        .expect("a party")
        .to_owned();
    // A logged interaction is an activity with no workout row.
    let interaction = scratch.run(
        "people.log_interaction",
        json!({ "party_id": person, "kind": "call" }),
    )["interaction_id"]
        .as_str()
        .expect("an interaction id")
        .to_owned();
    for id in [interaction.as_str(), "nobody"] {
        let Answer::HealthWorkout(none) =
            scratch.ask(Q::HealthWorkout(wire::HealthWorkoutRequest {
                activity_id: id.to_owned(),
            }))
        else {
            panic!("a workout answered as something else");
        };
        assert_eq!(none.workout, None, "{id}");
    }
}

#[test]
fn the_follow_view_names_the_two_latests_and_every_day_since() {
    let scratch = Scratch::fortnight();
    let Answer::HealthFollowView(view) =
        scratch.ask(Q::HealthFollowView(wire::HealthFollowViewRequest {
            since: "2026-10-14".to_owned(),
        }))
    else {
        panic!("the follow view answered as something else");
    };
    assert_eq!(view.latest_day.as_deref(), Some(TODAY));
    assert_eq!(
        view.latest_workout_started_at.as_deref(),
        Some("2026-10-20T07:00:00.000Z")
    );
    // Seven days of steps and sleep, and the weigh-in on the 17th.
    assert_eq!(view.days.len(), 15);
    assert_eq!(view.days[0].day, "2026-10-14");
    assert!(view.days.iter().all(|day| day.day.as_str() >= "2026-10-14"));

    // An empty vault answers with nothing rather than refusing.
    let empty = Scratch::founded();
    let Answer::HealthFollowView(view) =
        empty.ask(Q::HealthFollowView(wire::HealthFollowViewRequest {
            since: "2026-10-14".to_owned(),
        }))
    else {
        panic!("the follow view answered as something else");
    };
    assert_eq!(
        (
            view.latest_day,
            view.latest_workout_started_at,
            view.days.len()
        ),
        (None, None, 0)
    );
}

#[test]
fn what_a_request_states_is_checked_never_guessed() {
    let scratch = Scratch::founded();
    let refused = |query: Q| {
        matches!(
            scratch.try_ask(query),
            Err(CoreError::InvalidRequest { .. })
        )
    };
    assert!(refused(Q::HealthToday(wire::HealthTodayRequest {
        today: "2026-02-30".to_owned(),
        day_start: "2026-02-28T00:00:00Z".to_owned(),
        day_end: "2026-03-01T00:00:00Z".to_owned(),
    })));
    assert!(refused(Q::HealthToday(wire::HealthTodayRequest {
        today: TODAY.to_owned(),
        day_start: "2026-10-20T00:00:00+02:00".to_owned(),
        day_end: "2026-10-21T00:00:00Z".to_owned(),
    })));
    assert!(refused(Q::HealthSeries(wire::HealthSeriesRequest {
        metric: wire::HealthMetric::Unspecified as i32,
        range: wire::HealthRange::Week as i32,
        today: TODAY.to_owned(),
    })));
    assert!(refused(Q::HealthWorkouts(wire::HealthWorkoutsRequest {
        kind_concept_id: None,
        limit: 0,
        after: None,
    })));
    assert!(refused(Q::HealthFollowView(
        wire::HealthFollowViewRequest {
            since: String::new(),
        }
    )));
}
