package dev.centraid.shared.apps.notes

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandStatus
import centraid.core.v1.NotesLibraryRequest
import centraid.core.v1.NotesNotebooksRequest
import centraid.core.v1.NotesSearchRequest
import centraid.core.v1.NotesSort
import centraid.screen.v1.NotesLibraryData
import centraid.screen.v1.NotesLibraryEvent
import centraid.screen.v1.NotesLibrarySort
import centraid.screen.v1.NotesLibraryState
import centraid.screen.v1.NotesTagChip
import centraid.screen.v1.ReadFailure
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.sync.ScreenQueries
import dev.centraid.shared.sync.ScreenWrites

/**
 * WHAT THE LIBRARY ASKS THE CORE (#1029 port).
 *
 * The shelf is `notes.library` with the state's parameters, beside
 * `notes.notebooks` for the file-into sheet (the library's own notebook list
 * carries no counts, and the counts are what tell a notebook from an album).
 * While a term is typed the read is `notes.search` alone.
 *
 * The answers are folded HERE into finished rows ([NotesFold]); the machine
 * adds what depends on its parameters (the empty sentence, the selected
 * chips, the counts' words).
 */
public object NotesLibraryReads :
    ScreenQueries<NotesLibraryState, NotesLibraryEvent>,
    ScreenWrites<NotesLibraryState, NotesLibraryEvent> {
    override val screenId: String = NotesLibraryMachine.SCREEN_ID

    override val tables: Set<String> = NotesLibraryMachine.TABLES

    override val appId: String = "notes"

    override fun requests(state: NotesLibraryState, now: DeviceClock.Reading): List<AppQueryRequest> =
        if (NotesLibraryMachine.searchActive(state)) {
            listOf(AppQueryRequest(notes_search = NotesSearchRequest(term = state.search?.term?.trim() ?: "")))
        } else {
            listOf(
                AppQueryRequest(notes_library = libraryRequest(state).copy(tz = now.zone)),
                AppQueryRequest(notes_notebooks = NotesNotebooksRequest()),
            )
        }

    internal fun libraryRequest(state: NotesLibraryState): NotesLibraryRequest = NotesLibraryRequest(
        window = state.window,
        sort = when (state.sort) {
            NotesLibrarySort.NOTES_LIBRARY_SORT_CREATED -> NotesSort.NOTES_SORT_CREATED
            NotesLibrarySort.NOTES_LIBRARY_SORT_TITLE -> NotesSort.NOTES_SORT_TITLE
            else -> NotesSort.NOTES_SORT_UPDATED
        },
        pinned_only = state.pinned_only,
        notebook_id = state.notebook_id,
        unfiled_only = state.unfiled_only && state.notebook_id.isEmpty(),
        tag_concept_ids = state.tag_concept_ids,
    )

    /** By ARM: a search answer, or the library with its notebooks. */
    override fun arrived(answers: List<AppQueryResponse>): NotesLibraryEvent {
        answers.firstNotNullOfOrNull { it.notes_search }?.let { search ->
            return NotesLibraryEvent(
                search_arrived = NotesLibraryEvent.SearchArrived(rows = search.hits.map(NotesFold::hit)),
            )
        }
        val library = answers.firstNotNullOfOrNull { it.notes_library }
        val notebooks = answers.firstNotNullOfOrNull { it.notes_notebooks }
        val rows = library?.notes?.map(NotesFold::row) ?: emptyList()
        return NotesLibraryEvent(
            data_ = NotesLibraryEvent.DataArrived(
                data_ = NotesLibraryData(
                    sections = NotesLibraryMachine.sections(rows, pinnedOnly = false),
                    tags = library?.tags?.map { NotesTagChip(concept_id = it.concept_id, label = it.label) } ?: emptyList(),
                    truncated = library?.truncated ?: false,
                ),
                notebooks = NotesFold.choices(notebooks?.notebooks ?: emptyList()),
            ),
        )
    }

    override fun refused(failure: ReadFailure): NotesLibraryEvent =
        NotesLibraryEvent(refused = NotesLibraryEvent.ReadRefused(failure = failure))

    override fun denied(denial: AppQueryDenial): NotesLibraryEvent =
        NotesLibraryEvent(denied = NotesBand.denied(denial))

    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): NotesLibraryEvent =
        NotesLibraryEvent(write_settled = WriteLaw.settledOf(status, sentence, invokeKey))
}
