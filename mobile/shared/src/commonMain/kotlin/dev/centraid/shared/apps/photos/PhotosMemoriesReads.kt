package dev.centraid.shared.apps.photos

import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.MemoryRow
import centraid.screen.v1.MemoryStop
import centraid.screen.v1.PhotosMemoriesData
import centraid.screen.v1.PhotosMemoriesEvent
import centraid.screen.v1.PhotosMemoriesState
import centraid.screen.v1.ReadFailure
import dev.centraid.shared.sync.ScreenReads

/**
 * WHAT THE MEMORIES SHELF READS (#1029, photos port).
 *
 * The statement is `crates/apps/photos`' own — `photos.library.memories` in
 * `queries.rs`: `media_memory`, every row, ordered `computed_at DESC,
 * memory_id DESC`. Followed rather than re-derived, for `PhotosReads`' reason:
 * a shelf in a different order from the desktop's over the same rows is two
 * shelves.
 *
 * **THIS WALK IS A REAL WALK.** `computed_at` is `NOT NULL` in the DDL, so a
 * keyset continuation over it keeps its meaning — unlike `media_asset`'s
 * `captured_at`, where a continuation silently drops the NULLs and
 * `KitError::NullableSortKey` refuses one.
 *
 * **The whole projection is read, trash and all — because there is no trash
 * here.** `media_memory` has no `deleted_at`: a memory is dropped and rebuilt
 * by the pass that computes it, with deterministic ids so a rebuild is
 * byte-stable (`docs/photos/derived-ledger.md`). A predicate invented here
 * would filter on a column that does not exist.
 */
public object PhotosMemoriesReads :
    ScreenReads<PhotosMemoriesState, PhotosMemoriesEvent> {
    override val screenId: String = PhotosMemoriesMachine.SCREEN_ID

    /** `media_memory`, the same table the machine's `rowsChanged` declares. */
    override val table: String = PhotosMemoriesMachine.TABLE

    /**
     * The shelf's own size, as the desktop states it (`SHELF_ROWS` in
     * `queries.rs`: "the trash and memory shelves are what the screen shows").
     * Under the door's 500-row clamp, and a walk continues past it.
     */
    override val limit: Int = 200

    override fun query(state: PhotosMemoriesState, afterCursor: String?): PageQuery = PageQuery(
        name = "photos.memories.shelf",
        // THE SELECT CARRIES BOTH ORDER COLUMNS — `computed_at` and
        // `memory_id` — because the door has no `key_of` callback and reads the
        // cursor off the row by the two the ORDER BY names. `computed_at` is
        // projected for that and for nothing else: it is a fact about when a
        // pass ran and never one a member reads.
        select = listOf(
            "memory_id",
            "kind",
            "title_hint",
            "day_key",
            "started_at",
            "ended_at",
            "computed_at",
        ),
        from = table,
        order = PageOrder(
            sort_column = "computed_at",
            pk_column = "memory_id",
            descending = true,
        ),
    )

    override fun arrived(rows: List<Row>, nextCursor: String?): PhotosMemoriesEvent =
        PhotosMemoriesEvent(
            data_ = PhotosMemoriesEvent.DataArrived(
                data_ = PhotosMemoriesData(
                    memories = rows.map(::memoryOf),
                    next_cursor = nextCursor,
                    // THE CONSERVATIVE READING, AND THE ONLY ONE THIS DOOR
                    // SUPPORTS. `computed_at` is NOT NULL, so rows prove a pass
                    // ran and no rows prove nothing at all; nothing else on the
                    // vault records a run. True here means "these memories
                    // exist"; false means "not yet", which is what a member
                    // reads over an empty shelf. See `PhotosMemoriesMachine`.
                    computed = rows.isNotEmpty(),
                ),
            ),
        )

    override fun refused(failure: ReadFailure): PhotosMemoriesEvent =
        PhotosMemoriesEvent(refused = PhotosMemoriesEvent.ReadRefused(failure = failure))

    /**
     * One card out of one row.
     *
     * `place_name`, `member_count` and `cover_thumbnail_path` are absent: they
     * live on `core_place`, `media_memory_member` and `media_asset`, and this
     * statement joins none of them. Absent rather than invented — see
     * `PhotosMemoriesMachine`'s class note.
     *
     * **`day_key` IS PASSED THROUGH AND NEVER PARSED**, which is what the
     * contract asks for. Its shape differs by kind: the DDL's CHECK admits one
     * only on an on-this-day row and the column holds `MM-DD` there, because
     * the memory IS the same date in other years and a year in the key would
     * defeat it. The deterministic id is built from it (`otd:<day_key>`), which
     * is why it travels at all. Nothing here pads it into a year it does not
     * know, and the views take their dates from `started_at`/`ended_at`, which
     * are unambiguous instants.
     */
    private fun memoryOf(row: Row): MemoryRow = MemoryRow(
        memory_id = row.text(MEMORY_ID),
        kind = kindOf(row.text(KIND)),
        title_hint = row.text(TITLE_HINT),
        day_key = row.text(DAY_KEY),
        started_at = row.text(STARTED_AT),
        ended_at = row.text(ENDED_AT),
    )

    /**
     * The DDL's three `kind` values, as the proto's three.
     *
     * Spelled as the CHECK spells them — `on-this-day`, hyphens and all — and
     * read off the column rather than guessed from the id, even though the ids
     * are deterministic (`otd:`, `trip:`, `similar:`). The column is the
     * constraint; the id prefix is a convention of whatever wrote it.
     *
     * An unrecognised value is `KIND_UNSPECIFIED` and not the nearest
     * neighbour: a fourth kind arriving from a newer vault must not be drawn as
     * a trip.
     */
    private fun kindOf(kind: String): MemoryRow.Kind = when (kind) {
        "on-this-day" -> MemoryRow.Kind.KIND_ON_THIS_DAY
        "trip" -> MemoryRow.Kind.KIND_TRIP
        "similar" -> MemoryRow.Kind.KIND_SIMILAR
        else -> MemoryRow.Kind.KIND_UNSPECIFIED
    }

    // -----------------------------------------------------------------------
    // A trip's route: three legs after the shelf, folded onto the trip rows.
    // -----------------------------------------------------------------------

    /** A leg's page. A trip of more photographs than this sketches its first. */
    public const val ROUTE_LIMIT: Int = 500

    /** `photos.memories.members` — which photographs each trip holds, and in what order. */
    public fun membersQuery(memoryIds: List<String>): PageQuery? {
        if (memoryIds.isEmpty()) return null
        return PageQuery(
            name = "photos.memories.members",
            select = listOf("memory_id", "asset_id", "ordinal"),
            from = "media_memory_member",
            where_ = inList("memory_id", memoryIds.size),
            bind = memoryIds.map { Value(text = it) },
            order = PageOrder(sort_column = "memory_id", pk_column = "asset_id"),
        )
    }

    /**
     * `photos.memories.memberPlaces` — where each member was taken. Live
     * photographs only: a memory is computed over the live library, so a
     * trashed photograph leaves the route rather than bending it.
     */
    public fun memberPlacesQuery(assetIds: List<String>): PageQuery? {
        if (assetIds.isEmpty()) return null
        return PageQuery(
            name = "photos.memories.memberPlaces",
            select = listOf("asset_id", "captured_at", "place_id"),
            from = "media_asset",
            where_ = inList("asset_id", assetIds.size) +
                " AND deleted_at IS NULL AND place_id IS NOT NULL",
            bind = assetIds.map { Value(text = it) },
            order = PageOrder(sort_column = "asset_id", pk_column = "asset_id"),
        )
    }

    /** `photos.memories.stops` — the places those are, with their pins. */
    public fun stopsQuery(placeIds: List<String>): PageQuery? {
        if (placeIds.isEmpty()) return null
        return PageQuery(
            name = "photos.memories.stops",
            select = listOf("place_id", "name", "geo_lat", "geo_lng"),
            from = "core_place",
            where_ = inList("place_id", placeIds.size),
            bind = placeIds.map { Value(text = it) },
            order = PageOrder(sort_column = "place_id", pk_column = "place_id"),
        )
    }

    /** The trips on a page, whose routes are worth reading. */
    public fun tripIds(data: PhotosMemoriesData): List<String> = data.memories
        .filter { it.kind == MemoryRow.Kind.KIND_TRIP }
        .map { it.memory_id }

    /** The asset ids the member leg named, for the next leg's predicate. */
    public fun memberAssetIds(memberRows: List<Row>): List<String> =
        memberRows.map { it.text(1) }.filter { it.isNotEmpty() }.distinct()

    /** The place ids the asset leg named, for the last leg's predicate. */
    public fun memberPlaceIds(assetRows: List<Row>): List<String> =
        assetRows.map { it.text(2) }.filter { it.isNotEmpty() }.distinct()

    /**
     * EACH TRIP'S ROUTE, AND ITS PLACE NAME WHEN THE PASS GAVE IT NONE.
     *
     * v0's `tripFacts`, the part a sketch needs: the members in the trip's
     * own order (`ordinal`, then capture time), each one's place, a repeat of
     * the stop before collapsed, and only places with a pin — a place with no
     * coordinate has nowhere to be drawn. The place NAME is the one most of the
     * trip's photographs were taken at, and only a readable one (v0 named a
     * trip from its members' places, never from a coordinate).
     *
     * A route with no stops is left empty and the view draws no sketch; a
     * one-stop trip is a dot and no line.
     */
    public fun withRoutes(
        data: PhotosMemoriesData,
        memberRows: List<Row>,
        assetRows: List<Row>,
        placeRows: List<Row>,
    ): PhotosMemoriesData {
        if (memberRows.isEmpty()) return data
        val taken = assetRows.associate { it.text(0) to (it.text(1) to it.text(2)) }
        val places = placeRows.associateBy { it.text(0) }
        val membersByTrip = memberRows.groupBy { it.text(0) }
        return data.copy(
            memories = data.memories.map { memory ->
                val members = membersByTrip[memory.memory_id]
                if (memory.kind != MemoryRow.Kind.KIND_TRIP || members.isNullOrEmpty()) {
                    return@map memory
                }
                val placeIds = members
                    .sortedWith(
                        compareBy<Row>({ it.integer(2) }, { taken[it.text(1)]?.first.orEmpty() }),
                    )
                    .mapNotNull { taken[it.text(1)]?.second?.ifEmpty { null } }
                val route = mutableListOf<MemoryStop>()
                for (placeId in placeIds) {
                    val place = places[placeId] ?: continue
                    val latitude = place.values.getOrNull(2)?.real ?: continue
                    val longitude = place.values.getOrNull(3)?.real ?: continue
                    if (route.lastOrNull()?.place_id == placeId) continue
                    route += MemoryStop(
                        place_id = placeId,
                        latitude = latitude,
                        longitude = longitude,
                    )
                }
                val named = placeIds
                    .mapNotNull { id -> places[id]?.let { PlacesReads.readableName(it.text(1)) } }
                    .groupingBy { it }
                    .eachCount()
                    .maxByOrNull { it.value }
                    ?.key
                memory.copy(
                    route = route,
                    place_name = memory.place_name.ifEmpty { named.orEmpty() },
                )
            },
        )
    }

    private fun inList(column: String, count: Int): String =
        column + " IN (" + List(count) { "?" }.joinToString(", ") + ")"

    private fun Row.integer(index: Int): Long = values.getOrNull(index)?.integer ?: 0L

    private const val MEMORY_ID: Int = 0
    private const val KIND: Int = 1
    private const val TITLE_HINT: Int = 2
    private const val DAY_KEY: Int = 3
    private const val STARTED_AT: Int = 4
    private const val ENDED_AT: Int = 5

    /** Positional, as the door states. See `HomeReads.text` for why only TEXT. */
    private fun Row.text(index: Int): String = values.getOrNull(index)?.text ?: ""
}
