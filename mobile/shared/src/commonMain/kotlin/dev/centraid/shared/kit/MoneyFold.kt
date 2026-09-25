package dev.centraid.shared.kit

import centraid.screen.v1.Money

/**
 * THE PURE HALF OF MONEY. Rendering stays native — `commonMain` is platform-free
 * and has no CLDR — so `Money.render` (Swift) and `formatMoney` (Compose) draw,
 * and `contracts/screens/money-render.json` holds the two to one answer. What
 * is arithmetic lives here, once.
 */
public object MoneyFold {
    /**
     * One total PER CURRENCY, in first-seen order. Never a sum across
     * currencies: 100 USD and 500 JPY are not 600 of anything (the v0 tile
     * defect). The exponent and locale are the first amount's of each currency.
     */
    public fun sumByCurrency(amounts: List<Money>): List<Money> {
        val totals = LinkedHashMap<String, Money>()
        for (amount in amounts) {
            val seen = totals[amount.currency]
            totals[amount.currency] = seen?.copy(minor = seen.minor + amount.minor) ?: amount
        }
        return totals.values.toList()
    }

    /** -1, 0 or 1. */
    public fun sign(money: Money): Int = money.minor.compareTo(0L).coerceIn(-1, 1)

    public fun isZero(money: Money): Boolean = money.minor == 0L
}
