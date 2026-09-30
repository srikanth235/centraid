package dev.centraid.shared.apps.photos

import centraid.core.v1.CommandStatus
import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.DuplicateMember
import centraid.screen.v1.DuplicateReviewData
import centraid.screen.v1.DuplicateReviewEvent
import centraid.screen.v1.DuplicateReviewState
import centraid.screen.v1.PhotoCell
import centraid.screen.v1.ReadFailure
import dev.centraid.shared.sync.LinkConditions
import dev.centraid.shared.sync.ScreenReads
import dev.centraid.shared.sync.ScreenWrites

/**
 * WHAT ONE CLUSTER'S REVIEW READS, AND WHAT IT MAKES OF THE ROWS
 * (#1029, photos port).
 *
 * The desktop answers this with THREE statements and a fold —
 * `photos.duplicates.phashes`, then `.assets`, then `.contents`
 * (`crates/apps/photos/src/duplicates.rs`). A screen has ONE:
 * [dev.centraid.shared.sync.ScreenRuntime] calls [query] once per `ReadPage`
 * and hands the rows straight to [arrived], which is never told which statement
 * produced them. So the read is arranged the other way round — one page of
 * `media_asset`, with the cluster's membership as a PREDICATE rather than as a
 * first read:
 *
 * ```
 * asset_id IN (SELECT asset_id FROM media_asset_phash WHERE cluster_id = ?)
 *   AND deleted_at IS NULL
 * ```
 *
 * `deleted_at IS NULL` is the desktop's own rule and it matters here more than
 * anywhere: **only LIVE assets ride a cluster card.** A trashed member of an
 * old cluster is not something to offer trashing again — and after a resolve it
 * is exactly what the re-read must not bring back.
 *
 * The sort column is `asset_id`, which is NOT NULLABLE, so unlike the shelf
 * this read could be walked. It is not: `DuplicateReviewEvent` has no
 * `NextPageRequested`, because a cluster is a handful of copies of one
 * photograph. [limit] says what happens if that is ever wrong.
 *
 * ## WHAT THIS STATEMENT REACHES, AND WHAT A SECOND ONE DOES
 *
 * * **`member_placed` IS A LEG**, [DuplicateReviewLeg], over
 *   `core_collection_entry` keyed on the asset ids this read puts on the wire.
 *   It arrives through its own event arm and sets `placements_checked`, because
 *   **false is not a safe default on a screen that deletes photographs**: it
 *   reads as "this is a stray copy" about a photograph that may be in three
 *   albums. Out of THIS read it is false and `placements_checked` is false with
 *   it, which is the views' cue to say the question is open rather than answer
 *   it. The leg covers ALBUMS; the favourite half is a `core_tag` on the flags
 *   scheme's `starred` concept (#916) and is two further reads, so the views
 *   say which half was checked.
 * * **`byte_size` and `byte_phrase` are still empty, and this is the gap that
 *   remains.** The size is `core_content_item.byte_size`: a second table, and
 *   `select` is a list of REAL columns — the vault quotes every entry as an
 *   identifier (`log::identifiers::quoted`) — so there is no expression, no
 *   subquery in a projection and no join. `with_document_size` is the nearest
 *   computed column and does not fit twice over: it keys on
 *   `current_content_id`, which `media_asset` does not have (so it would be
 *   REFUSED AT PREPARE, not answered with nulls), and it yields the vault's
 *   formatted PHRASE for one row. A leg could be keyed — but its rows come back
 *   as `(content_id, byte_size)` and `DuplicateMember` carries no content id or
 *   hash to match them against, so nothing on the wire says which copy each
 *   size belongs to. The phrase is left empty rather than composed here,
 *   because a size is the VAULT's to spell: `format_byte_size` is `pub` in
 *   `crates/vault/src/page.rs` precisely so there is one of it, and a second
 *   spelling in a shell is what that rule refuses.
 * * **The suggestion is therefore not the one the contract describes.**
 *   `DuplicateReviewData.suggested_keep_asset_id` is specified as the largest
 *   by BYTES, and bytes are the gap above. What this read can compare is
 *   PIXELS, so it suggests the largest by pixel dimensions and says so in
 *   `suggestion_reason` — the field exists precisely so the reason is stated
 *   rather than assumed. When nothing distinguishes the members, there is NO
 *   suggestion: an arbitrary one with an invented reason is the product
 *   choosing, which is the thing this pair of screens is built to refuse.
 *
 * The remaining gap is named in this lane's report; the fix is a contract
 * decision and not a screen's.
 */
public object DuplicateReviewReads :
    ScreenReads<DuplicateReviewState, DuplicateReviewEvent>,
    ScreenWrites<DuplicateReviewState, DuplicateReviewEvent> {
    override val screenId: String = DuplicateReviewMachine.SCREEN_ID

    /** `media_asset`, the same table the machine's `rowsChanged` declares. */
    override val table: String = "media_asset"

    /**
     * Far more copies than a cluster has, on purpose.
     *
     * A near-duplicate cluster is a burst or a re-import: a handful. The
     * ceiling is generous so that filling it is not a case anybody has to think
     * about — and if it ever does fill, the members past the edge are simply
     * not shown, which is the SAFE direction: a resolve trashes what is on the
     * screen and nothing else, so an unshown copy survives rather than
     * disappearing unseen.
     */
    override val limit: Int = 200

    /**
     * One cluster's live members, or null before the screen knows which cluster.
     *
     * The id comes off the STATE, where `Opened` put it — `ScreenHost`
     * publishes the state before it emits the same reduce's effects, so by the
     * time this is asked the id is there. Null when it is not, which
     * `ScreenRuntime` turns into a sentence rather than into silence; an
     * unbound read would otherwise be a read of the WHOLE library offered to a
     * member as one cluster to delete from.
     *
     * The select carries both order columns — `asset_id` is both, being the
     * sort and the tiebreak — and `content_id` is deliberately ABSENT:
     * `with_held_thumbnail` is a correlated subquery on `{from}.content_id`
     * resolved by the vault, so the column is what the FLAG needs and not what
     * the projection needs (`PhotosReads` says the same of its own statement).
     *
     * [afterCursor] is ignored: there is no event that could produce one, and
     * re-reading the first page is the honest answer to a walk this screen does
     * not have.
     */
    override fun query(state: DuplicateReviewState, afterCursor: String?): PageQuery? {
        val clusterId = state.cluster_id.takeIf { it.isNotEmpty() } ?: return null
        return PageQuery(
            name = "photos.duplicate.members",
            select = listOf("asset_id", "captured_at", "width", "height", "kind"),
            from = table,
            where_ = "asset_id IN (SELECT asset_id FROM media_asset_phash " +
                "WHERE cluster_id = ?) AND deleted_at IS NULL",
            bind = listOf(Value(text = clusterId)),
            order = PageOrder(
                sort_column = "asset_id",
                pk_column = "asset_id",
                descending = false,
            ),
            // THE SAME APPENDED COLUMNS THE GRID READS (D-1025-S7-20). A
            // review that drew placeholders where the grid a tap earlier drew
            // photographs would be asking a member to choose between four
            // grey squares.
            with_held_thumbnail = true,
        )
    }

    override fun arrived(rows: List<Row>, nextCursor: String?): DuplicateReviewEvent {
        val members = rows.map(::memberOf)
        // ONE SUGGESTION, AND ITS REASON RIDES WITH IT. No suggestion means no
        // reason — a sentence explaining a recommendation that is not there is
        // how a view ends up drawing "This is the largest" beside nothing.
        val suggested = suggestedKeep(members)
        return DuplicateReviewEvent(
            data_ = DuplicateReviewEvent.DataArrived(
                data_ = DuplicateReviewData(
                    members = members,
                    suggested_keep_asset_id = suggested ?: "",
                    suggestion_reason = if (suggested == null) "" else SUGGESTION_REASON,
                    // NOTHING HAS ASKED YET. `DuplicateReviewLeg` is what turns
                    // this true, including on an empty answer — "none of these
                    // is in an album" is a finding, and a screen that cannot
                    // tell it from "nobody looked" must not stop hedging.
                    placements_checked = false,
                ),
            ),
        )
    }

    override fun refused(failure: ReadFailure): DuplicateReviewEvent =
        DuplicateReviewEvent(refused = DuplicateReviewEvent.ReadRefused(failure = failure))

    /**
     * One member out of one row.
     *
     * `held` is [PhotosReads.heldOf], the SAME derivation the grid uses, called
     * rather than restated: a second spelling of "what does this device have of
     * this photograph" is a second answer waiting to disagree with the first,
     * and it would disagree on the screen where a member is deciding what to
     * delete. `HELD_FETCHING` is not produced here for the same reason it is
     * not produced there — it is a fact about a tap, not about the replica.
     *
     * `byte_size` is zero and `member_placed` is false. See the file header:
     * both are other tables and neither is guessed at.
     */
    private fun memberOf(row: Row): DuplicateMember = DuplicateMember(
        asset_id = row.text(ASSET_ID),
        thumbnail_path = row.text(THUMBNAIL).ifEmpty { null },
        byte_size = 0L,
        // AND NO PHRASE EITHER, WHICH IS NOT "0 bytes". A size is the VAULT's
        // to spell (`format_byte_size`), nothing serves that function to a
        // shell, and a second spelling composed here is exactly what the rule
        // refuses. Empty is what the field's own comment calls unknown, and the
        // views draw nothing for it.
        byte_phrase = "",
        // A MISSING DIMENSION IS ZERO AND THE VIEWS DRAW NOTHING FOR ZERO.
        // `width` and `height` are nullable in the DDL, and a photograph whose
        // pixel size the vault does not know must show no pixel size rather
        // than "0 x 0", which reads as a broken file.
        width = row.integer(WIDTH).toInt(),
        height = row.integer(HEIGHT).toInt(),
        captured_at = row.text(CAPTURED_AT),
        // FALSE OUT OF THIS READ, AND `placements_checked` IS FALSE BESIDE
        // IT. The answer is [DuplicateReviewLeg]'s, and it arrives through its
        // own event arm. Until it does, the pair says "not asked" rather than
        // "no" — which is the whole reason the flag exists.
        member_placed = false,
        held = PhotosReads.heldOf(
            thumbnail = row.text(THUMBNAIL).isNotEmpty(),
            originalHeld = row.integer(ORIGINAL_HELD) > 0L,
            originalHash = row.text(ORIGINAL_HASH),
            kind = kindOf(row.text(KIND)),
            rule = LinkConditions.rule,
            metered = LinkConditions.metered,
        ),
    )

    /**
     * THE RECOMMENDATION, AND IT IS ONLY EVER A RECOMMENDATION.
     *
     * The largest by pixel area, and `null` — no suggestion at all — whenever
     * that cannot be said honestly:
     *
     * * no member carries dimensions, so there is nothing to compare;
     * * or two members TIE at the largest, so "the largest" names two
     *   photographs and picking between them would be the product choosing.
     *
     * Nothing downstream may turn this into a decision:
     * [DuplicateReviewMachine] never writes it into `keep_asset_id`, and both
     * views draw it as a hint on a row rather than as a ticked box. That is the
     * whole distinction the contract asks for, and it is worth restating at the
     * place the suggestion is made: a suggestion a member has not accepted must
     * not be able to delete anything.
     */
    internal fun suggestedKeep(members: List<DuplicateMember>): String? {
        val sized = members.filter { it.width > 0 && it.height > 0 }
        if (sized.isEmpty()) return null
        val largest = sized.maxOf { it.width.toLong() * it.height.toLong() }
        val winners = sized.filter { it.width.toLong() * it.height.toLong() == largest }
        return winners.singleOrNull()?.asset_id
    }

    /**
     * WHY THIS ONE, IN A MEMBER'S WORDS — and it says PIXELS because pixels are
     * what this read can compare. The contract's own wording is "the largest by
     * bytes"; `core_content_item.byte_size` is a second table this door cannot
     * reach, and a reason that named bytes over a comparison of pixels would be
     * a sentence that is simply false on a cluster where the smaller image is
     * the bigger file.
     */
    internal const val SUGGESTION_REASON: String =
        "This is the largest of these copies, by pixels."

    /** The app a write is logged under. See [ScreenWrites.appId]. */
    override val appId: String = "photos"

    /**
     * One trashed copy, settled.
     *
     * `EXECUTED` is committed and everything else is not — including
     * `QUEUED`, `IN_FLIGHT` and `PARKED`, which cannot occur any more (the
     * phone is the vault and a write commits here or it does not) and are
     * folded in with the refusals rather than being read as success. A copy
     * this screen reported as trashed and the vault did not trash is the
     * failure a member would only find out about later.
     */
    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): DuplicateReviewEvent =
        DuplicateReviewEvent(
            write_settled = DuplicateReviewEvent.WriteSettled(
                committed = status == CommandStatus.COMMAND_STATUS_EXECUTED,
                sentence = sentence,
            ),
        )

    /** The projection's order, as constants, so a moved column moves once. */
    private const val ASSET_ID: Int = 0
    private const val CAPTURED_AT: Int = 1
    private const val WIDTH: Int = 2
    private const val HEIGHT: Int = 3
    private const val KIND: Int = 4

    /**
     * The three computed columns, in the order `crates/core`'s `api::page`
     * appends them — after the five [query]'s `select` names. They move
     * together with that list and nowhere else; `PhotosReads` carries the same
     * three constants against its own.
     */
    private const val THUMBNAIL: Int = 5
    private const val ORIGINAL_HASH: Int = 6
    private const val ORIGINAL_HELD: Int = 7

    /**
     * The DDL's four `kind` values, as the proto's four.
     *
     * A fifth from a newer gateway is `KIND_UNSPECIFIED` and never a
     * photograph — the same rule `PhotosReads` states, restated because the
     * held derivation it feeds treats a video differently from a still under a
     * cellular rule.
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

/**
 * WHICH OF THESE COPIES THE MEMBER PUT SOMEWHERE (#1029, photos port).
 *
 * `DuplicateReviewReads` reads the members; this reads `core_collection_entry`
 * for the ones that are in an album. **It is the difference between deleting a
 * stray copy and deleting a copy somebody filed**, which is the fact the proto
 * says the screen must state — and the reason `member_placed` is not allowed to
 * default to false and stand in for "nobody checked".
 *
 * ## Its own event arm, and why the lightbox's trick would not work here
 *
 * The answer arrives as [DuplicateReviewEvent.PlacementArrived] and not a second
 * `DataArrived`. A reducer handed two `DataArrived`s cannot tell an AMENDMENT
 * from a REPLACE, and the discriminator the lightbox uses — "a detail with no
 * `asset_id` is an amendment" — inverts here: the asset ids are exactly what
 * this leg has to say, so absence cannot mark it. The shelf's own leg gets away
 * with the lightbox's shape because a cluster id is something a read of
 * `media_asset` genuinely cannot produce; a placement read has no such
 * unfillable field, so the contract grew an arm instead.
 *
 * ## What "placed" means here, exactly
 *
 * **An album entry, and not yet a favourite.** `target_type = 'media.asset'`
 * against `core_collection_entry` is the album half, and it is one statement.
 * The star is NOT a column — it is a `core_tag` row pointing at the `starred`
 * concept of the flags scheme (#916, ONT-03, and `queries.rs`'
 * `STARRED_NOTATION`), which is two further reads to resolve the scheme and the
 * concept before the tags can be asked for at all. Those legs are not built, so
 * the views say which half was checked rather than letting "placed: false" be
 * read as "this copy is a stray". Named in this lane's report.
 */
public class DuplicateReviewLeg internal constructor(
    public val leg: DuplicateReviewMachine.Leg,
) : ScreenReads<DuplicateReviewState, DuplicateReviewEvent> {
    override val screenId: String = DuplicateReviewMachine.readId(leg)

    override val table: String = when (leg) {
        DuplicateReviewMachine.Leg.PLACEMENTS -> "core_collection_entry"
    }

    /**
     * A CEILING, AND A FULL PAGE COSTS A LABEL AND NEVER A NUMBER.
     *
     * One entry per (album, asset) pair over a handful of copies. Nothing here
     * is counted, so the worst a full page can do is leave one copy's "in an
     * album" undrawn — and the ceiling is generous enough that a cluster would
     * have to be filed into two hundred albums to reach it.
     */
    override val limit: Int = 200

    /**
     * The album entries for the copies on screen, or null before there are any.
     *
     * Keyed on [centraid.screen.v1.DuplicateMember.asset_id], which is already
     * on the state — the placement question is about the copies the member is
     * looking at, and an unbound read would be every album entry in the vault.
     *
     * Sort and primary key are the same column, `crates/apps/photos`' idiom for
     * a set read by id and what its own `album_entries_statement` uses.
     */
    override fun query(state: DuplicateReviewState, afterCursor: String?): PageQuery? {
        val ids = state.data_?.members?.map { it.asset_id }?.filter { it.isNotEmpty() }
            ?.takeIf { it.isNotEmpty() }
            ?: return null
        return PageQuery(
            name = "photos.duplicate.placements",
            select = listOf("entry_id", "target_id"),
            from = table,
            where_ = "target_type = ? AND " + inList("target_id", ids.size),
            bind = listOf(Value(text = ASSET_TARGET_TYPE)) + ids.map { Value(text = it) },
            order = PageOrder(
                sort_column = "entry_id",
                pk_column = "entry_id",
                descending = false,
            ),
        )
    }

    /**
     * The copies that are in at least one album.
     *
     * Distinct, because a photograph filed into three albums is one placed
     * copy and not three — the screen's question is "did somebody put this
     * somewhere", which has one answer per asset.
     *
     * **An empty page is a REAL ANSWER and is still sent.** None of these
     * copies is in an album, and that is exactly as much of a finding as the
     * opposite: it is what turns `placements_checked` true, which is what lets
     * the view stop hedging. A leg that went quiet on an empty page would leave
     * the screen permanently saying "Centraid could not check".
     */
    override fun arrived(rows: List<Row>, nextCursor: String?): DuplicateReviewEvent =
        DuplicateReviewEvent(
            placements = DuplicateReviewEvent.PlacementArrived(
                placed_asset_ids = rows.map { it.text(TARGET_ID) }
                    .filter { it.isNotEmpty() }
                    .distinct(),
            ),
        )

    /**
     * A REFUSED LEG IS SILENT, AND SILENCE IS THE CORRECT OUTCOME HERE.
     *
     * No event at all, so `placements_checked` stays FALSE and the views keep
     * saying the question was not answered. An empty `PlacementArrived` would
     * say the opposite — "checked, and none of them is filed" — about a read
     * that was refused, which on a screen that deletes photographs is the
     * failure this whole leg exists to prevent.
     */
    override fun refused(failure: ReadFailure): DuplicateReviewEvent = DuplicateReviewEvent()

    private companion object {
        /** `crates/apps/photos`' `TAG_TARGET_TYPE`, spelled the same. */
        const val ASSET_TARGET_TYPE: String = "media.asset"

        const val TARGET_ID: Int = 1

        fun inList(column: String, count: Int): String =
            column + " IN (" + List(count) { "?" }.joinToString(", ") + ")"

        /** Positional, as the door states. See `HomeReads.text` for why only TEXT. */
        fun Row.text(index: Int): String = values.getOrNull(index)?.text ?: ""
    }
}
