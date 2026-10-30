package dev.centraid.android.screens.notes

import dev.centraid.android.kit.SearchAskRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import centraid.core.v1.NotesBandTab
import centraid.core.v1.NotesHomeEvent
import centraid.core.v1.NotesHomeState
import centraid.core.v1.NotesJournalData
import centraid.core.v1.NotesLibraryData
import centraid.core.v1.NotesLibrarySort
import centraid.core.v1.NotesNoteRow
import centraid.core.v1.NotesNotebooksData
import centraid.core.v1.NotesPlace
import centraid.core.v1.NotesSheet
import centraid.core.v1.Route
import dev.centraid.android.kit.SearchField
import dev.centraid.android.kit.SectionHead
import centraid.core.v1.StatusChip
import dev.centraid.android.kit.AppBand
import dev.centraid.android.kit.AppBandTab
import dev.centraid.android.kit.AppPlace
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.EditableFieldRow
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.IconKey
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.OptionSheet
import dev.centraid.android.kit.OutlineButton
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RoomAction
import dev.centraid.android.kit.RoomChip
import dev.centraid.android.kit.RoomSearch
import dev.centraid.android.kit.RowSkeleton
import dev.centraid.android.kit.SearchContainerRow
import dev.centraid.android.kit.SectionHeader
import dev.centraid.android.kit.SheetOption
import dev.centraid.android.kit.SheetPrimary
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.SheetRow
import dev.centraid.android.kit.screenContentOf
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * `notes.home` (#1135): Notes · Notebooks · Journal under one band, with Search
 * a field over the Notes place and More a sheet.
 *
 * THE VIEW DECIDES NOTHING. The place, the heading, the band, the chip row, the
 * sections, every count and sentence, the sheets and their rows, the confirms
 * and the two forms are on [NotesHomeState], which Rust makes. A band tap is an
 * event and swaps the place; a row that opens a page carries its [Route] and a
 * tap hands it to [onOpen].
 */
@Composable
public fun NotesHomeScreen(
    state: NotesHomeState,
    onEvent: (NotesHomeEvent) -> Unit,
    onOpen: (Route) -> Unit,
    onHome: () -> Unit,
) {
    val chrome = state.chrome
    val notesPlace = state.place != NotesPlace.NOTES_PLACE_NOTEBOOKS && state.place != NotesPlace.NOTES_PLACE_JOURNAL
    val search = state.search
    val denied = state.denied
    AppPlace(
        app = "notes",
        title = state.title,
        meta = (state.library?.count_label).orEmpty(),
        trailing = if (denied != null) null else when (state.place) {
            NotesPlace.NOTES_PLACE_NOTEBOOKS -> RoomAction("Plus", chrome?.new_notebook.orEmpty(), "notes-new-notebook") {
                onEvent(NotesHomeEvent(form_opened = NotesHomeEvent.FormOpened(notebook_id = "")))
            }
            NotesPlace.NOTES_PLACE_JOURNAL -> RoomAction("Plus", chrome?.new_entry.orEmpty(), "notes-new-entry") {
                onEvent(NotesHomeEvent(new_entry = NotesHomeEvent.NewEntryTapped()))
            }
            else -> state.new_note?.let { route ->
                RoomAction("Plus", chrome?.new_note.orEmpty(), "notes-new") { onOpen(route) }
            }
        },
        search = if (notesPlace && search != null && denied == null) {
            RoomSearch(
                field = SearchField(open_ = search.open_, term = search.term, corrected = search.corrected),
                placeholder = chrome?.search_placeholder.orEmpty(),
                label = chrome?.search_label.orEmpty(),
                closeLabel = chrome?.search_close.orEmpty(),
                onTerm = { term -> onEvent(NotesHomeEvent(search_term = NotesHomeEvent.SearchTerm(term))) },
                onClose = { onEvent(NotesHomeEvent(search_closed = NotesHomeEvent.SearchClosed())) },
                onOpen = { onEvent(NotesHomeEvent(search_opened = NotesHomeEvent.SearchOpened())) },
            )
        } else {
            null
        },
        chips = if (notesPlace) {
            state.chips.map { chip ->
                RoomChip(
                    testTag = "notes-chip-${chip.key}",
                    label = chip.label,
                    selected = chip.selected,
                    chevron = chip.chevron,
                    spoken = chip.spoken,
                ) { onEvent(NotesHomeEvent(chip = NotesHomeEvent.ChipPicked(chip.key))) }
            }
        } else {
            emptyList()
        },
        status = state.status?.sentence.orEmpty(),
        band = if (state.band.isEmpty()) null else ({ NotesBand(state.band, { key -> onEvent(NotesHomeEvent(band = NotesHomeEvent.BandPicked(key))) }, onHome) }),
    ) {
        val results = search?.results
        if (notesPlace && search?.open_ == true && results != null && state.library != null) {
            LazyColumn(Modifier.testTag("notes-search-results")) {
                val empty = results.empty
                if (results.rows.isEmpty() && search.containers.isEmpty() && empty != null) {
                    item(key = "empty") {
                        if (empty.headline.isEmpty()) Quiet(empty.body) else EmptyStateView(empty, onAction = null)
                    }
                }
                // THE NOTEBOOKS WHOSE NAME MATCHED come first (#1097), through the route they carry.
                items(search.containers, key = { "c-${it.entity}-${it.id}" }) { container ->
                    SearchContainerRow(container, onOpen = onOpen)
                }
                items(results.rows, key = { "s-" + it.note_id }) { row -> NoteRow(row, "", onOpen, onEvent) }
                // THE ASK ROW closes the answer, whether or not anything matched (#1097).
                item(key = "ask") { SearchAskRow(search.ask, onOpen) }
            }
        } else {
            ReadStateView(
                content = screenContentOf(
                    state.loading,
                    state.failure,
                    state.library ?: state.notebooks ?: state.journal,
                    state.denied,
                ),
                onRetry = { onEvent(NotesHomeEvent(refreshed = NotesHomeEvent.Refreshed())) },
                retryLabel = chrome?.retry.orEmpty(),
                skeleton = { RowSkeleton(label = chrome?.loading.orEmpty()) },
            ) { data ->
                when (data) {
                    is NotesLibraryData -> LibraryList(data, state, onOpen, onEvent)
                    is NotesNotebooksData -> NotebooksList(data, state, onEvent)
                    is NotesJournalData -> JournalList(data, state, onOpen, onEvent)
                }
            }
        }
    }
    HomeSheets(state, onEvent, onOpen)
}

@Composable
private fun NotesBand(band: List<NotesBandTab>, onPick: (String) -> Unit, onHome: () -> Unit) {
    AppBand(
        app = "notes",
        tabs = band.map { AppBandTab(key = it.key, label = it.label, iconKey = it.icon_key, selected = it.current) },
        onSelect = onPick,
        onHome = onHome,
    )
}

@Composable
private fun LibraryList(
    data: NotesLibraryData,
    state: NotesHomeState,
    onOpen: (Route) -> Unit,
    onEvent: (NotesHomeEvent) -> Unit,
) {
    val menuLabel = state.chrome?.row_menu_label.orEmpty()
    LazyColumn(Modifier.testTag("notes-library")) {
        val empty = data.empty
        if (data.sections.all { it.rows.isEmpty() } && empty != null) {
            item(key = "empty") {
                EmptyStateView(empty, onAction = { state.new_note?.let(onOpen) })
            }
        }
        sections(data, menuLabel, onOpen, onEvent)
        if (data.truncated) {
            item(key = "window") {
                Row(Modifier.fillMaxWidth().padding(KitGeometry.GUTTER)) {
                    Text(
                        data.window_end_label,
                        style = centraidType("annotLabel"),
                        color = centraidColor("textSoft"),
                        modifier = Modifier.weight(1f).padding(top = 9.dp),
                    )
                    if (data.can_widen && data.window_end_verb.isNotEmpty()) {
                        OutlineButton(data.window_end_verb, testTag = "notes-window-widen") {
                            onEvent(NotesHomeEvent(window_widened = NotesHomeEvent.WindowWidened()))
                        }
                    }
                }
            }
        }
    }
}

private fun LazyListScope.sections(
    data: NotesLibraryData,
    menuLabel: String,
    onOpen: (Route) -> Unit,
    onEvent: (NotesHomeEvent) -> Unit,
) {
    data.sections.forEachIndexed { index, section ->
        val head = section.head
        if (head != null && head.title.isNotEmpty()) {
            item(key = "head-$index") { SectionHeader(SectionHead(title = head.title, count = head.count)) }
        }
        items(section.rows, key = { "$index-" + it.note_id }) { row -> NoteRow(row, menuLabel, onOpen, onEvent) }
    }
}

/** One note: title over snippet and meta, the checklist word as a chip, and the menu key. */
@Composable
private fun NoteRow(row: NotesNoteRow, menuLabel: String, onOpen: (Route) -> Unit, onEvent: (NotesHomeEvent) -> Unit) {
    val matchInk = centraidColor("text")
    CentraidRow(
        title = row.title,
        meta = listOf(row.snippet, row.meta).filter { it.isNotEmpty() }.joinToString(" · "),
        chips = listOfNotNull(if (row.check_label.isNotEmpty()) StatusChip(label = row.check_label) else null),
        // A SEARCH HIT'S SNIPPET, its matches emphasised as the index marked
        // them (`snippet_runs`); the meta follows as on any row.
        metaRuns = row.snippet_runs.takeIf { it.isNotEmpty() }?.let { runs ->
            androidx.compose.ui.text.buildAnnotatedString {
                runs.forEach { run ->
                    if (run.highlighted) {
                        pushStyle(
                            androidx.compose.ui.text.SpanStyle(
                                fontWeight = androidx.compose.ui.text.font.FontWeight.W600,
                                color = matchInk,
                            ),
                        )
                        append(run.text)
                        pop()
                    } else {
                        append(run.text)
                    }
                }
                if (row.meta.isNotEmpty()) append(" · ${row.meta}")
            }
        },
        testTag = "notes-row-${row.note_id}",
        onTap = { row.route?.let(onOpen) },
    ) {
        if (menuLabel.isNotEmpty()) {
            IconKey(
                iconKey = "MoreHoriz",
                label = "$menuLabel, ${row.title}",
                testTag = "notes-row-menu-${row.note_id}",
                bordered = false,
            ) { onEvent(NotesHomeEvent(row_menu = NotesHomeEvent.RowMenuOpened(row.note_id))) }
        }
    }
}

@Composable
private fun NotebooksList(data: NotesNotebooksData, state: NotesHomeState, onEvent: (NotesHomeEvent) -> Unit) {
    LazyColumn(Modifier.testTag("notes-notebooks")) {
        items(data.rows, key = { it.id }) { row ->
            CentraidRow(
                title = row.title,
                trailing = row.count,
                a11y = row.accessibility_label,
                testTag = "notes-notebook-${row.id}",
                onTap = { onEvent(NotesHomeEvent(notebook_picked = NotesHomeEvent.NotebookPicked(row.id))) },
            ) {
                if (row.manageable) {
                    IconKey(
                        iconKey = "MoreHoriz",
                        label = state.chrome?.notebook_menu_title.orEmpty(),
                        testTag = "notes-notebook-menu-${row.id}",
                        bordered = false,
                    ) { onEvent(NotesHomeEvent(notebook_menu = NotesHomeEvent.NotebookMenuOpened(row.id))) }
                }
            }
        }
        val empty = data.empty
        if (empty != null) {
            item(key = "empty") {
                EmptyStateView(empty, onAction = { onEvent(NotesHomeEvent(form_opened = NotesHomeEvent.FormOpened(notebook_id = ""))) })
            }
        }
    }
}

@Composable
private fun JournalList(
    data: NotesJournalData,
    state: NotesHomeState,
    onOpen: (Route) -> Unit,
    onEvent: (NotesHomeEvent) -> Unit,
) {
    val empty = data.empty
    if (data.days.isEmpty() && empty != null) {
        EmptyStateView(empty, onAction = null)
        return
    }
    LazyColumn(Modifier.testTag("notes-journal")) {
        item(key = "origin") { Quiet(state.chrome?.journal_origin.orEmpty()) }
        data.days.forEach { day ->
            day.head?.let { head ->
                item(key = "d-" + day.day) { SectionHeader(SectionHead(title = head.title, count = head.count)) }
            }
            items(day.rows, key = { day.day + "-" + it.note_id }) { row ->
                CentraidRow(
                    title = row.title,
                    meta = row.meta,
                    trailing = row.trailing,
                    a11y = row.accessibility_label,
                    testTag = "notes-entry-${row.note_id}",
                    onTap = { row.route?.let(onOpen) },
                )
            }
        }
        if (data.truncated && data.window_end_verb.isNotEmpty()) {
            item(key = "window") {
                OutlineButton(
                    data.window_end_verb,
                    testTag = "notes-journal-widen",
                    modifier = Modifier.padding(KitGeometry.GUTTER),
                ) { onEvent(NotesHomeEvent(window_widened = NotesHomeEvent.WindowWidened())) }
            }
        }
    }
}

/** Every sheet and form the page can hold: More, the row and notebook menus, file-into, sort, the confirm, the notebook form and the journal's new entry. */
@Composable
private fun HomeSheets(state: NotesHomeState, onEvent: (NotesHomeEvent) -> Unit, onOpen: (Route) -> Unit) {
    val chrome = state.chrome
    val close = { onEvent(NotesHomeEvent(sheet_closed = NotesHomeEvent.SheetClosed())) }
    if (state.confirm == null) {
        when (state.sheet) {
            // MORE IS RUST'S ROWS (Trash): never search, sort or a filter.
            NotesSheet.NOTES_SHEET_MORE -> SheetRoom(title = chrome?.more_title.orEmpty(), onDismiss = close) {
                state.more_rows.forEach { row ->
                    SheetRow(row.label, iconKey = row.icon_key, testTag = "notes-more-${row.key}", onTap = {
                        close()
                        row.route?.let(onOpen)
                    })
                }
            }
            NotesSheet.NOTES_SHEET_SORT -> OptionSheet(
                title = chrome?.sort_title.orEmpty(),
                options = state.choices.map { SheetOption(key = it.id, label = it.label, selected = it.selected) },
                // The choice carries its sort (`NotesChoice.sort`): sent back as it came.
                onPick = { id ->
                    val sort = state.choices.firstOrNull { it.id == id }?.sort
                    if (sort != null && sort != NotesLibrarySort.NOTES_LIBRARY_SORT_UNSPECIFIED) {
                        onEvent(NotesHomeEvent(sort = NotesHomeEvent.SortPicked(sort)))
                    }
                },
                onDismiss = close,
            )
            NotesSheet.NOTES_SHEET_FILE_INTO -> OptionSheet(
                title = chrome?.file_title.orEmpty(),
                options = state.choices.map { SheetOption(key = it.id, label = it.label, selected = it.selected) },
                onPick = { id -> onEvent(NotesHomeEvent(notebook_chosen = NotesHomeEvent.NotebookChosen(id))) },
                onDismiss = close,
            )
            NotesSheet.NOTES_SHEET_ROW_MENU -> state.menu?.let { menu ->
                SheetRoom(title = menu.title, onDismiss = close) {
                    SheetRow(menu.pin_label, iconKey = "Pin", testTag = "notes-menu-pin", onTap = {
                        onEvent(NotesHomeEvent(pin = NotesHomeEvent.PinToggled(menu.note_id)))
                    })
                    SheetRow(menu.file_label, iconKey = "Folder", testTag = "notes-menu-file", onTap = {
                        onEvent(NotesHomeEvent(file_into = NotesHomeEvent.FileIntoOpened(menu.note_id)))
                    })
                    SheetRow(menu.trash_label, iconKey = "Trash", destructive = true, testTag = "notes-menu-trash", onTap = {
                        onEvent(NotesHomeEvent(trash = NotesHomeEvent.TrashAsked(menu.note_id)))
                    })
                }
            }
            NotesSheet.NOTES_SHEET_NOTEBOOK_MENU -> state.menu?.let { menu ->
                SheetRoom(title = menu.title, onDismiss = close) {
                    SheetRow(menu.rename_label, iconKey = "Pencil", testTag = "notes-notebook-rename", onTap = {
                        onEvent(NotesHomeEvent(form_opened = NotesHomeEvent.FormOpened(notebook_id = menu.note_id)))
                    })
                    SheetRow(menu.trash_label, iconKey = "Trash", destructive = true, testTag = "notes-notebook-delete", onTap = {
                        onEvent(NotesHomeEvent(notebook_delete = NotesHomeEvent.NotebookDeleteAsked(notebook_id = menu.note_id)))
                    })
                }
            }
            else -> Unit
        }
    }
    state.confirm?.let { confirm ->
        ConfirmSheet(
            confirm = confirm,
            onConfirm = { onEvent(NotesHomeEvent(confirmed = NotesHomeEvent.Confirmed())) },
            onDismiss = { onEvent(NotesHomeEvent(dismissed = NotesHomeEvent.Dismissed())) },
        )
    }
    state.form?.let { form ->
        SheetRoom(
            title = form.title,
            onDismiss = { onEvent(NotesHomeEvent(form_dismissed = NotesHomeEvent.FormDismissed())) },
            status = form.status,
            primary = SheetPrimary(form.confirm_label, testTag = "notes-notebook-confirm", enabled = form.can_confirm) {
                onEvent(NotesHomeEvent(form_confirmed = NotesHomeEvent.FormConfirmed()))
            },
        ) {
            EditableFieldRow(
                key = "",
                value = form.name,
                reload = form.notebook_id,
                placeholder = form.placeholder,
                testTag = "notes-notebook-name",
                onEdit = { onEvent(NotesHomeEvent(form_name = NotesHomeEvent.FormNameEdited(it))) },
            )
            SheetRow(form.cancel_label, testTag = "notes-notebook-cancel", onTap = {
                onEvent(NotesHomeEvent(form_dismissed = NotesHomeEvent.FormDismissed()))
            })
        }
    }
    // THE NEW-ENTRY SHEET: every word, and whether Save is offered, is Rust's.
    state.compose?.let { compose ->
        SheetRoom(
            title = compose.title,
            onDismiss = { onEvent(NotesHomeEvent(compose_closed = NotesHomeEvent.ComposeClosed())) },
            primary = SheetPrimary(label = compose.save, testTag = "notes-journal-save", enabled = compose.can_save) {
                onEvent(NotesHomeEvent(compose_saved = NotesHomeEvent.ComposeSaved()))
            },
            status = compose.status,
        ) {
            EditableFieldRow(
                key = "",
                value = compose.mood,
                reload = compose.day,
                placeholder = compose.mood_placeholder,
                testTag = "notes-journal-mood",
                onEdit = { onEvent(NotesHomeEvent(compose_edited = NotesHomeEvent.ComposeEdited(mood = it, text = compose.text))) },
            )
            EditableFieldRow(
                key = "",
                value = compose.text,
                reload = compose.day,
                placeholder = compose.text_placeholder,
                singleLine = false,
                testTag = "notes-journal-text",
                onEdit = { onEvent(NotesHomeEvent(compose_edited = NotesHomeEvent.ComposeEdited(mood = compose.mood, text = it))) },
            )
        }
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
