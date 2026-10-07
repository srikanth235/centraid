package dev.centraid.shared.apps.tally

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.TallyDashboardRequest
import centraid.core.v1.TallyExpenseRequest
import centraid.core.v1.TallyExpenseRow
import centraid.core.v1.TallyGroupRequest
import centraid.core.v1.TallyMoney
import centraid.core.v1.TallyRateSuggestion
import centraid.screen.v1.Confirm
import centraid.screen.v1.Loading
import centraid.screen.v1.Money
import centraid.screen.v1.SeatState
import centraid.screen.v1.TallyChoice
import centraid.screen.v1.TallyEditorChrome
import centraid.screen.v1.TallyEditorData
import centraid.screen.v1.TallyEditorEvent
import centraid.screen.v1.TallyEditorState
import centraid.screen.v1.TallyExpenseForm
import centraid.screen.v1.TallyLineEntry
import centraid.screen.v1.TallyPersonChip
import centraid.screen.v1.TallySplitEntry
import centraid.screen.v1.TallySplitMethod
import centraid.screen.v1.WriteSettled
import centraid.screen.v1.WriteState
import dev.centraid.design.copy.TallyCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.InvokeKeys
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.kit.WriteLens
import dev.centraid.shared.kit.jsonString
import dev.centraid.shared.screen.Step

/**
 * ADD OR EDIT AN EXPENSE (#1046): description and amount typed, everything
 * else a choice — payer, group, category, date, currency, and the division,
 * whose entries change with the method and are VALIDATED HERE, in minor units,
 * before the save ([TallySplit]).
 *
 * ## Explicit save, not autosave
 *
 * #1015 D3's autosave is for words; a money form is not words. A half-typed
 * amount is not an expense, and a division that does not reconcile cannot be
 * stored at all (`write_splits` refuses it), so there is nothing a debounce
 * could save on the member's way through. Save is ONE write under
 * [WriteLaw]; leaving with changes asks first; a refusal keeps every field.
 *
 * ## What the editor reads
 *
 * `tally.dashboard` (friends, groups, the base money, today and the
 * remembered rates), `tally.group` while a group is chosen (its members are
 * the roster), and `tally.expense` on an edit.
 *
 * ## An edit
 *
 * `tally.edit_expense` takes no group and no rate: the group is fixed, and a
 * converted expense keeps its rate — its currency chips are hidden
 * ([TallyEditorData.currency_locked]) and the amount is the settlement one.
 * An expense several people paid is re-saved with its named payer paying the
 * whole (the command's `payers` default): the editor has no multi-payer entry.
 */
public object TallyEditorMachine :
    TallyQueryMachine<TallyEditorState, TallyEditorEvent, TallyEditorData>(
        "tally.editor",
        TALLY_LEDGER_TABLES + setOf("core_entity_revision", "knowledge_annotation"),
    ) {
    public const val SCREEN_ID: String = "tally.editor"
    public const val ADD_COMMAND: String = "tally.add_expense"
    public const val EDIT_COMMAND: String = "tally.edit_expense"

    override val lens: ContentLens<TallyEditorState, TallyEditorData> = Lens

    override fun blank(): TallyEditorState = TallyEditorState(
        mode = TallyEditorState.Mode.MODE_ADD,
        form = TallyExpenseForm(),
        write = WriteState(phase = WriteState.Phase.PHASE_IDLE),
        sheet = TallyEditorState.Sheet.SHEET_NONE,
    )

    override fun withSeat(screen: TallyEditorState, seat: SeatState): TallyEditorState = screen.copy(seat = seat)

    // -----------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------

    override fun view(held: TallyHeld<TallyEditorState>, event: TallyEditorEvent): Step<TallyHeld<TallyEditorState>> {
        val screen = held.screen
        val form = screen.form ?: TallyExpenseForm()
        return when {
            event.opened != null -> {
                val opened = event.opened
                val mode = opened.mode.takeUnless { it == TallyEditorState.Mode.MODE_UNSPECIFIED }
                    ?: if (opened.expense_id.isEmpty()) TallyEditorState.Mode.MODE_ADD else TallyEditorState.Mode.MODE_EDIT
                reload(
                    held.copy(
                        screen = blank().copy(
                            seat = screen.seat,
                            mode = mode,
                            expense_id = opened.expense_id,
                            draft_token = opened.draft_token,
                            // THE PRESET rides as the form's first group and,
                            // for a friend, as who shares; the answer seeds the rest.
                            form = TallyExpenseForm(
                                group_id = opened.group_id,
                                entries = if (opened.party_id.isEmpty()) {
                                    emptyList()
                                } else {
                                    listOf(TallySplitEntry(person = TallyPersonChip(party_id = opened.party_id), included = true))
                                },
                            ),
                        ),
                    ),
                )
            }

            event.refreshed != null -> read(overRows(held))

            event.description != null -> edit(held, form.copy(description = event.description.text))
            event.amount != null -> edit(held, form.copy(amount_text = event.amount.text))

            // A CHOICES SHEET (#1015 D4): opened by the row, closed by a pick.
            event.sheet_opened != null ->
                if (event.sheet_opened.sheet == TallyEditorState.Sheet.SHEET_UNSPECIFIED || screen.baseline == null) {
                    Step(held)
                } else {
                    Step(held.copy(screen = screen.copy(sheet = event.sheet_opened.sheet)))
                }
            event.sheet_closed != null -> Step(closeSheet(held))

            event.payer != null -> edit(closeSheet(held), form.copy(payer_id = event.payer.party_id))
            event.category != null ->
                if (event.category.category in TallyFold.CATEGORIES) {
                    edit(closeSheet(held), form.copy(category = event.category.category))
                } else {
                    Step(held)
                }
            event.date != null -> edit(closeSheet(held), form.copy(spent_on = event.date.day))
            event.currency != null ->
                if (currencies(held).any { it.first == event.currency.currency }) {
                    edit(closeSheet(held), form.copy(currency = event.currency.currency))
                } else {
                    Step(held)
                }
            event.method != null ->
                when (event.method.method) {
                    TallySplitMethod.TALLY_SPLIT_METHOD_UNSPECIFIED -> Step(held)
                    form.method -> Step(closeSheet(held))
                    // A NEW METHOD STARTS ITS ENTRIES BLANK: a "25" typed as
                    // an amount is not 25 per cent.
                    else -> edit(closeSheet(held), form.copy(method = event.method.method, entries = form.entries.map { it.copy(text = "") }))
                }

            event.group != null -> pickGroup(closeSheet(held), event.group.group_id)

            event.entry_toggled != null -> edit(
                held,
                form.copy(
                    entries = form.entries.map {
                        if (it.person?.party_id == event.entry_toggled.party_id) it.copy(included = !it.included) else it
                    },
                ),
            )

            event.entry_changed != null -> edit(
                held,
                form.copy(
                    entries = form.entries.map {
                        if (it.person?.party_id == event.entry_changed.party_id) {
                            it.copy(text = event.entry_changed.text, included = true)
                        } else {
                            it
                        }
                    },
                ),
            )

            event.line_added != null -> {
                val next = (form.lines.mapNotNull { it.line_key.removePrefix("l").toIntOrNull() }.maxOrNull() ?: 0) + 1
                val everyone = form.entries.filter { it.included }.mapNotNull { it.person?.party_id }
                edit(held, form.copy(lines = form.lines + TallyLineEntry(line_key = "l$next", party_ids = everyone)))
            }

            event.line_removed != null ->
                edit(held, form.copy(lines = form.lines.filterNot { it.line_key == event.line_removed.line_key }))

            event.line_changed != null -> edit(
                held,
                form.copy(
                    lines = form.lines.map {
                        if (it.line_key == event.line_changed.line_key) {
                            it.copy(description = event.line_changed.description, amount_text = event.line_changed.amount_text)
                        } else {
                            it
                        }
                    },
                ),
            )

            event.line_party != null -> edit(
                held,
                form.copy(
                    lines = form.lines.map { line ->
                        if (line.line_key != event.line_party.line_key) {
                            line
                        } else {
                            val party = event.line_party.party_id
                            line.copy(party_ids = if (party in line.party_ids) line.party_ids - party else line.party_ids + party)
                        }
                    },
                ),
            )

            event.save != null -> save(held)

            // CLOSE = DONE when nothing changed; otherwise it asks.
            event.close != null ->
                if (screen.dirty && screen.write?.phase != WriteState.Phase.PHASE_COMMITTED) {
                    Step(
                        held.copy(
                            screen = screen.copy(
                                confirm = Confirm(
                                    title = TallyCopy.DISCARD_TITLE,
                                    body = TallyCopy.DISCARD_BODY,
                                    confirm_label = TallyCopy.DISCARD_COMMIT,
                                    destructive = true,
                                ),
                            ),
                        ),
                    )
                } else {
                    Step(held.copy(screen = screen.copy(done = true, confirm = null)))
                }

            event.confirmed != null ->
                if (screen.confirm == null) Step(held) else Step(held.copy(screen = screen.copy(done = true, confirm = null)))

            event.dismissed != null -> Step(held.copy(screen = screen.copy(confirm = null)))

            else -> Step(held)
        }
    }

    private fun closeSheet(held: TallyHeld<TallyEditorState>): TallyHeld<TallyEditorState> =
        held.copy(screen = held.screen.copy(sheet = TallyEditorState.Sheet.SHEET_NONE))

    /** A field changed: the form, re-folded. Nothing reads. */
    private fun edit(held: TallyHeld<TallyEditorState>, form: TallyExpenseForm): Step<TallyHeld<TallyEditorState>> {
        if (held.screen.baseline == null) return Step(held)
        return refold(held.copy(screen = held.screen.copy(form = form)))
    }

    /**
     * ANOTHER GROUP IS ANOTHER ROSTER AND ANOTHER MONEY, so it reads — the
     * group's members — and the entries start again from them. Fixed on an
     * edit: the command takes no group.
     */
    private fun pickGroup(held: TallyHeld<TallyEditorState>, groupId: String): Step<TallyHeld<TallyEditorState>> {
        val screen = held.screen
        val form = screen.form ?: return Step(held)
        if (screen.baseline == null || screen.mode == TallyEditorState.Mode.MODE_EDIT) return Step(held)
        if (form.group_id == groupId) return Step(held)
        if (groupId.isNotEmpty() && held.answers.dashboard?.groups?.none { it.group_id == groupId } != false) return Step(held)
        val moved = held.copy(
            screen = screen.copy(form = form.copy(group_id = groupId, entries = emptyList(), lines = emptyList(), currency = "")),
        )
        return if (groupId.isEmpty()) {
            refold(reconcile(moved))
        } else {
            read(overRows(moved))
        }
    }

    /**
     * AN EDIT LEARNS ITS GROUP FROM THE EXPENSE, so its roster is a second
     * read: the answer that seeded the group asks again for the members.
     */
    override fun reduce(
        state: TallyHeld<TallyEditorState>,
        event: TallyInput<TallyEditorEvent>,
    ): Step<TallyHeld<TallyEditorState>> {
        val step = super.reduce(state, event)
        val held = step.state
        val groupId = held.screen.form?.group_id ?: ""
        val waiting = event is TallyInput.Answered &&
            held.screen.baseline == null &&
            groupId.isNotEmpty() &&
            held.answers.group == null
        if (!waiting) return step
        val again = read(held)
        return Step(again.state, step.effects + again.effects)
    }

    // -----------------------------------------------------------------
    // Seeding and the roster
    // -----------------------------------------------------------------

    /** First answer: seed the form. Every answer: fit the entries to the roster. */
    override fun absorb(held: TallyHeld<TallyEditorState>): TallyHeld<TallyEditorState> {
        val screen = held.screen
        if (screen.baseline != null) return reconcile(held)
        val dashboard = held.answers.dashboard ?: return held
        val form = screen.form ?: TallyExpenseForm()
        val seeded = if (screen.mode == TallyEditorState.Mode.MODE_EDIT) {
            val row = held.answers.expense?.expense ?: return held
            seedEdit(row)
        } else {
            val preset = (listOfNotNull(dashboard.me) + form.entries.mapNotNull { it.person?.party_id }).toSet()
            form.copy(
                payer_id = dashboard.me ?: "",
                category = "general",
                spent_on = dashboard.today,
                method = TallySplitMethod.TALLY_SPLIT_METHOD_EQUALLY,
                entries = preset.map { TallySplitEntry(person = TallyPersonChip(party_id = it), included = true) },
            )
        }
        // A PRESET GROUP THAT IS GONE is no group; one whose roster has not
        // been answered yet waits for the read that asks it.
        val group = held.answers.group
        if (seeded.group_id.isNotEmpty() && group == null) return held.copy(screen = screen.copy(form = seeded))
        val placed = if (seeded.group_id.isNotEmpty() && group?.group?.group_id != seeded.group_id) {
            seeded.copy(group_id = "", entries = seeded.entries.filter { it.person?.party_id in setOfNotNull(dashboard.me) })
        } else {
            seeded
        }
        val fitted = reconcile(held.copy(screen = screen.copy(form = placed)))
        val seededForm = placed
        val fittedForm = fitted.screen.form ?: seededForm
        return fitted.copy(screen = fitted.screen.copy(baseline = truth(fittedForm)))
    }

    /** An edit opens the way the expense was entered. */
    private fun seedEdit(row: TallyExpenseRow): TallyExpenseForm {
        val exponent = row.amount?.exponent ?: 0
        val method = TallySplit.methodOf(row.split_method)
        val typed = row.split_params?.entries?.associate { it.party_id to it.value_ }.orEmpty()
        val entries = row.splits.map { share ->
            val party = share.person?.party_id ?: ""
            val text = when (method) {
                TallySplitMethod.TALLY_SPLIT_METHOD_EXACT -> TallySplit.amountText(share.amount?.minor ?: 0L, exponent)
                TallySplitMethod.TALLY_SPLIT_METHOD_PERCENTAGES, TallySplitMethod.TALLY_SPLIT_METHOD_SHARES ->
                    typed[party]?.let(::plainNumber) ?: ""
                TallySplitMethod.TALLY_SPLIT_METHOD_ADJUSTED ->
                    typed[party]?.let { TallySplit.amountText(it.toLong(), exponent) } ?: ""
                else -> ""
            }
            TallySplitEntry(person = TallyFold.chip(share.person), included = true, text = text)
        }
        return TallyExpenseForm(
            description = row.description,
            amount_text = TallySplit.amountText(row.amount?.minor ?: 0L, exponent),
            currency = row.amount?.currency ?: "",
            payer_id = row.paid_by?.party_id ?: "",
            group_id = row.group_id ?: "",
            category = row.category,
            spent_on = row.spent_on,
            method = method,
            entries = entries,
            lines = row.lines.mapIndexed { index, line ->
                TallyLineEntry(
                    line_key = "l${index + 1}",
                    description = line.description,
                    amount_text = TallySplit.amountText(line.amount?.minor ?: 0L, line.amount?.exponent ?: exponent),
                    party_ids = line.allocations.mapNotNull { it.person?.party_id },
                )
            },
        )
    }

    /** "33.5", not "33.5000001" nor "25.0". */
    private fun plainNumber(value: Double): String {
        val hundredths = kotlin.math.round(value * 100).toLong()
        return TallySplit.hundredths(hundredths)
    }

    /** Who can pay and share: a group's current members, or you and your friends. */
    private fun roster(held: TallyHeld<TallyEditorState>): List<TallyPersonChip>? {
        val form = held.screen.form ?: return null
        val dashboard = held.answers.dashboard ?: return null
        return if (form.group_id.isEmpty()) {
            val me = dashboard.me ?: ""
            listOf(TallyPersonChip(party_id = me, name = TallyCopy.YOU, is_me = true)).filter { me.isNotEmpty() } +
                dashboard.friends.mapNotNull { it.person }.map(TallyFold::chip)
        } else {
            val ledger = held.answers.group?.takeIf { it.group?.group_id == form.group_id } ?: return null
            ledger.members.filter { !it.departed }.mapNotNull { it.person }.map(TallyFold::chip)
        }
    }

    /**
     * THE ENTRIES, FITTED TO THE ROSTER: one per person, in roster order,
     * keeping what was typed beside anyone still on it. Who shares by default
     * is the whole group, or you and the friend it was opened from.
     */
    private fun reconcile(held: TallyHeld<TallyEditorState>): TallyHeld<TallyEditorState> {
        val form = held.screen.form ?: return held
        val roster = roster(held) ?: return held
        val byParty = form.entries.associateBy { it.person?.party_id ?: "" }
        val seededBefore = form.entries.isNotEmpty()
        val me = held.answers.dashboard?.me ?: ""
        val entries = roster.map { person ->
            val kept = byParty[person.party_id]
            TallySplitEntry(
                person = person,
                included = kept?.included ?: when {
                    seededBefore -> false
                    form.group_id.isNotEmpty() -> true
                    else -> person.party_id == me
                },
                text = kept?.text ?: "",
            )
        }
        val parties = roster.map { it.party_id }.toSet()
        val settlement = settlementCurrency(held)
        val currency = form.currency.takeIf { it.isNotEmpty() && (it == settlement || currencies(held).any { c -> c.first == it }) }
            ?: settlement
        return held.copy(
            screen = held.screen.copy(
                form = form.copy(
                    entries = entries,
                    payer_id = form.payer_id.takeIf { it in parties } ?: me.takeIf { it in parties } ?: roster.firstOrNull()?.party_id ?: "",
                    currency = currency,
                    lines = form.lines.map { it.copy(party_ids = it.party_ids.filter { p -> p in parties }) },
                ),
            ),
        )
    }

    /** The form's truth: what dirty compares, without anything the machine derives. */
    private fun truth(form: TallyExpenseForm): TallyExpenseForm = form.copy(
        entries = form.entries.map {
            TallySplitEntry(person = TallyPersonChip(party_id = it.person?.party_id ?: ""), included = it.included, text = it.text)
        },
        lines = form.lines.map { it.copy(issue = "") },
    )

    // -----------------------------------------------------------------
    // Money: the settlement currency, exponents, and rates
    // -----------------------------------------------------------------

    /** The group's one money, or the vault's base money for a group-less expense. */
    private fun settlementCurrency(held: TallyHeld<TallyEditorState>): String {
        val form = held.screen.form ?: TallyExpenseForm()
        if (held.screen.mode == TallyEditorState.Mode.MODE_EDIT) {
            held.answers.expense?.expense?.amount?.currency?.let { return it }
        }
        return if (form.group_id.isEmpty()) {
            held.answers.dashboard?.base_currency ?: ""
        } else {
            held.answers.group?.group?.takeIf { it.group_id == form.group_id }?.currency
                ?: held.answers.dashboard?.groups?.firstOrNull { it.group_id == form.group_id }?.your_net?.currency
                ?: ""
        }
    }

    /**
     * A CURRENCY'S EXPONENT, AS THE CORE STATED IT — never guessed: the base
     * money's `base_exponent`, a remembered rate's `from_exponent`, else the
     * exponent on any figure the answers carry. Null for a money none states.
     */
    private fun exponentOf(held: TallyHeld<TallyEditorState>, currency: String): Int? {
        if (currency.isEmpty()) return null
        val dashboard = held.answers.dashboard
        if (dashboard != null && dashboard.base_currency == currency) return dashboard.base_exponent
        dashboard?.rate_suggestions?.firstOrNull { it.from_currency == currency }?.let { return it.from_exponent }
        val seen = sequence<TallyMoney?> {
            held.answers.dashboard?.let { d ->
                yield(d.owed?.total)
                yield(d.owe?.total)
                yieldAll(d.owed?.components.orEmpty())
                yieldAll(d.owe?.components.orEmpty())
                d.friends.forEach { yieldAll(it.balances) }
                d.groups.forEach { yield(it.your_net) }
                d.archived_groups.forEach { yield(it.your_net) }
                d.activity.forEach { yield(it.expense?.amount ?: it.settlement?.amount) }
            }
            held.answers.group?.let { g ->
                g.members.forEach { yield(it.net) }
                g.ledger.forEach { yield(it.amount) }
            }
            held.answers.expense?.expense?.let { e ->
                yield(e.amount)
                yield(e.rate?.original)
            }
        }
        return seen.firstOrNull { it?.currency == currency }?.exponent
    }

    /** The settlement money, then every money a remembered rate converts from. */
    private fun currencies(held: TallyHeld<TallyEditorState>): List<Pair<String, TallyRateSuggestion?>> {
        val settlement = settlementCurrency(held)
        if (settlement.isEmpty()) return emptyList()
        if (held.screen.mode == TallyEditorState.Mode.MODE_EDIT) return listOf(settlement to null)
        val suggested = held.answers.dashboard?.rate_suggestions.orEmpty()
            .filter { it.to_currency == settlement && it.from_currency != settlement }
            .distinctBy { it.from_currency }
        return listOf(settlement to null) + suggested.map { it.from_currency to it }
    }

    // -----------------------------------------------------------------
    // The fold: choices, the division, and what stops a save
    // -----------------------------------------------------------------

    private data class Evaluation(
        val data: TallyEditorData,
        val entries: List<TallySplitEntry>,
        val lines: List<TallyLineEntry>,
        /** The save's input, when it can save. */
        val input: String?,
    )

    override fun fold(held: TallyHeld<TallyEditorState>): TallyEditorData? = evaluate(held)?.data

    private fun evaluate(held: TallyHeld<TallyEditorState>): Evaluation? {
        val screen = held.screen
        val dashboard = held.answers.dashboard ?: return null
        if (screen.mode == TallyEditorState.Mode.MODE_EDIT && held.answers.expense?.expense == null) return null
        val form = screen.form ?: return null
        val roster = roster(held).orEmpty()
        val settlement = settlementCurrency(held)
        val settlementExponent = exponentOf(held, settlement)
        val currencyChoices = currencies(held)
        val rate = currencyChoices.firstOrNull { it.first == form.currency }?.second
        val issues = mutableListOf<String>()
        val edit = screen.mode == TallyEditorState.Mode.MODE_EDIT

        if (form.description.isBlank()) issues += TallyCopy.DESCRIPTION_MISSING

        // THE AMOUNT, in the money it was typed in, then in the settlement money.
        val typedExponent = exponentOf(held, form.currency)
        var total: Long? = null
        var original: Long? = null
        if (typedExponent == null || settlementExponent == null) {
            issues += TallyCopy.CURRENCY_UNKNOWN
        } else {
            val typed = TallySplit.parseAmount(form.amount_text, typedExponent)
            when {
                typed == null || typed <= 0 -> issues += TallyCopy.AMOUNT_MISSING
                rate == null -> total = typed
                else -> {
                    original = typed
                    total = TallySplit.convert(typed, rate.rate_scaled, rate.rate_scale.toInt())
                    if (total == null) issues += TallyCopy.TOO_LARGE
                }
            }
        }

        val parties = roster.map { it.party_id }.toSet()
        if (form.payer_id !in parties) issues += TallyCopy.PAYER_MISSING

        val outcome = if (total != null && settlementExponent != null) {
            TallySplit.divide(
                form.method,
                total,
                settlementExponent,
                form.payer_id,
                form.entries.map { TallySplit.Entry(it.person?.party_id ?: "", it.included, it.text) },
                form.lines.map { TallySplit.Line(it.line_key, it.description, it.amount_text, it.party_ids) },
            )
        } else {
            null
        }
        // THE DIVISION'S PROBLEM IS THE RECONCILE LINE'S, said there once.

        fun money(minor: Long): Money = Money(minor = minor, currency = settlement, exponent = settlementExponent ?: 0)
        val unit = when (form.method) {
            TallySplitMethod.TALLY_SPLIT_METHOD_PERCENTAGES -> TallyCopy.UNIT_PERCENT
            TallySplitMethod.TALLY_SPLIT_METHOD_SHARES -> TallyCopy.UNIT_SHARES
            TallySplitMethod.TALLY_SPLIT_METHOD_ADJUSTED -> "± $settlement"
            TallySplitMethod.TALLY_SPLIT_METHOD_EXACT -> settlement
            else -> ""
        }
        val entries = form.entries.map { entry ->
            val party = entry.person?.party_id ?: ""
            entry.copy(
                unit_label = unit,
                share = outcome?.shares?.get(party)?.let(::money),
                issue = outcome?.issues?.get(party) ?: "",
            )
        }
        val lines = form.lines.map { it.copy(issue = outcome?.issues?.get(it.line_key) ?: "") }
        val writing = screen.write?.phase == WriteState.Phase.PHASE_IN_FLIGHT
        val canSave = issues.isEmpty() && !writing && screen.baseline != null && outcome?.problem == null
        val input = if (canSave && total != null) input(held, form, total, original, rate, outcome!!, settlementExponent ?: 0) else null

        val day = dashboard.today
        val dates = listOf(dashboard.today, dashboard.yesterday, form.spent_on).filter { it.isNotEmpty() }.distinct()
        val groups = dashboard.groups
        val data = TallyEditorData(
            payers = roster.map {
                TallyChoice(key = it.party_id, label = it.name, selected = it.party_id == form.payer_id, enabled = true, hue = it.hue)
            },
            groups = listOf(
                TallyChoice(key = "", label = TallyCopy.NO_GROUP_LABEL, selected = form.group_id.isEmpty(), enabled = !edit),
            ) + groups.map {
                TallyChoice(key = it.group_id, label = it.name, selected = it.group_id == form.group_id, enabled = !edit, hue = it.color)
            },
            categories = TallyFold.CATEGORIES.map {
                TallyChoice(key = it, label = TallyFold.categoryLabel(it), selected = it == form.category, enabled = true)
            },
            dates = dates.map {
                TallyChoice(key = it, label = TallyFold.day(it, day), selected = it == form.spent_on, enabled = true)
            },
            currencies = currencyChoices.map { (code, _) ->
                TallyChoice(key = code, label = code, selected = code == form.currency, enabled = true)
            },
            methods = METHODS.map {
                TallyChoice(
                    key = TallySplit.methodKey(it),
                    label = TallySplit.methodLabel(it),
                    selected = it == form.method,
                    enabled = true,
                    method = it,
                )
            },
            reconcile_line = outcome?.problem ?: TallySplit.rule(form.method),
            reconcile_problem = outcome?.problem != null,
            total = total?.let(::money),
            rate_line = rate?.let {
                "1 ${it.from_currency} = ${TallySplit.decimal(it.rate_scaled, it.rate_scale.toInt())} ${it.to_currency} · " +
                    "${TallyCopy.RATE_REMEMBERED} ${TallyFold.day(it.observed_on, null)}"
            } ?: "",
            issues = issues,
            can_save = canSave,
            currency_locked = edit,
            remaining = outcome?.remaining?.let { money(if (it < 0) -it else it) },
            remaining_label = when {
                outcome?.remaining == null -> ""
                outcome.remaining > 0 -> TallyCopy.REMAINING_LEFT
                else -> TallyCopy.REMAINING_OVER
            },
        )
        return Evaluation(data = data, entries = entries, lines = lines, input = input)
    }

    /** The command's input, in the vault's shape. */
    private fun input(
        held: TallyHeld<TallyEditorState>,
        form: TallyExpenseForm,
        total: Long,
        original: Long?,
        rate: TallyRateSuggestion?,
        outcome: TallySplit.Outcome,
        exponent: Int,
    ): String {
        val edit = held.screen.mode == TallyEditorState.Mode.MODE_EDIT
        val fields = mutableListOf<String>()
        fun field(name: String, json: String) {
            fields += "${jsonString(name)}:$json"
        }
        if (edit) field("expense_id", jsonString(held.screen.expense_id))
        field("description", jsonString(form.description.trim()))
        field("amount_minor", total.toString())
        field("paid_by", jsonString(form.payer_id))
        field("category", jsonString(form.category))
        if (form.spent_on.isNotEmpty()) field("spent_on", jsonString(form.spent_on))
        field("split_method", jsonString(TallySplit.methodKey(form.method)))
        field(
            "splits",
            outcome.shares.entries.joinToString(",", "[", "]") {
                "{\"party_id\":${jsonString(it.key)},\"share_minor\":${it.value}}"
            },
        )
        params(form, exponent)?.let { field("split_params", it) }
        if (form.method == TallySplitMethod.TALLY_SPLIT_METHOD_BY_LINE) {
            field(
                "line_items",
                outcome.lines.joinToString(",", "[", "]") { line ->
                    "{\"kind\":\"item\",\"description\":${jsonString(line.description)},\"amount_minor\":${line.amount}," +
                        "\"allocations\":" +
                        line.allocations.joinToString(",", "[", "]") { (party, share) ->
                            "{\"party_id\":${jsonString(party)},\"share_minor\":$share}"
                        } + "}"
                },
            )
        }
        if (!edit) {
            if (form.group_id.isNotEmpty()) field("group_id", jsonString(form.group_id))
            if (rate != null && original != null) {
                field("original_amount_minor", original.toString())
                field("original_currency", jsonString(rate.from_currency))
                field("settlement_currency", jsonString(rate.to_currency))
                field("rate_scaled", rate.rate_scaled.toString())
                field("rate_scale", rate.rate_scale.toString())
                field("rate_source", jsonString(rate.rate_source.ifEmpty { TallyCopy.RATE_SOURCE_REMEMBERED }))
                field("rate_date", jsonString(rate.observed_on))
            }
        }
        return fields.joinToString(",", "{", "}")
    }

    /**
     * WHAT WAS TYPED, kept so an edit re-opens the way it was entered
     * (`TallySplitParams`): provenance, never a second arithmetic path.
     */
    private fun params(form: TallyExpenseForm, exponent: Int): String? {
        val unit = when (form.method) {
            TallySplitMethod.TALLY_SPLIT_METHOD_PERCENTAGES -> "percent"
            TallySplitMethod.TALLY_SPLIT_METHOD_SHARES -> "shares"
            TallySplitMethod.TALLY_SPLIT_METHOD_ADJUSTED -> "adjust"
            else -> return null
        }
        val typed = form.entries.filter { it.included && it.text.isNotBlank() }.mapNotNull { entry ->
            val party = entry.person?.party_id ?: return@mapNotNull null
            val value = if (unit == "adjust") {
                TallySplit.parseAmount(entry.text, exponent, signed = true)?.toString()
            } else {
                TallySplit.parseHundredths(entry.text)?.let(TallySplit::hundredths)
            }
            value?.let { "${jsonString(party)}:$it" }
        }
        return "{\"unit\":${jsonString(unit)},\"entries\":${typed.joinToString(",", "{", "}")}}"
    }

    // -----------------------------------------------------------------
    // Save
    // -----------------------------------------------------------------

    private fun save(held: TallyHeld<TallyEditorState>): Step<TallyHeld<TallyEditorState>> {
        val evaluation = evaluate(held) ?: return Step(held)
        val input = evaluation.input ?: return refold(held)
        val edit = held.screen.mode == TallyEditorState.Mode.MODE_EDIT
        val command = if (edit) EDIT_COMMAND else ADD_COMMAND
        val subject = if (edit) held.screen.expense_id else "new"
        // ONE KEY PER SITTING AND PER CONTENT: a double tap is one expense;
        // the same expense saved in another sitting is a new one.
        val key = InvokeKeys.of(command, subject, held.screen.draft_token, input.hashCode().toUInt().toString(HEX))
        val step = WriteLaw.submit(Writes, held, command, input, key)
        return Step(refold(step.state).state, step.effects)
    }

    override fun settled(held: TallyHeld<TallyEditorState>, settled: WriteSettled): Step<TallyHeld<TallyEditorState>> {
        val step = WriteLaw.settled(Writes, held, settled)
        val done = step.state.screen.write?.phase == WriteState.Phase.PHASE_COMMITTED
        val next = if (done) step.state.copy(screen = step.state.screen.copy(done = true)) else step.state
        return Step(refold(next).state, step.effects)
    }

    // -----------------------------------------------------------------
    // What every state carries
    // -----------------------------------------------------------------

    override fun decorate(held: TallyHeld<TallyEditorState>): TallyEditorState {
        val screen = held.screen
        val edit = screen.mode == TallyEditorState.Mode.MODE_EDIT
        val chrome = CHROME.copy(
            title = if (edit) TallyCopy.EDIT_HEAD else TallyCopy.ADD_HEAD,
            save = if (edit) TallyCopy.EDIT_COMMIT else TallyCopy.ADD_COMMIT,
        )
        val form = screen.form ?: return screen.copy(chrome = chrome)
        // THE ENTRIES CARRY THEIR SHARES AND ISSUES, recomputed every step.
        val evaluation = if (lens.content(screen) is ReadContent.Data) evaluate(held) else null
        val shown = if (evaluation == null) form else form.copy(entries = evaluation.entries, lines = evaluation.lines)
        val baseline = screen.baseline
        return screen.copy(
            chrome = chrome,
            form = shown,
            dirty = baseline != null && truth(shown) != baseline,
        )
    }

    private val METHODS: List<TallySplitMethod> = listOf(
        TallySplitMethod.TALLY_SPLIT_METHOD_EQUALLY,
        TallySplitMethod.TALLY_SPLIT_METHOD_EXACT,
        TallySplitMethod.TALLY_SPLIT_METHOD_PERCENTAGES,
        TallySplitMethod.TALLY_SPLIT_METHOD_SHARES,
        TallySplitMethod.TALLY_SPLIT_METHOD_ADJUSTED,
        TallySplitMethod.TALLY_SPLIT_METHOD_BY_LINE,
    )

    private val CHROME: TallyEditorChrome = TallyEditorChrome(
        cancel = TallyCopy.CANCEL,
        retry = TallyCopy.RETRY,
        loading = TallyCopy.LOADING,
        description_key = TallyCopy.FIELD_DESCRIPTION,
        description_placeholder = TallyCopy.DESCRIPTION_PLACEHOLDER,
        amount_key = TallyCopy.FIELD_AMOUNT,
        payer_key = TallyCopy.FIELD_PAID_BY,
        group_key = TallyCopy.FIELD_GROUP,
        category_key = TallyCopy.FIELD_CATEGORY,
        date_key = TallyCopy.FIELD_DATE,
        currency_key = TallyCopy.FIELD_CURRENCY,
        method_key = TallyCopy.FIELD_DIVIDED,
        add_line = TallyCopy.ADD_LINE,
        remove_line = TallyCopy.REMOVE_LINE,
        line_placeholder = TallyCopy.LINE_PLACEHOLDER,
    )

    private const val HEX: Int = 16

    private object Writes : WriteLens<TallyHeld<TallyEditorState>> {
        override fun write(state: TallyHeld<TallyEditorState>): WriteState = state.screen.write ?: WriteState()

        override fun with(state: TallyHeld<TallyEditorState>, write: WriteState): TallyHeld<TallyEditorState> =
            state.copy(screen = state.screen.copy(write = write))
    }

    internal object Lens : ContentLens<TallyEditorState, TallyEditorData> {
        override fun content(state: TallyEditorState): ReadContent<TallyEditorData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: TallyEditorState, content: ReadContent<TallyEditorData>): TallyEditorState = when (content) {
            is ReadContent.Loading ->
                state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
            is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
            is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
            is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
        }
    }
}

/**
 * What the editor asks: the dashboard, the chosen group's roster, and on an
 * edit the expense.
 */
public object TallyEditorReads : TallyQueries<TallyEditorState, TallyEditorEvent>(
    screenId = TallyEditorMachine.SCREEN_ID,
    tables = TallyEditorMachine.tables,
    ask = { held, now ->
        val screen = held.screen
        val groupId = screen.form?.group_id ?: ""
        buildList {
            add(AppQueryRequest(tally_dashboard = TallyDashboardRequest(tz = now.zone)))
            if (groupId.isNotEmpty()) add(AppQueryRequest(tally_group = TallyGroupRequest(group_id = groupId)))
            if (screen.mode == TallyEditorState.Mode.MODE_EDIT && screen.expense_id.isNotEmpty()) {
                add(AppQueryRequest(tally_expense = TallyExpenseRequest(expense_id = screen.expense_id, tz = now.zone)))
            }
        }
    },
)
