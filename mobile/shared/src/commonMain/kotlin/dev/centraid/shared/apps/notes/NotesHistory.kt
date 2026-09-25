package dev.centraid.shared.apps.notes

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandStatus
import centraid.core.v1.NotesHistory
import centraid.core.v1.NotesHistoryRequest
import centraid.screen.v1.Denied
import centraid.screen.v1.EmptyState
import centraid.screen.v1.Loading
import centraid.screen.v1.NotesHistoryChrome
import centraid.screen.v1.NotesHistoryData
import centraid.screen.v1.NotesHistoryEvent
import centraid.screen.v1.NotesHistoryState
import centraid.screen.v1.NotesVersionRow
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
import dev.centraid.shared.kit.time.CivilWords
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import dev.centraid.shared.sync.ScreenQueries
import dev.centraid.shared.sync.ScreenWrites

/**
 * ONE NOTE'S VERSIONS (#1029 port), newest first, the current one marked.
 *
 * RESTORING IS A WRITE AND ASKS NOTHING: `knowledge.restore_note_version`
 * records the old body as a NEW version, so a restore is itself undoable from
 * this list. One restore in flight at a time; the vault's change event
 * re-reads the list.
 */
public object NotesHistoryMachine : ScreenMachine<NotesHistoryState, NotesHistoryEvent> {
    public const val SCREEN_ID: String = "notes.history"

    public val TABLES: Set<String> = setOf("knowledge_note", "core_entity_revision")

    internal const val RESTORE_COMMAND: String = "knowledge.restore_note_version"

    private const val PREVIEW: Int = 200

    override fun initial(): NotesHistoryState = decorate(
        NotesHistoryState(loading = Loading(first_load = true), write = WriteState(phase = WriteState.Phase.PHASE_IDLE)),
    )

    override fun reduce(state: NotesHistoryState, event: NotesHistoryEvent): Step<NotesHistoryState> {
        val step = step(state, event)
        return Step(decorate(step.state), step.effects)
    }

    private fun step(state: NotesHistoryState, event: NotesHistoryEvent): Step<NotesHistoryState> = when {
        event.opened != null -> Step(
            Content.with(
                state.copy(note_id = event.opened.note_id, note_title = event.opened.note_title, restoring_content_id = ""),
                ReadContent.Loading(true),
            ),
            listOf(read()),
        )
        event.refreshed != null -> Step(state, listOf(read()))
        event.restore != null -> {
            val id = event.restore.content_id
            val row = state.data_?.rows?.firstOrNull { it.content_id == id }
            if (row == null || row.current || state.note_id.isEmpty()) {
                Step(state)
            } else {
                WriteLaw.submit(
                    Writes,
                    state.copy(restoring_content_id = id),
                    RESTORE_COMMAND,
                    "{\"note_id\":${jsonString(state.note_id)},\"content_id\":${jsonString(id)}}",
                    InvokeKeys.of(RESTORE_COMMAND, state.note_id, id),
                )
            }
        }
        event.write_settled != null -> {
            val settled = WriteLaw.settled(Writes, state, event.write_settled).state
            Step(if (settled.write?.phase == WriteState.Phase.PHASE_IN_FLIGHT) settled else settled.copy(restoring_content_id = ""))
        }
        event.data_ != null -> Step(Content.with(state, ReadContent.Data(event.data_.data_ ?: NotesHistoryData())))
        event.refused != null -> Step(Content.with(state, ReadContent.Failed(event.refused.failure ?: Reads.refused(""))))
        event.denied != null -> Step(Content.with(state, ReadContent.Denied(event.denied)))
        event.rows_changed != null -> if (event.rows_changed.table in TABLES) Step(state, listOf(read())) else Step(state)
        event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))
        else -> Step(state)
    }

    private fun read(): ScreenEffect = ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)

    private fun decorate(state: NotesHistoryState): NotesHistoryState = state.copy(
        chrome = NotesHistoryChrome(
            title = NotesCopy.HISTORY_TITLE,
            retry = NotesCopy.RETRY,
            loading = NotesCopy.LOADING_HISTORY,
            close = NotesCopy.CLOSE,
        ),
    )

    /** The core's versions, as rows. The day is the instant's own (see [NotesFold]). */
    internal fun fold(history: NotesHistory): NotesHistoryData {
        val rows = history.versions.map { version ->
            val day = version.asserted_at.take(10)
            val clock = CivilWords.clock(version.asserted_at)
            val dated = listOf(CivilWords.dayMonth(day), clock).filter { it.isNotEmpty() }.joinToString(" · ")
            val label = if (version.current) NotesCopy.CURRENT_VERSION else dated
            val preview = NotesEditorMachine.firstLine(version.body).ifEmpty { version.body.take(PREVIEW) }
            NotesVersionRow(
                content_id = version.content_id,
                label = label,
                preview = preview,
                current = version.current,
                restore_label = if (version.current) "" else NotesCopy.RESTORE,
                accessibility_label = listOf(label, preview).filter { it.isNotEmpty() }.joinToString(", "),
            )
        }
        // One version is the note as it is: there is nothing earlier.
        val empty = if (rows.size <= 1) {
            EmptyState(headline = NotesCopy.HISTORY_EMPTY_HEADLINE, body = NotesCopy.HISTORY_EMPTY_BODY)
        } else {
            null
        }
        return NotesHistoryData(rows = rows, empty = empty)
    }

    override fun rowsChanged(table: String, keys: List<String>): NotesHistoryEvent? =
        if (table in TABLES) NotesHistoryEvent(rows_changed = NotesHistoryEvent.RowsChanged(table = table)) else null

    override fun seatChanged(seat: SeatState): NotesHistoryEvent =
        NotesHistoryEvent(seat_changed = NotesHistoryEvent.SeatChanged(seat = seat))

    private object Content : ContentLens<NotesHistoryState, NotesHistoryData> {
        override fun content(state: NotesHistoryState): ReadContent<NotesHistoryData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: NotesHistoryState, content: ReadContent<NotesHistoryData>): NotesHistoryState =
            when (content) {
                is ReadContent.Loading ->
                    state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
                is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
                is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
                is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
            }
    }

    private object Writes : WriteLens<NotesHistoryState> {
        override fun write(state: NotesHistoryState): WriteState = state.write ?: WriteState()

        override fun with(state: NotesHistoryState, write: WriteState): NotesHistoryState = state.copy(write = write)
    }
}

/** `notes.history` for the note on screen, and the restore's settle. */
public object NotesHistoryReads :
    ScreenQueries<NotesHistoryState, NotesHistoryEvent>,
    ScreenWrites<NotesHistoryState, NotesHistoryEvent> {
    override val screenId: String = NotesHistoryMachine.SCREEN_ID
    override val tables: Set<String> = NotesHistoryMachine.TABLES
    override val appId: String = "notes"

    /** Null before the screen knows which note: a history of nothing is not a read. */
    override fun requests(state: NotesHistoryState, now: DeviceClock.Reading): List<AppQueryRequest>? =
        state.note_id.takeIf { it.isNotEmpty() }?.let {
            listOf(AppQueryRequest(notes_history = NotesHistoryRequest(note_id = it, tz = now.zone)))
        }

    override fun arrived(answers: List<AppQueryResponse>): NotesHistoryEvent = NotesHistoryEvent(
        data_ = NotesHistoryEvent.DataArrived(
            data_ = NotesHistoryMachine.fold(answers.firstNotNullOfOrNull { it.notes_history } ?: NotesHistory()),
        ),
    )

    override fun refused(failure: ReadFailure): NotesHistoryEvent =
        NotesHistoryEvent(refused = NotesHistoryEvent.ReadRefused(failure = failure))

    /** A cycle or an over-long chain is the core's denial (D-1020-N2): the gate, with its words. */
    override fun denied(denial: AppQueryDenial): NotesHistoryEvent = NotesHistoryEvent(
        denied = Denied(
            title = NotesCopy.HISTORY_TITLE,
            body = denial.message?.takeIf { it.isNotBlank() } ?: NotesCopy.DENIED_BODY,
        ),
    )

    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): NotesHistoryEvent =
        NotesHistoryEvent(write_settled = WriteLaw.settledOf(status, sentence, invokeKey))
}

/** What both shells hold for one note's history. */
public class NotesHistoryBridge : ScreenBridge<NotesHistoryState, NotesHistoryEvent>(
    machine = NotesHistoryMachine,
    events = NotesHistoryEvent.ADAPTER,
    wire = { w -> w.session.attachQueries(w.host, NotesHistoryReads, NotesHistoryReads, left = w.left) },
)
