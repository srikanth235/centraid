package dev.centraid.android.screens.agenda

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
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
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import centraid.core.v1.Route
import centraid.core.v1.TodoCheck
import centraid.core.v1.TodoChrome
import centraid.core.v1.TodoChoice
import centraid.core.v1.QuickAddChip
import centraid.core.v1.TodoQuickAdd
import centraid.core.v1.TodoRow
import centraid.core.v1.TodoRowGroup
import dev.centraid.android.kit.rememberLargestText
import dev.centraid.android.kit.SectionHead
import dev.centraid.design.CentraidTokens
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.BandPolicy
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitRowAction
import dev.centraid.android.kit.KitSwipeRow
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.OutlineButton
import dev.centraid.android.kit.SectionHeader
import dev.centraid.android.kit.SheetRow
import dev.centraid.android.kit.appAccent
import dev.centraid.android.kit.hueColor
import dev.centraid.android.kit.rememberFollowedText
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidDark
import dev.centraid.android.theme.centraidType

/**
 * THE TO-DO ROW, ONE SHAPE: the box, the title over its due word and meta line,
 * the priority word and the project dot. With a `menu` the row swipes (Details, Flag, Delete; the long
 * press is the same three). Without one, an open root offers "Move to project"
 * on a long press (and to a screen reader as an action in both), never as a verb on
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
    menu: TodoRowMenu? = null,
    /** False where the long press lifts the row to reorder it, not to open the menu. */
    menuOnLongPress: Boolean = true,
    modifier: Modifier = Modifier,
) {
    // THE SWIPE (#1173): Details, Flag and Delete sit behind the row, and the kit's long press opens
    // them plus the menu-only Move up, Move down and Move to project; a row with no `menu` (a subtask, a completed row) is the plain row.
    val file = if (row.can_file && onFile != null && fileVerb.isNotEmpty()) ({ onFile(row.task_id) }) else null
    val actions = menu?.actions(row, onOpen, file, fileVerb).orEmpty()
    val swipes = actions.isNotEmpty()
    val body: @Composable () -> Unit = {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = KitGeometry.ROW_MIN)
                .padding(start = KitGeometry.GUTTER / 2 + indent + (depth * 24).dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.width(2.dp).height(28.dp))
            TodoCheckBox(row.check, row.check_label, tag = "$idPrefix-check-${row.task_id}", round = !row.subtask) { onCheck(row.task_id) }
            Column(
                Modifier
                    .weight(1f)
                    .then(
                        // THE SWIPE ROW OWNS THE TAP AND THE LONG PRESS; a plain row's long press files.
                        if (swipes) {
                            Modifier
                        } else {
                            Modifier.combinedClickable(
                                onClick = { row.route?.let(onOpen) },
                                onLongClick = file,
                                onLongClickLabel = fileVerb.ifEmpty { null },
                            )
                        },
                    )
                    .padding(vertical = 8.dp)
                    .testTag("$idPrefix-${row.task_id}")
                    .clearAndSetSemantics {
                        contentDescription = row.accessibility_label.ifEmpty { row.title }
                        role = Role.Button
                        val spoken = buildList {
                            if (file != null) add(CustomAccessibilityAction(fileVerb) { file(); true })
                            if (menu != null) addAll(menu.accessibilityActions(row, onOpen))
                        }
                        if (spoken.isNotEmpty()) customActions = spoken
                    },
            ) {
                Text(
                    row.title,
                    style = centraidType(if (row.subtask) "small" else "body"),
                    color = centraidColor(if (row.check == TodoCheck.TODO_CHECK_OPEN) "text" else "textFaint"),
                    maxLines = if (rememberLargestText()) Int.MAX_VALUE else 2,
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
                                maxLines = if (rememberLargestText()) Int.MAX_VALUE else 1,
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
            if (row.flagged) {
                CentraidIcon(
                    "Flag",
                    tint = agendaTokenColor("stateAmberText") ?: centraidColor("warning"),
                    size = 14.dp,
                    modifier = Modifier.padding(start = 6.dp).clearAndSetSemantics { },
                )
            }
            // THE LIST'S COLOUR (#1173): one of the eight, a dot after the title.
            val listColor = agendaListColor(row.list_color_key)
            if (listColor != null) {
                Box(Modifier.padding(start = 8.dp).size(6.dp).clip(CircleShape).background(listColor))
            } else if (row.project_hue_key.isNotEmpty()) {
                Box(
                    Modifier
                        .padding(start = 8.dp)
                        .size(6.dp)
                        .clip(CircleShape)
                        .background(hueColor(row.project_hue_key)),
                )
            }
        }
    }
    Box(modifier) {
        if (swipes) KitSwipeRow(actions = actions, onTap = { row.route?.let(onOpen) }, menuOnLongPress = menuOnLongPress, content = body) else body()
    }
    row.children.forEach { child ->
        TodoRowView(child, onCheck, onOpen, onFile = null, depth = depth + 1, idPrefix = idPrefix, indent = indent)
    }
}

/**
 * WHAT A ROW OFFERS (#1173): the swipe's Details, Flag/Unflag and Delete ([actions], the kit's
 * `KitSwipeRow`, which is the long press too), and for a screen reader also Move up and down (the
 * non-drag reorder, only where a move is wired). The words are the chrome's.
 */
internal class TodoRowMenu(
    val chrome: TodoChrome,
    val onFlag: ((String, Boolean) -> Unit)? = null,
    val onDelete: ((String) -> Unit)? = null,
    /** (moved id, the id it lands before; empty is the end), or null where rows do not reorder. */
    val onMove: ((String, String) -> Unit)? = null,
    /** The ids of the row's group in order, for Move up and down. */
    val siblings: List<String> = emptyList(),
) {
    fun actions(row: TodoRow, onOpen: (Route) -> Unit, file: (() -> Unit)? = null, fileVerb: String = ""): List<KitRowAction> = buildList {
        add(KitRowAction("details", chrome.details_verb.ifEmpty { KitWords.DETAILS }) { row.route?.let(onOpen) })
        onFlag?.let { flag ->
            val verb = if (row.flagged) chrome.unflag_verb.ifEmpty { KitWords.UNFLAG } else chrome.flag_verb.ifEmpty { KitWords.FLAG }
            add(KitRowAction("flag", verb, KitRowAction.Tone.Amber) { flag(row.task_id, !row.flagged) })
        }
        val at = siblings.indexOf(row.task_id)
        if (onMove != null && at > 0) {
            add(KitRowAction("move-up", chrome.move_up_verb, menuOnly = true) { onMove.invoke(row.task_id, siblings[at - 1]) })
        }
        if (onMove != null && at >= 0 && at < siblings.size - 1) {
            add(KitRowAction("move-down", chrome.move_down_verb, menuOnly = true) { onMove.invoke(row.task_id, siblings.getOrElse(at + 2) { "" }) })
        }
        if (file != null) add(KitRowAction("file", fileVerb, menuOnly = true) { file() })
        onDelete?.let { delete ->
            add(KitRowAction("delete", chrome.delete_verb.ifEmpty { KitWords.DELETE }, KitRowAction.Tone.Red) { delete(row.task_id) })
        }
    }

    fun accessibilityActions(row: TodoRow, onOpen: (Route) -> Unit): List<CustomAccessibilityAction> = buildList {
        actions(row, onOpen).filterNot { it.menuOnly }.forEach { action -> add(CustomAccessibilityAction(action.label) { action.onPress(); true }) }
        val at = siblings.indexOf(row.task_id)
        if (onMove != null && at > 0) {
            add(CustomAccessibilityAction(chrome.move_up_verb) { onMove.invoke(row.task_id, siblings[at - 1]); true })
        }
        if (onMove != null && at >= 0 && at < siblings.size - 1) {
            add(CustomAccessibilityAction(chrome.move_down_verb) { onMove.invoke(row.task_id, siblings.getOrElse(at + 2) { "" }); true })
        }
    }
}

/**
 * THE BOX: open is a ring, done a check, released a dash. A TASK IS A CIRCLE,
 * a subtask a box (`round = false`, the `sm` radius token): the shape every
 * task list teaches, drawn from `TodoRow.subtask` as iOS's `KitCheckBox` does.
 */
@Composable
internal fun TodoCheckBox(check: TodoCheck, label: String, tag: String = "tasks-check", round: Boolean = true, onTap: () -> Unit) {
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
        val shape = if (round) CircleShape else RoundedCornerShape((CentraidTokens.light.radii["sm"] ?: 0).dp)
        Box(
            Modifier
                .size(20.dp)
                .clip(shape)
                .border(KitGeometry.HAIRLINE, centraidColor("textSoft"), shape)
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
    menu: TodoRowMenu? = null,
    /** Where rows reorder by dragging (the project page); the menu's Move up and down stay for a screen reader. */
    reorder: TodoReorderState? = null,
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
        val ids = group.rows.map { r -> r.task_id }
        val rowKey = { id: String -> "row-${group.key}-$id" }
        group.rows.forEach { row ->
            item(key = rowKey(row.task_id)) {
                val drag = reorder?.takeIf { menu?.onMove != null && !row.subtask }
                TodoRowView(
                    row, onCheck, onOpen, onFile, fileVerb, idPrefix = idPrefix,
                    menu = menu?.let { TodoRowMenu(it.chrome, it.onFlag, it.onDelete, it.onMove, ids) },
                    menuOnLongPress = drag == null,
                    modifier = if (drag != null) Modifier.todoReorderable(drag, rowKey(row.task_id), row.task_id, ids, rowKey) else Modifier,
                )
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
    onDismissChip: () -> Unit = {},
    testTag: String = "tasks-quick-add",
    onTool: (String) -> Unit = {},
    onDue: (String) -> Unit = {},
    onTag: (String) -> Unit = {},
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
    // THE BAR RIDES ABOVE THE KEYBOARD (`imePadding`), and its toolbar is drawn only while focus is
    // anywhere in it: the tag field takes focus from the title, and that is still "the keyboard is here".
    Column(
        Modifier
            .imePadding()
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp)
            .onFocusChanged {
                if (it.hasFocus) {
                    held.value = true
                } else if (held.value) {
                    held.value = false
                    onBlur()
                }
            },
    ) {
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
                        .testTag(testTag)
                        .clearAndSetSemantics { contentDescription = prompt },
                )
            }
            if (quickAdd.can_submit) {
                OutlineButton(verb, testTag = "$testTag-verb", modifier = Modifier.padding(end = 4.dp), onPress = submit)
            }
        }
        quickAdd.chip?.let { QuickAddChipView(it, onDismissChip, "$testTag-chip") }
        // WHAT THE NEXT ADD CARRIES ("Tomorrow · #errand · Flagged"), under the field.
        if (quickAdd.staged_label.isNotEmpty()) {
            Text(
                quickAdd.staged_label,
                style = centraidType("annotLabel"),
                color = centraidColor("textSoft"),
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp).testTag("agenda-quick-staged"),
            )
        }
        // THE KEYBOARD TOOLBAR, while the field (or its tag field) has the keyboard.
        if (held.value) {
            QuickAddToolbar(quickAdd, onTool = onTool, onDue = onDue, onTag = onTag, modifier = Modifier.padding(top = 6.dp))
        }
    }
}

/**
 * THE DATE CHIP (#1173 Wave 3): what the typed words will save as, under the field before Add.
 * A pill in Agenda's tint says the day and time (or the repeat); the title that is left sits
 * beside it. The × keeps the words as typed. Every word is Rust's: the pill reads as one phrase
 * to a screen reader ([QuickAddChip.spoken]) and the × is its own button.
 */
@Composable
private fun QuickAddChipView(chip: QuickAddChip, onDismiss: () -> Unit, testTag: String) {
    val accent = appAccent("agenda")
    val shape = RoundedCornerShape(BandPolicy.BAND_RADIUS.dp)
    Column(
        Modifier.fillMaxWidth().padding(top = 8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            Modifier
                .heightIn(min = 32.dp)
                .clip(shape)
                .background(accent.wash(centraidDark()), shape)
                .padding(start = 10.dp)
                .testTag(testTag)
                .semantics { contentDescription = chip.spoken },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            CentraidIcon(if (chip.repeats) "Repeat" else "Calendar", tint = accent.text, size = 14.dp, modifier = Modifier.clearAndSetSemantics { })
            Text(
                chip.label,
                style = centraidType("smallStrong"),
                color = accent.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.clearAndSetSemantics { },
            )
            Box(
                Modifier
                    .size(KitGeometry.ROW_MIN)
                    .clip(CircleShape)
                    .clickable(onClick = onDismiss)
                    .testTag("$testTag-dismiss")
                    .semantics { contentDescription = chip.dismiss_label; role = Role.Button },
                contentAlignment = Alignment.Center,
            ) { CentraidIcon("X", tint = accent.text, size = 14.dp) }
        }
        // THE BOARD'S FOOTNOTE: what the words will save as, under the pill.
        Text(
            chip.saves_as,
            style = centraidType("small"),
            color = centraidColor("textSoft"),
            modifier = Modifier.clearAndSetSemantics { },
        )
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
