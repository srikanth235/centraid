package dev.centraid.android.screens.agenda

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import dev.centraid.design.CentraidScale
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.colorResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import centraid.core.v1.AgendaCalendarView
import centraid.core.v1.AgendaDestination
import centraid.core.v1.AgendaMonthStyle
import centraid.core.v1.AgendaMonthStyleChoice
import centraid.core.v1.AgendaSmartList
import centraid.core.v1.Route
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.appAccent
import dev.centraid.android.kit.kitTextStyle
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

// THE REDESIGN'S COLOURS FOR AGENDA (#1173), looked up by the key Rust sends:
// a list's colour is one of the eight `[list]` names (`raspberry`), a smart-list
// card's a token name (`listBlue`, `stateAmber`, `textInk`). Both resolve to the
// generated `res/values{,-night}/colors.xml` entries (`centraid_list_raspberry`),
// so there is no hex here and dark follows the system.

private fun snake(camel: String): String =
    camel.fold(StringBuilder()) { out, c -> if (c.isUpperCase()) out.append('_').append(c.lowercaseChar()) else out.append(c) }.toString()

/** The colour of a token name (`listBlue` -> `centraid_list_blue`); null if the resource is absent. */
@Composable
internal fun agendaTokenColor(key: String): Color? {
    if (key.isEmpty()) return null
    val context = LocalContext.current
    val id = remember(key) { context.resources.getIdentifier("centraid_" + snake(key), "color", context.packageName) }
    return if (id == 0) null else colorResource(id)
}

/** The colour of a list key (`raspberry`); null for an empty key. */
@Composable
internal fun agendaListColor(key: String): Color? = if (key.isEmpty()) null else agendaTokenColor("list" + key.replaceFirstChar { it.uppercase() })

/** The Reminders home's smart-list cards: two columns of rounded cards, glyph, count and label. */
@Composable
internal fun AgendaSmartLists(lists: List<AgendaSmartList>, onOpen: (Route) -> Unit) {
    Column(
        Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        lists.chunked(2).forEach { pair ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                pair.forEach { list ->
                    val shape = RoundedCornerShape(CentraidScale.cardRadius.dp)
                    Column(
                        Modifier
                            .weight(1f)
                            .heightIn(min = 92.dp)
                            .clip(shape)
                            .background(agendaTokenColor(list.color_key) ?: centraidColor("text"))
                            .clickable { list.route?.let(onOpen) }
                            .padding(14.dp)
                            .testTag("agenda-smart-${list.key}")
                            .clearAndSetSemantics { contentDescription = list.accessibility_label },
                        verticalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            CentraidIcon(list.icon_key, tint = Color.White, size = 26.dp)
                            if (list.count.isNotEmpty()) {
                                Text(list.count, style = centraidType("title"), color = Color.White)
                            }
                        }
                        Text(list.label, style = centraidType("bodyStrong"), color = Color.White)
                    }
                }
                if (pair.size == 1) Box(Modifier.weight(1f))
            }
        }
    }
}

/**
 * The Calendar tab's view menu: the current view and a chevron; a tap lists Day, Week, Month, List
 * and Year, with the current one checked. On Month a second group holds its styles (Grid, List).
 * Material 3 Expressive: a tonal card surface and the card radius.
 */
@Composable
internal fun AgendaViewMenu(
    views: List<AgendaCalendarView>,
    label: String,
    monthStyles: List<AgendaMonthStyleChoice>,
    onPick: (AgendaDestination) -> Unit,
    onStyle: (AgendaMonthStyle) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    Box {
        Row(
            Modifier
                .heightIn(min = KitGeometry.ROW_MIN)
                .clickable { open = true }
                .testTag("agenda-view-menu")
                .clearAndSetSemantics { contentDescription = label },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(views.firstOrNull { it.current }?.label ?: label, style = centraidType("smallStrong"), color = centraidColor("text"))
            CentraidIcon("ChevronDown", tint = centraidColor("textSoft"), size = 14.dp, modifier = Modifier.padding(start = 4.dp))
        }
        DropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            containerColor = Surface.card,
            shape = RoundedCornerShape(CentraidScale.cardRadius.dp),
        ) {
            views.forEach { view ->
                DropdownMenuItem(
                    text = { Text(view.label, style = kitTextStyle(KitType.Row), color = Surface.ink) },
                    leadingIcon = if (view.icon_key.isNotEmpty()) {
                        { CentraidIcon(view.icon_key, tint = Surface.body, size = 18.dp) }
                    } else {
                        null
                    },
                    trailingIcon = if (view.current) {
                        { CentraidIcon("Check", tint = appAccent("agenda").text, size = 18.dp) }
                    } else {
                        null
                    },
                    onClick = {
                        open = false
                        onPick(view.destination)
                    },
                    modifier = Modifier.testTag("agenda-view-${view.key}"),
                )
            }
            // MONTH'S SECOND GROUP: how it draws, Grid or List.
            if (monthStyles.isNotEmpty()) {
                Box(Modifier.fillMaxWidth().padding(vertical = 4.dp).height(KitGeometry.HAIRLINE).background(Surface.line))
                monthStyles.forEach { choice ->
                    DropdownMenuItem(
                        text = { Text(choice.label, style = kitTextStyle(KitType.Row), color = Surface.ink) },
                        trailingIcon = if (choice.current) {
                            { CentraidIcon("Check", tint = appAccent("agenda").text, size = 18.dp) }
                        } else {
                            null
                        },
                        onClick = {
                            open = false
                            onStyle(choice.style)
                        },
                        modifier = Modifier.testTag(
                            if (choice.style == AgendaMonthStyle.AGENDA_MONTH_STYLE_LIST) "agenda-month-style-list" else "agenda-month-style-grid",
                        ),
                    )
                }
            }
        }
    }
}
