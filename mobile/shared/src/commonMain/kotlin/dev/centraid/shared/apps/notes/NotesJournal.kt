package dev.centraid.shared.apps.notes

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandStatus
import centraid.core.v1.NotesJournal
import centraid.core.v1.NotesJournalRequest
import centraid.screen.v1.EmptyState
import centraid.screen.v1.ListRow
import centraid.screen.v1.Loading
import centraid.screen.v1.NotesJournalChrome
import centraid.screen.v1.NotesJournalCompose
import centraid.screen.v1.NotesJournalData
import centraid.screen.v1.NotesJournalDaySection
import centraid.screen.v1.NotesJournalEvent
import centraid.screen.v1.NotesJournalState
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.SeatState
import centraid.screen.v1.SectionHead
import centraid.screen.v1.WriteState
import dev.centraid.design.copy.NotesCopy
import dev.centraid.design.copy.SharedCopy
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
 * THE JOURNAL (#1029 port): People-journal entries grouped by the LOCAL day
 * each was written on, newest first — the core's grouping, in the device's
 * zone, so "Today" is the core's today and never a UTC guess.
 *
 * An entry is a note People's command marks (D-1020-N3), so "New entry for
 * today" opens the journal's own sheet (`compose`) and Save writes
 * `people.add_journal_entry{mood, text, entry_date}` — the one command that
 * makes an entry a journal entry. A plain new note would land in the library.
 */
public object NotesJournalMachine : ScreenMachine<NotesJournalState, NotesJournalEvent> {
    public const val SCREEN_ID: String = "notes.journal"

    /** The note, and the tag/concept pair that marks one a journal entry. */
    public val TABLES: Set<String> = setOf("knowledge_note", "core_tag", "core_concept")

    override fun initial(): NotesJournalState = decorate(NotesJournalState(loading = Loading(first_load = true)))

    override fun reduce(state: NotesJournalState, event: NotesJournalEvent): Step<NotesJournalState> {
        val step = step(state, event)
        return Step(decorate(step.state), step.effects)
    }

    private fun step(state: NotesJournalState, event: NotesJournalEvent): Step<NotesJournalState> = when {
        event.opened != null -> Step(Content.with(state, ReadContent.Loading(true)).copy(more_open = false), listOf(read()))
        event.refreshed != null -> Step(state, listOf(read()))
        event.band != null -> Step(if (event.band.key == NotesBand.MORE) state.copy(more_open = true) else state)
        event.more_closed != null -> Step(state.copy(more_open = false))
        event.window_widened != null -> {
            val current = if (state.window == 0) NotesLibraryMachine.DEFAULT_WINDOW else state.window
            if (current >= NotesLibraryMachine.MAX_WINDOW) {
                Step(state)
            } else {
                Step(state.copy(window = minOf(current * 2, NotesLibraryMachine.MAX_WINDOW)), listOf(read()))
            }
        }
        event.data_ != null -> Step(Content.with(state, ReadContent.Data(event.data_.data_ ?: NotesJournalData())))
        event.refused != null -> Step(Content.with(state, ReadContent.Failed(event.refused.failure ?: Reads.refused(""))))
        event.denied != null -> Step(Content.with(state, ReadContent.Denied(event.denied)))
        event.rows_changed != null -> if (event.rows_changed.table in TABLES) Step(state, listOf(read())) else Step(state)
        event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))
        event.new_entry != null -> {
            val day = event.new_entry.day.ifEmpty { state.data_?.today.orEmpty() }
            when {
                state.compose != null -> Step(state)
                // No day to date it by: the answer has not landed, so nothing opens.
                day.isEmpty() -> Step(state)
                else -> Step(state.copy(compose = NotesJournalCompose(day = day), more_open = false))
            }
        }
        event.compose_edited != null -> {
            val compose = state.compose
            if (compose == null || saving(state)) {
                Step(state)
            } else {
                Step(state.copy(compose = compose.copy(mood = event.compose_edited.mood, text = event.compose_edited.text, status_label = "")))
            }
        }
        event.compose_closed != null -> if (saving(state)) Step(state) else Step(state.copy(compose = null))
        event.compose_saved != null -> save(state)
        event.write_settled != null -> {
            val key = state.write?.invoke_key
            val step = WriteLaw.settled(Writes, state, event.write_settled)
            val compose = step.state.compose
            when {
                compose == null || event.write_settled.invoke_key != key -> step
                // FILED: the sheet goes; the journal re-reads on the vault's own change.
                event.write_settled.committed -> Step(step.state.copy(compose = null), step.effects)
                else -> Step(
                    step.state.copy(
                        compose = compose.copy(
                            status_label = event.write_settled.failure?.sentence?.ifEmpty { null } ?: SharedCopy.AUTOSAVE_NOT_SAVED,
                        ),
                    ),
                    step.effects,
                )
            }
        }
        else -> Step(state)
    }

    private fun saving(state: NotesJournalState): Boolean = state.write?.phase == WriteState.Phase.PHASE_IN_FLIGHT

    private fun save(state: NotesJournalState): Step<NotesJournalState> {
        val compose = state.compose ?: return Step(state)
        val mood = compose.mood.trim()
        val text = compose.text.trim()
        if (mood.isEmpty() || text.isEmpty() || saving(state)) return Step(state)
        return WriteLaw.submit(
            Writes,
            state.copy(compose = compose.copy(status_label = "")),
            ADD_ENTRY,
            "{\"mood\":${jsonString(mood)},\"text\":${jsonString(text)},\"entry_date\":${jsonString(compose.day)}}",
            InvokeKeys.of(ADD_ENTRY, compose.day, mood, text.hashCode().toString()),
        )
    }

    /** People's command, the one that marks a note a journal entry (D-1020-N3). */
    public const val ADD_ENTRY: String = "people.add_journal_entry"

    private object Writes : WriteLens<NotesJournalState> {
        override fun write(state: NotesJournalState): WriteState = state.write ?: WriteState(phase = WriteState.Phase.PHASE_IDLE)

        override fun with(state: NotesJournalState, write: WriteState): NotesJournalState = state.copy(write = write)
    }

    private fun read(): ScreenEffect = ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)

    private fun decorate(state: NotesJournalState): NotesJournalState = state.copy(
        band = if (state.denied != null) emptyList() else NotesBand.tabs(NotesBand.JOURNAL),
        chrome = NotesJournalChrome(
            title = NotesCopy.JOURNAL_TITLE,
            new_entry = NotesCopy.NEW_ENTRY,
            retry = NotesCopy.RETRY,
            loading = NotesCopy.LOADING_JOURNAL,
            home = NotesCopy.HOME,
            origin = NotesCopy.JOURNAL_ORIGIN,
            more_title = NotesCopy.MORE_TITLE,
        ),
        trash_label = NotesCopy.TRASH_LABEL,
        compose = state.compose?.let { compose ->
            val saving = saving(state)
            compose.copy(
                title = NotesCopy.NEW_ENTRY,
                mood_placeholder = NotesCopy.JOURNAL_MOOD,
                text_placeholder = NotesCopy.JOURNAL_LINE,
                save = NotesCopy.JOURNAL_SAVE,
                close = NotesCopy.CLOSE,
                saving = saving,
                can_save = !saving && compose.mood.isNotBlank() && compose.text.isNotBlank(),
            )
        },
    )

    /** The core's days, as sections. */
    internal fun fold(journal: NotesJournal): NotesJournalData {
        val days = journal.days.filter { it.entries.isNotEmpty() }.map { day ->
            NotesJournalDaySection(
                head = SectionHead(title = CivilWords.relativeDay(day.day, journal.today), count = day.entries.size),
                day = day.day,
                rows = day.entries.map { entry ->
                    val title = NotesFold.titleOf(entry.title, entry.preview)
                    val time = if (entry.local_time.isNotEmpty()) CivilWords.clock("${day.day}T${entry.local_time}") else ""
                    val check = if (entry.check_total > 0) "${entry.check_done} of ${entry.check_total} done" else ""
                    ListRow(
                        id = entry.note_id,
                        title = title,
                        meta = time,
                        trailing = check,
                        accessibility_label = listOf(title, time, check).filter { it.isNotEmpty() }.joinToString(", "),
                    )
                },
            )
        }
        return NotesJournalData(
            days = days,
            today = journal.today,
            empty = if (days.isEmpty()) {
                EmptyState(headline = NotesCopy.JOURNAL_EMPTY_HEADLINE, body = NotesCopy.JOURNAL_EMPTY_BODY)
            } else {
                null
            },
            truncated = journal.truncated,
            window_end_verb = if (journal.truncated) NotesCopy.WINDOW_END_VERB else "",
        )
    }

    override fun rowsChanged(table: String, keys: List<String>): NotesJournalEvent? =
        if (table in TABLES) NotesJournalEvent(rows_changed = NotesJournalEvent.RowsChanged(table = table)) else null

    override fun seatChanged(seat: SeatState): NotesJournalEvent =
        NotesJournalEvent(seat_changed = NotesJournalEvent.SeatChanged(seat = seat))

    private object Content : ContentLens<NotesJournalState, NotesJournalData> {
        override fun content(state: NotesJournalState): ReadContent<NotesJournalData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: NotesJournalState, content: ReadContent<NotesJournalData>): NotesJournalState =
            when (content) {
                is ReadContent.Loading ->
                    state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
                is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
                is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
                is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
            }
    }
}

/** `notes.journal` in the device's zone, and the new entry's write. */
public object NotesJournalReads :
    ScreenQueries<NotesJournalState, NotesJournalEvent>,
    ScreenWrites<NotesJournalState, NotesJournalEvent> {
    override val screenId: String = NotesJournalMachine.SCREEN_ID
    override val tables: Set<String> = NotesJournalMachine.TABLES

    /** The command is People's (D-1020-N3); the log line says which app wrote. */
    override val appId: String = "people"

    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): NotesJournalEvent =
        NotesJournalEvent(write_settled = WriteLaw.settledOf(status, sentence, invokeKey))

    override fun requests(state: NotesJournalState, now: DeviceClock.Reading): List<AppQueryRequest> =
        listOf(AppQueryRequest(notes_journal = NotesJournalRequest(window = state.window, tz = now.zone)))

    override fun arrived(answers: List<AppQueryResponse>): NotesJournalEvent = NotesJournalEvent(
        data_ = NotesJournalEvent.DataArrived(
            data_ = NotesJournalMachine.fold(answers.firstNotNullOfOrNull { it.notes_journal } ?: NotesJournal()),
        ),
    )

    override fun refused(failure: ReadFailure): NotesJournalEvent =
        NotesJournalEvent(refused = NotesJournalEvent.ReadRefused(failure = failure))

    override fun denied(denial: AppQueryDenial): NotesJournalEvent =
        NotesJournalEvent(denied = NotesBand.denied(denial))
}

/** What both shells hold for the Journal. */
public class NotesJournalBridge : ScreenBridge<NotesJournalState, NotesJournalEvent>(
    machine = NotesJournalMachine,
    events = NotesJournalEvent.ADAPTER,
    wire = { w -> w.session.attachQueries(w.host, NotesJournalReads, NotesJournalReads, left = w.left) },
)
