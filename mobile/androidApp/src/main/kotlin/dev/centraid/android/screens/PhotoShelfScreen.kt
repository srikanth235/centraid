package dev.centraid.android.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.border
import androidx.compose.foundation.text.BasicTextField
import dev.centraid.android.kit.RowSkeleton
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import centraid.screen.v1.AlbumChoiceCreated
import centraid.screen.v1.AlbumChoiceDismissed
import centraid.screen.v1.AlbumChoiceOpened
import centraid.screen.v1.AlbumChosen
import centraid.screen.v1.Confirm
import centraid.screen.v1.PhotoShelfEvent
import centraid.screen.v1.PhotoShelfState
import centraid.screen.v1.PhotoStateView
import dev.centraid.android.kit.AlbumChoiceSheet
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.IconKey
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitLink
import dev.centraid.android.kit.OptionSheet
import dev.centraid.android.kit.OutlineButton
import dev.centraid.android.kit.SheetOption
import dev.centraid.android.kit.SheetPrimary
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.PhotoCellsGrid
import dev.centraid.android.kit.ScreenEmpty
import dev.centraid.android.kit.ScreenFailure
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.copy.PhotosCopy
import dev.centraid.shared.apps.photos.PhotoShelfMachine
import dev.centraid.shared.kit.CappedCount

/**
 * A PHOTO SHELF: the library under a predicate (#1029, photos port).
 *
 * One screen for four of v0's routes — `PhotoStateView` (favourites, archive,
 * trash, videos), `AlbumDetail`, `PlaceDetail` and a memory's
 * members. They were four screens reading one table in one order and drawing
 * one cell, and they drifted exactly where four copies drift: only
 * `AlbumDetail.tsx` had a selection mode, only `PlaceDetail.tsx` had its own
 * empty sentence, and only the trash could say anything about the purge.
 *
 * The SwiftUI twin is `mobile/iosApp/Sources/PhotoShelfView.swift`; the two are
 * kept in step by hand, which is what a shared state message and a shared
 * screen id buy — the arrangement is per platform, the meaning is not.
 *
 * **The copy is `PhotoShelfMachine`'s, called from here.** This side can call
 * the machine directly because it is the same Kotlin; SwiftUI cannot, because
 * its `PhotoShelf` is SwiftProtobuf's struct and the machine's is Wire's class,
 * so that shell reads the same answers off `PhotoShelfBridge.sentences()`. One
 * derivation, two callers.
 */
@Composable
public fun PhotoShelfScreen(
    state: PhotoShelfState,
    onEvent: (PhotoShelfEvent) -> Unit,
    /**
     * OPEN ONE PHOTOGRAPH, AS NAVIGATION AND NOT AS AN EVENT.
     *
     * `PhotoShelfEvent` has no "cell tapped" arm, which is right: the shelf's
     * own state does not change when a member walks into the lightbox. The
     * neighbours are this shelf's order, so a swipe there needs no read.
     *
     * Defaulted so a preview and a fixture render this screen without one.
     */
    onOpenAsset: (assetId: String, neighbours: List<String>) -> Unit = { _, _ -> },
    /**
     * ADD PHOTOGRAPHS TO THIS ALBUM — the picker's only door.
     *
     * `photos.picker` was wired, correct and **unreachable**: nothing on
     * either shell pushed it, so a member could make an album and never put
     * anything in it. An album is the one shelf this belongs on — the standing
     * four are predicates over the library and have nothing to add to — which
     * is why the shelf offers it and Collections does not.
     */
    onAddPhotographs: (collectionId: String, name: String) -> Unit = { _, _ -> },
    /**
     * "SEND A COPY" AND "DOWNLOAD ORIGINAL" — the platform's, not the vault's.
     * Neither writes anything, so neither is an event: the activity finds the
     * originals and hands them off (`PhotoShelfCopies.kt`), and what that came
     * to comes back into `export_notice`.
     */
    onExport: (assetIds: List<String>, export: ShelfExport) -> Unit = { _, _ -> },
    /** The album this shelf was showing is gone; leave. */
    onClose: () -> Unit = {},
) {
    val shelf = state.shelf
    // THE PURGE CONFIRMATION IS THE SCREEN'S, deliberately.
    // `media.purge_asset` is `confirm: false` in the registry and its own
    // comment says why: a command-level confirm would ALSO park the member's
    // own act. So the safety is here, in front of the write, and it is the only
    // thing standing between a tap and a row that does not come back.
    var confirmingPurge by remember { mutableStateOf(false) }
    var confirmingEmptyTrash by remember { mutableStateOf(false) }
    var confirmingAlbumDelete by remember { mutableStateOf(false) }
    var choosingPlace by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }

    // THE ALBUM IS GONE — its delete committed — so the shelf showing it
    // leaves. What it would otherwise offer is Add and Rename against a row
    // the vault now refuses on `album_exists`.
    LaunchedEffect(state.album_gone) { if (state.album_gone) onClose() }

    Column(
        modifier = Modifier.padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        ShelfHeader(state, onEvent) { confirmingEmptyTrash = true }

        // ONLY AN ALBUM CAN BE ADDED TO. `PhotoShelf` is a oneof, so this is
        // a case check and not a flag: favourites, archive, trash, videos, a
        // place and a memory are all predicates over photographs
        // already in the vault, and "add" means nothing on any of them.
        val album = shelf?.album
        if (album != null) {
            AlbumActions(
                onAdd = { onAddPhotographs(album.collection_id, album.name) },
                onRename = { renaming = true },
                onDelete = { confirmingAlbumDelete = true },
            )
        }

        // "KEEP ORIGINALS ON THIS PHONE" — an album's, and only an album's
        // (`KeepOriginals.opened`).
        val keep = state.keep_originals
        if (keep != null && keep.offered) {
            KeepOriginalsRowView(keep) { value ->
                onEvent(PhotoShelfEvent(keep_originals_toggled = PhotoShelfEvent.KeepOriginalsToggled(keep = value)))
            }
        }

        // THE TRASH SAYS WHAT THE RULE IS, and it is the only shelf that does.
        // A WINDOW and not a countdown: `purge_window_days` is 0 on every other
        // shelf, so the sentence is empty there — and the field carries the
        // fact, so this draws what the state says rather than asking the shelf
        // a second question it could answer differently.
        val window = PhotoShelfMachine.purgeWindowSentence(state.purge_window_days)
        if (window.isNotEmpty()) {
            Text(
                text = window,
                style = centraidType("small"),
                color = centraidColor("textSoft"),
            )
        }

        // A WRITE WAS REFUSED, AND IT DOES NOT TAKE THE SHELF WITH IT.
        //
        // Drawn ABOVE the cells and OUTSIDE the `when` below, which is the
        // whole reason `write_failure` is its own field: a denied delete
        // rendered through the read's `failure` would replace a shelf full of
        // photographs with an error message, and a member would lose the very
        // selection they were deleting from. `NoteDraft.save_failure` is the
        // same field for the same reason.
        val refusal = state.write_failure
        if (refusal != null) ScreenFailure(refusal.sentence, refusal.remedy)

        // WHAT A COPY CAME TO — one clause, from the shell, and gone with the
        // next verb. Not a refusal: nothing was written.
        if (state.export_notice.isNotEmpty()) {
            Text(text = state.export_notice, style = centraidType("small"), color = centraidColor("textSoft"))
        }

        // A WIRE PROPERTY IS CROSS-MODULE PUBLIC API, so Kotlin will not
        // smart-cast it after a null check. Binding each arm's value to a local
        // first is what makes the branches type-check, and it is the shape
        // every screen in this module uses.
        val loading = state.loading
        val failure = state.failure
        val data = state.data_
        when {
            loading != null -> RowSkeleton()

            failure != null -> ScreenFailure(failure.sentence, failure.remedy)

            data != null ->
                if (data.cells.isEmpty()) {
                    // NOTHING HERE, AND WHY — this shelf's sentence and never a
                    // generic one. An empty archive and an empty place are
                    // different answers to different questions.
                    ScreenEmpty(
                        sentence = PhotoShelfMachine.emptySentence(shelf),
                        remedy = PhotoShelfMachine.emptyRemedy(shelf),
                    )
                } else {
                    val ids = data.cells.map { it.asset_id }
                    PhotoCellsGrid(
                        cells = data.cells,
                        packAbsent = data.thumbnail_pack_absent,
                        selected = state.selected_asset_ids.toSet(),
                        onTap = { assetId ->
                            if (state.selecting) {
                                onEvent(
                                    PhotoShelfEvent(
                                        selection = PhotoShelfEvent.SelectionToggled(assetId),
                                    ),
                                )
                            } else {
                                onOpenAsset(assetId, ids)
                            }
                        },
                    )
                }
        }

        // THE BAR IS THE MODE, and it is absent when there is no mode. v0
        // passed its selection bar unconditionally and the screen sat
        // permanently in the mode — the header read "Choose photographs" and
        // the band sat dimmed before a single photograph had been picked
        // (R-A-14).
        if (state.selecting) {
            SelectionBar(
                state = state,
                onEvent = onEvent,
                onAskToPurge = { confirmingPurge = true },
                onAskPlace = { choosingPlace = true },
                onSave = { onExport(state.selected_asset_ids, ShelfExport.Save) },
            )
        }
    }

    // "ADD TO ALBUM" — the shared sheet, drawn while the state says so. A
    // swipe-down reaches the reducer through `onDismiss`.
    if (state.album_choice_open) {
        AlbumChoiceSheet(
            choices = state.album_choices,
            onChoose = { onEvent(PhotoShelfEvent(album_chosen = AlbumChosen(album_id = it))) },
            onNewAlbum = { onEvent(PhotoShelfEvent(album_choice_created = AlbumChoiceCreated(title = it))) },
            onDismiss = { onEvent(PhotoShelfEvent(album_choice_dismissed = AlbumChoiceDismissed())) },
        )
    }

    if (confirmingEmptyTrash) {
        ConfirmSheet(
            confirm = Confirm(
                title = PhotosCopy.PHOTOS_EMPTY_TRASH_TITLE,
                body = PhotosCopy.PHOTOS_EMPTY_TRASH_BODY,
                confirm_label = PhotosCopy.PHOTOS_EMPTY_TRASH,
                destructive = true,
            ),
            onConfirm = {
                confirmingEmptyTrash = false
                onEvent(PhotoShelfEvent(empty_trash = PhotoShelfEvent.EmptyTrashRequested()))
            },
            onDismiss = { confirmingEmptyTrash = false },
            cancelLabel = PhotosCopy.PHOTOS_KEEP_THEM,
        )
    }

    if (confirmingAlbumDelete) {
        // v0's `ALBUM_DELETE_BODY`: the one thing a member deciding needs.
        ConfirmSheet(
            confirm = Confirm(
                title = PhotosCopy.PHOTOS_DELETE_ALBUM_TITLE,
                body = PhotosCopy.PHOTOS_DELETE_ALBUM_BODY,
                confirm_label = PhotosCopy.PHOTOS_DELETE_ALBUM,
                destructive = true,
            ),
            onConfirm = {
                confirmingAlbumDelete = false
                onEvent(PhotoShelfEvent(album_delete = PhotoShelfEvent.AlbumDeleteRequested()))
            },
            onDismiss = { confirmingAlbumDelete = false },
            cancelLabel = PhotosCopy.PHOTOS_KEEP_IT,
        )
    }

    if (renaming) {
        RenameSheet(
            title = PhotosCopy.PHOTOS_RENAME_ALBUM,
            fieldLabel = PhotosCopy.PHOTOS_ALBUM_NAME,
            current = PhotoShelfMachine.title(shelf),
            onDismiss = { renaming = false },
        ) { title ->
            renaming = false
            onEvent(PhotoShelfEvent(album_renamed = PhotoShelfEvent.AlbumRenamed(title = title)))
        }
    }

    // HOW MUCH OF THE PLACE TRAVELS, asked every time (#816). Two answers for
    // a batch: a place NAME is one sentence per photograph, and a batch has as
    // many places as photographs.
    if (choosingPlace) {
        OptionSheet(
            title = PhotosCopy.PHOTOS_SEND_PLACE_TITLE,
            options = listOf(
                SheetOption(key = "none", label = PhotosCopy.PHOTOS_SEND_NO_LOCATION),
                SheetOption(key = "exact", label = PhotosCopy.PHOTOS_SEND_EXACT_LOCATION),
            ),
            onPick = { key ->
                choosingPlace = false
                onExport(state.selected_asset_ids, ShelfExport.Send(keepLocation = key == "exact"))
            },
            onDismiss = { choosingPlace = false },
        )
    }

    // A SHEET IS NOT IN THE LAYOUT, so it sits outside the column: it is a
    // window of its own and a `Column` child that sometimes becomes one would
    // move everything below it on the frame it appeared.
    if (confirmingPurge) {
        PurgeConfirm(
            count = state.selected_asset_ids.size,
            onDismiss = { confirmingPurge = false },
            onConfirm = {
                confirmingPurge = false
                onEvent(
                    PhotoShelfEvent(
                        delete = PhotoShelfEvent.DeleteRequested(permanent = true),
                    ),
                )
            },
        )
    }
}

/**
 * The count, and the way into and out of selection.
 *
 * The count is the PAGE's and says so. There is no `COUNT(*)` on this door, so
 * a shelf longer than one page has read a floor and not a total — and a bare
 * "412 photographs" over a truncated page would be a number the screen made up.
 */
@Composable
private fun ShelfHeader(
    state: PhotoShelfState,
    onEvent: (PhotoShelfEvent) -> Unit,
    onAskToEmptyTrash: () -> Unit,
) {
    val data = state.data_
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = countSentence(state),
            style = centraidType("control"),
            color = centraidColor("textSoft"),
        )
        when {
            state.selecting -> KitLink(
                label = PhotosCopy.PHOTOS_DONE,
                onClick = {
                    onEvent(
                        PhotoShelfEvent(
                            selection_mode = PhotoShelfEvent
                                .SelectionModeChanged(selecting = false),
                        ),
                    )
                },
            )

            data != null && data.cells.isNotEmpty() -> Row(verticalAlignment = Alignment.CenterVertically) {
                // EMPTY TRASH, only on the trash, beside the way into
                // selection. A text control and never a filled one: the safety
                // is the confirm behind it.
                if (PhotoShelfMachine.isTrash(state.shelf)) {
                    OutlineButton(
                        label = PhotosCopy.PHOTOS_EMPTY_TRASH,
                        testTag = "shelf-empty-trash",
                        ink = "net",
                        onPress = onAskToEmptyTrash,
                    )
                }
                KitLink(
                    label = PhotosCopy.PHOTOS_SELECT,
                    onClick = {
                        onEvent(
                            PhotoShelfEvent(
                                selection_mode = PhotoShelfEvent.SelectionModeChanged(selecting = true),
                            ),
                        )
                    },
                )
            }
        }
    }
}

/**
 * THE ALBUM'S OWN VERBS: add to it, and behind one menu, rename it or delete
 * it. Rename and Delete are about the grouping, never about a photograph in it.
 */
@Composable
private fun AlbumActions(onAdd: () -> Unit, onRename: () -> Unit, onDelete: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    Row(verticalAlignment = Alignment.CenterVertically) {
        KitLink(label = PhotosCopy.PHOTOS_ADD_PHOTOS, onClick = onAdd)
        Box {
            IconKey(
                iconKey = "MoreHoriz",
                label = PhotosCopy.PHOTOS_ALBUM_OPTIONS,
                testTag = "album-options",
                bordered = false,
                onPress = { open = true },
            )
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                DropdownMenuItem(
                    text = { Text(text = PhotosCopy.PHOTOS_RENAME_ALBUM) },
                    onClick = {
                        open = false
                        onRename()
                    },
                )
                DropdownMenuItem(
                    text = { Text(text = PhotosCopy.PHOTOS_DELETE_ALBUM, color = centraidColor("net")) },
                    onClick = {
                        open = false
                        onDelete()
                    },
                )
            }
        }
    }
}

/** A FLOOR, AND IT SAYS SO WHEN IT IS ONE. See [ShelfHeader]. */
private fun countSentence(state: PhotoShelfState): String {
    val data = state.data_ ?: return ""
    return CappedCount.phrase(
        data.cells.size.toLong(),
        data.next_cursor != null,
        PhotosCopy.TILE_COUNT_ONE,
        PhotosCopy.TILE_COUNT_MANY,
    )
}

/**
 * THE VERBS A SHELF HAS OVER ITS SELECTION, and which ones depends on the shelf.
 *
 * The trash swaps Archive for Restore and Trash for Delete-forever, which is
 * v0's rule (`PhotoStateView.tsx`: "Trash swaps the fifth target for Restore").
 * The archive's Restore is an UN-ARCHIVE — `PhotoShelfMachine` sends
 * `media.update_asset` for it rather than `media.restore_asset`, because an
 * archived photograph was never in the trash and `restore_asset`'s own
 * precondition would refuse it with "that photograph is not in the trash".
 */
@Composable
private fun SelectionBar(
    state: PhotoShelfState,
    onEvent: (PhotoShelfEvent) -> Unit,
    onAskToPurge: () -> Unit,
    onAskPlace: () -> Unit,
    onSave: () -> Unit,
) {
    val shelf = state.shelf
    val trash = PhotoShelfMachine.isTrash(shelf)
    val archive = PhotoShelfMachine.isArchive(shelf)
    // ON THE FAVOURITES SHELF THE HEART UNSTARS, because everything on it is
    // starred. The other direction is in the menu: a cell does not carry its
    // star.
    val favorites = shelf?.state_view?.mode?.kind == PhotoStateView.Mode.Kind.KIND_FAVORITES
    val enabled = state.selected_asset_ids.isNotEmpty()
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (trash) {
            Verb(iconKey = "restore", label = PhotosCopy.PHOTOS_RESTORE, enabled = enabled) {
                onEvent(PhotoShelfEvent(restore = PhotoShelfEvent.RestoreRequested()))
            }
            Verb(iconKey = "trash", label = PhotosCopy.PHOTOS_DELETE_FOREVER, enabled = enabled, run = onAskToPurge)
        } else {
            Verb(iconKey = "share", label = PhotosCopy.PHOTOS_SEND_COPY, enabled = enabled, run = onAskPlace)
            Verb(iconKey = "heart", label = if (favorites) PhotosCopy.PHOTOS_UNFAVORITE else PhotosCopy.PHOTOS_FAVORITE, enabled = enabled) {
                onEvent(PhotoShelfEvent(favorite = PhotoShelfEvent.FavoriteToggled(favorite = !favorites)))
            }
            Verb(iconKey = "album", label = PhotosCopy.PHOTOS_ADD_TO_ALBUM, enabled = enabled) {
                onEvent(PhotoShelfEvent(album_choice_opened = AlbumChoiceOpened()))
            }
            if (archive) {
                Verb(iconKey = "restore", label = PhotosCopy.PHOTOS_UNARCHIVE, enabled = enabled) {
                    onEvent(PhotoShelfEvent(restore = PhotoShelfEvent.RestoreRequested()))
                }
            } else {
                Verb(iconKey = "Archive", label = PhotosCopy.PHOTOS_ARCHIVE, enabled = enabled) {
                    onEvent(PhotoShelfEvent(archive = PhotoShelfEvent.ArchiveToggled(archived = true)))
                }
            }
            Verb(iconKey = "trash", label = PhotosCopy.PHOTOS_TRASH, enabled = enabled) {
                onEvent(
                    PhotoShelfEvent(delete = PhotoShelfEvent.DeleteRequested(permanent = false)),
                )
            }
            MoreVerbs(state, favorites, enabled, onEvent, onSave)
        }
        Text(
            text = PhotosCopy.PHOTOS_CHOSEN.replace("{count}", "${state.selected_asset_ids.size}"),
            style = centraidType("small"),
            color = centraidColor("textSoft"),
        )
    }
}

/**
 * THE REST OF THE VERBS — the ones a member reaches for less, and the album's
 * own: "Make key photo" wants exactly one photograph, and "Remove from album"
 * takes the reference and never the photograph.
 */
@Composable
private fun MoreVerbs(
    state: PhotoShelfState,
    favorites: Boolean,
    enabled: Boolean,
    onEvent: (PhotoShelfEvent) -> Unit,
    onSave: () -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    val album = state.shelf?.album != null
    Box {
        Verb(iconKey = "MoreHoriz", label = PhotosCopy.PHOTOS_MORE, enabled = enabled) { open = true }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = { Text(text = PhotosCopy.PHOTOS_DOWNLOAD_ORIGINAL) },
                onClick = {
                    open = false
                    onSave()
                },
            )
            if (!favorites) {
                DropdownMenuItem(
                    text = { Text(text = PhotosCopy.PHOTOS_UNFAVORITE) },
                    onClick = {
                        open = false
                        onEvent(PhotoShelfEvent(favorite = PhotoShelfEvent.FavoriteToggled(favorite = false)))
                    },
                )
            }
            if (album) {
                val only = state.selected_asset_ids.singleOrNull()
                DropdownMenuItem(
                    text = { Text(text = PhotosCopy.PHOTOS_MAKE_KEY) },
                    enabled = only != null,
                    onClick = {
                        open = false
                        if (only != null) onEvent(PhotoShelfEvent(cover = PhotoShelfEvent.CoverChosen(asset_id = only)))
                    },
                )
                DropdownMenuItem(
                    text = { Text(text = PhotosCopy.PHOTOS_REMOVE_FROM_ALBUM) },
                    onClick = {
                        open = false
                        onEvent(PhotoShelfEvent(remove_from_album = PhotoShelfEvent.RemoveFromAlbumRequested()))
                    },
                )
            }
        }
    }
}

/**
 * One verb, disabled with nothing picked rather than hidden: a bar whose
 * controls come and go as a member picks is a bar that moves under their thumb.
 *
 * The icon key is one [dev.centraid.design.CentraidCatalog] actually has.
 * `CentraidIcon` falls back to `orEmpty()` and an unknown key draws NOTHING,
 * silently — which is what made the More tab render as a dash. Material's icon
 * set is deliberately not used: a second set is a second product.
 */
@Composable
private fun Verb(iconKey: String, label: String, enabled: Boolean, run: () -> Unit) {
    // DISABLED IS THE INK, NEVER A FADED CONTAINER: the key stays in place (the
    // bar must not move under a thumb), draws `textDisabled`, and does nothing.
    IconKey(iconKey = iconKey, label = label, testTag = "shelf-verb", bordered = false, enabled = enabled, onPress = run)
}

/**
 * The confirmation, with the whole cost stated.
 *
 * v0's words, because they are the ones that say what actually leaves: not only
 * the photograph but its captions, tags and album membership. "Delete
 * forever" with no body is a member agreeing to something they have not been
 * told.
 */
@Composable
private fun PurgeConfirm(count: Int, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    ConfirmSheet(
        confirm = Confirm(
            title = if (count == 1) {
                PhotosCopy.PHOTOS_DELETE_FOREVER_ONE
            } else {
                PhotosCopy.PHOTOS_DELETE_FOREVER_MANY.replace("{count}", "$count")
            },
            body = PhotosCopy.PHOTOS_DELETE_FOREVER_BODY,
            confirm_label = PhotosCopy.PHOTOS_DELETE_FOREVER_CONFIRM.replace("{count}", "$count"),
            destructive = true,
        ),
        onConfirm = onConfirm,
        onDismiss = onDismiss,
        cancelLabel = PhotosCopy.PHOTOS_KEEP_THEM,
    )
}

/**
 * RENAME, as one field and a verb in a [SheetRoom]. An empty name is not
 * offered: the vault's `title` is `minLength: 1`, and the reducer drops it
 * besides, so a blank name sends nothing.
 */
@Composable
internal fun RenameSheet(
    title: String,
    fieldLabel: String,
    current: String,
    onDismiss: () -> Unit,
    primaryLabel: String = PhotosCopy.PHOTOS_SAVE,
    onSave: (String) -> Unit,
) {
    var name by remember { mutableStateOf(current) }
    NameSheet(
        title = title,
        fieldLabel = fieldLabel,
        name = name,
        onName = { name = it },
        primaryLabel = primaryLabel,
        onDismiss = onDismiss,
        onSave = { onSave(name) },
    )
}

/**
 * A SHEET WITH ONE NAME FIELD AND ONE VERB — rename, and name a new album. The
 * verb is the sheet's ink button, drawn disabled while the name is blank: a
 * blank name is not a write. [status]
 * is the refusal's sentence, beside the field and never instead of it.
 */
@Composable
internal fun NameSheet(
    title: String,
    fieldLabel: String,
    name: String,
    onName: (String) -> Unit,
    primaryLabel: String,
    onDismiss: () -> Unit,
    status: String = "",
    onSave: () -> Unit,
) {
    val ready = name.isNotBlank()
    SheetRoom(
        title = title,
        onDismiss = onDismiss,
        status = status,
        primary = SheetPrimary(label = primaryLabel, testTag = "rename-save", enabled = ready, onPress = onSave),
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
