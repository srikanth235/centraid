package dev.centraid.android.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import centraid.screen.v1.MediaPermission
import centraid.screen.v1.PhotosGridEvent
import centraid.screen.v1.PhotosGridState

/**
 * The Photos grid (#1020, D-1020-E3).
 *
 * Two planes on one screen, and the whole screen is arranged so they cannot be
 * confused: the GRID renders `content` (the vault), and the BACKUP banner
 * renders `backup` and `permission` (the camera roll). A denied photo grant
 * changes the banner and never the grid.
 */
@Composable
public fun PhotosGridScreen(
    state: PhotosGridState,
    onEvent: (PhotosGridEvent) -> Unit,
) {
    Column(modifier = Modifier.padding(16.dp)) {
        Row {
            PhotosGridState.Destination.entries
                .filter { it != PhotosGridState.Destination.DESTINATION_UNSPECIFIED }
                .forEach { band ->
                    TextButton(
                        onClick = {
                            onEvent(
                                PhotosGridEvent(
                                    destination = PhotosGridEvent.DestinationChanged(band),
                                ),
                            )
                        },
                    ) { Text(text = bandLabel(band)) }
                }
            // `more` IS A SHEET. It is a `Sheet` event and there is no
            // `Destination` value it could send.
            IconButton(
                onClick = {
                    onEvent(
                        PhotosGridEvent(
                            sheet = PhotosGridEvent.SheetChanged(
                                PhotosGridState.Sheet.SHEET_MORE,
                            ),
                        ),
                    )
                },
            ) {
                Icon(imageVector = Icons.Filled.MoreVert, contentDescription = "More")
            }
        }

        BackupBanner(state, onEvent)

        when {
            state.loading != null -> CircularProgressIndicator()

            state.failure != null -> Column {
                Text(text = state.failure.sentence)
                if (state.failure.remedy.isNotEmpty()) Text(text = state.failure.remedy)
            }

            state.data_ != null -> {
                val cells = state.data_.cells
                if (cells.isEmpty()) {
                    Text(text = "No photos here yet.")
                } else {
                    LazyVerticalGrid(columns = GridCells.Adaptive(minSize = 96.dp)) {
                        items(cells) { cell ->
                            // TWO DIFFERENT EMPTY-CELL SENTENCES. A member with
                            // no pack at all and a member whose pack has
                            // evicted these must not read the same words.
                            val label = when {
                                cell.thumbnail_path != null -> "Photo"
                                state.data_.thumbnail_pack_absent ->
                                    "Preview not downloaded to this device"
                                else -> "Preview no longer on this device"
                            }
                            // A GRID CELL IS AN IMAGE-ONLY CONTROL, so it
                            // carries a description even when the image is
                            // missing — which is when it matters most.
                            Text(
                                text = if (cell.thumbnail_path != null) "" else label,
                                modifier = Modifier.semantics { contentDescription = label },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun BackupBanner(state: PhotosGridState, onEvent: (PhotosGridEvent) -> Unit) {
    val backup = state.backup ?: return
    Column {
        Text(text = phaseLabel(state))
        if (backup.paused_reason.isNotEmpty()) Text(text = backup.paused_reason)
        // AN OS PERMISSION IS A STATE, and each state has its own remedy:
        // "not asked" has a button, "denied" has a trip to Settings, and
        // "restricted" has neither.
        if (state.permission == MediaPermission.MEDIA_PERMISSION_NOT_ASKED) {
            Button(
                onClick = {
                    onEvent(
                        PhotosGridEvent(
                            permission_requested = PhotosGridEvent.PermissionRequested(),
                        ),
                    )
                },
            ) { Text(text = "Allow photo access") }
        }
    }
}

private fun phaseLabel(state: PhotosGridState): String {
    val backup = state.backup ?: return ""
    val transferred = backup.assets_transferred_this_session
    return when (backup.phase) {
        centraid.screen.v1.BackupState.Phase.PHASE_TRANSFERRING ->
            "Backing up: $transferred done, ${backup.assets_remaining} to go"
        centraid.screen.v1.BackupState.Phase.PHASE_ENUMERATING -> "Looking through your photos"
        centraid.screen.v1.BackupState.Phase.PHASE_WAITING_FOR_POWER -> "Waiting for a charger"
        centraid.screen.v1.BackupState.Phase.PHASE_WAITING_FOR_UNMETERED -> "Waiting for Wi-Fi"
        centraid.screen.v1.BackupState.Phase.PHASE_PARKED_LOW_DISK ->
            "Paused: this device is out of space"
        centraid.screen.v1.BackupState.Phase.PHASE_DONE -> "Your camera roll is backed up"
        centraid.screen.v1.BackupState.Phase.PHASE_IDLE,
        centraid.screen.v1.BackupState.Phase.PHASE_UNSPECIFIED,
        -> ""
    }
}

private fun bandLabel(band: PhotosGridState.Destination): String = when (band) {
    PhotosGridState.Destination.DESTINATION_LIBRARY -> "Library"
    PhotosGridState.Destination.DESTINATION_COLLECTIONS -> "Collections"
    PhotosGridState.Destination.DESTINATION_SEARCH -> "Search"
    PhotosGridState.Destination.DESTINATION_UNSPECIFIED -> ""
}
