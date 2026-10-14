package dev.centraid.shared

import centraid.core.v1.AssistModelState
import centraid.core.v1.ChatStoredMessage
import centraid.core.v1.ChatStoredOutcome
import centraid.core.v1.ChatThread
import centraid.core.v1.ChatThreadRow
import centraid.screen.v1.ChatEvent
import dev.centraid.design.copy.ChatCopy
import dev.centraid.shared.chat.Chat
import dev.centraid.shared.chat.ChatEffect
import dev.centraid.shared.chat.ChatInput
import dev.centraid.shared.chat.ChatMachine
import dev.centraid.shared.chat.ChatStep
import dev.centraid.shared.chat.ThreadRow
import dev.centraid.shared.chat.ThreadSearch
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.shouldBe

/**
 * THE DRAWER'S SEARCH (#1097, R-1097-24): the kit's field in the drawer, run
 * through the shared law. A term asks the core; the rows are the chats it found,
 * best first; a typo it corrected is said once on the field; a blank term, a
 * close, a chat opened and a drawer shut all bring the plain list back; and an
 * answer for a term the member has since changed is dropped.
 */
class ChatDrawerSearchSpec : StringSpec({

    fun reduce(chat: Chat, input: ChatInput): ChatStep = ChatMachine.reduce(chat, input)

    fun view(event: ChatEvent) = ChatInput.View(event)

    val now = 1_000_000_000L
    val recent = ThreadRow(id = "t-recent", title = "What is due today?", updatedMs = now - 5 * 60_000L)
    val older = ThreadRow(id = "t-older", title = "Who owes me money?", updatedMs = now - 30 * 3_600_000L)
    val marmalade = ThreadRow(id = "t-jam", title = "Where is the marmalade recipe?", updatedMs = now - 10 * 86_400_000L)

    /** A ready chat with its drawer open over two chats. */
    fun drawer(): Chat {
        var chat = reduce(ChatMachine.initial(), view(ChatEvent(opened = ChatEvent.Opened(app = "")))).chat
        chat = reduce(chat, ChatInput.Status(AssistModelState.ASSIST_MODEL_STATE_READY)).chat
        chat = reduce(chat, ChatInput.Started(7L)).chat
        chat = reduce(chat, ChatInput.Threads(listOf(recent, older), now)).chat
        return reduce(chat, view(ChatEvent(drawer = ChatEvent.DrawerToggled(opened = true)))).chat
    }

    fun opened(chat: Chat = drawer()): Chat =
        reduce(chat, view(ChatEvent(drawer_search_opened = ChatEvent.DrawerSearchOpened()))).chat

    fun typed(chat: Chat, term: String): ChatStep =
        reduce(chat, view(ChatEvent(drawer_search_term = ChatEvent.DrawerSearchTerm(term = term))))

    fun found(chat: Chat, term: String, rows: List<ThreadRow>?, corrected: String = ""): ChatStep =
        reduce(chat, ChatInput.Found(term, rows, corrected, now))

    "the drawer draws a closed search with its words, and the opener opens the field" {
        val closed = drawer().state
        closed.drawer_search!!.open_ shouldBe false
        closed.drawer_search_placeholder shouldBe ChatCopy.DRAWER_SEARCH_PLACEHOLDER
        ChatCopy.DRAWER_SEARCH_PLACEHOLDER shouldBe "Search chats"
        opened().state.drawer_search!!.open_ shouldBe true
        // The list is the plain list until a term is answered.
        opened().state.threads.map { it.thread_id } shouldBe listOf("t-recent", "t-older")
    }

    "a term asks the core, and the answer's chats are the drawer's rows, best first" {
        val step = typed(opened(), "marmalade")
        step.chat.state.drawer_search!!.term shouldBe "marmalade"
        step.effects shouldBe listOf(ChatEffect.SearchThreads("marmalade"))
        // The rows stay the list's while the term reads.
        step.chat.state.threads.map { it.thread_id } shouldBe listOf("t-recent", "t-older")

        val answered = found(step.chat, "marmalade", listOf(marmalade, older)).chat.state
        answered.threads.map { it.thread_id } shouldBe listOf("t-jam", "t-older")
        answered.threads.map { it.title } shouldBe listOf("Where is the marmalade recipe?", "Who owes me money?")
        answered.threads.map { it.ago } shouldBe listOf("2 January", "Yesterday")
        answered.drawer_search!!.answered_term shouldBe "marmalade"
        answered.drawer_search.corrected shouldBe ""
        answered.threads_empty_line shouldBe ""
        // "Delete all chats" is the plain list's, never offered over search results.
        drawer().state.can_delete_all shouldBe true
        answered.can_delete_all shouldBe false
        reduce(ChatMachine.initial(), ChatInput.Threads(emptyList(), now)).chat.state.can_delete_all shouldBe false
    }

    "a typo the core corrected is said on the field, a new term clears it, and an exact answer says nothing" {
        val slipped = typed(opened(), "marmalde").chat
        val fixed = found(slipped, "marmalde", listOf(marmalade), corrected = "marmalade").chat
        fixed.state.drawer_search!!.corrected shouldBe "marmalade"
        fixed.state.threads.map { it.thread_id } shouldBe listOf("t-jam")
        // A new term clears the words the last answer corrected to.
        typed(fixed, "marmalad").chat.state.drawer_search!!.corrected shouldBe ""
        found(slipped, "marmalde", listOf(marmalade)).chat.state.drawer_search!!.corrected shouldBe ""
        // A trailing space is not another term.
        found(typed(opened(), "marmalde ").chat, "marmalde", listOf(marmalade), "marmalade")
            .chat.state.drawer_search!!.corrected shouldBe "marmalade"
    }

    "an answer that found nothing says so with the term, and is not the empty-list line" {
        val none = found(typed(opened(), "zeppelin").chat, "zeppelin", emptyList()).chat.state
        none.threads.shouldBeEmpty()
        none.threads_empty_line shouldBe "No chats match “zeppelin”."
        none.threads_empty_line shouldBe ChatCopy.DRAWER_SEARCH_NO_MATCH.replace("{term}", "zeppelin")
        // A drawer with no chats at all, and no search, keeps its own line.
        val bare = reduce(drawer(), ChatInput.Threads(emptyList(), now)).chat.state
        bare.threads_empty_line shouldBe ChatCopy.THREADS_EMPTY
    }

    "an answer for a term since changed, cleared or closed is dropped, and a refusal leaves the drawer as it was" {
        val first = typed(opened(), "mar").chat
        val second = typed(first, "marmalade").chat
        // The answer for "mar" lands after "marmalade" was typed.
        found(second, "mar", listOf(older)).chat.state.threads.map { it.thread_id } shouldBe listOf("t-recent", "t-older")
        found(second, "mar", listOf(older)).chat.state.drawer_search!!.answered_term shouldBe ""
        // After the field is cleared or closed, a late answer is not drawn.
        val cleared = typed(second, "").chat
        found(cleared, "marmalade", listOf(marmalade)).chat.state.threads.map { it.thread_id } shouldBe
            listOf("t-recent", "t-older")
        val closed = reduce(second, view(ChatEvent(drawer_search_closed = ChatEvent.DrawerSearchClosed()))).chat
        found(closed, "marmalade", listOf(marmalade)).chat.state.threads.map { it.thread_id } shouldBe
            listOf("t-recent", "t-older")
        // The core would not answer: nothing changes.
        found(second, "marmalade", null).chat shouldBe second
    }

    "a blank term reads nothing and puts the plain list back" {
        val answered = found(typed(opened(), "marmalade").chat, "marmalade", listOf(marmalade)).chat
        val blank = typed(answered, "   ")
        blank.effects.shouldBeEmpty()
        blank.chat.state.threads.map { it.thread_id } shouldBe listOf("t-recent", "t-older")
        blank.chat.state.drawer_search!!.answered_term shouldBe ""
        blank.chat.state.drawer_search.open_ shouldBe true
    }

    "closing the field, and shutting the drawer, clear the term, its answer and its correction" {
        val answered = found(typed(opened(), "marmalde").chat, "marmalde", listOf(marmalade), "marmalade").chat
        val closed = reduce(answered, view(ChatEvent(drawer_search_closed = ChatEvent.DrawerSearchClosed()))).chat.state
        closed.drawer_search!!.open_ shouldBe false
        closed.drawer_search.term shouldBe ""
        closed.drawer_search.answered_term shouldBe ""
        closed.drawer_search.corrected shouldBe ""
        closed.threads.map { it.thread_id } shouldBe listOf("t-recent", "t-older")
        // The drawer shut with a search showing: the next open starts empty.
        val shut = reduce(answered, view(ChatEvent(drawer = ChatEvent.DrawerToggled(opened = false)))).chat
        val again = reduce(shut, view(ChatEvent(drawer = ChatEvent.DrawerToggled(opened = true)))).chat.state
        again.drawer_search!!.open_ shouldBe false
        again.drawer_search.term shouldBe ""
        again.threads.map { it.thread_id } shouldBe listOf("t-recent", "t-older")
    }

    "a chat opened from the results carries the hit's title when the list does not hold it, and the search closes" {
        val answered = found(typed(opened(), "marmalade").chat, "marmalade", listOf(marmalade)).chat
        // Found, so the header has its title at once even though the list (the newest chats) lacks it.
        val opening = reduce(
            answered,
            view(ChatEvent(thread_opened = ChatEvent.ThreadOpened(thread_id = "t-jam", title = "Where is the marmalade recipe?"))),
        )
        opening.chat.state.title shouldBe "Where is the marmalade recipe?"
        opening.effects shouldBe listOf(ChatEffect.OpenThread("t-jam"))
        opening.chat.state.drawer_open shouldBe false
        opening.chat.state.drawer_search!!.term shouldBe ""
        // The title a shell tells is used when nothing else knows the chat (a hit from Home).
        val fromHome = reduce(
            drawer().copy(drawerOpen = false),
            view(ChatEvent(thread_opened = ChatEvent.ThreadOpened(thread_id = "t-jam", title = "Where is the marmalade recipe?"))),
        )
        fromHome.chat.state.title shouldBe "Where is the marmalade recipe?"
        // The list's own row wins over the title the shell was told.
        reduce(
            drawer(),
            view(ChatEvent(thread_opened = ChatEvent.ThreadOpened(thread_id = "t-older", title = "told"))),
        ).chat.state.title shouldBe "Who owes me money?"
    }

    "deleting or renaming from the results changes them at once, and reading the list reads the search again" {
        val answered = found(typed(opened(), "marmalade").chat, "marmalade", listOf(marmalade, older)).chat
        val deleted = reduce(answered, view(ChatEvent(thread_deleted = ChatEvent.ThreadDeleted(thread_id = "t-jam"))))
        deleted.chat.state.threads.map { it.thread_id } shouldBe listOf("t-older")
        deleted.effects shouldBe listOf(ChatEffect.DeleteThread("t-jam"))
        val renamed = reduce(
            answered,
            view(ChatEvent(thread_renamed = ChatEvent.ThreadRenamed(thread_id = "t-jam", title = "Jam notes"))),
        )
        renamed.chat.state.threads.map { it.title } shouldBe listOf("Jam notes", "Who owes me money?")
        // A list read while a term is showing asks again, so a delete from elsewhere leaves the results.
        reduce(answered, ChatInput.Threads(listOf(recent), now)).effects shouldBe listOf(ChatEffect.SearchThreads("marmalade"))
        // And a list read with no search showing asks for nothing more.
        reduce(drawer(), ChatInput.Threads(listOf(recent), now)).effects.shouldBeEmpty()
    }

    "deleting every chat shuts the drawer and its search" {
        val answered = found(typed(opened(), "marmalade").chat, "marmalade", listOf(marmalade)).chat
        val cleared = reduce(answered, view(ChatEvent(all_threads_deleted = ChatEvent.AllThreadsDeleted()))).chat.state
        cleared.drawer_open shouldBe false
        cleared.drawer_search!!.term shouldBe ""
        cleared.threads.shouldBeEmpty()
    }

    "the search runs over a core: a typed term asks it, the found chats are drawn, and clearing the field puts the list back" {
        val rig = Rig()
        rig.door.storedRows = mutableListOf(recent, older)
        rig.door.searchAnswer = { term ->
            when (term) {
                "marmalde" -> ThreadSearch(rows = listOf(marmalade), corrected = "marmalade")
                else -> ThreadSearch(rows = emptyList())
            }
        }
        rig.open()
        rig.flow.send(ChatEvent(drawer = ChatEvent.DrawerToggled(opened = true)))
        rig.flow.send(ChatEvent(drawer_search_opened = ChatEvent.DrawerSearchOpened()))
        rig.flow.send(ChatEvent(drawer_search_term = ChatEvent.DrawerSearchTerm(term = "marmalde")))
        rig.door.history.last() shouldBe "search:marmalde"
        rig.state.threads.map { it.thread_id } shouldBe listOf("t-jam")
        rig.state.drawer_search!!.corrected shouldBe "marmalade"
        // A chat deleted from the results: the vault is told, the list and the search are read again.
        rig.door.storedThreads["t-jam"] = ChatThread(
            found = true,
            thread = ChatThreadRow(thread_id = "t-jam", title = "Where is the marmalade recipe?"),
            messages = listOf(
                ChatStoredMessage(ordinal = 0, from_member = true, text = "Where is the marmalade recipe?", outcome = ChatStoredOutcome.CHAT_STORED_OUTCOME_SENT),
            ),
        )
        // Clearing the field reads nothing and shows the list.
        val before = rig.door.history.size
        rig.flow.send(ChatEvent(drawer_search_term = ChatEvent.DrawerSearchTerm(term = "")))
        rig.door.history.size shouldBe before
        rig.state.threads.map { it.thread_id } shouldBe listOf("t-recent", "t-older")
        // Opening a found chat opens it against the core with the title the hit carried.
        rig.flow.send(ChatEvent(drawer_search_term = ChatEvent.DrawerSearchTerm(term = "marmalde")))
        rig.flow.send(ChatEvent(thread_opened = ChatEvent.ThreadOpened(thread_id = "t-jam", title = "Where is the marmalade recipe?")))
        rig.door.history.takeLast(2) shouldBe listOf("thread:t-jam", "start-thread:t-jam")
        rig.state.title shouldBe "Where is the marmalade recipe?"
        rig.state.drawer_open shouldBe false
        rig.state.drawer_search!!.term shouldBe ""
    }
})
