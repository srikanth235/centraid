package dev.centraid.android.screens.health

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import centraid.core.v1.HealthConnectEvent
import centraid.core.v1.HealthConnectState
import centraid.core.v1.HealthMetricEvent
import centraid.core.v1.HealthMetricState
import centraid.core.v1.HealthWorkoutEvent
import centraid.core.v1.HealthWorkoutState
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.InkButton
import dev.centraid.android.kit.KitCardGrid
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitSegmented
import dev.centraid.android.kit.KitText
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.LocalAppAccentId
import dev.centraid.android.kit.PushedPage
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.StateColor
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.appAccent
import dev.centraid.android.kit.kitBorderedCard
import dev.centraid.android.kit.kitCard
import dev.centraid.android.kit.kitTextStyle
import dev.centraid.android.theme.LocalCentraidTokens
import dev.centraid.android.kit.screenContentOf

// ---------------------------------------------------------------------------
// health.metric: one metric over a week, a month or a year (#1129, #1135)
// ---------------------------------------------------------------------------

@Composable
internal fun HealthMetricScreen(state: HealthMetricState, onEvent: (HealthMetricEvent) -> Unit, onBack: () -> Unit) {
    val chrome = state.chrome
    CompositionLocalProvider(LocalAppAccentId provides "health") {
        PushedPage(title = chrome?.title.orEmpty(), parentTitle = chrome?.back_label.orEmpty(), onBack = onBack) {
            Column(Modifier.fillMaxSize().background(Surface.plainPage)) {
                if (state.segments.isNotEmpty()) {
                    KitSegmented(
                        options = state.segments.map { it.key to it.label },
                        selected = state.segments.firstOrNull { it.active }?.key.orEmpty(),
                        onSelect = { key -> onEvent(HealthMetricEvent(range = HealthMetricEvent.RangePicked(key = key))) },
                        modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp).testTag("health-metric-range"),
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
                        LazyColumn(Modifier.testTag("health-metric-page")) {
                            item(key = "head") {
                                Column(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp)) {
                                    KitText(data.average_label, KitType.Group, Surface.meta)
                                    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                        Text(
                                            data.average,
                                            style = kitTextStyle(KitType.Row).copy(fontSize = 36.sp, fontWeight = FontWeight.Bold),
                                            color = Surface.ink,
                                        )
                                        KitText(data.average_unit, KitType.Row, Surface.meta, Modifier.padding(bottom = 4.dp))
                                    }
                                    KitText(data.caption, KitType.Meta, Surface.meta)
                                    if (data.versus.isNotEmpty()) {
                                        KitText(
                                            data.versus,
                                            KitType.Meta,
                                            if (data.versus_good) StateColor.Green.text else Surface.meta,
                                            Modifier.padding(top = 2.dp).testTag("health-metric-versus"),
                                        )
                                    }
                                }
                            }
                            item(key = "chart") { HealthChart(data) }
                            if (data.facts.isNotEmpty()) {
                                item(key = "facts") {
                                    Column(Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp).kitBorderedCard()) {
                                        data.facts.forEachIndexed { index, fact ->
                                            if (index > 0) HorizontalDivider(color = Surface.line)
                                            HealthFactRow(fact.label, fact.detail)
                                        }
                                    }
                                }
                            }
                            item(key = "about") {
                                Column(Modifier.padding(horizontal = KitGeometry.GUTTER + 4.dp, vertical = 8.dp)) {
                                    KitText(data.about_heading, KitType.Row, Surface.ink, Modifier.semantics { heading() })
                                    KitText(data.foot, KitType.Meta, Surface.meta, Modifier.padding(top = 4.dp))
                                }
                            }
                        }
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
    CompositionLocalProvider(LocalAppAccentId provides "health") {
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
                    LazyColumn(Modifier.testTag("health-workout-page")) {
                        item(key = "head") {
                            Column(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER + 4.dp, vertical = 4.dp)) {
                                KitText(data.kind_label, KitType.Group, appAccent("health").text)
                                KitText(data.title, KitType.Title, Surface.ink, Modifier.semantics { heading() })
                                KitText(data.when_label, KitType.Meta, Surface.meta)
                            }
                        }
                        // The figures are cards two to a row, one column at the largest text.
                        item(key = "figures") {
                            KitCardGrid(
                                items = data.figures,
                                modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
                                gap = 8.dp,
                            ) { figure -> HealthFigureCard(figure) }
                        }
                        item(key = "foot") { HealthNote(data.foot) }
                    }
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
 * button is off, that the store is being read, or why it was refused. The tap is an event: Rust
 * asks the shell to read the store (`HealthRead`, with Health Connect's own permission sheet at
 * the member's tap, `ScreenEffects.kt`). A connected page is `finished` and the host pops it.
 */
@Composable
internal fun HealthConnectScreen(state: HealthConnectState, onEvent: (HealthConnectEvent) -> Unit, onBack: () -> Unit) {
    val chrome = state.chrome
    val accent = appAccent("health")
    CompositionLocalProvider(LocalAppAccentId provides "health") {
        PushedPage(
            title = chrome?.title.orEmpty(),
            parentTitle = chrome?.back_label.orEmpty(),
            onBack = onBack,
            status = state.status,
        ) {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).testTag("health-connect")) {
                Row(
                    Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp).fillMaxWidth().kitCard().padding(16.dp),
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    Box(Modifier.size(44.dp).clip(RoundedCornerShape((LocalCentraidTokens.current.radii["md"] ?: 0).dp)).background(accent.wash(false)), contentAlignment = Alignment.Center) {
                        CentraidIcon(iconKey = "Heart", tint = accent.text, size = 22.dp)
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        KitText(state.headline, KitType.Row, Surface.ink, Modifier.semantics { heading() })
                        KitText(state.lede, KitType.Meta, Surface.body)
                    }
                }
                if (state.choices_title.isNotEmpty()) {
                    KitText(
                        state.choices_title,
                        KitType.Group,
                        Surface.meta,
                        Modifier.padding(start = KitGeometry.GUTTER + 16.dp, end = KitGeometry.GUTTER, top = 14.dp, bottom = 6.dp),
                    )
                }
                Column(Modifier.padding(horizontal = KitGeometry.GUTTER).fillMaxWidth().kitCard()) {
                    state.choices.forEachIndexed { index, choice ->
                        if (index > 0) HorizontalDivider(color = Surface.line)
                        val toggle = { onEvent(HealthConnectEvent(toggled = HealthConnectEvent.Toggled(key = choice.key))) }
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .heightIn(min = KitGeometry.ROW_MIN)
                                .clickable(enabled = !state.working, onClick = toggle)
                                .padding(start = 14.dp, end = 10.dp, top = 6.dp, bottom = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                KitText(choice.label, KitType.Row, Surface.ink)
                                if (choice.detail.isNotEmpty()) KitText(choice.detail, KitType.Meta, Surface.meta)
                            }
                            Switch(
                                checked = choice.on,
                                onCheckedChange = { if (!state.working) toggle() },
                                colors = SwitchDefaults.colors(checkedTrackColor = accent.fill, checkedThumbColor = Color.White, checkedBorderColor = accent.fill),
                                modifier = Modifier
                                    .testTag("health-choice-${choice.key}")
                                    .semantics { contentDescription = listOf(choice.label, choice.detail).filter { it.isNotEmpty() }.joinToString(", ") },
                            )
                        }
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
}
