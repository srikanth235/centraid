package dev.centraid.shared.apps.money

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.MoneyAccounts
import centraid.core.v1.MoneyAccountsRequest
import centraid.screen.v1.Confirm
import centraid.screen.v1.EmptyState
import centraid.screen.v1.Loading
import centraid.screen.v1.MoneyAccountEditor
import centraid.screen.v1.MoneyAccountRow
import centraid.screen.v1.MoneyAccountSection
import centraid.screen.v1.MoneyAccountsData
import centraid.screen.v1.MoneyAccountsEvent
import centraid.screen.v1.MoneyAccountsState
import centraid.screen.v1.MoneyFact
import centraid.screen.v1.MoneyPageChrome
import centraid.screen.v1.SeatState
import centraid.screen.v1.StatusChip
import centraid.screen.v1.StatusLine
import centraid.screen.v1.WriteSettled
import centraid.screen.v1.WriteState
import dev.centraid.design.copy.MoneyCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.InvokeKeys
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.kit.WriteLens
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.Step
import dev.centraid.shared.nav.ScreenIds

/**
 * ACCOUNTS (#1099): the places money sits, each with a balance worked out from
 * its opening amount and every line posted, and a statement's own balance kept
 * only as a checkpoint to compare against. One account, one currency: pounds and
 * dollars stay on separate lines and are never added. An account is added or
 * edited in a sheet (name, kind, whether it counts toward spending, the bank's
 * own account number so an OFX file finds it).
 *
 * THE BANK'S NUMBER IS NEVER SENT BACK (R-1119-2): the phone holds only its last
 * four digits, so the number is sent when typed and removed by its own action,
 * which asks first and sends `external_ref: null`. Saving with the field empty
 * keeps the number.
 */
public object MoneyAccountsMachine :
    MoneyQueryMachine<MoneyAccountsState, MoneyAccountsEvent, MoneyAccountsData>("money.accounts", MONEY_TABLES) {
    public const val SCREEN_ID: String = ScreenIds.MONEY_ACCOUNTS
    public const val CMD_ADD: String = "account.add"
    public const val CMD_EDIT: String = "account.edit"

    /** Closing is the archived flag, a shared verb: the sheet sends it beside the edit. */
    public const val CMD_CLOSE: String = "flag.set"
    public const val CMD_REOPEN: String = "flag.clear"
    private const val ARCHIVED: String = "archived"

    private const val PENDING_REMOVE_NUMBER: String = "remove_number"

    private val KINDS: List<Pair<String, String>> = listOf(
        "checking" to MoneyCopy.KIND_CHECKING,
        "savings" to MoneyCopy.KIND_SAVINGS,
        "credit_card" to MoneyCopy.KIND_CREDIT_CARD,
        "cash" to MoneyCopy.KIND_CASH,
    )

    override val lens: ContentLens<MoneyAccountsState, MoneyAccountsData> = Lens

    override fun blank(): MoneyAccountsState = MoneyAccountsState(
        write = WriteState(phase = WriteState.Phase.PHASE_IDLE),
        sheet = MoneyAccountsState.Sheet.SHEET_NONE,
        chrome = chrome(""),
    )

    override fun withSeat(screen: MoneyAccountsState, seat: SeatState): MoneyAccountsState = screen.copy(seat = seat)

    override fun view(held: MoneyHeld<MoneyAccountsState>, event: MoneyAccountsEvent): Step<MoneyHeld<MoneyAccountsState>> {
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
                        sheet = MoneyAccountsState.Sheet.SHEET_EDITOR,
                        status = null,
                        editor = MoneyAccountEditor(
                            mode = MoneyAccountEditor.Mode.MODE_ADD,
                            kind = KINDS.first().first,
                            on_budget = true,
                        ),
                    ),
                ),
            )

            event.account != null -> {
                val line = lines(held).firstOrNull { it.first.account_id == event.account.account_id } ?: return Step(held)
                Step(
                    held.copy(
                        screen = screen.copy(
                            sheet = MoneyAccountsState.Sheet.SHEET_EDITOR,
                            status = null,
                            editor = MoneyAccountEditor(
                                mode = MoneyAccountEditor.Mode.MODE_EDIT,
                                account_id = line.first.account_id,
                                name = line.first.name,
                                kind = line.first.kind,
                                currency = line.first.currency,
                                on_budget = line.second,
                                closed = line.first.closed,
                                has_external_ref = line.first.mask != null,
                            ),
                        ),
                    ),
                )
            }

            event.confirm_dismissed != null -> Step(held.copy(screen = screen.copy(confirm = null, pending = "")))

            event.confirm_accepted != null && screen.confirm != null -> confirmed(held)

            editor == null -> Step(held)

            // ASK FIRST: removing the number is the one edit the member cannot see to undo.
            event.remove_number != null && editor.mode == MoneyAccountEditor.Mode.MODE_EDIT && editor.has_external_ref ->
                Step(held.copy(screen = screen.copy(confirm = removeNumberConfirm(), pending = PENDING_REMOVE_NUMBER)))

            event.name != null -> Step(held.copy(screen = screen.copy(editor = editor.copy(name = event.name.text))))
            event.kind_picked != null -> Step(held.copy(screen = screen.copy(editor = editor.copy(kind = event.kind_picked.kind))))
            event.currency != null ->
                Step(held.copy(screen = screen.copy(editor = editor.copy(currency = event.currency.text.uppercase().take(CURRENCY_LENGTH)))))
            event.on_budget != null -> Step(held.copy(screen = screen.copy(editor = editor.copy(on_budget = !editor.on_budget))))
            event.external_ref != null ->
                Step(held.copy(screen = screen.copy(editor = editor.copy(external_ref = event.external_ref.text))))
            event.closed != null -> Step(held.copy(screen = screen.copy(editor = editor.copy(closed = !editor.closed))))
            event.sheet_closed != null ->
                Step(held.copy(screen = screen.copy(sheet = MoneyAccountsState.Sheet.SHEET_NONE, editor = null)))
            event.save != null -> save(held, editor)
            else -> Step(held)
        }
    }

    /** Every account line with whether it counts toward spending. */
    private fun lines(held: MoneyHeld<MoneyAccountsState>): List<Pair<MoneyAccounts.AccountLine, Boolean>> =
        held.answers.accounts?.on_budget.orEmpty().map { it to true } +
            held.answers.accounts?.off_budget.orEmpty().map { it to false }

    private fun removeNumberConfirm(): Confirm = Confirm(
        title = MoneyCopy.ACCOUNT_REMOVE_NUMBER_TITLE,
        body = MoneyCopy.ACCOUNT_REMOVE_NUMBER_BODY,
        confirm_label = MoneyCopy.ACCOUNT_REMOVE_NUMBER_CONFIRM,
        destructive = true,
    )

    private fun confirmed(held: MoneyHeld<MoneyAccountsState>): Step<MoneyHeld<MoneyAccountsState>> {
        val screen = held.screen
        val editor = screen.editor
        val cleared = held.copy(screen = screen.copy(confirm = null, pending = ""))
        if (screen.pending != PENDING_REMOVE_NUMBER || editor == null || editor.account_id.isEmpty()) return Step(cleared)
        // ONLY THE NUMBER: the rest of the sheet is unsaved typing, and stays unsent.
        val input = MoneyFold.json(
            "id" to MoneyFold.str(editor.account_id),
            "external_ref" to "null",
        )
        val key = InvokeKeys.of(CMD_EDIT, editor.account_id, INTENT_REMOVE_NUMBER, (held.tokens + 1).toString())
        return WriteLaw.submit(Writes, cleared.copy(tokens = held.tokens + 1), CMD_EDIT, input, key)
    }

    private fun check(held: MoneyHeld<MoneyAccountsState>, editor: MoneyAccountEditor): MoneyAccountEditor {
        val issue = when {
            editor.name.isBlank() -> MoneyCopy.ACCOUNT_NAME_MISSING
            editor.mode == MoneyAccountEditor.Mode.MODE_ADD && editor.currency.isNotEmpty() &&
                (editor.currency.length != CURRENCY_LENGTH || !editor.currency.all { it in 'A'..'Z' }) -> MoneyCopy.ACCOUNT_CURRENCY_INVALID
            else -> ""
        }
        val add = editor.mode == MoneyAccountEditor.Mode.MODE_ADD
        val removable = !add && editor.has_external_ref
        return editor.copy(
            can_save = issue.isEmpty(),
            issue = issue,
            title = if (add) MoneyCopy.ACCOUNT_ADD_TITLE else MoneyCopy.ACCOUNT_EDIT_TITLE,
            save_label = if (add) MoneyCopy.ACCOUNT_ADD_SAVE else MoneyCopy.SAVE,
            name_label = MoneyCopy.ACCOUNT_NAME,
            kind_label = MoneyCopy.ACCOUNT_KIND,
            kind_options = KINDS.map { (key, label) -> MoneyFold.choice(key, label, key == editor.kind) },
            currency_label = if (add) MoneyCopy.ACCOUNT_CURRENCY else "",
            on_budget_label = MoneyCopy.ACCOUNT_ON_BUDGET,
            external_ref_label = MoneyCopy.ACCOUNT_NUMBER,
            external_ref_note = if (add) MoneyCopy.ACCOUNT_NUMBER_NOTE else MoneyCopy.ACCOUNT_NUMBER_EDIT_NOTE,
            closed_label = if (add) "" else MoneyCopy.ACCOUNT_CLOSED,
            cancel_label = MoneyCopy.CANCEL,
            remove_number_label = if (removable) MoneyCopy.ACCOUNT_REMOVE_NUMBER else "",
            can_remove_number = removable && held.screen.write?.phase != WriteState.Phase.PHASE_IN_FLIGHT,
        )
    }

    private fun save(held: MoneyHeld<MoneyAccountsState>, editor: MoneyAccountEditor): Step<MoneyHeld<MoneyAccountsState>> {
        val checked = check(held, editor)
        if (!checked.can_save) return Step(held.copy(screen = held.screen.copy(editor = checked)))
        val number = checked.external_ref.trim().ifEmpty { null }
        val screen = held.screen
        if (checked.mode == MoneyAccountEditor.Mode.MODE_ADD) {
            val id = "account-${screen.draft_token}-${held.tokens + 1}"
            val input = MoneyFold.json(
                "id" to MoneyFold.str(id),
                "title" to MoneyFold.str(checked.name.trim()),
                "type" to MoneyFold.str(checked.kind),
                "currency" to checked.currency.takeIf { it.isNotEmpty() }?.let(MoneyFold::str),
                "on_budget" to checked.on_budget.toString(),
                "external_ref" to number?.let(MoneyFold::str),
            )
            return WriteLaw.submit(Writes, held.copy(tokens = held.tokens + 1), CMD_ADD, input, InvokeKeys.of(CMD_ADD, id))
        }
        val before = lines(held).firstOrNull { it.first.account_id == checked.account_id }
        val closedChanged = before != null && before.first.closed != checked.closed
        val input = MoneyFold.json(
            "id" to MoneyFold.str(checked.account_id),
            "title" to MoneyFold.str(checked.name.trim()),
            "type" to MoneyFold.str(checked.kind),
            "on_budget" to checked.on_budget.toString(),
            "external_ref" to number?.let(MoneyFold::str),
        )
        val key = InvokeKeys.of(CMD_EDIT, checked.account_id, (held.tokens + 1).toString())
        val step = WriteLaw.submit(Writes, held.copy(tokens = held.tokens + 1), CMD_EDIT, input, key)
        if (!closedChanged) return step
        // A closed account is the archived flag on it: its own command, sent beside the edit.
        val flag = MoneyFold.json("id" to MoneyFold.str(checked.account_id), "flag" to MoneyFold.str(ARCHIVED))
        val close = if (checked.closed) CMD_CLOSE else CMD_REOPEN
        return Step(
            step.state,
            step.effects + ScreenEffect.SubmitWrite(close, flag, InvokeKeys.of(close, checked.account_id, (held.tokens + 1).toString())),
        )
    }

    override fun settled(held: MoneyHeld<MoneyAccountsState>, settled: WriteSettled): Step<MoneyHeld<MoneyAccountsState>> {
        val step = WriteLaw.settled(Writes, held, settled)
        if (step.state === held) return step
        val screen = step.state.screen
        return if (settled.committed) {
            // SAVED: the sheet goes, and the change event reads the list again.
            val removed = settled.invoke_key.split(':').getOrNull(2) == INTENT_REMOVE_NUMBER
            Step(
                step.state.copy(
                    screen = screen.copy(
                        sheet = MoneyAccountsState.Sheet.SHEET_NONE,
                        editor = null,
                        status = StatusLine(sentence = if (removed) MoneyCopy.ACCOUNT_NUMBER_REMOVED else MoneyCopy.DONE_ACCOUNT),
                    ),
                ),
                step.effects,
            )
        } else {
            Step(
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
    }

    override fun fold(held: MoneyHeld<MoneyAccountsState>): MoneyAccountsData? {
        val answer = held.answers.accounts ?: return null
        fun row(line: MoneyAccounts.AccountLine): MoneyAccountRow {
            val checkpoint = line.checkpoint
            val kindWord = KINDS.firstOrNull { it.first == line.kind }?.second.orEmpty()
            val meta = listOfNotNull(
                line.mask?.let { "····$it" },
                kindWord.ifEmpty { null },
                line.currency,
                if (line.closed) MoneyCopy.ACCOUNT_CLOSED_META else null,
            ).joinToString(" · ")
            val (words, tone) = when {
                checkpoint == null -> MoneyCopy.CHECKPOINT_NONE to StatusChip.Tone.TONE_SEAM
                checkpoint.agrees -> MoneyFold.fill(MoneyCopy.CHECKPOINT_MATCHES, "day" to MoneyFold.dayShort(checkpoint.as_of)) to StatusChip.Tone.TONE_NEUTRAL
                else -> MoneyFold.fill(MoneyCopy.CHECKPOINT_OFF, "day" to MoneyFold.dayShort(checkpoint.as_of)) to StatusChip.Tone.TONE_WARNING
            }
            return MoneyAccountRow(
                account_id = line.account_id,
                name = line.name,
                meta = meta,
                has_balance = line.balance != null,
                balance = MoneyFold.money(line.balance),
                balance_note = if (line.balance == null) MoneyCopy.BALANCE_UNKNOWN else "",
                checkpoint_line = words,
                has_delta = checkpoint != null && !checkpoint.agrees,
                delta = MoneyFold.money(checkpoint?.delta),
                checkpoint_tone = tone,
                accessibility_label = listOf(line.name, meta, words).filter { it.isNotEmpty() }.joinToString(", "),
            )
        }
        val sections = listOfNotNull(
            answer.on_budget.takeIf { it.isNotEmpty() }?.let { MoneyAccountSection(title = MoneyCopy.ON_BUDGET, rows = it.map(::row)) },
            answer.off_budget.takeIf { it.isNotEmpty() }?.let { MoneyAccountSection(title = MoneyCopy.OFF_BUDGET, rows = it.map(::row)) },
        )
        return MoneyAccountsData(
            sections = sections,
            net_worth_label = if (answer.net_worth.isNotEmpty()) MoneyCopy.NET_WORTH else "",
            net_worth = answer.net_worth.map { line ->
                MoneyFold.figure(
                    if (line.complete) line.amount?.currency.orEmpty() else "${line.amount?.currency.orEmpty()} · ${MoneyCopy.INCOMPLETE}",
                    line.amount,
                    MoneyFold.signTone(line.amount),
                )
            },
            net_worth_note = if (answer.net_worth.size > 1) MoneyCopy.NET_WORTH_NOTE else "",
            empty = if (sections.isEmpty()) {
                EmptyState(headline = MoneyCopy.ACCOUNTS_EMPTY, action_label = MoneyCopy.ADD_ACCOUNT)
            } else {
                null
            },
            add_label = MoneyCopy.ADD_ACCOUNT,
            definitions = answer.definitions.mapNotNull(MoneyFold::definition).map { MoneyFact(label = it.first, detail = it.second) },
        )
    }

    override fun decorate(held: MoneyHeld<MoneyAccountsState>): MoneyAccountsState {
        val screen = held.screen
        return screen.copy(editor = screen.editor?.let { check(held, it) })
    }

    private fun chrome(parent: String): MoneyPageChrome = MoneyPageChrome(
        title = MoneyCopy.ACCOUNTS_TITLE,
        back_label = parent.ifEmpty { MoneyCopy.APP_TITLE },
        retry = MoneyCopy.RETRY,
    )

    private const val CURRENCY_LENGTH: Int = 3
    private const val INTENT_REMOVE_NUMBER: String = "number"

    private object Writes : WriteLens<MoneyHeld<MoneyAccountsState>> {
        override fun write(state: MoneyHeld<MoneyAccountsState>): WriteState = state.screen.write ?: WriteState()

        override fun with(state: MoneyHeld<MoneyAccountsState>, write: WriteState): MoneyHeld<MoneyAccountsState> =
            state.copy(screen = state.screen.copy(write = write))
    }

    internal object Lens : ContentLens<MoneyAccountsState, MoneyAccountsData> {
        override fun content(state: MoneyAccountsState): ReadContent<MoneyAccountsData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: MoneyAccountsState, content: ReadContent<MoneyAccountsData>): MoneyAccountsState = when (content) {
            is ReadContent.Loading -> state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
            is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
            is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
            is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
        }
    }
}

public object MoneyAccountsReads : MoneyQueries<MoneyAccountsState, MoneyAccountsEvent>(
    screenId = MoneyAccountsMachine.SCREEN_ID,
    tables = MONEY_TABLES,
    ask = { _, now -> listOf(AppQueryRequest(money_accounts = MoneyAccountsRequest(tz = now.zone))) },
)
