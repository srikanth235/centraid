package dev.centraid.android.glance

import android.content.Intent
import centraid.core.v1.AgendaIntent
import centraid.core.v1.AgendaIntentAdd
import centraid.core.v1.ShellFact
import dev.centraid.core.Screens
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.receiveAsFlow

/**
 * "ADD A REMINDER", FROM THE LAUNCHER'S SHORTCUT OR A WIDGET'S BUTTON (#1173).
 *
 * The activity [accept]s the intent as it arrives (`onCreate`, `onNewIntent`), possibly before the
 * screen runtime is up; the root composition [deliver]s each one once, after the effect performer is attached, as `ShellFact.agenda_intent.add`.
 * Nothing is decided or written here: the core opens Agenda's Reminders with the quick-add bar
 * holding the title, and the member taps Add.
 */
internal object AddReminderShortcut {
    /** Each request waits here until a session reports it; consumed once, in order. */
    private val pending = Channel<String>(Channel.UNLIMITED)

    /** Queue the request if [intent] is one (the title extra, empty when absent). */
    fun accept(intent: Intent?) {
        if (intent?.action != GlanceWidgets.ACTION_ADD_REMINDER) return
        pending.trySend(intent.getStringExtra(GlanceWidgets.EXTRA_TITLE).orEmpty())
    }

    /** Report every queued and later request to [screens], until the calling coroutine is cancelled. */
    suspend fun deliver(screens: Screens) {
        pending.receiveAsFlow().collect { title ->
            screens.shellFact(ShellFact(agenda_intent = AgendaIntent(add = AgendaIntentAdd(title = title))))
        }
    }
}
