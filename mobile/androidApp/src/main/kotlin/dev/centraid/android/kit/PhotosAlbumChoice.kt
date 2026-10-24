package dev.centraid.android.kit

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import centraid.core.v1.PhotosAlbumChoice
import centraid.core.v1.PhotosAlbumChoiceEntry
import centraid.core.v1.PhotosAlbumChoiceEvent
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * "ADD TO ALBUM", drawn from the core's [PhotosAlbumChoice] (#1135): the lightbox,
 * the library and a shelf each hold one in Rust, so this draws the sheet and
 * sends its events and decides nothing. A refused list arrives empty with its
 * sentence; the "New album…" row is always there, and creating keeps the sheet
 * open with the new album in the list.
 *
 * The typed album name is the one piece of state that lives here: it exists
 * nowhere else before it is sent.
 */
@Composable
public fun PhotosAlbumChoiceSheet(
    choice: PhotosAlbumChoice,
    onEvent: (PhotosAlbumChoiceEvent) -> Unit,
) {
    val dismiss = { onEvent(PhotosAlbumChoiceEvent(dismissed = PhotosAlbumChoiceEvent.Dismissed())) }
    SheetRoom(title = choice.title, onDismiss = dismiss) {
        Column(Modifier.fillMaxWidth().weight(1f, fill = false).testTag("album-choice-sheet")) {
            NewAlbumRow(choice) { title ->
                onEvent(PhotosAlbumChoiceEvent(created = PhotosAlbumChoiceEvent.Created(title = title)))
            }
            if (choice.empty.isNotEmpty()) {
                Text(
                    choice.empty,
                    style = centraidType("small"),
                    color = centraidColor("textFaint"),
                    modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
                )
            } else {
                LazyColumn(Modifier.fillMaxWidth().weight(1f, fill = false)) {
                    items(choice.entries, key = { it.album_id }) { entry ->
                        ChoiceRow(entry) {
                            onEvent(PhotosAlbumChoiceEvent(chosen = PhotosAlbumChoiceEvent.Chosen(album_id = entry.album_id)))
                        }
                    }
                }
            }
            OutlineButton(
                label = choice.cancel_label,
                testTag = "album-choice-cancel",
                modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
                onPress = dismiss,
            )
        }
    }
}

@Composable
private fun NewAlbumRow(choice: PhotosAlbumChoice, onNewAlbum: (String) -> Unit) {
    var naming by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    val create = {
        val trimmed = name.trim()
        if (trimmed.isNotEmpty()) {
            onNewAlbum(trimmed)
            name = ""
            naming = false
        }
    }
    if (naming) {
        Row(
            Modifier.padding(horizontal = KitGeometry.GUTTER),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text(choice.name_placeholder) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { create() }),
                modifier = Modifier.weight(1f).testTag("album-choice-name"),
            )
            KitLink(label = choice.create_label, onClick = create, dense = true, enabled = name.isNotBlank())
        }
    } else {
        SheetRow(
            label = choice.new_album_label,
            iconKey = "add",
            testTag = "album-choice-new",
            onTap = { naming = true },
        )
    }
}

@Composable
private fun ChoiceRow(entry: PhotosAlbumChoiceEntry, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clickable(onClick = onClick)
            .semantics(mergeDescendants = true) {
                contentDescription = "${entry.title}, ${entry.count_label}"
                role = Role.Button
            }
            .padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            Modifier.size(44.dp).clip(RoundedCornerShape(7.dp)).background(centraidColor("bgElev")),
            contentAlignment = Alignment.Center,
        ) {
            val cover = entry.cover?.thumbnail_path
            if (!cover.isNullOrEmpty()) {
                ContentImage(cover)
            } else {
                CentraidIcon(iconKey = "album", tint = centraidColor("textFaint"), size = 20.dp)
            }
        }
        Column(Modifier.weight(1f)) {
            Text(
                entry.title,
                style = centraidType("body"),
                color = centraidColor("text"),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(entry.count_label, style = centraidType("small"), color = centraidColor("textFaint"))
        }
    }
}
