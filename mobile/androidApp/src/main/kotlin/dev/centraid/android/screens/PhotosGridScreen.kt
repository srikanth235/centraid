package dev.centraid.android.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.border
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
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import centraid.core.v1.PhotosAlbumChoiceEvent
import centraid.core.v1.PhotosBatchAction
import centraid.core.v1.PhotosCopyPlaceChosen
import centraid.core.v1.PhotosFreeUpRow
import centraid.core.v1.PhotosFreeUpTapped
import centraid.core.v1.PhotosGrain
import centraid.core.v1.PhotosGrainChanged
import centraid.core.v1.PhotosHomeChrome
import centraid.core.v1.PhotosHomeEvent
import centraid.core.v1.PhotosHomeImportBanner
import centraid.core.v1.PhotosHomeState
import centraid.core.v1.PhotosImportNow
import centraid.core.v1.PhotosLibrary
import centraid.core.v1.PhotosLibraryData
import centraid.core.v1.PhotosNextPage
import centraid.core.v1.PhotosPinched
import centraid.core.v1.PhotosSelection
import centraid.core.v1.PhotosSelectionEvent
import centraid.core.v1.PhotosViewport
import centraid.core.v1.Route
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitLink
import dev.centraid.android.kit.OptionSheet
import dev.centraid.android.kit.PhotoGridSkeleton
import dev.centraid.android.kit.PhotosAlbumChoiceSheet
import dev.centraid.android.kit.ScreenEmpty
import dev.centraid.android.kit.ScreenFailure
import dev.centraid.android.kit.SheetOption
import dev.centraid.android.kit.SheetPrimary
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.SheetRow
import dev.centraid.android.kit.bandFloor
import dev.centraid.android.kit.bandPress
import dev.centraid.android.kit.toKit
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidGeometry
import dev.centraid.shared.shell.BandPolicy

/**
 * The Photos library (#1020, D-1020-E3; #1135).
 *
 * Two planes on one screen, and the whole screen is arranged so they cannot be
 * confused: the GRID renders the vault, and the BACKUP banner renders the camera
 * roll's grant and progress. A denied photo grant changes the banner and never
 * the grid.
 *
 * ## The library, as v0 drew it (#1029, photos port)
 *
 * v0's `PhotosHome.tsx` and its siblings: a justified timeline grouped by day
 * under sticky months, paged through the whole library as the member scrolls;
 * Years · Months · All above the band; a scrub rail on the trailing edge; the
 * filter as chips under the search bar and the tile size in More (the room's
 * chrome, drawn by [PhotosHomeScreen]); skeleton tiles while the first page is
 * read; and a selection whose bar takes the band's place. Every choice is Rust's
 * (`photos.home`) and every write is Rust's, so this file draws and forwards and
 * decides nothing. The layout pieces are `PhotosLibraryTimeline.kt`; the SwiftUI
 * twin is `PhotosGridView.swift`.
 */
@Composable
internal fun PhotosLibraryBody(
    state: PhotosHomeState,
    library: PhotosLibrary,
    onEvent: (PhotosHomeEvent) -> Unit,
    onOpen: (Route) -> Unit,
    onResume: () -> Unit,
) {
    val selection = state.selection ?: PhotosSelection()
    val selected = remember(selection.selected_ids) { selection.selected_ids.toSet() }
    val data = library.data_
    val tiles = data?.tiles.orEmpty()
    // WHERE THE MEMBER IS STANDING, reported by whichever grain is drawn, so a
    // grain switch can land on the same stretch of time.
    val visibleDay = remember { mutableStateOf("") }
    // ONE SCROLL POSITION PER GRAIN: All and Months are different lists, and
    // an index carried from one into the other lands nowhere in particular.
    val listState = remember(library.grain) { LazyListState() }
    val grain = library.grain

    // BACK LEAVES THE MODE BEFORE IT LEAVES THE SCREEN — Apple Photos', and
    // the band is not on screen to leave by while the bar stands in for it.
    BackHandler(enabled = selection.selecting) {
        onEvent(PhotosHomeEvent(selection = selectionMode(false)))
    }

    Column(Modifier.fillMaxSize()) {
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val width = maxWidth.value.toDouble()
            val viewport = maxHeight.value.toDouble()
            // RUST PACKS THE ROWS: it is told the width this grid is drawn at.
            val report by rememberUpdatedState(onEvent)
            LaunchedEffect(width, viewport) {
                report(PhotosHomeEvent(viewport = PhotosViewport(width = width, height = viewport)))
            }
            val top: @Composable () -> Unit = {
                val banner = state.import_banner
                if (banner != null) {
                    BackupBanner(banner, onEvent)
                    // WHAT BROUGHT THE MEMBER BACK FROM SETTINGS: the grant is read again.
                    if (banner.remedy != PhotosHomeImportBanner.Remedy.REMEDY_UNSPECIFIED) {
                        LifecycleResumeEffect(banner.remedy) {
                            onResume()
                            onPauseOrDispose {}
                        }
                    }
                }
            }
            val loading = library.loading
            val failure = library.failure
            when {
                // THE GRID IS THE LOADING STATE (v0 §14): skeleton tiles at the
                // rung's real geometry, so nothing reflows when the bytes land.
                // Never a spinner.
                loading != null -> Column {
                    top()
                    PhotoGridSkeleton(loading.skeleton, state.chrome?.title.orEmpty())
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

                tiles.isEmpty() -> Column {
                    top()
                    // THE FILTER EMPTIED THE GRID, NOT THE LIBRARY — its own
                    // sentence, never the empty-library copy.
                    data.empty?.let { empty ->
                        ScreenEmpty(
                            sentence = empty.headline,
                            remedy = empty.body,
                            modifier = Modifier.padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp),
                        )
                    }
                }

                grain == PhotosGrain.PHOTOS_GRAIN_YEARS || grain == PhotosGrain.PHOTOS_GRAIN_MONTHS -> {
                    LibraryGrains(
                        items = data.grain_items,
                        years = grain == PhotosGrain.PHOTOS_GRAIN_YEARS,
                        placeDay = library.place_day,
                        complete = data.complete,
                        cellCount = tiles.size,
                        undatedNote = data.undated_note,
                        loadingMoreLabel = data.loading_more_label,
                        listState = listState,
                        top = top,
                        onOpenPeriod = { day -> onEvent(PhotosHomeEvent(period_opened = day)) },
                        onMore = { onEvent(PhotosHomeEvent(next_page = PhotosNextPage())) },
                        onPinch = { scale -> onEvent(pinched(scale, visibleDay.value)) },
                    )
                    ReportVisibleDay(listState, visibleDay) { index -> grainDayAt(data.grain_items, index) }
                }

                else -> {
                    LandOnDay(listState, data, library.place_day)
                    LibraryTimeline(
                        tiles = tiles,
                        rows = data.rows,
                        rung = library.rung,
                        selecting = selection.selecting,
                        selected = selected,
                        complete = data.complete,
                        loadingMoreLabel = data.loading_more_label,
                        scrub = ScrubWords(data.scrub_label, data.scrub_next_label, data.scrub_previous_label),
                        listState = listState,
                        top = top,
                        onTile = { photoId ->
                            if (selection.selecting) {
                                onEvent(PhotosHomeEvent(selection = toggled(photoId)))
                            } else {
                                // A CELL OPENS THE PHOTOGRAPH, and the loaded
                                // library's own order rides along as the
                                // neighbours — so a swipe in the lightbox costs
                                // no read, and it walks the library in the order
                                // the member is looking at.
                                lightboxRoute(data, photoId)?.let(onOpen)
                            }
                        },
                        onPick = { ids, picked ->
                            onEvent(PhotosHomeEvent(selection = pickedSet(ids, picked)))
                        },
                        onFetch = { photoId, _ -> onEvent(PhotosHomeEvent(original_requested = photoId)) },
                        onMore = { onEvent(PhotosHomeEvent(next_page = PhotosNextPage())) },
                        onPinch = { scale -> onEvent(pinched(scale, visibleDay.value)) },
                    )
                    ReportVisibleDay(listState, visibleDay) { index -> dayOfRow(data.rows.getOrNull(index - 1)) }
                }
            }
        }
        // THE GRAIN CONTROL IS PERMANENT WHILE THE LIBRARY HAS PHOTOGRAPHS
        // (v0): absent only while selecting — the bar is then the foot — or
        // when there is nothing to zoom.
        if (!selection.selecting && tiles.isNotEmpty()) {
            val chrome = state.chrome ?: PhotosHomeChrome()
            GrainControl(
                grain = grain,
                labels = listOf(
                    PhotosGrain.PHOTOS_GRAIN_YEARS to chrome.grain_years_label,
                    PhotosGrain.PHOTOS_GRAIN_MONTHS to chrome.grain_months_label,
                    PhotosGrain.PHOTOS_GRAIN_ALL to chrome.grain_all_label,
                ),
            ) { next ->
                onEvent(PhotosHomeEvent(grain = PhotosGrainChanged(grain = next, at_day = visibleDay.value)))
            }
        }
    }
}

/** The lightbox route the library hands out: its template with the tapped photograph's id set. */
private fun lightboxRoute(data: PhotosLibraryData, photoId: String): Route? {
    val template = data.open ?: return null
    val args = template.photos_lightbox ?: return null
    return template.copy(photos_lightbox = args.copy(photo_id = photoId))
}

private fun pinched(scale: Float, day: String): PhotosHomeEvent =
    PhotosHomeEvent(pinched = PhotosPinched(scale = scale, at_day = day))

private fun selectionMode(on: Boolean): PhotosSelectionEvent =
    PhotosSelectionEvent(mode = PhotosSelectionEvent.ModeSet(selecting = on))

private fun toggled(photoId: String): PhotosSelectionEvent =
    PhotosSelectionEvent(toggled = PhotosSelectionEvent.Toggled(photo_id = photoId))

private fun pickedSet(ids: List<String>, picked: Boolean): PhotosSelectionEvent =
    PhotosSelectionEvent(set = PhotosSelectionEvent.SetPicked(photo_ids = ids, selected = picked))

/** Keep [visibleDay] on the day at the top of the list as it scrolls. */
@Composable
private fun ReportVisibleDay(listState: LazyListState, visibleDay: MutableState<String>, dayAt: (Int) -> String) {
    val probe by rememberUpdatedState(dayAt)
    LaunchedEffect(listState) {
        snapshotFlow { listState.firstVisibleItemIndex }.collect { index -> visibleDay.value = probe(index) }
    }
}

/**
 * LAND ON THE DAY A GRAIN SWITCH OR A CARD NAMED, once per distinct day — a
 * member who scrolls away is not pulled back on the next recomposition.
 */
@Composable
private fun LandOnDay(listState: LazyListState, data: PhotosLibraryData, day: String) {
    var landed by remember { mutableStateOf("") }
    LaunchedEffect(day, data.rows) {
        if (day.isEmpty() || day == landed) return@LaunchedEffect
        val rows = data.rows
        val index = rows.indexOfFirst {
            it.kind == centraid.core.v1.PhotosRowKind.PHOTOS_ROW_KIND_DAY && it.day == day
        }.takeIf { it >= 0 }
            ?: rows.indexOfFirst {
                it.kind == centraid.core.v1.PhotosRowKind.PHOTOS_ROW_KIND_MONTH &&
                    it.day.isNotEmpty() && day.startsWith(it.day.take(7))
            }
        if (index >= 0) {
            landed = day
            // Item 0 is the top slot, so a row's item is its index + 1.
            listState.scrollToItem(index + 1)
        }
    }
}

/**
 * THE SELECTION BAR, IN THE BAND'S PLACE (Apple Photos; v0's room took the
 * band away under a selection so a tap aimed at Trash could not land on a
 * destination). Drawn in place of `AppBand` while the library is selecting —
 * the band components themselves are not touched.
 *
 * The band's grammar: one elevated plate on the pill rung with a hairline, a
 * mark over a word per verb. With nothing picked every verb is drawn DISABLED
 * rather than hidden, so the bar does not move under the member's thumb as
 * they pick. Which verbs the bar offers, their words and whether each is
 * enabled are Rust's (`PhotosSelection.actions`); "Send a copy" is the
 * library's own and asks which location travels before it goes.
 */
@Composable
internal fun PhotosSelectionBar(
    selection: PhotosSelection,
    sendCopyLabel: String,
    onEvent: (PhotosHomeEvent) -> Unit,
) {
    val armed = selection.selected_ids.isNotEmpty()
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
            selection.actions.forEach { action ->
                SelectionVerb(verbIcon(action.kind), action.label, action.enabled, Modifier.weight(1f)) {
                    onEvent(
                        PhotosHomeEvent(
                            selection = PhotosSelectionEvent(action = PhotosSelectionEvent.ActionTapped(kind = action.kind)),
                        ),
                    )
                }
                // "SEND A COPY" SITS BESIDE THE HEART, as the bar always had it.
                if (action.kind == PhotosBatchAction.Kind.KIND_FAVORITE ||
                    action.kind == PhotosBatchAction.Kind.KIND_UNFAVORITE
                ) {
                    SelectionVerb("Share", sendCopyLabel, armed, Modifier.weight(1f)) {
                        onEvent(PhotosHomeEvent(copy_asked = centraid.core.v1.PhotosCopyAsked()))
                    }
                }
            }
        }
    }
}

private fun verbIcon(kind: PhotosBatchAction.Kind): String = when (kind) {
    PhotosBatchAction.Kind.KIND_ADD_TO_ALBUM -> "FolderPlus"
    PhotosBatchAction.Kind.KIND_FAVORITE, PhotosBatchAction.Kind.KIND_UNFAVORITE -> "Heart"
    PhotosBatchAction.Kind.KIND_TRASH, PhotosBatchAction.Kind.KIND_DELETE_FOREVER -> "Trash"
    PhotosBatchAction.Kind.KIND_RESTORE -> "Undo"
    PhotosBatchAction.Kind.KIND_ARCHIVE, PhotosBatchAction.Kind.KIND_UNARCHIVE -> "Archive"
    else -> "Check"
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
 * THE CAMERA-ROLL BANNER, AS RUST DECIDED IT: unset when there is nothing to say
 * or do, so a library with photographs and an import that is done draws no line
 * at all, and "Import now" is offered only over an empty library. This view
 * decides none of it; a remedy's tap is an event, and the shell performs it when
 * Rust asks (`PerformScreenEffects`).
 */
@Composable
private fun BackupBanner(banner: PhotosHomeImportBanner, onEvent: (PhotosHomeEvent) -> Unit) {
    val remedy = { which: PhotosHomeImportBanner.Remedy ->
        onEvent(PhotosHomeEvent(remedy = centraid.core.v1.PhotosBannerRemedy(remedy = which)))
    }
    Column(Modifier.padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp, vertical = 8.dp)) {
        if (banner.sentence.isNotEmpty()) {
            Text(text = banner.sentence, style = centraidType("small"), color = centraidColor("text"))
        }
        if (banner.reason.isNotEmpty()) {
            Text(text = banner.reason, style = centraidType("small"), color = centraidColor("textSoft"))
        }
        // AN OS PERMISSION IS A STATE, and each state has its own remedy.
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            when (banner.remedy) {
                PhotosHomeImportBanner.Remedy.REMEDY_ASK ->
                    KitLink(banner.allow_label, onClick = { remedy(PhotosHomeImportBanner.Remedy.REMEDY_ASK) })

                // On Android "denied" is also what a grant nobody has asked for reads
                // as, so the prompt is offered beside Settings.
                PhotosHomeImportBanner.Remedy.REMEDY_SETTINGS -> {
                    KitLink(banner.settings_label, onClick = { remedy(PhotosHomeImportBanner.Remedy.REMEDY_SETTINGS) })
                    KitLink(banner.allow_label, onClick = { remedy(PhotosHomeImportBanner.Remedy.REMEDY_ASK) })
                }

                PhotosHomeImportBanner.Remedy.REMEDY_MANAGE_SELECTION ->
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                        KitLink(banner.manage_label, onClick = { remedy(PhotosHomeImportBanner.Remedy.REMEDY_MANAGE_SELECTION) })
                    }

                PhotosHomeImportBanner.Remedy.REMEDY_UNSPECIFIED -> Unit
            }
            if (banner.import_now) {
                KitLink(label = banner.import_now_label, onClick = { onEvent(PhotosHomeEvent(import_now = PhotosImportNow())) })
            }
        }
    }
}

/**
 * THE SHEETS PHOTOS' HOME OPENS: More, the tile sizes, the camera roll's detail,
 * the location a copy carries, and "Add to album". WHICH ONE IS OPEN IS STATE —
 * read here, beside the band that opens it, so More works from every band and
 * not only from the library body.
 *
 * `more` is a sheet and never a destination. The rows, the sentences and the
 * free-up row are Rust's; the SwiftUI twin is `PhotosMoreSheet.swift`.
 */
@Composable
internal fun PhotosSheets(state: PhotosHomeState, onEvent: (PhotosHomeEvent) -> Unit) {
    // A SWIPE-TO-DISMISS HAS TO REACH RUST TOO, or the state still says MORE with
    // nothing on screen and the next press on `⋮` is a no-op.
    val sheet = { which: PhotosHomeState.Sheet ->
        onEvent(PhotosHomeEvent(sheet = PhotosHomeEvent.SheetEvent(sheet = which)))
    }
    val close = { sheet(PhotosHomeState.Sheet.SHEET_NONE) }
    val more = state.more
    val tileSize = state.tile_size
    val detail = state.backup_detail
    val copyPlace = state.copy_place
    when (state.sheet) {
        PhotosHomeState.Sheet.SHEET_MORE -> if (more != null) {
            SheetRoom(title = more.title, onDismiss = close) {
                more.rows.forEach { row ->
                    SheetRow(
                        label = row.label,
                        iconKey = if (row.key == "tile_size") "Grid" else null,
                        detail = row.meta,
                        testTag = "sheet-option-" + row.key.replace('_', '-'),
                        onTap = {
                            sheet(
                                if (row.key == "tile_size") {
                                    PhotosHomeState.Sheet.SHEET_TILE_SIZE
                                } else {
                                    PhotosHomeState.Sheet.SHEET_BACKUP_DETAIL
                                },
                            )
                        },
                    )
                }
                // ONE CLAUSE ONLY: every other surface is reached from Collections.
                Text(
                    text = more.foot,
                    style = centraidType("small"),
                    color = centraidColor("textSoft"),
                    modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
                )
                more.free_up?.let { row -> FreeUpSpaceRowView(row) { onEvent(PhotosHomeEvent(free_up_tapped = PhotosFreeUpTapped())) } }
            }
        }

        // THE SIZES, XS TO L, the current one checked; picking one closes the choice.
        PhotosHomeState.Sheet.SHEET_TILE_SIZE -> if (tileSize != null) {
            OptionSheet(
                title = tileSize.title,
                options = tileSize.options.map { SheetOption(key = "${it.rung}", label = it.label, selected = it.selected) },
                onPick = { key -> onEvent(PhotosHomeEvent(rung = key.toInt())) },
                onDismiss = close,
            )
        }

        PhotosHomeState.Sheet.SHEET_BACKUP_DETAIL -> if (detail != null) {
            SheetRoom(
                title = detail.title,
                onDismiss = close,
                // AN IMPORT, AND ONLY THAT (#1080). No transport row and no
                // gateway: where the backup stands is the Backup screen's.
                primary = SheetPrimary(
                    label = detail.import_label,
                    enabled = detail.import_enabled,
                    onPress = { onEvent(PhotosHomeEvent(import_now = PhotosImportNow())) },
                ),
                status = detail.status,
            ) {
                Column(
                    Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    detail.rows.forEach { row ->
                        Text(
                            text = row.value,
                            style = centraidType(if (row.key == "Status") "body" else "small"),
                            color = centraidColor(if (row.key == "Status") "text" else "textSoft"),
                        )
                    }
                }
            }
        }

        // HOW MUCH OF THE PLACE TRAVELS, asked every time (#816): a place NAME is
        // one sentence per photograph, and a batch has as many places as photographs.
        PhotosHomeState.Sheet.SHEET_COPY_PLACE -> if (copyPlace != null) {
            OptionSheet(
                title = copyPlace.title,
                options = listOf(
                    SheetOption(key = "none", label = copyPlace.no_location_label),
                    SheetOption(key = "exact", label = copyPlace.exact_location_label),
                ),
                onPick = { key ->
                    onEvent(PhotosHomeEvent(copy_place_chosen = PhotosCopyPlaceChosen(keep_location = key == "exact")))
                },
                onDismiss = close,
            )
        }

        else -> Unit
    }

    // THE SELECTION'S TWO SHEETS: the album choice (one sheet for every "Add to
    // album") and the trash confirm — a confirm is a sheet (D4).
    val choice = state.album_choice
    if (choice != null && choice.open) {
        PhotosAlbumChoiceSheet(
            choice = choice,
            onEvent = { event -> onEvent(PhotosHomeEvent(album_choice = event)) },
        )
    }
    val selection = state.selection
    val confirm = selection?.confirm
    if (selection != null && confirm != null) {
        ConfirmSheet(
            confirm = confirm.toKit(),
            cancelLabel = selection.cancel_label,
            onConfirm = {
                onEvent(PhotosHomeEvent(selection = PhotosSelectionEvent(confirmed = PhotosSelectionEvent.Confirmed())))
            },
            onDismiss = {
                onEvent(PhotosHomeEvent(selection = PhotosSelectionEvent(dismissed = PhotosSelectionEvent.ConfirmDismissed())))
            },
        )
    }
}

/**
 * THE MORE SHEET'S "FREE UP SPACE" ROW (#1080 A19). The title, the census's line,
 * why nothing can be freed (or how much a tap frees) and what the last free-up
 * came to are Rust's; the action is drawn only while it can act, and holds still
 * while the system's confirmation is up.
 *
 * The SwiftUI twin is `FreeUpSpaceRow` in `PhotosMoreSheet.swift`.
 */
@Composable
private fun FreeUpSpaceRowView(row: PhotosFreeUpRow, onFree: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp)
            // ONE SPOKEN ELEMENT: the title and the census's line.
            .semantics(mergeDescendants = true) {},
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            CentraidIcon(iconKey = "Gauge", tint = centraidColor("text"))
            Column {
                Text(text = row.title, style = centraidType("body"), color = centraidColor("text"))
                Text(text = row.meta, style = centraidType("small"), color = centraidColor("textSoft"))
            }
        }
        if (row.reason.isNotEmpty()) {
            Text(text = row.reason, style = centraidType("small"), color = centraidColor("textSoft"))
        }
        if (row.action_label.isNotEmpty()) {
            KitLink(label = row.action_label, onClick = onFree, enabled = row.enabled)
        }
        if (row.notice.isNotEmpty()) {
            Text(text = row.notice, style = centraidType("small"), color = centraidColor("textSoft"))
        }
        // WHAT A PHOTO DELETED FOR GOOD COSTS THE BACKUP DEVICE (#1080 F5).
        if (row.retention.isNotEmpty()) {
            Text(text = row.retention, style = centraidType("small"), color = centraidColor("textSoft"))
        }
    }
}
