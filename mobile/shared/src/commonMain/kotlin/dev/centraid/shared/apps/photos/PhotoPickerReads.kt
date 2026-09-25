package dev.centraid.shared.apps.photos

import centraid.core.v1.CommandStatus
import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.PhotoPickerEvent
import centraid.screen.v1.PhotoPickerState
import centraid.screen.v1.ReadFailure
import dev.centraid.shared.sync.ScreenReads
import dev.centraid.shared.sync.ScreenWrites

/**
 * WHAT THE PICKER READS (#1029, the photos port).
 *
 * The LIVE library, in the library's own order — the same statement
 * `PhotosReads` makes, because the picker offers the library and a picker that
 * showed a different set from the grid it was reached through would be a second
 * library with a second answer to "what do I have".
 *
 * ## Why a trashed photograph is not offered
 *
 * `deleted_at IS NULL` is v0's own filter here (`PhotoPicker.tsx`: "Trashed
 * photographs are not offered: adding would put a deleted reference into a
 * curated album"), and the vault agrees from the other side —
 * `media.delete_asset` DELETEs an asset's `core_collection_entry` rows before
 * it stamps `deleted_at`, so a reference added to a trashed photograph would be
 * swept away again by the next trash. `archived_at IS NULL` rides with it for
 * the library's reason: an archived photograph is one the member put away, and
 * offering it here would put it back in front of them.
 *
 * ## What is NOT in this statement, and why
 *
 * **The album's membership.** The door has no join and the membership is
 * `core_collection_entry`, so it is a SECOND statement — [membersQuery], walked
 * by `PhotoPickerBridge` beside this page and unioned into
 * `already_in_album_asset_ids` by the reducer. It used to ride the route from
 * the surface that pushed the picker, and no surface held more than one page of
 * the album: both shells passed an empty list, and every cell drew as addable.
 *
 * ## The projection is `PhotosReads`', and [SELECT] may not drift from it
 *
 * [arrived] delegates, so the door's three computed columns land at the indices
 * `PhotosReads` holds as constants. See `PhotoShelfReads`' file comment for the
 * failure a sixth named column causes, which is silent.
 */
public object PhotoPickerReads :
    ScreenReads<PhotoPickerState, PhotoPickerEvent>,
    ScreenWrites<PhotoPickerState, PhotoPickerEvent> {
    override val screenId: String = PhotoPickerMachine.SCREEN_ID

    /** `media_asset`, the same table the machine's `rowsChanged` declares. */
    override val table: String = "media_asset"

    /** A mosaic's page, the same as the library grid's. See `PhotosReads.limit`. */
    override val limit: Int = 120

    /** `PhotosReads`' five columns. See the file comment. */
    private val SELECT: List<String> = listOf(
        "asset_id",
        "captured_at",
        "tz_offset_min",
        "kind",
        "capture_group_id",
    )

    /**
     * The library, unconditionally — this read is not parameterised.
     *
     * The album id is on the state and does NOT enter the statement: the picker
     * offers everything and marks what is taken, rather than asking the vault
     * for the complement. Filtering here would mean the door doing a NOT IN
     * over a membership table, and it would also mean the picker's page count
     * changing under a member as the album filled.
     *
     * So this returns a statement even before `Opened` has landed. That is
     * right for this screen and wrong for the shelf: a shelf with no predicate
     * would be an unbound read of the whole library, and the picker's read IS
     * the whole live library.
     */
    override fun query(state: PhotoPickerState, afterCursor: String?): PageQuery = PageQuery(
        name = "photos.picker.live",
        select = SELECT,
        from = table,
        where_ = "deleted_at IS NULL AND archived_at IS NULL",
        order = PageOrder(
            sort_column = "captured_at",
            pk_column = "asset_id",
            descending = true,
        ),
        with_held_thumbnail = true,
    )

    /**
     * The rows, as cells — and the cells are [PhotosReads]'.
     *
     * The picker's cells show held state, which v0's never did: a member could
     * pick a photograph this device does not have, and find out afterwards.
     * They show it because it is the same renderer and the same derivation, not
     * because this screen remembered to.
     */
    override fun arrived(rows: List<Row>, nextCursor: String?): PhotoPickerEvent {
        val page = PhotosReads.arrived(rows, nextCursor).data_?.data_
        return PhotoPickerEvent(data_ = PhotoPickerEvent.DataArrived(data_ = page))
    }

    override fun refused(failure: ReadFailure): PhotoPickerEvent =
        PhotoPickerEvent(refused = PhotoPickerEvent.ReadRefused(failure = failure))

    override val appId: String = "photos"

    /**
     * One add's outcome.
     *
     * Only `EXECUTED` is committed; `QUEUED`, `IN_FLIGHT` and `PARKED` are
     * "somewhere durable, not yet committed" and must not draw a photograph as
     * taken — a cell that went grey before the entry existed would tell a
     * member the album holds something it does not.
     *
     * `asset_id` is empty for the reason `PhotoShelfReads.settled` states in
     * full: [ScreenWrites.settled] is not handed the write it is answering, so
     * this side has no row to name. The reducer reads an empty id as "about the
     * batch" and moves nothing, rather than marking a whole picked set taken on
     * one commit.
     */
    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): PhotoPickerEvent =
        PhotoPickerEvent(
            write_settled = PhotoPickerEvent.WriteSettled(
                committed = status == CommandStatus.COMMAND_STATUS_EXECUTED,
                sentence = sentence,
                asset_id = PhotoShelfReads.assetOfInvokeKey(invokeKey),
            ),
        )

    /**
     * WHAT THE ALBUM ALREADY HOLDS — its photographs' entries, by entry id, so
     * the walk can continue past one page. `target_type` because the table is
     * polymorphic and a notebook's notes live in it too.
     */
    public fun membersQuery(collectionId: String): PageQuery = PageQuery(
        name = "photos.picker.members",
        select = listOf("entry_id", "target_id"),
        from = "core_collection_entry",
        where_ = "collection_id = ? AND target_type = ?",
        bind = listOf(Value(text = collectionId), Value(text = "media.asset")),
        order = PageOrder(sort_column = "entry_id", pk_column = "entry_id"),
    )
}
