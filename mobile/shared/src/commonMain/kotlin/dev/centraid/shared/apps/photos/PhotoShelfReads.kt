package dev.centraid.shared.apps.photos

import centraid.core.v1.CommandStatus
import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.PhotoShelf
import centraid.screen.v1.PhotoShelfEvent
import centraid.screen.v1.PhotoShelfState
import centraid.screen.v1.PhotoStateView
import centraid.screen.v1.ReadFailure
import dev.centraid.shared.sync.ScreenReads
import dev.centraid.shared.sync.ScreenWrites

/**
 * WHAT A PHOTO SHELF READS (#1029, the photos port; #1135).
 *
 * Six predicates over one table, one order and one projection. The shelf is
 * the parameter; the STATEMENT is the only thing that changes, which is the
 * whole claim `PhotoShelfState` makes — and this file is where that claim is
 * either true or is four screens wearing one message.
 *
 * ## The projection is `PhotosReads`', called rather than copied
 *
 * [arrived] hands the rows to [PhotosReads.arrived] and re-wraps the
 * `PhotosGridData` it produced, after [asGridRow] has put each row into the
 * layout that function projects. The door's computed columns are APPENDED after
 * the named `select`, so their indices are a function of how many columns were
 * named — and `PhotosReads` holds those indices as constants against its own
 * five. A shelf that named a sixth column and handed the row over unchanged
 * would shift `thumbnail_path`, `original_hash` and `original_held` by one, and
 * every cell on every shelf would come back with a hash where its path should
 * be, silently. So [SELECT] begins with `PhotosReads`' five in its order, the
 * reshape is derived from [SELECT]`.size`, and `PhotoShelfSpec` asserts both
 * rather than trusting a comment.
 *
 * The prize is the one `PhotoCells.swift` names: ONE derivation of
 * `PhotoCell.Held` for every surface that draws a photograph. v0 had four and
 * only one of them ever grew the "no pack at all" sentence.
 *
 * ## The order is the library's, shelf by shelf
 *
 * Every shelf is `taken_at DESC, id DESC`, a timeline under a predicate, and the
 * trash's is `id DESC` (R-1135-5-17: the trash stamp is the `entity`'s, and the
 * door pages one table).
 *
 * **A NULL `taken_at` RIDES THE FIRST WINDOW AND NO OTHER**, which is
 * `PhotosReads`' inherited property and not a defect to patch here: the keyset
 * comparison `taken_at < ?` is false for NULL in SQL, and an undated photograph
 * has no place in a timeline cursor. The trash is the one shelf this cannot
 * touch: it sorts on the id, which has no NULL to drop.
 *
 * ## There is no join on this door, and there is no roster either
 *
 * Three of the six shelves are a membership — an album's members, a star, the
 * archive — and the door has no join clause. The honest shape would be two
 * reads: resolve the ids, then page the photographs. **`PhotoShelfState` has
 * nowhere to put a roster** (no field) and `PhotoShelfEvent` has no arm that
 * carries one, so a two-read walk cannot be expressed against this contract at
 * all; and a roster read at this screen's page limit would silently truncate a
 * shelf whose membership is longer than one page, which is worse than not
 * having it.
 *
 * So the membership rides in the PREDICATE, as `id IN (SELECT …)` over one
 * table at a time. That is not a join and not a fabricated column: it is the
 * door's own idiom — `with_held_thumbnail` is correlated subqueries in
 * `crates/vault/src/page.rs` — the paged read is still the photograph read, the
 * cursor still comes off `photo`, and every value is bound rather than
 * interpolated. The vault authorizes the subqueries against the tables a screen
 * may page.
 */
public object PhotoShelfReads :
    ScreenReads<PhotoShelfState, PhotoShelfEvent>,
    ScreenWrites<PhotoShelfState, PhotoShelfEvent> {
    override val screenId: String = PhotoShelfMachine.SCREEN_ID

    /**
     * `photo` — the table every arm pages, and the one the machine's
     * `rowsChanged` answers in photograph ids for. `entity` and `edge` move this
     * screen too, and the machine names them; this is the table the PAGE
     * comes from, which is the pairing `ScreenReads.table` is about.
     */
    override val table: String = "photo"

    /** A mosaic's page, the same as the library grid's. See `PhotosReads.limit`. */
    override val limit: Int = 120

    /**
     * THE PROJECTION: `PhotosReads`' FIVE, IN ITS ORDER.
     *
     * The first five are the cell's and may not be reordered or dropped —
     * [PhotosReads] projects a row positionally and this file hands it one.
     * [asGridRow] is derived from [SELECT]`.size`, so a sixth column added
     * here changes a number it reads off the list and nothing else.
     *
     * The trash orders by `id` and not by when a photograph was deleted: the
     * trash stamp is the `entity`'s, and the door pages one table (R-1135-5-17).
     * A photograph's id is minted in time order, so the trash reads newest-added
     * first.
     */
    private val SELECT: List<String> = listOf(
        "id",
        "taken_at",
        "offset_min",
        "form",
        "burst",
    )

    /**
     * How many of [SELECT] `PhotosReads` projects, and how many the door
     * appends behind it.
     *
     * `PhotosReads` names five real columns and asks for `with_held_thumbnail`,
     * which makes `crates/core`'s `api::page` append `thumbnail_path`,
     * `original_hash` and `original_held` in that order — three, fixed by
     * `crates/vault/src/page.rs` and not by anything here.
     */
    private const val CELL_COLUMNS: Int = 5
    private const val COMPUTED_COLUMNS: Int = 3

    /** The live library: not trashed, not put away, not folded under an edit. `PhotosReads`' predicate. */
    private const val LIVE: String = PhotoFold.LIVE

    /** A STAR IS A FLAG EDGE: the favourites shelf's predicate ([PhotoFold.STARRED]). */
    private const val STARRED: String = PhotoFold.STARRED

    /** An album's members: the `contains` edges from it. Its id is bound. */
    private const val IN_ALBUM: String = "id IN (SELECT to_id FROM edge WHERE from_id = ? AND rel = 'contains')"

    /**
     * The statement for whichever shelf is open, or null before one is.
     *
     * Null is a real answer and `ScreenRuntime` turns it into a sentence rather
     * than into silence: a shelf opened without its parameter must not become
     * an unbound read of the whole library, which is what the four v0 screens
     * would each have had to guard for themselves.
     *
     * [afterCursor] is not consulted: the keyset cursor rides `PageRequest.after`
     * and the door builds the tuple comparison itself, so a predicate that
     * mentioned the cursor would apply it twice.
     */
    override fun query(state: PhotoShelfState, afterCursor: String?): PageQuery? {
        val shelf = state.shelf ?: return null
        val arm = armOf(shelf) ?: return null
        return PageQuery(
            name = arm.name,
            select = SELECT,
            from = table,
            where_ = arm.where,
            bind = arm.bind,
            // THE ORDER IS THE ARM'S, because the desktop's is. Seven shelves
            // are a timeline and sort by capture; the trash is a record of what
            // a member did and sorts by when they did it.
            order = PageOrder(
                sort_column = arm.sortColumn,
                pk_column = "id",
                descending = true,
            ),
            // THE DOOR RESOLVES WHAT THIS DEVICE HOLDS, IN THE SAME STATEMENT
            // (`with_held_thumbnail`, D-1025-S7-20). Without it every cell of a
            // hundred-and-twenty-row page draws a placeholder over a device
            // that is holding the photographs.
            with_held_thumbnail = true,
        )
    }

    /**
     * One arm's statement: a name for the log, a predicate, its binds and the
     * column it sorts on.
     *
     * [sortColumn] defaults to the timeline's, because six of the seven
     * shelves ARE the timeline under a predicate. The trash overrides it, and
     * it is the only arm that does.
     */
    private data class Arm(
        val name: String,
        val where: String,
        val bind: List<Value> = emptyList(),
        val sortColumn: String = "taken_at",
    )

    private fun armOf(shelf: PhotoShelf): Arm? {
        val album = shelf.album
        val place = shelf.place
        val view = shelf.state_view
        return when {
            // AN ALBUM SHOWS ARCHIVED PHOTOGRAPHS AND THE LIBRARY DOES NOT.
            // Archiving is "put this away from the timeline", not "take it out
            // of the lists I curated", and v0's `AlbumDetail.tsx` filtered
            // neither flag. A trashed photograph keeps its membership (a restore
            // brings it back into the album) and is not drawn while it is in the
            // trash.
            album != null -> Arm(
                name = "photos.shelf.album",
                where = "${PhotoFold.NOT_TRASHED} AND $IN_ALBUM",
                bind = listOf(Value(text = album.collection_id)),
            )

            // THE PHOTOGRAPHS WITH NO PLACE (v0's "No location yet", #816) —
            // a flag and not an empty id, so a place row with a missing key
            // can never open this shelf by accident.
            place != null && place.unplaced -> Arm(
                name = "photos.shelf.unplaced",
                where = "$LIVE AND place_id IS NULL",
            )

            place != null -> Arm(
                name = "photos.shelf.place",
                where = "$LIVE AND place_id = ?",
                bind = listOf(Value(text = place.place_id)),
            )

            view != null -> stateViewArm(view)

            else -> null
        }
    }

    private fun stateViewArm(view: PhotoStateView): Arm? {
        return when (view.mode?.kind) {
            PhotoStateView.Mode.Kind.KIND_FAVORITES -> Arm(
                name = "photos.shelf.favorites",
                where = "$LIVE AND $STARRED",
            )

            // THE ARCHIVE IS THE LIBRARY'S COMPLEMENT ON ONE FLAG, and both
            // halves of the predicate are needed: a shelf that asked only for
            // the `archived` flag would show a member every photograph they had
            // archived AND then thrown away.
            PhotoStateView.Mode.Kind.KIND_ARCHIVE -> Arm(
                name = "photos.shelf.archive",
                where = "${PhotoFold.NOT_TRASHED} AND ${PhotoFold.ARCHIVED}",
            )

            // THE TRASH IS EVERY TRASHED PHOTOGRAPH, archived or not: a
            // photograph put away and then deleted is in the trash, and it is
            // the only shelf it is on.
            //
            // IT SORTS BY ID (newest added first) and not by when it was deleted:
            // the trash stamp is the `entity`'s and the door pages one table
            // (R-1135-5-17). The id is a total order with no NULL in it.
            PhotoStateView.Mode.Kind.KIND_TRASH -> Arm(
                name = "photos.shelf.trash",
                where = PhotoFold.TRASHED,
                sortColumn = "id",
            )

            PhotoStateView.Mode.Kind.KIND_VIDEOS -> Arm(
                name = "photos.shelf.videos",
                where = "$LIVE AND form = ?",
                // THE DDL's OWN WORD, bound and not interpolated. `photo`'s
                // CHECK admits three values and `video` is one of them;
                // `PhotosReads.kindOf` reads the same spelling back.
                bind = listOf(Value(text = "video")),
            )

            PhotoStateView.Mode.Kind.KIND_UNSPECIFIED, null -> null
        }
    }

    /**
     * The rows, as cells — and the cells are [PhotosReads]'.
     *
     * Delegated rather than copied, which is the whole reason [SELECT] is
     * frozen. `heldOf` is the one function allowed to produce `PhotoCell.Held`
     * (D-1025-S7-62), and a second call site spelling it again is a second
     * answer to "which cell gets the download arrow" — which is exactly the
     * drift `PhotoCells.swift` was written to end.
     *
     * An EMPTY page is data with no cells and never a refusal: a member whose
     * archive is empty has a real answer, and the sentence over it is
     * `PhotoShelfMachine.emptySentence`.
     */
    override fun arrived(rows: List<Row>, nextCursor: String?): PhotoShelfEvent {
        val page = PhotosReads.arrived(rows.map(::asGridRow), nextCursor).data_?.data_
        return PhotoShelfEvent(data_ = PhotoShelfEvent.DataArrived(data_ = page))
    }

    /**
     * ONE ROW, RESHAPED INTO THE LAYOUT [PhotosReads] PROJECTS.
     *
     * A door row is positional: [SELECT]'s columns in order, then the computed
     * ones appended behind them. `PhotosReads` names five and reads its
     * computed columns at 5, 6 and 7; this names six, so they arrive at 6, 7
     * and 8. Dropping the sixth value puts them back where the projection
     * expects them.
     *
     * **The arithmetic is derived from [SELECT] and not written down twice.**
     * That is the whole point: the previous answer to this was to forbid a
     * sixth column, which is a rule enforced by a comment — and the failure
     * when somebody adds one anyway is silent, a cell holding a hash where its
     * path should be. Here a seventh column changes nothing but a number this
     * function already reads off the list.
     */
    private fun asGridRow(row: Row): Row = Row(
        values = row.values.take(CELL_COLUMNS) +
            row.values.drop(SELECT.size).take(COMPUTED_COLUMNS),
    )

    override fun refused(failure: ReadFailure): PhotoShelfEvent =
        PhotoShelfEvent(refused = PhotoShelfEvent.ReadRefused(failure = failure))

    override val appId: String = "photos"

    /**
     * The write's outcome, as this shelf's own settle event.
     *
     * Only `EXECUTED` committed. `QUEUED`, `IN_FLIGHT` and `PARKED` all mean
     * "somewhere durable, not yet committed" and are NOT reported as committed:
     * a shelf that claimed a purge had happened while it was still owed would
     * be the shell asserting a commit the vault has not made.
     *
     * [sentence] is the core's own — `CommandOutcome.reason`, the author's
     * words for a denial or a failed precondition. Nothing here composes one
     * out of an error: `Error.detail` is logs-only, and one reached a member's
     * screen through exactly that field in #1020 wave 3.
     *
     * ## `asset_id` IS EMPTY HERE, AND IT IS THE RUNTIME THAT CANNOT FILL IT
     *
     * `PhotoShelfEvent.WriteSettled` carries the row that settled, and the
     * reducer keys on it: a selection of twelve submits twelve writes, and only
     * the ones that committed leave the selection. **This function cannot name
     * that row.** [ScreenWrites.settled] is handed a status and a sentence and
     * nothing else, and `ScreenRuntime.submit` — which DOES hold the
     * `ScreenEffect.SubmitWrite` it is answering — does not pass it on. Several
     * writes are in flight at once (`scope.launch` per effect), so a queue
     * remembered on this object would pair the wrong answer with the wrong row.
     *
     * So the id is empty, which the contract defines as "about the batch", and
     * the reducer's batch arm leaves the selection alone rather than guessing.
     * The fix is one parameter: `settled(status, sentence, invokeKey)` in
     * `sync/ScreenRuntime.kt`, passing `write.invokeKey` at each of its five
     * call sites. Every key this screen mints ends in the asset id
     * (`<command>[:<value>]:<assetId>`), so this side becomes
     * `invokeKey.substringAfterLast(':')`. Raised with the umbrella; that file
     * is not this lane's.
     *
     */
    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): PhotoShelfEvent {
        val command = invokeKey.substringBefore(':')
        val aboutNoRow = command in ALBUM_LEVEL_COMMANDS
        return PhotoShelfEvent(
            write_settled = PhotoShelfEvent.WriteSettled(
                committed = status == CommandStatus.COMMAND_STATUS_EXECUTED,
                sentence = sentence,
                // THE ALBUM'S OWN VERBS END IN A TITLE OR AN ALBUM ID, NOT A
                // PHOTOGRAPH. Reading an asset off them would take a photograph
                // out of the selection because an album was renamed.
                asset_id = if (aboutNoRow) "" else assetOfInvokeKey(invokeKey),
                command = command,
                album_title = if (command == PhotoShelfMachine.RENAME_ALBUM_COMMAND) {
                    titleOfRenameKey(invokeKey)
                } else {
                    ""
                },
            ),
        )
    }

    /**
     * The verbs whose key does not end in an asset id: the album's rename and
     * delete, and the create "New album…" sends from the "Add to album" sheet.
     */
    private val ALBUM_LEVEL_COMMANDS: Set<String> = setOf(
        PhotoShelfMachine.RENAME_ALBUM_COMMAND,
        PhotoShelfMachine.DELETE_ALBUM_COMMAND,
        AlbumChoice.CREATE_KEY,
    )

    /**
     * `album-rename:<albumId>:<title>` → `<title>`. The album id is a
     * vault-minted id with no colon in it, and the title may have any number,
     * so the split is after the SECOND colon and never at the last.
     */
    internal fun titleOfRenameKey(invokeKey: String): String =
        invokeKey.substringAfter(':', missingDelimiterValue = "")
            .substringAfter(':', missingDelimiterValue = "")

    /**
     * EVERY TRASHED PHOTOGRAPH, for Empty Trash — the trash arm's own predicate,
     * walked by the column it cannot be null on.
     */
    public fun trashListQuery(): PageQuery = PageQuery(
        name = "photos.shelf.trashList",
        select = listOf("id"),
        from = table,
        where_ = PhotoFold.TRASHED,
        order = PageOrder(sort_column = "id", pk_column = "id", descending = true),
    )

    /**
     * The blob behind each picked photograph — what the byte door locates an
     * original by. Null for no ids.
     */
    public fun contentOfQuery(assetIds: List<String>): PageQuery? {
        val ids = assetIds.filter { it.isNotEmpty() }.distinct()
        if (ids.isEmpty()) return null
        return PageQuery(
            name = "photos.shelf.contentOf",
            select = listOf("id", "blob", "form"),
            from = table,
            where_ = "id IN (" + ids.joinToString(", ") { "?" } + ")",
            bind = ids.map { Value(text = it) },
            order = PageOrder(sort_column = "id", pk_column = "id"),
        )
    }

    /**
     * THE ROW THIS SETTLE IS ABOUT, RECOVERED FROM THE KEY THIS SCREEN MINTED.
     *
     * Every `invokeKey` here ends in the asset id, by construction — the
     * reducer builds them — so the last segment IS the row. That is not a
     * convention two files have to agree on by hand: the mint and this read
     * are in the same object, and a key shape that stopped ending in the id
     * would break its own screen's tests first.
     *
     * Empty when the key names nothing recognisable, which the reducer reads
     * as "about the batch" and answers by moving nothing.
     */
    internal fun assetOfInvokeKey(invokeKey: String): String =
        invokeKey.substringAfterLast(':', missingDelimiterValue = "")
}
