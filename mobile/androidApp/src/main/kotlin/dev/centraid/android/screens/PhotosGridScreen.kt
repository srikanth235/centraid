package dev.centraid.android.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import centraid.screen.v1.AlbumChoiceCreated
import centraid.screen.v1.AlbumChoiceDismissed
import centraid.screen.v1.AlbumChosen
import centraid.screen.v1.AlbumChoiceOpened
import centraid.screen.v1.BackupState
import centraid.screen.v1.MediaPermission
import centraid.screen.v1.PhotoCell
import centraid.screen.v1.PhotosGridEvent
import centraid.screen.v1.PhotosGridState
import dev.centraid.android.kit.AlbumChoiceSheet
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.PhotoGridSkeleton
import dev.centraid.android.kit.ScreenEmpty
import dev.centraid.android.kit.ScreenFailure
import dev.centraid.android.kit.bandFloor
import dev.centraid.android.kit.bandPress
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidGeometry
import dev.centraid.shared.apps.photos.PhotosTimeline
import dev.centraid.shared.shell.BandPolicy

/**
 * The Photos grid (#1020, D-1020-E3).
 *
 * Two planes on one screen, and the whole screen is arranged so they cannot be
 * confused: the GRID renders `content` (the vault), and the BACKUP banner
 * renders `backup` and `permission` (the camera roll). A denied photo grant
 * changes the banner and never the grid.
 *
 * ## The library, as v0 drew it (#1029, photos port)
 *
 * v0's `PhotosHome.tsx` and its siblings: a justified timeline grouped by day
 * under sticky months, paged through the whole library as the member scrolls;
 * Years · Months · All above the band; a scrub rail on the trailing edge; a
 * header menu for the filter and the tile size; skeleton
 * tiles while the first page is read; and a selection whose bar takes the
 * band's place. Every choice is `PhotosGridState` and every write is the
 * machine's, so this file draws and forwards and decides nothing. The layout
 * pieces are `PhotosLibraryTimeline.kt`; the SwiftUI twin is
 * `PhotosGridView.swift`.
 */
@Composable
public fun PhotosGridScreen(
    state: PhotosGridState,
    onEvent: (PhotosGridEvent) -> Unit,
    /**
     * Run one camera-roll pass now (#1025 S6).
     *
     * A CALLBACK AND NOT AN EVENT, for iOS's reason: a pass is a shell effect
     * with file and network I/O in it, and the states it publishes come back as
     * ordinary `BackupChanged` events. Asking the reducer to do a file read
     * would make one of the two planes on this screen the other one's problem.
     *
     * Defaulted so a preview and a fixture render this screen without one.
     */
    onBackUpNow: () -> Unit = {},
    /**
     * A CELL WAS TAPPED. The asset, and the page's order as its neighbours.
     *
     * Defaulted so a preview and a fixture render this screen without one —
     * and it was MISSING, so the library grid was the one photographs surface
     * with no way into the lightbox while the shelf and search both had one.
     */
    onOpenAsset: (assetId: String, neighbours: List<String>) -> Unit = { _, _ -> },
) {
    val data = state.data_
    val cells = data?.cells.orEmpty()
    val selected = remember(state.selected) { state.selected.toSet() }
    // WHERE THE MEMBER IS STANDING, reported by whichever grain is drawn, so a
    // grain switch can land on the same stretch of time.
    val visibleDay = remember { mutableStateOf("") }
    // ONE SCROLL POSITION PER GRAIN: All and Months are different lists, and
    // an index carried from one into the other lands nowhere in particular.
    val listState = remember(state.grain) { LazyListState() }

    // BACK LEAVES THE MODE BEFORE IT LEAVES THE SCREEN — Apple Photos', and
    // the band is not on screen to leave by while the bar stands in for it.
    BackHandler(enabled = state.selecting) {
        onEvent(PhotosGridEvent(selection_mode = PhotosGridEvent.SelectionModeChanged(selecting = false)))
    }

    Column(Modifier.fillMaxSize()) {
        LibraryHeader(state, hasCells = cells.isNotEmpty(), onEvent = onEvent)
        state.write_failure?.let { failure ->
            // A REFUSED WRITE SAYS SO, in its own line and never in place of the
            // library: the photographs are still what they were.
            Text(
                text = failure.sentence,
                style = centraidType("small"),
                color = centraidColor("textSoft"),
                modifier = Modifier.padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp, vertical = 4.dp),
            )
        }
        if (state.export_notice.isNotEmpty()) {
            // WHAT "SEND A COPY" CAME TO — the originals not on this device, a
            // location that could not be taken out — in the same quiet line.
            Text(
                text = state.export_notice,
                style = centraidType("small"),
                color = centraidColor("textSoft"),
                modifier = Modifier.padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp, vertical = 4.dp),
            )
        }
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val width = maxWidth.value.toInt()
            val viewport = maxHeight.value.toInt()
            val target = PhotosTimeline.RUNG_HEIGHTS[PhotosTimeline.clampRung(state.rung)]
            val top: @Composable () -> Unit = {
                BackupBanner(state, onEvent, onBackUpNow)
            }
            val loading = state.loading
            val failure = state.failure
            when {
                // THE GRID IS THE LOADING STATE (v0 §14): skeleton tiles at the
                // rung's real geometry, so nothing reflows when the bytes land.
                // Never a spinner.
                loading != null -> Column {
                    top()
                    PhotoGridSkeleton(width, target, viewport)
                }

                failure != null -> Column {
                    top()
                    ScreenFailure(
                        failure.sentence,
                        failure.remedy,
                        Modifier.padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp),
                    )
                }

                data == null -> Column { top() }

                // THE DATED WALK CAME BACK EMPTY AND THE UNDATED ONE HAS NOT
                // RUN: still loading, not an empty library.
                cells.isEmpty() && !data.complete -> Column {
                    top()
                    PhotoGridSkeleton(width, target, viewport)
                    LaunchedEffect(data.undated_walk) {
                        onEvent(PhotosGridEvent(next_page = PhotosGridEvent.NextPageRequested()))
                    }
                }

                cells.isEmpty() -> Column {
                    top()
                    // THE FILTER EMPTIED THE GRID, NOT THE LIBRARY — its own
                    // sentence, never the empty-library copy.
                    if (state.filter == PhotosGridState.Filter.FILTER_FAVORITES) {
                        ScreenEmpty(
                            sentence = "No favorites yet",
                            remedy = "Photographs you mark as a favorite appear here.",
                            modifier = Modifier.padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp),
                        )
                    } else {
                        ScreenEmpty(
                            sentence = "No photographs on this device yet.",
                            remedy = "Import your camera roll and they appear here.",
                            modifier = Modifier.padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp),
                        )
                    }
                }

                state.grain == PhotosGridState.Grain.GRAIN_YEARS ||
                    state.grain == PhotosGridState.Grain.GRAIN_MONTHS -> {
                    LibraryGrains(
                        cells = cells,
                        grain = state.grain,
                        placeDay = state.place_day,
                        complete = data.complete,
                        listState = listState,
                        top = top,
                        onOpenPeriod = { day ->
                            onEvent(PhotosGridEvent(period = PhotosGridEvent.PeriodOpened(anchor_day = day)))
                        },
                        onMore = { onEvent(PhotosGridEvent(next_page = PhotosGridEvent.NextPageRequested())) },
                        onPinch = { scale -> pinched(state, scale, visibleDay.value, onEvent) },
                    )
                    ReportVisibleDay(listState, visibleDay) { index -> grainDayAt(cells, state.grain, index) }
                }

                else -> {
                    val year = remember { java.util.Calendar.getInstance().get(java.util.Calendar.YEAR) }
                    val rows = remember(cells, width, state.rung) { libraryRows(cells, width, state.rung, year) }
                    LandOnDay(listState, rows, state.place_day)
                    LibraryTimeline(
                        rows = rows,
                        rung = state.rung,
                        selecting = state.selecting,
                        selected = selected,
                        complete = data.complete,
                        cellCount = cells.size,
                        listState = listState,
                        top = top,
                        onTile = { assetId ->
                            if (state.selecting) {
                                onEvent(
                                    PhotosGridEvent(
                                        selection_toggled = PhotosGridEvent.SelectionToggled(asset_id = assetId),
                                    ),
                                )
                            } else {
                                // A CELL OPENS THE PHOTOGRAPH, and the loaded
                                // library's own order rides along as the
                                // neighbours — so a swipe in the lightbox costs
                                // no read, and it walks the library in the order
                                // the member is looking at.
                                onOpenAsset(assetId, cells.map { it.asset_id })
                            }
                        },
                        onPick = { ids, picked ->
                            onEvent(
                                PhotosGridEvent(
                                    selection_set = PhotosGridEvent.SelectionSet(asset_ids = ids, selected = picked),
                                ),
                            )
                        },
                        onFetch = { assetId, contentHash ->
                            onEvent(
                                PhotosGridEvent(
                                    fetch_original = PhotosGridEvent.OriginalRequested(
                                        asset_id = assetId,
                                        content_hash = contentHash,
                                    ),
                                ),
                            )
                        },
                        onMore = { onEvent(PhotosGridEvent(next_page = PhotosGridEvent.NextPageRequested())) },
                        onPinch = { scale -> pinched(state, scale, visibleDay.value, onEvent) },
                    )
                    ReportVisibleDay(listState, visibleDay) { index -> dayOfRow(rows.getOrNull(index - 1)) }
                }
            }
        }
        // THE GRAIN CONTROL IS PERMANENT WHILE THE LIBRARY HAS PHOTOGRAPHS
        // (v0): absent only while selecting — the bar is then the foot — or
        // when there is nothing to zoom.
        if (!state.selecting && cells.isNotEmpty()) {
            GrainControl(state.grain) { grain ->
                onEvent(PhotosGridEvent(grain = PhotosGridEvent.GrainChanged(grain = grain, at_day = visibleDay.value)))
            }
        }
    }

    // THE SELECTION'S TWO SHEETS: the album choice (lane C's, one sheet for
    // every "Add to album") and the trash confirm — a confirm is a sheet (D4).
    if (state.album_choice_open) {
        AlbumChoiceSheet(
            choices = state.album_choices,
            onChoose = { albumId ->
                onEvent(PhotosGridEvent(album_chosen = AlbumChosen(album_id = albumId)))
            },
            onNewAlbum = { title ->
                onEvent(PhotosGridEvent(album_created = AlbumChoiceCreated(title = title)))
            },
            onDismiss = { onEvent(PhotosGridEvent(album_choice_dismissed = AlbumChoiceDismissed())) },
        )
    }
    if (state.sheet == PhotosGridState.Sheet.SHEET_CONFIRM_TRASH) {
        ConfirmTrashSheet(
            count = state.selected.size,
            onConfirm = { onEvent(PhotosGridEvent(trash_confirmed = PhotosGridEvent.TrashConfirmed())) },
            onDismiss = {
                onEvent(PhotosGridEvent(sheet = PhotosGridEvent.SheetChanged(PhotosGridState.Sheet.SHEET_NONE)))
            },
        )
    }
}

/**
 * A PINCH, as the machine's table reads it: a rung step inside All, a grain
 * past its ends. Landing where the member was, like every grain change.
 */
private fun pinched(state: PhotosGridState, scale: Float, day: String, onEvent: (PhotosGridEvent) -> Unit) {
    val landed = PhotosTimeline.pinch(state.grain, state.rung, scale)
    if (landed.rung != state.rung) {
        onEvent(PhotosGridEvent(rung = PhotosGridEvent.RungChanged(rung = landed.rung)))
    }
    if (landed.grain != state.grain) {
        onEvent(PhotosGridEvent(grain = PhotosGridEvent.GrainChanged(grain = landed.grain, at_day = day)))
    }
}

/** Keep [visibleDay] on the day at the top of the list as it scrolls. */
@Composable
private fun ReportVisibleDay(listState: LazyListState, visibleDay: MutableState<String>, dayAt: (Int) -> String) {
    val probe by androidx.compose.runtime.rememberUpdatedState(dayAt)
    LaunchedEffect(listState) {
        snapshotFlow { listState.firstVisibleItemIndex }.collect { index -> visibleDay.value = probe(index) }
    }
}

/**
 * LAND ON THE DAY A GRAIN SWITCH OR A CARD NAMED, once per distinct day — a
 * member who scrolls away is not pulled back on the next recomposition.
 */
@Composable
private fun LandOnDay(listState: LazyListState, rows: List<LibraryRow>, day: String) {
    var landed by remember { mutableStateOf("") }
    LaunchedEffect(day, rows) {
        if (day.isEmpty() || day == landed) return@LaunchedEffect
        val index = rows.indexOfFirst { it is LibraryRow.Day && it.day == day }
            .takeIf { it >= 0 }
            ?: rows.indexOfFirst { it is LibraryRow.Month && day.startsWith(it.day.take(7)) && it.day.isNotEmpty() }
        if (index >= 0) {
            landed = day
            // Item 0 is the top slot, so a row's item is its index + 1.
            listState.scrollToItem(index + 1)
        }
    }
}

/**
 * THE LIBRARY'S HEAD: its name and its two controls, or — selecting — the
 * count and the way out (v0's room swaps its header in place to "N selected ·
 * Cancel").
 *
 * The menu is v0's `libraryMenuGroups`: the filter at every grain, the tile
 * size only at All — Years and Months draw one cover per period at an aspect
 * the grain fixes, so a size there would act on nothing on screen.
 *
 * v0's third group, "Prioritise faces", is NOT here: the enrichment ask behind
 * it went with #1029, so all that row could do is open People — a place, not a
 * view option, and one Collections already has a door to (Apple Photos' view
 * menu carries none either).
 */
@Composable
private fun LibraryHeader(
    state: PhotosGridState,
    hasCells: Boolean,
    onEvent: (PhotosGridEvent) -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = CentraidGeometry.TARGET_MIN_COARSE.dp)
            .padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val count = state.selected.size
        Text(
            text = when {
                !state.selecting -> "Library"
                count == 0 -> "Select photographs"
                count == 1 -> "1 photograph selected"
                else -> "$count photographs selected"
            },
            style = centraidType("title"),
            color = centraidColor("text"),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f).semantics { heading() },
        )
        if (state.selecting) {
            HeaderButton("Cancel") {
                onEvent(PhotosGridEvent(selection_mode = PhotosGridEvent.SelectionModeChanged(selecting = false)))
            }
        } else {
            Box {
                Box(
                    Modifier
                        .size(CentraidGeometry.TARGET_MIN_COARSE.dp)
                        .bandPress({ menu = true })
                        .semantics {
                            role = Role.Button
                            contentDescription = "View options"
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    CentraidIcon(iconKey = "Sliders", tint = centraidColor("text"), size = 20.dp)
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    MenuHeading("Filter")
                    listOf(
                        PhotosGridState.Filter.FILTER_ALL to "All photos",
                        PhotosGridState.Filter.FILTER_FAVORITES to "Favorites",
                    ).forEach { (filter, label) ->
                        val on = state.filter == filter ||
                            (filter == PhotosGridState.Filter.FILTER_ALL &&
                                state.filter == PhotosGridState.Filter.FILTER_UNSPECIFIED)
                        CheckRow(label, on) {
                            // CLOSES THE MENU: the card would hide the grid it
                            // just changed.
                            menu = false
                            onEvent(PhotosGridEvent(filter = PhotosGridEvent.FilterChanged(filter = filter)))
                        }
                    }
                    if (state.grain == PhotosGridState.Grain.GRAIN_ALL) {
                        HorizontalDivider()
                        MenuHeading("Tile size")
                        PhotosTimeline.RUNG_LABELS.forEachIndexed { rung, label ->
                            // STAYS OPEN: stepping sizes against the live grid
                            // needs the card up.
                            CheckRow(label, rung == state.rung) {
                                onEvent(PhotosGridEvent(rung = PhotosGridEvent.RungChanged(rung = rung)))
                            }
                        }
                    }
                }
            }
            if (hasCells) {
                HeaderButton("Select") {
                    onEvent(PhotosGridEvent(selection_mode = PhotosGridEvent.SelectionModeChanged(selecting = true)))
                }
            }
        }
    }
}

@Composable
private fun MenuHeading(label: String) {
    Text(
        text = label,
        style = centraidType("eyebrow"),
        color = centraidColor("textSoft"),
        modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp).semantics { heading() },
    )
}

@Composable
private fun CheckRow(label: String, on: Boolean, onClick: () -> Unit) {
    DropdownMenuItem(
        text = { Text(label, style = centraidType("body")) },
        trailingIcon = {
            if (on) CentraidIcon(iconKey = "Check", tint = centraidColor("text"), size = 18.dp)
        },
        onClick = onClick,
        modifier = Modifier.semantics { stateDescriptionOf(on) },
    )
}

private fun androidx.compose.ui.semantics.SemanticsPropertyReceiver.stateDescriptionOf(on: Boolean) {
    stateDescription = if (on) "Selected" else "Not selected"
}

/** A text control in the header: ink on the page, a thumb's target. */
@Composable
private fun HeaderButton(label: String, onClick: () -> Unit) {
    Box(
        Modifier
            .heightIn(min = CentraidGeometry.TARGET_MIN_COARSE.dp)
            .bandPress(onClick)
            .semantics {
                role = Role.Button
                contentDescription = label
            }
            .padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, style = centraidType("control"), color = centraidColor("text"))
    }
}

/**
 * THE SELECTION BAR, IN THE BAND'S PLACE (Apple Photos; v0's room took the
 * band away under a selection so a tap aimed at Trash could not land on a
 * destination). Drawn by `MainActivity`'s Photos foot in place of `AppBand`
 * while the library is selecting — the band components themselves are not
 * touched.
 *
 * The band's grammar: one elevated plate on the pill rung with a hairline, a
 * mark over a word per verb. With nothing picked every verb is drawn DISABLED
 * rather than hidden, so the bar does not move under the member's thumb as
 * they pick. Favorite says "Unfavorite" under the Favorites filter, where
 * every photograph on screen already is one. Trash is confirmed first.
 *
 * "Back up" is NOT here, though v0 had it: v0's grid merged camera-roll
 * photographs that were not yet in any vault, and backing one up was a verb
 * on it. Every tile of this grid IS a vault row — the phone is the vault — so
 * there is nothing on screen for a per-selection backup to carry.
 *
 * "Send a copy" is the shelf's batch hand-off (`PhotoShelfCopies.kt`) over the
 * library's pick: [onSendCopy] carries the pick and the member's one answer to
 * how much of the place travels, asked here once for all of them (#816).
 */
@Composable
public fun PhotosSelectionBar(
    state: PhotosGridState,
    onEvent: (PhotosGridEvent) -> Unit,
    onSendCopy: (assetIds: List<String>, export: ShelfExport.Send) -> Unit,
) {
    val armed = state.selected.isNotEmpty()
    var choosingPlace by remember { mutableStateOf(false) }
    val favorites = state.filter == PhotosGridState.Filter.FILTER_FAVORITES
    Row(
        Modifier
            .fillMaxWidth()
            .padding(
                start = BandPolicy.BAND_INSET.dp,
                end = BandPolicy.BAND_INSET.dp,
                top = BandPolicy.BAND_TOP_GAP.dp,
            )
            .bandFloor(),
    ) {
        Row(
            Modifier
                .weight(1f)
                .height(BandPolicy.BAND_HEIGHT.dp)
                .clip(RoundedCornerShape(BandPolicy.BAND_RADIUS.dp))
                .border(
                    CentraidGeometry.HAIRLINE.dp,
                    centraidColor("lineStrong"),
                    RoundedCornerShape(BandPolicy.BAND_RADIUS.dp),
                )
                .padding(BandPolicy.BAND_PLATE_PAD.dp),
            horizontalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            SelectionVerb("FolderPlus", "Add to album", armed, Modifier.weight(1f)) {
                onEvent(PhotosGridEvent(album_choice_opened = AlbumChoiceOpened()))
            }
            SelectionVerb("Heart", if (favorites) "Unfavorite" else "Favorite", armed, Modifier.weight(1f)) {
                onEvent(
                    PhotosGridEvent(
                        favorite_selected = PhotosGridEvent.FavoriteSelected(favorite = !favorites),
                    ),
                )
            }
            SelectionVerb("Share", "Send a copy", armed, Modifier.weight(1f)) {
                choosingPlace = true
            }
            SelectionVerb("Trash", "Trash", armed, Modifier.weight(1f)) {
                onEvent(PhotosGridEvent(sheet = PhotosGridEvent.SheetChanged(PhotosGridState.Sheet.SHEET_CONFIRM_TRASH)))
            }
        }
    }

    // HOW MUCH OF THE PLACE TRAVELS, asked every time (#816) — the shelf's two
    // answers, for the shelf's reason: a place NAME is one sentence per
    // photograph, and a batch has as many places as photographs.
    if (choosingPlace) {
        AlertDialog(
            onDismissRequest = { choosingPlace = false },
            title = { Text(text = "Send a copy — how much of the place?") },
            confirmButton = {
                Column {
                    TextButton(
                        onClick = {
                            choosingPlace = false
                            onSendCopy(state.selected, ShelfExport.Send(keepLocation = false))
                        },
                    ) { Text(text = "No location") }
                    TextButton(
                        onClick = {
                            choosingPlace = false
                            onSendCopy(state.selected, ShelfExport.Send(keepLocation = true))
                        },
                    ) { Text(text = "Exact location") }
                }
            },
            dismissButton = { TextButton(onClick = { choosingPlace = false }) { Text(text = "Cancel") } },
        )
    }
}

@Composable
private fun SelectionVerb(
    iconKey: String,
    label: String,
    armed: Boolean,
    modifier: Modifier = Modifier,
    onPress: () -> Unit,
) {
    // DISABLED IS ITS OWN TOKEN ON THE LEAF, never an opacity on the tab.
    val ink = if (armed) centraidColor("text") else centraidColor("textDisabled")
    Column(
        modifier
            .heightIn(min = BandPolicy.BAND_TAB_MIN_HEIGHT.dp)
            .then(if (armed) Modifier.bandPress(onPress) else Modifier)
            .padding(top = BandPolicy.BAND_TAB_TOP.dp, bottom = BandPolicy.BAND_TAB_BOTTOM.dp)
            .semantics {
                role = Role.Button
                contentDescription = label
                if (!armed) disabled()
            },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        CentraidIcon(iconKey = iconKey, tint = ink, size = BandPolicy.BAND_ICON_SIZE.dp)
        Text(
            text = label,
            style = centraidType("band"),
            color = ink,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(top = BandPolicy.BAND_LABEL_GAP.dp),
        )
    }
}

/**
 * "MOVE THESE TO THE TRASH?" — a sheet, not an alert (D4), with the one fact a
 * member deciding needs: the trash gives them back, and the camera roll is not
 * touched (v0's `TRASH_KEEPS_THE_ORIGINAL`, in this product's words). The
 * destructive answer is OUTLINED in `--net`, never filled.
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun ConfirmTrashSheet(count: Int, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    androidx.compose.material3.ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp)
                .padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = trashQuestion(count),
                style = centraidType("title"),
                color = centraidColor("text"),
                modifier = Modifier.semantics { heading() },
            )
            Text(
                text = TRASH_KEEPS_THE_ROLL,
                style = centraidType("small"),
                color = centraidColor("textSoft"),
            )
            Box(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = CentraidGeometry.TARGET_MIN_COARSE.dp)
                    .clip(RoundedCornerShape(BandPolicy.BAND_RADIUS.dp))
                    .border(CentraidGeometry.HAIRLINE.dp, centraidColor("net"), RoundedCornerShape(BandPolicy.BAND_RADIUS.dp))
                    .clickable(onClickLabel = "Move to trash", onClick = onConfirm)
                    .semantics { role = Role.Button },
                contentAlignment = Alignment.Center,
            ) {
                Text("Move to trash", style = centraidType("control"), color = centraidColor("net"))
            }
            TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) {
                Text("Keep them", style = centraidType("control"), color = centraidColor("text"))
            }
        }
    }
}

private fun trashQuestion(count: Int): String =
    if (count == 1) "Move 1 photograph to the trash?" else "Move $count photographs to the trash?"

/** What the trash confirm says, once, on both shells. */
private const val TRASH_KEEPS_THE_ROLL: String =
    "You can restore them from the trash. Photographs in your camera roll are not touched."

@Composable
private fun BackupBanner(
    state: PhotosGridState,
    onEvent: (PhotosGridEvent) -> Unit,
    onBackUpNow: () -> Unit,
) {
    val backup = state.backup ?: return
    Column(Modifier.padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp, vertical = 8.dp)) {
        Text(text = phaseLabel(state), style = centraidType("small"), color = centraidColor("text"))
        if (backup.paused_reason.isNotEmpty()) {
            Text(text = backup.paused_reason, style = centraidType("small"), color = centraidColor("textSoft"))
        }
        // AN OS PERMISSION IS A STATE, and each state has its own remedy:
        // "not asked" has the prompt, "denied" has a trip to Settings, a
        // selection has "Select more photos", and "restricted" has none
        // (`PhotoAccessRemedy`). The answer comes back as `PermissionRequested`,
        // whose runner reads the grant fresh.
        PhotoAccessRemedy(state.permission) {
            onEvent(PhotosGridEvent(permission_requested = PhotosGridEvent.PermissionRequested()))
        }
        // PARITY WITH iOS (#1025 S6). Not offered while a pass is running: the
        // runner holds a lock and a second press would do nothing, which is a
        // button that lies about having worked.
        if (
            backup.phase != BackupState.Phase.PHASE_TRANSFERRING &&
            backup.phase != BackupState.Phase.PHASE_ENUMERATING
        ) {
            BannerLink("Import now", onClick = onBackUpNow)
        }
    }
}

private fun phaseLabel(state: PhotosGridState): String {
    val backup = state.backup ?: return ""
    val transferred = backup.assets_transferred_this_session
    return when (backup.phase) {
        BackupState.Phase.PHASE_TRANSFERRING ->
            "Importing: $transferred done, ${backup.assets_remaining} to go"
        BackupState.Phase.PHASE_ENUMERATING -> "Looking through your photos"
        BackupState.Phase.PHASE_WAITING_FOR_POWER -> "Waiting for a charger"
        BackupState.Phase.PHASE_WAITING_FOR_UNMETERED -> "Waiting for Wi-Fi"
        BackupState.Phase.PHASE_PARKED_LOW_DISK ->
            "Paused: this device is out of space"
        BackupState.Phase.PHASE_DONE -> "Your camera roll is in your vault"
        // IDLE HAS A SENTENCE NOW. An empty string over an empty banner is a
        // member who cannot tell a backup that is OFF from one that has nothing
        // to say — the two look identical and only one has a next move.
        BackupState.Phase.PHASE_IDLE -> "Camera roll import is off"
        BackupState.Phase.PHASE_UNSPECIFIED -> ""
    }
}

/**
 * PHOTOS' BAND: v0's three places, in v0's order and with v0's marks
 * (`photos-band.ts`) — Library first, because the band is judged by how few
 * taps the timeline costs. More is not among them; it opens a sheet, so the
 * band draws it as its own tab. `unspecified` IS the library: the machine
 * opens there, and a band with nothing lit would be a band saying "nowhere".
 */
internal fun photosBandTabs(current: PhotosGridState.Destination): List<dev.centraid.android.kit.AppBandTab> =
    listOf(
        Triple(PhotosGridState.Destination.DESTINATION_LIBRARY, "Library", "Image"),
        Triple(PhotosGridState.Destination.DESTINATION_COLLECTIONS, "Collections", "Layers"),
        Triple(PhotosGridState.Destination.DESTINATION_SEARCH, "Search", "Search"),
    ).map { (destination, label, icon) ->
        dev.centraid.android.kit.AppBandTab(
            key = destination.name,
            label = label,
            iconKey = icon,
            selected = destination == current ||
                (destination == PhotosGridState.Destination.DESTINATION_LIBRARY &&
                    current == PhotosGridState.Destination.DESTINATION_UNSPECIFIED),
        )
    }

/**
 * THE MORE SHEET, AND THE BACKUP DETAIL BEHIND IT.
 *
 * `more` is a sheet and never a destination — the band caps at five, and the
 * type system says so, because `SHEET_MORE` is a `PhotosGridState.Sheet` and
 * there is no `Destination` value it could be. Until now the `⋮` control
 * reduced correctly and drew nothing: the event moved `state.sheet` and neither
 * shell read it, so it was a button that did nothing a member could see.
 *
 * **ONE ROW.** v0's sheet carries only what Collections does not — a row for a
 * shelf Collections already shows would be two doors, one hidden — and its foot
 * names what is actually behind this door (`photos-band.ts`).
 *
 * **WHERE THE BACKUP ROW LANDS IS NOT WHERE v0 SENT IT.** v0 deep-linked to the
 * FRAME's `Settings → BackupHealth`, keeping a link rather than a copy because
 * the policy it edits governs Docs' scans and Notes' attachments too. There is
 * no frame Settings in this shell — `Destination.Settings` is declared and
 * nothing renders it — so a row that pushed one would go nowhere. It opens
 * `SHEET_BACKUP_DETAIL` instead, which the state already declares. The deep
 * link comes back when the frame screen does.
 *
 * The SwiftUI twin is `mobile/iosApp/Sources/PhotosMoreSheet.swift`.
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
internal fun PhotosSheets(
    state: PhotosGridState,
    onEvent: (PhotosGridEvent) -> Unit,
    onBackUpNow: () -> Unit,
) {
    // A SWIPE-TO-DISMISS HAS TO REACH THE REDUCER TOO, or the state still says
    // MORE with nothing on screen and the next press on `⋮` is a no-op — the
    // shape of bug that makes a control feel broken every second press.
    val close = { onEvent(PhotosGridEvent(sheet = PhotosGridEvent.SheetChanged(PhotosGridState.Sheet.SHEET_NONE))) }
    when (state.sheet) {
        PhotosGridState.Sheet.SHEET_MORE ->
            androidx.compose.material3.ModalBottomSheet(onDismissRequest = close) {
                Column(Modifier.padding(16.dp)) {
                    Text(text = "More in Photos")
                    TextButton(
                        onClick = {
                            onEvent(
                                PhotosGridEvent(
                                    sheet = PhotosGridEvent.SheetChanged(
                                        PhotosGridState.Sheet.SHEET_BACKUP_DETAIL,
                                    ),
                                ),
                            )
                        },
                    ) { Text(text = "Camera roll") }
                    // ONE CLAUSE ONLY. It said "Everything Photos can show."
                    // over one row, and Photos has a dozen other surfaces —
                    // People, Places, Memories, Duplicates, Trash, Archive,
                    // Favorites, Albums — every one of them reached from
                    // Collections, so the claim was false as printed.
                    Text(text = "The rest of Photos is in Collections.")
                    // "FREE UP SPACE" — a statement, not a button
                    // (`KeepOriginalsViews.kt`).
                    FreeUpSpaceRowView(state.free_up)
                }
            }

        PhotosGridState.Sheet.SHEET_BACKUP_DETAIL ->
            androidx.compose.material3.ModalBottomSheet(onDismissRequest = close) {
                val backup = state.backup
                Column(Modifier.padding(16.dp)) {
                    Text(text = "Camera roll")
                    Text(text = phaseLabel(state))
                    if (backup != null && backup.paused_reason.isNotEmpty()) {
                        // WHY IT IS NOT MOVING, and never inferred from a
                        // radio: the pass asks the platform for the real
                        // answer.
                        Text(text = backup.paused_reason)
                    }
                    // REPORTED, NEVER CLAIMED. Which transport the product
                    // ships is decided by the overnight experiment in
                    // `mobile/maestro/ios-transfer-experiment.md`; until it has
                    // run this is a diagnostics line and not a sentence in a
                    // document.
                    Text(text = "Transport: ${transportLabel(state)}")
                    Button(
                        onClick = onBackUpNow,
                        enabled = backup?.phase != BackupState.Phase.PHASE_TRANSFERRING &&
                            backup?.phase != BackupState.Phase.PHASE_ENUMERATING,
                    ) { Text(text = "Import now") }
                }
            }

        else -> Unit
    }
}

private fun transportLabel(state: PhotosGridState): String =
    when (state.backup?.transport) {
        BackupState.Transport.TRANSPORT_IROH_BLOBS -> "Direct"
        BackupState.Transport.TRANSPORT_HTTPS_BLOB_DOOR -> "HTTPS"
        // AN HONEST "NOTHING HAS MOVED YET" and not a default.
        else -> "Nothing carried yet"
    }
