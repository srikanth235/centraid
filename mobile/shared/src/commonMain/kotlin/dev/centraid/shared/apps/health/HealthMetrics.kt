package dev.centraid.shared.apps.health

import centraid.core.v1.HealthMetric

/**
 * THE SIX DAILY METRICS, ONCE (#1129): the vault's key (`health_daily.metric`, which names the
 * unit), the read contract's enum, and how a day's figure folds. Today lists them in this order.
 *
 * A SUM (steps, active energy, exercise, sleep) is a day's total, and a sample deleted on the
 * phone lowers it, so a pass sends 0 for a day the store now reports nothing for (R-1129-3). A
 * LAST or AVERAGE (weight, resting heart rate) is one reading; the store reporting none for a day
 * says nothing about the reading the vault holds, which is never cleared.
 */
public enum class HealthMetrics(public val key: String, public val wire: HealthMetric, public val sum: Boolean) {
    STEPS("steps", HealthMetric.HEALTH_METRIC_STEPS, sum = true),
    SLEEP("sleep_min", HealthMetric.HEALTH_METRIC_SLEEP_MIN, sum = true),
    ENERGY("active_energy_kcal", HealthMetric.HEALTH_METRIC_ACTIVE_ENERGY_KCAL, sum = true),
    EXERCISE("exercise_min", HealthMetric.HEALTH_METRIC_EXERCISE_MIN, sum = true),
    RESTING_HR("resting_hr_bpm", HealthMetric.HEALTH_METRIC_RESTING_HR_BPM, sum = false),
    WEIGHT("weight_kg", HealthMetric.HEALTH_METRIC_WEIGHT_KG, sum = false),
    ;

    public companion object {
        /** The key a chosen set names workouts by (`HealthDevice.chosen`); not a daily metric. */
        public const val WORKOUTS: String = "workouts"

        public fun ofKey(key: String): HealthMetrics? = entries.firstOrNull { it.key == key }

        public fun ofWire(wire: HealthMetric): HealthMetrics? = entries.firstOrNull { it.wire == wire }
    }
}
