package dev.centraid.shared

import centraid.core.v1.AssistActivity
import centraid.core.v1.AssistAnswer
import centraid.core.v1.AssistCard
import centraid.core.v1.AssistCards
import centraid.core.v1.AssistEvent
import centraid.core.v1.AssistModelState
import centraid.core.v1.AssistNotice
import centraid.core.v1.AssistPending
import centraid.core.v1.AssistPendingStep
import centraid.core.v1.AssistReading
import centraid.core.v1.AssistReadingKind
import centraid.core.v1.AssistRefusal
import centraid.core.v1.AssistRefusalReason
import centraid.core.v1.AssistSent
import centraid.core.v1.AssistSettleOutcome
import centraid.core.v1.AssistSettled
import centraid.core.v1.AssistToken
import centraid.core.v1.AssistVisionState
import centraid.screen.v1.ChatAttachment
import centraid.screen.v1.ChatEvent
import centraid.screen.v1.ChatMessage
import centraid.screen.v1.ChatPending
import centraid.screen.v1.ChatState
import dev.centraid.design.copy.ChatCopy
import dev.centraid.shared.chat.Chat
import dev.centraid.shared.chat.ChatEffect
import dev.centraid.shared.chat.ChatInput
import dev.centraid.shared.chat.ChatMachine
import dev.centraid.shared.chat.ChatStep
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe

/**
 * THE ON-DEVICE CHAT'S DECISIONS, with no core and no model: what each phase
 * shows, what a tap does in each, and how a turn that the core tells twice —
 * a streamed event and the `send` call's answer — settles once.
 */
class ChatMachineSpec : StringSpec({

    fun reduce(chat: Chat, input: ChatInput): ChatStep = ChatMachine.reduce(chat, input)

    fun view(event: ChatEvent) = ChatInput.View(event)

    fun opened(app: String = "", bytes: Long = 0) =
        view(ChatEvent(opened = ChatEvent.Opened(app = app, model_bytes = bytes)))

    fun sent(text: String) = view(ChatEvent(sent = ChatEvent.Sent(text = text)))

    val stop = view(ChatEvent(stopped = ChatEvent.Stopped()))
    val regenerate = view(ChatEvent(regenerated = ChatEvent.Regenerated()))
    val newChat = view(ChatEvent(new_chat = ChatEvent.NewChat()))
    val download = view(ChatEvent(download = ChatEvent.DownloadTapped()))

    fun progress(done: Long, total: Long) =
        view(ChatEvent(download_progress = ChatEvent.DownloadProgress(done_bytes = done, total_bytes = total)))

    fun finished(ok: Boolean) = view(ChatEvent(download_finished = ChatEvent.DownloadFinished(ok = ok)))

    fun status(state: AssistModelState?) = ChatInput.Status(state)

    val absent = AssistModelState.ASSIST_MODEL_STATE_ABSENT
    val present = AssistModelState.ASSIST_MODEL_STATE_PRESENT
    val modelReady = AssistModelState.ASSIST_MODEL_STATE_READY

    /** A chat that has been opened and told the model is absent. */
    fun waiting(bytes: Long = 0): Chat =
        reduce(reduce(ChatMachine.initial(), opened(bytes = bytes)).chat, status(absent)).chat

    /** A chat with a ready model and a session, the way the core leaves it. */
    fun ready(scope: String = ""): Chat {
        var chat = reduce(ChatMachine.initial(), opened(scope)).chat
        chat = reduce(chat, status(modelReady)).chat
        return reduce(chat, ChatInput.Started(7L)).chat
    }

    fun coreEvent(turn: Long, build: (AssistEvent) -> AssistEvent) =
        ChatInput.Core(build(AssistEvent(session_id = 7, turn_id = turn)))

    fun refusal(reason: AssistRefusalReason) = AssistRefusal(reason = reason)

    fun settledRefused(turn: Long, reason: AssistRefusalReason) =
        ChatInput.Settled(turn, AssistSent(session_id = 7, turn_id = turn, refused = refusal(reason)))

    fun card(id: String, title: String) = AssistCard(app = "tasks", entity = "task", id = id, title = title)

    fun asked(text: String = "What is due today?"): Chat = reduce(ready(), sent(text)).chat

    // --- the opening phases ----------------------------------------------------

    "a fresh chat checks, draws only its header, and names the app it was opened from" {
        val chat = ChatMachine.initial()
        chat.state.phase shouldBe ChatState.Phase.PHASE_CHECKING
        chat.state.title shouldBe "New chat"
        chat.state.subtitle shouldBe "On this phone"
        chat.state.messages.shouldBeEmpty()
        val step = reduce(chat, opened("tally", bytes = 530_000_000))
        // The drawer's list is read beside the model's status, so it is ready
        // before the member opens the drawer.
        step.effects shouldBe listOf(ChatEffect.ReadStatus, ChatEffect.ReadThreads)
        step.chat.state.scope_app shouldBe "tally"
    }

    "no model draws the download step: the size, the one sentence, and Download model" {
        val chat = waiting(bytes = 530_000_000)
        chat.state.phase shouldBe ChatState.Phase.PHASE_NEEDS_MODEL
        val step = chat.state.model_step!!
        step.size_line shouldBe "530 MB download"
        step.note_line shouldBe "This is the only time Centraid fetches anything."
        step.action_label shouldBe "Download model"
        chat.state.messages.shouldBeEmpty()
    }

    "an unknown download size leaves the size line out and keeps the sentence" {
        val chat = waiting()
        chat.state.model_step!!.size_line shouldBe ""
        chat.state.model_step!!.note_line shouldBe ChatCopy.DOWNLOAD_NOTE
    }

    "a build with no engine, or a core that will not answer, is unavailable and not a download problem" {
        val begun = reduce(ChatMachine.initial(), opened()).chat
        for (state in listOf(AssistModelState.ASSIST_MODEL_STATE_NO_ENGINE, null)) {
            val chat = reduce(begun, status(state)).chat
            chat.state.phase shouldBe ChatState.Phase.PHASE_UNAVAILABLE
            chat.state.model_step!!.status_line shouldBe ChatCopy.UNAVAILABLE
            chat.state.model_step!!.action_label shouldBe ""
        }
    }

    "a model on the phone is loaded, then a session is started, then suggestions are asked for" {
        val begun = reduce(ChatMachine.initial(), opened("tasks")).chat
        val loadStep = reduce(begun, status(present))
        loadStep.chat.state.phase shouldBe ChatState.Phase.PHASE_LOADING
        loadStep.chat.state.model_step!!.status_line shouldBe "Loading model"
        loadStep.effects shouldBe listOf(ChatEffect.Load)

        val loaded = reduce(loadStep.chat, ChatInput.Loaded(modelReady))
        loaded.chat.state.phase shouldBe ChatState.Phase.PHASE_READY
        loaded.effects shouldBe listOf(ChatEffect.Start("tasks"))

        val started = reduce(loaded.chat, ChatInput.Started(7L))
        started.effects shouldBe listOf(ChatEffect.Suggest("tasks", 7L))
    }

    "a model that will not load is a model to fetch again, with one line saying so" {
        val loading = reduce(reduce(ChatMachine.initial(), opened()).chat, status(present)).chat
        val chat = reduce(loading, ChatInput.Loaded(null)).chat
        chat.state.phase shouldBe ChatState.Phase.PHASE_NEEDS_MODEL
        chat.state.error shouldBe ChatCopy.LOAD_FAILED
    }

    "a refused session is unavailable" {
        val chat = reduce(reduce(ChatMachine.initial(), opened()).chat, ChatInput.Started(null)).chat
        chat.state.phase shouldBe ChatState.Phase.PHASE_UNAVAILABLE
    }

    "an empty thread offers an empty line and at most three suggestions, and only while empty" {
        val chat = reduce(ready(), ChatInput.Suggested(7L, listOf("a", "b", "c", "d", " "))).chat
        chat.state.empty_line shouldBe ChatCopy.EMPTY_LINE
        chat.state.suggestions shouldBe listOf("a", "b", "c")

        val thread = reduce(chat, sent("hi")).chat
        thread.state.suggestions.shouldBeEmpty()
        thread.state.empty_line shouldBe ""
        // A late answer from the suggest call does not bring them back.
        reduce(thread, ChatInput.Suggested(7L, listOf("x"))).chat.state.suggestions.shouldBeEmpty()
        // Nor does one for a session this chat has left.
        reduce(ready(), ChatInput.Suggested(99L, listOf("x"))).chat.state.suggestions.shouldBeEmpty()
    }

    "the tab appearing again keeps the thread, whatever scope the shell says; a scope CHOSEN starts over" {
        val thread = asked()
        // Same scope: nothing changes. The drawer's list is read afresh unless a
        // turn is running (the saved turn will say when it changed).
        reduce(thread, opened()).effects.shouldBeEmpty()
        reduce(ready(), opened()).effects shouldBe listOf(ChatEffect.ReadThreads)
        reduce(thread, opened()).chat.messages shouldHaveSize 2
        // A different app on a tab appearing is not a choice: a chat with
        // something in it is never re-scoped by a glance at an app.
        reduce(thread, opened("photos")).chat.messages shouldHaveSize 2
        // The composer's menu IS a choice.
        val chosen = reduce(thread, view(ChatEvent(opened = ChatEvent.Opened(app = "photos", scope_chosen = true))))
        chosen.chat.messages.shouldBeEmpty()
        chosen.chat.state.scope_app shouldBe "photos"
        chosen.effects shouldBe listOf(ChatEffect.Cancel(7L), ChatEffect.ReadStatus, ChatEffect.ReadThreads)
        // An untouched chat adopts the app the tab was opened from.
        val adopted = reduce(ready(), opened("tally"))
        adopted.chat.state.scope_app shouldBe "tally"
    }

    "opening a chat that is still waiting for a model looks again, in case the file arrived" {
        reduce(waiting(), opened()).effects shouldBe listOf(ChatEffect.ReadStatus, ChatEffect.ReadThreads)
    }

    // --- the download ----------------------------------------------------------

    "the download step: tap, progress, then a load — and a failure goes back with one line" {
        val tapped = reduce(waiting(bytes = 100), download)
        tapped.effects shouldBe listOf(ChatEffect.StartDownload)
        tapped.chat.state.phase shouldBe ChatState.Phase.PHASE_DOWNLOADING
        tapped.chat.state.model_step!!.progress_known shouldBe false
        tapped.chat.state.model_step!!.status_line shouldBe ChatCopy.DOWNLOAD_PROGRESS_UNKNOWN

        val half = reduce(tapped.chat, progress(42, 100)).chat.state.model_step!!
        half.progress_known shouldBe true
        half.progress shouldBe 0.42f
        half.status_line shouldBe "Downloading 42%"

        val done = reduce(tapped.chat, finished(true))
        done.chat.state.phase shouldBe ChatState.Phase.PHASE_LOADING
        done.effects shouldBe listOf(ChatEffect.Load)

        val failed = reduce(tapped.chat, finished(false)).chat
        failed.state.phase shouldBe ChatState.Phase.PHASE_NEEDS_MODEL
        failed.state.error shouldBe "Download stopped. Retry."
        failed.state.model_step!!.action_label shouldBe "Download model"
    }

    "a download tap outside the download step does nothing, and a stale status read cannot undo a download" {
        reduce(ChatMachine.initial(), download).effects.shouldBeEmpty()
        val tapped = reduce(waiting(), download).chat
        reduce(tapped, status(absent)).chat.state.phase shouldBe ChatState.Phase.PHASE_DOWNLOADING
        // Progress and a finish outside a download are not heard.
        reduce(ready(), progress(1, 2)).chat.state.phase shouldBe ChatState.Phase.PHASE_READY
        reduce(ready(), finished(false)).chat.state.phase shouldBe ChatState.Phase.PHASE_READY
    }

    "a download still running from an earlier launch is DOWNLOADING at once, in either order against the status read" {
        // Progress heard while the chat is still CHECKING (the status read has
        // not landed): the status that lands after it must not undo it.
        val checking = reduce(ChatMachine.initial(), opened(bytes = 530_000_000)).chat
        val resumed = reduce(checking, progress(265_000_000, 530_000_000))
        resumed.chat.state.phase shouldBe ChatState.Phase.PHASE_DOWNLOADING
        resumed.chat.state.model_step!!.status_line shouldBe "Downloading 50%"
        // No second transfer is started: it is already going.
        resumed.effects.shouldBeEmpty()
        reduce(resumed.chat, status(absent)).chat.state.phase shouldBe ChatState.Phase.PHASE_DOWNLOADING

        // Status first: the chat said "Download model", and then progress arrived.
        val offered = waiting(bytes = 530_000_000)
        offered.state.phase shouldBe ChatState.Phase.PHASE_NEEDS_MODEL
        val late = reduce(offered, progress(53_000_000, 530_000_000)).chat
        late.state.phase shouldBe ChatState.Phase.PHASE_DOWNLOADING
        late.state.model_step!!.status_line shouldBe "Downloading 10%"
        late.state.model_step!!.action_label shouldBe ""

        // An unknown total still resumes, with the bar's unknown wording.
        reduce(checking, progress(1_000, 0)).chat.state.model_step!!.status_line shouldBe ChatCopy.DOWNLOAD_PROGRESS_UNKNOWN

        // And it finishes the ordinary way.
        reduce(late, finished(true)).effects shouldBe listOf(ChatEffect.Load)
    }

    // --- a turn ----------------------------------------------------------------

    "sending appends the question and an empty answer, and asks the core once" {
        val step = reduce(ready(), sent("  What is due today?  "))
        step.effects shouldBe listOf(ChatEffect.Send(7L, 1L, "What is due today?", regenerate = false))
        val messages = step.chat.state.messages
        messages shouldHaveSize 2
        messages[0].role shouldBe ChatMessage.Role.ROLE_USER
        messages[0].text shouldBe "What is due today?"
        messages[1].role shouldBe ChatMessage.Role.ROLE_ASSISTANT
        messages[1].streaming shouldBe true
        step.chat.state.streaming shouldBe true
        messages.map { it.id } shouldBe listOf(1L, 2L)
    }

    "a blank message, a message while one runs, and a message before the model is ready are not sent" {
        reduce(ready(), sent("   ")).effects.shouldBeEmpty()
        reduce(asked(), sent("again")).effects.shouldBeEmpty()
        reduce(ChatMachine.initial(), sent("early")).effects.shouldBeEmpty()
        val noSession = reduce(reduce(ChatMachine.initial(), opened()).chat, status(modelReady)).chat
        noSession.session shouldBe 0L
        reduce(noSession, sent("hi")).effects.shouldBeEmpty()
    }

    "a turn draws its activity, then its cards, then its sentence as it comes, then the answer" {
        var chat = asked()
        chat = reduce(chat, coreEvent(1) { it.copy(activity = AssistActivity(app = "tasks", tool = "tasks.list")) }).chat
        chat.state.activity shouldBe "Looking in Tasks"

        chat = reduce(
            chat,
            coreEvent(1) { it.copy(cards = AssistCards(cards = listOf(card("t1", "Pick up the dry cleaning")))) },
        ).chat
        chat.state.messages.last().cards.map { it.title } shouldBe listOf("Pick up the dry cleaning")
        chat.state.messages.last().streaming shouldBe true

        chat = reduce(chat, coreEvent(1) { it.copy(token = AssistToken(text = "One thing ")) }).chat
        chat = reduce(chat, coreEvent(1) { it.copy(token = AssistToken(text = "is due.")) }).chat
        chat.state.messages.last().text shouldBe "One thing is due."

        chat = reduce(
            chat,
            coreEvent(1) {
                it.copy(
                    answer = AssistAnswer(
                        text = "One thing is due today.",
                        cards = listOf(card("t1", "Pick up the dry cleaning")),
                    ),
                )
            },
        ).chat
        val last = chat.state.messages.last()
        last.text shouldBe "One thing is due today."
        last.streaming shouldBe false
        last.cards shouldHaveSize 1
        chat.state.streaming shouldBe false
        chat.state.activity shouldBe ""
        chat.state.error shouldBe ""
        chat.state.can_retry shouldBe true
        chat.state.can_new_chat shouldBe true
    }

    "the tool activity names the app the core named" {
        val chat = reduce(
            asked(),
            coreEvent(1) { it.copy(activity = AssistActivity(app = "tally", tool = "tally.balances")) },
        ).chat
        chat.state.activity shouldBe "Looking in Tally"
    }

    "the answer to the send call settles the turn exactly as the terminal event does, whichever comes first" {
        val reply = AssistSent(
            session_id = 7,
            turn_id = 1,
            answered = AssistAnswer(text = "Done.", cards = listOf(card("t1", "A"))),
        )
        val terminal = coreEvent(1) {
            it.copy(answer = AssistAnswer(text = "Done.", cards = listOf(card("t1", "A"))))
        }

        val responseFirst = reduce(reduce(asked(), ChatInput.Settled(1, reply)).chat, terminal).chat
        val eventFirst = reduce(reduce(asked(), terminal).chat, ChatInput.Settled(1, reply)).chat
        responseFirst.state shouldBe eventFirst.state
        responseFirst.state.messages shouldHaveSize 2
        responseFirst.state.messages.last().text shouldBe "Done."
    }

    "an event for another turn or another chat is not heard" {
        val chat = asked()
        val before = chat.state
        reduce(chat, coreEvent(2) { it.copy(token = AssistToken(text = "stale")) }).chat.state shouldBe before
        reduce(
            chat,
            ChatInput.Core(AssistEvent(session_id = 8, turn_id = 1, token = AssistToken(text = "other"))),
        ).chat.state shouldBe before
        reduce(chat, ChatInput.Settled(2, null)).chat.state shouldBe before
        // And nothing is heard once the turn is settled.
        val settled = reduce(chat, coreEvent(1) { it.copy(answer = AssistAnswer(text = "Done.")) }).chat
        reduce(settled, coreEvent(1) { it.copy(token = AssistToken(text = "late")) }).chat.state shouldBe settled.state
    }

    // --- failures --------------------------------------------------------------

    "each refusal is one line, and an answer with nothing in it is dropped" {
        val cases = mapOf(
            AssistRefusalReason.ASSIST_REFUSAL_REASON_NO_TOOL_FITS to ChatCopy.ERROR_NO_TOOL,
            AssistRefusalReason.ASSIST_REFUSAL_REASON_QUERY_FAILED to ChatCopy.ERROR_READ,
            AssistRefusalReason.ASSIST_REFUSAL_REASON_MODEL_FAILED to ChatCopy.ERROR_MODEL,
            AssistRefusalReason.ASSIST_REFUSAL_REASON_UNPARSABLE to ChatCopy.ERROR_GENERIC,
            AssistRefusalReason.ASSIST_REFUSAL_REASON_BUSY to ChatCopy.ERROR_GENERIC,
        )
        cases.forEach { (reason, line) ->
            val chat = reduce(asked(), settledRefused(1, reason)).chat
            chat.state.error shouldBe line
            chat.state.messages shouldHaveSize 1
            chat.state.messages.single().role shouldBe ChatMessage.Role.ROLE_USER
            chat.state.streaming shouldBe false
            chat.state.can_retry shouldBe true
        }
    }

    "a failed call is the generic line" {
        val chat = reduce(asked(), ChatInput.Settled(1, null)).chat
        chat.state.error shouldBe ChatCopy.ERROR_GENERIC
        chat.state.messages shouldHaveSize 1
    }

    "a failure after the cards were drawn keeps them, marked stopped, and says the line" {
        var chat = asked()
        chat = reduce(chat, coreEvent(1) { it.copy(cards = AssistCards(cards = listOf(card("t1", "A")))) }).chat
        chat = reduce(
            chat,
            coreEvent(1) { it.copy(failed = refusal(AssistRefusalReason.ASSIST_REFUSAL_REASON_MODEL_FAILED)) },
        ).chat
        chat.state.messages shouldHaveSize 2
        chat.state.messages.last().stopped shouldBe true
        chat.state.messages.last().cards shouldHaveSize 1
        chat.state.error shouldBe ChatCopy.ERROR_MODEL
    }

    "stopping keeps the part that was drawn, says nothing about it, and offers Retry" {
        var chat = asked()
        chat = reduce(chat, coreEvent(1) { it.copy(token = AssistToken(text = "One thing")) }).chat
        chat = reduce(chat, settledRefused(1, AssistRefusalReason.ASSIST_REFUSAL_REASON_CANCELLED)).chat
        chat.state.error shouldBe ""
        chat.state.messages.last().text shouldBe "One thing"
        chat.state.messages.last().stopped shouldBe true
        chat.state.messages.last().accessibility_label shouldBe "Centraid said: One thing. Stopped"
        chat.state.can_retry shouldBe true

        val nothing = reduce(asked(), settledRefused(1, AssistRefusalReason.ASSIST_REFUSAL_REASON_CANCELLED)).chat
        nothing.state.messages shouldHaveSize 1
        nothing.state.error shouldBe ""
    }

    "a model that went away sends the chat back to ask where it stands" {
        val step = reduce(asked(), settledRefused(1, AssistRefusalReason.ASSIST_REFUSAL_REASON_MODEL_ABSENT))
        step.effects shouldBe listOf(ChatEffect.ReadStatus)
        step.chat.state.phase shouldBe ChatState.Phase.PHASE_CHECKING
        step.chat.state.error shouldBe ""
    }

    // --- stop, retry, new chat, copy --------------------------------------------

    "stop reaches the core only while a turn runs" {
        reduce(asked(), stop).effects shouldBe listOf(ChatEffect.Cancel(7L))
        reduce(ready(), stop).effects.shouldBeEmpty()
    }

    "retry asks the same question again in place of the last answer" {
        var chat = asked("What is due today?")
        chat = reduce(
            chat,
            coreEvent(1) {
                it.copy(answer = AssistAnswer(text = "First wording.", cards = listOf(card("t1", "A"))))
            },
        ).chat
        val step = reduce(chat, regenerate)
        step.effects shouldBe listOf(ChatEffect.Send(7L, 2L, "What is due today?", regenerate = true))
        val messages = step.chat.state.messages
        messages shouldHaveSize 2
        messages[0].text shouldBe "What is due today?"
        messages[1].text shouldBe ""
        messages[1].streaming shouldBe true
        messages[1].cards.shouldBeEmpty()
        // The retried turn is turn 2: the first one's stragglers are stale.
        reduce(step.chat, coreEvent(1) { it.copy(token = AssistToken(text = "stale")) }).chat.state shouldBe
            step.chat.state
    }

    "retry after a failure that left no answer still has the question to ask" {
        val failed = reduce(asked(), settledRefused(1, AssistRefusalReason.ASSIST_REFUSAL_REASON_QUERY_FAILED)).chat
        val step = reduce(failed, regenerate)
        step.effects shouldBe listOf(ChatEffect.Send(7L, 2L, "What is due today?", regenerate = true))
        step.chat.state.messages shouldHaveSize 2
        step.chat.state.error shouldBe ""
    }

    "retry is not offered while running, before a question, or on a fresh chat" {
        reduce(asked(), regenerate).effects.shouldBeEmpty()
        reduce(ready(), regenerate).effects.shouldBeEmpty()
        ready().state.can_retry shouldBe false
    }

    "a new chat clears the thread, stops what was running, and asks for fresh suggestions" {
        val step = reduce(asked(), newChat)
        step.effects shouldBe listOf(ChatEffect.Clear(7L), ChatEffect.Suggest("", 7L))
        step.chat.state.messages.shouldBeEmpty()
        step.chat.state.streaming shouldBe false
        step.chat.state.can_new_chat shouldBe false
        step.chat.state.empty_line shouldBe ChatCopy.EMPTY_LINE
        // The abandoned turn's stragglers are heard by nobody.
        reduce(step.chat, coreEvent(1) { it.copy(token = AssistToken(text = "stale")) }).chat.state shouldBe
            step.chat.state
        reduce(step.chat, ChatInput.Settled(1, null)).chat.state shouldBe step.chat.state
        // And the next question is a new turn, not the abandoned one.
        reduce(step.chat, sent("fresh")).effects shouldBe
            listOf(ChatEffect.Send(7L, 3L, "fresh", regenerate = false))
    }

    "copy puts one message's text on the clipboard, and an unknown message nothing" {
        var chat = asked("What is due today?")
        chat = reduce(chat, coreEvent(1) { it.copy(answer = AssistAnswer(text = "One thing is due.")) }).chat
        reduce(chat, view(ChatEvent(copied = ChatEvent.Copied(message_id = 2)))).effects shouldBe
            listOf(ChatEffect.Copy("One thing is due."))
        reduce(chat, view(ChatEvent(copied = ChatEvent.Copied(message_id = 1)))).effects shouldBe
            listOf(ChatEffect.Copy("What is due today?"))
        reduce(chat, view(ChatEvent(copied = ChatEvent.Copied(message_id = 99)))).effects.shouldBeEmpty()
    }

    // --- what is drawn ----------------------------------------------------------

    "the thread is drawn only when the model is ready, and every label comes from the copy table" {
        val notReady = waiting().state
        notReady.messages.shouldBeEmpty()
        notReady.empty_line shouldBe ""
        val state = ready().state
        state.composer_placeholder shouldBe ChatCopy.COMPOSER_PLACEHOLDER
        state.send_label shouldBe ChatCopy.SEND
        state.stop_label shouldBe ChatCopy.STOP
        state.new_chat_label shouldBe ChatCopy.NEW_CHAT
        state.retry_label shouldBe ChatCopy.RETRY
        state.copy_label shouldBe ChatCopy.COPY
        state.model_step shouldBe null
    }

    "a message reads for a screen reader as who said what" {
        val chat = asked("What is due today?")
        chat.state.messages[0].accessibility_label shouldBe "You said: What is due today?"
    }

    "sizes are quoted in decimal units" {
        ChatMachine.sizeText(530_000_000) shouldBe "530 MB"
        ChatMachine.sizeText(1_600_000_000) shouldBe "1.6 GB"
        ChatMachine.sizeText(1_040_000_000) shouldBe "1.0 GB"
        ChatMachine.sizeText(1_000) shouldBe "1 MB"
        ChatMachine.sizeText(0) shouldBe ""
    }

    "an app id reads as its name" {
        ChatMachine.appName("tally") shouldBe "Tally"
        ChatMachine.appName("") shouldBe ""
    }

    // --- attachments ------------------------------------------------------------

    fun photo(asset: String = "a1", label: String = "Truckee river bend") = view(
        ChatEvent(
            attached = ChatEvent.Attached(
                vault_photo = ChatEvent.VaultPhoto(asset_id = asset),
                label = label,
                thumbnail_path = "/t/$asset.jpg",
            ),
        ),
    )

    fun document(id: String = "d1", label: String = "Tahoe packing list") = view(
        ChatEvent(
            attached = ChatEvent.Attached(vault_document = ChatEvent.VaultDocument(doc_id = id), label = label),
        ),
    )

    fun visionStatus(state: AssistVisionState?, bytes: Long = 204_987_232L) = ChatInput.VisionStatus(state, bytes)

    val visionReady = AssistVisionState.ASSIST_VISION_STATE_READY
    val visionPresent = AssistVisionState.ASSIST_VISION_STATE_PRESENT
    val visionAbsent = AssistVisionState.ASSIST_VISION_STATE_ABSENT

    /** A ready chat with a photo waiting and the reader known to be on the model. */
    fun seeing(): Chat {
        val attached = reduce(ready(), photo()).chat
        return reduce(attached, visionStatus(visionReady)).chat
    }

    "a photo waits in the composer as a chip and asks where the reader stands" {
        val step = reduce(ready(), photo())
        step.effects shouldBe listOf(ChatEffect.ReadVision)
        val chip = step.chat.state.pending.single()
        chip.kind shouldBe ChatAttachment.Kind.KIND_PHOTO
        chip.label shouldBe "Truckee river bend"
        chip.thumbnail_path shouldBe "/t/a1.jpg"
        step.chat.state.vision_blocked shouldBe true
        step.chat.state.can_attach shouldBe true
        step.chat.state.attach_label shouldBe "Attach"
        step.chat.state.attach_vault_photo_label shouldBe "Photo from vault"
        step.chat.state.attach_library_photo_label shouldBe "Photo library"
        step.chat.state.attach_document_label shouldBe "Document"
    }

    "no reader on the phone is the offer, with the size and one action, and a send waits" {
        val offered = reduce(reduce(ready(), photo()).chat, visionStatus(visionAbsent)).chat
        val step = offered.state.vision_step!!
        step.size_line shouldBe "Reading photos needs a 205 MB download"
        step.action_label shouldBe "Download"
        offered.state.vision_blocked shouldBe true
        reduce(offered, sent("What is in this photo?")).effects.shouldBeEmpty()
    }

    "the reader's download runs, loads, and unblocks the send" {
        val offered = reduce(reduce(ready(), photo()).chat, visionStatus(visionAbsent)).chat
        val tapped = reduce(offered, view(ChatEvent(download = ChatEvent.DownloadTapped(vision = true))))
        tapped.effects shouldBe listOf(ChatEffect.StartVisionDownload)
        tapped.chat.state.vision_step!!.status_line shouldBe "Downloading"

        val moving = reduce(
            tapped.chat,
            view(ChatEvent(download_progress = ChatEvent.DownloadProgress(done_bytes = 25, total_bytes = 100, vision = true))),
        ).chat
        moving.state.vision_step!!.progress_known shouldBe true
        moving.state.vision_step!!.status_line shouldBe "Downloading 25%"
        // The model's own step is untouched by the reader's transfer.
        moving.state.phase shouldBe ChatState.Phase.PHASE_READY

        val done = reduce(moving, view(ChatEvent(download_finished = ChatEvent.DownloadFinished(ok = true, vision = true))))
        done.effects shouldBe listOf(ChatEffect.LoadVision)
        done.chat.state.vision_step!!.status_line shouldBe "Loading photo reader"

        val loaded = reduce(done.chat, ChatInput.VisionLoaded(visionReady)).chat
        loaded.state.vision_step shouldBe null
        loaded.state.vision_blocked shouldBe false
    }

    "a reader download that stops, or will not load, is offered again with one line" {
        val offered = reduce(reduce(ready(), photo()).chat, visionStatus(visionAbsent)).chat
        val tapped = reduce(offered, view(ChatEvent(download = ChatEvent.DownloadTapped(vision = true)))).chat
        val stopped = reduce(tapped, view(ChatEvent(download_finished = ChatEvent.DownloadFinished(ok = false, vision = true)))).chat
        stopped.state.vision_step!!.action_label shouldBe "Download"
        stopped.state.vision_step!!.status_line shouldBe ChatCopy.DOWNLOAD_FAILED

        val again = reduce(stopped, view(ChatEvent(download = ChatEvent.DownloadTapped(vision = true)))).chat
        val loading = reduce(again, view(ChatEvent(download_finished = ChatEvent.DownloadFinished(ok = true, vision = true)))).chat
        val refused = reduce(loading, ChatInput.VisionLoaded(visionPresent)).chat
        refused.state.vision_step!!.status_line shouldBe ChatCopy.VISION_LOAD_FAILED
        refused.state.vision_blocked shouldBe true
    }

    "a reader on the phone and not on the model loads without a download" {
        val step = reduce(reduce(ready(), photo()).chat, visionStatus(visionPresent))
        step.effects shouldBe listOf(ChatEffect.LoadVision)
        step.chat.state.vision_step!!.status_line shouldBe ChatCopy.VISION_LOADING
    }

    "removing the photo takes its offer away, and a document needs no reader at all" {
        val offered = reduce(reduce(ready(), photo()).chat, visionStatus(visionAbsent)).chat
        val id = offered.state.pending.single().id
        val removed = reduce(offered, view(ChatEvent(attachment_removed = ChatEvent.AttachmentRemoved(id = id)))).chat
        removed.state.pending.shouldBeEmpty()
        removed.state.vision_step shouldBe null
        removed.state.vision_blocked shouldBe false

        val doc = reduce(ready(), document())
        doc.effects.shouldBeEmpty()
        doc.chat.state.pending.single().kind shouldBe ChatAttachment.Kind.KIND_DOCUMENT
        doc.chat.state.vision_blocked shouldBe false
    }

    "a message takes one photo and one document: a second of a kind replaces the first" {
        var chat = seeing()
        chat = reduce(chat, photo("a2", "Harbor lights")).chat
        chat = reduce(chat, document("d1", "First")).chat
        chat = reduce(chat, document("d2", "Second")).chat
        chat.state.pending.map { it.label } shouldBe listOf("Harbor lights", "Second")
        chat.state.pending.map { it.kind } shouldBe
            listOf(ChatAttachment.Kind.KIND_PHOTO, ChatAttachment.Kind.KIND_DOCUMENT)
    }

    "a send carries what waits, shows it on the member's message as chips, and empties the composer" {
        val chat = reduce(seeing(), document()).chat
        val step = reduce(chat, sent("What is in this photo?"))
        val effect = step.effects.single() as ChatEffect.Send
        effect.attachments.map { it.label } shouldBe listOf("Truckee river bend", "Tahoe packing list")
        effect.regenerate shouldBe false
        step.chat.state.pending.shouldBeEmpty()
        val user = step.chat.state.messages.first()
        user.attachments.map { it.label } shouldBe listOf("Truckee river bend", "Tahoe packing list")
        user.accessibility_label shouldBe
            "You said: What is in this photo?. Attached: Truckee river bend. Attached: Tahoe packing list"
        // Thinking, before the model says anything.
        step.chat.state.activity shouldBe "Thinking"
    }

    "retry asks the last turn's attachments again and keeps the member's message as it was" {
        val first = reduce(seeing(), sent("What is in this photo?"))
        val turn = (first.effects.single() as ChatEffect.Send).turn
        val answered = reduce(first.chat, ChatInput.Settled(turn, AssistSent(session_id = 7, turn_id = turn, answered = AssistAnswer(text = "A river."))))
        val again = reduce(answered.chat, regenerate)
        val effect = again.effects.single() as ChatEffect.Send
        effect.regenerate shouldBe true
        effect.attachments.map { it.label } shouldBe listOf("Truckee river bend")
        again.chat.state.messages.first().attachments.map { it.label } shouldBe listOf("Truckee river bend")
    }

    "attaching waits for a thread, and not while a turn runs" {
        reduce(ChatMachine.initial(), photo()).effects.shouldBeEmpty()
        reduce(waiting(), document()).chat.state.pending.shouldBeEmpty()
        val running = asked()
        reduce(running, document()).chat.state.pending.shouldBeEmpty()
    }

    "reading an attachment names the wait, and the first words end it" {
        val chat = reduce(seeing(), sent("What is in this photo?")).chat
        val reading = reduce(chat, coreEvent(1) { it.copy(reading = AssistReading(kind = AssistReadingKind.ASSIST_READING_KIND_PHOTO)) }).chat
        reading.state.activity shouldBe "Reading the photo"
        val doc = reduce(chat, coreEvent(1) { it.copy(reading = AssistReading(kind = AssistReadingKind.ASSIST_READING_KIND_DOCUMENT)) }).chat
        doc.state.activity shouldBe "Reading the document"
        // "Thinking" ends with the first token; a reading line stays until the end.
        reduce(chat, coreEvent(1) { it.copy(token = AssistToken(text = "A river")) }).chat.state.activity shouldBe ""
        reduce(reading, coreEvent(1) { it.copy(token = AssistToken(text = "A river")) }).chat.state.activity shouldBe "Reading the photo"
    }

    "a cut document is said on the answer" {
        val chat = reduce(reduce(ready(), document()).chat, sent("Summarise it")).chat
        val settled = reduce(
            chat,
            ChatInput.Settled(
                1,
                AssistSent(
                    session_id = 7,
                    turn_id = 1,
                    answered = AssistAnswer(text = "The start.", notices = listOf(AssistNotice.ASSIST_NOTICE_DOC_TRUNCATED)),
                ),
            ),
        ).chat
        settled.state.messages.last().note shouldBe "Read the first part of the document."
        // A whole document says nothing.
        val whole = reduce(chat, ChatInput.Settled(1, AssistSent(session_id = 7, turn_id = 1, answered = AssistAnswer(text = "All."))))
        whole.chat.state.messages.last().note shouldBe ""
    }

    "each attachment refusal is its own line, and a lost reader looks again" {
        val cases = mapOf(
            AssistRefusalReason.ASSIST_REFUSAL_REASON_ATTACHMENT_UNSUPPORTED to ChatCopy.ERROR_ATTACH_UNSUPPORTED,
            AssistRefusalReason.ASSIST_REFUSAL_REASON_ATTACHMENT_UNREADABLE to ChatCopy.ERROR_ATTACH_UNREADABLE,
            AssistRefusalReason.ASSIST_REFUSAL_REASON_ATTACHMENT_TOO_LARGE to ChatCopy.ERROR_ATTACH_TOO_LARGE,
        )
        for ((reason, line) in cases) {
            val chat = reduce(seeing(), sent("What is in this photo?")).chat
            reduce(chat, settledRefused(1, reason)).chat.state.error shouldBe line
        }
        val chat = reduce(seeing(), sent("What is in this photo?")).chat
        val lost = reduce(chat, settledRefused(1, AssistRefusalReason.ASSIST_REFUSAL_REASON_VISION_ABSENT))
        lost.chat.state.error shouldBe ChatCopy.ERROR_VISION
        lost.effects shouldBe listOf(ChatEffect.ReadVision)
        // The reader is no longer known to be on the model.
        reduce(lost.chat, photo("a9")).effects shouldBe listOf(ChatEffect.ReadVision)
    }

    "a new chat leaves nothing waiting, and nothing to retry with" {
        val chat = reduce(seeing(), sent("What is in this photo?")).chat
        val cleared = reduce(chat, newChat).chat
        cleared.pending.shouldBeEmpty()
        cleared.lastSent.shouldBeEmpty()
        val waitingChat = reduce(seeing(), document()).chat
        reduce(waitingChat, newChat).chat.state.pending.shouldBeEmpty()
    }

    "the model's own download is not the reader's: a vision event never moves the model's phase" {
        val chat = waiting(bytes = 530_000_000)
        val ignored = reduce(chat, view(ChatEvent(download = ChatEvent.DownloadTapped(vision = true))))
        ignored.effects.shouldBeEmpty()
        ignored.chat.state.phase shouldBe ChatState.Phase.PHASE_NEEDS_MODEL
    }

    // --- a proposed write, as a card (#1088, R-1088-2) --------------------------

    val dryCleaning = "Complete task \"Pick up the dry cleaning\""

    fun proposal(id: String = "p1", destructive: Boolean = false, more: Int = 0) = AssistPending(
        pending_id = id,
        verbs = listOf(if (destructive) "delete" else "complete"),
        steps = listOf(
            AssistPendingStep(
                verb = if (destructive) "delete" else "complete",
                kind = "task",
                title = "Pick up the dry cleaning",
                summary = if (destructive) "Delete task \"Pick up the dry cleaning\"" else dryCleaning,
                destructive = destructive,
            ),
        ),
        destructive = destructive,
        more = more,
    )

    fun pendingEvent(turn: Long, card: AssistPending) = coreEvent(turn) { it.copy(pending = card) }

    fun answerWith(turn: Long, card: AssistPending?) =
        coreEvent(turn) { it.copy(answer = AssistAnswer(text = "Proposed: $dryCleaning.", pending = card)) }

    /** A turn that parked a write: the card on the stream, the answer not yet in. */
    fun proposed(card: AssistPending = proposal()): Chat = reduce(asked(), pendingEvent(1, card)).chat

    /** The same turn settled: a card waiting for a tap. */
    fun waitingCard(card: AssistPending = proposal()): Chat = reduce(proposed(card), answerWith(1, card)).chat

    fun confirmTap(id: String = "p1") =
        view(ChatEvent(pending_confirmed = ChatEvent.PendingConfirmed(pending_id = id)))

    fun cancelTap(id: String = "p1") =
        view(ChatEvent(pending_cancelled = ChatEvent.PendingCancelled(pending_id = id)))

    fun confirmedAs(outcome: AssistSettleOutcome, line: String, id: String = "p1") =
        ChatInput.Confirmed(id, AssistSettled(session_id = 7, pending_id = id, outcome = outcome, line = line))

    fun cardOf(chat: Chat): ChatPending = chat.state.messages.last().pending!!

    "a write the model parks arrives as a card under its answer, in the core's words, waiting for a tap" {
        val streaming = proposed()
        // Drawn only once the answer stops streaming; the message says it is still streaming.
        streaming.state.messages.last().streaming shouldBe true
        val chat = waitingCard()
        val card = cardOf(chat)
        card.state shouldBe ChatPending.State.STATE_WAITING
        card.pending_id shouldBe "p1"
        card.steps.map { it.summary } shouldBe listOf(dryCleaning)
        card.steps.map { it.destructive } shouldBe listOf(false)
        card.destructive shouldBe false
        card.confirm_label shouldBe "Confirm"
        card.cancel_label shouldBe "Cancel"
        card.settled_line shouldBe ""
        card.more_line shouldBe ""
        card.accessibility_label shouldBe "Proposed change. $dryCleaning"
        chat.state.messages.last().streaming shouldBe false
        chat.state.messages.last().text shouldBe "Proposed: $dryCleaning."
    }

    "a turn that proposed nothing has no card" {
        val chat = reduce(asked(), answerWith(1, null)).chat
        chat.state.messages.last().pending shouldBe null
    }

    "the stream and the answer carry the same card, so either alone is enough and both are one" {
        // The stream's card was dropped from a full queue: the terminal event still has it.
        cardOf(reduce(asked(), answerWith(1, proposal())).chat).state shouldBe ChatPending.State.STATE_WAITING
        // The events were all dropped: the send call's own answer has it.
        val sent = AssistSent(session_id = 7, turn_id = 1, answered = AssistAnswer(text = "Proposed.", pending = proposal()))
        cardOf(reduce(asked(), ChatInput.Settled(1, sent)).chat).pending_id shouldBe "p1"
        // Both, in either order: still one card, and a tap made between them is not undone.
        val tapped = reduce(waitingCard(), confirmTap()).chat
        val again = reduce(tapped, ChatInput.Settled(1, sent)).chat
        cardOf(again).state shouldBe ChatPending.State.STATE_WORKING
        again.state.messages shouldHaveSize 2
    }

    "Confirm moves the card to working and asks the core once, whatever is tapped after" {
        val step = reduce(waitingCard(), confirmTap())
        step.effects shouldBe listOf(ChatEffect.Confirm(7L, "p1"))
        cardOf(step.chat).state shouldBe ChatPending.State.STATE_WORKING
        // A second tap while the core works asks nothing.
        reduce(step.chat, confirmTap()).effects.shouldBeEmpty()
        reduce(step.chat, cancelTap()).effects.shouldBeEmpty()
    }

    "the core's answer settles the card with its own line, and an applied card offers no undo" {
        val working = reduce(waitingCard(), confirmTap()).chat
        val applied = reduce(working, confirmedAs(AssistSettleOutcome.ASSIST_SETTLE_OUTCOME_APPLIED, "Done.")).chat
        val card = cardOf(applied)
        card.state shouldBe ChatPending.State.STATE_APPLIED
        card.settled_line shouldBe "Done."
        card.accessibility_label shouldBe "Proposed change. $dryCleaning. Done."
        // The card has Confirm and Cancel labels and nothing else to tap: there is no Undo.
        applied.state.messages.last().text shouldBe "Proposed: $dryCleaning."
        // Settled once: a second answer for the same card changes nothing.
        reduce(applied, confirmedAs(AssistSettleOutcome.ASSIST_SETTLE_OUTCOME_STALE, "That changed since. Ask again.")).chat
            .let { cardOf(it).state shouldBe ChatPending.State.STATE_APPLIED }
    }

    "a card whose rows moved says so, and a refusal or a card that was gone is not done" {
        val working = reduce(waitingCard(), confirmTap()).chat
        val stale = cardOf(reduce(working, confirmedAs(AssistSettleOutcome.ASSIST_SETTLE_OUTCOME_STALE, "That changed since. Ask again.")).chat)
        stale.state shouldBe ChatPending.State.STATE_STALE
        stale.settled_line shouldBe "That changed since. Ask again."

        val refused = cardOf(reduce(working, confirmedAs(AssistSettleOutcome.ASSIST_SETTLE_OUTCOME_REFUSED, "Not done. That date is past.")).chat)
        refused.state shouldBe ChatPending.State.STATE_NOT_DONE
        refused.settled_line shouldBe "Not done. That date is past."

        val gone = cardOf(reduce(working, confirmedAs(AssistSettleOutcome.ASSIST_SETTLE_OUTCOME_NOTHING_WAITING, "Nothing is waiting on that.")).chat)
        gone.state shouldBe ChatPending.State.STATE_NOT_DONE
        gone.settled_line shouldBe "Nothing is waiting on that."
    }

    "Cancel settles the card to not done at once and tells the core, which writes nothing" {
        val step = reduce(waitingCard(), cancelTap())
        step.effects shouldBe listOf(ChatEffect.Dismiss(7L, "p1"))
        val card = cardOf(step.chat)
        card.state shouldBe ChatPending.State.STATE_NOT_DONE
        card.settled_line shouldBe "Not done."
        // Nothing more to tap.
        reduce(step.chat, confirmTap()).effects.shouldBeEmpty()
        reduce(step.chat, cancelTap()).effects.shouldBeEmpty()
    }

    "a confirm whose call failed offers the card again with one error line, and claims no outcome" {
        val working = reduce(waitingCard(), confirmTap()).chat
        val failed = reduce(working, ChatInput.Confirmed("p1", null)).chat
        cardOf(failed).state shouldBe ChatPending.State.STATE_WAITING
        failed.state.error shouldBe ChatCopy.ERROR_GENERIC
        // and a tap clears the line and asks again
        val retried = reduce(failed, confirmTap())
        retried.effects shouldBe listOf(ChatEffect.Confirm(7L, "p1"))
        retried.chat.state.error shouldBe ""
    }

    "a new question supersedes a card still waiting, but never one the core is running" {
        val waiting = waitingCard()
        val next = reduce(waiting, sent("Something else")).chat
        next.state.messages.first { it.pending != null }.pending!!.state shouldBe ChatPending.State.STATE_INERT
        next.state.messages.first { it.pending != null }.pending!!.settled_line shouldBe "Not done."
        // An inert card cannot be tapped, even by a late tap.
        reduce(next, confirmTap()).effects.shouldBeEmpty()

        val working = reduce(waitingCard(), confirmTap()).chat
        val asking = reduce(working, sent("Something else")).chat
        asking.state.messages.first { it.pending != null }.pending!!.state shouldBe ChatPending.State.STATE_WORKING
        // and the core's answer still lands on it
        val applied = reduce(asking, confirmedAs(AssistSettleOutcome.ASSIST_SETTLE_OUTCOME_APPLIED, "Done.")).chat
        applied.state.messages.first { it.pending != null }.pending!!.state shouldBe ChatPending.State.STATE_APPLIED
    }

    "a card that asks twice is drawn destructive, line by line, and says how many rows it does not list" {
        val chat = waitingCard(proposal(destructive = true, more = 3))
        val card = cardOf(chat)
        card.destructive shouldBe true
        card.steps.single().destructive shouldBe true
        card.more_line shouldBe "and 3 more"
        card.accessibility_label shouldBe
            "Proposed change. Removes something. Delete task \"Pick up the dry cleaning\". and 3 more"
    }

    "taps that are not for a waiting card do nothing: another id, no id, a turn still running, a chat with no session" {
        reduce(waitingCard(), confirmTap("other")).effects.shouldBeEmpty()
        reduce(waitingCard(), confirmTap("")).effects.shouldBeEmpty()
        reduce(waitingCard(), cancelTap("other")).effects.shouldBeEmpty()
        // The card is on the stream but the turn has not settled: the core would refuse the tap.
        reduce(proposed(), confirmTap()).effects.shouldBeEmpty()
        reduce(proposed(), cancelTap()).effects.shouldBeEmpty()
        reduce(ChatMachine.initial(), confirmTap()).effects.shouldBeEmpty()
    }

    "a turn that fails after parking a write offers no card to tap" {
        val chat = reduce(proposed(), settledRefused(1, AssistRefusalReason.ASSIST_REFUSAL_REASON_MODEL_FAILED)).chat
        val held = chat.state.messages.last()
        held.pending!!.state shouldBe ChatPending.State.STATE_INERT
        reduce(chat, confirmTap()).effects.shouldBeEmpty()
    }

    "a new chat leaves no card behind" {
        reduce(waitingCard(), newChat).chat.state.messages.shouldBeEmpty()
    }
})
