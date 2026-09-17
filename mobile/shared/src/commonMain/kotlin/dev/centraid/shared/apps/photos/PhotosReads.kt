package dev.centraid.shared.apps.photos

import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.Row
import centraid.screen.v1.PhotoCell
import centraid.screen.v1.PhotosGridData
import centraid.screen.v1.PhotosGridEvent
import centraid.screen.v1.PhotosGridState
import centraid.screen.v1.ReadFailure
import dev.centraid.shared.sync.LinkConditions
import dev.centraid.shared.sync.ScreenReads
import dev.centraid.shared.sync.TransferRule

/**
 * WHAT THE PHOTOS GRID READS, AND WHAT IT MAKES OF THE ROWS (#1025 S5, lane L5).
 *
 * The statement is `crates/apps/photos`'s own — `photos.library.live` in
 * `queries.rs`: `media_asset`, the live and unarchived rows, ordered
 * `captured_at DESC, asset_id DESC`. Followed rather than re-derived, for the
 * reason `TallyReads` gives: a grid in a different order from the desktop's
 * over the same assets is two libraries.
 *
 * **A NULL `captured_at` RIDES THE FIRST WINDOW AND NO OTHER**, which the app's
 * own comment states and this inherits by using its order: the keyset
 * comparison `captured_at < ?` is false for NULL in SQL. That is not a defect
 * to patch here — an undated asset has no place in a timeline cursor — and it
 * is why this file does not invent a coalesce that would put undated photos in
 * whatever order the rowid happened to be.
 */
public object PhotosReads : ScreenReads<PhotosGridState, PhotosGridEvent> {
    override val screenId: String = PhotosGridMachine.SCREEN_ID

    /** `media_asset`, the same table the machine's `rowsChanged` declares. */
    override val table: String = "media_asset"

    /**
     * A mosaic's page is bigger than a list's.
     *
     * A grid of small cells shows several rows of them at once and a member
     * flicks through a library far faster than they read a ledger, so a
     * fifty-row page would fetch again before the scroll stopped. Still well
     * under v0's 500-row clamp (`window.ts:78`).
     */
    override val limit: Int = 120

    /**
     * THE SELECT CARRIES BOTH ORDER COLUMNS — `captured_at` and `asset_id` —
     * because the door has no `key_of` callback and reads the cursor off the
     * row (`statement.ts:43-48`).
     *
     * `archived_at IS NULL` beside `deleted_at IS NULL` is the app's predicate
     * and both are needed: they are different shelves, the DDL's own CHECK
     * keeps a row out of both at once, and a library that showed archived
     * assets would be showing a member the photos they put away.
     *
     * `content_id` IS NOT SELECTED, and `thumbnail_path` still arrives: it is
     * the door's own appended column, resolved from `seat_blob_held` against
     * the row's content in the SAME statement (`with_held_thumbnail`,
     * D-1025-S7-20). The join is the vault's SQL and the "may this path be
     * handed out at all" rule is the seat's; this side asks for the answer and
     * cannot spell either, which is the point — a media-type predicate written
     * here would be a security rule living in a shell's statement.
     *
     * It used to make no trip at all, so every cell of a hundred-and-twenty-row
     * page drew a placeholder over a device holding the photographs.
     */
    override fun query(state: PhotosGridState, afterCursor: String?): PageQuery = PageQuery(
        name = "photos.grid.live",
        select = listOf("asset_id", "captured_at", "tz_offset_min", "kind", "capture_group_id"),
        from = table,
        where_ = "deleted_at IS NULL AND archived_at IS NULL",
        order = PageOrder(
            sort_column = "captured_at",
            pk_column = "asset_id",
            descending = true,
        ),
        with_held_thumbnail = true,
    )

    override fun arrived(rows: List<Row>, nextCursor: String?): PhotosGridEvent = PhotosGridEvent(
        data_ = PhotosGridEvent.DataArrived(
            data_ = PhotosGridData(
                cells = rows.map(::cellOf),
                next_cursor = nextCursor,
                // TWO DIFFERENT EMPTY-CELL SENTENCES, and this read can only
                // honestly claim one of them. `thumbnail_pack_absent` means "no
                // thumbnail pack reached this device at all", which is a fact
                // about the byte store and not about these rows — and no read
                // in this lane asks the byte door anything. False is the
                // conservative answer: the member reads "no longer on this
                // device" rather than being told a pack is missing that may be
                // sitting there.
            ),
        ),
    )

    override fun refused(failure: ReadFailure): PhotosGridEvent =
        PhotosGridEvent(refused = PhotosGridEvent.ReadRefused(failure = failure))

    /**
     * One cell out of one row.
     *
     * `thumbnail_path` is THE APPENDED COLUMN — index [THUMBNAIL], after the
     * five the query named, which is where the door puts a computed column so
     * that `select` stays a list of real columns. Empty is a real answer with
     * more than one cause: the bytes have not reached this device, or they are
     * a reading no surface may embed. Neither is an error and both draw the
     * cell's own empty sentence.
     *
     * **A PATH IS NOT THE WHOLE STATE** (#1025 S5, D-1025-S7-62). It was, for
     * one slice — "present means held" — and that could not tell a
     * photograph still on its way from one a member's own rule is holding
     * back, which is the difference between a placeholder and a download
     * arrow. [heldOf] is the derivation and `PhotoCell.Held` is the closed
     * enum it produces.
     *
     * `HELD_FETCHING` is NOT produced here: it is a fact about a tap and not
     * about the replica, so `PhotosGridMachine` owns it and paints it over the
     * cell the member touched.
     *
     * `favorite` is FALSE because `media_asset` has no such column: a favourite
     * is a mirror kept elsewhere (#916), and a flag guessed here would be a
     * star a member never put on a photograph.
     */
    private fun cellOf(row: Row): PhotoCell = PhotoCell(
        asset_id = row.text(0),
        captured_at = row.text(1),
        // A CAPTURE-LOCAL OFFSET, NOT THE READER'S. `tz_offset_min` is
        // nullable in the DDL and a missing offset is read as zero, which the
        // proto's pairing already tolerates — a photo whose day cannot be told
        // is shown in UTC rather than in the phone's zone, which would silently
        // move it a day for a traveller.
        captured_utc_offset_minutes = row.integer(2).toInt(),
        kind = kindOf(row.text(3)),
        capture_group_id = row.text(4).ifEmpty { null },
        thumbnail_path = row.text(THUMBNAIL).ifEmpty { null },
        original_hash = row.text(ORIGINAL_HASH),
        held = heldOf(
            thumbnail = row.text(THUMBNAIL).isNotEmpty(),
            originalHeld = row.integer(ORIGINAL_HELD) > 0L,
            originalHash = row.text(ORIGINAL_HASH),
            kind = kindOf(row.text(3)),
            rule = rule,
            metered = metered,
        ),
    )

    /**
     * THE MEMBER'S RULE AND THE LINK, AS THIS READ LAST HEARD THEM (#1025 S4).
     *
     * Read off [LinkConditions], which the session writes once a round from the
     * window the pass runs under — so a grid cannot draw a download arrow under
     * one rule while the pass plans under another. It lives in `sync` rather
     * than on this object because the shell may not name an app's types
     * (`PerAppLayoutSpec`), and because a link is nobody's app.
     */
    private val rule: TransferRule get() = LinkConditions.rule
    private val metered: Boolean get() = LinkConditions.metered

    /**
     * WHAT THIS DEVICE HAS OF ONE PHOTOGRAPH (#1025 S5, D-1025-S7-62).
     *
     * Five states, in the order they exclude each other, and the order IS the
     * derivation — a cell that could be two of them at once would draw two
     * affordances.
     *
     * `HELD_FETCHING` is the reducer's and is not in this list: a tap is not a
     * fact this read can see, and it OUTRANKS every state below when the
     * machine paints it — the member has overridden the rule for that item and
     * the cell must say so while the bytes move.
     *
     * 1. **The original is here.** `original_held` and not a present
     *    `thumbnail_path`: the door's thumbnail column falls back to the
     *    ORIGINAL's hash on a vault with no derivative rows, so a path means
     *    the original on some libraries and a `thumb` on others, and a cell
     *    that guessed would tell a member their full-size photograph is on this
     *    device whenever a thumbnail was.
     * 2. **A thumbnail is here and nothing is holding the original back.**
     * 3. **A thumbnail is here and the RULE is why the original is not.** The
     *    one state that carries the download arrow, and the distinction that
     *    matters to a member: this is a decision they made, not a failure.
     * 4. **Nothing has reached this device.** A freshly paired phone
     *    mid-first-copy is every cell in this state, and it is not an error.
     *
     * **The arithmetic is asked of `crates/blobs` in spirit and mirrored here
     * in exactly one expression**, [wouldWithhold], which is a statement about
     * what a member is TOLD rather than about what is fetched: the fetching is
     * the core's and this is a label. The two are asserted against each other
     * by `crates/blobs`' own table test and this file's spec.
     */
    internal fun heldOf(
        thumbnail: Boolean,
        originalHeld: Boolean,
        originalHash: String,
        kind: PhotoCell.Kind,
        rule: TransferRule,
        metered: Boolean,
    ): PhotoCell.Held = when {
        originalHeld -> PhotoCell.Held.HELD_ORIGINAL
        // A CELL WITH NO ORIGINAL TO ASK FOR OFFERS NOTHING. This replica has
        // no live content row naming one, so there is no hash to tap and a
        // withheld state would be an affordance that cannot be served.
        originalHash.isEmpty() ->
            if (thumbnail) PhotoCell.Held.HELD_THUMBNAIL_ONLY else PhotoCell.Held.HELD_ABSENT
        wouldWithhold(kind, rule, metered) ->
            if (thumbnail) PhotoCell.Held.HELD_WITHHELD_BY_RULE else PhotoCell.Held.HELD_ABSENT
        thumbnail -> PhotoCell.Held.HELD_THUMBNAIL_ONLY
        else -> PhotoCell.Held.HELD_ABSENT
    }

    /**
     * WOULD AN ORDINARY WINDOW REFUSE TO ASK FOR THIS ORIGINAL?
     *
     * The same table as `centraid_blobs::Budget::admits_original`, and it is
     * here for ONE reason: a label. The core decides what crosses; this decides
     * which sentence a cell shows, and a cell that cannot tell "waiting for a
     * window" from "your rule is holding this" shows the wrong one of two.
     *
     * A VIDEO IS THE ONE KIND THE CELLULAR RULE STILL WITHHOLDS. `kind` is
     * `media_asset`'s and the core reads `core_content_representation`; they
     * agree for a camera roll, and where they do not the core is the authority
     * — the cost of a disagreement is a label, never a byte.
     */
    private fun wouldWithhold(
        kind: PhotoCell.Kind,
        rule: TransferRule,
        metered: Boolean,
    ): Boolean = when (rule) {
        TransferRule.MANUAL -> true
        TransferRule.WIFI_ONLY -> metered
        TransferRule.WIFI_AND_CELLULAR_PHOTOS ->
            metered && kind == PhotoCell.Kind.KIND_VIDEO
    }

    private const val THUMBNAIL: Int = 5

    /**
     * The other two computed columns, in the order `crates/core`'s `api::page`
     * appends them. They move together with [THUMBNAIL] and with `query`'s
     * `select` list, and nowhere else.
     */
    private const val ORIGINAL_HASH: Int = 6
    private const val ORIGINAL_HELD: Int = 7

    /**
     * The DDL's four `kind` values, as the proto's four.
     *
     * An unrecognised value is `KIND_UNSPECIFIED` and not `KIND_PHOTO`: the
     * CHECK constraint admits exactly these four today, and a fifth arriving
     * from a newer gateway must not be drawn as a photograph.
     */
    private fun kindOf(kind: String): PhotoCell.Kind = when (kind) {
        "photo" -> PhotoCell.Kind.KIND_PHOTO
        "video" -> PhotoCell.Kind.KIND_VIDEO
        "audio" -> PhotoCell.Kind.KIND_AUDIO
        "scan" -> PhotoCell.Kind.KIND_SCAN
        else -> PhotoCell.Kind.KIND_UNSPECIFIED
    }

    /** Positional, as the door states. See `HomeReads.text` for why only TEXT. */
    private fun Row.text(index: Int): String = values.getOrNull(index)?.text ?: ""

    private fun Row.integer(index: Int): Long = values.getOrNull(index)?.integer ?: 0L
}
