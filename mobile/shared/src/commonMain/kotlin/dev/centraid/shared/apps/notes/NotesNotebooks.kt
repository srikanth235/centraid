package dev.centraid.shared.apps.notes

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandStatus
import centraid.core.v1.NotesNotebooksRequest
import centraid.screen.v1.EmptyState
import centraid.screen.v1.ListRow
import centraid.screen.v1.Loading
import centraid.screen.v1.NotesNotebooksChrome
import centraid.screen.v1.NotesNotebooksData
import centraid.screen.v1.NotesNotebooksEvent
import centraid.screen.v1.NotesNotebooksState
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.SeatState
import centraid.screen.v1.WriteState
import dev.centraid.design.copy.NotesCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.InvokeKeys
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.ScreenBridge
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.kit.WriteLens
import dev.centraid.shared.kit.jsonString
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import dev.centraid.shared.sync.ScreenQueries
import dev.centraid.shared.sync.ScreenWrites

/**
 * NOTEBOOKS (#1029 port): "Unfiled", then every notebook with its count, and
 * a create sheet. Picking a row is an intent — the shell opens the library
 * filtered to it (`NotesLibraryEvent.Opened`).
 *
 * ALBUMS NEVER ARRIVE: the core's read is `kind = 'notebook'` (rung six), so
 * nothing here tells a notebook from an album.
 */
public object NotesNotebooksMachine : ScreenMachine<NotesNotebooksState, NotesNotebooksEvent> {
    public const val SCREEN_ID: String = "notes.notebooks"

    /** The id of the "Unfiled" row, which is no collection. */
    public const val UNFILED: String = "unfiled"

    public val TABLES: Set<String> = setOf("core_collection", "core_collection_entry", "knowledge_note")

    internal const val CREATE_COMMAND: String = "knowledge.create_notebook"

    override fun initial(): NotesNotebooksState = decorate(
        NotesNotebooksState(loading = Loading(first_load = true), write = WriteState(phase = WriteState.Phase.PHASE_IDLE)),
    )

    override fun reduce(state: NotesNotebooksState, event: NotesNotebooksEvent): Step<NotesNotebooksState> {
        val step = step(state, event)
        return Step(decorate(step.state), step.effects)
    }

    private fun step(state: NotesNotebooksState, event: NotesNotebooksEvent): Step<NotesNotebooksState> = when {
        event.opened != null -> Step(Content.with(state, ReadContent.Loading(true)).copy(more_open = false), listOf(read()))
        event.refreshed != null -> Step(state, listOf(read()))
        event.band != null -> Step(if (event.band.key == NotesBand.MORE) state.copy(more_open = true) else state)
        event.more_closed != null -> Step(state.copy(more_open = false))
        event.create_opened != null -> Step(state.copy(creating = true, draft_name = ""))
        event.name != null -> Step(state.copy(draft_name = event.name.name))
        event.create_dismissed != null -> Step(state.copy(creating = false, draft_name = ""))
        event.create_confirmed != null -> {
            val name = state.draft_name.trim()
            if (name.isEmpty() || state.write?.phase == WriteState.Phase.PHASE_IN_FLIGHT) {
                Step(state)
            } else {
                WriteLaw.submit(
                    Writes,
                    state,
                    CREATE_COMMAND,
                    "{\"name\":${jsonString(name)}}",
                    InvokeKeys.of(CREATE_COMMAND, "notebook", name),
                )
            }
        }
        // A CREATE THAT COMMITTED closes the sheet; a refused one keeps the
        // name typed, with the sentence over it.
        event.write_settled != null -> {
            val settled = WriteLaw.settled(Writes, state, event.write_settled)
            val committed = settled.state.write?.phase == WriteState.Phase.PHASE_COMMITTED &&
                event.write_settled.invoke_key == state.write?.invoke_key
            Step(if (committed) settled.state.copy(creating = false, draft_name = "") else settled.state)
        }
        event.data_ != null -> Step(Content.with(state, ReadContent.Data(event.data_.data_ ?: NotesNotebooksData())))
        event.refused != null -> Step(Content.with(state, ReadContent.Failed(event.refused.failure ?: Reads.refused(""))))
        event.denied != null -> Step(Content.with(state, ReadContent.Denied(event.denied)))
        event.rows_changed != null -> if (event.rows_changed.table in TABLES) Step(state, listOf(read())) else Step(state)
        event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))
        else -> Step(state)
    }

    private fun read(): ScreenEffect = ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)

    private fun decorate(state: NotesNotebooksState): NotesNotebooksState = state.copy(
        band = if (state.denied != null) emptyList() else NotesBand.tabs(NotesBand.NOTEBOOKS),
        chrome = CHROME,
        trash_label = NotesCopy.TRASH_LABEL,
        create_enabled = state.draft_name.isNotBlank() && state.write?.phase != WriteState.Phase.PHASE_IN_FLIGHT,
    )

    private val CHROME = NotesNotebooksChrome(
        title = NotesCopy.NOTEBOOKS_TITLE,
        new_notebook = NotesCopy.NEW_NOTEBOOK,
        name_placeholder = NotesCopy.NOTEBOOK_NAME,
        create = NotesCopy.CREATE,
        cancel = NotesCopy.CANCEL,
        retry = NotesCopy.RETRY,
        loading = NotesCopy.LOADING_NOTEBOOKS,
        home = NotesCopy.HOME,
        more_title = NotesCopy.MORE_TITLE,
    )

    /** The rows, from the core's notebooks: "Unfiled" first. */
    internal fun fold(notebooks: List<centraid.core.v1.NotesNotebook>): NotesNotebooksData {
        val rows = notebooks.map { notebook ->
            val name = NotesFold.nameOf(notebook)
            val count = NotesFold.notes(notebook.note_count)
            ListRow(id = notebook.notebook_id, title = name, trailing = count, accessibility_label = "$name, $count")
        }
        return NotesNotebooksData(
            rows = listOf(ListRow(id = UNFILED, title = NotesCopy.UNFILED_ROW, accessibility_label = NotesCopy.UNFILED_ROW)) + rows,
            empty = if (rows.isEmpty()) {
                EmptyState(
                    headline = NotesCopy.NOTEBOOKS_EMPTY_HEADLINE,
                    body = NotesCopy.NOTEBOOKS_EMPTY_BODY,
                    action_label = NotesCopy.NEW_NOTEBOOK,
                )
            } else {
                null
            },
        )
    }

    override fun rowsChanged(table: String, keys: List<String>): NotesNotebooksEvent? =
        if (table in TABLES) NotesNotebooksEvent(rows_changed = NotesNotebooksEvent.RowsChanged(table = table)) else null

    override fun seatChanged(seat: SeatState): NotesNotebooksEvent =
        NotesNotebooksEvent(seat_changed = NotesNotebooksEvent.SeatChanged(seat = seat))

    private object Content : ContentLens<NotesNotebooksState, NotesNotebooksData> {
        override fun content(state: NotesNotebooksState): ReadContent<NotesNotebooksData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: NotesNotebooksState, content: ReadContent<NotesNotebooksData>): NotesNotebooksState =
            when (content) {
                is ReadContent.Loading ->
                    state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
                is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
                is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
                is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
            }
    }

    private object Writes : WriteLens<NotesNotebooksState> {
        override fun write(state: NotesNotebooksState): WriteState = state.write ?: WriteState()

        override fun with(state: NotesNotebooksState, write: WriteState): NotesNotebooksState = state.copy(write = write)
    }
}

/** `notes.notebooks`, and the create's settle. */
public object NotesNotebooksReads :
    ScreenQueries<NotesNotebooksState, NotesNotebooksEvent>,
    ScreenWrites<NotesNotebooksState, NotesNotebooksEvent> {
    override val screenId: String = NotesNotebooksMachine.SCREEN_ID
    override val tables: Set<String> = NotesNotebooksMachine.TABLES
    override val appId: String = "notes"

    override fun requests(state: NotesNotebooksState, now: DeviceClock.Reading): List<AppQueryRequest> =
        listOf(AppQueryRequest(notes_notebooks = NotesNotebooksRequest()))

    override fun arrived(answers: List<AppQueryResponse>): NotesNotebooksEvent = NotesNotebooksEvent(
        data_ = NotesNotebooksEvent.DataArrived(
            data_ = NotesNotebooksMachine.fold(answers.firstNotNullOfOrNull { it.notes_notebooks }?.notebooks ?: emptyList()),
        ),
    )

    override fun refused(failure: ReadFailure): NotesNotebooksEvent =
        NotesNotebooksEvent(refused = NotesNotebooksEvent.ReadRefused(failure = failure))

    override fun denied(denial: AppQueryDenial): NotesNotebooksEvent =
        NotesNotebooksEvent(denied = NotesBand.denied(denial))

    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): NotesNotebooksEvent =
        NotesNotebooksEvent(write_settled = WriteLaw.settledOf(status, sentence, invokeKey))
}

/** What both shells hold for Notebooks. */
public class NotesNotebooksBridge : ScreenBridge<NotesNotebooksState, NotesNotebooksEvent>(
    machine = NotesNotebooksMachine,
    events = NotesNotebooksEvent.ADAPTER,
    wire = { w -> w.session.attachQueries(w.host, NotesNotebooksReads, NotesNotebooksReads, left = w.left) },
)
