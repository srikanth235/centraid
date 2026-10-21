# `crates/apps/health` — the phone's daily totals and workouts

Health follows the phone's health store one way — HealthKit on iOS, Health Connect on Android — into the vault ([#1129](https://github.com/srikanth235/centraid/issues/1129)). The vault keeps **daily totals** (`measurement`: steps, active energy, exercise minutes, sleep, resting heart rate and weight, one stated total per day and metric) and **workouts** (an `activity` of a workout kind with a `workout` row beside it), and this crate computes every figure a Health screen draws. Its doctrine:

- today is compared with the member's **own 30-day typical** — the median of the 30 whole days before today that have a row — and its usual range (25th to 75th percentile), never with a target (R-1129-8);
- a day with no row is **not a day of zero**: an average is over the days that have one, and a figure nothing feeds is absent;
- a metric folds its own way: steps, energy and exercise are sums (a period has a total), sleep is a night's total (never added across nights), resting heart rate an average, and weight's figure for a span is its **newest** value;
- **nothing derived is stored**: the figures are Rust's (R-1129-12), and a shell formats them by the phone's locale and computes none;
- nothing is ever written to the health store (R-1129-7), and Chat does not read Health (R-1129-11).

## Modules

| Module | What it owns |
| --- | --- |
| `civil` | `YYYY-MM-DD` days as counts, month steps, and the vault's spelling of a UTC instant. No zone and no clock: the caller states `today` |
| `figures` | The pure folds: `Metric` and its `Fold`, the R-7 quantile, the typical before today, a span's figure and total, day, month and even-run buckets, the best bucket and days above typical. Unit-tested on hand-made days |
| `door` | Every read as a `PageQuery` with a stated ceiling: a subject's days over a range, the newest day, the health origin, the workout kinds, a page of workouts on the `(started_at, activity_id)` index, one day's workouts, and the measured rows by id. One table per statement; a read past its ceiling is an error, never a short answer |
| `queries` | The six answers `health.proto` carries: Today, a metric's Series, the Trends, a page of Workouts with the kind counts, one Workout, and the follower's view (the newest day, the newest workout and the days since a day, R-1129-3, R-1129-4) |
| `manifest` | `manifest.json` (id `health`, `Activity`, `olive`, R-1129-10) parsed by the kit; its three actions are the vault's `measurement.record`, `follow.health` and `entity.trash`, schema for schema |

## What this crate may not contain, and what stops it

| Not allowed | What stops it |
| --- | --- |
| **SQL, in any form** | `cargo xtask rules`' `sql-confinement` scans this crate. The writes are the vault's `measurement.record`, `follow.health` and `entity.trash` |
| **A clock or a zone** | nothing here reads either; `today` and the instants that bound it come in from the caller |
| **A figure in Kotlin or Swift** | `health.proto`'s answers carry every number a screen draws; `crates/core`'s `app_query/health.rs` is the one conversion |
