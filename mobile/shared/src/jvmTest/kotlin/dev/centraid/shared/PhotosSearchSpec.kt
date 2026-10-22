package dev.centraid.shared

import centraid.core.v1.ContainerHit
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.PhotoCell
import centraid.screen.v1.PhotosSearchEvent
import centraid.screen.v1.SearchMatch
import dev.centraid.shared.apps.photos.PhotoFold
import dev.centraid.shared.apps.photos.PhotosSearchMachine
import dev.centraid.shared.apps.photos.PhotosSearchReads
import dev.centraid.shared.apps.photos.PhotosSearchReads.Reach
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain

/**
 * SEARCH, AS A PURE FUNCTION (#1029, the photos port).
 *
 * The one thing this screen exists to keep is the distinction a bag of
 * optionals erases — **a member who has typed nothing and a member whose query
 * matched nothing must not read the same words** — so most of what is asserted
 * here is which of the four arms the state is in after each event.
 *
 * The legs themselves are `PhotosSearchBridge`'s trip; what is asserted here is
 * every fold and statement they are made of (`PhotosSearchReads`), which needs
 * no vault.
 */
class PhotosSearchSpec : StringSpec({

    val machine = PhotosSearchMachine

    /**
     * A hit's row: `id, taken_at, offset_min, form, burst`, then the door's three.
     * The caption is the ENTITY's and arrives on its own read: see [hits].
     */
    fun assetRow(
        id: String,
        capturedAt: String,
        kind: String = "photo",
    ) = Row(
        values = listOf(
            Value(text = id),
            Value(text = capturedAt),
            Value(integer = 0L),
            Value(text = kind),
            Value(text = ""),
            // The door's three appended columns, in the order `api::page`
            // appends them: the thumbnail's path, the original's hash, and
            // whether the original is held.
            Value(text = "/store/data/$id.data"),
            Value(text = "a0b1"),
            Value(integer = 1L),
        ),
    )

    fun typed(query: String) =
        PhotosSearchEvent(query = PhotosSearchEvent.QueryChanged(query = query))

    /**
     * A hits page for [query] with no doors and no labels: captions only. Every
     * photograph is titled "Harbour at dusk" unless [titles] says otherwise, the
     * way the titles read hands them over (`photos.search.titles`, by id).
     */
    fun hits(
        query: String,
        rows: List<Row>,
        nextCursor: String? = null,
        titles: Map<String, String> = rows.associate { it.values[0].text!! to "Harbour at dusk" },
    ) = PhotosSearchReads.hitsArrived(
        query,
        rows,
        nextCursor,
        topHits = emptyList(),
        labels = emptyList(),
        titles = titles,
    )

    val vocabularyRead = listOf(ScreenEffect.ReadPage(PhotosSearchMachine.SCREEN_ID, afterCursor = null))

    "the screen rests before anything is typed, and opening it reads the vocabulary" {
        // LOADING WOULD BE A CLAIM THAT A HITS READ IS IN FLIGHT, and this
        // screen makes none until a member types — so a spinner here would
        // never finish. The fourth arm of the oneof exists for exactly this.
        machine.initial().resting.shouldNotBeNull()
        machine.initial().loading shouldBe null

        // WHAT THIS VAULT CAN BE SEARCHED FOR is read on open, and it lands
        // in the resting arm — never in `loading`.
        val opened = machine.reduce(
            machine.initial(),
            PhotosSearchEvent(opened = PhotosSearchEvent.Opened()),
        )
        opened.state.resting.shouldNotBeNull()
        opened.state.loading shouldBe null
        opened.effects shouldBe vocabularyRead
    }

    "typing asks for a page; clearing the field goes back to resting, not to empty" {
        val asking = machine.reduce(machine.initial(), typed("harbour"))
        asking.state.query shouldBe "harbour"
        asking.state.resting shouldBe null
        asking.state.loading.shouldNotBeNull().first_load shouldBe true
        asking.effects shouldBe listOf(
            ScreenEffect.ReadPage(PhotosSearchMachine.SCREEN_ID, afterCursor = null),
        )

        // THE MOMENT THE TWO STATES ARE MOST EASILY CONFUSED. A member who
        // deleted their query must not read "Nothing matches"; the resting
        // page reads its vocabulary again.
        val cleared = machine.reduce(asking.state, typed("   "))
        cleared.state.resting.shouldNotBeNull()
        cleared.state.query shouldBe ""
        cleared.state.hits shouldBe null
        cleared.effects shouldBe vocabularyRead
    }

    "refining a search keeps the frame, so the results do not flash away" {
        val found = machine.reduce(
            machine.reduce(machine.initial(), typed("har")).state,
            hits("har", listOf(assetRow("a-1", "2026-02-03T10:00:00Z"))),
        ).state
        found.hits.shouldNotBeNull()
        // A SPINNER OVER AN EMPTY SCREEN AND A SPINNER OVER LAST QUERY'S HITS
        // ARE DIFFERENT SCREENS.
        machine.reduce(found, typed("harb")).state.loading
            .shouldNotBeNull().first_load shouldBe false
    }

    "a page for a query the field has left is dropped, not drawn" {
        // A MEMBER TYPES FASTER THAN LEGS RETURN. Drawing "har"'s page under
        // "harbour" is one query's photographs under another's words.
        val asking = machine.reduce(machine.initial(), typed("harbour")).state
        val late = machine.reduce(asking, hits("har", listOf(assetRow("a-1", "2026-02-03T10:00:00Z"))))
        late.state shouldBe asking
        late.effects.shouldBeEmpty()

        // AND A PAGE THAT LANDS AFTER THE FIELD WAS CLEARED DRAWS NOTHING.
        val resting = machine.reduce(asking, typed("")).state
        machine.reduce(resting, hits("harbour", listOf(assetRow("a-1", "2026-02-03T10:00:00Z"))))
            .state shouldBe resting
    }

    "the vocabulary lands only on an empty field" {
        val vocabulary = PhotosSearchReads.restingArrived(
            placeRows = emptyList(),
            labelRows = listOf(Row(values = listOf(Value(text = "c-1"), Value(text = "beach")))),
        )
        val resting = machine.reduce(machine.initial(), vocabulary).state.resting.shouldNotBeNull()
        resting.suggested_labels.map { it.label } shouldContainExactly listOf("beach")

        // A MEMBER WHO STARTED TYPING while it was in flight is looking at
        // their query, not at it.
        val typing = machine.reduce(machine.initial(), typed("harbour")).state
        machine.reduce(typing, vocabulary).state shouldBe typing
    }

    "hits carry the cells and the reason they matched" {
        val found = hits(
            "harbour",
            listOf(assetRow("a-1", "2026-02-03T10:00:00Z", "video")),
            nextCursor = "2026-02-03|a-1",
        ).data_.shouldNotBeNull().hits.shouldNotBeNull()

        found.next_cursor shouldBe "2026-02-03|a-1"
        // THE QUERY IT ANSWERS rides the page, so a reducer can tell it from
        // a late one.
        found.query shouldBe "harbour"
        // WHY THESE MATCHED, AS A KIND AND A VALUE — never as prose. `value`
        // is what the query LANDED ON, never the query echoed back.
        found.matches shouldContainExactly listOf(
            SearchMatch(kind = SearchMatch.Kind.KIND_TITLE, value_ = "Harbour at dusk"),
        )
        val cell = found.cells.single()
        cell.asset_id shouldBe "a-1"
        cell.kind shouldBe PhotoCell.Kind.KIND_VIDEO
        cell.thumbnail_path shouldBe "/store/data/a-1.data"
        cell.original_hash shouldBe "a0b1"
        // THE HELD DERIVATION IS `PhotosReads.heldOf`'s AND NOT A SECOND COPY:
        // this row says the original is on the device, so no download arrow.
        cell.held shouldBe PhotoCell.Held.HELD_ORIGINAL
        // `favorite` IS FALSE on a cell: the star is an edge, and a cell is a row.
        cell.favorite shouldBe false
    }

    "nothing matched is DATA with no cells, and never a refusal" {
        // AN EMPTY RESULT SET IS A REAL ANSWER and it is a different screen
        // from a refusal: only one of the two means the member should try other
        // words. `matches` is empty too — it exists to explain hits, and an
        // explanation of nothing is noise.
        val event = hits("zebra", emptyList())
        event.refused shouldBe null
        val found = event.data_.shouldNotBeNull().hits.shouldNotBeNull()
        found.cells.shouldBeEmpty()
        found.matches.shouldBeEmpty()
        found.top_hits.shouldBeEmpty()

        val state = machine.reduce(
            machine.reduce(machine.initial(), typed("zebra")).state,
            event,
        ).state
        state.hits.shouldNotBeNull()
        state.resting shouldBe null
        state.failure shouldBe null
    }

    "a refused read is a sentence, never an empty result set" {
        val refused = machine.reduce(
            machine.reduce(machine.initial(), typed("harbour")).state,
            PhotosSearchReads.refused(Reads.refused("The access plane said no.")),
        )
        refused.state.hits shouldBe null
        refused.state.resting shouldBe null
        refused.state.loading shouldBe null
        refused.state.failure.shouldNotBeNull().sentence shouldBe "The access plane said no."
        refused.effects.shouldBeEmpty()
    }

    "a parked feed emits no re-read, from a scroll or from a row change" {
        val parked = machine.reduce(
            machine.reduce(machine.initial(), typed("harbour")).state,
            PhotosSearchEvent(
                refused = PhotosSearchEvent.ReadRefused(failure = Reads.lowDiskParked()),
            ),
        ).state

        machine.reduce(
            parked,
            PhotosSearchEvent(next_page = PhotosSearchEvent.NextPageRequested("2026|a-1")),
        ).effects.shouldBeEmpty()

        machine.reduce(
            parked,
            PhotosSearchEvent(rows_changed = PhotosSearchEvent.RowsChanged(emptyList())),
        ).effects.shouldBeEmpty()
    }

    "a row change re-reads what is showing, and only a live search filters by asset" {
        // AN EMPTY FIELD RE-READS ITS VOCABULARY IN PLACE: a place named or a
        // label put on is a new word to search for, and the words on screen
        // stay until the new ones land.
        val restingStep = machine.reduce(
            machine.initial(),
            PhotosSearchEvent(rows_changed = PhotosSearchEvent.RowsChanged(listOf("a-1"))),
        )
        restingStep.effects shouldBe vocabularyRead
        restingStep.state.resting.shouldNotBeNull()

        val showing = machine.reduce(
            machine.reduce(machine.initial(), typed("harbour")).state,
            hits("harbour", listOf(assetRow("a-1", "2026-02-03T10:00:00Z"))),
        ).state

        // EMPTY KEYS ARE "SOMETHING MOVED AND NOBODY CAN SAY WHAT".
        // `ChangeFeed::tables_changed` offers `pk_set: Vec::new()` for every
        // locally committed command, so a filter that read that as "none of
        // mine" would freeze this screen against the member's own writes.
        listOf(listOf("a-1"), emptyList()).forEach { keys ->
            withClue("keys=$keys") {
                machine.reduce(
                    showing,
                    PhotosSearchEvent(rows_changed = PhotosSearchEvent.RowsChanged(keys)),
                ).effects shouldBe listOf(
                    ScreenEffect.ReadPage(PhotosSearchMachine.SCREEN_ID, afterCursor = null),
                )
            }
        }

        // AN ASSET THIS SCREEN IS NOT SHOWING MOVES NOTHING: a camera roll
        // gains rows all day during a backup and a search that redrew on each
        // would never settle.
        machine.reduce(
            showing,
            PhotosSearchEvent(rows_changed = PhotosSearchEvent.RowsChanged(listOf("a-999"))),
        ).effects.shouldBeEmpty()
    }

    "rowsChanged answers for every table a search reads, and null for the rest" {
        machine.rowsChanged("photo", listOf("a-1")).shouldNotBeNull()
            .rows_changed.shouldNotBeNull().asset_ids shouldBe listOf("a-1")
        // A PLACE RENAMED, AN ALBUM FILLED, A LABEL PUT ON: each can change an
        // answer, and none of their keys is an asset id, so they arrive as
        // "something moved", never as a filter. A name, a title and a trash are
        // the entity's; a membership and a label are edges.
        listOf("entity", "place", "container", "edge").forEach { table ->
            withClue(table) {
                machine.rowsChanged(table, listOf("x-1")).shouldNotBeNull()
                    .rows_changed.shouldNotBeNull().asset_ids.shouldBeEmpty()
            }
        }
        machine.rowsChanged("blob", listOf("c-1")) shouldBe null
        // NO PERSON IS SEARCHED FOR, so a person or a face moves nothing here
        // (Q-1047-2).
        machine.rowsChanged("person", listOf("p-1")) shouldBe null
        machine.rowsChanged("media_asset", listOf("a-1")) shouldBe null
    }

    "the query is words, and a query of short words is matched whole" {
        // v0's `queryTokens`: lower-cased, split on anything that is not a
        // letter or a digit, one-letter words and the stop-list dropped.
        PhotosSearchReads.tokens("  ").shouldBeEmpty()
        PhotosSearchReads.tokens("The Coast road") shouldContainExactly listOf("coast", "road")
        // A FIRST KEYSTROKE IS NOT "NOTHING MATCHES": a query that is nothing
        // but short words is matched as typed.
        PhotosSearchReads.tokens("a") shouldContainExactly listOf("a")
    }

    "the hits read is the library's shelf, and what it reaches is binds" {
        val query = PhotosSearchReads.hitsQuery(Reach(assetIds = listOf("a-1", "a-2"))).shouldNotBeNull()
        query.from shouldBe "photo"
        val order = query.order.shouldNotBeNull()
        query.select.contains(order.sort_column) shouldBe true
        query.select.contains(order.pk_column) shouldBe true
        // THE SAME SHELF THE LIBRARY DRAWS: a search that reached archived or
        // trashed photographs would hand a member back what they put away.
        query.where_.shouldNotBeNull() shouldContain PhotoFold.LIVE
        // THE PHOTOGRAPHS THE CORE NAMED BY TEXT ARE BINDS AND NEVER TEXT IN THE
        // PREDICATE, and they are the only arm: the caption `LIKE` is the
        // door's now (#1097, R-1097-25).
        query.where_.shouldNotBeNull() shouldContain "id IN (?, ?)"
        query.where_.shouldNotBeNull().contains("LIKE") shouldBe false
        query.where_.shouldNotBeNull().contains("a-1") shouldBe false
        query.bind.map { it.text } shouldBe listOf("a-1", "a-2")
        query.with_held_thumbnail shouldBe true
        query.order.shouldNotBeNull().descending shouldBe true

        // WHAT THE DOORS MATCHED WIDENS THE GRID, by id and as binds: typing
        // "Tahoe" returns the album's photographs, not an empty grid under a
        // row saying the album exists (#712).
        val reached = PhotosSearchReads.hitsQuery(Reach(albumIds = listOf("al-1"))).shouldNotBeNull()
        reached.where_.shouldNotBeNull() shouldContain "rel = 'contains'"
        reached.bind.map { it.text }.contains("al-1") shouldBe true

        // NOTHING REACHED IS NO STATEMENT: an `OR` of no arms would read the
        // whole shelf.
        PhotosSearchReads.hitsQuery(Reach()) shouldBe null
    }

    "a wildcard the member typed is a character, not a wildcard" {
        // A member searching for `a_b` matches `arb` if this is left out. The
        // escape character is declared on the statement (`ESCAPE '\'`)
        // because SQLite has no default one.
        PhotosSearchReads.escapeLike("50%") shouldBe "50\\%"
        PhotosSearchReads.escapeLike("a_b") shouldBe "a\\_b"
        // THE BACKSLASH IS ESCAPED FIRST. Doing it last would escape the
        // backslashes this function had itself just written, turning one `%`
        // into an escaped backslash followed by a live wildcard.
        PhotosSearchReads.escapeLike("a\\%") shouldBe "a\\\\\\%"

        // `a_b` IS SHORT WORDS ONLY, so it is matched whole — and escaped. The
        // structured legs still match by `LIKE`; the text leg is the door's.
        val query = PhotosSearchReads.labelsQuery(PhotosSearchReads.tokens("a_b"))
        query.bind.map { it.text }.contains("%a\\_b%") shouldBe true
        query.where_.shouldNotBeNull() shouldContain "ESCAPE"
    }

    "one caption shared by two photographs is one reason, not two" {
        // A REASON LIST THAT REPEATED ITSELF is a list a member has to read
        // twice to learn one thing. The order is the page's, which is capture
        // order, so the reasons read in the same sequence as the grid.
        val found = hits(
            "harbour",
            listOf(
                assetRow("a-1", "2026-02-03T10:00:00Z"),
                assetRow("a-2", "2026-02-03T09:00:00Z"),
                assetRow("a-3", "2026-02-02T09:00:00Z"),
                // A photograph with no title is not a reason it can give: an
                // empty value would draw "Captions: " with nothing after it.
                assetRow("a-4", "2026-02-01T09:00:00Z"),
            ),
            titles = mapOf(
                "a-1" to "Harbour at dusk",
                "a-2" to "Harbour at dusk",
                "a-3" to "Harbour lights",
                "a-4" to "",
            ),
        ).data_.shouldNotBeNull().hits.shouldNotBeNull()
        found.matches.map { it.value_ } shouldContainExactly
            listOf("Harbour at dusk", "Harbour lights")
        found.cells.size shouldBe 4
    }

    "a second page appends cells and does not draw one twice" {
        val first = machine.reduce(
            machine.reduce(machine.initial(), typed("harbour")).state,
            hits("harbour", listOf(assetRow("a-1", "2026-02-03T10:00:00Z")), "2026-02-03T10:00:00Z|a-1"),
        ).state
        val second = machine.reduce(
            first,
            hits(
                "harbour",
                listOf(
                    // The boundary row, handed back by a keyset walk over a
                    // sort column that ties.
                    assetRow("a-1", "2026-02-03T10:00:00Z"),
                    assetRow("a-2", "2026-02-02T10:00:00Z"),
                ),
            ),
        ).state
        second.hits.shouldNotBeNull().cells.map { it.asset_id } shouldContainExactly
            listOf("a-1", "a-2")
    }

    "the field is the machine's: a corrected answer sets it, a new term or a clear takes it away" {
        // #1097, R-1097-27: the shared field draws "Including results for" from
        // `search.corrected`, so the machine has to own it through `SearchLaw`.
        val typing = machine.reduce(machine.initial(), typed("sunscren")).state
        typing.search.shouldNotBeNull().term shouldBe "sunscren"
        typing.search.shouldNotBeNull().corrected shouldBe ""

        val answered = machine.reduce(
            typing,
            PhotosSearchReads.hitsArrived(
                query = "sunscren",
                rows = listOf(assetRow("a-1", "2026-02-03T10:00:00Z")),
                nextCursor = null,
                topHits = emptyList(),
                labels = emptyList(),
                titles = mapOf("a-1" to "Sunscreen on the shelf"),
                corrected = "sunscreen",
            ),
        ).state
        answered.search.shouldNotBeNull().corrected shouldBe "sunscreen"
        // The typed words stay the screen's own, and the page is still for them.
        answered.query shouldBe "sunscren"
        // THE CAPTION IS A REASON FOR THE WORDS THE PAGE WAS READ FOR, not for
        // the typo: "sunscren" is not in the caption, "sunscreen" is.
        answered.hits.shouldNotBeNull().matches.map { it.value_ } shouldContainExactly
            listOf("Sunscreen on the shelf")

        // A NEW TERM SAYS WHAT THE LAST ANSWER CORRECTED NO MORE.
        machine.reduce(answered, typed("sunscreen")).state.search.shouldNotBeNull().corrected shouldBe ""
        // A CLEARED FIELD IS A CLOSED ONE.
        val cleared = machine.reduce(answered, typed("")).state
        cleared.search.shouldNotBeNull().corrected shouldBe ""
        cleared.search.shouldNotBeNull().term shouldBe ""
    }

    "Ask is the no-match question: a wholly empty current answer sets it and carries the action, and anything found, a new term, a denial or a clear takes it away (#1097, R-1097-28, R-1097-30)" {
        val typing = machine.reduce(machine.initial(), typed("zzqx")).state
        val none = machine.reduce(typing, hits("zzqx", emptyList())).state
        none.search.shouldNotBeNull().ask shouldBe "Find zzqx"
        // The no-match state is the machine's: the sentence and everywhere search looked, with Ask as its action.
        val empty = none.hits.shouldNotBeNull().empty.shouldNotBeNull()
        empty.headline shouldBe "No results"
        empty.body shouldBe "Nothing matches “zzqx”. Search covers captions, text in photos, places, labels and albums."
        empty.action_label shouldBe "Ask about “zzqx”"

        // A photograph is a result: no Ask, no no-match state.
        val found = machine.reduce(
            typing,
            hits("zzqx", listOf(assetRow("a-1", "2026-02-03T10:00:00Z"))),
        ).state
        found.search.shouldNotBeNull().ask shouldBe ""
        found.hits.shouldNotBeNull().empty shouldBe null
        // A new term, a clear and a refusal take the question away.
        machine.reduce(none, typed("zzq")).state.search.shouldNotBeNull().ask shouldBe ""
        machine.reduce(none, typed("")).state.search.shouldNotBeNull().ask shouldBe ""
        machine.reduce(
            none,
            PhotosSearchReads.refused(Reads.refused("The access plane said no.")),
        ).state.search.shouldNotBeNull().ask shouldBe ""
        // A late answer for a term the field has left sets none.
        val moved = machine.reduce(none, typed("zzqy")).state
        machine.reduce(moved, hits("zzqx", emptyList())).state.search.shouldNotBeNull().ask shouldBe ""
    }

    "a late corrected answer sets no correction, and a second page keeps it" {
        val asking = machine.reduce(machine.initial(), typed("sunscren")).state
        val corrected = PhotosSearchReads.hitsArrived(
            query = "sunscren",
            rows = listOf(assetRow("a-1", "2026-02-03T10:00:00Z")),
            nextCursor = "2026-02-03T10:00:00Z|a-1",
            topHits = emptyList(),
            labels = emptyList(),
            corrected = "sunscreen",
        )
        // The field has moved on: the page is dropped, and so is its correction.
        val moved = machine.reduce(asking, typed("sunscreen")).state
        machine.reduce(moved, corrected).state shouldBe moved

        val first = machine.reduce(asking, corrected).state
        first.search.shouldNotBeNull().corrected shouldBe "sunscreen"
        // The next page answers the same words and the line stays.
        val second = machine.reduce(
            first,
            PhotosSearchReads.hitsArrived(
                query = "sunscren",
                rows = listOf(assetRow("a-2", "2026-02-02T10:00:00Z")),
                nextCursor = null,
                topHits = emptyList(),
                labels = emptyList(),
                corrected = "sunscreen",
            ),
        ).state
        second.search.shouldNotBeNull().corrected shouldBe "sunscreen"
        second.hits.shouldNotBeNull().cells.size shouldBe 2
    }

    "albums are the core's container hits, in the door's rank order, three at most" {
        fun album(id: String, title: String) = ContainerHit(
            entity = "core.collection",
            id = id,
            title = title,
            app_id = "photos",
        )
        PhotosSearchReads.albums(
            listOf(
                album("al-2", "Tahoe 2025"),
                album("al-1", "Lake Tahoe"),
                album("al-3", "Tahoe winter"),
                album("al-4", "Tahoe spring"),
                album("", "No id"),
            ),
        ).map { it.id } shouldContainExactly listOf("al-2", "al-1", "al-3")
        // An album with no name is not a door.
        PhotosSearchReads.albums(listOf(album("al-9", "  "))).shouldBeEmpty()
    }

    "the photographs the core named reach the grid with the doors" {
        val reach = PhotosSearchReads.reach(emptyList(), emptyList(), assetIds = listOf("a-7", "a-8"))
        reach.assetIds shouldContainExactly listOf("a-7", "a-8")
        reach.isEmpty shouldBe false
        PhotosSearchReads.reach(emptyList(), emptyList()).isEmpty shouldBe true
    }
})
