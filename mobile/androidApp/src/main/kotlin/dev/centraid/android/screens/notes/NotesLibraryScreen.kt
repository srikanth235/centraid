package dev.centraid.android.screens.notes

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import centraid.screen.v1.NotesBandTab
import centraid.screen.v1.NotesLibraryEvent
import centraid.screen.v1.NotesLibrarySort
import centraid.screen.v1.NotesLibraryState
import centraid.screen.v1.NotesNoteRow
import centraid.screen.v1.StatusChip
import centraid.screen.v1.WriteState
import dev.centraid.android.kit.AppBand
import dev.centraid.android.kit.AppBandTab
import dev.centraid.android.kit.AppPlace
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.IconKey
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.OptionSheet
import dev.centraid.android.kit.QuietButton
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RoomAction
import dev.centraid.android.kit.RoomSearch
import dev.centraid.android.kit.RowSkeleton
import dev.centraid.android.kit.SectionHeader
import dev.centraid.android.kit.SheetOption
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.SheetRow
import dev.centraid.android.kit.screenContentOf
import dev.centraid.android.screens.people.FilterChip
import dev.centraid.android.screens.people.SearchOpener
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/** Notes' band, drawn from the machine's tabs; More is the plate's own key. */
@Composable
internal fun NotesBandView(band: List<NotesBandTab>, onPick: (String) -> Unit, onHome: () -> Unit) {
    AppBand(
        app = "notes",
        tabs = band.filter { it.key != "more" }.map {
            AppBandTab(key = it.key, label = it.label, iconKey = it.icon_key, selected = it.current)
        },
        onSelect = onPick,
        onHome = onHome,
        onMore = if (band.any { it.key == "more" }) ({ onPick("more") }) else null,
    )
}

/**
 * THE NOTES LIBRARY (#1029 app port) in an `AppPlace`: pinned-first sections,
 * tag chips, a window that widens at the foot, search over it, More, the row
 * menu, file-into and sort as sheets, the trash confirm. A band tap on
 * another place and the three intents are the route's.
 */
@Composable
public fun NotesLibraryScreen(
    state: NotesLibraryState,
    onEvent: (NotesLibraryEvent) -> Unit,
    onHome: () -> Unit,
) {
    val chrome = state.chrome
    val search = state.search
    val write = state.write
    AppPlace(
        app = "notes",
        title = state.heading.ifEmpty { chrome?.title.orEmpty() },
        meta = state.data_?.count_label.orEmpty(),
        trailing = chrome?.let {
            RoomAction("Plus", it.new_note, "notes-new") {
                onEvent(NotesLibraryEvent(new_note = NotesLibraryEvent.NewNoteRequested()))
            }
        },
        search = search?.let {
            RoomSearch(
                field = it,
                placeholder = chrome?.search_placeholder.orEmpty(),
                label = chrome?.search_label.orEmpty(),
                closeLabel = chrome?.search_close.orEmpty(),
                onTerm = { term -> onEvent(NotesLibraryEvent(search_term = NotesLibraryEvent.SearchTermChanged(term))) },
                onClose = { onEvent(NotesLibraryEvent(search_closed = NotesLibraryEvent.SearchClosed())) },
            )
        },
        status = if (write?.phase == WriteState.Phase.PHASE_REFUSED) write.failure?.sentence.orEmpty() else "",
        band = { NotesBandView(state.band, { key -> onEvent(NotesLibraryEvent(band = NotesLibraryEvent.BandPicked(key))) }, onHome) },
    ) {
        val results = state.results
        if (search?.open_ == true && results != null) {
            LazyColumn(Modifier.testTag("notes-search-results")) {
                val empty = results.empty
                if (results.rows.isEmpty() && empty != null) {
                    item(key = "empty") {
                        if (empty.headline.isEmpty()) Quiet(empty.body) else EmptyStateView(empty, onAction = null)
                    }
                }
                items(results.rows, key = { "s-" + it.note_id }) { row -> NoteRow(row, chrome?.row_menu_label.orEmpty(), onEvent) }
            }
        } else {
            ReadStateView(
                content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
                onRetry = { onEvent(NotesLibraryEvent(refreshed = NotesLibraryEvent.Refreshed())) },
                retryLabel = chrome?.retry.orEmpty(),
                skeleton = { RowSkeleton(label = chrome?.loading.orEmpty()) },
            ) { data ->
                LazyColumn(Modifier.testTag("notes-library")) {
                    item(key = "search-open") {
                        SearchOpener(chrome?.search_placeholder.orEmpty()) {
                            onEvent(NotesLibraryEvent(search_opened = NotesLibraryEvent.SearchOpened()))
                        }
                    }
                    if (state.filter_label.isNotEmpty()) {
                        item(key = "filter") {
                            Row(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp)) {
                                Text(
                                    state.filter_label,
                                    style = centraidType("annotLabel"),
                                    color = centraidColor("textSoft"),
                                    modifier = Modifier.weight(1f).padding(top = 9.dp),
                                )
                                QuietButton(chrome?.filter_clear_label.orEmpty(), testTag = "notes-clear-filter") {
                                    onEvent(NotesLibraryEvent(filter_cleared = NotesLibraryEvent.FilterCleared()))
                                }
                            }
                        }
                    }
                    if (data.tags.isNotEmpty()) {
                        item(key = "tags") {
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .horizontalScroll(rememberScrollState())
                                    .padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                data.tags.forEach { tag ->
                                    FilterChip(tag.label, tag.label, tag.selected, "notes-tag-${tag.concept_id}") {
                                        onEvent(NotesLibraryEvent(tag = NotesLibraryEvent.TagToggled(tag.concept_id)))
                                    }
                                }
                            }
                        }
                    }
                    val empty = data.empty
                    if (data.sections.all { it.rows.isEmpty() } && empty != null) {
                        item(key = "empty") {
                            EmptyStateView(empty, onAction = { onEvent(NotesLibraryEvent(new_note = NotesLibraryEvent.NewNoteRequested())) })
                        }
                    }
                    sections(data.sections, chrome?.row_menu_label.orEmpty(), onEvent)
                    if (data.truncated) {
                        item(key = "window") {
                            Row(Modifier.fillMaxWidth().padding(KitGeometry.GUTTER)) {
                                Text(
                                    data.window_end_label,
                                    style = centraidType("annotLabel"),
                                    color = centraidColor("textSoft"),
                                    modifier = Modifier.weight(1f).padding(top = 9.dp),
                                )
                                if (data.window_end_verb.isNotEmpty()) {
                                    QuietButton(data.window_end_verb, testTag = "notes-window-widen") {
                                        onEvent(NotesLibraryEvent(window_widened = NotesLibraryEvent.WindowWidened()))
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    val close = { onEvent(NotesLibraryEvent(sheet_closed = NotesLibraryEvent.SheetClosed())) }
    when (state.sheet) {
        NotesLibraryState.Sheet.SHEET_MORE -> if (chrome != null) {
            SheetRoom(title = chrome.more_title, onDismiss = close) {
                SheetRow(chrome.sort_label, iconKey = "SwitchVert", testTag = "notes-more-sort", onTap = {
                    onEvent(NotesLibraryEvent(sheet_opened = NotesLibraryEvent.SheetOpened(NotesLibraryState.Sheet.SHEET_SORT)))
                })
                SheetRow(chrome.pinned_only_label, iconKey = "Pin", selected = state.pinned_only, testTag = "notes-more-pinned", onTap = {
                    onEvent(NotesLibraryEvent(pinned_only = NotesLibraryEvent.PinnedOnlyToggled()))
                })
                SheetRow(chrome.trash_label, iconKey = "Trash", testTag = "notes-more-trash", onTap = {
                    onEvent(NotesLibraryEvent(trash_opened = NotesLibraryEvent.TrashOpened()))
                })
            }
        }
        NotesLibraryState.Sheet.SHEET_SORT -> OptionSheet(
            title = chrome?.sort_title.orEmpty(),
            options = state.choices.map { SheetOption(key = it.id, label = it.label, detail = it.detail, selected = it.selected) },
            // The choice carries its sort (`NotesChoice.sort`): sent back as it came.
            onPick = { id ->
                val sort = state.choices.firstOrNull { it.id == id }?.sort
                if (sort != null && sort != NotesLibrarySort.NOTES_LIBRARY_SORT_UNSPECIFIED) {
                    onEvent(NotesLibraryEvent(sort = NotesLibraryEvent.SortPicked(sort)))
                }
            },
            onDismiss = close,
        )
        NotesLibraryState.Sheet.SHEET_FILE_INTO -> OptionSheet(
            title = chrome?.file_title.orEmpty(),
            options = state.choices.map { SheetOption(key = it.id, label = it.label, detail = it.detail, selected = it.selected) },
            onPick = { id -> onEvent(NotesLibraryEvent(notebook_chosen = NotesLibraryEvent.NotebookChosen(id))) },
            onDismiss = close,
        )
        NotesLibraryState.Sheet.SHEET_ROW_MENU -> state.menu?.let { menu ->
            SheetRoom(title = menu.title, onDismiss = close) {
                SheetRow(menu.pin_label, iconKey = "Pin", testTag = "notes-menu-pin", onTap = {
                    onEvent(NotesLibraryEvent(pin = NotesLibraryEvent.PinToggled(menu.note_id)))
                })
                SheetRow(menu.file_label, iconKey = "Folder", testTag = "notes-menu-file", onTap = {
                    onEvent(NotesLibraryEvent(file_ = NotesLibraryEvent.FileRequested(menu.note_id)))
                })
                SheetRow(menu.trash_label, iconKey = "Trash", destructive = true, testTag = "notes-menu-trash", onTap = {
                    onEvent(NotesLibraryEvent(trash = NotesLibraryEvent.TrashRequested(menu.note_id)))
                })
            }
        }
        else -> Unit
    }
    state.confirm?.let { confirm ->
        ConfirmSheet(
            confirm = confirm,
            onConfirm = { onEvent(NotesLibraryEvent(confirmed = NotesLibraryEvent.Confirmed())) },
            onDismiss = { onEvent(NotesLibraryEvent(dismissed = NotesLibraryEvent.Dismissed())) },
        )
    }
}

private fun LazyListScope.sections(
    sections: List<centraid.screen.v1.NotesLibrarySection>,
    menuLabel: String,
    onEvent: (NotesLibraryEvent) -> Unit,
) {
    sections.forEachIndexed { index, section ->
        val head = section.head
        if (head != null && head.title.isNotEmpty()) item(key = "head-$index") { SectionHeader(head) }
        items(section.rows, key = { "$index-" + it.note_id }) { row -> NoteRow(row, menuLabel, onEvent) }
    }
}

/** One note: title over snippet and meta, the checklist word as a chip, and the menu key. */
@Composable
private fun NoteRow(row: NotesNoteRow, menuLabel: String, onEvent: (NotesLibraryEvent) -> Unit) {
    CentraidRow(
        title = row.title,
        meta = listOf(row.snippet, row.meta).filter { it.isNotEmpty() }.joinToString(" · "),
        chips = listOfNotNull(if (row.check_label.isNotEmpty()) StatusChip(label = row.check_label) else null),
        testTag = "notes-row-${row.note_id}",
        onTap = { onEvent(NotesLibraryEvent(note_picked = NotesLibraryEvent.NotePicked(row.note_id, row.title))) },
    ) {
        IconKey(
            iconKey = "MoreHoriz",
            label = if (menuLabel.isEmpty()) row.accessibility_label else "$menuLabel, ${row.title}",
            testTag = "notes-row-menu-${row.note_id}",
            bordered = false,
        ) { onEvent(NotesLibraryEvent(row_menu = NotesLibraryEvent.RowMenuOpened(row.note_id))) }
    }
}

@Composable
internal fun Quiet(sentence: String) {
    if (sentence.isEmpty()) return
    Text(
        sentence,
        style = centraidType("annotLabel"),
        color = centraidColor("textSoft"),
        modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
    )
}
