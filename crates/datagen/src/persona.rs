//! Who a world is about. The persona shapes volume and habits (a parent has more events, an
//! athlete more workouts); it never shapes the schema.

use serde::{Deserialize, Serialize};

use crate::pools;
use crate::rng::Rng;
use crate::settings::Split;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Archetype {
    Student,
    Parent,
    Freelancer,
    Professional,
    Retiree,
    Athlete,
}

/// Multipliers on the base volume of each app and on money and health habits.
#[derive(Debug, Clone, Copy)]
pub struct Profile {
    pub social: f64,
    pub busy: f64,
    pub paper: f64,
    pub money: f64,
    pub workouts_per_week: f64,
    pub steps: f64,
    pub rent: f64,
    pub income: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Persona {
    pub me: String,
    pub archetype: Archetype,
    /// The vault's default currency.
    pub currency: String,
}

impl Archetype {
    pub const ALL: [Self; 6] = [
        Self::Student,
        Self::Parent,
        Self::Freelancer,
        Self::Professional,
        Self::Retiree,
        Self::Athlete,
    ];

    #[must_use]
    pub const fn profile(self) -> Profile {
        match self {
            Self::Student => Profile {
                social: 1.3,
                busy: 1.0,
                paper: 0.7,
                money: 0.7,
                workouts_per_week: 1.5,
                steps: 1.0,
                rent: 0.6,
                income: 0.5,
            },
            Self::Parent => Profile {
                social: 1.1,
                busy: 1.4,
                paper: 1.3,
                money: 1.3,
                workouts_per_week: 1.0,
                steps: 0.9,
                rent: 1.1,
                income: 1.3,
            },
            Self::Freelancer => Profile {
                social: 0.9,
                busy: 1.2,
                paper: 1.2,
                money: 1.1,
                workouts_per_week: 2.0,
                steps: 1.0,
                rent: 0.9,
                income: 1.0,
            },
            Self::Professional => Profile {
                social: 1.0,
                busy: 1.1,
                paper: 1.0,
                money: 1.0,
                workouts_per_week: 2.0,
                steps: 1.0,
                rent: 1.0,
                income: 1.4,
            },
            Self::Retiree => Profile {
                social: 0.8,
                busy: 0.7,
                paper: 1.2,
                money: 0.8,
                workouts_per_week: 1.5,
                steps: 0.8,
                rent: 0.8,
                income: 0.8,
            },
            Self::Athlete => Profile {
                social: 0.9,
                busy: 0.9,
                paper: 0.7,
                money: 0.9,
                workouts_per_week: 5.0,
                steps: 1.4,
                rent: 0.9,
                income: 0.8,
            },
        }
    }
}

impl Persona {
    /// A persona drawn for world `index` of `split`. The owner's first name comes from a pool no
    /// other split uses, so a held-out world is a held-out person.
    #[must_use]
    pub fn draw(split: Split, rng: &mut Rng) -> Self {
        let first = match split {
            Split::Train => pools::ME_TRAIN,
            Split::Val => pools::ME_VAL,
            Split::Test => pools::ME_TEST,
        };
        let me = format!("{} {}", rng.pick(first), rng.pick(pools::LAST));
        let currency = rng
            .weighted(&[("USD", 6), ("EUR", 2), ("GBP", 1), ("CAD", 1), ("INR", 3)])
            .to_string();
        Self {
            me,
            archetype: *rng.pick(&Archetype::ALL),
            currency,
        }
    }
}
