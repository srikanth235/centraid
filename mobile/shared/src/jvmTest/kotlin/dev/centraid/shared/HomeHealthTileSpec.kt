package dev.centraid.shared

import centraid.core.v1.HealthMetric
import centraid.core.v1.HealthToday
import centraid.core.v1.HealthTodayMetric
import dev.centraid.design.CentraidCatalog
import dev.centraid.shared.platform.FakeDeviceClock
import dev.centraid.shared.shell.HomeHealthTile
import dev.centraid.shared.shell.HomeTileWords
import dev.centraid.shared.shell.SpringboardPolicy
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import java.io.File

/**
 * HOME'S HEALTH TILE (#1129), the one piece of Health that stays on the Kotlin side until the
 * shell lane ports Home: today's steps and last night's sleep from `health.today`. Health's
 * screens themselves are Rust's (`crates/screens/tests/health_*.rs` hold what `HealthScreensSpec`
 * held).
 *
 * It also holds the one cross-language fact the screens' marks rest on: every icon Rust names
 * for a workout kind is in the design registry, which only the shells draw from.
 */
class HomeHealthTileSpec : StringSpec({
    val today = "2026-10-20"

    fun metric(m: HealthMetric, value: Double?) =
        HealthTodayMetric(metric = m, value_ = value, day = if (value == null) null else today, typical_days = 30)

    val connectedToday = HealthToday(
        today = today,
        connected = true,
        metrics = listOf(
            metric(HealthMetric.HEALTH_METRIC_STEPS, 8_412.0),
            metric(HealthMetric.HEALTH_METRIC_SLEEP_MIN, 432.0),
        ),
    )

    "Home's tile: today's steps and last night's sleep, connect when nothing is, and never a zero it was not told" {
        val tile = HomeHealthTile.arrived(connectedToday).tile.shouldNotBeNull()
        tile.status shouldBe centraid.screen.v1.TileStatus.TILE_STATUS_CONTENT
        tile.body!!.health.shouldNotBeNull().let {
            it.figure shouldBe "8,412"
            it.caption shouldBe "steps today"
            it.line shouldBe "Slept 7 h 12 m"
        }
        val spoken = HomeTileWords.spoken(
            centraid.screen.v1.HomeTile(app_id = "health", status = tile.status, body = tile.body),
        )
        spoken.second shouldBe "Open Health, 8,412 steps today, Slept 7 h 12 m"
        val quiet = HomeHealthTile.arrived(connectedToday.copy(metrics = emptyList())).tile!!.body!!.health!!
        quiet.figure shouldBe ""
        quiet.caption shouldBe "Nothing yet today"
        quiet.line shouldBe ""
        HomeHealthTile.arrived(HealthToday(today = today, connected = false)).tile!!.status shouldBe
            centraid.screen.v1.TileStatus.TILE_STATUS_EMPTY
        val clock = FakeDeviceClock(zone = "America/New_York")
        HomeHealthTile.request(clock).health_today!!.tz shouldBe "America/New_York"
        SpringboardPolicy.SPRINGBOARD_ORDER.indexOf("health") shouldBe SpringboardPolicy.SPRINGBOARD_ORDER.indexOf("money") + 1
        SpringboardPolicy.tileSize("health") shouldBe centraid.screen.v1.TileSize.TILE_SIZE_SMALL
    }

    "each workout kind's mark Rust names is in the icon registry" {
        val repositoryRoot = File(
            System.getProperty("centraid.repositoryRoot")
                ?: error("centraid.repositoryRoot is unset; see mobile/shared/build.gradle.kts"),
        )
        val figures = repositoryRoot.resolve("crates/screens/src/health/figures.rs")
        withClue("${figures.path} is where Rust names a workout kind's mark") { figures.isFile.shouldBeTrue() }
        val body = figures.readText().substringAfter("pub fn kind_icon").substringBefore("\n}\n")
        val fallback = Regex("""WORKOUT_ICON: &str = "(\w+)"""").find(figures.readText())!!.groupValues[1]
        val marks = Regex("""=> "(\w+)",""").findAll(body).map { it.groupValues[1] }.toSet() + fallback
        withClue("the marks found in kind_icon: $marks") { (marks.size >= 7).shouldBeTrue() }
        marks.forEach { withClue(it) { CentraidCatalog.icons.containsKey(it) shouldBe true } }
    }
})
