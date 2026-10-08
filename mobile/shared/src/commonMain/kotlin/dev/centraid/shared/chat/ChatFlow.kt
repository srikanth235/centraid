package dev.centraid.shared.chat

import centraid.core.v1.AssistAttachment
import centraid.core.v1.AssistCancelRequest
import centraid.core.v1.AssistClearRequest
import centraid.core.v1.AssistConfirmRequest
import centraid.core.v1.AssistDismissRequest
import centraid.core.v1.AssistDocuments
import centraid.core.v1.AssistDocumentsRequest
import centraid.core.v1.AssistEvent
import centraid.core.v1.AssistImageBytes
import centraid.core.v1.AssistLoadRequest
import centraid.core.v1.AssistModelState
import centraid.core.v1.AssistRequest
import centraid.core.v1.AssistResponse
import centraid.core.v1.AssistSendRequest
import centraid.core.v1.AssistSent
import centraid.core.v1.AssistSettled
import centraid.core.v1.AssistStartRequest
import centraid.core.v1.AssistStatus
import centraid.core.v1.AssistStatusRequest
import centraid.core.v1.AssistSuggestRequest
import centraid.core.v1.AssistVaultDoc
import centraid.core.v1.AssistVaultPhoto
import centraid.core.v1.AssistStarted
import centraid.core.v1.AssistVisionState
import centraid.core.v1.AppQueryRequest
import centraid.core.v1.ChatCardRequest
import centraid.core.v1.ChatThread
import centraid.core.v1.ChatThreadRequest
import centraid.core.v1.ChatThreadsRequest
import centraid.core.v1.Command
import centraid.core.v1.CommandStatus
import centraid.core.v1.Envelope
import centraid.core.v1.Request
import centraid.screen.v1.ChatEvent
import centraid.screen.v1.ChatState
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import dev.centraid.shared.kit.InvokeKeys
import dev.centraid.shared.kit.jsonString
import okio.ByteString.Companion.encodeUtf8
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * THE CORE'S ASSISTANT PLANE, AS THE CHAT'S DOOR (`assist.proto`).
 *
 * One method per request kind, and none throws: "the core would not answer" is
 * a `null` the machine turns into a state, not an exception a flow has to guess
 * the meaning of — the same posture as `CoreDrainDoor`.
 *
 * **[send] BLOCKS FOR THE WHOLE TURN**, like every call on this ABI, and its
 * answer is the same fact as the turn's terminal event. [cancel] is its own
 * call, made while a send is in flight; that is why the core's dispatcher must
 * hold at least three threads (the event reader, a running send, a cancel).
 */
public interface ChatDoor {
    /** The core's assist events, for as long as the core is open. */
    public val events: Flow<AssistEvent>

    /** Where the model file stands; null when the core would not answer. */
    public suspend fun status(): AssistModelState?

    /** Load the model into memory; its state afterwards, null when refused. */
    public suspend fun load(): AssistModelState?

    /** Open a chat on [app] (empty is every app); its session id, null when refused. */
    public suspend fun start(app: String): Long?

    /** Where the vision projector stands; null when the core would not answer. */
    public suspend fun visionStatus(): AssistStatus?

    /** Give the loaded model the projector; its state afterwards, null when refused. */
    public suspend fun loadVision(): AssistVisionState?

    /**
     * Ask. Null when the call itself failed; a refusal is the answer's.
     * [attachments] ride on the question (a regenerate carries the last turn's
     * again).
     */
    public suspend fun send(
        session: Long,
        turn: Long,
        text: String,
        regenerate: Boolean,
        attachments: List<Pending> = emptyList(),
    ): AssistSent?

    public suspend fun cancel(session: Long)

    public suspend fun clear(session: Long)

    /**
     * The member tapped Confirm on the parked write [pendingId] names: the core runs its steps
     * once and answers how it ended and the line to say. Null when the call itself failed
     * (nothing ran).
     */
    public suspend fun confirm(session: Long, pendingId: String): AssistSettled?

    /** The member tapped Cancel: the core drops the parked write and writes nothing. Null when the call failed. */
    public suspend fun dismiss(session: Long, pendingId: String): AssistSettled?

    /** Three questions this vault can answer; empty when it would not say. */
    public suspend fun suggest(app: String): List<String>

    /** The vault's text documents the chat can read, newest edit first; null when it would not say. */
    public suspend fun documents(): AssistDocuments?

    /** The device's wall clock, epoch milliseconds, for "5 min ago". Zero when it has none. */
    public fun nowMillis(): Long = 0L

    /** The drawer's list, newest first; null when the core would not say. */
    public suspend fun threads(): List<ThreadRow>?

    /** One stored thread and its messages; null when the core would not say. */
    public suspend fun thread(threadId: String): ChatThread?

    /**
     * Reopen a stored thread: a session the core rebuilt from its last turns, so
     * the next question is routed as it would have been. Null when the core
     * refused (the thread is gone).
     */
    public suspend fun startThread(threadId: String): AssistStarted?

    /** Rename a stored thread; whether the vault did it. */
    public suspend fun renameThread(threadId: String, title: String): Boolean

    /** Delete a stored thread, with its messages; whether the vault did it. */
    public suspend fun deleteThread(threadId: String): Boolean

    /** Delete every stored thread in this vault; whether the vault did it. */
    public suspend fun deleteAllThreads(): Boolean

    /** Whether the row a card names is still in the vault. True when the core would not say. */
    public suspend fun cardLive(app: String, entity: String, id: String): Boolean
}

/**
 * [ChatDoor] over the foreground vault's core, asked of a SUPPLIER and not held:
 * the shelf moves the foreground on a vault switch, and a door bound to one
 * handle would go on asking a vault the member has left.
 *
 * [modelPath] is where the shell put the downloaded model, [projectorPath]
 * where it puts the vision projector (fetched only on a first photo), and
 * [timeZone] the device's IANA zone, read at every send because a phone changes
 * zone.
 */
public class CoreChatDoor(
    private val core: () -> CentraidCore?,
    private val modelPath: () -> String,
    private val timeZone: () -> String,
    private val projectorPath: () -> String = { "" },
    private val now: () -> Long = { 0L },
) : ChatDoor {
    override val events: Flow<AssistEvent> = flow {
        val open = core() ?: return@flow
        open.events.collect { event -> event.assist?.let { emit(it) } }
    }

    /**
     * The core this chat's session was started on. A session id means
     * something to ONE core, and the supplier moves with the foreground, so a
     * [cancel] sent after a vault switch (the shell stops the old chat as it
     * replaces it) must still reach the core that is running the turn.
     */
    private var sessionCore: CentraidCore? = null

    private suspend fun ask(request: AssistRequest, on: CentraidCore? = null): AssistResponse? {
        val open = on ?: core() ?: return null
        val answer = open.call(Envelope(request_id = 0, request = Request(assist = request)))
        return when (answer) {
            is CoreOutcome.Answered -> answer.value.response?.assist
            is CoreOutcome.Failed -> null
        }
    }

    override suspend fun status(): AssistModelState? =
        ask(AssistRequest(status = AssistStatusRequest(model_path = modelPath())))?.status?.state

    override suspend fun load(): AssistModelState? =
        ask(AssistRequest(load = AssistLoadRequest(model_path = modelPath())))?.status?.state

    override suspend fun start(app: String): Long? {
        val open = core()
        sessionCore = open
        return ask(AssistRequest(start = AssistStartRequest(app = app)), open)?.started?.session_id
    }

    override suspend fun visionStatus(): AssistStatus? =
        ask(AssistRequest(status = AssistStatusRequest(model_path = modelPath(), projector_path = projectorPath())))
            ?.status

    override suspend fun loadVision(): AssistVisionState? =
        ask(AssistRequest(load = AssistLoadRequest(model_path = modelPath(), projector_path = projectorPath())))
            ?.status?.vision

    override suspend fun send(
        session: Long,
        turn: Long,
        text: String,
        regenerate: Boolean,
        attachments: List<Pending>,
    ): AssistSent? =
        ask(
            AssistRequest(
                send = AssistSendRequest(
                    session_id = session,
                    text = text,
                    tz = timeZone(),
                    regenerate = regenerate,
                    turn_id = turn,
                    attachments = attachments.filterNot { it.source is AttachSource.Unavailable }.map(::wired),
                ),
            ),
        )?.sent

    override suspend fun cancel(session: Long) {
        ask(AssistRequest(cancel = AssistCancelRequest(session_id = session)), sessionCore)
    }

    override suspend fun clear(session: Long) {
        ask(AssistRequest(clear = AssistClearRequest(session_id = session)))
    }

    // A tap is for the core that holds the card: the supplier moves with the foreground.
    override suspend fun confirm(session: Long, pendingId: String): AssistSettled? =
        ask(
            AssistRequest(confirm = AssistConfirmRequest(session_id = session, pending_id = pendingId)),
            sessionCore,
        )?.settled

    override suspend fun dismiss(session: Long, pendingId: String): AssistSettled? =
        ask(
            AssistRequest(dismiss = AssistDismissRequest(session_id = session, pending_id = pendingId)),
            sessionCore,
        )?.settled

    override suspend fun documents(): AssistDocuments? =
        ask(AssistRequest(documents = AssistDocumentsRequest(limit = 50)))?.documents

    override suspend fun suggest(app: String): List<String> =
        ask(AssistRequest(suggest = AssistSuggestRequest(app = app, tz = timeZone())))
            ?.suggestions?.prompts.orEmpty()

    override fun nowMillis(): Long = now()

    private suspend fun query(request: AppQueryRequest): centraid.core.v1.AppQueryResponse? {
        val open = core() ?: return null
        return when (val answer = open.call(Envelope(request_id = 0, request = Request(app_query = request)))) {
            is CoreOutcome.Answered -> answer.value.response?.app_query
            is CoreOutcome.Failed -> null
        }
    }

    override suspend fun threads(): List<ThreadRow>? =
        query(AppQueryRequest(chat_threads = ChatThreadsRequest()))?.chat_threads?.threads?.map { row ->
            ThreadRow(id = row.thread_id, title = row.title, updatedMs = row.updated_ms)
        }

    override suspend fun thread(threadId: String): ChatThread? =
        query(AppQueryRequest(chat_thread = ChatThreadRequest(thread_id = threadId)))?.chat_thread

    override suspend fun startThread(threadId: String): AssistStarted? {
        val open = core()
        sessionCore = open
        return ask(AssistRequest(start = AssistStartRequest(thread_id = threadId)), open)?.started
    }

    /**
     * A WRITE, through the command plane. The chat's writes are registered
     * commands (`chat.*`); this is the door a shell sends one through, and the
     * only answer it keeps is whether the vault did it. The key names the intent
     * and its subject, so a double tap is one write.
     */
    private suspend fun write(name: String, input: String, subject: String, vararg intent: String): Boolean {
        val open = core() ?: return false
        val request = Envelope(
            request_id = 0,
            request = Request(
                command = Command(
                    name = name,
                    invoke_key = InvokeKeys.of(name, subject, *intent),
                    input = input.encodeUtf8(),
                ),
            ),
        )
        return when (val answer = open.call(request)) {
            is CoreOutcome.Answered ->
                answer.value.response?.command?.status == CommandStatus.COMMAND_STATUS_EXECUTED
            is CoreOutcome.Failed -> false
        }
    }

    override suspend fun renameThread(threadId: String, title: String): Boolean =
        write("chat.rename_thread", """{"thread_id":${jsonString(threadId)},"title":${jsonString(title)}}""", threadId, title)

    override suspend fun deleteThread(threadId: String): Boolean =
        write("chat.delete_thread", """{"thread_id":${jsonString(threadId)}}""", threadId)

    override suspend fun deleteAllThreads(): Boolean = write("chat.clear", "{}", "all")

    override suspend fun cardLive(app: String, entity: String, id: String): Boolean =
        query(AppQueryRequest(chat_card = ChatCardRequest(app = app, entity = entity, id = id)))
            ?.chat_card?.exists ?: true
}

/** An attachment as the core is handed it: a name, or the bytes a shell picked. */
internal fun wired(pending: Pending): AssistAttachment = when (val source = pending.source) {
    is AttachSource.VaultPhoto -> AssistAttachment(vault_photo = AssistVaultPhoto(asset_id = source.assetId))
    is AttachSource.VaultDocument -> AssistAttachment(vault_doc = AssistVaultDoc(doc_id = source.docId))
    is AttachSource.LibraryPhoto ->
        AssistAttachment(image_bytes = AssistImageBytes(content = source.bytes, mime = source.mime))
    // Never handed to the core: `ChatMachine` refuses a Retry that would lose one.
    AttachSource.Unavailable -> AssistAttachment()
}.copy(label = pending.label)

/**
 * THE MACHINE, RUNNING over a [ChatDoor].
 *
 * `send` takes the shell's intent; `attach` starts listening to the core's
 * stream. Every input is reduced under one lock and its effects run after the
 * lock is released, so a running `send` — which can last seconds — never holds
 * up the `Stopped` that has to reach the core while it runs.
 *
 * [startDownload] is the shell's: it owns the transfer (the only thing Centraid
 * ever fetches) and reports back with the progress and finished events.
 * [startVisionDownload] is the same for the vision projector, which the shell
 * fetches only when a member first attaches a photo.
 * [copyToClipboard] is the shell's platform act.
 */
public class ChatFlow(
    private val door: ChatDoor,
    private val startDownload: () -> Unit,
    private val copyToClipboard: (String) -> Unit,
    private val scope: CoroutineScope,
    private val startVisionDownload: () -> Unit = {},
) {
    private val model = MutableStateFlow(ChatMachine.initial())
    private val lock = Mutex()
    private val published = MutableStateFlow(model.value.state)

    /** The finished state the view draws. */
    public val state: StateFlow<ChatState> get() = published.asStateFlow()

    /** The model, for specs. */
    public val current: Chat get() = model.value

    /** Listen to the core's stream. Once per flow. */
    public fun attach() {
        scope.launch { door.events.collect { reduce(ChatInput.Core(it)) } }
    }

    /** The documents the attach picker lists; null when the core would not say. */
    public suspend fun documents(): AssistDocuments? = door.documents()

    /** Whether the row a tapped card names is still in the vault. */
    public suspend fun cardLive(app: String, entity: String, id: String): Boolean = door.cardLive(app, entity, id)

    /** The shell's intent. Not `suspend`: a SwiftUI button cannot await. */
    public fun send(event: ChatEvent) {
        scope.launch { reduce(ChatInput.View(event)) }
    }

    /**
     * STOP LISTENING, AND STOP FOR GOOD. Cancels the scope [attach]'s collector
     * and every in-flight effect run on, so a flow the shell has replaced (a
     * vault switch makes a new one) no longer reduces the old core's events.
     * The flow owns the scope it is given; nothing else may share it. A turn
     * the core is still running is told to stop first (see below), so closing
     * a bridge mid-answer does not leave the core generating to nobody.
     */
    public fun close() {
        val turn = model.value
        val running = if (turn.running && turn.session != 0L) turn.session else null
        scope.cancel()
        // THE TURN THE CORE IS STILL RUNNING is stopped from a context of its
        // own (the same dispatcher, no parent job): the scope above is
        // cancelled, and a cancel launched on it would never be sent.
        if (running != null) {
            CoroutineScope(scope.coroutineContext.minusKey(Job)).launch { door.cancel(running) }
        }
    }

    public suspend fun reduce(input: ChatInput) {
        val effects = lock.withLock {
            val step = ChatMachine.reduce(model.value, input)
            model.value = step.chat
            published.value = step.chat.state
            step.effects
        }
        effects.forEach { run(it) }
    }

    private suspend fun run(effect: ChatEffect) {
        when (effect) {
            ChatEffect.ReadStatus -> reduce(ChatInput.Status(door.status()))
            ChatEffect.Load -> reduce(ChatInput.Loaded(door.load()))
            ChatEffect.StartDownload -> startDownload()
            is ChatEffect.Start -> reduce(ChatInput.Started(door.start(effect.app)))
            is ChatEffect.Suggest -> reduce(ChatInput.Suggested(effect.session, door.suggest(effect.app)))
            is ChatEffect.Send -> reduce(
                ChatInput.Settled(
                    effect.turn,
                    door.send(effect.session, effect.turn, effect.text, effect.regenerate, effect.attachments),
                ),
            )
            ChatEffect.ReadVision -> {
                val status = door.visionStatus()
                reduce(ChatInput.VisionStatus(status?.vision, status?.projector_bytes ?: 0L))
            }
            ChatEffect.LoadVision -> reduce(ChatInput.VisionLoaded(door.loadVision()))
            ChatEffect.StartVisionDownload -> startVisionDownload()
            is ChatEffect.Cancel -> door.cancel(effect.session)
            is ChatEffect.Confirm ->
                reduce(ChatInput.Confirmed(effect.pendingId, door.confirm(effect.session, effect.pendingId)))
            // The card settled when Cancel was tapped; the core's answer changes nothing on screen.
            is ChatEffect.Dismiss -> {
                door.dismiss(effect.session, effect.pendingId)
            }
            is ChatEffect.Clear -> door.clear(effect.session)
            is ChatEffect.Copy -> copyToClipboard(effect.text)
            ChatEffect.ReadThreads -> reduce(ChatInput.Threads(door.threads(), door.nowMillis()))
            is ChatEffect.OpenThread -> {
                val thread = door.thread(effect.threadId)
                // The session is asked for only for a thread that is there: the
                // core refuses one that is not, and a session with nothing
                // behind it would be left running.
                val started = if (thread?.found == true) door.startThread(effect.threadId) else null
                reduce(ChatInput.ThreadOpened(effect.threadId, thread, started))
            }
            is ChatEffect.RenameThread -> {
                door.renameThread(effect.threadId, effect.title)
                reduce(ChatInput.Threads(door.threads(), door.nowMillis()))
            }
            is ChatEffect.DeleteThread -> {
                door.deleteThread(effect.threadId)
                reduce(ChatInput.Threads(door.threads(), door.nowMillis()))
            }
            ChatEffect.DeleteAllThreads -> {
                door.deleteAllThreads()
                reduce(ChatInput.Threads(door.threads(), door.nowMillis()))
            }
        }
    }
}

/**
 * WHAT SWIFTUI HOLDS INSTEAD OF A `StateFlow`: bytes in, bytes out, and a verb
 * per intent. Android drives [flow] directly.
 *
 * The shell:
 *
 * 1. builds one bridge for the app's session and calls [attach] with the
 *    foreground core's supplier (`{ session.shelf.core() }`), where the model
 *    file lives, the device's zone, and the two platform acts;
 * 2. calls [open] each time the Chat tab appears (with the app it was opened
 *    from, or empty) — repeating the same scope keeps the thread;
 * 3. in `PHASE_NEEDS_MODEL`, runs its download when [attach]'s `startDownload`
 *    fires, and reports it with [downloadProgress] and [downloadFinished];
 * 4. draws each state it is handed, and draws `cards` as the apps' own tiles.
 */
public class ChatBridge {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var running: ChatFlow? = null
    private var onState: ((ByteArray) -> Unit)? = null
    private var collecting = false

    /** The flow, once attached. */
    public val flow: ChatFlow? get() = running

    public fun attach(
        core: () -> CentraidCore?,
        modelPath: () -> String,
        timeZone: () -> String,
        startDownload: () -> Unit,
        copyToClipboard: (String) -> Unit,
        projectorPath: () -> String = { "" },
        startVisionDownload: () -> Unit = {},
        nowMillis: () -> Long = { 0L },
    ) {
        if (running != null) return
        val made = ChatFlow(
            door = CoreChatDoor(core, modelPath, timeZone, projectorPath, nowMillis),
            startDownload = startDownload,
            copyToClipboard = copyToClipboard,
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
            startVisionDownload = startVisionDownload,
        )
        made.attach()
        running = made
        startPublishing()
    }

    /** The finished state, as the bytes SwiftProtobuf decodes. */
    public fun observe(onState: (ByteArray) -> Unit) {
        this.onState = onState
        startPublishing()
        running?.let { onState(it.state.value.encode()) }
    }

    private fun startPublishing() {
        val flow = running ?: return
        if (collecting) return
        collecting = true
        scope.launch { flow.state.collect { onState?.invoke(it.encode()) } }
    }

    public fun current(): ByteArray = (running?.state?.value ?: ChatState()).encode()

    /**
     * The Chat tab appeared ([scopeChosen] false) or the member chose a scope
     * from the composer's menu ([scopeChosen] true, which starts over when it
     * differs). [vaultName] is the foreground vault's, for the header.
     */
    public fun open(app: String, modelBytes: Long, vaultName: String = "", scopeChosen: Boolean = false) {
        forward(
            ChatEvent(
                opened = ChatEvent.Opened(
                    app = app,
                    model_bytes = modelBytes,
                    vault_name = vaultName,
                    scope_chosen = scopeChosen,
                ),
            ),
        )
    }

    /** The header's menu control, the scrim, or the Chat tab pressed while Chat shows. */
    public fun toggleDrawer(open: Boolean) {
        forward(ChatEvent(drawer = ChatEvent.DrawerToggled(opened = open)))
    }

    public fun openThread(threadId: String) {
        forward(ChatEvent(thread_opened = ChatEvent.ThreadOpened(thread_id = threadId)))
    }

    public fun renameThread(threadId: String, title: String) {
        forward(ChatEvent(thread_renamed = ChatEvent.ThreadRenamed(thread_id = threadId, title = title)))
    }

    public fun deleteThread(threadId: String) {
        forward(ChatEvent(thread_deleted = ChatEvent.ThreadDeleted(thread_id = threadId)))
    }

    public fun deleteAllThreads() {
        forward(ChatEvent(all_threads_deleted = ChatEvent.AllThreadsDeleted()))
    }

    /**
     * Whether the row a tapped card names is still in the vault, handed to
     * [onResult] (true when the core would not say). A callback and not a return:
     * a SwiftUI button cannot await.
     */
    public fun cardLive(app: String, entity: String, id: String, onResult: (Boolean) -> Unit) {
        val flow = running ?: return onResult(true)
        scope.launch { onResult(flow.cardLive(app, entity, id)) }
    }

    public fun send(text: String) {
        forward(ChatEvent(sent = ChatEvent.Sent(text = text)))
    }

    public fun stop() {
        forward(ChatEvent(stopped = ChatEvent.Stopped()))
    }

    public fun regenerate() {
        forward(ChatEvent(regenerated = ChatEvent.Regenerated()))
    }

    public fun newChat() {
        forward(ChatEvent(new_chat = ChatEvent.NewChat()))
    }

    public fun copy(messageId: Long) {
        forward(ChatEvent(copied = ChatEvent.Copied(message_id = messageId)))
    }

    /** Confirm on the confirm card [pendingId] names. */
    public fun confirmPending(pendingId: String) {
        forward(ChatEvent(pending_confirmed = ChatEvent.PendingConfirmed(pending_id = pendingId)))
    }

    /** Cancel on the confirm card [pendingId] names. */
    public fun cancelPending(pendingId: String) {
        forward(ChatEvent(pending_cancelled = ChatEvent.PendingCancelled(pending_id = pendingId)))
    }

    public fun downloadTapped() {
        forward(ChatEvent(download = ChatEvent.DownloadTapped()))
    }

    public fun downloadProgress(doneBytes: Long, totalBytes: Long) {
        forward(ChatEvent(download_progress = ChatEvent.DownloadProgress(done_bytes = doneBytes, total_bytes = totalBytes)))
    }

    public fun downloadFinished(ok: Boolean) {
        forward(ChatEvent(download_finished = ChatEvent.DownloadFinished(ok = ok)))
    }

    /** The photo reader's own download, reported the same way as the model's. */
    public fun visionDownloadTapped() {
        forward(ChatEvent(download = ChatEvent.DownloadTapped(vision = true)))
    }

    public fun visionDownloadProgress(doneBytes: Long, totalBytes: Long) {
        forward(
            ChatEvent(
                download_progress = ChatEvent.DownloadProgress(
                    done_bytes = doneBytes,
                    total_bytes = totalBytes,
                    vision = true,
                ),
            ),
        )
    }

    public fun visionDownloadFinished(ok: Boolean) {
        forward(ChatEvent(download_finished = ChatEvent.DownloadFinished(ok = ok, vision = true)))
    }

    /**
     * The vault's text documents, as the bytes of an encoded `AssistDocuments`,
     * handed to [onResult] when the core has answered (empty bytes when it would
     * not). A callback and not a return: a SwiftUI sheet cannot await.
     */
    public fun loadDocuments(onResult: (ByteArray) -> Unit) {
        val flow = running ?: return onResult(ByteArray(0))
        scope.launch { onResult(flow.documents()?.encode() ?: ByteArray(0)) }
    }

    /** Take a waiting attachment out of the composer. */
    public fun removeAttachment(id: Long) {
        forward(ChatEvent(attachment_removed = ChatEvent.AttachmentRemoved(id = id)))
    }

    /** An event the view built itself, encoded. */
    public fun sendEncoded(event: ByteArray) {
        forward(ChatEvent.ADAPTER.decode(event))
    }

    public fun forward(event: ChatEvent) {
        running?.send(event)
    }

    /**
     * RELEASE THIS BRIDGE: its flow's collector is cancelled, its state stops
     * publishing, and every later call is a no-op. A shell that moves to
     * another vault builds a NEW bridge (the thread, the session and the cards
     * belong to the vault that was in front) and closes the old one — without
     * this the old collector went on listening to the previous core's stream
     * for the life of the process.
     */
    public fun close() {
        running?.close()
        running = null
        onState = null
        collecting = false
        scope.cancel()
    }
}
