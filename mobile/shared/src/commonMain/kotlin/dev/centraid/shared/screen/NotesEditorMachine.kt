package dev.centraid.shared.screen

import centraid.screen.v1.Loading
import centraid.screen.v1.NotesEditorEvent
import centraid.screen.v1.NotesEditorState

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

            event.body != null -> edited(state) { it.copy(body = event.body.body) }

            event.pin != null -> edited(state) { it.copy(pinned = !it.pinned) }

            event.save != null -> {
                val draft = state.draft
                if (draft == null || state.save == NotesEditorState.SaveState.SAVE_STATE_SAVING) {
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
                                // A NOTE SAVE IS NOT ONLINE-ONLY. It queues,
                                // and the outbox is the point.
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

    public const val SAVE_COMMAND: String = "knowledge.save_note"

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
     * The command's input, as canonical JSON bytes
     * (`centraid.core.v1.Command.input`).
     *
     * Hand-built rather than serialised by a library: `commonMain` carries no
     * JSON dependency, the shape is four fields, and the escaping is the only
     * hard part — which is exactly what `jsonString` below is tested for.
     */
    internal fun saveInput(state: NotesEditorState): String {
        val draft = state.draft ?: return "{}"
        return "{" +
            "\"note_id\":${jsonString(state.note_id)}," +
            "\"title\":${jsonString(draft.title)}," +
            "\"body\":${jsonString(draft.body)}," +
            "\"pinned\":${draft.pinned}," +
            "\"base_revision_id\":${jsonString(draft.base_revision_id)}" +
            "}"
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
}
