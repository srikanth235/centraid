package dev.centraid.shared.apps.notes

import centraid.screen.v1.Confirm
import centraid.screen.v1.EmptyState
import centraid.screen.v1.Loading
import centraid.screen.v1.NotesChoice
import centraid.screen.v1.NotesLibraryChrome
import centraid.screen.v1.NotesLibraryData
import centraid.screen.v1.NotesLibraryEvent
import centraid.screen.v1.NotesLibrarySection
import centraid.screen.v1.NotesLibrarySort
import centraid.screen.v1.NotesLibraryState
import centraid.screen.v1.NotesNoteRow
import centraid.screen.v1.NotesRowMenu
import centraid.screen.v1.NotesSearchResults
import centraid.screen.v1.SearchField
import centraid.screen.v1.SeatState
import centraid.screen.v1.SectionHead
import centraid.screen.v1.WriteState
import dev.centraid.design.copy.NotesCopy
import dev.centraid.shared.kit.InvokeKeys
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.SearchLaw
import dev.centraid.shared.kit.SearchLens
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.kit.WriteLens
import dev.centraid.shared.kit.jsonString
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step

/**
 * THE NOTES LIBRARY (#1029 port): the live shelf, pinned first, with search as
 * a field over it, sort and filters as the read's parameters, and a row menu
 * that pins, files into a notebook and trashes.
 *
 * - **Reads** are the core's `notes.library` beside `notes.notebooks` (the
 *   file-into sheet's choices), or `notes.search` while a term is typed
 *   ([NotesLibraryReads]). Search results live beside the library, so closing
 *   search puts the library back without a read — unless it went stale while
 *   search was answering (`library_stale`).
 * - **Writes** are one at a time ([WriteLaw]); the vault's change event
 *   re-reads the shelf, which never moves a row on a guess.
 * - **Views decide nothing**: the band, the chrome, the heading, the filter
 *   line and every empty sentence are recomputed on every step ([decorate]).
 */
public object NotesLibraryMachine : ScreenMachine<NotesLibraryState, NotesLibraryEvent> {
    public const val SCREEN_ID: String = "notes.library"

    /** Every table `notes.library`, `notes.notebooks` and `notes.search` read. */
    public val TABLES: Set<String> = setOf(
        "knowledge_note",
        "core_collection",
        "core_collection_entry",
        "core_tag",
        "core_concept",
        "core_attachment",
        "core_link",
    )

    /** The core's default window, and its ceiling. */
    internal const val DEFAULT_WINDOW: Int = 200
    internal const val MAX_WINDOW: Int = 2000

    internal const val PIN_COMMAND: String = "knowledge.edit_note"
    internal const val MOVE_COMMAND: String = "knowledge.move_note"
    internal const val TRASH_COMMAND: String = "knowledge.delete_note"

    override fun initial(): NotesLibraryState = decorate(
        NotesLibraryState(
            loading = Loading(first_load = true),
            search = SearchField(),
            sort = NotesLibrarySort.NOTES_LIBRARY_SORT_UPDATED,
            sheet = NotesLibraryState.Sheet.SHEET_NONE,
            write = WriteState(phase = WriteState.Phase.PHASE_IDLE),
        ),
    )

    override fun reduce(state: NotesLibraryState, event: NotesLibraryEvent): Step<NotesLibraryState> {
        val step = step(state, event)
        return Step(decorate(step.state), step.effects)
    }

    private fun step(state: NotesLibraryState, event: NotesLibraryEvent): Step<NotesLibraryState> = when {
        event.opened != null -> {
            val o = event.opened
            Step(
                Content.with(
                    state.copy(
                        notebook_id = o.notebook_id,
                        heading = o.notebook_name,
                        unfiled_only = o.unfiled_only && o.notebook_id.isEmpty(),
                        search = SearchField(),
                        results = null,
                        sheet = NotesLibraryState.Sheet.SHEET_NONE,
                        menu = null,
                        choices = emptyList(),
                        confirm = null,
                        confirm_note_id = "",
                        library_stale = false,
                        first_page_pending = false,
                    ),
                    ReadContent.Loading(firstLoad = true),
                ),
                listOf(read()),
            )
        }

        event.refreshed != null -> reread(state)

        // THE SAME PLACE IS NOTHING; More is a sheet; another place is the
        // shell's to route.
        event.band != null -> when (event.band.key) {
            NotesBand.MORE -> Step(state.copy(sheet = NotesLibraryState.Sheet.SHEET_MORE))
            else -> Step(state)
        }

        event.search_opened != null -> {
            val opened = SearchLaw.opened(Search, state).state
            Step(opened.copy(results = opened.results ?: NotesSearchResults(empty = searchPrompt())))
        }

        event.search_term != null -> {
            val term = event.search_term.term
            val step = SearchLaw.term(Search, state, term)
            val results = if (term.isBlank()) {
                NotesSearchResults(term = term, empty = searchPrompt())
            } else {
                (step.state.results ?: NotesSearchResults()).copy(term = term, loading = true)
            }
            Step(step.state.copy(results = results), step.effects)
        }

        // CLOSE CLEARS the term and its answer. A library that went stale
        // while search answered is read again now.
        event.search_closed != null -> {
            val closed = SearchLaw.closed(Search, state).state.copy(results = null)
            if (closed.library_stale) reread(closed.copy(library_stale = false)) else Step(closed)
        }

        event.sort != null -> readLibrary(
            state.copy(
                sort = event.sort.sort.takeUnless { it == NotesLibrarySort.NOTES_LIBRARY_SORT_UNSPECIFIED }
                    ?: NotesLibrarySort.NOTES_LIBRARY_SORT_UPDATED,
                sheet = NotesLibraryState.Sheet.SHEET_NONE,
                choices = emptyList(),
            ),
        )

        event.pinned_only != null -> readLibrary(
            state.copy(pinned_only = !state.pinned_only, sheet = NotesLibraryState.Sheet.SHEET_NONE),
        )

        event.tag != null -> {
            val id = event.tag.concept_id
            val tags = if (id in state.tag_concept_ids) state.tag_concept_ids - id else state.tag_concept_ids + id
            readLibrary(state.copy(tag_concept_ids = tags))
        }

        event.window_widened != null -> {
            val current = if (state.window == 0) DEFAULT_WINDOW else state.window
            if (current >= MAX_WINDOW) Step(state) else readLibrary(state.copy(window = minOf(current * 2, MAX_WINDOW)))
        }

        event.filter_cleared != null -> readLibrary(
            state.copy(pinned_only = false, unfiled_only = false, notebook_id = "", heading = "", tag_concept_ids = emptyList()),
        )

        event.sheet_opened != null -> when (event.sheet_opened.sheet) {
            NotesLibraryState.Sheet.SHEET_SORT -> Step(
                state.copy(sheet = NotesLibraryState.Sheet.SHEET_SORT, choices = sortChoices(state.sort)),
            )
            NotesLibraryState.Sheet.SHEET_MORE -> Step(state.copy(sheet = NotesLibraryState.Sheet.SHEET_MORE))
            else -> Step(state)
        }

        event.sheet_closed != null -> Step(closeSheet(state))

        event.row_menu != null -> {
            val row = rowOf(state, event.row_menu.note_id)
            if (row == null) {
                Step(state)
            } else {
                Step(state.copy(sheet = NotesLibraryState.Sheet.SHEET_ROW_MENU, menu = menuOf(row)))
            }
        }

        // A PIN IS A DECISION, and it saves at once: `edit_note` with the
        // one field that changed.
        event.pin != null -> {
            val row = rowOf(state, event.pin.note_id)
            if (row == null) {
                Step(closeSheet(state))
            } else {
                val pinned = if (row.pinned) 0 else 1
                WriteLaw.submit(
                    Writes,
                    closeSheet(state),
                    PIN_COMMAND,
                    "{\"note_id\":${jsonString(row.note_id)},\"pinned\":$pinned}",
                    InvokeKeys.of(PIN_COMMAND, row.note_id, "pinned=$pinned"),
                )
            }
        }

        event.file_ != null -> {
            val row = rowOf(state, event.file_.note_id)
            if (row == null) {
                Step(state)
            } else {
                Step(
                    state.copy(
                        sheet = NotesLibraryState.Sheet.SHEET_FILE_INTO,
                        menu = menuOf(row),
                        choices = fileChoices(state.notebooks, row.notebook_id),
                    ),
                )
            }
        }

        event.notebook_chosen != null -> {
            val noteId = state.menu?.note_id
            val row = noteId?.let { rowOf(state, it) }
            val chosen = event.notebook_chosen.notebook_id
            if (row == null || chosen == row.notebook_id) {
                Step(closeSheet(state))
            } else {
                val input = if (chosen.isEmpty()) {
                    "{\"note_id\":${jsonString(row.note_id)}}"
                } else {
                    "{\"note_id\":${jsonString(row.note_id)},\"notebook_id\":${jsonString(chosen)}}"
                }
                WriteLaw.submit(
                    Writes,
                    closeSheet(state),
                    MOVE_COMMAND,
                    input,
                    InvokeKeys.of(MOVE_COMMAND, row.note_id, "to=$chosen"),
                )
            }
        }

        // TRASH IS ASKED FIRST, in full sentences.
        event.trash != null -> {
            val row = rowOf(state, event.trash.note_id)
            if (row == null) {
                Step(state)
            } else {
                Step(
                    closeSheet(state).copy(
                        confirm = Confirm(
                            title = NotesCopy.DELETE_NOTE_TITLE,
                            body = NotesCopy.DELETE_NOTE_BODY,
                            confirm_label = NotesCopy.DELETE_NOTE_VERB,
                            destructive = true,
                        ),
                        confirm_note_id = row.note_id,
                    ),
                )
            }
        }

        event.confirmed != null -> {
            val id = state.confirm_note_id
            val dismissed = state.copy(confirm = null, confirm_note_id = "")
            if (id.isEmpty()) {
                Step(dismissed)
            } else {
                WriteLaw.submit(
                    Writes,
                    dismissed,
                    TRASH_COMMAND,
                    "{\"note_id\":${jsonString(id)}}",
                    InvokeKeys.of(TRASH_COMMAND, id),
                )
            }
        }

        event.dismissed != null -> Step(state.copy(confirm = null, confirm_note_id = ""))

        event.write_settled != null -> WriteLaw.settled(Writes, state, event.write_settled)

        event.data_ != null -> Step(
            Content.with(state, ReadContent.Data(event.data_.data_ ?: NotesLibraryData()))
                .copy(notebooks = event.data_.notebooks, first_page_pending = false),
        )

        // AN ANSWER FOR A SEARCH NO LONGER OPEN is dropped.
        event.search_arrived != null -> {
            val term = state.search?.term ?: ""
            if (state.search?.open_ != true || term.isBlank()) {
                Step(state)
            } else {
                val rows = event.search_arrived.rows
                Step(
                    SearchLaw.answered(Search, state, term).copy(
                        results = NotesSearchResults(
                            term = term,
                            rows = rows,
                            empty = if (rows.isEmpty()) {
                                EmptyState(headline = NotesCopy.SEARCH_NO_MATCH_HEADLINE, body = NotesCopy.SEARCH_NO_MATCH_BODY)
                            } else {
                                null
                            },
                            loading = false,
                        ),
                    ),
                )
            }
        }

        // A FAILED READ IS NOT AN EMPTY SHELF, and emits nothing: retry is a
        // member-sent refresh.
        event.refused != null -> Step(
            Content.with(state, ReadContent.Failed(event.refused.failure ?: Reads.refused("")))
                .copy(first_page_pending = false, results = state.results?.copy(loading = false)),
        )

        event.denied != null -> Step(Content.with(state, ReadContent.Denied(event.denied)).copy(first_page_pending = false))

        event.rows_changed != null ->
            if (event.rows_changed.table !in TABLES) {
                Step(state)
            } else if (searchActive(state)) {
                // Search re-reads now; the library when search closes.
                Step(state.copy(library_stale = true), listOf(read()))
            } else {
                reread(state)
            }

        event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))

        // INTENTS: the shell routes them.
        else -> Step(state)
    }

    // ---------------------------------------------------------------------

    private fun read(): ScreenEffect = ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)

    /** Is a term being answered? Then a read is a search. */
    internal fun searchActive(state: NotesLibraryState): Boolean =
        state.search?.open_ == true && state.search.term.isNotBlank()

    /** Read the library again, keeping its rows drawn — or later, while search answers. */
    private fun readLibrary(state: NotesLibraryState): Step<NotesLibraryState> =
        if (searchActive(state)) Step(state.copy(library_stale = true)) else reread(state)

    private fun reread(state: NotesLibraryState): Step<NotesLibraryState> =
        if (Content.content(state) is ReadContent.Data) {
            Step(state.copy(first_page_pending = true), listOf(read()))
        } else {
            Step(Content.with(state, ReadContent.Loading(firstLoad = true)), listOf(read()))
        }

    private fun closeSheet(state: NotesLibraryState): NotesLibraryState =
        state.copy(sheet = NotesLibraryState.Sheet.SHEET_NONE, menu = null, choices = emptyList())

    /** A row on screen — the library's or search's — by id. */
    private fun rowOf(state: NotesLibraryState, noteId: String): NotesNoteRow? =
        (state.data_?.sections?.flatMap { it.rows } ?: emptyList())
            .plus(state.results?.rows ?: emptyList())
            .firstOrNull { it.note_id == noteId }

    private fun menuOf(row: NotesNoteRow): NotesRowMenu = NotesRowMenu(
        note_id = row.note_id,
        title = row.title,
        pin_label = if (row.pinned) NotesCopy.UNPIN else NotesCopy.PIN,
        file_label = NotesCopy.FILE_VERB,
        trash_label = NotesCopy.DELETE_NOTE_VERB,
    )

    private fun fileChoices(notebooks: List<NotesChoice>, current: String): List<NotesChoice> =
        listOf(NotesChoice(id = "", label = NotesCopy.NO_NOTEBOOK, selected = current.isEmpty())) +
            notebooks.map { it.copy(selected = it.id == current) }

    private fun sortChoices(current: NotesLibrarySort): List<NotesChoice> = listOf(
        NotesLibrarySort.NOTES_LIBRARY_SORT_UPDATED to NotesCopy.SORT_UPDATED,
        NotesLibrarySort.NOTES_LIBRARY_SORT_CREATED to NotesCopy.SORT_CREATED,
        NotesLibrarySort.NOTES_LIBRARY_SORT_TITLE to NotesCopy.SORT_TITLE_AZ,
    ).map { (sort, label) -> NotesChoice(id = sort.name, label = label, selected = sort == current, sort = sort) }

    private fun searchPrompt(): EmptyState = EmptyState(headline = "", body = NotesCopy.SEARCH_EMPTY)

    // ---------------------------------------------------------------------
    // Decoration: everything a view draws that is not a row.
    // ---------------------------------------------------------------------

    private fun decorate(state: NotesLibraryState): NotesLibraryState {
        val denied = state.denied != null
        val heading = when {
            state.notebook_id.isNotEmpty() -> state.heading.ifEmpty { NotesCopy.TITLE }
            state.unfiled_only -> NotesCopy.UNFILED_ROW
            else -> NotesCopy.TITLE
        }
        val filters = buildList {
            if (state.pinned_only) add(NotesCopy.PINNED_ONLY)
            if (state.notebook_id.isNotEmpty() || state.unfiled_only) add(heading)
            state.data_?.tags?.filter { it.concept_id in state.tag_concept_ids }?.forEach { add(it.label) }
        }
        return state.copy(
            band = if (denied) emptyList() else NotesBand.tabs(NotesBand.NOTES),
            chrome = CHROME,
            heading = heading,
            filter_label = filters.joinToString(" · "),
            data_ = state.data_?.let { decorateData(state, it) },
        )
    }

    private fun decorateData(state: NotesLibraryState, data: NotesLibraryData): NotesLibraryData {
        val rows = data.sections.flatMap { it.rows }
        val filtered = state.pinned_only || state.unfiled_only || state.notebook_id.isNotEmpty() ||
            state.tag_concept_ids.isNotEmpty()
        val empty = when {
            rows.isNotEmpty() -> null
            state.notebook_id.isNotEmpty() -> EmptyState(
                headline = NotesCopy.EMPTY_FILTERED_HEADLINE,
                body = NotesCopy.EMPTY_NOTEBOOK_BODY,
                action_label = NotesCopy.NEW_NOTE,
            )
            filtered -> EmptyState(headline = NotesCopy.EMPTY_FILTERED_HEADLINE, body = NotesCopy.EMPTY_FILTERED_BODY)
            // DAY ONE: nothing written yet, and one action that takes content.
            else -> EmptyState(
                headline = NotesCopy.EMPTY_DAY_ONE_HEADLINE,
                body = NotesCopy.EMPTY_DAY_ONE,
                action_label = NotesCopy.NEW_NOTE,
            )
        }
        return data.copy(
            tags = data.tags.map { it.copy(selected = it.concept_id in state.tag_concept_ids) },
            empty = empty,
            window_end_label = if (data.truncated) NotesCopy.WINDOW_END_LABEL else "",
            window_end_verb = if (data.truncated) NotesCopy.WINDOW_END_VERB else "",
            count_label = NotesFold.notes(rows.size),
        )
    }

    /** PINNED FIRST, as the core ordered them: a "Pinned" section, then the rest. */
    internal fun sections(rows: List<NotesNoteRow>, pinnedOnly: Boolean): List<NotesLibrarySection> {
        if (rows.isEmpty()) return emptyList()
        val pinned = rows.filter { it.pinned }
        val rest = rows.filterNot { it.pinned }
        if (pinnedOnly || pinned.isEmpty() || rest.isEmpty()) {
            val title = if (rest.isEmpty() && pinned.isNotEmpty()) NotesCopy.SECTION_PINNED else NotesCopy.SECTION_NOTES
            return listOf(NotesLibrarySection(head = SectionHead(title = title, count = rows.size), rows = rows))
        }
        return listOf(
            NotesLibrarySection(head = SectionHead(title = NotesCopy.SECTION_PINNED, count = pinned.size), rows = pinned),
            NotesLibrarySection(head = SectionHead(title = NotesCopy.SECTION_NOTES, count = rest.size), rows = rest),
        )
    }

    private val CHROME = NotesLibraryChrome(
        title = NotesCopy.TITLE,
        new_note = NotesCopy.NEW_NOTE,
        search_placeholder = NotesCopy.SEARCH_PLACEHOLDER,
        search_label = NotesCopy.SEARCH_LABEL,
        search_close = NotesCopy.SEARCH_CLOSE,
        retry = NotesCopy.RETRY,
        loading = NotesCopy.LOADING,
        more_title = NotesCopy.MORE_TITLE,
        trash_label = NotesCopy.TRASH_LABEL,
        sort_label = NotesCopy.SORT_LABEL,
        pinned_only_label = NotesCopy.PINNED_ONLY,
        file_title = NotesCopy.FILE_TITLE,
        sort_title = NotesCopy.SORT_TITLE,
        home = NotesCopy.HOME,
        row_menu_label = NotesCopy.ROW_MENU,
        filter_clear_label = NotesCopy.CLEAR_FILTER,
    )

    override fun rowsChanged(table: String, keys: List<String>): NotesLibraryEvent? =
        if (table in TABLES) NotesLibraryEvent(rows_changed = NotesLibraryEvent.RowsChanged(table = table)) else null

    override fun seatChanged(seat: SeatState): NotesLibraryEvent =
        NotesLibraryEvent(seat_changed = NotesLibraryEvent.SeatChanged(seat = seat))

    // ---------------------------------------------------------------------
    // Lenses
    // ---------------------------------------------------------------------

    internal object Content : dev.centraid.shared.kit.ContentLens<NotesLibraryState, NotesLibraryData> {
        override fun content(state: NotesLibraryState): ReadContent<NotesLibraryData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: NotesLibraryState, content: ReadContent<NotesLibraryData>): NotesLibraryState =
            when (content) {
                is ReadContent.Loading ->
                    state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
                is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
                is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
                is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
            }
    }

    private object Search : SearchLens<NotesLibraryState> {
        override val screenId: String = SCREEN_ID

        override fun field(state: NotesLibraryState): SearchField = state.search ?: SearchField()

        override fun with(state: NotesLibraryState, field: SearchField): NotesLibraryState = state.copy(search = field)
    }

    private object Writes : WriteLens<NotesLibraryState> {
        override fun write(state: NotesLibraryState): WriteState = state.write ?: WriteState()

        override fun with(state: NotesLibraryState, write: WriteState): NotesLibraryState = state.copy(write = write)
    }
}
