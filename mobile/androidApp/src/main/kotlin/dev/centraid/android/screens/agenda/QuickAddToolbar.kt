package dev.centraid.android.screens.agenda

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import centraid.core.v1.TodoQuickAdd
import centraid.core.v1.TodoQuickTool
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.KitChip
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.Surface
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * THE KEYBOARD TOOLBAR (#1173) over To-do's quick add: a floating tonal bar of the machine's tools
 * (Date, Tag, Flag), each staging what the next add carries. The state says which is lit (`on`),
 * which one is open (`open_tool`) and every word; a tool sends [onTool], a due choice [onDue], a
 * typed tag [onTag] (the keyboard's Done), and nothing here decides what any of them does. The
 * caller draws it only while the quick-add field holds the keyboard, above the IME.
 */
@Composable
internal fun QuickAddToolbar(
    quickAdd: TodoQuickAdd,
    onTool: (String) -> Unit,
    onDue: (String) -> Unit,
    onTag: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (quickAdd.tools.isEmpty()) return
    val shape = RoundedCornerShape(KitGeometry.RADIUS)
    Column(
        modifier
            .fillMaxWidth()
            .clip(shape)
            .background(Surface.card)
            .border(KitGeometry.HAIRLINE, Surface.border, shape)
            .testTag("agenda-quick-toolbar"),
    ) {
        when (quickAdd.open_tool) {
            "date" -> Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                quickAdd.due_choices.forEach { choice ->
                    KitChip(
                        label = choice.label,
                        selected = choice.selected,
                        enabled = choice.enabled,
                        onClick = { onDue(choice.key) },
                        modifier = Modifier.testTag("agenda-quick-due-${choice.key}"),
                    )
                }
            }
            "tag" -> QuickTagField(quickAdd.tag_placeholder, onTag)
        }
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            quickAdd.tools.forEach { tool ->
                QuickToolKey(tool, lit = tool.key == quickAdd.open_tool, onPress = { onTool(tool.key) })
            }
        }
    }
}

/** One key: the catalogue mark by `icon_key`, filled while something is staged; the label is its whole description. */
@Composable
private fun QuickToolKey(tool: TodoQuickTool, lit: Boolean, onPress: () -> Unit) {
    val ink = if (tool.on) centraidColor("bg") else Surface.ink
    Box(
        Modifier
            .size(KitGeometry.ROW_MIN)
            .clip(CircleShape)
            .clickable(onClick = onPress)
            .testTag("agenda-quick-tool-${tool.key}")
            .clearAndSetSemantics {
                contentDescription = tool.label
                role = Role.Button
                selected = tool.on || lit
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .size(36.dp)
                .clip(CircleShape)
                .background(if (tool.on) centraidColor("text") else if (lit) Surface.fill else Surface.card),
            contentAlignment = Alignment.Center,
        ) {
            CentraidIcon(iconKey = tool.icon_key, tint = ink, size = 18.dp, solid = tool.on)
        }
    }
}

/** The tag field: typed here, sent on the keyboard's Done, then cleared; the keyboard stays for the next. */
@Composable
private fun QuickTagField(placeholder: String, onTag: (String) -> Unit) {
    var text by remember { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    Box(
        Modifier.fillMaxWidth().heightIn(min = KitGeometry.ROW_MIN).padding(horizontal = 12.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        if (text.isEmpty()) {
            Text(placeholder, style = centraidType("body"), color = centraidColor("textFaint"), modifier = Modifier.clearAndSetSemantics { })
        }
        BasicTextField(
            value = text,
            onValueChange = { text = it },
            singleLine = true,
            textStyle = centraidType("body").copy(color = centraidColor("text")),
            cursorBrush = SolidColor(centraidColor("text")),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = {
                if (text.isNotBlank()) onTag(text.trim())
                text = ""
            }),
            modifier = Modifier
                .fillMaxWidth()
                .focusRequester(focus)
                .testTag("agenda-quick-tag-field")
                .semantics { contentDescription = placeholder },
        )
    }
}
