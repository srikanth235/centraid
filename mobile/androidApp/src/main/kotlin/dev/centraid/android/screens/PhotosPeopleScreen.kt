package dev.centraid.android.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import dev.centraid.android.kit.RowSkeleton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import centraid.screen.v1.PersonRow
import centraid.screen.v1.PhotosPeopleData
import centraid.screen.v1.PhotosPeopleEvent
import centraid.screen.v1.PhotosPeopleState
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.ContentImage
import dev.centraid.android.kit.IconKey
import dev.centraid.android.kit.ScreenEmpty
import dev.centraid.android.kit.ScreenFailure
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.copy.PhotosCopy
import dev.centraid.shared.apps.photos.PhotosPeopleMachine

/**
 * PEOPLE — the members of a family, as this vault has been TOLD them (#1029,
 * photos port, lane L5).
 *
 * Nobody a model guessed is on this screen. The guesses are one tap away,
 * behind a door that carries their count — "a door that says nothing is a door
 * nobody opens", so the number is on it and not behind it.
 *
 * The SwiftUI twin is `mobile/iosApp/Sources/PhotosPeopleView.swift`; the two
 * are kept in step by hand, which is what a shared state message and a shared
 * screen id buy — the arrangement is per platform, the meaning is not.
 */
@Composable
public fun PhotosPeopleScreen(
    state: PhotosPeopleState,
    onEvent: (PhotosPeopleEvent) -> Unit,
    /**
     * A tap on a person: the shelf its `PhotoShelf` names.
     *
     * A CALLBACK AND NOT AN EVENT, because where the member goes is the
     * shell's business and never the reducer's. The VALUE is the shared
     * machine's ([PhotosPeopleMachine.shelfFor]), so both shells land in the
     * same place with the name already riding along.
     *
     * Defaulted so a preview and a fixture render this screen without one.
     */
    onOpenPerson: (PersonRow) -> Unit = {},
    /** The door to the queue of questions. */
    onOpenFaceReview: () -> Unit = {},
) {
    // A WIRE PROPERTY IS CROSS-MODULE PUBLIC API, so Kotlin will not smart-cast
    // it after a null check. Binding each arm's value to a local first is what
    // makes the branches type-check, and it is the shape every screen in this
    // module uses.
    val loading = state.loading
    val failure = state.failure
    val data = state.data_
    Column(modifier = Modifier.padding(16.dp)) {
        when {
            loading != null -> RowSkeleton()

            failure != null -> ScreenFailure(failure.sentence, failure.remedy)

            data != null -> {
                // A REFUSED RENAME SAYS SO, OVER THE LIST AND NEVER INSTEAD OF
                // IT. `write_failure` is its own field for exactly that reason:
                // the content oneof's `failure` is the READ's, and a denied
                // write drawn there would take away the list the member was
                // renaming from.
                val writeFailure = state.write_failure
                if (writeFailure != null) {
                    Text(
                        text = writeFailure.sentence,
                        style = centraidType("small"),
                        color = centraidColor("danger"),
                    )
                }
                // THE DOOR COMES FIRST AND IS DRAWN WHATEVER THE LIST SAYS. A
                // member with nobody named needs it most, and a member with a
                // full list still has a backlog worth clearing — v0 hid it
                // behind an empty state, so the queue was reachable only from a
                // screen that said there was nothing to see.
                if (data.proposed_face_count > 0) {
                    FaceReviewDoor(data.proposed_face_count, onOpenFaceReview)
                }
                if (data.people.isEmpty()) {
                    ScreenEmpty(
                        sentence = emptySentence(data.empty_reason),
                        remedy = emptyRemedy(data.empty_reason),
                    )
                } else {
                    // WEIGHTED, BECAUSE A LAZY LIST NEEDS A BOUNDED HEIGHT. A
                    // `LazyColumn` measured with an infinite maximum height
                    // throws at runtime rather than at compile time, and this
                    // shell has no Android compiler on the machine that wrote
                    // it — so the constraint is stated rather than discovered.
                    LazyColumn(
                        modifier = Modifier.weight(1f),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        // NOTHING WAITING, AND SAID SO (v0's roster foot). The
                        // door above is absent when the queue is empty, and a
                        // member who cannot see it should not have to wonder
                        // whether it is hidden or finished.
                        if (data.proposed_face_count == 0) {
                            item {
                                Text(
                                    text = ALL_MATCHED,
                                    style = centraidType("small"),
                                    color = centraidColor("textFaint"),
                                )
                            }
                        }
                        items(data.people) { person ->
                            PersonRowItem(
                                person = person,
                                onOpen = { onOpenPerson(person) },
                                onRename = { name ->
                                    onEvent(
                                        PhotosPeopleEvent(
                                            renamed = PhotosPeopleEvent.PersonRenamed(
                                                party_id = person.party_id,
                                                display_name = name,
                                            ),
                                        ),
                                    )
                                },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun FaceReviewDoor(count: Int, onOpen: () -> Unit) {
    val label = if (count == 1) "1 face to name" else "$count faces to name"
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onOpen)
            .padding(vertical = 8.dp)
            .semantics { contentDescription = label },
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CentraidIcon(iconKey = "UserPlus", tint = centraidColor("text"), size = 20.dp)
        Column {
            Text(text = label, style = centraidType("body"), color = centraidColor("text"))
            Text(
                text = PhotosCopy.PHOTOS_PEOPLE_TO_NAME_CAPTION,
                style = centraidType("small"),
                color = centraidColor("textSoft"),
            )
        }
    }
}

/**
 * ONE PERSON.
 *
 * The cover is the bridge's fourth leg, keyed on `cover_asset_id`. When it did
 * not run, did not answer, or answered no path, the ground is the person's
 * INITIAL and never a placeholder photograph: a grey square where a face goes
 * reads as "this failed", and a letter reads as "no picture yet".
 */
@Composable
private fun PersonRowItem(
    person: PersonRow,
    onOpen: () -> Unit,
    onRename: (String) -> Unit,
) {
    var renaming by remember { mutableStateOf(false) }
    val count = countSentence(person)
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            modifier = Modifier
                .weight(1f)
                .clickable(onClick = onOpen)
                .semantics { contentDescription = "${person.display_name}, $count" },
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val cover = person.cover_thumbnail_path
            Box(
                modifier = Modifier
                    .size(40.dp)
                    .clip(CircleShape)
                    .background(centraidColor("bgSunken"), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                if (!cover.isNullOrEmpty()) {
                    ContentImage(cover)
                } else {
                    Text(
                        text = person.display_name.take(1).uppercase(),
                        style = centraidType("body"),
                        color = centraidColor("text"),
                    )
                }
            }
            Column {
                Text(
                    text = person.display_name,
                    style = centraidType("body"),
                    color = centraidColor("text"),
                )
                Text(text = count, style = centraidType("small"), color = centraidColor("textSoft"))
            }
        }
        IconKey(
            iconKey = "Pencil",
            label = "Rename ${person.display_name}",
            testTag = "people-rename",
            bordered = false,
            onPress = { renaming = true },
        )
    }
    if (renaming) {
        RenameSheet(
            title = "Rename",
            fieldLabel = "Name",
            current = person.display_name,
            onDismiss = { renaming = false },
        ) { name ->
            renaming = false
            // AN EMPTY NAME IS NOT A RENAME. `core.update_party` puts
            // `minLength: 1` on the column, so the vault would refuse it — and
            // the reducer drops it too, so this is the cheapest of three
            // guards rather than the only one.
            val trimmed = name.trim()
            if (trimmed.isNotEmpty() && trimmed != person.display_name) {
                onRename(trimmed)
            }
        }
    }
}

/**
 * THE COUNT IS A FLOOR WHEN THE PAGE FILLED, AND SAYS SO.
 *
 * The read door has no `COUNT(*)`, so the number is counted off the rows one
 * page returned. "at least 84" is the honest phrasing; a bare number over a
 * full page would be a total nobody counted (`HomeTile.count.capped`).
 */
private fun countSentence(person: PersonRow): String {
    val noun = if (person.photo_count == 1) "photo" else "photos"
    return if (person.photo_count_capped) {
        "at least ${person.photo_count} $noun"
    } else {
        "${person.photo_count} $noun"
    }
}

/**
 * THREE EMPTY SCREENS, THREE SENTENCES.
 *
 * v0 drew one for all three (`PeopleEmptyState.tsx`) and they have three
 * different next moves: a setting to change, a wait, or a door to open. The
 * reason is read off the vault's recognition tier and never off an absence,
 * which is the whole point of `PhotosPeopleData.empty_reason`.
 */
private fun emptySentence(reason: PhotosPeopleData.EmptyReason): String = when (reason) {
    PhotosPeopleData.EmptyReason.EMPTY_REASON_RECOGNITION_OFF -> PhotosCopy.PHOTOS_PEOPLE_OFF
    PhotosPeopleData.EmptyReason.EMPTY_REASON_NOT_RUN_YET ->
        PhotosCopy.PHOTOS_PEOPLE_NOT_LOOKED
    PhotosPeopleData.EmptyReason.EMPTY_REASON_NONE_NAMED ->
        PhotosCopy.PHOTOS_PEOPLE_NONE_NAMED
    PhotosPeopleData.EmptyReason.EMPTY_REASON_NONE,
    PhotosPeopleData.EmptyReason.EMPTY_REASON_UNSPECIFIED,
    -> PhotosCopy.PHOTOS_PEOPLE_NO_ONE
}

private fun emptyRemedy(reason: PhotosPeopleData.EmptyReason): String = when (reason) {
    PhotosPeopleData.EmptyReason.EMPTY_REASON_RECOGNITION_OFF ->
        PhotosCopy.PHOTOS_PEOPLE_OFF_CAPTION
    PhotosPeopleData.EmptyReason.EMPTY_REASON_NOT_RUN_YET ->
        PhotosCopy.PHOTOS_PEOPLE_NOT_LOOKED_CAPTION
    PhotosPeopleData.EmptyReason.EMPTY_REASON_NONE_NAMED ->
        PhotosCopy.PHOTOS_PEOPLE_NONE_NAMED_CAPTION
    PhotosPeopleData.EmptyReason.EMPTY_REASON_NONE,
    PhotosPeopleData.EmptyReason.EMPTY_REASON_UNSPECIFIED,
    -> ""
}

/** v0's roster foot, and `PhotosPeopleView.swift`'s. */
private const val ALL_MATCHED: String = PhotosCopy.PHOTOS_PEOPLE_ALL_MATCHED
