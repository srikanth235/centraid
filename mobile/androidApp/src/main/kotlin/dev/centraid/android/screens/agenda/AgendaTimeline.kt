package dev.centraid.android.screens.agenda

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.SubcomposeLayout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import centraid.core.v1.*
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.hueColor
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import kotlin.math.abs
import kotlin.math.roundToInt

private class TimelineMeasurement { var geometry: TimelineGeometry? = null }

/** One measured time map drives the hour rules, event endpoints and both gestures. */
@Composable
internal fun AgendaTimeline(
    day: AgendaHourDay,
    chrome: AgendaChrome,
    gutter: androidx.compose.ui.unit.Dp,
    actions: AgendaTaskActions,
    onEvent: (AgendaHomeEvent) -> Unit,
    onOpen: (Route) -> Unit,
) {
    val measurement = remember(day.day) { TimelineMeasurement() }
    val density = LocalDensity.current
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val lanes = day.timeline.maxOfOrNull { it.lane_count }?.coerceAtLeast(1) ?: 1
        val canvasWidth = maxOf(maxWidth, gutter + KitGeometry.GUTTER + 8.dp + 120.dp * lanes)
        Box(Modifier.horizontalScroll(rememberScrollState())) {
            SubcomposeLayout(Modifier.width(canvasWidth).testTag("agenda-timeline-${day.day}")) { constraints ->
                val width = constraints.maxWidth
                val leading = (gutter + KitGeometry.GUTTER + 8.dp).roundToPx()
                val gap = 4.dp.roundToPx()
                val widths = day.timeline.map { placement ->
                    ((width - leading - gap * (placement.lane_count.coerceAtLeast(1) - 1)) / placement.lane_count.coerceAtLeast(1)).coerceAtLeast(1)
                }
                val measured = day.timeline.mapIndexed { index, placement ->
                    subcompose("measure-$index") {
                        TimelineItem(placement, actions, onEvent, onOpen) { _, _ -> }
                    }.single().measure(Constraints(maxWidth = widths[index], minWidth = widths[index]))
                }
                val geometry = TimelineGeometry(day.duration_ms, day.hours.map { it.offset_ms }, day.timeline.mapIndexed { index, placement ->
                    TimelineSpan(placement.start_offset_ms, placement.end_offset_ms,
                        if (placement.row?.now_line != null) 0.0 else measured[index].height.toDouble())
                }, with(density) { 64.dp.toPx().toDouble() })
                measurement.geometry = geometry
                val slots = day.hours.mapIndexed { index, slot ->
                    val end = day.hours.getOrNull(index + 1)?.offset_ms ?: day.duration_ms
                    val height = (geometry.y(end) - geometry.y(slot.offset_ms)).roundToInt().coerceAtLeast(1)
                    subcompose("hour-${slot.key}") {
                        Row(Modifier.fillMaxSize().padding(start = KitGeometry.GUTTER), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(slot.label, style = centraidType("annotLabel").copy(fontFeatureSettings = "tnum"), color = centraidColor("textSoft"), maxLines = 1, softWrap = false, modifier = Modifier.width(gutter))
                            Box(Modifier.weight(1f).fillMaxHeight()
                                .combinedClickable(onClick = {}, onLongClick = { slot.create_route?.let(onOpen) }, onLongClickLabel = chrome.new_event)
                                .testTag("agenda-slot-${slot.key}")) {
                                Box(Modifier.fillMaxWidth().height(1.dp).background(centraidColor("line")))
                            }
                        }
                    }.single().measure(Constraints.fixed(width, height))
                }
                val blocks = day.timeline.mapIndexed { index, placement ->
                    val height = maxOf(measured[index].height, (geometry.y(placement.end_offset_ms) - geometry.y(placement.start_offset_ms)).roundToInt())
                    subcompose("item-$index") {
                        TimelineItem(placement, actions, onEvent, onOpen) { translation, resize ->
                            val row = placement.row?.event
                            val step = row?.adjustments?.filter { it.resize == resize && it.delta_minutes != 0 }?.minOfOrNull { abs(it.delta_minutes) } ?: 0
                            val anchor = if (resize) placement.end_offset_ms else placement.start_offset_ms
                            val delta = measurement.geometry?.delta(anchor, translation.toDouble(), step) ?: 0
                            if (row != null && delta != 0) onEvent(AgendaHomeEvent(event_adjusted = AgendaHomeEvent.EventAdjusted(instance_key = row.instance_key, delta_minutes = delta, resize = resize)))
                        }
                    }.single().measure(Constraints.fixed(widths[index], height.coerceAtLeast(1)))
                }
                layout(width, geometry.height.roundToInt().coerceAtLeast(1)) {
                    slots.forEachIndexed { index, placeable -> placeable.placeRelative(0, geometry.y(day.hours[index].offset_ms).roundToInt()) }
                    blocks.forEachIndexed { index, placeable ->
                        val placement = day.timeline[index]
                        placeable.placeRelative(leading + placement.lane * (widths[index] + gap), geometry.y(placement.start_offset_ms).roundToInt())
                    }
                }
            }
        }
    }
}

@Composable
private fun TimelineItem(placement: AgendaTimelineItem, actions: AgendaTaskActions, onEvent: (AgendaHomeEvent) -> Unit, onOpen: (Route) -> Unit, onAdjust: (Float, Boolean) -> Unit) {
    val item = placement.row
    val latestAdjust by rememberUpdatedState(onAdjust)
    item?.event?.let { row ->
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(KitGeometry.RADIUS)).background(centraidColor("agendaTint"))
            .pointerInput(row.instance_key) {
                var drag = 0f
                detectDragGesturesAfterLongPress(onDragStart = { drag = 0f }, onDrag = { change, amount -> drag += amount.y; change.consume() }, onDragEnd = { latestAdjust(drag, false) })
            }.semantics {
                customActions = row.adjustments.map { option -> CustomAccessibilityAction(option.label) {
                    onEvent(AgendaHomeEvent(event_adjusted = AgendaHomeEvent.EventAdjusted(instance_key = row.instance_key, delta_minutes = option.delta_minutes, resize = option.resize)))
                    true
                } }
            }) {
            Row(Modifier.fillMaxWidth().clickable { row.route?.let(onOpen) }.padding(8.dp).testTag("agenda-row-${row.row_key}")
                .semantics(mergeDescendants = true) { contentDescription = row.accessibility_label }, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(Modifier.width(3.dp).height(24.dp).background(hueColor(row.calendar_hue_key)))
                Column(Modifier.weight(1f)) {
                    Text(row.title, style = centraidType("bodyStrong"), color = centraidColor("text"))
                    Text(row.time_label, style = centraidType("annotLabel"), color = centraidColor("textSoft"))
                    if (row.status_label.isNotEmpty()) Text(row.status_label, style = centraidType("annotLabel"), color = centraidColor("attention"))
                }
            }
            Spacer(Modifier.weight(1f))
            row.adjustments.lastOrNull { it.resize }?.let { option ->
                Box(Modifier.fillMaxWidth().height(44.dp).pointerInput(row.instance_key) {
                    var drag = 0f
                    detectVerticalDragGestures(onDragStart = { drag = 0f }, onVerticalDrag = { change, amount -> drag += amount; change.consume() }, onDragEnd = { latestAdjust(drag, true) })
                }.clickable {
                    onEvent(AgendaHomeEvent(event_adjusted = AgendaHomeEvent.EventAdjusted(instance_key = row.instance_key, delta_minutes = option.delta_minutes, resize = true)))
                }.semantics { contentDescription = option.label }.testTag("agenda-resize-${row.instance_key}"), contentAlignment = Alignment.Center) {
                    Box(Modifier.width(36.dp).height(4.dp).clip(CircleShape).background(centraidColor("agendaText")))
                }
            }
        }
    }
    item?.task?.let { TodoRowView(it, onCheck = actions.onCheck, onOpen = onOpen, onFile = actions.onFile, fileVerb = actions.fileVerb, idPrefix = AGENDA_TASK_ROW, onAction = actions.onAction) }
    item?.now_line?.let { now ->
        Row(Modifier.fillMaxWidth().semantics { contentDescription = now.accessibility_label }, verticalAlignment = Alignment.CenterVertically) {
            Text(now.label, style = centraidType("annotLabelOn"), color = centraidColor("agendaText"))
            Box(Modifier.weight(1f).height(2.dp).background(centraidColor("agendaText")))
        }
    }
    if (item == null) Spacer(Modifier.size(1.dp))
}
