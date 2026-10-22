package dev.centraid.shared

import centraid.core.v1.AppQueryResponse
import centraid.core.v1.PhotosDuplicateCluster
import centraid.core.v1.PhotosDuplicates
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.DuplicatesData
import centraid.screen.v1.DuplicatesEvent
import dev.centraid.shared.apps.photos.DuplicatesLeg
import dev.centraid.shared.apps.photos.DuplicatesMachine
import dev.centraid.shared.apps.photos.DuplicatesReads
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.platform.DeviceClock
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

    /** The core's answer: one cluster per entry, its key the lowest member id. */
    fun answer(vararg clusters: Pair<String, List<String>>) = listOf(
        AppQueryResponse(
            photos_duplicates = PhotosDuplicates(
                clusters = clusters.map { (key, ids) ->
                    PhotosDuplicateCluster(key = key, photo_ids = ids)
                },
            ),
        ),
    )

    fun arrivedData(vararg clusters: Pair<String, List<String>>) =
        DuplicatesReads.arrived(answer(*clusters)).data_?.data_

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
                    data_ = arrivedData("a-1" to listOf("a-1", "a-2")),
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
        // standing in for a failure: on THIS screen it would read as "you have
        // no duplicates", which is the sentence the shelf is careful not to say.
        refused.state.data_.shouldBeNull()
        refused.state.failure.shouldNotBeNull().sentence shouldBe "This is not shared with you."
        // AND NO RE-READ. A retry is a wake, not a reducer's reflex.
        refused.effects.shouldBeEmpty()
    }

    "a parked feed emits no re-read" {
        val parked = DuplicatesMachine.reduce(
            DuplicatesMachine.initial(),
            DuplicatesEvent(refused = DuplicatesEvent.ReadRefused(Reads.lowDiskParked())),
        )
        parked.effects.shouldBeEmpty()
        Reads.isParked(parked.state.failure) shouldBe true
    }

    "this shelf has one page, so a next-page request does nothing at all" {
        // The core answers every cluster, so `arrived` never hands out a cursor
        // and no view can offer the control. If one somehow arrives, the honest
        // answer is nothing.
        val step = DuplicatesMachine.reduce(
            DuplicatesMachine.initial(),
            DuplicatesEvent(next_page = DuplicatesEvent.NextPageRequested(after_cursor = "x")),
        )
        step.effects.shouldBeEmpty()
    }

    "rowsChanged answers for the tables a cluster is made of and null for any other" {
        DuplicatesMachine.rowsChanged("media_asset", listOf("a-1")).shouldBeNull()
        DuplicatesMachine.rowsChanged("album", listOf("a-1")).shouldBeNull()
        DuplicatesMachine.TABLES shouldBe setOf("derivative", "photo", "entity")
        val mine = DuplicatesMachine.rowsChanged("derivative", listOf("a-1"))
            .shouldNotBeNull()
        mine.rows_changed.shouldNotBeNull().asset_ids shouldBe listOf("a-1")
        // The reduction is on the event's PRESENCE: one new fingerprint can
        // create a cluster, dissolve one, or move a photograph between two.
        DuplicatesMachine.reduce(DuplicatesMachine.initial(), mine).effects shouldBe listOf(
            ScreenEffect.ReadPage(DuplicatesMachine.SCREEN_ID, afterCursor = null),
        )
        // A trash is an `entity` change with an empty key list, and it re-reads
        // too: an empty key list means "re-read", never "nothing moved".
        DuplicatesMachine.rowsChanged("entity", emptyList()).shouldNotBeNull()
        DuplicatesMachine.rowsChanged("photo", emptyList()).shouldNotBeNull()
    }

    // --- The read ---------------------------------------------------------

    "the shelf asks the core one question, and the leg asks `photo` for the covers" {
        val requests = DuplicatesReads.requests(
            DuplicatesMachine.initial(),
            DeviceClock.Reading(zone = "Europe/Lisbon", epochMillis = 0L),
        )
        requests.single().photos_duplicates.shouldNotBeNull()

        val leg = DuplicatesLeg(DuplicatesMachine.Leg.ASSETS)
        // No cards, no read: an unbound `IN ()` would read the whole library to
        // decorate a handful of cards.
        leg.query(DuplicatesMachine.initial(), null).shouldBeNull()
        val folded = DuplicatesMachine.reduce(
            DuplicatesMachine.initial(),
            DuplicatesEvent(
                data_ = DuplicatesEvent.DataArrived(
                    data_ = arrivedData("a-1" to listOf("a-1", "a-2")),
                ),
            ),
        ).state
        val query = leg.query(folded, null).shouldNotBeNull()
        query.from shouldBe "photo"
        // ONLY LIVE PHOTOGRAPHS ride a card: the cover is never one in the trash.
        withClue(query.where_) {
            query.where_.shouldNotBeNull().contains("entity WHERE deleted_at IS NULL") shouldBe true
        }
        val order = query.order.shouldNotBeNull()
        order.sort_column shouldBe "id"
        order.pk_column shouldBe "id"
        // `photo` carries a `blob`, so the door's thumbnail subquery resolves.
        query.with_held_thumbnail shouldBe true
    }

    "a cluster of one is a photograph, and the order is total" {
        val data = arrivedData(
            "a-1" to listOf("a-2", "a-1"),
            // A GROUP OF ONE: a "duplicate" with one member is a photograph.
            "b-1" to listOf("b-1"),
            "c-1" to listOf("c-1", "c-2", "c-3"),
        ).shouldNotBeNull()
        // BIGGEST FIRST, ties broken by the cluster id so the order is TOTAL.
        data.clusters.map { it.cluster_id } shouldBe listOf("c-1", "a-1")
        data.clusters.map { it.member_count } shouldBe listOf(3, 2)
        // AND EVERY CARD NAMES ITS MEMBERS, in id order: the key the cover leg
        // hangs on, and the reason two devices folding the same vault pick the
        // same cover.
        data.clusters.map { it.member_asset_ids } shouldBe listOf(
            listOf("c-1", "c-2", "c-3"),
            listOf("a-1", "a-2"),
        )
    }

    "the shelf is ordered by what resolving gives back, then by size of job" {
        val clusters = DuplicatesReads.foldClusters(
            listOf(
                PhotosDuplicateCluster(key = "a-1", photo_ids = listOf("a-1", "a-2")),
                PhotosDuplicateCluster(key = "b-1", photo_ids = listOf("b-1", "b-2", "b-3")),
            ),
        )
        clusters.map { it.cluster_id } shouldBe listOf("b-1", "a-1")
        clusters.map { it.reclaimable_bytes } shouldBe listOf(0L, 0L)
        // AND NO PHRASE, WHICH IS NOT "0 bytes". A size is the vault's to spell.
        clusters.map { it.reclaimable_phrase } shouldBe listOf("", "")
    }

    "the cover arrives as an amendment, and an amendment is not a fold" {
        val folded = DuplicatesMachine.reduce(
            DuplicatesMachine.initial(),
            DuplicatesEvent(
                data_ = DuplicatesEvent.DataArrived(
                    data_ = arrivedData("c-a" to listOf("a-1", "a-2")),
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
        // THE CLUSTER SURVIVED: an amendment amends and never replaces.
        amended.data_.shouldNotBeNull().clusters.single().cluster_id shouldBe "c-a"
        // AND THE COVER IS THE FIRST MEMBER IN THE FOLD'S ORDER, not the first
        // row the leg happened to return.
        amended.data_.clusters.single().cover_thumbnail_path shouldBe "/store/1.data"
    }

    "a leg with nothing to say sends no event, because an empty one is a fold" {
        val leg = DuplicatesLeg(DuplicatesMachine.Leg.ASSETS)
        leg.arrived(emptyList(), nextCursor = null) shouldBe DuplicatesEvent()
        leg.refused(Reads.refused("no")) shouldBe DuplicatesEvent()
        val folded = DuplicatesMachine.reduce(
            DuplicatesMachine.initial(),
            DuplicatesEvent(
                data_ = DuplicatesEvent.DataArrived(
                    data_ = arrivedData("c-a" to listOf("a-1", "a-2")),
                ),
            ),
        ).state
        val after = DuplicatesMachine.reduce(folded, DuplicatesEvent())
        after.state shouldBe folded
        after.effects.shouldBeEmpty()
    }

    "an empty fold still replaces, and asks for no covers" {
        val step = DuplicatesMachine.reduce(
            DuplicatesMachine.initial(),
            DuplicatesEvent(
                data_ = DuplicatesEvent.DataArrived(data_ = arrivedData()),
            ),
        )
        step.state.data_.shouldNotBeNull().clusters.shouldBeEmpty()
        step.state.loading.shouldBeNull()
        step.effects.shouldBeEmpty()
    }

    "the shelf says nothing it cannot stand behind" {
        val data = arrivedData("c-a" to listOf("a-1", "a-2")).shouldNotBeNull()
        // NEVER A CURSOR: the core answers the whole shelf.
        data.next_cursor.shouldBeNull()
        // ZERO BECAUSE IT IS UNKNOWN, and marked a floor: "at least 0" cannot
        // overstate where an exact zero would.
        data.total_reclaimable_bytes shouldBe 0L
        data.clusters.single().reclaimable_bytes shouldBe 0L
        data.clusters.single().cover_thumbnail_path.shouldBeNull()
        data.total_capped shouldBe true
        // The core answers every member of every cluster, so the count is exact.
        data.clusters.single().member_count_capped shouldBe false
        // FALSE, ALWAYS, AND ON PURPOSE: never tell a member their library is
        // clean on the strength of a read that cannot know.
        data.scan_complete shouldBe false
    }

    "an empty shelf is data with no clusters, never a refusal" {
        val arrived = DuplicatesReads.arrived(answer())
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
            "Not on this phone yet."
    }
})
