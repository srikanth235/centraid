package dev.centraid.android.screens

import androidx.compose.foundation.Canvas
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
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import centraid.screen.v1.MemoryRow
import centraid.screen.v1.PhotosMemoriesEvent
import centraid.screen.v1.PhotosMemoriesState
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.ContentImage
import dev.centraid.android.kit.ScreenEmpty
import dev.centraid.android.kit.ScreenFailure
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.shared.apps.photos.PhotosMemoriesMachine

/**
 * MEMORIES — WHAT A PASS NOTICED IN A LIBRARY (#1029, photos port).
 *
 * Browse only, as v0's `MemoriesView.tsx` was: no selection, no batch verb, no
 * write. A tap opens the memory's members, which are the library under a
 * predicate — `photos.shelf` with a `PhotoShelf.Memory`.
 *
 * The SwiftUI twin is `mobile/iosApp/Sources/PhotosMemoriesView.swift`; the two
 * are kept in step by hand.
 */
@Composable
public fun PhotosMemoriesScreen(
    state: PhotosMemoriesState,
    onEvent: (PhotosMemoriesEvent) -> Unit,
    /**
     * A tap lands on `photos.shelf`, with the value
     * [PhotosMemoriesMachine.shelfFor] composes — the title rides along so the
     * shelf's head has something to say before its first page returns.
     */
    onOpenMemory: (MemoryRow) -> Unit = {},
) {
    Column(modifier = Modifier.padding(16.dp)) {
        // A WIRE PROPERTY IS CROSS-MODULE PUBLIC API, so Kotlin will not
        // smart-cast it after a null check. Binding each arm's value to a local
        // first is what makes the branches type-check.
        val loading = state.loading
        val failure = state.failure
        val data = state.data_
        when {
            loading != null -> CircularProgressIndicator()

            failure != null -> ScreenFailure(failure.sentence, failure.remedy)

            data != null -> {
                val memories = data.memories
                if (memories.isEmpty()) {
                    // TWO EMPTY SHELVES, AND THEY ARE NOT THE SAME SCREEN.
                    // `computed` false is a pass that has not run — nothing is
                    // wrong and nothing is missing. True is a pass that ran and
                    // found nothing, which is a fact about the library. On this
                    // tree only the first is reachable: no command in `crates/`
                    // writes the memories projection.
                    if (data.computed) {
                        ScreenEmpty(
                            sentence = "No memories yet.",
                            remedy = "Your own photographs, noticed — a year behind a day, " +
                                "a trip, a burst.",
                        )
                    } else {
                        ScreenEmpty(
                            sentence = "Centraid has not looked for memories yet.",
                            remedy = "They appear here once it has.",
                        )
                    }
                } else {
                    // THREE SECTIONS, AS v0 DREW THEM, over ONE read. The rows
                    // arrive in the vault's own order (`computed_at DESC`) and
                    // each section keeps it, so grouping is an arrangement and
                    // never a re-sort that would disagree with the desktop.
                    LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        memorySection(
                            "On this day",
                            "Calendar",
                            memories.filter { it.kind == MemoryRow.Kind.KIND_ON_THIS_DAY },
                            onOpenMemory,
                        )
                        memorySection(
                            "Trips",
                            "place",
                            memories.filter { it.kind == MemoryRow.Kind.KIND_TRIP },
                            onOpenMemory,
                        )
                        memorySection(
                            "Similar moments",
                            "Image",
                            memories.filter { it.kind == MemoryRow.Kind.KIND_SIMILAR },
                            onOpenMemory,
                        )
                        // A KIND THIS BUILD DOES NOT KNOW IS STILL A MEMORY.
                        // Drawn rather than dropped: a shelf that quietly
                        // shrinks when a newer vault adds a fourth kind is a
                        // shelf a member cannot trust.
                        memorySection(
                            "Other",
                            "Sparkle",
                            memories.filter { it.kind == MemoryRow.Kind.KIND_UNSPECIFIED },
                            onOpenMemory,
                        )
                    }
                }
            }
        }
    }
}

private fun LazyListScope.memorySection(
    title: String,
    iconKey: String,
    rows: List<MemoryRow>,
    onOpen: (MemoryRow) -> Unit,
) {
    if (rows.isEmpty()) return
    item(key = "section:$title") {
        Row(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CentraidIcon(iconKey = iconKey, tint = centraidColor("textSoft"), size = 16.dp)
            Text(text = title, style = centraidType("title"), color = centraidColor("text"))
        }
    }
    items(rows.size, key = { index -> rows[index].memory_id }) { index ->
        MemoryCard(rows[index], onOpen)
    }
}

/**
 * ONE MEMORY, AS A ROW.
 *
 * No tile rail: the members are a page of `media_asset` and this screen reads
 * `media_memory` alone, so drawing thumbnails here would need a second read per
 * memory. The shelf a tap opens is where the photographs are, which is the
 * contract's own arrangement — *"computed memories; their MEMBERS are a
 * shelf"*.
 */
@Composable
private fun MemoryCard(row: MemoryRow, onOpen: (MemoryRow) -> Unit) {
    val title = PhotosMemoriesMachine.titleOf(row)
    val days = PhotosMemoriesMachine.dayRangeOf(row)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onOpen(row) }
            .semantics { contentDescription = title },
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(56.dp)
                .clip(RoundedCornerShape(5.dp))
                // THE GROUND, when there are no bytes. The cover needs a
                // `media_asset` row this read never asks for, so it is empty
                // here rather than fetched by a second trip per card.
                .background(centraidColor("bgSunken")),
        ) {
            val cover = row.cover_thumbnail_path
            if (cover != null && cover.isNotEmpty()) ContentImage(path = cover)
        }
        Column(Modifier.weight(1f)) {
            Text(
                text = title,
                style = centraidType("smallStrong"),
                color = centraidColor("text"),
                maxLines = 1,
            )
            if (days.isNotEmpty()) {
                Text(
                    text = days,
                    style = centraidType("mono"),
                    color = centraidColor("textFaint"),
                )
            }
        }
        if (row.route.isNotEmpty()) RouteSketch(row)
    }
}

/**
 * A TRIP'S ROUTE, SKETCHED BESIDE ITS NAME (v0's `RouteSketch`, #816).
 *
 * Small on purpose — it situates the trip, it is not a map to be read — and
 * drawn here from the member's own coordinates with nothing fetched: a tile
 * would tell a stranger's server where the member has been
 * (`docs/photos/places.md`). The stops are joined in the order the photographs
 * were taken; a one-stop trip is a dot and no line. The arithmetic is
 * [PhotosMemoriesMachine.sketch], shared with `PhotosMemoriesView.swift`.
 */
@Composable
private fun RouteSketch(row: MemoryRow) {
    val line = centraidColor("textFaint")
    val dot = centraidColor("textSoft")
    val stops = row.route.size
    Canvas(
        modifier = Modifier
            .size(width = SKETCH_WIDTH, height = SKETCH_HEIGHT)
            .clip(RoundedCornerShape(4.dp))
            .background(centraidColor("bgSunken"))
            .semantics {
                contentDescription = if (stops == 1) "A sketch of one stop" else "A sketch of $stops stops"
            },
    ) {
        val pad = SKETCH_PAD.toPx()
        val width = size.width - pad * 2
        val height = size.height - pad * 2
        val points = PhotosMemoriesMachine
            .sketch(row.route, aspect = (width / height).toDouble())
            .map { Offset(pad + it.x.toFloat() * width, pad + it.y.toFloat() * height) }
        points.zipWithNext { from, to -> drawLine(line, from, to, strokeWidth = 1.dp.toPx()) }
        points.forEach { drawCircle(dot, radius = 2.5.dp.toPx(), center = it) }
    }
}

private val SKETCH_WIDTH = 96.dp
private val SKETCH_HEIGHT = 56.dp

/** Clear of the plate's edge by a dot's radius, as v0's was. */
private val SKETCH_PAD = 7.dp
