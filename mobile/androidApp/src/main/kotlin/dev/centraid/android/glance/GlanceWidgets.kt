package dev.centraid.android.glance

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.AtomicFile
import android.util.SizeF
import android.widget.RemoteViews
import dev.centraid.android.MainActivity
import java.io.IOException

internal object GlanceWidgets {
    const val ACTION_ADD_REMINDER: String = "dev.centraid.action.ADD_REMINDER"
    const val EXTRA_TITLE: String = "dev.centraid.extra.REMINDER_TITLE"
    const val ACTION_AGENDA_OPEN: String = "dev.centraid.action.AGENDA_OPEN"
    const val EXTRA_OPEN_KEY: String = "dev.centraid.extra.OPEN_KEY"
    const val ACTION_REFRESH: String = "dev.centraid.action.GLANCE_REFRESH"

    private const val WIDE_DP = 220

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

    fun reload(context: Context) {
        val manager = AppWidgetManager.getInstance(context)
        val snapshot = GlanceSnapshot.load(context)
        val now = System.currentTimeMillis()
        for ((provider, render) in PROVIDERS) {
            for (id in manager.getAppWidgetIds(ComponentName(context, provider))) {
                manager.updateAppWidget(id, views(context, manager, id, render, snapshot, now))
            }
        }
    }

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

    fun reschedule(context: Context) {
        reload(context)
    }

    fun openUrl(context: Context, url: String?, slot: Int): PendingIntent? {
        if (url.isNullOrEmpty()) {
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
            return PendingIntent.getActivity(context, slot, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(context, slot, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    const val SLOT_UP_NEXT: Int = 100
    const val SLOT_REMINDERS: Int = 200
    const val SLOT_ADD: Int = 300

    internal interface Renderer {
        fun small(context: Context, snapshot: GlanceSnapshot?, now: Long): RemoteViews
        fun wide(context: Context, snapshot: GlanceSnapshot?, now: Long): RemoteViews
    }

    private val PROVIDERS: List<Pair<Class<*>, Renderer>> = listOf(
        UpNextWidget::class.java to UpNextWidget.Draw,
        RemindersWidget::class.java to RemindersWidget.Draw,
    )
}

internal fun RemoteViews.show(id: Int, on: Boolean) =
    setViewVisibility(id, if (on) android.view.View.VISIBLE else android.view.View.GONE)

internal fun RemoteViews.describe(id: Int, vararg parts: String) =
    setContentDescription(id, parts.filter { it.isNotEmpty() }.joinToString(" "))
