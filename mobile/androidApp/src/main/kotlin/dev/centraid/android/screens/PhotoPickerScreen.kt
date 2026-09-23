package dev.centraid.android.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import centraid.screen.v1.PhotoPickerEvent
import centraid.screen.v1.PhotoPickerState
import dev.centraid.android.kit.PhotoCellsGrid
import dev.centraid.android.kit.ScreenEmpty
import dev.centraid.android.kit.ScreenFailure
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.shared.apps.photos.PhotoPickerMachine

/**
 * ADDING PHOTOGRAPHS TO AN ALBUM (#1029, photos port; v0's `PhotoPicker.tsx`).
 *
 * A pushed screen and not a dialog, which is v0's own choice and the right one
 * on a phone: choosing from a whole library is a place a member goes, not a
 * card they hold open.
 *
 * **Its picked set is its own.** No selection bar goes to the shell: the
 * shelf's bar belongs to "these photographs", and this screen's one verb is
 * "add these to THIS album". A shelf that could be picked from would carry an
 * album id on every surface that shows one.
 *
 * **No search field.** v0 states the reason and it still holds: search is its
 * own screen with its own unreachable state, and a silent miss here would be
 * pretence.
 *
 * The SwiftUI twin is `mobile/iosApp/Sources/PhotoPickerView.swift`.
 */
@Composable
public fun PhotoPickerScreen(
    state: PhotoPickerState,
    onEvent: (PhotoPickerEvent) -> Unit,
    /**
     * The picker is done with itself. Adding is the end of this screen and the
     * pop is the shell's — v0 navigates back on a successful batch.
     *
     * Defaulted so a preview and a fixture render this screen without one.
     */
    onFinished: () -> Unit = {},
) {
    Column(
        modifier = Modifier.padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column {
                // THE NAME IS ON THE STATE BEFORE ANY READ HAS LANDED, because
                // it rode in with `Opened` off the route. A head that waited a
                // round trip would paint under the previous screen's title.
                Text(
                    text = "Add to “${state.collection_name}”",
                    style = centraidType("bodyStrong"),
                    color = centraidColor("text"),
                )
                // NOTHING HAS BEEN ADDED YET, and the line says so while a
                // member picks. A picked set is not a write, and a member
                // should not have to guess when the album changed.
                Text(
                    text = chosenSentence(state),
                    style = centraidType("small"),
                    color = centraidColor("textSoft"),
                )
            }
            // THE ONE FILLED ELEMENT (§18) — and it cannot fire with nothing
            // picked, so it is disabled rather than absent: a control that
            // appears when a member picks is a control that moves under their
            // thumb.
            Button(
                onClick = {
                    onEvent(PhotoPickerEvent(confirm = PhotoPickerEvent.ConfirmRequested()))
                    onFinished()
                },
                enabled = state.picked_asset_ids.isNotEmpty(),
            ) {
                Text(
                    text = if (state.picked_asset_ids.isEmpty()) {
                        "Add"
                    } else {
                        "Add ${state.picked_asset_ids.size}"
                    },
                )
            }
        }

        // ADDING REFERS, IT DOES NOT COPY — v0's sentence, verbatim, and the
        // fact that makes this screen safe to use. Nothing is duplicated and
        // nothing moves.
        Text(
            text = PhotoPickerMachine.REFERS_NOT_COPIES,
            style = centraidType("small"),
            color = centraidColor("textSoft"),
        )

        // AN ADD WAS REFUSED, AND THE GRID STAYS.
        //
        // Above the cells and outside the `when` below: a refusal drawn through
        // the read's `failure` would replace the library mid-pick and take the
        // member's picks off the screen they were choosing from. That is what
        // `write_failure` is a separate field for.
        val refusal = state.write_failure
        if (refusal != null) ScreenFailure(refusal.sentence, refusal.remedy)

        // A WIRE PROPERTY IS CROSS-MODULE PUBLIC API, so Kotlin will not
        // smart-cast it after a null check. Binding each arm's value to a local
        // first is what makes the branches type-check.
        val loading = state.loading
        val failure = state.failure
        val data = state.data_
        when {
            loading != null -> CircularProgressIndicator()

            // A FAILED READ IS NOT AN EMPTY LIBRARY, and on this screen the
            // difference decides what a member does next: one means there is
            // nothing left to add, the other means they must not conclude that.
            failure != null -> ScreenFailure(failure.sentence, failure.remedy)

            data != null ->
                if (data.cells.isEmpty()) {
                    ScreenEmpty(sentence = PhotoPickerMachine.NOTHING_LEFT)
                } else {
                    // TAKEN, NOT HIDDEN. A member hunting for the photograph
                    // they added last week should find it, and find out why it
                    // will not tick. `PhotoCellsGrid` draws `taken` and refuses
                    // the tap; the machine refuses it a second time, because
                    // the rule is the machine's and not the drawing's.
                    PhotoCellsGrid(
                        cells = data.cells,
                        packAbsent = data.thumbnail_pack_absent,
                        selected = state.picked_asset_ids.toSet(),
                        taken = state.already_in_album_asset_ids.toSet(),
                        onTap = { assetId ->
                            onEvent(PhotoPickerEvent(pick = PhotoPickerEvent.PickToggled(assetId)))
                        },
                    )
                }
        }
    }
}

private fun chosenSentence(state: PhotoPickerState): String =
    if (state.picked_asset_ids.isEmpty()) {
        "Nothing chosen yet"
    } else {
        "${state.picked_asset_ids.size} chosen · nothing has been added yet"
    }
