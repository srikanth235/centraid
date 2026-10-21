package dev.centraid.shared.shell

import dev.centraid.core.CentraidCore
import dev.centraid.shared.sync.phone.PhoneFollowSource
import dev.centraid.shared.sync.phone.PhoneSource
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlin.time.Clock

/**
 * HOW A SHELL FOLLOWS THE PHONE (#1127). Both shells do the same four things:
 *
 * - build a reader for each source it can read (`ContactsReader`, `CalendarReader`) and wrap it in
 *   the app's `ContactsFollow` / `CalendarFollow`;
 * - [attach] once, with the session, those sources, and the function that draws a question;
 * - call [requested] when the phone may have changed: the app came to the front, or the OS
 *   announced a change in the address book or the calendars. It is cheap and never blocks; the
 *   bridge coalesces bursts, runs one pass per source at a time, and does nothing unless the
 *   member already imported that source and the reader answers (no OS permission is ever asked);
 * - call [answer] when the member answers a [PhoneFollowQuestion].
 *
 * The follower belongs to the foreground vault's core: switching vaults starts a fresh one, and an
 * answer to a question of the vault left behind is ignored. Call all of it on the main thread.
 */
public class PhoneFollowBridge {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var session: HomeSession? = null
    private var sources: List<PhoneFollowSource> = emptyList()
    private var ask: (PhoneFollowQuestion) -> Unit = {}
    private var held: Pair<CentraidCore, PhoneFollower>? = null

    public fun attach(session: HomeSession, sources: List<PhoneFollowSource>, ask: (PhoneFollowQuestion) -> Unit) {
        this.session = session
        this.sources = sources
        this.ask = ask
        held = null
    }

    /** Follow [source] soon: the phone may have changed. */
    public fun requested(source: PhoneSource) {
        follower()?.requested(source)
    }

    /** The member's answer to [question]: [keep] is the default. */
    public fun answer(question: PhoneFollowQuestion, keep: Boolean) {
        follower()?.answer(question.originId, keep)
    }

    private fun follower(): PhoneFollower? {
        val core = session?.shelf?.core() ?: return null
        held?.takeIf { it.first === core }?.let { return it.second }
        val made = PhoneFollower(
            scope = scope,
            passes = sources.associate { it.source to it.bind(core) },
            ask = ask,
            now = { Clock.System.now().toEpochMilliseconds() },
        )
        held = core to made
        return made
    }
}
