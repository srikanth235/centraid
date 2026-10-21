//! # Health — the phone's daily totals and workouts, followed into the vault (#1129)
//!
//! Health follows the phone's health store one way (R-1127-1): HealthKit on iOS, Health Connect
//! on Android. The vault keeps daily totals (`health_daily`) and workouts (`health_workout`, the
//! health half of a `core_activity`); this crate reads them and computes every figure a Health
//! screen draws (R-1129-12):
//!
//! - **Today compares whole days** (R-1129-8): today's number against the member's own typical,
//!   the median of the 30 whole days before today that have a row, and its usual range, the
//!   25th to 75th percentile of the same days. Never a target.
//! - **A day with no row is not a day of zero**: an average is over the days that have one, and
//!   a figure nothing feeds is absent.
//! - **Nothing derived is stored**: the vault holds what the store stated, and every typical,
//!   average, bucket and best day is computed here at read time.
//!
//! The crate holds no SQL (`cargo xtask rules`, `sql-confinement`): [`door`] states its reads as
//! `PageQuery` values with stated ceilings, [`figures`] is pure, and [`queries`] is the six
//! answers `health.proto` carries. The writes are the vault's `health.*` commands, which the
//! shell's follower engine sends; Chat does not read Health (R-1129-11).

pub mod civil;
pub mod door;
pub mod figures;
pub mod manifest;
pub mod queries;
