package dev.centraid.shared.apps.photos

import centraid.core.v1.Command
import centraid.core.v1.CommandStatus
import centraid.core.v1.Envelope
import centraid.core.v1.Request
import centraid.screen.v1.PhotosPeopleEvent
import centraid.screen.v1.PhotosPeopleState
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
 * What SwiftUI holds instead of the People screen's `StateFlow`, AND the
 * runtime that composes its three reads (#1029, photos port, lane L5).
 *
 * `PhotosBridge`'s shape for the boundary half, and both of its rules are
 * load-bearing:
 *
 * * **BYTES, NOT OBJECTS.** The state crosses as an encoded `PhotosPeopleState`
 *   and the event arrives as an encoded `PhotosPeopleEvent`; Swift decodes it
 *   with SwiftProtobuf from the same schema Wire reads here, so one fixture
 *   proves both sides.
 * * **NOT `suspend`.** A SwiftUI button cannot await, and a view that could
 *   await a reducer would hold the main thread while a screen thinks.
 *
 * Android does NOT use this: Compose collects [host]'s `StateFlow` directly.
 *
 * ## WHY THIS BRIDGE SERVES ITS OWN READS
 *
 * `ScreenRuntime` serves ONE `ScreenReads` — one table, one statement — and
 * this screen reads three: `media_face_region`, `core_party` and
 * `enrich_policy`. The three answers cannot be chained through the reducer
 * because `PhotosPeopleState`'s content is a protobuf `oneof`, so there is
 * nowhere to hold two of them while the third is in flight; Wire refuses the
 * state outright. So the composition happens here, which is what
 * `HomeRuntime` already does and says it exists for: "it fans out one read per
 * app and turns seven independent answers into seven tiles".
 *
 * Everything about those reads that is DATA — the statements and the fold —
 * stays in `PhotosPeopleReads`, so all of it is provable on a machine with no
 * vault. What is here is the trip.
 */
public class PhotosPeopleBridge {
    /**
     * The host, exposed because Android drives it directly.
     *
     * One per bridge and never re-created: `ChangeStream.route` registers a
     * host for the life of the session, so a second host would leave the routed
     * one drawing into nothing.
     */
    public val host: ScreenHost<PhotosPeopleState, PhotosPeopleEvent> =
        ScreenHost(PhotosPeopleMachine)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var onState: ((ByteArray) -> Unit)? = null

    /**
     * Put this screen on the session, and start publishing.
     *
     * `changes.route` and not `attachScreen`: the latter builds a
     * `ScreenRuntime` over a `ScreenReads` this screen does not have. Routing
     * is the separate fact — it is what carries a row change into the reducer —
     * and it is called exactly ONCE, because the route list appends and a host
     * routed twice re-reads the screen twice on every commit.
     */
    public fun attach(session: HomeSession) {
        session.changes.route(host)
        // UNDISPATCHED, AND IT IS THE WHOLE CORRECTNESS OF THE SCREEN.
        // `ScreenHost.effects` is a `SharedFlow` with `replay = 0`, and one
        // with no subscriber DROPS what is emitted. A plain `launch` only
        // SCHEDULES this collector, so the screen's first `ReadPage` — emitted
        // a line later by the event that opens it — would race the dispatcher
        // and be lost on the runs it won. See `ScreenRuntime.start`, which is
        // the same rule and the tile grid that sat LOADING for ever when it was
        // broken.
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            host.effects.collect { effect ->
                when {
                    effect is ScreenEffect.ReadPage &&
                        effect.screenId == PhotosPeopleMachine.SCREEN_ID ->
                        // LAUNCHED rather than awaited inside the collector, so
                        // a slow page does not hold up the next effect.
                        scope.launch { serve(session, effect.afterCursor) }

                    effect is ScreenEffect.SubmitWrite -> scope.launch { submit(session, effect) }

                    // Every other effect is IGNORED rather than failed, for
                    // `HomeRuntime`'s reason: a runner that threw on somebody
                    // else's business would take this screen down over it.
                    else -> Unit
                }
            }
        }
        scope.launch { host.state.collect { state -> onState?.invoke(state.encode()) } }
    }

    /**
     * THE THREE READS, AND THE ONE SCREEN THEY MAKE.
     *
     * Order is not load-bearing — nothing here feeds anything else's
     * predicate — but a REFUSAL is: the first one that refuses ends the trip
     * and the screen draws a sentence. A half-composed People list is the
     * fourth state the read law forbids, and "Ada, 0 photographs" would be a
     * worse lie than "Centraid could not read this".
     *
     * The policy and the parties are re-read on a CONTINUED page too. They are
     * one row and one page, the file is local, and the alternative is caching a
     * name book on a state that has no field for one.
     */
    private suspend fun serve(session: HomeSession, afterCursor: String?) {
        val core = session.shelf.core()
        val policy = core.photosPage(PhotosPeopleReads.policyQuery(), limit = 1)
        if (policy is PhotosPage.Refused) {
            host.send(PhotosPeopleReads.refused(policy.failure))
            return
        }
        val parties = core.photosPage(
            PhotosPeopleReads.partiesQuery(),
            limit = PhotosPeopleReads.PARTY_LIMIT,
        )
        if (parties is PhotosPage.Refused) {
            host.send(PhotosPeopleReads.refused(parties.failure))
            return
        }
        val regions = core.photosPage(
            PhotosPeopleReads.regionsQuery(),
            limit = PhotosPeopleReads.REGION_LIMIT,
            after = ScreenRuntime.decodeCursor(afterCursor),
        )
        if (regions is PhotosPage.Refused) {
            host.send(PhotosPeopleReads.refused(regions.failure))
            return
        }
        val screen = PhotosPeopleReads.fold(
            policyRows = (policy as PhotosPage.Rows).rows,
            partyRows = (parties as PhotosPage.Rows).rows,
            regionRows = (regions as PhotosPage.Rows).rows,
            nextCursor = regions.nextCursor,
        )
        host.send(PhotosPeopleReads.arrived(withCovers(core, screen)))
    }

    /**
     * THE FOURTH LEG: each person's cover, by the asset id the fold chose.
     *
     * **A REFUSAL HERE IS NOT A REFUSED SCREEN, and that is the one place this
     * bridge departs from the three legs above.** Those three are what the
     * screen IS — who is confirmed, what they are called, whether recognition
     * runs — and a screen missing any of them cannot be drawn honestly. A cover
     * is not: `PersonRow.cover_thumbnail_path` is `optional` precisely because
     * absent is a real answer, and the view already draws the person's initial
     * for it. Replacing a readable list of people with a sentence because a
     * thumbnail could not be resolved would be the decoration taking the
     * content down with it.
     *
     * Skipped entirely when no row named a cover, which is every vault where
     * nobody is confirmed yet.
     */
    private suspend fun withCovers(
        core: dev.centraid.core.CentraidCore?,
        screen: centraid.screen.v1.PhotosPeopleData,
    ): centraid.screen.v1.PhotosPeopleData {
        val assetIds = screen.people.map { it.cover_asset_id }.filter { it.isNotEmpty() }.distinct()
        val query = PhotosPeopleReads.coversQuery(assetIds) ?: return screen
        val covers = core.photosPage(query, limit = assetIds.size)
        return when (covers) {
            is PhotosPage.Rows -> PhotosPeopleReads.withCovers(screen, covers.rows)
            is PhotosPage.Refused -> screen
        }
    }

    /**
     * The rename, down the same door.
     *
     * A FROZEN VAULT REFUSES AND SAYS SO (#1029 F1): a vault that moved to the
     * member's other phone is read-only, and the write is refused with a
     * sentence rather than committed or queued. Read at the moment of the write
     * and not at attach, because the shelf can freeze a vault while a member is
     * mid-edit.
     *
     * `invoke_key` is the screen's, which is content-derived rather than
     * ordinal — it is what keeps a replayed command from re-executing one that
     * already committed.
     */
    private suspend fun submit(session: HomeSession, write: ScreenEffect.SubmitWrite) {
        if (session.shelf.foregroundHolding()?.readOnly == true) {
            host.send(
                PhotosPeopleReads.settled(
                    CommandStatus.COMMAND_STATUS_DENIED,
                    Shelf.MOVED_SENTENCE,
                    write.invokeKey,
                ),
            )
            return
        }
        val handle = session.shelf.core()
        if (handle == null) {
            host.send(
                PhotosPeopleReads.settled(
                    CommandStatus.COMMAND_STATUS_DENIED,
                    "No vault is open on this device.",
                    write.invokeKey,
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
                PhotosPeopleReads.settled(
                    CommandStatus.COMMAND_STATUS_FAILED,
                    outcome.failure.sentence,
                    write.invokeKey,
                )

            is CoreOutcome.Answered -> {
                val answered = outcome.value.response?.command
                if (answered == null) {
                    PhotosPeopleReads.settled(
                        CommandStatus.COMMAND_STATUS_FAILED,
                        "",
                        write.invokeKey,
                    )
                } else {
                    // THE CORE'S OWN SENTENCE, when it has one.
                    // `CommandOutcome.reason` is the author's words for a denial
                    // or a failed precondition — never the raw predicate, which
                    // reaches the audit trail only.
                    PhotosPeopleReads.settled(answered.status, answered.reason, write.invokeKey)
                }
            }
        }
        host.send(event)
    }

    /** The People cover is on screen. */
    public fun opened() {
        scope.launch { host.send(PhotosPeopleEvent(opened = PhotosPeopleEvent.Opened())) }
    }

    /** Publish every state to [onState], starting with the current one. */
    public fun observe(onState: (ByteArray) -> Unit) {
        this.onState = onState
        // The FIRST state, immediately. A view that subscribed and then waited
        // for a change would draw nothing at all until a read landed.
        onState(host.state.value.encode())
    }

    /** Forward one encoded event. */
    public fun send(event: ByteArray) {
        scope.launch { host.send(PhotosPeopleEvent.ADAPTER.decode(event)) }
    }

    /** The current state, for a view that needs one before it subscribes. */
    public fun current(): ByteArray = host.state.value.encode()

    /** Release the scope. A screen that is gone reduces nothing. */
    public fun close() {
        scope.cancel()
    }
}
