package dev.centraid.android.screens.health

import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import centraid.screen.v1.Confirm
import centraid.screen.v1.HealthHomeEvent
import centraid.screen.v1.HealthHomeState
import centraid.screen.v1.StatusChip
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
// health.home: Today · Trends · Workouts, More as a sheet (#1129)
// ---------------------------------------------------------------------------

/**
 * HEALTH'S PLACE. The band's tab is the state's parameter; Workouts' kind chips sit in the room's
 * chip row and Trends' ranges in a segmented control at the top of its list. Before a store is
 * connected every tab draws the machine's one empty sentence, whose action is Connect.
 */
@Composable
internal fun HealthHomeScreen(state: HealthHomeState, onEvent: (HealthHomeEvent) -> Unit, onHome: () -> Unit) {
    val chrome = state.chrome
    val connect = { onEvent(HealthHomeEvent(connect = HealthHomeEvent.ConnectOpened())) }
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
                EmptyStateView(empty, onAction = connect)
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
                        HealthHomeState.Destination.DESTINATION_TRENDS -> trends(state, onEvent)
                        HealthHomeState.Destination.DESTINATION_WORKOUTS -> workouts(state, onEvent)
                        else -> today(state, onEvent)
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
                SheetOption(key = it.key, label = it.label, iconKey = it.icon_key, detail = it.meta, destructive = it.tone == StatusChip.Tone.TONE_NET)
            },
            onPick = { key -> onEvent(HealthHomeEvent(more = HealthHomeEvent.MorePicked(key = key))) },
            onDismiss = close,
        )
        HealthHomeState.Sheet.SHEET_READS -> SheetRoom(title = chrome?.reads_title.orEmpty(), onDismiss = close) {
            state.reads_facts.forEach { FieldRow(key = it.label, value = it.detail) }
        }
        // THE STOP IS THE MORE ROW'S NET ACT, confirmed in the machine's own sentences.
        HealthHomeState.Sheet.SHEET_STOP -> ConfirmSheet(
            confirm = Confirm(
                title = chrome?.stop_title.orEmpty(),
                body = chrome?.stop_body.orEmpty(),
                confirm_label = chrome?.stop_confirm.orEmpty(),
                destructive = true,
            ),
            onConfirm = { onEvent(HealthHomeEvent(stop = HealthHomeEvent.StopConfirmed())) },
            onDismiss = close,
            cancelLabel = chrome?.stop_cancel.orEmpty().ifEmpty { KitWords.CANCEL },
            confirmTag = "health-stop-confirm",
        )
        else -> Unit
    }
}

private fun metricPicked(metric: String): HealthHomeEvent = HealthHomeEvent(metric = HealthHomeEvent.MetricPicked(metric = metric))

private fun workoutPicked(id: String): HealthHomeEvent = HealthHomeEvent(workout = HealthHomeEvent.WorkoutPicked(activity_id = id))

private fun LazyListScope.today(state: HealthHomeState, onEvent: (HealthHomeEvent) -> Unit) {
    val today = state.data_?.today_data ?: return
    today.hero?.let { hero -> item(key = "hero") { HealthHero(hero) { onEvent(metricPicked(hero.metric)) } } }
    item(key = "metrics-heading") { HealthSection(today.metrics_heading) }
    items(today.metrics, key = { "m-${it.metric}" }) { line -> HealthMetricRow(line) { onEvent(metricPicked(line.metric)) } }
    if (today.workouts.isNotEmpty()) {
        item(key = "workouts-heading") { HealthSection(today.workouts_heading) }
        items(today.workouts, key = { "w-${it.activity_id}" }) { line -> HealthWorkoutRow(line) { onEvent(workoutPicked(line.activity_id)) } }
    }
    item(key = "foot") { HealthNote(today.foot) }
}

private fun LazyListScope.trends(state: HealthHomeState, onEvent: (HealthHomeEvent) -> Unit) {
    val trends = state.data_?.trends ?: return
    val empty = trends.empty
    if (empty != null) {
        item(key = "empty") { EmptyStateView(empty, onAction = null) }
        return
    }
    item(key = "compare") { HealthNote(trends.compare_line) }
    items(trends.rows, key = { "t-${it.metric}" }) { row -> HealthTrendRowView(row) { onEvent(metricPicked(row.metric)) } }
}

private fun LazyListScope.workouts(state: HealthHomeState, onEvent: (HealthHomeEvent) -> Unit) {
    val workouts = state.data_?.workouts ?: return
    val empty = workouts.empty
    if (empty != null) {
        item(key = "empty") { EmptyStateView(empty, onAction = null) }
        return
    }
    workouts.sections.forEachIndexed { index, section ->
        item(key = "s-$index") { HealthSection(section.heading) }
        items(section.rows, key = { "w-${it.activity_id}" }) { line -> HealthWorkoutRow(line) { onEvent(workoutPicked(line.activity_id)) } }
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
