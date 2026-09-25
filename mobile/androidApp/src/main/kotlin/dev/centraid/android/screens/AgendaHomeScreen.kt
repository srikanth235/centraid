package dev.centraid.android.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import centraid.screen.v1.AgendaBandTab
import centraid.screen.v1.AgendaChrome
import centraid.screen.v1.AgendaDaySection
import centraid.screen.v1.AgendaEmpty
import centraid.screen.v1.AgendaEventRow
import centraid.screen.v1.AgendaHomeData
import centraid.screen.v1.AgendaHomeEvent
import centraid.screen.v1.AgendaHomeState
import centraid.screen.v1.AgendaNowLine
import centraid.screen.v1.AgendaRowStatus
import centraid.screen.v1.AgendaToolbar
import dev.centraid.android.kit.AppBand
import dev.centraid.android.kit.AppBandTab
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.DeniedGate
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * AGENDA'S HOME (#1046, wave 3): Day, Schedule and Waiting over one list of
 * day sections, with Search a mode over the current surface and More a sheet.
 *
 * The view owns nothing. Every string is the machine's — `AgendaChrome` for the
 * fixed words, the rows for the rest — and every tap is an `AgendaHomeEvent`
 * forwarded through [onEvent]. The one local value is the search field's text
 * while the IME holds it, and it only ever reports a DIFFERENCE from the state.
 *
 * **FOUR BRANCHES, NEVER TWO**: loading draws skeleton rows (not a spinner),
 * failure a sentence and a retry, denied the gate with no band, data the list
 * or its one empty.
 */
@Composable
public fun AgendaHomeScreen(
    state: AgendaHomeState,
    onEvent: (AgendaHomeEvent) -> Unit,
    onHome: () -> Unit,
) {
    val chrome = state.chrome ?: AgendaChrome()
    val denied = state.denied
    if (denied != null) {
        // THE DENIED GATE HAS NO BAND: there is no Agenda to move around in.
        DeniedGate(denied, Modifier.testTag("agenda-denied"))
        return
    }

    Column(Modifier.fillMaxSize().testTag("agenda-home")) {
        AgendaHeader(state, chrome, onEvent)
        if (state.search_open) AgendaSearchField(state, chrome, onEvent)
        val toolbar = state.toolbar
        if (toolbar != null && toolbar.shown) AgendaToolbarRow(toolbar, chrome, onEvent)
        Box(Modifier.weight(1f).fillMaxWidth()) {
            val loading = state.loading
            val failure = state.failure
            val data = state.data_
            when {
                loading != null -> AgendaSkeleton(chrome)
                failure != null -> Column(Modifier.padding(16.dp).testTag("agenda-failure")) {
                    Text(failure.sentence, style = centraidType("body"), color = centraidColor("text"))
                    if (failure.remedy.isNotEmpty()) {
                        Text(failure.remedy, style = centraidType("small"), color = centraidColor("textSoft"))
                    }
                    QuietButton(
                        label = chrome.retry,
                        testTag = "agenda-retry",
                        modifier = Modifier.padding(top = 12.dp),
                    ) { onEvent(AgendaHomeEvent(refreshed = AgendaHomeEvent.Refreshed())) }
                }
                data != null -> AgendaList(state, data, onEvent)
            }
        }
        AppBand(
            app = "agenda",
            tabs = state.band.map { it.toTab() },
            onSelect = { key -> onEvent(AgendaHomeEvent(band = AgendaHomeEvent.BandPicked(key = key))) },
            onHome = onHome,
        )
    }

    when (state.sheet) {
        AgendaHomeState.Sheet.SHEET_MORE -> AgendaMoreSheet(state, chrome, onEvent)
        AgendaHomeState.Sheet.SHEET_READS -> AgendaReadsSheet(chrome, onEvent)
        else -> Unit
    }
}

private fun AgendaBandTab.toTab(): AppBandTab =
    AppBandTab(key = key, label = label, iconKey = icon_key, selected = current)

@Composable
private fun AgendaHeader(
    state: AgendaHomeState,
    chrome: AgendaChrome,
    onEvent: (AgendaHomeEvent) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                chrome.title,
                style = centraidType("title"),
                color = centraidColor("text"),
                modifier = Modifier.semantics { heading() },
            )
            val meta = listOfNotNull(
                state.toolbar?.month_label?.takeIf { it.isNotEmpty() },
                state.data_?.event_count_label?.takeIf { it.isNotEmpty() },
            ).joinToString(" · ")
            if (meta.isNotEmpty()) {
                Text(meta, style = centraidType("annotLabel"), color = centraidColor("textSoft"))
            }
        }
        IconSquare(
            iconKey = "Plus",
            label = chrome.new_event,
            testTag = "agenda-new-event",
        ) { onEvent(AgendaHomeEvent(new_event = AgendaHomeEvent.NewEventRequested())) }
    }
}

@Composable
private fun AgendaSearchField(
    state: AgendaHomeState,
    chrome: AgendaChrome,
    onEvent: (AgendaHomeEvent) -> Unit,
) {
    var typed by remember { mutableStateOf(state.search_term) }
    // The machine can clear the term (search closed and reopened); follow it.
    LaunchedEffect(state.search_term) {
        if (state.search_term != typed) typed = state.search_term
    }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .heightIn(min = 44.dp)
            .clip8()
            .background(centraidColor("bgSunken"))
            .border(1.dp, centraidColor("line"), RoundedCornerShape(8.dp))
            .padding(start = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CentraidIcon(
            iconKey = "Search",
            tint = centraidColor("textFaint"),
            size = 16.dp,
            modifier = Modifier.clearAndSetSemantics { },
        )
        Box(Modifier.weight(1f).padding(horizontal = 8.dp)) {
            if (typed.isEmpty()) {
                Text(
                    chrome.search_placeholder,
                    style = centraidType("body"),
                    color = centraidColor("textFaint"),
                    modifier = Modifier.clearAndSetSemantics { },
                )
            }
            BasicTextField(
                value = typed,
                onValueChange = { next ->
                    typed = next
                    if (next != state.search_term) {
                        onEvent(AgendaHomeEvent(search_term = AgendaHomeEvent.SearchTermChanged(term = next)))
                    }
                },
                singleLine = true,
                textStyle = centraidType("body").copy(color = centraidColor("text")),
                cursorBrush = SolidColor(centraidColor("text")),
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    imeAction = ImeAction.Search,
                ),
                modifier = Modifier
                    .fillMaxWidth()
                    .focusRequester(focus)
                    .testTag("agenda-search-field")
                    .semantics { contentDescription = chrome.search_label },
            )
        }
        IconSquare(
            iconKey = "X",
            label = chrome.search_close,
            testTag = "agenda-search-close",
            bordered = false,
        ) { onEvent(AgendaHomeEvent(search_closed = AgendaHomeEvent.SearchClosed())) }
    }
}

@Composable
private fun AgendaToolbarRow(
    toolbar: AgendaToolbar,
    chrome: AgendaChrome,
    onEvent: (AgendaHomeEvent) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).testTag("agenda-toolbar"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            toolbar.range_label,
            style = centraidType("title"),
            color = centraidColor("text"),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f).semantics { heading() },
        )
        if (!toolbar.at_today) {
            QuietButton(label = chrome.today, testTag = "agenda-today") {
                onEvent(AgendaHomeEvent(today = AgendaHomeEvent.TodayRequested()))
            }
        }
        IconSquare("ChevronLeft", chrome.previous_day, "agenda-previous-day") {
            onEvent(AgendaHomeEvent(day_stepped = AgendaHomeEvent.DayStepped(days = -1)))
        }
        IconSquare("ChevronRight", chrome.next_day, "agenda-next-day") {
            onEvent(AgendaHomeEvent(day_stepped = AgendaHomeEvent.DayStepped(days = 1)))
        }
    }
}

/** Skeleton rows, never a spinner: the list's own geometry, drawn in `skel`. */
@Composable
private fun AgendaSkeleton(chrome: AgendaChrome) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(16.dp)
            .testTag("agenda-loading")
            .clearAndSetSemantics { contentDescription = chrome.loading },
    ) {
        repeat(6) { index ->
            Row(
                Modifier.fillMaxWidth().heightIn(min = 40.dp).padding(vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.width(44.dp)) {
                    if (index == 0) SkeletonBar(28.dp)
                }
                SkeletonBar(40.dp)
                Spacer(Modifier.width(12.dp))
                SkeletonBar(if (index % 2 == 0) 180.dp else 130.dp)
            }
        }
    }
}

@Composable
private fun SkeletonBar(width: androidx.compose.ui.unit.Dp) {
    Box(
        Modifier
            .width(width)
            .height(12.dp)
            .clip8()
            .background(centraidColor("skel")),
    )
}

@Composable
private fun AgendaList(
    state: AgendaHomeState,
    data: AgendaHomeData,
    onEvent: (AgendaHomeEvent) -> Unit,
) {
    if (data.empty != AgendaEmpty.AGENDA_EMPTY_NONE && data.empty != AgendaEmpty.AGENDA_EMPTY_UNSPECIFIED) {
        Column(
            Modifier.fillMaxSize().padding(24.dp).testTag("agenda-empty-${data.empty.name.lowercase()}"),
            verticalArrangement = Arrangement.Center,
        ) {
            Text(data.empty_title, style = centraidType("title"), color = centraidColor("text"))
            if (data.empty_body.isNotEmpty()) {
                Text(
                    data.empty_body,
                    style = centraidType("body"),
                    color = centraidColor("textSoft"),
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
            if (data.empty_action.isNotEmpty()) {
                QuietButton(
                    label = data.empty_action,
                    testTag = "agenda-empty-action",
                    modifier = Modifier.padding(top = 16.dp),
                ) { onEvent(AgendaHomeEvent(new_event = AgendaHomeEvent.NewEventRequested())) }
            }
        }
        return
    }

    val listState = rememberLazyListState()
    // THE KEYS, IN DRAW ORDER, so landing can find its index without the view
    // deciding where to land: the machine's `landing` names the day and
    // whether the now line is the target.
    val keys = remember(data) {
        buildList {
            data.days.forEach { section ->
                if (section.month_heading != null) add("month-${section.day}")
                add("day-${section.day}")
                section.items.forEach { item ->
                    item.event?.let { add("row-${it.row_key}") }
                    if (item.now_line != null) add("now-${section.day}")
                }
            }
        }
    }
    val landing = data.landing
    LaunchedEffect(landing?.day, landing?.now_line, state.destination, state.anchor_day) {
        if (landing == null || landing.day.isEmpty()) return@LaunchedEffect
        val target = if (landing.now_line) "now-${landing.day}" else "day-${landing.day}"
        val index = keys.indexOf(target).takeIf { it >= 0 } ?: keys.indexOf("day-${landing.day}")
        if (index >= 0) listState.scrollToItem(maxOf(0, if (landing.now_line) index - 1 else index))
    }

    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize().testTag("agenda-list"),
    ) {
        data.days.forEach { section -> daySection(section, onEvent) }
        item(key = "foot") { Spacer(Modifier.height(16.dp)) }
    }
}

private fun LazyListScope.daySection(
    section: AgendaDaySection,
    onEvent: (AgendaHomeEvent) -> Unit,
) {
    section.month_heading?.let { month ->
        item(key = "month-${section.day}") {
            Text(
                month,
                style = centraidType("smallStrong"),
                color = centraidColor("textSoft"),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 4.dp)
                    .semantics { heading() },
            )
        }
    }
    item(key = "day-${section.day}") {
        Column(Modifier.fillMaxWidth()) {
            Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp).height(1.dp).background(centraidColor("line")))
            Row(
                Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 8.dp),
                verticalAlignment = Alignment.Top,
            ) {
                DateColumn(section)
                Column(Modifier.weight(1f).padding(start = 8.dp)) {
                    section.ribbon?.let { Ribbon(it) }
                    if (section.due_count > 0) DueShelf(section, onEvent)
                    if (section.items.isEmpty() && section.ribbon == null && section.due_count == 0) {
                        Spacer(Modifier.height(32.dp))
                    }
                }
            }
        }
    }
    section.items.forEach { item ->
        val event = item.event
        val now = item.now_line
        if (event != null) {
            item(key = "row-${event.row_key}") { EventRow(event, onEvent) }
        } else if (now != null) {
            item(key = "now-${section.day}") { NowLine(now) }
        }
    }
}

/** The 44dp date column: the number, the weekday, and today on an accent pill. */
@Composable
private fun DateColumn(section: AgendaDaySection) {
    Column(
        Modifier
            .width(44.dp)
            .semantics(mergeDescendants = true) {
                contentDescription = section.heading
                heading()
            },
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        val numberInk = when {
            section.is_today -> centraidColor("onAccent")
            section.is_past -> centraidColor("textFaint")
            else -> centraidColor("text")
        }
        Box(
            if (section.is_today) {
                Modifier.clip(CircleShape).background(centraidColor("accent")).padding(horizontal = 8.dp)
            } else {
                Modifier
            },
            contentAlignment = Alignment.Center,
        ) {
            Text(
                section.day_number,
                style = centraidType(if (section.is_today) "title" else "smallStrong"),
                color = numberInk,
            )
        }
        Text(
            section.weekday_short,
            style = centraidType("eyebrow"),
            color = if (section.is_past) centraidColor("textFaint") else centraidColor("textSoft"),
        )
    }
}

/** Day context, never an event row: a 2px dotted rule and the names. */
@Composable
private fun Ribbon(label: String) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 4.dp).testTag("agenda-ribbon"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val ink = centraidColor("line")
        Canvas(Modifier.width(2.dp).height(18.dp)) {
            drawLine(
                color = ink,
                start = Offset(size.width / 2, 0f),
                end = Offset(size.width / 2, size.height),
                strokeWidth = size.width,
                pathEffect = PathEffect.dashPathEffect(floatArrayOf(2f, 3f)),
            )
        }
        Text(
            label,
            style = centraidType("annotLabel"),
            color = centraidColor("textSoft"),
            modifier = Modifier.padding(start = 8.dp),
        )
    }
}

/** "{n} due", a toggle, and the titles read-only when it is open. */
@Composable
private fun DueShelf(section: AgendaDaySection, onEvent: (AgendaHomeEvent) -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        Text(
            section.due_label,
            style = centraidType("annotLabelOn"),
            color = centraidColor("textSoft"),
            modifier = Modifier
                .heightIn(min = 32.dp)
                .clickable { onEvent(AgendaHomeEvent(due_toggled = AgendaHomeEvent.DueShelfToggled(day = section.day))) }
                .padding(vertical = 6.dp)
                .testTag("agenda-due-${section.day}")
                .semantics {
                    role = Role.Button
                    stateDescription = if (section.due_open) "expanded" else "collapsed"
                },
        )
        if (section.due_open) {
            section.due.forEach { task ->
                Text(
                    task.title,
                    style = centraidType("annotLabel"),
                    color = centraidColor("text"),
                    modifier = Modifier.padding(start = 8.dp, bottom = 4.dp),
                )
            }
        }
    }
}

@Composable
private fun EventRow(row: AgendaEventRow, onEvent: (AgendaHomeEvent) -> Unit) {
    val titleInk = if (row.is_past) centraidColor("textFaint") else centraidColor("text")
    val timeInk = if (row.is_past) centraidColor("textFaint") else centraidColor("textSoft")
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 40.dp)
            .clickable {
                onEvent(
                    AgendaHomeEvent(
                        event_picked = AgendaHomeEvent.EventPicked(
                            event_id = row.event_id,
                            instance_key = row.instance_key,
                            original_start_local = row.original_start_local,
                        ),
                    ),
                )
            }
            .padding(start = 68.dp, end = 16.dp, top = 6.dp, bottom = 6.dp)
            .testTag("agenda-row-${row.row_key}")
            .clearAndSetSemantics {
                contentDescription = row.accessibility_label
                role = Role.Button
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // THE 2PX HUE RULE at inline-start: the calendar, and nothing else.
        Box(
            Modifier
                .width(2.dp)
                .height(28.dp)
                .clip(RoundedCornerShape(1.dp))
                .background(hueColor(row.calendar_hue_key)),
        )
        Text(
            row.time_label,
            style = centraidType("annotLabel"),
            color = timeInk,
            maxLines = 2,
            modifier = Modifier.width(60.dp).padding(start = 8.dp),
        )
        Text(
            row.title,
            style = centraidType("body"),
            color = titleInk,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f).padding(start = 8.dp),
        )
        StatusChip(row)
    }
}

@Composable
private fun StatusChip(row: AgendaEventRow) {
    val ink = when (row.status) {
        AgendaRowStatus.AGENDA_ROW_STATUS_NEEDS_REPLY -> centraidColor("attention")
        AgendaRowStatus.AGENDA_ROW_STATUS_CANCEL_ASKED -> centraidColor("net")
        AgendaRowStatus.AGENDA_ROW_STATUS_PENDING -> centraidColor("textSoft")
        else -> return
    }
    if (row.status_label.isEmpty()) return
    Text(
        row.status_label,
        style = centraidType("annotLabel"),
        color = ink,
        maxLines = 1,
        modifier = Modifier
            .padding(start = 8.dp)
            .border(1.dp, ink, RoundedCornerShape(4.dp))
            .padding(horizontal = 6.dp, vertical = 1.dp),
    )
}

/** The now line: a 1px `net` rule with a 6px dot and the time. */
@Composable
private fun NowLine(now: AgendaNowLine) {
    val net = centraidColor("net")
    Row(
        Modifier
            .fillMaxWidth()
            .padding(start = 68.dp, end = 16.dp, top = 2.dp, bottom = 2.dp)
            .testTag("agenda-now-line")
            .clearAndSetSemantics { contentDescription = now.accessibility_label },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(6.dp).clip(CircleShape).background(net))
        Box(Modifier.weight(1f).height(1.dp).background(net))
        Text(
            now.label,
            style = centraidType("annotLabel"),
            color = net,
            modifier = Modifier.padding(start = 6.dp),
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AgendaMoreSheet(
    state: AgendaHomeState,
    chrome: AgendaChrome,
    onEvent: (AgendaHomeEvent) -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = { onEvent(AgendaHomeEvent(sheet_closed = AgendaHomeEvent.SheetClosed())) },
        containerColor = centraidColor("bg"),
    ) {
        Column(Modifier.fillMaxWidth().padding(bottom = 24.dp).testTag("agenda-more-sheet")) {
            SheetTitle(chrome.more_title)
            Text(
                chrome.calendars_heading,
                style = centraidType("smallStrong"),
                color = centraidColor("textSoft"),
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp).semantics { heading() },
            )
            state.data_?.calendars.orEmpty().forEach { calendar ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp)
                        .clickable {
                            onEvent(
                                AgendaHomeEvent(
                                    calendar_toggled = AgendaHomeEvent.CalendarToggled(
                                        calendar_id = calendar.calendar_id,
                                    ),
                                ),
                            )
                        }
                        .padding(horizontal = 16.dp)
                        .testTag("agenda-calendar-${calendar.calendar_id}")
                        .clearAndSetSemantics {
                            contentDescription = "${calendar.name}, ${calendar.state_label}"
                            role = Role.Switch
                        },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    val hue = hueColor(calendar.hue_key)
                    Box(
                        Modifier
                            .size(12.dp)
                            .clip(CircleShape)
                            .then(
                                if (calendar.hidden) {
                                    Modifier.border(1.5.dp, hue, CircleShape)
                                } else {
                                    Modifier.background(hue)
                                },
                            ),
                    )
                    Text(
                        calendar.name,
                        style = centraidType("body"),
                        color = if (calendar.hidden) centraidColor("textFaint") else centraidColor("text"),
                        modifier = Modifier.weight(1f).padding(start = 12.dp),
                    )
                    Text(calendar.state_label, style = centraidType("annotLabel"), color = centraidColor("textSoft"))
                }
            }
            Box(Modifier.fillMaxWidth().padding(vertical = 8.dp).height(1.dp).background(centraidColor("line")))
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .clickable {
                        onEvent(
                            AgendaHomeEvent(
                                sheet_opened = AgendaHomeEvent.SheetOpened(
                                    sheet = AgendaHomeState.Sheet.SHEET_READS,
                                ),
                            ),
                        )
                    }
                    .padding(horizontal = 16.dp)
                    .testTag("agenda-open-reads")
                    .semantics { role = Role.Button },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    chrome.reads_title,
                    style = centraidType("body"),
                    color = centraidColor("text"),
                    modifier = Modifier.weight(1f),
                )
                CentraidIcon(
                    iconKey = "ChevronRight",
                    tint = centraidColor("textFaint"),
                    size = 16.dp,
                    modifier = Modifier.clearAndSetSemantics { },
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AgendaReadsSheet(chrome: AgendaChrome, onEvent: (AgendaHomeEvent) -> Unit) {
    ModalBottomSheet(
        onDismissRequest = { onEvent(AgendaHomeEvent(sheet_closed = AgendaHomeEvent.SheetClosed())) },
        containerColor = centraidColor("bg"),
    ) {
        Column(Modifier.fillMaxWidth().padding(bottom = 24.dp).testTag("agenda-reads-sheet")) {
            SheetTitle(chrome.reads_title)
            chrome.reads_facts.forEach { fact ->
                Column(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 8.dp)
                        .semantics(mergeDescendants = true) { },
                ) {
                    Text(fact.label, style = centraidType("smallStrong"), color = centraidColor("text"))
                    Text(fact.detail, style = centraidType("small"), color = centraidColor("textSoft"))
                }
            }
        }
    }
}

@Composable
private fun SheetTitle(title: String) {
    Text(
        title,
        style = centraidType("title"),
        color = centraidColor("text"),
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp).semantics { heading() },
    )
}

/** A 36dp square, `line` border, one catalog mark, described by its label. */
@Composable
private fun IconSquare(
    iconKey: String,
    label: String,
    testTag: String,
    bordered: Boolean = true,
    onPress: () -> Unit,
) {
    Box(
        Modifier
            .size(44.dp)
            .clickable(onClick = onPress)
            .testTag(testTag)
            .clearAndSetSemantics {
                contentDescription = label
                role = Role.Button
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .size(36.dp)
                .then(
                    if (bordered) {
                        Modifier.border(1.dp, centraidColor("line"), RoundedCornerShape(8.dp))
                    } else {
                        Modifier
                    },
                ),
            contentAlignment = Alignment.Center,
        ) {
            CentraidIcon(iconKey = iconKey, tint = centraidColor("textSoft"), size = 18.dp)
        }
    }
}

/** A small quiet button: words on a hairline, no fill. */
@Composable
private fun QuietButton(
    label: String,
    testTag: String,
    modifier: Modifier = Modifier,
    onPress: () -> Unit,
) {
    Text(
        label,
        style = centraidType("annotLabelOn"),
        color = centraidColor("text"),
        modifier = modifier
            .heightIn(min = 36.dp)
            .widthIn(min = 44.dp)
            .clip8()
            .border(1.dp, centraidColor("line"), RoundedCornerShape(8.dp))
            .clickable(onClick = onPress)
            .padding(horizontal = 12.dp, vertical = 9.dp)
            .testTag(testTag)
            .semantics { role = Role.Button },
    )
}

private fun Modifier.clip8(): Modifier = this.then(Modifier.clip(RoundedCornerShape(8.dp)))


/**
 * A party hue key (`rose` … `violet`) to its emitted colour role (`cRose`).
 * An unknown key draws slate, the machine's own neutral for "no calendar".
 */
@Composable
private fun hueColor(key: String): Color {
    val known = key in PARTY_HUES
    return centraidColor(if (known) "c" + key.replaceFirstChar { it.uppercase() } else "cSlate")
}

/** `packages/design`'s eight party hues — the only keys `calendar_hue_key` carries. */
private val PARTY_HUES: Set<String> =
    setOf("rose", "amber", "ochre", "forest", "teal", "slate", "indigo", "violet")
