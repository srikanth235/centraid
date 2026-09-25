package dev.centraid.android.screens.docs

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import centraid.screen.v1.DocsAction
import centraid.screen.v1.DocsCrumb
import centraid.screen.v1.DocsDocumentEvent
import centraid.screen.v1.DocsDocumentState
import centraid.screen.v1.DocsDriveData
import centraid.screen.v1.DocsDriveEvent
import centraid.screen.v1.DocsDriveState
import centraid.screen.v1.DocsEditorEvent
import centraid.screen.v1.DocsEditorState
import centraid.screen.v1.DocsFolderNode
import centraid.screen.v1.DocsRename
import centraid.screen.v1.DocsRowView
import centraid.screen.v1.DocsSheet
import centraid.screen.v1.DocsStage
import centraid.screen.v1.SectionHead
import centraid.screen.v1.StatusChip
import centraid.screen.v1.WriteState
import dev.centraid.android.kit.AppBand
import dev.centraid.android.kit.AppBandTab
import dev.centraid.android.kit.AppPlace
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.EditableFieldRow
import dev.centraid.android.kit.EditorRoom
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.FieldRow
import dev.centraid.android.kit.IconKey
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.OptionSheet
import dev.centraid.android.kit.PushedPage
import dev.centraid.android.kit.QuietButton
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RoomAction
import dev.centraid.android.kit.RoomSearch
import dev.centraid.android.kit.RowSkeleton
import dev.centraid.android.kit.SectionHeader
import dev.centraid.android.kit.SheetOption
import dev.centraid.android.kit.SheetPrimary
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.SheetRow
import dev.centraid.android.kit.StatusLine
import dev.centraid.android.kit.screenContentOf
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.shared.apps.docs.DocsWrites

/*
 * DOCS' VIEWS (#1046, docs port). Every word, chip, enabled flag and sheet is
 * the state's; the view forwards what the member did and the route turns the
 * intents (`FolderPicked`, `DocumentPicked`, `AddRequested`, `TrashOpened`,
 * `EditRequested`) into pushes and OS calls.
 */

private fun refusal(write: WriteState?): String =
    if (write?.phase == WriteState.Phase.PHASE_REFUSED) write.failure?.sentence.orEmpty() else ""

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
                QuietButton(label = labels.add_label, testTag = "docs-label-add", modifier = Modifier.padding(horizontal = KitGeometry.GUTTER)) {
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
            primary = if (folder.can_create && folder.create_label.isNotEmpty()) {
                SheetPrimary(label = folder.create_label, testTag = "docs-folder-create", onPress = actions.onFolderCreated)
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
    if (rename == null || rename.closed) return
    Row(Modifier.fillMaxWidth().testTag("docs-rename"), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.weight(1f)) {
            EditableFieldRow(
                key = "",
                value = rename.title,
                // Re-seed only when the vault's title changes, never under the member's thumbs.
                reload = rename.baseline,
                placeholder = placeholder,
                testTag = "docs-rename-field",
                onEdit = onEdit,
            )
        }
        QuietButton(label = doneLabel.ifEmpty { KitWords.DONE }, testTag = "docs-rename-done", onPress = onDone)
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
    onHome: () -> Unit,
    folderPage: Boolean,
    parentTitle: String,
    onBack: () -> Unit,
) {
    val chrome = state.chrome
    val add = chrome?.add?.takeIf { it.isNotEmpty() }?.let { label ->
        RoomAction("Plus", label, "docs-add") { onEvent(DocsDriveEvent(sheet_opened = DocsDriveEvent.SheetOpened(kind = DocsSheet.Kind.KIND_ADD))) }
    }
    val body: @Composable () -> Unit = { DriveBody(state, onEvent) }
    if (folderPage) {
        PushedPage(
            title = state.folder_name,
            parentTitle = parentTitle,
            onBack = onBack,
            trailing = add,
            status = refusal(state.write),
            content = body,
        )
    } else {
        AppPlace(
            app = "docs",
            title = chrome?.title.orEmpty(),
            meta = state.head_meta,
            trailing = add,
            search = RoomSearch(
                field = state.search ?: centraid.screen.v1.SearchField(),
                placeholder = chrome?.search_placeholder.orEmpty(),
                onTerm = { onEvent(DocsDriveEvent(search_term = DocsDriveEvent.SearchTermChanged(term = it))) },
                onClose = { onEvent(DocsDriveEvent(search_closed = DocsDriveEvent.SearchClosed())) },
                label = chrome?.search_label.orEmpty().ifEmpty { KitWords.SEARCH },
                closeLabel = chrome?.search_close.orEmpty().ifEmpty { KitWords.CLOSE_SEARCH },
            ),
            status = refusal(state.write),
            band = {
                AppBand(
                    app = "docs",
                    tabs = state.band.filter { it.key != "more" }.map {
                        AppBandTab(key = it.key, label = it.label, iconKey = it.icon_key, selected = it.current)
                    },
                    onSelect = { key -> onEvent(DocsDriveEvent(band = DocsDriveEvent.BandPicked(key = key))) },
                    onHome = onHome,
                    onMore = if (state.band.any { it.key == "more" }) {
                        { onEvent(DocsDriveEvent(band = DocsDriveEvent.BandPicked(key = "more"))) }
                    } else {
                        null
                    },
                )
            },
            content = body,
        )
    }
    DocsSheetView(
        state.sheet,
        DocsSheetActions(
            onAction = { action -> onEvent(DocsDriveEvent(action = DocsDriveEvent.ActionPicked(key = action.key))) },
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
private fun DriveBody(state: DocsDriveState, onEvent: (DocsDriveEvent) -> Unit) {
    val chrome = state.chrome
    Column(Modifier.fillMaxSize()) {
        // THE TOOLBAR: filter pills from state, clear, search, layout.
        Row(
            Modifier.fillMaxWidth().padding(start = KitGeometry.GUTTER, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(
                Modifier.weight(1f).horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                state.pills.forEach { pill ->
                    Pill(pill.label, pill.active, pill.accessibility_label, "docs-pill-${pill.key.value}") {
                        onEvent(DocsDriveEvent(sheet_opened = DocsDriveEvent.SheetOpened(kind = pill.key)))
                    }
                }
                if (state.filters_active && chrome?.filters_clear_label.orEmpty().isNotEmpty()) {
                    QuietButton(label = chrome!!.filters_clear_label, testTag = "docs-clear-filters") {
                        onEvent(DocsDriveEvent(filters_cleared = DocsDriveEvent.FiltersCleared()))
                    }
                }
            }
            if (state.search?.open_ != true && chrome?.search_label.orEmpty().isNotEmpty()) {
                IconKey("Search", chrome!!.search_label, "docs-search", bordered = false) {
                    onEvent(DocsDriveEvent(search_opened = DocsDriveEvent.SearchOpened()))
                }
            }
            if (chrome?.layout_toggle.orEmpty().isNotEmpty()) {
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
        ) { data -> DriveData(state, data, onEvent) }
    }
}

@Composable
private fun DriveData(state: DocsDriveState, data: DocsDriveData, onEvent: (DocsDriveEvent) -> Unit) {
    val empty = data.empty
    if (data.rows.isEmpty() && data.folders.isEmpty() && empty != null) {
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
    val openFolder = { id: String, name: String ->
        onEvent(DocsDriveEvent(folder_picked = DocsDriveEvent.FolderPicked(folder_id = id, name = name)))
    }
    val openRow = { row: DocsRowView ->
        onEvent(DocsDriveEvent(document_picked = DocsDriveEvent.DocumentPicked(document_id = row.document_id, title = row.title, surface = row.surface)))
    }
    val openMenu = { row: DocsRowView ->
        onEvent(DocsDriveEvent(row_menu = DocsDriveEvent.RowMenuOpened(document_id = row.document_id)))
    }
    val chrome = state.chrome
    if (state.layout == DocsDriveState.Layout.LAYOUT_GRID) {
        LazyVerticalGrid(columns = GridCells.Adaptive(150.dp), modifier = Modifier.fillMaxSize()) {
            item(span = { GridItemSpan(maxLineSpan) }, key = "head") { DriveHead(data, openFolder) }
            items(data.folders, key = { "f-" + it.folder_id }) { folder ->
                Tile(folder.name, folder.count_label, "Folder", folder.accessibility_label, "docs-folder-${folder.folder_id}", null, null) {
                    openFolder(folder.folder_id, folder.name)
                }
            }
            items(data.rows, key = { "d-" + it.document_id }) { row ->
                Tile(row.title, row.meta, row.kind_icon_key, row.accessibility_label, "docs-row-${row.document_id}", chrome?.row_menu, { openMenu(row) }) {
                    openRow(row)
                }
            }
            item(span = { GridItemSpan(maxLineSpan) }, key = "foot") { DriveFoot(data) }
        }
    } else {
        LazyColumn(Modifier.fillMaxSize()) {
            item(key = "head") { DriveHead(data, openFolder) }
            items(data.folders, key = { "f-" + it.folder_id }) { folder -> FolderLine(folder) { openFolder(folder.folder_id, folder.name) } }
            items(data.rows, key = { "d-" + it.document_id }) { row ->
                DocumentLine(row, chrome?.starred.orEmpty(), chrome?.row_menu.orEmpty(), onTap = { openRow(row) }, onMenu = { openMenu(row) })
            }
            item(key = "foot") { DriveFoot(data) }
        }
    }
}

@Composable
private fun DriveHead(data: DocsDriveData, openFolder: (String, String) -> Unit) {
    Crumbs(data.crumbs, openFolder)
    StatusLine(data.shelf_note)
}

@Composable
private fun DriveFoot(data: DocsDriveData) {
    StatusLine(data.truncated_note)
}

@Composable
internal fun Crumbs(crumbs: List<DocsCrumb>, onPick: (String, String) -> Unit) {
    if (crumbs.isEmpty()) return
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        crumbs.forEachIndexed { index, crumb ->
            if (index > 0) CentraidIcon("ChevronRight", tint = centraidColor("textFaint"), size = 12.dp)
            QuietButton(label = crumb.name, testTag = "docs-crumb-${crumb.folder_id}", ink = "textSoft") { onPick(crumb.folder_id, crumb.name) }
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

@Composable
private fun Pill(label: String, active: Boolean, a11y: String, tag: String, onTap: () -> Unit) {
    val shape = RoundedCornerShape(50)
    Text(
        label,
        style = centraidType("annotLabelOn"),
        color = centraidColor(if (active) "text" else "textSoft"),
        maxLines = 1,
        modifier = Modifier
            .heightIn(min = 32.dp)
            .clip(shape)
            .border(KitGeometry.HAIRLINE, centraidColor(if (active) "lineStrong" else "line"), shape)
            .clickable(onClick = onTap)
            .padding(horizontal = 12.dp, vertical = 7.dp)
            .testTag(tag)
            .clearAndSetSemantics {
                contentDescription = a11y.ifEmpty { label }
                role = Role.Button
                selected = active
            },
    )
}

// ---------------------------------------------------------------------------
// docs.document — reader, stage or facts; path, versions, activity, actions
// ---------------------------------------------------------------------------

@Composable
internal fun DocsDocumentScreen(
    state: DocsDocumentState,
    parentTitle: String,
    onEvent: (DocsDocumentEvent) -> Unit,
    onBack: () -> Unit,
    onFolder: (String, String) -> Unit,
    onEdit: (String, String) -> Unit,
) {
    val chrome = state.chrome
    val data = state.data_
    val row = data?.row
    PushedPage(
        title = row?.title?.ifEmpty { null } ?: state.title_hint,
        parentTitle = parentTitle.ifEmpty { chrome?.back.orEmpty() },
        onBack = onBack,
        // THE HEAD'S MORE: the verbs sheet opens on the machine's say
        // (`MoreOpened` → `DocsSheet.KIND_MORE`), every action a row in it.
        trailing = if (data?.actions.orEmpty().isNotEmpty() && chrome?.more.orEmpty().isNotEmpty()) {
            RoomAction("MoreHoriz", chrome!!.more, "docs-doc-more") { onEvent(DocsDocumentEvent(more_opened = DocsDocumentEvent.MoreOpened())) }
        } else {
            null
        },
        status = refusal(state.write),
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
                    Crumbs(document.path, onFolder)
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
                            if (reading.editable && reading.edit_label.isNotEmpty() && row != null) {
                                QuietButton(label = reading.edit_label, testTag = "docs-reader-edit") {
                                    onEvent(DocsDocumentEvent(edit_requested = DocsDocumentEvent.EditRequested(document_id = row.document_id, title = row.title)))
                                    onEdit(row.document_id, row.title)
                                }
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
                if (document.versions.isNotEmpty()) {
                    item(key = "versions-head") { Heading(chrome?.versions_heading.orEmpty()) }
                    items(document.versions, key = { "v-" + it.content_id }) { version ->
                        CentraidRow(
                            title = version.label,
                            meta = version.meta,
                            testTag = "docs-version-${version.content_id}",
                            accessory = if (version.restore_label.isNotEmpty()) {
                                {
                                    QuietButton(label = version.restore_label, testTag = "docs-version-restore-${version.content_id}") {
                                        onEvent(DocsDocumentEvent(version_restore = DocsDocumentEvent.VersionRestoreTapped(content_id = version.content_id)))
                                    }
                                }
                            } else {
                                null
                            },
                        )
                    }
                }
                item(key = "activity-head") { Heading(chrome?.activity_heading.orEmpty()) }
                if (document.activity.isEmpty()) {
                    item(key = "activity-empty") { StatusLine(document.activity_empty) }
                }
                items(document.activity.withIndex().toList(), key = { "a-" + it.index }) { (_, entry) ->
                    CentraidRow(title = entry.label, meta = entry.meta)
                }
            }
        }
    }
    DocsSheetView(
        state.sheet,
        DocsSheetActions(
            onAction = { action ->
                // `edit` is the shell's: the sheet closes and the editor is pushed.
                if (action.key == DocsWrites.KEY_EDIT && row != null) {
                    onEvent(DocsDocumentEvent(sheet_closed = DocsDocumentEvent.SheetClosed()))
                    onEvent(DocsDocumentEvent(edit_requested = DocsDocumentEvent.EditRequested(document_id = row.document_id, title = row.title)))
                    onEdit(row.document_id, row.title)
                } else {
                    onEvent(DocsDocumentEvent(action = DocsDocumentEvent.ActionPicked(key = action.key)))
                }
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

@Composable
private fun Heading(title: String) {
    if (title.isNotEmpty()) SectionHeader(SectionHead(title = title))
}

/**
 * THE STAGE. The bytes are held or they are not, and the state says why not.
 * SHARED-SIDE GAP: `DocsStage` carries a `content_id` and `held`, but no file
 * path — Photos' stage draws from `thumbnail_path`/original paths its reads
 * return, and no Docs read returns one — so a held image, PDF or video is
 * drawn as its card (kind and label) until the state carries a path.
 */
@Composable
private fun StageCard(stage: DocsStage) {
    val shape = RoundedCornerShape(KitGeometry.RADIUS)
    Column(
        Modifier
            .fillMaxWidth()
            .padding(KitGeometry.GUTTER)
            .clip(shape)
            .border(KitGeometry.HAIRLINE, centraidColor("line"), shape)
            .padding(16.dp)
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

// ---------------------------------------------------------------------------
// docs.editor — autosave, close = done
// ---------------------------------------------------------------------------

@Composable
internal fun DocsEditorScreen(state: DocsEditorState, onEvent: (DocsEditorEvent) -> Unit, onClose: () -> Unit, onDeparted: () -> Unit) {
    val chrome = state.chrome
    val draft = state.draft
    EditorRoom(
        title = draft?.title?.ifEmpty { null } ?: state.title_hint,
        status = state.autosave,
        onClose = onClose,
        onDeparted = onDeparted,
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
                    reload = state.baseline,
                    placeholder = chrome?.title_placeholder.orEmpty(),
                    style = "title",
                    testTag = "docs-editor-title",
                    onEdit = { onEvent(DocsEditorEvent(title = DocsEditorEvent.TitleEdited(title = it))) },
                )
                EditableFieldRow(
                    key = "",
                    value = words.body,
                    reload = state.baseline,
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
