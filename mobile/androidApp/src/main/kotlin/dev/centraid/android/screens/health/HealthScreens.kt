package dev.centraid.android.screens.health

import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
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
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitSegmented
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.OptionSheet
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RoomChip
import dev.centraid.android.kit.SheetOption
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.ShowMoreFooter
import dev.centraid.android.kit.screenContentOf

// ---------------------------------------------------------------------------
// health.home: Today · Trends · Workouts, More as a sheet (#1129, #1135)
// ---------------------------------------------------------------------------

/**
 * HEALTH'S PLACE. The band's tab is the state's parameter; Workouts' kind chips sit in the room's
 * chip row and Trends' ranges in a segmented control at the top of its list. Before a store is
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
        chips = state.chips.map { chip ->
            RoomChip(
                testTag = "health-chip-${chip.key.ifEmpty { "all" }}",
                label = chip.label,
                selected = chip.active,
                onPress = { onEvent(HealthHomeEvent(kind_picked = HealthHomeEvent.KindPicked(kind_concept_id = chip.key))) },
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

private fun LazyListScope.today(state: HealthHomeState, onOpen: (Route) -> Unit) {
    val today = state.data_?.today_data ?: return
    today.hero?.let { hero -> item(key = "hero") { HealthHero(hero) { hero.route?.let(onOpen) } } }
    item(key = "metrics-heading") { HealthSection(today.metrics_heading) }
    items(today.metrics, key = { "m-${it.metric}" }) { line -> HealthMetricRow(line) { line.route?.let(onOpen) } }
    if (today.workouts.isNotEmpty()) {
        item(key = "workouts-heading") { HealthSection(today.workouts_heading) }
        items(today.workouts, key = { "w-${it.activity_id}" }) { line -> HealthWorkoutRow(line) { line.route?.let(onOpen) } }
    }
    item(key = "foot") { HealthNote(today.foot) }
}

private fun LazyListScope.trends(state: HealthHomeState, onOpen: (Route) -> Unit) {
    val trends = state.data_?.trends ?: return
    val empty = trends.empty
    if (empty != null) {
        item(key = "empty") { EmptyStateView(empty, onAction = null) }
        return
    }
    item(key = "compare") { HealthNote(trends.compare_line) }
    items(trends.rows, key = { "t-${it.metric}" }) { row -> HealthTrendRowView(row) { row.route?.let(onOpen) } }
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
