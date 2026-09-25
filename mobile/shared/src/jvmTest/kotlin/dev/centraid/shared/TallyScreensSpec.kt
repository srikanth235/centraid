package dev.centraid.shared

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.TallyActivityExpense
import centraid.core.v1.TallyActivityRow
import centraid.core.v1.TallyDashboard
import centraid.core.v1.TallyExpense
import centraid.core.v1.TallyExpenseRow
import centraid.core.v1.TallyFriendBalance
import centraid.core.v1.TallyFriendLedger
import centraid.core.v1.TallyGroup
import centraid.core.v1.TallyGroupCard
import centraid.core.v1.TallyGroupLedger
import centraid.core.v1.TallyMember
import centraid.core.v1.TallyMoney
import centraid.core.v1.TallyNetPart
import centraid.core.v1.TallyPerson
import centraid.core.v1.TallyRevision
import centraid.core.v1.TallyRole
import centraid.core.v1.TallySearch
import centraid.core.v1.TallySettleUp
import centraid.core.v1.TallyShare
import centraid.core.v1.TallySimplification
import centraid.core.v1.TallySpending
import centraid.core.v1.TallyCategoryTotal
import centraid.core.v1.TallyTransfer
import centraid.core.v1.TallyValuation
import centraid.screen.v1.Money
import centraid.screen.v1.TallyEditorEvent
import centraid.screen.v1.TallyEditorState
import centraid.screen.v1.TallyExpenseEvent
import centraid.screen.v1.TallyGroupEvent
import centraid.screen.v1.TallyHomeEvent
import centraid.screen.v1.TallyHomeState
import centraid.screen.v1.TallySearchEvent
import centraid.screen.v1.TallySettleUpEvent
import centraid.screen.v1.TallySpendingEvent
import centraid.screen.v1.TallySplitMethod
import centraid.screen.v1.TallyTone
import centraid.screen.v1.TrashListData
import centraid.screen.v1.TrashListEvent
import centraid.screen.v1.TrashRow
import centraid.screen.v1.WriteSettled
import centraid.screen.v1.WriteState
import dev.centraid.design.copy.TallyCopy
import dev.centraid.shared.apps.tally.TallyEditorMachine
import dev.centraid.shared.apps.tally.TallyEditorReads
import dev.centraid.shared.apps.tally.TallyExpenseMachine
import dev.centraid.shared.apps.tally.TallyFriendMachine
import dev.centraid.shared.apps.tally.TallyFriendReads
import dev.centraid.shared.apps.tally.TallyGroupMachine
import dev.centraid.shared.apps.tally.TallyHeld
import dev.centraid.shared.apps.tally.TallyHomeMachine
import dev.centraid.shared.apps.tally.TallyHomeReads
import dev.centraid.shared.apps.tally.TallyInput
import dev.centraid.shared.apps.tally.TallySearchMachine
import dev.centraid.shared.apps.tally.TallySearchReads
import dev.centraid.shared.apps.tally.TallySettleUpMachine
import dev.centraid.shared.apps.tally.TallySpendingMachine
import dev.centraid.shared.apps.tally.TallySplit
import dev.centraid.shared.apps.tally.TallyTrashMachine
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain

/**
 * TALLY'S SCREENS (#1046 port): the folds from the core's typed answers, the
 * editor's six divisions in minor units, and every write a screen emits.
 */
class TallyScreensSpec : StringSpec({

    "the dashboard folds per currency, and the hero never sums across them" {
        val home = answered(TallyHomeMachine, open(TallyHomeMachine, TallyHomeEvent(opened = TallyHomeEvent.Opened())), dashboard())
        val data = home.screen.data_.shouldNotBeNull()
        home.screen.destination shouldBe TallyHomeState.Destination.DESTINATION_BALANCES
        // DANA IS OWED IN TWO MONEYS: two figures, each its own currency.
        val dana = data.friends.first { it.person?.name == "Dana" }
        dana.balances.map { it.amount } shouldBe listOf(money(4250, "EUR"), money(-300, "JPY", 0).copy(minor = 300))
        dana.balances.map { it.tone } shouldBe listOf(TallyTone.TALLY_TONE_OWED, TallyTone.TALLY_TONE_OWE)
        dana.balances.map { it.label } shouldBe listOf(TallyCopy.OWES_YOU, TallyCopy.YOU_OWE)
        // THE HERO: owed was not valued (two moneys, no rate) — two lines, no total.
        val hero = data.hero.shouldNotBeNull()
        hero.lines.map { it.amount?.currency } shouldBe listOf("EUR", "USD", "JPY")
        hero.lines.map { it.tone } shouldBe listOf(TallyTone.TALLY_TONE_OWED, TallyTone.TALLY_TONE_OWED, TallyTone.TALLY_TONE_OWE)
        hero.label shouldBe TallyCopy.HERO_OWED
        hero.sub shouldContain "2 expenses and 1 settlement"
        // Sam is level: said, not a zero figure.
        data.friends.first { it.person?.name == "Sam" }.meta shouldBe TallyCopy.LEVEL
        // GROUPS: your net in the group's one money.
        data.groups.single().your_net?.amount shouldBe money(1500, "EUR")
        data.groups.single().meta shouldBe "3 members"
        // "plane" names no catalog icon: the group mark, and the member's own glyph beside it.
        data.groups.single().icon_key shouldBe "Users"
        data.groups.single().glyph shouldBe "plane"
        // ACTIVITY: day sections against the core's today.
        data.activity.map { it.heading } shouldBe listOf("Today", "Yesterday")
        data.activity[0].rows.single().yours?.label shouldBe TallyCopy.YOU_LENT
        data.day_one shouldBe false
    }

    "day one is its own state, with one move" {
        val empty = TallyDashboard(me = "me", base_currency = "EUR", today = "2026-09-24", yesterday = "2026-09-23")
        val data = answered(TallyHomeMachine, open(TallyHomeMachine, TallyHomeEvent(opened = TallyHomeEvent.Opened())), empty)
            .screen.data_.shouldNotBeNull()
        data.day_one shouldBe true
        data.day_one_empty?.headline shouldBe TallyCopy.DAY_ONE
        data.day_one_empty?.action_label shouldBe TallyCopy.DAY_ONE_ACT
        data.hero?.label shouldBe TallyCopy.HERO_LEVEL
        data.groups_empty.shouldBeNull()
        data.activity_empty.shouldBeNull()
    }

    "a tab reads nothing, the same tab is nothing, and More is a sheet" {
        val home = answered(TallyHomeMachine, open(TallyHomeMachine, TallyHomeEvent(opened = TallyHomeEvent.Opened())), dashboard())
        val same = TallyHomeMachine.reduce(home, view(TallyHomeEvent(band = TallyHomeEvent.BandPicked(key = "balances"))))
        same.state shouldBe home
        same.effects.shouldBeEmpty()
        val groups = TallyHomeMachine.reduce(home, view(TallyHomeEvent(band = TallyHomeEvent.BandPicked(key = "groups"))))
        groups.effects.shouldBeEmpty()
        groups.state.screen.destination shouldBe TallyHomeState.Destination.DESTINATION_GROUPS
        groups.state.screen.band.single { it.current }.key shouldBe "groups"
        val more = TallyHomeMachine.reduce(groups.state, view(TallyHomeEvent(band = TallyHomeEvent.BandPicked(key = "more"))))
        more.state.screen.sheet shouldBe TallyHomeState.Sheet.SHEET_MORE
        more.state.screen.band.single { it.current }.key shouldBe "more"
        more.state.screen.chrome?.more_rows?.map { it.key } shouldBe
            listOf("settle", "recurring", "spending", "search", "export", "trash", "reads")
    }

    "Activity draws a window, and Show more widens it without a read" {
        val long = dashboard().copy(activity = (1..70).map { activity("e$it", "2026-09-24") })
        val home = answered(TallyHomeMachine, open(TallyHomeMachine, TallyHomeEvent(opened = TallyHomeEvent.Opened())), long)
        home.screen.data_?.activity_window shouldBe "60 of 70"
        home.screen.data_?.more_activity shouldBe true
        val more = TallyHomeMachine.reduce(home, view(TallyHomeEvent(show_more = TallyHomeEvent.ShowMore())))
        more.effects.shouldBeEmpty()
        more.state.screen.data_?.activity?.sumOf { it.rows.size } shouldBe 70
        more.state.screen.data_?.more_activity shouldBe false
    }

    "a change event re-reads over the rows, one read at a time" {
        val home = answered(TallyHomeMachine, open(TallyHomeMachine, TallyHomeEvent(opened = TallyHomeEvent.Opened())), dashboard())
        TallyHomeMachine.rowsChanged("people_note", listOf("k")).shouldBeNull()
        val changed = TallyHomeMachine.rowsChanged("tally_expense", emptyList()).shouldNotBeNull()
        val first = TallyHomeMachine.reduce(home, changed)
        first.effects shouldBe listOf(ScreenEffect.ReadPage("tally.home", afterCursor = null))
        first.state.screen.data_.shouldNotBeNull()
        // A SECOND CHANGE WHILE THE READ IS OUT QUEUES; the answer to the
        // first is then dropped and asked again.
        val second = TallyHomeMachine.reduce(first.state, TallyHomeMachine.rowsChanged("tally_expense_split", emptyList())!!)
        second.effects.shouldBeEmpty()
        val stale = TallyHomeMachine.reduce(second.state, TallyInput.Answered(listOf(AppQueryResponse(tally_dashboard = dashboard()))))
        stale.effects shouldBe listOf(ScreenEffect.ReadPage("tally.home", afterCursor = null))
    }

    "a refusal is a sentence and a denial is the gate, with no band" {
        val opened = open(TallyHomeMachine, TallyHomeEvent(opened = TallyHomeEvent.Opened()))
        val refused = TallyHomeMachine.reduce(opened, TallyInput.Refused(dev.centraid.shared.screen.Reads.refused("no"))).state
        refused.screen.failure?.sentence shouldBe "no"
        refused.screen.data_.shouldBeNull()
        val denied = TallyHomeMachine.reduce(opened, TallyInput.Denied(AppQueryDenial())).state
        denied.screen.denied?.title shouldBe TallyCopy.DENIED_TITLE
        denied.screen.denied?.receipt shouldBe TallyCopy.DENIED_SCOPE
        denied.screen.band.shouldBeEmpty()
        TallyHomeReads.denied(AppQueryDenial()) shouldBe TallyInput.Denied(AppQueryDenial())
    }

    "the home asks the dashboard in the device's zone" {
        TallyHomeReads.requests(TallyHomeMachine.initial(), CLOCK)!!.single().tally_dashboard?.tz shouldBe "Europe/Lisbon"
        TallyFriendReads.requests(TallyFriendMachine.initial(), CLOCK).shouldBeNull()
    }

    "a group folds members, ledger and simplification, and the toggle is one write" {
        val opened = open(TallyGroupMachine, TallyGroupEvent(opened = TallyGroupEvent.Opened(group_id = "g1", title = "Lisbon")))
        opened.screen.title shouldBe "Lisbon"
        val group = answeredWith(TallyGroupMachine, opened, AppQueryResponse(tally_group = groupLedger(optedIn = true)))
        val data = group.screen.data_.shouldNotBeNull()
        data.members.map { it.net?.label } shouldBe listOf(TallyCopy.IS_OWED, TallyCopy.OWES, TallyCopy.LEVEL)
        data.members.last().meta shouldBe TallyCopy.DEPARTED_META
        data.hero?.label shouldBe TallyCopy.GROUP_HERO_OWED
        data.simplify?.summary shouldBe "3 debts become 2 payments"
        data.simplify?.transfers?.single()?.line shouldBe "Sam pays You"
        data.simplify?.toggle_label shouldBe TallyCopy.SIMPLIFY_STOP
        val toggled = TallyGroupMachine.reduce(group, view(TallyGroupEvent(simplify_toggled = TallyGroupEvent.SimplifyToggled())))
        val write = toggled.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "tally.set_group_simplification"
        write.inputJson shouldBe "{\"group_id\":\"g1\",\"simplify\":false}"
        toggled.state.screen.data_?.simplify?.toggle_enabled shouldBe false
        // A DOUBLE TAP IS ONE WRITE.
        TallyGroupMachine.reduce(toggled.state, view(TallyGroupEvent(simplify_toggled = TallyGroupEvent.SimplifyToggled())))
            .effects.shouldBeEmpty()
        val settled = TallyGroupMachine.reduce(
            toggled.state,
            TallyInput.Settled(WriteSettled(invoke_key = write.invokeKey, committed = true)),
        ).state
        settled.screen.write?.phase shouldBe WriteState.Phase.PHASE_COMMITTED
        settled.screen.data_?.simplify?.toggle_enabled shouldBe true
    }

    "a group that is gone is a sentence" {
        val opened = open(TallyGroupMachine, TallyGroupEvent(opened = TallyGroupEvent.Opened(group_id = "gx")))
        answeredWith(TallyGroupMachine, opened, AppQueryResponse(tally_group = TallyGroupLedger()))
            .screen.data_?.gone?.headline shouldBe TallyCopy.GROUP_GONE
    }

    "a friend's net is its parts, one outside any group" {
        val ledger = TallyFriendLedger(
            me = "me",
            friend = person("dana", "Dana"),
            balances = listOf(eur(4250)),
            parts = listOf(
                TallyNetPart(group_id = "g1", group_name = "Lisbon", net = eur(5000)),
                TallyNetPart(group_name = "", net = eur(-750)),
            ),
            ledger = listOf(expenseRow("e1")),
        )
        val data = TallyFriendMachine.fold(ledger)
        data.hero?.lines?.single()?.label shouldBe TallyCopy.OWES_YOU
        data.parts.map { it.title } shouldBe listOf("Lisbon", TallyCopy.OUTSIDE_ANY_GROUP)
        data.parts.map { it.net?.tone } shouldBe listOf(TallyTone.TALLY_TONE_OWED, TallyTone.TALLY_TONE_OWE)
        data.parts[1].group_id shouldBe ""
        data.ledger.single().meta shouldContain "Lisbon"
    }

    "an expense: revisions with Undo, trash behind a confirm, restore without one" {
        val opened = open(TallyExpenseMachine, TallyExpenseEvent(opened = TallyExpenseEvent.Opened(expense_id = "e1")))
        val live = answeredWith(TallyExpenseMachine, opened, AppQueryResponse(tally_expense = expense(trashed = false)))
        val data = live.screen.data_.shouldNotBeNull()
        data.revisions.map { it.undo_label } shouldBe listOf(TallyCopy.UNDO_VERB, "")
        data.revisions[1].state_label shouldBe TallyCopy.UNDO_SPENT
        data.revisions[0].meta shouldContain "was “Dinner”"
        data.edit_label shouldBe TallyCopy.EDIT_VERB
        data.restore_label shouldBe ""
        data.fields.first { it.key == TallyCopy.FIELD_DIVIDED }.value_ shouldBe TallyCopy.METHOD_EQUALLY

        val undo = TallyExpenseMachine.reduce(live, view(TallyExpenseEvent(undo = TallyExpenseEvent.UndoTapped(revision_id = "r2"))))
        val undoWrite = undo.effects.single() as ScreenEffect.SubmitWrite
        undoWrite.command shouldBe "tally.undo_expense"
        undoWrite.inputJson shouldBe "{\"expense_id\":\"e1\",\"revision_id\":\"r2\"}"
        undoWrite.invokeKey shouldBe "tally.undo_expense:e1:r2"
        // The spent one offers nothing.
        TallyExpenseMachine.reduce(live, view(TallyExpenseEvent(undo = TallyExpenseEvent.UndoTapped(revision_id = "r1"))))
            .effects.shouldBeEmpty()

        val asked = TallyExpenseMachine.reduce(live, view(TallyExpenseEvent(trash = TallyExpenseEvent.TrashTapped())))
        asked.effects.shouldBeEmpty()
        asked.state.screen.confirm?.destructive shouldBe true
        asked.state.screen.confirm?.title shouldBe TallyCopy.TRASH_TITLE
        val trashed = TallyExpenseMachine.reduce(asked.state, view(TallyExpenseEvent(confirmed = TallyExpenseEvent.Confirmed())))
        (trashed.effects.single() as ScreenEffect.SubmitWrite).command shouldBe "tally.delete_expense"
        trashed.state.screen.confirm.shouldBeNull()

        val inTrash = answeredWith(TallyExpenseMachine, opened, AppQueryResponse(tally_expense = expense(trashed = true)))
        inTrash.screen.data_?.trash_line shouldBe "${TallyCopy.IN_TRASH} · ${TallyCopy.PURGES_ON} Sat 24 October"
        inTrash.screen.data_?.edit_label shouldBe ""
        val restore = TallyExpenseMachine.reduce(inTrash, view(TallyExpenseEvent(restore = TallyExpenseEvent.RestoreTapped())))
        (restore.effects.single() as ScreenEffect.SubmitWrite).command shouldBe "tally.restore_expense"
        inTrash.screen.data_?.memo_label shouldBe ""
    }

    "an expense's memo: a sheet, and closing it writes only changed words" {
        val opened = open(TallyExpenseMachine, TallyExpenseEvent(opened = TallyExpenseEvent.Opened(expense_id = "e1")))
        val live = answeredWith(TallyExpenseMachine, opened, AppQueryResponse(tally_expense = expense(trashed = false)))
        live.screen.data_?.memo_label shouldBe TallyCopy.MEMO_ADD
        live.screen.data_?.icon_key shouldBe "Receipt"
        live.screen.chrome?.back shouldBe TallyCopy.APP_TITLE
        val sheet = step(TallyExpenseMachine, live, TallyExpenseEvent(memo_opened = TallyExpenseEvent.MemoOpened()))
        sheet.screen.memo_draft shouldBe ""
        // Nothing typed: closing writes nothing.
        TallyExpenseMachine.reduce(sheet, view(TallyExpenseEvent(memo_closed = TallyExpenseEvent.MemoClosed()))).let {
            it.effects.shouldBeEmpty()
            it.state.screen.memo_draft.shouldBeNull()
        }
        val typed = step(TallyExpenseMachine, sheet, TallyExpenseEvent(memo_changed = TallyExpenseEvent.MemoChanged(text = " Paid in cash ")))
        val closed = TallyExpenseMachine.reduce(typed, view(TallyExpenseEvent(memo_closed = TallyExpenseEvent.MemoClosed())))
        val write = closed.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "tally.set_expense_memo"
        write.inputJson shouldBe "{\"expense_id\":\"e1\",\"note\":\"Paid in cash\"}"
        closed.state.screen.memo_draft.shouldBeNull()
        // A memo on record offers an edit.
        answeredWith(TallyExpenseMachine, opened, AppQueryResponse(tally_expense = expense(trashed = false).copy(memo = "Cash")))
            .screen.data_?.memo_label shouldBe TallyCopy.MEMO_EDIT
    }

    "the editor's choices sheet, its methods' enum, one reconcile sentence, and exponents the core states" {
        val opened = open(TallyEditorMachine, TallyEditorEvent(opened = TallyEditorEvent.Opened(draft_token = "t")))
        var held = answeredWith(TallyEditorMachine, opened, AppQueryResponse(tally_dashboard = dashboard()))
        held.screen.sheet shouldBe TallyEditorState.Sheet.SHEET_NONE
        held.screen.data_!!.methods.map { it.method } shouldBe listOf(
            TallySplitMethod.TALLY_SPLIT_METHOD_EQUALLY,
            TallySplitMethod.TALLY_SPLIT_METHOD_EXACT,
            TallySplitMethod.TALLY_SPLIT_METHOD_PERCENTAGES,
            TallySplitMethod.TALLY_SPLIT_METHOD_SHARES,
            TallySplitMethod.TALLY_SPLIT_METHOD_ADJUSTED,
            TallySplitMethod.TALLY_SPLIT_METHOD_BY_LINE,
        )
        held = step(TallyEditorMachine, held, TallyEditorEvent(sheet_opened = TallyEditorEvent.SheetOpened(sheet = TallyEditorState.Sheet.SHEET_METHOD)))
        held.screen.sheet shouldBe TallyEditorState.Sheet.SHEET_METHOD
        // A PICK CLOSES THE SHEET.
        held = step(TallyEditorMachine, held, TallyEditorEvent(method = TallyEditorEvent.MethodPicked(method = TallySplitMethod.TALLY_SPLIT_METHOD_PERCENTAGES)))
        held.screen.sheet shouldBe TallyEditorState.Sheet.SHEET_NONE
        held = step(TallyEditorMachine, held, TallyEditorEvent(description = TallyEditorEvent.DescriptionChanged(text = "Dinner")))
        held = step(TallyEditorMachine, held, TallyEditorEvent(amount = TallyEditorEvent.AmountChanged(text = "10")))
        held = step(TallyEditorMachine, held, TallyEditorEvent(entry_changed = TallyEditorEvent.EntryChanged(party_id = "me", text = "40")))
        val data = held.screen.data_.shouldNotBeNull()
        data.reconcile_problem shouldBe true
        // THE DIVISION'S PROBLEM IS SAID ONCE, on the reconcile line.
        data.issues.none { it == data.reconcile_line } shouldBe true
        data.can_save shouldBe false
        // A remembered rate's money scales by the exponent the core stated.
        val rated = dashboard().copy(
            rate_suggestions = listOf(
                centraid.core.v1.TallyRateSuggestion(
                    from_currency = "KWD",
                    to_currency = "EUR",
                    rate_scaled = 3_000_000,
                    rate_scale = 6,
                    observed_on = "2026-09-01",
                    from_exponent = 3,
                ),
            ),
        )
        var fx = answeredWith(TallyEditorMachine, opened, AppQueryResponse(tally_dashboard = rated))
        fx.screen.data_!!.currencies.map { it.key } shouldBe listOf("EUR", "KWD")
        fx = step(TallyEditorMachine, fx, TallyEditorEvent(currency = TallyEditorEvent.CurrencyPicked(currency = "KWD")))
        fx = step(TallyEditorMachine, fx, TallyEditorEvent(amount = TallyEditorEvent.AmountChanged(text = "1.500")))
        // 1.500 KWD is 1500 fils (exponent 3), converted by the vault's rule.
        fx.screen.data_!!.total shouldBe money(TallySplit.convert(1500, 3_000_000, 6)!!, "EUR")
    }

    "the six divisions, in minor units, each summing to the amount" {
        val people = listOf("me", "dana", "sam")
        fun entries(vararg texts: String, allIn: Boolean = false) =
            people.zip(texts.toList()).map { (p, t) -> TallySplit.Entry(p, allIn || p != "sam" || t.isNotEmpty(), t) }
        fun divide(method: TallySplitMethod, total: Long, payer: String, list: List<TallySplit.Entry>) =
            TallySplit.divide(method, total, 2, payer, list, emptyList())
        // EQUALLY: 1000 / 3 is 333 each and the odd penny to the payer.
        divide(TallySplitMethod.TALLY_SPLIT_METHOD_EQUALLY, 1000, "dana", entries("", "", "", allIn = true))
            .shares shouldBe mapOf("me" to 333L, "dana" to 334L, "sam" to 333L)
        // EXACT: must add up exactly; short says what is left.
        divide(TallySplitMethod.TALLY_SPLIT_METHOD_EXACT, 1000, "me", entries("5", "3", "2")).shares shouldBe
            mapOf("me" to 500L, "dana" to 300L, "sam" to 200L)
        val short = divide(TallySplitMethod.TALLY_SPLIT_METHOD_EXACT, 1000, "me", entries("5", "3", "1.99"))
        short.problem shouldBe TallyCopy.LEFT_TO_DIVIDE
        short.remaining shouldBe 1L
        short.shares shouldBe emptyMap()
        divide(TallySplitMethod.TALLY_SPLIT_METHOD_EXACT, 1000, "me", entries("5", "x", "2")).issues shouldBe
            mapOf("dana" to TallyCopy.NOT_AN_AMOUNT)
        // PERCENTAGES: 99 will not save.
        divide(TallySplitMethod.TALLY_SPLIT_METHOD_PERCENTAGES, 1000, "me", entries("50", "25", "24"))
            .problem shouldBe "${TallyCopy.PERCENT_TOTAL_PREFIX} 99${TallyCopy.PERCENT_TOTAL_SUFFIX}"
        val thirds = divide(TallySplitMethod.TALLY_SPLIT_METHOD_PERCENTAGES, 1001, "me", entries("33.34", "33.33", "33.33"))
        thirds.shares.values.sum() shouldBe 1001L
        // SHARES: weights, floors, the rest to the payer.
        divide(TallySplitMethod.TALLY_SPLIT_METHOD_SHARES, 1000, "me", entries("2", "1", ""))
            .shares shouldBe mapOf("me" to 667L, "dana" to 333L)
        // ADJUSTED: an equal base of what is left after the adjustments.
        divide(TallySplitMethod.TALLY_SPLIT_METHOD_ADJUSTED, 1000, "me", entries("+1", "", "-0.5", allIn = true))
            .shares shouldBe mapOf("me" to 418L, "dana" to 316L, "sam" to 266L)
        divide(TallySplitMethod.TALLY_SPLIT_METHOD_ADJUSTED, 1000, "me", entries("-20", "", "", allIn = true))
            .problem shouldBe TallyCopy.ADJUSTED_NEGATIVE
        // BY LINE: lines that make the total, each shared by its people.
        val lines = TallySplit.divide(
            TallySplitMethod.TALLY_SPLIT_METHOD_BY_LINE,
            1000,
            2,
            "me",
            emptyList(),
            listOf(
                TallySplit.Line("l1", "Pizza", "7.00", listOf("me", "dana")),
                TallySplit.Line("l2", "Wine", "3.00", listOf("sam")),
            ),
        )
        lines.shares shouldBe mapOf("me" to 350L, "dana" to 350L, "sam" to 300L)
        lines.lines.map { it.amount } shouldBe listOf(700L, 300L)
        TallySplit.divide(
            TallySplitMethod.TALLY_SPLIT_METHOD_BY_LINE,
            1000,
            2,
            "me",
            emptyList(),
            listOf(TallySplit.Line("l1", "Pizza", "7.00", listOf("me"))),
        ).problem shouldBe TallyCopy.LINES_SHORT
        // Typed amounts are integers of minor units, never rounded.
        TallySplit.parseAmount("42.505", 2).shouldBeNull()
        TallySplit.parseAmount("42,5", 2) shouldBe 4250L
        TallySplit.parseAmount("4250", 0) shouldBe 4250L
        TallySplit.parseAmount("4.250", 3) shouldBe 4250L
        TallySplit.amountText(4250, 2) shouldBe "42.50"
        TallySplit.amountText(5, 2) shouldBe "0.05"
        // The vault's conversion, half up: 1000 at 1.17 is 1170.
        TallySplit.convert(1000, 1_170_000, 6) shouldBe 1170L
    }

    "the editor seeds from the dashboard, validates, and saves one expense" {
        val opened = open(
            TallyEditorMachine,
            TallyEditorEvent(opened = TallyEditorEvent.Opened(mode = TallyEditorState.Mode.MODE_ADD, party_id = "dana", draft_token = "t1")),
        )
        TallyEditorReads.requests(opened, CLOCK)!!.map { it.tally_dashboard != null } shouldBe listOf(true)
        var held = answeredWith(TallyEditorMachine, opened, AppQueryResponse(tally_dashboard = dashboard()))
        val form = held.screen.form.shouldNotBeNull()
        form.payer_id shouldBe "me"
        form.currency shouldBe "EUR"
        form.spent_on shouldBe "2026-09-24"
        form.entries.filter { it.included }.map { it.person?.party_id } shouldBe listOf("me", "dana")
        held.screen.dirty shouldBe false
        held.screen.data_?.can_save shouldBe false
        held.screen.data_?.issues shouldBe listOf(TallyCopy.DESCRIPTION_MISSING, TallyCopy.AMOUNT_MISSING)

        held = step(TallyEditorMachine, held, TallyEditorEvent(description = TallyEditorEvent.DescriptionChanged(text = "Dinner")))
        held = step(TallyEditorMachine, held, TallyEditorEvent(amount = TallyEditorEvent.AmountChanged(text = "10.01")))
        held.screen.dirty shouldBe true
        val data = held.screen.data_.shouldNotBeNull()
        data.can_save shouldBe true
        data.total shouldBe money(1001, "EUR")
        data.reconcile_line shouldBe TallyCopy.RULE_EQUALLY
        held.screen.form?.entries?.first { it.person?.party_id == "me" }?.share shouldBe money(501, "EUR")

        // A PERCENTAGE SPLIT AT 99 DOES NOT SAVE.
        held = step(TallyEditorMachine, held, TallyEditorEvent(method = TallyEditorEvent.MethodPicked(method = TallySplitMethod.TALLY_SPLIT_METHOD_PERCENTAGES)))
        held = step(TallyEditorMachine, held, TallyEditorEvent(entry_changed = TallyEditorEvent.EntryChanged(party_id = "me", text = "50")))
        held = step(TallyEditorMachine, held, TallyEditorEvent(entry_changed = TallyEditorEvent.EntryChanged(party_id = "dana", text = "49")))
        held.screen.data_?.can_save shouldBe false
        held.screen.data_?.reconcile_problem shouldBe true
        TallyEditorMachine.reduce(held, view(TallyEditorEvent(save = TallyEditorEvent.SaveTapped()))).effects.shouldBeEmpty()
        held = step(TallyEditorMachine, held, TallyEditorEvent(entry_changed = TallyEditorEvent.EntryChanged(party_id = "dana", text = "50")))
        held.screen.data_?.can_save shouldBe true

        val saved = TallyEditorMachine.reduce(held, view(TallyEditorEvent(save = TallyEditorEvent.SaveTapped())))
        val write = saved.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "tally.add_expense"
        write.inputJson shouldContain "\"amount_minor\":1001"
        write.inputJson shouldContain "\"splits\":[{\"party_id\":\"me\",\"share_minor\":501},{\"party_id\":\"dana\",\"share_minor\":500}]"
        write.inputJson shouldContain "\"split_params\":{\"unit\":\"percent\",\"entries\":{\"me\":50,\"dana\":50}}"
        write.invokeKey shouldContain "tally.add_expense:new:t1:"
        // A DOUBLE TAP IS ONE EXPENSE.
        TallyEditorMachine.reduce(saved.state, view(TallyEditorEvent(save = TallyEditorEvent.SaveTapped()))).effects.shouldBeEmpty()
        // REFUSED: every field stays.
        val refused = TallyEditorMachine.reduce(
            saved.state,
            TallyInput.Settled(WriteSettled(invoke_key = write.invokeKey, committed = false, failure = dev.centraid.shared.screen.Reads.refused("no"))),
        ).state
        refused.screen.done shouldBe false
        refused.screen.form?.description shouldBe "Dinner"
        refused.screen.write?.failure?.sentence shouldBe "no"
        val committed = TallyEditorMachine.reduce(
            saved.state,
            TallyInput.Settled(WriteSettled(invoke_key = write.invokeKey, committed = true)),
        ).state
        committed.screen.done shouldBe true
    }

    "leaving the editor with changes asks first; without, it is done" {
        val opened = open(TallyEditorMachine, TallyEditorEvent(opened = TallyEditorEvent.Opened(draft_token = "t")))
        val clean = answeredWith(TallyEditorMachine, opened, AppQueryResponse(tally_dashboard = dashboard()))
        step(TallyEditorMachine, clean, TallyEditorEvent(close = TallyEditorEvent.CloseTapped())).screen.done shouldBe true
        val dirty = step(TallyEditorMachine, clean, TallyEditorEvent(description = TallyEditorEvent.DescriptionChanged(text = "x")))
        val asked = step(TallyEditorMachine, dirty, TallyEditorEvent(close = TallyEditorEvent.CloseTapped()))
        asked.screen.done shouldBe false
        asked.screen.confirm?.title shouldBe TallyCopy.DISCARD_TITLE
        step(TallyEditorMachine, asked, TallyEditorEvent(dismissed = TallyEditorEvent.Dismissed())).screen.confirm.shouldBeNull()
        step(TallyEditorMachine, asked, TallyEditorEvent(confirmed = TallyEditorEvent.Confirmed())).screen.done shouldBe true
    }

    "settle up: a suggestion becomes a draft, and recording it is one write" {
        val opened = open(TallySettleUpMachine, TallySettleUpEvent(opened = TallySettleUpEvent.Opened(draft_token = "s1")))
        val held = TallySettleUpMachine.reduce(
            opened,
            TallyInput.Answered(
                listOf(
                    AppQueryResponse(
                        tally_settle_up = TallySettleUp(
                            me = "me",
                            suggestions = listOf(TallyTransfer(from = person("dana", "Dana"), to = me(), amount = eur(4250), group_id = "g1")),
                        ),
                    ),
                    AppQueryResponse(tally_dashboard = dashboard()),
                ),
            ),
        ).state
        val row = held.screen.data_!!.suggestions.single()
        row.meta shouldBe "Lisbon"
        row.yours shouldBe true
        val picked = step(TallySettleUpMachine, held, TallySettleUpEvent(picked = TallySettleUpEvent.SuggestionPicked(key = row.key)))
        picked.screen.draft?.amount_text shouldBe "42.50"
        picked.screen.draft?.foot shouldBe TallyCopy.SETTLE_FOOT_YOURS
        val over = step(TallySettleUpMachine, picked, TallySettleUpEvent(amount = TallySettleUpEvent.AmountChanged(text = "50")))
        over.screen.draft?.can_record shouldBe false
        over.screen.draft?.issue shouldBe TallyCopy.PAYMENT_OVER
        val partial = step(TallySettleUpMachine, picked, TallySettleUpEvent(amount = TallySettleUpEvent.AmountChanged(text = "20")))
        val record = TallySettleUpMachine.reduce(partial, view(TallySettleUpEvent(record = TallySettleUpEvent.RecordTapped())))
        val write = record.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "tally.settle_up"
        write.inputJson shouldBe "{\"from_party\":\"dana\",\"to_party\":\"me\",\"amount_minor\":2000,\"currency\":\"EUR\",\"group_id\":\"g1\"}"
        TallySettleUpMachine.reduce(record.state, TallyInput.Settled(WriteSettled(invoke_key = write.invokeKey, committed = true)))
            .state.screen.draft.shouldBeNull()
    }

    "spending steps by month, never past this one, and keeps each money apart" {
        TallySpendingMachine.stepMonth("2026-01", -1) shouldBe "2025-12"
        TallySpendingMachine.stepMonth("2026-12", 1) shouldBe "2027-01"
        val opened = open(TallySpendingMachine, TallySpendingEvent(opened = TallySpendingEvent.Opened()))
        val spending = TallySpending(
            month = "2026-09",
            today = "2026-09-24",
            categories = listOf(
                TallyCategoryTotal(category = "food", total = eur(3000)),
                TallyCategoryTotal(category = "travel", total = TallyMoney(minor = 5000, currency = "JPY", exponent = 0)),
            ),
            month_total = listOf(eur(3000), TallyMoney(minor = 5000, currency = "JPY", exponent = 0)),
            paid = listOf(eur(3000)),
            share = listOf(eur(1500)),
            difference = listOf(eur(1500)),
        )
        val held = answeredWith(TallySpendingMachine, opened, AppQueryResponse(tally_spending = spending))
        held.screen.month shouldBe "2026-09"
        held.screen.month_label shouldBe "September 2026"
        held.screen.next_enabled shouldBe false
        held.screen.data_?.currencies?.map { it.currency } shouldBe listOf("EUR", "JPY")
        held.screen.data_?.currencies?.first()?.categories?.single()?.share_permille shouldBe 1000
        TallySpendingMachine.reduce(held, view(TallySpendingEvent(month_stepped = TallySpendingEvent.MonthStepped(months = 1))))
            .effects.shouldBeEmpty()
        val back = TallySpendingMachine.reduce(held, view(TallySpendingEvent(month_stepped = TallySpendingEvent.MonthStepped(months = -1))))
        back.effects shouldBe listOf(ScreenEffect.ReadPage("tally.spending", afterCursor = null))
        back.state.screen.month shouldBe "2026-08"
        back.state.screen.loading?.first_load shouldBe true
        back.state.screen.next_enabled shouldBe true
    }

    "search: nothing typed reads nothing, a term reads, clearing clears" {
        val start = TallySearchMachine.initial()
        start.screen.resting?.headline shouldBe TallyCopy.SEARCH_RESTING
        TallySearchReads.requests(start, CLOCK).shouldBeNull()
        TallySearchMachine.reduce(start, TallySearchMachine.rowsChanged("tally_expense", emptyList())!!).effects.shouldBeEmpty()
        val typed = TallySearchMachine.reduce(start, view(TallySearchEvent(term = TallySearchEvent.TermChanged(term = "ferry"))))
        typed.effects shouldBe listOf(ScreenEffect.ReadPage("tally.search", afterCursor = null))
        TallySearchReads.requests(typed.state, CLOCK)!!.single().tally_search?.term shouldBe "ferry"
        val none = TallySearchMachine.reduce(typed.state, TallyInput.Answered(listOf(AppQueryResponse(tally_search = TallySearch())))).state
        none.screen.data_?.empty?.headline shouldBe "${TallyCopy.NOTHING_MATCHES} “ferry”."
        none.screen.field_?.answered_term shouldBe "ferry"
        val hits = TallySearchMachine.reduce(
            typed.state,
            TallyInput.Answered(listOf(AppQueryResponse(tally_search = TallySearch(results = listOf(expenseRow("e1")), total_matches = 3)))),
        ).state
        hits.screen.data_?.count_label shouldBe "1 of 3 matches"
        val cleared = step(TallySearchMachine, hits, TallySearchEvent(cleared = TallySearchEvent.Cleared()))
        cleared.screen.field_?.term shouldBe ""
        cleared.screen.resting.shouldNotBeNull()
        cleared.screen.data_.shouldBeNull()
    }

    "Tally's trash restores and never offers to destroy" {
        val loaded = TallyTrashMachine.reduce(
            TallyTrashMachine.initial(),
            TrashListEvent(data_ = TrashListEvent.DataArrived(data_ = TrashListData(rows = listOf(TrashRow(id = "e1", title = "Dinner"))), answered_cursor = "")),
        ).state
        loaded.data_?.rows?.single()?.purge_label shouldBe ""
        loaded.data_?.empty_label shouldBe ""
        TallyTrashMachine.reduce(loaded, TrashListEvent(empty = TrashListEvent.EmptyTapped())).state.confirm.shouldBeNull()
        val restore = TallyTrashMachine.reduce(loaded, TrashListEvent(restore = TrashListEvent.RestoreTapped(id = "e1")))
        (restore.effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe "{\"expense_id\":\"e1\"}"
        TallyTrashMachine.screenId shouldBe "tally.trash"
    }
}) {
    private companion object {
        val CLOCK = DeviceClock.Reading(zone = "Europe/Lisbon", epochMillis = 1_790_000_000_000L)

        fun <E> view(event: E): TallyInput<E> = TallyInput.View(event)

        fun <S, E> open(machine: ScreenMachine<TallyHeld<S>, TallyInput<E>>, event: E): TallyHeld<S> =
            machine.reduce(machine.initial(), TallyInput.View(event)).state

        fun <S, E> step(machine: ScreenMachine<TallyHeld<S>, TallyInput<E>>, held: TallyHeld<S>, event: E): TallyHeld<S> =
            machine.reduce(held, TallyInput.View(event)).state

        fun <S, E> answered(machine: ScreenMachine<TallyHeld<S>, TallyInput<E>>, held: TallyHeld<S>, dashboard: TallyDashboard): TallyHeld<S> =
            answeredWith(machine, held, AppQueryResponse(tally_dashboard = dashboard))

        fun <S, E> answeredWith(machine: ScreenMachine<TallyHeld<S>, TallyInput<E>>, held: TallyHeld<S>, answer: AppQueryResponse): TallyHeld<S> {
            val step: Step<TallyHeld<S>> = machine.reduce(held, TallyInput.Answered(listOf(answer)))
            return step.state
        }

        fun money(minor: Long, currency: String, exponent: Int = if (currency == "JPY") 0 else 2): Money =
            Money(minor = minor, currency = currency, exponent = exponent)

        fun eur(minor: Long) = TallyMoney(minor = minor, currency = "EUR", exponent = 2)

        fun me() = TallyPerson(party_id = "me", name = "You", initials = "Y", color = "#111111", is_me = true)

        fun person(id: String, name: String) = TallyPerson(party_id = id, name = name, initials = name.take(1), color = "#222222")

        fun activity(id: String, day: String) = TallyActivityRow(
            expense = TallyActivityExpense(
                expense_id = id,
                date = day,
                description = "Dinner",
                category = "food",
                paid_by = me(),
                amount = eur(3000),
                your_role = TallyRole.TALLY_ROLE_LENT,
                your_amount = eur(1500),
            ),
        )

        fun dashboard() = TallyDashboard(
            me = "me",
            base_currency = "EUR",
            base_exponent = 2,
            today = "2026-09-24",
            yesterday = "2026-09-23",
            friends = listOf(
                TallyFriendBalance(
                    person = person("dana", "Dana"),
                    balances = listOf(eur(4250), TallyMoney(minor = -300, currency = "JPY", exponent = 0)),
                ),
                TallyFriendBalance(person = person("sam", "Sam")),
            ),
            owed = TallyValuation(valued = false, components = listOf(eur(4250), TallyMoney(minor = 900, currency = "USD", exponent = 2))),
            owe = TallyValuation(valued = true, total = TallyMoney(minor = 300, currency = "JPY", exponent = 0), components = listOf(TallyMoney(minor = 300, currency = "JPY", exponent = 0))),
            expense_count = 2,
            settlement_count = 1,
            groups = listOf(TallyGroupCard(group_id = "g1", name = "Lisbon", icon = "plane", color = "#0FA678", member_count = 3, your_net = eur(1500))),
            activity = listOf(activity("e1", "2026-09-24"), activity("e2", "2026-09-23")),
        )

        fun groupLedger(optedIn: Boolean) = TallyGroupLedger(
            me = "me",
            group = TallyGroup(group_id = "g1", name = "Lisbon", icon = "plane", color = "#0FA678", currency = "EUR", simplify_opt_in = optedIn),
            members = listOf(
                TallyMember(person = me(), net = eur(2000)),
                TallyMember(person = person("sam", "Sam"), net = eur(-2000)),
                TallyMember(person = person("ana", "Ana"), net = eur(0), departed = true),
            ),
            ledger = listOf(expenseRow("e1")),
            simplification = TallySimplification(
                opted_in = optedIn,
                transfers = listOf(TallyTransfer(from = person("sam", "Sam"), to = me(), amount = eur(2000), group_id = "g1")),
                debts_before = 3,
                payments_after = 2,
            ),
        )

        fun expenseRow(id: String) = TallyExpenseRow(
            expense_id = id,
            group_id = "g1",
            group_name = "Lisbon",
            description = "Dinner",
            amount = eur(3000),
            category = "food",
            spent_on = "2026-09-20",
            paid_by = me(),
            split_method = "equally",
            payers = listOf(TallyShare(person = me(), amount = eur(3000))),
            splits = listOf(TallyShare(person = me(), amount = eur(1500)), TallyShare(person = person("dana", "Dana"), amount = eur(1500))),
            your_role = TallyRole.TALLY_ROLE_LENT,
            your_amount = eur(1500),
        )

        fun expense(trashed: Boolean) = TallyExpense(
            expense = expenseRow("e1"),
            deleted_at = if (trashed) "2026-09-24T10:00:00.000Z" else null,
            purge_on_local = if (trashed) "2026-10-24" else null,
            revisions = listOf(
                TallyRevision(revision_id = "r2", operation = "edit", recorded_local = "2026-09-24T10:42", undoable = true, before_description = "Dinner"),
                TallyRevision(revision_id = "r1", operation = "edit", recorded_local = "2026-09-20T09:00", undone_at = "2026-09-20T09:00:05.000Z"),
            ),
        )
    }
}
