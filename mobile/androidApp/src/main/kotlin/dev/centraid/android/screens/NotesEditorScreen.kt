package dev.centraid.android.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
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
import centraid.screen.v1.Autosave
import centraid.screen.v1.NotesEditorEvent
import centraid.screen.v1.NotesEditorState
import dev.centraid.android.kit.EditableFieldRow
import dev.centraid.android.kit.EditorRoom
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.OptionSheet
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RoomAction
import dev.centraid.android.kit.RowSkeleton
import dev.centraid.android.kit.SheetOption
import dev.centraid.android.kit.StatusLine
import dev.centraid.android.kit.screenContentOf
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * The Notes editor (#1020, D-1020-E3; #1029 port), in the kit's `EditorRoom`.
 *
 * AUTOSAVE, CLOSE = DONE (#1015 D3). There is no Save button: the machine
 * saves after the last keystroke, a pin saves at once, and leaving by any
 * road runs [onDeparted] — the bridge's `departed()` — which saves what is
 * unsaved. The close key's word ("Cancel" before a keystroke, "Done" after)
 * and the status line are the machine's `chrome`.
 *
 * A NEW NOTE (`is_new`) opens empty and is created on its first save. A body
 * that is not on this device is read-only under `body_notice`. Pin, Link,
 * History and Send to Tasks sit behind the one menu key (`menu_label`), as on
 * iOS; History and Send to Tasks are intents for the route. `[[` typed in the
 * body opens the link sheet on the machine's own say (`link_sheet_open`).
 *
 * THE WORDS ARE LOCAL WHILE THEY ARE TYPED (`rememberEditorText`): each field
 * takes the machine's value back only on the vault's baseline while CLEAN —
 * or, for the body, when the link sheet closes, because a pick splices
 * `[[title]]` into the draft the machine holds.
 */
@Composable
public fun NotesEditorScreen(
    state: NotesEditorState,
    onEvent: (NotesEditorEvent) -> Unit,
    onClose: () -> Unit,
    onDeparted: () -> Unit,
) {
    val draft = state.draft
    val chrome = state.chrome
    val clean = state.autosave?.phase == Autosave.Phase.PHASE_CLEAN
    val reload = if (clean) Pair(state.note_id, state.baseline) else null
    // THE SPLICE SIGNAL: each time the link sheet closes, the body takes the
    // machine's value once (a pick wrote `[[title]]` into it there).
    val linkCloses = remember(state.note_id) { mutableIntStateOf(0) }
    val wasOpen = remember(state.note_id) { booleanArrayOf(false) }
    LaunchedEffect(state.link_sheet_open) {
        if (wasOpen[0] && !state.link_sheet_open) linkCloses.intValue += 1
        wasOpen[0] = state.link_sheet_open
    }
    val bodyReload: Any? = reload ?: linkCloses.intValue.takeIf { it > 0 }?.let { Pair(state.note_id, it) }
    // THE MENU IS A PLAIN LIST OF THE MACHINE'S VERBS: nothing in it is a
    // choice the machine holds, so its open/closed is this screen's alone.
    var menuOpen by remember(state.note_id) { mutableStateOf(false) }
    EditorRoom(
        title = chrome?.title?.ifEmpty { null } ?: draft?.title.orEmpty(),
        // THE MACHINE'S STATUS is drawn under the header instead of the kit's
        // autosave words, so the sentence is the one the machine chose.
        status = null,
        closeLabel = chrome?.close?.takeIf { it.isNotEmpty() } ?: KitWords.DONE,
        onClose = onClose,
        onDeparted = onDeparted,
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
            // No member-sent re-read exists on this machine: re-opening the
            // note is the retry.
            onRetry = null,
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
                if (state.body_notice.isNotEmpty()) {
                    Text(
                        state.body_notice,
                        style = centraidType("annotLabel"),
                        color = centraidColor("textSoft"),
                        modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp).testTag("notes-body-notice"),
                    )
                }
                if (state.body_editable) {
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
                } else if (note.body.isNotEmpty()) {
                    Text(
                        note.body,
                        style = centraidType("reading"),
                        color = centraidColor("textSoft"),
                        modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp).testTag("notes-body"),
                    )
                }
            }
        }
    }
    if (menuOpen && chrome != null && draft != null) {
        val options = buildList {
            add(SheetOption(key = MENU_PIN, label = chrome.pin_label))
            if (state.body_editable) add(SheetOption(key = MENU_LINK, label = chrome.link_label))
            if (chrome.history_enabled) add(SheetOption(key = MENU_HISTORY, label = chrome.history_label))
            if (chrome.send_to_tasks_label.isNotEmpty()) {
                add(SheetOption(key = MENU_SEND, label = chrome.send_to_tasks_label))
            }
        }.filter { it.label.isNotEmpty() }
        OptionSheet(
            title = chrome.menu_label,
            options = options,
            onPick = { key ->
                menuOpen = false
                when (key) {
                    MENU_PIN -> onEvent(NotesEditorEvent(pin = NotesEditorEvent.PinToggled()))
                    MENU_LINK -> onEvent(NotesEditorEvent(link_requested = NotesEditorEvent.LinkRequested(caret = draft.body.length)))
                    MENU_HISTORY -> onEvent(NotesEditorEvent(history = NotesEditorEvent.HistoryRequested()))
                    // The note's title, else its body — iOS sends the same.
                    MENU_SEND -> onEvent(
                        NotesEditorEvent(send_to_tasks = NotesEditorEvent.SendToTasks(text = draft.title.ifEmpty { draft.body })),
                    )
                }
            },
            onDismiss = { menuOpen = false },
        )
    }
}

private const val MENU_PIN = "pin"
private const val MENU_LINK = "link"
private const val MENU_HISTORY = "history"
private const val MENU_SEND = "send-to-tasks"
