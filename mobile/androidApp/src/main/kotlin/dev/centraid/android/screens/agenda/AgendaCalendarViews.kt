package dev.centraid.android.screens.agenda

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import centraid.core.v1.AgendaDestination
import centraid.core.v1.AgendaGridBlock
import centraid.core.v1.AgendaGridChip
import centraid.core.v1.AgendaGridDay
import centraid.core.v1.AgendaHomeData
import centraid.core.v1.AgendaHomeEvent
import centraid.core.v1.AgendaMonthCell
import centraid.core.v1.AgendaMonthGrid
import centraid.core.v1.AgendaMonthStyle
import centraid.core.v1.AgendaStripDay
import centraid.core.v1.AgendaTimeGrid
import centraid.core.v1.AgendaWeekStrip
import centraid.core.v1.AgendaYearGrid
import centraid.core.v1.AgendaYearMonth
import centraid.core.v1.Route
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.appAccent
import dev.centraid.android.kit.hueColor
import dev.centraid.android.kit.kitTextStyle
import dev.centraid.android.screens.daySection
import dev.centraid.android.theme.LocalCentraidTokens
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidDark
import dev.centraid.design.CentraidGeometry
import dev.centraid.design.CentraidScale
import kotlin.math.abs
import kotlin.math.roundToInt

/*
 * THE CALENDAR'S GRIDS (#1173): Day and Week's hour grid under the week strip, the Month and the Year.
 *
 * Rust lays every grid out (`AgendaHomeData.week_strip`, `time_grid`, `month`, `year`) and this file
 * only draws them and sends: a tap is `DayPicked`, a swipe `DayStepped` or `PeriodStepped`, a long
 * press on an empty slot `SlotPressed`, a drop `EventMoved`, a foot dragged `EventResized`. A block's
 * minute is what the finger is over; the core snaps (`snap_minutes`), and the preview under the finger
 * snaps to the same grid.
 */

/** One hour of the grid, the only layout constant: minutes map to it, 60 to a row. */
private val HOUR_HEIGHT: Dp = 56.dp

/** The hour labels' column. */
private val GUTTER_WIDTH: Dp = KitGeometry.ROW_MIN

/** The grid's whole day, in minutes (the proto counts from local midnight, 0 to 1440). */
private const val DAY_MINUTES: Int = 1440

/** A block is never drawn shorter than the core's smallest, so a short one is still a target. */
private const val MIN_BLOCK_MINUTES: Int = 15

/** The foot a resize drag takes hold of. */
private val RESIZE_HANDLE: Dp = 14.dp

/** The check circle on a task, in a block and in a chip. */
private val CHECK_SIZE: Dp = 18.dp

private fun Int.minuteDp(): Dp = HOUR_HEIGHT * (this / 60f)

private fun snapMinute(raw: Float, snap: Int): Int = (raw / snap).roundToInt() * snap

/** The radius token the existing rows read, never a number. */
@Composable
private fun radius(name: String): Dp = (LocalCentraidTokens.current.radii[name] ?: 0).dp

/** The pale ground of a hue: the hue at the icon chip's own strength, over the card. */
@Composable
private fun pale(hue: Color): Color =
    hue.copy(alpha = (if (centraidDark()) CentraidGeometry.ICON_CHIP_TINT_DARK else CentraidGeometry.ICON_CHIP_TINT_LIGHT).toFloat())

/**
 * A HORIZONTAL SWIPE: past a thumb's width it steps one way (`-1` for a drag to the right, the
 * period before) or the other (`+1`). The drag is consumed only once it is horizontal, so the
 * list or grid underneath still scrolls.
 */
@Composable
private fun Modifier.swipeStep(onStep: (Int) -> Unit): Modifier {
    val latest by rememberUpdatedState(onStep)
    val threshold = with(LocalDensity.current) { (KitGeometry.ROW_MIN * 1.5f).toPx() }
    return pointerInput(threshold) {
        var total = 0f
        detectHorizontalDragGestures(
            onDragStart = { total = 0f },
            onDragEnd = {
                if (abs(total) > threshold) latest(if (total < 0f) 1 else -1)
                total = 0f
            },
            onDragCancel = { total = 0f },
            onHorizontalDrag = { change, delta ->
                change.consume()
                total += delta
            },
        )
    }
}

/** What the toolbar's ‹ › say and step, per place: the week, the month and the year step a period. */
internal class AgendaPeriod(val previous: String, val next: String)

internal fun agendaPeriod(destination: AgendaDestination, data: AgendaHomeData?): AgendaPeriod? = when (destination) {
    AgendaDestination.AGENDA_DESTINATION_WEEK -> data?.week_strip?.let { AgendaPeriod(it.previous_label, it.next_label) }
    AgendaDestination.AGENDA_DESTINATION_MONTH -> data?.month?.let { AgendaPeriod(it.previous_label, it.next_label) }
    AgendaDestination.AGENDA_DESTINATION_YEAR -> data?.year?.let { AgendaPeriod(it.previous_label, it.next_label) }
    else -> null
}

internal fun stepPeriod(onEvent: (AgendaHomeEvent) -> Unit, by: Int) {
    onEvent(AgendaHomeEvent(period_stepped = AgendaHomeEvent.PeriodStepped(by_ = by)))
}

private fun pickDay(onEvent: (AgendaHomeEvent) -> Unit, day: String, destination: AgendaDestination) {
    onEvent(AgendaHomeEvent(day_picked = AgendaHomeEvent.DayPicked(day = day, destination = destination)))
}

/** THE FLOATING TODAY KEY: a tonal button over the content's bottom-start, above the band. */
@Composable
internal fun AgendaTodayButton(label: String, modifier: Modifier = Modifier, onPress: () -> Unit) {
    val accent = appAccent("agenda")
    Box(
        modifier
            .heightIn(min = KitGeometry.ROW_MIN)
            .clip(RoundedCornerShape(CentraidScale.cardRadius.dp))
            .background(Surface.card)
            .background(accent.wash(centraidDark()))
            .clickable(onClick = onPress)
            .padding(horizontal = KitGeometry.GUTTER)
            .testTag("agenda-today-button")
            .clearAndSetSemantics {
                contentDescription = label
                role = Role.Button
            },
        contentAlignment = Alignment.Center,
    ) {
        Text(label, style = kitTextStyle(KitType.Row), color = accent.text)
    }
}

// ---------------------------------------------------------------------------------------------
// DAY AND WEEK
// ---------------------------------------------------------------------------------------------

/** The week strip over the hour grid, then the all-day strip and the hour grid itself. */
@Composable
internal fun AgendaTimeView(
    strip: AgendaWeekStrip?,
    grid: AgendaTimeGrid,
    onEvent: (AgendaHomeEvent) -> Unit,
    onOpen: (Route) -> Unit,
    onCheck: (String) -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        if (strip != null) AgendaWeekStripView(strip, onEvent)
        val several = grid.days.size > 1
        Column(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .swipeStep { by ->
                    // DAY STEPS A DAY; THE WEEK STEPS ITS WEEK.
                    if (several) stepPeriod(onEvent, by) else onEvent(AgendaHomeEvent(day_stepped = AgendaHomeEvent.DayStepped(days = by)))
                }
                .testTag("agenda-time-grid"),
        ) {
            if (several) WeekHeadings(grid)
            if (grid.days.any { it.all_day.isNotEmpty() }) AllDayStrip(grid, onEvent, onOpen, onCheck)
            HourGrid(grid, onEvent, onOpen, onCheck, Modifier.weight(1f))
        }
    }
}

@Composable
private fun AgendaWeekStripView(strip: AgendaWeekStrip, onEvent: (AgendaHomeEvent) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp)
            .swipeStep { by -> onEvent(AgendaHomeEvent(day_stepped = AgendaHomeEvent.DayStepped(days = by * strip.step_days))) }
            .testTag("agenda-week-strip")
            .semantics {
                customActions = listOf(
                    CustomAccessibilityAction(strip.previous_label) {
                        onEvent(AgendaHomeEvent(day_stepped = AgendaHomeEvent.DayStepped(days = -strip.step_days)))
                        true
                    },
                    CustomAccessibilityAction(strip.next_label) {
                        onEvent(AgendaHomeEvent(day_stepped = AgendaHomeEvent.DayStepped(days = strip.step_days)))
                        true
                    },
                )
            },
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        strip.days.forEach { day -> StripDay(day, Modifier.weight(1f), onEvent) }
    }
}

@Composable
private fun StripDay(day: AgendaStripDay, modifier: Modifier, onEvent: (AgendaHomeEvent) -> Unit) {
    val accent = appAccent("agenda")
    val quiet = day.is_weekend
    Column(
        modifier
            .heightIn(min = KitGeometry.ROW_MIN)
            .clickable { pickDay(onEvent, day.day, day.opens) }
            .testTag("agenda-strip-day-${day.day}")
            .clearAndSetSemantics {
                contentDescription = day.accessibility_label
                role = Role.Button
                selected = day.is_selected
            },
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            day.weekday_initial,
            style = kitTextStyle(KitType.Badge),
            color = if (quiet) Surface.meta else Surface.body,
        )
        Box(
            Modifier
                .padding(top = 2.dp)
                .size(KitGeometry.ROW_MIN - 8.dp)
                .clip(CircleShape)
                .then(if (day.is_selected) Modifier.background(accent.fill) else Modifier),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                day.day_number,
                style = kitTextStyle(if (day.is_today || day.is_selected) KitType.Row else KitType.Meta),
                color = when {
                    day.is_selected -> Color.White
                    day.is_today -> accent.text
                    quiet -> Surface.meta
                    else -> Surface.ink
                },
            )
        }
        Row(Modifier.height(8.dp).padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            day.dot_hue_keys.take(3).forEach { key -> Dot(hueColor(key)) }
        }
    }
}

@Composable
private fun Dot(color: Color) {
    Box(Modifier.size(5.dp).clip(CircleShape).background(color))
}

/** The Week's column heads ("Wed 4"), over the all-day strip, lined up with the hour columns. */
@Composable
private fun WeekHeadings(grid: AgendaTimeGrid) {
    val accent = appAccent("agenda")
    Row(Modifier.fillMaxWidth()) {
        Spacer(Modifier.width(GUTTER_WIDTH))
        grid.days.forEach { day ->
            Box(
                Modifier
                    .weight(1f)
                    .padding(vertical = 4.dp)
                    .clearAndSetSemantics { contentDescription = day.accessibility_label },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    day.heading,
                    style = kitTextStyle(KitType.Meta),
                    color = if (day.is_today) accent.text else Surface.body,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun AllDayStrip(
    grid: AgendaTimeGrid,
    onEvent: (AgendaHomeEvent) -> Unit,
    onOpen: (Route) -> Unit,
    onCheck: (String) -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(max = KitGeometry.ROW_MIN * 2)
            .verticalScroll(rememberScrollState()),
    ) {
        Box(Modifier.width(GUTTER_WIDTH).padding(start = 4.dp, top = 4.dp)) {
            Text(grid.all_day_label, style = kitTextStyle(KitType.Badge), color = Surface.meta, maxLines = 2)
        }
        grid.days.forEach { day ->
            Column(
                Modifier.weight(1f).padding(horizontal = 1.dp, vertical = 2.dp).testTag("agenda-grid-allday-${day.day}"),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                day.all_day.forEach { chip -> AllDayChip(chip, onOpen, onCheck) }
            }
        }
    }
}

@Composable
private fun AllDayChip(chip: AgendaGridChip, onOpen: (Route) -> Unit, onCheck: (String) -> Unit) {
    val hue = hueColor(chip.hue_key)
    val shape = RoundedCornerShape(radius("sm"))
    Row(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(Surface.card)
            .background(pale(hue))
            .clickable(enabled = chip.route != null) { chip.route?.let(onOpen) }
            .testTag("agenda-grid-chip-${chip.key}")
            .clearAndSetSemantics {
                contentDescription = chip.accessibility_label
                role = Role.Button
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(3.dp).height(CHECK_SIZE).background(hue))
        if (chip.is_task) {
            CheckCircle(hue, "agenda-grid-chip-check-${chip.task_id}", chip.accessibility_label) { onCheck(chip.task_id) }
        }
        Text(
            chip.title,
            style = kitTextStyle(KitType.Badge),
            color = Surface.ink,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = 4.dp),
        )
    }
}

/** A task's hollow check circle: a tap checks it off (`TaskChecked`). */
@Composable
private fun CheckCircle(hue: Color, tag: String, label: String, onPress: () -> Unit) {
    Box(
        Modifier
            .padding(start = 2.dp)
            .size(CHECK_SIZE)
            .clip(CircleShape)
            .clickable(onClick = onPress)
            .testTag(tag)
            .clearAndSetSemantics {
                contentDescription = label
                role = Role.Button
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(CHECK_SIZE - 6.dp).border(1.5.dp, hue, CircleShape))
    }
}

/** The vertical scroll: the hour labels, the day columns and the now line. */
@Composable
private fun HourGrid(
    grid: AgendaTimeGrid,
    onEvent: (AgendaHomeEvent) -> Unit,
    onOpen: (Route) -> Unit,
    onCheck: (String) -> Unit,
    modifier: Modifier,
) {
    val scroll = rememberScrollState()
    val perMinute = with(LocalDensity.current) { HOUR_HEIGHT.toPx() / 60f }
    // OPENS WHERE THE CORE SAYS: the grid scrolls once per day shown and per landing minute, not on a drag's redraw.
    LaunchedEffect(grid.scroll_to_minute, grid.days.firstOrNull()?.day) {
        scroll.scrollTo((grid.scroll_to_minute * perMinute).roundToInt())
    }
    val line = Surface.line
    Row(
        modifier
            .fillMaxWidth()
            .verticalScroll(scroll),
    ) {
        Box(Modifier.width(GUTTER_WIDTH).height(DAY_MINUTES.minuteDp())) {
            grid.hours.forEach { mark ->
                Text(
                    mark.label,
                    style = kitTextStyle(KitType.Badge),
                    color = Surface.meta,
                    maxLines = 1,
                    modifier = Modifier.offset(x = 4.dp, y = mark.minute.minuteDp()),
                )
            }
        }
        grid.days.forEachIndexed { index, day ->
            DayColumn(grid, day, index, line, onEvent, onOpen, onCheck, Modifier.weight(1f))
        }
    }
}

@Composable
private fun DayColumn(
    grid: AgendaTimeGrid,
    day: AgendaGridDay,
    index: Int,
    line: Color,
    onEvent: (AgendaHomeEvent) -> Unit,
    onOpen: (Route) -> Unit,
    onCheck: (String) -> Unit,
    modifier: Modifier,
) {
    val density = LocalDensity.current
    val hourPx = with(density) { HOUR_HEIGHT.toPx() }
    val snap = grid.snap_minutes.coerceAtLeast(1)
    BoxWithConstraints(
        modifier
            .height(DAY_MINUTES.minuteDp())
            .drawBehind {
                grid.hours.forEach { mark ->
                    val y = mark.minute / 60f * hourPx
                    drawLine(line, Offset(0f, y), Offset(size.width, y), strokeWidth = 1.dp.toPx())
                }
                drawLine(line, Offset(0f, 0f), Offset(0f, size.height), strokeWidth = 1.dp.toPx())
            }
            // A LONG PRESS ON EMPTY SPACE: the minute under the finger; the core snaps it and opens the add sheet.
            .pointerInput(day.day, hourPx) {
                detectTapGestures(onLongPress = { at ->
                    val minute = (at.y / hourPx * 60f).toInt().coerceIn(0, DAY_MINUTES - 1)
                    onEvent(AgendaHomeEvent(slot_pressed = AgendaHomeEvent.SlotPressed(day = day.day, minute = minute)))
                })
            }
            .semantics {
                contentDescription = day.accessibility_label
                onLongClick(label = grid.slot_hint) {
                    onEvent(AgendaHomeEvent(slot_pressed = AgendaHomeEvent.SlotPressed(day = day.day, minute = grid.scroll_to_minute)))
                    true
                }
            },
    ) {
        val columnWidth = maxWidth
        day.blocks.forEach { block ->
            GridBlock(block, index, grid, columnWidth, snap, hourPx, onEvent, onOpen, onCheck)
        }
        val now = grid.now
        if (now != null && now.day == day.day) NowLine(now.minute, now.label, now.accessibility_label)
    }
}

@Composable
private fun NowLine(minute: Int, label: String, spoken: String) {
    val net = centraidColor("net")
    Row(
        Modifier
            .fillMaxWidth()
            .offset(y = minute.minuteDp() - 4.dp)
            .zIndex(2f)
            .testTag("agenda-now-line")
            .clearAndSetSemantics { contentDescription = spoken },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(net))
        Box(Modifier.weight(1f).height(1.dp).background(net))
        Text(label, style = kitTextStyle(KitType.Badge), color = net, modifier = Modifier.padding(horizontal = 2.dp))
    }
}

/**
 * ONE TIMED BLOCK, placed by minutes, split into its cluster's lanes. An event is a pale hue ground
 * with a leading bar; a task is dashed with a check circle. A movable block follows a drag after a
 * long press (and drops where it was snapped); its foot resizes it.
 */
@Composable
private fun GridBlock(
    block: AgendaGridBlock,
    dayIndex: Int,
    grid: AgendaTimeGrid,
    columnWidth: Dp,
    snap: Int,
    hourPx: Float,
    onEvent: (AgendaHomeEvent) -> Unit,
    onOpen: (Route) -> Unit,
    onCheck: (String) -> Unit,
) {
    val hue = hueColor(block.hue_key)
    val shape = RoundedCornerShape(radius("sm"))
    val columns = block.columns.coerceAtLeast(1)
    val lane = columnWidth / columns
    val columnPx = with(LocalDensity.current) { columnWidth.toPx() }
    val duration = (block.end_minute - block.start_minute).coerceAtLeast(MIN_BLOCK_MINUTES)
    val days = grid.days
    // THE DRAG'S PREVIEW: the finger's travel, snapped to the grid it will land on.
    var move by remember(block.key) { mutableStateOf<Offset?>(null) }
    var foot by remember(block.key) { mutableStateOf<Float?>(null) }
    fun shift(by: Offset): Int =
        if (days.size <= 1) 0 else (by.x / columnPx).roundToInt().coerceIn(-dayIndex, days.lastIndex - dayIndex)
    fun top(by: Offset): Int =
        snapMinute(block.start_minute + by.y / hourPx * 60f, snap).coerceIn(0, DAY_MINUTES - duration)
    fun end(by: Float): Int =
        snapMinute(block.end_minute + by / hourPx * 60f, snap).coerceIn(block.start_minute + snap, DAY_MINUTES)

    val dragging = move
    val resizing = foot
    val shownStart = if (dragging != null) top(dragging) else block.start_minute
    val shownEnd = when {
        dragging != null -> shownStart + duration
        resizing != null -> end(resizing)
        else -> block.start_minute + duration
    }
    val shownHeight = (shownEnd - shownStart).coerceAtLeast(MIN_BLOCK_MINUTES).minuteDp()
    val laneX = lane * block.column
    val shownX = laneX + if (dragging != null) columnWidth * shift(dragging) else 0.dp

    fun moveBy(minutes: Int) {
        val to = (block.start_minute + minutes).coerceIn(0, DAY_MINUTES - duration)
        onEvent(
            AgendaHomeEvent(
                event_moved = AgendaHomeEvent.EventMoved(
                    instance_key = block.instance_key,
                    day = days[dayIndex].day,
                    minute = to,
                ),
            ),
        )
    }

    Box(
        Modifier
            .offset(x = shownX, y = shownStart.minuteDp())
            .width(lane)
            .height(shownHeight)
            .zIndex(if (dragging != null || resizing != null) 3f else 1f)
            .padding(horizontal = 1.dp)
            .then(
                if (block.movable) {
                    Modifier.pointerInput(block.key, hourPx, snap, columnPx, dayIndex, days.size) {
                        detectDragGesturesAfterLongPress(
                            onDragStart = { move = Offset.Zero },
                            onDrag = { change, amount ->
                                change.consume()
                                move = (move ?: Offset.Zero) + amount
                            },
                            onDragEnd = {
                                val by = move
                                move = null
                                if (by != null) {
                                    onEvent(
                                        AgendaHomeEvent(
                                            event_moved = AgendaHomeEvent.EventMoved(
                                                instance_key = block.instance_key,
                                                day = days[dayIndex + shift(by)].day,
                                                minute = top(by),
                                            ),
                                        ),
                                    )
                                }
                            },
                            onDragCancel = { move = null },
                        )
                    }
                } else {
                    Modifier
                },
            ),
    ) {
        val body = Modifier
            .fillMaxSize()
            .clip(shape)
            .then(
                if (block.is_task) {
                    Modifier
                        .background(Surface.card)
                        .drawBehind {
                            drawRoundRect(
                                color = hue,
                                cornerRadius = CornerRadius(4.dp.toPx()),
                                style = Stroke(
                                    width = 1.5.dp.toPx(),
                                    pathEffect = PathEffect.dashPathEffect(floatArrayOf(6f, 4f)),
                                ),
                            )
                        }
                } else {
                    Modifier.background(Surface.card).background(pale(hue))
                },
            )
            .clickable { block.route?.let(onOpen) }
            .testTag("agenda-grid-block-${block.key}")
            .clearAndSetSemantics {
                contentDescription = block.accessibility_label
                role = Role.Button
                if (block.movable) {
                    customActions = listOf(
                        CustomAccessibilityAction(grid.move_label) {
                            moveBy(snap)
                            true
                        },
                        CustomAccessibilityAction(grid.resize_label) {
                            onEvent(
                                AgendaHomeEvent(
                                    event_resized = AgendaHomeEvent.EventResized(
                                        instance_key = block.instance_key,
                                        end_minute = (block.end_minute + snap).coerceAtMost(DAY_MINUTES),
                                    ),
                                ),
                            )
                            true
                        },
                    )
                }
            }
        Row(body) {
            if (!block.is_task) Box(Modifier.width(3.dp).fillMaxHeight().background(hue))
            Column(
                Modifier
                    .weight(1f)
                    .padding(start = if (block.is_task) CHECK_SIZE + 4.dp else 4.dp, end = 2.dp, top = 1.dp),
            ) {
                Text(
                    block.title,
                    style = kitTextStyle(if (days.size > 1) KitType.Badge else KitType.Meta),
                    color = if (block.is_past) Surface.meta else Surface.ink,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (shownHeight >= HOUR_HEIGHT * 0.6f) {
                    Text(
                        block.time_label,
                        style = kitTextStyle(KitType.Badge),
                        color = Surface.meta,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (block.meta.isNotEmpty() && shownHeight >= HOUR_HEIGHT * 0.9f) {
                        Text(
                            block.meta,
                            style = kitTextStyle(KitType.Badge),
                            color = Surface.meta,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
        if (block.is_task) {
            // THE TASK'S CHECK sits over the block's own tap, a sibling so each speaks for itself.
            CheckCircle(hue, "agenda-grid-block-check-${block.task_id}", block.accessibility_label) { onCheck(block.task_id) }
        }
        if (block.movable) {
            // THE FOOT: a drag on it sets the end, snapped to the grid.
            Box(
                Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .height(RESIZE_HANDLE)
                    .pointerInput(block.key, hourPx, snap) {
                        detectDragGestures(
                            onDragStart = { foot = 0f },
                            onDrag = { change, amount ->
                                change.consume()
                                foot = (foot ?: 0f) + amount.y
                            },
                            onDragEnd = {
                                val by = foot
                                foot = null
                                if (by != null) {
                                    onEvent(
                                        AgendaHomeEvent(
                                            event_resized = AgendaHomeEvent.EventResized(
                                                instance_key = block.instance_key,
                                                end_minute = end(by),
                                            ),
                                        ),
                                    )
                                }
                            },
                            onDragCancel = { foot = null },
                        )
                    },
                contentAlignment = Alignment.BottomCenter,
            ) {
                Box(Modifier.padding(bottom = 2.dp).width(CHECK_SIZE + 6.dp).height(3.dp).clip(CircleShape).background(hue))
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// MONTH
// ---------------------------------------------------------------------------------------------

@Composable
internal fun AgendaMonthView(
    month: AgendaMonthGrid,
    actions: AgendaTaskActions,
    onEvent: (AgendaHomeEvent) -> Unit,
    onOpen: (Route) -> Unit,
) {
    val grid = month.style != AgendaMonthStyle.AGENDA_MONTH_STYLE_LIST
    LazyColumn(
        Modifier
            .fillMaxSize()
            .swipeStep { by -> stepPeriod(onEvent, by) }
            .semantics {
                paneTitle = month.title
                customActions = listOf(
                    CustomAccessibilityAction(month.previous_label) { stepPeriod(onEvent, -1); true },
                    CustomAccessibilityAction(month.next_label) { stepPeriod(onEvent, 1); true },
                )
            },
    ) {
        item(key = "month-grid") {
            Column(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER).testTag("agenda-month-grid")) {
                Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                    month.weekday_labels.forEach { label ->
                        Text(
                            label,
                            style = kitTextStyle(KitType.Badge),
                            color = Surface.meta,
                            modifier = Modifier.weight(1f),
                            maxLines = 1,
                            textAlign = TextAlign.Center,
                        )
                    }
                }
                month.cells.chunked(7).forEach { week ->
                    Row(Modifier.fillMaxWidth()) {
                        week.forEach { cell -> MonthCell(cell, grid, Modifier.weight(1f), onEvent) }
                    }
                }
            }
        }
        if (!grid) {
            if (month.selected.isEmpty()) {
                item(key = "month-selected-empty") {
                    Text(
                        month.selected_empty,
                        style = kitTextStyle(KitType.Row),
                        color = Surface.meta,
                        modifier = Modifier.padding(KitGeometry.GUTTER).testTag("agenda-month-selected-empty"),
                    )
                }
            } else {
                month.selected.forEach { section -> daySection(section, actions, onOpen) }
            }
        }
        item(key = "month-foot") { Spacer(Modifier.height(KitGeometry.GUTTER)) }
    }
}

@Composable
private fun MonthCell(cell: AgendaMonthCell, grid: Boolean, modifier: Modifier, onEvent: (AgendaHomeEvent) -> Unit) {
    val accent = appAccent("agenda")
    Column(
        modifier
            .heightIn(min = if (grid) HOUR_HEIGHT * 1.4f else KitGeometry.ROW_MIN)
            .clickable { pickDay(onEvent, cell.day, cell.opens) }
            .padding(vertical = 2.dp)
            .testTag("agenda-month-cell-${cell.day}")
            .clearAndSetSemantics {
                contentDescription = cell.accessibility_label
                role = Role.Button
                selected = cell.is_selected
            },
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            Modifier
                .size(28.dp)
                .clip(CircleShape)
                .then(
                    when {
                        cell.is_today -> Modifier.background(accent.fill)
                        cell.is_selected -> Modifier.border(2.dp, accent.fill, CircleShape)
                        else -> Modifier
                    },
                ),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                cell.day_number,
                style = kitTextStyle(if (cell.is_today) KitType.Row else KitType.Meta),
                color = when {
                    cell.is_today -> Color.White
                    !cell.in_month -> Surface.meta
                    else -> Surface.ink
                },
            )
        }
        if (grid) {
            Column(Modifier.fillMaxWidth().padding(top = 2.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                cell.chips.take(3).forEach { chip ->
                    val hue = hueColor(chip.hue_key)
                    val shape = RoundedCornerShape(radius("sm"))
                    Text(
                        chip.title,
                        style = kitTextStyle(KitType.Badge),
                        color = if (cell.in_month) Surface.ink else Surface.meta,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 1.dp)
                            .clip(shape)
                            .then(
                                if (chip.is_task) {
                                    Modifier.border(1.dp, hue, shape)
                                } else {
                                    Modifier.background(Surface.card).background(pale(hue))
                                },
                            )
                            .padding(horizontal = 2.dp),
                    )
                }
                if (cell.more_label.isNotEmpty()) {
                    Text(cell.more_label, style = kitTextStyle(KitType.Badge), color = Surface.meta, maxLines = 1)
                }
            }
        } else {
            Row(Modifier.padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                cell.dot_hue_keys.take(3).forEach { key -> Dot(hueColor(key)) }
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// YEAR
// ---------------------------------------------------------------------------------------------

@Composable
internal fun AgendaYearView(year: AgendaYearGrid, onEvent: (AgendaHomeEvent) -> Unit) {
    Column(
        Modifier
            .fillMaxSize()
            .swipeStep { by -> stepPeriod(onEvent, by) }
            .verticalScroll(rememberScrollState())
            .padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp)
            .testTag("agenda-year-grid")
            .semantics {
                paneTitle = year.title
                customActions = listOf(
                    CustomAccessibilityAction(year.previous_label) { stepPeriod(onEvent, -1); true },
                    CustomAccessibilityAction(year.next_label) { stepPeriod(onEvent, 1); true },
                )
            },
        verticalArrangement = Arrangement.spacedBy(KitGeometry.GUTTER),
    ) {
        year.months.chunked(3).forEach { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(KitGeometry.GUTTER)) {
                row.forEach { month -> YearMonth(month, Modifier.weight(1f), onEvent) }
            }
        }
    }
}

@Composable
private fun YearMonth(month: AgendaYearMonth, modifier: Modifier, onEvent: (AgendaHomeEvent) -> Unit) {
    val accent = appAccent("agenda")
    Column(
        modifier
            .clickable { pickDay(onEvent, month.first_day, AgendaDestination.AGENDA_DESTINATION_MONTH) }
            .testTag("agenda-year-month-${month.month}")
            .clearAndSetSemantics {
                contentDescription = month.accessibility_label
                role = Role.Button
            },
    ) {
        Text(
            month.label,
            style = kitTextStyle(KitType.Row),
            color = if (month.is_current) accent.text else Surface.ink,
            modifier = Modifier.padding(bottom = 4.dp),
        )
        month.days.chunked(7).forEach { week ->
            Row(Modifier.fillMaxWidth()) {
                week.forEach { day ->
                    Box(Modifier.weight(1f).height(18.dp), contentAlignment = Alignment.Center) {
                        if (day.day_number.isNotEmpty()) {
                            Box(
                                Modifier
                                    .size(18.dp)
                                    .clip(CircleShape)
                                    .then(if (day.is_today) Modifier.background(accent.fill) else Modifier),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    day.day_number,
                                    style = kitTextStyle(KitType.Badge),
                                    color = if (day.is_today) Color.White else Surface.body,
                                    maxLines = 1,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
