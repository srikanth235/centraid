package dev.centraid.android.glance

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.util.AtomicFile
import android.util.SizeF
import android.widget.RemoteViews
import dev.centraid.android.MainActivity
import dev.centraid.android.R
import java.io.IOException

/**
 * HEALTH (#1185): today's steps, sleep and activity, 2x2 (the first figure big) and 4x2 (a 2x2 grid
 * of figures). A framework `AppWidgetProvider` over `RemoteViews`, like Agenda's: it draws the one
 * snapshot file Rust's `health.glance` service keeps ([HealthSnapshot.FILE] under `filesDir`) and
 * never opens the vault. The app pushes redraws ([keep]); the one timer is an inexact alarm at the
 * snapshot's `refresh_after` that redraws into the stale words. Privacy ruling: `home_screen` only
 * (see `glance_health_info.xml`), never the lock screen.
 */
public class HealthWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) = reload(context)

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, appWidgetId: Int, newOptions: Bundle) =
        reload(context)

    override fun onDeleted(context: Context, appWidgetIds: IntArray) = reload(context)

    override fun onDisabled(context: Context) = reload(context)

    /** The refresh alarm lands here (it is aimed at this receiver); everything else is the platform's. */
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == ACTION_REFRESH) reload(context) else super.onReceive(context, intent)
    }

    internal companion object {
        /** A Health widget's tap: the app on this action with one OPAQUE KEY as [GlanceWidgets.EXTRA_OPEN_KEY]. */
        const val ACTION_HEALTH_OPEN: String = "dev.centraid.action.HEALTH_OPEN"

        /** The alarm's broadcast: redraw, so a snapshot past its `refresh_after` shows its stale words. */
        const val ACTION_REFRESH: String = "dev.centraid.action.HEALTH_GLANCE_REFRESH"

        private const val SLOT_OPEN = 400
        private const val REQUEST_REFRESH = 4

        /** The width from which the 4x2 layout is drawn (dp), as Agenda's. */
        private const val WIDE_DP = 220

        private val GRID_LABELS = intArrayOf(R.id.health_label_0, R.id.health_label_1, R.id.health_label_2, R.id.health_label_3)
        private val GRID_TEXTS = intArrayOf(R.id.health_text_0, R.id.health_text_1, R.id.health_text_2, R.id.health_text_3)
        private val GRID_CELLS = intArrayOf(R.id.health_cell_0, R.id.health_cell_1, R.id.health_cell_2, R.id.health_cell_3)

        /**
         * WRITE THE DOCUMENT, THEN REDRAW. Atomic, readable by the widget the moment it lands. [name]
         * is the file Rust named; only a plain name is written. Throws [IOException] when the file
         * could not be written (the effect is then answered failed).
         */
        fun keep(context: Context, name: String, document: ByteArray) {
            if (name.isEmpty() || name.contains('/') || name == "." || name == "..") {
                throw IOException("the snapshot's file name is not a plain name")
            }
            val file = AtomicFile(HealthSnapshot.file(context, name))
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

        /** Redraw every placed Health widget from the file as it is now, and set the timer. */
        fun reload(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val snapshot = HealthSnapshot.load(context)
            val now = System.currentTimeMillis()
            val ids = manager.getAppWidgetIds(ComponentName(context, HealthWidget::class.java))
            for (id in ids) {
                val small = small(context, snapshot, now)
                val wide = wide(context, snapshot, now)
                val views = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    RemoteViews(mapOf(SizeF(0f, 0f) to small, SizeF(WIDE_DP.toFloat(), 0f) to wide))
                } else {
                    val minWidth = manager.getAppWidgetOptions(id).getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0)
                    if (minWidth >= WIDE_DP) wide else small
                }
                manager.updateAppWidget(id, views)
            }
            schedule(context, ids.isNotEmpty(), snapshot, now)
        }

        /**
         * The one timer: an inexact alarm (no exact-alarm permission, does not wake the phone) at a
         * ready snapshot's `refresh_after`. Cancelled when no widget is placed or the time has passed.
         */
        private fun schedule(context: Context, placed: Boolean, snapshot: HealthSnapshot?, now: Long) {
            val alarms = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
            val pending = PendingIntent.getBroadcast(
                context,
                REQUEST_REFRESH,
                Intent(ACTION_REFRESH).setClass(context, HealthWidget::class.java),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val at = snapshot?.takeIf { it.state == "ready" }?.refreshAtMillis()
            if (!placed || at == null || at <= now) alarms.cancel(pending) else alarms.set(AlarmManager.RTC, at, pending)
        }

        /** A TAP: the app on [ACTION_HEALTH_OPEN] with the core's opaque [key]; with none, the app as its launcher icon opens it. */
        private fun open(context: Context, key: String?): PendingIntent? {
            if (key.isNullOrEmpty()) {
                val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
                return PendingIntent.getActivity(context, SLOT_OPEN, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            }
            val intent = Intent(context, MainActivity::class.java)
                .setAction(ACTION_HEALTH_OPEN)
                .putExtra(GlanceWidgets.EXTRA_OPEN_KEY, key)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            return PendingIntent.getActivity(context, SLOT_OPEN, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }

        /**
         * The one sentence drawn instead of figures, or null when the figures are the truth: empty
         * and unavailable say so; a stale document says [HealthWords.stale] (its hint rides under it);
         * a ready one with no figure says [HealthWords.nothing].
         */
        private fun sentence(snapshot: HealthSnapshot, now: Long): String? = when {
            snapshot.state == "empty" -> snapshot.words.empty
            snapshot.state != "ready" -> snapshot.words.unavailable
            snapshot.isStale(now) -> snapshot.words.stale
            snapshot.figures.isEmpty() -> snapshot.words.nothing
            else -> null
        }

        private fun hint(snapshot: HealthSnapshot, now: Long): String? =
            if (snapshot.state == "ready" && snapshot.isStale(now)) snapshot.words.staleHint else null

        fun small(context: Context, snapshot: HealthSnapshot?, now: Long): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.glance_health_small)
            open(context, snapshot?.open)?.let { views.setOnClickPendingIntent(R.id.glance_root, it) }
            if (snapshot == null) return bare(context, views)
            val message = sentence(snapshot, now)
            val hint = hint(snapshot, now)
            val first = if (message == null) snapshot.figures.first() else null
            val caption = if (first?.metric == "steps") snapshot.words.stepsCaption else ""
            val sleep = if (message == null) snapshot.sleepLine else ""
            views.setTextViewText(R.id.glance_title, snapshot.words.title)
            views.show(R.id.health_figure, first != null)
            views.show(R.id.health_caption, caption.isNotEmpty())
            views.show(R.id.health_sleep, sleep.isNotEmpty())
            views.show(R.id.glance_message, message != null)
            views.show(R.id.health_hint, hint != null)
            if (first != null) views.setTextViewText(R.id.health_figure, first.text)
            views.setTextViewText(R.id.health_caption, caption)
            views.setTextViewText(R.id.health_sleep, sleep)
            if (message != null) views.setTextViewText(R.id.glance_message, message)
            if (hint != null) views.setTextViewText(R.id.health_hint, hint)
            views.describe(R.id.glance_root, snapshot.words.title, first?.text.orEmpty(), caption, sleep, message.orEmpty(), hint.orEmpty())
            return views
        }

        fun wide(context: Context, snapshot: HealthSnapshot?, now: Long): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.glance_health_wide)
            open(context, snapshot?.open)?.let { views.setOnClickPendingIntent(R.id.glance_root, it) }
            if (snapshot == null) {
                // Every slot is set every time: an update re-applies onto the view already on screen.
                hideCells(views, 0)
                views.show(R.id.health_hint, false)
                return bare(context, views)
            }
            val message = sentence(snapshot, now)
            val hint = hint(snapshot, now)
            val figures = if (message == null) snapshot.figures.take(GRID_CELLS.size) else emptyList()
            views.setTextViewText(R.id.glance_title, snapshot.words.title)
            views.show(R.id.glance_message, message != null)
            views.show(R.id.health_hint, hint != null)
            if (message != null) views.setTextViewText(R.id.glance_message, message)
            if (hint != null) views.setTextViewText(R.id.health_hint, hint)
            val said = mutableListOf(snapshot.words.title)
            figures.forEachIndexed { slot, figure ->
                views.show(GRID_CELLS[slot], true)
                views.setTextViewText(GRID_LABELS[slot], figure.label)
                views.setTextViewText(GRID_TEXTS[slot], figure.text)
                views.describe(GRID_CELLS[slot], figure.label, figure.text)
                said += figure.label
                said += figure.text
            }
            hideCells(views, figures.size)
            said += message.orEmpty()
            said += hint.orEmpty()
            views.describe(R.id.glance_root, *said.toTypedArray())
            return views
        }

        private fun hideCells(views: RemoteViews, from: Int) {
            for (slot in from until GRID_CELLS.size) views.show(GRID_CELLS[slot], false)
        }

        /** No snapshot yet: the widget's own name and the catalogue's "open Centraid" sentence, never an empty day. */
        private fun bare(context: Context, views: RemoteViews): RemoteViews {
            val name = context.getString(R.string.glance_widget_health_name)
            val unavailable = context.getString(R.string.glance_widget_health_unavailable)
            views.setTextViewText(R.id.glance_title, name)
            views.setTextViewText(R.id.glance_message, unavailable)
            views.show(R.id.glance_message, true)
            for (id in intArrayOf(R.id.health_figure, R.id.health_caption, R.id.health_sleep, R.id.health_hint)) {
                // The small layout has these; the wide one has only the hint, and a missing id is skipped by RemoteViews.
                views.show(id, false)
            }
            views.describe(R.id.glance_root, name, unavailable)
            return views
        }
    }
}
