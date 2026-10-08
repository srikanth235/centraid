package dev.centraid.shared

import centraid.core.v1.AssistAnswer
import centraid.core.v1.AssistNotice
import centraid.core.v1.AssistRefusalReason
import centraid.core.v1.AssistSent
import centraid.core.v1.AssistStarted
import centraid.core.v1.ChatStoredAttachment
import centraid.core.v1.ChatStoredAttachmentKind
import centraid.core.v1.ChatStoredCard
import centraid.core.v1.ChatStoredMessage
import centraid.core.v1.ChatStoredOutcome
import centraid.core.v1.ChatThread
import centraid.core.v1.ChatThreadRow
import centraid.screen.v1.ChatEvent
import centraid.screen.v1.ChatPending
import centraid.screen.v1.ChatState
import dev.centraid.design.copy.ChatCopy
import dev.centraid.shared.chat.AttachSource
import dev.centraid.shared.chat.Chat
import dev.centraid.shared.chat.ChatEffect
import dev.centraid.shared.chat.ChatInput
import dev.centraid.shared.chat.ChatMachine
import dev.centraid.shared.chat.ChatStep
import dev.centraid.shared.chat.ThreadRow
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe

/**
 * THE CHAT'S HISTORY AND ITS NAVIGATION, with no core: the drawer, a past chat
 * opened from it, rename and delete, and the thread a turn was saved into
 * (R-CHAT-1, R-CHAT-2). The same decisions run again over a fake core at the
 * foot, where the effects are real and the answers are fed back.
 */
class ChatHistorySpec : StringSpec({

    fun reduce(chat: Chat, input: ChatInput): ChatStep = ChatMachine.reduce(chat, input)

    fun view(event: ChatEvent) = ChatInput.View(event)

    fun ready(scope: String = "", vault: String = ""): Chat {
        var chat = reduce(
            ChatMachine.initial(),
            view(ChatEvent(opened = ChatEvent.Opened(app = scope, vault_name = vault))),
        ).chat
        chat = reduce(chat, ChatInput.Status(centraid.core.v1.AssistModelState.ASSIST_MODEL_STATE_READY)).chat
        return reduce(chat, ChatInput.Started(7L)).chat
    }

    val rows = listOf(
        ThreadRow(id = "t-new", title = "What is due today?", updatedMs = 1_000_000_000L - 5 * 60_000L),
        ThreadRow(id = "t-old", title = "Who owes me money?", updatedMs = 1_000_000_000L - 30 * 3_600_000L),
    )

    fun withThreads(chat: Chat, nowMs: Long = 1_000_000_000L): Chat =
        reduce(chat, ChatInput.Threads(rows, nowMs)).chat

    fun card(id: String) = ChatStoredCard(app = "tasks", entity = "task", id = id, title = "Pay rent", subtitle = "2026-10-01")

    fun stored(
        scope: String = "tasks",
        vararg messages: ChatStoredMessage,
    ) = ChatThread(
        found = true,
        thread = ChatThreadRow(thread_id = "t-new", title = "What is due today?", scope_app = scope),
        messages = messages.toList(),
    )

    fun question(text: String, attachments: List<ChatStoredAttachment> = emptyList()) = ChatStoredMessage(
        ordinal = 0,
        from_member = true,
        text = text,
        outcome = ChatStoredOutcome.CHAT_STORED_OUTCOME_SENT,
        attachments = attachments,
    )

    fun answer(
        text: String,
        outcome: ChatStoredOutcome = ChatStoredOutcome.CHAT_STORED_OUTCOME_ANSWERED,
        cards: List<ChatStoredCard> = emptyList(),
        refusal: AssistRefusalReason = AssistRefusalReason.ASSIST_REFUSAL_REASON_UNSPECIFIED,
        notices: List<AssistNotice> = emptyList(),
    ) = ChatStoredMessage(
        ordinal = 1,
        from_member = false,
        text = text,
        outcome = outcome,
        cards = cards,
        refusal = refusal,
        notices = notices,
    )

    fun started(session: Long = 9L, scope: String = "tasks") =
        AssistStarted(session_id = session, thread_id = "t-new", scope_app = scope)

    // --- the header -------------------------------------------------------------

    "the header says New chat until a thread has a title, with the vault and where it runs" {
        val chat = ready(vault = "Sample")
        chat.state.title shouldBe "New chat"
        chat.state.subtitle shouldBe "Sample · on this phone"
        // A vault with no name says only where the chat runs.
        ready().state.subtitle shouldBe "On this phone"
    }

    "a saved turn names its thread on the response, and the header takes the title" {
        val asked = reduce(ready(vault = "Sample"), view(ChatEvent(sent = ChatEvent.Sent(text = "What is due today?")))).chat
        val sent = AssistSent(
            session_id = 7,
            turn_id = 1,
            answered = AssistAnswer(text = "Rent."),
            thread_id = "t-new",
            thread_title = "What is due today?",
        )
        val settled = reduce(asked, ChatInput.Settled(1, sent))
        settled.chat.threadId shouldBe "t-new"
        settled.chat.state.title shouldBe "What is due today?"
        settled.chat.state.thread_id shouldBe "t-new"
        settled.chat.state.can_manage_thread shouldBe true
        // And the drawer's list is read again, so it holds the new chat.
        settled.effects shouldBe listOf(ChatEffect.ReadThreads)
    }

    "the response carries the thread even when the stream settled the turn first" {
        val asked = reduce(ready(), view(ChatEvent(sent = ChatEvent.Sent(text = "hi")))).chat
        val streamed = reduce(
            asked,
            ChatInput.Core(
                centraid.core.v1.AssistEvent(
                    session_id = 7,
                    turn_id = 1,
                    answer = AssistAnswer(text = "Hello."),
                ),
            ),
        ).chat
        streamed.running shouldBe false
        streamed.threadId shouldBe ""
        val late = reduce(
            streamed,
            ChatInput.Settled(
                1,
                AssistSent(session_id = 7, turn_id = 1, answered = AssistAnswer(text = "Hello."), thread_id = "t-1", thread_title = "hi"),
            ),
        )
        late.chat.threadId shouldBe "t-1"
        late.chat.messages.last().text shouldBe "Hello."
        late.effects shouldBe listOf(ChatEffect.ReadThreads)
    }

    "a stale turn's thread is not adopted by the chat that replaced it" {
        val asked = reduce(ready(), view(ChatEvent(sent = ChatEvent.Sent(text = "hi")))).chat
        val replaced = reduce(asked, view(ChatEvent(new_chat = ChatEvent.NewChat()))).chat
        val stale = reduce(
            replaced,
            ChatInput.Settled(1, AssistSent(session_id = 7, turn_id = 1, answered = AssistAnswer(text = "x"), thread_id = "t-old")),
        )
        stale.chat.threadId shouldBe ""
        stale.effects.shouldBeEmpty()
    }

    // --- the drawer -------------------------------------------------------------

    "the drawer lists past chats newest first with how long ago, and marks the open one" {
        val chat = withThreads(ready()).copy(threadId = "t-new")
        val state = reduce(chat, ChatInput.Threads(rows, 1_000_000_000L)).chat.state
        state.threads.map { it.title } shouldBe listOf("What is due today?", "Who owes me money?")
        state.threads.map { it.ago } shouldBe listOf("5 min ago", "Yesterday")
        state.threads.map { it.current } shouldBe listOf(true, false)
        state.threads[0].accessibility_label shouldBe "What is due today?, 5 min ago, Open chat"
        state.threads[1].accessibility_label shouldBe "Who owes me money?, Yesterday"
        state.threads_empty_line shouldBe ""
    }

    "the drawer with no chats says so in one line" {
        val state = reduce(ready(), ChatInput.Threads(emptyList(), 1L)).chat.state
        state.threads.shouldBeEmpty()
        state.threads_empty_line shouldBe ChatCopy.THREADS_EMPTY
        ChatCopy.THREADS_EMPTY shouldBe "No chats yet."
    }

    "how long ago is a duration up to a week and a landmark day after it" {
        val now = 1_790_000_000_000L
        fun said(agoMs: Long) = ChatMachine.whenText(now - agoMs, now)
        said(10_000) shouldBe "Just now"
        said(61_000) shouldBe "1 min ago"
        said(59 * 60_000L) shouldBe "59 min ago"
        said(3 * 3_600_000L) shouldBe "3 hr ago"
        said(30 * 3_600_000L) shouldBe "Yesterday"
        said(3 * 86_400_000L) shouldBe "3 days ago"
        said(40 * 86_400_000L) shouldBe "12 August"
        // No clock, no claim.
        ChatMachine.whenText(1L, 0L) shouldBe ""
    }

    "opening the drawer reads the list again, and closing it reads nothing" {
        val open = reduce(ready(), view(ChatEvent(drawer = ChatEvent.DrawerToggled(opened = true))))
        open.chat.state.drawer_open shouldBe true
        open.effects shouldBe listOf(ChatEffect.ReadThreads)
        val shut = reduce(open.chat, view(ChatEvent(drawer = ChatEvent.DrawerToggled(opened = false))))
        shut.chat.state.drawer_open shouldBe false
        shut.effects.shouldBeEmpty()
        // The same state again is nothing.
        reduce(shut.chat, view(ChatEvent(drawer = ChatEvent.DrawerToggled(opened = false)))).effects.shouldBeEmpty()
    }

    "the drawer is there before a model is: a member can read and delete chats while one downloads" {
        val begun = reduce(ChatMachine.initial(), view(ChatEvent(opened = ChatEvent.Opened()))).chat
        val chat = reduce(begun, ChatInput.Threads(rows, 1_000_000_000L)).chat
        chat.state.phase shouldBe ChatState.Phase.PHASE_CHECKING
        chat.state.threads shouldHaveSize 2
    }

    // --- opening a past chat ----------------------------------------------------

    "tapping a past chat closes the drawer, shows it loading, and asks for it" {
        val chat = reduce(withThreads(ready()), view(ChatEvent(drawer = ChatEvent.DrawerToggled(opened = true)))).chat
        val step = reduce(chat, view(ChatEvent(thread_opened = ChatEvent.ThreadOpened(thread_id = "t-old"))))
        step.effects shouldBe listOf(ChatEffect.OpenThread("t-old"))
        step.chat.state.drawer_open shouldBe false
        step.chat.state.title shouldBe "Who owes me money?"
        step.chat.state.messages.shouldBeEmpty()
        // No flash of the empty chat's line while the messages are read.
        step.chat.state.empty_line shouldBe ""
        step.chat.state.suggestions.shouldBeEmpty()
    }

    "a running turn is stopped before another chat opens" {
        val running = reduce(withThreads(ready()), view(ChatEvent(sent = ChatEvent.Sent(text = "hi")))).chat
        val step = reduce(running, view(ChatEvent(thread_opened = ChatEvent.ThreadOpened(thread_id = "t-old"))))
        step.effects shouldBe listOf(ChatEffect.Cancel(7L), ChatEffect.OpenThread("t-old"))
        step.chat.running shouldBe false
    }

    "the chat that is open only closes the drawer" {
        val open = withThreads(ready()).copy(threadId = "t-new", drawerOpen = true)
        val step = reduce(open, view(ChatEvent(thread_opened = ChatEvent.ThreadOpened(thread_id = "t-new"))))
        step.effects.shouldBeEmpty()
        step.chat.state.drawer_open shouldBe false
    }

    "a stored thread comes back with its messages, cards, session and scope" {
        val loading = reduce(
            withThreads(ready()),
            view(ChatEvent(thread_opened = ChatEvent.ThreadOpened(thread_id = "t-new"))),
        ).chat
        val thread = stored(
            "tasks",
            question("What is due today?"),
            answer("Rent.", cards = listOf(card("t-1")), notices = listOf(AssistNotice.ASSIST_NOTICE_DOC_TRUNCATED)),
        )
        val opened = reduce(loading, ChatInput.ThreadOpened("t-new", thread, started())).chat
        opened.session shouldBe 9L
        opened.scope shouldBe "tasks"
        opened.state.scope_app shouldBe "tasks"
        opened.state.thread_id shouldBe "t-new"
        opened.state.messages.map { it.text } shouldBe listOf("What is due today?", "Rent.")
        opened.state.messages[1].cards.single().title shouldBe "Pay rent"
        opened.state.messages[1].note shouldBe ChatCopy.NOTE_DOC_TRUNCATED
        // A follow-up works: the session is the core's, rebuilt from this thread,
        // and the question a Retry asks again is the last one stored.
        opened.state.can_retry shouldBe true
        val followUp = reduce(opened, view(ChatEvent(sent = ChatEvent.Sent(text = "and tomorrow?"))))
        followUp.effects.single().let { it as ChatEffect.Send }.session shouldBe 9L
        // Message ids continue where the stored ones stopped.
        followUp.chat.messages.map { it.id } shouldBe listOf(1L, 2L, 3L, 4L)
    }

    "a stopped turn comes back marked stopped, and a refusal comes back as the line it was" {
        val loading = reduce(ready(), view(ChatEvent(thread_opened = ChatEvent.ThreadOpened(thread_id = "t-new")))).chat
        val stopped = reduce(
            loading,
            ChatInput.ThreadOpened(
                "t-new",
                stored("", question("list my tasks"), answer("You have thr", outcome = ChatStoredOutcome.CHAT_STORED_OUTCOME_STOPPED)),
                started(scope = ""),
            ),
        ).chat
        stopped.state.messages.last().stopped shouldBe true
        stopped.state.error shouldBe ""

        val refused = reduce(
            loading,
            ChatInput.ThreadOpened(
                "t-new",
                stored(
                    "",
                    question("meaning of life"),
                    answer(
                        "",
                        outcome = ChatStoredOutcome.CHAT_STORED_OUTCOME_REFUSED,
                        refusal = AssistRefusalReason.ASSIST_REFUSAL_REASON_NO_TOOL_FITS,
                    ),
                ),
                started(scope = ""),
            ),
        ).chat
        // No empty bubble; the refusal is the line at the foot, with Retry.
        refused.state.messages shouldHaveSize 1
        refused.state.error shouldBe ChatCopy.ERROR_NO_TOOL
        refused.state.can_retry shouldBe true
    }

    "a reopened thread draws a stored proposal as an inert card, because no session holds the write" {
        val loading = reduce(ready(), view(ChatEvent(thread_opened = ChatEvent.ThreadOpened(thread_id = "t-new")))).chat
        val opened = reduce(
            loading,
            ChatInput.ThreadOpened(
                "t-new",
                stored(
                    "tasks",
                    question("complete the dry cleaning task"),
                    answer(
                        "Proposed: Complete task \"Dry cleaning\".",
                        outcome = ChatStoredOutcome.CHAT_STORED_OUTCOME_PROPOSED,
                        cards = listOf(card("t-1")),
                    ),
                ),
                started(),
            ),
        ).chat
        val held = opened.state.messages.last()
        // The proposal's own words stay; the card has no buttons to offer and no write to name.
        held.text shouldBe "Proposed: Complete task \"Dry cleaning\"."
        held.cards shouldHaveSize 1
        held.stopped shouldBe false
        val pending = held.pending!!
        pending.state shouldBe ChatPending.State.STATE_INERT
        pending.pending_id shouldBe ""
        pending.settled_line shouldBe "Not done."
        pending.steps.shouldBeEmpty()
        opened.state.error shouldBe ""

        // A tap on it, were a shell to send one, finds nothing waiting and calls nothing.
        val confirm = reduce(opened, view(ChatEvent(pending_confirmed = ChatEvent.PendingConfirmed(pending_id = ""))))
        confirm.effects.shouldBeEmpty()
        val named = reduce(opened, view(ChatEvent(pending_confirmed = ChatEvent.PendingConfirmed(pending_id = "p-1"))))
        named.effects.shouldBeEmpty()
        named.chat.state.messages.last().pending!!.state shouldBe ChatPending.State.STATE_INERT
    }

    "a reopened thread draws how each proposal ended as the line the member was told, with no card" {
        val loading = reduce(ready(), view(ChatEvent(thread_opened = ChatEvent.ThreadOpened(thread_id = "t-new")))).chat
        val ends = mapOf(
            ChatStoredOutcome.CHAT_STORED_OUTCOME_APPLIED to "Done.",
            ChatStoredOutcome.CHAT_STORED_OUTCOME_DISMISSED to "Not done.",
            ChatStoredOutcome.CHAT_STORED_OUTCOME_STALE to ChatCopy.SAID_STALE,
            ChatStoredOutcome.CHAT_STORED_OUTCOME_FAILED to "Not done. The vault refused a step.",
        )
        for ((outcome, line) in ends) {
            val opened = reduce(
                loading,
                ChatInput.ThreadOpened(
                    "t-new",
                    stored("tasks", question("complete the dry cleaning task"), answer(line, outcome = outcome, cards = listOf(card("t-1")))),
                    started(),
                ),
            ).chat
            val held = opened.state.messages.last()
            // The vault replaced the proposal's text with the line, and the rows it named are still there.
            held.text shouldBe line
            held.cards shouldHaveSize 1
            held.pending shouldBe null
            held.stopped shouldBe false
            held.streaming shouldBe false
            opened.state.error shouldBe ""
            opened.state.messages shouldHaveSize 2
        }
    }

    "a word this build has no name for restores as an ordinary answer, never as a card" {
        val loading = reduce(ready(), view(ChatEvent(thread_opened = ChatEvent.ThreadOpened(thread_id = "t-new")))).chat
        val opened = reduce(
            loading,
            ChatInput.ThreadOpened(
                "t-new",
                stored(
                    "tasks",
                    question("what is due?"),
                    answer("Rent.", outcome = ChatStoredOutcome.CHAT_STORED_OUTCOME_UNSPECIFIED),
                ),
                started(),
            ),
        ).chat
        opened.state.messages.last().text shouldBe "Rent."
        opened.state.messages.last().pending shouldBe null
    }

    "a stored camera-roll image keeps its chip and cannot be asked again, so Retry is not offered" {
        val loading = reduce(ready(), view(ChatEvent(thread_opened = ChatEvent.ThreadOpened(thread_id = "t-new")))).chat
        val image = ChatStoredAttachment(
            kind = ChatStoredAttachmentKind.CHAT_STORED_ATTACHMENT_KIND_IMAGE,
            label = "Camera roll",
            thumbnail_path = "/tmp/thumb.jpg",
        )
        val photo = ChatStoredAttachment(
            kind = ChatStoredAttachmentKind.CHAT_STORED_ATTACHMENT_KIND_PHOTO,
            label = "River",
            asset_id = "asset-1",
        )
        val withImage = reduce(
            loading,
            ChatInput.ThreadOpened("t-new", stored("", question("what is this?", listOf(image)), answer("A gradient.")), started(scope = "")),
        ).chat
        withImage.state.messages.first().attachments.single().label shouldBe "Camera roll"
        withImage.state.messages.first().attachments.single().thumbnail_path shouldBe "/tmp/thumb.jpg"
        withImage.state.can_retry shouldBe false

        // A vault photo is a reference a Retry can send again.
        val withPhoto = reduce(
            loading,
            ChatInput.ThreadOpened("t-new", stored("", question("what is this?", listOf(photo)), answer("A river.")), started(scope = "")),
        ).chat
        withPhoto.state.can_retry shouldBe true
        (withPhoto.messages.first().attachments.single().source as AttachSource.VaultPhoto).assetId shouldBe "asset-1"
    }

    "a photo the member has deleted since is a chip with no way to send it again" {
        val loading = reduce(ready(), view(ChatEvent(thread_opened = ChatEvent.ThreadOpened(thread_id = "t-new")))).chat
        val gone = ChatStoredAttachment(
            kind = ChatStoredAttachmentKind.CHAT_STORED_ATTACHMENT_KIND_PHOTO,
            label = "River",
        )
        val chat = reduce(
            loading,
            ChatInput.ThreadOpened("t-new", stored("", question("what is this?", listOf(gone)), answer("A river.")), started(scope = "")),
        ).chat
        chat.messages.first().attachments.single().source shouldBe AttachSource.Unavailable
        chat.state.can_retry shouldBe false
    }

    "a chat deleted from another place says it is gone and becomes a new chat" {
        val loading = reduce(withThreads(ready()), view(ChatEvent(thread_opened = ChatEvent.ThreadOpened(thread_id = "t-old")))).chat
        val step = reduce(loading, ChatInput.ThreadOpened("t-old", ChatThread(found = false), null))
        step.chat.state.error shouldBe ChatCopy.ERROR_THREAD_GONE
        step.chat.state.thread_id shouldBe ""
        step.chat.state.title shouldBe "New chat"
        step.effects shouldBe listOf(ChatEffect.Clear(7L), ChatEffect.ReadThreads)
    }

    "an answer for a chat the member has since left is dropped" {
        val loading = reduce(withThreads(ready()), view(ChatEvent(thread_opened = ChatEvent.ThreadOpened(thread_id = "t-old")))).chat
        val elsewhere = reduce(loading, view(ChatEvent(thread_opened = ChatEvent.ThreadOpened(thread_id = "t-new")))).chat
        val stale = reduce(elsewhere, ChatInput.ThreadOpened("t-old", stored(), started()))
        stale.chat.state.messages.shouldBeEmpty()
        stale.chat.opening shouldBe "t-new"
    }

    // --- new chat, rename, delete -----------------------------------------------

    "a new chat leaves the stored one where it is and starts with no thread" {
        val chat = withThreads(ready()).copy(threadId = "t-new", threadTitle = "What is due today?", drawerOpen = true)
        val step = reduce(chat, view(ChatEvent(new_chat = ChatEvent.NewChat())))
        step.chat.state.thread_id shouldBe ""
        step.chat.state.title shouldBe "New chat"
        step.chat.state.drawer_open shouldBe false
        step.chat.state.threads shouldHaveSize 2
        step.effects shouldBe listOf(ChatEffect.Clear(7L), ChatEffect.Suggest("", 7L))
        // Even a stored chat with nothing on screen can be left.
        step.chat.state.can_new_chat shouldBe false
        reduce(chat, ChatInput.Threads(rows, 1L)).chat.state.can_new_chat shouldBe true
    }

    "rename changes the row and the header at once and tells the vault" {
        val chat = withThreads(ready()).copy(threadId = "t-new", threadTitle = "What is due today?")
        val step = reduce(chat, view(ChatEvent(thread_renamed = ChatEvent.ThreadRenamed(thread_id = "t-new", title = "  Rent   week "))))
        step.effects shouldBe listOf(ChatEffect.RenameThread("t-new", "Rent week"))
        step.chat.state.title shouldBe "Rent week"
        step.chat.state.threads.first { it.thread_id == "t-new" }.title shouldBe "Rent week"
        // A blank title changes nothing.
        reduce(chat, view(ChatEvent(thread_renamed = ChatEvent.ThreadRenamed(thread_id = "t-new", title = "   ")))).effects.shouldBeEmpty()
    }

    "deleting the open chat goes back to a new one; deleting another leaves the open one alone" {
        val chat = withThreads(ready()).copy(threadId = "t-new", threadTitle = "What is due today?")
        val open = reduce(chat, view(ChatEvent(thread_deleted = ChatEvent.ThreadDeleted(thread_id = "t-new"))))
        open.chat.state.thread_id shouldBe ""
        open.chat.state.title shouldBe "New chat"
        open.chat.state.threads.map { it.thread_id } shouldBe listOf("t-old")
        open.effects shouldBe listOf(ChatEffect.DeleteThread("t-new"), ChatEffect.Clear(7L), ChatEffect.Suggest("", 7L))

        val other = reduce(chat, view(ChatEvent(thread_deleted = ChatEvent.ThreadDeleted(thread_id = "t-old"))))
        other.chat.state.thread_id shouldBe "t-new"
        other.chat.state.threads.map { it.thread_id } shouldBe listOf("t-new")
        other.effects shouldBe listOf(ChatEffect.DeleteThread("t-old"))
    }

    "delete all empties the drawer, and an open stored chat goes back to a new one" {
        val chat = withThreads(ready()).copy(threadId = "t-new")
        val step = reduce(chat, view(ChatEvent(all_threads_deleted = ChatEvent.AllThreadsDeleted())))
        step.chat.state.threads.shouldBeEmpty()
        step.chat.state.thread_id shouldBe ""
        step.effects shouldBe listOf(ChatEffect.DeleteAllThreads, ChatEffect.Clear(7L), ChatEffect.Suggest("", 7L))
        // A chat with nothing saved is left as it is.
        val unsaved = reduce(withThreads(ready()), view(ChatEvent(all_threads_deleted = ChatEvent.AllThreadsDeleted())))
        unsaved.effects shouldBe listOf(ChatEffect.DeleteAllThreads)
    }

    "a list the core would not answer leaves the drawer as it was" {
        val chat = withThreads(ready())
        reduce(chat, ChatInput.Threads(null, 5L)).chat.state.threads shouldHaveSize 2
    }

    "every string the drawer and its menu say is in the copy, and none is banned" {
        val state = withThreads(ready(vault = "Sample")).state
        val words = listOf(
            state.drawer_label, state.menu_label, state.rename_label, state.delete_label, state.delete_all_label,
            state.cancel_label, state.save_label, state.rename_title, state.delete_title, state.delete_body,
            state.delete_all_title, state.delete_all_body, state.card_gone_line, state.current_label,
            ChatCopy.THREADS_EMPTY, ChatCopy.ERROR_THREAD_GONE, ChatCopy.AGO_DAYS,
        )
        words.forEach { it.isNotEmpty() shouldBe true }
        val banned = listOf("please", "successfully", "simply", "in order to", "you can", "we're sorry")
        words.forEach { word -> banned.forEach { (word.lowercase().contains(it)) shouldBe false } }
        state.card_gone_line shouldBe "This item is gone."
        state.delete_all_label shouldBe "Delete all chats"
    }

    // --- through a running flow -------------------------------------------------

    "the flow reads the drawer when the tab opens, and again after a saved turn" {
        val rig = Rig()
        rig.door.storedRows = rows.toMutableList()
        rig.open()
        rig.door.history shouldBe listOf("threads")
        rig.state.threads shouldHaveSize 2

        rig.say("What is due today?")
        rig.door.sends.single().reply.complete(
            AssistSent(
                session_id = 7,
                turn_id = 1,
                answered = AssistAnswer(text = "Rent."),
                thread_id = "t-3",
                thread_title = "What is due today?",
            ),
        )
        rig.door.history shouldBe listOf("threads", "threads")
        rig.state.thread_id shouldBe "t-3"
    }

    "the flow opens a past chat: reads it, asks the core for its session, and the follow-up goes to that session" {
        val rig = Rig()
        rig.door.storedRows = rows.toMutableList()
        rig.door.storedThreads["t-new"] = stored("tasks", question("What is due today?"), answer("Rent.", cards = listOf(card("t-1"))))
        rig.open()
        rig.flow.send(ChatEvent(thread_opened = ChatEvent.ThreadOpened(thread_id = "t-new")))
        rig.door.history.takeLast(2) shouldBe listOf("thread:t-new", "start-thread:t-new")
        rig.state.messages.map { it.text } shouldBe listOf("What is due today?", "Rent.")
        rig.state.scope_app shouldBe "tasks"
        rig.say("and tomorrow?")
        rig.door.sends.single().session shouldBe 9L
    }

    "the flow does not ask for a session for a thread that is not there" {
        val rig = Rig()
        rig.open()
        rig.flow.send(ChatEvent(thread_opened = ChatEvent.ThreadOpened(thread_id = "nope")))
        rig.door.history.none { it.startsWith("start-thread") } shouldBe true
        rig.state.error shouldBe ChatCopy.ERROR_THREAD_GONE
    }

    "the flow renames, deletes and clears through the vault and reads the list after each" {
        val rig = Rig()
        rig.door.storedRows = rows.toMutableList()
        rig.open()
        rig.flow.send(ChatEvent(thread_renamed = ChatEvent.ThreadRenamed(thread_id = "t-old", title = "Money")))
        rig.door.history.takeLast(2) shouldBe listOf("rename:t-old:Money", "threads")
        rig.state.threads.first { it.thread_id == "t-old" }.title shouldBe "Money"

        rig.flow.send(ChatEvent(thread_deleted = ChatEvent.ThreadDeleted(thread_id = "t-old")))
        rig.door.history.takeLast(2) shouldBe listOf("delete:t-old", "threads")
        rig.state.threads.map { it.thread_id } shouldBe listOf("t-new")

        rig.flow.send(ChatEvent(all_threads_deleted = ChatEvent.AllThreadsDeleted()))
        rig.door.history.takeLast(2) shouldBe listOf("delete-all", "threads")
        rig.state.threads.shouldBeEmpty()
        rig.state.threads_empty_line shouldBe "No chats yet."
    }

    "deleting the open chat through the flow clears the core's session and starts a new chat" {
        val rig = Rig()
        rig.door.storedRows = rows.toMutableList()
        rig.door.storedThreads["t-new"] = stored("tasks", question("What is due today?"), answer("Rent."))
        rig.open()
        rig.flow.send(ChatEvent(thread_opened = ChatEvent.ThreadOpened(thread_id = "t-new")))
        rig.flow.send(ChatEvent(thread_deleted = ChatEvent.ThreadDeleted(thread_id = "t-new")))
        rig.door.clears shouldBe listOf(9L)
        rig.state.messages.shouldBeEmpty()
        rig.state.thread_id shouldBe ""
        rig.state.title shouldBe "New chat"
    }

    "a screen reader hears an answer's words and not its Markdown markers" {
        ChatMachine.spokenText("You spent **$380** on `gas`") shouldBe "You spent $380 on gas"
        ChatMachine.spokenText("## Today\n- one") shouldBe "Today\n- one"
    }
})
