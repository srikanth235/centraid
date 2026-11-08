package dev.centraid.android.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.text.font.FontWeight
import dev.centraid.android.kit.kitTextStyle
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
import dev.centraid.android.kit.KitText
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.Surface
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
    Column(Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier.weight(1f).padding(horizontal = KitGeometry.GUTTER).padding(top = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            KitText(state.title, KitType.Section, Surface.ink, maxLines = 2)

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
                            modifier = Modifier.weight(1f),
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
        // THE FOOT, docked as on iOS: how many are chosen, the sentence about albums, and the one
        // ink button, drawn disabled with nothing picked rather than absent so it does not move
        // under a thumb.
        Column(
            Modifier
                .fillMaxWidth()
                .background(Surface.page)
                .padding(horizontal = KitGeometry.GUTTER)
                .padding(top = 12.dp, bottom = 8.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                state.chosen_label,
                style = kitTextStyle(KitType.Row),
                color = Surface.ink,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
            )
            KitText(state.refers_note, KitType.Meta, Surface.meta)
            InkButton(
                label = state.add_label,
                testTag = "picker-add",
                enabled = state.add_enabled,
                modifier = Modifier.padding(top = 8.dp),
                onPress = { onEvent(PhotosPickerEvent(confirm = PhotosPickerEvent.ConfirmRequested())) },
            )
        }
    }
}
