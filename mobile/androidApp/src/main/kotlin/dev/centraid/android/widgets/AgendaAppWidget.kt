package dev.centraid.android.widgets

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.view.View
import android.widget.RemoteViews
import centraid.core.v1.AgendaWidgetSnapshot
import centraid.core.v1.HomeEvent
import centraid.core.v1.HomeState
import centraid.core.v1.ScreenEvent
import dev.centraid.android.MainActivity
import dev.centraid.android.R
import dev.centraid.core.Screens
import dev.centraid.design.KitWords
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/** A display-only host snapshot. No widget process opens a second vault. */
public class AgendaAppWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
        AgendaWidgetBridge.render(context, manager, appWidgetIds)
    }

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, appWidgetId: Int, newOptions: Bundle) {
        AgendaWidgetBridge.render(context, manager, intArrayOf(appWidgetId))
    }
}

internal object AgendaWidgetBridge {
    private const val STORE = "agenda-widget"
    private const val SNAPSHOT = "snapshot"
    private const val UPDATED = "updated"

    fun attach(context: Context, screens: Screens, scope: CoroutineScope) {
        scope.launch {
            screens.views.collect { states ->
                states.values.firstNotNullOfOrNull { it.home }?.let { publish(context, it) }
            }
        }
    }

    private fun publish(context: Context, home: HomeState) {
        val preferences = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
        val snapshot = home.data_?.agenda_widget
        val encoded = snapshot?.let { Base64.encodeToString(AgendaWidgetSnapshot.ADAPTER.encode(it), Base64.NO_WRAP) }
        val now = System.currentTimeMillis()
        if (encoded == preferences.getString(SNAPSHOT, null) && now - preferences.getLong(UPDATED, 0) < 900_000) return
        preferences.edit().putString(SNAPSHOT, encoded).putLong(UPDATED, now).apply()
        val manager = AppWidgetManager.getInstance(context)
        render(context, manager, manager.getAppWidgetIds(ComponentName(context, AgendaAppWidget::class.java)))
    }

    fun render(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val preferences = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
        val snapshot = preferences.getString(SNAPSHOT, null)?.let { encoded ->
            runCatching { AgendaWidgetSnapshot.ADAPTER.decode(Base64.decode(encoded, Base64.NO_WRAP)) }.getOrNull()
        }
        for (id in ids) {
            val views = RemoteViews(context.packageName, R.layout.agenda_widget)
            val options = manager.getAppWidgetOptions(id)
            val layout = AgendaWidgetSizing.at(
                options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 180),
                context.resources.configuration.fontScale,
            )
            views.setContentDescription(R.id.widget_root, snapshot?.open_label ?: KitWords.WIDGET_OPEN)
            views.setTextViewText(R.id.widget_title, snapshot?.title ?: KitWords.WIDGET_AGENDA)
            views.setTextViewText(R.id.widget_event, snapshot?.event_title?.ifEmpty { snapshot.empty_label } ?: KitWords.WIDGET_EMPTY)
            views.setTextViewText(R.id.widget_when, snapshot?.event_when.orEmpty())
            views.setTextViewText(R.id.widget_reminders, listOfNotNull(snapshot?.reminders, snapshot?.reminder_title).filter { it.isNotEmpty() }.joinToString("\n"))
            views.setTextViewText(R.id.widget_new, snapshot?.new_label ?: KitWords.WIDGET_NEW)
            val updated = preferences.getLong(UPDATED, 0)
            views.setTextViewText(R.id.widget_updated, if (snapshot == null) "" else snapshot.updated_label + " " + java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT, java.text.DateFormat.SHORT).format(java.util.Date(updated)))
            views.setInt(R.id.widget_event, "setMaxLines", layout.eventLines)
            views.setViewVisibility(R.id.widget_reminders, if (!layout.showReminders || snapshot?.reminders.isNullOrEmpty()) View.GONE else View.VISIBLE)
            views.setOnClickPendingIntent(R.id.widget_root, open(context, "calendar", id * 2))
            views.setOnClickPendingIntent(R.id.widget_new, open(context, "new", id * 2 + 1))
            manager.updateAppWidget(id, views)
        }
    }

    private fun open(context: Context, destination: String, request: Int): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setAction(Intent.ACTION_VIEW)
            .setData(Uri.parse("centraid://agenda/$destination"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(context, request, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
}

/** The host waits for its existing vault, then asks Rust for the destination. */
internal object AgendaWidgetLauncher {
    fun take(intent: Intent?): Intent? {
        val url = intent?.data ?: return null
        if (url.scheme != "centraid" || url.host != "agenda") return null
        return Intent(intent).also { intent.data = null }
    }

    suspend fun open(intent: Intent?, screens: Screens) {
        val url = intent?.data ?: return
        if (url.scheme != "centraid" || url.host != "agenda") return
        val entry = when (url.path) {
            "/calendar" -> HomeEvent.EntryAsked.Entry.ENTRY_AGENDA_CALENDAR
            "/reminders" -> HomeEvent.EntryAsked.Entry.ENTRY_AGENDA_REMINDERS
            "/new" -> HomeEvent.EntryAsked.Entry.ENTRY_AGENDA_NEW_REMINDER
            else -> return
        }
        val states = screens.views.first { states -> states.values.any { it.home?.data_ != null } }
        val home = states.values.first { it.home?.data_ != null }
        screens.send(home.instance, ScreenEvent(home = HomeEvent(entry_asked = HomeEvent.EntryAsked(
            entry = entry, title = url.getQueryParameter("title").orEmpty().take(1024),
        ))))
    }
}
