package dev.centraid.shared

import centraid.core.v1.CommandStatus
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.PersonRow
import centraid.screen.v1.PhotosPeopleData
import centraid.screen.v1.PhotosPeopleEvent
import dev.centraid.shared.apps.photos.PhotosPeopleMachine
import dev.centraid.shared.apps.photos.PhotosPeopleReads
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotContain

/**
 * PEOPLE, AS A STATE MACHINE AND THREE STATEMENTS (#1029, photos port, lane L5).
 *
 * Everything here is `(state, event) -> (state, effects)` and the fold off a
 * `Row`, which is the part of a read that is DATA. What needs a real vault —
 * that the door answers these statements at all — is the device contract's job,
 * and a test that mocked a core to assert a mock's answer would prove only that
 * the mock was written to match.
 */
class PhotosPeopleSpec : StringSpec({

    fun region(regionId: String, assetId: String, partyId: String, state: String) = Row(
        values = listOf(
            Value(text = regionId),
            Value(text = assetId),
            Value(text = partyId),
            Value(text = state),
        ),
    )

    fun party(partyId: String, name: String) = Row(
        values = listOf(Value(text = partyId), Value(text = name), Value(text = "person")),
    )

    fun policy(tier: String) = Row(values = listOf(Value(text = "photos"), Value(text = tier)))

    fun fold(
        policyRows: List<Row> = listOf(policy("gateway")),
        partyRows: List<Row> = emptyList(),
        regionRows: List<Row> = emptyList(),
        nextCursor: String? = null,
    ) = PhotosPeopleReads.fold(policyRows, partyRows, regionRows, nextCursor)

    // --- the read law -----------------------------------------------------

    "the first Opened emits ONE ReadPage and seeds loading" {
        val step = PhotosPeopleMachine.reduce(
            PhotosPeopleMachine.initial(),
            PhotosPeopleEvent(opened = PhotosPeopleEvent.Opened()),
        )
        step.state.loading.shouldNotBeNull().first_load shouldBe true
        // ONE EFFECT FOR THREE TABLES. The fan-out is the bridge's, because the
        // content oneof leaves nowhere to park two answers while the third is
        // in flight — Wire refuses the state outright.
        step.effects shouldBe listOf(
            ScreenEffect.ReadPage(PhotosPeopleMachine.SCREEN_ID, afterCursor = null),
        )
    }

    "a refusal lands as a failure and never as an empty list" {
        val loaded = PhotosPeopleMachine.reduce(
            PhotosPeopleMachine.initial(),
            PhotosPeopleReads.arrived(
                fold(
                    partyRows = listOf(party("p-ada", "Ada")),
                    regionRows = listOf(region("r-1", "a-1", "p-ada", PhotosPeopleReads.CONFIRMED)),
                ),
            ),
        ).state
        loaded.data_.shouldNotBeNull().people.size shouldBe 1
        val refused = PhotosPeopleMachine.reduce(
            loaded,
            PhotosPeopleReads.refused(Reads.noCopyYet()),
        ).state
        refused.loading.shouldBeNull()
        // A LIST OF NAMES WITH NO COUNTS UNDER A SENTENCE would be the screen
        // claiming nobody in this vault has ever been photographed.
        refused.data_.shouldBeNull()
        refused.failure.shouldNotBeNull().sentence shouldNotContain "null"
    }

    "a parked feed emits NO re-read" {
        // A retry loop over a failing batch is the regression the device
        // contract already pins (census §E seam 8).
        val parked = PhotosPeopleMachine.reduce(
            PhotosPeopleMachine.initial(),
            PhotosPeopleReads.refused(Reads.lowDiskParked()),
        ).state
        PhotosPeopleMachine.reduce(
            parked,
            PhotosPeopleEvent(
                rows_changed = PhotosPeopleEvent.RowsChanged(party_ids = listOf("p")),
            ),
        ).effects.shouldBeEmpty()
        // And not on a settled write either — the same loop through a different
        // door.
        PhotosPeopleMachine.reduce(
            parked,
            PhotosPeopleReads.settled(CommandStatus.COMMAND_STATUS_FAILED, "", "test.command:row-0001"),
        ).effects.shouldBeEmpty()
    }

    "rowsChanged answers for its three tables and null for any other" {
        listOf(
            PhotosPeopleReads.REGION_TABLE,
            PhotosPeopleReads.PARTY_TABLE,
            PhotosPeopleReads.POLICY_TABLE,
        ).forEach { table ->
            withClue(table) {
                PhotosPeopleMachine.rowsChanged(table, listOf("k")).shouldNotBeNull()
            }
        }
        PhotosPeopleMachine.rowsChanged("media_asset", listOf("k")).shouldBeNull()
    }

    "a row change re-reads from the top, because a list may renumber" {
        val loaded = PhotosPeopleMachine.reduce(
            PhotosPeopleMachine.initial(),
            PhotosPeopleReads.arrived(fold()),
        ).state
        val step = PhotosPeopleMachine.reduce(
            loaded,
            PhotosPeopleEvent(
                rows_changed = PhotosPeopleEvent.RowsChanged(party_ids = listOf("p")),
            ),
        )
        step.effects shouldBe listOf(
            ScreenEffect.ReadPage(PhotosPeopleMachine.SCREEN_ID, afterCursor = null),
        )
        // AND THE DATA GOES, because Wire's oneof will not hold a list under a
        // loading state — which is the read law made structural.
        step.state.data_.shouldBeNull()
        step.state.loading.shouldNotBeNull()
    }

    // --- empty_reason: the field this screen exists to get right -----------

    "recognition off is the TIER's answer and never an absence" {
        // THE DEFECT THIS PINS (`PeopleEmptyState.tsx`): v0 drew one sentence
        // for three different empty screens. "Off" is a setting with a next
        // move; "nothing found yet" is waiting; and no region row means either,
        // depending on a switch this fold reads.
        fold(policyRows = listOf(policy("off"))).empty_reason shouldBe
            PhotosPeopleData.EmptyReason.EMPTY_REASON_RECOGNITION_OFF
    }

    "no policy row at all is off, because the failure-safe direction is not running" {
        fold(policyRows = emptyList()).empty_reason shouldBe
            PhotosPeopleData.EmptyReason.EMPTY_REASON_RECOGNITION_OFF
    }

    "the retired tier names are read forward and still mean ON" {
        // `local` and `model` are the pre-#712 spellings the column's CHECK
        // still admits; a vault written by an older build must not report its
        // recognition switched off.
        listOf("device", "local", "gateway", "model").forEach { tier ->
            withClue(tier) { PhotosPeopleReads.recognitionIsOn(tier) shouldBe true }
        }
        listOf("off", "", "everywhere").forEach { tier ->
            withClue(tier) { PhotosPeopleReads.recognitionIsOn(tier) shouldBe false }
        }
    }

    "on with no regions is NOT RUN YET, which is a different screen from off" {
        fold(partyRows = listOf(party("p-ada", "Ada"))).empty_reason shouldBe
            PhotosPeopleData.EmptyReason.EMPTY_REASON_NOT_RUN_YET
    }

    "faces found and none confirmed is NONE NAMED, and the door carries the count" {
        val data = fold(
            partyRows = listOf(party("p-ada", "Ada")),
            regionRows = listOf(
                region("r-1", "a-1", "", PhotosPeopleReads.PROPOSED),
                region("r-2", "a-2", "", PhotosPeopleReads.PROPOSED),
            ),
        )
        data.empty_reason shouldBe PhotosPeopleData.EmptyReason.EMPTY_REASON_NONE_NAMED
        data.people.shouldBeEmpty()
        // COUNTED OFF THE ROWS, because the page door has no `COUNT(*)`.
        data.proposed_face_count shouldBe 2
    }

    "somebody named is NONE, and NONE means 'not empty'" {
        fold(
            partyRows = listOf(party("p-ada", "Ada")),
            regionRows = listOf(region("r-1", "a-1", "p-ada", PhotosPeopleReads.CONFIRMED)),
        ).empty_reason shouldBe PhotosPeopleData.EmptyReason.EMPTY_REASON_NONE
    }

    "switching recognition off does not un-name the people already named" {
        // A list that emptied itself when the switch moved would look like it
        // had forgotten them.
        val data = fold(
            policyRows = listOf(policy("off")),
            partyRows = listOf(party("p-ada", "Ada")),
            regionRows = listOf(region("r-1", "a-1", "p-ada", PhotosPeopleReads.CONFIRMED)),
        )
        data.people.single().display_name shouldBe "Ada"
        data.empty_reason shouldBe PhotosPeopleData.EmptyReason.EMPTY_REASON_NONE
    }

    // --- the join, and what it refuses to draw ----------------------------

    "the count is PER PHOTOGRAPH, not per region" {
        // Two faces of one person in one frame are one photograph of them —
        // `faces.rs`' `assets_by_party` dedupes with a set of asset ids and so
        // does this. "2 photos" under a single group shot is the defect.
        fold(
            partyRows = listOf(party("p-ada", "Ada")),
            regionRows = listOf(
                region("r-1", "a-1", "p-ada", PhotosPeopleReads.CONFIRMED),
                region("r-2", "a-1", "p-ada", PhotosPeopleReads.CONFIRMED),
                region("r-3", "a-2", "p-ada", PhotosPeopleReads.CONFIRMED),
            ),
        ).people.single().photo_count shouldBe 2
    }

    "a count off a FULL page is capped, and off a finished one is not" {
        // THE DOOR HAS NO `COUNT(*)`. A page with a cursor behind it has more
        // rows this person may be in, so the honest phrasing is "at least"
        // (`HomeState.ThingCount.capped`). A bare number over a full page would
        // state a total nobody counted.
        val rows = listOf(region("r-1", "a-1", "p-ada", PhotosPeopleReads.CONFIRMED))
        val names = listOf(party("p-ada", "Ada"))
        fold(partyRows = names, regionRows = rows, nextCursor = null)
            .people.single().photo_count_capped shouldBe false
        fold(partyRows = names, regionRows = rows, nextCursor = "r-1|r-1")
            .people.single().photo_count_capped shouldBe true
    }

    "a confirmed region whose party was purged is DROPPED, never drawn as an id" {
        // `party_id` is `ON DELETE SET NULL` (#916, D1), so a purged member
        // leaves their confirmed faces behind unnamed. A row on this screen for
        // somebody the member asked to be forgotten is one defect; an id drawn
        // where a name goes is the other (`AppReadsSpec`, Tally's payer).
        fold(
            partyRows = listOf(party("p-ada", "Ada")),
            regionRows = listOf(
                region("r-1", "a-1", "p-ada", PhotosPeopleReads.CONFIRMED),
                region("r-2", "a-2", "", PhotosPeopleReads.CONFIRMED),
                region("r-3", "a-3", "p-gone", PhotosPeopleReads.CONFIRMED),
            ),
        ).people.map { it.party_id } shouldBe listOf("p-ada")
    }

    "a person with a name and no confirmed face is not on this screen" {
        // CONFIRMED REGIONS ONLY. Every contact in the vault is a `core_party`
        // row; a People screen that listed them would be an address book with a
        // photographs label on it.
        fold(
            partyRows = listOf(party("p-ada", "Ada"), party("p-bo", "Bo")),
            regionRows = listOf(region("r-1", "a-1", "p-ada", PhotosPeopleReads.CONFIRMED)),
        ).people.map { it.display_name } shouldBe listOf("Ada")
    }

    "a proposed region does not make somebody a person" {
        // "A proposal is not a photograph of someone until a member has said
        // so" — the proto's own words for `PersonRow.photo_count`.
        fold(
            partyRows = listOf(party("p-ada", "Ada")),
            regionRows = listOf(region("r-1", "a-1", "p-ada", PhotosPeopleReads.PROPOSED)),
        ).people.shouldBeEmpty()
    }

    "people are ordered by name, because that is what a member looks for" {
        fold(
            partyRows = listOf(party("p-z", "Zoë"), party("p-a", "Ada"), party("p-m", "Mo")),
            regionRows = listOf(
                region("r-1", "a-1", "p-z", PhotosPeopleReads.CONFIRMED),
                region("r-2", "a-2", "p-z", PhotosPeopleReads.CONFIRMED),
                region("r-3", "a-3", "p-a", PhotosPeopleReads.CONFIRMED),
                region("r-4", "a-4", "p-m", PhotosPeopleReads.CONFIRMED),
            ),
        ).people.map { it.display_name } shouldBe listOf("Ada", "Mo", "Zoë")
    }

    "a cover NAMES ITS ASSET, stably, and the path comes from the leg" {
        // The key is what makes a fourth read possible at all: a cover is
        // `media_asset`'s thumbnail and the door has no join, so a row with no
        // asset id gives that leg nothing to ask about.
        //
        // The choice is the first confirmed photograph the page yields, which
        // is not "their best" — the door cannot rank — but IS stable, because
        // the page is ordered by `region_id`. A member's people list must not
        // shuffle its faces between openings.
        val data = fold(
            partyRows = listOf(party("p-ada", "Ada")),
            regionRows = listOf(
                region("r-1", "a-9", "p-ada", PhotosPeopleReads.CONFIRMED),
                region("r-2", "a-1", "p-ada", PhotosPeopleReads.CONFIRMED),
            ),
        )
        data.people.single().cover_asset_id shouldBe "a-9"
        // THE PATH IS ABSENT UNTIL THE LEG ANSWERS, and a path invented here
        // would claim bytes this device may not hold.
        data.people.single().cover_thumbnail_path.shouldBeNull()

        val withCover = PhotosPeopleReads.withCovers(
            data,
            listOf(Row(values = listOf(Value(text = "a-9"), Value(text = "/store/a.data")))),
        )
        withCover.people.single().cover_thumbnail_path shouldBe "/store/a.data"
    }

    "a cover the leg could not resolve stays ABSENT, never a placeholder" {
        // An empty appended column is a real answer with more than one cause —
        // the bytes have not reached this device, or they are a reading no
        // surface may embed. Neither is an error, and the view draws the
        // person's initial for both.
        val data = fold(
            partyRows = listOf(party("p-ada", "Ada")),
            regionRows = listOf(region("r-1", "a-9", "p-ada", PhotosPeopleReads.CONFIRMED)),
        )
        PhotosPeopleReads.withCovers(
            data,
            listOf(Row(values = listOf(Value(text = "a-9"), Value(text = "")))),
        ).people.single().cover_thumbnail_path.shouldBeNull()
        // AND A LEG THAT DID NOT RUN CHANGES NOTHING.
        PhotosPeopleReads.withCovers(data, emptyList()) shouldBe data
    }

    "the cover leg asks only about the ids it was given" {
        val query = PhotosPeopleReads.coversQuery(listOf("a-1", "a-2")).shouldNotBeNull()
        query.from shouldBe PhotosPeopleReads.ASSET_TABLE
        query.where_ shouldBe "asset_id IN (?, ?)"
        query.bind.mapNotNull { it.text } shouldBe listOf("a-1", "a-2")
        query.with_held_thumbnail shouldBe true
        // AN `IN ()` IS NOT A PREDICATE. A leg with nothing to ask is a trip not
        // taken, never a statement matching every row in the library.
        PhotosPeopleReads.coversQuery(emptyList()).shouldBeNull()
    }

    // --- the statements ---------------------------------------------------

    "every statement selects both of its order columns" {
        // THE DOOR HAS NO `key_of` CALLBACK: the cursor is read off the row by
        // the two columns the ORDER BY names, so a statement that orders by a
        // column it did not project produces a second page that repeats the
        // first.
        listOf(
            PhotosPeopleReads.regionsQuery(),
            PhotosPeopleReads.partiesQuery(),
            PhotosPeopleReads.policyQuery(),
        ).forEach { query ->
            val order = query.order.shouldNotBeNull()
            withClue("${query.name} selects ${query.select}") {
                query.select.contains(order.sort_column) shouldBe true
                query.select.contains(order.pk_column) shouldBe true
            }
        }
    }

    "every statement orders on a column the door will walk" {
        // A CONTINUED PAGE OVER A NULLABLE SORT KEY IS REFUSED
        // (`KitError::NullableSortKey`). `region_id`, `display_name` and
        // `domain` are all NOT NULL in the DDL; `captured_at`, `deleted_at` and
        // `media_asset_phash.cluster_id` are the ones that are not, and none of
        // them is here.
        PhotosPeopleReads.regionsQuery().order.shouldNotBeNull().sort_column shouldBe "region_id"
        PhotosPeopleReads.partiesQuery().order.shouldNotBeNull().sort_column shouldBe "display_name"
        PhotosPeopleReads.policyQuery().order.shouldNotBeNull().sort_column shouldBe "domain"
    }

    "a predicate binds its values and never inlines them" {
        val regions = PhotosPeopleReads.regionsQuery()
        regions.where_.shouldNotBeNull() shouldNotContain PhotosPeopleReads.CONFIRMED
        regions.bind.mapNotNull { it.text } shouldBe
            listOf(PhotosPeopleReads.CONFIRMED, PhotosPeopleReads.PROPOSED)
        PhotosPeopleReads.policyQuery().bind.mapNotNull { it.text } shouldBe
            listOf(PhotosPeopleReads.DOMAIN)
        PhotosPeopleReads.partiesQuery().bind.mapNotNull { it.text } shouldBe
            listOf(PhotosPeopleReads.PERSON)
    }

    "the statements read the tables the machine says it re-reads on" {
        // THE PAIRING, ASSERTED MECHANICALLY. When a query moves table and
        // `rowsChanged` does not follow, nothing fails: the screen stops
        // redrawing on sync, and the symptom is a list that is right only after
        // a relaunch.
        listOf(
            PhotosPeopleReads.regionsQuery().from,
            PhotosPeopleReads.partiesQuery().from,
            PhotosPeopleReads.policyQuery().from,
        ).forEach { from ->
            withClue(from) { PhotosPeopleMachine.rowsChanged(from, listOf("k")).shouldNotBeNull() }
        }
    }

    // --- the rename -------------------------------------------------------

    "a rename paints the row AND writes the core command" {
        val state = PhotosPeopleMachine.reduce(
            PhotosPeopleMachine.initial(),
            PhotosPeopleReads.arrived(
                PhotosPeopleData(
                    people = listOf(
                        PersonRow(party_id = "p-ada", display_name = "Ada", photo_count = 3),
                    ),
                    empty_reason = PhotosPeopleData.EmptyReason.EMPTY_REASON_NONE,
                ),
            ),
        ).state
        val step = PhotosPeopleMachine.reduce(
            state,
            PhotosPeopleEvent(
                renamed = PhotosPeopleEvent.PersonRenamed(
                    party_id = "p-ada",
                    display_name = "Ada Lovelace",
                ),
            ),
        )
        // THE PAINT: the new name is on the screen the instant the member
        // presses done, not a round trip later.
        step.state.data_.shouldNotBeNull().people.single().display_name shouldBe "Ada Lovelace"
        val write = step.effects.single() as ScreenEffect.SubmitWrite
        // THE COMMAND THE VAULT ACTUALLY HAS. There is no `media.rename_person`;
        // the name lives on `core_party` and `core.update_party` is its only
        // registered writer.
        write.command shouldBe "core.update_party"
        write.inputJson shouldBe "{\"party_id\":\"p-ada\",\"display_name\":\"Ada Lovelace\"}"
        // STABLE FOR THE SAME INTENT, never an ordinal.
        write.invokeKey shouldBe "core.update_party:p-ada:Ada Lovelace"
    }

    "an empty name never leaves the reducer" {
        // `core.update_party` puts `minLength: 1` on the name, so an empty one
        // is refused by the vault rather than clearing the column — and a
        // member would watch a name vanish and come back.
        PhotosPeopleMachine.reduce(
            PhotosPeopleMachine.initial(),
            PhotosPeopleEvent(
                renamed = PhotosPeopleEvent.PersonRenamed(party_id = "p-ada", display_name = ""),
            ),
        ).effects.shouldBeEmpty()
    }

    "a refused rename re-reads AND says why, beside the row" {
        // THE PAINT IS A CLAIM AND THIS TAKES IT BACK: the re-read puts
        // `core_party`'s own answer on the row, and `write_failure` carries the
        // reason. It is its OWN slot and never the content oneof's `failure` —
        // that one is the READ's, and a denied write put there would replace
        // the whole list with an error, so a member whose rename was refused
        // would lose the list they were renaming from. Before the field existed
        // the refusal was silent.
        val state = PhotosPeopleMachine.reduce(
            PhotosPeopleMachine.initial(),
            PhotosPeopleReads.arrived(fold()),
        ).state
        val step = PhotosPeopleMachine.reduce(
            state,
            PhotosPeopleReads.settled(CommandStatus.COMMAND_STATUS_DENIED, "This vault has moved.", "test.command:row-0001"),
        )
        step.effects shouldBe listOf(
            ScreenEffect.ReadPage(PhotosPeopleMachine.SCREEN_ID, afterCursor = null),
        )
        step.state.write_failure.shouldNotBeNull().sentence shouldBe "This vault has moved."
        // A COMMITTED RENAME NEEDS NOTHING: the row change it caused arrives on
        // its own, the paint already agrees with it, and the sentence clears.
        PhotosPeopleMachine.reduce(
            step.state,
            PhotosPeopleReads.settled(CommandStatus.COMMAND_STATUS_EXECUTED, "", "test.command:row-0001"),
        ).let { committed ->
            committed.effects.shouldBeEmpty()
            committed.state.write_failure.shouldBeNull()
        }
    }

    "a refusal with no words still gets a sentence" {
        // `CommandOutcome.reason` is the author's sentence and can be empty; a
        // blank line beside a row would be worse than a plain one.
        PhotosPeopleMachine.reduce(
            PhotosPeopleMachine.initial(),
            PhotosPeopleReads.settled(CommandStatus.COMMAND_STATUS_FAILED, "", "test.command:row-0001"),
        ).state.write_failure.shouldNotBeNull().sentence shouldBe
            "Centraid could not save that name."
    }

    "a parked vault still gets the sentence, and still emits no re-read" {
        // A member is owed the reason whether or not the list can be refreshed.
        val parked = PhotosPeopleMachine.reduce(
            PhotosPeopleMachine.initial(),
            PhotosPeopleReads.refused(Reads.lowDiskParked()),
        ).state
        val step = PhotosPeopleMachine.reduce(
            parked,
            PhotosPeopleReads.settled(CommandStatus.COMMAND_STATUS_DENIED, "nope", "test.command:row-0001"),
        )
        step.effects.shouldBeEmpty()
        step.state.write_failure.shouldNotBeNull().sentence shouldBe "nope"
    }

    "a new rename clears the last one's sentence" {
        var state = PhotosPeopleMachine.reduce(
            PhotosPeopleMachine.initial(),
            PhotosPeopleReads.arrived(
                PhotosPeopleData(
                    people = listOf(PersonRow(party_id = "p-ada", display_name = "Ada")),
                    empty_reason = PhotosPeopleData.EmptyReason.EMPTY_REASON_NONE,
                ),
            ),
        ).state
        state = state.copy(write_failure = Reads.refused("stale"))
        PhotosPeopleMachine.reduce(
            state,
            PhotosPeopleEvent(
                renamed = PhotosPeopleEvent.PersonRenamed(
                    party_id = "p-ada",
                    display_name = "Ada L",
                ),
            ),
        ).state.write_failure.shouldBeNull()
    }

    "only EXECUTED is committed" {
        // QUEUED, IN_FLIGHT and PARKED all mean "somewhere durable, not yet
        // committed"; a screen that read them as done would claim a write that
        // has not happened.
        listOf(
            CommandStatus.COMMAND_STATUS_QUEUED,
            CommandStatus.COMMAND_STATUS_IN_FLIGHT,
            CommandStatus.COMMAND_STATUS_PARKED,
            CommandStatus.COMMAND_STATUS_DENIED,
            CommandStatus.COMMAND_STATUS_FAILED,
        ).forEach { status ->
            withClue(status.name) {
                PhotosPeopleReads.settled(status, "", "test.command:row-0001")
                    .write_settled.shouldNotBeNull().committed shouldBe false
            }
        }
        PhotosPeopleReads.settled(CommandStatus.COMMAND_STATUS_EXECUTED, "", "test.command:row-0001")
            .write_settled.shouldNotBeNull().committed shouldBe true
    }

    "a name with a quote in it survives the hand-built JSON" {
        PhotosPeopleMachine.renameInput("p-1", "Ada \"Ace\" L") shouldBe
            "{\"party_id\":\"p-1\",\"display_name\":\"Ada \\\"Ace\\\" L\"}"
    }

    // --- where a tap lands -------------------------------------------------

    "a tap on a person is a SHELF with the name riding along" {
        // A DESTINATION IS A PARAMETER, NOT A SCREEN. There is no
        // `PersonPhotosState`: a person's photographs are the library under a
        // predicate, and the name rides so the app bar does not wait for a read.
        val shelf = PhotosPeopleMachine.shelfFor(
            PersonRow(party_id = "p-ada", display_name = "Ada", photo_count = 3),
        )
        val person = shelf.state_view.shouldNotBeNull().person.shouldNotBeNull()
        person.party_id shouldBe "p-ada"
        person.person_name shouldBe "Ada"
    }
})
