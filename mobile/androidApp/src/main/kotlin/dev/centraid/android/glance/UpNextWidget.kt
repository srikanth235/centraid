package dev.centraid.android.glance

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.RemoteViews
import dev.centraid.android.R

public class UpNextWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) =
        GlanceWidgets.reload(context)

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, appWidgetId: Int, newOptions: Bundle) =
        GlanceWidgets.reload(context)

    override fun onDeleted(context: Context, appWidgetIds: IntArray) = GlanceWidgets.reschedule(context)

    override fun onDisabled(context: Context) = GlanceWidgets.reschedule(context)

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == GlanceWidgets.ACTION_REFRESH) GlanceWidgets.reload(context) else super.onReceive(context, intent)
    }

    internal object Draw : GlanceWidgets.Renderer {
        private val TIMES = intArrayOf(R.id.glance_row_time_0, R.id.glance_row_time_1, R.id.glance_row_time_2, R.id.glance_row_time_3)
        private val TIMES_RED = intArrayOf(R.id.glance_row_time_red_0, R.id.glance_row_time_red_1, R.id.glance_row_time_red_2, R.id.glance_row_time_red_3)
        private val BARS = intArrayOf(R.id.glance_row_bar_0, R.id.glance_row_bar_1, R.id.glance_row_bar_2, R.id.glance_row_bar_3)
        private val TITLES = intArrayOf(R.id.glance_row_title_0, R.id.glance_row_title_1, R.id.glance_row_title_2, R.id.glance_row_title_3)
        private val ROWS = intArrayOf(R.id.glance_row_0, R.id.glance_row_1, R.id.glance_row_2, R.id.glance_row_3)
        private val DAYS = intArrayOf(R.id.glance_day_0, R.id.glance_day_1, R.id.glance_day_2, R.id.glance_day_3)

        override fun small(context: Context, snapshot: GlanceSnapshot?, now: Long): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.glance_up_next_small)
            GlanceWidgets.openUrl(context, snapshot?.lines?.firstOrNull()?.url, GlanceWidgets.SLOT_UP_NEXT)
                ?.let { views.setOnClickPendingIntent(R.id.glance_root, it) }
            if (snapshot == null) return bare(views)
            val first = snapshot.lines.firstOrNull()
            views.setTextViewText(R.id.glance_title, snapshot.title)
            views.show(R.id.glance_time, false)
            views.show(R.id.glance_time_red, false)
            views.show(R.id.glance_item, first != null)
            views.show(R.id.glance_message, first == null)
            if (first != null) {
                views.setTextViewText(R.id.glance_item, first.text)
            } else {
                views.setTextViewText(R.id.glance_message, snapshot.summary)
            }
            views.describe(R.id.glance_root, snapshot.title, first?.text ?: snapshot.summary)
            return views
        }

        override fun wide(context: Context, snapshot: GlanceSnapshot?, now: Long): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.glance_up_next_wide)
            GlanceWidgets.openUrl(context, null, GlanceWidgets.SLOT_UP_NEXT)
                ?.let { views.setOnClickPendingIntent(R.id.glance_root, it) }
            if (snapshot == null) {
                hideRows(views, 0)
                return bare(views)
            }
            views.setTextViewText(R.id.glance_title, snapshot.title)
            val rows = snapshot.lines.take(ROWS.size)
            views.show(R.id.glance_message, rows.isEmpty())
            if (rows.isEmpty()) views.setTextViewText(R.id.glance_message, snapshot.summary)
            val said = mutableListOf(snapshot.title)
            rows.forEachIndexed { slot, row ->
                views.show(DAYS[slot], false)
                views.show(ROWS[slot], true)
                GlanceWidgets.openUrl(context, row.url, GlanceWidgets.SLOT_UP_NEXT + 1 + slot)
                    ?.let { views.setOnClickPendingIntent(ROWS[slot], it) }
                views.describe(ROWS[slot], row.text)
                views.show(TIMES[slot], false)
                views.show(TIMES_RED[slot], false)
                views.setInt(BARS[slot], "setBackgroundResource", R.drawable.glance_bar_agenda)
                views.setTextViewText(TITLES[slot], row.text)
                said += row.text
            }
            hideRows(views, rows.size)
            if (rows.isEmpty()) said += snapshot.summary
            views.describe(R.id.glance_root, *said.toTypedArray())
            return views
        }

        private fun hideRows(views: RemoteViews, from: Int) {
            for (slot in from until ROWS.size) {
                views.show(DAYS[slot], false)
                views.show(ROWS[slot], false)
            }
        }

        private fun bare(views: RemoteViews): RemoteViews {
            views.setTextViewText(R.id.glance_title, "Today")
            views.setTextViewText(R.id.glance_message, "Open Centraid")
            views.show(R.id.glance_message, true)
            views.show(R.id.glance_time, false)
            views.show(R.id.glance_time_red, false)
            views.show(R.id.glance_item, false)
            views.describe(R.id.glance_root, "Today", "Open Centraid")
            return views
        }
    }
}
