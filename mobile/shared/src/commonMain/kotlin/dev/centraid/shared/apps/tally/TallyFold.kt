package dev.centraid.shared.apps.tally

import centraid.core.v1.TallyActivityExpense
import centraid.core.v1.TallyExpenseRow
import centraid.core.v1.TallyMoney
import centraid.core.v1.TallyPerson
import centraid.core.v1.TallyRole
import centraid.core.v1.TallySettlementRow
import centraid.core.v1.TallyTransfer
import centraid.core.v1.TallyValuation
import centraid.screen.v1.Money
import centraid.screen.v1.TallyFigure
import centraid.screen.v1.TallyHero
import centraid.screen.v1.TallyLedgerRow
import centraid.screen.v1.TallyPersonChip
import centraid.screen.v1.TallyTone
import centraid.screen.v1.TallyTransferRow
import dev.centraid.design.CentraidCatalog
import dev.centraid.design.copy.TallyCopy
import dev.centraid.shared.kit.MoneyFold
import dev.centraid.shared.kit.time.CivilWords

/**
 * THE FOLDS EVERY TALLY SCREEN SHARES — pure, and never arithmetic the core
 * did not do: a `TallyMoney` becomes a `Money` unchanged, a position's sign
 * becomes a tone and words, and nothing is added across currencies (there is
 * no `+` on money in this file).
 */
internal object TallyFold {
    /** A core amount as the screen's, UNCHANGED: minor units, code, exponent. */
    fun money(amount: TallyMoney?): Money = Money(
        minor = amount?.minor ?: 0L,
        currency = amount?.currency ?: "",
        exponent = amount?.exponent ?: 0,
    )

    /** The same amount without its sign, for a figure whose tone carries it. */
    fun magnitude(amount: Money): Money = if (amount.minor < 0) amount.copy(minor = -amount.minor) else amount

    fun chip(person: TallyPerson?): TallyPersonChip = TallyPersonChip(
        party_id = person?.party_id ?: "",
        name = person?.name ?: "",
        initials = person?.initials ?: "",
        hue = person?.color ?: "",
        is_me = person?.is_me ?: false,
    )

    /**
     * A POSITION: positive is owed to you. [owed], [owe] and [level] are the
     * words for this surface ("owes you" on a friend, "owed to you" on a hero).
     */
    fun position(amount: TallyMoney?, owed: String, owe: String, level: String): TallyFigure {
        val money = money(amount)
        return when (MoneyFold.sign(money)) {
            1 -> TallyFigure(amount = money, tone = TallyTone.TALLY_TONE_OWED, label = owed)
            -1 -> TallyFigure(amount = magnitude(money), tone = TallyTone.TALLY_TONE_OWE, label = owe)
            else -> TallyFigure(amount = money, tone = TallyTone.TALLY_TONE_LEVEL, label = level)
        }
    }

    /** Your part of an expense, as the core stated your stance on it. */
    fun yours(role: TallyRole, amount: TallyMoney?): TallyFigure {
        val money = magnitude(money(amount))
        return when (role) {
            TallyRole.TALLY_ROLE_LENT ->
                TallyFigure(amount = money, tone = TallyTone.TALLY_TONE_OWED, label = TallyCopy.YOU_LENT)
            TallyRole.TALLY_ROLE_BORROWED ->
                TallyFigure(amount = money, tone = TallyTone.TALLY_TONE_OWE, label = TallyCopy.YOU_BORROWED)
            else -> TallyFigure(amount = money, tone = TallyTone.TALLY_TONE_PLAIN, label = TallyCopy.NOT_INVOLVED)
        }
    }

    /**
     * A HERO over what the core valued: its one total when it could make one,
     * else one line per currency — never a sum nobody computed.
     */
    fun figures(valuation: TallyValuation?, owed: String, owe: String, level: String): List<TallyFigure> {
        valuation ?: return emptyList()
        val total = valuation.total
        val amounts = if (valuation.valued && total != null) listOf(total) else valuation.components
        return amounts.filter { it.minor != 0L }.map { position(it, owed, owe, level) }
    }

    /** A one-figure hero: a group's net, in the group's one money. */
    fun hero(net: TallyMoney?, owed: String, owe: String, level: String, sub: String): TallyHero {
        val figure = position(net, owed, owe, level)
        return TallyHero(lines = listOf(figure), label = figure.label, sub = sub, tone = figure.tone)
    }

    /** "You" for the owner, else the name the core resolved. */
    private fun who(person: TallyPerson?): String = person?.name?.ifEmpty { TallyCopy.SOMEONE } ?: TallyCopy.SOMEONE

    /** `Today` / `Yesterday` / `Wed 11 March` against [today], or `Wed 11 March`. */
    fun day(day: String, today: String?): String =
        if (day.isEmpty()) "" else if (today.isNullOrEmpty()) CivilWords.dayMonth(day) else CivilWords.relativeDay(day, today)

    private fun metaOf(vararg parts: String): String = parts.filter { it.isNotEmpty() }.joinToString(" · ")

    private fun paid(person: TallyPerson?): String = "${who(person)} ${TallyCopy.PAID_WORD}"

    fun categoryLabel(category: String): String = CATEGORY_LABELS[category] ?: category

    /** An Activity row. */
    fun activityRow(row: TallyActivityExpense, today: String?): TallyLedgerRow = ledgerRow(
        expenseId = row.expense_id,
        title = row.description,
        meta = metaOf(paid(row.paid_by), row.group_name, day(row.date, today)),
        amount = row.amount,
        yours = yours(row.your_role, row.your_amount),
        payer = row.paid_by,
        category = row.category,
    )

    /** A ledger row on a group, a friend or a search hit. */
    fun expenseRow(row: TallyExpenseRow, today: String?, withGroup: Boolean): TallyLedgerRow = ledgerRow(
        expenseId = row.expense_id,
        title = row.description,
        meta = metaOf(paid(row.paid_by), if (withGroup) row.group_name else "", day(row.spent_on, today)),
        amount = row.amount,
        yours = yours(row.your_role, row.your_amount),
        payer = row.paid_by,
        category = row.category,
    )

    private fun ledgerRow(
        expenseId: String,
        title: String,
        meta: String,
        amount: TallyMoney?,
        yours: TallyFigure,
        payer: TallyPerson?,
        category: String,
    ): TallyLedgerRow {
        val shown = title.ifEmpty { TallyCopy.UNTITLED_EXPENSE }
        return TallyLedgerRow(
            row_key = "e:$expenseId",
            expense_id = expenseId,
            title = shown,
            meta = meta,
            amount = money(amount),
            yours = yours,
            payer = chip(payer),
            icon_key = categoryIcon(category),
            accessibility_label = "$shown, $meta, ${yours.label}",
        )
    }

    /** A settlement: real cash, anyone to anyone. It does not open. */
    fun settlementRow(row: TallySettlementRow, groupName: String, today: String?): TallyLedgerRow {
        val mine = row.from?.is_me == true || row.to?.is_me == true
        val line = "${who(row.from)} ${TallyCopy.PAID_WORD} ${who(row.to)}"
        val meta = metaOf(
            groupName,
            day(row.paid_on ?: "", today),
            if (mine) "" else TallyCopy.SETTLEMENT_NOT_YOURS,
        )
        val amount = money(row.amount)
        return TallyLedgerRow(
            row_key = "s:${row.settlement_id}",
            expense_id = "",
            title = line,
            meta = meta,
            amount = amount,
            yours = TallyFigure(amount = amount, tone = TallyTone.TALLY_TONE_PLAIN, label = TallyCopy.SETTLEMENT_WORD),
            payer = chip(row.from),
            icon_key = SETTLEMENT_ICON,
            accessibility_label = "$line, $meta",
            settlement = true,
        )
    }

    /** A proposed payment. [groupNames] names the group it settles. */
    fun transferRow(transfer: TallyTransfer, groupNames: Map<String, String>): TallyTransferRow {
        val groupId = transfer.group_id ?: ""
        val line = "${who(transfer.from)} ${TallyCopy.PAYS_WORD} ${who(transfer.to)}"
        val meta = if (groupId.isEmpty()) TallyCopy.OUTSIDE_ANY_GROUP else groupNames[groupId] ?: ""
        val amount = money(transfer.amount)
        return TallyTransferRow(
            key = listOf(transfer.from?.party_id ?: "", transfer.to?.party_id ?: "", groupId, amount.currency)
                .joinToString("|"),
            from = chip(transfer.from),
            to = chip(transfer.to),
            amount = amount,
            line = line,
            meta = meta,
            group_id = groupId,
            accessibility_label = "$line, $meta",
            yours = transfer.from?.is_me == true || transfer.to?.is_me == true,
        )
    }

    /**
     * THE NINE CATEGORIES, closed (`CATEGORY_ENUM` in the vault), in the order
     * the editor offers them.
     */
    val CATEGORIES: List<String> = listOf(
        "general",
        "food",
        "groceries",
        "rent",
        "utilities",
        "transport",
        "fun",
        "travel",
        "shopping",
    )

    private val CATEGORY_LABELS: Map<String, String> = mapOf(
        "general" to TallyCopy.CATEGORY_GENERAL,
        "food" to TallyCopy.CATEGORY_FOOD,
        "groceries" to TallyCopy.CATEGORY_GROCERIES,
        "rent" to TallyCopy.CATEGORY_RENT,
        "utilities" to TallyCopy.CATEGORY_UTILITIES,
        "transport" to TallyCopy.CATEGORY_TRANSPORT,
        "fun" to TallyCopy.CATEGORY_FUN,
        "travel" to TallyCopy.CATEGORY_TRAVEL,
        "shopping" to TallyCopy.CATEGORY_SHOPPING,
    )

    /**
     * A CATEGORY AS A CATALOG ICON (`design/native-catalog.json`), the
     * nearest the catalog draws: it has no plate, cart or bus, so food is a
     * receipt, groceries a list, transport a compass.
     */
    fun categoryIcon(category: String): String = CATEGORY_ICONS[category] ?: CATEGORY_ICONS.getValue("general")

    private val CATEGORY_ICONS: Map<String, String> = mapOf(
        "general" to "Tag",
        "food" to "Receipt",
        "groceries" to "Todo",
        "rent" to "Home",
        "utilities" to "Bolt",
        "transport" to "Compass",
        "fun" to "Music",
        "travel" to "Globe",
        "shopping" to "Gift",
    )

    /** A settlement is cash moving: the coin. */
    const val SETTLEMENT_ICON: String = "Coin"

    /**
     * A GROUP'S ICON IS WHAT ITS MEMBER TYPED (`tally.create_group`'s free
     * `icon`, an emoji in practice): drawn as the glyph it is, over the
     * catalog's group mark — unless it already names a catalog icon.
     */
    fun groupIcon(icon: String): String = icon.takeIf { CentraidCatalog.icons.containsKey(it) } ?: GROUP_ICON

    /** The member's own glyph for a group, or empty when [groupIcon] is it. */
    fun groupGlyph(icon: String): String = if (CentraidCatalog.icons.containsKey(icon)) "" else icon.trim()

    const val GROUP_ICON: String = "Users"

    /** `n thing` / `n things`, with the words the copy table gives. */
    fun count(n: Int, one: String, many: String): String = "$n ${if (n == 1) one else many}"
}
