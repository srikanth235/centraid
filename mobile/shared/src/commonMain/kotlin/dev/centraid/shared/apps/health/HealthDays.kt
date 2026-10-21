package dev.centraid.shared.apps.health

import dev.centraid.shared.kit.time.epochDayOf

/**
 * THE PURE HALF OF A DAYS PASS (#1129): the store's totals against the vault's, in; the changed
 * set, out. Days bypass `phone_link` (R-1129-3): the store gives a day no identity, so the window
 * re-read is what corrects a late watch upload, and a day is never deleted. The window itself is
 * the core's (`health.follow_view`, R-1129-4), placed in the device's zone.
 *
 * - **Only what changed is sent.** A value the vault holds bit for bit is not sent again, so a
 *   second pass over the same store sends nothing (R-1088-12); `health.record_days` compares the
 *   same way and writes nothing for it either.
 * - **The zero rule.** A SUM metric the store now reports nothing for, on a day the vault holds
 *   a non-zero value, is sent as 0: a deleted sample corrects the day. **Only for a metric the
 *   store answered at all in this read** (RP-K-3): HealthKit hides a revoked read, so a type the
 *   member turned off reads as nothing on every day, and zeroing a week for it would turn a
 *   permission into a deletion. A LAST or AVERAGE metric is never cleared.
 * - Only days inside the window, real calendar days, known metrics and finite, non-negative values
 *   are sent; a day the store states twice keeps its last statement, since `record_days` refuses a
 *   batch naming one (day, metric) twice (RP-R-5).
 */
public object HealthDays {
    /** The most values one `health.record_days` carries (the command's own ceiling is 4,000). */
    public const val BATCH: Int = 2_000

    public fun changes(
        read: List<HealthDayTotal>,
        held: List<HealthDayTotal>,
        from: String,
        today: String,
    ): List<HealthDayTotal> {
        fun inWindow(day: String) = epochDayOf(day) != null && day >= from && day <= today
        val stated = linkedMapOf<Pair<String, String>, Double>()
        for (total in read) {
            if (!inWindow(total.day) || HealthMetrics.ofKey(total.metric) == null) continue
            if (!total.value.isFinite() || total.value < 0.0) continue
            stated[total.day to total.metric] = total.value
        }
        val vault = held.associate { (it.day to it.metric) to it.value }
        val out = mutableListOf<HealthDayTotal>()
        for ((key, value) in stated) {
            val was = vault[key]
            if (was == null || was.toBits() != value.toBits()) out += HealthDayTotal(key.first, key.second, value)
        }
        val answered = stated.keys.map { it.second }.toSet()
        for ((key, was) in vault) {
            val metric = HealthMetrics.ofKey(key.second) ?: continue
            if (!metric.sum || metric.key !in answered || !inWindow(key.first)) continue
            if (key !in stated && was != 0.0) out += HealthDayTotal(key.first, key.second, 0.0)
        }
        return out.sortedWith(compareBy({ it.day }, { HealthMetrics.ofKey(it.metric)?.ordinal ?: Int.MAX_VALUE }))
    }
}
