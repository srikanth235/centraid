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

    /// Worlds in a default run: 48 / 8 / 12, so val and test each hold a very large vault and an empty one.
    #[must_use]
    pub const fn first_run_count(self) -> usize {
        match self {
            Self::Train => 48,
            Self::Val => 8,
            Self::Test => 12,
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
    /// How many rows the world holds against a normal vault: `1.0` is normal, a large vault has several times as many
    /// (past the assistant's window of the newest 500 rows per kind), and `0.0` is a new member's empty vault.
    pub scale: f64,
}

impl Settings {
    pub const LOW: Self = Self {
        shared_names: 0.05,
        near_duplicates: 0.03,
        trashed: 0.03,
        history_days: 90,
        scale: 1.0,
    };
    pub const MEDIUM: Self = Self {
        shared_names: 0.2,
        near_duplicates: 0.1,
        trashed: 0.08,
        history_days: 180,
        scale: 1.0,
    };
    pub const HIGH: Self = Self {
        shared_names: 0.4,
        near_duplicates: 0.25,
        trashed: 0.15,
        history_days: 365,
        scale: 1.0,
    };
    /// A very large vault: a year of history and many times the rows, so kinds pass the assistant's window of the newest
    /// 500 rows and a whole-kind answer is refused or read from the store.
    pub const LARGE: Self = Self {
        shared_names: 0.2,
        near_duplicates: 0.1,
        trashed: 0.08,
        history_days: 365,
        scale: Self::LARGE_SCALE,
    };
    /// A new member: nothing in the vault yet.
    pub const EMPTY: Self = Self {
        shared_names: 0.0,
        near_duplicates: 0.0,
        trashed: 0.0,
        history_days: 30,
        scale: 0.0,
    };
    pub const LARGE_SCALE: f64 = 16.0;

    /// Which preset world `index` of a split sits on: the presets in turn, with a very large vault at 6 and an empty one
    /// at 7 of every eight, so every split of eight worlds or more holds one of each.
    #[must_use]
    pub fn preset(index: usize) -> Self {
        match index % 8 {
            6 => Self::LARGE,
            7 => Self::EMPTY,
            i => [Self::LOW, Self::MEDIUM, Self::HIGH, Self::MEDIUM][i % 4],
        }
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.scale <= 0.0
    }

    /// The settings of world `index` of a split: the presets in turn, each nudged by the seed so
    /// no two worlds sit on the same point.
    #[must_use]
    pub fn for_world(index: usize, rng: &mut Rng) -> Self {
        let base = Self::preset(index);
        let jitter =
            |value: f64, rng: &mut Rng| (value * (0.75 + 0.5 * rng.unit())).clamp(0.0, 0.9);
        Self {
            shared_names: jitter(base.shared_names, rng),
            near_duplicates: jitter(base.near_duplicates, rng),
            trashed: jitter(base.trashed, rng),
            history_days: (f64::from(base.history_days) * (0.8 + 0.4 * rng.unit())) as u32,
            scale: base.scale,
        }
    }
}
