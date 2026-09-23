package dev.centraid.android.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import centraid.screen.v1.PhotoShelf
import centraid.screen.v1.PlaceRow
import centraid.screen.v1.PlacesEvent
import centraid.screen.v1.PlacesState
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.ContentImage
import dev.centraid.android.kit.ScreenEmpty
import dev.centraid.android.kit.ScreenFailure
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidGeometry
import dev.centraid.shared.apps.photos.PlacesMachine
import kotlin.math.sqrt

/**
 * PLACES — THE SHELF AND THE PLOT, ON ONE SCREEN (#1029, photos port).
 *
 * v0 had `PlacesView.tsx` and `PlacesMap.tsx`: two routes, two reads of the
 * same rows, two empty states. Here the draw is a parameter, so the control at
 * the top swaps the body over rows that are already on screen and no read is
 * emitted.
 *
 * The SwiftUI twin is `mobile/iosApp/Sources/PlacesView.swift`; the two are
 * kept in step by hand, which is what a shared state message and a shared
 * screen id buy — the arrangement is per platform, the meaning is not.
 */
@Composable
public fun PlacesScreen(
    state: PlacesState,
    onEvent: (PlacesEvent) -> Unit,
    /**
     * A tap lands on `photos.shelf` with a `PhotoShelf.Place`, which
     * [PlacesMachine.shelfFor] composes — **names ride along**, so the shelf's
     * head says "The cabin" before its first page returns.
     *
     * A callback and not an event: navigation is the shell's and the reducer
     * has nothing to change when a member leaves this screen.
     */
    onOpenPlace: (PlaceRow) -> Unit = {},
    /**
     * A tap on "N photographs carry no place": the shelf of those photographs
     * ([PlacesMachine.unplacedShelf]), v0's trailing "No location yet" card.
     */
    onOpenShelf: (PhotoShelf) -> Unit = {},
) {
    // WHICH PLACE THE RENAME DIALOG IS ABOUT, and the words typed so far. The
    // typed text lives here because this is the only place it exists before it
    // is written; the reducer holds the name the vault last said.
    var renaming: PlaceRow? by remember { mutableStateOf(null) }
    var typedName by remember { mutableStateOf("") }

    Column(modifier = Modifier.padding(16.dp)) {
        PresentationControl(state.presentation, onEvent)

        // A REFUSED WRITE, OVER THE LIST AND NEVER INSTEAD OF IT. `failure` in
        // the `content` oneof is the READ's slot; a denied rename drawn there
        // would replace the shelf of places the member was renaming from with
        // an error about a write that changed nothing.
        val writeFailure = state.write_failure
        if (writeFailure != null) {
            ScreenFailure(writeFailure.sentence, writeFailure.remedy)
        }

        // A WIRE PROPERTY IS CROSS-MODULE PUBLIC API, so Kotlin will not
        // smart-cast it after a null check. Binding each arm's value to a local
        // first is what makes the branches type-check, and it is the shape
        // every screen in this module uses.
        val loading = state.loading
        val failure = state.failure
        val data = state.data_
        when {
            loading != null -> CircularProgressIndicator()

            failure != null -> ScreenFailure(failure.sentence, failure.remedy)

            data != null -> {
                val places = data.places
                if (places.isEmpty()) {
                    ScreenEmpty(
                        sentence = "No places yet.",
                        remedy = "A place is something a photograph carries, or does not.",
                    )
                } else if (state.presentation == PlacesState.Presentation.PRESENTATION_MAP) {
                    PlacesPlot(places, onOpenPlace)
                } else {
                    PlaceCards(
                        places = places,
                        modifier = Modifier.weight(1f),
                        onOpen = onOpenPlace,
                        onRename = { row ->
                            renaming = row
                            typedName = row.name
                        },
                    )
                }
                Footer(
                    places = places,
                    unplaced = data.unplaced_count,
                    unplacedCapped = data.unplaced_count_capped,
                    isMap = state.presentation == PlacesState.Presentation.PRESENTATION_MAP,
                    onOpenUnplaced = { onOpenShelf(PlacesMachine.unplacedShelf()) },
                )
            }
        }
    }

    val target = renaming
    if (target != null) {
        RenameDialog(
            typedName = typedName,
            onTyped = { typedName = it },
            onDismiss = { renaming = null },
            onSave = {
                onEvent(
                    PlacesEvent(
                        renamed = PlacesEvent.PlaceRenamed(
                            place_id = target.place_id,
                            name = typedName,
                        ),
                    ),
                )
                renaming = null
            },
        )
    }
}

/**
 * CARDS OR A PLOT, as two controls over one read.
 *
 * The marks are this product's own (`CentraidCatalog.icons`) and never
 * Material's: a second icon set is a second product, and an unknown key draws
 * nothing at all.
 */
@Composable
private fun PresentationControl(
    presentation: PlacesState.Presentation,
    onEvent: (PlacesEvent) -> Unit,
) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        PresentationButton(
            selected = presentation != PlacesState.Presentation.PRESENTATION_MAP,
            iconKey = "Grid",
            label = "Cards",
            onClick = {
                onEvent(
                    PlacesEvent(
                        presentation = PlacesEvent.PresentationChanged(
                            PlacesState.Presentation.PRESENTATION_CARDS,
                        ),
                    ),
                )
            },
        )
        PresentationButton(
            selected = presentation == PlacesState.Presentation.PRESENTATION_MAP,
            iconKey = "MapPin",
            label = "Map",
            onClick = {
                onEvent(
                    PlacesEvent(
                        presentation = PlacesEvent.PresentationChanged(
                            PlacesState.Presentation.PRESENTATION_MAP,
                        ),
                    ),
                )
            },
        )
    }
}

@Composable
private fun PresentationButton(
    selected: Boolean,
    iconKey: String,
    label: String,
    onClick: () -> Unit,
) {
    val ink = centraidColor(if (selected) "text" else "textSoft")
    TextButton(onClick = onClick) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CentraidIcon(iconKey = iconKey, tint = ink, size = 16.dp)
            Text(text = label, style = centraidType("control"), color = ink)
        }
    }
}

@Composable
private fun PlaceCards(
    places: List<PlaceRow>,
    modifier: Modifier,
    onOpen: (PlaceRow) -> Unit,
    onRename: (PlaceRow) -> Unit,
) {
    LazyVerticalGrid(
        columns = GridCells.Adaptive(minSize = 140.dp),
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        items(places) { row -> PlaceCard(row, onOpen, onRename) }
    }
}

/**
 * ONE PLACE, AS A CARD.
 *
 * The count is drawn only when it is non-zero: it is derived by reading the
 * library's own page and counting it, so a zero is "this read has not counted
 * it" and never "no photographs here". A "0" under a place a member has
 * photographed is worse than no number at all.
 */
@Composable
private fun PlaceCard(
    row: PlaceRow,
    onOpen: (PlaceRow) -> Unit,
    onRename: (PlaceRow) -> Unit,
) {
    val label = if (row.asset_count > 0) {
        "${row.name}, ${countPhrase(row)} photographs"
    } else {
        row.name
    }
    Column(
        modifier = Modifier
            .clickable { onOpen(row) }
            .semantics { contentDescription = label },
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(4f / 3f)
                .clip(RoundedCornerShape(7.dp))
                // THE GROUND, when there are no bytes. Not a placeholder image:
                // a surface the eye reads as empty.
                .background(centraidColor("bgSunken")),
        ) {
            val cover = row.cover_thumbnail_path
            if (cover != null && cover.isNotEmpty()) ContentImage(path = cover)
        }
        Text(
            text = row.name,
            style = centraidType("small"),
            color = centraidColor("text"),
            maxLines = 2,
        )
        if (row.asset_count > 0) {
            Text(
                text = countPhrase(row),
                style = centraidType("mono"),
                color = centraidColor("textFaint"),
            )
        }
        TextButton(onClick = { onRename(row) }) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CentraidIcon(
                    iconKey = "Pencil",
                    tint = centraidColor("textSoft"),
                    size = 14.dp,
                )
                Text(
                    text = "Name this place",
                    style = centraidType("control"),
                    color = centraidColor("textSoft"),
                )
            }
        }
    }
}

/**
 * THE PRIVATE PLOT — the pins over a plate, and no basemap at all.
 *
 * v0 could choose a real tile map (`places-map-mode.ts`, default `real`) and
 * disclosed the cost under it: the provider sees which areas a member opens.
 * **Neither shell here links a map SDK, and `docs/photos/places.md` says no
 * surface in this tree draws a map**, so this is the private ground: a
 * coordinate-space plot of the member's own `geo_lat`/`geo_lng` drawn with the
 * shell's own `Canvas` and no request to anyone. A real-tile map remains a
 * separate decision with that privacy cost attached.
 *
 * The projection is [PlacesMachine.plot], in `commonMain`, so the one place the
 * arithmetic can be wrong is the one place a JVM spec can test it.
 */
@Composable
private fun PlacesPlot(places: List<PlaceRow>, onOpen: (PlaceRow) -> Unit) {
    val plotted = PlacesMachine.plot(places)
    if (plotted.isEmpty()) {
        ScreenEmpty(
            sentence = "No place here carries a coordinate.",
            remedy = "A photograph lands on the plot once it carries where it was taken.",
        )
        return
    }
    val byId = places.associateBy { it.place_id }
    val largest = plotted.maxOf { it.count }.coerceAtLeast(1)
    val line = centraidColor("line")
    BoxWithConstraints(
        modifier = Modifier
            .fillMaxWidth()
            .height(260.dp)
            .clip(RoundedCornerShape(7.dp))
            .background(centraidColor("bgSunken")),
    ) {
        // RHYTHM, NOT REFERENCE. A graticule says "this is a chart of your own
        // coordinates" where a tiled ground would say "this is the world",
        // which is a claim this plate cannot make.
        Canvas(modifier = Modifier.fillMaxSize()) {
            for (step in 1..3) {
                val fraction = step / 4f
                drawLine(
                    color = line,
                    start = Offset(0f, size.height * fraction),
                    end = Offset(size.width, size.height * fraction),
                    strokeWidth = 1f,
                )
                drawLine(
                    color = line,
                    start = Offset(size.width * fraction, 0f),
                    end = Offset(size.width * fraction, size.height),
                    strokeWidth = 1f,
                )
            }
        }
        // NORTH, because the plate has no other orientation cue and a chart
        // without one is a picture.
        Text(
            text = "N ↑",
            style = centraidType("mono"),
            color = centraidColor("textFaint"),
            modifier = Modifier.align(Alignment.TopEnd).padding(6.dp),
        )
        val inset = 30.dp
        val spanWidth = maxWidth - inset * 2
        val spanHeight = maxHeight - inset * 2
        plotted.forEach { pin ->
            val row = byId[pin.placeId] ?: return@forEach
            val diameter = pinSize(pin.count, largest)
            val label = if (row.asset_count > 0) {
                "${row.name}, ${countPhrase(row)} photographs"
            } else {
                row.name
            }
            // A PIN IS THE PLACE'S NEWEST PHOTOGRAPH WITH ITS COUNT IN THE
            // CORNER (v0's `places-pin.tsx`): a member recognises a place by
            // what they took there long before they recognise it by where it
            // sits on a plate with no coastline. With no cover it is the count
            // alone, on the stage ink.
            val cover = row.cover_thumbnail_path?.takeIf { it.isNotEmpty() }
            val shape = RoundedCornerShape(7.dp)
            Box(
                modifier = Modifier
                    .offset(
                        x = inset + spanWidth * pin.x.toFloat() - diameter / 2,
                        y = inset + spanHeight * pin.y.toFloat() - diameter / 2,
                    )
                    .size(diameter)
                    .clip(shape)
                    .background(centraidColor(if (cover != null) "bgElev" else "stage"))
                    .border(CentraidGeometry.HAIRLINE.dp, centraidColor("line"), shape)
                    // A PIN IS A CONTROL WITH A NAME. A bare shape gives the
                    // accessibility tree nothing to land on, which is the same
                    // reason v0 put real `Pressable`s over its SVG.
                    .clickable { onOpen(row) }
                    .semantics { contentDescription = label },
                contentAlignment = Alignment.Center,
            ) {
                if (cover != null) {
                    ContentImage(path = cover)
                    if (pin.count > 0) {
                        Text(
                            text = pin.count.toString(),
                            style = centraidType("mono"),
                            color = centraidColor("onStage"),
                            modifier = Modifier
                                .align(Alignment.BottomEnd)
                                .background(
                                    centraidColor("stage"),
                                    RoundedCornerShape(topStart = 7.dp),
                                )
                                .padding(horizontal = 4.dp),
                        )
                    }
                } else {
                    Text(
                        text = if (pin.count > 0) pin.count.toString() else "·",
                        style = centraidType("mono"),
                        color = centraidColor("onStage"),
                    )
                }
            }
        }
    }
}

/**
 * Area tracks the count, as `pinSize` did: the square root, so a place with
 * four times the photographs is twice as wide and not four times.
 */
private fun pinSize(count: Int, largest: Int): Dp {
    // Large enough that the photograph in it is a photograph.
    val floor = 40.dp
    val ceiling = 64.dp
    if (largest <= 1 || count <= 0) return floor
    val ratio = sqrt(count.toFloat()) / sqrt(largest.toFloat())
    return floor + (ceiling - floor) * ratio
}

/**
 * WHAT THE SHELF IS NOT SHOWING, AND WHERE THE PIXELS CAME FROM.
 *
 * Two sentences a member needs and v0 showed only one of:
 *
 * * **`unplaced_count`** — photographs with no place at all. It is the number
 *   that says whether this screen is the library or a corner of it, and v0
 *   never showed it.
 * * **the ground** — nothing is fetched, so opening Places asks nothing of
 *   anyone. v0's default ground was real tiles and the equivalent sentence
 *   there was a disclosure: the provider sees which areas you open.
 */
@Composable
private fun Footer(
    places: List<PlaceRow>,
    unplaced: Int,
    unplacedCapped: Boolean,
    isMap: Boolean,
    onOpenUnplaced: () -> Unit,
) {
    if (unplaced > 0) {
        // "AT LEAST", WHEN THE COUNTING PAGE FILLED. This is the number that
        // answers "is the plot my library or a corner of it", and one that
        // quietly stopped at a page would answer it wrong.
        //
        // AND IT IS A DOOR (v0's "No location yet" card, #816): a count of
        // photographs a member cannot reach is a number with no next move.
        val sentence = unplacedSentence(unplaced, unplacedCapped)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = CentraidGeometry.TARGET_MIN_COARSE.dp)
                .clickable(onClick = onOpenUnplaced)
                .semantics(mergeDescendants = true) {
                    contentDescription = "$sentence Open them."
                    role = Role.Button
                },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = sentence,
                style = centraidType("small"),
                color = centraidColor("textSoft"),
                modifier = Modifier.weight(1f),
            )
            CentraidIcon(iconKey = "ChevronRight", tint = centraidColor("textFaint"))
        }
    }
    if (isMap) {
        val unpinned = places.count { !it.has_coordinate }
        if (unpinned > 0) {
            Text(
                text = if (unpinned == 1) {
                    "1 place has no coordinate, so it is not on the plot."
                } else {
                    "$unpinned places have no coordinate, so they are not on the plot."
                },
                style = centraidType("small"),
                color = centraidColor("textSoft"),
            )
        }
        Text(
            text = "Nothing is fetched — this is drawn here from your own coordinates.",
            style = centraidType("small"),
            color = centraidColor("textFaint"),
        )
    }
}

/**
 * One sentence, four shapes, because "1 photograph carries" and "at least 1
 * photograph carries" are both things a member may read.
 */
private fun unplacedSentence(unplaced: Int, capped: Boolean): String {
    val noun = if (unplaced == 1) "photograph carries" else "photographs carry"
    return if (capped) "At least $unplaced $noun no place." else "$unplaced $noun no place."
}

/**
 * "12", or "at least 12".
 *
 * The counting pass takes ONE page — `media_asset.captured_at` is nullable and
 * a keyset continuation over a nullable sort column drops rows — so past that
 * page every count is a floor. `asset_count_capped` is the row saying so, and
 * a bare number over it would be this card claiming a total it never read.
 */
private fun countPhrase(row: PlaceRow): String =
    if (row.asset_count_capped) "at least ${row.asset_count}" else "${row.asset_count}"

@Composable
private fun RenameDialog(
    typedName: String,
    onTyped: (String) -> Unit,
    onDismiss: () -> Unit,
    onSave: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(text = "Name this place") },
        text = {
            OutlinedTextField(
                value = typedName,
                onValueChange = onTyped,
                singleLine = true,
            )
        },
        confirmButton = {
            TextButton(
                onClick = onSave,
                // `media.name_place` REFUSES A BLANK NAME, so the control that
                // would send one is not offered. A round trip whose only
                // possible outcome is a denial teaches a member nothing.
                enabled = typedName.isNotBlank(),
            ) { Text(text = "Save") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(text = "Cancel") }
        },
    )
}
