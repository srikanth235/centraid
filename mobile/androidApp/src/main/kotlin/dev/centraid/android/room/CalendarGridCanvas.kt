package dev.centraid.android.room

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import centraid.core.v1.RoomCalendarCreateAt
import centraid.core.v1.RoomCalendarDay
import centraid.core.v1.RoomCalendarGrid
import centraid.core.v1.RoomCalendarItem
import centraid.core.v1.RoomCalendarItemKind
import centraid.core.v1.RoomCalendarPickDay
import centraid.core.v1.RoomCalendarView
import centraid.core.v1.RoomCanvasEvent
import dev.centraid.android.R
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.HoldGridText
import dev.centraid.android.kit.KitBadge
import dev.centraid.android.kit.KitChip
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitStepper
import dev.centraid.android.kit.KitText
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.StateColor
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.appAccent
import dev.centraid.android.kit.centraidResource
import dev.centraid.android.kit.kitCard
import dev.centraid.android.kit.kitTextStyle
import kotlin.math.max
import kotlin.math.min

private const val DEFAULT_START_HOUR = 8
private const val DEFAULT_END_HOUR = 18
private val HOUR_ROW_HEIGHT = 56.dp
private val COMPACT_HOUR_ROW_HEIGHT = 48.dp

@Composable
internal fun CalendarGridCanvas(
    grid: RoomCalendarGrid,
    onTap: (String) -> Unit,
    onCanvas: (RoomCanvasEvent) -> Unit,
    modifier: Modifier = Modifier,
) {
    val canvasSelectorId = grid.create_selector_id.ifEmpty { "calendar_grid" }
    val onPickDay: (String) -> Unit = { day ->
        if (day.isNotEmpty()) {
            onCanvas(
                RoomCanvasEvent(
                    selector_id = canvasSelectorId,
                    calendar_day = RoomCalendarPickDay(day = day),
                ),
            )
        }
    }
    val onCreateAt: (String, Int, Boolean) -> Unit = { day, minute, allDay ->
        if (day.isNotEmpty()) {
            onCanvas(
                RoomCanvasEvent(
                    selector_id = canvasSelectorId,
                    calendar_create = RoomCalendarCreateAt(
                        day = day,
                        minute = minute.coerceIn(0, 1439),
                        all_day = allDay,
                    ),
                ),
            )
        }
    }

    Column(
        modifier
            .fillMaxWidth()
            .testTag("canvas-calendar-grid"),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        CalendarControlStrip(grid = grid, onTap = onTap)

        when (grid.view) {
            RoomCalendarView.ROOM_CALENDAR_VIEW_DAY -> CalendarDayView(
                grid = grid,
                onTap = onTap,
                onPickDay = onPickDay,
                onCreateAt = onCreateAt,
            )
            RoomCalendarView.ROOM_CALENDAR_VIEW_WEEK -> CalendarWeekView(
                grid = grid,
                onTap = onTap,
                onPickDay = onPickDay,
                onCreateAt = onCreateAt,
            )
            RoomCalendarView.ROOM_CALENDAR_VIEW_MONTH -> CalendarMonthView(
                grid = grid,
                onPickDay = onPickDay,
                onCreateAt = onCreateAt,
            )
            RoomCalendarView.ROOM_CALENDAR_VIEW_LIST -> CalendarListView(
                grid = grid,
                onTap = onTap,
                onPickDay = onPickDay,
            )
            RoomCalendarView.ROOM_CALENDAR_VIEW_YEAR -> CalendarYearView(
                grid = grid,
                onPickDay = onPickDay,
            )
            else -> CalendarMonthView(
                grid = grid,
                onPickDay = onPickDay,
                onCreateAt = onCreateAt,
            )
        }
    }
}

@Composable
private fun CalendarControlStrip(
    grid: RoomCalendarGrid,
    onTap: (String) -> Unit,
) {
    val hasToday = grid.today_selector_id.isNotEmpty()
    val hasStep = grid.prev_selector_id.isNotEmpty() || grid.next_selector_id.isNotEmpty()
    if (!hasToday && !hasStep) return

    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER)
            .testTag("calendar-controls"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        if (hasToday) {
            KitChip(
                label = "Today",
                selected = false,
                onClick = { onTap(grid.today_selector_id) },
                modifier = Modifier.testTag(grid.today_selector_id),
            )
        } else {
            Spacer(Modifier.width(1.dp))
        }
        if (hasStep) {
            KitStepper(
                previousLabel = "Previous",
                nextLabel = "Next",
                onPrevious = { if (grid.prev_selector_id.isNotEmpty()) onTap(grid.prev_selector_id) },
                onNext = { if (grid.next_selector_id.isNotEmpty()) onTap(grid.next_selector_id) },
                canPrevious = grid.prev_selector_id.isNotEmpty(),
                canNext = grid.next_selector_id.isNotEmpty(),
                previousTag = grid.prev_selector_id.ifEmpty { "calendar-prev" },
                nextTag = grid.next_selector_id.ifEmpty { "calendar-next" },
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class, ExperimentalFoundationApi::class)
@Composable
private fun CalendarDayView(
    grid: RoomCalendarGrid,
    onTap: (String) -> Unit,
    onPickDay: (String) -> Unit,
    onCreateAt: (String, Int, Boolean) -> Unit,
) {
    val activeDay = grid.days.firstOrNull { it.selected }
        ?: grid.days.firstOrNull { it.today }
        ?: grid.days.firstOrNull()
        ?: return

    val overdueTasks = if (activeDay.today) {
        activeDay.items.filter { it.kind == RoomCalendarItemKind.ROOM_CALENDAR_ITEM_KIND_TASK && it.overdue }
    } else {
        emptyList()
    }
    val allDayItems = activeDay.items.filter { it.all_day && it !in overdueTasks }
    val timedItems = activeDay.items.filter { !it.all_day && it !in overdueTasks }
    val (startHour, endHour) = computeHourWindow(listOf(activeDay), grid.now_minute)

    Column(
        Modifier
            .fillMaxWidth()
            .testTag("calendar-view-day"),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (grid.days.size > 1) {
            CalendarDayStrip(days = grid.days, onPickDay = onPickDay)
        } else if (activeDay.label.isNotEmpty()) {
            KitText(
                text = activeDay.label,
                rung = KitType.Group,
                color = if (activeDay.today) appAccent("calendar").text else Surface.meta,
                modifier = Modifier
                    .padding(horizontal = KitGeometry.GUTTER)
                    .semantics { heading() },
            )
        }

        if (overdueTasks.isNotEmpty()) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = KitGeometry.GUTTER)
                    .kitCard()
                    .padding(12.dp)
                    .testTag("calendar-overdue-group"),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                KitText("Overdue", KitType.Group, StateColor.Red.text)
                overdueTasks.forEachIndexed { idx, item ->
                    CalendarItemRow(item = item, onTap = onTap)
                    if (idx < overdueTasks.lastIndex) RoomHairline()
                }
            }
        }

        if (allDayItems.isNotEmpty()) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = KitGeometry.GUTTER)
                    .combinedClickable(
                        onClick = {},
                        onLongClick = { onCreateAt(activeDay.day, 0, true) },
                    )
                    .testTag("calendar-allday-lane"),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                KitText("All day", KitType.Meta, Surface.meta)
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    allDayItems.forEach { item ->
                        CalendarAllDayChip(item = item, onTap = onTap)
                    }
                }
            }
        }

        CalendarSingleDayTimeGrid(
            day = activeDay,
            timedItems = timedItems,
            startHour = startHour,
            endHour = endHour,
            nowMinute = if (activeDay.today) grid.now_minute else null,
            onTap = onTap,
            onCreateAt = onCreateAt,
        )
    }
}

@Composable
private fun CalendarDayStrip(
    days: List<RoomCalendarDay>,
    onPickDay: (String) -> Unit,
) {
    val accent = appAccent("calendar")
    HoldGridText {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp)
                .testTag("calendar-day-strip"),
        ) {
            days.forEach { day ->
                val parts = splitDayHeader(day)
                Column(
                    Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(10.dp))
                        .clickable { onPickDay(day.day) }
                        .padding(vertical = 4.dp)
                        .testTag("calendar-day-${day.day}")
                        .semantics(mergeDescendants = true) {
                            role = Role.Button
                            selected = day.selected
                            contentDescription = day.label.ifEmpty { day.day }
                        },
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    if (parts.first.isNotEmpty()) {
                        KitText(parts.first, KitType.Badge, Surface.meta, maxLines = 1)
                    }
                    Box(
                        Modifier
                            .size(32.dp)
                            .clip(CircleShape)
                            .background(
                                when {
                                    day.today -> accent.fill
                                    day.selected -> Surface.fill
                                    else -> Color.Transparent
                                },
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = parts.second,
                            style = kitTextStyle(KitType.Row).copy(
                                fontWeight = if (day.today || day.selected) FontWeight.SemiBold else FontWeight.Normal,
                            ),
                            color = when {
                                day.today -> Color.White
                                day.in_scope -> Surface.ink
                                else -> Surface.meta
                            },
                            maxLines = 1,
                        )
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun CalendarSingleDayTimeGrid(
    day: RoomCalendarDay,
    timedItems: List<RoomCalendarItem>,
    startHour: Int,
    endHour: Int,
    nowMinute: Int?,
    onTap: (String) -> Unit,
    onCreateAt: (String, Int, Boolean) -> Unit,
) {
    val hours = (startHour until endHour).toList()
    val totalHeight = HOUR_ROW_HEIGHT * hours.size
    val layouts = layoutTimedItems(timedItems)

    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp),
    ) {
        HoldGridText {
            Column(Modifier.width(46.dp)) {
                hours.forEach { hour ->
                    Box(
                        Modifier
                            .height(HOUR_ROW_HEIGHT)
                            .fillMaxWidth()
                            .padding(end = 6.dp),
                        contentAlignment = Alignment.TopEnd,
                    ) {
                        KitText(formatHourLabel(hour), KitType.Meta, Surface.meta, maxLines = 1)
                    }
                }
            }
        }

        BoxWithConstraints(
            Modifier
                .weight(1f)
                .height(totalHeight),
        ) {
            val columnWidth = maxWidth
            Column(Modifier.fillMaxWidth()) {
                hours.forEach { hour ->
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .height(HOUR_ROW_HEIGHT)
                            .combinedClickable(
                                onClick = {},
                                onLongClick = { onCreateAt(day.day, hour * 60, false) },
                            )
                            .testTag("calendar-slot-${day.day}-$hour"),
                    ) {
                        RoomHairline()
                    }
                }
            }

            layouts.forEach { placed ->
                val topDp = minuteToDp(placed.item.start_minute, startHour, HOUR_ROW_HEIGHT)
                val durationMin = max(placed.item.end_minute - placed.item.start_minute, 30)
                val heightDp = (HOUR_ROW_HEIGHT * (durationMin / 60f)).coerceAtLeast(30.dp)
                val laneWidth = columnWidth / placed.laneCount
                val leftDp = laneWidth * placed.lane

                CalendarTimedBlock(
                    item = placed.item,
                    compact = placed.laneCount > 2,
                    onTap = onTap,
                    modifier = Modifier
                        .offset(x = leftDp, y = topDp)
                        .width((laneWidth - 3.dp).coerceAtLeast(24.dp))
                        .height(heightDp),
                )
            }

            if (nowMinute != null && nowMinute in (startHour * 60)..(endHour * 60)) {
                val nowY = minuteToDp(nowMinute, startHour, HOUR_ROW_HEIGHT)
                CalendarNowLine(
                    modifier = Modifier
                        .fillMaxWidth()
                        .offset(y = (nowY - 4.dp).coerceAtLeast(0.dp)),
                )
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun CalendarWeekView(
    grid: RoomCalendarGrid,
    onTap: (String) -> Unit,
    onPickDay: (String) -> Unit,
    onCreateAt: (String, Int, Boolean) -> Unit,
) {
    val days = grid.days
    if (days.isEmpty()) return
    val (startHour, endHour) = computeHourWindow(days, grid.now_minute)
    val hours = (startHour until endHour).toList()
    val totalHeight = COMPACT_HOUR_ROW_HEIGHT * hours.size
    val anyAllDay = days.any { day -> day.items.any { it.all_day } }

    Column(
        Modifier
            .fillMaxWidth()
            .testTag("calendar-view-week"),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(Modifier.fillMaxWidth().padding(start = 38.dp, end = 8.dp)) {
            CalendarDayStrip(days = days, onPickDay = onPickDay)
        }

        if (anyAllDay) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(start = 38.dp, end = 8.dp)
                    .testTag("calendar-week-allday"),
                horizontalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                days.forEach { day ->
                    val allDay = day.items.filter { it.all_day }
                    Column(
                        Modifier
                            .weight(1f)
                            .combinedClickable(
                                onClick = { onPickDay(day.day) },
                                onLongClick = { onCreateAt(day.day, 0, true) },
                            ),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        allDay.take(2).forEach { item ->
                            CalendarCompactPill(item = item, onTap = onTap)
                        }
                    }
                }
            }
        }

        Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 8.dp)) {
            HoldGridText {
                Column(Modifier.width(34.dp)) {
                    hours.forEach { hour ->
                        Box(
                            Modifier
                                .height(COMPACT_HOUR_ROW_HEIGHT)
                                .fillMaxWidth()
                                .padding(end = 4.dp),
                            contentAlignment = Alignment.TopEnd,
                        ) {
                            KitText(formatCompactHour(hour), KitType.Badge, Surface.meta, maxLines = 1)
                        }
                    }
                }
            }

            Row(Modifier.weight(1f).height(totalHeight)) {
                days.forEach { day ->
                    val timed = day.items.filter { !it.all_day }
                    val layouts = layoutTimedItems(timed)
                    BoxWithConstraints(
                        Modifier
                            .weight(1f)
                            .fillMaxHeight()
                            .border(width = 0.5.dp, color = Surface.line),
                    ) {
                        val colWidth = maxWidth
                        Column(Modifier.fillMaxWidth()) {
                            hours.forEach { hour ->
                                Box(
                                    Modifier
                                        .fillMaxWidth()
                                        .height(COMPACT_HOUR_ROW_HEIGHT)
                                        .combinedClickable(
                                            onClick = { onPickDay(day.day) },
                                            onLongClick = { onCreateAt(day.day, hour * 60, false) },
                                        )
                                        .testTag("calendar-slot-${day.day}-$hour"),
                                ) {
                                    RoomHairline()
                                }
                            }
                        }

                        layouts.forEach { placed ->
                            val topDp = minuteToDp(placed.item.start_minute, startHour, COMPACT_HOUR_ROW_HEIGHT)
                            val durationMin = max(placed.item.end_minute - placed.item.start_minute, 30)
                            val heightDp = (COMPACT_HOUR_ROW_HEIGHT * (durationMin / 60f)).coerceAtLeast(24.dp)
                            val laneW = colWidth / placed.laneCount
                            val leftDp = laneW * placed.lane

                            CalendarTimedBlock(
                                item = placed.item,
                                compact = true,
                                onTap = onTap,
                                modifier = Modifier
                                    .offset(x = leftDp, y = topDp)
                                    .width((laneW - 2.dp).coerceAtLeast(14.dp))
                                    .height(heightDp),
                            )
                        }

                        if (day.today && grid.now_minute in (startHour * 60)..(endHour * 60)) {
                            val nowY = minuteToDp(grid.now_minute, startHour, COMPACT_HOUR_ROW_HEIGHT)
                            CalendarNowLine(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .offset(y = (nowY - 4.dp).coerceAtLeast(0.dp)),
                            )
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun CalendarMonthView(
    grid: RoomCalendarGrid,
    onPickDay: (String) -> Unit,
    onCreateAt: (String, Int, Boolean) -> Unit,
) {
    val accent = appAccent("calendar")
    val weekdays = listOf("M", "T", "W", "T", "F", "S", "S")
    val weeks = grid.days.chunked(7)

    HoldGridText {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp)
                .testTag("calendar-view-month"),
        ) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(bottom = 4.dp),
            ) {
                weekdays.forEachIndexed { idx, letter ->
                    Text(
                        text = letter,
                        style = kitTextStyle(KitType.Meta),
                        color = if (idx >= 5) Surface.meta.copy(alpha = 0.7f) else Surface.meta,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.weight(1f),
                    )
                }
            }

            weeks.forEach { week ->
                Row(Modifier.fillMaxWidth()) {
                    week.forEach { day ->
                        val dayNum = extractDayNumber(day)
                        Column(
                            Modifier
                                .weight(1f)
                                .heightIn(min = 70.dp)
                                .border(width = 0.dp, color = Color.Transparent)
                                .combinedClickable(
                                    onClick = { onPickDay(day.day) },
                                    onLongClick = { onCreateAt(day.day, 9 * 60, false) },
                                )
                                .testTag("calendar-day-${day.day}")
                                .semantics(mergeDescendants = true) {
                                    role = Role.Button
                                    selected = day.selected
                                    contentDescription = day.label.ifEmpty { day.day }
                                },
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            RoomHairline()
                            Spacer(Modifier.height(6.dp))
                            Box(
                                Modifier
                                    .size(34.dp)
                                    .clip(CircleShape)
                                    .background(
                                        when {
                                            day.today -> accent.fill
                                            day.selected -> Surface.fill
                                            else -> Color.Transparent
                                        },
                                    ),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    text = dayNum,
                                    style = kitTextStyle(KitType.Row).copy(
                                        fontWeight = if (day.today || day.selected) FontWeight.SemiBold else FontWeight.Normal,
                                    ),
                                    color = when {
                                        day.today -> Color.White
                                        day.in_scope -> Surface.ink
                                        else -> Surface.meta.copy(alpha = 0.65f)
                                    },
                                    maxLines = 1,
                                )
                            }
                            if (day.items.isNotEmpty() || day.more_count > 0) {
                                Spacer(Modifier.height(4.dp))
                                Row(
                                    horizontalArrangement = Arrangement.spacedBy(3.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    day.items.take(3).forEach { item ->
                                        val dotColor = resolveCalendarItemColor(item)
                                        Box(
                                            Modifier
                                                .size(5.dp)
                                                .clip(CircleShape)
                                                .background(if (item.done) dotColor.copy(alpha = 0.4f) else dotColor),
                                        )
                                    }
                                    if (day.more_count > 0) {
                                        Text(
                                            text = "+${day.more_count}",
                                            style = kitTextStyle(KitType.Badge),
                                            color = Surface.meta,
                                            maxLines = 1,
                                        )
                                    }
                                }
                            }
                        }
                    }
                    repeat(7 - week.size) {
                        Spacer(Modifier.weight(1f))
                    }
                }
            }
        }
    }
}

@Composable
private fun CalendarListView(
    grid: RoomCalendarGrid,
    onTap: (String) -> Unit,
    onPickDay: (String) -> Unit,
) {
    val accent = appAccent("calendar")
    val visibleDays = grid.days.filter { it.items.isNotEmpty() || it.today || it.selected }
        .ifEmpty { grid.days }

    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER)
            .testTag("calendar-view-list"),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        visibleDays.forEach { day ->
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                KitText(
                    text = day.label.ifEmpty { day.day },
                    rung = KitType.Group,
                    color = if (day.today) accent.text else Surface.meta,
                    modifier = Modifier
                        .clickable { onPickDay(day.day) }
                        .testTag("calendar-day-${day.day}")
                        .semantics { heading() },
                )
                if (day.items.isNotEmpty()) {
                    Column(Modifier.fillMaxWidth().kitCard().padding(horizontal = 12.dp, vertical = 4.dp)) {
                        day.items.forEachIndexed { idx, item ->
                            CalendarItemRow(item = item, onTap = onTap)
                            if (idx < day.items.lastIndex) RoomHairline()
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CalendarYearView(
    grid: RoomCalendarGrid,
    onPickDay: (String) -> Unit,
) {
    val accent = appAccent("calendar")
    val months = grid.days.groupBy { day ->
        if (day.day.length >= 7) day.day.substring(0, 7) else day.day
    }.entries.toList()

    HoldGridText {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = KitGeometry.GUTTER)
                .testTag("calendar-view-year"),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            months.chunked(3).forEach { rowMonths ->
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    rowMonths.forEach { (monthKey, monthDays) ->
                        val hasToday = monthDays.any { it.today }
                        Column(
                            Modifier
                                .weight(1f)
                                .kitCard()
                                .padding(8.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            KitText(
                                text = formatMonthHeader(monthKey),
                                rung = KitType.Badge,
                                color = if (hasToday) accent.text else Surface.ink,
                                maxLines = 1,
                            )
                            monthDays.chunked(7).forEach { week ->
                                Row(Modifier.fillMaxWidth()) {
                                    week.forEach { day ->
                                        Box(
                                            Modifier
                                                .weight(1f)
                                                .clip(CircleShape)
                                                .background(if (day.today) accent.fill else Color.Transparent)
                                                .clickable { onPickDay(day.day) }
                                                .padding(vertical = 2.dp)
                                                .testTag("calendar-day-${day.day}"),
                                            contentAlignment = Alignment.Center,
                                        ) {
                                            Text(
                                                text = extractDayNumber(day),
                                                style = kitTextStyle(KitType.Badge),
                                                color = when {
                                                    day.today -> Color.White
                                                    day.items.isNotEmpty() -> accent.text
                                                    day.in_scope -> Surface.ink
                                                    else -> Surface.meta.copy(alpha = 0.5f)
                                                },
                                                maxLines = 1,
                                            )
                                        }
                                    }
                                    repeat(7 - week.size) { Spacer(Modifier.weight(1f)) }
                                }
                            }
                        }
                    }
                    repeat(3 - rowMonths.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
    }
}

@Composable
private fun CalendarTimedBlock(
    item: RoomCalendarItem,
    compact: Boolean,
    onTap: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val itemColor = resolveCalendarItemColor(item)
    val isTask = item.kind == RoomCalendarItemKind.ROOM_CALENDAR_ITEM_KIND_TASK
    val shape = RoundedCornerShape(8.dp)

    val isShort = (item.end_minute - item.start_minute).let { it in 1..44 }
    Row(
        modifier
            .clip(shape)
            .background(itemColor.copy(alpha = if (item.done) 0.08f else 0.14f))
            .clickable(enabled = item.selector_id.isNotEmpty()) { onTap(item.selector_id) }
            .testTag(item.selector_id.ifEmpty { "calendar-item-${item.title}" })
            .semantics(mergeDescendants = true) {
                role = Role.Button
                if (item.a11y_label.isNotEmpty()) contentDescription = item.a11y_label
            },
    ) {
        Box(
            Modifier
                .width(3.dp)
                .fillMaxHeight()
                .background(if (item.overdue) StateColor.Red.fill else itemColor),
        )
        Column(
            Modifier
                .weight(1f)
                .padding(horizontal = if (compact) 4.dp else 8.dp, vertical = 3.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                if (isTask) {
                    CalendarTaskCircle(done = item.done, color = if (item.overdue) StateColor.Red.fill else itemColor)
                } else if (item.kind == RoomCalendarItemKind.ROOM_CALENDAR_ITEM_KIND_PERSON_DATE) {
                    CentraidIcon("Gift", tint = itemColor, size = 11.dp)
                }
                Text(
                    text = item.title,
                    style = kitTextStyle(if (compact) KitType.Badge else KitType.Meta).copy(
                        fontWeight = FontWeight.SemiBold,
                        textDecoration = if (item.done) TextDecoration.LineThrough else TextDecoration.None,
                    ),
                    color = if (item.done) Surface.meta else Surface.ink,
                    maxLines = if (compact || isShort) 1 else 3,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (!compact && isShort && item.time_label.isNotEmpty()) {
                    Text(
                        text = item.time_label,
                        style = kitTextStyle(KitType.Badge),
                        color = if (item.overdue) StateColor.Red.text else Surface.meta,
                        maxLines = 1,
                    )
                }
            }
            if (!compact && !isShort && item.time_label.isNotEmpty()) {
                Text(
                    text = item.time_label,
                    style = kitTextStyle(KitType.Badge),
                    color = if (item.overdue) StateColor.Red.text else Surface.meta,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (!compact && !isShort && item.needs_reply) {
                KitBadge(label = "Needs reply", state = StateColor.Amber)
            }
        }
    }
}

@Composable
private fun CalendarAllDayChip(
    item: RoomCalendarItem,
    onTap: (String) -> Unit,
) {
    val itemColor = resolveCalendarItemColor(item)
    val isTask = item.kind == RoomCalendarItemKind.ROOM_CALENDAR_ITEM_KIND_TASK
    Row(
        Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(itemColor.copy(alpha = 0.14f))
            .clickable(enabled = item.selector_id.isNotEmpty()) { onTap(item.selector_id) }
            .padding(horizontal = 8.dp, vertical = 5.dp)
            .testTag(item.selector_id.ifEmpty { "calendar-allday-${item.title}" })
            .semantics(mergeDescendants = true) {
                role = Role.Button
                if (item.a11y_label.isNotEmpty()) contentDescription = item.a11y_label
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        if (isTask) {
            CalendarTaskCircle(done = item.done, color = if (item.overdue) StateColor.Red.fill else itemColor)
        } else if (item.kind == RoomCalendarItemKind.ROOM_CALENDAR_ITEM_KIND_PERSON_DATE) {
            CentraidIcon("Gift", tint = itemColor, size = 12.dp)
        } else {
            Box(Modifier.size(6.dp).clip(CircleShape).background(itemColor))
        }
        Text(
            text = item.title,
            style = kitTextStyle(KitType.Meta).copy(
                fontWeight = FontWeight.SemiBold,
                textDecoration = if (item.done) TextDecoration.LineThrough else TextDecoration.None,
            ),
            color = if (item.done) Surface.meta else Surface.ink,
        )
        if (item.needs_reply) {
            Box(Modifier.size(6.dp).clip(CircleShape).background(StateColor.Amber.fill))
        }
    }
}

@Composable
private fun CalendarCompactPill(
    item: RoomCalendarItem,
    onTap: (String) -> Unit,
) {
    val itemColor = resolveCalendarItemColor(item)
    Box(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(4.dp))
            .background(itemColor.copy(alpha = 0.18f))
            .clickable(enabled = item.selector_id.isNotEmpty()) { onTap(item.selector_id) }
            .padding(horizontal = 3.dp, vertical = 2.dp)
            .testTag(item.selector_id.ifEmpty { "calendar-pill-${item.title}" }),
    ) {
        Text(
            text = item.title,
            style = kitTextStyle(KitType.Badge),
            color = Surface.ink,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun CalendarItemRow(
    item: RoomCalendarItem,
    onTap: (String) -> Unit,
) {
    val itemColor = resolveCalendarItemColor(item)
    val isTask = item.kind == RoomCalendarItemKind.ROOM_CALENDAR_ITEM_KIND_TASK
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = KitGeometry.ROW_MIN)
            .clickable(enabled = item.selector_id.isNotEmpty()) { onTap(item.selector_id) }
            .padding(vertical = 8.dp)
            .testTag(item.selector_id.ifEmpty { "calendar-row-${item.title}" })
            .semantics(mergeDescendants = true) {
                role = Role.Button
                if (item.a11y_label.isNotEmpty()) contentDescription = item.a11y_label
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        when {
            isTask -> CalendarTaskCircle(
                done = item.done,
                color = if (item.overdue) StateColor.Red.fill else itemColor,
                size = 18.dp,
            )
            item.kind == RoomCalendarItemKind.ROOM_CALENDAR_ITEM_KIND_PERSON_DATE ->
                CentraidIcon("Gift", tint = itemColor, size = 18.dp)
            else -> Box(
                Modifier
                    .width(4.dp)
                    .height(28.dp)
                    .clip(RoundedCornerShape(2.dp))
                    .background(itemColor),
            )
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                text = item.title,
                style = kitTextStyle(KitType.Row).copy(
                    textDecoration = if (item.done) TextDecoration.LineThrough else TextDecoration.None,
                ),
                color = if (item.done) Surface.meta else Surface.ink,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            if (item.time_label.isNotEmpty()) {
                KitText(
                    text = item.time_label,
                    rung = KitType.Meta,
                    color = if (item.overdue) StateColor.Red.text else Surface.meta,
                    maxLines = 1,
                )
            }
        }
        if (item.overdue && !item.done) {
            KitBadge(label = "Overdue", state = StateColor.Red)
        } else if (item.needs_reply) {
            KitBadge(label = "Needs reply", state = StateColor.Amber)
        }
    }
}

@Composable
private fun CalendarTaskCircle(
    done: Boolean,
    color: Color,
    size: Dp = 14.dp,
) {
    Box(
        Modifier
            .size(size)
            .clip(CircleShape)
            .then(
                if (done) {
                    Modifier.background(color)
                } else {
                    Modifier.border(1.5.dp, color, CircleShape)
                },
            ),
        contentAlignment = Alignment.Center,
    ) {
        if (done) {
            CentraidIcon("Check", tint = Color.White, size = size * 0.65f)
        }
    }
}

@Composable
private fun CalendarNowLine(modifier: Modifier = Modifier) {
    Row(
        modifier.testTag("calendar-now-line"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(8.dp)
                .clip(CircleShape)
                .background(StateColor.Red.fill),
        )
        Box(
            Modifier
                .weight(1f)
                .height(1.5.dp)
                .background(StateColor.Red.fill),
        )
    }
}

private data class PlacedCalendarItem(
    val item: RoomCalendarItem,
    val lane: Int,
    val laneCount: Int,
)

private fun layoutTimedItems(items: List<RoomCalendarItem>): List<PlacedCalendarItem> {
    if (items.isEmpty()) return emptyList()
    val sorted = items.sortedWith(compareBy<RoomCalendarItem> { it.start_minute }.thenByDescending { it.end_minute })
    val laneEnds = mutableListOf<Int>()
    val assigned = mutableListOf<Pair<RoomCalendarItem, Int>>()

    sorted.forEach { item ->
        val end = max(item.end_minute, item.start_minute + 30)
        var lane = laneEnds.indexOfFirst { it <= item.start_minute }
        if (lane < 0) {
            lane = laneEnds.size
            laneEnds.add(end)
        } else {
            laneEnds[lane] = end
        }
        assigned.add(item to lane)
    }

    val totalLanes = laneEnds.size.coerceAtLeast(1)
    return assigned.map { (item, lane) -> PlacedCalendarItem(item, lane, totalLanes) }
}

private fun computeHourWindow(days: List<RoomCalendarDay>, nowMinute: Int): Pair<Int, Int> {
    var start = DEFAULT_START_HOUR
    var end = DEFAULT_END_HOUR
    days.forEach { day ->
        day.items
            .filter { !it.all_day && !it.overdue && (it.start_minute > 0 || it.end_minute > 0) }
            .forEach { item ->
                start = min(start, item.start_minute / 60)
                val endHour = (max(item.end_minute, item.start_minute + 30) + 59) / 60
                end = max(end, endHour)
            }
    }
    if (nowMinute in 1..1439) {
        start = min(start, nowMinute / 60)
        end = max(end, (nowMinute / 60) + 1)
    }
    return start.coerceIn(0, 22) to end.coerceIn(start + 2, 24)
}

private fun minuteToDp(minute: Int, startHour: Int, hourHeight: Dp): Dp {
    val offsetMinutes = (minute - startHour * 60).coerceAtLeast(0)
    return hourHeight * (offsetMinutes / 60f)
}

private fun formatHourLabel(hour: Int): String = "${hour.toString().padStart(2, '0')}:00"

private fun formatCompactHour(hour: Int): String = hour.toString().padStart(2, '0')

private fun splitDayHeader(day: RoomCalendarDay): Pair<String, String> {
    val tokens = day.label.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
    val num = extractDayNumber(day)
    val weekday = tokens.firstOrNull { it != num && it.any(Char::isLetter) }?.take(3).orEmpty()
    return weekday to num
}

private fun extractDayNumber(day: RoomCalendarDay): String {
    val fromIso = day.day.split("-").lastOrNull()?.toIntOrNull()
    if (fromIso != null) return fromIso.toString()
    val digits = day.label.filter(Char::isDigit).toIntOrNull()
    return digits?.toString() ?: day.label
}

private fun formatMonthHeader(yearMonth: String): String {
    val month = yearMonth.split("-").getOrNull(1)?.toIntOrNull() ?: return yearMonth
    val names = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
    return names.getOrElse(month - 1) { yearMonth }
}

@Composable
private fun resolveCalendarItemColor(item: RoomCalendarItem): Color {
    val fallback = when (item.kind) {
        RoomCalendarItemKind.ROOM_CALENDAR_ITEM_KIND_TASK -> appAccent("reminders").fill
        RoomCalendarItemKind.ROOM_CALENDAR_ITEM_KIND_PERSON_DATE -> appAccent("people").fill
        else -> appAccent("calendar").fill
    }
    return resolveCanvasHueColor(item.hue_key, fallback)
}

@Composable
internal fun resolveCanvasHueColor(hueKey: String, fallback: Color): Color = when (hueKey.lowercase()) {
    "blue" -> centraidResource(R.color.centraid_list_blue)
    "graphite" -> centraidResource(R.color.centraid_list_graphite)
    "indigo" -> centraidResource(R.color.centraid_list_indigo)
    "mustard" -> centraidResource(R.color.centraid_list_mustard)
    "orchid" -> centraidResource(R.color.centraid_list_orchid)
    "petrol" -> centraidResource(R.color.centraid_list_petrol)
    "raspberry" -> centraidResource(R.color.centraid_list_raspberry)
    "violet" -> centraidResource(R.color.centraid_list_violet)
    "calendar" -> appAccent("calendar").fill
    "docs" -> appAccent("docs").fill
    "health" -> appAccent("health").fill
    "locker" -> appAccent("locker").fill
    "money" -> appAccent("money").fill
    "notes" -> appAccent("notes").fill
    "people" -> appAccent("people").fill
    "photos" -> appAccent("photos").fill
    "reminders" -> appAccent("reminders").fill
    "green" -> StateColor.Green.fill
    "red" -> StateColor.Red.fill
    "amber" -> StateColor.Amber.fill
    else -> fallback
}
