package dev.centraid.android.screens

import dev.centraid.android.kit.KitWords
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import centraid.core.v1.PhotosBatchAction
import centraid.core.v1.PhotosSelectionEvent
import centraid.core.v1.PhotosShelfEvent
import centraid.core.v1.PhotosShelfState
import centraid.core.v1.Route
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.IconKey
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitLink
import dev.centraid.android.kit.OptionSheet
import dev.centraid.android.kit.OutlineButton
import dev.centraid.android.kit.PhotoCellsGrid
import dev.centraid.android.kit.PhotosAlbumChoiceSheet
import dev.centraid.android.kit.RowSkeleton
import dev.centraid.android.kit.ScreenEmpty
import dev.centraid.android.kit.ScreenFailure
import dev.centraid.android.kit.SheetOption
import dev.centraid.android.kit.SheetPrimary
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.kitSwitchColors
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * A PHOTO SHELF, drawn from the core's [PhotosShelfState] (#1135): favourites,
 * videos, the archive, the trash, an album, a place, the photographs with no
 * place. `crates/screens/src/photos/shelf.rs` decides everything a member reads
 * and does here (the head, the count, this shelf's empty sentence, the bar's
 * verbs and their confirms, the sheets); this draws it and sends events. The only
 * state kept here is the typed album name in the rename sheet and the open
 * menus.
 *
 * A cell carries the [Route] to the lightbox, so a tap opens it through [onOpen]
 * and no shelf names a destination. [dismissed] (the album is gone) pops.
 *
 * The SwiftUI twin is `mobile/iosApp/Sources/PhotoShelfView.swift`.
 */
@Composable
public fun PhotoShelfScreen(
    state: PhotosShelfState,
    onEvent: (PhotosShelfEvent) -> Unit,
    onOpen: (Route) -> Unit = {},
    onClose: () -> Unit = {},
) {
    LaunchedEffect(state.dismissed) { if (state.dismissed) onClose() }
    val selection = state.selection
    val selecting = selection?.selecting == true
    val data = state.data_
    val album = state.album
    val chrome = state.chrome
    val select = { event: PhotosSelectionEvent -> onEvent(PhotosShelfEvent(selection = event)) }

    Column(
        modifier = Modifier.padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = data?.count_label.orEmpty(),
                style = centraidType("control"),
                color = centraidColor("textSoft"),
            )
            if (selecting) {
                KitLink(
                    label = chrome?.done_label.orEmpty(),
                    onClick = { select(PhotosSelectionEvent(mode = PhotosSelectionEvent.ModeSet(selecting = false))) },
                )
            } else if (data != null && data.cells.isNotEmpty()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    val emptyTrash = data.empty_trash_label
                    if (emptyTrash != null) {
                        OutlineButton(
                            label = emptyTrash,
                            testTag = "shelf-empty-trash",
                            ink = "net",
                            onPress = {
                                onEvent(
                                    PhotosShelfEvent(
                                        prompt_opened = PhotosShelfEvent.PromptOpened(
                                            prompt = PhotosShelfState.Prompt.PROMPT_EMPTY_TRASH,
                                        ),
                                    ),
                                )
                            },
                        )
                    }
                    KitLink(
                        label = chrome?.select_label.orEmpty(),
                        onClick = { select(PhotosSelectionEvent(mode = PhotosSelectionEvent.ModeSet(selecting = true))) },
                    )
                }
            }
        }

        if (album != null) {
            if (album.trashed) {
                // A TRASHED ALBUM OFFERS ITS WAY BACK, and none of the verbs of a live one.
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(
                        text = album.trashed_note,
                        style = centraidType("small"),
                        color = centraidColor("textSoft"),
                        modifier = Modifier.weight(1f),
                    )
                    OutlineButton(
                        label = album.restore_label,
                        testTag = "album-restore",
                        onPress = { onEvent(PhotosShelfEvent(album_restored = PhotosShelfEvent.AlbumRestored())) },
                    )
                }
            } else {
                AlbumActions(
                    state = state,
                    onAdd = { album.add_route?.let(onOpen) },
                    onPrompt = { prompt ->
                        onEvent(PhotosShelfEvent(prompt_opened = PhotosShelfEvent.PromptOpened(prompt = prompt)))
                    },
                )
            }
        }

        val keep = state.keep_originals
        if (keep != null) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(text = keep.title, style = centraidType("body"), color = centraidColor("text"))
                    Text(text = keep.meta, style = centraidType("small"), color = centraidColor("textSoft"))
                }
                Switch(
                    checked = keep.keep,
                    onCheckedChange = { value ->
                        onEvent(PhotosShelfEvent(keep_toggled = PhotosShelfEvent.KeepToggled(keep = value)))
                    },
                    enabled = keep.ready,
                    colors = kitSwitchColors(),
                    modifier = Modifier.semantics {
                        contentDescription = keep.label
                        stateDescription = keep.meta
                    },
                )
            }
        }

        if (state.purge_window.isNotEmpty()) {
            Text(text = state.purge_window, style = centraidType("small"), color = centraidColor("textSoft"))
        }

        // A REFUSED WRITE, ABOVE THE CELLS AND NEVER INSTEAD OF THEM: it lands in
        // `status`, not in the read's `failure`, so the shelf and the pick stay.
        state.status?.let { ScreenFailure(it.sentence, "") }
        if (state.notice.isNotEmpty()) {
            Text(text = state.notice, style = centraidType("small"), color = centraidColor("textSoft"))
        }

        val loading = state.loading
        val failure = state.failure
        when {
            loading != null -> RowSkeleton()
            failure != null -> ScreenFailure(failure.sentence, failure.remedy)
            data != null -> {
                val empty = data.empty
                if (empty != null) {
                    ScreenEmpty(sentence = empty.headline, remedy = empty.body)
                } else {
                    PhotoCellsGrid(
                        cells = data.cells.map { it.tile!! },
                        selected = selection?.selected_ids.orEmpty().toSet(),
                        onTap = { photoId ->
                            if (selecting) {
                                select(PhotosSelectionEvent(toggled = PhotosSelectionEvent.Toggled(photo_id = photoId)))
                            } else {
                                data.cells.firstOrNull { it.tile?.photo_id == photoId }?.open_?.let(onOpen)
                            }
                        },
                    )
                    if (data.can_show_more) {
                        KitLink(
                            label = data.show_more_label,
                            onClick = { onEvent(PhotosShelfEvent(load_more = PhotosShelfEvent.LoadMore())) },
                        )
                    }
                }
            }
        }

        if (selecting && selection != null) {
            SelectionBar(state = state, onEvent = onEvent, select = select)
        }
    }

    state.album_choice?.takeIf { it.open_ }?.let { choice ->
        PhotosAlbumChoiceSheet(choice = choice) { onEvent(PhotosShelfEvent(album_choice = it)) }
    }

    // THE BATCH CONFIRM (trash, delete forever) is the selection's; this one is
    // the screen's (empty trash, delete album). Both are Rust's words.
    val batchConfirm = selection?.confirm
    if (batchConfirm != null) {
        ConfirmSheet(
            confirm = batchConfirm,
            onConfirm = { select(PhotosSelectionEvent(confirmed = PhotosSelectionEvent.Confirmed())) },
            onDismiss = { select(PhotosSelectionEvent(dismissed = PhotosSelectionEvent.ConfirmDismissed())) },
            cancelLabel = state.prompt_cancel_label,
        )
    }
    val confirm = state.confirm
    if (confirm != null) {
        ConfirmSheet(
            confirm = confirm,
            onConfirm = { onEvent(PhotosShelfEvent(prompt_confirmed = PhotosShelfEvent.PromptConfirmed())) },
            onDismiss = { onEvent(PhotosShelfEvent(prompt_dismissed = PhotosShelfEvent.PromptDismissed())) },
            cancelLabel = state.prompt_cancel_label,
        )
    }
    val rename = state.rename
    if (rename != null) {
        RenameSheet(
            title = rename.title,
            fieldLabel = rename.field_label,
            current = rename.current,
            onDismiss = { onEvent(PhotosShelfEvent(prompt_dismissed = PhotosShelfEvent.PromptDismissed())) },
            primaryLabel = rename.save_label,
        ) { title ->
            onEvent(PhotosShelfEvent(album_renamed = PhotosShelfEvent.AlbumRenamed(title = title)))
        }
    }
    val location = state.location_choice
    if (location != null) {
        OptionSheet(
            title = location.title,
            options = listOf(
                SheetOption(key = "none", label = location.none_label),
                SheetOption(key = "exact", label = location.exact_label),
            ),
            onPick = { key ->
                onEvent(PhotosShelfEvent(location_chosen = PhotosShelfEvent.LocationChosen(exact = key == "exact")))
            },
            onDismiss = { onEvent(PhotosShelfEvent(prompt_dismissed = PhotosShelfEvent.PromptDismissed())) },
        )
    }
}

/** The album's own verbs: add to it, and behind one menu, rename or delete it. */
@Composable
private fun AlbumActions(
    state: PhotosShelfState,
    onAdd: () -> Unit,
    onPrompt: (PhotosShelfState.Prompt) -> Unit,
) {
    val album = state.album ?: return
    var open by remember { mutableStateOf(false) }
    Row(verticalAlignment = Alignment.CenterVertically) {
        KitLink(label = album.add_label, onClick = onAdd)
        Box {
            IconKey(
                iconKey = "MoreHoriz",
                label = album.options_label,
                testTag = "album-options",
                bordered = false,
                onPress = { open = true },
            )
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                DropdownMenuItem(
                    text = { Text(text = album.rename_label) },
                    onClick = {
                        open = false
                        onPrompt(PhotosShelfState.Prompt.PROMPT_RENAME_ALBUM)
                    },
                )
                DropdownMenuItem(
                    text = { Text(text = album.delete_label, color = centraidColor("net")) },
                    onClick = {
                        open = false
                        onPrompt(PhotosShelfState.Prompt.PROMPT_DELETE_ALBUM)
                    },
                )
            }
        }
    }
}

/** The icon key for a bar verb; one [dev.centraid.design.CentraidCatalog] has. */
private fun iconOf(kind: PhotosBatchAction.Kind): String = when (kind) {
    PhotosBatchAction.Kind.KIND_FAVORITE, PhotosBatchAction.Kind.KIND_UNFAVORITE -> "heart"
    PhotosBatchAction.Kind.KIND_ADD_TO_ALBUM -> "album"
    PhotosBatchAction.Kind.KIND_ARCHIVE -> "Archive"
    PhotosBatchAction.Kind.KIND_UNARCHIVE, PhotosBatchAction.Kind.KIND_RESTORE -> "restore"
    PhotosBatchAction.Kind.KIND_TRASH, PhotosBatchAction.Kind.KIND_DELETE_FOREVER -> "trash"
    else -> "MoreHoriz"
}

/**
 * THE BAR: the verbs Rust offered for this shelf, in its order, disabled with
 * nothing picked rather than hidden (a bar whose keys come and go moves under a
 * thumb). A second Favorite/Unfavorite pair and the album's Remove sit in the
 * menu with the hand-off verbs.
 */
@Composable
private fun SelectionBar(
    state: PhotosShelfState,
    onEvent: (PhotosShelfEvent) -> Unit,
    select: (PhotosSelectionEvent) -> Unit,
) {
    val selection = state.selection ?: return
    val bar = state.bar
    val actions = selection.actions
    val offersFavorite = actions.any { it.kind == PhotosBatchAction.Kind.KIND_FAVORITE }
    val inMenu = { action: PhotosBatchAction ->
        action.kind == PhotosBatchAction.Kind.KIND_REMOVE_FROM_ALBUM ||
            (offersFavorite && action.kind == PhotosBatchAction.Kind.KIND_UNFAVORITE)
    }
    val trash = actions.any { it.kind == PhotosBatchAction.Kind.KIND_RESTORE }
    var more by remember { mutableStateOf(false) }
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (bar != null && !trash) {
            IconKey(
                iconKey = "share",
                label = bar.send_copy_label,
                testTag = "shelf-verb",
                bordered = false,
                enabled = bar.enabled,
                onPress = {
                    onEvent(
                        PhotosShelfEvent(
                            prompt_opened = PhotosShelfEvent.PromptOpened(
                                prompt = PhotosShelfState.Prompt.PROMPT_SEND_LOCATION,
                            ),
                        ),
                    )
                },
            )
        }
        actions.filterNot(inMenu).forEach { action ->
            IconKey(
                iconKey = iconOf(action.kind),
                label = action.label,
                testTag = "shelf-verb",
                bordered = false,
                enabled = action.enabled,
                onPress = {
                    select(PhotosSelectionEvent(action = PhotosSelectionEvent.ActionTapped(kind = action.kind)))
                },
            )
        }
        if (bar != null && !trash) {
            Box {
                IconKey(
                    iconKey = "MoreHoriz",
                    label = bar.more_label,
                    testTag = "shelf-verb",
                    bordered = false,
                    enabled = bar.enabled,
                    onPress = { more = true },
                )
                DropdownMenu(expanded = more, onDismissRequest = { more = false }) {
                    DropdownMenuItem(
                        text = { Text(text = bar.download_label) },
                        onClick = {
                            more = false
                            onEvent(PhotosShelfEvent(download = PhotosShelfEvent.DownloadRequested()))
                        },
                    )
                    actions.filter(inMenu).forEach { action ->
                        DropdownMenuItem(
                            text = { Text(text = action.label) },
                            enabled = action.enabled,
                            onClick = {
                                more = false
                                select(PhotosSelectionEvent(action = PhotosSelectionEvent.ActionTapped(kind = action.kind)))
                            },
                        )
                    }
                    if (bar.make_key_offered) {
                        DropdownMenuItem(
                            text = { Text(text = bar.make_key_label) },
                            enabled = bar.make_key_enabled,
                            onClick = {
                                more = false
                                onEvent(PhotosShelfEvent(cover_chosen = PhotosShelfEvent.CoverChosen()))
                            },
                        )
                    }
                }
            }
        }
        Text(
            text = selection.title,
            style = centraidType("small"),
            color = centraidColor("textSoft"),
        )
    }
}

/**
 * RENAME, as one field and a verb in a [SheetRoom]. An empty name is not
 * offered: the vault's `title` is `minLength: 1`, and the reducer drops it
 * besides, so a blank name sends nothing.
 *
 * **THE DRAFT IS THIS SHEET'S, and so is the blank guard**: neither
 * `PhotosRenameSheet` nor `PhotosPlaceNameSheet` carries a can-save flag, as
 * `PhotosCollections.new_album_can_submit` does for a new album. Until Rust says
 * so (the iOS shelf trims the same way), the guard here is the old behaviour,
 * kept and not extended.
 */
@Composable
internal fun RenameSheet(
    title: String,
    fieldLabel: String,
    current: String,
    onDismiss: () -> Unit,
    primaryLabel: String = KitWords.SAVE,
    onSave: (String) -> Unit,
) {
    var name by remember { mutableStateOf(current) }
    NameSheet(
        title = title,
        fieldLabel = fieldLabel,
        name = name,
        onName = { name = it },
        canSubmit = name.isNotBlank(),
        primaryLabel = primaryLabel,
        onDismiss = onDismiss,
        onSave = { onSave(name) },
    )
}

/**
 * A SHEET WITH ONE NAME FIELD AND ONE VERB — rename, and name a new album. The
 * verb is the sheet's ink button, drawn disabled while [canSubmit] is false: a
 * blank name is not a write, and whether it is blank is the caller's state to
 * say (a new album's is Rust's `new_album_can_submit`), never this sheet's.
 * [status] is the refusal's sentence, beside the field and never instead of it.
 */
@Composable
internal fun NameSheet(
    title: String,
    fieldLabel: String,
    name: String,
    onName: (String) -> Unit,
    canSubmit: Boolean,
    primaryLabel: String,
    onDismiss: () -> Unit,
    status: String = "",
    onSave: () -> Unit,
) {
    SheetRoom(
        title = title,
        onDismiss = onDismiss,
        status = status,
        primary = SheetPrimary(label = primaryLabel, testTag = "rename-save", enabled = canSubmit, onPress = onSave),
    ) {
        NameField(
            value = name,
            onValueChange = onName,
            label = fieldLabel,
            modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
        )
    }
}

/** A NAME FIELD: one line on a `lineStrong` hairline, its label the placeholder. */
@Composable
internal fun NameField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier
            .fillMaxWidth()
            .heightIn(min = KitGeometry.ROW_MIN)
            .border(KitGeometry.HAIRLINE, centraidColor("lineStrong"), RoundedCornerShape(KitGeometry.RADIUS))
            .padding(horizontal = 12.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        if (value.isEmpty()) {
            Text(
                text = label,
                style = centraidType("body"),
                color = centraidColor("textFaint"),
                modifier = Modifier.clearAndSetSemantics { },
            )
        }
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            singleLine = true,
            textStyle = centraidType("body").copy(color = centraidColor("text")),
            cursorBrush = SolidColor(centraidColor("text")),
            modifier = Modifier
                .fillMaxWidth()
                .testTag("rename-field")
                .semantics { contentDescription = label },
        )
    }
}
