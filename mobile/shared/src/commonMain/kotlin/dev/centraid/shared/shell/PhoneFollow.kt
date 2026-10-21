package dev.centraid.shared.shell

import centraid.screen.v1.Confirm
import dev.centraid.shared.sync.phone.FollowGate
import dev.centraid.shared.sync.phone.FollowStep
import dev.centraid.shared.sync.phone.OriginGone
import dev.centraid.shared.sync.phone.PhoneFollowPass
import dev.centraid.shared.sync.phone.PhoneSource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * THE QUESTION AN ORIGIN HELD FOR THE MEMBER LEAVES (R-1127-9), every word already chosen: the
 * shell draws [confirm] in the kit's `ConfirmSheet` with [keepLabel] as its cancel, and calls
 * [PhoneFollowBridge.answer]. **Keep is the default**: the sheet's cancel, and what a dismissal
 * that is not a button means.
 */
public data class PhoneFollowQuestion(
    public val source: PhoneSource,
    public val originId: String,
    public val title: String,
    public val body: String,
    public val keepLabel: String,
    public val trashLabel: String,
) {
    /**
     * THE QUESTION AS THE KIT'S CONFIRM (DESIGN.md: a destructive confirm goes through
     * `ConfirmSheet`, never an alert): Move to trash is the one destructive verb, drawn as the
     * `net` outline; Keep is not in it, because it is the sheet's cancel ([keepLabel]).
     */
    public val confirm: Confirm
        get() = Confirm(title = title, body = body, confirm_label = trashLabel, destructive = true)

    /** [confirm], encoded for SwiftUI. */
    public val confirmBytes: ByteArray get() = confirm.encode()
}

/**
 * THE FOLLOWER: TRIGGERS IN, ONE PASS AT A TIME, QUESTIONS OUT (#1127).
 *
 * A trigger ([requested]) goes through [FollowGate]; when the gate says go, the pass:
 * 1. stops unless the member imported the source ([PhoneFollowPass.imported]): **a foreground pass
 *    never imports into a vault that never tapped Import**;
 * 2. runs the source's pass ([PhoneFollowPass.run]), which reads the phone only if the OS already
 *    allows it and stops there if it does not;
 * 3. offers each origin the pass holds to the member, one question at a time.
 *
 * A question already open or waiting is not asked again when a later pass holds the same origin.
 * Everything runs on [scope]'s one thread, so none of this is locked.
 */
internal class PhoneFollower(
    private val scope: CoroutineScope,
    private val passes: Map<PhoneSource, PhoneFollowPass>,
    private val ask: (PhoneFollowQuestion) -> Unit,
    private val now: () -> Long,
    settleMs: Long = FollowGate.SETTLE_MS,
) {
    private val gate = FollowGate(settleMs)
    private val waiting = ArrayDeque<OriginGone>()
    private var open: OriginGone? = null
    private var answering = false

    /** A change on the phone, or the app coming forward: follow [source] soon. */
    fun requested(source: PhoneSource) {
        if (source !in passes) return
        val step = gate.request(source, now())
        if (step is FollowStep.Arm) {
            scope.launch {
                delay(step.delayMs)
                if (gate.fire(source, now()) is FollowStep.Start) run(source)
            }
        }
    }

    /** The member answered the question [open] holds; a stale answer (another vault's, a second tap) is ignored. */
    fun answer(originId: String, keep: Boolean) {
        val gone = open?.takeIf { it.originId == originId && !answering } ?: return
        val pass = passes[gone.source] ?: return
        answering = true
        scope.launch {
            pass.resolve(gone, keep)
            // Open until the answer is written, so a pass meanwhile does not ask the same thing again.
            open = null
            answering = false
            offerNext()
        }
    }

    private suspend fun run(source: PhoneSource) {
        do {
            try {
                pass(source)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (@Suppress("TooGenericExceptionCaught") failed: Exception) {
                // A pass that fails is a pass that did nothing; the next trigger tries again.
            }
        } while (gate.finish(source) is FollowStep.Start)
    }

    private suspend fun pass(source: PhoneSource) {
        val pass = passes[source] ?: return
        if (pass.imported() != true) return
        val gone = pass.run() ?: return
        hold(source, gone)
    }

    private fun hold(source: PhoneSource, gone: List<OriginGone>) {
        // A queued question whose origin this pass no longer holds (it came back) is withdrawn.
        waiting.removeAll { it.source == source && gone.none { held -> held.originId == it.originId } }
        for (item in gone) {
            if (item.originId == open?.originId || waiting.any { it.originId == item.originId }) continue
            waiting.addLast(item)
        }
        offerNext()
    }

    private fun offerNext() {
        if (open != null) return
        val next = waiting.removeFirstOrNull() ?: return
        open = next
        ask(PhoneFollowWords.question(next))
    }
}
