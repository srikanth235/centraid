package dev.centraid.shared

import app.cash.turbine.test
import centraid.screen.v1.SeatState
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.withContext

/**
 * The host of the shell's state machines (#1020, D-1020-E3): a reducer is
 * `(state, event) -> (state, effects)` and nothing else — no dispatcher, no
 * clock, no core — and the host is what serialises it.
 *
 * The screens these first ran through (a paged list, Home's grid) are Rust's now
 * (#1135: `crates/screens`, tested through `Driver`), so the host is proved on a
 * counter, which is the shape of the bug it exists to stop.
 */
class ScreenMachineSpec : StringSpec({

    "the host publishes a finished state before it emits the effect that asked for it" {
        val host = ScreenHost(Counter)
        host.effects.test {
            host.send(1)
            // The state is already the new state by the time the effect arrives,
            // so an answer delivered synchronously cannot beat it.
            host.state.value shouldBe 1
            awaitItem() shouldBe ScreenEffect.ReadPage(Counter.ID, null)
        }
        host.revision shouldBe 1uL
    }

    "the host's revision is monotonic per instance" {
        val host = ScreenHost(Counter)
        host.send(1)
        host.send(2)
        host.revision shouldBe 2uL
        host.state.value shouldBe 3
    }

    "CONCURRENT SENDS DO NOT LOSE ONE ANOTHER'S STATE" {
        // The shell's answers land on whatever threads the core's dispatcher gave
        // them. Before `ScreenHost` took a lock, two answers read the same state,
        // reduced their own event onto it, and the second write threw the first
        // away. It was invisible on a single-threaded dispatcher and showed up the
        // first time a real core answered from a pool.
        val host = ScreenHost(Counter)
        withContext(Dispatchers.Default) {
            (1..EIGHT).map { async { host.send(1) } }.awaitAll()
        }
        // EVERY one of them, not most of them.
        host.state.value shouldBe EIGHT
        host.revision shouldBe EIGHT.toULong()
    }
}) {
    private companion object {
        const val EIGHT: Int = 8

        /** The smallest machine: the state is the sum of what it was told. */
        object Counter : ScreenMachine<Int, Int> {
            const val ID: String = "test.counter"
            override fun initial(): Int = 0
            override fun reduce(state: Int, event: Int): Step<Int> =
                Step(state + event, listOf(ScreenEffect.ReadPage(ID, null)))
            override fun rowsChanged(table: String, keys: List<String>): Int? = null
            override fun seatChanged(seat: SeatState): Int? = null
        }
    }
}
