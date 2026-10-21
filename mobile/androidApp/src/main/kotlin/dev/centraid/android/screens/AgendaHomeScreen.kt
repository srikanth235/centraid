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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
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
import centraid.screen.v1.AgendaMoreRow
import centraid.screen.v1.AgendaNowLine
import centraid.screen.v1.AgendaRowStatus
import centraid.screen.v1.AgendaToolbar
import centraid.screen.v1.SearchContainer
import centraid.screen.v1.SearchField
import centraid.screen.v1.TasksChrome
import dev.centraid.android.kit.AppBand
import dev.centraid.android.kit.AppBandTab
import dev.centraid.android.kit.AppPlace
import dev.centraid.android.kit.DeniedGate
import dev.centraid.android.kit.LocalPhoneImport
import dev.centraid.android.kit.OutlineButton
import dev.centraid.android.kit.hueColor
import dev.centraid.android.kit.KitStepper
import dev.centraid.android.kit.RoomAction
import dev.centraid.android.kit.RoomSearch
import dev.centraid.android.kit.SearchContainerRow
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.SheetRow
import dev.centraid.android.kit.SkeletonBar
import dev.centraid.android.kit.StatusLine
import dev.centraid.android.kit.importLabel
import dev.centraid.android.screens.agenda.AGENDA_TASK_ROW
import dev.centraid.android.screens.agenda.AgendaNoticeView
import dev.centraid.android.screens.agenda.AgendaTaskActions
import dev.centraid.android.screens.agenda.AgendaTaskSheet
import dev.centraid.android.screens.agenda.AgendaTodoPlace
import dev.centraid.android.screens.agenda.agendaTaskActions
import dev.centraid.android.screens.tasks.TaskRowView
import dev.centraid.android.screens.tasks.TasksQuickAddBar
import dev.centraid.android.screens.tasks.taskGroupKeys
import dev.centraid.android.screens.tasks.taskGroups
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.android.theme.LocalCentraidTokens

/**
 * AGENDA'S HOME (#1046, wave 3; #1128): Day, Schedule, Waiting and To-do, with
 * Search a mode over the current surface and More a sheet. Day, Schedule and
 * Waiting are one list of day sections whose rows are events AND the tasks due
 * on the day (the round box checks one off in place); To-do is the Inbox, then
 * the projects by area (`AgendaTodoPlace`).
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
        // THE DENIED GATE KEEPS THE HEADER AND HAS NO BAND, iOS's shape: there
        // is no Agenda to move around in, search or add to.
        Box(Modifier.fillMaxSize().testTag("agenda-home")) {
            AppPlace(app = "agenda", title = chrome.title) {
                DeniedGate(denied, Modifier.testTag("agenda-denied"))
            }
        }
        return
    }

    // THE TASK WORDS (`AgendaChrome.tasks`) and the task events every place's rows share.
    val words = chrome.tasks ?: TasksChrome()
    val actions = agendaTaskActions(words, onEvent)
    val meta = listOfNotNull(
        state.toolbar?.month_label?.takeIf { it.isNotEmpty() },
        state.data_?.event_count_label?.takeIf { it.isNotEmpty() },
        state.data_?.todo?.count_label?.takeIf { it.isNotEmpty() },
    ).joinToString(" · ")
    // THE PLUS, PER PLACE (R-CHROME-1, R-1128-A2): the machine says what it is
    // called and what a tap does. On To-do it opens the quick-add bar and is
    // drawn only while the bar can be (`quick_add.shown`); elsewhere it is the
    // add sheet.
    val plusOpensBar = state.add_opens_quick_add
    val plusShown = state.add_label.isNotEmpty() && (!plusOpensBar || state.quick_add?.shown == true)
    Box(Modifier.fillMaxSize().testTag("agenda-home")) {
        AppPlace(
            app = "agenda",
            title = chrome.title,
            meta = meta,
            trailing = if (plusShown) {
                RoomAction(
                    iconKey = "Plus",
                    label = state.add_label,
                    testTag = if (plusOpensBar) "agenda-add-task" else "agenda-new-event",
                ) {
                    onEvent(
                        if (plusOpensBar) {
                            AgendaHomeEvent(quick_add_opened = AgendaHomeEvent.QuickAddOpened())
                        } else {
                            AgendaHomeEvent(new_event = AgendaHomeEvent.NewEventRequested())
                        },
                    )
                }
            } else {
                null
            },
            // SEARCH IS THE BAR UNDER THE TITLE (R-CHROME-2), above the day
            // bar; a tap opens the field through the machine.
            search = RoomSearch(
                field = SearchField(open_ = state.search_open, term = state.search_term, corrected = state.search_corrected),
                placeholder = chrome.search_placeholder,
                onTerm = { onEvent(AgendaHomeEvent(search_term = AgendaHomeEvent.SearchTermChanged(term = it))) },
                onClose = { onEvent(AgendaHomeEvent(search_closed = AgendaHomeEvent.SearchClosed())) },
                label = chrome.search_label,
                closeLabel = chrome.search_close,
                onOpen = { onEvent(AgendaHomeEvent(search_opened = AgendaHomeEvent.SearchOpened())) },
            ),
            band = {
                AppBand(
                    app = "agenda",
                    tabs = state.band.map { it.toTab() },
                    onSelect = { key -> onEvent(AgendaHomeEvent(band = AgendaHomeEvent.BandPicked(key = key))) },
                    onHome = onHome,
                )
            },
        ) {
            Column(Modifier.fillMaxSize()) {
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
                            OutlineButton(
                                label = chrome.retry,
                                testTag = "agenda-retry",
                                modifier = Modifier.padding(top = 12.dp),
                            ) { onEvent(AgendaHomeEvent(refreshed = AgendaHomeEvent.Refreshed())) }
                        }
                        data != null -> {
                            val todo = data.todo
                            if (todo != null) {
                                AgendaTodoPlace(todo, words, actions, onEvent)
                            } else {
                                AgendaList(state, data, actions, onEvent)
                            }
                        }
                    }
                }
                // THE TASK WRITE'S STATUS LINE ("Task done", Undo) docks under whichever place's list.
                StatusLine(state.status, actTag = "agenda-status-action") {
                    onEvent(AgendaHomeEvent(status_acted = AgendaHomeEvent.StatusActed()))
                }
                // THE PLUS OPENED THE BAR (To-do only): the keyboard-attached quick add, focus from `focused`.
                TasksQuickAddBar(
                    quickAdd = state.quick_add,
                    placeholder = words.quick_add_placeholder,
                    verb = words.quick_add_verb,
                    onChange = { onEvent(AgendaHomeEvent(quick_add_changed = AgendaHomeEvent.QuickAddChanged(title = it))) },
                    onSubmit = { onEvent(AgendaHomeEvent(quick_add_submitted = AgendaHomeEvent.QuickAddSubmitted())) },
                    // THE KEYBOARD LEFT: the machine puts an empty bar away.
                    onBlur = { onEvent(AgendaHomeEvent(quick_add_closed = AgendaHomeEvent.QuickAddClosed())) },
                    testTag = "agenda-quick-add",
                )
            }
        }
    }

    when (state.sheet) {
        AgendaHomeState.Sheet.SHEET_MORE -> AgendaMoreSheet(state, chrome, onEvent)
        AgendaHomeState.Sheet.SHEET_READS -> AgendaReadsSheet(chrome, onEvent)
        AgendaHomeState.Sheet.SHEET_FILE, AgendaHomeState.Sheet.SHEET_NEW_PROJECT -> AgendaTaskSheet(state, words, onEvent)
        else -> Unit
    }
}

private fun AgendaBandTab.toTab(): AppBandTab =
    AppBandTab(key = key, label = label, iconKey = icon_key, selected = current)

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
            OutlineButton(label = chrome.today, testTag = "agenda-today") {
                onEvent(AgendaHomeEvent(today = AgendaHomeEvent.TodayRequested()))
            }
        }
        KitStepper(
            previousLabel = chrome.previous_day,
            nextLabel = chrome.next_day,
            onPrevious = { onEvent(AgendaHomeEvent(day_stepped = AgendaHomeEvent.DayStepped(days = -1))) },
            onNext = { onEvent(AgendaHomeEvent(day_stepped = AgendaHomeEvent.DayStepped(days = 1))) },
            previousTag = "agenda-previous-day",
            nextTag = "agenda-next-day",
        )
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
private fun AgendaList(
    state: AgendaHomeState,
    data: AgendaHomeData,
    actions: AgendaTaskActions,
    onEvent: (AgendaHomeEvent) -> Unit,
) {
    val hasEmpty = data.empty != AgendaEmpty.AGENDA_EMPTY_NONE && data.empty != AgendaEmpty.AGENDA_EMPTY_UNSPECIFIED
    // THE BLOCKS DRAWN ABOVE THE DAYS (#1128): the absence notice and the
    // Overdue group (Day on today), then a search's project containers and task hits.
    val leads = data.notice != null || data.overdue != null || data.task_hits.isNotEmpty() || data.containers.isNotEmpty()
    // A DAY THAT OWES (Overdue, the notice) is never empty: the fold sends no
    // sentence for it, so an empty state here has nothing above it.
    if (hasEmpty) {
        AgendaEmptyBlock(data, onEvent, Modifier.fillMaxSize().padding(24.dp))
        return
    }

    val listState = rememberLazyListState()
    // NO EVENT OF THE MEMBER'S YET, only marks (due tasks, birthdays): the
    // phone's calendar is offered quietly above them, at the point of use.
    val importVerb = importLabel(data.import_source)
    val door = LocalPhoneImport.current
    val offersImport = importVerb.isNotEmpty() && door != null
    // THE KEYS, IN DRAW ORDER, so landing can find its index without the view
    // deciding where to land: the machine's `landing` names the day and
    // whether the now line is the target.
    val keys = remember(data, offersImport) {
        buildList {
            if (offersImport) add("import")
            if (data.notice != null) add("notice")
            data.overdue?.let { addAll(taskGroupKeys(listOf(it))) }
            data.containers.forEach { add(containerKey(it)) }
            addAll(taskGroupKeys(data.task_hits))
            data.days.forEach { section ->
                if (section.month_heading != null) add("month-${section.day}")
                add("day-${section.day}")
                section.items.forEach { item ->
                    item.event?.let { add("row-${it.row_key}") }
                    item.task?.let { add("task-${section.day}-${it.task_id}") }
                    if (item.now_line != null) add("now-${section.day}")
                }
            }
        }
    }
    val landing = data.landing
    LaunchedEffect(landing?.day, landing?.now_line, state.destination, state.anchor_day) {
        // LANDING NEVER SCROLLS PAST THE BLOCKS ABOVE THE DAYS: the member
        // opens on the notice and Overdue, or on a search's task hits.
        if (landing == null || landing.day.isEmpty() || leads) return@LaunchedEffect
        val target = if (landing.now_line) "now-${landing.day}" else "day-${landing.day}"
        val index = keys.indexOf(target).takeIf { it >= 0 } ?: keys.indexOf("day-${landing.day}")
        if (index >= 0) listState.scrollToItem(maxOf(0, if (landing.now_line) index - 1 else index))
    }

    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize().testTag("agenda-list"),
    ) {
        if (offersImport && door != null) {
            item(key = "import") {
                OutlineButton(
                    label = importVerb,
                    testTag = "agenda-import",
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                ) { door(data.import_source) }
            }
        }
        data.notice?.let { notice ->
            item(key = "notice") {
                AgendaNoticeView(notice) { onEvent(AgendaHomeEvent(notice_acted = AgendaHomeEvent.NoticeActed())) }
            }
        }
        // A SEARCH'S PROJECT CONTAINERS (Q-1128-1): the kit's one container row, a tap
        // `ProjectPicked` with the container's id, which `AgendaRouting` opens as To-do's
        // project row. Under a search there is no Overdue group, so they lead.
        items(data.containers, key = ::containerKey) { container ->
            SearchContainerRow(container) {
                onEvent(AgendaHomeEvent(project_picked = AgendaHomeEvent.ProjectPicked(project_id = container.id)))
            }
        }
        // OVERDUE (Day on today) AND A SEARCH'S TASK HITS: task groups, the Pages' own shape.
        taskGroups(
            listOfNotNull(data.overdue) + data.task_hits,
            onCheck = actions.onCheck,
            onPick = actions.onPick,
            onVerb = actions.onVerb,
            onFile = actions.onFile,
            fileVerb = actions.fileVerb,
            idPrefix = AGENDA_TASK_ROW,
        )
        data.days.forEach { section -> daySection(section, actions, onEvent) }
        item(key = "foot") { Spacer(Modifier.height(16.dp)) }
    }
}

/** A search container's list key, as Notes and Docs key theirs. */
private fun containerKey(container: SearchContainer): String = "c-${container.entity}-${container.id}"

/**
 * THE EMPTY STATE'S WORDS AND ITS ONE ACTION, whole-screen: it is sent only
 * when nothing else is drawn.
 */
@Composable
private fun AgendaEmptyBlock(
    data: AgendaHomeData,
    onEvent: (AgendaHomeEvent) -> Unit,
    modifier: Modifier,
) {
    Column(
        modifier.testTag("agenda-empty-${data.empty.name.lowercase()}"),
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
        // DAY ONE, WHERE THE PHONE HOLDS A CALENDAR (`import_source`): the
        // import in place of `empty_action` when the shell provides the
        // door — null inside a preview — and can read that source. "New
        // event" stays in the header, so the one action here is the
        // faster way to the member's own events.
        val importVerb = importLabel(data.import_source)
        val door = LocalPhoneImport.current
        if (importVerb.isNotEmpty() && door != null) {
            OutlineButton(
                label = importVerb,
                testTag = "agenda-empty-import",
                modifier = Modifier.padding(top = 16.dp),
            ) { door(data.import_source) }
        } else if (data.empty_action.isNotEmpty() && data.empty != AgendaEmpty.AGENDA_EMPTY_NO_MATCH) {
            // NO-MATCH'S ACTION IS ASK (#1097, R-1097-30): drawn only where the shell has a Chat tab,
            // and Android has none, so it draws the sentence without it.
            OutlineButton(
                label = data.empty_action,
                testTag = "agenda-empty-action",
                modifier = Modifier.padding(top = 16.dp),
            ) { onEvent(AgendaHomeEvent(new_event = AgendaHomeEvent.NewEventRequested())) }
        }
    }
}

private fun LazyListScope.daySection(
    section: AgendaDaySection,
    actions: AgendaTaskActions,
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
                    if (section.items.isEmpty() && section.ribbon == null) {
                        Spacer(Modifier.height(32.dp))
                    }
                }
            }
        }
    }
    section.items.forEach { item ->
        val event = item.event
        val task = item.task
        val now = item.now_line
        if (event != null) {
            item(key = "row-${event.row_key}") { EventRow(event, onEvent) }
        } else if (task != null) {
            // A TASK DUE ON THE DAY (R-1128-2): the round box checks it off where it
            // stands, a tap opens it, a long press offers "Move to project". Indented
            // past the date column, to the events' own start.
            item(key = "task-${section.day}-${task.task_id}") {
                TaskRowView(
                    task,
                    onCheck = actions.onCheck,
                    onPick = actions.onPick,
                    onFile = actions.onFile,
                    fileVerb = actions.fileVerb,
                    idPrefix = AGENDA_TASK_ROW,
                    indent = DAY_TASK_INDENT,
                )
            }
        } else if (now != null) {
            item(key = "now-${section.day}") { NowLine(now) }
        }
    }
}

/**
 * A DAY'S TASK ROW starts where the day's event rows do: the 44dp date column
 * and the gutters (68dp), less the row's own leading margin and the box's
 * padding, so the round mark sits under the events' hue rule.
 */
private val DAY_TASK_INDENT = 44.dp

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
                .clip(RoundedCornerShape((LocalCentraidTokens.current.radii["xs"] ?: 0).dp))
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
            .border(1.dp, ink, RoundedCornerShape((LocalCentraidTokens.current.radii["sm"] ?: 0).dp))
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

@Composable
private fun AgendaMoreSheet(
    state: AgendaHomeState,
    chrome: AgendaChrome,
    onEvent: (AgendaHomeEvent) -> Unit,
) {
    SheetRoom(
        title = chrome.more_title,
        onDismiss = { onEvent(AgendaHomeEvent(sheet_closed = AgendaHomeEvent.SheetClosed())) },
    ) {
        // THE ROWS ARE THE MACHINE'S (`more_rows`), the same list iOS draws: a
        // calendar row is a toggle with its hue dot, an action row a
        // `SheetRow`, and every tap sends the row's key.
        Column(Modifier.fillMaxWidth().testTag("agenda-more-sheet")) {
            state.more_rows.forEach { row ->
                if (row.section.isNotEmpty()) {
                    Text(
                        row.section,
                        style = centraidType("smallStrong"),
                        color = centraidColor("textSoft"),
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp).semantics { heading() },
                    )
                }
                val pick = { onEvent(AgendaHomeEvent(more_row = AgendaHomeEvent.MoreRowPicked(key = row.key))) }
                if (row.toggle) {
                    AgendaToggleRow(row, pick)
                } else {
                    SheetRow(
                        label = row.label,
                        testTag = "agenda-more-${row.key}",
                        onTap = pick,
                        iconKey = row.icon_key.ifEmpty { null },
                    )
                }
            }
        }
    }
}

/** A calendar's show/hide row: the hue dot, filled while shown, and its state word. */
@Composable
private fun AgendaToggleRow(row: AgendaMoreRow, onPick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clickable(onClick = onPick)
            .padding(horizontal = 16.dp)
            .testTag("agenda-more-${row.key}")
            .clearAndSetSemantics {
                contentDescription = row.spoken.ifEmpty { row.label }
                role = Role.Switch
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val hue = hueColor(row.hue_key)
        Box(
            Modifier
                .size(12.dp)
                .clip(CircleShape)
                .then(if (row.on) Modifier.background(hue) else Modifier.border(1.5.dp, hue, CircleShape)),
        )
        Text(
            row.label,
            style = centraidType("body"),
            color = if (row.on) centraidColor("text") else centraidColor("textFaint"),
            modifier = Modifier.weight(1f).padding(start = 12.dp),
        )
        Text(row.meta, style = centraidType("annotLabel"), color = centraidColor("textSoft"))
    }
}

@Composable
private fun AgendaReadsSheet(chrome: AgendaChrome, onEvent: (AgendaHomeEvent) -> Unit) {
    SheetRoom(
        title = chrome.reads_title,
        onDismiss = { onEvent(AgendaHomeEvent(sheet_closed = AgendaHomeEvent.SheetClosed())) },
    ) {
        Column(Modifier.fillMaxWidth().testTag("agenda-reads-sheet")) {
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
