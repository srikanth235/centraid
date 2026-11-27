package dev.centraid.android.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import centraid.core.v1.NotificationAction
import centraid.core.v1.NotificationCategory
import centraid.core.v1.NotificationVerb
import centraid.core.v1.PendingNotification
import centraid.core.v1.ScheduleNotifications
import dev.centraid.android.room.RoomClient
import java.lang.reflect.Proxy
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class NotifyActionsTest {
    private val doneAction = NotificationAction(
        verb = NotificationVerb.NOTIFICATION_VERB_DONE,
        label = "Done",
    )
    private val snoozeAction = NotificationAction(
        verb = NotificationVerb.NOTIFICATION_VERB_SNOOZE_HOUR,
        label = "Snooze",
    )

    @Test
    fun taskAlertCarriesDoneAndSnoozeActions() {
        val app = RuntimeEnvironment.getApplication()
        val categories = listOf(
            NotificationCategory(category_id = "alert.task", actions = listOf(doneAction, snoozeAction)),
        )
        val item = PendingNotification(
            notification_id = "alert|r1|2026-11-27T09:00",
            title = "Pay rent",
            body = "Due at 09:00",
            category_id = "alert.task",
            open_url = "centraid://open/task/0193-task",
            entity_id = "0193-task",
        )
        val notification = Notify.buildNotification(
            app = app,
            item = item,
            record = ScheduleNotifications(all = listOf(item), categories = categories),
        )
        assertEquals(listOf("Done", "Snooze"), notification.actions.map { it.title.toString() })
    }

    @Test
    fun eventPersonAndLockerAlertsCarrySnoozeOnlyNeverDone() {
        val app = RuntimeEnvironment.getApplication()
        for (kind in listOf("event", "person", "locker_item")) {
            val categoryId = "alert.$kind"
            // Even if a category erroneously includes Done, non-task reminder targets must only expose Snooze.
            val categories = listOf(
                NotificationCategory(category_id = categoryId, actions = listOf(doneAction, snoozeAction)),
            )
            val item = PendingNotification(
                notification_id = "alert|$kind|2026-11-27T09:00",
                title = "Alert for $kind",
                category_id = categoryId,
                open_url = "centraid://open/$kind/0193-$kind",
                entity_id = "0193-$kind",
            )
            val notification = Notify.buildNotification(
                app = app,
                item = item,
                record = ScheduleNotifications(all = listOf(item), categories = categories),
            )
            assertEquals(
                "kind $kind must only carry Snooze",
                listOf("Snooze"),
                notification.actions.map { it.title.toString() },
            )
        }
    }

    @Test
    fun durableOutboxWriteHappensBeforeBannerCancelAndTriggersReplay() = runBlocking {
        val prefs = RuntimeEnvironment.getApplication()
            .getSharedPreferences("notify-actions-order", Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        val outbox = NotifyOutbox(prefs)
        val order = mutableListOf<String>()
        var replayedPress: NotifyOutbox.Press? = null

        val handled = Notify.answerWith(
            outbox = outbox,
            cancelBanner = { id ->
                assertEquals(1, outbox.pending().size)
                assertEquals(id, outbox.pending().single().notificationId)
                order += "cancel:$id"
            },
            replay = { press ->
                order += "replay:${press.notificationId}"
                replayedPress = press
            },
            notificationId = "alert|r1|2026-11-27T09:00",
            verb = NotificationVerb.NOTIFICATION_VERB_DONE.value,
            entityId = "0193-task",
            dateId = "",
            fieldId = "",
            atMs = 1_732_680_000_000L,
        )

        assertTrue(handled)
        assertEquals(
            listOf("cancel:alert|r1|2026-11-27T09:00", "replay:alert|r1|2026-11-27T09:00"),
            order,
        )
        assertEquals("0193-task", replayedPress?.entityId)
        assertEquals(NotificationVerb.NOTIFICATION_VERB_DONE.value, replayedPress?.verb)
        assertEquals(1_732_680_000_000L, replayedPress?.atMs)
    }

    @Test
    fun failedOutboxWriteSkipsBannerCancelAndReplay() = runBlocking {
        val underlying = RuntimeEnvironment.getApplication()
            .getSharedPreferences("notify-actions-fail", Context.MODE_PRIVATE)
        underlying.edit().clear().commit()
        val failingPrefs = proxy<SharedPreferences>(SharedPreferences::class.java) { method, args ->
            if (method.name == "edit") {
                val editor = underlying.edit()
                lateinit var wrapped: SharedPreferences.Editor
                wrapped = proxy(SharedPreferences.Editor::class.java) { edit, editArgs ->
                    if (edit.name == "commit") false else {
                        val result = edit.invoke(editor, *editArgs)
                        if (result is SharedPreferences.Editor) wrapped else result
                    }
                }
                wrapped
            } else {
                method.invoke(underlying, *args)
            }
        }
        var cancelled = false
        var replayed = false

        val handled = Notify.answerWith(
            outbox = NotifyOutbox(failingPrefs),
            cancelBanner = { cancelled = true },
            replay = { replayed = true },
            notificationId = "alert|r2|2026-11-27T10:00",
            verb = NotificationVerb.NOTIFICATION_VERB_SNOOZE_HOUR.value,
            entityId = "0193-event",
        )

        assertFalse(handled)
        assertFalse(cancelled)
        assertFalse(replayed)
    }

    @Test
    fun scheduleNotificationsCancelsEveryDeliveredBannerInCancelDeliveredIds() = runBlocking {
        val app = RuntimeEnvironment.getApplication()
        val manager = app.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(Notify.CHANNEL, "Reminders", NotificationManager.IMPORTANCE_DEFAULT),
        )
        val trashed = PendingNotification(notification_id = "alert|trashed|1", title = "Trashed", fire_at_ms = 1L)
        val finished = PendingNotification(notification_id = "alert|finished|2", title = "Finished", fire_at_ms = 1L)
        val keep = PendingNotification(notification_id = "alert|keep|3", title = "Keep", fire_at_ms = 1L)
        val record = ScheduleNotifications(all = listOf(trashed, finished, keep))
        manager.notify(trashed.notification_id, 0, Notify.buildNotification(app, trashed, record))
        manager.notify(finished.notification_id, 0, Notify.buildNotification(app, finished, record))
        manager.notify(keep.notification_id, 0, Notify.buildNotification(app, keep, record))
        assertEquals(
            setOf("alert|trashed|1", "alert|finished|2", "alert|keep|3"),
            manager.activeNotifications.map { it.tag }.toSet(),
        )

        val scheduled = Notify.schedule(
            context = app,
            request = ScheduleNotifications(
                all = emptyList(),
                channel_name = "Reminders",
                backup_channel_name = "Backup",
                retain_delivered = true,
                cancel_delivered_ids = listOf("alert|trashed|1", "alert|finished|2"),
            ),
            ask = { true },
        )

        assertEquals(listOf("alert|keep|3"), manager.activeNotifications.map { it.tag })
        assertEquals(listOf("alert|keep|3"), scheduled.delivered.map { it.notification_id })
    }

    @Test
    fun tappingNotificationRoutesCentraidOpenDeepLink() {
        val app = RuntimeEnvironment.getApplication()
        val item = PendingNotification(
            notification_id = "alert|r3|2026-11-27T11:00",
            title = "Dentist",
            open_url = "centraid://open/event/0193-event-1",
            entity_id = "0193-event-1",
        )
        val intent = Notify.contentIntentFor(app, item)
        assertEquals(Intent.ACTION_VIEW, intent.action)
        assertEquals("centraid://open/event/0193-event-1", intent.dataString)

        NotifyTaps.note(intent)
        val noted = NotifyTaps.takeDeepLink()
        assertEquals("centraid://open/event/0193-event-1", noted)
        assertNull("deep link must be consumed once", NotifyTaps.takeDeepLink())
        assertEquals("event/0193-event-1", RoomClient.parseDeepLink(noted!!))
        assertNull(RoomClient.parseDeepLink("https://example.com/open/event/1"))
        assertNull(RoomClient.parseDeepLink("centraid://open/event/bad/extra"))
    }

    private fun <T : Any> proxy(
        type: Class<T>,
        action: (java.lang.reflect.Method, Array<out Any?>) -> Any?,
    ): T = checkNotNull(
        type.cast(
            Proxy.newProxyInstance(type.classLoader, arrayOf(type)) { _, method, args ->
                action(method, args.orEmpty())
            },
        ),
    )
}
