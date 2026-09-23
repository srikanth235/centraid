package dev.centraid.shared.shell

import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.Row
import centraid.screen.v1.HomeEvent
import centraid.screen.v1.TileBody
import centraid.screen.v1.TileCount
import centraid.screen.v1.TileStatus
import dev.centraid.shared.design.PartyHueWheel

/**
 * WHAT EACH HOME TILE READS, AND WHAT IT MAKES OF THE ROWS (#1020, wave A).
 *
 * The seam: this file answers "what does THIS app's tile say" over rows and
 * grows with the app roster, and [SpringboardPolicy] never touches a row.
 *
 * ## The count is the read's own ceiling
 *
 * There is no `COUNT(*)` on this door — a `PageRequest` returns rows. So a
 * tile's count is **the number of rows that came back**, and `capped` is true
 * when the read filled its limit. That is not a workaround: it is exactly what
 * `TileCount.capped` means and what v0's `countCapped` meant, and it is why the
 * tile renders `812+` rather than a number it cannot stand behind. A tile that
 * asked for a total would be asking the vault to scan a table to decorate a
 * launcher.
 *
 * ## Absent is not zero, on every one of them
 *
 * A read that was refused produces no `TileArrived` at all — the shell sends
 * [HomeEvent.TileRefused] instead and the machine grades the tile `UNKNOWN`. A
 * read that landed and returned nothing produces `EMPTY`. Those are different
 * screens and this file never collapses them, which is the whole reason Home
 * has a fourth state.
 *
 * ## Locker is not here
 *
 * Its tile body is a STATE — locked or unlocked — and not a query result, so it
 * has no read. `Reads` in `ScreenHost`'s effect runner supplies it from the
 * lock's own state. A `SELECT` over `locker_item` to decorate a launcher would
 * also be a count of a member's secrets computed for no one who asked.
 */
public object HomeReads {
    /**
     * The read ceiling, which is also the count's ceiling.
     *
     * v0 clamps a page at 500 rows (`window.ts:78`) and Home asked for far
     * fewer: a launcher tile shows three rows and a number, and a thousand-row
     * scan to compute the number is a scan a member waits for. Two hundred is
     * enough that a real vault's Photos count is honest for a long while and
     * small enough that `capped` is reachable in a demo.
     */
    public const val LIMIT: Int = 200

    /** How many rows a body actually draws. The rest are only counted. */
    public const val PREVIEW: Int = 3

    /**
     * Photos draws FOUR, not [PREVIEW]'s three.
     *
     * Its body is a mosaic rather than a list, and four cells in one row is the
     * hand-off's geometry: three would leave a quarter of the tile empty and
     * five would make each cell too small to be a photograph.
     */
    public const val PHOTO_CELLS: Int = 4

    /**
     * Where the door puts `thumbnail_path` on the photos read: after the three
     * columns it named. A constant, because it moves with that `select` list.
     */
    private const val PHOTO_THUMBNAIL: Int = 3

    /**
     * Where the door puts `document_size` on the docs read: after the three
     * columns it named, exactly as [PHOTO_THUMBNAIL] sits after its own. A
     * constant for the same reason — it moves with that `select` list, and a
     * literal `3` in the row builder would be a second place to forget.
     */
    private const val DOC_SIZE: Int = 3

    /**
     * One app's read: the statement, and the label its count is spoken with.
     *
     * `countLabel` is the noun a screen reader says after the number ("812
     * photographs"), never the glyph — the em dash a withheld count draws is
     * not a word.
     */
    public data class TileRead(
        val appId: String,
        val query: PageQuery,
        val countLabel: String,
    )

    private fun order(sort: String, pk: String, descending: Boolean = true) =
        PageOrder(sort_column = sort, pk_column = pk, descending = descending)

    /**
     * Every tile's read, in [SpringboardPolicy.SPRINGBOARD_ORDER].
     *
     * The order is the grid's, not an execution order: they are fanned out and
     * land independently, which is why a tile is an event.
     *
     * **The `select` carries both order columns**, which the door requires:
     * there is no `key_of` callback, so the cursor is read off the row by the
     * two columns the ORDER BY names.
     */
    public val READS: List<TileRead> = listOf(
        TileRead(
            appId = "photos",
            query = PageQuery(
                name = "home.photos",
                // `content_id` IS NO LONGER SELECTED and the byte-door trip
                // is gone with it (D-1025-S7-20): `with_held_thumbnail` makes
                // the door append a `thumbnail_path` resolved from the bytes
                // this device holds, in this statement, for these rows. The
                // mosaic used to be the ONE place in the product that made
                // that trip, which is why the photo GRID drew placeholders
                // over the same photographs the tile was drawing.
                select = listOf("asset_id", "title", "captured_at"),
                from = "media_asset",
                // Newest first: a launcher shows what just happened.
                order = order("captured_at", "asset_id"),
                with_held_thumbnail = true,
            ),
            countLabel = "photographs",
        ),
        TileRead(
            appId = "docs",
            query = PageQuery(
                name = "home.docs",
                select = listOf("document_id", "title", "updated_at"),
                from = "core_document",
                order = order("updated_at", "document_id"),
                // THE SIZE IS A COMPUTED COLUMN THE VAULT APPENDS, and asking
                // for it is the whole of what this tile had to do. `core_document`
                // carries `current_content_id`, which is what the correlated
                // subquery correlates on — set this flag on a table that does not
                // and the page is REFUSED at prepare, never answered with nulls.
                with_document_size = true,
            ),
            countLabel = "documents",
        ),
        TileRead(
            appId = "notes",
            query = PageQuery(
                name = "home.notes",
                select = listOf("note_id", "title", "updated_at"),
                from = "knowledge_note",
                order = order("updated_at", "note_id"),
            ),
            countLabel = "notes",
        ),
        TileRead(
            appId = "agenda",
            query = PageQuery(
                name = "home.agenda",
                select = listOf("event_id", "summary", "dtstart"),
                from = "core_event",
                // ASCENDING, and it is the one tile that is: an agenda shows
                // what is coming, and "newest first" on a calendar is last
                // week.
                order = order("dtstart", "event_id", descending = false),
            ),
            countLabel = "events",
        ),
        TileRead(
            appId = "tasks",
            query = PageQuery(
                name = "home.tasks",
                select = listOf("task_id", "title", "status"),
                from = "schedule_task",
                order = order("task_id", "task_id"),
            ),
            countLabel = "tasks",
        ),
        TileRead(
            appId = "people",
            query = PageQuery(
                name = "home.people",
                select = listOf("party_id", "display_name", "updated_at"),
                from = "core_party",
                order = order("updated_at", "party_id"),
            ),
            countLabel = "people",
        ),
        TileRead(
            appId = "tally",
            query = PageQuery(
                name = "home.tally",
                select = listOf("group_id", "currency"),
                from = "tally_group",
                order = order("group_id", "group_id"),
            ),
            countLabel = "groups",
        ),
    )

    /**
     * THE TABLES HOME COUNTS, DERIVED FROM THE READS THEMSELVES (#1025 S5).
     *
     * Not a second list. A hand-written set beside [READS] is the exact shape
     * that goes quietly stale: a tile whose query moves to another table stops
     * redrawing on sync, nothing fails, and the symptom is a count that is right
     * only after a relaunch. Deriving it means there is one place a table is
     * named and it is the query that reads it.
     */
    public val TABLES: Set<String> = READS.map { it.query.from }.toSet()

    /**
     * The text of a row's column, or empty. Positional, as the door states.
     *
     * `Value` is a five-way oneof and only one arm is a string, so an INTEGER
     * column read through here comes back empty rather than as its digits. That
     * is correct for these reads — every column they select is TEXT in the DDL —
     * and it would be a visible blank rather than a silent coercion if one ever
     * stopped being.
     */
    private fun Row.text(index: Int): String =
        values.getOrNull(index)?.text ?: ""


    /**
     * The event one landed read produces.
     *
     * [rows] is what came back and [capped] says whether it filled the limit.
     * The body is built from the first [PREVIEW] of them; the count is all of
     * them.
     *
     * A photo cell's path is IN ITS ROW (`thumbnail_path`, the door's appended
     * column), so a tile body is still a finished message and there is no
     * second trip to sequence before it: a cell that arrived without its path
     * and acquired one later would be two states for one photograph.
     */
    public fun arrived(
        appId: String,
        rows: List<Row>,
        capped: Boolean,
    ): HomeEvent {
        val read = READS.firstOrNull { it.appId == appId }
        val label = read?.countLabel ?: ""
        if (rows.isEmpty()) {
            // EMPTY, not UNKNOWN: this read landed and the app holds nothing.
            // The count is still stated — zero is a true answer to "how many"
            // once a read has actually returned.
            return HomeEvent(
                tile = HomeEvent.TileArrived(
                    app_id = appId,
                    status = TileStatus.TILE_STATUS_EMPTY,
                    count = TileCount(value_ = 0),
                    count_label = label,
                ),
            )
        }
        return HomeEvent(
            tile = HomeEvent.TileArrived(
                app_id = appId,
                status = TileStatus.TILE_STATUS_CONTENT,
                count = TileCount(value_ = rows.size, capped = capped),
                count_label = label,
                body = bodyFor(appId, rows),
            ),
        )
    }

    /**
     * One app's body out of its own rows.
     *
     * Every branch here is a v0 selector, and the shapes are deliberately
     * unalike: Docs is ruled file rows and Notes is prose because a title over
     * an opening line made the two indistinguishable on the grid.
     */
    private fun bodyFor(
        appId: String,
        rows: List<Row>,
    ): TileBody? {
        val preview = rows.take(PREVIEW)
        return when (appId) {
            "photos" -> TileBody(
                photos = TileBody.Photos(
                    // FOUR CELLS, one row, fixed count — only the cell contents
                    // change. A cell with no addressable bytes is still a cell:
                    // dropping the row would reflow ten photographs as one
                    // blank under a "10".
                    cells = rows.take(PHOTO_CELLS).map { row ->
                        TileBody.Photos.Cell(
                            asset_id = row.text(0),
                            // ABSENT IS A REAL ANSWER, and it has more than one
                            // cause: the bytes have not reached this device, or
                            // they are a reading no surface may embed. Neither
                            // is an error and both draw the same cell.
                            // Index 3 is the door's APPENDED column, after the
                            // three this query named.
                            thumbnail_path = row.text(PHOTO_THUMBNAIL).ifEmpty { null },
                        )
                    },
                ),
            )

            "docs" -> TileBody(
                docs = TileBody.Docs(
                    rows = preview.map { row ->
                        TileBody.Docs.Row(
                            document_id = row.text(0),
                            name = row.text(1),
                            // A PHRASE THE VAULT SAID, NEVER A NUMBER THIS TILE
                            // TURNED INTO ONE. This used to read `size = ""`
                            // with a comment explaining that the size "is not
                            // read here" — true, and the reason the Docs tile
                            // drew a bare list against a handoff that rules a
                            // trailing meta column. The door now offers
                            // `with_document_size` and the vault projects the
                            // formatted phrase, so the contract's rule ("already
                            // formatted by the core, which knows the vault's
                            // locale; never formatted in a view from a byte
                            // count") is a shape rather than advice: the integer
                            // is removed from the row before it is served and
                            // there is no byte count here to format.
                            size = row.text(DOC_SIZE),
                        )
                    },
                ),
            )

            "notes" -> preview.firstOrNull()?.let { row ->
                TileBody(
                    notes = TileBody.Notes(
                        note_id = row.text(0),
                        title = row.text(1).ifEmpty { "Untitled" },
                        // The EXCERPT is the note's body, which lives in a
                        // content item this read does not join. Absent rather
                        // than invented: the renderer draws the title alone.
                        excerpt = "",
                    ),
                )
            }

            "agenda" -> preview.firstOrNull()?.let { row ->
                TileBody(
                    agenda = TileBody.Agenda(
                        title = row.text(1),
                        at = row.text(2).take(16).replace('T', ' '),
                        after = if (rows.size > 1) "and ${rows.size - 1} more" else "",
                    ),
                )
            }

            "tasks" -> TileBody(
                tasks = TileBody.Tasks(
                    rows = preview.map { row ->
                        TileBody.Tasks.Row(
                            task_id = row.text(0),
                            title = row.text(1),
                            // v0's own vocabulary: `completed`, not `done`.
                            done = row.text(2) == "completed",
                        )
                    },
                ),
            )

            "people" -> TileBody(
                people = TileBody.People(
                    faces = preview.map { row ->
                        TileBody.People.Face(
                            party_id = row.text(0),
                            initials = initials(row.text(1)),
                            // THE HUE IS RESOLVED HERE, ONCE, FOR BOTH SHELLS
                            // (#883, ruling O-identity). A face drawn without
                            // one is a grey disc, which is what Home drew until
                            // this line: the identity wheel was emitted, ported
                            // to Rust and never reached from a screen. Compose
                            // and SwiftUI could each have run it — and would
                            // have agreed by luck — so the answer travels in
                            // the message and a view's whole job is a lookup.
                            //
                            // `null` for the stored colour, and NOT a column
                            // this read forgot: `core_party` has no
                            // `avatar_color`. It carries `avatar_content_id` —
                            // a PHOTOGRAPH — and the only `avatar_color` this
                            // repository ever had was v0's `tally_friend`. So
                            // every face today is derived from `party_id`,
                            // which is the branch that matters anyway: a hue
                            // keyed off the display name would repaint a
                            // person the member recognises the moment they
                            // corrected a spelling.
                            color = PartyHueWheel.partyHueKey(row.text(0), null),
                        )
                    },
                    // From the HEADER TOTAL, never a fabricated 0: an exhausted
                    // directory says so plainly rather than claiming more.
                    more = (rows.size - preview.size).coerceAtLeast(0),
                ),
            )

            // Tally's figure is a BALANCE, and a balance is derived by the
            // app's own projection rather than counted off a table. The tile
            // says how many groups there are until that projection is wired,
            // and says nothing it cannot stand behind.
            "tally" -> null

            else -> null
        }
    }

    /**
     * A person's initials, from the display name.
     *
     * One letter for one word and two for more, which is v0's rule — and it
     * takes the FIRST and LAST word rather than the first two, because a
     * middle name is not the letter anybody recognises.
     */
    private fun initials(displayName: String): String {
        val words = displayName.trim().split(" ").filter { it.isNotEmpty() }
        return when (words.size) {
            0 -> "?"
            1 -> words[0].take(1).uppercase()
            else -> (words.first().take(1) + words.last().take(1)).uppercase()
        }
    }

}
