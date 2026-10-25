//! THE STORE'S WORD FOR A WORKOUT'S KIND, AS THE VAULT'S KIND KEY (#1129): ONE
//! table for both stores. A HealthKit reader sends the `HKWorkoutActivityType`
//! case's Swift name (`running`, `traditionalStrengthTraining`); a Health Connect
//! reader sends the `ExerciseSessionRecord` constant's name
//! (`EXERCISE_TYPE_RUNNING`). The vault seeds eight kinds under fixed ids
//! (`health:kind:run` …); a word this table does not name passes through as
//! itself, and `follow.health` mints it into the scheme on first use.
//!
//! The shells' readers send the store's word whole and decide nothing:
//! `HealthKitReadOnlySpec` and `HealthConnectReadOnlySpec` hold the words they
//! name to the keys of [`TABLE`] by reading this file.

pub const RUN: &str = "run";
pub const WALK: &str = "walk";
pub const CYCLE: &str = "cycle";
pub const STRENGTH: &str = "strength";
pub const SWIM: &str = "swim";
pub const HIKE: &str = "hike";
pub const YOGA: &str = "yoga";
pub const OTHER: &str = "other";

/// The eight kinds the vault seeds, in the order a chip row would name them.
pub const SEEDED: [&str; 8] = [RUN, WALK, CYCLE, STRENGTH, SWIM, HIKE, YOGA, OTHER];

/// The store's word → the vault's key.
pub const TABLE: [(&str, &str); 22] = [
    // HealthKit (`HKWorkoutActivityType`).
    ("running", RUN),
    ("walking", WALK),
    ("cycling", CYCLE),
    ("handCycling", CYCLE),
    ("traditionalStrengthTraining", STRENGTH),
    ("functionalStrengthTraining", STRENGTH),
    ("swimming", SWIM),
    ("hiking", HIKE),
    ("yoga", YOGA),
    ("other", OTHER),
    // Health Connect (`ExerciseSessionRecord.EXERCISE_TYPE_*`).
    ("EXERCISE_TYPE_RUNNING", RUN),
    ("EXERCISE_TYPE_RUNNING_TREADMILL", RUN),
    ("EXERCISE_TYPE_WALKING", WALK),
    ("EXERCISE_TYPE_BIKING", CYCLE),
    ("EXERCISE_TYPE_BIKING_STATIONARY", CYCLE),
    ("EXERCISE_TYPE_STRENGTH_TRAINING", STRENGTH),
    ("EXERCISE_TYPE_WEIGHTLIFTING", STRENGTH),
    ("EXERCISE_TYPE_SWIMMING_POOL", SWIM),
    ("EXERCISE_TYPE_SWIMMING_OPEN_WATER", SWIM),
    ("EXERCISE_TYPE_HIKING", HIKE),
    ("EXERCISE_TYPE_YOGA", YOGA),
    ("EXERCISE_TYPE_OTHER_WORKOUT", OTHER),
];

/// The vault's kind key for the store's `word`: the table's, else the word
/// itself, trimmed.
#[must_use]
pub fn key(word: &str) -> String {
    let word = word.trim();
    TABLE
        .iter()
        .find(|(store, _)| *store == word)
        .map_or_else(|| word.to_owned(), |(_, kind)| (*kind).to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_word_the_table_names_maps_to_one_of_the_eight_kinds_the_vault_seeds() {
        assert!(TABLE.iter().all(|(_, kind)| SEEDED.contains(kind)));
        assert!(
            SEEDED
                .iter()
                .all(|kind| TABLE.iter().any(|(_, k)| k == kind))
        );
        assert_eq!(key("running"), "run");
        assert_eq!(key("traditionalStrengthTraining"), "strength");
        assert_eq!(key("EXERCISE_TYPE_BIKING_STATIONARY"), "cycle");
        assert_eq!(key("EXERCISE_TYPE_SWIMMING_OPEN_WATER"), "swim");
        assert_eq!(key("hiking"), "hike");
        assert_eq!(key("yoga"), "yoga");
        assert_eq!(key("EXERCISE_TYPE_WALKING"), "walk");
        assert_eq!(key("other"), "other");
    }

    #[test]
    fn a_word_the_table_does_not_name_passes_through_as_itself_trimmed() {
        assert_eq!(key("EXERCISE_TYPE_TENNIS"), "EXERCISE_TYPE_TENNIS");
        assert_eq!(key("  climbing "), "climbing");
    }
}
