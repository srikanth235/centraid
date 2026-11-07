//! HEALTH: four months of the phone's daily totals and a dozen workouts.
//!
//! Health follows the phone's health store one way, so the scenario seeds it the
//! way the follower writes it: the day totals through `measurement.record`
//! (one batch, one commit) and the workouts through `follow.health`, which is
//! also what founds the health origin the Today screen reads as "connected".
//!
//! **Every figure is a pure function of its day index.** No clock, no random
//! source: [`wobble`] is an integer hash, so the same `now` gives the same 120
//! days on every run, and a test can assert the counts and the odd values.
//!
//! **Not every day has every row, on purpose.** A day with no row is not a day
//! of zero (the crate's doctrine), so the weight is a weigh-in every few days
//! and a handful of resting-heart-rate days are missing: the average has to be
//! over the days that have one, and a gap is the case that proves it.

use serde_json::{Value, json};

use super::{DAY_MS, Seeder, at, day};

/// How many days back from the anchor the store is followed, today included.
pub const HEALTH_DAYS: i64 = 120;

/// The workouts the scenario follows, one per entry of [`WORKOUTS`].
pub const WORKOUT_COUNT: usize = 12;

/// A deterministic 0..1000 from a day index and a salt: an integer hash, so no
/// two metrics move together and no run moves differently.
fn wobble(index: i64, salt: i64) -> i64 {
    let mixed = (index.wrapping_add(1))
        .wrapping_mul(2_654_435_761)
        .wrapping_add(salt.wrapping_mul(40_503))
        .rem_euclid(1 << 31);
    ((mixed >> 7) ^ (mixed >> 3)).rem_euclid(1000)
}

/// A value `centre` plus or minus up to `spread`, from the hash.
fn around(centre: i64, spread: i64, index: i64, salt: i64) -> i64 {
    centre + (wobble(index, salt) * 2 * spread) / 1000 - spread
}

/// The `(day, metric, value)` triples, oldest first, `HEALTH_DAYS` of them.
///
/// `weekday` is derived from the epoch day so a weekend is a weekend whatever
/// the anchor: 1970-01-01 was a Thursday.
fn daily_totals(now: i64) -> Vec<Value> {
    let mut days = Vec::new();
    let anchor_day = now.div_euclid(DAY_MS);
    for ago in (0..HEALTH_DAYS).rev() {
        let index = HEALTH_DAYS - ago; // grows toward today
        let date = day(now, -ago);
        let weekend = matches!((anchor_day - ago + 4).rem_euclid(7), 0 | 6);
        // A fitter member each month: steps and exercise creep up, resting rate down.
        let fitness = index / 12;
        let steps = around(
            if weekend { 9_800 } else { 7_400 } + fitness * 90,
            2_600,
            index,
            1,
        );
        let mut put = |metric: &str, value: f64| {
            days.push(json!({ "day": date, "metric": metric, "value": value }));
        };
        put("steps", steps.max(1_200) as f64);
        put(
            "active_energy_kcal",
            around(430 + steps / 40, 90, index, 2) as f64,
        );
        put(
            "exercise_min",
            around(if weekend { 46 } else { 32 } + fitness, 16, index, 3).max(4) as f64,
        );
        put(
            "sleep_min",
            around(if weekend { 462 } else { 421 }, 48, index, 4) as f64,
        );
        // A few days the watch was off: no resting rate, and it is not a zero.
        if index % 17 != 5 {
            put(
                "resting_hr_bpm",
                around(63 - fitness / 2, 3, index, 5) as f64,
            );
        }
        // A weigh-in every third day, drifting down about a kilo in the window.
        if index % 3 == 0 {
            let tenths = 734 - index / 6 * 2 / 3 + around(0, 3, index, 6);
            put("weight_kg", tenths as f64 / 10.0);
        }
    }
    days
}

/// One workout: days before the anchor, hour, kind, minutes, then the measures
/// the watch states (distance in metres, energy in kcal, heart rate in bpm).
type Workout = (i64, i64, &'static str, i64, Option<f64>, f64, i64);

/// A dozen across the window: runs, walks, rides and strength, weekly-ish.
const WORKOUTS: [Workout; WORKOUT_COUNT] = [
    (1, 7, "run", 38, Some(6_420.0), 410.0, 154),
    (2, 18, "strength", 45, None, 280.0, 118),
    (4, 7, "run", 52, Some(8_900.0), 560.0, 158),
    (6, 17, "walk", 62, Some(5_100.0), 240.0, 104),
    (9, 8, "cycle", 74, Some(24_300.0), 610.0, 141),
    (12, 7, "run", 33, Some(5_300.0), 355.0, 151),
    (17, 18, "strength", 50, None, 310.0, 121),
    (24, 7, "run", 47, Some(7_700.0), 495.0, 156),
    (33, 9, "walk", 80, Some(6_800.0), 320.0, 101),
    (47, 8, "cycle", 95, Some(31_200.0), 740.0, 138),
    (71, 7, "run", 41, Some(6_900.0), 450.0, 153),
    (96, 18, "strength", 40, None, 250.0, 116),
];

fn workout_records(now: i64) -> Vec<Value> {
    WORKOUTS
        .iter()
        .enumerate()
        .map(
            |(index, (ago, hour, kind, minutes, distance, energy, heart))| {
                let mut measures = json!({
                    "recorded_by": "Apple Watch",
                    "moving_s": minutes * 60 - 90,
                    "energy_kcal": energy,
                    "heart_bpm": heart,
                });
                if let Some(distance) = distance {
                    measures["distance_m"] = json!(distance);
                }
                json!({
                    "external_id": format!("demo-wk-{index:02}"),
                    "fields": {
                        "kind": kind,
                        "starts": at(now, -ago, *hour, 0),
                        "ends": at(now, -ago, *hour, *minutes),
                        "workout": measures,
                    },
                })
            },
        )
        .collect()
}

/// Seed Health: the totals, then the follow that makes the store "connected".
pub(super) fn seed_health(seeder: &mut Seeder, now: i64) {
    seeder.run("measurement.record", json!({ "days": daily_totals(now) }));
    seeder.run(
        "follow.health",
        json!({
            "origin": { "ref": "store:apple-health", "label": "Apple Health" },
            "records": workout_records(now),
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_totals_are_a_pure_function_of_the_anchor_and_leave_honest_gaps() {
        let now = 1_767_225_600_000;
        let first = daily_totals(now);
        assert_eq!(first, daily_totals(now));
        let of = |metric: &str| first.iter().filter(|row| row["metric"] == metric).count();
        let whole = usize::try_from(HEALTH_DAYS).expect("days");
        for metric in ["steps", "active_energy_kcal", "exercise_min", "sleep_min"] {
            assert_eq!(of(metric), whole, "{metric}");
        }
        assert!(of("resting_hr_bpm") < whole, "the watch was off some days");
        assert!(of("weight_kg") > 30 && of("weight_kg") < whole);
        assert!(
            first
                .iter()
                .all(|row| row["value"].as_f64().unwrap_or(-1.0) >= 0.0)
        );
    }
}
