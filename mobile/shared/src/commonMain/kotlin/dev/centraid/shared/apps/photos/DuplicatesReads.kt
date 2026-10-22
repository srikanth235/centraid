package dev.centraid.shared.apps.photos

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.PhotosDuplicateCluster
import centraid.core.v1.PhotosDuplicatesRequest
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.DuplicateCluster
import centraid.screen.v1.DuplicatesData
import centraid.screen.v1.DuplicatesEvent
import centraid.screen.v1.DuplicatesState
import centraid.screen.v1.ReadFailure
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.sync.ScreenQueries
import dev.centraid.shared.sync.ScreenReads

/**
 * WHAT THE DUPLICATES SHELF READS, AND WHAT IT MAKES OF THE ANSWER
 * (#1029, photos port; #1135).
 *
 * ## THE CLUSTERS ARE THE CORE'S, AND THIS IS AN APP QUERY
 *
 * A near-duplicate is a photograph whose perceptual hash (a `phash` derivative of
 * its blob) is within a few bits of another's, and the grouping — union-find over
 * the Hamming distance, the group's lowest photograph id as its key — lives in
 * `centraid_media::duplicates`, in the core, and nowhere else. So the shelf asks
 * the core (`photos.duplicates`, `photos.proto`) and gets the clusters back as
 * lists of live photograph ids, of two or more each, biggest first. Nothing is
 * stored: a cluster is a projection of the hashes, recomputed whenever it is
 * asked for, so a trashed photograph or a new hash is in the next answer without
 * a sweep to run. A page read cannot say it — the door has no join, no
 * aggregate and no Hamming distance.
 *
 * ## WHAT THIS ANSWER CANNOT REACH, AND WHAT A LEG DOES
 *
 * The answer names photographs by id and carries nothing a card draws. So the
 * shelf is TWO reads. This one folds the clusters and fills
 * [DuplicateCluster.member_asset_ids]; [DuplicatesLeg] reads `photo` keyed on
 * those ids and amends each card with a COVER. That field is the whole reason
 * the second read is possible, exactly as `PhotoDetail.original_hash` is what
 * the lightbox's content leg keys on.
 *
 * **THE BYTES ARE ONE HOP FURTHER, AND THAT HOP IS NOT BUILT.**
 * `reclaimable_bytes` is a cluster's members' blob sizes summed, less the
 * largest. `DuplicateCluster` has somewhere to put it and no read serves it, so
 * `reclaimable_bytes` and `total_reclaimable_bytes` stay ZERO and `total_capped`
 * stays true beside them: "at least 0 bytes" cannot overstate, where `false`
 * would assert an exact total of zero over a shelf with eleven sets on it.
 *
 * **AND THE PHRASES STAY EMPTY, WHICH IS NOT "0 bytes".** A size is the VAULT's
 * to spell — `format_byte_size` is `pub` in `crates/vault/src/page.rs` precisely
 * so there is one of it, and nothing serves that function to a shell for a SUM. A
 * phrase composed here would be the second spelling that rule exists to refuse,
 * so there is none, and the views draw the bytes line only when a phrase arrives.
 *
 * **`scan_complete` IS FALSE ON EVERY READ THIS BUILD CAN MAKE.** The hashes are
 * derived as photographs arrive and nothing records how far a library has been
 * walked, so the only honest answer is the conservative one: a member whose
 * library has simply not been walked must not be told it is clean.
 *
 * ## THE ORDER IS THE CONTRACT'S, WITH A SECOND KEY THAT IS NOT DECORATION
 *
 * `reclaimable_bytes` descending first, because that is the number that makes
 * the work worth doing. It is zero on every card this build produces, so on its
 * own that comparator would collapse to the cluster id — a hash of nothing a
 * member can see. `member_count` descending sits behind it: the desktop's own key
 * (`fold_clusters`), and a real proxy for "bigger job" while the bytes are
 * unknown. The cluster id is last so the order is TOTAL.
 */
public object DuplicatesReads : ScreenQueries<DuplicatesState, DuplicatesEvent> {
    override val screenId: String = DuplicatesMachine.SCREEN_ID

    /** What a cluster is made of, and what a commit can change about it. */
    override val tables: Set<String> = DuplicatesMachine.TABLES

    override fun requests(state: DuplicatesState, now: DeviceClock.Reading): List<AppQueryRequest> =
        listOf(AppQueryRequest(photos_duplicates = PhotosDuplicatesRequest()))

    override fun arrived(answers: List<AppQueryResponse>): DuplicatesEvent {
        val clusters = answers.firstNotNullOfOrNull { it.photos_duplicates }?.clusters.orEmpty()
        return DuplicatesEvent(
            data_ = DuplicatesEvent.DataArrived(
                data_ = DuplicatesData(
                    clusters = foldClusters(clusters),
                    // NO CURSOR: the core answers the whole shelf.
                    next_cursor = null,
                    // ZERO BECAUSE IT IS UNKNOWN, AND THE VIEWS DRAW NOTHING FOR ZERO.
                    total_reclaimable_bytes = 0L,
                    total_capped = true,
                    // FALSE, ALWAYS, AND ON PURPOSE. See the header.
                    scan_complete = false,
                ),
            ),
        )
    }

    override fun refused(failure: ReadFailure): DuplicatesEvent =
        DuplicatesEvent(refused = DuplicatesEvent.ReadRefused(failure = failure))

    /**
     * THE FOLD, over what the core answered.
     *
     * Two rules, both the desktop's, and the core already keeps the first:
     *
     * 1. **A cluster of fewer than two photographs is no duplicate.** A
     *    "duplicate" with one member is a photograph.
     * 2. **Biggest cluster first, ties broken by the cluster id**, so the order
     *    is TOTAL.
     *
     * `member_asset_ids` are in id order, which is the order two devices folding
     * the same vault agree on, so a card's cover is the same on both.
     * `member_count` is EXACT: the core answers every member of every cluster.
     */
    internal fun foldClusters(clusters: List<PhotosDuplicateCluster>): List<DuplicateCluster> = clusters
        .filter { it.photo_ids.size >= 2 && it.key.isNotEmpty() }
        .map { cluster ->
            val members = cluster.photo_ids.filter { it.isNotEmpty() }.distinct().sorted()
            DuplicateCluster(
                cluster_id = cluster.key,
                member_count = members.size,
                // THE KEY THE SECOND LEG HANGS ON, and the whole reason the shelf
                // can draw a cover at all.
                member_asset_ids = members,
                member_count_capped = false,
                reclaimable_bytes = 0L,
                cover_thumbnail_path = null,
            )
        }
        .filter { it.member_count >= 2 }
        .sortedWith(
            compareByDescending<DuplicateCluster> { it.reclaimable_bytes }
                .thenByDescending { it.member_count }
                .thenBy { it.cluster_id },
        )
}

/**
 * THE SHELF'S SECOND STATEMENT (#1029, photos port).
 *
 * `DuplicatesReads` folds the core's clusters into cards. This reads
 * `photo` for the photographs those cards named, so each card can draw a COVER
 * — one of the photographs it is about, rather than a mark standing in for one.
 *
 * ## Why it is a second `ScreenReads` and not a branch
 *
 * The door serves ONE statement per screen id, and `arrived` is handed rows with
 * no note saying which statement produced them. A single object switching on a
 * phase it kept in a field would be a field two reads in flight can race, and
 * nothing in the runtime sequences them — `PhotoLightboxLeg` says the same and
 * has six of these. One statement, one projection, one screen id
 * ([DuplicatesMachine.readId]), and the pairing cannot come apart.
 *
 * It is attached with [dev.centraid.shared.shell.HomeSession.attachReads] and
 * NOT a second `attachScreen`: the second also calls `changes.route(host)`,
 * which is registration with no removal, so a screen routed twice answers every
 * change event with two re-reads for ever.
 *
 * ## What it returns, and why that shape
 *
 * One `DuplicateCluster` per ASSET, with **no `cluster_id`** and a single entry
 * in `member_asset_ids`. That is an AMENDMENT and the machine folds it onto the
 * card whose `member_asset_ids` contains that asset. The empty cluster id is the
 * discriminator and it is one this read cannot avoid honestly: `cluster_id`
 * lives on the perceptual hashes alone, so a statement over `photo` has none
 * to give and would have to invent one to be mistaken for the fold. The
 * lightbox's is the same shape — "a detail with no `asset_id` is an amendment".
 */
public class DuplicatesLeg internal constructor(
    public val leg: DuplicatesMachine.Leg,
) : ScreenReads<DuplicatesState, DuplicatesEvent> {
    override val screenId: String = DuplicatesMachine.readId(leg)

    override val table: String = when (leg) {
        DuplicatesMachine.Leg.ASSETS -> "photo"
    }

    /**
     * THE SAME CEILING THE FOLD READ UNDER.
     *
     * The shelf's own page is `MAX_PAGE_ROWS` fingerprints, so the ids this is
     * keyed on can number as many, and asking for fewer would leave the last
     * cards coverless for no reason a member could work out. It does not walk:
     * a full page here costs a cover, never a wrong number, because nothing on
     * this leg is counted.
     */
    override val limit: Int = 500

    /**
     * The clustered assets, bound by the ids the fold put on the state.
     *
     * Null when the shelf has no cards yet, or has cards with no members —
     * which `ScreenRuntime` turns into a sentence rather than into silence, and
     * which [DuplicatesMachine] avoids by not emitting this read at all in that
     * case. An unbound read here would be a read of the WHOLE library to
     * decorate a handful of cards.
     *
     * `deleted_at IS NULL` is the desktop's rule and the same one the review
     * screen keeps: **only LIVE assets ride a cluster card**, so a cover is
     * never a photograph already in the trash.
     *
     * Sort and primary key are the same column, which is `crates/apps/photos`'
     * own idiom for a set read by id (`content_statement`, `concepts_statement`)
     * and what keeps this off the nullable `captured_at` whose continued page
     * the door refuses.
     */
    override fun query(state: DuplicatesState, afterCursor: String?): PageQuery? {
        val ids = state.data_?.clusters?.flatMap { it.member_asset_ids }?.distinct()
            ?.takeIf { it.isNotEmpty() }
            ?: return null
        return PageQuery(
            name = "photos.duplicates.assets",
            select = listOf("id"),
            from = table,
            where_ = inList("id", ids.size) + " AND ${PhotoFold.NOT_TRASHED}",
            bind = ids.map { Value(text = it) },
            order = PageOrder(
                sort_column = "id",
                pk_column = "id",
                descending = false,
            ),
            // THE WHOLE POINT OF THE LEG. `photo` carries a `blob`, so the
            // door's correlated thumbnail subquery resolves here.
            with_held_thumbnail = true,
        )
    }

    /**
     * One amendment per asset that actually has bytes on this device.
     *
     * A row with no thumbnail path is DROPPED rather than carried as an empty
     * one: an amendment says "here is a cover", and an amendment carrying
     * nothing is a message with no content that the machine would have to learn
     * to ignore. The absence of a card's cover is already said by
     * `cover_thumbnail_path` being null.
     */
    override fun arrived(rows: List<Row>, nextCursor: String?): DuplicatesEvent {
        val amendments = rows.mapNotNull { row ->
            val assetId = row.text(ASSET_ID)
            val path = row.text(THUMBNAIL)
            if (assetId.isEmpty() || path.isEmpty()) {
                null
            } else {
                DuplicateCluster(
                    // NO CLUSTER ID, AND THAT IS THE DISCRIMINATOR. See the
                    // type note: this statement has none to give.
                    member_asset_ids = listOf(assetId),
                    cover_thumbnail_path = path,
                )
            }
        }
        // **AN AMENDMENT WITH NOTHING TO AMEND SAYS NOTHING AT ALL**, and this
        // is the one place the discriminator could otherwise be mistaken: a
        // `DataArrived` carrying no clusters is exactly what an empty FOLD
        // looks like, so sending one from here would blank a shelf the member
        // is reading whenever no member of any cluster had bytes on the device.
        // An event with no arm set reduces through every machine's `else` to
        // `Step(state)`, which is the honest shape of "nothing to add".
        return if (amendments.isEmpty()) {
            DuplicatesEvent()
        } else {
            DuplicatesEvent(
                data_ = DuplicatesEvent.DataArrived(
                    data_ = DuplicatesData(clusters = amendments),
                ),
            )
        }
    }

    /**
     * A REFUSED LEG IS SILENT — and silent means NO EVENT, not an empty one.
     *
     * `DuplicatesData` has no per-part failure slot, and the alternative is
     * replacing a shelf the member can use with a sentence because the cover
     * read was refused. The cost is stated rather than hidden: the cards draw
     * their mark instead of a photograph and nothing says why.
     * `PhotoLightboxLeg` makes the same trade and names the same want — a field
     * on the message, which is the root's to add.
     *
     * An empty `DataArrived` here would be worse than the refusal: it is the
     * shape of a fold that found no duplicates, and it would clear the shelf.
     */
    override fun refused(failure: ReadFailure): DuplicatesEvent = DuplicatesEvent()

    private companion object {
        const val ASSET_ID: Int = 0

        /** The door's appended column, after the one this `select` names. */
        const val THUMBNAIL: Int = 1

        fun inList(column: String, count: Int): String =
            column + " IN (" + List(count) { "?" }.joinToString(", ") + ")"

        /** Positional, as the door states. See `HomeReads.text` for why only TEXT. */
        fun Row.text(index: Int): String = values.getOrNull(index)?.text ?: ""
    }
}
