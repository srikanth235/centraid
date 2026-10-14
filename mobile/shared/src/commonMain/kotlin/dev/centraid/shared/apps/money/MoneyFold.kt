package dev.centraid.shared.apps.money

import centraid.core.v1.MoneyActivityRow
import centraid.core.v1.MoneyAmount
import centraid.core.v1.MoneyCadence
import centraid.core.v1.MoneyFlag
import centraid.core.v1.MoneyMatchKind
import centraid.screen.v1.Money
import centraid.screen.v1.MoneyChoice
import centraid.screen.v1.MoneyDaySection
import centraid.screen.v1.MoneyFigure
import centraid.screen.v1.MoneyRow
import centraid.screen.v1.StatusChip
import dev.centraid.design.copy.MoneyCopy
import dev.centraid.shared.kit.jsonString
import dev.centraid.shared.kit.time.CivilWords
import dev.centraid.shared.kit.time.civilDayOf
import dev.centraid.shared.kit.time.epochDayOf

/**
 * THE FOLDS EVERY MONEY SCREEN SHARES: pure, and never arithmetic the core did
 * not do. A core amount becomes a `Money` unchanged, a sign becomes a tone, and
 * there is no `+` on money in this file; the only sums are counts and basis
 * points for a bar's length, which are drawing, not figures.
 */
internal object MoneyFold {
    /** A core amount as the screen's, UNCHANGED: minor units, code, exponent. */
    fun money(amount: MoneyAmount?): Money = Money(
        minor = amount?.minor ?: 0L,
        currency = amount?.currency ?: "",
        exponent = amount?.exponent ?: 0,
    )

    /** The same amount without its sign, for a figure whose tone carries it. */
    fun magnitude(amount: Money): Money = if (amount.minor < 0) amount.copy(minor = -amount.minor) else amount

    fun figure(label: String, amount: MoneyAmount?, tone: StatusChip.Tone = StatusChip.Tone.TONE_NEUTRAL): MoneyFigure =
        MoneyFigure(label = label, amount = money(amount), tone = tone)

    /** NET is money out or over plan; NEUTRAL is ink. */
    fun signTone(amount: MoneyAmount?): StatusChip.Tone =
        if ((amount?.minor ?: 0L) < 0) StatusChip.Tone.TONE_NET else StatusChip.Tone.TONE_NEUTRAL

    fun choice(key: String, label: String, selected: Boolean, detail: String = ""): MoneyChoice =
        MoneyChoice(key = key, label = label, selected = selected, detail = detail)

    /** "1 row" / "3 rows": a count with its noun. */
    fun count(n: Int, one: String, many: String): String = "$n ${if (n == 1) one else many}"

    /** A copy template with `{name}` slots filled. */
    fun fill(template: String, vararg slots: Pair<String, String>): String =
        slots.fold(template) { text, (name, value) -> text.replace("{$name}", value) }

    // --- Months -----------------------------------------------------------

    /** `2026-10` of a `YYYY-MM-DD` day. */
    fun monthOf(day: String): String = day.take(MONTH_LENGTH)

    /** `October 2026`; the input unchanged when it is not a month. */
    fun monthLabel(month: String): String {
        val number = month.drop(MONTH_NUMBER_AT).toIntOrNull() ?: return month
        val name = CivilWords.monthName(number)
        return if (name.isEmpty()) month else "$name ${month.take(YEAR_LENGTH)}"
    }

    /** `Oct`. */
    fun monthShort(month: String): String {
        val number = month.drop(MONTH_NUMBER_AT).toIntOrNull() ?: return month
        return CivilWords.monthName(number).take(SHORT_LENGTH)
    }

    /** [month] moved by [months] (negative goes back); [month] itself when it is not a month. */
    fun shiftMonth(month: String, months: Int): String {
        val year = month.take(YEAR_LENGTH).toIntOrNull() ?: return month
        val number = month.drop(MONTH_NUMBER_AT).toIntOrNull() ?: return month
        val index = year * MONTHS + (number - 1) + months
        val shiftedYear = index.floorDiv(MONTHS)
        val shiftedMonth = index.mod(MONTHS) + 1
        return "${shiftedYear.toString().padStart(YEAR_LENGTH, '0')}-${shiftedMonth.toString().padStart(2, '0')}"
    }

    /** Months from [from] to [to], both `YYYY-MM`; 0 when either is not a month. */
    fun monthsBetween(from: String, to: String): Int {
        val a = from.take(YEAR_LENGTH).toIntOrNull()
        val b = to.take(YEAR_LENGTH).toIntOrNull()
        val c = from.drop(MONTH_NUMBER_AT).toIntOrNull()
        val d = to.drop(MONTH_NUMBER_AT).toIntOrNull()
        if (a == null || b == null || c == null || d == null) return 0
        return (b - a) * MONTHS + (d - c)
    }

    /** The month sheet's choices: [through] and the eleven before it, newest first. */
    fun monthOptions(through: String, selected: String): List<MoneyChoice> =
        (0 until MONTHS).map { back ->
            val month = shiftMonth(through, -back)
            choice(month, monthLabel(month), month == selected)
        }

    // --- Days -------------------------------------------------------------

    /** `Today` / `Yesterday` / `Mon 12 October`. */
    fun dayHeading(day: String, today: String): String =
        if (today.isEmpty()) CivilWords.dayMonth(day) else CivilWords.relativeDay(day, today)

    /** `today`, `yesterday` or `Oct 14`: a day inside a sentence. */
    fun dayWords(day: String, today: String): String = when (day) {
        today -> MoneyCopy.WORD_TODAY
        civilDayOf((epochDayOf(today) ?: 0L) - 1) -> MoneyCopy.WORD_YESTERDAY
        else -> dayShort(day)
    }

    /** `Oct 14` style short date for a meta line. */
    fun dayShort(day: String): String {
        val month = day.drop(MONTH_NUMBER_AT).take(2).toIntOrNull() ?: return day
        val dom = day.drop(DAY_AT).toIntOrNull() ?: return day
        return "${CivilWords.monthName(month).take(SHORT_LENGTH)} $dom"
    }

    /** `Sep 15 to Oct 14`. */
    fun span(first: String?, last: String?): String =
        if (first.isNullOrEmpty() || last.isNullOrEmpty()) "" else "${dayShort(first)} ${MoneyCopy.TO_WORD} ${dayShort(last)}"

    // --- Typed amounts -----------------------------------------------------

    /**
     * A typed amount in minor units, or null: digits with at most [exponent]
     * decimals, a `.` or `,` as the point, no sign. Never a float.
     */
    fun parseAmount(text: String, exponent: Int): Long? {
        val cleaned = text.trim().replace(" ", "").replace("\u00A0", "")
        if (cleaned.isEmpty()) return null
        val point = cleaned.indexOfLast { it == '.' || it == ',' }
        val whole: String
        val fraction: String
        if (point >= 0 && cleaned.length - point - 1 <= exponent && exponent > 0) {
            whole = cleaned.take(point).replace(".", "").replace(",", "")
            fraction = cleaned.drop(point + 1)
        } else if (point >= 0 && exponent == 0) {
            whole = cleaned.replace(".", "").replace(",", "")
            fraction = ""
        } else if (point >= 0) {
            return null
        } else {
            whole = cleaned
            fraction = ""
        }
        if (whole.isEmpty() && fraction.isEmpty()) return null
        if (!whole.all { it in '0'..'9' } || !fraction.all { it in '0'..'9' }) return null
        val padded = fraction.padEnd(exponent, '0')
        val digits = (whole.ifEmpty { "0" } + padded).trimStart('0').ifEmpty { "0" }
        return digits.toLongOrNull()
    }

    /** A minor amount as a typed text: `231.40`, `4250` for a currency with no decimals. */
    fun amountText(minor: Long, exponent: Int): String {
        if (exponent <= 0) return minor.toString()
        val negative = minor < 0
        val digits = (if (negative) -minor else minor).toString().padStart(exponent + 1, '0')
        val text = digits.dropLast(exponent) + "." + digits.takeLast(exponent)
        return if (negative) "-$text" else text
    }

    // --- Rows --------------------------------------------------------------

    /** Flags as chips, in the order a member reads them. */
    fun chips(flags: List<MoneyFlag>, hasCategory: Boolean): List<StatusChip> = buildList {
        for (flag in flags) {
            when (flag) {
                MoneyFlag.MONEY_FLAG_TRANSFER -> add(StatusChip(label = MoneyCopy.CHIP_TRANSFER, tone = StatusChip.Tone.TONE_SEAM))
                MoneyFlag.MONEY_FLAG_VOID -> add(StatusChip(label = MoneyCopy.CHIP_VOID, tone = StatusChip.Tone.TONE_SEAM))
                MoneyFlag.MONEY_FLAG_UNCATEGORISED -> if (!hasCategory) {
                    add(StatusChip(label = MoneyCopy.CHIP_NO_CATEGORY, tone = StatusChip.Tone.TONE_SEAM))
                }
                MoneyFlag.MONEY_FLAG_FUTURE -> add(StatusChip(label = MoneyCopy.CHIP_FUTURE, tone = StatusChip.Tone.TONE_NEUTRAL))
                else -> Unit
            }
        }
    }

    /** One Activity row as a list draws it. */
    fun row(source: MoneyActivityRow, today: String, withAccount: Boolean = true, withDay: Boolean = false): MoneyRow {
        val flags = source.flags
        val struck = MoneyFlag.MONEY_FLAG_TRANSFER in flags || MoneyFlag.MONEY_FLAG_VOID in flags
        val meta = listOf(
            if (withDay) dayShort(source.posted_on) else "",
            if (withAccount) source.account_label else "",
            if (source.display_name != source.raw && source.raw.isNotEmpty()) source.raw else "",
            if (struck && MoneyFlag.MONEY_FLAG_TRANSFER in flags) MoneyCopy.NOT_SPENDING else "",
        ).filter { it.isNotEmpty() }.joinToString(" · ")
        val category = source.category_label.orEmpty()
        val amount = money(source.amount)
        val title = source.display_name.ifEmpty { source.raw }
        return MoneyRow(
            txn_id = source.txn_id,
            title = title,
            meta = meta,
            amount = amount,
            amount_tone = if (struck) StatusChip.Tone.TONE_SEAM else signTone(source.amount),
            category_label = category,
            chips = chips(flags, source.category_id != null),
            accessibility_label = listOf(title, dayHeading(source.posted_on, today), category, meta)
                .filter { it.isNotEmpty() }.joinToString(", "),
            dimmed = struck,
        )
    }

    /** Rows grouped under their day, in the order given (newest first). */
    fun sections(rows: List<MoneyActivityRow>, today: String): List<MoneyDaySection> {
        val out = ArrayList<MoneyDaySection>()
        for (source in rows) {
            val last = out.lastOrNull()
            val row = row(source, today)
            if (last != null && last.day == source.posted_on) {
                out[out.lastIndex] = last.copy(rows = last.rows + row)
            } else {
                out += MoneyDaySection(day = source.posted_on, heading = dayHeading(source.posted_on, today), rows = listOf(row))
            }
        }
        return out
    }

    fun cadenceWords(cadence: MoneyCadence): String = when (cadence) {
        MoneyCadence.MONEY_CADENCE_WEEKLY -> MoneyCopy.CADENCE_WEEKLY
        MoneyCadence.MONEY_CADENCE_BIWEEKLY -> MoneyCopy.CADENCE_BIWEEKLY
        MoneyCadence.MONEY_CADENCE_MONTHLY -> MoneyCopy.CADENCE_MONTHLY
        MoneyCadence.MONEY_CADENCE_QUARTERLY -> MoneyCopy.CADENCE_QUARTERLY
        MoneyCadence.MONEY_CADENCE_YEARLY -> MoneyCopy.CADENCE_YEARLY
        else -> ""
    }

    fun matchKindWord(kind: MoneyMatchKind): String = when (kind) {
        MoneyMatchKind.MONEY_MATCH_KIND_IS -> MoneyCopy.KIND_IS
        MoneyMatchKind.MONEY_MATCH_KIND_MATCHES -> MoneyCopy.KIND_MATCHES
        else -> MoneyCopy.KIND_CONTAINS
    }

    fun matchKindKey(kind: MoneyMatchKind): String = when (kind) {
        MoneyMatchKind.MONEY_MATCH_KIND_IS -> "is"
        MoneyMatchKind.MONEY_MATCH_KIND_MATCHES -> "matches"
        else -> "contains"
    }

    /** The copy for a definition key the core names (`money.def.*`). */
    fun definition(key: String): Pair<String, String>? = when (key) {
        "money.def.spending" -> MoneyCopy.DEF_SPENDING_LABEL to MoneyCopy.DEF_SPENDING_DETAIL
        "money.def.refund_credit" -> MoneyCopy.DEF_REFUND_LABEL to MoneyCopy.DEF_REFUND_DETAIL
        "money.def.in_out_net" -> MoneyCopy.DEF_IN_OUT_LABEL to MoneyCopy.DEF_IN_OUT_DETAIL
        "money.def.savings_rate" -> MoneyCopy.DEF_SAVINGS_LABEL to MoneyCopy.DEF_SAVINGS_DETAIL
        "money.def.balance" -> MoneyCopy.DEF_BALANCE_LABEL to MoneyCopy.DEF_BALANCE_DETAIL
        "money.def.checkpoint" -> MoneyCopy.DEF_CHECKPOINT_LABEL to MoneyCopy.DEF_CHECKPOINT_DETAIL
        "money.def.planned" -> MoneyCopy.DEF_PLANNED_LABEL to MoneyCopy.DEF_PLANNED_DETAIL
        "money.def.forecast" -> MoneyCopy.DEF_FORECAST_LABEL to MoneyCopy.DEF_FORECAST_DETAIL
        "money.def.recurring" -> MoneyCopy.DEF_RECURRING_LABEL to MoneyCopy.DEF_RECURRING_DETAIL
        "money.def.transfer" -> MoneyCopy.DEF_TRANSFER_LABEL to MoneyCopy.DEF_TRANSFER_DETAIL
        else -> null
    }

    /** A civil day [days] after [day], else [day]. */
    fun plusDays(day: String, days: Int): String =
        epochDayOf(day)?.let { civilDayOf(it + days) } ?: day

    // --- Command inputs ------------------------------------------------------

    /** A JSON object out of already-encoded fragments; null values are omitted. */
    fun json(vararg fields: Pair<String, String?>): String =
        fields.filter { it.second != null }
            .joinToString(prefix = "{", postfix = "}", separator = ",") { (name, value) -> "${jsonString(name)}:$value" }

    fun str(value: String): String = jsonString(value)

    /** `null` for the JSON null, else the string. */
    fun strOrNull(value: String?): String = if (value == null) "null" else jsonString(value)

    private const val MONTHS: Int = 12
    private const val YEAR_LENGTH: Int = 4
    private const val MONTH_LENGTH: Int = 7
    private const val MONTH_NUMBER_AT: Int = 5
    private const val DAY_AT: Int = 8
    private const val SHORT_LENGTH: Int = 3
}
