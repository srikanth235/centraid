package dev.centraid.android.screens.health

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import centraid.screen.v1.HealthConnectEvent
import centraid.screen.v1.HealthConnectState
import centraid.screen.v1.HealthMetricEvent
import centraid.screen.v1.HealthMetricState
import centraid.screen.v1.HealthWorkoutEvent
import centraid.screen.v1.HealthWorkoutState
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.FieldRow
import dev.centraid.android.kit.InkButton
import dev.centraid.android.kit.KitCheckBox
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitSegmented
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.PushedPage
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.screenContentOf
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

// ---------------------------------------------------------------------------
// health.metric: one metric over a week, a month or a year (#1129)
// ---------------------------------------------------------------------------

@Composable
internal fun HealthMetricScreen(state: HealthMetricState, onEvent: (HealthMetricEvent) -> Unit, onBack: () -> Unit) {
    val chrome = state.chrome
    PushedPage(title = chrome?.title.orEmpty(), parentTitle = chrome?.back_label.orEmpty(), onBack = onBack) {
        Column {
            if (state.segments.isNotEmpty()) {
                KitSegmented(
                    options = state.segments.map { it.key to it.label },
                    selected = state.segments.firstOrNull { it.active }?.key.orEmpty(),
                    onSelect = { key -> onEvent(HealthMetricEvent(range = HealthMetricEvent.RangePicked(key = key))) },
                    modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
                )
            }
            ReadStateView(
                content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
                onRetry = { onEvent(HealthMetricEvent(refreshed = HealthMetricEvent.Refreshed())) },
                retryLabel = chrome?.retry.orEmpty().ifEmpty { KitWords.RETRY },
            ) { data ->
                val empty = data.empty
                if (empty != null) {
                    EmptyStateView(empty, onAction = null)
                } else {
                    LazyColumn {
                        item(key = "head") {
                            Column(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp)) {
                                Text(data.caption, style = centraidType("annotLabel"), color = centraidColor("textSoft"))
                                HealthValue(data.average, data.average_unit, "display")
                                if (data.versus.isNotEmpty()) Text(data.versus, style = centraidType("body"), color = centraidColor("textSoft"))
                            }
                        }
                        item(key = "chart") {
                            HealthChart(data.bars, data.has_typical, data.typical_bp, data.typical_label, data.ticks, data.chart_label)
                        }
                        items(data.facts.size, key = { "fact-$it" }) { index -> FieldRow(key = data.facts[index].label, value = data.facts[index].detail) }
                        item(key = "foot") { HealthNote(data.foot) }
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// health.workout (#1129)
// ---------------------------------------------------------------------------

@Composable
internal fun HealthWorkoutScreen(state: HealthWorkoutState, onEvent: (HealthWorkoutEvent) -> Unit, onBack: () -> Unit) {
    val chrome = state.chrome
    PushedPage(title = chrome?.title.orEmpty(), parentTitle = chrome?.back_label.orEmpty(), onBack = onBack) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
            onRetry = { onEvent(HealthWorkoutEvent(refreshed = HealthWorkoutEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty().ifEmpty { KitWords.RETRY },
        ) { data ->
            val gone = data.gone
            if (gone != null) {
                EmptyStateView(gone, onAction = null)
            } else {
                LazyColumn {
                    item(key = "head") {
                        Column(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp)) {
                            Text(data.kind_label, style = centraidType("annotLabel"), color = centraidColor("textSoft"))
                            Text(
                                data.title,
                                style = centraidType("title"),
                                color = centraidColor("text"),
                                modifier = Modifier.semantics { heading() },
                            )
                            Text(data.when_label, style = centraidType("body"), color = centraidColor("textSoft"))
                        }
                    }
                    item(key = "figures") { HealthFigures(data.figures) }
                    item(key = "foot") { HealthNote(data.foot) }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// health.connect: what Health may read, and the one Ink button (#1129)
// ---------------------------------------------------------------------------

/**
 * CONNECT. A check box a type, the note, and the one Ink button; the status line says why the
 * button is off, that the store is being read, or why it was refused. The tap is an intent the
 * route answers with Health Connect's own sheet ([rememberHealthConnect]).
 */
@Composable
internal fun HealthConnectScreen(state: HealthConnectState, onEvent: (HealthConnectEvent) -> Unit, onBack: () -> Unit) {
    val chrome = state.chrome
    PushedPage(
        title = chrome?.title.orEmpty(),
        parentTitle = chrome?.back_label.orEmpty(),
        onBack = onBack,
        status = state.status,
    ) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).testTag("health-connect")) {
            Text(
                state.headline,
                style = centraidType("title"),
                color = centraidColor("text"),
                modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp).semantics { heading() },
            )
            HealthNote(state.lede, style = "body")
            HealthSection(state.choices_title)
            state.choices.forEach { choice ->
                val toggle = { onEvent(HealthConnectEvent(toggled = HealthConnectEvent.Toggled(key = choice.key))) }
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = KitGeometry.ROW_MIN)
                        .clickable(enabled = !state.working, onClick = toggle)
                        .padding(start = KitGeometry.GUTTER, end = 4.dp, top = 4.dp, bottom = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(choice.label, style = centraidType("body"), color = centraidColor("text"))
                        if (choice.detail.isNotEmpty()) Text(choice.detail, style = centraidType("annotLabel"), color = centraidColor("textSoft"))
                    }
                    KitCheckBox(
                        checked = choice.on,
                        label = listOf(choice.label, choice.detail).filter { it.isNotEmpty() }.joinToString(", "),
                        onClick = { if (!state.working) toggle() },
                        modifier = Modifier.testTag("health-choice-${choice.key}"),
                    )
                }
            }
            HealthNote(state.note)
            InkButton(
                label = state.connect_label,
                enabled = state.can_connect,
                testTag = "health-connect-action",
                modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 12.dp),
            ) { onEvent(HealthConnectEvent(connect = HealthConnectEvent.ConnectTapped())) }
        }
    }
}
