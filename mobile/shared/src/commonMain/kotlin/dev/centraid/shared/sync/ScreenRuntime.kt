package dev.centraid.shared.sync

import centraid.core.v1.Command
import centraid.core.v1.Envelope
import centraid.core.v1.Intent
import centraid.core.v1.IntentStatus
import centraid.core.v1.PageCursor
import centraid.core.v1.PageQuery
import centraid.core.v1.PageRequest
import centraid.core.v1.Request
import centraid.core.v1.Row
import centraid.core.v1.SyncWindow
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.SeatState
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.shell.SEAT_BYTES_FETCH_COMMAND
import dev.centraid.shared.shell.boolField
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
 * ## The gate is not in here, and not in the reducer either
 *
 * [dev.centraid.shared.sync.WriteGate] decides send-now / enqueue / refuse, and
 * it decided it for nobody until this ran: it had tests, three verdicts and no
 * caller in the product, because `Request::Intent` refused on a seat and there
 * was nothing for it to gate. `ScreenEffect.SubmitWrite`'s own comment says why
 * the rule may not live in each screen — "a rule that lives in every reducer is
 * a rule one reducer will get wrong" — and `onlineOnly` is the case that makes
 * it matter: falling back to the outbox is exactly what that flag forbids.
 */
public interface ScreenWrites<S, E> {
    /**
     * This seat's state, as the screen is holding it.
     *
     * Read off the SCREEN and not off the session, because the screen's state
     * is what the member is looking at when they press the button — a gate that
     * consulted a fresher connectivity reading would refuse or queue on a fact
     * the screen never showed them.
     */
    public fun seat(state: S): SeatState?

    /** The app the write belongs to; `Intent.app_id`. */
    public val appId: String

    /**
     * The outcome, as this screen's own settle event.
     *
     * [sentence] is empty unless the core supplied one. Nothing here composes a
     * sentence out of an error: `Error.detail` is logs-only and a shell that
     * made its own from a peer's words would be the hole in that rule.
     */
    public fun settled(status: IntentStatus, sentence: String): E?
}

/**
 * A SCREEN THAT CAN ASK FOR ONE ORIGINAL (#1025 S5, D-1025-S7-63).
 *
 * Beside [ScreenWrites] and shaped like it, because it is the same kind of
 * thing: a member action this screen can take that is not a read. It is NOT a
 * write — nothing commits, there is no intent and no outbox entry — and it must
 * not go through the write gate, because a queued download is a promise nobody
 * can keep: the member wants the file now or wants to be told the gateway is
 * away.
 */
public interface ScreenFetches<E> {
    /**
     * The answer, as this screen's own event. Null for a screen that draws
     * nothing for it.
     *
     * [sentence] is the core's own, from its table of codes, and is empty when
     * there is nothing worth saying. Nothing here composes one: `Error.detail`
     * is logs-only and a shell that made a sentence out of a peer's words would
     * be the hole in that rule.
     */
    public fun fetchSettled(assetId: String, fetched: Boolean, sentence: String): E?
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
    /** Null for a screen with no download affordance. See [ScreenFetches]. */
    private val fetches: ScreenFetches<E>? = null,
    /**
     * The window a tapped fetch rides, from the shell's own policy.
     *
     * **The shell states the window, here as everywhere** (#1025 S2, S5): the
     * deadline is the OS's number and `metered`/`originals` are the radio's and
     * the member's. Neither can change this window's outcome — `Budget::only`
     * is checked before the rule is consulted at all (D-1025-S7-63) — so what
     * carrying them buys is an HONEST ECHO in the core's answer rather than a
     * decision. Null means the core's own default window, which is what a test
     * driving this class without a platform gets.
     */
    private val window: (suspend () -> SyncWindow)? = null,
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
            if (effect is ScreenEffect.FetchOriginal &&
                effect.screenId == reads.screenId &&
                fetches != null
            ) {
                // LAUNCHED, like a read and unlike nothing else here: a fetch
                // is a whole foreground window over a multi-megabyte file, and
                // a collector that awaited it would stop serving this screen's
                // reads for the length of a download.
                scope.launch { fetch(effect, fetches) }
            }
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
     * **The shell declares no payload hash** (#1025 S4, D-1025-S4-6). The field
     * is BLAKE3 over the canonical JSON, and neither CryptoKit nor
     * MessageDigest offers BLAKE3 — a shell that filled it would be filling it
     * with a different function's value under the vault's name, which is the
     * defect S4 closed at the staging door. It is left empty and the core
     * computes it, with the same canonicalisation the gateway rehashes with.
     *
     * `intent_id` IS the screen's `invokeKey`, which is content-derived rather
     * than ordinal (`NotesEditorMachine`: `"notes.save:<noteId>:<baseRevision>"`).
     * A retry of the same save carries the same id, so the gateway's replay
     * ledger short-circuits it; a save over a NEW base revision carries a
     * different one, so two real edits are two writes.
     */
    private suspend fun submit(write: ScreenEffect.SubmitWrite, writes: ScreenWrites<S, E>) {
        when (val verdict = WriteGate.verdict(write, writes.seat(host.state.value))) {
            is WriteGate.Verdict.Refuse -> {
                // REFUSED, AND SAID SO. Not queued and not silently dropped:
                // the member is told the write did not happen, with the
                // sentence that says why.
                writes.settled(IntentStatus.INTENT_STATUS_DENIED, verdict.sentence)
                    ?.let { host.send(it) }
                return
            }
            // The two go down the same door and differ in what the CORE does
            // with them, not in what this sends: a seat enqueues, a gateway
            // executes, and the answer's status is which happened. A shell that
            // branched here would be a second opinion about a decision the core
            // makes from its own role.
            WriteGate.Verdict.SendNow, WriteGate.Verdict.Enqueue -> Unit
        }
        val handle = core()
        if (handle == null) {
            writes.settled(
                IntentStatus.INTENT_STATUS_DENIED,
                "No vault is open on this device.",
            )?.let { host.send(it) }
            return
        }
        val request = Envelope(
            request_id = 0,
            request = Request(
                intent = Intent(
                    intent_id = write.invokeKey,
                    app_id = writes.appId,
                    action = write.command,
                    input = write.inputJson.encodeUtf8(),
                ),
            ),
        )
        val event = when (val outcome = handle.call(request)) {
            is CoreOutcome.Failed -> writes.settled(
                IntentStatus.INTENT_STATUS_FAILED,
                outcome.failure.sentence,
            )
            is CoreOutcome.Answered -> {
                val answered = outcome.value.response?.outcome
                if (answered == null) {
                    writes.settled(IntentStatus.INTENT_STATUS_FAILED, "")
                } else {
                    // THE CORE'S OWN SENTENCE, when it has one. `Outcome.reason`
                    // is the author's words for a denial or a failed
                    // precondition — never the raw predicate, which reaches the
                    // audit trail only.
                    writes.settled(answered.status, answered.reason)
                }
            }
        }
        event?.let { host.send(it) }
    }

    /**
     * FETCH ONE ORIGINAL THE MEMBER TAPPED (#1025 S5, D-1025-S7-63).
     *
     * `seat.bytes.fetch` — `seat.sync` with a one-item window — and NOT a
     * write: no gate, no intent, no outbox entry. A queued download is a
     * promise nobody can keep.
     *
     * **A settle event goes out on every path, the failures included.** The
     * success path's bytes redraw the cell through the ordinary `RowsChanged`
     * (D-1025-S7-21), so `fetched` is not what draws the photograph — what it
     * does is take the cell OUT of `HELD_FETCHING`, and a cell left spinning
     * because nobody said "it did not happen" is a state a member cannot get
     * out of.
     *
     * Every sentence is the CORE's, off `reason`, which the core makes from
     * its own closed table of codes. Nothing here composes one out of an
     * error: `Error.detail` is logs-only.
     */
    private suspend fun fetch(tap: ScreenEffect.FetchOriginal, fetches: ScreenFetches<E>) {
        val handle = core()
        if (handle == null) {
            fetches.fetchSettled(tap.assetId, false, "No vault is open on this device.")
                ?.let { host.send(it) }
            return
        }
        val request = Envelope(
            request_id = 0,
            request = Request(
                command = Command(
                    name = SEAT_BYTES_FETCH_COMMAND,
                    invoke_key = "shell",
                    // THE HASH ADDRESSES THE BYTES; the asset id is what a log
                    // line needs to say WHICH photograph was tapped, and what
                    // comes back names the cell to settle.
                    input = (
                        """{"contentHash":"${tap.contentHash}",""" +
                            """"ownerRef":"${tap.assetId}"}"""
                        ).encodeUtf8(),
                    sync_window = window?.invoke(),
                ),
            ),
        )
        val event = when (val outcome = handle.call(request)) {
            is CoreOutcome.Failed ->
                fetches.fetchSettled(tap.assetId, false, outcome.failure.sentence)
            is CoreOutcome.Answered -> {
                val answered = outcome.value.response?.command
                val fetched = answered?.output?.utf8()?.boolField("fetched") ?: false
                fetches.fetchSettled(tap.assetId, fetched, answered?.reason.orEmpty())
            }
        }
        event?.let { host.send(it) }
    }
}
