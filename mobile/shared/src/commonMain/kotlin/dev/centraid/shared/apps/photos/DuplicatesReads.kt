package dev.centraid.shared.apps.photos

import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.DuplicateCluster
import centraid.screen.v1.DuplicatesData
import centraid.screen.v1.DuplicatesEvent
import centraid.screen.v1.DuplicatesState
import centraid.screen.v1.ReadFailure
import dev.centraid.shared.sync.ScreenReads

/**
 * WHAT THE DUPLICATES SHELF READS, AND WHAT IT MAKES OF THE ROWS
 * (#1029, photos port).
 *
 * The statement is `crates/apps/photos`' own — `photos.duplicates.phashes` in
 * `duplicates.rs`: `media_asset_phash WHERE cluster_id IS NOT NULL`, ordered
 * `cluster_id ASC, asset_id ASC`. Followed rather than re-derived, for
 * `PhotosReads`' reason: a shelf in a different order from the desktop's over
 * the same fingerprints is two libraries.
 *
 * ## ONE PAGE, AND `next_cursor` IS NEVER HANDED OUT
 *
 * `cluster_id` is nullable, so the door REFUSES a continued page over it
 * (`KitError::NullableSortKey`, D-1020-P11): SQLite's row-value comparison puts
 * every NULL on one side of the keyset and the walk silently drops them. The
 * desktop asks for its four thousand fingerprints as one page and the clamp
 * gives it five hundred; this asks for the same page and does not pretend
 * otherwise. So [arrived] never fills `next_cursor` — a cursor handed to a view
 * is a control a member can press, and pressing it would come back as a refusal
 * over a shelf they were reading.
 *
 * **A FULL PAGE MEANS THE LAST GROUP IS CUT.** Rows arrive in cluster order, so
 * when the page fills the final cluster's remaining members are on a page
 * nobody will read. Its count would be wrong and — worse — a two-member cluster
 * whose second member fell past the edge would look like a cluster of one and
 * be dropped as "a photograph". The last group is therefore discarded whole
 * rather than reported short; see [foldClusters].
 *
 * ## WHAT THIS STATEMENT CANNOT REACH, AND WHAT A LEG NOW DOES
 *
 * `media_asset_phash` carries `asset_id`, `phash`, `cluster_id` and
 * `computed_at`, and nothing else a card wants is on it. In particular it has
 * NO `content_id`, which closes the door's own cross-table answers:
 * `with_held_thumbnail` is a CORRELATED SUBQUERY on `{from}.content_id`
 * resolved at PREPARE, so setting it here would fail the WHOLE read rather than
 * answer nulls (`crates/vault/src/page.rs`). And `select` is a list of REAL
 * columns — the vault quotes every entry as an identifier
 * (`log::identifiers::quoted`) — so there is no expression, no subquery in a
 * projection, no join clause and no aggregate.
 *
 * So the shelf is TWO statements. This one folds the fingerprints and fills
 * [DuplicateCluster.member_asset_ids]; [DuplicatesLeg] reads `media_asset` keyed
 * on those ids and amends each card with a COVER. That field is the whole
 * reason the second read is possible, exactly as `PhotoDetail.original_hash` is
 * what the lightbox's content leg keys on.
 *
 * **THE BYTES ARE ONE HOP FURTHER, AND THAT HOP IS NOT BUILT.**
 * `reclaimable_bytes` is a cluster's members' `core_content_item.byte_size`
 * summed, less the largest. The chain is `cluster_id -> asset_id -> content_id
 * -> byte_size`, and `DuplicateCluster` has somewhere to put the second link
 * and nowhere to put the third: a leg over `core_content_item` can be keyed,
 * but its rows come back as `(content_id, byte_size)` and nothing on the wire
 * says which asset — let alone which CLUSTER — each belongs to, while the
 * figure itself is a per-cluster aggregate rather than a per-row one. So
 * `reclaimable_bytes` and `total_reclaimable_bytes` stay ZERO, `total_capped`
 * stays true beside them, and the missing carrier is named in this lane's
 * report with the field that would close it.
 *
 * **AND THE PHRASES STAY EMPTY, WHICH IS NOT "0 bytes".**
 * `reclaimable_phrase` and `total_reclaimable_phrase` are what a member reads,
 * and a size is the VAULT's to spell — `format_byte_size` is `pub` in
 * `crates/vault/src/page.rs` precisely so there is one of it. Nothing serves
 * that function to a shell: the only door onto it is `with_document_size`,
 * which keys on `current_content_id` and yields a per-ROW phrase, and no
 * per-row phrase can spell a SUM. A phrase composed here would be the second
 * spelling that rule exists to refuse, so there is none, and the views draw the
 * bytes line only when a phrase arrives.
 *
 * **`scan_complete` IS FALSE ON EVERY READ THIS BUILD CAN MAKE.** Nothing
 * records the pass's progress: rows appear when a contributing device supplied
 * a phash (`crates/vault/src/commands/media.rs:890`), `cluster_id` is rewritten
 * wholesale by a rebuild, and there is no cursor, watermark or sweep-state row
 * anywhere in the schema — counting `media_asset` against `media_asset_phash`
 * would need a second read AND a `COUNT(*)` this door does not have. False is
 * the conservative reading and it is the one that matters: a member whose
 * library has simply not been walked must not be told it is clean.
 *
 * ## THE TWO `capped` FLAGS, AND WHY THEY POINT OPPOSITE WAYS
 *
 * `member_count_capped` is FALSE and `total_capped` is TRUE, which looks
 * inconsistent and is not. `member_count` is EXACT here, because the fold
 * refuses to report the one group a full page can cut and drops it instead —
 * so "at least 4 copies" about a cluster known to have four would understate a
 * fact this read holds. `total_reclaimable_bytes` is not capped by a page at
 * all; it is UNKNOWN, and of the two readings only "at least" is true of an
 * unknown. `false` there would assert an exact total of zero over a shelf with
 * eleven sets on it.
 *
 * ## THE ORDER IS THE CONTRACT'S, WITH A SECOND KEY THAT IS NOT DECORATION
 *
 * `reclaimable_bytes` descending first, because that is the number that makes
 * the work worth doing and a member with one evening is looking for the two
 * copies of a 200 MB video rather than four small screenshots. It is zero on
 * every card this build produces, so on its own that comparator would collapse
 * to the cluster id — a hash of nothing a member can see. `member_count`
 * descending sits behind it: the desktop's own key (`fold_clusters`), and a
 * real proxy for "bigger job" while the bytes are unknown. The cluster id is
 * last so the order is TOTAL — v0 sorted by length alone, which is not stable
 * across engines, and the card order is what a member's eye follows.
 */
public object DuplicatesReads : ScreenReads<DuplicatesState, DuplicatesEvent> {
    override val screenId: String = DuplicatesMachine.SCREEN_ID

    /** `media_asset_phash`, the same table the machine's `rowsChanged` declares. */
    override val table: String = "media_asset_phash"

    /**
     * The door's own ceiling, asked for on purpose.
     *
     * The desktop asks for `CLUSTER_ROWS` (4,000) and the vault clamps it to
     * `MAX_PAGE_ROWS` (500). There is no second page to be had over a nullable
     * sort column, so asking for the clamp is asking for everything this shelf
     * can ever see — and stating the real number here is what lets [arrived]
     * know the page filled and act on it, instead of a ceiling arriving from
     * somewhere else.
     */
    override val limit: Int = 500

    /**
     * Every clustered fingerprint, in cluster order.
     *
     * `cluster_id IS NOT NULL` is the app's predicate: a fingerprint the sweep
     * has not grouped is not a duplicate of anything, and a row with a NULL
     * cluster would in any case be dropped by the keyset the moment a cursor
     * existed.
     *
     * The select is TWO COLUMNS and both are order columns. There is no
     * `key_of` callback, so the cursor is read off the row by the two the ORDER
     * BY names; `phash` and `computed_at` are in the desktop's projection and
     * are deliberately absent from this one, because nothing on a cluster card
     * draws either and a column selected "for completeness" is a column the
     * next reader has to work out the purpose of.
     *
     * [afterCursor] is ignored. It can only be non-null if something handed out
     * a cursor, and [arrived] never does — re-reading the first page is the
     * honest answer to a walk that cannot exist.
     */
    override fun query(state: DuplicatesState, afterCursor: String?): PageQuery = PageQuery(
        name = "photos.duplicates.phashes",
        select = listOf("cluster_id", "asset_id"),
        from = table,
        where_ = "cluster_id IS NOT NULL",
        order = PageOrder(
            sort_column = "cluster_id",
            pk_column = "asset_id",
            descending = false,
        ),
    )

    override fun arrived(rows: List<Row>, nextCursor: String?): DuplicatesEvent = DuplicatesEvent(
        data_ = DuplicatesEvent.DataArrived(
            data_ = DuplicatesData(
                clusters = foldClusters(rows, pageFilled = nextCursor != null),
                // NEVER A CURSOR. See the file header: a continued page over
                // `cluster_id` is refused by the door, so handing one out
                // would put a control on the screen whose only outcome is a
                // failure over a shelf the member was reading.
                next_cursor = null,
                // ZERO BECAUSE IT IS UNKNOWN, AND THE VIEWS DRAW NOTHING FOR
                // ZERO. `core_content_item.byte_size` is a second table and
                // this door has one. A plausible number here would be the
                // worst kind of wrong: it is the figure the shelf exists to
                // justify the work by.
                total_reclaimable_bytes = 0L,
                // TRUE, AND IT IS THE STRONGER OF THE TWO READINGS.
                //
                // `total_capped` says "this figure is a FLOOR, so the honest
                // phrasing is 'at least'". Here the figure is not merely
                // capped by a page — it is unknown, because the bytes are on a
                // table this read cannot reach at all. Of the two values only
                // this one is true of an unknown: "at least 0 bytes" cannot
                // overstate, while `false` would assert "this is the exact
                // total" about a number nobody counted, and a reader
                // downstream would be entitled to print "0 bytes to reclaim"
                // over a shelf with eleven sets on it.
                total_capped = true,
                // FALSE, ALWAYS, AND ON PURPOSE. Nothing in the schema records
                // whether the phash pass has walked this library, so the only
                // honest answer is the conservative one — never tell a member
                // their library is clean on the strength of a read that cannot
                // know.
                scan_complete = false,
            ),
        ),
    )

    override fun refused(failure: ReadFailure): DuplicatesEvent =
        DuplicatesEvent(refused = DuplicatesEvent.ReadRefused(failure = failure))

    /**
     * THE FOLD, over rows that arrived in `cluster_id ASC, asset_id ASC` order.
     *
     * Consecutive grouping rather than a hash map, which is `fold_clusters`'
     * own choice: the statement's order IS the grouping, so a map would be a
     * second way of saying what the ORDER BY already said.
     *
     * Two rules, both the desktop's:
     *
     * 1. **A cluster left with fewer than two members is dropped entirely.** A
     *    "duplicate" with one member is a photograph.
     * 2. **Biggest cluster first, ties broken by the cluster id**, so the order
     *    is TOTAL. v0 sorted by length alone (`DuplicatesShelf.tsx` via
     *    `duplicate-clusters.ts`), which is not stable across engines — and the
     *    card order is what a member's eye follows down the shelf.
     *
     * And one that is this screen's alone: when [pageFilled] the LAST group is
     * discarded. Its remaining members are on a page nobody will read, so its
     * count would be a floor presented as a count, and a two-member cluster cut
     * after its first member would be silently dropped as a photograph. A
     * cluster that is not shown cannot be resolved wrongly; a cluster shown
     * with the wrong members can.
     *
     * `member_count` is otherwise EXACT, because every member of every kept
     * group is on this page by construction.
     */
    internal fun foldClusters(rows: List<Row>, pageFilled: Boolean): List<DuplicateCluster> {
        val groups = mutableListOf<Pair<String, MutableList<String>>>()
        rows.forEach { row ->
            val clusterId = row.text(CLUSTER_ID)
            val assetId = row.text(ASSET_ID)
            if (clusterId.isEmpty() || assetId.isEmpty()) return@forEach
            val last = groups.lastOrNull()
            if (last != null && last.first == clusterId) {
                last.second += assetId
            } else {
                groups += clusterId to mutableListOf(assetId)
            }
        }
        if (pageFilled && groups.isNotEmpty()) groups.removeAt(groups.lastIndex)
        return groups
            .filter { (_, members) -> members.size >= 2 }
            .map { (clusterId, members) ->
                DuplicateCluster(
                    cluster_id = clusterId,
                    member_count = members.size,
                    // THE KEY THE SECOND LEG HANGS ON, and the whole reason the
                    // shelf can draw a cover at all. `cluster_id` lives only on
                    // `media_asset_phash`, which has no `content_id`, so
                    // everything else a card wants is on another table and a
                    // leg needs something to bind. In `asset_id ASC` order,
                    // which is the statement's own — so two devices folding the
                    // same vault pick the same cover.
                    member_asset_ids = members,
                    // FALSE, BECAUSE THE CAP IS AVOIDED RATHER THAN REPORTED.
                    //
                    // The contract's default assumption is that a count off a
                    // full page is a floor. It is — for the group the page
                    // edge cut, and for that group ONLY, because the rows
                    // arrive in cluster order so every earlier group is whole.
                    // This fold drops that one group entirely (see above), so
                    // every cluster it emits was counted in full. Saying "at
                    // least 4 copies" about a cluster known to have exactly
                    // four would understate a fact this read actually holds,
                    // which is the same class of dishonesty as overstating.
                    member_count_capped = false,
                    // See the file header: unknown, and zero is what the views
                    // read as "say nothing about bytes".
                    reclaimable_bytes = 0L,
                    cover_thumbnail_path = null,
                )
            }
            // BY WHAT RESOLVING GIVES BACK, FIRST — the number that makes the
            // work worth doing, and the reason the contract names it the sort.
            // A member with eleven sets and one evening is looking for the two
            // copies of a 200 MB video, not for four small screenshots.
            //
            // **THE SECOND KEY IS NOT DECORATION.** `reclaimable_bytes` is zero
            // on every card this build produces — see the file header for the
            // hop that is still missing — so on its own this comparator would
            // collapse to the cluster id, which is a hash of nothing a member
            // can see. `member_count` descending is what the desktop's
            // `fold_clusters` sorts by and is a real proxy for "bigger job"
            // while the bytes are unknown; the cluster id is last so the order
            // is TOTAL. v0 sorted by length alone, which is not stable across
            // engines, and the card order is what a member's eye follows down
            // the shelf.
            .sortedWith(
                compareByDescending<DuplicateCluster> { it.reclaimable_bytes }
                    .thenByDescending { it.member_count }
                    .thenBy { it.cluster_id },
            )
    }

    /** The projection's order, as constants, so a moved column moves once. */
    private const val CLUSTER_ID: Int = 0
    private const val ASSET_ID: Int = 1

    /** Positional, as the door states. See `HomeReads.text` for why only TEXT. */
    private fun Row.text(index: Int): String = values.getOrNull(index)?.text ?: ""
}

/**
 * THE SHELF'S SECOND STATEMENT (#1029, photos port).
 *
 * `DuplicatesReads` folds `media_asset_phash` into cards. This reads
 * `media_asset` for the assets those cards named, so each card can draw a COVER
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
 * lives on `media_asset_phash` alone, so a statement over `media_asset` has none
 * to give and would have to invent one to be mistaken for the fold. The
 * lightbox's is the same shape — "a detail with no `asset_id` is an amendment".
 */
public class DuplicatesLeg internal constructor(
    public val leg: DuplicatesMachine.Leg,
) : ScreenReads<DuplicatesState, DuplicatesEvent> {
    override val screenId: String = DuplicatesMachine.readId(leg)

    override val table: String = when (leg) {
        DuplicatesMachine.Leg.ASSETS -> "media_asset"
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
            select = listOf("asset_id"),
            from = table,
            where_ = inList("asset_id", ids.size) + " AND deleted_at IS NULL",
            bind = ids.map { Value(text = it) },
            order = PageOrder(
                sort_column = "asset_id",
                pk_column = "asset_id",
                descending = false,
            ),
            // THE WHOLE POINT OF THE LEG. `media_asset` carries `content_id`,
            // so the door's correlated thumbnail subquery resolves here — which
            // is exactly what it cannot do over `media_asset_phash`, where it
            // would fail at PREPARE and take the fold read down with it.
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
