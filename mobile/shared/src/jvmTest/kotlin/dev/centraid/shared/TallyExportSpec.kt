package dev.centraid.shared

import centraid.core.v1.AppQueryResponse
import centraid.core.v1.TallyDashboard
import centraid.core.v1.TallyExport
import centraid.core.v1.TallyExpenseRow
import centraid.core.v1.TallyGroup
import centraid.core.v1.TallyGroupCard
import centraid.core.v1.TallyMoney
import centraid.core.v1.TallyPerson
import centraid.screen.v1.TallyExportEvent
import centraid.screen.v1.TallyExportState
import dev.centraid.design.copy.TallyCopy
import dev.centraid.shared.apps.tally.TallyExportMachine
import dev.centraid.shared.apps.tally.TallyExportReads
import dev.centraid.shared.apps.tally.TallyHeld
import dev.centraid.shared.apps.tally.TallyHomeMachine
import dev.centraid.shared.apps.tally.TallyInput
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.Step
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe

/**
 * `tally.export` (#1047, R-1047-Q5): the group and the range are the request,
 * the core renders the file, the screen says "N of M", and Save hands the
 * platform the core's CSV and file name.
 */
class TallyExportSpec : StringSpec({

    val clock = DeviceClock.Reading(zone = "Europe/London", epochMillis = 1_790_000_000_000L)

    fun drive(state: TallyHeld<TallyExportState>, vararg inputs: TallyInput<TallyExportEvent>): Step<TallyHeld<TallyExportState>> =
        inputs.fold(Step(state)) { step, input ->
            val next = TallyExportMachine.reduce(step.state, input)
            Step(next.state, step.effects + next.effects)
        }

    fun view(event: TallyExportEvent): TallyInput<TallyExportEvent> = TallyInput.View(event)

    fun opened(groupId: String = "") = drive(
        TallyExportMachine.initial(),
        view(TallyExportEvent(opened = TallyExportEvent.Opened(group_id = groupId, parent = "Tally"))),
    )

    fun dashboard(vararg groups: String) = AppQueryResponse(
        tally_dashboard = TallyDashboard(
            today = "2026-09-25",
            groups = groups.map { TallyGroupCard(group_id = it, name = it.replaceFirstChar(Char::uppercase), color = "var(--c-teal)") },
        ),
    )

    fun expense(id: String) = TallyExpenseRow(
        expense_id = id,
        description = "Dinner $id",
        amount = TallyMoney(minor = 4250, currency = "USD"),
        category = "food",
        spent_on = "2026-09-20",
        paid_by = TallyPerson(party_id = "me", name = "You", is_me = true),
    )

    fun export(expenses: Int, inWindow: Int) = AppQueryResponse(
        tally_export = TallyExport(
            group = TallyGroup(group_id = "tahoe", name = "Tahoe"),
            expenses = (1..expenses).map { expense("e$it") },
            expenses_in_window = inWindow,
            settlements_in_window = 0,
            csv = "kind,date\r\nexpense,2026-09-20\r\n",
            file_name = "tahoe-2026-09-25.csv",
        ),
    )

    "no group picked: the dashboard alone is read, and the screen asks for a group" {
        val start = opened()
        start.effects shouldBe listOf(ScreenEffect.ReadPage(TallyExportMachine.SCREEN_ID, null))
        TallyExportReads.requests(start.state, clock)!!.let { reads ->
            reads.size shouldBe 1
            reads.single().tally_dashboard.shouldNotBeNull().tz shouldBe "Europe/London"
        }
        val landed = drive(start.state, TallyInput.Answered(listOf(dashboard("tahoe", "lisbon")))).state
        landed.screen.group_id shouldBe ""
        val data = landed.screen.data_.shouldNotBeNull()
        data.groups.map { it.key } shouldBe listOf("tahoe", "lisbon")
        data.empty.shouldNotBeNull().headline shouldBe TallyCopy.EXPORT_PICK_GROUP
        data.can_save shouldBe false
        landed.screen.chrome.shouldNotBeNull().let {
            it.title shouldBe TallyCopy.EXPORT_HEAD
            it.save shouldBe TallyCopy.EXPORT_COMMIT
            it.back shouldBe "Tally"
        }
    }

    "one group is picked for the member, and its export is read at once" {
        val answered = drive(opened().state, TallyInput.Answered(listOf(dashboard("tahoe"))))
        answered.state.screen.group_id shouldBe "tahoe"
        answered.effects.last() shouldBe ScreenEffect.ReadPage(TallyExportMachine.SCREEN_ID, null)
        TallyExportReads.requests(answered.state, clock)!![1].tally_export.shouldNotBeNull().let {
            it.group_id shouldBe "tahoe"
            it.since shouldBe ""
            it.limit shouldBe TallyExportMachine.LIMIT
            it.tz shouldBe "Europe/London"
        }
    }

    "a range is a since day off the answer's today; the file is the core's, N of M when cut" {
        val landed = drive(
            opened("tahoe").state,
            TallyInput.Answered(listOf(dashboard("tahoe", "lisbon"), export(expenses = 2, inWindow = 2))),
        ).state
        landed.screen.data_.shouldNotBeNull().let {
            it.count_label shouldBe "2 expenses · 0 settlements"
            it.rows.size shouldBe 2
            it.can_save shouldBe true
            it.file_name shouldBe "tahoe-2026-09-25.csv"
            it.ranges.map { r -> r.enabled } shouldBe listOf(true, true, true)
        }
        val year = drive(landed, view(TallyExportEvent(range = TallyExportEvent.RangePicked(range = TallyExportState.Range.RANGE_THIS_YEAR))))
        year.effects shouldBe listOf(ScreenEffect.ReadPage(TallyExportMachine.SCREEN_ID, null))
        year.state.answers.export.shouldBeNull()
        TallyExportReads.requests(year.state, clock)!![1].tally_export!!.since shouldBe "2026-01-01"
        val yearLanded = drive(year.state, TallyInput.Answered(listOf(dashboard("tahoe"), export(expenses = 2, inWindow = 2)))).state
        val month = drive(yearLanded, view(TallyExportEvent(range = TallyExportEvent.RangePicked(range = TallyExportState.Range.RANGE_THIS_MONTH))))
        TallyExportReads.requests(month.state, clock)!![1].tally_export!!.since shouldBe "2026-09-01"

        val cut = drive(month.state, TallyInput.Answered(listOf(dashboard("tahoe"), export(expenses = 1, inWindow = 812)))).state
        cut.screen.data_!!.count_label shouldBe "1 of 812 expenses · 0 settlements"
    }

    "the choice sheets are state, and a range choice carries its enum (#1047)" {
        val landed = drive(
            opened("tahoe").state,
            TallyInput.Answered(listOf(dashboard("tahoe", "lisbon"), export(expenses = 2, inWindow = 2))),
        ).state
        landed.screen.sheet shouldBe TallyExportState.Sheet.SHEET_NONE
        landed.screen.data_!!.ranges.map { it.export_range } shouldBe listOf(
            TallyExportState.Range.RANGE_EVERYTHING,
            TallyExportState.Range.RANGE_THIS_YEAR,
            TallyExportState.Range.RANGE_THIS_MONTH,
        )
        landed.screen.data_.groups.map { it.export_range }.toSet() shouldBe setOf(TallyExportState.Range.RANGE_UNSPECIFIED)
        val ranging = drive(landed, view(TallyExportEvent(sheet_opened = TallyExportEvent.SheetOpened(sheet = TallyExportState.Sheet.SHEET_RANGE)))).state
        ranging.screen.sheet shouldBe TallyExportState.Sheet.SHEET_RANGE
        // Put away without a pick: nothing read.
        drive(ranging, view(TallyExportEvent(sheet_closed = TallyExportEvent.SheetClosed()))).let {
            it.state.screen.sheet shouldBe TallyExportState.Sheet.SHEET_NONE
            it.effects.shouldBeEmpty()
        }
        // A pick closes the sheet — the same range too.
        val picked = ranging.screen.data_!!.ranges[1].export_range
        drive(ranging, view(TallyExportEvent(range = TallyExportEvent.RangePicked(range = picked)))).state.screen.let {
            it.sheet shouldBe TallyExportState.Sheet.SHEET_NONE
            it.range shouldBe TallyExportState.Range.RANGE_THIS_YEAR
        }
        drive(ranging, view(TallyExportEvent(range = TallyExportEvent.RangePicked(range = TallyExportState.Range.RANGE_EVERYTHING))))
            .state.screen.sheet shouldBe TallyExportState.Sheet.SHEET_NONE
        val grouping = drive(landed, view(TallyExportEvent(sheet_opened = TallyExportEvent.SheetOpened(sheet = TallyExportState.Sheet.SHEET_GROUP)))).state
        grouping.screen.sheet shouldBe TallyExportState.Sheet.SHEET_GROUP
        drive(grouping, view(TallyExportEvent(group = TallyExportEvent.GroupPicked(group_id = "lisbon")))).state.screen.let {
            it.sheet shouldBe TallyExportState.Sheet.SHEET_NONE
            it.group_id shouldBe "lisbon"
        }
        // No dashboard yet: no sheet to open.
        drive(opened().state, view(TallyExportEvent(sheet_opened = TallyExportEvent.SheetOpened(sheet = TallyExportState.Sheet.SHEET_RANGE))))
            .state.screen.sheet shouldBe TallyExportState.Sheet.SHEET_NONE
    }

    "Save opens the platform's sheet over the core's file, and says how it went" {
        val landed = drive(opened("tahoe").state, TallyInput.Answered(listOf(dashboard("tahoe"), export(1, 1)))).state
        TallyExportMachine.file(landed).shouldBeNull()
        val open = drive(landed, view(TallyExportEvent(save = TallyExportEvent.SaveRequested()))).state
        open.screen.save shouldBe TallyExportState.Save.SAVE_OPEN
        TallyExportMachine.file(open) shouldBe ("kind,date\r\nexpense,2026-09-20\r\n" to "tahoe-2026-09-25.csv")
        val saved = drive(open, view(TallyExportEvent(save_settled = TallyExportEvent.SaveSettled(saved = true)))).state
        saved.screen.save shouldBe TallyExportState.Save.SAVE_SAVED
        saved.screen.status_label shouldBe TallyCopy.EXPORT_SAVED
        val cancelled = drive(open, view(TallyExportEvent(save_settled = TallyExportEvent.SaveSettled(cancelled = true)))).state
        cancelled.screen.save shouldBe TallyExportState.Save.SAVE_IDLE
        cancelled.screen.status_label shouldBe ""
        drive(open, view(TallyExportEvent(save_settled = TallyExportEvent.SaveSettled(sentence = "Disk full.")))).state
            .screen.status_label shouldBe "Disk full."

        // NOTHING IN THE RANGE: no file, no Save.
        val empty = drive(opened("tahoe").state, TallyInput.Answered(listOf(dashboard("tahoe"), export(0, 0)))).state
        empty.screen.data_!!.empty!!.headline shouldBe TallyCopy.EXPORT_NOTHING
        drive(empty, view(TallyExportEvent(save = TallyExportEvent.SaveRequested()))).state.screen.save shouldBe
            TallyExportState.Save.SAVE_IDLE
    }

    "a group not in the answer, or the one already picked, reads nothing" {
        val landed = drive(opened("tahoe").state, TallyInput.Answered(listOf(dashboard("tahoe"), export(1, 1)))).state
        drive(landed, view(TallyExportEvent(group = TallyExportEvent.GroupPicked(group_id = "nowhere")))).effects.shouldBeEmpty()
        drive(landed, view(TallyExportEvent(group = TallyExportEvent.GroupPicked(group_id = "tahoe")))).effects.shouldBeEmpty()
    }

    "the entry: Tally's More sheet names export, and the route carries the group" {
        TallyHomeMachine.MORE_EXPORT shouldBe "export"
        Destination.TallyExport().groupId shouldBe ""
        Destination.TallyExport("tahoe", parent = "Tahoe").parent shouldBe "Tahoe"
    }
})
