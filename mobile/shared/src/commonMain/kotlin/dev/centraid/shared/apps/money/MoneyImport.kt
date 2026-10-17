package dev.centraid.shared.apps.money

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.Envelope
import centraid.core.v1.MoneyAccountsRequest
import centraid.core.v1.MoneyDateOrder
import centraid.core.v1.MoneyImportPlan
import centraid.core.v1.MoneyImportPlanRequest
import centraid.core.v1.MoneyImportPlanRow
import centraid.core.v1.MoneyImportVerdict
import centraid.core.v1.MoneyImportWarning
import centraid.core.v1.MoneyRequest
import centraid.core.v1.MoneySignChoice
import centraid.core.v1.MoneySource
import centraid.core.v1.MoneyStatementPlan
import centraid.core.v1.Request
import centraid.screen.v1.EmptyState
import centraid.screen.v1.Loading
import centraid.screen.v1.MoneyFact
import centraid.screen.v1.MoneyFigure
import centraid.screen.v1.MoneyImportData
import centraid.screen.v1.MoneyImportEvent
import centraid.screen.v1.MoneyImportLine
import centraid.screen.v1.MoneyImportQuestion
import centraid.screen.v1.MoneyImportState
import centraid.screen.v1.MoneyImportStatement
import centraid.screen.v1.MoneyPageChrome
import centraid.screen.v1.SeatState
import centraid.screen.v1.StatusChip
import centraid.screen.v1.StatusLine
import centraid.screen.v1.WriteSettled
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import dev.centraid.design.copy.MoneyCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.InvokeKeys
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.Step
import dev.centraid.shared.sync.sentenceFor
import okio.ByteString.Companion.toByteString

/**
 * IMPORT A STATEMENT (#1099): pick a file, read the plan, publish. Nothing is
 * written until the last button.
 *
 * The file's bytes are held Kotlin-side ([MoneyHeld.file]) while the core plans
 * them and are dropped when the page is left, on Start over, and once the rows
 * are in: statement bytes are never stored. The plan is the core's
 * ([MoneyHeld.plan]); a drawn state carries its rows and sentences only.
 *
 * A CSV needs its account, an OFX file finds its own. The plan can ask one
 * question (a date order the file cannot answer) and offer one override (which
 * sign means money out); each answer plans the same file again. A row proposed
 * as a duplicate is skipped unless the member says otherwise. PUBLISHING IS THE
 * ORDINARY COMMAND, `money.import_transactions`, with the plan's own
 * `publish_input` unchanged, one statement at a time; a CSV's layout is
 * remembered only after every one has committed.
 */
public object MoneyImportMachine :
    MoneyQueryMachine<MoneyImportState, MoneyImportEvent, MoneyImportData>("money.import", MONEY_TABLES) {
    public const val SCREEN_ID: String = "money.import"
    public const val CMD_IMPORT: String = "money.import_transactions"
    public const val CMD_PROFILE: String = "money.save_import_profile"

    /** Rows of each kind drawn under a statement; the rest are counted. */
    private const val SHOWN_ROWS: Int = 25
    private const val SHOWN_NEW: Int = 10

    override val lens: ContentLens<MoneyImportState, MoneyImportData> = Lens

    override fun blank(): MoneyImportState = MoneyImportState(
        phase = MoneyImportState.Phase.PHASE_IDLE,
        sheet = MoneyImportState.Sheet.SHEET_NONE,
        chrome = chrome(""),
    )

    override fun withSeat(screen: MoneyImportState, seat: SeatState): MoneyImportState = screen.copy(seat = seat)

    /** What the file is: an OFX or QFX file by its name or its first bytes, else a CSV. */
    public fun sourceOf(file: MoneyFile): MoneySource {
        val name = file.name.lowercase()
        if (name.endsWith(".ofx") || name.endsWith(".qfx")) return MoneySource.MONEY_SOURCE_OFX
        val head = file.bytes.take(SNIFF).map { (it.toInt() and 0xFF).toChar() }.joinToString("").uppercase()
        return if (head.contains("OFXHEADER") || head.contains("<OFX>")) MoneySource.MONEY_SOURCE_OFX else MoneySource.MONEY_SOURCE_CSV
    }

    /** The plan the bridge asks the core for, out of what the page holds. */
    public fun askOf(held: MoneyHeld<MoneyImportState>): MoneyPlanAsk? {
        val file = held.file ?: return null
        val screen = held.screen
        return MoneyPlanAsk(
            source = sourceOf(file),
            accountId = screen.account_id.ifEmpty { null },
            dateOrder = when (screen.date_order) {
                MoneyImportState.DateOrder.DATE_ORDER_MDY -> MoneyDateOrder.MONEY_DATE_ORDER_MDY
                MoneyImportState.DateOrder.DATE_ORDER_DMY -> MoneyDateOrder.MONEY_DATE_ORDER_DMY
                else -> MoneyDateOrder.MONEY_DATE_ORDER_UNSPECIFIED
            },
            sign = when (screen.sign) {
                MoneyImportState.SignChoice.SIGN_CHOICE_DEBITS_NEGATIVE -> MoneySignChoice.MONEY_SIGN_CHOICE_DEBITS_NEGATIVE
                MoneyImportState.SignChoice.SIGN_CHOICE_DEBITS_POSITIVE -> MoneySignChoice.MONEY_SIGN_CHOICE_DEBITS_POSITIVE
                else -> MoneySignChoice.MONEY_SIGN_CHOICE_UNSPECIFIED
            },
        )
    }

    override fun view(held: MoneyHeld<MoneyImportState>, event: MoneyImportEvent): Step<MoneyHeld<MoneyImportState>> {
        val screen = held.screen
        val phase = screen.phase
        val busy = phase == MoneyImportState.Phase.PHASE_READING || phase == MoneyImportState.Phase.PHASE_PUBLISHING
        return when {
            event.opened != null -> reload(
                MoneyHeld(
                    screen = blank().copy(
                        seat = screen.seat,
                        chrome = chrome(event.opened.parent),
                        draft_token = event.opened.draft_token,
                    ),
                    tokens = held.tokens,
                ),
            )

            event.refreshed != null -> read(overRows(held))

            event.account_sheet_opened != null && !busy ->
                Step(held.copy(screen = screen.copy(sheet = MoneyImportState.Sheet.SHEET_ACCOUNT)))

            event.sheet_closed != null -> Step(held.copy(screen = screen.copy(sheet = MoneyImportState.Sheet.SHEET_NONE)))

            event.account_picked != null && !busy ->
                plan(held.copy(screen = screen.copy(account_id = event.account_picked.account_id, sheet = MoneyImportState.Sheet.SHEET_NONE)))

            event.date_order != null && !busy -> plan(
                held.copy(
                    screen = screen.copy(
                        date_order = when (event.date_order.order) {
                            "mdy" -> MoneyImportState.DateOrder.DATE_ORDER_MDY
                            "dmy" -> MoneyImportState.DateOrder.DATE_ORDER_DMY
                            else -> screen.date_order
                        },
                    ),
                ),
            )

            event.sign != null && !busy -> plan(
                held.copy(
                    screen = screen.copy(
                        sign = when (event.sign.choice) {
                            "debits_negative" -> MoneyImportState.SignChoice.SIGN_CHOICE_DEBITS_NEGATIVE
                            "debits_positive" -> MoneyImportState.SignChoice.SIGN_CHOICE_DEBITS_POSITIVE
                            else -> screen.sign
                        },
                    ),
                ),
            )

            event.keep_proposed != null && phase == MoneyImportState.Phase.PHASE_PLANNED ->
                refold(held.copy(screen = screen.copy(keep_proposed = !screen.keep_proposed)))

            event.publish != null && phase == MoneyImportState.Phase.PHASE_PLANNED -> publish(held)

            event.discard != null && !busy -> refold(drop(held).copy(screen = dropped(screen)))

            // LEAVING DROPS THE FILE; a write under way still lands.
            event.left != null && phase != MoneyImportState.Phase.PHASE_PUBLISHING ->
                refold(drop(held).copy(screen = dropped(screen).copy(status = null)))

            // `choose`, `add_account` and `done` are INTENTS the shell routes.
            else -> Step(held)
        }
    }

    override fun left(): MoneyInput<MoneyImportEvent> =
        MoneyInput.View(MoneyImportEvent(left = MoneyImportEvent.Left()))

    /** The file and the plan are gone; nothing the page held about them stays. */
    private fun drop(held: MoneyHeld<MoneyImportState>): MoneyHeld<MoneyImportState> =
        held.copy(file = null, plan = null, job = null, pending = emptyList())

    private fun dropped(screen: MoneyImportState): MoneyImportState = screen.copy(
        phase = MoneyImportState.Phase.PHASE_IDLE,
        status = null,
        date_order = MoneyImportState.DateOrder.DATE_ORDER_UNSPECIFIED,
        sign = MoneyImportState.SignChoice.SIGN_CHOICE_UNSPECIFIED,
        keep_proposed = false,
        sheet = MoneyImportState.Sheet.SHEET_NONE,
    )

    override fun picked(held: MoneyHeld<MoneyImportState>, input: MoneyInput.Picked): Step<MoneyHeld<MoneyImportState>> {
        val phase = held.screen.phase
        if (phase == MoneyImportState.Phase.PHASE_READING || phase == MoneyImportState.Phase.PHASE_PUBLISHING) return Step(held)
        val file = MoneyFile(input.name, input.bytes)
        val accounts = openAccounts(held)
        // THE ONLY ACCOUNT IS THE ACCOUNT: a vault with one has nothing to ask.
        val account = held.screen.account_id.ifEmpty { accounts.singleOrNull()?.account_id.orEmpty() }
        return plan(
            held.copy(
                file = file,
                plan = null,
                screen = dropped(held.screen).copy(account_id = account),
            ),
        )
    }

    /** Plan the held file again with the answers given so far, or wait for the account a CSV needs. */
    private fun plan(held: MoneyHeld<MoneyImportState>): Step<MoneyHeld<MoneyImportState>> {
        val file = held.file ?: return refold(held)
        val needsAccount = sourceOf(file) == MoneySource.MONEY_SOURCE_CSV && held.screen.account_id.isEmpty()
        if (needsAccount) {
            return refold(
                held.copy(
                    plan = null,
                    job = null,
                    screen = held.screen.copy(
                        phase = MoneyImportState.Phase.PHASE_IDLE,
                        status = StatusLine(sentence = MoneyCopy.IMPORT_CHOOSE_ACCOUNT),
                    ),
                ),
            )
        }
        val token = held.tokens + 1
        return refold(
            held.copy(
                tokens = token,
                plan = null,
                job = MoneyJob(token),
                screen = held.screen.copy(phase = MoneyImportState.Phase.PHASE_READING, status = null),
            ),
        )
    }

    override fun planned(held: MoneyHeld<MoneyImportState>, input: MoneyInput.Planned): Step<MoneyHeld<MoneyImportState>> =
        when (val outcome = input.outcome) {
            is MoneyPlanOutcome.Unreachable -> refold(
                held.copy(
                    job = null,
                    plan = null,
                    screen = held.screen.copy(
                        phase = MoneyImportState.Phase.PHASE_IDLE,
                        status = StatusLine(sentence = outcome.sentence, refused = true),
                    ),
                ),
            )
            is MoneyPlanOutcome.Plan -> refold(
                held.copy(
                    job = null,
                    plan = outcome.plan,
                    screen = held.screen.copy(phase = MoneyImportState.Phase.PHASE_PLANNED, status = null),
                ),
            )
        }

    /** The commands a publish sends, in order: each statement's own input. */
    private fun inputs(plan: MoneyImportPlan?, keep: Boolean): List<String> =
        plan?.statements.orEmpty().mapNotNull { statement ->
            val withProposed = statement.publish_input_with_proposed
            val chosen = if (keep && withProposed.size > 0) withProposed else statement.publish_input
            chosen.utf8().takeIf { it.isNotEmpty() }
        }

    private fun publishKey(held: MoneyHeld<MoneyImportState>, token: Long): String =
        InvokeKeys.of(CMD_IMPORT, held.screen.draft_token, token.toString())

    private fun publish(held: MoneyHeld<MoneyImportState>): Step<MoneyHeld<MoneyImportState>> {
        val all = inputs(held.plan, held.screen.keep_proposed)
        val first = all.firstOrNull() ?: return Step(held)
        val token = held.tokens + 1
        val next = held.copy(
            tokens = token,
            pending = all.drop(1),
            screen = held.screen.copy(phase = MoneyImportState.Phase.PHASE_PUBLISHING, status = null),
        )
        return refold(next).let { step ->
            Step(step.state, step.effects + ScreenEffect.SubmitWrite(CMD_IMPORT, first, publishKey(held, token)))
        }
    }

    override fun settled(held: MoneyHeld<MoneyImportState>, settled: WriteSettled): Step<MoneyHeld<MoneyImportState>> {
        // ONLY THE LAST IMPORT WE SENT: the layout's save has its own key and no page state.
        if (held.screen.phase != MoneyImportState.Phase.PHASE_PUBLISHING || settled.invoke_key != publishKey(held, held.tokens)) {
            return Step(held)
        }
        if (!settled.committed) {
            // A REFUSED PUBLISH KEEPS THE PLAN, so Import can be tried again: rows already in write nothing.
            return refold(
                held.copy(
                    pending = emptyList(),
                    screen = held.screen.copy(
                        phase = MoneyImportState.Phase.PHASE_PLANNED,
                        status = StatusLine(
                            sentence = settled.failure?.sentence?.takeIf { it.isNotEmpty() } ?: MoneyCopy.IMPORT_FAILED,
                            refused = true,
                        ),
                    ),
                ),
            )
        }
        val more = held.pending.firstOrNull()
        if (more != null) {
            val token = held.tokens + 1
            val next = held.copy(tokens = token, pending = held.pending.drop(1))
            return Step(next, listOf(ScreenEffect.SubmitWrite(CMD_IMPORT, more, publishKey(held, token))))
        }
        // EVERY STATEMENT IS IN: the file is dropped, and a CSV's layout is remembered.
        val written = written(held)
        return refold(
            held.copy(
                file = held.file?.let { MoneyFile(it.name, ByteArray(0)) },
                pending = emptyList(),
                screen = held.screen.copy(
                    phase = MoneyImportState.Phase.PHASE_PUBLISHED,
                    status = StatusLine(sentence = MoneyFold.fill(MoneyCopy.IMPORT_DONE, "rows" to MoneyFold.count(written, MoneyCopy.ROW_ONE, MoneyCopy.ROW_MANY))),
                ),
            ),
        ).let { step -> Step(step.state, step.effects + profileSaves(held)) }
    }

    /** Rows a publish wrote, as the plan counted them. */
    private fun written(held: MoneyHeld<MoneyImportState>): Int =
        held.plan?.statements.orEmpty().sumOf { statement ->
            statement.new + if (held.screen.keep_proposed) statement.proposed_duplicates else 0
        }

    private fun profileSaves(held: MoneyHeld<MoneyImportState>): List<ScreenEffect> =
        held.plan?.statements.orEmpty().mapNotNull { statement ->
            val profile = statement.profile_to_save ?: return@mapNotNull null
            val account = statement.account_id ?: return@mapNotNull null
            val input = MoneyFold.json(
                "account_id" to MoneyFold.str(account),
                "header_fingerprint" to MoneyFold.str(profile.header_fingerprint),
                "delimiter" to MoneyFold.str(profile.delimiter),
                "skip_lines" to profile.skip_lines.toString(),
                "date_order" to MoneyFold.str(profile.date_order),
                "sign_mode" to MoneyFold.str(profile.sign_mode),
                "date_col" to profile.date_col.toString(),
                "amount_col" to profile.amount_col?.toString(),
                "debit_col" to profile.debit_col?.toString(),
                "credit_col" to profile.credit_col?.toString(),
                "desc_col" to profile.desc_col.toString(),
                "memo_col" to profile.memo_col?.toString(),
                "indicator_col" to profile.indicator_col?.toString(),
                "indicator_out_value" to profile.indicator_out_value?.let(MoneyFold::str),
            )
            ScreenEffect.SubmitWrite(CMD_PROFILE, input, InvokeKeys.of(CMD_PROFILE, account, held.screen.draft_token))
        }

    private fun openAccounts(held: MoneyHeld<MoneyImportState>): List<centraid.core.v1.MoneyAccounts.AccountLine> =
        (held.answers.accounts?.on_budget.orEmpty() + held.answers.accounts?.off_budget.orEmpty()).filter { !it.closed }

    // --- The fold -----------------------------------------------------------

    override fun fold(held: MoneyHeld<MoneyImportState>): MoneyImportData? {
        if (held.answers.accounts == null) return null
        val screen = held.screen
        val phase = screen.phase
        val accounts = openAccounts(held)
        val busy = phase == MoneyImportState.Phase.PHASE_READING || phase == MoneyImportState.Phase.PHASE_PUBLISHING
        val file = held.file
        val csv = file == null || sourceOf(file) == MoneySource.MONEY_SOURCE_CSV
        val chosen = accounts.firstOrNull { it.account_id == screen.account_id }
        val drawn = held.plan.takeIf {
            phase == MoneyImportState.Phase.PHASE_PLANNED ||
                phase == MoneyImportState.Phase.PHASE_PUBLISHING ||
                phase == MoneyImportState.Phase.PHASE_PUBLISHED
        }
        val publishable = if (phase == MoneyImportState.Phase.PHASE_PLANNED) publishable(held) else 0
        return MoneyImportData(
            lede = MoneyCopy.IMPORT_LEDE,
            file_label = MoneyCopy.IMPORT_FILE,
            file_value = file?.name ?: MoneyCopy.IMPORT_NO_FILE,
            file_note = when (phase) {
                MoneyImportState.Phase.PHASE_READING -> MoneyCopy.IMPORT_READING
                MoneyImportState.Phase.PHASE_PUBLISHING -> MoneyCopy.IMPORT_PUBLISHING
                MoneyImportState.Phase.PHASE_PUBLISHED -> MoneyCopy.IMPORT_DONE_NOTE
                else -> MoneyCopy.IMPORT_FILE_NOTE
            },
            choose_label = when {
                busy || accounts.isEmpty() -> ""
                phase == MoneyImportState.Phase.PHASE_PUBLISHED -> MoneyCopy.IMPORT_CHOOSE_ANOTHER
                file != null -> MoneyCopy.IMPORT_CHOOSE_ANOTHER
                else -> MoneyCopy.IMPORT_CHOOSE
            },
            account_label = MoneyCopy.IMPORT_ACCOUNT,
            account_value = chosen?.let { account -> listOfNotNull(account.name, account.mask?.let { "····$it" }).joinToString(" ") }
                ?: MoneyCopy.IMPORT_NO_ACCOUNT_CHOSEN,
            needs_account = csv,
            account_options = accounts.map {
                MoneyFold.choice(it.account_id, it.name, it.account_id == screen.account_id, it.mask?.let { mask -> "····$mask" }.orEmpty())
            },
            account_sheet_title = MoneyCopy.IMPORT_ACCOUNT_SHEET,
            refusal = drawn?.refusal.orEmpty(),
            statements = drawn?.statements.orEmpty().mapIndexed { index, statement ->
                statement(held, statement, index, drawn?.statements?.size ?: 1)
            },
            publish_label = if (publishable > 0) {
                MoneyFold.fill(MoneyCopy.IMPORT_PUBLISH, "rows" to MoneyFold.count(publishable, MoneyCopy.ROW_ONE, MoneyCopy.ROW_MANY))
            } else {
                ""
            },
            publish_note = if (publishable > 0) MoneyCopy.IMPORT_PUBLISH_NOTE else "",
            discard_label = if (phase == MoneyImportState.Phase.PHASE_PLANNED) MoneyCopy.IMPORT_DISCARD else "",
            done_label = if (phase == MoneyImportState.Phase.PHASE_PUBLISHED) MoneyCopy.DONE else "",
            empty = if (accounts.isEmpty()) {
                EmptyState(headline = MoneyCopy.IMPORT_NO_ACCOUNT, action_label = MoneyCopy.ADD_ACCOUNT)
            } else {
                null
            },
            add_account_label = MoneyCopy.ADD_ACCOUNT,
        )
    }

    private fun publishable(held: MoneyHeld<MoneyImportState>): Int =
        held.plan?.statements.orEmpty().sumOf { statement ->
            if (statement.question != null || statement.publish_input.size == 0) {
                0
            } else {
                statement.new + if (held.screen.keep_proposed) statement.proposed_duplicates else 0
            }
        }

    private fun statement(
        held: MoneyHeld<MoneyImportState>,
        statement: MoneyStatementPlan,
        index: Int,
        total: Int,
    ): MoneyImportStatement {
        val screen = held.screen
        val rows = statement.rows
        val proposed = rows.filter { it.verdict == MoneyImportVerdict.MONEY_IMPORT_VERDICT_PROPOSED_DUPLICATE }
        val rejected = rows.filter { it.verdict == MoneyImportVerdict.MONEY_IMPORT_VERDICT_REJECTED }
        val fresh = rows.filter { it.verdict == MoneyImportVerdict.MONEY_IMPORT_VERDICT_NEW }
        val shown = proposed.take(SHOWN_ROWS) + rejected.take(SHOWN_ROWS) + fresh.take(SHOWN_NEW)
        val more = buildList {
            if (proposed.size > SHOWN_ROWS) add(MoneyFold.fill(MoneyCopy.AND_MORE, "n" to (proposed.size - SHOWN_ROWS).toString()))
            if (rejected.size > SHOWN_ROWS) add(MoneyFold.fill(MoneyCopy.AND_MORE, "n" to (rejected.size - SHOWN_ROWS).toString()))
            if (fresh.size > SHOWN_NEW) add(MoneyFold.fill(MoneyCopy.AND_MORE, "n" to (fresh.size - SHOWN_NEW).toString()))
        }
        val question = statement.question?.let { q ->
            MoneyImportQuestion(
                prompt = MoneyCopy.DATE_ORDER_PROMPT,
                samples = q.samples,
                options = q.options.mapNotNull { option ->
                    when (option) {
                        MoneyDateOrder.MONEY_DATE_ORDER_MDY ->
                            MoneyFold.choice("mdy", MoneyCopy.DATE_ORDER_MDY, screen.date_order == MoneyImportState.DateOrder.DATE_ORDER_MDY)
                        MoneyDateOrder.MONEY_DATE_ORDER_DMY ->
                            MoneyFold.choice("dmy", MoneyCopy.DATE_ORDER_DMY, screen.date_order == MoneyImportState.DateOrder.DATE_ORDER_DMY)
                        else -> null
                    }
                },
            )
        }
        val signGuessed = MoneyImportWarning.MONEY_IMPORT_WARNING_SIGN_GUESSED in statement.warnings
        val counts = buildList {
            add(MoneyFact(MoneyCopy.COUNT_NEW, statement.new.toString()))
            add(MoneyFact(MoneyCopy.COUNT_ALREADY_IN, statement.already_in.toString()))
            // LINES OWED A LOOK carry the tone that says so while there are any:
            // "Check these" is the seam's, "Can't read" the net's.
            add(
                MoneyFact(
                    MoneyCopy.COUNT_CHECK,
                    statement.proposed_duplicates.toString(),
                    tone = if (statement.proposed_duplicates > 0) StatusChip.Tone.TONE_SEAM else StatusChip.Tone.TONE_UNSPECIFIED,
                ),
            )
            if (statement.repeats_in_file > 0) add(MoneyFact(MoneyCopy.COUNT_REPEATS, statement.repeats_in_file.toString()))
            add(
                MoneyFact(
                    MoneyCopy.COUNT_REJECTED,
                    statement.rejected.toString(),
                    tone = if (statement.rejected > 0) StatusChip.Tone.TONE_NET else StatusChip.Tone.TONE_UNSPECIFIED,
                ),
            )
        }
        return MoneyImportStatement(
            key = "statement:$index",
            title = statement.account_label ?: if (total > 1) MoneyFold.fill(MoneyCopy.STATEMENT_N, "n" to (index + 1).toString()) else MoneyCopy.STATEMENT,
            refusal = statement.statement_refusal.orEmpty(),
            span = MoneyFold.span(statement.first_day, statement.last_day),
            totals = if (statement.question == null && statement.statement_refusal == null) {
                listOf(
                    MoneyFold.figure(MoneyCopy.FILE_IN, statement.file_in),
                    MoneyFold.figure(MoneyCopy.FILE_OUT, statement.file_out, StatusChip.Tone.TONE_NET),
                )
            } else {
                emptyList()
            },
            counts = if (statement.question == null && statement.statement_refusal == null) counts else emptyList(),
            rows = shown.map { line(it) },
            more = more,
            question = question,
            warnings = statement.warnings.mapNotNull {
                when (it) {
                    MoneyImportWarning.MONEY_IMPORT_WARNING_PROFILE_CHANGED -> MoneyCopy.WARN_PROFILE_CHANGED
                    MoneyImportWarning.MONEY_IMPORT_WARNING_SIGN_GUESSED -> MoneyCopy.WARN_SIGN_GUESSED
                    else -> null
                }
            },
            sign_options = if (signGuessed) {
                listOf(
                    MoneyFold.choice("debits_negative", MoneyCopy.SIGN_NEGATIVE, screen.sign == MoneyImportState.SignChoice.SIGN_CHOICE_DEBITS_NEGATIVE),
                    MoneyFold.choice("debits_positive", MoneyCopy.SIGN_POSITIVE, screen.sign == MoneyImportState.SignChoice.SIGN_CHOICE_DEBITS_POSITIVE),
                )
            } else {
                emptyList()
            },
            sign_label = if (signGuessed) MoneyCopy.SIGN_LABEL else "",
            checkpoint = statement.checkpoint?.let { MoneyFigure(label = MoneyCopy.STATEMENT_BALANCE, amount = MoneyFold.money(it.balance)) },
            checkpoint_label = statement.checkpoint?.let { MoneyFold.fill(MoneyCopy.CHECKPOINT_AS_OF, "day" to MoneyFold.dayShort(it.as_of)) }.orEmpty(),
            keep_proposed_label = if (statement.proposed_duplicates > 0) MoneyCopy.KEEP_PROPOSED else "",
            has_proposed = statement.proposed_duplicates > 0,
        )
    }

    private fun line(row: MoneyImportPlanRow): MoneyImportLine {
        val verdict = row.verdict
        val (chip, tone) = when (verdict) {
            MoneyImportVerdict.MONEY_IMPORT_VERDICT_NEW -> MoneyCopy.CHIP_NEW to StatusChip.Tone.TONE_NEUTRAL
            MoneyImportVerdict.MONEY_IMPORT_VERDICT_ALREADY_IN -> MoneyCopy.CHIP_ALREADY_IN to StatusChip.Tone.TONE_SEAM
            MoneyImportVerdict.MONEY_IMPORT_VERDICT_PROPOSED_DUPLICATE -> MoneyCopy.CHIP_CHECK to StatusChip.Tone.TONE_WARNING
            MoneyImportVerdict.MONEY_IMPORT_VERDICT_REPEAT_IN_FILE -> MoneyCopy.CHIP_IN_FILE to StatusChip.Tone.TONE_SEAM
            else -> MoneyCopy.CHIP_CANT_READ to StatusChip.Tone.TONE_WARNING
        }
        val day = row.posted_on?.let(MoneyFold::dayShort).orEmpty()
        val title = row.display_name?.takeIf { it.isNotEmpty() } ?: row.description.orEmpty()
        val meta = when (verdict) {
            MoneyImportVerdict.MONEY_IMPORT_VERDICT_NEW ->
                listOf(day, row.category_label ?: MoneyCopy.NO_CATEGORY).filter { it.isNotEmpty() }.joinToString(" · ")
            MoneyImportVerdict.MONEY_IMPORT_VERDICT_PROPOSED_DUPLICATE ->
                listOf(day, MoneyCopy.LOOKS_ALIKE).filter { it.isNotEmpty() }.joinToString(" · ")
            MoneyImportVerdict.MONEY_IMPORT_VERDICT_REJECTED -> ""
            else -> day
        }
        return MoneyImportLine(
            key = "line:${row.line}",
            line_label = MoneyFold.fill(MoneyCopy.ROW_N, "n" to row.line.toString()),
            title = title,
            meta = meta,
            has_amount = row.amount != null,
            amount = MoneyFold.money(row.amount),
            chip = StatusChip(label = chip, tone = tone),
            reason = row.reason.orEmpty(),
            accessibility_label = listOf(title, meta, chip, row.reason.orEmpty()).filter { it.isNotEmpty() }.joinToString(", "),
        )
    }

    private fun chrome(parent: String): MoneyPageChrome = MoneyPageChrome(
        title = MoneyCopy.IMPORT_TITLE,
        back_label = parent.ifEmpty { MoneyCopy.APP_TITLE },
        retry = MoneyCopy.RETRY,
    )

    override fun decorate(held: MoneyHeld<MoneyImportState>): MoneyImportState = held.screen

    private const val SNIFF: Int = 256

    internal object Lens : ContentLens<MoneyImportState, MoneyImportData> {
        override fun content(state: MoneyImportState): ReadContent<MoneyImportData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: MoneyImportState, content: ReadContent<MoneyImportData>): MoneyImportState = when (content) {
            is ReadContent.Loading -> state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
            is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
            is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
            is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
        }
    }
}

/** What the core is asked to plan: the held file's source and the member's answers. */
public data class MoneyPlanAsk(
    public val source: MoneySource,
    public val accountId: String?,
    public val dateOrder: MoneyDateOrder,
    public val sign: MoneySignChoice,
)

/** The accounts a CSV can import into. */
public object MoneyImportReads : MoneyQueries<MoneyImportState, MoneyImportEvent>(
    screenId = MoneyImportMachine.SCREEN_ID,
    tables = MONEY_TABLES,
    ask = { _, now -> listOf(AppQueryRequest(money_accounts = MoneyAccountsRequest(tz = now.zone))) },
)

/** The core's plan for a statement, behind a seam a spec can fake. */
public interface MoneyDoor {
    public suspend fun plan(bytes: ByteArray, ask: MoneyPlanAsk, zone: String): MoneyPlanOutcome
}

/** The door over the session's core, taken as a SUPPLIER (a vault switch is a new core). */
public class CoreMoneyDoor(private val core: () -> CentraidCore?) : MoneyDoor {
    override suspend fun plan(bytes: ByteArray, ask: MoneyPlanAsk, zone: String): MoneyPlanOutcome {
        val open = core() ?: return MoneyPlanOutcome.Unreachable(MoneyCopy.NO_VAULT)
        val request = MoneyImportPlanRequest(
            tz = zone,
            source = ask.source,
            content = bytes.toByteString(),
            account_id = ask.accountId,
            date_order = ask.dateOrder,
            sign = ask.sign,
        )
        return when (val outcome = open.call(Envelope(request_id = 0, request = Request(money = MoneyRequest(import_plan = request))))) {
            is CoreOutcome.Failed -> MoneyPlanOutcome.Unreachable(outcome.failure.sentence)
            is CoreOutcome.Answered -> {
                val plan = outcome.value.response?.money?.import_plan
                val error = outcome.value.error
                when {
                    plan != null -> MoneyPlanOutcome.Plan(plan)
                    // `Error.detail` IS FOR LOGS AND NEVER FOR A MEMBER: the code chooses the sentence.
                    error != null -> MoneyPlanOutcome.Unreachable(sentenceFor(error.code).sentence)
                    else -> MoneyPlanOutcome.Unreachable(MoneyCopy.NO_ANSWER)
                }
            }
        }
    }
}
