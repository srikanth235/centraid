package dev.centraid.android.screens.people

import dev.centraid.android.kit.SearchAskRow
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.onClick
import centraid.core.v1.PeopleIndexLetter
import centraid.core.v1.PeopleMyCard
import centraid.core.v1.PeopleReconnectLine
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.KitText
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.appAccent
import dev.centraid.android.theme.centraidDark
import dev.centraid.design.CentraidScale
import kotlinx.coroutines.launch
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.unit.dp
import centraid.core.v1.FilterMenuCleared
import centraid.core.v1.FilterMenuPicked
import centraid.core.v1.PeopleAvatar
import centraid.core.v1.PeopleHomeEvent
import centraid.core.v1.PeopleHomeState
import centraid.core.v1.PeopleRosterData
import centraid.core.v1.PeopleRow
import centraid.core.v1.PeopleSectionHead
import centraid.core.v1.PeopleTouchData
import centraid.core.v1.Route
import dev.centraid.android.kit.SearchField
import dev.centraid.android.kit.SectionHead
import centraid.core.v1.StatusChip
import dev.centraid.android.kit.AppBand
import dev.centraid.android.kit.AppBandTab
import dev.centraid.android.kit.AppPlace
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.IconKey
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.OutlineButton
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RoomAction
import dev.centraid.android.kit.RoomFilter
import dev.centraid.android.kit.RoomSearch
import dev.centraid.android.kit.RowSkeleton
import dev.centraid.android.kit.SectionHeader
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.SheetRow
import dev.centraid.android.kit.hueColor
import dev.centraid.android.kit.screenContentOf
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * `people.home` (#1135): People (the roster) and Touch (the rails) under one band
 * — Add person top right beside the filter button (the roster's filters with their
 * counts, then the order), More (Trash) an ordinary band tab.
 *
 * THE VIEW DECIDES NOTHING. Every word, filter, count and empty sentence is on
 * [PeopleHomeState], which Rust makes, and every tap is a [PeopleHomeEvent]; a
 * row that opens a page carries its [Route] and a tap hands it to [onOpen].
 */
@Composable
public fun PeopleHomeScreen(
    state: PeopleHomeState,
    onEvent: (PeopleHomeEvent) -> Unit,
    onOpen: (Route) -> Unit,
    onHome: () -> Unit,
) {
    val chrome = state.chrome
    val search = state.search
    val denied = state.denied != null
    val status = state.status?.sentence.orEmpty().ifEmpty {
        state.roster?.status_line ?: state.touch?.status_line ?: ""
    }
    AppPlace(
        app = "people",
        title = state.title,
        trailing = if (denied) {
            null
        } else {
            state.add_person?.let { route ->
                RoomAction("Plus", chrome?.add_person.orEmpty(), "people-add") { onOpen(route) }
            }
        },
        search = if (search != null && !denied) {
            RoomSearch(
                field = SearchField(open_ = search.open_, term = search.term, corrected = search.corrected, corrected_label = search.corrected),
                placeholder = chrome?.search_placeholder.orEmpty(),
                label = chrome?.search_label.orEmpty(),
                closeLabel = chrome?.search_close.orEmpty(),
                onTerm = { term -> onEvent(PeopleHomeEvent(search_term = PeopleHomeEvent.SearchTermChanged(term))) },
                onClose = { onEvent(PeopleHomeEvent(search_closed = PeopleHomeEvent.SearchClosed())) },
                onOpen = { onEvent(PeopleHomeEvent(search_opened = PeopleHomeEvent.SearchOpened())) },
            )
        } else {
            null
        },
        // THE HEADER'S FILTER BUTTON (R-CHROME-3): Rust's menu, the roster's filters with their
        // counts and then its order.
        filter = state.filter_menu?.let { menu ->
            RoomFilter(
                menu = menu,
                onPick = { section, option ->
                    onEvent(PeopleHomeEvent(filter_menu_picked = FilterMenuPicked(section_key = section, option_key = option)))
                },
                onClear = { onEvent(PeopleHomeEvent(filter_menu_cleared = FilterMenuCleared())) },
            )
        },
        status = status,
        // More is an ordinary tab, last, as Rust lists it (R-CHROME-4).
        band = if (state.band.isEmpty()) {
            null
        } else {
            {
                AppBand(
                    app = "people",
                    tabs = state.band.map { AppBandTab(key = it.key, label = it.label, iconKey = it.icon_key, selected = it.current) },
                    onSelect = { key -> onEvent(PeopleHomeEvent(band = PeopleHomeEvent.BandPicked(key))) },
                    onHome = onHome,
                )
            }
        },
    ) {
        val results = search?.results
        if (search?.open_ == true && results != null && !denied) {
            // SEARCH IS A MODE OVER THE SURFACE: its rows while a term reads.
            LazyColumn(Modifier.testTag("people-search-results")) {
                val empty = results.empty
                if (results.rows.isEmpty() && empty != null) {
                    item(key = "empty") { EmptyStateView(empty, onAction = null) }
                }
                items(results.rows, key = { "s-" + it.party_id }) { row -> PersonRow(row, onOpen, onEvent) }
                // THE ASK ROW closes the answer, whether or not anything matched (#1097).
                item(key = "ask") { SearchAskRow(search.ask, onOpen) }
            }
        } else {
            ReadStateView(
                content = screenContentOf(state.loading, state.failure, state.roster ?: state.touch, state.denied),
                onRetry = { onEvent(PeopleHomeEvent(refreshed = PeopleHomeEvent.Refreshed())) },
                retryLabel = chrome?.retry.orEmpty(),
                skeleton = { RowSkeleton(label = chrome?.loading.orEmpty()) },
            ) { data ->
                when (data) {
                    is PeopleRosterData -> RosterList(data, chrome?.import_contacts.orEmpty(), onOpen, onEvent)
                    is PeopleTouchData -> LazyColumn(Modifier.testTag("people-list")) {
                        touch(data, chrome?.import_contacts.orEmpty(), onOpen, onEvent)
                    }
                }
            }
        }
    }

    val dismiss = { onEvent(PeopleHomeEvent(sheet_closed = PeopleHomeEvent.SheetClosed())) }
    // MORE IS RUST'S ROWS (Trash): never search, sort or a filter.
    if (state.sheet == PeopleHomeState.Sheet.SHEET_MORE && chrome != null) {
        SheetRoom(title = chrome.more_title, onDismiss = dismiss, expanded = true) {
            state.more_rows.forEach { row ->
                SheetRow(
                    label = row.label,
                    iconKey = row.icon_key,
                    testTag = "people-more-${row.key}",
                    onTap = {
                        dismiss()
                        row.route?.let(onOpen)
                    },
                )
            }
        }
    }
}

/** The day-one empty state: the phone's contacts are its action (the header's Add person stays). */
@Composable
private fun DayOne(empty: centraid.core.v1.EmptyState, importLabel: String, onEvent: (PeopleHomeEvent) -> Unit) {
    val offersImport = empty.import_source == centraid.core.v1.ImportSource.IMPORT_SOURCE_CONTACTS && importLabel.isNotEmpty()
    val shown = empty.copy(
        import_source = centraid.core.v1.ImportSource.IMPORT_SOURCE_UNSPECIFIED,
        action_label = if (offersImport) importLabel else "",
    )
    EmptyStateView(
        shown,
        onAction = if (offersImport) {
            { onEvent(PeopleHomeEvent(import_contacts = PeopleHomeEvent.ImportContactsTapped())) }
        } else {
            null
        },
    )
}

/**
 * THE ROSTER (#1173): My card, the reconnect line, then the people. Under the Name order they are
 * A to Z in sections (the letter stays at the top while its people scroll) with the index beside
 * them; under any other they are one flat list. Rust sent the sections, the index and where each
 * letter jumps to; this only draws them and scrolls.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun RosterList(
    roster: PeopleRosterData,
    importLabel: String,
    onOpen: (Route) -> Unit,
    onEvent: (PeopleHomeEvent) -> Unit,
) {
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val empty = roster.empty
    // The list's items before the first section: My card, the reconnect line.
    val lead = (if (roster.my_card != null) 1 else 0) + (if (roster.reconnect != null) 1 else 0)
    val starts = remember(roster) {
        var at = lead + roster.rows.size
        roster.sections.associate { section ->
            val start = at
            at += 1 + section.rows.size
            section.key to start
        }
    }
    // The index is put away at the largest text, where its letters would overlap.
    val showIndex = roster.index.isNotEmpty() && LocalDensity.current.fontScale < LARGEST_TEXT_SCALE
    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            state = listState,
            modifier = Modifier.testTag("people-list"),
            contentPadding = PaddingValues(end = if (showIndex) 22.dp else 0.dp),
        ) {
            roster.my_card?.let { card -> item(key = "my-card") { MyCardRow(card, onOpen) } }
            roster.reconnect?.let { line ->
                item(key = "reconnect") {
                    ReconnectLine(line) { onEvent(PeopleHomeEvent(band = PeopleHomeEvent.BandPicked("touch"))) }
                }
            }
            if (roster.rows.isEmpty() && roster.sections.isEmpty() && empty != null) {
                item(key = "empty") { DayOne(empty, importLabel, onEvent) }
            }
            items(roster.rows, key = { it.party_id }) { row -> PersonRow(row, onOpen, onEvent) }
            roster.sections.forEach { section ->
                stickyHeader(key = "s-" + section.key) { SectionLetter(section.title) }
                items(section.rows, key = { it.party_id }) { row -> PersonRow(row, onOpen, onEvent) }
            }
        }
        if (showIndex) {
            IndexRail(roster.index, Modifier.align(Alignment.CenterEnd)) { key ->
                starts[key]?.let { at -> scope.launch { listState.scrollToItem(at) } }
            }
        }
    }
}

/** At this font scale and above the index would not fit its letters. */
private const val LARGEST_TEXT_SCALE = 1.5f

/** A section's letter: 13 semibold in the quiet ink on the page, kept at the top while its people scroll. */
@Composable
private fun SectionLetter(title: String) {
    KitText(
        text = title,
        rung = KitType.Meta,
        color = Surface.meta,
        modifier = Modifier
            .fillMaxWidth()
            .background(Surface.page)
            .padding(start = KitGeometry.GUTTER, end = KitGeometry.GUTTER, top = 10.dp, bottom = 4.dp)
            .semantics { heading() },
    )
}

/**
 * THE INDEX: every letter in the app's colour, the ones with nobody dim; a tap or a drag along it
 * jumps to the letter's section. TalkBack steps through the letters and activates one.
 */
@Composable
private fun IndexRail(letters: List<PeopleIndexLetter>, modifier: Modifier, onJump: (String) -> Unit) {
    val accent = appAccent("people")
    var height by remember { mutableIntStateOf(1) }
    val pick = { y: Float ->
        val at = ((y / height) * letters.size).toInt().coerceIn(0, letters.size - 1)
        onJump(letters[at].section_key)
    }
    Column(
        modifier
            .padding(end = 2.dp)
            .onSizeChanged { height = it.height.coerceAtLeast(1) }
            .pointerInput(letters) { detectTapGestures { offset -> pick(offset.y) } }
            .pointerInput(letters) { detectVerticalDragGestures { change, _ -> pick(change.position.y) } }
            .testTag("people-index"),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        letters.forEach { letter ->
            KitText(
                text = letter.letter,
                rung = KitType.Badge,
                color = accent.text.copy(alpha = if (letter.has_rows) 1f else 0.4f),
                modifier = Modifier
                    .padding(horizontal = 4.dp, vertical = 1.dp)
                    .clearAndSetSemantics {
                        contentDescription = letter.accessibility_label
                        role = Role.Button
                        onClick {
                            onJump(letter.section_key)
                            true
                        }
                    },
            )
        }
    }
}

/** MY CARD: the owner's own card above the list, a 52dp avatar, the name and the words "My card". */
@Composable
private fun MyCardRow(card: PeopleMyCard, onOpen: (Route) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable { card.route?.let(onOpen) }
            .padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp)
            .testTag("people-my-card")
            .clearAndSetSemantics {
                contentDescription = card.accessibility_label
                role = Role.Button
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(card.avatar, size = 52)
        Column(Modifier.padding(start = 12.dp)) {
            KitText(card.name, KitType.Row, Surface.ink, maxLines = 1)
            KitText(card.label, KitType.Meta, Surface.meta, maxLines = 1)
        }
    }
}

/** THE RECONNECT LINE: who is overdue, in a pale pill in the app's colour; a tap is the band's Touch. */
@Composable
private fun ReconnectLine(line: PeopleReconnectLine, onTap: () -> Unit) {
    val accent = appAccent("people")
    val shape = RoundedCornerShape(CentraidScale.cardRadius.dp)
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp)
            .clip(shape)
            .background(accent.wash(centraidDark()))
            .clickable(onClick = onTap)
            .padding(horizontal = 14.dp, vertical = 12.dp)
            .testTag("people-reconnect-line")
            .clearAndSetSemantics {
                contentDescription = line.accessibility_label
                role = Role.Button
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CentraidIcon(iconKey = "Activity", tint = accent.text, size = 20.dp)
        KitText(line.text, KitType.Row, Surface.ink, modifier = Modifier.weight(1f).padding(horizontal = 12.dp))
        KitText(line.action_label, KitType.Row, accent.text, maxLines = 1)
    }
}

private fun LazyListScope.touch(
    touch: PeopleTouchData,
    importLabel: String,
    onOpen: (Route) -> Unit,
    onEvent: (PeopleHomeEvent) -> Unit,
) {
    val empty = touch.empty
    if (empty != null) {
        item(key = "touch-empty") { DayOne(empty, importLabel, onEvent) }
        return
    }
    if (touch.tiles.isNotEmpty()) {
        item(key = "tiles") {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                touch.tiles.forEach { tile ->
                    val shape = RoundedCornerShape(KitGeometry.RADIUS)
                    Column(
                        Modifier
                            .weight(1f)
                            .heightIn(min = 64.dp)
                            .clip(shape)
                            .border(KitGeometry.HAIRLINE, centraidColor("line"), shape)
                            .then(
                                if (tile.tappable) {
                                    Modifier.clickable {
                                        onEvent(PeopleHomeEvent(tile = PeopleHomeEvent.TilePicked(tile.key)))
                                    }
                                } else {
                                    Modifier
                                },
                            )
                            .padding(10.dp)
                            .testTag("people-tile-${tile.key}")
                            .clearAndSetSemantics {
                                contentDescription = tile.accessibility_label
                                if (tile.tappable) role = Role.Button
                            },
                    ) {
                        Text(
                            tile.count.toString(),
                            style = centraidType("title"),
                            color = centraidColor(if (tile.net) "net" else "text"),
                        )
                        Text(tile.label, style = centraidType("annotLabel"), color = centraidColor("textSoft"))
                    }
                }
            }
        }
    }
    touch.reconnect_head?.let { head -> item(key = "reconnect-head") { SectionHeader(head.toKit()) } }
    if (touch.reconnect.isEmpty() && touch.reconnect_empty.isNotEmpty()) {
        item(key = "reconnect-empty") { RailEmpty(touch.reconnect_empty) }
    }
    items(touch.reconnect, key = { "r-" + it.party_id }) { card ->
        CentraidRow(
            title = card.name,
            meta = listOf(card.role, card.detail).filter { it.isNotEmpty() }.joinToString(" · "),
            hueKey = card.avatar?.hue_key.orEmpty(),
            a11y = card.accessibility_label,
            testTag = "people-reconnect-${card.party_id}",
            onTap = { card.route?.let(onOpen) },
        ) {
            if (card.action_label.isNotEmpty()) {
                OutlineButton(
                    label = card.action_label,
                    testTag = "people-log-${card.party_id}",
                    modifier = Modifier.padding(start = 8.dp),
                ) { card.log_route?.let(onOpen) }
            }
        }
    }
    touch.upcoming_head?.let { head -> item(key = "upcoming-head") { SectionHeader(head.toKit()) } }
    if (touch.upcoming.isEmpty() && touch.upcoming_empty.isNotEmpty()) {
        item(key = "upcoming-empty") { RailEmpty(touch.upcoming_empty) }
    }
    items(touch.upcoming, key = { "u-" + it.date_id }) { row ->
        CentraidRow(
            title = row.name,
            meta = listOf(row.label, row.day_label).filter { it.isNotEmpty() }.joinToString(" · "),
            trailing = row.when_label,
            hueKey = row.avatar?.hue_key.orEmpty(),
            a11y = row.accessibility_label,
            testTag = "people-upcoming-${row.date_id}",
            onTap = { row.route?.let(onOpen) },
        )
    }
    touch.recent_head?.let { head -> item(key = "recent-head") { SectionHeader(head.toKit()) } }
    if (touch.recent.isEmpty() && touch.recent_empty.isNotEmpty()) {
        item(key = "recent-empty") { RailEmpty(touch.recent_empty) }
    }
    items(touch.recent, key = { "t-" + it.interaction_id }) { row ->
        CentraidRow(
            title = row.name,
            meta = listOf(row.kind_label, row.text).filter { it.isNotEmpty() }.joinToString(" · "),
            trailing = row.when_label,
            hueKey = row.avatar?.hue_key.orEmpty(),
            a11y = row.accessibility_label,
            testTag = "people-recent-${row.interaction_id}",
            onTap = { row.route?.let(onOpen) },
        )
    }
}

internal fun PeopleSectionHead.toKit(): SectionHead =
    SectionHead(title = title, count = count, verb_label = verb_label)

@Composable
internal fun RailEmpty(sentence: String) {
    Text(
        sentence,
        style = centraidType("annotLabel"),
        color = centraidColor("textSoft"),
        modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
    )
}

/** One roster row: avatar, name over role · meta, every chip in draw order, and the star key. */
@Composable
private fun PersonRow(row: PeopleRow, onOpen: (Route) -> Unit, onEvent: (PeopleHomeEvent) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = KitGeometry.GUTTER)) {
        Avatar(row.avatar)
        Box(Modifier.weight(1f)) {
            CentraidRow(
                title = row.name,
                meta = listOf(row.role, row.meta).filter { it.isNotEmpty() }.joinToString(" · "),
                chips = row.chips.map { chip ->
                    StatusChip(label = chip.label, tone = StatusChip.Tone.fromValue(chip.tone.value) ?: StatusChip.Tone.TONE_UNSPECIFIED)
                },
                a11y = row.accessibility_label,
                testTag = "people-row-${row.party_id}",
                onTap = { row.route?.let(onOpen) },
            )
        }
        IconKey(
            iconKey = "Star",
            label = row.star_label,
            testTag = "people-star-${row.party_id}",
            bordered = row.starred,
            modifier = Modifier.padding(end = 8.dp),
        ) { onEvent(PeopleHomeEvent(star = PeopleHomeEvent.StarToggled(row.party_id))) }
    }
}

/** The avatar: initials on the person's hue. Decorative; the row speaks the name. */
@Composable
internal fun Avatar(avatar: PeopleAvatar?, size: Int = 32) {
    Box(
        Modifier
            .size(size.dp)
            .clip(CircleShape)
            .background(hueColor(avatar?.hue_key.orEmpty()))
            .clearAndSetSemantics { },
        contentAlignment = Alignment.Center,
    ) {
        Text(avatar?.initials.orEmpty(), style = centraidType("smallStrong"), color = centraidColor("onAccent"))
    }
}
