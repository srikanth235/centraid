package dev.centraid.android.screens.agenda

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import centraid.core.v1.AgendaAttachmentEvent
import centraid.core.v1.AgendaAttachmentTile
import centraid.core.v1.AgendaAttachmentsSection
import centraid.core.v1.Route
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.ContentImage
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitLink
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.StatusLine
import dev.centraid.android.kit.Surface
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidScale

/**
 * THE ATTACHMENTS SECTION (#1173 wave 2) of an event and of a task: its heading, a tile per photo or
 * file (a tap pushes the route the tile carries), Add photo and Add file, Show more, a busy line
 * while bytes stage, the remove confirm and the section's own status. [prefix] is the page's
 * selector stem (`agenda-event`, `agenda-detail`). Every word and every glyph key is the section's.
 */
@Composable
internal fun AgendaAttachmentsView(
    section: AgendaAttachmentsSection,
    prefix: String,
    onEvent: (AgendaAttachmentEvent) -> Unit,
    onOpen: (Route) -> Unit,
) {
    Column(Modifier.fillMaxWidth().testTag("$prefix-attachments")) {
        Text(
            section.heading,
            style = centraidType("eyebrow"),
            color = centraidColor("textSoft"),
            modifier = Modifier.padding(start = KitGeometry.GUTTER, end = KitGeometry.GUTTER, top = 16.dp, bottom = 6.dp).semantics { heading() },
        )
        if (section.items.isEmpty() && section.empty_label.isNotEmpty()) {
            Text(section.empty_label, style = centraidType("body"), color = centraidColor("textFaint"), modifier = Modifier.padding(horizontal = KitGeometry.GUTTER))
        }
        // THE BOARD'S CARD: the attachments in one rounded plate.
        if (section.items.isNotEmpty()) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = KitGeometry.GUTTER)
                    .clip(RoundedCornerShape(CentraidScale.cardRadius.dp))
                    .background(Surface.card),
            ) {
                section.items.forEach { tile -> AttachmentTile(tile, prefix, onEvent, onOpen) }
            }
        }
        if (section.has_more && section.more_label.isNotEmpty()) {
            KitLink(
                label = section.more_label,
                onClick = { onEvent(AgendaAttachmentEvent(show_more = AgendaAttachmentEvent.ShowMore())) },
                modifier = Modifier.testTag("$prefix-attachment-more").padding(horizontal = KitGeometry.GUTTER / 2),
            )
        }
        if (section.busy && section.busy_label.isNotEmpty()) {
            Text(section.busy_label, style = centraidType("annotLabel"), color = centraidColor("textSoft"), modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp))
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AddVerb(section.add_photo_label, section.add_photo_icon_key, "$prefix-attachment-add-photo", !section.busy) {
                onEvent(AgendaAttachmentEvent(add_photo = AgendaAttachmentEvent.AddPhoto()))
            }
            AddVerb(section.add_file_label, section.add_file_icon_key, "$prefix-attachment-add-file", !section.busy) {
                onEvent(AgendaAttachmentEvent(add_file = AgendaAttachmentEvent.AddFile()))
            }
        }
        StatusLine(section.status, actTag = "$prefix-attachment-status") {
            onEvent(AgendaAttachmentEvent(status_dismissed = AgendaAttachmentEvent.StatusDismissed()))
        }
    }
    val confirm = section.remove_confirm
    if (confirm != null) {
        ConfirmSheet(
            confirm = confirm,
            onConfirm = { onEvent(AgendaAttachmentEvent(remove_confirmed = AgendaAttachmentEvent.RemoveConfirmed())) },
            onDismiss = { onEvent(AgendaAttachmentEvent(remove_dismissed = AgendaAttachmentEvent.RemoveDismissed())) },
            cancelLabel = KitWords.CANCEL,
        )
    }
}

@Composable
private fun AddVerb(label: String, iconKey: String, testTag: String, enabled: Boolean, onTap: () -> Unit) {
    if (label.isEmpty()) return
    Row(
        Modifier
            .heightIn(min = KitGeometry.ROW_MIN)
            .clip(CircleShape)
            .background(Surface.card, CircleShape)
            .border(1.dp, Surface.line, CircleShape)
            .clickable(enabled = enabled, onClick = onTap)
            .padding(horizontal = 14.dp)
            .testTag(testTag)
            .clearAndSetSemantics {
                contentDescription = label
                role = Role.Button
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (iconKey.isNotEmpty()) {
            CentraidIcon(iconKey, tint = centraidColor(if (enabled) "text" else "textFaint"), size = 18.dp, modifier = Modifier.padding(end = 6.dp))
        }
        Text(label, style = centraidType("smallStrong"), color = centraidColor(if (enabled) "text" else "textFaint"))
    }
}

/** One attachment: its thumbnail (or the kind's glyph), title and meta; a tap opens it, the control removes it. */
@Composable
private fun AttachmentTile(
    tile: AgendaAttachmentTile,
    prefix: String,
    onEvent: (AgendaAttachmentEvent) -> Unit,
    onOpen: (Route) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = KitGeometry.ROW_MIN).padding(start = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            Modifier
                .weight(1f)
                .heightIn(min = KitGeometry.ROW_MIN)
                .clickable { tile.route?.let(onOpen) }
                .padding(vertical = 6.dp)
                .testTag("$prefix-attachment-${tile.attachment_id}")
                .clearAndSetSemantics {
                    contentDescription = tile.accessibility_label.ifEmpty { tile.title }
                    role = Role.Button
                },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier.size(44.dp).clip(RoundedCornerShape(CentraidScale.cardRadius.dp / 2)).background(Surface.fill),
                contentAlignment = Alignment.Center,
            ) {
                if (tile.thumbnail_path.isNotEmpty()) {
                    ContentImage(tile.thumbnail_path)
                } else {
                    CentraidIcon(tile.icon_key, tint = centraidColor("textSoft"), size = 22.dp)
                }
            }
            Column(Modifier.weight(1f).padding(start = 12.dp)) {
                Text(tile.title, style = centraidType("body"), color = centraidColor("text"), maxLines = 1)
                if (tile.meta.isNotEmpty()) Text(tile.meta, style = centraidType("annotLabel"), color = centraidColor("textSoft"), maxLines = 1)
            }
            if (tile.badge.isNotEmpty()) {
                Text(tile.badge, style = centraidType("annotLabel"), color = centraidColor("textSoft"), modifier = Modifier.padding(horizontal = 8.dp))
            }
        }
        // THE BOARD'S ×: a quiet glyph; the word stays the spoken label.
        Box(
            Modifier
                .size(KitGeometry.ROW_MIN)
                .clip(CircleShape)
                .clickable { onEvent(AgendaAttachmentEvent(remove_asked = AgendaAttachmentEvent.RemoveAsked(attachment_id = tile.attachment_id))) }
                .testTag("$prefix-attachment-remove-${tile.attachment_id}")
                .clearAndSetSemantics {
                    contentDescription = tile.remove_accessibility_label.ifEmpty { tile.remove_label }
                    role = Role.Button
                },
            contentAlignment = Alignment.Center,
        ) { CentraidIcon("X", tint = centraidColor("textFaint"), size = 16.dp) }
    }
}
