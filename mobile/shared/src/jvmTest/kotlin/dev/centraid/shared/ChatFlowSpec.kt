package dev.centraid.shared

import centraid.core.v1.AssistActivity
import centraid.core.v1.AssistAnswer
import centraid.core.v1.AssistCard
import centraid.core.v1.AssistCards
import centraid.core.v1.AssistDocuments
import centraid.core.v1.AssistEvent
import centraid.core.v1.AssistModelState
import centraid.core.v1.AssistPending
import centraid.core.v1.AssistPendingStep
import centraid.core.v1.AssistRefusal
import centraid.core.v1.AssistRefusalReason
import centraid.core.v1.AssistSent
import centraid.core.v1.AssistSettleOutcome
import centraid.core.v1.AssistSettled
import centraid.core.v1.AssistStarted
import centraid.core.v1.AssistStatus
import centraid.core.v1.AssistToken
import centraid.core.v1.AssistVisionState
import centraid.core.v1.ChatThread
import centraid.screen.v1.ChatEvent
import centraid.screen.v1.ChatPending
import centraid.screen.v1.ChatState
import dev.centraid.shared.chat.ChatDoor
import dev.centraid.shared.chat.ChatFlow
import dev.centraid.shared.chat.Pending
import dev.centraid.shared.chat.ThreadRow
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.runTest

/** A core that answers from a script and records what it was asked. */
internal class ScriptedChatDoor : ChatDoor {
    val bus = MutableSharedFlow<AssistEvent>(extraBufferCapacity = 64)
    override val events: Flow<AssistEvent> get() = bus

    var statusAnswer: AssistModelState? = AssistModelState.ASSIST_MODEL_STATE_READY
    var loadAnswer: AssistModelState? = AssistModelState.ASSIST_MODEL_STATE_READY
    var session: Long? = 7L
    var suggestions: List<String> = listOf("What is due today?", "Who owes me money?", "Find photos of Ana", "extra")

    var visionAnswer: AssistVisionState = AssistVisionState.ASSIST_VISION_STATE_READY
    var visionLoadAnswer: AssistVisionState? = AssistVisionState.ASSIST_VISION_STATE_READY

    class Send(
        val session: Long,
        val turn: Long,
        val text: String,
        val regenerate: Boolean,
        val attachments: List<Pending> = emptyList(),
    ) {
        val reply = CompletableDeferred<AssistSent?>()
    }

    val sends = mutableListOf<Send>()
    val cancels = mutableListOf<Long>()
    val clears = mutableListOf<Long>()
    val calls = mutableListOf<String>()

    // The member's taps on a parked write's card, and what the core answers to them.
    val confirms = mutableListOf<Pair<Long, String>>()
    val dismisses = mutableListOf<Pair<Long, String>>()
    var confirmAnswer: (String) -> AssistSettled? = { id ->
        AssistSettled(
            session_id = 7,
            pending_id = id,
            outcome = AssistSettleOutcome.ASSIST_SETTLE_OUTCOME_APPLIED,
            line = "Done.",
        )
    }

    override suspend fun status(): AssistModelState? = statusAnswer.also { calls += "status" }

    override suspend fun load(): AssistModelState? = loadAnswer.also { calls += "load" }

    override suspend fun start(app: String): Long? = session.also { calls += "start:$app" }

    override suspend fun visionStatus(): AssistStatus? =
        AssistStatus(vision = visionAnswer, projector_bytes = 204_987_232L).also { calls += "vision-status" }

    override suspend fun loadVision(): AssistVisionState? = visionLoadAnswer.also { calls += "load-vision" }

    override suspend fun send(
        session: Long,
        turn: Long,
        text: String,
        regenerate: Boolean,
        attachments: List<Pending>,
    ): AssistSent? {
        val call = Send(session, turn, text, regenerate, attachments)
        sends += call
        calls += "send:$turn"
        return call.reply.await()
    }

    override suspend fun cancel(session: Long) {
        cancels += session
        calls += "cancel"
    }

    override suspend fun clear(session: Long) {
        clears += session
        calls += "clear"
    }

    override suspend fun confirm(session: Long, pendingId: String): AssistSettled? {
        confirms += session to pendingId
        calls += "confirm:$pendingId"
        return confirmAnswer(pendingId)
    }

    override suspend fun dismiss(session: Long, pendingId: String): AssistSettled? {
        dismisses += session to pendingId
        calls += "dismiss:$pendingId"
        return AssistSettled(
            session_id = session,
            pending_id = pendingId,
            outcome = AssistSettleOutcome.ASSIST_SETTLE_OUTCOME_DISMISSED,
            line = "Not done.",
        )
    }

    override suspend fun suggest(app: String): List<String> = suggestions.also { calls += "suggest:$app" }

    override suspend fun documents(): AssistDocuments? = AssistDocuments().also { calls += "documents" }

    // The history's reads and writes. Recorded apart from `calls`, which the
    // older specs pin to the plane's own requests.
    var clock: Long = 1_000_000_000L
    var storedRows: MutableList<ThreadRow> = mutableListOf()
    val storedThreads = mutableMapOf<String, ChatThread>()
    var threadSession: Long? = 9L
    val history = mutableListOf<String>()
    var failingThreadRead = false

    override fun nowMillis(): Long = clock

    override suspend fun threads(): List<ThreadRow>? {
        history += "threads"
        return if (failingThreadRead) null else storedRows.toList()
    }

    override suspend fun thread(threadId: String): ChatThread? {
        history += "thread:$threadId"
        return storedThreads[threadId] ?: ChatThread(found = false)
    }

    override suspend fun startThread(threadId: String): AssistStarted? {
        history += "start-thread:$threadId"
        val held = storedThreads[threadId]?.thread
        return threadSession?.let { AssistStarted(session_id = it, thread_id = threadId, scope_app = held?.scope_app.orEmpty()) }
    }

    override suspend fun renameThread(threadId: String, title: String): Boolean {
        history += "rename:$threadId:$title"
        storedRows = storedRows.map { if (it.id == threadId) it.copy(title = title) else it }.toMutableList()
        return true
    }

    override suspend fun deleteThread(threadId: String): Boolean {
        history += "delete:$threadId"
        storedRows = storedRows.filterNot { it.id == threadId }.toMutableList()
        storedThreads.remove(threadId)
        return true
    }

    override suspend fun deleteAllThreads(): Boolean {
        history += "delete-all"
        storedRows.clear()
        storedThreads.clear()
        return true
    }

    override suspend fun cardLive(app: String, entity: String, id: String): Boolean = true
}

internal class Rig(val door: ScriptedChatDoor = ScriptedChatDoor()) {
    var downloads = 0
    var visionDownloads = 0
    val clipboard = mutableListOf<String>()
    val flow = ChatFlow(
        door = door,
        startDownload = { downloads += 1 },
        copyToClipboard = { clipboard += it },
        scope = CoroutineScope(Dispatchers.Unconfined),
        startVisionDownload = { visionDownloads += 1 },
    ).also { it.attach() }

    val state: ChatState get() = flow.state.value

    fun open(app: String = "", bytes: Long = 0) =
        flow.send(ChatEvent(opened = ChatEvent.Opened(app = app, model_bytes = bytes)))

    fun say(text: String) = flow.send(ChatEvent(sent = ChatEvent.Sent(text = text)))
}

/**
 * THE CHAT RUNNING over a fake core: the effects the machine asks for are run,
 * their answers are fed back, and a running `send` does not hold up the stop
 * that has to reach the core while it runs.
 */
class ChatFlowSpec : StringSpec({

    fun card(id: String, title: String) = AssistCard(app = "tasks", entity = "task", id = id, title = title)

    "opening a ready model starts a session and shows three suggestions" {
        val rig = Rig()
        rig.open("tasks")
        rig.door.calls shouldBe listOf("status", "start:tasks", "suggest:tasks")
        rig.state.phase shouldBe ChatState.Phase.PHASE_READY
        rig.state.suggestions shouldBe listOf("What is due today?", "Who owes me money?", "Find photos of Ana")
        rig.state.scope_app shouldBe "tasks"
    }

    "a model that is not there draws the download step, and the whole download runs to a ready chat" {
        runTest {
            val rig = Rig()
            rig.door.statusAnswer = AssistModelState.ASSIST_MODEL_STATE_ABSENT
            rig.open(bytes = 530_000_000)
            rig.state.phase shouldBe ChatState.Phase.PHASE_NEEDS_MODEL
            rig.state.model_step!!.size_line shouldBe "530 MB download"

            rig.flow.send(ChatEvent(download = ChatEvent.DownloadTapped()))
            rig.downloads shouldBe 1
            rig.state.phase shouldBe ChatState.Phase.PHASE_DOWNLOADING

            rig.flow.send(ChatEvent(download_progress = ChatEvent.DownloadProgress(done_bytes = 265_000_000, total_bytes = 530_000_000)))
            rig.state.model_step!!.status_line shouldBe "Downloading 50%"

            rig.flow.send(ChatEvent(download_finished = ChatEvent.DownloadFinished(ok = true)))
            rig.door.calls.takeLast(3) shouldBe listOf("load", "start:", "suggest:")
            rig.state.phase shouldBe ChatState.Phase.PHASE_READY
        }
    }

    "a model on the phone is loaded before anything else" {
        val rig = Rig()
        rig.door.statusAnswer = AssistModelState.ASSIST_MODEL_STATE_PRESENT
        rig.open()
        rig.door.calls shouldBe listOf("status", "load", "start:", "suggest:")
        rig.state.phase shouldBe ChatState.Phase.PHASE_READY
    }

    "a question streams into the thread as the core streams it, and settles once" {
        val rig = Rig()
        rig.open()
        rig.say("What is due today?")
        val send = rig.door.sends.single()
        (send.session to send.turn) shouldBe (7L to 1L)
        send.text shouldBe "What is due today?"
        rig.state.streaming shouldBe true
        rig.state.messages shouldHaveSize 2

        rig.door.bus.tryEmit(AssistEvent(session_id = 7, turn_id = 1, activity = AssistActivity(app = "tasks", tool = "tasks.list")))
        rig.state.activity shouldBe "Looking in Tasks"
        rig.door.bus.tryEmit(AssistEvent(session_id = 7, turn_id = 1, cards = AssistCards(cards = listOf(card("t1", "Pick up the dry cleaning")))))
        rig.state.messages.last().cards shouldHaveSize 1
        rig.door.bus.tryEmit(AssistEvent(session_id = 7, turn_id = 1, token = AssistToken(text = "One thing")))
        rig.state.messages.last().text shouldBe "One thing"

        val answer = AssistAnswer(text = "One thing is due today.", cards = listOf(card("t1", "Pick up the dry cleaning")))
        // The call comes back, and so does the terminal event, in either order.
        send.reply.complete(AssistSent(session_id = 7, turn_id = 1, answered = answer))
        rig.door.bus.tryEmit(AssistEvent(session_id = 7, turn_id = 1, answer = answer))
        rig.state.streaming shouldBe false
        rig.state.messages.last().text shouldBe "One thing is due today."
        rig.state.messages shouldHaveSize 2
        rig.state.can_retry shouldBe true
    }

    "stop reaches the core while the send is still running, and the send's refusal ends the turn" {
        val rig = Rig()
        rig.open()
        rig.say("What is due today?")
        rig.door.bus.tryEmit(AssistEvent(session_id = 7, turn_id = 1, token = AssistToken(text = "One")))

        rig.flow.send(ChatEvent(stopped = ChatEvent.Stopped()))
        rig.door.cancels shouldBe listOf(7L)
        rig.state.streaming shouldBe true

        rig.door.sends.single().reply.complete(
            AssistSent(
                session_id = 7,
                turn_id = 1,
                refused = AssistRefusal(reason = AssistRefusalReason.ASSIST_REFUSAL_REASON_CANCELLED),
            ),
        )
        rig.state.streaming shouldBe false
        rig.state.messages.last().text shouldBe "One"
        rig.state.messages.last().stopped shouldBe true
        rig.state.error shouldBe ""
    }

    "retry sends the same question as a regenerate under the next turn" {
        val rig = Rig()
        rig.open()
        rig.say("What is due today?")
        rig.door.sends[0].reply.complete(
            AssistSent(session_id = 7, turn_id = 1, answered = AssistAnswer(text = "First.")),
        )
        rig.flow.send(ChatEvent(regenerated = ChatEvent.Regenerated()))
        val again = rig.door.sends[1]
        (again.turn to again.regenerate) shouldBe (2L to true)
        again.text shouldBe "What is due today?"
        again.reply.complete(AssistSent(session_id = 7, turn_id = 2, answered = AssistAnswer(text = "Second.")))
        rig.state.messages.map { it.text } shouldBe listOf("What is due today?", "Second.")
    }

    "a new chat clears the core's transcript, then asks for fresh suggestions" {
        val rig = Rig()
        rig.open()
        rig.say("hi")
        rig.door.sends.single().reply.complete(
            AssistSent(session_id = 7, turn_id = 1, answered = AssistAnswer(text = "Hello.")),
        )
        rig.door.suggestions = listOf("Fresh one")
        rig.flow.send(ChatEvent(new_chat = ChatEvent.NewChat()))
        rig.door.clears shouldBe listOf(7L)
        rig.door.calls.takeLast(2) shouldBe listOf("clear", "suggest:")
        rig.state.messages.shouldBeEmpty()
        rig.state.suggestions shouldBe listOf("Fresh one")
    }

    "copy goes to the clipboard the shell gave" {
        val rig = Rig()
        rig.open()
        rig.say("hi")
        rig.door.sends.single().reply.complete(
            AssistSent(session_id = 7, turn_id = 1, answered = AssistAnswer(text = "Hello.")),
        )
        rig.flow.send(ChatEvent(copied = ChatEvent.Copied(message_id = 2)))
        rig.clipboard shouldBe listOf("Hello.")
    }

    "a core that will not answer is unavailable, and a session it refuses is too" {
        val silent = Rig()
        silent.door.statusAnswer = null
        silent.open()
        silent.state.phase shouldBe ChatState.Phase.PHASE_UNAVAILABLE

        val refusing = Rig()
        refusing.door.session = null
        refusing.open()
        refusing.state.phase shouldBe ChatState.Phase.PHASE_UNAVAILABLE
    }

    "closing a flow stops it listening, and stops a turn the core is still running" {
        val rig = Rig()
        rig.open()
        rig.say("What is due today?")
        rig.door.bus.tryEmit(AssistEvent(session_id = 7, turn_id = 1, token = AssistToken(text = "One")))
        rig.state.messages.last().text shouldBe "One"

        rig.flow.close()
        // The core was told to stop the turn it is running...
        rig.door.cancels shouldBe listOf(7L)
        // ...and nothing it streams afterwards reaches the old flow.
        rig.door.bus.tryEmit(AssistEvent(session_id = 7, turn_id = 1, token = AssistToken(text = " more")))
        rig.state.messages.last().text shouldBe "One"
        // Nor does an intent sent to it.
        rig.say("again")
        rig.door.sends shouldHaveSize 1
    }

    "closing an idle flow cancels nothing" {
        val rig = Rig()
        rig.open()
        rig.flow.close()
        rig.door.cancels.shouldBeEmpty()
        rig.door.bus.tryEmit(AssistEvent(session_id = 7, turn_id = 0, token = AssistToken(text = "x")))
        rig.state.phase shouldBe ChatState.Phase.PHASE_READY
    }

    "a send whose call fails draws the generic line and leaves the chat usable" {
        val rig = Rig()
        rig.open()
        rig.say("hi")
        rig.door.sends.single().reply.complete(null)
        rig.state.error shouldBe "Chat could not answer. Retry."
        rig.say("again")
        rig.door.sends shouldHaveSize 2
    }

    // --- attachments through the running flow ---------------------------------

    fun attachPhoto(rig: Rig, asset: String = "asset-1", label: String = "Truckee river bend") =
        rig.flow.send(
            ChatEvent(
                attached = ChatEvent.Attached(
                    vault_photo = ChatEvent.VaultPhoto(asset_id = asset),
                    label = label,
                    thumbnail_path = "/tmp/thumb.jpg",
                ),
            ),
        )

    "a photo with no reader on the phone offers the download, runs it, loads it, and then sends" {
        runTest {
            val rig = Rig()
            rig.door.visionAnswer = AssistVisionState.ASSIST_VISION_STATE_ABSENT
            rig.open()
            attachPhoto(rig)
            rig.door.calls.last() shouldBe "vision-status"
            rig.state.vision_blocked shouldBe true
            rig.state.vision_step!!.action_label shouldBe "Download"
            rig.state.vision_step!!.size_line shouldBe "Reading photos needs a 205 MB download"
            // Blocked: a send changes nothing until the reader is on the model.
            rig.say("What is in this photo?")
            rig.door.sends.shouldBeEmpty()

            rig.flow.send(ChatEvent(download = ChatEvent.DownloadTapped(vision = true)))
            rig.visionDownloads shouldBe 1
            rig.downloads shouldBe 0
            rig.flow.send(
                ChatEvent(download_progress = ChatEvent.DownloadProgress(done_bytes = 50, total_bytes = 100, vision = true)),
            )
            rig.state.vision_step!!.status_line shouldBe "Downloading 50%"

            rig.flow.send(ChatEvent(download_finished = ChatEvent.DownloadFinished(ok = true, vision = true)))
            rig.door.calls.takeLast(1) shouldBe listOf("load-vision")
            rig.state.vision_step shouldBe null
            rig.state.vision_blocked shouldBe false

            rig.say("What is in this photo?")
            val send = rig.door.sends.single()
            send.attachments.map { it.label } shouldBe listOf("Truckee river bend")
            rig.state.messages.first().attachments.map { it.label } shouldBe listOf("Truckee river bend")
            rig.state.pending.shouldBeEmpty()
        }
    }

    "a reader that is on the phone and not on the model is loaded without a download" {
        val rig = Rig()
        rig.door.visionAnswer = AssistVisionState.ASSIST_VISION_STATE_PRESENT
        rig.open()
        attachPhoto(rig)
        rig.door.calls.takeLast(2) shouldBe listOf("vision-status", "load-vision")
        rig.visionDownloads shouldBe 0
        rig.state.vision_blocked shouldBe false
    }

    "a document needs no reader and is carried by the send" {
        val rig = Rig()
        rig.open()
        rig.flow.send(
            ChatEvent(
                attached = ChatEvent.Attached(
                    vault_document = ChatEvent.VaultDocument(doc_id = "doc-1"),
                    label = "Tahoe packing list",
                ),
            ),
        )
        rig.door.calls shouldBe listOf("status", "start:", "suggest:")
        rig.state.pending.map { it.label } shouldBe listOf("Tahoe packing list")
        rig.say("What should I not forget?")
        rig.door.sends.single().attachments.map { it.label } shouldBe listOf("Tahoe packing list")
    }

    "retry asks the last turn's attachments again" {
        val rig = Rig()
        rig.open()
        attachPhoto(rig)
        rig.say("What is in this photo?")
        rig.door.sends.single().reply.complete(
            AssistSent(session_id = 7, turn_id = 1, answered = AssistAnswer(text = "A river.")),
        )
        rig.flow.send(ChatEvent(regenerated = ChatEvent.Regenerated()))
        val again = rig.door.sends.last()
        again.regenerate shouldBe true
        again.attachments.map { it.label } shouldBe listOf("Truckee river bend")
    }

    // --- a parked write's card, through the flow (#1088) ------------------------

    val cardFor = AssistPending(
        pending_id = "p1",
        verbs = listOf("complete"),
        steps = listOf(
            AssistPendingStep(
                verb = "complete",
                kind = "task",
                title = "Pick up the dry cleaning",
                summary = "Complete task \"Pick up the dry cleaning\"",
            ),
        ),
    )

    /** A turn that parked a write and settled: the card waits for a tap. */
    fun Rig.proposeAWrite() {
        open()
        say("Complete the dry cleaning task")
        val send = door.sends.single()
        door.bus.tryEmit(AssistEvent(session_id = 7, turn_id = 1, pending = cardFor))
        val answer = AssistAnswer(text = "Proposed: Complete task \"Pick up the dry cleaning\".", pending = cardFor)
        send.reply.complete(AssistSent(session_id = 7, turn_id = 1, answered = answer))
        door.bus.tryEmit(AssistEvent(session_id = 7, turn_id = 1, answer = answer))
    }

    "Confirm asks the core once for the card's id and draws the core's line, with no write from the shell" {
        val rig = Rig()
        rig.proposeAWrite()
        rig.state.messages.last().pending!!.state shouldBe ChatPending.State.STATE_WAITING
        rig.door.confirms.shouldBeEmpty()

        rig.flow.send(ChatEvent(pending_confirmed = ChatEvent.PendingConfirmed(pending_id = "p1")))
        rig.door.confirms shouldBe listOf(7L to "p1")
        val card = rig.state.messages.last().pending!!
        card.state shouldBe ChatPending.State.STATE_APPLIED
        card.settled_line shouldBe "Done."

        // a second tap reaches nothing
        rig.flow.send(ChatEvent(pending_confirmed = ChatEvent.PendingConfirmed(pending_id = "p1")))
        rig.door.confirms shouldHaveSize 1
        rig.door.dismisses.shouldBeEmpty()
    }

    "Cancel tells the core to drop the card and writes nothing" {
        val rig = Rig()
        rig.proposeAWrite()
        rig.flow.send(ChatEvent(pending_cancelled = ChatEvent.PendingCancelled(pending_id = "p1")))
        rig.door.dismisses shouldBe listOf(7L to "p1")
        rig.door.confirms.shouldBeEmpty()
        val card = rig.state.messages.last().pending!!
        card.state shouldBe ChatPending.State.STATE_NOT_DONE
        card.settled_line shouldBe "Not done."
    }

    "a stale card says so, and a core that did not answer leaves the card to tap again" {
        val rig = Rig()
        rig.proposeAWrite()
        rig.door.confirmAnswer = { id ->
            AssistSettled(
                session_id = 7,
                pending_id = id,
                outcome = AssistSettleOutcome.ASSIST_SETTLE_OUTCOME_STALE,
                line = "That changed since. Ask again.",
            )
        }
        rig.flow.send(ChatEvent(pending_confirmed = ChatEvent.PendingConfirmed(pending_id = "p1")))
        rig.state.messages.last().pending!!.state shouldBe ChatPending.State.STATE_STALE
        rig.state.messages.last().pending!!.settled_line shouldBe "That changed since. Ask again."

        val silent = Rig()
        silent.proposeAWrite()
        silent.door.confirmAnswer = { null }
        silent.flow.send(ChatEvent(pending_confirmed = ChatEvent.PendingConfirmed(pending_id = "p1")))
        silent.state.messages.last().pending!!.state shouldBe ChatPending.State.STATE_WAITING
        silent.state.error shouldBe "Chat could not answer. Retry."
    }

    "a new question while the card waits makes it inert, and the core is never asked to run it" {
        val rig = Rig()
        rig.proposeAWrite()
        rig.say("What is due today?")
        rig.state.messages.first { it.pending != null }.pending!!.state shouldBe ChatPending.State.STATE_INERT
        rig.flow.send(ChatEvent(pending_confirmed = ChatEvent.PendingConfirmed(pending_id = "p1")))
        rig.door.confirms.shouldBeEmpty()
    }
})
