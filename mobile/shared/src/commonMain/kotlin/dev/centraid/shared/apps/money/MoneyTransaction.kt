package dev.centraid.shared.apps.money

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.MoneyCategoriesRequest
import centraid.core.v1.MoneyFlag
import centraid.core.v1.MoneyTransaction
import centraid.core.v1.MoneyTransactionRequest
import centraid.screen.v1.Confirm
import centraid.screen.v1.Loading
import centraid.screen.v1.MoneyAction
import centraid.screen.v1.MoneyChoice
import centraid.screen.v1.MoneyFact
import centraid.screen.v1.MoneyOffer
import centraid.screen.v1.MoneyPageChrome
import centraid.screen.v1.MoneyTransactionData
import centraid.screen.v1.MoneyTransactionEvent
import centraid.screen.v1.MoneyTransactionState
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
import dev.centraid.shared.kit.dataOf
import dev.centraid.shared.kit.time.CivilWords
import dev.centraid.shared.nav.ScreenIds
import dev.centraid.shared.screen.Step

/**
 * ONE TRANSACTION (#1099): what the bank said never changes; the category and the
 * name are the member's decisions, layered on top. The page draws what the core
 * derived and offers four acts: file it, name it, void it, and take back a
 * transfer. A transfer and a rule are PROPOSED by the app and written only when
 * the member accepts (R20(c)).
 */
public object MoneyTransactionMachine :
    MoneyQueryMachine<MoneyTransactionState, MoneyTransactionEvent, MoneyTransactionData>(ScreenIds.MONEY_TRANSACTION, MONEY_TABLES) {
    public const val SCREEN_ID: String = ScreenIds.MONEY_TRANSACTION

    public const val CMD_CATEGORIZE: String = "txn.categorize"
    public const val CMD_VOID: String = "txn.void"

    /** A line's name is its entity's title: the shared verb. */
    public const val CMD_NAME: String = "entity.retitle"
    public const val CMD_LINK: String = "txn.link_transfer"
    public const val CMD_UNLINK: String = "txn.unlink_transfer"
    public const val CMD_ADD_RULE: String = "rule.add"

    public const val ACTION_CATEGORY: String = "category"
    public const val ACTION_NAME: String = "name"
    public const val ACTION_UNLINK: String = "unlink"
    public const val ACTION_VOID: String = "void"

    public const val OFFER_TRANSFER: String = "transfer"
    public const val OFFER_RULE: String = "rule"

    override val lens: ContentLens<MoneyTransactionState, MoneyTransactionData> = Lens

    override fun blank(): MoneyTransactionState = MoneyTransactionState(
        write = WriteState(phase = WriteState.Phase.PHASE_IDLE),
        sheet = MoneyTransactionState.Sheet.SHEET_NONE,
    )

    override fun withSeat(screen: MoneyTransactionState, seat: SeatState): MoneyTransactionState = screen.copy(seat = seat)

    override fun view(
        held: MoneyHeld<MoneyTransactionState>,
        event: MoneyTransactionEvent,
    ): Step<MoneyHeld<MoneyTransactionState>> {
        val screen = held.screen
        return when {
            event.opened != null -> reload(
                held.copy(
                    screen = blank().copy(
                        seat = screen.seat,
                        txn_id = event.opened.txn_id,
                        draft_token = event.opened.draft_token,
                        chrome = chrome(event.opened.parent),
                    ),
                ),
            )

            event.refreshed != null -> read(overRows(held))

            event.action != null -> action(held, event.action.key)

            event.category != null -> {
                val id = event.category.category_id
                val input = MoneyFold.json(
                    "ids" to "[${MoneyFold.str(screen.txn_id)}]",
                    "category_id" to MoneyFold.strOrNull(id.ifEmpty { null }),
                )
                submit(held.copy(screen = screen.copy(sheet = MoneyTransactionState.Sheet.SHEET_NONE)), CMD_CATEGORIZE, input, id)
            }

            event.name_edited != null -> Step(held.copy(screen = screen.copy(name_draft = event.name_edited.text)))

            event.name_saved != null -> {
                // A cleared name goes back to the bank's own words.
                val text = screen.name_draft.trim().ifEmpty { held.answers.transaction?.raw.orEmpty() }
                val closed = held.copy(screen = screen.copy(sheet = MoneyTransactionState.Sheet.SHEET_NONE))
                if (text.isEmpty()) {
                    Step(closed)
                } else {
                    val input = MoneyFold.json("id" to MoneyFold.str(screen.txn_id), "title" to MoneyFold.str(text))
                    submit(closed, CMD_NAME, input, text)
                }
            }

            event.sheet_closed != null ->
                Step(held.copy(screen = screen.copy(sheet = MoneyTransactionState.Sheet.SHEET_NONE)))

            event.offer_accepted != null -> accept(held, event.offer_accepted.key)

            event.offer_dismissed != null ->
                Step(held.copy(screen = screen.copy(dismissed = (screen.dismissed + event.offer_dismissed.key).distinct())))

            event.confirm_accepted != null && screen.confirm != null -> {
                val input = MoneyFold.json("id" to MoneyFold.str(screen.txn_id))
                submit(held.copy(screen = screen.copy(confirm = null)), CMD_VOID, input, "")
            }

            event.confirm_dismissed != null -> Step(held.copy(screen = screen.copy(confirm = null)))

            else -> Step(held)
        }
    }

    private fun action(held: MoneyHeld<MoneyTransactionState>, key: String): Step<MoneyHeld<MoneyTransactionState>> {
        val screen = held.screen
        val data = lens.dataOf(screen)
        return when (key) {
            ACTION_CATEGORY -> Step(held.copy(screen = screen.copy(sheet = MoneyTransactionState.Sheet.SHEET_CATEGORY)))
            ACTION_NAME -> Step(
                held.copy(
                    screen = screen.copy(
                        sheet = MoneyTransactionState.Sheet.SHEET_NAME,
                        name_draft = data?.title.orEmpty(),
                    ),
                ),
            )
            ACTION_UNLINK -> submit(held, CMD_UNLINK, MoneyFold.json("id" to MoneyFold.str(screen.txn_id)), "")
            ACTION_VOID -> Step(
                held.copy(
                    screen = screen.copy(
                        confirm = Confirm(
                            title = MoneyCopy.VOID_TITLE,
                            body = MoneyCopy.VOID_BODY,
                            confirm_label = MoneyCopy.VOID_CONFIRM,
                            destructive = true,
                        ),
                    ),
                ),
            )
            else -> Step(held)
        }
    }

    private fun accept(held: MoneyHeld<MoneyTransactionState>, key: String): Step<MoneyHeld<MoneyTransactionState>> {
        val screen = held.screen
        val answer = held.answers.transaction ?: return Step(held)
        return when (key) {
            OFFER_TRANSFER -> {
                val other = answer.transfer_proposal ?: return Step(held)
                val input = MoneyFold.json(
                    "id" to MoneyFold.str(screen.txn_id),
                    "other_id" to MoneyFold.str(other.other_txn_id),
                )
                submit(held, CMD_LINK, input, other.other_txn_id)
            }
            OFFER_RULE -> {
                val offer = answer.rule_proposal ?: return Step(held)
                val input = MoneyFold.json(
                    "id" to MoneyFold.str("rule-${screen.draft_token}"),
                    "match" to MoneyFold.str(MoneyFold.matchKindKey(offer.kind)),
                    "text" to MoneyFold.str(offer.pattern),
                    "category_id" to MoneyFold.str(offer.category_id),
                )
                submit(held, CMD_ADD_RULE, input, screen.draft_token)
            }
            else -> Step(held)
        }
    }

    private fun submit(
        held: MoneyHeld<MoneyTransactionState>,
        command: String,
        input: String,
        intent: String,
    ): Step<MoneyHeld<MoneyTransactionState>> {
        // THE KEY ONLY CORRELATES THE ANSWER. The same act on the same row in
        // flight is one write ([WriteLaw]); the core remembers no key (R-1088-12).
        val key = InvokeKeys.of(command, held.screen.txn_id, intent)
        return WriteLaw.submit(Writes, held.copy(screen = held.screen.copy(status = null)), command, input, key)
    }

    override fun settled(
        held: MoneyHeld<MoneyTransactionState>,
        settled: WriteSettled,
    ): Step<MoneyHeld<MoneyTransactionState>> {
        val step = WriteLaw.settled(Writes, held, settled)
        if (step.state === held) return step
        val command = settled.invoke_key.substringBefore(':')
        val status = if (settled.committed) {
            StatusLine(sentence = committedSentence(command))
        } else {
            StatusLine(sentence = settled.failure?.sentence?.takeIf { it.isNotEmpty() } ?: MoneyCopy.WRITE_REFUSED, refused = true)
        }
        return Step(step.state.copy(screen = step.state.screen.copy(status = status)), step.effects)
    }

    private fun committedSentence(command: String): String = when (command) {
        CMD_CATEGORIZE -> MoneyCopy.DONE_CATEGORY
        CMD_NAME -> MoneyCopy.DONE_NAME
        CMD_LINK -> MoneyCopy.DONE_LINKED
        CMD_UNLINK -> MoneyCopy.DONE_UNLINKED
        CMD_VOID -> MoneyCopy.DONE_VOID
        CMD_ADD_RULE -> MoneyCopy.DONE_RULE
        else -> MoneyCopy.DONE_GENERIC
    }

    override fun fold(held: MoneyHeld<MoneyTransactionState>): MoneyTransactionData? {
        val answer = held.answers.transaction ?: return null
        if (!answer.found) return null
        val screen = held.screen
        val amount = MoneyFold.money(answer.amount)
        val voided = MoneyFlag.MONEY_FLAG_VOID in answer.flags
        val struck = voided || MoneyFlag.MONEY_FLAG_TRANSFER in answer.flags
        val facts = buildList {
            add(MoneyFact(MoneyCopy.FACT_ACCOUNT, answer.account_label))
            add(MoneyFact(MoneyCopy.FACT_POSTED, CivilWords.dayMonth(answer.posted_on)))
            add(MoneyFact(MoneyCopy.FACT_BANK_WROTE, answer.raw))
            // CATEGORY AND NAME ARE THE FACTS A MEMBER CHANGES: each names its
            // action, and a category still to supply is owed attention (seam).
            add(
                MoneyFact(
                    MoneyCopy.FACT_CATEGORY,
                    answer.category_label ?: MoneyCopy.NO_CATEGORY,
                    action = ACTION_CATEGORY,
                    tone = if (answer.category_label == null) StatusChip.Tone.TONE_SEAM else StatusChip.Tone.TONE_UNSPECIFIED,
                ),
            )
            add(
                MoneyFact(
                    MoneyCopy.FACT_NAME,
                    when (answer.display_name_source) {
                        "rule" -> "${answer.display_name} · ${MoneyCopy.FROM_RULE}"
                        "member" -> "${answer.display_name} · ${MoneyCopy.FROM_YOU}"
                        else -> answer.display_name
                    },
                    action = ACTION_NAME,
                ),
            )
            answer.memo?.takeIf { it.isNotBlank() }?.let { add(MoneyFact(MoneyCopy.FACT_MEMO, it)) }
            answer.check_number?.takeIf { it.isNotBlank() }?.let { add(MoneyFact(MoneyCopy.FACT_CHECK, it)) }
            answer.bank_type?.takeIf { it.isNotBlank() }?.let { add(MoneyFact(MoneyCopy.FACT_BANK_TYPE, it)) }
            answer.imported_from?.let {
                add(MoneyFact(MoneyCopy.FACT_IMPORTED, if (it == "ofx") MoneyCopy.SOURCE_OFX_FROM else MoneyCopy.SOURCE_CSV_FROM))
            }
        }
        val transferOffer = answer.transfer_proposal?.takeIf { OFFER_TRANSFER !in screen.dismissed }?.let { offer ->
            MoneyOffer(
                key = OFFER_TRANSFER,
                title = MoneyCopy.TRANSFER_OFFER_TITLE,
                body = MoneyFold.fill(
                    MoneyCopy.TRANSFER_OFFER_BODY,
                    "account" to offer.other_account_label,
                    "day" to MoneyFold.dayShort(offer.other_posted_on),
                ),
                detail = offer.other_description,
                accept_label = MoneyCopy.TRANSFER_ACCEPT,
                dismiss_label = MoneyCopy.NOT_NOW,
            )
        }
        val ruleOffer = answer.rule_proposal?.takeIf { OFFER_RULE !in screen.dismissed }?.let { offer ->
            MoneyOffer(
                key = OFFER_RULE,
                title = MoneyCopy.RULE_OFFER_TITLE,
                body = MoneyFold.fill(
                    MoneyCopy.RULE_OFFER_BODY,
                    "support" to offer.support.toString(),
                    "of" to offer.of.toString(),
                    "name" to offer.display_name.ifEmpty { answer.display_name },
                    "category" to offer.category_label,
                ),
                detail = "${MoneyFold.matchKindWord(offer.kind)} ${offer.pattern}",
                accept_label = MoneyCopy.RULE_ACCEPT,
                dismiss_label = MoneyCopy.NOT_NOW,
            )
        }
        val notes = buildList {
            if (answer.seen_times > 1) add(MoneyFold.fill(MoneyCopy.SEEN_TIMES, "n" to answer.seen_times.toString()))
            answer.recurring?.let { add(MoneyFold.fill(MoneyCopy.REPEATS, "cadence" to MoneyFold.cadenceWords(it.cadence))) }
            if (answer.applied_rule_ids.isNotEmpty()) add(MoneyCopy.NAMED_BY_RULE)
        }
        val actions = buildList {
            add(MoneyAction(key = ACTION_CATEGORY, label = MoneyCopy.ACTION_CATEGORY, icon_key = "Tag", enabled = !voided))
            add(MoneyAction(key = ACTION_NAME, label = MoneyCopy.ACTION_NAME, icon_key = "Pencil", enabled = !voided))
            if (answer.transferred_with != null) {
                add(MoneyAction(key = ACTION_UNLINK, label = MoneyCopy.ACTION_UNLINK, icon_key = "SwitchVert", enabled = true))
            }
            if (!voided) {
                add(MoneyAction(key = ACTION_VOID, label = MoneyCopy.ACTION_VOID, icon_key = "Trash", enabled = true, destructive = true))
            }
        }
        return MoneyTransactionData(
            title = answer.display_name.ifEmpty { answer.raw },
            amount = amount,
            amount_tone = if (struck) StatusChip.Tone.TONE_SEAM else MoneyFold.signTone(answer.amount),
            direction_label = if (amount.minor < 0) MoneyCopy.MONEY_OUT else MoneyCopy.MONEY_IN,
            facts = facts,
            chips = MoneyFold.chips(answer.flags, answer.category_id != null),
            transfer_offer = transferOffer,
            rule_offer = ruleOffer,
            notes = notes,
            actions = actions,
            category_options = categoryOptions(held, answer),
            category_sheet_title = MoneyCopy.CATEGORY_SHEET_TITLE,
            name_sheet_title = MoneyCopy.NAME_SHEET_TITLE,
            name_placeholder = MoneyCopy.NAME_PLACEHOLDER,
            save_label = MoneyCopy.SAVE,
            clear_label = MoneyCopy.CLEAR,
            accessibility_label = listOf(answer.display_name, CivilWords.dayMonth(answer.posted_on), answer.account_label)
                .filter { it.isNotEmpty() }.joinToString(", "),
            transferred_with = answer.transferred_with.orEmpty(),
        )
    }

    private fun categoryOptions(held: MoneyHeld<MoneyTransactionState>, answer: MoneyTransaction): List<MoneyChoice> = buildList {
        add(MoneyFold.choice("", MoneyCopy.NO_CATEGORY, answer.category_id == null))
        held.answers.categories?.groups.orEmpty().forEach { group ->
            group.categories.filter { !it.archived || it.category_id == answer.category_id }.forEach { category ->
                add(MoneyFold.choice(category.category_id, category.label, category.category_id == answer.category_id, group.label))
            }
        }
    }

    private fun chrome(parent: String): MoneyPageChrome = MoneyPageChrome(
        title = MoneyCopy.TRANSACTION_TITLE,
        back_label = parent.ifEmpty { MoneyCopy.APP_TITLE },
        retry = MoneyCopy.RETRY,
    )

    override fun decorate(held: MoneyHeld<MoneyTransactionState>): MoneyTransactionState =
        if (held.screen.chrome == null) held.screen.copy(chrome = chrome("")) else held.screen

    private object Writes : WriteLens<MoneyHeld<MoneyTransactionState>> {
        override fun write(state: MoneyHeld<MoneyTransactionState>): WriteState = state.screen.write ?: WriteState()

        override fun with(state: MoneyHeld<MoneyTransactionState>, write: WriteState): MoneyHeld<MoneyTransactionState> =
            state.copy(screen = state.screen.copy(write = write))
    }

    internal object Lens : ContentLens<MoneyTransactionState, MoneyTransactionData> {
        override fun content(state: MoneyTransactionState): ReadContent<MoneyTransactionData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: MoneyTransactionState, content: ReadContent<MoneyTransactionData>): MoneyTransactionState =
            when (content) {
                is ReadContent.Loading ->
                    state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
                is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
                is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
                is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
            }
    }
}

/** The transaction, and the categories its sheet files it under. Nothing until it is named. */
public object MoneyTransactionReads : MoneyQueries<MoneyTransactionState, MoneyTransactionEvent>(
    screenId = MoneyTransactionMachine.SCREEN_ID,
    tables = MONEY_TABLES,
    ask = { held, now ->
        held.screen.txn_id.takeIf { it.isNotEmpty() }?.let { id ->
            listOf(
                AppQueryRequest(money_transaction = MoneyTransactionRequest(tz = now.zone, txn_id = id)),
                AppQueryRequest(money_categories = MoneyCategoriesRequest()),
            )
        }
    },
)
