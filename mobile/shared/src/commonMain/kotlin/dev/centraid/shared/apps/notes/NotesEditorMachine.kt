package dev.centraid.shared.apps.notes

import centraid.screen.v1.SeatState
import centraid.screen.v1.Loading
import centraid.screen.v1.NotesEditorEvent
import centraid.screen.v1.NotesEditorState
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step

/**
 * The Notes editor (#1020, D-1020-E3).
 *
 * The editor is the screen where the read law and the WRITE law are different
 * laws, and keeping them apart is most of this file: a failed READ replaces the
 * editor, a failed SAVE does not. A member whose save was refused still has
 * their words on the screen, and an editor that swapped them for an error
 * message would have thrown away the only copy.
 */
public object NotesEditorMachine : ScreenMachine<NotesEditorState, NotesEditorEvent> {
    public const val SCREEN_ID: String = "notes.editor"

    override fun initial(): NotesEditorState = NotesEditorState(
        loading = Loading(first_load = true),
        save = NotesEditorState.SaveState.SAVE_STATE_CLEAN,
    )

    override fun reduce(state: NotesEditorState, event: NotesEditorEvent): Step<NotesEditorState> =
        when {
            event.opened != null -> Step(
                state.copy(
                    note_id = event.opened.note_id,
                    loading = Loading(first_load = true),
                    failure = null,
                    draft = null,
                    save = NotesEditorState.SaveState.SAVE_STATE_CLEAN,
                ),
                listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)),
            )

            event.data_ != null -> Step(
                state.copy(
                    loading = null,
                    failure = null,
                    draft = event.data_.draft,
                    save = NotesEditorState.SaveState.SAVE_STATE_CLEAN,
                ),
            )

            // A CHANGE FROM THE GATEWAY NEVER TAKES A MEMBER'S TYPING.
            //
            // The event is delivered whatever the editor is doing, and the
            // decision is HERE because only this machine knows whether there is
            // an unsaved draft. A re-read while `save` is dirty would replace
            // the paragraph being typed with the copy that arrived, which is
            // the one outcome no member forgives; a saving draft is the same
            // case, because its own commit is the change coming back.
            event.rows_changed != null ->
                if (state.note_id !in event.rows_changed.note_ids ||
                    state.save != NotesEditorState.SaveState.SAVE_STATE_CLEAN
                ) {
                    Step(state)
                } else {
                    Step(state, listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)))
                }

            // A FAILED READ REPLACES THE EDITOR. There is nothing to edit: the
            // body never arrived.
            event.refused != null -> Step(
                state.copy(
                    loading = null,
                    draft = null,
                    failure = event.refused.failure,
                ),
            )

            // AN EDIT NEVER WRITES. No autosave-per-keystroke: every keystroke
            // would be a command with its own `invoke_key`, an audit receipt and
            // a replica round trip, and a member typing a paragraph would fill
            // their outbox with a hundred revisions of one note.
            event.title != null -> edited(state) { it.copy(title = event.title.title) }

            // R-NOTES-2: a member who typed a body is saving their words. Clear
            // the unavailable flag so `saveInput` includes `body_text`.
            event.body != null -> edited(state) { draft ->
                draft.copy(
                    body = event.body.body,
                    body_unavailable = draft.body_unavailable && event.body.body.isEmpty(),
                )
            }

            event.pin != null -> edited(state) { it.copy(pinned = !it.pinned) }

            event.save != null -> {
                val draft = state.draft
                if (draft != null &&
                    draft.body_unavailable &&
                    draft.body.isEmpty() &&
                    state.save != NotesEditorState.SaveState.SAVE_STATE_DIRTY
                ) {
                    // R-NOTES-2: refuse ONLY when empty AND unavailable, with
                    // no member edit queued. A title/pin-only dirty draft still
                    // queues (omit `body_text`); a typed body cleared the flag
                    // above. A pristine Save on a body that is not here is the
                    // sentence, not a quiet no-op.
                    Step(
                        state.copy(
                            save = NotesEditorState.SaveState.SAVE_STATE_REFUSED,
                            draft = draft.copy(
                                save_failure = Reads.unavailable(
                                    "Centraid has not copied this note's text to this device yet.",
                                ),
                            ),
                        ),
                    )
                } else if (draft == null ||
                    state.save == NotesEditorState.SaveState.SAVE_STATE_SAVING
                ) {
                    // Nothing to save, or a save already in flight. A second
                    // command with a second `invoke_key` would be a second
                    // revision of the same edit.
                    Step(state)
                } else {
                    Step(
                        state.copy(save = NotesEditorState.SaveState.SAVE_STATE_SAVING),
                        listOf(
                            ScreenEffect.SubmitWrite(
                                command = SAVE_COMMAND,
                                inputJson = saveInput(state),
                                // THE INVOKE KEY IS THE BASE REVISION, not an
                                // ordinal. v0's fallback was the call's
                                // ORDINAL and was only stable for a handler
                                // that made the same call sequence every time
                                // (apps census §2.1); without a stable key a
                                // replayed intent re-executes a command that
                                // already committed.
                                invokeKey = "notes.save:${state.note_id}:${draft.base_revision_id}",
                                // R-NOTES-3: a note save is never onlineOnly.
                                onlineOnly = false,
                            ),
                        ),
                    )
                }
            }

            // A FAILED SAVE DOES NOT REPLACE THE EDITOR. The outcome lands on
            // `save` and the sentence lands on the draft; `content` is
            // untouched, so the words stay on the screen.
            event.save_settled != null -> Step(
                state.copy(
                    save = event.save_settled.outcome,
                    draft = state.draft?.copy(save_failure = event.save_settled.failure),
                ),
            )

            event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))

            else -> Step(state)
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

    private inline fun edited(
        state: NotesEditorState,
        change: (centraid.screen.v1.NoteDraft) -> centraid.screen.v1.NoteDraft,
    ): Step<NotesEditorState> {
        val draft = state.draft ?: return Step(state)
        return Step(
            state.copy(
                draft = change(draft).copy(save_failure = null),
                save = NotesEditorState.SaveState.SAVE_STATE_DIRTY,
            ),
        )
    }

    /**
     * The command's input, as JSON bytes (`centraid.core.v1.Intent.input`).
     *
     * Hand-built rather than serialised by a library: `commonMain` carries no
     * JSON dependency, the shape is four fields, and the escaping is the only
     * hard part — which is exactly what `jsonString` below is tested for.
     *
     * **It does NOT have to be canonical.** Both ends canonicalise the parsed
     * value before hashing — the seat's enqueue door and the gateway's
     * rehash — so a shell agreeing byte-for-byte with the vault's
     * canonicaliser would be a second implementation of it, which is
     * D-1025-S4-6's argument about digests applied to the same seam.
     *
     * ## `knowledge.edit_note`'s schema is `additionalProperties: false`
     *
     * So every key here is one the schema names, and three things this used to
     * send are gone:
     *
     * * **`body` → `body_text`.** The column is `body_text` and the wrong
     *   spelling would be rejected as an additional property.
     * * **`base_revision_id` is not an input.** It is the invoke key's second
     *   half — which is where concurrency control actually lives for a queued
     *   write — and sending it would be refused.
     * * **An ABSENT field is "leave it alone", and that is load-bearing here.**
     *   `title` and `body_text` are `minLength: 1`, so an empty string is not a
     *   legal way to say "unchanged" — it is refused. The body is omitted
     *   whenever this seat has not copied it (`body_unavailable`), which is
     *   what lets a title/pin-only save queue without blanking the note
     *   (R-NOTES-2/3).
     *
     * `pinned` is 0 or 1: the schema says integer, because SQLite has no
     * boolean and a `true` on the wire would invent one.
     */
    internal fun saveInput(state: NotesEditorState): String {
        val draft = state.draft ?: return "{}"
        val fields = mutableListOf("\"note_id\":${jsonString(state.note_id)}")
        if (draft.title.isNotEmpty()) fields += "\"title\":${jsonString(draft.title)}"
        if (!draft.body_unavailable && draft.body.isNotEmpty()) {
            fields += "\"body_text\":${jsonString(draft.body)}"
        }
        fields += "\"pinned\":${if (draft.pinned) 1 else 0}"
        return fields.joinToString(",", prefix = "{", postfix = "}")
    }

    internal fun jsonString(value: String): String = buildString {
        append('"')
        for (character in value) {
            when (character) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else ->
                    if (character < ' ') {
                        append("\\u").append(character.code.toString(16).padStart(4, '0'))
                    } else {
                        append(character)
                    }
            }
        }
        append('"')
    }

    /**
     * `knowledge_note`. Whether the editor acts on it is [reduce]'s decision:
     * see the `rows_changed` case, which refuses to replace a dirty draft.
     */
    override fun rowsChanged(
        table: String,
        keys: List<String>,
        commitSeq: ULong,
    ): NotesEditorEvent? = if (table == TABLE) {
        NotesEditorEvent(rows_changed = NotesEditorEvent.RowsChanged(note_ids = keys))
    } else {
        null
    }

    private const val TABLE: String = "knowledge_note"

    override fun seatChanged(seat: SeatState): NotesEditorEvent = NotesEditorEvent(seat_changed = NotesEditorEvent.SeatChanged(seat = seat))
}
