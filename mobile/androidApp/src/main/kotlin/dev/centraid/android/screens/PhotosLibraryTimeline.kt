package dev.centraid.android.screens

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import centraid.screen.v1.PhotoCell
import centraid.screen.v1.PhotosGridState
import dev.centraid.android.kit.ContentImage
import dev.centraid.android.kit.GAP
import dev.centraid.android.kit.JustifiedTile
import dev.centraid.android.kit.PhotoTile
import dev.centraid.android.kit.bandPress
import dev.centraid.android.theme.LocalCentraidTokens
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidGeometry
import dev.centraid.design.copy.PhotosCopy
import dev.centraid.shared.apps.photos.GrainItem
import dev.centraid.shared.apps.photos.LibraryCell
import dev.centraid.shared.apps.photos.LibraryPeriod
import dev.centraid.shared.apps.photos.LibraryTitles
import dev.centraid.shared.apps.photos.PhotosLibraryLayout
import dev.centraid.shared.apps.photos.PhotosTimeline
import dev.centraid.shared.apps.photos.TimelineRowKind
import dev.centraid.shared.shell.BandPolicy
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/*
 * THE LIBRARY'S DRAWING, IN COMPOSE (#1029, photos port — v0's
 * `PhotoTimeline.tsx`, `PhotoGrainView.tsx`, `ScrubRail.tsx`,
 * `TimelineGrainControl.tsx` and `timeline-rows.ts`).
 *
 * What is drawn here is arithmetic over a width only the shell knows: where a
 * header sits, which tile is under a finger. WHICH ROWS THE CELLS PACK INTO,
 * where a month or a day header goes, which cards a grain draws and how the
 * months pair are not this file's: they are `PhotosLibraryLayout` and
 * `PhotoJustify` in `commonMain`, so the SwiftUI twin in `PhotosLibraryView.swift`
 * draws the same library from the same rules. What a day IS, which grain comes
 * next and what a pick means are the machine's (`PhotosGridMachine`,
 * `PhotosTimeline`). Only the date's spelling in the device's locale stays
 * here, because only the platform knows it ([DeviceLibraryTitles]).
 */

/** One row of the All grain, keyed so a recomposition keeps its place. */
internal sealed interface LibraryRow {
    val key: String

    /** The month's name and nothing else — no tally (#712). Sticky. */
    data class Month(override val key: String, val title: String, val day: String) : LibraryRow

    /** A day's header. Selecting, it carries the day's "Select". */
    data class Day(override val key: String, val day: String, val title: String, val ids: List<String>) : LibraryRow

    /** One justified row of tiles. */
    data class Tiles(override val key: String, val day: String, val tiles: List<JustifiedTile>) : LibraryRow
}

/**
 * THE SHELL'S SIDE OF THE LIBRARY'S ROWS: copy the cells into shared's
 * [LibraryCell], ask [PhotosLibraryLayout.rows], and put the cell back under
 * each tile it names. Nothing is decided here.
 */
internal fun libraryRows(cells: List<PhotoCell>, width: Int, rung: Int, currentYear: Int): List<LibraryRow> =
    PhotosLibraryLayout.rows(libraryCells(cells), width.toDouble(), rung, currentYear, DeviceLibraryTitles).map { row ->
        when (row.kind) {
            TimelineRowKind.MONTH -> LibraryRow.Month(row.id, row.title, row.day)
            TimelineRowKind.DAY -> LibraryRow.Day(row.id, row.day, row.title, row.ids)
            TimelineRowKind.TILES -> LibraryRow.Tiles(
                row.id,
                row.day,
                row.tiles.map { JustifiedTile(cells[it.index], it.width.toInt(), it.height.toInt()) },
            )
        }
    }

/** The five fields the layout reads of a cell. */
private fun libraryCells(cells: List<PhotoCell>): List<LibraryCell> = cells.map {
    LibraryCell(
        assetId = it.asset_id,
        day = it.day,
        video = it.kind == PhotoCell.Kind.KIND_VIDEO,
        thumbnailPath = it.thumbnail_path.orEmpty(),
        width = it.width,
        height = it.height,
    )
}

/** The day a row belongs to, for landing a grain switch where the member was. */
internal fun dayOfRow(row: LibraryRow?): String = when (row) {
    is LibraryRow.Month -> row.day
    is LibraryRow.Day -> row.day
    is LibraryRow.Tiles -> row.day
    null -> ""
}

/**
 * THE ALL GRAIN: the justified timeline.
 *
 * One `LazyColumn`, with [top] as its first item so the backup banner scrolls
 * with the photographs rather than pinning above them. Month headers stick.
 *
 * ## The gestures, and why they are shaped this way
 *
 * * A TAP is the tile's own — it opens, or while selecting it toggles.
 * * A LONG PRESS picks the tile under it and enters the mode, and a DRAG that
 *   continues it sweeps every tile it crosses into the selection (v0's
 *   `activateAfterLongPress(220)` pan, Apple Photos' swipe-select). A sweep
 *   adds and never toggles, so a finger that crosses a tile twice does not
 *   undo it. Scrolling is switched off for the length of a sweep, or the list
 *   would take the finger back.
 * * A PINCH is a stepper press, never a continuous zoom (v0 §4.2), and it only
 *   answers two fingers, so a one-finger scroll is never mistaken for one.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun LibraryTimeline(
    rows: List<LibraryRow>,
    rung: Int,
    selecting: Boolean,
    selected: Set<String>,
    complete: Boolean,
    cellCount: Int,
    listState: LazyListState,
    top: @Composable () -> Unit,
    onTile: (String) -> Unit,
    onPick: (List<String>, Boolean) -> Unit,
    onFetch: (String, String) -> Unit,
    onMore: () -> Unit,
    onPinch: (Float) -> Unit,
) {
    var sweeping by remember { mutableStateOf(false) }
    val density = LocalDensity.current
    val currentRows by rememberUpdatedState(rows)
    val pick by rememberUpdatedState(onPick)
    val pinch by rememberUpdatedState(onPinch)
    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            state = listState,
            userScrollEnabled = !sweeping,
            modifier = Modifier
                .fillMaxSize()
                .pointerInput(Unit) {
                    // THE SWEEP RUNS ON THE INITIAL PASS, ahead of the tiles and
                    // the scroller: once the press has held, every move and the
                    // release are consumed here, so the list does not scroll
                    // under the finger and the tile it lifts from does not read
                    // the release as a tap and undo its own pick.
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                        val ended = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) {
                            while (true) {
                                val change = awaitPointerEvent(PointerEventPass.Initial)
                                    .changes.firstOrNull { it.id == down.id } ?: return@withTimeoutOrNull true
                                if (!change.pressed) return@withTimeoutOrNull true
                                if ((change.position - down.position).getDistance() > viewConfiguration.touchSlop) {
                                    return@withTimeoutOrNull true
                                }
                            }
                            @Suppress("UNREACHABLE_CODE")
                            true
                        }
                        // A TAP OR A SCROLL: the press never held still long enough.
                        if (ended != null) return@awaitEachGesture
                        sweeping = true
                        tileAt(listState, currentRows, down.position.x, down.position.y, density.density)
                            ?.let { pick(listOf(it), true) }
                        while (true) {
                            val change = awaitPointerEvent(PointerEventPass.Initial)
                                .changes.firstOrNull { it.id == down.id } ?: break
                            change.consume()
                            if (!change.pressed) break
                            tileAt(listState, currentRows, change.position.x, change.position.y, density.density)
                                ?.let { pick(listOf(it), true) }
                        }
                        sweeping = false
                    }
                }
                .pointerInput(Unit) {
                    awaitEachGesture {
                        awaitFirstDown(requireUnconsumed = false)
                        var zoom = 1f
                        var pinching = false
                        do {
                            val event = awaitPointerEvent()
                            if (event.changes.count { it.pressed } >= 2) {
                                pinching = true
                                zoom *= event.calculateZoom()
                                event.changes.forEach { if (it.positionChanged()) it.consume() }
                            }
                        } while (event.changes.any { it.pressed })
                        if (pinching) pinch(zoom)
                    }
                },
        ) {
            item(key = "top") { Column { top() } }
            rows.forEach { row ->
                when (row) {
                    is LibraryRow.Month -> stickyHeader(key = row.key) { MonthHeader(row.title) }
                    is LibraryRow.Day -> item(key = row.key) {
                        DayHeader(
                            title = row.title,
                            selecting = selecting,
                            allPicked = row.ids.all { it in selected },
                            onPickDay = { picked -> onPick(row.ids, picked) },
                        )
                    }
                    is LibraryRow.Tiles -> item(key = row.key) {
                        Row(
                            Modifier.padding(bottom = GAP.dp),
                            horizontalArrangement = Arrangement.spacedBy(GAP.dp),
                        ) {
                            row.tiles.forEach { tile ->
                                val id = tile.cell.asset_id
                                PhotoTile(
                                    cell = tile.cell,
                                    width = tile.width,
                                    height = tile.height,
                                    rung = rung,
                                    selecting = selecting,
                                    selected = id in selected,
                                    onTap = { onTile(id) },
                                    // THE LONG PRESS IS THE LIST'S, not the tile's:
                                    // see the sweep above.
                                    onLongPress = null,
                                    onFetch = onFetch,
                                )
                            }
                        }
                    }
                }
            }
            item(key = "more") { MoreSentinel(complete, cellCount, onMore) }
        }
        ScrubRail(listState = listState, rows = rows)
    }
}

/**
 * THE NEXT PAGE IS ASKED FOR WHEN THE END IS ON SCREEN — and asked again each
 * time a page lands while it still is, which is what `cellCount` keys: a
 * member at the foot of a library of short days pages on without lifting a
 * finger. The machine keeps one read in flight, so an ask it cannot serve yet
 * is simply dropped.
 */
@Composable
private fun MoreSentinel(complete: Boolean, cellCount: Int, onMore: () -> Unit) {
    if (complete) {
        Spacer(Modifier.height(GAP.dp))
        return
    }
    LaunchedEffect(cellCount) { onMore() }
    // A STATIC ROW OF GROUND, never a spinner: more photographs are coming
    // and this is where they will stand.
    Box(
        Modifier
            .fillMaxWidth()
            .height(PhotosTimeline.RUNG_HEIGHTS[0].dp)
            .background(centraidColor("skel"))
            .semantics { contentDescription = PhotosCopy.PHOTOS_LIBRARY_LOADING_MORE },
    )
}

@Composable
private fun MonthHeader(title: String) {
    Box(
        Modifier
            .fillMaxWidth()
            .background(centraidColor("bg"))
            .height(MONTH_ROW_HEIGHT.dp)
            .padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp)
            .padding(top = 12.dp),
    ) {
        Text(
            text = title,
            style = centraidType("eyebrow"),
            color = centraidColor("text"),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.semantics { heading() },
        )
    }
}

/**
 * A DAY'S HEADER. Selecting, it offers the whole day at once — v0's "Select
 * day", and Apple Photos' per-day Select — and says "Deselect" once every
 * photograph under it is picked.
 */
@Composable
private fun DayHeader(title: String, selecting: Boolean, allPicked: Boolean, onPickDay: (Boolean) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = DAY_ROW_HEIGHT.dp)
            .padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = title,
            style = centraidType("small"),
            color = centraidColor("textSoft"),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f).semantics { heading() },
        )
        if (selecting) {
            val label = if (allPicked) PhotosCopy.PHOTOS_DESELECT else PhotosCopy.PHOTOS_SELECT
            val said = (if (allPicked) PhotosCopy.PHOTOS_DESELECT_DAY else PhotosCopy.PHOTOS_SELECT_DAY).replace("{title}", title)
            Box(
                Modifier
                    .heightIn(min = CentraidGeometry.TARGET_MIN_COARSE.dp)
                    .clickable(onClickLabel = said) { onPickDay(!allPicked) }
                    .semantics {
                        role = Role.Button
                        contentDescription = said
                    },
                contentAlignment = Alignment.CenterEnd,
            ) {
                Text(text = label, style = centraidType("control"), color = centraidColor("text"))
            }
        }
    }
}

/**
 * THE TILE UNDER A POINT, for a sweep. The row from the list's own layout,
 * the tile by walking the row's widths — the same widths [justify] gave it.
 * Rows are full-bleed, so `x` is already row-relative.
 */
private fun tileAt(state: LazyListState, rows: List<LibraryRow>, x: Float, y: Float, density: Float): String? {
    val item = state.layoutInfo.visibleItemsInfo.firstOrNull { y >= it.offset && y < it.offset + it.size }
        ?: return null
    val row = rows.firstOrNull { it.key == item.key } as? LibraryRow.Tiles ?: return null
    var left = 0f
    row.tiles.forEach { tile ->
        val right = left + tile.width * density
        if (x < right) return tile.cell.asset_id
        left = right + GAP * density
    }
    return row.tiles.lastOrNull()?.cell?.asset_id
}

/**
 * THE SCRUB RAIL (v0's `ScrubRail.tsx`, §4.5): month-labelled, on the grid's
 * trailing edge, and hit-testable ONLY UNDER ITS THUMB, so the tiles beneath
 * the rest of the edge stay tappable. The thumb stands where the list is; a
 * drag moves the list, and the month under it rides a bubble beside the thumb
 * for as long as the finger is down. For a screen reader it is an adjustable
 * control stepping a month at a time.
 */
@Composable
private fun ScrubRail(listState: LazyListState, rows: List<LibraryRow>) {
    if (rows.size < RAIL_MIN_ROWS) return
    val scope = rememberCoroutineScope()
    val total = rows.size
    val months = remember(rows) { rows.withIndex().filter { it.value is LibraryRow.Month } }
    // The list's item 0 is the top slot, so a row's item is its index + 1.
    val position = ((listState.firstVisibleItemIndex - 1).coerceAtLeast(0).toFloat() / (total - 1).coerceAtLeast(1))
        .coerceIn(0f, 1f)
    var dragging by remember { mutableStateOf(false) }
    var fraction by remember { mutableFloatStateOf(0f) }
    var label by remember { mutableStateOf("") }
    val shown = if (dragging) fraction else position
    fun monthAt(index: Int): String =
        (months.lastOrNull { it.index <= index }?.value as? LibraryRow.Month)?.title ?: ""
    fun scrubTo(target: Float) {
        fraction = target.coerceIn(0f, 1f)
        val index = (fraction * (total - 1)).roundToInt()
        label = monthAt(index)
        scope.launch { listState.scrollToItem(index + 1) }
    }
    // THE WHOLE EDGE IS THE RAIL'S BOX, AND ONLY THE THUMB TAKES A TOUCH:
    // Compose hit-tests pointer input and nothing else, so the tiles under the
    // rest of the edge stay tappable, and the bubble can stand beside the
    // thumb rather than being squeezed into its width.
    BoxWithConstraints(Modifier.fillMaxSize().padding(vertical = RAIL_TOP.dp)) {
        val track = maxHeight - THUMB_HEIGHT.dp
        val trackPx = with(LocalDensity.current) { track.toPx() }.coerceAtLeast(1f)
        val offset = with(LocalDensity.current) { (track * shown).roundToPx() }
        Box(
            Modifier
                .align(Alignment.TopEnd)
                .offset { IntOffset(0, offset) }
                .size(RAIL_WIDTH.dp, THUMB_HEIGHT.dp)
                .pointerInput(total) {
                    detectVerticalDragGestures(
                        onDragStart = {
                            dragging = true
                            fraction = position
                        },
                        onVerticalDrag = { change, dy ->
                            change.consume()
                            scrubTo(fraction + dy / trackPx)
                        },
                        onDragEnd = { dragging = false },
                        onDragCancel = { dragging = false },
                    )
                }
                .semantics {
                    contentDescription = PhotosCopy.PHOTOS_SCRUB
                    stateDescription = monthAt(((total - 1) * position).roundToInt())
                    customActions = listOf(
                        androidx.compose.ui.semantics.CustomAccessibilityAction(PhotosCopy.PHOTOS_SCRUB_NEXT) {
                            val here = ((total - 1) * position).roundToInt()
                            val next = months.firstOrNull { it.index > here } ?: return@CustomAccessibilityAction false
                            scope.launch { listState.scrollToItem(next.index + 1) }
                            true
                        },
                        androidx.compose.ui.semantics.CustomAccessibilityAction(PhotosCopy.PHOTOS_SCRUB_PREVIOUS) {
                            val here = ((total - 1) * position).roundToInt()
                            val previous = months.lastOrNull { it.index < here } ?: return@CustomAccessibilityAction false
                            scope.launch { listState.scrollToItem(previous.index + 1) }
                            true
                        },
                    )
                },
            contentAlignment = Alignment.CenterEnd,
        ) {
            // THE THUMB: a hairline-bordered pill on the elevated ground, the
            // band's grammar at a rail's size. Never glass over a photograph.
            Box(
                Modifier
                    .padding(end = 4.dp)
                    .size(6.dp, THUMB_HEIGHT.dp - 12.dp)
                    .clip(RoundedCornerShape(BandPolicy.BAND_RADIUS.dp))
                    .background(centraidColor("bgElev"))
                    .border(
                        CentraidGeometry.HAIRLINE.dp,
                        centraidColor("lineStrong"),
                        RoundedCornerShape(BandPolicy.BAND_RADIUS.dp),
                    ),
            )
        }
        if (dragging && label.isNotEmpty()) {
            // THE MONTH UNDER THE THUMB: page ink on the elevated ground, a
            // hairline, the pill rung — v0's bubble.
            Box(
                Modifier
                    .align(Alignment.TopEnd)
                    .offset { IntOffset(0, offset) }
                    .padding(end = (RAIL_WIDTH + 4).dp, top = 10.dp)
                    .clip(RoundedCornerShape(BandPolicy.BAND_RADIUS.dp))
                    .background(centraidColor("bgElev"))
                    .border(
                        CentraidGeometry.HAIRLINE.dp,
                        centraidColor("line"),
                        RoundedCornerShape(BandPolicy.BAND_RADIUS.dp),
                    )
                    .padding(horizontal = 12.dp, vertical = 4.dp),
            ) {
                Text(label, style = centraidType("mono"), color = centraidColor("text"), maxLines = 1)
            }
        }
    }
}

/**
 * THE YEARS AND MONTHS GRAINS (v0's `PhotoGrainView.tsx`).
 *
 * A card is a PERIOD: a tap goes one grain in at its first day, and never
 * selects — a period is not a photograph. A year is a chapter — full width,
 * its name on the cover over a scrim; a month is one of twelve — two to a row,
 * its name beneath. Year headers only when the library spans more than one
 * year. The periods are the same cells All draws, grouped by prefix, so the
 * grains cannot disagree about where a period starts; undated photographs are
 * in All only, because "sometime" is not a stretch of time.
 */
@Composable
internal fun LibraryGrains(
    cells: List<PhotoCell>,
    grain: PhotosGridState.Grain,
    placeDay: String,
    complete: Boolean,
    listState: LazyListState,
    top: @Composable () -> Unit,
    onOpenPeriod: (String) -> Unit,
    onMore: () -> Unit,
    onPinch: (Float) -> Unit,
) {
    val years = grain == PhotosGridState.Grain.GRAIN_YEARS
    val items = remember(cells, grain) { grainItemsOf(cells, years) }
    val pinch by rememberUpdatedState(onPinch)
    // LAND ON THE PERIOD THAT HOLDS THE DAY, once per distinct day, so a
    // member who scrolls away is not pulled back on the next recomposition.
    var landed by remember { mutableStateOf("") }
    LaunchedEffect(placeDay, items, grain) {
        if (placeDay.isEmpty() || placeDay == landed) return@LaunchedEffect
        val index = PhotosLibraryLayout.grainItemIndex(items, placeDay)
        if (index >= 0) {
            landed = placeDay
            listState.scrollToItem(index + 1)
        }
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val stage = maxWidth - (CentraidGeometry.PAGE_MARGIN * 2).dp
        LazyColumn(
            state = listState,
            modifier = Modifier
                .fillMaxSize()
                .pointerInput(Unit) {
                    awaitEachGesture {
                        awaitFirstDown(requireUnconsumed = false)
                        var zoom = 1f
                        var pinching = false
                        do {
                            val event = awaitPointerEvent()
                            if (event.changes.count { it.pressed } >= 2) {
                                pinching = true
                                zoom *= event.calculateZoom()
                                event.changes.forEach { if (it.positionChanged()) it.consume() }
                            }
                        } while (event.changes.any { it.pressed })
                        if (pinching) pinch(zoom)
                    }
                },
        ) {
            item(key = "top") { Column { top() } }
            if (items.isEmpty() && complete) {
                item(key = "undated") {
                    // A QUIET LINE, NOT A CARD: undated photographs live in All,
                    // and a card for them would be a fake period.
                    Text(
                        text = PhotosCopy.PHOTOS_LIBRARY_UNDATED_NOTE,
                        style = centraidType("small"),
                        color = centraidColor("textSoft"),
                        modifier = Modifier.padding(CentraidGeometry.PAGE_MARGIN.dp),
                    )
                }
            }
            items.forEach { entry ->
                item(key = entry.key) {
                    when {
                        entry.header.isNotEmpty() -> Box(
                            Modifier
                                .fillMaxWidth()
                                .height(MONTH_ROW_HEIGHT.dp)
                                .padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp),
                            contentAlignment = Alignment.BottomStart,
                        ) {
                            Text(
                                entry.header,
                                style = centraidType("eyebrow"),
                                color = centraidColor("text"),
                                modifier = Modifier.padding(bottom = 6.dp).semantics { heading() },
                            )
                        }
                        years -> Box(Modifier.padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp)) {
                            PeriodCard(entry.periods[0], stage * YEAR_COVER_RATIO, overlaid = true, onOpenPeriod)
                        }
                        else -> Row(
                            Modifier.padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp),
                            horizontalArrangement = Arrangement.spacedBy(CARD_GUTTER.dp),
                        ) {
                            val cardWidth = (stage - CARD_GUTTER.dp) / 2
                            entry.periods.forEach { period ->
                                Box(Modifier.width(cardWidth)) {
                                    PeriodCard(period, cardWidth, overlaid = false, onOpenPeriod)
                                }
                            }
                        }
                    }
                }
            }
            item(key = "more") { MoreSentinel(complete, cells.size, onMore) }
        }
    }
}

@Composable
private fun PeriodCard(
    period: LibraryPeriod,
    coverHeight: androidx.compose.ui.unit.Dp,
    overlaid: Boolean,
    onOpenPeriod: (String) -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .clickable(onClickLabel = PhotosCopy.PHOTOS_OPEN_ITEM.replace("{label}", period.title)) { onOpenPeriod(period.anchorDay) }
            .semantics(mergeDescendants = true) {
                role = Role.Button
                contentDescription = "${period.title}, ${period.count}"
            }
            .padding(bottom = CARD_BOTTOM.dp),
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .height(coverHeight)
                .clip(RoundedCornerShape(RADIUS_MD.dp))
                .background(centraidColor("skel")),
        ) {
            if (period.coverPath.isNotEmpty()) ContentImage(period.coverPath)
            if (overlaid) {
                // AN OVERLAY ONLY WITH A GROUND OF ITS OWN: a name over an
                // unpredictable photograph needs the scrim under it.
                Box(Modifier.fillMaxSize().background(centraidColor("scrim")))
                Text(
                    text = period.title,
                    style = centraidType("display"),
                    color = centraidColor("onStage"),
                    maxLines = 1,
                    modifier = Modifier.align(Alignment.BottomStart).padding(16.dp, 0.dp, 16.dp, 12.dp),
                )
            }
        }
        Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (!overlaid) {
                Text(
                    period.title,
                    style = centraidType("smallStrong"),
                    color = centraidColor("text"),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
            }
            Text(period.count, style = centraidType("mono"), color = centraidColor("textSoft"), maxLines = 1)
        }
    }
}

/**
 * THE DAY AT THE TOP OF A GRAIN'S LIST — the first card's newest day under a
 * year header, or the card's own — so a switch to another grain lands where
 * the member was. Item 0 is the top slot.
 */
internal fun grainDayAt(cells: List<PhotoCell>, grain: PhotosGridState.Grain, index: Int): String {
    val items = grainItemsOf(cells, grain == PhotosGridState.Grain.GRAIN_YEARS)
    val item = items.drop((index - 1).coerceAtLeast(0)).firstOrNull { it.periods.isNotEmpty() }
    return item?.periods?.firstOrNull()?.anchorDay ?: ""
}

/** The Years or Months list: its cards, in the cells' own newest-first order. */
private fun grainItemsOf(cells: List<PhotoCell>, years: Boolean): List<GrainItem> =
    PhotosLibraryLayout.grainItems(
        PhotosLibraryLayout.periods(libraryCells(cells), years, DeviceLibraryTitles),
        years,
    )

/**
 * THE GRAIN CONTROL (v0's `TimelineGrainControl.tsx`): Years · Months · All,
 * PERMANENT while the library is the destination — never armed by a scroll,
 * never on a timer. The band's grammar: one elevated plate on the pill rung
 * with a hairline, the lit segment in ink with a mark-wide rule over it.
 */
@Composable
internal fun GrainControl(grain: PhotosGridState.Grain, onGrain: (PhotosGridState.Grain) -> Unit) {
    val segments = listOf(
        PhotosGridState.Grain.GRAIN_YEARS to PhotosCopy.PHOTOS_GRAIN_YEARS,
        PhotosGridState.Grain.GRAIN_MONTHS to PhotosCopy.PHOTOS_GRAIN_MONTHS,
        PhotosGridState.Grain.GRAIN_ALL to PhotosCopy.PHOTOS_GRAIN_ALL,
    )
    Box(Modifier.fillMaxWidth().padding(top = BandPolicy.BAND_TOP_GAP.dp), contentAlignment = Alignment.Center) {
        Row(
            Modifier
                .clip(RoundedCornerShape(BandPolicy.BAND_RADIUS.dp))
                .background(centraidColor("bgElev"))
                .border(
                    CentraidGeometry.HAIRLINE.dp,
                    centraidColor("lineStrong"),
                    RoundedCornerShape(BandPolicy.BAND_RADIUS.dp),
                )
                .padding(BandPolicy.BAND_PLATE_PAD.dp),
            horizontalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            segments.forEach { (key, label) ->
                val active = key == grain ||
                    (key == PhotosGridState.Grain.GRAIN_ALL && grain == PhotosGridState.Grain.GRAIN_UNSPECIFIED)
                Box(
                    Modifier
                        .heightIn(min = CentraidGeometry.TARGET_MIN_COARSE.dp)
                        .bandPress({ onGrain(key) })
                        .semantics {
                            role = Role.Tab
                            selected = active
                            contentDescription = label
                        }
                        .padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    if (active) {
                        Box(
                            Modifier
                                .align(Alignment.TopCenter)
                                .padding(top = CentraidGeometry.HAIRLINE.dp)
                                .size(BandPolicy.BAND_MARK_SIZE.dp, 2.dp)
                                .clip(RoundedCornerShape((LocalCentraidTokens.current.radii["pill"] ?: 0).dp))
                                .background(centraidColor("text")),
                        )
                    }
                    Text(
                        text = label,
                        style = centraidType(if (active) "control" else "band", scales = false),
                        color = centraidColor(if (active) "text" else "textSoft"),
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

/**
 * A DATE IN THE READER'S LOCALE — `Fri, Aug 14`, with the year only when it is
 * not this one (v0's `sectionPhotoAssets`), and `August 2026`. The one thing
 * the shared layout cannot say: `CivilWords` spells days in English from the
 * copy tables, and the library has always spelled them the way the device
 * does. The day is already the capture-local day; it is formatted at noon UTC
 * in UTC so no zone can move it.
 */
private object DeviceLibraryTitles : LibraryTitles {
    override fun month(year: Int, month: Int): String =
        format(year, month, 1, android.text.format.DateFormat.getBestDateTimePattern(java.util.Locale.getDefault(), "MMMMyyyy"))

    override fun day(year: Int, month: Int, day: Int, withYear: Boolean): String {
        val skeleton = if (withYear) "EEEMMMdyyyy" else "EEEMMMd"
        return format(year, month, day, android.text.format.DateFormat.getBestDateTimePattern(java.util.Locale.getDefault(), skeleton))
    }

    private fun format(year: Int, month: Int, day: Int, pattern: String): String {
        val utc = java.util.TimeZone.getTimeZone("UTC")
        val calendar = java.util.Calendar.getInstance(utc).apply {
            clear()
            set(year, month - 1, day, 12, 0)
        }
        return java.text.SimpleDateFormat(pattern, java.util.Locale.getDefault())
            .apply { timeZone = utc }
            .format(calendar.time)
    }
}

private const val MONTH_ROW_HEIGHT: Int = PhotosLibraryLayout.MONTH_ROW
private const val DAY_ROW_HEIGHT: Int = PhotosLibraryLayout.DAY_ROW
private const val RAIL_WIDTH: Int = PhotosLibraryLayout.RAIL_WIDTH
private const val RAIL_TOP: Int = PhotosLibraryLayout.RAIL_INSET
private const val THUMB_HEIGHT: Int = PhotosLibraryLayout.THUMB
private const val RAIL_MIN_ROWS: Int = PhotosLibraryLayout.RAIL_MIN_ROWS
private const val YEAR_COVER_RATIO: Float = PhotosLibraryLayout.YEAR_COVER_RATIO.toFloat()
private const val CARD_GUTTER: Int = PhotosLibraryLayout.CARD_GUTTER
private const val CARD_BOTTOM: Int = PhotosLibraryLayout.CARD_BOTTOM
private const val RADIUS_MD: Int = 7
