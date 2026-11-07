package dev.centraid.android.notify

import centraid.core.v1.PendingNotification
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * WHAT THE NOTIFICATION PERFORMER OWES RUST'S WHOLE SET (#1173): which alarms go, which are set, which
 * are posted now, which kind of alarm the platform gives and when the permission is asked. Counts and
 * ids only; no clock is waited on.
 */
class NotifyPlanTest {
    private fun item(id: String, at: Long = 10_000L, immediate: Boolean = false, title: String = "t") =
        PendingNotification(notification_id = id, fire_at_ms = at, immediate = immediate, title = title)

    @Test
    fun anIdNoLongerWantedIsCancelledAndTheRestAreSetAgain() {
        val plan = NotifyPlan.diff(
            recorded = listOf(item("a"), item("b")),
            wanted = listOf(item("b"), item("c")),
            nowMs = 1_000L,
        )
        assertEquals(listOf("a"), plan.cancel)
        assertEquals(listOf("b", "c"), plan.arm.map { it.notification_id })
        assertTrue(plan.drop.isEmpty())
        assertTrue(plan.post.isEmpty())
    }

    @Test
    fun aMomentAlreadyPastIsDroppedNotSet() {
        val plan = NotifyPlan.diff(recorded = listOf(item("a", at = 500L)), wanted = listOf(item("a", at = 500L)), nowMs = 1_000L)
        assertEquals(listOf("a"), plan.drop)
        assertTrue(plan.arm.isEmpty())
        assertTrue("it is still wanted, so its delivered notification stays", plan.cancel.isEmpty())
        assertTrue(NotifyPlan.kept(listOf(item("a", at = 500L), item("b")), 1_000L).map { it.notification_id } == listOf("b"))
    }

    @Test
    fun anImmediateOneIsPostedOnceAndNotSetAsAnAlarm() {
        val receipt = item("r", immediate = true)
        val first = NotifyPlan.diff(recorded = emptyList(), wanted = listOf(receipt), nowMs = 1_000L)
        assertEquals(listOf("r"), first.post.map { it.notification_id })
        assertTrue(first.arm.isEmpty())
        val again = NotifyPlan.diff(recorded = listOf(receipt), wanted = listOf(receipt), nowMs = 2_000L)
        assertTrue(again.post.isEmpty())
        val changed = NotifyPlan.diff(recorded = listOf(receipt), wanted = listOf(receipt.copy(title = "other")), nowMs = 2_000L)
        assertEquals(1, changed.post.size)
    }

    @Test
    fun anEmptySetCancelsEverythingHeld() {
        val plan = NotifyPlan.diff(recorded = listOf(item("a"), item("b")), wanted = emptyList(), nowMs = 1_000L)
        assertEquals(listOf("a", "b"), plan.cancel)
    }

    @Test
    fun exactWhileTheGrantIsHeldOrBelowApi31() {
        assertTrue(NotifyPlan.exact(sdk = 30, canScheduleExact = false))
        assertTrue(NotifyPlan.exact(sdk = 34, canScheduleExact = true))
        assertFalse(NotifyPlan.exact(sdk = 34, canScheduleExact = false))
    }

    @Test
    fun permissionIsAskedOnlyWhenFirstNeededAndOnlyOnce() {
        assertEquals(NotifyPlan.Gate.ASK, NotifyPlan.gate(33, permissionHeld = false, enabled = false, asked = false, askPermission = true))
        assertEquals(NotifyPlan.Gate.NOT_ASKED, NotifyPlan.gate(33, false, false, asked = false, askPermission = false))
        assertEquals(NotifyPlan.Gate.DENIED, NotifyPlan.gate(33, false, false, asked = true, askPermission = true))
        assertEquals(NotifyPlan.Gate.GRANTED, NotifyPlan.gate(34, true, true, asked = false, askPermission = false))
        assertEquals(NotifyPlan.Gate.DENIED, NotifyPlan.gate(34, true, false, asked = true, askPermission = true))
        assertEquals(NotifyPlan.Gate.GRANTED, NotifyPlan.gate(30, true, true, asked = false, askPermission = true))
        assertEquals(NotifyPlan.Gate.DENIED, NotifyPlan.gate(30, true, false, asked = false, askPermission = true))
    }

    @Test
    fun theInstantIsReadFromTheWallClockAndZoneWhenTheyParse() {
        val paris = PendingNotification(notification_id = "a", fire_local = "2026-11-08T09:00:00", zone = "Europe/Paris", fire_at_ms = 1L)
        assertEquals(1_794_124_800_000L, NotifyPlan.fireInstant(34, paris))
        assertEquals("below API 26 the sent instant stands", 1L, NotifyPlan.fireInstant(24, paris))
        assertEquals("an unparsable pair keeps the sent instant", 7L, NotifyPlan.fireInstant(34, paris.copy(zone = "nowhere", fire_at_ms = 7L)))
    }

    @Test
    fun aRequestCodeIsStablePerId() {
        assertEquals(NotifyPlan.requestCode("task:1"), NotifyPlan.requestCode("task:1"))
    }
}
