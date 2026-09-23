package dev.centraid.android.kit

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyGridScope
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import centraid.screen.v1.PhotoCell
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import kotlin.math.roundToInt

/**
 * ONE CELL RENDERER, FOR EVERY SURFACE THAT DRAWS PHOTOGRAPHS.
 *
 * The library grid, a shelf, the picker and search hits all draw the same
 * [PhotoCell] from the same page read: the same square ground, the same two
 * empty-cell sentences, the same held overlay and the same download arrow. v0
 * wrote that four times and they drifted — only one ever grew the "no pack at
 * all" sentence, and the picker's cells never showed held state at all, so a
 * member could pick a photograph this device did not have.
 *
 * The SwiftUI twin is `mobile/iosApp/Sources/PhotoCells.swift`; the two are
 * kept in step by hand, which is what a shared state message and a shared
 * screen id buy — the arrangement is per platform, the meaning is not.
 */
@Composable
public fun PhotoCellsGrid(
    cells: List<PhotoCell>,
    /**
     * TWO DIFFERENT EMPTY-CELL SENTENCES (`docs/mobile-offline.md:224`). A
     * member with no thumbnail pack and a member whose pack has evicted these
     * must not read the same words.
     */
    packAbsent: Boolean,
    modifier: Modifier = Modifier,
    selected: Set<String> = emptySet(),
    /**
     * Assets this surface cannot pick because they are already where the pick
     * would put them. Drawn as taken rather than hidden: a member looking for a
     * photograph they added last week should find it, and find out why it will
     * not tick.
     */
    taken: Set<String> = emptySet(),
    minimumCell: Int = 96,
    onTap: ((String) -> Unit)? = null,
    onFetch: ((assetId: String, contentHash: String) -> Unit)? = null,
    /** Rows a surface puts ABOVE its cells inside the same scroller, so the
     *  head scrolls with the grid rather than sitting in a second one. */
    header: (LazyGridScope.() -> Unit)? = null,
) {
    LazyVerticalGrid(
        columns = GridCells.Adaptive(minSize = minimumCell.dp),
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        header?.invoke(this)
        items(cells) { cell ->
            PhotoCellSquare(
                cell = cell,
                packAbsent = packAbsent,
                isSelected = cell.asset_id in selected,
                isTaken = cell.asset_id in taken,
                onTap = onTap,
                onFetch = onFetch,
            )
        }
    }
}

@Composable
public fun PhotoCellSquare(
    cell: PhotoCell,
    packAbsent: Boolean,
    modifier: Modifier = Modifier,
    isSelected: Boolean = false,
    isTaken: Boolean = false,
    onTap: ((String) -> Unit)? = null,
    onFetch: ((assetId: String, contentHash: String) -> Unit)? = null,
) {
    val path = cell.thumbnail_path
    val label = cellLabel(cell, packAbsent)
    Box(
        modifier
            .aspectRatio(1f)
            .alpha(if (isTaken) 0.45f else 1f)
            .background(centraidColor("skel"))
            .then(
                if (onTap != null && !isTaken) {
                    Modifier.clickable { onTap(cell.asset_id) }
                } else {
                    Modifier
                },
            )
            .semantics { contentDescription = label },
    ) {
        if (!path.isNullOrEmpty()) ContentImage(path) else Text(text = label)
        // WHAT THIS DEVICE HAS OF THIS PHOTOGRAPH, ON TOP OF IT (#1025 S5,
        // D-1025-S7-62). A thumbnail is under every one of these: what the
        // overlay says is whether the FULL-SIZE file is here, moving, or
        // waiting on the member's own rule.
        HeldState(cell, onFetch)
        if (isTaken) {
            // TAKEN AND SELECTED MUST NOT READ THE SAME: one says "you are
            // choosing this now", the other "this is already where you are
            // putting it" — so the taken dot is the muted ink.
            SelectionDot(selected = true, muted = true)
        } else if (isSelected) {
            SelectionDot(selected = true)
        }
        KindLine(cell, rung = TILE_KIND_MIN_RUNG)
    }
}

/**
 * ONE TILE OF THE JUSTIFIED TIMELINE (v0's `PhotoTile.tsx`, #1029 photos port).
 *
 * Its box is fixed from the asset record before a byte arrives — `width` and
 * `height` come from [justify] — and every state paints INSIDE it, so nothing
 * reflows when a thumbnail lands. Four overlay slots and nothing else (v0's
 * `tile-overlays.ts`): selection top-trailing, kind bottom-trailing, and the
 * held state bottom-leading. The fourth, v0's vault rule, marked a photograph
 * from a vault other than the member's own inside a MERGED timeline; this grid
 * reads one vault, so every tile would carry it and the mark would say
 * nothing.
 *
 * Taps and long presses are the caller's: the library's drag-to-select owns
 * the gesture layer above the rows, so a tile that also claimed a long press
 * would race it.
 */
@Composable
public fun PhotoTile(
    cell: PhotoCell,
    width: Int,
    height: Int,
    rung: Int,
    selecting: Boolean,
    selected: Boolean,
    modifier: Modifier = Modifier,
    onTap: () -> Unit = {},
    onLongPress: (() -> Unit)? = null,
    onFetch: ((assetId: String, contentHash: String) -> Unit)? = null,
) {
    val path = cell.thumbnail_path
    val label = cellLabel(cell, packAbsent = false)
    Box(
        modifier
            .size(width.dp, height.dp)
            // `--skel`, NEVER `--bg-elev`: an absence is not a card (§B), and
            // the ground is what shows before the bytes decode.
            .background(centraidColor("skel"))
            .combinedClickable(
                onClick = onTap,
                onLongClick = onLongPress,
                onClickLabel = if (selecting) "Select" else "Open",
            )
            .semantics {
                contentDescription = label
                role = Role.Image
                this.selected = selected
            },
    ) {
        if (!path.isNullOrEmpty()) ContentImage(path)
        if (selected) {
            // THE OUTLINE IS DRAWN INSIDE THE BOX: the gutter is 2 and an
            // overhang would paint over the neighbour's edge.
            Box(
                Modifier
                    .fillMaxSize()
                    .border(SELECTION_OUTLINE.dp, centraidColor("text")),
            )
        }
        HeldState(cell, onFetch)
        if (selecting || selected) SelectionDot(selected = selected)
        KindLine(cell, rung)
    }
}

/**
 * A GRID CELL IS AN IMAGE-ONLY CONTROL, so it carries a description even when
 * the image is missing — which is when it matters most. A video and a live
 * photograph say so, because that is what changes what a tap does.
 */
private fun cellLabel(cell: PhotoCell, packAbsent: Boolean): String {
    val noun = when {
        cell.live -> "Live photo"
        cell.kind == PhotoCell.Kind.KIND_VIDEO -> "Video"
        else -> "Photo"
    }
    return when {
        !cell.thumbnail_path.isNullOrEmpty() -> noun
        packAbsent -> "$noun, preview not downloaded to this device"
        else -> "$noun, preview no longer on this device"
    }
}

/**
 * The per-cell affordance, and nothing for the states that need none.
 *
 * **The download arrow is drawn ONLY for `HELD_WITHHELD_BY_RULE`.** A
 * photograph still on its way gets none — tapping it would ask for something
 * already queued — and `HELD_ORIGINAL` and `HELD_ABSENT` draw nothing at all.
 *
 * A FETCH IS A LINE AND NOT A SPINNER (DESIGN.md: loading is determinate or
 * static, never a spinner). The byte plane reports completion and not progress
 * (`PhotoCell.fetch_percent`), so the honest mark is words on the tile's own
 * chip — v0's state slot, which is one quiet mono line on the page colour.
 */
@Composable
private fun BoxScope.HeldState(
    cell: PhotoCell,
    onFetch: ((String, String) -> Unit)?,
) {
    val corner = Modifier.align(Alignment.BottomStart).padding(4.dp)
    when {
        cell.held == PhotoCell.Held.HELD_FETCHING ->
            Text(
                text = "downloading",
                style = centraidType("mono"),
                color = centraidColor("textFaint"),
                maxLines = 1,
                modifier = corner
                    .clip(RoundedCornerShape(RADIUS_SM.dp))
                    .background(centraidColor("bg"))
                    .padding(horizontal = 3.dp, vertical = 1.dp)
                    .semantics { contentDescription = "Downloading" },
            )

        cell.held == PhotoCell.Held.HELD_WITHHELD_BY_RULE &&
            cell.original_hash.isNotEmpty() &&
            onFetch != null ->
            // A 44 TARGET AROUND A SMALL CHIP: the mark is the tile's size, the
            // press is a thumb's.
            Box(
                Modifier
                    .align(Alignment.BottomStart)
                    .size(TARGET_MIN.dp)
                    .clickable(onClickLabel = "Download full-size photo") {
                        onFetch(cell.asset_id, cell.original_hash)
                    }
                    .semantics { contentDescription = "Download full-size photo" },
                contentAlignment = Alignment.BottomStart,
            ) {
                Box(
                    Modifier
                        .padding(4.dp)
                        .clip(RoundedCornerShape(RADIUS_SM.dp))
                        .background(centraidColor("bg"))
                        .padding(3.dp),
                ) {
                    CentraidIcon(iconKey = "Download", tint = centraidColor("text"), size = 14.dp)
                }
            }
    }
}

/**
 * SLOT 1 — SELECTION (v0's `tile-overlays.ts`): a 20 circle, top-trailing, 6
 * in. Selecting and not picked is an outline in the stage's ink; picked is a
 * filled ink circle with the inverse tick. INK, never a hue: DESIGN.md keeps
 * colour off controls, and a picked photograph is a control's state.
 */
@Composable
private fun BoxScope.SelectionDot(selected: Boolean, muted: Boolean = false) {
    val ink = if (muted) centraidColor("textSoft") else centraidColor("text")
    Box(
        Modifier
            .align(Alignment.TopEnd)
            .padding(SELECTION_INSET.dp)
            .size(SELECTION_DOT.dp)
            .clip(CircleShape)
            .then(
                if (selected) {
                    Modifier.background(ink).border(1.5.dp, ink, CircleShape)
                } else {
                    Modifier.border(1.5.dp, centraidColor("onStage"), CircleShape)
                },
            ),
        contentAlignment = Alignment.Center,
    ) {
        if (selected) CentraidIcon(iconKey = "Check", tint = centraidColor("textInv"), size = 13.dp)
    }
}

/**
 * SLOT 3 — KIND (v0's `kindOverlay`): a video's length or `live`, in mono,
 * bottom-trailing, from rung S up — below it the type would have to shrink
 * past legibility, and DESIGN.md puts the floor there rather than shrinking it.
 * A video whose length the vault does not know still says it is a video,
 * with the catalog's play mark, because that is what changes what a tap does.
 */
@Composable
private fun BoxScope.KindLine(cell: PhotoCell, rung: Int) {
    if (rung < TILE_KIND_MIN_RUNG) return
    val text = when {
        cell.live -> "live"
        cell.kind == PhotoCell.Kind.KIND_VIDEO && cell.duration_seconds > 0 ->
            mediaClock(cell.duration_seconds)
        else -> null
    }
    val corner = Modifier.align(Alignment.BottomEnd).padding(horizontal = 5.dp, vertical = 4.dp)
    if (text != null) {
        Text(
            text = text,
            // THE STAGE'S OWN INK OVER AN UNPREDICTABLE PHOTOGRAPH needs a
            // carrier; a text shadow is the one that costs no container.
            style = centraidType("mono").copy(
                shadow = Shadow(color = centraidColor("stage"), blurRadius = 6f),
            ),
            color = centraidColor("onStage"),
            maxLines = 1,
            modifier = corner,
        )
    } else if (cell.kind == PhotoCell.Kind.KIND_VIDEO) {
        CentraidIcon(iconKey = "Play", tint = centraidColor("onStage"), size = 14.dp, modifier = corner)
    }
}

/**
 * `1:04`, `12:07`, `1:02:03` — v0's `mediaClock`, so a tile and a viewer
 * transport state one recording's length the same way.
 */
public fun mediaClock(seconds: Int): String {
    val hours = seconds / 3_600
    val minutes = (seconds % 3_600) / 60
    val rest = seconds % 60
    return if (hours > 0) {
        "$hours:" + minutes.toString().padStart(2, '0') + ":" + rest.toString().padStart(2, '0')
    } else {
        "$minutes:" + rest.toString().padStart(2, '0')
    }
}

/** A tile's packed box: the cell, and where [justify] put its edges. */
public data class JustifiedTile(val cell: PhotoCell, val width: Int, val height: Int)

/**
 * JUSTIFIED ROWS FROM REAL ASPECT RATIOS (v0's `justify.ts`, §4.1).
 *
 * Rows pack to a target height and scale to fill the width exactly; nothing
 * crops to a square and nothing reflows when bytes land. The constants are
 * v0's and must stay equal to the SwiftUI twin's: a 2 gutter, a 28% overshoot
 * before a row closes, and a trailing partial row kept at natural height
 * capped at 1.25× so one wide photograph cannot become a banner. A full row's
 * rounding remainder folds into its LAST tile so the row fills the width to
 * the point; the trailing row deliberately does not.
 */
public fun justify(cells: List<PhotoCell>, containerWidth: Int, targetHeight: Int): List<List<JustifiedTile>> {
    if (containerWidth <= 0 || targetHeight <= 0) return emptyList()
    val rows = mutableListOf<List<JustifiedTile>>()
    val row = mutableListOf<Pair<PhotoCell, Double>>()
    var sum = 0.0
    for (cell in cells) {
        val ratio = aspectRatio(cell)
        row += cell to ratio
        sum += ratio
        val threshold = containerWidth - GAP * (row.size - 1) + targetHeight * OVERSHOOT
        if (sum * targetHeight >= threshold) {
            val height = ((containerWidth - GAP * (row.size - 1)) / sum).roundToInt()
            val widths = row.map { (height * it.second).roundToInt() }.toMutableList()
            val available = containerWidth - GAP * (row.size - 1)
            widths[widths.lastIndex] = widths.last() + (available - widths.sum())
            rows += row.mapIndexed { index, (packed, _) -> JustifiedTile(packed, widths[index], height) }
            row.clear()
            sum = 0.0
        }
    }
    if (row.isNotEmpty()) {
        val natural = (containerWidth - GAP * (row.size - 1)) / sum
        val height = minOf(targetHeight * LAST_ROW_CAP, natural)
        rows += row.map { (packed, ratio) ->
            JustifiedTile(packed, (height * ratio).roundToInt(), height.roundToInt())
        }
    }
    return rows
}

/**
 * The real aspect ratio; an unknown box packs SQUARE — a missing record is
 * the one case there is nothing to be faithful to.
 */
private fun aspectRatio(cell: PhotoCell): Double =
    if (cell.width > 0 && cell.height > 0) cell.width.toDouble() / cell.height.toDouble() else 1.0

/**
 * THE GRID IS THE LOADING STATE (v0's `PhotosGridSkeleton.tsx`, §14).
 *
 * Skeleton tiles at the rung's own geometry, packed by the same [justify], so
 * the photographs land where their placeholders stood. The aspect sequence is
 * FIXED — random aspects would flicker — and nothing moves: DESIGN.md's
 * `Loading` is static skeletons, and a shimmer is attention-seeking about work
 * the product can simply describe.
 */
@Composable
public fun PhotoGridSkeleton(containerWidth: Int, targetHeight: Int, viewportHeight: Int, modifier: Modifier = Modifier) {
    // BOTH HALVES ROUND UP: too few reads as "the library ends here".
    val perRow = maxOf(1, containerWidth / maxOf(1, targetHeight)) + 1
    val rowCount = maxOf(1, viewportHeight / maxOf(1, targetHeight) + 1)
    val placeholders = List(perRow * rowCount) { index ->
        val aspect = SKELETON_ASPECTS[index % SKELETON_ASPECTS.size]
        PhotoCell(asset_id = "skeleton-$index", width = (1000 * aspect).roundToInt(), height = 1000)
    }
    val rows = justify(placeholders, containerWidth, targetHeight)
    Column(
        modifier.semantics { contentDescription = "Opening your library" },
        verticalArrangement = Arrangement.spacedBy(GAP.dp),
    ) {
        rows.forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(GAP.dp)) {
                row.forEach { tile ->
                    Box(
                        Modifier
                            .size(tile.width.dp, tile.height.dp)
                            .clip(RoundedCornerShape(RADIUS_SM.dp))
                            .background(centraidColor("skel")),
                    )
                }
            }
        }
    }
}

/** v0's `SKELETON_ASPECTS`, in order. */
private val SKELETON_ASPECTS: List<Double> =
    listOf(1.5, 1.0, 4.0 / 3, 0.75, 1.5, 16.0 / 9, 1.0, 2.0 / 3, 4.0 / 3, 1.0, 1.5, 0.75)

/** The gutter between tiles, both axes — the 4 base rung halved. */
public const val GAP: Int = 2
private const val OVERSHOOT: Double = 0.28
private const val LAST_ROW_CAP: Double = 1.25

/** v0's `KIND_MIN_RUNG`: S. */
private const val TILE_KIND_MIN_RUNG: Int = 1
private const val SELECTION_DOT: Int = 20
private const val SELECTION_INSET: Int = 6
private const val SELECTION_OUTLINE: Int = 2

/** The `sm` radius rung. */
private const val RADIUS_SM: Int = 4

/** `TARGET_MIN_COARSE`: a thumb's press. */
private const val TARGET_MIN: Int = 44

/**
 * THE THREE-STATE READ LAW, DRAWN ONCE.
 *
 * Every screen in this app has the same three shapes and the same two lines for
 * a failure, and a per-screen copy is a per-screen chance to leave the remedy
 * out — which is the half of a refusal a member can act on.
 */
@Composable
public fun ScreenFailure(sentence: String, remedy: String, modifier: Modifier = Modifier) {
    Column(modifier) {
        Text(text = sentence)
        if (remedy.isNotEmpty()) Text(text = remedy)
    }
}

/**
 * NOTHING HERE, AND WHY. An empty shelf is a screen with a sentence, never a
 * blank frame — and the sentence differs per shelf, so it is a parameter.
 */
@Composable
public fun ScreenEmpty(sentence: String, modifier: Modifier = Modifier, remedy: String = "") {
    Column(modifier.padding(vertical = 32.dp).fillMaxWidth()) {
        Text(text = sentence)
        if (remedy.isNotEmpty()) Text(text = remedy)
    }
}
