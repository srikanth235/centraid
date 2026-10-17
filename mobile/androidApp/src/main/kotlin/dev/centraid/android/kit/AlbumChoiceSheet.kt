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
import centraid.screen.v1.AlbumChoiceEntry
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.copy.PhotosCopy
import dev.centraid.shared.kit.CappedCount

/**
 * "ADD TO ALBUM", AS ONE SHEET FOR EVERY SCREEN THAT OFFERS IT (#1029, the
 * photos port).
 *
 * v0 asked "which album?" from four surfaces through alerts with a row per
 * album — no grabber, no scroll, and a cap that made Album detail slice its list
 * to six (`PhotosChoiceSheet.tsx`). A choice is a `SheetRoom` (DESIGN.md): a
 * grabber, a title carrying the noun, one quiet way out.
 *
 * **It decides nothing.** [choices] is the host state's `album_choices`, read by
 * `AlbumChoice.kt`; a tap names an album and the host's reducer turns it into
 * one `media.add_to_album` per picked photograph. The host draws this only while
 * `album_choice_open` says so, and [onDismiss] is how a swipe reaches the
 * reducer.
 *
 * **"New album…" does not put the pick in the album it makes**, and the sheet
 * stays open on purpose: the vault mints the id and no settle carries it back,
 * so the new album joins this list when the create commits and the member's
 * next tap finishes the job. The SwiftUI twin is `AlbumChoiceSheet.swift`.
 */
@Composable
public fun AlbumChoiceSheet(
    choices: List<AlbumChoiceEntry>,
    onChoose: (String) -> Unit,
    onNewAlbum: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    SheetRoom(title = PhotosCopy.PHOTOS_ADD_TO_ALBUM, onDismiss = onDismiss) {
        Column(Modifier.fillMaxWidth().weight(1f, fill = false).testTag("album-choice-sheet")) {
            NewAlbumRow(onNewAlbum)
            if (choices.isEmpty()) {
                // ONE SENTENCE, NEVER AN EMPTY SHEET. The row above is the
                // action; this only says why the list is short.
                Text(
                    PhotosCopy.PHOTOS_ALBUM_CHOICE_NONE,
                    style = centraidType("small"),
                    color = centraidColor("textFaint"),
                    modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
                )
            } else {
                LazyColumn(Modifier.fillMaxWidth().weight(1f, fill = false)) {
                    items(choices, key = { it.album_id }) { choice ->
                        ChoiceRow(choice) { onChoose(choice.album_id) }
                    }
                }
            }
            OutlineButton(
                label = PhotosCopy.PHOTOS_CANCEL,
                testTag = "album-choice-cancel",
                modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
                onPress = onDismiss,
            )
        }
    }
}

/**
 * "NEW ALBUM…", AND THE FIELD IT BECOMES — inline, because a sheet on a sheet
 * is two ways out for one question.
 */
@Composable
private fun NewAlbumRow(onNewAlbum: (String) -> Unit) {
    var naming by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    val create = {
        val trimmed = name.trim()
        // AN EMPTY NAME IS NOT A WRITE: `media.create_album`'s `title` is
        // `minLength: 1`.
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
                label = { Text(PhotosCopy.PHOTOS_ALBUM_NAME) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { create() }),
                modifier = Modifier.weight(1f).testTag("album-choice-name"),
            )
            KitLink(label = PhotosCopy.PHOTOS_CREATE, onClick = create, dense = true, enabled = name.isNotBlank())
        }
    } else {
        SheetRow(
            label = PhotosCopy.PHOTOS_ALBUM_CHOICE_NEW,
            iconKey = "add",
            testTag = "album-choice-new",
            onTap = { naming = true },
        )
    }
}

@Composable
private fun ChoiceRow(choice: AlbumChoiceEntry, onClick: () -> Unit) {
    val title = choice.title.ifEmpty { PhotosCopy.PHOTOS_UNTITLED_ALBUM }
    val (shown, spoken) = choiceCount(choice)
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clickable(onClick = onClick)
            .semantics(mergeDescendants = true) {
                contentDescription = "$title, $spoken"
                role = Role.Button
            }
            .padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            Modifier.size(COVER_SIDE).clip(RoundedCornerShape(COVER_RADIUS)).background(centraidColor("bgElev")),
            contentAlignment = Alignment.Center,
        ) {
            val cover = choice.cover_thumbnail_path
            if (!cover.isNullOrEmpty()) {
                ContentImage(cover)
            } else {
                CentraidIcon(iconKey = "album", tint = centraidColor("textFaint"), size = 20.dp)
            }
        }
        Column(Modifier.weight(1f)) {
            Text(
                title,
                style = centraidType("body"),
                color = centraidColor("text"),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(shown, style = centraidType("small"), color = centraidColor("textFaint"))
        }
    }
}

/** A capped count says `N+` and never a bare number — Collections' rule. */
private fun choiceCount(choice: AlbumChoiceEntry): Pair<String, String> {
    if (choice.count == 0L && !choice.count_capped) return PhotosCopy.PHOTOS_COUNT_EMPTY to PhotosCopy.PHOTOS_COUNT_EMPTY
    val one = PhotosCopy.TILE_COUNT_ONE
    val many = PhotosCopy.TILE_COUNT_MANY
    return CappedCount.shown(choice.count, choice.count_capped, one, many) to
        CappedCount.spoken(choice.count, choice.count_capped, one, many)
}

/** A cover thumbnail's side in the list — the system's album-picker row. */
private val COVER_SIDE = 44.dp

/** The CONTROL rung: a thumbnail in a row is content held by a control. */
private val COVER_RADIUS = 7.dp
