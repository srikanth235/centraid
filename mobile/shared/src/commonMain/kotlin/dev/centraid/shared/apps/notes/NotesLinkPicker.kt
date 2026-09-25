package dev.centraid.shared.apps.notes

import centraid.core.v1.AppQueryDenial
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.NotesLinkTarget
import centraid.core.v1.NotesLinkTargetsRequest
import centraid.screen.v1.EmptyState
import centraid.screen.v1.Loading
import centraid.screen.v1.NotesLinkDomain
import centraid.screen.v1.NotesLinkPickerChrome
import centraid.screen.v1.NotesLinkPickerData
import centraid.screen.v1.NotesLinkPickerEvent
import centraid.screen.v1.NotesLinkPickerState
import centraid.screen.v1.NotesLinkTargetRow
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.SeatState
import centraid.screen.v1.SectionHead
import dev.centraid.design.copy.NotesCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.ScreenBridge
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import dev.centraid.shared.sync.ScreenQueries

/**
 * THE POWERBOX (#1029 port, D-1020-N1): what a note can link to, grouped by
 * the domain it lives in. A choices sheet over the editor; a pick is an
 * intent the shell forwards to the editor (`NotesEditorEvent.LinkPicked`).
 *
 * A transient sheet over search results: it re-reads on a new term and on
 * nothing else, so it declares no table.
 */
public object NotesLinkPickerMachine : ScreenMachine<NotesLinkPickerState, NotesLinkPickerEvent> {
    public const val SCREEN_ID: String = "notes.link_targets"

    public val TABLES: Set<String> = emptySet()

    override fun initial(): NotesLinkPickerState = NotesLinkPickerState(loading = Loading(first_load = true), chrome = CHROME)

    override fun reduce(state: NotesLinkPickerState, event: NotesLinkPickerEvent): Step<NotesLinkPickerState> = when {
        event.opened != null -> Step(
            Content.with(state.copy(term = event.opened.term, chrome = CHROME), ReadContent.Loading(true)),
            listOf(read()),
        )
        // The rows on screen stay while the new term reads.
        event.term != null ->
            if (event.term.term == state.term) Step(state) else Step(state.copy(term = event.term.term), listOf(read()))
        event.data_ != null -> Step(Content.with(state, ReadContent.Data(decorate(state, event.data_.data_ ?: NotesLinkPickerData()))))
        event.refused != null -> Step(Content.with(state, ReadContent.Failed(event.refused.failure ?: Reads.refused(""))))
        event.denied != null -> Step(Content.with(state, ReadContent.Denied(event.denied)))
        event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))
        else -> Step(state)
    }

    private fun read(): ScreenEffect = ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)

    /** The empty sentence depends on whether a term was typed. */
    private fun decorate(state: NotesLinkPickerState, data: NotesLinkPickerData): NotesLinkPickerData = data.copy(
        empty = when {
            data.domains.isNotEmpty() -> null
            state.term.isBlank() -> EmptyState(headline = NotesCopy.LINK_EMPTY_HEADLINE, body = NotesCopy.LINK_EMPTY_BODY)
            else -> EmptyState(headline = NotesCopy.LINK_EMPTY_HEADLINE, body = NotesCopy.LINK_NO_MATCH_BODY)
        },
    )

    /** The core's targets, grouped in its domain order. */
    internal fun fold(targets: List<NotesLinkTarget>): NotesLinkPickerData {
        val domains = targets.groupBy { domainOf(it.entity) }.map { (label, rows) ->
            NotesLinkDomain(
                head = SectionHead(title = label, count = rows.size),
                rows = rows.map { t ->
                    NotesLinkTargetRow(
                        entity = t.entity,
                        id = t.id,
                        title = t.title.ifBlank { NotesCopy.UNTITLED },
                        subtitle = t.subtitle,
                        app_id = t.app_id,
                        accessibility_label = listOf(t.title, t.subtitle, label).filter { it.isNotBlank() }.joinToString(", "),
                    )
                },
            )
        }
        return NotesLinkPickerData(domains = domains)
    }

    private fun domainOf(entity: String): String = when (entity) {
        "knowledge.note" -> NotesCopy.DOMAIN_NOTES
        "core.party" -> NotesCopy.DOMAIN_PEOPLE
        "core.event" -> NotesCopy.DOMAIN_EVENTS
        "schedule.task" -> NotesCopy.DOMAIN_TASKS
        "core.document" -> NotesCopy.DOMAIN_DOCS
        "media.asset" -> NotesCopy.DOMAIN_PHOTOS
        else -> NotesCopy.DOMAIN_OTHER
    }

    private val CHROME = NotesLinkPickerChrome(
        title = NotesCopy.LINK_TITLE,
        search_placeholder = NotesCopy.LINK_SEARCH,
        close = NotesCopy.CLOSE,
        retry = NotesCopy.RETRY,
        loading = NotesCopy.LOADING_LINKS,
        foot = NotesCopy.POWERBOX_FOOT,
    )

    override fun rowsChanged(table: String, keys: List<String>): NotesLinkPickerEvent? = null

    override fun seatChanged(seat: SeatState): NotesLinkPickerEvent =
        NotesLinkPickerEvent(seat_changed = NotesLinkPickerEvent.SeatChanged(seat = seat))

    private object Content : ContentLens<NotesLinkPickerState, NotesLinkPickerData> {
        override fun content(state: NotesLinkPickerState): ReadContent<NotesLinkPickerData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: NotesLinkPickerState, content: ReadContent<NotesLinkPickerData>): NotesLinkPickerState =
            when (content) {
                is ReadContent.Loading -> if (state.data_ != null && !content.firstLoad) {
                    state
                } else {
                    state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
                }
                is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
                is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
                is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
            }
    }
}

/**
 * `notes.link_targets` for the term on screen.
 *
 * AN ANSWER DOES NOT SAY WHICH TERM IT ANSWERS (`ScreenQueries.arrived` is
 * handed the answers, not the requests), so two answers landing out of order
 * can draw an older term's targets — the port report's kit need.
 */
public object NotesLinkPickerReads : ScreenQueries<NotesLinkPickerState, NotesLinkPickerEvent> {
    override val screenId: String = NotesLinkPickerMachine.SCREEN_ID
    override val tables: Set<String> = NotesLinkPickerMachine.TABLES

    override fun requests(state: NotesLinkPickerState, now: DeviceClock.Reading): List<AppQueryRequest> =
        listOf(AppQueryRequest(notes_link_targets = NotesLinkTargetsRequest(term = state.term.trim())))

    override fun arrived(answers: List<AppQueryResponse>): NotesLinkPickerEvent = NotesLinkPickerEvent(
        data_ = NotesLinkPickerEvent.DataArrived(
            data_ = NotesLinkPickerMachine.fold(answers.firstNotNullOfOrNull { it.notes_link_targets }?.targets ?: emptyList()),
        ),
    )

    override fun refused(failure: ReadFailure): NotesLinkPickerEvent =
        NotesLinkPickerEvent(refused = NotesLinkPickerEvent.ReadRefused(failure = failure))

    override fun denied(denial: AppQueryDenial): NotesLinkPickerEvent =
        NotesLinkPickerEvent(denied = NotesBand.denied(denial))
}

/** What both shells hold for the powerbox sheet. */
public class NotesLinkPickerBridge : ScreenBridge<NotesLinkPickerState, NotesLinkPickerEvent>(
    machine = NotesLinkPickerMachine,
    events = NotesLinkPickerEvent.ADAPTER,
    wire = { w -> w.session.attachQueries(w.host, NotesLinkPickerReads, left = w.left) },
)
