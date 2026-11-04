package dev.centraid.android.screens.photos

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import centraid.core.v1.PhotosDestination
import centraid.core.v1.FilterMenuCleared
import centraid.core.v1.FilterMenuPicked
import centraid.core.v1.PhotosGrain
import centraid.core.v1.PhotosGrainChanged
import centraid.core.v1.PhotosHomeChrome
import centraid.core.v1.PhotosHomeEvent
import centraid.core.v1.PhotosHomeState
import centraid.core.v1.PhotosSelection
import centraid.core.v1.PhotosSelectionEvent
import centraid.core.v1.Route
import dev.centraid.android.kit.SearchField
import dev.centraid.android.kit.AppBand
import dev.centraid.android.kit.AppBandTab
import dev.centraid.android.kit.AppPlace
import dev.centraid.android.kit.RoomAction
import dev.centraid.android.kit.BandSegment
import dev.centraid.android.kit.RoomFilter
import dev.centraid.android.kit.RoomSearch
import dev.centraid.android.screens.PhotosCollectionsScreen
import dev.centraid.android.screens.PhotosLibraryBody
import dev.centraid.android.screens.PhotosSearchScreen
import dev.centraid.android.screens.PhotosSelectionBar
import dev.centraid.android.screens.PhotosSheets
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember

/**
 * PHOTOS' ROOT (#1135): the library, Collections and Search, drawn from the view
 * state Rust sends for `photos.home`.
 *
 * THE ROOT'S CHROME IS RUST'S (R-CHROME-1…5): the band's places then More, the
 * filter menu, and every word around them ride [PhotosHomeState], so this only
 * draws them. "Photos" has ONE trailing action — Select on the library (the app
 * with nothing to create), New album on Collections — beside the filter button's menu,
 * the body, and the band at the foot, the one floating bar, which carries the library's zoom
 * (Years · Months · All) as a segmented control, which the photographs run under and
 * whose trailing key is search. A
 * selection takes the band's place (Apple Photos; v0's room), so a tap aimed at
 * Trash cannot land on a destination.
 *
 * Every tap is a [PhotosHomeEvent]; a row that opens a page carries the [Route]
 * Rust built, handed to [onOpen].
 */
@Composable
internal fun PhotosHomeScreen(
    state: PhotosHomeState,
    onEvent: (PhotosHomeEvent) -> Unit,
    onOpen: (Route) -> Unit,
    onHome: () -> Unit,
) {
    val chrome = state.chrome ?: PhotosHomeChrome()
    val selection = state.selection ?: PhotosSelection()
    val searching = state.destination == PhotosDestination.PHOTOS_DESTINATION_SEARCH
    val collections = state.destination == PhotosDestination.PHOTOS_DESTINATION_COLLECTIONS
    val selecting = !collections && !searching && selection.selecting
    val hasTiles = state.library?.data_?.tiles.orEmpty().isNotEmpty()
    // WHERE THE MEMBER IS STANDING, reported by whichever grain the library draws, so a switch of
    // zoom — a chip in the room's row, out here — can land on the same stretch of time.
    val visibleDay = remember { mutableStateOf("") }
    val focusManager = LocalFocusManager.current
    // A SCROLL THROUGH THE HITS PUTS THE KEYBOARD AWAY, as the system's search
    // does: the member has stopped typing and started looking.
    val dismissOnScroll = remember(focusManager) {
        object : NestedScrollConnection {
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                if (available.y != 0f) focusManager.clearFocus()
                return Offset.Zero
            }
        }
    }
    val search = state.search
    // THE ZOOM, IN THE BAND: Years · Months · All as a segmented control. Whether it is there, its
    // words and which segment is lit are Rust's; a pick carries the day the member is standing on.
    val grainName = { grain: PhotosGrain ->
        when (grain) {
            PhotosGrain.PHOTOS_GRAIN_YEARS -> "years"
            PhotosGrain.PHOTOS_GRAIN_MONTHS -> "months"
            else -> "all"
        }
    }
    val grainSegments = state.grain_segments.map { segment ->
        BandSegment(id = "photos-grain-" + grainName(segment.grain), label = segment.label, selected = segment.selected)
    }
    // THE HEADER'S FILTER BUTTON (R-CHROME-3): All photos · Favorites, Rust's menu.
    val filter = state.filter_menu?.let { menu ->
        RoomFilter(
            menu = menu,
            onPick = { section, option ->
                onEvent(PhotosHomeEvent(filter_menu_picked = FilterMenuPicked(section_key = section, option_key = option)))
            },
            onClear = { onEvent(PhotosHomeEvent(filter_menu_cleared = FilterMenuCleared())) },
        )
    }
    Box(Modifier.fillMaxSize().testTag("photos-home")) {
        AppPlace(
            app = "photos",
            title = if (selecting) selection.title.ifEmpty { chrome.selecting_title } else chrome.title,
            trailing = when {
                searching -> null
                collections -> RoomAction("Plus", chrome.new_album_label, "collections-new-album") {
                    onEvent(PhotosHomeEvent(sheet = PhotosHomeEvent.SheetEvent(sheet = PhotosHomeState.Sheet.SHEET_NEW_ALBUM)))
                }
                selecting -> RoomAction("X", chrome.cancel_label, "photos-library-cancel") {
                    onEvent(PhotosHomeEvent(selection = PhotosSelectionEvent(mode = PhotosSelectionEvent.ModeSet(selecting = false))))
                }
                hasTiles -> RoomAction("CheckCircle", chrome.select_label, "photos-library-select") {
                    onEvent(PhotosHomeEvent(selection = PhotosSelectionEvent(mode = PhotosSelectionEvent.ModeSet(selecting = true))))
                }
                else -> null
            },
            // SEARCH IS THE BAND'S TRAILING KEY (R-CHROME-2): its press moves Photos to
            // Search, whose body is the hits, and the field opens at the foot where the
            // band stood; closing clears the query and returns to the library. While
            // selecting, the selection bar stands in the band's place and carries no key.
            search = if (selecting) {
                null
            } else {
                RoomSearch(
                    field = SearchField(
                        open_ = searching,
                        term = search?.query.orEmpty(),
                        corrected = search?.corrected.orEmpty(),
                        corrected_label = search?.corrected.orEmpty(),
                    ),
                    placeholder = chrome.search_placeholder,
                    onTerm = { query -> onEvent(PhotosHomeEvent(search_term = query)) },
                    onClose = { onEvent(PhotosHomeEvent(search_closed = centraid.core.v1.PhotosSearchClosed())) },
                    label = chrome.search_label,
                    closeLabel = chrome.close_search_label,
                    onOpen = { onEvent(PhotosHomeEvent(search_opened = centraid.core.v1.PhotosSearchOpened())) },
                )
            },
            filter = filter,
            contentUnderBand = true,
            status = state.status?.sentence.orEmpty(),
            band = {
                if (selecting) {
                    // A SELECTION TAKES THE BAND'S PLACE (Apple Photos; v0's room),
                    // so a tap aimed at Trash cannot land on a destination.
                    PhotosSelectionBar(selection, chrome.send_copy_label, onEvent)
                } else {
                    // PLACES, THEN MORE — an ordinary tab, whose press opens the
                    // sheet (`more` is a sheet, never a destination).
                    AppBand(
                        app = "photos",
                        tabs = state.band.map { tab ->
                            AppBandTab(key = tab.key, label = tab.label, iconKey = tab.icon_key, selected = tab.current)
                        },
                        onSelect = { key -> onEvent(PhotosHomeEvent(band = key)) },
                        onHome = onHome,
                        segments = grainSegments,
                        onSegment = { id ->
                            state.grain_segments.firstOrNull { "photos-grain-" + grainName(it.grain) == id }?.let { segment ->
                                onEvent(
                                    PhotosHomeEvent(grain = PhotosGrainChanged(grain = segment.grain, at_day = visibleDay.value)),
                                )
                            }
                        },
                    )
                }
            },
        ) {
            val library = state.library
            val collectionsState = state.collections
            val searchState = state.search
            when {
                searchState != null -> Box(Modifier.fillMaxSize().nestedScroll(dismissOnScroll)) {
                    PhotosSearchScreen(searchState, onEvent, onOpen)
                }
                collectionsState != null -> PhotosCollectionsScreen(state, collectionsState, onEvent, onOpen)
                library != null -> PhotosLibraryBody(state, library, onEvent, onOpen, visibleDay)
                else -> Box(Modifier.fillMaxWidth())
            }
        }
        // WHICH SHEET IS OPEN IS STATE — read here, beside the band that opens it,
        // so More works from every band and not only from the library body.
        PhotosSheets(state, onEvent)
    }
}
