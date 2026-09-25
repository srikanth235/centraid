package dev.centraid.android.screens.tasks

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import centraid.screen.v1.SectionHead
import centraid.screen.v1.TasksCheck
import centraid.screen.v1.TasksChoice
import centraid.screen.v1.TasksQuickAdd
import centraid.screen.v1.TasksRow
import centraid.screen.v1.TasksRowGroup
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.IconKey
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.QuietButton
import dev.centraid.android.kit.SectionHeader
import dev.centraid.android.kit.SheetOption
import dev.centraid.android.kit.SheetRow
import dev.centraid.android.kit.hueColor
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.copy.TasksCopy

/**
 * TASKS' ONE ROW SHAPE: the box, the title over its due word and meta line,
 * the priority word, the project dot and (open roots) File. Every word is the
 * row's own; the view only lays them out. A pending write is the 2px rule.
 */
@Composable
internal fun TaskRowView(
    row: TasksRow,
    onCheck: (String) -> Unit,
    onPick: (String) -> Unit,
    onFile: ((String) -> Unit)? = null,
    fileVerb: String = "",
    depth: Int = 0,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = KitGeometry.ROW_MIN)
            .padding(start = KitGeometry.GUTTER / 2 + (depth * 24).dp, end = 4.dp)
            .testTag("tasks-row-${row.task_id}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .width(2.dp)
                .height(28.dp)
                .background(if (row.pending) centraidColor("seam") else centraidColor("bg")),
        )
        TaskCheckBox(row.check, row.check_label, enabled = row.can_check) { onCheck(row.task_id) }
        Column(
            Modifier
                .weight(1f)
                .clickable { onPick(row.task_id) }
                .padding(vertical = 8.dp)
                .clearAndSetSemantics {
                    contentDescription = row.accessibility_label.ifEmpty { row.title }
                    role = Role.Button
                },
        ) {
            Text(
                row.title,
                style = centraidType("body"),
                color = centraidColor(if (row.check == TasksCheck.TASKS_CHECK_OPEN) "text" else "textFaint"),
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
        if (row.can_file && onFile != null) {
            // THE VISIBLE VERB (`TasksChrome.file_verb`); the catalog's folder
            // key only while the state has no word for it.
            if (fileVerb.isNotEmpty()) {
                QuietButton(fileVerb, testTag = "tasks-file-${row.task_id}", modifier = Modifier.padding(start = 6.dp)) {
                    onFile(row.task_id)
                }
            } else {
                IconKey("Folder", "${TasksCopy.FILE} ${row.title}", "tasks-file-${row.task_id}", bordered = false) {
                    onFile(row.task_id)
                }
            }
        }
    }
    row.children.forEach { child ->
        TaskRowView(child, onCheck, onPick, onFile = null, depth = depth + 1)
    }
}

/** THE BOX: open is a ring, done a check, released a dash. */
@Composable
internal fun TaskCheckBox(check: TasksCheck, label: String, enabled: Boolean, onTap: () -> Unit) {
    Box(
        Modifier
            .size(KitGeometry.ROW_MIN)
            .then(if (enabled) Modifier.clickable(onClick = onTap) else Modifier)
            .testTag("tasks-check")
            .clearAndSetSemantics {
                contentDescription = label
                role = Role.Checkbox
            },
        contentAlignment = Alignment.Center,
    ) {
        val done = check == TasksCheck.TASKS_CHECK_DONE
        Box(
            Modifier
                .size(20.dp)
                .clip(CircleShape)
                .border(KitGeometry.HAIRLINE, centraidColor(if (enabled) "textSoft" else "textFaint"), CircleShape)
                .background(if (done) centraidColor("text") else centraidColor("bg")),
            contentAlignment = Alignment.Center,
        ) {
            when (check) {
                TasksCheck.TASKS_CHECK_DONE -> CentraidIcon("Check", tint = centraidColor("bg"), size = 12.dp)
                TasksCheck.TASKS_CHECK_WONT_DO -> Box(Modifier.width(8.dp).height(1.5.dp).background(centraidColor("textSoft")))
                TasksCheck.TASKS_CHECK_IN_PROCESS -> Box(Modifier.size(8.dp).clip(CircleShape).background(centraidColor("textSoft")))
                else -> Unit
            }
        }
    }
}

/** The groups of a list: month heading, section head with its one verb, the rows. */
internal fun LazyListScope.taskGroups(
    groups: List<TasksRowGroup>,
    onCheck: (String) -> Unit,
    onPick: (String) -> Unit,
    onVerb: (String) -> Unit,
    onFile: ((String) -> Unit)? = null,
    fileVerb: String = "",
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
                TaskRowView(row, onCheck, onPick, onFile, fileVerb)
            }
        }
    }
}

/** THE QUICK-ADD BAR: a bare title, where it lands, and Add. */
@Composable
internal fun TasksQuickAddBar(
    quickAdd: TasksQuickAdd?,
    placeholder: String,
    verb: String,
    onChange: (String) -> Unit,
    onSubmit: () -> Unit,
) {
    if (quickAdd == null || !quickAdd.shown) return
    var typed by remember { mutableStateOf(quickAdd.title) }
    LaunchedEffect(quickAdd.title) { if (quickAdd.title != typed) typed = quickAdd.title }
    // OPENED WITH WORDS IN IT (Notes' "Send to Tasks"): the field takes the keyboard.
    val focus = remember { FocusRequester() }
    LaunchedEffect(quickAdd.focused) { if (quickAdd.focused) focus.requestFocus() }
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
                    Text(placeholder, style = centraidType("body"), color = centraidColor("textFaint"), modifier = Modifier.clearAndSetSemantics { })
                }
                BasicTextField(
                    value = typed,
                    onValueChange = {
                        typed = it
                        if (it != quickAdd.title) onChange(it)
                    },
                    singleLine = true,
                    textStyle = centraidType("body").copy(color = centraidColor("text")),
                    cursorBrush = SolidColor(centraidColor("text")),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { if (quickAdd.can_submit) onSubmit() }),
                    modifier = Modifier
                        .fillMaxWidth()
                        .focusRequester(focus)
                        .testTag("tasks-quick-add")
                        .clearAndSetSemantics { contentDescription = placeholder },
                )
            }
            if (quickAdd.can_submit) {
                QuietButton(verb, testTag = "tasks-quick-add-verb", modifier = Modifier.padding(end = 4.dp), onPress = onSubmit)
            }
        }
        if (quickAdd.lands_label.isNotEmpty()) {
            Text(quickAdd.lands_label, style = centraidType("annotLabel"), color = centraidColor("textFaint"), modifier = Modifier.padding(top = 2.dp))
        }
    }
}

/** A choice row: enabled rows pick, disabled rows are drawn dimmed and say so. */
@Composable
internal fun TasksChoiceRow(choice: TasksChoice, onPick: (String) -> Unit) {
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

internal fun TasksChoice.option(): SheetOption =
    SheetOption(key = key, label = label, iconKey = icon_key.ifEmpty { null }, detail = meta, selected = selected)
