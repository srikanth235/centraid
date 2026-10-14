package dev.centraid.shared

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.VaultSearch
import centraid.core.v1.VaultSearchHit
import centraid.core.v1.VaultSearchRequest
import centraid.screen.v1.ChatCard
import centraid.screen.v1.HomeSearchEvent
import centraid.screen.v1.HomeSearchState
import dev.centraid.design.copy.SharedCopy
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.RowRoutes
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.shell.HomeSearchMachine
import dev.centraid.shared.shell.HomeSearchReads
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe

/**
 * HOME'S SEARCH (R-CHROME-6): grouped by app in Home's tile order, Locker
 * never on it, a blank term reading nothing, the latest term winning, this
 * session's searches remembered, and a row opening where its app opens it.
 */
class HomeSearchSpec : StringSpec({
    val now = DeviceClock.Reading(zone = "Europe/Lisbon", epochMillis = 1_773_230_400_000)

    fun hit(app: String, entity: String, id: String, title: String, openId: String = "") =
        VaultSearchHit(entity = entity, id = id, title = title, app_id = app, subtitle = app, open_id = openId)

    fun step(state: HomeSearchState, event: HomeSearchEvent) = HomeSearchMachine.reduce(state, event)

    fun typed(state: HomeSearchState, term: String) =
        step(state, HomeSearchEvent(term = HomeSearchEvent.TermChanged(term = term)))

    /** What the runtime hands the machine for [hits] answering [term]. */
    fun answer(term: String, vararg hits: VaultSearchHit): HomeSearchEvent = HomeSearchReads.arrived(
        listOf(AppQueryResponse(vault_search = VaultSearch(hits = hits.toList()))),
        listOf(AppQueryRequest(vault_search = VaultSearchRequest(term = term, tz = now.zone))),
    )

    val opened = step(HomeSearchMachine.initial(), HomeSearchEvent(opened = HomeSearchEvent.Opened())).state

    "the words the core corrected are on the field, a new term clears them, and an answer for another term draws none (#1097)" {
        val slipped = typed(opened, "sunscren").state
        fun answered(term: String, corrected: String) = HomeSearchReads.arrived(
            listOf(
                AppQueryResponse(
                    vault_search = VaultSearch(hits = listOf(hit("tasks", "schedule.task", "t1", "Buy sunscreen")), corrected = corrected),
                ),
            ),
            listOf(AppQueryRequest(vault_search = VaultSearchRequest(term = term, tz = now.zone))),
        )
        val fixed = step(slipped, answered("sunscren", "sunscreen")).state
        fixed.field_!!.corrected shouldBe "sunscreen"
        fixed.field_.answered_term shouldBe "sunscren"
        // An exact answer says nothing was corrected.
        step(slipped, answered("sunscren", "")).state.field_!!.corrected shouldBe ""
        // A trailing space is not another term.
        step(typed(opened, "sunscren ").state, answered("sunscren", "sunscreen")).state.field_!!.corrected shouldBe "sunscreen"
        // A NEW TERM clears it, and so does cancelling the field.
        typed(fixed, "sunscree").state.field_!!.corrected shouldBe ""
        step(fixed, HomeSearchEvent(cancelled = HomeSearchEvent.Cancelled())).state.field_!!.corrected shouldBe ""
        // AN ANSWER FOR AN OLDER TERM than the one on screen is dropped whole.
        step(slipped, answered("sun", "sunscreen")).state.field_!!.corrected shouldBe ""
    }

    "nothing matching offers one action, which asks the assistant about the term, and asking records the search (#1097)" {
        val nothing = step(typed(opened, "zzqx").state, answer("zzqx")).state
        val empty = nothing.data_!!.empty.shouldNotBeNull()
        empty.headline shouldBe SharedCopy.HOME_SEARCH_NO_MATCH_HEADLINE
        empty.action_label shouldBe "Ask about “zzqx”"
        nothing.data_.ask_question shouldBe "Find zzqx"
        // The shell carries the action out; the machine remembers the term.
        step(nothing, HomeSearchEvent(asked = HomeSearchEvent.Asked())).state.recent shouldBe listOf("zzqx")
        // Rows found: no empty state, no question.
        val found = step(typed(opened, "cab").state, answer("cab", hit("notes", "knowledge.note", "n1", "Cabin"))).state
        found.data_!!.empty.shouldBeNull()
        found.data_.ask_question shouldBe ""
    }

    "the hits are grouped by app in Home's tile order, each counted, each row named by its kind" {
        val data = HomeSearchMachine.fold(
            listOf(
                hit("notes", "knowledge.note", "n1", "Cabin packing"),
                hit("agenda", "core.event", "e1", "Cabin weekend"),
                hit("notes", "knowledge.note", "n2", "Cabin key"),
                hit("photos", "core.content_item", "c1", "Cabin at dusk", openId = "a1"),
                hit("tasks", "schedule.task", "t1", "Book the cabin"),
            ),
        )
        // SPRINGBOARD_ORDER: photos, docs, notes, agenda, tasks, people.
        data.groups.map { it.app_id } shouldContainExactly listOf("photos", "notes", "agenda", "tasks")
        data.groups.map { it.label } shouldContainExactly listOf("Photos", "Notes", "Agenda", "Tasks")
        data.groups.map { it.count } shouldContainExactly listOf(1, 2, 1, 1)
        data.groups[1].accessibility_label shouldBe "Notes, 2 results"
        data.groups[0].accessibility_label shouldBe "Photos, 1 result"
        data.groups[1].rows.map { it.kind_label to it.title } shouldContainExactly
            listOf(SharedCopy.SEARCH_KIND_NOTE to "Cabin packing", SharedCopy.SEARCH_KIND_NOTE to "Cabin key")
        data.groups[2].rows.single().kind_label shouldBe SharedCopy.SEARCH_KIND_EVENT
        data.groups[1].rows[0].accessibility_label shouldBe "Note, Cabin packing"
    }

    "Locker never appears, even if a hit names it" {
        val data = HomeSearchMachine.fold(
            listOf(
                hit("locker", "locker.item", "l1", "Cabin door code"),
                hit("notes", "knowledge.note", "n1", "Cabin packing"),
            ),
        )
        data.groups.map { it.app_id } shouldContainExactly listOf("notes")
    }

    "a blank term reads nothing and rests on the recent searches" {
        val blank = typed(opened, "   ")
        blank.effects.shouldBeEmpty()
        blank.state.resting.shouldNotBeNull()
        blank.state.data_.shouldBeNull()
        val typedThenCleared = typed(typed(opened, "cab").state, "")
        typedThenCleared.effects.shouldBeEmpty()
        typedThenCleared.state.resting.shouldNotBeNull()
        // An answer that lands after the clear is not drawn over the rest.
        step(typedThenCleared.state, answer("cab", hit("notes", "knowledge.note", "n1", "Cabin"))).state
            .data_.shouldBeNull()
    }

    "every term reads, and the latest one wins" {
        val first = typed(opened, "ca")
        first.effects shouldContainExactly listOf(ScreenEffect.ReadPage(HomeSearchMachine.SCREEN_ID, afterCursor = null))
        HomeSearchReads.requests(first.state, now).single().vault_search shouldBe
            VaultSearchRequest(term = "ca", tz = now.zone)
        val second = typed(first.state, "cabin").state
        // The answer for "ca" lands after the member typed "cabin": dropped.
        val stale = step(second, answer("ca", hit("notes", "knowledge.note", "n9", "Calendar")))
        stale.state.data_.shouldBeNull()
        val current = step(second, answer("cabin", hit("notes", "knowledge.note", "n1", "Cabin packing"))).state
        current.data_!!.groups.single().rows.single().title shouldBe "Cabin packing"
        current.field_!!.answered_term shouldBe "cabin"
        // And the rows on screen stay while the next term reads.
        typed(current, "cabins").state.data_.shouldNotBeNull()
    }

    "nothing matched says so, naming the term" {
        val state = step(typed(opened, "zzz").state, answer("zzz")).state
        state.data_!!.groups.shouldBeEmpty()
        state.data_!!.empty!!.body shouldBe "Nothing in this vault matches “zzz”."
    }

    "a picked row records its term, newest first, capped, and Cancel keeps them but clears the field" {
        var state = opened
        listOf("alpha", "beta", "gamma", "delta", "epsilon", "Beta").forEach { term ->
            state = typed(state, term).state
            state = step(state, answer(term, hit("notes", "knowledge.note", "n-$term", term))).state
            val row = state.data_!!.groups.single().rows.single()
            state = step(state, HomeSearchEvent(row = HomeSearchEvent.RowPicked(row = row))).state
        }
        state.recent shouldContainExactly listOf("Beta", "epsilon", "delta", "gamma")
        state.recent.size shouldBe HomeSearchMachine.RECENT_MAX
        val cancelled = step(state, HomeSearchEvent(cancelled = HomeSearchEvent.Cancelled())).state
        cancelled.field_!!.term shouldBe ""
        cancelled.data_.shouldBeNull()
        cancelled.resting!!.suggestions shouldContainExactly listOf("Beta", "epsilon", "delta", "gamma")
        cancelled.resting!!.suggestions_label shouldBe SharedCopy.HOME_SEARCH_RECENT_LABEL
        // A fresh open after Cancel starts empty, the recents still offered.
        val reopened = step(cancelled, HomeSearchEvent(opened = HomeSearchEvent.Opened())).state
        reopened.field_!!.term shouldBe ""
        reopened.resting!!.suggestions.size shouldBe 4
        // The keyboard's search key records too; a suggestion reads its term.
        val submitted = step(typed(reopened, "zeta").state, HomeSearchEvent(submitted = HomeSearchEvent.Submitted())).state
        submitted.recent.first() shouldBe "zeta"
        val picked = step(reopened, HomeSearchEvent(suggestion = HomeSearchEvent.SuggestionPicked(term = "gamma")))
        picked.state.field_!!.term shouldBe "gamma"
        picked.effects.size shouldBe 1
        // A fresh vault-less screen offers no "Recent" heading over nothing.
        opened.resting!!.suggestions_label shouldBe ""
    }

    "another vault in front takes the term, the rows and the recent searches with it" {
        var state = typed(opened, "cabin").state
        state = step(state, answer("cabin", hit("notes", "knowledge.note", "n-1", "Cabin trip"))).state
        state = step(state, HomeSearchEvent(submitted = HomeSearchEvent.Submitted())).state
        state.recent shouldContainExactly listOf("cabin")
        val switched = step(state, HomeSearchEvent(vault_changed = HomeSearchEvent.VaultChanged())).state
        switched.field_!!.term shouldBe ""
        switched.data_.shouldBeNull()
        switched.recent.shouldBeEmpty()
        switched.resting!!.suggestions.shouldBeEmpty()
        // A late answer for the last vault's term is not this vault's.
        step(switched, answer("cabin", hit("notes", "knowledge.note", "n-1", "Cabin trip"))).state.data_.shouldBeNull()
    }

    "a row's target opens the item in its own app" {
        val data = HomeSearchMachine.fold(
            listOf(
                hit("notes", "knowledge.note", "n1", "Cabin packing"),
                hit("people", "core.party", "p1", "Kate Bell"),
                hit("agenda", "core.event", "e1", "Cabin weekend"),
                hit("tasks", "schedule.task", "t1", "Book the cabin"),
                hit("docs", "core.document", "d1", "Cabin lease"),
                hit("photos", "core.content_item", "c1", "Cabin at dusk", openId = "a1"),
            ),
        )
        val targets = data.groups.flatMap { group -> group.rows.map { it.target!! } }
        targets.single { it.app == "photos" } shouldBe ChatCard(app = "photos", entity = "photo", id = "a1", title = "Cabin at dusk")
        targets.single { it.app == "notes" } shouldBe ChatCard(app = "notes", entity = "note", id = "n1", title = "Cabin packing")
        val opens = targets.associate { it.app to RowRoutes.destination(it, parent = "Search") }
        opens["notes"] shouldBe Destination.NotesEditor("n1", title = "Cabin packing")
        opens["people"] shouldBe Destination.PeoplePerson("p1", "Kate Bell")
        opens["agenda"] shouldBe Destination.AgendaEvent("e1", "", null, "")
        opens["tasks"] shouldBe Destination.TasksDetail("t1")
        opens["docs"] shouldBe Destination.DocsDocument("d1", "Cabin lease", parent = "Search")
        opens["photos"] shouldBe Destination.PhotoLightbox("a1", listOf("a1"))
        // Picking a row is an intent: the machine records, the shell opens.
        val shown = step(typed(opened, "cabin").state, answer("cabin", hit("notes", "knowledge.note", "n1", "Cabin packing"))).state
        val row = shown.data_!!.groups.single().rows.single()
        val picked = step(shown, HomeSearchEvent(row = HomeSearchEvent.RowPicked(row = row)))
        picked.effects.shouldBeEmpty()
        picked.state.data_ shouldBe shown.data_
        RowRoutes.destination(row.target!!) shouldBe Destination.NotesEditor("n1", title = "Cabin packing")
    }

    // ---- THE CHAT GROUP (#1097, R-1097-24) ---------------------------------------------------------

    val chatThread = hit("chat", "chat.thread", "th-1", "Where is the marmalade recipe?")
    val noteHit = hit("notes", "knowledge.note", "n1", "Cabin packing")
    val withChatTab = step(HomeSearchMachine.initial(), HomeSearchEvent(opened = HomeSearchEvent.Opened(chat_tab = true))).state

    "a conversation is a chat row in a Chats group, last, whose target is the thread (R-1097-24)" {
        val data = HomeSearchMachine.fold(listOf(chatThread, noteHit))
        // Last: the group is not an app of Home's tile order.
        data.groups.map { it.app_id } shouldContainExactly listOf("notes", "chat")
        val group = data.groups.last()
        group.label shouldBe SharedCopy.HOME_SEARCH_CHAT_GROUP
        group.accessibility_label shouldBe "Chats, 1 result"
        group.containers.shouldBeEmpty()
        val row = group.rows.single()
        row.kind_label shouldBe SharedCopy.SEARCH_KIND_CHAT
        row.accessibility_label shouldBe "Chat, Where is the marmalade recipe?"
        // The shell opens a thread in its Chat tab: the reference names the thread and its title.
        row.target shouldBe ChatCard(app = "chat", entity = "thread", id = "th-1", title = "Where is the marmalade recipe?")
        // Chat is a tab and not a screen, so a stack-based shell has no destination for it.
        RowRoutes.destination(row.target!!).shouldBeNull()
    }

    "the Chat group is drawn only when the shell says it has a Chat tab" {
        // ON: iOS sends `Opened(chat_tab = true)`.
        withChatTab.chat_tab shouldBe true
        val on = step(typed(withChatTab, "cab").state, answer("cab", chatThread, noteHit)).state
        on.data_!!.groups.map { it.app_id } shouldContainExactly listOf("notes", "chat")
        // OFF: Android sends a bare `Opened`, so its answer has the same hits and no chat group.
        opened.chat_tab shouldBe false
        val off = step(typed(opened, "cab").state, answer("cab", chatThread, noteHit)).state
        off.data_!!.groups.map { it.app_id } shouldContainExactly listOf("notes")
        off.data_.groups.single().count shouldBe 1
    }

    "a term only a conversation holds is the no-match state where there is no Chat tab, and the group where there is" {
        val off = step(typed(opened, "marmalade").state, answer("marmalade", chatThread)).state
        off.data_!!.groups.shouldBeEmpty()
        off.data_.empty.shouldNotBeNull()
        off.data_.ask_question shouldBe "Find marmalade"
        val on = step(typed(withChatTab, "marmalade").state, answer("marmalade", chatThread)).state
        on.data_!!.empty.shouldBeNull()
        on.data_.groups.single().app_id shouldBe "chat"
    }

    "the shell's word on a Chat tab survives cancelling and another vault, and opening again takes the new word" {
        var state = step(typed(withChatTab, "cab").state, answer("cab", chatThread)).state
        state = step(state, HomeSearchEvent(cancelled = HomeSearchEvent.Cancelled())).state
        state.chat_tab shouldBe true
        state = step(state, HomeSearchEvent(vault_changed = HomeSearchEvent.VaultChanged())).state
        state.chat_tab shouldBe true
        // The shell says it again at every open; a shell that lost its tab says so.
        step(state, HomeSearchEvent(opened = HomeSearchEvent.Opened(chat_tab = false))).state.chat_tab shouldBe false
    }
})
