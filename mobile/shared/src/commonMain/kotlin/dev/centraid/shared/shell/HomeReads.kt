package dev.centraid.shared.shell

import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.HomeEvent
import centraid.screen.v1.TileBody
import centraid.screen.v1.TileCount
import centraid.screen.v1.TileStatus
import dev.centraid.design.copy.DocsCopy
import dev.centraid.design.copy.LockerCopy
import dev.centraid.design.copy.NotesCopy
import dev.centraid.design.copy.PeopleCopy
import dev.centraid.design.copy.PhotosCopy
import dev.centraid.design.copy.TallyCopy
import dev.centraid.design.copy.TasksCopy
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
 * ## Locker counts, and shows nothing (#1047)
 *
 * Its read selects an id and an order column — no title, no username, no
 * sealed cell — so the tile says how many live items there are and whether
 * the Locker is open ([lockerOpen]), which is all a launcher may say about a
 * place that holds secrets.
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

    /** The trash predicate every soft-deleting table's tile read carries. */
    private const val NOT_TRASHED: String = "deleted_at IS NULL"

    /** `schedule_task.status`'s two open values, from the DDL's CHECK. */
    private val OPEN_TASK_STATUSES: List<String> = listOf("needs-action", "in-process")

    /**
     * One app's read: the statement, and the nouns its count is spoken with.
     *
     * The label is the noun a screen reader says after the number ("812
     * photographs"), never the glyph — the em dash a withheld count draws is
     * not a word. It AGREES WITH THE NUMBER (#1047): "1 group", not "1
     * groups", so each read carries both forms from its app's copy and
     * [countLabel] picks one.
     */
    public data class TileRead(
        val appId: String,
        val query: PageQuery,
        val countOne: String,
        val countMany: String,
        /**
         * Tables the query's filter READS besides [PageQuery.from] — a
         * subquery's — so a change on them redraws the tile too (#1047).
         */
        val alsoReads: Set<String> = emptySet(),
    ) {
        /** The noun for [count] rows: singular at exactly one uncapped row. */
        public fun countLabel(count: Int, capped: Boolean): String = countNoun(count, capped, countOne, countMany)
    }

    /**
     * Singular only at exactly one, and never when capped — "1+" is a floor,
     * not a count of one. Zero takes the plural ("0 groups"). Agenda's tile
     * speaks through here too, so every tile agrees on the rule.
     */
    public fun countNoun(count: Int, capped: Boolean, one: String, many: String): String =
        if (count == 1 && !capped) one else many

    /** The People tile's foot: how many more than the faces, or that every face is shown. */
    public fun peopleMore(more: Int): String =
        if (more > 0) PeopleCopy.TILE_MORE.replace("{n}", more.toString()) else PeopleCopy.TILE_EVERYONE

    private fun order(sort: String, pk: String, descending: Boolean = true) =
        PageOrder(sort_column = sort, pk_column = pk, descending = descending)

    /**
     * Every tile's PAGE read, in [SpringboardPolicy.SPRINGBOARD_ORDER].
     * Agenda's is an app query and is [HomeAgendaTile]'s.
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
            countOne = PhotosCopy.TILE_COUNT_ONE,
            countMany = PhotosCopy.TILE_COUNT_MANY,
        ),
        TileRead(
            appId = "docs",
            query = PageQuery(
                name = "home.docs",
                select = listOf("document_id", "title", "updated_at"),
                from = "core_document",
                // THE TRASH IS NOT THE LIBRARY (#1046's audit). A deleted
                // document keeps its row for the restore window, and a
                // launcher that counted it would tell a member they hold a
                // file they threw away.
                where_ = NOT_TRASHED,
                order = order("updated_at", "document_id"),
                // THE SIZE IS A COMPUTED COLUMN THE VAULT APPENDS, and asking
                // for it is the whole of what this tile had to do. `core_document`
                // carries `current_content_id`, which is what the correlated
                // subquery correlates on — set this flag on a table that does not
                // and the page is REFUSED at prepare, never answered with nulls.
                with_document_size = true,
            ),
            countOne = DocsCopy.DOCUMENT_ONE,
            countMany = DocsCopy.DOCUMENT_MANY,
        ),
        TileRead(
            appId = "notes",
            query = PageQuery(
                name = "home.notes",
                select = listOf("note_id", "title", "updated_at"),
                from = "knowledge_note",
                // Notes' own filter (`NotesReads`), for the Docs tile's reason.
                where_ = NOT_TRASHED,
                order = order("updated_at", "note_id"),
            ),
            countOne = NotesCopy.TILE_COUNT_ONE,
            countMany = NotesCopy.TILE_COUNT_MANY,
        ),
        // AGENDA IS NOT A PAGE READ (#1046). Its tile is the next occurrence
        // of whatever repeats, which only the core's recurrence engine can
        // answer, so it rides the app-query arm: `HomeAgendaTile`.
        TileRead(
            appId = "tasks",
            query = PageQuery(
                name = "home.tasks",
                select = listOf("task_id", "title", "status"),
                from = "schedule_task",
                // OPEN WORK, NOT TRASHED (#1046's audit). The tile is "the
                // next thing to do", and a finished or cancelled task is not
                // one — counted, a vault with one open task reads as every
                // task it ever held. The two open statuses are the DDL
                // CHECK's, bound rather than spliced.
                where_ = "$NOT_TRASHED AND status IN (?, ?)",
                bind = OPEN_TASK_STATUSES.map { Value(text = it) },
                order = order("task_id", "task_id"),
            ),
            countOne = TasksCopy.TASK_ONE,
            countMany = TasksCopy.TASK_MANY,
        ),
        TileRead(
            appId = "people",
            query = PageQuery(
                name = "home.people",
                select = listOf("party_id", "display_name", "updated_at"),
                from = "core_party",
                // THE PEOPLE THE ROSTER LISTS, NOT EVERY PARTY (#1047): a
                // party is anyone the vault names — the owner, a merchant, a
                // face — and the People app's roster is the parties with a
                // live profile. Counted off `core_party`, the tile said 8 over
                // a roster of 4.
                where_ = "party_id IN (SELECT party_id FROM people_profile WHERE deleted_at IS NULL)",
                order = order("updated_at", "party_id"),
            ),
            countOne = PeopleCopy.TILE_COUNT_ONE,
            countMany = PeopleCopy.TILE_COUNT_MANY,
            alsoReads = setOf("people_profile"),
        ),
        TileRead(
            appId = "tally",
            query = PageQuery(
                name = "home.tally",
                select = listOf("group_id", "currency"),
                from = "tally_group",
                order = order("group_id", "group_id"),
            ),
            countOne = TallyCopy.TILE_COUNT_ONE,
            countMany = TallyCopy.TILE_COUNT_MANY,
        ),
        // LOCKER COUNTS ITS ITEMS AND SHOWS NONE OF THEM (#1047, D-5): the
        // read selects the id and the order column and nothing a member
        // wrote, so a locked Locker's tile carries no title, no username and
        // no secret — only how many live items there are, and whether the
        // Locker is open ([lockerOpen]).
        TileRead(
            appId = "locker",
            query = PageQuery(
                name = "home.locker",
                select = listOf("item_id", "updated_at"),
                from = "locker_item",
                where_ = "$NOT_TRASHED AND archived_at IS NULL",
                order = order("updated_at", "item_id"),
            ),
            countOne = LockerCopy.TILE_COUNT_ONE,
            countMany = LockerCopy.TILE_COUNT_MANY,
        ),
    )

    /**
     * WHETHER LOCKER IS OPEN, as the Locker gate says (#1047). A slot the
     * shell owns and `apps.locker` fills, so Home never names an app's types
     * (`PerAppLayoutSpec`); closed until something says otherwise.
     */
    public var lockerOpen: () -> Boolean = { false }

    /**
     * THE TABLES HOME COUNTS, DERIVED FROM THE READS THEMSELVES (#1025 S5).
     *
     * Not a second list. A hand-written set beside [READS] is the exact shape
     * that goes quietly stale: a tile whose query moves to another table stops
     * redrawing on sync, nothing fails, and the symptom is a count that is right
     * only after a relaunch. Deriving it means there is one place a table is
     * named and it is the query that reads it — and for Agenda's app query,
     * which names no table the runtime can see, it is [HomeAgendaTile.TABLES].
     */
    public val TABLES: Set<String> =
        READS.flatMap { listOf(it.query.from) + it.alsoReads }.toSet() + HomeAgendaTile.TABLES

    /**
     * Every app whose tile is READ — the page reads and the app queries —
     * which is every tile, Locker's included since #1047 (a count, never a row).
     */
    public val READ_APP_IDS: Set<String> =
        READS.map { it.appId }.toSet() + HomeAgendaTile.APP_ID

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
        val label = read?.countLabel(rows.size, capped) ?: ""
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
                body = bodyFor(appId, rows, capped),
            ),
        )
    }

    /**
     * THE ROWS THE PHOTOS MOSAIC DRAWS: the newest [PHOTO_CELLS] that have a
     * thumbnail to draw.
     *
     * An asset can have none for a reason that never goes away — a video with
     * no poster frame has no thumbnail row to resolve a path from — and taking
     * the newest four as they come left such a vault's strip with a blank cell
     * for as long as that asset stayed among them. So the cells skip over them.
     *
     * **When NO row in the window is drawable the newest four are kept as they
     * are**: that is the "these photographs are not on this device yet" state,
     * whose grey strip and sentence are the truthful answer, and an empty
     * `cells` would draw as a tile with a count and nothing beneath it. The
     * count and the label are still every row's — only the strip is chosen.
     */
    private fun mosaicRows(rows: List<Row>): List<Row> {
        val drawable = rows.filter { it.text(PHOTO_THUMBNAIL).isNotEmpty() }
        return (drawable.ifEmpty { rows }).take(PHOTO_CELLS)
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
        capped: Boolean,
    ): TileBody? {
        val preview = rows.take(PREVIEW)
        return when (appId) {
            "photos" -> TileBody(
                photos = TileBody.Photos(
                    // FOUR CELLS, one row, fixed count — only the cell contents
                    // change. [mosaicRows] says which rows: the newest that can
                    // be DRAWN, so an asset with no thumbnail (a video with no
                    // poster) is stepped over for the next photograph instead
                    // of holding a permanently blank cell in the strip.
                    cells = mosaicRows(rows).map { row ->
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

            "tasks" -> TileBody(
                tasks = TileBody.Tasks(
                    rows = preview.map { row ->
                        TileBody.Tasks.Row(
                            task_id = row.text(0),
                            title = row.text(1),
                            // v0's own vocabulary: `completed`, not `done`.
                            // FALSE ON EVERY ROW THIS READ RETURNS, since it
                            // reads open work only; kept so the field says what
                            // the row is rather than what the filter implies.
                            done = row.text(2) == "completed",
                        )
                    },
                ),
            )

            "people" -> (rows.size - preview.size).coerceAtLeast(0).let { more ->
                TileBody(
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
                    more = more,
                    more_label = peopleMore(more),
                ),
            )
            }

            // Tally's figure is a BALANCE, and a balance is derived by the
            // app's own projection (`tally.dashboard`'s valuation) rather than
            // counted off a table, so this tile states NO figure until that
            // projection is wired into Home. What it can stand behind is the
            // count, WITH ITS NOUN: the header draws the bare number, and a
            // body of nothing under "Tally 1" read as a tile that had failed
            // to load. The caption is that number and its noun, from the
            // tile's own count label; `figure` is absent, which a renderer
            // draws as the caption alone.
            "tally" -> TileBody(
                tally = TileBody.Tally(
                    caption = "${rows.size}${if (capped) "+" else ""} " +
                        (READS.firstOrNull { it.appId == "tally" }?.countLabel(rows.size, capped) ?: ""),
                ),
            )

            // A STATE AND ITS WORDS, never a row (the read carries none).
            "locker" -> lockerOpen().let { open ->
                TileBody(
                    locker = TileBody.Locker(
                        locked = !open,
                        state_label = if (open) LockerCopy.TILE_OPEN else LockerCopy.TILE_LOCKED,
                        line = if (open) LockerCopy.TILE_OPEN_LINE else LockerCopy.TILE_LOCKED_LINE,
                    ),
                )
            }

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
