package dev.centraid.android.screens.photos

import androidx.compose.runtime.Composable
import centraid.core.v1.Route
import centraid.core.v1.ScreenEvent
import centraid.core.v1.ViewState
import dev.centraid.android.screens.PhotoPickerScreen
import dev.centraid.android.screens.PhotoShelfScreen
import dev.centraid.android.screens.PlacesScreen

/**
 * THE SHELF FAMILY'S DRAW (#1135): `photos.shelf`, `photos.picker` and
 * `photos.places`, for the Photos host's one `when` over a [ViewState]. Returns
 * true when [view] was one of these and was drawn, so the host falls through to
 * its other screens otherwise. A row's route is pushed through [open]; a
 * finished picker and a deleted album pop through [back].
 */
@Composable
internal fun PhotosShelfFamilyScreen(
    view: ViewState,
    send: (ScreenEvent) -> Unit,
    open: (Route) -> Unit,
    back: () -> Unit,
): Boolean {
    val shelf = view.photos_shelf
    val picker = view.photos_picker
    val places = view.photos_places
    when {
        shelf != null -> PhotoShelfScreen(
            state = shelf,
            onEvent = { send(ScreenEvent(photos_shelf = it)) },
            onOpen = open,
            onClose = back,
        )
        picker != null -> PhotoPickerScreen(
            state = picker,
            onEvent = { send(ScreenEvent(photos_picker = it)) },
            onFinished = back,
        )
        places != null -> PlacesScreen(
            state = places,
            onEvent = { send(ScreenEvent(photos_places = it)) },
            onOpen = open,
        )
        else -> return false
    }
    return true
}
