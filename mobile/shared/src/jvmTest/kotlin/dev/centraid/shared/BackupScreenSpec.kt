package dev.centraid.shared

import centraid.screen.v1.BackupLine
import centraid.screen.v1.BackupScreenEvent
import centraid.screen.v1.BackupScreenState
import dev.centraid.design.copy.SharedCopy
import dev.centraid.shared.platform.BackgroundTasks
import dev.centraid.shared.sync.BackupEffect
import dev.centraid.shared.sync.BackupInput
import dev.centraid.shared.sync.BackupLines
import dev.centraid.shared.sync.BackupModel
import dev.centraid.shared.sync.BackupReading
import dev.centraid.shared.sync.BackupScreenDoors
import dev.centraid.shared.sync.BackupScreenFlow
import dev.centraid.shared.sync.BackupScreenMachine
import dev.centraid.shared.sync.BackupStep
import dev.centraid.shared.sync.DestinationReading
import dev.centraid.shared.sync.ForgetAnswer
import dev.centraid.shared.sync.TransferRule
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.runTest

/**
 * `backup.home`: ONE HONEST LINE, THE GATEWAYS AND THREE CONTROLS (#1080, the
 * shells; seam contract A11).
 *
 * The machine is proved step by step — every word a view draws arrives
 * finished in the state — and the flow once, against doors that record what
 * they were asked, which is the half a shell cannot get wrong.
 */
class BackupScreenSpec : StringSpec({

    val now = 1_790_000_000_000L
    val hour = 60L * 60L * 1_000L

    val home = DestinationReading("gw-1", "Home laptop", listOf("192.168.1.20:7443"), lastSeenMs = now - 120_000, lastAckMs = now)
    val nas = DestinationReading("gw-2", "", emptyList(), lastSeenMs = null, lastAckMs = null)

    fun reading(
        destinations: List<DestinationReading> = listOf(home, nas),
        lastAckMs: Long? = now - 120_000,
        confirmed: Long = 10,
        pending: Long = 0,
    ) = BackupReading(
        destinations = destinations,
        lastSnapshotMs = now - 60_000,
        lastAckMs = lastAckMs,
        contentTotal = 10,
        contentConfirmed = confirmed,
        pendingBytes = pending,
        spoolBytes = pending,
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

    fun BackupModel.on(event: BackupScreenEvent): BackupStep = BackupScreenMachine.reduce(this, BackupInput.View(event))

    val backUpNow = BackupScreenEvent(back_up_now = BackupScreenEvent.BackUpNow())

    "a read draws the line, the gateways and the controls, every word finished" {
        val state = ready(read(rule = TransferRule.WIFI_AND_CELLULAR_PHOTOS)).state
        state.phase shouldBe BackupScreenState.Phase.PHASE_READY
        state.title shouldBe SharedCopy.BACKUP_TITLE
        // THE LINE IS HOME'S LINE, the same value and the same words.
        state.line shouldBe BackupLines.line(reading(), frozen = false, nowMs = now)
        state.line?.sentence shouldBe "Backed up 2 minutes ago."
        state.destinations.map { it.gateway_id } shouldBe listOf("gw-1", "gw-2")
        state.destinations.map { it.label } shouldBe listOf("Home laptop", SharedCopy.BACKUP_UNNAMED)
        state.destinations.map { it.detail } shouldBe
            listOf("192.168.1.20:7443 · Reached 2 minutes ago", SharedCopy.BACKUP_SEEN_NEVER)
        state.destinations.first().accessibility_label shouldBe "Home laptop. 192.168.1.20:7443 · Reached 2 minutes ago"
        state.destinations.last().last_seen_ms shouldBe 0L
        state.add_destination_label shouldBe SharedCopy.BACKUP_ADD_DESTINATION
        state.forget_label shouldBe SharedCopy.BACKUP_FORGET
        state.rule shouldBe TransferRule.WIFI_AND_CELLULAR_PHOTOS.stored
        state.rule_label shouldBe SharedCopy.BACKUP_RULE_HEADING
        state.include_videos shouldBe true
        state.include_videos_label shouldBe SharedCopy.BACKUP_INCLUDE_VIDEOS
        state.back_up_now_label shouldBe SharedCopy.BACKUP_NOW
        state.back_up_now_enabled shouldBe true
        state.last_snapshot_ms shouldBe now - 60_000
        state.last_ack_ms shouldBe now - 120_000
        state.notice shouldBe ""
        state.background_notice shouldBe ""
    }

    "battery saving is mentioned only once a backlog has stood a day" {
        // BEHIND AND UNACKNOWLEDGED FOR MORE THAN A DAY: worth a sentence, and
        // the shell decides whether the platform is actually holding it back.
        val stood = ready(read(reading(lastAckMs = now - 25 * hour, confirmed = 7))).state
        stood.battery_sentence shouldBe SharedCopy.BACKUP_BATTERY
        stood.battery_label shouldBe SharedCopy.BACKUP_BATTERY_ACTION
        // Sealed bytes still waiting are a backlog too.
        ready(read(reading(lastAckMs = now - 25 * hour, pending = 4_096))).state.battery_sentence shouldBe
            SharedCopy.BACKUP_BATTERY
        listOf(
            // A FRESH ACKNOWLEDGEMENT, an old one with nothing behind it, a
            // vault never acknowledged, nothing paired, a frozen vault: none.
            read(reading(lastAckMs = now - 23 * hour, confirmed = 7)),
            read(reading(lastAckMs = now - 25 * hour)),
            read(reading(lastAckMs = null, confirmed = 0)),
            read(reading(destinations = emptyList(), lastAckMs = now - 25 * hour, confirmed = 7)),
            read(reading(lastAckMs = now - 25 * hour, confirmed = 7), frozen = true),
            read(null),
        ).forEach { input ->
            val state = ready(input).state
            state.battery_sentence shouldBe ""
            state.battery_label shouldBe ""
        }
    }

    "a phone that will not wake Centraid says so, in the OS's own sentence" {
        val refused = BackgroundTasks.Registration(
            registered = false,
            sentence = "Background App Refresh is off for Centraid.",
            refusal = "BGTaskSchedulerErrorCodeNotPermitted",
        )
        ready(read(registration = refused)).state.background_notice shouldBe "Background App Refresh is off for Centraid."
        ready(read(registration = BackgroundTasks.Registration(registered = true, sentence = "ok"))).state
            .background_notice shouldBe ""
    }

    "a vault that moved offers no Forget, and a forget sent anyway asks nothing (#1080, the sweep)" {
        // THE CORE REFUSES IT (e91c2bd2b): forgetting would drop the moved mark
        // with the gateway's row, and a later pairing would take the vault over
        // with this phone's older copy. A button that can only fail is not drawn.
        val frozen = ready(read(frozen = true))
        frozen.state.forget_label shouldBe ""
        frozen.on(BackupScreenEvent(forget_destination = BackupScreenEvent.ForgetDestination(gateway_id = "gw-1")))
            .effects.shouldBeEmpty()
        ready(read()).state.forget_label shouldBe SharedCopy.BACKUP_FORGET
    }

    "a vault that moved offers no Add a laptop (#1080, the simulator edge cases)" {
        // ON THE SIMULATOR, the frozen old phone paired its gateway from this
        // button, took the vault over with its stale copy, and set the head
        // over the newer phone's: a superseded phone comes back by restoring.
        ready(read(frozen = true)).state.add_destination_label shouldBe ""
        ready(read()).state.add_destination_label shouldBe SharedCopy.BACKUP_ADD_DESTINATION
    }

    "back up now needs a gateway, a vault that has not moved, and no run already going" {
        val unpaired = ready(read(reading(destinations = emptyList())))
        unpaired.state.back_up_now_enabled shouldBe false
        unpaired.on(backUpNow).effects.shouldBeEmpty()
        val frozen = ready(read(frozen = true))
        frozen.state.back_up_now_enabled shouldBe false
        frozen.on(backUpNow).effects.shouldBeEmpty()

        val running = ready(read(reading(confirmed = 7))).on(backUpNow)
        running.effects shouldBe listOf(BackupEffect.BackUpNow)
        running.model.state.backing_up_now shouldBe true
        running.model.state.back_up_now_enabled shouldBe false
        running.model.state.progress shouldBe "Backing up — 7 of 10 photos and files"
        // A SECOND PRESS STARTS NOTHING HERE: the session's run is already going.
        running.model.on(backUpNow).effects.shouldBeEmpty()
        // NOTHING LEFT TO COUNT is said plainly, never "all 10" while it runs.
        ready().on(backUpNow).model.state.progress shouldBe SharedCopy.BACKUP_NOW_RUNNING
    }

    "a run that ends is re-read, because what it moved is the line's to say" {
        val started = BackupScreenMachine.reduce(ready(), BackupInput.Running(true))
        started.effects.shouldBeEmpty()
        started.model.state.backing_up_now shouldBe true
        val ended = BackupScreenMachine.reduce(started.model, BackupInput.Running(false))
        ended.effects shouldBe listOf(BackupEffect.Read)
        ended.model.state.progress shouldBe ""
        // A "not running" that ends nothing reads nothing.
        BackupScreenMachine.reduce(ready(), BackupInput.Running(false)).effects.shouldBeEmpty()
    }

    "a run that is going is re-read as it goes, and nothing else is" {
        val going = BackupScreenMachine.reduce(ready(), BackupInput.Running(true)).model
        BackupScreenMachine.reduce(going, BackupInput.Tick).effects shouldBe listOf(BackupEffect.Read)
        BackupScreenMachine.reduce(ready(), BackupInput.Tick).effects.shouldBeEmpty()
        // A CLOSED SCREEN reads nothing, run or no run.
        val closed = going.on(BackupScreenEvent(dismissed = BackupScreenEvent.Dismissed())).model
        BackupScreenMachine.reduce(closed, BackupInput.Tick).effects.shouldBeEmpty()
    }

    "the flow re-reads a running pass every interval and stops when it ends (#1080, the simulator smoke)" {
        runTest {
            val doors = RecordingDoors(reading(confirmed = 7))
            val scope = CoroutineScope(coroutineContext + Job())
            val flow = BackupScreenFlow(doors, scope)
            flow.start()
            flow.reduce(BackupInput.View(BackupScreenEvent(opened = BackupScreenEvent.Opened())))
            testScheduler.runCurrent()
            doors.reads shouldBe 1
            doors.running.value = true
            testScheduler.advanceTimeBy(BackupScreenFlow.PROGRESS_READ_MS * 3 + 1)
            doors.reads shouldBe 4
            doors.running.value = false
            testScheduler.runCurrent()
            // THE ENDED RUN READ ONCE MORE, AND THE TICKS STOPPED.
            doors.reads shouldBe 5
            testScheduler.advanceTimeBy(BackupScreenFlow.PROGRESS_READ_MS * 5)
            doors.reads shouldBe 5
            scope.cancel()
        }
    }

    "an open screen re-reads when a pass it did not start moves the line, and a closed one does not" {
        BackupScreenMachine.reduce(ready(), BackupInput.Moved).effects shouldBe listOf(BackupEffect.Read)
        val closed = ready().on(BackupScreenEvent(dismissed = BackupScreenEvent.Dismissed())).model
        BackupScreenMachine.reduce(closed, BackupInput.Moved).effects.shouldBeEmpty()
    }

    "the flow follows the line a pass moved while the screen is open (#1080, the simulator edge cases)" {
        runTest {
            // A VIDEO THE WALKER IMPORTED and a pass backed up while the screen
            // stood open: Home read "All 60" while this screen kept "All 59".
            val doors = RecordingDoors(reading(confirmed = 7))
            val scope = CoroutineScope(coroutineContext + Job())
            val flow = BackupScreenFlow(doors, scope)
            flow.start()
            flow.reduce(BackupInput.View(BackupScreenEvent(opened = BackupScreenEvent.Opened())))
            testScheduler.runCurrent()
            doors.reads shouldBe 1
            doors.lines.value = BackupLine(confirmed = 8, total = 8, sentence = "Backed up just now.")
            testScheduler.runCurrent()
            doors.reads shouldBe 2
            // CLOSED, it hears the line and reads nothing.
            flow.reduce(BackupInput.View(BackupScreenEvent(dismissed = BackupScreenEvent.Dismissed())))
            doors.lines.value = BackupLine(confirmed = 9, total = 9, sentence = "Backed up just now.")
            testScheduler.runCurrent()
            doors.reads shouldBe 2
            scope.cancel()
        }
    }

    "include videos is written as the member set it" {
        val off = ready().on(BackupScreenEvent(set_include_videos = BackupScreenEvent.SetIncludeVideos(include = false)))
        off.effects shouldBe listOf(BackupEffect.WriteIncludeVideos(false))
        off.model.state.include_videos shouldBe false
    }

    "forgetting asks nothing, reaches only a gateway the screen draws, and says whether the gateway will refuse this phone" {
        val forget = { id: String -> BackupScreenEvent(forget_destination = BackupScreenEvent.ForgetDestination(gateway_id = id)) }
        ready().on(forget("gw-1")).effects shouldBe listOf(BackupEffect.Forget("gw-1", "Home laptop"))
        ready().on(forget("gw-2")).effects shouldBe listOf(BackupEffect.Forget("gw-2", SharedCopy.BACKUP_UNNAMED))
        ready().on(forget("gw-9")).effects.shouldBeEmpty()

        val revoked = BackupScreenMachine.reduce(
            ready(),
            BackupInput.Forgot("gw-1", "Home laptop", forgotten = true, revoked = true),
        )
        revoked.model.state.notice shouldBe
            "This phone no longer backs up to Home laptop. Your laptop will refuse this phone from now on."
        revoked.effects shouldBe listOf(BackupEffect.Read)
        // NOT TOLD: the token stays live there, so the member is told how to end it.
        BackupScreenMachine.reduce(ready(), BackupInput.Forgot("gw-1", "Home laptop", forgotten = true, revoked = false))
            .model.state.notice shouldBe SharedCopy.BACKUP_FORGOTTEN_NOT_REVOKED.replace("{name}", "Home laptop")
        SharedCopy.BACKUP_FORGOTTEN_NOT_REVOKED shouldContain "centraid-gateway pairings revoke"
        BackupScreenMachine.reduce(ready(), BackupInput.Forgot("gw-1", "Home laptop", forgotten = false))
            .model.state.notice shouldBe "Centraid could not forget Home laptop. Try again."
    }

    "a dismissed screen hears nothing until it is opened again" {
        val closed = ready().on(BackupScreenEvent(dismissed = BackupScreenEvent.Dismissed())).model
        closed.state.phase shouldBe BackupScreenState.Phase.PHASE_CLOSED
        closed.on(backUpNow).effects.shouldBeEmpty()
        BackupScreenMachine.reduce(closed, read()).model.state.phase shouldBe BackupScreenState.Phase.PHASE_CLOSED
        closed.on(BackupScreenEvent(opened = BackupScreenEvent.Opened())).effects shouldBe listOf(BackupEffect.Read)
    }

    "the flow runs each act through its door and re-reads after a run and a forget" {
        runTest {
            val doors = RecordingDoors(reading(confirmed = 7))
            // THE TEST'S OWN SCOPE: `advanceUntilIdle` leaves `backgroundScope`'s
            // ready work unrun, and the effects are what is under test.
            val flow = BackupScreenFlow(doors, this)
            flow.reduce(BackupInput.View(BackupScreenEvent(opened = BackupScreenEvent.Opened())))
            testScheduler.advanceUntilIdle()
            flow.state.value.phase shouldBe BackupScreenState.Phase.PHASE_READY
            doors.reads shouldBe 1
            flow.reduce(BackupInput.View(backUpNow))
            flow.reduce(
                BackupInput.View(BackupScreenEvent(set_include_videos = BackupScreenEvent.SetIncludeVideos(include = false))),
            )
            testScheduler.advanceUntilIdle()
            doors.backUps shouldBe 1
            doors.videos shouldBe listOf(false)
            // OPENED READ ONCE; THE ENDED RUN READ AGAIN.
            doors.reads shouldBe 2
            flow.state.value.backing_up_now shouldBe false
            flow.reduce(
                BackupInput.View(BackupScreenEvent(forget_destination = BackupScreenEvent.ForgetDestination(gateway_id = "gw-1"))),
            )
            testScheduler.advanceUntilIdle()
            doors.forgets shouldBe listOf("gw-1")
            doors.reads shouldBe 3
            // THE DOOR'S `revoked` REACHES THE SCREEN (#1080).
            flow.state.value.notice shouldBe SharedCopy.BACKUP_FORGOTTEN_REVOKED.replace("{name}", "Home laptop")
        }
    }
})

/** Doors that answer one reading and remember what they were asked. */
private class RecordingDoors(private val reading: BackupReading) : BackupScreenDoors {
    var reads = 0
    var backUps = 0
    val videos = mutableListOf<Boolean>()
    val forgets = mutableListOf<String>()

    override suspend fun read(): BackupReading {
        reads += 1
        return reading
    }

    override suspend fun rule(): TransferRule = TransferRule.DEFAULT

    override suspend fun includeVideos(): Boolean = videos.lastOrNull() ?: true

    override suspend fun writeIncludeVideos(include: Boolean) {
        videos += include
    }

    override fun registration(): BackgroundTasks.Registration? = null

    override suspend fun backUpNow() {
        backUps += 1
    }

    val running = MutableStateFlow(false)

    override val backingUp: StateFlow<Boolean> = running

    val lines = MutableStateFlow(BackupLines.line(reading, frozen = false, nowMs = 0))

    override val line: StateFlow<BackupLine> = lines

    override suspend fun forget(gatewayId: String): ForgetAnswer {
        forgets += gatewayId
        return ForgetAnswer(forgotten = true, revoked = true)
    }

    override fun nowMs(): Long = 0
}
