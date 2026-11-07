package dev.centraid.android.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat
import centraid.core.v1.NotificationAnswered
import centraid.core.v1.NotificationVerb
import dev.centraid.core.Screens
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import centraid.core.v1.ShellFact

/** AN ALARM FIRED (#1173): post the notification it was set for, from the record. Not exported. */
public class NotifyAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra(Notify.EXTRA_ID) ?: return
        Notify.deliver(context, id)
    }
}

/**
 * A BUTTON WAS PRESSED (#1173): the notification goes, and Rust hears the id and the verb as they were
 * handed over; what the verb does is Rust's. The process may have no activity, so the fact reaches the
 * core the way a background pass does (`PassHost`): the process's one session, opened here if need be.
 * Not exported.
 */
public class NotifyActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra(Notify.EXTRA_ID) ?: return
        val verb = intent.getIntExtra(Notify.EXTRA_VERB, 0)
        NotificationManagerCompat.from(context).cancel(id, 0)
        val pending = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                Notify.answer(context, id, verb)
            } finally {
                pending.finish()
            }
        }
    }
}

/**
 * THE CLOCK OR THE PHONE CHANGED (#1173): a reboot clears every alarm, and a new time or zone moves
 * what a wall-clock reminder means, so every recorded item is set again from its local time and zone.
 * Not exported: the system's broadcasts reach a manifest receiver regardless.
 */
public class NotifyBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Notify.rearm(context)
    }
}

/**
 * TAPS ON A NOTIFICATION (#1173), held until a session is up. A tap opens the launcher activity (a
 * receiver may not start one from a notification), which notes the extras here and sends the fact once
 * the session exists. Each is sent once.
 */
internal object NotifyTaps {
    private val waiting = ArrayDeque<NotificationAnswered>()

    /** Note a launch or a new intent's tap, and take the extras off it so a recreation does not repeat it. */
    @Synchronized
    fun note(intent: Intent?) {
        val id = intent?.getStringExtra(Notify.EXTRA_ID) ?: return
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
    private fun take(): NotificationAnswered? = waiting.removeFirstOrNull()

    /** Send every noted tap into [screens]. */
    suspend fun flush(screens: Screens) {
        while (true) {
            val tap = take() ?: return
            screens.shellFact(ShellFact(notification_answered = tap))
        }
    }
}
