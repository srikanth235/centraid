package dev.centraid.shared.apps.tally

import centraid.screen.v1.TallySplitMethod
import dev.centraid.design.copy.TallyCopy

/**
 * THE SIX DIVISIONS, IN MINOR UNITS (#1046). Pure, and the only arithmetic on
 * money a Tally machine does: turning what a member typed into the shares the
 * vault stores. The vault re-checks every one — the splits must sum to the
 * amount exactly (`write_splits`) — so this is the member seeing the problem
 * before the save rather than a second authority after it.
 *
 * Every figure is an integer of minor units: a typed "42.50" in a currency of
 * exponent 2 is 4250, never a float. A remainder that does not divide goes to
 * the PAYER (the handoff: "the odd penny goes to the payer, always"), or to the
 * first person sharing when the payer does not.
 */
internal object TallySplit {
    /** What the member typed beside one person. */
    data class Entry(val partyId: String, val included: Boolean, val text: String)

    /** One typed line of a "By line" expense. */
    data class Line(val key: String, val description: String, val amountText: String, val parties: List<String>)

    /** What a division came to. [shares] is empty exactly when [problem] is set. */
    data class Outcome(
        val shares: Map<String, Long>,
        val problem: String?,
        /** Per-entry issues, by party (or by line key for a line). */
        val issues: Map<String, String> = emptyMap(),
        /** What is left to divide (+) or over the total (−), when that is the problem. */
        val remaining: Long? = null,
        /** The typed lines, resolved, for the save. */
        val lines: List<ResolvedLine> = emptyList(),
    )

    data class ResolvedLine(val description: String, val amount: Long, val allocations: List<Pair<String, Long>>)

    fun methodKey(method: TallySplitMethod): String = when (method) {
        TallySplitMethod.TALLY_SPLIT_METHOD_EQUALLY -> "equally"
        TallySplitMethod.TALLY_SPLIT_METHOD_EXACT -> "exact"
        TallySplitMethod.TALLY_SPLIT_METHOD_PERCENTAGES -> "percentages"
        TallySplitMethod.TALLY_SPLIT_METHOD_SHARES -> "shares"
        TallySplitMethod.TALLY_SPLIT_METHOD_ADJUSTED -> "adjusted"
        TallySplitMethod.TALLY_SPLIT_METHOD_BY_LINE -> "by_line"
        else -> ""
    }

    fun methodOf(key: String): TallySplitMethod = when (key) {
        "equally", "equal" -> TallySplitMethod.TALLY_SPLIT_METHOD_EQUALLY
        "exact" -> TallySplitMethod.TALLY_SPLIT_METHOD_EXACT
        "percentages", "percent" -> TallySplitMethod.TALLY_SPLIT_METHOD_PERCENTAGES
        "shares" -> TallySplitMethod.TALLY_SPLIT_METHOD_SHARES
        "adjusted", "adjust" -> TallySplitMethod.TALLY_SPLIT_METHOD_ADJUSTED
        "by_line" -> TallySplitMethod.TALLY_SPLIT_METHOD_BY_LINE
        else -> TallySplitMethod.TALLY_SPLIT_METHOD_EXACT
    }

    fun methodLabel(key: String): String = methodLabel(methodOf(key))

    fun methodLabel(method: TallySplitMethod): String = when (method) {
        TallySplitMethod.TALLY_SPLIT_METHOD_EQUALLY -> TallyCopy.METHOD_EQUALLY
        TallySplitMethod.TALLY_SPLIT_METHOD_EXACT -> TallyCopy.METHOD_EXACT
        TallySplitMethod.TALLY_SPLIT_METHOD_PERCENTAGES -> TallyCopy.METHOD_PERCENTAGES
        TallySplitMethod.TALLY_SPLIT_METHOD_SHARES -> TallyCopy.METHOD_SHARES
        TallySplitMethod.TALLY_SPLIT_METHOD_ADJUSTED -> TallyCopy.METHOD_ADJUSTED
        TallySplitMethod.TALLY_SPLIT_METHOD_BY_LINE -> TallyCopy.METHOD_BY_LINE
        else -> ""
    }

    /** The rule the reconcile line states for a method when nothing is wrong. */
    fun rule(method: TallySplitMethod): String = when (method) {
        TallySplitMethod.TALLY_SPLIT_METHOD_EQUALLY -> TallyCopy.RULE_EQUALLY
        TallySplitMethod.TALLY_SPLIT_METHOD_EXACT -> TallyCopy.RULE_EXACT
        TallySplitMethod.TALLY_SPLIT_METHOD_PERCENTAGES -> TallyCopy.RULE_PERCENTAGES
        TallySplitMethod.TALLY_SPLIT_METHOD_SHARES -> TallyCopy.RULE_SHARES
        TallySplitMethod.TALLY_SPLIT_METHOD_ADJUSTED -> TallyCopy.RULE_ADJUSTED
        TallySplitMethod.TALLY_SPLIT_METHOD_BY_LINE -> TallyCopy.RULE_BY_LINE
        else -> ""
    }

    // -----------------------------------------------------------------
    // Typed numbers
    // -----------------------------------------------------------------

    /**
     * A typed amount in minor units at [exponent] digits, or null. "42", "42.5"
     * and "42.50" are 4250 at 2; "42.505" is refused rather than rounded, and
     * a separator is `.` or `,`. [signed] admits a leading `-` or `+` (an
     * adjustment).
     */
    fun parseAmount(text: String, exponent: Int, signed: Boolean = false): Long? =
        parseFixed(text, exponent, signed)

    /** A percentage or a weight in hundredths: "33.34" is 3334. */
    fun parseHundredths(text: String): Long? = parseFixed(text, 2, signed = false)

    private fun parseFixed(raw: String, digits: Int, signed: Boolean): Long? {
        var text = raw.trim()
        if (text.isEmpty()) return null
        var negative = false
        if (signed && (text[0] == '-' || text[0] == '+' || text[0] == '−')) {
            negative = text[0] != '+'
            text = text.substring(1).trim()
        }
        val separator = text.indexOfFirst { it == '.' || it == ',' }
        val whole = if (separator < 0) text else text.substring(0, separator)
        val fraction = if (separator < 0) "" else text.substring(separator + 1)
        if (whole.isEmpty() && fraction.isEmpty()) return null
        if (!whole.all { it.isDigit() } || !fraction.all { it.isDigit() }) return null
        if (fraction.length > digits) return null
        if (whole.length > MAX_DIGITS) return null
        var value = if (whole.isEmpty()) 0L else whole.toLong()
        repeat(digits) { value *= 10 }
        val padded = fraction.padEnd(digits, '0')
        value += if (padded.isEmpty()) 0L else padded.toLong()
        return if (negative) -value else value
    }

    /** Minor units as the text a member would type: 4250 at 2 is "42.50". */
    fun amountText(minor: Long, exponent: Int): String {
        if (exponent <= 0) return minor.toString()
        val sign = if (minor < 0) "-" else ""
        val digits = (if (minor < 0) -minor else minor).toString().padStart(exponent + 1, '0')
        return sign + digits.dropLast(exponent) + "." + digits.takeLast(exponent)
    }

    /** A fixed-point number with trailing zeros dropped: 1170000 at 6 is "1.17". */
    fun decimal(scaled: Long, scale: Int): String {
        val text = amountText(scaled, scale)
        return if ('.' in text) text.trimEnd('0').trimEnd('.') else text
    }

    /** Hundredths as a member reads them: 9950 is "99.5". */
    fun hundredths(value: Long): String = decimal(value, 2)

    /**
     * The vault's conversion, exactly (`convert_currency_minor`): half up, in
     * integers. Null where it would not fit.
     */
    fun convert(original: Long, rateScaled: Long, rateScale: Int): Long? {
        if (original <= 0 || rateScaled <= 0 || rateScale !in 0..MAX_SCALE) return null
        if (original > Long.MAX_VALUE / rateScaled) return null
        var divisor = 1L
        repeat(rateScale) { divisor *= 10 }
        val product = original * rateScaled
        if (product > Long.MAX_VALUE - divisor / 2) return null
        return ((product + divisor / 2) / divisor).takeIf { it > 0 }
    }

    // -----------------------------------------------------------------
    // The divisions
    // -----------------------------------------------------------------

    /** Divide [total] minor units by [method]. [exponent] reads typed amounts. */
    fun divide(
        method: TallySplitMethod,
        total: Long,
        exponent: Int,
        payer: String,
        entries: List<Entry>,
        lines: List<Line>,
    ): Outcome = when (method) {
        TallySplitMethod.TALLY_SPLIT_METHOD_EQUALLY -> equally(total, payer, entries.filter { it.included }.map { it.partyId })
        TallySplitMethod.TALLY_SPLIT_METHOD_EXACT -> exact(total, exponent, entries)
        TallySplitMethod.TALLY_SPLIT_METHOD_PERCENTAGES -> weighted(total, payer, entries, percent = true)
        TallySplitMethod.TALLY_SPLIT_METHOD_SHARES -> weighted(total, payer, entries, percent = false)
        TallySplitMethod.TALLY_SPLIT_METHOD_ADJUSTED -> adjusted(total, exponent, payer, entries)
        TallySplitMethod.TALLY_SPLIT_METHOD_BY_LINE -> byLine(total, exponent, payer, lines)
        else -> Outcome(emptyMap(), TallyCopy.METHOD_MISSING)
    }

    /** Equal parts; the remainder to the payer. */
    fun equally(total: Long, payer: String, parties: List<String>): Outcome {
        if (parties.isEmpty()) return Outcome(emptyMap(), TallyCopy.NOBODY_SHARES)
        val count = parties.size.toLong()
        val base = total / count
        val shares = LinkedHashMap<String, Long>()
        parties.forEach { shares[it] = base }
        remainderTo(shares, total - base * count, payer)
        return Outcome(shares, null)
    }

    /** The amounts as typed; a blank is nothing. They must add up exactly. */
    private fun exact(total: Long, exponent: Int, entries: List<Entry>): Outcome {
        val issues = LinkedHashMap<String, String>()
        val shares = LinkedHashMap<String, Long>()
        entries.forEach { entry ->
            if (entry.text.isBlank()) return@forEach
            val amount = parseAmount(entry.text, exponent)
            if (amount == null) issues[entry.partyId] = TallyCopy.NOT_AN_AMOUNT else if (amount > 0) shares[entry.partyId] = amount
        }
        if (issues.isNotEmpty()) return Outcome(emptyMap(), TallyCopy.FIX_ENTRIES, issues)
        if (shares.isEmpty()) return Outcome(emptyMap(), TallyCopy.NOBODY_SHARES)
        val sum = shares.values.sum()
        if (sum != total) {
            return Outcome(
                emptyMap(),
                if (sum < total) TallyCopy.LEFT_TO_DIVIDE else TallyCopy.OVER_THE_TOTAL,
                remaining = total - sum,
            )
        }
        return Outcome(shares, null)
    }

    /** Percentages that total 100, or weights; floors, the remainder to the payer. */
    private fun weighted(total: Long, payer: String, entries: List<Entry>, percent: Boolean): Outcome {
        val issues = LinkedHashMap<String, String>()
        val weights = LinkedHashMap<String, Long>()
        entries.forEach { entry ->
            if (entry.text.isBlank()) return@forEach
            val value = parseHundredths(entry.text)
            if (value == null) {
                issues[entry.partyId] = if (percent) TallyCopy.NOT_A_PERCENTAGE else TallyCopy.NOT_A_WEIGHT
            } else if (value > 0) {
                weights[entry.partyId] = value
            }
        }
        if (issues.isNotEmpty()) return Outcome(emptyMap(), TallyCopy.FIX_ENTRIES, issues)
        if (weights.isEmpty()) return Outcome(emptyMap(), TallyCopy.NOBODY_SHARES)
        val sum = weights.values.sum()
        if (percent && sum != HUNDRED_PERCENT) {
            return Outcome(emptyMap(), "${TallyCopy.PERCENT_TOTAL_PREFIX} ${hundredths(sum)}${TallyCopy.PERCENT_TOTAL_SUFFIX}")
        }
        val shares = LinkedHashMap<String, Long>()
        for ((party, weight) in weights) {
            if (weight != 0L && total > Long.MAX_VALUE / weight) return Outcome(emptyMap(), TallyCopy.TOO_LARGE)
            shares[party] = total * weight / sum
        }
        remainderTo(shares, total - shares.values.sum(), payer)
        return Outcome(shares, null)
    }

    /**
     * An equal base, then a per-person adjustment: everyone listed shares the
     * rest equally, and each adjustment moves their part up or down.
     */
    private fun adjusted(total: Long, exponent: Int, payer: String, entries: List<Entry>): Outcome {
        val parties = entries.filter { it.included }
        if (parties.isEmpty()) return Outcome(emptyMap(), TallyCopy.NOBODY_SHARES)
        val issues = LinkedHashMap<String, String>()
        val adjustments = LinkedHashMap<String, Long>()
        parties.forEach { entry ->
            val value = if (entry.text.isBlank()) 0L else parseAmount(entry.text, exponent, signed = true)
            if (value == null) issues[entry.partyId] = TallyCopy.NOT_AN_AMOUNT else adjustments[entry.partyId] = value
        }
        if (issues.isNotEmpty()) return Outcome(emptyMap(), TallyCopy.FIX_ENTRIES, issues)
        val rest = total - adjustments.values.sum()
        if (rest < 0) return Outcome(emptyMap(), TallyCopy.ADJUSTED_OVER, remaining = rest)
        val base = equally(rest, payer, adjustments.keys.toList()).shares
        val shares = LinkedHashMap<String, Long>()
        adjustments.forEach { (party, adjustment) -> shares[party] = (base[party] ?: 0L) + adjustment }
        val negative = shares.filterValues { it < 0 }.keys
        if (negative.isNotEmpty()) {
            return Outcome(emptyMap(), TallyCopy.ADJUSTED_NEGATIVE, negative.associateWith { TallyCopy.BELOW_ZERO })
        }
        return Outcome(shares, null)
    }

    /** Typed lines, each shared equally by its people; the lines must make the total. */
    private fun byLine(total: Long, exponent: Int, payer: String, lines: List<Line>): Outcome {
        if (lines.isEmpty()) return Outcome(emptyMap(), TallyCopy.NO_LINES)
        val issues = LinkedHashMap<String, String>()
        val resolved = mutableListOf<ResolvedLine>()
        val shares = LinkedHashMap<String, Long>()
        lines.forEach { line ->
            val amount = parseAmount(line.amountText, exponent)
            when {
                line.description.isBlank() -> issues[line.key] = TallyCopy.LINE_NEEDS_WORDS
                amount == null || amount <= 0 -> issues[line.key] = TallyCopy.NOT_AN_AMOUNT
                line.parties.isEmpty() -> issues[line.key] = TallyCopy.LINE_NEEDS_PEOPLE
                else -> {
                    val parts = equally(amount, payer, line.parties).shares
                    parts.forEach { (party, share) -> shares[party] = (shares[party] ?: 0L) + share }
                    resolved += ResolvedLine(line.description.trim(), amount, parts.toList())
                }
            }
        }
        if (issues.isNotEmpty()) return Outcome(emptyMap(), TallyCopy.FIX_LINES, issues)
        val sum = resolved.sumOf { it.amount }
        if (sum != total) {
            return Outcome(
                emptyMap(),
                if (sum < total) TallyCopy.LINES_SHORT else TallyCopy.LINES_OVER,
                remaining = total - sum,
            )
        }
        return Outcome(shares, null, lines = resolved)
    }

    /** The odd minor units go to the payer when they share, else the first who does. */
    private fun remainderTo(shares: LinkedHashMap<String, Long>, remainder: Long, payer: String) {
        if (remainder == 0L || shares.isEmpty()) return
        val to = if (payer in shares) payer else shares.keys.first()
        shares[to] = (shares[to] ?: 0L) + remainder
    }

    private const val HUNDRED_PERCENT: Long = 10_000
    private const val MAX_DIGITS: Int = 13
    private const val MAX_SCALE: Int = 12
}
