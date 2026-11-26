package dev.centraid.android.glance

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.os.Bundle
import android.widget.RemoteViews
import dev.centraid.android.R

public class RemindersWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) =
        GlanceWidgets.reload(context)

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, appWidgetId: Int, newOptions: Bundle) =
        GlanceWidgets.reload(context)

    override fun onDeleted(context: Context, appWidgetIds: IntArray) = GlanceWidgets.reschedule(context)

    override fun onDisabled(context: Context) = GlanceWidgets.reschedule(context)

    internal object Draw : GlanceWidgets.Renderer {
        private val ROWS = intArrayOf(R.id.glance_row_0, R.id.glance_row_1, R.id.glance_row_2, R.id.glance_row_3)
        private val TITLES = intArrayOf(R.id.glance_row_title_0, R.id.glance_row_title_1, R.id.glance_row_title_2, R.id.glance_row_title_3)
        private val FLAGS = intArrayOf(R.id.glance_row_flag_0, R.id.glance_row_flag_1, R.id.glance_row_flag_2, R.id.glance_row_flag_3)
        private val DUES = intArrayOf(R.id.glance_row_due_0, R.id.glance_row_due_1, R.id.glance_row_due_2, R.id.glance_row_due_3)
        private val DUES_RED = intArrayOf(R.id.glance_row_due_red_0, R.id.glance_row_due_red_1, R.id.glance_row_due_red_2, R.id.glance_row_due_red_3)

        override fun small(context: Context, snapshot: GlanceSnapshot?, now: Long): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.glance_reminders_small)
            GlanceWidgets.openUrl(context, null, GlanceWidgets.SLOT_REMINDERS)
                ?.let { views.setOnClickPendingIntent(R.id.glance_root, it) }
            if (snapshot == null) {
                views.setTextViewText(R.id.glance_title, "Reminders")
                for (id in intArrayOf(R.id.glance_count, R.id.glance_count_label, R.id.glance_overdue, R.id.glance_flagged)) {
                    views.show(id, false)
                }
                views.setTextViewText(R.id.glance_message, "Open Centraid")
                views.show(R.id.glance_message, true)
                views.describe(R.id.glance_root, "Reminders", "Open Centraid")
                return views
            }
            val tasks = snapshot.lines.filter { it.kind == "task" }
            views.setTextViewText(R.id.glance_title, snapshot.title)
            views.show(R.id.glance_count, tasks.isNotEmpty())
            views.show(R.id.glance_count_label, tasks.isNotEmpty())
            views.show(R.id.glance_overdue, false)
            views.show(R.id.glance_flagged, false)
            views.show(R.id.glance_message, tasks.isEmpty())
            if (tasks.isEmpty()) {
                views.setTextViewText(R.id.glance_message, snapshot.summary)
            } else {
                views.setTextViewText(R.id.glance_count, tasks.size.toString())
                views.setTextViewText(R.id.glance_count_label, snapshot.summary)
            }
            views.describe(R.id.glance_root, snapshot.title, snapshot.summary)
            return views
        }

        override fun wide(context: Context, snapshot: GlanceSnapshot?, now: Long): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.glance_reminders_wide)
            GlanceWidgets.openUrl(context, null, GlanceWidgets.SLOT_REMINDERS)
                ?.let { views.setOnClickPendingIntent(R.id.glance_root, it) }
            GlanceWidgets.openUrl(context, null, GlanceWidgets.SLOT_ADD)
                ?.let { views.setOnClickPendingIntent(R.id.glance_add, it) }
            if (snapshot == null) {
                views.setTextViewText(R.id.glance_title, "Reminders")
                views.setTextViewText(R.id.glance_add, "+")
                views.setTextViewText(R.id.glance_today, "")
                views.setTextViewText(R.id.glance_message, "Open Centraid")
                views.show(R.id.glance_message, true)
                for (slot in ROWS.indices) views.show(ROWS[slot], false)
                views.describe(R.id.glance_root, "Reminders", "Open Centraid")
                return views
            }
            val rows = snapshot.lines.filter { it.kind == "task" }.take(ROWS.size)
            views.setTextViewText(R.id.glance_title, snapshot.title)
            views.setTextViewText(R.id.glance_today, snapshot.summary)
            views.setTextViewText(R.id.glance_add, "+")
            views.show(R.id.glance_message, rows.isEmpty())
            if (rows.isEmpty()) views.setTextViewText(R.id.glance_message, snapshot.summary)
            val said = mutableListOf(snapshot.title)
            for (slot in ROWS.indices) {
                val row = rows.getOrNull(slot)
                views.show(ROWS[slot], row != null)
                if (row == null) continue
                GlanceWidgets.openUrl(context, row.url, GlanceWidgets.SLOT_REMINDERS + 1 + slot)
                    ?.let { views.setOnClickPendingIntent(ROWS[slot], it) }
                views.describe(ROWS[slot], row.text)
                views.setTextViewText(TITLES[slot], row.text)
                views.show(DUES[slot], false)
                views.show(DUES_RED[slot], false)
                views.show(FLAGS[slot], false)
                said += row.text
            }
            if (rows.isEmpty()) said += snapshot.summary
            views.describe(R.id.glance_root, *said.toTypedArray())
            return views
        }
    }
}
