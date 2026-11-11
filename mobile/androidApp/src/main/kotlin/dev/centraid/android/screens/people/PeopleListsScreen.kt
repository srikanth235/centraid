package dev.centraid.android.screens.people

import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import centraid.core.v1.PeopleListsEvent
import centraid.core.v1.PeopleListsState
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.EditableFieldRow
import dev.centraid.android.kit.PushedPage
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RoomAction
import dev.centraid.android.kit.SheetOutline
import dev.centraid.android.kit.SheetPrimary
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.StatusLine

/**
 * `people.lists` (#1185): the member's lists by name with how many people each holds, "New list"
 * in the header, and one name sheet that makes a list or renames the one tapped (its "Move to
 * trash" is on that sheet). THE VIEW DECIDES NOTHING: every word, count and flag is on
 * [PeopleListsState], and every tap is a [PeopleListsEvent]. The status line's Undo is the kit's
 * `status_acted`, sent from [StatusLine].
 */
@Composable
internal fun PeopleListsScreen(
    state: PeopleListsState,
    onEvent: (PeopleListsEvent) -> Unit,
    onBack: () -> Unit,
) {
    val data = state.data_
    PushedPage(
        title = state.title,
        parentTitle = state.back_label,
        onBack = onBack,
        app = "people",
        trailing = state.add_label.takeIf { it.isNotEmpty() }?.let { label ->
            RoomAction("Plus", label, "people-list-add") { onEvent(PeopleListsEvent(new_tapped = PeopleListsEvent.NewTapped())) }
        },
        statusLine = { StatusLine(state.status) },
    ) {
        ReadStateView(
            page = state.page!!,
            onRetry = { onEvent(PeopleListsEvent(refreshed = PeopleListsEvent.Refreshed())) },
        ) {
            LazyColumn {
                items(data?.rows.orEmpty(), key = { it.list_id }) { row ->
                    CentraidRow(
                        title = row.name,
                        meta = row.meta,
                        a11y = row.accessibility_label,
                        testTag = "people-list-row-${row.list_id}",
                        onTap = { onEvent(PeopleListsEvent(row_tapped = PeopleListsEvent.RowTapped(list_id = row.list_id))) },
                    )
                }
            }
        }
    }
    // THE NAME SHEET: a new list, or the one tapped. A name arms the verb; Move to trash asks nothing.
    state.sheet?.let { sheet ->
        val close = { onEvent(PeopleListsEvent(sheet_closed = PeopleListsEvent.SheetClosed())) }
        val trash = sheet.trash_label
        SheetRoom(
            title = sheet.title,
            onDismiss = close,
            primary = SheetPrimary(label = sheet.submit_label, enabled = sheet.can_submit, testTag = "people-list-submit") {
                onEvent(PeopleListsEvent(submitted = PeopleListsEvent.Submitted()))
            },
            outlines = listOfNotNull(
                trash?.takeIf { it.isNotEmpty() }?.let {
                    SheetOutline(label = it, testTag = "people-list-trash", ink = "net") {
                        onEvent(PeopleListsEvent(trash_tapped = PeopleListsEvent.TrashTapped()))
                    }
                },
                SheetOutline(label = sheet.cancel_label, testTag = "people-list-cancel", link = true, pageInk = true, onPress = close),
            ),
        ) {
            EditableFieldRow(
                key = "",
                value = sheet.name,
                reload = sheet.title,
                placeholder = sheet.name_placeholder,
                testTag = "people-list-name",
                onEdit = { onEvent(PeopleListsEvent(name_changed = PeopleListsEvent.NameChanged(text = it))) },
            )
        }
    }
}
