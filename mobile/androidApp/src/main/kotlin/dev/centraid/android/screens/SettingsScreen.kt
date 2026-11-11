package dev.centraid.android.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import centraid.core.v1.Route
import centraid.core.v1.SettingsChoice
import centraid.core.v1.SettingsData
import centraid.core.v1.SettingsEvent
import centraid.core.v1.SettingsRow
import centraid.core.v1.SettingsState
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.design.CentraidGeometry
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitSegment
import dev.centraid.android.kit.KitSegmented
import dev.centraid.android.kit.KitText
import dev.centraid.android.kit.KitTile
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.PushedPage
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.StateColor
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.appAccent
import dev.centraid.android.kit.kitCard
import dev.centraid.android.kit.kitTextStyle
import dev.centraid.android.kit.rememberLargestText
import dev.centraid.android.kit.screenContentOf
import dev.centraid.android.theme.centraidDark

/**
 * `home.settings` (#1173, the Settings board): a pushed page of cards. The appearance is one
 * segmented choice (stacked at the largest text), then a card per section, then About. Every word,
 * the order and where a row goes are Rust's; a tap on a row with a route is [onOpen].
 */
@Composable
internal fun SettingsScreen(
    state: SettingsState,
    onEvent: (SettingsEvent) -> Unit,
    onOpen: (Route) -> Unit,
    onBack: () -> Unit,
) {
    // THE PAGE HANDED ITS JOB TO HOME (the vault switcher is Home's sheet): it steps aside.
    LaunchedEffect(state.finished) { if (state.finished) onBack() }
    PushedPage(title = state.title, parentTitle = state.back_label, onBack = onBack) {
        ReadStateView(
            content = screenContentOf(state.loading, null, state.data_),
            onRetry = null,
        ) { data -> SettingsBody(data, onEvent, onOpen) }
    }
    // DOWNLOAD SETTINGS is a sheet of its own (Rust's `transfer_sheet`): the member's one transfer
    // rule, the same three choices Home's gear draws.
    state.transfer_sheet?.let { rules ->
        dev.centraid.android.kit.TransferRulesSheet(
            sheet = rules,
            onPick = { stored -> onEvent(SettingsEvent(transfer_rule_chosen = SettingsEvent.TransferRuleChosen(stored = stored))) },
            onDismiss = { onEvent(SettingsEvent(transfer_rules_closed = SettingsEvent.TransferRulesClosed())) },
        )
    }
}

@Composable
private fun SettingsBody(data: SettingsData, onEvent: (SettingsEvent) -> Unit, onOpen: (Route) -> Unit) {
    LazyColumn(
        Modifier.fillMaxWidth().testTag("settings-list"),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(
            start = KitGeometry.GUTTER,
            end = KitGeometry.GUTTER,
            bottom = 24.dp,
        ),
    ) {
        val appearance = data.appearance
        if (appearance != null) {
            item(key = "appearance") {
                Column {
                    GroupHead(appearance.title)
                    KitSegmented(
                        appearance.choices.map { KitSegment(it.id, it.label, it.selected) },
                        testTag = "settings-appearance",
                    ) { id ->
                        onEvent(SettingsEvent(appearance_picked = SettingsEvent.AppearancePicked(id = id)))
                    }
                    KitText(
                        appearance.note,
                        KitType.Meta,
                        Surface.meta,
                        Modifier.padding(horizontal = 4.dp, vertical = 8.dp).testTag("settings-appearance-note"),
                    )
                }
            }
        }
        val units = data.units
        if (units != null) {
            item(key = "units") {
                Column {
                    GroupHead(units.title)
                    KitSegmented(
                        units.choices.map { KitSegment(it.id, it.label, it.selected) },
                        testTag = "settings-units",
                    ) { id ->
                        onEvent(SettingsEvent(units_picked = SettingsEvent.UnitsPicked(id = id)))
                    }
                    KitText(
                        units.note,
                        KitType.Meta,
                        Surface.meta,
                        Modifier.padding(horizontal = 4.dp, vertical = 8.dp).testTag("settings-units-note"),
                    )
                }
            }
        }
        data.sections.forEach { section ->
            item(key = "section-${section.key}") {
                Column {
                    GroupHead(section.title)
                    Column(Modifier.kitCard().testTag("settings-section-${section.key}")) {
                        section.rows.forEach { row ->
                            SettingsRowView(row, onOpen) { onEvent(SettingsEvent(row_pressed = SettingsEvent.RowPressed(id = row.id))) }
                        }
                    }
                }
            }
        }
        item(key = "about") {
            Column {
                GroupHead(data.about_title)
                Row(
                    Modifier
                        .kitCard()
                        .fillMaxWidth()
                        .heightIn(min = 52.dp)
                        .padding(horizontal = 16.dp, vertical = 8.dp)
                        .semantics(mergeDescendants = true) { }
                        .testTag("settings-version"),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    KitText(data.version_title, KitType.Row, Surface.ink, Modifier.weight(1f))
                    KitText(data.version, KitType.Row, Surface.meta)
                }
            }
        }
    }
}

@Composable
private fun GroupHead(title: String) {
    KitText(
        title,
        KitType.Group,
        Surface.meta,
        Modifier.padding(start = 4.dp, top = 20.dp, bottom = 6.dp).semantics { heading() },
    )
}

@Composable
private fun SettingsRowView(row: SettingsRow, onOpen: (Route) -> Unit, onPress: () -> Unit) {
    val route = row.route
    // A row with no page behind it is still pressed (`pressable`): Rust is told which.
    val tappable = route != null || row.pressable
    Column {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 56.dp)
                .then(
                    when {
                        route != null -> Modifier.clickable { onOpen(route) }
                        row.pressable -> Modifier.clickable(onClick = onPress)
                        else -> Modifier
                    },
                )
                .padding(horizontal = 12.dp, vertical = 8.dp)
                .testTag("settings-row-${row.id}")
                .clearAndSetSemantics {
                    contentDescription = row.accessibility_label
                    if (tappable) role = Role.Button
                },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // THE ROW'S TILE, as Rust names it: the vault's round initial, the state-amber fill
            // (the recovery key), or the shell's colour.
            when (row.tile) {
                "initial" -> Box(
                    Modifier.padding(end = 12.dp).size(32.dp).clip(CircleShape).background(appAccent("").fill).clearAndSetSemantics { },
                    contentAlignment = Alignment.Center,
                ) { Text(row.initial, style = kitTextStyle(KitType.Row), color = Color.White, fontWeight = FontWeight.Bold) }
                "amber" -> KitTile(row.icon_key, Modifier.padding(end = 12.dp), size = 32.dp, fill = StateColor.Amber.fill)
                "neutral" -> KitTile(row.icon_key, Modifier.padding(end = 12.dp), size = 32.dp, fill = Surface.meta)
                // A ROW THAT MAKES SOMETHING: the shell's tint under the shell's glyph.
                "add" -> Box(
                    Modifier
                        .padding(end = 12.dp)
                        .size(32.dp)
                        .clip(RoundedCornerShape((32 * CentraidGeometry.ICON_CHIP_RADIUS_RATIO).dp))
                        .background(appAccent("").wash(centraidDark()))
                        .clearAndSetSemantics { },
                    contentAlignment = Alignment.Center,
                ) { CentraidIcon(iconKey = row.icon_key, tint = appAccent("").text, size = 16.dp) }
                else -> if (row.icon_key.isNotEmpty()) KitTile(row.icon_key, Modifier.padding(end = 12.dp), size = 32.dp)
            }
            Column(Modifier.weight(1f)) {
                KitText(row.title, KitType.Row, if (row.tile == "add") appAccent("").text else Surface.ink)
                if (row.meta.isNotEmpty()) Text(row.meta, style = kitTextStyle(KitType.Meta), color = Surface.meta)
            }
            if (row.value_.isNotEmpty()) {
                KitText(row.value_, KitType.Row, Surface.meta, Modifier.padding(start = 8.dp))
            }
            // A row that MAKES something draws no chevron (the board's Make a vault).
            if (tappable && row.tile != "add") {
                CentraidIcon(iconKey = "ChevronRight", tint = Surface.meta, size = 16.dp, modifier = Modifier.padding(start = 8.dp))
            }
        }
        Spacer(Modifier.padding(start = 56.dp).fillMaxWidth().height(KitGeometry.HAIRLINE).background(Surface.line))
    }
}
