package dev.centraid.core

import centraid.core.v1.CounterCopyTapped
import centraid.core.v1.CounterEvent
import centraid.core.v1.NavEvent
import centraid.core.v1.NavPopped
import centraid.core.v1.NavPush
import centraid.core.v1.Navigation
import centraid.core.v1.Route
import centraid.core.v1.ScreenEvent
import centraid.core.v1.TabStack
import dev.centraid.core.AbiRoundTripSpec.Companion.openRealCore
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldContain
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout

/**
 * THE SCREEN RUNTIME THROUGH THE REAL LIBRARY (#1135, lane C2).
 *
 * `crates/screens`' own tests drive the runtime in Rust; this one proves the
 * same five symbols carry it to Kotlin — a `Request.screen` over `centraid_call`
 * and a pushed `Event.screen` over `centraid_next_event` — and that [Screens]
 * holds what Compose draws. The proof screen's finished strings come from Rust;
 * nothing here writes any.
 */
class ScreensRoundTripSpec : StringSpec({

    "the room runtime opens the home shell room through centraid_call" {
        val core = openRealCore()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            core.startReader()
            val outcome = core.call(
                centraid.core.v1.Envelope(
                    request_id = 0,
                    request = centraid.core.v1.Request(
                        room = centraid.core.v1.RoomRequest(
                            open_ = centraid.core.v1.RoomOpen(key = "home", tab = "home", root = true),
                        ),
                    ),
                ),
            )
            val answered = outcome as CoreOutcome.Answered
            val shown = answered.value.response!!.room!!.shown.single()
            shown.tab shouldBe "home"
            shown.room!!.key shouldBe "home"
            shown.room!!.kind shouldBe centraid.core.v1.RoomKind.ROOM_KIND_HOME
            shown.room!!.ready!!.blocks.isNotEmpty() shouldBe true
        } finally {
            scope.coroutineContext[kotlinx.coroutines.Job]?.cancel()
            core.close()
        }
    }

    "start opens the root and a finished count comes back from Rust" {
        val core = openRealCore()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            core.startReader()
            val screens = Screens(core, scope)
            screens.attach()
            (screens.start() as CoreOutcome.Answered)

            val opened = pushProof(screens)
            val view = screens.views.value[opened]!!.counter!!
            view.title shouldBe "Upcoming"
            val data = view.data_!!
            data.count_label shouldContain "upcoming event"
            data.copy_label shouldBe "Copy the count"
        } finally {
            scope.coroutineContext[kotlinx.coroutines.Job]?.cancel()
            core.close()
        }
    }

    "a tap is an event; the platform work Rust asks for arrives as an effect" {
        val core = openRealCore()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            core.startReader()
            val screens = Screens(core, scope)
            screens.attach()
            screens.start()
            val root = pushProof(screens)

            screens.send(
                root,
                ScreenEvent(counter = CounterEvent(copy_tapped = CounterCopyTapped())),
            )
            val first = withTimeout(5_000) { screens.effects.first { it.instance == root } }
            first.effect?.clipboard_set shouldNotBe null
            screens.views.value[root]!!.counter!!.data_!!.notice shouldContain "Copied"
        } finally {
            scope.coroutineContext[kotlinx.coroutines.Job]?.cancel()
            core.close()
        }
    }

    "the stack is Rust's: a push adds an entry the shell only draws, and a pop takes it off" {
        val core = openRealCore()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            core.startReader()
            val screens = Screens(core, scope)
            screens.start()
            screens.navigation.value!!.tab("home").entries.size shouldBe 1
            val pushed = pushProof(screens)
            screens.navigation.value!!.tab("home").entries.size shouldBe 2
            screens.navigate(NavEvent(popped = NavPopped(tab = "home", instance = pushed)))
            screens.navigation.value!!.tab("home").entries.size shouldBe 1
        } finally {
            scope.coroutineContext[kotlinx.coroutines.Job]?.cancel()
            core.close()
        }
    }
}) {
    private companion object {
        fun Navigation.tab(name: String): TabStack = tabs.single { it.tab == name }

        /** Push the proof screen onto Home's tab as a tapped row would; its instance. */
        suspend fun pushProof(screens: Screens): Long {
            screens.navigate(
                NavEvent(push = NavPush(tab = "home", route = Route(screen = "proof.counter"))),
            )
            return screens.navigation.value!!.tab("home").entries.last().instance
        }
    }
}
