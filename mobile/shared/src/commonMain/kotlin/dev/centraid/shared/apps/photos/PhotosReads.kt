package dev.centraid.shared.apps.photos

import centraid.core.v1.CommandStatus
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
import dev.centraid.shared.sync.ScreenWrites
import dev.centraid.shared.sync.TransferRule

/**
 * WHAT THE PHOTOS GRID READS, AND WHAT IT MAKES OF THE ROWS (#1025 S5, lane L5;
 * #1135).
 *
 * The statement is the library's, on the `photo` table: the live, unarchived
 * photographs (an `entity` not in the trash, no `archived` flag edge, not
 * folded under an edit, [PhotoFold]), ordered `taken_at DESC, id DESC`. A grid
 * in a different order from the app's over the same photographs is two libraries.
 *
 * **THE LIBRARY IS TWO WALKS, AND THE SECOND ONE IS THE UNDATED TAIL** (#1029,
 * photos port). An undated photograph has no place in a capture-time keyset — the
 * comparison `(taken_at, id) < (?, ?)` is never true for NULL — so a
 * single walk ordered on capture time silently lost every undated photograph
 * behind the first window, which on a library past one page was all of them.
 * The first walk is therefore `taken_at IS NOT NULL`, newest first; when it
 * ends, the machine starts the second over `taken_at IS NULL`, keyed on the
 * primary key alone, and v0's "Undated" section is its tail
 * (`timeline-model.ts`'s `UNDATED_SECTION_DAY`). No coalesce is invented: an
 * undated photograph is placed after every dated one, which is where v0 sank it,
 * rather than in whatever order a fallback column happened to give it.
 */
public object PhotosReads :
    ScreenReads<PhotosGridState, PhotosGridEvent>,
    ScreenWrites<PhotosGridState, PhotosGridEvent> {
    override val screenId: String = PhotosGridMachine.SCREEN_ID

    /** `photo`, the table the grid pages; the machine's `rowsChanged` also declares the tables a verdict reads. */
    override val table: String = "photo"

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
     * THE SELECT CARRIES BOTH ORDER COLUMNS — `taken_at` and `id` —
     * because the door has no `key_of` callback and reads the cursor off the
     * row (`statement.ts:43-48`).
     *
     * Not trashed AND not archived is the app's predicate and both are needed:
     * they are different shelves, and a library that showed archived
     * photographs would be showing a member the photos they put away.
     *
     * `blob` IS NOT SELECTED, and `thumbnail_path` still arrives: it is
     * the door's own appended column, resolved from the content store against
     * the row's blob in the SAME statement (`with_held_thumbnail`,
     * D-1025-S7-20). The join is the vault's SQL and the "may this path be
     * handed out at all" rule is the seat's; this side asks for the answer and
     * cannot spell either, which is the point — a media-type predicate written
     * here would be a security rule living in a shell's statement.
     *
     * It used to make no trip at all, so every cell of a hundred-and-twenty-row
     * page drew a placeholder over a device holding the photographs.
     *
     * **THE PIXEL BOX AND THE LENGTH RIDE AFTER THE CELL'S FIVE** — `width`,
     * `height` and `duration_s` (#1029, photos port). A justified row packs from
     * the real aspect ratio before a byte arrives (v0's `justify.ts`), and a
     * video's tile says how long it is. They sit between the five cell columns
     * and the door's appended three, which is why [cellOf] finds the appended
     * columns from the END of the row: `PhotoShelfReads` and `PhotoPickerReads`
     * hand it the plain eight-value layout and are read correctly either way.
     *
     * **THE WALK AND THE FILTER ARE THE STATE'S.** [PhotosGridState.reading_undated]
     * says which of the two walks the one read in flight belongs to — the
     * machine keeps at most one outstanding, and the state is published before
     * its effect is served, so this reads the walk that was asked for. The
     * Favorites filter is the favourites shelf's own predicate
     * ([PhotoShelfReads]' `STARRED`), restated here because a star is a
     * `tagged` edge and not a column, and the door pages one table.
     */
    override fun query(state: PhotosGridState, afterCursor: String?): PageQuery {
        val undated = state.reading_undated
        val favorites = state.filter == PhotosGridState.Filter.FILTER_FAVORITES
        val where = buildList {
            add(LIVE)
            add(if (undated) "taken_at IS NULL" else "taken_at IS NOT NULL")
            if (favorites) add(STARRED)
        }.joinToString(" AND ")
        return PageQuery(
            name = when {
                favorites && undated -> "photos.grid.favorites.undated"
                favorites -> "photos.grid.favorites"
                undated -> "photos.grid.undated"
                else -> "photos.grid.live"
            },
            select = SELECT,
            from = table,
            where_ = where,
            order = PageOrder(
                // THE UNDATED TAIL IS KEYED ON THE PRIMARY KEY ALONE: it has no
                // capture time to sort on, and a keyset must be total.
                sort_column = if (undated) "id" else "taken_at",
                pk_column = "id",
                descending = true,
            ),
            with_held_thumbnail = true,
        )
    }

    /**
     * The cell's five, then the extras the grid alone projects. Order is
     * positional and moves with [cellOf]'s indices and nowhere else.
     */
    private val SELECT: List<String> = listOf(
        "id",
        "taken_at",
        "offset_min",
        "form",
        "burst",
        "width",
        "height",
        "duration_s",
    )

    /** The live library: not trashed, not put away, not folded under an edit ([PhotoFold]). The app's own predicate. */
    private const val LIVE: String = PhotoFold.LIVE

    /** A STAR IS A FLAG EDGE: the favourites shelf's predicate ([PhotoFold.STARRED]). */
    private const val STARRED: String = PhotoFold.STARRED

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

    /** A tapped original's fetch, settled (#1080). */
    override fun fetchSettled(assetId: String, fetched: Boolean, sentence: String): PhotosGridEvent =
        PhotosGridEvent(
            fetch_settled = PhotosGridEvent.FetchSettled(asset_id = assetId, fetched = fetched, sentence = sentence),
        )

    override val appId: String = "photos"

    /**
     * The selection bar's writes, settled (#1029, photos port).
     *
     * Only `EXECUTED` committed — `PhotoShelfReads.settled`'s rule and reason.
     * Every key the library mints ends in the asset id
     * (`<command>[:<value>]:<assetId>`, and `AlbumChoice`'s
     * `<command>:<albumId>:<assetId>`), so the last segment is the photograph
     * the answer is about.
     */
    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): PhotosGridEvent =
        PhotosGridEvent(
            write_settled = PhotosGridEvent.WriteSettled(
                committed = status == CommandStatus.COMMAND_STATUS_EXECUTED,
                sentence = sentence,
                asset_id = invokeKey.substringAfterLast(':', missingDelimiterValue = ""),
            ),
        )

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
     * `favorite` is FALSE because `photo` has no such column: a favourite
     * is a mirror kept elsewhere (#916), and a flag guessed here would be a
     * star a member never put on a photograph.
     */
    private fun cellOf(row: Row): PhotoCell {
        // THE APPENDED THREE ARE THE LAST THREE, WHEREVER THE ROW ENDS. The
        // door puts its computed columns after `select`, so counting from the
        // end reads this grid's eleven-value rows and the shelf's and picker's
        // eight-value rows with one set of indices. The extras are only read
        // when the row is long enough to hold them.
        // A row too short to carry them has NO appended columns — reading its
        // own cell columns as a path and a hash would be worse than reading
        // nothing.
        val appended = if (row.values.size >= CELL_COLUMNS + APPENDED_COLUMNS) {
            row.values.size - APPENDED_COLUMNS
        } else {
            row.values.size
        }
        val extras = appended >= CELL_COLUMNS + EXTRA_COLUMNS
        val thumbnail = row.text(appended + THUMBNAIL)
        val originalHash = row.text(appended + ORIGINAL_HASH)
        val capturedAt = row.text(1)
        // A CAPTURE-LOCAL OFFSET, NOT THE READER'S. `tz_offset_min` is
        // nullable in the DDL and a missing offset is read as zero, which the
        // proto's pairing already tolerates — a photo whose day cannot be told
        // is shown in UTC rather than in the phone's zone, which would silently
        // move it a day for a traveller.
        val offset = row.integer(2).toInt()
        return PhotoCell(
            asset_id = row.text(0),
            captured_at = capturedAt,
            captured_utc_offset_minutes = offset,
            kind = kindOf(row.text(3)),
            capture_group_id = row.text(4).ifEmpty { null },
            thumbnail_path = thumbnail.ifEmpty { null },
            original_hash = originalHash,
            held = heldOf(
                thumbnail = thumbnail.isNotEmpty(),
                originalHeld = row.integer(appended + ORIGINAL_HELD) > 0L,
                originalHash = originalHash,
                kind = kindOf(row.text(3)),
                rule = rule,
                metered = metered,
            ),
            // A MISSING BOX IS ZERO AND NOT A GUESS: `width > 0` is the DDL's
            // own CHECK, so zero can only mean "the vault does not know", and
            // the view packs that tile square.
            width = if (extras) row.integer(WIDTH).coerceIn(0L, Int.MAX_VALUE.toLong()).toInt() else 0,
            height = if (extras) row.integer(HEIGHT).coerceIn(0L, Int.MAX_VALUE.toLong()).toInt() else 0,
            duration_seconds = if (extras) row.seconds(DURATION) else 0,
            day = PhotosTimeline.captureDay(capturedAt, offset),
        )
    }

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
     * The rule the core's `phone::drain::Conditions` applies to a pass nobody
     * asked for (`may_prepare` under MANUAL, `allows_cellular` on a metered
     * link), and it is here for ONE reason: a label. The core decides what crosses; this decides
     * which sentence a cell shows, and a cell that cannot tell "waiting for a
     * window" from "your rule is holding this" shows the wrong one of two.
     *
     * A VIDEO IS THE ONE KIND THE CELLULAR RULE STILL WITHHOLDS. `kind` is
     * `photo`'s and the core reads the media type; they
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

    /**
     * The door's three computed columns, as OFFSETS from where they start —
     * `thumbnail_path`, `original_hash`, `original_held`, in the order
     * `crates/core`'s `api::page` appends them after whatever `select` named.
     */
    private const val APPENDED_COLUMNS: Int = 3
    private const val THUMBNAIL: Int = 0
    private const val ORIGINAL_HASH: Int = 1
    private const val ORIGINAL_HELD: Int = 2

    /** The five every cell reads, and the three only this grid projects. */
    private const val CELL_COLUMNS: Int = 5
    private const val EXTRA_COLUMNS: Int = 3
    private const val WIDTH: Int = 5
    private const val HEIGHT: Int = 6
    private const val DURATION: Int = 7

    /**
     * The DDL's three `form` values, as the proto's. A photograph has no audio:
     * an audio file is a Docs document (R-1135-5-3).
     *
     * An unrecognised value is `KIND_UNSPECIFIED` and not `KIND_PHOTO`: the
     * CHECK constraint admits exactly these three today, and a fourth arriving
     * from a newer gateway must not be drawn as a photograph.
     *
     * `internal` rather than private because every Photos surface that reads
     * `photo` owes the same answer, and a second copy of this `when` is a
     * second place a fourth `form` gets drawn as a still image
     * (`PhotoLightboxReads`, #1029 photos port).
     */
    internal fun kindOf(kind: String): PhotoCell.Kind = when (kind) {
        "photo" -> PhotoCell.Kind.KIND_PHOTO
        "video" -> PhotoCell.Kind.KIND_VIDEO
        "scan" -> PhotoCell.Kind.KIND_SCAN
        else -> PhotoCell.Kind.KIND_UNSPECIFIED
    }

    /** Positional, as the door states. See `HomeReads.text` for why only TEXT. */
    private fun Row.text(index: Int): String = values.getOrNull(index)?.text ?: ""

    private fun Row.integer(index: Int): Long = values.getOrNull(index)?.integer ?: 0L

    /**
     * `duration_s` is `REAL` in the DDL, so a STRICT table hands back a real —
     * but an integer is read too rather than dropped to zero, because a length
     * that arrived as `64` is still sixty-four seconds.
     */
    private fun Row.seconds(index: Int): Int {
        val value = values.getOrNull(index) ?: return 0
        val seconds = value.real ?: value.integer?.toDouble() ?: return 0
        return seconds.coerceIn(0.0, Int.MAX_VALUE.toDouble()).toInt()
    }
}
