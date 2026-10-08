package dev.centraid.shared.chat

import centraid.core.v1.AssistCard
import centraid.core.v1.AssistEvent
import centraid.core.v1.AssistModelState
import centraid.core.v1.AssistNotice
import centraid.core.v1.AssistPending
import centraid.core.v1.AssistReading
import centraid.core.v1.AssistReadingKind
import centraid.core.v1.AssistRefusal
import centraid.core.v1.AssistRefusalReason
import centraid.core.v1.AssistSent
import centraid.core.v1.AssistSettleOutcome
import centraid.core.v1.AssistSettled
import centraid.core.v1.AssistStarted
import centraid.core.v1.AssistVisionState
import centraid.core.v1.ChatStoredAttachment
import centraid.core.v1.ChatStoredAttachmentKind
import centraid.core.v1.ChatStoredCard
import centraid.core.v1.ChatStoredOutcome
import centraid.core.v1.ChatThread
import centraid.screen.v1.ChatAttachment
import centraid.screen.v1.ChatCard
import centraid.screen.v1.ChatEvent
import centraid.screen.v1.ChatMessage
import centraid.screen.v1.ChatModelStep
import centraid.screen.v1.ChatPending
import centraid.screen.v1.ChatPendingStep
import centraid.screen.v1.ChatState
import centraid.screen.v1.ChatThreadItem
import dev.centraid.design.copy.ChatCopy
import dev.centraid.design.copy.SharedCopy
import dev.centraid.shared.kit.time.CivilWords
import okio.ByteString

/**
 * THE ON-DEVICE CHAT, AS A PURE MACHINE.
 *
 * `chat`. A tab on the bottom bar, not an app (`screen.proto`'s Chat section):
 * a question goes to the core's assistant plane (`assist.proto`), the model
 * routes it to one read and phrases one line, and the answer is that line
 * **and the rows it found**, which the apps' own tiles draw. This file is the
 * decisions: what each phase shows, what a tap does in each, how a streamed
 * event and the call's own answer — the same fact twice — settle a turn once.
 * It does no I/O: [reduce] takes a [Chat] and an input and answers the next
 * [Chat] and the [ChatEffect]s to run, exactly as `WordsShowMachine` does.
 *
 * ## The phases are the model's, not the thread's
 *
 * `CHECKING → NEEDS_MODEL → DOWNLOADING → LOADING → READY`, with `UNAVAILABLE`
 * for a build that cannot run a model. The thread exists only in `READY`: a
 * member never types into a chat that has no model to answer, and the download
 * is a step on the way, drawn from [ChatModelStep], not a screen.
 *
 * ## A turn settles ONCE
 *
 * The core tells a turn's end twice — a terminal event on the stream and the
 * answer to the `send` call — and which arrives first is not promised. Both
 * carry the turn id this machine minted, and a turn is settled only while it is
 * the running one: the second to arrive finds `running` false, or a newer turn
 * id, and is dropped.
 *
 * ## What the transcript is, and where it lives
 *
 * The thread on screen is in this object; what was said is the VAULT's
 * (R-CHAT-1). The core saves each completed turn itself, through the `chat.*`
 * commands, and answers the thread it saved into on the turn's own response
 * ([ChatInput.Settled]): that is how this machine learns [Chat.threadId]. A past
 * chat is opened by [ChatEffect.OpenThread], which reads the stored messages
 * and asks the core for a session rebuilt from them, and arrives as ONE input
 * ([ChatInput.ThreadOpened]) so the thread and its session never disagree.
 * [ChatMessage.id] is monotonic within the thread on screen and is what a view
 * diffs by and what `copy` names.
 *
 * ## A write the model proposes is a card, and a tap makes it (#1088, R-1088-2)
 *
 * The core never writes on the model's say-so: the turn ends in an answer that
 * carries the write it PARKED ([AssistPending], on the stream and again on the
 * answer, which is the reliable copy). This machine draws it as a confirm card
 * under the answer ([ChatPending]) in [ProposalPhase.WAITING]. Confirm moves it
 * to WORKING and asks the core to run it ([ChatEffect.Confirm]); the core's
 * [AssistSettled] settles it to APPLIED, STALE or NOT_DONE with the core's own
 * line. Cancel settles it to NOT_DONE at once and tells the core
 * ([ChatEffect.Dismiss]). A new question supersedes a card still WAITING (the core
 * drops it too): it goes INERT, buttons gone. A card in flight is never
 * superseded, so a tap that did write is never shown as one that did not. The
 * card lives only in the thread on screen: a reopened chat is a fresh session
 * that holds no write (R-1088-10), so a stored `proposed` answer is drawn with
 * its "Proposed: …" text and an INERT card, and an applied, dismissed, stale or
 * failed one as the line the member was told, which is the text the vault kept.
 *
 * There is NO UNDO on an applied card. The runtime's undo is a verb the MODEL
 * writes, and it parks like any write; the core has no request that parks one
 * without the model, so an Undo control here would have nothing to call.
 *
 * ## The drawer
 *
 * The header's menu opens the DRAWER: past chats, newest first, the open one
 * marked ([ChatState.drawer_open], [ChatState.threads]). The list is read when
 * the tab appears, when the drawer opens and after anything that changes it
 * (a saved turn, a rename, a delete), so it is never older than the last act.
 * Opening a past chat stops a running turn first and replaces the thread; a
 * chat deleted from another place and tapped here says it is gone and starts a
 * new one.
 *
 * ## Attachments
 *
 * A message may carry one photo and one text document (the plane's v1 limit).
 * They WAIT in the composer ([Chat.pending]) until a send moves them onto the
 * member's message as markers and thumbnails — never bytes. A second photo
 * replaces the first rather than being refused: the member's last choice is
 * the one they meant. A photo needs the vision projector, a second download
 * fetched only on a first photo ([Vision]); until it is on the model the send
 * is blocked and the composer says why ([ChatState.vision_step]). Retry asks
 * the last turn's attachments again ([Chat.lastSent]), because the core
 * forgets nothing the shell can still hand it and a refused turn never
 * reached the plane.
 */
public object ChatMachine {
    /** A chat that has not asked the core anything yet. */
    public fun initial(): Chat = render(Chat())

    /** The most suggestions the thread's empty state offers. */
    public const val SUGGESTIONS: Int = 3

    public fun reduce(chat: Chat, input: ChatInput): ChatStep = when (input) {
        is ChatInput.View -> view(chat, input.event)
        is ChatInput.Status -> status(chat, input.state)
        is ChatInput.Loaded -> loaded(chat, input.state)
        is ChatInput.Started -> started(chat, input.session)
        is ChatInput.Suggested -> suggested(chat, input)
        is ChatInput.Core -> core(chat, input.event)
        is ChatInput.Settled -> settled(chat, input)
        is ChatInput.Confirmed -> confirmed(chat, input)
        is ChatInput.VisionStatus -> visionStatus(chat, input.state, input.bytes)
        is ChatInput.VisionLoaded -> visionLoaded(chat, input.state)
        is ChatInput.Threads -> threadsRead(chat, input)
        is ChatInput.ThreadOpened -> threadLoaded(chat, input)
    }

    // ---------------------------------------------------------------- view --

    private fun view(chat: Chat, event: ChatEvent): ChatStep {
        event.opened?.let { return opened(chat, it) }
        event.sent?.let { return asked(chat, it.text) }
        event.stopped?.let { return stopped(chat) }
        event.regenerated?.let { return regenerated(chat) }
        event.new_chat?.let { return newChat(chat) }
        event.copied?.let { return copied(chat, it.message_id) }
        event.download?.let { return if (it.vision) visionTapped(chat) else downloadTapped(chat) }
        event.download_progress?.let {
            return if (it.vision) visionProgressed(chat, it) else progressed(chat, it)
        }
        event.download_finished?.let {
            return if (it.vision) visionFinished(chat, it.ok) else downloadFinished(chat, it.ok)
        }
        event.attached?.let { return attached(chat, it) }
        event.attachment_removed?.let { return removed(chat, it.id) }
        event.drawer?.let { return drawerToggled(chat, it.opened) }
        event.pending_confirmed?.let { return confirmTapped(chat, it.pending_id) }
        event.pending_cancelled?.let { return cancelTapped(chat, it.pending_id) }
        event.thread_opened?.let { return threadOpened(chat, it.thread_id) }
        event.thread_renamed?.let { return threadRenamed(chat, it.thread_id, it.title) }
        event.thread_deleted?.let { return threadDeleted(chat, it.thread_id) }
        event.all_threads_deleted?.let { return allThreadsDeleted(chat) }
        return ChatStep(chat)
    }

    /**
     * The tab appeared, or the member chose a scope.
     *
     * A tab appearing changes nothing about a chat that has something in it —
     * the thread survives a switch of tab, and a thread opened from the drawer
     * keeps ITS scope, which the shell has never heard of. It adopts the app it
     * was opened from only while there is nothing to lose: no messages and no
     * stored thread. A scope CHOSEN from the composer's menu ([ChatEvent.Opened.scope_chosen])
     * starts over when it differs, which is what a new scope means. Either way
     * the vault's name is kept current, a chat still waiting on a model looks
     * again (the file may have arrived while another tab was up), and the
     * drawer's list is read afresh.
     */
    private fun opened(chat: Chat, event: ChatEvent.Opened): ChatStep {
        val bytes = event.model_bytes
        val named = event.vault_name.ifEmpty { chat.vaultName }
        val untouched = chat.messages.isEmpty() && chat.threadId.isEmpty() && chat.opening.isEmpty()
        val rescope = chat.opened && chat.scope != event.app && (event.scope_chosen || untouched)
        if (chat.opened && !rescope) {
            val waiting = chat.phase == ChatState.Phase.PHASE_NEEDS_MODEL ||
                chat.phase == ChatState.Phase.PHASE_UNAVAILABLE
            val kept = chat.copy(modelBytes = if (bytes > 0) bytes else chat.modelBytes, vaultName = named)
            val effects = listOfNotNull(
                ChatEffect.ReadStatus.takeIf { waiting },
                ChatEffect.ReadThreads.takeIf { !chat.running },
            )
            return ChatStep(render(kept), effects)
        }
        val stopping = if (chat.running && chat.session != 0L) listOf(ChatEffect.Cancel(chat.session)) else emptyList()
        val fresh = Chat(
            opened = true,
            scope = event.app,
            modelBytes = bytes,
            vaultName = named,
            threads = chat.threads,
            now = chat.now,
        )
        return ChatStep(render(fresh), stopping + ChatEffect.ReadStatus + ChatEffect.ReadThreads)
    }

    private fun asked(chat: Chat, text: String): ChatStep {
        val line = text.trim()
        if (!ready(chat) || chat.running || line.isEmpty() || visionBlocked(chat)) return ChatStep(chat)
        return ask(chat, line, regenerate = false)
    }

    /** Append the user's line (unless regenerating) and an empty answer, and send. */
    private fun ask(chat: Chat, line: String, regenerate: Boolean): ChatStep {
        val turn = chat.turn + 1
        val user = chat.nextId
        val answer = if (regenerate) user else user + 1
        // A retry asks the last turn's attachments again; a new question takes
        // what waits in the composer, and the composer empties.
        val carried = if (regenerate) chat.lastSent else chat.pending
        val messages = buildList {
            // A card still waiting is superseded by the new question: the core drops it too.
            addAll(chat.messages.map { it.superseded() })
            if (!regenerate) add(Msg(id = user, user = true, text = line, attachments = carried))
            add(Msg(id = answer, user = false, streaming = true))
        }
        val next = chat.copy(
            messages = messages,
            nextId = answer + 1,
            suggestions = emptyList(),
            running = true,
            turn = turn,
            // The status line says something from the first moment: the answer
            // is never a bare mark.
            activity = ChatCopy.THINKING,
            error = "",
            asked = line,
            pending = if (regenerate) chat.pending else emptyList(),
            lastSent = carried,
        )
        return ChatStep(render(next), listOf(ChatEffect.Send(chat.session, turn, line, regenerate, carried)))
    }

    private fun stopped(chat: Chat): ChatStep =
        if (chat.running) ChatStep(chat, listOf(ChatEffect.Cancel(chat.session))) else ChatStep(chat)

    /** Ask the last question again, in place of the last answer. */
    private fun regenerated(chat: Chat): ChatStep {
        val line = chat.asked
        if (!ready(chat) || chat.running || line == null) return ChatStep(chat)
        val kept = if (chat.messages.lastOrNull()?.user == false) chat.messages.dropLast(1) else chat.messages
        if (kept.lastOrNull()?.user != true) return ChatStep(chat)
        // The user's line stays where it was; only the answer is replaced, and
        // the core drops the turn it recorded (`regenerate`).
        return ask(chat.copy(messages = kept, nextId = chat.nextId), line, regenerate = true)
    }

    private fun newChat(chat: Chat): ChatStep {
        val cleared = fresh(chat)
        if (chat.session == 0L) return ChatStep(render(cleared))
        return ChatStep(
            render(cleared),
            listOf(ChatEffect.Clear(chat.session), ChatEffect.Suggest(chat.scope, chat.session)),
        )
    }

    /**
     * THE SAME CHAT, WITH NOTHING IN IT: no thread, no messages, the drawer shut.
     * The core's session is told to clear separately (it unbinds the stored
     * thread there), and the turn id moves on so that whatever an abandoned turn
     * still says is stale.
     */
    private fun fresh(chat: Chat): Chat = chat.copy(
        messages = emptyList(),
        suggestions = emptyList(),
        running = false,
        turn = chat.turn + 1,
        activity = "",
        error = "",
        asked = null,
        pending = emptyList(),
        lastSent = emptyList(),
        threadId = "",
        threadTitle = "",
        opening = "",
        drawerOpen = false,
    )

    private fun copied(chat: Chat, id: Long): ChatStep {
        val text = chat.messages.firstOrNull { it.id == id }?.text.orEmpty()
        return if (text.isEmpty()) ChatStep(chat) else ChatStep(chat, listOf(ChatEffect.Copy(text)))
    }

    private fun downloadTapped(chat: Chat): ChatStep {
        if (chat.phase != ChatState.Phase.PHASE_NEEDS_MODEL) return ChatStep(chat)
        return ChatStep(
            render(chat.copy(phase = ChatState.Phase.PHASE_DOWNLOADING, progress = null, error = "")),
            listOf(ChatEffect.StartDownload),
        )
    }

    /**
     * A transfer reported progress.
     *
     * While the chat is DOWNLOADING that moves the bar. While it is CHECKING or
     * NEEDS_MODEL it is the other thing progress can mean: a download the
     * shell started in an earlier launch is STILL RUNNING (a background
     * transfer outlives the app), and the shell said so on this launch. The
     * chat goes to DOWNLOADING at once instead of offering "Download model"
     * over a transfer that is already half done and waiting for a tap to be
     * noticed. Order against the status read does not matter: a status that
     * lands after this is ignored while DOWNLOADING (see [status]), and one
     * that landed before has only put the chat in NEEDS_MODEL, which this
     * leaves. No effect: the transfer is already going.
     */
    private fun progressed(chat: Chat, event: ChatEvent.DownloadProgress): ChatStep {
        val resumed = chat.phase == ChatState.Phase.PHASE_CHECKING ||
            chat.phase == ChatState.Phase.PHASE_NEEDS_MODEL
        if (chat.phase != ChatState.Phase.PHASE_DOWNLOADING && !resumed) return ChatStep(chat)
        val total = event.total_bytes
        val fraction = if (total > 0) (event.done_bytes.toFloat() / total.toFloat()).coerceIn(0f, 1f) else null
        return ChatStep(
            render(
                chat.copy(
                    phase = ChatState.Phase.PHASE_DOWNLOADING,
                    progress = fraction,
                    modelBytes = if (total > 0) total else chat.modelBytes,
                    error = if (resumed) "" else chat.error,
                ),
            ),
        )
    }

    private fun downloadFinished(chat: Chat, ok: Boolean): ChatStep {
        if (chat.phase != ChatState.Phase.PHASE_DOWNLOADING) return ChatStep(chat)
        return if (ok) {
            ChatStep(render(chat.copy(phase = ChatState.Phase.PHASE_LOADING, progress = null)), listOf(ChatEffect.Load))
        } else {
            ChatStep(
                render(
                    chat.copy(
                        phase = ChatState.Phase.PHASE_NEEDS_MODEL,
                        progress = null,
                        error = ChatCopy.DOWNLOAD_FAILED,
                    ),
                ),
            )
        }
    }

    // ---------------------------------------------------------------- core --

    /** What the core says about the model file. `null`: it would not answer. */
    private fun status(chat: Chat, state: AssistModelState?): ChatStep {
        // A status read that was in flight when the download began is older than
        // the download, and must not put the step back.
        if (chat.phase == ChatState.Phase.PHASE_DOWNLOADING) return ChatStep(chat)
        return when (state) {
            AssistModelState.ASSIST_MODEL_STATE_ABSENT ->
                ChatStep(render(chat.copy(phase = ChatState.Phase.PHASE_NEEDS_MODEL, progress = null)))
            AssistModelState.ASSIST_MODEL_STATE_PRESENT ->
                ChatStep(
                    // The projector belongs to the loaded model: a model that
                    // is about to be loaded has none.
                    render(chat.copy(phase = ChatState.Phase.PHASE_LOADING, vision = chat.vision.unloaded())),
                    listOf(ChatEffect.Load),
                )
            AssistModelState.ASSIST_MODEL_STATE_LOADING ->
                ChatStep(render(chat.copy(phase = ChatState.Phase.PHASE_LOADING)))
            AssistModelState.ASSIST_MODEL_STATE_READY -> becameReady(chat)
            // NO_ENGINE, a core that would not answer, and a state this build
            // has no name for are all "not available here".
            else -> ChatStep(render(chat.copy(phase = ChatState.Phase.PHASE_UNAVAILABLE)))
        }
    }

    private fun loaded(chat: Chat, state: AssistModelState?): ChatStep {
        if (chat.phase != ChatState.Phase.PHASE_LOADING) return ChatStep(chat)
        if (state == AssistModelState.ASSIST_MODEL_STATE_READY) return becameReady(chat)
        // A file that will not load is a file to fetch again.
        return ChatStep(
            render(chat.copy(phase = ChatState.Phase.PHASE_NEEDS_MODEL, error = ChatCopy.LOAD_FAILED)),
        )
    }

    private fun becameReady(chat: Chat): ChatStep {
        val ready = chat.copy(phase = ChatState.Phase.PHASE_READY, progress = null, error = "")
        if (chat.session != 0L) return ChatStep(render(ready))
        return ChatStep(render(ready), listOf(ChatEffect.Start(chat.scope)))
    }

    private fun started(chat: Chat, session: Long?): ChatStep {
        if (session == null) return ChatStep(render(chat.copy(phase = ChatState.Phase.PHASE_UNAVAILABLE)))
        val next = chat.copy(session = session)
        return if (next.messages.isEmpty()) {
            ChatStep(render(next), listOf(ChatEffect.Suggest(chat.scope, session)))
        } else {
            ChatStep(render(next))
        }
    }

    private fun suggested(chat: Chat, input: ChatInput.Suggested): ChatStep {
        if (input.session != chat.session || chat.messages.isNotEmpty()) return ChatStep(chat)
        return ChatStep(render(chat.copy(suggestions = input.prompts.filter { it.isNotBlank() }.take(SUGGESTIONS))))
    }

    /** One streamed event. Only the running turn's are heard. */
    private fun core(chat: Chat, event: AssistEvent): ChatStep {
        if (!chat.running || event.session_id != chat.session || event.turn_id != chat.turn) return ChatStep(chat)
        event.activity?.let { activity ->
            return ChatStep(render(chat.copy(activity = ChatCopy.LOOKING.replace("{app}", appName(activity.app)))))
        }
        event.reading?.let { reading -> return ChatStep(render(chat.copy(activity = readingLine(reading)))) }
        event.cards?.let { cards ->
            return ChatStep(render(chat.withAnswer { it.copy(cards = cards.cards.map(::card)) }))
        }
        event.token?.let { token ->
            // The first words end "Thinking": text is its own status.
            val spoken = if (chat.activity == ChatCopy.THINKING) chat.copy(activity = "") else chat
            return ChatStep(render(spoken.withAnswer { it.copy(text = it.text + token.text) }))
        }
        event.pending?.let { pending ->
            return ChatStep(render(chat.withAnswer { it.withProposal(pending) }))
        }
        event.answer?.let { answer -> return answered(chat, answer.text, answer.cards, answer.notices, answer.pending) }
        event.failed?.let { failed -> return failed(chat, failed) }
        return ChatStep(chat)
    }

    /**
     * The `send` call came back: the same fact as the terminal event, and the
     * ONE carrier of where the turn was saved.
     *
     * The thread is absorbed whichever of the two arrived first — an event can be
     * dropped from a full queue and a response cannot — but only for the latest
     * turn: a new chat moves the turn id on, and an old turn's thread must not
     * be adopted by the chat that replaced it.
     */
    private fun settled(chat: Chat, input: ChatInput.Settled): ChatStep {
        if (input.turn != chat.turn) return ChatStep(chat)
        val sent: AssistSent? = input.sent
        val saved = sent != null && sent.thread_id.isNotEmpty()
        val adopted = if (saved && sent != null) {
            chat.copy(threadId = sent.thread_id, threadTitle = sent.thread_title.ifEmpty { chat.threadTitle })
        } else {
            chat
        }
        val refresh = if (saved) listOf(ChatEffect.ReadThreads) else emptyList()
        if (!adopted.running) return ChatStep(render(adopted), refresh)
        if (sent == null) return failed(adopted, null).let { it.copy(effects = it.effects + refresh) }
        val step = sent.answered?.let { answered(adopted, it.text, it.cards, it.notices, it.pending) }
            ?: failed(adopted, sent.refused)
        return step.copy(effects = step.effects + refresh)
    }

    private fun answered(
        chat: Chat,
        text: String,
        cards: List<AssistCard>,
        notices: List<AssistNotice> = emptyList(),
        pending: AssistPending? = null,
    ): ChatStep {
        val note = if (AssistNotice.ASSIST_NOTICE_DOC_TRUNCATED in notices) ChatCopy.NOTE_DOC_TRUNCATED else ""
        // The card rode the stream before the answer and rides the answer too, so one that
        // was dropped from a full queue still arrives; `withProposal` keeps the one it has.
        val settled = chat.withAnswer {
            it.copy(text = text, cards = cards.map(::card), streaming = false, note = note).withProposal(pending)
        }
        return ChatStep(render(settled.copy(running = false, activity = "", error = "")))
    }

    private fun readingLine(reading: AssistReading): String = when (reading.kind) {
        AssistReadingKind.ASSIST_READING_KIND_PHOTO -> ChatCopy.READING_PHOTO
        AssistReadingKind.ASSIST_READING_KIND_DOCUMENT -> ChatCopy.READING_DOCUMENT
        else -> ChatCopy.THINKING
    }

    /** The one line a refusal is told in, or empty for a stop, which says nothing. */
    private fun errorLine(reason: AssistRefusalReason): String = when (reason) {
        AssistRefusalReason.ASSIST_REFUSAL_REASON_CANCELLED -> ""
        AssistRefusalReason.ASSIST_REFUSAL_REASON_NO_TOOL_FITS -> ChatCopy.ERROR_NO_TOOL
        AssistRefusalReason.ASSIST_REFUSAL_REASON_QUERY_FAILED -> ChatCopy.ERROR_READ
        AssistRefusalReason.ASSIST_REFUSAL_REASON_MODEL_FAILED -> ChatCopy.ERROR_MODEL
        AssistRefusalReason.ASSIST_REFUSAL_REASON_VISION_ABSENT -> ChatCopy.ERROR_VISION
        AssistRefusalReason.ASSIST_REFUSAL_REASON_ATTACHMENT_UNSUPPORTED -> ChatCopy.ERROR_ATTACH_UNSUPPORTED
        AssistRefusalReason.ASSIST_REFUSAL_REASON_ATTACHMENT_UNREADABLE -> ChatCopy.ERROR_ATTACH_UNREADABLE
        AssistRefusalReason.ASSIST_REFUSAL_REASON_ATTACHMENT_TOO_LARGE -> ChatCopy.ERROR_ATTACH_TOO_LARGE
        else -> ChatCopy.ERROR_GENERIC
    }

    /**
     * A turn that did not answer. A stop keeps what was drawn and says nothing
     * about it; any other failure keeps cards that were drawn and puts one line
     * about it where the view reads `error`.
     */
    private fun failed(chat: Chat, refusal: AssistRefusal?): ChatStep {
        val reason = refusal?.reason ?: AssistRefusalReason.ASSIST_REFUSAL_REASON_UNSPECIFIED
        val last = chat.messages.lastOrNull()
        val hasContent = last != null && !last.user &&
            (last.text.isNotEmpty() || last.cards.isNotEmpty() || last.proposal != null)
        val messages = when {
            last == null || last.user -> chat.messages
            // A turn that failed after parking a write does not offer it: the turn is over.
            hasContent -> chat.messages.dropLast(1) + last.superseded().copy(streaming = false, stopped = true)
            else -> chat.messages.dropLast(1)
        }
        val error = errorLine(reason)
        val next = chat.copy(messages = messages, running = false, activity = "", error = error)
        // THE PHOTO READER WENT AWAY (the model was unloaded, and its projector
        // with it): look again, so the composer says what to do about it.
        if (reason == AssistRefusalReason.ASSIST_REFUSAL_REASON_VISION_ABSENT) {
            return ChatStep(render(next.copy(vision = next.vision.unloaded())), listOf(ChatEffect.ReadVision))
        }
        // THE MODEL WENT AWAY (memory pressure unloaded it): ask what stands now,
        // so the chat draws the load step instead of failing every question.
        if (reason == AssistRefusalReason.ASSIST_REFUSAL_REASON_MODEL_ABSENT) {
            return ChatStep(
                render(next.copy(phase = ChatState.Phase.PHASE_CHECKING, error = "", vision = next.vision.unloaded())),
                listOf(ChatEffect.ReadStatus),
            )
        }
        return ChatStep(render(next))
    }

    // ------------------------------------------------------------ proposals --

    /** Replace the message holding card [id] in [phase] with [change] of it; null when none does. */
    private fun Chat.changingProposal(id: String, phase: ProposalPhase, change: (Proposal) -> Proposal): Chat? {
        val at = messages.indexOfFirst { message -> message.proposal?.let { it.id == id && it.phase == phase } == true }
        if (at < 0) return null
        val held = messages[at]
        val proposal = held.proposal ?: return null
        return copy(messages = messages.toMutableList().also { it[at] = held.copy(proposal = change(proposal)) })
    }

    /**
     * Confirm was tapped. Only a card WAITING, on a settled turn, is run; the card goes to
     * WORKING so a second tap finds nothing waiting, and the core runs it once.
     */
    private fun confirmTapped(chat: Chat, id: String): ChatStep {
        if (!ready(chat) || chat.running || id.isEmpty()) return ChatStep(chat)
        val working = chat.changingProposal(id, ProposalPhase.WAITING) { it.copy(phase = ProposalPhase.WORKING) }
            ?: return ChatStep(chat)
        return ChatStep(render(working.copy(error = "")), listOf(ChatEffect.Confirm(chat.session, id)))
    }

    /**
     * Cancel was tapped: the card settles at once ("Not done.") and the core is told. A core
     * that does not hear it still holds a card nothing can tap, and the next message drops it.
     */
    private fun cancelTapped(chat: Chat, id: String): ChatStep {
        if (!ready(chat) || chat.running || id.isEmpty()) return ChatStep(chat)
        val cancelled = chat.changingProposal(id, ProposalPhase.WAITING) {
            it.copy(phase = ProposalPhase.NOT_DONE, line = notDoneLine())
        } ?: return ChatStep(chat)
        return ChatStep(render(cancelled), listOf(ChatEffect.Dismiss(chat.session, id)))
    }

    /** The core's answer to a confirm: how it ended and the line to say. */
    private fun confirmed(chat: Chat, input: ChatInput.Confirmed): ChatStep {
        val settled: AssistSettled? = input.settled
        // THE CALL ITSELF FAILED: nothing ran (the core refuses a tap on a chat still running or
        // gone, and a closed core runs nothing), so the card is offered again rather than
        // claiming an outcome nobody saw.
        if (settled == null) {
            val offered = chat.changingProposal(input.pendingId, ProposalPhase.WORKING) {
                it.copy(phase = ProposalPhase.WAITING)
            } ?: return ChatStep(chat)
            return ChatStep(render(offered.copy(error = ChatCopy.ERROR_GENERIC)))
        }
        val next = chat.changingProposal(input.pendingId, ProposalPhase.WORKING) { held ->
            val phase = when (settled.outcome) {
                AssistSettleOutcome.ASSIST_SETTLE_OUTCOME_APPLIED -> ProposalPhase.APPLIED
                AssistSettleOutcome.ASSIST_SETTLE_OUTCOME_STALE -> ProposalPhase.STALE
                // A refusal, a card that was already gone, anything this build has no name for.
                else -> ProposalPhase.NOT_DONE
            }
            held.copy(phase = phase, line = settled.line.ifEmpty { notDoneLine() })
        } ?: return ChatStep(chat)
        return ChatStep(render(next))
    }

    /** `Not done.`: the copy's sentence with no reason to give. */
    private fun notDoneLine(): String = ChatCopy.SAID_NOT_DONE.replace("{reason}", "").trim()

    /** A card still WAITING when something newer happens goes inert; any other phase has already ended or is in flight. */
    private fun Msg.superseded(): Msg {
        val held = proposal ?: return this
        if (held.phase != ProposalPhase.WAITING) return this
        return copy(proposal = held.copy(phase = ProposalPhase.INERT, line = notDoneLine()))
    }

    /** The card the core sent, once: the stream and the answer both carry it, in either order. */
    private fun Msg.withProposal(wire: AssistPending?): Msg {
        if (wire == null || wire.pending_id.isEmpty() || proposal?.id == wire.pending_id) return this
        return copy(
            proposal = Proposal(
                id = wire.pending_id,
                steps = wire.steps.map { ProposalStep(summary = it.summary, destructive = it.destructive) },
                more = wire.more,
                destructive = wire.destructive,
            ),
        )
    }

    // -------------------------------------------------------------- threads --

    /** The drawer's own control, its scrim, or the Chat tab pressed while Chat is showing. */
    private fun drawerToggled(chat: Chat, open: Boolean): ChatStep {
        if (chat.drawerOpen == open) return ChatStep(chat)
        // Opening reads the list again: it is never older than the last act.
        return ChatStep(render(chat.copy(drawerOpen = open)), if (open) listOf(ChatEffect.ReadThreads) else emptyList())
    }

    /** The drawer's list, read. A refusal to answer leaves the list as it was. */
    private fun threadsRead(chat: Chat, input: ChatInput.Threads): ChatStep {
        val rows = input.rows ?: return ChatStep(chat)
        return ChatStep(render(chat.copy(threads = rows, now = if (input.nowMs > 0) input.nowMs else chat.now)))
    }

    /**
     * A past chat was tapped. The one already open only closes the drawer.
     * Anything else stops a running turn, shows the thread as loading (empty,
     * with its title already in the header) and asks for the stored messages
     * and a session rebuilt from them.
     */
    private fun threadOpened(chat: Chat, id: String): ChatStep {
        if (id.isEmpty()) return ChatStep(chat)
        if (id == chat.threadId && chat.opening.isEmpty()) return drawerToggled(chat, false)
        val stopping = if (chat.running && chat.session != 0L) listOf(ChatEffect.Cancel(chat.session)) else emptyList()
        val title = chat.threads.firstOrNull { it.id == id }?.title.orEmpty()
        val loading = fresh(chat).copy(threadId = id, threadTitle = title, opening = id)
        return ChatStep(render(loading), stopping + ChatEffect.OpenThread(id))
    }

    /**
     * The stored thread and its session, together. A thread that is not in the
     * vault any more (deleted from another place) says so and becomes a new
     * chat. Anything but the thread this machine is still waiting for is stale.
     */
    private fun threadLoaded(chat: Chat, input: ChatInput.ThreadOpened): ChatStep {
        if (chat.opening.isEmpty() || input.requested != chat.opening) return ChatStep(chat)
        val stored = input.thread
        val started = input.started
        if (stored == null || !stored.found || started == null) {
            val gone = fresh(chat).copy(error = if (stored != null && !stored.found) ChatCopy.ERROR_THREAD_GONE else ChatCopy.ERROR_GENERIC)
            val effects = buildList {
                if (chat.session != 0L) add(ChatEffect.Clear(chat.session))
                add(ChatEffect.ReadThreads)
            }
            return ChatStep(render(gone), effects)
        }
        var next = 1L
        val messages = buildList {
            for (message in stored.messages) {
                if (message.from_member) {
                    add(
                        Msg(
                            id = next++,
                            user = true,
                            text = message.text,
                            attachments = message.attachments.mapIndexed { index, held -> pendingOf(held, index) },
                        ),
                    )
                } else if (message.text.isNotEmpty() || message.cards.isNotEmpty()) {
                    add(
                        Msg(
                            id = next++,
                            user = false,
                            text = message.text,
                            cards = message.cards.map(::storedCard),
                            stopped = message.outcome == ChatStoredOutcome.CHAT_STORED_OUTCOME_STOPPED ||
                                message.outcome == ChatStoredOutcome.CHAT_STORED_OUTCOME_REFUSED,
                            note = if (AssistNotice.ASSIST_NOTICE_DOC_TRUNCATED in message.notices) ChatCopy.NOTE_DOC_TRUNCATED else "",
                            proposal = storedProposal(message.outcome),
                        ),
                    )
                }
            }
        }
        val last = stored.messages.lastOrNull()
        val refused = last != null && !last.from_member && last.outcome == ChatStoredOutcome.CHAT_STORED_OUTCOME_REFUSED
        val asked = stored.messages.lastOrNull { it.from_member }?.text
        val opened = chat.copy(
            session = started.session_id,
            scope = started.scope_app,
            threadId = stored.thread?.thread_id ?: chat.threadId,
            threadTitle = stored.thread?.title ?: chat.threadTitle,
            opening = "",
            messages = messages,
            nextId = next,
            asked = asked,
            error = if (refused && last != null) errorLine(last.refusal) else "",
            running = false,
        )
        return ChatStep(render(opened))
    }

    /**
     * The card a stored answer draws, if any (R-1088-10). A `proposed` answer is a write no session
     * holds any more: its text is the "Proposed: …" line and its card is INERT, nothing to tap and
     * nothing run, with no id because the core has nothing by that name. The four ends need no
     * card: the vault replaced the answer's text with the line the member was told ("Done.",
     * "Not done.", "That changed since. Ask again."), and that text is what the message draws.
     */
    private fun storedProposal(outcome: ChatStoredOutcome): Proposal? =
        if (outcome == ChatStoredOutcome.CHAT_STORED_OUTCOME_PROPOSED) {
            Proposal(id = "", steps = emptyList(), phase = ProposalPhase.INERT, line = notDoneLine())
        } else {
            null
        }

    /** A stored attachment as a chip: what it was, never its bytes, and whether a retry can send it again. */
    private fun pendingOf(held: ChatStoredAttachment, index: Int): Pending {
        val source: AttachSource = when {
            held.kind == ChatStoredAttachmentKind.CHAT_STORED_ATTACHMENT_KIND_PHOTO && held.asset_id.isNotEmpty() ->
                AttachSource.VaultPhoto(held.asset_id)
            held.kind == ChatStoredAttachmentKind.CHAT_STORED_ATTACHMENT_KIND_DOCUMENT && held.document_id.isNotEmpty() ->
                AttachSource.VaultDocument(held.document_id)
            // A camera-roll image kept only its thumbnail, and a photo or a
            // document the member has since deleted is not there to send.
            else -> AttachSource.Unavailable
        }
        return Pending(
            id = index.toLong() + 1,
            photo = held.kind != ChatStoredAttachmentKind.CHAT_STORED_ATTACHMENT_KIND_DOCUMENT,
            label = held.label,
            thumbnailPath = held.thumbnail_path,
            source = source,
        )
    }

    /** Rename: the row and the header change at once; the vault is told after. */
    private fun threadRenamed(chat: Chat, id: String, title: String): ChatStep {
        val named = title.trim().replace(Regex("\\s+"), " ")
        if (id.isEmpty() || named.isEmpty()) return ChatStep(chat)
        val threads = chat.threads.map { if (it.id == id) it.copy(title = named) else it }
        val renamed = chat.copy(
            threads = threads,
            threadTitle = if (id == chat.threadId) named else chat.threadTitle,
        )
        return ChatStep(render(renamed), listOf(ChatEffect.RenameThread(id, named)))
    }

    /**
     * Delete one chat. The open one goes back to a new chat (and the core's
     * session is cleared, which unbinds it); another leaves the list at once.
     * Either way the vault is told, and the list is read again after.
     */
    private fun threadDeleted(chat: Chat, id: String): ChatStep {
        if (id.isEmpty()) return ChatStep(chat)
        if (id == chat.threadId) {
            val cleared = fresh(chat).copy(threads = chat.threads.filterNot { it.id == id })
            val effects = buildList {
                add(ChatEffect.DeleteThread(id))
                if (chat.session != 0L) {
                    add(ChatEffect.Clear(chat.session))
                    add(ChatEffect.Suggest(chat.scope, chat.session))
                }
            }
            return ChatStep(render(cleared), effects)
        }
        return ChatStep(
            render(chat.copy(threads = chat.threads.filterNot { it.id == id })),
            listOf(ChatEffect.DeleteThread(id)),
        )
    }

    /** Delete every chat in this vault. An open stored chat goes back to a new one. */
    private fun allThreadsDeleted(chat: Chat): ChatStep {
        val base = chat.copy(threads = emptyList(), drawerOpen = false)
        if (chat.threadId.isEmpty() && chat.opening.isEmpty()) {
            return ChatStep(render(base), listOf(ChatEffect.DeleteAllThreads))
        }
        val effects = buildList {
            add(ChatEffect.DeleteAllThreads)
            if (chat.session != 0L) {
                add(ChatEffect.Clear(chat.session))
                add(ChatEffect.Suggest(chat.scope, chat.session))
            }
        }
        return ChatStep(render(fresh(base)), effects)
    }

    /** `5 min ago`, `Yesterday`, `12 September`: how long ago a chat moved. Empty when the clock is unknown. */
    internal fun whenText(updatedMs: Long, nowMs: Long): String {
        if (nowMs <= 0 || updatedMs <= 0) return ""
        val minutes = ((nowMs - updatedMs) / MINUTE).coerceAtLeast(0)
        return when {
            minutes < 1 -> ChatCopy.AGO_JUST_NOW
            minutes < 60 -> ChatCopy.AGO_MINUTES.replace("{n}", "$minutes")
            minutes < 24 * 60 -> ChatCopy.AGO_HOURS.replace("{n}", "${minutes / 60}")
            minutes < 48 * 60 -> SharedCopy.YESTERDAY
            minutes < 7 * 24 * 60 -> ChatCopy.AGO_DAYS.replace("{n}", "${minutes / (24 * 60)}")
            else -> dayMonth(updatedMs)
        }
    }

    /** `12 September`, in UTC: the day an old chat last moved is a landmark and not a timestamp. */
    private fun dayMonth(epochMs: Long): String {
        // Howard Hinnant's civil-from-days, on the UTC day: no calendar library
        // in commonMain, and no zone to say which day this should be.
        val days = epochMs.floorDiv(DAY) + 719_468
        val era = days.floorDiv(146_097L)
        val dayOfEra = days - era * 146_097
        val yearOfEra = (dayOfEra - dayOfEra / 1_460 + dayOfEra / 36_524 - dayOfEra / 146_096) / 365
        val dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
        val shifted = (5 * dayOfYear + 2) / 153
        val day = dayOfYear - (153 * shifted + 2) / 5 + 1
        val month = if (shifted < 10) shifted + 3 else shifted - 9
        return "$day ${CivilWords.monthName(month.toInt())}"
    }

    // ---------------------------------------------------------- attachments --

    /** The member chose something. Only while there is a thread to attach it to. */
    private fun attached(chat: Chat, event: ChatEvent.Attached): ChatStep {
        if (!ready(chat) || chat.running) return ChatStep(chat)
        val vaultPhoto = event.vault_photo
        val libraryPhoto = event.library_photo
        val vaultDocument = event.vault_document
        val source: AttachSource = when {
            vaultPhoto != null -> AttachSource.VaultPhoto(vaultPhoto.asset_id)
            libraryPhoto != null -> AttachSource.LibraryPhoto(libraryPhoto.content, libraryPhoto.mime)
            vaultDocument != null -> AttachSource.VaultDocument(vaultDocument.doc_id)
            else -> return ChatStep(chat)
        }
        val photo = source !is AttachSource.VaultDocument
        val added = Pending(
            id = chat.nextPending,
            photo = photo,
            label = event.label,
            thumbnailPath = event.thumbnail_path,
            source = source,
        )
        // ONE PHOTO AND ONE DOCUMENT: a second of a kind replaces the first.
        val next = chat.copy(
            pending = chat.pending.filter { it.photo != photo } + added,
            nextPending = chat.nextPending + 1,
            error = "",
        )
        // A photo needs the projector: find out where it stands, unless that is
        // already known or already being settled.
        val settling = chat.vision.phase == VisionPhase.DOWNLOADING || chat.vision.phase == VisionPhase.LOADING
        if (photo && !chat.vision.ready && !settling) {
            return ChatStep(render(next), listOf(ChatEffect.ReadVision))
        }
        return ChatStep(render(next))
    }

    private fun removed(chat: Chat, id: Long): ChatStep {
        val pending = chat.pending.filter { it.id != id }
        if (pending.size == chat.pending.size) return ChatStep(chat)
        val next = chat.copy(pending = pending)
        // An offer for a reader nobody is waiting on goes away; a download in
        // flight is not interrupted by the photo that asked for it.
        val vision = if (!pending.any { it.photo } && chat.vision.phase == VisionPhase.NEEDS) {
            chat.vision.copy(phase = VisionPhase.NONE, error = "")
        } else {
            chat.vision
        }
        return ChatStep(render(next.copy(vision = vision)))
    }

    /** A photo is waiting, or a refused one is being asked again, and the reader is not on the model. */
    private fun visionBlocked(chat: Chat): Boolean =
        chat.pending.any { it.photo } && !chat.vision.ready

    /** Whether the photo reader's step has anyone to speak to. */
    private fun wantsReader(chat: Chat): Boolean =
        chat.pending.any { it.photo } || chat.error == ChatCopy.ERROR_VISION

    /** Where the projector stands: loaded, on the phone, or not. */
    internal fun visionStatus(chat: Chat, state: AssistVisionState?, bytes: Long): ChatStep {
        // Older than the download that began after it was asked.
        if (chat.vision.phase == VisionPhase.DOWNLOADING) return ChatStep(chat)
        val known = if (bytes > 0) bytes else chat.vision.bytes
        return when (state) {
            AssistVisionState.ASSIST_VISION_STATE_READY ->
                ChatStep(render(chat.copy(vision = Vision(ready = true, bytes = known), error = clearVisionError(chat))))
            AssistVisionState.ASSIST_VISION_STATE_PRESENT ->
                ChatStep(
                    render(chat.copy(vision = chat.vision.copy(phase = VisionPhase.LOADING, bytes = known, error = ""))),
                    listOf(ChatEffect.LoadVision),
                )
            else -> {
                val phase = if (wantsReader(chat)) VisionPhase.NEEDS else VisionPhase.NONE
                ChatStep(render(chat.copy(vision = chat.vision.copy(phase = phase, bytes = known, ready = false))))
            }
        }
    }

    private fun clearVisionError(chat: Chat): String =
        if (chat.error == ChatCopy.ERROR_VISION) "" else chat.error

    internal fun visionLoaded(chat: Chat, state: AssistVisionState?): ChatStep {
        if (chat.vision.phase != VisionPhase.LOADING) return ChatStep(chat)
        if (state == AssistVisionState.ASSIST_VISION_STATE_READY) {
            return ChatStep(render(chat.copy(vision = Vision(ready = true, bytes = chat.vision.bytes), error = clearVisionError(chat))))
        }
        // A projector that will not load is a projector to fetch again.
        return ChatStep(
            render(
                chat.copy(
                    vision = chat.vision.copy(
                        phase = VisionPhase.NEEDS,
                        ready = false,
                        progress = null,
                        error = ChatCopy.VISION_LOAD_FAILED,
                    ),
                ),
            ),
        )
    }

    private fun visionTapped(chat: Chat): ChatStep {
        if (chat.vision.phase != VisionPhase.NEEDS) return ChatStep(chat)
        return ChatStep(
            render(chat.copy(vision = chat.vision.copy(phase = VisionPhase.DOWNLOADING, progress = null, error = ""))),
            listOf(ChatEffect.StartVisionDownload),
        )
    }

    /** The projector's transfer reported progress (or, on a launch after a kill, is still running). */
    private fun visionProgressed(chat: Chat, event: ChatEvent.DownloadProgress): ChatStep {
        val total = event.total_bytes
        val fraction = if (total > 0) (event.done_bytes.toFloat() / total.toFloat()).coerceIn(0f, 1f) else null
        val vision = chat.vision.copy(
            phase = VisionPhase.DOWNLOADING,
            progress = fraction,
            bytes = if (total > 0) total else chat.vision.bytes,
            error = "",
        )
        return ChatStep(render(chat.copy(vision = vision)))
    }

    private fun visionFinished(chat: Chat, ok: Boolean): ChatStep {
        if (chat.vision.phase != VisionPhase.DOWNLOADING) return ChatStep(chat)
        return if (ok) {
            ChatStep(
                render(chat.copy(vision = chat.vision.copy(phase = VisionPhase.LOADING, progress = null))),
                listOf(ChatEffect.LoadVision),
            )
        } else {
            ChatStep(
                render(
                    chat.copy(
                        vision = chat.vision.copy(
                            phase = VisionPhase.NEEDS,
                            progress = null,
                            error = ChatCopy.DOWNLOAD_FAILED,
                        ),
                    ),
                ),
            )
        }
    }

    // -------------------------------------------------------------- render --

    private fun ready(chat: Chat): Boolean =
        chat.phase == ChatState.Phase.PHASE_READY && chat.session != 0L && chat.opening.isEmpty()

    private fun Chat.withAnswer(change: (Msg) -> Msg): Chat {
        val last = messages.lastOrNull() ?: return this
        if (last.user) return this
        return copy(messages = messages.dropLast(1) + change(last))
    }

    private fun card(card: AssistCard): ChatCard = ChatCard(
        app = card.app,
        entity = card.entity,
        id = card.id,
        qualifier = card.qualifier,
        title = card.title,
        subtitle = card.subtitle,
        meta = card.meta,
    )

    private fun storedCard(card: ChatStoredCard): ChatCard = ChatCard(
        app = card.app,
        entity = card.entity,
        id = card.id,
        qualifier = card.qualifier,
        title = card.title,
        subtitle = card.subtitle,
        meta = card.meta,
    )

    /**
     * The words of an answer for a screen reader: the Markdown a small model
     * writes without being asked (`**bold**`, `` `code` ``, `# heading`) is the
     * view's to draw as styling, and a reader that said "star star" would be
     * speaking the markers. List markers stay: they are how a reader hears a list.
     */
    internal fun spokenText(text: String): String =
        text.replace("**", "").replace("__", "").replace("`", "")
            .lines().joinToString("\n") { it.replaceFirst(Regex("^\\s*#{1,6}\\s+"), "") }

    /** An app id as a member reads it: `tally` is Tally. */
    internal fun appName(id: String): String = id.replaceFirstChar { it.uppercase() }

    /** `530 MB`, `1.6 GB`: decimal units, the way a download is quoted. */
    internal fun sizeText(bytes: Long): String {
        if (bytes <= 0) return ""
        return if (bytes >= GIGABYTE) {
            val tenths = (bytes * 10 + GIGABYTE / 2) / GIGABYTE
            "${tenths / 10}.${tenths % 10} GB"
        } else {
            "${maxOf(1L, (bytes + MEGABYTE / 2) / MEGABYTE)} MB"
        }
    }

    internal fun render(chat: Chat): Chat {
        val phase = chat.phase
        val ready = phase == ChatState.Phase.PHASE_READY
        val empty = chat.messages.isEmpty()
        val step = when (phase) {
            ChatState.Phase.PHASE_NEEDS_MODEL -> ChatModelStep(
                size_line = if (chat.modelBytes > 0) ChatCopy.SIZE_LINE.replace("{size}", sizeText(chat.modelBytes)) else "",
                note_line = ChatCopy.DOWNLOAD_NOTE,
                action_label = ChatCopy.DOWNLOAD_ACTION,
            )
            ChatState.Phase.PHASE_DOWNLOADING -> ChatModelStep(
                progress_known = chat.progress != null,
                progress = chat.progress ?: 0f,
                status_line = chat.progress?.let {
                    ChatCopy.DOWNLOAD_PROGRESS.replace("{percent}", "${(it * 100).toInt()}%")
                } ?: ChatCopy.DOWNLOAD_PROGRESS_UNKNOWN,
            )
            ChatState.Phase.PHASE_LOADING -> ChatModelStep(status_line = ChatCopy.LOADING)
            ChatState.Phase.PHASE_UNAVAILABLE -> ChatModelStep(status_line = ChatCopy.UNAVAILABLE)
            else -> null
        }
        val visionStep = when {
            !ready -> null
            chat.vision.phase == VisionPhase.NEEDS && wantsReader(chat) -> ChatModelStep(
                size_line = ChatCopy.VISION_LINE.replace(
                    "{size}",
                    sizeText(if (chat.vision.bytes > 0) chat.vision.bytes else ChatModelAsset.VISION_BYTES),
                ),
                action_label = ChatCopy.VISION_ACTION,
                status_line = chat.vision.error,
            )
            chat.vision.phase == VisionPhase.DOWNLOADING -> ChatModelStep(
                progress_known = chat.vision.progress != null,
                progress = chat.vision.progress ?: 0f,
                status_line = chat.vision.progress?.let {
                    ChatCopy.DOWNLOAD_PROGRESS.replace("{percent}", "${(it * 100).toInt()}%")
                } ?: ChatCopy.DOWNLOAD_PROGRESS_UNKNOWN,
            )
            chat.vision.phase == VisionPhase.LOADING -> ChatModelStep(status_line = ChatCopy.VISION_LOADING)
            else -> null
        }
        // A past chat being opened shows nothing yet: the empty chat's line and
        // suggestions would flash for the moment the stored messages are read.
        val opening = chat.opening.isNotEmpty()
        val title = chat.threads.firstOrNull { it.id == chat.threadId }?.title ?: chat.threadTitle
        return chat.copy(
            state = ChatState(
                phase = phase,
                title = title.ifEmpty { ChatCopy.NEW_CHAT },
                subtitle = if (chat.vaultName.isEmpty()) {
                    ChatCopy.SUBTITLE
                } else {
                    ChatCopy.SUBTITLE_VAULT.replace("{vault}", chat.vaultName)
                },
                scope_app = chat.scope,
                messages = if (ready) chat.messages.map(::message) else emptyList(),
                empty_line = if (ready && empty && !opening) ChatCopy.EMPTY_LINE else "",
                suggestions = if (ready && empty && !opening) chat.suggestions else emptyList(),
                streaming = ready && chat.running,
                activity = if (ready && chat.running) chat.activity else "",
                error = chat.error,
                model_step = step,
                composer_placeholder = ChatCopy.COMPOSER_PLACEHOLDER,
                send_label = ChatCopy.SEND,
                stop_label = ChatCopy.STOP,
                new_chat_label = ChatCopy.NEW_CHAT,
                retry_label = ChatCopy.RETRY,
                copy_label = ChatCopy.COPY,
                can_retry = ready && !chat.running && chat.asked != null && !empty && !retryLosesAnAttachment(chat),
                can_new_chat = ready && (!empty || chat.threadId.isNotEmpty()),
                pending = if (ready) chat.pending.map(::attachment) else emptyList(),
                can_attach = ready && !chat.running,
                attach_label = ChatCopy.ATTACH,
                attach_vault_photo_label = ChatCopy.ATTACH_VAULT_PHOTO,
                attach_library_photo_label = ChatCopy.ATTACH_LIBRARY_PHOTO,
                attach_document_label = ChatCopy.ATTACH_DOCUMENT,
                remove_attachment_label = ChatCopy.REMOVE_ATTACHMENT,
                vision_step = visionStep,
                vision_blocked = ready && visionBlocked(chat),
                drawer_open = chat.drawerOpen,
                threads = chat.threads.map { row -> threadItem(row, chat) },
                threads_empty_line = if (chat.threads.isEmpty()) ChatCopy.THREADS_EMPTY else "",
                thread_id = chat.threadId,
                can_manage_thread = chat.threadId.isNotEmpty() && !chat.running && !opening,
                drawer_label = ChatCopy.DRAWER_LABEL,
                menu_label = ChatCopy.MENU_LABEL,
                rename_label = ChatCopy.RENAME,
                delete_label = ChatCopy.DELETE,
                delete_all_label = ChatCopy.DELETE_ALL,
                cancel_label = ChatCopy.CANCEL,
                save_label = ChatCopy.SAVE,
                rename_title = ChatCopy.RENAME_TITLE,
                delete_title = ChatCopy.DELETE_TITLE,
                delete_body = ChatCopy.DELETE_BODY,
                delete_all_title = ChatCopy.DELETE_ALL_TITLE,
                delete_all_body = ChatCopy.DELETE_ALL_BODY,
                card_gone_line = ChatCopy.CARD_GONE,
                current_label = ChatCopy.CURRENT_CHAT,
            ),
        )
    }

    /**
     * A Retry sends the last question's attachments again, and a stored one that
     * cannot be sent (a camera-roll image kept only as a thumbnail, a photo
     * since deleted) would be dropped from the answer without a word. So the
     * question can be asked again only when everything it carried still can.
     */
    private fun retryLosesAnAttachment(chat: Chat): Boolean =
        chat.messages.lastOrNull { it.user }?.attachments?.any { it.source is AttachSource.Unavailable } == true

    private fun threadItem(row: ThreadRow, chat: Chat): ChatThreadItem {
        val current = row.id == chat.threadId
        val said = whenText(row.updatedMs, chat.now)
        return ChatThreadItem(
            thread_id = row.id,
            title = row.title,
            ago = said,
            current = current,
            accessibility_label = listOf(row.title, said, if (current) ChatCopy.CURRENT_CHAT else "")
                .filter { it.isNotEmpty() }
                .joinToString(", "),
        )
    }

    private fun attachment(pending: Pending): ChatAttachment = ChatAttachment(
        id = pending.id,
        kind = if (pending.photo) ChatAttachment.Kind.KIND_PHOTO else ChatAttachment.Kind.KIND_DOCUMENT,
        label = pending.label.ifEmpty { if (pending.photo) ChatCopy.CHIP_PHOTO else ChatCopy.CHIP_DOCUMENT },
        thumbnail_path = pending.thumbnailPath,
    )

    /** A parked write, as the card the view draws. The labels are the copy's: the view owns no word. */
    private fun proposalCard(proposal: Proposal): ChatPending {
        val more = if (proposal.more > 0) ChatCopy.MORE_STEPS.replace("{n}", "${proposal.more}") else ""
        return ChatPending(
            pending_id = proposal.id,
            state = when (proposal.phase) {
                ProposalPhase.WAITING -> ChatPending.State.STATE_WAITING
                ProposalPhase.WORKING -> ChatPending.State.STATE_WORKING
                ProposalPhase.APPLIED -> ChatPending.State.STATE_APPLIED
                ProposalPhase.NOT_DONE -> ChatPending.State.STATE_NOT_DONE
                ProposalPhase.STALE -> ChatPending.State.STATE_STALE
                ProposalPhase.INERT -> ChatPending.State.STATE_INERT
            },
            steps = proposal.steps.map { ChatPendingStep(summary = it.summary, destructive = it.destructive) },
            more_line = more,
            confirm_label = ChatCopy.CONFIRM,
            cancel_label = ChatCopy.CANCEL,
            destructive = proposal.destructive,
            settled_line = proposal.line,
            accessibility_label = buildList {
                add(ChatCopy.A11Y_PROPOSAL)
                if (proposal.destructive) add(ChatCopy.A11Y_DESTRUCTIVE)
                addAll(proposal.steps.map { it.summary })
                if (more.isNotEmpty()) add(more)
                if (proposal.line.isNotEmpty()) add(proposal.line)
            }.joinToString(". "),
        )
    }

    private fun message(message: Msg): ChatMessage = ChatMessage(
        id = message.id,
        role = if (message.user) ChatMessage.Role.ROLE_USER else ChatMessage.Role.ROLE_ASSISTANT,
        text = message.text,
        cards = message.cards,
        streaming = message.streaming,
        stopped = message.stopped,
        attachments = message.attachments.map(::attachment),
        note = message.note,
        pending = message.proposal?.let(::proposalCard),
        accessibility_label = buildString {
            append(if (message.user) ChatCopy.A11Y_YOU else ChatCopy.A11Y_ANSWER)
            if (message.text.isNotEmpty()) append(": ").append(spokenText(message.text))
            for (attached in message.attachments) {
                append(". ").append(ChatCopy.A11Y_ATTACHED).append(": ")
                append(attached.label.ifEmpty { if (attached.photo) ChatCopy.CHIP_PHOTO else ChatCopy.CHIP_DOCUMENT })
            }
            if (message.stopped) append(". ").append(ChatCopy.STOPPED)
        },
    )

    private const val MINUTE: Long = 60_000
    private const val DAY: Long = 86_400_000
    private const val MEGABYTE: Long = 1_000_000
    private const val GIGABYTE: Long = 1_000_000_000
}

/** One message in the transcript, as the machine holds it. */
public data class Msg(
    public val id: Long,
    public val user: Boolean,
    public val text: String = "",
    public val cards: List<ChatCard> = emptyList(),
    public val streaming: Boolean = false,
    public val stopped: Boolean = false,
    /** What the member attached to this question: shown as chips, never as bytes. */
    public val attachments: List<Pending> = emptyList(),
    /** One line beside an answer (a document was cut), or empty. */
    public val note: String = "",
    /** The write this answer proposes, until the thread is left. */
    public val proposal: Proposal? = null,
)

/** Where a proposed write stands. It moves forward once and never back, except WORKING to WAITING when the call failed. */
public enum class ProposalPhase { WAITING, WORKING, APPLIED, NOT_DONE, STALE, INERT }

/** One line of a proposed write, as the core composed it. */
public data class ProposalStep(public val summary: String, public val destructive: Boolean)

/** A write the model proposed and the core parked, waiting on the member's tap. */
public data class Proposal(
    /** What the core named it by; what a confirm or a cancel names. */
    public val id: String,
    public val steps: List<ProposalStep>,
    /** Rows the write changes beyond [steps]. */
    public val more: Int = 0,
    public val destructive: Boolean = false,
    public val phase: ProposalPhase = ProposalPhase.WAITING,
    /** How it ended, once it has. */
    public val line: String = "",
)

/** Where an attachment comes from. What the core is handed, by name or by bytes. */
public sealed interface AttachSource {
    public data class VaultPhoto(public val assetId: String) : AttachSource

    /** JPEG or PNG bytes a shell picked; HEIC is converted by the shell first. */
    public data class LibraryPhoto(public val bytes: ByteString, public val mime: String) : AttachSource

    public data class VaultDocument(public val docId: String) : AttachSource

    /**
     * A stored attachment that cannot be sent again: a camera-roll image kept
     * only as a thumbnail, or a vault photo or document since deleted. It is
     * drawn as the chip it was and never handed to the core.
     */
    public data object Unavailable : AttachSource
}

/** One attachment, from the moment it waits in the composer until the chat is cleared. */
public data class Pending(
    /** Minted by the machine; what a remove names. */
    public val id: Long,
    public val photo: Boolean,
    public val label: String,
    public val thumbnailPath: String,
    public val source: AttachSource,
)

/** The photo reader's own steps: the second download, which is not the model's phase. */
public enum class VisionPhase { NONE, NEEDS, DOWNLOADING, LOADING }

/** Whether the loaded model can read a photo, and the step on the way there. */
public data class Vision(
    public val phase: VisionPhase = VisionPhase.NONE,
    /** The loaded model carries the projector. */
    public val ready: Boolean = false,
    public val bytes: Long = 0,
    public val progress: Float? = null,
    public val error: String = "",
) {
    /** A model that was unloaded took its projector with it. */
    public fun unloaded(): Vision = Vision(bytes = bytes)
}

/**
 * The machine's model: everything the chat knows, with [state] the finished
 * message the view draws.
 */
public data class Chat(
    public val phase: ChatState.Phase = ChatState.Phase.PHASE_CHECKING,
    /** The app the chat was opened from, or empty. */
    public val scope: String = "",
    /** Whether a tab has opened this chat at all. */
    public val opened: Boolean = false,
    public val modelBytes: Long = 0,
    /** The core's session id, 0 until it has started one. */
    public val session: Long = 0,
    /** The last turn id minted; the running turn's, while [running]. */
    public val turn: Long = 0,
    public val nextId: Long = 1,
    public val messages: List<Msg> = emptyList(),
    public val suggestions: List<String> = emptyList(),
    public val running: Boolean = false,
    public val activity: String = "",
    public val error: String = "",
    /** 0.0 to 1.0, or null while the size is not known. */
    public val progress: Float? = null,
    /** The last question put to the core, for Retry. */
    public val asked: String? = null,
    /** What waits in the composer. */
    public val pending: List<Pending> = emptyList(),
    public val nextPending: Long = 1,
    /** The last turn's attachments, asked again by Retry. */
    public val lastSent: List<Pending> = emptyList(),
    public val vision: Vision = Vision(),
    /** The foreground vault's name, for the header. */
    public val vaultName: String = "",
    /** The stored thread this chat is saved in, or empty until a turn has been saved. */
    public val threadId: String = "",
    /** That thread's title as last told; the list's row wins when it has one. */
    public val threadTitle: String = "",
    /** The thread being opened from the drawer, until its messages arrive. */
    public val opening: String = "",
    public val drawerOpen: Boolean = false,
    /** The drawer's list, newest first. */
    public val threads: List<ThreadRow> = emptyList(),
    /** The device clock at the last read of [threads], for "5 min ago". */
    public val now: Long = 0,
    public val state: ChatState = ChatState(),
)

/** One past chat, as the drawer's read answered it. */
public data class ThreadRow(
    public val id: String,
    public val title: String,
    /** When it last moved, in epoch milliseconds. */
    public val updatedMs: Long,
)

public sealed interface ChatInput {
    /** The shell's intent. */
    public data class View(public val event: ChatEvent) : ChatInput

    /** The core's answer about the model file; null when it would not answer. */
    public data class Status(public val state: AssistModelState?) : ChatInput

    /** The core's answer to a load; null when it was refused. */
    public data class Loaded(public val state: AssistModelState?) : ChatInput

    /** A session the core opened; null when it refused. */
    public data class Started(public val session: Long?) : ChatInput

    /** The questions this vault can answer, for the chat opened on [session]. */
    public data class Suggested(public val session: Long, public val prompts: List<String>) : ChatInput

    /** One event of a running turn, as the core streamed it. */
    public data class Core(public val event: AssistEvent) : ChatInput

    /** `send` returned. Null means the call itself failed. */
    public data class Settled(public val turn: Long, public val sent: AssistSent?) : ChatInput

    /** The core's answer about the vision projector; null state when it would not answer. */
    public data class VisionStatus(public val state: AssistVisionState?, public val bytes: Long) : ChatInput

    /** The core's answer to loading the projector; null when it was refused. */
    public data class VisionLoaded(public val state: AssistVisionState?) : ChatInput

    /** The core's answer to a confirm tap on card [pendingId]; null when the call itself failed. */
    public data class Confirmed(public val pendingId: String, public val settled: AssistSettled?) : ChatInput

    /** The drawer's list, read; null rows when the core would not answer. [nowMs] is the device clock. */
    public data class Threads(public val rows: List<ThreadRow>?, public val nowMs: Long) : ChatInput

    /**
     * A past chat, read, and the session the core rebuilt from it — together, so
     * the messages on screen and the session that continues them cannot
     * disagree. [thread] is null when the read failed and [started] when the
     * core refused the session; [requested] is the thread that was asked for.
     */
    public data class ThreadOpened(
        public val requested: String,
        public val thread: ChatThread?,
        public val started: AssistStarted?,
    ) : ChatInput
}

/** What the runner does on the machine's behalf. */
public sealed interface ChatEffect {
    public data object ReadStatus : ChatEffect

    public data object Load : ChatEffect

    /** Ask the shell to start its model download. Progress comes back as events. */
    public data object StartDownload : ChatEffect

    public data class Start(public val app: String) : ChatEffect

    public data class Suggest(public val app: String, public val session: Long) : ChatEffect

    public data class Send(
        public val session: Long,
        public val turn: Long,
        public val text: String,
        public val regenerate: Boolean,
        public val attachments: List<Pending> = emptyList(),
    ) : ChatEffect

    /** Where the projector stands. */
    public data object ReadVision : ChatEffect

    /** Give the loaded model the projector. */
    public data object LoadVision : ChatEffect

    /** Ask the shell to start its projector download. Progress comes back as events. */
    public data object StartVisionDownload : ChatEffect

    public data class Cancel(public val session: Long) : ChatEffect

    /** Ask the core to run the parked write [pendingId] names. Its answer returns as [ChatInput.Confirmed]. */
    public data class Confirm(public val session: Long, public val pendingId: String) : ChatEffect

    /** Tell the core the member cancelled [pendingId]. Nothing is written and nothing comes back. */
    public data class Dismiss(public val session: Long, public val pendingId: String) : ChatEffect

    public data class Clear(public val session: Long) : ChatEffect

    public data class Copy(public val text: String) : ChatEffect

    /** Read the drawer's list. */
    public data object ReadThreads : ChatEffect

    /** Read a stored thread and ask the core for a session rebuilt from it. */
    public data class OpenThread(public val threadId: String) : ChatEffect

    public data class RenameThread(public val threadId: String, public val title: String) : ChatEffect

    public data class DeleteThread(public val threadId: String) : ChatEffect

    public data object DeleteAllThreads : ChatEffect
}

public data class ChatStep(public val chat: Chat, public val effects: List<ChatEffect> = emptyList())
