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
import centraid.screen.v1.NotesNotebooksState
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
import dev.centraid.shared.apps.notes.NotesTarget
import dev.centraid.shared.apps.notes.NotesTrashMachine
import dev.centraid.shared.apps.notes.NotesTrashReads
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavStack
import dev.centraid.shared.nav.withNotesPlace
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
        pinned.filter_label shouldBe "${NotesCopy.PINNED_ONLY} · work"
        pinned.data_!!.tags.single().selected shouldBe true

        val cleared = NotesLibraryMachine.reduce(pinned, NotesLibraryEvent(filter_cleared = NotesLibraryEvent.FilterCleared())).state
        cleared.filter_label shouldBe ""
        NotesLibraryReads.requests(cleared, now)[0].notes_library!!.pinned_only shouldBe false
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
        NotesLibraryMachine.rowsChanged("tally_expense", emptyList()).shouldBeNull()
        val step = NotesLibraryMachine.reduce(state, NotesLibraryMachine.rowsChanged("core_collection_entry", listOf("k"))!!)
        step.effects.single().shouldBeInstanceOf<ScreenEffect.ReadPage>()
        step.state.data_.shouldNotBeNull()
    }

    "library: denied is the gate, with no band" {
        val state = NotesLibraryMachine.reduce(openedLibrary(), NotesLibraryReads.denied(AppQueryDenial(message = "revoked"))).state
        state.denied!!.title shouldBe NotesCopy.DENIED_TITLE
        state.band.shouldBeEmpty()
        state.data_.shouldBeNull()
    }

    "library: More is a sheet, the same tab is nothing, another tab is the shell's" {
        val state = loadedLibrary(row("n-1", "A"))
        NotesLibraryMachine.reduce(state, NotesLibraryEvent(band = NotesLibraryEvent.BandPicked(key = "more"))).state.sheet shouldBe
            NotesLibraryState.Sheet.SHEET_MORE
        val same = NotesLibraryMachine.reduce(state, NotesLibraryEvent(band = NotesLibraryEvent.BandPicked(key = "notes")))
        same.effects.shouldBeEmpty()
        same.state shouldBe state
        val stack = NavStack().push(Destination.NotesLibrary())
        stack.withNotesPlace("journal").entries shouldBe listOf(Destination.Home, Destination.NotesJournal)
        stack.withNotesPlace("more") shouldBe stack
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
                NotesLinkTarget(entity = "tally.expense", id = "x-1", title = "Dinner", subtitle = "tally", app_id = "tally"),
                NotesLinkTarget(entity = "some.thing", id = "o-1", title = "Odd", subtitle = "elsewhere", app_id = "elsewhere"),
            ),
        )
        folded.domains.map { it.head!!.title to it.rows.single().subtitle } shouldBe listOf(
            NotesCopy.DOMAIN_DOCS to NotesCopy.LINK_KIND_DOCUMENT,
            NotesCopy.DOMAIN_PHOTOS to NotesCopy.LINK_KIND_PHOTOGRAPH,
            NotesCopy.DOMAIN_TALLY to NotesCopy.LINK_KIND_EXPENSE,
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
        NotesJournalMachine.reduce(saving.state, NotesJournalEvent(write_settled = WriteSettled(invoke_key = key, committed = true)))
            .state.compose shouldBe null
        NotesJournalMachine.reduce(refused, NotesJournalEvent(compose_closed = NotesJournalEvent.ComposeClosed())).state.compose shouldBe null
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

    "routing: the tile's note, else a new note, and nothing while loading" {
        val mint = { "minted" }
        NotesRouting.target(
            HomeTile(app_id = "notes", status = TileStatus.TILE_STATUS_CONTENT, body = TileBody(notes = TileBody.Notes(note_id = "n-9", title = "Hi"))),
            mint,
        ) shouldBe NotesTarget.Existing("n-9", "Hi")
        NotesRouting.target(HomeTile(app_id = "notes", status = TileStatus.TILE_STATUS_EMPTY), mint) shouldBe NotesTarget.New("minted")
        NotesRouting.target(null, mint) shouldBe NotesTarget.New("minted")
        NotesRouting.target(HomeTile(app_id = "notes", status = TileStatus.TILE_STATUS_LOADING), mint).shouldBeNull()
        NotesRouting.target(HomeTile(app_id = "notes", status = TileStatus.TILE_STATUS_UNKNOWN), mint).shouldBeNull()
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
