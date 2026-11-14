package dev.centraid.android.notify

import centraid.core.v1.NotificationAnswered
import centraid.core.v1.NotificationVerb
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class NotifyAnswersTest {
    @Test
    fun onlyTheExactTerminalAnswerCompletesTheReceiver() {
        val gate = NotifyAnswers()
        val answer = NotificationAnswered(notification_id = "task|a", verb = NotificationVerb.NOTIFICATION_VERB_OPEN, press_id = "press-a")
        val held = gate.hold(answer)
        gate.complete(answer.copy(notification_id = "task|other"))
        gate.complete(answer.copy(verb = NotificationVerb.NOTIFICATION_VERB_UNSPECIFIED))
        gate.complete(answer.copy(press_id = "press-other"))
        assertFalse(held.done.isCompleted)
        gate.complete(answer)
        assertTrue(held.done.isCompleted)
    }

    @Test
    fun duplicateWaiterCannotRemoveTheOriginalAndExpiryAllowsDurableReplay() {
        val gate = NotifyAnswers()
        val answer = NotificationAnswered(notification_id = "task|a", press_id = "press-a")
        val first = gate.hold(answer)
        val duplicate = gate.hold(answer)
        assertTrue(first.owner)
        assertFalse(duplicate.owner)
        assertSame(first.done, duplicate.done)
        gate.release(duplicate)
        gate.complete(answer)
        assertTrue(first.done.isCompleted)
        val replay = gate.hold(answer)
        gate.release(replay)
        assertFalse(replay.done.isCompleted)
        assertTrue(gate.hold(answer).owner)
    }
}
