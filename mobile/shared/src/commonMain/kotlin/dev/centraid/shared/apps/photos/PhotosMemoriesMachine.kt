package dev.centraid.shared.apps.photos

import centraid.screen.v1.Loading
import centraid.screen.v1.MemoryRow
import centraid.screen.v1.MemoryStop
import centraid.screen.v1.PhotoShelf
import centraid.screen.v1.PhotosMemoriesData
import centraid.screen.v1.PhotosMemoriesEvent
import centraid.screen.v1.PhotosMemoriesState
import centraid.screen.v1.SeatState
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step

/**
 * MEMORIES — WHAT A PASS NOTICED IN A LIBRARY (#1029, photos port).
 *
 * Browse only, exactly as v0's `MemoriesView.tsx` was: no selection, no batch
 * verb, no write. A tap opens the memory's MEMBERS, which are the library under
 * a predicate — `photos.shelf` with a [PhotoShelf.Memory] — and not a screen of
 * their own.
 *
 * ## `computed` IS THE HONEST HALF OF AN EMPTY LIST, AND NO READ CAN ANSWER IT
 *
 * `PhotosMemoriesData.computed` exists so that an empty list with it false
 * reads as "not yet" and with it true reads as "there are none". **Nothing on
 * this door can tell the two apart.** `media_memory.computed_at` is `NOT NULL`,
 * so it is a fact about a ROW and says nothing about a pass that produced none;
 * there is no run ledger beside the table; and `docs/photos/derived-ledger.md`
 * states the rest plainly — *"No command in `crates/` writes the projection."*
 * The fixtures agree: `contracts/apps/photos/rows.json` carries zero
 * `media_memory` rows.
 *
 * So this takes the conservative reading and says so: **`computed` is true only
 * when rows arrived.** An empty answer is "not yet", which is the claim that
 * cannot be wrong on a tree where nothing computes memories at all. Saying
 * "there are none" would be this screen asserting a pass ran when nothing in
 * the product runs one.
 *
 * ## What one read cannot say, and does not invent
 *
 * `MemoryRow.member_count` and `cover_thumbnail_path` are facts about
 * `media_memory_member` and `media_asset`; the shelf statement reads
 * `media_memory` and the door has no join clause. They are left ABSENT rather
 * than guessed, which is `TallyReads`' rule for `payer_name`: a renderer draws
 * no name instead of drawing an id as a person. [titleOf] composes a title
 * without them, and the views print no count rather than printing zero —
 * because on this door a zero is "not read", never "empty".
 *
 * A TRIP'S `route` and `place_name` are the exception: `PhotosMemoriesBridge`
 * reads its members' places as extra legs and folds them onto the row
 * (`PhotosMemoriesReads.withRoutes`), because a trip's sketch and its name are
 * what make it a trip and not a date range.
 */
public object PhotosMemoriesMachine :
    ScreenMachine<PhotosMemoriesState, PhotosMemoriesEvent> {
    public const val SCREEN_ID: String = "photos.memories"

    override fun initial(): PhotosMemoriesState =
        PhotosMemoriesState(loading = Loading(first_load = true))

    override fun reduce(
        state: PhotosMemoriesState,
        event: PhotosMemoriesEvent,
    ): Step<PhotosMemoriesState> = when {
        event.opened != null -> firstLoad(state)

        // A REAL WALK, unlike the library's. `computed_at` is `NOT NULL`, so a
        // keyset continuation over it keeps its meaning — `captured_at` is the
        // column that cannot be continued, which is why the grid and the places
        // count take one page and say so.
        event.next_page != null -> Step(
            state,
            listOf(ScreenEffect.ReadPage(SCREEN_ID, event.next_page.after_cursor)),
        )

        // A ROW MOVED. The keys are not consulted: this shelf is a projection a
        // pass rewrites wholesale (deterministic ids, drop-and-rebuild), so a
        // subset of ids says nothing useful about what the shelf now is.
        //
        // **A PARKED FEED EMITS NO RE-READ.** Low disk stops the cadence;
        // freeing space resumes it from the durable cursor.
        event.rows_changed != null ->
            if (Reads.isParked(state.failure)) Step(state) else firstLoad(state)

        event.data_ != null -> Step(
            state.copy(
                loading = null,
                failure = null,
                data_ = merge(state.data_, event.data_.data_),
            ),
        )

        // A FAILED READ IS NOT "YOU HAVE NO MEMORIES", and on this screen the
        // two are one word apart: the empty case already says something about a
        // pass, and a refusal drawn as an empty list would say it about a read
        // that never happened.
        event.refused != null -> Step(
            state.copy(loading = null, data_ = null, failure = event.refused.failure),
        )

        event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))

        else -> Step(state)
    }

    private fun firstLoad(state: PhotosMemoriesState): Step<PhotosMemoriesState> = Step(
        state.copy(loading = Loading(first_load = true), failure = null, data_ = null),
        listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)),
    )

    /**
     * A later page APPENDS; it never replaces.
     *
     * Keyed by `memory_id` for `PhotosGridMachine.merge`'s reason: a page that
     * overlaps its predecessor — which a keyset walk can do when rows are
     * rewritten under it — must not put the same memory on the shelf twice.
     *
     * `computed` is `||` across pages: a first page that carried rows has
     * already settled the question, and a later empty page is the END of the
     * walk and not a new claim that nothing was computed.
     */
    internal fun merge(
        existing: PhotosMemoriesData?,
        arriving: PhotosMemoriesData?,
    ): PhotosMemoriesData? {
        if (arriving == null) return existing
        if (existing == null) return arriving
        val known = existing.memories.map { it.memory_id }.toSet()
        return arriving.copy(
            memories = existing.memories + arriving.memories.filterNot { it.memory_id in known },
            computed = existing.computed || arriving.computed,
        )
    }

    /**
     * WHAT THIS MEMORY IS CALLED.
     *
     * `title_hint` is what the pass called it, and it is empty when the pass
     * had nothing to call it — the DDL leaves it NULL for the kinds that do not
     * populate it. **The title is composed here rather than stored**, which is
     * the contract's own instruction: a title written into the vault would be a
     * name the vault never wrote, and it would not re-phrase when the member
     * names the place it is about.
     *
     * Composed in `commonMain` and not in each view, because two shells
     * composing the same sentence twice is two sentences.
     *
     * The trip's fallback is `MemoriesView`'s own — "Away from home" — for a
     * trip whose photographs carry no readable place; `place_name` is folded
     * from its members' places otherwise (see the class note).
     */
    public fun titleOf(row: MemoryRow): String {
        val hint = row.title_hint.trim()
        if (hint.isNotEmpty()) return hint
        return when (row.kind) {
            MemoryRow.Kind.KIND_ON_THIS_DAY -> ON_THIS_DAY
            MemoryRow.Kind.KIND_TRIP -> row.place_name.ifEmpty { AWAY_FROM_HOME }
            MemoryRow.Kind.KIND_SIMILAR ->
                if (row.member_count > 0) "${row.member_count} similar photographs" else SIMILAR
            MemoryRow.Kind.KIND_UNSPECIFIED -> UNKNOWN_KIND
        }
    }

    /**
     * A TRIP'S ROUTE, AS A SKETCH IN A BOX `aspect` WIDE AND 1 HIGH — the
     * arithmetic `MemoriesView.tsx`'s `RouteSketch` took from `projectPlaces`,
     * here so it is written once and a JVM spec can hold it.
     *
     * **Not a map and not to be read as one** (v0: "situates the trip beside
     * its name"): no basemap, no scale, nothing fetched. Longitude is narrowed
     * by the cosine of the route's middle latitude and both axes share ONE
     * scale, so a trip up a coast looks like a trip up a coast and not a
     * square; the route is centred, and **y grows SOUTH** because both shells'
     * canvases put the origin at the top left.
     *
     * Answers unit coordinates the views multiply by their own box, less a
     * dot's radius of padding. One stop, or several at one spot, lands in the
     * middle rather than dividing by a zero span.
     */
    public fun sketch(route: List<MemoryStop>, aspect: Double): List<SketchPoint> {
        if (route.isEmpty() || aspect <= 0.0) return emptyList()
        val middle = (route.minOf { it.latitude } + route.maxOf { it.latitude }) / 2
        val narrowing = kotlin.math.cos(middle * kotlin.math.PI / 180.0)
        val xs = route.map { it.longitude * narrowing }
        val ys = route.map { -it.latitude }
        val spanX = xs.max() - xs.min()
        val spanY = ys.max() - ys.min()
        val scale = minOf(
            if (spanX > 0.0) aspect / spanX else Double.POSITIVE_INFINITY,
            if (spanY > 0.0) 1.0 / spanY else Double.POSITIVE_INFINITY,
        )
        val centreX = (xs.max() + xs.min()) / 2
        val centreY = (ys.max() + ys.min()) / 2
        return route.indices.map { index ->
            if (scale.isInfinite()) {
                SketchPoint(MIDDLE, MIDDLE)
            } else {
                SketchPoint(
                    x = MIDDLE + (xs[index] - centreX) * scale / aspect,
                    y = MIDDLE + (ys[index] - centreY) * scale,
                )
            }
        }
    }

    /** One stop in the unit box: 0,0 top left, 1,1 bottom right. */
    public data class SketchPoint(public val x: Double, public val y: Double)

    private const val MIDDLE: Double = 0.5

    /**
     * The days a memory covers, or empty.
     *
     * **A PARTIAL RANGE IS NOT PRINTED** (`tripDateLabel`: "Missing endpoint →
     * title hint; do not print a partial range"). One date where a member
     * expects two reads as a trip that ended the day it started.
     *
     * The dates are the vault's own `YYYY-MM-DD`, not a month name. Spelling
     * "3 Jun" needs a locale, and the locale that is right is the VAULT's and
     * never the device's — the rule `Money.spelled` keeps by printing a raw
     * figure rather than dividing by a hundred it cannot justify. `MemoryRow`
     * carries no locale, so this prints what the column says.
     */
    public fun dayRangeOf(row: MemoryRow): String {
        val start = row.started_at.take(DAY_LENGTH)
        val end = row.ended_at.take(DAY_LENGTH)
        if (start.length < DAY_LENGTH || end.length < DAY_LENGTH) return ""
        return if (start == end) start else "$start – $end"
    }

    /**
     * WHERE A TAP ON A MEMORY LANDS: `photos.shelf`, with the members as the
     * shelf's predicate and the composed title riding along so the head has
     * something to say before the first page returns.
     */
    public fun shelfFor(row: MemoryRow): PhotoShelf = PhotoShelf(
        memory = PhotoShelf.Memory(memory_id = row.memory_id, title = titleOf(row)),
    )

    /**
     * `media_memory` — the projection itself.
     *
     * NOT `media_memory_member`: this screen reads no memberships, so a change
     * there names rows it is not showing, and its primary key is the PAIR
     * `(memory_id, asset_id)` which `ChangeStream.textKeyOf` answers null for
     * anyway. The pair moves TOGETHER in practice — the projection is dropped
     * and rebuilt as a unit — so the memory rows' own change is what redraws
     * this shelf.
     */
    override fun rowsChanged(table: String, keys: List<String>): PhotosMemoriesEvent? =
        when (table) {
            TABLE -> PhotosMemoriesEvent(
                rows_changed = PhotosMemoriesEvent.RowsChanged(memory_ids = keys),
            )
            else -> null
        }

    internal const val TABLE: String = "media_memory"

    /** `YYYY-MM-DD`. */
    private const val DAY_LENGTH: Int = 10

    internal const val ON_THIS_DAY: String = "On this day"
    internal const val AWAY_FROM_HOME: String = "Away from home"
    internal const val SIMILAR: String = "Similar photographs"

    /**
     * A KIND THIS BUILD DOES NOT KNOW IS STILL A MEMORY.
     *
     * The DDL's CHECK admits three values today. A fourth arriving from a newer
     * vault must not be drawn as a trip, and it must not be dropped either — a
     * card a member can open is better than a shelf that quietly shrinks.
     */
    internal const val UNKNOWN_KIND: String = "A memory"

    override fun seatChanged(seat: SeatState): PhotosMemoriesEvent =
        PhotosMemoriesEvent(seat_changed = PhotosMemoriesEvent.SeatChanged(seat = seat))
}
