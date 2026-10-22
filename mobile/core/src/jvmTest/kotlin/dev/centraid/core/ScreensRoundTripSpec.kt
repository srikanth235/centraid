package dev.centraid.core

import centraid.core.v1.CounterCopyTapped
import centraid.core.v1.CounterEvent
import centraid.core.v1.NavEvent
import centraid.core.v1.NavPush
import centraid.core.v1.Route
import centraid.core.v1.ScreenEvent
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

    "start opens the root and a finished count comes back from Rust" {
        val core = openRealCore()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            core.startReader()
            val screens = Screens(core, scope)
            screens.attach()
            (screens.start() as CoreOutcome.Answered)

            val stack = screens.navigation.value!!.tabs.single().entries
            val view = screens.views.value[stack.single().instance]!!.counter!!
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
            val root = screens.navigation.value!!.tabs.single().entries.single().instance

            screens.send(
                root,
                ScreenEvent(counter = CounterEvent(copy_tapped = CounterCopyTapped())),
            )
            val first = withTimeout(5_000) { screens.effects.first() }
            first.effect?.clipboard_set shouldNotBe null
            screens.views.value[root]!!.counter!!.data_!!.notice shouldContain "Copied"
        } finally {
            scope.coroutineContext[kotlinx.coroutines.Job]?.cancel()
            core.close()
        }
    }

    "the stack is Rust's: a push adds an entry the shell only draws" {
        val core = openRealCore()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            core.startReader()
            val screens = Screens(core, scope)
            screens.start()
            screens.navigate(
                NavEvent(push = NavPush(tab = "proof", route = Route(screen = "proof.counter"))),
            )
            screens.navigation.value!!.tabs.single().entries.size shouldBe 2
        } finally {
            scope.coroutineContext[kotlinx.coroutines.Job]?.cancel()
            core.close()
        }
    }
})
