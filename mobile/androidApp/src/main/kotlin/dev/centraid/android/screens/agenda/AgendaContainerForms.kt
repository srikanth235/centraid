package dev.centraid.android.screens.agenda

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import centraid.core.v1.*
import dev.centraid.android.kit.*
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

@Composable
internal fun AgendaAppearancePicker(value: AgendaAppearance, change: (AgendaFormChanged) -> Unit) {
    Column {
        SectionHeader(SectionHead(title = value.color_label))
        value.colors.forEach { choice ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.padding(start = KitGeometry.GUTTER).size(16.dp).clip(CircleShape).background(centraidColor(choice.key)))
                SheetRow(label = choice.label, selected = choice.selected, testTag = "agenda-color-${choice.key}", onTap = { change(AgendaFormChanged(field_ = "color", value_ = choice.key)) })
            }
        }
        SectionHeader(SectionHead(title = value.icon_label))
        value.icons.forEach { choice ->
            SheetRow(label = choice.label, iconKey = choice.icon_key, selected = choice.selected, testTag = "agenda-icon-${choice.key}", onTap = { change(AgendaFormChanged(field_ = "icon", value_ = choice.key)) })
        }
    }
}

@Composable
internal fun AgendaCalendarForm(value: AgendaContainerForm, status: String, onEvent: (AgendaHomeEvent) -> Unit) {
    SheetRoom(title = value.title, status = status, onDismiss = { onEvent(AgendaHomeEvent(sheet_closed = AgendaHomeEvent.SheetClosed())) }, primary = SheetPrimary(value.save_label, enabled = value.can_save) { onEvent(AgendaHomeEvent(container_saved = AgendaHomeEvent.ContainerSaved())) }) {
        Column(Modifier.verticalScroll(rememberScrollState())) {
            EditableFieldRow(key = value.name_label, value = value.name, reload = null, placeholder = value.name_label, onEdit = { onEvent(AgendaHomeEvent(container_form = AgendaFormChanged(field_ = "name", value_ = it))) }, testTag = "agenda-calendar-name")
            value.appearance?.let { AgendaAppearancePicker(it) { changed -> onEvent(AgendaHomeEvent(container_form = changed)) } }
        }
    }
}

@Composable
internal fun AgendaImportOptionsView(value: AgendaImportOptions, onEvent: (AgendaHomeEvent) -> Unit) {
    SheetRoom(title = value.title, onDismiss = { onEvent(AgendaHomeEvent(sheet_closed = AgendaHomeEvent.SheetClosed())) }) {
        Row(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER), verticalAlignment = Alignment.CenterVertically) {
            Text(value.include_completed_label, style = centraidType("body"), color = centraidColor("text"), modifier = Modifier.weight(1f))
            Switch(checked = value.include_completed, onCheckedChange = { onEvent(AgendaHomeEvent(import_options = AgendaHomeEvent.ImportOptionsChanged(include_completed = it))) }, colors = kitSwitchColors(), modifier = Modifier.testTag("agenda-import-completed").semantics { contentDescription = value.include_completed_label })
        }
        value.options.forEach { option ->
            SheetRow(label = option.label, testTag = "agenda-import-${option.key}", onTap = { onEvent(AgendaHomeEvent(import_requested = AgendaHomeEvent.ImportRequested(source = option.source, include_completed = value.include_completed, from_file = option.from_file))) })
        }
    }
}
