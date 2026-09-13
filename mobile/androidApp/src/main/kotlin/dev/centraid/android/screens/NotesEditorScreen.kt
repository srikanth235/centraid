package dev.centraid.android.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import centraid.screen.v1.NotesEditorEvent
import centraid.screen.v1.NotesEditorState

/**
 * The Notes editor (#1020, D-1020-E3).
 *
 * The read law and the write law render in different places, which is the
 * whole shape of this screen: `content` decides whether there is an editor at
 * all, and `save` decides what the save line says over it. A refused save
 * leaves the member's words exactly where they were.
 */
@Composable
public fun NotesEditorScreen(
    state: NotesEditorState,
    onEvent: (NotesEditorEvent) -> Unit,
) {
    Column(modifier = Modifier.padding(16.dp)) {
        when {
            state.loading != null -> CircularProgressIndicator()

            state.failure != null -> Column {
                Text(text = state.failure.sentence)
                if (state.failure.remedy.isNotEmpty()) Text(text = state.failure.remedy)
            }

            state.draft != null -> {
                val draft = state.draft
                Row {
                    Text(text = saveLabel(state))
                    IconButton(
                        onClick = { onEvent(NotesEditorEvent(pin = NotesEditorEvent.PinToggled())) },
                    ) {
                        Icon(
                            imageVector = Icons.Filled.Star,
                            contentDescription = if (draft.pinned) "Unpin note" else "Pin note",
                        )
                    }
                    TextButton(
                        onClick = { onEvent(NotesEditorEvent(save = NotesEditorEvent.SaveRequested())) },
                    ) { Text(text = "Save") }
                }
                TextField(
                    value = draft.title,
                    onValueChange = { value ->
                        onEvent(NotesEditorEvent(title = NotesEditorEvent.TitleEdited(value)))
                    },
                    label = { Text(text = "Title") },
                )
                TextField(
                    value = draft.body,
                    onValueChange = { value ->
                        onEvent(NotesEditorEvent(body = NotesEditorEvent.BodyEdited(value)))
                    },
                    label = { Text(text = "Note") },
                    modifier = Modifier.padding(top = 8.dp),
                )
                // THE SAVE'S OWN SENTENCE, over the words and not instead of
                // them.
                draft.save_failure?.let { failure -> Text(text = failure.sentence) }
            }
        }
    }
}

private fun saveLabel(state: NotesEditorState): String = when (state.save) {
    NotesEditorState.SaveState.SAVE_STATE_CLEAN -> "Saved"
    NotesEditorState.SaveState.SAVE_STATE_DIRTY -> "Not saved yet"
    NotesEditorState.SaveState.SAVE_STATE_SAVING -> "Saving"
    // QUEUED IS NOT SAVED, and it is not failed either.
    NotesEditorState.SaveState.SAVE_STATE_QUEUED -> "Saved on this device"
    NotesEditorState.SaveState.SAVE_STATE_REFUSED -> "Could not save"
    NotesEditorState.SaveState.SAVE_STATE_UNSPECIFIED -> ""
}
