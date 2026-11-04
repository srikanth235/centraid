//! The knobs of a world: how much ambiguity it carries and how far back its history reaches.

use serde::{Deserialize, Serialize};

use crate::rng::Rng;

/// Which side of the train/val/test line a world's seed falls on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Split {
    Train,
    Val,
    Test,
}

impl Split {
    pub const ALL: [Self; 3] = [Self::Train, Self::Val, Self::Test];

    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Train => "train",
            Self::Val => "val",
            Self::Test => "test",
        }
    }

    /// Worlds in the first run (#1166: ~60 worlds, 48 / 6 / 6).
    #[must_use]
    pub const fn first_run_count(self) -> usize {
        match self {
            Self::Train => 48,
            Self::Val | Self::Test => 6,
        }
    }
}

/// Every share is a probability in `[0, 1]` applied per row.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Settings {
    /// Chance a new person takes the first name of someone already in the world (`Neha Rao`
    /// and `Neha Kulkarni`); for other kinds, the chance a title repeats an existing one.
    pub shared_names: f64,
    /// Chance a row gets a near twin: the same name one typo, one word or one initial away.
    pub near_duplicates: f64,
    /// Chance a row that can be trashed is trashed.
    pub trashed: f64,
    /// Days of history before today. Reads the runtime windows (three months of transactions,
    /// ninety days of health) cap what those two kinds hold.
    pub history_days: u32,
}

impl Settings {
    pub const LOW: Self = Self {
        shared_names: 0.05,
        near_duplicates: 0.03,
        trashed: 0.03,
        history_days: 90,
    };
    pub const MEDIUM: Self = Self {
        shared_names: 0.2,
        near_duplicates: 0.1,
        trashed: 0.08,
        history_days: 180,
    };
    pub const HIGH: Self = Self {
        shared_names: 0.4,
        near_duplicates: 0.25,
        trashed: 0.15,
        history_days: 365,
    };

    /// The settings of world `index` of a split: the presets in turn, each nudged by the seed so
    /// no two worlds sit on the same point.
    #[must_use]
    pub fn for_world(index: usize, rng: &mut Rng) -> Self {
        let base = [Self::LOW, Self::MEDIUM, Self::HIGH, Self::MEDIUM][index % 4];
        let jitter =
            |value: f64, rng: &mut Rng| (value * (0.75 + 0.5 * rng.unit())).clamp(0.0, 0.9);
        Self {
            shared_names: jitter(base.shared_names, rng),
            near_duplicates: jitter(base.near_duplicates, rng),
            trashed: jitter(base.trashed, rng),
            history_days: (f64::from(base.history_days) * (0.8 + 0.4 * rng.unit())) as u32,
        }
    }
}
