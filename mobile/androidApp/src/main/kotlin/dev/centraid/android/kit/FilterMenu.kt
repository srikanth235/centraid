package dev.centraid.android.kit

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import centraid.core.v1.FilterMenu
import centraid.core.v1.HeaderSubtitle
import centraid.core.v1.MenuOption
import centraid.core.v1.MenuSection
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/*
 * THE ONE FILTER AND SORT MENU (DESIGN.md, `AppPlace`), the Compose twin of iOS's `FilterMenu.swift`.
 *
 * The header's filter button opens a Material 3 `DropdownMenu` that Rust finished (`FilterMenu`):
 * its sections, options, counts, checks and words. This file is the only drawing of it, so every
 * app's menu is the same control, and it keeps no state beyond whether the menu is open and which
 * nested section is showing: a pick goes back as `FilterMenuPicked`, the clear row as
 * `FilterMenuCleared`, and the next state says what is checked.
 */

/** A FILTER MENU AS AN `AppPlace` CARRIES IT: Rust's menu and the two events it answers with. */
public class RoomFilter(
    public val menu: FilterMenu,
    public val onPick: (section: String, option: String) -> Unit,
    public val onClear: () -> Unit,
)

/**
 * THE HEADER'S SECOND LINE, as an `AppPlace` carries it: the scope the page is in. The words (and
 * the close key, when `clearable`) are Rust's `HeaderSubtitle`; [onTap] is the app's own event for
 * a tap on the words (Money's month sheet) and [onClear] the app's clear (Notes' notebook).
 */
public class RoomSubtitle(
    public val subtitle: HeaderSubtitle,
    public val onTap: () -> Unit = {},
    public val onClear: () -> Unit = {},
)

/**
 * THE FILTER BUTTON AND ITS MENU.
 *
 * LIT, NOT BADGED: while Rust says `filtering` the funnel is drawn solid (the same ink, filled in),
 * never an accent, a dot or a count. A single section checks one option and closes the menu; a
 * multi section toggles and leaves it open (a member choosing three tags is not done after one).
 * Material 3 has no nested dropdown, so a `nested` section swaps the menu's content for its own
 * options under a back row: two levels deep, never more.
 */
@Composable
public fun FilterMenuButton(app: String, filter: RoomFilter) {
    val menu = filter.menu
    var open by remember { mutableStateOf(false) }
    var inside by remember { mutableStateOf<String?>(null) }
    val close = {
        open = false
        inside = null
    }
    Box {
        Box(
            Modifier
                .size(KitGeometry.ROW_MIN)
                .clip(RoundedCornerShape(KitGeometry.RADIUS))
                .clickable { open = true }
                .testTag("$app-filter-menu")
                .clearAndSetSemantics {
                    contentDescription = menu.spoken
                    role = Role.Button
                },
            contentAlignment = Alignment.Center,
        ) {
            CentraidIcon(
                iconKey = "Filter",
                tint = centraidColor("text"),
                size = 20.dp,
                solid = menu.filtering,
            )
        }
        DropdownMenu(expanded = open, onDismissRequest = close) {
            val section = menu.sections.firstOrNull { it.key == inside }
            if (section != null) {
                DropdownMenuItem(
                    text = { Text(section.title, style = centraidType("control")) },
                    leadingIcon = { CentraidIcon("ChevronLeft", centraidColor("textSoft"), size = 18.dp) },
                    onClick = { inside = null },
                    modifier = Modifier.testTag("$app-filter-${section.key}-back"),
                )
                Rule()
                section.options.forEach { option -> OptionItem(app, filter, section, option, close) }
            } else {
                if (menu.filtering) {
                    DropdownMenuItem(
                        text = { Text(menu.clear_label) },
                        onClick = {
                            close()
                            filter.onClear()
                        },
                        modifier = Modifier.testTag("$app-filter-clear"),
                    )
                    Rule()
                }
                menu.sections.forEachIndexed { at, each ->
                    if (each.nested) {
                        DropdownMenuItem(
                            text = {
                                Text(
                                    if (each.summary.isEmpty()) each.title else "${each.title} · ${each.summary}",
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            },
                            trailingIcon = { CentraidIcon("ChevronRight", centraidColor("textSoft"), size = 18.dp) },
                            onClick = { inside = each.key },
                            modifier = Modifier.testTag("$app-filter-${each.key}"),
                        )
                    } else {
                        if (at > 0) Rule()
                        Text(
                            each.title,
                            style = centraidType("annotLabel"),
                            color = centraidColor("textFaint"),
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                        )
                        each.options.forEach { option -> OptionItem(app, filter, each, option, close) }
                    }
                }
            }
        }
    }
}

@Composable
private fun OptionItem(
    app: String,
    filter: RoomFilter,
    section: MenuSection,
    option: MenuOption,
    close: () -> Unit,
) {
    val words = if (option.count > 0) "${option.label} · ${option.count}" else option.label
    DropdownMenuItem(
        text = { Text(words, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        // THE CHECK stands in a slot of its own, so the words do not move when it comes and goes.
        leadingIcon = {
            if (option.selected) {
                CentraidIcon("Check", centraidColor("text"), size = 18.dp)
            } else {
                Spacer(Modifier.size(18.dp))
            }
        },
        onClick = {
            if (section.kind != MenuSection.Kind.KIND_MULTI) close()
            filter.onPick(section.key, option.key)
        },
        modifier = Modifier
            .testTag("$app-filter-${section.key}-${option.key}")
            .semantics { selected = option.selected },
    )
}

@Composable
private fun Rule() {
    Spacer(
        Modifier
            .fillMaxWidth()
            .height(KitGeometry.HAIRLINE)
            .background(centraidColor("line")),
    )
}

/**
 * THE HEADER'S TITLE WITH A SECOND LINE: the scope under the app's name, which may open something
 * ([HeaderSubtitle.tappable]) and may carry a close key ([HeaderSubtitle.clearable]).
 */
@Composable
internal fun RoomSubtitleLine(slot: RoomSubtitle) {
    val subtitle = slot.subtitle
    Row(verticalAlignment = Alignment.CenterVertically) {
        val words: @Composable () -> Unit = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    subtitle.label,
                    style = centraidType("small"),
                    color = centraidColor("textSoft"),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (subtitle.tappable) {
                    CentraidIcon("ChevronDown", centraidColor("textSoft"), size = 14.dp)
                }
            }
        }
        if (subtitle.tappable) {
            Box(
                Modifier
                    .clip(RoundedCornerShape(KitGeometry.RADIUS))
                    .clickable(onClick = slot.onTap)
                    .testTag("room-subtitle")
                    .clearAndSetSemantics {
                        contentDescription = subtitle.spoken
                        role = Role.Button
                    },
            ) { words() }
        } else {
            Box(
                Modifier
                    .testTag("room-subtitle")
                    .clearAndSetSemantics { contentDescription = subtitle.spoken },
            ) { words() }
        }
        if (subtitle.clearable) {
            Box(
                Modifier
                    .size(KitGeometry.ROW_MIN)
                    .clip(RoundedCornerShape(KitGeometry.RADIUS))
                    .clickable(onClick = slot.onClear)
                    .testTag("room-subtitle-clear")
                    .clearAndSetSemantics {
                        contentDescription = subtitle.clear_spoken
                        role = Role.Button
                    },
                contentAlignment = Alignment.Center,
            ) {
                CentraidIcon("X", centraidColor("textSoft"), size = 14.dp)
            }
        }
    }
}
