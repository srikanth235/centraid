package dev.centraid.android.glance

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.AtomicFile
import android.util.SizeF
import android.widget.RemoteViews
import dev.centraid.android.MainActivity
import java.io.IOException

/**
 * THE WIDGETS' ONE DOOR (#1173): keeps the snapshot Rust asked the shell to keep, redraws the two
 * providers from it, and sets the one timer that makes an old snapshot say so.
 *
 * Widgets are read-only and never open the vault or call the core: they draw
 * [GlanceSnapshot.FILE] and nothing else. Words and rows are Rust's; only the layout, the tint keys
 * and the platform's clock are here.
 */
internal object GlanceWidgets {
    /** The launcher shortcut's and the widget button's action: open Reminders with the quick-add bar ready. */
    const val ACTION_ADD_REMINDER: String = "dev.centraid.action.ADD_REMINDER"

    /** An optional extra on that action: the reminder's title, seeded into the bar (empty when absent). */
    const val EXTRA_TITLE: String = "dev.centraid.extra.REMINDER_TITLE"

    /**
     * A WIDGET'S TAP: the app on this action with one OPAQUE KEY from the snapshot as
     * [EXTRA_OPEN_KEY]. The core names the page; this shell names none.
     */
    const val ACTION_AGENDA_OPEN: String = "dev.centraid.action.AGENDA_OPEN"

    /** The key a widget's tap carries, copied untouched from the snapshot's `open` fields. */
    const val EXTRA_OPEN_KEY: String = "dev.centraid.extra.OPEN_KEY"

    /** The alarm's broadcast: redraw, so a snapshot past its `refresh_after` shows its stale words. */
    const val ACTION_REFRESH: String = "dev.centraid.action.GLANCE_REFRESH"

    /** The width from which the 4x2 layouts are drawn (dp). A 2x2 cell block is about 110 to 160. */
    private const val WIDE_DP = 220

    /**
     * WRITE THE DOCUMENT, THEN REDRAW. Atomic: a widget reading while this writes sees the old file
     * or the new one, never half of one. Throws [IOException] when the file could not be written
     * (the effect is then answered failed and Rust asks again with the next change).
     */
    fun keep(context: Context, document: ByteArray) {
        val file = AtomicFile(GlanceSnapshot.file(context))
        val out = file.startWrite()
        try {
            out.write(document)
            file.finishWrite(out)
        } catch (error: IOException) {
            file.failWrite(out)
            throw error
        }
        reload(context)
    }

    /** Redraw every placed widget of both providers from the file as it is now, and set the timer. */
    fun reload(context: Context) {
        val manager = AppWidgetManager.getInstance(context)
        val snapshot = GlanceSnapshot.load(context)
        val now = System.currentTimeMillis()
        for ((provider, render) in PROVIDERS) {
            for (id in manager.getAppWidgetIds(ComponentName(context, provider))) {
                manager.updateAppWidget(id, views(context, manager, id, render, snapshot, now))
            }
        }
        schedule(context, manager, snapshot, now)
    }

    /**
     * ONE LAYOUT PER SIZE CLASS. From Android 12 the launcher is handed both and picks by the size
     * the widget has (`RemoteViews(Map)`); below it, the widget's current minimum width picks
     * (`onAppWidgetOptionsChanged` redraws on a resize).
     */
    private fun views(
        context: Context,
        manager: AppWidgetManager,
        id: Int,
        render: Renderer,
        snapshot: GlanceSnapshot?,
        now: Long,
    ): RemoteViews {
        val small = render.small(context, snapshot, now)
        val wide = render.wide(context, snapshot, now)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            RemoteViews(mapOf(SizeF(0f, 0f) to small, SizeF(WIDE_DP.toFloat(), 0f) to wide))
        } else {
            val minWidth = manager.getAppWidgetOptions(id).getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0)
            if (minWidth >= WIDE_DP) wide else small
        }
    }

    /**
     * THE ONE TIMER: an inexact alarm at the snapshot's `refresh_after`, which redraws the widgets
     * into [GlanceWords.stale]. Inexact (`AlarmManager.set`), so it needs no exact-alarm permission
     * and does not wake the phone; if the phone sleeps through it, the widget flips on the next
     * redraw (a launcher refresh, an app update push). Cancelled when no widget is placed or the
     * time has passed.
     */
    fun schedule(context: Context, manager: AppWidgetManager, snapshot: GlanceSnapshot?, now: Long) {
        val alarms = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        val pending = PendingIntent.getBroadcast(
            context,
            REQUEST_REFRESH,
            Intent(ACTION_REFRESH).setClass(context, UpNextWidget::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val placed = PROVIDERS.any { (provider, _) -> manager.getAppWidgetIds(ComponentName(context, provider)).isNotEmpty() }
        val at = snapshot?.takeIf { it.ready }?.refreshAtMillis()
        if (!placed || at == null || at <= now) alarms.cancel(pending) else alarms.set(AlarmManager.RTC, at, pending)
    }

    /** The timer's own re-evaluation, from a widget being removed. */
    fun reschedule(context: Context) {
        schedule(context, AppWidgetManager.getInstance(context), GlanceSnapshot.load(context), System.currentTimeMillis())
    }

    /**
     * A TAP ON A WIDGET'S BODY OR ROW (#1173): the app on [ACTION_AGENDA_OPEN] with the core's opaque
     * [key], delivered to the running activity when there is one. [slot] is a request code unique to
     * this widget's body or row: a `PendingIntent` is told apart by its request code and not by its
     * extras, so two slots with the same code would share one key. A snapshot with no key (none
     * kept yet, or one an older core wrote) opens the app as its launcher icon would, as it always
     * did; null if the app has no launcher entry.
     */
    fun open(context: Context, key: String?, slot: Int): PendingIntent? {
        if (key.isNullOrEmpty()) {
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
            return PendingIntent.getActivity(context, slot, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        val intent = Intent(context, MainActivity::class.java)
            .setAction(ACTION_AGENDA_OPEN)
            .putExtra(EXTRA_OPEN_KEY, key)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(context, slot, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    /**
     * The New Reminder button: the `open_add` [key] the snapshot carries, or, with no snapshot to
     * name one, the shortcut's own [ACTION_ADD_REMINDER] (which opens the same bar). Delivered to the
     * running activity when there is one.
     */
    fun add(context: Context, key: String?): PendingIntent {
        if (!key.isNullOrEmpty()) return open(context, key, SLOT_ADD) ?: addShortcut(context)
        return addShortcut(context)
    }

    private fun addShortcut(context: Context): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setAction(ACTION_ADD_REMINDER)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(context, SLOT_ADD, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    /** The request code of Up next's body; its rows follow, one per slot. */
    const val SLOT_UP_NEXT: Int = 100

    /** The request code of Reminders' body; its rows follow, one per slot. */
    const val SLOT_REMINDERS: Int = 200

    /** The request code of the New Reminder button. */
    const val SLOT_ADD: Int = 300

    /** One widget's two layouts. */
    internal interface Renderer {
        fun small(context: Context, snapshot: GlanceSnapshot?, now: Long): RemoteViews
        fun wide(context: Context, snapshot: GlanceSnapshot?, now: Long): RemoteViews
    }

    private val PROVIDERS: List<Pair<Class<*>, Renderer>> = listOf(
        UpNextWidget::class.java to UpNextWidget.Draw,
        RemindersWidget::class.java to RemindersWidget.Draw,
    )

    private const val REQUEST_REFRESH = 3
}

/** The words a widget shows in place of rows: Rust's `stale` once the snapshot ran out, else its `unavailable`. */
internal fun GlanceSnapshot.sentence(now: Long): String? = when {
    !ready -> words.unavailable
    isStale(now) -> words.stale
    else -> null
}

/** Show or hide a view. */
internal fun RemoteViews.show(id: Int, on: Boolean) =
    setViewVisibility(id, if (on) android.view.View.VISIBLE else android.view.View.GONE)

/** A screen reader's one sentence for a widget: the words it draws, in reading order. */
internal fun RemoteViews.describe(id: Int, vararg parts: String) =
    setContentDescription(id, parts.filter { it.isNotEmpty() }.joinToString(" "))
