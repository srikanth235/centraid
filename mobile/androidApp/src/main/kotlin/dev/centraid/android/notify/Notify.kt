package dev.centraid.android.notify

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import centraid.core.v1.NotificationAnswered
import centraid.core.v1.NotificationPermission
import centraid.core.v1.NotificationVerb
import centraid.core.v1.NotificationsScheduled
import centraid.core.v1.PendingNotification
import centraid.core.v1.ScheduleNotifications
import centraid.core.v1.ShellFact
import dev.centraid.android.MainActivity
import dev.centraid.android.session.AppSession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

/**
 * ANDROID'S NOTIFICATIONS, AS AGENDA ASKS FOR THEM (#1173).
 *
 * Rust sends the WHOLE desired set (`ScheduleNotifications`); this makes the OS hold exactly that and
 * decides nothing else. Every word (titles, bodies, the channel's name, each button's label) is Rust's.
 * The alarms are `AlarmManager`'s and the record of them is [NotifyStore]; a reboot re-arms from it
 * ([NotifyBootReceiver]), an alarm posts from it ([NotifyAlarmReceiver]) and a button or tap is reported
 * as `ShellFact.notification_answered` ([NotifyActionReceiver], [NotifyTaps]).
 *
 * EXACT OR INEXACT: `SCHEDULE_EXACT_ALARM` is declared (not `USE_EXACT_ALARM`; see the manifest). Exact
 * (`setExactAndAllowWhileIdle`) while the platform lets this app, which is always below API 31; else
 * `setAndAllowWhileIdle`, a few minutes late at worst. The member is never sent to settings for it.
 */
internal object Notify {
    const val CHANNEL: String = "agenda-reminders"

    /** The backup warnings' own channel, so switching off reminders does not silence them (and the reverse). */
    const val BACKUP_CHANNEL: String = "backup-warnings"
    const val EXTRA_ID: String = "dev.centraid.notify.ID"
    const val EXTRA_VERB: String = "dev.centraid.notify.VERB"

    /**
     * How long a button's session is held for Rust's answer to be performed (the new set, with its
     * receipt). Rust answers within the same call; this only bounds a performer that never runs, and stays
     * under the ten seconds `goAsync` gives a receiver.
     */
    private const val ANSWER_GRACE_MS: Long = 8_000L

    /** Completed by the next performed `ScheduleNotifications`, while a button's session waits on it. */
    @Volatile private var performed: CompletableDeferred<Unit>? = null

    /** The tag every notification is posted under (with id 0), so one is cancelled by its id alone. */
    private const val SLOT: Int = 0

    /**
     * Perform one `ScheduleNotifications`. [ask] shows the system's permission prompt and says whether
     * it was granted, or null when no activity is up to show it (nothing is then asked or recorded).
     */
    suspend fun schedule(context: Context, request: ScheduleNotifications, ask: suspend () -> Boolean?): NotificationsScheduled {
        val app = context.applicationContext
        val store = NotifyStore(app)
        val manager = NotificationManagerCompat.from(app)
        val held = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(app, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        val permission = when (
            NotifyPlan.gate(Build.VERSION.SDK_INT, held, manager.areNotificationsEnabled(), store.asked(), request.ask_permission)
        ) {
            NotifyPlan.Gate.GRANTED -> NotificationPermission.NOTIFICATION_PERMISSION_GRANTED
            NotifyPlan.Gate.DENIED -> NotificationPermission.NOTIFICATION_PERMISSION_DENIED
            NotifyPlan.Gate.NOT_ASKED -> NotificationPermission.NOTIFICATION_PERMISSION_NOT_ASKED
            NotifyPlan.Gate.ASK -> when (val answer = ask()) {
                null -> NotificationPermission.NOTIFICATION_PERMISSION_NOT_ASKED
                else -> {
                    store.markAsked()
                    if (answer && manager.areNotificationsEnabled()) {
                        NotificationPermission.NOTIFICATION_PERMISSION_GRANTED
                    } else {
                        NotificationPermission.NOTIFICATION_PERMISSION_DENIED
                    }
                }
            }
        }
        val count = when (permission) {
            NotificationPermission.NOTIFICATION_PERMISSION_GRANTED -> hold(app, store, manager, request)
            // REFUSED IS QUIET: everything held goes, nothing is scheduled and nothing is said.
            NotificationPermission.NOTIFICATION_PERMISSION_DENIED -> {
                store.load().all.forEach { cancel(app, manager, it.notification_id) }
                store.save(ScheduleNotifications())
                0
            }
            else -> 0
        }
        performed?.complete(Unit)
        // WHAT THE PHONE WILL DO WITH WHAT IS HELD: said back so the editor row can say it.
        val channel = manager.getNotificationChannelCompat(CHANNEL)
        val backup = manager.getNotificationChannelCompat(BACKUP_CHANNEL)
        val alarms = app.getSystemService(AlarmManager::class.java)
        val canExact = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && alarms?.canScheduleExactAlarms() == true
        return NotificationsScheduled(
            permission = permission,
            held = count,
            exact_denied = !NotifyPlan.exact(Build.VERSION.SDK_INT, canExact),
            channel_off = channel != null && channel.importance == NotificationManagerCompat.IMPORTANCE_NONE,
            channel_shown = channel?.name?.toString().orEmpty(),
            backup_channel_off = backup != null && backup.importance == NotificationManagerCompat.IMPORTANCE_NONE,
            backup_channel_shown = backup?.name?.toString().orEmpty(),
        )
    }

    /** Make the OS hold [request]'s set; how many alarms are pending now. */
    private fun hold(app: Context, store: NotifyStore, manager: NotificationManagerCompat, request: ScheduleNotifications): Int {
        val now = System.currentTimeMillis()
        val recorded = store.load().all
        val showing = showingIds(manager)
        val plan = NotifyPlan.reconcile(
            wanted = request.all,
            live = request.live_ids,
            pending = recorded.filter { !it.immediate }.map { it.notification_id },
            showing = showing,
            nowMs = now,
        )
        manager.createNotificationChannel(
            NotificationChannelCompat.Builder(CHANNEL, NotificationManagerCompat.IMPORTANCE_DEFAULT)
                .setName(request.channel_name)
                .build(),
        )
        manager.createNotificationChannel(
            NotificationChannelCompat.Builder(BACKUP_CHANNEL, NotificationManagerCompat.IMPORTANCE_DEFAULT)
                .setName(request.backup_channel_name)
                .build(),
        )
        plan.removePending.forEach { cancelAlarm(app, it) }
        plan.removeShowing.forEach { cancel(app, manager, it) }
        // THE RECORD FIRST: an alarm that fires the moment it is set finds its words in it.
        val next = ScheduleNotifications(
            all = NotifyPlan.kept(request.all, now),
            categories = request.categories,
            ask_permission = request.ask_permission,
            channel_name = request.channel_name,
            backup_channel_name = request.backup_channel_name,
            live_ids = request.live_ids,
        )
        store.save(next)
        plan.schedule.forEach { arm(app, it.notification_id, it.fire_at_ms) }
        plan.post.forEach { post(app, it, next) }
        return plan.schedule.size
    }

    /** The ids of the notifications this app has on the screen now, asked of the OS and not remembered. */
    private fun showingIds(manager: NotificationManagerCompat): List<String> =
        manager.activeNotifications.filter { it.id == SLOT }.mapNotNull { it.tag }

    /** An alarm fired: the notification it was set for, worded from the record. */
    fun deliver(context: Context, notificationId: String) {
        val app = context.applicationContext
        val record = NotifyStore(app).load()
        val item = record.all.firstOrNull { it.notification_id == notificationId } ?: return
        post(app, item, record)
    }

    /** After a reboot, a change of the clock or the zone or an update: every recorded timed item again. */
    fun rearm(context: Context) {
        val app = context.applicationContext
        val store = NotifyStore(app)
        val record = store.load()
        if (record.all.isEmpty() || !NotificationManagerCompat.from(app).areNotificationsEnabled()) return
        val now = System.currentTimeMillis()
        val kept = mutableListOf<PendingNotification>()
        for (item in record.all) {
            if (item.immediate) {
                kept += item
                continue
            }
            // READ AGAIN FROM THE WALL CLOCK AND THE ZONE: that is what the member chose.
            val at = NotifyPlan.fireInstant(Build.VERSION.SDK_INT, item)
            if (at > now) {
                arm(app, item.notification_id, at)
                kept += item.copy(fire_at_ms = at)
            } else {
                cancelAlarm(app, item.notification_id)
            }
        }
        store.save(record.copy(all = kept))
    }

    /**
     * A button was pressed (or the notification tapped): write it down FIRST, then tell Rust. The press
     * leaves the outbox only once the core has taken it; a press the process could not deliver is sent
     * again by [drain] at the next start (#1188, A6).
     */
    suspend fun answer(context: Context, notificationId: String, verb: Int) {
        val press = NotifyOutbox(context).add(notificationId, verb)
        deliverPress(context, press)
    }

    /** Send every press still in the outbox, once each; called wherever a session is first up. */
    suspend fun drain(context: Context) {
        NotifyOutbox(context).pending().forEach { deliverPress(context, it) }
    }

    private suspend fun deliverPress(context: Context, press: NotifyOutbox.Press) {
        val said = NotificationAnswered(
            notification_id = press.notificationId,
            verb = NotificationVerb.fromValue(press.verb) ?: NotificationVerb.NOTIFICATION_VERB_UNSPECIFIED,
            press_id = press.pressId,
        )
        // HELD UNTIL RUST'S ANSWER IS PERFORMED: the write answers with a new set (the receipt and its
        // Undo, the reminder gone), and letting go of the session first would cancel its performer.
        AppSession.use(context.applicationContext) { open ->
            val done = CompletableDeferred<Unit>()
            performed = done
            try {
                open.screens.shellFact(ShellFact(notification_answered = said))
                withTimeoutOrNull(ANSWER_GRACE_MS) { done.await() }
                // THE CORE HAS IT: the press leaves the queue.
                NotifyOutbox(context).remove(press.pressId)
            } finally {
                if (performed === done) performed = null
            }
        }
    }

    private fun cancel(app: Context, manager: NotificationManagerCompat, notificationId: String) {
        cancelAlarm(app, notificationId)
        manager.cancel(notificationId, SLOT)
    }

    private fun arm(app: Context, notificationId: String, atMs: Long) {
        val alarms = app.getSystemService(AlarmManager::class.java) ?: return
        val intent = alarmIntent(app, notificationId)
        val canExact = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && alarms.canScheduleExactAlarms()
        if (NotifyPlan.exact(Build.VERSION.SDK_INT, canExact)) {
            try {
                alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, intent)
                return
            } catch (_: SecurityException) {
                // THE GRANT WAS TAKEN BACK BETWEEN THE ASK AND THE SET: the inexact alarm below.
            }
        }
        alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, intent)
    }

    private fun cancelAlarm(app: Context, notificationId: String) {
        val intent = alarmIntent(app, notificationId)
        app.getSystemService(AlarmManager::class.java)?.cancel(intent)
        intent.cancel()
    }

    private fun alarmIntent(app: Context, notificationId: String): PendingIntent =
        PendingIntent.getBroadcast(
            app,
            NotifyPlan.requestCode(notificationId),
            Intent(app, NotifyAlarmReceiver::class.java).setData(uriOf("alarm", notificationId, "")).putExtra(EXTRA_ID, notificationId),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

    /** A data URI makes each (id, verb) its own PendingIntent: extras do not tell two intents apart. */
    private fun uriOf(kind: String, notificationId: String, verb: String): Uri =
        Uri.Builder().scheme("centraid-notify").authority(kind).appendPath(notificationId).appendPath(verb).build()

    @SuppressLint("MissingPermission") // `areNotificationsEnabled` is checked first: no grant, nothing posted.
    private fun post(app: Context, item: PendingNotification, record: ScheduleNotifications) {
        val manager = NotificationManagerCompat.from(app)
        if (!manager.areNotificationsEnabled()) return
        val open = PendingIntent.getActivity(
            app,
            NotifyPlan.requestCode(item.notification_id),
            Intent(app, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .setData(uriOf("open", item.notification_id, ""))
                .putExtra(EXTRA_ID, item.notification_id)
                .putExtra(EXTRA_VERB, NotificationVerb.NOTIFICATION_VERB_OPEN.value),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val backupWarning = item.channel_id == "backup"
        val builder = NotificationCompat.Builder(app, if (backupWarning) BACKUP_CHANNEL else CHANNEL)
            // THE PLATFORM'S OWN REMINDER GLYPH: the app ships no drawable of its own (as `BackupNotices`).
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle(item.title)
            .setContentText(item.body)
            .setWhen(item.fire_at_ms)
            .setCategory(if (backupWarning) NotificationCompat.CATEGORY_STATUS else NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .setContentIntent(open)
        if (item.thread_id.isNotEmpty()) builder.setGroup(item.thread_id)
        val buttons = record.categories.firstOrNull { it.category_id == item.category_id && item.category_id.isNotEmpty() }
        buttons?.actions.orEmpty().forEach { action ->
            val answered = PendingIntent.getBroadcast(
                app,
                NotifyPlan.requestCode(item.notification_id + "#" + action.verb.value),
                Intent(app, NotifyActionReceiver::class.java)
                    .setData(uriOf("verb", item.notification_id, action.verb.value.toString()))
                    .putExtra(EXTRA_ID, item.notification_id)
                    .putExtra(EXTRA_VERB, action.verb.value),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            builder.addAction(NotificationCompat.Action.Builder(0, action.label, answered).build())
        }
        manager.notify(item.notification_id, SLOT, builder.build())
    }
}
