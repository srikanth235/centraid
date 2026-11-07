package dev.centraid.android.glance

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.RemoteViews
import dev.centraid.android.R

/**
 * UP NEXT (#1173): what is next today from Agenda, 2x2 (the next item) and 4x2 (a short list).
 * A framework `AppWidgetProvider` over `RemoteViews`: no Glance, no list service, so no new
 * dependency. Everything it draws is in the snapshot file ([GlanceSnapshot]); it never opens the
 * vault. The app pushes redraws (`GlanceWidgets.keep`); the platform's own timer is off.
 */
public class UpNextWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) =
        GlanceWidgets.reload(context)

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, appWidgetId: Int, newOptions: Bundle) =
        GlanceWidgets.reload(context)

    override fun onDeleted(context: Context, appWidgetIds: IntArray) = GlanceWidgets.reschedule(context)

    override fun onDisabled(context: Context) = GlanceWidgets.reschedule(context)

    /** The refresh alarm lands here (it is aimed at this receiver); everything else is the platform's. */
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == GlanceWidgets.ACTION_REFRESH) GlanceWidgets.reload(context) else super.onReceive(context, intent)
    }

    internal object Draw : GlanceWidgets.Renderer {
        /** The most lines (rows and day headers together) the 4x2 layout has room for. */
        private const val LINES = 4

        private val TIMES = intArrayOf(R.id.glance_row_time_0, R.id.glance_row_time_1, R.id.glance_row_time_2, R.id.glance_row_time_3)
        private val TIMES_RED = intArrayOf(R.id.glance_row_time_red_0, R.id.glance_row_time_red_1, R.id.glance_row_time_red_2, R.id.glance_row_time_red_3)
        private val BARS = intArrayOf(R.id.glance_row_bar_0, R.id.glance_row_bar_1, R.id.glance_row_bar_2, R.id.glance_row_bar_3)
        private val TITLES = intArrayOf(R.id.glance_row_title_0, R.id.glance_row_title_1, R.id.glance_row_title_2, R.id.glance_row_title_3)
        private val ROWS = intArrayOf(R.id.glance_row_0, R.id.glance_row_1, R.id.glance_row_2, R.id.glance_row_3)
        private val DAYS = intArrayOf(R.id.glance_day_0, R.id.glance_day_1, R.id.glance_day_2, R.id.glance_day_3)

        override fun small(context: Context, snapshot: GlanceSnapshot?, now: Long): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.glance_up_next_small)
            GlanceWidgets.open(context)?.let { views.setOnClickPendingIntent(R.id.glance_root, it) }
            if (snapshot == null) return bare(context, views)
            val first = snapshot.upNext.firstOrNull()
            val message = snapshot.sentence(now) ?: if (first == null) snapshot.words.nothingNext else null
            val item = if (message == null) first else null
            val red = item?.tint == "red"
            views.setTextViewText(R.id.glance_title, snapshot.words.upNextTitle)
            views.show(R.id.glance_time, item != null && !red)
            views.show(R.id.glance_time_red, item != null && red)
            views.show(R.id.glance_item, item != null)
            views.show(R.id.glance_message, message != null)
            if (item != null) {
                views.setTextViewText(R.id.glance_time, item.timeLabel)
                views.setTextViewText(R.id.glance_time_red, item.timeLabel)
                views.setTextViewText(R.id.glance_item, item.title)
            }
            if (message != null) views.setTextViewText(R.id.glance_message, message)
            views.describe(R.id.glance_root, snapshot.words.upNextTitle, item?.timeLabel.orEmpty(), item?.title.orEmpty(), message.orEmpty())
            return views
        }

        override fun wide(context: Context, snapshot: GlanceSnapshot?, now: Long): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.glance_up_next_wide)
            GlanceWidgets.open(context)?.let { views.setOnClickPendingIntent(R.id.glance_root, it) }
            if (snapshot == null) {
                // Every slot is set every time: an update re-applies onto the view already on screen.
                hideRows(views, 0)
                return bare(context, views)
            }
            val sentence = snapshot.sentence(now)
            val rows = if (sentence == null) snapshot.upNext else emptyList()
            val message = sentence ?: if (rows.isEmpty()) snapshot.words.nothingNext else null
            views.setTextViewText(R.id.glance_title, snapshot.words.upNextTitle)
            views.show(R.id.glance_message, message != null)
            if (message != null) views.setTextViewText(R.id.glance_message, message)
            // A day header (the snapshot's "Tomorrow") rides above the first row of its day.
            var used = 0
            var slot = 0
            var day = ""
            val said = mutableListOf(snapshot.words.upNextTitle)
            for (row in rows) {
                val header = row.dayLabel.isNotEmpty() && row.dayLabel != day
                val lines = if (header) 2 else 1
                if (slot >= ROWS.size || used + lines > LINES) break
                day = row.dayLabel
                views.show(DAYS[slot], header)
                if (header) {
                    views.setTextViewText(DAYS[slot], row.dayLabel)
                    said += row.dayLabel
                }
                val red = row.tint == "red"
                views.show(ROWS[slot], true)
                views.setTextViewText(TIMES[slot], row.timeLabel)
                views.setTextViewText(TIMES_RED[slot], row.timeLabel)
                views.show(TIMES[slot], !red)
                views.show(TIMES_RED[slot], red)
                views.setInt(BARS[slot], "setBackgroundResource", if (red) R.drawable.glance_bar_red else R.drawable.glance_bar_agenda)
                views.setTextViewText(TITLES[slot], row.title)
                said += row.timeLabel
                said += row.title
                used += lines
                slot++
            }
            hideRows(views, slot)
            if (message != null) said += message
            views.describe(R.id.glance_root, *said.toTypedArray())
            return views
        }

        /** Hide every slot from [from] on, header and row. */
        private fun hideRows(views: RemoteViews, from: Int) {
            for (slot in from until ROWS.size) {
                views.show(DAYS[slot], false)
                views.show(ROWS[slot], false)
            }
        }

        /** No snapshot yet: the widget's own name and the catalogue's "open Centraid" sentence, never an empty day. */
        private fun bare(context: Context, views: RemoteViews): RemoteViews {
            val name = context.getString(R.string.glance_widget_up_next_name)
            val unavailable = context.getString(R.string.glance_widget_unavailable)
            views.setTextViewText(R.id.glance_title, name)
            views.setTextViewText(R.id.glance_message, unavailable)
            views.show(R.id.glance_message, true)
            views.show(R.id.glance_time, false)
            views.show(R.id.glance_time_red, false)
            views.show(R.id.glance_item, false)
            views.describe(R.id.glance_root, name, unavailable)
            return views
        }
    }
}
