package dev.centraid.android.screens.notes

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.KitText
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.LocalAppAccentId
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.appAccent
import dev.centraid.android.kit.kitCard
import dev.centraid.android.kit.kitTextStyle
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.ImeAction
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import centraid.core.v1.NotesEditorEvent
import centraid.core.v1.NotesEditorState
import centraid.core.v1.NotesHistoryEvent
import centraid.core.v1.NotesHistoryState
import centraid.core.v1.NotesLinkChipKind
import centraid.core.v1.NotesLinkResolution
import centraid.core.v1.NotesLinkSheet
import centraid.core.v1.StatusLine as StatusLineMessage
import centraid.core.v1.Route
import dev.centraid.android.kit.SearchField
import dev.centraid.android.kit.SectionHead
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.CentraidSearchField
import dev.centraid.android.kit.EditableFieldRow
import dev.centraid.android.kit.EditorRoom
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.IconKey
import dev.centraid.android.kit.FailureView
import dev.centraid.android.kit.OptionSheet
import dev.centraid.android.kit.OutlineButton
import dev.centraid.android.kit.PushedPage
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RoomAction
import dev.centraid.android.kit.RowSkeleton
import dev.centraid.android.kit.ScreenContent
import dev.centraid.android.kit.SectionHeader
import dev.centraid.android.kit.SheetOption
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.StatusLine
import dev.centraid.android.kit.screenContentOf

/**
 * `notes.editor` (#1135), in the kit's `EditorRoom`.
 *
 * AUTOSAVE, CLOSE = DONE (#1015 D3). There is no Save button: Rust saves after
 * the last keystroke, a pin saves at once, and leaving by any road is the
 * page's pop, which Rust sees as `Left` and flushes. The close key's word
 * ("Cancel" before a keystroke, "Done" after) and the status line are Rust's
 * `chrome`. History and Send to Agenda are routes the state carries; the
 * powerbox is a sheet the state opens (`link`), also on a typed `[[`.
 *
 * THE WORDS ARE LOCAL WHILE THEY ARE TYPED: each field takes Rust's value back
 * only on the vault's baseline while CLEAN — or, for the body, when the link
 * sheet closes, because a pick splices `[[title]]` into the draft Rust holds.
 */
@Composable
public fun NotesEditorScreen(
    state: NotesEditorState,
    onEvent: (NotesEditorEvent) -> Unit,
    onOpen: (Route) -> Unit,
    onClose: () -> Unit,
) {
    val draft = state.draft
    val chrome = state.chrome
    val clean = state.autosave?.refused != true && state.autosave?.edit_seq == state.autosave?.saved_seq
    val reload: Any? = if (clean) state.note_id else null
    // A CORE EDIT (a checklist tap, Return, Undo, a pick) is on its way back: the body field may
    // take the core's body even while it has the keyboard.
    val pending = remember(state.note_id) { CoreEditPending() }
    val bodyFocused = remember(state.note_id) { mutableStateOf(false) }
    val linkOpen = state.link != null
    val send: (NotesEditorEvent) -> Unit = { event ->
        if (event.checklist_requested != null || event.checklist_toggled != null || event.return_pressed != null ||
            event.status_acted != null || event.link_picked != null
        ) {
            pending.value = true
        }
        onEvent(event)
    }
    val focus = androidx.compose.ui.platform.LocalFocusManager.current
    var menuOpen by remember(state.note_id) { mutableStateOf(false) }
    CompositionLocalProvider(LocalAppAccentId provides "notes") {
    EditorRoom(
        title = chrome?.title.orEmpty(),
        status = state.autosave,
        closeLabel = chrome?.close.orEmpty().ifEmpty { dev.centraid.android.kit.KitWords.DONE },
        onClose = onClose,
        // The page's pop is the flush: Rust sends itself `Left`.
        onDeparted = {},
        trailing = if (draft != null && chrome != null) {
            RoomAction(iconKey = "MoreHoriz", label = chrome.menu_label.ifEmpty { chrome.pin_label }, testTag = "notes-menu") {
                menuOpen = true
            }
        } else {
            null
        },
    ) {
        // THE ONE STATUS LINE: the core's sentence, with its one verb (Undo) while it has one.
        if (chrome != null && chrome.status_action.isNotEmpty()) {
            StatusLine(
                line = StatusLineMessage(sentence = chrome.status, action_label = chrome.status_action),
                actTag = "notes-editor-status-action",
            ) { send(NotesEditorEvent(status_acted = NotesEditorEvent.StatusActed())) }
        } else {
            StatusLine(chrome?.status.orEmpty())
        }
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, draft),
            onRetry = { onEvent(NotesEditorEvent(refreshed = NotesEditorEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty(),
            skeleton = { RowSkeleton(rows = 4, meta = false) },
        ) { note ->
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
                // THE LINE OVER THE TITLE: the pin when pinned, then "Travel · Edited Wed 4 November".
                if (state.meta.isNotEmpty()) {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (note.pinned) {
                            CentraidIcon(iconKey = "Pin", tint = appAccent().text, size = 12.dp)
                            Spacer(Modifier.width(6.dp))
                        }
                        KitText(state.meta, KitType.Meta, Surface.meta, maxLines = 1, modifier = Modifier.testTag("notes-editor-meta"))
                    }
                }
                EditableFieldRow(
                    key = "",
                    value = note.title,
                    reload = reload,
                    placeholder = chrome?.title_placeholder.orEmpty(),
                    style = "title",
                    testTag = "notes-title",
                    onEdit = { value -> onEvent(NotesEditorEvent(title = NotesEditorEvent.TitleEdited(value))) },
                )
                TagsRow(state, onEvent)
                NotesRichBody(
                    value = note.body,
                    rich = state.rich,
                    selection = state.selection,
                    follows = !bodyFocused.value || pending.value || linkOpen,
                    pending = pending,
                    placeholder = chrome?.body_placeholder.orEmpty(),
                    onEdit = { value -> onEvent(NotesEditorEvent(body = NotesEditorEvent.BodyEdited(value))) },
                    onFocus = { bodyFocused.value = it },
                    onReturn = { caret -> send(NotesEditorEvent(return_pressed = NotesEditorEvent.ReturnPressed(caret = caret))) },
                    onToggle = { at -> send(NotesEditorEvent(checklist_toggled = NotesEditorEvent.ChecklistToggled(at = at))) },
                    onLink = { chip, at ->
                        val route = chip.route
                        if (chip.kind == NotesLinkChipKind.NOTES_LINK_CHIP_KIND_NOTE &&
                            chip.resolution == NotesLinkResolution.NOTES_LINK_RESOLUTION_RESOLVED && route != null
                        ) {
                            onOpen(route)
                        } else {
                            send(NotesEditorEvent(link_opened = NotesEditorEvent.LinkOpened(at = at)))
                        }
                    },
                    modifier = Modifier.padding(horizontal = KitGeometry.GUTTER).padding(top = 4.dp),
                )
                // THE TOOLS under the words: checklist and link are Rust's events.
                if (chrome != null) {
                    Row(
                        Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        IconKey("Todo", chrome.checklist_label, "notes-tool-checklist") {
                            send(NotesEditorEvent(checklist_requested = NotesEditorEvent.ChecklistRequested()))
                        }
                        IconKey("Link", chrome.link_label, "notes-tool-link") {
                            onEvent(NotesEditorEvent(link_requested = NotesEditorEvent.LinkRequested()))
                        }
                        IconKey("ChevronDown", chrome.keyboard_label, "notes-tool-keyboard") { focus.clearFocus() }
                    }
                }
            }
        }
    }
    }
    if (menuOpen && chrome != null && draft != null) {
        val options = buildList {
            add(SheetOption(key = MENU_PIN, label = chrome.pin_label))
            add(SheetOption(key = MENU_LINK, label = chrome.link_label))
            if (chrome.history_enabled && state.history != null) add(SheetOption(key = MENU_HISTORY, label = chrome.history_label))
            if (state.send_to_agenda != null) add(SheetOption(key = MENU_SEND, label = chrome.send_to_agenda_label))
        }.filter { it.label.isNotEmpty() }
        OptionSheet(
            title = chrome.menu_label,
            options = options,
            onPick = { key ->
                menuOpen = false
                when (key) {
                    MENU_PIN -> onEvent(NotesEditorEvent(pin = NotesEditorEvent.PinToggled()))
                    MENU_LINK -> onEvent(NotesEditorEvent(link_requested = NotesEditorEvent.LinkRequested()))
                    MENU_HISTORY -> state.history?.let(onOpen)
                    MENU_SEND -> state.send_to_agenda?.let(onOpen)
                }
            },
            onDismiss = { menuOpen = false },
        )
    }
    state.link?.let { sheet -> LinkSheet(sheet, send) }
}

/**
 * THE NOTE'S TAGS, each removable, and the field that adds one (`add-tag`,
 * `remove-tag`; Rust writes at once). The field is offered only once the note
 * exists (`tag_placeholder` is empty before).
 */
@Composable
private fun TagsRow(state: NotesEditorState, onEvent: (NotesEditorEvent) -> Unit) {
    val placeholder = state.chrome?.tag_placeholder.orEmpty()
    @OptIn(ExperimentalLayoutApi::class)
    FlowRow(
        Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        state.tags.forEach { tag ->
            Row(
                Modifier
                    .padding(vertical = 2.dp)
                    .clip(RoundedCornerShape(percent = 50))
                    .background(Surface.fill)
                    .padding(start = 12.dp)
                    .testTag("notes-tag-${tag.concept_id}"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                KitText(tag.label, KitType.Meta, Surface.body, maxLines = 1)
                IconKey(
                    iconKey = "X",
                    label = tag.remove_label,
                    testTag = "notes-tag-remove-${tag.concept_id}",
                    bordered = false,
                ) { onEvent(NotesEditorEvent(tag_removed = NotesEditorEvent.TagRemoved(tag.label))) }
            }
        }
    }
    if (placeholder.isNotEmpty()) {
        // THE ADD FIELD IS LOCAL UNTIL THE KEYBOARD'S DONE: only then is the label an event.
        var typed by remember(state.note_id) { mutableStateOf("") }
        Box(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp).heightIn(min = 36.dp)) {
            if (typed.isEmpty()) {
                Text(placeholder, style = centraidType("small"), color = centraidColor("textFaint"))
            }
            BasicTextField(
                value = typed,
                onValueChange = { typed = it },
                singleLine = true,
                textStyle = centraidType("small").copy(color = centraidColor("text")),
                cursorBrush = SolidColor(centraidColor("text")),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = {
                    val label = typed.trim()
                    typed = ""
                    if (label.isNotEmpty()) onEvent(NotesEditorEvent(tag_added = NotesEditorEvent.TagAdded(label)))
                }),
                modifier = Modifier.fillMaxWidth().testTag("notes-tag-field"),
            )
        }
    }
}

/** THE POWERBOX: a sheet over the editor; a pick is `LinkPicked` and Rust splices `[[title]]`. */
@Composable
private fun LinkSheet(sheet: NotesLinkSheet, onEvent: (NotesEditorEvent) -> Unit) {
    val dismiss = { onEvent(NotesEditorEvent(link_dismissed = NotesEditorEvent.LinkDismissed())) }
    SheetRoom(title = sheet.title, onDismiss = dismiss, status = sheet.foot) {
        CentraidSearchField(
            field = SearchField(open_ = true, term = sheet.term),
            placeholder = sheet.search_placeholder,
            label = sheet.search_placeholder,
            closeLabel = sheet.close,
            onTerm = { term -> onEvent(NotesEditorEvent(link_term = NotesEditorEvent.LinkTerm(term))) },
            onClose = dismiss,
            testTag = "notes-link-search",
        )
        when (val content = screenContentOf(sheet.loading, sheet.failure, sheet.data_, sheet.denied)) {
            is ScreenContent.Loading -> RowSkeleton(rows = 4, label = sheet.loading_label)
            is ScreenContent.Failure -> FailureView(content.sentence, content.remedy, onRetry = null)
            is ScreenContent.Gate -> Quiet(content.denied.title)
            is ScreenContent.Data -> {
                val data = content.value
                val empty = data.empty
                if (data.domains.isEmpty() && empty != null) {
                    Quiet(listOf(empty.headline, empty.body).filter { it.isNotEmpty() }.joinToString(" "))
                }
                LazyColumn(Modifier.testTag("notes-link-targets")) {
                    data.domains.forEachIndexed { index, domain ->
                        domain.head?.let { head ->
                            item(key = "h-$index") { SectionHeader(SectionHead(title = head.title, count = head.count)) }
                        }
                        items(domain.rows, key = { "$index-" + it.entity + it.id }) { target ->
                            CentraidRow(
                                title = target.title,
                                meta = target.subtitle,
                                a11y = target.accessibility_label,
                                testTag = "notes-link-${target.id}",
                                onTap = { onEvent(NotesEditorEvent(link_picked = NotesEditorEvent.LinkPicked(target.id))) },
                            )
                        }
                    }
                }
            }
        }
    }
}

/** `notes.history` (#1135): a `PushedPage` back to the note, each version a row with Restore; the current one has none. */
@Composable
public fun NotesHistoryScreen(
    state: NotesHistoryState,
    onEvent: (NotesHistoryEvent) -> Unit,
    onBack: () -> Unit,
) {
    CompositionLocalProvider(LocalAppAccentId provides "notes") {
    PushedPage(
        title = state.title,
        parentTitle = state.back,
        onBack = onBack,
        status = state.status?.sentence.orEmpty(),
    ) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
            onRetry = { onEvent(NotesHistoryEvent(refreshed = NotesHistoryEvent.Refreshed())) },
            retryLabel = state.retry,
            skeleton = { RowSkeleton(label = state.loading_label) },
        ) { data ->
            val empty = data.empty
            if (data.rows.size <= 1 && empty != null) {
                EmptyStateView(empty, onAction = null)
            } else {
                // NOTHING IS DIMMED: the current version says "Current" and has no Restore.
                Column(
                    Modifier.padding(horizontal = KitGeometry.GUTTER).kitCard().testTag("notes-history"),
                ) {
                    data.rows.forEach { row ->
                        Row(
                            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).testTag("notes-version-${row.content_id}"),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                KitText(row.label, KitType.Row, Surface.ink, maxLines = 1)
                                KitText(row.preview, KitType.Meta, Surface.body, maxLines = 1)
                            }
                            if (row.restore_label.isNotEmpty() && !row.current) {
                                Text(
                                    row.restore_label,
                                    style = kitTextStyle(KitType.Row).copy(fontWeight = FontWeight.SemiBold),
                                    color = appAccent().text,
                                    modifier = Modifier
                                        .padding(start = 8.dp)
                                        .clickable { onEvent(NotesHistoryEvent(restore = NotesHistoryEvent.RestoreTapped(row.content_id))) }
                                        .padding(vertical = 12.dp)
                                        .testTag("notes-restore-${row.content_id}"),
                                )
                            }
                        }
                    }
                }
            }
        }
    }
    }
}

private const val MENU_PIN = "pin"
private const val MENU_LINK = "link"
private const val MENU_HISTORY = "history"
private const val MENU_SEND = "send-to-agenda"
