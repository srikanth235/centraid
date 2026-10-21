package dev.centraid.shared

import dev.centraid.shared.apps.health.HealthDayTotal
import dev.centraid.shared.apps.health.HealthDays
import dev.centraid.shared.apps.health.HealthKinds
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe

/**
 * THE PURE HALF OF A HEALTH PASS (#1129): which day totals a pass sends (R-1129-3) and the store's
 * word for a kind as the vault's key. The window a pass reads (R-1129-4) is the core's, and
 * `crates/apps/health`'s `window_from` tests hold it.
 */
class HealthDaysSpec : StringSpec({
    val today = "2026-10-20"
    fun t(day: String, metric: String, value: Double) = HealthDayTotal(day, metric, value)

    "only what changed is sent: a value the vault holds bit for bit is not" {
        val held = listOf(t("2026-10-18", "steps", 8_412.0), t("2026-10-19", "steps", 6_100.0))
        val read = listOf(t("2026-10-18", "steps", 8_412.0), t("2026-10-19", "steps", 6_350.0), t("2026-10-20", "steps", 1_200.0))
        HealthDays.changes(read, held, "2026-10-13", today) shouldContainExactly listOf(
            t("2026-10-19", "steps", 6_350.0),
            t("2026-10-20", "steps", 1_200.0),
        )
    }

    "a second pass over the same store sends nothing" {
        val read = listOf(t("2026-10-19", "steps", 6_350.0), t("2026-10-19", "weight_kg", 71.4), t("2026-10-20", "sleep_min", 432.0))
        HealthDays.changes(read, read, "2026-10-13", today).shouldBeEmpty()
    }

    "a sum the store now reports nothing for, where the vault holds one, is sent as 0" {
        val held = listOf(t("2026-10-17", "steps", 900.0), t("2026-10-18", "steps", 8_000.0), t("2026-10-16", "steps", 0.0))
        val read = listOf(t("2026-10-18", "steps", 8_000.0))
        HealthDays.changes(read, held, "2026-10-13", today) shouldContainExactly listOf(t("2026-10-17", "steps", 0.0))
    }

    "a metric the store answered nothing for at all is never zeroed: a revoked type is not a deletion (RP-K-3)" {
        val held = listOf(t("2026-10-17", "steps", 900.0), t("2026-10-17", "sleep_min", 420.0))
        val read = listOf(t("2026-10-18", "sleep_min", 400.0))
        HealthDays.changes(read, held, "2026-10-13", today) shouldContainExactly listOf(
            t("2026-10-17", "sleep_min", 0.0),
            t("2026-10-18", "sleep_min", 400.0),
        )
    }

    "a last-value or average metric is never cleared" {
        val held = listOf(t("2026-10-17", "weight_kg", 71.4), t("2026-10-17", "resting_hr_bpm", 58.0))
        val read = listOf(t("2026-10-18", "weight_kg", 71.2), t("2026-10-18", "resting_hr_bpm", 57.0))
        HealthDays.changes(read, held, "2026-10-13", today) shouldContainExactly listOf(
            t("2026-10-18", "resting_hr_bpm", 57.0),
            t("2026-10-18", "weight_kg", 71.2),
        )
    }

    "nothing outside the window, no unknown metric, no negative or non-finite value, and a day stated twice keeps its last" {
        val read = listOf(
            t("2026-10-01", "steps", 10.0),
            t("2026-10-21", "steps", 10.0),
            t("2026-02-30", "steps", 10.0),
            t("2026-10-19", "heart_rate", 60.0),
            t("2026-10-19", "steps", -1.0),
            t("2026-10-19", "exercise_min", Double.NaN),
            t("2026-10-19", "active_energy_kcal", 300.0),
            t("2026-10-19", "active_energy_kcal", 310.0),
        )
        // A zero is only ever sent for a day inside the window, too.
        val held = listOf(t("2026-10-01", "active_energy_kcal", 200.0))
        HealthDays.changes(read, held, "2026-10-13", today) shouldContainExactly listOf(t("2026-10-19", "active_energy_kcal", 310.0))
    }

    "every word the table names maps to one of the eight kinds the rung seeds" {
        HealthKinds.TABLE.values.toSet().all { it in HealthKinds.SEEDED } shouldBe true
        HealthKinds.SEEDED.all { it in HealthKinds.TABLE.values } shouldBe true
        HealthKinds.key("running") shouldBe "run"
        HealthKinds.key("traditionalStrengthTraining") shouldBe "strength"
        HealthKinds.key("EXERCISE_TYPE_BIKING_STATIONARY") shouldBe "cycle"
        HealthKinds.key("EXERCISE_TYPE_SWIMMING_OPEN_WATER") shouldBe "swim"
        HealthKinds.key("hiking") shouldBe "hike"
        HealthKinds.key("yoga") shouldBe "yoga"
        HealthKinds.key("EXERCISE_TYPE_WALKING") shouldBe "walk"
        HealthKinds.key("other") shouldBe "other"
    }

    "a word the table does not name passes through as itself, trimmed, for the vault to mint" {
        HealthKinds.key("EXERCISE_TYPE_TENNIS") shouldBe "EXERCISE_TYPE_TENNIS"
        HealthKinds.key("  climbing ") shouldBe "climbing"
    }
})
