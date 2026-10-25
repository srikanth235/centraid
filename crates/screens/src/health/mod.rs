//! HEALTH'S SCREENS (#1135): Today · Trends · Workouts under one band with More
//! as sheets, one metric over a week, a month or a year, one workout, and
//! Connect. Every decision a person sees is made here; SwiftUI and Compose draw
//! [`wire::ViewState`].
//!
//! | Screen | Route name | Machine |
//! |---|---|---|
//! | Today · Trends · Workouts, with More | [`HOME`] | [`home`] |
//! | One metric over a week, a month or a year | [`METRIC`] | [`metric`] |
//! | One workout | [`WORKOUT`] | [`workout`] |
//! | What Health may read, and Connect | [`CONNECT`] | [`connect`] |
//!
//! ## Reads and writes
//!
//! Every read is `health.today`, `series`, `trends`, `workouts`, `workout` or
//! `follow-view`; every write is a manifest action (`record-days`,
//! `follow-workouts`, `stop-following`): the same door chat and the training
//! harness use. The figures are the core's (R-1129-12); [`figures`] only
//! formats them, in the phone's units.
//!
//! ## The phone's store
//!
//! HealthKit and Health Connect are read by the shell, as one generic effect
//! ([`wire::HealthRead`], answered with a [`wire::HealthSnapshot`]). What a pass
//! sends, the zero rule, a workout's identity and kind, and when a read may
//! judge a workout gone are [`follow`]'s; the member's choice of types is a
//! keychain habit of this phone, never a vault row (R-1129-6).
//!
//! Nothing here is written back to the store (R-1129-7).

use centraid_api_proto::core_v1 as wire;

use crate::Registry;
use crate::kit::read::Reading;
use crate::screen::Ctx;
use crate::strings::{Locale, health as words};

pub mod connect;
pub mod figures;
pub mod follow;
pub mod home;
pub mod kinds;
pub mod metric;
pub mod workout;

pub const HOME: &str = "health.home";
pub const METRIC: &str = "health.metric";
pub const WORKOUT: &str = "health.workout";
pub const CONNECT: &str = "health.connect";

/// The tab Health's pages are pushed under.
pub const TAB: &str = "health";

/// Every Health screen, registered under its route name.
#[must_use]
pub fn registry() -> Registry {
    Registry::default()
        .with(HOME, home::build)
        .with(METRIC, metric::build)
        .with(WORKOUT, workout::build)
        .with(CONNECT, connect::build)
}

/// A runtime with Health's screens and one tab, `health`, rooted at Today. The
/// shell's real runtime composes [`registry`] with the other apps'; this is what
/// Health's own tests drive.
#[must_use]
pub fn runtime() -> crate::Runtime {
    crate::Runtime::new(
        registry(),
        vec![(TAB.to_owned(), routes::home(wire::HealthDestination::Today))],
    )
}

/// What a page holds of its reads: nothing yet, a refusal, a gate or the answer.
/// A failed read is never an empty list.
#[derive(Clone, Debug)]
pub(crate) enum Phase<T> {
    Loading,
    Failed,
    Denied(wire::AppQueryDenial),
    Ready(T),
}

impl<T> Phase<T> {
    pub(crate) fn of(reading: Reading<T>) -> Self {
        match reading {
            Reading::Data(data) => Self::Ready(data),
            Reading::Denied(denial) => Self::Denied(denial),
            Reading::Failed => Self::Failed,
        }
    }

    pub(crate) fn data(&self) -> Option<&T> {
        match self {
            Self::Ready(data) => Some(data),
            _ => None,
        }
    }
}

/// The gate drawn when the vault will not let Health read.
pub(crate) fn denied(locale: Locale, denial: &wire::AppQueryDenial) -> wire::Denied {
    wire::Denied {
        title: words::denied_title(locale),
        body: words::denied_body(locale),
        receipt: denial
            .code
            .clone()
            .unwrap_or_else(|| words::denied_scope(locale)),
    }
}

/// The measurement system the phone's locale uses: only the regions that
/// measure in miles and pounds read as imperial (display only: storage is the
/// metric's own unit).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Units {
    Metric,
    Imperial,
}

impl Units {
    /// The units of the device `ctx` describes.
    #[must_use]
    pub fn of(ctx: &Ctx) -> Self {
        if matches!(ctx.region(), "US" | "LR" | "MM") {
            Self::Imperial
        } else {
            Self::Metric
        }
    }
}

/// The health store this phone has: Apple Health on iOS, Health Connect on
/// Android. One origin each (R-1129-2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Store {
    AppleHealth,
    HealthConnect,
    /// The shell has not said which OS it is.
    Any,
}

impl Store {
    /// The store of the device `ctx` describes.
    #[must_use]
    pub fn of(ctx: &Ctx) -> Self {
        match ctx.platform() {
            "ios" => Self::AppleHealth,
            "android" => Self::HealthConnect,
            _ => Self::Any,
        }
    }

    /// The store the shell named in a snapshot.
    #[must_use]
    pub fn of_snapshot(snapshot: &wire::HealthSnapshot) -> Self {
        match wire::health_snapshot::Store::try_from(snapshot.store) {
            Ok(wire::health_snapshot::Store::AppleHealth) => Self::AppleHealth,
            Ok(wire::health_snapshot::Store::HealthConnect) => Self::HealthConnect,
            _ => Self::Any,
        }
    }

    /// The vault's origin for the store (`system: health`, `ref`).
    #[must_use]
    pub const fn origin(self) -> Option<&'static str> {
        match self {
            Self::AppleHealth => Some("store:apple-health"),
            Self::HealthConnect => Some("store:health-connect"),
            Self::Any => None,
        }
    }

    /// The store's name as the member reads it.
    #[must_use]
    pub fn name(self, locale: Locale) -> String {
        match self {
            Self::AppleHealth => words::store_apple_health(locale),
            Self::HealthConnect => words::store_health_connect(locale),
            Self::Any => words::store_any(locale),
        }
    }

    /// Both stores, for Stop (which retires whichever origin the vault holds).
    pub const BOTH: [Self; 2] = [Self::AppleHealth, Self::HealthConnect];
}

/// THE SIX DAILY METRICS, ONCE (#1129): the vault's key (which names the unit),
/// the core's wire enum, and how a day's figure folds. Today lists them in this
/// order.
///
/// A SUM (steps, active energy, exercise, sleep) is a day's total, and a sample
/// deleted on the phone lowers it, so a pass sends 0 for a day the store now
/// reports nothing for (R-1129-3). A LAST or AVERAGE (weight, resting heart
/// rate) is one reading; the store reporting none for a day says nothing about
/// the reading the vault holds, which is never cleared.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Metric {
    Steps,
    Sleep,
    Energy,
    Exercise,
    RestingHr,
    Weight,
}

impl Metric {
    /// In Today's order.
    pub const ALL: [Self; 6] = [
        Self::Steps,
        Self::Sleep,
        Self::Energy,
        Self::Exercise,
        Self::RestingHr,
        Self::Weight,
    ];

    /// The key a chosen set and a day total name it by.
    #[must_use]
    pub const fn key(self) -> &'static str {
        match self {
            Self::Steps => "steps",
            Self::Sleep => "sleep_min",
            Self::Energy => "active_energy_kcal",
            Self::Exercise => "exercise_min",
            Self::RestingHr => "resting_hr_bpm",
            Self::Weight => "weight_kg",
        }
    }

    #[must_use]
    pub fn of_key(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|metric| metric.key() == key)
    }

    /// A total of the day, not a reading.
    #[must_use]
    pub const fn sum(self) -> bool {
        matches!(
            self,
            Self::Steps | Self::Sleep | Self::Energy | Self::Exercise
        )
    }

    pub(crate) const fn wire(self) -> wire::HealthMetric {
        match self {
            Self::Steps => wire::HealthMetric::Steps,
            Self::Sleep => wire::HealthMetric::SleepMin,
            Self::Energy => wire::HealthMetric::ActiveEnergyKcal,
            Self::Exercise => wire::HealthMetric::ExerciseMin,
            Self::RestingHr => wire::HealthMetric::RestingHrBpm,
            Self::Weight => wire::HealthMetric::WeightKg,
        }
    }

    pub(crate) fn of_wire(value: i32) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|metric| metric.wire() as i32 == value)
    }

    /// The key a chosen set names workouts by; not a daily metric.
    pub const WORKOUTS: &'static str = "workouts";
}

/// The routes Health's own screens hand to a shell inside a view state.
pub mod routes {
    use super::{CONNECT, HOME, METRIC, WORKOUT, wire};

    fn route(screen: &str, args: wire::route::Args) -> wire::Route {
        wire::Route {
            screen: screen.to_owned(),
            args: Some(args),
        }
    }

    /// Health's home, landing on `destination`.
    #[must_use]
    pub fn home(destination: wire::HealthDestination) -> wire::Route {
        route(
            HOME,
            wire::route::Args::HealthHome(wire::HealthHomeRoute {
                destination: destination as i32,
            }),
        )
    }

    /// One metric's page; `parent` is the pushing page's title.
    #[must_use]
    pub fn metric(metric: &str, parent: &str) -> wire::Route {
        route(
            METRIC,
            wire::route::Args::HealthMetric(wire::HealthMetricRoute {
                metric: metric.to_owned(),
                range: wire::HealthMetricRange::Week as i32,
                parent: parent.to_owned(),
            }),
        )
    }

    /// One workout's page; `parent` is the pushing page's title.
    #[must_use]
    pub fn workout(activity_id: &str, parent: &str) -> wire::Route {
        route(
            WORKOUT,
            wire::route::Args::HealthWorkout(wire::HealthWorkoutRoute {
                activity_id: activity_id.to_owned(),
                parent: parent.to_owned(),
            }),
        )
    }

    /// What Health may read, and Connect.
    #[must_use]
    pub fn connect(parent: &str) -> wire::Route {
        route(
            CONNECT,
            wire::route::Args::HealthConnect(wire::HealthConnectRoute {
                parent: parent.to_owned(),
            }),
        )
    }
}
