package dev.centraid.android.glance

import android.content.Intent
import centraid.core.v1.AgendaIntent
import centraid.core.v1.AgendaIntentAdd
import centraid.core.v1.AgendaIntentOpen
import centraid.core.v1.ShellFact
import dev.centraid.core.Screens
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.receiveAsFlow

/**
 * WHAT THE PLATFORM ASKS OF AGENDA FROM OUTSIDE THE APP (#1173): "add a reminder" (the launcher's
 * shortcut) and a widget's tap.
 *
 * The activity [accept]s the intent as it arrives (`onCreate`, `onNewIntent`), possibly before the
 * screen runtime is up; the root composition [deliver]s each one once, after the effect performer is
 * attached, as `ShellFact.agenda_intent`. Nothing is decided or written here:
 *
 * - `add` opens Agenda's Reminders with the quick-add bar open, holding the title when there is one;
 * - `open` carries an OPAQUE KEY from the widget's snapshot (its row's or its body's), handed back
 *   untouched. The core names the page, and a key it did not offer in its last snapshot opens
 *   Agenda's home. **This shell names no screen and checks nothing about the key**, because the
 *   activity is exported and any app may send the intent: what an outside app can push into Agenda
 *   is what the core's own table offers, and nothing else.
 */
internal object AgendaIntents {
    /** Each request waits here until a session reports it; consumed once, in order. */
    private val pending = Channel<AgendaIntent>(Channel.UNLIMITED)

    /** Queue the request if [intent] is one this shell answers. */
    fun accept(intent: Intent?) {
        when (intent?.action) {
            GlanceWidgets.ACTION_ADD_REMINDER ->
                pending.trySend(AgendaIntent(add = AgendaIntentAdd(title = intent.getStringExtra(GlanceWidgets.EXTRA_TITLE).orEmpty())))
            GlanceWidgets.ACTION_AGENDA_OPEN ->
                pending.trySend(AgendaIntent(open = AgendaIntentOpen(key = intent.getStringExtra(GlanceWidgets.EXTRA_OPEN_KEY).orEmpty())))
        }
    }

    /** Report every queued and later request to [screens], until the calling coroutine is cancelled. */
    suspend fun deliver(screens: Screens) {
        pending.receiveAsFlow().collect { asked ->
            screens.shellFact(ShellFact(agenda_intent = asked))
        }
    }
}
