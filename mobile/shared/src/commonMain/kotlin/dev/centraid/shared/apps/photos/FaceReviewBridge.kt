package dev.centraid.shared.apps.photos

import centraid.core.v1.Command
import centraid.core.v1.CommandStatus
import centraid.core.v1.Envelope
import centraid.core.v1.Request
import centraid.core.v1.Row
import centraid.screen.v1.FaceReviewEvent
import centraid.screen.v1.FaceReviewState
import dev.centraid.core.CoreOutcome
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.shell.Shelf
import dev.centraid.shared.sync.ScreenRuntime
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import okio.ByteString.Companion.encodeUtf8

/**
 * What SwiftUI holds instead of the face queue's `StateFlow`, AND the runtime
 * that composes its two reads (#1029, photos port, lane L5).
 *
 * `PhotosBridge`'s shape for the boundary half: bytes and not objects, so one
 * fixture proves both shells; and not `suspend`, because a SwiftUI button
 * cannot await and a view that could await a reducer would hold the main thread
 * while a screen thinks. Android does not use this — Compose collects [host]'s
 * `StateFlow` directly.
 *
 * ## WHY THIS BRIDGE SERVES ITS OWN READS
 *
 * The queue is `media_face_region` and the picker's roster is `core_party`; the
 * page door has no join, and `ScreenRuntime` serves one `ScreenReads` under one
 * screen id. The two answers cannot be chained through the reducer either,
 * because `FaceReviewState`'s content is a protobuf `oneof` and there is
 * nowhere to park one while the other is in flight. So the fan-out lives here,
 * which is `HomeRuntime`'s design and its documented reason for existing; the
 * statements and the folds stay in `FaceReviewReads`, where they are provable
 * on a machine with no vault.
 *
 * FOUR LEGS, AND THEY ARE NOT ALL THE SAME KIND. The tier and the roster and
 * the queue are what the screen IS, and a refusal from any of them refuses the
 * screen. The thumbnails are an AMENDMENT: they arrive after the page, on their
 * own event arm, and a refusal there leaves questions unanswered rather than
 * taking down a queue the member could otherwise work through.
 */
public class FaceReviewBridge {
    public val host: ScreenHost<FaceReviewState, FaceReviewEvent> = ScreenHost(FaceReviewMachine)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var onState: ((ByteArray) -> Unit)? = null

    /**
     * Put this screen on the session, and start publishing.
     *
     * `changes.route` is called exactly ONCE — the route list appends, and a
     * host routed twice re-reads the screen twice on every commit.
     */
    public fun attach(session: HomeSession) {
        session.changes.route(host)
        // UNDISPATCHED. `ScreenHost.effects` is a `SharedFlow` with `replay = 0`
        // and one with no subscriber DROPS what is emitted, so a plain `launch`
        // would let the screen's first `ReadPage` race the dispatcher and be
        // lost on the runs it won (`ScreenRuntime.start`).
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            host.effects.collect { effect ->
                when {
                    effect is ScreenEffect.ReadPage &&
                        effect.screenId == FaceReviewMachine.SCREEN_ID ->
                        scope.launch { serve(session, effect.afterCursor) }

                    effect is ScreenEffect.SubmitWrite -> scope.launch { submit(session, effect) }

                    else -> Unit
                }
            }
        }
        scope.launch { host.state.collect { state -> onState?.invoke(state.encode()) } }
    }

    /**
     * THE ROSTER AND THE QUEUE, AND THE ONE PAGE THEY MAKE.
     *
     * The roster goes first and it is not an optimisation: it is the book that
     * gives the model's guess a name, so a queue folded without it would draw
     * "is this …?" with nothing after it. A refusal from EITHER ends the trip —
     * a queue of questions with no roster behind it is a picker that cannot
     * offer a single person, which is not half a screen but a different one.
     */
    private suspend fun serve(session: HomeSession, afterCursor: String?) {
        val core = session.shelf.core()
        // IS THE PLANE ON AT ALL? First, and FATAL when it refuses — because
        // `recognition_enabled` is a boolean and a boolean has no third arm for
        // "we could not ask". Drawing "recognition is off" over a vault nobody
        // asked about would be the exact lie `enrichment.rs` keeps a
        // three-armed `Reading` to prevent, so the screen refuses instead and
        // the flag is only ever read after this leg answered.
        val policy = core.photosPage(PhotosPeopleReads.policyQuery(), limit = 1)
        if (policy is PhotosPage.Refused) {
            host.send(FaceReviewReads.refused(policy.failure))
            return
        }
        host.send(FaceReviewReads.recognition((policy as PhotosPage.Rows).rows))

        val parties = core.photosPage(
            FaceReviewReads.partiesQuery(),
            limit = FaceReviewReads.PARTY_LIMIT,
        )
        if (parties is PhotosPage.Refused) {
            host.send(FaceReviewReads.refused(parties.failure))
            return
        }
        val queue = core.photosPage(
            FaceReviewReads.queueQuery(),
            limit = FaceReviewReads.QUEUE_LIMIT,
            after = ScreenRuntime.decodeCursor(afterCursor),
        )
        if (queue is PhotosPage.Refused) {
            host.send(FaceReviewReads.refused(queue.failure))
            return
        }
        val rows = (queue as PhotosPage.Rows).rows
        host.send(
            FaceReviewReads.arrived(
                FaceReviewReads.fold(
                    partyRows = (parties as PhotosPage.Rows).rows,
                    queueRows = rows,
                    nextCursor = queue.nextCursor,
                ),
            ),
        )
        // THE PHOTOGRAPHS, AFTER THE QUESTIONS.
        //
        // **Sent second on purpose.** The page is what the member can act on
        // and it is drawable without pictures; making them wait for a second
        // trip before the first question appears would hold a screen for an
        // amendment. `ThumbnailsArrived` then paints onto candidates that are
        // already there.
        //
        // A REFUSAL HERE SENDS NOTHING, which is not silence: the proto's rule
        // is that an asset missing from the map is an UNANSWERED question, and
        // a leg that could not run answered none of them. An empty map would
        // say the same thing more slowly.
        thumbnails(session, rows)
    }

    /**
     * The asset leg, keyed on the page's own asset ids.
     *
     * The ids come off the ROWS rather than off the state, because the state
     * the `DataArrived` above produced may not have been reduced yet — and the
     * rows are what this trip is about either way.
     */
    private suspend fun thumbnails(session: HomeSession, queueRows: List<Row>) {
        val assetIds = queueRows.mapNotNull { row -> row.values.getOrNull(1)?.text }
            .filter { it.isNotEmpty() }
            .distinct()
        val query = FaceReviewReads.thumbnailsQuery(assetIds) ?: return
        val assets = session.shelf.core().photosPage(query, limit = assetIds.size)
        if (assets is PhotosPage.Rows) host.send(FaceReviewReads.thumbnails(assets.rows))
    }

    /**
     * An answer, or the person a face is being named as, down the same door.
     *
     * A FROZEN VAULT REFUSES AND SAYS SO (#1029 F1), read at the moment of the
     * write and not at attach: the shelf can freeze a vault while a member is
     * mid-answer, and a value captured earlier would let the next tap write to
     * a vault that had moved a minute ago.
     */
    private suspend fun submit(session: HomeSession, write: ScreenEffect.SubmitWrite) {
        // WHICH QUESTION THIS WAS ABOUT. `ScreenWrites.settled` is
        // `(status, sentence)` for every screen, so the region rides the write's
        // own `invoke_key` — whose shape the machine owns and reads back.
        // Without it a refusal would have to assume the answer in flight was
        // the one on screen, and assuming wrong advances the cursor past a face
        // whose answer was dropped.
        val region = FaceReviewMachine.regionOfInvokeKey(write.invokeKey)
        if (session.shelf.foregroundHolding()?.readOnly == true) {
            host.send(
                FaceReviewReads.settledFor(
                    CommandStatus.COMMAND_STATUS_DENIED,
                    Shelf.MOVED_SENTENCE,
                    region,
                ),
            )
            return
        }
        val handle = session.shelf.core()
        if (handle == null) {
            host.send(
                FaceReviewReads.settledFor(
                    CommandStatus.COMMAND_STATUS_DENIED,
                    "No vault is open on this device.",
                    region,
                ),
            )
            return
        }
        val outcome = handle.call(
            Envelope(
                request_id = 0,
                request = Request(
                    command = Command(
                        name = write.command,
                        invoke_key = write.invokeKey,
                        input = write.inputJson.encodeUtf8(),
                    ),
                ),
            ),
        )
        val event = when (outcome) {
            is CoreOutcome.Failed ->
                FaceReviewReads.settledFor(
                    CommandStatus.COMMAND_STATUS_FAILED,
                    outcome.failure.sentence,
                    region,
                )

            is CoreOutcome.Answered -> {
                val answered = outcome.value.response?.command
                if (answered == null) {
                    FaceReviewReads.settledFor(CommandStatus.COMMAND_STATUS_FAILED, "", region)
                } else {
                    // THE CORE'S OWN SENTENCE, when it has one.
                    // `CommandOutcome.reason` is the author's words for a denial
                    // or a failed precondition — never the raw predicate, which
                    // reaches the audit trail only.
                    //
                    // A NEW PERSON'S ID IS HANDED BACK, so the confirm that
                    // needs it follows in the same breath (`PersonCreated`).
                    // `core.add_party` answers it in `CommandOutcome.output`;
                    // when it is not there the settle goes as before and the
                    // member finishes with a tap on the re-read roster.
                    val created = if (
                        write.command == FaceReviewMachine.CREATE_PERSON_COMMAND &&
                        answered.status == CommandStatus.COMMAND_STATUS_EXECUTED
                    ) {
                        partyIdOf(answered.output.utf8())
                    } else {
                        ""
                    }
                    if (created.isNotEmpty()) {
                        FaceReviewEvent(
                            person_created = FaceReviewEvent.PersonCreated(
                                region_id = region,
                                party_id = created,
                            ),
                        )
                    } else {
                        FaceReviewReads.settledFor(answered.status, answered.reason, region)
                    }
                }
            }
        }
        host.send(event)
    }

    /**
     * `party_id` out of `core.add_party`'s answer, or empty.
     *
     * The answer is canonical JSON the vault wrote — `{"party_id": "…", …}` —
     * and a party id is a slug with nothing in it to escape, so this reads the
     * one string value rather than carrying a JSON library into `commonMain`
     * for one field. Anything it cannot read answers empty, which is the
     * two-tap path and never a confirm against a guessed id.
     */
    internal fun partyIdOf(output: String): String {
        val key = output.indexOf("\"party_id\"")
        if (key < 0) return ""
        val colon = output.indexOf(':', key)
        if (colon < 0) return ""
        val open = output.indexOf('"', colon + 1)
        if (open < 0 || output.substring(colon + 1, open).isNotBlank()) return ""
        val close = output.indexOf('"', open + 1)
        if (close < 0) return ""
        val id = output.substring(open + 1, close)
        return if (id.contains('\\')) "" else id
    }

    /** The face queue is on screen. */
    public fun opened() {
        scope.launch { host.send(FaceReviewEvent(opened = FaceReviewEvent.Opened())) }
    }

    /** Publish every state to [onState], starting with the current one. */
    public fun observe(onState: (ByteArray) -> Unit) {
        this.onState = onState
        onState(host.state.value.encode())
    }

    /** Forward one encoded event. */
    public fun send(event: ByteArray) {
        scope.launch { host.send(FaceReviewEvent.ADAPTER.decode(event)) }
    }

    /** The current state, for a view that needs one before it subscribes. */
    public fun current(): ByteArray = host.state.value.encode()

    /** Release the scope. A screen that is gone reduces nothing. */
    public fun close() {
        scope.cancel()
    }
}
