package dev.centraid.android.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import centraid.core.v1.PendingNotification
import centraid.core.v1.ScheduleNotifications
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class NotifyDeliveryTest {
    @Test
    fun aPostedThenDismissedTimedAlertIsNotReplayedAfterRearm() {
        val app = RuntimeEnvironment.getApplication()
        val manager = app.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(Notify.CHANNEL, "Reminders", NotificationManager.IMPORTANCE_DEFAULT))
        val fired = PendingNotification(notification_id = "task|fired", fire_at_ms = 1L)
        val future = PendingNotification(notification_id = "task|future", fire_at_ms = Long.MAX_VALUE)
        val receipt = PendingNotification(notification_id = "receipt|a", immediate = true)
        val store = NotifyStore(app)
        assertTrue(store.save(ScheduleNotifications(all = listOf(fired, future, receipt))))
        Notify.deliver(app, fired.notification_id)
        assertEquals(listOf("task|fired"), manager.activeNotifications.map { it.tag })
        assertEquals(listOf(future, receipt), store.load().all)
        manager.cancel(fired.notification_id, 0)
        Notify.rearm(app)
        assertTrue(manager.activeNotifications.isEmpty())
        assertEquals(listOf(future, receipt), store.load().all)
    }

    @Test
    fun anActuallyMissedTimedAlertPostsOnceAndANewerReplacementIsNeverRemoved() {
        val app = RuntimeEnvironment.getApplication()
        val manager = app.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(Notify.CHANNEL, "Reminders", NotificationManager.IMPORTANCE_DEFAULT))
        val missed = PendingNotification(notification_id = "task|missed", fire_at_ms = 1L)
        val store = NotifyStore(app)
        assertTrue(store.save(ScheduleNotifications(all = listOf(missed))))
        Notify.rearm(app)
        assertEquals(listOf("task|missed"), manager.activeNotifications.map { it.tag })
        assertTrue(store.load().all.isEmpty())
        manager.cancel(missed.notification_id, 0)
        Notify.rearm(app)
        assertTrue(manager.activeNotifications.isEmpty())
        val replacement = missed.copy(fire_at_ms = Long.MAX_VALUE)
        assertTrue(store.save(ScheduleNotifications(all = listOf(replacement))))
        assertTrue(store.deliveredTimed(missed))
        assertEquals(listOf(replacement), store.load().all)
    }
}
