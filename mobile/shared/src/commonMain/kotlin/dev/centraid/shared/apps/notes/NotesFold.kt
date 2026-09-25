package dev.centraid.shared.apps.notes

import centraid.core.v1.NotesNotebook
import centraid.core.v1.NotesRow
import centraid.core.v1.NotesSearchHit
import centraid.screen.v1.NotesChoice
import centraid.screen.v1.NotesNoteRow
import centraid.screen.v1.NotesTextRun
import dev.centraid.design.copy.NotesCopy
import dev.centraid.shared.kit.time.CivilWords

/**
 * THE CORE'S NOTES ANSWERS, AS FINISHED ROWS (#1029 port). Pure; every word
 * from `NotesCopy` or the kit's `CivilWords`.
 *
 * DATES ARE THE INSTANT'S OWN DAY. `NotesRow.updated_at` is a UTC instant and
 * the library answer carries no local day, and `commonMain` does no zone
 * arithmetic — so "Edited 3 March" is the UTC day, as the kit's trash rows say
 * theirs. The core's need is in the port report: a `*_local` day per row.
 */
internal object NotesFold {
    private const val DAY: Int = 10

    fun row(row: NotesRow): NotesNoteRow = noteRow(
        noteId = row.note_id,
        title = row.title,
        preview = row.preview,
        pinned = row.pinned,
        updatedAt = row.updated_at ?: row.created_at,
        notebookNames = row.notebook_names,
        notebookIds = row.notebook_ids,
        checkTotal = row.check_total,
        checkDone = row.check_done,
        runs = emptyList(),
    )

    fun hit(hit: NotesSearchHit): NotesNoteRow {
        val runs = runsOf(hit.snippet)
        return noteRow(
            noteId = hit.note_id,
            title = hit.title,
            preview = hit.preview,
            pinned = hit.pinned,
            updatedAt = hit.updated_at ?: hit.created_at,
            notebookNames = hit.notebook_names,
            notebookIds = hit.notebook_ids,
            checkTotal = hit.check_total,
            checkDone = hit.check_done,
            runs = runs,
        ).let { if (runs.isEmpty()) it else it.copy(snippet = runs.joinToString("") { r -> r.text }) }
    }

    private fun noteRow(
        noteId: String,
        title: String?,
        preview: String,
        pinned: Boolean,
        updatedAt: String?,
        notebookNames: List<String>,
        notebookIds: List<String>,
        checkTotal: Int,
        checkDone: Int,
        runs: List<NotesTextRun>,
    ): NotesNoteRow {
        val shownTitle = titleOf(title, preview)
        val edited = updatedAt?.takeIf { it.length >= DAY }?.let { "${NotesCopy.EDITED} ${CivilWords.dayMonth(it.take(DAY))}" } ?: ""
        val meta = (listOf(edited) + notebookNames.filter { it.isNotBlank() }).filter { it.isNotEmpty() }.joinToString(" · ")
        val check = if (checkTotal > 0) "$checkDone of $checkTotal done" else ""
        val spoken = listOf(shownTitle, if (pinned) NotesCopy.SECTION_PINNED else "", meta, check)
            .filter { it.isNotEmpty() }.joinToString(", ")
        return NotesNoteRow(
            note_id = noteId,
            title = shownTitle,
            snippet = preview,
            snippet_runs = runs,
            meta = meta,
            pinned = pinned,
            check_label = check,
            accessibility_label = spoken,
            notebook_id = notebookIds.firstOrNull() ?: "",
        )
    }

    /** The title, else the preview's first line, else "Untitled note". */
    fun titleOf(title: String?, preview: String): String =
        title?.trim()?.takeIf { it.isNotEmpty() }
            ?: NotesEditorMachine.firstLine(preview).takeIf { it.isNotEmpty() }
            ?: NotesCopy.UNTITLED

    /** `⟦match⟧` spans as runs. No marker: no runs (the preview is drawn). */
    fun runsOf(snippet: String): List<NotesTextRun> {
        if ('⟦' !in snippet) return emptyList()
        val runs = mutableListOf<NotesTextRun>()
        var rest = snippet
        while (rest.isNotEmpty()) {
            val open = rest.indexOf('⟦')
            if (open < 0) {
                runs += NotesTextRun(text = rest)
                break
            }
            if (open > 0) runs += NotesTextRun(text = rest.substring(0, open))
            val close = rest.indexOf('⟧', open + 1)
            if (close < 0) {
                runs += NotesTextRun(text = rest.substring(open + 1))
                break
            }
            runs += NotesTextRun(text = rest.substring(open + 1, close), highlighted = true)
            rest = rest.substring(close + 1)
        }
        return runs.filter { it.text.isNotEmpty() }
    }

    fun nameOf(notebook: NotesNotebook): String =
        notebook.name?.trim()?.takeIf { it.isNotEmpty() } ?: NotesCopy.UNTITLED_NOTEBOOK

    /** "12 notes" / "1 note". */
    fun notes(count: Int): String = if (count == 1) "1 note" else "$count notes"

    /**
     * Every row the core answers is a notebook: its read filters
     * `core_collection` to `kind = 'notebook'` (rung six), so Photos' albums
     * never reach this shell to be hidden.
     */
    fun choices(notebooks: List<NotesNotebook>): List<NotesChoice> =
        notebooks.map { NotesChoice(id = it.notebook_id, label = nameOf(it)) }
}
