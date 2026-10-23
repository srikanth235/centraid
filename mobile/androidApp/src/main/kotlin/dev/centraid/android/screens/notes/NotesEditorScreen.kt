package dev.centraid.android.screens.notes

import androidx.compose.foundation.layout.Column
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
import centraid.core.v1.NotesLinkSheet
import centraid.core.v1.Route
import centraid.screen.v1.SearchField
import centraid.screen.v1.SectionHead
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.CentraidSearchField
import dev.centraid.android.kit.EditableFieldRow
import dev.centraid.android.kit.EditorRoom
import dev.centraid.android.kit.EmptyStateView
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
import dev.centraid.android.kit.toKit

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
    // THE SPLICE SIGNAL: each time the link sheet closes, the body takes Rust's
    // value once (a pick wrote `[[title]]` into it there).
    val linkCloses = remember(state.note_id) { mutableIntStateOf(0) }
    val wasOpen = remember(state.note_id) { booleanArrayOf(false) }
    val linkOpen = state.link != null
    LaunchedEffect(linkOpen) {
        if (wasOpen[0] && !linkOpen) linkCloses.intValue += 1
        wasOpen[0] = linkOpen
    }
    val bodyReload: Any? = reload ?: linkCloses.intValue.takeIf { it > 0 }?.let { Pair(state.note_id, it) }
    var menuOpen by remember(state.note_id) { mutableStateOf(false) }
    EditorRoom(
        title = chrome?.title.orEmpty(),
        status = state.autosave?.toKit(),
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
        StatusLine(chrome?.status.orEmpty())
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, draft),
            onRetry = { onEvent(NotesEditorEvent(refreshed = NotesEditorEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty(),
            skeleton = { RowSkeleton(rows = 4, meta = false) },
        ) { note ->
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
                EditableFieldRow(
                    key = "",
                    value = note.title,
                    reload = reload,
                    placeholder = chrome?.title_placeholder.orEmpty(),
                    style = "title",
                    testTag = "notes-title",
                    onEdit = { value -> onEvent(NotesEditorEvent(title = NotesEditorEvent.TitleEdited(value))) },
                )
                EditableFieldRow(
                    key = "",
                    value = note.body,
                    reload = bodyReload,
                    placeholder = chrome?.body_placeholder.orEmpty(),
                    style = "reading",
                    singleLine = false,
                    testTag = "notes-body",
                    modifier = Modifier.padding(top = 4.dp),
                    onEdit = { value -> onEvent(NotesEditorEvent(body = NotesEditorEvent.BodyEdited(value))) },
                )
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
    state.link?.let { sheet -> LinkSheet(sheet, onEvent) }
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
                EmptyStateView(empty.toKit(), onAction = null)
            } else {
                LazyColumn(Modifier.testTag("notes-history")) {
                    items(data.rows, key = { it.content_id }) { row ->
                        CentraidRow(
                            title = row.label,
                            meta = row.preview,
                            dimmed = row.current,
                            a11y = row.accessibility_label,
                            testTag = "notes-version-${row.content_id}",
                        ) {
                            if (row.restore_label.isNotEmpty() && !row.current) {
                                OutlineButton(
                                    row.restore_label,
                                    testTag = "notes-restore-${row.content_id}",
                                    modifier = Modifier.padding(start = 8.dp),
                                ) { onEvent(NotesHistoryEvent(restore = NotesHistoryEvent.RestoreTapped(row.content_id))) }
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
