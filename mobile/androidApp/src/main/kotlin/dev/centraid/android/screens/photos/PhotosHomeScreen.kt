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
import centraid.core.v1.PhotosFilter
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
import dev.centraid.android.kit.RoomChip
import dev.centraid.android.kit.RoomSearch
import dev.centraid.android.screens.PhotosCollectionsScreen
import dev.centraid.android.screens.PhotosLibraryBody
import dev.centraid.android.screens.PhotosSearchScreen
import dev.centraid.android.screens.PhotosSelectionBar
import dev.centraid.android.screens.PhotosSheets
import androidx.compose.runtime.remember

/**
 * PHOTOS' ROOT (#1135): the library, Collections and Search, drawn from the view
 * state Rust sends for `photos.home`.
 *
 * THE ROOT'S CHROME IS RUST'S (R-CHROME-1…5): the band's places then More, the
 * filter chips, and every word around them ride [PhotosHomeState], so this only
 * draws them. "Photos" has ONE trailing action — Select on the library (the app
 * with nothing to create), New album on Collections — the search bar, the
 * library's filter chips, the body, and the band at the foot. A selection takes
 * the band's place (Apple Photos; v0's room), so a tap aimed at Trash cannot land
 * on a destination.
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
            // SEARCH IS THE FIELD UNDER THE TITLE (R-CHROME-2): the bar's press moves
            // Photos to Search, whose body is the hits, and the field opens where the
            // bar stood; closing clears the query and returns to the library. Not while
            // selecting — the header is the selection's then.
            search = if (selecting) {
                null
            } else {
                RoomSearch(
                    field = SearchField(
                        open_ = searching,
                        term = search?.query.orEmpty(),
                        corrected = search?.corrected.orEmpty(),
                    ),
                    placeholder = chrome.search_placeholder,
                    onTerm = { query -> onEvent(PhotosHomeEvent(search_term = query)) },
                    onClose = { onEvent(PhotosHomeEvent(search_closed = centraid.core.v1.PhotosSearchClosed())) },
                    label = chrome.search_label,
                    closeLabel = chrome.close_search_label,
                    onOpen = { onEvent(PhotosHomeEvent(search_opened = centraid.core.v1.PhotosSearchOpened())) },
                )
            },
            chips = state.chips.map { chip ->
                RoomChip(
                    testTag = "photos-filter-" +
                        if (chip.filter == PhotosFilter.PHOTOS_FILTER_FAVORITES) "favorites" else "all",
                    label = chip.label,
                    selected = chip.selected,
                    onPress = { onEvent(PhotosHomeEvent(filter = chip.filter)) },
                )
            },
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
                library != null -> PhotosLibraryBody(state, library, onEvent, onOpen)
                else -> Box(Modifier.fillMaxWidth())
            }
        }
        // WHICH SHEET IS OPEN IS STATE — read here, beside the band that opens it,
        // so More works from every band and not only from the library body.
        PhotosSheets(state, onEvent)
    }
}
