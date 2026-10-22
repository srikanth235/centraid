package dev.centraid.android.screens.agenda

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import centraid.core.v1.Route
import centraid.core.v1.TodoCheck
import centraid.core.v1.TodoChoice
import centraid.core.v1.TodoQuickAdd
import centraid.core.v1.TodoRow
import centraid.core.v1.TodoRowGroup
import centraid.screen.v1.SectionHead
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.OutlineButton
import dev.centraid.android.kit.SectionHeader
import dev.centraid.android.kit.SheetRow
import dev.centraid.android.kit.hueColor
import dev.centraid.android.kit.rememberFollowedText
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * THE TO-DO ROW, ONE SHAPE: the box, the title over its due word and meta line,
 * the priority word and the project dot. An open root offers "Move to project"
 * on a long press (and to a screen reader as an action), never as a verb on
 * every row. Every word is the row's own; the view only lays them out. A tap
 * hands the row's own `route` to [onOpen], which the shell pushes.
 *
 * ONE SHAPE IN TWO HOMES (#1128): the pushed to-do pages draw it at the page
 * margin under `tasks-row`, and Agenda's Day, Schedule and To-do draw it under
 * `agenda-task-row`, indented past the date column on a day. The ids a flow
 * taps are `<idPrefix>-<task id>` on the row and `<idPrefix>-check-<task id>`
 * on its box, the same strings iOS sets.
 */
@Composable
internal fun TodoRowView(
    row: TodoRow,
    onCheck: (String) -> Unit,
    onOpen: (Route) -> Unit,
    onFile: ((String) -> Unit)? = null,
    fileVerb: String = "",
    depth: Int = 0,
    idPrefix: String = "tasks-row",
    indent: Dp = 0.dp,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = KitGeometry.ROW_MIN)
            .padding(start = KitGeometry.GUTTER / 2 + indent + (depth * 24).dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(2.dp).height(28.dp))
        TodoCheckBox(row.check, row.check_label, tag = "$idPrefix-check-${row.task_id}") { onCheck(row.task_id) }
        val file = if (row.can_file && onFile != null && fileVerb.isNotEmpty()) ({ onFile(row.task_id) }) else null
        Column(
            Modifier
                .weight(1f)
                .combinedClickable(onClick = { row.route?.let(onOpen) }, onLongClick = file, onLongClickLabel = fileVerb.ifEmpty { null })
                .padding(vertical = 8.dp)
                .testTag("$idPrefix-${row.task_id}")
                .clearAndSetSemantics {
                    contentDescription = row.accessibility_label.ifEmpty { row.title }
                    role = Role.Button
                    if (file != null) customActions = listOf(CustomAccessibilityAction(fileVerb) { file(); true })
                },
        ) {
            Text(
                row.title,
                style = centraidType("body"),
                color = centraidColor(if (row.check == TodoCheck.TODO_CHECK_OPEN) "text" else "textFaint"),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            val line = listOf(row.due_label, row.meta).filter { it.isNotEmpty() }
            if (line.isNotEmpty()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (row.due_label.isNotEmpty()) {
                        Text(
                            row.due_label,
                            style = centraidType("annotLabel"),
                            color = centraidColor(if (row.overdue) "warning" else "textSoft"),
                            maxLines = 1,
                        )
                    }
                    if (row.meta.isNotEmpty()) {
                        Text(
                            (if (row.due_label.isNotEmpty()) " · " else "") + row.meta,
                            style = centraidType("annotLabel"),
                            color = centraidColor("textSoft"),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
        if (row.priority_label.isNotEmpty()) {
            Text(
                row.priority_label,
                style = centraidType("annotLabel"),
                color = centraidColor("textSoft"),
                modifier = Modifier.padding(start = 6.dp),
            )
        }
        if (row.project_hue_key.isNotEmpty()) {
            Box(
                Modifier
                    .padding(start = 8.dp)
                    .size(6.dp)
                    .clip(CircleShape)
                    .background(hueColor(row.project_hue_key)),
            )
        }
    }
    row.children.forEach { child ->
        TodoRowView(child, onCheck, onOpen, onFile = null, depth = depth + 1, idPrefix = idPrefix, indent = indent)
    }
}

/** THE BOX: open is a ring, done a check, released a dash. */
@Composable
internal fun TodoCheckBox(check: TodoCheck, label: String, tag: String = "tasks-check", onTap: () -> Unit) {
    Box(
        Modifier
            .size(KitGeometry.ROW_MIN)
            .clickable(onClick = onTap)
            .testTag(tag)
            .clearAndSetSemantics {
                contentDescription = label
                role = Role.Checkbox
            },
        contentAlignment = Alignment.Center,
    ) {
        val done = check == TodoCheck.TODO_CHECK_DONE
        Box(
            Modifier
                .size(20.dp)
                .clip(CircleShape)
                .border(KitGeometry.HAIRLINE, centraidColor("textSoft"), CircleShape)
                .background(if (done) centraidColor("text") else centraidColor("bg")),
            contentAlignment = Alignment.Center,
        ) {
            when (check) {
                TodoCheck.TODO_CHECK_DONE -> CentraidIcon("Check", tint = centraidColor("bg"), size = 12.dp)
                TodoCheck.TODO_CHECK_WONT_DO -> Box(Modifier.width(8.dp).height(1.5.dp).background(centraidColor("textSoft")))
                TodoCheck.TODO_CHECK_IN_PROCESS -> Box(Modifier.size(8.dp).clip(CircleShape).background(centraidColor("textSoft")))
                else -> Unit
            }
        }
    }
}

/** The groups of a list: month heading, section head with its one verb, the rows. */
internal fun LazyListScope.todoGroups(
    groups: List<TodoRowGroup>,
    onCheck: (String) -> Unit,
    onOpen: (Route) -> Unit,
    onVerb: (String) -> Unit,
    onFile: ((String) -> Unit)? = null,
    fileVerb: String = "",
    idPrefix: String = "tasks-row",
) {
    groups.forEach { group ->
        item(key = "group-${group.key}") {
            Column {
                val month = group.month_heading
                if (!month.isNullOrEmpty()) {
                    Text(
                        month,
                        style = centraidType("eyebrow"),
                        color = centraidColor("textFaint"),
                        modifier = Modifier.padding(start = KitGeometry.GUTTER, top = 20.dp),
                    )
                }
                SectionHeader(
                    SectionHead(title = group.title, count = group.meta.toIntOrNull(), verb_label = group.verb_label),
                    onVerb = if (group.verb_key.isNotEmpty()) ({ onVerb(group.verb_key) }) else null,
                )
            }
        }
        group.rows.forEach { row ->
            item(key = "row-${group.key}-${row.task_id}") {
                TodoRowView(row, onCheck, onOpen, onFile, fileVerb, idPrefix = idPrefix)
            }
        }
    }
}

/**
 * THE ITEM KEYS [todoGroups] DRAWS, IN ORDER: a list that scrolls to an item
 * by its key (Agenda's landing) counts the blocks above its days with this, so
 * the two never drift apart.
 */
internal fun todoGroupKeys(groups: List<TodoRowGroup>): List<String> =
    groups.flatMap { group -> listOf("group-${group.key}") + group.rows.map { "row-${group.key}-${it.task_id}" } }

/**
 * THE QUICK-ADD BAR: a bare title whose placeholder says where it lands, and
 * Add once there are words. Drawn while the machine holds it `drawn` — on
 * Agenda's To-do, only after the header's Plus (the project page, which has no
 * Plus, keeps it open).
 */
@Composable
internal fun TodoQuickAddBar(
    quickAdd: TodoQuickAdd?,
    placeholder: String,
    verb: String,
    onChange: (String) -> Unit,
    onSubmit: () -> Unit,
    onBlur: () -> Unit = {},
    testTag: String = "tasks-quick-add",
) {
    if (quickAdd == null || !quickAdd.shown || !quickAdd.drawn) return
    val focus = remember { FocusRequester() }
    // `onFocusChanged` reports once on attach, unfocused: only a field that
    // HAD the keyboard and lost it tells the machine.
    val held = remember { mutableStateOf(false) }
    val prompt = quickAdd.lands_label.ifEmpty { placeholder }
    // A LATE ECHO NEVER OVERWRITES WHAT IS TYPED NOW: the machine's title is
    // adopted only when it is not an echo of this field's typing (a clear after
    // Add, words handed in by Notes' "Send to Agenda"). Following every echo
    // moved letters under a slow round trip ("Walk task" became "Wak task … l").
    val editor = rememberFollowedText(quickAdd.title)
    val typed = editor.text.value
    val submit = { onSubmit() }
    // THE PLUS OPENED IT, or Notes' "Send to Agenda" did with words in it: the
    // field takes the keyboard.
    LaunchedEffect(quickAdd.focused) { if (quickAdd.focused) runCatching { focus.requestFocus() } }
    val shape = RoundedCornerShape(KitGeometry.RADIUS)
    Column(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = KitGeometry.ROW_MIN)
                .clip(shape)
                .border(KitGeometry.HAIRLINE, centraidColor("line"), shape)
                .padding(start = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CentraidIcon("Plus", tint = centraidColor("textFaint"), size = 16.dp, modifier = Modifier.clearAndSetSemantics { })
            Box(Modifier.weight(1f).padding(horizontal = 8.dp)) {
                if (typed.isEmpty()) {
                    Text(prompt, style = centraidType("body"), color = centraidColor("textFaint"), modifier = Modifier.clearAndSetSemantics { })
                }
                BasicTextField(
                    value = typed,
                    onValueChange = { if (editor.edited(it)) onChange(it) },
                    singleLine = true,
                    textStyle = centraidType("body").copy(color = centraidColor("text")),
                    cursorBrush = SolidColor(centraidColor("text")),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { if (quickAdd.can_submit) submit() }),
                    modifier = Modifier
                        .fillMaxWidth()
                        .focusRequester(focus)
                        .onFocusChanged {
                            if (it.isFocused) {
                                held.value = true
                            } else if (held.value) {
                                held.value = false
                                onBlur()
                            }
                        }
                        .testTag(testTag)
                        .clearAndSetSemantics { contentDescription = prompt },
                )
            }
            if (quickAdd.can_submit) {
                OutlineButton(verb, testTag = "$testTag-verb", modifier = Modifier.padding(end = 4.dp), onPress = submit)
            }
        }
    }
}

/** A choice row: enabled rows pick, disabled rows are drawn dimmed and say so. */
@Composable
internal fun TodoChoiceRow(choice: TodoChoice, onPick: (String) -> Unit) {
    if (choice.enabled) {
        SheetRow(
            label = choice.label,
            onTap = { onPick(choice.key) },
            iconKey = choice.icon_key.ifEmpty { null },
            detail = choice.meta,
            selected = choice.selected,
            testTag = "tasks-choice-${choice.key}",
            modifier = if (choice.indented) Modifier.padding(start = 24.dp) else Modifier,
        )
    } else {
        CentraidRow(
            title = choice.label,
            meta = choice.meta,
            dimmed = true,
            testTag = "tasks-choice-${choice.key}",
            modifier = if (choice.indented) Modifier.padding(start = 24.dp) else Modifier,
        )
    }
}
