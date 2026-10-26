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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import centraid.core.v1.PhotosPlaceRow
import centraid.core.v1.PhotosPlacesData
import centraid.core.v1.PhotosPlacesEvent
import centraid.core.v1.PhotosPlacesState
import centraid.core.v1.Route
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.ContentImage
import dev.centraid.android.kit.KitLink
import dev.centraid.android.kit.KitSegmented
import dev.centraid.android.kit.RowSkeleton
import dev.centraid.android.kit.ScreenEmpty
import dev.centraid.android.kit.ScreenFailure
import dev.centraid.android.theme.LocalCentraidTokens
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidGeometry

/**
 * PLACES — THE SHELF AND THE PLOT, ON ONE SCREEN, drawn from the core's
 * [PhotosPlacesState] (#1135). Cards or a map is a parameter Rust holds; the
 * control at the top swaps the body over the rows already on screen. A row
 * carries the [Route] to its shelf. The projection of a place onto the plate
 * (`pin_x`, `pin_y`, `pin_size`) is Rust's (`photos/places.rs`); this only
 * multiplies by its own box. Nothing is fetched: the plate is drawn from the
 * member's own coordinates, with no basemap and no request to anyone.
 *
 * The SwiftUI twin is `mobile/iosApp/Sources/PlacesView.swift`.
 */
@Composable
public fun PlacesScreen(
    state: PhotosPlacesState,
    onEvent: (PhotosPlacesEvent) -> Unit,
    onOpen: (Route) -> Unit = {},
) {
    val map = state.presentation == PhotosPlacesState.Presentation.PRESENTATION_MAP
    Column(modifier = Modifier.padding(16.dp)) {
        KitSegmented(
            options = listOf(PRESENT_CARDS to state.cards_label, PRESENT_MAP to state.map_label),
            selected = if (map) PRESENT_MAP else PRESENT_CARDS,
            onSelect = { key ->
                onEvent(
                    PhotosPlacesEvent(
                        presentation = PhotosPlacesEvent.PresentationChanged(
                            if (key == PRESENT_MAP) {
                                PhotosPlacesState.Presentation.PRESENTATION_MAP
                            } else {
                                PhotosPlacesState.Presentation.PRESENTATION_CARDS
                            },
                        ),
                    ),
                )
            },
        )

        // A REFUSED RENAME, OVER THE LIST AND NEVER INSTEAD OF IT.
        state.status?.let { ScreenFailure(it.sentence, "") }

        val loading = state.loading
        val failure = state.failure
        val data = state.data_
        when {
            loading != null -> RowSkeleton()
            failure != null -> ScreenFailure(failure.sentence, failure.remedy)
            data != null -> {
                val empty = data.empty
                val mapEmpty = data.map_empty
                if (empty != null) {
                    ScreenEmpty(sentence = empty.headline, remedy = empty.body)
                } else if (map && mapEmpty != null) {
                    ScreenEmpty(sentence = mapEmpty.headline, remedy = mapEmpty.body)
                } else if (map) {
                    PlacesPlot(data, onOpen)
                } else {
                    PlaceCards(
                        places = data.places,
                        modifier = Modifier.weight(1f),
                        onOpen = onOpen,
                        onName = { row ->
                            onEvent(
                                PhotosPlacesEvent(
                                    name_requested = PhotosPlacesEvent.NameRequested(place_id = row.place_id),
                                ),
                            )
                        },
                    )
                }
                Footer(data = data, isMap = map, onOpen = onOpen)
            }
        }
    }

    val sheet = state.name_sheet
    if (sheet != null) {
        // A blank name is not offered: the sheet does not enable its verb.
        RenameSheet(
            title = sheet.title,
            fieldLabel = sheet.field_label,
            current = sheet.current,
            onDismiss = { onEvent(PhotosPlacesEvent(name_dismissed = PhotosPlacesEvent.NameDismissed())) },
            primaryLabel = sheet.save_label,
        ) { name ->
            onEvent(
                PhotosPlacesEvent(
                    renamed = PhotosPlacesEvent.Renamed(place_id = sheet.place_id, name = name),
                ),
            )
        }
    }
}

private const val PRESENT_CARDS = "cards"
private const val PRESENT_MAP = "map"

/** The plate's inset, so a pin on the edge is not clipped. Geometry, not copy. */
private const val PLOT_INSET = 32

@Composable
private fun PlaceCards(
    places: List<PhotosPlaceRow>,
    modifier: Modifier,
    onOpen: (Route) -> Unit,
    onName: (PhotosPlaceRow) -> Unit,
) {
    LazyVerticalGrid(
        columns = GridCells.Adaptive(minSize = 140.dp),
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        items(places) { row -> PlaceCard(row, onOpen, onName) }
    }
}

/** ONE PLACE, AS A CARD. The count is drawn only when Rust gave one. */
@Composable
private fun PlaceCard(
    row: PhotosPlaceRow,
    onOpen: (Route) -> Unit,
    onName: (PhotosPlaceRow) -> Unit,
) {
    Column(
        modifier = Modifier
            .clickable { row.open_?.let(onOpen) }
            .semantics { contentDescription = row.spoken },
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(4f / 3f)
                .clip(RoundedCornerShape((LocalCentraidTokens.current.radii["md"] ?: 0).dp))
                // THE GROUND, when there are no bytes: a surface the eye reads as empty.
                .background(centraidColor("bgSunken")),
        ) {
            val cover = row.cover?.thumbnail_path
            if (!cover.isNullOrEmpty()) ContentImage(path = cover)
        }
        Text(
            text = row.title,
            style = centraidType("small"),
            color = centraidColor("text"),
            maxLines = 2,
        )
        if (row.count_label.isNotEmpty()) {
            Text(
                text = row.count_label,
                style = centraidType("mono"),
                color = centraidColor("textFaint"),
            )
        }
        KitLink(label = row.name_label, dense = true, onClick = { onName(row) })
    }
}

/** THE PRIVATE PLOT: the pins over a plate, and no basemap at all. */
@Composable
private fun PlacesPlot(data: PhotosPlacesData, onOpen: (Route) -> Unit) {
    val plotted = data.places.filter { it.pinned }
    val line = centraidColor("line")
    BoxWithConstraints(
        modifier = Modifier
            .fillMaxWidth()
            .height(260.dp)
            .clip(RoundedCornerShape((LocalCentraidTokens.current.radii["md"] ?: 0).dp))
            .background(centraidColor("bgSunken")),
    ) {
        // RHYTHM, NOT REFERENCE: a graticule says "a chart of your own coordinates".
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
        Text(
            text = data.north_label,
            style = centraidType("mono"),
            color = centraidColor("textFaint"),
            modifier = Modifier.align(Alignment.TopEnd).padding(6.dp),
        )
        val inset = PLOT_INSET.dp
        val spanWidth = maxWidth - inset * 2
        val spanHeight = maxHeight - inset * 2
        plotted.forEach { row ->
            val diameter = row.pin_size.dp
            val cover = row.cover?.thumbnail_path?.takeIf { it.isNotEmpty() }
            val shape = RoundedCornerShape((LocalCentraidTokens.current.radii["md"] ?: 0).dp)
            // A PIN IS THE PLACE'S NEWEST PHOTOGRAPH WITH ITS COUNT IN THE CORNER;
            // with no cover it is the count alone, on the stage ink.
            Box(
                modifier = Modifier
                    .offset(
                        x = inset + spanWidth * row.pin_x.toFloat() - diameter / 2,
                        y = inset + spanHeight * row.pin_y.toFloat() - diameter / 2,
                    )
                    .size(diameter)
                    .clip(shape)
                    .background(centraidColor(if (cover != null) "bgElev" else "stage"))
                    .border(CentraidGeometry.HAIRLINE.dp, centraidColor("line"), shape)
                    .clickable { row.open_?.let(onOpen) }
                    .semantics { contentDescription = row.spoken },
                contentAlignment = Alignment.Center,
            ) {
                if (cover != null) {
                    ContentImage(path = cover)
                    if (row.count_mark.isNotEmpty()) {
                        Text(
                            text = row.count_mark,
                            style = centraidType("mono"),
                            color = centraidColor("onStage"),
                            modifier = Modifier
                                .align(Alignment.BottomEnd)
                                .background(
                                    centraidColor("stage"),
                                    RoundedCornerShape(topStart = (LocalCentraidTokens.current.radii["md"] ?: 0).dp),
                                )
                                .padding(horizontal = 4.dp),
                        )
                    }
                } else {
                    Text(
                        text = row.count_mark.ifEmpty { "·" },
                        style = centraidType("mono"),
                        color = centraidColor("onStage"),
                    )
                }
            }
        }
    }
}

/** WHAT THE SHELF IS NOT SHOWING, AND WHERE THE PIXELS CAME FROM. */
@Composable
private fun Footer(data: PhotosPlacesData, isMap: Boolean, onOpen: (Route) -> Unit) {
    val unplacedOpen = data.unplaced_open
    if (data.unplaced_label.isNotEmpty()) {
        // AND IT IS A DOOR: a count of photographs a member cannot reach is a
        // number with no next move.
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = CentraidGeometry.TARGET_MIN_COARSE.dp)
                .clickable(enabled = unplacedOpen != null) { unplacedOpen?.let(onOpen) }
                .semantics(mergeDescendants = true) {
                    contentDescription = "${data.unplaced_label} ${data.unplaced_open_label}"
                    role = Role.Button
                },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = data.unplaced_label,
                style = centraidType("small"),
                color = centraidColor("textSoft"),
                modifier = Modifier.weight(1f),
            )
            CentraidIcon(iconKey = "ChevronRight", tint = centraidColor("textFaint"))
        }
    }
    if (isMap) {
        if (data.unpinned_label.isNotEmpty()) {
            Text(text = data.unpinned_label, style = centraidType("small"), color = centraidColor("textSoft"))
        }
        Text(text = data.map_note, style = centraidType("small"), color = centraidColor("textFaint"))
    }
}
