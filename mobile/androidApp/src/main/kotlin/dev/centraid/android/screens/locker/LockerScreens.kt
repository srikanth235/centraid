package dev.centraid.android.screens.locker

import dev.centraid.android.kit.SecureWindow
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.CompositionLocalProvider
import dev.centraid.android.kit.KitText
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.kitTextStyle
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.StateColor
import dev.centraid.android.kit.appAccent
import dev.centraid.android.kit.KitCardGrid
import dev.centraid.android.kit.KitTile
import dev.centraid.android.kit.kitCard
import dev.centraid.android.screens.docs.docsListColor
import dev.centraid.android.kit.LocalAppAccentId
import dev.centraid.android.theme.centraidDark
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.runtime.key
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.sp
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentDataType
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDataType
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import centraid.core.v1.FilterMenuCleared
import centraid.core.v1.FilterMenuPicked
import centraid.core.v1.LockerChoice
import centraid.core.v1.LockerCountdown
import centraid.core.v1.LockerDestination
import centraid.core.v1.LockerEditorEvent
import centraid.core.v1.LockerEditorState
import centraid.core.v1.LockerFieldRow
import centraid.core.v1.LockerFieldSheet
import centraid.core.v1.LockerGenerator
import centraid.core.v1.LockerCategory
import centraid.core.v1.LockerHomeData
import centraid.core.v1.LockerHomeEvent
import centraid.core.v1.LockerHomeState
import centraid.core.v1.LockerInputRow
import centraid.core.v1.LockerItemEvent
import centraid.core.v1.LockerItemState
import centraid.core.v1.LockerRow
import centraid.core.v1.LockerWall
import centraid.core.v1.LockerWallEvent
import centraid.core.v1.Route
import dev.centraid.android.kit.SearchField
import dev.centraid.android.kit.SectionHead
import dev.centraid.android.kit.AppBand
import dev.centraid.android.kit.AppBandTab
import dev.centraid.android.kit.AppMark
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.ChoiceStack
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.FieldRow
import dev.centraid.android.kit.InkButton
import dev.centraid.android.kit.KitChip
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.NoAutofill
import dev.centraid.android.kit.OptionSheet
import dev.centraid.android.kit.OutlineButton
import dev.centraid.android.kit.PushedPage
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RoomAction
import dev.centraid.android.kit.RoomFilter
import dev.centraid.android.kit.RoomSearch
import dev.centraid.android.kit.RowSkeleton
import dev.centraid.android.kit.SectionHeader
import dev.centraid.android.kit.SheetOption
import dev.centraid.android.kit.SheetOutline
import dev.centraid.android.kit.SheetPrimary
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.StatusChipView
import dev.centraid.android.kit.StatusLine
import dev.centraid.android.kit.kitSwitchColors
import dev.centraid.android.kit.screenContentOf
import dev.centraid.android.theme.LocalCentraidTokens
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

// LOCKER'S SCREENS, DRAWN (#1047; #1135). Every word, every phase, every verb
// and every route here is Rust's (`crates/screens/src/locker`): this file draws
// a `ViewState` arm and forwards what the member did as a `ScreenEvent`. The
// OS prompt, the file pickers and the clipboard are generic effects
// (`session/ShellEffects.kt`, `kit/ScreenEffects.kt`); the capture shield is `SecureWindow(state.secure)`.
//
// THE WALL COVERS A SCREEN WHOLE: a view with `wall` set draws the wall and
// nothing of the screen under it.

// ---------------------------------------------------------------------------
// The wall
// ---------------------------------------------------------------------------

@Composable
internal fun LockerWallView(wall: LockerWall, onUnlock: () -> Unit, onWords: () -> Unit) {
    val failing = wall.phase == LockerWall.Phase.PHASE_FAILED || wall.phase == LockerWall.Phase.PHASE_UNAVAILABLE
    LazyColumn(
        Modifier
            .fillMaxSize()
            .testTag("locker-wall")
            .semantics { contentDescription = wall.accessibility_label },
    ) {
        item(key = "mark") {
            // THE LOCK SCREEN (#1173): the lock on a wash of Locker's graphite, the one sentence,
            // what unlocking does, and the one ink button in Locker's fill.
            val accent = appAccent("locker")
            CompositionLocalProvider(LocalAppAccentId provides "locker") {
            Column(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 24.dp)) {
                Box(
                    Modifier.size(64.dp).clip(CircleShape).background(accent.wash(centraidDark())).clearAndSetSemantics { },
                    contentAlignment = Alignment.Center,
                ) { CentraidIcon(iconKey = "Lock", tint = accent.text, size = 28.dp) }
                KitText(wall.title, KitType.Section, Surface.ink, Modifier.padding(top = 16.dp).semantics { heading() })
                if (wall.body.isNotEmpty()) {
                    Text(wall.body, style = kitTextStyle(KitType.Row), color = Surface.body, modifier = Modifier.padding(top = 8.dp))
                }
                if (wall.notice.isNotEmpty()) {
                    Text(
                        wall.notice,
                        style = kitTextStyle(KitType.Meta),
                        color = if (failing) StateColor.Red.text else Surface.meta,
                        modifier = Modifier.padding(top = 12.dp).testTag("locker-wall-notice"),
                    )
                }
                // UNLOCK AND THE WORDS DOOR ARE ALTERNATIVES: one stack, one ink.
                if (wall.unlock_label.isNotEmpty() || wall.words_label.isNotEmpty()) {
                    ChoiceStack(Modifier.padding(top = 20.dp)) {
                        if (wall.unlock_label.isNotEmpty()) {
                            InkButton(label = wall.unlock_label, testTag = "locker-unlock", iconKey = wall.unlock_icon, onPress = onUnlock)
                        }
                        if (wall.words_label.isNotEmpty()) {
                            if (wall.unlock_label.isEmpty()) {
                                InkButton(label = wall.words_label, testTag = "locker-words", onPress = onWords)
                            } else {
                                OutlineButton(label = wall.words_label, testTag = "locker-words", onPress = onWords)
                            }
                        }
                    }
                }
            }
            }
        }
    }
}

/**
 * A SCREEN OR ITS WALL. With a wall the screen is not composed at all; a pushed
 * page keeps a back so the member is never stuck behind it.
 */
@Composable
internal fun LockerCovered(
    wall: LockerWall?,
    backLabel: String,
    onBack: () -> Unit,
    send: (LockerWallEvent) -> Unit,
    onWords: () -> Unit,
    content: @Composable () -> Unit,
) {
    if (wall == null) {
        content()
        return
    }
    PushedPage(title = "", parentTitle = backLabel, onBack = onBack) {
        LockerWallView(
            wall,
            onUnlock = { send(LockerWallEvent(unlock = LockerWallEvent.UnlockTapped())) },
            onWords = onWords,
        )
    }
}

/** `locker.lock`: the wall as a page; Rust sets `finished` and the host pops. */
@Composable
internal fun LockerLockPage(
    state: centraid.core.v1.LockerLockState,
    send: (LockerWallEvent) -> Unit,
    onWords: () -> Unit,
    onClose: () -> Unit,
) {
    SecureWindow(state.secure)
    PushedPage(title = "", parentTitle = state.close_label, onBack = onClose) {
        state.wall?.let { wall ->
            LockerWallView(wall, onUnlock = { send(LockerWallEvent(unlock = LockerWallEvent.UnlockTapped())) }, onWords = onWords)
        }
    }
}

// ---------------------------------------------------------------------------
// locker.home — Items · Review · Generate, More as a sheet; search the bar
// ---------------------------------------------------------------------------

@Composable
internal fun LockerHomeScreen(
    state: LockerHomeState,
    onEvent: (LockerHomeEvent) -> Unit,
    sendWall: (LockerWallEvent) -> Unit,
    onOpen: (Route) -> Unit,
    onWords: () -> Unit,
    onHome: () -> Unit,
) {
    SecureWindow(state.secure)
    val chrome = state.chrome
    val wall = state.wall
    if (wall != null) {
        // A LOCKED LOCKER KEEPS ITS WHOLE BAND: Home, the plate of places dimmed, no search. A place
        // pressed starts the unlock (as the button does) and lands there once it opens.
        dev.centraid.android.kit.AppPlace(
            app = "locker",
            title = chrome?.title.orEmpty(),
            band = if (state.band.isEmpty()) {
                null
            } else {
                {
                    AppBand(
                        app = "locker",
                        tabs = state.band.map {
                            AppBandTab(key = it.key, label = it.label, iconKey = it.icon_key, selected = it.current)
                        },
                        onSelect = { key -> onEvent(LockerHomeEvent(band = LockerHomeEvent.BandPicked(key = key))) },
                        onHome = onHome,
                        locked = state.band_locked,
                    )
                }
            },
        ) {
            LockerWallView(
                wall,
                onUnlock = { sendWall(LockerWallEvent(unlock = LockerWallEvent.UnlockTapped())) },
                onWords = onWords,
            )
        }
        return
    }
    LockerCovered(state.wall, chrome?.title.orEmpty(), onHome, sendWall, onWords) {
        val data = state.data_
        val generating = state.destination == LockerDestination.LOCKER_DESTINATION_GENERATE
        val field = state.search
        dev.centraid.android.kit.AppPlace(
            app = "locker",
            title = chrome?.title.orEmpty(),
            trailing = chrome?.add_label?.takeIf { it.isNotEmpty() }?.let { label ->
                RoomAction("Plus", label, "locker-add") { chrome.add_route?.let(onOpen) }
            },
            // THE LOCK KEY (#1173): cover every item now, Rust's own event.
            lead = chrome?.lock_label?.takeIf { it.isNotEmpty() && state.denied == null }?.let { label ->
                RoomAction("Lock", label, "locker-lock") { onEvent(LockerHomeEvent(lock_requested = LockerHomeEvent.LockRequested())) }
            },
            // SEARCH IS THE ROOM'S BAR (R-CHROME-2), never a tab.
            search = if (state.denied == null) {
                RoomSearch(
                    field = SearchField(open_ = field?.open_ == true, term = field?.term.orEmpty(), answered_term = field?.answered_term.orEmpty(), corrected = field?.corrected.orEmpty()),
                    placeholder = chrome?.search_placeholder.orEmpty(),
                    onTerm = { onEvent(LockerHomeEvent(search_typed = LockerHomeEvent.SearchTyped(term = it))) },
                    onClose = { onEvent(LockerHomeEvent(search_closed = LockerHomeEvent.SearchClosed())) },
                    closeLabel = chrome?.close_label.orEmpty().ifEmpty { KitWords.CLOSE_SEARCH },
                    onOpen = { onEvent(LockerHomeEvent(search_opened = LockerHomeEvent.SearchOpened())) },
                )
            } else {
                null
            },
            // THE ITEMS FILTER IS THE HEADER'S MENU (R-CHROME-3): only Items' data carries it.
            filter = data?.filter_menu?.let { menu ->
                RoomFilter(
                    menu = menu,
                    onPick = { section, option ->
                        onEvent(LockerHomeEvent(filter_menu_picked = FilterMenuPicked(section_key = section, option_key = option)))
                    },
                    onClear = { onEvent(LockerHomeEvent(filter_menu_cleared = FilterMenuCleared())) },
                )
            },
            status = if (generating) "" else data?.status_line.orEmpty(),
            statusLine = state.status?.let { line ->
                { StatusLine(line) {} }
            },
            band = if (state.band.isEmpty()) {
                null
            } else {
                {
                    // MORE IS ONE OF THE TABS (R-CHROME-4), drawn as a tab.
                    AppBand(
                        app = "locker",
                        tabs = state.band.map {
                            AppBandTab(key = it.key, label = it.label, iconKey = it.icon_key, selected = it.current)
                        },
                        onSelect = { key -> onEvent(LockerHomeEvent(band = LockerHomeEvent.BandPicked(key = key))) },
                        onHome = onHome,
                    )
                }
            },
        ) {
            ReadStateView(
                content = screenContentOf(state.loading, state.failure, data, state.denied),
                onRetry = { onEvent(LockerHomeEvent(refreshed = LockerHomeEvent.Refreshed())) },
                retryLabel = chrome?.retry.orEmpty().ifEmpty { KitWords.RETRY },
                skeleton = { RowSkeleton() },
            ) { home ->
                BackHandler(enabled = home.list_title.isNotEmpty()) {
                    onEvent(LockerHomeEvent(category_closed = LockerHomeEvent.CategoryClosed()))
                }
                if (generating) {
                    val generator = home.generator
                    if (generator != null) LockerGeneratorBody(generator, onEvent, onOpen)
                } else {
                    LazyColumn(Modifier.fillMaxSize().testTag("locker-home-list")) {
                        when (state.destination) {
                            LockerDestination.LOCKER_DESTINATION_REVIEW -> reviewTab(home, onOpen)
                            LockerDestination.LOCKER_DESTINATION_SEARCH -> searchTab(state, home, onOpen)
                            else -> itemsTab(home, chrome?.add_route, onOpen, onEvent)
                        }
                    }
                }
            }
        }
        val close = { onEvent(LockerHomeEvent(sheet_closed = LockerHomeEvent.SheetClosed())) }
        when (state.sheet) {
            LockerHomeState.Sheet.SHEET_MORE -> OptionSheet(
                title = chrome?.more_title.orEmpty(),
                options = chrome?.more_rows.orEmpty().map { SheetOption(key = it.key, label = it.label, iconKey = it.icon_key, detail = it.meta) },
                onPick = { key ->
                    val row = chrome?.more_rows?.firstOrNull { it.key == key }
                    val route = row?.route
                    if (route != null) onOpen(route) else onEvent(LockerHomeEvent(more = LockerHomeEvent.MorePicked(key = key)))
                },
                onDismiss = close,
            )
            LockerHomeState.Sheet.SHEET_FACTS -> SheetRoom(title = chrome?.facts_title.orEmpty(), onDismiss = close) {
                chrome?.facts.orEmpty().forEach { fact -> FieldRow(key = fact.label, value = fact.detail) }
            }
            else -> Unit
        }
    }
}

private fun LazyListScope.itemsTab(
    home: LockerHomeData,
    add: Route?,
    onOpen: (Route) -> Unit,
    onEvent: (LockerHomeEvent) -> Unit,
) {
    if (home.list_title.isNotEmpty()) {
        listOfCategory(home, add, onOpen, onEvent)
        return
    }
    // THE LANDING: the six category cards, then Starred and Recently used.
    val empty = home.items_empty
    if (home.status_line.isNotEmpty()) item(key = "landing-note") { LockerNote(home.status_line) }
    if (empty != null) {
        item(key = "empty") {
            Box(Modifier.heightIn(min = 320.dp)) {
                EmptyStateView(empty, onAction = add?.let { route -> { onOpen(route) } })
            }
        }
    }
    if (home.categories.isNotEmpty()) {
        item(key = "categories") {
            KitCardGrid(
                items = home.categories,
                modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
            ) { category ->
                LockerCategoryCard(category) {
                    val route = category.route
                    if (route != null) {
                        onOpen(route)
                    } else {
                        onEvent(LockerHomeEvent(category_picked = LockerHomeEvent.CategoryPicked(key = category.key)))
                    }
                }
            }
        }
    }
    if (home.starred.isNotEmpty()) {
        item(key = "starred") { LockerRowGroup(home.starred_title, home.starred, onOpen) }
    }
    if (home.recent.isNotEmpty()) {
        item(key = "recent") { LockerRowGroup(home.recent_title, home.recent, onOpen) }
    }
}

/** ONE CATEGORY'S LIST: the chevron back (also the system back) returns to the landing. */
private fun LazyListScope.listOfCategory(
    home: LockerHomeData,
    add: Route?,
    onOpen: (Route) -> Unit,
    onEvent: (LockerHomeEvent) -> Unit,
) {
    item(key = "list-head") {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier
                    .heightIn(min = KitGeometry.ROW_MIN)
                    .clickable { onEvent(LockerHomeEvent(category_closed = LockerHomeEvent.CategoryClosed())) }
                    .padding(horizontal = 10.dp)
                    .testTag("locker-category-back")
                    .clearAndSetSemantics { contentDescription = KitWords.backTo(home.list_back_label) },
                contentAlignment = Alignment.Center,
            ) { CentraidIcon(iconKey = "ChevronLeft", tint = Surface.ink, size = 18.dp) }
            KitText(home.list_title, KitType.Section, Surface.ink)
        }
    }
    val empty = home.items_empty
    if (home.rows.isEmpty() && empty != null) {
        item(key = "empty") {
            Box(Modifier.heightIn(min = 320.dp)) {
                EmptyStateView(empty, onAction = add?.let { route -> { onOpen(route) } })
            }
        }
    }
    items(home.rows, key = { "i-" + it.item_id }) { row -> LockerRowView(row) { row.route?.let(onOpen) } }
    if (home.window.isNotEmpty()) item(key = "window") { LockerNote(home.window) }
}

/** A WHITE CARD OF ROWS under a group head: Starred, Recently used. */
@Composable
private fun LockerRowGroup(title: String, rows: List<LockerRow>, onOpen: (Route) -> Unit) {
    Column(Modifier.fillMaxWidth().padding(top = 10.dp)) {
        if (title.isNotEmpty()) {
            KitText(
                title,
                KitType.Group,
                Surface.meta,
                Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp),
            )
        }
        Column(Modifier.padding(horizontal = KitGeometry.GUTTER).kitCard()) {
            rows.forEach { row -> LockerRowView(row) { row.route?.let(onOpen) } }
        }
    }
}

/** ONE CATEGORY CARD: a tile in a list-palette colour, the count, the word. */
@Composable
private fun LockerCategoryCard(category: LockerCategory, onTap: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .kitCard()
            .clickable(onClick = onTap)
            .padding(12.dp)
            .testTag("locker-category-${category.key}")
            .clearAndSetSemantics { contentDescription = category.accessibility_label },
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            KitTile(category.icon_key, size = 30.dp, fill = docsListColor(category.color_key))
            KitText(category.count.toString(), KitType.Title, Surface.ink)
        }
        KitText(category.label, KitType.Row, Surface.ink)
    }
}

private fun LazyListScope.reviewTab(home: LockerHomeData, onOpen: (Route) -> Unit) {
    val clear = home.review_clear
    if (clear != null) {
        item(key = "clear") { Box(Modifier.heightIn(min = 200.dp)) { EmptyStateView(clear, onAction = null) } }
    }
    home.review.forEach { section ->
        item(key = "s-" + section.key) {
            section.head?.let { SectionHeader(SectionHead(title = it.title, count = it.count)) }
            LockerNote(section.reason)
        }
        items(section.rows, key = { "r-" + section.key + "-" + it.item_id }) { row -> LockerRowView(row) { row.route?.let(onOpen) } }
    }
    if (home.review_unchecked.isNotEmpty()) {
        item(key = "unchecked-head") { SectionHeader(SectionHead(title = home.review_unchecked_title)) }
        items(home.review_unchecked, key = { "u-" + it.label }) { fact -> FieldRow(key = fact.label, value = fact.detail) }
    }
    if (home.review_note.isNotEmpty()) item(key = "note") { LockerNote(home.review_note) }
}

private fun LazyListScope.searchTab(state: LockerHomeState, home: LockerHomeData, onOpen: (Route) -> Unit) {
    val term = state.search?.term.orEmpty()
    if (term.isBlank()) {
        // WHAT IS NEVER SEARCHED, said before a term.
        item(key = "note") { LockerNote(state.chrome?.search_note.orEmpty()) }
        return
    }
    val empty = home.search_empty
    if (home.hits.isEmpty() && empty != null) {
        item(key = "empty") { Box(Modifier.heightIn(min = 240.dp)) { EmptyStateView(empty, onAction = null) } }
    }
    items(home.hits, key = { "h-" + it.item_id }) { row -> LockerRowView(row) { row.route?.let(onOpen) } }
}

/** THE ITEM ROW: the type chip, the one kit row, and the star in the app's colour. */
@Composable
internal fun LockerRowView(row: LockerRow, onTap: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onTap).padding(start = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TypeChip(row.type_chip)
        CentraidRow(
            title = row.title,
            modifier = Modifier.weight(1f),
            meta = row.meta,
            chips = row.chips.map { it },
            a11y = row.accessibility_label,
            testTag = "locker-row-${row.item_id}",
            onTap = onTap,
        )
        if (row.starred) {
            // AMBER ONLY MEANS A STATE: the star wears the app's colour.
            CentraidIcon(
                iconKey = "Star",
                tint = appAccent("locker").text,
                size = 14.dp,
                modifier = Modifier.padding(end = KitGeometry.GUTTER).clearAndSetSemantics { },
            )
        }
    }
}

/** The type's two letters in the app's fill, white on it. */
@Composable
private fun TypeChip(letters: String, modifier: Modifier = Modifier, size: androidx.compose.ui.unit.Dp = 32.dp) {
    if (letters.isEmpty()) return
    Box(
        modifier
            .size(size)
            .clip(RoundedCornerShape((size.value * dev.centraid.design.CentraidGeometry.ICON_CHIP_RADIUS_RATIO).dp))
            .background(appAccent("locker").fill)
            .clearAndSetSemantics { },
        contentAlignment = Alignment.Center,
    ) {
        KitText(letters, if (size.value > 40f) KitType.Title else KitType.Badge, androidx.compose.ui.graphics.Color.White)
    }
}

/** THE ITEM'S HERO TILE: the first letter of the title (Rust's `hero_initial`) in white on ink; the ink stays ink in dark. */
@Composable
private fun HeroTile(letter: String, modifier: Modifier = Modifier, size: androidx.compose.ui.unit.Dp = 64.dp) {
    if (letter.isEmpty()) return
    Box(
        modifier
            .size(size)
            .clip(RoundedCornerShape((size.value * dev.centraid.design.CentraidGeometry.ICON_CHIP_RADIUS_RATIO).dp))
            .background(Surface.tile)
            .clearAndSetSemantics { },
        contentAlignment = Alignment.Center,
    ) {
        KitText(letter, KitType.Title, androidx.compose.ui.graphics.Color.White)
    }
}

/** A quiet sentence under a list or a field: Rust's, drawn only when present. */
@Composable
internal fun LockerNote(text: String, modifier: Modifier = Modifier, ink: String = "textSoft") {
    if (text.isEmpty()) return
    Text(
        text,
        style = kitTextStyle(KitType.Meta),
        color = if (ink == "net") StateColor.Red.text else Surface.meta,
        modifier = modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp),
    )
}

/** A row of Rust's choices as kit chips; the selected one is `bgSunken`, never accent. */
@Composable
internal fun LockerChoices(choices: List<LockerChoice>, testTag: String, onPick: (String) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        choices.forEach { choice ->
            KitChip(
                label = choice.label,
                selected = choice.selected,
                modifier = Modifier.testTag("$testTag-${choice.key}"),
                onClick = { onPick(choice.key) },
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Generate — Home's third tab; reads nothing, writes nothing
// ---------------------------------------------------------------------------

@Composable
private fun LockerGeneratorBody(state: LockerGenerator, onEvent: (LockerHomeEvent) -> Unit, onOpen: (Route) -> Unit) {
    LazyColumn(Modifier.fillMaxSize().testTag("locker-generator")) {
        item(key = "output") {
            Column(Modifier.fillMaxWidth().padding(KitGeometry.GUTTER)) {
                // THE OUTPUT AT THE DISPLAY RUNG, in a bordered box. Not
                // selectable: the Copy verb is the one way off the screen.
                Box(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 72.dp)
                        .border(KitGeometry.HAIRLINE, centraidColor("lineStrong"), RoundedCornerShape(KitGeometry.RADIUS))
                        .padding(12.dp)
                        .semantics { contentDescription = state.accessibility_label },
                    contentAlignment = Alignment.CenterStart,
                ) {
                    Text(
                        state.output,
                        style = centraidType("display").copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace),
                        color = centraidColor("text"),
                        modifier = Modifier.testTag("locker-generator-output"),
                    )
                }
                if (state.strength.isNotEmpty()) {
                    Text(state.strength, style = centraidType("annotLabel"), color = centraidColor("textSoft"), modifier = Modifier.padding(top = 6.dp))
                }
                Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (state.regenerate_label.isNotEmpty()) {
                        OutlineButton(state.regenerate_label, testTag = "locker-regenerate") {
                            onEvent(LockerHomeEvent(generator_regenerate = LockerHomeEvent.GeneratorRegenerate()))
                        }
                    }
                    if (state.copy_label.isNotEmpty()) {
                        OutlineButton(state.copy_label, testTag = "locker-generator-copy") {
                            onEvent(LockerHomeEvent(generator_copy = LockerHomeEvent.GeneratorCopy()))
                        }
                    }
                    if (state.use_label.isNotEmpty()) {
                        OutlineButton(state.use_label, testTag = "locker-generator-use") {
                            // THE CANDIDATE GOES TO THE EDITOR IN RUST (a take-once slot); the route carries none of it.
                            onEvent(LockerHomeEvent(generator_used = LockerHomeEvent.GeneratorUsed()))
                            state.use_route?.let(onOpen)
                        }
                    }
                }
            }
        }
        if (state.kinds.isNotEmpty()) {
            item(key = "kinds") {
                LockerLabel(state.kinds_label)
                LockerChoices(state.kinds, testTag = "locker-kind") { key ->
                    onEvent(LockerHomeEvent(generator_kind = LockerHomeEvent.GeneratorKindPicked(key = key)))
                }
            }
        }
        if (state.length_max > state.length_min) {
            item(key = "length") {
                LockerLabel(state.length_label)
                LengthSlider(state) { length ->
                    onEvent(LockerHomeEvent(generator_length = LockerHomeEvent.GeneratorLength(length = length)))
                }
            }
        }
        if (state.include.isNotEmpty()) {
            item(key = "include") {
                LockerLabel(state.include_label)
                LockerChoices(state.include, testTag = "locker-include") { key ->
                    onEvent(LockerHomeEvent(generator_include = LockerHomeEvent.GeneratorIncludeToggled(key = key)))
                }
                LockerNote(state.lookalike_note)
            }
        }
    }
}

/**
 * THE LENGTH, as a slider over Rust's bounds. The thumb moves with the finger
 * and Rust hears each whole step once; the state's `length` replaces the
 * thumb's position whenever it changes.
 */
@Composable
private fun LengthSlider(state: LockerGenerator, onLength: (Int) -> Unit) {
    var position by remember(state.length) { mutableFloatStateOf(state.length.toFloat()) }
    Slider(
        value = position,
        onValueChange = { next ->
            position = next
            val whole = next.toInt()
            if (whole != state.length.toInt()) onLength(whole)
        },
        valueRange = state.length_min.toFloat()..state.length_max.toFloat(),
        steps = (state.length_max.toInt() - state.length_min.toInt() - 1).coerceAtLeast(0),
        colors = SliderDefaults.colors(
            thumbColor = centraidColor("text"),
            activeTrackColor = centraidColor("text"),
            inactiveTrackColor = centraidColor("line"),
        ),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER)
            .testTag("locker-length")
            .semantics { contentDescription = state.length_label },
    )
}

@Composable
internal fun LockerLabel(text: String) {
    if (text.isEmpty()) return
    Text(
        text,
        style = centraidType("eyebrow"),
        color = centraidColor("textSoft"),
        modifier = Modifier.padding(start = KitGeometry.GUTTER, end = KitGeometry.GUTTER, top = 12.dp),
    )
}

// ---------------------------------------------------------------------------
// locker.item
// ---------------------------------------------------------------------------

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun LockerItemScreen(
    state: LockerItemState,
    onEvent: (LockerItemEvent) -> Unit,
    sendWall: (LockerWallEvent) -> Unit,
    onOpen: (Route) -> Unit,
    onWords: () -> Unit,
    onBack: () -> Unit,
) {
    SecureWindow(state.secure)
    val chrome = state.chrome
    var menuOpen by remember { mutableStateOf(false) }
    LockerCovered(state.wall, chrome?.back_label.orEmpty(), onBack, sendWall, onWords) {
        val data = state.data_
        PushedPage(
            title = chrome?.title.orEmpty(),
            parentTitle = chrome?.back_label.orEmpty(),
            onBack = onBack,
            // THE "…" MENU holds the item's verbs (add a field, star, archive, trash).
            more = data?.takeIf { it.gone == null && it.actions.isNotEmpty() }?.let {
                RoomAction("MoreHoriz", chrome?.menu_label.orEmpty(), "locker-item-menu") { menuOpen = true }
            },
            trailing = chrome?.edit_label?.takeIf { it.isNotEmpty() && data?.gone == null }?.let { label ->
                RoomAction("Pencil", label, "locker-item-edit") { chrome.edit_route?.let(onOpen) }
            },
            statusLine = { StatusLine(state.status) { onEvent(LockerItemEvent(status_acted = LockerItemEvent.StatusActed())) } },
        ) {
            ReadStateView(
                content = screenContentOf(state.loading, state.failure, data, state.denied),
                onRetry = { onEvent(LockerItemEvent(refreshed = LockerItemEvent.Refreshed())) },
                retryLabel = chrome?.retry.orEmpty().ifEmpty { KitWords.RETRY },
            ) { item ->
                val gone = item.gone
                if (gone != null) {
                    EmptyStateView(gone, onAction = null)
                    return@ReadStateView
                }
                LazyColumn(Modifier.fillMaxSize().testTag("locker-item")) {
                    item(key = "head") {
                        // THE CENTRED HERO (the Locker item board): the title's first letter on ink, the title with
                        // its star beside it, and the type with when it was last used under that.
                        Column(
                            Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp).testTag("locker-item-head"),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            HeroTile(item.hero_initial)
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                Text(
                                    item.title,
                                    style = kitTextStyle(KitType.Hero),
                                    color = Surface.ink,
                                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                                )
                                if (item.star_label.isNotEmpty()) {
                                    Box(Modifier.testTag("locker-item-star").semantics { contentDescription = item.star_label }) {
                                        CentraidIcon(iconKey = "Star", tint = appAccent("locker").text, size = 18.dp, solid = true)
                                    }
                                }
                            }
                            Text(item.subtitle, style = kitTextStyle(KitType.Meta), color = Surface.meta, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                            if (item.chips.isNotEmpty()) {
                                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    item.chips.forEach { chip -> StatusChipView(chip) }
                                }
                            }
                        }
                        LockerNote(item.trashed_note, ink = "net")
                        LockerNote(item.status_line)
                    }
                    item.sections.forEachIndexed { index, section ->
                        item(key = "sec-$index") { if (section.title.isNotEmpty()) SectionHeader(SectionHead(title = section.title)) }
                        // EACH SECTION IS A WHITE CARD OF ROWS; the verification code is the first.
                        item(key = "card-$index") {
                            Column(Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp).kitCard()) {
                                section.rows.forEach { row ->
                                    LockerFieldView(row) { verb ->
                                        onEvent(LockerItemEvent(verb = LockerItemEvent.VerbTapped(key = row.key, verb = verb)))
                                    }
                                }
                            }
                        }
                        if (section.note.isNotEmpty()) item(key = "sec-note-$index") { LockerNote(section.note) }
                        val change = item.change_password
                        if (change != null && section.rows.any { it.key == "password" }) {
                            item(key = "change-password") {
                                Box(Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp)) {
                                    OutlineButton(change.label, testTag = "locker-item-action-change_password") {
                                        onEvent(LockerItemEvent(action = LockerItemEvent.ActionTapped(key = change.key)))
                                    }
                                }
                            }
                        }
                    }
                    item.links?.let { links ->
                        item(key = "links") {
                            dev.centraid.android.kit.LinkSectionView(links, { link -> onEvent(LockerItemEvent(link = link)) }, onOpen)
                        }
                    }
                    if (item.tags.isNotEmpty()) {
                        item(key = "tags") {
                            SectionHeader(SectionHead(title = item.tags_label))
                            FlowRow(
                                Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER),
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                                verticalArrangement = Arrangement.spacedBy(6.dp),
                            ) {
                                item.tags.forEach { tag ->
                                    Text(
                                        tag,
                                        style = centraidType("annotLabel"),
                                        color = centraidColor("textSoft"),
                                        modifier = Modifier
                                            .border(KitGeometry.HAIRLINE, centraidColor("line"), RoundedCornerShape((LocalCentraidTokens.current.radii["sm"] ?: 0).dp))
                                            .padding(horizontal = 6.dp, vertical = 2.dp),
                                    )
                                }
                            }
                        }
                    }
                    item(key = "memo") {
                        if (item.memo.isNotEmpty() || item.memo_action.isNotEmpty()) {
                            SectionHeader(
                                SectionHead(title = item.memo_label, verb_label = item.memo_action),
                                onVerb = { onEvent(LockerItemEvent(memo_opened = LockerItemEvent.MemoOpened())) },
                            )
                            if (item.memo.isNotEmpty()) {
                                Text(
                                    item.memo,
                                    style = centraidType("body"),
                                    color = centraidColor("text"),
                                    modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp),
                                )
                            }
                        }
                    }
                    // EVERY RECORD KEEPS ITS EARLIER VALUES (#1185): the last content row; it is inside
                    // the item's data, so it is absent while Locker is locked.
                    item.earlier?.let { entry -> item(key = "earlier") { dev.centraid.android.kit.EarlierEntryCard(entry, onOpen) } }
                    item(key = "origin") { dev.centraid.android.kit.OriginLineView(item.origin) }
                }
            }
        }
        if (menuOpen && data != null) {
            OptionSheet(
                title = chrome?.menu_label.orEmpty(),
                options = data.actions.map { SheetOption(key = it.key, label = it.label, destructive = it.destructive) },
                onPick = { key ->
                    menuOpen = false
                    onEvent(LockerItemEvent(action = LockerItemEvent.ActionTapped(key = key)))
                },
                onDismiss = { menuOpen = false },
            )
        }
        state.link_picker?.takeIf { it.open_ }?.let { picker ->
            dev.centraid.android.kit.LinkPickerSheet(picker) { link -> onEvent(LockerItemEvent(link = link)) }
        }
        state.confirm?.let { confirm ->
            ConfirmSheet(
                confirm = confirm,
                onConfirm = { onEvent(LockerItemEvent(confirmed = LockerItemEvent.Confirmed())) },
                onDismiss = { onEvent(LockerItemEvent(dismissed = LockerItemEvent.Dismissed())) },
            )
        }
        state.memo?.let { memo ->
            val close = { onEvent(LockerItemEvent(memo_closed = LockerItemEvent.MemoClosed())) }
            val text = remember { mutableStateOf(TextFieldValue(memo.text, TextRange(memo.text.length))) }
            SheetRoom(
                title = memo.title,
                onDismiss = close,
                primary = SheetPrimary(label = memo.save_label, testTag = "locker-memo-save") {
                    onEvent(LockerItemEvent(memo_saved = LockerItemEvent.MemoSaved()))
                },
                outlines = if (memo.cancel_label.isEmpty()) emptyList() else listOf(SheetOutline(memo.cancel_label, "locker-memo-cancel", onPress = close)),
            ) {
                LockerTextField(
                    text = text,
                    label = memo.title,
                    placeholder = memo.hint,
                    singleLine = false,
                    testTag = "locker-memo-text",
                    onEdit = { onEvent(LockerItemEvent(memo_typed = LockerItemEvent.MemoTyped(text = it))) },
                )
            }
        }
        // THE PASSKEY'S NAME: the memo sheet's shape.
        state.passkey_name?.let { sheet ->
            val close = { onEvent(LockerItemEvent(passkey_name_closed = LockerItemEvent.PasskeyNameClosed())) }
            val text = remember { mutableStateOf(TextFieldValue(sheet.text, TextRange(sheet.text.length))) }
            SheetRoom(
                title = sheet.title,
                onDismiss = close,
                primary = SheetPrimary(label = sheet.save_label, testTag = "locker-passkey-name-save") {
                    onEvent(LockerItemEvent(passkey_name_saved = LockerItemEvent.PasskeyNameSaved()))
                },
                outlines = if (sheet.cancel_label.isEmpty()) emptyList() else listOf(SheetOutline(sheet.cancel_label, "locker-passkey-name-cancel", onPress = close)),
            ) {
                LockerTextField(
                    text = text,
                    label = sheet.title,
                    placeholder = sheet.hint,
                    testTag = "locker-passkey-name-text",
                    onEdit = { onEvent(LockerItemEvent(passkey_name_typed = LockerItemEvent.PasskeyNameTyped(text = it))) },
                )
            }
        }
        // THE CUSTOM FIELD SHEET: one field, added or edited; a sealed value in
        // a password entry the IME neither suggests from nor learns.
        state.field_sheet?.let { sheet -> LockerFieldSheetView(sheet, onEvent) }
    }
}

@Composable
private fun LockerFieldSheetView(sheet: LockerFieldSheet, onEvent: (LockerItemEvent) -> Unit) {
    val close = { onEvent(LockerItemEvent(field_closed = LockerItemEvent.FieldClosed())) }
    val typed = { key: String, value: String -> onEvent(LockerItemEvent(field_typed = LockerItemEvent.FieldTyped(key = key, value_ = value))) }
    val section = rememberSentText(sheet.section)
    val label = rememberSentText(sheet.label)
    SheetRoom(
        title = sheet.title,
        onDismiss = close,
        status = sheet.blocked,
        primary = SheetPrimary(label = sheet.save_label, testTag = "locker-field-save", enabled = sheet.can_save) {
            onEvent(LockerItemEvent(field_saved = LockerItemEvent.FieldSaved()))
        },
        // REMOVE, WHERE THE FIELD CAN BE REMOVED, THEN CANCEL: Save's alternatives.
        outlines = buildList<SheetOutline> {
            if (sheet.remove_label.isNotEmpty()) {
                add(SheetOutline(sheet.remove_label, "locker-field-remove", ink = "net") {
                    onEvent(LockerItemEvent(field_removed = LockerItemEvent.FieldRemoved()))
                })
            }
            if (sheet.cancel_label.isNotEmpty()) add(SheetOutline(sheet.cancel_label, "locker-field-cancel", onPress = close))
        },
    ) {
        LockerTextField(
            text = section.first,
            label = sheet.section_label,
            placeholder = sheet.section_hint,
            testTag = "locker-field-section",
            onEdit = {
                section.second(it)
                typed("section", it)
            },
        )
        LockerTextField(
            text = label.first,
            label = sheet.label_label,
            placeholder = sheet.label_hint,
            testTag = "locker-field-label",
            onEdit = {
                label.second(it)
                typed("label", it)
            },
        )
        if (sheet.kinds.isNotEmpty()) {
            LockerLabel(sheet.kind_label)
            LockerChoices(sheet.kinds, "locker-field-kind") { key -> onEvent(LockerItemEvent(field_kind = LockerItemEvent.FieldKindPicked(key = key))) }
        }
        // A NEW ENTRY WHEN THE KIND CHANGES, so a plain value never lingers in a field that has become a secret one.
        androidx.compose.runtime.key(sheet.secret) {
            val value = rememberSentText(sheet.value_)
            LockerTextField(
                text = value.first,
                label = sheet.value_label,
                placeholder = sheet.value_hint,
                secret = sheet.secret,
                singleLine = sheet.secret,
                keyboard = if (sheet.secret) KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false) else KeyboardOptions.Default,
                testTag = "locker-field-value",
                onEdit = {
                    value.second(it)
                    typed("value", it)
                },
            )
        }
        LockerNote(sheet.value_note, ink = "textFaint")
    }
}

/**
 * A FIELD ROW WITH VERBS. Sealed and concealed, it draws Rust's mask; revealed,
 * the plaintext and the countdown note. The value is plain `Text`, which
 * Compose never makes selectable — Copy is the one way off the screen.
 */
@Composable
internal fun LockerFieldView(row: LockerFieldRow, onVerb: (String) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = KitGeometry.ROW_MIN)
            .padding(start = 14.dp, end = 8.dp, top = 6.dp, bottom = 6.dp)
            .testTag("locker-field-${row.key}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(
            Modifier
                .weight(1f)
                .then(
                    if (row.accessibility_label.isNotEmpty()) {
                        Modifier.clearAndSetSemantics { contentDescription = row.accessibility_label }
                    } else {
                        Modifier.semantics(mergeDescendants = true) { }
                    },
                ),
        ) {
            KitText(row.label, KitType.Meta, Surface.meta)
            val concealed = row.sealed_ && !row.revealed
            val shown = if (concealed) row.mask else row.value_
            val mono = row.monospace || concealed
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    shown,
                    style = if (mono) {
                        (if (row.key == "otp_seed") kitTextStyle(KitType.Title).copy(fontSize = 28.sp) else centraidType("body")).copy(
                            fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                            letterSpacing = if (concealed) androidx.compose.ui.unit.TextUnit(2f, androidx.compose.ui.unit.TextUnitType.Sp) else androidx.compose.ui.unit.TextUnit.Unspecified,
                        )
                    } else {
                        centraidType("body")
                    },
                    color = centraidColor(if (concealed) "textSoft" else "text"),
                    modifier = Modifier.testTag("locker-value-${row.key}"),
                )
                row.countdown?.takeIf { !concealed }?.let { LockerCountdownRing(it) }
            }
            if (row.note.isNotEmpty()) {
                Text(row.note, style = centraidType("annotLabel"), color = centraidColor("textFaint"))
            }
        }
        row.verbs.forEach { verb ->
            if (verb.pill) {
                // THE CODE CARD'S COPY: a green pill, as the board draws it.
                Text(
                    verb.label,
                    style = centraidType("smallStrong"),
                    color = StateColor.Green.text,
                    modifier = Modifier
                        .padding(start = 6.dp)
                        .heightIn(min = 36.dp)
                        .clip(CircleShape)
                        .background(StateColor.Green.tint)
                        .clickable { onVerb(verb.key) }
                        .padding(horizontal = 14.dp, vertical = 9.dp)
                        .testTag("locker-verb-${row.key}-${verb.key}"),
                )
            } else {
                OutlineButton(verb.label, testTag = "locker-verb-${row.key}-${verb.key}", modifier = Modifier.padding(start = 6.dp)) {
                    onVerb(verb.key)
                }
            }
        }
    }
}

/**
 * A ONE-TIME CODE'S LIFE: a small ring that empties as the step runs out. The
 * seconds are in the row's note too, so the ring carries no semantics.
 */
@Composable
private fun LockerCountdownRing(countdown: LockerCountdown) {
    val fraction = if (countdown.period > 0) (countdown.seconds_left.toFloat() / countdown.period.toFloat()).coerceIn(0f, 1f) else 0f
    val track = centraidColor("line")
    val ink = centraidColor(if (countdown.seconds_left <= 5) "net" else "textSoft")
    Canvas(
        Modifier
            .padding(start = 8.dp)
            .size(14.dp)
            .testTag("locker-code-countdown"),
    ) {
        val stroke = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round)
        drawArc(track, startAngle = 0f, sweepAngle = 360f, useCenter = false, style = stroke)
        drawArc(ink, startAngle = -90f, sweepAngle = 360f * fraction, useCenter = false, style = stroke)
    }
}

// ---------------------------------------------------------------------------
// locker.editor — add or edit, explicit Save
// ---------------------------------------------------------------------------

@Composable
internal fun LockerEditorScreen(
    state: LockerEditorState,
    onEvent: (LockerEditorEvent) -> Unit,
    sendWall: (LockerWallEvent) -> Unit,
    onWords: () -> Unit,
    onClose: () -> Unit,
) {
    SecureWindow(state.secure)
    val chrome = state.chrome
    LockerCovered(state.wall, chrome?.cancel_label.orEmpty(), onClose, sendWall, onWords) {
        val data = state.data_
        val cancel = { onEvent(LockerEditorEvent(cancel = LockerEditorEvent.CancelTapped())) }
        // NOT AUTOSAVE: back asks Rust, which confirms a dirty leave.
        BackHandler(onBack = cancel)
        // LOCKER IS THE PASSWORD STORE: no autofill service is offered what is typed here.
        NoAutofill()
        PushedPage(
            title = chrome?.title.orEmpty(),
            parentTitle = chrome?.cancel_label.orEmpty(),
            backSpoken = chrome?.cancel_label?.ifEmpty { null },
            onBack = cancel,
            trailing = if (data?.can_save == true && chrome?.save_label.orEmpty().isNotEmpty()) {
                RoomAction("Check", chrome!!.save_label, "locker-editor-save") { onEvent(LockerEditorEvent(save = LockerEditorEvent.SaveTapped())) }
            } else {
                null
            },
            status = state.status?.sentence.orEmpty().ifEmpty { data?.blocked.orEmpty() },
        ) {
            ReadStateView(
                content = screenContentOf(state.loading, state.failure, data, state.denied),
                onRetry = null,
            ) { editor ->
                LazyColumn(Modifier.fillMaxSize().testTag("locker-editor")) {
                    item(key = "lede") { LockerNote(chrome?.lede.orEmpty()) }
                    if (editor.types.isNotEmpty()) {
                        item(key = "types") {
                            LockerLabel(editor.types_label)
                            LockerChoices(editor.types, testTag = "locker-type") { key ->
                                onEvent(LockerEditorEvent(type = LockerEditorEvent.TypePicked(key = key)))
                            }
                        }
                    }
                    // THE FIELDS ARE ONE WHITE CARD, as on iOS: each input, the tags, the compromised
                    // flag, a hairline under each.
                    item(key = "fields-" + state.item_id) {
                        Column(
                            Modifier
                                .fillMaxWidth()
                                .padding(horizontal = KitGeometry.GUTTER)
                                .padding(top = 8.dp)
                                .kitCard(),
                        ) {
                            editor.inputs.forEach { input ->
                                key("in-" + state.item_id + "-" + input.key) {
                                    LockerInputView(input, onEvent)
                                    LockerHairline()
                                }
                            }
                            val text = rememberSentText(editor.tags_text)
                            LockerTextField(
                                text = text.first,
                                label = editor.tags_label,
                                placeholder = editor.tags_hint,
                                testTag = "locker-editor-tags",
                                onEdit = {
                                    text.second(it)
                                    onEvent(LockerEditorEvent(tags = LockerEditorEvent.TagsTyped(text = it)))
                                },
                            )
                            if (editor.compromised_label.isNotEmpty()) {
                                LockerHairline()
                                LockerCompromisedRow(editor.compromised_label, editor.compromised, editor.compromised_note) { on ->
                                    onEvent(LockerEditorEvent(compromised = LockerEditorEvent.CompromisedToggled(on = on)))
                                }
                            }
                        }
                    }
                }
            }
        }
        state.confirm?.let { confirm ->
            ConfirmSheet(
                confirm = confirm,
                onConfirm = { onEvent(LockerEditorEvent(confirmed = LockerEditorEvent.Confirmed())) },
                onDismiss = { onEvent(LockerEditorEvent(dismissed = LockerEditorEvent.Dismissed())) },
            )
        }
    }
}

/** The hairline between the rows of a card. */
@Composable
internal fun LockerHairline() {
    androidx.compose.foundation.layout.Spacer(
        Modifier.padding(start = KitGeometry.GUTTER).fillMaxWidth().height(KitGeometry.HAIRLINE).background(Surface.line),
    )
}

/** ONE INPUT. A secret is a masked entry on the password keyboard, which the IME neither autocorrects, suggests from nor learns. */
@Composable
private fun LockerInputView(input: LockerInputRow, onEvent: (LockerEditorEvent) -> Unit) {
    val text = rememberSentText(input.value_)
    Column(Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) {
                LockerTextField(
                    text = text.first,
                    label = input.label,
                    placeholder = input.placeholder,
                    secret = input.secret,
                    singleLine = input.kind != LockerInputRow.Kind.KIND_MULTILINE,
                    keyboard = keyboardOf(input),
                    testTag = "locker-input-${input.key}",
                    onEdit = {
                        text.second(it)
                        onEvent(LockerEditorEvent(typed = LockerEditorEvent.Typed(key = input.key, value_ = it)))
                    },
                )
            }
            if (input.generate_label.isNotEmpty()) {
                OutlineButton(input.generate_label, testTag = "locker-generate-${input.key}", modifier = Modifier.padding(end = KitGeometry.GUTTER)) {
                    onEvent(LockerEditorEvent(generate = LockerEditorEvent.GenerateTapped(key = input.key)))
                }
            }
        }
        if (input.note.isNotEmpty()) {
            Text(
                input.note,
                style = centraidType("annotLabel"),
                color = centraidColor("textFaint"),
                modifier = Modifier.padding(horizontal = KitGeometry.GUTTER),
            )
        }
    }
}

/** THE COMPROMISED FLAG: a switch row with its note under it; Rust says what the note is. */
@Composable
private fun LockerCompromisedRow(label: String, on: Boolean, note: String, onToggle: (Boolean) -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = KitGeometry.ROW_MIN)
                .toggleable(value = on, role = Role.Switch, onValueChange = onToggle)
                .padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp)
                .testTag("locker-editor-compromised"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(label, style = centraidType("body"), color = centraidColor("text"), modifier = Modifier.weight(1f))
            Switch(checked = on, onCheckedChange = null, colors = kitSwitchColors())
        }
        if (note.isNotEmpty()) {
            Text(note, style = centraidType("annotLabel"), color = centraidColor("textFaint"), modifier = Modifier.padding(horizontal = KitGeometry.GUTTER))
        }
    }
}

private fun keyboardOf(input: LockerInputRow): KeyboardOptions = when {
    input.secret -> KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false)
    input.kind == LockerInputRow.Kind.KIND_EMAIL -> KeyboardOptions(keyboardType = KeyboardType.Email, autoCorrectEnabled = false)
    input.kind == LockerInputRow.Kind.KIND_URL -> KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false)
    input.kind == LockerInputRow.Kind.KIND_PHONE -> KeyboardOptions(keyboardType = KeyboardType.Phone)
    input.kind == LockerInputRow.Kind.KIND_NUMBER -> KeyboardOptions(keyboardType = KeyboardType.Number, autoCorrectEnabled = false)
    else -> KeyboardOptions.Default
}

/**
 * TYPING THAT CANNOT DROP A KEYSTROKE, and a value Rust changed that still
 * lands. The member's text lives here; every value this field sent is
 * remembered, so an answer that merely echoes one of them never overwrites what
 * is typed now, while a value the member did not type — the item loaded, a
 * generated password — replaces it.
 */
@Composable
internal fun rememberSentText(value: String): Pair<MutableState<TextFieldValue>, (String) -> Unit> {
    val text = remember { mutableStateOf(TextFieldValue(value, TextRange(value.length))) }
    val sent = remember { mutableSetOf(value) }
    if (value != text.value.text && value !in sent) {
        text.value = TextFieldValue(value, TextRange(value.length))
        sent.clear()
        sent.add(value)
    }
    return text to { next: String -> sent.add(next) }
}

@Composable
internal fun LockerTextField(
    text: MutableState<TextFieldValue>,
    label: String,
    placeholder: String,
    testTag: String,
    onEdit: (String) -> Unit,
    secret: Boolean = false,
    singleLine: Boolean = true,
    keyboard: KeyboardOptions = KeyboardOptions.Default,
) {
    Column(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp)) {
        if (label.isNotEmpty()) Text(label, style = centraidType("eyebrow"), color = centraidColor("textSoft"))
        Box(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 40.dp)
                .border(KitGeometry.HAIRLINE, centraidColor("line"), RoundedCornerShape(KitGeometry.RADIUS))
                .padding(horizontal = 10.dp, vertical = 8.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            if (text.value.text.isEmpty() && placeholder.isNotEmpty()) {
                Text(placeholder, style = centraidType("body"), color = centraidColor("textFaint"), modifier = Modifier.clearAndSetSemantics { })
            }
            BasicTextField(
                value = text.value,
                onValueChange = { next ->
                    val changed = next.text != text.value.text
                    text.value = next
                    if (changed) onEdit(next.text)
                },
                singleLine = singleLine,
                keyboardOptions = keyboard,
                visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
                textStyle = centraidType("body").copy(
                    color = centraidColor("text"),
                    fontFamily = if (secret) androidx.compose.ui.text.font.FontFamily.Monospace else centraidType("body").fontFamily,
                ),
                cursorBrush = SolidColor(centraidColor("text")),
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag(testTag)
                    .semantics {
                        contentDescription = label.ifEmpty { placeholder }
                        contentDataType = ContentDataType.None
                    },
            )
        }
    }
}
