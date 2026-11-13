package dev.centraid.core

import centraid.core.v1.Envelope
import centraid.core.v1.ScreenEvent
import centraid.core.v1.WordsEnterEvent
import centraid.core.v1.WordsWordTyped
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlin.coroutines.CoroutineContext

/** The worker pool may run newer work first; that must not reverse the member's edits. */
class ScreensOrderingSpec : StringSpec({
    "screen edits reach the ABI in submission order even when IO work is selected newest first" {
        val io = NewestFirstDispatcher()
        val delivered = mutableListOf<String>()
        val abi = FakeCentraidAbi { bytes ->
            val request = Envelope.ADAPTER.decode(bytes)
            delivered += requireNotNull(request.request?.screen?.send?.event?.words_enter?.typed).text
            FakeCentraidAbi.ok(Envelope(request_id = request.request_id))
        }
        val core = CentraidCore.overAbi(abi, io, uiThreadName = "")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        try {
            val screens = Screens(core, scope)
            fun edit(text: String) = scope.launch(start = CoroutineStart.UNDISPATCHED) {
                screens.send(
                    7L,
                    ScreenEvent(words_enter = WordsEnterEvent(typed = WordsWordTyped(position = 2, text = text))),
                ) shouldBe CoreOutcome.Answered(Unit)
            }

            // Public dummy text only. Both submissions run up to their first suspension now.
            val older = edit("A")
            val newer = edit("AB")
            delivered shouldBe emptyList()

            // An adversarial worker pool chooses the newest runnable, with no threads or sleeps.
            io.runNewest()
            io.runNewest()
            io.pending shouldBe 0
            older.isCompleted shouldBe true
            newer.isCompleted shouldBe true
            delivered shouldBe listOf("A", "AB")
        } finally {
            scope.cancel()
            core.close()
        }
    }
})

private class NewestFirstDispatcher : CoroutineDispatcher() {
    private val work = ArrayDeque<Runnable>()
    val pending: Int get() = work.size

    override fun dispatch(context: CoroutineContext, block: Runnable) {
        work.addLast(block)
    }

    fun runNewest() {
        check(work.isNotEmpty()) { "a submitted core call must have IO work" }
        work.removeLast().run()
    }
}
