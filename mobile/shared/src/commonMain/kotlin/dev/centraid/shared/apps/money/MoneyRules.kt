package dev.centraid.shared.apps.money

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.MoneyAccounts
import centraid.core.v1.MoneyAccountsRequest
import centraid.core.v1.MoneyAmount
import centraid.core.v1.MoneyCategoriesRequest
import centraid.core.v1.MoneyRules
import centraid.core.v1.MoneyRulesRequest
import centraid.screen.v1.Confirm
import centraid.screen.v1.EmptyState
import centraid.screen.v1.Loading
import centraid.screen.v1.Money
import centraid.screen.v1.MoneyChoice
import centraid.screen.v1.MoneyPageChrome
import centraid.screen.v1.MoneyRuleEditor
import centraid.screen.v1.MoneyRuleRow
import centraid.screen.v1.MoneyRulesData
import centraid.screen.v1.MoneyRulesEvent
import centraid.screen.v1.MoneyRulesState
import centraid.screen.v1.SeatState
import centraid.screen.v1.StatusLine
import centraid.screen.v1.WriteSettled
import centraid.screen.v1.WriteState
import dev.centraid.design.copy.MoneyCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.InvokeKeys
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.kit.WriteLens
import dev.centraid.shared.screen.Step

/**
 * RULES (#1099): how a line gets its name and its category. A rule matches the
 * bank's own words (is, contains, or a pattern with `*` and `?`) and sets a
 * category, a name or both; the most specific rule wins. A rule is added,
 * edited and deleted here, and can be applied to the lines already in. Rules
 * never touch a line the member filed or named themselves.
 *
 * AN EDIT SENDS EVERYTHING THE SHEET SHOWS (R-1119-2): the pattern, kind, category
 * and name, and the rule's amount limits and account. A cleared limit or account
 * is sent as null, and an untouched one as its current value. The limits are
 * typed in the units of the account they name; with no account they are typed in
 * the one exponent every account shares, and when there is none the fields are
 * locked and the stored limits go back unchanged. A category or account the page
 * cannot name by its label is left rather than cleared.
 */
public object MoneyRulesMachine :
    MoneyQueryMachine<MoneyRulesState, MoneyRulesEvent, MoneyRulesData>("money.rules", MONEY_TABLES) {
    public const val SCREEN_ID: String = "money.rules"
    public const val CMD_ADD: String = "money.add_rule"
    public const val CMD_EDIT: String = "money.edit_rule"
    public const val CMD_DELETE: String = "money.delete_rule"
    public const val CMD_APPLY: String = "money.apply_rule_to_history"

    private const val PENDING_DELETE: String = "delete"
    private const val PENDING_APPLY: String = "apply"

    private val KINDS: List<Pair<String, String>> = listOf(
        "contains" to MoneyCopy.KIND_CONTAINS,
        "is" to MoneyCopy.KIND_IS,
        "matches" to MoneyCopy.KIND_MATCHES,
    )

    override val lens: ContentLens<MoneyRulesState, MoneyRulesData> = Lens

    override fun blank(): MoneyRulesState = MoneyRulesState(
        write = WriteState(phase = WriteState.Phase.PHASE_IDLE),
        sheet = MoneyRulesState.Sheet.SHEET_NONE,
        chrome = chrome(""),
    )

    override fun withSeat(screen: MoneyRulesState, seat: SeatState): MoneyRulesState = screen.copy(seat = seat)

    override fun view(held: MoneyHeld<MoneyRulesState>, event: MoneyRulesEvent): Step<MoneyHeld<MoneyRulesState>> {
        val screen = held.screen
        val editor = screen.editor
        return when {
            event.opened != null -> reload(
                held.copy(
                    screen = blank().copy(
                        seat = screen.seat,
                        chrome = chrome(event.opened.parent),
                        draft_token = event.opened.draft_token,
                    ),
                ),
            )

            event.refreshed != null -> read(overRows(held))

            event.add != null -> Step(
                held.copy(
                    screen = screen.copy(
                        sheet = MoneyRulesState.Sheet.SHEET_EDITOR,
                        status = null,
                        editor = MoneyRuleEditor(mode = MoneyRuleEditor.Mode.MODE_ADD, kind = KINDS.first().first),
                    ),
                ),
            )

            event.rule != null -> {
                val rule = held.answers.rules?.rules?.firstOrNull { it.rule_id == event.rule.rule_id } ?: return Step(held)
                val label = rule.category_label.orEmpty()
                // THE RULE NAMES ITS CATEGORY BY LABEL: the id is found by it, and
                // when it cannot be (a renamed or archived one) the category is left alone on save.
                val id = if (label.isEmpty()) "" else categories(held).firstOrNull { it.second == label }?.first.orEmpty()
                // THE SAME FOR THE ACCOUNT: named by its label (account names are unique), else left alone on save.
                val accountLabel = rule.account_label.orEmpty()
                val accountId = if (accountLabel.isEmpty()) "" else accountByName(held, accountLabel)?.account_id.orEmpty()
                val exponent = limitsExponent(held, accountId, accountLabel)
                val currency = limitsCurrency(held, accountId, accountLabel)
                Step(
                    held.copy(
                        screen = screen.copy(
                            sheet = MoneyRulesState.Sheet.SHEET_EDITOR,
                            status = null,
                            editor = MoneyRuleEditor(
                                mode = MoneyRuleEditor.Mode.MODE_EDIT,
                                rule_id = rule.rule_id,
                                kind = MoneyFold.matchKindKey(rule.kind),
                                pattern = rule.pattern,
                                category_id = id,
                                category_label = label,
                                display_name = rule.display_name.orEmpty(),
                                account_id = accountId,
                                account_label = accountLabel,
                                amount_min = stored(rule.amount_min, currency, exponent),
                                amount_max = stored(rule.amount_max, currency, exponent),
                                amount_min_text = seeded(rule.amount_min, exponent),
                                amount_max_text = seeded(rule.amount_max, exponent),
                            ),
                        ),
                    ),
                )
            }

            // The list's own act: apply every rule to the lines already in.
            event.apply != null && editor == null -> Step(
                held.copy(screen = screen.copy(confirm = applyConfirm(), pending = PENDING_APPLY)),
            )

            event.confirm_dismissed != null -> Step(held.copy(screen = screen.copy(confirm = null, pending = "")))

            event.confirm_accepted != null && screen.confirm != null -> confirmed(held)

            editor == null -> Step(held)

            event.kind_picked != null -> Step(held.copy(screen = screen.copy(editor = editor.copy(kind = event.kind_picked.kind))))
            event.pattern != null -> Step(held.copy(screen = screen.copy(editor = editor.copy(pattern = event.pattern.text))))
            event.name != null -> Step(held.copy(screen = screen.copy(editor = editor.copy(display_name = event.name.text))))
            event.category_sheet != null -> Step(held.copy(screen = screen.copy(sheet = MoneyRulesState.Sheet.SHEET_CATEGORY)))
            event.category != null -> {
                val id = event.category.category_id
                val label = categories(held).firstOrNull { it.first == id }?.second.orEmpty()
                Step(
                    held.copy(
                        screen = screen.copy(
                            sheet = MoneyRulesState.Sheet.SHEET_EDITOR,
                            editor = editor.copy(category_id = id, category_label = label),
                        ),
                    ),
                )
            }
            event.amount_min != null -> Step(held.copy(screen = screen.copy(editor = editor.copy(amount_min_text = event.amount_min.text))))
            event.amount_max != null -> Step(held.copy(screen = screen.copy(editor = editor.copy(amount_max_text = event.amount_max.text))))
            event.account_sheet != null -> Step(held.copy(screen = screen.copy(sheet = MoneyRulesState.Sheet.SHEET_ACCOUNT)))
            event.account != null -> pickAccount(held, editor, event.account.account_id)
            event.sheet_closed != null -> Step(
                held.copy(
                    screen = if (screen.sheet == MoneyRulesState.Sheet.SHEET_CATEGORY || screen.sheet == MoneyRulesState.Sheet.SHEET_ACCOUNT) {
                        screen.copy(sheet = MoneyRulesState.Sheet.SHEET_EDITOR)
                    } else {
                        screen.copy(sheet = MoneyRulesState.Sheet.SHEET_NONE, editor = null)
                    },
                ),
            )
            event.save != null -> save(held, editor)
            event.delete != null && editor.mode == MoneyRuleEditor.Mode.MODE_EDIT -> Step(
                held.copy(screen = screen.copy(confirm = deleteConfirm(), pending = PENDING_DELETE)),
            )
            event.apply != null && editor.mode == MoneyRuleEditor.Mode.MODE_EDIT -> Step(
                held.copy(screen = screen.copy(confirm = applyConfirm(), pending = PENDING_APPLY)),
            )
            else -> Step(held)
        }
    }

    private fun categories(held: MoneyHeld<MoneyRulesState>): List<Pair<String, String>> =
        held.answers.categories?.groups.orEmpty().flatMap { group -> group.categories.map { it.category_id to it.label } }

    private fun accountLines(held: MoneyHeld<MoneyRulesState>): List<MoneyAccounts.AccountLine> =
        held.answers.accounts?.let { it.on_budget + it.off_budget }.orEmpty()

    /**
     * The rule's account, by the name the core printed for it: both answers carry the vault's
     * stored name byte for byte, so the match is exact. A case-blind match would differ from the
     * vault's own uniqueness check (SQLite's ASCII-only `lower()`) on a non-ASCII name.
     */
    private fun accountByName(held: MoneyHeld<MoneyRulesState>, label: String): MoneyAccounts.AccountLine? =
        accountLines(held).firstOrNull { it.name == label }

    /**
     * EACH CURRENCY'S EXPONENT, as the core states it on the amounts the accounts
     * answer carries (a balance, a statement's figures, net worth). It is never
     * guessed: a currency none of them states has no entry.
     */
    private fun exponents(held: MoneyHeld<MoneyRulesState>): Map<String, Int> {
        val answer = held.answers.accounts ?: return emptyMap()
        val seen = linkedMapOf<String, Int>()
        fun see(amount: MoneyAmount?) {
            if (amount != null && amount.currency.isNotEmpty()) seen.getOrPut(amount.currency) { amount.exponent }
        }
        (answer.on_budget + answer.off_budget).forEach { line ->
            see(line.balance)
            see(line.checkpoint?.stated)
            see(line.checkpoint?.delta)
        }
        answer.net_worth.forEach { see(it.amount) }
        return seen
    }

    /** The accounts a rule's limits are typed against: the one it names, else every account. */
    private fun limitAccounts(held: MoneyHeld<MoneyRulesState>, accountId: String): List<MoneyAccounts.AccountLine> =
        if (accountId.isEmpty()) accountLines(held) else accountLines(held).filter { it.account_id == accountId }

    /**
     * THE EXPONENT THE LIMITS ARE TYPED IN, or null when no one is known: an
     * account the page cannot name, a currency the answer never states, or
     * accounts that disagree (a limit is a count of minor units, so it means
     * nothing until an account says which).
     */
    private fun limitsExponent(held: MoneyHeld<MoneyRulesState>, accountId: String, accountLabel: String): Int? {
        if (accountId.isEmpty() && accountLabel.isNotEmpty()) return null
        val table = exponents(held)
        return limitAccounts(held, accountId).map { table[it.currency] ?: return null }.distinct().singleOrNull()
    }

    /** The currency code the limits are in; empty when it is not one currency. */
    private fun limitsCurrency(held: MoneyHeld<MoneyRulesState>, accountId: String, accountLabel: String): String {
        if (accountId.isEmpty() && accountLabel.isNotEmpty()) return ""
        return limitAccounts(held, accountId).map { it.currency }.distinct().singleOrNull().orEmpty()
    }

    /** A stored limit as the kit's Money, in the currency and exponent the limits are typed in. */
    private fun stored(minor: Long?, currency: String, exponent: Int?): Money? =
        minor?.let { Money(minor = it, currency = currency, exponent = exponent ?: 0) }

    /** A stored limit as the field holds it; empty when there is none or no exponent to state it in. */
    private fun seeded(minor: Long?, exponent: Int?): String =
        if (minor == null || exponent == null) "" else MoneyFold.amountText(minor, exponent)

    private fun pickAccount(
        held: MoneyHeld<MoneyRulesState>,
        editor: MoneyRuleEditor,
        accountId: String,
    ): Step<MoneyHeld<MoneyRulesState>> {
        val line = accountLines(held).firstOrNull { it.account_id == accountId }
        if (accountId.isNotEmpty() && line == null) return Step(held)
        val label = line?.name.orEmpty()
        val before = limitsExponent(held, editor.account_id, editor.account_label)
        val after = limitsExponent(held, accountId, label)
        var next = editor.copy(account_id = accountId, account_label = label)
        // LIMITS THAT WERE LOCKED are in the units of the account the member now names: show them.
        if (before == null && after != null) {
            next = next.copy(
                amount_min_text = seeded(editor.amount_min?.minor, after),
                amount_max_text = seeded(editor.amount_max?.minor, after),
            )
        }
        return Step(held.copy(screen = held.screen.copy(sheet = MoneyRulesState.Sheet.SHEET_EDITOR, editor = next)))
    }

    private fun applyConfirm(): Confirm = Confirm(
        title = MoneyCopy.APPLY_TITLE,
        body = MoneyCopy.APPLY_BODY,
        confirm_label = MoneyCopy.APPLY_CONFIRM,
        destructive = false,
    )

    private fun deleteConfirm(): Confirm = Confirm(
        title = MoneyCopy.RULE_DELETE_TITLE,
        body = MoneyCopy.RULE_DELETE_BODY,
        confirm_label = MoneyCopy.RULE_DELETE_CONFIRM,
        destructive = true,
    )

    private fun confirmed(held: MoneyHeld<MoneyRulesState>): Step<MoneyHeld<MoneyRulesState>> {
        val screen = held.screen
        val editor = screen.editor
        val cleared = held.copy(screen = screen.copy(confirm = null, pending = ""))
        val ruleId = editor?.rule_id.orEmpty()
        return when (screen.pending) {
            PENDING_DELETE -> WriteLaw.submit(
                Writes,
                cleared,
                CMD_DELETE,
                MoneyFold.json("rule_id" to MoneyFold.str(ruleId)),
                InvokeKeys.of(CMD_DELETE, ruleId),
            )
            PENDING_APPLY -> {
                val input = MoneyFold.json("rule_id" to ruleId.takeIf { editor != null && it.isNotEmpty() }?.let(MoneyFold::str))
                WriteLaw.submit(Writes, cleared, CMD_APPLY, input, InvokeKeys.of(CMD_APPLY, ruleId.ifEmpty { "all" }, (held.tokens + 1).toString()))
                    .let { step -> Step(step.state.copy(tokens = held.tokens + 1), step.effects) }
            }
            else -> Step(cleared)
        }
    }

    /** A typed limit in minor units; null when blank, invalid or locked. */
    private fun typedLimit(text: String, exponent: Int?): Long? =
        if (exponent == null || text.isBlank()) null else MoneyFold.parseAmount(text, exponent)

    private fun check(held: MoneyHeld<MoneyRulesState>, editor: MoneyRuleEditor): MoneyRuleEditor {
        val add = editor.mode == MoneyRuleEditor.Mode.MODE_ADD
        val hasEffect = editor.category_label.isNotEmpty() || editor.category_id.isNotEmpty() || editor.display_name.isNotBlank()
        val exponent = limitsExponent(held, editor.account_id, editor.account_label)
        val currency = limitsCurrency(held, editor.account_id, editor.account_label)
        val min = typedLimit(editor.amount_min_text, exponent)
        val max = typedLimit(editor.amount_max_text, exponent)
        val issue = when {
            editor.pattern.isBlank() -> MoneyCopy.RULE_PATTERN_MISSING
            editor.pattern.length > PATTERN_MAX -> MoneyCopy.RULE_PATTERN_LONG
            !hasEffect -> MoneyCopy.RULE_EFFECT_MISSING
            exponent != null && editor.amount_min_text.isNotBlank() && min == null -> MoneyCopy.AMOUNT_INVALID
            exponent != null && editor.amount_max_text.isNotBlank() && max == null -> MoneyCopy.AMOUNT_INVALID
            min != null && max != null && min > max -> MoneyCopy.RULE_LIMITS_ORDER
            else -> ""
        }
        return editor.copy(
            can_save = issue.isEmpty(),
            issue = if (editor.pattern.isEmpty() && add) "" else issue,
            title = if (add) MoneyCopy.RULE_ADD_TITLE else MoneyCopy.RULE_EDIT_TITLE,
            save_label = if (add) MoneyCopy.RULE_ADD_SAVE else MoneyCopy.SAVE,
            kind_label = MoneyCopy.RULE_WHEN_BANK_WROTE,
            kind_options = KINDS.map { (key, label) -> MoneyFold.choice(key, label, key == editor.kind) },
            pattern_label = MoneyCopy.RULE_PATTERN,
            pattern_note = if (editor.kind == "matches") MoneyCopy.RULE_PATTERN_WILDCARD else MoneyCopy.RULE_PATTERN_NOTE,
            category_row_label = MoneyCopy.RULE_SET_CATEGORY,
            name_label = MoneyCopy.RULE_SET_NAME,
            delete_label = if (add) "" else MoneyCopy.RULE_DELETE,
            apply_label = if (add) "" else MoneyCopy.RULE_APPLY,
            cancel_label = MoneyCopy.CANCEL,
            clear_category_label = MoneyCopy.NO_CATEGORY,
            account_row_label = MoneyCopy.RULE_ACCOUNT,
            clear_account_label = MoneyCopy.RULE_ACCOUNT_ANY,
            amount_min_label = listOf(MoneyCopy.RULE_AMOUNT_MIN, currency).filter { it.isNotEmpty() }.joinToString(LABEL_JOIN),
            amount_max_label = listOf(MoneyCopy.RULE_AMOUNT_MAX, currency).filter { it.isNotEmpty() }.joinToString(LABEL_JOIN),
            limits_enabled = exponent != null,
            amount_note = when {
                exponent == null -> MoneyCopy.RULE_LIMITS_LOCKED_NOTE
                exponent == 0 -> "${MoneyCopy.RULE_AMOUNT_NOTE} ${MoneyCopy.WHOLE_UNITS}"
                else -> MoneyCopy.RULE_AMOUNT_NOTE
            },
        )
    }

    /**
     * A LIMIT AS THE COMMAND TAKES IT: the typed amount, null once cleared, and
     * while the fields are locked the stored one, so an untouched limit goes
     * back as it is.
     */
    private fun limitField(exponent: Int?, text: String, stored: Money?): String =
        when {
            exponent == null -> stored?.minor?.toString() ?: "null"
            text.isBlank() -> "null"
            else -> MoneyFold.parseAmount(text, exponent)?.toString() ?: "null"
        }

    private fun save(held: MoneyHeld<MoneyRulesState>, editor: MoneyRuleEditor): Step<MoneyHeld<MoneyRulesState>> {
        val checked = check(held, editor)
        if (!checked.can_save) return Step(held.copy(screen = held.screen.copy(editor = checked)))
        val name = checked.display_name.trim().ifEmpty { null }
        val exponent = limitsExponent(held, checked.account_id, checked.account_label)
        val min = limitField(exponent, checked.amount_min_text, checked.amount_min)
        val max = limitField(exponent, checked.amount_max_text, checked.amount_max)
        if (checked.mode == MoneyRuleEditor.Mode.MODE_ADD) {
            val id = "rule-${held.screen.draft_token}-${held.tokens + 1}"
            val input = MoneyFold.json(
                "rule_id" to MoneyFold.str(id),
                "match_kind" to MoneyFold.str(checked.kind),
                "pattern" to MoneyFold.str(checked.pattern.trim()),
                "set_category_concept_id" to checked.category_id.ifEmpty { null }?.let(MoneyFold::str),
                "set_display_name" to name?.let(MoneyFold::str),
                // A NEW RULE'S NO-LIMIT IS AN ABSENT KEY.
                "amount_min_minor" to min.takeIf { it != "null" },
                "amount_max_minor" to max.takeIf { it != "null" },
                "account_id" to checked.account_id.ifEmpty { null }?.let(MoneyFold::str),
            )
            return WriteLaw.submit(Writes, held.copy(tokens = held.tokens + 1), CMD_ADD, input, InvokeKeys.of(CMD_ADD, id))
        }
        // A CATEGORY THE PAGE COULD NOT NAME STAYS: only a known or a cleared one is sent.
        val categoryField = when {
            checked.category_id.isNotEmpty() -> MoneyFold.str(checked.category_id)
            checked.category_label.isEmpty() -> "null"
            else -> null
        }
        // THE SAME FOR THE ACCOUNT: a known one is sent, a cleared one is null, one the page could not name stays.
        val accountField = when {
            checked.account_id.isNotEmpty() -> MoneyFold.str(checked.account_id)
            checked.account_label.isEmpty() -> "null"
            else -> null
        }
        val input = MoneyFold.json(
            "rule_id" to MoneyFold.str(checked.rule_id),
            "match_kind" to MoneyFold.str(checked.kind),
            "pattern" to MoneyFold.str(checked.pattern.trim()),
            "set_category_concept_id" to categoryField,
            "set_display_name" to MoneyFold.strOrNull(name),
            "amount_min_minor" to min,
            "amount_max_minor" to max,
            "account_id" to accountField,
        )
        val key = InvokeKeys.of(CMD_EDIT, checked.rule_id, (held.tokens + 1).toString())
        return WriteLaw.submit(Writes, held.copy(tokens = held.tokens + 1), CMD_EDIT, input, key)
    }

    override fun settled(held: MoneyHeld<MoneyRulesState>, settled: WriteSettled): Step<MoneyHeld<MoneyRulesState>> {
        val step = WriteLaw.settled(Writes, held, settled)
        if (step.state === held) return step
        val screen = step.state.screen
        val command = settled.invoke_key.substringBefore(':')
        if (!settled.committed) {
            return Step(
                step.state.copy(
                    screen = screen.copy(
                        status = StatusLine(
                            sentence = settled.failure?.sentence?.takeIf { it.isNotEmpty() } ?: MoneyCopy.WRITE_REFUSED,
                            refused = true,
                        ),
                    ),
                ),
                step.effects,
            )
        }
        val sentence = when (command) {
            CMD_APPLY -> MoneyCopy.DONE_APPLIED
            CMD_DELETE -> MoneyCopy.DONE_RULE_DELETED
            else -> MoneyCopy.DONE_RULE
        }
        // SAVED, DELETED OR APPLIED: the sheet goes and the change event reads the list again.
        return Step(
            step.state.copy(
                screen = screen.copy(sheet = MoneyRulesState.Sheet.SHEET_NONE, editor = null, status = StatusLine(sentence = sentence)),
            ),
            step.effects,
        )
    }

    override fun fold(held: MoneyHeld<MoneyRulesState>): MoneyRulesData? {
        val answer = held.answers.rules ?: return null
        val categories = held.answers.categories
        val rows = answer.rules.map { rule -> row(rule) }
        val selected = held.screen.editor?.category_id.orEmpty()
        val chosenAccount = held.screen.editor?.account_id.orEmpty()
        return MoneyRulesData(
            rows = rows,
            limit_line = if (rows.isEmpty()) "" else MoneyFold.fill(MoneyCopy.RULES_LIMIT, "n" to rows.size.toString(), "limit" to answer.limit.toString()),
            empty = if (rows.isEmpty()) EmptyState(headline = MoneyCopy.RULES_EMPTY, action_label = MoneyCopy.RULE_ADD_SAVE) else null,
            add_label = MoneyCopy.RULE_ADD_SAVE,
            apply_label = if (rows.isEmpty()) "" else MoneyCopy.RULES_APPLY_ALL,
            category_options = buildList<MoneyChoice> {
                add(MoneyFold.choice("", MoneyCopy.NO_CATEGORY, selected.isEmpty() && held.screen.editor?.category_label.isNullOrEmpty()))
                categories?.groups.orEmpty().forEach { group ->
                    group.categories.filter { !it.archived || it.category_id == selected }.forEach { category ->
                        add(MoneyFold.choice(category.category_id, category.label, category.category_id == selected, group.label))
                    }
                }
            },
            category_sheet_title = MoneyCopy.CATEGORY_SHEET_TITLE,
            account_options = buildList<MoneyChoice> {
                add(MoneyFold.choice("", MoneyCopy.RULE_ACCOUNT_ANY, chosenAccount.isEmpty() && held.screen.editor?.account_label.isNullOrEmpty()))
                accountLines(held).filter { !it.closed || it.account_id == chosenAccount }.forEach { line ->
                    add(MoneyFold.choice(line.account_id, line.name, line.account_id == chosenAccount, line.currency))
                }
            },
            account_sheet_title = MoneyCopy.RULE_ACCOUNT_SHEET_TITLE,
        )
    }

    private fun row(rule: MoneyRules.RuleLine): MoneyRuleRow {
        val meta = listOfNotNull(
            MoneyFold.matchKindWord(rule.kind),
            rule.category_label?.let { MoneyFold.fill(MoneyCopy.RULE_FILES_UNDER, "category" to it) },
            rule.display_name?.takeIf { it.isNotEmpty() }?.let { MoneyFold.fill(MoneyCopy.RULE_NAMES_IT, "name" to it) },
            if (rule.amount_min != null || rule.amount_max != null) MoneyCopy.RULE_AMOUNT_LIMITS else null,
            rule.account_label?.let { MoneyFold.fill(MoneyCopy.RULE_ONLY_IN, "account" to it) },
        ).joinToString(" · ")
        return MoneyRuleRow(
            rule_id = rule.rule_id,
            title = rule.pattern,
            meta = meta,
            accessibility_label = "${rule.pattern}, $meta",
        )
    }

    override fun decorate(held: MoneyHeld<MoneyRulesState>): MoneyRulesState {
        val screen = held.screen
        return screen.copy(editor = screen.editor?.let { check(held, it) })
    }

    private fun chrome(parent: String): MoneyPageChrome = MoneyPageChrome(
        title = MoneyCopy.RULES_TITLE,
        back_label = parent.ifEmpty { MoneyCopy.APP_TITLE },
        retry = MoneyCopy.RETRY,
    )

    private const val PATTERN_MAX: Int = 200
    private const val LABEL_JOIN: String = " · "

    private object Writes : WriteLens<MoneyHeld<MoneyRulesState>> {
        override fun write(state: MoneyHeld<MoneyRulesState>): WriteState = state.screen.write ?: WriteState()

        override fun with(state: MoneyHeld<MoneyRulesState>, write: WriteState): MoneyHeld<MoneyRulesState> =
            state.copy(screen = state.screen.copy(write = write))
    }

    internal object Lens : ContentLens<MoneyRulesState, MoneyRulesData> {
        override fun content(state: MoneyRulesState): ReadContent<MoneyRulesData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: MoneyRulesState, content: ReadContent<MoneyRulesData>): MoneyRulesState = when (content) {
            is ReadContent.Loading -> state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
            is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
            is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
            is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
        }
    }
}

/** The rules, the categories their sheet files under, and the accounts they may be limited to. */
public object MoneyRulesReads : MoneyQueries<MoneyRulesState, MoneyRulesEvent>(
    screenId = MoneyRulesMachine.SCREEN_ID,
    tables = MONEY_TABLES,
    ask = { _, now ->
        listOf(
            AppQueryRequest(money_rules = MoneyRulesRequest()),
            AppQueryRequest(money_categories = MoneyCategoriesRequest()),
            // The accounts a rule may be limited to, and the exponent its limits are typed in.
            AppQueryRequest(money_accounts = MoneyAccountsRequest(tz = now.zone)),
        )
    },
)
