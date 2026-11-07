package dev.centraid.android.screens.health

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import centraid.core.v1.FilterMenuCleared
import centraid.core.v1.FilterMenuPicked
import centraid.core.v1.HealthDestination
import centraid.core.v1.HealthHomeEvent
import centraid.core.v1.HealthHomeState
import centraid.core.v1.Route
import centraid.core.v1.StatusChip
import dev.centraid.android.kit.AppBand
import dev.centraid.android.kit.AppBandTab
import dev.centraid.android.kit.AppPlace
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.FieldRow
import dev.centraid.android.kit.KitCardGrid
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitSegmented
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.OptionSheet
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RoomFilter
import dev.centraid.android.kit.SheetOption
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.ShowMoreFooter
import dev.centraid.android.kit.screenContentOf

// ---------------------------------------------------------------------------
// health.home: Summary · Trends · Workouts, More as a sheet (#1129, #1135, #1173)
// ---------------------------------------------------------------------------

/**
 * HEALTH'S PLACE. The band's tab is the state's parameter; Workouts' kind is the header's filter
 * menu and Trends' ranges in a segmented control at the top of its list. Before a store is
 * connected every tab draws Rust's one empty sentence, whose action is Connect (its [Route]).
 * A row that opens a page carries its route and a tap hands it to [onOpen].
 */
@Composable
internal fun HealthHomeScreen(
    state: HealthHomeState,
    onEvent: (HealthHomeEvent) -> Unit,
    onOpen: (Route) -> Unit,
    onHome: () -> Unit,
) {
    val chrome = state.chrome
    AppPlace(
        app = "health",
        title = chrome?.title.orEmpty(),
        meta = state.data_?.day_label.orEmpty(),
        // THE HEADER'S FILTER BUTTON: Workouts' kind, Rust's menu.
        filter = state.filter_menu?.let { menu ->
            RoomFilter(
                menu = menu,
                onPick = { section, option ->
                    onEvent(HealthHomeEvent(filter_menu_picked = FilterMenuPicked(section_key = section, option_key = option)))
                },
                onClear = { onEvent(HealthHomeEvent(filter_menu_cleared = FilterMenuCleared())) },
            )
        },
        status = state.status?.sentence.orEmpty(),
        band = {
            AppBand(
                app = "health",
                tabs = state.band.map { AppBandTab(key = it.key, label = it.label, iconKey = it.icon_key, selected = it.current) },
                onSelect = { key -> onEvent(HealthHomeEvent(band = HealthHomeEvent.BandPicked(key = key))) },
                onHome = onHome,
            )
        },
    ) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
            onRetry = { onEvent(HealthHomeEvent(refreshed = HealthHomeEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty().ifEmpty { KitWords.RETRY },
        ) { data ->
            val empty = data.empty
            if (empty != null) {
                EmptyStateView(empty, onAction = { data.connect?.let(onOpen) })
            } else {
                LazyColumn {
                    if (state.segments.isNotEmpty()) {
                        item(key = "segments") {
                            KitSegmented(
                                options = state.segments.map { it.key to it.label },
                                selected = state.segments.firstOrNull { it.active }?.key.orEmpty(),
                                onSelect = { key -> onEvent(HealthHomeEvent(range = HealthHomeEvent.RangePicked(key = key))) },
                                modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
                            )
                        }
                    }
                    when (state.destination) {
                        HealthDestination.HEALTH_DESTINATION_TRENDS -> trends(state, onOpen)
                        HealthDestination.HEALTH_DESTINATION_WORKOUTS -> workouts(state, onOpen, onEvent)
                        else -> today(state, onOpen)
                    }
                }
            }
        }
    }
    val close = { onEvent(HealthHomeEvent(sheet_closed = HealthHomeEvent.SheetClosed())) }
    when (state.sheet) {
        HealthHomeState.Sheet.SHEET_MORE -> OptionSheet(
            title = chrome?.more_title.orEmpty(),
            options = state.more_rows.map {
                SheetOption(key = it.key, label = it.label, iconKey = it.icon_key, destructive = it.tone == StatusChip.Tone.TONE_NET)
            },
            // The sheet goes either way; a row with a route also opens its page.
            onPick = { key ->
                onEvent(HealthHomeEvent(more = HealthHomeEvent.MorePicked(key = key)))
                state.more_rows.firstOrNull { it.key == key }?.route?.let(onOpen)
            },
            onDismiss = close,
        )
        HealthHomeState.Sheet.SHEET_READS -> SheetRoom(title = chrome?.reads_title.orEmpty(), onDismiss = close) {
            state.reads_facts.forEach { FieldRow(key = it.label, value = it.detail) }
        }
        // THE STOP IS THE MORE ROW'S NET ACT, confirmed in Rust's own sentences.
        HealthHomeState.Sheet.SHEET_STOP -> state.stop?.let { stop ->
            ConfirmSheet(
                confirm = stop,
                onConfirm = { onEvent(HealthHomeEvent(stop = HealthHomeEvent.StopConfirmed())) },
                onDismiss = close,
                cancelLabel = chrome?.stop_cancel.orEmpty().ifEmpty { KitWords.CANCEL },
                confirmTag = "health-stop-confirm",
            )
        }
        else -> Unit
    }
}

/**
 * THE SUMMARY: the pinned cards (the first two wide with a sparkline, the rest two to a row, one
 * column at the largest text), the highlights, and today's workouts.
 */
private fun LazyListScope.today(state: HealthHomeState, onOpen: (Route) -> Unit) {
    val today = state.data_?.today_data ?: return
    val pinned = listOfNotNull(today.hero) + today.metrics
    item(key = "pinned-heading") { HealthSection(today.metrics_heading, today.metrics_note) }
    items(pinned.filter { it.wide }, key = { "p-${it.metric}" }) { line ->
        Box(Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp)) {
            HealthPinnedCard(line, if (line.metric == "steps") "health-hero" else "health-metric-${line.metric}") { line.route?.let(onOpen) }
        }
    }
    item(key = "pinned-grid") {
        KitCardGrid(
            items = pinned.filterNot { it.wide },
            modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp),
            gap = 8.dp,
        ) { line -> HealthPinnedCard(line, "health-metric-${line.metric}") { line.route?.let(onOpen) } }
    }
    if (today.highlights.isNotEmpty()) {
        item(key = "highlights-heading") { HealthSection(today.highlights_heading) }
        items(today.highlights, key = { "h-${it.metric}" }) { highlight ->
            Box(Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp)) {
                HealthHighlightCard(highlight) { highlight.route?.let(onOpen) }
            }
        }
    }
    if (today.workouts.isNotEmpty()) {
        item(key = "workouts-heading") { HealthSection(today.workouts_heading) }
        items(today.workouts, key = { "w-${it.activity_id}" }) { line -> HealthWorkoutRow(line) { line.route?.let(onOpen) } }
    }
}

private fun LazyListScope.trends(state: HealthHomeState, onOpen: (Route) -> Unit) {
    val trends = state.data_?.trends ?: return
    val empty = trends.empty
    if (empty != null) {
        item(key = "empty") { EmptyStateView(empty, onAction = null) }
        return
    }
    item(key = "compare") { HealthNote(trends.compare_line) }
    items(trends.rows, key = { "t-${it.metric}" }) { row ->
        Box(Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp)) { HealthTrendRowView(row) { row.route?.let(onOpen) } }
    }
}

private fun LazyListScope.workouts(state: HealthHomeState, onOpen: (Route) -> Unit, onEvent: (HealthHomeEvent) -> Unit) {
    val workouts = state.data_?.workouts ?: return
    val empty = workouts.empty
    if (empty != null) {
        item(key = "empty") { EmptyStateView(empty, onAction = null) }
        return
    }
    workouts.sections.forEachIndexed { index, section ->
        item(key = "s-$index") { HealthSection(section.heading) }
        items(section.rows, key = { "w-${it.activity_id}" }) { line -> HealthWorkoutRow(line) { line.route?.let(onOpen) } }
    }
    item(key = "more") {
        ShowMoreFooter(
            visible = workouts.more,
            loading = false,
            label = state.chrome?.show_more.orEmpty().ifEmpty { KitWords.SHOW_MORE },
            onMore = { onEvent(HealthHomeEvent(show_more = HealthHomeEvent.ShowMore())) },
        )
    }
}
