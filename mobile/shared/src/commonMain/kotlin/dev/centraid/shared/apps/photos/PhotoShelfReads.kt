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
 * WHAT A PHOTO SHELF READS (#1029, the photos port).
 *
 * Eight predicates over one table, one order and one projection. The shelf is
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
 * ## The order is the DESKTOP's, arm by arm — and the trash's is `deleted_at`
 *
 * `crates/apps/photos`' `trash_statement` orders the trash `deleted_at DESC,
 * asset_id DESC` and every other shelf `captured_at DESC, asset_id DESC`, and
 * this follows both. A shelf in a different order from the desktop's over the
 * same assets is two libraries — and on the trash it is worse than a
 * difference of taste: *what did I just delete* is the question a trash shelf
 * exists to answer, and a `captured_at` order scatters a batch a member deleted
 * together across however many years those photographs were taken in.
 *
 * **What that costs, and why it is arithmetic rather than a second projection.**
 * The door reads the cursor off the row by the two columns the ORDER BY names,
 * so ordering by `deleted_at` means projecting it — and the door APPENDS its
 * computed columns after the named ones, so a sixth named column moves
 * `thumbnail_path`, `original_hash` and `original_held` by one. `PhotosReads`
 * holds those three as constants against ITS five. The first draft of this file
 * answered that by ordering the trash `captured_at` like everything else, which
 * bought one layout at the price of the one shelf whose order carries meaning.
 *
 * What it does instead is select the sixth column on EVERY arm and compute the
 * appended indices from [SELECT]`.size`, in [asGridRow], which reshapes each row
 * into the eight-value layout `PhotosReads` projects. So there is still one
 * projection and one `heldOf` — the only thing that moved is where two numbers
 * come from, and they now come from the list rather than from a comment asking
 * the next person not to add a column.
 *
 * **A NULL `captured_at` RIDES THE FIRST WINDOW AND NO OTHER**, which is
 * `PhotosReads`' inherited property and not a defect to patch here: the keyset
 * comparison `captured_at < ?` is false for NULL in SQL, and an undated asset
 * has no place in a timeline cursor. The trash is the one shelf this cannot
 * touch: its predicate is `deleted_at IS NOT NULL`, so its sort column has no
 * NULL to drop.
 *
 * ## There is no join on this door, and there is no roster either
 *
 * Four of the eight shelves are a membership — an album's entries, a person's
 * confirmed faces, a memory's members, a star — and the door has no join
 * clause. The honest shape would be two reads: resolve the ids, then page the
 * assets. **`PhotoShelfState` has nowhere to put a roster** (no field) and
 * `PhotoShelfEvent` has no arm that carries one, so a two-read walk cannot be
 * expressed against this contract at all; and a roster read at this screen's
 * page limit would silently truncate a shelf whose membership is longer than
 * one page, which is worse than not having it.
 *
 * So the membership rides in the PREDICATE, as `asset_id IN (SELECT …)` over
 * one table at a time. That is not a join and not a fabricated column: it is
 * the door's own idiom — `with_held_thumbnail` is three correlated subqueries
 * in `crates/vault/src/page.rs` — the paged read is still the asset read, the
 * cursor still comes off `media_asset`, and every value is bound rather than
 * interpolated. Reported to the umbrella all the same, because the root's
 * instruction was two reads and this is not two reads.
 */
public object PhotoShelfReads :
    ScreenReads<PhotoShelfState, PhotoShelfEvent>,
    ScreenWrites<PhotoShelfState, PhotoShelfEvent> {
    override val screenId: String = PhotoShelfMachine.SCREEN_ID

    /**
     * `media_asset` — the table every arm pages, and the one the machine's
     * `rowsChanged` answers in asset ids for. The four membership tables move
     * this screen too, and the machine names them; this is the table the PAGE
     * comes from, which is the pairing `ScreenReads.table` is about.
     */
    override val table: String = "media_asset"

    /** A mosaic's page, the same as the library grid's. See `PhotosReads.limit`. */
    override val limit: Int = 120

    /**
     * THE PROJECTION: `PhotosReads`' FIVE, IN ITS ORDER, PLUS THE TRASH'S SORT.
     *
     * The first five are the cell's and may not be reordered or dropped —
     * [PhotosReads] projects a row positionally and this file hands it one.
     * `deleted_at` is sixth because the trash orders by it and the door reads
     * the cursor off the row by the two columns the ORDER BY names; it is
     * selected on EVERY arm rather than on the trash alone so that every arm
     * has one row shape, which is what lets [asGridRow] be arithmetic instead
     * of a per-arm table.
     *
     * The other seven arms never read it. That is the cheap half of the trade:
     * one column of a hundred and twenty rows, against a trash shelf that
     * answers "what did I just delete".
     */
    private val SELECT: List<String> = listOf(
        "asset_id",
        "captured_at",
        "tz_offset_min",
        "kind",
        "capture_group_id",
        "deleted_at",
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

    /** The live library: not trashed, not put away. `PhotosReads`' predicate. */
    private const val LIVE: String = "deleted_at IS NULL AND archived_at IS NULL"

    /**
     * A STAR IS A TAG, NOT A COLUMN (#916, and `media.rs`'s `set_starred`).
     *
     * `media_asset` has no `favorite` column and never had one.
     * `media.update_asset`'s `favorite` input calls `set_starred`, which
     * DELETEs and re-INSERTs one `core_tag` row pointing at the `starred`
     * concept of the flags scheme. So the favourites shelf reads what that
     * write writes, through three nested single-table subqueries rather than
     * `is_starred`'s two JOINs — the door pages one table and joins none, and a
     * `FROM a JOIN b` here would break both the projection and the keyset.
     *
     * The three literals are the vault's own constants, restated for the reason
     * `crates/apps/photos/src/queries.rs` restates them: this side cannot
     * import Rust, and the parity is asserted rather than assumed.
     *
     * **The flags scheme is an `https` URI and the tags scheme is not**, which
     * is not drift to tidy: a `urn:`-style `:flags` reads as a NAMED PARAMETER
     * in condition SQL (#258, the colon-literal trap).
     */
    private const val ASSET_TARGET_TYPE: String = "media.asset"
    private const val FLAGS_SCHEME_URI: String = "https://centraid.dev/schemes/flags"
    private const val STARRED_NOTATION: String = "starred"

    private const val STARRED = "asset_id IN (SELECT target_id FROM core_tag " +
        "WHERE target_type = ? AND concept_id IN (SELECT concept_id FROM core_concept " +
        "WHERE notation = ? AND scheme_id IN (SELECT scheme_id FROM core_concept_scheme " +
        "WHERE uri = ?)))"

    /**
     * A CONFIRMED FACE, AND ONLY A CONFIRMED ONE.
     *
     * `review_state` is the column `media.answer_face_proposal` writes and the
     * only writer of it; the DDL's CHECK ties `'confirmed'` to a non-null
     * `confirmed_by_party_id`, so the two cannot disagree and reading the state
     * is reading both. A proposal is a QUESTION and not an identification —
     * putting proposed faces on a person's shelf would show a member
     * photographs of a stranger under their sister's name.
     */
    private const val CONFIRMED: String = "confirmed"

    private const val CONFIRMED_FACE = "asset_id IN (SELECT asset_id FROM media_face_region " +
        "WHERE party_id = ? AND review_state = ?)"

    private const val IN_ALBUM = "asset_id IN (SELECT target_id FROM core_collection_entry " +
        "WHERE collection_id = ? AND target_type = ?)"

    private const val IN_MEMORY = "asset_id IN (SELECT asset_id FROM media_memory_member " +
        "WHERE memory_id = ?)"

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
                pk_column = "asset_id",
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
     * [sortColumn] defaults to the timeline's, because seven of the eight
     * shelves ARE the timeline under a predicate. The trash overrides it, and
     * it is the only arm that does.
     */
    private data class Arm(
        val name: String,
        val where: String,
        val bind: List<Value> = emptyList(),
        val sortColumn: String = "captured_at",
    )

    private fun armOf(shelf: PhotoShelf): Arm? {
        val album = shelf.album
        val place = shelf.place
        val memory = shelf.memory
        val view = shelf.state_view
        return when {
            // AN ALBUM SHOWS ARCHIVED PHOTOGRAPHS AND THE LIBRARY DOES NOT.
            // Archiving is "put this away from the timeline", not "take it out
            // of the lists I curated", and v0's `AlbumDetail.tsx` filtered
            // neither flag. Trashed ones cannot appear at all: `delete_asset`
            // DELETEs the asset's `core_collection_entry` rows before it stamps
            // `deleted_at`, so the membership is already gone.
            album != null -> Arm(
                name = "photos.shelf.album",
                where = "deleted_at IS NULL AND $IN_ALBUM",
                bind = listOf(
                    Value(text = album.collection_id),
                    Value(text = ASSET_TARGET_TYPE),
                ),
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

            memory != null -> Arm(
                name = "photos.shelf.memory",
                // A memory is computed over the LIVE library, so a trashed
                // photograph leaves the memory it was in rather than sitting in
                // it as a hole.
                where = "$LIVE AND $IN_MEMORY",
                bind = listOf(Value(text = memory.memory_id)),
            )

            view != null -> stateViewArm(view)

            else -> null
        }
    }

    private fun stateViewArm(view: PhotoStateView): Arm? {
        val person = view.person
        if (person != null) {
            return Arm(
                name = "photos.shelf.person",
                where = "$LIVE AND $CONFIRMED_FACE",
                bind = listOf(Value(text = person.party_id), Value(text = CONFIRMED)),
            )
        }
        return when (view.mode?.kind) {
            PhotoStateView.Mode.Kind.KIND_FAVORITES -> Arm(
                name = "photos.shelf.favorites",
                where = "$LIVE AND $STARRED",
                bind = listOf(
                    Value(text = ASSET_TARGET_TYPE),
                    Value(text = STARRED_NOTATION),
                    Value(text = FLAGS_SCHEME_URI),
                ),
            )

            // THE ARCHIVE IS THE LIBRARY'S COMPLEMENT ON ONE COLUMN, and both
            // halves of the predicate are needed: the DDL's CHECK keeps a row
            // out of the trash and the archive at once, but a shelf that asked
            // only for `archived_at IS NOT NULL` would show a member every
            // photograph they had archived AND then thrown away.
            PhotoStateView.Mode.Kind.KIND_ARCHIVE -> Arm(
                name = "photos.shelf.archive",
                where = "deleted_at IS NULL AND archived_at IS NOT NULL",
            )

            // THE TRASH IS EVERY DELETED ROW, archived or not: a photograph put
            // away and then deleted is in the trash, and it is the only shelf
            // it is on.
            //
            // AND IT SORTS BY WHEN IT WAS DELETED, which is
            // `crates/apps/photos`' `trash_statement` and is the only arm that
            // leaves the timeline. The question a trash shelf exists to answer
            // is "what did I just delete", and a capture-time order scatters a
            // batch deleted together across however many years those
            // photographs were taken in. The predicate also makes this the one
            // sort column on this screen with no NULL in it.
            PhotoStateView.Mode.Kind.KIND_TRASH -> Arm(
                name = "photos.shelf.trash",
                where = "deleted_at IS NOT NULL",
                sortColumn = "deleted_at",
            )

            PhotoStateView.Mode.Kind.KIND_VIDEOS -> Arm(
                name = "photos.shelf.videos",
                where = "$LIVE AND kind = ?",
                // THE DDL's OWN WORD, bound and not interpolated. `media_asset`'s
                // CHECK admits four values and `video` is one of them;
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
        AlbumChoice.CREATE_COMMAND,
    )

    /**
     * `media.rename_album:<albumId>:<title>` → `<title>`. The album id is a
     * vault-minted id with no colon in it, and the title may have any number,
     * so the split is after the SECOND colon and never at the last.
     */
    internal fun titleOfRenameKey(invokeKey: String): String =
        invokeKey.substringAfter(':', missingDelimiterValue = "")
            .substringAfter(':', missingDelimiterValue = "")

    /**
     * EVERY TRASHED ASSET, for Empty Trash — `deleted_at IS NOT NULL`, the trash
     * arm's own predicate, walked by the column it cannot be null on.
     */
    public fun trashListQuery(): PageQuery = PageQuery(
        name = "photos.shelf.trashList",
        select = listOf("asset_id", "deleted_at"),
        from = table,
        where_ = "deleted_at IS NOT NULL",
        order = PageOrder(sort_column = "deleted_at", pk_column = "asset_id", descending = true),
    )

    /**
     * The content item behind each picked photograph — what the byte door
     * locates an original by (`ContentRef.content_id`). Null for no ids.
     */
    public fun contentOfQuery(assetIds: List<String>): PageQuery? {
        val ids = assetIds.filter { it.isNotEmpty() }.distinct()
        if (ids.isEmpty()) return null
        return PageQuery(
            name = "photos.shelf.contentOf",
            select = listOf("asset_id", "content_id", "kind"),
            from = table,
            where_ = "asset_id IN (" + ids.joinToString(", ") { "?" } + ")",
            bind = ids.map { Value(text = it) },
            order = PageOrder(sort_column = "asset_id", pk_column = "asset_id"),
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
