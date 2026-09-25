package dev.centraid.shared.apps.docs

import centraid.core.v1.DocsActivity
import centraid.core.v1.DocsActivityEvent
import centraid.core.v1.DocsDocument
import centraid.core.v1.DocsDocumentRow
import centraid.core.v1.DocsDrive
import centraid.core.v1.DocsFolder
import centraid.core.v1.DocsKind
import centraid.core.v1.DocsSearch
import centraid.core.v1.DocsSurface
import centraid.core.v1.DocsVersion
import centraid.screen.v1.DocsAction
import centraid.screen.v1.DocsActivityRow
import centraid.screen.v1.DocsCrumb
import centraid.screen.v1.DocsDocumentData
import centraid.screen.v1.DocsDriveData
import centraid.screen.v1.DocsEditorDraft
import centraid.screen.v1.DocsEditorEvent
import centraid.screen.v1.DocsFact
import centraid.screen.v1.DocsFactsOnly
import centraid.screen.v1.DocsFolderNode
import centraid.screen.v1.DocsLabelChip
import centraid.screen.v1.DocsRail
import centraid.screen.v1.DocsReader
import centraid.screen.v1.DocsRowView
import centraid.screen.v1.DocsSnippetRun
import centraid.screen.v1.DocsStage
import centraid.screen.v1.DocsSurfaceKind
import centraid.screen.v1.DocsVersionRow
import centraid.screen.v1.EmptyState
import dev.centraid.design.copy.DocsCopy
import dev.centraid.shared.kit.time.CivilWords
import dev.centraid.shared.kit.time.plusDays
import dev.centraid.shared.screen.Reads

/**
 * THE CORE'S DOCS ANSWERS, AS THE SCREENS DRAW THEM (#1046, docs port).
 *
 * `screen.proto` cannot import `centraid.core.v1`, so each answer is folded
 * here, once, into the screen messages — every word, icon key and
 * accessibility label a view draws. Pure: dates are the core's `*_local`
 * readings against the answer's own `today`, and no size, kind or media type
 * is classified here (the core answers `size`, `kind_name` and `surface`).
 *
 * What depends on the SCREEN's state (the band, the pills, which empty state)
 * is the machine's; what depends only on the answer is here.
 */
public object DocsFold {
    // ---------------------------------------------------------------------
    // Rows
    // ---------------------------------------------------------------------

    /** One row, as every list and the document's head draw it. */
    public fun row(row: DocsDocumentRow, today: String): DocsRowView {
        val title = row.title.ifBlank { DocsCopy.UNTITLED }
        val kind = row.kind_name
        val meta = if (row.trashed) {
            listOf(kind, row.size, dated(DocsCopy.DELETED, row.trashed_local, today))
        } else {
            listOf(kind, row.size, dated(DocsCopy.CHANGED, row.updated_local.ifEmpty { row.created_local }, today))
        }.filter { it.isNotEmpty() }.joinToString(" · ")
        return DocsRowView(
            document_id = row.document_id,
            content_id = row.content_id,
            title = title,
            kind_icon_key = iconOf(row.kind),
            kind_label = kind,
            meta = meta,
            surface = surfaceOf(row.surface),
            starred = row.starred,
            trashed = row.trashed,
            folder_id = row.folder_id,
            labels = row.labels.map { DocsLabelChip(tag_id = it.tag_id, label = it.label) },
            snippet = snippet(row.snippet),
            accessibility_label = listOfNotNull(
                title,
                meta.replace(" · ", ", "),
                DocsCopy.STARRED.takeIf { row.starred },
            ).joinToString(", "),
        )
    }

    /** "Changed today" / "Changed Wed 11 March", from a `YYYY-MM-DD…` reading. */
    internal fun dated(verb: String, local: String, today: String): String {
        if (local.length < DAY) return ""
        val day = local.take(DAY)
        val words = CivilWords.relativeDay(day, today)
        // "Today" and "Yesterday" are words inside the clause, not its start.
        val inline = if (day == today || day == plusDays(today, -1)) words.lowercase() else words
        return "$verb $inline"
    }

    /** The index's highlight, `⟦`/`⟧` around the matched words, as runs. */
    internal fun snippet(raw: String): List<DocsSnippetRun> {
        if (raw.isEmpty()) return emptyList()
        val runs = mutableListOf<DocsSnippetRun>()
        var rest = raw
        while (rest.isNotEmpty()) {
            val open = rest.indexOf(OPEN)
            if (open < 0) {
                runs += DocsSnippetRun(text = rest, match = false)
                break
            }
            if (open > 0) runs += DocsSnippetRun(text = rest.substring(0, open), match = false)
            val close = rest.indexOf(CLOSE, open + 1)
            if (close < 0) {
                runs += DocsSnippetRun(text = rest.substring(open + 1), match = true)
                break
            }
            val hit = rest.substring(open + 1, close)
            if (hit.isNotEmpty()) runs += DocsSnippetRun(text = hit, match = true)
            rest = rest.substring(close + 1)
        }
        return runs
    }

    internal fun surfaceOf(surface: DocsSurface): DocsSurfaceKind = when (surface) {
        DocsSurface.DOCS_SURFACE_READING -> DocsSurfaceKind.DOCS_SURFACE_KIND_READING
        DocsSurface.DOCS_SURFACE_STAGE -> DocsSurfaceKind.DOCS_SURFACE_KIND_STAGE
        DocsSurface.DOCS_SURFACE_FACTS -> DocsSurfaceKind.DOCS_SURFACE_KIND_FACTS
        else -> DocsSurfaceKind.DOCS_SURFACE_KIND_FACTS
    }

    /** A `design/native-catalog.json` key for a kind. */
    internal fun iconOf(kind: DocsKind): String = when (kind) {
        DocsKind.DOCS_KIND_IMAGE -> "Image"
        DocsKind.DOCS_KIND_VIDEO -> "Video"
        DocsKind.DOCS_KIND_AUDIO -> "Music"
        DocsKind.DOCS_KIND_SPREADSHEET -> "Table"
        DocsKind.DOCS_KIND_PRESENTATION -> "Layers"
        DocsKind.DOCS_KIND_PDF, DocsKind.DOCS_KIND_DOCUMENT -> "FileText"
        else -> "Paperclip"
    }

    // ---------------------------------------------------------------------
    // The drive
    // ---------------------------------------------------------------------

    /** The rail: every folder, the labels and the counts. */
    public fun rail(drive: DocsDrive): DocsRail = DocsRail(
        folders = drive.folders.map(::folder),
        labels = drive.labels,
        all_count = drive.all_count,
        unfiled_count = drive.unfiled_count,
        starred_count = drive.starred_count,
        trash_count = drive.trash_count,
        truncated = drive.truncated,
        window = drive.window,
        today = drive.today,
    )

    public fun folder(folder: DocsFolder): DocsFolderNode {
        val count = countLabel(folder.document_count)
        return DocsFolderNode(
            folder_id = folder.folder_id,
            name = folder.name.ifBlank { DocsCopy.UNTITLED },
            parent_id = folder.parent_id,
            document_count = folder.document_count,
            count_label = if (folder.document_count == 0) DocsCopy.FOLDER_EMPTY_COUNT else count,
            accessibility_label = "${folder.name.ifBlank { DocsCopy.UNTITLED }}, " +
                if (folder.document_count == 0) DocsCopy.FOLDER_EMPTY_COUNT else count,
        )
    }

    /** "1 document" / "24 documents". */
    public fun countLabel(n: Int): String = "$n ${if (n == 1) DocsCopy.DOCUMENT_ONE else DocsCopy.DOCUMENT_MANY}"

    /** A shelf's rows. The machine adds the folders, the crumbs and the empty choice. */
    public fun shelf(drive: DocsDrive): DocsDriveData = DocsDriveData(
        mode = DocsDriveData.Mode.MODE_SHELF,
        rows = drive.documents.map { row(it, drive.today) },
        truncated_note = if (drive.truncated) DocsCopy.TRUNCATED else "",
    )

    public fun search(search: DocsSearch): DocsDriveData = DocsDriveData(
        mode = DocsDriveData.Mode.MODE_SEARCH,
        rows = search.documents.map { row(it, search.today) },
    )

    /** The path from the top level down to [folderId], through the rail's parents. */
    public fun crumbs(folders: List<DocsFolderNode>, folderId: String): List<DocsCrumb> {
        if (folderId.isEmpty()) return emptyList()
        val byId = folders.associateBy { it.folder_id }
        val path = mutableListOf<DocsCrumb>()
        var at: String? = folderId
        // A cycle cannot be drawn and should not hang a reducer.
        while (at != null && at.isNotEmpty() && path.size < folders.size + 1) {
            val node = byId[at] ?: break
            path += DocsCrumb(folder_id = node.folder_id, name = node.name)
            at = node.parent_id
        }
        return path.reversed()
    }

    // ---------------------------------------------------------------------
    // One document
    // ---------------------------------------------------------------------

    /**
     * One document's screen: its surface, facts, versions and activity, with
     * the drive's folders and labels for the move and labels sheets.
     */
    public fun document(
        answer: DocsDocument,
        activity: DocsActivity?,
        drive: DocsDrive?,
    ): DocsDocumentData {
        val found = answer.document
            ?: return DocsDocumentData(gone = EmptyState(headline = DocsCopy.GONE))
        val row = row(found, answer.today)
        val folders = drive?.folders?.map(::folder).orEmpty()
        val events = activity?.events.orEmpty()
        return DocsDocumentData(
            row = row,
            reading = if (found.surface == DocsSurface.DOCS_SURFACE_READING) reader(found, answer) else null,
            stage = if (found.surface == DocsSurface.DOCS_SURFACE_STAGE) stage(found, answer, row.title) else null,
            facts_only = if (found.surface != DocsSurface.DOCS_SURFACE_READING &&
                found.surface != DocsSurface.DOCS_SURFACE_STAGE
            ) {
                DocsFactsOnly(sentence = DocsCopy.FACTS_ONLY)
            } else {
                null
            },
            facts = facts(found, answer, row),
            path = answer.path.map { DocsCrumb(folder_id = it.folder_id, name = it.name.ifBlank { DocsCopy.UNTITLED }) },
            versions = answer.versions.map { version(it, trashed = found.trashed) },
            activity = events.map(::activity),
            activity_empty = if (events.isEmpty()) DocsCopy.ACTIVITY_EMPTY else "",
            actions = actions(found),
            trashed_note = trashedNote(found),
            folders = folders,
            labels = drive?.labels.orEmpty(),
        )
    }

    private fun reader(row: DocsDocumentRow, answer: DocsDocument): DocsReader {
        val body = answer.body
        return DocsReader(
            body = body ?: "",
            has_text = body != null,
            no_text = if (body == null) DocsCopy.NO_TEXT else "",
            format = formatOf(row.media_type),
            editable = body != null && !row.trashed,
            edit_label = if (body != null && !row.trashed) DocsCopy.ACTION_EDIT else "",
            empty_body = if (body != null && body.isEmpty()) DocsCopy.EMPTY_BODY else "",
        )
    }

    internal fun formatOf(mediaType: String): DocsReader.Format =
        if (mediaType.substringBefore(';').trim() == "text/markdown") {
            DocsReader.Format.FORMAT_MARKDOWN
        } else {
            DocsReader.Format.FORMAT_PLAIN
        }

    private fun stage(row: DocsDocumentRow, answer: DocsDocument, title: String): DocsStage = DocsStage(
        content_id = row.content_id,
        media = when (row.kind) {
            DocsKind.DOCS_KIND_IMAGE -> DocsStage.Media.MEDIA_IMAGE
            DocsKind.DOCS_KIND_PDF -> DocsStage.Media.MEDIA_PDF
            DocsKind.DOCS_KIND_AUDIO -> DocsStage.Media.MEDIA_AUDIO
            DocsKind.DOCS_KIND_VIDEO -> DocsStage.Media.MEDIA_VIDEO
            else -> DocsStage.Media.MEDIA_UNSPECIFIED
        },
        media_type = row.media_type,
        held = answer.bytes_held,
        absent_reason = if (answer.bytes_held) "" else answer.bytes_absent_reason,
        accessibility_label = "$title, ${row.kind_name}",
    )

    private fun facts(row: DocsDocumentRow, answer: DocsDocument, view: DocsRowView): List<DocsFact> = buildList {
        add(DocsFact(label = DocsCopy.FACT_KIND, detail = view.kind_label))
        if (row.size.isNotEmpty()) add(DocsFact(label = DocsCopy.FACT_SIZE, detail = row.size))
        if (row.media_type.isNotEmpty()) add(DocsFact(label = DocsCopy.FACT_MEDIA_TYPE, detail = row.media_type))
        add(
            DocsFact(
                label = DocsCopy.FACT_FOLDER,
                detail = answer.path.lastOrNull()?.name?.ifBlank { null } ?: DocsCopy.MOVE_TOP,
            ),
        )
        stamp(row.created_local)?.let { add(DocsFact(label = DocsCopy.FACT_ADDED, detail = it)) }
        stamp(row.updated_local)?.let { add(DocsFact(label = DocsCopy.FACT_CHANGED, detail = it)) }
        if (row.labels.isNotEmpty()) {
            add(DocsFact(label = DocsCopy.FACT_LABELS, detail = row.labels.joinToString(", ") { it.label }))
        }
        if (answer.versions.isNotEmpty()) {
            add(DocsFact(label = DocsCopy.FACT_VERSIONS, detail = answer.versions.size.toString()))
        }
    }

    /** "Wed 11 March 09:12", or null for no reading. */
    internal fun stamp(local: String): String? {
        if (local.length < DAY) return null
        val clock = CivilWords.clock(local)
        val day = CivilWords.dayMonth(local.take(DAY))
        return if (clock.isEmpty()) day else "$day $clock"
    }

    private fun version(version: DocsVersion, trashed: Boolean): DocsVersionRow = DocsVersionRow(
        content_id = version.content_id,
        label = "${DocsCopy.VERSION} ${version.number}",
        meta = listOfNotNull(
            DocsCopy.CURRENT.takeIf { version.current },
            version.size.ifEmpty { null },
            stamp(version.asserted_local),
        ).joinToString(" · "),
        current = version.current,
        // An earlier version of a LIVE document can be made current again; a
        // trashed one is restored first (the vault refuses otherwise).
        restore_label = if (!version.current && !trashed) DocsCopy.ACTION_RESTORE else "",
    )

    private fun activity(event: DocsActivityEvent): DocsActivityRow = DocsActivityRow(
        label = when (event.activity) {
            "core.add_document" -> DocsCopy.ACTIVITY_ADDED
            "core.edit_document" -> DocsCopy.ACTIVITY_EDITED
            "core.rename_document" -> DocsCopy.ACTIVITY_RENAMED
            "core.move_document" -> DocsCopy.ACTIVITY_MOVED
            "core.star_document" -> DocsCopy.ACTIVITY_STARRED
            "core.unstar_document" -> DocsCopy.ACTIVITY_UNSTARRED
            "core.trash_document" -> DocsCopy.ACTIVITY_TRASHED
            "core.restore_document" -> DocsCopy.ACTIVITY_RESTORED
            "core.replace_document_content" -> DocsCopy.ACTIVITY_REPLACED
            "core.restore_document_version" -> DocsCopy.ACTIVITY_VERSION_RESTORED
            "core.tag_item" -> DocsCopy.ACTIVITY_LABELLED
            "core.untag_item" -> DocsCopy.ACTIVITY_UNLABELLED
            "core.empty_document_trash" -> DocsCopy.ACTIVITY_TRASH_EMPTIED
            else -> DocsCopy.ACTIVITY_OTHER
        },
        meta = listOfNotNull(
            when (event.agent_kind) {
                "owner" -> DocsCopy.AGENT_YOU
                "agent" -> DocsCopy.AGENT_ASSISTANT
                else -> DocsCopy.AGENT_APP
            },
            stamp(event.occurred_local),
        ).joinToString(" · "),
    )

    /** The head's actions: edit (text), star, rename, move, labels, then trash or restore. */
    internal fun actions(row: DocsDocumentRow): List<DocsAction> = buildList {
        if (row.trashed) {
            add(action(DocsWrites.KEY_RESTORE, DocsCopy.ACTION_RESTORE, "restore", enabled = row.purge_in_days > 0))
            return@buildList
        }
        if (row.surface == DocsSurface.DOCS_SURFACE_READING) {
            add(action(DocsWrites.KEY_EDIT, DocsCopy.ACTION_EDIT, "Pencil"))
        }
        addAll(menu(row.starred))
    }

    /** A live document's menu: star, rename, move, labels, trash. */
    internal fun menu(starred: Boolean): List<DocsAction> = listOf(
        if (starred) {
            action(DocsWrites.KEY_UNSTAR, DocsCopy.ACTION_UNSTAR, "Star")
        } else {
            action(DocsWrites.KEY_STAR, DocsCopy.ACTION_STAR, "Star")
        },
        action(DocsWrites.KEY_RENAME, DocsCopy.ACTION_RENAME, "FileEdit"),
        action(DocsWrites.KEY_MOVE, DocsCopy.ACTION_MOVE, "Folder"),
        action(DocsWrites.KEY_LABELS, DocsCopy.ACTION_LABELS, "Tag"),
        action(DocsWrites.KEY_TRASH, DocsCopy.ACTION_TRASH, "trash", destructive = true),
    )

    internal fun action(
        key: String,
        label: String,
        icon: String,
        destructive: Boolean = false,
        enabled: Boolean = true,
        detail: String = "",
    ): DocsAction = DocsAction(
        key = key,
        label = label,
        icon_key = icon,
        destructive = destructive,
        enabled = enabled,
        detail = detail,
    )

    /**
     * NO DESTROY PATH: the grace window's end is when a restore stops being
     * possible, never when the document is deleted (`docs.proto`'s header).
     */
    private fun trashedNote(row: DocsDocumentRow): String = when {
        !row.trashed -> ""
        row.purge_in_days > 0 && row.purge_local_day.length >= DAY ->
            "${DocsCopy.IN_TRASH_UNTIL} ${CivilWords.dayMonth(row.purge_local_day.take(DAY))}"
        else -> DocsCopy.IN_TRASH_LAPSED
    }

    // ---------------------------------------------------------------------
    // The editor
    // ---------------------------------------------------------------------

    /**
     * The editor's draft, or the reason there is none: only a live text
     * document whose text this vault holds can be edited.
     */
    public fun editor(answer: DocsDocument): DocsEditorEvent.DataArrived {
        val row = answer.document
            ?: return DocsEditorEvent.DataArrived(refusal = Reads.refused(DocsCopy.GONE))
        val body = answer.body
        val refusal = when {
            row.trashed -> DocsCopy.TRASHED_NOT_EDITABLE
            row.surface != DocsSurface.DOCS_SURFACE_READING || body == null -> DocsCopy.NOT_EDITABLE
            else -> null
        }
        if (refusal != null) return DocsEditorEvent.DataArrived(refusal = Reads.refused(refusal))
        val current = answer.versions.firstOrNull { it.current } ?: answer.versions.firstOrNull()
        return DocsEditorEvent.DataArrived(
            draft = DocsEditorDraft(title = row.title, body = body ?: ""),
            // WHICH VERSION THE WORDS ARE ON: a save mints the next one, so the
            // head's content id is the revision the editor last read.
            revision = row.content_id,
            version_label = current?.let { "${DocsCopy.VERSION} ${it.number}" } ?: "",
            format = formatOf(row.media_type),
        )
    }

    private const val DAY: Int = 10
    private const val OPEN: Char = '⟦'
    private const val CLOSE: Char = '⟧'
}
