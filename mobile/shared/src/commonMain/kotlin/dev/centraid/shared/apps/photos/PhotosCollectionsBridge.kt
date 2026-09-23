package dev.centraid.shared.apps.photos

import centraid.core.v1.Command
import centraid.core.v1.CommandStatus
import centraid.core.v1.Envelope
import centraid.core.v1.Request
import centraid.core.v1.Row
import centraid.screen.v1.PhotosCollectionsEvent
import centraid.screen.v1.PhotosCollectionsState
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
 * What SwiftUI holds instead of Collections' `StateFlow`, AND the runtime that
 * composes its ten reads (#1029, the photos port).
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
 * door has no `COUNT(*)` and no join. So it reads ten tables:
 * `core_collection` for the albums, `core_collection_entry` for their sizes,
 * `media_asset` three times for Archive, Trash and Videos, the
 * scheme/concept/tag chain for Favorites, and one table each for the People,
 * Places, Memories and Duplicates doors.
 *
 * They cannot be chained through the reducer because `PhotosCollectionsState`'s
 * content is a protobuf `oneof`: `loading` and `data` cannot both be set, so
 * there is nowhere to hold nine answers while the tenth is in flight. Wire
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
     * THE TEN READS, AND THE ONE SCREEN THEY MAKE.
     *
     * Order is load-bearing in exactly one place — the star is a CHAIN, because
     * a concept cannot be asked for until its scheme has been named — and
     * nowhere else. A REFUSAL is load-bearing everywhere: the first one that
     * refuses ends the trip and the screen draws a sentence, because a
     * half-composed Collections is the fourth state the read law forbids and
     * "Trash, 0" over a refused read is a worse lie than "Centraid could not
     * read this".
     *
     * The counts are re-read on a CONTINUED page too. A page of albums is a
     * hundred rows and the counts are nine local reads against a file on this
     * phone; the alternative is caching nine answers on a state that has no
     * field for one, which is how a screen comes to show yesterday's numbers
     * beside today's rows.
     */
    private suspend fun serve(session: HomeSession, afterCursor: String?) {
        val core = session.shelf.core()

        // THE ALBUMS ARE THE ONLY READ THAT WALKS. Every other statement on
        // this screen sorts on a column that can be NULL, and the door refuses
        // a CONTINUED page over a nullable sort key outright — so the rest ask
        // for one page and say whether it filled.
        val albums = core.photosPage(
            PhotosCollectionsReads.albumsQuery(),
            limit = PhotosCollectionsReads.ALBUM_LIMIT,
            after = ScreenRuntime.decodeCursor(afterCursor),
        )
        val albumScan = albums.scanOrRefuse() ?: return
        // THE CURSOR THE SCREEN CARRIES. `Scan` deliberately does not hold one:
        // nine of these ten reads never walk, and a cursor field on the shape
        // they share would be nine fields that are always null.
        val albumsNextCursor = (albums as? PhotosPage.Rows)?.nextCursor

        val counts = listOf(
            PhotosCollectionsReads.albumEntriesQuery(),
            PhotosCollectionsReads.archiveQuery(),
            PhotosCollectionsReads.trashQuery(),
            PhotosCollectionsReads.videosQuery(),
            PhotosCollectionsReads.facesQuery(),
            PhotosCollectionsReads.placesQuery(),
            PhotosCollectionsReads.memoriesQuery(),
            PhotosCollectionsReads.duplicatesQuery(),
        ).map { query ->
            core.photosPage(query, limit = PhotosCollectionsReads.COUNT_LIMIT)
                .scanOrRefuse() ?: return
        }

        // THE STAR IS THREE READS AND THE MIDDLE ONE IS CONDITIONAL.
        //
        // `media_asset.favorite` does not exist (#916, ONT-03): the star is the
        // `starred` concept in the flags scheme, so this walks scheme →
        // concept → tags. **NO SCHEME OR NO CONCEPT MEANS NOTHING IS STARRED,
        // AND THAT IS NOT AN ERROR** — `crates/apps/photos` says so in as many
        // words, because a vault mints both the first time something is
        // starred. An empty scan is the honest "none"; a refusal is still a
        // refusal.
        val scheme = core.photosPage(PhotosCollectionsReads.flagsSchemeQuery(), limit = 1)
            .scanOrRefuse() ?: return
        val schemeId = scheme.rows.firstOrNull().firstText()
        val conceptId = if (schemeId.isEmpty()) {
            ""
        } else {
            val concept = core.photosPage(
                PhotosCollectionsReads.starredConceptQuery(schemeId),
                limit = 1,
            ).scanOrRefuse() ?: return
            concept.rows.firstOrNull().firstText()
        }
        val starred = if (conceptId.isEmpty()) {
            PhotosCollectionsReads.Scan()
        } else {
            core.photosPage(
                PhotosCollectionsReads.starredTagsQuery(conceptId),
                limit = PhotosCollectionsReads.COUNT_LIMIT,
            ).scanOrRefuse() ?: return
        }

        // THE COVERS ARE AN AMENDMENT, NOT A READ THE SCREEN WAITS ON. A
        // refusal here costs the cards their pictures and nothing else, so it is
        // not sent as the screen's sentence the way the reads above are.
        val (coverContents, coverAssets) =
            PhotosCollectionsReads.albumCoverKeys(albumScan, counts[ENTRIES])
        val covers = PhotosCollectionsReads.albumCoversQuery(coverContents, coverAssets)
            ?.let { query ->
                (core.photosPage(query, limit = coverContents.size + coverAssets.size) as? PhotosPage.Rows)
                    ?.let { PhotosCollectionsReads.Scan(it.rows) }
            }
            ?: PhotosCollectionsReads.Scan()

        host.send(
            PhotosCollectionsReads.arrived(
                PhotosCollectionsReads.fold(
                    albums = albumScan,
                    albumsNextCursor = albumsNextCursor,
                    entries = counts[ENTRIES],
                    archive = counts[ARCHIVE],
                    trash = counts[TRASH],
                    videos = counts[VIDEOS],
                    starred = starred,
                    faces = counts[FACES],
                    places = counts[PLACES],
                    memories = counts[MEMORIES],
                    duplicates = counts[DUPLICATES],
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

    /** The first TEXT column of a one-row lookup, or empty when there was none. */
    private fun Row?.firstText(): String = this?.values?.firstOrNull()?.text ?: ""

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
     * ordinal — it is what keeps a replayed command from re-executing one that
     * already committed.
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
        private const val FACES: Int = 4
        private const val PLACES: Int = 5
        private const val MEMORIES: Int = 6
        private const val DUPLICATES: Int = 7
    }
}
