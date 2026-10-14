package dev.centraid.shared.apps.money

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.MoneyCategoriesRequest
import centraid.core.v1.MoneyRules
import centraid.core.v1.MoneyRulesRequest
import centraid.screen.v1.Confirm
import centraid.screen.v1.EmptyState
import centraid.screen.v1.Loading
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
 * An edit sends only what this page shows: a rule's amount limits and account
 * are the core's and stay as they are.
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
            event.sheet_closed != null -> Step(
                held.copy(
                    screen = if (screen.sheet == MoneyRulesState.Sheet.SHEET_CATEGORY) {
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

    private fun check(editor: MoneyRuleEditor): MoneyRuleEditor {
        val add = editor.mode == MoneyRuleEditor.Mode.MODE_ADD
        val hasEffect = editor.category_label.isNotEmpty() || editor.category_id.isNotEmpty() || editor.display_name.isNotBlank()
        val issue = when {
            editor.pattern.isBlank() -> MoneyCopy.RULE_PATTERN_MISSING
            editor.pattern.length > PATTERN_MAX -> MoneyCopy.RULE_PATTERN_LONG
            !hasEffect -> MoneyCopy.RULE_EFFECT_MISSING
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
        )
    }

    private fun save(held: MoneyHeld<MoneyRulesState>, editor: MoneyRuleEditor): Step<MoneyHeld<MoneyRulesState>> {
        val checked = check(editor)
        if (!checked.can_save) return Step(held.copy(screen = held.screen.copy(editor = checked)))
        val name = checked.display_name.trim().ifEmpty { null }
        if (checked.mode == MoneyRuleEditor.Mode.MODE_ADD) {
            val id = "rule-${held.screen.draft_token}-${held.tokens + 1}"
            val input = MoneyFold.json(
                "rule_id" to MoneyFold.str(id),
                "match_kind" to MoneyFold.str(checked.kind),
                "pattern" to MoneyFold.str(checked.pattern.trim()),
                "set_category_concept_id" to checked.category_id.ifEmpty { null }?.let(MoneyFold::str),
                "set_display_name" to name?.let(MoneyFold::str),
            )
            return WriteLaw.submit(Writes, held.copy(tokens = held.tokens + 1), CMD_ADD, input, InvokeKeys.of(CMD_ADD, id))
        }
        // A CATEGORY THE PAGE COULD NOT NAME STAYS: only a known or a cleared one is sent.
        val categoryField = when {
            checked.category_id.isNotEmpty() -> MoneyFold.str(checked.category_id)
            checked.category_label.isEmpty() -> "null"
            else -> null
        }
        val input = MoneyFold.json(
            "rule_id" to MoneyFold.str(checked.rule_id),
            "match_kind" to MoneyFold.str(checked.kind),
            "pattern" to MoneyFold.str(checked.pattern.trim()),
            "set_category_concept_id" to categoryField,
            "set_display_name" to MoneyFold.strOrNull(name),
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
        return screen.copy(editor = screen.editor?.let(::check))
    }

    private fun chrome(parent: String): MoneyPageChrome = MoneyPageChrome(
        title = MoneyCopy.RULES_TITLE,
        back_label = parent.ifEmpty { MoneyCopy.APP_TITLE },
        retry = MoneyCopy.RETRY,
    )

    private const val PATTERN_MAX: Int = 200

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

/** The rules, and the categories their sheet files under. */
public object MoneyRulesReads : MoneyQueries<MoneyRulesState, MoneyRulesEvent>(
    screenId = MoneyRulesMachine.SCREEN_ID,
    tables = MONEY_TABLES,
    ask = { _, _ ->
        listOf(
            AppQueryRequest(money_rules = MoneyRulesRequest()),
            AppQueryRequest(money_categories = MoneyCategoriesRequest()),
        )
    },
)
