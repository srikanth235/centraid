package dev.centraid.android.room

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import centraid.core.v1.RoomCanvasEvent
import centraid.core.v1.RoomChange
import centraid.core.v1.RoomMediaKind
import centraid.core.v1.RoomPhotoGrid
import centraid.core.v1.RoomPhotoPaged
import centraid.core.v1.RoomPhotoSection
import centraid.core.v1.RoomPhotoTile
import centraid.core.v1.RoomPhotoTileKind
import centraid.core.v1.RoomPhotoViewer
import centraid.core.v1.RoomPhotoZoom
import centraid.core.v1.RoomPhotoZoomed
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.ContentImage
import dev.centraid.android.kit.IconKey
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitLink
import dev.centraid.android.kit.KitSegmented
import dev.centraid.android.kit.KitText
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.StageKey
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.appAccent
import dev.centraid.android.kit.kitCard
import dev.centraid.android.theme.centraidColor
import dev.centraid.design.CentraidScale
import java.io.File

private val GRID_GAP = 2.dp

@Composable
internal fun PhotoGridCanvas(
    grid: RoomPhotoGrid,
    onTap: (String) -> Unit,
    onChange: (RoomChange) -> Unit,
    onCanvas: (RoomCanvasEvent) -> Unit,
    modifier: Modifier = Modifier,
) {
    val viewer = grid.viewer
    if (viewer != null) {
        PhotoViewerCanvas(
            viewer = viewer,
            onTap = onTap,
            onChange = onChange,
            onCanvas = onCanvas,
            modifier = modifier,
        )
        return
    }

    val targetRowHeight = when (grid.zoom) {
        RoomPhotoZoom.ROOM_PHOTO_ZOOM_YEARS -> 84.dp
        RoomPhotoZoom.ROOM_PHOTO_ZOOM_MONTHS -> 112.dp
        else -> 140.dp
    }

    Column(
        modifier
            .fillMaxWidth()
            .testTag("canvas-photo-grid"),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        grid.sections.forEachIndexed { sIdx, section ->
            PhotoGridSectionView(
                section = section,
                sectionIndex = sIdx,
                targetRowHeight = targetRowHeight,
                onTap = onTap,
            )
        }

        if (grid.next_page_selector_id.isNotEmpty()) {
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                KitLink(
                    label = KitWords.SHOW_MORE,
                    onClick = { onTap(grid.next_page_selector_id) },
                    modifier = Modifier.testTag(grid.next_page_selector_id),
                )
            }
        }

        PhotoZoomBar(
            zoom = grid.zoom,
            onSelect = { chosen ->
                if (chosen != grid.zoom) {
                    onCanvas(
                        RoomCanvasEvent(
                            selector_id = "photo_grid",
                            photo_zoom = RoomPhotoZoomed(zoom = chosen),
                        ),
                    )
                }
            },
        )
    }
}

@Composable
private fun PhotoZoomBar(
    zoom: RoomPhotoZoom,
    onSelect: (RoomPhotoZoom) -> Unit,
) {
    val selectedKey = when (zoom) {
        RoomPhotoZoom.ROOM_PHOTO_ZOOM_YEARS -> "years"
        RoomPhotoZoom.ROOM_PHOTO_ZOOM_MONTHS -> "months"
        else -> "all"
    }
    Box(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp)
            .testTag("photo-zoom-bar"),
    ) {
        KitSegmented(
            options = listOf(
                "years" to "Years",
                "months" to "Months",
                "all" to "All",
            ),
            selected = selectedKey,
            onSelect = { key ->
                val mapped = when (key) {
                    "years" -> RoomPhotoZoom.ROOM_PHOTO_ZOOM_YEARS
                    "months" -> RoomPhotoZoom.ROOM_PHOTO_ZOOM_MONTHS
                    else -> RoomPhotoZoom.ROOM_PHOTO_ZOOM_ALL
                }
                onSelect(mapped)
            },
        )
    }
}

@Composable
private fun PhotoGridSectionView(
    section: RoomPhotoSection,
    sectionIndex: Int,
    targetRowHeight: Dp,
    onTap: (String) -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .testTag("photo-section-$sectionIndex"),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (section.heading.isNotEmpty()) {
            KitText(
                text = section.heading,
                rung = KitType.Group,
                color = Surface.meta,
                modifier = Modifier
                    .padding(horizontal = KitGeometry.GUTTER)
                    .semantics { heading() },
            )
        }
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val containerWidth = maxWidth
            val rows = remember(section.tiles, containerWidth, targetRowHeight) {
                packJustifiedRows(
                    tiles = section.tiles,
                    containerWidthDp = containerWidth.value,
                    targetRowHeightDp = targetRowHeight.value,
                    gapDp = GRID_GAP.value,
                )
            }
            Column(
                Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(GRID_GAP),
            ) {
                rows.forEach { row ->
                    Row(
                        Modifier.fillMaxWidth().height(row.heightDp.dp),
                        horizontalArrangement = Arrangement.spacedBy(GRID_GAP),
                    ) {
                        row.cells.forEach { cell ->
                            PhotoTileCell(
                                tile = cell.tile,
                                onTap = onTap,
                                modifier = Modifier
                                    .width(cell.widthDp.dp)
                                    .height(row.heightDp.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PhotoTileCell(
    tile: RoomPhotoTile,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val accent = appAccent("photos")
    val tint = resolveCanvasHueColor(tile.thumb?.hue_key.orEmpty(), Surface.fill)
    val ref = tile.thumb?.ref.orEmpty()
    val hasLocalFile = remember(ref) { ref.isNotEmpty() && File(ref).isFile }
    val scrim = centraidColor("stage").copy(alpha = 0.72f)
    val spoken = tile.a11y_label.ifEmpty { tile.thumb?.alt.orEmpty() }

    Box(
        modifier
            .background(tint.copy(alpha = 0.28f))
            .clickable(enabled = tile.selector_id.isNotEmpty()) { onTap(tile.selector_id) }
            .testTag(tile.selector_id.ifEmpty { "photo-tile" })
            .semantics(mergeDescendants = true) {
                role = Role.Button
                selected = tile.selected
                if (spoken.isNotEmpty()) contentDescription = spoken
            },
        contentAlignment = Alignment.Center,
    ) {
        if (hasLocalFile) {
            ContentImage(ref)
        } else {
            val icon = when (tile.kind) {
                RoomPhotoTileKind.ROOM_PHOTO_TILE_KIND_VIDEO -> "Play"
                RoomPhotoTileKind.ROOM_PHOTO_TILE_KIND_SCAN -> "FileText"
                else -> "Image"
            }
            CentraidIcon(iconKey = icon, tint = tint, size = 24.dp)
        }

        if (tile.kind == RoomPhotoTileKind.ROOM_PHOTO_TILE_KIND_VIDEO && tile.duration_label.isNotEmpty()) {
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .padding(6.dp)
                    .clip(RoundedCornerShape(6.dp))
                    .background(scrim)
                    .padding(horizontal = 6.dp, vertical = 2.dp),
            ) {
                KitText(tile.duration_label, KitType.Badge, Color.White)
            }
        }

        if (tile.starred) {
            Box(
                Modifier
                    .align(Alignment.BottomStart)
                    .padding(6.dp)
                    .size(22.dp)
                    .clip(CircleShape)
                    .background(scrim)
                    .testTag("${tile.selector_id}-starred"),
                contentAlignment = Alignment.Center,
            ) {
                CentraidIcon("Star", tint = Color.White, size = 12.dp, solid = true)
            }
        }

        if (tile.selected) {
            Box(
                Modifier
                    .align(Alignment.TopEnd)
                    .padding(6.dp)
                    .size(24.dp)
                    .clip(CircleShape)
                    .background(accent.fill)
                    .border(1.5.dp, Color.White, CircleShape)
                    .testTag("${tile.selector_id}-selected"),
                contentAlignment = Alignment.Center,
            ) {
                CentraidIcon("Check", tint = Color.White, size = 13.dp)
            }
        }
    }
}

@Composable
private fun PhotoViewerCanvas(
    viewer: RoomPhotoViewer,
    onTap: (String) -> Unit,
    onChange: (RoomChange) -> Unit,
    onCanvas: (RoomCanvasEvent) -> Unit,
    modifier: Modifier = Modifier,
) {
    val viewerSelectorId = viewer.tile_selector_id.ifEmpty { "photo_grid" }
    var detailsOpen by remember(viewerSelectorId, viewer.details_open) { mutableStateOf(viewer.details_open) }
    var menuOpen by remember(viewerSelectorId) { mutableStateOf(false) }
    var scale by remember(viewerSelectorId, viewer.index) { mutableFloatStateOf(1f) }
    var pan by remember(viewerSelectorId, viewer.index) { mutableStateOf(Offset.Zero) }

    val pageTo: (Int) -> Unit = { target ->
        if (viewer.count > 0 && target in 0 until viewer.count && target != viewer.index) {
            onCanvas(
                RoomCanvasEvent(
                    selector_id = viewerSelectorId,
                    photo_page = RoomPhotoPaged(index = target),
                ),
            )
        }
    }

    val ground = if (viewer.slideshow) centraidColor("stage") else Surface.page
    val fg = if (viewer.slideshow) Color.White else Surface.ink
    val current = viewer.current
    val ratio = ((current?.aspect_milli?.takeIf { it > 0 } ?: 1333) / 1000f).coerceIn(0.6f, 2.2f)
    val ref = current?.thumb?.ref.orEmpty()
    val hasFile = remember(ref) { ref.isNotEmpty() && File(ref).isFile }
    val mediaTint = resolveCanvasHueColor(current?.thumb?.hue_key.orEmpty(), Surface.fill)

    Column(
        modifier
            .fillMaxWidth()
            .background(ground)
            .testTag(if (viewer.slideshow) "photo-viewer-slideshow" else "photo-viewer"),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (viewer.slideshow) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                if (viewer.count > 0) {
                    KitText("${viewer.index + 1} / ${viewer.count}", KitType.Meta, Color.White)
                } else {
                    Spacer(Modifier.width(1.dp))
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (viewer.index > 0) {
                        StageKey("ChevronLeft", "Previous photo", onClick = { pageTo(viewer.index - 1) })
                    }
                    if (viewer.count > 0 && viewer.index + 1 < viewer.count) {
                        StageKey("ChevronRight", "Next photo", onClick = { pageTo(viewer.index + 1) })
                    }
                }
            }
        } else {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                KitText(
                    text = if (viewer.count > 0) "${viewer.index + 1} of ${viewer.count}" else "",
                    rung = KitType.Meta,
                    color = Surface.meta,
                    modifier = Modifier.testTag("photo-viewer-counter"),
                )
                Row(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (viewer.index > 0) {
                        IconKey(
                            iconKey = "ChevronLeft",
                            label = "Previous photo",
                            testTag = "photo-viewer-prev",
                            bordered = false,
                            onPress = { pageTo(viewer.index - 1) },
                        )
                    }
                    if (viewer.count > 0 && viewer.index + 1 < viewer.count) {
                        IconKey(
                            iconKey = "ChevronRight",
                            label = "Next photo",
                            testTag = "photo-viewer-next",
                            bordered = false,
                            onPress = { pageTo(viewer.index + 1) },
                        )
                    }
                    if (viewer.details.isNotEmpty()) {
                        IconKey(
                            iconKey = "Info",
                            label = KitWords.DETAILS,
                            testTag = "photo-viewer-info",
                            bordered = false,
                            onPress = { detailsOpen = !detailsOpen },
                        )
                    }
                    viewer.menu?.let { menu ->
                        Box {
                            IconKey(
                                iconKey = "MoreHoriz",
                                label = KitWords.BAND_MORE,
                                testTag = menu.selector_id.ifEmpty { "photo-viewer-menu" },
                                bordered = false,
                                onPress = { menuOpen = true },
                            )
                            RoomDropdownMenu(
                                menu = menu,
                                expanded = menuOpen,
                                onDismiss = { menuOpen = false },
                                onTap = { id ->
                                    menuOpen = false
                                    onTap(id)
                                },
                            )
                        }
                    }
                }
            }
        }

        Box(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = if (viewer.slideshow) 0.dp else KitGeometry.GUTTER)
                .then(
                    if (detailsOpen) {
                        Modifier.height(220.dp)
                    } else {
                        Modifier.aspectRatio(ratio)
                    },
                )
                .clip(RoundedCornerShape(if (viewer.slideshow) 0.dp else CentraidScale.cardRadius.dp))
                .background(mediaTint.copy(alpha = 0.25f))
                .pointerInput(viewerSelectorId, viewer.index) {
                    detectTapGestures(
                        onDoubleTap = {
                            if (scale > 1.05f) {
                                scale = 1f
                                pan = Offset.Zero
                            } else {
                                scale = 2.2f
                            }
                        },
                    )
                }
                .pointerInput(viewerSelectorId, viewer.index) {
                    detectTransformGestures { _, panChange, zoomChange, _ ->
                        val nextScale = (scale * zoomChange).coerceIn(1f, 4f)
                        scale = nextScale
                        pan = if (nextScale > 1.02f) pan + panChange else Offset.Zero
                    }
                }
                .pointerInput(viewerSelectorId, viewer.index, viewer.count) {
                    var dragX = 0f
                    detectHorizontalDragGestures(
                        onDragStart = { dragX = 0f },
                        onDragEnd = {
                            if (scale <= 1.02f) {
                                if (dragX < -80f) pageTo(viewer.index + 1)
                                else if (dragX > 80f) pageTo(viewer.index - 1)
                            }
                            dragX = 0f
                        },
                        onHorizontalDrag = { _, delta -> dragX += delta },
                    )
                }
                .pointerInput(viewerSelectorId, detailsOpen, viewer.details.size) {
                    var dragY = 0f
                    detectVerticalDragGestures(
                        onDragStart = { dragY = 0f },
                        onDragEnd = {
                            if (!viewer.slideshow && viewer.details.isNotEmpty()) {
                                if (dragY < -70f && !detailsOpen) detailsOpen = true
                                else if (dragY > 70f && detailsOpen) detailsOpen = false
                            }
                            dragY = 0f
                        },
                        onVerticalDrag = { _, delta -> dragY += delta },
                    )
                }
                .testTag("photo-viewer-stage"),
            contentAlignment = Alignment.Center,
        ) {
            Box(
                Modifier
                    .fillMaxSize()
                    .graphicsLayer(
                        scaleX = scale,
                        scaleY = scale,
                        translationX = pan.x,
                        translationY = pan.y,
                    ),
                contentAlignment = Alignment.Center,
            ) {
                if (hasFile) {
                    ContentImage(ref)
                } else {
                    val icon = when (current?.kind) {
                        RoomMediaKind.ROOM_MEDIA_KIND_VIDEO -> "Play"
                        RoomMediaKind.ROOM_MEDIA_KIND_SCAN, RoomMediaKind.ROOM_MEDIA_KIND_FILE -> "FileText"
                        else -> "Image"
                    }
                    CentraidIcon(iconKey = icon, tint = mediaTint, size = 48.dp)
                }
            }

            if (current != null && current.duration_label.isNotEmpty()) {
                Box(
                    Modifier
                        .align(Alignment.BottomEnd)
                        .padding(10.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .background(centraidColor("stage").copy(alpha = 0.72f))
                        .padding(horizontal = 8.dp, vertical = 3.dp),
                ) {
                    KitText(current.duration_label, KitType.Badge, Color.White)
                }
            }
        }

        if (current != null && current.caption.isNotEmpty()) {
            KitText(
                text = current.caption,
                rung = KitType.Meta,
                color = if (viewer.slideshow) fg.copy(alpha = 0.85f) else Surface.meta,
                modifier = Modifier.padding(horizontal = KitGeometry.GUTTER),
            )
        }

        if (!viewer.slideshow && detailsOpen && viewer.details.isNotEmpty()) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = KitGeometry.GUTTER)
                    .kitCard()
                    .padding(vertical = 8.dp)
                    .testTag("photo-viewer-details"),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                viewer.details.forEach { block ->
                    RoomBlockView(
                        block = block,
                        onTap = onTap,
                        onChange = onChange,
                        onCanvas = onCanvas,
                    )
                }
            }
        }
    }
}

private data class JustifiedCell(
    val tile: RoomPhotoTile,
    val widthDp: Float,
)

private data class JustifiedRow(
    val heightDp: Float,
    val cells: List<JustifiedCell>,
)

private fun packJustifiedRows(
    tiles: List<RoomPhotoTile>,
    containerWidthDp: Float,
    targetRowHeightDp: Float,
    gapDp: Float,
): List<JustifiedRow> {
    if (tiles.isEmpty() || containerWidthDp <= 0f) return emptyList()
    val rows = mutableListOf<JustifiedRow>()
    val current = mutableListOf<Pair<RoomPhotoTile, Float>>()
    var sumAspect = 0f

    fun flushRow(justify: Boolean) {
        if (current.isEmpty()) return
        val totalGap = gapDp * (current.size - 1)
        val availWidth = (containerWidthDp - totalGap).coerceAtLeast(1f)
        val rowHeight = if (justify && sumAspect > 0f) {
            (availWidth / sumAspect).coerceIn(targetRowHeightDp * 0.65f, targetRowHeightDp * 1.45f)
        } else {
            targetRowHeightDp
        }
        val cells = current.map { (tile, aspect) ->
            JustifiedCell(tile = tile, widthDp = (aspect * rowHeight).coerceAtLeast(24f))
        }
        rows.add(JustifiedRow(heightDp = rowHeight, cells = cells))
        current.clear()
        sumAspect = 0f
    }

    tiles.forEach { tile ->
        val aspect = ((tile.aspect_milli.takeIf { it > 0 } ?: 1000) / 1000f).coerceIn(0.45f, 2.5f)
        current.add(tile to aspect)
        sumAspect += aspect
        val totalGap = gapDp * (current.size - 1)
        val idealWidth = sumAspect * targetRowHeightDp + totalGap
        if (idealWidth >= containerWidthDp) {
            flushRow(justify = true)
        }
    }
    flushRow(justify = false)
    return rows
}
