package dev.centraid.android.widgets

/** A RemoteViews widget cannot scroll. Larger text gives the summary its space
 * by dropping the optional reminder preview before any action is clipped. */
internal data class AgendaWidgetSizing(val eventLines: Int, val showReminders: Boolean) {
    companion object {
        fun at(heightDp: Int, fontScale: Float): AgendaWidgetSizing {
            val usable = heightDp / fontScale.coerceAtLeast(1f)
            return AgendaWidgetSizing(eventLines = if (usable >= 220) 2 else 1, showReminders = usable >= 280)
        }
    }
}
