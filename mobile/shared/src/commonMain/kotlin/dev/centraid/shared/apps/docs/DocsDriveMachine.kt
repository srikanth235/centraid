package dev.centraid.shared.apps.docs

import centraid.screen.v1.Confirm
import centraid.screen.v1.Denied
import centraid.screen.v1.DocsAction
import centraid.screen.v1.DocsActionList
import centraid.screen.v1.DocsBandTab
import centraid.screen.v1.DocsCapture
import centraid.screen.v1.DocsChoice
import centraid.screen.v1.DocsChoiceList
import centraid.screen.v1.DocsDriveChrome
import centraid.screen.v1.DocsDriveData
import centraid.screen.v1.DocsDriveEvent
import centraid.screen.v1.DocsDriveState
import centraid.screen.v1.DocsLabelsSheet
import centraid.screen.v1.DocsNewFolderSheet
import centraid.screen.v1.DocsPill
import centraid.screen.v1.DocsQuery
import centraid.screen.v1.DocsRename
import centraid.screen.v1.DocsRowView
import centraid.screen.v1.DocsSheet
import centraid.screen.v1.EmptyState
import centraid.screen.v1.Loading
import centraid.screen.v1.SearchField
import centraid.screen.v1.SeatState
import centraid.screen.v1.WriteState
import dev.centraid.design.copy.DocsCopy
import dev.centraid.shared.kit.BandLaw
import dev.centraid.shared.kit.BandLens
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.InvokeKeys
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.SearchLaw
import dev.centraid.shared.kit.SearchLens
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.kit.WriteLens
import dev.centraid.shared.kit.dataOf
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step

/**
 * DOCS' DRIVE ON THE PHONE (#1046, docs port): All · Folders · Starred, with
 * Recently added from More, search as a field, and every write a row offers.
 *
 * ## The band
 *
 * The handoff's band is All · Folders · Coming due · Search · More; v0's was
 * All · Folders · Starred · Shared · More. This one is All · Folders ·
 * Starred · More: Shared left with the sharing plane (#1029), "Coming due" has
 * no data plane in this build (nothing reads obligations out of a document),
 * and search is a field on the current surface (`SearchLaw`), never a tab.
 *
 * ## What reads
 *
 * The shelf, the folder, the three filters and the order are the core's
 * REQUEST (`docs.drive`), so changing any of them reads again. A term reads
 * `docs.search` instead; the folder rail and counts are kept from the last
 * drive answer ([DocsDriveState.rail]). One read is in flight at a time
 * ([ReadGate]). Grid or list is local and reads nothing.
 *
 * ## Writes
 *
 * Star, move, labels, trash (behind a confirm) and a new folder go through
 * [WriteLaw]: one in flight, a refusal keeps the rows and says so. Rename is
 * inline and autosaves ([DocsRenameLaw]). Nothing is patched locally: the
 * vault's change event re-reads the shelf. Capture is the shell's — the Add
 * sheet's rows are intents (`AddRequested`), and whether they can be offered
 * is the OS grants the shell reports (`DocsCapture`, law 4).
 *
 * ## Views decide nothing
 *
 * The band, the pills, the sheets, the empty choice, the head's subtitle and
 * every label are recomputed on every step ([decorate]).
 */
public object DocsDriveMachine : ScreenMachine<DocsDriveState, DocsDriveEvent> {
    public const val SCREEN_ID: String = "docs.drive"

    /**
     * THE TABLES `docs.drive` AND `docs.search` READ: the document, its folder
     * and label edges, the folders scheme, the content rows, their
     * representations, custody and decoded text. `DocsDriveReads.tables` is
     * this set, and `AppReadsSpec` holds [rowsChanged] to exactly it.
     */
    public val TABLES: Set<String> = setOf(
        "core_document",
        "core_tag",
        "core_concept",
        "core_concept_scheme",
        "core_content_item",
        "core_content_representation",
        "core_content_text",
        "blob_custody_state",
    )

    public const val BAND_ALL: String = "all"
    public const val BAND_FOLDERS: String = "folders"
    public const val BAND_STARRED: String = "starred"
    public const val BAND_MORE: String = "more"

    // The sort sheet's keys: the core's sort and its direction.
    public const val SORT_CHANGED_DESC: String = "changed_desc"
    public const val SORT_CHANGED_ASC: String = "changed_asc"
    public const val SORT_NAME_ASC: String = "name_asc"
    public const val SORT_NAME_DESC: String = "name_desc"
    public const val SORT_KIND_ASC: String = "kind_asc"
    public const val SORT_SIZE_DESC: String = "size_desc"

    /** A filter sheet's "any" row. */
    public const val KEY_ANY: String = "any"

    override fun initial(): DocsDriveState = decorate(
        DocsDriveState(
            destination = DocsDriveState.Destination.DESTINATION_ALL,
            query = DocsQuery(sort = DocsQuery.Sort.SORT_CHANGED),
            layout = DocsDriveState.Layout.LAYOUT_LIST,
            search = SearchField(),
            loading = Loading(first_load = true),
            sheet = DocsSheet(kind = DocsSheet.Kind.KIND_NONE),
            write = WriteState(phase = WriteState.Phase.PHASE_IDLE),
            capture = DocsCapture(
                camera = DocsCapture.Permission.PERMISSION_NOT_ASKED,
                files = DocsCapture.Permission.PERMISSION_NOT_ASKED,
            ),
        ),
    )

    override fun reduce(state: DocsDriveState, event: DocsDriveEvent): Step<DocsDriveState> {
        val step = step(state, event)
        return Step(decorate(step.state), step.effects)
    }

    override fun rowsChanged(table: String, keys: List<String>): DocsDriveEvent? =
        if (table in TABLES) DocsDriveEvent(rows_changed = DocsDriveEvent.RowsChanged(table = table)) else null

    override fun seatChanged(seat: SeatState): DocsDriveEvent =
        DocsDriveEvent(seat_changed = DocsDriveEvent.SeatChanged(seat = seat))

    override fun ticked(token: String): DocsDriveEvent = DocsDriveEvent(tick = DocsDriveEvent.Ticked(token = token))

    /** Leaving saves an open rename (close = done). */
    override fun left(): DocsDriveEvent = DocsDriveEvent(left = DocsDriveEvent.Left())

    /** The term the drive is searching, or null when it reads its shelf. */
    public fun activeTerm(state: DocsDriveState): String? {
        val field = state.search ?: return null
        return field.term.trim().takeIf { field.open_ && it.isNotEmpty() }
    }

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    private fun step(state: DocsDriveState, event: DocsDriveEvent): Step<DocsDriveState> = when {
        event.opened != null -> {
            val to = event.opened.destination
                .takeUnless { it == DocsDriveState.Destination.DESTINATION_UNSPECIFIED }
                ?: DocsDriveState.Destination.DESTINATION_ALL
            val folder = if (to == DocsDriveState.Destination.DESTINATION_FOLDERS) event.opened.folder_id else ""
            read(
                Content.with(
                    state.copy(
                        destination = to,
                        folder_id = folder,
                        folder_name = if (folder.isEmpty()) "" else event.opened.folder_name,
                        search = SearchField(),
                        sheet = none(),
                        confirm = null,
                        confirm_document_id = "",
                        refreshing = false,
                    ),
                    ReadContent.Loading(firstLoad = true),
                ),
            )
        }

        event.refreshed != null -> refresh(state)

        event.band != null -> band(state, event.band.key)

        event.data_ != null -> landed(state) { s ->
            val arrived = event.data_.data_ ?: DocsDriveData()
            val rail = event.data_.rail ?: s.rail
            val answered = if (arrived.mode == DocsDriveData.Mode.MODE_SEARCH) {
                SearchLaw.answered(Search, s, s.search?.term ?: "")
            } else {
                s
            }
            Step(Content.with(answered.copy(rail = rail, refreshing = false), ReadContent.Data(arrived)))
        }

        // A FAILED READ IS NOT AN EMPTY LIST, and it asks nothing more: a
        // retry is the member's `Refreshed`.
        event.refused != null -> landed(state) { s ->
            Step(
                Content.with(
                    s.copy(refreshing = false),
                    ReadContent.Failed(event.refused.failure ?: Reads.refused("")),
                ),
            )
        }

        event.denied != null -> landed(state) { s ->
            Step(Content.with(s.copy(refreshing = false, sheet = none()), ReadContent.Denied(event.denied)))
        }

        event.rows_changed != null -> refresh(state)

        event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))

        event.search_opened != null -> SearchLaw.opened(Search, state)

        event.search_term != null -> {
            val wasSearching = Content.dataOf(state)?.mode == DocsDriveData.Mode.MODE_SEARCH
            val step = SearchLaw.term(Search, state, event.search_term.term)
            // A term cleared to nothing reads the shelf back under the field.
            if (event.search_term.term.isBlank() && wasSearching) read(step.state) else gate(step)
        }

        event.search_closed != null -> {
            val wasSearching = Content.dataOf(state)?.mode == DocsDriveData.Mode.MODE_SEARCH || state.reading
            val step = SearchLaw.closed(Search, state)
            if (wasSearching) read(step.state) else step
        }

        event.layout_toggled != null -> Step(
            state.copy(
                layout = if (state.layout == DocsDriveState.Layout.LAYOUT_GRID) {
                    DocsDriveState.Layout.LAYOUT_LIST
                } else {
                    DocsDriveState.Layout.LAYOUT_GRID
                },
            ),
        )

        event.sheet_opened != null -> Step(openSheet(state, event.sheet_opened.kind, documentId = ""))

        event.sheet_closed != null -> Step(state.copy(sheet = none()))

        event.choice != null -> choice(state, event.choice.key)

        event.filters_cleared != null -> read(
            state.copy(
                query = (state.query ?: DocsQuery()).copy(
                    type = DocsQuery.TypeFilter.TYPE_FILTER_UNSPECIFIED,
                    modified = DocsQuery.Modified.MODIFIED_UNSPECIFIED,
                    label = "",
                ),
                sheet = none(),
            ),
        )

        event.row_menu != null ->
            if (row(state, event.row_menu.document_id) == null) {
                Step(state)
            } else {
                Step(openSheet(state, DocsSheet.Kind.KIND_ROW_MENU, event.row_menu.document_id))
            }

        event.action != null -> action(state, event.action.key)

        event.rename_edited != null -> DocsRenameLaw.edited(Rename, state, event.rename_edited.title)

        event.rename_closed != null -> DocsRenameLaw.closed(Rename, state)

        event.tick != null -> DocsRenameLaw.tick(Rename, state, event.tick.token)

        event.left != null -> DocsRenameLaw.closed(Rename, state)

        event.label_added != null -> labelAdded(state, event.label_added.label)

        event.label_removed != null -> {
            val tagId = event.label_removed.tag_id
            if (tagId.isEmpty()) {
                Step(state)
            } else {
                WriteLaw.submit(Writes, state, DocsWrites.UNTAG, DocsWrites.untag(tagId), InvokeKeys.of(DocsWrites.UNTAG, tagId))
            }
        }

        event.label_draft != null -> Step(withSheetText(state, event.label_draft.text))

        event.folder_name != null -> Step(withSheetText(state, event.folder_name.name))

        event.folder_created != null -> folderCreated(state)

        event.confirmed != null -> {
            val documentId = state.confirm_document_id
            val cleared = state.copy(confirm = null, confirm_document_id = "")
            if (state.confirm == null || documentId.isEmpty()) {
                Step(cleared)
            } else {
                WriteLaw.submit(
                    Writes,
                    cleared,
                    DocsWrites.TRASH,
                    DocsWrites.documentOnly(documentId),
                    InvokeKeys.of(DocsWrites.TRASH, documentId),
                )
            }
        }

        event.dismissed != null -> Step(state.copy(confirm = null, confirm_document_id = ""))

        event.write_settled != null ->
            if (DocsRenameLaw.owns(Rename, state, event.write_settled.invoke_key)) {
                DocsRenameLaw.settled(Rename, state, event.write_settled)
            } else {
                WriteLaw.settled(Writes, state, event.write_settled)
            }

        event.permission != null -> Step(permission(state, event.permission))

        // INTENTS: the shell routes them. The sheet a row was on goes away.
        event.add_requested != null || event.trash_opened != null -> Step(state.copy(sheet = none()))

        else -> Step(state)
    }

    private fun band(state: DocsDriveState, key: String): Step<DocsDriveState> {
        if (key == BAND_MORE) return Step(openSheet(state, DocsSheet.Kind.KIND_MORE, documentId = ""))
        val to = when (key) {
            BAND_ALL -> DocsDriveState.Destination.DESTINATION_ALL
            BAND_FOLDERS -> DocsDriveState.Destination.DESTINATION_FOLDERS
            BAND_STARRED -> DocsDriveState.Destination.DESTINATION_STARRED
            else -> return Step(state)
        }
        return toDestination(state, to)
    }

    /**
     * A DESTINATION CHANGE (law 2): the same one is nothing; another closes
     * search, lands at the top level and reads. Folders' tab is always the
     * top level; a folder inside it is a pushed page (`FolderPicked`).
     */
    private fun toDestination(state: DocsDriveState, to: DocsDriveState.Destination): Step<DocsDriveState> {
        if (state.destination == to && state.folder_id.isEmpty()) return Step(state.copy(sheet = none()))
        val landed = state.copy(folder_id = "", folder_name = "", sheet = none(), search = SearchField())
        // `BandLaw` compares destinations; a folder page moving to its own
        // tab's top level is still a move, so the destination is cleared first.
        val from = if (state.destination == to) {
            landed.copy(destination = DocsDriveState.Destination.DESTINATION_UNSPECIFIED)
        } else {
            landed
        }
        return gate(BandLaw.changed(Band, Content, SCREEN_ID, from, to))
    }

    private fun refresh(state: DocsDriveState): Step<DocsDriveState> =
        if (Content.dataOf(state) != null) {
            read(state.copy(refreshing = true))
        } else {
            read(Content.with(state, ReadContent.Loading(firstLoad = true)))
        }

    // ---------------------------------------------------------------------
    // Sheets
    // ---------------------------------------------------------------------

    private fun choice(state: DocsDriveState, key: String): Step<DocsDriveState> {
        val sheet = state.sheet ?: return Step(state)
        val query = state.query ?: DocsQuery()
        val closed = state.copy(sheet = none())
        return when (sheet.kind) {
            DocsSheet.Kind.KIND_TYPE -> read(closed.copy(query = query.copy(type = typeOf(key))))
            DocsSheet.Kind.KIND_MODIFIED -> read(closed.copy(query = query.copy(modified = modifiedOf(key))))
            DocsSheet.Kind.KIND_LABEL -> read(closed.copy(query = query.copy(label = if (key == KEY_ANY) "" else key)))
            DocsSheet.Kind.KIND_SORT -> {
                val (sort, ascending) = sortOf(key) ?: return Step(state)
                read(closed.copy(query = query.copy(sort = sort, ascending = ascending)))
            }
            DocsSheet.Kind.KIND_MOVE -> {
                val documentId = sheet.document_id
                val current = row(state, documentId) ?: return Step(closed)
                val folderId = if (key == DocsWrites.KEY_TOP_LEVEL) "" else key
                // Where it already is: nothing to write.
                if (folderId == current.folder_id) {
                    Step(closed)
                } else {
                    WriteLaw.submit(
                        Writes,
                        closed,
                        DocsWrites.MOVE,
                        DocsWrites.move(documentId, folderId),
                        InvokeKeys.of(DocsWrites.MOVE, documentId, key),
                    )
                }
            }
            else -> Step(state)
        }
    }

    private fun action(state: DocsDriveState, key: String): Step<DocsDriveState> {
        val sheet = state.sheet ?: return Step(state)
        return when (sheet.kind) {
            DocsSheet.Kind.KIND_MORE -> when (key) {
                DocsWrites.KEY_RECENT -> toDestination(state, DocsDriveState.Destination.DESTINATION_RECENT)
                // `trash_shelf` is the shell's route; the sheet goes.
                else -> Step(state.copy(sheet = none()))
            }
            DocsSheet.Kind.KIND_ADD -> when (key) {
                DocsWrites.KEY_NEW_FOLDER -> Step(openSheet(state, DocsSheet.Kind.KIND_NEW_FOLDER, documentId = ""))
                // Capture is the shell's (`AddRequested`); the sheet goes.
                else -> Step(state.copy(sheet = none()))
            }
            DocsSheet.Kind.KIND_ROW_MENU -> rowAction(state, sheet.document_id, key)
            else -> Step(state)
        }
    }

    private fun rowAction(state: DocsDriveState, documentId: String, key: String): Step<DocsDriveState> {
        val row = row(state, documentId) ?: return Step(state.copy(sheet = none()))
        val closed = state.copy(sheet = none())
        return when (key) {
            DocsWrites.KEY_STAR, DocsWrites.KEY_UNSTAR -> {
                val command = if (key == DocsWrites.KEY_STAR) DocsWrites.STAR else DocsWrites.UNSTAR
                WriteLaw.submit(Writes, closed, command, DocsWrites.documentOnly(documentId), InvokeKeys.of(command, documentId))
            }
            DocsWrites.KEY_RENAME -> DocsRenameLaw.opened(Rename, closed, documentId, row.title)
            DocsWrites.KEY_MOVE -> Step(openSheet(state, DocsSheet.Kind.KIND_MOVE, documentId))
            DocsWrites.KEY_LABELS -> Step(openSheet(state, DocsSheet.Kind.KIND_LABELS, documentId))
            DocsWrites.KEY_TRASH -> Step(
                closed.copy(
                    confirm = Confirm(
                        title = DocsCopy.TRASH_CONFIRM_TITLE,
                        body = DocsCopy.TRASH_CONFIRM_BODY,
                        confirm_label = DocsCopy.TRASH_CONFIRM,
                        destructive = true,
                    ),
                    confirm_document_id = documentId,
                ),
            )
            else -> Step(state)
        }
    }

    private fun labelAdded(state: DocsDriveState, raw: String): Step<DocsDriveState> {
        val sheet = state.sheet ?: return Step(state)
        val label = raw.trim()
        val row = row(state, sheet.document_id) ?: return Step(state)
        if (label.isEmpty() || row.labels.any { it.label == label }) return Step(withSheetText(state, ""))
        return WriteLaw.submit(
            Writes,
            withSheetText(state, ""),
            DocsWrites.TAG,
            DocsWrites.tag(row.document_id, label),
            InvokeKeys.of(DocsWrites.TAG, row.document_id, label),
        )
    }

    private fun folderCreated(state: DocsDriveState): Step<DocsDriveState> {
        val name = state.sheet?.new_folder?.name?.trim().orEmpty()
        if (state.sheet?.kind != DocsSheet.Kind.KIND_NEW_FOLDER || name.isEmpty()) return Step(state)
        val parent = parentForNewFolder(state)
        return WriteLaw.submit(
            Writes,
            state.copy(sheet = none()),
            DocsWrites.CREATE_FOLDER,
            DocsWrites.createFolder(name, parent),
            InvokeKeys.of(DocsWrites.CREATE_FOLDER, parent.ifEmpty { DocsWrites.KEY_TOP_LEVEL }, name),
        )
    }

    /** A new folder lands inside the folder open, else at the top level. */
    private fun parentForNewFolder(state: DocsDriveState): String =
        if (state.destination == DocsDriveState.Destination.DESTINATION_FOLDERS) state.folder_id else ""

    private fun permission(state: DocsDriveState, changed: DocsDriveEvent.PermissionChanged): DocsDriveState {
        val capture = state.capture ?: DocsCapture()
        return state.copy(
            capture = when (changed.surface) {
                DocsDriveEvent.PermissionChanged.Surface.SURFACE_CAMERA -> capture.copy(camera = changed.permission)
                DocsDriveEvent.PermissionChanged.Surface.SURFACE_FILES -> capture.copy(files = changed.permission)
                else -> capture
            },
        )
    }

    /** A sheet of [kind]; [decorate] fills its body from the state. */
    private fun openSheet(state: DocsDriveState, kind: DocsSheet.Kind, documentId: String): DocsDriveState =
        when (kind) {
            DocsSheet.Kind.KIND_ROW_MENU, DocsSheet.Kind.KIND_MOVE, DocsSheet.Kind.KIND_LABELS ->
                if (documentId.isEmpty()) state else state.copy(sheet = DocsSheet(kind = kind, document_id = documentId))
            DocsSheet.Kind.KIND_NONE, DocsSheet.Kind.KIND_UNSPECIFIED -> state.copy(sheet = none())
            else -> state.copy(sheet = DocsSheet(kind = kind))
        }

    private fun withSheetText(state: DocsDriveState, text: String): DocsDriveState {
        val sheet = state.sheet ?: return state
        return when {
            sheet.labels != null -> state.copy(sheet = sheet.copy(labels = sheet.labels.copy(draft = text)))
            sheet.new_folder != null -> state.copy(sheet = sheet.copy(new_folder = sheet.new_folder.copy(name = text)))
            else -> state
        }
    }

    private fun none(): DocsSheet = DocsSheet(kind = DocsSheet.Kind.KIND_NONE)

    // ---------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------

    private fun read(state: DocsDriveState): Step<DocsDriveState> = ReadGate.read(Gate, state)

    private fun gate(step: Step<DocsDriveState>): Step<DocsDriveState> = ReadGate.gated(Gate, step)

    private fun landed(
        state: DocsDriveState,
        fold: (DocsDriveState) -> Step<DocsDriveState>,
    ): Step<DocsDriveState> {
        val (settled, superseded) = ReadGate.landed(Gate, state)
        return superseded ?: fold(settled)
    }

    private fun row(state: DocsDriveState, documentId: String): DocsRowView? =
        Content.dataOf(state)?.rows?.firstOrNull { it.document_id == documentId }

    // ---------------------------------------------------------------------
    // Keys
    // ---------------------------------------------------------------------

    internal fun typeOf(key: String): DocsQuery.TypeFilter =
        TYPES.firstOrNull { it.first == key }?.second ?: DocsQuery.TypeFilter.TYPE_FILTER_UNSPECIFIED

    internal fun modifiedOf(key: String): DocsQuery.Modified =
        MODIFIED.firstOrNull { it.first == key }?.second ?: DocsQuery.Modified.MODIFIED_UNSPECIFIED

    internal fun sortOf(key: String): Pair<DocsQuery.Sort, Boolean>? = when (key) {
        SORT_CHANGED_DESC -> DocsQuery.Sort.SORT_CHANGED to false
        SORT_CHANGED_ASC -> DocsQuery.Sort.SORT_CHANGED to true
        SORT_NAME_ASC -> DocsQuery.Sort.SORT_NAME to true
        SORT_NAME_DESC -> DocsQuery.Sort.SORT_NAME to false
        SORT_KIND_ASC -> DocsQuery.Sort.SORT_KIND to true
        SORT_SIZE_DESC -> DocsQuery.Sort.SORT_SIZE to false
        else -> null
    }

    private fun sortKeyOf(query: DocsQuery): String = when (query.sort) {
        DocsQuery.Sort.SORT_NAME -> if (query.ascending) SORT_NAME_ASC else SORT_NAME_DESC
        DocsQuery.Sort.SORT_KIND -> SORT_KIND_ASC
        DocsQuery.Sort.SORT_SIZE -> SORT_SIZE_DESC
        else -> if (query.ascending) SORT_CHANGED_ASC else SORT_CHANGED_DESC
    }

    private val TYPES: List<Triple<String, DocsQuery.TypeFilter, String>> = listOf(
        Triple("pdf", DocsQuery.TypeFilter.TYPE_FILTER_PDF, DocsCopy.TYPE_PDF),
        Triple("image", DocsQuery.TypeFilter.TYPE_FILTER_IMAGE, DocsCopy.TYPE_IMAGE),
        Triple("word", DocsQuery.TypeFilter.TYPE_FILTER_WORD, DocsCopy.TYPE_WORD),
        Triple("spreadsheet", DocsQuery.TypeFilter.TYPE_FILTER_SPREADSHEET, DocsCopy.TYPE_SPREADSHEET),
        Triple("markdown", DocsQuery.TypeFilter.TYPE_FILTER_MARKDOWN, DocsCopy.TYPE_MARKDOWN),
        Triple("text", DocsQuery.TypeFilter.TYPE_FILTER_TEXT, DocsCopy.TYPE_TEXT),
        Triple("audio", DocsQuery.TypeFilter.TYPE_FILTER_AUDIO, DocsCopy.TYPE_AUDIO),
        Triple("video", DocsQuery.TypeFilter.TYPE_FILTER_VIDEO, DocsCopy.TYPE_VIDEO),
    )

    private val MODIFIED: List<Triple<String, DocsQuery.Modified, String>> = listOf(
        Triple("today", DocsQuery.Modified.MODIFIED_TODAY, DocsCopy.MODIFIED_TODAY),
        Triple("7d", DocsQuery.Modified.MODIFIED_LAST_7_DAYS, DocsCopy.MODIFIED_LAST_7_DAYS),
        Triple("30d", DocsQuery.Modified.MODIFIED_LAST_30_DAYS, DocsCopy.MODIFIED_LAST_30_DAYS),
        Triple("year", DocsQuery.Modified.MODIFIED_THIS_YEAR, DocsCopy.MODIFIED_THIS_YEAR),
    )

    private val SORTS: List<Triple<String, String, String>> = listOf(
        Triple(SORT_CHANGED_DESC, DocsCopy.SORT_CHANGED, DocsCopy.SORT_NEWEST),
        Triple(SORT_CHANGED_ASC, DocsCopy.SORT_CHANGED, DocsCopy.SORT_OLDEST),
        Triple(SORT_NAME_ASC, DocsCopy.SORT_NAME, DocsCopy.SORT_A_TO_Z),
        Triple(SORT_NAME_DESC, DocsCopy.SORT_NAME, DocsCopy.SORT_Z_TO_A),
        Triple(SORT_KIND_ASC, DocsCopy.SORT_KIND, DocsCopy.SORT_A_TO_Z),
        Triple(SORT_SIZE_DESC, DocsCopy.SORT_SIZE, DocsCopy.SORT_LARGEST),
    )

    // ---------------------------------------------------------------------
    // Decorate: everything a view draws that depends on this state
    // ---------------------------------------------------------------------

    private fun decorate(state: DocsDriveState): DocsDriveState {
        val denied = state.denied != null
        val query = state.query ?: DocsQuery()
        val filtering = state.destination != DocsDriveState.Destination.DESTINATION_RECENT
        val filtersActive = filtering && (
            query.type != DocsQuery.TypeFilter.TYPE_FILTER_UNSPECIFIED ||
                query.modified != DocsQuery.Modified.MODIFIED_UNSPECIFIED ||
                query.label.isNotEmpty()
            )
        val searching = activeTerm(state) != null
        val withData = state.data_?.let { state.copy(data_ = dataOf(state, it, filtersActive)) } ?: state
        return withData.copy(
            band = if (denied) emptyList() else band(state),
            pills = if (denied || searching || !filtering) emptyList() else pills(state, query),
            filters_active = filtersActive && !searching && !denied,
            chrome = chrome(state),
            sheet = sheetOf(withData),
            rename = state.rename?.let { it.copy(status_label = DocsRenameLaw.status(it)) },
            head_meta = headMeta(withData),
        )
    }

    private fun band(state: DocsDriveState): List<DocsBandTab> {
        fun tab(key: String, label: String, icon: String, destination: DocsDriveState.Destination) = DocsBandTab(
            key = key,
            label = label,
            icon_key = icon,
            current = state.destination == destination,
        )
        return listOf(
            tab(BAND_ALL, DocsCopy.BAND_ALL, "FileText", DocsDriveState.Destination.DESTINATION_ALL),
            tab(BAND_FOLDERS, DocsCopy.BAND_FOLDERS, "Folder", DocsDriveState.Destination.DESTINATION_FOLDERS),
            tab(BAND_STARRED, DocsCopy.BAND_STARRED, "Star", DocsDriveState.Destination.DESTINATION_STARRED),
            DocsBandTab(key = BAND_MORE, label = DocsCopy.BAND_MORE, icon_key = "more", current = false),
        )
    }

    private fun pills(state: DocsDriveState, query: DocsQuery): List<DocsPill> {
        val type = TYPES.firstOrNull { it.second == query.type }?.third
        val modified = MODIFIED.firstOrNull { it.second == query.modified }?.third
        val label = query.label.ifEmpty { null }
        val sort = SORTS.firstOrNull { it.first == sortKeyOf(query) }
        fun pill(kind: DocsSheet.Kind, name: String, chosen: String?) = DocsPill(
            key = kind,
            label = chosen ?: name,
            active = chosen != null,
            accessibility_label = if (chosen == null) name else "$name, $chosen",
        )
        return listOf(
            pill(DocsSheet.Kind.KIND_TYPE, DocsCopy.FILTER_TYPE, type),
            pill(DocsSheet.Kind.KIND_MODIFIED, DocsCopy.FILTER_MODIFIED, modified),
            // No label in the drive: no Label pill to open an empty sheet.
            *(if ((state.rail?.labels.isNullOrEmpty()) && label == null) {
                emptyArray()
            } else {
                arrayOf(pill(DocsSheet.Kind.KIND_LABEL, DocsCopy.FILTER_LABEL, label))
            }),
            DocsPill(
                key = DocsSheet.Kind.KIND_SORT,
                label = sort?.let { "${it.second} · ${it.third}" } ?: DocsCopy.SORT,
                // The order is always set; it is a control, not a filter.
                active = false,
                accessibility_label = "${DocsCopy.SORT}, ${sort?.second ?: ""} ${sort?.third ?: ""}".trim(),
            ),
        )
    }

    private fun chrome(state: DocsDriveState): DocsDriveChrome = DocsDriveChrome(
        title = when {
            state.destination == DocsDriveState.Destination.DESTINATION_FOLDERS && state.folder_id.isNotEmpty() ->
                state.folder_name.ifEmpty { DocsCopy.BAND_FOLDERS }
            state.destination == DocsDriveState.Destination.DESTINATION_RECENT -> DocsCopy.MORE_RECENT
            else -> DocsCopy.APP_TITLE
        },
        home = DocsCopy.BAND_HOME,
        search_label = DocsCopy.SEARCH_LABEL,
        search_placeholder = DocsCopy.SEARCH_PLACEHOLDER,
        search_close = DocsCopy.SEARCH_CLOSE,
        retry = DocsCopy.RETRY,
        loading = DocsCopy.LOADING,
        add = DocsCopy.ADD,
        layout_toggle = if (state.layout == DocsDriveState.Layout.LAYOUT_GRID) DocsCopy.LAYOUT_TO_LIST else DocsCopy.LAYOUT_TO_GRID,
        layout_icon_key = if (state.layout == DocsDriveState.Layout.LAYOUT_GRID) "List" else "Grid",
        filters_clear_label = DocsCopy.CLEAR_FILTERS,
        row_menu = DocsCopy.MORE,
        starred = DocsCopy.STARRED,
        rename_placeholder = DocsCopy.RENAME_PLACEHOLDER,
        rename_done = DocsCopy.DONE,
    )

    /** The data as drawn: the folder level, the crumbs, the empty choice, a closing rename's title. */
    private fun dataOf(state: DocsDriveState, data: DocsDriveData, filtersActive: Boolean): DocsDriveData {
        val search = data.mode == DocsDriveData.Mode.MODE_SEARCH
        val inFolders = state.destination == DocsDriveState.Destination.DESTINATION_FOLDERS && !search
        val all = state.rail?.folders.orEmpty()
        val folders = if (inFolders) all.filter { it.parent_id == state.folder_id } else emptyList()
        val rename = state.rename
        val rows = if (rename == null) {
            data.rows
        } else {
            data.rows.map { if (it.document_id == rename.document_id) it.copy(title = rename.title) else it }
        }
        val nothing = rows.isEmpty() && folders.isEmpty()
        val (empty, action) = if (!nothing) {
            null to DocsDriveData.EmptyAction.EMPTY_ACTION_NONE
        } else {
            emptyOf(state, search, filtersActive)
        }
        return data.copy(
            rows = rows,
            folders = folders,
            crumbs = if (inFolders) DocsFold.crumbs(all, state.folder_id) else emptyList(),
            empty = empty,
            empty_action = action,
            shelf_note = if (state.destination == DocsDriveState.Destination.DESTINATION_RECENT && !search) {
                DocsCopy.RECENT_RULE
            } else {
                ""
            },
            // Search is not windowed; only a shelf can be cut short.
            truncated_note = if (search) "" else data.truncated_note,
        )
    }

    private fun emptyOf(
        state: DocsDriveState,
        search: Boolean,
        filtersActive: Boolean,
    ): Pair<EmptyState, DocsDriveData.EmptyAction> = when {
        search -> EmptyState(headline = DocsCopy.EMPTY_SEARCH, body = DocsCopy.EMPTY_SEARCH_BODY) to
            DocsDriveData.EmptyAction.EMPTY_ACTION_NONE
        filtersActive -> EmptyState(headline = DocsCopy.EMPTY_FILTERED, action_label = DocsCopy.CLEAR_FILTERS) to
            DocsDriveData.EmptyAction.EMPTY_ACTION_CLEAR_FILTERS
        else -> when (state.destination) {
            DocsDriveState.Destination.DESTINATION_STARRED ->
                EmptyState(headline = DocsCopy.EMPTY_STARRED, body = DocsCopy.EMPTY_STARRED_BODY) to
                    DocsDriveData.EmptyAction.EMPTY_ACTION_NONE
            DocsDriveState.Destination.DESTINATION_RECENT ->
                EmptyState(headline = DocsCopy.EMPTY_RECENT, action_label = DocsCopy.EMPTY_ALL_ACTION) to
                    DocsDriveData.EmptyAction.EMPTY_ACTION_ADD
            DocsDriveState.Destination.DESTINATION_FOLDERS ->
                if (state.folder_id.isEmpty()) {
                    EmptyState(headline = DocsCopy.EMPTY_FOLDERS, action_label = DocsCopy.EMPTY_FOLDERS_ACTION) to
                        DocsDriveData.EmptyAction.EMPTY_ACTION_NEW_FOLDER
                } else {
                    EmptyState(headline = DocsCopy.EMPTY_FOLDER, action_label = DocsCopy.EMPTY_ALL_ACTION) to
                        DocsDriveData.EmptyAction.EMPTY_ACTION_ADD
                }
            else -> EmptyState(headline = DocsCopy.EMPTY_ALL, action_label = DocsCopy.EMPTY_ALL_ACTION) to
                DocsDriveData.EmptyAction.EMPTY_ACTION_ADD
        }
    }

    private fun headMeta(state: DocsDriveState): String {
        val data = Content.dataOf(state) ?: return ""
        val rail = state.rail
        return when {
            data.mode == DocsDriveData.Mode.MODE_SEARCH -> DocsFold.countLabel(data.rows.size)
            state.destination == DocsDriveState.Destination.DESTINATION_ALL && rail != null ->
                DocsFold.countLabel(rail.all_count)
            state.destination == DocsDriveState.Destination.DESTINATION_STARRED && rail != null ->
                DocsFold.countLabel(rail.starred_count)
            state.destination == DocsDriveState.Destination.DESTINATION_FOLDERS && state.folder_id.isEmpty() && rail != null ->
                DocsFold.countLabel(rail.unfiled_count)
            else -> DocsFold.countLabel(data.rows.size)
        }
    }

    /** The open sheet's body, rebuilt from the state so it follows every re-read. */
    private fun sheetOf(state: DocsDriveState): DocsSheet {
        val sheet = state.sheet ?: return none()
        val query = state.query ?: DocsQuery()
        val base = DocsSheet(kind = sheet.kind, document_id = sheet.document_id, close_label = DocsCopy.CLOSE)
        return when (sheet.kind) {
            DocsSheet.Kind.KIND_MORE -> base.copy(
                title = DocsCopy.MORE_TITLE,
                actions = DocsActionList(
                    actions = listOf(
                        DocsFold.action(DocsWrites.KEY_RECENT, DocsCopy.MORE_RECENT, "Clock"),
                        DocsFold.action(
                            DocsWrites.KEY_TRASH_SHELF,
                            DocsCopy.MORE_TRASH,
                            "trash",
                            detail = state.rail?.trash_count?.takeIf { it > 0 }?.let(DocsFold::countLabel) ?: "",
                        ),
                    ),
                ),
            )
            DocsSheet.Kind.KIND_ADD -> base.copy(title = DocsCopy.ADD_TITLE, actions = DocsActionList(actions = addRows(state)))
            DocsSheet.Kind.KIND_TYPE -> base.copy(
                title = DocsCopy.FILTER_TYPE,
                choices = DocsChoiceList(
                    choices = listOf(choice(KEY_ANY, DocsCopy.TYPE_ANY, query.type == DocsQuery.TypeFilter.TYPE_FILTER_UNSPECIFIED)) +
                        TYPES.map { (key, type, label) -> choice(key, label, query.type == type) },
                ),
            )
            DocsSheet.Kind.KIND_MODIFIED -> base.copy(
                title = DocsCopy.FILTER_MODIFIED,
                choices = DocsChoiceList(
                    choices = listOf(choice(KEY_ANY, DocsCopy.MODIFIED_ANY, query.modified == DocsQuery.Modified.MODIFIED_UNSPECIFIED)) +
                        MODIFIED.map { (key, modified, label) -> choice(key, label, query.modified == modified) },
                ),
            )
            DocsSheet.Kind.KIND_LABEL -> base.copy(
                title = DocsCopy.FILTER_LABEL,
                choices = DocsChoiceList(
                    choices = listOf(choice(KEY_ANY, DocsCopy.LABEL_ANY, query.label.isEmpty())) +
                        state.rail?.labels.orEmpty().map { choice(it, it, query.label == it) },
                ),
            )
            DocsSheet.Kind.KIND_SORT -> base.copy(
                title = DocsCopy.SORT,
                choices = DocsChoiceList(
                    choices = SORTS.map { (key, label, detail) ->
                        DocsChoice(key = key, label = label, detail = detail, selected = sortKeyOf(query) == key)
                    },
                ),
            )
            DocsSheet.Kind.KIND_ROW_MENU -> {
                val row = row(state, sheet.document_id) ?: return none()
                base.copy(title = row.title, actions = DocsActionList(actions = DocsFold.menu(row.starred)))
            }
            DocsSheet.Kind.KIND_MOVE -> {
                val row = row(state, sheet.document_id) ?: return none()
                base.copy(
                    title = DocsCopy.MOVE_TITLE,
                    choices = DocsChoiceList(choices = moveChoices(state.rail?.folders.orEmpty(), row.folder_id)),
                )
            }
            DocsSheet.Kind.KIND_LABELS -> {
                val row = row(state, sheet.document_id) ?: return none()
                base.copy(title = DocsCopy.LABELS_TITLE, labels = labelsSheet(row, state.rail?.labels.orEmpty(), sheet.labels?.draft ?: ""))
            }
            DocsSheet.Kind.KIND_NEW_FOLDER -> {
                val name = sheet.new_folder?.name ?: ""
                val parent = parentForNewFolder(state)
                base.copy(
                    title = DocsCopy.NEW_FOLDER_TITLE,
                    new_folder = DocsNewFolderSheet(
                        name = name,
                        placeholder = DocsCopy.FOLDER_PLACEHOLDER,
                        create_label = DocsCopy.CREATE,
                        can_create = name.isNotBlank(),
                        where_label = if (parent.isEmpty()) {
                            DocsCopy.WHERE_TOP
                        } else {
                            "${DocsCopy.WHERE_IN} ${state.folder_name.ifEmpty { DocsCopy.BAND_FOLDERS }}"
                        },
                    ),
                )
            }
            else -> none()
        }
    }

    /** The Add sheet: what the OS lets the shell offer (law 4), and a folder. */
    private fun addRows(state: DocsDriveState): List<DocsAction> {
        val capture = state.capture ?: DocsCapture()
        fun gated(
            key: String,
            label: String,
            icon: String,
            permission: DocsCapture.Permission,
            denied: String,
            restricted: String,
        ): DocsAction? = when (permission) {
            DocsCapture.Permission.PERMISSION_UNAVAILABLE -> null
            DocsCapture.Permission.PERMISSION_DENIED -> DocsFold.action(key, label, icon, enabled = false, detail = denied)
            DocsCapture.Permission.PERMISSION_RESTRICTED -> DocsFold.action(key, label, icon, enabled = false, detail = restricted)
            else -> DocsFold.action(key, label, icon)
        }
        return listOfNotNull(
            gated(DocsWrites.KEY_UPLOAD, DocsCopy.ADD_UPLOAD, "Upload", capture.files, DocsCopy.FILES_DENIED, DocsCopy.FILES_RESTRICTED),
            gated(DocsWrites.KEY_SCAN, DocsCopy.ADD_SCAN, "Camera", capture.camera, DocsCopy.CAMERA_DENIED, DocsCopy.CAMERA_RESTRICTED),
            DocsFold.action(DocsWrites.KEY_TEXT, DocsCopy.ADD_TEXT, "FileText"),
            DocsFold.action(DocsWrites.KEY_NEW_FOLDER, DocsCopy.ADD_FOLDER, "FolderPlus"),
        )
    }

    internal fun moveChoices(folders: List<centraid.screen.v1.DocsFolderNode>, current: String): List<DocsChoice> {
        val byId = folders.associateBy { it.folder_id }
        fun path(node: centraid.screen.v1.DocsFolderNode): String {
            val names = mutableListOf(node.name)
            var parent = node.parent_id
            while (parent.isNotEmpty() && names.size <= folders.size) {
                val up = byId[parent] ?: break
                names += up.name
                parent = up.parent_id
            }
            return names.reversed().joinToString(" / ")
        }
        return listOf(DocsChoice(key = DocsWrites.KEY_TOP_LEVEL, label = DocsCopy.MOVE_TOP, selected = current.isEmpty())) +
            folders.map { DocsChoice(key = it.folder_id, label = path(it), selected = it.folder_id == current) }
                .sortedBy { it.label.lowercase() }
    }

    internal fun labelsSheet(row: DocsRowView, drive: List<String>, draft: String): DocsLabelsSheet {
        val on = row.labels.map { it.label }.toSet()
        val typed = draft.trim()
        return DocsLabelsSheet(
            current = row.labels,
            available = drive.filterNot { it in on },
            draft = draft,
            can_add = typed.isNotEmpty() && typed !in on,
            add_label = DocsCopy.LABEL_ADD,
            placeholder = DocsCopy.LABEL_PLACEHOLDER,
            remove_label = DocsCopy.LABEL_REMOVE,
        )
    }

    private fun choice(key: String, label: String, selected: Boolean) = DocsChoice(key = key, label = label, selected = selected)

    // ---------------------------------------------------------------------
    // Lenses
    // ---------------------------------------------------------------------

    internal object Content : ContentLens<DocsDriveState, DocsDriveData> {
        override fun content(state: DocsDriveState): ReadContent<DocsDriveData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: DocsDriveState, content: ReadContent<DocsDriveData>): DocsDriveState = when (content) {
            is ReadContent.Loading -> state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
            is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
            is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
            is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
        }
    }

    private object Band : BandLens<DocsDriveState, DocsDriveState.Destination> {
        override fun destination(state: DocsDriveState): DocsDriveState.Destination = state.destination

        override fun with(state: DocsDriveState, destination: DocsDriveState.Destination): DocsDriveState =
            state.copy(destination = destination)
    }

    private object Search : SearchLens<DocsDriveState> {
        override val screenId: String = SCREEN_ID

        override fun field(state: DocsDriveState): SearchField = state.search ?: SearchField()

        override fun with(state: DocsDriveState, field: SearchField): DocsDriveState = state.copy(search = field)
    }

    private object Writes : WriteLens<DocsDriveState> {
        override fun write(state: DocsDriveState): WriteState = state.write ?: WriteState()

        override fun with(state: DocsDriveState, write: WriteState): DocsDriveState = state.copy(write = write)
    }

    private object Rename : RenameSlot<DocsDriveState> {
        override val screenId: String = SCREEN_ID

        override fun rename(state: DocsDriveState): DocsRename? = state.rename

        override fun with(state: DocsDriveState, rename: DocsRename?): DocsDriveState = state.copy(rename = rename)
    }

    private object Gate : ReadGateLens<DocsDriveState> {
        override val screenId: String = SCREEN_ID

        override fun reading(state: DocsDriveState): Boolean = state.reading

        override fun queued(state: DocsDriveState): Boolean = state.read_queued

        override fun with(state: DocsDriveState, reading: Boolean, queued: Boolean): DocsDriveState =
            state.copy(reading = reading, read_queued = queued)
    }

    /** The denied gate's words, as the kit's arm carries them. */
    internal fun deniedOf(): Denied = Denied(title = DocsCopy.DENIED_TITLE, body = DocsCopy.DENIED_BODY)
}
