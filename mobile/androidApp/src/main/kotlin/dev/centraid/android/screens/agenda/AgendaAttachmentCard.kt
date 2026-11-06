package dev.centraid.android.screens.agenda

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import centraid.core.v1.AgendaAttachments
import centraid.core.v1.AgendaAttachmentEvent
import centraid.core.v1.Route
import dev.centraid.android.kit.*
import dev.centraid.android.theme.centraidColor

@Composable
internal fun AgendaAttachmentCard(value: AgendaAttachments, onEvent: (AgendaAttachmentEvent) -> Unit, onOpen: (Route) -> Unit) {
    Column(Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp).background(centraidColor("bgElev"), RoundedCornerShape(KitGeometry.RADIUS)).padding(vertical = 8.dp)) {
        SectionHeader(SectionHead(title = value.heading))
        value.rows.forEach { row ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                SheetRow(label = row.title, detail = row.meta, iconKey = "Paperclip", modifier = Modifier.weight(1f), testTag = "agenda-attachment-${row.id}", onTap = { row.route?.let(onOpen) })
                IconKey(iconKey = "X", label = value.remove_label, testTag = "agenda-attachment-remove-${row.id}", enabled = !value.busy) { onEvent(AgendaAttachmentEvent(remove = AgendaAttachmentEvent.Remove(id = row.id))) }
            }
        }
        SheetRow(label = value.add_label, iconKey = "Plus", enabled = !value.busy, testTag = "agenda-attachment-add", onTap = { onEvent(AgendaAttachmentEvent(add = AgendaAttachmentEvent.Add())) })
        SheetRow(label = value.add_photo_label, iconKey = "Image", enabled = !value.busy, testTag = "agenda-attachment-add-photo", onTap = { onEvent(AgendaAttachmentEvent(add_photo = AgendaAttachmentEvent.AddPhoto())) })
        StatusLine(value.status) { onEvent(AgendaAttachmentEvent(retry = AgendaAttachmentEvent.Retry())) }
    }
}
