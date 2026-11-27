package dev.centraid.android.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import centraid.core.v1.NotificationAnswered
import centraid.core.v1.NotificationVerb
import centraid.core.v1.ShellFact
import dev.centraid.android.room.RoomClient
import dev.centraid.core.Screens
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

public class NotifyAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra(Notify.EXTRA_ID) ?: return
        Notify.deliver(context, id)
    }
}

public class NotifyActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra(Notify.EXTRA_ID) ?: return
        val verb = intent.getIntExtra(Notify.EXTRA_VERB, 0)
        val entityId = intent.getStringExtra(Notify.EXTRA_ENTITY_ID).orEmpty()
        val dateId = intent.getStringExtra(Notify.EXTRA_DATE_ID).orEmpty()
        val fieldId = intent.getStringExtra(Notify.EXTRA_FIELD_ID).orEmpty()
        val pending = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                Notify.answer(context, id, verb, entityId, dateId, fieldId)
            } finally {
                pending.finish()
            }
        }
    }
}

public class NotifyBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Notify.rearm(context)
    }
}

internal object NotifyTaps {
    private val deepLinks = ArrayDeque<String>()
    private val waiting = ArrayDeque<NotificationAnswered>()

    @Synchronized
    fun note(intent: Intent?) {
        if (intent == null) return
        val openUrl = intent.getStringExtra(Notify.EXTRA_OPEN_URL)
            ?.takeIf { it.isNotBlank() }
            ?: intent.dataString?.takeIf { it.startsWith("centraid://open/") }
        if (openUrl != null) {
            intent.removeExtra(Notify.EXTRA_OPEN_URL)
            intent.removeExtra(Notify.EXTRA_ID)
            intent.removeExtra(Notify.EXTRA_VERB)
            if (intent.dataString == openUrl) intent.data = null
            deepLinks.addLast(openUrl)
            return
        }
        val id = intent.getStringExtra(Notify.EXTRA_ID) ?: return
        val verb = intent.getIntExtra(Notify.EXTRA_VERB, 0)
        intent.removeExtra(Notify.EXTRA_ID)
        intent.removeExtra(Notify.EXTRA_VERB)
        waiting.addLast(
            NotificationAnswered(
                notification_id = id,
                verb = NotificationVerb.fromValue(verb) ?: NotificationVerb.NOTIFICATION_VERB_UNSPECIFIED,
            ),
        )
    }

    @Synchronized
    internal fun takeDeepLink(): String? = deepLinks.removeFirstOrNull()

    @Synchronized
    private fun take(): NotificationAnswered? = waiting.removeFirstOrNull()

    suspend fun flush(rooms: RoomClient, screens: Screens) {
        while (true) {
            val url = takeDeepLink() ?: break
            rooms.openDeepLink(url)
        }
        while (true) {
            val tap = take() ?: return
            screens.shellFact(ShellFact(notification_answered = tap))
        }
    }
}
