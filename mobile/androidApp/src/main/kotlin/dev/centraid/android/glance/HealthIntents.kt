package dev.centraid.android.glance

import android.content.Intent
import centraid.core.v1.HealthIntent
import centraid.core.v1.ShellFact
import dev.centraid.core.Screens
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.receiveAsFlow

/**
 * A HEALTH WIDGET'S TAP (#1185), the way Agenda's arrive ([AgendaIntents]): the activity [accept]s
 * the intent as it arrives, possibly before the screen runtime is up; the root composition
 * [deliver]s each one once as `ShellFact.health_intent`. The extra is an OPAQUE KEY from the
 * snapshot, handed back untouched; the core names the page (Health's home for any key). This shell
 * names no screen and checks nothing about the key, because the activity is exported.
 */
internal object HealthIntents {
    private val pending = Channel<HealthIntent>(Channel.UNLIMITED)

    /** Queue the request if [intent] is a Health widget's tap. */
    fun accept(intent: Intent?) {
        if (intent?.action == HealthWidget.ACTION_HEALTH_OPEN) {
            pending.trySend(HealthIntent(key = intent.getStringExtra(GlanceWidgets.EXTRA_OPEN_KEY).orEmpty()))
        }
    }

    /** Report every queued and later request to [screens], until the calling coroutine is cancelled. */
    suspend fun deliver(screens: Screens) {
        pending.receiveAsFlow().collect { asked ->
            screens.shellFact(ShellFact(health_intent = asked))
        }
    }
}
