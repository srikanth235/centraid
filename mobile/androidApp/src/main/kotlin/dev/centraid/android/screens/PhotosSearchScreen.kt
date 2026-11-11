package dev.centraid.android.screens

import dev.centraid.android.kit.SearchAskRow
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import centraid.core.v1.PhotosHomeEvent
import centraid.core.v1.PhotosEarlierRow
import centraid.core.v1.PhotosSearchDoor
import centraid.core.v1.PhotosSearchResting
import centraid.core.v1.PhotosSearchView
import centraid.core.v1.Route
import dev.centraid.android.kit.BandPolicy
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.ContentImage
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitLink
import dev.centraid.android.kit.LocalBandClearance
import dev.centraid.android.kit.PhotoCellsGrid
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RowSkeleton
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidGeometry

/**
 * SEARCH (#1029, the photos port; #1135).
 *
 * Three states behind one destination, and the distinction the whole screen
 * exists to keep: **a member who has typed nothing and a member whose query
 * matched nothing must not read the same words.** The oneof is which one is
 * showing.
 *
 * **THE FIELD IS NOT HERE.** It is the room's search field, at the foot
 * where every app's search stands (R-CHROME-2). This screen is only what the
 * query found: the doors (places and albums the words name), the photographs,
 * and the reason line — all finished by Rust.
 *
 * The SwiftUI twin is `mobile/iosApp/Sources/PhotosSearchView.swift`.
 */
@Composable
internal fun PhotosSearchScreen(
    search: PhotosSearchView,
    onEvent: (PhotosHomeEvent) -> Unit,
    onOpen: (Route) -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        val resting = search.resting
        val hits = search.hits
        ReadStateView(
            page = search.page!!,
            onRetry = { onEvent(PhotosHomeEvent(refreshed = centraid.core.v1.PhotosRefreshed())) },
            modifier = Modifier.weight(1f),
            skeleton = { RowSkeleton() },
        ) {
            when {
                resting != null -> RestingPanel(resting, onEvent, onOpen)

                // NOTHING MATCHED is the page's Empty state (Rust quotes the query back and says
                // everywhere search looked); hits are only ever something.
                hits != null -> PhotoCellsGrid(
                    cells = hits.tiles,
                    // `onTap` BY NAME: this composable's last parameter is `header`.
                    onTap = { photoId ->
                        val template = hits.open_
                        val args = template?.photos_lightbox
                        if (template != null && args != null) {
                            onOpen(template.copy(photos_lightbox = args.copy(photo_id = photoId)))
                        }
                    },
                    onFetch = { photoId, _ -> onEvent(PhotosHomeEvent(original_requested = photoId)) },
                    // THE DOORS AND THE REASONS SCROLL WITH THE GRID, in its own
                    // scroller: a head that stayed put over a grid of hits would
                    // eat the screen the hits need.
                    header = {
                        item(span = { GridItemSpan(maxLineSpan) }) {
                            HitsHead(hits.doors, hits.matched_label, onOpen)
                        }
                        // THE ASK ROW closes the answer (#1097).
                        item(span = { GridItemSpan(maxLineSpan) }) { SearchAskRow(search.ask, onOpen) }
                    },
                    // PHOTOGRAPHS FOUND ONLY BY WHAT THEY SAID BEFORE (#1185): a tile has no line to
                    // say so, so each is a row under the grid, opening its Earlier versions.
                    footer = {
                        hits.earlier.forEach { row ->
                            item(span = { GridItemSpan(maxLineSpan) }) { EarlierPhotoRow(row, onOpen) }
                        }
                    },
                )
            }
        }
        // THE ASK ROW closes an answer that matched nothing too (#1097): with hits it rides at
        // the foot of the grid above, so only an answer with no hits draws it here.
        if (hits == null) SearchAskRow(search.ask, onOpen)
    }
}

/** THE PLACES AND ALBUMS THE QUERY NAMED, AND WHY THE GRID MATCHED. */
@Composable
private fun HitsHead(doors: List<PhotosSearchDoor>, matched: String, onOpen: (Route) -> Unit) {
    Column(Modifier.padding(bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        doors.forEach { door -> DoorRow(door, onOpen) }
        if (matched.isNotEmpty()) {
            Text(
                text = matched,
                maxLines = 2,
                style = centraidType("small"),
                color = centraidColor("textSoft"),
                modifier = Modifier.padding(top = 4.dp),
            )
        }
    }
}

/**
 * One photograph the words matched only in an earlier version of it: its thumbnail, its title and
 * the line "In an earlier version". A tap opens that photograph's Earlier versions.
 */
@Composable
private fun EarlierPhotoRow(row: PhotosEarlierRow, onOpen: (Route) -> Unit) {
    val path = row.tile?.thumbnail_path
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = CentraidGeometry.TARGET_MIN_COARSE.dp)
            .clickable { row.route?.let(onOpen) }
            .semantics(mergeDescendants = true) {
                contentDescription = row.accessibility_label
                role = Role.Button
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            Modifier
                .size(52.dp)
                .clip(RoundedCornerShape(KitGeometry.RADIUS))
                .background(centraidColor("skel")),
        ) {
            if (!path.isNullOrEmpty()) ContentImage(path)
        }
        Column(Modifier.weight(1f)) {
            Text(row.title, style = centraidType("body"), color = centraidColor("text"), maxLines = 1)
            Text(row.line, style = centraidType("small"), color = centraidColor("textSoft"), maxLines = 1)
        }
        CentraidIcon(iconKey = "ChevronRight", tint = centraidColor("textFaint"))
    }
}

/** One door: the kind's mark, the vault's name for it, what it holds. */
@Composable
private fun DoorRow(door: PhotosSearchDoor, onOpen: (Route) -> Unit) {
    val sub = listOf(door.kind_label, door.count_label).filter { it.isNotEmpty() }.joinToString(" · ")
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = CentraidGeometry.TARGET_MIN_COARSE.dp)
            .clickable { door.route?.let(onOpen) }
            .semantics(mergeDescendants = true) {
                contentDescription = door.accessibility_label
                role = Role.Button
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        CentraidIcon(iconKey = door.icon_key, tint = centraidColor("textSoft"), size = 20.dp)
        Column(Modifier.weight(1f)) {
            Text(door.label, style = centraidType("body"), color = centraidColor("text"), maxLines = 1)
            Text(sub, style = centraidType("small"), color = centraidColor("textSoft"), maxLines = 1)
        }
        CentraidIcon(iconKey = "ChevronRight", tint = centraidColor("textFaint"))
    }
}

/**
 * NOTHING HAS BEEN ASKED YET — so this says what there is to ask FOR.
 *
 * One line that is true of every vault — what a search reaches — and then this
 * vault's own vocabulary under it: the places its photographs were taken, each a
 * door to its shelf, and the labels on them, each a word to search for. Never a
 * fixed list of words the product hopes are there.
 */
@Composable
private fun RestingPanel(resting: PhotosSearchResting, onEvent: (PhotosHomeEvent) -> Unit, onOpen: (Route) -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            // THE PANEL RUNS UNDER THE BAND'S GLASS; its last door scrolls clear of it.
            .padding(bottom = LocalBandClearance.current + BandPolicy.FOOT_MARGIN.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(text = resting.hint, style = centraidType("small"), color = centraidColor("textSoft"))
        if (resting.places.isNotEmpty()) {
            RestingSection(resting.places_title) {
                resting.places.forEach { place ->
                    RestingDoor(place.label, "place") { place.route?.let(onOpen) }
                }
            }
        }
        if (resting.labels.isNotEmpty()) {
            // A LABEL HAS NO SHELF OF ITS OWN: tapping one searches for that word.
            RestingSection(resting.labels_title) {
                resting.labels.forEach { label ->
                    KitLink(label = label.label, onClick = { onEvent(PhotosHomeEvent(search_term = label.label)) })
                }
            }
        }
    }
}

/** A heading over one kind of word, and nothing at all when there are none. */
@Composable
private fun RestingSection(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
            title,
            style = centraidType("smallStrong"),
            color = centraidColor("textSoft"),
            modifier = Modifier.padding(top = 8.dp, bottom = 4.dp),
        )
        content()
    }
}

/** One place on the resting page, opening its shelf. */
@Composable
private fun RestingDoor(label: String, iconKey: String, onOpen: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = CentraidGeometry.TARGET_MIN_COARSE.dp)
            .clickable(onClick = onOpen)
            .semantics(mergeDescendants = true) {
                contentDescription = label
                role = Role.Button
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        CentraidIcon(iconKey = iconKey, tint = centraidColor("textSoft"), size = 20.dp)
        Text(
            label,
            style = centraidType("body"),
            color = centraidColor("text"),
            maxLines = 1,
            modifier = Modifier.weight(1f),
        )
        CentraidIcon(iconKey = "ChevronRight", tint = centraidColor("textFaint"))
    }
}
