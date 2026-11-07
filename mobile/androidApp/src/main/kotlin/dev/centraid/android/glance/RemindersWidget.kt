package dev.centraid.android.glance

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.os.Bundle
import android.widget.RemoteViews
import dev.centraid.android.R

/**
 * REMINDERS (#1173): today's and overdue reminders from Agenda, 2x2 (the count and what needs
 * attention) and 4x2 (a short list and a New Reminder button). Same rules as [UpNextWidget]: a
 * framework provider over `RemoteViews`, drawn from the snapshot file alone, never the vault.
 */
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
            GlanceWidgets.open(context)?.let { views.setOnClickPendingIntent(R.id.glance_root, it) }
            if (snapshot == null) {
                val name = context.getString(R.string.glance_widget_reminders_name)
                views.setTextViewText(R.id.glance_title, name)
                val unavailable = context.getString(R.string.glance_widget_unavailable)
                for (id in intArrayOf(R.id.glance_count, R.id.glance_count_label, R.id.glance_overdue, R.id.glance_flagged)) {
                    views.show(id, false)
                }
                views.setTextViewText(R.id.glance_message, unavailable)
                views.show(R.id.glance_message, true)
                views.describe(R.id.glance_root, name, unavailable)
                return views
            }
            val words = snapshot.words
            val message = snapshot.sentence(now)
                ?: if (snapshot.todayCount == 0 && snapshot.overdueCount == 0) words.noReminders else null
            val counts = message == null
            views.setTextViewText(R.id.glance_title, words.remindersTitle)
            views.show(R.id.glance_count, counts)
            views.show(R.id.glance_count_label, counts)
            views.show(R.id.glance_overdue, counts && snapshot.overdueCount > 0)
            views.show(R.id.glance_flagged, counts && snapshot.flaggedCount > 0)
            views.show(R.id.glance_message, message != null)
            if (message != null) views.setTextViewText(R.id.glance_message, message)
            views.setTextViewText(R.id.glance_count, snapshot.todayCount.toString())
            views.setTextViewText(R.id.glance_count_label, words.todayTitle)
            views.setTextViewText(R.id.glance_overdue, words.overdueLabel)
            views.setTextViewText(R.id.glance_flagged, words.flaggedLabel)
            views.describe(
                R.id.glance_root,
                words.remindersTitle,
                message ?: words.todayLabel,
                if (counts && snapshot.overdueCount > 0) words.overdueLabel else "",
                if (counts && snapshot.flaggedCount > 0) words.flaggedLabel else "",
            )
            return views
        }

        override fun wide(context: Context, snapshot: GlanceSnapshot?, now: Long): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.glance_reminders_wide)
            GlanceWidgets.open(context)?.let { views.setOnClickPendingIntent(R.id.glance_root, it) }
            // The button is the one control, and it works without a snapshot: it only opens the app.
            views.setOnClickPendingIntent(R.id.glance_add, GlanceWidgets.add(context))
            if (snapshot == null) {
                val name = context.getString(R.string.glance_widget_reminders_name)
                val add = context.getString(R.string.glance_shortcut_add_short)
                views.setTextViewText(R.id.glance_title, name)
                views.setTextViewText(R.id.glance_add, add)
                views.setTextViewText(R.id.glance_today, "")
                val unavailable = context.getString(R.string.glance_widget_unavailable)
                views.setTextViewText(R.id.glance_message, unavailable)
                views.show(R.id.glance_message, true)
                for (slot in ROWS.indices) views.show(ROWS[slot], false)
                views.describe(R.id.glance_root, name, unavailable)
                views.describe(R.id.glance_add, add)
                return views
            }
            val words = snapshot.words
            val sentence = snapshot.sentence(now)
            val rows = if (sentence == null) snapshot.reminders else emptyList()
            val message = sentence ?: if (rows.isEmpty()) words.noReminders else null
            views.setTextViewText(R.id.glance_title, words.remindersTitle)
            views.setTextViewText(R.id.glance_today, if (sentence == null) words.todayLabel else "")
            views.setTextViewText(R.id.glance_add, words.addLabel)
            views.show(R.id.glance_message, message != null)
            if (message != null) views.setTextViewText(R.id.glance_message, message)
            val said = mutableListOf(words.remindersTitle)
            for (slot in ROWS.indices) {
                val row = rows.getOrNull(slot)
                views.show(ROWS[slot], row != null)
                if (row == null) continue
                views.setTextViewText(TITLES[slot], row.title)
                views.setTextViewText(DUES[slot], row.dueLabel)
                views.setTextViewText(DUES_RED[slot], row.dueLabel)
                views.show(DUES[slot], !row.overdue)
                views.show(DUES_RED[slot], row.overdue)
                views.show(FLAGS[slot], row.flagged)
                said += row.title
                said += row.dueLabel
            }
            if (message != null) said += message
            views.describe(R.id.glance_root, *said.toTypedArray())
            views.describe(R.id.glance_add, words.addLabel)
            return views
        }
    }
}
