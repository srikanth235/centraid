package dev.centraid.shared

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.MoneyAccounts
import centraid.core.v1.MoneyActivity
import centraid.core.v1.MoneyActivityRow
import centraid.core.v1.MoneyAmount
import centraid.core.v1.MoneyCadence
import centraid.core.v1.MoneyCashflow
import centraid.core.v1.MoneyCategories
import centraid.core.v1.MoneyCategoryFilter
import centraid.core.v1.MoneyCounted
import centraid.core.v1.MoneyDateOrder
import centraid.core.v1.MoneyDateOrderQuestion
import centraid.core.v1.MoneyFlag
import centraid.core.v1.MoneyHomeTile
import centraid.core.v1.MoneyImportCheckpoint
import centraid.core.v1.MoneyImportPlan
import centraid.core.v1.MoneyImportPlanRow
import centraid.core.v1.MoneyImportProfile
import centraid.core.v1.MoneyImportVerdict
import centraid.core.v1.MoneyMatchKind
import centraid.core.v1.MoneyRecurring
import centraid.core.v1.MoneyRecurringStatus
import centraid.core.v1.MoneyRules
import centraid.core.v1.MoneySearch
import centraid.core.v1.MoneySource
import centraid.core.v1.MoneySpending
import centraid.core.v1.MoneyStatementPlan
import centraid.core.v1.MoneyTargetSheet
import centraid.core.v1.MoneyTransaction
import centraid.screen.v1.MoneyAccountsEvent
import centraid.screen.v1.MoneyCategoriesEvent
import centraid.screen.v1.MoneyCategoriesState
import centraid.screen.v1.MoneyHomeEvent
import centraid.screen.v1.MoneyHomeState
import centraid.screen.v1.MoneyImportEvent
import centraid.screen.v1.MoneyImportState
import centraid.screen.v1.MoneyRecurringEvent
import centraid.screen.v1.MoneyRulesEvent
import centraid.screen.v1.MoneyRulesState
import centraid.screen.v1.MoneySearchEvent
import centraid.screen.v1.MoneyTargetEvent
import centraid.screen.v1.MoneyTransactionEvent
import centraid.screen.v1.MoneyTransactionState
import centraid.screen.v1.StatusChip
import centraid.screen.v1.TileBody
import centraid.screen.v1.TileStatus
import centraid.screen.v1.WriteSettled
import centraid.screen.v1.WriteState
import dev.centraid.design.copy.MoneyCopy
import dev.centraid.shared.apps.money.MONEY_TABLES
import dev.centraid.shared.apps.money.MoneyAccountsMachine
import dev.centraid.shared.apps.money.MoneyAccountsReads
import dev.centraid.shared.apps.money.MoneyCategoriesMachine
import dev.centraid.shared.apps.money.MoneyFold
import dev.centraid.shared.apps.money.MoneyHeld
import dev.centraid.shared.apps.money.MoneyHomeMachine
import dev.centraid.shared.apps.money.MoneyHomeReads
import dev.centraid.shared.apps.money.MoneyImportMachine
import dev.centraid.shared.apps.money.MoneyInput
import dev.centraid.shared.apps.money.MoneyPlanOutcome
import dev.centraid.shared.apps.money.MoneyRecurringMachine
import dev.centraid.shared.apps.money.MoneyRulesMachine
import dev.centraid.shared.apps.money.MoneyRulesReads
import dev.centraid.shared.apps.money.MoneySearchMachine
import dev.centraid.shared.apps.money.MoneySearchReads
import dev.centraid.shared.apps.money.MoneyTargetMachine
import dev.centraid.shared.apps.money.MoneyTargetReads
import dev.centraid.shared.apps.money.MoneyTransactionMachine
import dev.centraid.shared.apps.money.MoneyTransactionReads
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.shell.HomeMoneyTile
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import okio.ByteString.Companion.encodeUtf8

/**
 * MONEY'S SCREENS (#1099): the folds from the core's typed answers, the money
 * laws (one currency per line, nothing summed across them), every write a screen
 * emits, and the import's pick, plan and publish.
 */
class MoneyScreensSpec : StringSpec({

    // --- Home ------------------------------------------------------------

    "Spending folds per currency, and nothing is summed across them" {
        val home = answered(MoneyHomeMachine, open(MoneyHomeMachine, MoneyHomeEvent(opened = MoneyHomeEvent.Opened())), spending())
        val data = home.screen.data_.shouldNotBeNull()
        home.screen.destination shouldBe MoneyHomeState.Destination.DESTINATION_SPENDING
        val spending = data.spending.shouldNotBeNull()
        // TWO CURRENCIES, TWO HEROES: each its own money, in the core's order.
        spending.heroes.map { it.spent?.currency } shouldBe listOf("USD", "CAD")
        spending.heroes.map { it.spent?.minor } shouldBe listOf(331_458L, 12_000L)
        spending.heroes[0].figures.map { it.label } shouldBe listOf(MoneyCopy.PLANNED, MoneyCopy.LEFT)
        spending.heroes[0].has_bar shouldBe true
        spending.heroes[0].fill_bp shouldBe 8_757
        // The tick is how far through the month today falls: day 14 of 31.
        spending.heroes[0].tick_bp shouldBe 4_516
        spending.heroes[1].has_bar shouldBe false
        // Category tables never mix currencies, and name the currency only when there are two.
        spending.tables.map { it.currency } shouldBe listOf("USD")
        spending.tables.single().heading shouldBe ""
        spending.tables.single().rows.single().over shouldBe true
        spending.days_left_label shouldBe "17 days left"
        spending.notes shouldContain "3 rows need a category"
        spending.notes shouldContain "2 transfers are not counted"
        data.month_label shouldBe "October 2026"
        data.can_step_next shouldBe false
        data.month_options.size shouldBe 12
        data.month_options.first().key shouldBe "2026-10"
    }

    "day one is one sentence and Import statement" {
        val home = answered(
            MoneyHomeMachine,
            open(MoneyHomeMachine, MoneyHomeEvent(opened = MoneyHomeEvent.Opened())),
            spending().copy(empty = true, per_currency = emptyList(), categories = emptyList()),
        )
        val empty = home.screen.data_?.spending?.empty.shouldNotBeNull()
        empty.headline shouldBe MoneyCopy.DAY_ONE
        empty.action_label shouldBe MoneyCopy.IMPORT_ACTION
        home.screen.data_?.spending?.heroes.shouldBeEmpty()
    }

    "the band holds three places and More, and More's rows are the machine's" {
        val home = answered(MoneyHomeMachine, open(MoneyHomeMachine, MoneyHomeEvent(opened = MoneyHomeEvent.Opened())), spending())
        home.screen.band.map { it.key } shouldBe listOf("spending", "activity", "cashflow", "more")
        home.screen.band.last().icon_key shouldBe "MoreHoriz"
        home.screen.chrome?.more_rows?.map { it.key } shouldBe listOf("accounts", "rules", "categories", "import")
        // THE HEADER'S ONE ACTION IS SPOKEN "Import statement" (R-CHROME-1); search is a bar, never a More row.
        home.screen.chrome?.add_label shouldBe "Import statement"
        home.screen.chrome?.search_placeholder shouldBe "Search transactions"
        val more = MoneyHomeMachine.reduce(home, view(MoneyHomeEvent(band = MoneyHomeEvent.BandPicked(key = "more"))))
        more.state.screen.sheet shouldBe MoneyHomeState.Sheet.SHEET_MORE
        more.effects.shouldBeEmpty()
        // The same tab again is nothing.
        val same = MoneyHomeMachine.reduce(home, view(MoneyHomeEvent(band = MoneyHomeEvent.BandPicked(key = "spending"))))
        same.state shouldBe home
        // The search bar and the Plus are doors: they change nothing here.
        MoneyHomeMachine.reduce(home, view(MoneyHomeEvent(search_opened = MoneyHomeEvent.SearchOpened()))).state shouldBe home
        MoneyHomeMachine.reduce(home, view(MoneyHomeEvent(add = MoneyHomeEvent.AddStatement()))).state shouldBe home
    }

    "Activity asks for a window, filters by month, account and category, and Show more widens it" {
        val opened = open(MoneyHomeMachine, MoneyHomeEvent(opened = MoneyHomeEvent.Opened(destination = MoneyHomeState.Destination.DESTINATION_ACTIVITY)))
        val ask = MoneyHomeReads.requests(opened, CLOCK).shouldNotBeNull()
        ask.map { it.money_activity != null } shouldBe listOf(true, false, false)
        ask[0].money_activity?.limit shouldBe MoneyHomeMachine.PAGE
        ask[0].money_activity?.tz shouldBe "Europe/Lisbon"
        ask[0].money_activity?.category_filter shouldBe MoneyCategoryFilter.MONEY_CATEGORY_FILTER_ANY
        ask[1].money_accounts.shouldNotBeNull()
        ask[2].money_categories.shouldNotBeNull()
        val home = answeredWith(
            MoneyHomeMachine,
            opened,
            AppQueryResponse(money_activity = activity(next = true)),
            AppQueryResponse(money_accounts = accounts()),
            AppQueryResponse(money_categories = categories()),
        )
        val data = home.screen.data_?.activity.shouldNotBeNull()
        data.sections.map { it.heading } shouldBe listOf("Today", "Yesterday")
        data.sections[0].rows.single().title shouldBe "Trader Joe’s"
        data.sections[0].rows.single().amount_tone shouldBe StatusChip.Tone.TONE_NET
        // A TRANSFER keeps its row, greys its amount and says why.
        val transfer = data.sections[1].rows.single()
        transfer.amount_tone shouldBe StatusChip.Tone.TONE_SEAM
        transfer.dimmed shouldBe true
        transfer.meta shouldContain MoneyCopy.NOT_SPENDING
        data.needs_label shouldBe "Needs a category · 3"
        data.more shouldBe true
        data.window shouldBe "Showing 2"
        home.screen.chips.map { it.key } shouldBe listOf("month", "account", "category")
        home.screen.chips.map { it.active } shouldBe listOf(false, false, false)
        data.category_options.map { it.key } shouldBe listOf("", "uncategorised", "c-groc", "c-util")
        // Picking an account re-reads with that account, from the first page.
        val filtered = MoneyHomeMachine.reduce(home, view(MoneyHomeEvent(account_picked = MoneyHomeEvent.AccountPicked(account_id = "a-chase"))))
        filtered.state.screen.account_id shouldBe "a-chase"
        filtered.effects shouldBe listOf(ScreenEffect.ReadPage("money.home", afterCursor = null))
        MoneyHomeReads.requests(filtered.state, CLOCK)!![0].money_activity?.account_id shouldBe "a-chase"
        filtered.state.screen.chips[1].active shouldBe true
        val uncategorised = MoneyHomeMachine.reduce(filtered.state, view(MoneyHomeEvent(category_picked = MoneyHomeEvent.CategoryPicked(key = "uncategorised"))))
        MoneyHomeReads.requests(uncategorised.state, CLOCK)!![0].money_activity?.category_filter shouldBe
            MoneyCategoryFilter.MONEY_CATEGORY_FILTER_UNCATEGORISED
        val category = MoneyHomeMachine.reduce(filtered.state, view(MoneyHomeEvent(category_picked = MoneyHomeEvent.CategoryPicked(key = "c-groc"))))
        MoneyHomeReads.requests(category.state, CLOCK)!![0].money_activity?.category_filter shouldBe MoneyCategoryFilter.MONEY_CATEGORY_FILTER_IS
        MoneyHomeReads.requests(category.state, CLOCK)!![0].money_activity?.category_id shouldBe "c-groc"
        // Show more asks for a bigger window and keeps the rows while it lands.
        val more = MoneyHomeMachine.reduce(home, view(MoneyHomeEvent(show_more = MoneyHomeEvent.ShowMore())))
        more.state.screen.activity_shown shouldBe MoneyHomeMachine.PAGE * 2
        more.state.screen.data_.shouldNotBeNull()
        MoneyHomeReads.requests(more.state, CLOCK)!![0].money_activity?.limit shouldBe MoneyHomeMachine.PAGE * 2
    }

    "stepping the month reads again and never goes past this month" {
        val home = answered(MoneyHomeMachine, open(MoneyHomeMachine, MoneyHomeEvent(opened = MoneyHomeEvent.Opened())), spending())
        home.screen.month shouldBe "2026-10"
        val back = MoneyHomeMachine.reduce(home, view(MoneyHomeEvent(month_stepped = MoneyHomeEvent.MonthStepped(months = -1))))
        back.state.screen.month shouldBe "2026-09"
        back.effects shouldBe listOf(ScreenEffect.ReadPage("money.home", afterCursor = null))
        MoneyHomeReads.requests(back.state, CLOCK)!!.single().money_spending?.month shouldBe "2026-09"
        val past = answeredWith(MoneyHomeMachine, back.state, AppQueryResponse(money_spending = spending().copy(month = "2026-09")))
        past.screen.data_?.can_step_next shouldBe true
        val forward = MoneyHomeMachine.reduce(home, view(MoneyHomeEvent(month_stepped = MoneyHomeEvent.MonthStepped(months = 1))))
        forward.state.screen.month shouldBe "2026-10"
        MoneyFold.shiftMonth("2026-01", -1) shouldBe "2025-12"
        MoneyFold.shiftMonth("2026-12", 1) shouldBe "2027-01"
    }

    "Cash flow draws bars against its own largest side, and outlines a partial month" {
        val home = answered(
            MoneyHomeMachine,
            open(MoneyHomeMachine, MoneyHomeEvent(opened = MoneyHomeEvent.Opened(destination = MoneyHomeState.Destination.DESTINATION_CASHFLOW))),
            cashflow(),
        )
        MoneyHomeReads.requests(home, CLOCK)!!.single().money_cashflow?.tz shouldBe "Europe/Lisbon"
        val series = home.screen.data_?.cashflow?.series.shouldNotBeNull().single()
        series.months.map { it.in_bp } shouldBe listOf(10_000, 5_000)
        series.months.map { it.partial } shouldBe listOf(false, true)
        series.months[0].rate_label shouldBe "25% kept"
        series.months[1].rate_label shouldBe ""
        series.months[0].label shouldBe "Sep"
        series.months[0].net_tone shouldBe StatusChip.Tone.TONE_NEUTRAL
        series.months[1].net_tone shouldBe StatusChip.Tone.TONE_NET
    }

    "a refusal is a sentence and a denial is the gate, with no band" {
        val opened = open(MoneyHomeMachine, MoneyHomeEvent(opened = MoneyHomeEvent.Opened()))
        val refused = MoneyHomeMachine.reduce(opened, MoneyInput.Refused(dev.centraid.shared.screen.Reads.refused("no"))).state
        refused.screen.failure?.sentence shouldBe "no"
        refused.screen.data_.shouldBeNull()
        val denied = MoneyHomeMachine.reduce(opened, MoneyInput.Denied(AppQueryDenial())).state
        denied.screen.denied?.title shouldBe MoneyCopy.DENIED_TITLE
        denied.screen.band.shouldBeEmpty()
    }

    "a change event re-reads over the rows, one read at a time" {
        val home = answered(MoneyHomeMachine, open(MoneyHomeMachine, MoneyHomeEvent(opened = MoneyHomeEvent.Opened())), spending())
        MoneyHomeMachine.rowsChanged("people_note", listOf("k")).shouldBeNull()
        MONEY_TABLES.forEach { MoneyHomeMachine.rowsChanged(it, emptyList()).shouldNotBeNull() }
        val first = MoneyHomeMachine.reduce(home, MoneyHomeMachine.rowsChanged("core_transaction", emptyList())!!)
        first.effects shouldBe listOf(ScreenEffect.ReadPage("money.home", afterCursor = null))
        first.state.screen.data_.shouldNotBeNull()
        val second = MoneyHomeMachine.reduce(first.state, MoneyHomeMachine.rowsChanged("money_rule", emptyList())!!)
        second.effects.shouldBeEmpty()
        val stale = MoneyHomeMachine.reduce(second.state, MoneyInput.Answered(listOf(AppQueryResponse(money_spending = spending()))))
        stale.effects shouldBe listOf(ScreenEffect.ReadPage("money.home", afterCursor = null))
    }

    // --- Transaction -------------------------------------------------------

    "a transaction offers a transfer and a rule, and writes only when the member accepts" {
        val opened = open(MoneyTransactionMachine, MoneyTransactionEvent(opened = MoneyTransactionEvent.Opened(txn_id = "t1", parent = "Activity", draft_token = "tok")))
        opened.screen.chrome?.back_label shouldBe "Activity"
        MoneyTransactionReads.requests(MoneyTransactionMachine.initial(), CLOCK).shouldBeNull()
        MoneyTransactionReads.requests(opened, CLOCK)!!.first().money_transaction?.txn_id shouldBe "t1"
        val held = answeredWith(
            MoneyTransactionMachine,
            opened,
            AppQueryResponse(money_transaction = transaction()),
            AppQueryResponse(money_categories = categories()),
        )
        val data = held.screen.data_.shouldNotBeNull()
        data.title shouldBe "Trader Joe’s"
        data.direction_label shouldBe MoneyCopy.MONEY_OUT
        data.amount?.minor shouldBe -6_418L
        data.facts.first { it.label == MoneyCopy.FACT_NAME }.detail shouldBe "Trader Joe’s · ${MoneyCopy.FROM_RULE}"
        data.facts.first { it.label == MoneyCopy.FACT_BANK_WROTE }.detail shouldBe "TRADER JOE S #552"
        data.transfer_offer?.key shouldBe "transfer"
        data.rule_offer?.body shouldBe "4 of the last 5 Trader Joe’s rows are Groceries."
        data.rule_offer?.detail shouldBe "contains TRADER JOE S"
        data.actions.map { it.key } shouldBe listOf("category", "name", "void")
        data.actions.last().destructive shouldBe true
        // NOTHING WAS WRITTEN BY OPENING IT.
        held.screen.write?.phase shouldBe WriteState.Phase.PHASE_IDLE

        // Accepting the transfer is one write, with the other half's id.
        val link = MoneyTransactionMachine.reduce(held, view(MoneyTransactionEvent(offer_accepted = MoneyTransactionEvent.OfferAccepted(key = "transfer"))))
        val linkWrite = link.effects.single() as ScreenEffect.SubmitWrite
        linkWrite.command shouldBe "money.link_transfer"
        linkWrite.inputJson shouldBe """{"txn_id":"t1","other_txn_id":"t2"}"""
        // A double tap while it is in flight is the same write.
        MoneyTransactionMachine.reduce(link.state, view(MoneyTransactionEvent(offer_accepted = MoneyTransactionEvent.OfferAccepted(key = "transfer")))).effects.shouldBeEmpty()
        val settled = MoneyTransactionMachine.reduce(link.state, MoneyInput.Settled(WriteSettled(invoke_key = linkWrite.invokeKey, committed = true)))
        settled.state.screen.status?.sentence shouldBe MoneyCopy.DONE_LINKED

        // Accepting the rule mints its id from the sitting's token.
        val rule = MoneyTransactionMachine.reduce(held, view(MoneyTransactionEvent(offer_accepted = MoneyTransactionEvent.OfferAccepted(key = "rule"))))
        val ruleWrite = rule.effects.single() as ScreenEffect.SubmitWrite
        ruleWrite.command shouldBe "money.add_rule"
        ruleWrite.inputJson shouldBe
            """{"rule_id":"rule-tok","match_kind":"contains","pattern":"TRADER JOE S","set_category_concept_id":"c-groc","set_display_name":"Trader Joe’s"}"""

        // Waving an offer off hides it and writes nothing.
        val dismissed = MoneyTransactionMachine.reduce(held, view(MoneyTransactionEvent(offer_dismissed = MoneyTransactionEvent.OfferDismissed(key = "rule"))))
        dismissed.effects.shouldBeEmpty()
        dismissed.state.screen.data_?.rule_offer.shouldBeNull()
        // The other offer stays until it is waved off too.
        dismissed.state.screen.data_?.transfer_offer.shouldNotBeNull()
    }

    "filing, naming and voiding are each one write, and void asks first" {
        val opened = open(MoneyTransactionMachine, MoneyTransactionEvent(opened = MoneyTransactionEvent.Opened(txn_id = "t1", draft_token = "tok")))
        val held = answeredWith(
            MoneyTransactionMachine,
            opened,
            AppQueryResponse(money_transaction = transaction(offers = false)),
            AppQueryResponse(money_categories = categories()),
        )
        val sheet = MoneyTransactionMachine.reduce(held, view(MoneyTransactionEvent(action = MoneyTransactionEvent.ActionPicked(key = "category"))))
        sheet.state.screen.sheet shouldBe MoneyTransactionState.Sheet.SHEET_CATEGORY
        sheet.state.screen.data_?.category_options?.map { it.key } shouldBe listOf("", "c-groc", "c-util")
        val filed = MoneyTransactionMachine.reduce(sheet.state, view(MoneyTransactionEvent(category = MoneyTransactionEvent.CategoryPicked(category_id = "c-groc"))))
        (filed.effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe """{"txn_ids":["t1"],"category_concept_id":"c-groc"}"""
        filed.state.screen.sheet shouldBe MoneyTransactionState.Sheet.SHEET_NONE
        // Clearing sends an explicit null.
        val cleared = MoneyTransactionMachine.reduce(held, view(MoneyTransactionEvent(category = MoneyTransactionEvent.CategoryPicked(category_id = ""))))
        (cleared.effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe """{"txn_ids":["t1"],"category_concept_id":null}"""

        val name = MoneyTransactionMachine.reduce(held, view(MoneyTransactionEvent(action = MoneyTransactionEvent.ActionPicked(key = "name"))))
        name.state.screen.name_draft shouldBe "Trader Joe’s"
        val typed = MoneyTransactionMachine.reduce(name.state, view(MoneyTransactionEvent(name_edited = MoneyTransactionEvent.NameEdited(text = "  TJ  "))))
        val saved = MoneyTransactionMachine.reduce(typed.state, view(MoneyTransactionEvent(name_saved = MoneyTransactionEvent.NameSaved())))
        (saved.effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe """{"txn_id":"t1","display_name":"TJ"}"""

        val ask = MoneyTransactionMachine.reduce(held, view(MoneyTransactionEvent(action = MoneyTransactionEvent.ActionPicked(key = "void"))))
        ask.effects.shouldBeEmpty()
        ask.state.screen.confirm?.destructive shouldBe true
        val voided = MoneyTransactionMachine.reduce(ask.state, view(MoneyTransactionEvent(confirm_accepted = MoneyTransactionEvent.ConfirmAccepted())))
        (voided.effects.single() as ScreenEffect.SubmitWrite).command shouldBe "money.void_transaction"
        val refused = MoneyTransactionMachine.reduce(
            voided.state,
            MoneyInput.Settled(WriteSettled(invoke_key = (voided.effects.single() as ScreenEffect.SubmitWrite).invokeKey, committed = false)),
        )
        refused.state.screen.status?.refused shouldBe true
        refused.state.screen.data_.shouldNotBeNull()
    }

    "a voided transaction offers no void and a missing one is not made up" {
        val opened = open(MoneyTransactionMachine, MoneyTransactionEvent(opened = MoneyTransactionEvent.Opened(txn_id = "t1")))
        val voided = answeredWith(
            MoneyTransactionMachine,
            opened,
            AppQueryResponse(money_transaction = transaction(offers = false).copy(flags = listOf(MoneyFlag.MONEY_FLAG_VOID))),
        )
        voided.screen.data_?.actions?.map { it.key } shouldBe listOf("category", "name")
        voided.screen.data_?.actions?.all { !it.enabled } shouldBe true
        voided.screen.data_?.amount_tone shouldBe StatusChip.Tone.TONE_SEAM
        val gone = answeredWith(MoneyTransactionMachine, opened, AppQueryResponse(money_transaction = MoneyTransaction(found = false)))
        gone.screen.data_.shouldBeNull()
        gone.screen.failure.shouldNotBeNull()
    }

    // --- Target --------------------------------------------------------------

    "the target sheet seeds from the stored plan, previews what is typed, and saves four facts" {
        val opened = open(
            MoneyTargetMachine,
            MoneyTargetEvent(opened = MoneyTargetEvent.Opened(month = "2026-10", category_id = "c-util", currency = "USD", draft_token = "tok")),
        )
        val first = MoneyTargetReads.requests(opened, CLOCK)!!.single().money_target_sheet.shouldNotBeNull()
        first.typing_amount_minor.shouldBeNull()
        val held = answeredWith(MoneyTargetMachine, opened, AppQueryResponse(money_target_sheet = targetSheet()))
        held.screen.amount_text shouldBe "220.00"
        held.screen.carry shouldBe false
        val data = held.screen.data_.shouldNotBeNull()
        data.title shouldBe "Utilities target"
        data.can_save shouldBe true
        data.figures.map { it.label } shouldBe listOf(MoneyCopy.TARGET_AVERAGE, MoneyCopy.TARGET_SPENT, MoneyCopy.TARGET_CARRIED_IN)
        data.preview_label shouldBe "November 2026 target"
        // Typing asks the core for the preview with the typed amount in minor units.
        val typed = MoneyTargetMachine.reduce(held, view(MoneyTargetEvent(amount = MoneyTargetEvent.AmountEdited(text = "231.40"))))
        MoneyTargetReads.requests(typed.state, CLOCK)!!.single().money_target_sheet?.typing_amount_minor shouldBe 23_140L
        val carry = MoneyTargetMachine.reduce(typed.state, view(MoneyTargetEvent(carry = MoneyTargetEvent.CarryToggled())))
        MoneyTargetReads.requests(carry.state, CLOCK)!!.single().money_target_sheet?.typing_carry shouldBe true
        val average = MoneyTargetMachine.reduce(carry.state, view(MoneyTargetEvent(use_average = MoneyTargetEvent.UseAverage())))
        average.state.screen.amount_text shouldBe "231.40"
        val save = MoneyTargetMachine.reduce(carry.state, view(MoneyTargetEvent(save = MoneyTargetEvent.Save())))
        val write = save.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "money.set_target"
        write.inputJson shouldBe """{"month":"2026-10","category_concept_id":"c-util","amount_minor":23140,"currency":"USD","carry":true}"""
        // Something that is not an amount cannot be saved.
        val bad = MoneyTargetMachine.reduce(held, view(MoneyTargetEvent(amount = MoneyTargetEvent.AmountEdited(text = "2x0"))))
        MoneyTargetMachine.reduce(bad.state, view(MoneyTargetEvent(save = MoneyTargetEvent.Save()))).effects.shouldBeEmpty()
        val remove = MoneyTargetMachine.reduce(held, view(MoneyTargetEvent(remove = MoneyTargetEvent.Remove())))
        (remove.effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe
            """{"month":"2026-10","category_concept_id":"c-util","amount_minor":null,"currency":"USD"}"""
    }

    "typed amounts parse by the currency's exponent, never as floats" {
        MoneyFold.parseAmount("220", 2) shouldBe 22_000L
        MoneyFold.parseAmount("231.4", 2) shouldBe 23_140L
        MoneyFold.parseAmount("1,234.56", 2) shouldBe 123_456L
        MoneyFold.parseAmount("4,250", 0) shouldBe 4_250L
        MoneyFold.parseAmount("0.05", 2) shouldBe 5L
        MoneyFold.parseAmount("1.234", 2).shouldBeNull()
        MoneyFold.parseAmount("-5", 2).shouldBeNull()
        MoneyFold.parseAmount("", 2).shouldBeNull()
        MoneyFold.amountText(23_140L, 2) shouldBe "231.40"
        MoneyFold.amountText(5L, 2) shouldBe "0.05"
        MoneyFold.amountText(4_250L, 0) shouldBe "4250"
    }

    // --- Recurring and search ------------------------------------------------

    "recurring charges say how often, when next, and whether this cycle's posted" {
        val opened = open(MoneyRecurringMachine, MoneyRecurringEvent(opened = MoneyRecurringEvent.Opened()))
        val held = answeredWith(
            MoneyRecurringMachine,
            opened,
            AppQueryResponse(
                money_recurring = MoneyRecurring(
                    today = "2026-10-14",
                    series = listOf(
                        MoneyRecurring.Line(
                            merchant = "Netflix",
                            account_label = "Amex",
                            cadence = MoneyCadence.MONEY_CADENCE_MONTHLY,
                            cadence_words = "every month",
                            amount = amount(1_549),
                            next_due = "2026-10-28",
                            status = MoneyRecurringStatus.MONEY_RECURRING_STATUS_DUE,
                            seen_times = 6,
                        ),
                    ),
                ),
            ),
        )
        val row = held.screen.data_?.rows.shouldNotBeNull().single()
        row.meta shouldBe "every month · Amex"
        row.detail shouldBe "next Oct 28 · seen 6 times"
        row.chips.single().label shouldBe MoneyCopy.CHIP_DUE
        row.amount?.minor shouldBe 1_549L
        val none = answeredWith(MoneyRecurringMachine, opened, AppQueryResponse(money_recurring = MoneyRecurring(today = "2026-10-14")))
        none.screen.data_?.empty?.headline shouldBe MoneyCopy.RECURRING_EMPTY
    }

    "search reads a term, drops a stale answer, and offers Ask on no match" {
        val start = open(MoneySearchMachine, MoneySearchEvent(opened = MoneySearchEvent.Opened()))
        start.screen.resting.shouldNotBeNull()
        MoneySearchReads.requests(start, CLOCK).shouldBeNull()
        MoneySearchMachine.reduce(start, MoneySearchMachine.rowsChanged("core_transaction", emptyList())!!).effects.shouldBeEmpty()
        val typed = MoneySearchMachine.reduce(start, view(MoneySearchEvent(term = MoneySearchEvent.TermChanged(term = "coffee"))))
        typed.effects shouldBe listOf(ScreenEffect.ReadPage("money.search", afterCursor = null))
        val request = MoneySearchReads.requests(typed.state, CLOCK)!!.single().money_search.shouldNotBeNull()
        request.term shouldBe "coffee"
        request.limit shouldBe MoneySearchMachine.LIMIT
        val none = MoneySearchMachine.reduce(typed.state, MoneyInput.Answered(listOf(AppQueryResponse(money_search = MoneySearch(term = "coffee"))))).state
        none.screen.data_?.empty?.headline shouldBe "Nothing matches coffee."
        none.screen.field_?.answered_term shouldBe "coffee"
        val hits = MoneySearchMachine.reduce(
            typed.state,
            MoneyInput.Answered(listOf(AppQueryResponse(money_search = MoneySearch(term = "coffee", rows = listOf(activityRow("t9", "Blue Bottle Coffee", -675)), total_matches = 3)))),
        ).state
        hits.screen.data_?.count_label shouldBe "1 of 3 matches"
        hits.screen.data_?.rows?.single()?.meta shouldContain "Oct 14"
        val cleared = MoneySearchMachine.reduce(hits, view(MoneySearchEvent(cleared = MoneySearchEvent.Cleared())))
        cleared.state.screen.resting.shouldNotBeNull()
        cleared.state.screen.data_.shouldBeNull()
    }

    // --- Import ---------------------------------------------------------------

    "importing a CSV: pick, plan, publish the plan's own input, then remember the layout" {
        val opened = answeredWith(
            MoneyImportMachine,
            open(MoneyImportMachine, MoneyImportEvent(opened = MoneyImportEvent.Opened(draft_token = "tok"))),
            AppQueryResponse(money_accounts = accounts()),
        )
        opened.screen.data_?.needs_account shouldBe true
        opened.screen.data_?.choose_label shouldBe MoneyCopy.IMPORT_CHOOSE
        // A CSV with two accounts waits for the member to choose one.
        val picked = MoneyImportMachine.reduce(opened, MoneyInput.Picked("Chase.csv", "a,b".encodeToByteArray())).state
        picked.job.shouldBeNull()
        picked.file?.name shouldBe "Chase.csv"
        picked.screen.status?.sentence shouldBe MoneyCopy.IMPORT_CHOOSE_ACCOUNT
        val account = MoneyImportMachine.reduce(picked, view(MoneyImportEvent(account_picked = MoneyImportEvent.AccountPicked(account_id = "a-chase")))).state
        account.job.shouldNotBeNull()
        account.screen.phase shouldBe MoneyImportState.Phase.PHASE_READING
        val ask = MoneyImportMachine.askOf(account).shouldNotBeNull()
        ask.source shouldBe MoneySource.MONEY_SOURCE_CSV
        ask.accountId shouldBe "a-chase"
        // NOTHING IS WRITTEN WHILE IT READS: the screen offers no Import.
        account.screen.data_?.publish_label shouldBe ""

        val planned = MoneyImportMachine.reduce(account, MoneyInput.Planned(account.job!!.token, MoneyPlanOutcome.Plan(plan()))).state
        planned.screen.phase shouldBe MoneyImportState.Phase.PHASE_PLANNED
        val data = planned.screen.data_.shouldNotBeNull()
        val statement = data.statements.single()
        statement.title shouldBe "Chase Total Checking"
        statement.counts.map { it.label to it.detail } shouldBe listOf(
            MoneyCopy.COUNT_NEW to "2",
            MoneyCopy.COUNT_ALREADY_IN to "1",
            MoneyCopy.COUNT_CHECK to "1",
            MoneyCopy.COUNT_REJECTED to "1",
        )
        // Every verdict a row can have is said, and a bad row says why.
        statement.rows.map { it.chip?.label } shouldContain MoneyCopy.CHIP_CHECK
        statement.rows.first { it.line_label == "Row 88" }.reason shouldBe "Amount has a letter O."
        statement.has_proposed shouldBe true
        statement.checkpoint?.amount?.minor shouldBe 318_452L
        statement.span shouldBe "Sep 15 to Oct 14"
        data.publish_label shouldBe "Import 2 rows"

        // Publishing is the ordinary command, with the plan's input UNCHANGED.
        val publish = MoneyImportMachine.reduce(planned, view(MoneyImportEvent(publish = MoneyImportEvent.Publish())))
        val write = publish.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "money.import_transactions"
        write.inputJson shouldBe """{"account_id":"a-chase","rows":[1,2]}"""
        publish.state.screen.phase shouldBe MoneyImportState.Phase.PHASE_PUBLISHING
        // A second tap while it is out writes nothing.
        MoneyImportMachine.reduce(publish.state, view(MoneyImportEvent(publish = MoneyImportEvent.Publish()))).effects.shouldBeEmpty()

        // Committed: the file is dropped, the layout is remembered, the rows are said.
        val done = MoneyImportMachine.reduce(publish.state, MoneyInput.Settled(WriteSettled(invoke_key = write.invokeKey, committed = true)))
        done.state.screen.phase shouldBe MoneyImportState.Phase.PHASE_PUBLISHED
        done.state.file?.bytes?.size shouldBe 0
        done.state.screen.status?.sentence shouldBe "Imported 2 rows"
        val profile = done.effects.single() as ScreenEffect.SubmitWrite
        profile.command shouldBe "money.save_import_profile"
        profile.inputJson shouldContain """"account_id":"a-chase""""
        profile.inputJson shouldContain """"header_fingerprint":"date,desc,amount""""
        profile.inputJson shouldContain """"amount_col":2"""
        profile.inputJson shouldNotContain "debit_col"
        // The profile's own settle is nothing to the page.
        MoneyImportMachine.reduce(done.state, MoneyInput.Settled(WriteSettled(invoke_key = profile.invokeKey, committed = true))).state shouldBe done.state
    }

    "a refused publish keeps the plan so Import can be tried again" {
        val planned = plannedImport()
        val publish = MoneyImportMachine.reduce(planned, view(MoneyImportEvent(publish = MoneyImportEvent.Publish())))
        val key = (publish.effects.single() as ScreenEffect.SubmitWrite).invokeKey
        val refused = MoneyImportMachine.reduce(publish.state, MoneyInput.Settled(WriteSettled(invoke_key = key, committed = false))).state
        refused.screen.phase shouldBe MoneyImportState.Phase.PHASE_PLANNED
        refused.plan.shouldNotBeNull()
        refused.screen.status?.refused shouldBe true
        MoneyImportMachine.reduce(refused, view(MoneyImportEvent(publish = MoneyImportEvent.Publish()))).effects.size shouldBe 1
    }

    "the rows proposed as duplicates are skipped unless the member says otherwise" {
        val planned = plannedImport()
        val keep = MoneyImportMachine.reduce(planned, view(MoneyImportEvent(keep_proposed = MoneyImportEvent.KeepProposedToggled()))).state
        keep.screen.keep_proposed shouldBe true
        keep.screen.data_?.publish_label shouldBe "Import 3 rows"
        val publish = MoneyImportMachine.reduce(keep, view(MoneyImportEvent(publish = MoneyImportEvent.Publish())))
        (publish.effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe """{"account_id":"a-chase","rows":[1,2,3]}"""
    }

    "a file that cannot name its date order asks, and the answer plans it again" {
        val opened = answeredWith(
            MoneyImportMachine,
            open(MoneyImportMachine, MoneyImportEvent(opened = MoneyImportEvent.Opened(draft_token = "tok"))),
            AppQueryResponse(money_accounts = accounts(single = true)),
        )
        // The only account is the account: nothing to ask, and an OFX file is sniffed by its header.
        val picked = MoneyImportMachine.reduce(opened, MoneyInput.Picked("download", "OFXHEADER:100".encodeToByteArray())).state
        MoneyImportMachine.askOf(picked)!!.source shouldBe MoneySource.MONEY_SOURCE_OFX
        val csv = MoneyImportMachine.reduce(opened, MoneyInput.Picked("a.csv", "d,a".encodeToByteArray())).state
        csv.screen.account_id shouldBe "a-chase"
        csv.job.shouldNotBeNull()
        val asked = MoneyImportMachine.reduce(
            csv,
            MoneyInput.Planned(
                csv.job!!.token,
                MoneyPlanOutcome.Plan(
                    MoneyImportPlan(
                        statements = listOf(
                            MoneyStatementPlan(
                                account_id = "a-chase",
                                account_label = "Chase Total Checking",
                                question = MoneyDateOrderQuestion(
                                    samples = listOf("03/04/2026"),
                                    options = listOf(MoneyDateOrder.MONEY_DATE_ORDER_MDY, MoneyDateOrder.MONEY_DATE_ORDER_DMY),
                                ),
                            ),
                        ),
                    ),
                ),
            ),
        ).state
        val question = asked.screen.data_?.statements?.single()?.question.shouldNotBeNull()
        question.options.map { it.key } shouldBe listOf("mdy", "dmy")
        question.samples shouldBe listOf("03/04/2026")
        // WHILE IT IS ASKED THERE IS NOTHING TO IMPORT.
        asked.screen.data_?.publish_label shouldBe ""
        val answered = MoneyImportMachine.reduce(asked, view(MoneyImportEvent(date_order = MoneyImportEvent.DateOrderAnswered(order = "dmy")))).state
        MoneyImportMachine.askOf(answered)!!.dateOrder shouldBe MoneyDateOrder.MONEY_DATE_ORDER_DMY
        answered.job.shouldNotBeNull()
        answered.screen.phase shouldBe MoneyImportState.Phase.PHASE_READING
    }

    "leaving drops the file and the plan; a refusal of the whole file is a sentence" {
        val planned = plannedImport()
        val left = MoneyImportMachine.reduce(planned, view(MoneyImportEvent(left = MoneyImportEvent.Left()))).state
        left.file.shouldBeNull()
        left.plan.shouldBeNull()
        left.screen.phase shouldBe MoneyImportState.Phase.PHASE_IDLE
        MoneyImportMachine.left().shouldNotBeNull()
        val refused = MoneyImportMachine.reduce(
            planned.copy(job = dev.centraid.shared.apps.money.MoneyJob(7)),
            MoneyInput.Planned(7, MoneyPlanOutcome.Plan(MoneyImportPlan(refusal = "This file is too large."))),
        ).state
        refused.screen.data_?.refusal shouldBe "This file is too large."
        refused.screen.data_?.publish_label shouldBe ""
        // A plan nobody asked for (an old token) is not drawn.
        MoneyImportMachine.reduce(planned, MoneyInput.Planned(99, MoneyPlanOutcome.Plan(MoneyImportPlan()))).state shouldBe planned
    }

    // --- Accounts, rules, categories -------------------------------------------

    "accounts group by budget, never add currencies, and write add and edit with the bank's number" {
        val opened = open(MoneyAccountsMachine, MoneyAccountsEvent(opened = MoneyAccountsEvent.Opened(draft_token = "tok")))
        MoneyAccountsReads.requests(opened, CLOCK)!!.single().money_accounts?.tz shouldBe "Europe/Lisbon"
        val held = answeredWith(MoneyAccountsMachine, opened, AppQueryResponse(money_accounts = accounts()))
        val data = held.screen.data_.shouldNotBeNull()
        data.sections.map { it.title } shouldBe listOf(MoneyCopy.ON_BUDGET, MoneyCopy.OFF_BUDGET)
        data.net_worth.map { it.amount?.currency } shouldBe listOf("USD", "CAD")
        data.net_worth_note shouldBe MoneyCopy.NET_WORTH_NOTE
        val chase = data.sections[0].rows[0]
        chase.meta shouldBe "····2291 · Checking · USD"
        chase.checkpoint_line shouldBe "Matches Sep 30 statement"
        val amex = data.sections[0].rows[1]
        amex.has_delta shouldBe true
        amex.checkpoint_tone shouldBe StatusChip.Tone.TONE_WARNING
        data.sections[1].rows.single().checkpoint_line shouldBe MoneyCopy.CHECKPOINT_NONE

        val add = MoneyAccountsMachine.reduce(held, view(MoneyAccountsEvent(add = MoneyAccountsEvent.AddTapped()))).state
        add.screen.editor?.can_save shouldBe false
        val named = MoneyAccountsMachine.reduce(add, view(MoneyAccountsEvent(name = MoneyAccountsEvent.NameEdited(text = "Tangerine")))).state
        val number = MoneyAccountsMachine.reduce(named, view(MoneyAccountsEvent(external_ref = MoneyAccountsEvent.ExternalRefEdited(text = "000123456")))).state
        val currency = MoneyAccountsMachine.reduce(number, view(MoneyAccountsEvent(currency = MoneyAccountsEvent.CurrencyEdited(text = "cad")))).state
        val save = MoneyAccountsMachine.reduce(currency, view(MoneyAccountsEvent(save = MoneyAccountsEvent.Save())))
        val write = save.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "money.add_account"
        write.inputJson shouldBe
            """{"account_id":"account-tok-1","name":"Tangerine","kind":"checking","currency":"CAD","on_budget":true,"external_ref":"000123456"}"""
        // A bad currency code cannot be saved.
        val bad = MoneyAccountsMachine.reduce(currency, view(MoneyAccountsEvent(currency = MoneyAccountsEvent.CurrencyEdited(text = "ca"))))
        MoneyAccountsMachine.reduce(bad.state, view(MoneyAccountsEvent(save = MoneyAccountsEvent.Save()))).effects.shouldBeEmpty()
        // Saved: the sheet goes.
        val done = MoneyAccountsMachine.reduce(save.state, MoneyInput.Settled(WriteSettled(invoke_key = write.invokeKey, committed = true))).state
        done.screen.editor.shouldBeNull()
        done.screen.status?.sentence shouldBe MoneyCopy.DONE_ACCOUNT

        // Editing sends only what changed about closing.
        val edit = MoneyAccountsMachine.reduce(held, view(MoneyAccountsEvent(account = MoneyAccountsEvent.AccountPicked(account_id = "a-chase")))).state
        val rename = MoneyAccountsMachine.reduce(edit, view(MoneyAccountsEvent(name = MoneyAccountsEvent.NameEdited(text = "Chase Main")))).state
        val renamed = MoneyAccountsMachine.reduce(rename, view(MoneyAccountsEvent(save = MoneyAccountsEvent.Save())))
        (renamed.effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe
            """{"account_id":"a-chase","name":"Chase Main","kind":"checking","on_budget":true}"""
        val close = MoneyAccountsMachine.reduce(rename, view(MoneyAccountsEvent(closed = MoneyAccountsEvent.ClosedToggled()))).state
        (MoneyAccountsMachine.reduce(close, view(MoneyAccountsEvent(save = MoneyAccountsEvent.Save()))).effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe
            """{"account_id":"a-chase","name":"Chase Main","kind":"checking","on_budget":true,"closed_on":"2026-10-14"}"""
    }

    "rules add, edit, delete and apply to history, each after the member decides" {
        val opened = open(MoneyRulesMachine, MoneyRulesEvent(opened = MoneyRulesEvent.Opened(draft_token = "tok")))
        MoneyRulesReads.requests(opened, CLOCK)!!.mapNotNull { it.money_accounts?.tz } shouldBe listOf("Europe/Lisbon")
        val held = answeredWith(
            MoneyRulesMachine,
            opened,
            AppQueryResponse(money_rules = rules()),
            AppQueryResponse(money_categories = categories()),
            AppQueryResponse(money_accounts = accounts()),
        )
        val data = held.screen.data_.shouldNotBeNull()
        data.rows.single().title shouldBe "TRADER JOE S"
        data.rows.single().meta shouldBe "contains · files under Groceries · names it Trader Joe’s"
        data.limit_line shouldBe "1 of 500"

        val add = MoneyRulesMachine.reduce(held, view(MoneyRulesEvent(add = MoneyRulesEvent.AddTapped()))).state
        add.screen.editor?.can_save shouldBe false
        val pattern = MoneyRulesMachine.reduce(add, view(MoneyRulesEvent(pattern = MoneyRulesEvent.PatternEdited(text = "BLUE BOTTLE")))).state
        // A rule needs an effect: a category or a name.
        pattern.screen.editor?.can_save shouldBe false
        val sheet = MoneyRulesMachine.reduce(pattern, view(MoneyRulesEvent(category_sheet = MoneyRulesEvent.CategorySheetOpened()))).state
        sheet.screen.sheet shouldBe MoneyRulesState.Sheet.SHEET_CATEGORY
        val filed = MoneyRulesMachine.reduce(sheet, view(MoneyRulesEvent(category = MoneyRulesEvent.CategoryPicked(category_id = "c-groc")))).state
        filed.screen.editor?.category_label shouldBe "Groceries"
        filed.screen.sheet shouldBe MoneyRulesState.Sheet.SHEET_EDITOR
        val save = MoneyRulesMachine.reduce(filed, view(MoneyRulesEvent(save = MoneyRulesEvent.Save())))
        (save.effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe
            """{"rule_id":"rule-tok-1","match_kind":"contains","pattern":"BLUE BOTTLE","set_category_concept_id":"c-groc"}"""

        // Editing sends every field this page shows, and clears nothing it cannot name.
        val edit = MoneyRulesMachine.reduce(held, view(MoneyRulesEvent(rule = MoneyRulesEvent.RulePicked(rule_id = "r1")))).state
        edit.screen.editor?.category_id shouldBe "c-groc"
        val saved = MoneyRulesMachine.reduce(edit, view(MoneyRulesEvent(save = MoneyRulesEvent.Save())))
        (saved.effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe
            """{"rule_id":"r1","match_kind":"contains","pattern":"TRADER JOE S","set_category_concept_id":"c-groc","set_display_name":"Trader Joe’s","amount_min_minor":null,"amount_max_minor":null,"account_id":null}"""

        // Delete and apply both ask first.
        val delete = MoneyRulesMachine.reduce(edit, view(MoneyRulesEvent(delete = MoneyRulesEvent.DeleteTapped())))
        delete.effects.shouldBeEmpty()
        delete.state.screen.confirm?.destructive shouldBe true
        (MoneyRulesMachine.reduce(delete.state, view(MoneyRulesEvent(confirm_accepted = MoneyRulesEvent.ConfirmAccepted()))).effects.single() as ScreenEffect.SubmitWrite)
            .command shouldBe "money.delete_rule"
        val applyOne = MoneyRulesMachine.reduce(edit, view(MoneyRulesEvent(apply = MoneyRulesEvent.ApplyTapped())))
        applyOne.effects.shouldBeEmpty()
        (MoneyRulesMachine.reduce(applyOne.state, view(MoneyRulesEvent(confirm_accepted = MoneyRulesEvent.ConfirmAccepted()))).effects.single() as ScreenEffect.SubmitWrite)
            .inputJson shouldBe """{"rule_id":"r1"}"""
        val applyAll = MoneyRulesMachine.reduce(held, view(MoneyRulesEvent(apply = MoneyRulesEvent.ApplyTapped())))
        (MoneyRulesMachine.reduce(applyAll.state, view(MoneyRulesEvent(confirm_accepted = MoneyRulesEvent.ConfirmAccepted()))).effects.single() as ScreenEffect.SubmitWrite)
            .inputJson shouldBe "{}"
        MoneyRulesMachine.reduce(applyAll.state, view(MoneyRulesEvent(confirm_dismissed = MoneyRulesEvent.ConfirmDismissed()))).state.screen.confirm.shouldBeNull()
    }

    "the bank's number is removed by its own action, after a confirm, and the mask is never sent" {
        val opened = open(MoneyAccountsMachine, MoneyAccountsEvent(opened = MoneyAccountsEvent.Opened(draft_token = "tok")))
        val held = answeredWith(MoneyAccountsMachine, opened, AppQueryResponse(money_accounts = accounts()))
        val edit = MoneyAccountsMachine.reduce(held, view(MoneyAccountsEvent(account = MoneyAccountsEvent.AccountPicked(account_id = "a-chase")))).state
        val editor = edit.screen.editor.shouldNotBeNull()
        editor.has_external_ref shouldBe true
        editor.remove_number_label shouldBe MoneyCopy.ACCOUNT_REMOVE_NUMBER
        editor.can_remove_number shouldBe true
        // The field starts empty: the last four digits are never put in it.
        editor.external_ref shouldBe ""

        // It asks first, and a dismissed ask writes nothing.
        val ask = MoneyAccountsMachine.reduce(edit, view(MoneyAccountsEvent(remove_number = MoneyAccountsEvent.RemoveNumberTapped())))
        ask.effects.shouldBeEmpty()
        ask.state.screen.confirm?.destructive shouldBe true
        ask.state.screen.confirm?.title shouldBe MoneyCopy.ACCOUNT_REMOVE_NUMBER_TITLE
        MoneyAccountsMachine.reduce(ask.state, view(MoneyAccountsEvent(confirm_dismissed = MoneyAccountsEvent.ConfirmDismissed())))
            .let { it.effects.shouldBeEmpty(); it.state.screen.confirm.shouldBeNull() }

        // Confirmed: the number alone, as null.
        val sent = MoneyAccountsMachine.reduce(ask.state, view(MoneyAccountsEvent(confirm_accepted = MoneyAccountsEvent.ConfirmAccepted())))
        val write = sent.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "money.edit_account"
        write.inputJson shouldBe """{"account_id":"a-chase","external_ref":null}"""
        write.inputJson.contains("2291") shouldBe false
        sent.state.screen.confirm.shouldBeNull()
        val done = MoneyAccountsMachine.reduce(sent.state, MoneyInput.Settled(WriteSettled(invoke_key = write.invokeKey, committed = true))).state
        done.screen.editor.shouldBeNull()
        done.screen.status?.sentence shouldBe MoneyCopy.ACCOUNT_NUMBER_REMOVED

        // Typing a new number still replaces it, and an empty field keeps it.
        val typed = MoneyAccountsMachine.reduce(edit, view(MoneyAccountsEvent(external_ref = MoneyAccountsEvent.ExternalRefEdited(text = " 777001 ")))).state
        (MoneyAccountsMachine.reduce(typed, view(MoneyAccountsEvent(save = MoneyAccountsEvent.Save()))).effects.single() as ScreenEffect.SubmitWrite)
            .inputJson shouldBe """{"account_id":"a-chase","name":"Chase Total Checking","kind":"checking","on_budget":true,"external_ref":"777001"}"""

        // An account with no number offers nothing to remove.
        val bare = accounts().copy(off_budget = accounts().off_budget.map { it.copy(mask = null) })
        val bareHeld = answeredWith(MoneyAccountsMachine, opened, AppQueryResponse(money_accounts = bare))
        val bareEdit = MoneyAccountsMachine.reduce(bareHeld, view(MoneyAccountsEvent(account = MoneyAccountsEvent.AccountPicked(account_id = "a-tang")))).state
        bareEdit.screen.editor?.remove_number_label shouldBe ""
        bareEdit.screen.editor?.can_remove_number shouldBe false
        MoneyAccountsMachine.reduce(bareEdit, view(MoneyAccountsEvent(remove_number = MoneyAccountsEvent.RemoveNumberTapped())))
            .state.screen.confirm.shouldBeNull()
        // A new account has no number to remove either.
        val add = MoneyAccountsMachine.reduce(held, view(MoneyAccountsEvent(add = MoneyAccountsEvent.AddTapped()))).state
        add.screen.editor?.remove_number_label shouldBe ""
    }

    "a rule's limits and account are shown in its account's currency and sent back as they stand" {
        val held = rulesHeld(limitedRules())
        val edit = MoneyRulesMachine.reduce(held, view(MoneyRulesEvent(rule = MoneyRulesEvent.RulePicked(rule_id = "r2")))).state
        val editor = edit.screen.editor.shouldNotBeNull()
        editor.account_id shouldBe "a-chase"
        editor.account_label shouldBe "Chase Total Checking"
        editor.amount_min_text shouldBe "5.00"
        editor.amount_max_text shouldBe "200.00"
        editor.amount_min shouldBe centraid.screen.v1.Money(minor = 500, currency = "USD", exponent = 2)
        editor.amount_max shouldBe centraid.screen.v1.Money(minor = 20_000, currency = "USD", exponent = 2)
        editor.amount_min_label shouldBe "Smallest amount · USD"
        editor.amount_max_label shouldBe "Largest amount · USD"
        editor.limits_enabled shouldBe true
        editor.amount_note shouldBe MoneyCopy.RULE_AMOUNT_NOTE

        // UNTOUCHED: the same values go back.
        val untouched = MoneyRulesMachine.reduce(edit, view(MoneyRulesEvent(save = MoneyRulesEvent.Save())))
        (untouched.effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe
            """{"rule_id":"r2","match_kind":"contains","pattern":"COSTCO","set_category_concept_id":"c-groc","set_display_name":null,"amount_min_minor":500,"amount_max_minor":20000,"account_id":"a-chase"}"""

        // EDITED: the typed amounts, in minor units.
        val min = MoneyRulesMachine.reduce(edit, view(MoneyRulesEvent(amount_min = MoneyRulesEvent.AmountMinEdited(text = "10")))).state
        val max = MoneyRulesMachine.reduce(min, view(MoneyRulesEvent(amount_max = MoneyRulesEvent.AmountMaxEdited(text = "250.50")))).state
        (MoneyRulesMachine.reduce(max, view(MoneyRulesEvent(save = MoneyRulesEvent.Save()))).effects.single() as ScreenEffect.SubmitWrite)
            .inputJson shouldBe
            """{"rule_id":"r2","match_kind":"contains","pattern":"COSTCO","set_category_concept_id":"c-groc","set_display_name":null,"amount_min_minor":1000,"amount_max_minor":25050,"account_id":"a-chase"}"""

        // CLEARED: each limit and the account go as null.
        val noMin = MoneyRulesMachine.reduce(edit, view(MoneyRulesEvent(amount_min = MoneyRulesEvent.AmountMinEdited(text = "")))).state
        val noMax = MoneyRulesMachine.reduce(noMin, view(MoneyRulesEvent(amount_max = MoneyRulesEvent.AmountMaxEdited(text = "  ")))).state
        val sheet = MoneyRulesMachine.reduce(noMax, view(MoneyRulesEvent(account_sheet = MoneyRulesEvent.AccountSheetOpened()))).state
        sheet.screen.sheet shouldBe MoneyRulesState.Sheet.SHEET_ACCOUNT
        val options = sheet.screen.data_?.account_options.shouldNotBeNull()
        options.map { it.key } shouldBe listOf("", "a-chase", "a-amex", "a-tang")
        options.first().label shouldBe MoneyCopy.RULE_ACCOUNT_ANY
        options.first { it.selected }.key shouldBe "a-chase"
        sheet.screen.data_?.account_sheet_title shouldBe MoneyCopy.RULE_ACCOUNT_SHEET_TITLE
        val any = MoneyRulesMachine.reduce(sheet, view(MoneyRulesEvent(account = MoneyRulesEvent.AccountPicked(account_id = "")))).state
        any.screen.sheet shouldBe MoneyRulesState.Sheet.SHEET_EDITOR
        any.screen.editor?.account_label shouldBe ""
        (MoneyRulesMachine.reduce(any, view(MoneyRulesEvent(save = MoneyRulesEvent.Save()))).effects.single() as ScreenEffect.SubmitWrite)
            .inputJson shouldBe
            """{"rule_id":"r2","match_kind":"contains","pattern":"COSTCO","set_category_concept_id":"c-groc","set_display_name":null,"amount_min_minor":null,"amount_max_minor":null,"account_id":null}"""

        // Closing the account sheet returns to the editor with the account as it was.
        MoneyRulesMachine.reduce(sheet, view(MoneyRulesEvent(sheet_closed = MoneyRulesEvent.SheetClosed()))).state.screen.sheet shouldBe
            MoneyRulesState.Sheet.SHEET_EDITOR
    }

    "a rule's smallest amount above its largest is refused, with a sentence" {
        val held = rulesHeld(limitedRules())
        val edit = MoneyRulesMachine.reduce(held, view(MoneyRulesEvent(rule = MoneyRulesEvent.RulePicked(rule_id = "r2")))).state
        val min = MoneyRulesMachine.reduce(edit, view(MoneyRulesEvent(amount_min = MoneyRulesEvent.AmountMinEdited(text = "300")))).state
        min.screen.editor?.can_save shouldBe false
        min.screen.editor?.issue shouldBe MoneyCopy.RULE_LIMITS_ORDER
        MoneyRulesMachine.reduce(min, view(MoneyRulesEvent(save = MoneyRulesEvent.Save()))).effects.shouldBeEmpty()
        // Equal is allowed; one limit alone is never compared.
        val equal = MoneyRulesMachine.reduce(min, view(MoneyRulesEvent(amount_min = MoneyRulesEvent.AmountMinEdited(text = "200")))).state
        equal.screen.editor?.can_save shouldBe true
        val onlyMin = MoneyRulesMachine.reduce(min, view(MoneyRulesEvent(amount_max = MoneyRulesEvent.AmountMaxEdited(text = "")))).state
        onlyMin.screen.editor?.can_save shouldBe true
        // Words that are not an amount are refused too.
        val words = MoneyRulesMachine.reduce(edit, view(MoneyRulesEvent(amount_max = MoneyRulesEvent.AmountMaxEdited(text = "lots")))).state
        words.screen.editor?.can_save shouldBe false
        words.screen.editor?.issue shouldBe MoneyCopy.AMOUNT_INVALID
        MoneyRulesMachine.reduce(words, view(MoneyRulesEvent(save = MoneyRulesEvent.Save()))).effects.shouldBeEmpty()
    }

    "a rule's limits lock where no one exponent is known, and go back unchanged" {
        val yen = accounts().copy(
            off_budget = accounts().off_budget + MoneyAccounts.AccountLine(
                account_id = "a-yen",
                name = "Yen Wallet",
                kind = "cash",
                currency = "JPY",
                balance = amount(5_000, "JPY", 0),
            ),
        )
        val held = rulesHeld(limitedRules(), yen)
        // r3 names no account, and the accounts disagree about decimals.
        val edit = MoneyRulesMachine.reduce(held, view(MoneyRulesEvent(rule = MoneyRulesEvent.RulePicked(rule_id = "r3")))).state
        val locked = edit.screen.editor.shouldNotBeNull()
        locked.limits_enabled shouldBe false
        locked.amount_note shouldBe MoneyCopy.RULE_LIMITS_LOCKED_NOTE
        locked.amount_min_label shouldBe MoneyCopy.RULE_AMOUNT_MIN
        locked.amount_min_text shouldBe ""
        (MoneyRulesMachine.reduce(edit, view(MoneyRulesEvent(save = MoneyRulesEvent.Save()))).effects.single() as ScreenEffect.SubmitWrite)
            .inputJson shouldBe
            """{"rule_id":"r3","match_kind":"contains","pattern":"ATM","set_category_concept_id":"c-util","set_display_name":null,"amount_min_minor":500,"amount_max_minor":null,"account_id":null}"""
        // Naming an account says which decimals the limits are in: they show.
        val named = MoneyRulesMachine.reduce(edit, view(MoneyRulesEvent(account = MoneyRulesEvent.AccountPicked(account_id = "a-yen")))).state
        named.screen.editor?.limits_enabled shouldBe true
        named.screen.editor?.amount_min_text shouldBe "500"
        named.screen.editor?.amount_max_text shouldBe ""
        named.screen.editor?.amount_max_label shouldBe "Largest amount · JPY"
        named.screen.editor?.amount_note shouldBe "${MoneyCopy.RULE_AMOUNT_NOTE} ${MoneyCopy.WHOLE_UNITS}"
        (MoneyRulesMachine.reduce(named, view(MoneyRulesEvent(save = MoneyRulesEvent.Save()))).effects.single() as ScreenEffect.SubmitWrite)
            .inputJson shouldBe
            """{"rule_id":"r3","match_kind":"contains","pattern":"ATM","set_category_concept_id":"c-util","set_display_name":null,"amount_min_minor":500,"amount_max_minor":null,"account_id":"a-yen"}"""

        // An account the page cannot name stays as it is, with its limits locked.
        val strange = MoneyRules(
            limit = 500,
            rules = listOf(
                MoneyRules.RuleLine(
                    rule_id = "r4",
                    kind = MoneyMatchKind.MONEY_MATCH_KIND_IS,
                    pattern = "OLD",
                    amount_max = 9_900,
                    account_label = "Closed Elsewhere",
                    display_name = "Old",
                ),
            ),
        )
        val strangeEdit = MoneyRulesMachine.reduce(
            rulesHeld(strange),
            view(MoneyRulesEvent(rule = MoneyRulesEvent.RulePicked(rule_id = "r4"))),
        ).state
        strangeEdit.screen.editor?.limits_enabled shouldBe false
        (MoneyRulesMachine.reduce(strangeEdit, view(MoneyRulesEvent(save = MoneyRulesEvent.Save()))).effects.single() as ScreenEffect.SubmitWrite)
            .inputJson shouldBe
            """{"rule_id":"r4","match_kind":"is","pattern":"OLD","set_category_concept_id":null,"set_display_name":"Old","amount_min_minor":null,"amount_max_minor":9900}"""
    }

    "a new rule can carry limits and an account, and sends only what is set" {
        val held = rulesHeld(rules())
        val add = MoneyRulesMachine.reduce(held, view(MoneyRulesEvent(add = MoneyRulesEvent.AddTapped()))).state
        val editor = add.screen.editor.shouldNotBeNull()
        // Every account has two decimals, so the limits are typed in them.
        editor.limits_enabled shouldBe true
        val pattern = MoneyRulesMachine.reduce(add, view(MoneyRulesEvent(pattern = MoneyRulesEvent.PatternEdited(text = "COSTCO")))).state
        val named = MoneyRulesMachine.reduce(pattern, view(MoneyRulesEvent(name = MoneyRulesEvent.NameEdited(text = "Costco")))).state
        val max = MoneyRulesMachine.reduce(named, view(MoneyRulesEvent(amount_max = MoneyRulesEvent.AmountMaxEdited(text = "150")))).state
        val account = MoneyRulesMachine.reduce(max, view(MoneyRulesEvent(account = MoneyRulesEvent.AccountPicked(account_id = "a-amex")))).state
        (MoneyRulesMachine.reduce(account, view(MoneyRulesEvent(save = MoneyRulesEvent.Save()))).effects.single() as ScreenEffect.SubmitWrite)
            .inputJson shouldBe
            """{"rule_id":"rule-tok-1","match_kind":"contains","pattern":"COSTCO","set_display_name":"Costco","amount_max_minor":15000,"account_id":"a-amex"}"""
        // An account that is not among the answered ones is not taken.
        MoneyRulesMachine.reduce(max, view(MoneyRulesEvent(account = MoneyRulesEvent.AccountPicked(account_id = "a-nope")))).state shouldBe max
    }

    "categories add under a group, archive and restore, and merge only after a confirm" {
        val opened = open(MoneyCategoriesMachine, MoneyCategoriesEvent(opened = MoneyCategoriesEvent.Opened(draft_token = "tok")))
        val held = answeredWith(MoneyCategoriesMachine, opened, AppQueryResponse(money_categories = categories()))
        held.screen.data_?.groups?.map { it.label } shouldBe listOf("Food", "Home")

        val add = MoneyCategoriesMachine.reduce(held, view(MoneyCategoriesEvent(add = MoneyCategoriesEvent.AddTapped()))).state
        add.screen.sheet shouldBe MoneyCategoriesState.Sheet.SHEET_ADD
        MoneyCategoriesMachine.reduce(add, view(MoneyCategoriesEvent(save = MoneyCategoriesEvent.Save()))).effects.shouldBeEmpty()
        val named = MoneyCategoriesMachine.reduce(add, view(MoneyCategoriesEvent(name = MoneyCategoriesEvent.NameEdited(text = " Coffee ")))).state
        val grouped = MoneyCategoriesMachine.reduce(named, view(MoneyCategoriesEvent(group = MoneyCategoriesEvent.GroupPicked(group_id = "g-food")))).state
        (MoneyCategoriesMachine.reduce(grouped, view(MoneyCategoriesEvent(save = MoneyCategoriesEvent.Save()))).effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe
            """{"category_id":"category-tok-1","name":"Coffee","parent_concept_id":"g-food"}"""

        val row = MoneyCategoriesMachine.reduce(held, view(MoneyCategoriesEvent(category = MoneyCategoriesEvent.CategoryPicked(category_id = "c-groc")))).state
        row.screen.data_?.row_actions?.map { it.key } shouldBe listOf("merge", "archive")
        val archive = MoneyCategoriesMachine.reduce(row, view(MoneyCategoriesEvent(row_action = MoneyCategoriesEvent.RowActionPicked(key = "archive"))))
        (archive.effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe """{"concept_id":"c-groc","archived":true}"""

        val merge = MoneyCategoriesMachine.reduce(row, view(MoneyCategoriesEvent(row_action = MoneyCategoriesEvent.RowActionPicked(key = "merge"))))
        merge.state.screen.data_?.merge_options?.map { it.key } shouldBe listOf("c-util")
        val into = MoneyCategoriesMachine.reduce(merge.state, view(MoneyCategoriesEvent(merge_into = MoneyCategoriesEvent.MergeIntoPicked(category_id = "c-util"))))
        // Nothing moves until the member confirms.
        into.effects.shouldBeEmpty()
        into.state.screen.confirm?.body shouldBe "Rows filed under Groceries move to Utilities."
        val done = MoneyCategoriesMachine.reduce(into.state, view(MoneyCategoriesEvent(confirm_accepted = MoneyCategoriesEvent.ConfirmAccepted())))
        (done.effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe """{"from_concept_id":"c-groc","into_concept_id":"c-util"}"""
    }

    // --- Home's tile -------------------------------------------------------------

    "Home's tile draws this month's spending per currency, and day one says what to do" {
        val tile = HomeMoneyTile.arrived(
            MoneyHomeTile(month = "2026-10", spent = listOf(amount(331_458), amount(12_000, "CAD"))),
        ).tile.shouldNotBeNull()
        tile.app_id shouldBe "money"
        tile.status shouldBe TileStatus.TILE_STATUS_CONTENT
        tile.count.shouldBeNull()
        val body = tile.body?.money.shouldNotBeNull()
        body.amounts.map { it.currency to it.minor } shouldBe listOf("USD" to 331_458L, "CAD" to 12_000L)
        body.caption shouldBe "spent in October"
        val empty = HomeMoneyTile.arrived(MoneyHomeTile(empty = true)).tile.shouldNotBeNull()
        empty.status shouldBe TileStatus.TILE_STATUS_EMPTY
        empty.body.shouldBeNull()
        HomeMoneyTile.request(CLOCK).home_tile?.tz shouldBe "Europe/Lisbon"
        TileBody(money = TileBody.Spent()).money.shouldNotBeNull()
    }
}) {
    companion object {
        val CLOCK = DeviceClock.Reading(zone = "Europe/Lisbon", epochMillis = 1_791_000_000_000L)

        fun <E> view(event: E): MoneyInput<E> = MoneyInput.View(event)

        fun <S, E> open(machine: ScreenMachine<MoneyHeld<S>, MoneyInput<E>>, event: E): MoneyHeld<S> =
            machine.reduce(machine.initial(), MoneyInput.View(event)).state

        fun <S, E> answered(machine: ScreenMachine<MoneyHeld<S>, MoneyInput<E>>, held: MoneyHeld<S>, answer: MoneySpending): MoneyHeld<S> =
            answeredWith(machine, held, AppQueryResponse(money_spending = answer))

        fun <S, E> answered(machine: ScreenMachine<MoneyHeld<S>, MoneyInput<E>>, held: MoneyHeld<S>, answer: MoneyCashflow): MoneyHeld<S> =
            answeredWith(machine, held, AppQueryResponse(money_cashflow = answer))

        fun <S, E> answeredWith(
            machine: ScreenMachine<MoneyHeld<S>, MoneyInput<E>>,
            held: MoneyHeld<S>,
            vararg responses: AppQueryResponse,
        ): MoneyHeld<S> = machine.reduce(held, MoneyInput.Answered(responses.toList())).state

        fun amount(minor: Long, currency: String = "USD", exponent: Int = 2) =
            MoneyAmount(minor = minor, currency = currency, exponent = exponent)

        fun spending() = MoneySpending(
            month = "2026-10",
            today = "2026-10-14",
            day_of_month = 14,
            days_in_month = 31,
            days_left = 17,
            per_currency = listOf(
                MoneySpending.SpendingCurrency(
                    spent = amount(331_458),
                    planned = amount(378_500),
                    left = amount(47_042),
                    progress_bp = 8_757,
                    refund_credit = amount(0),
                ),
                MoneySpending.SpendingCurrency(spent = amount(12_000, "CAD"), refund_credit = amount(0, "CAD")),
            ),
            categories = listOf(
                MoneySpending.SpendingCategory(
                    currency = "USD",
                    category_id = "c-util",
                    label = "Utilities",
                    planned = amount(22_000),
                    carry_in = amount(0),
                    spent = amount(24_827),
                    left = amount(-2_827),
                    over = true,
                    refund_credit = amount(0),
                ),
            ),
            uncategorised = listOf(MoneyCounted(count = 3, amount = amount(6_118))),
            in_out_net = listOf(
                MoneySpending.InOutNet(incoming = amount(245_662), outgoing = amount(333_808), net = amount(-88_146)),
            ),
            transfers_excluded = listOf(MoneyCounted(count = 2, amount = amount(50_000))),
            definitions = listOf("money.def.spending"),
        )

        fun activityRow(id: String, name: String, minor: Long, day: String = "2026-10-14", flags: List<MoneyFlag> = emptyList(), category: String? = null) =
            MoneyActivityRow(
                txn_id = id,
                posted_on = day,
                display_name = name,
                raw = name.uppercase(),
                amount = amount(minor),
                account_id = "a-chase",
                account_label = "Chase Total Checking",
                category_id = category?.let { "c-$it" },
                category_label = category,
                flags = flags,
            )

        fun activity(next: Boolean = false) = MoneyActivity(
            month = "2026-10",
            today = "2026-10-14",
            rows = listOf(
                activityRow("t1", "Trader Joe’s", -6_418, category = "Groceries"),
                activityRow("t2", "To Chase Savings", -50_000, day = "2026-10-13", flags = listOf(MoneyFlag.MONEY_FLAG_TRANSFER)),
            ),
            needs_category = listOf(MoneyCounted(count = 3, amount = amount(6_118))),
            next = if (next) centraid.core.v1.MoneyCursor(sort_key = "2026-10-13", pk = "t2") else null,
        )

        fun cashflow() = MoneyCashflow(
            through = "2026-10",
            today = "2026-10-14",
            series = listOf(
                MoneyCashflow.Series(
                    currency = "USD",
                    months = listOf(
                        MoneyCashflow.Month(
                            month = "2026-09",
                            incoming = amount(400_000),
                            outgoing = amount(300_000),
                            net = amount(100_000),
                            savings_rate_bp = 2_500,
                        ),
                        MoneyCashflow.Month(
                            month = "2026-10",
                            incoming = amount(200_000),
                            outgoing = amount(250_000),
                            net = amount(-50_000),
                            partial = true,
                        ),
                    ),
                ),
            ),
        )

        fun accounts(single: Boolean = false) = MoneyAccounts(
            today = "2026-10-14",
            on_budget = listOfNotNull(
                MoneyAccounts.AccountLine(
                    account_id = "a-chase",
                    name = "Chase Total Checking",
                    mask = "2291",
                    kind = "checking",
                    currency = "USD",
                    balance = amount(318_452),
                    checkpoint = MoneyAccounts.CheckpointLine(as_of = "2026-09-30", stated = amount(300_000), delta = amount(0), agrees = true),
                ),
                if (single) {
                    null
                } else {
                    MoneyAccounts.AccountLine(
                        account_id = "a-amex",
                        name = "Amex Blue Cash",
                        mask = "1009",
                        kind = "credit_card",
                        currency = "USD",
                        balance = amount(-120_633),
                        checkpoint = MoneyAccounts.CheckpointLine(as_of = "2026-09-28", stated = amount(-119_393), delta = amount(-1_240), agrees = false),
                    )
                },
            ),
            off_budget = if (single) {
                emptyList()
            } else {
                listOf(
                    MoneyAccounts.AccountLine(
                        account_id = "a-tang",
                        name = "Tangerine Chequing",
                        mask = "8830",
                        kind = "checking",
                        currency = "CAD",
                        balance = amount(194_000, "CAD"),
                    ),
                )
            },
            net_worth = listOf(
                MoneyAccounts.NetWorthLine(amount = amount(1_481_830), complete = true),
                MoneyAccounts.NetWorthLine(amount = amount(194_000, "CAD"), complete = true),
            ),
        )

        fun categories() = MoneyCategories(
            groups = listOf(
                MoneyCategories.Group(
                    group_id = "g-food",
                    label = "Food",
                    categories = listOf(MoneyCategories.Category(category_id = "c-groc", label = "Groceries")),
                ),
                MoneyCategories.Group(
                    group_id = "g-home",
                    label = "Home",
                    categories = listOf(MoneyCategories.Category(category_id = "c-util", label = "Utilities")),
                ),
            ),
        )

        fun rules() = MoneyRules(
            limit = 500,
            rules = listOf(
                MoneyRules.RuleLine(
                    rule_id = "r1",
                    kind = MoneyMatchKind.MONEY_MATCH_KIND_CONTAINS,
                    pattern = "TRADER JOE S",
                    category_label = "Groceries",
                    display_name = "Trader Joe’s",
                    specificity = 1,
                ),
            ),
        )

        /** The rules, with two that carry limits: r2 is limited to Chase, r3 to no account. */
        fun limitedRules() = rules().let { base ->
            base.copy(
                rules = base.rules + listOf(
                    MoneyRules.RuleLine(
                        rule_id = "r2",
                        kind = MoneyMatchKind.MONEY_MATCH_KIND_CONTAINS,
                        pattern = "COSTCO",
                        amount_min = 500,
                        amount_max = 20_000,
                        account_label = "Chase Total Checking",
                        category_label = "Groceries",
                        specificity = 4,
                    ),
                    MoneyRules.RuleLine(
                        rule_id = "r3",
                        kind = MoneyMatchKind.MONEY_MATCH_KIND_CONTAINS,
                        pattern = "ATM",
                        amount_min = 500,
                        category_label = "Utilities",
                        specificity = 2,
                    ),
                ),
            )
        }

        /** The Rules page, answered with its rules, the categories and the accounts. */
        fun rulesHeld(rules: MoneyRules, accounts: MoneyAccounts = accounts()): MoneyHeld<MoneyRulesState> =
            answeredWith(
                MoneyRulesMachine,
                open(MoneyRulesMachine, MoneyRulesEvent(opened = MoneyRulesEvent.Opened(draft_token = "tok"))),
                AppQueryResponse(money_rules = rules),
                AppQueryResponse(money_categories = categories()),
                AppQueryResponse(money_accounts = accounts),
            )

        fun targetSheet() = MoneyTargetSheet(
            category_id = "c-util",
            category_label = "Utilities",
            month = "2026-10",
            currency = "USD",
            amount = amount(22_000),
            carry = false,
            carry_in = amount(0),
            spent = amount(24_827),
            six_month_average = amount(23_140),
            next_month_preview = amount(22_000),
        )

        fun transaction(offers: Boolean = true) = MoneyTransaction(
            found = true,
            txn_id = "t1",
            posted_on = "2026-10-13",
            display_name = "Trader Joe’s",
            display_name_source = "rule",
            raw = "TRADER JOE S #552",
            amount = amount(-6_418),
            account_id = "a-chase",
            account_label = "Chase Total Checking",
            category_id = "c-groc",
            category_label = "Groceries",
            imported_from = "csv",
            flags = emptyList(),
            transfer_proposal = if (offers) {
                MoneyTransaction.TransferOffer(
                    other_txn_id = "t2",
                    other_account_label = "Chase Savings",
                    other_description = "FROM CHECKING",
                    other_posted_on = "2026-10-13",
                    days_apart = 0,
                )
            } else {
                null
            },
            rule_proposal = if (offers) {
                MoneyTransaction.RuleOffer(
                    kind = MoneyMatchKind.MONEY_MATCH_KIND_CONTAINS,
                    pattern = "TRADER JOE S",
                    category_id = "c-groc",
                    category_label = "Groceries",
                    display_name = "Trader Joe’s",
                    support = 4,
                    of = 5,
                )
            } else {
                null
            },
            seen_times = 5,
            recurring = MoneyTransaction.RecurringNote(cadence = MoneyCadence.MONEY_CADENCE_MONTHLY, amount = amount(6_418)),
        )

        private fun planRow(line: Int, verdict: MoneyImportVerdict, name: String, minor: Long = -1_000, reason: String? = null) =
            MoneyImportPlanRow(
                line = line,
                verdict = verdict,
                posted_on = "2026-10-03",
                amount = amount(minor),
                description = name,
                reason = reason,
            )

        fun plan() = MoneyImportPlan(
            statements = listOf(
                MoneyStatementPlan(
                    account_id = "a-chase",
                    account_label = "Chase Total Checking",
                    rows = listOf(
                        planRow(2, MoneyImportVerdict.MONEY_IMPORT_VERDICT_NEW, "COFFEE"),
                        planRow(3, MoneyImportVerdict.MONEY_IMPORT_VERDICT_NEW, "RENT", -215_000),
                        planRow(4, MoneyImportVerdict.MONEY_IMPORT_VERDICT_ALREADY_IN, "GAS"),
                        planRow(5, MoneyImportVerdict.MONEY_IMPORT_VERDICT_PROPOSED_DUPLICATE, "NETFLIX.COM", -1_549),
                        MoneyImportPlanRow(line = 88, verdict = MoneyImportVerdict.MONEY_IMPORT_VERDICT_REJECTED, reason = "Amount has a letter O."),
                    ),
                    new = 2,
                    already_in = 1,
                    proposed_duplicates = 1,
                    rejected = 1,
                    file_in = amount(488_662),
                    file_out = amount(576_130),
                    first_day = "2026-09-15",
                    last_day = "2026-10-14",
                    checkpoint = MoneyImportCheckpoint(as_of = "2026-10-14", balance = amount(318_452)),
                    profile_to_save = MoneyImportProfile(
                        header_fingerprint = "date,desc,amount",
                        delimiter = ",",
                        skip_lines = 0,
                        date_order = "mdy",
                        sign_mode = "signed",
                        date_col = 0,
                        amount_col = 2,
                        desc_col = 1,
                    ),
                    publish_input = """{"account_id":"a-chase","rows":[1,2]}""".encodeUtf8(),
                    publish_input_with_proposed = """{"account_id":"a-chase","rows":[1,2,3]}""".encodeUtf8(),
                ),
            ),
        )

        /** An import page holding a plan: one account, a CSV picked and planned. */
        fun plannedImport(): MoneyHeld<MoneyImportState> {
            val opened = answeredWith(
                MoneyImportMachine,
                open(MoneyImportMachine, MoneyImportEvent(opened = MoneyImportEvent.Opened(draft_token = "tok"))),
                AppQueryResponse(money_accounts = accounts(single = true)),
            )
            val picked = MoneyImportMachine.reduce(opened, MoneyInput.Picked("Chase.csv", "a,b".encodeToByteArray())).state
            return MoneyImportMachine.reduce(picked, MoneyInput.Planned(picked.job!!.token, MoneyPlanOutcome.Plan(plan()))).state
        }
    }
}
