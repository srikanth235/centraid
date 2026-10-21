package dev.centraid.shared.apps.health

/**
 * THE STORE'S WORD FOR A WORKOUT'S KIND, AS THE VAULT'S KIND KEY (#1129): ONE table for both
 * stores. A HealthKit reader sends the `HKWorkoutActivityType` case's Swift name (`running`,
 * `traditionalStrengthTraining`); a Health Connect reader sends the `ExerciseSessionRecord`
 * constant's name (`EXERCISE_TYPE_RUNNING`). The vault seeds eight kinds under fixed ids
 * (`health:kind:run` …); a word this table does not name passes through as itself, and
 * `health.follow_workout` mints it into the scheme on first use. `phone_kind` keeps the store's
 * word whole either way, so a re-mapping later is a read-side change.
 */
public object HealthKinds {
    public const val RUN: String = "run"
    public const val WALK: String = "walk"
    public const val CYCLE: String = "cycle"
    public const val STRENGTH: String = "strength"
    public const val SWIM: String = "swim"
    public const val HIKE: String = "hike"
    public const val YOGA: String = "yoga"
    public const val OTHER: String = "other"

    /** The eight kinds the rung seeds, in the order a chip row would name them. */
    public val SEEDED: List<String> = listOf(RUN, WALK, CYCLE, STRENGTH, SWIM, HIKE, YOGA, OTHER)

    /** The store's word → the vault's key. */
    public val TABLE: Map<String, String> = mapOf(
        // HealthKit (`HKWorkoutActivityType`).
        "running" to RUN,
        "walking" to WALK,
        "cycling" to CYCLE,
        "handCycling" to CYCLE,
        "traditionalStrengthTraining" to STRENGTH,
        "functionalStrengthTraining" to STRENGTH,
        "swimming" to SWIM,
        "hiking" to HIKE,
        "yoga" to YOGA,
        "other" to OTHER,
        // Health Connect (`ExerciseSessionRecord.EXERCISE_TYPE_*`).
        "EXERCISE_TYPE_RUNNING" to RUN,
        "EXERCISE_TYPE_RUNNING_TREADMILL" to RUN,
        "EXERCISE_TYPE_WALKING" to WALK,
        "EXERCISE_TYPE_BIKING" to CYCLE,
        "EXERCISE_TYPE_BIKING_STATIONARY" to CYCLE,
        "EXERCISE_TYPE_STRENGTH_TRAINING" to STRENGTH,
        "EXERCISE_TYPE_WEIGHTLIFTING" to STRENGTH,
        "EXERCISE_TYPE_SWIMMING_POOL" to SWIM,
        "EXERCISE_TYPE_SWIMMING_OPEN_WATER" to SWIM,
        "EXERCISE_TYPE_HIKING" to HIKE,
        "EXERCISE_TYPE_YOGA" to YOGA,
        "EXERCISE_TYPE_OTHER_WORKOUT" to OTHER,
    )

    /** The vault's kind key for the store's [word]: the table's, else the word itself, trimmed. */
    public fun key(word: String): String = word.trim().let { TABLE[it] ?: it }
}
