package dev.centraid.shared.apps.photos

import centraid.core.v1.CommandStatus
import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.Row
import centraid.screen.v1.PlaceRow
import centraid.screen.v1.PlacesData
import centraid.screen.v1.PlacesEvent
import centraid.screen.v1.PlacesState
import centraid.screen.v1.ReadFailure
import dev.centraid.shared.sync.ScreenReads
import dev.centraid.shared.sync.ScreenWrites

/**
 * THE PLACES THEMSELVES (#1029, photos port).
 *
 * The statement is `crates/apps/photos`' own — `photos.shared.places` in
 * `places.rs`: `core_place`, every row, ordered by `place_id`. Followed rather
 * than re-derived, for `PhotosReads`' reason: a shelf in a different order from
 * the desktop's over the same rows is two libraries. `tz` is the one column
 * this read adds, because `PlaceRow.time_zone` is on the contract and the
 * desktop's own statement has no field for it.
 *
 * **A WALK IS SAFE HERE AND IS NOT SAFE ON THE LIBRARY.** `place_id` is the
 * primary key and therefore NOT NULL, so a continued page keeps its meaning;
 * `media_asset.captured_at` is nullable, which is why [PlacesAssetReads] below
 * takes exactly one page and says so. `places.rs` calls this table
 * "owner-shaped and small" and reads it as a bounded walk, which is what
 * [limit] mirrors.
 *
 * ## The phrase ladder stops at rung one here, and that is a gap worth naming
 *
 * `place_phrase` (`docs/photos/places.md`, layer 2) resolves a place in four
 * falling rungs: the member's own name, a hedged gazetteer name, a phrase
 * relative to a named anchor, and finally [PlacesMachine.NO_NAME]. Only the
 * first and the last are reachable from a page read. Rung 2's name is buried
 * inside `core_place.address_json` and rung 3 needs the member's home and a
 * bearing — so this read resolves rung 1 or falls to rung 4 rather than
 * hand-rolling a JSON parser and a great-circle in a reducer. The ladder is the
 * vault's and a second implementation of it in a shell is a second answer to
 * "what is this place called". What is missing is a phrase ON THE DOOR; until
 * there is one, a gazetteer-named place reads as unnamed on the phone.
 *
 * **A COORDINATE IS NEVER A NAME.** `find_or_create_place`'s third rung mints a
 * row whose stored `name` is its own coordinates, and `printable_name` refuses
 * one at every rung — which is why [readableName] refuses it here too. Without
 * that check every unnamed place on the phone would print digits that look like
 * an answer.
 */
public object PlacesReads :
    ScreenReads<PlacesState, PlacesEvent>,
    ScreenWrites<PlacesState, PlacesEvent> {
    override val screenId: String = PlacesMachine.SCREEN_ID

    /** `core_place`, one of the two tables the machine's `rowsChanged` declares. */
    override val table: String = PlacesMachine.PLACES_TABLE

    /**
     * The door's own ceiling (`MAX_PAGE_ROWS`, `query.proto:126`).
     *
     * A place shelf is not scrolled the way a library is — it is read at a
     * glance and tapped — so the page is as large as the door allows and the
     * walk exists for the vault that outgrew it rather than for the scroll.
     */
    override val limit: Int = 500

    override val appId: String = "photos"

    override fun query(state: PlacesState, afterCursor: String?): PageQuery = PageQuery(
        name = "photos.places.shelf",
        // THE SELECT CARRIES BOTH ORDER COLUMNS — here the same column twice,
        // which is what `places_statement` does too: the door has no `key_of`
        // callback and reads the cursor off the row by the two columns the
        // ORDER BY names.
        select = listOf("place_id", "name", "geo_lat", "geo_lng", "tz"),
        from = table,
        order = PageOrder(sort_column = "place_id", pk_column = "place_id", descending = false),
    )

    override fun arrived(rows: List<Row>, nextCursor: String?): PlacesEvent = PlacesEvent(
        data_ = PlacesEvent.DataArrived(
            data_ = PlacesData(
                places = rows.map(::placeOf),
                next_cursor = nextCursor,
                // NOT THIS PASS'S QUESTION. `unplaced_count` is a fact about
                // assets with no place, and this statement never looks at an
                // asset. Zero here means "not answered by me", and
                // `PlacesMachine.merge` is what keeps that from being read as
                // "none" — see its `maxOf`.
            ),
        ),
    )

    override fun refused(failure: ReadFailure): PlacesEvent =
        PlacesEvent(refused = PlacesEvent.ReadRefused(failure = failure))

    /**
     * The rename's outcome, as this screen's own settle event.
     *
     * **ONLY `EXECUTED` IS COMMITTED.** `QUEUED`, `IN_FLIGHT` and `PARKED` all
     * say the same thing — somewhere durable, not yet committed — and
     * `PlacesEvent.WriteSettled` is a BOOLEAN, so folding them into `true`
     * would be the shell claiming a commit that has not happened and re-reading
     * a name the vault has not written. They land as `false` with the core's
     * own sentence, which is the conservative half of a two-valued field that
     * has five answers to carry.
     */
    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): PlacesEvent =
        PlacesEvent(
            write_settled = PlacesEvent.WriteSettled(
                committed = status == CommandStatus.COMMAND_STATUS_EXECUTED,
                sentence = sentence,
            ),
        )

    /**
     * One card's identity, out of one `core_place` row.
     *
     * `asset_count` and `cover_thumbnail_path` are deliberately absent: they are
     * [PlacesAssetReads]' half of the join, and a zero invented here would be a
     * zero `PlacesMachine.merge` could not tell from a real one.
     */
    private fun placeOf(row: Row): PlaceRow {
        val latitude = row.real(LATITUDE)
        val longitude = row.real(LONGITUDE)
        return PlaceRow(
            place_id = row.text(PLACE_ID),
            name = readableName(row.text(NAME)) ?: PlacesMachine.NO_NAME,
            // BOTH OR NEITHER, AND `has_coordinate` IS WHAT SAYS WHICH. The
            // DDL allows one coordinate without the other, and a row with half
            // a pin is a row the plot cannot draw — drawing it at 0,0 would put
            // a member's photographs in the Gulf of Guinea, which is a real
            // place and the reason this flag exists at all.
            latitude = latitude ?: 0.0,
            longitude = longitude ?: 0.0,
            has_coordinate = latitude != null && longitude != null,
            time_zone = row.text(TIME_ZONE),
        )
    }

    /**
     * A name a member may read, or null.
     *
     * Mirrors `printable_name` in `crates/apps/photos/src/places.rs`: non-empty
     * once trimmed, and **not coordinate-shaped**. The shape test is
     * `is_coordinate_label`'s — two signed decimals around a comma, one to
     * three whole digits each — and it is what stops the gazetteer or the
     * mint-by-coordinate rung leaking digits into a card that reads as a name.
     */
    internal fun readableName(name: String): String? {
        val text = name.trim()
        if (text.isEmpty() || isCoordinateLabel(text)) return null
        return text
    }

    private fun isCoordinateLabel(text: String): Boolean {
        val comma = text.indexOf(',')
        if (comma < 0) return false
        return signedDecimal(text.substring(0, comma)) &&
            signedDecimal(text.substring(comma + 1).trimStart())
    }

    private fun signedDecimal(text: String): Boolean {
        val body = text.removePrefix("-")
        val dot = body.indexOf('.')
        if (dot < 0) return false
        val whole = body.substring(0, dot)
        val fraction = body.substring(dot + 1)
        return whole.length in 1..3 &&
            whole.all { it in '0'..'9' } &&
            fraction.isNotEmpty() &&
            fraction.all { it in '0'..'9' }
    }

    private const val PLACE_ID: Int = 0
    private const val NAME: Int = 1
    private const val LATITUDE: Int = 2
    private const val LONGITUDE: Int = 3
    private const val TIME_ZONE: Int = 4

    /** Positional, as the door states. See `HomeReads.text` for why only TEXT. */
    private fun Row.text(index: Int): String = values.getOrNull(index)?.text ?: ""

    /**
     * A REAL COLUMN OR NOTHING — never a coerced zero.
     *
     * `geo_lat`/`geo_lng` are `REAL` in the DDL and a NULL arrives on the
     * `null` arm, so `real` is absent rather than zero. `places-model.ts` has
     * the same guard and the same comment: "Number column or nothing — never
     * coerce". A coordinate coerced from a missing column is a pin on the
     * equator.
     */
    private fun Row.real(index: Int): Double? = values.getOrNull(index)?.real
}

/**
 * HOW MANY PHOTOGRAPHS ARE AT EACH PLACE, AND HOW MANY ARE AT NONE.
 *
 * The counting half of the Places join. The door has no `COUNT(*)` and no join
 * clause, so the count is derived the only way it can be: read the library's own
 * page and count the rows in `arrived`.
 *
 * **THE STATEMENT IS THE LIBRARY'S** — `photos.library.live` in `queries.rs`:
 * `deleted_at IS NULL AND archived_at IS NULL`, ordered `captured_at DESC,
 * asset_id DESC`. Two things follow from using it rather than inventing one:
 * the cover a place shows is the NEWEST photograph taken there, which is what
 * `placeCards` picked, and the trash and the archive are excluded, which is what
 * `assetsAtPlace` did.
 *
 * ## ONE PAGE, AND THE COUNT IS A FLOOR BEYOND IT
 *
 * `captured_at` is NULLABLE, and a keyset continuation over a nullable sort
 * column silently drops rows — `KitError::NullableSortKey` is what refuses one
 * on the desktop. So this pass takes exactly one page of [limit] rows and never
 * continues: `arrived` reports no cursor, and `PlacesMachine.merge` keeps the
 * place walk's cursor instead.
 *
 * On a library larger than [limit] the counts and `unplaced_count` are
 * therefore a FLOOR, not a total — and the contract says so:
 * `PlaceRow.asset_count_capped` and `PlacesData.unplaced_count_capped` are set
 * whenever the page filled, and the views then read "at least N". A bare number
 * that quietly stopped at one page would answer "is this map my library or a
 * corner of it" wrong, which is the one question `unplaced_count` exists for.
 *
 * The flag is per PAGE and not per place: when the page filled, ANY place could
 * have more assets beyond it, so every row on that answer is capped. A flag set
 * per row would be a claim this read cannot make about the rows it did not see.
 */
public object PlacesAssetReads : ScreenReads<PlacesState, PlacesEvent> {
    override val screenId: String = PlacesMachine.ASSETS_SCREEN_ID

    /** `media_asset`, the other table the machine's `rowsChanged` declares. */
    override val table: String = PlacesMachine.ASSETS_TABLE

    /** The door's ceiling (`MAX_PAGE_ROWS`). See the class note on the floor. */
    override val limit: Int = 500

    override fun query(state: PlacesState, afterCursor: String?): PageQuery = PageQuery(
        name = "photos.places.counts",
        select = listOf("asset_id", "captured_at", "place_id"),
        from = table,
        where_ = "deleted_at IS NULL AND archived_at IS NULL",
        order = PageOrder(sort_column = "captured_at", pk_column = "asset_id", descending = true),
        // THE COVER, RESOLVED IN THE SAME STATEMENT (`with_held_thumbnail`,
        // D-1025-S7-20). Without it a card would need a second trip through the
        // byte door per place, which is what left every cell of the grid drawing
        // a placeholder over a device that held the photographs.
        with_held_thumbnail = true,
    )

    override fun arrived(rows: List<Row>, nextCursor: String?): PlacesEvent {
        // THE PAGE FILLED, SO THE COUNTS STOPPED SHORT OF THE LIBRARY.
        //
        // Either signal is enough and both are read: a cursor means the door
        // has more to give, and a full page means it reached the ceiling this
        // read asked for. They usually agree; where they do not, the honest
        // answer is the one that admits the floor.
        val capped = nextCursor != null || rows.size >= limit
        var unplaced = 0
        val counts = LinkedHashMap<String, Int>()
        val covers = LinkedHashMap<String, String>()
        rows.forEach { row ->
            val placeId = row.text(PLACE_ID)
            if (placeId.isEmpty()) {
                // NO `place_id` AT ALL — which is not the same as a place with
                // no coordinate. `assetsWithNoPlace` kept the two apart in v0
                // and the distinction is the whole point of `unplaced_count`:
                // unplottable is not unlocated.
                unplaced += 1
                return@forEach
            }
            counts[placeId] = (counts[placeId] ?: 0) + 1
            // THE FIRST THUMBNAIL IN CAPTURE ORDER, so the cover is the newest
            // photograph at the place that this device actually holds bytes
            // for. `putIfAbsent` semantics by hand: a later row must not
            // replace a cover already chosen.
            val thumbnail = row.text(THUMBNAIL)
            if (thumbnail.isNotEmpty() && !covers.containsKey(placeId)) covers[placeId] = thumbnail
        }
        return PlacesEvent(
            data_ = PlacesEvent.DataArrived(
                data_ = PlacesData(
                    places = counts.map { (placeId, count) ->
                        PlaceRow(
                            place_id = placeId,
                            // NO NAME, NO PIN, NO ZONE. This statement never
                            // read `core_place`, and a row that guessed would
                            // be the guess `PlacesMachine.merge` then has to
                            // prefer over the real answer.
                            asset_count = count,
                            asset_count_capped = capped,
                            cover_thumbnail_path = covers[placeId],
                        )
                    },
                    // NO CURSOR, DELIBERATELY. See the class note: a
                    // continuation over `captured_at` drops NULLs, and
                    // `PlacesData.next_cursor` belongs to the place walk. The
                    // cursor is not dropped without trace, though — it is what
                    // [capped] was read from.
                    unplaced_count = unplaced,
                    unplaced_count_capped = capped,
                ),
            ),
        )
    }

    override fun refused(failure: ReadFailure): PlacesEvent =
        PlacesEvent(refused = PlacesEvent.ReadRefused(failure = failure))

    private const val PLACE_ID: Int = 2

    /**
     * The door's first appended column, after the three `select` named.
     *
     * `with_held_thumbnail` appends THREE in a fixed order — the path, the
     * original's hash and whether the original is held (`crates/core`'s
     * `api::page`) — and this read uses only the first. The other two answer
     * "may this member fetch the full-size file", which is a CELL's question
     * and not a card's: a place card draws a cover, never a download arrow.
     */
    private const val THUMBNAIL: Int = 3

    private fun Row.text(index: Int): String = values.getOrNull(index)?.text ?: ""
}
