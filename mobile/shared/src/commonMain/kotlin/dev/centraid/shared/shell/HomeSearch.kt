package dev.centraid.shared.shell

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.VaultSearchHit
import centraid.core.v1.VaultSearchRequest
import centraid.screen.v1.ChatCard
import centraid.screen.v1.Denied
import centraid.screen.v1.EmptyState
import centraid.screen.v1.HomeSearchChrome
import centraid.screen.v1.HomeSearchData
import centraid.screen.v1.HomeSearchEvent
import centraid.screen.v1.HomeSearchGroup
import centraid.screen.v1.HomeSearchResting
import centraid.screen.v1.HomeSearchRow
import centraid.screen.v1.HomeSearchState
import centraid.screen.v1.Loading
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.SearchField
import centraid.screen.v1.SeatState
import dev.centraid.design.copy.SharedCopy
import dev.centraid.shared.kit.ScreenBridge
import dev.centraid.shared.kit.SearchContainers
import dev.centraid.shared.kit.SearchLaw
import dev.centraid.shared.kit.SearchLens
import dev.centraid.shared.nav.AppHomes
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import dev.centraid.shared.sync.ScreenQueries
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * HOME'S SEARCH (R-CHROME-6): one field over every app, the answer
 * grouped by the app each row opens in.
 *
 * The read is `vault_search`, which is Notes' powerbox loader asked from Home
 * (D-1020-N1) — one probe per search domain, and a Locker item is a hit like the
 * rest (#1135): the index holds its plain text whether or not Locker is locked, a
 * sealed secret never, and a tap on the row passes through Locker's own lock wall
 * like any Locker destination. This machine groups the hits in Home's tile order, names each row's kind, and
 * says where a tap goes ([HomeSearchRow.target], the reference a chat card
 * carries, so the shell's one router opens it).
 *
 * **LATEST WINS.** Every term the member types reads; an answer names the term
 * it answers ([HomeSearchReads.arrived] is handed the request beside the
 * answer), and one for a term since changed or cleared is dropped rather than
 * drawn over the field.
 *
 * **RECENT SEARCHES ARE THIS SESSION'S.** A term is recorded when the member
 * opens a row from it or presses the keyboard's search key, newest first and
 * at most [RECENT_MAX]; never persisted and never read from the vault. They
 * survive Cancel, which clears the field and nothing else.
 *
 * A transient screen over search results: it re-reads on a new term and on
 * nothing else, so it declares no table (the powerbox's ruling).
 */
public object HomeSearchMachine : ScreenMachine<HomeSearchState, HomeSearchEvent> {
    public const val SCREEN_ID: String = "home.search"

    public val TABLES: Set<String> = emptySet()

    /** How many recent searches the resting screen offers. */
    public const val RECENT_MAX: Int = 4

    override fun initial(): HomeSearchState =
        HomeSearchState(field_ = SearchField(open_ = true), chrome = CHROME, resting = resting(emptyList()))

    override fun reduce(state: HomeSearchState, event: HomeSearchEvent): Step<HomeSearchState> = when {
        // OPENED FROM HOME'S BAR: a fresh field, the recent searches under it, and the shell's
        // word on whether it has a Chat tab (R-1097-24): the shell says it, no view guesses it.
        event.opened != null ->
            Step(rest(state.copy(field_ = SearchField(open_ = true), chrome = CHROME, chat_tab = event.opened.chat_tab)))
        event.term != null -> term(state, event.term.term)
        event.suggestion != null -> term(state, event.suggestion.term)
        event.row != null -> Step(record(state))
        // A CONTAINER OPENED FROM THE ANSWER is a row opened: the term is a search the member made.
        event.container != null -> Step(record(state))
        // THE ASK ACTION is the shell's to carry out (Chat is a tab, not a screen
        // this machine can push); the term is a search the member made.
        event.asked != null -> Step(record(state))
        event.submitted != null -> Step(record(state))
        // CLOSING CLEARS THE TERM (R-1046-6): the next open starts empty.
        event.cancelled != null -> Step(rest(state.copy(field_ = SearchField())))
        event.refreshed != null -> {
            val asked = termOf(state)
            if (asked.isEmpty()) Step(state) else Step(loading(state), listOf(read()))
        }
        event.data_ != null ->
            Step(arrived(state, event.data_.data_ ?: HomeSearchData(), event.data_.term, event.data_.corrected))
        event.refused != null ->
            if (termOf(state).isEmpty()) Step(state) else Step(state.failed(event.refused.failure ?: Reads.refused("")))
        event.denied != null ->
            if (termOf(state).isEmpty()) Step(state) else Step(state.deniedBy(event.denied))
        event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))
        // ANOTHER VAULT IN FRONT: nothing typed or found in the last one
        // follows the member into this one — not the term, the rows, or the
        // recent searches.
        event.vault_changed != null -> Step(initial().copy(seat = state.seat, chat_tab = state.chat_tab))
        else -> Step(state)
    }

    /** A new term. A blank one rests and reads nothing; the rows on screen stay while a new one reads. */
    private fun term(state: HomeSearchState, term: String): Step<HomeSearchState> {
        val field = state.field_ ?: SearchField()
        if (field.open_ && field.term == term && state.resting == null) return Step(state)
        // A NEW TERM clears the words the last one was corrected to, and the Ask it offered.
        val next = state.copy(field_ = field.copy(open_ = true, term = term, corrected = "", ask_row = null))
        if (term.isBlank()) return Step(rest(next.copy(field_ = next.field_?.copy(answered_term = ""))))
        return Step(loading(next), listOf(read()))
    }

    private fun read(): ScreenEffect = ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)

    private fun termOf(state: HomeSearchState): String = state.field_?.term?.trim().orEmpty()

    /** The answer, if it answers the term on screen. */
    private fun arrived(
        state: HomeSearchState,
        data: HomeSearchData,
        answered: String,
        corrected: String,
    ): HomeSearchState {
        val field = state.field_ ?: return state
        if (!field.open_ || termOf(state).isEmpty() || termOf(state) != answered.trim()) return state
        // THE CHAT GROUP IS DRAWN ONLY WHERE THE SHELL HAS A CHAT TAB (R-1097-24): the core answers
        // the member's conversations as Home hits whatever the shell, and a row that opens nothing
        // is not a result. Android has no Chat tab, so for it the group is absent, and a term that
        // only a conversation holds is the no-match state, not a row that goes nowhere.
        val kept = if (state.chat_tab) data else data.copy(groups = data.groups.filterNot { it.app_id == CHAT })
        val shown = if (kept.groups.isEmpty()) {
            // NOTHING MATCHED: one sentence; the Ask row under it is the law's, as it is under rows.
            kept.copy(
                empty = EmptyState(
                    headline = SharedCopy.HOME_SEARCH_NO_MATCH_HEADLINE,
                    body = SharedCopy.HOME_SEARCH_NO_MATCH_BODY.replace("{term}", answered.trim()),
                ),
            )
        } else {
            kept.copy(empty = null)
        }
        // The words the rows answer and the Ask row are kept by the law, for an answer still current.
        return SearchLaw.answered(Field, state, answered.trim(), corrected).copy(
            resting = null,
            loading = null,
            failure = null,
            denied = null,
            data_ = shown,
        )
    }

    /** The term on screen, recorded as this session's newest search. */
    private fun record(state: HomeSearchState): HomeSearchState {
        val asked = termOf(state)
        if (asked.isEmpty()) return state
        val recent = (listOf(asked) + state.recent.filterNot { it.equals(asked, ignoreCase = true) }).take(RECENT_MAX)
        return state.copy(recent = recent)
    }

    private object Field : SearchLens<HomeSearchState> {
        override val screenId: String = SCREEN_ID
        // Home asks across every app: the chat it opens is unscoped (#1135).
        override val askScope: String = ""

        override fun field(state: HomeSearchState): SearchField = state.field_ ?: SearchField()

        override fun with(state: HomeSearchState, field: SearchField): HomeSearchState = state.copy(field_ = field)
    }

    private fun rest(state: HomeSearchState): HomeSearchState = state.copy(
        resting = resting(state.recent),
        loading = null,
        failure = null,
        denied = null,
        data_ = null,
    )

    private fun loading(state: HomeSearchState): HomeSearchState =
        if (state.data_ != null) {
            state
        } else {
            state.copy(resting = null, loading = Loading(first_load = true), failure = null, denied = null, data_ = null)
        }

    private fun HomeSearchState.failed(failure: ReadFailure): HomeSearchState =
        copy(resting = null, loading = null, failure = failure, denied = null, data_ = null)

    private fun HomeSearchState.deniedBy(denied: Denied): HomeSearchState =
        copy(resting = null, loading = null, failure = null, denied = denied, data_ = null)

    private fun resting(recent: List<String>): HomeSearchResting = HomeSearchResting(
        note = SharedCopy.HOME_SEARCH_NOTE,
        suggestions_label = if (recent.isEmpty()) "" else SharedCopy.HOME_SEARCH_RECENT_LABEL,
        suggestions = recent,
    )

    /**
     * THE CORE'S HITS, GROUPED BY APP IN HOME'S TILE ORDER. A Locker hit is
     * the item's plain title and kind, never a secret (the index holds none);
     * it sits in Locker's group and opens through Locker's lock wall.
     *
     * A HIT IS GROUPED UNDER THE APP A MEMBER OPENS IT IN (#1128, R-1128-7): a
     * task hit sits in Agenda's group, among its events, and the group's header,
     * mark and test id are Agenda's. The row keeps its own `app_id`, so it still
     * opens `TasksDetail` through `RowRoutes` (R-CHROME-6: a row opens in its own
     * app's router).
     */
    public fun fold(hits: List<VaultSearchHit>): HomeSearchData {
        val order = SpringboardPolicy.SPRINGBOARD_ORDER
        val groups = hits
            .filter { it.app_id.isNotBlank() }
            .groupBy { AppHomes.appOf(it.app_id) }
            .entries
            .sortedBy { (app, _) -> order.indexOf(app).let { if (it < 0) order.size else it } }
            .map { (app, hits) ->
                val label = if (app == CHAT) {
                    SharedCopy.HOME_SEARCH_CHAT_GROUP
                } else {
                    AppHomes.nameOf(app)
                }
                // A CONTAINER (#1097) IS A HIT OF ITS APP'S GROUP, drawn before that app's rows;
                // `SearchContainers` says which hits are one and how each opens.
                val (containers, rows) = hits
                    .map { hit -> SearchContainers.of(hit.entity, hit.id, hit.app_id, hit.title) to hit }
                    .partition { (container, _) -> container != null }
                val count = hits.size
                HomeSearchGroup(
                    app_id = app,
                    label = label,
                    count = count,
                    accessibility_label = (if (count == 1) SharedCopy.HOME_SEARCH_GROUP_ONE else SharedCopy.HOME_SEARCH_GROUP)
                        .replace("{name}", label)
                        .replace("{n}", count.toString()),
                    containers = containers.mapNotNull { it.first },
                    rows = rows.map { (_, hit) -> row(hit) },
                )
            }
        return HomeSearchData(groups = groups)
    }

    private fun row(hit: VaultSearchHit): HomeSearchRow {
        val kind = kindOf(hit.entity)
        val opens = hit.open_id.ifBlank { hit.id }
        return HomeSearchRow(
            entity = hit.entity,
            id = hit.id,
            app_id = hit.app_id,
            kind_label = kind,
            title = hit.title,
            accessibility_label = listOf(kind, hit.title).filter { it.isNotBlank() }.joinToString(", "),
            target = ChatCard(app = hit.app_id, entity = routeEntityOf(hit.entity), id = opens, title = hit.title),
        )
    }

    /** What one row IS, in a word — the soft column beside its title. */
    private fun kindOf(entity: String): String = when (entity) {
        "note" -> SharedCopy.SEARCH_KIND_NOTE
        "person" -> SharedCopy.SEARCH_KIND_PERSON
        "event" -> SharedCopy.SEARCH_KIND_EVENT
        "task" -> SharedCopy.SEARCH_KIND_TASK
        "photo" -> SharedCopy.SEARCH_KIND_PHOTO
        "document" -> SharedCopy.SEARCH_KIND_DOCUMENT
        LOCKER_ITEM -> SharedCopy.SEARCH_KIND_LOCKER_ITEM
        CHAT_THREAD -> SharedCopy.SEARCH_KIND_CHAT
        else -> ""
    }

    /**
     * The index's entity in the router's vocabulary (`ChatCard.entity`): the
     * noun a chat card names its row by. Unknown: empty, which the router
     * opens as the app's home.
     */
    private fun routeEntityOf(entity: String): String = when (entity) {
        "note" -> "note"
        "person" -> "person"
        "event" -> "event"
        "task" -> "task"
        "photo" -> "photo"
        "document" -> "document"
        LOCKER_ITEM -> LOCKER_ITEM
        CHAT_THREAD -> CHAT_THREAD_NOUN
        else -> ""
    }

    /** A Locker item (#1135): the index's entity and the router's noun are the same word. */
    private const val LOCKER_ITEM: String = "locker_item"

    /** The member's conversations (R-1097-22): the app id the core answers them under, the index's entity, and the router's noun. */
    public const val CHAT: String = "chat"
    private const val CHAT_THREAD: String = "thread"

    /** `ChatCard.entity` for a thread: the shell's router opens it in the Chat tab, not as a route. */
    public const val CHAT_THREAD_NOUN: String = "thread"

    private val CHROME = HomeSearchChrome(
        placeholder = SharedCopy.HOME_SEARCH_PLACEHOLDER,
        scope_label = SharedCopy.HOME_SEARCH_SCOPE_LABEL,
        cancel = SharedCopy.KIT_CANCEL,
        close_label = SharedCopy.KIT_CLOSE_SEARCH,
        loading = SharedCopy.HOME_SEARCH_LOADING,
        retry = SharedCopy.KIT_RETRY,
        title = SharedCopy.KIT_SEARCH,
    )

    override fun rowsChanged(table: String, keys: List<String>): HomeSearchEvent? = null

    override fun seatChanged(seat: SeatState): HomeSearchEvent =
        HomeSearchEvent(seat_changed = HomeSearchEvent.SeatChanged(seat = seat))
}

/** `vault_search` for the term on screen, and the answer beside the term it answers. */
public object HomeSearchReads : ScreenQueries<HomeSearchState, HomeSearchEvent> {
    override val screenId: String = HomeSearchMachine.SCREEN_ID
    override val tables: Set<String> = HomeSearchMachine.TABLES

    override fun requests(state: HomeSearchState, now: DeviceClock.Reading): List<AppQueryRequest> =
        listOf(AppQueryRequest(vault_search = VaultSearchRequest(term = state.field_?.term?.trim().orEmpty(), tz = now.zone)))

    override fun arrived(answers: List<AppQueryResponse>, requests: List<AppQueryRequest>): HomeSearchEvent =
        HomeSearchEvent(
            data_ = HomeSearchEvent.DataArrived(
                data_ = HomeSearchMachine.fold(answers.firstNotNullOfOrNull { it.vault_search }?.hits ?: emptyList()),
                term = requests.firstNotNullOfOrNull { it.vault_search }?.term.orEmpty(),
                corrected = answers.firstNotNullOfOrNull { it.vault_search }?.corrected.orEmpty(),
            ),
        )

    override fun refused(failure: ReadFailure): HomeSearchEvent =
        HomeSearchEvent(refused = HomeSearchEvent.ReadRefused(failure = failure))
}

/** What both shells hold for Home's search: one bridge for the app's life. */
public class HomeSearchBridge : ScreenBridge<HomeSearchState, HomeSearchEvent>(
    machine = HomeSearchMachine,
    events = HomeSearchEvent.ADAPTER,
    wire = { w ->
        w.session.attachQueries(w.host, HomeSearchReads, left = w.left)
        // THE VAULT IN FRONT IS THE ROSTER'S HEAD (`Shelf.publishFrom`). The
        // first id is the vault the session opened on; every change after it
        // is a switch, and the search starts over.
        w.session.outliving.launch {
            w.session.shelf.roster
                .map { roster -> roster.firstOrNull()?.vault_id }
                .filterNotNull()
                .distinctUntilChanged()
                .drop(1)
                .collect { w.host.send(HomeSearchEvent(vault_changed = HomeSearchEvent.VaultChanged())) }
        }
    },
)
