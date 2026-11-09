package dev.centraid.android.kit

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.OutlinedTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import centraid.core.v1.LinkEvent
import centraid.core.v1.LinkPicker
import centraid.core.v1.LinkRow
import centraid.core.v1.LinkSection
import centraid.core.v1.Route
import androidx.compose.material3.Text

/**
 * LINKS SET BY HAND (#1173, O3): the one section and the one picker sheet that Money's "With",
 * Photos' "People in this photo", Docs' "About" and Locker's "Linked to" share. Rust makes every
 * word and row ([LinkSection], [LinkPicker]); this draws them and sends the member's taps back
 * as a [LinkEvent]. The SwiftUI twin is `Kit/LinkViews.swift`.
 */
@Composable
public fun LinkSectionView(
    section: LinkSection,
    onEvent: (LinkEvent) -> Unit,
    onOpen: ((Route) -> Unit)? = null,
    modifier: Modifier = Modifier,
    padded: Boolean = true,
) {
    val accent = appAccent()
    Column(modifier.fillMaxWidth().padding(horizontal = if (padded) KitGeometry.GUTTER else 0.dp)) {
        KitText(
            section.title,
            KitType.Group,
            Surface.meta,
            Modifier.padding(start = 4.dp, top = 12.dp, bottom = 6.dp).testTag("link-section-title"),
        )
        Column(Modifier.fillMaxWidth().kitCard()) {
            section.rows.forEachIndexed { index, row ->
                if (index > 0) LinkHairline()
                LinkRowView(row, onEvent, onOpen)
            }
            if (section.rows.isEmpty() && section.empty.isNotEmpty()) {
                KitText(
                    section.empty,
                    KitType.Row,
                    Surface.meta,
                    Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(horizontal = 14.dp, vertical = 12.dp),
                )
            }
            section.adds.forEachIndexed { index, add ->
                if (index > 0 || section.rows.isNotEmpty()) LinkHairline()
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp)
                        .clickable { onEvent(LinkEvent(add = LinkEvent.AddTapped(key = add.key))) }
                        .padding(horizontal = 14.dp)
                        .testTag("link-add-${add.key}"),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Box(Modifier.size(32.dp), contentAlignment = Alignment.Center) {
                        CentraidIcon(iconKey = "add", tint = accent.text, size = 18.dp)
                    }
                    KitText(add.label, KitType.Row, accent.text)
                }
            }
        }
    }
}

@Composable
private fun LinkHairline() {
    Spacer(Modifier.padding(start = 16.dp).fillMaxWidth().height(KitGeometry.HAIRLINE).background(Surface.line))
}

@Composable
private fun LinkRowView(row: LinkRow, onEvent: (LinkEvent) -> Unit, onOpen: ((Route) -> Unit)?) {
    val route = row.route
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("link-row-${row.id}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            Modifier
                .weight(1f)
                .clickable(enabled = route != null && onOpen != null) { route?.let { onOpen?.invoke(it) } }
                .padding(start = 14.dp, top = 4.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            LinkInitial(row.title)
            Column(Modifier.weight(1f)) {
                if (row.meta.isNotEmpty()) KitText(row.meta, KitType.Meta, Surface.meta)
                KitText(row.title, KitType.Row, Surface.ink)
            }
        }
        if (row.remove_label.isNotEmpty()) {
            Box(
                Modifier
                    .size(48.dp)
                    .clickable { onEvent(LinkEvent(remove = LinkEvent.RemoveTapped(id = row.id))) }
                    .semantics { contentDescription = row.remove_label }
                    .testTag("link-remove-${row.id}"),
                contentAlignment = Alignment.Center,
            ) {
                CentraidIcon(iconKey = "X", tint = Surface.meta, size = 16.dp)
            }
        }
    }
}

/** The first letter of a name in a quiet circle: no photograph is ever fetched for a link. */
@Composable
public fun LinkInitial(text: String) {
    val accent = appAccent()
    Box(
        Modifier.size(32.dp).clip(CircleShape).background(accent.fill.copy(alpha = 0.12f)),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text.take(1).uppercase(),
            style = kitTextStyle(KitType.Meta),
            color = accent.text,
        )
    }
}

/** THE PICKER SHEET: search by name, tap a row to link it, tap a linked one to unlink it. */
@Composable
public fun LinkPickerSheet(picker: LinkPicker, onEvent: (LinkEvent) -> Unit) {
    SheetRoom(
        title = picker.title,
        onDismiss = { onEvent(LinkEvent(closed = LinkEvent.PickerClosed())) },
        expanded = true,
    ) {
        var typed by remember(picker.open_) { mutableStateOf(picker.query) }
        Column(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER)) {
            OutlinedTextField(
                value = typed,
                onValueChange = {
                    typed = it
                    onEvent(LinkEvent(query = LinkEvent.QueryChanged(text = it)))
                },
                placeholder = { Text(picker.placeholder) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().testTag("link-picker-search"),
            )
        }
        if (picker.candidates.isEmpty()) {
            KitText(
                picker.empty,
                KitType.Row,
                Surface.meta,
                Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 16.dp).testTag("link-picker-empty"),
            )
        } else {
            LazyColumn(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER - 12.dp)) {
                items(picker.candidates, key = { it.id }) { row ->
                    SheetRow(
                        label = row.title,
                        detail = row.meta,
                        selected = row.selected,
                        testTag = "link-pick-${row.id}",
                        onTap = { onEvent(LinkEvent(pick = LinkEvent.Picked(id = row.id))) },
                    )
                }
            }
        }
    }
}
