package dev.centraid.shared

import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.DuplicatesData
import centraid.screen.v1.DuplicatesEvent
import dev.centraid.shared.apps.photos.DuplicatesLeg
import dev.centraid.shared.apps.photos.DuplicatesMachine
import dev.centraid.shared.apps.photos.DuplicatesReads
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe

/**
 * The duplicates SHELF, as a state machine and a projection
 * (#1029, photos port).
 *
 * Everything here runs on the JVM with no ABI, because everything here is the
 * part of a screen that is DATA: `(state, event) -> (state, effects)`, the
 * statement, and the fold off a `Row`. What needs a real vault — that the door
 * answers this statement at all — is the device contract's job.
 */
class DuplicatesSpec : StringSpec({

    /** One `media_asset_phash` row, as the statement projects it. */
    fun row(clusterId: String, assetId: String) = Row(
        values = listOf(Value(text = clusterId), Value(text = assetId)),
    )

    // --- The machine ------------------------------------------------------

    "the first Opened asks for the fold" {
        val step = DuplicatesMachine.reduce(
            DuplicatesMachine.initial(),
            DuplicatesEvent(opened = DuplicatesEvent.Opened()),
        )
        step.state.loading.shouldNotBeNull().first_load shouldBe true
        step.effects shouldBe listOf(
            ScreenEffect.ReadPage(DuplicatesMachine.SCREEN_ID, afterCursor = null),
        )
    }

    "a refused read clears the clusters and is NOT an empty shelf" {
        val loaded = DuplicatesMachine.reduce(
            DuplicatesMachine.initial(),
            DuplicatesEvent(
                data_ = DuplicatesEvent.DataArrived(
                    data_ = DuplicatesReads.arrived(
                        listOf(row("c-1", "a-1"), row("c-1", "a-2")),
                        nextCursor = null,
                    ).data_?.data_,
                ),
            ),
        ).state
        loaded.data_.shouldNotBeNull().clusters.size shouldBe 1

        val refused = DuplicatesMachine.reduce(
            loaded,
            DuplicatesEvent(
                refused = DuplicatesEvent.ReadRefused(
                    Reads.refused("This is not shared with you."),
                ),
            ),
        )
        // THE FOURTH STATE THE READ LAW FORBIDS would be an empty data case
        // standing in for a failure — and on THIS screen it would read as "you
        // have no duplicates", which is the sentence the whole shelf is
        // careful not to say.
        refused.state.data_.shouldBeNull()
        refused.state.failure.shouldNotBeNull().sentence shouldBe "This is not shared with you."
        // AND NO RE-READ. A retry is a wake, not a reducer's reflex.
        refused.effects.shouldBeEmpty()
    }

    "a parked feed emits no re-read" {
        // The pinned regression: a retry loop over a failing batch. Out of disk
        // PARKS — the cursor and the rows stay and the cadence stops — so a
        // reducer that asked again here would re-apply the failing read every
        // second while the device had no space to answer it.
        val parked = DuplicatesMachine.reduce(
            DuplicatesMachine.initial(),
            DuplicatesEvent(refused = DuplicatesEvent.ReadRefused(Reads.lowDiskParked())),
        )
        parked.effects.shouldBeEmpty()
        Reads.isParked(parked.state.failure) shouldBe true
    }

    "this shelf has one page, so a next-page request does nothing at all" {
        // `cluster_id` is nullable and the door refuses a CONTINUED page over a
        // nullable sort key, so `arrived` never hands out a cursor and no view
        // can offer the control. If one somehow arrives, the honest answer is
        // nothing — a `ReadPage` with a cursor would come back as a refusal
        // painted over a shelf the member was reading.
        val step = DuplicatesMachine.reduce(
            DuplicatesMachine.initial(),
            DuplicatesEvent(next_page = DuplicatesEvent.NextPageRequested(after_cursor = "x")),
        )
        step.effects.shouldBeEmpty()
    }

    "rowsChanged answers for its own table and null for any other" {
        DuplicatesMachine.rowsChanged("media_asset", listOf("a-1")).shouldBeNull()
        val mine = DuplicatesMachine.rowsChanged("media_asset_phash", listOf("a-1"))
            .shouldNotBeNull()
        // THE KEYS RIDE ALONG NOW THAT THE FIELD IS NAMED FOR THEM. The change
        // stream reports a table's PRIMARY KEY and this table's is `asset_id`;
        // the event said `cluster_ids`, which no producer could fill, so this
        // emitted an empty list rather than lie in a field name.
        mine.rows_changed.shouldNotBeNull().asset_ids shouldBe listOf("a-1")
        // And the reduction is on the event's PRESENCE: one new fingerprint can
        // create a cluster, dissolve one, or move an asset between two, so
        // re-reading the fold is not a shortcut — it is the only correct answer.
        DuplicatesMachine.reduce(DuplicatesMachine.initial(), mine).effects shouldBe listOf(
            ScreenEffect.ReadPage(DuplicatesMachine.SCREEN_ID, afterCursor = null),
        )
    }

    // --- The read ---------------------------------------------------------

    "the statement is the desktop's, and its select carries both order columns" {
        val query = DuplicatesReads.query(DuplicatesMachine.initial(), null)
        query.from shouldBe DuplicatesReads.table
        query.from shouldBe "media_asset_phash"
        query.where_ shouldBe "cluster_id IS NOT NULL"
        val order = query.order.shouldNotBeNull()
        order.sort_column shouldBe "cluster_id"
        order.pk_column shouldBe "asset_id"
        order.descending shouldBe false
        // THE DOOR HAS NO `key_of` CALLBACK, so the cursor is read off the row
        // by the two columns the ORDER BY names.
        withClue(query.select) {
            query.select.contains(order.sort_column) shouldBe true
            query.select.contains(order.pk_column) shouldBe true
        }
        // AND NO THUMBNAIL COLUMN. `with_held_thumbnail` is a correlated
        // subquery on `{from}.content_id`, resolved at PREPARE —
        // `media_asset_phash` has no such column, so setting it would fail the
        // WHOLE read rather than answering nulls, and the member would read a
        // refusal over a shelf that is otherwise fine.
        query.with_held_thumbnail shouldBe false
    }

    "a cluster of one is a photograph, and the order is total" {
        val data = DuplicatesReads.arrived(
            listOf(
                row("c-a", "a-1"),
                row("c-a", "a-2"),
                // A GROUP OF ONE. The sweep's cluster lost members to the trash
                // since it ran; a "duplicate" with one member is a photograph.
                row("c-b", "b-1"),
                row("c-c", "c-1"),
                row("c-c", "c-2"),
                row("c-c", "c-3"),
            ),
            nextCursor = null,
        ).data_.shouldNotBeNull().data_.shouldNotBeNull()
        // BIGGEST FIRST, ties broken by the cluster id so the order is TOTAL.
        // v0 sorted by length alone, which is not stable across engines — and
        // the card order is what a member's eye follows down the shelf.
        data.clusters.map { it.cluster_id } shouldBe listOf("c-c", "c-a")
        data.clusters.map { it.member_count } shouldBe listOf(3, 2)
        // AND EVERY CARD NAMES ITS MEMBERS, in `asset_id` order — the key the
        // cover leg hangs on, and the reason two devices folding the same vault
        // pick the same cover.
        data.clusters.map { it.member_asset_ids } shouldBe listOf(
            listOf("c-1", "c-2", "c-3"),
            listOf("a-1", "a-2"),
        )
    }

    "the shelf is ordered by what resolving gives back, then by size of job" {
        // `reclaimable_bytes` FIRST, because that is the number that makes the
        // work worth doing. It is zero on every card this build produces — see
        // `DuplicatesReads` for the hop that is missing — so the second key is
        // what a member actually sees: without it the comparator would collapse
        // to the cluster id, which is a hash of nothing.
        val clusters = DuplicatesReads.foldClusters(
            listOf(
                row("c-a", "a-1"),
                row("c-a", "a-2"),
                row("c-b", "b-1"),
                row("c-b", "b-2"),
                row("c-b", "b-3"),
            ),
            pageFilled = false,
        )
        clusters.map { it.cluster_id } shouldBe listOf("c-b", "c-a")
        clusters.map { it.reclaimable_bytes } shouldBe listOf(0L, 0L)
        // AND NO PHRASE, WHICH IS NOT "0 bytes". A size is the vault's to
        // spell; nothing serves that function to a shell, so the views draw no
        // bytes line at all rather than one nobody chose the words for.
        clusters.map { it.reclaimable_phrase } shouldBe listOf("", "")
    }

    "the cover arrives as an amendment, and an amendment is not a fold" {
        // The leg reads `media_asset`, where nothing knows what
        // `media_asset_phash.cluster_id` groups by — so it has no cluster id to
        // give, and that unfillable absence is the discriminator. The same
        // shape `PhotoLightboxMachine` uses, and chosen for the same reason:
        // the producer cannot avoid it, so two files cannot drift apart on it.
        val folded = DuplicatesMachine.reduce(
            DuplicatesMachine.initial(),
            DuplicatesEvent(
                data_ = DuplicatesEvent.DataArrived(
                    data_ = DuplicatesReads.arrived(
                        listOf(row("c-a", "a-1"), row("c-a", "a-2")),
                        nextCursor = null,
                    ).data_?.data_,
                ),
            ),
        )
        // THE FOLD ASKS FOR THE COVERS. There are member ids to key on.
        folded.effects shouldBe listOf(
            ScreenEffect.ReadPage(
                DuplicatesMachine.readId(DuplicatesMachine.Leg.ASSETS),
                afterCursor = null,
            ),
        )
        val amended = DuplicatesMachine.reduce(
            folded.state,
            DuplicatesLeg(DuplicatesMachine.Leg.ASSETS).arrived(
                listOf(
                    Row(values = listOf(Value(text = "a-2"), Value(text = "/store/2.data"))),
                    Row(values = listOf(Value(text = "a-1"), Value(text = "/store/1.data"))),
                ),
                nextCursor = null,
            ),
        ).state
        // THE CLUSTER SURVIVED — an amendment amends and never replaces.
        amended.data_.shouldNotBeNull().clusters.single().cluster_id shouldBe "c-a"
        // AND THE COVER IS THE FIRST MEMBER IN THE FOLD'S ORDER, not the first
        // row the leg happened to return: a card that changed picture between
        // two reads of an unchanged library is a card a member cannot trust.
        amended.data_!!.clusters.single().cover_thumbnail_path shouldBe "/store/1.data"
    }

    "a leg with nothing to say sends no event, because an empty one is a fold" {
        // A `DataArrived` carrying no clusters is EXACTLY what an empty fold
        // looks like, so a leg that sent one would blank a shelf the member is
        // reading whenever no member of any cluster had bytes on this device.
        val leg = DuplicatesLeg(DuplicatesMachine.Leg.ASSETS)
        leg.arrived(emptyList(), nextCursor = null) shouldBe DuplicatesEvent()
        leg.refused(Reads.refused("no")) shouldBe DuplicatesEvent()
        // And the machine reduces an armless event to nothing at all.
        val folded = DuplicatesMachine.reduce(
            DuplicatesMachine.initial(),
            DuplicatesEvent(
                data_ = DuplicatesEvent.DataArrived(
                    data_ = DuplicatesReads.arrived(
                        listOf(row("c-a", "a-1"), row("c-a", "a-2")),
                        nextCursor = null,
                    ).data_?.data_,
                ),
            ),
        ).state
        val after = DuplicatesMachine.reduce(folded, DuplicatesEvent())
        after.state shouldBe folded
        after.effects.shouldBeEmpty()
    }

    "an empty fold still replaces, and asks for no covers" {
        // The other side of the same discriminator: no clusters is a real
        // answer from the FOLD — a vault with no duplicates — and it must
        // reach the screen as data rather than be mistaken for an amendment.
        val step = DuplicatesMachine.reduce(
            DuplicatesMachine.initial(),
            DuplicatesEvent(
                data_ = DuplicatesEvent.DataArrived(
                    data_ = DuplicatesReads.arrived(emptyList(), nextCursor = null).data_?.data_,
                ),
            ),
        )
        step.state.data_.shouldNotBeNull().clusters.shouldBeEmpty()
        step.state.loading.shouldBeNull()
        step.effects.shouldBeEmpty()
    }

    "a page that filled drops its last group rather than reporting it short" {
        // Rows arrive in cluster order, so a full page cuts the final group.
        // Reporting its count would be a floor presented as a count — and a
        // two-member cluster cut after its first member would be dropped
        // silently as "a photograph". A cluster that is not shown cannot be
        // resolved wrongly; a cluster shown with the wrong members can.
        val data = DuplicatesReads.arrived(
            listOf(
                row("c-a", "a-1"),
                row("c-a", "a-2"),
                row("c-b", "b-1"),
                row("c-b", "b-2"),
            ),
            nextCursor = "c-b|b-2",
        ).data_.shouldNotBeNull().data_.shouldNotBeNull()
        data.clusters.map { it.cluster_id } shouldBe listOf("c-a")
    }

    "the shelf says nothing it cannot stand behind" {
        val data = DuplicatesReads.arrived(
            listOf(row("c-a", "a-1"), row("c-a", "a-2")),
            nextCursor = null,
        ).data_.shouldNotBeNull().data_.shouldNotBeNull()
        // NEVER A CURSOR: a continued page over `cluster_id` is refused by the
        // door, so handing one out would put a control on the screen whose only
        // outcome is a failure.
        data.next_cursor.shouldBeNull()
        // ZERO BECAUSE IT IS UNKNOWN. `core_content_item.byte_size` is a second
        // table and this door reads one; a plausible number here would be the
        // worst kind of wrong, because it is the figure the shelf exists to
        // justify the work by. The views draw nothing for zero.
        data.total_reclaimable_bytes shouldBe 0L
        data.clusters.single().reclaimable_bytes shouldBe 0L
        data.clusters.single().cover_thumbnail_path.shouldBeNull()
        // AND THE ZERO IS MARKED AS A FLOOR. Of the two readings only "at
        // least" is true of an unknown: `false` would assert an exact total of
        // zero, and a reader downstream would be entitled to print "0 bytes to
        // reclaim" over a shelf with clusters on it.
        data.total_capped shouldBe true
        // THE MEMBER COUNT IS THE OTHER WAY ROUND, and the two are consistent.
        // The fold AVOIDS the cap rather than reporting it — the one group a
        // full page can cut is dropped whole — so every cluster it emits was
        // counted in full, and "at least 2" here would understate a fact this
        // read actually holds.
        data.clusters.single().member_count_capped shouldBe false
        // FALSE, ALWAYS, AND ON PURPOSE. Nothing in the schema records whether
        // the phash pass has walked this library, so the conservative reading
        // is the only honest one: never tell a member their library is clean on
        // the strength of a read that cannot know.
        data.scan_complete shouldBe false
    }

    "an empty shelf is data with no clusters, never a refusal" {
        val arrived = DuplicatesReads.arrived(emptyList(), nextCursor = null)
        arrived.refused.shouldBeNull()
        arrived.data_.shouldNotBeNull().data_ shouldBe DuplicatesData(
            clusters = emptyList(),
            next_cursor = null,
            total_reclaimable_bytes = 0L,
            total_capped = true,
            scan_complete = false,
        )
    }

    "a refusal reaches the screen as this screen's own event" {
        val event = DuplicatesReads.refused(Reads.noCopyYet())
        event.data_.shouldBeNull()
        event.refused.shouldNotBeNull().failure.shouldNotBeNull().sentence shouldBe
            "This device has not copied these yet."
    }
})
