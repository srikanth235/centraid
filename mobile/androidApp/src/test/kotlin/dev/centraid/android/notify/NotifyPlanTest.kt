package dev.centraid.android.notify

import centraid.core.v1.PendingNotification
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

/**
 * WHAT THE NOTIFICATION PERFORMER OWES RUST'S WHOLE SET (#1173): which alarms go, which are set, which
 * are posted now, which kind of alarm the platform gives and when the permission is asked. Counts and
 * ids only; no clock is waited on.
 */
@RunWith(RobolectricTestRunner::class)
class NotifyPlanTest {
    private fun item(id: String, at: Long = 10_000L, immediate: Boolean = false, title: String = "t") =
        PendingNotification(notification_id = id, fire_at_ms = at, immediate = immediate, title = title)

    /**
     * THE ONE FIXTURE BOTH SHELLS READ (`contracts/notify/reconcile-cases.json`): each case is a set, the
     * delivered ids still live, what the OS holds pending and showing, and the plan that follows.
     */
    @Test
    fun theSharedFixtureHoldsOnThisShell() {
        val root = JSONObject(File("../../contracts/notify/reconcile-cases.json").readText())
        val now = root.getLong("now_ms")
        val cases = root.getJSONArray("cases")
        assertTrue("the fixture has cases", cases.length() >= 9)
        for (n in 0 until cases.length()) {
            val case = cases.getJSONObject(n)
            val name = case.getString("name")
            val wanted = case.getJSONArray("wanted").objects().map {
                item(it.getString("id"), at = it.getLong("fire_at_ms"), immediate = it.optBoolean("immediate"))
            }
            val plan = NotifyPlan.reconcile(
                wanted = wanted,
                live = case.getJSONArray("live").strings(),
                pending = case.getJSONArray("pending").strings(),
                showing = case.getJSONArray("showing").strings(),
                nowMs = now,
            )
            val expected = case.getJSONObject("plan")
            assertEquals(name, expected.getJSONArray("removePending").strings(), plan.removePending)
            assertEquals(name, expected.getJSONArray("removeShowing").strings(), plan.removeShowing)
            assertEquals(name, expected.getJSONArray("schedule").strings(), plan.schedule.map { it.notification_id })
            assertEquals(name, expected.getJSONArray("post").strings(), plan.post.map { it.notification_id })
        }
    }

    private fun JSONArray.strings(): List<String> = (0 until length()).map { getString(it) }

    private fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }

    @Test
    fun theRecordKeepsWhatIsStillToComeAndTheImmediates() {
        val kept = NotifyPlan.kept(listOf(item("a", at = 500L), item("b"), item("r", immediate = true)), 1_000L)
        assertEquals(listOf("b", "r"), kept.map { it.notification_id })
    }

    @Test
    fun anImmediateOneIsPostedOnceAndNotSetAsAnAlarm() {
        val receipt = item("r", immediate = true)
        val first = NotifyPlan.reconcile(listOf(receipt), emptyList(), emptyList(), emptyList(), 1_000L)
        assertEquals(listOf("r"), first.post.map { it.notification_id })
        assertTrue(first.schedule.isEmpty())
        val seen = NotifyPlan.rememberedImmediates(setOf("r"), emptySet(), setOf("r"))
        val dismissed = NotifyPlan.reconcile(listOf(receipt.copy(title = "other")), emptyList(), emptyList(), emptyList(), 2_000L, seenImmediateIds = seen)
        assertTrue("a dismissed receipt must not reappear when its words change", dismissed.post.isEmpty())
        assertTrue(NotifyPlan.rememberedImmediates(emptySet(), seen, emptySet()).isEmpty())
    }

    @Test
    fun anEmptySetCancelsEverythingHeld() {
        val plan = NotifyPlan.reconcile(emptyList(), emptyList(), listOf("a", "b"), emptyList(), 1_000L)
        assertEquals(listOf("a", "b"), plan.removePending)
    }

    @Test
    fun aFiredCardSurvivesTheFutureSetBecomingEmptyInRetentionMode() {
        val plan = NotifyPlan.reconcile(emptyList(), emptyList(), listOf("fired"), listOf("fired"), 1_000L, retainDelivered = true)
        assertTrue(plan.removeShowing.isEmpty())
        assertEquals(listOf("fired"), plan.removePending)
    }

    @Test
    fun explicitWithdrawalDoesNotCancelTheEditedRecordsNextAlarm() {
        val plan = NotifyPlan.reconcile(
            listOf(item("edited", at = 2_000L)), emptyList(), listOf("edited"), listOf("edited", "other"),
            1_000L, retainDelivered = true, explicitIds = listOf("edited"),
        )
        assertEquals(listOf("edited"), plan.schedule.map { it.notification_id })
        assertEquals(listOf("edited"), plan.removeShowing)
        assertTrue(plan.removePending.isEmpty())
    }

    @Test
    fun legacyOrVaultSwitchWithdrawalIncludesCardsNoLongerInThePendingRecord() {
        val plan = NotifyPlan.reconcile(listOf(item("new-vault")), emptyList(), listOf("old-pending"), listOf("old-delivered"), 1_000L)
        assertEquals(listOf("old-pending"), plan.removePending)
        assertEquals(listOf("old-delivered"), plan.removeShowing)
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
