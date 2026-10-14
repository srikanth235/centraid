package dev.centraid.shared.apps.photos

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.PhotosSearch
import centraid.core.v1.PhotosSearchRequest
import centraid.screen.v1.PhotosSearchEvent
import centraid.screen.v1.PhotosSearchState
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.SearchTopHit
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.sync.AppQueryOutcome
import dev.centraid.shared.sync.askCore
import dev.centraid.shared.sync.deniedFailure
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.sync.ScreenRuntime
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * What SwiftUI holds instead of Search's `StateFlow` (#1029, the photos port).
 *
 * `PhotosBridge`'s shape, for the same reasons, and they are worth restating
 * because both are load-bearing at this boundary:
 *
 * * **BYTES, NOT OBJECTS.** The state crosses as an encoded `PhotosSearchState`
 *   and the event arrives as an encoded `PhotosSearchEvent`; Swift decodes it
 *   with SwiftProtobuf from the same schema Wire reads here, so one fixture
 *   proves both sides. Handing Swift a Kotlin object would put an Objective-C
 *   bridging layer between the shells and give the contract two shapes.
 * * **NOT `suspend`.** A SwiftUI text field cannot await, and a view that could
 *   await a reducer would be a view holding the main thread while a screen
 *   thinks. The launch is what keeps `send`'s ordering — one coroutine, one
 *   queue — without the caller knowing there is one.
 *
 * Android does NOT use this: Compose collects [host]'s `StateFlow` directly.
 *
 * **THIS SCREEN HAS NO WRITE.** Searching commits nothing.
 *
 * ## WHY THIS BRIDGE SERVES ITS OWN READS
 *
 * `ScreenRuntime` serves ONE statement, and a search is legs: the people,
 * places, albums and labels a query names, their counts, and then the page of
 * photographs all of them reach — whose predicate is built FROM the earlier
 * legs' ids. That chaining cannot ride the reducer (the content oneof has
 * nowhere to park three answers while a fourth is in flight), so it happens
 * here, which is `PhotosPeopleBridge`'s shape and `HomeRuntime`'s reason.
 * Every statement and every fold is `PhotosSearchReads`; what is here is the
 * trip.
 */
public class PhotosSearchBridge {
    /**
     * The host, exposed because Android drives it directly.
     *
     * One per bridge and never re-created: `ChangeStream.route` registers a
     * host for the life of the session, so a second host would leave the routed
     * one drawing into nothing.
     */
    public val host: ScreenHost<PhotosSearchState, PhotosSearchEvent> =
        ScreenHost(PhotosSearchMachine)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var onState: ((ByteArray) -> Unit)? = null

    /**
     * Put this screen on the session's core, and start publishing.
     *
     * The attach is the session's ([HomeSession.attachScreen]) because the core
     * is: R-1020-24 is one core per process, so a bridge that opened its own
     * would be refused by `SingleHandleGuard`.
     */
    public fun attach(session: HomeSession) {
        // ROUTED ONCE: the route list appends, and a host routed twice
        // re-reads the screen twice on every commit.
        session.changes.route(host)
        // UNDISPATCHED, for `ScreenRuntime.start`'s reason: `effects` has no
        // replay, so a collector that is only SCHEDULED loses the `ReadPage`
        // the opening event emits a line later.
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            host.effects.collect { effect ->
                if (effect is ScreenEffect.ReadPage &&
                    effect.screenId == PhotosSearchMachine.SCREEN_ID
                ) {
                    scope.launch { serve(session, effect.afterCursor) }
                }
            }
        }
        scope.launch { host.state.collect { state -> onState?.invoke(state.encode()) } }
    }

    /**
     * WHAT THE SCREEN SHOWS, READ FOR THE QUERY IT HOLDS NOW.
     *
     * `ScreenHost` publishes the state before it emits the effects of the same
     * reduce, so the query read here is the one that asked. An empty field
     * reads the vocabulary; anything else reads the hits.
     */
    private suspend fun serve(session: HomeSession, afterCursor: String?) {
        val query = host.state.value.query
        if (query.isBlank()) resting(session) else hits(session, query, afterCursor)
    }

    /** The three vocabulary legs. A leg that refuses is an empty list. */
    private suspend fun resting(session: HomeSession) {
        val core = session.shelf.core()
        val limit = PhotosSearchReads.VOCABULARY_LIMIT
        host.send(
            PhotosSearchReads.restingArrived(
                peopleRows = core.photosPage(PhotosSearchReads.restingPeopleQuery(), limit).rowsOrEmpty(),
                placeRows = core.photosPage(PhotosSearchReads.restingPlacesQuery(), limit).rowsOrEmpty(),
                labelRows = core.photosPage(PhotosSearchReads.restingLabelsQuery(), limit).rowsOrEmpty(),
            ),
        )
    }

    /**
     * THE HITS: the structured entities, the core's answer for the text and the
     * albums, their counts, then the page they reach.
     *
     * An ENTITY leg that refuses ends the trip with a refusal — a search that
     * silently dropped "people" would answer fewer photographs than the member
     * asked for and say nothing. A COUNT leg that refuses does not: a door
     * with no number is still the door, and the view prints no count for zero.
     *
     * **THE CORRECTION (#1097, R-1097-27).** The core corrects only when asked,
     * and is asked only when every leg here came back empty for the term as
     * typed. If it hands back corrected words, the structured legs run again at
     * those words, and the correction is KEPT only if the whole answer is then
     * not empty; a correction that found nothing is not reported. A later page
     * of an answer already corrected reads at the words the state holds.
     */
    private suspend fun hits(session: HomeSession, query: String, afterCursor: String?) {
        val core = session.shelf.core()
        val settled = if (afterCursor == null) "" else host.state.value.search?.corrected.orEmpty()
        val searched = settled.ifEmpty { query }

        val exact = when (val read = legs(core, searched, allowCorrection = afterCursor == null)) {
            is Legs.Refused -> return host.send(PhotosSearchReads.refused(read.failure))
            is Legs.Answer -> read
        }
        var kept = exact
        var corrected = settled
        if (exact.corrected.isNotEmpty()) {
            // The core corrected: the structured legs get the corrected words too.
            val again = when (val read = legs(core, exact.corrected, allowCorrection = false, core = exact.core)) {
                is Legs.Refused -> return host.send(PhotosSearchReads.refused(read.failure))
                is Legs.Answer -> read
            }
            if (!again.isEmpty) {
                kept = again
                corrected = exact.corrected
            }
        }

        val page = kept.reach.let { reach ->
            PhotosSearchReads.hitsQuery(reach)?.let { statement ->
                core.photosPage(
                    statement,
                    PhotosSearchReads.HIT_LIMIT,
                    after = ScreenRuntime.decodeCursor(afterCursor),
                )
            }
        }
        if (page is PhotosPage.Refused) return host.send(PhotosSearchReads.refused(page.failure))
        host.send(
            PhotosSearchReads.hitsArrived(
                query = query,
                rows = (page as PhotosPage.Rows?)?.rows.orEmpty(),
                nextCursor = (page as PhotosPage.Rows?)?.nextCursor,
                topHits = kept.topHits,
                labels = kept.labels,
                corrected = corrected,
            ),
        )
    }

    /** What one run of every leg at one term came to. */
    private sealed interface Legs {
        data class Refused(val failure: ReadFailure) : Legs

        class Answer(
            val topHits: List<SearchTopHit>,
            val labels: List<PhotosSearchReads.Named>,
            val reach: PhotosSearchReads.Reach,
            /** The words the core corrected the term to, or empty. */
            val corrected: String,
            /** The core's answer, kept so a corrected run does not ask it twice. */
            val core: PhotosSearch,
        ) : Legs {
            /** No door, no label and no photograph: the grid has nothing to read. */
            val isEmpty: Boolean get() = topHits.isEmpty() && labels.isEmpty() && reach.assetIds.isEmpty()
        }
    }

    /**
     * EVERY LEG AT ONE TERM: the people, places and labels from the page door,
     * the photographs and albums from the core, then the counts the doors carry.
     *
     * With [core] given the core is not asked again: its answer was for these
     * words already (the corrected run).
     */
    private suspend fun legs(
        handle: dev.centraid.core.CentraidCore?,
        term: String,
        allowCorrection: Boolean,
        core: PhotosSearch? = null,
    ): Legs {
        val words = PhotosSearchReads.tokens(term)
        val limit = PhotosSearchReads.ENTITY_LIMIT

        val peopleRows = handle.photosPage(PhotosSearchReads.peopleQuery(words), limit)
        if (peopleRows is PhotosPage.Refused) return Legs.Refused(peopleRows.failure)
        val placeRows = handle.photosPage(PhotosSearchReads.placesQuery(), PhotosSearchReads.PLACE_LIMIT)
        if (placeRows is PhotosPage.Refused) return Legs.Refused(placeRows.failure)
        val labelRows = handle.photosPage(PhotosSearchReads.labelsQuery(words), limit)
        if (labelRows is PhotosPage.Refused) return Legs.Refused(labelRows.failure)

        val people = PhotosSearchReads.people((peopleRows as PhotosPage.Rows).rows)
        val places = PhotosSearchReads.matchPlaces((placeRows as PhotosPage.Rows).rows, term)
            .let { it.copy(places = it.places.take(PhotosSearchReads.PER_KIND_CAP)) }
        val labels = PhotosSearchReads.labels((labelRows as PhotosPage.Rows).rows)

        // THE CORE, asked to correct only when nothing here found a thing: the
        // people and the places are the legs the core cannot see.
        val structuredEmpty = people.isEmpty() && places.places.isEmpty() && !places.unplaced && labels.isEmpty()
        val answered = core ?: when (val read = askDoor(handle, term, correct = allowCorrection && structuredEmpty)) {
            is CoreRead.Refused -> return Legs.Refused(read.failure)
            is CoreRead.Answer -> read.search
        }
        val albums = PhotosSearchReads.albums(answered.albums)

        val personCounts = count(handle, PhotosSearchReads.personCountsQuery(people.map { it.id }), 1, 2)
        val placeCounts = count(
            handle,
            PhotosSearchReads.placeCountsQuery(places.places.map { it.id }, places.unplaced),
            1,
            0,
        )
        val albumCounts = count(handle, PhotosSearchReads.albumCountsQuery(albums.map { it.id }), 1, 0)
        val topHits = PhotosSearchReads.topHits(
            people = people,
            personCounts = personCounts,
            places = places,
            placeCounts = placeCounts,
            albums = albums,
            albumCounts = albumCounts,
        )
        return Legs.Answer(
            topHits = topHits,
            labels = labels,
            reach = PhotosSearchReads.reach(topHits, labels, answered.asset_ids),
            corrected = if (core == null) answered.corrected else "",
            core = answered,
        )
    }

    private sealed interface CoreRead {
        data class Refused(val failure: ReadFailure) : CoreRead

        data class Answer(val search: PhotosSearch) : CoreRead
    }

    /** `photos.search` of the core: the text and album legs, and the correction. */
    private suspend fun askDoor(
        handle: dev.centraid.core.CentraidCore?,
        term: String,
        correct: Boolean,
    ): CoreRead {
        val request = AppQueryRequest(
            photos_search = PhotosSearchRequest(
                term = term,
                limit = PhotosSearchReads.TEXT_LIMIT,
                correct = correct,
            ),
        )
        return when (val outcome = askCore(handle, listOf(request))) {
            is AppQueryOutcome.Answered ->
                outcome.answers.firstOrNull()?.photos_search?.let(CoreRead::Answer)
                    ?: CoreRead.Refused(Reads.refused("Centraid got no answer. Try again."))
            is AppQueryOutcome.Denied -> CoreRead.Refused(deniedFailure(outcome.denial))
            is AppQueryOutcome.Refused -> CoreRead.Refused(outcome.failure)
        }
    }

    /** One count leg, or an empty count when there is nothing to count or it refused. */
    private suspend fun count(
        core: dev.centraid.core.CentraidCore?,
        query: centraid.core.v1.PageQuery?,
        keyAt: Int,
        assetAt: Int,
    ): PhotosSearchReads.Counted {
        val none = PhotosSearchReads.Counted(emptyMap(), capped = false)
        if (query == null) return none
        val limit = PhotosSearchReads.COUNT_LIMIT
        return when (val page = core.photosPage(query, limit)) {
            is PhotosPage.Rows -> PhotosSearchReads.counted(page.rows, keyAt, assetAt, limit)
            is PhotosPage.Refused -> none
        }
    }

    private fun PhotosPage.rowsOrEmpty(): List<centraid.core.v1.Row> = when (this) {
        is PhotosPage.Rows -> rows
        is PhotosPage.Refused -> emptyList()
    }

    /**
     * The screen is on screen.
     *
     * `Opened` returns the screen to its resting state and reads the
     * vocabulary that fills it; the first hits read is the member's first
     * keystroke.
     */
    public fun opened() {
        scope.launch { host.send(PhotosSearchEvent(opened = PhotosSearchEvent.Opened())) }
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
        scope.launch { host.send(PhotosSearchEvent.ADAPTER.decode(event)) }
    }

    /** The current state, for a view that needs one before it subscribes. */
    public fun current(): ByteArray = host.state.value.encode()

    /** Release the scope. A screen that is gone reduces nothing. */
    public fun close() {
        scope.cancel()
    }
}
