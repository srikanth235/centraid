package dev.centraid.shared.sync

import centraid.core.v1.Command
import centraid.core.v1.CommandStatus
import centraid.core.v1.Envelope
import centraid.core.v1.PageCursor
import centraid.core.v1.PageQuery
import centraid.core.v1.PageRequest
import centraid.core.v1.Request
import centraid.core.v1.Row
import centraid.screen.v1.ReadFailure
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenHost
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import okio.ByteString.Companion.encodeUtf8

/**
 * WHAT ONE APP SCREEN READS (#1025 S5, lane L5).
 *
 * `HomeReads` is the same idea for Home and it is not this interface, because
 * Home is not the general case: it fans out one read PER APP and turns seven
 * independent answers into seven tiles. An app screen reads one thing and makes
 * one state of it, and that is what a screen runtime can serve without knowing
 * which screen it is serving.
 *
 * **[table] is declared here so it can be checked against the machine.**
 * [dev.centraid.shared.screen.ScreenMachine.rowsChanged] already names the
 * table a screen re-reads ON, and this names the table it reads FROM. They must
 * be the same table, and the defect when they are not is silent: a screen whose
 * query moved stops moving on sync, nothing fails, and the symptom is a list
 * that is right only after a relaunch. `AppReadsSpec` asserts the pairing
 * mechanically for all three screens.
 */
public interface ScreenReads<S, E> {
    /** The `screenId` this screen's `ReadPage` effects carry. */
    public val screenId: String

    /** The table [query] reads, and the one the machine's `rowsChanged` names. */
    public val table: String

    /** The page ceiling. A read returns rows; there is no `COUNT(*)` on this door. */
    public val limit: Int

    /**
     * The statement for this read, or null when the screen cannot yet say what
     * to read.
     *
     * [state] is passed because a read can be PARAMETERISED by what the screen
     * is already holding — the Notes editor reads one note and that note's id
     * lives in its state, having arrived with `Opened`. Depending on it is safe
     * because `ScreenHost` publishes the state BEFORE it emits the effects of
     * the same reduce, which is the ordering its own comment pins.
     */
    public fun query(state: S, afterCursor: String?): PageQuery?

    /** The rows, as this screen's `DataArrived`. [nextCursor] is null at the end. */
    public fun arrived(rows: List<Row>, nextCursor: String?): E

    /** The refusal, as this screen's `ReadRefused`. */
    public fun refused(failure: ReadFailure): E
}

/**
 * WHAT ONE APP SCREEN WRITES (#1025 S5).
 *
 * Implemented only by screens that have a write. Tally and Photos have none
 * yet, and `null` on the runtime is how that is said — an interface every
 * screen had to implement with a stub would be four stubs standing for "this
 * screen does not write", which is a thing an absence already says.
 *
 * ## THERE IS NO GATE ANY MORE, BECAUSE THERE IS NOWHERE ELSE FOR A WRITE TO GO
 *
 * `WriteGate` chose between send-now, the durable outbox and a refusal, and all
 * three were answers to "can this device reach its gateway right now". The
 * phone is the vault (#1029 §1): a write commits here or it does not commit,
 * and there is no second destination to route it to. The gate, the `seat(state)`
 * reading it consulted and `SubmitWrite.onlineOnly` all leave with the plane
 * they were choosing between.
 */
public interface ScreenWrites<S, E> {
    /**
     * The app the write belongs to.
     *
     * It was `Intent.app_id`, and `Command` carries no such field: a command is
     * registered under a name the vault holds and the app is that name's first
     * segment (`notes.save`). It stays because a log line still has to say which
     * app wrote, and deriving it from the command name would be a second
     * spelling of a fact the screen already knows.
     */
    public val appId: String

    /**
     * The outcome, as this screen's own settle event.
     *
     * [sentence] is empty unless the core supplied one. Nothing here composes a
     * sentence out of an error: `Error.detail` is logs-only and a shell that
     * made its own from a peer's words would be the hole in that rule.
     */
    public fun settled(status: CommandStatus, sentence: String): E?
}

/**
 * THE EFFECT RUNNER FOR ANY ONE SCREEN (#1025 S5, lane L5).
 *
 * ## The gap this closes
 *
 * `TallyListMachine`, `PhotosGridMachine` and `NotesEditorMachine` have emitted
 * `ScreenEffect.ReadPage` since #1020 and **nothing served it** — there was no
 * per-screen query, no runner and no bridge, on either shell. Home alone was
 * wired, through `shell/HomeRuntime.kt`. So all three app screens drew their
 * seeded `LOADING` state for ever against a real vault, and a member could not
 * tell that from a vault that had not synced.
 *
 * ## Why it is not `HomeRuntime` with a parameter
 *
 * [dev.centraid.shared.shell.HomeRuntime] is Home-shaped in two ways that do
 * not generalise: it fans out one read per app, and it makes a batched trip
 * through the byte door for the mosaic's thumbnails before the tile is sent.
 * Generalising it would mean an app-shaped runtime carrying a Home-shaped
 * branch. What the two genuinely share is the FAILURE MAPPING, and that is
 * exactly what moved to `ReadFailures.kt` rather than being copied.
 *
 * ## Where it lives, and why not `screen/`
 *
 * `screen` is the CONTRACT and `PerAppLayoutSpec` pins it to two files — the
 * machine and the host — because "nothing outside `apps` reaches into one" is
 * only meaningful if what a shell may name is a small, fixed surface. A runtime
 * that holds a `CentraidCore` is not a contract. `sync` is where the other
 * thing that carries vault movement into a screen already lives
 * ([ChangeStream]), and the two are a pair: this serves what a screen ASKED
 * for, that delivers what arrived without being asked.
 *
 * ## It names no app type
 *
 * Every screen-specific decision — the statement, the projection, the event —
 * is [ScreenReads], which each app implements in its own package. That is what
 * keeps this file inside the second Konsist rule: a runtime that mentioned
 * `TallyListState` would be a runtime that has to be edited to add an app.
 *
 * ## The core is a SUPPLIER, not a handle
 *
 * [core] is read at the moment of each read rather than captured once, because
 * a vault switch closes one core and opens another and only the session knows
 * when. A runtime holding the old handle would answer every read for the rest
 * of the process with `CoreFailure.Closed`. The narrow race that remains is
 * stated rather than hidden: a read already in flight when a switch closes its
 * core lands as `CORE_RESTARTED` on a screen of a vault the member has left,
 * and the screen's next open corrects it.
 */
public class ScreenRuntime<S, E>(
    private val core: () -> CentraidCore?,
    private val host: ScreenHost<S, E>,
    private val reads: ScreenReads<S, E>,
    private val scope: CoroutineScope,
    /** Null for a screen with no write. See [ScreenWrites]. */
    private val writes: ScreenWrites<S, E>? = null,
) {
    /**
     * Collect this host's effects and serve the ones that are this screen's.
     *
     * Every other effect is ignored rather than failed, for `HomeRuntime`'s
     * reason: a runner that threw on an effect it does not own would take the
     * screen down over somebody else's business. Several runtimes collect the
     * same `SharedFlow` and each sees every effect.
     *
     * The read is LAUNCHED rather than awaited inside the collector, so a slow
     * page does not hold up the next effect — a member who taps refresh while a
     * first page is in flight must not be ignored.
     */
    public fun start(): Job = scope.launch {
        host.effects.collect { effect ->
            if (effect is ScreenEffect.ReadPage && effect.screenId == reads.screenId) {
                scope.launch { serve(effect.afterCursor) }
            }
            if (effect is ScreenEffect.SubmitWrite && writes != null) {
                scope.launch { submit(effect, writes) }
            }
            // `ScreenEffect.FetchOriginal` IS NOT SERVED HERE ANY MORE
            // (#1029 §1). It rode `seat.bytes.fetch` — `seat.sync` with a
            // one-item window — and `grep -rn 'seat.bytes.fetch' crates/` is
            // now empty: the command left with the seat plane. The affordance
            // stays on the Photos grid and the effect stays in the contract;
            // what serves it is the phone's own byte plane, which #1029 W6
            // builds.
        }
    }
    private suspend fun serve(afterCursor: String?) {
        val query = reads.query(host.state.value, afterCursor)
        if (query == null) {
            // NOT SILENCE. A screen that asked for a read and got no event sits
            // on its loading state for ever, which is the exact defect this
            // file exists to close — so a screen that cannot say what to read
            // is told so, and draws a sentence.
            host.send(reads.refused(Reads.refused("Centraid does not know what to read here.")))
            return
        }
        val handle = core()
        if (handle == null) {
            // NO VAULT IS NOT A CRASH, and not an empty list either: a device
            // before its first pairing has not learned that it holds nothing.
            host.send(reads.refused(Reads.refused("No vault is open on this device.")))
            return
        }
        val request = Envelope(
            request_id = 0,
            request = Request(
                page = PageRequest(
                    query = query,
                    limit = reads.limit,
                    after = decodeCursor(afterCursor),
                ),
            ),
        )
        val event = when (val outcome = handle.call(request)) {
            is CoreOutcome.Failed -> reads.refused(fromCore(outcome.failure))
            is CoreOutcome.Answered -> {
                val page = outcome.value.response?.page
                val error = outcome.value.error
                when {
                    page != null -> reads.arrived(page.rows, page.next?.let(::encodeCursor))
                    // `Error.detail` IS FOR LOGS AND NEVER FOR A MEMBER. It
                    // carries whatever the failing layer said, including a
                    // SQLite `RAISE(ABORT)`, and one reached a member's screen
                    // through exactly this field in #1020 wave 3 (lane E,
                    // finding 2). The code chooses the sentence.
                    error != null -> reads.refused(sentenceFor(error.code))
                    else -> reads.refused(
                        Reads.refused("The vault answered with neither a page nor a reason."),
                    )
                }
            }
        }
        host.send(event)
    }

    /**
     * THE KEYSET CURSOR, AS THE ONE STRING A SCREEN CARRIES.
     *
     * `centraid.core.v1.PageCursor` is a PAIR — the sort key and the primary
     * key — because a keyset walk needs both, and every screen's `next_cursor`
     * is a single `string`. So the pair is spelled with a separator here.
     *
     * `ChangeStream.textKeyOf` refuses to do this for a RECORD key and says
     * why: a record key is compared against ids a screen is holding, and an
     * invented spelling would match nothing. **This is the opposite case.** A
     * page cursor is OPAQUE: minted by this runtime, handed to a screen, handed
     * back to this runtime, and never compared to anything.
     *
     * **THE SPELLING IS THE FIXTURES', NOT A NEW ONE.** `contracts/screens`'
     * `tally/data-page` carries a `next_cursor` and `ScreenFixtureSpec` asserts
     * it contains a `|` — so the pipe is already this product's written-down
     * answer to "how does a keyset pair ride as one string", and a second
     * spelling here would make the fixture a fixture of nothing. It cannot
     * occur in the TEXT keys these tables use, which are ids and RFC 3339
     * timestamps. A string without it is not a cursor this runtime wrote, so it
     * is dropped rather than guessed at — which starts the walk again rather
     * than silently repeating a page under a mangled key.
     *
     * Both halves are `internal` on the companion because the round trip is the
     * only part of this class testable without an ABI.
     */
    internal companion object {
        /** The fixtures' own separator. See above. */
        internal const val SEPARATOR: Char = '|'

        internal fun encodeCursor(cursor: PageCursor): String =
            cursor.sort_key + SEPARATOR + cursor.pk

        internal fun decodeCursor(encoded: String?): PageCursor? {
            if (encoded == null) return null
            val at = encoded.indexOf(SEPARATOR)
            if (at < 0) return null
            return PageCursor(sort_key = encoded.substring(0, at), pk = encoded.substring(at + 1))
        }
    }

    /**
     * Serve one write: gate it, then hand it to the core.
     *
     * ## A WRITE IS A COMMAND, AND THERE IS NO INTENT (#1029 §1, §6)
     *
     * This sent `Request::Intent` — a write QUEUED for a gateway to run, with a
     * payload hash the gateway rehashed and a `needs` list it pulled bytes on.
     * There is no gateway. The phone is the vault, so the write it makes IS the
     * commit: `Request::Command` down the same door, answered by the
     * `CommandOutcome` the handler produced. `intent.proto` is deleted and the
     * envelope's arm 4 is retired, not reused.
     *
     * `invoke_key` IS the screen's `invokeKey`, which is content-derived rather
     * than ordinal (`NotesEditorMachine`: `"notes.save:<noteId>:<baseRevision>"`).
     * It kept a replayed intent from re-executing a command that had already
     * committed, and it does exactly that here — `command.proto` calls the field
     * required for that reason.
     */
    private suspend fun submit(write: ScreenEffect.SubmitWrite, writes: ScreenWrites<S, E>) {
        val handle = core()
        if (handle == null) {
            writes.settled(
                CommandStatus.COMMAND_STATUS_DENIED,
                "No vault is open on this device.",
            )?.let { host.send(it) }
            return
        }
        val request = Envelope(
            request_id = 0,
            request = Request(
                command = Command(
                    name = write.command,
                    invoke_key = write.invokeKey,
                    input = write.inputJson.encodeUtf8(),
                ),
            ),
        )
        val event = when (val outcome = handle.call(request)) {
            is CoreOutcome.Failed -> writes.settled(
                CommandStatus.COMMAND_STATUS_FAILED,
                outcome.failure.sentence,
            )
            is CoreOutcome.Answered -> {
                val answered = outcome.value.response?.command
                if (answered == null) {
                    writes.settled(CommandStatus.COMMAND_STATUS_FAILED, "")
                } else {
                    // THE CORE'S OWN SENTENCE, when it has one.
                    // `CommandOutcome.reason` is the author's words for a denial
                    // or a failed precondition — never the raw predicate, which
                    // reaches the audit trail only.
                    writes.settled(answered.status, answered.reason)
                }
            }
        }
        event?.let { host.send(it) }
    }
}
