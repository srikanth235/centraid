package dev.centraid.shared.shell

import centraid.core.v1.MoneyHomeTile
import centraid.core.v1.MoneyHomeTileRequest
import centraid.core.v1.MoneyRequest
import centraid.screen.v1.HomeEvent
import centraid.screen.v1.Money
import centraid.screen.v1.TileBody
import centraid.screen.v1.TileStatus
import dev.centraid.design.copy.MoneyCopy
import dev.centraid.shared.kit.time.CivilWords
import dev.centraid.shared.platform.DeviceClock

/**
 * HOME'S MONEY TILE (#1099): what this month's spending came to, one figure PER
 * CURRENCY and never a sum across them. It rides the core's own envelope arm
 * (`Request.money`, `money.home_tile`), because the figure is folded from the
 * month's lines at read time and no page read can say it.
 *
 * Nothing imported yet is `EMPTY`, not `UNKNOWN`: the read landed and the app
 * holds no lines, so the tile says what to do. The count is withheld (absent):
 * the tile's figure is money, and a number of lines beside it would be a second
 * thing to read.
 */
public object HomeMoneyTile {
    public const val APP_ID: String = "money"

    /**
     * THE TABLES WHOSE CHANGES MOVE THIS TILE, and `HomeReads.TABLES` carries them,
     * so `HomeMachine.rowsChanged` re-reads on them: the lines (an amount, a void),
     * the accounts (whether one counts toward spending) and the transfer links
     * (a transfer is not spending).
     */
    public val TABLES: Set<String> = setOf(
        "account", "budget", "checkpoint", "concept", "edge", "entity", "origin", "rule", "source", "txn",
    )

    /** The one request, in the device's zone. */
    public fun request(now: DeviceClock.Reading): MoneyRequest =
        MoneyRequest(home_tile = MoneyHomeTileRequest(tz = now.zone))

    /** The tile, out of one answer. */
    public fun arrived(answer: MoneyHomeTile): HomeEvent {
        if (answer.empty || answer.spent.isEmpty()) {
            return HomeEvent(
                tile = HomeEvent.TileArrived(app_id = APP_ID, status = TileStatus.TILE_STATUS_EMPTY),
            )
        }
        val month = answer.month.drop(MONTH_AT).toIntOrNull()?.let(CivilWords::monthName).orEmpty()
        return HomeEvent(
            tile = HomeEvent.TileArrived(
                app_id = APP_ID,
                status = TileStatus.TILE_STATUS_CONTENT,
                body = TileBody(
                    money = TileBody.Spent(
                        // THE CORE'S AMOUNTS, UNCHANGED, in the order it gave them.
                        amounts = answer.spent.map { Money(minor = it.minor, currency = it.currency, exponent = it.exponent) },
                        caption = if (month.isEmpty()) MoneyCopy.TILE_CAPTION_NO_MONTH else MoneyCopy.TILE_CAPTION.replace("{month}", month),
                    ),
                ),
            ),
        )
    }

    private const val MONTH_AT: Int = 5
}
