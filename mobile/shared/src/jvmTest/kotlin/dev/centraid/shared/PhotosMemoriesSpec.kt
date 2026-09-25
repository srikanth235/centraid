package dev.centraid.shared

import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.MemoryRow
import centraid.screen.v1.MemoryStop
import centraid.screen.v1.PhotosMemoriesData
import centraid.screen.v1.PhotosMemoriesEvent
import dev.centraid.shared.apps.photos.PhotosMemoriesMachine
import dev.centraid.shared.apps.photos.PhotosMemoriesReads
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe

/**
 * MEMORIES, AS A STATE MACHINE AND A PROJECTION (#1029, photos port).
 *
 * `media_memory` is EMPTY in `contracts/apps/photos/rows.json` and nothing in
 * `crates/` writes it (`docs/photos/derived-ledger.md`), so the shape of the
 * empty answer is the most load-bearing thing on this screen — and it is what
 * most of this file is about.
 */
class PhotosMemoriesSpec : StringSpec({

    /** A `media_memory` row as `PhotosMemoriesReads.query` projects it. */
    fun memoryRow(
        memoryId: String,
        kind: String,
        titleHint: String = "",
        dayKey: String = "",
        startedAt: String = "",
        endedAt: String = "",
        computedAt: String = "2026-02-03T00:00:00Z",
    ) = Row(
        values = listOf(
            Value(text = memoryId),
            Value(text = kind),
            Value(text = titleHint),
            Value(text = dayKey),
            Value(text = startedAt),
            Value(text = endedAt),
            Value(text = computedAt),
        ),
    )

    "the first open reads the shelf" {
        val opened = PhotosMemoriesMachine.reduce(
            PhotosMemoriesMachine.initial(),
            PhotosMemoriesEvent(opened = PhotosMemoriesEvent.Opened()),
        )
        opened.effects shouldBe listOf(
            ScreenEffect.ReadPage(PhotosMemoriesMachine.SCREEN_ID, afterCursor = null),
        )
        opened.state.loading.shouldNotBeNull().first_load.shouldBeTrue()
    }

    "a refused read clears the memories and is NOT an empty shelf" {
        val loaded = PhotosMemoriesMachine.reduce(
            PhotosMemoriesMachine.initial(),
            PhotosMemoriesEvent(
                data_ = PhotosMemoriesEvent.DataArrived(
                    PhotosMemoriesData(
                        memories = listOf(MemoryRow(memory_id = "otd:02-03")),
                        computed = true,
                    ),
                ),
            ),
        ).state
        val refused = PhotosMemoriesMachine.reduce(
            loaded,
            PhotosMemoriesEvent(
                refused = PhotosMemoriesEvent.ReadRefused(
                    Reads.refused("This is not shared with you."),
                ),
            ),
        )
        refused.state.data_.shouldBeNull()
        refused.state.failure.shouldNotBeNull().sentence shouldBe "This is not shared with you."
        // AND NO RE-READ. A retry is a wake, not a reducer's reflex.
        refused.effects.shouldBeEmpty()
    }

    "an empty shelf with `computed` false is 'not yet', never 'there are none'" {
        // THE CONSERVATIVE READING, AND THE ONLY ONE THIS DOOR SUPPORTS.
        // `media_memory.computed_at` is NOT NULL, so rows prove a pass ran and
        // NO rows prove nothing at all; nothing else on the vault records a
        // run. Claiming "there are none" would assert a pass ran when no
        // command in `crates/` writes the projection.
        val empty = PhotosMemoriesReads.arrived(emptyList(), nextCursor = null)
        val data = empty.data_.shouldNotBeNull().data_.shouldNotBeNull()
        data.memories.shouldBeEmpty()
        data.computed.shouldBeFalse()
        // An empty page is still DATA and never a refusal.
        empty.refused.shouldBeNull()

        val answered = PhotosMemoriesReads.arrived(
            listOf(memoryRow("otd:02-03", "on-this-day", dayKey = "02-03")),
            nextCursor = null,
        ).data_.shouldNotBeNull().data_.shouldNotBeNull()
        answered.computed.shouldBeTrue()
    }

    "a later page appends, and a page that ends the walk does not un-compute the shelf" {
        val first = PhotosMemoriesData(
            memories = listOf(MemoryRow(memory_id = "m1")),
            next_cursor = "c",
            computed = true,
        )
        // THE END OF THE WALK IS NOT A NEW CLAIM. An empty last page with
        // `computed` false would otherwise flip a settled answer back to "not
        // yet" and draw the wrong empty state over rows that are on screen.
        val merged = PhotosMemoriesMachine.merge(
            first,
            PhotosMemoriesData(memories = emptyList(), computed = false),
        ).shouldNotBeNull()
        merged.computed.shouldBeTrue()
        merged.memories.map { it.memory_id } shouldBe listOf("m1")

        // AND AN OVERLAPPING PAGE DOES NOT DUPLICATE. A keyset walk can
        // overlap when rows are rewritten under it, and the projection is
        // dropped and rebuilt wholesale.
        val overlapped = PhotosMemoriesMachine.merge(
            first,
            PhotosMemoriesData(
                memories = listOf(MemoryRow(memory_id = "m1"), MemoryRow(memory_id = "m2")),
                computed = true,
            ),
        ).shouldNotBeNull()
        overlapped.memories.map { it.memory_id } shouldBe listOf("m1", "m2")
    }

    "a parked feed emits no re-read when rows move" {
        val parked = PhotosMemoriesMachine.reduce(
            PhotosMemoriesMachine.initial(),
            PhotosMemoriesEvent(refused = PhotosMemoriesEvent.ReadRefused(Reads.lowDiskParked())),
        ).state
        PhotosMemoriesMachine.reduce(
            parked,
            PhotosMemoriesEvent(
                rows_changed = PhotosMemoriesEvent.RowsChanged(memory_ids = listOf("m1")),
            ),
        ).effects.shouldBeEmpty()

        PhotosMemoriesMachine.reduce(
            PhotosMemoriesMachine.initial(),
            PhotosMemoriesEvent(
                rows_changed = PhotosMemoriesEvent.RowsChanged(memory_ids = listOf("m1")),
            ),
        ).effects shouldBe listOf(
            ScreenEffect.ReadPage(PhotosMemoriesMachine.SCREEN_ID, afterCursor = null),
        )
    }

    "a change on a table this screen does not read answers null" {
        PhotosMemoriesMachine.rowsChanged("media_memory", listOf("m1")).shouldNotBeNull()
        PhotosMemoriesMachine.rowsChanged("media_memory_member", listOf("m1")).shouldBeNull()
        PhotosMemoriesMachine.rowsChanged("media_asset", listOf("a1")).shouldBeNull()
    }

    "the shelf reads the table its machine says it re-reads on, and both order columns" {
        val query = PhotosMemoriesReads.query(PhotosMemoriesMachine.initial(), null)
        query.from shouldBe PhotosMemoriesReads.table
        PhotosMemoriesMachine.rowsChanged(PhotosMemoriesReads.table, listOf("k")).shouldNotBeNull()
        // `photos.library.memories` in `queries.rs`: `computed_at DESC,
        // memory_id DESC`. `computed_at` is NOT NULL, so this walk is a real
        // walk — unlike the library's over `captured_at`.
        val order = query.order.shouldNotBeNull()
        order.sort_column shouldBe "computed_at"
        order.pk_column shouldBe "memory_id"
        order.descending.shouldBeTrue()
        query.select.contains(order.sort_column).shouldBeTrue()
        query.select.contains(order.pk_column).shouldBeTrue()
        // A PREDICATE HERE WOULD FILTER ON A COLUMN THAT DOES NOT EXIST:
        // `media_memory` has no `deleted_at`, because the pass drops and
        // rebuilds the projection.
        query.where_.shouldBeNull()
    }

    "the three kinds are read off the column, spelled as the CHECK spells them" {
        // Read off `kind` and not guessed from the deterministic id prefixes
        // (`otd:`, `trip:`, `similar:`): the column is the constraint, the id
        // is a convention of whatever wrote it.
        mapOf(
            "on-this-day" to MemoryRow.Kind.KIND_ON_THIS_DAY,
            "trip" to MemoryRow.Kind.KIND_TRIP,
            "similar" to MemoryRow.Kind.KIND_SIMILAR,
            // A FOURTH KIND FROM A NEWER VAULT IS NOT A TRIP.
            "slideshow" to MemoryRow.Kind.KIND_UNSPECIFIED,
            "onThisDay" to MemoryRow.Kind.KIND_UNSPECIFIED,
        ).forEach { (column, kind) ->
            withClue(column) {
                PhotosMemoriesReads.arrived(listOf(memoryRow("m", column)), null)
                    .data_.shouldNotBeNull().data_.shouldNotBeNull()
                    .memories.single().kind shouldBe kind
            }
        }
    }

    "`day_key` is passed through, never parsed, and never padded into a year" {
        // Its shape differs by kind. The DDL's CHECK admits one only on an
        // on-this-day row and the column holds `MM-DD` there, because the
        // memory IS the same date in other years and a year in the key would
        // defeat it. A view takes its dates from `started_at`/`ended_at`.
        val row = PhotosMemoriesReads.arrived(
            listOf(memoryRow("otd:02-03", "on-this-day", dayKey = "02-03")),
            null,
        ).data_.shouldNotBeNull().data_.shouldNotBeNull().memories.single()
        row.day_key shouldBe "02-03"
    }

    "what the shelf read cannot join is absent, never invented" {
        // `place_name`, `member_count` and `cover_thumbnail_path` live on
        // `core_place`, `media_memory_member` and `media_asset`, and the door
        // has no join clause. Absent rather than guessed, which is what keeps a
        // zero from being read as "this memory has no photographs". A TRIP'S
        // place name is folded on afterwards by the bridge's route legs
        // (`PhotosMemoriesReads.withRoutes`, below) — never by this read.
        val row = PhotosMemoriesReads.arrived(
            listOf(memoryRow("trip:2026-06-03", "trip")),
            null,
        ).data_.shouldNotBeNull().data_.shouldNotBeNull().memories.single()
        row.place_name shouldBe ""
        row.member_count shouldBe 0
        row.cover_thumbnail_path.shouldBeNull()
    }

    "a title the pass wrote wins; otherwise one is composed and never stored" {
        PhotosMemoriesMachine.titleOf(
            MemoryRow(kind = MemoryRow.Kind.KIND_TRIP, title_hint = "  Lisbon  "),
        ) shouldBe "Lisbon"
        PhotosMemoriesMachine.titleOf(
            MemoryRow(kind = MemoryRow.Kind.KIND_ON_THIS_DAY),
        ) shouldBe PhotosMemoriesMachine.ON_THIS_DAY
        PhotosMemoriesMachine.titleOf(
            MemoryRow(kind = MemoryRow.Kind.KIND_TRIP, place_name = "Truckee"),
        ) shouldBe "Truckee"
        // The trip fallback is `MemoriesView`'s own, and it is reached more
        // often here because `place_name` is a `core_place` fact this screen
        // cannot read — which is better than printing a place id as a place.
        PhotosMemoriesMachine.titleOf(
            MemoryRow(kind = MemoryRow.Kind.KIND_TRIP),
        ) shouldBe PhotosMemoriesMachine.AWAY_FROM_HOME
        PhotosMemoriesMachine.titleOf(
            MemoryRow(kind = MemoryRow.Kind.KIND_SIMILAR, member_count = 4),
        ) shouldBe "4 similar photographs"
        PhotosMemoriesMachine.titleOf(
            MemoryRow(kind = MemoryRow.Kind.KIND_SIMILAR),
        ) shouldBe PhotosMemoriesMachine.SIMILAR
        // A KIND THIS BUILD DOES NOT KNOW IS STILL A MEMORY, with a name and a
        // tap, rather than a card that quietly disappears.
        PhotosMemoriesMachine.titleOf(
            MemoryRow(kind = MemoryRow.Kind.KIND_UNSPECIFIED),
        ) shouldBe PhotosMemoriesMachine.UNKNOWN_KIND
    }

    "a partial range is not printed" {
        // One date where a member expects two reads as a trip that ended the
        // day it started.
        PhotosMemoriesMachine.dayRangeOf(
            MemoryRow(started_at = "2026-06-03T09:00:00Z", ended_at = ""),
        ) shouldBe ""
        PhotosMemoriesMachine.dayRangeOf(
            MemoryRow(started_at = "", ended_at = "2026-06-09T09:00:00Z"),
        ) shouldBe ""
        PhotosMemoriesMachine.dayRangeOf(
            MemoryRow(started_at = "2026-06-03T09:00:00Z", ended_at = "2026-06-09T21:00:00Z"),
        ) shouldBe "2026-06-03 – 2026-06-09"
        PhotosMemoriesMachine.dayRangeOf(
            MemoryRow(started_at = "2026-06-03T09:00:00Z", ended_at = "2026-06-03T21:00:00Z"),
        ) shouldBe "2026-06-03"
    }

    "a tap carries the memory and the title it composed" {
        val shelf = PhotosMemoriesMachine.shelfFor(
            MemoryRow(memory_id = "trip:2026-06-03", kind = MemoryRow.Kind.KIND_TRIP),
        )
        val memory = shelf.memory.shouldNotBeNull()
        memory.memory_id shouldBe "trip:2026-06-03"
        // NAMES RIDE ALONG, so the shelf's head has something to say before its
        // first page returns.
        memory.title shouldBe PhotosMemoriesMachine.AWAY_FROM_HOME
        shelf.place.shouldBeNull()
    }

    "a trip's route and name are its members' places, folded after the shelf" {
        // THE BRIDGE SERVES ITS OWN READS (`PhotosMemoriesBridge`): the shelf,
        // then three legs — members, where each was taken, those places' pins —
        // each built from the one before, and folded here into ONE page.
        val data = PhotosMemoriesData(
            memories = listOf(
                MemoryRow(memory_id = "trip:2026-06-03", kind = MemoryRow.Kind.KIND_TRIP),
                MemoryRow(memory_id = "otd:02-03", kind = MemoryRow.Kind.KIND_ON_THIS_DAY),
            ),
            computed = true,
        )
        // ONLY TRIPS HAVE ROUTES, so only trips are asked about.
        PhotosMemoriesReads.tripIds(data) shouldBe listOf("trip:2026-06-03")
        PhotosMemoriesReads.membersQuery(emptyList()).shouldBeNull()

        fun member(assetId: String, ordinal: Long) = Row(
            values = listOf(Value(text = "trip:2026-06-03"), Value(text = assetId), Value(integer = ordinal)),
        )
        fun taken(assetId: String, placeId: String) = Row(
            values = listOf(Value(text = assetId), Value(text = "2026-06-03T09:00:00Z"), Value(text = placeId)),
        )
        fun place(placeId: String, name: String, latitude: Double, longitude: Double) = Row(
            values = listOf(
                Value(text = placeId),
                Value(text = name),
                Value(real = latitude),
                Value(real = longitude),
            ),
        )
        val members = listOf(member("a-1", 0), member("a-2", 1), member("a-3", 2))
        val assets = listOf(taken("a-1", "p-lis"), taken("a-2", "p-lis"), taken("a-3", "p-opo"))
        PhotosMemoriesReads.memberAssetIds(members) shouldBe listOf("a-1", "a-2", "a-3")
        PhotosMemoriesReads.memberPlaceIds(assets) shouldBe listOf("p-lis", "p-opo")

        val folded = PhotosMemoriesReads.withRoutes(
            data,
            members,
            assets,
            listOf(place("p-lis", "Lisbon", 38.72, -9.14), place("p-opo", "Porto", 41.15, -8.61)),
        )
        val trip = folded.memories.first()
        // A REPEAT OF THE STOP BEFORE IS ONE STOP, in the trip's own order.
        trip.route shouldBe listOf(
            MemoryStop(place_id = "p-lis", latitude = 38.72, longitude = -9.14),
            MemoryStop(place_id = "p-opo", latitude = 41.15, longitude = -8.61),
        )
        // NAMED FOR WHERE MOST OF IT WAS TAKEN, which is what [titleOf] prints.
        trip.place_name shouldBe "Lisbon"
        PhotosMemoriesMachine.titleOf(trip) shouldBe "Lisbon"
        // Not a trip, not touched.
        folded.memories[1] shouldBe data.memories[1]
    }
})
