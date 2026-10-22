package dev.centraid.shared.apps.photos

import centraid.core.v1.Command
import centraid.core.v1.CommandStatus
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.Envelope
import centraid.core.v1.PhotosDuplicatesRequest
import centraid.core.v1.Request
import centraid.core.v1.Row
import centraid.screen.v1.PhotosCollectionsEvent
import centraid.screen.v1.PhotosCollectionsState
import dev.centraid.core.CoreOutcome
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.shell.Shelf
import dev.centraid.shared.sync.AppQueryOutcome
import dev.centraid.shared.sync.ScreenRuntime
import dev.centraid.shared.sync.askCore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import okio.ByteString.Companion.encodeUtf8

/**
 * What SwiftUI holds instead of Collections' `StateFlow`, AND the runtime that
 * composes its reads (#1029, the photos port; #1135).
 *
 * `PhotosBridge`'s shape for the boundary half, and both of its rules are
 * load-bearing:
 *
 * * **BYTES, NOT OBJECTS.** The state crosses as an encoded
 *   `PhotosCollectionsState` and the event arrives as an encoded
 *   `PhotosCollectionsEvent`; Swift decodes it with SwiftProtobuf from the same
 *   schema Wire reads here, so one fixture proves both sides.
 * * **NOT `suspend`.** A SwiftUI button cannot await, and a view that could
 *   await a reducer would hold the main thread while a screen thinks.
 *
 * Android does NOT use this: Compose collects [host]'s `StateFlow` directly.
 *
 * ## WHY THIS BRIDGE SERVES ITS OWN READS
 *
 * `ScreenRuntime` serves ONE `ScreenReads` — one table, one statement — and
 * this screen is a list of SHELVES, which is to say a list of COUNTS, and the
 * door has no `COUNT(*)` and no join. So it reads: `entity` for the albums'
 * names, `container` for their covers, `edge` for their sizes and for the
 * Favorites, `photo` three times for Archive, Trash and Videos, `entity` for the
 * Places door, and the `photos.duplicates` app query for the Duplicates door.
 *
 * They cannot be chained through the reducer because `PhotosCollectionsState`'s
 * content is a protobuf `oneof`: `loading` and `data` cannot both be set, so
 * there is nowhere to hold seven answers while the eighth is in flight. Wire
 * refuses the state in its own constructor, which is the three-state read law
 * made structural. So the composition happens here, which is what `HomeRuntime`
 * already does and says it exists for.
 *
 * Everything about those reads that is DATA — the statements and the fold —
 * stays in [PhotosCollectionsReads], so all of it is provable on a machine with
 * no vault. What is here is the trip.
 */
public class PhotosCollectionsBridge {
    /**
     * The host, exposed because Android drives it directly.
     *
     * One per bridge and never re-created: `ChangeStream.route` registers a
     * host for the life of the session, so a second host would leave the routed
     * one drawing into nothing.
     */
    public val host: ScreenHost<PhotosCollectionsState, PhotosCollectionsEvent> =
        ScreenHost(PhotosCollectionsMachine)

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
                        effect.screenId == PhotosCollectionsMachine.SCREEN_ID ->
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
     * THE READS, AND THE ONE SCREEN THEY MAKE.
     *
     * A REFUSAL is load-bearing everywhere: the first one that refuses ends the
     * trip and the screen draws a sentence, because a half-composed Collections is
     * the fourth state the read law forbids and "Trash, 0" over a refused read is
     * a worse lie than "Centraid could not read this".
     *
     * The counts are re-read on a CONTINUED page too. A page of albums is a
     * hundred rows and the counts are a handful of local reads against a file on
     * this phone; the alternative is caching the answers on a state that has no
     * field for one, which is how a screen comes to show yesterday's numbers
     * beside today's rows.
     */
    private suspend fun serve(session: HomeSession, afterCursor: String?) {
        val core = session.shelf.core()

        // THE ALBUMS ARE THE ONLY READ THAT WALKS. Every other statement on
        // this screen sorts on a column that can be NULL or is a count over a
        // set, and the door refuses a CONTINUED page over a nullable sort key
        // outright — so the rest ask for one page and say whether it filled.
        val albums = core.photosPage(
            PhotosCollectionsReads.albumsQuery(),
            limit = PhotosCollectionsReads.ALBUM_LIMIT,
            after = ScreenRuntime.decodeCursor(afterCursor),
        )
        val albumScan = albums.scanOrRefuse() ?: return
        // THE CURSOR THE SCREEN CARRIES. `Scan` deliberately does not hold one:
        // the other reads never walk, and a cursor field on the shape they share
        // would be fields that are always null.
        val albumsNextCursor = (albums as? PhotosPage.Rows)?.nextCursor

        val counts = listOf(
            PhotosCollectionsReads.albumEntriesQuery(),
            PhotosCollectionsReads.archiveQuery(),
            PhotosCollectionsReads.trashQuery(),
            PhotosCollectionsReads.videosQuery(),
            PhotosCollectionsReads.starredQuery(),
            PhotosCollectionsReads.placesQuery(),
        ).map { query ->
            core.photosPage(query, limit = PhotosCollectionsReads.COUNT_LIMIT)
                .scanOrRefuse() ?: return
        }

        // THE DUPLICATES DOOR IS THE CORE'S: a cluster is a projection of the
        // photographs' perceptual hashes, computed where the clustering lives
        // (`photos.duplicates`), and counted here. A denial or a refusal is the
        // screen's sentence, like any read above.
        val duplicates = when (val answer = askCore(core, listOf(AppQueryRequest(photos_duplicates = PhotosDuplicatesRequest())))) {
            is AppQueryOutcome.Answered -> answer.answers.firstNotNullOfOrNull { it.photos_duplicates }?.clusters?.size ?: 0
            is AppQueryOutcome.Denied -> 0
            is AppQueryOutcome.Refused -> {
                host.send(PhotosCollectionsReads.refused(answer.failure))
                return
            }
        }

        // THE COVERS ARE AN AMENDMENT, NOT A READ THE SCREEN WAITS ON. A
        // refusal here costs the cards their pictures and nothing else, so it is
        // not sent as the screen's sentence the way the reads above are.
        val coverBlob = PhotosCollectionsReads.albumCoverBlobsQuery(albumScan.rows.map { it.text(0) })
            ?.let { query -> (core.photosPage(query, limit = PhotosCollectionsReads.ALBUM_LIMIT) as? PhotosPage.Rows)?.rows }
            .orEmpty()
            .filter { it.text(1).isNotEmpty() }
            .associate { it.text(0) to it.text(1) }
        val first = AlbumChoice.firstMembers(counts[ENTRIES].rows)
        val covers = PhotosCollectionsReads.albumCoversQuery(
            coverBlobs = coverBlob.values.toList(),
            firstMembers = albumScan.rows.map { it.text(0) }.filter { it !in coverBlob }.mapNotNull { first[it] },
        )?.let { query ->
            (core.photosPage(query, limit = PhotosCollectionsReads.COUNT_LIMIT) as? PhotosPage.Rows)
                ?.let { PhotosCollectionsReads.Scan(it.rows) }
        } ?: PhotosCollectionsReads.Scan()

        host.send(
            PhotosCollectionsReads.arrived(
                PhotosCollectionsReads.fold(
                    albums = albumScan,
                    albumsNextCursor = albumsNextCursor,
                    coverBlob = coverBlob,
                    entries = counts[ENTRIES],
                    archive = counts[ARCHIVE],
                    trash = counts[TRASH],
                    videos = counts[VIDEOS],
                    starred = counts[STARRED],
                    places = counts[PLACES],
                    duplicateClusters = duplicates,
                    covers = covers,
                ),
            ),
        )
    }

    /**
     * One page, as a [PhotosCollectionsReads.Scan] — or the member's sentence,
     * sent, and `null` to end the trip.
     *
     * **`capped` IS THE CURSOR AND NEVER A ROW COUNT.** A page that returned
     * exactly as many rows as the limit and a page that ran out on the last row
     * look identical from a count; only the door's own `next` can tell them
     * apart, which is the same distinction `crates/apps/photos`' `filled` is
     * and the reason its comment refuses a count.
     */
    private suspend fun PhotosPage.scanOrRefuse(): PhotosCollectionsReads.Scan? = when (this) {
        is PhotosPage.Refused -> {
            host.send(PhotosCollectionsReads.refused(failure))
            null
        }

        is PhotosPage.Rows -> PhotosCollectionsReads.Scan(
            rows = rows,
            capped = nextCursor != null,
        )
    }

    /** Positional, as the door states. */
    private fun Row.text(index: Int): String = values.getOrNull(index)?.text ?: ""

    /**
     * The album verbs, down the same door.
     *
     * A FROZEN VAULT REFUSES AND SAYS SO (#1029 F1): a vault that moved to the
     * member's other phone is read-only, and the write is refused with a
     * sentence rather than committed or queued. Read at the moment of the write
     * and not at attach, because the shelf can freeze a vault while a member is
     * mid-edit.
     *
     * `invoke_key` is the screen's, which is content-derived rather than
     * ordinal — the correlation key the answer comes back under. The core
     * remembers no key (no replay ledger, #1029 §1, R-1088-12).
     */
    private suspend fun submit(session: HomeSession, write: ScreenEffect.SubmitWrite) {
        if (session.shelf.foregroundHolding()?.readOnly == true) {
            host.send(
                PhotosCollectionsReads.settled(
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
                PhotosCollectionsReads.settled(
                    CommandStatus.COMMAND_STATUS_DENIED,
                    "No vault is open on this phone.",
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
            is CoreOutcome.Failed -> PhotosCollectionsReads.settled(
                CommandStatus.COMMAND_STATUS_FAILED,
                outcome.failure.sentence,
                write.invokeKey,
            )

            is CoreOutcome.Answered -> {
                val answered = outcome.value.response?.command
                if (answered == null) {
                    PhotosCollectionsReads.settled(
                        CommandStatus.COMMAND_STATUS_FAILED,
                        "",
                        write.invokeKey,
                    )
                } else {
                    // THE CORE'S OWN SENTENCE, when it has one.
                    // `CommandOutcome.reason` is the author's words for a denial
                    // or a failed precondition — never the raw predicate, which
                    // reaches the audit trail only.
                    PhotosCollectionsReads.settled(answered.status, answered.reason, write.invokeKey)
                }
            }
        }
        host.send(event)
    }

    /** The Collections cover is on screen. */
    public fun opened() {
        scope.launch { host.send(PhotosCollectionsEvent(opened = PhotosCollectionsEvent.Opened())) }
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
        scope.launch { host.send(PhotosCollectionsEvent.ADAPTER.decode(event)) }
    }

    /** The current state, for a view that needs one before it subscribes. */
    public fun current(): ByteArray = host.state.value.encode()

    /** Release the scope. A screen that is gone reduces nothing. */
    public fun close() {
        scope.cancel()
    }

    /**
     * Where each counting read landed in the list above.
     *
     * Named constants rather than literals at the call site, because the list
     * and the fold are two orders that must agree and a transposed pair would
     * put the trash count on the archive shelf — a defect nothing would fail
     * on, on a vault where both happen to be small.
     */
    private companion object {
        private const val ENTRIES: Int = 0
        private const val ARCHIVE: Int = 1
        private const val TRASH: Int = 2
        private const val VIDEOS: Int = 3
        private const val STARRED: Int = 4
        private const val PLACES: Int = 5
    }
}
