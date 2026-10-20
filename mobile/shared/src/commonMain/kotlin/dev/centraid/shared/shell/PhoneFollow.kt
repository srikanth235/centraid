package dev.centraid.shared.shell

import dev.centraid.shared.apps.agenda.PhoneEvent
import dev.centraid.shared.apps.people.PhoneContact
import dev.centraid.shared.sync.phone.FollowGate
import dev.centraid.shared.sync.phone.FollowStep
import dev.centraid.shared.sync.phone.OriginGone
import dev.centraid.shared.sync.phone.PhoneOriginRef
import dev.centraid.shared.sync.phone.PhoneSource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

/** WHAT THE SHELL READ OF THE ADDRESS BOOK for a following pass: [ContactsImportBridge.sync]'s arguments. */
public data class ContactsRead(
    public val contacts: List<PhoneContact>,
    public val origins: List<PhoneOriginRef>,
    public val complete: Boolean,
)

/** WHAT THE SHELL READ OF THE CALENDARS for a following pass: [CalendarImportBridge.sync]'s arguments. */
public data class CalendarRead(
    public val events: List<PhoneEvent>,
    public val origins: List<PhoneOriginRef>,
    public val complete: Boolean,
    public val deviceTz: String,
    public val now: Long,
)

/**
 * THE QUESTION AN ORIGIN HELD FOR THE MEMBER LEAVES (R-1127-9), every word already chosen: the
 * shell draws [title], [body] and two buttons and calls [PhoneFollowBridge.answer]. **[keepLabel]
 * is the default and the one drawn bold**; a dismissal that is not a button is a Keep too.
 */
public data class PhoneFollowQuestion(
    public val source: PhoneSource,
    public val originId: String,
    public val title: String,
    public val body: String,
    public val keepLabel: String,
    public val trashLabel: String,
)

/**
 * WHAT THE SHELL GIVES A FOLLOWING PASS: the phone read, and a place to ask the member. Both are
 * called on the follower's thread and may answer from any other.
 */
public interface PhoneFollowShell {
    /**
     * Read the address book and hand it to [done], off the main thread; **null when contacts
     * access is not already granted**: a pass never asks the OS for permission.
     */
    public fun readContacts(done: (ContactsRead?) -> Unit)

    /** As [readContacts], for the calendars: null unless full access is already granted. */
    public fun readCalendar(done: (CalendarRead?) -> Unit)

    /** Show [question]. The next one is offered only after [PhoneFollowBridge.answer] for this one. */
    public fun ask(question: PhoneFollowQuestion)
}

/** One read of the phone, whichever source. */
internal sealed interface PhoneRead {
    data class Contacts(val read: ContactsRead) : PhoneRead

    data class Calendar(val read: CalendarRead) : PhoneRead
}

/** What one following pass wrote and holds. */
internal data class FollowOutcome(val gone: List<OriginGone>)

/** THE VAULT, AS A FOLLOWING PASS SEES IT. [CoreFollowVault] is the real one; the specs bring their own. */
internal interface FollowVault {
    /** Whether the member imported [source]: the vault holds a `phone_origin` for it. Null when unreadable. */
    suspend fun imported(source: PhoneSource): Boolean?

    /** One pass over [read]; null when the vault would not take it. */
    suspend fun sync(read: PhoneRead): FollowOutcome?

    /** The member's answer to [gone]. */
    suspend fun resolve(gone: OriginGone, keep: Boolean)
}

/**
 * THE FOLLOWER: TRIGGERS IN, ONE PASS AT A TIME, QUESTIONS OUT (#1127).
 *
 * A trigger ([requested]) goes through [FollowGate]; when the gate says go, the pass:
 * 1. stops unless the member imported the source ([FollowVault.imported]): **a foreground pass
 *    never imports into a vault that never tapped Import**;
 * 2. asks the shell to read the phone, and stops if it answers null (access not already granted);
 * 3. runs the engine, and offers each origin it holds to the member, one question at a time.
 *
 * A question already open or waiting is not asked again when a later pass holds the same origin.
 * Everything runs on [scope]'s one thread, so none of this is locked.
 */
internal class PhoneFollower(
    private val scope: CoroutineScope,
    private val vault: FollowVault,
    private val shell: PhoneFollowShell,
    private val now: () -> Long,
    settleMs: Long = FollowGate.SETTLE_MS,
    private val readTimeoutMs: Long = READ_TIMEOUT_MS,
) {
    private val gate = FollowGate(settleMs)
    private val waiting = ArrayDeque<OriginGone>()
    private var open: OriginGone? = null
    private var answering = false

    /** A change on the phone, or the app coming forward: follow [source] soon. */
    fun requested(source: PhoneSource) {
        val step = gate.request(source, now())
        if (step is FollowStep.Arm) {
            scope.launch {
                delay(step.delayMs)
                if (gate.fire(source, now()) is FollowStep.Start) run(source)
            }
        }
    }

    /** The member answered the question [open] holds; a stale answer (another vault's, a second tap) is ignored. */
    fun answer(originId: String, keep: Boolean) {
        val gone = open?.takeIf { it.originId == originId && !answering } ?: return
        answering = true
        scope.launch {
            vault.resolve(gone, keep)
            // Open until the answer is written, so a pass meanwhile does not ask the same thing again.
            open = null
            answering = false
            offerNext()
        }
    }

    private suspend fun run(source: PhoneSource) {
        do {
            try {
                pass(source)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (@Suppress("TooGenericExceptionCaught") failed: Exception) {
                // A pass that fails is a pass that did nothing; the next trigger tries again.
            }
        } while (gate.finish(source) is FollowStep.Start)
    }

    private suspend fun pass(source: PhoneSource) {
        if (vault.imported(source) != true) return
        val read = withTimeoutOrNull(readTimeoutMs) { read(source) } ?: return
        val outcome = vault.sync(read) ?: return
        hold(source, outcome.gone)
    }

    private suspend fun read(source: PhoneSource): PhoneRead? = suspendCancellableCoroutine { next ->
        when (source) {
            PhoneSource.CONTACTS -> shell.readContacts { next.resume(it?.let(PhoneRead::Contacts)) }
            PhoneSource.CALENDAR -> shell.readCalendar { next.resume(it?.let(PhoneRead::Calendar)) }
            PhoneSource.FILES -> next.resume(null)
        }
    }

    private fun hold(source: PhoneSource, gone: List<OriginGone>) {
        // A queued question whose origin this pass no longer holds (it came back) is withdrawn.
        waiting.removeAll { it.source == source && gone.none { held -> held.originId == it.originId } }
        for (item in gone) {
            if (item.originId == open?.originId || waiting.any { it.originId == item.originId }) continue
            waiting.addLast(item)
        }
        offerNext()
    }

    private fun offerNext() {
        if (open != null) return
        val next = waiting.removeFirstOrNull() ?: return
        open = next
        shell.ask(PhoneFollowWords.question(next))
    }

    companion object {
        /** A read that has not answered in two minutes is abandoned, so one stuck read cannot hold the source for good. */
        const val READ_TIMEOUT_MS: Long = 120_000
    }
}
