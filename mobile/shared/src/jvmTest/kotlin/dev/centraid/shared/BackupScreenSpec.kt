package dev.centraid.shared

import centraid.screen.v1.BackupLine
import centraid.screen.v1.BackupScreenEvent
import centraid.screen.v1.BackupScreenState
import dev.centraid.design.copy.SharedCopy
import dev.centraid.design.copy.WordsCopy
import dev.centraid.shared.custody.CustodyCopy
import dev.centraid.shared.custody.PairAnswer
import dev.centraid.shared.custody.PairDoor
import dev.centraid.shared.custody.PairRefusal
import dev.centraid.shared.custody.PairResult
import dev.centraid.shared.platform.BackgroundTasks
import dev.centraid.shared.shell.BackupEffect
import dev.centraid.shared.shell.BackupInput
import dev.centraid.shared.shell.BackupModel
import dev.centraid.shared.shell.BackupScreenDoors
import dev.centraid.shared.shell.BackupScreenFlow
import dev.centraid.shared.shell.BackupScreenMachine
import dev.centraid.shared.sync.BackupLines
import dev.centraid.shared.sync.BackupReading
import dev.centraid.shared.sync.DestinationReading
import dev.centraid.shared.sync.TransferRule
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.runTest

/**
 * `backup.home`: THREE CONTROLS AND THE GATEWAYS (#1080, the shells).
 *
 * The machine is proved step by step; the flow once, against doors that
 * record what they were asked, which is the half a shell cannot get wrong.
 */
class BackupScreenSpec : StringSpec({

    val now = 1_790_000_000_000L

    val home = DestinationReading("gw-1", "Home laptop", listOf("192.168.1.20:7443"), lastSeenMs = now - 120_000, lastAckMs = now)
    val nas = DestinationReading("gw-2", "", emptyList(), lastSeenMs = null, lastAckMs = null)

    fun reading(destinations: List<DestinationReading> = listOf(home, nas), spool: Long = 0) = BackupReading(
        destinations = destinations,
        lastSnapshotMs = now - 60_000,
        lastAckMs = now - 120_000,
        contentTotal = 10,
        contentConfirmed = 10,
        pendingBytes = spool,
        spoolBytes = spool,
        waiting = emptyMap(),
        frozen = false,
    )

    fun read(
        reading: BackupReading? = reading(),
        rule: TransferRule = TransferRule.WIFI_ONLY,
        frozen: Boolean = false,
        registration: BackgroundTasks.Registration? = null,
    ) = BackupInput.Read(
        reading = reading,
        line = BackupLines.line(reading, frozen = frozen, nowMs = now),
        rule = rule,
        includeVideos = true,
        registration = registration,
        nowMs = now,
    )

    fun ready(input: BackupInput.Read = read()): BackupModel {
        val opened = BackupScreenMachine.reduce(
            BackupScreenMachine.initial(),
            BackupInput.View(BackupScreenEvent(opened = BackupScreenEvent.Opened())),
        )
        opened.effects shouldBe listOf(BackupEffect.Read)
        opened.model.state.phase shouldBe BackupScreenState.Phase.PHASE_LOADING
        return BackupScreenMachine.reduce(opened.model, input).model
    }

    fun BackupModel.on(event: BackupScreenEvent) = BackupScreenMachine.reduce(this, BackupInput.View(event))

    "a read draws the line, the gateways and the three controls, all finished" {
        val state = ready().state
        state.phase shouldBe BackupScreenState.Phase.PHASE_READY
        state.title shouldBe SharedCopy.BACKUP_TITLE
        state.line?.sentence shouldBe "Backed up 2 minutes ago."
        state.destinations.map { it.label } shouldBe listOf("Home laptop", SharedCopy.BACKUP_UNNAMED)
        state.destinations.map { it.address } shouldBe listOf("192.168.1.20:7443", "")
        state.destinations.map { it.seen_label } shouldBe listOf("Reached 2 minutes ago", SharedCopy.BACKUP_SEEN_NEVER)
        state.destinations_heading shouldBe SharedCopy.BACKUP_DESTINATIONS
        state.rule shouldBe TransferRule.WIFI_ONLY.stored
        state.rule_choices.map { it.stored } shouldBe
            listOf(TransferRule.WIFI_ONLY.stored, TransferRule.WIFI_AND_CELLULAR_PHOTOS.stored)
        state.rule_choices.single { it.selected }.stored shouldBe TransferRule.WIFI_ONLY.stored
        state.include_videos shouldBe true
        state.back_up_now_label shouldBe SharedCopy.BACKUP_NOW
        state.back_up_now_enabled shouldBe true
        state.spool_label shouldBe ""
        state.background_notice shouldBe ""
    }

    "manual is drawn only while it is the member's rule, and then it is the selected one" {
        val state = ready(read(rule = TransferRule.MANUAL)).state
        state.rule_choices.map { it.stored } shouldBe TransferRule.entries.map { it.stored }
        state.rule_choices.single { it.selected }.stored shouldBe TransferRule.MANUAL.stored
    }

    "a spool and a refused registration are said, in words" {
        val state = ready(
            read(
                reading = reading(spool = 120_000_000),
                registration = BackgroundTasks.Registration(false, "Background App Refresh is off."),
            ),
        ).state
        state.spool_label shouldBe "Ready to upload: 120 MB"
        state.background_notice shouldBe "Background App Refresh is off."
    }

    "back up now needs a gateway, a vault that has not moved, and no run already going" {
        val step = ready().on(BackupScreenEvent(back_up_now = BackupScreenEvent.BackUpNow()))
        step.effects shouldBe listOf(BackupEffect.BackUpNow)
        step.model.state.back_up_now_label shouldBe SharedCopy.BACKUP_NOW_RUNNING
        step.model.state.back_up_now_enabled shouldBe false
        // A SECOND PRESS WHILE IT RUNS ASKS NOTHING.
        step.model.on(BackupScreenEvent(back_up_now = BackupScreenEvent.BackUpNow())).effects.shouldBeEmpty()
        // NO GATEWAY, OR A MOVED VAULT: the button is off and a press asks nothing.
        listOf(ready(read(reading = reading(destinations = emptyList()))), ready(read(frozen = true))).forEach { model ->
            model.state.back_up_now_enabled shouldBe false
            model.on(BackupScreenEvent(back_up_now = BackupScreenEvent.BackUpNow())).effects.shouldBeEmpty()
        }
    }

    "a run that ends is re-read, because what it moved is the line's to say" {
        val running = BackupScreenMachine.reduce(ready(), BackupInput.Running(true)).model
        running.state.backing_up_now shouldBe true
        BackupScreenMachine.reduce(running, BackupInput.Running(false)).effects shouldBe listOf(BackupEffect.Read)
    }

    "the rule and the videos switch are written as the member set them" {
        val rule = ready().on(BackupScreenEvent(set_rule = BackupScreenEvent.SetRule(stored = "wifi-and-cellular-photos")))
        rule.effects shouldBe listOf(BackupEffect.WriteRule(TransferRule.WIFI_AND_CELLULAR_PHOTOS))
        rule.model.state.rule shouldBe TransferRule.WIFI_AND_CELLULAR_PHOTOS.stored
        // AN UNKNOWN WORD IS THE DEFAULT, never a rule that spends more.
        ready().on(BackupScreenEvent(set_rule = BackupScreenEvent.SetRule(stored = "everything")))
            .effects shouldBe listOf(BackupEffect.WriteRule(TransferRule.DEFAULT))
        val videos = ready().on(BackupScreenEvent(set_include_videos = BackupScreenEvent.SetIncludeVideos(include = false)))
        videos.effects shouldBe listOf(BackupEffect.WriteIncludeVideos(false))
        videos.model.state.include_videos shouldBe false
    }

    "a pairing payload pairs, and a blank one is told what to paste" {
        ready().on(BackupScreenEvent(add_destination = BackupScreenEvent.AddDestination(payload = "  ")))
            .model.state.notice shouldBe CustodyCopy.PAIR_EMPTY
        val pairing = ready().on(BackupScreenEvent(add_destination = BackupScreenEvent.AddDestination(payload = "pair {\"v\":2}")))
        pairing.model.state.phase shouldBe BackupScreenState.Phase.PHASE_PAIRING
        (pairing.effects.single() as BackupEffect.Pair).toString() shouldBe "Pair(<redacted>)"
    }

    "each pairing answer has its own sentence, and a blank safety number refuses" {
        fun after(result: PairResult) =
            BackupScreenMachine.reduce(ready(), BackupInput.Paired(result))
        after(PairResult.Paired(PairAnswer("gw", safetyNumber = "12345", laptopName = "NAS"))).model.state.notice shouldBe
            "Now backing up to NAS."
        after(PairResult.Paired(PairAnswer("gw", safetyNumber = ""))).model.state.notice shouldBe
            CustodyCopy.PAIR_NOTHING_TO_COMPARE
        after(PairResult.Refused(PairRefusal.NOT_TAKEN)).model.state.notice shouldBe WordsCopy.PAIR_NOT_TAKEN
        after(PairResult.Refused(PairRefusal.UNREACHABLE)).effects shouldBe listOf(BackupEffect.Read)
    }

    "forgetting a gateway asks first, and only a yes forgets" {
        val asked = ready().on(BackupScreenEvent(forget_destination = BackupScreenEvent.ForgetDestination(destination_id = "gw-1")))
        asked.effects.shouldBeEmpty()
        val confirm = asked.model.state.confirm.shouldNotBeNull()
        confirm.title shouldBe "Stop backing up to Home laptop?"
        confirm.destructive shouldBe true
        asked.model.state.confirming_destination_id shouldBe "gw-1"
        asked.model.on(BackupScreenEvent(forget_cancelled = BackupScreenEvent.ForgetCancelled())).let {
            it.effects.shouldBeEmpty()
            it.model.state.confirm.shouldBeNull()
        }
        asked.model.on(BackupScreenEvent(forget_confirmed = BackupScreenEvent.ForgetConfirmed())).effects shouldBe
            listOf(BackupEffect.Forget("gw-1", "Home laptop"))
        // A GATEWAY THE SCREEN IS NOT DRAWING CANNOT BE FORGOTTEN FROM IT.
        ready().on(BackupScreenEvent(forget_destination = BackupScreenEvent.ForgetDestination(destination_id = "gw-9")))
            .model.state.confirm.shouldBeNull()
        BackupScreenMachine.reduce(ready(), BackupInput.Forgot("gw-1", "Home laptop", forgotten = true))
            .model.state.notice shouldBe "This phone no longer backs up to Home laptop."
    }

    "a dismissed screen hears nothing until it is opened again" {
        val closed = ready().on(BackupScreenEvent(dismissed = BackupScreenEvent.Dismissed())).model
        closed.state.phase shouldBe BackupScreenState.Phase.PHASE_CLOSED
        closed.on(BackupScreenEvent(back_up_now = BackupScreenEvent.BackUpNow())).effects.shouldBeEmpty()
    }

    "the flow runs each act through its door and re-reads after a run" {
        runTest {
            val doors = RecordingDoors(reading())
            // THE TEST'S OWN SCOPE: `advanceUntilIdle` leaves `backgroundScope`'s
            // ready work unrun, and the effects are what is under test.
            val flow = BackupScreenFlow(doors, this)
            flow.reduce(BackupInput.View(BackupScreenEvent(opened = BackupScreenEvent.Opened())))
            testScheduler.advanceUntilIdle()
            flow.state.value.phase shouldBe BackupScreenState.Phase.PHASE_READY
            flow.reduce(BackupInput.View(BackupScreenEvent(back_up_now = BackupScreenEvent.BackUpNow())))
            flow.reduce(BackupInput.View(BackupScreenEvent(set_rule = BackupScreenEvent.SetRule("wifi-and-cellular-photos"))))
            testScheduler.advanceUntilIdle()
            doors.backUps shouldBe 1
            doors.rules shouldBe listOf(TransferRule.WIFI_AND_CELLULAR_PHOTOS)
            // OPENED READ ONCE; THE ENDED RUN READ AGAIN.
            doors.reads shouldBe 2
            flow.state.value.backing_up_now shouldBe false
        }
    }
})

/** Doors that answer one reading and remember what they were asked. */
private class RecordingDoors(private val reading: BackupReading) : BackupScreenDoors {
    var reads = 0
    var backUps = 0
    val rules = mutableListOf<TransferRule>()

    override suspend fun read(): BackupReading {
        reads += 1
        return reading
    }

    override fun line(): BackupLine = BackupLines.line(reading, frozen = false, nowMs = 0)

    override suspend fun rule(): TransferRule = rules.lastOrNull() ?: TransferRule.DEFAULT

    override suspend fun includeVideos(): Boolean = true

    override suspend fun writeRule(rule: TransferRule) {
        rules += rule
    }

    override suspend fun writeIncludeVideos(include: Boolean) = Unit

    override fun registration(): BackgroundTasks.Registration? = null

    override suspend fun backUpNow() {
        backUps += 1
    }

    override val backingUp: StateFlow<Boolean> = MutableStateFlow(false)

    override fun pairDoor(): PairDoor? = null

    override suspend fun forget(destinationId: String): Boolean? = null

    override fun nowMs(): Long = 0
}
