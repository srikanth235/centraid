package dev.centraid.android.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import centraid.core.v1.PhotosPickerEvent
import centraid.core.v1.PhotosPickerState
import dev.centraid.android.kit.InkButton
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitLink
import dev.centraid.android.kit.PhotoCellsGrid
import dev.centraid.android.kit.RowSkeleton
import dev.centraid.android.kit.ScreenEmpty
import dev.centraid.android.kit.ScreenFailure
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * ADDING PHOTOGRAPHS TO AN ALBUM, drawn from the core's [PhotosPickerState]
 * (#1135): the library as a grid with what the album already holds drawn as
 * taken, the one ink button, and the sentence "an album points to a photo where
 * it lives". Rust (`photos/picker.rs`) decides what can be picked, what Add
 * writes and when the picker is [PhotosPickerState.finished]; this draws it.
 *
 * A refused add is `status`, above the grid and never instead of it, so the
 * member keeps the library they were choosing from.
 *
 * The SwiftUI twin is `mobile/iosApp/Sources/PhotoPickerView.swift`.
 */
@Composable
public fun PhotoPickerScreen(
    state: PhotosPickerState,
    onEvent: (PhotosPickerEvent) -> Unit,
    onFinished: () -> Unit = {},
) {
    LaunchedEffect(state.finished) { if (state.finished) onFinished() }
    Column(
        modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column {
            Text(text = state.title, style = centraidType("bodyStrong"), color = centraidColor("text"))
            Text(text = state.chosen_label, style = centraidType("small"), color = centraidColor("textSoft"))
        }
        // The one ink button: drawn disabled with nothing picked rather than absent,
        // so it does not move under a thumb.
        InkButton(
            label = state.add_label,
            testTag = "picker-add",
            enabled = state.add_enabled,
            onPress = { onEvent(PhotosPickerEvent(confirm = PhotosPickerEvent.ConfirmRequested())) },
        )
        Text(text = state.refers_note, style = centraidType("small"), color = centraidColor("textSoft"))

        state.status?.let { ScreenFailure(it.sentence, "") }

        val loading = state.loading
        val failure = state.failure
        val data = state.data_
        when {
            loading != null -> RowSkeleton()
            failure != null -> ScreenFailure(failure.sentence, failure.remedy)
            data != null -> {
                val empty = data.empty
                if (empty != null) {
                    ScreenEmpty(sentence = empty.headline, remedy = empty.body)
                } else {
                    // TAKEN, NOT HIDDEN: a member hunting for the photograph they
                    // added last week finds it, and finds out why it will not tick.
                    PhotoCellsGrid(
                        cells = data.cells.map { it.tile!! },
                        selected = data.cells.filter { it.picked }.map { it.tile!!.photo_id }.toSet(),
                        taken = data.cells.filter { it.taken }.map { it.tile!!.photo_id }.toSet(),
                        takenLabel = data.taken_label,
                        onTap = { photoId ->
                            onEvent(PhotosPickerEvent(pick = PhotosPickerEvent.PickToggled(photo_id = photoId)))
                        },
                    )
                    if (data.can_show_more) {
                        KitLink(
                            label = data.show_more_label,
                            onClick = { onEvent(PhotosPickerEvent(load_more = PhotosPickerEvent.LoadMore())) },
                        )
                    }
                }
            }
        }
    }
}
