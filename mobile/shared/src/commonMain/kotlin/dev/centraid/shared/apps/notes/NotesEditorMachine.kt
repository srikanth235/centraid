package dev.centraid.shared.apps.notes

import centraid.screen.v1.Autosave
import centraid.screen.v1.Loading
import centraid.screen.v1.NoteDraft
import centraid.screen.v1.NotesEditorChrome
import centraid.screen.v1.NotesEditorEvent
import centraid.screen.v1.NotesEditorState
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.SeatState
import dev.centraid.design.copy.NotesCopy
import dev.centraid.shared.kit.AutosaveLaw
import dev.centraid.shared.kit.AutosaveLens
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step

/**
 * The Notes editor (#1020, D-1020-E3), autosaving (#1015 D3: close = done).
 *
 * The editor is the screen where the read law and the WRITE law are different
 * laws, and keeping them apart is most of this file: a failed READ replaces the
 * editor, a failed SAVE does not. A member whose save was refused still has
 * their words on the screen, and an editor that swapped them for an error
 * message would have thrown away the only copy.
 *
 * The save itself is the kit's [AutosaveLaw]: an edit schedules a save 900 ms
 * later, a pin saves at once, leaving saves whatever is unsaved, each save is
 * one command under one key per edit, only changed fields are sent, and a
 * change from the vault never replaces words being typed.
 */
public object NotesEditorMachine : ScreenMachine<NotesEditorState, NotesEditorEvent> {
    public const val SCREEN_ID: String = "notes.editor"

    override fun initial(): NotesEditorState = NotesEditorState(
        loading = Loading(first_load = true),
        save = NotesEditorState.SaveState.SAVE_STATE_CLEAN,
        autosave = Autosave(phase = Autosave.Phase.PHASE_CLEAN),
    )

    override fun reduce(state: NotesEditorState, event: NotesEditorEvent): Step<NotesEditorState> =
        project(step(state, event))

    private fun step(state: NotesEditorState, event: NotesEditorEvent): Step<NotesEditorState> =
        when {
            // A NEW NOTE IS NOT READ: nothing is in the vault under its id
            // yet, and a read would answer "could not find this note". It opens
            // on an empty draft, and its first save creates it.
            event.opened != null && event.opened.is_new -> {
                val opened = AutosaveLaw.opened(
                    Lens,
                    closeLink(state.copy(note_id = event.opened.note_id, is_new = true)),
                ).state
                val empty = NoteDraft(format = NoteDraft.Format.FORMAT_MARKDOWN)
                Step(AutosaveLaw.loaded(Lens, opened, empty, "").state)
            }

            event.opened != null ->
                AutosaveLaw.opened(Lens, closeLink(state.copy(note_id = event.opened.note_id, is_new = false)))

            // Not in the vault yet: there is nothing of it to re-read.
            event.rows_changed != null && state.is_new -> Step(state)

            event.data_ != null -> {
                val draft = event.data_.draft
                if (draft == null) Step(state) else AutosaveLaw.loaded(Lens, state, draft, draft.base_revision_id)
            }

            // A CHANGE NEVER TAKES A MEMBER'S TYPING. Unsaved words or a save
            // in flight: `remote_changed`, no read. An EMPTY id list is "re-read
            // the table" — the core sends one for every local commit, this
            // editor's own saves included — so it is this note too.
            event.rows_changed != null -> AutosaveLaw.rowsChanged(Lens, state, event.rows_changed.note_ids)

            // A FAILED READ REPLACES THE EDITOR. There is nothing to edit: the
            // body never arrived.
            event.refused != null -> Step(
                Lens.with(state, ReadContent.Failed(event.refused.failure ?: Reads.refused(""))),
            )

            event.title != null -> AutosaveLaw.edited(Lens, state) { it.copy(title = event.title.title) }

            // A BODY NOT ON THIS DEVICE IS READ-ONLY (the owner's ruling,
            // superseding R-NOTES-2): typing over words the member cannot see
            // would replace them unseen. The title and the pin still save.
            event.body != null -> {
                val draft = state.draft
                if (draft == null || draft.body_unavailable) {
                    Step(state)
                } else {
                    val edited = AutosaveLaw.edited(Lens, state) { it.copy(body = event.body.body) }
                    Step(openLinkOnBrackets(edited.state, draft.body, event.body.body), edited.effects)
                }
            }

            // THE POWERBOX. The link button opens it at the caret; a pick
            // lands `[[title]]` there (replacing a typed `[[`) and saves like
            // any edit.
            event.link_requested != null -> {
                val draft = state.draft
                if (draft == null || draft.body_unavailable) {
                    Step(state)
                } else {
                    Step(
                        state.copy(
                            link_sheet_open = true,
                            link_anchor = minOf(event.link_requested.caret, draft.body.length),
                            link_replaces = false,
                        ),
                    )
                }
            }

            event.link_picked != null -> {
                val target = event.link_picked.target
                val draft = state.draft
                if (!state.link_sheet_open || target == null || draft == null || draft.body_unavailable) {
                    Step(closeLink(state))
                } else {
                    val body = spliceLink(draft.body, state.link_anchor, state.link_replaces, target.title)
                    AutosaveLaw.edited(Lens, closeLink(state)) { it.copy(body = body) }
                }
            }

            event.link_dismissed != null -> Step(closeLink(state))

            // A PIN IS A CHOICE, NOT TYPING: it saves at once.
            event.pin != null -> {
                val edited = AutosaveLaw.edited(Lens, state) { it.copy(pinned = !it.pinned) }
                val flushed = AutosaveLaw.flush(Lens, edited.state)
                // The debounce the edit scheduled is dropped: the flush is it.
                Step(flushed.state, flushed.effects)
            }

            // SAVE NOW. What the native Save button sends until K5 removes it,
            // and what leaving sends (close = done).
            event.save != null || event.left != null -> AutosaveLaw.flush(Lens, state)

            event.tick != null -> AutosaveLaw.tick(Lens, state, event.tick.token)

            // THE CREATE COMMITTED: the note exists, and every later save is
            // an edit of it.
            event.write_settled != null -> {
                val creating = state.is_new && event.write_settled.committed &&
                    event.write_settled.invoke_key == state.autosave?.invoke_key
                val settled = AutosaveLaw.settled(Lens, state, event.write_settled)
                if (creating) Step(settled.state.copy(is_new = false), settled.effects) else settled
            }

            event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))

            else -> Step(state)
        }

    override fun ticked(token: String): NotesEditorEvent = NotesEditorEvent(tick = NotesEditorEvent.Ticked(token = token))

    override fun left(): NotesEditorEvent = NotesEditorEvent(left = NotesEditorEvent.Left())

    /**
     * `save` IS `autosave`, AS THE VIEWS STILL READ IT (until K5): written
     * here from the one source and never read by this machine. The refusal's
     * sentence rides the draft's `save_failure` for the same views.
     */
    private fun project(step: Step<NotesEditorState>): Step<NotesEditorState> {
        val created = asCreate(step)
        val state = decorate(created.state)
        val autosave = state.autosave ?: return Step(state, created.effects)
        val save = when (autosave.phase) {
            Autosave.Phase.PHASE_DIRTY -> NotesEditorState.SaveState.SAVE_STATE_DIRTY
            Autosave.Phase.PHASE_SAVING -> NotesEditorState.SaveState.SAVE_STATE_SAVING
            Autosave.Phase.PHASE_REFUSED -> NotesEditorState.SaveState.SAVE_STATE_REFUSED
            else -> NotesEditorState.SaveState.SAVE_STATE_CLEAN
        }
        val draft = state.draft?.let { d ->
            val failure = if (autosave.phase == Autosave.Phase.PHASE_REFUSED) autosave.failure else null
            if (d.save_failure == failure) d else d.copy(save_failure = failure)
        }
        return Step(state.copy(save = save, draft = draft), created.effects)
    }

    /**
     * A NEW NOTE'S FIRST SAVE IS A CREATE. The kit's law submits the lens'
     * one command; while the note is new, that submit is rewritten into
     * `knowledge.create_note` under the phone-minted id, with the whole draft
     * (a create has no baseline to measure changes against), and its key is
     * the create's.
     */
    private fun asCreate(step: Step<NotesEditorState>): Step<NotesEditorState> {
        val state = step.state
        if (!state.is_new) return step
        val draft = state.sending ?: state.draft ?: return step
        var rewritten = state
        val effects = step.effects.map { effect ->
            if (effect is ScreenEffect.SubmitWrite && effect.command == SAVE_COMMAND) {
                val key = CREATE_COMMAND + effect.invokeKey.removePrefix(SAVE_COMMAND)
                rewritten = rewritten.copy(autosave = rewritten.autosave?.copy(invoke_key = key))
                ScreenEffect.SubmitWrite(command = CREATE_COMMAND, inputJson = createInput(state.note_id, draft), invokeKey = key)
            } else {
                effect
            }
        }
        return Step(rewritten, effects)
    }

    /** What a view draws that is not the draft: the chrome and the body's lock. */
    private fun decorate(state: NotesEditorState): NotesEditorState {
        val autosave = state.autosave
        val draft = state.draft
        val status = when (autosave?.phase) {
            Autosave.Phase.PHASE_SAVING -> NotesCopy.SAVING
            Autosave.Phase.PHASE_SAVED -> NotesCopy.SAVED
            Autosave.Phase.PHASE_REFUSED -> autosave.failure?.sentence ?: ""
            else -> ""
        }
        val untouched = autosave == null || autosave.phase == Autosave.Phase.PHASE_CLEAN
        return state.copy(
            body_editable = draft != null && !draft.body_unavailable,
            body_notice = if (draft?.body_unavailable == true) NotesCopy.BODY_NOT_HERE else "",
            chrome = NotesEditorChrome(
                // #1015 D3: "Cancel" only before the first keystroke; after
                // it, close = done.
                close = if (untouched) NotesCopy.CANCEL else NotesCopy.DONE,
                title_placeholder = NotesCopy.TITLE_PLACEHOLDER,
                body_placeholder = NotesCopy.BODY_PLACEHOLDER,
                pin_label = if (draft?.pinned == true) NotesCopy.UNPIN else NotesCopy.PIN,
                history_label = NotesCopy.HISTORY_TITLE,
                send_to_tasks_label = NotesCopy.SEND_TO_TASKS,
                link_label = NotesCopy.LINK_LABEL,
                status = status,
                history_enabled = !state.is_new && draft != null,
                title = if (state.is_new) NotesCopy.NEW_NOTE else NotesCopy.NOTE_TITLE,
                menu_label = NotesCopy.ROW_MENU,
            ),
        )
    }

    private fun closeLink(state: NotesEditorState): NotesEditorState =
        state.copy(link_sheet_open = false, link_anchor = 0, link_replaces = false)

    /**
     * `[[` JUST TYPED opens the powerbox there. Measured against the body
     * before the edit, so a `[[` already in the note never reopens it.
     */
    internal fun openLinkOnBrackets(state: NotesEditorState, before: String, after: String): NotesEditorState {
        if (after.length <= before.length || countOf(after) <= countOf(before)) return state
        val common = before.zip(after).takeWhile { (a, b) -> a == b }.size
        val anchor = after.indexOf(BRACKETS, maxOf(0, common - 1))
        if (anchor < 0) return state
        return state.copy(link_sheet_open = true, link_anchor = anchor, link_replaces = true)
    }

    private fun countOf(body: String): Int = body.windowed(2).count { it == BRACKETS }

    /** `[[title]]` at [anchor], replacing a typed `[[` there when [replaces]. */
    internal fun spliceLink(body: String, anchor: Int, replaces: Boolean, title: String): String {
        val at = anchor.coerceIn(0, body.length)
        val link = "[[${title.ifBlank { NotesCopy.UNTITLED }}]]"
        val tail = if (replaces && body.startsWith(BRACKETS, at)) at + BRACKETS.length else at
        return body.substring(0, at) + link + body.substring(tail)
    }

    private const val BRACKETS: String = "[["

    /** A new note, whole: its minted id, a title (derived when blank), the body. */
    internal fun createInput(noteId: String, draft: NoteDraft): String {
        val title = draft.title.trim().ifEmpty { firstLine(draft.body) }
        return "{\"note_id\":${jsonString(noteId)},\"title\":${jsonString(title)}," +
            "\"body_text\":${jsonString(draft.body)},\"format\":\"markdown\"}"
    }

    /** The command a new note's first save is. */
    public const val CREATE_COMMAND: String = "knowledge.create_note"

    /** The editor's parts, for the kit's autosave law. */
    internal object Lens : AutosaveLens<NotesEditorState, NoteDraft> {
        override val screenId: String = SCREEN_ID
        override val command: String = SAVE_COMMAND

        override fun subjectId(state: NotesEditorState): String = state.note_id

        override fun content(state: NotesEditorState): ReadContent<NoteDraft> = when {
            state.draft != null -> ReadContent.Data(state.draft)
            state.failure != null -> ReadContent.Failed(state.failure)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: NotesEditorState, content: ReadContent<NoteDraft>): NotesEditorState =
            when (content) {
                is ReadContent.Loading -> state.copy(
                    loading = Loading(first_load = content.firstLoad),
                    failure = null,
                    draft = null,
                )
                is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, draft = null)
                is ReadContent.Denied -> state.copy(
                    loading = null,
                    failure = Reads.refused(content.denied.body.ifEmpty { content.denied.title }),
                    draft = null,
                )
                is ReadContent.Data -> state.copy(loading = null, failure = null, draft = content.data)
            }

        override fun autosave(state: NotesEditorState): Autosave = state.autosave ?: Autosave()

        override fun withAutosave(state: NotesEditorState, autosave: Autosave): NotesEditorState =
            state.copy(autosave = autosave)

        override fun baseline(state: NotesEditorState): NoteDraft? = state.baseline

        override fun withBaseline(state: NotesEditorState, baseline: NoteDraft?): NotesEditorState =
            state.copy(baseline = baseline)

        override fun sending(state: NotesEditorState): NoteDraft? = state.sending

        override fun withSending(state: NotesEditorState, sending: NoteDraft?): NotesEditorState =
            state.copy(sending = sending)

        override fun input(state: NotesEditorState, draft: NoteDraft, baseline: NoteDraft?): String? =
            saveInput(state.note_id, draft, baseline)

        /**
         * A NEW NOTE NEEDS A NAME: `create_note` requires a `title`, and an
         * empty one is derived from the body's first line — so a note with
         * neither is not yet a note. A body cleared to nothing is SAVED:
         * `body_text` takes an empty string (`minLength: 0`).
         */
        override fun refusal(state: NotesEditorState, draft: NoteDraft, baseline: NoteDraft?): ReadFailure? =
            if (state.is_new && draft.title.isBlank() && firstLine(draft.body).isEmpty()) {
                Reads.refused(NotesCopy.WRITE_A_LINE)
            } else {
                null
            }
    }

    /**
     * THE COMMAND THE VAULT ACTUALLY HAS (#1025 S5).
     *
     * This said `knowledge.save_note`, and there is no such command. The
     * registry has `create_note`, `edit_note`, `move_note`, `delete_note`,
     * `restore_note` and the notebook verbs. `Vault::execute` answered
     * `UnknownCommand`, `crates/core` mapped it to `ERROR_CODE_INVALID_REQUEST`,
     * and the member read "That request does not make sense to this build" —
     * **on every window, for ever**, because the seat retried a write that could
     * never succeed.
     *
     * Nothing caught it because nothing in the product had ever submitted a
     * write: the machine's only exercise was a unit test asserting the effect it
     * emitted, and an effect naming a command nobody runs looks exactly like one
     * naming a command that exists. It took a device and a real gateway.
     */
    public const val SAVE_COMMAND: String = "knowledge.edit_note"

    /**
     * The command's input, as JSON: `note_id` and ONLY THE FIELDS THAT CHANGED
     * against [baseline] — or null when none did.
     *
     * `knowledge.edit_note`'s schema is `additionalProperties: false`, and an
     * ABSENT field is "leave it alone", which is load-bearing here:
     *
     * * **`body_text`, never `body`** — an empty one included: a body cleared
     *   to nothing is the member's words (`minLength: 0`). A body this seat has
     *   not copied (`body_unavailable`) is never sent, which is what lets a
     *   title or pin save without blanking the note (R-NOTES-2/3).
     * * **An empty title is DERIVED from the body's first line**, because
     *   `title` is `minLength: 1` too and a note with no title is still a note
     *   a member means to keep. The draft keeps its empty title; the vault gets
     *   the derived one. No first line, no title sent.
     * * **`base_revision_id` is not an input.** There is no vault-side
     *   revision check: the last save on this phone wins.
     * * `pinned` is 0 or 1 — SQLite has no boolean.
     *
     * Hand-built: `commonMain` carries no JSON library, and the escaping is the
     * only hard part ([jsonString]).
     */
    internal fun saveInput(noteId: String, draft: NoteDraft, baseline: NoteDraft?): String? {
        val fields = mutableListOf<String>()
        val bodyChanged = draft.body != (baseline?.body ?: "") && !draft.body_unavailable
        val title = draft.title.ifBlank { firstLine(draft.body) }
        val titleChanged = draft.title != baseline?.title || (draft.title.isBlank() && bodyChanged)
        if (titleChanged && title.isNotEmpty()) fields += "\"title\":${jsonString(title)}"
        if (bodyChanged) fields += "\"body_text\":${jsonString(draft.body)}"
        if (draft.pinned != baseline?.pinned) fields += "\"pinned\":${if (draft.pinned) 1 else 0}"
        if (fields.isEmpty()) return null
        return (listOf("\"note_id\":${jsonString(noteId)}") + fields)
            .joinToString(",", prefix = "{", postfix = "}")
    }

    /** The first non-blank line of [body], trimmed, at most [TITLE_FROM_BODY] characters. */
    internal fun firstLine(body: String): String =
        body.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() }?.take(TITLE_FROM_BODY) ?: ""

    private const val TITLE_FROM_BODY: Int = 80

    internal fun jsonString(value: String): String = dev.centraid.shared.kit.jsonString(value)

    /**
     * `knowledge_note`. Whether the editor acts on it is [reduce]'s decision:
     * see the `rows_changed` case, which refuses to replace a dirty draft.
     */
    override fun rowsChanged(
        table: String,
        keys: List<String>,
    ): NotesEditorEvent? = if (table == TABLE) {
        NotesEditorEvent(rows_changed = NotesEditorEvent.RowsChanged(note_ids = keys))
    } else {
        null
    }

    private const val TABLE: String = "knowledge_note"

    override fun seatChanged(seat: SeatState): NotesEditorEvent = NotesEditorEvent(seat_changed = NotesEditorEvent.SeatChanged(seat = seat))
}
