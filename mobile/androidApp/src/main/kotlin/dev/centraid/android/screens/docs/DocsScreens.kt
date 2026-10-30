package dev.centraid.android.screens.docs

import dev.centraid.android.kit.SearchAskRow
import android.graphics.Bitmap
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import centraid.core.v1.DocsAction
import centraid.core.v1.DocsCrumb
import centraid.core.v1.DocsDestination
import centraid.core.v1.DocsDocumentEvent
import centraid.core.v1.DocsDocumentState
import centraid.core.v1.DocsDriveData
import centraid.core.v1.DocsDriveEvent
import centraid.core.v1.DocsDriveState
import centraid.core.v1.DocsEditorEvent
import centraid.core.v1.DocsEditorState
import centraid.core.v1.DocsFolderNode
import centraid.core.v1.DocsIngestView
import centraid.core.v1.DocsRename
import centraid.core.v1.DocsRowView
import centraid.core.v1.DocsSheet
import centraid.core.v1.DocsStage
import centraid.core.v1.DocsVersionsEvent
import centraid.core.v1.DocsVersionsState
import centraid.core.v1.Route
import dev.centraid.android.kit.SearchField
import dev.centraid.android.kit.SectionHead
import centraid.core.v1.StatusChip
import dev.centraid.android.kit.AppBand
import dev.centraid.android.kit.AppBandTab
import dev.centraid.android.kit.AppPlace
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.CentraidSearchField
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.EditableFieldRow
import dev.centraid.android.kit.EditorRoom
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.FieldRow
import dev.centraid.android.kit.IconKey
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.OptionSheet
import dev.centraid.android.kit.OutlineButton
import dev.centraid.android.kit.ProgressStatusLine
import dev.centraid.android.kit.PushedPage
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RoomAction
import dev.centraid.android.kit.RoomChip
import dev.centraid.android.kit.RoomChipRow
import dev.centraid.android.kit.RoomSearchOpener
import dev.centraid.android.kit.RoomSearch
import dev.centraid.android.kit.RowSkeleton
import dev.centraid.android.kit.SearchContainerRow
import dev.centraid.android.kit.SectionHeader
import dev.centraid.android.kit.SheetOption
import dev.centraid.android.kit.SheetPrimary
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.SheetRow
import dev.centraid.android.kit.StatusLine
import dev.centraid.android.kit.screenContentOf
import dev.centraid.android.screens.photos.LightboxTransport
import dev.centraid.android.screens.photos.PlayerSurface
import dev.centraid.android.screens.decodeUpright
import dev.centraid.android.screens.photos.rememberLightboxPlayer
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/*
 * DOCS' VIEWS (#1046, #1135). Every word, chip, enabled flag and sheet is
 * Rust's (`crates/screens/src/docs`); the view forwards what the member did, and
 * a row, a folder, a crumb or a sheet row that opens a page carries its `Route`,
 * which a tap hands to `onOpen`.
 */

// ---------------------------------------------------------------------------
// The sheets both pages share
// ---------------------------------------------------------------------------

/** What a sheet can send, for whichever page it is on. */
internal class DocsSheetActions(
    val onAction: (DocsAction) -> Unit,
    val onChoice: (String) -> Unit,
    val onLabelAdded: (String) -> Unit,
    val onLabelRemoved: (String) -> Unit,
    val onLabelDraft: (String) -> Unit,
    val onFolderName: (String) -> Unit = {},
    val onFolderCreated: () -> Unit = {},
    val onClose: () -> Unit,
)

@Composable
internal fun DocsSheetView(sheet: DocsSheet?, actions: DocsSheetActions) {
    if (sheet == null || sheet.kind == DocsSheet.Kind.KIND_NONE || sheet.kind == DocsSheet.Kind.KIND_UNSPECIFIED) return
    val list = sheet.actions
    val choices = sheet.choices
    val labels = sheet.labels
    val folder = sheet.new_folder
    when {
        choices != null -> OptionSheet(
            title = sheet.title,
            options = choices.choices.map { SheetOption(key = it.key, label = it.label, detail = it.detail, selected = it.selected) },
            onPick = actions.onChoice,
            onDismiss = actions.onClose,
        )
        list != null -> SheetRoom(title = sheet.title, onDismiss = actions.onClose) {
            list.actions.forEach { action ->
                SheetRow(
                    label = action.label,
                    iconKey = action.icon_key.ifEmpty { null },
                    detail = action.detail,
                    destructive = action.destructive,
                    testTag = "docs-action-${action.key}",
                    onTap = { if (action.enabled) actions.onAction(action) },
                )
            }
            SheetNote(list.footer)
        }
        labels != null -> SheetRoom(title = sheet.title, onDismiss = actions.onClose) {
            labels.current.forEach { chip ->
                SheetRow(
                    label = chip.label,
                    detail = labels.remove_label,
                    iconKey = "Tag",
                    testTag = "docs-label-${chip.tag_id}",
                    onTap = { actions.onLabelRemoved(chip.tag_id) },
                )
            }
            EditableFieldRow(
                key = "",
                value = labels.draft,
                reload = labels.draft.isEmpty(),
                placeholder = labels.placeholder,
                testTag = "docs-label-draft",
                onEdit = actions.onLabelDraft,
            )
            if (labels.can_add && labels.add_label.isNotEmpty()) {
                OutlineButton(label = labels.add_label, testTag = "docs-label-add", modifier = Modifier.padding(horizontal = KitGeometry.GUTTER)) {
                    actions.onLabelAdded(labels.draft.trim())
                }
            }
            labels.available.forEach { label ->
                SheetRow(label = label, iconKey = "Plus", testTag = "docs-label-offer", onTap = { actions.onLabelAdded(label) })
            }
        }
        folder != null -> SheetRoom(
            title = sheet.title,
            onDismiss = actions.onClose,
            primary = if (folder.create_label.isNotEmpty()) {
                SheetPrimary(
                    label = folder.create_label,
                    testTag = "docs-folder-create",
                    enabled = folder.can_create,
                    onPress = actions.onFolderCreated,
                )
            } else {
                null
            },
        ) {
            EditableFieldRow(
                key = folder.where_label,
                value = folder.name,
                reload = folder.name.isEmpty(),
                placeholder = folder.placeholder,
                testTag = "docs-folder-name",
                onEdit = actions.onFolderName,
            )
        }
    }
}

@Composable
private fun ColumnScope.SheetNote(text: String) {
    if (text.isEmpty()) return
    Text(
        text,
        style = centraidType("annotLabel"),
        color = centraidColor("textSoft"),
        modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
    )
}

/** AN INLINE RENAME: the title field, its status, and Done (close = done). */
@Composable
internal fun RenameLine(rename: DocsRename?, placeholder: String, doneLabel: String, onEdit: (String) -> Unit, onDone: () -> Unit) {
    if (rename == null) return
    Row(Modifier.fillMaxWidth().testTag("docs-rename"), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.weight(1f)) {
            EditableFieldRow(
                key = "",
                value = rename.title,
                // Seeded once per rename, never under the member's thumbs.
                reload = rename.document_id,
                placeholder = placeholder,
                testTag = "docs-rename-field",
                onEdit = onEdit,
            )
        }
        OutlineButton(label = doneLabel.ifEmpty { KitWords.DONE }, testTag = "docs-rename-done", onPress = onDone)
    }
    StatusLine(rename.status_label)
}

// ---------------------------------------------------------------------------
// docs.drive — All · Folders · Starred, More as a sheet; a folder as a page
// ---------------------------------------------------------------------------

@Composable
internal fun DocsDriveScreen(
    state: DocsDriveState,
    onEvent: (DocsDriveEvent) -> Unit,
    onOpen: (Route) -> Unit,
    onHome: () -> Unit,
    onBack: () -> Unit,
) {
    val chrome = state.chrome
    // A FOLDER IS A PUSHED PAGE; the drive at its tab is a room with the band.
    val folderPage = state.destination == DocsDestination.DOCS_DESTINATION_FOLDERS && state.folder_id.isNotEmpty()
    // ADDING A DOCUMENT: the ingest's own line in the room's status host —
    // its words, a determinate bar while bytes move, Try again and Dismiss
    // after a failure. Every word is `DocsIngestView`'s.
    val adding: (@Composable () -> Unit)? = state.ingest?.takeIf { it.status_label.isNotEmpty() }?.let { line ->
        {
            val moving = line.phase == DocsIngestView.Phase.PHASE_PICKING || line.phase == DocsIngestView.Phase.PHASE_FILING
            ProgressStatusLine(
                sentence = line.status_label,
                permille = if (moving) line.progress_permille else null,
                refused = line.phase == DocsIngestView.Phase.PHASE_FAILED,
                actionLabel = line.retry_label,
                onAct = { onEvent(DocsDriveEvent(ingest_retried = DocsDriveEvent.IngestRetried())) },
                closeLabel = line.dismiss_label,
                onClose = { onEvent(DocsDriveEvent(ingest_dismissed = DocsDriveEvent.IngestDismissed())) },
                testTag = "docs-ingest",
            )
        }
    }
    val add = chrome?.add?.takeIf { it.isNotEmpty() }?.let { label ->
        RoomAction("Plus", label, "docs-add") { onEvent(DocsDriveEvent(sheet_opened = DocsDriveEvent.SheetOpened(kind = DocsSheet.Kind.KIND_ADD))) }
    }
    // THE CHIP ROW (R-CHROME-3), Rust's pills as they come: the
    // filters, Clear while one is set, the sort last.
    val chips = if (state.denied != null) {
        emptyList<RoomChip>()
    } else {
        state.pills.map { pill ->
            RoomChip(
                testTag = if (pill.clears) "docs-clear-filters" else "docs-pill-${pill.key.value}",
                label = pill.label,
                selected = pill.active,
                chevron = pill.chevron,
                spoken = pill.accessibility_label,
            ) {
                if (pill.clears) {
                    onEvent(DocsDriveEvent(filters_cleared = DocsDriveEvent.FiltersCleared()))
                } else {
                    onEvent(DocsDriveEvent(sheet_opened = DocsDriveEvent.SheetOpened(kind = pill.key)))
                }
            }
        }
    }
    val search = RoomSearch(
        field = SearchField(open_ = state.search?.open_ ?: false, term = state.search?.term.orEmpty(), corrected = state.search?.corrected.orEmpty(), corrected_label = state.search?.corrected_label.orEmpty()),
        placeholder = chrome?.search_placeholder.orEmpty(),
        onTerm = { onEvent(DocsDriveEvent(search_term = DocsDriveEvent.SearchTermChanged(term = it))) },
        onClose = { onEvent(DocsDriveEvent(search_closed = DocsDriveEvent.SearchClosed())) },
        label = chrome?.search_label.orEmpty().ifEmpty { KitWords.SEARCH },
        closeLabel = chrome?.search_close.orEmpty().ifEmpty { KitWords.CLOSE_SEARCH },
        onOpen = { onEvent(DocsDriveEvent(search_opened = DocsDriveEvent.SearchOpened())) },
    )
    if (folderPage) {
        // A FOLDER PAGE IS NOT A ROOM, so it draws the room's search bar and
        // chip row itself, in the room's order.
        val body: @Composable () -> Unit = {
            Column(Modifier.fillMaxSize()) {
                if (search.field.open_) {
                    CentraidSearchField(
                        field = search.field,
                        placeholder = search.placeholder,
                        onTerm = search.onTerm,
                        onClose = search.onClose,
                        label = search.label,
                        closeLabel = search.closeLabel,
                    )
                } else if (state.denied == null) {
                    RoomSearchOpener(search.placeholder, testTag = "docs-search-open", onOpen = search.onOpen)
                }
                if (chips.isNotEmpty()) RoomChipRow("docs", chips)
                Box(Modifier.weight(1f)) { DriveBody(state, onEvent, onOpen) }
                SearchAskRow(state.search?.ask_row, onOpen)
            }
        }
        PushedPage(
            title = state.folder_name,
            // RUST NAMES THE PARENT (`chrome.back`, #1047).
            parentTitle = chrome?.back.orEmpty(),
            onBack = onBack,
            trailing = add,
            status = state.status?.sentence.orEmpty(),
            statusLine = adding,
            content = body,
        )
    } else {
        AppPlace(
            app = "docs",
            title = chrome?.title.orEmpty(),
            meta = state.head_meta,
            trailing = add,
            search = search,
            chips = chips,
            status = state.status?.sentence.orEmpty(),
            statusLine = adding,
            band = {
                // MORE IS ONE OF RUST'S TABS (R-CHROME-4), drawn as a
                // tab and not as the kit's More.
                AppBand(
                    app = "docs",
                    tabs = state.band.map {
                        AppBandTab(key = it.key, label = it.label, iconKey = it.icon_key, selected = it.current)
                    },
                    onSelect = { key -> onEvent(DocsDriveEvent(band = DocsDriveEvent.BandPicked(key = key))) },
                    onHome = onHome,
                )
            },
            content = {
                Column(Modifier.fillMaxSize()) {
                    Box(Modifier.weight(1f)) { DriveBody(state, onEvent, onOpen) }
                    // THE ASK ROW closes a search's answer (#1097).
                    SearchAskRow(state.search?.ask_row, onOpen)
                }
            },
        )
    }
    DocsSheetView(
        state.sheet,
        DocsSheetActions(
            // A row that opens a page carries its route: Rust is told, then the shell pushes.
            onAction = { action ->
                onEvent(DocsDriveEvent(action = DocsDriveEvent.ActionPicked(key = action.key)))
                action.route?.let(onOpen)
            },
            onChoice = { key -> onEvent(DocsDriveEvent(choice = DocsDriveEvent.ChoicePicked(key = key))) },
            onLabelAdded = { onEvent(DocsDriveEvent(label_added = DocsDriveEvent.LabelAdded(label = it))) },
            onLabelRemoved = { onEvent(DocsDriveEvent(label_removed = DocsDriveEvent.LabelRemoved(tag_id = it))) },
            onLabelDraft = { onEvent(DocsDriveEvent(label_draft = DocsDriveEvent.LabelDraftEdited(text = it))) },
            onFolderName = { onEvent(DocsDriveEvent(folder_name = DocsDriveEvent.FolderNameEdited(name = it))) },
            onFolderCreated = { onEvent(DocsDriveEvent(folder_created = DocsDriveEvent.FolderCreated())) },
            onClose = { onEvent(DocsDriveEvent(sheet_closed = DocsDriveEvent.SheetClosed())) },
        ),
    )
    val confirm = state.confirm
    if (confirm != null) {
        ConfirmSheet(
            confirm = confirm,
            onConfirm = { onEvent(DocsDriveEvent(confirmed = DocsDriveEvent.Confirmed())) },
            onDismiss = { onEvent(DocsDriveEvent(dismissed = DocsDriveEvent.Dismissed())) },
        )
    }
}

@Composable
private fun DriveBody(state: DocsDriveState, onEvent: (DocsDriveEvent) -> Unit, onOpen: (Route) -> Unit) {
    val chrome = state.chrome
    Column(Modifier.fillMaxSize()) {
        // THE LAYOUT TOGGLE, at the list's head. Search and the chips are
        // the room's (R-CHROME-2/3), drawn above.
        if (state.denied == null && chrome?.layout_toggle.orEmpty().isNotEmpty()) {
            Row(Modifier.fillMaxWidth().padding(end = 4.dp), horizontalArrangement = Arrangement.End) {
                IconKey(chrome!!.layout_icon_key.ifEmpty { "Grid" }, chrome.layout_toggle, "docs-layout", bordered = false) {
                    onEvent(DocsDriveEvent(layout_toggled = DocsDriveEvent.LayoutToggled()))
                }
            }
        }
        RenameLine(
            state.rename,
            chrome?.rename_placeholder.orEmpty(),
            chrome?.rename_done.orEmpty(),
            onEdit = { onEvent(DocsDriveEvent(rename_edited = DocsDriveEvent.RenameEdited(title = it))) },
            onDone = { onEvent(DocsDriveEvent(rename_closed = DocsDriveEvent.RenameClosed())) },
        )
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
            onRetry = { onEvent(DocsDriveEvent(refreshed = DocsDriveEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty().ifEmpty { KitWords.RETRY },
            skeleton = { RowSkeleton(label = chrome?.loading.orEmpty().ifEmpty { KitWords.OPENING }) },
        ) { data -> DriveData(state, data, onEvent, onOpen) }
    }
}

@Composable
private fun DriveData(
    state: DocsDriveState,
    data: DocsDriveData,
    onEvent: (DocsDriveEvent) -> Unit,
    onOpen: (Route) -> Unit,
) {
    val empty = data.empty
    // THE FOLDERS WHOSE NAME MATCHED (#1097) come before the documents; a tap pushes each one's route.
    val containers = data.containers
    if (data.rows.isEmpty() && data.folders.isEmpty() && containers.isEmpty() && empty != null) {
        EmptyStateView(
            empty,
            onAction = when (data.empty_action) {
                DocsDriveData.EmptyAction.EMPTY_ACTION_ADD -> {
                    { onEvent(DocsDriveEvent(sheet_opened = DocsDriveEvent.SheetOpened(kind = DocsSheet.Kind.KIND_ADD))) }
                }
                DocsDriveData.EmptyAction.EMPTY_ACTION_CLEAR_FILTERS -> {
                    { onEvent(DocsDriveEvent(filters_cleared = DocsDriveEvent.FiltersCleared())) }
                }
                DocsDriveData.EmptyAction.EMPTY_ACTION_NEW_FOLDER -> {
                    { onEvent(DocsDriveEvent(sheet_opened = DocsDriveEvent.SheetOpened(kind = DocsSheet.Kind.KIND_NEW_FOLDER))) }
                }
                else -> null
            },
        )
        return
    }
    val openMenu = { row: DocsRowView ->
        onEvent(DocsDriveEvent(row_menu = DocsDriveEvent.RowMenuOpened(document_id = row.document_id)))
    }
    val chrome = state.chrome
    if (state.layout == DocsDriveState.Layout.LAYOUT_GRID) {
        LazyVerticalGrid(columns = GridCells.Adaptive(150.dp), modifier = Modifier.fillMaxSize()) {
            item(span = { GridItemSpan(maxLineSpan) }, key = "head") { DriveHead(data, onOpen) }
            items(containers, span = { GridItemSpan(maxLineSpan) }, key = { "c-${it.entity}-${it.id}" }) { container ->
                SearchContainerRow(container, onOpen = onOpen)
            }
            items(data.folders, key = { "f-" + it.folder_id }) { folder ->
                Tile(folder.name, folder.count_label, "Folder", folder.accessibility_label, "docs-folder-${folder.folder_id}", null, null) {
                    folder.route?.let(onOpen)
                }
            }
            items(data.rows, key = { "d-" + it.document_id }) { row ->
                Tile(row.title, row.meta, row.kind_icon_key, row.accessibility_label, "docs-row-${row.document_id}", chrome?.row_menu, { openMenu(row) }) {
                    row.route?.let(onOpen)
                }
            }
            item(span = { GridItemSpan(maxLineSpan) }, key = "foot") { DriveFoot(data) }
        }
    } else {
        LazyColumn(Modifier.fillMaxSize()) {
            item(key = "head") { DriveHead(data, onOpen) }
            items(containers, key = { "c-${it.entity}-${it.id}" }) { container ->
                SearchContainerRow(container, onOpen = onOpen)
            }
            items(data.folders, key = { "f-" + it.folder_id }) { folder -> FolderLine(folder) { folder.route?.let(onOpen) } }
            items(data.rows, key = { "d-" + it.document_id }) { row ->
                DocumentLine(row, chrome?.starred.orEmpty(), chrome?.row_menu.orEmpty(), onTap = { row.route?.let(onOpen) }, onMenu = { openMenu(row) })
            }
            item(key = "foot") { DriveFoot(data) }
        }
    }
}

@Composable
private fun DriveHead(data: DocsDriveData, onOpen: (Route) -> Unit) {
    Crumbs(data.crumbs, onOpen)
    StatusLine(data.shelf_note)
}

@Composable
private fun DriveFoot(data: DocsDriveData) {
    StatusLine(data.truncated_note)
}

@Composable
internal fun Crumbs(crumbs: List<DocsCrumb>, onOpen: (Route) -> Unit) {
    if (crumbs.isEmpty()) return
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        crumbs.forEachIndexed { index, crumb ->
            if (index > 0) CentraidIcon("ChevronRight", tint = centraidColor("textFaint"), size = 12.dp)
            OutlineButton(label = crumb.name, testTag = "docs-crumb-${crumb.folder_id}", ink = "textSoft") {
                crumb.route?.let(onOpen)
            }
        }
    }
}

@Composable
private fun FolderLine(folder: DocsFolderNode, onTap: () -> Unit) {
    CentraidRow(
        title = folder.name,
        trailing = folder.count_label,
        a11y = folder.accessibility_label,
        testTag = "docs-folder-${folder.folder_id}",
        onTap = onTap,
    )
}

@Composable
private fun DocumentLine(row: DocsRowView, starredWord: String, menuLabel: String, onTap: () -> Unit, onMenu: () -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        CentraidRow(
            title = row.title,
            meta = listOf(row.meta, row.labels.joinToString(" · ") { it.label }).filter { it.isNotEmpty() }.joinToString(" · "),
            chips = listOfNotNull(if (row.starred && starredWord.isNotEmpty()) StatusChip(label = starredWord, tone = StatusChip.Tone.TONE_NEUTRAL) else null),
            dimmed = row.trashed,
            testTag = "docs-row-${row.document_id}",
            onTap = onTap,
            accessory = {
                // The row opens; its words are the state's accessibility label.
                Box(Modifier.semantics { contentDescription = row.accessibility_label })
                if (menuLabel.isNotEmpty()) IconKey("MoreVert", menuLabel, "docs-row-menu-${row.document_id}", bordered = false, onPress = onMenu)
            },
        )
        if (row.snippet.isNotEmpty()) {
            val snippet = buildAnnotatedString {
                row.snippet.forEach { run ->
                    if (run.match) withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = centraidColor("text"))) { append(run.text) } else append(run.text)
                }
            }
            Text(
                snippet,
                style = centraidType("annotLabel"),
                color = centraidColor("textSoft"),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = KitGeometry.GUTTER, end = KitGeometry.GUTTER, bottom = 6.dp),
            )
        }
    }
}

@Composable
private fun Tile(
    title: String,
    meta: String,
    iconKey: String,
    a11y: String,
    tag: String,
    menuLabel: String?,
    onMenu: (() -> Unit)?,
    onTap: () -> Unit,
) {
    Column(
        Modifier
            .padding(6.dp)
            .clip(RoundedCornerShape(KitGeometry.RADIUS))
            .border(KitGeometry.HAIRLINE, centraidColor("line"), RoundedCornerShape(KitGeometry.RADIUS))
            .clickable(onClick = onTap)
            .padding(10.dp)
            .testTag(tag),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            CentraidIcon(iconKey.ifEmpty { "FileText" }, tint = centraidColor("textSoft"), size = 20.dp)
            Box(Modifier.weight(1f))
            if (menuLabel != null && menuLabel.isNotEmpty() && onMenu != null) {
                IconKey("MoreVert", menuLabel, "$tag-menu", bordered = false, onPress = onMenu)
            }
        }
        Column(Modifier.clearAndSetSemantics { contentDescription = a11y.ifEmpty { title }; role = Role.Button }) {
            Text(title, style = centraidType("smallStrong"), color = centraidColor("text"), maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (meta.isNotEmpty()) Text(meta, style = centraidType("annotLabel"), color = centraidColor("textSoft"), maxLines = 1)
        }
    }
}

// ---------------------------------------------------------------------------
// docs.document — reader, stage or facts; path, versions, actions
// ---------------------------------------------------------------------------

@Composable
internal fun DocsDocumentScreen(
    state: DocsDocumentState,
    onEvent: (DocsDocumentEvent) -> Unit,
    onOpen: (Route) -> Unit,
    onBack: () -> Unit,
) {
    val chrome = state.chrome
    val data = state.data_
    val row = data?.row
    PushedPage(
        title = row?.title?.ifEmpty { null } ?: state.title_hint,
        // RUST NAMES THE PARENT (`chrome.back`, #1047).
        parentTitle = chrome?.back.orEmpty(),
        onBack = onBack,
        // THE HEAD'S MORE: the verbs sheet opens on Rust's say
        // (`MoreOpened` → `DocsSheet.KIND_MORE`), every action a row in it.
        trailing = if (data?.actions.orEmpty().isNotEmpty() && chrome?.more.orEmpty().isNotEmpty()) {
            RoomAction("MoreHoriz", chrome!!.more, "docs-doc-more") { onEvent(DocsDocumentEvent(more_opened = DocsDocumentEvent.MoreOpened())) }
        } else {
            null
        },
        status = state.status?.sentence.orEmpty(),
    ) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, data, state.denied),
            onRetry = { onEvent(DocsDocumentEvent(refreshed = DocsDocumentEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty().ifEmpty { KitWords.RETRY },
            skeleton = { RowSkeleton(label = chrome?.loading.orEmpty().ifEmpty { KitWords.OPENING }) },
        ) { document ->
            val gone = document.gone
            if (gone != null) {
                EmptyStateView(gone, onAction = null)
                return@ReadStateView
            }
            LazyColumn(Modifier.fillMaxSize()) {
                item(key = "path") {
                    Crumbs(document.path, onOpen)
                    if (row != null && row.meta.isNotEmpty()) StatusLine(row.meta)
                    StatusLine(document.trashed_note)
                    RenameLine(
                        state.rename,
                        chrome?.rename_placeholder.orEmpty(),
                        chrome?.rename_done.orEmpty(),
                        onEdit = { onEvent(DocsDocumentEvent(rename_edited = DocsDocumentEvent.RenameEdited(title = it))) },
                        onDone = { onEvent(DocsDocumentEvent(rename_closed = DocsDocumentEvent.RenameClosed())) },
                    )
                }
                item(key = "surface") {
                    val reading = document.reading
                    val stage = document.stage
                    val facts = document.facts_only
                    when {
                        reading != null -> Column(Modifier.fillMaxWidth().padding(KitGeometry.GUTTER)) {
                            Text(
                                when {
                                    reading.has_text && reading.body.isNotEmpty() -> reading.body
                                    reading.has_text -> reading.empty_body
                                    else -> reading.no_text
                                },
                                style = centraidType("reading"),
                                color = centraidColor(if (reading.has_text && reading.body.isNotEmpty()) "text" else "textSoft"),
                            )
                            // EDIT IS THE HEAD'S `edit` ACTION: its route is the editor.
                            val edit = document.actions.firstOrNull { it.key == EDIT }?.route
                            if (reading.editable && reading.edit_label.isNotEmpty() && edit != null) {
                                OutlineButton(label = reading.edit_label, testTag = "docs-reader-edit") { onOpen(edit) }
                            }
                        }
                        stage != null -> StageCard(stage)
                        facts != null -> StatusLine(facts.sentence)
                    }
                }
                if (document.facts.isNotEmpty()) {
                    item(key = "facts-head") { Heading(chrome?.facts_heading.orEmpty()) }
                    items(document.facts, key = { "fact-" + it.label }) { fact -> FieldRow(key = fact.label, value = fact.detail) }
                }
                // THE VERSION HISTORY is a page of its own: this row opens it.
                document.versions?.let { versions ->
                    item(key = "versions") {
                        CentraidRow(
                            title = versions.label,
                            trailing = versions.count_label,
                            testTag = "docs-versions",
                            onTap = { versions.route?.let(onOpen) },
                        )
                    }
                }
            }
        }
    }
    DocsSheetView(
        state.sheet,
        DocsSheetActions(
            // A verb picked from the sheet closes it; `edit` carries the editor's route.
            onAction = { action ->
                onEvent(DocsDocumentEvent(action = DocsDocumentEvent.ActionPicked(key = action.key)))
                action.route?.let(onOpen)
            },
            onChoice = { key -> onEvent(DocsDocumentEvent(choice = DocsDocumentEvent.ChoicePicked(key = key))) },
            onLabelAdded = { onEvent(DocsDocumentEvent(label_added = DocsDocumentEvent.LabelAdded(label = it))) },
            onLabelRemoved = { onEvent(DocsDocumentEvent(label_removed = DocsDocumentEvent.LabelRemoved(tag_id = it))) },
            onLabelDraft = { onEvent(DocsDocumentEvent(label_draft = DocsDocumentEvent.LabelDraftEdited(text = it))) },
            onClose = { onEvent(DocsDocumentEvent(sheet_closed = DocsDocumentEvent.SheetClosed())) },
        ),
    )
    val confirm = state.confirm
    if (confirm != null) {
        ConfirmSheet(
            confirm = confirm,
            onConfirm = { onEvent(DocsDocumentEvent(confirmed = DocsDocumentEvent.Confirmed())) },
            onDismiss = { onEvent(DocsDocumentEvent(dismissed = DocsDocumentEvent.Dismissed())) },
        )
    }
}

/** The head's `edit` action key. */
private const val EDIT: String = "edit"

// ---------------------------------------------------------------------------
// docs.versions — a document's history; an earlier version of a live one is restorable
// ---------------------------------------------------------------------------

@Composable
internal fun DocsVersionsScreen(state: DocsVersionsState, onEvent: (DocsVersionsEvent) -> Unit, onBack: () -> Unit) {
    val chrome = state.chrome
    PushedPage(
        title = chrome?.heading.orEmpty(),
        parentTitle = chrome?.back.orEmpty(),
        onBack = onBack,
        status = state.status?.sentence.orEmpty(),
    ) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
            onRetry = { onEvent(DocsVersionsEvent(refreshed = DocsVersionsEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty().ifEmpty { KitWords.RETRY },
            skeleton = { RowSkeleton(label = chrome?.loading.orEmpty().ifEmpty { KitWords.OPENING }) },
        ) { data ->
            val empty = data.empty
            if (empty != null) {
                EmptyStateView(empty, onAction = null)
                return@ReadStateView
            }
            LazyColumn(Modifier.fillMaxSize()) {
                items(data.versions, key = { "v-" + it.key }) { version ->
                    CentraidRow(
                        title = version.label,
                        meta = version.meta,
                        dimmed = !version.current,
                        testTag = "docs-version-${version.key}",
                        accessory = if (version.restore_label.isNotEmpty()) {
                            {
                                OutlineButton(label = version.restore_label, testTag = "docs-version-restore-${version.key}") {
                                    onEvent(DocsVersionsEvent(restored = DocsVersionsEvent.Restored(key = version.key)))
                                }
                            }
                        } else {
                            null
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun Heading(title: String) {
    if (title.isNotEmpty()) SectionHeader(SectionHead(title = title))
}

/**
 * THE STAGE. The bytes are here to draw (`bytes_path`) or they are not, and
 * the state says why not. An image decodes upright and no larger than the
 * screen needs (Photos' `decodeUpright`); a PDF draws its first page through
 * the platform's `PdfRenderer`; a video or a recording plays through Photos'
 * player and transport, on the stage ground. A file that will not open draws
 * the card, never a broken glyph.
 */
@Composable
private fun StageCard(stage: DocsStage) {
    val path = stage.bytes_path.takeIf { stage.held && it.isNotEmpty() }
    val drawn = when {
        path == null -> false
        stage.media == DocsStage.Media.MEDIA_IMAGE || stage.media == DocsStage.Media.MEDIA_PDF -> StageStill(stage, path)
        stage.media == DocsStage.Media.MEDIA_VIDEO || stage.media == DocsStage.Media.MEDIA_AUDIO -> {
            StagePlayer(stage, path)
            true
        }
        else -> false
    }
    if (!drawn) StageFacts(stage)
}

/** An image or a PDF's first page, fit to the column; false while it will not open. */
@Composable
private fun StageStill(stage: DocsStage, path: String): Boolean {
    val decoded by produceState<ImageBitmap?>(initialValue = null, path, stage.media) {
        value = withContext(Dispatchers.IO) {
            if (stage.media == DocsStage.Media.MEDIA_PDF) firstPdfPage(path) else decodeUpright(path, maxDimension = STAGE_DECODE)?.asImageBitmap()
        }
    }
    val bitmap = decoded ?: return false
    val shape = RoundedCornerShape(KitGeometry.RADIUS)
    Image(
        bitmap = bitmap,
        contentDescription = stage.accessibility_label.ifEmpty { null },
        contentScale = ContentScale.Fit,
        modifier = Modifier
            .fillMaxWidth()
            .padding(KitGeometry.GUTTER)
            .clip(shape)
            .border(KitGeometry.HAIRLINE, centraidColor("line"), shape)
            .aspectRatio(bitmap.width.toFloat() / bitmap.height.coerceAtLeast(1))
            .testTag("docs-stage"),
    )
    return true
}

/** A video (its first frame, then playback) or a recording: Photos' player and transport. */
@Composable
private fun StagePlayer(stage: DocsStage, path: String) {
    val player = rememberLightboxPlayer(path, once = false)
    val shape = RoundedCornerShape(KitGeometry.RADIUS)
    Column(
        Modifier
            .fillMaxWidth()
            .padding(KitGeometry.GUTTER)
            .clip(shape)
            .background(centraidColor("stage"))
            .padding(horizontal = 8.dp)
            .testTag("docs-stage")
            .semantics { contentDescription = stage.accessibility_label },
    ) {
        if (player == null) return@Column
        if (stage.media == DocsStage.Media.MEDIA_VIDEO) {
            Box(Modifier.fillMaxWidth().aspectRatio(VIDEO_ASPECT)) { PlayerSurface(player) }
        }
        LightboxTransport(player, stage.play_label, stage.pause_label, stage.position_label, stage.position_value)
    }
}

/** No file to draw: the kind, the label, and the state's reason. */
@Composable
private fun StageFacts(stage: DocsStage) {
    val shape = RoundedCornerShape(KitGeometry.RADIUS)
    Column(
        Modifier
            .fillMaxWidth()
            .padding(KitGeometry.GUTTER)
            .clip(shape)
            .border(KitGeometry.HAIRLINE, centraidColor("line"), shape)
            .padding(KitGeometry.GUTTER)
            .testTag("docs-stage")
            .clearAndSetSemantics {
                contentDescription = listOf(stage.accessibility_label, stage.absent_reason).filter { it.isNotEmpty() }.joinToString(". ")
            },
    ) {
        CentraidIcon(
            when (stage.media) {
                DocsStage.Media.MEDIA_IMAGE -> "Image"
                DocsStage.Media.MEDIA_VIDEO -> "Video"
                DocsStage.Media.MEDIA_AUDIO -> "Music"
                else -> "FileText"
            },
            tint = centraidColor("textSoft"),
            size = 28.dp,
        )
        if (stage.accessibility_label.isNotEmpty()) {
            Text(stage.accessibility_label, style = centraidType("body"), color = centraidColor("text"), modifier = Modifier.padding(top = 8.dp))
        }
        if (!stage.held && stage.absent_reason.isNotEmpty()) {
            Text(stage.absent_reason, style = centraidType("small"), color = centraidColor("textSoft"), modifier = Modifier.padding(top = 4.dp))
        }
    }
}

/**
 * A PDF'S FIRST PAGE, rendered at [STAGE_DECODE] pixels wide on white (a PDF
 * page is transparent where nothing is printed). Null when the file is not a
 * PDF the platform can open — encrypted, damaged, or not a PDF at all.
 */
private fun firstPdfPage(path: String): ImageBitmap? = runCatching {
    ParcelFileDescriptor.open(File(path), ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
        PdfRenderer(descriptor).use { renderer ->
            if (renderer.pageCount == 0) return@use null
            renderer.openPage(0).use { page ->
                val width = STAGE_DECODE
                val height = (width.toLong() * page.height / page.width.coerceAtLeast(1)).toInt().coerceIn(1, STAGE_DECODE * 2)
                val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                bitmap.eraseColor(android.graphics.Color.WHITE)
                page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                bitmap.asImageBitmap()
            }
        }
    }
}.getOrNull()

/** The stage's decode ceiling: a column-wide image on any phone, not a 48 MP original. */
private const val STAGE_DECODE = 1600

/** A video's frame before its own size is known. */
private const val VIDEO_ASPECT = 16f / 9f

// ---------------------------------------------------------------------------
// docs.editor — autosave, close = done
// ---------------------------------------------------------------------------

@Composable
internal fun DocsEditorScreen(state: DocsEditorState, onEvent: (DocsEditorEvent) -> Unit, onClose: () -> Unit) {
    val chrome = state.chrome
    val draft = state.draft
    EditorRoom(
        title = draft?.title?.ifEmpty { null } ?: state.title_hint,
        status = state.autosave,
        onClose = onClose,
        // CLOSE = DONE: the pop is a `NavPopped`, which Rust turns into the screen's `Left`, the flush.
        onDeparted = {},
        closeLabel = chrome?.done.orEmpty().ifEmpty { KitWords.DONE },
    ) {
        StatusLine(listOf(state.version_label, state.remote_note).filter { it.isNotEmpty() }.joinToString(" · "))
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, draft),
            onRetry = { onEvent(DocsEditorEvent(refreshed = DocsEditorEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty().ifEmpty { KitWords.RETRY },
            skeleton = { RowSkeleton(label = chrome?.loading.orEmpty().ifEmpty { KitWords.OPENING }) },
        ) { words ->
            Column(Modifier.fillMaxSize()) {
                EditableFieldRow(
                    key = "",
                    value = words.title,
                    // Seeded once per document, never under the member's thumbs.
                    reload = state.document_id,
                    placeholder = chrome?.title_placeholder.orEmpty(),
                    style = "title",
                    testTag = "docs-editor-title",
                    onEdit = { onEvent(DocsEditorEvent(title = DocsEditorEvent.TitleEdited(title = it))) },
                )
                EditableFieldRow(
                    key = "",
                    value = words.body,
                    reload = state.document_id,
                    placeholder = chrome?.body_placeholder.orEmpty(),
                    singleLine = false,
                    style = "reading",
                    testTag = "docs-editor-body",
                    onEdit = { onEvent(DocsEditorEvent(body = DocsEditorEvent.BodyEdited(body = it))) },
                )
            }
        }
    }
}
