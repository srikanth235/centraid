package dev.centraid.shared.apps.notes

import centraid.core.v1.CommandStatus
import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.NoteDraft
import centraid.screen.v1.NotesEditorEvent
import centraid.screen.v1.NotesEditorState
import centraid.screen.v1.ReadFailure
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.sync.ScreenReads
import dev.centraid.shared.sync.ScreenWrites

/**
 * WHAT THE NOTES EDITOR READS, AND WHAT IT MAKES OF THE ROW (#1025 S5, lane L5).
 *
 * The editor is the one screen of the three that reads ONE row rather than a
 * page, and the door has one shape: a page. So the statement is
 * `crates/apps/notes`' `notes.library.recent` — `knowledge_note`, live rows,
 * `updated_at DESC, note_id DESC` — with the note's own id bound into the
 * predicate and a limit of one.
 *
 * **The order columns are still selected and the order is still stated**, on a
 * read that can return at most one row. Not ceremony: the door reads the cursor
 * off the row by the two columns the ORDER BY names, there is no `key_of`
 * callback, and a statement that dropped them because "it is only one row"
 * would be a statement that breaks the moment its predicate widens.
 */
public object NotesReads :
    ScreenReads<NotesEditorState, NotesEditorEvent>,
    ScreenWrites<NotesEditorState, NotesEditorEvent> {
    override val screenId: String = NotesEditorMachine.SCREEN_ID

    /** `knowledge_note`, the same table the machine's `rowsChanged` declares. */
    override val table: String = "knowledge_note"

    /** One note. The editor is open on exactly one. */
    override val limit: Int = 1

    /**
     * The note the editor is open on, or null before it knows.
     *
     * The id comes off the STATE, where `Opened` put it — `ScreenHost`
     * publishes the state before it emits the same reduce's effects, so by the
     * time this is asked the id is there. Null when it is not, which
     * `ScreenRuntime` turns into a sentence rather than into silence: an editor
     * that asked for a read and got nothing back would sit loading for ever.
     *
     * `deleted_at IS NULL` is the app's own filter: a deleted note stays on the
     * table until the purge sweep takes it, and an editor that opened one would
     * let a member type into something already thrown away.
     *
     * [afterCursor] is ignored, and it is the one screen where that is right —
     * there is no second page of one note. A cursor arriving here would mean a
     * caller walked a single-row read, and re-reading the same row is the
     * honest answer to that.
     */
    override fun query(state: NotesEditorState, afterCursor: String?): PageQuery? {
        val noteId = state.note_id.takeIf { it.isNotEmpty() } ?: return null
        return PageQuery(
            name = "notes.editor.note",
            select = listOf(
                "note_id",
                "title",
                "format",
                "pinned",
                "current_revision_id",
                "updated_at",
            ),
            from = table,
            where_ = "note_id = ? AND deleted_at IS NULL",
            bind = listOf(Value(text = noteId)),
            order = PageOrder(
                sort_column = "updated_at",
                pk_column = "note_id",
                descending = true,
            ),
            // R-NOTES-1: the body is `core_content_text`, appended as
            // `body_text` after the named columns — not `seat_blob_held`.
            with_note_body = true,
        )
    }

    /**
     * The draft, or the refusal that a note which is not there deserves.
     *
     * **AN EMPTY PAGE IS NOT AN EMPTY NOTE.** A list with no rows is a real
     * answer — the member has no expenses — but an EDITOR with no row is an
     * editor over a note that was deleted, purged, or never reached this seat,
     * and drawing an empty title and an empty body would invite a member to
     * type into a document that does not exist and then be told on save that it
     * does not. So the absence is a sentence, produced here because this is the
     * only place that knows a page of one is a page of one.
     */
    override fun arrived(rows: List<Row>, nextCursor: String?): NotesEditorEvent {
        val row = rows.firstOrNull()
            ?: return refused(
                Reads.refused("Centraid could not find this note on this device."),
            )
        val (body, bodyUnavailable) = row.noteBody()
        return NotesEditorEvent(
            data_ = NotesEditorEvent.DataArrived(
                draft = NoteDraft(
                    title = row.text(1),
                    // R-NOTES-1: `body_text` is the door's appended column from
                    // `core_content_text`, after the six named select columns.
                    // NULL means the text is not on this device; a present
                    // string (including empty) is the replica's own words.
                    body = body,
                    body_unavailable = bodyUnavailable,
                    format = formatOf(row.text(2)),
                    // SQLite HAS NO BOOLEAN. `pinned` is `INTEGER CHECK
                    // (pinned IN (0,1))`, so it arrives on the integer arm of
                    // the value oneof and reading it as text would come back
                    // empty and unpin every note in the vault.
                    pinned = row.integer(3) != 0L,
                    // THE BASE REVISION IS WHAT MAKES A SAVE A CONCURRENCY
                    // CHECK rather than a last-write-wins, and the machine puts
                    // it in the save's `invoke_key`. A draft read without one
                    // would let a replayed intent re-execute a committed
                    // command.
                    base_revision_id = row.text(4),
                ),
            ),
        )
    }

    override fun refused(failure: ReadFailure): NotesEditorEvent =
        NotesEditorEvent(refused = NotesEditorEvent.ReadRefused(failure = failure))

    /**
     * The DDL's three `format` values, as the proto's three.
     *
     * Unrecognised is `FORMAT_UNSPECIFIED` and not `FORMAT_PLAIN`: rendering
     * an unknown format as plain text would show a member markup they wrote as
     * literal characters, or hide markup they did not.
     */
    private fun formatOf(format: String): NoteDraft.Format = when (format) {
        "markdown" -> NoteDraft.Format.FORMAT_MARKDOWN
        "html" -> NoteDraft.Format.FORMAT_HTML
        "plain" -> NoteDraft.Format.FORMAT_PLAIN
        else -> NoteDraft.Format.FORMAT_UNSPECIFIED
    }

    /** Positional, as the door states. See `HomeReads.text` for why only TEXT. */
    private fun Row.text(index: Int): String = values.getOrNull(index)?.text ?: ""

    private fun Row.integer(index: Int): Long = values.getOrNull(index)?.integer ?: 0L

    /**
     * The appended `body_text` column ([BODY]), or unavailable when it is SQL
     * NULL / absent. An empty string on the text arm is a real body.
     */
    private fun Row.noteBody(): Pair<String, Boolean> {
        val value = values.getOrNull(BODY) ?: return "" to true
        if (value.null_ != null) return "" to true
        return (value.text ?: "") to false
    }

    /** After the six named select columns; see `query`'s `with_note_body`. */
    private const val BODY: Int = 6

    override val appId: String = "notes"

    /**
     * The save's outcome, as the editor's own settle event, keyed by the
     * invoke key it was submitted under — so a settle for a save the editor
     * has since moved past is recognisably not the one in flight.
     *
     * Only `EXECUTED` commits: the phone is the vault, and a save commits here
     * or it does not (QUEUED left with the outbox). The sentence is the core's;
     * silence carries none.
     */
    override fun settled(status: CommandStatus, sentence: String, invokeKey: String): NotesEditorEvent =
        NotesEditorEvent(write_settled = WriteLaw.settledOf(status, sentence, invokeKey))
}
