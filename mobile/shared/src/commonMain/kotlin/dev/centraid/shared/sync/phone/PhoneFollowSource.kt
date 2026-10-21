package dev.centraid.shared.sync.phone

import centraid.core.v1.Envelope
import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.PageRequest
import centraid.core.v1.Request
import centraid.core.v1.Value
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

/**
 * ONE PHONE STORE A SHELL CAN FOLLOW, as its app makes it (#1127). The app owns what its reader
 * returns and how that becomes a pass ([bind]); the shell's follower owns when a pass runs and
 * what is asked. Neither names the other's types, which is why this seam is generic: People
 * brings `ContactsFollow`, Agenda `CalendarFollow`, and the shell hands the follower the list.
 */
public interface PhoneFollowSource {
    public val source: PhoneSource

    /** The source over the foreground vault's [core]. */
    public fun bind(core: CentraidCore): PhoneFollowPass
}

/** A source over one vault: the three things a following pass does. Never throws; a failure is a null. */
public interface PhoneFollowPass {
    /** Whether the member imported the source: the vault holds an `origin` for it. Null when unreadable. */
    public suspend fun imported(): Boolean?

    /**
     * Read the phone (off the main thread; the OS is never asked for permission) and run one pass
     * over it. The origins the pass holds for a question, or null when there was nothing to do: no
     * access, a read that never answered, a vault that would not take it.
     */
    public suspend fun run(): List<OriginGone>?

    /** The member's answer to [gone]. */
    public suspend fun resolve(gone: OriginGone, keep: Boolean)
}

/** THE WAIT FOR A SHELL'S READ, the same for every source. */
public object PhoneFollowReads {
    /** A read that has not answered in two minutes is abandoned, so one stuck read cannot hold its source for good. */
    public const val READ_TIMEOUT_MS: Long = 120_000

    /**
     * Ask the shell's reader for a snapshot of the phone and wait for it: [ask] is handed the
     * callback the reader calls once, from any thread, with the read or with null (access not
     * already granted).
     */
    public suspend fun <T : Any> await(timeoutMs: Long = READ_TIMEOUT_MS, ask: (done: (T?) -> Unit) -> Unit): T? =
        withTimeoutOrNull(timeoutMs) {
            suspendCancellableCoroutine { next -> ask { next.resume(it) } }
        }

    /** Whether [core] holds an `origin` for [source]'s system: the member imported it. Null when the read fails. */
    public suspend fun imported(core: CentraidCore, source: PhoneSource): Boolean? {
        val query = PageQuery(
            name = "phone.follow.imported",
            select = listOf("id"),
            from = "origin",
            where_ = "system = ?",
            bind = listOf(Value(text = source.wire)),
            order = PageOrder(sort_column = "id", pk_column = "id"),
        )
        val answer = core.call(Envelope(request_id = 0, request = Request(page = PageRequest(query = query, limit = 1))))
        val page = (answer as? CoreOutcome.Answered)?.value?.response?.page ?: return null
        return page.rows.isNotEmpty()
    }
}
