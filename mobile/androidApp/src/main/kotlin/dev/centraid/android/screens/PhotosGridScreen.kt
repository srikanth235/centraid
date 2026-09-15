package dev.centraid.android.screens

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import centraid.screen.v1.MediaPermission
import centraid.screen.v1.PhotoCell
import centraid.screen.v1.PhotosGridEvent
import centraid.screen.v1.PhotosGridState
import dev.centraid.android.kit.ContentImage

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
    /**
     * Run one camera-roll pass now (#1025 S6).
     *
     * A CALLBACK AND NOT AN EVENT, for iOS's reason: a pass is a shell effect
     * with file and network I/O in it, and the states it publishes come back as
     * ordinary `BackupChanged` events. Asking the reducer to do a file read
     * would make one of the two planes on this screen the other one's problem.
     *
     * Defaulted so a preview and a fixture render this screen without one.
     */
    onBackUpNow: () -> Unit = {},
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

        BackupBanner(state, onEvent, onBackUpNow)

        // A WIRE PROPERTY IS CROSS-MODULE PUBLIC API, so Kotlin will not smart-cast
        // it after a null check. Binding each arm's value to a local first is
        // what makes the branches type-check, and it is the shape every screen
        // in this module uses.
        val loading = state.loading
        val failure = state.failure
        val data = state.data_
        when {
            loading != null -> CircularProgressIndicator()

            failure != null -> Column {
                Text(text = failure.sentence)
                if (failure.remedy.isNotEmpty()) Text(text = failure.remedy)
            }

            data != null -> {
                val cells = data.cells
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
                                data.thumbnail_pack_absent ->
                                    "Preview not downloaded to this device"
                                else -> "Preview no longer on this device"
                            }
                            // A GRID CELL IS AN IMAGE-ONLY CONTROL, so it
                            // carries a description even when the image is
                            // missing — which is when it matters most.
                            val path = cell.thumbnail_path
                            Box(
                                Modifier
                                    .aspectRatio(1f)
                                    .semantics { contentDescription = label },
                            ) {
                                // THE SAME RENDERER AS HOME'S MOSAIC
                                // (D-1025-S7-20). This grid drew a label and
                                // never an image, even over a real path, so
                                // the one place in the product that drew a
                                // vault's own bytes was a four-cell tile on
                                // Home. One path, one view.
                                if (!path.isNullOrEmpty()) {
                                    ContentImage(path)
                                } else {
                                    Text(text = label)
                                }
                                // WHAT THIS DEVICE HAS OF THIS PHOTOGRAPH, ON
                                // TOP OF IT (#1025 S5, D-1025-S7-62). A
                                // thumbnail is under every one of these: the
                                // grid is full under every rule there is, and
                                // what the overlay says is whether the
                                // FULL-SIZE file is here, moving, or waiting
                                // on the member's own rule.
                                CellState(cell, onEvent)
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * The per-cell affordance, and nothing for the states that need none.
 *
 * **The download arrow is drawn ONLY for `HELD_WITHHELD_BY_RULE`.** A
 * photograph still on its way gets none — tapping it would ask for something
 * already queued, and an affordance that does nothing is worse than none — and
 * `HELD_ORIGINAL` and `HELD_ABSENT` draw nothing at all.
 */
@Composable
private fun BoxScope.CellState(cell: PhotoCell, onEvent: (PhotosGridEvent) -> Unit) {
    val corner = Modifier.align(Alignment.BottomEnd).padding(4.dp)
    when {
        cell.held == PhotoCell.Held.HELD_FETCHING ->
            CircularProgressIndicator(
                modifier = corner
                    .size(20.dp)
                    .semantics { contentDescription = "Downloading" },
            )

        cell.held == PhotoCell.Held.HELD_WITHHELD_BY_RULE && cell.original_hash.isNotEmpty() ->
            IconButton(
                onClick = {
                    onEvent(
                        PhotosGridEvent(
                            fetch_original = PhotosGridEvent.OriginalRequested(
                                asset_id = cell.asset_id,
                                content_hash = cell.original_hash,
                            ),
                        ),
                    )
                },
                modifier = corner,
            ) {
                Icon(
                    imageVector = Icons.Filled.KeyboardArrowDown,
                    contentDescription = "Download full-size photo",
                )
            }
    }
}

@Composable
private fun BackupBanner(
    state: PhotosGridState,
    onEvent: (PhotosGridEvent) -> Unit,
    onBackUpNow: () -> Unit,
) {
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
        // PARITY WITH iOS (#1025 S6). Not offered while a pass is running: the
        // runner holds a lock and a second press would do nothing, which is a
        // button that lies about having worked.
        if (
            backup.phase != centraid.screen.v1.BackupState.Phase.PHASE_TRANSFERRING &&
            backup.phase != centraid.screen.v1.BackupState.Phase.PHASE_ENUMERATING
        ) {
            Button(onClick = onBackUpNow) { Text(text = "Back up now") }
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
        // IDLE HAS A SENTENCE NOW. An empty string over an empty banner is a
        // member who cannot tell a backup that is OFF from one that has nothing
        // to say — the two look identical and only one has a next move.
        centraid.screen.v1.BackupState.Phase.PHASE_IDLE -> "Camera roll backup is off"
        centraid.screen.v1.BackupState.Phase.PHASE_UNSPECIFIED -> ""
    }
}

private fun bandLabel(band: PhotosGridState.Destination): String = when (band) {
    PhotosGridState.Destination.DESTINATION_LIBRARY -> "Library"
    PhotosGridState.Destination.DESTINATION_COLLECTIONS -> "Collections"
    PhotosGridState.Destination.DESTINATION_SEARCH -> "Search"
    PhotosGridState.Destination.DESTINATION_UNSPECIFIED -> ""
}
