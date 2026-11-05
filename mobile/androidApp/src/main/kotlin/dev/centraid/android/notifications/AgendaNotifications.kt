package dev.centraid.android.notifications

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.AtomicFile
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import centraid.core.v1.AgendaAlert
import centraid.core.v1.AgendaNotificationAction
import centraid.core.v1.AgendaNotificationJournal
import centraid.core.v1.AgendaNotificationState
import centraid.core.v1.AgendaNotificationSync
import centraid.core.v1.ShellFact
import dev.centraid.android.MainActivity
import dev.centraid.android.R
import dev.centraid.android.session.AppSession
import java.io.File
import java.io.FileNotFoundException
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** Executes Rust's replacement plan. The atomic file is a device journal, never a second scheduler. */
internal object AgendaNotifications {
    private const val CHANNEL = "agenda-reminders"
    private const val FIRE = "dev.centraid.agenda.FIRE"
    private const val ACTION = "dev.centraid.agenda.ACTION"
    private const val VAULT = "vault"
    private const val ALERT = "alert"
    private const val KIND = "kind"
    private const val ENTITY = "entity"
    private const val SOURCE = "source"
    private const val PAYLOAD = "alarm_payload"
    private const val FIRE_AT = "fire_ms"
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var applied = 0L

    private fun file(context: Context) = AtomicFile(File(context.noBackupFilesDir, "agenda-notifications.pb"))

    private fun read(context: Context): AgendaNotificationJournal = try {
        AgendaNotificationJournal.ADAPTER.decode(file(context).readFully())
    } catch (_: FileNotFoundException) {
        AgendaNotificationJournal()
    }

    private fun write(context: Context, journal: AgendaNotificationJournal) {
        val file = file(context)
        val stream = file.startWrite()
        try {
            stream.write(AgendaNotificationJournal.ADAPTER.encode(journal))
            file.finishWrite(stream)
        } catch (failure: Exception) {
            file.failWrite(stream)
            throw failure
        }
    }

    fun allowed(context: Context): Boolean {
        val manager = manager(context)
        return (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
            manager.areNotificationsEnabled() && (Build.VERSION.SDK_INT < 26 || manager.getNotificationChannel(CHANNEL)?.importance != NotificationManager.IMPORTANCE_NONE)
    }

    @Synchronized
    fun sync(context: Context, asked: AgendaNotificationSync): AgendaNotificationState {
        var journal = read(context)
        if (!asked.load_only) {
            val previous = journal.plan ?: AgendaNotificationSync()
            journal = AgendaNotificationJournal(plan = asked, pending = journal.pending.filter { it.action_id !in asked.acknowledge })
            // Persist before applying: a reboot replays this exact plan.
            write(context, journal)
            val now = System.currentTimeMillis()
            previous.alerts.forEach { old ->
                // Android may still be dispatching a due exact/inexact alarm.
                // Preserve that original delivery while its source remains live.
                if (old.fire_at_ms > now || !agendaAlarmMayFire(asked, previous.vault_id, old, now)) {
                    cancel(context, previous.vault_id, old)
                }
                if (!isCurrent(asked, previous.vault_id, old.entity_id, old.source_stamp)) manager(context).cancel(tag(previous.vault_id, old.id), 0)
            }
            // Delivered occurrences are validated by their source revision, not
            // by the bounded list of future alarm identities.
            manager(context).activeNotifications.filter { posted ->
                if (posted.tag?.startsWith("agenda:") != true) false else {
                    val extras = posted.notification.extras
                    !agendaAlarmMayFire(asked, extras.getString(VAULT).orEmpty(), AgendaAlert(
                        id = extras.getString(ALERT).orEmpty(), entity_id = extras.getString(ENTITY).orEmpty(),
                        source_stamp = extras.getString(SOURCE).orEmpty(), fire_at_ms = extras.getLong(FIRE_AT),
                    ), System.currentTimeMillis())
                }
            }.forEach { manager(context).cancel(it.tag, it.id) }
            if (Build.VERSION.SDK_INT >= 26 && asked.alerts.isNotEmpty()) manager(context).createNotificationChannel(NotificationChannel(CHANNEL, asked.channel_label, NotificationManager.IMPORTANCE_DEFAULT))
            if (allowed(context)) asked.alerts.forEach { schedule(context, asked.vault_id, it) }
            applied += 1
        }
        val plan = journal.plan ?: AgendaNotificationSync()
        return AgendaNotificationState(vault_id = plan.vault_id, snoozed = plan.snoozed, pending = journal.pending, allowed = allowed(context))
    }

    private fun isCurrent(plan: AgendaNotificationSync, vault: String, entity: String, source: String): Boolean =
        vault.isNotEmpty() && plan.vault_id == vault && plan.sources.any { it.entity_id == entity && it.source_stamp == source }

    private fun alarm(context: Context) = context.getSystemService(AlarmManager::class.java)
    private fun manager(context: Context) = context.getSystemService(NotificationManager::class.java)
    private fun tag(vault: String, alert: String) = "agenda:$vault:$alert"
    private fun uri(vault: String, alert: String, action: String): Uri = Uri.Builder()
        .scheme("centraid").authority("agenda-notifications").appendPath(vault).appendPath(alert).appendPath(action).build()

    private fun alarmIntent(context: Context, vault: String, alert: AgendaAlert): Intent =
        Intent(context, AgendaNotificationReceiver::class.java).setAction(FIRE)
            // Keep a queued occurrence immutable while the next one shares its card id.
            .setData(uri(vault, alert.id, "$FIRE:${alert.fire_at_ms}"))
            .putExtra(VAULT, vault).putExtra(ALERT, alert.id)
            .putExtra(PAYLOAD, AgendaAlert.ADAPTER.encode(alert))

    private fun cancel(context: Context, vault: String, alert: AgendaAlert) {
        // Looking up an alarm must never replace the payload of an in-flight broadcast.
        PendingIntent.getBroadcast(context, 0, alarmIntent(context, vault, alert),
            PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE)?.let { alarm(context).cancel(it) }
    }

    private fun schedule(context: Context, vault: String, alert: AgendaAlert) {
        if (alert.fire_at_ms <= System.currentTimeMillis()) return
        val alarm = alarm(context)
        val pending = PendingIntent.getBroadcast(context, 0, alarmIntent(context, vault, alert),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        // Special exact-alarm access is optional. Without it Android may defer
        // an inexact alarm under battery policy; the alert is still scheduled.
        if (Build.VERSION.SDK_INT < 31 || alarm.canScheduleExactAlarms()) {
            try {
                alarm.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, alert.fire_at_ms, pending)
                return
            } catch (_: SecurityException) { /* Access can change after the check. */ }
        }
        alarm.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, alert.fire_at_ms, pending)
    }

    private fun action(context: Context, vault: String, alert: AgendaAlert, kind: AgendaNotificationAction.Kind): PendingIntent =
        PendingIntent.getBroadcast(context, 0,
            Intent(context, AgendaNotificationReceiver::class.java).setAction(ACTION)
                .setData(uri(vault, alert.id, kind.name)).putExtra(VAULT, vault).putExtra(ALERT, alert.id).putExtra(KIND, kind.value)
                .putExtra(ENTITY, alert.entity_id).putExtra(SOURCE, alert.source_stamp),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    @Synchronized
    private fun fire(context: Context, vault: String, alert: AgendaAlert) {
        val plan = read(context).plan ?: return
        if (!agendaAlarmMayFire(plan, vault, alert, System.currentTimeMillis()) || !allowed(context)) return
        val id = alert.id
        val manager = manager(context)
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel(CHANNEL, plan.channel_label, NotificationManager.IMPORTANCE_DEFAULT))
        val launch = PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java)
            .setData(uri(vault, id, "open")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher_monochrome)
            .setContentTitle(alert.title).setContentText(alert.body).setAutoCancel(true)
            .addExtras(Bundle().apply {
                putString(VAULT, vault); putString(ALERT, alert.id); putString(ENTITY, alert.entity_id)
                putString(SOURCE, alert.source_stamp); putLong(FIRE_AT, alert.fire_at_ms)
            })
            .setContentIntent(launch).setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        if (alert.task) notification.addAction(0, plan.done_label, action(context, vault, alert, AgendaNotificationAction.Kind.KIND_DONE))
        notification.addAction(0, plan.hour_label, action(context, vault, alert, AgendaNotificationAction.Kind.KIND_HOUR))
        notification.addAction(0, plan.tomorrow_label, action(context, vault, alert, AgendaNotificationAction.Kind.KIND_TOMORROW))
        try { manager.notify(tag(vault, id), 0, notification.build()) } catch (_: SecurityException) { /* Permission changed. */ }
    }

    @Synchronized
    private fun record(context: Context, vault: String, alert: String, kind: Int, entity: String, source: String): AgendaNotificationAction? {
        val journal = read(context)
        val plan = journal.plan ?: return null
        if (alert.isEmpty() || !isCurrent(plan, vault, entity, source)) return null
        val actionKind = AgendaNotificationAction.Kind.fromValue(kind) ?: return null
        if (actionKind == AgendaNotificationAction.Kind.KIND_UNSPECIFIED) return null
        val action = AgendaNotificationAction(action_id = UUID.randomUUID().toString(), vault_id = vault,
            alert_id = alert, kind = actionKind, at_ms = System.currentTimeMillis(), entity_id = entity, source_stamp = source)
        write(context, journal.copy(pending = journal.pending + action))
        manager(context).cancel(tag(vault, alert), 0)
        return action
    }

    @Synchronized
    private fun pending(context: Context, id: String) = read(context).pending.any { it.action_id == id }

    fun receive(context: Context, intent: Intent, finished: () -> Unit) {
        scope.launch {
            try {
                val vault = intent.getStringExtra(VAULT).orEmpty()
                val alert = intent.getStringExtra(ALERT).orEmpty()
                when (intent.action) {
                    FIRE -> intent.getByteArrayExtra(PAYLOAD)?.let { bytes ->
                        val payload = AgendaAlert.ADAPTER.decode(bytes)
                        if (payload.id == alert) fire(context, vault, payload)
                    }
                    ACTION -> record(context, vault, alert, intent.getIntExtra(KIND, 0), intent.getStringExtra(ENTITY).orEmpty(), intent.getStringExtra(SOURCE).orEmpty())?.let { action ->
                        AppSession.use(context) { open ->
                            open.screens.shellFact(ShellFact(agenda_notification = action))
                            // Keep the receiver's session until Rust's acknowledgement is durable.
                            withTimeoutOrNull(8_000) { while (pending(context, action.action_id)) delay(50) }
                        }
                    }
                    Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_TIME_CHANGED, Intent.ACTION_TIMEZONE_CHANGED -> {
                        synchronized(this@AgendaNotifications) {
                            val plan = read(context).plan
                            if (plan != null && allowed(context)) plan.alerts.forEach { schedule(context, plan.vault_id, it) }
                        }
                        // Civil reminders are recomputed by Rust after a zone or clock change.
                        val before = synchronized(this@AgendaNotifications) { applied }
                        AppSession.use(context) { open ->
                            AppSession.environment(open.screens)
                            open.screens.start()
                            withTimeoutOrNull(8_000) { while (synchronized(this@AgendaNotifications) { applied == before }) delay(50) }
                        }
                    }
                }
            } catch (failure: Exception) {
                // The durable action stays pending. A later foreground retries it.
                Log.w("Centraid", "Agenda notification could not be applied: ${failure.javaClass.simpleName}")
            } finally { finished() }
        }
    }
}

/** Explicit pending intents only; OS boot/clock broadcasts are declared separately. */
public class AgendaNotificationReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        AgendaNotifications.receive(context.applicationContext, intent) { pending.finish() }
    }
}
