package dev.centraid.android.screens.people

import dev.centraid.android.kit.SearchAskRow
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
import centraid.core.v1.PeopleAvatar
import centraid.core.v1.PeopleHomeEvent
import centraid.core.v1.PeopleHomeState
import centraid.core.v1.PeopleRosterData
import centraid.core.v1.PeopleRow
import centraid.core.v1.PeopleSectionHead
import centraid.core.v1.PeopleTouchData
import centraid.core.v1.Route
import centraid.screen.v1.SearchField
import centraid.screen.v1.SectionHead
import centraid.screen.v1.StatusChip
import dev.centraid.android.kit.AppBand
import dev.centraid.android.kit.AppBandTab
import dev.centraid.android.kit.AppPlace
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.IconKey
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.OptionSheet
import dev.centraid.android.kit.OutlineButton
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RoomAction
import dev.centraid.android.kit.RoomChip
import dev.centraid.android.kit.RoomSearch
import dev.centraid.android.kit.RowSkeleton
import dev.centraid.android.kit.SectionHeader
import dev.centraid.android.kit.SheetOption
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.SheetRow
import dev.centraid.android.kit.hueColor
import dev.centraid.android.kit.screenContentOf
import dev.centraid.android.kit.toKit
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * `people.home` (#1135): People (the roster) and Touch (the rails) under one band
 * — Add person top right, the search bar, ONE chip row (the roster's chips, the
 * sort last), More (Trash) an ordinary band tab.
 *
 * THE VIEW DECIDES NOTHING. Every word, chip, count and empty sentence is on
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
                field = SearchField(open_ = search.open, term = search.term, corrected = search.corrected),
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
        // ONE CHIP ROW: the filters, then the sort chip, last.
        chips = state.chips.map { chip ->
            RoomChip(
                testTag = "people-chip-${chip.key.name}",
                label = chip.label,
                count = if (chip.count > 0) chip.count.toString() else "",
                selected = chip.selected,
                spoken = chip.accessibility_label,
            ) { onEvent(PeopleHomeEvent(chip = PeopleHomeEvent.ChipPicked(chip.key))) }
        } + listOfNotNull(
            state.sort_chip?.let { sort ->
                RoomChip(testTag = "people-chip-sort", label = sort.label, chevron = true, spoken = sort.spoken) {
                    onEvent(PeopleHomeEvent(sheet_opened = PeopleHomeEvent.SheetOpened(PeopleHomeState.Sheet.SHEET_ORDER)))
                }
            },
        ),
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
        if (search?.open == true && results != null && !denied) {
            // SEARCH IS A MODE OVER THE SURFACE: its rows while a term reads.
            LazyColumn(Modifier.testTag("people-search-results")) {
                val empty = results.empty
                if (results.rows.isEmpty() && empty != null) {
                    item(key = "empty") { EmptyStateView(empty.toKit(), onAction = null) }
                }
                items(results.rows, key = { "s-" + it.party_id }) { row -> PersonRow(row, onOpen, onEvent) }
                // THE ASK ROW closes the answer, whether or not anything matched (#1097).
                item(key = "ask") { SearchAskRow(search.ask) }
            }
        } else {
            ReadStateView(
                content = screenContentOf(state.loading, state.failure, state.roster ?: state.touch, state.denied),
                onRetry = { onEvent(PeopleHomeEvent(refreshed = PeopleHomeEvent.Refreshed())) },
                retryLabel = chrome?.retry.orEmpty(),
                skeleton = { RowSkeleton(label = chrome?.loading.orEmpty()) },
            ) { data ->
                LazyColumn(Modifier.testTag("people-list")) {
                    when (data) {
                        is PeopleRosterData -> roster(data, chrome?.import_contacts.orEmpty(), onOpen, onEvent)
                        is PeopleTouchData -> touch(data, chrome?.import_contacts.orEmpty(), onOpen, onEvent)
                    }
                }
            }
        }
    }

    val dismiss = { onEvent(PeopleHomeEvent(sheet_closed = PeopleHomeEvent.SheetClosed())) }
    // MORE IS RUST'S ROWS (Trash): never search, sort or a filter.
    if (state.sheet == PeopleHomeState.Sheet.SHEET_MORE && chrome != null) {
        SheetRoom(title = chrome.more_title, onDismiss = dismiss) {
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
    // THE SORT CHIP'S SHEET: the orders, the current one marked.
    if (state.sheet == PeopleHomeState.Sheet.SHEET_ORDER && chrome != null) {
        OptionSheet(
            title = chrome.sort_heading,
            options = state.order_choices.map { SheetOption(key = it.order.name, label = it.label, selected = it.selected) },
            onPick = { key ->
                state.order_choices.firstOrNull { it.order.name == key }?.let {
                    onEvent(PeopleHomeEvent(order = PeopleHomeEvent.OrderPicked(it.order)))
                }
            },
            onDismiss = dismiss,
        )
    }
}

/** The day-one empty state: the phone's contacts are its action (the header's Add person stays). */
@Composable
private fun DayOne(empty: centraid.core.v1.EmptyState, importLabel: String, onEvent: (PeopleHomeEvent) -> Unit) {
    val offersImport = empty.import_source == centraid.core.v1.ImportSource.IMPORT_SOURCE_CONTACTS && importLabel.isNotEmpty()
    val shown = empty.toKit().copy(
        import_source = centraid.screen.v1.ImportSource.IMPORT_SOURCE_UNSPECIFIED,
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

private fun LazyListScope.roster(
    roster: PeopleRosterData,
    importLabel: String,
    onOpen: (Route) -> Unit,
    onEvent: (PeopleHomeEvent) -> Unit,
) {
    val empty = roster.empty
    if (roster.rows.isEmpty() && empty != null) {
        item(key = "empty") { DayOne(empty, importLabel, onEvent) }
    }
    items(roster.rows, key = { it.party_id }) { row -> PersonRow(row, onOpen, onEvent) }
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
