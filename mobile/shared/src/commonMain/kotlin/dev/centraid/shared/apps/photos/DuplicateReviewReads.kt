package dev.centraid.shared.apps.photos

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.CommandStatus
import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.PhotosDuplicatesRequest
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.DuplicateMember
import centraid.screen.v1.DuplicateReviewData
import centraid.screen.v1.DuplicateReviewEvent
import centraid.screen.v1.DuplicateReviewState
import centraid.screen.v1.PhotoCell
import centraid.screen.v1.ReadFailure
import dev.centraid.core.CentraidCore
import dev.centraid.shared.sync.AppQueryOutcome
import dev.centraid.shared.sync.LinkConditions
import dev.centraid.shared.sync.ScreenReads
import dev.centraid.shared.sync.ScreenWrites
import dev.centraid.shared.sync.askCore

/**
 * WHAT ONE CLUSTER'S REVIEW READS, AND WHAT IT MAKES OF THE ROWS
 * (#1029, photos port; #1135).
 *
 * A cluster is the core's (`photos.duplicates`, [DuplicateClusterMembers]): the
 * grouping is a projection of the photographs' perceptual hashes and no page read
 * can say it. A screen has ONE statement —
 * [dev.centraid.shared.sync.ScreenRuntime] calls [query] once per `ReadPage` and
 * hands the rows straight to [arrived], which is never told which statement
 * produced them — so the read is arranged around what the core said: one page of
 * `photo`, with the cluster's members as the predicate:
 *
 * ```
 * id IN (the cluster's photographs) AND <not in the trash>
 * ```
 *
 * The trash predicate is the desktop's own rule and it matters here more than
 * anywhere: **only LIVE photographs ride a cluster card.** A trashed member of
 * an old cluster is not something to offer trashing again — and after a resolve
 * it is exactly what the re-read must not bring back.
 *
 * The sort column is `id`, which is NOT NULLABLE, so unlike the shelf this read
 * could be walked. It is not: `DuplicateReviewEvent` has no `NextPageRequested`,
 * because a cluster is a handful of copies of one photograph. [limit] says what
 * happens if that is ever wrong.
 *
 * ## WHAT THIS STATEMENT REACHES, AND WHAT A SECOND ONE DOES
 *
 * * **`member_placed` IS A LEG**, [DuplicateReviewLeg], over `edge` keyed on the
 *   photograph ids this read puts on the wire. It arrives through its own event
 *   arm and sets `placements_checked`, because **false is not a safe default on a
 *   screen that deletes photographs**: it reads as "this is a stray copy" about a
 *   photograph that may be in three albums. Out of THIS read it is false and
 *   `placements_checked` is false with it, which is the views' cue to say the
 *   question is open rather than answer it. The leg covers ALBUMS and the star:
 *   both are `edge`s now, and one statement says which copies are placed.
 * * **`byte_size` and `byte_phrase` are still empty, and this is the gap that
 *   remains.** The size is `blob.size`: a second table, and `select` is a list of
 *   REAL columns — the vault quotes every entry as an identifier — so there is no
 *   expression, no subquery in a projection and no join. A leg could be keyed —
 *   but its rows come back as `(hash, size)` and `DuplicateMember` carries no hash
 *   to match them against, so nothing on the wire says which copy each size
 *   belongs to. The phrase is left empty rather than composed here, because a
 *   size is the VAULT's to spell: `format_byte_size` is `pub` in
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
 * The remaining gap is a contract decision and not a screen's.
 */
public object DuplicateReviewReads :
    ScreenReads<DuplicateReviewState, DuplicateReviewEvent>,
    ScreenWrites<DuplicateReviewState, DuplicateReviewEvent> {
    override val screenId: String = DuplicateReviewMachine.SCREEN_ID

    /** `photo`, the same table the machine's `rowsChanged` declares. */
    override val table: String = "photo"

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
     * The select carries both order columns — `id` is both, being the sort and
     * the tiebreak — and `blob` is deliberately ABSENT: `with_held_thumbnail` is
     * a correlated subquery on `{from}.blob` resolved by the vault, so the column
     * is what the FLAG needs and not what the projection needs (`PhotosReads` says
     * the same of its own statement).
     *
     * [afterCursor] is ignored: there is no event that could produce one, and
     * re-reading the first page is the honest answer to a walk this screen does
     * not have.
     */
    override fun query(state: DuplicateReviewState, afterCursor: String?): PageQuery? {
        val clusterId = state.cluster_id.takeIf { it.isNotEmpty() } ?: return null
        val members = DuplicateClusterMembers.of(clusterId)
        // A CLUSTER THE CORE DOES NOT ANSWER HAS NO MEMBERS TO OFFER, and an unbound
        // read here would be the WHOLE library offered to a member as one cluster to
        // delete from.
        if (members.isEmpty()) return null
        return PageQuery(
            name = "photos.duplicate.members",
            select = listOf("id", "taken_at", "width", "height", "form"),
            from = table,
            where_ = "id IN (" + members.joinToString(", ") { "?" } + ") AND ${PhotoFold.NOT_TRASHED}",
            bind = members.map { Value(text = it) },
            order = PageOrder(
                sort_column = "id",
                pk_column = "id",
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
            kind = PhotosReads.kindOf(row.text(KIND)),
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
     * bytes"; `blob.size` is a second table this door cannot
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

    /** Positional, as the door states. See `HomeReads.text` for why only TEXT. */
    private fun Row.text(index: Int): String = values.getOrNull(index)?.text ?: ""

    private fun Row.integer(index: Int): Long = values.getOrNull(index)?.integer ?: 0L
}

/**
 * WHICH OF THESE COPIES THE MEMBER PUT SOMEWHERE (#1029, photos port; #1135).
 *
 * `DuplicateReviewReads` reads the members; this reads `edge` for the ones that
 * are in an album or starred. **It is the difference between deleting a stray
 * copy and deleting a copy somebody filed**, which is the fact the proto says the
 * screen must state — and the reason `member_placed` is not allowed to default to
 * false and stand in for "nobody checked".
 *
 * ## Its own event arm, and why the lightbox's trick would not work here
 *
 * The answer arrives as [DuplicateReviewEvent.PlacementArrived] and not a second
 * `DataArrived`. A reducer handed two `DataArrived`s cannot tell an AMENDMENT
 * from a REPLACE, and the discriminator the lightbox uses — "a detail with no
 * `asset_id` is an amendment" — inverts here: the photograph ids are exactly what
 * this leg has to say, so absence cannot mark it.
 *
 * ## What "placed" means here, exactly
 *
 * **An album's `contains` edge, or the `starred` flag's `tagged` edge** (#916): a
 * copy is placed when somebody filed it or favourited it. One statement says both:
 * an album edge names the photograph as its `to_id`, and a star as its `from_id`,
 * so the row carries its `rel` and [arrived] reads the right end.
 */
public class DuplicateReviewLeg internal constructor(
    public val leg: DuplicateReviewMachine.Leg,
) : ScreenReads<DuplicateReviewState, DuplicateReviewEvent> {
    override val screenId: String = DuplicateReviewMachine.readId(leg)

    override val table: String = when (leg) {
        DuplicateReviewMachine.Leg.PLACEMENTS -> "edge"
    }

    /**
     * A CEILING, AND A FULL PAGE COSTS A LABEL AND NEVER A NUMBER.
     *
     * One edge per (album, photograph) pair over a handful of copies. Nothing here
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
     * looking at, and an unbound read would be every album edge in the vault.
     *
     * An edge has no id of its own, and `(from_id, to_id)` is unique under one
     * `rel`, so the two ends are the keyset.
     */
    override fun query(state: DuplicateReviewState, afterCursor: String?): PageQuery? {
        val ids = state.data_?.members?.map { it.asset_id }?.filter { it.isNotEmpty() }
            ?.takeIf { it.isNotEmpty() }
            ?: return null
        return PageQuery(
            name = "photos.duplicate.placements",
            select = listOf("from_id", "to_id", "rel"),
            from = table,
            where_ = "(rel = 'contains' AND " + inList("to_id", ids.size) + ") OR " +
                "(rel = 'tagged' AND to_id = 'flag:starred' AND " + inList("from_id", ids.size) + ")",
            bind = ids.map { Value(text = it) } + ids.map { Value(text = it) },
            order = PageOrder(
                sort_column = "from_id",
                pk_column = "to_id",
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
                placed_asset_ids = rows.map { if (it.text(REL) == "contains") it.text(TO_ID) else it.text(FROM_ID) }
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
        const val FROM_ID: Int = 0
        const val TO_ID: Int = 1
        const val REL: Int = 2

        fun inList(column: String, count: Int): String =
            column + " IN (" + List(count) { "?" }.joinToString(", ") + ")"

        /** Positional, as the door states. See `HomeReads.text` for why only TEXT. */
        fun Row.text(index: Int): String = values.getOrNull(index)?.text ?: ""
    }
}

/**
 * A CLUSTER'S MEMBERS, AS THE CORE LAST SAID THEM (#1135).
 *
 * The grouping is `photos.duplicates`' (union-find over the photographs' perceptual
 * hashes), and the review screen is opened with only the cluster's key, so the
 * bridge asks the core once as the screen opens and the read ([DuplicateReviewReads])
 * binds what was said. A key the core no longer answers remembers nothing.
 */
internal object DuplicateClusterMembers {
    private var held: Map<String, List<String>> = emptyMap()

    /** The photograph ids of cluster [key] as last asked, in id order; empty when unknown. */
    fun of(key: String): List<String> = held[key].orEmpty()

    /** Keep [ids] as cluster [key]'s members (what [ask] does with the core's answer). */
    fun remember(key: String, ids: List<String>) {
        held = mapOf(key to ids.filter { it.isNotEmpty() }.distinct().sorted())
    }

    /** Ask [core] for the clusters and keep [key]'s members (and drop the rest). */
    suspend fun ask(core: CentraidCore?, key: String) {
        val answer = askCore(core, listOf(AppQueryRequest(photos_duplicates = PhotosDuplicatesRequest())))
        val clusters = (answer as? AppQueryOutcome.Answered)?.answers
            ?.firstNotNullOfOrNull { it.photos_duplicates }?.clusters
        if (clusters != null) {
            held = emptyMap()
            clusters.firstOrNull { it.key == key }?.let { remember(key, it.photo_ids) }
        }
    }
}
