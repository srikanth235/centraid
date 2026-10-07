package dev.centraid.shared.apps.photos

import centraid.screen.v1.DuplicatesData
import centraid.screen.v1.DuplicatesEvent
import centraid.screen.v1.DuplicatesState
import centraid.screen.v1.Loading
import centraid.screen.v1.SeatState
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step

/**
 * The shelf of near-duplicate clusters (#1029, photos port).
 *
 * One card per `media_asset_phash.cluster_id`, and the card is a DECISION and
 * not a browse: the way in is `photos.duplicate`, where a member picks the copy
 * that survives. Nothing on this screen deletes anything, which is deliberate —
 * v0's shelf carried a selection bar with Trash on it
 * (`DuplicatesShelf.tsx:132-150`), so a member could bulk-trash copies from a
 * list that never told them which of the copies was the biggest, the sharpest
 * or the one already in an album. The verb lives on the screen that shows the
 * differences.
 *
 * ## What a cluster is, and who decided it
 *
 * `cluster_id` is a REBUILDABLE PROJECTION written wholesale by a sweep —
 * union-find over phash Hamming distance ≤ 6 with the group's lowest `asset_id`
 * as its id (`crates/media/src/duplicates.rs`, D-1020-P3). This screen reads it
 * and stops. It does not re-derive the clustering, for the reason that module's
 * own header gives: a second implementation would agree with the sweep until
 * the threshold moved and then disagree silently at exactly the boundary where
 * a member is deciding what to delete.
 *
 * ## One page, and it is not this screen's choice
 *
 * `cluster_id` is nullable, and the door REFUSES a continued page over a
 * nullable sort key (`KitError::NullableSortKey`, D-1020-P11): SQLite's
 * row-value comparison puts every NULL on one side of the keyset and the walk
 * silently drops them. So this shelf reads ONE page and never hands out a
 * cursor — see [DuplicatesReads] for what that costs and how it is reported
 * rather than hidden.
 */
public object DuplicatesMachine : ScreenMachine<DuplicatesState, DuplicatesEvent> {
    public const val SCREEN_ID: String = "photos.duplicates"

    /**
     * THE SECOND STATEMENT THIS SHELF MAKES (#1029, photos port).
     *
     * `ScreenReads` serves ONE statement per screen id and `arrived` is handed
     * rows with no note saying which statement produced them, so a screen that
     * reads two tables is two `ScreenReads` with two ids — `PhotoLightboxMachine`
     * has six of these for the same reason, and its note on why a phase field
     * would race applies here unchanged.
     *
     * There is one leg and not three, and the ceiling is stated rather than
     * discovered: `cluster_id` lives only on `media_asset_phash`, which has no
     * `content_id`, so the cover has to come from `media_asset` keyed on
     * `DuplicateCluster.member_asset_ids`. The BYTES are one hop further —
     * `core_content_item.byte_size`, reached through a content id this shelf
     * has nowhere to put — and that hop is named in this lane's report rather
     * than faked.
     */
    public enum class Leg {
        /** `media_asset`, for each cluster's [DuplicateCluster.cover_thumbnail_path]. */
        ASSETS,
    }

    /** The screen id a [Leg]'s `ReadPage` effect carries. */
    public fun readId(leg: Leg): String = SCREEN_ID + "/" + leg.name.lowercase()

    override fun initial(): DuplicatesState = DuplicatesState(
        loading = Loading(first_load = true),
    )

    override fun reduce(state: DuplicatesState, event: DuplicatesEvent): Step<DuplicatesState> =
        when {
            event.opened != null -> firstLoad(state)

            // THIS SHELF HAS EXACTLY ONE PAGE AND THEREFORE NO NEXT ONE.
            //
            // `DuplicatesReads` never fills `next_cursor`, so no view can
            // offer the control that would send this — and if one somehow
            // did, the honest answer is nothing rather than a read the door
            // would refuse. A `ReadPage` with a cursor over `cluster_id`
            // comes back as `KitError::NullableSortKey`, which would replace
            // a shelf the member is looking at with a failure they cannot act
            // on. The event stays on the contract because `screen.proto` is
            // the root's; what it MEANS here is "nothing to continue".
            event.next_page != null -> Step(state)

            // A PHASH ROW MOVED, SO THE WHOLE FOLD MOVED — AND THIS ONE DOES
            // NOT FILTER, THOUGH IT NOW COULD.
            //
            // `member_asset_ids` puts the shown assets on the state, so this
            // arm could ask "is that one of mine" the way the grid does. It
            // deliberately does not. A fingerprint the shelf has never seen is
            // exactly the row that CREATES a cluster, and one that moved can
            // dissolve a cluster or shift an asset between two — so an id that
            // matches nothing on screen is not evidence that nothing on screen
            // changed. Re-reading the fold is not a shortcut here; it is the
            // only correct reduction, and the one page it costs is the same
            // page the first load cost.
            event.rows_changed != null -> firstLoad(state)

            // TWO STATEMENTS ARRIVE THROUGH ONE ARM, AND THE DISCRIMINATOR IS
            // AN IDENTITY FIELD THE LEG GENUINELY CANNOT FILL.
            //
            // `DuplicatesEvent` has one `DataArrived`, so the fold and the
            // cover read both land here. **A cluster with an EMPTY
            // `cluster_id` is an AMENDMENT and never a cluster**: the leg reads
            // `media_asset`, a table on which nothing knows what
            // `media_asset_phash.cluster_id` groups by, so it has no cluster id
            // to give and would have to invent one to be mistaken for the fold.
            // That is the same shape `PhotoLightboxMachine` uses ("a detail
            // with no `asset_id` is an amendment") and it is chosen for the
            // same reason: the discriminator is an absence the producer cannot
            // avoid, not a convention two files have to keep agreeing about.
            event.data_ != null -> {
                val arriving = event.data_.data_
                when {
                    arriving == null -> Step(state)

                    // NOT `any`, and not `isEmpty` either. An arriving list
                    // with NO clusters is what an empty FOLD looks like — a
                    // vault with no duplicates — so it must take the replace
                    // branch, and `DuplicatesLeg` sends no event at all rather
                    // than an empty one for exactly that reason.
                    arriving.clusters.isNotEmpty() &&
                        arriving.clusters.all { it.cluster_id.isEmpty() } ->
                        amend(state, arriving)

                    else -> Step(
                        state.copy(loading = null, failure = null, data_ = arriving),
                        // ASK FOR THE COVERS ONLY WHEN THERE IS SOMETHING TO
                        // COVER. A leg over an empty `IN ()` list is a
                        // statement with no rows to find, and `DuplicatesLeg`
                        // answers null for it rather than sending one.
                        if (arriving.clusters.any { it.member_asset_ids.isNotEmpty() }) {
                            listOf(ScreenEffect.ReadPage(readId(Leg.ASSETS), afterCursor = null))
                        } else {
                            emptyList()
                        },
                    )
                }
            }

            // A FAILED READ IS NOT AN EMPTY SHELF (census §E seam 3). The
            // clusters go, the sentence arrives, and NO re-read is emitted: a
            // reducer that retried its own refusal is the 1 s loop the
            // low-disk park exists to stop.
            event.refused != null -> Step(
                state.copy(
                    loading = null,
                    data_ = null,
                    failure = event.refused.failure,
                ),
            )

            event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))

            else -> Step(state)
        }

    /**
     * Back to `loading`, and ASK.
     *
     * The clusters are dropped rather than held under the spinner, which is
     * `PhotosGridMachine.firstLoad`'s choice for the same reason: the fold is
     * ordered, a re-read can dissolve a cluster or merge two, and cards left on
     * the screen under a spinner would be a shelf that disagrees with the read
     * that is replacing it.
     */
    /**
     * THE COVERS, FOLDED ONTO THE CLUSTERS THEY BELONG TO.
     *
     * [DuplicatesLeg] returns one amendment per ASSET — a `DuplicateCluster`
     * with no cluster id, one entry in `member_asset_ids`, and that asset's
     * held thumbnail — because a read of `media_asset` knows assets and knows
     * nothing about clusters. The match back is `member_asset_ids`, which is
     * exactly why the field is on the wire.
     *
     * **The FIRST member that has a thumbnail wins, in the fold's own order.**
     * Not the largest and not the newest: `member_asset_ids` is ordered by
     * `asset_id` ascending, which is the order the desktop's `fold_clusters`
     * puts a card's members in, so two devices folding the same vault choose
     * the same cover. A cover picked by "whichever row the leg returned first"
     * would be a card that changes picture between two reads of an unchanged
     * library.
     *
     * An amendment that arrives with no fold on screen is DROPPED. It can only
     * happen when a refusal or a re-read replaced the data between the two
     * statements, and the cover of a cluster that is no longer shown belongs to
     * nothing.
     */
    private fun amend(state: DuplicatesState, amendment: DuplicatesData): Step<DuplicatesState> {
        val held = state.data_ ?: return Step(state)
        val paths: Map<String, String> = amendment.clusters
            .mapNotNull { row ->
                val assetId = row.member_asset_ids.firstOrNull() ?: return@mapNotNull null
                val path = row.cover_thumbnail_path?.takeIf { it.isNotEmpty() }
                    ?: return@mapNotNull null
                assetId to path
            }
            .toMap()
        if (paths.isEmpty()) return Step(state)
        return Step(
            state.copy(
                data_ = held.copy(
                    clusters = held.clusters.map { cluster ->
                        cluster.copy(
                            cover_thumbnail_path = cluster.cover_thumbnail_path
                                ?: cluster.member_asset_ids.firstNotNullOfOrNull { paths[it] },
                        )
                    },
                ),
            ),
        )
    }

    private fun firstLoad(state: DuplicatesState): Step<DuplicatesState> = Step(
        state.copy(
            loading = Loading(first_load = true),
            failure = null,
            data_ = null,
        ),
        listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)),
    )

    /**
     * `media_asset_phash` — the fingerprints and the cluster the sweep put them
     * in. Not `media_asset`: a photograph's title changing is not a change to
     * which photographs are near-identical, and a library that redrew this
     * shelf on every capture-time edit would re-fold five hundred fingerprints
     * to produce the same cards.
     *
     * **THE KEYS RIDE ALONG NOW THAT THE FIELD IS NAMED FOR THEM.** The event
     * said `cluster_ids`, which no producer could fill — the change stream
     * reports a table's PRIMARY KEY and `media_asset_phash`'s is `asset_id`
     * (`001_baseline.sql:1623`) — so this emitted an EMPTY list rather than put
     * asset ids in a field named for cluster ids, which would have been a shell
     * lying in a field name. The field is `asset_ids` and carries what the
     * stream actually said. [reduce] still re-reads on the event's presence
     * rather than on its contents, and says why.
     */
    override fun rowsChanged(table: String, keys: List<String>): DuplicatesEvent? = when (table) {
        TABLE -> DuplicatesEvent(rows_changed = DuplicatesEvent.RowsChanged(asset_ids = keys))
        else -> null
    }

    private const val TABLE: String = "media_asset_phash"

    override fun seatChanged(seat: SeatState): DuplicatesEvent =
        DuplicatesEvent(seat_changed = DuplicatesEvent.SeatChanged(seat = seat))
}
