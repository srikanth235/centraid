package dev.centraid.shared.shell

import centraid.core.v1.Envelope
import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.PageRequest
import centraid.core.v1.Request
import centraid.core.v1.Value
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import dev.centraid.shared.apps.agenda.CalendarImport
import dev.centraid.shared.apps.people.ContactsImport
import dev.centraid.shared.sync.phone.GoneChoice
import dev.centraid.shared.sync.phone.OriginGone
import dev.centraid.shared.sync.phone.PhoneSource
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlin.time.Clock

/**
 * THE REAL [FollowVault]: the foreground vault's [core], through the importers' own entry points,
 * so a following pass is exactly an import that was already begun (#1127).
 */
internal class CoreFollowVault(private val core: CentraidCore) : FollowVault {
    override suspend fun imported(source: PhoneSource): Boolean? {
        val query = PageQuery(
            name = "phone.follow.imported",
            select = listOf("origin_id"),
            from = "phone_origin",
            where_ = "source = ?",
            bind = listOf(Value(text = source.wire)),
            order = PageOrder(sort_column = "origin_id", pk_column = "origin_id"),
        )
        val answer = core.call(Envelope(request_id = 0, request = Request(page = PageRequest(query = query, limit = 1))))
        val page = (answer as? CoreOutcome.Answered)?.value?.response?.page ?: return null
        return page.rows.isNotEmpty()
    }

    override suspend fun sync(read: PhoneRead): FollowOutcome? = when (read) {
        is PhoneRead.Contacts ->
            FollowOutcome(ContactsImport.run(core, read.read.contacts, read.read.origins, read.read.complete).gone)
        is PhoneRead.Calendar ->
            with(read.read) { FollowOutcome(CalendarImport.run(core, events, deviceTz, now, origins, complete).gone) }
    }

    override suspend fun resolve(gone: OriginGone, keep: Boolean) {
        val choice = if (keep) GoneChoice.KEEP else GoneChoice.TRASH
        when (gone.source) {
            PhoneSource.CONTACTS -> ContactsImport.resolveGone(core, gone.originId, choice)
            // Resolving reads no window, so the zone and the instant are only placeholders.
            PhoneSource.CALENDAR -> CalendarImport.resolveGone(core, gone.originId, choice, "", Clock.System.now().toEpochMilliseconds())
            PhoneSource.FILES -> Unit
        }
    }
}

/**
 * HOW A SHELL FOLLOWS THE PHONE (#1127). Both shells call the same two methods:
 *
 * - [requested] when the phone may have changed: the app came to the front, or the OS announced a
 *   change in the address book or the calendars. It is cheap and never blocks; the bridge
 *   coalesces bursts, runs one pass per source at a time, and does nothing unless the member
 *   already imported that source and the shell's reader answers (no OS permission is ever asked).
 * - [answer] when the member answered a [PhoneFollowQuestion] the shell was handed through
 *   [PhoneFollowShell.ask].
 *
 * The follower belongs to the foreground vault's core: switching vaults starts a fresh one, and an
 * answer to a question of the vault left behind is ignored. Call both on the main thread.
 */
public class PhoneFollowBridge {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var session: HomeSession? = null
    private var shell: PhoneFollowShell? = null
    private var held: Pair<CentraidCore, PhoneFollower>? = null

    public fun attach(session: HomeSession, shell: PhoneFollowShell) {
        this.session = session
        this.shell = shell
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
        val shell = shell ?: return null
        held?.takeIf { it.first === core }?.let { return it.second }
        val made = PhoneFollower(scope, CoreFollowVault(core), shell, now = { Clock.System.now().toEpochMilliseconds() })
        held = core to made
        return made
    }
}
