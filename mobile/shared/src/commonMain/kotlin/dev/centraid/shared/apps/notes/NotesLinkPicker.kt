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
import dev.centraid.shared.kit.time.CivilWords
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
                    val subtitle = subtitleOf(t)
                    NotesLinkTargetRow(
                        entity = t.entity,
                        id = t.id,
                        title = t.title.ifBlank { NotesCopy.UNTITLED },
                        subtitle = subtitle,
                        app_id = t.app_id,
                        accessibility_label = listOf(t.title, subtitle, label).filter { it.isNotBlank() }.joinToString(", "),
                    )
                },
            )
        }
        return NotesLinkPickerData(domains = domains)
    }

    /**
     * THE SUBTITLE AS WORDS (#1047). The search index answers a raw column:
     * an event's `dtstart`, a task's `due_at`, an expense's `spent_on`, a
     * note's decoded body, else the app's name. A day or an instant is a
     * civil day in words ("Wed 11 March"); anything else is a clean excerpt —
     * its first line with the markdown marks taken out, capped.
     *
     * The day is the core's `subtitle_local_day`, read in the device's zone
     * (#1047) — never the instant's own date part. A when the core could not
     * place (an instant, no zone) says what kind of thing the row is instead.
     */
    internal fun subtitleOf(target: NotesLinkTarget): String {
        // THE INDEX'S FALLBACK IS THE APP KEY ("photos", "docs") when a row
        // has no subtitle column of its own — an identifier, not copy. The
        // row says what KIND of thing it is instead (#1047).
        if (target.subtitle.trim() == target.app_id) return kindOf(target.entity)
        if (target.subtitle_local_day.isNotBlank()) {
            val words = CivilWords.dayMonth(target.subtitle_local_day)
            if (words != target.subtitle_local_day) return words
        }
        if (WHEN_SHAPE.matches(target.subtitle.trim())) return kindOf(target.entity)
        return excerpt(target.subtitle)
    }

    /** The first non-blank line of [markdown], unmarked and capped at [EXCERPT] characters. */
    internal fun excerpt(markdown: String): String {
        val line = markdown.lineSequence()
            .map(::unmark)
            .firstOrNull { it.isNotEmpty() }
            ?: return ""
        return if (line.length <= EXCERPT) line else line.take(EXCERPT).trimEnd() + "…"
    }

    private fun unmark(line: String): String {
        var text = line.trim()
        text = BLOCK_MARK.replace(text, "")
        text = IMAGE.replace(text) { it.groupValues[1] }
        text = LINK.replace(text) { it.groupValues[1] }
        text = WIKI_LINK.replace(text) { it.groupValues[1] }
        text = INLINE_MARK.replace(text, "")
        return WHITESPACE.replace(text, " ").trim()
    }

    private const val EXCERPT: Int = 80
    /** A day, or an instant: `2026-03-11`, `2026-03-11T09:00:00Z`, `2026-03-11 09:00`. */
    private val WHEN_SHAPE = Regex("""\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?""")

    /** Heading, quote, list and task marks at a line's start — repeated, as `> - [ ] ` nests them. */
    private val BLOCK_MARK = Regex("""^(?:(?:#{1,6}|>|[-*+]|\d+[.)]|\[[ xX]\])\s+)+""")
    private val IMAGE = Regex("""!\[([^\]]*)]\([^)]*\)""")
    private val LINK = Regex("""\[([^\]]*)]\([^)]*\)""")
    private val WIKI_LINK = Regex("""\[\[([^\]]*)]]""")
    private val INLINE_MARK = Regex("""\*\*|__|~~|`|(?<![\w])[*_]|[*_](?![\w])""")
    private val WHITESPACE = Regex("""\s+""")

    /** The index's domains (`crates/search/src/domains.rs`), by entity. A photograph is a content item there. */
    private fun domainOf(entity: String): String = when (entity) {
        "knowledge.note" -> NotesCopy.DOMAIN_NOTES
        "core.party" -> NotesCopy.DOMAIN_PEOPLE
        "core.event" -> NotesCopy.DOMAIN_EVENTS
        "schedule.task" -> NotesCopy.DOMAIN_TASKS
        "core.document" -> NotesCopy.DOMAIN_DOCS
        "core.content_item", "media.asset" -> NotesCopy.DOMAIN_PHOTOS
        "tally.expense" -> NotesCopy.DOMAIN_TALLY
        else -> NotesCopy.DOMAIN_OTHER
    }

    /** What one target IS, in a word — the subtitle when its row has none. Unknown: no subtitle. */
    private fun kindOf(entity: String): String = when (entity) {
        "knowledge.note" -> NotesCopy.LINK_KIND_NOTE
        "core.party" -> NotesCopy.LINK_KIND_PERSON
        "core.event" -> NotesCopy.LINK_KIND_EVENT
        "schedule.task" -> NotesCopy.LINK_KIND_TASK
        "core.document" -> NotesCopy.LINK_KIND_DOCUMENT
        "core.content_item", "media.asset" -> NotesCopy.LINK_KIND_PHOTOGRAPH
        "tally.expense" -> NotesCopy.LINK_KIND_EXPENSE
        else -> ""
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
        listOf(AppQueryRequest(notes_link_targets = NotesLinkTargetsRequest(term = state.term.trim(), tz = now.zone)))

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
