package dev.centraid.shared.apps.notes

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.NotesJournal
import centraid.core.v1.NotesJournalRequest
import centraid.screen.v1.EmptyState
import centraid.screen.v1.ListRow
import centraid.screen.v1.Loading
import centraid.screen.v1.NotesJournalChrome
import centraid.screen.v1.NotesJournalData
import centraid.screen.v1.NotesJournalDaySection
import centraid.screen.v1.NotesJournalEvent
import centraid.screen.v1.NotesJournalState
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.SeatState
import centraid.screen.v1.SectionHead
import dev.centraid.design.copy.NotesCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.ScreenBridge
import dev.centraid.shared.kit.time.CivilWords
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import dev.centraid.shared.sync.ScreenQueries

/**
 * THE JOURNAL (#1029 port): People-journal entries grouped by the LOCAL day
 * each was written on, newest first — the core's grouping, in the device's
 * zone, so "Today" is the core's today and never a UTC guess.
 *
 * Entries are written in People (D-1020-N3); "New entry for today" is an
 * intent carrying the core's `today`, which the shell routes.
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
        else -> Step(state)
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

/** `notes.journal` in the device's zone. */
public object NotesJournalReads : ScreenQueries<NotesJournalState, NotesJournalEvent> {
    override val screenId: String = NotesJournalMachine.SCREEN_ID
    override val tables: Set<String> = NotesJournalMachine.TABLES

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
    wire = { w -> w.session.attachQueries(w.host, NotesJournalReads, left = w.left) },
)
