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

    "the runtime opens its one tab, home, rooted at Home, framed by a band" {
        val core = openRealCore()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            core.startReader()
            val screens = Screens(core, scope)
            screens.attach()
            screens.start()
            val navigation = screens.navigation.value!!
            navigation.tabs.map { it.tab } shouldBe listOf("home")
            navigation.selected_tab shouldBe "home"
            val root = navigation.tab("home").entries.single()
            root.route!!.screen shouldBe "home.springboard"
            // The band is Rust's: only the places whose tabs exist, Home lit.
            navigation.band!!.tabs.map { it.tab to it.selected } shouldBe listOf("home" to true)
            // Home's tiles are read in the springboard's order, through the apps' own queries.
            val home = screens.views.value[root.instance]!!.home!!
            home.data_!!.tiles.map { it.app_id } shouldBe
                listOf("photos", "docs", "agenda", "notes", "money", "health", "people", "locker")
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
