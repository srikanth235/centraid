package dev.centraid.shared.apps.photos

import centraid.screen.v1.Loading
import centraid.screen.v1.PhotosSearchEvent
import centraid.screen.v1.PhotosSearchState
import centraid.screen.v1.SearchHits
import centraid.screen.v1.SearchResting
import centraid.screen.v1.SeatState
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step

/**
 * SEARCH — the band's third destination, and three screens behind one of them
 * (#1029, the photos port).
 *
 * v0 had `PhotosSearchRestingState`, `PhotosSearchEmptyState` and the hits in
 * three components with three empty sentences between them. They are three
 * states of one search, and the difference that matters is the one a bag of
 * optionals erases: **a member who has typed nothing and a member whose query
 * matched nothing must not read the same words.** The oneof is which one is
 * showing, and this reducer is what moves between them.
 *
 * ## THE INITIAL STATE IS RESTING, NOT LOADING
 *
 * Every other screen in this module seeds `loading`, because every other screen
 * reads the moment it opens. This one does not: a search with no query has
 * nothing to ask for, and `loading` is a claim that a read is in flight. The
 * fourth arm of this state's oneof exists precisely for "nothing has been
 * asked", and that is what is true before the first keystroke — so seeding
 * `loading` would be a spinner over a screen that will never finish loading
 * until the member types.
 *
 * ## WHAT A SEARCH REACHES
 *
 * People (confirmed parties), places (the member's name, the gazetteer's, the
 * home band), albums, labels and captions — v0's `search-hits.ts`, read as legs
 * by `PhotosSearchBridge` and folded by `PhotosSearchReads`. The resting page
 * is the same vault's vocabulary: the people, places and labels a query could
 * land on, read when the field is empty, never a fixed list of words the
 * product hopes are there.
 *
 * ## ONE `ReadPage`, TWO ANSWERS
 *
 * `ReadPage` means "read what this screen shows", and what it shows is decided
 * by the query at the moment the bridge serves it: an empty field reads the
 * vocabulary and answers `RestingArrived`, a query reads the hits and answers
 * `DataArrived`. So opening the screen and clearing the field are both a
 * `ReadPage`, and neither needs an effect this screen alone would have.
 *
 * **A LATE ANSWER IS DROPPED, NOT DRAWN.** A member types faster than legs
 * return, so every `SearchHits` carries the query it answers and a page for a
 * query the field has left is thrown away — the alternative is the last
 * query's photographs drawn under this query's words.
 */
public object PhotosSearchMachine : ScreenMachine<PhotosSearchState, PhotosSearchEvent> {
    public const val SCREEN_ID: String = "photos.search"

    override fun initial(): PhotosSearchState = PhotosSearchState(resting = resting())

    override fun reduce(
        state: PhotosSearchState,
        event: PhotosSearchEvent,
    ): Step<PhotosSearchState> = when {
        // OPENING A SEARCH READS ITS VOCABULARY. It returns to whatever
        // "nothing typed" means — the resting state — and the read that
        // follows fills it with what this vault can be searched for.
        event.opened != null -> restAndRead(state)

        event.query != null -> {
            val query = event.query.query
            if (query.isBlank()) {
                // A CLEARED FIELD IS THE RESTING STATE AGAIN, never an empty
                // hits grid. The two are different screens and this is the
                // moment they are most easily confused: a member who deleted
                // their query must not read "Nothing matches".
                restAndRead(state)
            } else {
                Step(
                    state.copy(
                        query = query,
                        // FIRST LOAD IS ABOUT THE FRAME, not about the query.
                        // A spinner over an empty screen and a spinner over the
                        // last query's hits are different screens, so a member
                        // refining a search keeps their results under it.
                        loading = Loading(first_load = state.hits == null),
                        resting = null,
                        failure = null,
                        hits = null,
                    ),
                    listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)),
                )
            }
        }

        event.next_page != null ->
            // A PARKED FEED EMITS NO RE-READ (`docs/mobile-offline.md:238`).
            if (Reads.isParked(state.failure)) {
                Step(state)
            } else {
                Step(
                    state,
                    listOf(ScreenEffect.ReadPage(SCREEN_ID, event.next_page.after_cursor)),
                )
            }

        // A PAGE FOR ANOTHER QUERY IS DROPPED. See the class note: the field
        // has moved on, and drawing this would put one query's photographs
        // under another's words.
        event.data_ != null ->
            if (state.query.isBlank() || event.data_.hits?.query != state.query) {
                Step(state)
            } else {
                Step(
                    state.copy(
                        loading = null,
                        failure = null,
                        resting = null,
                        hits = merge(state.hits, event.data_.hits),
                    ),
                )
            }

        // THE VOCABULARY LANDS ONLY ON AN EMPTY FIELD. A member who started
        // typing while it was in flight is looking at their query, not at it.
        event.resting != null ->
            if (state.query.isNotBlank()) {
                Step(state)
            } else {
                Step(
                    state.copy(
                        loading = null,
                        failure = null,
                        hits = null,
                        resting = event.resting.resting ?: resting(),
                    ),
                )
            }

        // A FAILED READ IS NOT AN EMPTY RESULT SET. "Nothing matches your
        // query" and "the vault refused this read" are two different sentences
        // and only one of them means the member should try other words.
        event.refused != null -> Step(
            state.copy(
                loading = null,
                hits = null,
                resting = null,
                failure = event.refused.failure,
            ),
        )

        // A ROW MOVED — RE-READ WHAT IS SHOWING.
        //
        // * A PARKED FEED EMITS NO RE-READ.
        // * An empty field re-reads its vocabulary IN PLACE: the words on
        //   screen stay until the new ones land, because a resting page that
        //   blinked empty on every commit would read as "you have nobody".
        // * A query re-reads its hits only when the change can be its own. The
        //   keys are asset ids for `media_asset` and are checked against the
        //   cells on screen, EXCEPT when there are none: an empty list means
        //   "this table moved and nobody can say which rows" (every local
        //   commit, and every table that is not `media_asset`), so it is a
        //   re-read and not a shrug.
        event.rows_changed != null -> {
            val ids = event.rows_changed.asset_ids
            val mine = ids.isEmpty() || ids.any { it in shownIds(state) }
            when {
                Reads.isParked(state.failure) -> Step(state)
                state.query.isBlank() ->
                    Step(state, listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)))
                !mine -> Step(state)
                else -> Step(
                    state.copy(
                        // The frame stays: a member watching their results is
                        // not sent back to an empty screen because a row moved.
                        loading = Loading(first_load = false),
                        failure = null,
                        hits = null,
                    ),
                    listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)),
                )
            }
        }

        event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))

        else -> Step(state)
    }

    /**
     * THE VOCABULARY BEFORE IT HAS BEEN READ — empty, and the read that fills
     * it is already on its way ([restAndRead]).
     */
    private fun resting(): SearchResting = SearchResting()

    private fun restAndRead(state: PhotosSearchState): Step<PhotosSearchState> = Step(
        rest(state, query = ""),
        listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)),
    )

    private fun rest(state: PhotosSearchState, query: String): PhotosSearchState = state.copy(
        query = query,
        resting = resting(),
        loading = null,
        failure = null,
        hits = null,
    )

    /**
     * A second page appends cells and keeps the reasons.
     *
     * Deduped by asset id for `PhotosGridMachine.merge`'s reason: a keyset walk
     * over a sort column that ties can hand the same row twice at a page
     * boundary, and a grid that drew it twice would be a grid disagreeing with
     * its own count.
     *
     * `matches` comes from the ARRIVING page, which is why the arriving copy is
     * the one kept: a later page can only ever have landed on more of the
     * vault's own words than the first did, and a stale reason list under a
     * grown grid would explain fewer photographs than are on screen.
     */
    private fun merge(existing: SearchHits?, arriving: SearchHits?): SearchHits? {
        if (arriving == null) return existing
        if (existing == null) return arriving
        val known = existing.cells.map { it.asset_id }.toSet()
        return arriving.copy(
            cells = existing.cells + arriving.cells.filterNot { it.asset_id in known },
        )
    }

    private fun shownIds(state: PhotosSearchState): Set<String> =
        state.hits?.cells?.map { it.asset_id }?.toSet() ?: emptySet()

    /**
     * EVERY TABLE A SEARCH READS, because every one can change an answer.
     *
     * `media_asset` carries its keys, which are this screen's own cell ids and
     * are filtered by the reducer. The others — a person named, a place
     * renamed, an album filled, a label put on — carry none: their keys are not
     * asset ids, and a filter over them would always say "not mine".
     */
    override fun rowsChanged(table: String, keys: List<String>): PhotosSearchEvent? = when (table) {
        TABLE -> PhotosSearchEvent(rows_changed = PhotosSearchEvent.RowsChanged(asset_ids = keys))
        in VOCABULARY_TABLES ->
            PhotosSearchEvent(rows_changed = PhotosSearchEvent.RowsChanged(asset_ids = emptyList()))
        else -> null
    }

    internal const val TABLE: String = "media_asset"

    private val VOCABULARY_TABLES: Set<String> = setOf(
        "core_party",
        "media_face_region",
        "core_place",
        "core_collection",
        "core_collection_entry",
        "core_tag",
        "core_concept",
    )

    override fun seatChanged(seat: SeatState): PhotosSearchEvent =
        PhotosSearchEvent(seat_changed = PhotosSearchEvent.SeatChanged(seat = seat))
}
