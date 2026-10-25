package dev.centraid.shared

import centraid.core.v1.MoneyHomeTile
import centraid.core.v1.MoneyAmount
import centraid.screen.v1.TileBody
import centraid.screen.v1.TileStatus
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.shell.HomeMoneyTile
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe

/**
 * HOME'S MONEY TILE (#1099): this month's spending per currency, and day one. Money's own
 * screens are Rust's (`crates/screens/tests/money_*.rs`); the tile stays here until Home
 * moves into Rust (#1135).
 */
class HomeMoneyTileSpec : StringSpec({

    "Home's tile draws this month's spending per currency, and day one says what to do" {
        val tile = HomeMoneyTile.arrived(
            MoneyHomeTile(month = "2026-10", spent = listOf(amount(331_458), amount(12_000, "CAD"))),
        ).tile.shouldNotBeNull()
        tile.app_id shouldBe "money"
        tile.status shouldBe TileStatus.TILE_STATUS_CONTENT
        tile.count.shouldBeNull()
        val body = tile.body?.money.shouldNotBeNull()
        body.amounts.map { it.currency to it.minor } shouldBe listOf("USD" to 331_458L, "CAD" to 12_000L)
        body.caption shouldBe "spent in October"
        val empty = HomeMoneyTile.arrived(MoneyHomeTile(empty = true)).tile.shouldNotBeNull()
        empty.status shouldBe TileStatus.TILE_STATUS_EMPTY
        empty.body.shouldBeNull()
        HomeMoneyTile.request(CLOCK).home_tile?.tz shouldBe "Europe/Lisbon"
        TileBody(money = TileBody.Spent()).money.shouldNotBeNull()
    }
}) {
    companion object {
        val CLOCK = DeviceClock.Reading(zone = "Europe/Lisbon", epochMillis = 1_791_000_000_000L)

        fun amount(minor: Long, currency: String = "USD", exponent: Int = 2) =
            MoneyAmount(minor = minor, currency = currency, exponent = exponent)
    }
}
