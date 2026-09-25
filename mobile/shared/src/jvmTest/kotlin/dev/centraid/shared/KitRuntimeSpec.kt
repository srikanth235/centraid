package dev.centraid.shared

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandOutcome
import centraid.core.v1.CommandStatus
import centraid.core.v1.Envelope
import centraid.core.v1.Page
import centraid.core.v1.Response
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.NotesEditorEvent
import centraid.screen.v1.NotesEditorState
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.SeatState
import dev.centraid.core.CentraidCore
import dev.centraid.shared.apps.notes.NotesEditorMachine
import dev.centraid.shared.apps.notes.NotesReads
import dev.centraid.shared.kit.ScreenBridge
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.platform.FakeDeviceClock
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import dev.centraid.shared.sync.ScreenQueries
import dev.centraid.shared.sync.ScreenQueryRuntime
import dev.centraid.shared.sync.ScreenRuntime
import dev.centraid.shared.sync.ScreenWrites
import dev.centraid.shared.sync.StrandedWrites
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * THE KIT'S RUNTIME HALF: what a pure reducer cannot do for itself.
 *
 * - a [ScreenEffect.Schedule] is served by BOTH runtimes, and its expiry is the
 *   machine's own `ticked` event (the autosave debounce needs a clock, and a
 *   reducer has none);
 * - a write is pinned to the vault that was foreground when it was EMITTED, not
 *   when the launched coroutine got round to it;
 * - leaving a screen flushes its unsaved words on the SESSION's scope, so
 *   releasing the bridge does not cancel the save — and a flush that fails
 *   after the screen is gone reaches the stranded-write seam.
 */
class KitRuntimeSpec : StringSpec({

    /** A screen that schedules on open and records its ticks. */
    val ticking = object : ScreenMachine<List<String>, String> {
        override fun initial(): List<String> = emptyList()

        override fun reduce(state: List<String>, event: String): Step<List<String>> = when (event) {
            "open" -> Step(state, listOf(ScreenEffect.Schedule(SCREEN, "t-1", 10)))
            "write" -> Step(state, listOf(ScreenEffect.SubmitWrite("probe.write", "{}", "probe:1")))
            else -> Step(state + event)
        }

        override fun ticked(token: String): String = "tick:$token"

        override fun rowsChanged(table: String, keys: List<String>): String? = null

        override fun seatChanged(seat: SeatState): String? = null
    }

    fun executed(): Envelope = Envelope(
        response = Response(command = CommandOutcome(status = CommandStatus.COMMAND_STATUS_EXECUTED)),
    )

    "a Schedule is served by the page runtime, as the machine's own tick" {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val host = ScreenHost(ticking)
            ScreenRuntime(core = { null }, host = host, reads = probeReads(), scope = scope).start()
            host.send("open")
            withTimeout(5_000) { host.state.first { it.isNotEmpty() } } shouldBe listOf("tick:t-1")
        } finally {
            scope.cancel()
        }
    }

    "a Schedule is served by the app-query runtime too" {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val host = ScreenHost(ticking)
            ScreenQueryRuntime(
                core = { null },
                host = host,
                queries = probeQueries(),
                clock = FakeDeviceClock(),
                scope = scope,
            ).start()
            host.send("open")
            withTimeout(5_000) { host.state.first { it.isNotEmpty() } } shouldBe listOf("tick:t-1")
        } finally {
            scope.cancel()
        }
    }

    "a write goes to the vault that was foreground when it was EMITTED" {
        val toA = ConcurrentLinkedQueue<String>()
        val toB = ConcurrentLinkedQueue<String>()
        val a = CentraidCore.answering(Dispatchers.Default) { envelope ->
            envelope.request?.command?.let { toA += it.name }
            executed()
        }
        val b = CentraidCore.answering(Dispatchers.Default) { envelope ->
            envelope.request?.command?.let { toB += it.name }
            executed()
        }
        var foreground: CentraidCore = a
        // A DISPATCHER THIS TEST TURNS BY HAND, so the flip can land exactly
        // between the collector seeing the effect and the write running.
        val queued = Queued()
        val scope = CoroutineScope(SupervisorJob() + queued)
        try {
            val host = ScreenHost(ticking)
            ScreenRuntime(
                core = { foreground },
                host = host,
                reads = probeReads(),
                scope = scope,
                writes = object : ScreenWrites<List<String>, String> {
                    override val appId: String = "probe"

                    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): String =
                        "settled"
                },
            ).start()
            host.send("write")
            queued.runAll() // the collector sees the effect, pins, and queues the write
            foreground = b // the member switches vault before the write has run
            withTimeout(5_000) {
                while ("settled" !in host.state.value) {
                    queued.runAll()
                    kotlinx.coroutines.delay(5)
                }
            }
            toA.toList() shouldBe listOf("probe.write")
            toB.toList() shouldBe emptyList()
        } finally {
            scope.cancel()
            a.close()
            b.close()
        }
    }

    "leaving flushes the unsaved words, and the save survives the bridge's close" {
        val commands = ConcurrentLinkedQueue<String>()
        val core = CentraidCore.answering(Dispatchers.Default) { envelope ->
            val command = envelope.request?.command
            if (command != null) {
                commands += command.input.utf8()
                executed()
            } else {
                notePage()
            }
        }
        val session = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val bridge = ScreenBridge(
                machine = NotesEditorMachine,
                events = NotesEditorEvent.ADAPTER,
                wire = {},
                dispatcher = Dispatchers.Default,
            )
            bridge.attachOn(session) {
                ScreenRuntime(
                    core = { core },
                    host = bridge.host,
                    reads = NotesReads,
                    scope = session,
                    writes = NotesReads,
                    left = { bridge.left },
                ).start()
            }
            loadAndType(bridge.host)
            // CLOSE = DONE, well inside the 900 ms debounce: nothing has been
            // saved yet, and the bridge's own scope is released by `leave()`.
            commands.toList() shouldBe emptyList()
            bridge.leave()
            withTimeout(5_000) {
                bridge.host.state.first { it.autosave?.saved_seq == 1L }
            }
            commands.single() shouldBe "{\"note_id\":\"n-1\",\"body_text\":\"milk and eggs\"}"
        } finally {
            session.cancel()
            core.close()
        }
    }

    "a flush that fails after the screen is left reaches the stranded-write seam" {
        val core = CentraidCore.answering(Dispatchers.Default) { envelope ->
            if (envelope.request?.command != null) {
                Envelope(
                    response = Response(
                        command = CommandOutcome(
                            status = CommandStatus.COMMAND_STATUS_DENIED,
                            reason = "That note was removed.",
                        ),
                    ),
                )
            } else {
                notePage()
            }
        }
        val stranded = ConcurrentLinkedQueue<Triple<String, String, String>>()
        val session = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val bridge = ScreenBridge(NotesEditorMachine, NotesEditorEvent.ADAPTER, {}, Dispatchers.Default)
            bridge.attachOn(session) {
                ScreenRuntime(
                    core = { core },
                    host = bridge.host,
                    reads = NotesReads,
                    scope = session,
                    writes = NotesReads,
                    left = { bridge.left },
                    stranded = StrandedWrites { app, command, sentence -> stranded += Triple(app, command, sentence) },
                ).start()
            }
            loadAndType(bridge.host)
            bridge.leave()
            withTimeout(5_000) {
                bridge.host.state.first { it.save == NotesEditorState.SaveState.SAVE_STATE_REFUSED }
            }
            stranded.single() shouldBe Triple("notes", NotesEditorMachine.SAVE_COMMAND, "That note was removed.")
        } finally {
            session.cancel()
            core.close()
        }
    }
}) {
    private companion object {
        const val SCREEN = "probe.screen"

        /** Runs what was dispatched to it only when told to. */
        class Queued : kotlinx.coroutines.CoroutineDispatcher() {
            private val queue = ArrayDeque<Runnable>()

            override fun dispatch(context: kotlin.coroutines.CoroutineContext, block: Runnable) {
                synchronized(queue) { queue.addLast(block) }
            }

            fun runAll() {
                while (true) {
                    val next = synchronized(queue) { queue.removeFirstOrNull() } ?: return
                    next.run()
                }
            }
        }

        fun probeReads(): dev.centraid.shared.sync.ScreenReads<List<String>, String> =
            object : dev.centraid.shared.sync.ScreenReads<List<String>, String> {
                override val screenId: String = SCREEN
                override val table: String = "probe"
                override val limit: Int = 1
                override fun query(state: List<String>, afterCursor: String?) = null
                override fun arrived(rows: List<centraid.core.v1.Row>, nextCursor: String?): String = "arrived"
                override fun refused(failure: ReadFailure): String = "refused"
            }

        fun probeQueries(): ScreenQueries<List<String>, String> = object : ScreenQueries<List<String>, String> {
            override val screenId: String = SCREEN
            override val tables: Set<String> = emptySet()
            override fun requests(state: List<String>, now: DeviceClock.Reading): List<AppQueryRequest>? = null
            override fun arrived(answers: List<AppQueryResponse>): String = "arrived"
            override fun refused(failure: ReadFailure): String = "refused"
        }

        /** The one row the editor reads: note n-1, "milk". */
        fun notePage(): Envelope = Envelope(
            response = Response(
                page = Page(
                    rows = listOf(
                        Row(
                            values = listOf(
                                Value(text = "n-1"),
                                Value(text = "Groceries"),
                                Value(text = "plain"),
                                Value(integer = 0),
                                Value(text = "rev-1"),
                                Value(text = "2026-09-24T08:00:00Z"),
                                Value(text = "milk"),
                            ),
                        ),
                    ),
                ),
            ),
        )

        /** Open note n-1, wait for it, and type into it — unsaved, inside the debounce. */
        suspend fun loadAndType(host: ScreenHost<NotesEditorState, NotesEditorEvent>) {
            host.send(NotesEditorEvent(opened = NotesEditorEvent.Opened(note_id = "n-1")))
            withTimeout(5_000) { host.state.first { it.draft != null } }
            host.send(NotesEditorEvent(body = NotesEditorEvent.BodyEdited(body = "milk and eggs")))
            host.state.value.draft.shouldNotBeNull().body shouldBe "milk and eggs"
        }
    }
}
