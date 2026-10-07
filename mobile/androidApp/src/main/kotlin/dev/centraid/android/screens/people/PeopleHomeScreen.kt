package dev.centraid.android.screens.people

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.unit.dp
import centraid.screen.v1.PeopleAvatar
import centraid.screen.v1.PeopleHomeEvent
import centraid.screen.v1.PeopleHomeState
import centraid.screen.v1.PeopleRosterData
import centraid.screen.v1.PeopleRow
import centraid.screen.v1.PeopleTouchData
import centraid.screen.v1.WriteState
import dev.centraid.android.kit.AppBand
import dev.centraid.android.kit.AppBandTab
import dev.centraid.android.kit.AppPlace
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.IconKey
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.QuietButton
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RoomAction
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
 * PEOPLE'S HOME (#1029 app port): People (the roster) and Touch (the rails)
 * under one band, search a field over the current surface, More a sheet.
 *
 * The view decides nothing: every word, chip, count and empty sentence is on
 * [PeopleHomeState], and every tap is a [PeopleHomeEvent]. The intents
 * (`PersonPicked`, `AddPersonRequested`, `TrashRequested`,
 * `LogTouchRequested`) are forwarded like any event; the route reads them
 * off the way and moves the stack.
 */
@Composable
public fun PeopleHomeScreen(
    state: PeopleHomeState,
    onEvent: (PeopleHomeEvent) -> Unit,
    onHome: () -> Unit,
) {
    val chrome = state.chrome
    val search = state.search
    val write = state.write
    val status = when {
        write?.phase == WriteState.Phase.PHASE_REFUSED -> write.failure?.sentence.orEmpty()
        state.status.isNotEmpty() -> state.status
        else -> state.data_?.roster?.status_line ?: state.data_?.touch?.status_line ?: ""
    }
    AppPlace(
        app = "people",
        title = chrome?.title.orEmpty(),
        trailing = chrome?.let {
            RoomAction("UserPlus", it.add_person, "people-add") {
                onEvent(PeopleHomeEvent(add_person = PeopleHomeEvent.AddPersonRequested()))
            }
        },
        search = if (search != null) {
            RoomSearch(
                field = search,
                placeholder = chrome?.search_placeholder.orEmpty(),
                label = chrome?.search_label.orEmpty(),
                closeLabel = chrome?.search_close.orEmpty(),
                onTerm = { term -> onEvent(PeopleHomeEvent(search_term = PeopleHomeEvent.SearchTermChanged(term))) },
                onClose = { onEvent(PeopleHomeEvent(search_closed = PeopleHomeEvent.SearchClosed())) },
            )
        } else {
            null
        },
        status = status,
        band = {
            AppBand(
                app = "people",
                tabs = state.band.filter { it.key != "more" }.map {
                    AppBandTab(key = it.key, label = it.label, iconKey = it.icon_key, selected = it.current)
                },
                onSelect = { key -> onEvent(PeopleHomeEvent(band = PeopleHomeEvent.BandPicked(key))) },
                onHome = onHome,
                onMore = if (state.band.any { it.key == "more" }) {
                    { onEvent(PeopleHomeEvent(band = PeopleHomeEvent.BandPicked("more"))) }
                } else {
                    null
                },
            )
        },
    ) {
        val searchData = state.search_data
        if (search?.open_ == true) {
            // SEARCH IS A MODE OVER THE SURFACE: its rows while a term reads.
            if (searchData != null) {
                LazyColumn(Modifier.testTag("people-search-results")) {
                    val empty = searchData.empty
                    if (searchData.rows.isEmpty() && empty != null) {
                        item(key = "empty") { EmptyStateView(empty, onAction = null) }
                    }
                    items(searchData.rows, key = { "s-" + it.party_id }) { row -> PersonRow(row, onEvent) }
                }
            }
        } else {
            ReadStateView(
                content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
                onRetry = { onEvent(PeopleHomeEvent(refreshed = PeopleHomeEvent.Refreshed())) },
                retryLabel = chrome?.retry.orEmpty(),
                skeleton = { RowSkeleton(label = chrome?.loading.orEmpty()) },
            ) { data ->
                val roster = data.roster
                val touch = data.touch
                LazyColumn(Modifier.testTag("people-list")) {
                    item(key = "search-open") {
                        SearchOpener(chrome?.search_placeholder.orEmpty()) {
                            onEvent(PeopleHomeEvent(search_opened = PeopleHomeEvent.SearchOpened()))
                        }
                    }
                    if (roster != null) roster(roster, onEvent)
                    if (touch != null) touch(touch, onEvent)
                }
            }
        }
    }

    if (state.sheet == PeopleHomeState.Sheet.SHEET_MORE && chrome != null) {
        SheetRoom(
            title = chrome.more_title,
            onDismiss = { onEvent(PeopleHomeEvent(sheet_closed = PeopleHomeEvent.SheetClosed())) },
        ) {
            if (state.order_choices.isNotEmpty()) {
                Text(
                    chrome.sort_heading,
                    style = centraidType("eyebrow"),
                    color = centraidColor("textSoft"),
                    modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp),
                )
                state.order_choices.forEach { choice ->
                    SheetRow(
                        label = choice.label,
                        selected = choice.selected,
                        testTag = "people-order-${choice.order.name}",
                        onTap = { onEvent(PeopleHomeEvent(order = PeopleHomeEvent.OrderPicked(choice.order))) },
                    )
                }
            }
            SheetRow(
                label = chrome.trash_label,
                iconKey = "Trash",
                testTag = "people-more-trash",
                onTap = { onEvent(PeopleHomeEvent(trash = PeopleHomeEvent.TrashRequested())) },
            )
        }
    }
}

/** A quiet field-shaped key under the header: tapping it opens search. */
@Composable
internal fun SearchOpener(placeholder: String, onOpen: () -> Unit) {
    val shape = RoundedCornerShape(KitGeometry.RADIUS)
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp)
            .heightIn(min = KitGeometry.ROW_MIN)
            .clip(shape)
            .background(centraidColor("bgSunken"))
            .border(KitGeometry.HAIRLINE, centraidColor("line"), shape)
            .clickable(onClick = onOpen)
            .padding(horizontal = 12.dp)
            .testTag("search-opener")
            .clearAndSetSemantics {
                contentDescription = placeholder
                role = Role.Button
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CentraidIcon(iconKey = "Search", tint = centraidColor("textFaint"), size = 16.dp)
        Text(
            placeholder,
            style = centraidType("body"),
            color = centraidColor("textFaint"),
            modifier = Modifier.padding(start = 8.dp),
        )
    }
}

private fun LazyListScope.roster(roster: PeopleRosterData, onEvent: (PeopleHomeEvent) -> Unit) {
    if (roster.chips.isNotEmpty()) {
        item(key = "chips") {
            Row(
                Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                roster.chips.forEach { chip ->
                    FilterChip(
                        label = if (chip.count > 0) "${chip.label} ${chip.count}" else chip.label,
                        spoken = chip.accessibility_label.ifEmpty { chip.label },
                        selected = chip.selected,
                        testTag = "people-chip-${chip.key.name}",
                    ) { onEvent(PeopleHomeEvent(chip = PeopleHomeEvent.ChipPicked(chip.key))) }
                }
            }
        }
    }
    val empty = roster.empty
    if (roster.rows.isEmpty() && empty != null) {
        item(key = "empty") {
            EmptyStateView(empty, onAction = { onEvent(PeopleHomeEvent(add_person = PeopleHomeEvent.AddPersonRequested())) })
        }
    }
    items(roster.rows, key = { it.party_id }) { row -> PersonRow(row, onEvent) }
}

private fun LazyListScope.touch(touch: PeopleTouchData, onEvent: (PeopleHomeEvent) -> Unit) {
    val empty = touch.empty
    if (empty != null) {
        item(key = "touch-empty") { EmptyStateView(empty, onAction = null) }
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
                                contentDescription = tile.accessibility_label.ifEmpty { "${tile.label}, ${tile.count}" }
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
    touch.reconnect_head?.let { head -> item(key = "reconnect-head") { SectionHeader(head) } }
    if (touch.reconnect.isEmpty() && touch.reconnect_empty.isNotEmpty()) {
        item(key = "reconnect-empty") { RailEmpty(touch.reconnect_empty) }
    }
    items(touch.reconnect, key = { "r-" + it.party_id }) { card ->
        CentraidRow(
            title = card.name,
            meta = listOf(card.role, card.detail).filter { it.isNotEmpty() }.joinToString(" · "),
            hueKey = card.avatar?.hue_key.orEmpty(),
            testTag = "people-reconnect-${card.party_id}",
            onTap = { onEvent(PeopleHomeEvent(person = PeopleHomeEvent.PersonPicked(card.party_id, card.name))) },
        ) {
            if (card.action_label.isNotEmpty()) {
                QuietButton(
                    label = card.action_label,
                    testTag = "people-log-${card.party_id}",
                    modifier = Modifier.padding(start = 8.dp),
                ) {
                    onEvent(PeopleHomeEvent(log_touch = PeopleHomeEvent.LogTouchRequested(card.party_id, card.name)))
                }
            }
        }
    }
    touch.upcoming_head?.let { head -> item(key = "upcoming-head") { SectionHeader(head) } }
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
            onTap = { onEvent(PeopleHomeEvent(person = PeopleHomeEvent.PersonPicked(row.party_id, row.name))) },
        )
    }
    touch.recent_head?.let { head -> item(key = "recent-head") { SectionHeader(head) } }
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
            onTap = { onEvent(PeopleHomeEvent(person = PeopleHomeEvent.PersonPicked(row.party_id, row.name))) },
        )
    }
}

@Composable
private fun RailEmpty(sentence: String) {
    Text(
        sentence,
        style = centraidType("annotLabel"),
        color = centraidColor("textSoft"),
        modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
    )
}

/** One roster row: avatar, name over role · meta, every chip in draw order, and the star key. */
@Composable
private fun PersonRow(row: PeopleRow, onEvent: (PeopleHomeEvent) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = KitGeometry.GUTTER)) {
        Avatar(row.avatar)
        Box(Modifier.weight(1f)) {
            CentraidRow(
                title = row.name,
                meta = listOf(row.role, row.meta).filter { it.isNotEmpty() }.joinToString(" · "),
                chips = row.chips,
                pending = row.star_pending,
                a11y = row.accessibility_label,
                testTag = "people-row-${row.party_id}",
                onTap = { onEvent(PeopleHomeEvent(person = PeopleHomeEvent.PersonPicked(row.party_id, row.name))) },
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

/** A filter chip: hairline, the selected one in full ink with a check-free weight step. */
@Composable
internal fun FilterChip(label: String, spoken: String, selected: Boolean, testTag: String, onTap: () -> Unit) {
    val shape = RoundedCornerShape(KitGeometry.RADIUS)
    Text(
        label,
        style = centraidType(if (selected) "control" else "annotLabelOn"),
        color = centraidColor(if (selected) "text" else "textSoft"),
        modifier = Modifier
            .heightIn(min = 36.dp)
            .clip(shape)
            .border(KitGeometry.HAIRLINE, centraidColor(if (selected) "lineStrong" else "line"), shape)
            .clickable(onClick = onTap)
            .padding(horizontal = 12.dp, vertical = 9.dp)
            .testTag(testTag)
            .clearAndSetSemantics {
                contentDescription = spoken
                role = Role.Button
                this.selected = selected
            },
    )
}
