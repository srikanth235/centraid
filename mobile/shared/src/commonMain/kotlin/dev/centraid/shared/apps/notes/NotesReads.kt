package dev.centraid.shared.apps.notes

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.AppQueryResponse
import centraid.core.v1.CommandStatus
import centraid.core.v1.NotesNote
import centraid.core.v1.NotesNoteRequest
import centraid.screen.v1.NoteDraft
import centraid.screen.v1.NotesEditorEvent
import centraid.screen.v1.NotesEditorState
import centraid.screen.v1.ReadFailure
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.platform.DeviceClock
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.sync.ScreenQueries
import dev.centraid.shared.sync.ScreenWrites

/**
 * WHAT THE NOTES EDITOR READS, AND WHAT IT MAKES OF THE ANSWER (#1135).
 *
 * The editor reads ONE note whole, so it rides the core's `notes.note` app query
 * — the same arm that opens a People-journal entry by id — rather than a page of
 * `note` rows: a note is an `entity` and a `note` row, and the page door's one
 * shape is one table. The answer carries the title, the format, the pin, the
 * notebook and `row_version`, which is the editor's base.
 */
public object NotesReads :
    ScreenQueries<NotesEditorState, NotesEditorEvent>,
    ScreenWrites<NotesEditorState, NotesEditorEvent> {
    override val screenId: String = NotesEditorMachine.SCREEN_ID

    /** The tables a note's draft is made of; `rowsChanged` names exactly these. */
    override val tables: Set<String> = NotesTables.SHELF

    /**
     * The note the editor is open on, or null before it knows. The id comes off
     * the STATE, where `Opened` put it: null when it is not there, which the
     * runtime turns into a sentence rather than silence.
     */
    override fun requests(state: NotesEditorState, now: DeviceClock.Reading): List<AppQueryRequest>? =
        state.note_id.takeIf { it.isNotEmpty() }?.let {
            listOf(AppQueryRequest(notes_note = NotesNoteRequest(note_id = it, tz = now.zone)))
        }

    /**
     * The draft, or the refusal that a note which is not there deserves.
     *
     * **AN ABSENT NOTE IS NOT AN EMPTY NOTE.** An editor with no note is an
     * editor over one that was purged or never made, and drawing an empty title
     * and an empty body would invite a member to type into a document that does
     * not exist. So `found = false` is a sentence, and so is a note in the
     * trash: `note.edit` refuses a trashed note, so the editor must not open one.
     */
    override fun arrived(answers: List<AppQueryResponse>): NotesEditorEvent {
        val note = answers.firstNotNullOfOrNull { it.notes_note } ?: NotesNote()
        if (!note.found) return refused(Reads.refused("This note isn't on this phone."))
        if (note.deleted_at != null) return refused(Reads.refused("This note is in the trash."))
        return NotesEditorEvent(
            data_ = NotesEditorEvent.DataArrived(
                draft = NoteDraft(
                    title = note.title,
                    body = note.body,
                    format = formatOf(note.format),
                    pinned = note.pinned,
                    // THE BASE IS A MARKER AND NOT A CHECK. The kit's autosave keeps
                    // it (`AutosaveLaw.loaded`), but it is not an input to the save:
                    // there is no vault-side version check, and the last save on
                    // this phone wins (R-1047-K3).
                    base_revision_id = note.row_version.toString(),
                ),
            ),
        )
    }

    override fun refused(failure: ReadFailure): NotesEditorEvent =
        NotesEditorEvent(refused = NotesEditorEvent.ReadRefused(failure = failure))

    /**
     * The note's two formats, as the proto's.
     *
     * Unrecognised is `FORMAT_UNSPECIFIED` and not `FORMAT_PLAIN`: rendering an
     * unknown format as plain text would show a member markup they wrote as
     * literal characters, or hide markup they did not.
     */
    private fun formatOf(format: String): NoteDraft.Format = when (format) {
        "markdown" -> NoteDraft.Format.FORMAT_MARKDOWN
        "plain" -> NoteDraft.Format.FORMAT_PLAIN
        else -> NoteDraft.Format.FORMAT_UNSPECIFIED
    }

    override val appId: String = "notes"

    /**
     * The save's outcome, as the editor's own settle event, keyed by the invoke
     * key it was submitted under — so a settle for a save the editor has since
     * moved past is recognisably not the one in flight.
     *
     * Only `EXECUTED` commits: the phone is the vault, and a save commits here or
     * it does not. The sentence is the core's; silence carries none.
     */
    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): NotesEditorEvent =
        NotesEditorEvent(write_settled = WriteLaw.settledOf(status, sentence, invokeKey))
}
