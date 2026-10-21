package dev.centraid.shared

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.NotesHistory
import centraid.core.v1.NotesJournal
import centraid.core.v1.NotesJournalDay
import centraid.core.v1.NotesJournalEntry
import centraid.core.v1.NotesLibrary
import centraid.core.v1.NotesLinkTarget
import centraid.core.v1.NotesLinkTargets
import centraid.core.v1.NotesNotebook
import centraid.core.v1.NotesNotebooks
import centraid.core.v1.NotesRow
import centraid.core.v1.NotesSearch
import centraid.core.v1.NotesSearchHit
import centraid.core.v1.NotesSort
import centraid.core.v1.NotesTagFacet
import centraid.core.v1.NotesTrash
import centraid.core.v1.NotesVersion
import centraid.screen.v1.HomeTile
import centraid.screen.v1.NoteDraft
import centraid.screen.v1.NotesEditorEvent
import centraid.screen.v1.NotesEditorState
import centraid.screen.v1.NotesHistoryEvent
import centraid.screen.v1.NotesHistoryState
import centraid.screen.v1.NotesJournalEvent
import centraid.screen.v1.NotesLibraryEvent
import centraid.screen.v1.NotesLibrarySort
import centraid.screen.v1.NotesLibraryState
import centraid.screen.v1.NotesLinkPickerEvent
import centraid.screen.v1.NotesLinkTargetRow
import centraid.screen.v1.NotesNotebooksEvent
import centraid.screen.v1.TileBody
import centraid.screen.v1.TileStatus
import centraid.screen.v1.TrashListEvent
import centraid.screen.v1.WriteSettled
import centraid.screen.v1.WriteState
import dev.centraid.design.copy.NotesCopy
import dev.centraid.shared.apps.notes.NotesBand
import dev.centraid.shared.apps.notes.NotesEditorMachine
import dev.centraid.shared.apps.notes.NotesHistoryMachine
import dev.centraid.shared.apps.notes.NotesHistoryReads
import dev.centraid.shared.apps.notes.NotesJournalMachine
import dev.centraid.shared.apps.notes.NotesJournalReads
import dev.centraid.shared.apps.notes.NotesLibraryMachine
import dev.centraid.shared.apps.notes.NotesLibraryReads
import dev.centraid.shared.apps.notes.NotesLinkPickerMachine
import dev.centraid.shared.apps.notes.NotesLinkPickerReads
import dev.centraid.shared.apps.notes.NotesNotebooksMachine
import dev.centraid.shared.apps.notes.NotesNotebooksReads
import dev.centraid.shared.apps.notes.NotesRouting
import dev.centraid.shared.apps.notes.NotesTrashMachine
import dev.centraid.shared.apps.notes.NotesTrashReads
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavStack
import dev.centraid.shared.nav.applying
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.types.shouldBeInstanceOf

/**
 * NOTES, THE REST OF THE APP (#1029 port): library, notebooks, journal,
 * history, the powerbox, trash and the entry-point routing — over the core's
 * typed answers, with no core.
 */
class NotesAppSpec : StringSpec({
    val now = DeviceClock.Reading(zone = "Europe/Lisbon", epochMillis = 1_773_230_400_000)

    fun <S, E> ScreenMachine<S, E>.run(state: S, vararg events: E): Step<S> =
        events.fold(Step(state)) { step, event -> reduce(step.state, event) }

    fun row(id: String, title: String?, pinned: Boolean = false, notebook: String? = null) = NotesRow(
        note_id = id,
        title = title,
        pinned = pinned,
        updated_at = "2026-03-11T09:00:00.000Z",
        updated_local_day = "2026-03-11",
        preview = "first line of $id\nsecond",
        notebook_ids = listOfNotNull(notebook),
        notebook_names = listOfNotNull(notebook?.let { "Book $it" }),
    )

    fun libraryAnswer(vararg rows: NotesRow, truncated: Boolean = false) = listOf(
        AppQueryResponse(
            notes_library = NotesLibrary(
                notes = rows.toList(),
                tags = listOf(NotesTagFacet(concept_id = "c-1", label = "work")),
                truncated = truncated,
            ),
        ),
        AppQueryResponse(
            notes_notebooks = NotesNotebooks(
                notebooks = listOf(
                    NotesNotebook(notebook_id = "nb-1", name = "Recipes", note_count = 2),
                    // An EMPTY notebook. The core's read is `kind = 'notebook'`
                    // (rung six), so no album is ever in this answer, and a
                    // notebook with no notes is still a notebook.
                    NotesNotebook(notebook_id = "nb-2", name = "Empty"),
                ),
            ),
        ),
    )

    fun openedLibrary(): NotesLibraryState =
        NotesLibraryMachine.reduce(NotesLibraryMachine.initial(), NotesLibraryEvent(opened = NotesLibraryEvent.Opened())).state

    fun loadedLibrary(vararg rows: NotesRow): NotesLibraryState =
        NotesLibraryMachine.reduce(openedLibrary(), NotesLibraryReads.arrived(libraryAnswer(*rows))).state

    // --- Library -----------------------------------------------------------

    "library: opening reads the library and its notebooks, with the default sort" {
        val step = NotesLibraryMachine.reduce(NotesLibraryMachine.initial(), NotesLibraryEvent(opened = NotesLibraryEvent.Opened()))
        step.effects shouldBe listOf(ScreenEffect.ReadPage(NotesLibraryMachine.SCREEN_ID, null))
        step.state.loading.shouldNotBeNull()
        val asks = NotesLibraryReads.requests(step.state, now)
        asks.size shouldBe 2
        asks[0].notes_library.shouldNotBeNull().sort shouldBe NotesSort.NOTES_SORT_UPDATED
        asks[1].notes_notebooks.shouldNotBeNull()
        step.state.band.map { it.key } shouldBe listOf("notes", "notebooks", "journal", "more")
        step.state.band.single { it.current }.key shouldBe NotesBand.NOTES
    }

    "library: pinned lead in their own section, rows carry finished words" {
        val state = loadedLibrary(row("n-1", "Pinned one", pinned = true), row("n-2", null, notebook = "nb-1"))
        val data = state.data_.shouldNotBeNull()
        data.sections.map { it.head?.title } shouldBe listOf(NotesCopy.SECTION_PINNED, NotesCopy.SECTION_NOTES)
        val unnamed = data.sections[1].rows.single()
        // No title: the preview's first line.
        unnamed.title shouldBe "first line of n-2"
        unnamed.meta shouldBe "${NotesCopy.EDITED} Wed 11 March · Book nb-1"
        unnamed.notebook_id shouldBe "nb-1"
        data.count_label shouldBe "2 notes"
        data.empty.shouldBeNull()
        data.tags.single().label shouldBe "work"
    }

    "library: every notebook the core answers is offered for filing, an empty one included" {
        val state = loadedLibrary(row("n-1", "A"))
        state.notebooks.map { it.id } shouldBe listOf("nb-1", "nb-2")
        val filing = NotesLibraryMachine.reduce(state, NotesLibraryEvent(file_ = NotesLibraryEvent.FileRequested(note_id = "n-1"))).state
        filing.sheet shouldBe NotesLibraryState.Sheet.SHEET_FILE_INTO
        filing.choices.map { it.id } shouldBe listOf("", "nb-1", "nb-2")
        filing.choices.first().selected shouldBe true
    }

    "library: sort, pinned-only, tags and a wider window are the read's parameters" {
        val loaded = loadedLibrary(row("n-1", "A"))
        val sorted = NotesLibraryMachine.reduce(loaded, NotesLibraryEvent(sort = NotesLibraryEvent.SortPicked(sort = NotesLibrarySort.NOTES_LIBRARY_SORT_TITLE)))
        sorted.effects.single().shouldBeInstanceOf<ScreenEffect.ReadPage>()
        // THE ROWS STAY while the new order reads.
        sorted.state.data_.shouldNotBeNull()
        sorted.state.first_page_pending shouldBe true
        NotesLibraryReads.requests(sorted.state, now)[0].notes_library!!.sort shouldBe NotesSort.NOTES_SORT_TITLE

        val pinned = NotesLibraryMachine.run(
            sorted.state,
            NotesLibraryEvent(pinned_only = NotesLibraryEvent.PinnedOnlyToggled()),
            NotesLibraryEvent(tag = NotesLibraryEvent.TagToggled(concept_id = "c-1")),
            NotesLibraryEvent(window_widened = NotesLibraryEvent.WindowWidened()),
        ).state
        val ask = NotesLibraryReads.requests(pinned, now)[0].notes_library!!
        ask.pinned_only shouldBe true
        ask.tag_concept_ids shouldBe listOf("c-1")
        ask.window shouldBe 400
        pinned.data_!!.tags.single().selected shouldBe true
        // EVERY FILTER IS A CHIP, selected while it narrows.
        pinned.chips.filter { it.selected }.map { it.key } shouldBe listOf("pinned", "tag-c-1")

        // A selected chip clears itself.
        val cleared = NotesLibraryMachine.run(
            pinned,
            NotesLibraryEvent(chip = NotesLibraryEvent.ChipPicked(key = "pinned")),
            NotesLibraryEvent(chip = NotesLibraryEvent.ChipPicked(key = "tag-c-1")),
        ).state
        cleared.chips.none { it.selected } shouldBe true
        NotesLibraryReads.requests(cleared, now)[0].notes_library!!.pinned_only shouldBe false
        NotesLibraryReads.requests(cleared, now)[0].notes_library!!.tag_concept_ids.shouldBeEmpty()
    }

    "library: ONE chip row — Pinned, the tags, then the sort, last, wearing the current order" {
        val loaded = loadedLibrary(row("n-1", "A"))
        loaded.chips.map { it.key } shouldBe listOf("pinned", "tag-c-1", "sort")
        loaded.chips.map { it.label } shouldBe listOf(NotesCopy.CHIP_PINNED, "work", NotesCopy.SORT_UPDATED)
        val sort = loaded.chips.last()
        sort.chevron shouldBe true
        sort.spoken shouldBe "Sort, ${NotesCopy.SORT_UPDATED}"
        loaded.chips.dropLast(1).none { it.chevron } shouldBe true

        // The sort chip opens the sort sheet; a choice re-reads and renames the chip.
        val sheet = NotesLibraryMachine.reduce(loaded, NotesLibraryEvent(chip = NotesLibraryEvent.ChipPicked(key = "sort")))
        sheet.effects.shouldBeEmpty()
        sheet.state.sheet shouldBe NotesLibraryState.Sheet.SHEET_SORT
        sheet.state.choices.single { it.selected }.sort shouldBe NotesLibrarySort.NOTES_LIBRARY_SORT_UPDATED
        val byTitle = NotesLibraryMachine.reduce(
            sheet.state,
            NotesLibraryEvent(sort = NotesLibraryEvent.SortPicked(sort = NotesLibrarySort.NOTES_LIBRARY_SORT_TITLE)),
        ).state
        byTitle.sheet shouldBe NotesLibraryState.Sheet.SHEET_NONE
        byTitle.chips.last().label shouldBe NotesCopy.SORT_TITLE_AZ
        byTitle.chips.last().spoken shouldBe "Sort, ${NotesCopy.SORT_TITLE_AZ}"

        // No chip row over search: no filter narrows its results.
        NotesLibraryMachine.reduce(loaded, NotesLibraryEvent(search_opened = NotesLibraryEvent.SearchOpened())).state.chips.shouldBeEmpty()
        // An unknown key is nothing.
        NotesLibraryMachine.reduce(loaded, NotesLibraryEvent(chip = NotesLibraryEvent.ChipPicked(key = "nope"))).state shouldBe loaded
    }

    "library: opened on a notebook, its chip leads, selected, and a tap widens to every note" {
        val opened = NotesLibraryMachine.reduce(
            NotesLibraryMachine.initial(),
            NotesLibraryEvent(opened = NotesLibraryEvent.Opened(notebook_id = "nb-1", notebook_name = "Recipes")),
        ).state
        val loaded = NotesLibraryMachine.reduce(opened, NotesLibraryReads.arrived(libraryAnswer(row("n-1", "A")))).state
        loaded.chips.first().let {
            it.key shouldBe "notebook"
            it.label shouldBe "Recipes"
            it.selected shouldBe true
        }
        val widened = NotesLibraryMachine.reduce(loaded, NotesLibraryEvent(chip = NotesLibraryEvent.ChipPicked(key = "notebook")))
        widened.effects.single().shouldBeInstanceOf<ScreenEffect.ReadPage>()
        widened.state.heading shouldBe NotesCopy.TITLE
        widened.state.chips.map { it.key } shouldBe listOf("pinned", "tag-c-1", "sort")
        NotesLibraryReads.requests(widened.state, now)[0].notes_library!!.notebook_id shouldBe ""
    }

    "library: opened on a notebook reads it, heads with its name" {
        val state = NotesLibraryMachine.reduce(
            NotesLibraryMachine.initial(),
            NotesLibraryEvent(opened = NotesLibraryEvent.Opened(notebook_id = "nb-1", notebook_name = "Recipes")),
        ).state
        state.heading shouldBe "Recipes"
        NotesLibraryReads.requests(state, now)[0].notes_library!!.notebook_id shouldBe "nb-1"
        val empty = NotesLibraryMachine.reduce(state, NotesLibraryReads.arrived(libraryAnswer())).state
        empty.data_!!.empty!!.body shouldBe NotesCopy.EMPTY_NOTEBOOK_BODY
    }

    "library: day one is one sentence and one action that writes" {
        val state = loadedLibrary()
        val empty = state.data_!!.empty.shouldNotBeNull()
        empty.headline shouldBe NotesCopy.EMPTY_DAY_ONE_HEADLINE
        empty.action_label shouldBe NotesCopy.NEW_NOTE
        state.data_.sections.shouldBeEmpty()
        // Filtered to nothing is not day one.
        val filtered = NotesLibraryMachine.run(
            state,
            NotesLibraryEvent(pinned_only = NotesLibraryEvent.PinnedOnlyToggled()),
            NotesLibraryReads.arrived(libraryAnswer()),
        ).state
        filtered.data_!!.empty!!.body shouldBe NotesCopy.EMPTY_FILTERED_BODY
    }

    "library: a truncated window offers to show older" {
        val state = NotesLibraryMachine.reduce(openedLibrary(), NotesLibraryReads.arrived(libraryAnswer(row("n-1", "A"), truncated = true))).state
        state.data_!!.window_end_verb shouldBe NotesCopy.WINDOW_END_VERB
    }

    "library: row menu pins at once, files, and trashes only after a confirm" {
        val state = loadedLibrary(row("n-1", "A"))
        val menu = NotesLibraryMachine.reduce(state, NotesLibraryEvent(row_menu = NotesLibraryEvent.RowMenuOpened(note_id = "n-1"))).state
        menu.menu!!.pin_label shouldBe NotesCopy.PIN

        val pin = NotesLibraryMachine.reduce(menu, NotesLibraryEvent(pin = NotesLibraryEvent.PinToggled(note_id = "n-1")))
        val pinWrite = pin.effects.single() as ScreenEffect.SubmitWrite
        pinWrite.command shouldBe "knowledge.edit_note"
        pinWrite.inputJson shouldBe "{\"note_id\":\"n-1\",\"pinned\":1}"
        pin.state.sheet shouldBe NotesLibraryState.Sheet.SHEET_NONE
        pin.state.write!!.phase shouldBe WriteState.Phase.PHASE_IN_FLIGHT

        val filed = NotesLibraryMachine.run(
            state,
            NotesLibraryEvent(file_ = NotesLibraryEvent.FileRequested(note_id = "n-1")),
            NotesLibraryEvent(notebook_chosen = NotesLibraryEvent.NotebookChosen(notebook_id = "nb-1")),
        )
        (filed.effects.single() as ScreenEffect.SubmitWrite).let {
            it.command shouldBe "knowledge.move_note"
            it.inputJson shouldBe "{\"note_id\":\"n-1\",\"notebook_id\":\"nb-1\"}"
        }

        val asked = NotesLibraryMachine.reduce(state, NotesLibraryEvent(trash = NotesLibraryEvent.TrashRequested(note_id = "n-1")))
        asked.effects.shouldBeEmpty()
        asked.state.confirm!!.destructive shouldBe true
        val trashed = NotesLibraryMachine.reduce(asked.state, NotesLibraryEvent(confirmed = NotesLibraryEvent.Confirmed()))
        (trashed.effects.single() as ScreenEffect.SubmitWrite).command shouldBe "knowledge.delete_note"
        trashed.state.confirm.shouldBeNull()
        // A REFUSED WRITE KEEPS THE ROWS, with the sentence on the write.
        val key = trashed.state.write!!.invoke_key
        val refused = NotesLibraryMachine.reduce(
            trashed.state,
            NotesLibraryEvent(write_settled = WriteSettled(invoke_key = key, committed = false, failure = centraid.screen.v1.ReadFailure(sentence = "No."))),
        ).state
        refused.write!!.phase shouldBe WriteState.Phase.PHASE_REFUSED
        refused.data_.shouldNotBeNull()
    }

    "library: search is a field, reads notes.search, marks matches, and close restores the library without a read" {
        val state = loadedLibrary(row("n-1", "A"))
        val open = NotesLibraryMachine.reduce(state, NotesLibraryEvent(search_opened = NotesLibraryEvent.SearchOpened()))
        open.effects.shouldBeEmpty()
        open.state.results!!.empty!!.body shouldBe NotesCopy.SEARCH_EMPTY
        val typed = NotesLibraryMachine.reduce(open.state, NotesLibraryEvent(search_term = NotesLibraryEvent.SearchTermChanged(term = "milk")))
        typed.effects.single().shouldBeInstanceOf<ScreenEffect.ReadPage>()
        val asks = NotesLibraryReads.requests(typed.state, now)
        asks.single().notes_search!!.term shouldBe "milk"
        val hit = NotesSearchHit(note_id = "n-1", title = "A", preview = "buy milk", snippet = "buy ⟦milk⟧ today")
        val answered = NotesLibraryMachine.reduce(
            typed.state,
            NotesLibraryReads.arrived(listOf(AppQueryResponse(notes_search = NotesSearch(hits = listOf(hit))))),
        ).state
        val runs = answered.results!!.rows.single().snippet_runs
        runs.map { it.text to it.highlighted } shouldBe listOf("buy " to false, "milk" to true, " today" to false)
        answered.search!!.answered_term shouldBe "milk"
        val none = NotesLibraryMachine.reduce(
            typed.state,
            NotesLibraryReads.arrived(listOf(AppQueryResponse(notes_search = NotesSearch()))),
        ).state
        none.results!!.empty!!.headline shouldBe NotesCopy.SEARCH_NO_MATCH_HEADLINE
        val closed = NotesLibraryMachine.reduce(answered, NotesLibraryEvent(search_closed = NotesLibraryEvent.SearchClosed()))
        closed.effects.shouldBeEmpty()
        closed.state.results.shouldBeNull()
        closed.state.search!!.term shouldBe ""
        closed.state.data_.shouldNotBeNull()
    }

    "library: the words the core corrected are on the field, a new term clears them, and an answer for a closed search draws none (#1097)" {
        val state = loadedLibrary(row("n-1", "A"))
        val open = NotesLibraryMachine.reduce(state, NotesLibraryEvent(search_opened = NotesLibraryEvent.SearchOpened()))
        val typed = NotesLibraryMachine.reduce(open.state, NotesLibraryEvent(search_term = NotesLibraryEvent.SearchTermChanged(term = "mlik"))).state
        val hit = NotesSearchHit(note_id = "n-1", title = "A", preview = "buy milk", snippet = "buy ⟦milk⟧ today")
        val corrected = NotesLibraryReads.arrived(listOf(AppQueryResponse(notes_search = NotesSearch(hits = listOf(hit), corrected = "milk"))))
        val fixed = NotesLibraryMachine.reduce(typed, corrected).state
        fixed.search!!.corrected shouldBe "milk"
        // An exact answer says nothing was corrected.
        NotesLibraryMachine.reduce(typed, NotesLibraryReads.arrived(listOf(AppQueryResponse(notes_search = NotesSearch(hits = listOf(hit))))))
            .state.search!!.corrected shouldBe ""
        // A NEW TERM clears it.
        NotesLibraryMachine.reduce(fixed, NotesLibraryEvent(search_term = NotesLibraryEvent.SearchTermChanged(term = "mli")))
            .state.search!!.corrected shouldBe ""
        // AN ANSWER FOR A SEARCH CLOSED SINCE draws none.
        val closed = NotesLibraryMachine.reduce(typed, NotesLibraryEvent(search_closed = NotesLibraryEvent.SearchClosed())).state
        NotesLibraryMachine.reduce(closed, corrected).state.search!!.corrected shouldBe ""
        NotesLibraryMachine.reduce(fixed, NotesLibraryEvent(search_closed = NotesLibraryEvent.SearchClosed()))
            .state.search!!.corrected shouldBe ""
    }

    "library: a notebook found by name is a container on the field, with no nothing-found over it, cleared by a new term or a close, and a stale answer sets none (#1097)" {
        val state = loadedLibrary(row("n-1", "A"))
        val open = NotesLibraryMachine.reduce(state, NotesLibraryEvent(search_opened = NotesLibraryEvent.SearchOpened()))
        val typed = NotesLibraryMachine.reduce(open.state, NotesLibraryEvent(search_term = NotesLibraryEvent.SearchTermChanged(term = "cabin"))).state
        val notebook = centraid.core.v1.ContainerHit(entity = "core.collection", id = "nb-1", title = "Cabin", app_id = "notes")
        val answer = NotesLibraryReads.arrived(listOf(AppQueryResponse(notes_search = NotesSearch(containers = listOf(notebook)))))
        val found = NotesLibraryMachine.reduce(typed, answer).state
        val container = found.search!!.containers.single()
        container.entity shouldBe "core.collection"
        container.kind_label shouldBe "Notebook"
        container.target shouldBe centraid.screen.v1.ChatCard(app = "notes", entity = "notebook", id = "nb-1", title = "Cabin")
        // A notebook that matched is an answer: rows are empty and the sentence is not drawn.
        found.results!!.rows.shouldBeEmpty()
        found.results.empty.shouldBeNull()
        // A NEW TERM clears it; a close clears it; an answer for a closed search sets none.
        NotesLibraryMachine.reduce(found, NotesLibraryEvent(search_term = NotesLibraryEvent.SearchTermChanged(term = "cabi")))
            .state.search!!.containers.shouldBeEmpty()
        NotesLibraryMachine.reduce(found, NotesLibraryEvent(search_closed = NotesLibraryEvent.SearchClosed()))
            .state.search!!.containers.shouldBeEmpty()
        val closed = NotesLibraryMachine.reduce(typed, NotesLibraryEvent(search_closed = NotesLibraryEvent.SearchClosed())).state
        NotesLibraryMachine.reduce(closed, answer).state.search!!.containers.shouldBeEmpty()
    }

    "library: Ask is the no-match question: set by a wholly empty current answer, cleared by a new term, a close, a denial or a stale answer, and never set when anything was found (#1097, R-1097-28)" {
        val state = loadedLibrary(row("n-1", "A"))
        val open = NotesLibraryMachine.reduce(state, NotesLibraryEvent(search_opened = NotesLibraryEvent.SearchOpened()))
        val typed = NotesLibraryMachine.reduce(open.state, NotesLibraryEvent(search_term = NotesLibraryEvent.SearchTermChanged(term = "zzqx"))).state
        fun answer(search: NotesSearch) = NotesLibraryReads.arrived(listOf(AppQueryResponse(notes_search = search)))
        val none = NotesLibraryMachine.reduce(typed, answer(NotesSearch())).state
        none.search!!.ask shouldBe "Find zzqx"
        none.results!!.empty!!.action_label shouldBe "Ask about “zzqx”"
        // Anything found is no Ask: a note, or a notebook.
        val hit = NotesSearchHit(note_id = "n-1", title = "A", preview = "p", snippet = "p")
        NotesLibraryMachine.reduce(typed, answer(NotesSearch(hits = listOf(hit)))).state.search!!.ask shouldBe ""
        val notebook = centraid.core.v1.ContainerHit(entity = "core.collection", id = "nb-1", title = "Cabin", app_id = "notes")
        NotesLibraryMachine.reduce(typed, answer(NotesSearch(containers = listOf(notebook)))).state.search!!.ask shouldBe ""
        // A new term, a close and a denial clear it; an answer for a closed search sets none.
        NotesLibraryMachine.reduce(none, NotesLibraryEvent(search_term = NotesLibraryEvent.SearchTermChanged(term = "zzq")))
            .state.search!!.ask shouldBe ""
        NotesLibraryMachine.reduce(none, NotesLibraryEvent(search_closed = NotesLibraryEvent.SearchClosed()))
            .state.search!!.ask shouldBe ""
        NotesLibraryMachine.reduce(none, NotesLibraryReads.denied(AppQueryDenial(message = "revoked"))).state.search!!.ask shouldBe ""
        val closed = NotesLibraryMachine.reduce(typed, NotesLibraryEvent(search_closed = NotesLibraryEvent.SearchClosed())).state
        NotesLibraryMachine.reduce(closed, answer(NotesSearch())).state.search!!.ask shouldBe ""
    }

    "library: a change while searching re-reads the search, and the library on close" {
        val searching = NotesLibraryMachine.run(
            loadedLibrary(row("n-1", "A")),
            NotesLibraryEvent(search_opened = NotesLibraryEvent.SearchOpened()),
            NotesLibraryEvent(search_term = NotesLibraryEvent.SearchTermChanged(term = "x")),
        ).state
        val changed = NotesLibraryMachine.reduce(searching, NotesLibraryMachine.rowsChanged("knowledge_note", emptyList())!!)
        changed.effects.single().shouldBeInstanceOf<ScreenEffect.ReadPage>()
        changed.state.library_stale shouldBe true
        val closed = NotesLibraryMachine.reduce(changed.state, NotesLibraryEvent(search_closed = NotesLibraryEvent.SearchClosed()))
        closed.effects.single().shouldBeInstanceOf<ScreenEffect.ReadPage>()
        NotesLibraryReads.requests(closed.state, now)[0].notes_library.shouldNotBeNull()
    }

    "library: rows_changed re-reads on its tables only, keeping the rows drawn" {
        val state = loadedLibrary(row("n-1", "A"))
        NotesLibraryMachine.rowsChanged("locker_item", emptyList()).shouldBeNull()
        val step = NotesLibraryMachine.reduce(state, NotesLibraryMachine.rowsChanged("core_collection_entry", listOf("k"))!!)
        step.effects.single().shouldBeInstanceOf<ScreenEffect.ReadPage>()
        step.state.data_.shouldNotBeNull()
    }

    "library: denied is the gate, with no band" {
        val state = NotesLibraryMachine.reduce(openedLibrary(), NotesLibraryReads.denied(AppQueryDenial(message = "revoked"))).state
        state.denied!!.title shouldBe NotesCopy.DENIED_TITLE
        state.band.shouldBeEmpty()
        state.chips.shouldBeEmpty()
        state.more_rows.shouldBeEmpty()
        state.data_.shouldBeNull()
    }

    "library: More is a sheet, the same tab is nothing, another tab is the shell's" {
        val state = loadedLibrary(row("n-1", "A"))
        val more = NotesLibraryMachine.reduce(state, NotesLibraryEvent(band = NotesLibraryEvent.BandPicked(key = "more"))).state
        more.sheet shouldBe NotesLibraryState.Sheet.SHEET_MORE
        // MORE HOLDS TRASH ALONE: never search, sort or a filter (R-CHROME-4).
        more.more_rows.map { it.key to it.label } shouldBe listOf(NotesLibraryMachine.MORE_TRASH to NotesCopy.TRASH_LABEL)
        // A row closes the sheet; where it leads is the shell's.
        val picked = NotesLibraryMachine.reduce(more, NotesLibraryEvent(more_row = NotesLibraryEvent.MoreRowPicked(key = "trash")))
        picked.effects.shouldBeEmpty()
        picked.state.sheet shouldBe NotesLibraryState.Sheet.SHEET_NONE
        // More is an ordinary band tab, last, on the catalog's glyph.
        state.band.last().let {
            it.key shouldBe NotesBand.MORE
            it.icon_key shouldBe "MoreHoriz"
        }
        val same = NotesLibraryMachine.reduce(state, NotesLibraryEvent(band = NotesLibraryEvent.BandPicked(key = "notes")))
        same.effects.shouldBeEmpty()
        same.state shouldBe state
        // Another place swaps the top entry; the same place and More move nothing.
        val stack = NavStack().push(Destination.NotesLibrary())
        val journal = NotesRouting.library(NotesLibraryEvent(band = NotesLibraryEvent.BandPicked(key = NotesBand.JOURNAL)))!!
        stack.applying(journal).entries shouldBe listOf(Destination.Home, Destination.NotesJournal)
        NotesRouting.library(NotesLibraryEvent(band = NotesLibraryEvent.BandPicked(key = NotesBand.MORE))).shouldBeNull()
        NotesRouting.library(NotesLibraryEvent(band = NotesLibraryEvent.BandPicked(key = NotesBand.NOTES))).shouldBeNull()
    }

    // --- Notebooks ---------------------------------------------------------

    "notebooks: counts in words, Unfiled first, every answered notebook listed, create is a write" {
        val opened = NotesNotebooksMachine.reduce(NotesNotebooksMachine.initial(), NotesNotebooksEvent(opened = NotesNotebooksEvent.Opened()))
        NotesNotebooksReads.requests(opened.state, now).single().notes_notebooks.shouldNotBeNull()
        val loaded = NotesNotebooksMachine.reduce(opened.state, NotesNotebooksReads.arrived(libraryAnswer().drop(1))).state
        val rows = loaded.data_!!.rows
        rows.map { it.title } shouldBe listOf(NotesCopy.UNFILED_ROW, "Recipes", "Empty")
        rows[1].trailing shouldBe "2 notes"
        rows[2].trailing shouldBe "0 notes"

        val typing = NotesNotebooksMachine.run(
            loaded,
            NotesNotebooksEvent(create_opened = NotesNotebooksEvent.CreateOpened()),
            NotesNotebooksEvent(name = NotesNotebooksEvent.NameEdited(name = "  ")),
        ).state
        typing.create_enabled shouldBe false
        val named = NotesNotebooksMachine.reduce(typing, NotesNotebooksEvent(name = NotesNotebooksEvent.NameEdited(name = "Trips"))).state
        named.create_enabled shouldBe true
        val created = NotesNotebooksMachine.reduce(named, NotesNotebooksEvent(create_confirmed = NotesNotebooksEvent.CreateConfirmed()))
        val write = created.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "knowledge.create_notebook"
        write.inputJson shouldBe "{\"name\":\"Trips\"}"
        created.state.create_enabled shouldBe false
        val done = NotesNotebooksMachine.reduce(
            created.state,
            NotesNotebooksEvent(write_settled = WriteSettled(invoke_key = write.invokeKey, committed = true)),
        ).state
        done.creating shouldBe false
        done.draft_name shouldBe ""
        // THE COMMIT ENDS THE SITTING (#1089): the name is spent, so a second Create files no second notebook.
        NotesNotebooksMachine.reduce(done, NotesNotebooksEvent(create_confirmed = NotesNotebooksEvent.CreateConfirmed()))
            .effects.shouldBeEmpty()
    }

    "notebooks: the Unfiled row carries the core's count, and says when it is of the window only (#1047)" {
        fun unfiled(answer: NotesNotebooks) = NotesNotebooksMachine.reduce(
            NotesNotebooksMachine.initial(),
            NotesNotebooksReads.arrived(listOf(AppQueryResponse(notes_notebooks = answer))),
        ).state.data_!!.rows.first()
        unfiled(NotesNotebooks(unfiled_count = 1)).let {
            it.title shouldBe NotesCopy.UNFILED_ROW
            it.trailing shouldBe "1 note"
            it.accessibility_label shouldBe "${NotesCopy.UNFILED_ROW}, 1 note"
        }
        unfiled(NotesNotebooks(unfiled_count = 200, unfiled_truncated = true)).trailing shouldBe "200+ notes"
    }

    "dates are the member's: Edited, a search hit and a trashed note read the core's local day (#1047)" {
        // 23:30 UTC on the 11th is the 12th in the member's zone.
        val row = row("n-1", "Late").copy(updated_at = "2026-03-11T23:30:00Z", updated_local_day = "2026-03-12")
        loadedLibrary(row).data_!!.sections.flatMap { it.rows }.single().meta shouldBe "${NotesCopy.EDITED} Thu 12 March"
        // No zone resolved: no day at all — never the instant's UTC one.
        loadedLibrary(row.copy(updated_local_day = "")).data_!!.sections.flatMap { it.rows }.single().meta shouldBe ""
        val searching = NotesLibraryMachine.run(
            openedLibrary(),
            NotesLibraryEvent(search_opened = NotesLibraryEvent.SearchOpened()),
            NotesLibraryEvent(search_term = NotesLibraryEvent.SearchTermChanged(term = "late")),
        ).state
        NotesLibraryReads.requests(searching, now).single().notes_search!!.tz shouldBe "Europe/Lisbon"
        val hit = NotesSearchHit(note_id = "n-1", title = "Late", updated_at = "2026-03-11T23:30:00Z", updated_local_day = "2026-03-12")
        NotesLibraryMachine.reduce(searching, NotesLibraryReads.arrived(listOf(AppQueryResponse(notes_search = NotesSearch(hits = listOf(hit))))))
            .state.results!!.rows.single().meta shouldBe "${NotesCopy.EDITED} Thu 12 March"
        val trashed = NotesTrashReads.arrived(
            listOf(
                AppQueryResponse(
                    notes_trash = NotesTrash(
                        notes = listOf(row.copy(deleted_at = "2026-03-11T23:30:00Z", deleted_local_day = "2026-03-12")),
                    ),
                ),
            ),
        )
        trashed.data_!!.data_!!.rows.single().meta shouldBe "Deleted Thu 12 March"
    }

    "powerbox: a subtitle is a clean excerpt or the core's local day in words, never a raw column or a UTC slice (#1047)" {
        fun sub(raw: String, day: String = "", entity: String = "core.event") =
            NotesLinkPickerMachine.subtitleOf(NotesLinkTarget(entity = entity, subtitle = raw, subtitle_local_day = day, app_id = "agenda"))
        // 23:30Z on 11 March is 12 March east of UTC: the core's day wins, never the date part.
        sub("2026-03-11T23:30:00Z", day = "2026-03-12") shouldBe "Thu 12 March"
        sub("2026-03-11", day = "2026-03-11") shouldBe "Wed 11 March"
        sub("2026-03-11 09:00:00", day = "2026-03-11") shouldBe "Wed 11 March"
        // A when the core could not place (no zone): what it is, not a sliced date.
        sub("2026-03-11T09:00:00Z") shouldBe NotesCopy.LINK_KIND_EVENT
        sub("\n## **Plans** for [[Ana]]\n- more", entity = "knowledge.note") shouldBe "Plans for Ana"
        sub("- [ ] call the [bank](https://x.example) `today`", entity = "schedule.task") shouldBe "call the bank today"
        sub("2026-03-11 standup notes", entity = "knowledge.note") shouldBe "2026-03-11 standup notes"
        sub("snake_case stays") shouldBe "snake_case stays"
        sub("People") shouldBe "People"
        sub("x".repeat(100)) shouldBe "x".repeat(80) + "…"
        val folded = NotesLinkPickerMachine.fold(
            listOf(
                NotesLinkTarget(
                    entity = "core.event", id = "e-1", title = "Dentist", subtitle = "2026-03-11T09:00:00Z",
                    subtitle_local_day = "2026-03-11", app_id = "agenda",
                ),
            ),
        )
        folded.domains.single().rows.single().let {
            it.subtitle shouldBe "Wed 11 March"
            it.accessibility_label shouldBe "Dentist, Wed 11 March, ${NotesCopy.DOMAIN_EVENTS}"
        }
        val state = NotesLinkPickerMachine.initial().copy(term = "den")
        NotesLinkPickerReads.requests(state, now).single().notes_link_targets!!.tz shouldBe now.zone
    }

    "powerbox: a row whose subtitle is only its app key says what it is, never \"photos\" or \"docs\" (#1047)" {
        val folded = NotesLinkPickerMachine.fold(
            listOf(
                NotesLinkTarget(entity = "core.document", id = "d-1", title = "Lease", subtitle = "docs", app_id = "docs"),
                NotesLinkTarget(entity = "core.content_item", id = "p-1", title = "Beach", subtitle = "photos", app_id = "photos"),
                NotesLinkTarget(entity = "some.thing", id = "o-1", title = "Odd", subtitle = "elsewhere", app_id = "elsewhere"),
            ),
        )
        folded.domains.map { it.head!!.title to it.rows.single().subtitle } shouldBe listOf(
            NotesCopy.DOMAIN_DOCS to NotesCopy.LINK_KIND_DOCUMENT,
            NotesCopy.DOMAIN_PHOTOS to NotesCopy.LINK_KIND_PHOTOGRAPH,
            NotesCopy.DOMAIN_OTHER to "",
        )
        // A REAL subtitle that is not the app key still reads as itself.
        NotesLinkPickerMachine.fold(
            listOf(NotesLinkTarget(entity = "knowledge.note", id = "n-2", title = "Plans", subtitle = "Call Ana", app_id = "notes")),
        ).domains.single().rows.single().subtitle shouldBe "Call Ana"
    }

    "notebooks: no notebook is one sentence and the create action" {
        val loaded = NotesNotebooksMachine.reduce(
            NotesNotebooksMachine.initial(),
            NotesNotebooksReads.arrived(listOf(AppQueryResponse(notes_notebooks = NotesNotebooks()))),
        ).state
        loaded.data_!!.empty!!.action_label shouldBe NotesCopy.NEW_NOTEBOOK
        loaded.band.single { it.current }.key shouldBe NotesBand.NOTEBOOKS
        NotesNotebooksMachine.reduce(loaded, NotesNotebooksEvent(band = NotesNotebooksEvent.BandPicked(key = "more"))).state.more_open shouldBe true
    }

    // --- Journal -----------------------------------------------------------

    "journal: the core's local days, in words, newest first; new entry carries today" {
        val opened = NotesJournalMachine.reduce(NotesJournalMachine.initial(), NotesJournalEvent(opened = NotesJournalEvent.Opened())).state
        NotesJournalReads.requests(opened, now).single().notes_journal!!.tz shouldBe "Europe/Lisbon"
        val journal = NotesJournal(
            today = "2026-03-11",
            days = listOf(
                NotesJournalDay(
                    day = "2026-03-11",
                    entries = listOf(NotesJournalEntry(note_id = "j-1", title = "Met Ana", created_at = "x", local_time = "09:30", preview = "")),
                ),
                NotesJournalDay(
                    day = "2026-03-10",
                    entries = listOf(NotesJournalEntry(note_id = "j-2", created_at = "x", local_time = "18:05", preview = "Call\nmore")),
                ),
                NotesJournalDay(day = "2026-03-02", entries = listOf(NotesJournalEntry(note_id = "j-3", created_at = "x", preview = "p"))),
            ),
        )
        val loaded = NotesJournalMachine.reduce(opened, NotesJournalReads.arrived(listOf(AppQueryResponse(notes_journal = journal)))).state
        val days = loaded.data_!!.days
        days.map { it.head!!.title } shouldBe listOf("Today", "Yesterday", "Mon 2 March")
        days[0].rows.single().meta shouldBe "09:30"
        days[1].rows.single().title shouldBe "Call"
        loaded.data_.today shouldBe "2026-03-11"
        loaded.chrome!!.new_entry shouldBe NotesCopy.NEW_ENTRY
        val empty = NotesJournalMachine.reduce(opened, NotesJournalReads.arrived(listOf(AppQueryResponse(notes_journal = NotesJournal(today = "2026-03-11"))))).state
        empty.data_!!.empty!!.headline shouldBe NotesCopy.JOURNAL_EMPTY_HEADLINE
    }

    "journal: new entry opens the sheet, and Save is People's journal command dated that day (#1047)" {
        val opened = NotesJournalMachine.reduce(NotesJournalMachine.initial(), NotesJournalEvent(opened = NotesJournalEvent.Opened())).state
        // No answer yet: no day to date it by, so nothing opens.
        NotesJournalMachine.reduce(opened, NotesJournalEvent(new_entry = NotesJournalEvent.NewEntryRequested())).state.compose shouldBe null
        val loaded = NotesJournalMachine.reduce(
            opened,
            NotesJournalReads.arrived(listOf(AppQueryResponse(notes_journal = NotesJournal(today = "2026-03-11")))),
        ).state
        val composing = NotesJournalMachine.reduce(loaded, NotesJournalEvent(new_entry = NotesJournalEvent.NewEntryRequested(day = "2026-03-11")))
        composing.effects.shouldBeEmpty()
        composing.state.compose!!.let {
            it.day shouldBe "2026-03-11"
            it.title shouldBe NotesCopy.NEW_ENTRY
            it.mood_placeholder shouldBe NotesCopy.JOURNAL_MOOD
            it.text_placeholder shouldBe NotesCopy.JOURNAL_LINE
            it.save shouldBe NotesCopy.JOURNAL_SAVE
            it.can_save shouldBe false
        }
        // Save with an empty field is nothing.
        NotesJournalMachine.reduce(composing.state, NotesJournalEvent(compose_saved = NotesJournalEvent.ComposeSaved())).effects.shouldBeEmpty()
        val typed = NotesJournalMachine.reduce(
            composing.state,
            NotesJournalEvent(compose_edited = NotesJournalEvent.ComposeEdited(mood = "Good", text = "Lunch with \"Ana\"")),
        ).state
        typed.compose!!.can_save shouldBe true
        val saving = NotesJournalMachine.reduce(typed, NotesJournalEvent(compose_saved = NotesJournalEvent.ComposeSaved()))
        saving.effects.filterIsInstance<ScreenEffect.SubmitWrite>().single().let {
            it.command shouldBe "people.add_journal_entry"
            it.inputJson shouldBe """{"mood":"Good","text":"Lunch with \"Ana\"","entry_date":"2026-03-11"}"""
        }
        saving.state.compose!!.saving shouldBe true
        saving.state.compose.can_save shouldBe false
        // While in flight the sheet stays.
        NotesJournalMachine.reduce(saving.state, NotesJournalEvent(compose_closed = NotesJournalEvent.ComposeClosed())).state.compose shouldNotBe null
        val key = saving.state.write!!.invoke_key
        val refused = NotesJournalMachine.reduce(
            saving.state,
            NotesJournalEvent(write_settled = WriteSettled(invoke_key = key, committed = false, failure = Reads.refused("The vault is full."))),
        ).state
        refused.compose!!.status_label shouldBe "The vault is full."
        refused.compose.can_save shouldBe true
        val filed = NotesJournalMachine.reduce(saving.state, NotesJournalEvent(write_settled = WriteSettled(invoke_key = key, committed = true)))
            .state
        filed.compose shouldBe null
        // THE COMMIT ENDS THE SITTING (#1089): the sheet is gone, so a second Save files no second entry.
        NotesJournalMachine.reduce(filed, NotesJournalEvent(compose_saved = NotesJournalEvent.ComposeSaved())).effects.shouldBeEmpty()
        NotesJournalMachine.reduce(refused, NotesJournalEvent(compose_closed = NotesJournalEvent.ComposeClosed())).state.compose shouldBe null
    }

    "the journal's new entry states the zone the day was read in, so east of UTC+11:59 today is not tomorrow" {
        val loaded = NotesJournalMachine.reduce(
            NotesJournalMachine.reduce(NotesJournalMachine.initial(), NotesJournalEvent(opened = NotesJournalEvent.Opened())).state,
            NotesJournalReads.arrived(
                listOf(AppQueryResponse(notes_journal = NotesJournal(today = "2026-03-12", tz = "Pacific/Auckland"))),
            ),
        ).state
        loaded.data_!!.tz shouldBe "Pacific/Auckland"
        val composing = NotesJournalMachine.reduce(loaded, NotesJournalEvent(new_entry = NotesJournalEvent.NewEntryRequested())).state
        composing.compose!!.day shouldBe "2026-03-12"
        composing.compose.tz shouldBe "Pacific/Auckland"
        val typed = NotesJournalMachine.reduce(
            composing,
            NotesJournalEvent(compose_edited = NotesJournalEvent.ComposeEdited(mood = "Good", text = "Walked")),
        ).state
        NotesJournalMachine.reduce(typed, NotesJournalEvent(compose_saved = NotesJournalEvent.ComposeSaved()))
            .effects.filterIsInstance<ScreenEffect.SubmitWrite>().single().inputJson shouldBe
            """{"mood":"Good","text":"Walked","entry_date":"2026-03-12","tz":"Pacific/Auckland"}"""
    }

    // --- History -----------------------------------------------------------

    "history: versions newest first, the current one unrestorable, restore is a write" {
        val opened = NotesHistoryMachine.reduce(
            NotesHistoryMachine.initial(),
            NotesHistoryEvent(opened = NotesHistoryEvent.Opened(note_id = "n-1", note_title = "A")),
        )
        opened.effects.single().shouldBeInstanceOf<ScreenEffect.ReadPage>()
        // THE BACK WORD IS THE NOTE'S TITLE, else "Untitled note" — never the view's (#1047).
        opened.state.chrome!!.back shouldBe "A"
        NotesHistoryMachine.reduce(
            NotesHistoryMachine.initial(),
            NotesHistoryEvent(opened = NotesHistoryEvent.Opened(note_id = "n-2", note_title = " ")),
        ).state.chrome!!.back shouldBe NotesCopy.UNTITLED
        NotesHistoryReads.requests(opened.state, now)!!.single().notes_history!!.note_id shouldBe "n-1"
        NotesHistoryReads.requests(NotesHistoryMachine.initial(), now).shouldBeNull()
        val history = NotesHistory(
            versions = listOf(
                NotesVersion(
                    content_id = "c-2",
                    body = "new words",
                    current = true,
                    asserted_at = "2026-03-11T10:05:00.000Z",
                    asserted_local_day = "2026-03-11",
                    asserted_local = "2026-03-11T10:05",
                ),
                NotesVersion(
                    content_id = "c-1",
                    body = "old words",
                    asserted_at = "2026-03-02T08:00:00.000Z",
                    asserted_local_day = "2026-03-02",
                    asserted_local = "2026-03-02T08:00",
                ),
            ),
        )
        val loaded = NotesHistoryMachine.reduce(opened.state, NotesHistoryReads.arrived(listOf(AppQueryResponse(notes_history = history)))).state
        val rows = loaded.data_!!.rows
        rows[0].label shouldBe NotesCopy.CURRENT_VERSION
        rows[0].restore_label shouldBe ""
        rows[1].label shouldBe "Mon 2 March · 08:00"
        // THE MEMBER'S DAY AND TIME, when the core read them in a zone (#1047).
        NotesHistoryMachine.fold(
            NotesHistory(
                versions = listOf(
                    NotesVersion(
                        content_id = "c-1",
                        body = "b",
                        asserted_at = "2026-03-02T23:30:00.000Z",
                        asserted_local_day = "2026-03-03",
                        asserted_local = "2026-03-03T00:30",
                    ),
                ),
            ),
        ).rows.single().label shouldBe "Tue 3 March · 00:30"
        // NO ZONE RESOLVED, NO DAY: `asserted_at`'s UTC reading is never drawn.
        NotesHistoryMachine.fold(
            NotesHistory(versions = listOf(NotesVersion(content_id = "c-1", body = "b", asserted_at = "2026-03-02T23:30:00.000Z"))),
        ).rows.single().label shouldBe ""
        rows[1].restore_label shouldBe NotesCopy.RESTORE
        NotesHistoryMachine.reduce(loaded, NotesHistoryEvent(restore = NotesHistoryEvent.RestoreTapped(content_id = "c-2"))).effects.shouldBeEmpty()
        val restore = NotesHistoryMachine.reduce(loaded, NotesHistoryEvent(restore = NotesHistoryEvent.RestoreTapped(content_id = "c-1")))
        val write = restore.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe "knowledge.restore_note_version"
        write.inputJson shouldBe "{\"note_id\":\"n-1\",\"content_id\":\"c-1\"}"
        restore.state.restoring_content_id shouldBe "c-1"
    }

    "history: a cycle is the core's denial, drawn as the gate" {
        val state = NotesHistoryMachine.reduce(NotesHistoryState(), NotesHistoryReads.denied(AppQueryDenial(message = "This note's history is broken."))).state
        state.denied!!.body shouldBe "This note's history is broken."
    }

    // --- The editor's powerbox, new notes, the read-only body ---------------

    fun loadedEditor(body: String = "hello", unavailable: Boolean = false): NotesEditorState = NotesEditorMachine.run(
        NotesEditorMachine.initial(),
        NotesEditorEvent(opened = NotesEditorEvent.Opened(note_id = "n-1")),
        NotesEditorEvent(data_ = NotesEditorEvent.DataArrived(draft = NoteDraft(title = "T", body = body, body_unavailable = unavailable))),
    ).state

    "editor: typing [[ opens the powerbox, a pick lands [[title]] there and autosaves" {
        val typed = NotesEditorMachine.reduce(loadedEditor("hello "), NotesEditorEvent(body = NotesEditorEvent.BodyEdited(body = "hello [[ world")))
        typed.state.link_sheet_open shouldBe true
        typed.state.link_anchor shouldBe 6
        typed.state.link_replaces shouldBe true
        val picked = NotesEditorMachine.reduce(
            typed.state,
            NotesEditorEvent(link_picked = NotesEditorEvent.LinkPicked(target = NotesLinkTargetRow(entity = "core.party", id = "p-1", title = "Ana"))),
        )
        picked.state.draft!!.body shouldBe "hello [[Ana]] world"
        picked.state.link_sheet_open shouldBe false
        picked.effects.single().shouldBeInstanceOf<ScreenEffect.Schedule>()
        // An existing `[[` does not reopen it.
        NotesEditorMachine.reduce(picked.state, NotesEditorEvent(body = NotesEditorEvent.BodyEdited(body = "hello [[Ana]] world!")))
            .state.link_sheet_open shouldBe false
        // THE BUTTON'S LINK LANDS AT THE END: no shell reports a caret, and
        // one sent is not read (#1047).
        val button = NotesEditorMachine.run(
            loadedEditor("ab"),
            NotesEditorEvent(link_requested = NotesEditorEvent.LinkRequested(caret = 1)),
        ).state
        button.link_anchor shouldBe 2
        NotesEditorMachine.reduce(
            button,
            NotesEditorEvent(link_picked = NotesEditorEvent.LinkPicked(target = NotesLinkTargetRow(title = "X"))),
        ).state.draft!!.body shouldBe "ab [[X]]"
    }

    "editor: the button's link is its own word — spaced after text, a new line after a heading (#1047)" {
        fun splice(body: String, at: Int = body.length) = NotesEditorMachine.spliceLink(body, at, replaces = false, title = "Book")
        splice("Middlemarch.") shouldBe "Middlemarch. [[Book]]"
        splice("Middlemarch. ") shouldBe "Middlemarch. [[Book]]"
        splice("Middlemarch.\n") shouldBe "Middlemarch.\n[[Book]]"
        splice("") shouldBe "[[Book]]"
        splice("# Reading") shouldBe "# Reading\n[[Book]]"
        // Mid-text, it is spaced from what follows too.
        splice("ab cd", at = 2) shouldBe "ab [[Book]] cd"
        splice("abcd", at = 2) shouldBe "ab [[Book]] cd"
        // A TYPED `[[` is where the member put it: replaced in place, never spaced.
        NotesEditorMachine.spliceLink("Middlemarch.[[", 12, replaces = true, title = "Book") shouldBe "Middlemarch.[[Book]]"
    }

    "editor: the powerbox reads notes.link_targets and groups by domain" {
        val opened = NotesLinkPickerMachine.reduce(NotesLinkPickerMachine.initial(), NotesLinkPickerEvent(opened = NotesLinkPickerEvent.Opened()))
        opened.effects.single().shouldBeInstanceOf<ScreenEffect.ReadPage>()
        val typed = NotesLinkPickerMachine.reduce(opened.state, NotesLinkPickerEvent(term = NotesLinkPickerEvent.TermChanged(term = "an")))
        NotesLinkPickerReads.requests(typed.state, now).single().notes_link_targets!!.term shouldBe "an"
        val answer = NotesLinkTargets(
            targets = listOf(
                NotesLinkTarget(entity = "knowledge.note", id = "n-2", title = "Plans", app_id = "notes"),
                NotesLinkTarget(entity = "core.party", id = "p-1", title = "Ana", app_id = "people"),
            ),
        )
        val loaded = NotesLinkPickerMachine.reduce(typed.state, NotesLinkPickerReads.arrived(listOf(AppQueryResponse(notes_link_targets = answer)))).state
        loaded.data_!!.domains.map { it.head!!.title } shouldBe listOf(NotesCopy.DOMAIN_NOTES, NotesCopy.DOMAIN_PEOPLE)
        val none = NotesLinkPickerMachine.reduce(typed.state, NotesLinkPickerReads.arrived(listOf(AppQueryResponse(notes_link_targets = NotesLinkTargets())))).state
        none.data_!!.empty!!.body shouldBe NotesCopy.LINK_NO_MATCH_BODY
        loaded.chrome!!.foot shouldBe NotesCopy.POWERBOX_FOOT
    }

    "editor: a body not on this device is read-only; the title still saves" {
        val state = loadedEditor(body = "", unavailable = true)
        state.body_editable shouldBe false
        state.body_notice shouldBe NotesCopy.BODY_NOT_HERE
        NotesEditorMachine.reduce(state, NotesEditorEvent(body = NotesEditorEvent.BodyEdited(body = "x"))).state shouldBe state
        val titled = NotesEditorMachine.run(
            state,
            NotesEditorEvent(title = NotesEditorEvent.TitleEdited(title = "New")),
            NotesEditorEvent(save = NotesEditorEvent.SaveRequested()),
        )
        (titled.effects.single() as ScreenEffect.SubmitWrite).inputJson shouldBe "{\"note_id\":\"n-1\",\"title\":\"New\"}"
    }

    "editor: close stays Done after an autosave and the re-read that follows; a fresh open is Cancel (#1015 D3)" {
        val loaded = loadedEditor("hello")
        loaded.chrome!!.close shouldBe NotesCopy.CANCEL
        val typed = NotesEditorMachine.reduce(loaded, NotesEditorEvent(body = NotesEditorEvent.BodyEdited(body = "hello there")))
        val tick = (typed.effects.single() as ScreenEffect.Schedule).token
        val saving = NotesEditorMachine.reduce(typed.state, NotesEditorEvent(tick = NotesEditorEvent.Ticked(token = tick)))
        val key = (saving.effects.single() as ScreenEffect.SubmitWrite).invokeKey
        val saved = NotesEditorMachine.reduce(
            saving.state,
            NotesEditorEvent(write_settled = WriteSettled(invoke_key = key, committed = true)),
        ).state
        saved.chrome!!.close shouldBe NotesCopy.DONE
        // THE RE-READ AFTER THE SAVE puts the phase back to clean; close stays Done.
        val reread = NotesEditorMachine.reduce(
            saved,
            NotesEditorEvent(data_ = NotesEditorEvent.DataArrived(draft = NoteDraft(title = "T", body = "hello there"))),
        ).state
        reread.autosave!!.phase shouldBe centraid.screen.v1.Autosave.Phase.PHASE_CLEAN
        reread.chrome!!.close shouldBe NotesCopy.DONE
        // Another visit starts over.
        NotesEditorMachine.reduce(reread, NotesEditorEvent(opened = NotesEditorEvent.Opened(note_id = "n-2")))
            .state.chrome!!.close shouldBe NotesCopy.CANCEL
    }

    "editor: a new note reads nothing, creates on first save under its minted id, then edits" {
        val id = "0b7e3a52-1c7d-4d5e-9f00-1234567890ab"
        val opened = NotesEditorMachine.reduce(
            NotesEditorMachine.initial(),
            NotesEditorEvent(opened = NotesEditorEvent.Opened(note_id = id, is_new = true)),
        )
        opened.effects.shouldBeEmpty()
        opened.state.draft.shouldNotBeNull()
        opened.state.chrome!!.close shouldBe NotesCopy.CANCEL
        opened.state.chrome.history_enabled shouldBe false
        // NOTHING IS SAVED YET, so the status line does not say "Saved" (#1047 walk).
        opened.state.autosave!!.label shouldBe ""
        // Not in the vault: a change event reads nothing.
        NotesEditorMachine.reduce(opened.state, NotesEditorMachine.rowsChanged("knowledge_note", emptyList())!!).effects.shouldBeEmpty()
        opened.state.chrome.title shouldBe NotesCopy.NEW_NOTE
        opened.state.chrome.menu_label shouldBe NotesCopy.ROW_MENU
        // Nothing to name it by: a line first.
        val blank = NotesEditorMachine.run(
            opened.state,
            NotesEditorEvent(body = NotesEditorEvent.BodyEdited(body = "  ")),
            NotesEditorEvent(save = NotesEditorEvent.SaveRequested()),
        ).state
        blank.chrome!!.status shouldBe NotesCopy.WRITE_A_LINE
        // A title alone IS a note now (`body_text` may be empty).
        val titleOnly = NotesEditorMachine.run(
            opened.state,
            NotesEditorEvent(title = NotesEditorEvent.TitleEdited(title = "T")),
        ).state
        val typed = NotesEditorMachine.reduce(titleOnly, NotesEditorEvent(body = NotesEditorEvent.BodyEdited(body = "Buy milk")))
        typed.state.chrome!!.close shouldBe NotesCopy.DONE
        val tick = (typed.effects.single() as ScreenEffect.Schedule).token
        val create = NotesEditorMachine.reduce(typed.state, NotesEditorEvent(tick = NotesEditorEvent.Ticked(token = tick)))
        val write = create.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe NotesEditorMachine.CREATE_COMMAND
        write.inputJson shouldBe "{\"note_id\":\"$id\",\"title\":\"T\",\"body_text\":\"Buy milk\",\"format\":\"markdown\"}"
        create.state.autosave!!.invoke_key shouldBe write.invokeKey
        write.invokeKey shouldContain NotesEditorMachine.CREATE_COMMAND
        val committed = NotesEditorMachine.reduce(
            create.state,
            NotesEditorEvent(write_settled = WriteSettled(invoke_key = write.invokeKey, committed = true)),
        ).state
        committed.is_new shouldBe false
        committed.chrome!!.status shouldBe NotesCopy.SAVED
        val edited = NotesEditorMachine.run(
            committed,
            NotesEditorEvent(body = NotesEditorEvent.BodyEdited(body = "Buy milk and eggs")),
            NotesEditorEvent(left = NotesEditorEvent.Left()),
        )
        val edit = edited.effects.last() as ScreenEffect.SubmitWrite
        edit.command shouldBe NotesEditorMachine.SAVE_COMMAND
        edit.inputJson shouldBe "{\"note_id\":\"$id\",\"body_text\":\"Buy milk and eggs\"}"
    }

    "editor: words typed while the create is in flight are an edit of the note it made, never a second create (#1089)" {
        // The core keeps no replay ledger (R-1088-12): a second `create_note` under
        // the same minted id is not one the vault will answer from memory.
        val id = "0b7e3a52-1c7d-4d5e-9f00-1234567890ab"
        val opened = NotesEditorMachine.reduce(
            NotesEditorMachine.initial(),
            NotesEditorEvent(opened = NotesEditorEvent.Opened(note_id = id, is_new = true)),
        ).state
        val typed = NotesEditorMachine.reduce(opened, NotesEditorEvent(body = NotesEditorEvent.BodyEdited(body = "Buy milk")))
        val tick = (typed.effects.single() as ScreenEffect.Schedule).token
        val create = NotesEditorMachine.reduce(typed.state, NotesEditorEvent(tick = NotesEditorEvent.Ticked(token = tick)))
        val write = create.effects.single() as ScreenEffect.SubmitWrite
        write.command shouldBe NotesEditorMachine.CREATE_COMMAND
        // Typing on while the create is in flight, and a save asked for: it waits.
        val more = NotesEditorMachine.reduce(create.state, NotesEditorEvent(body = NotesEditorEvent.BodyEdited(body = "Buy milk and eggs")))
        val waiting = NotesEditorMachine.reduce(more.state, NotesEditorEvent(save = NotesEditorEvent.SaveRequested()))
        waiting.effects.filterIsInstance<ScreenEffect.SubmitWrite>().shouldBeEmpty()
        val committed = NotesEditorMachine.reduce(
            waiting.state,
            NotesEditorEvent(write_settled = WriteSettled(invoke_key = write.invokeKey, committed = true)),
        )
        committed.state.is_new shouldBe false
        val next = committed.effects.filterIsInstance<ScreenEffect.SubmitWrite>().single()
        next.command shouldBe NotesEditorMachine.SAVE_COMMAND
        next.inputJson shouldBe "{\"note_id\":\"$id\",\"title\":\"Buy milk and eggs\",\"body_text\":\"Buy milk and eggs\"}"
        // A save asked for with nothing changed since the commit sends nothing.
        val settledAgain = NotesEditorMachine.reduce(
            committed.state,
            NotesEditorEvent(write_settled = WriteSettled(invoke_key = next.invokeKey, committed = true)),
        ).state
        NotesEditorMachine.reduce(settledAgain, NotesEditorEvent(save = NotesEditorEvent.SaveRequested()))
            .effects.filterIsInstance<ScreenEffect.SubmitWrite>().shouldBeEmpty()
    }

    "editor: a title derived from the body stays derived after the re-read — the field stays empty (#1047 F5)" {
        val id = "0b7e3a52-1c7d-4d5e-9f00-1234567890ab"
        val opened = NotesEditorMachine.reduce(
            NotesEditorMachine.initial(),
            NotesEditorEvent(opened = NotesEditorEvent.Opened(note_id = id, is_new = true)),
        ).state
        val typed = NotesEditorMachine.reduce(opened, NotesEditorEvent(body = NotesEditorEvent.BodyEdited(body = "Buy milk")))
        val tick = (typed.effects.single() as ScreenEffect.Schedule).token
        val create = NotesEditorMachine.reduce(typed.state, NotesEditorEvent(tick = NotesEditorEvent.Ticked(token = tick)))
        val write = create.effects.single() as ScreenEffect.SubmitWrite
        val committed = NotesEditorMachine.reduce(
            create.state,
            NotesEditorEvent(write_settled = WriteSettled(invoke_key = write.invokeKey, committed = true)),
        ).state
        // THE CLEAN RE-READ brings back the title the vault derived. The
        // field is still the member's: empty, so the first line still names it.
        val reread = NotesEditorMachine.reduce(
            committed,
            NotesEditorEvent(data_ = NotesEditorEvent.DataArrived(draft = NoteDraft(title = "Buy milk", body = "Buy milk"))),
        ).state
        reread.draft!!.title shouldBe ""
        val renamed = NotesEditorMachine.run(
            reread,
            NotesEditorEvent(body = NotesEditorEvent.BodyEdited(body = "Groceries\nBuy milk")),
            NotesEditorEvent(left = NotesEditorEvent.Left()),
        )
        (renamed.effects.last() as ScreenEffect.SubmitWrite).inputJson shouldBe
            "{\"note_id\":\"$id\",\"title\":\"Groceries\",\"body_text\":\"Groceries\\nBuy milk\"}"
        // A pin alone sends no title: nothing about the name changed.
        val pinned = NotesEditorMachine.reduce(reread, NotesEditorEvent(pin = NotesEditorEvent.PinToggled()))
        (pinned.effects.last() as ScreenEffect.SubmitWrite).inputJson shouldBe "{\"note_id\":\"$id\",\"pinned\":1}"
        // A NAME FROM ELSEWHERE is not derived, and is adopted.
        NotesEditorMachine.reduce(
            committed,
            NotesEditorEvent(data_ = NotesEditorEvent.DataArrived(draft = NoteDraft(title = "Shopping", body = "Buy milk"))),
        ).state.draft!!.title shouldBe "Shopping"
        // A FRESH OPEN draws the stored title, on both shells, as it always has.
        NotesEditorMachine.run(
            NotesEditorMachine.initial(),
            NotesEditorEvent(opened = NotesEditorEvent.Opened(note_id = id)),
            NotesEditorEvent(data_ = NotesEditorEvent.DataArrived(draft = NoteDraft(title = "Buy milk", body = "Buy milk"))),
        ).state.draft!!.title shouldBe "Buy milk"
    }

    "editor: a cleared name saves as cleared — the first line when there is one, else empty (#1047 T1)" {
        val id = "0b7e3a52-1c7d-4d5e-9f00-1234567890ab"
        fun opened(title: String, body: String) = NotesEditorMachine.run(
            NotesEditorMachine.initial(),
            NotesEditorEvent(opened = NotesEditorEvent.Opened(note_id = id)),
            NotesEditorEvent(data_ = NotesEditorEvent.DataArrived(draft = NoteDraft(title = title, body = body))),
        ).state
        fun cleared(title: String, body: String): String = (
            NotesEditorMachine.run(
                opened(title, body),
                NotesEditorEvent(title = NotesEditorEvent.TitleEdited(title = "")),
                NotesEditorEvent(left = NotesEditorEvent.Left()),
            ).effects.last() as ScreenEffect.SubmitWrite
            ).inputJson
        // A FIRST LINE NAMES IT, as ever.
        cleared("Name", "Buy milk") shouldBe "{\"note_id\":\"$id\",\"title\":\"Buy milk\"}"
        // NO FIRST LINE: the name the member removed is removed, not kept in
        // the vault to come back on the next read (`edit_note`'s `title` takes
        // `""`).
        cleared("Name", "") shouldBe "{\"note_id\":\"$id\",\"title\":\"\"}"
    }

    // --- Routing -----------------------------------------------------------

    "routing: the tile's shelf opens the Notes place, else a new note, and nothing while loading" {
        val mint = { "minted" }
        NotesRouting.tile(
            HomeTile(app_id = "notes", status = TileStatus.TILE_STATUS_CONTENT, body = TileBody(notes = TileBody.Notes(note_id = "n-9", title = "Hi"))),
            mint,
        ) shouldBe Destination.NotesLibrary()
        NotesRouting.tile(HomeTile(app_id = "notes", status = TileStatus.TILE_STATUS_EMPTY), mint) shouldBe
            Destination.NotesEditor("minted", isNew = true)
        NotesRouting.tile(null, mint) shouldBe Destination.NotesEditor("minted", isNew = true)
        NotesRouting.tile(HomeTile(app_id = "notes", status = TileStatus.TILE_STATUS_LOADING), mint).shouldBeNull()
        NotesRouting.tile(HomeTile(app_id = "notes", status = TileStatus.TILE_STATUS_UNKNOWN), mint).shouldBeNull()
        // The id is the shape `create_note` takes.
        NotesRouting.mintNoteId().matches(Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")) shouldBe true
    }

    // --- Trash -------------------------------------------------------------

    "trash: the core's notes.trash, restore only, no purge and no empty" {
        val opened = NotesTrashMachine.reduce(NotesTrashMachine.initial(), TrashListEvent(opened = TrashListEvent.Opened()))
        NotesTrashMachine.screenId shouldBe "notes.trash"
        NotesTrashReads.requests(opened.state, now).single().notes_trash.shouldNotBeNull()
        val answer = NotesTrash(notes = listOf(NotesRow(note_id = "n-1", title = "Gone", deleted_at = "2026-03-11T09:00:00.000Z", preview = "")))
        val loaded = NotesTrashMachine.reduce(opened.state, NotesTrashReads.arrived(listOf(AppQueryResponse(notes_trash = answer)))).state
        val trashRow = loaded.data_!!.rows.single()
        trashRow.title shouldBe "Gone"
        trashRow.purge_label shouldBe ""
        loaded.data_.empty_label shouldBe ""
        val restore = NotesTrashMachine.reduce(loaded, TrashListEvent(restore = TrashListEvent.RestoreTapped(id = "n-1")))
        (restore.effects.single() as ScreenEffect.SubmitWrite).let {
            it.command shouldBe "knowledge.restore_note"
            it.inputJson shouldBe "{\"note_id\":\"n-1\"}"
        }
        NotesTrashMachine.reduce(loaded, TrashListEvent(purge = TrashListEvent.PurgeTapped(id = "n-1"))).state.confirm.shouldBeNull()
        NotesTrashMachine.reduce(loaded, TrashListEvent(empty = TrashListEvent.EmptyTapped())).state.confirm.shouldBeNull()
    }
})
