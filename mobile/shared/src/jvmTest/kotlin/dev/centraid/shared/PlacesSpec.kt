package dev.centraid.shared

import centraid.core.v1.CommandStatus
import centraid.core.v1.NullValue
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.PlaceRow
import centraid.screen.v1.PlacesData
import centraid.screen.v1.PlacesEvent
import centraid.screen.v1.PlacesState
import dev.centraid.shared.apps.photos.PlacesAssetReads
import dev.centraid.shared.apps.photos.PlacesMachine
import dev.centraid.shared.apps.photos.PlacesReads
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
 * PLACES, AS A STATE MACHINE AND A PROJECTION (#1029, photos port).
 *
 * Every test here is `(state, event) -> (state, effects)` or `rows -> event`:
 * no dispatcher, no clock, no core. That is the whole reason a screen is pure —
 * it is what makes the screen provable on a machine with no device.
 */
class PlacesSpec : StringSpec({

    /** A `core_place` row as `PlacesReads.query` projects it. */
    fun placeRow(
        placeId: String,
        name: String,
        latitude: Double? = null,
        longitude: Double? = null,
        timeZone: String = "",
    ) = Row(
        values = listOf(
            Value(text = placeId),
            Value(text = name),
            latitude?.let { Value(real = it) } ?: Value(null_ = NullValue()),
            longitude?.let { Value(real = it) } ?: Value(null_ = NullValue()),
            Value(text = timeZone),
        ),
    )

    /** A `media_asset` row as `PlacesAssetReads.query` projects it, thumbnail and all. */
    fun assetRow(assetId: String, capturedAt: String, placeId: String, thumbnail: String = "") =
        Row(
            values = listOf(
                Value(text = assetId),
                Value(text = capturedAt),
                Value(text = placeId),
                Value(text = thumbnail),
            ),
        )

    "the first open reads BOTH passes, because a card is a join the door will not do" {
        // `core_place` knows a place's name and its pin; only `media_asset`
        // knows how many photographs are at it. There is no join clause and no
        // COUNT(*) on this door, so one screen asks two questions.
        val opened = PlacesMachine.reduce(
            PlacesMachine.initial(),
            PlacesEvent(opened = PlacesEvent.Opened()),
        )
        opened.effects shouldBe listOf(
            ScreenEffect.ReadPage(PlacesMachine.SCREEN_ID, afterCursor = null),
            ScreenEffect.ReadPage(PlacesMachine.ASSETS_SCREEN_ID, afterCursor = null),
        )
        opened.state.loading.shouldNotBeNull().first_load.shouldBeTrue()
    }

    "cards or map is a parameter, and it costs no read" {
        // Doctrine 2, read one step further than v0 read it: `PlacesView` and
        // `PlacesMap` were two routes over one read, so opening the map showed
        // a spinner over places the member was looking at a moment earlier.
        val loaded = PlacesMachine.reduce(
            PlacesMachine.initial(),
            PlacesEvent(
                data_ = PlacesEvent.DataArrived(
                    PlacesData(places = listOf(PlaceRow(place_id = "p1", name = "The cabin"))),
                ),
            ),
        ).state
        val switched = PlacesMachine.reduce(
            loaded,
            PlacesEvent(
                presentation = PlacesEvent.PresentationChanged(
                    PlacesState.Presentation.PRESENTATION_MAP,
                ),
            ),
        )
        switched.state.presentation shouldBe PlacesState.Presentation.PRESENTATION_MAP
        switched.effects.shouldBeEmpty()
        // AND THE ROWS ARE STILL THERE. A presentation that cleared the data
        // would be the two-route bug with one route.
        switched.state.data_.shouldNotBeNull().places.single().name shouldBe "The cabin"
    }

    "a refused read clears the places and is NOT an empty shelf" {
        val loaded = PlacesMachine.reduce(
            PlacesMachine.initial(),
            PlacesEvent(
                data_ = PlacesEvent.DataArrived(
                    PlacesData(places = listOf(PlaceRow(place_id = "p1", name = "The cabin"))),
                ),
            ),
        ).state
        val refused = PlacesMachine.reduce(
            loaded,
            PlacesEvent(
                refused = PlacesEvent.ReadRefused(Reads.refused("This is not shared with you.")),
            ),
        )
        refused.state.data_.shouldBeNull()
        refused.state.failure.shouldNotBeNull().sentence shouldBe "This is not shared with you."
        // AND NO RE-READ. A retry is a wake, not a reducer's reflex.
        refused.effects.shouldBeEmpty()
    }

    "an empty shelf is data with no rows, and the two are different states" {
        val empty = PlacesMachine.reduce(
            PlacesMachine.initial(),
            PlacesEvent(data_ = PlacesEvent.DataArrived(PlacesData())),
        ).state
        empty.data_.shouldNotBeNull().places.shouldBeEmpty()
        empty.failure.shouldBeNull()
        val refused = PlacesMachine.reduce(
            PlacesMachine.initial(),
            PlacesEvent(refused = PlacesEvent.ReadRefused(Reads.refused("no"))),
        ).state
        (empty == refused).shouldBeFalse()
    }

    "a parked feed emits no re-read when rows move" {
        // Doctrine 8. Low disk PARKS: the cursor and the rows stay and the
        // retry cadence stops, because a loop that keeps re-applying a failing
        // batch is the regression the device contract pins.
        val parked = PlacesMachine.reduce(
            PlacesMachine.initial(),
            PlacesEvent(refused = PlacesEvent.ReadRefused(Reads.lowDiskParked())),
        ).state
        val moved = PlacesMachine.reduce(
            parked,
            PlacesEvent(rows_changed = PlacesEvent.RowsChanged(place_ids = listOf("p1"))),
        )
        moved.effects.shouldBeEmpty()

        // A LIVE FEED DOES RE-READ, and it reads BOTH passes: a place's count
        // is an aggregate and no subset of keys decides one.
        val live = PlacesMachine.reduce(
            PlacesMachine.initial(),
            PlacesEvent(rows_changed = PlacesEvent.RowsChanged(place_ids = listOf("p1"))),
        )
        live.effects.size shouldBe 2
    }

    "a change on a table this screen does not read answers null" {
        PlacesMachine.rowsChanged("core_place", listOf("p1")).shouldNotBeNull()
        PlacesMachine.rowsChanged("media_asset", listOf("a1")).shouldNotBeNull()
        PlacesMachine.rowsChanged("knowledge_note", listOf("n1")).shouldBeNull()
        // AND THE ASSET EVENT CARRIES NO IDS. `RowsChanged.place_ids` is a list
        // of PLACE ids and a `media_asset` change names assets, so the keys are
        // dropped rather than mislabelled.
        PlacesMachine.rowsChanged("media_asset", listOf("a1"))
            .shouldNotBeNull().rows_changed.shouldNotBeNull().place_ids.shouldBeEmpty()
    }

    "each pass reads the table its machine says it re-reads on" {
        // The pairing, mechanically. When a query moves to another table and
        // `rowsChanged` does not, nothing fails — the screen simply stops
        // redrawing on sync, and the symptom is a list that is right only after
        // a relaunch.
        listOf(
            PlacesReads.table to PlacesReads.query(PlacesMachine.initial(), null),
            PlacesAssetReads.table to PlacesAssetReads.query(PlacesMachine.initial(), null),
        ).forEach { (table, query) ->
            withClue("$table vs ${query.from}") {
                query.from shouldBe table
                PlacesMachine.rowsChanged(table, listOf("k")).shouldNotBeNull()
            }
        }
    }

    "every pass's select carries both order columns" {
        // THE DOOR HAS NO `key_of` CALLBACK, so the cursor is read off the row
        // by the two columns the ORDER BY names. A statement that orders by a
        // column it did not project produces a walk that repeats its first page.
        listOf(
            PlacesReads.query(PlacesMachine.initial(), null),
            PlacesAssetReads.query(PlacesMachine.initial(), null),
        ).forEach { query ->
            val order = query.order.shouldNotBeNull()
            withClue(query.select.toString()) {
                query.select.contains(order.sort_column).shouldBeTrue()
                query.select.contains(order.pk_column).shouldBeTrue()
            }
        }
    }

    "the places pass follows the desktop's own statement" {
        // `photos.shared.places` in `crates/apps/photos/src/places.rs`:
        // `core_place`, every row, ordered by `place_id`. A shelf in a
        // different order from the desktop's over the same rows is two shelves.
        val query = PlacesReads.query(PlacesMachine.initial(), null)
        query.from shouldBe "core_place"
        query.order.shouldNotBeNull().sort_column shouldBe "place_id"
        query.order.shouldNotBeNull().descending.shouldBeFalse()
        query.where_.shouldBeNull()
    }

    "the counting pass is the library's own predicate and order" {
        // `photos.library.live`: live and unarchived, newest first. Following
        // it is what makes the cover the NEWEST photograph at a place, as
        // `placeCards` picked, and keeps the trash out.
        val query = PlacesAssetReads.query(PlacesMachine.initial(), null)
        query.from shouldBe "media_asset"
        query.where_ shouldBe "deleted_at IS NULL AND archived_at IS NULL"
        query.order.shouldNotBeNull().sort_column shouldBe "captured_at"
        query.order.shouldNotBeNull().descending.shouldBeTrue()
        query.with_held_thumbnail.shouldBeTrue()
    }

    "0,0 IS A PLACE, and a half-pin is not" {
        // `has_coordinate` exists because the Gulf of Guinea is a real point
        // and not a null. A row with one coordinate is a row the plot cannot
        // draw, and drawing it at zero would put a member's photographs there.
        val rows = PlacesReads.arrived(
            listOf(
                placeRow("p-gulf", "The buoy", latitude = 0.0, longitude = 0.0),
                placeRow("p-half", "Half a pin", latitude = 12.5, longitude = null),
                placeRow("p-none", "No pin at all"),
            ),
            nextCursor = null,
        ).data_.shouldNotBeNull().data_.shouldNotBeNull().places
        val gulf = rows.single { it.place_id == "p-gulf" }
        gulf.has_coordinate.shouldBeTrue()
        gulf.latitude shouldBe 0.0
        rows.single { it.place_id == "p-half" }.has_coordinate.shouldBeFalse()
        rows.single { it.place_id == "p-none" }.has_coordinate.shouldBeFalse()
    }

    "a coordinate is never a name" {
        // `find_or_create_place`'s third rung mints a row whose stored `name`
        // IS its coordinates, and `printable_name` refuses one at every rung.
        // Without this, every unnamed place on the phone prints digits that
        // look like an answer.
        PlacesReads.readableName("39.0682, -120.1268").shouldBeNull()
        PlacesReads.readableName("-38.9186,-120.0836").shouldBeNull()
        PlacesReads.readableName("  ").shouldBeNull()
        PlacesReads.readableName("The cabin") shouldBe "The cabin"
        // NOT COORDINATE-SHAPED, so it is a name: no decimal point on either
        // side, and four whole digits is outside the shape.
        PlacesReads.readableName("Pier 39, San Francisco") shouldBe "Pier 39, San Francisco"
        val unnamed = PlacesReads.arrived(
            listOf(placeRow("p1", "39.0682, -120.1268", 39.0682, -120.1268)),
            nextCursor = null,
        ).data_.shouldNotBeNull().data_.shouldNotBeNull().places.single()
        unnamed.name shouldBe PlacesMachine.NO_NAME
    }

    "the counting pass counts by place, picks the newest cover, and counts the unplaced" {
        // A count derived by reading the rows and counting them, because the
        // door has no COUNT(*). `unplaced_count` is the number v0 never showed:
        // it is what says whether this screen is the library or a corner of it.
        val data = PlacesAssetReads.arrived(
            listOf(
                assetRow("a1", "2026-02-03T10:00:00Z", "p1", "/store/newest.data"),
                assetRow("a2", "2026-02-02T10:00:00Z", "p1", "/store/older.data"),
                assetRow("a3", "2026-02-01T10:00:00Z", "p2"),
                assetRow("a4", "2026-01-31T10:00:00Z", ""),
                assetRow("a5", "2026-01-30T10:00:00Z", ""),
            ),
            nextCursor = "2026-01-30T10:00:00Z|a5",
        ).data_.shouldNotBeNull().data_.shouldNotBeNull()
        data.unplaced_count shouldBe 2
        val first = data.places.single { it.place_id == "p1" }
        first.asset_count shouldBe 2
        // THE FIRST THUMBNAIL IN CAPTURE ORDER. A later row must not replace a
        // cover already chosen, or the cover would be the OLDEST photograph.
        first.cover_thumbnail_path shouldBe "/store/newest.data"
        data.places.single { it.place_id == "p2" }.asset_count shouldBe 1
        data.places.single { it.place_id == "p2" }.cover_thumbnail_path.shouldBeNull()
        // AND EVERY COUNT ON THIS ANSWER IS A FLOOR, because the door had more
        // to give. Per PAGE and not per place: when the page filled, ANY place
        // could have more assets beyond it.
        data.unplaced_count_capped.shouldBeTrue()
        data.places.forEach { it.asset_count_capped.shouldBeTrue() }
        // NO CURSOR, DELIBERATELY: a continuation over the nullable
        // `captured_at` drops rows, and `next_cursor` belongs to the place walk.
        data.next_cursor.shouldBeNull()
    }

    "a page that did not fill is an exact count, not a floor" {
        // The other half of the cap: no cursor and a short page means the read
        // reached the end of the library, so "at least" would be a hedge over
        // an answer this screen actually has.
        val data = PlacesAssetReads.arrived(
            listOf(assetRow("a1", "2026-02-03T10:00:00Z", "p1")),
            nextCursor = null,
        ).data_.shouldNotBeNull().data_.shouldNotBeNull()
        data.unplaced_count_capped.shouldBeFalse()
        data.places.single().asset_count_capped.shouldBeFalse()
    }

    "the two passes join, and the join does not care which landed first" {
        val places = PlacesReads.arrived(
            listOf(placeRow("p1", "The cabin", 37.79, -122.39, "America/Los_Angeles")),
            nextCursor = "p1|p1",
        ).data_.shouldNotBeNull().data_.shouldNotBeNull()
        val counts = PlacesAssetReads.arrived(
            listOf(
                assetRow("a1", "2026-02-03T10:00:00Z", "p1", "/store/cover.data"),
                assetRow("a2", "2026-02-02T10:00:00Z", ""),
            ),
            nextCursor = null,
        ).data_.shouldNotBeNull().data_.shouldNotBeNull()

        listOf(
            PlacesMachine.merge(places, counts),
            PlacesMachine.merge(counts, places),
        ).forEach { merged ->
            val joined = merged.shouldNotBeNull()
            val row = joined.places.single()
            withClue(row.toString()) {
                row.name shouldBe "The cabin"
                row.asset_count shouldBe 1
                row.cover_thumbnail_path shouldBe "/store/cover.data"
                row.has_coordinate.shouldBeTrue()
                row.time_zone shouldBe "America/Los_Angeles"
                // THE FLOOR TRAVELS WITH THE NUMBER, whichever order the two
                // answers landed in. Losing it would leave a count that
                // stopped at one page reading as a total.
                row.asset_count_capped.shouldBeFalse()
            }
            // THE PLACE WALK OWNS `next_cursor`. The counting pass reports
            // none, and `?:` is what stops it erasing the walk's own.
            joined.next_cursor shouldBe "p1|p1"
            joined.unplaced_count shouldBe 1
        }
    }

    "the shelf is most photographed first" {
        val merged = PlacesMachine.merge(
            PlacesData(
                places = listOf(
                    PlaceRow(place_id = "p1", name = "Quiet", asset_count = 1),
                    PlaceRow(place_id = "p2", name = "Busy", asset_count = 9),
                ),
            ),
            PlacesData(places = emptyList()),
        ).shouldNotBeNull()
        merged.places.map { it.place_id } shouldBe listOf("p2", "p1")
    }

    "a rename is the VAULT command, keyed by the intent and not by an ordinal" {
        val step = PlacesMachine.reduce(
            PlacesMachine.initial(),
            PlacesEvent(
                renamed = PlacesEvent.PlaceRenamed(place_id = "p1", name = "  The cabin  "),
            ),
        )
        val write = step.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "media.name_place"
        // `kind` IS NOT SENT: it is optional on the command and it is how the
        // ladder learns which place is Home, so writing one from a sheet that
        // never asked would answer a question the member was not shown.
        write.inputJson shouldBe "{\"place_id\":\"p1\",\"name\":\"The cabin\"}"
        // STABLE FOR THE SAME INTENT. A replayed command with the same key must
        // not re-execute a rename that already committed.
        write.invokeKey shouldBe "media.name_place:p1:The cabin"
        PlacesMachine.reduce(
            PlacesMachine.initial(),
            PlacesEvent(
                renamed = PlacesEvent.PlaceRenamed(place_id = "p1", name = "  The cabin  "),
            ),
        ).effects shouldBe step.effects
    }

    "a blank name is refused here rather than sent to be refused there" {
        // `media.name_place` refuses a blank name, so a round trip whose only
        // possible outcome is a denial is not made.
        PlacesMachine.reduce(
            PlacesMachine.initial(),
            PlacesEvent(renamed = PlacesEvent.PlaceRenamed(place_id = "p1", name = "   ")),
        ).effects.shouldBeEmpty()
        PlacesMachine.reduce(
            PlacesMachine.initial(),
            PlacesEvent(renamed = PlacesEvent.PlaceRenamed(place_id = "", name = "Home")),
        ).effects.shouldBeEmpty()
    }

    "only EXECUTED is a commit, and only a commit re-reads" {
        // QUEUED, IN_FLIGHT and PARKED all say the same thing — somewhere
        // durable, not yet committed — and `WriteSettled.committed` is a
        // boolean, so folding them into `true` would re-read a name the vault
        // has not written.
        PlacesReads.settled(CommandStatus.COMMAND_STATUS_EXECUTED, "", "test.command:row-0001")
            .write_settled.shouldNotBeNull().committed.shouldBeTrue()
        listOf(
            CommandStatus.COMMAND_STATUS_QUEUED,
            CommandStatus.COMMAND_STATUS_IN_FLIGHT,
            CommandStatus.COMMAND_STATUS_PARKED,
            CommandStatus.COMMAND_STATUS_DENIED,
            CommandStatus.COMMAND_STATUS_FAILED,
        ).forEach { status ->
            withClue(status.name) {
                PlacesReads.settled(status, "nope", "test.command:row-0001")
                    .write_settled.shouldNotBeNull().committed.shouldBeFalse()
            }
        }
        val committed = PlacesMachine.reduce(
            PlacesMachine.initial(),
            PlacesEvent(write_settled = PlacesEvent.WriteSettled(committed = true)),
        )
        committed.effects.size shouldBe 2
        val denied = PlacesMachine.reduce(
            PlacesMachine.initial(),
            PlacesEvent(
                write_settled = PlacesEvent.WriteSettled(committed = false, sentence = "nope"),
            ),
        )
        // A DENIED RENAME CHANGES NOTHING AND RE-READS NOTHING, and its
        // sentence lands on `write_failure` — NEVER on `failure`, which is the
        // READ's three-state slot. Putting it there would replace the shelf of
        // places the member was renaming from with an error about a write that
        // changed nothing.
        denied.effects.shouldBeEmpty()
        denied.state.failure.shouldBeNull()
        denied.state.write_failure.shouldNotBeNull().sentence shouldBe "nope"
    }

    "a refusal with no sentence still says something, and the shell writes it" {
        // `CommandOutcome.reason` is the author's words when there are any. A
        // refusal that carried none used to be silent, which is a rename that
        // fails and looks like a rename that worked.
        val denied = PlacesMachine.reduce(
            PlacesMachine.initial(),
            PlacesEvent(write_settled = PlacesEvent.WriteSettled(committed = false)),
        ).state
        denied.write_failure.shouldNotBeNull().sentence shouldBe PlacesMachine.NOT_SAVED
    }

    "a refused rename survives a sync re-read, and three things clear it" {
        val denied = PlacesMachine.reduce(
            PlacesMachine.initial(),
            PlacesEvent(
                write_settled = PlacesEvent.WriteSettled(committed = false, sentence = "nope"),
            ),
        ).state
        // A ROW MOVING SOMEWHERE ELSE IS NOT AN ANSWER TO A REFUSED RENAME, so
        // the sentence stays on screen for the member to read.
        PlacesMachine.reduce(
            denied,
            PlacesEvent(rows_changed = PlacesEvent.RowsChanged(place_ids = listOf("p1"))),
        ).state.write_failure.shouldNotBeNull()
        // The three that DO make it stale.
        PlacesMachine.reduce(denied, PlacesEvent(opened = PlacesEvent.Opened()))
            .state.write_failure.shouldBeNull()
        PlacesMachine.reduce(
            denied,
            PlacesEvent(renamed = PlacesEvent.PlaceRenamed(place_id = "p1", name = "Home")),
        ).state.write_failure.shouldBeNull()
        PlacesMachine.reduce(
            denied,
            PlacesEvent(write_settled = PlacesEvent.WriteSettled(committed = true)),
        ).state.write_failure.shouldBeNull()
    }

    "the plot drops a row with no pin, and the origin is the TOP left" {
        val plotted = PlacesMachine.plot(
            listOf(
                PlaceRow(
                    place_id = "north",
                    latitude = 40.0,
                    longitude = -120.0,
                    has_coordinate = true,
                ),
                PlaceRow(
                    place_id = "south",
                    latitude = 30.0,
                    longitude = -110.0,
                    has_coordinate = true,
                ),
                PlaceRow(place_id = "nowhere", name = "No pin"),
            ),
        )
        plotted.map { it.placeId } shouldBe listOf("north", "south")
        // y GROWS SOUTH: both shells' canvases put the origin at the top left,
        // and a plot that forgot that draws every library upside down.
        plotted.single { it.placeId == "north" }.y shouldBe 0.0
        plotted.single { it.placeId == "south" }.y shouldBe 1.0
        plotted.single { it.placeId == "north" }.x shouldBe 0.0
        plotted.single { it.placeId == "south" }.x shouldBe 1.0
    }

    "two rows of byte-identical zeros, and only the one with the bool is plotted" {
        // THE FIXTURE'S OWN CASE (`photos-places/no-coordinate`). Proto3
        // implicit presence puts NEITHER double on the wire for a row at
        // 0.0/0.0, so `has_coordinate` is the only recoverable signal: anything
        // testing `lat != 0 || lng != 0` is wrong about Null Island in one
        // direction and wrong about a genuinely unplaced row in the other.
        val plotted = PlacesMachine.plot(
            listOf(
                PlaceRow(
                    place_id = "gulf",
                    latitude = 0.0,
                    longitude = 0.0,
                    has_coordinate = true,
                ),
                PlaceRow(
                    place_id = "unplaced",
                    latitude = 0.0,
                    longitude = 0.0,
                    has_coordinate = false,
                ),
            ),
        )
        plotted.map { it.placeId } shouldBe listOf("gulf")
    }

    "one place, or several at one spot, lands in the middle rather than dividing by zero" {
        val plotted = PlacesMachine.plot(
            listOf(
                PlaceRow(place_id = "p1", latitude = 12.0, longitude = 34.0, has_coordinate = true),
                PlaceRow(place_id = "p2", latitude = 12.0, longitude = 34.0, has_coordinate = true),
            ),
        )
        plotted.forEach {
            it.x shouldBe 0.5
            it.y shouldBe 0.5
        }
    }
})
